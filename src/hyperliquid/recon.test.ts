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
