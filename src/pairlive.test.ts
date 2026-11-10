import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { budgetUsed, desired, newWin, parsePairs, worstCase, type PairConfig } from "./pairlive.js";
import type { Book } from "./polymarket.js";

const book = (bid: number): Book => ({ bids: [{ price: bid, size: 100 }], asks: [{ price: bid + 0.01, size: 10 }], bestBid: bid, bestAsk: bid + 0.01, bidDepth: 0, askDepth: 0 });
const cfg: PairConfig = { on: true, series: ["eth15m"], clip: 6, maxLoss: 35, maxPairs: 3, dayMaxLoss: 20, minBalance: 235 };

test("pairlive: quotes both sides only inside the rule, completes a lone clip under $1, never over $5 an order", () => {
  const w = newWin("eth15m", 900);
  assert.deepEqual(desired(w, book(0.48), book(0.5), 910, 900, cfg, true), { U: null, D: null }); // first 30 s
  assert.deepEqual(desired(w, book(0.48), book(0.5), 1000, 900, cfg, true), { U: { price: 0.48, size: 6 }, D: { price: 0.5, size: 6 } });
  assert.deepEqual(desired(w, book(0.5), book(0.5), 1000, 900, cfg, true), { U: null, D: null }); // bids add to $1
  assert.deepEqual(desired(w, book(0.1), book(0.85), 1000, 900, cfg, true), { U: null, D: null }); // outside 17-83c
  assert.deepEqual(desired(w, book(0.48), book(0.5), 1700, 900, cfg, true), { U: null, D: null }); // last 3 minutes
  assert.deepEqual(desired(w, book(0.48), book(0.5), 1000, 900, cfg, false), { U: null, D: null }); // a guard says no
  assert.deepEqual(desired(w, book(0.48), book(0.5), 1000, 900, { ...cfg, on: false }, true), { U: null, D: null });
  // Up filled 6 at 48c: only Down is bid, at most 51c
  w.up = { shares: 6, cost: 2.88, last: 0.48 };
  assert.deepEqual(desired(w, book(0.45), book(0.54), 1001, 900, cfg, true), { U: null, D: { price: 0.51, size: 6 } });
  assert.deepEqual(desired(w, book(0.55), book(0.44), 1001, 900, cfg, true), { U: null, D: { price: 0.44, size: 6 } });
  assert.deepEqual(desired(w, book(0.55), book(0.44), 1785, 900, cfg, true), { U: null, D: null }); // last 20 s
  assert.equal(worstCase(w), 2.88);
  // pair done: worst case is a sure gain, counted as zero; three pairs is the cap for a window
  w.down = { shares: 6, cost: 3.06, last: 0.51 };
  assert.equal(worstCase(w), 0);
  // 2 Up shares more than Down (a part fill): only Down is bid
  w.up.shares = 8;
  assert.deepEqual(desired(w, book(0.48), book(0.5), 1100, 900, cfg, true), { U: null, D: { price: 0.5, size: 6 } });
  w.up.shares = w.down.shares = 18;
  assert.deepEqual(desired(w, book(0.48), book(0.5), 1100, 900, cfg, true), { U: null, D: null });
});

test("pairlive: budget counts settled losses plus the worst case of open windows", () => {
  const w = newWin("eth15m", 900);
  w.down = { shares: 6, cost: 3, last: 0.5 };
  assert.deepEqual(budgetUsed([{ net: 0.06 }, { net: -2.9 }], [w]), { lost: 2.84, open: 3 });
  assert.deepEqual(budgetUsed([{ net: 0.5 }], []), { lost: 0, open: 0 });
});

test("pairlive: config is off unless everything says on, and the hard limits hold", () => {
  const local = { mode: "live", funder: "x" };
  const mk = (pairs: unknown, mode = "live") => JSON.stringify({ mode, minBalance: 250, pairs });
  assert.equal(parsePairs("not json", local).on, false);
  assert.equal(parsePairs(mk({ on: true, series: ["eth15m"], maxLoss: 35 }, "dry"), local).on, false);
  assert.equal(parsePairs(mk({ on: true, series: ["eth15m"], maxLoss: 35 }), { mode: "off", funder: "x" }).on, false);
  assert.equal(parsePairs(mk({ on: true, series: ["eth15m"], maxLoss: 35 }), { mode: "live" }).on, false);
  assert.equal(parsePairs(mk({ on: "yes", series: ["eth15m"], maxLoss: 35 }), local).on, false);
  assert.equal(parsePairs(mk({ on: true, series: ["nope"], maxLoss: 35 }), local).on, false);
  const big = parsePairs(mk({ on: true, series: ["eth15m", "eth5m"], clip: 50, maxLoss: 500, maxPairs: 99 }), local);
  assert.deepEqual([big.on, big.series, big.clip, big.maxLoss, big.maxPairs, big.minBalance], [true, ["eth15m"], 6, 35, 6, 250]);
  assert.deepEqual(parsePairs(mk({ on: true, series: ["btc5m", "eth15m"], maxLoss: 35 }), local).series, ["btc5m", "eth15m"]);
  // 5m windows quote from 20 s in until 60 s before the close
  const w5 = newWin("btc5m", 900);
  assert.deepEqual(desired(w5, book(0.48), book(0.5), 915, 300, cfg, true), { U: null, D: null });
  assert.deepEqual(desired(w5, book(0.48), book(0.5), 925, 300, cfg, true), { U: { price: 0.48, size: 6 }, D: { price: 0.5, size: 6 } });
  assert.deepEqual(desired(w5, book(0.48), book(0.5), 1145, 300, cfg, true), { U: null, D: null });
  const real = parsePairs(readFileSync("deploy/live-rules.json", "utf8"), local);
  assert.ok(real.maxLoss <= 35 && real.clip <= 6 && real.series.every((s) => s.endsWith("15m") || s === "btc5m"));
});
