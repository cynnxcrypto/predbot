import assert from "node:assert/strict";
import { test } from "node:test";
import { SERIES, eventSlug, windowStart } from "./config.js";

test("event slugs: timestamp style and the hourly New York style", () => {
  assert.equal(eventSlug("btc-updown-4h", 1792569600), "btc-updown-4h-1792569600");
  // 6am ET on 21 Oct 2026 (EDT, UTC-4) is 10:00 UTC.
  const start = Date.UTC(2026, 9, 21, 10) / 1000;
  assert.equal(eventSlug("bitcoin-up-or-down", start, "et-hour"), "bitcoin-up-or-down-october-21-2026-6am-et");
  assert.equal(eventSlug("bitcoin-up-or-down", Date.UTC(2026, 9, 21, 16) / 1000, "et-hour"), "bitcoin-up-or-down-october-21-2026-12pm-et");
  assert.equal(eventSlug("bitcoin-up-or-down", Date.UTC(2026, 9, 21, 4) / 1000, "et-hour"), "bitcoin-up-or-down-october-21-2026-12am-et");
});

test("every series has a unique key, label and window length that fits its slug", () => {
  const keys = new Set(SERIES.map((s) => s.key));
  assert.equal(keys.size, SERIES.length);
  for (const s of SERIES) {
    assert.ok(/ (5m|15m|1h|4h|24h)$/.test(s.label), s.label);
    const w = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "24h": 86400 }[s.label.split(" ")[1]];
    assert.equal(s.windowSec, w, s.label);
  }
});

test("daily windows run noon to noon New York time and are named by the end day", () => {
  // 29 Oct 2026 08:30 UTC is 04:30 EDT: the running window started at noon EDT on 28 Oct = 16:00 UTC.
  const sec = Date.UTC(2026, 9, 29, 8, 30) / 1000;
  const start = windowStart(sec, 86400, "et-day");
  assert.equal(start, Date.UTC(2026, 9, 28, 16) / 1000);
  assert.equal(eventSlug("bitcoin-up-or-down", start, "et-day"), "bitcoin-up-or-down-on-october-29-2026");
  // just after noon EDT the new window begins
  assert.equal(windowStart(Date.UTC(2026, 9, 29, 16, 0, 5) / 1000, 86400, "et-day"), Date.UTC(2026, 9, 29, 16) / 1000);
  // after the clocks change (1 Nov 2026) noon is 17:00 UTC
  assert.equal(windowStart(Date.UTC(2026, 10, 3, 20) / 1000, 86400, "et-day"), Date.UTC(2026, 10, 3, 17) / 1000);
});
