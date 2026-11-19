import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as B from "./basecopy.js";
import * as L from "./baselive.js";
import { LIFI_DIAMOND } from "../bridge/real.js";
import { inspectSwap, toRaw, type SwapReq } from "./basereal.js";

const now = Date.UTC(2026, 10, 19, 7, 0);
const addr = (n: number) => "0x" + String(n).padStart(40, "0");
const token = addr(1001);
const W = addr(5);
const SW = (over: Record<string, unknown> = {}) => JSON.stringify({ baseCopy: { on: true, stakeUsd: 10, maxOpen: 2, maxLossUsd: 15, gasKeepEth: 0.0005, ...over } });

function world(sw: string | null) {
  const paper: B.BaseState = { coins: { [token]: { symbol: "AERO", token, pool: addr(1), mcapUsd: 5e7, liqUsd: 1e6, px: 2, pxAt: now } }, wallets: {}, seen: {}, open: [], done: [] };
  // wallet W is at the bar: 10 paper copies, 6 won, ahead
  for (let i = 0; i < 10; i++) paper.done.push({ wallet: W, symbol: "AERO", at: now - 9e6, closedAt: now - 8e6, usd: i < 6 ? 5 : -3, why: "sold" });
  const st = L.emptyLive();
  const w = { usdc: 100, eth: 0.002, coins: 0n, sends: [] as string[], failBuy: "", failSell: "", wallet: true, sw };
  const d: L.Deps = {
    switch: () => (w.sw ? L.parseSwitch(w.sw) : null),
    hasWallet: () => w.wallet,
    balances: async () => ({ usdc: w.usdc, eth: w.eth }),
    held: async () => w.coins,
    buy: async (_t, usd, px) => {
      if (w.failBuy === "before") throw new Error("the route's price is worse than the limit");
      w.sends.push("buy " + usd);
      w.usdc -= usd;
      const got = BigInt(Math.round((usd / px) * 0.99 * 1e6)) * 10n ** 12n;
      w.coins += got;
      if (w.failBuy === "after") throw new Error("sent, not seen on chain yet");
      return { raw: got, decimals: 18 };
    },
    sell: async (_t, raw, px) => {
      if (w.failSell === "before") throw new Error("the route finder gave no route");
      w.sends.push("sell");
      const got = (Number(raw) / 1e18) * px * 0.99;
      w.coins -= raw;
      w.usdc += got;
      if (w.failSell === "after") throw new Error("sent, not seen on chain yet");
      return got;
    },
  };
  const open = (stakeUsd = 100): B.Event[] => {
    const copy: B.Copy = { wallet: W, token, symbol: "AERO", at: now, px: 2, leaderPx: 2, stakeUsd, left: 1 };
    paper.open.push(copy);
    return [{ kind: "open", copy }];
  };
  const close = (): B.Event[] => {
    paper.open = [];
    return [{ kind: "close", key: B.keyOf({ wallet: W, token }) }];
  };
  return { paper, st, w, d, open, close, run: (ev: B.Event[], t = now) => L.liveRound(st, paper, ev, d, t, () => undefined) };
}

test("base real: no switch, switch off or no wallet = nothing is ever sent", async () => {
  for (const sw of [null, "{}", SW({ on: false }), SW({ on: "true" }), "not json"]) {
    const x = world(sw);
    await x.run(x.open());
    assert.deepEqual(x.w.sends, [], String(sw));
  }
  const x = world(SW());
  x.w.wallet = false;
  await x.run(x.open());
  assert.deepEqual(x.w.sends, []);
});

test("base real: the switch is pressed inside the hard limits", () => {
  const s = L.parseSwitch(SW({ stakeUsd: 5000, maxOpen: 99, maxLossUsd: 1e6, gasKeepEth: 0 }))!;
  assert.equal(s.stakeUsd, L.HARD.stakeUsd);
  assert.equal(s.maxOpen, L.HARD.maxOpen);
  assert.equal(s.maxLossUsd, L.HARD.maxLossUsd);
  assert.ok(s.gasKeepEth >= L.HARD.minGasKeepEth);
  const copy = { wallet: W, token, symbol: "A", at: 0, px: 1, leaderPx: 1, stakeUsd: 200 };
  assert.equal(L.sizeUsd(s, copy), L.HARD.stakeUsd * 2, "double conviction on the largest stake is the most a buy can be");
  assert.equal(L.sizeUsd(L.parseSwitch(SW())!, { ...copy, stakeUsd: 50 }), 5);
});

test("deploy/live-rules.json: the real Base copy is off until enrique gives sizes", () => {
  const s = L.parseSwitch(readFileSync(join(process.cwd(), "deploy", "live-rules.json"), "utf8"));
  assert.ok(!s || !s.on || (s.stakeUsd <= L.HARD.stakeUsd && s.maxOpen <= L.HARD.maxOpen));
});

test("base real: only a wallet at the paper bar is copied; bought by conviction, part sold with the wallet, closed with it", async () => {
  const x = world(SW());
  x.paper.done.length = 5; // only 5 paper copies: not at the bar
  await x.run(x.open());
  assert.deepEqual(x.w.sends, []);
  const y = world(SW());
  await y.run(y.open(200));
  assert.deepEqual(y.w.sends, ["buy 20"]);
  assert.equal(y.st.positions.length, 1);
  assert.equal(y.st.positions[0].stage, "held");
  // the wallet sells 40%: we sell 40% of ours
  const before = y.w.coins;
  await y.run([{ kind: "part", key: B.keyOf({ wallet: W, token }), share: 0.4 }]);
  assert.equal(y.w.coins, before - (before * 400_000n) / 1_000_000n);
  assert.equal(y.st.positions[0].parts, 1);
  // then everything, at $2.40
  y.paper.coins[token].px = 2.4;
  await y.run(y.close());
  assert.equal(y.w.coins, 0n);
  assert.equal(y.st.positions.length, 0);
  assert.equal(y.st.closed.length, 1);
  // 9.9 coins: 3.96 sold at $2, 5.94 at $2.40, 1% lost each time: about +1.96 on $20
  assert.ok(Math.abs(y.st.closed[0].usd - (3.96 * 2 * 0.99 + 5.94 * 2.4 * 0.99 - 20)) < 1e-3, String(y.st.closed[0].usd));
  assert.ok(Math.abs(y.w.usdc - (100 + y.st.closed[0].usd)) < 1e-3, "the record is the wallet's own dollars");
});

test("base real: no buy with gas low, no cash, the book full, the loss stop hit or the wallet behind on real", async () => {
  const run = async (prep: (x: ReturnType<typeof world>) => void) => {
    const x = world(SW());
    prep(x);
    await x.run(x.open());
    return x;
  };
  assert.deepEqual((await run((x) => void (x.w.eth = 0.0001))).st.skipped, { "gas low": 1 });
  assert.deepEqual((await run((x) => void (x.w.usdc = 6))).st.skipped, { "no cash": 1 });
  const pos = (n: number): L.Pos => ({ key: "k" + n, wallet: addr(70 + n), token: addr(2000 + n), symbol: "X", at: now, stage: "buying", usdcIn: 5, raw: "0", decimals: 18, backUsd: 0, parts: 0 });
  assert.deepEqual((await run((x) => void x.st.positions.push(pos(1), pos(2)))).st.skipped, { full: 1 });
  const lost = (wallet: string, usd: number): L.Closed => ({ t: now, at: now, wallet, symbol: "X", usdcIn: 10, usd, parts: 0 });
  assert.deepEqual((await run((x) => void x.st.closed.push(lost(addr(9), -16)))).st.skipped, { "loss stop": 1 });
  assert.deepEqual((await run((x) => void x.st.closed.push(lost(W, -1), lost(W, -1), lost(W, 1)))).st.skipped, { "wallet behind on real": 1 });
  // a new resetId lifts the loss stop from where the record stands
  const x = world(SW({ resetId: "r2" }));
  x.st.closed.push(lost(addr(9), -16));
  await x.run(x.open());
  assert.deepEqual(x.w.sends, ["buy 10"]);
});

test("base real: switched off while holding, the coin is still sold when the wallet sells", async () => {
  const x = world(SW());
  await x.run(x.open());
  x.w.sw = SW({ on: false });
  await x.run(x.open()); // a second copy event: no buy
  assert.deepEqual(x.w.sends, ["buy 10"]);
  await x.run(x.close());
  assert.deepEqual(x.w.sends, ["buy 10", "sell"]);
  assert.equal(x.st.positions.length, 0);
  // and a missed close (a restart) is caught by the paper copy being gone
  const y = world(SW());
  await y.run(y.open());
  y.paper.open = [];
  await y.run([]);
  assert.deepEqual(y.w.sends, ["buy 10", "sell"]);
});

test("base real: nothing is sent twice: a send whose receipt was not seen is settled by the wallet's balance", async () => {
  const x = world(SW());
  x.w.failBuy = "after";
  await x.run(x.open());
  assert.deepEqual(x.w.sends, ["buy 10"]);
  assert.equal(x.st.positions[0].stage, "held", "the coins are in the wallet: it was bought");
  await x.run([]);
  assert.deepEqual(x.w.sends, ["buy 10"], "no second buy");
  x.w.failBuy = "";
  x.w.failSell = "after";
  await x.run(x.close());
  assert.deepEqual(x.w.sends, ["buy 10", "sell"]);
  assert.equal(x.st.positions.length, 0);
  assert.equal(x.st.closed[0].est, true);
  await x.run([]);
  assert.deepEqual(x.w.sends, ["buy 10", "sell"]);
  // a buy refused before sending leaves no position after the wait
  const y = world(SW());
  y.w.failBuy = "before";
  await y.run(y.open());
  assert.deepEqual(y.w.sends, []);
  await y.run([], now + L.BUY_WAIT_MS + 1000);
  assert.equal(y.st.positions.length, 0);
  // a sale refused before sending is tried again next round
  const z = world(SW());
  await z.run(z.open());
  z.w.failSell = "before";
  await z.run(z.close());
  assert.equal(z.st.positions.length, 1);
  z.w.failSell = "";
  await z.run([]);
  assert.equal(z.st.positions.length, 0);
});

test("base real: the once-test buys a little of the deepest coin and sells it straight back, once per id", async () => {
  const x = world(SW({ on: false, testOnce: "t1" }));
  await x.run([]);
  assert.deepEqual(x.w.sends, ["buy " + L.HARD.testUsd, "sell"]);
  assert.equal(x.st.closed[0].test, true);
  await x.run([]);
  assert.equal(x.w.sends.length, 2);
  assert.equal(L.summary(x.st, x.paper, x.d.switch(), true, now).closed, 0, "a test is not a copy in the record");
});

const me = addr(42);
const req: SwapReq = { wallet: me, fromToken: addr(7), toToken: token, amount: 10_000_000n, minOut: 4_800_000n };
const good = () => ({
  action: { fromChainId: 8453, toChainId: 8453, fromToken: { address: addr(7) }, toToken: { address: token }, fromAmount: "10000000", fromAddress: me, toAddress: me },
  estimate: { toAmount: "5000000", toAmountMin: "4950000", approvalAddress: LIFI_DIAMOND },
  transactionRequest: { to: LIFI_DIAMOND, data: "0xabcdef" + me.slice(2) + "00", value: "0x0", chainId: 8453 },
});
test("base real: a route is signed only when it is exactly what was asked", () => {
  assert.deepEqual(inspectSwap(req, good()).bad, []);
  const cases: [string, (g: ReturnType<typeof good>) => void][] = [
    ["another chain", (g) => void (g.action.toChainId = 1)],
    ["another token out", (g) => void (g.action.toToken.address = addr(8))],
    ["another token in", (g) => void (g.action.fromToken.address = addr(8))],
    ["another amount", (g) => void (g.action.fromAmount = "99000000")],
    ["pays someone else", (g) => void (g.action.toAddress = addr(66))],
    ["another contract", (g) => void (g.transactionRequest.to = addr(66))],
    ["allowance elsewhere", (g) => void (g.estimate.approvalAddress = addr(66))],
    ["carries ETH", (g) => void (g.transactionRequest.value = "0x1")],
    ["wrong chain id", (g) => void (g.transactionRequest.chainId = 1)],
    ["bytes without our wallet", (g) => void (g.transactionRequest.data = "0xabcdef")],
    ["bad price", (g) => void (g.estimate.toAmountMin = "4000000")],
  ];
  for (const [name, breakIt] of cases) {
    const g = good();
    breakIt(g);
    const r = inspectSwap(req, g);
    assert.ok(r.bad.length > 0 && r.swap === null, name);
  }
  assert.equal(inspectSwap(req, { message: "no route" }).swap, null);
  assert.equal(toRaw(10, 6), 10_000_000n);
  assert.equal(toRaw(1.5, 18), 1_500_000_000_000_000_000n);
});
