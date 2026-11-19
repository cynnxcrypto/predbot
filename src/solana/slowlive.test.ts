import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// a scratch folder: the wallet these tests sign with is made there, never in the real data folder
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "slowlive-"));
// the size floors (17 Nov 2026) are tested on their own below; the other tests use small wallets
process.env.SOLANA_SLOW_MIN_SOL = "0";
process.env.SOLANA_SLOW_MIN_BUY_SOL = "0";
// made-up keys: every network call here is faked
process.env.HELIUS_API_KEY = "test-helius";
process.env.JUPITER_API_KEY = "test-jupiter";
const { parseSlowLive, slowLiveSummary, onSwap, sweep, recover, startSlowLive, wallets, rested, realWinner, losingRun, realOf, oneStake, resultOf, heldCopies, afterOf, AFTER_MAX_MS, NET_ROUNDS_FREE, saleRefused, GIVE_UP_ROUNDS, RETRY_MS, RETRY_UNSOLD_MS, UNSOLD_DAYS, LEVEL_STAKES, takenVsSkipped, openNow, cutClearly, CUT_HOLD_MS, HARD_MAX_LOSS_SOL, HARD_STAKE_SOL, HARD_MAX_OPEN, WALLETS, stepOf, _test } = await import("./slowlive.js");
const { _test: run } = await import("./copyrun.js");
const { buildSigned, wallet } = await import("./keys.js");
const { base58 } = await import("./whirlpool.js");
const slow = await import("./slow.js");
const exits = await import("./slowexits.js");
type Cfg = import("./slowlive.js").SlowLiveConfig;

const SYSTEM = "11111111111111111111111111111111";
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SOLMINT = "So11111111111111111111111111111111111111112";
const FEE = 5000;
const RENT = 2_039_280;
const A = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const B = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const L1 = WALLETS[0].address;
const L2 = WALLETS[1].address;
const sigOfTx = (b64: string) => base58(Buffer.from(b64, "base64").subarray(1, 65));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CFG: Cfg = { on: true, stakeSol: 0.01, maxLossSol: 0.1, stopLossSol: 0, maxOpen: 6, entrySec: 1, exitSec: 1, maxHoldH: 72, slippageBps: 1500, maxFeeLamports: 20_000, follow: "fixed" };

/** A made-up chain and Jupiter that keep real books (as in copylive.test.ts): `worth(mint)` = what a sale brings back, SOL. */
function chain(worth: (mint: string) => number, lamports = 0.08e9) {
  const w = wallet();
  const c = {
    lamports, n: 0, quotes: 0, sends: 0,
    held: new Map<string, bigint>(),
    built: new Map<string, { kind: "buy" | "sell"; mint: string; out: number }>(),
    txs: new Map<string, { pre: number; post: number; ok: boolean }>(),
    /** buys that never land */
    lost: false,
    /** set by a test: the price service answers a quote with this HTTP status (and its own error code) */
    refuse: null as null | ((kind: "buy" | "sell") => { status: number; code?: string } | null),
    /** sales that land but fail on the chain (the coin stays in the wallet) */
    failSell: false,
    /** the leader's own transactions, as the history reader returns them */
    leaderTxs: [] as unknown[],
    apply(sig: string, delta: number, ok: boolean) {
      c.txs.set(sig, { pre: c.lamports, post: c.lamports + delta, ok });
      c.lamports += delta;
    },
  };
  const acc = (mint: string) => ({ pubkey: mint, account: { owner: T22, data: { parsed: { info: { mint, state: "initialized", tokenAmount: { amount: c.held.get(mint)!.toString(), decimals: 6 } } } } } });
  run.setNet((async (url: string, init?: { body?: string }) => {
    const json = (x: unknown) => new Response(JSON.stringify(x));
    if (url.includes("/swap/v1/quote")) {
      c.quotes++;
      const u = new URL(url).searchParams;
      const [i, o] = [u.get("inputMint")!, u.get("outputMint")!];
      const no = c.refuse?.(i === SOLMINT ? "buy" : "sell");
      if (no) return new Response(JSON.stringify({ errorCode: no.code ?? "" }), { status: no.status });
      return json(i === SOLMINT ? { outAmount: "1000", inputMint: i, outputMint: o } : { outAmount: String(Math.round(worth(i) * 1e9)), inputMint: i, outputMint: o });
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
    if (method === "getTransactionsForAddress") return res({ data: c.leaderTxs, paginationToken: null });
    if (method === "getLatestBlockhash") return res({ value: { blockhash: SYSTEM } });
    if (method === "sendTransaction") {
      c.sends++;
      const raw = Buffer.from(params[0] as string, "base64");
      const sig = base58(raw.subarray(1, 65));
      if (c.txs.has(sig)) return res(sig); // the same transaction again: the chain takes it once
      const b = c.built.get(sig);
      if (b?.kind === "buy") {
        if (c.lost) return res(sig);
        c.held.set(b.mint, 1000n);
        c.apply(sig, -(0.01e9 + FEE + RENT), true);
      } else if (b?.kind === "sell") {
        const ok = !c.failSell && (c.held.get(b.mint) ?? 0n) > 0n;
        if (ok) c.held.set(b.mint, 0n);
        c.apply(sig, ok ? b.out - FEE : -FEE, ok);
      } else {
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
      return res(t ? { meta: { preBalances: [t.pre, 1], postBalances: [t.post, 1] }, transaction: { message: { accountKeys: [w.address, SYSTEM] } } } : null);
    }
    if (method === "getTokenAccountsByOwner") {
      const f = params[1] as { mint?: string };
      return res({ value: f.mint && c.held.has(f.mint) ? [acc(f.mint)] : [] });
    }
    throw new Error(`unexpected call ${method}`);
  }) as never);
  return c;
}
const fresh = (cfg: Cfg = CFG) => {
  _test.reset();
  _test.setConfig(cfg);
  _test.ready(true);
};
const swap = (wallet: string, mint: string, buy: boolean, sol = 0.3) => ({ wallet, mint, buy, sol, slot: 1, seenMs: Date.now() });

test("real day-holder copy: off unless switched on, hard limits hold", () => {
  assert.equal(parseSlowLive("{}").on, false);
  assert.equal(parseSlowLive("not json").on, false);
  assert.equal(parseSlowLive(JSON.stringify({ solanaSlow: { on: true } })).on, false, "no loss cap means off");
  assert.equal(parseSlowLive(JSON.stringify({ solanaSlow: { on: true, maxLossSol: 0.05, stakeSol: 0.001 } })).on, false);
  assert.equal(parseSlowLive(JSON.stringify({ solanaCopy: { on: true, maxLossSol: 0.5 } })).on, false, "the first test's switch is not this one");
  const c = parseSlowLive(JSON.stringify({ solanaSlow: { on: true, maxLossSol: 9, stakeSol: 9, maxOpen: 999, entrySec: 0, exitSec: 999, slippageBps: 1e6, maxFeeLamports: 1e12 } }));
  assert.deepEqual([c.on, c.maxLossSol, c.stakeSol, c.maxOpen, c.entrySec, c.exitSec, c.slippageBps, c.maxFeeLamports], [true, HARD_MAX_LOSS_SOL, HARD_STAKE_SOL, HARD_MAX_OPEN, 1, 60, 3000, 200_000]);
  const d = parseSlowLive(JSON.stringify({ solanaSlow: { on: true, maxLossSol: 0.08 } }));
  assert.deepEqual([d.stakeSol, d.maxOpen, d.entrySec, d.exitSec, d.maxHoldH, d.maxFeeLamports], [0.01, HARD_MAX_OPEN, 5, 5, 72, 20_000]);
  assert.equal(HARD_MAX_LOSS_SOL, 1.5, "the whole wallet: no more than it may hold");
  // size steps from our own landed copies of a wallet
  const NOWS = 1_800_000_000_000;
  const mk = (n: number, each: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ name: "w", buy: "landed", t: NOWS - (n - i) * 60_000, netSol: each(i) }));
  assert.equal(stepOf(mk(29, () => 0.001), "w", 5, NOWS).mult, 1);
  assert.equal(stepOf(mk(30, () => 0.001), "w", 0.2, NOWS).mult, 2);
  assert.equal(stepOf(mk(100, () => 0.001), "w", 0.2, NOWS).mult, 2, "the top step needs a leader buy of 1+ SOL");
  assert.equal(stepOf(mk(100, () => 0.001), "w", 1.5, NOWS).mult, 4);
  assert.equal(stepOf(mk(100, (i) => (i < 85 ? 0.001 : -0.001)), "w", 1.5, NOWS).mult, 2, "newest 15 behind: one step down");
  assert.equal(stepOf(mk(40, (i) => (i % 2 ? 0.001 : -0.002)), "w", 5, NOWS).mult, 1, "behind overall");
  assert.equal(stepOf(mk(40, () => 0.001), "other", 5, NOWS).mult, 1);
  // which wallets: the paper-proven ones unless the file says "fixed"
  assert.deepEqual([d.follow, parseSlowLive(JSON.stringify({ solanaSlow: { on: true, maxLossSol: 0.08, wallets: "fixed" } })).follow, parseSlowLive(JSON.stringify({ solanaSlow: { on: true, maxLossSol: 0.08, wallets: 7 } })).follow], ["proven", "fixed", "proven"]);
});

test("real day-holder copy: copies the wallets proven on paper, adapts as the list changes, rests a wallet whose real copies are behind", async () => {
  fresh({ ...CFG, follow: "proven" });
  const c = chain(() => 0.012);
  slow._test.reset();
  const P1 = "Prov1111111111111111111111111111111111111111";
  const P2 = "Prov2222222222222222222222222222222222222222";
  const st = slow._test.state();
  // paper: closed copies entered 5 s late; 0.3 back on 0.25 is a win, 0.24 a loss
  const paper = (wallet: string, name: string, i: number, back: number) => ({ wallet, name, mint: `c${i}`, seenMs: i, leaderSol: 1, entries: { e5: "10", e30: null, e300: null, e1800: null }, exits: { "e5-x5": back }, closed: "sold" as const });
  for (let i = 0; i < 20; i++) st.recent.push(paper(P1, "coin buyer Prov", i, i < 12 ? 0.3 : 0.24));
  for (let i = 0; i < 19; i++) st.recent.push(paper(P2, "coin buyer Pro2", i, 0.3));
  for (let i = 0; i < 30; i++) st.recent.push(paper(L1, WALLETS[0].name, i, 0.24));
  slow._test.follow([P1, P2, L1]);
  // P1: 20 copies, 12 won, ahead. P2: one copy short. The first wallet of the old three: behind on paper.
  assert.deepEqual(wallets().map((w) => w.address), [P1]);
  onSwap(swap(L1, B, true));
  onSwap(swap(P2, B, true));
  assert.equal(_test.state().opens.length, 0, "not proven: not copied");
  onSwap(swap(P1, A, true));
  assert.equal(_test.state().opens.length, 1);
  await wait(1500);
  assert.equal(_test.state().opens[0].stage, "held");
  // the list adapts: P1's newest paper copies turn (out), P2 gets its 20th (in)
  for (let i = 20; i < 60; i++) st.recent.push(paper(P1, "coin buyer Prov", i, 0.24));
  st.recent.push(paper(P2, "coin buyer Pro2", 19, 0.3));
  assert.deepEqual(wallets().map((w) => w.address), [P1], "the list is kept for a minute");
  _test.relist();
  assert.deepEqual(wallets().map((w) => w.address), [P2]);
  // P1 is off the list: a new buy of it is not copied, but its sale of the coin we hold is still heard and followed
  onSwap(swap(P1, B, true));
  assert.equal(_test.state().opens.length, 1);
  startSlowLive();
  slow._test.setCfg({ rpcUrl: () => null, fetch: () => fetch, listed: () => [], busy: () => [], quote: async () => null });
  assert.ok(slow.slowWatch().includes(P1) && slow.slowWatch().includes(P2), "the stream carries the copied wallets and the wallet of a copy that is out");
  onSwap(swap(P1, A, false));
  await wait(3000);
  assert.equal(_test.state().opens.length, 0);
  assert.equal(c.held.has(A), false);
  assert.deepEqual([_test.state().rows[0].name, _test.state().rows[0].exit], ["coin buyer Prov", "sold"]);
  // rested (cut the losers): 5+ real copies in the last 7 days and behind, however many won; older ones do not count
  const row = (name: string, t: number, netSol: number) => ({ t, name, mint: "x", leaderSol: 1, buy: "landed" as const, exit: "sold" as const, heldMin: 60, netSol, sigs: [] as string[] });
  const now = Date.now();
  for (let i = 0; i < 4; i++) _test.state().rows.push(row("coin buyer Pro2", now - i * 60_000, i < 3 ? 0.001 : -0.005));
  assert.equal(rested("coin buyer Pro2"), false, "four copies: paper still decides");
  _test.state().rows.push(row("coin buyer Pro2", now, 0.0005));
  assert.equal(rested("coin buyer Pro2"), true, "five copies, four won, behind");
  _test.relist();
  assert.deepEqual(wallets(), []);
  onSwap(swap(P2, B, true));
  assert.equal(_test.state().opens.length, 0, "rested: not copied");
  const s = slowLiveSummary();
  assert.deepEqual([s.follow, s.wallets, s.kept, s.rested], ["proven", [], [], ["coin buyer Pro2"]]);
  assert.deepEqual(s.byWallet.map((x) => [x.name, x.state, x.last7.copies]), [["coin buyer Prov", "off", 1], ["coin buyer Pro2", "rested on real", 5]]);
  assert.ok(!JSON.stringify(s).includes(P1) && !JSON.stringify(s).includes(P2), "names only in the public summary");
  // ahead, or its bad copies over a week old: not rested
  _test.state().rows[_test.state().rows.length - 1].netSol = 0.002;
  assert.equal(rested("coin buyer Pro2"), false);
  _test.state().rows[_test.state().rows.length - 1].netSol = 0.0005;
  assert.equal(rested("coin buyer Pro2", now + 8 * 86_400_000), false);
  // more than one stake behind: rested at once, at any count. One stake = the biggest its counted copies were bought with
  // (a row without a stake is one of the first, 0.01 SOL): a copy lost whole rests its wallet, an ordinary loser does not
  const staked = (name: string, netSol: number, stakeSol?: number) => ({ ...row(name, now, netSol), ...(stakeSol ? { stakeSol } : {}) });
  _test.state().rows.push(staked("coin buyer Rug1", -0.0103), staked("coin buyer Rug2", -0.0099), staked("coin buyer Rug3", -0.0244, 0.035), staked("coin buyer Rug4", -0.0353, 0.035), staked("coin buyer Rug5", -0.0203, 0.02), staked("coin buyer Rug6", -0.0199, 0.02));
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((i) => rested(`coin buyer Rug${i}`)), [true, false, false, true, true, false]);
  assert.deepEqual([oneStake("coin buyer Rug1"), oneStake("coin buyer Rug3"), oneStake("coin buyer Rug5"), oneStake("coin buyer Nobody")], [0.01, 0.035, 0.02, 0.02]);
  slow._test.reset();
  slow._test.setCfg(null);
  _test.reset();
});

test("real day-holder copy: real results come first: a real winner stays copied when paper drops it, unless a safety screen fails", async () => {
  fresh({ ...CFG, follow: "proven" });
  chain(() => 0.012);
  slow._test.reset();
  const W1 = "Win11111111111111111111111111111111111111111";
  const W2 = "Win22222222222222222222222222222222222222222";
  const W3 = "Win33333333333333333333333333333333333333333";
  const P1 = "Prov1111111111111111111111111111111111111111";
  const st = slow._test.state();
  const paper = (wallet: string, name: string, i: number, back: number) => ({ wallet, name, mint: `c${i}`, seenMs: i, leaderSol: 1, entries: { e5: "10", e30: null, e300: null, e1800: null }, exits: { "e5-x5": back }, closed: "sold" as const });
  // on paper: P1 proven; the three W wallets were copied on paper but are behind there now
  for (let i = 0; i < 20; i++) st.recent.push(paper(P1, "coin buyer Prov", i, 0.3));
  for (const [w, n] of [[W1, "coin buyer Win1"], [W2, "coin buyer Win2"], [W3, "coin buyer Win3"]]) for (let i = 0; i < 25; i++) st.recent.push(paper(w, n, i, 0.24));
  // the scan: W1 and W2 read and not a program; W3 filed as a program
  const ws = (bot?: boolean) => ({ name: "w", doneAt: Date.now(), newest: 0, txPerDay: 10, buysPerDay: 2, spanDays: 30, ...(bot ? { bot } : {}), swaps: [], late: {} });
  st.wallets[W1] = ws();
  st.wallets[W2] = ws();
  st.wallets[W3] = ws(true);
  st.wallets[P1] = ws();
  slow._test.follow([P1]); // paper follows only P1 now
  const row = (name: string, i: number, netSol: number, wallet?: string) => ({ t: Date.now() - i * 60_000, name, ...(wallet ? { wallet } : {}), mint: "x", leaderSol: 1, buy: "landed" as const, exit: "sold" as const, heldMin: 60, netSol, sigs: [] as string[] });
  const rows = _test.state().rows;
  // real: W1 six copies, ahead by one big winner (two won); W2 four copies ahead (too few); W3 five ahead but a program
  for (let i = 0; i < 6; i++) rows.push(row("coin buyer Win1", i, i === 0 ? 0.03 : i === 1 ? 0.001 : -0.002));
  for (let i = 0; i < 4; i++) rows.push(row("coin buyer Win2", i, 0.004, W2));
  for (let i = 0; i < 5; i++) rows.push(row("coin buyer Win3", i, 0.004, W3));
  _test.relist();
  // real winners first, then the paper list
  assert.deepEqual(wallets().map((w) => [w.address, w.by]), [[W1, "real"], [P1, "paper"]]);
  // its buys are copied again
  onSwap(swap(W2, B, true));
  onSwap(swap(W3, B, true));
  assert.equal(_test.state().opens.length, 0, "too few real copies / a program: not copied");
  onSwap(swap(W1, A, true));
  assert.equal(_test.state().opens.length, 1);
  await wait(1500);
  assert.equal(_test.state().opens[0].stage, "held");
  // its open copy is not on the dropped-wallet clock
  const t0 = Date.now();
  sweep(t0);
  sweep(t0 + 7 * 3_600_000);
  await wait(300);
  assert.deepEqual([_test.state().opens.length, _test.state().opens[0].offMs], [1, undefined]);
  const s = slowLiveSummary();
  assert.deepEqual([s.wallets, s.kept, s.rested], [["coin buyer Win1", "coin buyer Prov"], ["coin buyer Win1"], []]);
  // by wallet: real winners first, each with its state
  assert.deepEqual(s.byWallet.map((x) => [x.name, x.state, x.copies, x.won]), [
    ["coin buyer Win1", "kept on real", 6, 2],
    ["coin buyer Win3", "held back", 5, 5],
    ["coin buyer Win2", "off", 4, 4],
    ["coin buyer Prov", "on the paper list", 0, 0],
  ]);
  assert.ok(![W1, W2, W3, P1].some((a) => JSON.stringify(s).includes(a)), "names only in the public summary");
  // a fifth winning copy brings W2 in (its address from its rows); W1 falls behind and is cut, and then its copy is on the clock
  rows.push(row("coin buyer Win2", 0, 0.004, W2));
  rows.push(row("coin buyer Win1", 0, -0.03));
  _test.relist();
  assert.deepEqual(wallets().map((w) => [w.address, w.by]), [[W2, "real"], [P1, "paper"]]);
  assert.equal(rested("coin buyer Win1"), true);
  sweep(t0 + 8 * 3_600_000);
  assert.ok(_test.state().opens[0].offMs);
  // not copyable by its late copies: a safety screen, so the real record does not override it
  // a screen name two addresses share cannot be told apart: no address for it
  assert.equal(slow.paperAddresses().get("coin buyer Prov"), P1);
  st.recent.push(paper("Prov9999999999999999999999999999999999999999", "coin buyer Prov", 99, 0.3));
  assert.equal(slow.paperAddresses().has("coin buyer Prov"), false);
  st.recent.pop();
  // the safety screens: read by the scan, not a program, not a flipper
  assert.deepEqual([slow.copySafe(W2), slow.copySafe(W3), slow.copySafe("Unknown1111111111111111111111111111111111111")], [true, false, false]);
  st.wallets[W2] = { ...ws(), fast: { trips: 90, holdMin: 5, sol: 1, wonPct: 60 } };
  _test.relist();
  assert.deepEqual(wallets().map((w) => w.address), [P1], "a flipper now: the real record does not override that");
  slow._test.reset();
  slow._test.setCfg(null);
  _test.reset();
});

test("real day-holder copy: real first, the gaps closed: a winner's address from our own records; a cut is heard at once; winners first when the list is full; a coin we cannot sell; the clock only while paper lists a wallet", async () => {
  const paper = (wallet: string, name: string, i: number, back: number) => ({ wallet, name, mint: `c${i}`, seenMs: i, leaderSol: 1, entries: { e5: "10", e30: null, e300: null, e1800: null }, exits: { "e5-x5": back }, closed: "sold" as const });
  const ws = () => ({ name: "w", doneAt: Date.now(), newest: 0, txPerDay: 10, buysPerDay: 2, spanDays: 30, swaps: [], late: {} });
  const row = (name: string, i: number, netSol: number, more: Record<string, unknown> = {}) => ({ t: Date.now() - i * 60_000, name, mint: "x", leaderSol: 1, buy: "landed" as const, exit: "sold" as const, heldMin: 60, netSol, sigs: [] as string[], ...more });
  const out = (wallet: string, name: string, mint: string, more: Record<string, unknown> = {}) => ({ wallet, name, mint, leaderSol: 1, seenMs: Date.now() - 60_000, boughtMs: Date.now() - 60_000, stakeSol: 0.01, stage: "held" as const, sigs: [] as string[], sellRounds: 0, ...more });
  const W1 = "Win11111111111111111111111111111111111111111";
  const P1 = "Prov1111111111111111111111111111111111111111";
  const P2 = "Prov2222222222222222222222222222222222222222";
  const begin = () => {
    fresh({ ...CFG, follow: "proven" });
    slow._test.reset();
    return slow._test.state();
  };

  // 1. A real winner paper holds no copies of any more, and whose rows were written before rows carried an address
  let st = begin();
  chain(() => 0.012);
  for (let i = 0; i < 20; i++) st.recent.push(paper(P1, "coin buyer Prov", i, 0.3));
  st.wallets[W1] = ws() as never;
  slow._test.follow([P1]);
  for (let i = 0; i < 6; i++) _test.state().rows.push(row("coin buyer Win1", i + 1, 0.002));
  _test.relist();
  assert.deepEqual(wallets().map((w) => [w.address, w.by]), [[P1, "paper"]]);
  assert.equal(slowLiveSummary().byWallet.find((x) => x.name === "coin buyer Win1")?.state, "address unknown", "no screen failed: it is not 'held back'");
  // a copy of it that is still out knows both its name and its address: it is kept, and that copy is not on the clock
  _test.state().opens.push(out(W1, "coin buyer Win1", B));
  _test.relist();
  assert.deepEqual(wallets().map((w) => [w.address, w.by]), [[W1, "real"], [P1, "paper"]]);
  assert.equal(_test.state().addr?.["coin buyer Win1"], W1, "written into the name book");
  const t1 = Date.now();
  sweep(t1);
  sweep(t1 + 7 * 3_600_000);
  await wait(200);
  assert.deepEqual([_test.state().opens.length, _test.state().opens[0].offMs], [1, undefined]);
  // the copy gone and still no row with an address: the name book has it
  _test.state().opens = [];
  _test.relist();
  assert.deepEqual(wallets().map((w) => w.address), [W1, P1]);
  const s1 = slowLiveSummary();
  assert.equal(s1.byWallet.find((x) => x.name === "coin buyer Win1")?.state, "kept on real");
  assert.ok(!JSON.stringify(s1).includes(W1) && !JSON.stringify(s1).includes(P1), "addresses stay out of the status");

  // 2. A wallet that turns loser is cut at once: the list is worked out again when a copy finishes
  st = begin();
  const c2 = chain(() => 0.004); // a sale brings back less than half the stake
  for (let i = 0; i < 20; i++) st.recent.push(paper(P1, "coin buyer Prov", i, 0.3));
  slow._test.follow([P1]);
  for (let i = 0; i < 4; i++) _test.state().rows.push(row("coin buyer Prov", i + 1, -0.001)); // four copies a little behind: paper still decides
  _test.relist();
  assert.deepEqual(wallets().map((w) => w.address), [P1]);
  onSwap(swap(P1, A, true));
  await wait(1500);
  assert.equal(_test.state().opens[0].stage, "held");
  onSwap(swap(P1, A, false));
  await wait(3000);
  assert.equal(_test.state().rows.length, 5);
  assert.equal(rested("coin buyer Prov"), true, "five copies, behind");
  onSwap(swap(P1, B, true)); // its next buy, seconds later: no minute's wait for the list
  assert.equal(_test.state().opens.length, 0, "cut at once");
  // and a copy already waiting for its entry when its wallet is cut is not bought
  st = begin();
  const c3 = chain(() => 0.012);
  for (let i = 0; i < 20; i++) st.recent.push(paper(P1, "coin buyer Prov", i, 0.3));
  slow._test.follow([P1]);
  for (let i = 0; i < 4; i++) _test.state().rows.push(row("coin buyer Prov", i + 1, -0.001));
  _test.relist();
  onSwap(swap(P1, A, true));
  assert.equal(_test.state().opens[0]?.stage, "waiting");
  _test.state().rows.push(row("coin buyer Prov", 0, -0.001)); // another copy of it is booked behind in that second
  await wait(1500);
  assert.deepEqual([_test.state().opens.length, c3.sends, c2.sends > 0], [0, 0, true], "not bought");

  // 3. The list is full: real winners come first, whoever lists them; the limit drops wallets with no real record
  st = begin();
  chain(() => 0.012);
  const many = Array.from({ length: 26 }, (_, k) => `Pap${String(k).padStart(2, "0")}${"1".repeat(39)}`);
  many.forEach((a, k) => {
    for (let i = 0; i < 20; i++) st.recent.push(paper(a, `coin buyer P${k}`, i, 0.3 + (26 - k) * 0.01)); // P0 best on paper, P25 last
  });
  slow._test.follow(many);
  st.wallets[W1] = ws() as never;
  for (let i = 0; i < 8; i++) _test.state().rows.push(row("coin buyer P25", i + 1, 0.01)); // last on paper, the biggest real winner
  for (let i = 0; i < 6; i++) _test.state().rows.push(row("coin buyer Win1", i + 1, 0.002, { wallet: W1 })); // off paper, a smaller one
  _test.relist();
  const full = wallets();
  assert.equal(full.length, 25);
  assert.deepEqual(full.slice(0, 4).map((w) => [w.name, w.by]), [["coin buyer P25", "paper"], ["coin buyer Win1", "real"], ["coin buyer P0", "paper"], ["coin buyer P1", "paper"]]);
  assert.deepEqual(["P22", "P23", "P24"].map((n) => full.some((w) => w.name === `coin buyer ${n}`)), [true, false, false]);

  // 3b. Round six under way is not six rounds failed: until it fails the copy is being sold, not lost
  st = begin();
  const c3b = chain(() => 0.012);
  st.wallets[W1] = ws() as never;
  for (let i = 0; i < 6; i++) _test.state().rows.push(row("coin buyer Win1", i + 1, 0.001, { wallet: W1 }));
  c3b.held.set(B, 1000n);
  _test.state().opens.push(out(W1, "coin buyer Win1", B, { exit: "sold", soldSeenMs: Date.now() - 50_000, sellRounds: 5, nextTryMs: Date.now() - 1000 }));
  _test.relist();
  sweep();
  const p3b = _test.state().opens[0];
  assert.deepEqual([p3b.stage, p3b.sellRounds, realOf("coin buyer Win1").n, rested("coin buyer Win1"), realWinner("coin buyer Win1")], ["selling", 6, 6, false, true], "round six under way: not a lost stake");
  for (let i = 0; i < 80 && _test.state().opens.length; i++) await wait(100);
  assert.deepEqual([_test.state().opens.length, realOf("coin buyer Win1").n, realWinner("coin buyer Win1")], [0, 7, true], "sold on the sixth round: a row, a winner still");

  // 4. A coin we cannot sell: no row is written until a sale goes through, but its wallet's record counts it as lost
  st = begin();
  chain(() => 0.012);
  st.wallets[W1] = ws() as never;
  for (let i = 0; i < 6; i++) _test.state().rows.push(row("coin buyer Win1", i + 1, 0.001, { wallet: W1 }));
  _test.relist();
  assert.deepEqual(wallets().map((w) => [w.name, w.by]), [["coin buyer Win1", "real"]]);
  _test.state().opens.push(out(W1, "coin buyer Win1", B, { exit: "sold", soldSeenMs: Date.now() - 50_000, sellRounds: 5, nextTryMs: Date.now() + 600_000 }));
  assert.equal(realOf("coin buyer Win1").n, 6, "five failed rounds: still being tried");
  assert.equal(resultOf(B, _test.state().opens[0].seenMs), undefined, "no result for the paper exit study yet");
  _test.state().opens[0].sellRounds = 6;
  assert.deepEqual(resultOf(B, _test.state().opens[0].seenMs), { netSol: -(0.01 + 0.00204), stakeSol: 0.01, heldMin: null, unsold: true }, "for the paper exit study: the stake lost");
  const r4 = realOf("coin buyer Win1");
  assert.deepEqual([r4.n, r4.won, Math.round(r4.netSol * 1e6)], [7, 6, Math.round((0.006 - 0.01 - 0.00204) * 1e6)]);
  assert.equal(rested("coin buyer Win1"), true);
  _test.relist();
  assert.deepEqual(wallets(), [], "no longer kept on its real record");
  assert.deepEqual(slowLiveSummary().byWallet.map((x) => [x.name, x.state, x.copies, x.last7.copies, x.open]), [["coin buyer Win1", "rested on real", 6, 7, 1]]);
  // the file after a restart that cut round six short (no sale of ours under way in this run): still a lost stake
  _test.state().opens[0].stage = "selling";
  assert.equal(realOf("coin buyer Win1").n, 7);
  // a restart tries it again (round seven): six rounds had failed before, so it stays a lost stake while that try runs
  _test.state().opens[0].stage = "held";
  const again = _test.sell(_test.state().opens[0], "sold");
  assert.equal(resultOf(B, _test.state().opens[0].seenMs), undefined, "a sale round under way: the study waits for how it ends");
  assert.deepEqual([_test.state().opens[0].sellRounds, realOf("coin buyer Win1").n, rested("coin buyer Win1")], [7, 7, true], "a later try under way: still a lost stake");
  await again;

  // 4b. A losing run: one old big winner does not carry a wallet through its newest 15 (three won, behind)
  st = begin();
  chain(() => 0.012);
  st.wallets[W1] = ws() as never;
  for (let i = 0; i < 20; i++) _test.state().rows.push(row("coin buyer Win1", 30 - i, i === 0 ? 0.06 : i < 5 ? 0.001 : i % 4 === 0 ? 0.002 : -0.004, { wallet: W1 }));
  const r4b = realOf("coin buyer Win1");
  assert.ok(r4b.n === 20 && r4b.netSol > 0.02, "ahead over the week");
  assert.deepEqual([losingRun("coin buyer Win1"), rested("coin buyer Win1"), realWinner("coin buyer Win1")], [true, true, false]);
  _test.relist();
  assert.deepEqual(wallets(), [], "not kept on its real record");
  assert.equal(slowLiveSummary().byWallet[0].state, "rested on real");
  // with its newest 15 ahead it is a winner again
  for (let i = 0; i < 6; i++) _test.state().rows.push(row("coin buyer Win1", 0, 0.006, { wallet: W1 }));
  assert.deepEqual([losingRun("coin buyer Win1"), rested("coin buyer Win1"), realWinner("coin buyer Win1")], [false, false, true]);

  // 5. Paper proves nobody and one wallet is kept on real: the dropped-wallet clock does not start for the others
  st = begin();
  const c5 = chain(() => 0.009);
  st.wallets[W1] = ws() as never;
  for (let i = 0; i < 6; i++) _test.state().rows.push(row("coin buyer Win1", i + 1, 0.002, { wallet: W1 }));
  slow._test.follow([]);
  c5.held.set(A, 1000n);
  _test.state().opens.push(out(P1, "coin buyer Prov", A));
  _test.relist();
  assert.deepEqual(wallets().map((w) => [w.address, w.by]), [[W1, "real"]]);
  const t5 = Date.now();
  sweep(t5);
  sweep(t5 + 7 * 3_600_000);
  await wait(300);
  assert.deepEqual([_test.state().opens.length, _test.state().opens[0].offMs], [1, undefined], "paper has nothing to say: nothing is sold as dropped");
  // paper lists a wallet again: the copy of the wallet nobody lists is on the clock from now
  for (let i = 0; i < 20; i++) st.recent.push(paper(P2, "coin buyer Pro2", i, 0.3));
  slow._test.follow([P2]);
  _test.relist();
  sweep(t5 + 8 * 3_600_000);
  assert.equal(_test.state().opens[0].offMs, t5 + 8 * 3_600_000);

  // 5b. Paper proves one wallet and that wallet is rested on real: the list is empty, yet paper has spoken, so the
  // open copies (of the rested wallet and of a wallet nobody lists) go on the clock and are sold six hours on
  st = begin();
  const c5b = chain(() => 0.009);
  for (let i = 0; i < 20; i++) st.recent.push(paper(P1, "coin buyer Prov", i, 0.3));
  slow._test.follow([P1]);
  for (let i = 0; i < 5; i++) _test.state().rows.push(row("coin buyer Prov", i + 1, -0.001));
  c5b.held.set(A, 1000n);
  c5b.held.set(B, 1000n);
  _test.state().opens.push(out(P1, "coin buyer Prov", A), out(P2, "coin buyer Pro2", B));
  _test.relist();
  assert.deepEqual([wallets(), rested("coin buyer Prov")], [[], true]);
  const t5b = Date.now();
  sweep(t5b);
  assert.deepEqual(_test.state().opens.map((p) => p.offMs), [t5b, t5b], "both on the clock");
  sweep(t5b + 7 * 3_600_000);
  for (let i = 0; i < 80 && _test.state().opens.length; i++) await wait(100);
  assert.deepEqual([_test.state().opens.length, _test.state().rows.slice(-2).map((x) => x.exit)], [0, ["wallet dropped", "wallet dropped"]]);
  slow._test.reset();
  slow._test.setCfg(null);
  _test.reset();
});

test("real day-holder copy: buys after the entry delay, sells after the wallet's first sale, counts from the chain", async () => {
  fresh();
  const c = chain(() => 0.012);
  onSwap(swap(L1, A, true));
  assert.equal(_test.state().opens.length, 1);
  assert.equal(_test.state().opens[0].stage, "waiting");
  await wait(1500);
  assert.equal(_test.state().opens[0].stage, "held");
  assert.equal(c.held.get(A), 1000n);
  // the wallet adds to it: not copied; a dust buy of another coin: not copied
  onSwap(swap(L1, A, true));
  onSwap(swap(L1, B, true, 0.05));
  assert.equal(_test.state().opens.length, 1);
  onSwap(swap(L1, A, false));
  await wait(3000);
  assert.equal(_test.state().opens.length, 0);
  assert.equal(c.held.has(A), false, "sold and its account closed");
  const row = _test.state().rows[0];
  assert.equal(row.exit, "sold");
  assert.equal(row.buy, "landed");
  // -(0.01 + fee + rent) + (0.012 - fee) + (rent - fee)
  assert.equal(row.netSol, (0.012e9 - 0.01e9 - 3 * FEE) / 1e9);
  assert.equal(_test.state().netSol, row.netSol);
  const s = slowLiveSummary();
  assert.equal(s.copies, 1);
  assert.equal(s.won, 1);
  assert.equal(s.byWallet[0].copies, 1);
  const text = JSON.stringify(s);
  assert.ok(!text.includes(A) && !text.includes(wallet().address) && !row.sigs.some((x) => text.includes(x)), "no coin, address or signature in the public summary");
});

test("real day-holder copy: a sale before our entry means no copy; same coin, cap, open and balance guards", async () => {
  fresh();
  let c = chain(() => 0.01);
  onSwap(swap(L1, A, true));
  onSwap(swap(L1, A, false));
  await wait(1300);
  assert.equal(c.quotes, 0);
  assert.equal(_test.state().skippedSold, 1);
  assert.equal(_test.state().opens.length, 0);
  // another of the wallets buying a coin we hold or wait for: let go
  onSwap(swap(L1, A, true));
  onSwap(swap(L2, A, true));
  assert.equal(_test.state().missedSame, 1);
  // a coin the real bucket trades hold (same wallet; a sale sells all of a coin) is not copied
  const { writeFileSync, rmSync } = await import("node:fs");
  const bucketFile = join(process.env.DATA_DIR!, "solana-bucketslive.json");
  writeFileSync(bucketFile, JSON.stringify({ opens: [{ mint: B, stage: "held" }] }));
  onSwap(swap(L1, B, true));
  assert.equal(_test.state().opens.some((p) => p.mint === B), false);
  assert.equal(_test.state().missedSame, 2);
  rmSync(bucketFile);
  // the cap must hold with every open copy lost in full: 0.026 SOL leaves room for two at 0.013 each
  fresh({ ...CFG, maxLossSol: 0.026 });
  c = chain(() => 0.01);
  onSwap(swap(L1, A, true));
  onSwap(swap(L1, B, true));
  onSwap(swap(L2, "C1ty111111111111111111111111111111111111111", true));
  assert.equal(_test.state().opens.length, 2);
  assert.equal(_test.state().missedCap, 1);
  // too many out
  fresh({ ...CFG, maxOpen: 1 });
  onSwap(swap(L1, A, true));
  onSwap(swap(L1, B, true));
  assert.equal(_test.state().missedOpen, 1);
  // too little SOL in the wallet: not bought, said in fixed words
  fresh();
  c = chain(() => 0.01, 0.011e9);
  onSwap(swap(L1, A, true));
  await wait(1300);
  assert.equal(c.quotes, 0);
  assert.equal(_test.state().missedLow, 1);
  assert.equal(_test.state().note, "wallet balance too low for a copy");
  // switched off or halted: nothing new
  fresh({ ...CFG, on: false });
  onSwap(swap(L1, A, true));
  assert.equal(_test.state().opens.length, 0);
  fresh();
  _test.state().halted = "loss cap reached";
  onSwap(swap(L1, A, true));
  assert.equal(_test.state().opens.length, 0);
  _test.reset();
});

test("real day-holder copy: the loss cap stops buying for good; a buy that never lands costs nothing", async () => {
  fresh({ ...CFG, maxLossSol: 0.013 });
  let c = chain(() => 0.0001);
  onSwap(swap(L1, A, true));
  await wait(1300);
  onSwap(swap(L1, A, false));
  await wait(2500);
  assert.equal(_test.state().rows.length, 1);
  assert.ok(_test.state().netSol < -0.0098);
  assert.match(_test.state().halted, /loss cap reached/);
  onSwap(swap(L1, B, true));
  assert.equal(_test.state().opens.length, 0);
  // a buy that is never seen on chain: once its time has surely run out, the wallet holds nothing, so no cost
  fresh();
  _test.setLaterLook(10);
  c = chain(() => 0.01);
  c.lost = true;
  const p = { wallet: L1, name: "x", mint: A, leaderSol: 0.3, seenMs: Date.now(), stage: "waiting" as const, sigs: [], sellRounds: 0 };
  _test.state().opens.push(p);
  await _test.buy(p);
  assert.equal(_test.state().rows[0].exit, "buy did not land");
  assert.equal(_test.state().rows[0].netSol, 0);
  assert.equal(_test.state().opens.length, 0);
  _test.reset();
});

test("real day-holder copy: max hold, failed sales tried again, and a restart finishes what was out", async () => {
  fresh();
  const c = chain(() => 0.011);
  // held past 72 h: sold by the sweep
  c.held.set(A, 1000n);
  _test.state().opens.push({ wallet: L1, name: "x", mint: A, leaderSol: 0.3, seenMs: Date.now() - 73 * 3_600_000, boughtMs: Date.now() - 73 * 3_600_000, stage: "held", sigs: [], sellRounds: 0 });
  sweep();
  await wait(1500);
  assert.equal(_test.state().rows.at(-1)!.exit, "max hold");
  // after a restart: a copy still waiting missed its entry; a coin being sold is sold; one whose sale went through is counted
  _test.reset();
  _test.setConfig(CFG);
  c.held.set(B, 1000n);
  _test.state().opens.push(
    { wallet: L1, name: "x", mint: "W8it111111111111111111111111111111111111111", leaderSol: 0.3, seenMs: Date.now(), stage: "waiting", sigs: [], sellRounds: 0 },
    { wallet: L2, name: "y", mint: B, leaderSol: 0.3, seenMs: Date.now() - 600_000, boughtMs: Date.now() - 590_000, soldSeenMs: Date.now() - 1000, exit: "sold", stage: "selling", sigs: [], sellRounds: 1 },
  );
  await recover();
  await wait(1500);
  assert.equal(_test.state().skippedSold, 1);
  assert.equal(_test.state().opens.length, 0);
  assert.equal(_test.state().rows.at(-1)!.exit, "sold while we were down");
  assert.equal(c.held.has(B), false);
  _test.reset();
});

test("real day-holder copy: a copy sold while the start's recovery is still on its list is sold once and counted once", async () => {
  fresh();
  const c = chain(() => 0.012);
  onSwap(swap(L1, A, true));
  onSwap(swap(L2, B, true));
  await wait(1500);
  const [pa, pb] = _test.state().opens;
  assert.deepEqual([pa.stage, pb.stage], ["held", "held"]);
  // the wallet sells A: our sale starts a second later; the recovery of a start runs right into it
  onSwap(swap(L1, A, false));
  while (pa.stage !== "selling") await wait(20);
  const sendsBefore = c.sends;
  await recover();
  assert.equal(pa.stage, "selling", "the recovery left the sale alone");
  await wait(3000);
  assert.equal(c.held.has(A), false);
  assert.deepEqual(_test.state().rows.map((x) => x.mint), [A], "one row for the one copy");
  assert.equal(_test.state().netSol, _test.state().rows[0].netSol);
  // one sale and one account close for A, nothing else sent
  assert.equal(c.sends - sendsBefore <= 2, true, `sends ${c.sends - sendsBefore}`);
  // asked twice, counted once; a recovery that still has a counted copy on its list adds nothing
  await _test.finish(wallet(), pa, "sold");
  assert.equal(_test.state().rows.length, 1);
  assert.equal(_test.state().opens.length, 1);
  assert.equal(slowLiveSummary().copies, 1);
});

test("real day-holder copy: an open copy whose wallet has been off the list for 6 hours is sold; back on the list or no list at all, it is kept", async () => {
  fresh({ ...CFG, follow: "proven" });
  const c = chain(() => 0.009);
  slow._test.reset();
  const P = ["Drop1111111111111111111111111111111111111111", "Drop2222222222222222222222222222222222222222", "Keep1111111111111111111111111111111111111111"];
  const st = slow._test.state();
  const paper = (wallet: string, i: number, back: number) => ({ wallet, name: `coin buyer ${wallet.slice(0, 5)}`, mint: `c${i}`, seenMs: i, leaderSol: 1, entries: { e5: "10", e30: null, e300: null, e1800: null }, exits: { "e5-x5": back }, closed: "sold" as const });
  for (const w of P) for (let i = 0; i < 20; i++) st.recent.push(paper(w, i, 0.3));
  slow._test.follow(P);
  assert.equal(wallets().length, 3);
  // any valid addresses do for coins here
  const coins = [A, B, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "ComputeBudget111111111111111111111111111111"];
  // Drop1 holds four coins, Keep one
  for (const m of coins.slice(0, 4)) onSwap(swap(P[0], m, true));
  onSwap(swap(P[2], coins[4], true));
  await wait(1800);
  assert.deepEqual(_test.state().opens.map((p) => p.stage), ["held", "held", "held", "held", "held"]);
  const t0 = Date.now();
  // the paper study has nothing (no list at all): no clock starts, nothing is sold however long it lasts
  slow._test.follow([]);
  _test.relist();
  sweep(t0);
  sweep(t0 + 7 * 3_600_000);
  assert.equal(_test.state().opens.filter((p) => p.offMs).length, 0);
  // Drop1 leaves the list: the clock starts at the first sweep that sees it; under 6 hours nothing is sold
  slow._test.follow([P[1], P[2]]);
  _test.relist();
  sweep(t0);
  assert.deepEqual(_test.state().opens.map((p) => !!p.offMs), [true, true, true, true, false]);
  assert.equal(slowLiveSummary().openOffList, 4);
  sweep(t0 + 5.9 * 3_600_000);
  await wait(300);
  assert.equal(_test.state().opens.length, 5);
  // back on the list for a moment: the clock is cleared and starts again
  slow._test.follow(P);
  _test.relist();
  sweep(t0 + 5.95 * 3_600_000);
  assert.equal(_test.state().opens.filter((p) => p.offMs).length, 0);
  slow._test.follow([P[1], P[2]]);
  _test.relist();
  sweep(t0 + 6 * 3_600_000);
  sweep(t0 + 11.9 * 3_600_000);
  await wait(300);
  assert.equal(_test.state().opens.length, 5, "six hours from the new start, not from the first");
  // six hours off the list: sold, three a sweep; the wallet still on the list keeps its copy
  _test.relist();
  sweep(t0 + 12 * 3_600_000 + 1);
  await wait(3500);
  assert.deepEqual(_test.state().rows.map((x) => x.exit), ["wallet dropped", "wallet dropped", "wallet dropped"]);
  assert.equal(_test.state().opens.length, 2);
  _test.relist();
  sweep(t0 + 12 * 3_600_000 + 300_000);
  await wait(3000);
  assert.deepEqual(_test.state().opens.map((p) => p.mint), [coins[4]]);
  assert.deepEqual(coins.map((m) => c.held.has(m)), [false, false, false, false, true], [...c.held].map(([k, v]) => `${k}:${v}`).join());
  const s = slowLiveSummary();
  assert.deepEqual([s.soldDropped, s.openOffList, s.copies, s.won], [4, 0, 4, 0]);
  // each: -(0.01 + fee + rent) + (0.009 - fee) + (rent - fee)
  assert.equal(_test.state().netSol, Math.round(4 * (0.009e9 - 0.01e9 - 3 * FEE)) / 1e9);
  slow._test.reset();
  slow._test.setCfg(null);
  _test.reset();
});

test("real day-holder copy: buys let go are written down and priced by the paper copy of the same buy, beside the ones taken; what fills the wallet", async () => {
  fresh({ ...CFG, maxOpen: 1 });
  chain(() => 0.012);
  slow._test.reset();
  const C = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const [n1, n2] = [WALLETS[0].name, WALLETS[1].name];
  const t0 = Date.now();
  // the first wallet buys A: taken. The second buys A too (we hold it): let go, "same". The first buys B and C: let go, one copy at most ("open").
  onSwap({ ...swap(L1, A, true), seenMs: t0 });
  onSwap({ ...swap(L2, A, true), seenMs: t0 + 1000 });
  onSwap({ ...swap(L1, B, true), seenMs: t0 + 2000 });
  onSwap({ ...swap(L1, C, true), seenMs: t0 + 3000 });
  assert.deepEqual(_test.state().missed!.map((x) => [x.n, x.m, x.w]), [[n2, A, "same"], [n1, B, "open"], [n1, C, "open"]]);
  await wait(1500);
  const o = openNow(Date.now() + 7 * 3_600_000);
  assert.deepEqual([o.onList, o.offList, o.under6h, o.h6to24, o.h24to48, o.over48h, o.saleNotThrough, o.stakeSol], [1, 0, 0, 1, 0, 0, 0, 0.01]);
  onSwap(swap(L1, A, false));
  await wait(3000);
  assert.equal(_test.state().rows.length, 1);
  // the paper copy saw the same four buys (0.25 SOL each; 0.3 back = +19.2%, 0.24 = -4.8%), and one older buy of the first wallet nobody took
  const paper = (name: string, mint: string, seenMs: number, back: number) => ({ wallet: name, name, mint, seenMs, leaderSol: 1, entries: { e5: "10", e30: null, e300: null, e1800: null }, exits: { "e5-x5": back } as Record<string, number | null>, closed: "sold" as const });
  slow._test.state().recent.push(paper(n1, A, t0 + 20, 0.3), paper(n2, A, t0 + 1010, 0.24), paper(n1, B, t0 + 2010, 0.3), paper(n1, C, t0 + 3010, 0.24), paper(n1, "old", t0 - 3_600_000, 0.3));
  const v = takenVsSkipped();
  assert.deepEqual([v.taken.n, v.taken.won, v.taken.avgRetPct, v.taken.real.won], [1, 1, 19.2, 1]);
  // the real copy of that buy: 0.012 back on 0.01 less three fees
  assert.ok(Math.abs(v.taken.real.avgRetPct! - 19.85) < 0.06, String(v.taken.real.avgRetPct));
  assert.deepEqual([v.same.n, v.same.won, v.same.avgRetPct], [1, 0, -4.8]);
  assert.deepEqual([v.open.n, v.open.won, v.open.avgRetPct, v.cap.n, v.low.n, v.missedWritten], [2, 1, 7.2, 0, 0, 3]);
  // before misses were written down: nothing here (the old paper copy is outside the wallet's real copies)
  assert.equal(v.notTakenBefore.n, 0);
  const s = slowLiveSummary();
  assert.ok(s.takenVsSkipped && s.openNow);
  const text = JSON.stringify(s);
  assert.ok(!text.includes(A) && !text.includes(C), "no coin in the public summary");
  // the estimate for the time before: with no misses written, a paper copy between a wallet's first and last real copy that has no real copy
  _test.state().missed = [];
  _test.state().rows.push({ ..._test.state().rows[0], t: t0 + 10_000, mint: "later" });
  const w = takenVsSkipped();
  assert.deepEqual([w.taken.n, w.notTakenBefore.n, w.notTakenBefore.won], [1, 2, 1]);
  slow._test.reset();
  slow._test.setCfg(null);
  _test.reset();
});

test("real day-holder copy: the slow study's stream hands over its wallets' swaps", async () => {
  fresh();
  chain(() => 0.01);
  startSlowLive();
  slow._test.reset();
  slow._test.setCfg({ rpcUrl: () => null, fetch: () => fetch, listed: () => [], busy: () => [], quote: async () => null });
  assert.ok(slow.slowWatch().includes(L1), "the stream carries the real copy's wallets");
  const tx = (payer: string, mint: string, buy: boolean, sol: number) => ({
    slot: 9,
    transaction: { message: { accountKeys: [payer] } },
    meta: { err: null, fee: 5000, preBalances: [100e9], postBalances: [100e9 + (buy ? -1 : 1) * sol * 1e9 - 5000], preTokenBalances: [{ mint, owner: payer, uiTokenAmount: { uiAmountString: "5000" } }], postTokenBalances: [{ mint, owner: payer, uiTokenAmount: { uiAmountString: String(5000 + (buy ? 1000 : -1000)) } }] },
  });
  slow.slowTx(tx("someone else", A, true, 1) as never);
  assert.equal(_test.state().opens.length, 0);
  slow.slowTx(tx(L1, A, true, 0.5) as never);
  assert.equal(_test.state().opens.length, 1);
  assert.equal(_test.state().opens[0].name, WALLETS[0].name);
  slow.slowTx(tx(L1, A, false, 0.6) as never);
  assert.equal(_test.state().opens.length, 0, "sold before our entry");
  assert.ok(slow.slowSummary().real, "the slow study's status carries the real copy");
  slow._test.reset();
  slow._test.setCfg(null);
  _test.reset();
});

test("real day-holder copy: a sale the stream missed is found by reading the wallet hourly", async () => {
  fresh();
  const c = chain(() => 0.011);
  c.held.set(A, 1000n);
  const t0 = Date.now() - 2 * 3_600_000;
  _test.state().opens.push({ wallet: L1, name: "x", mint: A, leaderSol: 0.3, seenMs: t0, boughtMs: t0, stage: "held", sigs: [], sellRounds: 0 });
  // nothing sold yet: read, stays
  sweep();
  await wait(800);
  assert.equal(_test.state().opens.length, 1);
  assert.ok(_test.state().opens[0].checkedMs);
  assert.equal(_test.state().credits, 10);
  // read again only after an hour; then the wallet's sale is there
  sweep();
  await wait(300);
  assert.equal(_test.state().credits, 10);
  _test.state().opens[0].checkedMs = Date.now() - 2 * 3_600_000;
  c.leaderTxs = [{ slot: 7, blockTime: Math.floor(Date.now() / 1000) - 600, transaction: { message: { accountKeys: [L1] } }, meta: { err: null, fee: 5000, preBalances: [100e9], postBalances: [100.5e9], preTokenBalances: [{ mint: A, owner: L1, uiTokenAmount: { uiAmountString: "5000" } }], postTokenBalances: [{ mint: A, owner: L1, uiTokenAmount: { uiAmountString: "0" } }] } }];
  sweep();
  await wait(2000);
  assert.equal(_test.state().opens.length, 0);
  assert.equal(_test.state().rows.at(-1)!.exit, "sold, seen late");
  _test.reset();
});

test("real day-holder copy: a buy left half-way by an error is settled from the wallet", async () => {
  fresh();
  const c = chain(() => 0.011);
  c.held.set(A, 1000n);
  _test.state().opens.push(
    { wallet: L1, name: "x", mint: A, leaderSol: 0.3, seenMs: Date.now() - 10 * 60_000, soldSeenMs: Date.now() - 1000, stage: "buying", sigs: [], sellRounds: 0 },
    { wallet: L2, name: "y", mint: B, leaderSol: 0.3, seenMs: Date.now() - 10 * 60_000, stage: "buying", sigs: [], sellRounds: 0 },
  );
  sweep();
  await wait(2000);
  // A came in and its wallet had sold: sold; B never came: counted and dropped
  assert.equal(_test.state().opens.length, 0);
  assert.deepEqual(_test.state().rows.map((r) => r.exit).sort(), ["buy did not land", "sold"]);
  _test.reset();
});

test("a copy counted twice is counted once at the next start, and only once", async () => {
  const { writeFileSync, readFileSync, mkdirSync } = await import("node:fs");
  const dir = process.env.DATA_DIR!;
  const row = (name: string, netSol: number, sigs: string[]) => ({ t: 1, name, mint: "m", leaderSlot: 0, buy: "landed", netSol, sigs });
  const rows = [row("a", 0.002, ["s1", "s2"]), row("b", -0.001292, ["s3", "s4"]), row("b", -0.001292, ["s4", "s3"]), row("c", -0.0005, [])];
  writeFileSync(join(dir, "solana-slowlive.json"), JSON.stringify({ netSol: -0.001084, halted: "", opens: [], rows }));
  mkdirSync(join(dir, "solana"), { recursive: true });
  writeFileSync(join(dir, "solana", "slowlive-trades.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  _test.reload();
  assert.equal(_test.state().rows.length, 3);
  assert.equal(_test.state().netSol, 0.000208);
  assert.equal(readFileSync(join(dir, "solana", "slowlive-trades.jsonl"), "utf8").trim().split("\n").length, 3);
  _test.reload();
  assert.equal(_test.state().rows.length, 3);
  assert.equal(_test.state().netSol, 0.000208);
  _test.reset();
});

// ---- 16 Nov 2026, after the review of the real-first rule: the follow-ups, each through the made-up chain -------------
test("real day-holder copy: a buy quote refused for asking too fast is asked again, twice at most; any other refusal is not", async () => {
  fresh();
  const c = chain(() => 0.012);
  const C1 = "W8it111111111111111111111111111111111111111";
  const C2 = "Mint2222222222222222222222222222222222222222";
  let no = 1;
  c.refuse = (kind) => (kind === "buy" && no-- > 0 ? { status: 429 } : null);
  onSwap(swap(L1, A, true));
  await wait(2200);
  assert.deepEqual([_test.state().opens[0]?.stage, _test.state().buyRefused, _test.state().notSent], ["held", 1, 0], "refused once, asked again, bought");
  assert.equal(_test.state().opens[0].tokens, "1000", "the amount the paper sale study asks its quotes for");
  // refused three times in a row: let go, and every refusal counted
  no = 3;
  onSwap(swap(L1, C1, true));
  await wait(2500);
  assert.deepEqual([_test.state().opens.length, _test.state().buyRefused, _test.state().notSent, no], [1, 4, 1, 0]);
  // a coin with no route: asked once, let go
  const q0 = c.quotes;
  c.refuse = (kind) => (kind === "buy" ? { status: 400, code: "COULD_NOT_FIND_ANY_ROUTE" } : null);
  onSwap(swap(L1, C2, true));
  await wait(1800);
  assert.deepEqual([_test.state().opens.length, c.quotes - q0, _test.state().buyRefused, _test.state().notSent], [1, 1, 4, 2]);
  const s = slowLiveSummary();
  assert.deepEqual([s.buyRefused, s.notSent, s.unsold], [4, 2, 0]);
  _test.reset();
});

test("real day-holder copy: a sale round lost to the network is not a failed sale; a coin given up as unsellable is still tried, and sold when a route comes back", async () => {
  // which errors say the SALE was refused, and which only that a request did not get through
  assert.deepEqual(
    ["no sell quote", "sale failed on the chain", "jupiter /swap/v1/quote http 400 COULD_NOT_FIND_ANY_ROUTE", "jupiter /swap/v1/swap http 400", "jupiter /swap/v1/swap http 422"].map((m) => saleRefused(new Error(m))),
    [true, true, true, true, true],
  );
  assert.deepEqual(
    ["jupiter /swap/v1/quote http 429", "jupiter /swap/v1/quote http 401", "jupiter /swap/v1/quote http 403", "jupiter /swap/v1/quote http 502", "rpc getTokenAccountsByOwner http 400", "The operation was aborted due to timeout", "fetch failed"].map((m) => saleRefused(new Error(m))),
    [false, false, false, false, false, false, false],
  );
  fresh();
  const c = chain(() => 0.012);
  const name = WALLETS[0].name;
  c.held.set(B, 1000n);
  _test.state().opens.push({ wallet: L1, name, mint: B, leaderSol: 0.3, seenMs: Date.now() - 600_000, boughtMs: Date.now() - 590_000, soldSeenMs: Date.now() - 1000, stakeSol: 0.01, stage: "held", sigs: [], sellRounds: 0 });
  const p = _test.state().opens[0];
  const who = { name, address: L1 };
  // 1. the price service refuses every ask of a round for asking too fast: nothing is learned about the coin
  c.refuse = (kind) => (kind === "sell" ? { status: 429 } : null);
  await _test.sell(p, "sold");
  assert.deepEqual([p.stage, p.sellRounds, p.failRounds, p.netRounds], ["held", 0, 0, 1], "sellRounds carries the failed rounds only (a rollback reads it so)");
  assert.ok(Math.abs(p.nextTryMs! - Date.now() - RETRY_MS) < 5000, "tried again ten minutes later");
  // rounds the network eats (up to NET_ROUNDS_FREE) do not count the coin as lost
  p.netRounds = 20;
  assert.deepEqual([realOf(who).n, slowLiveSummary().unsold, resultOf(B, p.seenMs)], [0, 0, undefined]);
  // 2. the sale lands and fails on the chain: that is the sale itself
  c.refuse = null;
  c.failSell = true;
  await _test.sell(p, "sold");
  assert.deepEqual([p.stage, p.sellRounds, p.failRounds, p.netRounds, c.held.get(B)], ["held", 1, 1, 20, 1000n]);
  c.failSell = false;
  // 3. no route, for the round that makes it GIVE_UP_ROUNDS: now the coin counts as a lost stake, and is tried again hours later
  p.failRounds = GIVE_UP_ROUNDS - 1;
  c.refuse = (kind) => (kind === "sell" ? { status: 400, code: "COULD_NOT_FIND_ANY_ROUTE" } : null);
  await _test.sell(p, "sold");
  assert.deepEqual([p.stage, p.failRounds], ["held", GIVE_UP_ROUNDS]);
  assert.ok(Math.abs(p.nextTryMs! - Date.now() - RETRY_UNSOLD_MS) < 5000, "tried again three hours later");
  assert.ok(Math.abs(p.unsoldMs! - Date.now()) < 5000, "the clock of an unsellable coin starts");
  const lost = realOf(who);
  assert.deepEqual([lost.n, lost.won, Math.round(lost.netSol * 1e6), slowLiveSummary().unsold], [1, 0, -Math.round((0.01 + 0.00204) * 1e6), 1]);
  assert.equal(resultOf(B, p.seenMs)?.unsold, true);
  // not before its time (a week after it was given up it is written off: see the next test)
  const q0 = c.quotes;
  sweep();
  await wait(300);
  assert.equal(c.quotes, q0);
  // a round of an unsellable coin is two tries, not six: a sale that lands and fails costs a fee each try
  c.refuse = null;
  c.failSell = true;
  const s0 = c.sends;
  await _test.sell(p, "sold");
  assert.deepEqual([c.txs.size, p.failRounds, c.sends > s0], [6 + 2, GIVE_UP_ROUNDS + 1, true]);
  c.failSell = false;
  // 4. hours later a route is back: the sweep's try sells it, and the record takes the real result in place of the lost stake
  c.refuse = null;
  p.nextTryMs = Date.now() - 1;
  sweep();
  for (let i = 0; i < 80 && _test.state().opens.length; i++) await wait(100);
  const row = _test.state().rows.at(-1)!;
  const after = realOf(who);
  assert.deepEqual([_test.state().opens.length, row.exit, row.buy, c.held.has(B)], [0, "sold", "landed", false]);
  assert.deepEqual([after.n, after.netSol, slowLiveSummary().unsold, resultOf(B, row.t)?.unsold], [1, row.netSol, 0, undefined]);
  _test.reset();
});

test("real day-holder copy: a margin around the zero line; two wallets under one screen name are kept apart; a winner a screen holds back stays on the watch", async () => {
  fresh({ ...CFG, follow: "proven" });
  chain(() => 0.012);
  slow._test.reset();
  const st = slow._test.state();
  const ws = (bot?: boolean) => ({ name: "w", doneAt: Date.now(), newest: 0, txPerDay: 10, buysPerDay: 2, spanDays: 30, ...(bot ? { bot } : {}), swaps: [], late: {} });
  const row = (name: string, i: number, netSol: number, wallet?: string) => ({ t: Date.now() - i * 60_000, name, ...(wallet ? { wallet } : {}), mint: "x", leaderSol: 1, buy: "landed" as const, exit: "sold" as const, heldMin: 60, netSol, sigs: [] as string[] });
  const rows = _test.state().rows;
  // 1. the margin: LEVEL_STAKES of a stake (0.001 SOL at the first stake, 0.01) either side of level is neither behind nor ahead
  const set = (net: number) => {
    rows.length = 0;
    for (let i = 0; i < 5; i++) rows.push(row("coin buyer Edge", i, i === 0 ? net : 0));
    return [rested("coin buyer Edge"), realWinner("coin buyer Edge")];
  };
  assert.deepEqual([set(-0.0012), set(-0.0008), set(0), set(0.0008), set(0.0012)], [[true, false], [false, false], [false, false], [false, false], [false, true]]);
  assert.equal(LEVEL_STAKES * oneStake("coin buyer Edge"), 0.001);
  rows.length = 0;
  // 2. two wallets the scan gave the same four letters: each has its own record, its own state and its own place on the list
  const S1 = "Same1111111111111111111111111111111111111111";
  const S2 = "Same2222222222222222222222222222222222222222";
  const H1 = "Hold1111111111111111111111111111111111111111";
  st.wallets[S1] = ws() as never;
  st.wallets[S2] = ws() as never;
  st.wallets[H1] = ws(true) as never; // filed as a program by the scan
  for (let i = 0; i < 6; i++) rows.push(row("coin buyer Same", i, 0.002, S1), row("coin buyer Same", i, -0.003, S2), row("coin buyer Hold", i, 0.004, H1));
  const [a, b] = [realOf({ name: "coin buyer Same", address: S1 }), realOf({ name: "coin buyer Same", address: S2 })];
  assert.deepEqual([a.n, a.won, b.n, b.won], [6, 6, 6, 0]);
  assert.deepEqual([realWinner({ name: "coin buyer Same", address: S1 }), rested({ name: "coin buyer Same", address: S1 }), realWinner({ name: "coin buyer Same", address: S2 }), rested({ name: "coin buyer Same", address: S2 })], [true, false, false, true]);
  _test.relist();
  assert.deepEqual(wallets().map((w) => [w.address, w.by]), [[S1, "real"]], "the winner of the two is kept; the loser and the program are not");
  const s = slowLiveSummary();
  assert.deepEqual(s.byWallet.map((x) => [x.name, x.state, x.copies, x.won]).sort(), [["coin buyer Hold", "held back", 6, 6], ["coin buyer Same", "kept on real", 6, 6], ["coin buyer Same", "rested on real", 6, 0]]);
  assert.ok(![S1, S2, H1].some((x) => JSON.stringify(s).includes(x)), "names only in the public summary");
  // the winner's buy is copied, the loser's is not, though both carry the same name
  onSwap(swap(S2, B, true));
  onSwap(swap(H1, B, true));
  assert.equal(_test.state().opens.length, 0, "the loser of the two, and the winner a screen holds back: not copied");
  onSwap(swap(S1, A, true));
  assert.equal(_test.state().opens.length, 1);
  // 3. the held-back winner is not copied, but the scan keeps reading it daily: the day its screen clears it is copied at once
  startSlowLive();
  slow._test.setCfg({ rpcUrl: () => null, fetch: () => fetch, listed: () => [], busy: () => [], quote: async () => null });
  assert.deepEqual([S1, H1, S2].map((x) => slow.slowWatch().includes(x)), [true, true, false]);
  st.wallets[H1] = ws() as never;
  _test.relist();
  assert.deepEqual(wallets().map((w) => w.address).sort(), [H1, S1].sort());
  await wait(1500);
  slow._test.reset();
  slow._test.setCfg(null);
  _test.reset();
});

test("real day-holder copy and the paper sale study, end to end: bought, polled, sold, and every rule scored against what the copy really made", async () => {
  fresh();
  const c = chain(() => 0.012);
  exits._test.reset();
  exits.setExitSource({ held: heldCopies, resultOf });
  // what the study's sell quote says at each poll, SOL for the 1000 tokens bought with 0.01: +60%, then +25%
  const polls = [0.016, 0.0125];
  const asked: string[] = [];
  exits._test.setQuote(async (mint, _out, amount) => {
    asked.push(`${mint}|${amount}`);
    return BigInt(Math.round(polls.shift()! * 1e9));
  });
  onSwap(swap(L1, A, true));
  await wait(1500);
  assert.deepEqual(heldCopies().map((h) => [h.mint, h.stakeSol, h.tokens]), [[A, 0.01, "1000"]]);
  const now = Date.now();
  await exits.tick(now);
  await exits.tick(now + exits.POLL_MS);
  assert.deepEqual(asked, [`${A}|1000`, `${A}|1000`]);
  assert.deepEqual([exits.slowExitsSummary().open.n, exits.slowExitsSummary().copies], [1, 0]);
  // the copied wallet sells: ours is sold for 0.012 (+20% before fees) and its row is written
  onSwap(swap(L1, A, false));
  await wait(3000);
  const row = _test.state().rows[0];
  assert.deepEqual([_test.state().opens.length, row.exit, heldCopies().length], [0, "sold", 0]);
  assert.deepEqual(resultOf(A, row.t), { netSol: row.netSol, stakeSol: 0.01, heldMin: row.heldMin, exit: "sold" });
  await exits.tick(now + 2 * exits.POLL_MS);
  const s = exits.slowExitsSummary();
  assert.deepEqual([s.copies, s.open.n, s.real.won, s.real.netSol], [1, 0, 1, row.netSol]);
  const by = Object.fromEntries(s.rules.map((r) => [r.id, r]));
  // sold at +50% would have kept the +60% of the first poll; the +100% line was never reached
  assert.deepEqual([by["take-50"].fired, by["take-100"].fired, by["stop-30"].fired], [1, 0, 0]);
  assert.ok(by["take-50"].vsRealSol > 0.003, "the take-profit beats the real sale here");
  // the summary slowlive publishes carries the same study
  assert.equal(slowLiveSummary().exits?.copies, 1);
  exits.setExitSource(null);
  exits._test.reset();
  _test.reset();
});

test("real day-holder copy: after a sale on our own clock the copied wallet's sale is still listened for, for the paper sale study, and nothing is copied because of it", async () => {
  fresh();
  const c = chain(() => 0.011);
  const X = "Drop1111111111111111111111111111111111111111";
  c.held.set(B, 1000n);
  const seenMs = Date.now() - 73 * 3_600_000;
  _test.state().opens.push({ wallet: X, name: "coin buyer Drop", mint: B, leaderSol: 0.3, seenMs, boughtMs: seenMs, stakeSol: 0.01, tokens: "1000", stage: "held", sigs: [], sellRounds: 0 });
  assert.equal(afterOf(B, seenMs), undefined, "held: not followed after anything");
  sweep();
  for (let i = 0; i < 80 && _test.state().opens.length; i++) await wait(100);
  assert.deepEqual([_test.state().opens.length, _test.state().rows.at(-1)!.exit, resultOf(B, seenMs)?.exit], [0, "max hold", "max hold"]);
  // sold by us, the copied wallet still holding: its sale is listened for
  assert.equal(afterOf(B, seenMs), "holds");
  startSlowLive();
  slow._test.setCfg({ rpcUrl: () => null, fetch: () => fetch, listed: () => [], busy: () => [], quote: async () => null });
  assert.equal(slow.slowWatch().includes(X), true, "its wallet stays on the watch though no copy of it is out");
  // a buy of that wallet is not copied: it is not on the list
  onSwap(swap(X, A, true));
  assert.equal(_test.state().opens.length, 0);
  // it sells another coin: not the one; then the coin
  onSwap(swap(X, A, false));
  assert.equal(afterOf(B, seenMs), "holds");
  onSwap(swap(X, B, false));
  assert.deepEqual([afterOf(B, seenMs), slow.slowWatch().includes(X), _test.state().opens.length, _test.state().rows.length], ["sold", false, 0, 1]);
  // never heard selling: after AFTER_MAX_MS it is no longer followed, nor watched
  _test.state().after = [{ wallet: X, mint: B, seenMs, ms: Date.now() - AFTER_MAX_MS - 1 }];
  assert.deepEqual([afterOf(B, seenMs), slow.slowWatch().includes(X)], [undefined, false]);
  // a copy sold after the wallet's own sale is not followed
  c.held.set(A, 1000n);
  _test.state().opens.push({ wallet: L1, name: WALLETS[0].name, mint: A, leaderSol: 0.3, seenMs: seenMs + 1, boughtMs: Date.now() - 60_000, stakeSol: 0.01, tokens: "1000", stage: "held", sigs: [], sellRounds: 0 });
  onSwap(swap(L1, A, false));
  await wait(3000);
  assert.deepEqual([_test.state().rows.at(-1)!.exit, afterOf(A, seenMs + 1)], ["sold", undefined]);
  assert.ok(!JSON.stringify(slowLiveSummary()).includes(X), "nothing of it in the public summary");
  slow._test.reset();
  slow._test.setCfg(null);
  _test.reset();
});

test("real day-holder copy: with sellCut on, the open copies of a wallet cut on its real record are sold at the second sweep; off, they wait", async () => {
  assert.deepEqual([parseSlowLive(JSON.stringify({ solanaSlow: { on: true, maxLossSol: 0.1 } })).sellCut, parseSlowLive(JSON.stringify({ solanaSlow: { on: true, maxLossSol: 0.1, sellCut: true } })).sellCut, parseSlowLive(JSON.stringify({ solanaSlow: { on: true, maxLossSol: 0.1, sellCut: "yes" } })).sellCut], [false, true, false]);
  const name = WALLETS[0].name;
  const row = (i: number, netSol: number) => ({ t: Date.now() - i * 60_000, name, wallet: L1, mint: "x", leaderSol: 1, buy: "landed" as const, exit: "sold" as const, heldMin: 60, netSol, sigs: [] as string[] });
  const out = (wallet: string, n: string, mint: string, seenMs: number) => ({ wallet, name: n, mint, leaderSol: 0.3, seenMs, boughtMs: seenMs, stakeSol: 0.01, tokens: "1000", stage: "held" as const, sigs: [] as string[], sellRounds: 0 });
  for (const sellCut of [false, true]) {
    fresh({ ...CFG, sellCut });
    const c = chain(() => 0.009);
    c.held.set(A, 1000n);
    c.held.set(B, 1000n);
    const t = Date.now() - 3_600_000;
    // L1 is behind on five real copies (cut); L2 has no record. One copy of each is out
    for (let i = 0; i < 5; i++) _test.state().rows.push(row(i + 1, -0.002));
    _test.state().opens.push(out(L1, name, A, t), out(L2, WALLETS[1].name, B, t + 1));
    assert.equal(rested({ name, address: L1 }), true);
    // it must be so at two sweeps: the first only notes it
    sweep();
    await wait(300);
    assert.equal(_test.state().opens.length, 2, "one sweep sells nothing");
    sweep(Date.now() + CUT_HOLD_MS);
    for (let i = 0; i < 60 && _test.state().opens.length > 1; i++) await wait(100);
    const s = slowLiveSummary();
    if (!sellCut) {
      assert.deepEqual([_test.state().opens.length, s.sellCut, s.soldCut], [2, false, 0], "off: both wait");
    } else {
      assert.deepEqual([_test.state().opens.map((p) => p.mint), _test.state().rows.at(-1)!.exit, s.sellCut, s.soldCut], [[B], "wallet cut", true, 1], "on: the cut wallet's copy is sold, the other is kept");
      assert.equal(afterOf(A, t), "holds", "and the paper sale study follows it until the copied wallet sells");
    }
    _test.reset();
  }
});

// ---- 16 Nov 2026, the review of the batch (f34e2b28 .. 06a09788): each through the made-up chain --------------------
test("real day-holder copy: a buy is not sent when its wallet sells while the quote is asked again after a 429", async () => {
  fresh();
  const c = chain(() => 0.012);
  let no = 1;
  c.refuse = (kind) => (kind === "buy" && no-- > 0 ? { status: 429 } : null);
  onSwap(swap(L1, A, true));
  // the entry is a second after the wallet's buy; the 429 makes the buy wait 200 ms, and the wallet sells in that wait
  for (let i = 0; i < 60 && c.quotes === 0; i++) await wait(25);
  onSwap(swap(L1, A, false));
  await wait(1500);
  const st = _test.state();
  assert.deepEqual([st.opens.length, c.sends, c.held.get(A) ?? 0n, st.skippedSold, st.notSent, st.rows.length, st.buyRefused], [0, 0, 0n, 1, 0, 0, 1], "nothing sent, nothing held, counted once");
  _test.reset();
});

test("real day-holder copy: with sellCut on, a wallet is sold out only when it is cut at two sweeps in a row", async () => {
  const name = WALLETS[0].name;
  const who = { name, address: L1 };
  const row = (i: number, netSol: number) => ({ t: Date.now() - i * 60_000, name, wallet: L1, mint: "x", leaderSol: 1, buy: "landed" as const, exit: "sold" as const, heldMin: 60, netSol, sigs: [] as string[] });
  fresh({ ...CFG, sellCut: true });
  const c = chain(() => 0.009);
  c.held.set(A, 1000n);
  const t = Date.now() - 3_600_000;
  _test.state().opens.push({ wallet: L1, name, mint: A, leaderSol: 0.3, seenMs: t, boughtMs: t, stakeSol: 0.01, tokens: "1000", stage: "held", sigs: [], sellRounds: 0, failRounds: 0 });
  for (let i = 0; i < 4; i++) _test.state().rows.push(row(i + 2, 0.001));
  // 1. cut at one sweep (a copy just finished behind), back by the next (the next one finished ahead): nothing sold
  _test.state().rows.push(row(1, -0.02));
  assert.equal(rested(who), true);
  const t0 = Date.now();
  sweep(t0);
  _test.state().rows.pop();
  assert.equal(rested(who), false);
  sweep(t0 + CUT_HOLD_MS);
  // cut again: a new spell, counted from its own start
  _test.state().rows.push(row(1, -0.02));
  sweep(t0 + CUT_HOLD_MS + 1);
  await wait(300);
  assert.deepEqual([_test.state().opens.length, c.sends], [1, 0], "no sale on one look");
  // 2. cut at two sweeps in a row: sold
  sweep(t0 + 2 * CUT_HOLD_MS + 1);
  for (let i = 0; i < 60 && _test.state().opens.length; i++) await wait(100);
  assert.deepEqual([_test.state().opens.length, _test.state().rows.at(-1)!.exit, slowLiveSummary().soldCut], [0, "wallet cut", 1]);
  assert.equal(cutClearly({ name: "nobody" }), false);
  _test.reset();
});

test("real day-holder copy: a restart is not one more sale round; a copy whose sale failed waits for its time, and not past its week", async () => {
  fresh();
  const c = chain(() => 0.012);
  const name = WALLETS[0].name;
  c.held.set(B, 1000n);
  c.refuse = (kind) => (kind === "sell" ? { status: 400, code: "COULD_NOT_FIND_ANY_ROUTE" } : null);
  _test.state().opens.push({ wallet: L1, name, mint: B, leaderSol: 0.3, seenMs: Date.now() - 600_000, boughtMs: Date.now() - 590_000, soldSeenMs: Date.now() - 1000, stakeSol: 0.01, stage: "held", sigs: [], sellRounds: 0, failRounds: 0 });
  const p = _test.state().opens[0];
  await _test.sell(p, "sold");
  assert.deepEqual([p.stage, p.failRounds, p.exit], ["held", 1, "sold"]);
  // four restarts in a row before its time: no round
  const q0 = c.quotes;
  for (let k = 0; k < 4; k++) await recover();
  assert.deepEqual([c.quotes, p.failRounds, p.sellRounds], [q0, 1, 1]);
  // its time has come: the restart tries it
  p.nextTryMs = Date.now() - 1;
  await recover();
  for (let i = 0; i < 100 && p.failRounds === 1; i++) await wait(100);
  assert.deepEqual([p.failRounds, p.sellRounds], [2, 2]);
  // a week after it was given up: not even at its time
  p.unsoldMs = Date.now() - UNSOLD_DAYS * 86_400_000 - 1;
  p.nextTryMs = Date.now() - 1;
  const q1 = c.quotes;
  await recover();
  await wait(300);
  assert.equal(c.quotes, q1);
  _test.reset();
});

test("real day-holder copy: rounds the network eats are free only for a while; a coin unsold for a week is written off and frees its place", async () => {
  fresh();
  const c = chain(() => 0.012);
  const name = WALLETS[0].name;
  const who = { name, address: L1 };
  c.held.set(B, 1000n);
  // bought for real: its buy transaction is on the books
  _test.state().opens.push({ wallet: L1, name, mint: B, leaderSol: 0.3, seenMs: Date.now() - 600_000, boughtMs: Date.now() - 590_000, soldSeenMs: Date.now() - 1000, stakeSol: 0.01, stage: "held", sigs: ["buy1"], sellRounds: 0, failRounds: 0 });
  c.txs.set("buy1", { pre: c.lamports + 0.01e9 + FEE + RENT, post: c.lamports, ok: true });
  const p = _test.state().opens[0];
  // 1. the network eats every round: free up to NET_ROUNDS_FREE, each one after that counts as failed
  c.refuse = (kind) => (kind === "sell" ? { status: 503 } : null);
  p.netRounds = NET_ROUNDS_FREE - 1;
  await _test.sell(p, "sold");
  assert.deepEqual([p.netRounds, p.failRounds, p.sellRounds], [NET_ROUNDS_FREE, 0, 0]);
  await _test.sell(p, "sold");
  assert.deepEqual([p.netRounds, p.failRounds, p.sellRounds], [NET_ROUNDS_FREE + 1, 1, 1]);
  p.failRounds = p.sellRounds = GIVE_UP_ROUNDS - 1;
  await _test.sell(p, "sold");
  assert.deepEqual([p.failRounds, p.sellRounds, !!p.unsoldMs, slowLiveSummary().unsold], [GIVE_UP_ROUNDS, GIVE_UP_ROUNDS, true, 1], "given up: a lost stake, tried every few hours");
  assert.equal(realOf(who).n, 1);
  // 2. a week later: written off from its own transactions, no sale tried; its place and cap room are free again
  const q0 = c.quotes;
  sweep(p.unsoldMs! + UNSOLD_DAYS * 86_400_000 + 1);
  for (let i = 0; i < 80 && _test.state().opens.length; i++) await wait(100);
  const row = _test.state().rows.at(-1)!;
  assert.deepEqual([_test.state().opens.length, c.quotes, row.exit, row.buy, c.held.get(B)], [0, q0, "written off", "landed", 1000n]);
  assert.equal(row.netSol, -(0.01e9 + FEE + RENT) / 1e9, "the stake, its fee and the coin account's rent: what its own transactions say");
  assert.equal(_test.state().netSol, row.netSol);
  const r = realOf(who);
  assert.deepEqual([r.n, r.won, r.netSol, slowLiveSummary().unsold, slowLiveSummary().writtenOff], [1, 0, row.netSol, 0, 1]);
  assert.deepEqual(resultOf(B, row.t), { netSol: row.netSol, stakeSol: 0.01, heldMin: row.heldMin, exit: "written off" });
  _test.reset();
});

test("the scan: a wallet on the real watch is re-read daily whatever it was filed as (a held-back winner filed as a bot)", () => {
  slow._test.reset();
  const st = slow._test.state();
  const H = "Hold1111111111111111111111111111111111111111";
  const N = "Bot21111111111111111111111111111111111111111";
  const twoDays = Date.now() - 2 * 86_400_000;
  st.candidates = [{ address: H }, { address: N }] as never;
  st.wallets[H] = { name: "w", doneAt: twoDays, newest: 0, txPerDay: 900, buysPerDay: 300, spanDays: 30, bot: true, swaps: [], late: {} } as never;
  st.wallets[N] = { name: "w", doneAt: twoDays, newest: 0, txPerDay: 900, buysPerDay: 300, spanDays: 30, bot: true, swaps: [], late: {} } as never;
  slow.onSlowSwap(() => [H], () => undefined);
  assert.deepEqual(slow._test.dueWallets().map((c: { address: string }) => c.address), [H], "the watched bot is due after a day; the other bot waits its 30 days");
  slow.onSlowSwap(() => [], () => undefined);
  slow._test.reset();
});

test("real day-holder copy, caps only: wallets from the replay of their past mid and high cap trips, and only coins over the floor", async () => {
  fresh({ ...CFG, follow: "proven", capOnly: true });
  chain(() => 0.012);
  slow._test.reset();
  const CW = "CapW1111111111111111111111111111111111111111";
  const CAP = "CapA1111111111111111111111111111111111111";
  const MEME = "Meme1111111111111111111111111111111111111";
  const st = slow._test.state();
  const now = Date.now();
  const t = Math.floor(now / 1000) - 20 * 86_400;
  st.caps = { [CAP]: { mcap: 2e8, liq: 3e6, createdMs: now - 100 * 86_400_000, at: now }, [MEME]: { mcap: 3e6, liq: 1e5, createdMs: now - 100 * 86_400_000, at: now } };
  const swaps: [number, number, string, 0 | 1, number, number][] = [];
  const late: Record<string, { e5: number; x5: number }> = {};
  for (let i = 0; i < 12; i++) {
    swaps.push([t + i * 40_000, 1000 + i * 100, CAP, 1, 1, 1000], [t + i * 40_000 + 7200, 1050 + i * 100, CAP, 0, 1.1, 1000]);
    late[`${CAP}|${1000 + i * 100}`] = { e5: 0.001, x5: i % 4 === 3 ? 0.00095 : 0.00115 };
  }
  st.wallets[CW] = { name: "coin buyer CapW", doneAt: now, newest: t + 12 * 40_000, txPerDay: 2, buysPerDay: 1, spanDays: 30, swaps, late };
  st.candidates.push({ name: "coin buyer CapW", address: CW, source: "coin" });
  // a wallet proven on paper is not copied on caps only
  for (let i = 0; i < 20; i++) st.recent.push({ wallet: L1, name: WALLETS[0].name, mint: `c${i}`, seenMs: i, leaderSol: 1, entries: { e5: "10" }, exits: { "e5-x5": 0.3 }, closed: "sold" as const });
  slow._test.follow([L1]);
  // a wallet ahead on its real memecoin copies is not copied on caps only either: it has not passed the cap replay
  st.wallets[L2] = { name: "w", doneAt: now, newest: 0, txPerDay: 10, buysPerDay: 2, spanDays: 30, swaps: [], late: {} } as never;
  const rows = _test.state().rows;
  for (let i = 0; i < 6; i++) rows.push({ t: now - i * 60_000, name: "coin buyer Win9", wallet: L2, mint: "x", leaderSol: 1, buy: "landed" as const, exit: "sold" as const, heldMin: 60, netSol: 0.004, sigs: [] as string[] });
  assert.equal(realWinner({ name: "coin buyer Win9", address: L2 }), true);
  _test.relist();
  assert.deepEqual(wallets().map((w) => w.address), [CW]);
  rows.length = 0;
  onSwap(swap(CW, MEME, true));
  assert.equal(_test.state().opens.length, 0, "a memecoin is not copied");
  assert.equal(_test.state().notCap, 1);
  onSwap(swap(CW, CAP, true));
  assert.equal(_test.state().opens.length, 1, "a coin over the floor is");
  assert.equal(slowLiveSummary().capOnly, true);
  assert.equal(parseSlowLive(JSON.stringify({ solanaSlow: { on: true, maxLossSol: 1, stakeSol: 0.02, capOnly: true } })).capOnly, true);
  assert.equal(parseSlowLive(JSON.stringify({ solanaSlow: { on: true, maxLossSol: 1, stakeSol: 0.02 } })).capOnly, false);
  _test.reset();
  slow._test.reset();
});

test("real day-holder copy, caps only: a bigger stake ceiling, and SOL kept back for gas is never spent", async () => {
  // the stake ceiling: 0.1 SOL on caps only, 0.05 otherwise
  assert.equal(parseSlowLive(JSON.stringify({ solanaSlow: { on: true, maxLossSol: 1, stakeSol: 0.1, capOnly: true, gasKeepSol: 0.05, maxOpen: 8 } })).stakeSol, 0.1);
  assert.equal(parseSlowLive(JSON.stringify({ solanaSlow: { on: true, maxLossSol: 1, stakeSol: 0.1 } })).stakeSol, 0.05);
  assert.equal(parseSlowLive(JSON.stringify({ solanaSlow: { on: true, maxLossSol: 1, stakeSol: 0.5, capOnly: true } })).stakeSol, 0.1);
  assert.equal(parseSlowLive(JSON.stringify({ solanaSlow: { on: true, maxLossSol: 1, stakeSol: 0.1, capOnly: true, gasKeepSol: 5 } })).gasKeepSol, 0.2);
  assert.equal(parseSlowLive(JSON.stringify({ solanaSlow: { on: true, maxLossSol: 1, stakeSol: 0.1, capOnly: true, maxOpen: 8 } })).maxOpen, 8);
  const run = async (gasKeepSol: number) => {
    fresh({ ...CFG, follow: "proven", capOnly: true, gasKeepSol });
    chain(() => 0.012); // 0.08 SOL in the wallet
    slow._test.reset();
    const CW = "CapW1111111111111111111111111111111111111111";
    const CAP = "CapA1111111111111111111111111111111111111";
    const st = slow._test.state();
    const now = Date.now();
    const t = Math.floor(now / 1000) - 20 * 86_400;
    st.caps = { [CAP]: { mcap: 2e8, liq: 3e6, createdMs: now - 100 * 86_400_000, at: now } };
    const swaps: [number, number, string, 0 | 1, number, number][] = [];
    const late: Record<string, { e5: number; x5: number }> = {};
    for (let i = 0; i < 12; i++) {
      swaps.push([t + i * 40_000, 1000 + i * 100, CAP, 1, 1, 1000], [t + i * 40_000 + 7200, 1050 + i * 100, CAP, 0, 1.1, 1000]);
      late[`${CAP}|${1000 + i * 100}`] = { e5: 0.001, x5: i % 4 === 3 ? 0.00095 : 0.00115 };
    }
    st.wallets[CW] = { name: "coin buyer CapW", doneAt: now, newest: t + 12 * 40_000, txPerDay: 2, buysPerDay: 1, spanDays: 30, swaps, late };
    st.candidates.push({ name: "coin buyer CapW", address: CW, source: "coin" });
    onSwap(swap(CW, CAP, true));
    await wait(1500);
    const s = _test.state();
    const r = { opens: s.opens.length, low: s.missedLow };
    _test.reset();
    slow._test.reset();
    return r;
  };
  // 0.08 SOL: a 0.01 copy with its rent and sale reserve fits, but not with 0.075 kept for gas
  assert.deepEqual(await run(0.075), { opens: 0, low: 1 });
  assert.deepEqual(await run(0.05), { opens: 1, low: 0 });
});
