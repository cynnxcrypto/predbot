import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECKPOINTS, windowStart } from "./config.js";
import { Feed } from "./feeds/socket.js";

test("window start rounds down to the 5-minute edge", () => {
  assert.equal(windowStart(1791972000), 1791972000);
  assert.equal(windowStart(1791972299), 1791972000);
  assert.equal(windowStart(1791972300), 1791972300);
});

test("checkpoints are unique and descending", () => {
  const sorted = [...CHECKPOINTS].sort((a, b) => b - a);
  assert.deepEqual(CHECKPOINTS, sorted);
  assert.equal(new Set(CHECKPOINTS).size, CHECKPOINTS.length);
});

test("feed keeps ticks in order and answers at()/between()", () => {
  const feed = new Feed({ name: "t", url: "wss://example.invalid", onText: () => undefined });
  const push = (feed as unknown as { push: (t: number, p: number) => void }).push;
  push(1000, 10);
  push(2000, 11);
  push(1500, 99); // out of order: dropped
  push(2000, 12); // same stamp: replaced
  assert.deepEqual(feed.ticks, [{ t: 1000, price: 10 }, { t: 2000, price: 12 }]);
  assert.equal(feed.at(1999)?.price, 10);
  assert.equal(feed.at(2000)?.price, 12);
  assert.equal(feed.at(999), null);
  assert.equal(feed.between(1000, 1500).length, 1);
});
