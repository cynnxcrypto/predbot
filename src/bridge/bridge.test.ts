import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "bridge-"));
const { saveJson } = await import("../store.js");
import type { Deps, Order, PlaceInfo, Quote, QuoteReq } from "./bridge.js";
import type { Place } from "./state.js";
const { bridgeTick, checkOrder, guard, parseOrder, parts, bridgePublic, scrub, _test, TEST_USD, HL_WITHDRAW_FEE, ARRIVE_WAIT_MS, WITHDRAW_WAIT_MS, UNSENT_WAIT_MS, MAX_TRIES } = await import("./bridge.js");
const { loadBridge, bridgeHoldsHyperliquid } = await import("./state.js");
const { readQuote, inspectEvm, inspectSolana, LIFI_DIAMOND, tokenAddress, _setBaseUsdc } = await import("./real.js");

const HL = "0x00000000000000000000000000000000000000Aa";
const PM = "0x00000000000000000000000000000000000000Bb";
const SOLP = "So1PerpsWa11et11111111111111111111111111111";
const INFO: Record<Place, PlaceInfo> = {
  hyperliquid: { chain: "arbitrum", address: HL, token: "USDC" },
  polymarket: { chain: "polygon", address: PM, token: "USDC" },
  base: { chain: "base", address: "0x00000000000000000000000000000000000000Cc", token: "USDC" },
  "solana-perps": { chain: "solana", address: SOLP, token: "USDC" },
  "solana-spot-rules": { chain: "solana", address: "So1Ru1es", token: "SOL" },
  "solana-spot-copy": { chain: "solana", address: "So1Copy", token: "SOL" },
};

/** A pretend world: wallets, Hyperliquid, and a bridge that takes `fee` and delivers after `lag` looks. */
function world(o: { order?: Order | null; bal?: Partial<Record<Place, number>>; hl?: number; fee?: number; lag?: number; sol?: number; payTo?: string; sendFails?: boolean; never?: boolean; hlRefuses?: boolean; inspect?: string[]; status?: "done" | "pending" | "failed" | "unknown" } = {}) {
  const s = {
    t: 1_000_000,
    order: o.order ?? null,
    bal: { hyperliquid: 0, polymarket: 0, base: 0, "solana-perps": 0, "solana-spot-rules": 0, "solana-spot-copy": 0, ...o.bal } as Record<Place, number>,
    hl: o.hl ?? 0,
    queue: [] as { n: number; to: Place; amount: number }[],
    sends: [] as number[],
    withdrawals: [] as number[],
    quotes: 0,
  };
  const placeOf = (p: PlaceInfo) => (Object.keys(INFO) as Place[]).find((k) => INFO[k].address === p.address)!;
  const land = () => {
    for (const q of s.queue) if (--q.n <= 0) s.bal[q.to] += q.amount;
    s.queue = s.queue.filter((q) => q.n > 0);
  };
  const px = (p: PlaceInfo) => (p.token === "SOL" ? o.sol ?? 200 : 1);
  const d: Deps = {
    order: () => s.order,
    place: (p) => INFO[p],
    balance: async (p) => s.bal[placeOf(p)],
    watch: async (p) => s.bal[p],
    solUsd: async () => o.sol ?? 200,
    quote: async (r) => {
      s.quotes++;
      const out = (r.amount * px(r.from) - (o.fee ?? 0.3)) / px(r.to);
      return { tool: "testbridge", minutes: 2, toAmount: out, toAmountMin: out, echo: { fromChain: r.from.chain, toChain: r.to.chain, fromToken: r.from.token, toToken: r.to.token, fromAddress: r.from.address, toAddress: o.payTo ?? r.to.address, fromAmount: r.amount }, tx: r.from.chain === "solana" ? { kind: "solana", data: "AA==" } : { kind: "evm", to: LIFI_DIAMOND, data: "0x", value: "0x0", chainId: 42161, approval: LIFI_DIAMOND } };
    },
    inspect: async () => o.inspect ?? [],
    send: async (r, q) => {
      if (o.sendFails) throw new Error("the transaction never landed");
      s.bal[placeOf(r.from)] -= r.amount;
      s.sends.push(r.amount);
      if (!o.never) s.queue.push({ n: o.lag ?? 1, to: placeOf(r.to), amount: q.toAmountMin });
      return "tx" + s.sends.length;
    },
    status: async () => o.status ?? "pending",
    hlFree: async () => s.hl,
    hlWithdraw: async (usd) => {
      if (o.hlRefuses) throw new Error("refused: Insufficient balance for withdrawal");
      s.hl -= usd;
      s.withdrawals.push(usd);
      s.queue.push({ n: 2, to: "hyperliquid", amount: usd - HL_WITHDRAW_FEE });
    },
    now: () => s.t,
  };
  const look = async (n = 1, stepMs = 20_000) => {
    let r = null;
    for (let i = 0; i < n; i++) {
      land();
      r = await bridgeTick(d);
      s.t += stepMs;
    }
    return r;
  };
  return { s, d, look };
}

beforeEach(() => {
  saveJson("bridge-state.json", { moves: {} });
  _test.reset();
});
const order = (o: Partial<Order> = {}): Order => ({ id: "perps-to-hl-1", from: "solana-perps", to: "hyperliquid", usd: 100, mode: "go", ...o });

test("no order: nothing happens, nothing is asked", async () => {
  const w = world();
  assert.equal(await w.look(3), null);
  assert.equal(w.s.quotes, 0);
});

test("orders: only our places, limits, and what is not built is refused in words", () => {
  assert.deepEqual(checkOrder(order()), []);
  assert.match(checkOrder(order({ usd: 251 }))[0], /15 to 250/);
  assert.match(checkOrder(order({ usd: 5 }))[0], /15 to 250/);
  assert.match(checkOrder(order({ to: "solana-perps" }))[0], /same place/);
  assert.deepEqual(checkOrder(order({ from: "polymarket" })), []);
  assert.deepEqual(checkOrder(order({ from: "base", to: "polymarket" })), []);
  assert.match(checkOrder(order({ from: "solana-perps", to: "solana-spot-copy" }))[0], /two Solana wallets/);
  assert.match(checkOrder(order({ to: "0xdeadbeef" as Place }))[0], /one of/);
  assert.match(checkOrder(order({ id: "" }))[0], /id/);
  assert.equal(parseOrder("{}"), null);
  assert.equal(parseOrder('{"bridge":{"order":null}}'), null);
  assert.equal(parseOrder("not json"), null);
  // anything but the exact word is a dry run
  assert.equal(parseOrder('{"bridge":{"order":{"id":"a-1","from":"solana-perps","to":"hyperliquid","usd":50,"mode":"GO"}}}')!.mode, "dry");
  assert.equal(parseOrder('{"bridge":{"order":{"id":"a-1","from":"solana-perps","to":"hyperliquid","usd":50,"mode":"go"}}}')!.mode, "go");
});

test("a dry run prices both parts, signs nothing and writes no move", async () => {
  const w = world({ order: order({ mode: "dry" }), bal: { "solana-perps": 120 } });
  const r = (await w.look())!;
  assert.equal(r.stage, "dry run: ready");
  assert.equal(r.steps.length, 3);
  assert.match(r.steps[0], /would send 8 USDC as a test: at least 7.7 USDC arrives/);
  assert.match(r.steps[2], /at most about \$0.6/);
  assert.deepEqual(w.s.sends, []);
  assert.deepEqual(loadBridge().moves, {});
  assert.equal(bridgeHoldsHyperliquid(), false);
  // and it is not priced again at every look
  await w.look(5);
  assert.equal(w.s.quotes, 2);
});

test("a dry run says when the wallet is short or the price is bad", async () => {
  let r = (await world({ order: order({ mode: "dry" }), bal: { "solana-perps": 40 } }).look())!;
  assert.equal(r.stage, "dry run: would NOT go");
  assert.match(r.problems[0], /holds 40 USDC, the move needs 100 USDC/);
  _test.reset();
  r = (await world({ order: order({ mode: "dry" }), bal: { "solana-perps": 120 }, fee: 3 }).look())!;
  assert.match(r.problems[0], /would cost up to \$3 of \$8 \(limit \$2\)/);
});

test("Solana perps to Hyperliquid: the test goes first, the rest only after it arrived", async () => {
  const w = world({ order: order(), bal: { "solana-perps": 120 }, lag: 3 });
  await w.look(); // new -> test
  await w.look(); // sends the test
  assert.deepEqual(w.s.sends, [TEST_USD]);
  assert.equal(bridgeHoldsHyperliquid(), true);
  await w.look(); // not there yet
  assert.deepEqual(w.s.sends, [TEST_USD]);
  await w.look(2); // arrived
  assert.equal(loadBridge().moves["perps-to-hl-1"].stage, "rest");
  await w.look(); // sends the rest
  assert.deepEqual(w.s.sends, [TEST_USD, 92]);
  const r = (await w.look(4))!;
  assert.equal(r.stage, "done");
  const m = loadBridge().moves["perps-to-hl-1"];
  assert.equal(m.sent, 100);
  assert.ok(Math.abs(m.arrived - 99.4) < 1e-6);
  assert.ok(Math.abs(w.s.bal.hyperliquid - 99.4) < 1e-6);
  assert.equal(w.s.bal["solana-perps"], 20);
  assert.equal(bridgeHoldsHyperliquid(), false); // the funding may now deposit it
  // the same order left in the file does nothing more
  await w.look(5);
  assert.equal(w.s.sends.length, 2);
  assert.equal(bridgePublic().moves[0].stage, "done");
});

test("Hyperliquid to Polymarket: withdraws to its own wallet first, and the funding is held off meanwhile", async () => {
  const w = world({ order: order({ id: "hl-to-pm-1", from: "hyperliquid", to: "polymarket", usd: 50 }), hl: 80 });
  await w.look();
  assert.deepEqual(w.s.withdrawals, [50]);
  assert.equal(bridgeHoldsHyperliquid(), true);
  assert.deepEqual(w.s.sends, []);
  await w.look(2); // the 49 shows in the wallet
  assert.equal(loadBridge().moves["hl-to-pm-1"].left, 49);
  await w.look(8);
  assert.deepEqual(w.s.sends, [TEST_USD, 41]);
  assert.equal(loadBridge().moves["hl-to-pm-1"].stage, "done");
  assert.ok(Math.abs(w.s.bal.polymarket - 48.4) < 1e-6);
  assert.equal(w.s.withdrawals.length, 1);
});

test("Hyperliquid says no, or lets too little out: nothing moves", async () => {
  let w = world({ order: order({ id: "hl-out-1", from: "hyperliquid", to: "polymarket", usd: 50 }), hl: 80, hlRefuses: true });
  const r = (await w.look(2))!;
  assert.equal(r.stage, "STOPPED");
  assert.match(r.problems[0], /did not take the withdrawal/);
  assert.equal(bridgeHoldsHyperliquid(), false);
  w = world({ order: order({ id: "hl-out-2", from: "hyperliquid", to: "polymarket", usd: 50 }), hl: 30 });
  assert.match((await w.look(3))!.steps[0], /would let only \$30 out/);
  assert.deepEqual(w.s.withdrawals, []);
  assert.equal(bridgeHoldsHyperliquid(), false);
});

test("a withdrawal that never shows stops the move and frees the wallet", async () => {
  const w = world({ order: order({ id: "hl-out-3", from: "hyperliquid", to: "polymarket", usd: 50 }), hl: 80 });
  await w.look();
  w.s.queue = [];
  const r = (await w.look(4, WITHDRAW_WAIT_MS / 3))!;
  assert.equal(r.stage, "STOPPED");
  assert.equal(bridgeHoldsHyperliquid(), false);
  assert.deepEqual(w.s.sends, []);
});

test("a quote that pays someone else, or a transaction the chain check dislikes, is never sent", async () => {
  let w = world({ order: order(), bal: { "solana-perps": 120 }, payTo: "0x00000000000000000000000000000000000000Ff" });
  let r = (await w.look(6))!;
  assert.match(r.steps[0], /does not pay our own wallet/);
  assert.deepEqual(w.s.sends, []);
  saveJson("bridge-state.json", { moves: {} });
  w = world({ order: order(), bal: { "solana-perps": 120 }, inspect: ["the transaction would take more USDC than the move"] });
  r = (await w.look(6))!;
  assert.match(r.steps[0], /more USDC than the move/);
  assert.deepEqual(w.s.sends, []);
});

test("the test part never arrives: the rest is never sent, the move stops for a look", async () => {
  const w = world({ order: order(), bal: { "solana-perps": 120 }, never: true });
  await w.look(2);
  const r = (await w.look(5, ARRIVE_WAIT_MS / 4))!;
  assert.equal(r.stage, "STOPPED");
  assert.deepEqual(w.s.sends, [TEST_USD]);
  await w.look(5);
  assert.deepEqual(w.s.sends, [TEST_USD]);
});

test("the bridge reports a failed part: stopped at once", async () => {
  const w = world({ order: order(), bal: { "solana-perps": 120 }, never: true, status: "failed" });
  const r = (await w.look(4))!;
  assert.equal(r.stage, "STOPPED");
  assert.deepEqual(w.s.sends, [TEST_USD]);
});

test("sends that never leave the wallet are tried a few times, then the move stops", async () => {
  const w = world({ order: order(), bal: { "solana-perps": 120 }, sendFails: true });
  const r = (await w.look(4 * MAX_TRIES + 2, UNSENT_WAIT_MS))!;
  assert.equal(r.stage, "STOPPED");
  assert.match(r.problems[0], /never left the wallet/);
  assert.equal(w.s.bal["solana-perps"], 120);
});

test("an id runs once: the same id with other numbers is refused, and only one move goes at a time", async () => {
  const w = world({ order: order(), bal: { "solana-perps": 240 }, lag: 50 });
  await w.look(2);
  w.s.order = order({ usd: 200 });
  assert.match((await w.look())!.problems[0], /already used/);
  w.s.order = order({ id: "another-1" });
  assert.match((await w.look())!.problems[0], /still going/);
  assert.deepEqual(w.s.sends, [TEST_USD]);
});

test("turning go off pauses before the next part; what is on its way is still followed", async () => {
  const w = world({ order: order(), bal: { "solana-perps": 120 }, lag: 2 });
  await w.look(2);
  w.s.order = order({ mode: "dry" });
  await w.look(5);
  const m = loadBridge().moves["perps-to-hl-1"];
  assert.equal(m.stage, "rest");
  assert.deepEqual(w.s.sends, [TEST_USD]);
});

test("SOL moves keep the wallet's gas and are priced in dollars", async () => {
  const w = world({ order: order({ id: "copy-to-hl-1", from: "solana-spot-copy", usd: 40 }), bal: { "solana-spot-copy": 0.22 }, sol: 200 });
  assert.match((await w.look())!.steps[0], /holds 0.22 SOL, the move needs 0.25 SOL/);
  w.s.bal["solana-spot-copy"] = 0.3;
  await w.look(8);
  assert.deepEqual(w.s.sends, [0.04, 0.16]);
  assert.equal(loadBridge().moves["copy-to-hl-1"].stage, "done");
  assert.ok(Math.abs(w.s.bal.hyperliquid - 39.4) < 1e-6);
});

test("parts and the guard", () => {
  assert.deepEqual(parts(18, 1), [18]);
  assert.deepEqual(parts(100, 1), [8, 92]);
  const r: QuoteReq = { from: INFO["solana-perps"], to: INFO.hyperliquid, amount: 100 };
  const q = (over: Partial<Quote["echo"]> = {}, min = 99.5): Quote => ({ tool: "x", minutes: 1, toAmount: min, toAmountMin: min, echo: { fromChain: "solana", toChain: "arbitrum", fromToken: "USDC", toToken: "USDC", fromAddress: SOLP, toAddress: HL.toLowerCase(), fromAmount: 100, ...over }, tx: { kind: "solana", data: "AA==" } });
  const one = { from: 1, to: 1 };
  assert.deepEqual(guard(r, q(), one), []);
  assert.match(guard(r, q({ toChain: "polygon" }), one)[0], /other chains/);
  assert.match(guard(r, q({ toToken: "?" }), one)[0], /other tokens/);
  assert.match(guard(r, q({ fromAddress: SOLP.toLowerCase() }), one)[0], /does not start at our wallet/); // Solana addresses are case-exact
  assert.match(guard(r, q({ fromAmount: 150 }), one)[0], /another amount/);
  assert.match(guard(r, q({}, 97), one)[0], /cost up to \$3 of \$100 \(limit \$2\)/);
  assert.match(guard(r, q({}, 120), one)[0], /not believed/);
  assert.match(guard(r, q({}, 0), one)[0], /no least amount/);
  assert.match(guard(r, { ...q(), tx: { kind: "evm", to: "", data: "0x", value: "0", chainId: 1, approval: "" } }, one)[0], /another kind of chain/);
});

test("reading the route finder's answer, and the checks on what it built", () => {
  const r: QuoteReq = { from: INFO.hyperliquid, to: INFO.polymarket, amount: 41 };
  const answer = (data: string, to = LIFI_DIAMOND) => ({
    tool: "across",
    action: { fromChainId: 42161, toChainId: 137, fromToken: { address: tokenAddress("arbitrum", "USDC").toLowerCase() }, toToken: { address: tokenAddress("polygon", "USDC") }, fromAmount: "41000000", fromAddress: HL, toAddress: PM },
    estimate: { toAmount: "40900000", toAmountMin: "40700000", approvalAddress: LIFI_DIAMOND, executionDuration: 120 },
    transactionRequest: { to, data, value: "0x0", chainId: 42161 },
  });
  const good = readQuote(answer("0xabcdef" + PM.slice(2).toLowerCase() + "00"), r);
  assert.equal(good.toAmountMin, 40.7);
  assert.equal(good.echo.fromAmount, 41);
  assert.equal(good.echo.toToken, "USDC");
  assert.equal(good.minutes, 2);
  assert.deepEqual(guard(r, good, { from: 1, to: 1 }), []);
  assert.deepEqual(inspectEvm(r, good), []);
  assert.match(inspectEvm(r, readQuote(answer("0xabcdef"), r))[0], /do not name our destination/);
  assert.match(inspectEvm(r, readQuote(answer("0xabcdef" + PM.slice(2).toLowerCase(), "0x00000000000000000000000000000000000000Cc"), r))[0], /does not call the route finder's own contract/);
  assert.match(inspectEvm(r, { ...good, tx: { ...(good.tx as { kind: "evm"; to: string; data: string; value: string; chainId: number; approval: string }), value: "0x38d7ea4c68000" } })[0], /more ETH than a bridge fee/);
  assert.throws(() => readQuote({ message: "No available quotes" }, r), /no route: No available quotes/);
  // a quote for another token reads as "?" and is refused by the guard
  const other = readQuote({ ...answer("0x00"), action: { ...answer("0x00").action, toToken: { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" } } }, r);
  assert.match(guard(r, other, { from: 1, to: 1 })[0], /other tokens/);

  const key = Buffer.alloc(32, 7);
  const tx = (signers: number, first: Buffer, versioned = true) => Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(versioned ? [0x80] : []), Buffer.from([signers, 0, 1, 2]), first, Buffer.alloc(32, 9), Buffer.alloc(40)]).toString("base64");
  assert.deepEqual(inspectSolana(tx(1, key), key), []);
  assert.deepEqual(inspectSolana(tx(1, key, false), key), []);
  assert.match(inspectSolana(tx(2, key), key)[0], /more than one signer/);
  assert.match(inspectSolana(tx(1, Buffer.alloc(32, 8)), key)[0], /not our wallet/);
  assert.match(inspectSolana("AA==", key)[0], /more than our one signature/);
});

test("nothing that looks like an address or a key reaches the status", () => {
  assert.equal(scrub(`paid ${HL} and ${"5".repeat(44)} with api-key=abc123`), "paid 0x… and … with api-key=…");
});

test("Polymarket to Hyperliquid, and Solana to Base: the same two parts", async () => {
  let w = world({ order: order({ id: "pm-to-hl-1", from: "polymarket", to: "hyperliquid", usd: 60 }), bal: { polymarket: 300 } });
  await w.look(8);
  assert.deepEqual(w.s.sends, [TEST_USD, 52]);
  assert.equal(loadBridge().moves["pm-to-hl-1"].stage, "done");
  assert.ok(Math.abs(w.s.bal.hyperliquid - 59.4) < 1e-6);
  saveJson("bridge-state.json", { moves: {} });
  w = world({ order: order({ id: "perps-to-base-1", to: "base", usd: 30 }), bal: { "solana-perps": 50 } });
  await w.look(8);
  assert.deepEqual(w.s.sends, [TEST_USD, 22]);
  assert.equal(bridgeHoldsHyperliquid(), false);
});

test("out of Polymarket: USDC.e leaves, the batch can carry no fee coin; Base is read as a chain", () => {
  // Base's USDC is never taken on trust: until it is proven on Base there is no token to price or sign for
  assert.throws(() => tokenAddress("base", "USDC"), /not proven yet/);
  _setBaseUsdc("0x00000000000000000000000000000000000000Dd");
  const r: QuoteReq = { from: INFO.polymarket, to: INFO.base, amount: 50 };
  const dest = INFO.base.address.slice(2).toLowerCase();
  const answer = (value: string, fromToken = tokenAddress("polygon", "USDC", "from")) => ({
    tool: "across",
    action: { fromChainId: 137, toChainId: 8453, fromToken: { address: fromToken }, toToken: { address: tokenAddress("base", "USDC") }, fromAmount: "50000000", fromAddress: PM, toAddress: INFO.base.address },
    estimate: { toAmount: "49800000", toAmountMin: "49600000", approvalAddress: LIFI_DIAMOND, executionDuration: 60 },
    transactionRequest: { to: LIFI_DIAMOND, data: "0xaa" + dest, value, chainId: 137 },
  });
  assert.notEqual(tokenAddress("polygon", "USDC", "from"), tokenAddress("polygon", "USDC", "to"));
  const good = readQuote(answer("0x0"), r);
  assert.deepEqual(guard(r, good, { from: 1, to: 1 }), []);
  assert.deepEqual(inspectEvm(r, good), []);
  assert.match(inspectEvm(r, readQuote(answer("0x1"), r))[0], /fee in POL/);
  // a quote that would take the native USDC instead of USDC.e is for another token
  assert.match(guard(r, readQuote(answer("0x0", tokenAddress("polygon", "USDC", "to")), r), { from: 1, to: 1 })[0], /other tokens/);
});

test("between two Solana wallets: SOL only, a plain System transfer signed by the sender", async () => {
  assert.deepEqual(checkOrder({ id: "sol-1", from: "solana-spot-rules", to: "solana-spot-copy", usd: 17, mode: "go" }), []);
  assert.ok(checkOrder({ id: "sol-2", from: "solana-spot-rules", to: "solana-spot-copy", usd: 17, mode: "go", token: "USDC" }).some((x) => /only SOL/.test(x)));
  const { transferTx, sameSolana } = await import("./real.js");
  const { generateKeyPairSync, sign, verify } = await import("node:crypto");
  const { base58 } = await import("../solana/whirlpool.js");
  const kp = generateKeyPairSync("ed25519");
  const pub = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const w = { address: base58(pub), pubkey: pub, sign: (m: Uint8Array) => sign(null, m, kp.privateKey) };
  const to = base58(Buffer.alloc(32, 7));
  const bh = base58(Buffer.alloc(32, 9));
  const tx = Buffer.from(transferTx(w, to, 250_000_000, bh), "base64");
  assert.equal(tx[0], 1);
  const msg = tx.subarray(65);
  assert.ok(verify(null, msg, kp.publicKey, tx.subarray(1, 65)), "signed by the sending wallet");
  assert.deepEqual([...msg.subarray(0, 4)], [1, 0, 1, 3]);
  assert.ok(msg.subarray(4, 36).equals(pub));
  assert.ok(msg.subarray(36, 68).equals(Buffer.alloc(32, 7)));
  assert.ok(msg.subarray(68, 100).equals(Buffer.alloc(32, 0)), "System Program");
  const ix = msg.subarray(132);
  assert.deepEqual([...ix.subarray(0, 6)], [1, 2, 2, 0, 1, 12]);
  assert.equal(ix.readUInt32LE(6), 2);
  assert.equal(ix.readBigUInt64LE(10), 250_000_000n);
  assert.throws(() => transferTx(w, to, 0, bh));
  assert.equal(sameSolana({ from: { chain: "solana", address: "a", token: "SOL" }, to: { chain: "solana", address: "b", token: "SOL" }, amount: 1 }), true);
  assert.equal(sameSolana({ from: { chain: "solana", address: "a", token: "USDC" }, to: { chain: "arbitrum", address: "b", token: "USDC" }, amount: 1 }), false);
});
