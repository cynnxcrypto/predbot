/**
 * PAPER ONLY runner for the Solana liquidity rules (src/solana/lp.ts). Reads pool accounts from a Solana RPC,
 * never signs or sends anything. SOLANA=off disables it. SOLANA_RPC overrides the RPC address (keep any key in the
 * server's environment, never in the repo).
 *
 * Files in the data folder: solana-lp.json (state), solana-lp-summary.json (what the dashboard and status read),
 * solana/<pool>-<KST day>.jsonl (one line per read: [t, price, liquidity, feeGrowthA, feeGrowthB], kept 60 days, so
 * any other range rule can be replayed later against the same real fees).
 *
 * The wider test (12 Nov 2026, summary key "wide"): the same rules on more pairs (SOL/USDT, staked SOL against SOL,
 * BTC against SOL), so 30 days of evidence cover more than one pair. Its pools are found on the chain once
 * (lpwide.ts) and kept in solana-lp-pools.json. They are read in the same call as the two SOL/USDC pools; a pool
 * that cannot be read is skipped and named, and never stops the others. The SOL/USDC rules, their state and their
 * summary fields are untouched. SOLANA_LP_WIDE=off turns the wider part off.
 *
 * Summary key "edge" (lpedge.ts): for every pool followed, what its fee counters paid against what the price moves
 * cost, which does not depend on where the price happens to end. It starts from the reads already on disk.
 * Summary key "meteora" (dlmmrun.ts): the same reading for Meteora's SOL/USDC pools, once a minute.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA } from "../config.js";
import { PEG_RULES, RULES, rulesFor, start, step, summarize, type RuleState } from "./lp.js";
import { dlmmSummary, dlmmTick } from "./dlmmrun.js";
import { EDGE_NOTE, edgeStart, edgeStep, edgeSummary, type EdgeState, type Read } from "./lpedge.js";
import { discover, usdOfB, validFound, type Account, type Found } from "./lpwide.js";
import { POOLS, type PoolDef } from "./pools.js";
import { decodeWhirlpool, price, type PoolSnap } from "./whirlpool.js";

const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const TICK_MS = 30_000;
const STATE = () => join(DATA, "solana-lp.json");
const SUMMARY = () => join(DATA, "solana-lp-summary.json");
const DIR = () => join(DATA, "solana");
const WIDE_FILE = () => join(DATA, "solana-lp-pools.json");
const wideOn = () => process.env.SOLANA_LP_WIDE !== "off";
const WIDE_RETRY_MS = 10 * 60_000;

interface Saved {
  rules: RuleState[];
  wide?: RuleState[];
  edge?: EdgeState[];
  snaps: Record<string, Record<string, string | number>>;
}

const big = (k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
function reviveSnap(o: Record<string, string | number>): PoolSnap {
  return { ...(o as unknown as PoolSnap), liquidity: BigInt(o.liquidity), sqrtPrice: BigInt(o.sqrtPrice), feeGrowthA: BigInt(o.feeGrowthA), feeGrowthB: BigInt(o.feeGrowthB) };
}

function save(file: string, body: unknown) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(body, big));
  renameSync(file + ".tmp", file);
}

/** Accounts as the chain has them now (null where there is none), up to 100 in one call. */
export async function readAccounts(addresses: string[], rpc = RPC, fetcher: typeof fetch = fetch): Promise<(Account | null)[]> {
  const res = await fetcher(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [addresses, { encoding: "base64", commitment: "confirmed" }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  const j = (await res.json()) as { error?: { message: string }; result?: { value: ({ data: [string, string]; owner?: string } | null)[] } };
  if (j.error || !j.result) throw new Error(`rpc: ${j.error?.message ?? "no result"}`);
  return j.result.value.map((acc) => (acc ? { data: Buffer.from(acc.data[0], "base64"), owner: acc.owner ?? "" } : null));
}

function snapOf(def: PoolDef, acc: Account | null | undefined, t: number): PoolSnap {
  if (!acc) throw new Error(`${def.key}: account not found`);
  const snap = decodeWhirlpool(acc.data, t);
  if (snap.mintA !== def.mintA || snap.mintB !== def.mintB) throw new Error(`${def.key}: not the expected pool (mints differ)`);
  return snap;
}

export async function readPools(pools: PoolDef[], rpc = RPC, fetcher: typeof fetch = fetch): Promise<Map<string, PoolSnap>> {
  const accs = await readAccounts(pools.map((p) => p.address), rpc, fetcher);
  const t = Date.now();
  return new Map(pools.map((def, i) => [def.key, snapOf(def, accs[i], t)]));
}

let rules: RuleState[] = [];
let wideRules: RuleState[] = [];
let edges: EdgeState[] = [];
let found: Found | null = null;
const snaps = new Map<string, PoolSnap>();
const health = { startedAt: 0, lastOk: 0, reads: 0, errors: 0, lastError: "" };
/** the wider test: bad = pools that could not be read at the last tick, in our own fixed words */
const wide = { tries: 0, nextTry: 0, error: "", bad: {} as Record<string, string>, ticks: 0 };
let loaded = false;

function load() {
  loaded = true;
  try {
    const s = JSON.parse(readFileSync(STATE(), "utf8")) as Saved;
    rules = s.rules ?? [];
    wideRules = s.wide ?? [];
    edges = s.edge ?? [];
    for (const [k, v] of Object.entries(s.snaps ?? {})) snaps.set(k, reviveSnap(v));
  } catch {
    rules = [];
    wideRules = [];
    edges = [];
  }
  // the fees-against-cost reading starts from the reads already on disk, so it does not begin at zero
  for (const pool of POOLS) {
    if (edges.some((e) => e.pool === pool.key)) continue;
    const e = replay(pool);
    if (e) edges.push(e);
  }
}

const readOf = (pool: PoolDef, s: PoolSnap): Read => ({ t: s.t, p: price(s, pool.decA, pool.decB), fgA: s.feeGrowthA, fgB: s.feeGrowthB });

/** The reading for one pool from its recorded reads (the last 14 days of files). Null when there are none. */
function replay(pool: PoolDef): EdgeState | null {
  if (!existsSync(DIR())) return null;
  const files = readdirSync(DIR()).filter((f) => f.startsWith(`${pool.key}-`) && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f.slice(pool.key.length + 1))).sort().slice(-14);
  let e: EdgeState | null = null;
  let prev: Read | null = null;
  for (const f of files) {
    for (const ln of readFileSync(join(DIR(), f), "utf8").split("\n")) {
      if (!ln) continue;
      try {
        const [t, p, , a, b] = JSON.parse(ln) as [number, number, string, string, string];
        const now: Read = { t, p, fgA: BigInt(a), fgB: BigInt(b) };
        if (!e) e = edgeStart(pool, t);
        if (prev) edgeStep(e, pool, prev, now);
        prev = now;
      } catch {
        // a torn line: skip it
      }
    }
  }
  return e;
}

function meter(pool: PoolDef, prev: PoolSnap | undefined, snap: PoolSnap) {
  let e = edges.find((x) => x.pool === pool.key);
  if (!e) {
    e = edgeStart(pool, snap.t);
    edges.push(e);
  }
  if (prev) edgeStep(e, pool, readOf(pool, prev), readOf(pool, snap));
}

/** The extra pools: the saved answer if there is one, else one look at the chain (again every 10 minutes until it works). */
async function findWide(fetcher: typeof fetch) {
  if (!wideOn() || found) return;
  try {
    found = validFound(JSON.parse(readFileSync(WIDE_FILE(), "utf8")));
  } catch {
    found = null;
  }
  if (found || Date.now() < wide.nextTry) return;
  wide.nextTry = Date.now() + WIDE_RETRY_MS;
  wide.tries++;
  try {
    found = await discover((a) => readAccounts(a, RPC, fetcher));
    save(WIDE_FILE(), found);
    wide.error = "";
  } catch {
    wide.error = "the pools could not be looked up on the chain yet; it is tried again every 10 minutes";
  }
}

function record(pool: PoolDef, snap: PoolSnap) {
  mkdirSync(DIR(), { recursive: true });
  const day = new Date(snap.t + 9 * 3600_000).toISOString().slice(0, 10);
  const p = price(snap, pool.decA, pool.decB);
  appendFileSync(join(DIR(), `${pool.key}-${day}.jsonl`), JSON.stringify([snap.t, pool.pair ? +p.toPrecision(8) : +p.toFixed(4), snap.liquidity.toString(), snap.feeGrowthA.toString(), snap.feeGrowthB.toString()]) + "\n");
}

function prune() {
  if (!existsSync(DIR())) return;
  const cut = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  for (const f of readdirSync(DIR())) {
    const m = f.match(/-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (m && m[1] < cut) unlinkSync(join(DIR(), f));
  }
}

const BAR = (r: { closedDays: number; vsHold: number; daysWon: number; cycles: number }) => r.closedDays >= 30 && r.vsHold > 0 && r.daysWon / r.closedDays >= 0.5 && (r.cycles === 0 || r.cycles >= 100);

/** The wider test, compact: one line per rule and pool, everything in dollars. */
function wideSummary() {
  if (!wideOn()) return { mode: "paper", on: false };
  const extra = found?.pools ?? [];
  const rows = wideRules.flatMap((s) => {
    const pool = extra.find((p) => p.key === s.pool);
    const def = pool && rulesFor(pool).find((r) => r.id === s.id);
    return def && pool ? [summarize(s, def, pool)] : [];
  });
  rows.sort((a, b) => b.vsHold - a.vsHold);
  return {
    mode: "paper",
    on: true,
    note: "Paper only, nothing is sent. The same fee test as SOL/USDC on more pairs: $200 on paper in a price range, real fees read from each pool's own counters, score vsHold = position + fees - costs against simply holding the two tokens, in dollars. Staked SOL pairs get much narrower ranges because they barely move. The cost of a re-centring swap is assumed per pair. Same bar: 30+ closed days, at least half of them ahead of hold, net ahead, 100+ range cycles for rules that re-centre. Days are needed; the first days say nothing.",
    found: !!found,
    foundAt: found?.at ?? null,
    error: found ? "" : wide.error,
    noPool: found?.none ?? [],
    pools: extra.map((p) => {
      const s = snaps.get(p.key);
      const mine = rows.filter((r) => r.pool === p.key);
      return {
        key: p.key, label: p.label, pair: p.pair, kind: p.kind, price: s ? +price(s, p.decA, p.decB).toPrecision(6) : null, feeRatePct: s ? s.feeRate * 100 : null, lastRead: s?.t ?? null,
        problem: wide.bad[p.key] ?? "", rules: mine.length, aheadOfHold: mine.filter((r) => r.vsHold > 0).length,
        best: mine[0] ? { id: mine[0].id, vsHold: mine[0].vsHold, fees: mine[0].fees, feeAprPct: mine[0].feeAprPct } : null,
      };
    }),
    rulesTried: rows.length,
    aheadOfHold: rows.filter((r) => r.vsHold > 0).length,
    qualified: rows.filter(BAR).map((r) => `${r.id}@${r.pool}`),
    texts: Object.fromEntries([...RULES, ...PEG_RULES].map((r) => [r.id, r.text])),
    rows: rows.map((r) => ({
      id: r.id, pool: r.pool, days: r.days, net: r.net, vsHold: r.vsHold, fees: r.fees, costs: r.costs, feeAprPct: r.feeAprPct, inRangePct: r.inRangePct,
      cycles: r.cycles, cyclesWon: r.cyclesWon, closedDays: r.closedDays, daysWon: r.daysWon, todayVsHold: r.todayVsHold,
    })),
  };
}

export function buildSummary() {
  const rows = rules.flatMap((s) => {
    const def = RULES.find((r) => r.id === s.id);
    const pool = POOLS.find((p) => p.key === s.pool);
    return def && pool ? [summarize(s, def, pool)] : [];
  });
  rows.sort((a, b) => b.vsHold - a.vsHold);
  const qualified = rows.filter(BAR);
  return {
    mode: "paper",
    note: "Paper only. Score is vsHold: position + fees - costs, against holding the starting SOL and USDC. Bar for real: 30+ closed days, at least half of them ahead of hold, net ahead of hold, and 100+ range cycles for rules that re-centre.",
    updatedAt: Date.now(),
    health,
    pools: POOLS.map((p) => {
      const s = snaps.get(p.key);
      return { key: p.key, label: p.label, price: s ? +price(s, p.decA, p.decB).toFixed(3) : null, feeRatePct: s ? s.feeRate * 100 : null, lastRead: s?.t ?? null };
    }),
    rulesTried: rows.length,
    aheadOfHold: rows.filter((r) => r.vsHold > 0).length,
    qualified: qualified.map((r) => `${r.id}@${r.pool}`),
    rules: rows,
    wide: wideSummary(),
    meteora: dlmmSummary(),
    edge: {
      mode: "paper",
      note: EDGE_NOTE,
      pools: [...POOLS, ...(wideOn() ? (found?.pools ?? []) : [])].flatMap((p) => {
        const e = edges.find((x) => x.pool === p.key);
        return e ? [edgeSummary(e, p)] : [];
      }),
    },
  };
}

export async function tick(fetcher: typeof fetch = fetch) {
  if (!loaded) load();
  if (!health.startedAt) health.startedAt = Date.now();
  await findWide(fetcher);
  const extra = wideOn() ? (found?.pools ?? []) : [];
  let now: Map<string, PoolSnap>;
  let accs: (Account | null)[];
  let t: number;
  try {
    // one call for everything; the two SOL/USDC pools must both be right, as before
    accs = await readAccounts([...POOLS, ...extra].map((p) => p.address), RPC, fetcher);
    t = Date.now();
    now = new Map(POOLS.map((def, i) => [def.key, snapOf(def, accs[i], t)]));
  } catch (e) {
    health.errors++;
    health.lastError = String((e as Error).message).slice(0, 200);
    save(SUMMARY(), buildSummary());
    return;
  }
  health.reads++;
  health.lastOk = Date.now();
  for (const pool of POOLS) {
    const snap = now.get(pool.key)!;
    const prev = snaps.get(pool.key);
    record(pool, snap);
    meter(pool, prev, snap);
    for (const def of RULES) {
      let s = rules.find((r) => r.id === def.id && r.pool === pool.key);
      if (!s) {
        s = start(def, pool, snap);
        rules.push(s);
      } else if (prev) step(s, def, pool, prev, snap);
    }
    snaps.set(pool.key, snap);
  }
  // the wider test: each pool on its own, a bad one is named and skipped
  const solUsd = price(now.get(POOLS[0].key)!, POOLS[0].decA, POOLS[0].decB);
  wide.bad = {};
  extra.forEach((pool, i) => {
    let snap: PoolSnap;
    try {
      snap = snapOf(pool, accs[POOLS.length + i], t);
    } catch (e) {
      wide.bad[pool.key] = /not found/.test(String((e as Error).message)) ? "account not found" : /mints differ/.test(String((e as Error).message)) ? "not the expected pool" : "could not be read";
      return;
    }
    const usdB = usdOfB(pool, price(snap, pool.decA, pool.decB), solUsd);
    if (usdB === null) {
      wide.bad[pool.key] = "no dollar price";
      return;
    }
    const prev = snaps.get(pool.key);
    if (wide.ticks % 2 === 0) record(pool, snap); // once a minute is enough for a replay
    meter(pool, prev, snap);
    for (const def of rulesFor(pool)) {
      let s = wideRules.find((r) => r.id === def.id && r.pool === pool.key);
      if (!s) {
        s = start(def, pool, snap, usdB);
        wideRules.push(s);
      } else if (prev) step(s, def, pool, prev, snap, usdB);
    }
    snaps.set(pool.key, snap);
  });
  // Meteora's pools, once a minute, with their own state and their own health line
  if (wide.ticks % 2 === 1) {
    try {
      await dlmmTick((a) => readAccounts(a, RPC, fetcher));
    } catch {
      // never lets the fee test down
    }
  }
  wide.ticks++;
  save(STATE(), { rules, wide: wideRules, edge: edges, snaps: Object.fromEntries(snaps) });
  save(SUMMARY(), buildSummary());
}

export const _lpTest = {
  reset() {
    rules = [];
    wideRules = [];
    edges = [];
    found = null;
    snaps.clear();
    loaded = true;
    Object.assign(wide, { tries: 0, nextTry: 0, error: "", bad: {}, ticks: 0 });
    Object.assign(health, { startedAt: 0, lastOk: 0, reads: 0, errors: 0, lastError: "" });
  },
  wide: () => ({ found, rules: wideRules, health: wide }),
  edges: () => edges,
  /** as after a restart: the state is read from disk again at the next tick */
  restart() {
    loaded = false;
    found = null;
    snaps.clear();
  },
};

/** For the status page: the last summary written to disk (null until the first read). */
export function solanaSummary(): unknown {
  try {
    return JSON.parse(readFileSync(SUMMARY(), "utf8"));
  } catch {
    return null;
  }
}

export function startSolanaLp() {
  if (process.env.SOLANA === "off") return null;
  let busy = false;
  let n = 0;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await tick();
      if (n++ % 2880 === 0) prune();
    } catch (e) {
      health.errors++;
      health.lastError = String((e as Error).message).slice(0, 200);
    } finally {
      busy = false;
    }
  };
  void run();
  return setInterval(run, TICK_MS);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`solana paper LP: ${POOLS.length} pools, ${RULES.length} rules each, rpc ${new URL(RPC).host}`);
  startSolanaLp();
  setInterval(() => {
    const s = buildSummary();
    console.log(new Date().toISOString(), `reads ${health.reads} errors ${health.errors} ${health.lastError}`, s.pools.map((p) => `${p.key} ${p.price}`).join(" · "), `ahead of hold ${s.aheadOfHold}/${s.rulesTried}`);
  }, 60_000);
}
