import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import type { Coin, Fill } from "./exchange.js";
import type { Account, HlDeps, HlLiveConfig, PaperOpen } from "./live.js";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hllive-"));
const { _test, hlKeptTraders, hlLiveSummary, hlLiveTick, leverageFor, parseHlLive, setHlDelayNote, TEST_RULE } = await import("./live.js");

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

test("real results first: behind after two real trades is cut even with paper at the bar (sooner on Hyperliquid, 19 Nov 2026)", async () => {
  const { w, d } = world();
  for (let i = 0; i < 2; i++) {
    const at = T0 + i * 600_000;
    w.paper = [copy("copy-aaaa1111", "DOGE", 1, at, 2)];
    w.mids.DOGE = 0.2;
    await hlLiveTick(d, at + 1000);
    w.paper = [];
    w.mids.DOGE = 0.196;
    await hlLiveTick(d, at + 61_000);
  }
  assert.equal(hlLiveSummary(ON).trades, 2);
  assert.match(_test.state().demotedWhy["copy-aaaa1111"], /behind after 2 trades/);
  const tr = hlLiveSummary(ON).traders[0];
  assert.deepEqual([tr.trades, tr.won, tr.sinceCut.trades, tr.real], [2, 0, 0, false], "a cut trader keeps its real count and net in the status");
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
  const c = parseHlLive('{"hyperliquid":{"trade":{"on":true,"collateralUsd":500,"maxOpen":999,"maxLossUsd":900,"traderStopUsd":80}}}');
  assert.deepEqual(c, { on: true, collateralUsd: 30, maxOpen: 500, maxLossUsd: 50, traderStopUsd: 10, testOnce: "", lateWithin: 0 });
  assert.equal(parseHlLive('{"hyperliquid":{"trade":{"on":true,"maxLossUsd":50,"lateWithinPct":7}}}').lateWithin, 0.01);
  assert.equal(parseHlLive('{"hyperliquid":{"trade":{"on":true}}}').on, false, "no loss cap, no trading");
  assert.equal(parseHlLive('{"hyperliquid":{"trade":{"on":false,"closeAllOnce":"c1"}}}').closeAllOnce, "c1", "close all works with trading off");
  assert.equal(parseHlLive('{"hyperliquid":{"trade":{"on":true,"maxLossUsd":50}}}').closeAllOnce, undefined);
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

test("late copies: a position a real trader still holds is copied while the price is within 1% of its entry, never one we already held", async () => {
  const LATE: HlLiveConfig = { ...ON, lateWithin: 0.01 };
  const { w, d } = world({ cfg: LATE, free: 25 });
  const old = (coin: string, px: number, rule = "copy-aaaa1111"): PaperOpen => ({ ...copy(rule, coin, 1, T0 - 3_600_000, 2), px });
  w.paper = [old("HYPE", 41), old("DOGE", 0.2), old("BTC", 100_500, "copy-bbbb2222")];
  await hlLiveTick(d, T0);
  // HYPE is 2.4% under its entry: not copied; DOGE at its entry: copied; BTC's trader is not real
  assert.deepEqual(hlLiveSummary(LATE).opens.map((x) => [x.coin, x.late]), [["DOGE", true]]);
  w.mids.HYPE = 40.8; // back within 1%: copied now
  w.acct.freeUsd = 25;
  await hlLiveTick(d, T0 + 20_000);
  assert.deepEqual(hlLiveSummary(LATE).opens.map((x) => x.coin), ["DOGE", "HYPE"]);
  // liquidated (gone from the account) while the trader still holds: booked, and never opened again
  delete w.acct.positions.DOGE;
  for (let i = 1; i <= 4; i++) await hlLiveTick(d, T0 + 20_000 + i * 20_000);
  assert.deepEqual(hlLiveSummary(LATE).opens.map((x) => x.coin), ["HYPE"]);
  assert.equal(w.orders.filter((x) => x.coin === COINS.DOGE.index && !x.reduce).length, 1);
  // without the switch nothing old is copied
  _test.reset();
  const off = world();
  off.w.paper = [old("DOGE", 0.2)];
  await hlLiveTick(off.d, T0);
  assert.equal(hlLiveSummary(ON).opens.length, 0);
});

test("partial closes: the trader takes part off, we take the same share of our opening size off; under the smallest order all goes", async () => {
  const { w, d } = world({ free: 200 });
  // a pretend venue that can close part of a position
  const order0 = d.venue.order;
  d.venue.order = async (c, buy, px, sz, reduce) => {
    if (!reduce) return order0(c, buy, px, sz, reduce);
    const coin = Object.keys(COINS).find((k) => COINS[k].index === c.index)!;
    const p = w.acct.positions[coin];
    w.orders.push({ coin: c.index, buy, sz, reduce });
    const left = Math.round((Math.abs(p.szi) - sz) * 1e8) / 1e8;
    if (left <= 0) delete w.acct.positions[coin];
    else p.szi = Math.sign(p.szi) * left;
    return { filled: true, sz, px: w.mids[coin], oid: ++w.oid, error: null };
  };
  const x = { ...copy("copy-aaaa1111", "HYPE", 1, T0, 3), left: 1 };
  w.paper = [x];
  await hlLiveTick(d, T0 + 1000);
  assert.deepEqual(w.orders[0], { coin: 5, buy: true, sz: 0.75, reduce: false }); // $30 at $40
  x.left = 0.5;
  await hlLiveTick(d, T0 + 61_000);
  assert.deepEqual(w.orders[1], { coin: 5, buy: false, sz: 0.37, reduce: true }, "half of 0.75 off, rounded down");
  assert.equal(_test.state().opens[0].parts, 1);
  await hlLiveTick(d, T0 + 121_000);
  assert.equal(w.orders.length, 2, "nothing more while the trader holds half");
  x.left = 0.1; // 0.075 HYPE = $3 left: under the smallest order, so all of it goes
  await hlLiveTick(d, T0 + 181_000);
  assert.equal(w.orders[2].reduce, true);
  assert.equal(_test.state().opens.length, 0);
  assert.equal(hlLiveSummary(ON).recent[0].why, "the trader closed most of it");
  assert.equal(hlLiveSummary(ON).trades, 1, "one copy is one trade, partial closes and all");
});

test("size by conviction: a step down under a quarter of the trader's account, up at its size, two up at 3x only when proven", async () => {
  const { convictionUsd } = await import("./live.js");
  const none = { trades: 0, won: 0, net: 0 };
  const proven = { trades: 4, won: 3, net: 2 };
  assert.equal(convictionUsd(10, undefined, none), 10);
  assert.equal(convictionUsd(10, 0.1, none), 10, "never under $10");
  assert.equal(convictionUsd(20, 0.1, none), 15);
  assert.equal(convictionUsd(10, 0.5, none), 10);
  assert.equal(convictionUsd(10, 1.2, none), 15);
  assert.equal(convictionUsd(10, 5, none), 15, "two steps up only for a trader ahead on 3+ real trades");
  assert.equal(convictionUsd(10, 5, proven), 20);
  assert.equal(convictionUsd(20, 5, proven), 30);
  assert.equal(convictionUsd(30, 5, proven), 30, "never past the hard limit");
  const { w, d } = world({ free: 200 });
  w.paper = [{ ...copy("copy-aaaa1111", "HYPE", 1, T0, 2), share: 1.5 }];
  await hlLiveTick(d, T0 + 1000);
  assert.equal(_test.state().opens[0].collUsd, 15);
  assert.equal(hlLiveSummary(ON).opens[0].conviction, 1.5);
});

test("cut sooner: a $5 real loss cuts at once; a trader already behind is cut at the next look", async () => {
  const { hlCutReason } = await import("./live.js");
  assert.match(hlCutReason({ trades: 1, won: 0, net: -5 }, 9), /loss stop/);
  assert.equal(hlCutReason({ trades: 1, won: 0, net: -4 }, 9), "");
  assert.match(hlCutReason({ trades: 2, won: 1, net: -0.1 }, 9), /behind after 2/);
  assert.equal(hlCutReason({ trades: 2, won: 1, net: 0 }, 9), "");
});

test("partial closes are measured from what the trader held when OUR copy opened: an old copy read back, a late copy", async () => {
  const { w, d } = world({ cfg: { ...ON, lateWithin: 0.01 } });
  const order0 = d.venue.order;
  d.venue.order = async (c, buy, px, sz, reduce) => {
    if (!reduce) return order0(c, buy, px, sz, reduce);
    const coin = Object.keys(COINS).find((k) => COINS[k].index === c.index)!;
    const p = w.acct.positions[coin];
    w.orders.push({ coin: c.index, buy, sz, reduce });
    p.szi = Math.sign(p.szi) * (Math.abs(p.szi) - sz);
    return { filled: true, sz, px: w.mids[coin], oid: ++w.oid, error: null };
  };
  // an old copy: opened when nothing was known about the trader's size
  const x: PaperOpen = copy("copy-aaaa1111", "HYPE", 1, T0, 3);
  w.paper = [x];
  await hlLiveTick(d, T0 + 1000);
  await hlLiveTick(d, T0 + 61_000);
  assert.equal(w.orders.length, 1);
  assert.equal(hlLiveSummary(ON).opens[0].traderHolds, null);
  // read back: the trader had taken 20% off BEFORE our copy opened and another 40% of its opening size after
  x.left = 0.4;
  x.hist = [[T0 + 500, 0.8], [T0 + 30_000, 0.4]];
  await hlLiveTick(d, T0 + 121_000);
  assert.equal(hlLiveSummary(ON).opens[0].traderHolds, 0.5, "it holds half of what it held when we opened");
  assert.deepEqual(w.orders[1], { coin: 5, buy: false, sz: 0.37, reduce: true });
  // a late copy of a position already half taken off is not cut for that half
  const y: PaperOpen = { ...copy("copy-aaaa1111", "DOGE", 1, T0 - 3_600_000, 2), px: 0.2, left: 0.5 };
  w.paper = [x, y];
  await hlLiveTick(d, T0 + 181_000);
  await hlLiveTick(d, T0 + 241_000);
  const doge = hlLiveSummary(ON).opens.find((o) => o.coin === "DOGE")!;
  assert.deepEqual([doge.late, doge.traderHolds, doge.partCloses], [true, 1, 0]);
});

/** A second pretend account beside the first (the second wallet). */
function two(o: { cfg?: HlLiveConfig; bar?: string[]; value2?: number } = {}) {
  const { w, d } = world({ cfg: o.cfg ?? { ...ON, second: { on: true, testOnce: "", maxOpen: 4 } }, bar: o.bar ?? ["copy-aaaa1111", "copy-bbbb2222", "copy-cccc3333"] });
  const w2 = { acct: { valueUsd: o.value2 ?? 50, freeUsd: o.value2 ?? 50, positions: {} } as Account, orders: [] as { coin: number; buy: boolean; sz: number; reduce: boolean }[], lev: [] as [number, number][], agentCalls: 0, down: false, oid: 1000 };
  const name = (c: Coin) => Object.keys(COINS).find((k) => COINS[k].index === c.index)!;
  d.venue2 = {
    coins: async () => COINS,
    mids: async () => w.mids,
    account: async () => (w2.down ? Promise.reject(new Error("timeout 0x" + "b".repeat(40))) : structuredClone(w2.acct)),
    agent: async () => (w2.agentCalls++, ""),
    setLeverage: async (c, l) => (w2.lev.push([c.index, l]), ""),
    order: async (c, buy, _px, sz, reduce): Promise<Fill> => {
      const coin = name(c);
      w2.orders.push({ coin: c.index, buy, sz, reduce });
      if (reduce) delete w2.acct.positions[coin];
      else w2.acct.positions[coin] = { szi: buy ? sz : -sz, entryPx: w.mids[coin], unrealUsd: 0, marginUsd: 10 };
      return { filled: true, sz, px: w.mids[coin], oid: ++w2.oid, error: null };
    },
    result: async () => null,
  };
  return { w, w2, d };
}

test("the second wallet: a second trader on a coin we hold is copied there at its own leverage, same side or opposite; a third is skipped", async () => {
  const { w, w2, d } = two();
  w.paper = [copy("copy-aaaa1111", "HYPE", 1, T0, 2)];
  await hlLiveTick(d, T0 + 1000);
  assert.deepEqual([w.orders.length, w2.orders.length], [1, 0], "a free coin goes to the first wallet");
  w.paper.push(copy("copy-bbbb2222", "HYPE", -1, T0 + 60_000, 5));
  await hlLiveTick(d, T0 + 61_000);
  assert.deepEqual(w.orders.length, 1, "the first wallet's position is not touched");
  assert.deepEqual(w.lev, [[5, 2]]);
  assert.deepEqual(w2.lev, [[5, 5]], "its own leverage");
  assert.deepEqual(w2.orders, [{ coin: 5, buy: false, sz: 1.25, reduce: false }]); // $10 x 5 at $40, short
  assert.equal(w2.agentCalls, 1);
  w.paper.push(copy("copy-cccc3333", "HYPE", 1, T0 + 120_000, 3));
  await hlLiveTick(d, T0 + 121_000);
  assert.deepEqual([w.orders.length, w2.orders.length], [1, 1]);
  assert.equal(_test.state().skipped["coin already held"], 1, "held in both: skipped, never merged");
  const s = hlLiveSummary(d.cfg(), () => true, T0 + 121_000);
  assert.deepEqual(s.opens.map((x) => [x.wallet, x.trader, x.side, x.leverage]), [[1, "copy-aaaa1111", "long", 2], [2, "copy-bbbb2222", "short", 5]]);
  assert.deepEqual([s.second?.on, s.second?.open, s.second?.keyNamed], [true, 1, true]);
  assert.equal(s.account?.valueUsd, 150, "both wallets as one");
  // the second trader closes: only the second wallet's position is closed, booked in the same book
  w.paper = w.paper.filter((x) => x.rule !== "copy-bbbb2222");
  w.mids.HYPE = 36;
  await hlLiveTick(d, T0 + 181_000);
  assert.deepEqual(w2.orders[1], { coin: 5, buy: true, sz: 1.25, reduce: true });
  assert.equal(w.orders.length, 1);
  const st = _test.state();
  assert.deepEqual([st.rows.length, st.rows[0].rule, st.rows[0].wallet, st.rows[0].netUsd > 4.8], [1, "copy-bbbb2222", 2, true]);
  assert.equal(JSON.stringify(hlLiveSummary(d.cfg(), () => true, T0 + 181_000)).includes("0x"), false);
});

test("the second wallet: off, not there, without money or not read, an overlap is skipped; a look that cannot read it leaves its positions alone", async () => {
  for (const cfg of [ON, { ...ON, second: { on: false, testOnce: "", maxOpen: 0 } }]) {
    _test.reset();
    const { w, w2, d } = two({ cfg });
    w.paper = [copy("copy-aaaa1111", "HYPE", 1, T0, 2), copy("copy-bbbb2222", "HYPE", 1, T0, 5)];
    await hlLiveTick(d, T0 + 1000);
    assert.deepEqual([w.orders.length, w2.orders.length, _test.state().skipped["coin already held"]], [1, 0, 1]);
  }
  _test.reset();
  const empty = two({ value2: 0 });
  empty.w.paper = [copy("copy-aaaa1111", "HYPE", 1, T0, 2), copy("copy-bbbb2222", "HYPE", 1, T0, 5)];
  await hlLiveTick(empty.d, T0 + 1000);
  assert.deepEqual([empty.w2.orders.length, empty.w2.agentCalls], [0, 0], "no money there yet: no key named, nothing opened");
  assert.match(hlLiveSummary(empty.d.cfg(), () => true, T0 + 1000).second?.lastError ?? "", /no money/);
  _test.reset();
  const { w, w2, d } = two();
  w.paper = [copy("copy-aaaa1111", "HYPE", 1, T0, 2), copy("copy-bbbb2222", "HYPE", 1, T0, 5)];
  await hlLiveTick(d, T0 + 1000);
  assert.equal(w2.orders.length, 1);
  w2.down = true;
  w.paper.push(copy("copy-cccc3333", "DOGE", 1, T0 + 60_000, 2), copy("copy-aaaa1111", "DOGE", 1, T0 + 60_000, 2));
  for (let i = 1; i <= 5; i++) await hlLiveTick(d, T0 + 1000 + i * 60_000);
  const st = _test.state();
  assert.equal(st.opens.filter((p) => p.w === 2).length, 1, "never counted as gone on a failed read");
  assert.equal(st.rows.length, 0);
  assert.equal(w2.orders.length, 1, "and nothing new opened there");
  const err = hlLiveSummary(d.cfg(), () => true, T0 + 400_000).second?.lastError ?? "";
  assert.ok(/not read/.test(err) && !/0x[0-9a-f]{40}/.test(err));
  w2.down = false;
  w.paper = w.paper.filter((x) => x.rule !== "copy-bbbb2222");
  await hlLiveTick(d, T0 + 500_000);
  assert.deepEqual(w2.orders[1], { coin: 5, buy: false, sz: 1.25, reduce: true }, "closed once it can be read again");
});

test("the second wallet's test trade: one smallest BTC long there, only once it has money, once per name, with copies off", async () => {
  const cfg = parseHlLive('{"hyperliquid":{"trade":{"on":true,"maxLossUsd":50,"second":{"on":false,"testOnce":"s1"}}}}');
  assert.deepEqual(cfg.second, { on: false, testOnce: "s1", maxOpen: 4 });
  assert.deepEqual(parseHlLive('{"hyperliquid":{"trade":{"on":true,"maxLossUsd":50,"second":{"on":true,"maxOpen":4}}}}').second, { on: true, testOnce: "", maxOpen: 4 });
  assert.equal(parseHlLive('{"hyperliquid":{"trade":{"on":true,"maxLossUsd":50,"second":{"on":true,"maxOpen":999}}}}').second?.maxOpen, 500);
  assert.deepEqual(parseHlLive('{"hyperliquid":{"trade":{"on":true,"maxLossUsd":50,"second":{"on":"yes","testOnce":"BAD NAME"}}}}').second, { on: false, testOnce: "", maxOpen: 4 });
  assert.equal(parseHlLive('{"hyperliquid":{"trade":{"on":true,"maxLossUsd":50}}}').second, undefined);
  const { w, w2, d } = two({ cfg, value2: 0 });
  await hlLiveTick(d, T0 + 1000);
  await hlLiveTick(d, T0 + 61_000);
  assert.equal(w2.orders.length, 0, "no money yet: the name is not used up");
  w2.acct.valueUsd = w2.acct.freeUsd = 49;
  await hlLiveTick(d, T0 + 121_000);
  assert.deepEqual(w2.orders, [{ coin: 0, buy: true, sz: 0.00011, reduce: false }]);
  assert.deepEqual(w2.lev, [[0, 1]]);
  await hlLiveTick(d, T0 + 181_000);
  assert.deepEqual(w2.orders[1], { coin: 0, buy: false, sz: 0.00011, reduce: true });
  await hlLiveTick(d, T0 + 241_000);
  await hlLiveTick(d, T0 + 301_000);
  assert.equal(w2.orders.length, 2, "never again under the same name");
  assert.equal(w.orders.length, 0, "the first wallet is not touched");
  const s = hlLiveSummary(cfg, () => true, T0 + 301_000);
  assert.match(s.second?.test?.result ?? "", /opened and closed/);
  assert.deepEqual(hlKeptTraders(), [], "a test trade is nobody's record");
});

test("close all once (20 Nov 2026): positions open then close, the trader is not judged on it, and new copies go on", async () => {
  const cfg: { c: HlLiveConfig } = { c: ON };
  const { w, d } = world();
  d.cfg = () => cfg.c;
  w.paper = [copy("copy-aaaa1111", "HYPE", -1, T0, 3)];
  await hlLiveTick(d, T0 + 30_000);
  assert.equal(_test.state().opens.length, 1);
  w.mids.HYPE = 60; // a big loss for a short
  cfg.c = { ...ON, closeAllOnce: "c1" };
  await hlLiveTick(d, T0 + 90_000);
  assert.equal(_test.state().opens.length, 0);
  assert.match(_test.state().rows.at(-1)!.why, /close all/);
  assert.equal(_test.state().demoted["copy-aaaa1111"], undefined);
  assert.equal(_test.state().ghosts?.length, 1);
  w.mids.HYPE = 70; // the market kept going against the short: holding would have lost more
  w.paper = [copy("copy-aaaa1111", "DOGE", 1, T0 + 100_000, 2)]; // the trader's HYPE short is gone: ghost ends at 70

  await hlLiveTick(d, T0 + 120_000);
  await hlLiveTick(d, T0 + 180_000);
  assert.equal(_test.state().opens.length, 1, "a new copy after the close all stays open");
  const g = hlLiveSummary().closeAllGhosts!;
  assert.equal(g.n, 1);
  assert.equal(g.stillHeldByTrader, 0);
  assert.ok(g.holdingWouldAddUsd < 0, "short from 60 to 70 would have lost");
  // a close booked before ghosts existed: rebuilt once from the fills
  const st = _test.state();
  st.ghosts = [];
  delete st.ghostsRebuilt;
  d.venue.fills = async () => [{ coin: "HYPE", px: 60, sz: 0.75, time: T0 + 90_000, dir: "Close Short" }];
  await hlLiveTick(d, T0 + 240_000);
  assert.equal(_test.state().ghosts?.length, 1);
  assert.equal(_test.state().ghosts![0].closePx, 60);
});

test("the own-history bar is a switch of its own, off unless the file says true", () => {
  assert.equal(parseHlLive('{"hyperliquid":{"trade":{"on":true,"maxLossUsd":50,"historyBar":true}}}').historyBar, true);
  for (const v of ['"yes"', "1", "false"]) assert.equal(parseHlLive(`{"hyperliquid":{"trade":{"on":true,"maxLossUsd":50,"historyBar":${v}}}}`).historyBar, undefined);
  assert.equal(parseHlLive('{"hyperliquid":{"trade":{"historyBar":true}}}').historyBar, undefined, "trading off: off");
  const top = (v: string) => parseHlLive(`{"hyperliquid":{"trade":{"on":true,"maxLossUsd":50,"historyBar":true${v}}}}`).historyTop;
  assert.deepEqual([top(""), top(',"historyTop":8'), top(',"historyTop":0'), top(',"historyTop":999'), top(',"historyTop":"x"')], [5, 8, 0, 50, 5]);
  assert.equal(parseHlLive('{"hyperliquid":{"trade":{"on":true,"maxLossUsd":50,"historyTop":8}}}').historyTop, undefined);
});

test("keep bar: real copies must average $0.50+, traders without real copies 2%+ a position on their own history", async () => {
  const { keepsTrader, parseHlLive } = await import("./live.js");
  const kb = { perCopyUsd: 0.5, histPct: 2 };
  assert.equal(keepsTrader({ trades: 19, net: 2.2 }, 9, kb).ok, false, "about 12c a copy: out, whatever its history");
  assert.equal(keepsTrader({ trades: 6, net: 3.24 }, 0.2, kb).ok, true, "54c a copy: kept");
  assert.equal(keepsTrader({ trades: 0, net: 0 }, 2.8, kb).ok, true);
  assert.equal(keepsTrader({ trades: 0, net: 0 }, 0.9, kb).ok, false);
  assert.equal(keepsTrader({ trades: 0, net: 0 }, null, kb).ok, false);
  assert.equal(keepsTrader({ trades: 3, net: -1 }, 9, undefined).ok, true, "no bar: everyone");
  const c = parseHlLive(JSON.stringify({ hyperliquid: { trade: { on: true, maxLossUsd: 50, keepBar: { perCopyUsd: 0.5, histPct: 2 } } } }));
  assert.deepEqual(c.keepBar, kb);
  assert.equal(parseHlLive(JSON.stringify({ hyperliquid: { trade: { on: true, maxLossUsd: 50 } } })).keepBar, undefined);
});

test("the trade feed's delay measure is told when a real copy opens and when it closes because the trader closed (22 Nov 2026)", async () => {
  const notes: string[] = [];
  setHlDelayNote((k, r, c) => void notes.push(`${k}|${r}|${c}`));
  const { w, d } = world();
  w.paper = [copy("copy-aaaa1111", "HYPE", 1, T0, 2)];
  await hlLiveTick(d, T0 + 5_000);
  w.paper = [];
  await hlLiveTick(d, T0 + 25_000);
  assert.deepEqual(notes, ["realOpen|copy-aaaa1111|HYPE", "realClose|copy-aaaa1111|HYPE"]);
  setHlDelayNote(() => {
    throw new Error("a measure that fails");
  });
  w.paper = [copy("copy-aaaa1111", "BTC", 1, T0 + 30_000, 2)];
  await hlLiveTick(d, T0 + 35_000);
  assert.equal(_test.state().opens.length, 1, "a failing measure never stops a trade");
  setHlDelayNote(null);
});
