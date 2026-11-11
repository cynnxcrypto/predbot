import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// a scratch folder: the wallet these tests sign with is made there, never in the real data folder
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "sollive-"));
const { HARD_MAX_LOSS_SOL, HARD_STAKE_SOL, parseLive, solanaCopyLiveSummary, _test } = await import("./copylive.js");
const { _test: run } = await import("./copyrun.js");
const { buildSigned, wallet } = await import("./keys.js");
type Row = import("./copylive.js").Row;
type LiveConfig = import("./copylive.js").LiveConfig;

test("real copy test is off unless switched on, and hard limits hold", () => {
  assert.equal(parseLive("{}").on, false);
  assert.equal(parseLive("not json").on, false);
  assert.equal(parseLive(JSON.stringify({ solanaCopy: { on: "true", maxLossSol: 0.5 } })).on, false);
  assert.equal(parseLive(JSON.stringify({ solanaCopy: { on: true } })).on, false, "no loss budget means off");
  assert.equal(parseLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 0.5, stakeSol: 0.001 } })).on, false);
  const c = parseLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 50, stakeSol: 5, holdSec: 999, maxPerDay: 1e6, slippageBps: 9999, maxFeeLamports: 1e12 } }));
  assert.equal(c.on, true);
  assert.equal(c.maxLossSol, HARD_MAX_LOSS_SOL);
  assert.equal(c.stakeSol, HARD_STAKE_SOL);
  assert.equal(c.holdSec, 60);
  assert.equal(c.targetPct, 0, "no target unless one is set: the old fixed hold");
  assert.equal(parseLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 0.5, holdSec: 60, targetPct: 10 } })).targetPct, 10);
  assert.equal(parseLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 0.5, targetPct: 900 } })).targetPct, 50);
  assert.equal(parseLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 0.5, targetPct: -5 } })).targetPct, 0);
  assert.equal(c.maxPerDay, 200);
  assert.equal(c.slippageBps, 3000);
  assert.equal(c.maxFeeLamports, 2_000_000);
});

test("public summary carries numbers only", () => {
  _test.reset();
  _test.setConfig(null);
  const mint = "So11111111111111111111111111111111111111112";
  _test.state().rows.push({ t: 1, name: "someone", mint, leaderSlot: 100, landSlot: 101, slotsBehind: 1, buy: "landed", netSol: -0.002, sigs: ["SIGSIGSIG"], ahead: [3, 5], pipelineMs: 400, fillGapPct: 2.5, sold: true });
  const s = solanaCopyLiveSummary();
  const text = JSON.stringify(s);
  assert.ok(!text.includes(mint) && !text.includes("SIGSIGSIG") && !text.includes("someone") && !text.includes("101"));
  assert.equal(s.landed, 1);
  assert.equal(s.nextBlock, 1);
  assert.equal(s.aheadMedian, 3);
  assert.equal(s.on, false);
  _test.reset();
});

// ---- the exit: sell at the target, else when the time is up --------------------------------------------------------
const MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const SYSTEM = "11111111111111111111111111111111";
const CFG: LiveConfig = { on: true, stakeSol: 0.05, maxLossSol: 0.5, holdSec: 60, targetPct: 10, maxPerDay: 80, slippageBps: 1500, maxFeeLamports: 1_000_000 };
/** A made-up chain and Jupiter: `quotes` = what a sale would bring back at each ask (SOL); `fills` = whether each sale lands. */
function fake(quotes: number[], fills: boolean[]) {
  const w = wallet();
  const log = { quotes: 0, swaps: 0, sends: 0, slips: [] as string[] };
  let holding = 1000n;
  run.setNet((async (url: string, init?: { method?: string; body?: string }) => {
    const json = (x: unknown) => new Response(JSON.stringify(x));
    if (url.includes("/swap/v1/quote")) {
      log.slips.push(new URL(url).searchParams.get("slippageBps") ?? "");
      const sol = quotes[Math.min(log.quotes++, quotes.length - 1)];
      return json({ outAmount: String(Math.round(sol * 1e9)) });
    }
    if (url.includes("/swap/v1/swap")) {
      log.swaps++;
      return json({ swapTransaction: buildSigned(w, SYSTEM, SYSTEM, [{ pubkey: w.address, writable: true }], [log.swaps]) });
    }
    const { method } = JSON.parse(init!.body!) as { method: string };
    if (method === "sendTransaction") {
      if (fills[log.sends++]) holding = 0n;
      return json({ result: "sent" });
    }
    if (method === "getSignatureStatuses") return json({ result: { value: [{ slot: 5, err: holding === 0n ? null : { InstructionError: [0, "slippage"] } }] } });
    if (method === "getTokenAccountsByOwner") return json({ result: { value: holding ? [{ pubkey: "acc", account: { owner: "tok", data: { parsed: { info: { tokenAmount: { amount: holding.toString(), decimals: 6 } } } } } }] : [] } });
    throw new Error(`unexpected call ${method}`);
  }) as never);
  return { w, log, left: () => holding };
}
const blank = (): Row => ({ t: Date.now(), name: "someone", mint: MINT, leaderSlot: 1, buy: "landed", netSol: 0, sigs: [] });

test("exit: sells the moment a sale would bring back 10% more than the stake", async () => {
  _test.reset();
  _test.setPoll(20);
  const f = fake([0.047, 0.052, 0.0549, 0.056, 0.03], [true]);
  const row = blank();
  const t0 = Date.now();
  assert.equal(await _test.watch(f.w, MINT, 1000n, CFG, row, Date.now() + 5000), true);
  assert.ok(Date.now() - t0 < 2500, "did not wait for the time to run out");
  assert.equal(f.log.quotes, 4, "0.0549 SOL is +9.8%: not yet");
  assert.equal(f.log.sends, 1);
  assert.equal(f.left(), 0n);
  assert.deepEqual({ exit: row.exit, bestPct: row.bestPct, targetTries: row.targetTries, sigs: row.sigs.length }, { exit: "target", bestPct: 12, targetTries: 1, sigs: 1 });
  assert.ok(f.log.slips.every((x) => x === "500"), "a target sale may give back at most 5% of what was quoted");
});

test("exit: no target reached means no sale here, the time limit sells; a failed target sale keeps watching", async () => {
  _test.reset();
  _test.setPoll(20);
  // never up 10%
  let f = fake([0.047, 0.051, 0.044], []);
  let row = blank();
  assert.equal(await _test.watch(f.w, MINT, 1000n, CFG, row, Date.now() + 300), false);
  assert.equal(f.log.sends, 0);
  assert.equal(row.exit, undefined);
  assert.equal(row.bestPct, 2);
  // what it is worth is kept for the dashboard while the copy is open
  _test.state().open = { mint: MINT, bal0: 0.45, t: Date.now(), tries: 0 };
  f = fake([0.047], []);
  assert.equal(await _test.watch(f.w, MINT, 1000n, CFG, blank(), Date.now() + 100), false);
  assert.deepEqual({ worthSol: _test.state().open!.worthSol, nowPct: _test.state().open!.nowPct, bestPct: _test.state().open!.bestPct }, { worthSol: 0.047, nowPct: -6, bestPct: -6 });
  _test.state().open = null;
  // up 10% twice, but the price fell back before each sale landed: two fees, still holding, time runs out
  f = fake([0.056, 0.04, 0.058, 0.04], [false, false]);
  row = blank();
  assert.equal(await _test.watch(f.w, MINT, 1000n, CFG, row, Date.now() + 1500), false);
  assert.equal(f.log.sends, 2);
  assert.equal(f.left(), 1000n);
  assert.equal(row.targetTries, 2);
  assert.equal(row.exit, undefined);
  // the old fixed hold: watches the price for the record, never sells early
  f = fake([0.09], []);
  row = blank();
  assert.equal(await _test.watch(f.w, MINT, 1000n, { ...CFG, targetPct: 0 }, row, Date.now() + 200), false);
  assert.equal(f.log.sends, 0);
  assert.equal(row.bestPct, 80);
  // Jupiter down: nothing is priced, nothing is sold, and it does not throw
  run.setNet((async () => new Response("no", { status: 500 })) as never);
  row = blank();
  assert.equal(await _test.watch(f.w, MINT, 1000n, CFG, row, Date.now() + 200), false);
  assert.match(row.error ?? "", /jupiter/);
  run.setNet(fetch);
});

test("public summary shows what is held in numbers only, and counts the new exit apart", () => {
  _test.reset();
  _test.setConfig(CFG);
  const st = _test.state();
  st.rows.push({ ...blank(), netSol: -0.004, sold: true }); // an old fixed-hold copy
  st.rows.push({ ...blank(), netSol: 0.003, sold: true, exit: "target", bestPct: 11.2, targetTries: 1, sigs: ["SIGSIGSIG"] });
  st.rows.push({ ...blank(), netSol: -0.006, sold: true, exit: "time", bestPct: 4, targetTries: 1 });
  st.open = { mint: MINT, bal0: 0.45, t: Date.now() - 12_000, tries: 0, worthSol: 0.04845, nowPct: -3.1, bestPct: 2.4 };
  const s = solanaCopyLiveSummary();
  assert.equal(s.exitRule, "sells at +10% or after 60 s");
  assert.deepEqual(s.open, { stakeSol: 0.05, heldSec: 12, tries: 0, worthSol: 0.04845, nowPct: -3.1, bestPct: 2.4 });
  assert.deepEqual(s.targetExit, { copies: 2, atTarget: 1, atTimeUp: 1, won: 1, netSol: -0.003, bestPctMedian: 4, missedTargetSales: 1 });
  assert.equal(s.recent[1].exit, "target");
  assert.equal(s.recent[0].at, new Date(st.rows[2].t).toISOString(), "each copy carries its time for the dashboard");
  const text = JSON.stringify(s);
  assert.ok(!text.includes(MINT) && !text.includes("SIGSIGSIG") && !text.includes("someone"));
  st.open = null;
  assert.equal(solanaCopyLiveSummary().open, null);
  _test.setConfig(null);
  _test.reset();
});
