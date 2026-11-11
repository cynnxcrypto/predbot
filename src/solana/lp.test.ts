import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "sol-"));

const { amounts, base58, decodeWhirlpool, growth, open, price, rawLiquidity, value } = await import("./whirlpool.js");
const { RULES, STAKE, SWAP_COST, TX_USD, netUsd, start, step, vsHold } = await import("./lp.js");
const { POOLS, SOL, USDC } = await import("./pools.js");
const { readPools, tick, solanaSummary } = await import("./run.js");

const pool = POOLS[0];
const Q64 = 1n << 64n;
/** sqrtPrice (Q64.64) for a USDC-per-SOL price */
const sp = (p: number) => BigInt(Math.round(Math.sqrt(p / 1000) * 2 ** 32)) << 32n;
const snap = (t: number, p: number, fgA = 0n, fgB = 0n, liquidity = 10n ** 15n) => ({ t, liquidity, sqrtPrice: sp(p), tick: 0, tickSpacing: 4, feeRate: 0.0004, mintA: SOL, mintB: USDC, feeGrowthA: fgA, feeGrowthB: fgB });

function b58decode(s: string): Buffer {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const out = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 255n);
    n >>= 8n;
  }
  return out;
}
function account(p: number, fgA: bigint, fgB: bigint): Buffer {
  const b = Buffer.alloc(653);
  const w = (off: number, v: bigint) => {
    b.writeBigUInt64LE(v & (Q64 - 1n), off);
    b.writeBigUInt64LE(v >> 64n, off + 8);
  };
  b.writeUInt16LE(4, 41);
  b.writeUInt16LE(400, 45);
  w(49, 10n ** 15n);
  w(65, sp(p));
  b.writeInt32LE(-18000, 81);
  b58decode(SOL).copy(b, 101);
  w(165, fgA);
  b58decode(USDC).copy(b, 181);
  w(245, fgB);
  return b;
}

test("decodes a whirlpool account", () => {
  const s = decodeWhirlpool(account(160, 5n, 7n), 1);
  assert.equal(s.mintA, SOL);
  assert.equal(s.mintB, USDC);
  assert.equal(s.feeRate, 0.0004);
  assert.equal(s.tick, -18000);
  assert.equal(s.feeGrowthA, 5n);
  assert.equal(s.feeGrowthB, 7n);
  assert.ok(Math.abs(price(s, 9, 6) - 160) < 0.01);
  assert.equal(base58(new Uint8Array(32)), "1".repeat(32));
});

test("a position is worth what was put in, and one-sided outside its range", () => {
  const r = open(200, 160, 0.05);
  assert.ok(Math.abs(value(r, 160) - 200) < 1e-9);
  assert.equal(amounts(r, 140).b, 0);
  assert.equal(amounts(r, 180).a, 0);
  // above the range it is all USDC and worth less than holding would have been
  const h = amounts(r, 160);
  assert.ok(value(r, 180) < h.a * 180 + h.b);
  assert.ok(value(r, 140) < h.a * 140 + h.b);
});

test("fee counter growth survives the wrap", () => {
  const top = (1n << 128n) - 1n;
  assert.equal(growth(top, 0n), 1 / 2 ** 64);
  assert.equal(growth(10n, 10n), 0);
});

test("fees are credited in range only, and match counter × liquidity", () => {
  const def = RULES.find((r) => r.id === "lp-w5")!;
  const s0 = snap(0, 160);
  const s = start(def, pool, s0);
  const p0 = price(s0, 9, 6);
  assert.ok(Math.abs(netUsd(s, p0) + (STAKE / 2) * SWAP_COST + TX_USD) < 1e-9);
  assert.ok(Math.abs(vsHold(s, p0)) < 1e-9);
  const mine = rawLiquidity(s.range.L, 9, 6);
  // counter moves so that one unit of liquidity earns 1e-9 raw USDC
  const d = BigInt(Math.round(1e-9 * 2 ** 64));
  const s1 = snap(30_000, 160, 0n, d);
  step(s, def, pool, s0, s1);
  const expect = ((1e-9 * mine) / 1e6) * (1e15 / (1e15 + mine));
  assert.ok(Math.abs(s.fees - expect) / expect < 1e-6, `${s.fees} vs ${expect}`);
  // no credit across a long gap
  const before = s.fees;
  step(s, def, pool, s1, snap(30_000 + 10 * 60_000, 160, 0n, d * 2n));
  assert.equal(s.fees, before);
  assert.ok(s.gapMs > 0);
});

test("leaving the range re-centres, charges the cost and closes a losing cycle", () => {
  const def = RULES.find((r) => r.id === "lp-w1")!;
  const s0 = snap(0, 160);
  const s = start(def, pool, s0);
  const s1 = snap(30_000, 170);
  step(s, def, pool, s0, s1);
  assert.equal(s.cycles, 1);
  assert.equal(s.cyclesWon, 0);
  assert.ok(s.cyclesNet < 0);
  assert.ok(s.range.lo < 170 && s.range.hi > 170);
  assert.ok(vsHold(s, 170) < 0);
  assert.equal(s.fees, 0);
});

test("a wait rule stays put until the wait has passed; hold rules never move", () => {
  const def = RULES.find((r) => r.id === "lp-w5-wait60")!;
  const hold = RULES.find((r) => r.id === "lp-w10-hold")!;
  let prev = snap(0, 160);
  const s = start(def, pool, prev);
  const h = start(hold, pool, prev);
  for (let m = 1; m <= 59; m++) {
    const now = snap(m * 60_000, 190);
    step(s, def, pool, prev, now);
    step(h, hold, pool, prev, now);
    prev = now;
  }
  assert.equal(s.cycles, 0);
  for (let m = 60; m <= 62; m++) {
    const now = snap(m * 60_000, 190);
    step(s, def, pool, prev, now);
    step(h, hold, pool, prev, now);
    prev = now;
  }
  assert.equal(s.cycles, 1);
  assert.equal(h.cycles, 0);
});

test("days close on the KST boundary", () => {
  const def = RULES.find((r) => r.id === "lp-w20-hold")!;
  const t0 = Date.UTC(2026, 10, 11, 14, 59, 30); // 23:59:30 KST
  const a = snap(t0, 160);
  const s = start(def, pool, a);
  const b = snap(t0 + 60_000, 161);
  step(s, def, pool, a, b);
  assert.equal(s.days.length, 1);
  assert.equal(s.days[0].day, "2026-11-11");
  assert.equal(s.dayKey, "2026-11-12");
});

test("runner reads pools over RPC, rejects a wrong pool, and writes a summary", async () => {
  let fg = 0n;
  const rpc = (async () => {
    fg += 1000n;
    return new Response(JSON.stringify({ result: { value: POOLS.map(() => ({ data: [account(160, fg, fg).toString("base64"), "base64"] })) } }));
  }) as unknown as typeof fetch;
  await tick(rpc);
  await tick(rpc);
  const sum = solanaSummary() as { rules: unknown[]; mode: string; health: { reads: number } };
  assert.equal(sum.mode, "paper");
  assert.equal(sum.rules.length, POOLS.length * RULES.length);
  assert.equal(sum.health.reads, 2);
  const bad = (async () => new Response(JSON.stringify({ result: { value: POOLS.map(() => ({ data: [Buffer.alloc(653).toString("base64"), "base64"] })) } }))) as unknown as typeof fetch;
  await assert.rejects(readPools(POOLS, "http://x", bad), /not the expected pool/);
});
