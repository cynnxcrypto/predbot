import { test } from "node:test";
import assert from "node:assert/strict";
import { extraClaims, extraUnclaimed, waitingKinds, wonRows, RECLAIM_AFTER } from "./pmredeem.js";

const C = (n: number) => "0x" + String(n).padStart(64, "0");

test("wonRows keeps redeemable positions worth something, summed per market", () => {
  const w = wonRows([
    { condition_id: C(1), redeemable: true, current_value: 5, current_size: 5 },
    { condition_id: C(1), redeemable: true, current_value: 2.5, current_size: 2.5, negative_risk: true },
    { condition_id: C(2), redeemable: true, current_value: 0, current_size: 3 },
    { condition_id: C(3), redeemable: false, current_value: 4, current_size: 8 },
    { condition_id: "0x12", redeemable: true, current_value: 4, current_size: 4 },
  ]);
  assert.deepEqual(w, [{ c: C(1), v: 7.5, neg: true }]);
});

test("extraUnclaimed counts only what our books do not have waiting", () => {
  const pm = [
    { c: C(1), v: 10, neg: false },
    { c: C(2), v: 6, neg: false },
    { c: C(3), v: 4, neg: false },
    { c: C(7), v: 5, neg: false },
    { c: C(8), v: 2, neg: false },
  ];
  const bets = [
    { conditionId: C(1), shares: 10, pay: 1, settledAt: 1 }, // waiting in our books: already counted
    { conditionId: C(2), shares: 6, pay: 1, settledAt: 1 }, // claim marked done, still redeemable: not counted by us
    { conditionId: C(7), shares: 5, pnl: null }, // still open in our books: already counted as an open bet
    { conditionId: C(8), shares: 2, pay: 0, pnl: -1, settledAt: 1 }, // booked as lost, Polymarket says won
  ];
  const claims = { [C(2)]: { tx: "0xabc", at: 1 } };
  assert.equal(extraUnclaimed(pm, bets, claims), 12);
  assert.deepEqual(waitingKinds(pm, bets, claims), { waitingInOurBooks: { n: 1, usd: 10 }, claimMarkedDone: { n: 1, usd: 6 }, notInOurBets: { n: 1, usd: 4 }, stillOpenInOurBooks: { n: 1, usd: 5 }, settledAsLostInOurBooks: { n: 1, usd: 2 } });
});

test("extraClaims: new ones at once, done or given-up ones after 2 h and at most 3 more times", () => {
  const now = 10 * RECLAIM_AFTER;
  const pm = [C(1), C(2), C(3), C(4), C(5), C(6)].map((c) => ({ c, v: 3, neg: false }));
  const claims = {
    [C(2)]: { tx: "0x1", at: now - 1000 }, // claimed just now: wait for the data API
    [C(3)]: { tx: "0x1", at: now - RECLAIM_AFTER }, // claimed 2 h ago, still there: again
    [C(4)]: { tx: "0x1", at: 0, reclaims: 3 }, // tried enough
    [C(5)]: { tx: null, tries: 5, at: 0 }, // given up: a few more tries
    [C(6)]: { tx: null, tries: 1, at: now, nextAt: now + 1 }, // waiting for its next try
  };
  assert.deepEqual(extraClaims(pm, false, claims, now).map((w) => w.c), [C(1), C(3), C(5)]);
  assert.deepEqual(extraClaims(pm, true, claims, now), []);
});
