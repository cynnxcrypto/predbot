import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "gasout-"));
const { gasPlan, openTo, rpcHex, MAX_USD } = await import("./gasout.js");
const { seal } = await import("../solana/sendout.js");

const TO = "0x52908400098527886E0F7030069857D2E4169EE7"; // EIP-55 example address
test("gasout: the destination opens only with the right key, as a checksummed address", () => {
  const s = seal(TO.toLowerCase(), "k");
  assert.equal(openTo(s, "k"), TO);
  assert.equal(openTo(s, "other"), null);
  assert.equal(openTo(seal("not an address", "k"), "k"), null);
});
test("gasout: a small amount, never above the cap, and the wallet keeps its own gas", () => {
  const o = { id: "gas-1", to: "x", usd: 1.5 };
  assert.deepEqual(gasPlan(o, TO, 0.01, 3000), { eth: 0.0005 });
  assert.ok("why" in gasPlan({ ...o, usd: MAX_USD + 1 }, TO, 1, 3000));
  assert.ok("why" in gasPlan(o, null, 1, 3000));
  assert.ok("why" in gasPlan(o, TO, 0.0008, 3000), "would leave under $1 of ETH");
  assert.ok("why" in gasPlan({ ...o, id: "" }, TO, 1, 3000));
});
test("gasout: amounts go to the node without leading zero digits", async () => {
  const { BigNumber } = await import("@ethersproject/bignumber");
  assert.equal(rpcHex(BigNumber.from("0x01c6bf52634000")), "0x1c6bf52634000");
  assert.equal(rpcHex(BigNumber.from(0)), "0x0");
});
test("manual deposits: good rows become money into the Hyperliquid wallet, bad rows are left out", async () => {
  const { manualDeposits } = await import("./gasout.js");
  const t = JSON.stringify({ hyperliquid: { manualDeposits: [{ at: "2026-11-25T14:01:11Z", usd: 56.23 }, { at: "nope", usd: 5 }, { at: "2026-11-25T14:01:11Z", usd: -1 }] } });
  assert.deepEqual(manualDeposits(t), [{ from: "enrique", to: "hyperliquid", startedAt: Date.parse("2026-11-25T14:01:11Z"), endedAt: Date.parse("2026-11-25T14:01:11Z"), arrivedUsd: 56.23 }]);
  assert.deepEqual(manualDeposits("{}"), []);
});
test("fund: USDC that arrives from outside counts as money in; our bridge arrivals and busy times do not", async () => {
  const { usdcIn } = await import("./fund.js");
  assert.equal(usdcIn({ lastUsdc: 0.5 }, 56.73, 0, false), 56.23);
  assert.equal(usdcIn({}, 56.73, 0, false), 0, "no baseline yet");
  assert.equal(usdcIn({ lastUsdc: 0 }, 36.85, 36.85, false), 0, "a bridge move brought it");
  assert.equal(usdcIn({ lastUsdc: 0 }, 30, 0, true), 0, "a bridge move is using the wallet");
  assert.equal(usdcIn({ lastUsdc: 5 }, 5.4, 0, false), 0);
});
