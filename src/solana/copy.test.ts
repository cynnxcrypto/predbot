import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "solcopy-"));
process.env.DATA_DIR = dir;
process.env.HELIUS_API_KEY = "SECRETHELIUS";
process.env.JUPITER_API_KEY = "SECRETJUP";

const { crowd, exitStudy, followerPrice, fomoStudy, GRID, lateStudy, parseBuy, parseDollarBuy, pathRet, ret, rising, roundTrip, sameBlockRet, SAME_BLOCK_SLIP, scalp, scalpCut, sizeStudy, STAKE_SOL, summarize, buySizeRatios, buySizeStudy, relGroup, trail, TX_SOL, traderRet, verdictAt, verdictOf, paceAt, gapAt, verdictsBefore, unrefuse, REFUSED_FROM, REFUSED_TO, unlate, LATE_FROM, LATE_CHECK_MS } = await import("./copy.js");
const { SOL, USDC } = await import("./pools.js");
const { validAddress, WALLETS } = await import("./wallets.js");
const { _test, buildCopySummary, onStreamBuy, scrub } = await import("./copyrun.js");
type Signal = import("./copy.js").Signal;

const W = WALLETS[0].address;
const MINT = "Mint1111111111111111111111111111111111111111";
const tok = (mint: string, owner: string, amt: number) => ({ mint, owner, uiTokenAmount: { uiAmountString: String(amt) } });
const tx = (o: Partial<{ pre: number; post: number; preTok: unknown[]; postTok: unknown[]; err: unknown }> = {}) => ({
  slot: 1000, blockTime: 1_800_000_000,
  meta: { err: o.err ?? null, fee: 5000, preBalances: [o.pre ?? 10e9, 0], postBalances: [o.post ?? 9e9, 0], preTokenBalances: o.preTok ?? [], postTokenBalances: o.postTok ?? [tok(MINT, W, 1_000_000)] },
  transaction: { message: { accountKeys: [{ pubkey: W }, { pubkey: "x" }] } },
}) as never;

test("all tracked wallets are valid addresses", () => {
  assert.ok(WALLETS.length >= 170);
  for (const w of WALLETS) assert.ok(validAddress(w.address), w.name);
  assert.equal(new Set(WALLETS.map((w) => w.address)).size, WALLETS.length);
  assert.ok(!validAddress("notanaddress"));
});

test("reads a buy: SOL out, one token in", () => {
  const b = parseBuy(tx(), W)!;
  assert.equal(b.mint, MINT);
  assert.ok(Math.abs(b.sol - (1 - 5000 / 1e9)) < 1e-9);
  assert.equal(b.tokens, 1_000_000);
  assert.equal(b.slot, 1000);
});

test("ignores sells, failed, tiny, token-to-token and other wallets' transactions", () => {
  assert.equal(parseBuy(tx({ err: {} }), W), null);
  assert.equal(parseBuy(tx({ pre: 9e9, post: 10e9, preTok: [tok(MINT, W, 5)], postTok: [tok(MINT, W, 0)] }), W), null);
  assert.equal(parseBuy(tx({ post: 10e9 - 1e7 }), W), null);
  assert.equal(parseBuy(tx({ preTok: [tok("Other", W, 9)], postTok: [tok("Other", W, 0), tok(MINT, W, 5)] }), W), null);
  assert.equal(parseBuy(tx({ postTok: [tok(MINT, "someoneelse", 5)] }), W), null);
  assert.equal(parseBuy(tx(), "nobody"), null);
  // paying with wrapped SOL counts as SOL
  const b = parseBuy(tx({ post: 10e9, preTok: [tok(SOL, W, 2)], postTok: [tok(SOL, W, 1.5), tok(MINT, W, 100)] }), W)!;
  assert.ok(Math.abs(b.sol - 0.5) < 1e-5);
});

/** A fomo-style buy: the relayer pays the fee, the wallet pays dollars and is named nowhere but as the owner of its balances. */
const F = "FomoTrader111111111111111111111111111111111";
const dollarTx = (o: Partial<{ usd: number; mint: string; preTok: unknown[]; postTok: unknown[]; err: unknown }> = {}) => ({
  slot: 2000, blockTime: 1_800_000_500,
  meta: {
    err: o.err ?? null, fee: 5000, preBalances: [10e9, 0], postBalances: [10e9 - 5000, 0],
    preTokenBalances: o.preTok ?? [tok(USDC, F, 5000)],
    postTokenBalances: o.postTok ?? [tok(USDC, F, 5000 - (o.usd ?? 800)), tok(o.mint ?? MINT, F, 400_000)],
  },
  transaction: { message: { accountKeys: [{ pubkey: "relayer" }, { pubkey: "atokenaccount" }] } },
}) as never;

test("fomo buys: paid in dollars, read by owner whoever signed", () => {
  const b = parseDollarBuy(dollarTx(), F, 160)!;
  assert.equal(b.mint, MINT);
  assert.equal(b.sol, 5); // $800 at $160 a SOL
  assert.equal(b.tokens, 400_000);
  assert.equal(b.price, 5 / 400_000);
  assert.equal(b.slot, 2000);
  assert.equal(parseBuy(dollarTx(), F), null, "the SOL parser cannot see it: the wallet is not even named");
  assert.equal(parseDollarBuy(dollarTx(), F, null), null, "no SOL price yet: no guess");
  assert.equal(parseDollarBuy(dollarTx({ usd: 5 }), F, 160), null, "tiny");
  assert.equal(parseDollarBuy(dollarTx({ err: {} }), F, 160), null);
  assert.equal(parseDollarBuy(dollarTx(), "someoneelse", 160), null);
  // a sale: coin out, dollars in
  assert.equal(parseDollarBuy(dollarTx({ preTok: [tok(USDC, F, 100), tok(MINT, F, 400_000)], postTok: [tok(USDC, F, 900), tok(MINT, F, 0)] }), F, 160), null);
  // dollars out and two coins in, or a coin swapped for a coin: not a plain buy
  assert.equal(parseDollarBuy(dollarTx({ postTok: [tok(USDC, F, 4200), tok(MINT, F, 5), tok("Other", F, 5)] }), F, 160), null);
  // dollars only (a transfer): nothing bought
  assert.equal(parseDollarBuy(dollarTx({ postTok: [tok(USDC, F, 4200)] }), F, 160), null);
});

const sig = (o: Partial<Signal> = {}): Signal => ({
  sig: "s", wallet: W, name: "Chairman", mint: MINT, leaderSlot: 1000, leaderTime: 1_800_000_000, leaderSol: 1, leaderPrice: 1e-6,
  seenMs: 1_800_000_001_000, knownMs: 1_800_000_001_500, lagSlots: 3, feed: "t",
  entries: { d0: { t: 0, slot: 1004, tokens: "1", price: 1.1e-6 }, d1: { t: 0, slot: 1007, tokens: "1", price: 1.2e-6 }, d3: null },
  exits: { d0: { x0: 0.24, x2: 0.26, x5: 0.27, x10: 0.25, x20: 0.2, x30: 0.2, x60: 0.15, x120: 0.1 }, d1: { x2: null, x5: 0.2, x120: 0.1 }, d3: {} },
  crowd: null, ...o,
});

/** A rule by id: among the reachable ones, the instant-price ones, or (no copy at all) the not-measured ids. */
const ruleOf = (sum: ReturnType<typeof summarize>, id: string) => {
  const hit = [...sum.rules, ...sum.rulesInstant].find((x) => x.id === id);
  if (hit) return hit;
  assert.ok(sum.notMeasured.includes(id), `no rule ${id}`);
  return { id, text: "", n: 0, won: 0, netSol: 0, netUsd: 0, medianRetPct: 0, avgRetPct: null as number | null };
};

test("returns: costs taken off, missing quotes handled honestly", () => {
  const s = sig();
  assert.ok(Math.abs(ret(s, 0, 5)! - ((0.27 - 2 * TX_SOL) / STAKE_SOL - 1)) < 1e-12);
  assert.equal(ret(s, 1, 2), undefined); // later quote exists: a failed request, left out
  assert.equal(ret(s, 3, 5), undefined); // never entered
  // the price service had no price from 5 s on, to the last check: could not be sold at all, a total loss
  const dead = sig({ exits: { d0: { x0: 0.24, x2: 0.2, x5: null, x10: null, x20: null, x30: null, x60: null, x120: null }, d1: {}, d3: {} } });
  assert.equal(ret(dead, 0, 30), -1);
  // the same checks never made, or their requests failed (keys absent): nothing was measured, so nothing is scored
  assert.equal(ret(sig({ exits: { d0: { x0: 0.24, x2: 0.2 }, d1: {}, d3: {} } }), 0, 30), undefined);
  assert.equal(ret(sig({ exits: { d0: { x0: 0.24, x2: 0.2, x30: null, x60: 0.2 }, d1: {}, d3: {} } }), 0, 30), undefined);
  assert.ok(Math.abs(roundTrip(s)! - (1 - (0.24 - 2 * TX_SOL) / STAKE_SOL)) < 1e-12);
});

test("scalp: first check at the target, else the time stop", () => {
  const s = sig();
  assert.equal(scalp(s, 0, 3), ret(s, 0, 2)); // +3.2% at 2 s
  assert.equal(scalp(s, 0, 5), ret(s, 0, 5)); // +7.2% at 5 s
  assert.equal(scalp(s, 0, 10), ret(s, 0, 60)); // never reached: out at 60 s
});

test("early cut: one timed look, a copy that is not up by then is sold", () => {
  const out = (pct: number) => STAKE_SOL * (1 + pct / 100) + 2 * TX_SOL; // the sale that gives this return after costs
  const path = (o: Record<string, number | null>) => sig({ exits: { d0: { x0: out(-2), ...o }, d1: {}, d3: {} } });
  // down at 5 s and never back: cut at 5 s instead of riding it to 60 s
  const down = path({ x2: out(-1), x5: out(-3), x10: out(-6), x20: out(-9), x30: out(-12), x60: out(-20), x120: out(-30) });
  assert.equal(scalpCut(down, 10, 5), ret(down, 0, 5));
  assert.equal(scalpCut(down, 10, 10), ret(down, 0, 10));
  assert.equal(scalpCut(down, 10, 20), ret(down, 0, 20));
  assert.equal(scalp(down, 0, 10), ret(down, 0, 60), "without the cut it rides to the time stop");
  // up at the look: nothing is cut, the target or the time stop decides
  const up = path({ x2: out(1), x5: out(4), x10: out(2), x20: out(-5), x30: out(12), x60: out(3), x120: out(0) });
  assert.equal(scalpCut(up, 10, 5), ret(up, 0, 30));
  assert.equal(scalpCut(up, 10, 20), ret(up, 0, 20), "down at the 20 s look: sold there, the later spike is missed");
  // the target comes first when it is reached before the look
  const fast = path({ x2: out(11), x5: out(-9), x10: out(-9), x20: out(-9), x30: out(-9), x60: out(-9), x120: out(-9) });
  assert.equal(scalpCut(fast, 10, 5), ret(fast, 0, 2));
  // a failed quote at the look is no cut; a coin that cannot be sold at all is a total loss
  const gap = path({ x2: out(-1), x5: null, x10: out(-4), x20: out(-4), x30: out(-4), x60: out(-7), x120: out(-9) });
  assert.equal(scalpCut(gap, 10, 5), ret(gap, 0, 60));
  assert.equal(scalpCut(sig({ exits: { d0: { x0: out(-2), x2: out(1), x5: null, x10: null, x20: null, x30: null, x60: null, x120: null }, d1: {}, d3: {} } }), 10, 5), -1);
});

test("late entries: followed from their own purchase, and compared only on buys priced at every entry time", () => {
  const out = (pct: number) => STAKE_SOL * (1 + pct / 100) + 2 * TX_SOL;
  const e = (price: number) => ({ t: 0, slot: 1010, tokens: "1", price });
  const flat = (pct: number) => ({ x2: out(pct), x5: out(pct), x10: out(pct), x20: out(pct), x30: out(pct), x60: out(pct), x120: out(pct) });
  // the price ran up during the wait: the late entry pays 8% more and is left holding the fall
  const ran = sig({
    entries: { d0: e(1e-6), d1: e(1e-6), d3: e(1e-6), d5: e(1.08e-6), d10: e(1.05e-6), d20: e(0.9e-6) },
    exits: { d0: { x0: out(-2), ...flat(4), x5: out(12) }, d1: flat(0), d3: flat(0), d5: flat(-6), d10: flat(-3), d20: { ...flat(2), x30: out(11) } },
  });
  assert.equal(scalp(ran, 5, 10), ret(ran, 5, 60));
  assert.equal(scalp(ran, 20, 10), ret(ran, 20, 30));
  assert.equal(rising(ran, 5, 10), ret(ran, 5, 60), "price was higher after 5 s: the rising rule buys");
  assert.equal(rising(ran, 10, 10), ret(ran, 10, 60));
  const fell = sig({ entries: { ...ran.entries, d5: e(0.97e-6) }, exits: ran.exits });
  assert.equal(rising(fell, 5, 10), undefined, "price was lower after 5 s: no trade");
  // an older signal has no late entries: it is in none of the late rules and not in the study
  const old = sig();
  assert.equal(scalp(old, 5, 10), undefined);
  assert.equal(rising(old, 5, 10), undefined);
  const sum = summarize([ran, old], 80);
  const rule = (id: string) => ruleOf(sum, id);
  assert.equal(rule("copy-d5-tp10-t60").n, 1);
  assert.equal(rule("copy-d20-x30").n, 1);
  assert.equal(rule("copy-d5-rising-tp10-t60").n, 1);
  assert.equal(rule("copy-d0-tp10-cut5-t60").n, 2);
  assert.ok(rule("copy-d0-tp10-cut10-t60").text.includes("sell at 10 s if it is not up"));
  const st = sum.lateStudy;
  assert.equal(st.n, 1);
  // the instant quote first (no order gets it), then 1 s later (where a real order lands), then the late times
  assert.deepEqual(st.entries.map((x) => x.sec), [0, 1, 5, 10, 20]);
  assert.deepEqual(st.entries.map((x) => x.reachable), [false, true, true, true, true]);
  assert.deepEqual(st.entries.map((x) => x.priceVsFastestPct), [0, 0, 8, 5, -10]);
  assert.deepEqual(st.entries.map((x) => x.won), [1, 0, 0, 0, 1]);
  assert.deepEqual(st.entries.map((x) => x.avgRetPct), [12, 0, -6, -3, 11]);
  assert.deepEqual(st.entries[4].holdOnly, { n: 1, won: 1, avgRetPct: 2 });
  // no late entry priced at all (as today): the study is at once against 1 s later, on every buy priced at both
  const two = lateStudy([old, old]);
  assert.deepEqual([two.n, two.entries.map((x) => x.sec)], [2, [0, 1]]);
  // a late time priced for under half of the buys is left out instead of shrinking the rows to its few buys
  assert.deepEqual(lateStudy([ran, old, old]).entries.map((x) => x.sec), [0, 1]);
});

test("realistic figures: every rule and wallet number is priced where a real order lands, the instant quote sits apart", () => {
  const out = (pct: number) => STAKE_SOL * (1 + pct / 100) + 2 * TX_SOL;
  const e = (price: number) => ({ t: 0, slot: 1010, tokens: "1", price });
  const flat = (pct: number) => ({ x2: out(pct), x5: out(pct), x10: out(pct), x20: out(pct), x30: out(pct), x60: out(pct), x120: out(pct) });
  // The hopium case: at the instant quote we are 2% above the wallet and the copy is up 12% throughout; a second
  // later the price is 10% higher and the same copy is 6% down throughout. Three such buys by one wallet.
  const one = (i: number) => sig({
    sig: `h${i}`, knownMs: 1_800_000_001_500 + i * 4 * 3_600_000,
    entries: { d0: e(1.02e-6), d1: e(1.122e-6), d3: null },
    exits: { d0: { x0: out(-2), ...flat(12) }, d1: flat(-6), d3: {} },
    path: { x1: out(12), x3: out(12), x15: out(12), x45: out(12), x90: out(12), x180: out(12), x300: out(3), x600: null },
    crowd: { same: 1, s10: 4, s25: 5, s150: 9, ahead: { d0: 1, d1: 6 } },
  });
  const sum = summarize([0, 1, 2].map(one), 80);
  const inst = (id: string) => sum.rulesInstant.find((x) => x.id === id)!;
  const real = (id: string) => sum.rules.find((x) => x.id === id)!;
  // the instant rule wins every copy and is not in the list the page ranks; its twin a second later loses them all
  assert.deepEqual([inst("copy-d0-gap3under-tp10-t60").n, inst("copy-d0-gap3under-tp10-t60").won, inst("copy-d0-gap3under-tp10-t60").avgRetPct], [3, 3, 12]);
  assert.equal(sum.rules.find((x) => x.id.startsWith("copy-d0-")), undefined);
  assert.deepEqual([real("copy-d1-gap3under-tp10-t60").n, real("copy-d1-gap3under-tp10-t60").won, real("copy-d1-gap3under-tp10-t60").avgRetPct], [3, 0, -6]);
  // the twin is decided on the instant quote (2% above the wallet: under the 3% bar) and only filled later;
  // a bar read on the later price (12% above) would not have bought
  assert.ok(real("copy-d1-gap3under-tp10-t60").text.includes("1 s after we know") && !real("copy-d1-gap3under-tp10-t60").text.includes("the moment we know"));
  for (const id of ["copy-d1-tp10-t60", "copy-d1-tp10-t30", "copy-d1-tp20-t60", "copy-d1-tp10-sl5-t60", "copy-d1-tp10-cut5-t60", "copy-d1-trader-new-tp10-t30", "copy-d1-calm-tp10-t30"]) {
    assert.deepEqual([real(id).n, real(id).won], [3, 0], id);
  }
  // nothing a real order could get is in profit, whatever the instant quote says
  assert.deepEqual([sum.inProfit, sum.qualified], [0, []]);
  assert.ok(sum.rulesInstant.filter((x) => (x.netSol ?? 0) > 0).length >= 20);
  // 5 min a second late: the instant copy's sale (up 3% by then) re-priced for the fewer tokens the later buy got
  // (1.02 / 1.122 of them), so down 6%; at 10 min there was no price and nothing after it: a total loss, as at once
  const sold = (out(3) * (1.02 / 1.122) - 2 * TX_SOL) / STAKE_SOL - 1;
  assert.ok(sold < -0.06 && pathRet(one(0), 300)! > 0.029);
  assert.ok(Math.abs(pathRet(one(0), 300, 1)! - sold) < 1e-12);
  assert.ok(Math.abs(pathRet(one(0), 60, 1)! - -0.06) < 1e-12, "its own check where it has one");
  assert.equal(pathRet(one(0), 600, 1), -1);
  assert.equal(pathRet(sig(), 300, 1), undefined, "no path: nothing invented");
  assert.equal(real("copy-d1-x300").n, 3);
  assert.ok(Math.abs(real("copy-d1-x300").avgRetPct! - Math.round(sold * 10000) / 100) < 0.011);
  assert.equal(scalpCut(one(0), 10, 5, 1), ret(one(0), 1, 5), "down at the 5 s look a second late: sold there");
  // the wallet row: what a buy a second later pays and meets, and the AVERAGE of its results; instant apart
  const w = sum.wallets[0];
  assert.deepEqual([w.priced, w.entryGapPct, w.aheadOfUs, w.ret5, w.ret30, w.ret120], [3, 12.2, 6, -6, -6, -6]);
  assert.deepEqual(w.instant, { entryGapPct: 2, aheadOfUs: 1, ret5: 12, ret30: 12, ret120: 12 });
  assert.deepEqual([w.copy.won, w.copyLate.won, w.copyLate.avgRetPct], [3, 0, -6]);
  // an average, not the middle value: two small wins and one big loss a second late read as a loss
  const mixed = [0, 1, 2].map((i) => ({ ...one(i), exits: { ...one(i).exits, d1: flat(i < 2 ? 3 : -60) } }));
  assert.equal(summarize(mixed, 80).wallets[0].ret30, -18);
  // the trade log and the "buy at once or wait" table say the same
  assert.deepEqual([sum.recent[0].ahead, sum.recent[0].entryGapPct], [6, 12.2]);
  assert.deepEqual(sum.lateStudy.entries.map((x) => [x.sec, x.reachable, x.avgRetPct]), [[0, false, 12], [1, true, -6]]);
  // the fomo traders' panel has the same copy a second late beside the instant one
  const fm = fomoStudy([0, 1, 2].map(one), 80).all.rules;
  assert.deepEqual([fm["copy-d0-tp10-t60"].avgRetPct, fm["copy-d1-tp10-t60"].avgRetPct, fm["copy-d1-x60"].won], [12, -6, 0]);
});

test("same-block what-if: the measured exit re-priced at the wallet's price plus slip", () => {
  const s = sig(); // we paid 1.1e-6, the wallet 1e-6
  const want = (0.27 * (1.1e-6 / (1e-6 * (1 + SAME_BLOCK_SLIP))) - 2 * TX_SOL) / STAKE_SOL - 1;
  assert.ok(Math.abs(sameBlockRet(s, 5)! - want) < 1e-12);
  assert.ok(sameBlockRet(s, 5)! > ret(s, 0, 5)!);
  assert.equal(summarize([s], 80).sameBlock.rules.length, 7);
  // with a measured follower price the what-if uses it instead of the assumption
  const m = sig({ near: { n: 3, price: 1.05e-6 } });
  assert.ok(Math.abs(sameBlockRet(m, 5)! - ((0.27 * (1.1e-6 / 1.05e-6) - 2 * TX_SOL) / STAKE_SOL - 1)) < 1e-12);
  const sm = summarize([m], 80).sameBlock;
  assert.equal(sm.measured, 1);
  assert.equal(sm.nearGapPctMedian, 5);
  // a follower's own buy gives the price at that spot in line
  assert.ok(Math.abs(followerPrice(tx({ post: 9.5e9, postTok: [tok(MINT, W, 400_000)] }), MINT)! - (0.5 - 5000 / 1e9) / 400_000) < 1e-15);
  assert.equal(followerPrice(tx(), "othermint"), null);
});

test("crowd: who lands before us", () => {
  const after = [1000, 1000, 1001, 1003, 1004, 1009, 1020, 1100, 1200].map((slot) => ({ slot, ok: true }));
  after.push({ slot: 1001, ok: false });
  const c = crowd(after, 1000, sig().entries);
  assert.deepEqual(c, { same: 2, s10: 6, s25: 7, s150: 8, ahead: { d0: 5, d1: 5 } });
});

test("summary: speed first, rules counted, wallets ranked by follow-through", () => {
  const a = sig({ crowd: { same: 2, s10: 6, s25: 7, s150: 8, ahead: { d0: 5, d1: 9 } } });
  const b = sig({ wallet: WALLETS[1].address, name: "gr3g", crowd: { same: 0, s10: 0, s25: 0, s150: 1, ahead: { d0: 0, d1: 0 } } });
  const sum = summarize([a, b], 80);
  assert.equal(sum.speed.buysSeen, 2);
  assert.equal(sum.speed.lagSecMedian, 1.5);
  // the line and the price are those of a buy 1 s after we know (where a real order lands); the instant ones sit apart
  assert.equal(sum.speed.aheadMedian, 4.5);
  assert.equal(sum.speed.firstInLinePct, 50);
  assert.equal(sum.speed.noWavePct, 50);
  assert.equal(sum.speed.entryGapPctMedian, 20);
  assert.deepEqual(sum.speed.instant, { aheadMedian: 2.5, firstInLinePct: 50, entryGapPctMedian: 10 });
  assert.ok(sum.speed.breakEvenPctMedian! > 4);
  // 135 rules in all: 55 at the instant quote, kept apart; of the 80 a real order could get, those with a copy are listed
  assert.equal(sum.rulesInstant.length, 55);
  assert.equal(sum.rules.length + sum.notMeasured.length, 80);
  assert.equal(sum.rulesTried, sum.rules.length);
  const ids = [...sum.rules.map((x) => x.id), ...sum.rulesInstant.map((x) => x.id), ...sum.notMeasured];
  assert.equal(new Set(ids).size, 135);
  assert.ok(sum.rulesInstant.every((x) => x.id.startsWith("copy-d0-")));
  assert.ok(sum.rules.every((x) => x.n > 0 && !x.id.startsWith("copy-d0-")) && sum.notMeasured.every((id) => !id.startsWith("copy-d0-")));
  assert.equal(sum.wallets[0].name, "Chairman");
  assert.deepEqual(sum.qualified, []);
});

test("9% buys under other exits: a look at 20 s, stops, and stricter gaps", () => {
  // our price is 10% above the wallet's; the copy is up 8% at 5 s, flat at 10 s, down 20% at 20 s and 40% at 60 s
  const s = sig();
  const rule = (list: Signal[], id: string) => ruleOf(summarize(list, 80), id);
  const at60 = rule([s], "copy-d0-gap9-tp10-t60");
  assert.deepEqual({ n: at60.n, won: at60.won }, { n: 1, won: 0 });
  assert.ok(at60.avgRetPct! < -39);
  // the look at 20 s and both stops sell at the 20 s check, half the loss of waiting for 60 s
  for (const id of ["copy-d0-gap9-tp10-cut20-t60", "copy-d0-gap9-tp10-sl10-t60", "copy-d0-gap9-tp10-sl20-t60"]) {
    const r = rule([s], id);
    assert.equal(r.n, 1, id);
    assert.ok(r.avgRetPct! < -19 && r.avgRetPct! > -21, id);
  }
  // a 10% gap is not in the stricter bands; a 16% gap is in both, a 13% gap only in the first
  assert.equal(rule([s], "copy-d0-gap12-tp10-t60").n, 0);
  const far = (price: number) => sig({ entries: { ...s.entries, d0: { ...s.entries.d0!, price } } });
  assert.deepEqual([rule([far(1.16e-6)], "copy-d0-gap12-tp10-t60").n, rule([far(1.16e-6)], "copy-d0-gap15-tp10-t60").n], [1, 1]);
  assert.deepEqual([rule([far(1.13e-6)], "copy-d0-gap12-tp10-t60").n, rule([far(1.13e-6)], "copy-d0-gap15-tp10-t60").n], [1, 0]);
  // the 9-15% band on its own, the 15% bar on the 30 s clock, and the 30% bar
  const ids = ["copy-d0-gap9to15-tp10-t60", "copy-d0-gap15-tp10-t30", "copy-d0-gap30-tp10-t60"];
  assert.deepEqual(ids.map((id) => rule([s], id).n), [1, 0, 0]);
  assert.deepEqual(ids.map((id) => rule([far(1.13e-6)], id).n), [1, 0, 0]);
  assert.deepEqual(ids.map((id) => rule([far(1.16e-6)], id).n), [0, 1, 0]);
  assert.deepEqual(ids.map((id) => rule([far(1.31e-6)], id).n), [0, 1, 1]);
  // the 15% bar with a stop and with the 20 s clock: only buys 15% or more above the wallet
  const more = ["copy-d0-gap15-tp10-sl10-t60", "copy-d0-gap15-tp10-sl20-t60", "copy-d0-gap15-tp10-t20"];
  assert.deepEqual(more.map((id) => rule([far(1.13e-6)], id).n), [0, 0, 0]);
  assert.deepEqual(more.map((id) => rule([far(1.16e-6)], id).n), [1, 1, 1]);
  // a buy under 9% is in none of them
  assert.equal(rule([far(1.05e-6)], "copy-d0-gap9-tp10-cut20-t60").n, 0);
});

test("exit study: long path, trailing exit, and nothing invented for times never checked", () => {
  const cost = 2 * TX_SOL;
  const pct = (out: number) => (out - cost) / STAKE_SOL - 1;
  // an older signal has no long checks: they cannot be scored, the short ones can
  const old = sig();
  assert.equal(pathRet(old, 300), undefined);
  assert.ok(Math.abs(pathRet(old, 30)! - pct(0.2)) < 1e-12);
  assert.equal(trail(old, 90), undefined, "never fell 90 points from its best and was not followed to 10 min");
  assert.ok(Math.abs(trail(old, 5)! - pct(0.25)) < 1e-12, "best at 5 s (0.27), 5 points lower at 10 s: sold there");
  // a new signal with the whole path: pumps, fades, recovers
  const full = sig({ exits: { d0: { x0: 0.24, x2: 0.26, x5: 0.3, x10: 0.31, x20: 0.3, x30: 0.29, x60: 0.28, x120: 0.27 }, d1: {}, d3: {} }, path: { x1: 0.25, x3: 0.27, x15: 0.305, x45: 0.28, x90: 0.275, x180: 0.255, x300: 0.33, x600: 0.2 }, crowd: { same: 1, s10: 9, s25: 9, s150: 9, ahead: { d0: 2 } } });
  assert.ok(Math.abs(pathRet(full, 300)! - pct(0.33)) < 1e-12);
  assert.ok(Math.abs(trail(full, 10)! - pct(0.28)) < 1e-12, "best 0.31 at 10 s; first check 10 points below it is 45 s");
  assert.ok(Math.abs(trail(full, 20)! - pct(0.255)) < 1e-12);
  // a token that stopped being sellable: total loss from the first dead check on
  const dead = sig({ exits: { d0: { x0: 0.24, x2: 0.26, x5: null, x10: null, x20: null, x30: null, x60: null, x120: null }, d1: {}, d3: {} }, path: { x1: 0.25, x3: 0.2, x15: null, x45: null, x90: null, x180: null, x300: null, x600: null } });
  assert.equal(pathRet(dead, 60), -1);
  assert.equal(trail(dead, 20), pathRet(dead, 3), "already 20 points under its best at 3 s");
  const st = exitStudy([old, full, dead]);
  assert.equal(st.n, 3);
  assert.equal(st.path.length, GRID.length);
  assert.deepEqual(st.path.find((c) => c.sec === 600), { sec: 600, n: 2, won: 0, medianRetPct: st.path.find((c) => c.sec === 600)!.medianRetPct, avgRetPct: st.path.find((c) => c.sec === 600)!.avgRetPct });
  assert.equal(st.path.find((c) => c.sec === 2)!.n, 3);
  assert.equal(st.best.n, 3);
  assert.equal(st.byWave[0].n + st.byWave[1].n, 1, "only signals with a counted wave are split by wave");
  assert.deepEqual(st.byStart.map((g) => g.n), [1, 1, 1], "dead token down, old signal up moderately, full one up strongly");
});

test("size check: the same copies at four stakes, compared like with like", () => {
  const exits = { d0: { x0: 0.24, x2: 0.26, x5: 0.3, x10: 0.26, x20: 0.3, x30: 0.27, x60: 0.25, x120: 0.27 }, d1: {}, d3: {} };
  const sized = sig({ exits, sizes: { "0.05": { x0: 0.0485, x10: 0.053, x30: 0.055, x60: 0.051 }, "1": { x0: 0.9, x10: 0.98, x30: 1.02, x60: 0.95 }, "3": { x0: 2.1, x10: 2.4, x30: 2.5, x60: null } } });
  const st = sizeStudy([sized, sig()]); // the second signal has no size check: left out of every row
  assert.equal(st.n, 1);
  assert.deepEqual(st.sizes.map((x) => x.sol), [0.05, 0.25, 1, 3]);
  const by = (sol: number) => st.sizes.find((x) => x.sol === sol)!;
  // buying and selling straight back costs more the bigger the stake
  assert.deepEqual(st.sizes.map((x) => x.inAndOutCostPct), [3.2, 4.04, 10.01, 30]);
  assert.deepEqual(by(1).holds.map((h) => [h.sec, h.won, h.avgRetPct]), [[10, 0, -2.01], [30, 1, 1.99], [60, 0, -5.01]]);
  assert.equal(by(1).holds[1].avgSolPerTrade, 0.0199);
  assert.equal(by(0.25).holds[1].avgRetPct, 7.96, "the standard stake comes from the normal checks, with the same fee");
  assert.equal(by(3).holds[2].n, 0, "no quote at 60 s for 3 SOL: left out, not counted as a loss");
});

test("runner: a buy becomes a scored signal, and keys never leak", async () => {
  assert.ok(!scrub("fail https://mainnet.helius-rpc.com/?api-key=SECRETHELIUS x SECRETJUP").includes("SECRET"));
  const realSet = globalThis.setTimeout;
  // run timers at once so the 2 minute schedule finishes in the test
  (globalThis as { setTimeout: unknown }).setTimeout = ((f: () => void) => realSet(f, 0)) as never;
  try {
    let quotes = 0;
    _test.setSlot(1003);
    _test.setNet((async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
      if (String(url).includes("/swap/v1/quote")) {
        assert.equal(init?.headers?.["x-api-key"], "SECRETJUP");
        quotes++;
        const buying = String(url).includes(`inputMint=${SOL}`);
        return new Response(JSON.stringify({ outAmount: buying ? "1000000000" : "240000000" }));
      }
      const { method } = JSON.parse(init!.body!) as { method: string };
      const result = method === "getTransaction" ? tx() : method === "getTokenSupply" ? { value: { decimals: 6 } } : [{ signature: "f1", slot: 1001, err: null }, { signature: "f0", slot: 1000, err: null }];
      return new Response(JSON.stringify({ result }));
    }) as never);
    await _test.onTx(WALLETS[0], "sigA", Date.now());
    await _test.onTx(WALLETS[0], "sigA", Date.now()); // same signature again: ignored
    await _test.onTx(WALLETS[0], "sigB", Date.now()); // same wallet and token within 30 min: ignored
    const s = _test.signals();
    assert.equal(s.length, 1);
    assert.equal(s[0].lagSlots, 3);
    assert.equal(s[0].entries.d0!.price, STAKE_SOL / 1000);
    assert.equal(s[0].exits.d0.x0, 0.24);
    assert.equal(s[0].exits.d1.x120, 0.24);
    assert.deepEqual(s[0].crowd, { same: 1, s10: 2, s25: 2, s150: 2, ahead: { d0: 2, d1: 2 } }, "the late entries (3, 5, 10, 20 s) are no longer measured");
    assert.equal(s[0].entries.d20, undefined);
    assert.equal(s[0].entries.d3, undefined);
    assert.equal(s[0].exits.d1.x60, 0.24);
    assert.equal(s[0].exits.d1.x0, undefined, "only the fastest entry is priced for an instant round trip");
    assert.equal(s[0].onTime, true, "marked: no check of this buy was taken late");
    // 2 entries, 7 exits each, the instant round trip, the 5 extra early checks of the exit study; its 3 long
    // checks follow after the signal is saved; plus the size check: one other stake, a buy quote and 4 sale quotes.
    // 29 with the long checks, where a buy took 72 before 12 Nov 2026: the real test shares the price service's limit.
    assert.ok(quotes >= 2 + 2 * 7 + 1 + 5 + 5 && quotes <= 2 + 2 * 7 + 1 + 8 + 5, `${quotes} price requests`);
    assert.deepEqual(Object.keys(s[0].sizes!).sort(), ["0.05"], "of the other stakes only the real test's own is still measured");
    assert.deepEqual(s[0].sizes!["0.05"], { x0: 0.24, x10: 0.24, x30: 0.24, x60: 0.24 });
    assert.equal(s[0].path!.x1, 0.24);
    assert.equal(s[0].path!.x90, 0.24);
    void 0;
    // the transaction stream hands over a whole transaction: no lookup, and the signal is marked with that feed
    const t2 = tx({ postTok: [tok("Mint2222222222222222222222222222222222222222", W, 5)] });
    await _test.onTx(WALLETS[0], "sigC", Date.now(), t2);
    assert.equal(_test.signals().length, 2);
    assert.equal(_test.signals()[1].feed, "helius transaction stream");
    const sum = buildCopySummary();
    assert.equal(sum.mode, "paper");
    assert.equal(sum.speed.buysSeen, 1); // only the stream buy is scored; the non-Helius one is left out
    assert.equal(sum.byFeed[0].feed, "helius transaction stream");
    assert.equal(sum.leftOut, 1);
    // a fomo trader's own buy: taken from the stream, kept apart from the listed wallets, never offered to the real test
    let offered = 0;
    onStreamBuy(() => offered++);
    const fomo = { name: "fomo frankdegods", address: F, found: true, fomo: true };
    _test.setSolUsd(null);
    await _test.onTx(fomo, "sigF0", Date.now(), dollarTx());
    assert.equal(_test.signals().length, 2, "without a SOL price a dollar buy is not guessed at");
    _test.setSolUsd(160);
    await _test.onTx(fomo, "sigF", Date.now(), dollarTx({ mint: "Mint3333333333333333333333333333333333333333" }));
    onStreamBuy(null);
    assert.equal(offered, 0);
    const f = _test.signals()[2];
    assert.deepEqual({ fomo: f.fomo, name: f.name, leaderSol: f.leaderSol, feed: f.feed }, { fomo: true, name: "fomo frankdegods", leaderSol: 5, feed: "helius transaction stream" });
    const after = buildCopySummary();
    assert.equal(after.speed.buysSeen, 1, "the listed wallets' numbers do not move");
    assert.equal(after.leftOut, 1);
    assert.equal(after.fomo.n, 1);
    assert.equal(after.fomo.traders[0].name, "fomo frankdegods");
    assert.equal(after.fomo.all.rules["copy-d0-tp10-t60"].n, 1);
    assert.equal(after.fomo.all.rules["copy-d0-x60"].n, 1);
    assert.equal(after.fomo.recent[0].leaderSol, 5);
    assert.equal(fomoStudy([], 160).n, 0);
    const files = readFileSync(join(dir, "solana", "copy-signals.jsonl"), "utf8") + readFileSync(join(dir, "solana-copy-summary.json"), "utf8");
    assert.ok(!files.includes("SECRET"));
  } finally {
    globalThis.setTimeout = realSet;
  }
});

test("traders: a verdict from the earlier copies only, and rules that never see their own result", () => {
  assert.equal(verdictOf([0.1, 0.1, 0.1]), "new");
  assert.equal(verdictOf([0.1, 0.1, -0.05, -0.05]), "good", "made money on average and half won");
  assert.equal(verdictOf([-0.1, -0.1, -0.1, 0.05]), "bad");
  assert.equal(verdictOf([0.5, -0.1, -0.1, -0.1]), "mixed", "one big winner is not a good trader");
  assert.equal(verdictOf([-0.3, 0.05, 0.05, -0.3]), "mixed", "half won but it lost on average");
  const t0 = 1_800_000_000_000;
  // the sample buy never reaches +10% and is 20.8% down at 30 s; the other is up 19.2% at the first look
  const lose = (i: number, wallet = W) => sig({ sig: `l${wallet}${i}`, wallet, knownMs: t0 + i * 60_000 });
  const win = (i: number, wallet: string) => sig({ sig: `w${wallet}${i}`, wallet, name: "Other", knownMs: t0 + i * 60_000 + 1000, exits: { d0: { x0: 0.24, x2: 0.3, x5: 0.3, x10: 0.3, x20: 0.3, x30: 0.3, x60: 0.3, x120: 0.3 }, d1: {}, d3: {} } });
  assert.ok(traderRet(lose(0))! < -0.2 && traderRet(win(0, "o"))! > 0.19);
  const bad = [0, 1, 2, 3, 4].map((i) => lose(i));
  // four losing copies, then a fifth buy: the trader is judged bad from the fifth on, never earlier
  const before = verdictsBefore(bad);
  assert.deepEqual(bad.map((x) => before.get(x)), ["new", "new", "new", "new", "bad"]);
  // a copy bought under 30 s ago has no result yet; another trader's copies never count
  assert.equal(verdictAt(bad.slice(0, 4), W, bad[3].knownMs + 29_000), "new");
  assert.equal(verdictAt(bad.slice(0, 4), W, bad[3].knownMs + 30_000), "bad");
  assert.equal(verdictAt(bad, "someone else", t0 + 3_600_000), "new");
  // two traders: one loses five times, one wins five times; the rules split their fifth buys by the earlier four
  const good = [0, 1, 2, 3, 4].map((i) => win(i, "o"));
  const sum = summarize([...bad, ...good], 80);
  const rule = (id: string) => ruleOf(sum, id);
  assert.deepEqual([rule("copy-d0-tp10-t30").n, rule("copy-d0-trader-new-tp10-t30").n, rule("copy-d0-trader-bad-tp10-t30").n, rule("copy-d0-trader-good-tp10-t30").n, rule("copy-d0-trader-mixed-tp10-t30").n], [10, 8, 1, 1, 0]);
  assert.deepEqual([rule("copy-d0-trader-bad-tp10-t30").won, rule("copy-d0-trader-good-tp10-t30").won], [0, 1]);
  assert.deepEqual([rule("copy-d0-trader-notbad-tp10-t30").n, rule("copy-d0-trader-notbad-tp10-t30").won], [9, 5]);
  // pace: a trader's third buy inside three hours is still calm, the fourth and later are busy; buys older than three
  // hours no longer count, and another trader's buys never do
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => paceAt(bad.slice(0, i), W, bad[i].knownMs)), ["calm", "calm", "calm", "busy", "busy"]);
  assert.equal(paceAt(bad, W, bad[4].knownMs + 3 * 3600_000 + 1), "calm");
  assert.equal(paceAt(bad, "someone else", bad[4].knownMs + 1), "calm");
  assert.deepEqual([rule("copy-d0-calm-tp10-t30").n, rule("copy-d0-busy-tp10-t30").n, rule("copy-d0-busy-tp10-t30").won], [6, 4, 2]);
  assert.deepEqual([rule("copy-d0-gap15-calm-tp10-t30").n, rule("copy-d0-gap15-busy-tp10-t30").n], [0, 0]);
  // the bar read a second later: the sample buy is 10% above the wallet at once and 20% above a second later; it was
  // never priced three seconds later. Bought a second later and up 19% at the first look: one copy, won
  assert.deepEqual([gapAt(bad[0], 0), gapAt(bad[0], 1), gapAt(bad[0], 3)].map((v) => (v === null ? null : Math.round(v * 100))), [10, 20, null]);
  const late = summarize([sig({ sig: "late", wallet: "late", exits: { d0: {}, d1: { x2: 0.3, x5: 0.3, x10: 0.3, x20: 0.3, x30: 0.3, x60: 0.3, x120: 0.3 }, d3: {} } })], 80);
  assert.deepEqual(["copy-d1-gapthen15-tp10-t30", "copy-d3-gapthen15-tp10-t30"].map((id) => [ruleOf(late, id).n, ruleOf(late, id).won]), [[1, 1], [0, 0]]);
  // not the same rule as the 15% bar read at once and filled a second later: at once that buy is only 10% above
  assert.equal(ruleOf(late, "copy-d1-gap15-tp10-t30").n, 0);
  // with the 15% bar: the sample buys are 10% above the wallet, so none passes; at 16% above they split the same way
  assert.equal(rule("copy-d0-gap15-trader-notbad-tp10-t30").n, 0);
  const far = (x: Signal): Signal => ({ ...x, entries: { ...x.entries, d0: { ...x.entries.d0!, price: 1.16e-6 } } });
  const sum2 = summarize([...bad, ...good].map(far), 80);
  const rule2 = (id: string) => ruleOf(sum2, id);
  assert.deepEqual([rule2("copy-d0-gap15-trader-notbad-tp10-t30").n, rule2("copy-d0-gap15-trader-bad-tp10-t30").n, rule2("copy-d0-gap15-trader-good-tp10-t30").n], [9, 1, 1]);
  // the status: each trader's record and verdict today, and how many of each kind
  const w = (name: string) => sum.wallets.find((x) => x.name === name)!;
  assert.deepEqual([w("Chairman").verdict, w("Chairman").copy.n, w("Chairman").copy.won, w("Other").verdict, w("Other").copy.won], ["bad", 5, 0, "good", 5]);
  assert.deepEqual({ seen: sum.traders.seen, good: sum.traders.good, bad: sum.traders.bad, mixed: sum.traders.mixed, new: sum.traders.new, min: sum.traders.min }, { seen: 2, good: 1, bad: 1, mixed: 0, new: 0, min: 4 });
});


test("the real test first: paper quotes wait while the real test is buying and after a refusal, except a buy's fastest entry", async () => {
  const { realFirst, PAPER_RETRIES, PAPER_GAP_MS } = await import("./copyrun.js");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let status = 200;
  let calls = 0;
  _test.setNet((async () => {
    calls++;
    return new Response(JSON.stringify(status === 200 ? { outAmount: "1000" } : { error: "Too many requests" }), { status });
  }) as unknown as typeof fetch);
  try {
    // the line is empty (the checks of the buys above are through) and nothing was asked in the last PAPER_GAP_MS:
    // answered at once
    for (let quiet = 0, last = -1; quiet < 2; ) {
      // checks of the buys in the tests above may still be coming: wait until none has gone out for a moment
      await _test.lane();
      await sleep(PAPER_GAP_MS + 30);
      if (calls === last) quiet++;
      else [quiet, last] = [0, calls];
    }
    let t = Date.now();
    assert.equal(await _test.quote(SOL, MINT, "1"), 1000n);
    assert.ok(Date.now() - t < 150);
    // the real test is buying: a paper check waits for it, the fastest entry of a buy does not
    realFirst(300);
    t = Date.now();
    assert.equal(await _test.quote(SOL, MINT, "1", true), 1000n);
    assert.ok(Date.now() - t < 150, "the fastest entry is not held");
    assert.equal(await _test.quote(SOL, MINT, "1"), 1000n);
    assert.ok(Date.now() - t >= 250, "a check waits until the real test is through");
    const held = _test.health().quoteHeld;
    assert.ok(held >= 1);
    // refused once for asking too fast: counted, the paper test stands back, and the same quote is asked again
    let refuse = 1;
    _test.setNet((async () => {
      calls++;
      if (refuse-- > 0) return new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 });
      return new Response(JSON.stringify({ outAmount: "1000" }));
    }) as unknown as typeof fetch);
    const before = { ..._test.health() };
    t = Date.now();
    let n = calls;
    assert.equal(await _test.quote(SOL, MINT, "1"), 1000n);
    assert.ok(Date.now() - t >= 1200 && calls === n + 2, "asked again after standing back");
    assert.equal(_test.health().quoteRefused, before.quoteRefused + 1);
    // refused every time: given up after the retries, and that is "not measured" (undefined), never "no price"
    refuse = 99;
    n = calls;
    assert.equal(await _test.quote(SOL, MINT, "1"), undefined);
    assert.equal(calls, n + 1 + PAPER_RETRIES);
    assert.equal(_test.health().quoteLost, before.quoteLost + 1);
    // the price service answers that it has no route: that is "no price" (null), at once
    _test.setNet((async () => (calls++, new Response(JSON.stringify({ error: "no route" }), { status: 400 }))) as unknown as typeof fetch);
    n = calls;
    assert.equal(await _test.quote(SOL, MINT, "1"), null);
    assert.equal(calls, n + 1);
    // a server error or a time-out is not an answer either
    _test.setNet((async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch);
    assert.equal(await _test.quote(SOL, MINT, "1"), undefined);
    // a burst: ten quotes asked in the same instant leave one after the other, PAPER_GAP_MS apart
    const at: number[] = [];
    _test.setNet((async () => (at.push(Date.now()), new Response(JSON.stringify({ outAmount: "1000" })))) as unknown as typeof fetch);
    await sleep(1600); // past the last stand-back
    await Promise.all(Array.from({ length: 10 }, () => _test.quote(SOL, MINT, "1")));
    assert.ok(at[9] - at[0] >= 9 * PAPER_GAP_MS - 20, `spread over ${at[9] - at[0]} ms`);
    // more than the line can send on time: a check whose turn would come later than LATE_CHECK_MS is not sent at
    // all and counts as not measured, so nothing taken late is ever written down as the price of its moment
    await sleep(PAPER_GAP_MS + 30);
    at.length = 0;
    const late0 = _test.health().quoteLate;
    t = Date.now();
    const got = await Promise.all(Array.from({ length: 16 }, () => _test.quote(SOL, MINT, "1")));
    const sent = got.filter((x) => x === 1000n).length;
    const fit = Math.floor(LATE_CHECK_MS / PAPER_GAP_MS) + 1;
    assert.ok(sent >= fit - 2 && sent <= fit, `${sent} of 16 sent`);
    assert.deepEqual(got.slice(sent), Array.from({ length: 16 - sent }, () => undefined), "the last in line are the ones left out");
    assert.equal(at.length, sent, "a late check is never asked of the price service");
    assert.equal(_test.health().quoteLate, late0 + 16 - sent);
    assert.ok(Date.now() - t < LATE_CHECK_MS + 300, "and the line is empty again at once");
    // an entry has less time: asked with a limit already used up, it is left out even with the line empty
    await sleep(PAPER_GAP_MS + 30);
    assert.equal(await _test.quote(SOL, MINT, "1", false, -1), undefined);
    assert.equal(await _test.quote(SOL, MINT, "1", false, 500), 1000n);
  } finally {
    _test.setNet(fetch);
  }
});

test("refused checks: in the 80 minutes when refusals were written down as 'no price', a missing price proves nothing", () => {
  const dead = () => ({ d0: { x0: 0.24, x2: 0.2, x5: null, x10: null, x20: null, x30: null, x60: null, x120: null }, d1: {}, d3: {} });
  const more = () => ({ path: { x1: 0.2, x180: null }, sizes: { "0.05": { x10: 0.049, x30: null } } });
  // known inside that time: the missing prices are taken out, so the copy cannot be scored instead of being a total loss
  const inside = unrefuse(sig({ knownMs: REFUSED_FROM + 60_000, exits: dead(), ...more() }));
  assert.equal(ret(inside, 0, 30), undefined);
  assert.equal(ret(inside, 0, 2)! < 0, true, "what was measured stays");
  assert.deepEqual([inside.exits.d0, inside.path, inside.sizes], [{ x0: 0.24, x2: 0.2 }, { x1: 0.2 }, { "0.05": { x10: 0.049 } }]);
  // known before or after it: a token the price service had no price for is still a total loss
  for (const knownMs of [REFUSED_FROM - 1, REFUSED_TO, REFUSED_TO + 3_600_000]) {
    const s = unrefuse(sig({ knownMs, exits: dead(), ...more() }));
    assert.equal(ret(s, 0, 30), -1);
    assert.equal(s.path!.x180, null);
  }
  assert.equal(new Date(REFUSED_FROM).toISOString(), "2026-11-11T15:23:26.000Z");
  assert.equal(new Date(REFUSED_TO).toISOString(), "2026-11-11T16:45:28.000Z");
});

test("late checks: a check proven to have left the line seconds late is taken out, the rest stays", () => {
  const T = LATE_FROM + 600_000;
  const e = (t: number) => ({ t, slot: 1, tokens: "1", price: 1.1e-6 });
  const full = () => ({ x0: 0.24, x2: 0.26, x5: 0.27, x10: 0.25, x20: 0.2, x30: 0.2, x60: 0.15, x120: 0.1 });
  // A: its entry 1 s late was asked at T+1 s and answered 40 s later: the line was 40 s long then
  const a = sig({ sig: "a", knownMs: T, entries: { d0: e(T + 50), d1: e(T + 41_000), d3: null }, exits: { d0: full(), d1: { x2: 0.2, x30: 0.2 }, d3: {} }, path: { x1: 0.25, x45: 0.2, x90: 0.2 }, sizes: { "0.05": { x0: 0.048, x10: 0.049, x30: 0.05, x60: 0.05 } } });
  // B: known 20 s after A, in the same jam: its checks asked up to T+38 s left after T+41 s, proven 3 s late or more
  const b = sig({ sig: "b", knownMs: T + 20_000, entries: { d0: e(T + 20_050), d1: null, d3: null }, exits: { d0: full(), d1: {}, d3: {} }, path: { x1: 0.25, x15: 0.2, x45: 0.2 } });
  // C: ten minutes later, entries answered on time
  const c = sig({ sig: "c", knownMs: T + 600_000, entries: { d0: e(T + 600_050), d1: e(T + 601_100), d3: null }, exits: { d0: full(), d1: { x2: 0.2 }, d3: {} }, path: { x1: 0.25 } });
  // D: in the jam as B, but measured by the runner that leaves late checks out: never touched
  const d = sig({ sig: "d", knownMs: T + 20_000, onTime: true, entries: { d0: e(T + 20_050), d1: null, d3: null }, exits: { d0: full(), d1: {}, d3: {} } });
  // E: before the line existed (same times, a day earlier): never touched
  const day = 86_400_000;
  const old = sig({ sig: "e", knownMs: T - day, entries: { d0: e(T - day + 50), d1: e(T - day + 41_000), d3: null }, exits: { d0: full(), d1: { x2: 0.2 }, d3: {} } });
  const done = unlate([a, b, c, d, old]);
  // A: the late entry goes with its checks; its own fastest checks asked from T+1 s on are behind that entry in line
  assert.equal(a.entries.d1, undefined);
  assert.equal(a.exits.d1, undefined);
  assert.deepEqual(Object.keys(a.exits.d0), ["x0", "x60", "x120"], "x0 was asked before the jam is proven; x60 and x120 after it had cleared");
  assert.deepEqual(a.path, { x45: 0.2, x90: 0.2 });
  assert.deepEqual(a.sizes, { "0.05": { x0: 0.048, x60: 0.05 } });
  // B: checks asked before T+38 s go, later ones stay (x20 was asked at T+40.05 s: under a second behind at most)
  assert.deepEqual(Object.keys(b.exits.d0), ["x20", "x30", "x60", "x120"]);
  assert.deepEqual(b.path, { x45: 0.2 });
  assert.equal(ret(b, 0, 10), undefined, "a check taken out cannot be scored");
  assert.ok(ret(b, 0, 30) !== undefined);
  // C, D, E untouched
  assert.deepEqual([Object.keys(c.exits.d0).length, c.exits.d1, c.path], [8, { x2: 0.2 }, { x1: 0.25 }]);
  assert.equal(Object.keys(d.exits.d0).length, 8);
  assert.deepEqual([Object.keys(old.exits.d0).length, old.entries.d1 !== undefined], [8, true]);
  assert.deepEqual(done, { signals: 2, entries: 1, checks: 5 + 1 + 2 + 4 + 2 });
  assert.equal(new Date(LATE_FROM).toISOString(), "2026-11-11T18:10:25.000Z");
});

test("other readings of the stored buys: hour of the day, repeat buyers, and selling into the next buyer's wave", async () => {
  const { hourStudy, repeatStudy, secondWaveStudy } = await import("./copy.js");
  const T = Date.UTC(2026, 10, 11, 10, 30, 0); // 19:30 KST
  const e = (tokens: string) => ({ t: 0, slot: 1, tokens, price: 1.05e-6 });
  const flat = (v: number) => ({ x0: 0.24, x2: v, x5: v, x10: v, x20: v, x30: v, x60: v, x120: v });
  // A: wallet a buys coin M; 200 s later wallet b buys it too (B); C is another coin, four hours later
  const a = sig({ sig: "A", wallet: "a", mint: "M", knownMs: T, entries: { d0: e("1000"), d1: e("1000"), d3: null }, exits: { d0: flat(0.2), d1: { x2: 0.2, x5: 0.2, x10: 0.2, x20: 0.2, x30: 0.2, x60: 0.2, x120: 0.2 }, d3: {} }, path: { x300: 0.18, x600: 0.15 } });
  const b = sig({ sig: "B", wallet: "b", mint: "M", knownMs: T + 200_000, entries: { d0: e("1000"), d1: null, d3: null }, exits: { d0: { ...flat(0.25), x2: 0.3, x5: 0.28 }, d1: {}, d3: {} }, path: { x300: 0.2, x600: 0.2 } });
  const c = sig({ sig: "C", wallet: "a", mint: "N", knownMs: T + 4 * 3_600_000, entries: { d0: e("1000"), d1: null, d3: null }, exits: { d0: flat(0.3), d1: {}, d3: {} } });
  const h = hourStudy([a, b, c]);
  assert.equal(h.rows.length, 8);
  assert.deepEqual(h.rows.filter((x) => x.buys).map((x) => [x.kst, x.buys, x.days, x.t60.n, x.late1t60.n]), [["18-21", 2, 1, 2, 1], ["21-24", 1, 1, 1, 0]]);
  assert.ok(h.rows.find((x) => x.kst === "18-21")!.late1t60.avgRetPct! < -20, "bought 1 s late and sold for 0.2 of 0.25");
  const rep = repeatStudy([c, b, a]);
  assert.deepEqual(rep.rows.map((x) => [x.buyer, x.buys]), [["first", 2], ["second", 1], ["third or later", 0]]);
  const w = secondWaveStudy([a, b, c]);
  const row = (sec: number, end: number, buyers: string) => w.rows.find((x) => x.entrySec === sec && x.endSec === end && x.buyers === buyers)!;
  assert.equal(w.rows.length, 2 * 2 * 6);
  // bought 2 min after A at 0.2 per 1000 (in-and-out cost 4.8%), sold 2 s after B's buy at 0.3 per 1000; A was the
  // coin's first listed buyer
  assert.deepEqual([row(120, 600, "1").all.n, row(120, 600, "1").withNext.n, row(120, 600, "1").nextPct, row(120, 600, "1").waitSecMedian], [1, 1, 100, 80]);
  assert.equal(row(120, 600, "1").withNext.avgRetPct, 42.8);
  assert.equal(row(120, 600, "1").withNextAt5.avgRetPct, 33.28);
  // B is the coin's second listed buyer and nobody follows: held to 10 min, 0.25 -> 0.2 less the cost
  assert.deepEqual([row(120, 600, "2").all.n, row(120, 600, "2").noNext.n, row(120, 600, "2").noNext.avgRetPct], [1, 1, -23.84]);
  assert.deepEqual([row(120, 600, "any").all.n, row(120, 600, "any").nextPct, row(120, 600, "3 or more").all.n, row(120, 600, "3").all.n, row(120, 600, "4 or more").all.n], [2, 50, 0, 0, 0]);
  // the earlier and the later half of the copies apart: A's trade first, B's second
  assert.deepEqual([row(120, 600, "any").firstHalfAvgPct, row(120, 600, "any").secondHalfAvgPct, row(120, 600, "3").firstHalfAvgPct], [42.8, -23.84, null]);
  // C's later checks were never made (no price at 5 or 10 min): it is not counted at all
  assert.equal(row(60, 300, "any").all.n, 2);
  // a listed buy that comes before our own purchase moves the purchase behind it: A is then no entry
  const soon = sig({ ...b, sig: "B2", knownMs: T + 30_000 });
  const w2 = secondWaveStudy([a, soon]);
  assert.deepEqual([w2.rows.find((x) => x.entrySec === 60 && x.endSec === 600 && x.buyers === "any")!.all.n, w2.rows.find((x) => x.entrySec === 60 && x.endSec === 600 && x.buyers === "2")!.noNext.n], [1, 1]);
  assert.equal(JSON.stringify([h, rep, w]).includes('"M"'), false, "numbers only");
});

test("second wave measured with quotes: followed from the coin's second listed buyer, sold into the next one, written down only when the window is over", async () => {
  const { waveQuotedStudy, WAVE_FEE, WAVE_STAKE_SOL } = await import("./copy.js");
  type WaveTrade = Parameters<typeof waveQuotedStudy>[0][number];
  // the table, from finished trades
  const lot = (o: object) => ({ tokens: "1000", late: 0.9, ...o });
  const trades: WaveTrade[] = [
    // coin P, third listed buyer; the next one came 200 s later: sold into it for 0.06
    { mint: "P", t: 1000, buyers: 3, nextSec: 200, lots: { e60: lot({ next2: 0.06, next5: 0.058 }), e120: lot({ next2: 0.055 }) } },
    // coin Q, fourth buyer; the next one came after 400 s: at 5 min it was still held (0.04), at 10 min it was sold into the buyer (0.07)
    { mint: "Q", t: 2000, buyers: 4, nextSec: 400, lots: { e60: lot({ end300: 0.04, next2: 0.07 }) } },
    // coin R, second buyer; nobody came, and the coin could not be sold at 10 min
    { mint: "R", t: 3000, buyers: 2, nextSec: null, lots: { e60: { tokens: "1000", end300: 0.045, end600: null } } },
    // coin S: no route for the buy; coin U: its sale was never priced
    { mint: "S", t: 4000, buyers: 3, nextSec: null, lots: { e60: { tokens: null } } },
    { mint: "U", t: 5000, buyers: 3, nextSec: null, lots: { e60: { tokens: "1000" } } },
  ];
  const q = waveQuotedStudy(trades);
  const row = (sec: number, end: number, buyers: string) => q.rows.find((x) => x.entrySec === sec && x.endSec === end && x.buyers === buyers)!;
  const pct = (sol: number) => Math.round((sol / WAVE_STAKE_SOL - 1 - WAVE_FEE) * 10000) / 100;
  assert.deepEqual([q.followed, q.rows.length], [5, 2 * 2 * 4]);
  assert.deepEqual([row(60, 300, "3").all.n, row(60, 300, "3").withNext.avgRetPct, row(60, 300, "3").nextPct, row(60, 300, "3").waitSecMedian, row(60, 300, "3").noRoute], [1, pct(0.06), 100, 140, 1]);
  assert.equal(row(60, 300, "3").late1.avgRetPct, pct(0.06 * 0.9), "a buy that lands a second later gets fewer tokens");
  assert.deepEqual([row(60, 300, "4 or more").noNext.avgRetPct, row(60, 600, "4 or more").withNext.avgRetPct], [pct(0.04), pct(0.07)], "a next buyer after 5 min counts only for the 10 min window");
  assert.deepEqual([row(60, 300, "3 or more").all.n, row(60, 300, "3 or more").nextPct, row(60, 300, "3 or more").firstHalfAvgPct, row(60, 300, "3 or more").secondHalfAvgPct], [2, 50, pct(0.06), pct(0.04)]);
  assert.deepEqual([row(60, 300, "2").noNext.avgRetPct, row(60, 600, "2").noNext.avgRetPct, row(60, 600, "2").late1.n], [pct(0.045), pct(0), 0], "no price at the end is a total loss; without a late quote there is no late trade");
  assert.deepEqual([row(120, 600, "3").all.n, row(120, 600, "3").withNext.avgRetPct, row(120, 600, "2").all.n], [1, pct(0.055), 0]);
  assert.equal(JSON.stringify(q).includes('"P"'), false, "numbers only");

  // the runner: timers run at once, so the next buyer is announced before the follower takes its first step
  const realSet = globalThis.setTimeout;
  (globalThis as { setTimeout: unknown }).setTimeout = ((f: () => void) => realSet(f, 0)) as never;
  try {
    const asked: string[] = [];
    _test.setNet((async (url: string) => {
      const buying = String(url).includes(`inputMint=${SOL}`);
      asked.push(buying ? "buy" : "sell");
      return new Response(JSON.stringify({ outAmount: buying ? "1000" : "60000000" }));
    }) as never);
    const before = _test.waves().length;
    const t = Date.now();
    const W1 = "MintW111111111111111111111111111111111111111";
    _test.waveOnBuy(W1, "w1", t - 120_000); // a coin's first listed buyer: not followed
    await _test.waveIdle();
    assert.deepEqual([asked.length, _test.waves().length - before], [0, 0]);
    _test.waveOnBuy(W1, "w2", t); // the second listed wallet: followed
    _test.waveOnBuy(W1, "w3", t + 90_000); // the third buys 90 s later: w2's trade is sold into it, and w3's own is followed
    _test.waveOnBuy(W1, "w3", t + 95_000 + 31 * 60_000); // long after: nobody is told, and a single buyer is no trade
    await _test.waveIdle();
    const [second, third] = _test.waves().slice(before);
    // bought 60 s after w2 (the 120 s entry was overtaken by w3), sold 2 s and 5 s after w3's buy
    assert.deepEqual(second, { mint: W1, t, buyers: 2, nextSec: 90, lots: { e60: { tokens: "1000", late: 1, next2: 0.06, next5: 0.06 } } });
    // w3 is the coin's third buyer in the half hour; nobody follows in time: both entries held to 5 and to 10 min
    assert.deepEqual(third, { mint: W1, t: t + 90_000, buyers: 3, nextSec: null, lots: { e60: { tokens: "1000", late: 1, end300: 0.06, end600: 0.06 }, e120: { tokens: "1000", late: 1, end300: 0.06, end600: 0.06 } } });
    assert.deepEqual([asked.filter((x) => x === "buy").length, asked.filter((x) => x === "sell").length], [6, 6], "two quotes per purchase, and only the sales that happen");
    assert.equal(_test.health().waveLive, 0);
    const sum = buildCopySummary();
    assert.equal(sum.waveQuoted.followed, _test.waves().length);
    assert.equal(sum.waveQuoted.rows.find((x) => x.entrySec === 60 && x.endSec === 300 && x.buyers === "2")!.withNext.avgRetPct, pct(0.06));
    // kept across a restart, and switched off by SOLANA_WAVE=off
    assert.ok(readFileSync(join(dir, "solana", "copy-waves.jsonl"), "utf8").trim().split("\n").length >= 2);
    _test.load();
    assert.deepEqual(_test.waves().slice(-2), [second, third]);
    process.env.SOLANA_WAVE = "off";
    _test.waveOnBuy("MintW222222222222222222222222222222222222222", "w1", t);
    _test.waveOnBuy("MintW222222222222222222222222222222222222222", "w2", t);
    await _test.waveIdle();
    assert.equal(_test.waves().length, before + 2);
  } finally {
    delete process.env.SOLANA_WAVE;
    globalThis.setTimeout = realSet;
    _test.setNet(fetch);
  }
});

test("price history for the slow-trade research: started once, only where the publishing token is, and switchable off", async () => {
  const { startCandles } = await import("./candles.js");
  const { writeFileSync } = await import("node:fs");
  const calls: { cmd: string; args: string[]; detached: boolean }[] = [];
  const run = ((cmd: string, args: string[], o: { detached: boolean }) => (calls.push({ cmd, args, detached: o.detached }), { unref() {} })) as never;
  const home = mkdtempSync(join(tmpdir(), "solhome-"));
  assert.equal(startCandles(home, run), false, "no token on this machine: not started");
  assert.equal(startCandles("", run), false);
  writeFileSync(join(home, ".predbot-github-token"), "t");
  process.env.SOLANA_CANDLES = "off";
  assert.equal(startCandles(home, run), false);
  delete process.env.SOLANA_CANDLES;
  assert.equal(startCandles(home, run), true);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].cmd, calls[0].args[0].endsWith(join("research", "sol-candles.py")), calls[0].detached], ["python3", true, true]);
  const script = readFileSync(calls[0].args[0], "utf8");
  assert.ok(script.includes("api.binance.com") && !/order|apiKey|X-MBX-APIKEY|signature/i.test(script.replace(/no order|no key, no account, no order/gi, "")), "public market data only: no key, no order");
});

test("walk-forward: only buys made after the pace rule was written are scored, by pace and by price gap", async () => {
  const { walkStudy, WALK_FROM, pacesBefore } = await import("./copy.js");
  const exits = (v: number) => ({ d0: { x0: 0.24, x2: v, x5: v, x10: v, x20: v, x30: v, x60: v, x120: v }, d1: {}, d3: {} });
  // price paid by us against the wallet's 1e-6: 1.05e-6 = 5% above, 1.12e-6 = 12%, 1.3e-6 = 30%
  const at = (i: number, wallet: string, price: number, out: number, ms = WALK_FROM + i * 60_000) =>
    sig({ sig: `w${i}`, wallet, knownMs: ms, entries: { d0: { t: 0, slot: 1, tokens: "1", price }, d1: null, d3: null }, exits: exits(out) });
  const sigs = [
    at(-3, "busy", 1.05e-6, 0.5), at(-2, "busy", 1.05e-6, 0.5), at(-1, "busy", 1.05e-6, 0.5), // before the rule: never scored, but they make the trader busy
    at(1, "busy", 1.05e-6, 0.2),
    at(2, "calm", 1.05e-6, 0.3),
    at(3, "calm2", 1.12e-6, 0.26),
    at(4, "calm3", 1.3e-6, 0.2),
  ];
  const w = walkStudy(sigs, pacesBefore(sigs));
  assert.equal(w.buys, 4);
  assert.equal(w.since, "2026-11-11T16:15:00.000Z");
  const cell = (pace: string, gap: string) => w.cells.find((c) => c.pace === pace && c.gap === gap)!;
  assert.deepEqual([cell("calm", "under 9%").t30.n, cell("calm", "9% to 15%").t30.n, cell("calm", "15% and more").t30.n, cell("calm", "any").t30.n], [1, 1, 1, 3]);
  assert.deepEqual([cell("busy", "under 9%").t30.n, cell("busy", "any").t30.n, cell("all", "any").t30.n, cell("all", "under 9%").t60.n], [1, 1, 4, 2]);
  assert.equal(cell("calm", "under 9%").t30.won, 1);
  assert.equal(cell("busy", "under 9%").t30.won, 0);
  assert.ok(cell("calm", "under 9%").t30.avgRetPct! > 15);
  assert.equal(w.cells.length, 12);
  assert.equal(JSON.stringify(w).includes("calm2"), false, "numbers only");
  // the 60 s rule with a stop: the busy trader's copy (sold for 0.2 of 0.25) is cut at the first check in every case
  assert.deepEqual([cell("busy", "under 9%").t60sl10.n, cell("busy", "under 9%").t60sl10.won, cell("calm", "under 9%").t60sl10.won], [1, 0, 1]);
  assert.equal(cell("busy", "under 9%").t60sl10.avgRetPct, cell("busy", "under 9%").t60.avgRetPct, "flat path: the stop sells at the same price the clock would");
  // bought 1 s late: these signals have no late entry, so nothing is scored there
  assert.deepEqual([cell("all", "any").late1t60.n, cell("all", "any").late1t60sl10.n], [0, 0]);
  // a copy that is 12% down at 5 s and back up at 60 s: the stop takes the 12%, the clock would have won
  const dip = sig({ sig: "dip", wallet: "calm9", knownMs: WALK_FROM + 9 * 60_000, entries: { d0: { t: 0, slot: 1, tokens: "1", price: 1.05e-6 }, d1: { t: 0, slot: 1, tokens: "1", price: 1.06e-6 }, d3: null }, exits: { d0: { x0: 0.24, x2: 0.24, x5: 0.218, x10: 0.24, x20: 0.25, x30: 0.26, x60: 0.262, x120: 0.3 }, d1: { x2: 0.24, x5: 0.218, x10: 0.24, x20: 0.25, x30: 0.26, x60: 0.262, x120: 0.3 }, d3: {} } });
  const w2 = walkStudy([dip], pacesBefore([dip])).cells.find((c) => c.pace === "calm" && c.gap === "under 9%")!;
  assert.deepEqual([w2.t60.won, w2.t60sl10.won, w2.t60sl15.won, w2.t60sl20.won, w2.late1t60.won, w2.late1t60sl10.won, w2.late1t60sl15.won], [1, 0, 1, 1, 1, 0, 1]);
  assert.ok(w2.t60sl10.avgRetPct! < -12 && w2.t60sl10.avgRetPct! > -14);
});

test("buy size: judged against the wallet's earlier buys only; real copies matched by coin and slot", () => {
  const d1 = (x10: number) => ({ x2: x10, x5: x10, x10, x20: x10, x30: x10, x60: x10, x120: x10 });
  // one wallet: five 1 SOL buys, then a 0.2 SOL buy (small), then a 3 SOL buy (big); another wallet's first buy
  const mk = (i: number, sol: number, out: number, wallet = W) =>
    sig({ sig: `s${i}`, wallet, mint: `m${i}`, leaderSlot: 2000 + i, leaderSol: sol, knownMs: 1_800_000_000_000 + i * 60_000, exits: { d0: d1(out), d1: d1(out), d3: {} } });
  const sigs = [0, 1, 2, 3, 4].map((i) => mk(i, 1, 0.26)).concat([mk(5, 0.2, 0.2), mk(6, 3, 0.3), mk(7, 0.2, 0.3, "other")]);
  const ratio = buySizeRatios(sigs);
  assert.equal(ratio.get(sigs[4]), null); // only 4 earlier buys
  assert.equal(ratio.get(sigs[5]), 0.2);
  assert.ok(Math.abs(ratio.get(sigs[6])! - 3 / 1) < 1e-12); // the median of the earlier six is 1
  assert.equal(ratio.get(sigs[7]), null); // the other wallet has no history: a small buy is not called small
  assert.equal(relGroup(0.2), "under 1/4 of usual");
  assert.equal(relGroup(0.3), "1/4 to 1/2 of usual");
  assert.equal(relGroup(1), "usual (1/2 to 2x)");
  assert.equal(relGroup(3), "over 2x usual");
  const real = [
    { mint: "m5", leaderSlot: 2005, buy: "landed", netSol: -0.01 },
    { mint: "m6", leaderSlot: 2006, buy: "landed", netSol: 0.004 },
    { mint: "m6", leaderSlot: 9999, buy: "landed", netSol: -0.002 }, // another buy of the coin: not this one
    { mint: "m1", leaderSlot: 2001, buy: "not sent", netSol: 0 },
  ];
  const b = buySizeStudy(sigs, new Map(), real, null);
  const row = (g: string) => b.byUsual.find((x) => x.group === g)!;
  assert.equal(row("under 1/4 of usual").late1.n, 1);
  assert.equal(row("under 1/4 of usual").late1.won, 0);
  assert.equal(row("over 2x usual").late1.won, 1);
  assert.equal(row("no history").late1.n, 6);
  assert.equal(b.skipSmall.kept.late1.n, 7);
  assert.equal(b.real.sent, 3);
  assert.equal(b.real.matched, 2);
  const rr = (g: string) => b.real.byUsual.find((x) => x.group === g)!;
  assert.deepEqual([rr("under 1/4 of usual").copies, rr("under 1/4 of usual").netSol], [1, -0.01]);
  assert.deepEqual([rr("over 2x usual").copies, rr("over 2x usual").won], [1, 1]);
  assert.equal(rr("not matched").copies, 1);
  assert.equal(b.bySol.find((x) => x.group === "under 0.5 SOL")!.late1.n, 2);
  assert.ok(!JSON.stringify(b).includes("m5")); // totals only, no coin
});
