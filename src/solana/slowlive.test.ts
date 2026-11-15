import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// a scratch folder: the wallet these tests sign with is made there, never in the real data folder
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "slowlive-"));
// made-up keys: every network call here is faked
process.env.HELIUS_API_KEY = "test-helius";
process.env.JUPITER_API_KEY = "test-jupiter";
const { parseSlowLive, slowLiveSummary, onSwap, sweep, recover, startSlowLive, wallets, rested, HARD_MAX_LOSS_SOL, HARD_STAKE_SOL, HARD_MAX_OPEN, WALLETS, _test } = await import("./slowlive.js");
const { _test: run } = await import("./copyrun.js");
const { buildSigned, wallet } = await import("./keys.js");
const { base58 } = await import("./whirlpool.js");
const slow = await import("./slow.js");
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
const CFG: Cfg = { on: true, stakeSol: 0.01, maxLossSol: 0.1, maxOpen: 6, entrySec: 1, exitSec: 1, maxHoldH: 72, slippageBps: 1500, maxFeeLamports: 20_000, follow: "fixed" };

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
        const ok = (c.held.get(b.mint) ?? 0n) > 0n;
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
  const c = parseSlowLive(JSON.stringify({ solanaSlow: { on: true, maxLossSol: 9, stakeSol: 9, maxOpen: 99, entrySec: 0, exitSec: 999, slippageBps: 1e6, maxFeeLamports: 1e12 } }));
  assert.deepEqual([c.on, c.maxLossSol, c.stakeSol, c.maxOpen, c.entrySec, c.exitSec, c.slippageBps, c.maxFeeLamports], [true, HARD_MAX_LOSS_SOL, HARD_STAKE_SOL, HARD_MAX_OPEN, 1, 60, 3000, 200_000]);
  const d = parseSlowLive(JSON.stringify({ solanaSlow: { on: true, maxLossSol: 0.08 } }));
  assert.deepEqual([d.stakeSol, d.maxOpen, d.entrySec, d.exitSec, d.maxHoldH, d.maxFeeLamports], [0.01, HARD_MAX_OPEN, 5, 5, 72, 20_000]);
  assert.equal(HARD_MAX_LOSS_SOL, 0.6, "the whole wallet: no more than it may hold");
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
  // rested: its newest 15 real copies of the last 7 days lost SOL with under half won; older ones do not count
  const row = (name: string, t: number, netSol: number) => ({ t, name, mint: "x", leaderSol: 1, buy: "landed" as const, exit: "sold" as const, heldMin: 60, netSol, sigs: [] });
  const now = Date.now();
  for (let i = 0; i < 15; i++) _test.state().rows.push(row("coin buyer Pro2", now - i * 60_000, i < 7 ? 0.001 : -0.002));
  assert.equal(rested("coin buyer Pro2"), true);
  _test.relist();
  assert.deepEqual(wallets(), []);
  onSwap(swap(P2, B, true));
  assert.equal(_test.state().opens.length, 0, "rested: not copied");
  const s = slowLiveSummary();
  assert.deepEqual([s.follow, s.wallets, s.rested], ["proven", [], ["coin buyer Pro2"]]);
  assert.ok(!JSON.stringify(s).includes(P1) && !JSON.stringify(s).includes(P2), "names only in the public summary");
  // half won, or its bad copies over a week old: not rested
  _test.state().rows[_test.state().rows.length - 1].netSol = 0.001;
  assert.equal(rested("coin buyer Pro2"), false);
  assert.equal(rested("coin buyer Pro2", now + 8 * 86_400_000), false);
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
