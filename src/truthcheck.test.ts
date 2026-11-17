import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "truth-"));
process.env.DATA_DIR = dir;
const T = await import("./truthcheck.js");

test("compare: dashboard minus source, ok within $1 or the percentage", () => {
  assert.deepEqual(T.compare("x", 100.4, 100), { k: "x", dash: 100.4, src: 100, diff: 0.4, ok: true });
  assert.equal(T.compare("x", 103, 100).ok, false);
  assert.equal(T.compare("x", 1003, 1000, 1, 0.015).ok, true, "1.5% of $1000 is $15");
  assert.equal(T.compare("x", null, 100).ok, null);
  assert.equal(T.compare("cash", 131.96, 131.95, 0.05, 0).ok, true);
  assert.equal(T.compare("cash", 132.05, 131.95, 0.05, 0).ok, false);
});

test("Polymarket positions: open at currentValue, redeemable split into won (waiting) and lost", () => {
  const s = T.splitPositions([
    { size: 10, currentValue: 4.5, redeemable: false },
    { size: "5", currentValue: "2.25", redeemable: false },
    { size: 7, currentValue: 7, redeemable: true },
    { size: 3, currentValue: 0, redeemable: true },
    { size: 0, currentValue: 9, redeemable: false },
  ]);
  assert.deepEqual(s, { open: 6.75, openN: 2, won: 7, wonN: 1, lostN: 1 });
});

test("Solana transfers: only money from or to wallets that are not ours, at least $1", () => {
  const W = "Wallet1111111111111111111111111111111111111";
  const OTHER = "Other11111111111111111111111111111111111111";
  const MINE = "Mine111111111111111111111111111111111111111";
  const ours = new Set([W, MINE]);
  const txs = [
    { signature: "a", timestamp: 1000, nativeTransfers: [{ fromUserAccount: OTHER, toUserAccount: W, amount: 0.7e9 }] }, // deposit 0.7 SOL
    { signature: "b", timestamp: 2000, nativeTransfers: [{ fromUserAccount: W, toUserAccount: MINE, amount: 0.05e9 }] }, // gas top-up to our own wallet
    { signature: "c", timestamp: 3000, tokenTransfers: [{ fromUserAccount: W, toUserAccount: OTHER, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenAmount: 50 }] }, // USDC out
    { signature: "d", timestamp: 4000, nativeTransfers: [{ fromUserAccount: OTHER, toUserAccount: W, amount: 0.001e9 }] }, // dust
  ];
  assert.deepEqual(T.externalTransfers(txs, W, ours, 140, "Solana spot copy"), [
    { t: 1_000_000, wallet: "Solana spot copy", usd: 98, sig: "a" },
    { t: 3_000_000, wallet: "Solana spot copy", usd: -50, sig: "c" },
  ]);
});

test("data API v2 positions: snake_case current_value is read", () => {
  assert.deepEqual(T.splitPositions([{ size: "4", current_value: "1.5", redeemable: false }, { size: 2, current_value: 2, redeemable: true }]), { open: 1.5, openN: 1, won: 2, wonN: 1, lostN: 0 });
});

test("transfers: only a plain wallet on the other side is money in or out; token, program and closed accounts are not", () => {
  const W = "Wallet1111111111111111111111111111111111111";
  const FRIEND = "Friend11111111111111111111111111111111111111";
  const COINACC = "CoinAcc1111111111111111111111111111111111111";
  const CUSTODY = "Custody1111111111111111111111111111111111111";
  const CLOSED = "Closed11111111111111111111111111111111111111";
  const txs = [
    { signature: "dep", timestamp: 10, nativeTransfers: [{ fromUserAccount: FRIEND, toUserAccount: W, amount: 1e9 }] }, // a real deposit
    { signature: "rent", timestamp: 20, nativeTransfers: [{ fromUserAccount: COINACC, toUserAccount: W, amount: 0.03e9 }] }, // coin accounts closed for rent
    { signature: "perp", timestamp: 30, tokenTransfers: [{ fromUserAccount: W, toUserAccount: CUSTODY, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenAmount: 10 }] }, // perps collateral
    { signature: "wsol", timestamp: 40, nativeTransfers: [{ fromUserAccount: CLOSED, toUserAccount: W, amount: 0.5e9 }] }, // wrapped SOL account closed
  ];
  assert.deepEqual(T.counterparts(txs, W).sort(), [CLOSED, COINACC, CUSTODY, FRIEND].sort());
  const kinds = new Map<string, "wallet" | "token" | "program" | "gone">([[FRIEND, "wallet"], [COINACC, "token"], [CUSTODY, "program"], [CLOSED, "gone"]]);
  assert.deepEqual(T.externalTransfers(txs, W, new Set([W]), 70, "Solana perps", kinds), [{ t: 10_000, wallet: "Solana perps", usd: 70, sig: "dep" }]);
  assert.equal(T.externalTransfers(txs, W, new Set([W]), 70, "Solana perps").length, 4, "without kinds every transfer of $1 or more counts (the first run's 30)");
});

test("window flow difference: the chart's Solana flows minus the chain's, Polymarket left out", () => {
  const chain = [{ t: 5_000, wallet: "Solana spot rules", usd: 100, sig: "a" }, { t: 50_000, wallet: "Solana perps", usd: 100, sig: "b" }];
  const flows: [number, number, string][] = [[5_100, 98, "Solana spot rules"], [60_000, 12, "Solana spot copy"], [70_000, 40, "Polymarket"]];
  assert.equal(T.windowFlowDiff(chain, flows, 0), -90, "98 + 12 taken out by the chart, 200 moved on the chain");
  assert.equal(T.windowFlowDiff(chain, flows, 40_000), -88);
});

test("flows against the chain: matched, missing from the chart, and chart flows with nothing on the chain", () => {
  const chain = [
    { t: 1_000_000, wallet: "Solana perps", usd: 100, sig: "a" },
    { t: 9_000_000, wallet: "Solana spot rules", usd: 101, sig: "b" },
  ];
  const flows: [number, number, string][] = [
    [1_000_000 + 10 * 60_000, 99.2, "Solana perps"],
    [5_000_000, -12, "Solana spot copy"],
    [6_000_000, 40, "Polymarket"],
  ];
  const m = T.matchFlows(chain, flows);
  assert.equal(m.matched.length, 1);
  assert.deepEqual(m.missing.map((x) => x.sig), ["b"]);
  assert.deepEqual(m.extra, [[5_000_000, -12, "Solana spot copy"]], "Polymarket flows are checked elsewhere");
});

test("a run with made-up sources; the public copy has differences and counts only, never a balance", async () => {
  writeFileSync(join(dir, "live.json"), JSON.stringify({ funder: "0x" + "ab".repeat(20) }));
  writeFileSync(join(dir, "solana-wallet-address.txt"), "Spot1111111111111111111111111111111111111111");
  T._truthTest.setWaits([]);
  // economic_pnl already holds the open bets at Polymarket's marks (unrealized_pnl is inside it, not added again)
  let pnlPoints: { timestamp: number; economic_pnl: number; unrealized_pnl?: number }[] = [{ timestamp: 1, economic_pnl: -800 }, { timestamp: 4990, economic_pnl: -919.4, unrealized_pnl: -19.4 }];
  let allTimeNow = -919.63;
  const bal: Record<string, string> = { "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb": "0x" + (100_000_000).toString(16), "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174": "0x" + (31_950_000).toString(16), "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359": "0x0" };
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (u.startsWith("https://polygon")) return json({ result: bal[body.params[0].to] });
    if (u.includes("/v2/positions?")) return json({ data: [{ size: 10, current_value: 145.5, redeemable: false }, { size: 31.36, current_value: 31.36, redeemable: true }], pagination: { next_cursor: null } });
    if (u.includes("/v2/user-pnl?")) return u.includes("interval=1d") || u.includes("interval=all") ? new Response("no", { status: 400 }) : json({ data: { points: pnlPoints } });
    if (u.includes("rpc")) {
      if (body.method === "getBalance") return json({ result: { value: 0.3e9 } });
      if (body.method === "getTokenAccountsByOwner") return json({ result: { value: body.params[1].programId.startsWith("Tokenkeg") ? [{ account: { data: { parsed: { info: { mint: "Coin111111111111111111111111111111111111111", tokenAmount: { amount: "5000", uiAmount: 5 } } } } } }, { account: { data: { parsed: { info: { mint: "Lost111111111111111111111111111111111111111", tokenAmount: { amount: "9", uiAmount: 9 } } } } } }] : [] } });
    }
    if (u.includes("api.helius.xyz")) return json([]);
    return new Response("?", { status: 500 });
  }) as typeof fetch;
  T._truthTest.setDeps({
    dash: () => ({ at: 1, total: 309.14 + 140 * 0.4, cash: 131.95, claim: 31.36, bets: 145.83, betsN: 1, solBal: 0.3, coinsSol: 0.1, coinsN: 1, solUsd: 140, rulesUsd: null, perpsUsd: null, perpsPos: 0 }),
    flows: () => [],
    allTime: () => allTimeNow,
    rpcUrl: () => "https://rpc.example/?api-key=x",
    helius: () => "x",
    quote: async (mint) => {
      if (mint.startsWith("Lost")) throw new Error("jupiter /swap/v1/quote http 400 COULD_NOT_FIND_ANY_ROUTE");
      return { outAmount: String(0.1e9) };
    },
    tracked: () => ({ spot: new Set(["Coin111111111111111111111111111111111111111"]), rules: new Set() }),
    fetch: fake,
  });
  const r = await T.truthRun(5_000_000);
  const by = Object.fromEntries(r!.items.map((i) => [i.k, i]));
  assert.equal(by["Polymarket cash"].src, 131.95);
  assert.equal(by["Polymarket cash"].ok, true);
  assert.equal(by["Polymarket open bets"].diff, 0.33);
  assert.equal(by["Polymarket won, waiting for claim"].ok, true);
  assert.equal(by["Polymarket all time"].diff, -0.23, "Polymarket's newest point, economic_pnl alone (interval=1d and all refused, max answered)");
  assert.equal(by["Polymarket all time"].ok, true);
  assert.equal(by["Solana spot copy card"].src, 56, "0.3 SOL + a coin worth 0.1 SOL at $140; the coin with no route counts 0");
  assert.equal(by["Solana spot copy card"].ok, true);
  const pub = T.truthPublic()!;
  const text = JSON.stringify(pub);
  assert.ok(!/"dash"|"src"|131\.95|145\.5|Spot111|0xabab/.test(text), text);
  assert.equal(pub.coins.spot.noRoute, 1);
  assert.equal(pub.coins.spot.untracked, 1);
  assert.equal(pub.polymarketPnl!.ageMin, 0);
  // Polymarket's newest point an hour old, and no figure of ours from then: the difference is shown, but it is no check
  pnlPoints = [{ timestamp: 8_600, economic_pnl: -930 }];
  allTimeNow = -925;
  const r2 = await T.truthRun(12_200_000);
  const late = r2!.items.find((i) => i.k === "Polymarket all time")!;
  assert.equal(late.diff, 5);
  assert.equal(late.ok, null);
  assert.match(late.why!, /02:23 UTC \(60 min before this check\).*not a check/);
  // a point from 5 minutes after an earlier run: compared with ours from that run
  pnlPoints = [{ timestamp: 5_300, economic_pnl: -919.4 }];
  const r3 = await T.truthRun(12_300_000);
  const then = r3!.items.find((i) => i.k === "Polymarket all time")!;
  assert.equal(then.diff, -0.23);
  assert.equal(then.ok, true);
  assert.match(then.why!, /at 01:28 UTC, with ours from then/);
  assert.equal(T.truthPublic()!.polymarketPnl!.comparedWithOursAt, 5_000_000);
  T._truthTest.setDeps(null);
});

test("day by day: served lines against a recount from the raw rows, with a running-total bug and a shifted day", () => {
  // 16 Nov 2026 12:00 KST
  const now = Date.UTC(2026, 10, 16, 3, 0, 0);
  const at = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00+09:00`);
  const raw = {
    events: [
      { t: at("2026-11-14", "10:00"), group: "copy", shares: 5, pnl: 2, settledAt: at("2026-11-15", "09:00") },
      { t: at("2026-11-15", "10:00"), group: "copy", shares: 5, pnl: -1.5, settledAt: at("2026-11-15", "20:00") },
      { t: at("2026-11-16", "01:00"), group: "copy", shares: 4, pnl: 1.25, settledAt: at("2026-11-16", "08:00") },
      { t: at("2026-11-16", "02:00"), group: "copy", shares: 0, pnl: 0, settledAt: at("2026-11-16", "03:00") }, // unfilled: not a trade
      { t: at("2026-11-16", "02:00"), group: "copy", shares: 3, pnl: null }, // still open
      { t: at("2026-11-15", "05:00"), group: "tennis", shares: 6, pnl: 3, settledAt: at("2026-11-15", "07:00") },
      { t: at("2026-11-16", "05:00"), group: "tennisrest", shares: 2, pnl: -1, settledAt: at("2026-11-16", "07:00") },
    ],
    slow: [
      { t: at("2026-11-15", "23:00"), buy: "landed", heldMin: 90, netSol: 0.002 }, // sold 00:30 on the 16th
      { t: at("2026-11-16", "09:00"), buy: "failed", heldMin: null, netSol: -0.0001 },
    ],
    rules: [
      // t is when the trade closed (23:50 on the 15th); the page adds the minutes held again and puts it on the 16th
      { t: at("2026-11-15", "23:50"), buy: "landed", heldMin: 30, netSol: -0.001 },
      { t: at("2026-11-16", "10:00"), buy: "landed", heldMin: 5, netSol: 0.003 },
    ],
    perps: [
      { t: at("2026-11-12", "10:00"), filled: true, netUsd: 1.1 },
      { t: at("2026-11-16", "11:00"), filled: true, netUsd: -0.4 },
      { t: at("2026-11-16", "11:30"), filled: false, netUsd: -0.01 },
    ],
  };
  const rec = T.recountDays(raw);
  assert.deepEqual(rec.cells["2026-11-15"].copy, { n: 2, won: 1, net: 0.5 });
  assert.deepEqual(rec.cells["2026-11-16"].copy, { n: 1, won: 1, net: 1.25 }, "the unfilled bid and the open bet are not closed trades");
  assert.equal(rec.all["2026-11-16"].copy.n, 2, "every row with a result that day, filled or not");
  assert.deepEqual(rec.cells["2026-11-16"].tennis, { n: 1, won: 0, net: -1 }, "resting bids count with tennis");
  assert.deepEqual(rec.groups["2026-11-16"].tennisrest, { n: 1, won: 0, net: -1 });
  assert.equal(rec.cells["2026-11-16"]["spot copy"].n, 1);
  const served = T.servedDayCells({
    copy: [{ day: "2026-11-16", settled: 1, won: 1, net: 1.25 }, { day: "2026-11-15", settled: 2, won: 1, net: 0.5 }],
    // the bug the owner saw: each day's count is the running total
    tennis: [{ day: "2026-11-16", settled: 2, won: 1, net: 2 }, { day: "2026-11-15", settled: 1, won: 1, net: 3 }],
    slow: [{ day: "2026-11-16", n: 1, won: 1, netSol: 0.002 }],
    ruleRows: raw.rules,
    // the status keeps only the newest rows: the perp of the 12th is gone
    perpRows: raw.perps.slice(1),
  });
  const c = T.compareDays(served, rec, now, 150);
  assert.equal(c.days.length, 8);
  assert.equal(c.days[0], "2026-11-16");
  const by = (day: string, type: string) => c.rows.find((r) => r.day === day && r.type === type)!;
  assert.equal(by("2026-11-16", "copy").ok, true);
  assert.equal(by("2026-11-15", "copy").ok, true);
  const ten = by("2026-11-16", "tennis");
  assert.deepEqual([ten.countDiff, ten.netDiff, ten.ok, ten.cumulative], [1, 3, false, true], "2 shown where 1 row closed that day");
  assert.equal(by("2026-11-16", "spot copy").ok, true);
  const r15 = by("2026-11-15", "spot rules");
  assert.deepEqual([r15.countDiff, r15.netDiff, r15.ok, r15.cumulative], [-1, 0.15, false, false], "-0.001 SOL at $150 missing from the 15th");
  const r16 = by("2026-11-16", "spot rules");
  assert.deepEqual([r16.countDiff, r16.netDiff, r16.ok], [1, -0.15, false]);
  const p12 = by("2026-11-12", "perps");
  assert.deepEqual([p12.countDiff, p12.netDiff, p12.ok], [-1, -1.1, false]);
  assert.equal(by("2026-11-16", "perps").ok, true, "the unfilled perp is not a trade on either side");
  assert.equal(c.rows.find((r) => r.day === "2026-11-08"), undefined, "older than 8 days: not compared");
  // a part the server could not read is listed, not compared
  const none = T.compareDays(T.servedDayCells({ copy: null, tennis: [], slow: [], ruleRows: [], perpRows: [] }), rec, now, 150);
  assert.deepEqual(none.notRead, ["copy"]);
  assert.equal(none.rows.some((r) => r.type === "copy"), false);
});

test("day by day in a run: the public copy lists only wrong lines, as differences", async () => {
  const now = Date.UTC(2026, 10, 16, 3, 0, 0);
  const at = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00+09:00`);
  writeFileSync(join(dir, "eventlive.json"), JSON.stringify([
    { t: at("2026-11-16", "01:00"), group: "copy", shares: 4, pnl: 1.25, settledAt: at("2026-11-16", "08:00") },
    { t: at("2026-11-15", "01:00"), group: "copy", shares: 4, pnl: -2, settledAt: at("2026-11-15", "08:00") },
  ]));
  writeFileSync(join(dir, "solana-perpslive.json"), JSON.stringify({ rows: [{ t: at("2026-11-16", "11:00"), filled: true, netUsd: -0.4 }] }));
  const raw = T.readRawTrades();
  assert.equal(raw.events.length, 2);
  assert.equal(raw.slow.length, 0, "no file: no rows");
  T._truthTest.setWaits([]);
  T._truthTest.setDeps({
    dash: () => null,
    flows: () => [],
    allTime: () => null,
    rpcUrl: () => "https://rpc.example/",
    helius: () => "",
    quote: async () => ({}),
    tracked: () => ({ spot: new Set(), rules: new Set() }),
    fetch: (async () => new Response("?", { status: 500 })) as typeof fetch,
    dayServed: () => ({
      // the 16th shows both days' bets: a running total
      copy: [{ day: "2026-11-16", settled: 2, won: 1, net: -0.75 }, { day: "2026-11-15", settled: 1, won: 0, net: -2 }],
      tennis: [],
      slow: [],
      ruleRows: [],
      perpRows: [{ t: at("2026-11-16", "11:00"), filled: true, netUsd: -0.4 }],
    }),
  });
  await T.truthRun(now);
  const pub = T.truthPublic()!;
  assert.deepEqual(pub.days, { checked: 3, notRead: [], wrong: [{ day: "2026-11-16", type: "copy", countDiff: 1, netDiff: -2, cumulative: true }] });
  const priv = T.truthPrivate()!.extra.days as { rows: { served: { net: number } }[] };
  assert.equal(priv.rows.length, 3, "the private copy keeps every line with both sides' figures");
  assert.ok(!/"served"|"recount"|1\.25/.test(JSON.stringify(pub.days)));
  T._truthTest.setDeps(null);
});

test("flows enrique did not confirm are flagged", async () => {
  const { unconfirmedFlows } = await import("./truthcheck.js");
  const t15 = Date.UTC(2026, 10, 15, 3);
  const t17 = Date.UTC(2026, 10, 17, 6);
  const out = unconfirmedFlows([[t15, 101, "spot rules"], [t17, 11.06, "perps"], [t17, -11.98, "perps"], [t17, 50, "Polymarket"]]);
  assert.deepEqual(out.map((f) => f[1]), [11.06, -11.98]);
});
