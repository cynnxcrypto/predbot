/**
 * REAL MONEY: copying Hyperliquid traders ON Hyperliquid, on every coin they trade (enrique, 17 Nov 2026: "new tab
 * for hyperliquid", "lets not mix it", "and it is it's own wallet"). The Solana perps side can copy only SOL, BTC and
 * ETH (Jupiter has no other coins); here a copied trader's position on any Hyperliquid coin can be followed.
 *
 * The same rules as the Solana perps copies (src/solana/perpslive.ts), with the same paper record behind them
 * (src/solana/buckets.ts: one paper copy of every position a followed trader opens, on every coin):
 *   - a trader goes real on its own record: TRADER_MIN_COPIES closed paper copies, half or more won, ahead, a day old;
 *   - real results first (src/solana/realfirst.ts): real while its real net is zero or better; back to paper when
 *     behind after 3 real trades or at its stop;
 *   - every open position of a real trader is copied (enrique, 17 Nov 2026 23:08 KST: "yes allow more than one HL copy
 *     per trader"); one per coin, since Hyperliquid nets a coin's positions into one; as many as the wallet's free
 *     money and maxOpen allow;
 *   - the trader's own leverage, whole numbers, at most half of what Hyperliquid allows for the coin; ISOLATED
 *     margin, so one position can lose its own collateral and nothing more;
 *   - the copy is opened in the first OPEN_WINDOW_MS after the paper copy, and closed when the paper copy closes;
 *   - LATE COPIES (enrique, 18 Nov 2026, after 26 copies were missed for no free money; asked "also copy positions
 *     those traders still hold, when the price is still within 1% of their entry?", he: "ah yea that makes sense"):
 *     a position a real trader still holds and we never held is copied later too, while Hyperliquid's price is within
 *     lateWithinPct (at most HARD_LATE_PCT) of the price the paper copy was opened at, either way. Never one we
 *     already held (closed, liquidated, at max hold): that one is over.
 *
 * THE SECOND WALLET (enrique, 19 Nov 2026: "did you consider what happens to leverage of our position when two traders
 * at different times and different leversge enter a position in the same direction", "potentially we could have more
 * than 1 hl wallet", then his tap "2nd wallet for every overlap"): Hyperliquid keeps ONE position, one leverage and
 * one liquidation price per coin per account, so two traders' copies are never merged. A copy on a coin the first
 * wallet already holds (same side or opposite) is opened in the second wallet, with its own leverage, margin and exit;
 * held in both: skipped. One book for both: the same trader records, loss cap, maxOpen and lists; a position says
 * which wallet holds it ("trade": { "second": { "on": true, "testOnce": "<name>" } }).
 *
 * deploy/live-rules.json "hyperliquid": { "trade": { "on": true, "collateralUsd": 10, "maxOpen": 5, "maxLossUsd": 50,
 * "traderStopUsd": 9, "testOnce": "<name>" } }. No block or on != true: nothing is opened (open positions are still
 * closed). testOnce: ONE smallest BTC long, opened and closed at the next look, once per name.
 *
 * Orders are signed by the trading key (it cannot withdraw). State: data/hyperliquid-live.json (server only).
 */
import { entryGapPct, gapStats, PROVEN_CUT_N, provenCut } from "./skill.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config.js";
import { loadJson, saveJson } from "../store.js";
import { cutReason, perpLadder, realRecord, standing, type RealRecord } from "../solana/realfirst.js";
import type { Coin, Fill } from "./exchange.js";
import { roundSz } from "./exchange.js";

export const HARD_COLLATERAL_USD = 30;
export const MIN_COLLATERAL_USD = 10;
export const HARD_MAX_LOSS_USD = 50;
// 20 Nov 2026 18:56 KST, enrique: "push no position limits on HL wallet 1, HL wallet 2 and polymarket bets per wallet, only
// skip when no cash": the count is a backstop only; free money decides
export const HARD_MAX_OPEN = 500;
export const HARD_TRADER_STOP_USD = 10;
/** a late copy is never made further than this many percent from the paper copy's entry price */
export const HARD_LATE_PCT = 1;
/** Hyperliquid turns down an order worth under $10; ours are never under this */
export const MIN_ORDER_USD = 11;
export const OPEN_WINDOW_MS = 120_000;
export const MAX_HOLD_H = 24 * 14;
export const OPEN_SLIP = 0.01;
export const CLOSE_SLIP = [0.02, 0.05, 0.1] as const;
export const GONE_LOOKS = 3;
export const TEST_RULE = "test-once";
/** Hyperliquid's taker fee a side, used only when its own fill record cannot be read */
export const TAKER_FEE = 0.00045;
const FILE = "hyperliquid-live.json";
const r2 = (x: number) => Math.round(x * 100) / 100;
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const HARD_HISTORY_TOP = 50;
export interface HlLiveConfig {
  on: boolean;
  collateralUsd: number;
  maxOpen: number;
  maxLossUsd: number;
  traderStopUsd: number;
  testOnce: string;
  /** late copies: how far (a fraction) the price may be from the paper entry; 0 or none = no late copies */
  lateWithin?: number;
  /** a trader may also meet the bar on its own closed positions of the last month (src/solana/buckets.ts hlTrips) */
  historyBar?: boolean;
  /** of the traders that meet that bar only on the longer look, how many of the best are approved (0 to HARD_HISTORY_TOP) */
  historyTop?: number;
  /** the second wallet (overlaps): on = a copy the first wallet cannot hold goes there; testOnce = its one test trade */
  second?: { on: boolean; testOnce: string; maxOpen: number };
  /** once per name: close every position open at that moment in both wallets (20 Nov 2026, enrique: "close all
   *  hyperliquid positions and lets see what happens next"); new copies go on as usual ("why no new real copies open
   *  wtf"). A forced close does not count for or against the trader */
  closeAllOnce?: string;
  /** only the better traders (21 Nov 2026, enrique: "push HL keep traders at $0.50+ a copy on real, or 2%+ a trade on
   *  own history"): with real copies since its last cut, a trader stays only while they average perCopyUsd or more;
   *  with none, only while its own Hyperliquid history averages histPct % or more a position. Open copies are untouched. */
  keepBar?: { perCopyUsd: number; histPct: number };
  /** SKILL BAR (25 Nov 2026, enrique: "push skill bar: HL history traders must pass the skill test, passers get cash
   *  first"): a trader approved on its own history must also pass the skill test (src/hyperliquid/skill.ts: 20+
   *  closed, beats BTC by 2+ standard errors, ahead without its best 3, ahead in 2 of 3 periods); in each look skill
   *  passers are copied first, and a copy of a trader that does not pass leaves one base position of free money for them */
  skillBar?: boolean;
  /** PROVEN TIER (25 Nov 2026, enrique: 'push proven tier: 2.5+ standard errors not cut until 20+ real copies behind, bilberry back to real'): a trader that passes the
   *  skill test at provenT+ standard errors is real and is not cut by the short-streak rules (cut sooner, trader stop,
   *  keep bar); it goes back to paper only with PROVEN_CUT_N+ real copies (all of them) and behind. 0 = off */
  provenT?: number;
}
/** Is this trader good enough to copy under the keep bar? Pure. */
export function keepsTrader(real: { trades: number; net: number }, histAvgPct: number | null, kb: HlLiveConfig["keepBar"]): { ok: boolean; why: string } {
  if (!kb) return { ok: true, why: "" };
  const two = (x: number) => Math.round(x * 100) / 100;
  if (real.trades > 0) {
    const per = real.net / real.trades;
    return per >= kb.perCopyUsd ? { ok: true, why: "" } : { ok: false, why: `paper: real copies average $${two(per)} each, under the $${kb.perCopyUsd} keep bar` };
  }
  if (histAvgPct == null) return { ok: false, why: "paper: no own Hyperliquid history read for the keep bar" };
  return histAvgPct >= kb.histPct ? { ok: true, why: "" } : { ok: false, why: `paper: own history averages ${two(histAvgPct)}% a position, under the ${kb.histPct}% keep bar` };
}
/** the second wallet's own slots (enrique, 20 Nov 2026: "move 50usd to the second hl wallet and 4 slots") */
export const SECOND_MAX_OPEN = 4;
export const HARD_SECOND_MAX_OPEN = 500;
const OFF: HlLiveConfig = { on: false, collateralUsd: MIN_COLLATERAL_USD, maxOpen: 0, maxLossUsd: 0, traderStopUsd: 0, testOnce: "" };
/** Parse the "hyperliquid.trade" block of deploy/live-rules.json. Hard limits are applied here; anything odd means off. */
export function parseHlLive(text: string): HlLiveConfig {
  try {
    const p = (JSON.parse(text) as { hyperliquid?: { trade?: Record<string, unknown> } }).hyperliquid?.trade;
    if (!p) return OFF;
    const name = (v: unknown) => (typeof v === "string" && /^[a-z0-9-]{1,40}$/.test(v) ? v : "");
    const testOnce = name(p.testOnce);
    const s2 = p.second && typeof p.second === "object" ? (p.second as Record<string, unknown>) : null;
    const maxLossUsd = clamp(num(p.maxLossUsd, 0), 0, HARD_MAX_LOSS_USD);
    const collateralUsd = clamp(num(p.collateralUsd, MIN_COLLATERAL_USD), MIN_COLLATERAL_USD, HARD_COLLATERAL_USD);
    const closeAll = name(p.closeAllOnce) ? { closeAllOnce: name(p.closeAllOnce) } : {};
    if (p.on !== true || !(maxLossUsd > 0)) return { ...OFF, collateralUsd, testOnce, ...closeAll, ...(s2 ? { second: { on: false, testOnce: name(s2.testOnce), maxOpen: 0 } } : {}) };
    const lateWithin = clamp(num(p.lateWithinPct, 0), 0, HARD_LATE_PCT) / 100;
    const kb = p.keepBar && typeof p.keepBar === "object" ? (p.keepBar as Record<string, unknown>) : null;
    const keepBar = kb ? { keepBar: { perCopyUsd: clamp(num(kb.perCopyUsd, 0.5), 0, 50), histPct: clamp(num(kb.histPct, 2), 0, 50) } } : {};
    return { on: true, collateralUsd, maxLossUsd, testOnce, lateWithin, ...keepBar, ...(p.historyBar === true ? { historyBar: true, historyTop: Math.floor(clamp(num(p.historyTop, 5), 0, HARD_HISTORY_TOP)) } : {}), ...(p.skillBar === true ? { skillBar: true } : {}), ...(num(p.provenT, 0) > 0 ? { provenT: clamp(num(p.provenT, 0), 1, 10) } : {}), ...closeAll, ...(s2 ? { second: { on: s2.on === true, testOnce: name(s2.testOnce), maxOpen: Math.floor(clamp(num(s2.maxOpen, SECOND_MAX_OPEN), 1, HARD_SECOND_MAX_OPEN)) } } : {}), maxOpen: Math.floor(clamp(num(p.maxOpen, 5), 1, HARD_MAX_OPEN)), traderStopUsd: clamp(num(p.traderStopUsd, 9), 1, HARD_TRADER_STOP_USD) };
  } catch {
    return OFF;
  }
}

export interface VenuePos {
  szi: number;
  entryPx: number;
  unrealUsd: number;
  marginUsd: number;
  /** the leverage Hyperliquid's own account record has on the position, and whether its margin is isolated */
  lev?: number;
  isolated?: boolean;
}
export interface Account {
  valueUsd: number;
  freeUsd: number;
  positions: Record<string, VenuePos>;
}
/** Hyperliquid, as the trading loop sees it (tests stand in for it). */
export interface Venue {
  coins(): Promise<Record<string, Coin>>;
  mids(): Promise<Record<string, number>>;
  account(): Promise<Account>;
  /** make sure the trading key is named for the account; "" when it is, else why not */
  agent(): Promise<string>;
  /** "" when set, else why not */
  setLeverage(coin: Coin, leverage: number): Promise<string>;
  order(coin: Coin, buy: boolean, px: number, sz: number, reduceOnly: boolean): Promise<Fill>;
  /** what Hyperliquid's own record says these orders made: closed profit minus fees; null when it cannot be read */
  result(oids: number[], sinceMs: number): Promise<number | null>;
  /** the account's fills since a time (for rebuilding ghosts) */
  fills?(sinceMs: number): Promise<{ coin: string; px: number; sz: number; time: number; dir: string }[]>;
}
export interface PaperOpen {
  id: string;
  rule: string;
  coin: string;
  dir: number;
  at: number;
  lev?: number;
  /** the price the paper copy was opened at */
  px?: number;
  /** the share of its opening size the trader still holds (0..1), when known */
  left?: number;
  /** that share after each of the trader's fills since the paper copy opened [time, share], when it was read back */
  hist?: [number, number][];
  /** the position's value against the trader's account value when it opened (conviction), when known */
  share?: number;
  /** the trader's own average entry price when the paper copy saw the position (22 Nov 2026) */
  their?: number;
}
export interface HlDeps {
  cfg(): HlLiveConfig;
  venue: Venue;
  /** the second wallet's account (overlaps); none = there is no second wallet */
  venue2?: Venue;
  paperOpens(): PaperOpen[];
  /** does this trader's paper record made after `sinceMs` meet the bar for real? */
  meetsBar(rule: string, sinceMs: number, now: number): boolean;
  /** is the trader still on the list followed now? */
  listed(rule: string): boolean;
  /** the trader's own Hyperliquid history: average result a position, in %; null = not read */
  histAvgPct?(rule: string): number | null;
  /** does the trader pass the skill test on its own history (skill bar) */
  skillPass?(rule: string): boolean;
  /** proven tier: does the trader pass the skill test at this many standard errors */
  proven?(rule: string, minT: number): boolean;
}

interface Pos {
  /** marked by a closeAllOnce: closed at the next looks whatever the trader does */
  forceClose?: boolean;
  rule: string;
  coin: string;
  paperId: string;
  dir: number;
  lev: number;
  sz: number;
  entryPx: number;
  collUsd: number;
  openOid: number | null;
  /** every order that closed a part of it */
  closeOids?: number[];
  openedMs: number;
  closeTries: number;
  /** opened later than the paper copy (a late copy) */
  late?: boolean;
  /** our fill against the trader's own average entry, % (positive = worse for us), and seconds from seeing the
   *  position on paper to our fill (22 Nov 2026, enrique: "inform me of our delay and fill price") */
  gapPct?: number;
  lagSec?: number;
  goneLooks?: number;
  unrealUsd?: number;
  markMs?: number;
  /** read back from Hyperliquid's account at every look: its leverage on the position, isolated or not, margin held */
  venueLev?: number;
  venueIsolated?: boolean;
  venueMarginUsd?: number;
  /** partial closes that followed the trader's (19 Nov 2026), and what they made by our own count */
  parts?: number;
  partUsd?: number;
  /** the share of its paper-copy opening size the trader held when OUR copy opened (a late copy opens after part may
   * be gone already), and the share of what it held then that it holds now */
  left0?: number;
  traderLeft?: number;
  /** the trader's position against its account when copied (conviction) */
  share?: number;
  /** 2 = held in the second wallet (the coin was taken in the first by another trader's copy) */
  w?: 2;
}
interface Row {
  t: number;
  rule: string;
  coin: string;
  side: "long" | "short";
  leverage: number;
  netUsd: number;
  heldH: number;
  why: string;
  /** what the position was opened with (rows before 17 Nov 2026 21:40 KST have none) */
  collateralUsd?: number;
  wallet?: 2;
  gapPct?: number;
  lagSec?: number;
}
interface State {
  netUsd: number;
  opens: Pos[];
  rows: Row[];
  demoted: Record<string, number>;
  demotedWhy: Record<string, string>;
  seen: string[];
  /** every paper copy we ever held a real copy of, and the late copies that failed once: never (re)opened late */
  held: string[];
  lateOff: string[];
  skipped: Record<string, number>;
  test?: { id: string; at: number; result: string };
  agentOk?: boolean;
  lastError: string;
  account?: { at: number; valueUsd: number; freeUsd: number };
  /** the second wallet: its account, its trading key named, its one test trade, its last trouble */
  account2?: { at: number; valueUsd: number; freeUsd: number };
  agentOk2?: boolean;
  test2?: { id: string; at: number; result: string };
  /** the last closeAllOnce name carried out */
  closeAllId?: string;
  /** the close-all whose earlier closes (made before ghosts existed) were rebuilt as ghosts from the fills */
  ghostsRebuilt?: string;
  /** what each force-closed position would have made if held until its trader closed (enrique, 20 Nov 2026: "if the
   *  market continues in the direction these positions we had pointed, then u fucked up"): from our close price */
  ghosts?: { coin: string; dir: number; sz: number; closePx: number; paperId: string; closedAt: number; nowPx?: number; exitPx?: number; exitAt?: number; lockedUsd: number }[];
  lastError2?: string;
}
const fresh = (): State => ({ netUsd: 0, opens: [], rows: [], demoted: {}, demotedWhy: {}, seen: [], held: [], lateOff: [], skipped: {}, lastError: "" });
let state: State = fresh();
let loaded = false;
const load = () => {
  loaded = true;
  state = { ...fresh(), ...loadJson<Partial<State>>(FILE, {}) };
  for (const o of state.opens) if (!state.held.includes(o.paperId)) state.held.push(o.paperId);
  // a trader cut on nothing but such rows is put back (copy-05a42708, 17 Nov 2026: three one-minute ATOM shorts)
  for (const rule of Object.keys(state.demoted)) {
    const before = state.rows.filter((x) => x.rule === rule && x.t <= state.demoted[rule]);
    if (before.length && before.every(isFlip) && /behind after/.test(state.demotedWhy[rule] ?? "")) {
      delete state.demoted[rule];
      delete state.demotedWhy[rule];
    }
  }
};
const save = () => saveJson(FILE, state);
const skip = (why: string) => void (state.skipped[why] = (state.skipped[why] ?? 0) + 1);
/**
 * A copy opened and closed within a few minutes for cents: not a trade of the trader's, but its position slipping in
 * and out of the followed list (fixed at the source 17 Nov 2026, src/solana/buckets.ts HL_KEEP_POS_USD). Such rows stay
 * in the money count, but no trader is kept or cut on them.
 */
export const isFlip = (x: { heldH: number; netUsd: number }) => x.heldH <= 0.05 && Math.abs(x.netUsd) < 0.15;
const realNetsOf = (rule: string) => state.rows.filter((x) => x.rule === rule && x.t > (state.demoted[rule] ?? 0) && !isFlip(x)).map((x) => x.netUsd);
const realOf = (rule: string) => realRecord(realNetsOf(rule));
/** A trader's position size: the base, up the perps ladder on its own real record (realfirst.ts perpLadder), never past the hard limit. */
export const hlCollateral = (rule: string, base: number) => Math.min(HARD_COLLATERAL_USD, perpLadder(realNetsOf(rule), base).usd);
/**
 * SIZE BY CONVICTION (enrique, 19 Nov 2026: "yeah build all 3"): the ladder's size moved along the ladder's own steps by
 * how big the trader's position is against its account when it opened it: under a quarter of the account one step
 * down, the account's size or more one step up, three times or more two steps up, the second step only for a trader
 * ahead on 3+ real trades. Never under MIN_COLLATERAL_USD, never past HARD_COLLATERAL_USD.
 */
export const HL_STEPS = [10, 15, 20, 30] as const;
export function convictionUsd(ladderUsd: number, share: number | undefined, real: RealRecord): number {
  if (share == null || !Number.isFinite(share)) return Math.min(HARD_COLLATERAL_USD, ladderUsd);
  let i = 0;
  for (let k = 0; k < HL_STEPS.length; k++) if (HL_STEPS[k] <= ladderUsd + 1e-9) i = k;
  const proven = real.trades >= 3 && real.net > 0;
  const d = share < 0.25 ? -1 : share >= 3 && proven ? 2 : share >= 1 ? 1 : 0;
  const j = Math.max(0, Math.min(HL_STEPS.length - 1, i + d));
  return Math.max(MIN_COLLATERAL_USD, Math.min(HARD_COLLATERAL_USD, d === 0 ? ladderUsd : HL_STEPS[j]));
}
/**
 * CUT SOONER on Hyperliquid (enrique, 19 Nov 2026: "yeah build all 3"; Hyperliquid then 3 of 13 won, -$1.39): back to
 * paper when behind after 2 real trades (not 3), or at a $5 real loss (not the stop of up to $10).
 */
export const HL_CUT_MIN_TRADES = 2;
export const HL_CUT_STOP_USD = 5;
export const hlCutReason = (real: RealRecord, stop: number): string =>
  cutReason(real, Math.min(stop > 0 ? stop : HL_CUT_STOP_USD, HL_CUT_STOP_USD)) || (real.trades >= HL_CUT_MIN_TRADES && real.net < 0 ? `cut: real record behind after ${real.trades} trades` : "");
const loss = () => Math.max(0, -state.netUsd);

/** The traders the paper side must keep following even off the daily list: a real position open here, or real copies ahead. */
export const hlKeptTraders = () => {
  if (!loaded) load();
  const ids = [...new Set([...state.opens.map((x) => x.rule), ...state.rows.map((x) => x.rule)])].filter((id) => id.startsWith("copy-"));
  return ids.filter((id) => state.opens.some((x) => x.rule === id) || (realOf(id).trades > 0 && realOf(id).net > 0));
};

/** The leverage of a copy: the trader's own, a whole number, never above half of Hyperliquid's limit for the coin. */
export const leverageFor = (traderLev: number | undefined, coin: Coin) => Math.max(1, Math.min(Math.floor(traderLev ?? 2), Math.max(1, Math.floor(coin.maxLeverage / 2))));

function book(p: Pos, netUsd: number, why: string, now: number, stop: number, proven = false) {
  if (why === "the trader closed") noteDelay("realClose", p.rule, p.coin);
  state.netUsd = r2(state.netUsd + netUsd);
  state.rows.push({ t: now, rule: p.rule, coin: p.coin, side: p.dir > 0 ? "long" : "short", leverage: p.lev, netUsd: r2(netUsd), heldH: Math.round(((now - p.openedMs) / 3_600_000) * 100) / 100, why, collateralUsd: p.collUsd, ...(p.w ? { wallet: 2 as const } : {}), ...(p.gapPct != null ? { gapPct: p.gapPct } : {}), ...(p.lagSec != null ? { lagSec: p.lagSec } : {}) });
  if (state.rows.length > 2000) state.rows = state.rows.slice(-2000);
  state.opens = state.opens.filter((x) => x !== p);
  if (p.rule === TEST_RULE || why.startsWith("closed on enrique's word") || proven) return;
  const cut = hlCutReason(realOf(p.rule), stop);
  if (cut) {
    state.demotedWhy[p.rule] = cut;
    state.demoted[p.rule] = now;
  }
}

let busy = false;
/** the trade feed's delay measure (src/hyperliquid/watch.ts): told when a real copy opens or closes after its trader */
let delayNote: ((kind: "realOpen" | "realClose", rule: string, coin: string) => void) | null = null;
export const setHlDelayNote = (f: typeof delayNote) => void (delayNote = f);
const noteDelay = (kind: "realOpen" | "realClose", rule: string, coin: string) => {
  try {
    delayNote?.(kind, rule, coin);
  } catch {
    // a measure never stops a trade
  }
};
/** One look: close what is due, then open what is new. Never throws. */
export async function hlLiveTick(d: HlDeps, now = Date.now()): Promise<void> {
  if (busy) return;
  if (!loaded) load();
  const cfg = d.cfg();
  const testDue = !!cfg.testOnce && state.test?.id !== cfg.testOnce;
  const test2Due = !!d.venue2 && !!cfg.second?.testOnce && state.test2?.id !== cfg.second.testOnce;
  if (!cfg.on && !testDue && !test2Due && !state.opens.length && !cfg.closeAllOnce) return;
  busy = true;
  try {
    const v = d.venue;
    const acct = await v.account();
    state.account = { at: now, valueUsd: r2(acct.valueUsd), freeUsd: r2(acct.freeUsd) };
    if (!state.agentOk) {
      if (!(acct.valueUsd > 0)) return void (state.lastError = "no money on Hyperliquid yet");
      const why = await v.agent();
      if (why) return void (state.lastError = `trading key: ${why}`);
      state.agentOk = true;
    }
    // THE SECOND WALLET (overlaps): one book, two accounts. A look in which it cannot be read leaves its positions as
    // they are (never counted as gone) and opens nothing there.
    const v2 = d.venue2 && (cfg.second?.on || test2Due || state.opens.some((p) => p.w)) ? d.venue2 : undefined;
    let acct2: Account | null = null;
    if (v2) {
      state.lastError2 = "";
      acct2 = await v2.account().catch((e) => ((state.lastError2 = `second wallet not read: ${String((e as Error)?.message ?? e).replace(/0x[0-9a-fA-F]{40,}/g, "…").slice(0, 100)}`), null));
      if (acct2) {
        state.account2 = { at: now, valueUsd: r2(acct2.valueUsd), freeUsd: r2(acct2.freeUsd) };
        if (!state.agentOk2) {
          if (!(acct2.valueUsd > 0)) state.lastError2 = "no money in the second wallet yet";
          else {
            const why = await v2.agent().catch((e) => String((e as Error)?.message ?? e).replace(/0x[0-9a-fA-F]{40,}/g, "…").slice(0, 100));
            if (why) state.lastError2 = `second wallet trading key: ${why}`;
            else state.agentOk2 = true;
          }
        }
      }
    }
    const ready2 = !!acct2 && !!state.agentOk2;
    /** where a new copy on this coin can go: 1 the first wallet, 2 the second (the first holds the coin already), 0 nowhere */
    const where = (c: string): 0 | 1 | 2 => {
      if (!state.opens.some((o) => !o.w && o.coin === c) && !acct.positions[c]) return 1;
      return cfg.second?.on && ready2 && state.opens.filter((o) => o.w).length < cfg.second.maxOpen && !state.opens.some((o) => o.w && o.coin === c) && !acct2!.positions[c] ? 2 : 0;
    };
    const [coins, mids] = [await v.coins(), await v.mids()];
    const paper = d.paperOpens();
    const stop = cfg.traderStopUsd || HARD_TRADER_STOP_USD - 1;
    // proven tier: real until PROVEN_CUT_N+ real copies (all of them, through any old cut) are behind
    const allOf = (rule: string) => realRecord(state.rows.filter((x) => x.rule === rule && !isFlip(x)).map((x) => x.netUsd));
    const isProven = (rule: string) => !!cfg.provenT && !!d.proven?.(rule, cfg.provenT);
    const isReal = (rule: string) => isProven(rule) ? !provenCut(allOf(rule).trades, allOf(rule).net) : standing(realOf(rule), d.meetsBar(rule, state.demoted[rule] ?? 0, now), state.demotedWhy[rule]).real && keepsTrader(realOf(rule), d.histAvgPct?.(rule) ?? null, cfg.keepBar).ok;
    // a trader already behind under the sooner cut is cut now, not only at its next close
    for (const rule of new Set(state.rows.map((x) => x.rule))) {
      if (rule === TEST_RULE || isProven(rule)) continue;
      const c = hlCutReason(realOf(rule), stop);
      if (c) {
        state.demotedWhy[rule] = c;
        state.demoted[rule] = now;
      }
    }

    // ---- ghosts rebuilt (once per close-all) for closes booked before ghosts existed: price and size from the fills ----
    if (state.closeAllId && state.ghostsRebuilt !== state.closeAllId) {
      const forced = state.rows.filter((r) => /close all/.test(r.why) && now - r.t < 2 * 86_400_000);
      const since = Math.min(...forced.map((r) => r.t), now) - 15 * 60_000;
      const f1 = v.fills ? await v.fills(since).catch(() => null) : [];
      const f2 = v2?.fills ? await v2.fills(since).catch(() => null) : [];
      if (f1 && (f2 || !forced.some((r) => r.wallet === 2))) {
        const gs = state.ghosts ?? [];
        for (const r of forced) {
          const dir = r.side === "long" ? 1 : -1;
          if (gs.some((g) => g.coin === r.coin && g.dir === dir && g.lockedUsd === r.netUsd && Math.abs(g.closedAt - r.t) < 20 * 60_000)) continue;
          const fills = (r.wallet === 2 ? f2 ?? [] : f1).filter((f) => f.coin === r.coin && /^close/i.test(f.dir) && f.time <= r.t + 60_000 && f.time >= r.t - 10 * 60_000);
          const sz = fills.reduce((a, f) => a + f.sz, 0);
          if (!(sz > 0)) continue;
          const px = fills.reduce((a, f) => a + f.px * f.sz, 0) / sz;
          const po = paper.find((x) => x.rule === r.rule && x.coin === r.coin && x.dir === dir);
          gs.push({ coin: r.coin, dir, sz, closePx: px, paperId: po?.id ?? "", closedAt: r.t, lockedUsd: r.netUsd, ...(po ? {} : { exitPx: mids[r.coin] > 0 ? mids[r.coin] : px, exitAt: now }) });
        }
        state.ghosts = gs.slice(-200);
        state.ghostsRebuilt = state.closeAllId;
        save();
      }
    }
    // ---- ghosts of force-closed positions: marked at the mid until their trader closes ----
    for (const g of state.ghosts ?? []) {
      if (g.exitAt) continue;
      if (mids[g.coin] > 0) g.nowPx = mids[g.coin];
      if (!paper.some((x) => x.id === g.paperId) && g.nowPx) {
        g.exitPx = g.nowPx;
        g.exitAt = now;
      }
    }
    // ---- close all, once per name: every position open now is marked; later copies are not ----
    if (cfg.closeAllOnce && state.closeAllId !== cfg.closeAllOnce) {
      for (const p of state.opens) p.forceClose = true;
      state.closeAllId = cfg.closeAllOnce;
      save();
    }
    // ---- what we hold: mark it, close what is due ----
    for (const p of [...state.opens]) {
      const pa = p.w ? acct2 : acct;
      const pv = p.w ? v2 : v;
      if (!pa || !pv) continue; // the second wallet was not read in this look
      const held = pa.positions[p.coin];
      const coin = coins[p.coin];
      if (!held || Math.sign(held.szi) !== p.dir) {
        // liquidated, or closed by hand: only after several looks in a row, and at what Hyperliquid's record says it made
        p.goneLooks = (p.goneLooks ?? 0) + 1;
        if (p.goneLooks >= GONE_LOOKS) book(p, (p.openOid != null ? await pv.result([p.openOid], p.openedMs - 60_000).catch(() => null) : null) ?? -p.collUsd, "gone: liquidated or closed outside the bot", now, stop, isProven(p.rule));
        continue;
      }
      p.goneLooks = 0;
      p.unrealUsd = r2(held.unrealUsd);
      p.markMs = now;
      p.venueLev = held.lev;
      p.venueIsolated = held.isolated;
      p.venueMarginUsd = r2(held.marginUsd);
      const po = paper.find((x) => x.id === p.paperId);
      let why = p.forceClose ? "closed on enrique's word (close all)" : p.rule === TEST_RULE ? "test" : !po ? "the trader closed" : now - p.openedMs > MAX_HOLD_H * 3_600_000 ? "max hold" : "";
      // PARTIAL CLOSES (enrique, 19 Nov 2026: "yeah build all 3"): the trader took part off, so we take the same share
      // of our opening size off. What is left is never kept under Hyperliquid's smallest order: then all of it goes.
      if (po?.left != null) {
        // measured from what the trader held when OUR copy opened: a copy opened late, after the trader had taken part
        // off, is not cut for that part
        if (!(p.left0! > 0)) p.left0 = Math.min(1, [...(po.hist ?? [])].reverse().find(([t]) => t <= p.openedMs)?.[1] ?? 1) || 1;
        p.traderLeft = Math.round(Math.min(1, Math.max(0, po.left) / p.left0!) * 1000) / 1000;
      }
      if (!why && p.traderLeft != null && p.traderLeft < 1 && coin && mids[p.coin] > 0) {
        const px0 = mids[p.coin];
        const cur = Math.abs(held.szi);
        const target = p.sz * p.traderLeft;
        if (target * px0 < MIN_ORDER_USD) why = "the trader closed most of it";
        else {
          const cut = roundSz(cur - target, coin.szDecimals);
          if (cut * px0 >= MIN_ORDER_USD) {
            const f = await pv.order(coin, p.dir < 0, px0 * (1 - p.dir * CLOSE_SLIP[0]), cut, true);
            if (!f.filled) state.lastError = `${p.coin} part close: ${f.error}`;
            else {
              if (f.oid != null) p.closeOids = [...(p.closeOids ?? []), f.oid];
              p.parts = (p.parts ?? 0) + 1;
              p.partUsd = r2((p.partUsd ?? 0) + p.dir * (f.px - p.entryPx) * f.sz - TAKER_FEE * f.sz * (f.px + p.entryPx));
            }
          }
        }
      }
      if (!why) continue;
      const px = mids[p.coin];
      if (!coin || !(px > 0)) {
        state.lastError = `${p.coin}: no price to close at`;
        continue;
      }
      const slip = CLOSE_SLIP[Math.min(p.closeTries, CLOSE_SLIP.length - 1)];
      const sz = Math.abs(held.szi);
      const f = await pv.order(coin, p.dir < 0, px * (1 - p.dir * slip), sz, true);
      p.closeTries++;
      if (!f.filled) {
        if (/does not exist/i.test(f.error ?? "")) p.w ? (state.agentOk2 = false) : (state.agentOk = false);
        state.lastError = `${p.coin} close: ${f.error}`;
        continue;
      }
      if (f.oid != null) p.closeOids = [...(p.closeOids ?? []), f.oid];
      if (f.sz < sz - 1e-9) continue; // part closed: the rest goes at the next look, booked when all of it is out
      delete pa.positions[p.coin];
      const oids = [p.openOid, ...(p.closeOids ?? [])].filter((x): x is number => x != null);
      const own = p.openOid != null && p.closeOids?.length ? await pv.result(oids, p.openedMs - 60_000).catch(() => null) : null;
      const net = own ?? (p.partUsd ?? 0) + p.dir * (f.px - p.entryPx) * sz - TAKER_FEE * sz * (f.px + p.entryPx);
      if (p.forceClose) state.ghosts = [...(state.ghosts ?? []), { coin: p.coin, dir: p.dir, sz, closePx: f.px, paperId: p.paperId, closedAt: now, lockedUsd: r2(net) }].slice(-200);
      book(p, net, why, now, stop, isProven(p.rule));
      const tst = p.w ? state.test2 : state.test;
      if (p.rule === TEST_RULE && tst) tst.result = `opened and closed, ${r2(state.rows[state.rows.length - 1].netUsd)} USD`;
    }

    // ---- the one test trade ----
    if (testDue && !state.opens.some((x) => x.rule === TEST_RULE && !x.w)) {
      state.test = { id: cfg.testOnce, at: now, result: "tried" }; // a name is used once, whatever happens next
      save();
      const r = await open(d, { id: `test:${cfg.testOnce}`, rule: TEST_RULE, coin: "BTC", dir: 1, at: now, lev: 1 }, MIN_ORDER_USD, coins, mids, acct, now);
      state.test.result = r || "opened";
    }
    // the second wallet's one test trade: only once it has money and its trading key is named (the name is not used up before)
    if (test2Due && ready2 && !state.opens.some((x) => x.w && (x.rule === TEST_RULE || x.coin === "BTC")) && !acct2!.positions.BTC) {
      state.test2 = { id: cfg.second!.testOnce, at: now, result: "tried" };
      save();
      const r = await open(d, { id: `test2:${cfg.second!.testOnce}`, rule: TEST_RULE, coin: "BTC", dir: 1, at: now, lev: 1 }, MIN_ORDER_USD, coins, mids, acct2!, now, false, 2);
      state.test2.result = r || "opened";
    }

    // skill passers first (skill bar): when the money is short they get it before the others
    const passes = (rule: string) => !!cfg.skillBar && !!d.skillPass?.(rule);
    const ordered = cfg.skillBar ? [...paper].sort((a, b) => Number(passes(b.rule)) - Number(passes(a.rule))) : paper;
    /** a copy of a trader that does not pass may not take the last base position of free money (skill bar) */
    const keptForPassers = (rule: string, wa: Account) => !!cfg.skillBar && !passes(rule) && wa.freeUsd < 2 * cfg.collateralUsd + 1;
    // ---- new copies ----
    if (cfg.on) {
      for (const x of ordered) {
        if (state.seen.includes(x.id) || now - x.at > OPEN_WINDOW_MS) continue;
        if (!isReal(x.rule)) continue; // not marked seen: it is simply not ours to copy
        state.seen.push(x.id);
        if (state.seen.length > 4000) state.seen = state.seen.slice(-4000);
        if (loss() >= cfg.maxLossUsd) (skip("loss cap reached"));
        else if (!d.listed(x.rule)) skip("trader off the list");
        else if (state.opens.filter((o) => !o.w).length >= cfg.maxOpen && where(x.coin) !== 2) skip("all positions in use");
        else {
          // a coin the first wallet holds for another trader goes to the second wallet (its own leverage, margin and
          // exit); held in both, or no second wallet: skipped
          const w = where(x.coin);
          const why = !w ? "coin already held" : keptForPassers(x.rule, w === 2 ? acct2! : acct) ? "cash kept for skill passers" : await open(d, x, convictionUsd(hlCollateral(x.rule, cfg.collateralUsd), x.share, realOf(x.rule)), coins, mids, w === 2 ? acct2! : acct, now, false, w);
          if (why) skip(why);
        }
      }
    }

    // ---- late copies: what a real trader still holds and we never held, while the price is still near its entry ----
    if (cfg.on && (cfg.lateWithin ?? 0) > 0 && loss() < cfg.maxLossUsd) {
      for (const x of ordered) {
        const full1 = state.opens.filter((o) => !o.w).length >= cfg.maxOpen;
        if (now - x.at <= OPEN_WINDOW_MS || !(x.px && x.px > 0)) continue;
        if (state.held.includes(x.id) || state.lateOff.includes(x.id)) continue;
        if (!isReal(x.rule) || !d.listed(x.rule)) continue;
        const w = where(x.coin);
        const wa = w === 2 ? acct2! : acct;
        if (!w || (w === 1 && full1) || wa.freeUsd < cfg.collateralUsd + 1 || keptForPassers(x.rule, wa)) continue;
        const px = mids[x.coin];
        if (!(px > 0) || Math.abs(px / x.px - 1) > (cfg.lateWithin ?? 0)) continue;
        const why = await open(d, x, convictionUsd(hlCollateral(x.rule, cfg.collateralUsd), x.share, realOf(x.rule)), coins, mids, wa, now, true, w);
        if (why) {
          skip(`late copy: ${why}`);
          state.lateOff = [...state.lateOff, x.id].slice(-500);
        }
      }
    }
    state.lastError = "";
  } catch (e) {
    state.lastError = String((e as Error)?.message ?? e).replace(/0x[0-9a-fA-F]{40,}/g, "…").slice(0, 160);
  } finally {
    save();
    busy = false;
  }
}

/** Open one copy. Returns "" when it is open, else why not. */
async function open(d: HlDeps, x: PaperOpen, collateralUsd: number, coins: Record<string, Coin>, mids: Record<string, number>, acct: Account, now: number, late = false, w: 1 | 2 = 1): Promise<string> {
  const venue = w === 2 ? d.venue2 : d.venue;
  if (!venue) return "no second wallet";
  const coin = coins[x.coin];
  const px = mids[x.coin];
  if (!coin || !(px > 0)) return "coin not on Hyperliquid's list";
  const lev = leverageFor(x.lev, coin);
  // Hyperliquid's smallest order is $10: a 1x copy of $10 came out a few cents under it and was never made. Such a
  // copy is made at the smallest size Hyperliquid takes (about $11) instead.
  const sz = roundSz(Math.max(collateralUsd * lev, MIN_ORDER_USD) / px, coin.szDecimals);
  if (sz * px < MIN_ORDER_USD - 1) return "position too small for Hyperliquid";
  if (acct.freeUsd < collateralUsd + 1) return "not enough free money";
  const lv = await venue.setLeverage(coin, lev);
  if (lv) return `leverage not set`;
  const f = await venue.order(coin, x.dir > 0, px * (1 + x.dir * OPEN_SLIP), sz, false);
  if (!f.filled) {
    if (/does not exist/i.test(f.error ?? "")) w === 2 ? (state.agentOk2 = false) : (state.agentOk = false);
    state.lastError = `${x.coin} open: ${f.error}`;
    return "order not filled";
  }
  acct.freeUsd -= (f.sz * f.px) / lev;
  const gapPct = x.their ? entryGapPct(x.dir, f.px, x.their) : null;
  state.opens.push({ rule: x.rule, coin: x.coin, paperId: x.id, dir: x.dir, lev, sz: f.sz, entryPx: f.px, ...(gapPct != null ? { gapPct } : {}), ...(late ? {} : { lagSec: Math.max(0, Math.round((now - x.at) / 1000)) }), collUsd: r2((f.sz * f.px) / lev), openOid: f.oid, openedMs: now, closeTries: 0, ...(late ? { late: true } : {}), ...(x.share != null ? { share: x.share } : {}), ...(x.left != null && x.left > 0 ? { left0: Math.min(1, x.left) } : {}), ...(w === 2 ? { w: 2 as const } : {}) });
  if (!late && x.rule !== TEST_RULE) noteDelay("realOpen", x.rule, x.coin);
  state.held = [...state.held, x.id].slice(-4000);
  save();
  return "";
}

export const fileCfg = (): HlLiveConfig => {
  try {
    return parseHlLive(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8"));
  } catch {
    return OFF;
  }
};

/** For the status and the dashboard tab. Traders by their short rule name only: no address. */
export function hlLiveSummary(cfg: HlLiveConfig = fileCfg(), meetsBar: (rule: string, sinceMs: number, now: number) => boolean = () => false, now = Date.now(), histAvgPct: (rule: string) => number | null = () => null, provenOf: (rule: string) => boolean = () => false) {
  if (!loaded) load();
  const rules = [...new Set([...state.rows.map((x) => x.rule), ...state.opens.map((x) => x.rule)])].filter((x) => x !== TEST_RULE);
  return {
    on: cfg.on,
    note: "REAL. Copies of Hyperliquid traders on Hyperliquid itself, every coin; isolated margin; a trader is real on its own paper record, then on its real record.",
    keepBar: cfg.keepBar ?? null,
    skillBar: !!cfg.skillBar,
    limits: { collateralUsd: cfg.collateralUsd, maxOpen: cfg.maxOpen, maxLossUsd: cfg.maxLossUsd, traderStopUsd: cfg.traderStopUsd, lateWithinPct: Math.round((cfg.lateWithin ?? 0) * 10000) / 100 },
    // both wallets as one (the worth counts them as one), and each beside it
    account: state.account && state.account2 ? { at: Math.min(state.account.at, state.account2.at), valueUsd: r2(state.account.valueUsd + state.account2.valueUsd), freeUsd: r2(state.account.freeUsd + state.account2.freeUsd) } : (state.account ?? null),
    second: cfg.second || state.account2 ? { on: !!cfg.second?.on, account: state.account2 ?? null, first: state.account ?? null, keyNamed: !!state.agentOk2, test: state.test2 ?? null, open: state.opens.filter((p) => p.w).length, lastError: state.lastError2 ?? "" } : null,
    netUsd: state.netUsd,
    // force-closed positions: what closing locked in, and what holding until the trader closed would have added (after
    // our close; fees left out). Open ghosts are at the price now.
    closeAllGhosts: state.ghosts?.length ? (() => {
      const gs = state.ghosts!;
      const after = (g: (typeof gs)[number]) => g.dir * ((g.exitPx ?? g.nowPx ?? g.closePx) - g.closePx) * g.sz;
      return { id: state.closeAllId ?? null, n: gs.length, stillHeldByTrader: gs.filter((g) => !g.exitAt).length, lockedUsd: r2(gs.reduce((a, g) => a + g.lockedUsd, 0)), holdingWouldAddUsd: r2(gs.reduce((a, g) => a + after(g), 0)), rows: gs.map((g) => ({ coin: g.coin, side: g.dir > 0 ? "long" : "short", lockedUsd: g.lockedUsd, holdingWouldAddUsd: r2(after(g)), traderClosed: !!g.exitAt })) };
    })() : null,
    trades: state.rows.length,
    won: state.rows.filter((x) => x.netUsd > 0).length,
    halted: cfg.on && loss() >= cfg.maxLossUsd ? "loss cap reached: nothing new is opened" : "",
    opens: state.opens.map((p) => ({ wallet: p.w ?? 1, trader: p.rule, coin: p.coin, side: p.dir > 0 ? "long" : "short", leverage: p.lev, collateralUsd: p.collUsd, entryPx: p.entryPx, unrealUsd: p.unrealUsd ?? null, openedAt: p.openedMs, late: !!p.late, conviction: p.share ?? null, partCloses: p.parts ?? 0, traderHolds: p.traderLeft ?? null, onHyperliquid: p.venueLev == null ? null : { leverage: p.venueLev, isolated: !!p.venueIsolated, marginUsd: p.venueMarginUsd ?? null, same: p.venueLev === p.lev && !!p.venueIsolated } })),
    traders: rules.map((rule) => {
      const real = realOf(rule);
      const st0 = standing(real, meetsBar(rule, state.demoted[rule] ?? 0, now), state.demotedWhy[rule]);
      const kept = keepsTrader(real, histAvgPct(rule), cfg.keepBar);
      const all = realRecord(state.rows.filter((x) => x.rule === rule).map((x) => x.netUsd));
      const allNoFlip = realRecord(state.rows.filter((x) => x.rule === rule && !isFlip(x)).map((x) => x.netUsd));
      const pv = !!cfg.provenT && provenOf(rule);
      const st = pv ? (provenCut(allNoFlip.trades, allNoFlip.net) ? { real: false, why: `paper: proven tier, but behind after ${allNoFlip.trades} real copies` } : { real: true, why: `real: proven tier (skill ${cfg.provenT}+ standard errors), cut only after ${PROVEN_CUT_N}+ real copies behind` }) : st0.real && !kept.ok ? { real: false, why: kept.why } : st0;
      // trades, won, netUsd: every real trade ever made with this trader, kept through a cut (what it made us);
      // sinceCut: the record the keep-or-cut rule looks at, which starts again at a cut
      return { trader: rule, real: st.real, why: st.why, proven: pv, trades: all.trades, won: all.won, netUsd: r2(all.net), cutAt: state.demoted[rule] ?? null, sinceCut: { trades: real.trades, won: real.won, netUsd: r2(real.net) } };
    }),
    recent: state.rows.slice(-30).reverse(),
    // our real fill against the trader's own average entry (positive = worse for us), and seconds from the paper
    // copy seeing the position to our fill; a late copy waits on purpose, so it is counted apart (22 Nov 2026)
    entryGap: (() => {
      const all = [...state.rows.map((x) => ({ g: x.gapPct, l: x.lagSec })), ...state.opens.map((p) => ({ g: p.gapPct, l: p.lagSec }))];
      const lags = all.map((x) => x.l).filter((x): x is number => x != null).sort((a, b) => a - b);
      return { ...gapStats(all.map((x) => x.g).filter((x): x is number => x != null)), seenToFillSecMedian: lags.length ? lags[Math.floor(lags.length / 2)] : null, seenToFillN: lags.length };
    })(),
    test: state.test ?? null,
    skipped: state.skipped,
    lastError: state.lastError,
  };
}

export const _test = { reset: () => ((state = fresh()), (loaded = true), (busy = false)), state: () => state, reload: () => load() };
