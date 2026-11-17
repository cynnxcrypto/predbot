// The dashboard's totals must agree with each other and with their rows (enrique, 17 Nov 2026: "it's always
// mismatched"). Every figure the page shows in more than one place comes from these server functions; a change that
// makes two of them disagree fails here, and so fails the deploy.
import assert from "node:assert/strict";
import { test } from "node:test";
import { daySum, kstMidnight, sumOfWallets, walletDays, walletsToday, worthDays, worthToday, type WalletPoint } from "./worthdash.js";
import { slowDays } from "./solslowdash.js";
import { closeDays } from "./solana/bucketslive.js";

const mid = Date.UTC(2026, 10, 16, 15, 0); // 17 Nov 00:00 KST
const now = mid + 4 * 3_600_000;
const wh: WalletPoint[] = [
  [mid - 60_000, 320, 95, 101, 100],
  [mid + 3_600_000, 322, 94.5, 101.2, 102],
  [now - 60_000, 325.19, 94.44, 103.76, 104.14],
];
const nowW = [325.19, 94.44, 103.76, 104.14];

test("overview today = the four wallet cards, to the cent", () => {
  const w = walletsToday(wh, [], nowW, now);
  const sum = Math.round(["poly", "sc", "sr", "pp"].reduce((a, k) => a + (w[k] as { usd: number }).usd, 0) * 100) / 100;
  const total = wh.map((p) => [p[0], (p[1] as number) + (p[2] as number) + (p[3] as number) + (p[4] as number)] as [number, number]);
  const all = worthToday(total, nowW.reduce((a, b) => a + b, 0), now);
  assert.ok(all);
  const shown = sumOfWallets(all, w);
  assert.equal(shown?.usd, sum);
  assert.ok(Math.abs((all as { usd: number }).usd - sum) < 0.011, "the total's own change and the wallets' sum agree");
});

test("a day's headline = its wallet lines once all four have one", () => {
  const wd = walletDays(wh, [], nowW, now);
  const day = new Date(mid + 9 * 3_600_000).toISOString().slice(0, 10);
  const total = wh.map((p) => [p[0], (p[1] as number) + (p[2] as number) + (p[3] as number) + (p[4] as number)] as [number, number]);
  const d = worthDays(total, null, now).find((x) => x.day === day);
  assert.ok(d && wd[day]);
  const lines = Math.round(Object.values(wd[day]).reduce((a, x) => a + x.usd, 0) * 100) / 100;
  assert.equal(daySum(d, wd[day]).usd, lines);
  assert.equal(kstMidnight(now), mid);
});

test("day lines of closed trades add up to every closed trade (spot copy, spot rules, perps)", () => {
  const rows = [
    { t: mid + 1000, name: "a", mint: "m", buy: "landed", exit: "sold", heldMin: 30, netSol: 0.01 },
    { t: mid + 2000, name: "a", mint: "m", buy: "failed", exit: "", heldMin: null, netSol: -0.0002 },
    { t: mid - 86_400_000, name: "b", mint: "m", buy: "landed", exit: "sold", heldMin: 5, netSol: -0.02 },
  ];
  const d = slowDays(rows);
  assert.equal(Math.round(d.reduce((a, x) => a + x.netSol, 0) * 1e6), Math.round(rows.reduce((a, r) => a + r.netSol, 0) * 1e6));
  assert.equal(d.reduce((a, x) => a + x.n, 0), 2, "a buy that never landed is a fee, not a trade");
  const r2 = [{ t: mid + 5, netUsd: 1.2, filled: true }, { t: mid - 5, netUsd: -0.4, filled: true }, { t: mid + 9, netUsd: -0.01, filled: false }];
  const c = closeDays(r2, (x) => x.netUsd, (x) => x.filled);
  assert.equal(Math.round(c.reduce((a, x) => a + x.net, 0) * 100), Math.round(r2.reduce((a, x) => a + x.netUsd, 0) * 100));
  assert.equal(c.reduce((a, x) => a + x.n, 0), 2);
});

test("coins with no quote never block today: last quote, else cost once held 30 min", async () => {
  const { priceCoins } = await import("./worthdash.js");
  const mem = new Map<string, number>();
  const t0 = mid;
  priceCoins([{ name: "a", t: t0, worthSol: 0.03, stakeSol: 0.02 }], mem, t0 + 60_000);
  const out = priceCoins(
    [
      { name: "a", t: t0, worthSol: null, stakeSol: 0.02 },
      { name: "dead", t: t0 - 3_600_000, worthSol: null, stakeSol: 0.02 },
      { name: "new", t: t0 + 3_000_000, worthSol: null, stakeSol: 0.02 },
    ],
    mem,
    t0 + 3_600_000,
  );
  assert.deepEqual(out.map((c) => c.worthSol), [0.03, 0.02, null]);
});

test("a perps position opening or closing is not a deposit or a withdrawal", async () => {
  const { flowsBetween } = await import("./worthdash.js");
  const base = { pc: null, pk: 0, pst: 0, sol: null, coins: 0, rules: null };
  // open: cash leaves the wallet for the position, read a moment apart
  assert.deepEqual(flowsBetween({ ...base, perps: 100, perpsPos: 0 }, { ...base, perps: 111.06, perpsPos: 11 }, 1, mid), []);
  assert.deepEqual(flowsBetween({ ...base, perps: 111.06, perpsPos: 11 }, { ...base, perps: 99.08, perpsPos: 0 }, 1, mid), []);
  // a real top-up with no position change is still one
  assert.equal(flowsBetween({ ...base, perps: 100, perpsPos: 0 }, { ...base, perps: 150, perpsPos: 0 }, 1, mid).length, 1);
});

test("Hyperliquid: ETH sent is a deposit, a swap or a trade is not; the overview sums five wallets once it has a today", async () => {
  const { flowsBetween } = await import("./worthdash.js");
  const base = { pc: null, pk: 0, pst: 0, sol: null, coins: 0, rules: null, perps: null };
  // first seen with money: counts whole
  assert.deepEqual(flowsBetween({ ...base }, { ...base, hl: 150, hlIn: 150 }, 1, mid), [[mid, 150, "Hyperliquid"]]);
  // ETH swapped to USDC and moved into Hyperliquid, a position opened: same money, no flow
  assert.deepEqual(flowsBetween({ ...base, hl: 150, hlIn: 150 }, { ...base, hl: 149.2, hlIn: 150 }, 1, mid), []);
  // a trade making $30 is a result, not a deposit
  assert.deepEqual(flowsBetween({ ...base, hl: 149.2, hlIn: 150 }, { ...base, hl: 179.2, hlIn: 150 }, 1, mid), []);
  // more ETH arrives: a deposit of what arrived
  assert.deepEqual(flowsBetween({ ...base, hl: 179.2, hlIn: 150 }, { ...base, hl: 279.2, hlIn: 250 }, 1, mid), [[mid, 100, "Hyperliquid"]]);
  // overview: without a Hyperliquid today it is the four; with one, the five
  const w4 = { poly: { usd: 1 }, sc: { usd: 2 }, sr: { usd: 3 }, pp: { usd: 4 }, hl: null };
  assert.equal(sumOfWallets({ usd: 99 }, w4)?.usd, 10);
  assert.equal(sumOfWallets({ usd: 99 }, { ...w4, hl: { usd: -2.5 } })?.usd, 7.5);
  assert.equal(sumOfWallets({ usd: 99 }, { ...w4, pp: null })?.usd, 99, "a core wallet missing: the total's own change");
  // an old reading without a Hyperliquid column still works for the other four
  const t = walletsToday(wh, [], [...nowW, 50], now);
  assert.equal(t.hl, null);
  assert.ok(t.poly);
});

test("strategy wallets: the chain decides what was money in or out (15 Nov 2026 read +$100 when real deposits were dropped)", async () => {
  const { mergeChainFlows } = await import("./worthdash.js");
  const t0 = mid - 2 * 86_400_000;
  const chart: [number, number, string][] = [
    [t0, 60, "Solana perps"], // a real deposit, matched on the chain: kept at the chart's figure
    [t0 + 3_600_000, 11.06, "Solana perps"], // a position opening read as a deposit: not on the chain, taken out
    [t0 + 7_200_000, 92, "Polymarket"], // other wallets untouched
  ];
  const fix = { at: mid, from: mid - 8 * 86_400_000, missing: [{ t: t0 + 600_000, usd: 40.5, wallet: "Solana perps" }], notOnChain: [{ t: t0 + 3_600_000, usd: 11.06, wallet: "Solana perps" }] };
  assert.deepEqual(mergeChainFlows(chart, fix), [[t0, 60, "Solana perps"], [t0 + 600_000, 40.5, "Solana perps"], [t0 + 7_200_000, 92, "Polymarket"]]);
  // with no chain read, the chart's own
  assert.deepEqual(mergeChainFlows(chart, null), chart);
  // a flow after the last chain read is the chart's own detection
  const late: [number, number, string] = [mid + 60_000, 20, "Solana spot rules"];
  assert.ok(mergeChainFlows([late], fix).some((f) => f === late));
});

test("a new wallet's first money is a deposit from the first reading, never a gain in any window", async () => {
  const { flowsBetween, netOfFlows } = await import("./worthdash.js");
  const t = now - 3_600_000;
  const before = { pc: 300, pk: 120, pst: 110, sol: 1, coins: 0.5, rules: 100, perps: 100 };
  // the Hyperliquid wallet is read for the first time with $46.70 in it, before the next chart sample
  const fresh = flowsBetween({ ...before, pc: null, sol: null }, { ...before, pc: null, sol: null, hl: 46.7, hlIn: 46.7 }, 1, now);
  assert.deepEqual(fresh, [[now, 46.7, "Hyperliquid"]]);
  const hist: [number, number][] = [[t, 600], [now - 60_000, 600]];
  const total = 646.7;
  // the 1 h window: total now against the series an hour ago, net of money put in since
  const series = netOfFlows(hist, fresh);
  const h1 = series.find((p) => p[0] === t)!;
  assert.equal(Math.round((total - h1[1]) * 100) / 100, 0);
  const all = worthToday(netOfFlows([[mid - 60_000, 600], ...hist], fresh), total, now);
  assert.equal(all?.usd, 0);
});
