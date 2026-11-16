import assert from "node:assert/strict";
import { test } from "node:test";
import { streamRow } from "./pmstream.js";
import { copyBuys, copyGapSummary, copySells, gapC, type PaperTrade } from "./eventpaper.js";

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
  assert.equal(g.paper.byGap[3].n, 1); // exactly 10c above: the (5, 10] bucket
  assert.equal(g.paper.byGap[3].fromC, 5);
  assert.equal(g.paper.byGap[4].n, 0);
  assert.equal(g.paper.byLag[0].n, 1);
  assert.equal(g.realCopies.matched, 1);
  assert.equal(g.sells.paper.n, 1);
  assert.equal(g.sells.paper.sellNet, -0.25); // 5 shares at 0.55 = 2.75 back on 3
  assert.equal(g.sells.real.sellNet, -0.25);
});

test("gaps are whole tenths of a cent: exact 2c / 5c / 10c land in the same bucket every time", () => {
  assert.equal(gapC(0.6, 0.5), 10);
  assert.equal(gapC(0.55, 0.45), 10);
  assert.equal(gapC(0.07, 0.02), 5);
  assert.equal(gapC(0.5, 0.52), -2);
});

test("orders_matched is not read as a trade; the traded token is kept for the side check", () => {
  const pay = { proxyWallet: W, conditionId: COND, outcomeIndex: 0, price: 0.5, size: 2, side: "BUY", timestamp: 1794800000, asset: "123" };
  assert.equal(streamRow({ topic: "activity", type: "orders_matched", payload: pay }), null);
  const got = streamRow({ topic: "activity", type: "trades", payload: pay });
  assert.equal(got?.row.asset, "123");
  assert.equal(copyBuys([got!.row as never], 0)[0].asset, "123");
});

test("real copy orders wait their turn instead of meeting each other in flight", async () => {
  const { copyOrderTurn } = await import("./eventpaper.js");
  let inFlight = 0;
  let most = 0;
  const order = (tag: string) => async () => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return tag;
  };
  const got = await Promise.all([copyOrderTurn(order("a")), copyOrderTurn(order("b")), copyOrderTurn(async () => { throw new Error("x"); }).catch(() => "err"), copyOrderTurn(order("c"))]);
  assert.deepEqual(got, ["a", "b", "err", "c"]);
  assert.equal(most, 1);
});
