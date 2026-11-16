import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "slowexits-"));
const { RULES, see, tick, step, setExitSource, slowExitsSummary, POLL_MS, _test } = await import("./slowexits.js");
const { spread } = await import("./slowlive.js");

type Held = { mint: string; seenMs: number; name: string; boughtMs: number; stakeSol: number; tokens?: string };
const rule = (id: string) => RULES.find((r) => r.id === id)!;

test("each sale rule fires on what it says", () => {
  const x = (v: number, prev: number | null = null, peak = Math.max(1, v), heldH = 0.5) => ({ v, prev, peak, heldH });
  assert.deepEqual([rule("stop-30").hit(x(0.71)), rule("stop-30").hit(x(0.7)), rule("stop-15").hit(x(0.86)), rule("stop-50").hit(x(0.5))], [false, true, false, true]);
  assert.deepEqual([rule("take-50").hit(x(1.49)), rule("take-50").hit(x(1.5)), rule("take-100").hit(x(2)), rule("half-100").half], [false, true, true, true]);
  // trailing: 20% under the best seen; from the start that best is what we paid
  assert.deepEqual([rule("trail-20").hit(x(0.81)), rule("trail-20").hit(x(0.8)), rule("trail-20").hit(x(1.3, 1.6, 1.7)), rule("trail-30").hit(x(1.3, 1.6, 1.7))], [false, true, true, false]);
  assert.deepEqual([rule("time-4h").hit(x(1, null, 1, 3.9)), rule("time-4h").hit(x(1, null, 1, 4)), rule("time-2h").hit(x(1, null, 1, 2.1))], [false, true, true]);
  // a sharp drop needs a poll before it
  assert.deepEqual([rule("drop-30").hit(x(0.6)), rule("drop-30").hit(x(0.6, 1)), rule("drop-30").hit(x(0.75, 1))], [false, true, false]);
});

test("a rule keeps the value of the FIRST poll at which it would have sold", () => {
  const t = { mint: "m", seenMs: 1, name: "w", boughtMs: 0, stakeSol: 0.02, tokens: "1", polls: 0, v: null, prev: null, peak: 1, lastMs: 0, askMs: 0, fired: {} as Record<string, number> };
  for (const [i, v] of [0.97, 1.6, 1.1, 0.65, 0.4].entries()) see(t, v, (i + 1) * 120_000);
  assert.equal(t.fired["take-50"], 1.6);
  assert.equal(t.fired["half-50"], 1.6);
  assert.equal(t.fired["take-100"], undefined);
  assert.equal(t.fired["trail-30"], 1.1, "1.1 is 31% under the best seen (1.6)");
  assert.equal(t.fired["stop-30"], 0.65);
  assert.equal(t.fired["stop-50"], 0.4);
  assert.equal(t.fired["drop-30"], 1.1);
  assert.deepEqual([t.polls, t.peak, t.v, t.prev], [5, 1.6, 0.4, 0.65]);
});

test("real copies are followed from buy to sale and every rule is scored against what the copy really made", async () => {
  _test.reset();
  const now = Date.now();
  let held: Held[] = [
    { mint: "A", seenMs: 1, name: "coin buyer Aaaa", boughtMs: now - 60_000, stakeSol: 0.02, tokens: "1000" },
    { mint: "B", seenMs: 2, name: "coin buyer Bbbb", boughtMs: now - 60_000, stakeSol: 0.02, tokens: "1000" },
    { mint: "OLD", seenMs: 3, name: "coin buyer Old1", boughtMs: now - 9e6, stakeSol: 0.035 }, // bought before the study: no token amount
  ];
  const rows = new Map<string, { netSol: number; stakeSol: number; heldMin: number | null } | null>();
  setExitSource({ held: () => held, resultOf: (m, t) => rows.get(`${m}|${t}`) });
  // what a sale would bring, in SOL, per coin and poll; null = no route; undefined = the request failed
  const price: Record<string, (number | null | undefined)[]> = { A: [0.0194, 0.0136, undefined, 0.019], B: [0.0196, null, 0.031, 0.022] };
  const asked: string[] = [];
  _test.setQuote(async (mint) => {
    asked.push(mint);
    const v = price[mint].shift();
    return v == null ? (v as null | undefined) : BigInt(Math.round(v * 1e9));
  });
  for (let i = 0; i < 4; i++) await tick(now + i * POLL_MS);
  assert.equal(asked.filter((m) => m === "OLD").length, 0);
  const st = _test.state();
  assert.deepEqual(st.tracks.map((t) => [t.mint, t.polls]), [["A", 3], ["B", 3]]);
  const s0 = slowExitsSummary();
  assert.deepEqual([s0.copies, s0.open.n, s0.quotes, s0.noRoute, s0.missed], [0, 2, 8, 1, 1]);
  assert.equal(s0.open.avgRetPct, 2.5); // (0.95 + 1.10) / 2 - 1
  // both are really sold: A at -6% (it had dipped to -32% and come back), B at +9% (it had been at +55%)
  held = [held[2]];
  rows.set("A|1", { netSol: -0.0012, stakeSol: 0.02, heldMin: 8 });
  rows.set("B|2", { netSol: 0.0018, stakeSol: 0.02, heldMin: 8 });
  await tick(now + 4 * POLL_MS);
  const s = slowExitsSummary();
  assert.deepEqual([s.copies, s.open.n, s.real.won, s.real.netSol, s.real.avgRetPct], [2, 0, 1, 0.0006, 1.5]);
  // the last poll said -5% and +10%; the real results were -6% and +9%: the gap is -1%
  assert.deepEqual([s.gapPct, s.gapCopies], [-1, 2]);
  const by = Object.fromEntries(s.rules.map((r) => [r.id, r]));
  // the stop at -30% sold A at 0.68 of the stake (-32%, -33% with the gap) where the copy really made -6%: worse
  assert.deepEqual([by["stop-30"].fired, by["stop-30"].firedAvgRetPct, by["stop-30"].firedRealAvgRetPct], [1, -33, -6]);
  assert.equal(by["stop-30"].vsRealSol, Math.round((-0.33 - -0.06) * 0.02 * 1e6) / 1e6);
  // take profit at +50% sold B at 1.55 (+54% with the gap) where it really made +9%: better
  assert.deepEqual([by["take-50"].fired, by["take-50"].firedAvgRetPct, by["take-50"].firedRealAvgRetPct, by["take-50"].won], [1, 54, 9, 1]);
  assert.equal(by["take-50"].vsRealSol, Math.round((0.54 - 0.09) * 0.02 * 1e6) / 1e6);
  // the half rule: half at that quote, half the real result
  assert.equal(by["half-50"].vsRealSol, Math.round(0.5 * (0.54 - 0.09) * 0.02 * 1e6) / 1e6);
  // a rule that never fired is the real result exactly
  assert.deepEqual([by["take-100"].fired, by["take-100"].vsRealSol, by["take-100"].netSol, by["time-8h"].fired], [0, 0, 0.0006, 0]);
  // best first
  assert.deepEqual(s.rules.slice(0, 2).map((r) => r.id).sort(), ["take-30", "take-50"]);
  assert.ok(s.rules[s.rules.length - 1].vsRealSol < 0);
  // numbers only: no coin in the public summary
  assert.ok(!/"A"|"B"|OLD/.test(JSON.stringify(s)));
  // a copy whose buy never landed, or that never gets a row, leaves no result
  held = [{ mint: "C", seenMs: 5, name: "coin buyer Cccc", boughtMs: now, stakeSol: 0.02, tokens: "5" }];
  price.C = [0.02];
  await tick(now + 5 * POLL_MS);
  held = [];
  rows.set("C|5", null);
  await tick(now + 6 * POLL_MS);
  assert.deepEqual([slowExitsSummary().copies, _test.state().tracks.length], [2, 0]);
  setExitSource(null);
  _test.reset();
});

test("one request a step, for the copy asked longest ago, and none before its two minutes are up", async () => {
  _test.reset();
  const now = Date.now();
  const held: Held[] = ["A", "B", "C"].map((m, i) => ({ mint: m, seenMs: i, name: "w", boughtMs: now, stakeSol: 0.02, tokens: "1" }));
  setExitSource({ held: () => held, resultOf: () => undefined });
  const asked: string[] = [];
  _test.setQuote(async (mint) => (asked.push(mint), 19_000_000n));
  for (let i = 0; i < 5; i++) await step(Date.now());
  assert.deepEqual(asked, ["A", "B", "C"], "each once: nothing is asked again inside two minutes");
  await step(Date.now() + POLL_MS + 1000);
  assert.equal(asked.length, 4);
  setExitSource(null);
  _test.reset();
});

test("the real results by size and by time held; the most a stop could have saved", () => {
  const row = (netSol: number, heldMin: number, exit = "sold", stakeSol = 0.02) => ({ netSol, stakeSol, heldMin, exit });
  const s = spread([row(-0.012, 300), row(-0.008, 500), row(-0.001, 30), row(0.003, 20), row(0.004, 90), row(0.03, 8), row(-0.004, 400, "wallet dropped"), { netSol: -0.004, heldMin: 60, exit: "sold" }]);
  const res = Object.fromEntries(s.byResultPct.map((x) => [`${x.from}..${x.to}`, x.n]));
  assert.deepEqual([res["null..-50"], res["-50..-30"], res["-30..-10"], res["-10..0"], res["10..30"], res["100..null"]], [1, 2, 1, 1, 2, 1]);
  const h = Object.fromEntries(s.byHeldMin.map((x) => [x.from, [x.n, x.won, x.netSol]]));
  assert.deepEqual([h[0], h[240], h[480]], [[1, 1, 0.03], [2, 0, -0.016], [1, 0, -0.008]]);
  assert.deepEqual(s.byExit, [{ exit: "sold", n: 7, won: 3, netSol: 0.012 }, { exit: "wallet dropped", n: 1, won: 0, netSol: -0.004 }]);
  // -60%, -40% and the old 0.01 row at -40% end under -30%: sold exactly there they lose 0.006 + 0.006 + 0.003
  assert.deepEqual(s.stopAtMost.find((x) => x.stopPct === -30), { stopPct: -30, copies: 3, savedSol: 0.009 });
  assert.deepEqual(s.stopAtMost.find((x) => x.stopPct === -50), { stopPct: -50, copies: 1, savedSol: 0.002 });
});
