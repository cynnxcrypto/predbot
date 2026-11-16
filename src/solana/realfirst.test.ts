import assert from "node:assert/strict";
import { test } from "node:test";
import { cutReason, realRecord, standing, CUT_MIN_TRADES } from "./realfirst.js";

test("real first: who is real", () => {
  const none = realRecord([]);
  // no real trades yet: the paper bar decides
  assert.deepEqual(standing(none, true), { real: true, why: "real: paper record at the bar" });
  assert.deepEqual(standing(none, false), { real: false, why: "paper: paper record not at the bar yet" });
  // real trades, ahead or level: real, whatever paper says
  assert.equal(standing(realRecord([2, -1]), false).real, true);
  assert.equal(standing(realRecord([2, -1]), false).why, "real: its real record is ahead (1 of 2 won); paper record is under the bar");
  assert.equal(standing(realRecord([1, -1]), false).real, true, "level counts as zero or better");
  // behind on fewer than three real trades: paper still decides
  assert.equal(standing(realRecord([-1]), true).real, true);
  assert.equal(standing(realRecord([-1]), false).real, false);
  // after a cut there are no real trades since: only new paper trades bring it back
  assert.deepEqual(standing(none, false, "cut: real record behind after 3 trades"), { real: false, why: "paper: cut: real record behind after 3 trades; returns on new paper trades at the bar" });
  assert.equal(standing(none, true, "cut: real record behind after 3 trades").why, "real: back on new paper trades at the bar");
});

test("real first: who is cut", () => {
  assert.equal(CUT_MIN_TRADES, 3);
  assert.equal(cutReason(realRecord([-1, -1]), 10), "", "two losing trades under the stop: not yet");
  assert.equal(cutReason(realRecord([-1, -1, 1.5]), 10), "cut: real record behind after 3 trades");
  assert.equal(cutReason(realRecord([-1, -1, 2]), 10), "", "level after three: stays");
  assert.equal(cutReason(realRecord([3, 3, -1]), 10), "", "a winner with one loss stays");
  assert.equal(cutReason(realRecord([-10]), 10), "cut: real trades reached the loss stop", "the loss stop needs no three trades");
  assert.equal(cutReason(realRecord([-4]), 0), "", "no stop set: only the three-trade rule");
  // cents that add up to exactly nothing: as floats 0.3 - 0.1 - 0.2 is a hair under zero, which must not read as behind
  assert.ok(0.3 - 0.1 - 0.2 < 0);
  assert.equal(realRecord([0.3, -0.1, -0.2]).net, 0);
  assert.equal(cutReason(realRecord([0.3, -0.1, -0.2]), 10), "", "level in cents after three: stays");
  assert.equal(standing(realRecord([0.3, -0.1, -0.2]), false).real, true);
  assert.equal(cutReason(realRecord([-3.3, -3.3, -3.4]), 10), "cut: real trades reached the loss stop", "exactly at the stop in cents");
});
