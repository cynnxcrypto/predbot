import assert from "node:assert/strict";
import { test } from "node:test";
import { BookFeed } from "./feeds/book.js";

const UP = "111";
const DOWN = "222";

test("book feed: snapshot, level changes and removals", () => {
  const feed = new BookFeed();
  feed.watch([UP, DOWN], false);
  feed.handle({ event_type: "book", asset_id: UP, bids: [{ price: "0.92", size: "100" }, { price: "0.90", size: "50" }], asks: [{ price: "0.93", size: "40" }, { price: "0.95", size: "10" }] });
  let b = feed.peek(UP);
  assert.ok(b);
  assert.equal(b.bestBid, 0.92);
  assert.equal(b.bestAsk, 0.93);
  assert.equal(b.askDepth, 50);
  // Old-style price_change: one asset, a list of changes. Size is the new total at that level; 0 removes it.
  feed.handle({ event_type: "price_change", asset_id: UP, changes: [{ price: "0.93", size: "0", side: "SELL" }, { price: "0.94", size: "25", side: "SELL" }] });
  b = feed.peek(UP);
  assert.equal(b?.bestAsk, 0.94);
  assert.equal(b?.askDepth, 35);
  // New-style price_change: several assets in one event.
  feed.handle({ event_type: "price_change", price_changes: [{ asset_id: UP, price: "0.92", size: "0", side: "BUY" }, { asset_id: DOWN, price: "0.05", size: "9", side: "BUY" }] });
  assert.equal(feed.peek(UP)?.bestBid, 0.9);
  // DOWN never had a snapshot, so its changes are ignored and it stays unknown.
  assert.equal(feed.peek(DOWN), null);
  // Not connected: get() returns nothing, so callers fall back to HTTP.
  assert.equal(feed.get(UP), null);
  // Unwatched tokens are dropped.
  feed.watch([DOWN], false);
  assert.equal(feed.peek(UP), null);
});

test("book feed: an HTTP read resets the cache", () => {
  const feed = new BookFeed();
  feed.watch([UP], false);
  feed.reset(UP, [{ price: 0.5, size: 10 }], [{ price: 0.6, size: 5 }]);
  assert.equal(feed.peek(UP)?.bestAsk, 0.6);
  feed.reset(DOWN, [{ price: 0.5, size: 10 }], []);
  assert.equal(feed.peek(DOWN), null);
});
