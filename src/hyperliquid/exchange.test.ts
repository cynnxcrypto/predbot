import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyTypedData } from "@ethersproject/wallet";
import { Wallet } from "@ethersproject/wallet";
import { actionHash, coinsOf, leverageAction, nonce, orderAction, pack, readOrder, roundPx, roundSz, signAction, wire } from "./exchange.js";

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
