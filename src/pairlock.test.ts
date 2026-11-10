import assert from "node:assert/strict";
import { test } from "node:test";
import { newSim, onPrint, quote, type Sim } from "./pairlock.js";
import type { Book } from "./polymarket.js";

/** A fresh view of the sim, so the compiler does not carry an earlier null check across calls that change it. */
const v = (s: Sim): Sim => ({ ...s });

const book = (bid: number, size: number, ask: number): Book => ({ bids: [{ price: bid, size }, { price: Math.round((bid - 0.01) * 100) / 100, size: 50 }], asks: [{ price: ask, size: 10 }], bestBid: bid, bestAsk: ask, bidDepth: 0, askDepth: 0 });

test("pairlock: quotes both sides, fills from prints only, completes a pair under $1", () => {
  const sim = newSim(1000);
  quote(sim, book(0.48, 100, 0.5), book(0.5, 20, 0.52), 1010, 890, false);
  assert.equal(v(sim).up, null); // first 30 s: no quotes
  quote(sim, book(0.48, 100, 0.5), book(0.5, 20, 0.52), 1040, 860, false);
  assert.deepEqual([v(sim).up?.price, v(sim).up?.ahead, v(sim).down?.price, v(sim).down?.ahead], [0.48, 100, 0.5, 20]);
  // a taker buying Up at 50c is the same trade as selling Down at 50c: it eats 15 of the 20 shares ahead of our Down bid
  assert.equal(onPrint(sim, { price: 0.5, size: 15, side: "BUY" }, true, 1041), null);
  // a taker selling Up at the 50c ask side never happens; a sell of Up at 49c does not reach our 48c Up bid
  assert.equal(onPrint(sim, { price: 0.49, size: 500, side: "SELL" }, true, 1041), null);
  // sells at our Down price: the last 5 ahead trade first, then 2 of our 6
  assert.equal(onPrint(sim, { price: 0.5, size: 7, side: "SELL" }, false, 1042), null);
  assert.equal(onPrint(sim, { price: 0.5, size: 4, side: "SELL" }, false, 1043), "first");
  assert.deepEqual([v(sim).held?.side, v(sim).held?.price, v(sim).up, v(sim).down], ["D", 0.5, null, null]);
  // completion bid on Up at min(best bid, 0.99 - 0.50 = 0.49)
  quote(sim, book(0.51, 30, 0.52), book(0.48, 20, 0.49), 1044, 856, false);
  assert.deepEqual([v(sim).up?.price, v(sim).down], [0.49, null]);
  // a taker buying Down above 1 - 0.49 fills our Up bid outright
  assert.equal(onPrint(sim, { price: 0.52, size: 6, side: "BUY" }, false, 1045), "pair");
  assert.deepEqual([v(sim).pairs, Math.round(v(sim).cost * 100), v(sim).held], [1, 99, null]);
});

test("pairlock: no quotes when the bids add to more than 99c or near the close; chase lifts the cap after 20 s", () => {
  const sim = newSim(1000);
  quote(sim, book(0.5, 10, 0.51), book(0.5, 10, 0.51), 1100, 800, false);
  assert.equal(v(sim).up, null);
  quote(sim, book(0.4, 10, 0.42), book(0.57, 10, 0.6), 1750, 150, false);
  assert.equal(v(sim).up, null);
  sim.held = { side: "U", price: 0.5, at: 1100 };
  quote(sim, book(0.4, 10, 0.42), book(0.55, 10, 0.6), 1125, 700, false);
  assert.equal(v(sim).down?.price, 0.49);
  quote(sim, book(0.4, 10, 0.42), book(0.55, 10, 0.6), 1125, 700, true);
  assert.equal(v(sim).down?.price, 0.53);
  quote(sim, book(0.4, 10, 0.42), book(0.55, 10, 0.6), 1890, 10, true);
  assert.equal(v(sim).down, null);
});
