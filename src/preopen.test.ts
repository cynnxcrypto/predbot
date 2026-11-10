import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPrint, placeBid } from "./preopen.js";

test("preopen: a 49c bid fills only on sells after the queue ahead has traded", () => {
  const side = placeBid([{ price: 0.49, size: 100 }, { price: 0.48, size: 50 }], 0.51)!;
  assert.equal(side.ahead, 100);
  assert.equal(applyPrint(side, { price: 0.49, size: 60, side: "BUY", t: 1 }), 0);
  assert.equal(applyPrint(side, { price: 0.5, size: 60, side: "SELL", t: 1 }), 0);
  assert.equal(applyPrint(side, { price: 0.49, size: 60, side: "SELL", t: 2 }), 0);
  assert.equal(side.ahead, 40);
  assert.equal(applyPrint(side, { price: 0.49, size: 43, side: "SELL", t: 3 }), 3);
  assert.equal(side.at, 3);
  // a print under our price fills the rest, capped at $5 of shares
  const got = applyPrint(side, { price: 0.47, size: 500, side: "", t: 4 });
  assert.ok(Math.abs(side.shares - 5 / 0.49) < 1e-9 && got > 7);
  assert.equal(applyPrint(side, { price: 0.4, size: 500, side: "SELL", t: 5 }), 0);
});

test("preopen: no bid when the ask is already at 49c; unknown queue never fills; empty level means front of queue", () => {
  assert.equal(placeBid([{ price: 0.45, size: 10 }], 0.49), null);
  assert.equal(placeBid([{ price: 0.45, size: 10 }], 0.55)!.ahead, 0);
  const deep = placeBid([{ price: 0.55, size: 10 }, { price: 0.52, size: 10 }], 0.56)!;
  assert.equal(deep.ahead, null);
  assert.equal(applyPrint(deep, { price: 0.3, size: 100, side: "SELL", t: 1 }), 0);
});
