import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "solbuckets-"));
process.env.DATA_DIR = dir;

const B = await import("./buckets.js");
const { SOL, USDC } = await import("./pools.js");
const { isStock, bucketCoins, bucketOf, bucketsSummary, bucketsTick, hlDiff, hlPick, hlPositions, parseKlines, parsePrices, perpNet, pickUniverse, spotExit, spotSignal, PERP_RULES, SPOT_RULES, _bucketsTest } = B;

const MINT = (n: number) => "Mint" + String(n).padStart(4, "1").replace(/0/g, "z") + "1".repeat(32);
const row = (n: number, mcap: number, extra: Record<string, unknown> = {}) => ({ id: MINT(n), symbol: "C" + n, mcap, liquidity: 500_000, stats24h: { buyVolume: 400_000, sellVolume: 300_000 }, firstPool: { createdAt: "2026-01-01T00:00:00Z" }, ...extra });
const NOW = Date.parse("2026-11-15T00:00:00Z");

test("buckets: coins are sorted by market value; stables, staked SOL, thin and new coins are left out", () => {
  assert.deepEqual([2e9, 5e8, 5e7, 5e6].map(bucketOf), ["high", "mid", "low", "meme"]);
  const coins = bucketCoins(
    [
      row(1, 2e9), row(2, 5e8), row(3, 5e7), row(4, 5e6),
      row(5, 5e8, { symbol: "USDT" }), row(6, 5e8, { tags: ["lst"] }), row(7, 5e8, { symbol: "jitoSOL" }),
      row(8, 5e8, { liquidity: 10_000 }), row(9, 5e8, { stats24h: { buyVolume: 10, sellVolume: 10 } }),
      row(10, 5e8, { firstPool: { createdAt: "2026-11-14T00:00:00Z" } }), row(11, 5e6, { firstPool: { createdAt: "2026-11-14T00:00:00Z" } }),
      row(12, NaN), { id: "not a mint", mcap: 1e9 },
    ],
    NOW,
  );
  assert.deepEqual(coins.map((c) => [c.symbol, c.bucket]), [["C1", "high"], ["C2", "mid"], ["C3", "low"], ["C4", "meme"], ["C11", "meme"]], "a one-day-old meme counts, a one-day-old mid cap does not");
  // wrapped and bridged majors are high caps whatever their Solana supply says, but only when verified and liquid
  const wrapped = bucketCoins([row(20, 5e7, { symbol: "ETH", isVerified: true }), row(21, 5e7, { symbol: "cbBTC", tags: ["verified"] }), row(22, 5e7, { symbol: "BTC" }), row(23, 5e7, { symbol: "ZEC", isVerified: true, liquidity: 60_000 }), { id: SOL, symbol: "SOL", mcap: 5e10, liquidity: 1e9, stats24h: { buyVolume: 1e9, sellVolume: 1e9 } }], NOW);
  assert.deepEqual(wrapped.map((c) => c.bucket), ["high", "high", "low", "low", "high"], "an unverified BTC and a thin ZEC get no credit; SOL itself is a high cap");
  // tokenised stocks are not crypto: out, however they are labelled
  assert.equal(isStock({ symbol: "NVDA", name: "NVIDIA xStock" }), true);
  assert.equal(isStock({ symbol: "NVDAx", name: "NVIDIA" }), true);
  assert.equal(isStock({ symbol: "TTWOon", name: "Take-Two" }), true);
  assert.equal(isStock({ symbol: "NIO", name: "NIO Inc. (Ondo Tokenized)" }), true);
  assert.equal(isStock({ symbol: "SPY", name: "SP500", tags: ["verified", "xstocks"] }), true);
  assert.equal(isStock({ symbol: "BONK", name: "Bonk", tags: ["verified", "community"] }), false);
  assert.equal(isStock({ symbol: "Fartcoin", name: "Fartcoin" }), false);
  assert.equal(isStock({ symbol: "JUP", name: "Jupiter" }), false);
  assert.deepEqual(bucketCoins([row(30, 5e6, { symbol: "NVDA", name: "NVIDIA xStock" })], NOW), []);
  // the leftovers of the first live lists: an unlabelled stock, a pool share, a stablecoin, a wrapped major
  assert.equal(isStock({ symbol: "NIO", name: "NIO" }), true);
  const left = bucketCoins([row(40, 5e8, { symbol: "JLP", name: "Jupiter Perps LP" }), row(41, 5e8, { symbol: "CASH", name: "CASH" }), row(42, 5e8, { symbol: "XYZ", name: "Some Stable Dollar" }), row(43, 5e8, { symbol: "SOL-USDC" }), row(44, 5e6, { symbol: "wNEAR", name: "Wrapped NEAR", isVerified: true }), row(45, 5e8, { symbol: "WIF", name: "dogwifhat", tags: ["verified"] })], NOW);
  assert.deepEqual(left.map((c) => [c.symbol, c.bucket, c.name]), [["wNEAR", "high", "Wrapped NEAR"], ["WIF", "mid", "dogwifhat"]]);
  const many = Array.from({ length: 150 }, (_, i) => ({ ...coins[1], mint: MINT(100 + i), vol: i }));
  const picked = pickUniverse([...many, ...many, coins[0]]);
  assert.equal(picked.filter((c) => c.bucket === "mid").length, B.PER_BUCKET);
  assert.equal(picked.filter((c) => c.bucket === "mid")[0].vol, 149, "the busiest first, one row a mint");
});

test("buckets: spot signals scale with the bucket and exits are measured from the buy price", () => {
  const dip = SPOT_RULES.find((x) => x.key === "dip1h")!;
  const flat = Array.from({ length: 300 }, () => 100);
  const fall = (pct: number) => [...flat.slice(0, 299), 100 * (1 - pct / 100)];
  assert.equal(spotSignal(dip, "high", fall(2.1), flat), true);
  assert.equal(spotSignal(dip, "high", fall(1.9), flat), false);
  assert.equal(spotSignal(dip, "meme", fall(9), flat), false, "memes need 10%");
  assert.equal(spotSignal(dip, "meme", fall(10.5), flat), true);
  assert.equal(spotSignal(dip, "high", [100, 97], flat), false, "no hour of history yet");
  const mkt = SPOT_RULES.find((x) => x.key === "mktdip1h")!;
  assert.equal(spotSignal(mkt, "high", fall(3), flat), false, "SOL did not fall");
  assert.equal(spotSignal(mkt, "high", fall(3), fall(1.6)), true);
  const mom = SPOT_RULES.find((x) => x.key === "mom1h")!;
  const rise = [...Array.from({ length: 288 }, () => 100), ...Array.from({ length: 11 }, () => 101), 103.2];
  assert.equal(spotSignal(mom, "high", rise, flat), true);
  assert.equal(spotSignal(mom, "high", [...Array.from({ length: 288 }, () => 110), ...Array.from({ length: 11 }, () => 101), 103.2], flat), false, "down on the day");
  const brk = SPOT_RULES.find((x) => x.key === "brk24h")!;
  assert.equal(spotSignal(brk, "high", [...flat.slice(0, 299), 106], flat), true);
  assert.equal(spotSignal(brk, "high", [...flat.slice(0, 150), 107, ...flat.slice(0, 148), 106], flat), false, "not a new high");
  assert.equal(spotExit(dip, "high", 100, 101.9, 60_000), null);
  assert.equal(spotExit(dip, "high", 100, 102, 60_000), "target");
  assert.equal(spotExit(dip, "meme", 100, 109, 60_000), null, "the meme target is +10%");
  assert.equal(spotExit(dip, "high", 100, 80, 239 * 60_000), null, "the dip rule has no stop");
  assert.equal(spotExit(dip, "high", 100, 80, 240 * 60_000), "time");
  assert.equal(spotExit(mom, "mid", 100, 96.9, 60_000), "stop");
});

test("buckets: perp rules, costs and candles", () => {
  // 0.07% a side and the borrow: a short that gains 1% over 10 hours nets 1% - 0.14% - 0.016%
  assert.ok(Math.abs(perpNet(-1, 100, 99, 10) - (0.01 - 0.0014 - 0.00016)) < 1e-12);
  const H = 3_600_000;
  const rows = Array.from({ length: 5 }, (_, i) => [i * H, "1", "2", "0.5", String(10 + i)]);
  const { k, px } = parseKlines(rows, 4 * H + 60_000);
  assert.deepEqual(k.t, [0, 1, 2, 3], "the running candle is not a close");
  assert.equal(px, 14, "but it is the price now");
  const mk = (c: number[]) => ({ t: c.map((_, i) => 1000 + i), h: c, l: c, c });
  const down = mk(Array.from({ length: 800 }, (_, i) => 200 - i * 0.1));
  const week = PERP_RULES.find((x) => x.key === "short-down-week")!;
  const at = down.t.findIndex((t, i) => i >= 720 && t % 24 === 23);
  assert.equal(week.signal(down, at), -1);
  assert.equal(week.signal(down, at + 1), 0, "looked at once a day");
  const up = mk(Array.from({ length: 800 }, (_, i) => 100 + i * 0.1));
  assert.equal(week.signal(up, at), 0);
  const brk = PERP_RULES.find((x) => x.key === "break-24h")!;
  assert.equal(brk.signal(up, 700), 1);
  assert.equal(brk.signal(down, 700), -1);
  const pump = PERP_RULES.find((x) => x.key === "short-pump-1h")!;
  assert.equal(pump.signal(mk([100, 101.6]), 1), -1);
  assert.equal(pump.signal(mk([100, 101.4]), 1), 0);
});

test("buckets: perp traders are picked from the leaderboard and their position changes read", () => {
  const perf = (w: number, m: number, a: number, roi: number, vlm: number) => [["day", { pnl: "1", roi: "0", vlm: "0" }], ["week", { pnl: String(w), roi: "0.1", vlm: "1" }], ["month", { pnl: String(m), roi: String(roi), vlm: String(vlm) }], ["allTime", { pnl: String(a), roi: "1", vlm: "1" }]];
  const A = (n: number) => "0x" + String(n).padStart(40, "0");
  const picked = hlPick({
    leaderboardRows: [
      { ethAddress: A(1), accountValue: "500000", windowPerformances: perf(10, 100_000, 60_000, 0.3, 5_000_000) },
      { ethAddress: A(2), accountValue: "500000", windowPerformances: perf(-10, 100_000, 60_000, 0.3, 5_000_000) },
      { ethAddress: A(3), accountValue: "50000", windowPerformances: perf(10, 100_000, 60_000, 0.3, 500_000) },
      { ethAddress: A(4), accountValue: "500000", windowPerformances: perf(10, 100_000, 60_000, 0.3, 500_000_000) },
      { ethAddress: A(5), accountValue: "500000", windowPerformances: perf(10, 200_000, 60_000, 0.01, 5_000_000) },
      { ethAddress: A(6), accountValue: "900000", windowPerformances: perf(10, 300_000, 60_000, 0.4, 5_000_000) },
      { ethAddress: A(7), accountValue: "500000", windowPerformances: perf(10, 5_000, 60_000, 0.3, 5_000_000) },
      { ethAddress: A(8), accountValue: "500000", windowPerformances: perf(10, 100_000, 5_000, 0.3, 5_000_000) },
      { ethAddress: "nope", accountValue: "900000", windowPerformances: perf(10, 300_000, 5, 0.4, 5_000_000) },
    ],
  });
  assert.deepEqual(picked.map((t) => t.address), [A(6), A(1)], "down on the week, small account, small month or all-time profit, market maker and low return are out; biggest month first");
  assert.deepEqual(hlPick(null), []);
  const pos = hlPositions({ assetPositions: [{ position: { coin: "SOL", szi: "-500", positionValue: "41000" } }, { position: { coin: "BTC", szi: "0.01", positionValue: "900" } }, { position: { coin: "bad coin!", szi: "1", positionValue: "90000" } }] });
  assert.deepEqual(pos, { SOL: -41000 }, "small positions and odd names are ignored");
  assert.equal(hlPositions({}), null);
  assert.deepEqual(hlDiff({ SOL: -1, ETH: 5 }, { SOL: 3, BTC: 2 }), { opened: [{ coin: "SOL", dir: 1 }, { coin: "BTC", dir: 1 }], closed: ["SOL", "ETH"] }, "a turn-round closes and opens");
  assert.deepEqual(hlDiff({ SOL: -1 }, { SOL: -9 }), { opened: [], closed: [] }, "adding to a position is not a new trade");
});

test("buckets: prices in both shapes", () => {
  assert.deepEqual(parsePrices({ a: { usdPrice: 2 }, b: { usdPrice: 0 }, c: null }), { a: 2 });
  assert.deepEqual(parsePrices({ data: { a: { price: "3" } } }), { a: 3 });
  assert.deepEqual(parsePrices(null), {});
});

test("buckets: a full paper walk: spot buy and sell at quotes, a perp short, a copied trader, copies by bucket", async () => {
  _bucketsTest.reset();
  const coin = MINT(1);
  let price = 100;
  let solPx = 150;
  let perpPx = 100;
  let hour0 = 0;
  const trader = "0x" + "a".repeat(40);
  let traderPos: unknown[] = [];
  const quotes: string[] = [];
  const H = 3_600_000;
  const deps = {
    quote: async (a: string, b: string, amount: string) => {
      quotes.push(`${a === USDC ? "buy" : "sell"} ${amount}`);
      // 1% lost to fees and impact on each side
      return a === USDC ? BigInt(Math.floor((Number(amount) / 1e6 / price) * 0.99 * 1e6)) : BigInt(Math.floor((Number(amount) / 1e6) * price * 0.99 * 1e6));
    },
    jup: async (path: string) => {
      if (path.startsWith("/price/")) return { [coin]: { usdPrice: price }, [SOL]: { usdPrice: solPx } };
      if (path.startsWith("/tokens/v2/search")) return [{ id: path.split("=")[1], mcap: 3e6 }];
      return [row(1, 2e9)];
    },
    fetch: () =>
      (async (url: string, init?: { body?: string }) => {
        const json = (x: unknown) => ({ ok: true, status: 200, json: async () => x }) as unknown as Response;
        if (url.includes("binance")) {
          // a market that has fallen for 30 days, then the hour that just closed, then the running one
          const n = 800;
          return json(Array.from({ length: n + 1 }, (_, i) => [(hour0 - n + i) * H, "0", String(300 - i * 0.2 + 0.1), String(300 - i * 0.2 - 0.1), String(i === n ? perpPx : 300 - i * 0.2)]));
        }
        if (url.includes("leaderboard")) return json({ leaderboardRows: [{ ethAddress: trader, accountValue: "500000", windowPerformances: [["week", { pnl: "1", roi: "1", vlm: "1" }], ["month", { pnl: "90000", roi: "0.5", vlm: "5000000" }], ["allTime", { pnl: "100000", roi: "1", vlm: "1" }]] }] });
        const body = JSON.parse(init!.body!) as { type: string };
        if (body.type === "allMids") return json({ SOL: String(solPx) });
        return json({ assetPositions: traderPos });
      }) as unknown as typeof fetch,
  };
  // the day-holder study's file: one closed copy of a coin that the lookup calls a meme, +10% after costs
  mkdirSync(join(dir, "solana"), { recursive: true });
  writeFileSync(join(dir, "solana", "slow-paper.json"), JSON.stringify({ open: [], recent: [{ wallet: "W", name: "w", mint: MINT(9), seenMs: 1, leaderSol: 1, entries: { e30: "5" }, exits: { "e30-x30": 0.277 }, closed: "sold", closedMs: 2 }] }));

  // an hour of flat 5-minute closes, then a 3% fall: the high-cap dip rule buys at a quote
  let now = Math.floor(NOW / H) * H + 20_000;
  hour0 = Math.floor(now / H);
  for (let i = 0; i < 13; i++, now += 300_000) await bucketsTick(deps, now);
  assert.equal(_bucketsTest.state().open.length, 0);
  price = 97;
  await bucketsTick(deps, now);
  const st = _bucketsTest.state();
  assert.deepEqual(st.open.map((o) => o.rule), ["high-dip1h"]);
  assert.equal(quotes.at(-1), "buy 50000000", "a $50 quote taken after the signal");
  // the bounce: +2% on the price it bought at sells, at a quote for exactly the tokens it holds
  price = 99;
  now += 60_000;
  await bucketsTick(deps, now);
  assert.equal(st.open.length, 0);
  assert.equal(quotes.at(-1), `sell ${Math.floor((50 / 97) * 0.99 * 1e6)}`);
  const t = _bucketsTest.state().trades[0];
  assert.equal(t.why, "target");
  // 50 * 0.99 * 99/97 * 0.99 - 50 - 0.02
  assert.ok(Math.abs(t.netUsd - (50 * 0.99 * (99 / 97) * 0.99 - 50 - 0.02)) < 0.001, "what the two quotes left, less two fees: a loss although the price bounced");
  assert.ok(t.netUsd < 0);
  // no second buy of the same coin inside the cool-down
  price = 90;
  now += 300_000;
  await bucketsTick(deps, now);
  assert.equal(_bucketsTest.state().open.filter((o) => o.rule === "high-dip1h").length, 0);

  // perps: the falling market opened shorts at the price of the look
  const shorts = _bucketsTest.state().perpOpen.filter((o) => o.rule === "SOL-break-24h");
  assert.equal(shorts.length, 1);
  assert.equal(shorts[0].dir, -1);
  assert.equal(shorts[0].entry, 100);

  // the copied trader: nothing on the first look, a copy when a position appears, closed when it goes
  assert.equal(_bucketsTest.state().hlOpen.length, 0);
  traderPos = [{ position: { coin: "SOL", szi: "-1000", positionValue: "150000" } }];
  now += 60_000;
  await bucketsTick(deps, now);
  assert.deepEqual(_bucketsTest.state().hlOpen.map((o) => [o.coin, o.dir, o.entry]), [["SOL", -1, 150]]);
  solPx = 147;
  traderPos = [];
  now += 60_000;
  await bucketsTick(deps, now);
  const c = _bucketsTest.state().hlTrades[0];
  assert.ok(Math.abs(c.net - (0.02 - 0.0014 - 0.000016 / 60)) < 1e-5, "2% gained on the short, less Jupiter's two fees and a minute of borrow");

  const sum = bucketsSummary();
  assert.equal(sum.mode, "paper");
  assert.equal(sum.spot.find((b) => b.bucket === "high")!.rules.find((x) => x.id === "high-dip1h")!.trades, 1);
  assert.deepEqual(sum.spot.find((b) => b.bucket === "meme")!.copy, { trades: 1, won: 1, net: 0.1, avgPct: 10 }, "(0.277 - 0.002) / 0.25 - 1");
  assert.equal(sum.perpCopy.shorts.trades, 1);
  assert.ok(!JSON.stringify(sum).includes(trader), "no full trader address in the status");
  assert.ok(sum.jupiter.usedToday > 0 && sum.jupiter.usedToday < 200);
  // the state survives a restart
  _bucketsTest.reload();
  assert.equal(_bucketsTest.state().trades.length, 1);
});

test("buckets: the Jupiter allowance stops new requests", async () => {
  _bucketsTest.reset();
  process.env.SOLANA_BUCKETS_JUP_DAY = "2";
  let calls = 0;
  const deps = { quote: async () => 1n, jup: async () => (calls++, [row(1, 2e9)]), fetch: () => (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch };
  await bucketsTick(deps, NOW + 20_000);
  await bucketsTick(deps, NOW + 80_000);
  assert.ok(calls <= 2, `asked ${calls} times`);
  delete process.env.SOLANA_BUCKETS_JUP_DAY;
});

test("buckets: leverage on paper: liquidation, tiers, confidence, the traders' own leverage", () => {
  const { levResult, liqMove, levTable, perpConfidence, worstMove, hlLeverage, CONF_LEV, LEV_TIERS } = B;
  // 10x: the price may go 10% - fees (0.14%) - borrow - 0.2% against us
  assert.ok(Math.abs(liqMove(10, 0) - (0.1 - 0.0014 - 0.002)) < 1e-12);
  assert.deepEqual(levResult(0.01, 0.02, 1, 5), { ret: 0.05, liquidated: false });
  // won in the end, but the price went 12% against a 10x on the way: the collateral is gone
  assert.deepEqual(levResult(0.03, 0.12, 1, 10), { ret: -1, liquidated: true });
  assert.equal(levResult(0.03, 0.12, 1, 5).liquidated, false);
  assert.equal(levResult(-0.3, 0.1, 1, 5).ret, -1); // never more than the collateral
  const table = levTable([{ net: 0.03, worst: 0.12, hours: 1, dir: -1 }, { net: 0.01, worst: 0, hours: 1, dir: 1 }, { net: 0.5, hours: 1, dir: 1 }]);
  assert.equal(table.length, LEV_TIERS.length);
  assert.deepEqual(table.find((x) => x.lev === 5), { lev: 5, trades: 2, won: 2, liquidated: 0, netUsd: 4, avgPctOfCollateral: 10 }); // the trade with no worst price is left out
  assert.equal(table.find((x) => x.lev === 10)?.liquidated, 1);
  assert.equal(table.find((x) => x.lev === 10)?.netUsd, -18);
  // worst move: a short opened at 100 after hour 5; later candles reached 104
  const k = { t: [4, 5, 6, 7], h: [120, 120, 104, 101], l: [90, 90, 99, 97], c: [100, 100, 100, 98] };
  assert.ok(Math.abs(worstMove(k, 5, -1, 100, 98) - 0.04) < 1e-12);
  assert.ok(Math.abs(worstMove(k, 5, 1, 100, 98) - 0.03) < 1e-12);
  // confidence: a steady fall, quiet last day, traders short -> a short scores 4, a long 1 (quiet only)
  const n = 800;
  const c = Array.from({ length: n }, (_, i) => 300 - i * 0.2);
  const wide = (i: number) => (i >= n - 24 ? 0.05 : 2);
  const fall = { t: c.map((_, i) => i), h: c.map((x, i) => x + wide(i)), l: c.map((x, i) => x - wide(i)), c };
  assert.equal(perpConfidence(fall, n - 1, -1, -50_000), 4);
  assert.equal(perpConfidence(fall, n - 1, 1, -50_000), 1);
  assert.equal(perpConfidence(fall, n - 1, -1, 0), 3);
  assert.equal(CONF_LEV.length, 5);
  assert.deepEqual(hlLeverage({ assetPositions: [{ position: { coin: "SOL", leverage: { type: "cross", value: 20 } } }, { position: { coin: "BTC", leverage: { value: 0 } } }, { position: { coin: "ETH" } }] }), { SOL: 20 });
});

test("buckets: one copied trader's own record and the bar for following it for real", () => {
  const { traderRule, traderRecord, traderMeetsBar, perpMeetsBar, perpPaperOpens, perpRuleIds, TRADER_MIN_COPIES, bucketsSummary: sum } = B;
  _bucketsTest.reset();
  const A = "0x" + "ab".repeat(20);
  const Z = "0x" + "cd".repeat(20);
  const now = Date.now();
  const copy = (trader: string, i: number, net: number, at: number) => ({ trader, coin: i % 2 ? "SOL" : "HYPE", dir: i % 2 ? -1 : 1, at: at + i, exitAt: at + i + 1000, net, why: "closed" as const, lev: 20, worst: 0.01 });
  const old = now - 30 * 3_600_000;
  _bucketsTest.state().hlTrades = [
    ...Array.from({ length: TRADER_MIN_COPIES }, (_, i) => copy(A, i, i < 12 ? 0.02 : -0.01, old)),
    ...Array.from({ length: TRADER_MIN_COPIES }, (_, i) => copy(Z, i, i < 12 ? 0.02 : -0.01, now - 3_600_000)), // good, but only an hour on paper
  ] as never;
  const rule = traderRule(A);
  assert.equal(rule, "copy-abababab");
  assert.equal(traderRecord(rule).trades, TRADER_MIN_COPIES);
  assert.equal(perpMeetsBar(rule), true);
  assert.equal(perpMeetsBar(traderRule(Z)), false, "a day on paper first");
  assert.equal(perpMeetsBar(rule, now), false, "after a demotion only copies made later count");
  assert.equal(traderMeetsBar({ trades: 19, won: 19, netUsd: 5, firstAt: old }), false);
  assert.equal(traderMeetsBar({ trades: 20, won: 9, netUsd: 5, firstAt: old }), false);
  assert.equal(traderMeetsBar({ trades: 20, won: 10, netUsd: 0, firstAt: old }), false);
  // review 63 (16 Nov 2026): with minOurs, that many of the copies must be on SOL, BTC or ETH (0 = off)
  assert.equal(traderMeetsBar({ trades: 28, won: 20, netUsd: 5, firstAt: old, ours: 0 }), true);
  assert.equal(traderMeetsBar({ trades: 28, won: 20, netUsd: 5, firstAt: old, ours: 0 }, Date.now(), 3), false);
  assert.equal(traderMeetsBar({ trades: 28, won: 20, netUsd: 5, firstAt: old, ours: 2 }, Date.now(), 3), false);
  assert.equal(traderMeetsBar({ trades: 28, won: 20, netUsd: 5, firstAt: old, ours: 3 }, Date.now(), 3), true);
  const ours = traderRecord(rule).ours;
  assert.equal(perpMeetsBar(rule, 0, Date.now(), ours), true);
  assert.equal(perpMeetsBar(rule, 0, Date.now(), ours + 1), false, "one copy short on SOL, BTC or ETH");
  assert.ok(perpRuleIds().includes(rule));
  // its positions on SOL, BTC, ETH (long or short) are offered to the real side under the trader's own name; another coin is not
  _bucketsTest.state().hlOpen = [{ trader: A, coin: "SOL", dir: -1, at: now, entry: 100, lev: 20, worst: 0 }, { trader: A, coin: "HYPE", dir: -1, at: now, entry: 30 }, { trader: A, coin: "BTC", dir: 1, at: now, entry: 60000 }] as never;
  assert.deepEqual(perpPaperOpens().map((o) => [o.rule, o.coin, o.dir]), [[rule, "SOL", -1], [rule, "BTC", 1]]);
  const pc = sum().perpCopy;
  assert.equal(pc.tradersCopied, 2);
  assert.equal(pc.tradersAtBar, 1);
  const row = pc.traderRecords[0];
  assert.equal(row.id, rule);
  assert.equal(row.atBar, true);
  assert.equal(row.leverage, 20);
  // at the trader's 20x capped to 10x: 12 wins of +20% and 8 losses of -10% of the collateral
  assert.deepEqual(row.atOwnLeverage, { trades: 20, won: 12, liquidated: 0, netUsd: 32, avgPctOfCollateral: 8 });
  assert.ok(!JSON.stringify(pc).includes(A));
});

test("buckets: a trader the list dropped and took back is looked at afresh: what it opened in between is not copied", async () => {
  _bucketsTest.reset();
  const A = "0x" + "a".repeat(40);
  const B = "0x" + "b".repeat(40);
  const rowOf = (a: string) => ({ ethAddress: a, accountValue: "500000", windowPerformances: [["week", { pnl: "1", roi: "1", vlm: "1" }], ["month", { pnl: "90000", roi: "0.5", vlm: "5000000" }], ["allTime", { pnl: "100000", roi: "1", vlm: "1" }]] });
  let board = [A];
  let posA: unknown[] = [];
  const deps = {
    quote: async () => 0n,
    jup: async () => [],
    fetch: () =>
      (async (url: string, init?: { body?: string }) => {
        const json = (x: unknown) => ({ ok: true, status: 200, json: async () => x }) as unknown as Response;
        if (url.includes("binance")) return json([]);
        if (url.includes("leaderboard")) return json({ leaderboardRows: board.map(rowOf) });
        const body = JSON.parse(init!.body!) as { type: string; user?: string };
        if (body.type === "allMids") return json({ SOL: "150", BTC: "90000" });
        return json({ assetPositions: body.user === A ? posA : [] });
      }) as unknown as typeof fetch,
  };
  let now = NOW;
  const tick = async () => bucketsTick(deps as never, (now += 60_000));
  const st = () => _bucketsTest.state();
  await tick(); // first look at A: holds nothing
  posA = [{ position: { coin: "SOL", szi: "-1000", positionValue: "150000" } }];
  await tick();
  assert.deepEqual(st().hlOpen.map((o) => o.coin), ["SOL"]);
  // the daily list leaves A out: its open copy is still followed to its end
  board = [B];
  st().hlAt = 0;
  await tick();
  assert.deepEqual(st().hlTraders.map((t) => t.address), [B]);
  assert.ok(st().hlSeen[A], "still looked at while a copy of it is open");
  posA = [];
  await tick();
  assert.equal(st().hlOpen.length, 0);
  assert.equal(st().hlTrades.length, 1);
  assert.equal(st().hlSeen[A], undefined, "nothing of it is open: what it held is forgotten");
  // off the list it opens a BTC long that we never saw; then it is back on the list
  posA = [{ position: { coin: "BTC", szi: "1", positionValue: "90000" } }];
  await tick();
  board = [A, B];
  st().hlAt = 0;
  await tick();
  await tick();
  assert.equal(st().hlOpen.length, 0, "a position opened at a price we never saw is not copied as new");
});

test("buckets: a trader the real side names as a winner stays followed when the daily list leaves it out", async () => {
  _bucketsTest.reset();
  const A = "0x" + "c".repeat(40);
  const Bq = "0x" + "d".repeat(40);
  const rowOf = (a: string) => ({ ethAddress: a, accountValue: "500000", windowPerformances: [["week", { pnl: "1", roi: "1", vlm: "1" }], ["month", { pnl: "90000", roi: "0.5", vlm: "5000000" }], ["allTime", { pnl: "100000", roi: "1", vlm: "1" }]] });
  let board = [A];
  let posA: unknown[] = [];
  const deps = {
    quote: async () => 0n,
    jup: async () => [],
    fetch: () =>
      (async (url: string, init?: { body?: string }) => {
        const json = (x: unknown) => ({ ok: true, status: 200, json: async () => x }) as unknown as Response;
        if (url.includes("binance")) return json([]);
        if (url.includes("leaderboard")) return json({ leaderboardRows: board.map(rowOf) });
        const body = JSON.parse(init!.body!) as { type: string; user?: string };
        if (body.type === "allMids") return json({ SOL: "150" });
        return json({ assetPositions: body.user === A ? posA : [] });
      }) as unknown as typeof fetch,
  };
  let now = NOW + 86_400_000;
  const tick = async () => bucketsTick(deps as never, (now += 60_000));
  const st = () => _bucketsTest.state();
  await tick();
  let kept = [B.traderRule(A)];
  B.setKeptTraders(() => kept);
  try {
    board = [Bq];
    st().hlAt = 0;
    await tick();
    assert.deepEqual(st().hlTraders.map((t) => t.address), [Bq, A], "the winner stays on the list");
    assert.equal(B.traderListed(B.traderRule(A)), true);
    posA = [{ position: { coin: "SOL", szi: "-1000", positionValue: "150000" } }];
    await tick();
    assert.deepEqual(st().hlOpen.map((o) => o.trader), [A], "and its new position is copied");
    // no longer named (its real record fell behind and it was cut): gone at the next list read
    kept = [];
    st().hlAt = 0;
    await tick();
    assert.deepEqual(st().hlTraders.map((t) => t.address), [Bq]);
  } finally {
    B.setKeptTraders(() => []);
  }
});

test("buckets: a trader's close seen in a look whose prices fail is not lost: no trader is looked at without prices", async () => {
  _bucketsTest.reset();
  const A = "0x" + "e".repeat(40);
  const rowOf = (a: string) => ({ ethAddress: a, accountValue: "500000", windowPerformances: [["week", { pnl: "1", roi: "1", vlm: "1" }], ["month", { pnl: "90000", roi: "0.5", vlm: "5000000" }], ["allTime", { pnl: "100000", roi: "1", vlm: "1" }]] });
  let posA: unknown[] = [];
  let midsFail = false;
  const deps = {
    quote: async () => 0n,
    jup: async () => [],
    fetch: () =>
      (async (url: string, init?: { body?: string }) => {
        const json = (x: unknown, status = 200) => ({ ok: status === 200, status, json: async () => x }) as unknown as Response;
        if (url.includes("binance")) return json([]);
        if (url.includes("leaderboard")) return json({ leaderboardRows: [rowOf(A)] });
        const body = JSON.parse(init!.body!) as { type: string; user?: string };
        if (body.type === "allMids") return midsFail ? json({}, 429) : json({ SOL: "150", BTC: "90000" });
        return json({ assetPositions: body.user === A ? posA : [] });
      }) as unknown as typeof fetch,
  };
  let now = NOW + 2 * 86_400_000;
  const tick = async () => bucketsTick(deps as never, (now += 60_000));
  const st = () => _bucketsTest.state();
  await tick();
  posA = [{ position: { coin: "SOL", szi: "-1000", positionValue: "150000" } }];
  await tick();
  assert.equal(st().hlOpen.length, 1);
  // the trader closes in a look where the prices answer 429
  posA = [];
  midsFail = true;
  await tick();
  assert.equal(st().hlOpen.length, 1);
  assert.deepEqual(Object.keys(st().hlSeen[A] ?? {}), ["SOL"], "what it held is not overwritten without prices");
  assert.equal(st().errors.traders !== undefined, true);
  midsFail = false;
  await tick();
  assert.equal(st().hlOpen.length, 0, "the close is seen at the next look and booked");
  assert.equal(st().hlTrades.length, 1);
});

test("buckets: the trader list prefers traders on SOL, BTC and ETH, and leaves out those whose copies are all elsewhere", async () => {
  _bucketsTest.reset();
  const addr = (c: string) => "0x" + c.repeat(40);
  const [ON, OFF, NEW, SEEN] = [addr("1"), addr("2"), addr("3"), addr("4")];
  // month profit: OFF best, then NEW, SEEN, ON
  const rowOf = (a: string, pnl: number) => ({ ethAddress: a, accountValue: "500000", windowPerformances: [["week", { pnl: "1", roi: "1", vlm: "1" }], ["month", { pnl: String(pnl * 10000), roi: "0.5", vlm: "5000000" }], ["allTime", { pnl: "100000", roi: "1", vlm: "1" }]] });
  const deps = {
    quote: async () => 0n,
    jup: async () => [],
    fetch: () =>
      (async (url: string, init?: { body?: string }) => {
        const json = (x: unknown) => ({ ok: true, status: 200, json: async () => x }) as unknown as Response;
        if (url.includes("binance")) return json([]);
        if (url.includes("leaderboard")) return json({ leaderboardRows: [rowOf(OFF, 40), rowOf(NEW, 30), rowOf(SEEN, 20), rowOf(ON, 10)] });
        const body = JSON.parse(init!.body!) as { type: string; user?: string };
        if (body.type === "allMids") return json({ SOL: "150", BTC: "90000" });
        return json({ assetPositions: body.user === SEEN ? [{ position: { coin: "ETH", szi: "50", positionValue: "150000" } }] : [] });
      }) as unknown as typeof fetch,
  };
  const st = _bucketsTest.state();
  const now = NOW + 3 * 86_400_000;
  const copy = (trader: string, coin: string, i: number) => ({ trader, coin, dir: 1, at: now - 5 * 86_400_000 + i, exitAt: now - 4 * 86_400_000, net: 0.01, why: "closed" as const });
  st.hlTrades = [...Array.from({ length: 12 }, (_, i) => copy(OFF, "DOGE", i)), copy(ON, "SOL", 0), ...Array.from({ length: 11 }, (_, i) => copy(ON, "DOGE", i + 1))] as never;
  assert.equal(B.majorTier(ON, now), 0);
  assert.equal(B.majorTier(OFF, now), 2);
  assert.equal(B.majorTier(NEW, now), 1);
  await bucketsTick(deps as never, now);
  assert.deepEqual(st.hlTraders.map((t) => t.address), [ON, NEW, SEEN], "OFF is left out; ON first although its month is the smallest");
  // SEEN was looked at holding ETH: it moves up at the next list read
  assert.ok(st.hlMajorSeen?.[SEEN]);
  st.hlAt = 0;
  await bucketsTick(deps as never, now + 60_000);
  assert.deepEqual(st.hlTraders.map((t) => t.address), [SEEN, ON, NEW], "both on Jupiter's coins, by month profit; then the one not known yet");
});

test("buckets: a linked wallet is followed on paper off the list; liked traders are named from our own copy record", async () => {
  _bucketsTest.reset();
  const A = "0x" + "a".repeat(40);
  const X = "0x" + "c".repeat(40);
  const rowOf = (a: string) => ({ ethAddress: a, accountValue: "500000", windowPerformances: [["week", { pnl: "1", roi: "1", vlm: "1" }], ["month", { pnl: "90000", roi: "0.5", vlm: "5000000" }], ["allTime", { pnl: "100000", roi: "1", vlm: "1" }]] });
  let posX: unknown[] = [];
  const deps = {
    quote: async () => 0n,
    jup: async () => [],
    fetch: () =>
      (async (url: string, init?: { body?: string }) => {
        const json = (x: unknown) => ({ ok: true, status: 200, json: async () => x }) as unknown as Response;
        if (url.includes("binance")) return json([]);
        if (url.includes("leaderboard")) return json({ leaderboardRows: [rowOf(A), { ethAddress: X, accountValue: "1200" }, { ethAddress: "bad", accountValue: "5" }] });
        const body = JSON.parse(init!.body!) as { type: string; user?: string };
        if (body.type === "allMids") return json({ SOL: "150", BTC: "90000" });
        return json({ assetPositions: body.user === X ? posX : [] });
      }) as unknown as typeof fetch,
  };
  let now = NOW;
  const tick = async () => bucketsTick(deps as never, (now += 60_000));
  const st = () => _bucketsTest.state();
  B.setExtraTraders(() => [X, "not an address"]);
  try {
    await tick();
    assert.deepEqual(st().hlTraders.map((t) => t.address), [A, X]);
    assert.deepEqual(B.hlBoard(), [{ address: A, acct: 500000 }, { address: X, acct: 1200 }], "the whole board, small accounts too");
    assert.deepEqual(JSON.parse((await import("node:fs")).readFileSync(join(dir, "solana", "hl-board.json"), "utf8")), [[A, 500000], [X, 1200]], "kept for the next start");
    posX = [{ position: { coin: "SOL", szi: "-1000", positionValue: "150000" } }];
    await tick();
    assert.deepEqual(st().hlOpen.map((o) => [o.trader, o.coin]), [[X, "SOL"]], "copied on paper like a trader of the list");
    assert.equal(B.traderListed(B.traderRule(X)), true);
    assert.equal(B.traderMeetsBar(B.traderRecord(B.traderRule(X)), now), false, "linked is not a record: no copies closed, no bar");
    // liked: 10+ closed copies, half won, ahead
    assert.deepEqual(B.likedTraders(now), []);
    for (let i = 0; i < 10; i++) st().hlTrades.push({ trader: A, coin: "BTC", dir: 1, at: now - 1000 - i, exitAt: now - i, net: i < 6 ? 0.02 : -0.01, why: "closed", worst: 0 } as never);
    assert.deepEqual(B.likedTraders(now), [{ address: A, why: "paper" }]);
  } finally {
    B.setExtraTraders(() => []);
  }
});

test("a followed position stays followed while it is still held, even when it dips under the size to start following", async () => {
  const { hlPositions, hlDiff, HL_MIN_POS_USD, HL_KEEP_POS_USD } = await import("./buckets.js");
  const st = (v: number, szi = "-100") => ({ assetPositions: [{ position: { coin: "ATOM", szi, positionValue: String(v) } }] });
  const a = hlPositions(st(HL_MIN_POS_USD + 50))!;
  const b = hlPositions(st(HL_MIN_POS_USD - 80), a)!;
  assert.deepEqual(hlDiff(a, b), { opened: [], closed: [] });
  assert.deepEqual(hlPositions(st(HL_MIN_POS_USD - 80)), {}, "not followed yet: too small to start");
  assert.deepEqual(hlDiff(b, hlPositions(st(HL_KEEP_POS_USD - 1), b)!), { opened: [], closed: ["ATOM"] });
  assert.deepEqual(hlDiff(b, hlPositions(st(HL_MIN_POS_USD - 80, "100"), b)!), { opened: [], closed: ["ATOM"] }, "turned round under the size: closed, not followed as new");
});

test("trader sizes in coins and account value, for partial closes and conviction (19 Nov 2026)", () => {
  const st = { marginSummary: { accountValue: "20000" }, assetPositions: [{ position: { coin: "SOL", szi: "-500", positionValue: "41000" } }, { position: { coin: "X", szi: "0" } }] };
  assert.deepEqual(B.hlSizes(st), { SOL: 500 });
  // the size a trader held when an old copy opened, from its own fills since: a short of 100 cut to 60, then to 50
  const fills = [
    { coin: "ETH", time: 3000, side: "B", sz: "10", startPosition: "-60" },
    { coin: "ETH", time: 2000, side: "B", sz: "15", startPosition: "-75" },
    { coin: "ETH", time: 2000, side: "B", sz: "25", startPosition: "-100" },
    { coin: "BTC", time: 2500, side: "A", sz: "1", startPosition: "0" },
  ];
  assert.deepEqual(B.hlSizeBack(fills, "ETH", -1, 50), { sz0: 100, hist: [[2000, 85], [2000, 60], [3000, 50]] });
  assert.deepEqual(B.hlSizeBack(fills, "ETH", -1, 80), { sz0: 80, hist: [] }, "the fills do not end at the size held now: nothing is assumed");
  assert.deepEqual(B.hlSizeBack([], "ETH", -1, 50), { sz0: 50, hist: [] });
  assert.deepEqual(B.hlSizeBack(null, "ETH", -1, 50), { sz0: 50, hist: [] });
  assert.equal(B.hlAccountValue(st), 20000);
  assert.equal(B.hlAccountValue({}), null);
});

test("a trader's own history: closed positions out of its fills, and the same bar on them (20 Nov 2026)", () => {
  const H = 3_600_000;
  const f = (coin: string, time: number, side: string, sz: number, px: number, start: number, closedPnl = 0, fee = 0) => ({ coin, time, side, sz: String(sz), px: String(px), startPosition: String(start), closedPnl: String(closedPnl), fee: String(fee) });
  const fills = [
    // a long of 10 ETH at 2000 ($20k), added to, closed in two parts 3 hours later: +$600 less $30 of fees
    f("ETH", 1 * H, "B", 10, 2000, 0, 0, 10),
    f("ETH", 2 * H, "B", 5, 2000, 10, 0, 5),
    f("ETH", 3 * H, "A", 5, 2040, 15, 200, 5),
    f("ETH", 4 * H, "A", 10, 2040, 10, 400, 10),
    // open at the first fill we have: its start was never seen, not counted
    f("BTC", 1 * H, "A", 1, 100000, 1, 500, 5),
    // under $10k at its largest: we would not have copied it
    f("DOGE", 1 * H, "B", 1000, 0.2, 0, 0, 0),
    f("DOGE", 5 * H, "A", 1000, 0.3, 1000, 100, 0),
    // in and out in a minute: not copyable
    f("SOL", 1 * H, "B", 100, 150, 0, 0, 1),
    f("SOL", 1 * H + 60_000, "A", 100, 151, 100, 100, 1),
    // a short turned round to a long: the short counts, the long that starts in the same fill does not
    f("HYPE", 2 * H, "A", 500, 40, 0, 0, 4),
    f("HYPE", 6 * H, "B", 800, 42, -500, -1000, 6),
    f("HYPE", 9 * H, "A", 300, 50, 300, 2400, 3),
    // spot is not a position
    f("@107", 1 * H, "B", 1000, 20, 0, 0, 0),
    f("@107", 5 * H, "A", 1000, 30, 1000, 10000, 0),
    { coin: "ETH", time: "x" },
  ];
  assert.deepEqual(B.hlTrips(fills), [
    { coin: "ETH", openAt: 1 * H, closeAt: 4 * H, pct: 0.018627 }, // 570 over 15 x 2040
    { coin: "HYPE", openAt: 2 * H, closeAt: 6 * H, pct: -0.048095 }, // -1010 over 500 x 42
  ]);
  assert.deepEqual(B.hlTrips(fills, 5 * H).map((x) => x.coin), ["HYPE"]);
  assert.deepEqual(B.hlTrips(null), []);
  assert.deepEqual(B.hlTrips([...fills, ...fills]), B.hlTrips(fills), "a fill read twice counts once");
  // fills missing in the middle (a gap between pages): the position is not followed across the gap
  const gap = [f("ETH", 1 * H, "B", 10, 2000, 0), f("ETH", 30 * H, "A", 4, 2100, 25, 400), f("ETH", 31 * H, "A", 21, 2100, 21, 2100), f("ETH", 40 * H, "B", 10, 2000, 0), f("ETH", 44 * H, "A", 10, 2100, 10, 1000)];
  assert.deepEqual(B.hlTrips(gap).map((x) => [x.openAt, x.closeAt, x.pct]), [[40 * H, 44 * H, 0.047619]]);
  const now = 400 * 86_400_000;
  const trips = (n: number, won: number, each = 0.01, at = now - 86_400_000): [number, number][] => Array.from({ length: n }, (_, i) => [at + i, i < won ? each : -each]);
  assert.equal(B.histMeetsBar(trips(20, 11), 0, now), true);
  assert.equal(B.histMeetsBar(trips(19, 19), 0, now), false, "under 20 closed");
  assert.equal(B.histMeetsBar(trips(20, 9), 0, now), false, "under half won");
  assert.equal(B.histMeetsBar([...trips(20, 12), [now - 1000, -0.2]], 0, now), false, "not ahead");
  assert.equal(B.histMeetsBar(trips(30, 30, 0.01, now - 91 * 86_400_000), 0, now), false, "older than the 90 days");
  assert.equal(B.histMeetsBar(trips(30, 30, 0.01, now - 60 * 86_400_000), 0, now), true, "two months back counts (21 Nov 2026: 90 days)");
  assert.equal(B.histMeetsBar(trips(30, 30), now, now), false, "after a cut only positions closed since count");
});

test("a followed trader's history is read once a day, and qualifies it unless our own paper copies of it are behind", async () => {
  B._bucketsTest.reset();
  const st = B._bucketsTest.state();
  const A = "0x" + "ab".repeat(20);
  const C = "0x" + "cd".repeat(20);
  const now = 1_800_000_000_000;
  st.hlTraders = [{ address: A, monthPnl: 5, monthRoi: 0.1, acct: 2_000_000 }, { address: C, monthPnl: 4, monthRoi: 0.1 }];
  st.hlAt = now;
  const fill = (i: number, win: boolean) => [
    { coin: "ETH", time: now - (30 - i) * 3_600_000, side: "B", sz: "10", px: "2000", startPosition: "0", closedPnl: "0", fee: "1" },
    { coin: "ETH", time: now - (30 - i) * 3_600_000 + 1_800_000, side: "A", sz: "10", px: "2000", startPosition: "10", closedPnl: win ? "300" : "-100", fee: "1" },
  ];
  const asked: string[] = [];
  const deps = {
    quote: async () => 1n,
    jup: async () => [],
    fetch: () =>
      (async (_u: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { type: string; user?: string };
        if (/^userFills/.test(body.type)) asked.push(body.user!);
        const out = body.type === "allMids" ? { BTC: "100000", ETH: "2000" } : /^userFills/.test(body.type) ? (body.user === A ? Array.from({ length: 22 }, (_, i) => fill(i, i % 2 === 0)).flat() : []) : { marginSummary: { accountValue: "1000000" }, assetPositions: [] };
        return { ok: true, status: 200, json: async () => out };
      }) as unknown as typeof fetch,
  };
  await B._bucketsTest.hlTick(deps, now);
  await B._bucketsTest.hlTick(deps, now + 60_000);
  assert.deepEqual(asked, [A, C], "each once");
  const rule = B.traderRule(A);
  assert.equal(B.hlHistoryMeetsBar(rule, 0, now + 60_000), true);
  assert.equal(B.hlHistoryMeetsBar(B.traderRule(C), 0, now + 60_000), false, "nothing closed");
  assert.equal(B.hlHistoryMeetsBar(rule, now, now + 60_000), false, "after a cut it starts again");
  assert.equal(B.hlHistoryMeetsBar(rule, 0, now + 3 * 86_400_000), false, "a history not read for two days is not trusted");
  const sum = B.hlHistorySummary(now + 60_000);
  assert.deepEqual([sum.followed, sum.read, sum.with20, sum.atBar, sum.atBarNotOnPaper], [2, 2, 1, 1, 1]);
  assert.deepEqual(sum.traders.map((x) => [x.id, x.closed, x.won, x.accountUsd]), [[rule, 22, 11, 2_000_000]]);
  assert.ok(!JSON.stringify(sum).includes(A.slice(10)), "no address in the status");
  // five paper copies of ours, behind: the history does not carry it
  for (let i = 0; i < 5; i++) st.hlTrades.push({ trader: A, coin: "ETH", dir: 1, at: now - 1000 + i, exitAt: now, net: -0.01, why: "closed" });
  assert.equal(B.hlHistoryMeetsBar(rule, 0, now + 60_000), false);
  // off the list: forgotten
  st.hlTraders = [st.hlTraders[1]];
  await B._bucketsTest.hlTick(deps, now + 120_000);
  assert.equal(Object.keys(st.hlHist ?? {}).includes(A), false);
});

test("a 90-day history is read in pages; a trader with more than the pages hold gets its newest fills too; a failed page keeps nothing", async () => {
  B._bucketsTest.reset();
  const st = B._bucketsTest.state();
  const A = "0x" + "ef".repeat(20);
  const now = 1_800_000_000_000;
  st.hlTraders = [{ address: A, monthPnl: 5, monthRoi: 0.1 }];
  st.hlAt = now;
  const calls: { type: string; startTime?: number }[] = [];
  let pages = 2;
  let fail = false;
  const row = (t: number) => ({ coin: "ETH", time: t, side: "B", sz: "0.001", px: "2000", startPosition: "1", closedPnl: "0", fee: "0" });
  const deps = {
    quote: async () => 1n,
    jup: async () => [],
    fetch: () =>
      (async (_u: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { type: string; startTime?: number };
        if (/^userFills/.test(body.type)) calls.push({ type: body.type, startTime: body.startTime });
        const n = calls.filter((c) => c.type === "userFillsByTime").length;
        if (body.type === "userFillsByTime" && fail && n === 2) return { ok: false, status: 500, json: async () => null };
        const out = body.type === "allMids" ? { BTC: "100000", ETH: "2000" } : body.type === "userFillsByTime" ? Array.from({ length: n < pages ? 2000 : 5 }, (_, i) => row(body.startTime! + i)) : body.type === "userFills" ? [row(now - 5)] : { marginSummary: { accountValue: "1000000" }, assetPositions: [] };
        return { ok: true, status: 200, json: async () => out };
      }) as unknown as typeof fetch,
  };
  await B._bucketsTest.hlTick(deps, now);
  const t0 = now - 90 * 86_400_000;
  assert.deepEqual(calls, [{ type: "userFillsByTime", startTime: t0 }, { type: "userFillsByTime", startTime: t0 + 2000 }], "the second page starts after the first's last fill");
  assert.equal(st.hlHist?.[A]?.d, 90);
  // more than four full pages: the newest 2,000 are asked for as well
  calls.length = 0;
  pages = 99;
  delete st.hlHist![A];
  await B._bucketsTest.hlTick(deps, now + 60_000);
  assert.deepEqual(calls.map((c) => c.type), ["userFillsByTime", "userFillsByTime", "userFillsByTime", "userFillsByTime", "userFills"]);
  // a page that fails: nothing kept, asked again at the next look
  calls.length = 0;
  fail = true;
  delete st.hlHist![A];
  await B._bucketsTest.hlTick(deps, now + 120_000);
  assert.equal(st.hlHist?.[A], undefined);
  // a history read at 30 days is read again at once
  st.hlHist![A] = { at: now + 120_000, trips: [] };
  fail = false;
  pages = 1;
  calls.length = 0;
  await B._bucketsTest.hlTick(deps, now + 180_000);
  assert.equal(calls.length, 1);
  assert.equal(st.hlHist?.[A]?.d, 90);
});
