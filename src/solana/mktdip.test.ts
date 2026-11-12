import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "mktdip-"));

const { MKT_LEGS, MKT_MINTS, mktExit, mktSummary, mktTick, _mktTest } = await import("./mktdip.js");
const { USDC } = await import("./pools.js");

const H = 3_600_000;
const leg = (rule: string, coin: string) => MKT_LEGS.find((x) => x.rule === rule && x.coin === coin)!;

test("market dip: signals are the ones the research wrote down", () => {
  assert.equal(leg("both-dip", "SOL").buys({ SOL: -0.11, BTC: -0.04 }), false, "BTC must be 5% down too");
  assert.equal(leg("both-dip", "SOL").buys({ SOL: -0.11, BTC: -0.05 }), true);
  assert.equal(leg("both-dip", "ETH").buys({ SOL: -0.11, BTC: -0.05, ETH: -0.09 }), false);
  assert.equal(leg("mkt-dip-7", "ETH").buys({ BTC: -0.069 }), false);
  assert.equal(leg("mkt-dip-7-small", "WIF").buys({ BTC: -0.07 }), true);
  assert.equal(leg("dip-scaled", "BTC").buys({ BTC: -0.06 }), true);
  assert.equal(leg("dip-scaled", "ETH").buys({ BTC: -0.06, ETH: -0.07 }), false);
  assert.equal(leg("dip-scaled", "SOL").buys({}), false, "a coin without candles never buys");
  const open = { signalHour: 100, refPrice: 50 };
  assert.equal(mktExit(leg("dip-scaled", "BTC"), open, 101, 53), "target");
  assert.equal(mktExit(leg("mkt-dip-7", "SOL"), open, 101, 99), null, "time only");
  assert.equal(mktExit(leg("mkt-dip-7", "SOL"), open, 124, 10), "time");
  assert.equal(new Set(Object.values(MKT_MINTS)).size, 8);
});

test("market dip: a fall buys at a quote, an hour-late quote is kept, and it is sold 24 hours later", async () => {
  _mktTest.reset();
  // BTC closes: flat 100, then 92 from hour 1000 on (8% down against 24 hours earlier until hour 1023)
  const closeAt = (coin: string, h: number) => (coin === "BTC" && h >= 1000 ? 92 : 100);
  let now = 0;
  const net = (async (url: string) => {
    const coin = /symbol=(\w+)USDT/.exec(url)![1];
    const last = Math.floor(now / H);
    const rows = Array.from({ length: 30 }, (_, k) => last - 29 + k).map((h) => [h * H, "1", "1", "1", String(closeAt(coin, h)), "0"]);
    return { ok: true, json: async () => rows };
  }) as unknown as typeof fetch;
  const asked: string[] = [];
  const quote = async (a: string, b: string, amount: string) => {
    asked.push(`${a === USDC ? "buy" : "sell"}:${amount}`);
    return a === USDC ? 1000n : amount === "1000" ? 103_000_000n : 0n;
  };
  const deps = { fetch: () => net, quote, retryMs: 0 };
  now = 1001 * H + 20_000; // hour 1000 has closed
  await mktTick(deps, now);
  const s = _mktTest.state();
  assert.equal(Object.values(s.check!).every(Boolean), true);
  assert.deepEqual(s.open.map((o) => `${o.rule}:${o.coin}`).sort(), ["dip-scaled:BTC", "mkt-dip-7-small:BONK", "mkt-dip-7-small:JTO", "mkt-dip-7-small:JUP", "mkt-dip-7-small:PYTH", "mkt-dip-7-small:WIF", "mkt-dip-7:ETH", "mkt-dip-7:SOL"]);
  await mktTick(deps, now + 60_000);
  assert.equal(s.open.length, 8, "the same hour is not looked at twice");
  now = 1002 * H + 20_000;
  await mktTick(deps, now);
  assert.ok(s.open.every((o) => o.late === "1000"), "bought again an hour late, on paper");
  assert.equal(s.open.length, 8, "one position per coin per rule");
  now = 1025 * H + 20_000; // 24 hours after the close of hour 1000
  await mktTick(deps, now);
  assert.equal(s.open.length, 0);
  assert.equal(s.trades.length, 8);
  assert.ok(s.trades.every((tr) => tr.why === "time" && tr.netUsd === 2.98 && tr.lateNetUsd === 2.98));
  const sum = mktSummary();
  const m = sum.rules.find((x) => x.id === "mkt-dip-7")!;
  assert.deepEqual([m.trades, m.days, m.won, m.avgPct, m.lateAvgPct], [2, 1, 2, 2.98, 2.98]);
  assert.equal(JSON.stringify(sum).includes(MKT_MINTS.BTC), false);
});
