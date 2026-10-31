import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// liveConfig reads data/live.json through DATA, so point DATA at a scratch folder before importing it.
const dir = mkdtempSync(join(tmpdir(), "predbot-live-"));
process.env.DATA_DIR = dir;
const { liveConfig, ladderLevel } = await import("./live.js");

test("live.json: one variant per series stays as before", () => {
  writeFileSync(join(dir, "live.json"), JSON.stringify({ mode: "live", variant: "band80-30-j70", size: 5, maxLossPerDay: 25, funder: "0xabc" }));
  const c = liveConfig();
  assert.equal(c.mode, "live");
  assert.equal(c.variant, "band80-30-j70");
  assert.deepEqual(c.variants, [{ variant: "band80-30-j70", size: 5, haltAfterLosses: 0 }]);
  assert.equal(c.statsSince, 0);
});

test("live.json: statsSince is parsed as a timestamp", () => {
  writeFileSync(join(dir, "live.json"), JSON.stringify({ mode: "live", funder: "0xabc", statsSince: "2026-10-23T02:43:00Z" }));
  assert.equal(liveConfig().statsSince, Date.parse("2026-10-23T02:43:00Z"));
  assert.equal(liveConfig("eth5m").statsSince, Date.parse("2026-10-23T02:43:00Z"));
});

test("live.json: several variants per series, each with its own size and halt", () => {
  writeFileSync(join(dir, "live.json"), JSON.stringify({
    mode: "live", funder: "0xabc", maxLossPerDay: 40,
    variants: [{ variant: "band80-30-j70", size: 5 }, { variant: "fav93", size: 5, haltAfterLosses: 2 }, { variant: "cheap10-first90", size: 1, haltAfterLosses: 2 }],
    markets: [{ series: "btc15m", maxLossPerDay: 15, variants: [{ variant: "fav93", size: 5, haltAfterLosses: 2 }] }, { series: "sol5m", variant: "fav93-mid", size: 5, haltAfterLosses: 2, mode: "dry" }],
  }));
  const btc = liveConfig();
  assert.equal(btc.maxLossPerDay, 40);
  assert.equal(btc.variants.length, 3);
  assert.equal(btc.variant, "band80-30-j70");
  assert.deepEqual(btc.variants[2], { variant: "cheap10-first90", size: 1, haltAfterLosses: 2 });
  const btc15 = liveConfig("btc15m");
  assert.equal(btc15.mode, "live");
  assert.equal(btc15.maxLossPerDay, 15);
  assert.deepEqual(btc15.variants, [{ variant: "fav93", size: 5, haltAfterLosses: 2 }]);
  const sol = liveConfig("sol5m");
  assert.equal(sol.mode, "dry");
  assert.deepEqual(sol.variants, [{ variant: "fav93-mid", size: 5, haltAfterLosses: 2 }]);
  // A market with no entry follows the global mode (manual bets) but has no rules.
  assert.equal(liveConfig("eth15m").mode, "live");
  assert.equal(liveConfig("eth15m").variants.length, 0);
});

test("size ladder: climbs on positive 100-fill marks, drops on a negative trailing 100", () => {
  const L = [2, 4, 6];
  assert.deepEqual(ladderLevel([], L).size, 2);
  assert.equal(ladderLevel(Array(99).fill(1), L).size, 2);
  assert.equal(ladderLevel(Array(100).fill(1), L).size, 4);
  assert.equal(ladderLevel(Array(100).fill(-1), L).size, 2);
  assert.equal(ladderLevel(Array(200).fill(1), L).size, 6);
  assert.equal(ladderLevel(Array(300).fill(1), L).size, 6);
  // 200 good fills then 100 bad ones: back one step
  assert.equal(ladderLevel([...Array(200).fill(1), ...Array(100).fill(-1)], L).size, 4);
  // first mark negative stops the climb for good even if later blocks are positive
  assert.equal(ladderLevel([...Array(100).fill(-1), ...Array(100).fill(2)], L).size, 2);
});

test("live.json: ladder sets the starting size and is kept on the rule", () => {
  writeFileSync(join(dir, "live.json"), JSON.stringify({ mode: "live", funder: "0xabc", variants: [{ variant: "feed3-up40", size: 2, haltAfterLosses: 12, ladder: [2, 4, 6] }] }));
  assert.deepEqual(liveConfig().variants, [{ variant: "feed3-up40", size: 2, haltAfterLosses: 12, ladder: [2, 4, 6] }]);
});

test("live.json: \"rules\": \"repo\" takes rules from deploy/live-rules.json, keeps funder, local off still wins", () => {
  writeFileSync(join(dir, "live.json"), JSON.stringify({ rules: "repo", mode: "live", funder: "0xabc", minBalance: 400, variants: [{ variant: "local-only", size: 5 }] }));
  const c = liveConfig();
  assert.equal(c.funder, "0xabc");
  assert.equal(c.minBalance, 400);
  assert.ok(!c.variants.some((v) => v.variant === "local-only"));
  writeFileSync(join(dir, "live.json"), JSON.stringify({ rules: "repo", mode: "off", funder: "0xabc" }));
  assert.equal(liveConfig().mode, "off");
  assert.equal(liveConfig("eth5m").mode, "off");
});
