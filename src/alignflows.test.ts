import assert from "node:assert/strict";
import { test } from "node:test";
import { netOfFlows, settleBase, settleTimes, worthWindows, type Flow } from "./worthdash.js";

test("7 d: a deposit the worth shows only in parts over the next hours is counted once, never as a gain", () => {
  const H = 3_600_000;
  const now = 20 * 24 * H;
  const f0 = now - 7 * 24 * H - 2 * H; // booked 7 d 2 h ago
  // worth 500 flat; $300 deposited at f0 that the worth shows a third at a time, at +1 h, +3 h and +9 h
  const raw: [number, number][] = [];
  for (let t = now - 9 * 24 * H; t <= now; t += H / 2) {
    const got = (t >= f0 + H ? 100 : 0) + (t >= f0 + 3 * H ? 100 : 0) + (t >= f0 + 9 * H ? 100 : 0);
    raw.push([t, 500 + got]);
  }
  const fl: Flow[] = [[f0, 300, "Solana spot copy"], [f0 + H, -5, "Polymarket"]];
  assert.deepEqual(settleTimes(fl), [f0]); // the small flow is not in it
  const h = netOfFlows(raw, fl.slice(0, 1));
  const settle = settleTimes(fl);
  // as booked, a window starting 2 h after the deposit reads +$200 that is only the deposit
  assert.equal(worthWindows(h, 800, now).find((w) => w.k === "7d")!.usd, 200);
  // measured from before the deposit: 0, for every start within the day after it
  for (const back of [0, 1, 2, 5, 8, 20]) {
    const nw = now - back * H;
    const w = worthWindows(h.filter((p) => p[0] <= nw), 800, nw, settle).find((x) => x.k === "7d")!;
    assert.equal(w.usd, 0, `${back} h back`);
  }
  // past the day it is the plain start again
  assert.equal(settleBase(f0 + 25 * H, settle), f0 + 25 * H);
  assert.equal(settleBase(f0 + 2 * H, settle), f0 - 1);
  // the 1 h and 24 h windows keep their own start
  assert.deepEqual(worthWindows(h, 800, now, settle).filter((w) => w.k !== "7d"), worthWindows(h, 800, now).filter((w) => w.k !== "7d"));
});
