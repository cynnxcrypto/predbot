import assert from "node:assert/strict";
import { test } from "node:test";
import { flowsBetween, repairClaims, unclaimedAt, winSpans, type Comp, type Flow } from "./worthdash.js";

test("worth: a won bet waiting for its claim is counted, and its claim is not a deposit", () => {
  const H = 3_600_000;
  const rows = [
    { shares: 30, pay: 1, settledAt: 1 * H, conditionId: "a" }, // claimed at 4 h
    { shares: 10, pay: 1, settledAt: 2 * H, conditionId: "b" }, // not claimed yet
    { shares: 10, pay: 0, settledAt: 2 * H, conditionId: "c" }, // lost
    { shares: 5, pay: 1, settledAt: null, conditionId: "d" }, // open
  ];
  const spans = winSpans(rows, { a: { at: 4 * H, tx: "0x1" }, b: { at: 3 * H, tx: null } });
  assert.equal(spans.length, 2);
  assert.equal(unclaimedAt(spans, 0.5 * H), 0);
  assert.equal(unclaimedAt(spans, 3 * H), 40);
  assert.equal(unclaimedAt(spans, 5 * H), 10);
  // kept samples: flat at 100 really; the old count dipped by the waiting wins and stepped up at the claim
  const hist: [number, number][] = [[0, 100], [1.5 * H, 70], [3 * H, 60], [4 * H + 60_000, 90]];
  const flows: Flow[] = [[4 * H + 60_000, 30, "Polymarket"], [2.5 * H, 50, "Polymarket"], [4 * H + 30_000, 12, "Solana perps"]];
  const rep = repairClaims(hist, flows, spans);
  assert.deepEqual(rep.hist.map((p) => p[1]), [100, 100, 100, 100]);
  assert.deepEqual(rep.flows.map((f) => f[1]), [50, 12]); // the real deposit and the other wallet stay
  assert.deepEqual([rep.removed, rep.removedUsd], [1, 30]);
  // a claim whose waiting side fell a few samples before the cash rose is still not a deposit
  const c = (pc: number, pk: number, pkh?: number[]): Comp => ({ pc, pk, pst: 0, sol: null, coins: 0, rules: null, perps: null, pkh });
  assert.equal(flowsBetween(c(100, 50, [80, 80]), c(130, 50), null, 1).length, 0);
  assert.deepEqual(flowsBetween(c(100, 50, [50, 50]), c(130, 50), null, 1), [[1, 30, "Polymarket"]]);
});
