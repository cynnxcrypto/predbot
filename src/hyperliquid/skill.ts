/**
 * Skill or luck, PAPER ONLY (enrique, 22 Nov 2026 22:46-22:50 KST: "how can we do better at scanning and finding the
 * best traders", then "yeah" to building a ranking next to the current one). Nothing here picks, sizes or cuts a real
 * trader: it is a second ranking shown in the status beside the live bar, so the two can be compared before any rule
 * changes (that needs his push words in MAIN's thread).
 *
 * Three tests on a trader's own closed positions (src/solana/buckets.ts hlTrips, each a result over its largest size):
 *  1. BEAT THE MARKET: each position's result minus what the same side held over the same hours on BTC made. The
 *     20 Nov assessment found about 57% of our Hyperliquid gain was market direction (shorts in a falling market).
 *     BTC at beta 1 is a floor: small coins move more than BTC, so some market move is still left in the excess.
 *  2. A REAL STATISTICAL BAR instead of "half won and ahead": the average excess result must be 2+ standard errors
 *     above zero (t >= 2), and the trader must still be ahead without its best 3 positions (one lucky ticket is
 *     not a record).
 *  3. CONSISTENCY: the window is cut into 3 equal periods; ahead (on excess) in at least 2 of them, each with a
 *     position closed in it.
 */
export const SKILL_MIN_N = 20;
export const SKILL_MIN_T = 2;
export const SKILL_PERIODS = 3;
export const SKILL_MIN_PERIODS_AHEAD = 2;
/**
 * PROVEN TIER (25 Nov 2026, enrique: "push proven tier: 2.5+ standard errors not cut until 20+ real copies behind, bilberry back to real"):
 * a trader that passes the skill test at provenT+ standard errors is not cut by the short-streak rules; it goes back to
 * paper only when it has PROVEN_CUT_N+ real copies and is behind on them (all of its real copies, through any old cut).
 * The wallet-wide loss caps still hold.
 */
export const PROVEN_CUT_N = 20;
/** Is a proven trader's own real record bad enough to cut it: PROVEN_CUT_N+ real copies and behind. */
export const provenCut = (n: number, net: number) => n >= PROVEN_CUT_N && net < 0;

/** One closed position: [closed at, result, opened at?, side (+1 long, -1 short)?, coin?]. Older rows have only 2. */
export type Trip = [number, number, number?, number?, string?];
/** Hourly BTC closes, [hour start ms, close], sorted. */
export type Candles = [number, number][];

/** BTC close at or before t (null when t is before the series or the series is empty). */
export function priceAt(c: Candles, t: number): number | null {
  let lo = 0;
  let hi = c.length - 1;
  if (hi < 0 || t < c[0][0]) return null;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (c[m][0] <= t) lo = m;
    else hi = m - 1;
  }
  // a series that stopped more than 2 hours before t does not price it
  return t - c[lo][0] > 3 * 3_600_000 ? null : c[lo][1];
}

/** A position's result over the same side held on BTC for the same hours (null: no side, open time or prices). */
export function excessOf(x: Trip, btc: Candles): number | null {
  const [close, pct, open, dir] = x;
  if (open == null || dir == null || !(dir === 1 || dir === -1)) return null;
  const a = priceAt(btc, open);
  const b = priceAt(btc, close);
  if (!a || !b) return null;
  return pct - dir * (b / a - 1);
}

const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
/** Average / standard error (0 for under 2 values or no spread). */
export function tStat(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(xs.length)) : 0;
}
/** Sum without the k best. */
export const sumWithoutBest = (xs: number[], k = 3) => [...xs].sort((a, b) => b - a).slice(k).reduce((a, x) => a + x, 0);

export interface Skill {
  n: number;
  /** how many of them could be set against BTC (side and open time known, prices there) */
  nEx: number;
  won: number;
  avgPct: number;
  t: number;
  exAvgPct: number | null;
  exT: number | null;
  /** share of the raw result that the BTC move explains (null: no excess known or raw sum not above 0) */
  marketShare: number | null;
  noBest3Pct: number;
  periodsAhead: number;
  pass: boolean;
  why: string;
}

const r = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function skillOf(trips: Trip[], btc: Candles, sinceMs: number, now: number): Skill {
  const xs = trips.filter((x) => x[0] > sinceMs && x[0] <= now);
  const raw = xs.map((x) => x[1]);
  const ex = xs.map((x) => excessOf(x, btc));
  const exKnown = ex.filter((x): x is number => x != null);
  // the tests run on the excess where it is known for (nearly) all positions, else on the raw results
  const useEx = exKnown.length >= Math.max(SKILL_MIN_N, 0.8 * xs.length);
  const val = useEx ? ex.map((e, i) => e ?? raw[i]) : raw;
  const t = tStat(raw);
  const exT = useEx ? tStat(val) : null;
  const noBest3 = sumWithoutBest(val);
  const span = (now - sinceMs) / SKILL_PERIODS;
  let periodsAhead = 0;
  for (let p = 0; p < SKILL_PERIODS; p++) {
    const ps = xs.map((x, i) => [x[0], val[i]] as const).filter(([at]) => at > sinceMs + p * span && at <= sinceMs + (p + 1) * span);
    if (ps.length && ps.reduce((a, x) => a + x[1], 0) > 0) periodsAhead++;
  }
  const rawSum = raw.reduce((a, x) => a + x, 0);
  const exSum = useEx ? val.reduce((a, x) => a + x, 0) : null;
  const whyNot =
    xs.length < SKILL_MIN_N ? `under ${SKILL_MIN_N} closed`
    : !useEx ? "BTC prices or sides missing"
    : exT! < SKILL_MIN_T ? `beats BTC by under ${SKILL_MIN_T} standard errors`
    : !(noBest3 > 0) ? "behind without its best 3"
    : periodsAhead < SKILL_MIN_PERIODS_AHEAD ? `ahead in under ${SKILL_MIN_PERIODS_AHEAD} of ${SKILL_PERIODS} periods`
    : "";
  return {
    n: xs.length,
    nEx: exKnown.length,
    won: raw.filter((x) => x > 0).length,
    avgPct: xs.length ? r(mean(raw) * 100) : 0,
    t: r(t),
    exAvgPct: useEx ? r(mean(val) * 100) : null,
    exT: exT == null ? null : r(exT),
    marketShare: exSum != null && rawSum > 0 ? r((rawSum - exSum) / rawSum) : null,
    noBest3Pct: r(noBest3 * 100),
    periodsAhead,
    pass: !whyNot,
    why: whyNot || "passes",
  };
}

/** Hyperliquid candleSnapshot answer -> [open ms, close], sorted. */
export function parseCandles(j: unknown): Candles {
  if (!Array.isArray(j)) return [];
  return (j as Record<string, unknown>[])
    .map((x) => [Number(x?.t), Number(x?.c)] as [number, number])
    .filter(([t, c]) => t > 0 && c > 0)
    .sort((a, b) => a[0] - b[0]);
}

/** Median and 90th percentile of what our entry gave away against the trader's, in % (positive = we paid worse). */
export function gapStats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => (s.length ? r(s[Math.min(s.length - 1, Math.floor(q * s.length))], 3) : null);
  return { n: s.length, medianPct: at(0.5), p90Pct: at(0.9), worseOver1PctShare: s.length ? r(s.filter((x) => x > 1).length / s.length) : null };
}
/** Our entry against the trader's average entry, in %, positive when ours is worse for the side. */
export const entryGapPct = (dir: number, ours: number, theirs: number) => (theirs > 0 && ours > 0 ? r(dir * (ours / theirs - 1) * 100, 4) : null);
