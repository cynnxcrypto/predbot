import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "solcopy-"));
process.env.DATA_DIR = dir;
process.env.HELIUS_API_KEY = "SECRETHELIUS";
process.env.JUPITER_API_KEY = "SECRETJUP";

const { crowd, exitStudy, followerPrice, fomoStudy, GRID, lateStudy, parseBuy, parseDollarBuy, pathRet, ret, rising, roundTrip, sameBlockRet, SAME_BLOCK_SLIP, scalp, scalpCut, sizeStudy, STAKE_SOL, summarize, trail, TX_SOL } = await import("./copy.js");
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

test("returns: costs taken off, missing quotes handled honestly", () => {
  const s = sig();
  assert.ok(Math.abs(ret(s, 0, 5)! - ((0.27 - 2 * TX_SOL) / STAKE_SOL - 1)) < 1e-12);
  assert.equal(ret(s, 1, 2), undefined); // later quote exists: a failed request, left out
  assert.equal(ret(s, 3, 5), undefined); // never entered
  const dead = sig({ exits: { d0: { x0: 0.24, x2: 0.2 }, d1: {}, d3: {} } });
  assert.equal(ret(dead, 0, 30), -1); // could not be sold at all: total loss
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
  assert.equal(scalpCut(sig({ exits: { d0: { x0: out(-2), x2: out(1) }, d1: {}, d3: {} } }), 10, 5), -1);
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
  const rule = (id: string) => sum.rules.find((x) => x.id === id)!;
  assert.equal(rule("copy-d5-tp10-t60").n, 1);
  assert.equal(rule("copy-d20-x30").n, 1);
  assert.equal(rule("copy-d5-rising-tp10-t60").n, 1);
  assert.equal(rule("copy-d0-tp10-cut5-t60").n, 2);
  assert.ok(rule("copy-d0-tp10-cut10-t60").text.includes("sell at 10 s if it is not up"));
  const st = sum.lateStudy;
  assert.equal(st.n, 1);
  assert.deepEqual(st.entries.map((x) => x.sec), [0, 5, 10, 20]);
  assert.deepEqual(st.entries.map((x) => x.priceVsFastestPct), [0, 8, 5, -10]);
  assert.deepEqual(st.entries.map((x) => x.won), [1, 0, 0, 1]);
  assert.deepEqual(st.entries.map((x) => x.avgRetPct), [12, -6, -3, 11]);
  assert.deepEqual(st.entries[3].holdOnly, { n: 1, won: 1, avgRetPct: 2 });
  assert.equal(lateStudy([old]).n, 0);
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
  const a = sig({ crowd: { same: 2, s10: 6, s25: 7, s150: 8, ahead: { d0: 5 } } });
  const b = sig({ wallet: WALLETS[1].address, name: "gr3g", crowd: { same: 0, s10: 0, s25: 0, s150: 1, ahead: { d0: 0 } } });
  const sum = summarize([a, b], 80);
  assert.equal(sum.speed.buysSeen, 2);
  assert.equal(sum.speed.lagSecMedian, 1.5);
  assert.equal(sum.speed.aheadMedian, 2.5);
  assert.equal(sum.speed.firstInLinePct, 50);
  assert.equal(sum.speed.noWavePct, 50);
  assert.equal(sum.speed.entryGapPctMedian, 10);
  assert.ok(sum.speed.breakEvenPctMedian! > 4);
  assert.equal(sum.rulesTried, 58);
  assert.equal(sum.wallets[0].name, "Chairman");
  assert.deepEqual(sum.qualified, []);
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
    assert.deepEqual(s[0].crowd, { same: 1, s10: 2, s25: 2, s150: 2, ahead: { d0: 2, d1: 2, d3: 2, d5: 2, d10: 2, d20: 2 } });
    // the late entries are bought and followed like the others
    assert.equal(s[0].entries.d20!.price, STAKE_SOL / 1000);
    assert.equal(s[0].exits.d5.x60, 0.24);
    assert.equal(s[0].exits.d20.x0, undefined, "only the fastest entry is priced for an instant round trip");
    // 6 entries (3 of them late on purpose), 7 exits each, the instant round trip, the 5 extra early checks of the
    // exit study; its 3 long checks follow after the signal is saved
    // plus the size check: 3 other stakes, each one buy quote and 4 sale quotes
    assert.ok(quotes >= 6 + 6 * 7 + 1 + 5 + 15 && quotes <= 6 + 6 * 7 + 1 + 8 + 15);
    assert.deepEqual(Object.keys(s[0].sizes!).sort(), ["0.05", "1", "3"]);
    assert.deepEqual(s[0].sizes!["1"], { x0: 0.24, x10: 0.24, x30: 0.24, x60: 0.24 });
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
