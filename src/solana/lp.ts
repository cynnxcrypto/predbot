/**
 * PAPER ONLY: liquidity provision on a concentrated-liquidity pool (Orca SOL/USDC). No wallet, no keys, no transactions.
 *
 * Each rule pretends to put STAKE dollars into the pool in a price range of ±width around the current price and
 * re-centres the range when the price leaves it (straight away, after a wait, or never).
 *
 * What is real: the pool's price, its active liquidity and its fee counters (feeGrowthGlobal), read from the chain.
 * A position's fees are exactly (growth of the fee counter) × (its liquidity) while the price is inside its range,
 * which is how the pool pays real positions, so competing liquidity (including just-in-time bots) is already counted.
 * What is assumed: the cost of each re-centring (SWAP_COST on the half that must be swapped, plus TX_USD), and that
 * between two reads the price stayed inside the range if it was inside at both ends (half credit if at one end only,
 * nothing across a gap longer than MAX_GAP_MS).
 *
 * The honest score is "vs hold": the position plus fees minus costs, compared with simply holding the SOL and USDC
 * it started with. Dollars alone flatter the rule whenever SOL goes up.
 */
import { amounts, growth, open, price, rawLiquidity, value, type PoolSnap, type Range } from "./whirlpool.js";
import type { PoolDef } from "./pools.js";

export const STAKE = 200;
/** Cost of swapping, as a fraction: 4 bp pool fee on the cheapest route plus 2 bp price impact and spread. */
export const SWAP_COST = 0.0006;
/** Network and priority fees for one re-centring (close, swap, open), in dollars. */
export const TX_USD = 0.03;
export const MAX_GAP_MS = 5 * 60_000;
const KST = 9 * 3600_000;

export interface RuleDef {
  id: string;
  /** half-width of the range: 0.05 means 5% below to 5% above the price at opening */
  width: number;
  /** minutes the price must stay outside the range before re-centring; 0 = at once; null = never */
  wait: number | null;
  text: string;
}

const pct = (w: number) => `${+(w * 100).toFixed(1)}%`;
function rule(width: number, wait: number | null): RuleDef {
  const tag = wait === null ? "-hold" : wait > 0 ? `-wait${wait}` : "";
  const after = wait === null ? "never moves the range" : wait > 0 ? `re-centres after ${wait} min outside` : "re-centres as soon as the price leaves";
  return { id: `lp-w${String(width * 100).replace(".", "p")}${tag}`, width, wait, text: `Puts $${STAKE} in the pool ${pct(width)} either side of the price and ${after}.` };
}

export const RULES: RuleDef[] = [rule(0.01, 0), rule(0.025, 0), rule(0.05, 0), rule(0.1, 0), rule(0.025, 60), rule(0.05, 60), rule(0.05, 240), rule(0.1, null), rule(0.2, null)];

export interface Cycle {
  t0: number;
  t1: number;
  fees: number;
  cost: number;
  /** fees minus price loss minus cost, against holding what the range started with */
  net: number;
}

export interface Day {
  day: string;
  net: number;
  vsHold: number;
  fees: number;
}

export interface RuleState {
  id: string;
  pool: string;
  startedAt: number;
  range: Range;
  openedAt: number;
  openPrice: number;
  /** hold benchmark: what the very first position held */
  holdA: number;
  holdB: number;
  /** what the current range held when it opened */
  cycA: number;
  cycB: number;
  cycFees: number;
  fees: number;
  costs: number;
  outSince: number | null;
  inMs: number;
  totalMs: number;
  gapMs: number;
  cycles: number;
  cyclesWon: number;
  cyclesNet: number;
  recent: Cycle[];
  dayKey: string;
  dayNet0: number;
  dayVs0: number;
  dayFees0: number;
  days: Day[];
  lastPrice: number;
  lastT: number;
}

const dayOf = (t: number) => new Date(t + KST).toISOString().slice(0, 10);
const entryCost = (usd: number) => (usd / 2) * SWAP_COST + TX_USD;

export function start(def: RuleDef, pool: PoolDef, snap: PoolSnap): RuleState {
  const p = price(snap, pool.decA, pool.decB);
  const cost = entryCost(STAKE);
  const range = open(STAKE - cost, p, def.width);
  const { a, b } = amounts(range, p);
  return {
    id: def.id, pool: pool.key, startedAt: snap.t, range, openedAt: snap.t, openPrice: p,
    holdA: a, holdB: b, cycA: a, cycB: b, cycFees: 0, fees: 0, costs: cost, outSince: null,
    inMs: 0, totalMs: 0, gapMs: 0, cycles: 0, cyclesWon: 0, cyclesNet: 0, recent: [],
    dayKey: dayOf(snap.t), dayNet0: -cost, dayVs0: 0, dayFees0: 0, days: [], lastPrice: p, lastT: snap.t,
  };
}

/** Dollars made or lost so far, counting SOL's own price move. */
export function netUsd(s: RuleState, p: number) {
  return value(s.range, p) + s.fees - STAKE;
}

/** Dollars ahead of (or behind) simply holding the starting SOL and USDC. This is the score. */
export function vsHold(s: RuleState, p: number) {
  return value(s.range, p) + s.fees - (s.holdA * p + s.holdB);
}

/** Advance one rule from the previous pool read to the current one. */
export function step(s: RuleState, def: RuleDef, pool: PoolDef, prev: PoolSnap, now: PoolSnap) {
  const p0 = price(prev, pool.decA, pool.decB);
  const p = price(now, pool.decA, pool.decB);
  const dt = now.t - prev.t;
  if (dt <= 0) return;
  const inside = (x: number) => x > s.range.lo && x < s.range.hi;

  // close the KST day before today's numbers move
  const day = dayOf(now.t);
  if (day !== s.dayKey) {
    const n = netUsd(s, p0);
    const v = vsHold(s, p0);
    s.days.push({ day: s.dayKey, net: n - s.dayNet0, vsHold: v - s.dayVs0, fees: s.fees - s.dayFees0 });
    if (s.days.length > 60) s.days.shift();
    s.dayKey = day;
    s.dayNet0 = n;
    s.dayVs0 = v;
    s.dayFees0 = s.fees;
  }

  s.totalMs += dt;
  if (dt > MAX_GAP_MS) {
    s.gapMs += dt; // we did not see the path: earn nothing
  } else {
    const share = (inside(p0) ? 0.5 : 0) + (inside(p) ? 0.5 : 0);
    if (share > 0 && now.liquidity > 0n) {
      const mine = rawLiquidity(s.range.L, pool.decA, pool.decB);
      const dilute = Number(now.liquidity) / (Number(now.liquidity) + mine);
      const feeA = (growth(prev.feeGrowthA, now.feeGrowthA) * mine) / 10 ** pool.decA;
      const feeB = (growth(prev.feeGrowthB, now.feeGrowthB) * mine) / 10 ** pool.decB;
      const usd = (feeA * p + feeB) * share * dilute;
      // a counter jump this large means a bad read, not income
      if (usd >= 0 && usd < STAKE * 0.02) {
        s.fees += usd;
        s.cycFees += usd;
      }
      s.inMs += dt * share;
    }
  }

  if (inside(p)) s.outSince = null;
  else if (s.outSince === null) s.outSince = now.t;

  if (s.outSince !== null && def.wait !== null && now.t - s.outSince >= def.wait * 60_000) {
    const v = value(s.range, p);
    const cost = entryCost(v);
    const net = v + s.cycFees - cost - (s.cycA * p + s.cycB);
    s.cycles++;
    if (net > 0) s.cyclesWon++;
    s.cyclesNet += net;
    s.recent.push({ t0: s.openedAt, t1: now.t, fees: s.cycFees, cost, net });
    if (s.recent.length > 20) s.recent.shift();
    s.costs += cost;
    s.range = open(v - cost, p, def.width);
    const { a, b } = amounts(s.range, p);
    s.cycA = a;
    s.cycB = b;
    s.cycFees = 0;
    s.openedAt = now.t;
    s.openPrice = p;
    s.outSince = null;
  }
  s.lastPrice = p;
  s.lastT = now.t;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function summarize(s: RuleState, def: RuleDef, pool: PoolDef) {
  const p = s.lastPrice;
  const days = s.totalMs / 86_400_000;
  const seen = s.totalMs - s.gapMs;
  const daysWon = s.days.filter((d) => d.vsHold > 0).length;
  return {
    id: s.id, pool: pool.key, poolLabel: pool.label, text: def.text, stake: STAKE,
    startedAt: s.startedAt, days: r2(days),
    net: r2(netUsd(s, p)), vsHold: r2(vsHold(s, p)), fees: r2(s.fees), costs: r2(s.costs),
    feeAprPct: days > 0.02 ? r2((s.fees / STAKE / days) * 365 * 100) : null,
    inRangePct: seen > 0 ? r2((s.inMs / seen) * 100) : null,
    cycles: s.cycles, cyclesWon: s.cyclesWon, cyclesNet: r2(s.cyclesNet),
    closedDays: s.days.length, daysWon,
    todayVsHold: r2(vsHold(s, p) - s.dayVs0), todayFees: r2(s.fees - s.dayFees0),
    open: { lo: r2(s.range.lo), hi: r2(s.range.hi), price: r2(p), inRange: p > s.range.lo && p < s.range.hi, since: s.openedAt, value: r2(value(s.range, p)) },
    recent: s.recent.slice(-10).map((c) => ({ t0: c.t0, t1: c.t1, fees: r2(c.fees), cost: r2(c.cost), net: r2(c.net) })),
    dayRows: s.days.slice(-14).map((d) => ({ day: d.day, net: r2(d.net), vsHold: r2(d.vsHold), fees: r2(d.fees) })),
  };
}
