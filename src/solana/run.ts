/**
 * PAPER ONLY runner for the Solana liquidity rules (src/solana/lp.ts). Reads pool accounts from a Solana RPC,
 * never signs or sends anything. SOLANA=off disables it. SOLANA_RPC overrides the RPC address (keep any key in the
 * server's environment, never in the repo).
 *
 * Files in the data folder: solana-lp.json (state), solana-lp-summary.json (what the dashboard and status read),
 * solana/<pool>-<KST day>.jsonl (one line per read: [t, price, liquidity, feeGrowthA, feeGrowthB], kept 60 days, so
 * any other range rule can be replayed later against the same real fees).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA } from "../config.js";
import { RULES, start, step, summarize, type RuleState } from "./lp.js";
import { POOLS, type PoolDef } from "./pools.js";
import { decodeWhirlpool, price, type PoolSnap } from "./whirlpool.js";

const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const TICK_MS = 30_000;
const STATE = () => join(DATA, "solana-lp.json");
const SUMMARY = () => join(DATA, "solana-lp-summary.json");
const DIR = () => join(DATA, "solana");

interface Saved {
  rules: RuleState[];
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

export async function readPools(pools: PoolDef[], rpc = RPC, fetcher: typeof fetch = fetch): Promise<Map<string, PoolSnap>> {
  const res = await fetcher(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [pools.map((p) => p.address), { encoding: "base64", commitment: "confirmed" }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  const j = (await res.json()) as { error?: { message: string }; result?: { value: ({ data: [string, string] } | null)[] } };
  if (j.error || !j.result) throw new Error(`rpc: ${j.error?.message ?? "no result"}`);
  const t = Date.now();
  const out = new Map<string, PoolSnap>();
  j.result.value.forEach((acc, i) => {
    const def = pools[i];
    if (!acc) throw new Error(`${def.key}: account not found`);
    const snap = decodeWhirlpool(Buffer.from(acc.data[0], "base64"), t);
    if (snap.mintA !== def.mintA || snap.mintB !== def.mintB) throw new Error(`${def.key}: not the expected pool (mints differ)`);
    out.set(def.key, snap);
  });
  return out;
}

let rules: RuleState[] = [];
const snaps = new Map<string, PoolSnap>();
const health = { startedAt: 0, lastOk: 0, reads: 0, errors: 0, lastError: "" };
let loaded = false;

function load() {
  loaded = true;
  try {
    const s = JSON.parse(readFileSync(STATE(), "utf8")) as Saved;
    rules = s.rules ?? [];
    for (const [k, v] of Object.entries(s.snaps ?? {})) snaps.set(k, reviveSnap(v));
  } catch {
    rules = [];
  }
}

function record(pool: PoolDef, snap: PoolSnap) {
  mkdirSync(DIR(), { recursive: true });
  const day = new Date(snap.t + 9 * 3600_000).toISOString().slice(0, 10);
  appendFileSync(join(DIR(), `${pool.key}-${day}.jsonl`), JSON.stringify([snap.t, +price(snap, pool.decA, pool.decB).toFixed(4), snap.liquidity.toString(), snap.feeGrowthA.toString(), snap.feeGrowthB.toString()]) + "\n");
}

function prune() {
  if (!existsSync(DIR())) return;
  const cut = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  for (const f of readdirSync(DIR())) {
    const m = f.match(/-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (m && m[1] < cut) unlinkSync(join(DIR(), f));
  }
}

export function buildSummary() {
  const rows = rules.flatMap((s) => {
    const def = RULES.find((r) => r.id === s.id);
    const pool = POOLS.find((p) => p.key === s.pool);
    return def && pool ? [summarize(s, def, pool)] : [];
  });
  rows.sort((a, b) => b.vsHold - a.vsHold);
  const qualified = rows.filter((r) => r.closedDays >= 30 && r.vsHold > 0 && r.daysWon / r.closedDays >= 0.5 && (r.cycles === 0 || r.cycles >= 100));
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
  };
}

export async function tick(fetcher: typeof fetch = fetch) {
  if (!loaded) load();
  if (!health.startedAt) health.startedAt = Date.now();
  let now: Map<string, PoolSnap>;
  try {
    now = await readPools(POOLS, RPC, fetcher);
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
    for (const def of RULES) {
      let s = rules.find((r) => r.id === def.id && r.pool === pool.key);
      if (!s) {
        s = start(def, pool, snap);
        rules.push(s);
      } else if (prev) step(s, def, pool, prev, snap);
    }
    snaps.set(pool.key, snap);
  }
  save(STATE(), { rules, snaps: Object.fromEntries(snaps) });
  save(SUMMARY(), buildSummary());
}

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
