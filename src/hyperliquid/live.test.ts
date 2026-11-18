import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import type { Coin, Fill } from "./exchange.js";
import type { Account, HlDeps, HlLiveConfig, PaperOpen } from "./live.js";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hllive-"));
const { _test, hlKeptTraders, hlLiveSummary, hlLiveTick, leverageFor, parseHlLive, TEST_RULE } = await import("./live.js");

const COINS: Record<string, Coin> = { BTC: { index: 0, szDecimals: 5, maxLeverage: 40 }, HYPE: { index: 5, szDecimals: 2, maxLeverage: 10 }, DOGE: { index: 9, szDecimals: 0, maxLeverage: 10 } };
const ON: HlLiveConfig = { on: true, collateralUsd: 10, maxOpen: 5, maxLossUsd: 50, traderStopUsd: 9, testOnce: "" };
const T0 = 1_800_000_000_000;

/** A pretend Hyperliquid: fills every order at the mid, keeps positions, charges nothing. */
function world(o: { cfg?: HlLiveConfig; bar?: string[]; free?: number } = {}) {
  const w = {
    mids: { BTC: 100_000, HYPE: 40, DOGE: 0.2 } as Record<string, number>,
    paper: [] as PaperOpen[],
    acct: { valueUsd: o.free ?? 100, freeUsd: o.free ?? 100, positions: {} } as Account,
    orders: [] as { coin: number; buy: boolean; sz: number; reduce: boolean }[],
    lev: [] as [number, number][],
    agentCalls: 0,
    reject: "",
    result: null as number | null,
    oid: 0,
  };
  const name = (c: Coin) => Object.keys(COINS).find((k) => COINS[k].index === c.index)!;
  const d: HlDeps = {
    cfg: () => o.cfg ?? ON,
    paperOpens: () => w.paper,
    meetsBar: (rule) => (o.bar ?? ["copy-aaaa1111"]).includes(rule),
    listed: () => true,
    venue: {
      coins: async () => COINS,
      mids: async () => w.mids,
      account: async () => structuredClone(w.acct),
      agent: async () => (w.agentCalls++, ""),
      setLeverage: async (c, l) => (w.lev.push([c.index, l]), ""),
      order: async (c, buy, _px, sz, reduce): Promise<Fill> => {
        if (w.reject) return { filled: false, sz: 0, px: 0, oid: null, error: w.reject };
        const coin = name(c);
        w.orders.push({ coin: c.index, buy, sz, reduce });
        if (reduce) delete w.acct.positions[coin];
        else w.acct.positions[coin] = { szi: buy ? sz : -sz, entryPx: w.mids[coin], unrealUsd: 0, marginUsd: 10 };
        return { filled: true, sz, px: w.mids[coin], oid: ++w.oid, error: null };
      },
      result: async () => w.result,
    },
  };
  return { w, d };
}
const copy = (rule: string, coin: string, dir: number, at: number, lev?: number): PaperOpen => ({ id: `${rule}:${coin}:${at}`, rule, coin, dir, at, lev });
beforeEach(() => _test.reset());

test("a trader at the bar is copied on any coin, at its leverage, and closed when the trader closes", async () => {
  const { w, d } = world();
  w.paper = [copy("copy-aaaa1111", "HYPE", -1, T0, 3.7)];
  await hlLiveTick(d, T0 + 30_000);
  assert.deepEqual(w.lev, [[5, 3]]);
  assert.deepEqual(w.orders, [{ coin: 5, buy: false, sz: 0.75, reduce: false }]); // $10 x 3 at $40
  assert.equal(_test.state().opens[0].collUsd, 10);
  await hlLiveTick(d, T0 + 90_000);
  assert.equal(w.orders.length, 1, "held while the paper copy is open");
  w.paper = [];
  w.mids.HYPE = 36; // the short made 10%
  await hlLiveTick(d, T0 + 150_000);
  assert.deepEqual(w.orders[1], { coin: 5, buy: true, sz: 0.75, reduce: true });
  const s = hlLiveSummary(ON, () => true, T0 + 150_000);
  assert.equal(s.trades, 1);
  assert.ok(Math.abs(s.netUsd - (3 - 0.00045 * 0.75 * 76)) < 0.011, "0.75 x $4 less both fees");
  assert.deepEqual(hlKeptTraders(), ["copy-aaaa1111"]);
  assert.equal(JSON.stringify(s).includes("0x"), false);
});

test("Hyperliquid's own fill record is used for the result when it can be read", async () => {
  const { w, d } = world();
  w.paper = [copy("copy-aaaa1111", "BTC", 1, T0, 2)];
  await hlLiveTick(d, T0 + 1000);
  w.paper = [];
  w.result = -1.23;
  await hlLiveTick(d, T0 + 61_000);
  assert.equal(hlLiveSummary(ON).netUsd, -1.23);
});

test("not copied: under the bar, too late, a second copy of a trader or a coin, no free money, loss cap", async () => {
  const { w, d } = world({ bar: ["copy-aaaa1111", "copy-bbbb2222"] });
  w.paper = [copy("copy-cccc3333", "BTC", 1, T0), copy("copy-aaaa1111", "DOGE", 1, T0 - 300_000)];
  await hlLiveTick(d, T0 + 1000);
  assert.equal(w.orders.length, 0);
  w.paper = [copy("copy-aaaa1111", "BTC", 1, T0), copy("copy-aaaa1111", "HYPE", 1, T0), copy("copy-bbbb2222", "BTC", -1, T0)];
  await hlLiveTick(d, T0 + 2000);
  assert.equal(w.orders.length, 2, "both of the first trader's positions are copied");
  assert.deepEqual(_test.state().skipped, { "coin already held": 1 });
  const poor = world({ free: 6 });
  poor.w.paper = [copy("copy-aaaa1111", "BTC", 1, T0)];
  await (_test.reset(), hlLiveTick(poor.d, T0 + 1000));
  assert.equal(poor.w.orders.length, 0);
  _test.reset();
  _test.state().netUsd = -50;
  const capped = world();
  capped.w.paper = [copy("copy-aaaa1111", "BTC", 1, T0)];
  await hlLiveTick(capped.d, T0 + 1000);
  assert.equal(capped.w.orders.length, 0);
  assert.match(hlLiveSummary(ON).halted, /loss cap/);
});

test("real results first: behind after three real trades is cut even with paper at the bar; ahead stays without it", async () => {
  const { w, d } = world();
  for (let i = 0; i < 3; i++) {
    const at = T0 + i * 600_000;
    w.paper = [copy("copy-aaaa1111", "DOGE", 1, at, 2)];
    w.mids.DOGE = 0.2;
    await hlLiveTick(d, at + 1000);
    w.paper = [];
    w.mids.DOGE = 0.196;
    await hlLiveTick(d, at + 61_000);
  }
  assert.equal(hlLiveSummary(ON).trades, 3);
  assert.match(_test.state().demotedWhy["copy-aaaa1111"], /behind after 3 trades/);
  const tr = hlLiveSummary(ON).traders[0];
  assert.deepEqual([tr.trades, tr.won, tr.sinceCut.trades, tr.real], [3, 0, 0, false], "a cut trader keeps its real count and net in the status");
  assert.ok(tr.netUsd < 0 && tr.cutAt);
  assert.equal(hlLiveSummary(ON).recent[0].collateralUsd, 10);
  // the bar now counts only paper trades made after the cut: here it says no
  const after = world({ bar: [] });
  after.w.paper = [copy("copy-aaaa1111", "DOGE", 1, T0 + 3_000_000)];
  await hlLiveTick(after.d, T0 + 3_001_000);
  assert.equal(after.w.orders.length, 0);
});

test("a position that vanished is booked only after three looks, as its collateral lost", async () => {
  const { w, d } = world();
  w.paper = [copy("copy-aaaa1111", "BTC", 1, T0, 20)];
  await hlLiveTick(d, T0 + 1000);
  w.acct.positions = {};
  await hlLiveTick(d, T0 + 61_000);
  await hlLiveTick(d, T0 + 121_000);
  assert.equal(hlLiveSummary(ON).trades, 0);
  await hlLiveTick(d, T0 + 181_000);
  const s = hlLiveSummary(ON);
  assert.equal(s.trades, 1);
  assert.equal(s.netUsd, -10);
  assert.match(_test.state().demotedWhy["copy-aaaa1111"], /loss stop/);
});

test("the test trade: one smallest BTC long, closed at the next look, once per name, with trading off", async () => {
  const cfg = parseHlLive('{"hyperliquid":{"trade":{"testOnce":"first"}}}');
  assert.deepEqual([cfg.on, cfg.testOnce], [false, "first"]);
  const { w, d } = world({ cfg });
  w.paper = [copy("copy-aaaa1111", "HYPE", 1, T0)];
  await hlLiveTick(d, T0 + 1000);
  assert.deepEqual(w.orders, [{ coin: 0, buy: true, sz: 0.00011, reduce: false }]);
  assert.deepEqual(w.lev, [[0, 1]]);
  await hlLiveTick(d, T0 + 61_000);
  assert.deepEqual(w.orders[1], { coin: 0, buy: false, sz: 0.00011, reduce: true });
  await hlLiveTick(d, T0 + 121_000);
  await hlLiveTick(d, T0 + 181_000);
  assert.equal(w.orders.length, 2, "never again under the same name, and no copies while off");
  assert.equal(_test.state().rows[0].rule, TEST_RULE);
  assert.equal(w.agentCalls, 1);
});

test("an order that is refused opens nothing; limits are clamped; leverage is whole and at most half the coin's", async () => {
  const { w, d } = world();
  w.reject = "Insufficient margin";
  w.paper = [copy("copy-aaaa1111", "BTC", 1, T0)];
  await hlLiveTick(d, T0 + 1000);
  assert.equal(_test.state().opens.length, 0);
  assert.deepEqual(_test.state().skipped, { "order not filled": 1 });
  const c = parseHlLive('{"hyperliquid":{"trade":{"on":true,"collateralUsd":500,"maxOpen":99,"maxLossUsd":900,"traderStopUsd":80}}}');
  assert.deepEqual(c, { on: true, collateralUsd: 25, maxOpen: 20, maxLossUsd: 50, traderStopUsd: 10, testOnce: "" });
  assert.equal(parseHlLive('{"hyperliquid":{"trade":{"on":true}}}').on, false, "no loss cap, no trading");
  assert.equal(parseHlLive("{}").on, false);
  assert.deepEqual([leverageFor(25, COINS.BTC), leverageFor(25, COINS.HYPE), leverageFor(0.4, COINS.BTC), leverageFor(undefined, COINS.BTC)], [20, 5, 1, 2]);
});

test("one-minute in-and-out copies for cents never cut a trader; one cut on nothing else is put back; a 1x copy is made", async () => {
  const { saveJson } = await import("../store.js");
  const { w, d } = world();
  for (let i = 0; i < 3; i++) {
    const at = T0 + i * 600_000;
    w.paper = [copy("copy-aaaa1111", "DOGE", -1, at, 2)];
    w.mids.DOGE = 0.2;
    await hlLiveTick(d, at + 1000);
    w.paper = [];
    w.mids.DOGE = 0.2001; // nothing moved: the loss is the fee
    await hlLiveTick(d, at + 61_000);
  }
  const tr = hlLiveSummary(ON, () => true).traders[0];
  assert.deepEqual([tr.trades, tr.sinceCut.trades, tr.cutAt, tr.real], [3, 0, null, true]);
  assert.ok(tr.netUsd < 0, "the cents still count as money");
  // the state as the server has it: cut on three such rows
  const rows = _test.state().rows;
  saveJson("hyperliquid-live.json", { ..._test.state(), demoted: { "copy-aaaa1111": rows[2].t }, demotedWhy: { "copy-aaaa1111": "cut: real record behind after 3 trades" } });
  _test.reload();
  assert.deepEqual(_test.state().demoted, {});
  _test.reset();
  const one = world();
  one.w.paper = [copy("copy-aaaa1111", "HYPE", 1, T0, 1)];
  await hlLiveTick(one.d, T0 + 1000);
  assert.deepEqual(one.w.orders, [{ coin: 5, buy: true, sz: 0.27, reduce: false }]); // $11 at $40, not $10
});
