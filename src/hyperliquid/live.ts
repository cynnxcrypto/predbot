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
 *   - the copy is opened only in the first OPEN_WINDOW_MS after the paper copy, and closed when the paper copy closes.
 *
 * deploy/live-rules.json "hyperliquid": { "trade": { "on": true, "collateralUsd": 10, "maxOpen": 5, "maxLossUsd": 50,
 * "traderStopUsd": 9, "testOnce": "<name>" } }. No block or on != true: nothing is opened (open positions are still
 * closed). testOnce: ONE smallest BTC long, opened and closed at the next look, once per name.
 *
 * Orders are signed by the trading key (it cannot withdraw). State: data/hyperliquid-live.json (server only).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config.js";
import { loadJson, saveJson } from "../store.js";
import { cutReason, realRecord, standing } from "../solana/realfirst.js";
import type { Coin, Fill } from "./exchange.js";
import { roundSz } from "./exchange.js";

export const HARD_COLLATERAL_USD = 25;
export const MIN_COLLATERAL_USD = 10;
export const HARD_MAX_LOSS_USD = 50;
export const HARD_MAX_OPEN = 10;
export const HARD_TRADER_STOP_USD = 10;
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

export interface HlLiveConfig {
  on: boolean;
  collateralUsd: number;
  maxOpen: number;
  maxLossUsd: number;
  traderStopUsd: number;
  testOnce: string;
}
const OFF: HlLiveConfig = { on: false, collateralUsd: MIN_COLLATERAL_USD, maxOpen: 0, maxLossUsd: 0, traderStopUsd: 0, testOnce: "" };
/** Parse the "hyperliquid.trade" block of deploy/live-rules.json. Hard limits are applied here; anything odd means off. */
export function parseHlLive(text: string): HlLiveConfig {
  try {
    const p = (JSON.parse(text) as { hyperliquid?: { trade?: Record<string, unknown> } }).hyperliquid?.trade;
    if (!p) return OFF;
    const testOnce = typeof p.testOnce === "string" && /^[a-z0-9-]{1,40}$/.test(p.testOnce) ? p.testOnce : "";
    const maxLossUsd = clamp(num(p.maxLossUsd, 0), 0, HARD_MAX_LOSS_USD);
    const collateralUsd = clamp(num(p.collateralUsd, MIN_COLLATERAL_USD), MIN_COLLATERAL_USD, HARD_COLLATERAL_USD);
    if (p.on !== true || !(maxLossUsd > 0)) return { ...OFF, collateralUsd, testOnce };
    return { on: true, collateralUsd, maxLossUsd, testOnce, maxOpen: Math.floor(clamp(num(p.maxOpen, 5), 1, HARD_MAX_OPEN)), traderStopUsd: clamp(num(p.traderStopUsd, 9), 1, HARD_TRADER_STOP_USD) };
  } catch {
    return OFF;
  }
}

export interface VenuePos {
  szi: number;
  entryPx: number;
  unrealUsd: number;
  marginUsd: number;
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
}
export interface PaperOpen {
  id: string;
  rule: string;
  coin: string;
  dir: number;
  at: number;
  lev?: number;
}
export interface HlDeps {
  cfg(): HlLiveConfig;
  venue: Venue;
  paperOpens(): PaperOpen[];
  /** does this trader's paper record made after `sinceMs` meet the bar for real? */
  meetsBar(rule: string, sinceMs: number, now: number): boolean;
  /** is the trader still on the list followed now? */
  listed(rule: string): boolean;
}

interface Pos {
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
  goneLooks?: number;
  unrealUsd?: number;
  markMs?: number;
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
}
interface State {
  netUsd: number;
  opens: Pos[];
  rows: Row[];
  demoted: Record<string, number>;
  demotedWhy: Record<string, string>;
  seen: string[];
  skipped: Record<string, number>;
  test?: { id: string; at: number; result: string };
  agentOk?: boolean;
  lastError: string;
  account?: { at: number; valueUsd: number; freeUsd: number };
}
const fresh = (): State => ({ netUsd: 0, opens: [], rows: [], demoted: {}, demotedWhy: {}, seen: [], skipped: {}, lastError: "" });
let state: State = fresh();
let loaded = false;
const load = () => {
  loaded = true;
  state = { ...fresh(), ...loadJson<Partial<State>>(FILE, {}) };
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
const realOf = (rule: string) => realRecord(state.rows.filter((x) => x.rule === rule && x.t > (state.demoted[rule] ?? 0) && !isFlip(x)).map((x) => x.netUsd));
const loss = () => Math.max(0, -state.netUsd);

/** The traders the paper side must keep following even off the daily list: a real position open here, or real copies ahead. */
export const hlKeptTraders = () => {
  if (!loaded) load();
  const ids = [...new Set([...state.opens.map((x) => x.rule), ...state.rows.map((x) => x.rule)])].filter((id) => id.startsWith("copy-"));
  return ids.filter((id) => state.opens.some((x) => x.rule === id) || (realOf(id).trades > 0 && realOf(id).net > 0));
};

/** The leverage of a copy: the trader's own, a whole number, never above half of Hyperliquid's limit for the coin. */
export const leverageFor = (traderLev: number | undefined, coin: Coin) => Math.max(1, Math.min(Math.floor(traderLev ?? 2), Math.max(1, Math.floor(coin.maxLeverage / 2))));

function book(p: Pos, netUsd: number, why: string, now: number, stop: number) {
  state.netUsd = r2(state.netUsd + netUsd);
  state.rows.push({ t: now, rule: p.rule, coin: p.coin, side: p.dir > 0 ? "long" : "short", leverage: p.lev, netUsd: r2(netUsd), heldH: Math.round(((now - p.openedMs) / 3_600_000) * 100) / 100, why, collateralUsd: p.collUsd });
  if (state.rows.length > 2000) state.rows = state.rows.slice(-2000);
  state.opens = state.opens.filter((x) => x !== p);
  if (p.rule === TEST_RULE) return;
  const cut = cutReason(realOf(p.rule), stop);
  if (cut) {
    state.demotedWhy[p.rule] = cut;
    state.demoted[p.rule] = now;
  }
}

let busy = false;
/** One look: close what is due, then open what is new. Never throws. */
export async function hlLiveTick(d: HlDeps, now = Date.now()): Promise<void> {
  if (busy) return;
  if (!loaded) load();
  const cfg = d.cfg();
  const testDue = !!cfg.testOnce && state.test?.id !== cfg.testOnce;
  if (!cfg.on && !testDue && !state.opens.length) return;
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
    const [coins, mids] = [await v.coins(), await v.mids()];
    const paper = d.paperOpens();
    const stop = cfg.traderStopUsd || HARD_TRADER_STOP_USD - 1;
    const isReal = (rule: string) => standing(realOf(rule), d.meetsBar(rule, state.demoted[rule] ?? 0, now), state.demotedWhy[rule]).real;

    // ---- what we hold: mark it, close what is due ----
    for (const p of [...state.opens]) {
      const held = acct.positions[p.coin];
      const coin = coins[p.coin];
      if (!held || Math.sign(held.szi) !== p.dir) {
        // liquidated, or closed by hand: only after several looks in a row, and at what Hyperliquid's record says it made
        p.goneLooks = (p.goneLooks ?? 0) + 1;
        if (p.goneLooks >= GONE_LOOKS) book(p, (p.openOid != null ? await v.result([p.openOid], p.openedMs - 60_000).catch(() => null) : null) ?? -p.collUsd, "gone: liquidated or closed outside the bot", now, stop);
        continue;
      }
      p.goneLooks = 0;
      p.unrealUsd = r2(held.unrealUsd);
      p.markMs = now;
      const why = p.rule === TEST_RULE ? "test" : !paper.some((x) => x.id === p.paperId) ? "the trader closed" : now - p.openedMs > MAX_HOLD_H * 3_600_000 ? "max hold" : "";
      if (!why) continue;
      const px = mids[p.coin];
      if (!coin || !(px > 0)) {
        state.lastError = `${p.coin}: no price to close at`;
        continue;
      }
      const slip = CLOSE_SLIP[Math.min(p.closeTries, CLOSE_SLIP.length - 1)];
      const sz = Math.abs(held.szi);
      const f = await v.order(coin, p.dir < 0, px * (1 - p.dir * slip), sz, true);
      p.closeTries++;
      if (!f.filled) {
        if (/does not exist/i.test(f.error ?? "")) state.agentOk = false;
        state.lastError = `${p.coin} close: ${f.error}`;
        continue;
      }
      if (f.oid != null) p.closeOids = [...(p.closeOids ?? []), f.oid];
      if (f.sz < sz - 1e-9) continue; // part closed: the rest goes at the next look, booked when all of it is out
      delete acct.positions[p.coin];
      const oids = [p.openOid, ...(p.closeOids ?? [])].filter((x): x is number => x != null);
      const own = p.openOid != null && p.closeOids?.length ? await v.result(oids, p.openedMs - 60_000).catch(() => null) : null;
      book(p, own ?? p.dir * (f.px - p.entryPx) * p.sz - TAKER_FEE * p.sz * (f.px + p.entryPx), why, now, stop);
      if (p.rule === TEST_RULE && state.test) state.test.result = `opened and closed, ${r2(state.rows[state.rows.length - 1].netUsd)} USD`;
    }

    // ---- the one test trade ----
    if (testDue && !state.opens.some((x) => x.rule === TEST_RULE)) {
      state.test = { id: cfg.testOnce, at: now, result: "tried" }; // a name is used once, whatever happens next
      save();
      const r = await open(d, { id: `test:${cfg.testOnce}`, rule: TEST_RULE, coin: "BTC", dir: 1, at: now, lev: 1 }, MIN_ORDER_USD, coins, mids, acct, now);
      state.test.result = r || "opened";
    }

    // ---- new copies ----
    if (cfg.on) {
      for (const x of paper) {
        if (state.seen.includes(x.id) || now - x.at > OPEN_WINDOW_MS) continue;
        if (!isReal(x.rule)) continue; // not marked seen: it is simply not ours to copy
        state.seen.push(x.id);
        if (state.seen.length > 4000) state.seen = state.seen.slice(-4000);
        if (loss() >= cfg.maxLossUsd) (skip("loss cap reached"));
        else if (!d.listed(x.rule)) skip("trader off the list");
        else if (state.opens.length >= cfg.maxOpen) skip("all positions in use");
        else if (state.opens.some((o) => o.coin === x.coin) || acct.positions[x.coin]) skip("coin already held");
        else {
          const why = await open(d, x, cfg.collateralUsd, coins, mids, acct, now);
          if (why) skip(why);
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
async function open(d: HlDeps, x: PaperOpen, collateralUsd: number, coins: Record<string, Coin>, mids: Record<string, number>, acct: Account, now: number): Promise<string> {
  const coin = coins[x.coin];
  const px = mids[x.coin];
  if (!coin || !(px > 0)) return "coin not on Hyperliquid's list";
  const lev = leverageFor(x.lev, coin);
  // Hyperliquid's smallest order is $10: a 1x copy of $10 came out a few cents under it and was never made. Such a
  // copy is made at the smallest size Hyperliquid takes (about $11) instead.
  const sz = roundSz(Math.max(collateralUsd * lev, MIN_ORDER_USD) / px, coin.szDecimals);
  if (sz * px < MIN_ORDER_USD - 1) return "position too small for Hyperliquid";
  if (acct.freeUsd < collateralUsd + 1) return "not enough free money";
  const lv = await d.venue.setLeverage(coin, lev);
  if (lv) return `leverage not set`;
  const f = await d.venue.order(coin, x.dir > 0, px * (1 + x.dir * OPEN_SLIP), sz, false);
  if (!f.filled) {
    if (/does not exist/i.test(f.error ?? "")) state.agentOk = false;
    state.lastError = `${x.coin} open: ${f.error}`;
    return "order not filled";
  }
  acct.freeUsd -= (f.sz * f.px) / lev;
  state.opens.push({ rule: x.rule, coin: x.coin, paperId: x.id, dir: x.dir, lev, sz: f.sz, entryPx: f.px, collUsd: r2((f.sz * f.px) / lev), openOid: f.oid, openedMs: now, closeTries: 0 });
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
export function hlLiveSummary(cfg: HlLiveConfig = fileCfg(), meetsBar: (rule: string, sinceMs: number, now: number) => boolean = () => false, now = Date.now()) {
  if (!loaded) load();
  const rules = [...new Set([...state.rows.map((x) => x.rule), ...state.opens.map((x) => x.rule)])].filter((x) => x !== TEST_RULE);
  return {
    on: cfg.on,
    note: "REAL. Copies of Hyperliquid traders on Hyperliquid itself, every coin; isolated margin; a trader is real on its own paper record, then on its real record.",
    limits: { collateralUsd: cfg.collateralUsd, maxOpen: cfg.maxOpen, maxLossUsd: cfg.maxLossUsd, traderStopUsd: cfg.traderStopUsd },
    account: state.account ?? null,
    netUsd: state.netUsd,
    trades: state.rows.length,
    won: state.rows.filter((x) => x.netUsd > 0).length,
    halted: cfg.on && loss() >= cfg.maxLossUsd ? "loss cap reached: nothing new is opened" : "",
    opens: state.opens.map((p) => ({ trader: p.rule, coin: p.coin, side: p.dir > 0 ? "long" : "short", leverage: p.lev, collateralUsd: p.collUsd, entryPx: p.entryPx, unrealUsd: p.unrealUsd ?? null, openedAt: p.openedMs })),
    traders: rules.map((rule) => {
      const real = realOf(rule);
      const st = standing(real, meetsBar(rule, state.demoted[rule] ?? 0, now), state.demotedWhy[rule]);
      // trades, won, netUsd: every real trade ever made with this trader, kept through a cut (what it made us);
      // sinceCut: the record the keep-or-cut rule looks at, which starts again at a cut
      const all = realRecord(state.rows.filter((x) => x.rule === rule).map((x) => x.netUsd));
      return { trader: rule, real: st.real, why: st.why, trades: all.trades, won: all.won, netUsd: r2(all.net), cutAt: state.demoted[rule] ?? null, sinceCut: { trades: real.trades, won: real.won, netUsd: r2(real.net) } };
    }),
    recent: state.rows.slice(-30).reverse(),
    test: state.test ?? null,
    skipped: state.skipped,
    lastError: state.lastError,
  };
}

export const _test = { reset: () => ((state = fresh()), (loaded = true), (busy = false)), state: () => state, reload: () => load() };
