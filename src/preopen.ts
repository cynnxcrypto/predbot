/**
 * PAPER ONLY. `preopen-both49` (10 Nov 2026, venue-mechanics research, /mnt/project-files/reviews/venue-mechanics-2026-11-10.md P2).
 *
 * Before a 15-minute window opens nobody can know its result: the strike is the price at the open, which has not
 * happened yet. So a bid filled before the open cannot be picked off by someone who already knows the answer. The rule:
 * from 10 minutes before the NEXT window opens until 60 seconds before, rest a 49c bid on Up and a 49c bid on Down
 * ($5 each) on BTC, ETH and SOL 15m; cancel both at 60 s before the open; hold any fill to settlement.
 *
 * Fills are counted honestly, on recorded trades only: when the bid is placed we note how many shares already rest at
 * 49c (the queue ahead of us); a fill needs a trade print where the taker SOLD at 49c or lower (or any print under 49c),
 * and only the shares left after the queue ahead has traded are ours. A taker BUY of the other outcome at 51c or
 * higher is the same trade seen from the other token and counts the same way. Orders ahead that cancel are not credited, so this
 * undercounts a little. Bar: 100 fills, 51.5%+ won.
 *
 * It also records the pre-open book (spread and size) every 30 s to data/<series>-preopen/<day>.jsonl, fill or not.
 * Nothing here places an order.
 */
import { SERIES, type Series } from "./config.js";
import { bookFeed, type TradePrint } from "./feeds/book.js";
import { marketFor, resolution, type Market } from "./polymarket.js";
import { watchExtra } from "./recorder.js";
import { append, loadJson, saveJson } from "./store.js";

export const PREOPEN_BID = 0.49;
export const PREOPEN_USD = 5;
const KEYS = ["btc15m", "eth15m", "sol15m"];
const FROM = 600;
const TO = 60;
const FILE = "preopen.json";

export type Side = { ahead: number | null; shares: number; at: number | null };
export type PreopenTrade = { series: string; start: number; side: "UP" | "DOWN"; shares: number; cost: number; at: number; secBefore: number; won?: boolean; net?: number };
type State = { windows: number; noQueue: number; trades: PreopenTrade[] };
type Slot = { start: number; market: Market | null; triedAt: number; up: Side | null; down: Side | null; done: boolean; snapAt: number; counted: boolean };

/** A fresh resting bid: `ahead` = shares already resting at our price (null when our price is deeper than the levels we can see). */
export function placeBid(bids: { price: number; size: number }[], bestAsk: number | null, price = PREOPEN_BID): Side | null {
  if (bestAsk != null && bestAsk <= price) return null; // we would be taking, not resting: no bid
  const level = bids.find((l) => Math.abs(l.price - price) < 1e-9);
  const lowest = bids.length ? Math.min(...bids.map((l) => l.price)) : null;
  const ahead = level ? level.size : lowest == null || price > lowest ? 0 : null;
  return { ahead, shares: 0, at: null };
}

/** Apply one trade print to a resting bid. Returns the shares that became ours. */
export function applyPrint(side: Side, p: { price: number; size: number; side: string; t: number }, price = PREOPEN_BID, usd = PREOPEN_USD): number {
  const want = usd / price - side.shares;
  if (want <= 1e-9 || side.ahead == null) return 0;
  const through = p.price < price - 1e-9;
  if (!through && !(p.side === "SELL" && p.price <= price + 1e-9)) return 0;
  let size = p.size;
  if (!through) {
    const eaten = Math.min(side.ahead, size);
    side.ahead -= eaten;
    size -= eaten;
  } else side.ahead = 0;
  const got = Math.min(want, size);
  if (got <= 1e-9) return 0;
  side.shares += got;
  side.at ??= p.t;
  return got;
}

const state: State = loadJson<State>(FILE, { windows: 0, noQueue: 0, trades: [] });
const slots = new Map<string, Slot>();
let last: Record<string, unknown> = {};

function onTrade(p: TradePrint) {
  for (const [key, slot] of slots) {
    const m = slot.market;
    if (!m || slot.done) continue;
    const printUp = p.tokenId === m.upToken;
    if (!printUp && p.tokenId !== m.downToken) continue;
    // One trade prints on one token only (checked on the first prints, 10 Nov 2026): a taker BUY of Down at 0.51 is the
    // same trade as a taker SELL of Up at 0.49, so each print is applied to its own side and, mirrored, to the other.
    for (const which of ["UP", "DOWN"] as const) {
      const side = which === "UP" ? slot.up : slot.down;
      if (!side) continue;
      const own = (which === "UP") === printUp;
      if (!own && p.side !== "BUY") continue;
      const got = applyPrint(side, own ? p : { price: Math.round((1 - p.price) * 100) / 100, size: p.size, side: "SELL", t: p.t });
      if (got <= 0) continue;
      const t = state.trades.find((x) => x.series === key && x.start === slot.start && x.side === which);
      if (t) {
        t.shares += got;
        t.cost = t.shares * PREOPEN_BID;
      } else state.trades.push({ series: key, start: slot.start, side: which, shares: got, cost: got * PREOPEN_BID, at: p.t, secBefore: Math.round(slot.start - p.t / 1000) });
      saveJson(FILE, state);
    }
    return;
  }
}

async function tick(series: Series) {
  const now = Math.floor(Date.now() / 1000);
  const next = (Math.floor(now / series.windowSec) + 1) * series.windowSec;
  const until = next - now;
  let slot = slots.get(series.key);
  if (slot && slot.start !== next) {
    // The window we were bidding on has opened: the recorder watches its tokens itself from here.
    watchExtra(`${series.key}-next`, null);
    slots.delete(series.key);
    slot = undefined;
  }
  if (until > FROM) return;
  if (!slot) {
    slot = { start: next, market: null, triedAt: 0, up: null, down: null, done: false, snapAt: 0, counted: false };
    slots.set(series.key, slot);
  }
  if (!slot.market) {
    if (Date.now() - slot.triedAt < 15_000) return;
    slot.triedAt = Date.now();
    slot.market = await marketFor(next, series.slug, series.slugStyle).catch(() => null);
    if (!slot.market) return;
    watchExtra(`${series.key}-next`, [slot.market.upToken, slot.market.downToken]);
    return;
  }
  const up = bookFeed.peek(slot.market.upToken, 600_000);
  const down = bookFeed.peek(slot.market.downToken, 600_000);
  if (until <= TO) {
    slot.done = true;
    return;
  }
  if (!up || !down) return;
  if (!slot.counted) {
    slot.counted = true;
    slot.up = placeBid(up.bids, up.bestAsk);
    slot.down = placeBid(down.bids, down.bestAsk);
    state.windows += 1;
    if (slot.up?.ahead == null || slot.down?.ahead == null) state.noQueue += 1;
    saveJson(FILE, state);
  }
  if (Date.now() - slot.snapAt >= 30_000) {
    slot.snapAt = Date.now();
    const sz = (ls: { price: number; size: number }[], px: number | null) => (px == null ? null : Math.round(ls.find((l) => l.price === px)?.size ?? 0));
    const row = [Date.now(), next, until, up.bestBid, up.bestAsk, down.bestBid, down.bestAsk, sz(up.bids, up.bestBid), sz(up.asks, up.bestAsk), sz(down.bids, down.bestBid), sz(down.asks, down.bestAsk), slot.up?.ahead ?? null, slot.down?.ahead ?? null];
    last[series.key] = { until, upBid: up.bestBid, upAsk: up.bestAsk, downBid: down.bestBid, downAsk: down.bestAsk, aheadUp: slot.up?.ahead ?? null, aheadDown: slot.down?.ahead ?? null };
    try {
      append(`${series.key}-preopen`, { b: row });
    } catch {
      /* a full disk must not stop anything */
    }
  }
}

async function settle() {
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const t of state.trades) {
    if (t.won != null || now < t.start + 900 + 120) continue;
    const s = SERIES.find((x) => x.key === t.series);
    if (!s) continue;
    const r = await resolution(t.start, s.slug, s.slugStyle).catch(() => null);
    if (!r || r.resolvedUp == null) continue;
    t.won = r.resolvedUp === (t.side === "UP");
    t.net = Math.round((t.won ? t.shares - t.cost : -t.cost) * 100) / 100;
    changed = true;
  }
  if (state.trades.length > 3000) state.trades.splice(0, state.trades.length - 3000);
  if (changed) saveJson(FILE, state);
}

export function preopenSummary() {
  const done = state.trades.filter((t) => t.won != null);
  return {
    rule: "preopen-both49: 49c bids on Up and Down of the next BTC/ETH/SOL 15m window, 10 min to 60 s before it opens, $5 each; fills counted only on recorded trades after the queue ahead; paper",
    windows: state.windows,
    noQueue: state.noQueue,
    fills: state.trades.length,
    settled: done.length,
    won: done.filter((t) => t.won).length,
    net: Math.round(done.reduce((a, t) => a + (t.net ?? 0), 0) * 100) / 100,
    last,
    recent: state.trades.slice(-10),
  };
}

export function startPreopen() {
  if (process.env.PREOPEN === "off") return null;
  bookFeed.onTrade(onTrade);
  const series = SERIES.filter((s) => KEYS.includes(s.key));
  let busy = false;
  let n = 0;
  return setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      for (const s of series) await tick(s).catch(() => undefined);
      if (++n % 12 === 0) await settle().catch(() => undefined);
    } finally {
      busy = false;
    }
  }, 5000);
}
