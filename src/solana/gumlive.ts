/**
 * REAL perps on Jupiter's order book (Gum), 17 Nov 2026. enrique: "from jupiter we can also do other coins im sure,
 * at least 5 or 6". The JLP pool (perpslive.ts) has only SOL, BTC and ETH; the order book has more (the server's look,
 * 17 Nov: BNB, HYPE, JUP, NEAR, ZEC and tokenized stocks, $5 minimum order, 3.5 bps taker fee). This side copies a
 * real trader's position on those other coins, under the same rules as the pool side:
 *  - the same traders: a trader is real on its paper record (the bar) and then on its REAL record, one record for
 *    both venues (perpslive.ts setOtherVenueReal / cutRule): a cut on either side is one cut;
 *  - the same leverage limits (the trader's, at most half the market's maximum) and the same caps: collateral per
 *    position, a loss cap for this side, a loss stop per trader, positions at once;
 *  - each position in its own ISOLATED margin account: a liquidation takes that position's collateral and nothing else;
 *  - closed when the trader's position closes, or after MAX_HOLD_H.
 * Everything is behind the "solanaGum" block of deploy/live-rules.json; no block, or on false, means nothing is sent.
 * Three more switches there, each used once by its name: createAccount (make the wallet's account on Gum),
 * deposit {id, usd} (move USDC in), dryRun "<id>" (a resting order far from the price, then cancelled), test
 * {id, coin, side} (one small position, closed at the next look).
 * The perps wallet signs (keys.ts namedWallet("perps")). Results come from Gum's position history (each closed
 * position's netPnl: price, fees and funding), never from a guess: a result not yet listed stops new positions.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DATA, ROOT } from "../config.js";
import { namedWallet, type Wallet } from "./keys.js";
import { cutReason, realRecord, standing } from "./realfirst.js";
import { perpMeetsBar, perpPaperOpensOn } from "./buckets.js";
import { cutRule, leverageFor, perpsCutAt, perpsRealOf, setOtherVenueReal, MAX_HOLD_H, OPEN_WINDOW_MS, TEST_RULE } from "./perpslive.js";
import { gum, signApiTx, txLayout, txRoles, redactKeys, signedCancelAll, signedPlace, type GumMarket, type GumPlace } from "./gum.js";

export const HARD_COLLATERAL_USD = 25;
export const MIN_COLLATERAL_USD = 5;
export const HARD_MAX_LOSS_USD = 50;
export const HARD_RULE_STOP_USD = 10;
export const HARD_MAX_OPEN = 6;
export const HARD_DEPOSIT_USD = 100;
/** the worst price an opening order accepts, and the closing tries (then a sweep at any price) */
export const OPEN_SLIP = 0.01;
export const CLOSE_SLIP = [0.02, 0.05, 0.1] as const;
/** an opening order is IOC: no position after this long means it did not fill */
export const FILL_MS = 60_000;
/** a close is tried again after this long */
export const RETRY_MS = 60_000;
/** a closed position not yet in the history after this long stops new positions until it is */
export const UNREAD_MS = 30 * 60_000;
const r2 = (x: number) => Math.round(x * 100) / 100;
const STATE = () => join(DATA, "solana-gumlive.json");

export interface GumConfig {
  on: boolean;
  createAccount: boolean;
  collateralUsd: number;
  maxLossUsd: number;
  ruleStopUsd: number;
  maxOpen: number;
  deposit?: { id: string; usd: number };
  dryRun?: string;
  test?: { id: string; coin: string; side: "long" | "short" };
}
const OFF: GumConfig = { on: false, createAccount: false, collateralUsd: 0, maxLossUsd: 0, ruleStopUsd: 0, maxOpen: 0 };
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const id = (v: unknown) => (typeof v === "string" && /^[\w.-]{1,40}$/.test(v) ? v : undefined);
/** The "solanaGum" block of deploy/live-rules.json. Hard limits applied here; anything odd means off. */
export function parseGum(text: string): GumConfig {
  try {
    const p = (JSON.parse(text) as { solanaGum?: Record<string, unknown> }).solanaGum;
    if (!p || typeof p !== "object") return OFF;
    const maxLossUsd = clamp(num(p.maxLossUsd, 0), 0, HARD_MAX_LOSS_USD);
    const dep = p.deposit as { id?: unknown; usd?: unknown } | undefined;
    const t = p.test as { id?: unknown; coin?: unknown; side?: unknown } | undefined;
    return {
      on: p.on === true && maxLossUsd > 0,
      createAccount: p.createAccount === true,
      maxLossUsd,
      collateralUsd: clamp(num(p.collateralUsd, 10), MIN_COLLATERAL_USD, HARD_COLLATERAL_USD),
      ruleStopUsd: clamp(num(p.ruleStopUsd, 9), 1, HARD_RULE_STOP_USD),
      maxOpen: Math.floor(clamp(num(p.maxOpen, 3), 1, HARD_MAX_OPEN)),
      ...(dep && id(dep.id) && num(dep.usd, 0) > 0 ? { deposit: { id: id(dep.id)!, usd: clamp(num(dep.usd, 0), 0, HARD_DEPOSIT_USD) } } : {}),
      ...(id(p.dryRun) ? { dryRun: id(p.dryRun) } : {}),
      ...(t && id(t.id) && typeof t.coin === "string" && (t.side === "long" || t.side === "short") ? { test: { id: id(t.id)!, coin: t.coin, side: t.side } } : {}),
    };
  } catch {
    return OFF;
  }
}

// ---- state ---------------------------------------------------------------------------------------------------------
interface Pos {
  rule: string;
  coin: string;
  paperId: string;
  dir: number;
  lev: number;
  collUsd: number;
  qty: number;
  stage: "opening" | "open" | "closing" | "booking";
  sentMs: number;
  openedMs?: number;
  closeTries: number;
  /** when its position was first seen gone (closed by us, liquidated, or deleveraged): its result is read from the history */
  goneMs?: number;
  clientId: string;
  /** USDC moved from the cross account into the coin's isolated account with the order (what was there already is used first) */
  moveUsd?: number;
}
interface Row {
  t: number;
  rule: string;
  coin: string;
  side: string;
  leverage: number;
  filled: boolean;
  netUsd: number;
  heldH: number | null;
  /** "trade", "liquidation" or "adl", as Gum says */
  how?: string;
}
interface State {
  netUsd: number;
  halted: string;
  unread: string;
  opens: Pos[];
  rows: Row[];
  seen: string[];
  skipped: Record<string, number>;
  /** the wallet's cross-margin account on Gum, and its subaccount */
  account?: { cross: string; sub: number };
  created?: { at: number; result: string };
  deposits?: Record<string, { at: number; result: string }>;
  /** the layout of the last deposit transaction the API built (no address): what the signer saw */
  depositLayout?: unknown;
  dry?: { id: string; at: number; result: string };
  test?: { id: string; at: number; result?: string };
  lastError: string;
}
const fresh = (): State => ({ netUsd: 0, halted: "", unread: "", opens: [], rows: [], seen: [], skipped: {}, lastError: "" });
let state: State = fresh();
let loaded = false;
function load() {
  loaded = true;
  let text: string;
  try {
    text = readFileSync(STATE(), "utf8");
  } catch {
    return;
  }
  try {
    state = { ...fresh(), ...(JSON.parse(text) as State) };
  } catch {
    state.halted = "the state file could not be read: the loss count is unknown, so nothing is opened";
  }
}
function save() {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(STATE() + ".tmp", JSON.stringify(state));
  renameSync(STATE() + ".tmp", STATE());
}
const loss = () => Math.max(0, -state.netUsd);
const stopped = () => state.halted || state.unread || "";
const skip = (why: string) => void (state.skipped[why] = (state.skipped[why] ?? 0) + 1);

/** This side's real results of a rule since `sinceMs`, for the one shared record (perpslive.ts). */
export const gumNets = (rule: string, sinceMs: number) => {
  if (!loaded) load();
  return state.rows.filter((x) => x.rule === rule && x.filled && x.t > sinceMs).map((x) => x.netUsd);
};
setOtherVenueReal(gumNets);
/** Real here: the shared record decides once there is one; before, the paper bar (no SOL/BTC/ETH copies asked: other coins). */
export function gumStanding(rule: string, now = Date.now()) {
  const cut = perpsCutAt(rule);
  return standing(perpsRealOf(rule), perpMeetsBar(rule, cut.at, now, 0), cut.why);
}

// ---- what it needs from Gum (production: the API; tests: fakes) -----------------------------------------------------
export interface GumPosition {
  symbol: string;
  side: "Bid" | "Ask";
  size: string;
  isolated?: boolean;
  markPrice?: string;
}
export interface GumClosed {
  symbol: string;
  isolated?: boolean;
  netPnl: string;
  closeReason?: string;
  openedAt: number;
  closedAt: number;
}
export interface GumAccount {
  pubkey: string;
  subaccountId: number;
  isolated: boolean;
  market?: string | null;
  data?: { freeBalance?: string; accountValue?: string };
}
export interface GumDeps {
  cfg: () => GumConfig;
  wallet: () => Wallet;
  markets: () => Promise<GumMarket[]>;
  accounts: (w: Wallet) => Promise<GumAccount[]>;
  createAccount: (w: Wallet) => Promise<void>;
  positions: (cross: string) => Promise<GumPosition[]>;
  history: (cross: string, symbol: string) => Promise<GumClosed[]>;
  blockhash: () => Promise<string>;
  place: (w: Wallet, body: unknown) => Promise<unknown>;
  cancelAll: (w: Wallet, body: unknown) => Promise<unknown>;
  /** build, sign (signApiTx) and submit a deposit into the cross account; returns the signature */
  deposit: (w: Wallet, cross: string, usd: number, seen: (layout: unknown) => void) => Promise<string>;
  paperOpens: (coins: string[]) => { id: string; rule: string; coin: string; dir: number; at: number; lev?: number }[];
  fixed: (e: unknown) => string;
  /** is this trader real now (tests; production: gumStanding) */
  isReal?: (rule: string, now: number) => boolean;
}

const sideOf = (dir: number): "Bid" | "Ask" => (dir > 0 ? "Bid" : "Ask");
const priceOf = (m: GumMarket) => m.markPrice ?? m.indexPrice ?? 0;
/** quantity for a collateral and leverage, rounded DOWN to the market's step (never above what was meant) */
export function qtyFor(m: GumMarket, collUsd: number, lev: number): number {
  const px = priceOf(m);
  const step = m.stepSize ?? m.baseLotSize / 10 ** m.baseDecimals;
  if (!(px > 0) || !(step > 0)) return 0;
  return Math.floor((collUsd * lev) / px / step + 1e-9) * step;
}
const minUsd = (m: GumMarket) => m.orderLimitConfig?.market?.minOrderNotional ?? 5;
const clientIdOf = (n: number) => BigInt(n % 9_000_000_000_000 || 1);

async function sendOpen(d: GumDeps, w: Wallet, m: GumMarket, p: Pos) {
  const px = priceOf(m);
  const o: GumPlace = {
    subaccountId: state.account!.sub,
    symbol: m.symbol,
    side: sideOf(p.dir),
    orderType: "market",
    price: px * (1 + p.dir * OPEN_SLIP),
    quantity: p.qty,
    reduceOnly: false,
    timeInForce: "ImmediateOrCancel",
    clientOrderId: BigInt(p.clientId),
    isIsolated: true,
    collateralAmount: BigInt(Math.round((p.moveUsd ?? p.collUsd) * 1e6)),
  };
  p.sentMs = Date.now();
  await d.place(w, signedPlace(w, m, o, state.account!.cross, await d.blockhash()));
}
async function sendClose(d: GumDeps, w: Wallet, m: GumMarket, p: Pos, qty: number) {
  const slip = CLOSE_SLIP[p.closeTries];
  const px = priceOf(m);
  const o: GumPlace = {
    subaccountId: state.account!.sub,
    symbol: m.symbol,
    side: sideOf(-p.dir),
    orderType: "market",
    // a long is closed by selling (the least accepted), a short by buying (the most paid); then any price
    price: slip === undefined || !(px > 0) ? 0 : px * (1 - p.dir * slip),
    quantity: qty,
    reduceOnly: true,
    timeInForce: "ImmediateOrCancel",
    clientOrderId: null,
    isIsolated: true,
    collateralAmount: 0n,
  };
  p.stage = "closing";
  p.closeTries++;
  p.sentMs = Date.now();
  save();
  await d.place(w, signedPlace(w, m, o, state.account!.cross, await d.blockhash()));
}

/** Book a finished position, judge its trader (one cut for both venues) and the loss cap. Not saved here. */
function book(d: GumDeps, p: Pos, net: number, filled: boolean, how?: string) {
  state.netUsd = r2(state.netUsd + net);
  state.rows = [...state.rows, { t: Date.now(), rule: p.rule, coin: p.coin, side: p.dir > 0 ? "long" : "short", leverage: p.lev, filled, netUsd: r2(net), heldH: p.openedMs ? Math.round(((Date.now() - p.openedMs) / 3_600_000) * 10) / 10 : null, ...(how ? { how } : {}) }].slice(-2000);
  state.opens = state.opens.filter((x) => x !== p);
  const c = d.cfg();
  if (p.rule !== TEST_RULE && filled) {
    const cut = cutReason(perpsRealOf(p.rule), c.ruleStopUsd);
    if (cut) cutRule(p.rule, cut);
  }
  if (p.rule === TEST_RULE && state.test) state.test.result = filled ? `closed: $${r2(net)}` : "not filled";
  if (!state.halted && c.maxLossUsd > 0 && loss() + c.collateralUsd > c.maxLossUsd + 1e-9) state.halted = `loss cap reached: $${r2(loss())} of $${c.maxLossUsd} (no room for another position)`;
}

let busy = false;
let marketsAt = 0;
let markets: GumMarket[] = [];
export async function gumLiveTick(d: GumDeps, now = Date.now()): Promise<void> {
  if (busy) return;
  if (!loaded) load();
  busy = true;
  try {
    const c = d.cfg();
    const w = d.wallet();
    // the account: made once, only on its switch (enrique's word); found if it is already there
    if (!state.account) {
      let accts = await d.accounts(w);
      if (!accts.some((a) => !a.isolated) && c.createAccount && !state.created) {
        state.created = { at: now, result: "asked" };
        save();
        try {
          await d.createAccount(w);
          accts = await d.accounts(w);
          state.created.result = accts.some((a) => !a.isolated) ? "made" : "asked, not there yet";
        } catch (e) {
          state.created.result = `error: ${d.fixed(e)}`;
        }
      }
      const cross = accts.filter((a) => !a.isolated).sort((a, b) => a.subaccountId - b.subaccountId)[0];
      if (cross) state.account = { cross: cross.pubkey, sub: cross.subaccountId };
      save();
      if (!state.account) return;
    }
    // a deposit, once per name
    if (c.deposit && !state.deposits?.[c.deposit.id]) {
      state.deposits = { ...(state.deposits ?? {}), [c.deposit.id]: { at: now, result: "sending" } };
      save();
      try {
        await d.deposit(w, state.account.cross, c.deposit.usd, (l) => void (state.depositLayout = l));
        state.deposits[c.deposit.id].result = `sent: $${c.deposit.usd}`;
      } catch (e) {
        // the whole error (dep-4's was cut and could not be read)
        state.deposits[c.deposit.id].result = `error: ${redactKeys(String((e as Error)?.message ?? e)).slice(0, 1500)}`;
      }
      save();
    }
    if (now - marketsAt > 10 * 60_000 || !markets.length) {
      markets = await d.markets();
      marketsAt = now;
    }
    const mk = (coin: string) => markets.find((m) => m.symbol === coin);
    const accts = await d.accounts(w);
    const free = Number(accts.find((a) => a.pubkey === state.account!.cross)?.data?.freeBalance ?? 0);
    // what a coin's isolated account still holds (a closed position's collateral and result stay there until used again)
    const isoFree = (coin: string) => Number(accts.find((a) => a.isolated && a.market === coin)?.data?.freeBalance ?? 0);

    // the dry run: a resting bid at half the price, then every order of that market cancelled (nothing can fill)
    if (c.dryRun && state.dry?.id !== c.dryRun) {
      const m = mk("HYPE") ?? markets.find((x) => !["SOL", "BTC", "ETH"].includes(x.symbol));
      state.dry = { id: c.dryRun, at: now, result: "sending" };
      save();
      if (!m) state.dry.result = "no market";
      else if (free < 1) state.dry.result = "no money on Gum yet (cross free balance under $1)";
      else {
        try {
          const px = priceOf(m) / 2;
          const step = m.stepSize ?? m.baseLotSize / 10 ** m.baseDecimals;
          const qty = Math.ceil((minUsd(m) * 1.2) / px / step) * step;
          const o: GumPlace = { subaccountId: state.account.sub, symbol: m.symbol, side: "Bid", orderType: "postOnly", price: px, quantity: qty, reduceOnly: false, timeInForce: "GoodTilCanceled", clientOrderId: clientIdOf(now), isIsolated: false };
          await d.place(w, signedPlace(w, m, o, state.account.cross, await d.blockhash()));
          await d.cancelAll(w, signedCancelAll(w, { subaccountId: state.account.sub, symbol: m.symbol, isIsolated: false }, state.account.cross, await d.blockhash()));
          state.dry.result = `ok: ${m.symbol} order accepted and cancelled`;
        } catch (e) {
          state.dry.result = `error: ${d.fixed(e)}`;
        }
      }
      save();
    }

    // the positions there now, and the closes and results of ours
    const held = c.on || state.opens.length ? await d.positions(state.account.cross) : [];
    const heldOn = (coin: string) => held.find((x) => x.symbol === coin && x.isolated !== false && Number(x.size) > 0);
    const paper = d.paperOpens(markets.map((m) => m.symbol));
    for (const p of [...state.opens]) {
      const m = mk(p.coin);
      const h = heldOn(p.coin);
      if (p.stage === "opening") {
        if (h) {
          p.stage = "open";
          p.openedMs = now;
          p.qty = Number(h.size);
        } else if (now - p.sentMs > FILL_MS) book(d, p, 0, false);
        continue;
      }
      if ((p.stage === "open" || p.stage === "closing") && !h) {
        p.stage = "booking";
        p.goneMs = now;
      }
      if (p.stage === "booking") {
        const closed = (await d.history(state.account.cross, p.coin)).filter((x) => x.isolated !== false && x.closedAt * 1000 >= (p.openedMs ?? p.sentMs) - 120_000);
        if (closed.length) {
          book(d, p, closed.reduce((a, x) => a + Number(x.netPnl), 0), true, closed[0].closeReason);
          if (!state.opens.some((x) => x.stage === "booking" && now - (x.goneMs ?? now) > UNREAD_MS)) state.unread = "";
        } else if (now - (p.goneMs ?? now) > UNREAD_MS) state.unread = "a closed position is not in Gum's history yet: its result is unknown, so nothing new is opened";
        continue;
      }
      // open: closed when the trader's position is gone, after MAX_HOLD_H, or (the test) at the next look
      const due = p.rule === TEST_RULE || !paper.some((x) => x.id === p.paperId) || now - (p.openedMs ?? now) > MAX_HOLD_H * 3_600_000;
      if (m && h && due && (p.stage === "open" || now - p.sentMs > RETRY_MS)) {
        try {
          await sendClose(d, w, m, p, Number(h.size));
        } catch (e) {
          state.lastError = d.fixed(e);
        }
      }
    }
    save();
    if (!c.on || stopped()) return;

    // the test: one small position, once per name
    const tryOpen = async (rule: string, paperId: string, coin: string, dir: number, traderLev: number | undefined, coll: number) => {
      const m = mk(coin);
      if (!m) return skip("not a market on Gum");
      if (["SOL", "BTC", "ETH"].includes(coin)) return skip("SOL, BTC and ETH go to the pool");
      if (state.opens.some((x) => x.coin === coin) || heldOn(coin)) return skip("one position per coin");
      if (state.opens.length >= c.maxOpen) return skip("positions at the limit");
      if (loss() + coll > c.maxLossUsd + 1e-9) return skip("no room under the loss cap");
      const move = Math.max(0, r2(coll - isoFree(coin)));
      if (free < move) return skip("not enough money on Gum");
      const lev = leverageFor(traderLev, 2, m.maxLeverage ?? null);
      const qty = qtyFor(m, coll, lev);
      if (!(qty > 0) || qty * priceOf(m) < minUsd(m)) return skip("under the market's minimum order");
      const p: Pos = { rule, coin, paperId, dir, lev, collUsd: coll, qty, stage: "opening", sentMs: now, closeTries: 0, clientId: String(clientIdOf(now + state.rows.length)), moveUsd: move };
      state.opens.push(p);
      state.seen = [...state.seen, paperId].slice(-2000);
      save();
      try {
        await sendOpen(d, w, m, p);
      } catch (e) {
        state.lastError = d.fixed(e);
        state.opens = state.opens.filter((x) => x !== p);
      }
      save();
    };
    if (c.test && state.test?.id !== c.test.id && !state.opens.length) {
      state.test = { id: c.test.id, at: now };
      save();
      await tryOpen(TEST_RULE, `test:${c.test.id}`, c.test.coin, c.test.side === "long" ? 1 : -1, 1.2, MIN_COLLATERAL_USD);
      return;
    }
    for (const o of paper) {
      if (state.seen.includes(o.id)) continue;
      if (now - o.at > OPEN_WINDOW_MS) {
        state.seen = [...state.seen, o.id].slice(-2000);
        skip("paper position too old");
        continue;
      }
      if (!(d.isReal ? d.isReal(o.rule, now) : gumStanding(o.rule, now).real)) continue;
      await tryOpen(o.rule, o.id, o.coin, o.dir, o.lev, c.collateralUsd);
    }
    save();
  } catch (e) {
    state.lastError = d.fixed(e);
    save();
  } finally {
    busy = false;
  }
}

export function gumLiveSummary() {
  if (!loaded) load();
  const c = fileCfg();
  const done = state.rows.filter((x) => x.filled && x.rule !== TEST_RULE);
  return {
    note: "REAL on Jupiter's order book (Gum): the coins the pool does not have. Off unless the live rules switch it on.",
    on: c.on && !stopped(),
    halted: stopped(),
    account: !!state.account,
    created: state.created?.result ?? null,
    deposits: Object.fromEntries(Object.entries(state.deposits ?? {}).map(([k, v]) => [k, v.result])),
    depositLayout: state.depositLayout ?? null,
    dryRun: state.dry ? { id: state.dry.id, result: state.dry.result } : null,
    test: state.test ? { id: state.test.id, result: state.test.result ?? null } : null,
    collateralUsd: c.collateralUsd,
    maxLossUsd: c.maxLossUsd,
    ruleStopUsd: c.ruleStopUsd,
    netUsd: state.netUsd,
    trades: done.length,
    won: done.filter((x) => x.netUsd > 0).length,
    open: state.opens.length,
    rows: state.rows.slice(-40).reverse().map((x) => ({ rule: x.rule, coin: x.coin, side: x.side, filled: x.filled, netUsd: x.netUsd, how: x.how ?? null })),
    skipped: state.skipped,
    lastError: state.lastError,
  };
}

function fileCfg(): GumConfig {
  if (process.env.SOLANA_LIVE === "off") return OFF;
  try {
    return parseGum(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8"));
  } catch {
    return OFF;
  }
}
let timer: ReturnType<typeof setInterval> | null = null;
export function startGumLive() {
  if (timer || process.env.SOLANA_LIVE === "off") return;
  const fixed = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 160);
  const d: GumDeps = {
    cfg: fileCfg,
    wallet: () => namedWallet("perps"),
    markets: () => gum<GumMarket[]>("/markets"),
    accounts: async (w) => (await gum<{ accounts?: GumAccount[] }>("/tradingAccount", { pubkey: w.address })).accounts ?? [],
    createAccount: async (w) => void (await gum("/tradingAccount", { method: "POST", pubkey: w.address })),
    positions: (cross) => gum<GumPosition[]>(`/tradingAccount/${cross}/positions`),
    history: async (cross, symbol) => (await gum<{ entries?: GumClosed[] }>(`/tradingAccount/${cross}/positionHistory?symbol=${encodeURIComponent(symbol)}&limit=20`)).entries ?? [],
    blockhash: async () => (await gum<{ blockhash: string }>("/blockhash")).blockhash,
    place: (w, body) => gum("/order/create", { method: "POST", pubkey: w.address, body }),
    cancelAll: (w, body) => gum("/order/cancel-all", { method: "POST", pubkey: w.address, body }),
    deposit: async (w, cross, usd, seen) => {
      const b = await gum<{ serializedTransaction: string }>(`/deposit?amount=${Math.round(usd * 1e6)}&trading_account=${cross}`, { pubkey: w.address });
      seen({ ...txLayout(b.serializedTransaction, w), roles: txRoles(b.serializedTransaction, w, { [cross]: "ourCrossAccount" }) });
      try {
        const r = await gum<{ signature: string }>("/deposit", { method: "POST", pubkey: w.address, body: { serializedTransaction: signApiTx(b.serializedTransaction, w) } });
        return r.signature;
      } catch (e) {
        // read-only: what the trading account holds, to tell an empty source from a wrong target
        const bal = await gum<unknown>(`/tradingAccount/${cross}/balances`).then((x) => JSON.stringify(x).slice(0, 300), (x) => `balances error: ${String((x as Error).message).slice(0, 200)}`);
        throw new Error(redactKeys(`${String((e as Error).message)} | cross balances: ${bal}`));
      }
    },
    paperOpens: perpPaperOpensOn,
    fixed,
  };
  timer = setInterval(() => void gumLiveTick(d), 30_000);
  timer.unref();
}
export const _test = { reset: () => ((state = fresh()), (loaded = true), (markets = []), (marketsAt = 0)), state: () => state };
