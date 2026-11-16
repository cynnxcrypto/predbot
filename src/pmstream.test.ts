import assert from "node:assert/strict";
import { test } from "node:test";
import { streamRow } from "./pmstream.js";
import { copyBuys, copyGapSummary, copySells, type PaperTrade } from "./eventpaper.js";

const COND = "0x" + "ab".repeat(32);
const W = "0x" + "12".repeat(20);

test("a socket trade becomes a copy row the copy code reads like a data API row", () => {
  const got = streamRow({ topic: "activity", type: "trades", payload: { proxyWallet: W.toUpperCase().replace("0X", "0x"), conditionId: COND, outcomeIndex: 1, price: 0.42, size: 100, side: "BUY", timestamp: 1794800000, outcome: "No", title: "T" } });
  assert.ok(got);
  assert.equal(got.wallet, W);
  assert.equal(got.row.usdc_size, 42);
  const buys = copyBuys([got.row as never], 1794799999);
  assert.deepEqual(buys, [{ ts: 1794800000, cond: COND, idx: 1, price: 0.42 }]);
  // milliseconds are read as seconds
  assert.equal(streamRow({ topic: "activity", type: "trades", payload: { proxyWallet: W, conditionId: COND, outcomeIndex: 0, price: 0.5, size: 1, side: "SELL", timestamp: 1794800000123 } })?.row.timestamp, 1794800000);
});

test("other topics, bad wallets and prices out of range are not trades", () => {
  assert.equal(streamRow({ topic: "crypto_prices", payload: {} }), null);
  assert.equal(streamRow({ topic: "activity", type: "trades", payload: { proxyWallet: "nope", conditionId: COND, outcomeIndex: 0, price: 0.5, size: 1, timestamp: 1 } }), null);
  assert.equal(streamRow({ topic: "activity", type: "trades", payload: { proxyWallet: W, conditionId: COND, outcomeIndex: 0, price: 1, size: 1, timestamp: 1 } }), null);
  assert.equal(streamRow({ topic: "activity", type: "trades", payload: { proxyWallet: W, conditionId: COND, outcomeIndex: 2, price: 0.5, size: 1, timestamp: 1 } }), null);
});

test("sales are picked out apart from buys", () => {
  const rows = [
    { type: "TRADE", side: "BUY", timestamp: 10, condition_id: COND, outcome_index: 0, price: 0.4 },
    { type: "TRADE", side: "SELL", timestamp: 20, condition_id: COND, outcome_index: 0, price: 0.6 },
    { type: "TRADE", side: "SELL", timestamp: 5, condition_id: COND, outcome_index: 0, price: 0.6 },
  ];
  assert.deepEqual(copySells(rows as never, 9), [{ ts: 20, cond: COND, idx: 0, price: 0.6 }]);
});

test("gap summary: buckets by cents above the wallet, real twins and sold-with-them", () => {
  const t = (ask: number, wallet: number, lagSec: number, pnl: number | null, extra: Record<string, unknown> = {}): PaperTrade => ({ rule: "copy-any-a", marketId: `m${ask}`, title: "", outcome: "Yes", idx: 0, token: "", t: 1000, ask, avg: ask, shares: 3 / ask, cost: 3, fee: 0, fillable: true, feeRate: 0, extra: { wallet, lagSec, ...extra }, won: pnl == null ? null : pnl > 0, pnl });
  const trades = [t(0.5, 0.5, 3, 3), t(0.6, 0.5, 20, -3, { soldAt: 1, sellBid: 0.55 }), t(0.53, 0.5, 8, null)];
  const real = [{ t: 1010, group: "copy", rule: "copy-take-a", marketId: "m0.6", conditionId: null, title: "", outcome: "Yes", idx: 0, ask: 0.6, size: 3, cost: 3, shares: 5, fee: 0, ok: true, status: "filled", error: null, won: false, pnl: -3 }];
  const g = copyGapSummary(trades, real as never, { "copy-take-a|m0.6|0|1010": { t: 2, bid: 0.55, their: 0.56 } });
  assert.equal(g.paper.n, 3);
  assert.equal(g.paper.byGap[0].n, 1); // at or under the wallet's price
  assert.equal(g.paper.byGap[3].n, 1); // 10c above: 5-10 bucket is [5,10), 10 goes to the last one
  assert.equal(g.paper.byGap[3].fromC, 5);
  assert.equal(g.paper.byLag[0].n, 1);
  assert.equal(g.realCopies.matched, 1);
  assert.equal(g.sells.paper.n, 1);
  assert.equal(g.sells.paper.sellNet, -0.25); // 5 shares at 0.55 = 2.75 back on 3
  assert.equal(g.sells.real.sellNet, -0.25);
});
