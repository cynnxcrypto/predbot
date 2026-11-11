import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "soldip-"));
process.env.DATA_DIR = dir;

const { closedCandles, DIP_RULES, DIP_STAKE_USD, DIP_TX_USD, dipExit, dipSignal, dipSummary, dipTick, _dipTest } = await import("./dip.js");
const { SOL, USDC } = await import("./pools.js");

const H = 3_600_000;
const rule = DIP_RULES.find((x) => x.id === "dip24-10-tp10-24h")!;

test("dip rule: the signal and the exits are those of the history test", () => {
  assert.deepEqual(rule, { id: "dip24-10-tp10-24h", fallHours: 24, fallPct: 10, targetPct: 10, holdHours: 24 });
  const c = [...Array.from({ length: 24 }, () => 100), 100, 91, 90, 89.9];
  assert.equal(dipSignal(rule, c, 23), false, "not enough hours before it");
  assert.equal(dipSignal(rule, c, 25), false, "9% down is not 10%");
  assert.equal(dipSignal(rule, c, 27), true, "10.1% down buys");
  const open = { signalHour: 500, refPrice: 90 };
  assert.equal(dipExit(rule, open, 501, 98.9), null);
  assert.equal(dipExit(rule, open, 501, 99.1), "target", "+10% on the close it bought on");
  assert.equal(dipExit(rule, open, 523, 80), null);
  assert.equal(dipExit(rule, open, 524, 80), "time", "24 hours after the close it bought on");
  // the same walk as research/sol-slow-rules.py's dip(): [F, F, T, T, F, F, F] for a 1 hour, 10% fall, +5%, 3 hour rule
  const small = { id: "x", fallHours: 1, fallPct: 10, targetPct: 5, holdHours: 3 };
  const closes = [100, 100, 89, 90, 95, 99, 99];
  const held: boolean[] = [];
  let pos: { signalHour: number; refPrice: number } | null = null;
  closes.forEach((close, i) => {
    if (pos && dipExit(small, pos, i, close)) pos = null;
    else if (!pos && dipSignal(small, closes, i)) pos = { signalHour: i, refPrice: close };
    held.push(!!pos);
  });
  assert.deepEqual(held, [false, false, true, true, false, false, false]);
  assert.ok(DIP_RULES.every((x) => x.fallPct >= 5 && x.holdHours <= 72) && new Set(DIP_RULES.map((x) => x.id)).size === DIP_RULES.length);
});

test("dip rule: only closed candles are read", () => {
  const now = 1000 * H + 20_000;
  const rows = [[998 * H, "1", "2", "0.5", "101.5", "0"], [999 * H, "1", "2", "0.5", "99", "0"], [1000 * H, "1", "2", "0.5", "50", "0"], ["x"], null];
  assert.deepEqual(closedCandles(rows, now), { t: [998, 999], c: [101.5, 99] }, "the hour still running is left out");
  assert.deepEqual(closedCandles({ code: -1 }, now), { t: [], c: [] });
});

test("dip rule on paper: buys at a real quote after the fall, sells at the target or the time, and never twice", async () => {
  _dipTest.reset();
  // hourly closes: flat at 100, then a fall to 89 at hour 1030 (11% down on 24 h before), back to 99 at hour 1033
  const price = (hour: number) => (hour < 1030 ? 100 : hour < 1033 ? 89 : hour < 1060 ? 99 : 100);
  const candles = (now: number) => Array.from({ length: 100 }, (_, k) => Math.floor(now / H) - 99 + k).map((hour) => [hour * H, "0", "0", "0", String(price(hour)), "0"]);
  const asked: string[] = [];
  let fail = 0;
  const deps = {
    fetch: () => (async (url: string) => (assert.ok(String(url).includes("api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1h")), new Response(JSON.stringify(candles(now))))) as never,
    quote: async (inMint: string, outMint: string, amount: string) => {
      asked.push(`${inMint === USDC ? "buy" : "sell"} ${amount}`);
      if (fail > 0) return fail--, undefined;
      // buying: $100 at $89.20 a SOL (a little above the candle); selling: those lamports at $98.80 a SOL
      return inMint === USDC ? BigInt(Math.round((100 / 89.2) * 1e9)) : BigInt(Math.round((Number(amount) / 1e9) * 98.8 * 1e6));
    },
    retryMs: 0,
  };
  let now = 1030 * H + 5_000;
  await dipTick(deps, now);
  assert.equal(_dipTest.state().lastHour, 0, "in the first 15 s of an hour the candle may not be final: no look");
  now = 1030 * H + 20_000; // hour 1029 has closed at 100: nothing to do
  await dipTick(deps, now);
  assert.deepEqual([_dipTest.state().lastHour, _dipTest.state().open.length, asked.length], [1029, 0, 0]);
  await dipTick(deps, now + 60_000);
  assert.equal(asked.length, 0, "the same hour is not looked at twice");
  now = 1031 * H + 20_000; // hour 1030 closed at 89: 11% below 24 hours earlier
  await dipTick(deps, now);
  const open = _dipTest.state().open;
  // 11% down buys for the 6, 8 and 10% rules (two exits of the 10% one) and the 4 hour 5% rule; not for the 12% rule
  assert.deepEqual(open.map((o) => o.rule).sort(), ["dip24-10-tp10-24h", "dip24-10-tp5-24h", "dip24-6-tp10-24h", "dip24-8-tp10-24h", "dip4-5-tp10-72h"]);
  assert.deepEqual([open[0].signalHour, open[0].refPrice, open[0].quotePrice], [1030, 89, 89.2]);
  assert.deepEqual(asked, Array.from({ length: 5 }, () => `buy ${DIP_STAKE_USD * 1e6}`));
  now = 1032 * H + 20_000; // hour 1031 closed at 89 again: already in, nothing bought twice
  await dipTick(deps, now);
  assert.equal(_dipTest.state().open.length, 5);
  // hour 1033 closes at 99: +11% on the close it bought on. The first quote fails, the second answers.
  fail = 1;
  now = 1034 * H + 20_000;
  await dipTick(deps, now);
  const s = _dipTest.state();
  assert.deepEqual(s.open.map((o) => o.rule), [], "all five sold at the target");
  const tr = s.trades.find((x) => x.rule === "dip24-10-tp10-24h")!;
  const usdOut = (100 / 89.2) * 98.8;
  assert.deepEqual([tr.why, tr.exitHour, tr.exitRef, tr.late], ["target", 1033, 99, undefined]);
  assert.ok(Math.abs(tr.usdOut - usdOut) < 0.001 && Math.abs(tr.netUsd - (usdOut - 100 - 2 * DIP_TX_USD)) < 0.001);
  assert.equal(tr.testPct, Math.round(((99 / 89) * 0.999 ** 2 - 1) * 10000) / 100, "what the history test would have counted for this trade");
  const sum = dipSummary();
  const row = sum.rules.find((x) => x.id === "dip24-10-tp10-24h")!;
  assert.deepEqual([row.trades, row.won, row.open, sum.rules.find((x) => x.id === "dip24-12-tp10-24h")!.trades], [1, 1, null, 0]);
  assert.ok(row.avgPct! > 10 && row.avgPct! < row.avgTestPct!, "the quoted trade is a little worse than the candle trade");
  assert.deepEqual([sum.lastLook!.price, sum.lastLook!.change24hPct, sum.mode], [99, -1, "paper"]);
  // kept across a restart
  _dipTest.reload();
  assert.equal(_dipTest.state().trades.length, 5);
  assert.ok(readFileSync(join(dir, "solana", "dip-state.json"), "utf8").includes("dip24-10-tp10-24h"));
});

test("dip rule on paper: the time exit, a sale that gets no quote, and a buy that gets none", async () => {
  _dipTest.reset();
  const price = (hour: number) => (hour < 2030 ? 100 : 88);
  let now = 0;
  const candles = () => Array.from({ length: 100 }, (_, k) => Math.floor(now / H) - 99 + k).map((hour) => [hour * H, "0", "0", "0", String(price(hour)), "0"]);
  let quotes = true;
  let n = 0;
  const deps = {
    fetch: () => (async () => new Response(JSON.stringify(candles()))) as never,
    quote: async (inMint: string, _out: string, amount: string) => (n++, !quotes ? undefined : inMint === USDC ? BigInt(Math.round((100 / 88) * 1e9)) : BigInt(Math.round((Number(amount) / 1e9) * 88 * 1e6))),
    retryMs: 0,
  };
  // no quote at the moment of the fall: nothing is bought and the miss is counted
  quotes = false;
  now = 2031 * H + 20_000;
  await dipTick(deps, now);
  assert.deepEqual([_dipTest.state().open.length, _dipTest.state().missedEntries, n], [0, 6, 18], "all six rules wanted to buy; each asked three times");
  // an hour later the price is still 12% below 24 hours earlier: now it buys (the 12% rule too)
  quotes = true;
  now = 2032 * H + 20_000;
  await dipTick(deps, now);
  assert.equal(_dipTest.state().open.length, 6);
  // 24 hours after the close it bought on the price is unchanged: the 24 hour rules are due, the 72 hour one is not.
  // The price service gives no quote: they stay open.
  quotes = false;
  now = 2056 * H + 20_000;
  await dipTick(deps, now);
  assert.deepEqual([_dipTest.state().open.length, _dipTest.state().trades.length], [6, 0]);
  // a minute later it answers: sold, and marked late
  quotes = true;
  await dipTick(deps, now + 60_000);
  const s = _dipTest.state();
  assert.deepEqual(s.open.map((o) => o.rule), ["dip4-5-tp10-72h"]);
  assert.ok(s.trades.length === 5 && s.trades.every((x) => x.why === "time" && x.late === true && x.exitHour === 2055));
  assert.ok(Math.abs(s.trades[0].netUsd - -2 * DIP_TX_USD) < 0.001, "bought and sold at the same price: only the network fees");
  // a rule that sold at a close does not buy again at that same close, as in the history test
  assert.equal(s.open.filter((o) => o.rule.startsWith("dip24")).length, 0);
  // the candles cannot be read: the error is our own words, and nothing changes
  const before = JSON.stringify(s.trades);
  await dipTick({ ...deps, fetch: () => (async () => new Response("secret words from somewhere", { status: 502 })) as never }, 2057 * H + 20_000);
  assert.deepEqual([dipSummary().error, JSON.stringify(_dipTest.state().trades)], ["candles http 502", before]);
  assert.equal(JSON.stringify(dipSummary()).includes(SOL), false);
});
