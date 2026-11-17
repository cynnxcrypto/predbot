import assert from "node:assert/strict";
import { test } from "node:test";
import { actionMessage, cancelAllData, cancelData, placeData, toBaseLots, toPriceLots, baseLotsToQty } from "./gum.js";

// the Rust SDK's own golden bytes (gum-perp-sdk rust/tests/signing_parity.rs, read 17 Nov 2026)
const M = { symbol: "SOL", baseDecimals: 9, quoteLotSize: 100, baseLotSize: 1_000_000 };
const signer = Buffer.alloc(32, 7);
const hash = Buffer.alloc(32, 9);

test("gum: a place order signs the same bytes as the Rust SDK", () => {
  const data = placeData(M, { subaccountId: 1, symbol: "SOL", side: "Bid", orderType: "limit", price: 100.25, quantity: 1.5, reduceOnly: false, timeInForce: "GoodTilCanceled", clientOrderId: 42n, isIsolated: false });
  assert.equal(
    actionMessage(signer, hash, data).toString("hex"),
    "09090909090909090909090909090909090909090909090909090909090909090afd23d1134d8b39513c49c67720abbffa8addf50eb783a890bab5fb6473bedb0107070707070707070707070707070707070707070707070707070707070707072a030103000000534f4cea03000000000000dc050000000000000000000000000000012a00000000000000",
  );
});

test("gum: cancel and cancel-all sign the same bytes as the Rust SDK", () => {
  assert.equal(
    actionMessage(signer, hash, cancelData({ subaccountId: 2, isIsolated: true, symbol: "BTC", orderId: 12345678901234567890n, clientOrderId: 43n })).toString("hex"),
    "09090909090909090909090909090909090909090909090909090909090909090afd23d1134d8b39513c49c67720abbffa8addf50eb783a890bab5fb6473bedb010707070707070707070707070707070707070707070707070707070707070707231f020300000042544301d20a1feb8ca954ab0000000000000000012b00000000000000",
  );
  assert.equal(
    actionMessage(signer, hash, cancelAllData({ subaccountId: 0, isIsolated: false, symbol: "SOL" })).toString("hex"),
    "09090909090909090909090909090909090909090909090909090909090909090afd23d1134d8b39513c49c67720abbffa8addf50eb783a890bab5fb6473bedb01070707070707070707070707070707070707070707070707070707070707070709050003000000534f4c",
  );
});

test("gum: lots, a market order, and an isolated order", () => {
  assert.equal(toBaseLots(M, 1.5), 1500n);
  assert.equal(baseLotsToQty(M, 1500n), 1.5);
  assert.equal(toPriceLots(M, 100.25), 1002n);
  assert.throws(() => toBaseLots(M, 0.0001));
  // a market order is IOC on chain, with no price when none is given
  const mk = placeData(M, { subaccountId: 0, symbol: "SOL", side: "Ask", orderType: "market", price: 0, quantity: 1, reduceOnly: true, timeInForce: "GoodTilCanceled", clientOrderId: null, isIsolated: false });
  assert.equal(mk.toString("hex"), "0300" + "03000000534f4c" + "0000000000000000" + "e803000000000000" + "01" + "01" + "01" + "01" + "00");
  // isolated: tag 30, the collateral first
  const iso = placeData(M, { subaccountId: 0, symbol: "SOL", side: "Bid", orderType: "market", price: 0, quantity: 1, reduceOnly: false, timeInForce: "ImmediateOrCancel", clientOrderId: null, isIsolated: true, collateralAmount: 5_000_000n });
  assert.equal(iso[0], 30);
  assert.equal(iso.readBigUInt64LE(1), 5_000_000n);
  assert.throws(() => placeData(M, { subaccountId: 0, symbol: "SOL", side: "Bid", orderType: "market", price: 0, quantity: 1, reduceOnly: false, timeInForce: "ImmediateOrCancel", clientOrderId: null, isIsolated: true }));
});
