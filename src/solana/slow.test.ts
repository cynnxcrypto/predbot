import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "solslow-"));

const { tripsOf, screen, lateRet, ownRet, priceAfter, posRet, paperRules, slowTx, slowSummary, reportOf, followed, slowWatch, _test, STAKE_SOL, TX_SOL, DELAY_COST, MIN_TRIPS } = await import("./slow.js");

const W = "Wa11et1111111111111111111111111111111111111";
const M = "M1nt11111111111111111111111111111111111111";
const SOLM = "So11111111111111111111111111111111111111112";
type Sw = { t: number; slot: number; mint: string; buy: boolean; sol: number; tokens: number };
const sw = (o: Partial<Sw>): Sw => ({ t: 1_800_000_000, slot: 1000, mint: M, buy: true, sol: 1, tokens: 1000, ...o });

/** A transaction the wallet paid for: SOL out and tokens in for a buy, the other way for a sale. */
const txOf = (wallet: string, mint: string, buy: boolean, sol: number, tokens: number, slot: number, t: number | null = 1_800_000_000) => ({
  slot,
  transactionIndex: 0,
  blockTime: t,
  transaction: { message: { accountKeys: [wallet] } },
  meta: {
    err: null,
    fee: 5000,
    preBalances: [100e9],
    postBalances: [100e9 + (buy ? -1 : 1) * sol * 1e9 - 5000],
    preTokenBalances: [{ mint, owner: wallet, uiTokenAmount: { uiAmountString: "5000" } }],
    postTokenBalances: [{ mint, owner: wallet, uiTokenAmount: { uiAmountString: String(5000 + (buy ? tokens : -tokens)) } }],
  },
});

test("round trips: first buy until 90% is sold; coins held before or still held are left out", () => {
  const { trips, open } = tripsOf([
    sw({ slot: 1, t: 0, sol: 1, tokens: 1000 }),
    sw({ slot: 2, t: 60, sol: 0.5, tokens: 400 }),
    sw({ slot: 3, t: 3600, buy: false, sol: 1.2, tokens: 700 }),
    sw({ slot: 4, t: 7200, buy: false, sol: 1, tokens: 700 }),
    sw({ mint: "held-before", slot: 5, buy: false, sol: 2, tokens: 10 }),
    sw({ mint: "still-held", slot: 6, sol: 1, tokens: 10 }),
  ]);
  assert.equal(open, 1);
  assert.equal(trips.length, 1);
  const t = trips[0];
  assert.deepEqual([t.t0, t.t1, t.tClose, t.buys, t.sells], [0, 3600, 7200, 2, 2]);
  assert.ok(Math.abs(t.sellSol - t.buySol - 0.7) < 1e-12);
  assert.equal(t.p0, 0.001);
  assert.ok(Math.abs(t.p1 - 1.2 / 700) < 1e-12);
  assert.equal(t.firstSol, 1);
  // a sale of less than 90% leaves it open; the same coin bought again later is a new trip
  const two = tripsOf([sw({ slot: 1 }), sw({ slot: 2, buy: false, sol: 2, tokens: 950 }), sw({ slot: 3, t: 9, sol: 1 }), sw({ slot: 4, buy: false, sol: 0.5, tokens: 500 })]);
  assert.equal(two.trips.length, 1);
  assert.equal(two.open, 1);
});

const trip = (i: number, gain: number, holdSec = 7200, firstSol = 1) => ({
  mint: `m${i}`, t0: i * 10_000, slot0: i * 100, p0: 0.001, firstSol, t1: i * 10_000 + holdSec, slot1: i * 100 + 50, p1: 0.001 * (1 + gain), tClose: i * 10_000 + holdSec,
  buySol: firstSol, sellSol: firstSol * (1 + gain), buys: 1, sells: 1,
});
const meta = { txPerDay: 20, buysPerDay: 3, spanDays: 14, open: 2 };

test("screen: slow, steady and ahead in both halves passes; each failure is named", () => {
  const good = Array.from({ length: 24 }, (_, i) => trip(i, i % 2 ? 0.3 : -0.1));
  const s = screen(good, meta);
  assert.equal(s.pass, true, s.why.join());
  assert.equal(s.trips, 24);
  assert.equal(s.wonPct, 50);
  assert.equal(s.holdMinMedian, 120);
  assert.equal(s.realisedSol, 2.4);
  assert.ok(s.olderSol! > 0 && s.newerSol! > 0);
  assert.equal(screen(good, { ...meta, txPerDay: 500 }).why[0], "bot");
  assert.ok(screen(good.map((t) => ({ ...t, t1: t.t0 + 600 })), meta).why.some((w) => w.startsWith("holds")));
  assert.ok(screen(good.slice(0, MIN_TRIPS - 1), meta).why.includes(`${MIN_TRIPS - 1} trips`));
  // all of the profit in one trade
  const lucky = Array.from({ length: 24 }, (_, i) => trip(i, i === 3 ? 20 : i % 2 ? 0.01 : -0.01));
  assert.ok(screen(lucky, meta).why.includes("one trade"));
  // ahead overall but the newer half lost
  const faded = Array.from({ length: 24 }, (_, i) => trip(i, i < 12 ? 0.5 : i % 2 ? 0.1 : -0.3));
  assert.ok(screen(faded, meta).why.includes("one half lost"));
  // small first buys are counted
  const bait = good.map((t, i) => (i < 6 ? { ...t, firstSol: 0.1, buySol: 0.1, sellSol: 0.1 * (1 + (i % 2 ? 0.3 : -0.1)) } : t));
  assert.equal(screen(bait, meta).smallStartPct, 25);
});

test("late copies: entry 30 s / 5 min after the first buy, exit 30 s after the first sale, cost taken off", () => {
  const t = { ...trip(1, 0.5), e30: 0.0011, e300: 0.0012, x30: 0.0014 };
  assert.ok(Math.abs(lateRet(t, 30)! - (0.0014 / 0.0011 - 1 - DELAY_COST)) < 1e-12);
  assert.ok(Math.abs(lateRet(t, 300)! - (0.0014 / 0.0012 - 1 - DELAY_COST)) < 1e-12);
  assert.ok(Math.abs(ownRet(t) - 0.5) < 1e-12);
  // it sold within 5 min: a 5 min copy never happens
  assert.equal(lateRet({ ...t, t1: t.t0 + 200 }, 300), null);
  assert.equal(lateRet({ ...t, x30: null }, 30), null);
  const trips = Array.from({ length: 24 }, (_, i) => ({ ...trip(i, i % 2 ? 0.3 : -0.1), e30: 0.001, e300: 0.001, x30: i % 2 ? 0.0012 : 0.0009 }));
  const s = screen(trips, meta);
  assert.equal(s.late.checked, 24);
  assert.equal(s.late.in5min.n, 24);
  assert.equal(s.late.in5min.won, 12);
  assert.equal(s.late.in5min.avgPct, 4); // (+19% and -11%) / 2
});

test("a price after a slot: same-side trades first, else the other side marked over", () => {
  const b = (price: number, buy = true, sol = 1) => ({ buy, sol, price });
  assert.equal(priceAfter([b(1), b(3), b(2, false)], "entry"), 2);
  assert.equal(priceAfter([b(1, false), b(3, false), b(2)], "exit"), 2);
  assert.equal(priceAfter([b(1, false)], "entry"), 1.02);
  assert.equal(priceAfter([b(1)], "exit"), 0.98);
  assert.equal(priceAfter([b(1, true, 0.01)], "entry"), null); // dust is no price
  assert.equal(priceAfter([], "exit"), null);
});

test("paper copy: buys late after a followed wallet buys, sells after its first sale, drops entries it sold before", async () => {
  _test.reset();
  const quotes: string[] = [];
  _test.setCfg({
    rpcUrl: () => null,
    fetch: () => fetch,
    listed: () => [],
    busy: () => [],
    quote: async (a: string, b: string, amount: string) => {
      quotes.push(`${a === SOLM ? "buy" : "sell"} ${amount}`);
      return a === SOLM ? 1000n : 300_000_000n;
    },
  });
  _test.follow([W]);
  mock.timers.enable({ apis: ["setTimeout"], now: 1_800_000_000_000 });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  try {
    slowTx(txOf("someone else", M, true, 1, 1000, 10), Date.now()); // not followed
    slowTx(txOf(W, M, true, 0.05, 50, 10), Date.now()); // dust
    assert.equal(_test.state().open.length, 0);
    slowTx(txOf(W, M, true, 1, 1000, 10), Date.now());
    assert.equal(_test.state().open.length, 1);
    assert.deepEqual(slowWatch(), [W]);
    slowTx(txOf(W, M, true, 1, 1000, 11), Date.now()); // adding to it: no second copy
    assert.equal(_test.state().open.length, 1);
    mock.timers.tick(5000);
    await flush();
    mock.timers.tick(25_000);
    await flush();
    const p = _test.state().open[0];
    assert.equal(p.entries.e5, "1000");
    assert.equal(p.entries.e30, "1000");
    // it sells after 2 minutes: the 5 and 30 min entries are never made
    mock.timers.tick(90_000);
    slowTx(txOf(W, M, false, 1.5, 1000, 20), Date.now());
    assert.equal(p.entries.e300, "cancel");
    assert.equal(p.entries.e1800, "cancel");
    mock.timers.tick(5000);
    await flush();
    mock.timers.tick(25_000);
    await flush();
    await flush();
    assert.equal(_test.state().open.length, 0);
    assert.equal(p.closed, "sold");
    const want = (0.3 - 2 * TX_SOL) / STAKE_SOL - 1;
    assert.ok(Math.abs(posRet(p, 5, 5)! - want) < 1e-12);
    assert.equal(posRet(p, 300, 5), undefined);
    const rules = paperRules(_test.state().recent);
    const r = (id: string) => rules.find((x) => x.id === id)!;
    assert.equal(r("slow-e5-x5").n, 1);
    assert.equal(r("slow-e30-x30").won, 1);
    assert.equal(r("slow-e300-x30").n, 0);
    assert.equal(quotes.filter((q) => q.startsWith("buy")).length, 2);
    assert.equal(quotes.filter((q) => q === "sell 1000").length, 4); // two entries, two exit times
  } finally {
    mock.timers.reset();
    _test.reset();
  }
});

test("a price that never came is left out; a coin that cannot be sold is a total loss", () => {
  const p = { wallet: W, name: "x", mint: M, seenMs: 0, leaderSol: 1, entries: { e5: "10", e30: null, e300: "cancel" as const }, exits: { "e5-x5": null }, closed: "sold" as const };
  assert.equal(posRet(p, 5, 5), -1);
  assert.equal(posRet(p, 5, 30), undefined);
  assert.equal(posRet(p, 30, 5), undefined);
  assert.equal(posRet(p, 300, 5), undefined);
});

test("screen from the chain: the wallet's own swaps read, others' left out; late prices read for a wallet that passes", async () => {
  _test.reset();
  const calls: { address: string; filters: Record<string, unknown> }[] = [];
  const now = Math.floor(Date.now() / 1000);
  const own: ReturnType<typeof txOf>[] = [];
  for (let i = 0; i < 24; i++) {
    const t0 = now - 13 * 86_400 + i * 40_000;
    own.push(txOf(W, `m${i}`, true, 1, 1000, 1000 + i * 100, t0));
    own.push(txOf(W, `m${i}`, false, i % 2 ? 1.4 : 0.9, 1000, 1050 + i * 100, t0 + 7200));
  }
  own.push(txOf("relayer", "mX", true, 1, 1000, 999, now - 86_400)); // paid by someone else: not its own swap
  const fake = (async (_url: string, init: { body: string }) => {
    const { params } = JSON.parse(init.body) as { params: [string, { filters: Record<string, unknown> }] };
    calls.push({ address: params[0], filters: params[1].filters });
    const data = params[0] === W ? own.slice().reverse() : [txOf("buyer", params[0], true, 1, 1000, 5), txOf("buyer2", params[0], true, 1, 800, 6)];
    return new Response(JSON.stringify({ result: { data, paginationToken: null } }), { status: 200 });
  }) as unknown as typeof fetch;
  _test.setCfg({ rpcUrl: () => "https://rpc.test/?api-key=k", fetch: () => fake, listed: () => [], busy: () => [], quote: async () => null });
  _test.state().candidates.push({ name: "Slowpoke", address: W });
  assert.equal(await _test.readWallet({ name: "Slowpoke", address: W }), true);
  const rep = reportOf(W)!;
  assert.equal(rep.trips, 24);
  assert.equal(rep.holdMinMedian, 120);
  assert.equal(rep.pass, true, rep.why.join());
  assert.equal(await _test.checkLate(W), true);
  const late = reportOf(W)!.late;
  assert.equal(late.checked, 24);
  assert.equal(late.in30s.n, 24);
  // others paid 1/1000 and 1/800 SOL a token: entries at the median, exits marked down by the spread
  assert.ok(late.in30s.avgPct !== null);
  assert.ok(calls.some((c) => c.address === "m0" && (c.filters.slot as { gte: number }).gte === 1000 + 75));
  assert.equal(_test.state().credits, 10 + 24 * 3 * 10);
  assert.deepEqual(followed().map((x) => x.name), ["Slowpoke"]);
  const sum = slowSummary();
  assert.equal(sum.passing, 1);
  assert.equal(sum.pass[0].name, "Slowpoke");
  assert.ok(!JSON.stringify(sum).includes("api-key"));
  _test.reset();
});
