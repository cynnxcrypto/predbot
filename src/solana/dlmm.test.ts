import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "soldlmm-"));
process.env.DATA_DIR = dir;
process.env.SOLANA_LP_WIDE = "off";

const { arrayIndex, binArrayAddress, binFees, binPrice, decodeBinArray, decodeLbPair, DLMM_PROGRAM, feeRate, lbPairAddress } = await import("./dlmm.js");
const { dlmmCandidates, dlmmSummary, dlmmTick, discoverDlmm, validDlmmFound, _dlmmTest } = await import("./dlmmrun.js");
const { onCurve, pubkeyBytes } = await import("./pda.js");
const { POOLS, SOL, USDC } = await import("./pools.js");
const { tick, solanaSummary, _lpTest } = await import("./run.js");

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const Q = 1n << 64n;
type Acc = { data: Buffer; owner: string };
const w128 = (b: Buffer, off: number, v: bigint) => {
  b.writeBigUInt64LE(v & (Q - 1n), off);
  b.writeBigUInt64LE(v >> 64n, off + 8);
};

function lbPair(o: { activeId: number; binStep: number; baseFactor?: number; mintX?: string; mintY?: string; reserveX: string; reserveY: string; lastSwapSec: number; vfc?: number; va?: number }): Acc {
  const b = Buffer.alloc(904);
  Buffer.from([33, 11, 49, 98, 181, 101, 177, 13]).copy(b, 0);
  b.writeUInt16LE(o.baseFactor ?? 10000, 8);
  b.writeUInt32LE(o.vfc ?? 0, 16);
  b.writeUInt32LE(o.va ?? 0, 40);
  b.writeBigInt64LE(BigInt(o.lastSwapSec), 56);
  b.writeInt32LE(o.activeId, 76);
  b.writeUInt16LE(o.binStep, 80);
  pubkeyBytes(o.mintX ?? SOL).copy(b, 88);
  pubkeyBytes(o.mintY ?? USDC).copy(b, 120);
  pubkeyBytes(o.reserveX).copy(b, 152);
  pubkeyBytes(o.reserveY).copy(b, 184);
  return { data: b, owner: DLMM_PROGRAM };
}
/** raw price (raw Y per raw X) of a bin, as the account stores it */
const rawPrice = (binStep: number, id: number) => BigInt(Math.round((1 + binStep / 1e4) ** id * 2 ** 64));
/** an array whose bins each hold `y` raw USDC (so their value is y and their supply y << 64), with fee counters from fees(id) */
function binArray(pool: string, index: number, binStep: number, y: bigint, fees: (id: number) => { fx?: bigint; fy?: bigint } = () => ({})): Acc {
  const b = Buffer.alloc(10136);
  Buffer.from([92, 142, 92, 220, 5, 148, 70, 181]).copy(b, 0);
  b.writeBigInt64LE(BigInt(index), 8);
  pubkeyBytes(pool).copy(b, 24);
  for (let j = 0; j < 70; j++) {
    const o = 56 + j * 144;
    const id = index * 70 + j;
    b.writeBigUInt64LE(y, o + 8);
    w128(b, o + 16, rawPrice(binStep, id));
    w128(b, o + 32, y << 64n);
    w128(b, o + 80, fees(id).fx ?? 0n);
    w128(b, o + 96, fees(id).fy ?? 0n);
  }
  return { data: b, owner: DLMM_PROGRAM };
}
function tokenAccount(mint: string, amount: bigint): Acc {
  const b = Buffer.alloc(165);
  pubkeyBytes(mint).copy(b, 0);
  b.writeBigUInt64LE(amount, 64);
  return { data: b, owner: TOKEN };
}
/** the bin whose price is about `usd` dollars a SOL */
const binAt = (binStep: number, usd: number) => Math.round(Math.log(usd / 1000) / Math.log(1 + binStep / 1e4));

test("Meteora addresses are worked out locally and reproduce four known SOL/USDC pools", () => {
  assert.equal(lbPairAddress(SOL, USDC, 4), "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6");
  assert.equal(lbPairAddress(USDC, SOL, 1), "HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR");
  assert.equal(lbPairAddress(SOL, USDC, 20), "BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh");
  assert.equal(lbPairAddress(SOL, USDC, 10, 10000), "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y");
  assert.deepEqual([arrayIndex(0), arrayIndex(69), arrayIndex(70), arrayIndex(-1), arrayIndex(-70), arrayIndex(-71)], [0, 0, 1, -1, -1, -2]);
  const pool = lbPairAddress(SOL, USDC, 4);
  const a = binArrayAddress(pool, -89);
  assert.ok(a !== binArrayAddress(pool, 89) && a !== binArrayAddress(lbPairAddress(SOL, USDC, 20), -89) && !onCurve(pubkeyBytes(a)));
  const c = dlmmCandidates();
  assert.equal(new Set(c.map((x) => x.address)).size, c.length);
  assert.ok(c.length <= 100 && c.some((x) => x.address === "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y") && !c.some((x) => POOLS.some((p) => p.address === x.address)));
  assert.ok(Math.abs(binPrice(4, binAt(4, 83), 9, 6) / 83 - 1) < 0.0004);
});

test("pool and bin array accounts are decoded, and anything else is refused", () => {
  const pool = lbPairAddress(SOL, USDC, 4);
  const acc = lbPair({ activeId: -6223, binStep: 4, reserveX: POOLS[0].address, reserveY: POOLS[1].address, lastSwapSec: 1_794_000_000, vfc: 40000, va: 100_000 });
  const p = decodeLbPair(acc.data);
  assert.deepEqual([p.activeId, p.binStep, p.baseFactor, p.mintX, p.mintY, p.reserveX, p.reserveY, p.lastSwapSec], [-6223, 4, 10000, SOL, USDC, POOLS[0].address, POOLS[1].address, 1_794_000_000]);
  // base fee 10000 x 4 x 10 / 1e9 = 0.04%; after ten bins crossed the moving part adds (100000 x 4)^2 x 40000 / 1e11 / 1e9 = 0.0064%
  assert.ok(Math.abs(feeRate({ ...p, variableFeeControl: 0 }) - 0.0004) < 1e-12 && Math.abs(feeRate(p) - 0.000464) < 1e-12, `${feeRate(p)}`);
  assert.equal(feeRate({ ...p, volatilityAccumulator: 4_000_000_000 }), 0.1, "never above the program's 10% ceiling");
  assert.throws(() => decodeLbPair(acc.data.subarray(0, 900)), /not a DLMM pool/);
  assert.throws(() => decodeLbPair(Buffer.alloc(904)), /not a DLMM pool/, "the account type is checked");
  const arr = binArray(pool, -89, 4, 5_000_000n, (id) => (id === -6223 ? { fx: 7n, fy: 9n } : {}));
  const d = decodeBinArray(arr.data, pool);
  assert.deepEqual([d.index, d.bins.length, d.bins[0].id, d.bins[69].id], [-89, 70, -6230, -6161]);
  const b = d.bins.find((x) => x.id === -6223)!;
  assert.deepEqual([b.x, b.y, b.supply, b.fx, b.fy], [0n, 5_000_000n, 5_000_000n << 64n, 7n, 9n]);
  assert.ok(Math.abs(Number(b.price) / 2 ** 64 / 1.0004 ** -6223 - 1) < 1e-9);
  assert.throws(() => decodeBinArray(arr.data, lbPairAddress(SOL, USDC, 20)), /another pool/);
  assert.throws(() => decodeBinArray(Buffer.alloc(10136), pool), /not a bin array/);
});

test("bin fee counters: what a unit of value in the bins was paid", () => {
  const pool = lbPairAddress(SOL, USDC, 4);
  const y = 5_000_000n; // 5 USDC in every bin
  const marks = new Map<number, { fx: bigint; fy: bigint }>();
  const first = binFees(marks, decodeBinArray(binArray(pool, -89, 4, y).data, pool).bins);
  assert.deepEqual([first.r, first.counted, first.unseen, marks.size], [0, 0, 70, 70], "the first look only sets the marks");
  // bin -6223 is paid 1,000 raw USDC, bin -6222 is paid 20,000 raw SOL (lamports), in the units the program uses
  const per = (fee: bigint) => (fee << 64n) / y;
  const next = decodeBinArray(binArray(pool, -89, 4, y, (id) => (id === -6223 ? { fy: per(1000n) } : id === -6222 ? { fx: per(20_000n) } : {})).data, pool).bins;
  const f = binFees(marks, next);
  const px = 1.0004 ** -6222; // raw USDC per lamport
  assert.equal(f.counted, 2);
  assert.ok(Math.abs(f.r - (1000 / 5e6 + (20_000 * px) / 5e6)) < 1e-9, `${f.r}`);
  assert.ok(Math.abs(f.paidY - (1000 + 20_000 * px)) < 1e-3);
  assert.ok(f.shareValue.every((v) => Math.abs(v - 1) < 1e-9), "value per unit of supply is 1, as the arithmetic assumes");
  assert.equal(binFees(marks, next).r, 0, "nothing new, nothing paid");
  // the counter wraps; and a bin that pays 5% of itself between two looks is a bad read
  marks.set(-6223, { fx: 0n, fy: (1n << 128n) - 5n });
  assert.ok(Math.abs(binFees(marks, next).r - Number(per(1000n) + 5n) / 2 ** 64) < 1e-12);
  marks.set(-6223, { fx: 0n, fy: 0n });
  const wild = decodeBinArray(binArray(pool, -89, 4, y, (id) => (id === -6223 ? { fy: per(300_000n) } : {})).data, pool).bins;
  marks.set(-6222, { fx: 0n, fy: 0n });
  assert.deepEqual([binFees(marks, wild).r, marks.get(-6223)!.fy], [0, per(300_000n)]);
});

test("the Meteora runner finds the pools once, then compares each bin's counters from minute to minute", async () => {
  _dlmmTest.reset();
  const now0 = 1_794_441_600_000;
  const a4 = lbPairAddress(SOL, USDC, 4);
  const a10 = lbPairAddress(SOL, USDC, 10, 10000);
  const a20 = lbPairAddress(SOL, USDC, 20);
  const a1 = lbPairAddress(SOL, USDC, 1);
  const res = (pool: string, side: number) => binArrayAddress(pool, 9000 + side); // any address will do for a reserve
  let active4 = binAt(4, 83);
  const active10 = binAt(10, 83);
  let paid4 = 0n; // raw USDC paid to each of the two bins around the start, per look
  let down = false;
  let asked70 = 0;
  const y = 50_000_000n;
  const start4 = active4;
  const chain = (addr: string): Acc | null => {
    if (addr === a4) return lbPair({ activeId: active4, binStep: 4, reserveX: res(a4, 0), reserveY: res(a4, 1), lastSwapSec: now0 / 1000 - 5 });
    if (addr === a10) return lbPair({ activeId: active10, binStep: 10, reserveX: res(a10, 0), reserveY: res(a10, 1), lastSwapSec: now0 / 1000 - 60 });
    if (addr === a20) return lbPair({ activeId: binAt(20, 83), binStep: 20, reserveX: res(a20, 0), reserveY: res(a20, 1), lastSwapSec: now0 / 1000 - 2 * 86_400 });
    if (addr === a1) return lbPair({ activeId: binAt(1, 83), binStep: 1, reserveX: res(a1, 0), reserveY: res(a1, 1), lastSwapSec: now0 / 1000 - 5 });
    if (addr === lbPairAddress(SOL, USDC, 2)) return { ...lbPair({ activeId: 0, binStep: 2, reserveX: res(a1, 0), reserveY: res(a1, 1), lastSwapSec: now0 / 1000 }), owner: TOKEN };
    for (const [pool, sol, usdc] of [[a4, 30_000n, 2_500_000n], [a10, 6_000n, 500_000n], [a20, 60_000n, 5_000_000n], [a1, 30n, 2_500n]] as [string, bigint, bigint][]) {
      if (addr === res(pool, 0)) return tokenAccount(SOL, sol * 10n ** 9n);
      if (addr === res(pool, 1)) return tokenAccount(USDC, usdc * 10n ** 6n);
    }
    for (const i of [-2, -1, 0, 1, 2]) {
      const idx = arrayIndex(start4) + i;
      if (addr === binArrayAddress(a4, idx)) return binArray(a4, idx, 4, y, (id) => (id === start4 || id === start4 + 1 ? { fy: (paid4 << 64n) / y } : {}));
      const idx10 = arrayIndex(active10) + i;
      if (addr === binArrayAddress(a10, idx10)) return i === 0 ? binArray(a10, idx10, 10, y) : null; // the neighbours do not exist: normal
    }
    return null;
  };
  const read = async (addrs: string[]) => {
    if (down) throw new Error("secret words from the rpc");
    if (addrs.length === dlmmCandidates().length) asked70++;
    return addrs.map(chain);
  };
  // the look-up on its own
  const f = await discoverDlmm(read, now0);
  assert.deepEqual(f.pools.map((p) => [p.key, p.binStep, p.decX, p.decY]), [["meteora-sol-usdc-bs4", 4, 9, 6], ["meteora-sol-usdc-bs10-f10000", 10, 9, 6]], "most money first; no trade for two days and too small are left out");
  assert.deepEqual([f.seen, f.pools[0].label, validDlmmFound(JSON.parse(JSON.stringify(f)))!.pools.length, validDlmmFound({ ...f, version: "x" })], [4, "Meteora SOL/USDC 0.04% (bin step 4)", 2, null]);
  assert.ok(Math.abs(f.pools[0].tvlUsd / (30_000 * 83 + 2_500_000) - 1) < 0.001);
  assert.equal(validDlmmFound({ ...f, pools: [{ ...f.pools[0], address: POOLS[0].address }] }), null);
  // look 1 finds the pools, look 2 reads the pools only, look 3 sets the marks, look 4 is the first that counts
  asked70 = 0;
  await dlmmTick(read, now0);
  assert.deepEqual([asked70, _dlmmTest.state().found!.pools.length, existsSync(join(dir, "solana-dlmm.json"))], [1, 2, true]);
  await dlmmTick(read, now0 + 60_000);
  await dlmmTick(read, now0 + 120_000);
  assert.deepEqual([_dlmmTest.state().health.steps, _dlmmTest.state().edges.map((e) => e.all.ms)], [0, [0, 0]]);
  // in the next minute the 0.04% pool moves up one bin and each of the two bins is paid 2,000 raw USDC
  active4 += 1;
  paid4 = 2000n;
  await dlmmTick(read, now0 + 180_000);
  const e4 = _dlmmTest.state().edges.find((e) => e.pool === "meteora-sol-usdc-bs4")!;
  const s = Math.log(1.0004);
  assert.ok(Math.abs(e4.all.fee - (s / 2) * (2 * 2000) / 5e7) < 1e-12, `${e4.all.fee}`);
  assert.ok(Math.abs(e4.all.c30 - (Math.sqrt(1.0004) - 1) ** 2) < 1e-15);
  assert.deepEqual([e4.all.ms, _dlmmTest.state().health.steps, _dlmmTest.state().health.partialSteps, _dlmmTest.state().health.badArrays], [60_000, 2, 0, 0]);
  let sum = dlmmSummary() as { found: boolean; check: { shareValue: number }; health: { lastError: string; errors: number }; pools: { pool: string; all: { feePct: number; ratio30s: number }; poolFeesUsd: { all: number }; usdPerSol: number; feeRatePctNow: number; problem: string }[] };
  assert.deepEqual([sum.found, sum.check.shareValue, sum.pools.map((p) => p.problem)], [true, 1, ["", ""]]);
  assert.ok(Math.abs(sum.pools[0].usdPerSol / 83 - 1) < 0.001 && sum.pools[0].feeRatePctNow === 0.04 && sum.pools[1].feeRatePctNow === 0.1);
  // the two bins were paid 0.008% of their value in all, a fifth of one bin step: fee / cost = 2 x 0.2 = 0.4
  assert.equal(sum.pools[0].all.ratio30s, 0.4);
  assert.equal(sum.pools[0].poolFeesUsd.all, 0, "0.004 dollars of fees, rounded");
  // a read that fails says so in our own words and counts nothing
  down = true;
  await dlmmTick(read, now0 + 240_000);
  sum = dlmmSummary() as typeof sum;
  assert.deepEqual([sum.health.errors, sum.health.lastError], [1, "the pools could not be read"]);
  down = false;
  // after a restart the saved pools are used (no second look-up) and the first minute is not counted
  _dlmmTest.restart();
  paid4 = 9000n;
  await dlmmTick(read, now0 + 300_000);
  await dlmmTick(read, now0 + 360_000);
  assert.deepEqual([asked70, _dlmmTest.state().edges.find((e) => e.pool === "meteora-sol-usdc-bs4")!.all.ms], [1, 60_000]);
  paid4 = 9500n;
  await dlmmTick(read, now0 + 420_000);
  const again = _dlmmTest.state().edges.find((e) => e.pool === "meteora-sol-usdc-bs4")!;
  assert.ok(again.all.ms === 120_000 && Math.abs(again.all.fee - (s / 2) * (2 * 2000 + 2 * 500) / 5e7) < 1e-12, "only what was paid between two looks of the same run");
  // the price runs three arrays away between two looks: that minute is not counted, and the next looks pick up there
  active4 += 3 * 70;
  await dlmmTick(read, now0 + 480_000);
  assert.deepEqual([_dlmmTest.state().edges.find((e) => e.pool === "meteora-sol-usdc-bs4")!.all.ms, (dlmmSummary() as typeof sum).pools[0].problem], [120_000, "the active bin's array could not be read"]);
});

test("the fee test's runner carries the Meteora reading and is not held up when it fails", async () => {
  _lpTest.reset();
  _dlmmTest.reset();
  const account = () => {
    const b = Buffer.alloc(653);
    b.writeUInt16LE(4, 41);
    b.writeUInt16LE(400, 45);
    b.writeBigUInt64LE(10n ** 15n, 49);
    const sp = BigInt(Math.round(Math.sqrt(83 / 1000) * 2 ** 32)) << 32n;
    b.writeBigUInt64LE(sp & (Q - 1n), 65);
    b.writeBigUInt64LE(sp >> 64n, 73);
    pubkeyBytes(SOL).copy(b, 101);
    pubkeyBytes(USDC).copy(b, 181);
    return b;
  };
  const rpc = (async () => new Response(JSON.stringify({ result: { value: POOLS.map(() => ({ data: [account().toString("base64"), "base64"] })) } }))) as unknown as typeof fetch;
  await tick(rpc);
  await tick(rpc);
  const sum = solanaSummary() as { rules: unknown[]; health: { reads: number; errors: number }; meteora: { on: boolean; found: boolean; health: { lastError: string } } };
  assert.deepEqual([sum.rules.length, sum.health.reads, sum.health.errors], [18, 2, 0]);
  assert.deepEqual([sum.meteora.on, sum.meteora.found], [true, false]);
  assert.ok(sum.meteora.health.lastError.startsWith("the pools could not be looked up"));
});
