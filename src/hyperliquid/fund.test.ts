import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hlfund-"));
const { saveJson, loadJson } = await import("../store.js");
import type { Chain, FundState } from "./fund.js";
const { fund, nextStep, check, HL_BRIDGE, KEEP_GAS_USD, TEST_USDC } = await import("./fund.js");
type C = Chain;

const ME = "0x00000000000000000000000000000000000000Aa";
/** A pretend Arbitrum + Hyperliquid: ETH at 3000, the pool 0.1% under, deposits credited after `lag` sleeps. */
function fake(o: { hlDown?: boolean; ref?: number; eth?: number; usdc?: number; mid?: number; pool?: number; lag?: number; bridge?: number; chain?: number; credit?: boolean } = {}) {
  const s = { eth: o.eth ?? 0.05, usdc: o.usdc ?? 0, hl: 0, listed: 0, queue: [] as { n: number; usdc: number }[], swaps: [] as number[], deposits: [] as number[] };
  const mid = o.mid ?? 3000;
  const c: C = {
    address: ME,
    chainId: async () => o.chain ?? 42161,
    hasCode: async () => true,
    usdcMeta: async () => ({ symbol: "USDC", decimals: 6 }),
    eth: async () => s.eth,
    usdc: async (a) => (a === HL_BRIDGE ? o.bridge ?? 3e9 : s.usdc),
    quote: async (eth) => eth * (o.pool ?? mid * 0.999),
    hlEthMid: async () => (o.hlDown ? Promise.reject(new Error("aborted due to timeout")) : mid),
    refPrice: async () => o.ref ?? mid,
    hlValue: async () => (o.hlDown ? Promise.reject(new Error("aborted due to timeout")) : s.hl),
    hlDeposited: async () => s.listed,
    swap: async (eth, min) => {
      const got = eth * (o.pool ?? mid * 0.999);
      if (got < min) throw new Error("swap reverted: under the floor");
      s.eth -= eth + 0.00002;
      s.usdc += got;
      s.swaps.push(eth);
      return "0xswap";
    },
    deposit: async (usdc) => {
      if (usdc > s.usdc + 1e-9) throw new Error("not enough USDC");
      s.usdc -= usdc;
      s.deposits.push(usdc);
      if (o.credit !== false) s.queue.push({ n: o.lag ?? 1, usdc });
      return "0xdep";
    },
    sleep: async () => {
      for (const q of s.queue) if (--q.n === 0) (s.hl += q.usdc), (s.listed += q.usdc);
    },
  };
  return { c, s };
}
beforeEach(() => saveJson("hyperliquid-fund.json", {}));

test("a dry run signs nothing and says the whole plan", async () => {
  const { c, s } = fake();
  const r = await fund(c);
  assert.equal(r.dry, true);
  assert.deepEqual([s.swaps, s.deposits], [[], []]);
  assert.match(r.steps[0], /would swap 0\.049 ETH for about 146\.85 USDC \(floor 145\.53\), keeping 0\.001 ETH/);
  assert.match(r.steps[1], /would deposit 6 USDC as a test.*then deposit the other 140\.85/);
});

test("for real: swap keeping gas, test deposit, wait for Hyperliquid, then the rest", async () => {
  const { c, s } = fake({ lag: 3 });
  const r = await fund(c, { go: true });
  assert.deepEqual(s.swaps, [0.049]);
  assert.deepEqual(s.deposits, [TEST_USDC, 140.85]);
  assert.ok(s.eth * 3000 > KEEP_GAS_USD - 0.1, "the gas reserve stays");
  assert.equal(r.hlUsd, 146.85);
  assert.equal(r.done, true);
  assert.equal(r.usdc < 0.01, true);
});

test("the rest is never sent while the test deposit has not shown on Hyperliquid", async () => {
  const { c, s } = fake({ credit: false });
  const r = await fund(c, { go: true, waitMs: 0 });
  assert.deepEqual(s.deposits, [TEST_USDC]);
  assert.equal(r.done, false);
  const again = await fund(c, { go: true, waitMs: 0 });
  assert.deepEqual(s.deposits, [TEST_USDC], "a second run still waits");
  assert.match(again.steps.join(" "), /not on Hyperliquid yet/);
  s.hl = TEST_USDC; // it arrives
  await fund(c, { go: true, waitMs: 0 });
  assert.deepEqual(s.deposits, [TEST_USDC, 140.85]);
});

test("a swap priced more than 1% under Hyperliquid's ETH price is refused", async () => {
  const { c, s } = fake({ pool: 2960 });
  const r = await fund(c, { go: true });
  assert.deepEqual(s.swaps, []);
  assert.match(r.steps[0], /under Hyperliquid's ETH price/);
});

test("wrong chain or a bridge address with no money stops everything", async () => {
  assert.match((await check(fake({ chain: 1 }).c))[0], /not Arbitrum One/);
  const { c, s } = fake({ bridge: 12 });
  const r = await fund(c, { go: true });
  assert.match(r.problems[0], /not the Hyperliquid bridge/);
  assert.deepEqual([s.swaps, s.deposits], [[], []]);
});

test("a deposit that failed before leaving is cleared, one that may have left is not", async () => {
  const { c, s } = fake({ eth: 0.001, usdc: 50 });
  const p: FundState = { pending: { usdc: 6, before: 0, walletUsdc: 50, at: Date.now() - 300_000, tx: "", test: true } };
  saveJson("hyperliquid-fund.json", p);
  const r = await fund(c);
  assert.match(r.steps[0], /never left the wallet/);
  assert.equal(loadJson<FundState>("hyperliquid-fund.json", {}).pending, undefined);
  s.usdc = 44; // the USDC is gone: it left
  saveJson("hyperliquid-fund.json", p);
  await fund(c, { go: true, waitMs: 0 });
  assert.deepEqual(s.deposits, []);
  assert.ok(loadJson<FundState>("hyperliquid-fund.json", {}).pending);
});

test("Hyperliquid unreachable: the swap is still planned and made (priced against Chainlink), the deposit waits", async () => {
  const { c, s } = fake({ hlDown: true });
  const dry = await fund(c);
  assert.match(dry.steps.join(" | "), /cannot be reached.*\| would swap 0\.049 ETH for about 146\.85 USDC.*\| the deposit of the USDC would wait/);
  assert.equal(dry.hlUsd, null);
  const r = await fund(c, { go: true });
  assert.deepEqual([s.swaps, s.deposits], [[0.049], []]);
  assert.match(r.steps[r.steps.length - 1], /waits in the wallet/);
  // a pool far from the second price is refused just the same
  const off = fake({ hlDown: true, ref: 3100 });
  await fund(off.c, { go: true });
  assert.deepEqual(off.s.swaps, []);
});

test("small amounts: only the gas reserve does nothing; a small balance goes in one deposit", () => {
  assert.equal(nextStep({ eth: 0.001, usdc: 0, mid: 3000, quotePerEth: null }, {}).do, "nothing");
  assert.deepEqual(nextStep({ eth: 0.001, usdc: 9.127, mid: 3000, quotePerEth: null }, {}), { do: "deposit", usdc: 9.12, test: false });
  assert.equal(nextStep({ eth: 0.001, usdc: 4, mid: 3000, quotePerEth: null }, {}).do, "nothing");
  assert.deepEqual(nextStep({ eth: 0.001, usdc: 80, mid: 3000, quotePerEth: null }, { proven: true }), { do: "deposit", usdc: 80, test: false });
});

test("the real chain link: plain JSON-RPC reads, and a swap signed by the wallet for Arbitrum and nothing else", async () => {
  const { parse } = await import("@ethersproject/transactions");
  const { hlWallet } = await import("./keys.js");
  const { realChain, rpcCall, SWAP_ROUTER, ARBITRUM_CHAIN_ID } = await import("./fund.js");
  const me = hlWallet().address;
  const calls: { method: string; params: unknown[] }[] = [];
  const net = (async (_u: string | URL | Request, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push({ method, params });
    const result = ({ eth_chainId: "0xa4b1", eth_getBalance: "0xb1a2bc2ec50000", eth_getCode: "0x60", eth_estimateGas: "0x30d40", eth_gasPrice: "0x989680", eth_getTransactionCount: "0x7", eth_sendRawTransaction: "0xhash", eth_getTransactionReceipt: { status: "0x1" } } as Record<string, unknown>)[method];
    return new Response(JSON.stringify(result === undefined ? { error: { message: "execution reverted" } } : { result }));
  }) as typeof fetch;
  const c = realChain(me, net);
  assert.equal(await c.chainId(), 42161);
  assert.equal(await c.eth(me), 0.05);
  assert.equal(await c.hasCode(SWAP_ROUTER), true);
  assert.equal(await c.swap(0.049, 145.53), "0xhash");
  const raw = calls.find((x) => x.method === "eth_sendRawTransaction")!.params[0] as string;
  const tx = parse(raw);
  assert.deepEqual([tx.from, tx.to, tx.chainId, tx.nonce, tx.value.toString(), tx.gasLimit.toNumber()], [me, SWAP_ROUTER, ARBITRUM_CHAIN_ID, 7, "49000000000000000", 260000]);
  await assert.rejects(rpcCall("eth_call", [], net), /arbitrum eth_call: execution reverted/);
  let tries = 0;
  const dead = (async () => (tries++, Promise.reject(new Error("aborted due to timeout")))) as unknown as typeof fetch;
  await assert.rejects(rpcCall("eth_chainId", [], dead), /arbitrum eth_chainId: aborted due to timeout/);
  assert.equal(tries, 2);
});

test("the public history says what was swapped, what Hyperliquid has shown, and what is still on its way (no transaction ids)", async () => {
  const { fundHistory } = await import("./fund.js");
  const stuck = fake({ credit: false });
  await fund(stuck.c, { go: true, waitMs: 0 });
  const h1 = fundHistory();
  assert.deepEqual([h1.swappedEth, h1.depositedUsdcSeenOnHyperliquid, h1.testDepositSeen, h1.inTransit?.usdc, h1.inTransit?.sent], [0.049, 0, false, 6, true]);
  saveJson("hyperliquid-fund.json", {});
  const { c } = fake({ lag: 2 });
  await fund(c, { go: true });
  const h = fundHistory();
  assert.deepEqual([h.swappedEth, h.gotUsdc, h.depositedUsdcSeenOnHyperliquid, h.testDepositSeen, h.inTransit], [0.049, 146.85, 146.85, true, null]);
  assert.deepEqual(h.steps.map((x) => [x.what, x.amount]), [["swap", 0.049], ["test deposit", 6], ["deposit", 140.85]]);
  assert.equal(JSON.stringify(h).includes("0x"), false);
});
