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

test("a deposit among the hourly estimates moves to the live step that took it in (15 Nov 08:37Z, 22 Nov 2026)", () => {
  const m = 60_000;
  // hourly estimates at 0 and 60 min (flag 1), live samples every 2 min from 90 min; the $202 shows only at 120 min
  const s: [number, number, ...unknown[]][] = [[0, 700, 1], [60 * m, 720, 1]];
  for (let k = 90; k <= 140; k += 2) s.push([k * m, k >= 120 ? 690 : 488]);
  const fl: Flow[] = [[30 * m, 101, "Solana spot copy"], [30 * m, 101, "Solana spot rules"]];
  const al = alignFlows(s, fl);
  assert.deepEqual(al.map((f) => f[0]), [120 * m - 1, 120 * m - 1]);
  // the window starting at the first live sample no longer counts the deposits as a gain
  const net = netOfFlows(s as [number, number][], al);
  assert.equal(net.find((p) => p[0] === 90 * m)![1], 690);
});
