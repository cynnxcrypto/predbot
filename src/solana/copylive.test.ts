import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// a scratch folder: the wallet these tests sign with is made there, never in the real data folder
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "sollive-"));
// made-up keys: the real test refuses to trade without both, and every network call here is faked
process.env.HELIUS_API_KEY = "test-helius";
process.env.JUPITER_API_KEY = "test-jupiter";
const { HARD_MAX_LOSS_SOL, HARD_STAKE_SOL, parseLive, solanaCopyLiveSummary, trade, tidy, _test } = await import("./copylive.js");
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
  assert.equal(c.maxPerDay, 1e6);
  assert.equal(parseLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 0.5 } })).maxPerDay, Number.MAX_SAFE_INTEGER, "no daily limit unless one is set: the loss cap is the stop");
  assert.equal(parseLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 0.5, maxPerDay: 80 } })).maxPerDay, 80);
  assert.equal(c.minGapPct, 0, "no entry filter unless one is set");
  assert.equal(parseLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 0.5, minGapPct: 9 } })).minGapPct, 9);
  assert.equal(parseLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 0.5, minGapPct: 900 } })).minGapPct, 50);
  assert.equal(parseLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 0.5, minGapPct: "9" } })).minGapPct, 0);
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
const CFG: LiveConfig = { on: true, stakeSol: 0.05, maxLossSol: 0.5, holdSec: 60, targetPct: 10, maxPerDay: Number.MAX_SAFE_INTEGER, minGapPct: 0, slippageBps: 1500, maxFeeLamports: 1_000_000 };
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

// ---- the entry: which buys are copied at all ----------------------------------------------------------------------
/** A made-up chain for the start of a copy: a wallet with 0.4 SOL, a buy quote of `out` raw tokens, and a swap call that fails. */
function entry(out: () => string) {
  const log = { balances: 0, quotes: 0, swaps: 0, sends: 0 };
  run.setNet((async (url: string, init?: { body?: string }) => {
    const json = (x: unknown) => new Response(JSON.stringify(x));
    if (url.includes("/swap/v1/quote")) return log.quotes++, json({ outAmount: out() });
    if (url.includes("/swap/v1/swap")) return log.swaps++, new Response("no", { status: 500 });
    const { method } = JSON.parse(init!.body!) as { method: string };
    if (method === "getBalance") return log.balances++, json({ result: { value: 0.4e9 } });
    if (method === "sendTransaction") log.sends++;
    throw new Error(`unexpected call ${method}`);
  }) as never);
  return log;
}
// the wallet paid 0.00001 SOL a token (6 decimals): 0.05 SOL buys 5,000 tokens at that price
const raw = (gapPct: number) => String(Math.round((0.05 / (0.00001 * (1 + gapPct / 100))) * 1e6));
const signal = (over: Partial<Parameters<typeof trade>[0]> = {}) => ({ sig: "leader-sig", name: "someone", mint: MINT, leaderSlot: 100, leaderPrice: 0.00001, decimals: 6, knownMs: Date.now(), ...over });

test("entry filter: a buy whose quote is not far enough above the wallet's price is left alone, at no cost", async () => {
  _test.reset();
  _test.ready();
  _test.setConfig({ ...CFG, minGapPct: 9 });
  const st = _test.state;
  let gap = 5;
  const log = entry(() => raw(gap));
  await trade(signal());
  assert.deepEqual({ quotes: log.quotes, swaps: log.swaps, sends: log.sends }, { quotes: 1, swaps: 0, sends: 0 }, "priced, then nothing built or sent");
  assert.deepEqual({ trades: st().trades, dayCount: st().dayCount, rows: st().rows.length, open: st().open, low: st().skippedLowGap }, { trades: 0, dayCount: 0, rows: 0, open: null, low: 1 });
  // no price to compare with (the wallet's transaction did not give the token's decimals): left alone too
  await trade(signal({ decimals: undefined }));
  assert.deepEqual({ swaps: log.swaps, noPrice: st().skippedNoPrice, trades: st().trades }, { swaps: 0, noPrice: 1, trades: 0 });
  // a skipped buy does not hold back the next one: this comes right after and goes ahead (the made-up swap call fails)
  gap = 12;
  await trade(signal());
  assert.equal(log.swaps, 1, "12% above the wallet's price: the order is built");
  assert.equal(log.sends, 0);
  assert.deepEqual({ buy: st().rows[0].buy, quoteGapPct: st().rows[0].quoteGapPct, trades: st().trades }, { buy: "not sent", quoteGapPct: 12, trades: 0 });
  const s = solanaCopyLiveSummary();
  assert.match(s.entryRule, /9% or more above/);
  assert.deepEqual({ low: s.skippedLowGap, noPrice: s.skippedNoPrice, dailyLimit: s.dailyLimit }, { low: 1, noPrice: 1, dailyLimit: null });
  assert.ok(!JSON.stringify(s).includes(MINT) && !JSON.stringify(s).includes("leader-sig"));
  // no filter set: every buy goes ahead, and what the quote said is still kept for the record
  _test.reset();
  _test.setConfig(CFG);
  const all = entry(() => raw(1));
  await trade(signal());
  assert.equal(all.swaps, 1);
  assert.equal(_test.state().rows[0].quoteGapPct, 1);
  assert.match(solanaCopyLiveSummary().entryRule, /every first buy/);
  run.setNet(fetch);
  _test.setConfig(null);
  _test.reset();
});

test("daily count: stops the day only when a limit is set", async () => {
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  _test.reset();
  _test.ready();
  _test.setConfig({ ...CFG, maxPerDay: 80 });
  Object.assign(_test.state(), { day: today, dayCount: 80 });
  let log = entry(() => raw(1));
  await trade(signal());
  assert.equal(log.balances + log.quotes, 0);
  assert.equal(_test.state().note, "daily count reached");
  assert.equal(solanaCopyLiveSummary().dailyLimit, 80);
  // the same day with the limit taken away: it trades again, and the note goes
  _test.setConfig(CFG);
  log = entry(() => raw(1));
  await trade(signal());
  assert.equal(log.quotes, 1);
  assert.equal(_test.state().note, "");
  run.setNet(fetch);
  _test.setConfig(null);
  _test.reset();
});

// ---- the clean-up: empty token accounts a routed swap leaves behind -------------------------------------------------
const CLASSIC = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
// made-up token accounts (any valid address will do as a name)
const ACC = { usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", spam: "So11111111111111111111111111111111111111112", frozen: MINT, stuck: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" };
/** A made-up wallet with four token accounts: one empty, one holding a dropped coin, one empty but frozen, one empty whose close fails. */
function spare() {
  const log = { sends: 0, balances: 0 };
  const open = new Set(Object.values(ACC));
  const sigAcc = new Map<string, string>();
  const acc = (pubkey: string, owner: string, amount: string, state = "initialized") => ({ pubkey, account: { owner, data: { parsed: { info: { state, tokenAmount: { amount, decimals: 6 } } } } } });
  run.setNet((async (_url: string, init?: { body?: string }) => {
    const json = (x: unknown) => new Response(JSON.stringify({ result: x }));
    const { method, params } = JSON.parse(init!.body!) as { method: string; params: unknown[] };
    if (method === "getTokenAccountsByOwner") {
      const prog = (params[1] as { programId: string }).programId;
      const all = prog === CLASSIC ? [acc(ACC.usdc, CLASSIC, "0"), acc(ACC.spam, CLASSIC, "40")] : [acc(ACC.frozen, T22, "0", "frozen"), acc(ACC.stuck, T22, "0")];
      return json({ value: all.filter((a) => open.has(a.pubkey)) });
    }
    if (method === "getLatestBlockhash") return json({ value: { blockhash: SYSTEM } });
    if (method === "sendTransaction") {
      // which account this close is for: the made-up chain reads it back from the order of the calls
      const target = [ACC.usdc, ACC.stuck].filter((a) => open.has(a) && ![...sigAcc.values()].includes(a))[0];
      const sig = `close-${++log.sends}`;
      sigAcc.set(sig, target);
      return json(sig);
    }
    if (method === "getSignatureStatuses") {
      const a = sigAcc.get((params[0] as string[])[0]);
      if (a === ACC.usdc) open.delete(a);
      return json({ value: [{ slot: 9, err: a === ACC.usdc ? null : { InstructionError: [0, "Custom"] } }] });
    }
    if (method === "getBalance") return json({ value: log.balances++ === 0 ? 0.4e9 : 0.40149e9 });
    throw new Error(`unexpected call ${method}`);
  }) as never);
  return { log, open };
}

test("clean-up: closes only empty, unfrozen token accounts, and does not keep paying for one that will not close", async () => {
  _test.reset();
  _test.ready();
  _test.forgetCloses();
  const f = spare();
  const sigs: string[] = [];
  assert.equal(await _test.closeSpare(wallet(), sigs), 1, "one closed; the other close failed on chain");
  assert.equal(f.log.sends, 2, "the coin that was dropped in and the frozen account are left alone");
  assert.deepEqual(sigs, ["close-1", "close-2"]);
  assert.ok(!f.open.has(ACC.usdc) && f.open.has(ACC.spam) && f.open.has(ACC.frozen));
  assert.equal(await _test.closeSpare(wallet(), sigs), 0);
  assert.equal(f.log.sends, 2, "the account whose close failed is not tried again");
  run.setNet(fetch);
});

test("clean-up at a start: the rent that comes back is in the result but in no copy's row", async () => {
  _test.reset();
  _test.ready();
  _test.forgetCloses();
  _test.setConfig(CFG);
  const st = _test.state();
  st.netSol = 0.02;
  spare();
  await tidy();
  assert.deepEqual({ netSol: st.netSol, rentBackSol: st.rentBackSol, spareClosed: st.spareClosed, rows: st.rows.length }, { netSol: 0.02149, rentBackSol: 0.00149, spareClosed: 1, rows: 0 });
  const s = solanaCopyLiveSummary();
  assert.deepEqual({ rentBackSol: s.rentBackSol, spareAccountsClosed: s.spareAccountsClosed }, { rentBackSol: 0.00149, spareAccountsClosed: 1 });
  // a copy under way, or the test switched off: nothing is touched
  st.open = { mint: MINT, bal0: 0.4, t: Date.now(), tries: 0 };
  const f = spare();
  _test.forgetCloses();
  await tidy();
  st.open = null;
  _test.setConfig({ ...CFG, on: false });
  await tidy();
  assert.equal(f.log.sends + f.log.balances, 0);
  run.setNet(fetch);
  _test.setConfig(null);
  _test.reset();
});
