/**
 * REAL MONEY. The fast pair bot on BTC 5m, the real twin of the paper rule `pairfast-top-lock-5m` (src/pairfast.ts).
 * enrique, 11 Nov 2026 08:03 KST: "do real money with the fast btc5min. can lose up to 15usd".
 *
 * The rule: one post-only bid of `clip` shares a side, on Up and on Down, placed at the best bid and then LEFT RESTING
 * (queue place kept) until it is `slack` cents behind the best bid. When one side fills, that side stops and the other
 * bid may never be above 99c minus the price paid: a finished pair always costs under $1 and one of the two pays $1.
 * We never take, and a pair is never completed above 99c. A clip left without its pair is held to settlement.
 * No new first leg in the last 2 minutes; everything is cancelled 15 s before the close.
 *
 * What is fast: the decision is re-made on every change of the book and on every trade print at our price (not once a
 * second), and an order is only touched when the decision changes, so it keeps its place in the queue.
 *
 * Guards (deploy/live-rules.json "pairfast", read fresh on every decision):
 *  - off unless that block has "on": true, the repo mode is "live" and the server's own live.json does not say off;
 *    it also stays off while the old "pairs" test is on for BTC 5m (two bots must not cancel each other's orders);
 *  - HARD budget `maxLoss` (never above $15 in code): before every new first leg, settled losses + the worst case of
 *    every open window + the worst case of the bids resting and the bid about to be placed must be at or under it.
 *    The worst case of a resting bid is that it fills and its pair never comes, so the budget cannot be overshot;
 *  - at most $5 an order (17-83c at 6 shares), `maxPairs` pairs a window, never more than one clip unpaired;
 *  - the wallet floor `minBalance`; 20 API errors in a KST day stop it for the day; every error pauses 20 s (nothing
 *    new is placed; resting bids stay);
 *  - when the budget or wallet guard trips, bids that would start a new pair are cancelled; a bid that completes a pair
 *    already begun is kept (it can only lower the risk). Switched off, restarting or 20 errors: everything is cancelled;
 *  - orders are kept in data/pairfastlive.json and read back from the exchange after a restart.
 * Fills are read from the exchange (size_matched of our own orders), never guessed. Winning shares are claimed through
 * the BTC 5m claim queue (live.ts). No ids, keys or addresses leave this file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AssetType, OrderType, Side, type ClobClient } from "@polymarket/clob-client-v2";
import { ROOT, SERIES, kstDay } from "./config.js";
import { getClient } from "./eventlive.js";
import { bookFeed, type TradePrint } from "./feeds/book.js";
import { queueRedeem } from "./live.js";
import { resolution, type Book } from "./polymarket.js";
import { currentMarket } from "./recorder.js";
import { loadJson, saveJson } from "./store.js";

const FILE = "pairfastlive.json";
const NAME = "btc5m";
const S = SERIES[0]; // BTC 5m
export const LO = 0.17;
export const HI = 0.83; // 6 shares at 83c is $4.98: the $5 an order limit
export const HARD_MAX_LOSS = 15; // enrique's word covers $15, no more
const STOP = 120; // no new first leg in the last 2 minutes
const FROM = 10;
const EPS = 1e-9;

export type FastConfig = { on: boolean; clip: number; maxLoss: number; maxPairs: number; slack: number; minBalance: number };
type Sd = "U" | "D";
type Ord = { id: string; price: number; size: number; matched: number; at: number };
type Leg = { shares: number; cost: number; last: number };
export type Win = { start: number; up: Leg; down: Leg; orders: { U: Ord | null; D: Ord | null }; orderCount: number };
type Done = { start: number; up: number; down: number; cost: number; net: number; at: number };
type State = { cur: Win | null; pending: Win[]; done: Done[]; errDay: string; errs: number; note: string | null; rejects: number };
export type Want = { price: number; size: number };

const num = (x: unknown, d: number) => (x != null && Number.isFinite(Number(x)) ? Number(x) : d);
const r2 = (x: number) => Math.round(x * 100) / 100;
const OFF: FastConfig = { on: false, clip: 6, maxLoss: 0, maxPairs: 0, slack: 3, minBalance: 0 };

/** Parse the repo rules and the server's local switch. Anything malformed means off. Hard limits are applied here. */
export function parseFast(repoText: string, local: { mode?: string; funder?: string }): FastConfig {
  try {
    const repo = JSON.parse(repoText) as { mode?: string; minBalance?: unknown; pairs?: { on?: unknown; series?: unknown }; pairfast?: { on?: unknown; series?: unknown; clip?: unknown; maxLoss?: unknown; maxPairs?: unknown; slack?: unknown } };
    const p = repo?.pairfast;
    if (!p || p.on !== true || repo.mode !== "live" || local.mode === "off" || !String(local.funder ?? "").trim()) return OFF;
    if (!Array.isArray(p.series) || p.series.length !== 1 || p.series[0] !== NAME) return OFF; // BTC 5m only
    if (repo.pairs?.on === true && Array.isArray(repo.pairs.series) && repo.pairs.series.includes(NAME)) return OFF;
    const maxLoss = Math.min(HARD_MAX_LOSS, Math.max(0, num(p.maxLoss, 0)));
    if (!(maxLoss > 0)) return OFF;
    return { on: true, clip: Math.min(6, Math.max(5, num(p.clip, 6))), maxLoss, maxPairs: Math.min(3, Math.max(1, Math.floor(num(p.maxPairs, 1)))), slack: Math.min(6, Math.max(1, Math.floor(num(p.slack, 3)))), minBalance: Math.max(0, num(repo.minBalance, 0)) };
  } catch {
    return OFF;
  }
}
let cfgAt = 0;
let cfgCache: FastConfig = OFF;
/** The config, re-read from disk at most once a second (decisions run on every book change). */
export function fastConfig(): FastConfig {
  if (Date.now() - cfgAt < 1000) return cfgCache;
  cfgAt = Date.now();
  return (cfgCache = readConfig());
}
function readConfig(): FastConfig {
  let text = "";
  try {
    text = readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8");
  } catch {
    /* off */
  }
  return parseFast(text, loadJson<{ mode?: string; funder?: string }>("live.json", {}));
}

export const newWin = (start: number): Win => ({ start, up: { shares: 0, cost: 0, last: 0 }, down: { shares: 0, cost: 0, last: 0 }, orders: { U: null, D: null }, orderCount: 0 });
const leg = (w: Win, side: Sd) => (side === "U" ? w.up : w.down);

/** The most a window can still lose with what it holds: what was paid minus the $1 a share the finished pairs are sure to pay. */
export const worstCase = (w: { up: { shares: number; cost: number }; down: { shares: number; cost: number } }) => Math.max(0, w.up.cost + w.down.cost - Math.min(w.up.shares, w.down.shares));

/**
 * The most a window can lose counting its resting bids too: every combination of "this bid fills in full / not at all"
 * is tried and the worst is taken (a bid that fills and never gets its pair loses everything paid for it).
 */
export function exposure(w: Win, bids: { U: Want | null; D: Want | null }): number {
  let worst = 0;
  for (const u of [0, 1]) {
    for (const d of [0, 1]) {
      const up = { shares: w.up.shares + (u && bids.U ? bids.U.size : 0), cost: w.up.cost + (u && bids.U ? bids.U.size * bids.U.price : 0) };
      const down = { shares: w.down.shares + (d && bids.D ? bids.D.size : 0), cost: w.down.cost + (d && bids.D ? bids.D.size * bids.D.price : 0) };
      worst = Math.max(worst, worstCase({ up, down }));
    }
  }
  return worst;
}

/** Settled result so far: dollars lost (0 when ahead). */
export const lostSoFar = (done: { net: number }[]) => Math.max(0, -done.reduce((a, d) => a + d.net, 0));

/**
 * What should rest on each side right now. Pure. `now` in seconds.
 *  - `ok`: the outside guards for starting a new pair pass (balance, errors, pause);
 *  - `room`: dollars of budget left for THIS window: maxLoss - settled losses - worst case of the other open windows.
 * A resting bid within `slack` cents under the price we would bid now is kept as it is (same price back = no action).
 */
export function desired(w: Win, up: Book | null, down: Book | null, now: number, cfg: FastConfig, ok: boolean, room: number): { U: Want | null; D: Want | null } {
  const out: { U: Want | null; D: Want | null } = { U: null, D: null };
  const left = w.start + S.windowSec - now;
  if (!cfg.on || !up || !down || up.bestBid == null || down.bestBid == null || left <= 15 || w.orderCount >= 80) return out;
  const keep = (side: Sd, price: number, size: number): Want => {
    const o = w.orders[side];
    // Leave a resting bid alone while it is at or under the price wanted now and not more than `slack` cents behind.
    if (o && o.price <= price + EPS && o.price >= price - cfg.slack / 100 - EPS && o.size - o.matched <= size + 0.01) return { price: o.price, size: r2(o.size - o.matched) };
    return { price, size };
  };
  const un = w.up.shares - w.down.shares;
  if (Math.abs(un) >= 5) {
    // One side is waiting for its pair: bid only the other, never above 99c minus what the waiting side cost.
    const heavy = un > 0 ? w.up : w.down;
    const side: Sd = un > 0 ? "D" : "U";
    const b = side === "U" ? up : down;
    const cap = Math.floor((0.99 - heavy.last) * 100 + 1e-6) / 100;
    const price = r2(Math.min(b.bestBid!, cap));
    if (!(heavy.last > 0) || !(price >= 0.01)) return out;
    const size = Math.min(Math.floor(Math.abs(un) * 100) / 100, Math.floor((5 / price) * 100) / 100);
    if (size < 5) return out;
    out[side] = keep(side, price, size);
    return out;
  }
  const paired = Math.min(w.up.shares, w.down.shares);
  const band = (x: number) => x >= LO - EPS && x <= HI + EPS;
  const start = ok && now - w.start >= FROM && left >= STOP && paired < cfg.maxPairs * cfg.clip - 0.01 && up.bestBid + down.bestBid <= 0.99 + EPS && band(up.bestBid) && band(down.bestBid);
  // A bid that is part filled keeps resting for the rest of its clip, whatever else is decided: cancelling it leaves a
  // few shares that can never be paired (under the 5-share order minimum). First real hour, 11 Nov 2026: 3.63 Up
  // filled, the rest was cancelled, Down filled 6, a second Up clip filled: 9.63 Up against 6 Down, -$2.30.
  const part = (side: Sd): Want | null => {
    const o = w.orders[side];
    return o && o.matched > 0.01 && o.size - o.matched >= 0.01 ? { price: o.price, size: r2(o.size - o.matched) } : null;
  };
  out.U = part("U");
  out.D = part("D");
  if (!start) return out;
  // Never a NEW bid on the side that is ahead by a few shares; the other side gets a full clip.
  let U = out.U ?? (un > 0.01 ? null : keep("U", up.bestBid, cfg.clip));
  let D = out.D ?? (un < -0.01 ? null : keep("D", down.bestBid, cfg.clip));
  if (U && D && U.price + D.price > 0.99 + EPS) {
    // Two resting bids may never add to more than 99c: drop to fresh best bids (they add to 99c or less, checked above).
    if (out.U || out.D) return out; // one of them is part filled: leave it, start nothing new
    U = { price: up.bestBid, size: cfg.clip };
    D = { price: down.bestBid, size: cfg.clip };
  }
  // The hard budget: with these bids resting, the window's worst case must fit in the room that is left. A bid that is
  // already resting is cancelled by the caller when it no longer fits.
  if (exposure(w, { U, D }) > room + EPS) return out; // no first legs at all; the caller cancels what is resting
  out.U = U;
  out.D = D;
  return out;
}

const state: State = { cur: null, pending: [], done: [], errDay: "", errs: 0, note: null, rejects: 0, ...loadJson<Partial<State>>(FILE, {}) };
const save = () => saveJson(FILE, state);
const scrub = (s: string) => s.replace(/0x[0-9a-fA-F]{16,}/g, "0x…").replace(/\d{30,}/g, "…").slice(0, 160);
let balance: number | null = null;
let balanceAt = 0;
let quiet = false;
let pauseUntil = 0;
let blocked: string | null = null;

/** Read one of our orders from the exchange and book any new fill. Returns true when the order is finished. */
async function sync(c: ClobClient, w: Win, side: Sd): Promise<boolean> {
  const o = w.orders[side];
  if (!o) return true;
  const got = await c.getOrder(o.id);
  const matched = Number(got?.size_matched) || 0;
  if (matched > o.matched + 1e-9) {
    const d = matched - o.matched;
    const l = leg(w, side);
    l.shares = Math.round((l.shares + d) * 1e6) / 1e6;
    l.cost = Math.round((l.cost + d * o.price) * 1e6) / 1e6;
    l.last = o.price;
    o.matched = matched;
    console.log(`pairfast ${NAME}: filled ${d.toFixed(2)} ${side === "U" ? "Up" : "Down"} at ${Math.round(o.price * 100)}c after ${Math.round((Date.now() - o.at) / 1000)} s resting (holds ${w.up.shares.toFixed(2)} Up / ${w.down.shares.toFixed(2)} Down)`);
  }
  const dead = /MATCHED|CANCEL/i.test(String(got?.status ?? "")) || matched >= o.size - 0.01;
  if (dead) w.orders[side] = null;
  save();
  return dead;
}

/** Cancel one resting order and read its final fill. Returns the shares it filled since the last look. */
async function cancel(c: ClobClient, w: Win, side: Sd): Promise<number> {
  const o = w.orders[side];
  if (!o) return 0;
  const before = leg(w, side).shares;
  await c.cancelOrder({ orderID: o.id });
  await sync(c, w, side); // if the exchange still lists it as live it stays in w.orders and is read again next time
  return leg(w, side).shares - before;
}

async function place(c: ClobClient, w: Win, side: Sd, token: string, want: Want) {
  if (want.price * want.size > 5 + EPS) return; // never over $5 an order, whatever the caller asked
  w.orderCount += 1;
  const order = await c.createOrder({ tokenID: token, price: want.price, side: Side.BUY, size: want.size }, { tickSize: "0.01", negRisk: false });
  let res: { success?: boolean; orderID?: string; errorMsg?: string } | null = null;
  let threw: string | null = null;
  try {
    res = await c.postOrder(order, OrderType.GTC, true); // post-only: rejected if it would take
  } catch (e) {
    threw = scrub((e as Error).message ?? String(e));
  }
  if (!res?.success || !res.orderID) {
    state.rejects += 1;
    state.note = `order not accepted: ${threw ?? scrub(String(res?.errorMsg ?? "no reason given"))}`;
    // No clean answer: the order may exist without us knowing its id. Cancel everything of ours on this token.
    if (threw || !res?.errorMsg) await c.cancelMarketOrders({ asset_id: token }).catch(() => undefined);
    pauseUntil = Date.now() + (threw || !res?.errorMsg ? 5000 : 1000);
    save();
    return;
  }
  w.orders[side] = { id: res.orderID, price: want.price, size: want.size, matched: 0, at: Date.now() };
  save();
}

async function killAll(c: ClobClient, w: Win) {
  for (const side of ["U", "D"] as const) if (w.orders[side]) await cancel(c, w, side);
}

export const LOCKED_ALLOWANCE = 30;
/** Dollars sure to come back from finished pairs not yet claimed (claims run every 30 min). */
function lockedInPairs(now: number): number {
  let total = 0;
  for (const w of [...(state.cur ? [state.cur] : []), ...state.pending]) total += Math.min(w.up.shares, w.down.shares);
  for (const d of state.done) if (now - d.at < 45 * 60_000) total += Math.min(d.up, d.down);
  return total;
}

/** Budget left for the current window: maxLoss minus settled losses minus the worst case of the windows not settled yet. */
function roomNow(cfg: FastConfig): number {
  return cfg.maxLoss - lostSoFar(state.done) - state.pending.reduce((a, w) => a + worstCase(w), 0);
}

function guard(cfg: FastConfig, now: number): string | null {
  if (!cfg.on) return "switched off";
  if (quiet) return "restarting";
  const today = kstDay(now);
  if (state.errDay === today && state.errs >= 20) return "20 API errors today";
  const room = roomNow(cfg) - (state.cur ? worstCase(state.cur) : 0);
  if (room < cfg.clip * LO) return `budget used: $${r2(cfg.maxLoss - room)} of $${cfg.maxLoss} lost or at risk`;
  if (balance == null) return "balance not read yet";
  const locked = lockedInPairs(now);
  if (balance + Math.min(LOCKED_ALLOWANCE, locked) - cfg.minBalance < 2 * 5) return `wallet $${balance.toFixed(2)} (+$${locked.toFixed(2)} in finished pairs) is at the $${cfg.minBalance} floor`;
  return null;
}

/**
 * The short pause after a refused order or an API error: nothing new is placed and nothing is cancelled (a part-filled
 * bid pulled here would leave shares that can never be paired); what rests stays as it is until 15 s before the close.
 */
export function paused(w: Win, now: number): { U: Want | null; D: Want | null } {
  const rest = (o: Ord | null): Want | null => (o && w.start + S.windowSec - now > 15 ? { price: o.price, size: r2(o.size - o.matched) } : null);
  return { U: rest(w.orders.U), D: rest(w.orders.D) };
}

/** The decision from what we know right now, without asking the exchange. */
function decide(cfg: FastConfig, nowMs: number): { w: Win; want: { U: Want | null; D: Want | null }; live: { upToken: string; downToken: string } | null } | null {
  const w = state.cur;
  const now = Math.floor(nowMs / 1000);
  if (!w || w.start !== Math.floor(now / S.windowSec) * S.windowSec) return null;
  const m = currentMarket(S.key);
  const live = m && m.start === w.start ? m : null;
  const up = live ? bookFeed.fresh(live.upToken) : null;
  const down = live ? bookFeed.fresh(live.downToken) : null;
  blocked = guard(cfg, nowMs);
  // Off, restarting, too many errors or the pause after an error: nothing rests. Budget or wallet: no NEW pair, but a
  // pair already begun may still be completed (that only lowers the risk).
  const hard = !cfg.on || quiet || /errors/.test(blocked ?? "");
  const want = hard ? { U: null, D: null } : nowMs < pauseUntil ? paused(w, now) : desired(w, up, down, now, cfg, blocked == null, roomNow(cfg));
  return { w, want, live };
}

const differs = (o: Ord | null, d: Want | null) => (o ? !d || Math.abs(o.price - d.price) > 1e-9 || o.size - o.matched > d.size + 0.01 : !!d);

async function step(c: ClobClient, cfg: FastConfig) {
  const nowMs = Date.now();
  const start = Math.floor(nowMs / 1000 / S.windowSec) * S.windowSec;
  let w = state.cur;
  if (w && w.start !== start) {
    // The window is over: its orders died with the market, but cancel and read them once more to be sure of the fills.
    try {
      await killAll(c, w);
    } catch {
      if (nowMs / 1000 - (w.start + S.windowSec) < 60) return; // try again, for up to a minute
      w.orders = { U: null, D: null };
    }
    if (w.up.shares > 0 || w.down.shares > 0) state.pending.push(w);
    state.cur = w = null;
    save();
  }
  if (!w) {
    if (!cfg.on || quiet) return;
    w = state.cur = newWin(start);
  }
  for (const side of ["U", "D"] as const) if (w.orders[side]) await sync(c, w, side);
  const d = decide(cfg, Date.now());
  if (!d) return;
  for (const side of ["U", "D"] as const) {
    const o = w.orders[side];
    const want = d.want[side];
    if (o && differs(o, want)) {
      const filled = await cancel(c, w, side);
      if (filled > 1e-6 || w.orders[side]) return; // something filled, or not yet confirmed dead: decide again
    }
    if (!w.orders[side] && want && d.live) {
      // The fills just read may have changed the picture: place only what a fresh decision still wants.
      const again = decide(cfg, Date.now())?.want[side];
      if (!again || Math.abs(again.price - want.price) > 1e-9 || again.size !== want.size) return;
      await place(c, w, side, side === "U" ? d.live.upToken : d.live.downToken, want);
    }
  }
}

async function settle() {
  const now = Math.floor(Date.now() / 1000);
  for (const w of [...state.pending]) {
    if (now < w.start + S.windowSec + 90) continue;
    const r = await resolution(w.start, S.slug, S.slugStyle).catch(() => null);
    if (!r || r.resolvedUp == null) continue;
    const win = r.resolvedUp ? w.up.shares : w.down.shares;
    const cost = w.up.cost + w.down.cost;
    state.done.push({ start: w.start, up: r2(w.up.shares), down: r2(w.down.shares), cost: r2(cost), net: r2(win - cost), at: Date.now() });
    if (state.done.length > 5000) state.done.splice(0, state.done.length - 5000); // far more windows than $15 can buy
    state.pending = state.pending.filter((x) => x !== w);
    if (win > 0.01) queueRedeem(S.key, w.start, win);
    console.log(`pairfast ${NAME}: window settled ${r.resolvedUp ? "Up" : "Down"}, ${w.up.shares.toFixed(2)} Up / ${w.down.shares.toFixed(2)} Down for $${cost.toFixed(2)}, net ${win - cost >= 0 ? "+" : "-"}$${Math.abs(win - cost).toFixed(2)}`);
    save();
  }
}

/** For the status page and file: numbers only. */
export function pairfastliveSummary() {
  const cfg = fastConfig();
  const today = kstDay();
  const budget = cfg.maxLoss || HARD_MAX_LOSS;
  const lost = r2(lostSoFar(state.done));
  const open = r2([...(state.cur ? [state.cur] : []), ...state.pending].reduce((a, w) => a + worstCase(w), 0));
  const day = state.done.filter((d) => kstDay(d.at) === today);
  const lone = state.done.filter((d) => Math.abs(d.up - d.down) >= 1);
  return {
    rule: "BTC 5m. One small buy order (6 shares) rests on Up and one on Down at the best bid and is left there to keep its place in the queue. When one fills, the other may cost at most 99c minus the first, so a finished pair costs under $1 and one side always pays $1. Bids are never raised and we never buy at the ask. A clip that never gets its pair is held to the result.",
    paperTwin: "pairfast-top-lock-5m",
    on: cfg.on,
    series: [NAME],
    clip: cfg.clip,
    budget: { name: "pairfast", budget, lost, open, left: r2(budget - lost - open) },
    windows: state.done.length,
    won: state.done.filter((d) => d.net > 0).length,
    net: r2(state.done.reduce((a, d) => a + d.net, 0)),
    todayWindows: day.length,
    todayNet: r2(day.reduce((a, d) => a + d.net, 0)),
    pairedShares: r2(state.done.reduce((a, d) => a + Math.min(d.up, d.down), 0)),
    loneWindows: lone.length,
    loneNet: r2(lone.reduce((a, d) => a + d.net, 0)),
    unsettled: state.pending.length,
    blocked,
    errorsToday: state.errDay === today ? state.errs : 0,
    rejects: state.rejects,
    note: state.note,
    now: state.cur ? { start: state.cur.start, up: r2(state.cur.up.shares), down: r2(state.cur.down.shares), cost: r2(state.cur.up.cost + state.cur.down.cost), bidUp: state.cur.orders.U?.price ?? null, bidDown: state.cur.orders.D?.price ?? null, orders: state.cur.orderCount } : null,
    // Windows that have closed and wait for their result (11 Nov 2026: shown on the dashboard so a trade does not vanish between open and settled).
    pending: state.pending.map((w) => ({ series: NAME, start: w.start, up: r2(w.up.shares), down: r2(w.down.shares), cost: r2(w.up.cost + w.down.cost) })),
    recent: state.done.slice(-12).map((d) => ({ series: NAME, start: d.start, up: d.up, down: d.down, cost: d.cost, net: d.net })),
  };
}

/** Stop quoting and cancel (the bot is about to restart). */
export function pairfastliveQuiet() {
  quiet = true;
  kick();
}

let busy = false;
let again = false;
let kick: () => void = () => undefined;

export function startPairfastlive() {
  if (process.env.PAIRFASTLIVE === "off") return null;
  let n = 0;
  const run = async () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        const cfg = fastConfig();
        if (!cfg.on && !state.cur && !state.pending.length) return;
        const funder = String(loadJson<{ funder?: string }>("live.json", {}).funder ?? "").trim();
        if (!funder) return;
        const c = await getClient(funder);
        if (Date.now() - balanceAt > 60_000) {
          balanceAt = Date.now();
          const b = await c.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }).catch(() => null);
          if (b && Number.isFinite(Number(b.balance))) balance = Number(b.balance) / 1e6;
        }
        try {
          await step(c, cfg);
        } catch (e) {
          const today = kstDay();
          if (state.errDay !== today) {
            state.errDay = today;
            state.errs = 0;
          }
          state.errs += 1;
          state.note = `error: ${scrub((e as Error).message ?? String(e))}`;
          pauseUntil = Date.now() + 20_000;
          console.log(`pairfast ${NAME}: ${state.note}; pausing 20 s`);
          save();
        }
        if (again) await new Promise((r) => setTimeout(r, 100)); // a breath between back-to-back steps
      } while (again);
    } catch (e) {
      state.note = `error: ${scrub((e as Error).message ?? String(e))}`;
    } finally {
      busy = false;
    }
  };
  kick = () => void run();
  // The fast part: any change of our market's book that changes the decision, or a print that may have filled us,
  // runs a step at once instead of waiting for the timer.
  const mine = (tokenId: string) => {
    const m = currentMarket(S.key);
    return !!m && !!state.cur && m.start === state.cur.start && (tokenId === m.upToken || tokenId === m.downToken);
  };
  bookFeed.onUpdate((tokenId) => {
    try {
      if (!mine(tokenId) || busy) return;
      const d = decide(fastConfig(), Date.now());
      if (d && (differs(d.w.orders.U, d.want.U) || differs(d.w.orders.D, d.want.D))) void run();
    } catch {
      /* the timer will get to it */
    }
  });
  bookFeed.onTrade((p: TradePrint) => {
    try {
      if (!mine(p.tokenId)) return;
      const m = currentMarket(S.key)!;
      // A print that can have reached one of our bids (a sell of that token at or under our price, or a buy of the
      // other token at or over 1 - our price): read our orders now.
      const hit = (["U", "D"] as const).some((side) => {
        const o = state.cur!.orders[side];
        if (!o) return false;
        const own = (side === "U") === (p.tokenId === m.upToken);
        return own ? p.side === "SELL" && p.price <= o.price + EPS : p.side === "BUY" && p.price >= 1 - o.price - EPS;
      });
      if (hit) void run();
    } catch {
      /* the timer will get to it */
    }
  });
  return setInterval(() => {
    void run();
    if (++n % 20 === 0) settle().catch(() => undefined);
  }, 1000);
}
