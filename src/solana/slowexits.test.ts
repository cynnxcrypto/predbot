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
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

test("each sale rule fires on what it says", () => {
  const x = (v: number, prev: number | null = null, peak = Math.max(1, v), heldH = 0.5, prevAgeMs = POLL_MS) => ({ v, prev, prevAgeMs, peak, heldH });
  assert.deepEqual([rule("stop-30").hit(x(0.71)), rule("stop-30").hit(x(0.7)), rule("stop-15").hit(x(0.86)), rule("stop-50").hit(x(0.5))], [false, true, false, true]);
  assert.deepEqual([rule("take-50").hit(x(1.49)), rule("take-50").hit(x(1.5)), rule("take-100").hit(x(2)), rule("half-100").half], [false, true, true, true]);
  // trailing: 20% under the best seen; from the start that best is what we paid
  assert.deepEqual([rule("trail-20").hit(x(0.81)), rule("trail-20").hit(x(0.8)), rule("trail-20").hit(x(1.3, 1.6, 1.7)), rule("trail-30").hit(x(1.3, 1.6, 1.7))], [false, true, true, false]);
  assert.deepEqual([rule("time-4h").hit(x(1, null, 1, 3.9)), rule("time-4h").hit(x(1, null, 1, 4)), rule("time-2h").hit(x(1, null, 1, 2.1))], [false, true, true]);
  // a sharp drop needs a poll before it
  assert.deepEqual([rule("drop-30").hit(x(0.6)), rule("drop-30").hit(x(0.6, 1)), rule("drop-30").hit(x(0.75, 1))], [false, true, false]);
  // and that poll must be fresh: after polls missed in between, a fall is not a sharp drop
  assert.deepEqual([rule("drop-30").hit(x(0.6, 1, 1, 0.5, 2 * POLL_MS)), rule("drop-30").hit(x(0.6, 1, 1, 0.5, 2 * POLL_MS + 1))], [true, false]);
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
  // the same scores with the fired results not moved by the gap: the most each rule can have made
  assert.deepEqual([by["stop-30"].vsRealSolNoGap, by["take-50"].vsRealSolNoGap, by["half-50"].vsRealSolNoGap, by["take-100"].vsRealSolNoGap], [-0.0052, 0.0092, 0.0046, 0]);
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

test("a fault in the study's own file never holds back the real numbers", async () => {
  _test.reset();
  const { slowLiveSummary } = await import("./slowlive.js");
  // an entry no run of this code writes (no fired marks): the study's own summary throws on it
  _test.state().done.push({ name: "w", stakeSol: 0.02, netSol: 0.001, heldMin: 5, polls: 1, lastV: 1, near: true } as never);
  assert.throws(() => slowExitsSummary());
  const s = slowLiveSummary();
  assert.equal(s.exits, null, "the study's block is empty, and no error text is published");
  assert.ok(Array.isArray(s.spread.byHeldMin) && typeof s.copies === "number", "the real numbers are still there");
  _test.reset();
});

test("a coin that could not be sold is scored as its stake lost and kept out of the gap", async () => {
  _test.reset();
  const now = Date.now();
  let held: Held[] = [{ mint: "U", seenMs: 7, name: "w", boughtMs: now, stakeSol: 0.02, tokens: "1" }];
  let result: { netSol: number; stakeSol: number; heldMin: number | null; unsold?: boolean } | undefined;
  setExitSource({ held: () => held, resultOf: () => result });
  const price = [0.019, 0.012];
  _test.setQuote(async () => BigInt(Math.round(price.shift()! * 1e9)));
  await tick(now);
  await tick(now + POLL_MS);
  // its wallet sells and our sale does not go through: no row, so nothing to score yet
  held = [];
  await tick(now + 2 * POLL_MS);
  assert.deepEqual([slowExitsSummary().copies, _test.state().tracks.length], [0, 1], "still waiting for a result");
  // six sale rounds have failed: slowlive gives the copy as its stake and the rent lost
  result = { netSol: -0.02204, stakeSol: 0.02, heldMin: null, unsold: true };
  await tick(now + 3 * POLL_MS);
  const s = slowExitsSummary();
  const by = Object.fromEntries(s.rules.map((r) => [r.id, r]));
  assert.deepEqual([s.copies, _test.state().tracks.length, s.real.netSol, s.gapCopies, s.gapPct], [1, 0, -0.02204, 0, null], "scored, and not part of the gap");
  // the stop at -30% had sold at 0.60 of the stake: 0.008 SOL lost instead of the whole stake and the rent
  assert.deepEqual([by["stop-30"].fired, by["stop-30"].vsRealSol, by["stop-50"].fired], [1, 0.01404, 0]);
  assert.ok(Math.abs(by["stop-50"].vsRealSol) < 1e-9, "a rule that had not fired lost it too");
  setExitSource(null);
  _test.reset();
});

test("study gaps: a stale poll is no sharp drop, an answer after the wallet's sale is thrown away, the gap comes from our own sales", async () => {
  _test.reset();
  const now = Date.now();
  // a poll, then twenty minutes without an answer, then 40% lower: the stop fires, the sharp-drop rule does not
  const t = { mint: "m", seenMs: 1, name: "w", boughtMs: now, stakeSol: 0.02, tokens: "1", polls: 0, v: null, prev: null, peak: 1, lastMs: 0, askMs: 0, fired: {} as Record<string, number> };
  see(t, 1, now + POLL_MS);
  see(t, 0.6, now + 11 * POLL_MS);
  assert.deepEqual([t.fired["stop-30"], t.fired["drop-30"]], [0.6, undefined]);
  see(t, 0.4, now + 12 * POLL_MS);
  assert.equal(t.fired["drop-30"], 0.4, "two polls in a row: a sharp drop");
  // an answer that comes after the copied wallet sold (the copy is no longer held) is not a poll
  let held: Held[] = [{ mint: "L", seenMs: 9, name: "w", boughtMs: now, stakeSol: 0.02, tokens: "1" }];
  const rows = new Map<string, { netSol: number; stakeSol: number; heldMin: number | null; exit?: string }>();
  setExitSource({ held: () => held, resultOf: (m, s) => rows.get(`${m}|${s}`) });
  let n = 0;
  _test.setQuote(async () => {
    if (n++ === 1) held = []; // the wallet sells while the second request waits its turn
    return n === 1 ? 19_000_000n : 9_000_000n;
  });
  await tick(now);
  await tick(now + POLL_MS);
  const tr = _test.state().tracks[0];
  assert.deepEqual([tr.polls, tr.v, tr.fired["stop-30"]], [1, 0.95, undefined], "the late answer (0.45) fired nothing");
  assert.equal(slowExitsSummary().late, 1);
  // the gap: from every sale until ten of our own market sales are in, then from those alone
  _test.reset();
  const done = _test.state().done;
  const d = (netSol: number, lastV: number, own?: boolean) => ({ name: "w", stakeSol: 0.02, netSol, heldMin: 60, polls: 5, lastV, near: true, ...(own ? { own } : {}), fired: {} });
  for (let i = 0; i < 20; i++) done.push(d(-0.001, 1)); // after the wallet's own sale: 5% under the last poll
  for (let i = 0; i < 9; i++) done.push(d(-0.0002, 1, true)); // our own sales: 1% under it
  let s = slowExitsSummary();
  assert.deepEqual([s.gapFrom, s.gapCopies, s.gapPct], ["all sales", 29, -3.8]);
  done.push(d(-0.0002, 1, true));
  s = slowExitsSummary();
  assert.deepEqual([s.gapFrom, s.gapCopies, s.gapPct], ["own sales", 10, -1]);
  // slowlive says how each copy was sold: max hold and wallet dropped are our own sales
  _test.reset();
  held = [{ mint: "O", seenMs: 3, name: "w", boughtMs: now, stakeSol: 0.02, tokens: "1" }, { mint: "P", seenMs: 4, name: "w", boughtMs: now, stakeSol: 0.02, tokens: "1" }];
  _test.setQuote(async () => 19_000_000n);
  await tick(now);
  held = [];
  rows.set("O|3", { netSol: -0.001, stakeSol: 0.02, heldMin: 400, exit: "wallet dropped" });
  rows.set("P|4", { netSol: -0.001, stakeSol: 0.02, heldMin: 40, exit: "sold" });
  await tick(now + POLL_MS);
  assert.deepEqual(_test.state().done.map((x) => x.own ?? false), [true, false]);
  setExitSource(null);
  _test.reset();
});

test("a copy we sold on our own clock is followed until the copied wallet sells: our sale against holding on, with each rule on top", async () => {
  _test.reset();
  const now = Date.now();
  let held: Held[] = [
    { mint: "A", seenMs: 1, name: "coin buyer Aaaa", boughtMs: now - 60_000, stakeSol: 0.02, tokens: "1000" },
    { mint: "B", seenMs: 2, name: "coin buyer Bbbb", boughtMs: now - 60_000, stakeSol: 0.02, tokens: "1000" },
    { mint: "C", seenMs: 3, name: "coin buyer Cccc", boughtMs: now - 60_000, stakeSol: 0.02, tokens: "1000" },
  ];
  const rows = new Map<string, { netSol: number; stakeSol: number; heldMin: number | null; exit?: string }>();
  const after = new Map<string, "holds" | "sold" | undefined>();
  setExitSource({ held: () => held, resultOf: (m, t) => rows.get(`${m}|${t}`), after: (m, t) => after.get(`${m}|${t}`) });
  // what a sale would bring at each poll, SOL
  const price: Record<string, number[]> = { A: [0.018, 0.013, 0.024, 0.03], B: [0.018, 0.017, 0.016, 0.03], C: [0.018, 0.019] };
  const asked: string[] = [];
  _test.setQuote(async (mint) => {
    asked.push(mint);
    return BigInt(Math.round(price[mint].shift()! * 1e9));
  });
  await tick(now);
  // all three are sold at -12.5%: A and B on our own clock (their wallets still hold), C after its wallet's sale
  held = [];
  rows.set("A|1", { netSol: -0.0025, stakeSol: 0.02, heldMin: 400, exit: "wallet dropped" });
  rows.set("B|2", { netSol: -0.0025, stakeSol: 0.02, heldMin: 4320, exit: "max hold" });
  rows.set("C|3", { netSol: -0.0025, stakeSol: 0.02, heldMin: 30, exit: "sold" });
  after.set("A|1", "holds");
  after.set("B|2", "holds");
  await tick(now + POLL_MS);
  const s1 = slowExitsSummary();
  // scored as every copy is; C is done with; A and B are polled on
  assert.deepEqual([s1.copies, s1.open.n, s1.afterOwn.copies, s1.afterOwn.following, _test.state().tracks.map((t) => t.mint)], [3, 0, 0, 2, ["A", "B"]]);
  assert.deepEqual(asked, ["A", "B", "C", "A", "B"]);
  // A fell to -35% right after our sale (a stop at -30% would have sold there), then comes back to +20% when its wallet sells
  await tick(now + 2 * POLL_MS);
  after.set("A|1", "sold");
  // B's wallet is never heard selling: the time runs out
  after.set("B|2", undefined);
  await tick(now + 3 * POLL_MS);
  assert.equal(asked.length, 7, "no poll after the wallet sold or the time ran out");
  const s = slowExitsSummary();
  assert.deepEqual([s.copies, _test.state().tracks.length, s.afterOwn.copies, s.afterOwn.notSeenSelling, s.afterOwn.following], [3, 0, 2, 1, 0]);
  // the rules' score on the real copies is as it was: what they saw until our sale
  assert.equal(_test.state().done.every((d) => d.fired["stop-30"] === undefined), true);
  // the gap: every copy really made -12.5% where its last poll said -10%
  assert.equal(s.gapPct, -2.5);
  // our sales made -0.005; holding on: A +20% and B -20% (its last poll), each less the gap = -0.001
  assert.deepEqual([s.afterOwn.realNetSol, s.afterOwn.holdNetSol, s.afterOwn.holdVsRealSol], [-0.005, -0.001, 0.004]);
  const by = Object.fromEntries(s.afterOwn.rules.map((r) => [r.id, r]));
  // holding with a stop at -30%: A sold at -35% (less the gap) instead of +20%; B as held
  assert.deepEqual([by["stop-30"].fired, by["stop-30"].netSol, by["stop-30"].vsHoldSol], [1, r6((0.65 - 1 - 0.025 + (0.8 - 1 - 0.025)) * 0.02), r6((0.65 - 1.2) * 0.02)]);
  assert.deepEqual([by["stop-50"].fired, by["stop-50"].vsHoldSol], [0, 0]);
  setExitSource(null);
  _test.reset();
});
