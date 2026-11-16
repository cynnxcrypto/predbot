import assert from "node:assert/strict";
import { test } from "node:test";
import { flowsBetween, repairClaims, unclaimedAt, kstMidnight, walletDays, walletsToday, worthDays, winSpans, worthToday, worthWindows, type Comp, type Flow, type WalletPoint } from "./worthdash.js";

test("worth: a won bet waiting for its claim is counted, and its claim is not a deposit", () => {
  const H = 3_600_000;
  const rows = [
    { shares: 30, pay: 1, settledAt: 1 * H, conditionId: "a" }, // claimed at 4 h
    { shares: 10, pay: 1, settledAt: 2 * H, conditionId: "b" }, // not claimed yet
    { shares: 10, pay: 0, settledAt: 2 * H, conditionId: "c" }, // lost
    { shares: 5, pay: 1, settledAt: null, conditionId: "d" }, // open
  ];
  const spans = winSpans(rows, { a: { at: 4 * H, tx: "0x1" }, b: { at: 3 * H, tx: null } });
  assert.equal(spans.length, 2);
  assert.equal(unclaimedAt(spans, 0.5 * H), 0);
  assert.equal(unclaimedAt(spans, 3 * H), 40);
  assert.equal(unclaimedAt(spans, 5 * H), 10);
  // kept samples: flat at 100 really; the old count dipped by the waiting wins and stepped up at the claim
  const hist: [number, number][] = [[0, 100], [1.5 * H, 70], [3 * H, 60], [4 * H + 60_000, 90]];
  const flows: Flow[] = [[4 * H + 60_000, 30, "Polymarket"], [2.5 * H, 50, "Polymarket"], [4 * H + 30_000, 12, "Solana perps"]];
  const rep = repairClaims(hist, flows, spans);
  assert.deepEqual(rep.hist.map((p) => p[1]), [100, 100, 100, 100]);
  assert.deepEqual(rep.flows.map((f) => f[1]), [50, 12]); // the real deposit and the other wallet stay
  assert.deepEqual([rep.removed, rep.removedUsd], [1, 30]);
  // a claim whose waiting side fell a few samples before the cash rose is still not a deposit
  const c = (pc: number, pk: number, pkh?: number[]): Comp => ({ pc, pk, pst: 0, sol: null, coins: 0, rules: null, perps: null, pkh });
  assert.equal(flowsBetween(c(100, 50, [80, 80]), c(130, 50), null, 1).length, 0);
  assert.deepEqual(flowsBetween(c(100, 50, [50, 50]), c(130, 50), null, 1), [[1, 30, "Polymarket"]]);
});

test("worth windows: the public status gives the page's own 1 h, 24 h, 7 d and since numbers", () => {
  // the page's code (src/status.ts, total worth panel), copied as it is, as the reference
  type P = [number, number] | [number, number, 1];
  const page = (H: P[], total: number, nw: number) => {
    const WN: [string, number][] = [["1h", 36e5], ["24h", 864e5], ["7d", 6048e5]];
    const CM: { k: string; b: P; from: number }[] = [];
    const atT = (T: number) => {
      let b: P | null = null;
      for (let i = 0; i < H.length; i++) {
        if (H[i][0] <= T) b = H[i];
        else break;
      }
      return b;
    };
    if (H.length > 1) {
      WN.forEach((w) => {
        const T = nw - w[1];
        if (H[0][0] <= T + w[1] * 0.1) CM.push({ k: w[0], b: atT(T) || H[0], from: T });
      });
      if (!CM.length || CM[CM.length - 1].b !== H[0]) CM.push({ k: "since", b: H[0], from: H[0][0] });
    }
    return CM.map((c) => ({ k: c.k, usd: Math.round((total - c.b[1]) * 100) / 100, est: c.b[2] === 1, from: c.from }));
  };
  const now = 1_800_000_000_000;
  const H = 3_600_000;
  // eight days: hourly estimates first, then a sample every 2 minutes for the last 30 hours
  const long: P[] = [];
  for (let t = now - 8 * 24 * H; t < now - 30 * H; t += H) long.push([t, 700 - (now - t) / H / 10, 1]);
  for (let t = now - 30 * H, i = 0; t <= now; t += 120_000, i++) long.push([t, 640 + Math.sin(i / 7) * 5]);
  const total = 607.9;
  const w = worthWindows(long, total, now);
  assert.deepEqual(w, page(long, total, now));
  assert.deepEqual(w.map((x) => x.k), ["1h", "24h", "7d", "since"]);
  assert.equal(w.find((x) => x.k === "7d")!.est, true);
  assert.equal(w.find((x) => x.k === "24h")!.est, false);
  // two hours of samples: only 1 h, then since
  const short: P[] = [];
  for (let t = now - 2 * H; t <= now; t += 120_000) short.push([t, 600 + (t - now) / H]);
  assert.deepEqual(worthWindows(short, 600.5, now), page(short, 600.5, now));
  assert.deepEqual(worthWindows(short, 600.5, now).map((x) => x.k), ["1h", "since"]);
  // 23 hours: the 24 h window is still shown from the first point (within a tenth of the window), and no since after it
  const day: P[] = [];
  for (let t = now - 23 * H; t <= now; t += 120_000) day.push([t, 610]);
  assert.deepEqual(worthWindows(day, 607.9, now), page(day, 607.9, now));
  assert.deepEqual(worthWindows(day, 607.9, now).map((x) => [x.k, x.usd]), [["1h", -2.1], ["24h", -2.1]]);
  assert.deepEqual(worthWindows([[now, 600]], 600, now), []);
});
test("worth today: the real worth change since 00:00 KST, against the last sample at or before midnight", () => {
  const H = 3_600_000;
  // 16 Nov 2026 17:15 KST = 08:15 UTC; midnight KST = 15 Nov 15:00 UTC
  const now = Date.UTC(2026, 10, 16, 8, 15);
  const mid = Date.UTC(2026, 10, 15, 15, 0);
  assert.equal(kstMidnight(now), mid);
  assert.equal(kstMidnight(mid), mid); // midnight itself starts the new day
  assert.equal(kstMidnight(mid - 1), mid - 24 * H);
  // hourly estimates the day before, then a sample every 2 minutes from 22:00 KST
  const h: ([number, number] | [number, number, 1])[] = [];
  for (let t = mid - 30 * H; t < mid - 2 * H; t += H) h.push([t, 650, 1]);
  for (let t = mid - 2 * H, i = 0; t <= now; t += 120_000, i++) h.push([t, t <= mid ? 627.4 + (t === mid - 120_000 ? 0.1 : 0) : 610]);
  const w = worthToday(h, 607.9, now)!;
  assert.equal(w.from, mid);
  assert.equal(w.at, mid); // the sample at midnight itself
  assert.equal(w.usd, -19.5);
  assert.equal(w.est, false);
  // no sample at midnight: the last one before it
  const gap = h.filter((p) => p[0] < mid - 60 * 60_000 || p[0] > mid + 30 * 60_000);
  const g = worthToday(gap, 607.9, now)!;
  assert.equal(g.at, mid - 62 * 60_000);
  assert.equal(g.usd, -19.5);
  // only hourly estimates before midnight: shown as an estimate
  const est = h.filter((p) => p[0] < mid - 2 * H || p[0] > mid);
  assert.equal(worthToday(est, 607.9, now)!.est, true);
  assert.equal(worthToday(est, 607.9, now)!.usd, -42.1);
  // samples began after midnight: the first sample, and at says so
  const late = h.filter((p) => p[0] >= mid + 3 * H);
  assert.equal(worthToday(late, 607.9, now)!.at, mid + 3 * H);
  assert.equal(worthToday(late, 607.9, now)!.usd, -2.1);
  assert.equal(worthToday([], 607.9, now), null);
});

test("worth: each wallet's today is its worth since 00:00 KST, its own deposits left out", () => {
  const now = Date.UTC(2026, 10, 16, 8, 0, 0);
  const mid = kstMidnight(now);
  const wh: WalletPoint[] = [[mid - 3e5, 100, 50, 30, 90], [mid + 3e5, 110, 52, 30, 90], [now - 6e4, 95, 47, 31, 88]];
  const fl: Flow[] = [[mid + 6e5, 20, "Polymarket"], [mid - 6e5, 9, "Polymarket"], [mid + 6e5, 5, "Solana perps"]];
  const t = walletsToday(wh, fl, [96, 47, 31, 88], now);
  assert.deepEqual(t.poly, { usd: -24, at: mid - 3e5 });
  assert.equal(t.sc!.usd, -3);
  assert.equal(t.pp!.usd, -7);
  // no sample before midnight yet: the first of the day is used, and says so by its time
  const late = walletsToday(wh.slice(1), [], [96, 47, null, 88], now);
  assert.deepEqual(late.poly, { usd: -14, at: mid + 3e5 });
  assert.equal(late.sr, null);
});

test("worth: each KST day's real change, whole account and per wallet", () => {
  const H = 3_600_000;
  const now = Date.UTC(2026, 10, 16, 8, 0, 0);
  const mid = kstMidnight(now);
  const h: [number, number][] = [[mid - 30 * H, 500], [mid - 24 * H - 60_000, 510], [mid - 12 * H, 520], [mid - 60_000, 490], [mid + 2 * H, 480], [now - 60_000, 470]];
  const d = worthDays(h, null, now);
  assert.deepEqual(d.map((x) => [x.day, x.usd, x.part]), [["2026-11-16", -20, false], ["2026-11-15", -20, false], ["2026-11-14", 10, true]]);
  const wh: WalletPoint[] = [[mid - 12 * H, 100, 50, null, 90], [mid - 60_000, 110, 48, null, 90], [mid + H, 105, 47, 30, 90]];
  const w = walletDays(wh, [[mid + 2 * H, 20, "Polymarket"]], [130, 46, 31, 91], now);
  assert.deepEqual(w["2026-11-16"].poly, { usd: 0, part: false });
  assert.equal(w["2026-11-16"].sr, undefined); // no reading near midnight: no change for that wallet
  assert.equal(w["2026-11-15"]?.sc, undefined);
});

test("wallet seed fills readings before the first sample, never over one", async () => {
  const { withSeed, walletsToday } = await import("./worthdash.js");
  const mid = Date.UTC(2026, 10, 15, 15, 0); // 16 Nov 00:00 KST
  const wh: import("./worthdash.js").WalletPoint[] = [[mid + 18 * 36e5, 300, 95, 100, 99]];
  const now = mid + 19 * 36e5;
  assert.equal(walletsToday(wh, [], [290, 94, 100, 99], now).poly, null);
  const seeded = withSeed(wh, [[mid - 60e3, 320, 100, null, 100], [mid + 20 * 36e5, 1, 1, 1, 1], ["x"]]);
  assert.equal(seeded.length, 2);
  const t = walletsToday(seeded, [], [290, 94, 100, 99], now);
  assert.equal(t.poly?.usd, -30);
  assert.equal(t.sc?.usd, -6);
  assert.equal(t.sr, null);
});

test("a day's change is the sum of the wallets' changes once all four have one", async () => {
  const { sumOfWallets, daySum } = await import("./worthdash.js");
  const all = { usd: -18.12, at: 1 };
  assert.equal(sumOfWallets(all, { poly: { usd: -10 }, sc: { usd: -4.11 }, sr: null, pp: { usd: 0 } }), all);
  assert.equal(sumOfWallets(all, { poly: { usd: -10 }, sc: { usd: -4.11 }, sr: { usd: 0.5 }, pp: { usd: -0.02 } })?.usd, -13.63);
  assert.equal(daySum({ day: "x", usd: 5 }, undefined).usd, 5);
  assert.equal(daySum({ day: "x", usd: 5 }, { poly: { usd: 1 }, sc: { usd: 1 }, sr: { usd: 1 }, pp: { usd: 1 } }).summed, true);
});
