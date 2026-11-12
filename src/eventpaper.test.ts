import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBook, slugDate, solveQ, tennisTour, walk, winMarketFor, zonedUtc } from "./eventpaper.js";

test("eventpaper helpers", () => {
  const q = solveQ(0.648);
  assert.ok(Math.abs(q * q * (3 - 2 * q) - 0.648) < 1e-6);
  assert.ok(Math.abs(solveQ(0.5) - 0.5) < 1e-6);
  const b = parseBook({ bids: [{ price: "0.40", size: "10" }], asks: [{ price: "0.45", size: "20" }, { price: "0.43", size: "5" }] });
  assert.equal(b.bestAsk, 0.43);
  assert.equal(b.mid, (0.4 + 0.43) / 2);
  const w = walk(b.asks, 5, 0.45);
  assert.ok(w.full && Math.abs(w.cost - 5) < 1e-9 && w.avg! > 0.43 && w.avg! < 0.45);
  assert.equal(walk(b.asks, 5, 0.43).full, false);
  assert.deepEqual(slugDate("xauusd-up-or-down-on-november-9-2026"), [2026, 11, 9]);
  assert.equal(new Date(zonedUtc(2026, 11, 9, 17, "America/New_York")).toISOString(), "2026-11-09T22:00:00.000Z");
  assert.equal(new Date(zonedUtc(2026, 7, 9, 16, "America/New_York")).toISOString(), "2026-07-09T20:00:00.000Z");
});

test("football win market matching", () => {
  const ms = [{ question: "Will Real Madrid CF win on 2026-11-08?" }, { question: "Will Valencia CF vs. Real Madrid CF end in a draw?" }, { question: "Will Valencia CF win on 2026-11-08?" }];
  assert.equal(winMarketFor("Real Madrid", ms.filter((m) => !/draw/.test(m.question))), 0);
  assert.equal(winMarketFor("Valencia", [ms[0], ms[2]]), 1);
  assert.equal(winMarketFor("Atlético Madrid", [{ question: "Will Atletico Madrid win?" }, { question: "Will Sevilla win?" }]), 0);
});

test("tennis tour", () => {
  assert.equal(tennisTour("WTA Linz: Swiatek vs Gauff"), "wta");
  assert.equal(tennisTour("ATP Paris Masters: Sinner vs Alcaraz"), "atp");
  assert.equal(tennisTour("ITF W35 Tokyo: A vs B"), "itf");
  assert.equal(tennisTour("WTA Doubles: Kichenok/Ostapenko vs X/Y"), null);
  assert.equal(tennisTour("Some exhibition"), null);
});

test("weather forecast share per bucket label", async () => {
  const { wxBucketProb } = await import("./eventpaper.js");
  const maxC = [20.2, 20.6, 21.4, 22.0, 23.6]; // rounds to 20, 21, 21, 22, 24 C; 68, 69, 71, 72, 74 F
  assert.equal(wxBucketProb("21°C", maxC), 0.4);
  assert.equal(wxBucketProb("20°C or below", maxC), 0.2);
  assert.equal(wxBucketProb("22°C or higher", maxC), 0.4);
  assert.equal(wxBucketProb("70-71°F", maxC), 0.2);
  assert.equal(wxBucketProb("72°F or higher", maxC), 0.4);
  assert.equal(wxBucketProb("no number", maxC), null);
  assert.equal(wxBucketProb("21°C", []), null);
});

test("wx-no-maker: a resting NO bid fills only from trades at its price after the queue ahead, or through it", async () => {
  const { noMakerFill } = await import("./eventpaper.js");
  const mk = { bid: 0.8, ahead: 10, got: 0, shares: 6.25, seen: 100, yes: "Y", no: "N" };
  // old trade, a buy of NO, a sale at a better NO bid: nothing
  assert.equal(noMakerFill(mk, [{ timestamp: 90, side: "SELL", token_id: "N", price: 0.8, size: 50 }, { timestamp: 110, side: "BUY", token_id: "N", price: 0.82, size: 50 }, { timestamp: 111, side: "SELL", token_id: "N", price: 0.81, size: 50 }]), false);
  assert.deepEqual([mk.ahead, mk.got], [10, 0]);
  // a YES buy at 20c is a sale into NO bids at 80c: 12 shares eat the 10 ahead, 2 reach us
  assert.equal(noMakerFill(mk, [{ timestamp: 120, side: "BUY", token_id: "Y", price: 0.2, size: 12 }]), false);
  assert.deepEqual([mk.ahead, mk.got, mk.seen], [0, 2, 120]);
  // the same row again is not counted twice; a sale through our price fills the rest
  assert.equal(noMakerFill(mk, [{ timestamp: 120, side: "BUY", token_id: "Y", price: 0.2, size: 12 }, { timestamp: 130000, side: "SELL", token_id: "N", price: 0.79, size: 5 }]), true);
});

test("closing price: size-weighted, other token counted at 1 - price, only inside the window", async () => {
  const { closeVwap } = await import("./eventpaper.js");
  const rows = [
    { timestamp: 1000, token_id: "A", price: 0.6, size: 10 },
    { timestamp: 1100, token_id: "B", price: 0.3, size: 30 }, // = A at 0.70
    { timestamp: 5000, token_id: "A", price: 0.9, size: 100 }, // outside
  ];
  assert.equal(closeVwap(rows, "A", "B", 900, 1200, 1), 0.675);
  assert.equal(closeVwap(rows, "A", "B", 900, 1200), null); // fewer than 5 prints: no close
  assert.equal(closeVwap(rows, "A", "B", 2000, 3000), null);
});

test("wx-copy: only the wallet's new buys are read, oldest first", async () => {
  const { wxCopyBuys, WX_COPY_WALLET } = await import("./eventpaper.js");
  assert.match(WX_COPY_WALLET, /^0x[0-9a-f]{40}$/);
  const rows = [
    { type: "TRADE", side: "BUY", price: "0.33", timestamp: 2000, condition_id: "0xb", outcome: "Yes" },
    { type: "TRADE", side: "SELL", price: 0.4, timestamp: 2001, condition_id: "0xc", outcome: "Yes" },
    { type: "REDEEM", timestamp: 2002, condition_id: "0xd" },
    { type: "TRADE", side: "BUY", price: 0.8, timestamp: 1500, condition_id: "0xa", outcome: "No" },
    { type: "TRADE", side: "BUY", price: 0.5, timestamp: 1000, condition_id: "0xe", outcome: "Yes" },
    { type: "TRADE", side: "BUY", price: 1, timestamp: 3000, condition_id: "0xf", outcome: "Yes" },
  ];
  assert.deepEqual(wxCopyBuys(rows, 1000), [
    { ts: 1500, cond: "0xa", yes: false, price: 0.8 },
    { ts: 2000, cond: "0xb", yes: true, price: 0.33 },
  ]);
});
