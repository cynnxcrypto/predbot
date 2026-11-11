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
const { _test: run, shared } = await import("./copyrun.js");
const { buildSigned, wallet } = await import("./keys.js");
const { base58 } = await import("./whirlpool.js");
const { recoverMany, HARD_MAX_OPEN, solanaCopyLiveQuiet, solanaCopyLiveWaiting, whyNotSent, MIN_STOP_PCT, exitKey, heldTogether, REQUOTE_MS, PIPE, speedOf, byLanding, feesOf, readFees } = await import("./copylive.js");
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
const CFG: LiveConfig = { on: true, stakeSol: 0.05, maxLossSol: 0.5, holdSec: 60, targetPct: 10, stopPct: 0, maxPerDay: Number.MAX_SAFE_INTEGER, minGapPct: 0, maxOpen: 1, traders: "all", slippageBps: 1500, maxFeeLamports: 1_000_000, maxBuyFeeLamports: 1_000_000 };
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
  assert.deepEqual(s.exit, { targetPct: 10, holdSec: 60, stopPct: 0 });
  assert.deepEqual(s.open, { stakeSol: 0.05, heldSec: 12, tries: 0, worthSol: 0.04845, nowPct: -3.1, bestPct: 2.4 });
  assert.deepEqual(s.targetExit, { copies: 2, atTarget: 1, atTimeUp: 1, atStop: 0, won: 1, netSol: -0.003, bestPctMedian: 4, missedTargetSales: 1 });
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
  assert.equal(log.swaps, 2, "12% above the wallet's price: the order is built (the made-up build fails, so it is tried once more)");
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
  assert.equal(all.swaps, 2);
  assert.equal(_test.state().rows[0].quoteGapPct, 1);
  assert.match(solanaCopyLiveSummary().entryRule, /every first buy/);
  run.setNet(fetch);
  _test.setConfig(null);
  _test.reset();
});

test("wallet check: money put in beyond what was agreed stops buying and says so; the test's own winnings do not", async () => {
  const net = (lamports: number) => {
    const log = { quotes: 0 };
    run.setNet((async (url: string, init?: { body?: string }) => {
      if (url.includes("/swap/v1/quote")) return log.quotes++, new Response(JSON.stringify({ outAmount: raw(1) }));
      if (url.includes("/swap/v1/swap")) return new Response("no", { status: 500 });
      const { method } = JSON.parse(init!.body!) as { method: string };
      if (method === "getBalance") return new Response(JSON.stringify({ result: { value: lamports } }));
      throw new Error(`unexpected call ${method}`);
    }) as never);
    return log;
  };
  for (const maxOpen of [1, 5]) {
    _test.reset();
    _test.ready();
    _test.setConfig({ ...CFG, maxOpen });
    // 0.75 SOL in a wallet that was to hold 0.5: somebody put more in
    let log = net(0.75e9);
    await trade(signal());
    assert.equal(log.quotes, 0);
    assert.match(_test.state().note, /more than was agreed .*0\.6 SOL now.*not buying/);
    assert.match(solanaCopyLiveSummary().note, /not buying until the extra is taken out/, "it says so in the status");
    // the same 0.75 SOL after the test has won 0.2: that is its own money, it goes on
    _test.reset();
    _test.state().netSol = 0.2;
    log = net(0.75e9);
    await trade(signal());
    assert.ok(log.quotes > 0, "it goes on to price the buy");
    assert.equal(_test.state().note, "");
    // winnings and more on top: stops again
    _test.reset();
    _test.state().netSol = 0.2;
    log = net(0.85e9);
    await trade(signal());
    assert.equal(log.quotes, 0);
    assert.match(_test.state().note, /0\.8 SOL now/);
  }
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
  // a buy that comes while a copy is under way is let go and counted
  _test.state().open = { mint: MINT, bal0: 0.4, t: Date.now(), tries: 0 };
  await trade(signal());
  _test.state().open = null;
  assert.equal(solanaCopyLiveSummary().missedWhileBusy, 1);
  // the same day with the limit taken away: it trades again, and the note goes
  _test.setConfig(CFG);
  log = entry(() => raw(1));
  await trade(signal());
  assert.ok(log.quotes > 0, "it goes on to price the buy");
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

// ---- several coins at once ------------------------------------------------------------------------------------------
const SOLMINT = "So11111111111111111111111111111111111111112";
const COIN = { a: MINT, b: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", c: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
const FEE = 5000;
const RENT = 2_039_280;
const sigOfTx = (b64: string) => base58(Buffer.from(b64, "base64").subarray(1, 65));
/**
 * A made-up chain and Jupiter that keep real books: a wallet with 0.5 SOL, a token account per coin (named by the
 * coin's own address), every transaction with the wallet's SOL before and after it. `worth(mint)` = what selling
 * the coin brings back now (SOL); a coin in `stuck` cannot be sold (the sale lands and fails); a transaction id in
 * `hidden` has landed but cannot be read back.
 */
function chain(worth: (mint: string) => number) {
  const w = wallet();
  const c = {
    lamports: 0.5e9, n: 0, quotes: 0, sends: 0,
    held: new Map<string, bigint>(), // coin -> amount, for every token account that exists
    built: new Map<string, { kind: "buy" | "sell"; mint: string; out: number }>(),
    txs: new Map<string, { pre: number; post: number; ok: boolean }>(),
    stuck: new Set<string>(), hidden: new Set<string>(),
    // the price service misbehaving: buy orders it fails to build, coins it has no route for, and the buy quotes it gives next
    failBuild: 0, noRoute: new Set<string>(), code: "COULD_NOT_FIND_ANY_ROUTE", buyOut: [] as string[],
    // buy quotes it refuses for asking too fast (http 429) before it answers again
    refuse: 0,
    apply(sig: string, delta: number, ok: boolean) {
      c.txs.set(sig, { pre: c.lamports, post: c.lamports + delta, ok });
      c.lamports += delta;
    },
    /** a buy that happened before a restart: returns its id */
    bought(mint: string) {
      const sig = sigOfTx(buildSigned(w, SYSTEM, SYSTEM, [{ pubkey: w.address, writable: true }], [200 + ++c.n]));
      c.held.set(mint, 1000n);
      c.apply(sig, -(0.05e9 + FEE + RENT), true);
      return sig;
    },
  };
  const acc = (mint: string) => ({ pubkey: mint, account: { owner: T22, data: { parsed: { info: { mint, state: "initialized", tokenAmount: { amount: c.held.get(mint)!.toString(), decimals: 6 } } } } } });
  run.setNet((async (url: string, init?: { body?: string }) => {
    const json = (x: unknown) => new Response(JSON.stringify(x));
    if (url.includes("/swap/v1/quote")) {
      c.quotes++;
      const u = new URL(url).searchParams;
      const [i, o] = [u.get("inputMint")!, u.get("outputMint")!];
      if (i === SOLMINT && c.refuse > 0) {
        c.refuse--;
        return new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 });
      }
      if (i === SOLMINT && c.noRoute.has(o)) return new Response(JSON.stringify({ error: "Could not find any route", errorCode: c.code }), { status: 400 });
      if (i === SOLMINT && c.buyOut.length) return json({ outAmount: c.buyOut.shift(), inputMint: i, outputMint: o });
      return json(i === SOLMINT ? { outAmount: "5000000000", inputMint: i, outputMint: o } : { outAmount: String(Math.round(worth(i) * 1e9)), inputMint: i, outputMint: o });
    }
    if (url.includes("/swap/v1/swap")) {
      const q = (JSON.parse(init!.body!) as { quoteResponse: { inputMint: string; outputMint: string; outAmount: string } }).quoteResponse;
      if (q.inputMint === SOLMINT && c.failBuild > 0) {
        c.failBuild--;
        return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
      }
      const tx = buildSigned(w, SYSTEM, SYSTEM, [{ pubkey: w.address, writable: true }], [++c.n]);
      c.built.set(sigOfTx(tx), q.inputMint === SOLMINT ? { kind: "buy", mint: q.outputMint, out: 0 } : { kind: "sell", mint: q.inputMint, out: Number(q.outAmount) });
      return json({ swapTransaction: tx });
    }
    const { method, params } = JSON.parse(init!.body!) as { method: string; params: unknown[] };
    const res = (x: unknown) => json({ result: x });
    if (method === "getBalance") return res({ value: c.lamports });
    if (method === "getLatestBlockhash") return res({ value: { blockhash: SYSTEM } });
    if (method === "getSignaturesForAddress") return res([]);
    if (method === "sendTransaction") {
      c.sends++;
      const raw = Buffer.from(params[0] as string, "base64");
      const sig = base58(raw.subarray(1, 65));
      const b = c.built.get(sig);
      if (b?.kind === "buy") {
        c.held.set(b.mint, 1000n);
        c.apply(sig, -(0.05e9 + FEE + RENT), true);
      } else if (b?.kind === "sell") {
        const ok = !c.stuck.has(b.mint) && (c.held.get(b.mint) ?? 0n) > 0n;
        if (ok) c.held.set(b.mint, 0n);
        c.apply(sig, ok ? b.out - FEE : -FEE, ok);
      } else {
        // an account close: the account is the second key of the transaction
        const mint = base58(raw.subarray(69 + 32, 69 + 64));
        const ok = c.held.get(mint) === 0n;
        if (ok) c.held.delete(mint);
        c.apply(sig, ok ? RENT - FEE : -FEE, ok);
      }
      return res(sig);
    }
    if (method === "getSignatureStatuses") return res({ value: (params[0] as string[]).map((s) => (c.txs.has(s) ? { slot: 500, err: c.txs.get(s)!.ok ? null : { InstructionError: [0, "Custom"] } } : null)) });
    if (method === "getTransaction") {
      const t = c.txs.get(params[0] as string);
      return res(t && !c.hidden.has(params[0] as string) ? { meta: { preBalances: [t.pre, 1], postBalances: [t.post, 1] }, transaction: { message: { accountKeys: [w.address, SYSTEM] } } } : null);
    }
    if (method === "getTokenAccountsByOwner") {
      const f = params[1] as { mint?: string; programId?: string };
      if (f.mint) return res({ value: c.held.has(f.mint) ? [acc(f.mint)] : [] });
      return res({ value: f.programId === T22 ? [...c.held.keys()].map(acc) : [] });
    }
    throw new Error(`unexpected call ${method}`);
  }) as never);
  return c;
}
const MANY: LiveConfig = { ...CFG, maxOpen: 5, holdSec: 3 };
const old = () => Date.now() - 80_000; // long known: the count of followers is not waited for
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("several at once: hard limit, and one at a time unless the file says otherwise", () => {
  assert.equal(parseLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 0.5 } })).maxOpen, 1);
  assert.equal(parseLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 0.5, maxOpen: 5 } })).maxOpen, 5);
  assert.equal(parseLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 0.5, maxOpen: 50 } })).maxOpen, HARD_MAX_OPEN);
  assert.equal(parseLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 0.5, maxOpen: 0 } })).maxOpen, 1);
});

test("several at once: two coins held together, each counted from its own transactions, and the books equal the wallet", async () => {
  _test.reset();
  _test.ready();
  _test.forgetCloses();
  _test.setPoll(20);
  _test.setConfig(MANY);
  const t0 = Date.now();
  // coin a reaches +16% after 1.6 s; coin b never does and is sold when its time is up
  const c = chain((m) => (m === COIN.a ? (Date.now() - t0 > 1600 ? 0.058 : 0.05) : 0.045));
  const st = _test.state;
  const a = trade(signal({ mint: COIN.a, sig: "lead-a", knownMs: old() }));
  await wait(1100);
  const b = trade(signal({ mint: COIN.b, sig: "lead-b", knownMs: old() }));
  await wait(250);
  assert.equal(st().opens.length, 2, "both coins are out at the same time");
  const s1 = solanaCopyLiveSummary();
  assert.deepEqual({ openCount: s1.openCount, maxOpen: s1.maxOpen, opens: s1.opens.length, openPosition: s1.openPosition }, { openCount: 2, maxOpen: 5, opens: 2, openPosition: true });
  assert.ok(!JSON.stringify(s1).includes(COIN.a) && !JSON.stringify(s1).includes(COIN.b));
  // the same coin again while it is held: let go (a sale sells all of a coin)
  await trade(signal({ mint: COIN.a, sig: "lead-a2", knownMs: old() }));
  assert.equal(st().missedSame, 1);
  await Promise.all([a, b]);
  const [ra, rb] = [st().rows.find((r) => r.mint === COIN.a)!, st().rows.find((r) => r.mint === COIN.b)!];
  assert.deepEqual({ buy: ra.buy, sold: ra.sold, exit: ra.exit, netSol: ra.netSol }, { buy: "landed", sold: true, exit: "target", netSol: 0.007985 }, "0.058 back for 0.05, less three fees; the account's rent came back");
  assert.deepEqual({ buy: rb.buy, sold: rb.sold, exit: rb.exit, netSol: rb.netSol }, { buy: "landed", sold: true, exit: "time", netSol: -0.005015 });
  assert.equal(st().netSol, 0.00297);
  assert.equal(c.lamports, 0.5e9 + 2_970_000, "the made-up wallet moved by exactly what the books say");
  assert.deepEqual({ opens: st().opens.length, baseSol: st().baseSol, driftSol: st().driftSol, trades: st().trades, unread: st().unreadTx }, { opens: 0, baseSol: 0.5, driftSol: 0, trades: 2, unread: 0 });
  assert.equal(c.held.size, 0, "both token accounts were closed");
  assert.equal(solanaCopyLiveSummary().booksVsWalletSol, 0);
  // the status says that two were out together, so nobody has to catch the few seconds on the dashboard
  assert.deepEqual(solanaCopyLiveSummary().heldTogether, { copies: 2, most: 2, pairs: 1 });
  assert.ok(ra.heldAt! >= ra.t && rb.heldAt! > ra.heldAt!);
  // rows from before the moment was written down are placed from their start and the time the order took
  const row = (t: number, heldSec: number, pipelineMs = 500): Row => ({ t, name: "", mint: "", leaderSlot: 0, buy: "landed", netSol: 0, sigs: [], heldSec, pipelineMs });
  assert.deepEqual(heldTogether([row(0, 60), row(20_000, 5), row(50_000, 60), row(200_000, 10), { ...row(205_000, 3), heldSec: undefined }]), { copies: 4, most: 2, pairs: 2 });
  assert.deepEqual(heldTogether([row(0, 60), row(1000, 60), row(2000, 60), row(100_000, 1)]), { copies: 4, most: 3, pairs: 3 });
  assert.deepEqual(heldTogether([row(0, 5), row(10_000, 5)]), { copies: 2, most: 1, pairs: 0 });
  assert.deepEqual(heldTogether([]), { copies: 0, most: 0, pairs: 0 });
  run.setNet(fetch);
  _test.setConfig(null);
  _test.reset();
});

test("several at once: the loss cap holds even if every coin that is out is lost in full", async () => {
  _test.reset();
  _test.ready();
  _test.setConfig(MANY);
  const c = chain(() => 0.05);
  const st = _test.state();
  // 0.30 SOL lost, two coins out: a third would make 0.30 + 3 x (0.05 + 0.03) = 0.54
  st.netSol = -0.3;
  st.opens.push({ mint: COIN.a, t: Date.now(), tries: 0, sigs: [] }, { mint: COIN.b, t: Date.now(), tries: 0, sigs: [] });
  await trade(signal({ mint: COIN.c, knownMs: old() }));
  assert.deepEqual({ missedCap: st.missedCap, quotes: c.quotes, halted: st.halted }, { missedCap: 1, quotes: 0, halted: "" });
  // five out: the sixth is let go
  st.netSol = 0;
  st.opens.push({ mint: SOLMINT, t: Date.now(), tries: 0, sigs: [] }, { mint: SYSTEM, t: Date.now(), tries: 0, sigs: [] }, { mint: CLASSIC, t: Date.now(), tries: 0, sigs: [] });
  await trade(signal({ mint: COIN.c, knownMs: old() }));
  assert.deepEqual({ missedBusy: st.missedBusy, quotes: c.quotes }, { missedBusy: 1, quotes: 0 });
  // at the cap with a coin still out: no new buy, and the stop for good waits until nothing is out
  st.opens.length = 1;
  st.netSol = -0.43;
  await trade(signal({ mint: COIN.c, knownMs: old() }));
  assert.equal(st.halted, "");
  st.opens.length = 0;
  await trade(signal({ mint: COIN.c, knownMs: old() }));
  assert.match(st.halted, /loss cap reached/);
  assert.equal(c.quotes + c.sends, 0);
  run.setNet(fetch);
  _test.setConfig(null);
  _test.reset();
});

test("several at once: after a restart every open coin is finished and counted once; one that cannot be sold stops new buys only", async () => {
  _test.reset();
  _test.ready();
  _test.forgetCloses();
  _test.setRecoverWait(0);
  _test.setConfig(MANY);
  const c = chain(() => 0.052);
  const st = _test.state;
  st().baseSol = 0.5;
  // two coins were out when the bot stopped; their buys are on the chain and their ids on the markers
  st().opens.push({ mint: COIN.a, t: Date.now() - 200_000, tries: 0, sigs: [c.bought(COIN.a)] }, { mint: COIN.b, t: Date.now() - 200_000, tries: 0, sigs: [c.bought(COIN.b)] });
  c.stuck.add(COIN.b);
  await recoverMany();
  const [ra, rb] = [st().rows.find((r) => r.mint === COIN.a)!, st().rows.find((r) => r.mint === COIN.b)!];
  assert.deepEqual({ buy: ra.buy, sold: ra.sold, netSol: ra.netSol }, { buy: "interrupted", sold: true, netSol: 0.001985 }, "the buy from before the restart is in the result");
  assert.deepEqual({ sold: rb.sold, netSol: rb.netSol }, { sold: false, netSol: -0.05207428 }, "the buy, the rent and six failed sales");
  assert.equal(st().opens.length, 1, "the sold coin's marker is gone, the other stays");
  assert.deepEqual({ mint: st().opens[0].mint, tries: st().opens[0].tries, sigs: st().opens[0].sigs.length }, { mint: COIN.b, tries: 1, sigs: 0 });
  assert.match(st().halted, /could not sell/);
  assert.equal(Math.round(st().netSol * 1e9), c.lamports - 0.5e9, "books and wallet agree to the lamport");
  // new buys are stopped ...
  await trade(signal({ mint: COIN.c, knownMs: old() }));
  assert.equal(c.held.has(COIN.c), false);
  // ... and when the coin can be sold again, the next pass sells it and counts only what is new
  c.stuck.delete(COIN.b);
  await recoverMany();
  assert.equal(st().opens.length, 0);
  assert.equal(st().halted, "");
  assert.equal(Math.round(st().netSol * 1e9), c.lamports - 0.5e9);
  assert.equal(st().driftSol, 0);
  assert.equal(st().rows.filter((r) => r.mint === COIN.b).length, 2);
  run.setNet(fetch);
  _test.setConfig(null);
  _test.setRecoverWait(5000);
  _test.reset();
});

test("several at once: a transaction that cannot be read back yet is counted later, never lost", async () => {
  _test.reset();
  _test.ready();
  _test.forgetCloses();
  _test.setPoll(20);
  _test.setRecoverWait(0);
  _test.setConfig({ ...MANY, holdSec: 1 });
  const c = chain(() => 0.058);
  const st = _test.state;
  // the sale lands, but the node will not show it for a while
  const seen = new Set<string>();
  const hide = setInterval(() => {
    for (const [sig, b] of c.built) if (b.kind === "sell" && !seen.has(sig)) (seen.add(sig), c.hidden.add(sig));
  }, 5);
  await trade(signal({ mint: COIN.a, knownMs: old() }));
  clearInterval(hide);
  const first = st().rows[0];
  assert.deepEqual({ sold: first.sold, unread: first.unread, netSol: first.netSol }, { sold: true, unread: 1, netSol: -0.05001 }, "the buy and the close are counted, the sale is not yet");
  assert.equal(st().opens.length, 1, "the marker stays, holding the id that is still to be read");
  assert.equal(st().opens[0].sigs.length, 1);
  assert.deepEqual({ done: st().opens[0].done, halted: st().halted }, { done: true, halted: "" });
  // still not readable: it stays, and after three tries nothing new is bought until it is
  await recoverMany();
  await recoverMany();
  await recoverMany();
  assert.match(st().halted, /could not be read back/);
  assert.equal(st().opens.length, 1);
  c.hidden.clear();
  await recoverMany();
  assert.deepEqual({ opens: st().opens.length, halted: st().halted, rows: st().rows.length }, { opens: 0, halted: "", rows: 1 });
  assert.equal(Math.round(st().netSol * 1e9), c.lamports - 0.5e9, "now the books equal the wallet");
  assert.deepEqual({ netSol: first.netSol, unread: first.unread, total: st().netSol, drift: st().driftSol }, { netSol: 0.007985, unread: undefined, total: 0.007985, drift: 0 }, "the sale went into the copy's own row");
  run.setNet(fetch);
  _test.setConfig(null);
  _test.setRecoverWait(5000);
  _test.reset();
});

test("before a restart: no new copy is started, the coins that are out are sold, and only then is it clear to stop", async () => {
  _test.reset();
  _test.ready();
  _test.forgetCloses();
  _test.setPoll(20);
  _test.setConfig({ ...MANY, holdSec: 1 });
  const c = chain(() => 0.045);
  const st = _test.state;
  assert.equal(solanaCopyLiveWaiting(), "");
  assert.equal(solanaCopyLiveSummary().restartPending, null);
  const a = trade(signal({ mint: COIN.a, knownMs: old() }));
  await wait(250);
  const b = trade(signal({ mint: COIN.b, knownMs: old() }));
  await wait(250);
  assert.equal(st().opens.length, 2);
  assert.equal(solanaCopyLiveWaiting(), "waiting for 2 open coins", "not a moment to stop");
  solanaCopyLiveQuiet();
  await trade(signal({ mint: COIN.c, knownMs: old() }));
  assert.deepEqual({ opens: st().opens.length, missed: st().missedRestart, bought: c.held.has(COIN.c) }, { opens: 2, missed: 1, bought: false });
  assert.equal(solanaCopyLiveSummary().restartPending, "restart pending: waiting for 2 open coins");
  await Promise.all([a, b]);
  assert.equal(solanaCopyLiveWaiting(), "", "sold, counted, accounts closed");
  assert.equal(solanaCopyLiveSummary().restartPending, "restart pending: nothing open");
  assert.deepEqual({ opens: st().opens.length, sold: st().rows.map((r) => r.sold), drift: st().driftSol }, { opens: 0, sold: [true, true], drift: 0 });
  // left-over coins are still finished while no new copy starts: the switch does not stop the recovery
  _test.setRecoverWait(0);
  st().opens.push({ mint: COIN.c, t: Date.now() - 200_000, tries: 0, sigs: [c.bought(COIN.c)] });
  await recoverMany();
  _test.setRecoverWait(5000);
  assert.deepEqual({ opens: st().opens.length, held: c.held.get(COIN.c) ?? 0n, drift: st().driftSol }, { opens: 0, held: 0n, drift: 0 });
  // one at a time: the same switch
  _test.reset();
  _test.setConfig(CFG);
  solanaCopyLiveQuiet();
  const sends = c.sends;
  await trade(signal({ mint: COIN.c, knownMs: old() }));
  assert.deepEqual({ trades: _test.state().trades, missed: _test.state().missedRestart, sends: c.sends - sends }, { trades: 0, missed: 1, sends: 0 });
  run.setNet(fetch);
  _test.setConfig(null);
  _test.reset();
});

test("a buy order the price service fails to build is tried once more, with a fresh price that must pass the entry rule again", async () => {
  const start = () => {
    _test.reset();
    _test.ready();
    _test.forgetCloses();
    _test.setPoll(20);
    _test.setConfig({ ...MANY, holdSec: 1, minGapPct: 9 });
    return chain((mint) => (mint === COIN.a ? 0.06 : 0.045));
  };
  const st = _test.state;
  // fails once: the second try goes out, with the gap of the fresh quote on the row
  let c = start();
  c.failBuild = 1;
  c.buyOut = [raw(20), raw(15)];
  await trade(signal({ mint: COIN.a, knownMs: old() }));
  assert.deepEqual({ rows: st().rows.length, buy: st().rows[0].buy, gap: st().rows[0].quoteGapPct, rebuilt: st().rebuilt, exit: st().rows[0].exit }, { rows: 1, buy: "landed", gap: 15, rebuilt: 1, exit: "target" });
  assert.equal(solanaCopyLiveSummary().rebuiltBuys, 1);
  // a second copy that runs out of time: the entry rule's own totals count both, with target sales and time-ups apart
  c.buyOut = [raw(12)];
  await trade(signal({ mint: COIN.b, knownMs: old() }));
  const e = solanaCopyLiveSummary().entryRuleCopies!;
  const [won, lost] = [st().rows[0].netSol, st().rows[1].netSol];
  assert.ok(won > 0 && lost < 0);
  const { byGap, byExit, byTrader, byPace, byLanding: landing, ...flat } = e;
  // both copies landed (the made-up chain lands everything at slot 500, the wallet bought at 100): one row, "4+"
  assert.deepEqual(landing.map((x) => [x.blocksBehind, x.copies]), [["1", 0], ["2", 0], ["3", 0], ["4+", 2]]);
  assert.deepEqual(byTrader.map((x) => [x.trader, x.copies]), [["new", 2]]);
  assert.deepEqual(byPace.map((x) => [x.pace, x.copies]), [["calm", 2]]);
  assert.deepEqual({ ...flat, netSol: 0 }, { minGapPct: 9, copies: 2, landed: 2, won: 1, netSol: 0, targetSales: 1, targetSalesSol: Math.round(won * 1e6) / 1e6, timeUps: 1, timeUpsWon: 0, timeUpsSol: Math.round(lost * 1e6) / 1e6, stops: 0, stopsSol: 0, otherSol: 0, rowsKept: 2 });
  // the same two copies by entry gap (the first was bought 15% above the wallet, the second 12%) ...
  const [w6, l6] = [Math.round(won * 1e6) / 1e6, Math.round(lost * 1e6) / 1e6];
  assert.deepEqual(byGap.map((g) => [g.fromPct, g.toPct, g.copies, g.won, g.netSol, g.targetSales, g.timeUps]), [[9, 12, 0, 0, 0, 0, 0], [12, 15, 1, 0, l6, 0, 1], [15, 20, 1, 1, w6, 1, 0], [20, 30, 0, 0, 0, 0, 0], [30, null, 0, 0, 0, 0, 0]]);
  // ... and by the exit in force when each was bought; a row from before the exit was written down counts apart
  assert.equal(exitKey({ targetPct: 10, stopPct: 0, holdSec: 30 }), "tp10-t30");
  assert.equal(exitKey({ targetPct: 10, stopPct: 20, holdSec: 60 }), "tp10-sl20-t60");
  assert.equal(exitKey({ targetPct: 0, stopPct: 0, holdSec: 6 }), "t6");
  assert.deepEqual(byExit.map((x) => [x.exit, x.copies, x.won]), [[exitKey({ ...MANY, holdSec: 1, stopPct: 0 }), 2, 1]]);
  delete st().rows[1].exitKey;
  assert.deepEqual(solanaCopyLiveSummary().entryRuleCopies!.byExit.map((x) => [x.exit, x.copies, x.timeUpsSol]), [[exitKey({ ...MANY, holdSec: 1, stopPct: 0 }), 1, 0], ["earlier", 1, l6]]);
  assert.ok(Math.abs(e.netSol - (won + lost)) < 1e-6);
  assert.equal(st().driftSol, 0, "the books still equal the wallet");
  // fails once, and the fresh price is no longer far enough above the wallet's: no copy, no row, nothing sent
  c = start();
  c.failBuild = 1;
  c.buyOut = [raw(20), raw(5)];
  await trade(signal({ mint: COIN.a, knownMs: old() }));
  assert.deepEqual({ rows: st().rows.length, low: st().skippedLowGap, sends: c.sends, opens: st().opens.length }, { rows: 0, low: 1, sends: 0, opens: 0 });
  // fails twice: that is final, and the status says why in our own words
  c = start();
  c.failBuild = 2;
  c.buyOut = [raw(20), raw(20)];
  await trade(signal({ mint: COIN.a, knownMs: old() }));
  assert.deepEqual({ buy: st().rows[0].buy, error: st().rows[0].error, sends: c.sends, opens: st().opens.length }, { buy: "not sent", error: "jupiter /swap/v1/swap http 500", sends: 0, opens: 0 });
  // no route for the coin: Jupiter's own code is kept, anything that is not a plain code is not
  c.noRoute.add(COIN.b);
  await wait(250);
  await trade(signal({ mint: COIN.b, knownMs: old() }));
  assert.equal(st().rows[1].error, "jupiter /swap/v1/quote http 400 COULD_NOT_FIND_ANY_ROUTE");
  c.code = "see https://example.com/?key=abc";
  c.noRoute.add(COIN.c);
  await wait(250);
  await trade(signal({ mint: COIN.c, knownMs: old() }));
  assert.equal(st().rows[2].error, "jupiter /swap/v1/quote http 400");
  const sum = solanaCopyLiveSummary();
  assert.deepEqual(sum.notSent, { n: 3, why: { "the price service could not build the order": 1, "the price service has no route for the coin": 2 } });
  assert.equal(sum.entryRuleCopies!.copies, 0, "a buy that was never sent is not a copy");
  assert.equal(whyNotSent("jupiter /swap/v1/quote http 429"), "the price service refused: too many requests");
  assert.equal(whyNotSent("fetch failed"), "network error or time-out");
  assert.equal(whyNotSent("something new"), "other");
  run.setNet(fetch);
  _test.setConfig(null);
  _test.reset();
});

test("a buy quote refused for asking too fast is asked again, and the paper test is told to stand back", async () => {
  const start = () => {
    _test.reset();
    _test.ready();
    _test.forgetCloses();
    _test.setPoll(20);
    _test.setConfig({ ...MANY, holdSec: 1, minGapPct: 9 });
    return chain(() => 0.06);
  };
  const st = _test.state;
  const realFirst = shared.realFirst;
  const asked: number[] = [];
  shared.realFirst = (ms: number) => void asked.push(ms);
  try {
    // refused once: the second ask goes through 0.15 s later and the copy is made
    let c = start();
    c.refuse = 1;
    c.buyOut = [raw(20)];
    const t0 = Date.now();
    await trade(signal({ mint: COIN.a, knownMs: old() }));
    assert.deepEqual({ rows: st().rows.length, buy: st().rows[0].buy, gap: st().rows[0].quoteGapPct, requoted: st().requoted }, { rows: 1, buy: "landed", gap: 20, requoted: 1 });
    assert.ok(Date.now() - t0 >= REQUOTE_MS[0]);
    assert.equal(solanaCopyLiveSummary().requotedBuys, 1);
    // the paper test was told to stand back: at the start of the copy, and longer at the refusal
    assert.ok(asked.includes(800) && asked.includes(2000));
    // refused three times: that is final, and the status says why
    c = start();
    c.refuse = 3;
    await trade(signal({ mint: COIN.b, knownMs: old() }));
    assert.deepEqual({ buy: st().rows[0].buy, error: st().rows[0].error, requoted: st().requoted, sends: c.sends, opens: st().opens.length }, { buy: "not sent", error: "jupiter /swap/v1/quote http 429", requoted: 2, sends: 0, opens: 0 });
    assert.deepEqual(solanaCopyLiveSummary().notSent, { n: 1, why: { "the price service refused: too many requests": 1 } });
    // the fresh quote decides: refused once, and by then the price is no longer far enough above the wallet's
    c = start();
    c.refuse = 1;
    c.buyOut = [raw(5)];
    await trade(signal({ mint: COIN.c, knownMs: old() }));
    assert.deepEqual({ rows: st().rows.length, low: st().skippedLowGap, sends: c.sends }, { rows: 0, low: 1, sends: 0 });
  } finally {
    shared.realFirst = realFirst;
    run.setNet(fetch);
    _test.setConfig(null);
    _test.reset();
  }
});

test("speed: the balance is read while the price is asked, and nothing is signed before it is known and inside the limits", async () => {
  const st = _test.state;
  /** the made-up chain, with a slow balance read and a record of the order the calls were made in */
  const start = (lastSeenSol: number | null) => {
    _test.reset();
    _test.ready();
    _test.forgetCloses();
    _test.setPoll(20);
    _test.setConfig({ ...MANY, holdSec: 1, minGapPct: 9 });
    const c = chain(() => 0.06);
    st().balanceSol = lastSeenSol;
    const inner = shared.fetch();
    const order: string[] = [];
    run.setNet((async (url: string, init?: { body?: string }) => {
      const what = url.includes("/swap/v1/quote") ? "quote" : url.includes("/swap/v1/swap") ? "build" : (JSON.parse(init!.body!) as { method: string }).method;
      if (what !== "getBalance") return order.push(what), inner(url, init as never);
      order.push("balance asked");
      await wait(60);
      const r = await inner(url, init as never);
      order.push("balance known");
      return r;
    }) as never);
    return { c, order, first: (x: string) => order.indexOf(x) };
  };
  try {
    // the last balance seen was fine: the price is asked while the balance is still being read, and the order
    // leaves only once the balance is known
    let f = start(0.45);
    f.c.buyOut = [raw(20)];
    await trade(signal({ mint: COIN.a, knownMs: old() }));
    assert.ok(f.first("balance asked") < f.first("quote") && f.first("quote") < f.first("balance known"), "price asked before the balance is back");
    assert.ok(f.first("balance known") < f.first("sendTransaction"), "nothing sent before the balance is known");
    assert.deepEqual({ buy: st().rows[0].buy, pipe: st().rows[0].pipe, pre: typeof st().rows[0].preMs, note: st().note }, { buy: "landed", pipe: PIPE, pre: "number", note: "" });
    const way = solanaCopyLiveSummary().speedByWay;
    assert.deepEqual([way.length, way[0].way, way[0].copies, way[0].landed], [1, PIPE, 1, 1]);
    // the wallet has run low since the last look: the price was asked, but nothing is signed or sent
    f = start(0.45);
    f.c.lamports = 0.05e9;
    f.c.buyOut = [raw(20)];
    await trade(signal({ mint: COIN.a, knownMs: old() }));
    assert.deepEqual({ sends: f.c.sends, rows: st().rows.length, opens: st().opens.length, note: st().note, seen: st().balanceSol }, { sends: 0, rows: 0, opens: 0, note: "wallet balance too low for a copy", seen: 0.05 });
    // and from then on the balance is read first again: no price is asked for nothing
    const asked = f.c.quotes;
    await trade(signal({ mint: COIN.b, knownMs: old() }));
    assert.deepEqual({ quotes: f.c.quotes - asked, sends: f.c.sends }, { quotes: 0, sends: 0 });
    // more in the wallet than was agreed, found only by the fresh read: nothing is signed or sent either
    f = start(0.45);
    f.c.lamports = 0.75e9;
    f.c.buyOut = [raw(20)];
    await trade(signal({ mint: COIN.a, knownMs: old() }));
    assert.equal(f.c.sends, 0);
    assert.match(st().note, /more than was agreed/);
    // the balance cannot be read: the copy stops there, and the status says why
    f = start(0.45);
    f.c.buyOut = [raw(20)];
    const inner = shared.fetch();
    run.setNet((async (url: string, init?: { body?: string }) => {
      if (!url.includes("/swap/") && (JSON.parse(init!.body!) as { method: string }).method === "getBalance") return new Response("no", { status: 503 });
      return inner(url, init as never);
    }) as never);
    await trade(signal({ mint: COIN.a, knownMs: old() }));
    assert.deepEqual({ sends: f.c.sends, buy: st().rows[0].buy, why: whyNotSent(st().rows[0].error) }, { sends: 0, buy: "not sent", why: "network error or time-out" });
    // a buy the entry rule lets go: no order, and the balance that was read is still taken note of
    f = start(0.45);
    f.c.lamports = 0.44e9;
    f.c.buyOut = [raw(5)];
    await trade(signal({ mint: COIN.a, knownMs: old() }));
    await wait(100);
    assert.deepEqual({ low: st().skippedLowGap, sends: f.c.sends, rows: st().rows.length, seen: st().balanceSol }, { low: 1, sends: 0, rows: 0, seen: 0.44 });
    // never seen a balance (a first start): read first, as before
    f = start(null);
    f.c.buyOut = [raw(20)];
    await trade(signal({ mint: COIN.a, knownMs: old() }));
    assert.ok(f.first("balance known") < f.first("quote"));
    assert.equal(st().rows[0].buy, "landed");
  } finally {
    run.setNet(fetch);
    _test.setConfig(null);
    _test.reset();
  }
});

test("speed: the status tells the two ways of making an order apart, and what landing a block later cost", () => {
  const row = (over: object) => ({ t: 1, name: "x", mint: MINT, leaderSlot: 100, buy: "landed" as const, netSol: 0, sigs: [], ...over });
  const rows = [
    row({ slotsBehind: 1, pipelineMs: 230, quoteMs: 50, buildMs: 40, sendMs: 40, netSol: 0.004, quoteGapPct: 20, fillGapPct: 21 }),
    row({ slotsBehind: 2, pipelineMs: 250, quoteMs: 60, buildMs: 44, sendMs: 42, netSol: -0.003, quoteGapPct: 20, fillGapPct: 24 }),
    row({ slotsBehind: 1, pipe: 2, preMs: 3, warm: true, pipelineMs: 130, quoteMs: 30, buildMs: 40, sendMs: 40, netSol: 0.002, quoteGapPct: 16, fillGapPct: 16.5 }),
    row({ slotsBehind: 6, pipe: 2, preMs: 5, warm: false, pipelineMs: 170, quoteMs: 70, buildMs: 40, sendMs: 40, netSol: -0.01, quoteGapPct: 30, fillGapPct: 45 }),
    row({ buy: "not sent", pipe: 2, preMs: 4, warm: false }),
  ];
  assert.deepEqual(speedOf(rows.filter((r) => (r as { pipe?: number }).pipe === 2)), { copies: 2, pipelineMsMedian: 130, preMsMedian: 3, quoteMsMedian: 30, quoteMsWarmMedian: 30, quoteMsColdMedian: 70, buildMsMedian: 40, sendMsMedian: 40, slow: 0, landed: 2, nextBlock: 1, slotsBehindMedian: 1 });
  assert.equal(speedOf([...rows, row({ pipe: 2, pipelineMs: 400 })]).slow, 1, "a median hides a slow half: how many took over 250 ms is counted");
  assert.deepEqual(byLanding(rows), [
    { blocksBehind: "1", copies: 2, won: 2, netSol: 0.006, slipPctMedian: 0.43 },
    { blocksBehind: "2", copies: 1, won: 0, netSol: -0.003, slipPctMedian: 3.33 },
    { blocksBehind: "3", copies: 0, won: 0, netSol: 0, slipPctMedian: null },
    { blocksBehind: "4+", copies: 1, won: 0, netSol: -0.01, slipPctMedian: 11.54 },
  ]);
});

test("traders: off unless the file says so; a bad trader's buy is let go at no cost, and each copy carries the verdict", async () => {
  const live = (o: object) => parseLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 0.5, ...o } }));
  assert.deepEqual([live({}).traders, live({ traders: "cut-bad" }).traders, live({ traders: "good-only" }).traders, live({ traders: "anything" }).traders], ["all", "cut-bad", "good-only", "all"]);
  const verdict = shared.verdict;
  const pace = shared.pace;
  const start = (traders: "all" | "cut-bad" | "good-only", v: string) => {
    _test.reset();
    _test.ready();
    _test.forgetCloses();
    _test.setPoll(20);
    _test.setConfig({ ...MANY, holdSec: 1, minGapPct: 9, traders });
    shared.verdict = () => v as ReturnType<typeof verdict>;
    return chain(() => 0.06);
  };
  const st = _test.state;
  const buy = async () => {
    await trade(signal({ mint: COIN.a, wallet: "trader-1", knownMs: old() }));
    return { rows: st().rows.length, skipped: st().skippedTrader ?? 0 };
  };
  try {
    // "all": the verdict is only written on the row, nothing is skipped
    let c = start("all", "bad");
    c.buyOut = [raw(20)];
    assert.deepEqual(await buy(), { rows: 1, skipped: 0 });
    assert.equal(st().rows[0].trader, "bad");
    const sum = solanaCopyLiveSummary();
    assert.equal(sum.traderRule, "copies every listed trader");
    assert.deepEqual(sum.entryRuleCopies!.byTrader.map((x) => [x.trader, x.copies, x.won]), [["bad", 1, 1]]);
    // "cut-bad": a bad trader's buy is let go before anything is asked of the price service
    c = start("cut-bad", "bad");
    assert.deepEqual({ ...(await buy()), sends: c.sends }, { rows: 0, skipped: 1, sends: 0 });
    assert.deepEqual([solanaCopyLiveSummary().skippedTrader, solanaCopyLiveSummary().traderRule], [1, "does not copy traders whose earlier copies lost"]);
    for (const v of ["new", "mixed", "good"]) {
      c = start("cut-bad", v);
      c.buyOut = [raw(20)];
      assert.deepEqual(await buy(), { rows: 1, skipped: 0 }, v);
    }
    // "good-only": only a trader whose earlier copies were good
    for (const v of ["new", "mixed", "bad"]) {
      c = start("good-only", v);
      assert.deepEqual({ ...(await buy()), sends: c.sends }, { rows: 0, skipped: 1, sends: 0 }, v);
    }
    c = start("good-only", "good");
    c.buyOut = [raw(20)];
    assert.deepEqual(await buy(), { rows: 1, skipped: 0 });
    assert.equal(st().rows[0].trader, "good");
    assert.equal(solanaCopyLiveSummary().traderRule, "copies only traders whose earlier copies won");
    // one coin at a time: the same rule
    _test.reset();
    _test.setConfig({ ...CFG, traders: "cut-bad" });
    shared.verdict = () => "bad";
    await trade(signal({ mint: COIN.c, wallet: "trader-1", knownMs: old() }));
    assert.deepEqual({ rows: st().rows.length, skipped: st().skippedTrader }, { rows: 0, skipped: 1 });
    // "cut-busy": a trader who has bought often lately is let go, whatever the record says; a calm one is copied
    assert.equal(live({ traders: "cut-busy" }).traders, "cut-busy");
    shared.pace = () => "busy";
    c = start("cut-busy" as never, "good");
    assert.deepEqual({ ...(await buy()), sends: c.sends, quotes: c.quotes }, { rows: 0, skipped: 1, sends: 0, quotes: 0 });
    assert.equal(solanaCopyLiveSummary().traderRule, "does not copy traders who bought 3 or more times in the 3 hours before");
    shared.pace = () => "calm";
    c = start("cut-busy" as never, "bad");
    c.buyOut = [raw(20)];
    assert.deepEqual(await buy(), { rows: 1, skipped: 0 });
    assert.deepEqual([st().rows[0].pace, st().rows[0].trader], ["calm", "bad"]);
    assert.deepEqual(solanaCopyLiveSummary().entryRuleCopies!.byPace.map((x) => [x.pace, x.copies]), [["calm", 1]]);
    // "all": a busy trader is still copied, and the row says busy
    shared.pace = () => "busy";
    c = start("all", "new");
    c.buyOut = [raw(20)];
    assert.deepEqual(await buy(), { rows: 1, skipped: 0 });
    assert.equal(st().rows[0].pace, "busy");
  } finally {
    shared.pace = pace;
    shared.verdict = verdict;
    run.setNet(fetch);
    _test.setConfig(null);
    _test.reset();
  }
});

test("stop: off unless set; a copy that stays 20% down for two looks is sold at once, a dip of one look is not", async () => {
  const live = (o: object) => parseLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 0.5, ...o } }));
  assert.equal(live({}).stopPct, 0, "no stop unless one is set");
  assert.equal(live({ stopPct: 20 }).stopPct, 20);
  assert.equal(live({ stopPct: 2 }).stopPct, MIN_STOP_PCT, "tighter than the cost of an in-and-out would sell every copy");
  assert.equal(live({ stopPct: 500 }).stopPct, 90);
  assert.equal(live({ stopPct: "20" }).stopPct, 0);
  assert.equal(live({ stopPct: -20 }).stopPct, 0);
  const start = (cfg: Partial<LiveConfig>, worth: () => number) => {
    _test.reset();
    _test.ready();
    _test.forgetCloses();
    _test.setPoll(20);
    _test.setConfig({ ...MANY, holdSec: 2, ...cfg });
    return chain(worth);
  };
  const st = _test.state;
  // 6% down, then 22% down and staying there: sold long before the 2 s are over, through the usual sale
  let v = 0.047;
  let c = start({ stopPct: 20 }, () => v);
  const t0 = Date.now();
  const a = trade(signal({ mint: COIN.a, knownMs: old() }));
  await wait(500);
  assert.equal(st().opens.length, 1, "6% down is not a stop");
  v = 0.039;
  await a;
  const row = st().rows[0];
  assert.deepEqual({ exit: row.exit, sold: row.sold, opens: st().opens.length, drift: st().driftSol }, { exit: "stop", sold: true, opens: 0, drift: 0 });
  assert.ok(Date.now() - t0 < 1900 && row.heldSec! < 1.5, "did not wait for the clock");
  assert.ok(row.netSol < -0.011 && row.netSol > -0.013, "lost what the coin was down, not more");
  const sum = solanaCopyLiveSummary();
  assert.match(sum.exitRule, /sells at \+10% or after 2 s, and sooner if it is 20% down/);
  assert.equal(sum.targetExit.atStop, 1);
  assert.equal(c.held.has(COIN.a), false);
  // one look far down (a bad quote, a dip of a moment), then back: no stop, the clock sells
  let dip = 1;
  c = start({ stopPct: 20, holdSec: 1 }, () => (dip-- > 0 ? 0.03 : 0.047));
  await trade(signal({ mint: COIN.a, knownMs: old() }));
  assert.deepEqual({ exit: st().rows[0].exit, sold: st().rows[0].sold }, { exit: "time", sold: true });
  // no stop set: 22% down is held to the clock, as before
  c = start({ holdSec: 1 }, () => 0.039);
  await trade(signal({ mint: COIN.a, knownMs: old() }));
  assert.deepEqual({ exit: st().rows[0].exit, sold: st().rows[0].sold }, { exit: "time", sold: true });
  assert.doesNotMatch(solanaCopyLiveSummary().exitRule, /down/);
  // with the 9% rule on, a stopped copy is counted in the rule's own totals
  c = start({ stopPct: 20, minGapPct: 9 }, () => 0.039);
  c.buyOut = [raw(12)];
  await trade(signal({ mint: COIN.a, knownMs: old() }));
  const e = solanaCopyLiveSummary().entryRuleCopies!;
  assert.deepEqual({ copies: e.copies, stops: e.stops, timeUps: e.timeUps, other: e.otherSol, same: e.stopsSol === e.netSol }, { copies: 1, stops: 1, timeUps: 0, other: 0, same: true });
  run.setNet(fetch);
  _test.setConfig(null);
  _test.reset();
});

test("fees: the network fees inside the results are shown apart, and a buy may get its own lower limit", () => {
  const row = (over: object) => ({ t: 1, name: "x", mint: MINT, leaderSlot: 100, buy: "landed" as const, netSol: 0, sigs: ["a", "b"], ...over });
  const rows = [
    row({ netSol: -0.004, feeSol: 0.0021, buyFeeSol: 0.001005, feeTx: 2 }),
    row({ netSol: 0.003, feeSol: 0.0011, buyFeeSol: 0.000505, feeTx: 3 }),
    row({ netSol: -0.002, feeSol: 0.0017, buyFeeSol: 0.000705, feeTx: 2 }),
    row({ netSol: -0.001 }), // not read back yet: in neither sum
    row({ buy: "not sent", feeSol: 0 }), // nothing was sent: not a copy
  ];
  const f = feesOf(rows, { stakeSol: 0.05, maxFeeLamports: 1_000_000, maxBuyFeeLamports: 400_000 });
  assert.equal(f.copiesRead, 3);
  assert.equal(f.copiesNotReadYet, 1);
  assert.equal(f.feesSol, 0.0049);
  assert.equal(f.resultSol, -0.003);
  assert.equal(f.resultBeforeFeesSol, 0.0019, "what the same copies would show had the network been free");
  assert.equal(f.perCopySolMedian, 0.0017);
  assert.equal(f.perCopyPctOfStakeMedian, 3.4);
  assert.equal(f.buyFeeSolMedian, 0.000705);
  assert.equal(f.txPerCopyMedian, 2);
  assert.equal(f.limitSol, 0.001);
  assert.equal(f.buyLimitSol, 0.0004);
  assert.equal(feesOf([], { stakeSol: 0.05, maxFeeLamports: 1_000_000, maxBuyFeeLamports: 1_000_000 }).perCopySolMedian, null);

  const live = (o: object) => parseLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 0.5, ...o } }));
  assert.equal(live({}).maxBuyFeeLamports, live({}).maxFeeLamports, "unset: a buy bids as before");
  assert.equal(live({ maxBuyFeeLamports: 300_000 }).maxBuyFeeLamports, 300_000);
  assert.equal(live({ maxBuyFeeLamports: 300_000 }).maxFeeLamports, 1_000_000, "sales keep their limit: getting out must not wait");
  assert.equal(live({ maxFeeLamports: 500_000, maxBuyFeeLamports: 9_000_000 }).maxBuyFeeLamports, 500_000, "never above the limit of every other transaction");
  assert.equal(live({ maxBuyFeeLamports: 1 }).maxBuyFeeLamports, 10_000);
  assert.equal(live({ maxBuyFeeLamports: "300000" }).maxBuyFeeLamports, 1_000_000, "a text is not a number: unchanged");
});

test("fees: read back from the chain once per copy, never while a coin is out, and a failed read is tried again", async () => {
  _test.reset();
  _test.ready();
  const st = _test.state();
  const old = Date.now() - 600_000;
  const fees: Record<string, number | null | "fail"> = { buy1: 1_005_000, sell1: 705_000, gone1: null, buy2: 505_000, sell2: "fail", buy3: 205_000 };
  const asked: string[] = [];
  run.setNet((async (_url: string, init?: { body?: string }) => {
    const { method, params } = JSON.parse(init!.body!) as { method: string; params: [string] };
    assert.equal(method, "getTransaction", "nothing but a read");
    asked.push(params[0]);
    const fee = fees[params[0]];
    if (fee === "fail") return new Response("busy", { status: 503 });
    return new Response(JSON.stringify({ result: fee === null ? null : { meta: { fee, preBalances: [], postBalances: [] }, transaction: { message: { accountKeys: [] } } } }));
  }) as never);
  try {
    st.rows.push({ ...blank(), t: old, sigs: ["buy2", "sell2"] }, { ...blank(), t: old + 1, sigs: ["buy1", "sell1", "gone1", "buy1"] }, { ...blank(), t: Date.now(), sigs: ["buy3"] }, { ...blank(), t: old + 2, buy: "not sent", sigs: [] });
    st.opens.push({ mint: MINT, t: Date.now(), tries: 0, sigs: [] });
    await readFees();
    assert.deepEqual(asked, [], "a coin is out: the line is left alone");
    st.opens.length = 0;
    await readFees();
    // newest first; the copy made a moment ago waits (its transactions may not be readable yet)
    assert.deepEqual(asked, ["buy1", "sell1", "gone1", "buy2", "sell2"]);
    const [second, first, recent] = st.rows;
    assert.deepEqual({ feeSol: first.feeSol, buyFeeSol: first.buyFeeSol, feeTx: first.feeTx }, { feeSol: 0.00171, buyFeeSol: 0.001005, feeTx: 2 }, "a transaction that never landed cost nothing");
    assert.equal(second.feeSol, undefined, "one of its transactions could not be read: nothing is written, it is read again later");
    assert.equal(recent.feeSol, undefined);
    fees.sell2 = 705_000;
    asked.length = 0;
    await readFees();
    assert.deepEqual(asked, ["buy2", "sell2"], "what is read is not asked again");
    assert.equal(second.feeSol, 0.00121);
  } finally {
    run.setNet(fetch);
    _test.reset();
  }
});
