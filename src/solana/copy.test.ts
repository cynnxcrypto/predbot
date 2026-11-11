import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "solcopy-"));
process.env.DATA_DIR = dir;
process.env.HELIUS_API_KEY = "SECRETHELIUS";
process.env.JUPITER_API_KEY = "SECRETJUP";

const { crowd, parseBuy, ret, roundTrip, sameBlockRet, SAME_BLOCK_SLIP, scalp, STAKE_SOL, summarize, TX_SOL } = await import("./copy.js");
const { SOL } = await import("./pools.js");
const { validAddress, WALLETS } = await import("./wallets.js");
const { _test, buildCopySummary, scrub } = await import("./copyrun.js");
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
  assert.equal(WALLETS.length, 50);
  for (const w of WALLETS) assert.ok(validAddress(w.address), w.name);
  assert.equal(new Set(WALLETS.map((w) => w.address)).size, 50);
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

test("same-block what-if: the measured exit re-priced at the wallet's price plus slip", () => {
  const s = sig(); // we paid 1.1e-6, the wallet 1e-6
  const want = (0.27 * (1.1e-6 / (1e-6 * (1 + SAME_BLOCK_SLIP))) - 2 * TX_SOL) / STAKE_SOL - 1;
  assert.ok(Math.abs(sameBlockRet(s, 5)! - want) < 1e-12);
  assert.ok(sameBlockRet(s, 5)! > ret(s, 0, 5)!);
  assert.equal(summarize([s], 80).sameBlock.rules.length, 7);
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
  assert.equal(sum.rulesTried, 30);
  assert.equal(sum.wallets[0].name, "Chairman");
  assert.deepEqual(sum.qualified, []);
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
    assert.deepEqual(s[0].crowd, { same: 1, s10: 2, s25: 2, s150: 2, ahead: { d0: 2, d1: 2, d3: 2 } });
    assert.equal(quotes, 3 + 3 * 7 + 1);
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
    const files = readFileSync(join(dir, "solana", "copy-signals.jsonl"), "utf8") + readFileSync(join(dir, "solana-copy-summary.json"), "utf8");
    assert.ok(!files.includes("SECRET"));
  } finally {
    globalThis.setTimeout = realSet;
  }
});
