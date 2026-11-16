import assert from "node:assert/strict";
import { test } from "node:test";
import { flowsBetween, repairClaims, unclaimedAt, winSpans, worthWindows, type Comp, type Flow } from "./worthdash.js";

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

test("worth windows: the public status gives the page's own 1 h, 24 h, 7 d and since numbers", () => {
  // the page's code (src/status.ts, total worth panel), copied as it is, as the reference
  type P = [number, number] | [number, number, 1];
  const page = (H: P[], total: number, nw: number) => {
    const WN: [string, number][] = [["1h", 36e5], ["24h", 864e5], ["7d", 6048e5]];
    const CM: { k: string; b: P; from: number }[] = [];
    const atT = (T: number) => {
      let b: P | null = null;
      for (let i = 0; i < H.length; i++) {
        if (H[i][0] <= T) b = H[i];
        else break;
      }
      return b;
    };
    if (H.length > 1) {
      WN.forEach((w) => {
        const T = nw - w[1];
        if (H[0][0] <= T + w[1] * 0.1) CM.push({ k: w[0], b: atT(T) || H[0], from: T });
      });
      if (!CM.length || CM[CM.length - 1].b !== H[0]) CM.push({ k: "since", b: H[0], from: H[0][0] });
    }
    return CM.map((c) => ({ k: c.k, usd: Math.round((total - c.b[1]) * 100) / 100, est: c.b[2] === 1, from: c.from }));
  };
  const now = 1_800_000_000_000;
  const H = 3_600_000;
  // eight days: hourly estimates first, then a sample every 2 minutes for the last 30 hours
  const long: P[] = [];
  for (let t = now - 8 * 24 * H; t < now - 30 * H; t += H) long.push([t, 700 - (now - t) / H / 10, 1]);
  for (let t = now - 30 * H, i = 0; t <= now; t += 120_000, i++) long.push([t, 640 + Math.sin(i / 7) * 5]);
  const total = 607.9;
  const w = worthWindows(long, total, now);
  assert.deepEqual(w, page(long, total, now));
  assert.deepEqual(w.map((x) => x.k), ["1h", "24h", "7d", "since"]);
  assert.equal(w.find((x) => x.k === "7d")!.est, true);
  assert.equal(w.find((x) => x.k === "24h")!.est, false);
  // two hours of samples: only 1 h, then since
  const short: P[] = [];
  for (let t = now - 2 * H; t <= now; t += 120_000) short.push([t, 600 + (t - now) / H]);
  assert.deepEqual(worthWindows(short, 600.5, now), page(short, 600.5, now));
  assert.deepEqual(worthWindows(short, 600.5, now).map((x) => x.k), ["1h", "since"]);
  // 23 hours: the 24 h window is still shown from the first point (within a tenth of the window), and no since after it
  const day: P[] = [];
  for (let t = now - 23 * H; t <= now; t += 120_000) day.push([t, 610]);
  assert.deepEqual(worthWindows(day, 607.9, now), page(day, 607.9, now));
  assert.deepEqual(worthWindows(day, 607.9, now).map((x) => [x.k, x.usd]), [["1h", -2.1], ["24h", -2.1]]);
  assert.deepEqual(worthWindows([[now, 600]], 600, now), []);
});
