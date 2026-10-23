import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// liveConfig reads data/live.json through DATA, so point DATA at a scratch folder before importing it.
const dir = mkdtempSync(join(tmpdir(), "predbot-live-"));
process.env.DATA_DIR = dir;
const { liveConfig } = await import("./live.js");

test("live.json: one variant per series stays as before", () => {
  writeFileSync(join(dir, "live.json"), JSON.stringify({ mode: "live", variant: "band80-30-j70", size: 5, maxLossPerDay: 25, funder: "0xabc" }));
  const c = liveConfig();
  assert.equal(c.mode, "live");
  assert.equal(c.variant, "band80-30-j70");
  assert.deepEqual(c.variants, [{ variant: "band80-30-j70", size: 5, haltAfterLosses: 0 }]);
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
  assert.equal(liveConfig("eth15m").mode, "off");
});
