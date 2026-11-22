import assert from "node:assert/strict";
import { test } from "node:test";
import { alignFlows, netOfFlows, worthWindows, type Flow } from "./worthdash.js";

test("a deposit booked before the worth showed it moves to the sample that shows it, so no window counts it as a gain", () => {
  const m = 60_000;
  // worth 500 flat; $100 deposited, booked at 10 min, but the worth shows it only from 40 min
  const raw: [number, number][] = [0, 10, 20, 30, 40, 50, 60].map((k) => [k * m, k * m >= 40 * m ? 600 : 500]);
  const fl: Flow[] = [[10 * m + 1, 100, "Solana perps"]];
  // as booked: the samples at 20 and 30 min hold 500 though the deposit is taken off after them, so a window starting
  // there reads +$100 that is only the deposit
  const booked = netOfFlows(raw, fl);
  assert.deepEqual(booked.map((p) => p[1]), [600, 600, 500, 500, 600, 600, 600]);
  const al = alignFlows(raw, fl);
  assert.equal(al[0][0], 40 * m - 1);
  assert.deepEqual(netOfFlows(raw, al).map((p) => p[1]), [600, 600, 600, 600, 600, 600, 600]);
  const w = worthWindows(netOfFlows(raw, al), 600, 60 * m + 1);
  assert.ok(w.every((x) => x.usd === 0));
});

test("a flow the worth never shows, a small one, and a withdrawal", () => {
  const m = 60_000;
  const raw: [number, number][] = [0, 10, 20, 30].map((k) => [k * m, k >= 20 ? 400 : 500]);
  assert.deepEqual(alignFlows(raw, [[5 * m, 300, "deposit"]]), [[5 * m, 300, "deposit"]]); // never shows: stays
  assert.deepEqual(alignFlows(raw, [[5 * m, 10, "deposit"]]), [[5 * m, 10, "deposit"]]); // under $20: stays
  assert.deepEqual(alignFlows(raw, [[5 * m, -100, "Hyperliquid"]]), [[20 * m - 1, -100, "Hyperliquid"]]);
});
