import assert from "node:assert/strict";
import { test } from "node:test";
import { LAG, PAIRFAST, afterGap, book1, mark, newSim, onPrint, quote, sync, type Sim, type Spec } from "./pairfast.js";
import type { Book } from "./polymarket.js";

const c = (x: number) => Math.round(x * 100) / 100;
/** A book with `size` at the best bid, 50 on each of the four levels under it, and the ask 1c over the bid. */
const book = (bid: number, size: number, ask = c(bid + 0.01)): Book => ({ bids: [{ price: bid, size }, ...[1, 2, 3, 4].map((i) => ({ price: c(bid - i / 100), size: 50 }))], asks: [{ price: ask, size: 10 }], bestBid: bid, bestAsk: ask, bidDepth: 0, askDepth: 0 });
const spec = (over: Partial<Spec> = {}): Spec => ({ name: "t", key: "eth15m", offs: [0], slack: 3, maxImb: 1, from: 20, stop: 120, ...over });
const real = PAIRFAST.find((p) => p.name === "pairfast-top-lock-5m")!;
const T0 = 1_000_000; // window start, s
const at = (sec: number) => (T0 + sec) * 1000;
const view = (s: Sim) => s.orders.map((o) => [o.side, o.price, o.ahead, o.rem]);
const run = (s: Sim, sp: Spec, up: Book, down: Book, now: number) => {
  sync(s, up, down, now);
  quote(s, sp, up, down, now);
};

test("pairfast: a bid reaches the book LAG ms after the decision and joins behind what is shown then", () => {
  const s = newSim(T0, 900);
  run(s, spec(), book(0.48, 100), book(0.51, 20), at(10));
  assert.equal(s.orders.length, 0); // before `from`
  run(s, spec(), book(0.48, 100), book(0.51, 20), at(30));
  assert.deepEqual(view(s), [["U", 0.48, null, 6], ["D", 0.51, null, 6]]);
  // a print before the order has arrived cannot fill it
  assert.equal(onPrint(s, { price: 0.47, size: 500, side: "SELL" }, true, at(30) + 100), 0);
  // by the time it arrives the level is 140: that is the queue
  sync(s, book(0.48, 140), book(0.51, 20), at(30) + LAG);
  assert.deepEqual(view(s), [["U", 0.48, 140, 6], ["D", 0.51, 20, 6]]);
});

test("pairfast: only trades move us up the queue; a shrunken level is not counted twice with its print", () => {
  const s = newSim(T0, 900);
  run(s, spec(), book(0.48, 100), book(0.51, 20), at(30));
  sync(s, book(0.48, 100), book(0.51, 20), at(31));
  // 40 cancel from the Up level: still 100 ahead as far as we can know (100 > 60 is impossible, so 60)
  sync(s, book(0.48, 60), book(0.51, 20), at(32));
  assert.equal(s.orders[0].ahead, 60);
  // that drop was really a trade and its print arrives now: no second step forward
  assert.equal(onPrint(s, { price: 0.48, size: 40, side: "SELL" }, true, at(32) + 50), 0);
  assert.equal(s.orders[0].ahead, 60);
  // print first, book after: 25 trade, the level then shows 35
  assert.equal(onPrint(s, { price: 0.48, size: 25, side: "SELL" }, true, at(40)), 0);
  sync(s, book(0.48, 35), book(0.51, 20), at(40) + 20);
  assert.equal(s.orders[0].ahead, 35);
  // a buy of Up at 49c is a sale into the 51c Down level (15 of the 20 ahead of our Down bid); it does not touch the Up bid
  assert.equal(onPrint(s, { price: 0.49, size: 15, side: "BUY" }, true, at(41)), 0);
  assert.deepEqual([s.orders[0].ahead, s.orders[1].ahead], [35, 5]);
  // a sell at a better bid than ours does not reach us
  assert.equal(onPrint(s, { price: 0.49, size: 900, side: "SELL" }, true, at(41)), 0);
  // 38 more trade at our price: 35 ahead, 3 for us
  assert.equal(onPrint(s, { price: 0.48, size: 38, side: "SELL" }, true, at(45)), 3);
  assert.deepEqual([s.inv.U, c(s.cost.U), s.orders[0].rem], [3, 1.44, 3]);
  // a taker BUY of Down at 52c is a sale into the 48c Up level
  assert.equal(onPrint(s, { price: 0.52, size: 10, side: "BUY" }, false, at(46)), 3);
  assert.equal(s.inv.U, 6);
});

test("pairfast: a print through our price fills at most its own size, shared across our levels", () => {
  const s = newSim(T0, 900);
  const sp = spec({ offs: [0, 1, 2], maxImb: 3, slack: 2 });
  run(s, sp, book(0.48, 100), book(0.51, 100), at(30));
  sync(s, book(0.48, 100), book(0.51, 100), at(31));
  assert.deepEqual(s.orders.filter((o) => o.side === "U").map((o) => [o.price, o.ahead]), [[0.46, 50], [0.47, 50], [0.48, 100]]);
  // 8 shares sold at 45c: the level above was gone, so our 48c bid takes 6 and our 47c bid 2
  assert.equal(onPrint(s, { price: 0.45, size: 8, side: "SELL" }, true, at(32)), 8);
  assert.deepEqual(s.fills.map((f) => [f.price, f.size, f.through]), [[0.48, 6, true], [0.47, 2, true]]);
  assert.deepEqual(s.orders.filter((o) => o.side === "U").map((o) => [o.price, o.rem]), [[0.46, 6], [0.47, 4]]);
});

test("pairfast: bids rest when the best bid moves, and the long side stops quoting", () => {
  const s = newSim(T0, 900);
  run(s, spec(), book(0.48, 100), book(0.51, 20), at(30));
  sync(s, book(0.48, 100), book(0.51, 20), at(31));
  // the Up bid moves up 2c: our bid stays at 48c with its place (3c of slack)
  run(s, spec(), book(0.5, 30), book(0.49, 20), at(40));
  assert.deepEqual(view(s).filter((o) => o[0] === "U"), [["U", 0.48, 50, 6]]);
  assert.equal(s.cancelled, 0);
  // 4c behind: cancelled (still fillable until the cancel lands) and re-placed at the best bid
  run(s, spec(), book(0.52, 30), book(0.47, 20), at(50));
  const ups = s.orders.filter((o) => o.side === "U");
  assert.deepEqual(ups.map((o) => [o.price, o.deadAt != null]), [[0.48, true], [0.52, false]]);
  assert.equal(onPrint(s, { price: 0.46, size: 6, side: "SELL" }, true, at(50) + 100), 6); // the dying bid is hit
  // long Up by one clip: no Up bid at all; the Down bid keeps resting where it was (the level above it emptied on the
  // way, so nothing is ahead of it any more)
  run(s, spec(), book(0.46, 30), book(0.53, 20), at(51));
  sync(s, book(0.46, 30), book(0.53, 20), at(52));
  assert.deepEqual(view(s), [["D", 0.51, 0, 6]]);
});

test("pairfast: the control re-joins the best bid every time it moves; post-only bids that would cross are rejected", () => {
  const s = newSim(T0, 900);
  const sp = spec({ slack: 0 });
  run(s, sp, book(0.48, 100), book(0.51, 20), at(30));
  sync(s, book(0.48, 100), book(0.51, 20), at(31));
  run(s, sp, book(0.49, 10), book(0.5, 20), at(40));
  assert.deepEqual(s.orders.filter((o) => o.side === "U").map((o) => [o.price, o.deadAt != null]), [[0.48, true], [0.49, false]]);
  // by the time the 49c bid arrives the ask has dropped to 49c: rejected
  sync(s, book(0.47, 10, 0.49), book(0.5, 20), at(40) + LAG);
  assert.equal(s.rejected, 1);
  assert.deepEqual(s.orders.filter((o) => o.side === "U"), []);
});

test("pairfast: the lock twin never bids the missing side above 99c minus what the other side cost", () => {
  const s = newSim(T0, 900);
  const sp = spec({ offs: [0, 1, 2], maxImb: 3, slack: 2, lock: true });
  s.inv.U = 6;
  s.cost.U = 6 * 0.48;
  run(s, sp, book(0.44, 30), book(0.55, 20), at(60));
  // Down may cost at most 51c: 55c..53c are all over the cap
  assert.deepEqual(s.orders.filter((o) => o.side === "D"), []);
  run(s, sp, book(0.47, 30), book(0.52, 20), at(61));
  assert.deepEqual(s.orders.filter((o) => o.side === "D").map((o) => o.price), [0.5, 0.51]);
  // Up is one clip long: room for two clips. The 43c bid from before is within 2c of the ladder and keeps its place,
  // the 42c bid is pulled, and the one new bid goes on the deepest empty step
  assert.deepEqual(s.orders.filter((o) => o.side === "U" && o.deadAt == null).map((o) => o.price), [0.43, 0.45]);
});

test("pairfast: near the close only the missing side may still fill; everything is pulled 15 s before the end", () => {
  const s = newSim(T0, 900);
  s.inv.D = 6;
  s.cost.D = 3;
  run(s, spec(), book(0.48, 30), book(0.51, 20), at(800));
  assert.deepEqual(view(s), [["U", 0.48, null, 6]]);
  run(s, spec(), book(0.48, 30), book(0.51, 20), at(886));
  assert.ok(s.orders.every((o) => o.deadAt != null));
  sync(s, book(0.48, 30), book(0.51, 20), at(887));
  assert.equal(s.orders.length, 0);
});

test("pairfast: after a hole in the feed a bid the market traded through counts as filled; fills are marked later", () => {
  const s = newSim(T0, 900);
  run(s, spec(), book(0.48, 100), book(0.51, 20), at(30));
  sync(s, book(0.48, 100), book(0.51, 20), at(31));
  afterGap(s, book(0.44, 10), book(0.55, 10), at(60));
  assert.deepEqual([s.inv.U, s.inv.D, s.fills[0].gap, s.gaps], [6, 0, true, 1]);
  mark(s, book(0.44, 10), book(0.55, 10), at(63));
  assert.equal(s.fills[0].swept, true);
  mark(s, book(0.42, 10, 0.44), book(0.56, 10), at(91));
  assert.deepEqual([s.fills[0].mk10, s.fills[0].mk30], [-0.05, -0.05]);
});

test("pairfast: a settled window is split into the paired part and the lone part", () => {
  const t = { windows: 0, won: 0, net: 0, pairShares: 0, pairNet: 0, loneShares: 0, loneNet: 0, loneWindows: 0, loneWon: 0, day: "", dayNet: 0, dayWindows: 0, recent: [] } as unknown as Parameters<typeof book1>[0];
  // 12 Up at 48c, 6 Down at 50c, Down wins: pairs 6 x (1 - 0.98) = +0.12, lone 6 Up lost -2.88
  book1(t, { name: "t", key: "eth15m", start: T0, up: 12, down: 6, upCost: 5.76, downCost: 3, fills: 3, gaps: 0 }, false);
  assert.deepEqual([t.windows, t.won, t.net, t.pairNet, t.loneNet, t.loneWindows, t.loneWon], [1, 0, -2.76, 0.12, -2.88, 1, 0]);
});

test("pairfast: every rule is paper, on ETH 15m or BTC 5m, with a unique name", () => {
  assert.equal(new Set(PAIRFAST.map((p) => p.name)).size, PAIRFAST.length);
  assert.ok(PAIRFAST.every((p) => p.name.startsWith("pairfast-") && ["eth15m", ""].includes(p.key)));
});

test("pairfast: the twin of the real rule starts pairs only at 17-83c and stops after one pair a window", () => {
  const s = newSim(T0, 300);
  run(s, real, book(0.12, 30), book(0.87, 20), at(30));
  assert.equal(s.orders.length, 0);
  run(s, real, book(0.48, 30), book(0.51, 20), at(31));
  assert.equal(s.orders.length, 2);
  const t = newSim(T0, 300);
  Object.assign(t, { inv: { U: 6, D: 6 }, cost: { U: 2.88, D: 3.06 } });
  run(t, real, book(0.48, 30), book(0.51, 20), at(31));
  assert.equal(t.orders.length, 0);
  // no new pair in the last 2 minutes
  run(newSim(T0, 300), real, book(0.48, 30), book(0.51, 20), at(185));
});
