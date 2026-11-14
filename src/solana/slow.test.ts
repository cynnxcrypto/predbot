import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "solslow-"));

const { tripsOf, screen, lateRet, ownRet, priceAfter, posRet, paperRules, slowTx, slowSummary, reportOf, followed, slowWatch, jupCoins, coinOld, creditsDay, _test, STAKE_SOL, TX_SOL, DELAY_COST, MIN_TRIPS } = await import("./slow.js");

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

test("after a restart: one read a wallet for all its open copies; a sale counts only after that copy's buy was seen", async () => {
  _test.reset();
  const t0 = 1_800_000_000;
  const calls: { address: string; gt: number }[] = [];
  const fake = (async (_url: string, init: { body: string }) => {
    const { params } = JSON.parse(init.body) as { params: [string, { filters: { blockTime: { gt: number } } }] };
    calls.push({ address: params[0], gt: params[1].filters.blockTime.gt });
    // it sold coin A an hour after our first copy (before we saw its second buy of A), and coin B two hours after
    const data = params[0] === W ? [txOf(W, "A", false, 1, 1000, 50, t0 + 3600), txOf(W, "B", false, 1, 1000, 60, t0 + 7200)] : [];
    return new Response(JSON.stringify({ result: { data, paginationToken: null } }), { status: 200 });
  }) as unknown as typeof fetch;
  _test.setCfg({ rpcUrl: () => "https://rpc.test/?api-key=k", fetch: () => fake, listed: () => [], busy: () => [], quote: async () => null });
  const pos = (wallet: string, mint: string, seenS: number) => ({ wallet, name: "x", mint, seenMs: seenS * 1000, leaderSol: 1, entries: { e5: "missed" as const, e30: "missed" as const, e300: "missed" as const, e1800: "missed" as const }, exits: {} });
  const st = _test.state();
  st.open.push(pos(W, "B", t0), pos(W, "C", t0 + 60), pos(W, "A", t0 + 5000), pos("Other11111", "A", t0));
  try {
    await _test.catchUp();
    // two wallets, two reads (not four), each from its oldest open copy
    assert.deepEqual(calls, [{ address: W, gt: t0 }, { address: "Other11111", gt: t0 }]);
    assert.equal(st.credits, 20);
    const sold = (mint: string, w = W) => !!st.open.find((p) => p.wallet === w && p.mint === mint)?.soldMs;
    // B was sold after we saw its buy; A's sale came before our copy of A; C and the other wallet's A were not sold
    assert.deepEqual([sold("B"), sold("A"), sold("C"), sold("A", "Other11111")], [true, false, false, false]);
  } finally {
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

const DAY = 86_400_000;
test("day holders: Jupiter's lists without SOL, stables or staked SOL; a coin trades for days by its first pool or by two days on a list", () => {
  const now = Date.now();
  const rows = [
    { id: "CoinA111", symbol: "AAA", firstPool: { createdAt: new Date(now - 10 * DAY).toISOString() } },
    { id: "So11111111111111111111111111111111111111112", symbol: "SOL" },
    { id: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC" },
    { id: "Usd1", symbol: "PYUSD" },
    { id: "Lst1", symbol: "XYZ", tags: ["lst", "verified"] },
    { id: "Lst2", symbol: "JitoSOL" },
    { address: "CoinB111", symbol: "B$B!", firstPool: { createdAt: "not a date" } },
    { symbol: "no id" },
  ];
  const got = jupCoins(rows);
  assert.deepEqual(got.map((x) => x.mint), ["CoinA111", "CoinB111"]);
  assert.equal(got[1].symbol, "BB");
  assert.equal(got[1].createdMs, null);
  assert.deepEqual(jupCoins({ not: "a list" }), []);
  assert.equal(coinOld({ symbol: "A", from: "jupiter", days: ["d1"], createdMs: now - 4 * DAY }, now), true);
  assert.equal(coinOld({ symbol: "A", from: "jupiter", days: ["d1", "d2"], createdMs: now - 1 * DAY }, now), false);
  assert.equal(coinOld({ symbol: "A", from: "jupiter", days: ["d1"], createdMs: null }, now), false);
  assert.equal(coinOld({ symbol: "A", from: "jupiter", days: ["d1", "d2"], createdMs: null }, now), true);
  assert.equal(coinOld({ symbol: "A", from: "ours", days: ["d1"], createdMs: null }, now), true);
});

test("day holders: buyers of 0.2+ SOL sampled from coins that trade for days, never on launch day; more coins first", async () => {
  _test.reset();
  const now = Date.now();
  const A = "CoinA1111111111111111111111111111111111111";
  const B = "CoinB1111111111111111111111111111111111111";
  const calls: { address: string; gte: number }[] = [];
  const jupCalls: string[] = [];
  const jup = async (path: string) => {
    jupCalls.push(path);
    if (path.includes("toptraded")) return [{ id: A, symbol: "AAA", firstPool: { createdAt: new Date(now - 10 * DAY).toISOString() } }, { id: "Young111", symbol: "NEW", firstPool: { createdAt: new Date(now - DAY).toISOString() } }];
    if (path.includes("toporganicscore")) return [{ id: B, symbol: "BBB", firstPool: { createdAt: new Date(now - 5.5 * DAY).toISOString() } }];
    throw new Error("jupiter tokens: http 429");
  };
  const fake = (async (_url: string, init: { body: string }) => {
    const { params } = JSON.parse(init.body) as { params: [string, { filters: { blockTime: { gte: number } } }] };
    calls.push({ address: params[0], gte: params[1].filters.blockTime.gte });
    const data =
      params[0] === A
        ? [txOf("Both11111", A, true, 0.5, 500, 5), txOf("Dust11111", A, true, 0.1, 100, 6), txOf("Seller111", A, false, 1, 100, 7)]
        : [txOf("Both11111", B, true, 0.3, 300, 5), txOf("Big111111", B, true, 2, 2000, 6)];
    return new Response(JSON.stringify({ result: { data, paginationToken: null } }), { status: 200 });
  }) as unknown as typeof fetch;
  _test.setCfg({ rpcUrl: () => "https://rpc.test/?api-key=k", fetch: () => fake, listed: () => [], busy: () => [], quote: async () => null, jup });
  assert.equal(await _test.coinStep(), true);
  // twelve lists (three kinds, four periods) and the verified coins
  assert.equal(jupCalls.length, 13);
  assert.ok(jupCalls.includes("/tokens/v2/toptrending/5m?limit=100") && jupCalls.includes("/tokens/v2/tag?query=verified"));
  assert.deepEqual(Object.keys(_test.state().coins).sort(), [A, B, "Young111"].sort());
  // A (10 days old): the eight points up to 8 days back, never its first day; B (5.5 days old): the five up to
  // 4 days back; the young coin: not sampled. A page that is not full is the only one read at its point.
  assert.equal(calls.filter((c) => c.address === A).length, 8);
  assert.equal(calls.filter((c) => c.address === B).length, 5);
  assert.ok(!calls.some((c) => c.address === "Young111"));
  assert.ok(calls.some((c) => c.address === A && Math.abs(c.gte - Math.floor((now - 8 * DAY) / 1000)) < 5));
  assert.ok(!calls.some((c) => c.address === A && c.gte < Math.floor((now - 9 * DAY) / 1000)));
  assert.equal(_test.state().credits, 130);
  const cands = _test.state().candidates;
  assert.deepEqual(cands.map((c) => c.address), ["Both11111", "Big111111"]);
  assert.ok(cands.every((c) => c.source === "coin" && c.name.startsWith("coin buyer ")));
  assert.deepEqual(Object.keys(_test.state().pool), []);
  // nothing due again for a week, and the lists are asked again only after 6 hours
  assert.equal(await _test.coinStep(), true);
  assert.equal(jupCalls.length, 13);
  assert.equal(_test.state().credits, 130);
  const sum = slowSummary();
  assert.equal(sum.coins.sampledThisWeek, 2);
  assert.equal(sum.coins.oldEnough, 2);
  assert.equal(sum.coins.dueNow, 0);
  assert.equal(sum.coins.lists, "8 of 13 answered");
  assert.equal(sum.coins.lastError, "jupiter tokens: http 429");
  assert.equal(sum.bySource.coin.candidates, 2);
  _test.reset();
});

test("cheaper reads: a full first page inside 3 hours is a bot after one page; a flipper stops after two", async () => {
  _test.reset();
  const now = Math.floor(Date.now() / 1000);
  const BOT = "Bot1111111";
  const FLIP = "Flip111111";
  const botTx = Array.from({ length: 100 }, (_, i) => txOf(BOT, `m${i}`, i % 2 === 0, 1, 1000, 10_000 - i, now - i * 60));
  // a flipper: a trip every 30 min, sold 5 min after it bought
  const flipTx: ReturnType<typeof txOf>[] = [];
  for (let k = 0; k < 150; k++) {
    const t0 = now - 600 - k * 1800;
    flipTx.push(txOf(FLIP, `f${k}`, false, 1.1, 1000, 100_000 - 2 * k, t0 + 300));
    flipTx.push(txOf(FLIP, `f${k}`, true, 1, 1000, 100_000 - 2 * k - 1, t0));
  }
  const calls: string[] = [];
  const fake = (async (_url: string, init: { body: string }) => {
    const { params } = JSON.parse(init.body) as { params: [string, { paginationToken?: string }] };
    calls.push(params[0]);
    const n = Number(params[1].paginationToken ?? 0);
    const data = params[0] === BOT ? botTx : flipTx.slice(n * 100, n * 100 + 100);
    return new Response(JSON.stringify({ result: { data, paginationToken: String(n + 1) } }), { status: 200 });
  }) as unknown as typeof fetch;
  _test.setCfg({ rpcUrl: () => "https://rpc.test/?api-key=k", fetch: () => fake, listed: () => [], busy: () => [], quote: async () => null });
  _test.state().candidates.push({ name: "bot", address: BOT }, { name: "flip", address: FLIP, source: "coin" });
  assert.equal(await _test.readWallet({ name: "bot", address: BOT }), true);
  assert.equal(calls.length, 1);
  assert.equal(_test.state().wallets[BOT].bot, true);
  assert.deepEqual(_test.state().wallets[BOT].swaps, []);
  assert.equal(await _test.readWallet({ name: "flip", address: FLIP }), true);
  assert.equal(calls.length, 3);
  const w = _test.state().wallets[FLIP];
  assert.equal(w.bot, undefined);
  assert.equal(w.fast?.holdMin, 5);
  assert.ok((w.fast?.trips ?? 0) >= 90);
  assert.equal(w.fast?.wonPct, 100);
  assert.deepEqual(w.swaps, []);
  const rep = reportOf(FLIP)!;
  assert.equal(rep.fast, true);
  assert.equal(rep.pass, false);
  assert.deepEqual(rep.why, ["holds 5 min"]);
  const sum = slowSummary();
  assert.equal(sum.bots, 1);
  assert.equal(sum.fast, 1);
  assert.equal(sum.near.length, 0);
  assert.equal(sum.bySource.coin.fast, 1);
  assert.equal(sum.bySource.list.bots, 1);
  _test.reset();
});

test("the wide scan: verified coins by volume, more pages a point, launch pages left out, best buyers first", async () => {
  _test.reset();
  const now = Date.now();
  const sec = (ms: number) => Math.floor(ms / 1000);
  const BUSY = "Busy11111111111111111111111111111111111111";
  const QUIET = "Quiet1111111111111111111111111111111111111";
  const NODATE = "NoDate111111111111111111111111111111111111";
  const old = { createdAt: new Date(now - 20 * DAY).toISOString() };
  // the volume is read from the list; a coin without it has none
  assert.deepEqual(jupCoins([{ id: "V1", symbol: "V", stats24h: { buyVolume: 40_000, sellVolume: 30_000.4 } }, { id: "V2", symbol: "W" }]).map((x) => x.vol), [70_000.4, null]);
  const jup = async (path: string) => {
    if (path.includes("tag?query=verified")) return [{ id: BUSY, symbol: "BUSY", firstPool: old, stats24h: { buyVolume: 400_000, sellVolume: 300_000 } }, { id: QUIET, symbol: "QUIET", firstPool: old, stats24h: { buyVolume: 10_000, sellVolume: 5_000 } }, { id: "NoVol111", symbol: "NOVOL", firstPool: old }];
    if (path.includes("toptraded/24h")) return [{ id: NODATE, symbol: "NODATE" }];
    return [];
  };
  const pages: { address: string; token: string | null }[] = [];
  const fake = (async (_url: string, init: { body: string }) => {
    const { params } = JSON.parse(init.body) as { params: [string, { paginationToken?: string; filters: { blockTime: { gte: number } } }] };
    const token = params[1].paginationToken ?? null;
    pages.push({ address: params[0], token });
    const from = params[1].filters.blockTime.gte;
    if (params[0] === NODATE) {
      // the point half a day back has trades right after it; every older point comes back with trades a day later (its launch)
      const t = from > sec(now - DAY) ? from + 60 : from + 86_400;
      return new Response(JSON.stringify({ result: { data: [txOf(t === from + 60 ? "Later1111" : "Sniper111", NODATE, true, 1, 1000, 5, t)], paginationToken: null } }), { status: 200 });
    }
    // a busy coin: full pages as long as we ask, a different buyer on each
    const n = Number(token ?? 0);
    const data = Array.from({ length: 100 }, (_, i) => txOf(i === 0 ? `Page${n}Buyer` : "Dust11111", BUSY, true, i === 0 ? 1 : 0.01, 10, 5 + i, from + i));
    return new Response(JSON.stringify({ result: { data, paginationToken: String(n + 1) } }), { status: 200 });
  }) as unknown as typeof fetch;
  _test.setCfg({ rpcUrl: () => "https://rpc.test/?api-key=k", fetch: () => fake, listed: () => [], busy: () => [], quote: async () => null, jup });
  // the first day of a coin known only from a list: it must be on a list on two days before it is sampled
  _test.state().coins[NODATE] = { symbol: "NODATE", from: "jupiter", days: ["2026-11-01"], createdMs: null };
  assert.equal(await _test.coinStep(), true);
  const coins = _test.state().coins;
  // verified: only the coin that traded $50,000+ in a day; no volume given means not taken
  assert.deepEqual(Object.keys(coins).sort(), [BUSY, NODATE].sort());
  assert.equal(coins[BUSY].vol, 700_000);
  // three pages at each of the ten points of the busy coin, following the page token
  const busy = pages.filter((p) => p.address === BUSY);
  assert.equal(busy.length, 30);
  assert.deepEqual(busy.slice(0, 3).map((p) => p.token), [null, "1", "2"]);
  // the coin without a first day: one page a point, and the pages that only show its launch add nobody
  assert.equal(pages.filter((p) => p.address === NODATE).length, 10);
  const cands = _test.state().candidates.map((c) => c.address);
  assert.ok(cands.includes("Later1111") && !cands.includes("Sniper111"));
  assert.deepEqual(cands.filter((a) => a.startsWith("Page")).sort(), ["Page0Buyer", "Page1Buyer", "Page2Buyer"]);
  // promotion: a share a pass, buyers of more coins first, then more SOL
  _test.state().pool = { One1: ["aaaaaa", 50], Two1: ["aaaaaa,bbbbbb", 1], Three: ["aaaaaa,bbbbbb,cccccc", 0.5], One2: ["aaaaaa", 9] };
  const before = _test.state().candidates.length;
  _test.promote(3);
  assert.deepEqual(_test.state().candidates.slice(before).map((c) => c.address), ["Three", "Two1", "One1"]);
  assert.deepEqual(Object.keys(_test.state().pool), ["One2"]);
  _test.reset();
});

test("the wide scan: a wallet far from the bar keeps its numbers, not its swaps; who is read first; a month of history", async () => {
  _test.reset();
  const now = Math.floor(Date.now() / 1000);
  const LOSER = "Loser11111";
  const NEAR = "Near111111";
  // 12 trips held two hours each over 25 days: the loser sells every one lower, the near one higher (too few trips to pass)
  const trips = (w: string, back: number) =>
    Array.from({ length: 12 }, (_, i) => {
      const t0 = now - 25 * 86_400 + i * 170_000;
      return [txOf(w, `c${i}`, true, 1, 1000, 1000 + i * 100, t0), txOf(w, `c${i}`, false, back, 1000, 1050 + i * 100, t0 + 7200)];
    }).flat();
  const data: Record<string, ReturnType<typeof txOf>[]> = { [LOSER]: trips(LOSER, 0.8), [NEAR]: trips(NEAR, 1.3) };
  const calls: { address: string; gt: number }[] = [];
  const fake = (async (_url: string, init: { body: string }) => {
    const { params } = JSON.parse(init.body) as { params: [string, { filters: { blockTime: { gt: number } } }] };
    calls.push({ address: params[0], gt: params[1].filters.blockTime.gt });
    return new Response(JSON.stringify({ result: { data: (data[params[0]] ?? []).slice().reverse(), paginationToken: null } }), { status: 200 });
  }) as unknown as typeof fetch;
  _test.setCfg({ rpcUrl: () => "https://rpc.test/?api-key=k", fetch: () => fake, listed: () => [], busy: () => [], quote: async () => null });
  const st = _test.state();
  st.candidates.push({ name: "loser", address: LOSER, source: "coin" }, { name: "near", address: NEAR, source: "coin" }, { name: "new", address: "New1111111", source: "coin" });
  assert.equal(await _test.readWallet({ name: "loser", address: LOSER }), true);
  assert.equal(await _test.readWallet({ name: "near", address: NEAR }), true);
  // a month back, not two weeks: the trips 25 days old are read
  assert.ok(calls.every((c) => Math.abs(c.gt - (now - 30 * 86_400)) < 5));
  // the loser: 12 trips, all lost: numbers kept, swaps dropped, still reported with its reasons
  assert.deepEqual(st.wallets[LOSER].swaps, []);
  assert.deepEqual([st.wallets[LOSER].out?.trips, st.wallets[LOSER].out?.wonPct, st.wallets[LOSER].out?.holdMin], [12, 0, 120]);
  const lr = reportOf(LOSER)!;
  assert.deepEqual([lr.pass, lr.trips, lr.holdMinMedian, lr.fast], [false, 12, 120, false]);
  assert.ok(lr.why.includes("lost") && lr.why.includes("12 trips"));
  // the near one: 12 winning two-hour trips, short of the 20: its swaps stay for the daily read
  assert.equal(st.wallets[NEAR].out, undefined);
  assert.equal(st.wallets[NEAR].swaps.length, 24);
  assert.deepEqual([reportOf(NEAR)!.pass, reportOf(NEAR)!.why], [false, ["12 trips"]]);
  const sum = slowSummary();
  assert.deepEqual([sum.windowDays, sum.candidates, sum.read, sum.unread, sum.kept, sum.farOff], [30, 3, 2, 1, 1, 1]);
  assert.deepEqual(sum.near.map((x) => x.name), ["near", "loser"]);
  // just read: only the unread wallet is due. A day later the near one is due again and comes first; the far-off
  // one only after two weeks, and last
  assert.deepEqual(_test.dueWallets().map((c) => c.name), ["new"]);
  st.wallets[NEAR].doneAt -= 25 * 3_600_000;
  st.wallets[LOSER].doneAt -= 25 * 3_600_000;
  assert.deepEqual(_test.dueWallets().map((c) => c.name), ["near", "new"]);
  st.wallets[LOSER].doneAt -= 14 * 86_400_000;
  assert.deepEqual(_test.dueWallets().map((c) => c.name), ["near", "new", "loser"]);
  assert.deepEqual(_test.dueWallets(2).map((c) => c.name), ["near", "new"]);
  // a far-off wallet is read whole again (it kept nothing to add to)
  calls.length = 0;
  assert.equal(await _test.readWallet({ name: "loser", address: LOSER }), true);
  assert.ok(Math.abs(calls[0].gt - (now - 30 * 86_400)) < 5);
  // state written under the two-week window: every person is marked for one whole read, bots are not; once
  st.wallets[NEAR].doneAt = Date.now();
  st.wallets.Bot1 = { name: "bot", doneAt: Date.now(), newest: now, txPerDay: 900, buysPerDay: 0, spanDays: 1, bot: true, swaps: [], late: {} };
  st.window = 14;
  _test.toWindow();
  assert.deepEqual([st.window, st.wallets[NEAR].redo, st.wallets[LOSER].redo, st.wallets.Bot1.redo], [30, true, true, undefined]);
  assert.equal(reportOf(NEAR)!.trips, 12, "its old swaps stand until it is read again");
  assert.ok(_test.dueWallets().some((c) => c.name === "near"));
  calls.length = 0;
  assert.equal(await _test.readWallet({ name: "near", address: NEAR }), true);
  assert.ok(Math.abs(calls[0].gt - (now - 30 * 86_400)) < 5, "whole, not from its newest transaction");
  assert.equal(st.wallets[NEAR].redo, undefined);
  // the daily budget: 500,000 credits until the plan resets on 24 Nov 2026, 150,000 after
  assert.deepEqual([creditsDay(Date.UTC(2026, 10, 23, 23)), creditsDay(Date.UTC(2026, 10, 24, 1))], [500_000, 150_000]);
  _test.reset();
});
