import assert from "node:assert/strict";
import { test } from "node:test";
import { flow, tally } from "./wallethistory.js";

test("wallet history: buys and splits are money out, sells, redeems and merges money in", () => {
  assert.deepEqual(flow({ type: "TRADE", side: "BUY", usdcSize: 5 }), { kind: "buy", usd: -5 });
  assert.deepEqual(flow({ type: "TRADE", side: "SELL", size: 10, price: 0.4 }), { kind: "sell", usd: 4 });
  assert.deepEqual(flow({ type: "REDEEM", usdcSize: "6" }), { kind: "redeem", usd: 6 });
  assert.deepEqual(flow({ type: "SPLIT", usdcSize: 3 }), { kind: "split", usd: -3 });
  assert.equal(flow({ type: "SOMETHING", usdcSize: 3 }), null);
});

test("wallet history: split at the server start, unknown kinds left out and counted", () => {
  const start = 1_000_000_000_000;
  const t = tally(
    [
      { type: "TRADE", side: "BUY", usdcSize: 5, timestamp: start / 1000 - 100 },
      { type: "REDEEM", usdcSize: 2, timestamp: start / 1000 - 50 },
      { type: "TRADE", side: "BUY", usdcSize: 3, timestamp: start / 1000 + 10 },
      { type: "MERGE", usdcSize: 4, timestamp: start + 20_000 }, // milliseconds are accepted too
      { type: "ODD", usdcSize: 9, timestamp: start / 1000 + 30 },
    ],
    start,
  );
  assert.deepEqual([t.before, t.since, t.rows], [-3, 1, 5]);
  assert.deepEqual(t.unknown, { ODD: 1 });
  assert.equal(t.kinds.buy.n, 2);
});
