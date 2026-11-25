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
