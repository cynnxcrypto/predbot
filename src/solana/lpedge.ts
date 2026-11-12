/**
 * PAPER ONLY: does a pool pay its liquidity providers more than the price moves cost them? Read only, nothing sent.
 *
 * Why (12 Nov 2026): the range rules in lp.ts are scored by where the price happens to end, so one calm day can put
 * thirteen of eighteen "ahead of holding" by luck. This reading does not depend on where the price ends:
 *
 *   fee   what the pool's fee counters paid one unit of liquidity (exact, from the chain, the same counters that
 *         pay real positions), as a fraction of the value that liquidity stands for;
 *   cost  what the price moves cost that same unit of liquidity against simply holding its two tokens: for a move
 *         from p0 to p it is (sqrt(p/p0) - 1)^2, which is about a quarter of the squared move. It is summed over
 *         steps of 30 seconds, 5 minutes and 1 hour: the short steps also count the back-and-forth that earns the
 *         pool its fees and costs nothing in the end, so the 1 hour figure is the fair one and 30 seconds is the
 *         hardest.
 *
 * ratio = fee / cost. Above 1 the pool paid more than the price cost; under 1 no range rule in that pool can win
 * over time, whatever its width, because a narrower range multiplies fee and cost alike and adds re-centring
 * costs. Both are shown as the percent a position in a reference range (REF_VOLATILE, or REF_PEGGED for staked
 * SOL) would have earned and lost, so the numbers read like the rules' own.
 *
 * It also sorts every hour by how far the price moved in the hour BEFORE it (known in advance), to see whether
 * providing liquidity only after a calm hour pays: a rule that would be active most of the day and needs no speed.
 * A day or a bucket means little; weeks are needed. Nothing here is a result with money.
 */
import type { PoolDef } from "./pools.js";
import { growth } from "./whirlpool.js";

export const REF_VOLATILE = 0.05;
export const REF_PEGGED = 0.005;
export const EDGE_GAP_MS = 5 * 60_000;
/** most one read may pay a unit of liquidity (a thousand times a busy half minute); more is a bad read */
export const MAX_FEE_STEP = 1e-3;
/** previous hour's move, in percent: under 0.25, to 0.5, to 1, to 2, above */
export const CALM_EDGES = [0.25, 0.5, 1, 2];
export const CALM_LABELS = ["under 0.25%", "0.25 to 0.5%", "0.5 to 1%", "1 to 2%", "over 2%"];
const KST = 9 * 3600_000;
const dayOf = (t: number) => new Date(t + KST).toISOString().slice(0, 10);

export interface Read {
  t: number;
  /** whole tokens of B for one of A */
  p: number;
  fgA: bigint;
  fgB: bigint;
}

/** Sums per unit of liquidity value (L x sqrt(price)); ms = time covered by reads close enough to count. */
export interface Sums {
  fee: number;
  c30: number;
  c5: number;
  c60: number;
  ms: number;
}
export interface Bucket {
  n: number;
  fee: number;
  c5: number;
  c60: number;
}
export interface EdgeState {
  pool: string;
  startedAt: number;
  a5: { t: number; p: number } | null;
  /** the running hour: where it began, the sums at that moment, and the size of the hour before it (null = unknown) */
  a60: { t: number; p: number; fee: number; c5: number; prevAbs: number | null } | null;
  dayKey: string;
  day: Sums;
  days: (Sums & { day: string })[];
  all: Sums;
  calm: Bucket[];
}

const zero = (): Sums => ({ fee: 0, c30: 0, c5: 0, c60: 0, ms: 0 });
const cost = (p0: number, p: number) => (Math.sqrt(p / p0) - 1) ** 2;

export function edgeStart(pool: PoolDef, t: number): EdgeState {
  return { pool: pool.key, startedAt: t, a5: null, a60: null, dayKey: dayOf(t), day: zero(), days: [], all: zero(), calm: CALM_LABELS.map(() => ({ n: 0, fee: 0, c5: 0, c60: 0 })) };
}

/** One step from the previous read to this one. A gap longer than EDGE_GAP_MS counts for nothing and restarts the clocks. */
export function edgeStep(e: EdgeState, pool: PoolDef, prev: Read, now: Read) {
  const dt = now.t - prev.t;
  if (dt <= 0 || !(prev.p > 0) || !(now.p > 0)) return;
  const day = dayOf(now.t);
  if (day !== e.dayKey) {
    if (e.day.ms > 0) e.days.push({ day: e.dayKey, ...e.day });
    if (e.days.length > 60) e.days.shift();
    e.dayKey = day;
    e.day = zero();
  }
  if (dt > EDGE_GAP_MS) {
    e.a5 = null;
    e.a60 = null;
    return;
  }
  const add = (k: "fee" | "c30" | "c5" | "c60", x: number) => {
    e.day[k] += x;
    e.all[k] += x;
  };
  // fee value per unit of whole-token liquidity, in token B, over the value that liquidity stands for (sqrt(p))
  const scale = 10 ** ((pool.decA + pool.decB) / 2);
  const fee = (((growth(prev.fgA, now.fgA) * now.p) / 10 ** pool.decA + growth(prev.fgB, now.fgB) / 10 ** pool.decB) * scale) / Math.sqrt(now.p);
  const paid = fee >= 0 && fee < MAX_FEE_STEP ? fee : 0; // a jump this large is a bad read, not income
  add("fee", paid);
  add("c30", cost(prev.p, now.p));
  e.day.ms += dt;
  e.all.ms += dt;
  if (!e.a5) e.a5 = { t: prev.t, p: prev.p };
  if (now.t - e.a5.t >= 5 * 60_000) {
    add("c5", cost(e.a5.p, now.p));
    e.a5 = { t: now.t, p: now.p };
  }
  if (!e.a60) e.a60 = { t: prev.t, p: prev.p, fee: e.all.fee - paid, c5: e.all.c5, prevAbs: null };
  if (now.t - e.a60.t >= 3600_000) {
    const c60 = cost(e.a60.p, now.p);
    add("c60", c60);
    const moved = Math.abs(Math.log(now.p / e.a60.p)) * 100;
    const before = e.a60.prevAbs;
    if (before !== null) {
      const i = CALM_EDGES.findIndex((x) => before < x);
      const b = e.calm[i < 0 ? CALM_EDGES.length : i];
      b.n++;
      b.fee += e.all.fee - e.a60.fee;
      b.c5 += e.all.c5 - e.a60.c5;
      b.c60 += c60;
    }
    e.a60 = { t: now.t, p: now.p, fee: e.all.fee, c5: e.all.c5, prevAbs: moved };
  }
}

/** value of one unit of liquidity in a range of +-w, as a share of L x sqrt(p) */
const share = (w: number) => 2 - 1 / Math.sqrt(1 + w) - Math.sqrt(1 - w);
const sig = (x: number) => +x.toPrecision(4);
const ratio = (a: number, b: number) => (b > 0 ? +(a / b).toFixed(2) : null);

function line(s: Sums, k: number) {
  return {
    hours: +(s.ms / 3600_000).toFixed(1),
    feePct: sig(s.fee * k), cost1hPct: sig(s.c60 * k), cost5mPct: sig(s.c5 * k), cost30sPct: sig(s.c30 * k),
    ratio1h: ratio(s.fee, s.c60), ratio5m: ratio(s.fee, s.c5), ratio30s: ratio(s.fee, s.c30),
  };
}

export function edgeSummary(e: EdgeState, pool: PoolDef) {
  const ref = pool.kind === "pegged" ? REF_PEGGED : REF_VOLATILE;
  const k = 100 / share(ref);
  return {
    pool: pool.key, label: pool.label, refRangePct: ref * 100, since: e.startedAt,
    all: line(e.all, k),
    today: line(e.day, k),
    days: e.days.slice(-10).map((d) => ({ day: d.day, ...line(d, k) })),
    afterAnHourThatMoved: e.calm.map((b, i) => ({ moved: CALM_LABELS[i], hours: b.n, feePct: sig(b.fee * k), cost1hPct: sig(b.c60 * k), cost5mPct: sig(b.c5 * k), ratio1h: ratio(b.fee, b.c60), ratio5m: ratio(b.fee, b.c5) })),
  };
}

export const EDGE_NOTE =
  "Paper only. For each pool: feePct is what its fee counters paid a position in the reference range (5% either side; 0.5% for staked SOL pairs), costPct what the price moves cost that position against holding its two tokens, summed over steps of 1 hour, 5 minutes and 30 seconds (1 hour is the fair figure, 30 seconds the hardest). ratio = fee / cost: above 1 the pool paid more than the price cost, under 1 no range rule in that pool can win over time. afterAnHourThatMoved sorts each hour by the size of the move in the hour before it, to see whether providing liquidity only after a calm hour pays. One day or one bucket means little: weeks are needed, and re-centring costs come on top.";
