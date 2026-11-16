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
  const bal: Record<string, string> = { "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb": "0x" + (100_000_000).toString(16), "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174": "0x" + (31_950_000).toString(16), "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359": "0x0" };
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (u.startsWith("https://polygon")) return json({ result: bal[body.params[0].to] });
    if (u.includes("/positions?")) return json([{ size: 10, currentValue: 145.5, redeemable: false }, { size: 31.36, currentValue: 31.36, redeemable: true }]);
    if (u.includes("lb-api")) return new Response("no", { status: 404 });
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
    allTime: () => -919.63,
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
  assert.equal(by["Solana spot copy card"].src, 56, "0.3 SOL + a coin worth 0.1 SOL at $140; the coin with no route counts 0");
  assert.equal(by["Solana spot copy card"].ok, true);
  const pub = T.truthPublic()!;
  const text = JSON.stringify(pub);
  assert.ok(!/"dash"|"src"|131\.95|145\.5|Spot111|0xabab/.test(text), text);
  assert.equal(pub.coins.spot.noRoute, 1);
  assert.equal(pub.coins.spot.untracked, 1);
  T._truthTest.setDeps(null);
});
