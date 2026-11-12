import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "solwide-"));
process.env.DATA_DIR = dir;
process.env.SOLANA_DLMM = "off";

const { findProgramAddress, onCurve, ORCA_PROGRAM, ordered, pubkeyBytes, whirlpoolAddress } = await import("./pda.js");
const { candidates, discover, mintDecimals, usdOfB, validFound, WIDE_VERSION } = await import("./lpwide.js");
const { PEG_RULES, RULES, STAKE, TX_USD, netUsd, rulesFor, start, step, summarize, vsHold } = await import("./lp.js");
const { CBBTC, JITOSOL, MSOL, PAIRS, POOLS, SOL, TICK_SPACINGS, USDC, USDT } = await import("./pools.js");
const { tick, solanaSummary, _lpTest } = await import("./run.js");
const { price, rawLiquidity } = await import("./whirlpool.js");

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const Q64 = 1n << 64n;

/** a pool account as the chain stores it; p = whole tokens of B for one of A */
function poolAccount(o: { mintA: string; mintB: string; decA: number; decB: number; p: number; ts: number; fee?: number; liquidity?: bigint; fgA?: bigint; fgB?: bigint }) {
  const b = Buffer.alloc(653);
  const w = (off: number, v: bigint) => {
    b.writeBigUInt64LE(v & (Q64 - 1n), off);
    b.writeBigUInt64LE(v >> 64n, off + 8);
  };
  b.writeUInt16LE(o.ts, 41);
  b.writeUInt16LE(o.fee ?? 400, 45);
  w(49, o.liquidity ?? 10n ** 15n);
  w(65, BigInt(Math.round(Math.sqrt(o.p * 10 ** (o.decB - o.decA)) * 2 ** 32)) << 32n);
  pubkeyBytes(o.mintA).copy(b, 101);
  w(165, o.fgA ?? 0n);
  pubkeyBytes(o.mintB).copy(b, 181);
  w(245, o.fgB ?? 0n);
  return { data: b, owner: ORCA_PROGRAM };
}
function mintAccount(decimals: number, owner = TOKEN) {
  const b = Buffer.alloc(82);
  b[44] = decimals;
  b[45] = 1;
  return { data: b, owner };
}

test("pool addresses are worked out locally and match the two pools already followed", () => {
  assert.equal(whirlpoolAddress(SOL, USDC, 4), POOLS[0].address);
  assert.equal(whirlpoolAddress(USDC, SOL, 64), POOLS[1].address, "the order the mints are given in does not matter");
  assert.deepEqual(ordered(USDT, SOL), [SOL, USDT]);
  assert.equal(onCurve(pubkeyBytes(USDC)), true, "a token mint is an ordinary key");
  assert.equal(onCurve(pubkeyBytes(POOLS[0].address)), false, "a derived address is never one");
  assert.throws(() => pubkeyBytes("not-base58!"));
  assert.throws(() => pubkeyBytes(SOL + "11111111111111111111"), /longer/);
  assert.equal(findProgramAddress([Buffer.from("whirlpool")], ORCA_PROGRAM).length >= 43, true);
  const c = candidates();
  assert.equal(c.length, PAIRS.length * TICK_SPACINGS.length);
  assert.equal(new Set(c.map((x) => x.address)).size, c.length);
  assert.ok(!c.some((x) => POOLS.some((p) => p.address === x.address)), "the wider test never doubles the SOL/USDC pools");
});

test("discovery keeps the deepest pools of each pair and nothing it cannot check", async () => {
  const at = (pair: string, ts: number) => candidates().find((c) => c.pair.key === pair && c.tickSpacing === ts)!.address;
  const chain = new Map<string, { data: Buffer; owner: string }>([
    [SOL, mintAccount(9)],
    [USDT, mintAccount(6)],
    [JITOSOL, mintAccount(9)],
    [MSOL, mintAccount(9)],
    // cbBTC and the others: no mint account on this pretend chain
    [at("sol-usdt", 4), poolAccount({ mintA: SOL, mintB: USDT, decA: 9, decB: 6, p: 80, ts: 4, fee: 400, liquidity: 5n * 10n ** 15n })],
    [at("sol-usdt", 64), poolAccount({ mintA: SOL, mintB: USDT, decA: 9, decB: 6, p: 80.1, ts: 64, fee: 3000, liquidity: 10n ** 15n })],
    [at("sol-usdt", 2), poolAccount({ mintA: SOL, mintB: USDT, decA: 9, decB: 6, p: 82.5, ts: 2, fee: 200, liquidity: 2n * 10n ** 15n })], // 3% off: stale
    [at("sol-usdt", 8), poolAccount({ mintA: SOL, mintB: USDT, decA: 9, decB: 6, p: 80, ts: 8, fee: 500, liquidity: 0n })], // empty
    [at("sol-usdt", 16), poolAccount({ mintA: SOL, mintB: USDT, decA: 9, decB: 6, p: 80, ts: 16, fee: 1600, liquidity: 10n ** 14n })], // third deepest
    [at("sol-usdt", 1), { ...poolAccount({ mintA: SOL, mintB: USDT, decA: 9, decB: 6, p: 80, ts: 1, liquidity: 10n ** 18n }), owner: TOKEN }], // not Orca's
    [at("sol-usdt", 128), poolAccount({ mintA: SOL, mintB: USDC, decA: 9, decB: 6, p: 80, ts: 128, liquidity: 10n ** 18n })], // other mints
    [at("sol-usdt", 256), poolAccount({ mintA: SOL, mintB: USDT, decA: 9, decB: 6, p: 80, ts: 4, liquidity: 10n ** 18n })], // other tick spacing
    [at("jitosol-sol", 1), poolAccount({ mintA: SOL, mintB: JITOSOL, decA: 9, decB: 9, p: 0.8, ts: 1, fee: 100 })],
    [at("cbbtc-sol", 64), poolAccount({ mintA: SOL, mintB: CBBTC, decA: 9, decB: 8, p: 0.0008, ts: 64 })],
  ]);
  let calls = 0;
  const read = async (a: string[]) => (calls++, assert.ok(a.length <= 100), a.map((x) => chain.get(x) ?? null));
  const f = await discover(read, PAIRS, 1234);
  assert.equal(calls, 1, "one call: under 100 addresses");
  assert.deepEqual(f.pools.map((p) => p.key), ["orca-sol-usdt-ts4", "orca-sol-usdt-ts64", "orca-jitosol-sol-ts1"]);
  assert.deepEqual(f.none.sort(), ["cbbtc-sol", "jupsol-sol", "msol-sol", "wbtc-sol"]);
  const [usdt, , jito] = f.pools;
  assert.deepEqual([usdt.label, usdt.decA, usdt.decB, usdt.kind, usdt.swapCost, usdt.address], ["Orca SOL/USDT 0.04%", 9, 6, "volatile", 0.0008, at("sol-usdt", 4)]);
  assert.deepEqual([jito.label, jito.mintA, jito.mintB, jito.kind, f.pools[1].label], ["Orca jitoSOL/SOL 0.01%", SOL, JITOSOL, "pegged", "Orca SOL/USDT 0.3%"]);
  assert.deepEqual([f.version, f.at], [WIDE_VERSION, 1234]);
  // the saved answer: used as it is, refused if it is another version or names a pool this code could not have found
  assert.equal(validFound(JSON.parse(JSON.stringify(f)))!.pools.length, 3);
  assert.equal(validFound({ ...f, version: "wide-v0" }), null);
  assert.equal(validFound({ ...f, pools: [{ ...usdt, address: POOLS[0].address }] }), null);
  assert.equal(validFound({ ...f, pools: [{ ...usdt, key: "orca-sol-usdt-ts64" }] }), null);
  assert.equal(validFound(null), null);
  // a read that fails or comes back short saves nothing
  await assert.rejects(discover(async () => [null], PAIRS), /missing/);
  await assert.rejects(discover(async () => Promise.reject(new Error("down")), PAIRS), /down/);
  // decimals come from the mint account only
  assert.equal(mintDecimals(mintAccount(8)), 8);
  assert.equal(mintDecimals(mintAccount(8, ORCA_PROGRAM)), null);
  assert.equal(mintDecimals(null), null);
  assert.equal(mintDecimals({ data: Buffer.alloc(82), owner: TOKEN }), null, "not initialised");
});

test("a pool priced in another token is still scored in dollars", () => {
  const pool = { key: "orca-jitosol-sol-ts1", label: "Orca jitoSOL/SOL 0.01%", address: "x", mintA: SOL, mintB: JITOSOL, decA: 9, decB: 9, pair: "jitosol-sol", kind: "pegged" as const, swapCost: 0.0003 };
  assert.equal(rulesFor(pool), PEG_RULES);
  assert.equal(rulesFor(POOLS[0]), RULES);
  assert.deepEqual(PEG_RULES.map((r) => r.id), ["lp-w0p1", "lp-w0p25", "lp-w0p5", "lp-w1", "lp-w0p25-wait60", "lp-w0p5-wait240", "lp-w0p5-hold", "lp-w2-hold"]);
  assert.equal(PEG_RULES[1].text, "Puts $200 in the pool 0.25% either side of the price and re-centres as soon as the price leaves.");
  assert.deepEqual(RULES.map((r) => r.id), ["lp-w1", "lp-w2p5", "lp-w5", "lp-w10", "lp-w2p5-wait60", "lp-w5-wait60", "lp-w5-wait240", "lp-w10-hold", "lp-w20-hold"], "the SOL/USDC rules keep their names");
  assert.equal(RULES[1].text, "Puts $200 in the pool 2.5% either side of the price and re-centres as soon as the price leaves.");
  // SOL at $80, jitoSOL at 0.8 per SOL: one jitoSOL is $100
  assert.equal(usdOfB(pool, 0.8, 80), 100);
  assert.equal(usdOfB({ ...pool, mintB: USDT }, 80, 80), 1);
  assert.equal(usdOfB({ ...pool, mintA: MSOL, mintB: SOL }, 1.25, 80), 80);
  assert.equal(usdOfB({ ...pool, mintA: MSOL }, 1, 80), null);
  assert.equal(usdOfB(pool, 0.8, 0), null);
  const snap = (t: number, p: number, fgB = 0n) => ({ t, liquidity: 10n ** 18n, sqrtPrice: BigInt(Math.round(Math.sqrt(p) * 2 ** 32)) << 32n, tick: 0, tickSpacing: 1, feeRate: 0.0001, mintA: SOL, mintB: JITOSOL, feeGrowthA: 0n, feeGrowthB: fgB });
  const def = PEG_RULES[0];
  const s0 = snap(0, 0.8);
  const s = start(def, pool, s0, 100);
  assert.equal(s.stakeB, 2, "$200 is 2 jitoSOL");
  const cost = (STAKE / 2) * 0.0003 + TX_USD; // the pair's own swap cost, and the network fee, in dollars
  assert.ok(Math.abs(netUsd(s, price(s0, 9, 9)) + cost) < 1e-9);
  assert.ok(Math.abs(vsHold(s, price(s0, 9, 9))) < 1e-9);
  // the counter pays one unit of liquidity 1e-12 raw jitoSOL
  const mine = rawLiquidity(s.range.L, 9, 9);
  const s1 = snap(30_000, 0.8, BigInt(Math.round(1e-12 * 2 ** 64)));
  step(s, def, pool, s0, s1, 100);
  const feeB = ((1e-12 * mine) / 1e9) * (1e18 / (1e18 + mine));
  assert.ok(Math.abs(s.fees - feeB) / feeB < 1e-6, "fees are kept in the pool's token");
  const row = summarize(s, def, pool);
  assert.equal(row.fees, Math.round(feeB * 100 * 100) / 100, "and shown in dollars");
  assert.ok(Math.abs(row.vsHold - row.fees) < 0.011 && row.net < 0);
  assert.deepEqual([row.open.price, row.open.lo, row.open.hi], [0.8, 0.7992, 0.8008], "small prices keep their figures");
  // SOL rises 10%: the tokens are worth more in dollars, the score against holding them does not move
  const before = vsHold(s, 0.8);
  step(s, def, pool, s1, snap(60_000, 0.8, s1.feeGrowthB), 110);
  assert.equal(s.usdB, 110);
  assert.ok(Math.abs(netUsd(s, 0.8) - (netUsd(s, 0.8, 100) + 200 * 0.1 + (netUsd(s, 0.8, 100)) * 0.1)) < 1e-6);
  assert.ok(Math.abs(vsHold(s, 0.8) - before * 1.1) < 1e-9);
  // a re-centring is charged at the pair's cost; the SOL/USDC rules are charged what they always were
  const out = snap(90_000, 0.81, s1.feeGrowthB);
  step(s, def, pool, snap(60_000, 0.8, s1.feeGrowthB), out, 110);
  assert.equal(s.cycles, 1);
  assert.ok(s.range.lo < 0.81 && s.range.hi > 0.81 && s.costs > cost / 100);
  const usdc = start(RULES[2], POOLS[0], { ...s0, sqrtPrice: BigInt(Math.round(Math.sqrt(160 / 1000) * 2 ** 32)) << 32n, mintB: USDC });
  assert.deepEqual([usdc.stakeB, usdc.usdB], [undefined, undefined]);
  assert.ok(Math.abs(usdc.costs - ((STAKE / 2) * 0.0006 + TX_USD)) < 1e-12);
});

test("the runner follows the extra pools next to SOL/USDC, and a pool that cannot be read stops nothing", async () => {
  _lpTest.reset();
  const at = (pair: string, ts: number) => candidates().find((c) => c.pair.key === pair && c.tickSpacing === ts)!.address;
  let fg = 0n;
  let gone = "";
  let big = 0;
  const chain = (): Map<string, { data: Buffer; owner: string }> =>
    new Map([
      [SOL, mintAccount(9)],
      [USDT, mintAccount(6)],
      [JITOSOL, mintAccount(9)],
      ...POOLS.map((p, i) => [p.address, poolAccount({ mintA: SOL, mintB: USDC, decA: 9, decB: 6, p: 80, ts: i ? 64 : 4, fgA: fg, fgB: fg })] as [string, { data: Buffer; owner: string }]),
      [at("sol-usdt", 4), poolAccount({ mintA: SOL, mintB: USDT, decA: 9, decB: 6, p: 80, ts: 4, fgA: fg, fgB: fg })],
      [at("jitosol-sol", 1), poolAccount({ mintA: SOL, mintB: JITOSOL, decA: 9, decB: 9, p: 0.8, ts: 1, fee: 100, fgA: fg, fgB: fg })],
    ]);
  const rpc = (async (_url: string, init: { body: string }) => {
    const asked = JSON.parse(init.body).params[0] as string[];
    if (asked.length > 20) big++;
    fg += 1000n;
    const c = chain();
    return new Response(JSON.stringify({ result: { value: asked.map((a) => (a === gone ? null : c.get(a) ? { data: [c.get(a)!.data.toString("base64"), "base64"], owner: c.get(a)!.owner } : null)) } }));
  }) as unknown as typeof fetch;
  await tick(rpc);
  await tick(rpc);
  type Sum = { rules: { pool: string }[]; rulesTried: number; health: { reads: number }; wide: { found: boolean; error: string; noPool: string[]; rulesTried: number; pools: { key: string; problem: string; rules: number; price: number }[]; rows: { id: string; pool: string; net: number; vsHold: number }[]; texts: Record<string, string> } };
  let sum = solanaSummary() as Sum;
  assert.equal(big, 1, "the chain is asked for the pool list once");
  assert.deepEqual([sum.rules.length, sum.rulesTried, sum.health.reads], [POOLS.length * RULES.length, 18, 2], "the SOL/USDC part is what it was");
  assert.ok(sum.rules.every((r) => POOLS.some((p) => p.key === r.pool)));
  assert.deepEqual([sum.wide.found, sum.wide.error, sum.wide.rulesTried], [true, "", RULES.length + PEG_RULES.length]);
  assert.deepEqual(sum.wide.pools.map((p) => [p.key, p.rules, p.problem, p.price]), [["orca-sol-usdt-ts4", 9, "", 80], ["orca-jitosol-sol-ts1", 8, "", 0.8]]);
  assert.deepEqual(sum.wide.noPool.sort(), ["cbbtc-sol", "jupsol-sol", "msol-sol", "wbtc-sol"]);
  const jito = sum.wide.rows.find((r) => r.pool === "orca-jitosol-sol-ts1" && r.id === "lp-w0p1")!;
  assert.ok(jito.net < 0 && jito.net > -0.2, `$200 of staked SOL, in dollars: ${jito.net}`);
  assert.ok(sum.wide.texts["lp-w0p1"].includes("0.1% either side"));
  assert.ok(existsSync(join(dir, "solana-lp-pools.json")));
  assert.ok(existsSync(join(dir, "solana")) && readFileSync(join(dir, "solana-lp.json"), "utf8").includes('"wide"'));
  // one extra pool vanishes: it is named, the other pools and SOL/USDC carry on
  gone = at("jitosol-sol", 1);
  await tick(rpc);
  sum = solanaSummary() as Sum;
  assert.deepEqual([sum.health.reads, sum.wide.pools.map((p) => p.problem)], [3, ["", "account not found"]]);
  // after a restart the saved list is used: the chain is not asked again
  gone = "";
  _lpTest.reset();
  await tick(rpc);
  assert.deepEqual([big, _lpTest.wide().found!.pools.length, _lpTest.wide().health.tries], [1, 2, 0]);
  // the lookup failing is not an error of the SOL/USDC test, and is tried again later
  _lpTest.reset();
  const { unlinkSync } = await import("node:fs");
  unlinkSync(join(dir, "solana-lp-pools.json"));
  const short = (async (_url: string, init: { body: string }) => {
    const asked = JSON.parse(init.body).params[0] as string[];
    if (asked.length > 20) return new Response("{}", { status: 429 });
    const c = chain();
    return new Response(JSON.stringify({ result: { value: asked.map((a) => ({ data: [c.get(a)!.data.toString("base64"), "base64"] })) } }));
  }) as unknown as typeof fetch;
  await tick(short);
  await tick(short);
  sum = solanaSummary() as Sum;
  assert.deepEqual([sum.health.reads, sum.wide.found, sum.wide.rulesTried, _lpTest.wide().health.tries], [2, false, 0, 1]);
  assert.ok(sum.wide.error.startsWith("the pools could not be looked up"));
  assert.equal((sum.health as unknown as { errors: number }).errors, 0);
});
