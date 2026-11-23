import assert from "node:assert/strict";
import { test } from "node:test";
import { _rateTest, hlHttp, hlHttpSummary } from "./ratelog.js";

test("Hyperliquid answers by status: 429s counted by who asked, the last hour kept", () => {
  _rateTest.reset();
  const t = 1_800_000_000_000;
  hlHttp(200, "real", t);
  hlHttp(429, "real", t);
  hlHttp(429, "paper", t + 1000);
  hlHttp(500, "paper", t + 1000);
  hlHttp(null, "real", t + 2000);
  let s = hlHttpSummary(t + 10_000);
  assert.deepEqual(s.sinceStart, { ok: 1, http429: 2, otherHttp: 1, noAnswer: 1 });
  assert.deepEqual(s.lastHour.http429, { n: 2, by: { real: 1, paper: 1 } });
  assert.equal(s.last429AgoS, 9);
  s = hlHttpSummary(t + 2 * 3_600_000);
  assert.equal(s.lastHour.http429.n, 0);
  assert.equal(s.sinceStart.http429, 2);
  assert.equal(s.last429AgoS, null);
});
