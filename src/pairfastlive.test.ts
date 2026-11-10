import assert from "node:assert/strict";
import { test } from "node:test";
import { HARD_MAX_LOSS, desired, exposure, lostSoFar, newWin, parseFast, worstCase, type FastConfig, type Win } from "./pairfastlive.js";
import type { Book } from "./polymarket.js";

const book = (bid: number): Book => ({ bids: [{ price: bid, size: 100 }], asks: [{ price: bid + 0.01, size: 10 }], bestBid: bid, bestAsk: bid + 0.01, bidDepth: 0, askDepth: 0 });
const cfg: FastConfig = { on: true, clip: 6, maxLoss: 15, maxPairs: 1, slack: 3, minBalance: 235 };
const T = 300_000; // a window start
const ord = (price: number, size = 6, matched = 0) => ({ id: "x", price, size, matched, at: 0 });
const rules = (pairfast: unknown, more: Record<string, unknown> = {}) => JSON.stringify({ mode: "live", minBalance: 235, pairfast, ...more });
const local = { mode: "live", funder: "f" };

test("pairfastlive: off unless its own block says on; BTC 5m only; never more than $15, $5 an order", () => {
  assert.equal(parseFast("{}", local).on, false);
  assert.equal(parseFast("not json", local).on, false);
  assert.equal(parseFast(rules({ on: false, series: ["btc5m"], maxLoss: 15 }), local).on, false);
  assert.equal(parseFast(rules({ on: true, series: ["btc5m"], maxLoss: 15 }), { mode: "off", funder: "f" }).on, false);
  assert.equal(parseFast(rules({ on: true, series: ["btc5m"], maxLoss: 15 }), { mode: "live" }).on, false);
  assert.equal(parseFast(rules({ on: true, series: ["btc5m"], maxLoss: 15 }, { mode: "paper" }), local).on, false);
  assert.equal(parseFast(rules({ on: true, series: ["eth15m"], maxLoss: 15 }), local).on, false);
  assert.equal(parseFast(rules({ on: true, series: ["btc5m", "eth15m"], maxLoss: 15 }), local).on, false);
  assert.equal(parseFast(rules({ on: true, series: ["btc5m"] }), local).on, false); // no budget given
  // the old pair test on BTC 5m at the same time: off (they would cancel each other's orders)
  assert.equal(parseFast(rules({ on: true, series: ["btc5m"], maxLoss: 15 }, { pairs: { on: true, series: ["btc5m"] } }), local).on, false);
  assert.equal(parseFast(rules({ on: true, series: ["btc5m"], maxLoss: 15 }, { pairs: { on: false, series: ["btc5m"] } }), local).on, true);
  const c = parseFast(rules({ on: true, series: ["btc5m"], maxLoss: 500, clip: 50, maxPairs: 99, slack: 40 }), local);
  assert.deepEqual(c, { on: true, clip: 6, maxLoss: HARD_MAX_LOSS, maxPairs: 3, slack: 6, minBalance: 235 });
  assert.equal(HARD_MAX_LOSS, 15);
  assert.ok(c.clip * 0.83 <= 5);
});

test("pairfastlive: budget arithmetic: a resting bid counts as if it fills and its pair never comes", () => {
  const w = newWin(T);
  assert.equal(exposure(w, { U: null, D: null }), 0);
  // two first legs resting: the worst is the dearer one filling alone (both filling is a pair under $1: no loss)
  assert.equal(Math.round(exposure(w, { U: { price: 0.48, size: 6 }, D: { price: 0.51, size: 6 } }) * 100), 306);
  // holding a lone Up clip at 48c: $2.88 at risk; a completing Down bid adds nothing to the worst case
  w.up = { shares: 6, cost: 2.88, last: 0.48 };
  assert.equal(worstCase(w), 2.88);
  assert.equal(exposure(w, { U: null, D: { price: 0.51, size: 6 } }), 2.88);
  // a finished pair at 99c can lose nothing more
  w.down = { shares: 6, cost: 3.06, last: 0.51 };
  assert.equal(worstCase(w), 0);
  assert.equal(lostSoFar([{ net: -2.88 }, { net: 0.06 }, { net: -3 }]), 5.82);
  assert.equal(lostSoFar([{ net: 1 }]), 0);
});

test("pairfastlive: no new pair unless its worst case fits in what is left of the $15", () => {
  const w = newWin(T);
  const both = { U: { price: 0.48, size: 6 }, D: { price: 0.51, size: 6 } };
  assert.deepEqual(desired(w, book(0.48), book(0.51), T + 60, cfg, true, 15), both);
  assert.deepEqual(desired(w, book(0.48), book(0.51), T + 60, cfg, true, 3.06), both); // exactly fits
  assert.deepEqual(desired(w, book(0.48), book(0.51), T + 60, cfg, true, 3.05), { U: null, D: null }); // 1c short: nothing
  // bids already resting are dropped too once they no longer fit (another window's loss settled meanwhile)
  w.orders = { U: ord(0.48), D: ord(0.51) };
  assert.deepEqual(desired(w, book(0.48), book(0.51), T + 60, cfg, true, 2), { U: null, D: null });
  // ...but a pair already begun may always be completed, even with no room and the guards saying no
  w.orders = { U: null, D: null };
  w.up = { shares: 6, cost: 2.88, last: 0.48 };
  assert.deepEqual(desired(w, book(0.46), book(0.51), T + 60, cfg, false, 0), { U: null, D: { price: 0.51, size: 6 } });
  // simulate the whole budget: every window ends with a lone clip that loses; settled loss never passes $15
  let lost = 0;
  for (let i = 0; i < 50; i++) {
    const x = newWin(T);
    const d = desired(x, book(0.48), book(0.51), T + 60, cfg, true, cfg.maxLoss - lost);
    if (!d.D) break;
    lost += d.D.price * d.D.size; // the dearer side fills and loses
  }
  assert.ok(lost <= 15 && lost > 15 - 3.06, String(lost));
});

test("pairfastlive: bids rest (kept within the slack), pairs never over 99c, timing and band", () => {
  const w: Win = newWin(T);
  const none = { U: null, D: null };
  assert.deepEqual(desired(w, book(0.48), book(0.51), T + 5, cfg, true, 15), none); // first 10 s
  assert.deepEqual(desired(w, book(0.48), book(0.51), T + 181, cfg, true, 15), none); // last 2 minutes: no first leg
  assert.deepEqual(desired(w, book(0.5), book(0.5), T + 60, cfg, true, 15), none); // bids add to $1
  assert.deepEqual(desired(w, book(0.1), book(0.89), T + 60, cfg, true, 15), none); // outside 17-83c
  assert.deepEqual(desired(w, book(0.48), book(0.51), T + 60, cfg, false, 15), none); // a guard says no
  assert.deepEqual(desired(w, book(0.48), book(0.51), T + 60, { ...cfg, on: false }, true, 15), none);
  // resting at 46c / 51c; others step in front on Up at 48c: our 46c bid stays where it is, with its place in the queue
  w.orders = { U: ord(0.46), D: ord(0.51) };
  assert.deepEqual(desired(w, book(0.48), book(0.51), T + 70, cfg, true, 15), { U: { price: 0.46, size: 6 }, D: { price: 0.51, size: 6 } });
  // 4c behind: re-placed at the best bid
  w.orders.U = ord(0.44);
  assert.deepEqual(desired(w, book(0.48), book(0.51), T + 70, cfg, true, 15), { U: { price: 0.48, size: 6 }, D: { price: 0.51, size: 6 } });
  w.orders.U = ord(0.48);
  // Down filled at 51c: Up may cost at most 48c. Up's best bid is 53c: the resting 48c bid stays, nothing is raised
  w.orders.D = null;
  w.down = { shares: 6, cost: 3.06, last: 0.51 };
  assert.deepEqual(desired(w, book(0.53), book(0.45), T + 80, cfg, true, 15), { U: { price: 0.48, size: 6 }, D: null });
  // with no Up bid resting, a new one goes at min(best bid, cap)
  w.orders.U = null;
  assert.deepEqual(desired(w, book(0.53), book(0.45), T + 80, cfg, true, 15), { U: { price: 0.48, size: 6 }, D: null });
  assert.deepEqual(desired(w, book(0.4), book(0.59), T + 80, cfg, true, 15), { U: { price: 0.4, size: 6 }, D: null });
  // the completing bid may rest into the last 2 minutes, and is pulled 15 s before the close
  assert.deepEqual(desired(w, book(0.4), book(0.59), T + 250, cfg, true, 15), { U: { price: 0.4, size: 6 }, D: null });
  assert.deepEqual(desired(w, book(0.4), book(0.59), T + 286, cfg, true, 15), none);
  // a resting completion bid 4c behind the best bid (but under the cap) is re-placed at the best bid, still under the cap
  w.orders.U = ord(0.4);
  assert.deepEqual(desired(w, book(0.44), book(0.55), T + 100, cfg, true, 15), { U: { price: 0.44, size: 6 }, D: null });
  // one pair done, maxPairs 1: finished for this window
  w.orders.U = null;
  w.up = { shares: 6, cost: 2.4, last: 0.4 };
  assert.deepEqual(desired(w, book(0.48), book(0.51), T + 100, cfg, true, 15), none);
});
