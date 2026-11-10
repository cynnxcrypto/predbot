/**
 * PAPER ONLY. `pairlock` (10 Nov 2026, top-traders research, /mnt/project-files/reviews/top-traders-crypto-2026-11-11.md).
 *
 * What the steady winners on the 15-minute crypto markets do: they rest bids on BOTH Up and Down and lock pairs that
 * cost under $1 together (one of the two always pays $1). Our own maker lost because it bid one side only.
 *
 * Rule (clip 6 shares, one order per side): from 30 s after the open until 180 s before the close, while flat, if
 * upBid + downBid <= 0.99 and both are 10-90c, rest a bid at the best bid on each side; when the best bid moves, cancel
 * and re-join (queue position resets). After the first fill at p, cancel the other entry bid and rest a completion bid
 * on the other side at min(its best bid, 0.99 - p) until 20 s before the close. A complete pair returns to flat and
 * starts again. An unpaired clip is held to settlement.
 *
 * Twins: refresh every 5 s instead of 1 s (measures the speed effect); `chase20` lets the completion bid go up to
 * 1.03 - p after 20 s unpaired (a 3c loss instead of a full one); ETH and SOL only.
 *
 * Fills come from trade prints only, never from book touches: a taker SELL of our outcome below our bid, or a taker BUY
 * of the other outcome above (1 - our bid), fills us; at exactly our price the shares shown at that price when we joined
 * must trade first. Simplification: an order needs its whole clip on one resting price; a part fill is dropped when the
 * order is re-priced. Nothing here places an order.
 */
import { SERIES } from "./config.js";
import { bookFeed, type TradePrint } from "./feeds/book.js";
import { resolution, type Book } from "./polymarket.js";
import { currentMarket } from "./recorder.js";
import { append, loadJson, saveJson } from "./store.js";

export const CLIP = 6;
const FILE = "pairlock.json";
type Spec = { name: string; every: number; chase: boolean; keys: string[]; from?: number; stop?: number; cut?: number; cap?: number };
const BIG3 = ["btc15m", "eth15m", "sol15m"];
const BTC5M = SERIES[0].key; // the first series is BTC 5m
const USED = [...BIG3, BTC5M];
export const PAIRLOCK: Spec[] = [
  { name: "pairlock-1s", every: 1, chase: false, keys: BIG3 },
  { name: "pairlock-5s", every: 5, chase: false, keys: BIG3 },
  { name: "pairlock-1s-chase20", every: 1, chase: true, keys: BIG3 },
  { name: "pairlock-1s-ethsol", every: 1, chase: false, keys: ["eth15m", "sol15m"] },
  // 11 Nov 2026 00:00 KST (top-traders update): the best pair bots do most of their volume on BTC 5m. Same rule on the
  // 5-minute window: start 20 s after the open, stop new pairs 60 s before the close.
  { name: "pairlock-1s-5m", every: 1, chase: false, keys: [BTC5M], from: 20, stop: 60 },
  // Round 335 (11 Nov 2026 01:15 KST): the first real hour of the pair test: 9 windows, about 21 pairs at +6c each, but
  // 3 windows ended with a lone clip and all 3 lost (-$2.82, -$2.58, -$1.20), net -$5.04. Paper says the same: 23 of
  // 23 settled lone clips lost across the copies. The side that fills first is the side that is falling. These twins cut a lone clip
  // instead of holding it: when its own best bid is 10c (or 5c) under what we paid, sell it at that bid and start again.
  // 11 Nov 2026 01:30 KST (top-traders update): the best pair wallets pay over $1 for a third to half of their pairs
  // (p90 108-109c) and leave under 2% unpaired; replay with the completion bid allowed up to pair cost 1.10: +$41 vs
  // +$29, lone clips 4.4% vs 15.7%. Real runs this from 01:30 KST; these are its paper twins.
  { name: "pairlock-1s-cap110", every: 1, chase: false, keys: BIG3, cap: 1.1 },
  { name: "pairlock-1s-5m-cap110", every: 1, chase: false, keys: [BTC5M], from: 20, stop: 60, cap: 1.1 },
  { name: "pairlock-1s-cut10", every: 1, chase: false, keys: BIG3, cut: 0.1 },
  { name: "pairlock-1s-cut5", every: 1, chase: false, keys: BIG3, cut: 0.05 },
  { name: "pairlock-1s-5m-cut10", every: 1, chase: false, keys: [BTC5M], from: 20, stop: 60, cut: 0.1 },
  { name: "pairlock-1s-5m-cut5", every: 1, chase: false, keys: [BTC5M], from: 20, stop: 60, cut: 0.05 },
];

export type Order = { price: number; ahead: number; got: number };
export type Sim = { start: number; up: Order | null; down: Order | null; held: { side: "U" | "D"; price: number; at: number } | null; pairs: number; cost: number; rebate: number; active: boolean; cuts: number; cutNet: number };
type Left = { series: string; start: number; side: "U" | "D"; price: number; won?: boolean; net?: number };
type Tot = { windows: number; pairs: number; pairNet: number; rebate: number; left: Left[]; cuts?: number; cutNet?: number };

const cent = (x: number) => Math.round(x * 100) / 100;
export const newSim = (start: number): Sim => ({ start, up: null, down: null, held: null, pairs: 0, cost: 0, rebate: 0, active: false, cuts: 0, cutNet: 0 });

/** Join (or keep) a resting bid at `price`; a new price means a new place in the queue behind the shares shown there. */
export function join(cur: Order | null, bids: { price: number; size: number }[], price: number): Order {
  if (cur && Math.abs(cur.price - price) < 1e-9) return cur;
  const level = bids.find((l) => Math.abs(l.price - price) < 1e-9);
  const lowest = bids.length ? Math.min(...bids.map((l) => l.price)) : 0;
  return { price, ahead: level ? level.size : price > lowest ? 0 : Infinity, got: 0 };
}

/** One second of quoting for one sim. `now` and `left` in seconds. */
export function quote(sim: Sim, up: Book | null, down: Book | null, now: number, left: number, chase: boolean, from = 30, stop = 180, cut = 0, capAt = 0.99) {
  const elapsed = now - sim.start;
  if (!up || !down || up.bestBid == null || down.bestBid == null) {
    sim.up = sim.down = null;
    return;
  }
  if (!sim.held) {
    const ok = elapsed >= from && left >= stop && up.bestBid + down.bestBid <= 0.99 + 1e-9 && [up.bestBid, down.bestBid].every((b) => b >= 0.1 && b <= 0.9);
    if (!ok) {
      sim.up = sim.down = null;
      return;
    }
    sim.active = true;
    sim.up = join(sim.up, up.bids, up.bestBid);
    sim.down = join(sim.down, down.bids, down.bestBid);
    return;
  }
  const own = sim.held.side === "U" ? up : down;
  if (cut > 0 && own.bestBid != null && own.bestBid <= sim.held.price - cut + 1e-9) {
    // Cut the lone clip: sold at its own best bid (a taker sale; the fee is not counted here).
    sim.cuts += 1;
    sim.cutNet += (own.bestBid - sim.held.price) * CLIP;
    sim.held = null;
    sim.up = sim.down = null;
    return;
  }
  const other = sim.held.side === "U" ? down : up;
  const cap = Math.floor(((chase && now - sim.held.at >= 20 ? 1.03 : capAt) - sim.held.price) * 100 + 1e-6) / 100;
  const price = cent(Math.min(other.bestBid!, cap));
  const o = left > 20 && price >= 0.01 ? join(sim.held.side === "U" ? sim.down : sim.up, other.bids, price) : null;
  if (sim.held.side === "U") {
    sim.up = null;
    sim.down = o;
  } else {
    sim.down = null;
    sim.up = o;
  }
}

/** Shares of one print that reach a resting order (0 when the print does not touch it). `own` = the print is in our outcome's token. */
export function hit(o: Order, p: { price: number; size: number; side: string }, own: boolean): boolean {
  const bid = own ? o.price : cent(1 - o.price);
  const takerOk = own ? p.side === "SELL" : p.side === "BUY";
  if (!takerOk) return false;
  const through = own ? p.price < bid - 1e-9 : p.price > bid + 1e-9;
  const at = Math.abs(p.price - bid) < 1e-9;
  if (!through && !at) return false;
  let size = p.size;
  if (at) {
    const eaten = Math.min(o.ahead, size);
    o.ahead -= eaten;
    size -= eaten;
  } else o.ahead = 0;
  o.got += size;
  return o.got >= CLIP - 1e-9;
}

/** Apply a print to a sim. Returns "pair", "first" or null. */
export function onPrint(sim: Sim, p: { price: number; size: number; side: string }, isUp: boolean, now: number): "pair" | "first" | null {
  for (const side of ["U", "D"] as const) {
    const o = side === "U" ? sim.up : sim.down;
    if (!o || !hit(o, p, (side === "U") === isUp)) continue;
    sim.rebate += 0.014 * o.price * (1 - o.price) * CLIP;
    if (sim.held) {
      sim.pairs += 1;
      sim.cost += sim.held.price + o.price;
      sim.held = null;
      sim.up = sim.down = null;
      return "pair";
    }
    sim.held = { side, price: o.price, at: now };
    sim.up = sim.down = null;
    return "first";
  }
  return null;
}

const state = loadJson<Record<string, Tot>>(FILE, {});
const sims = new Map<string, Sim>(); // `${variant}|${series}`
const tot = (name: string) => (state[name] ??= { windows: 0, pairs: 0, pairNet: 0, rebate: 0, left: [] });

function close(spec: Spec, key: string, sim: Sim) {
  if (!sim.active && !sim.pairs && !sim.held && !sim.cuts) return;
  const t = tot(spec.name);
  const pairNet = Math.round((sim.pairs - sim.cost) * CLIP * 100) / 100;
  t.windows += 1;
  t.pairs += sim.pairs;
  t.pairNet = Math.round((t.pairNet + pairNet) * 100) / 100;
  t.rebate = Math.round((t.rebate + sim.rebate) * 1000) / 1000;
  t.cuts = (t.cuts ?? 0) + sim.cuts;
  t.cutNet = Math.round(((t.cutNet ?? 0) + sim.cutNet) * 100) / 100;
  if (sim.held) t.left.push({ series: key, start: sim.start, side: sim.held.side, price: sim.held.price });
  if (t.left.length > 600) t.left.splice(0, t.left.length - 600);
  try {
    append("pairlock", { v: spec.name, s: key, start: sim.start, pairs: sim.pairs, pairCost: sim.pairs ? Math.round((sim.cost / sim.pairs) * 1000) / 1000 : null, pairNet, rebate: Math.round(sim.rebate * 1000) / 1000, left: sim.held ? [sim.held.side, sim.held.price] : null });
  } catch {
    /* a full disk must not stop anything */
  }
}

function tick() {
  const now = Math.floor(Date.now() / 1000);
  let dirty = false;
  for (const s of SERIES) {
    if (!USED.includes(s.key)) continue;
    const start = Math.floor(now / s.windowSec) * s.windowSec;
    const m = currentMarket(s.key);
    const live = m && m.start === start ? m : null;
    const up = live ? bookFeed.fresh(live.upToken) : null;
    const down = live ? bookFeed.fresh(live.downToken) : null;
    for (const spec of PAIRLOCK) {
      if (!spec.keys.includes(s.key)) continue;
      const id = `${spec.name}|${s.key}`;
      let sim = sims.get(id);
      if (sim && sim.start !== start) {
        close(spec, s.key, sim);
        dirty = true;
        sim = undefined;
      }
      if (!sim) sims.set(id, (sim = newSim(start)));
      if (now % spec.every === 0) quote(sim, up, down, now, start + s.windowSec - now, spec.chase, spec.from, spec.stop, spec.cut, spec.cap);
    }
  }
  if (dirty) saveJson(FILE, state);
}

function trade(p: TradePrint) {
  const now = Math.floor(Date.now() / 1000);
  for (const s of SERIES) {
    if (!USED.includes(s.key)) continue;
    const m = currentMarket(s.key);
    if (!m || (p.tokenId !== m.upToken && p.tokenId !== m.downToken)) continue;
    for (const spec of PAIRLOCK) {
      const sim = sims.get(`${spec.name}|${s.key}`);
      if (sim && sim.start === m.start) onPrint(sim, p, p.tokenId === m.upToken, now);
    }
    return;
  }
}

async function settle() {
  const now = Math.floor(Date.now() / 1000);
  const seen = new Map<string, boolean | null>();
  let changed = false;
  for (const t of Object.values(state)) {
    for (const l of t.left) {
      const s = SERIES.find((x) => x.key === l.series);
      if (l.won != null || !s || now < l.start + s.windowSec + 120) continue;
      const k = `${l.series}|${l.start}`;
      if (!seen.has(k)) {
        const r = s ? await resolution(l.start, s.slug, s.slugStyle).catch(() => null) : null;
        seen.set(k, r?.resolvedUp ?? null);
      }
      const upWon = seen.get(k);
      if (upWon == null) continue;
      l.won = upWon === (l.side === "U");
      l.net = Math.round((l.won ? 1 - l.price : -l.price) * CLIP * 100) / 100;
      changed = true;
    }
  }
  if (changed) saveJson(FILE, state);
}

export function pairlockSummary() {
  return PAIRLOCK.map((spec) => {
    const t = tot(spec.name);
    const done = t.left.filter((l) => l.won != null);
    const leftNet = Math.round(done.reduce((a, l) => a + (l.net ?? 0), 0) * 100) / 100;
    return { name: spec.name, windows: t.windows, pairs: t.pairs, pairNet: t.pairNet, leftovers: t.left.length, leftSettled: done.length, leftWon: done.filter((l) => l.won).length, leftNet, cuts: t.cuts ?? 0, cutNet: t.cutNet ?? 0, net: Math.round((t.pairNet + leftNet + (t.cutNet ?? 0)) * 100) / 100, rebateEst: t.rebate };
  });
}

export function startPairlock() {
  if (process.env.PAIRLOCK === "off") return null;
  bookFeed.onTrade(trade);
  let n = 0;
  let busy = false;
  return setInterval(() => {
    try {
      tick();
    } catch {
      /* paper only: never disturb the bot */
    }
    if (++n % 60 === 0 && !busy) {
      busy = true;
      settle().catch(() => undefined).finally(() => (busy = false));
    }
  }, 1000);
}
