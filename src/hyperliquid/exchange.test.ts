import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyTypedData } from "@ethersproject/wallet";
import { Wallet } from "@ethersproject/wallet";
import { actionHash, coinsOf, leverageAction, nonce, orderAction, pack, readOrder, roundPx, roundSz, signAction, usdSend, wire } from "./exchange.js";

test("the action hash is the one Hyperliquid's own SDK gives for the same order", () => {
  // hyperliquid-python-sdk, tests/signing_test.py, test_phantom_agent_creation_matches_production
  const action = orderAction({ index: 4, szDecimals: 4, maxLeverage: 50 }, true, 1670.1, 0.0147, false);
  assert.deepEqual(action.orders[0], { a: 4, b: true, p: "1670.1", s: "0.0147", r: false, t: { limit: { tif: "Ioc" } } });
  assert.equal(actionHash(action, 1677777606040), "0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908");
});

test("an action is signed by the trading key, and only for these exact contents", async () => {
  const key = Wallet.createRandom();
  const action = leverageAction({ index: 7, szDecimals: 1, maxLeverage: 20 }, 5.9);
  assert.deepEqual(action, { type: "updateLeverage", asset: 7, isCross: false, leverage: 5 });
  const sig = await signAction(key, action, 1700000000000);
  const who = verifyTypedData(
    { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
    { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    { source: "a", connectionId: actionHash(action, 1700000000000) },
    sig,
  );
  assert.equal(who, key.address);
  assert.notEqual(actionHash(action, 1700000000001), actionHash(action, 1700000000000));
});

test("packing: sizes of numbers, text and lists", () => {
  assert.deepEqual([...pack({ a: 1, b: [true, false, null], c: "x" })], [0x83, 0xa1, 0x61, 1, 0xa1, 0x62, 0x93, 0xc3, 0xc2, 0xc0, 0xa1, 0x63, 0xa1, 0x78]);
  assert.deepEqual([...pack(200)], [0xcc, 200]);
  assert.deepEqual([...pack(70000)], [0xce, 0, 1, 0x11, 0x70]);
  assert.deepEqual([...pack("a".repeat(40))].slice(0, 2), [0xd9, 40]);
  assert.throws(() => pack(1.5));
});

test("prices and sizes in Hyperliquid's form", () => {
  assert.equal(roundPx(103456.7, 5), 103460);
  assert.equal(roundPx(1670.123, 4), 1670.1);
  assert.equal(roundPx(0.00012345678, 0), 0.000123);
  assert.equal(roundPx(1.234567, 2), 1.2346);
  assert.equal(roundSz(0.014799, 4), 0.0147);
  assert.equal(roundSz(12.99, 0), 12);
  assert.equal(wire(0.1 + 0.2), "0.3");
  assert.equal(wire(100), "100");
});

test("the coin list, order answers and nonces", () => {
  const coins = coinsOf({ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "OLD", szDecimals: 1, maxLeverage: 3, isDelisted: true }, { name: "HYPE", szDecimals: 2, maxLeverage: 10 }] });
  assert.deepEqual(coins, { BTC: { index: 0, szDecimals: 5, maxLeverage: 40 }, HYPE: { index: 2, szDecimals: 2, maxLeverage: 10 } });
  assert.deepEqual(readOrder({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.02", avgPx: "1891.4", oid: 77 } }] } } }), { filled: true, sz: 0.02, px: 1891.4, oid: 77, error: null });
  assert.equal(readOrder({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Order could not immediately match" }] } } }).error, "Order could not immediately match");
  assert.equal(readOrder({ status: "err", response: "User or API Wallet does not exist." }).error, "User or API Wallet does not exist.");
  assert.equal(readOrder(null).filled, false);
  const a = nonce(5);
  assert.ok(nonce(5) > a, "never the same number twice");
});

test("reading the account and a trade's own result out of Hyperliquid's answers", async () => {
  const { readAccount, readResult } = await import("./venue.js");
  const a = readAccount({ marginSummary: { accountValue: "101.5" }, withdrawable: "80.25", assetPositions: [{ position: { coin: "HYPE", szi: "-0.75", entryPx: "40.0", unrealizedPnl: "1.2", marginUsed: "10.1" } }, { position: { coin: "X", szi: "0" } }] });
  assert.deepEqual(a, { valueUsd: 101.5, freeUsd: 80.25, positions: { HYPE: { szi: -0.75, entryPx: 40, unrealUsd: 1.2, marginUsd: 10.1 } } });
  assert.throws(() => readAccount({}));
  const b = readAccount({ marginSummary: { accountValue: "50" }, assetPositions: [{ position: { coin: "ETH", szi: "-0.066", entryPx: "1811.1", marginUsed: "9.99", leverage: { type: "isolated", value: 12, rawUsd: "129.5" } } }, { position: { coin: "SOL", szi: "1", leverage: { type: "cross", value: 3 } } }] });
  assert.deepEqual([b.positions.ETH.lev, b.positions.ETH.isolated, b.positions.SOL.lev, b.positions.SOL.isolated], [12, true, 3, false]);
  const fills = [{ oid: 1, closedPnl: "0", fee: "0.0135" }, { oid: 2, closedPnl: "3.0", fee: "0.01" }, { oid: 2, closedPnl: "0.5", fee: "0.002" }, { oid: 9, closedPnl: "50", fee: "1" }];
  assert.equal(Math.round(readResult(fills, [1, 2])! * 1e4) / 1e4, 3.4745);
  assert.equal(readResult(fills, [1, 3]), null, "an order missing from the record: not guessed");
});

test("a move to our second wallet is signed by the paying wallet itself, for that address and amount only", async () => {
  const key = Wallet.createRandom();
  const to = Wallet.createRandom().address;
  let sent: { action: Record<string, unknown>; nonce: number; signature: { r: string; s: string; v: number }; vaultAddress?: unknown } | null = null;
  const net = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.ok(String(url).endsWith("/exchange"));
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ status: "ok", response: { type: "default" } }));
  }) as typeof fetch;
  assert.deepEqual(await usdSend(key, to, 50, net), { status: "ok", response: { type: "default" } });
  const s = sent!;
  assert.deepEqual(s.action, { type: "usdSend", hyperliquidChain: "Mainnet", signatureChainId: "0xa4b1", destination: to.toLowerCase(), amount: "50", time: s.nonce });
  assert.equal("vaultAddress" in s, false);
  const who = verifyTypedData(
    { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: "0x0000000000000000000000000000000000000000" },
    { "HyperliquidTransaction:UsdSend": [{ name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "amount", type: "string" }, { name: "time", type: "uint64" }] },
    { hyperliquidChain: "Mainnet", destination: to.toLowerCase(), amount: "50", time: s.nonce },
    s.signature,
  );
  assert.equal(who, key.address);
  await assert.rejects(usdSend(key, "0x12", 50, net));
  await assert.rejects(usdSend(key, to, 0, net));
});
