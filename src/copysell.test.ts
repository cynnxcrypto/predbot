import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "copysell-"));

const { _copySellTest, bookSale, copySellStatus, fillsOf, followSales, keepAfter, mergeFills, newSales, paperSell, parseSellCfg, sellDue, sellFill, sellPlan, shareKept, soldFromTrades, walkBids, walletRemaining } = await import("./copysell.js");
const { EVENT_LIVE_FILE, _eventLiveTest, eventLiveRows, eventLiveSettle } = await import("./eventlive.js");
const { saveJson } = await import("./store.js");
type EventLiveRow = import("./eventlive.js").EventLiveRow;
type PaperTrade = import("./eventpaper.js").PaperTrade;
type SellDeps = import("./copysell.js").SellDeps;

const COND = "0x" + "ab".repeat(32);
// the real clock: the retry and freshness windows of a real sale are measured against Date.now()
const NOW = Math.floor(Date.now() / 1000) * 1000;
const TS = Math.floor(NOW / 1000);
const act = (side: string, size: number, price: number, ts: number, o: object = {}) => ({ type: "TRADE", side, size, price, usdc_size: size * price, timestamp: ts, condition_id: COND, outcome_index: 0, ...o });
const real = (o: Partial<EventLiveRow> = {}): EventLiveRow => ({ t: NOW - 3600_000, group: "copy", rule: "copy-take-w", marketId: "m1", conditionId: COND, title: "Will it rain", outcome: "Yes", idx: 0, ask: 0.5, size: 5, cost: 5, shares: 10, fee: 0.1, ok: true, status: "matched", error: null, token: "tok0", ...o });
const paper = (o: Partial<PaperTrade> = {}): PaperTrade => ({ rule: "copy-take-w", marketId: "m1", title: "Will it rain", outcome: "Yes", idx: 0, token: "tok0", t: NOW - 3600_000, ask: 0.5, avg: 0.5, shares: 6, cost: 3, fee: 0.03, fillable: true, feeRate: 0, extra: { cond: COND }, ...o });
const W = { name: "w", address: "0x" + "12".repeat(20) };
const bookAt = (bid: number, size = 1000) => ({ bids: [{ price: bid, size }], bestBid: bid });
function deps(o: Partial<SellDeps> = {}): SellDeps {
  return { market: async () => ({ id: "m1", tokens: ["tok0", "tok1"], feeRate: 0 }), book: async () => bookAt(0.6), remaining: async () => null, trades: [], ...o };
}
/** A stand-in for the exchange: records what is asked of it and answers as told. */
function exchange(o: { bal?: number; allowances?: Record<string, string>; answer?: (order: { amount: number; price: number }) => object; trades?: object[] } = {}) {
  const sent: { amount: number; price: number; side: unknown; tokenID: string }[] = [];
  const c = {
    sent,
    getBalanceAllowance: async () => ({ balance: String(Math.round((o.bal ?? 10) * 1e6)), allowances: o.allowances ?? { ex: "1000" } }),
    getTickSize: async () => "0.01",
    getNegRisk: async () => false,
    createMarketOrder: async (x: { amount: number; price: number; side: unknown; tokenID: string }) => (sent.push(x), x),
    postOrder: async (x: { amount: number; price: number }) => (o.answer ? o.answer(x) : { success: true, status: "matched", orderID: "o1", makingAmount: String(x.amount), takingAmount: String(Math.round(x.amount * 0.6 * 1e6) / 1e6) }),
    getTrades: async () => o.trades ?? [],
  };
  _copySellTest.client(c);
  return c;
}
function fresh(rows: EventLiveRow[], cfg: object = {}) {
  _copySellTest.reset();
  _eventLiveTest.reset();
  _copySellTest.cfg({ paper: true, real: true, minUsd: 1, slip: 0.02, live: true, ...cfg });
  saveJson(EVENT_LIVE_FILE, rows);
}

test("the switch: paper follows by default, real only when the live rules say so; the repo keeps real off until MAIN turns it on", () => {
  assert.deepEqual(parseSellCfg("{}"), { paper: true, real: false, minUsd: 1, slip: 0.02 });
  assert.deepEqual(parseSellCfg("nope"), { paper: true, real: false, minUsd: 1, slip: 0.02 });
  assert.equal(parseSellCfg(JSON.stringify({ events: { copy: { sells: { real: "yes" } } } })).real, false);
  assert.deepEqual(parseSellCfg(JSON.stringify({ events: { copy: { sells: { real: true, paper: false, minUsd: 100, slip: 0.05 } } } })), { paper: false, real: true, minUsd: 20, slip: 0.05 });
  const live = parseSellCfg(readFileSync(join(process.cwd(), "deploy", "live-rules.json"), "utf8"));
  assert.equal(live.paper, true);
});

test("a wallet's trades: shares from size or dollars, two readings merge without doubles, a sale is new only once", () => {
  const rows = [act("BUY", 100, 0.4, TS - 500), act("SELL", 50, 0.6, TS - 10), { type: "REDEEM", side: "", timestamp: TS }, act("SELL", 5, 1.2, TS)];
  const f = fillsOf(rows);
  assert.equal(f.length, 2);
  assert.equal(fillsOf([{ type: "TRADE", side: "sell", price: 0.5, usdc_size: 10, timestamp: TS * 1000, condition_id: COND, outcome_index: "1" }])[0].size, 20);
  assert.equal(mergeFills(f, f).length, 2);
  const twice = fillsOf([act("SELL", 5, 0.5, TS), act("SELL", 5, 0.5, TS)]);
  assert.equal(mergeFills(twice.slice(0, 1), twice).length, 2);
  const seen: Record<string, { n: number; ts: number }> = {};
  assert.equal(newSales(f, seen, "w", TS - 1800).length, 1);
  assert.equal(newSales(f, seen, "w", TS - 5).length, 0, "too old");
  assert.equal(newSales(twice, { [`w|${COND}|0|${TS}|SELL|5|0.5`]: { n: 1, ts: TS } }, "w", 0).length, 1, "the second of two equal sales is still new");
});

test("the share it kept: each sale against what it held just before it", () => {
  const all = fillsOf([act("BUY", 60, 0.4, TS - 900), act("BUY", 40, 0.45, TS - 800), act("SELL", 50, 0.6, TS - 10)]);
  assert.deepEqual(keepAfter(all, all.slice(2), COND, 0), { keep: 0.5, covered: true, sold: 50 });
  // an older sale is not counted again: 100 bought, 50 sold before, now 25 of the 50 left
  const more = [...all, ...fillsOf([act("SELL", 25, 0.7, TS)])];
  assert.deepEqual(keepAfter(more, more.slice(3), COND, 0), { keep: 0.5, covered: true, sold: 25 });
  // two new sales in one reading: half, then all of the rest
  assert.equal(keepAfter([...all, ...fillsOf([act("SELL", 50, 0.7, TS)])], [all[2], ...fillsOf([act("SELL", 50, 0.7, TS)])], COND, 0).keep, 0);
  // the list does not reach back to its buys
  const cut = fillsOf([act("SELL", 50, 0.6, TS)]);
  assert.equal(keepAfter(cut, cut, COND, 0).covered, false);
  // another side of the same market is not mixed in
  const other = fillsOf([act("BUY", 100, 0.4, TS - 9, { outcome_index: 1 }), act("SELL", 50, 0.6, TS)]);
  assert.equal(keepAfter(other, other.slice(1), COND, 0).covered, false);
});

test("which reading decides the share: its whole list, else what Polymarket says it still holds, else nothing is sold", () => {
  assert.equal(shareKept({ keep: 0.5, covered: true, sold: 50 }, true, null), 0.5);
  assert.equal(shareKept({ keep: 0.5, covered: true, sold: 50 }, false, 150), 0.75, "the list may be cut off: 50 sold, 150 still held");
  assert.equal(shareKept({ keep: 0, covered: false, sold: 50 }, false, 0), 0);
  assert.equal(shareKept({ keep: 0.5, covered: true, sold: 50 }, false, null), 0.5);
  assert.equal(shareKept({ keep: 0, covered: false, sold: 50 }, true, null), null);
});

test("how much we sell: the same share; a part under $1 waits; all of it once the wallet is out", () => {
  assert.deepEqual(sellPlan(10, 10, 0.5, 0.6, 1), { shares: 5, all: false });
  assert.equal(sellPlan(10, 10, 0.9, 0.6, 1).shares, 0, "1 share at 60c is under $1");
  assert.match(String(sellPlan(10, 10, 0.9, 0.6, 1).why), /under \$1/);
  // the part that waited goes with the next one: 10% then half of the rest
  assert.equal(sellPlan(10, 10, 0.45, 0.6, 1).shares, 5.5);
  assert.deepEqual(sellPlan(4.5, 10, 0.01, 0.6, 1), { shares: 4.5, all: true });
  assert.equal(sellPlan(5, 10, 0.5, 0.6, 1).shares, 0, "already sold our half");
});

test("books: a part sold is its own finished row, the open row keeps the rest; sums are kept; the claimer never sees a sale", () => {
  const rows = [real()];
  const key = `copy-take-w|m1|0|${rows[0].t}`;
  const b = bookSale(rows, key, 4, 2.4, 0, NOW);
  assert.deepEqual(b, { pnl: 0.36, all: false, shares: 4 });
  assert.equal(rows.length, 2);
  const [open, sold] = rows;
  assert.equal(open.shares, 6);
  assert.equal(open.cost, 3);
  assert.equal(open.fee, 0.06);
  assert.equal(open.pnl, undefined);
  assert.equal(sold.status, "sold");
  assert.equal(sold.won, true);
  assert.equal(sold.pay, undefined, "no payout: nothing to claim for a sale");
  assert.equal(sold.token, undefined);
  assert.notEqual(sold.t, open.t);
  assert.equal(open.cost + sold.cost, 5);
  // the rest is settled by the result as before
  saveJson(EVENT_LIVE_FILE, rows);
  assert.equal(eventLiveSettle("m1", [1, 0]), 1);
  const after = eventLiveRows();
  assert.equal(after[0].pnl, 6 - 3 - 0.06);
  assert.equal(after[1].pnl, sold.pnl, "the sold part is not settled again");
  // all of it, at a loss, with a taker fee on the sale
  const r2 = [real()];
  const all = bookSale(r2, key, 10, 4, 0.02, NOW);
  assert.equal(all?.all, true);
  assert.equal(r2.length, 1);
  assert.equal(r2[0].status, "sold");
  assert.equal(r2[0].won, false);
  assert.ok(Math.abs(r2[0].pnl! - (4 - 5 - 0.1 - 0.02 * 10 * 0.4 * 0.6)) < 1e-6);
  assert.equal(bookSale(r2, key, 1, 1, 0, NOW), null, "a finished row is not sold again");
});

test("paper: the twin sells the same share at the bids it sees and keeps the rest", () => {
  const t = paper();
  const p = paperSell(t, 0.5, [{ price: 0.6, size: 2 }, { price: 0.59, size: 100 }, { price: 0.5, size: 100 }], { minUsd: 1, slip: 0.02 }, NOW, 0.61);
  assert.ok(p?.piece);
  assert.equal(p.shares, 3);
  assert.ok(Math.abs(p.usd - (2 * 0.6 + 0.59)) < 1e-9);
  assert.equal(t.shares, 3);
  assert.equal(t.cost, 1.5);
  assert.equal(t.pnl, undefined);
  assert.ok(Math.abs(p.piece.pnl! - (1.79 - 1.5 - 0.015)) < 1e-9);
  assert.equal(walkBids([{ price: 0.6, size: 2 }, { price: 0.5, size: 9 }], 5, 0.58).shares, 2, "bids under our limit are not taken");
  // then the wallet gets out: the rest goes and the trade is finished
  const q = paperSell(t, 0, [{ price: 0.7, size: 100 }], { minUsd: 1, slip: 0.02 }, NOW, 0.7);
  assert.equal(q?.piece, null);
  assert.equal(t.won, true);
  assert.ok(Math.abs(t.pnl! - (2.1 - 1.5 - 0.015)) < 1e-9);
  assert.equal(paperSell(t, 0, [{ price: 0.7, size: 100 }], { minUsd: 1, slip: 0.02 }, NOW, 0.7), null);
});

test("the exchange's answer: shares and dollars whichever way round; our own trades by order id", () => {
  assert.deepEqual(sellFill({ makingAmount: "5", takingAmount: "3" }, 5), { shares: 5, usd: 3 });
  assert.deepEqual(sellFill({ makingAmount: "3", takingAmount: "5" }, 5), { shares: 5, usd: 3 });
  assert.deepEqual(sellFill({ makingAmount: "", takingAmount: "" }, 5), { shares: 0, usd: 0 });
  assert.deepEqual(sellFill({ makingAmount: "50", takingAmount: "30" }, 5), { shares: 0, usd: 0 }, "more than we asked to sell is not believed");
  const trades = [{ taker_order_id: "o1", side: "SELL", size: "3", price: "0.6" }, { taker_order_id: "o1", side: "SELL", size: "2", price: "0.59", status: "FAILED" }, { taker_order_id: "o2", side: "SELL", size: "9", price: "0.6" }, { taker_order_id: "o1", side: "BUY", size: "9", price: "0.6" }];
  assert.deepEqual(soldFromTrades(trades, { orderId: "o1", t: NOW }), { shares: 3, usd: 1.8 });
  assert.deepEqual(soldFromTrades([{ side: "SELL", size: "3", price: "0.6", trader_side: "TAKER", match_time: String(TS + 5) }, { side: "SELL", size: "3", price: "0.6", trader_side: "MAKER", match_time: String(TS + 5) }], { t: NOW }), { shares: 3, usd: 1.8 });
});

test("REAL: the wallet sells half, we sell half on the book; the same sale from the socket and the reading is followed once", async () => {
  fresh([real()]);
  const ex = exchange();
  const d = deps({ trades: [paper()] });
  const rows = [act("SELL", 50, 0.62, TS - 5), act("BUY", 100, 0.4, TS - 900)];
  // the socket sees the sale first (its own row), then the 15 s reading brings the whole list
  const lines = await followSales(W, rows.slice(0, 1), rows, NOW, "stream", d);
  assert.equal(ex.sent.length, 1);
  assert.equal(ex.sent[0].amount, 5);
  assert.equal(ex.sent[0].tokenID, "tok0");
  assert.equal(String(ex.sent[0].side), "SELL");
  assert.equal(ex.sent[0].price, 0.58, "limited to 2c under the best bid");
  assert.ok(lines.some((l) => /REAL sold 5\.00 for \$3\.00 \(60c\), a part/.test(l)), lines.join(" | "));
  assert.deepEqual(await followSales(W, rows, rows, NOW + 15_000, "poll", d), []);
  assert.equal(ex.sent.length, 1);
  const file = eventLiveRows();
  assert.equal(file.length, 2);
  assert.equal(file[0].shares, 5);
  assert.equal(file[0].cost, 2.5);
  assert.equal(file[1].pnl, 3 - 2.5 - 0.05);
  // the paper twin did the same
  assert.equal(d.trades.length, 2);
  assert.equal(d.trades[0].shares, 3);
  // later it sells the rest: we are out, and the row is finished as sold
  const later = [act("SELL", 50, 0.7, TS + 60), ...rows];
  await followSales(W, later, later, NOW + 61_000, "poll", d);
  assert.equal(ex.sent.length, 2);
  assert.equal(ex.sent[1].amount, 5);
  const end = eventLiveRows();
  assert.equal(end.length, 2);
  assert.equal(end[0].status, "sold");
  assert.equal(end[0].pnl, 3 - 2.5 - 0.05);
  assert.equal(d.trades[0].pnl != null, true);
  const s = copySellStatus();
  assert.equal(s.realSales.n, 2);
  assert.equal(s.realSales.usd, 6);
  assert.equal(s.following, 0);
  assert.ok(!JSON.stringify(s).includes("tok0") && !JSON.stringify(s).includes(W.address));
});

test("REAL off: paper follows, no order is sent and the real row is untouched", async () => {
  fresh([real()], { real: false });
  const ex = exchange();
  const d = deps({ trades: [paper()] });
  const rows = [act("SELL", 50, 0.62, TS - 5), act("BUY", 100, 0.4, TS - 900)];
  await followSales(W, rows, rows, NOW, "poll", d);
  assert.equal(ex.sent.length, 0);
  assert.equal(eventLiveRows()[0].shares, 10);
  assert.equal(d.trades.length, 2);
  assert.equal(copySellStatus().real, false);
});

test("REAL: a small part waits and goes with the next sale; a share that cannot be told sells nothing", async () => {
  fresh([real()]);
  const ex = exchange();
  const rows = [act("SELL", 10, 0.62, TS - 5), act("BUY", 100, 0.4, TS - 900)];
  await followSales(W, rows, rows, NOW, "poll", deps());
  assert.equal(ex.sent.length, 0, "10% of ours is 1 share = 60c");
  const next = [act("SELL", 45, 0.62, TS + 30), ...rows];
  await followSales(W, next, next, NOW + 31_000, "poll", deps());
  assert.equal(ex.sent[0].amount, 5.5);
  // its buys are older than its list and Polymarket's positions are not readable: nothing is sold
  fresh([real()]);
  const ex2 = exchange();
  const cut = Array.from({ length: 200 }, (_, i) => act(i ? "BUY" : "SELL", 50, 0.6, TS - i, i ? { condition_id: "0x" + "cd".repeat(32) } : {}));
  const lines = await followSales(W, cut, cut, NOW, "poll", deps());
  assert.equal(ex2.sent.length, 0);
  assert.match(lines.join(" "), /cannot be told/);
  // readable: 50 sold, 150 still held = a quarter sold
  fresh([real()]);
  const ex3 = exchange();
  await followSales(W, cut, cut, NOW, "poll", deps({ remaining: async () => 150 }));
  assert.equal(ex3.sent[0].amount, 2.5);
});

test("REAL: no permission, a refusal and a held order are all safe; a held order is read from our trades and booked once", async () => {
  const rows = [act("SELL", 50, 0.62, TS - 5), act("BUY", 100, 0.4, TS - 900)];
  fresh([real()]);
  let ex = exchange({ allowances: { a: "0", b: "0" } });
  let lines = await followSales(W, rows, rows, NOW, "poll", deps());
  assert.equal(ex.sent.length, 0);
  assert.match(lines.join(" "), /permission missing/);
  assert.equal(eventLiveRows()[0].shares, 10);

  fresh([real()]);
  ex = exchange({ answer: () => ({ success: false, errorMsg: "not enough balance" }) });
  lines = await followSales(W, rows, rows, NOW, "poll", deps());
  assert.match(lines.join(" "), /refused \(not enough balance\)/);
  assert.equal(eventLiveRows().length, 1);
  // tried again a minute later, not before
  assert.deepEqual(await sellDue(deps(), Date.now() + 10_000), []);
  assert.equal((await sellDue(deps(), Date.now() + 61_000)).length, 1);
  assert.equal(ex.sent.length, 2);

  fresh([real()]);
  ex = exchange({ answer: () => ({ success: true, status: "delayed", orderID: "o9", makingAmount: "", takingAmount: "" }), trades: [] });
  lines = await followSales(W, rows, rows, NOW, "poll", deps());
  assert.match(lines.join(" "), /accepted with a delay/);
  assert.equal(copySellStatus().waiting, 1);
  // while it is held no second order goes out, and nothing is booked until our trades show it
  assert.deepEqual(await sellDue(deps(), Date.now() + 61_000), []);
  assert.equal(ex.sent.length, 1);
  assert.equal(eventLiveRows().length, 1);
  exchange({ trades: [{ taker_order_id: "o9", side: "SELL", size: "5", price: "0.6" }] });
  const got = await sellDue(deps(), Date.now() + 62_000);
  assert.match(got.join(" "), /REAL sold 5\.00 for \$3\.00/);
  assert.equal(eventLiveRows().length, 2);
  assert.deepEqual(await sellDue(deps(), Date.now() + 200_000), []);
  assert.equal(eventLiveRows().length, 2);
});

test("REAL: fewer shares in the wallet than on the row (fee taken in shares) still closes the row when the wallet gets out; a restart pending sends nothing", async () => {
  fresh([real()]);
  const ex = exchange({ bal: 9.8 });
  const rows = [act("SELL", 100, 0.62, TS - 5), act("BUY", 100, 0.4, TS - 900)];
  await followSales(W, rows, rows, NOW, "poll", deps());
  assert.equal(ex.sent[0].amount, 9.8);
  const file = eventLiveRows();
  assert.equal(file.length, 1);
  assert.equal(file[0].status, "sold");
  assert.ok(Math.abs(file[0].pnl! - (9.8 * 0.6 - 5 - 0.1)) < 1e-6);

  fresh([real()]);
  const ex2 = exchange();
  _eventLiveTest.busy(true);
  const lines = await followSales(W, rows, rows, NOW, "poll", deps());
  _eventLiveTest.busy(false);
  assert.equal(ex2.sent.length, 0);
  assert.match(lines.join(" "), /another real order is in flight/);
  assert.equal(eventLiveRows()[0].shares, 10);
});

test("what a wallet still holds: found, gone once the whole list was read, unknown when the list cannot be read", async () => {
  const page = (data: object[], next = "") => ({ data, pagination: { next_cursor: next } });
  const row = (c: string, i: number, size: number) => ({ condition_id: c, outcome_index: i, current_size: size });
  assert.equal(await walletRemaining("0x1", COND, 0, async () => page([row(COND, 1, 9), row(COND, 0, 150)])), 150);
  assert.equal(await walletRemaining("0x1", COND, 0, async () => page([{ conditionId: COND, outcomeIndex: 0, size: "12.5" }])), 12.5);
  assert.equal(await walletRemaining("0x1", COND, 0, async () => page([row("0x" + "cd".repeat(32), 0, 5)])), 0);
  assert.equal(await walletRemaining("0x1", COND, 0, async () => page([{ foo: 1 }])), null, "rows we cannot read prove nothing");
  assert.equal(await walletRemaining("0x1", COND, 0, async () => ({ nope: true })), null);
  assert.equal(await walletRemaining("0x1", COND, 0, async () => page([row("0x" + "cd".repeat(32), 0, 5)], "more")), null, "the list never ended");
});

test("queueExit: an open bet is queued once for a full sale, again only when its tries ran out", async () => {
  const { queueExit } = await import("./copysell.js");
  _copySellTest.reset();
  const r: import("./eventlive.js").EventLiveRow = { t: 1, group: "copy", rule: "copy-take-x", marketId: "m-exit", conditionId: null, title: "T", outcome: "Yes", idx: 0, ask: 0.5, size: 3, cost: 3, shares: 6, fee: 0.03, ok: true, status: "matched", error: null, pnl: null, won: null, settledAt: null };
  assert.equal(queueExit(r, 1_000), true);
  assert.equal(queueExit(r, 2_000), false);
  assert.equal(queueExit(r, 1_000 + 31 * 60_000), true, "stale: queued afresh");
});
