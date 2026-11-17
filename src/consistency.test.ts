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
