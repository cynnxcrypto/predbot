import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "soledge-"));
process.env.DATA_DIR = dir;
process.env.SOLANA_DLMM = "off";
process.env.SOLANA_LP_WIDE = "off";

const { CALM_LABELS, EDGE_GAP_MS, MAX_FEE_STEP, REF_VOLATILE, edgeStart, edgeStep, edgeSummary } = await import("./lpedge.js");
const { RULES, STAKE, start, step } = await import("./lp.js");
const { POOLS, SOL, USDC } = await import("./pools.js");
const { tick, solanaSummary, _lpTest } = await import("./run.js");
const { ORCA_PROGRAM, pubkeyBytes } = await import("./pda.js");

const pool = POOLS[0];
const Q64 = 2 ** 64;
/** counter growth that pays one unit of whole-token liquidity `usdc` dollars (token B side) */
const fg = (usdc: number) => BigInt(Math.round(((usdc * 1e6) / 10 ** 7.5) * Q64));
const read = (t: number, p: number, paid = 0) => ({ t, p, fgA: 0n, fgB: fg(paid) });
const share = (w: number) => 2 - 1 / Math.sqrt(1 + w) - Math.sqrt(1 - w);

test("fee and price cost are counted per unit of liquidity, over 30 s, 5 min and 1 hour", () => {
  const e = edgeStart(pool, 0);
  // 100 -> 101 -> 100 in two reads, and the pool pays 0.002 dollars per unit of liquidity over them
  edgeStep(e, pool, read(0, 100), read(30_000, 101, 0.001));
  edgeStep(e, pool, read(30_000, 101, 0.001), read(60_000, 100, 0.002));
  const up = (Math.sqrt(1.01) - 1) ** 2;
  const down = (Math.sqrt(100 / 101) - 1) ** 2;
  assert.ok(Math.abs(e.all.c30 - (up + down)) < 1e-12);
  assert.ok(Math.abs(e.all.fee - (0.001 / Math.sqrt(101) + 0.001 / Math.sqrt(100))) < 1e-9, `${e.all.fee}`);
  assert.deepEqual([e.all.c5, e.all.c60, e.all.ms], [0, 0, 60_000], "the longer clocks have not closed yet");
  // the price is back where it began: over 5 minutes the move, and so its cost, is nothing
  let prev = read(60_000, 100, 0.002);
  for (let t = 90_000; t <= 300_000; t += 30_000) {
    const now = read(t, 100, 0.002);
    edgeStep(e, pool, prev, now);
    prev = now;
  }
  assert.equal(e.all.c5, 0);
  assert.ok(e.a5!.t === 300_000 && e.all.c30 > 0, "back and forth costs at 30 s and nothing at 5 minutes");
  // one hour from the start the price is 2% up: the hour's cost is that of one 2% move
  for (let t = 330_000; t <= 3_600_000; t += 30_000) {
    const now = read(t, t === 3_600_000 ? 102 : 100, 0.002);
    edgeStep(e, pool, prev, now);
    prev = now;
  }
  assert.ok(Math.abs(e.all.c60 - (Math.sqrt(1.02) - 1) ** 2) < 1e-12);
  assert.equal(e.a60!.prevAbs !== null && Math.abs(e.a60!.prevAbs! - Math.log(1.02) * 100) < 1e-9, true);
  assert.equal(e.calm.reduce((a, b) => a + b.n, 0), 0, "the first hour has no hour before it");
  const s = edgeSummary(e, pool);
  const k = 100 / share(REF_VOLATILE);
  assert.deepEqual([s.refRangePct, s.all.hours, s.all.cost1hPct], [5, 1, +(e.all.c60 * k).toPrecision(4)]);
  assert.equal(s.all.ratio1h, +(e.all.fee / e.all.c60).toFixed(2));
  assert.equal(s.afterAnHourThatMoved.length, CALM_LABELS.length);
});

test("the reading agrees with what a range rule is paid from the same counters", () => {
  const Q = 1n << 64n;
  const sp = (p: number) => BigInt(Math.round(Math.sqrt(p / 1000) * 2 ** 32)) << 32n;
  const snap = (t: number, fgB: bigint) => ({ t, liquidity: 10n ** 20n, sqrtPrice: sp(160), tick: 0, tickSpacing: 4, feeRate: 0.0004, mintA: SOL, mintB: USDC, feeGrowthA: 0n, feeGrowthB: fgB });
  const def = RULES.find((r) => r.id === "lp-w5")!;
  const s0 = snap(0, 0n);
  const s1 = snap(30_000, Q / 10n ** 10n);
  const rule = start(def, pool, s0);
  step(rule, def, pool, s0, s1);
  const e = edgeStart(pool, 0);
  edgeStep(e, pool, { t: 0, p: 160, fgA: 0n, fgB: 0n }, { t: 30_000, p: 160, fgA: 0n, fgB: s1.feeGrowthB });
  const mine = edgeSummary(e, pool).all.feePct / 100; // share of a position 5% either side
  const rules = rule.fees / (STAKE - rule.costs);
  assert.ok(Math.abs(mine / rules - 1) < 2e-3, `${mine} vs ${rules}`);
});

test("a gap counts for nothing, a bad read pays nothing, days close on the KST boundary", () => {
  const e = edgeStart(pool, 0);
  edgeStep(e, pool, read(0, 100), read(30_000, 100, 0.001));
  const fee = e.all.fee;
  edgeStep(e, pool, read(30_000, 100, 0.001), read(30_000 + EDGE_GAP_MS + 1, 120, 0.5));
  assert.deepEqual([e.all.fee, e.all.c30, e.a5, e.a60], [fee, 0, null, null], "not seen: neither paid nor charged, clocks restart");
  // a counter jump far beyond anything real
  edgeStep(e, pool, read(400_000, 120, 0.5), read(430_000, 120, 0.5 + MAX_FEE_STEP * Math.sqrt(120) * 2));
  assert.equal(e.all.fee, fee);
  assert.equal(e.all.ms, 60_000);
  edgeStep(e, pool, read(430_000, 120), read(430_000, 121));
  edgeStep(e, pool, read(430_000, 0), read(460_000, 121));
  assert.equal(e.all.ms, 60_000, "no time, or no price: nothing");
  const t0 = Date.UTC(2026, 10, 11, 14, 59, 30); // 23:59:30 KST
  const d = edgeStart(pool, t0);
  edgeStep(d, pool, read(t0, 100), read(t0 + 20_000, 100, 0.001));
  edgeStep(d, pool, read(t0 + 20_000, 100, 0.001), read(t0 + 50_000, 100, 0.003));
  assert.deepEqual([d.days.length, d.days[0].day, d.dayKey], [1, "2026-11-11", "2026-11-12"]);
  assert.ok(d.days[0].fee > 0 && d.day.fee > d.days[0].fee && Math.abs(d.all.fee - d.days[0].fee - d.day.fee) < 1e-15);
});

test("hours are sorted by the move of the hour before them", () => {
  const e = edgeStart(pool, 0);
  // hour 1 moves 0.1% (calm), hour 2 moves 3% and is paid 0.01, hour 3 flat and paid 0.02
  const at = (t: number) => (t <= 3_600_000 ? 100 + (0.1 * t) / 3_600_000 : t <= 7_200_000 ? 100.1 * (1 + (0.03 * (t - 3_600_000)) / 3_600_000) : 100.1 * 1.03);
  const paid = (t: number) => (t <= 3_600_000 ? 0 : t <= 7_200_000 ? (0.01 * (t - 3_600_000)) / 3_600_000 : 0.01 + (0.02 * (t - 7_200_000)) / 3_600_000);
  let prev = read(0, at(0), paid(0));
  for (let t = 30_000; t <= 3 * 3_600_000; t += 30_000) {
    const now = read(t, at(t), paid(t));
    edgeStep(e, pool, prev, now);
    prev = now;
  }
  const [calm, , , , wild] = e.calm;
  assert.deepEqual([calm.n, wild.n, e.calm[1].n + e.calm[2].n + e.calm[3].n], [1, 1, 0]);
  // after the calm hour came the 3% hour: paid 0.01 a unit, at a real cost
  assert.ok(Math.abs(calm.fee - 0.01 / Math.sqrt(101.6)) < 2e-5 && Math.abs(calm.c60 - (Math.sqrt(1.03) - 1) ** 2) < 1e-9);
  // after the wild hour came the flat one: paid 0.02, cost nothing
  assert.ok(Math.abs(wild.fee - 0.02 / Math.sqrt(103.103)) < 1e-6 && wild.c60 === 0 && wild.c5 === 0);
  const s = edgeSummary(e, pool);
  assert.deepEqual([s.afterAnHourThatMoved[0].moved, s.afterAnHourThatMoved[0].hours, s.afterAnHourThatMoved[4].ratio1h], ["under 0.25%", 1, null]);
});

test("the runner keeps the reading for every pool and starts it from the reads on disk", async () => {
  _lpTest.reset();
  // two hours of recorded reads for the first pool, as the runner writes them: price, liquidity, the two counters
  mkdirSync(join(dir, "solana"), { recursive: true });
  const t0 = Date.UTC(2026, 10, 12, 0, 0, 0);
  const lines: string[] = [];
  for (let i = 0; i <= 240; i++) lines.push(JSON.stringify([t0 + i * 30_000, +(100 + i * 0.01).toFixed(4), "1000", "0", fg(i * 1e-5).toString()]));
  writeFileSync(join(dir, "solana", `${pool.key}-2026-11-12.jsonl`), lines.join("\n") + "\n{torn");
  writeFileSync(join(dir, "solana", `${pool.key}0-2026-11-12.jsonl`), lines.join("\n")); // another pool's file: not read
  _lpTest.restart();
  const account = (fgB: bigint) => {
    const b = Buffer.alloc(653);
    const w = (off: number, v: bigint) => {
      b.writeBigUInt64LE(v & ((1n << 64n) - 1n), off);
      b.writeBigUInt64LE(v >> 64n, off + 8);
    };
    b.writeUInt16LE(4, 41);
    b.writeUInt16LE(400, 45);
    w(49, 10n ** 15n);
    w(65, BigInt(Math.round(Math.sqrt(160 / 1000) * 2 ** 32)) << 32n);
    pubkeyBytes(SOL).copy(b, 101);
    pubkeyBytes(USDC).copy(b, 181);
    w(245, fgB);
    return b;
  };
  let n = 0n;
  const rpc = (async () => new Response(JSON.stringify({ result: { value: POOLS.map(() => ({ data: [account(++n * 10n ** 9n).toString("base64"), "base64"], owner: ORCA_PROGRAM })) } }))) as unknown as typeof fetch;
  await tick(rpc);
  await tick(rpc);
  type Sum = { rules: unknown[]; wide: { on: boolean }; edge: { note: string; pools: { pool: string; all: { hours: number; feePct: number; cost1hPct: number; ratio1h: number | null }; today: { hours: number } }[] } };
  const sum = solanaSummary() as Sum;
  assert.deepEqual([sum.rules.length, sum.wide.on], [POOLS.length * RULES.length, false]);
  assert.deepEqual(sum.edge.pools.map((p) => p.pool), POOLS.map((p) => p.key));
  const [first, second] = sum.edge.pools;
  assert.ok(first.all.hours >= 2 && first.all.hours < 2.1 && first.all.feePct > 0 && first.all.cost1hPct > 0 && first.all.ratio1h !== null, JSON.stringify(first.all));
  assert.ok(second.all.hours < 0.1 && second.all.feePct > 0, "the second pool had no file: it starts now");
  assert.ok(sum.edge.note.includes("above 1"));
  // a restart keeps it: the saved state is used and the files are not replayed on top
  const before = first.all.hours;
  _lpTest.restart();
  await tick(rpc);
  const again = (solanaSummary() as Sum).edge.pools[0].all.hours;
  assert.ok(again >= before && again < before + 0.1);
  delete process.env.SOLANA_LP_WIDE;
});
