import { test } from "node:test";
import assert from "node:assert/strict";
import { ledgerUsd } from "./recon.js";

const me = "0xAbC0000000000000000000000000000000000001";
test("recon: ledger rows signed from this wallet's side", () => {
  assert.deepEqual(ledgerUsd({ time: 1, delta: { type: "deposit", usdc: "42.74" } }, me), { kind: "deposit", usd: 42.74 });
  assert.deepEqual(ledgerUsd({ time: 1, delta: { type: "withdraw", usdc: "14", fee: "1" } }, me), { kind: "withdraw", usd: -15 });
  assert.deepEqual(ledgerUsd({ time: 1, delta: { type: "send", user: me.toLowerCase(), destination: "0x2", usdcValue: "40" } }, me), { kind: "send", usd: -40 });
  assert.deepEqual(ledgerUsd({ time: 1, delta: { type: "send", user: "0x2", destination: me, usdcValue: "40" } }, me), { kind: "send", usd: 40 });
  assert.deepEqual(ledgerUsd({ time: 1, delta: { type: "accountClassTransfer", usdc: "5", toPerp: true } }, me), { kind: "perpSpot", usd: 0 });
});

import { readGone } from "./venue.js";
test("gone: a liquidation is booked at what Hyperliquid's fills say, not the opening fee", () => {
  const T = 1_795_000_000_000;
  const fills = [
    { coin: "BTC", dir: "Open Long", sz: "0.00484", closedPnl: "0", fee: "0.13", oid: 1, time: T },
    { coin: "BTC", dir: "Open Short", sz: "0.004", closedPnl: "0", fee: "0.1", oid: 9, time: T + 1000 }, // other side: not ours
    { coin: "BTC", dir: "Close Long", sz: "0.00484", closedPnl: "-11.4", fee: "0.1", oid: 2, time: T + 5_000_000 },
    { coin: "BTC", dir: "Open Long", sz: "0.005", closedPnl: "0", fee: "0.13", oid: 3, time: T + 5_100_000 }, // the next copy
    { coin: "BTC", dir: "Close Long", sz: "0.005", closedPnl: "9", fee: "0.1", oid: 4, time: T + 6_000_000 },
  ];
  assert.equal(readGone(fills, "BTC", 1, T + 20_000, 1), -11.63);
  assert.equal(readGone(fills, "BTC", 1, T + 20_000, null), -11.63, "found by time when the oid is not kept");
  assert.equal(readGone(fills.slice(0, 2), "BTC", 1, T, 1), null, "not closed in the record yet");
  assert.equal(readGone(fills, "ETH", 1, T, null), null);
});

import { fileCfg } from "./live.js";
test("cut list: read from live-rules", () => {
  const c = fileCfg();
  assert.ok(!c.on || (c.cut ?? []).includes("copy-ecb63caa"));
});
