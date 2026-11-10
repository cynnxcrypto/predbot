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
