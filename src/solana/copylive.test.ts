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
const { base58 } = await import("./whirlpool.js");
const { recoverMany, HARD_MAX_OPEN, solanaCopyLiveQuiet, solanaCopyLiveWaiting } = await import("./copylive.js");
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
const CFG: LiveConfig = { on: true, stakeSol: 0.05, maxLossSol: 0.5, holdSec: 60, targetPct: 10, maxPerDay: Number.MAX_SAFE_INTEGER, minGapPct: 0, maxOpen: 1, slippageBps: 1500, maxFeeLamports: 1_000_000 };
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
    assert.equal(log.quotes, 1);
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
      return json(i === SOLMINT ? { outAmount: "5000000000", inputMint: i, outputMint: o } : { outAmount: String(Math.round(worth(i) * 1e9)), inputMint: i, outputMint: o });
    }
    if (url.includes("/swap/v1/swap")) {
      const q = (JSON.parse(init!.body!) as { quoteResponse: { inputMint: string; outputMint: string; outAmount: string } }).quoteResponse;
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
