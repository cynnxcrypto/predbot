/**
 * PAPER ONLY. `pairfast` (11 Nov 2026): the fast two-sided pair bot, on paper. Nothing here places an order.
 *
 * Why: the real pair test (src/pairlive.ts) lost because it looked once a second and re-joined the best bid at the back
 * of the queue; the winning pair wallets leave bids resting on both sides all window and earn about 1c a leg from their
 * place in the queue (/mnt/project-files/reviews/top-traders-crypto-2026-11-11.md, update 02:40 KST).
 *
 * What is different from src/pairlock.ts:
 *  - Driven by the websocket: quotes are re-decided on every change of the book, not on a 1-second timer.
 *  - Orders REST. A bid is left where it is (queue place kept) until it is `slack` cents behind the ladder.
 *  - Several levels a side (`offs`, cents under the best bid), 6 shares each.
 *  - Inventory, not "one clip then complete": both sides keep quoting; the side that is ahead by `maxImb` clips stops.
 *  - Never a taker, never raised to finish a pair.
 *
 * The fill model is deliberately strict, because the 1-second replay flattered us:
 *  - A decision reaches the book LAG ms later (placing and cancelling both). A bid is post-only: if it would cross when
 *    it arrives it is rejected. A cancelled bid can still be filled until the cancel lands.
 *  - Queue: a bid joins behind everything shown at its price when it arrives. Only trades at that price move it up;
 *    a cancel is assumed to be behind us unless the whole level is now smaller than our place in it.
 *  - Fills come from trade prints only. At our price we are filled after the queue ahead; a print through our price
 *    fills us for at most its own size. One print cannot fill two of our bids twice over.
 *  - After a hole in the feed, any bid the market has traded through is counted as filled (the worst case).
 *  - Every fill is marked 10 s and 30 s later against the mid, and whether its level was swept within 2 s: the markout
 *    is the early, honest read (top wallets about +0.8c a fill, small bots about -0.3c).
 * Result per window = payout of the side that won minus everything paid, booked only after Polymarket resolves it.
 */
import { SERIES, type Symbol } from "./config.js";
import { feedsFor } from "./feeds/index.js";
import { bookFeed, type TradePrint } from "./feeds/book.js";
import { resolution, type Book } from "./polymarket.js";
import { currentMarket } from "./recorder.js";
import { append, loadJson, saveJson } from "./store.js";

export const CLIP = 6;
export const LAG = 250; // ms from decision to the book, placing or cancelling (measured from Stockholm: about 170)
const MIN_ORDER = 5; // Polymarket's smallest order, shares
const MAX_SIDE = 60; // most shares bought on one side in one window
const FILE = "pairfast.json";
const EPS = 1e-9;

export type Spec = { name: string; key: string; offs: number[]; slack: number; maxImb: number; lock?: boolean; from: number; stop: number; band?: [number, number]; maxPairs?: number; minBid?: number; pull?: { bp: number; ms: number; hold: number } };
const ETH = "eth15m";
const BTC5M = SERIES[0].key; // the first series is BTC 5m
const base = (name: string, offs: number[], slack: number, maxImb: number, lock = false, more: Partial<Spec> = {}): Spec[] => [
  { name, key: ETH, offs, slack, maxImb, lock, from: 20, stop: 120, ...more },
  { name: `${name}-5m`, key: BTC5M, offs, slack, maxImb, lock, from: 10, stop: 120, ...more },
];
export const PAIRFAST: Spec[] = [
  // Control: the old method (one bid a side, re-joined whenever the best bid moves) under the strict fill model.
  ...base("pairfast-requote", [0], 0, 1),
  // One resting bid a side at the best bid, left alone until it is 3c behind.
  ...base("pairfast-top", [0], 3, 1),
  // The paper twin of the REAL rule (src/pairfastlive.ts, BTC 5m): one resting bid a side, a pair never over 99c, new
  // pairs only while both best bids are 17-83c, one pair a window. Compare `pairfast-top-lock-5m` with real fill by fill.
  ...base("pairfast-top-lock", [0], 3, 1, true, { band: [0.17, 0.83], maxPairs: 1 }),
  // Round 343 (11 Nov 2026 09:15 KST): first real hour of the fast rule: 7 windows, 5 full pairs at +6c to +18c, 2 lone
  // parts -$2.30 and -$3.00, net -$4.88. On paper 77-90% of fills come from a sweep and the price is 2c lower 30 s
  // later; the unlocked styles pay 104-107c a pair, the locked ones 97-98c but keep lone clips. This copy is the real
  // rule bidding 2c UNDER the best bid on both sides: it only fills on a sweep, but at the price the sweep ends at.
  ...base("pairfast-deep2-lock", [2], 3, 1, true, { band: [0.17, 0.83], maxPairs: 1 }),
  // 11 Nov 2026 09:40 KST, research after the first real hours (real 13 windows: 10 pairs +$0.90, 3 lone clips -$8.12).
  // Replay of the real rule on 10 h of 1-s books and prints (119 BTC 5m windows, 372 first fills): about 20% of first
  // fills never get their pair, and that share does not move with volatility, price level, hour or book size. 36
  // variants: calm-only, deeper, pair cap 95-103c, buying the other side at the ask: all red. Nearest to zero were
  // bids 2c deep (above), first legs only on the favourite, and starting 2 minutes in. The replay is kinder than live
  // paper, so these three run here under the strict model. `pairfast-top-lock` is their control.
  // First leg only on the side priced 60c or more (a lone favourite clip wins more often than it loses).
  ...base("pairfast-fav60-lock", [0], 3, 1, true, { band: [0.17, 0.83], maxPairs: 1, minBid: 0.6 }),
  // Round 345 (11:10 KST 11 Nov 2026). After ~3 h under the strict model the two styles with the fewest lone clips on
  // BTC 5m were fav60-lock (13 windows, 0 lone clips, +$1.62) and deep2-lock (18 windows, 2 lone, -$3.06); the real
  // rule's twin top-lock had 7 lone clips in 30 windows (-$9.47), real 5 in 30 (-$9.44). Samples are small. These
  // two join the ideas: first leg only on the favourite AND 2c under the best bid; and a stricter favourite (70c+).
  ...base("pairfast-fav60-deep2-lock", [2], 3, 1, true, { band: [0.17, 0.83], maxPairs: 1, minBid: 0.6 }),
  ...base("pairfast-fav70-lock", [0], 3, 1, true, { band: [0.17, 0.83], maxPairs: 1, minBid: 0.7 }),
  // No new pair in the first 2 minutes; new pairs until 60 s before the close.
  ...base("pairfast-late-lock", [0], 3, 1, true, { band: [0.17, 0.83], maxPairs: 1, from: 120, stop: 60 }),
  // What 1-second data cannot test: pull the first-leg bid on a side the moment Binance spot has moved 1.5 bp against
  // it within 2 s (Up when spot falls, Down when it rises), and keep it out for 3 s. The cancel takes the same 250 ms
  // as everything else, so this measures honestly whether we can step aside before the sweep arrives.
  ...base("pairfast-pull-lock", [0], 3, 1, true, { band: [0.17, 0.83], maxPairs: 1, pull: { bp: 1.5, ms: 2000, hold: 3000 } }),
  // Three resting levels a side: best bid, 1c and 2c under.
  ...base("pairfast-lad3", [0, 1, 2], 2, 3),
  // Same, but the side that is behind never bids more than 99c minus the average paid on the other side.
  ...base("pairfast-lad3-lock", [0, 1, 2], 2, 3, true),
  // Never at the best bid: four levels 1-4c under it, filled only when a sell sweeps down to them.
  ...base("pairfast-deep4", [1, 2, 3, 4], 3, 3),
];

type Side = "U" | "D";
export type Ord = { side: Side; price: number; rem: number; liveAt: number; ahead: number | null; ahead0: number; credit: number; creditAt: number; deadAt: number | null };
export type Fill = { side: Side; price: number; size: number; t: number; through: boolean; ahead0: number; age: number; gap?: boolean; mk10?: number | null; mk30?: number | null; swept?: boolean | null };
export type Sim = { start: number; windowSec: number; orders: Ord[]; inv: Record<Side, number>; cost: Record<Side, number>; fills: Fill[]; rebate: number; placed: number; cancelled: number; rejected: number; gaps: number };

const cent = (x: number) => Math.round(x * 100) / 100;
const r2 = (x: number) => Math.round(x * 100) / 100;
const other = (s: Side): Side => (s === "U" ? "D" : "U");
export const newSim = (start: number, windowSec: number): Sim => ({ start, windowSec, orders: [], inv: { U: 0, D: 0 }, cost: { U: 0, D: 0 }, fills: [], rebate: 0, placed: 0, cancelled: 0, rejected: 0, gaps: 0 });

/** Shares shown at `price` on the bid side; 0 above the lowest shown level, Infinity below it (unknown, never ahead of it). */
function levelSize(b: Book, price: number): number {
  const level = b.bids.find((l) => Math.abs(l.price - price) < EPS);
  if (level) return level.size;
  const lowest = b.bids.length ? b.bids[b.bids.length - 1].price : 0;
  return price > lowest ? 0 : Infinity;
}

function take(sim: Sim, o: Ord, size: number, now: number, through: boolean, gap = false) {
  const got = Math.min(o.rem, size);
  if (got <= EPS) return 0;
  o.rem -= got;
  sim.inv[o.side] += got;
  sim.cost[o.side] += got * o.price;
  sim.rebate += 0.014 * o.price * (1 - o.price) * got;
  sim.fills.push({ side: o.side, price: o.price, size: r2(got), t: now, through, ahead0: o.ahead0 === Infinity ? -1 : Math.round(o.ahead0), age: now - o.liveAt, ...(gap ? { gap } : {}) });
  return got;
}

/**
 * Bring the orders up to `now` (ms): bids that have reached the book take their place in the queue (or are rejected if
 * they would cross), cancels that have landed are removed, and a level that shrank below our place moves us up.
 */
export function sync(sim: Sim, up: Book | null, down: Book | null, now: number) {
  for (const o of sim.orders) {
    const b = o.side === "U" ? up : down;
    if (o.ahead == null && now >= o.liveAt && b) {
      if (b.bestAsk != null && o.price >= b.bestAsk - EPS) {
        o.rem = 0;
        sim.rejected += 1;
        continue;
      }
      o.ahead = o.ahead0 = levelSize(b, o.price);
    }
    if (o.ahead == null || !b) continue;
    if (now - o.creditAt > 2000) o.credit = 0;
    const size = levelSize(b, o.price);
    if (o.ahead > size) {
      // The level is smaller than the queue we thought was ahead: some of it left. If that was a trade, its print will
      // follow (or came first); `credit` stops that print from moving us up a second time.
      if (o.ahead !== Infinity) {
        o.credit += o.ahead - size;
        o.creditAt = now;
      }
      o.ahead = size;
    }
  }
  sim.orders = sim.orders.filter((o) => o.rem > 0.01 && !(o.deadAt != null && now >= o.deadAt));
}

/** One trade print (taker `side`, on the Up token or the Down token). Returns the shares it filled for us. */
export function onPrint(sim: Sim, p: { price: number; size: number; side: string }, isUpToken: boolean, now: number): number {
  let total = 0;
  for (const side of ["U", "D"] as const) {
    const own = (side === "U") === isUpToken;
    // A taker SELL of our token hits our bid level; a taker BUY of the other token at q is the same book level at 1 - q.
    if (own ? p.side !== "SELL" : p.side !== "BUY") continue;
    const level = own ? p.price : cent(1 - p.price);
    let left = p.size;
    const mine = sim.orders.filter((o) => o.side === side && o.ahead != null && now >= o.liveAt).sort((a, b) => b.price - a.price);
    for (const o of mine) {
      if (left <= EPS) break;
      if (level > o.price + EPS) continue; // traded at a better bid than ours: does not reach us
      let got: number;
      if (level < o.price - EPS) {
        o.ahead = 0;
        got = take(sim, o, left, now, true);
      } else {
        const fresh = Math.max(0, left - o.credit); // the part of this print not already counted as a shrunken level
        o.credit -= Math.min(o.credit, left);
        const eaten = Math.min(o.ahead!, fresh);
        o.ahead = o.ahead! - eaten;
        got = take(sim, o, fresh - eaten, now, false);
      }
      left -= got;
      total += got;
    }
  }
  if (total > 0) sim.orders = sim.orders.filter((o) => o.rem > 0.01);
  return total;
}

/** After a hole in the feed: every bid the market is now trading below is counted as filled. */
export function afterGap(sim: Sim, up: Book | null, down: Book | null, now: number) {
  sim.gaps += 1;
  for (const o of sim.orders) {
    const b = o.side === "U" ? up : down;
    if (o.ahead != null && b?.bestBid != null && b.bestBid < o.price - EPS) take(sim, o, o.rem, now, true, true);
  }
  sim.orders = sim.orders.filter((o) => o.rem > 0.01);
}

/** Decide cancels and new bids for both sides. `now` in ms. Call after `sync`. */
export function quote(sim: Sim, spec: Spec, up: Book | null, down: Book | null, now: number, pulled: { U?: boolean; D?: boolean } = {}) {
  const elapsed = now / 1000 - sim.start;
  const left = sim.start + sim.windowSec - now / 1000;
  const cancel = (o: Ord) => {
    if (o.deadAt != null) return;
    o.deadAt = now + LAG;
    sim.cancelled += 1;
  };
  if (left <= 15) {
    sim.orders.forEach(cancel);
    return;
  }
  for (const side of ["U", "D"] as const) {
    const b = side === "U" ? up : down;
    if (!b || b.bestBid == null) continue; // no view: resting orders stay in the book
    const bid = b.bestBid;
    const imb = sim.inv[side] - sim.inv[other(side)];
    let open = elapsed >= spec.from && bid >= 0.05 - EPS && bid <= 0.95 + EPS && sim.inv[side] < MAX_SIDE;
    if (imb >= 0 && open) {
      // Starting a new pair (not completing one): the optional limits of the real rule.
      const ob = (side === "U" ? down : up)?.bestBid;
      if (spec.band && (ob == null || [bid, ob].some((x) => x < spec.band![0] - EPS || x > spec.band![1] + EPS))) open = false;
      if (spec.maxPairs && Math.min(sim.inv.U, sim.inv.D) >= spec.maxPairs * CLIP - 0.01) open = false;
      if (spec.minBid && bid < spec.minBid - EPS) open = false;
      if (pulled[side]) open = false;
    }
    // Before `stop`: rest up to maxImb clips beyond the other side. After it: only what completes pairs already begun.
    let allowed = !open ? 0 : left >= spec.stop ? spec.maxImb * CLIP - Math.max(0, imb) : Math.max(0, -imb);
    allowed = Math.min(allowed, MAX_SIDE - sim.inv[side]);
    let cap = 0.99;
    const o2 = other(side);
    if (spec.lock && imb < 0 && sim.inv[o2] > 0) cap = Math.floor((0.99 - sim.cost[o2] / sim.inv[o2]) * 100 + 1e-6) / 100;
    const targets = spec.offs.map((c) => cent(bid - c / 100)).filter((p) => p >= 0.01 && p <= cap + EPS);
    const lowest = targets.length ? Math.min(...targets) : Infinity;
    const live = sim.orders.filter((o) => o.side === side && o.deadAt == null);
    for (const o of live) if (o.price < lowest - spec.slack / 100 - EPS || o.price > cap + EPS) cancel(o);
    // Too much resting for the room there is: pull the highest bids first (lean away from the side we are long).
    let resting = 0;
    for (const o of live.filter((x) => x.deadAt == null).sort((a, b2) => a.price - b2.price)) {
      if (resting + o.rem > allowed + EPS) cancel(o);
      else resting += o.rem;
    }
    const kept = live.filter((o) => o.deadAt == null);
    // Empty ladder steps, deepest first, while there is room.
    for (const price of targets.filter((p) => !kept.some((o) => Math.abs(o.price - p) < EPS)).sort((a, b2) => a - b2)) {
      const size = Math.min(CLIP, allowed - resting);
      if (size < MIN_ORDER - EPS) break;
      sim.orders.push({ side, price, rem: size, liveAt: now + LAG, ahead: null, ahead0: 0, credit: 0, creditAt: 0, deadAt: null });
      sim.placed += 1;
      resting += size;
    }
  }
}

/** Mark fills 2 s, 10 s and 30 s after they happened against the current books. */
export function mark(sim: Sim, up: Book | null, down: Book | null, now: number) {
  for (const f of sim.fills) {
    const b = f.side === "U" ? up : down;
    if (!b || b.bestBid == null) continue;
    const mid = b.bestAsk != null ? (b.bestBid + b.bestAsk) / 2 : b.bestBid;
    if (f.swept === undefined && now >= f.t + 2000) f.swept = b.bestBid < f.price - EPS;
    if (f.mk10 === undefined && now >= f.t + 10_000) f.mk10 = Math.round((mid - f.price) * 1000) / 1000;
    if (f.mk30 === undefined && now >= f.t + 30_000) f.mk30 = Math.round((mid - f.price) * 1000) / 1000;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Runner: one sim per spec on the live feed, results booked after resolution.

type Rec = { name: string; key: string; start: number; up: number; down: number; upCost: number; downCost: number; fills: number; gaps: number; net?: number };
type Tot = {
  windows: number; won: number; net: number; quiet: number; fills: number; through: number; shares: number;
  pairShares: number; pairNet: number; loneShares: number; loneNet: number; loneWindows: number; loneWon: number;
  mkN: number; mk10: number; mk30: number; sweptN: number; swept: number; rebate: number; gapWindows: number;
  placed: number; cancelled: number; rejected: number; day: string; dayNet: number; dayWindows: number; recent: Rec[];
};
type Saved = { start: number; inv: Record<Side, number>; cost: Record<Side, number>; fills: Fill[]; rebate: number; gaps: number };
type State = { tot: Record<string, Tot>; pending: Rec[]; live: Record<string, Saved> };

const state = loadJson<State>(FILE, { tot: {}, pending: [], live: {} });
state.tot ??= {};
state.pending ??= [];
state.live ??= {};
const sims = new Map<string, Sim>();
const kstDay = (sec: number) => new Date((sec + 9 * 3600) * 1000).toISOString().slice(0, 10);
const tot = (name: string): Tot =>
  (state.tot[name] ??= { windows: 0, won: 0, net: 0, quiet: 0, fills: 0, through: 0, shares: 0, pairShares: 0, pairNet: 0, loneShares: 0, loneNet: 0, loneWindows: 0, loneWon: 0, mkN: 0, mk10: 0, mk30: 0, sweptN: 0, swept: 0, rebate: 0, gapWindows: 0, placed: 0, cancelled: 0, rejected: 0, day: "", dayNet: 0, dayWindows: 0, recent: [] });
let dirty = false;
let feedOkAt = 0;

function books(key: string, start: number): [Book | null, Book | null, { upToken: string; downToken: string } | null] {
  const m = currentMarket(key);
  if (!m || m.start !== start) return [null, null, null];
  return [bookFeed.fresh(m.upToken), bookFeed.fresh(m.downToken), m];
}

function close(spec: Spec, sim: Sim) {
  const t = tot(spec.name);
  t.placed += sim.placed;
  t.cancelled += sim.cancelled;
  t.rejected += sim.rejected;
  delete state.live[spec.name];
  dirty = true;
  if (!sim.fills.length) {
    t.quiet += 1;
    return;
  }
  t.fills += sim.fills.length;
  t.through += sim.fills.filter((f) => f.through).length;
  t.shares = r2(t.shares + sim.inv.U + sim.inv.D);
  t.rebate = Math.round((t.rebate + sim.rebate) * 1000) / 1000;
  if (sim.gaps) t.gapWindows += 1;
  for (const f of sim.fills) {
    if (f.mk10 != null && f.mk30 != null) {
      t.mkN += f.size;
      t.mk10 += f.mk10 * f.size;
      t.mk30 += f.mk30 * f.size;
    }
    if (f.swept != null) {
      t.sweptN += 1;
      if (f.swept) t.swept += 1;
    }
  }
  const rec: Rec = { name: spec.name, key: spec.key, start: sim.start, up: r2(sim.inv.U), down: r2(sim.inv.D), upCost: r2(sim.cost.U), downCost: r2(sim.cost.D), fills: sim.fills.length, gaps: sim.gaps };
  state.pending.push(rec);
  try {
    append("pairfast", { v: spec.name, s: spec.key, start: sim.start, up: rec.up, down: rec.down, upCost: rec.upCost, downCost: rec.downCost, placed: sim.placed, cancelled: sim.cancelled, rejected: sim.rejected, gaps: sim.gaps, fills: sim.fills.map((f) => [f.side, f.price, f.size, Math.round(f.t / 1000) - sim.start, f.through ? 1 : 0, f.ahead0, f.age, f.swept == null ? null : f.swept ? 1 : 0, f.mk10 ?? null, f.mk30 ?? null]) });
  } catch {
    /* a full disk must not stop anything */
  }
}

/** Advance every sim of one series: window roll, order arrivals, markouts, quotes. */
function step(key: string, now: number) {
  const s = SERIES.find((x) => x.key === key);
  if (!s) return;
  const start = Math.floor(now / 1000 / s.windowSec) * s.windowSec;
  const [up, down] = books(key, start);
  for (const spec of PAIRFAST) {
    if (spec.key !== key) continue;
    let sim = sims.get(spec.name);
    if (sim && sim.start !== start) {
      close(spec, sim);
      sim = undefined;
    }
    if (!sim) {
      sim = newSim(start, s.windowSec);
      const saved = state.live[spec.name];
      // A restart inside a window: the resting orders are gone (as they would be), what was bought is still ours.
      if (saved && saved.start === start) Object.assign(sim, { inv: saved.inv, cost: saved.cost, fills: saved.fills, rebate: saved.rebate, gaps: saved.gaps });
      sims.set(spec.name, sim);
    }
    if (!up || !down) continue;
    sync(sim, up, down, now);
    mark(sim, up, down, now);
    quote(sim, spec, up, down, now, spec.pull ? pulledNow(spec, s.symbol, now) : {});
  }
}

const pullUntil = new Map<string, { U: number; D: number; at: number }>();
/** Which sides of a `pull` rule are stepped aside right now: spot moved `bp` against that side within `ms`. */
function pulledNow(spec: Spec, symbol: Symbol, now: number): { U: boolean; D: boolean } {
  const st = pullUntil.get(spec.name) ?? { U: 0, D: 0, at: 0 };
  pullUntil.set(spec.name, st);
  if (spec.pull && now - st.at >= 100) {
    st.at = now;
    const feed = feedsFor(symbol).binance;
    const last = feed.last(3000);
    const before = feed.at(now - spec.pull.ms);
    // No fresh spot price: stay out on both sides rather than quote blind.
    if (!last || !before || now - before.t > spec.pull.ms + 3000) st.U = st.D = now + spec.pull.hold;
    else {
      const bp = (last.price / before.price - 1) * 1e4;
      if (bp <= -spec.pull.bp) st.U = now + spec.pull.hold;
      if (bp >= spec.pull.bp) st.D = now + spec.pull.hold;
    }
  }
  return { U: now < st.U, D: now < st.D };
}

function persist(spec: Spec, sim: Sim) {
  state.live[spec.name] = { start: sim.start, inv: sim.inv, cost: sim.cost, fills: sim.fills, rebate: sim.rebate, gaps: sim.gaps };
  dirty = true;
}

function trade(p: TradePrint) {
  const now = Date.now();
  for (const key of [ETH, BTC5M]) {
    const m = currentMarket(key);
    if (!m || (p.tokenId !== m.upToken && p.tokenId !== m.downToken)) continue;
    const up = bookFeed.fresh(m.upToken);
    const down = bookFeed.fresh(m.downToken);
    for (const spec of PAIRFAST) {
      const sim = sims.get(spec.name);
      if (spec.key !== key || !sim || sim.start !== m.start) continue;
      sync(sim, up, down, now);
      if (onPrint(sim, p, p.tokenId === m.upToken, now) > 0) persist(spec, sim);
    }
    step(key, now); // re-quote at once after a fill
    return;
  }
}

function update(tokenId: string) {
  for (const key of [ETH, BTC5M]) {
    const m = currentMarket(key);
    if (m && (tokenId === m.upToken || tokenId === m.downToken)) return step(key, Date.now());
  }
}

function tick() {
  const now = Date.now();
  const ok = bookFeed.connected() && now - bookFeed.lastAt < 3000;
  if (ok && feedOkAt && now - feedOkAt > 5000) {
    // The feed was away for more than 5 s: prints were missed. Take the worst case for every resting bid.
    for (const spec of PAIRFAST) {
      const sim = sims.get(spec.name);
      if (!sim) continue;
      const [up, down] = books(spec.key, sim.start);
      const before = sim.fills.length;
      afterGap(sim, up, down, now);
      if (sim.fills.length > before) persist(spec, sim);
    }
  }
  if (ok) feedOkAt = now;
  for (const key of [ETH, BTC5M]) step(key, now);
  if (dirty) {
    dirty = false;
    saveJson(FILE, state);
  }
}

/** Book one settled window into the totals. Exported for the test. */
export function book1(t: Tot, rec: Rec, upWon: boolean) {
  const net = r2((upWon ? rec.up : rec.down) - rec.upCost - rec.downCost);
  rec.net = net;
  const paired = Math.min(rec.up, rec.down);
  const pairNet = paired > 0 ? paired * (1 - rec.upCost / rec.up - rec.downCost / rec.down) : 0;
  const lone = Math.abs(rec.up - rec.down);
  t.windows += 1;
  if (net > 0) t.won += 1;
  t.net = r2(t.net + net);
  t.pairShares = r2(t.pairShares + paired);
  t.pairNet = r2(t.pairNet + pairNet);
  if (lone >= 1) {
    t.loneWindows += 1;
    t.loneShares = r2(t.loneShares + lone);
    t.loneNet = r2(t.loneNet + net - pairNet);
    if (upWon === rec.up > rec.down) t.loneWon += 1;
  }
  const day = kstDay(rec.start);
  if (t.day !== day) {
    t.day = day;
    t.dayNet = 0;
    t.dayWindows = 0;
  }
  t.dayNet = r2(t.dayNet + net);
  t.dayWindows += 1;
  t.recent.push(rec);
  if (t.recent.length > 20) t.recent.splice(0, t.recent.length - 20);
}

async function settle() {
  const now = Math.floor(Date.now() / 1000);
  const seen = new Map<string, boolean | null>();
  const keep: Rec[] = [];
  for (const rec of state.pending) {
    const s = SERIES.find((x) => x.key === rec.key);
    if (!s || now < rec.start + s.windowSec + 120) {
      if (s) keep.push(rec);
      continue;
    }
    const k = `${rec.key}|${rec.start}`;
    if (!seen.has(k)) seen.set(k, (await resolution(rec.start, s.slug, s.slugStyle).catch(() => null))?.resolvedUp ?? null);
    const upWon = seen.get(k);
    if (upWon == null) {
      if (now < rec.start + s.windowSec + 6 * 3600) keep.push(rec); // unresolved after 6 h: dropped, not guessed
      continue;
    }
    book1(tot(rec.name), rec, upWon);
    dirty = true;
  }
  if (keep.length !== state.pending.length) dirty = true;
  state.pending = keep;
}

export function pairfastSummary() {
  const today = kstDay(Date.now() / 1000);
  return {
    paperOnly: true,
    lagMs: LAG,
    clip: CLIP,
    rules: PAIRFAST.map((spec) => {
      const t = tot(spec.name);
      const c = (x: number, n: number) => (n > 0 ? Math.round((x / n) * 1000) / 10 : null); // cents
      const sim = sims.get(spec.name);
      return {
        name: spec.name,
        market: SERIES.find((x) => x.key === spec.key)?.label ?? spec.key,
        levels: spec.offs.length,
        windows: t.windows,
        won: t.won,
        net: t.net,
        todayNet: t.day === today ? t.dayNet : 0,
        todayWindows: t.day === today ? t.dayWindows : 0,
        open: state.pending.filter((r) => r.name === spec.name).length,
        quiet: t.quiet,
        fills: t.fills,
        throughPct: t.fills ? Math.round((t.through / t.fills) * 100) : null,
        pairs: Math.round((t.pairShares / CLIP) * 10) / 10,
        pairNet: t.pairNet,
        pairCostC: t.pairShares > 0 ? Math.round((1 - t.pairNet / t.pairShares) * 1000) / 10 : null,
        loneWindows: t.loneWindows,
        loneWon: t.loneWon,
        loneNet: t.loneNet,
        markout10C: c(t.mk10, t.mkN),
        markout30C: c(t.mk30, t.mkN),
        sweptPct: t.sweptN ? Math.round((t.swept / t.sweptN) * 100) : null,
        rebateEst: t.rebate,
        gapWindows: t.gapWindows,
        orders: { placed: t.placed, cancelled: t.cancelled, rejected: t.rejected },
        now: sim ? { start: sim.start, up: r2(sim.inv.U), down: r2(sim.inv.D), cost: r2(sim.cost.U + sim.cost.D), resting: sim.orders.filter((o) => o.deadAt == null).map((o) => [o.side, o.price, o.ahead == null || o.ahead === Infinity ? null : Math.round(o.ahead)]) } : null,
        recent: t.recent.slice(-8),
      };
    }),
  };
}

export function startPairfast() {
  if (process.env.PAIRFAST === "off") return null;
  const guard = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => {
    try {
      f(...a);
    } catch {
      /* paper only: never disturb the bot */
    }
  };
  bookFeed.onTrade(guard(trade));
  bookFeed.onUpdate(guard(update));
  let n = 0;
  let busy = false;
  return setInterval(() => {
    guard(tick)();
    if (++n % 240 === 0 && !busy) {
      busy = true;
      settle().catch(() => undefined).finally(() => (busy = false));
    }
  }, 250);
}
