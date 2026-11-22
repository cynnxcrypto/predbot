import { test } from "node:test";
import assert from "node:assert/strict";
import { entryGapPct, excessOf, gapStats, parseCandles, priceAt, skillOf, sumWithoutBest, tStat, type Candles, type Trip } from "./skill.js";

const H = 3_600_000;
const D = 24 * H;
const flat = (from: number, hours: number, px = 100): Candles => Array.from({ length: hours }, (_, i) => [from + i * H, px]);

test("priceAt takes the last close at or before, and not across a hole", () => {
  const c: Candles = [[0, 10], [H, 11], [2 * H, 12]];
  assert.equal(priceAt(c, -1), null);
  assert.equal(priceAt(c, 90 * 60_000), 11);
  assert.equal(priceAt(c, 2 * H + 30 * 60_000), 12);
  assert.equal(priceAt(c, 6 * H), null, "series stopped long before");
  assert.equal(priceAt([], 5), null);
});

test("excess removes what the same side on BTC made", () => {
  const c: Candles = [[0, 100], [H, 110]];
  // a short that made 5% while BTC rose 10%: it beat the market by 15 points
  assert.ok(Math.abs(excessOf([H, 0.05, 0, -1], c)! - 0.15) < 1e-9);
  // a long that made 12% while BTC rose 10%: 2 points of skill
  assert.ok(Math.abs(excessOf([H, 0.12, 0, 1], c)! - 0.02) < 1e-9);
  assert.equal(excessOf([H, 0.05], c), null, "old row without side");
});

test("t-stat and the best-3 cut", () => {
  assert.equal(tStat([1]), 0);
  assert.equal(tStat([1, 1, 1]), 0, "no spread");
  assert.ok(tStat([1, 2, 3, 2]) > 3);
  assert.equal(sumWithoutBest([10, 1, 1, 1, -2]), -1);
});

test("skill: a trader that only rode BTC down fails; one that beats it steadily passes", () => {
  const now = 90 * D;
  // BTC falls 1% every 3 days, linearly per hour
  const btc: Candles = Array.from({ length: 90 * 24 }, (_, i) => [i * H, 100 * (1 - 0.01 * (i / 72))]);
  const at = (k: number) => 3 * D + k * 3 * D; // 29 positions spread over the window
  // shorts held 3 days each that made exactly what BTC fell: no skill
  const rider: Trip[] = Array.from({ length: 29 }, (_, k) => {
    const o = at(k) - 3 * D + H;
    const c = at(k);
    const m = priceAt(btc, c)! / priceAt(btc, o)! - 1;
    return [c, -m, o, -1, "BTC"];
  });
  const s1 = skillOf(rider, btc, 0, now);
  assert.equal(s1.n, 29);
  assert.equal(s1.pass, false);
  assert.ok(Math.abs(s1.exAvgPct!) < 0.01);
  assert.ok(s1.marketShare! > 0.99, "all of it is the market");
  // longs that each beat BTC by 1-3 points
  const good: Trip[] = Array.from({ length: 29 }, (_, k) => {
    const o = at(k) - 3 * D + H;
    const c = at(k);
    const m = priceAt(btc, c)! / priceAt(btc, o)! - 1;
    return [c, m + 0.01 + (k % 3) * 0.01, o, 1, "ETH"];
  });
  const s2 = skillOf(good, btc, 0, now);
  assert.equal(s2.pass, true, s2.why);
  assert.equal(s2.periodsAhead, 3);
  // too few
  assert.equal(skillOf(good.slice(0, 10), btc, 0, now).why, "under 20 closed");
  // old rows without side: no excess, not judged
  assert.equal(skillOf(good.map((x) => [x[0], x[1]] as Trip), btc, 0, now).why, "BTC prices or sides missing");
});

test("skill: one lucky ticket fails the best-3 cut", () => {
  const now = 90 * D;
  const btc = flat(0, 90 * 24);
  const xs: Trip[] = Array.from({ length: 30 }, (_, k) => [k * 3 * D + 2 * D, k === 5 ? 3 : k % 2 ? 0.011 : -0.01, k * 3 * D + D, 1, "X"]);
  const s = skillOf(xs, btc, 0, now);
  assert.equal(s.pass, false);
  assert.ok(s.noBest3Pct < 0 || s.exT! < 2);
});

test("candles and entry gaps", () => {
  assert.deepEqual(parseCandles([{ t: 2, c: "5" }, { t: 1, c: "4" }, { t: 0, c: "x" }]), [[1, 4], [2, 5]]);
  assert.deepEqual(parseCandles(null), []);
  assert.equal(entryGapPct(1, 101, 100), 1);
  assert.equal(entryGapPct(-1, 101, 100), -1, "a short sold higher than the trader: better for us");
  assert.equal(entryGapPct(1, 0, 100), null);
  assert.deepEqual(gapStats([0.1, 2, -0.5, 0.3]), { n: 4, medianPct: 0.3, p90Pct: 2, worseOver1PctShare: 0.25 });
  assert.deepEqual(gapStats([]), { n: 0, medianPct: null, p90Pct: null, worseOver1PctShare: null });
});
