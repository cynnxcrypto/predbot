/**
 * PAPER ONLY: fees against price cost in Meteora's SOL/USDC pools (DLMM). Read only, no keys, nothing sent.
 *
 * Why (12 Nov 2026): fee earning is the one idea that is active all day and needs no speed, and on Orca the first
 * day's fees covered about 90% of what the price moves cost. Meteora's pools charge a fee that RISES when the price
 * moves fast, which is exactly when providers lose, so they may pay better. This measures it the same way as
 * lpedge.ts does for Orca: what the pool's own fee counters paid one unit of liquidity, against what the price moves
 * cost that unit versus holding. No range rule is simulated here; the ratio says whether one could win at all.
 *
 * How: the pools are found once (addresses derived in dlmm.ts, the chain asked which exist, the DLMM_KEEP with the
 * most money in them that traded in the last day are kept, saved in solana-dlmm.json). Once a minute one call reads
 * each pool and the bin arrays around its active bin; each bin's fee counters are compared with the last look.
 * A position holding the same value in every bin is paid sum(bin fee / bin value) per unit of that value; turned
 * into the unit lpedge.ts uses (liquidity value per price step, times two) that is binStep/2 times the sum.
 *
 * Honest limits: this arithmetic has not been checked against a real position's payout. The summary carries the
 * figures to judge it by: shareValue (must be about 1), the pool's fees in dollars (to compare with what Meteora
 * shows), and partialSteps (the price ran past the bins that were read: those fees are missing, so the fee side
 * can only be too low, never too high). The first minute after every restart is not counted.
 * SOLANA_DLMM=off turns it off.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../config.js";
import { arrayIndex, binArrayAddress, binFees, binPrice, decodeBinArray, decodeLbPair, DLMM_PROGRAM, feeRate, lbPairAddress, type Bin, type LbPair, type Mark } from "./dlmm.js";
import { edgeAdd, edgeSkip, edgeStart, edgeSummary, type EdgeState } from "./lpedge.js";
import type { Account, Reader } from "./lpwide.js";
import { pubkeyBytes } from "./pda.js";
import { SOL, USDC } from "./pools.js";

export const DLMM_VERSION = "dlmm-v1";
export const DLMM_KEEP = 2;
const STEPS_OLD = [1, 2, 4, 5, 8, 10, 15, 16, 20, 25, 30, 40, 50, 60, 80, 100];
const STEPS_NEW = [1, 2, 4, 5, 8, 10, 15, 20, 25];
const FACTORS = [5000, 8000, 10000, 12500, 15000, 20000];
const MIN_TVL_USD = 10_000;
const RETRY_MS = 10 * 60_000;
const FILE = () => join(DATA, "solana-dlmm.json");
const on = () => process.env.SOLANA_DLMM !== "off";
const KST = 9 * 3600_000;
const dayOf = (t: number) => new Date(t + KST).toISOString().slice(0, 10);

export interface DlmmPool {
  key: string;
  label: string;
  address: string;
  binStep: number;
  mintX: string;
  mintY: string;
  decX: number;
  decY: number;
  /** dollars in the pool when it was chosen */
  tvlUsd: number;
}
export interface DlmmFound {
  version: string;
  at: number;
  /** how many SOL/USDC pools the chain has among the addresses tried */
  seen: number;
  pools: DlmmPool[];
}

interface Candidate {
  address: string;
  binStep: number;
  baseFactor?: number;
}
let memo: Candidate[] | null = null;
export function dlmmCandidates(): Candidate[] {
  memo ??= [
    ...STEPS_OLD.map((binStep) => ({ binStep, address: lbPairAddress(SOL, USDC, binStep) })),
    ...STEPS_NEW.flatMap((binStep) => FACTORS.map((baseFactor) => ({ binStep, baseFactor, address: lbPairAddress(SOL, USDC, binStep, baseFactor) }))),
  ];
  return memo;
}

const dec = (mint: string) => (mint === SOL ? 9 : 6);
/** amount in a token account, if it is the account of that mint (SPL layout: mint at 0, amount at 64) */
function tokenAmount(acc: Account | null, mint: string): bigint | null {
  if (!acc || acc.data.length < 72) return null;
  return acc.data.subarray(0, 32).equals(pubkeyBytes(mint)) ? acc.data.readBigUInt64LE(64) : null;
}

function poolOf(acc: Account | null, binStep: number): LbPair | null {
  if (!acc || acc.owner !== DLMM_PROGRAM) return null;
  try {
    const p = decodeLbPair(acc.data);
    const sides = [p.mintX, p.mintY].sort().join();
    return sides === [SOL, USDC].sort().join() && p.binStep === binStep ? p : null;
  } catch {
    return null;
  }
}

/** One look at the chain. Throws when a read fails, so nothing half-found is saved. */
export async function discoverDlmm(read: Reader, now = Date.now()): Promise<DlmmFound> {
  const cands = dlmmCandidates();
  const accs = await read(cands.map((c) => c.address));
  if (accs.length !== cands.length) throw new Error("accounts missing from the answer");
  const live = cands.flatMap((c, i) => {
    const pair = poolOf(accs[i], c.binStep);
    return pair ? [{ c, pair }] : [];
  });
  const reserves = live.length ? await read(live.flatMap((x) => [x.pair.reserveX, x.pair.reserveY])) : [];
  if (reserves.length !== live.length * 2) throw new Error("accounts missing from the answer");
  const pools = live
    .flatMap(({ c, pair }, i) => {
      const x = tokenAmount(reserves[2 * i], pair.mintX);
      const y = tokenAmount(reserves[2 * i + 1], pair.mintY);
      if (x === null || y === null || now / 1000 - pair.lastSwapSec > 86_400) return [];
      const decX = dec(pair.mintX);
      const decY = dec(pair.mintY);
      const p = binPrice(pair.binStep, pair.activeId, decX, decY);
      const tvlUsd = pair.mintX === SOL ? (Number(x) / 10 ** decX) * p + Number(y) / 10 ** decY : Number(x) / 10 ** decX + (Number(y) / 10 ** decY) / p;
      if (!(tvlUsd >= MIN_TVL_USD)) return [];
      const base = +((pair.baseFactor * pair.binStep * 10) / 1e7).toFixed(3);
      const pool: DlmmPool = {
        key: `meteora-sol-usdc-bs${c.binStep}${c.baseFactor === undefined ? "" : `-f${c.baseFactor}`}`, label: `Meteora SOL/USDC ${base}% (bin step ${c.binStep})`, address: c.address,
        binStep: c.binStep, mintX: pair.mintX, mintY: pair.mintY, decX, decY, tvlUsd: Math.round(tvlUsd),
      };
      return [pool];
    })
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, DLMM_KEEP);
  return { version: DLMM_VERSION, at: now, seen: live.length, pools };
}

export function validDlmmFound(x: unknown): DlmmFound | null {
  const f = x as DlmmFound | null;
  if (!f || f.version !== DLMM_VERSION || !Array.isArray(f.pools)) return null;
  const known = new Map(dlmmCandidates().map((c) => [c.address, c]));
  return f.pools.every((p) => known.get(p?.address)?.binStep === p.binStep && [p.mintX, p.mintY].sort().join() === [SOL, USDC].sort().join()) ? f : null;
}

interface Saved {
  found: DlmmFound | null;
  edges: EdgeState[];
  paid: Record<string, { day: string; today: number; all: number }>;
}
interface Last {
  t: number;
  p: number;
  activeId: number;
  /** the bins around the active one were read at that look, so the next look can be compared with it */
  marked: boolean;
}

let found: DlmmFound | null = null;
let edges: EdgeState[] = [];
let paid: Saved["paid"] = {};
let loaded = false;
const marks = new Map<string, Map<number, Mark>>();
const last = new Map<string, Last>();
const info = new Map<string, { usdPerSol: number; feeRatePct: number; lastRead: number; problem: string }>();
const shareValues: number[] = [];
const arrayAddr = new Map<string, string>();
const health = { reads: 0, errors: 0, lastError: "", tries: 0, nextTry: 0, steps: 0, partialSteps: 0, badArrays: 0 };

function load() {
  loaded = true;
  try {
    const s = JSON.parse(readFileSync(FILE(), "utf8")) as Saved;
    found = validDlmmFound(s.found);
    edges = found ? (s.edges ?? []) : [];
    paid = found ? (s.paid ?? {}) : {};
  } catch {
    found = null;
    edges = [];
    paid = {};
  }
}
function save() {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(FILE() + ".tmp", JSON.stringify({ found, edges, paid } satisfies Saved));
  renameSync(FILE() + ".tmp", FILE());
}

const radius = (binStep: number) => (binStep >= 4 ? 1 : 2);
function addrOf(pool: DlmmPool, index: number) {
  const k = `${pool.key}:${index}`;
  let a = arrayAddr.get(k);
  if (!a) {
    if (arrayAddr.size > 500) arrayAddr.clear();
    a = binArrayAddress(pool.address, index);
    arrayAddr.set(k, a);
  }
  return a;
}

/** One look. Called about once a minute by the fee test's runner with its own reader (public RPC). */
export async function dlmmTick(read: Reader, now = Date.now()) {
  if (!on()) return;
  if (!loaded) load();
  if (!found) {
    if (now < health.nextTry) return;
    health.nextTry = now + RETRY_MS;
    health.tries++;
    try {
      found = await discoverDlmm(read, now);
      health.lastError = "";
      save();
    } catch {
      health.lastError = "the pools could not be looked up on the chain yet; it is tried again every 10 minutes";
    }
    return;
  }
  if (!found.pools.length) return;
  const plan = found.pools.map((pool) => {
    const l = last.get(pool.key);
    const mid = l ? arrayIndex(l.activeId) : 0;
    const r = radius(pool.binStep);
    return { pool, arrays: l ? Array.from({ length: 2 * r + 1 }, (_, i) => mid - r + i) : [] };
  });
  const req = plan.flatMap(({ pool, arrays }) => [pool.address, ...arrays.map((i) => addrOf(pool, i))]);
  let accs: (Account | null)[];
  try {
    accs = await read(req);
    if (accs.length !== req.length) throw new Error("short");
  } catch {
    health.errors++;
    health.lastError = "the pools could not be read";
    return;
  }
  health.reads++;
  health.lastError = "";
  let k = 0;
  for (const { pool, arrays } of plan) {
    const acc = accs[k++];
    const arrAccs = arrays.map(() => accs[k++]);
    const pair = poolOf(acc, pool.binStep);
    if (!pair || pair.mintX !== pool.mintX) {
      info.set(pool.key, { ...(info.get(pool.key) ?? { usdPerSol: 0, feeRatePct: 0, lastRead: 0 }), problem: "pool account could not be read" });
      last.delete(pool.key);
      continue;
    }
    const p = binPrice(pool.binStep, pair.activeId, pool.decX, pool.decY);
    const usdPerSol = pool.mintX === SOL ? p : 1 / p;
    const bins: Bin[] = [];
    let gotActive = false;
    arrays.forEach((index, j) => {
      const a = arrAccs[j];
      if (!a) return; // an array nobody has put liquidity in does not exist: normal
      try {
        if (a.owner !== DLMM_PROGRAM) throw new Error("owner");
        const d = decodeBinArray(a.data, pool.address);
        if (d.index !== index) throw new Error("index");
        bins.push(...d.bins);
        if (index === arrayIndex(pair.activeId)) gotActive = true;
      } catch {
        health.badArrays++;
      }
    });
    let m = marks.get(pool.key);
    if (!m) marks.set(pool.key, (m = new Map()));
    const l = last.get(pool.key);
    // did the price run through bins that had no mark? then their fees over this stretch cannot be counted
    let partial = false;
    if (l) for (let id = Math.min(l.activeId, pair.activeId); id <= Math.max(l.activeId, pair.activeId); id++) if (!m.has(id)) partial = true;
    const f = binFees(m, bins);
    // marks further away than the arrays just read are dropped: an old mark would book hours of fees into one minute
    if (arrays.length) {
      const lo = (arrays[0] - 1) * 70;
      const hi = (arrays[arrays.length - 1] + 2) * 70;
      for (const id of m.keys()) if (id < lo || id >= hi) m.delete(id);
    }
    let e = edges.find((x) => x.pool === pool.key);
    if (!e) edges.push((e = edgeStart(pool, now)));
    if (l?.marked && gotActive) {
      edgeAdd(e, l, { t: now, p }, (Math.log(1 + pool.binStep / 1e4) / 2) * f.r);
      health.steps++;
      if (partial) health.partialSteps++;
      const usd = pool.mintY === USDC ? f.paidY / 10 ** pool.decY : (f.paidY / 10 ** pool.decY) * usdPerSol;
      const day = dayOf(now);
      const pd = (paid[pool.key] ??= { day, today: 0, all: 0 });
      if (pd.day !== day) Object.assign(pd, { day, today: 0 });
      if (now - l.t <= 5 * 60_000 && usd >= 0 && usd < 1e7) {
        pd.today += usd;
        pd.all += usd;
      }
      for (const v of f.shareValue) {
        shareValues.push(v);
        if (shareValues.length > 400) shareValues.shift();
      }
    } else edgeSkip(e);
    last.set(pool.key, { t: now, p, activeId: pair.activeId, marked: gotActive });
    info.set(pool.key, { usdPerSol: +usdPerSol.toFixed(3), feeRatePct: +(feeRate(pair) * 100).toFixed(4), lastRead: now, problem: gotActive || !arrays.length ? "" : "the active bin's array could not be read" });
  }
  save();
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

export function dlmmSummary() {
  if (!on()) return { mode: "paper", on: false };
  const sv = median(shareValues);
  return {
    mode: "paper",
    on: true,
    note: "Paper only, nothing is sent. Meteora SOL/USDC pools, whose fee rises when the price moves fast. Same reading as solana.edge: feePct is what the pool's fee counters paid a position spread 5% either side of the price, costPct what the price moves cost it against holding (1 hour steps are the fair figure), ratio = fee / cost; above 1 the pool paid more than the price cost. NOT YET CHECKED against a real position's payout: judge it by check.shareValue (must be about 1), poolFeesUsd (compare with what Meteora shows for the pool) and partialSteps (the price ran past the bins that were read, so some fees are missing and the fee side is too low, never too high). Days are needed.",
    found: !!found,
    foundAt: found?.at ?? null,
    poolsOnChain: found?.seen ?? null,
    health: { reads: health.reads, errors: health.errors, lastError: health.lastError, steps: health.steps, partialSteps: health.partialSteps, badArrays: health.badArrays },
    check: { shareValue: sv === null ? null : +sv.toPrecision(4), samples: shareValues.length },
    pools: (found?.pools ?? []).map((pool) => {
      const e = edges.find((x) => x.pool === pool.key);
      const i = info.get(pool.key);
      const pd = paid[pool.key];
      return {
        ...(e ? edgeSummary(e, pool) : { pool: pool.key, label: pool.label }),
        binStep: pool.binStep, tvlUsdWhenChosen: pool.tvlUsd, usdPerSol: i?.usdPerSol ?? null, feeRatePctNow: i?.feeRatePct ?? null, lastRead: i?.lastRead ?? null, problem: i?.problem ?? "",
        poolFeesUsd: pd ? { today: Math.round(pd.day === dayOf(Date.now()) ? pd.today : 0), all: Math.round(pd.all) } : null,
      };
    }),
  };
}

export const _dlmmTest = {
  reset() {
    found = null;
    edges = [];
    paid = {};
    loaded = true;
    marks.clear();
    last.clear();
    info.clear();
    shareValues.length = 0;
    Object.assign(health, { reads: 0, errors: 0, lastError: "", tries: 0, nextTry: 0, steps: 0, partialSteps: 0, badArrays: 0 });
  },
  /** as after a restart: memory gone, the saved file read again at the next look */
  restart() {
    loaded = false;
    marks.clear();
    last.clear();
    info.clear();
    health.nextTry = 0;
  },
  state: () => ({ found, edges, paid, health, last, marks }),
};
