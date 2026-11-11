import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "preconf-"));
const { decodeFrame, makeProbe, preconfSummary, preconfSeen, CREDITS } = await import("./preconf.js");
const { base58 } = await import("./whirlpool.js");

/** one message as the provider frames it: version, slot, place in the block, status, then the transaction bytes */
function frame(slot: number, status: number, tx: Buffer, version = 1) {
  const head = Buffer.alloc(18);
  head[0] = version;
  head.writeBigUInt64LE(BigInt(slot), 1);
  head.writeBigUInt64LE(7n, 9);
  head[17] = status;
  return new Uint8Array(Buffer.concat([head, tx]));
}
const sigBytes = (n: number) => Buffer.alloc(64, n);
const legacy = (n: number) => Buffer.concat([Buffer.from([1]), sigBytes(n), Buffer.alloc(40, 9)]);

test("early stream: a message gives the slot, the status and the transaction's id, and nothing is guessed", () => {
  assert.deepEqual(decodeFrame(frame(301_234_567, 1, legacy(5))), { slot: 301_234_567, status: "success", sig: base58(sigBytes(5)) });
  assert.equal(decodeFrame(frame(1, 0, legacy(5)))!.status, "failed");
  assert.equal(decodeFrame(frame(1, 2, legacy(5)))!.status, "unknown");
  // two signatures: the first is still the id
  assert.equal(decodeFrame(frame(1, 1, Buffer.concat([Buffer.from([2]), sigBytes(3), sigBytes(4), Buffer.alloc(40)])))!.sig, base58(sigBytes(3)));
  // a layout we do not know (first byte is not a small count): read as a message, but with no id
  assert.equal(decodeFrame(frame(1, 1, Buffer.concat([Buffer.from([0x81]), Buffer.alloc(120)])))!.sig, null);
  // another version of the framing, or too short to hold a transaction: not read at all
  assert.equal(decodeFrame(frame(1, 1, legacy(5), 2)), null);
  assert.equal(decodeFrame(new Uint8Array(20)), null);
});

test("early stream: pairs each transaction with the processed stream whichever comes first, and counts what it costs", () => {
  const p = makeProbe(100_000);
  const early = (sig: string | null, slot: number, now: number, status: "failed" | "success" | "unknown" = "success") => p.onEarly({ slot, status, sig }, now);
  // the early stream is 180 ms ahead
  early("a", 10, 1000);
  p.onProcessed("a", 1180);
  // the same transaction again from the second source: counted as a message, not paired twice
  early("a", 10, 1190, "unknown");
  // the processed stream is first by 40 ms
  p.onProcessed("b", 2000);
  early("b", 11, 2040);
  // a trader's transaction the early stream never had, and an early message that never landed
  p.onProcessed("c", 3000);
  early("d", 12, 3100, "failed");
  early(null, 12, 3110);
  const s = preconfSummary(p, "listening");
  assert.deepEqual(
    { messages: s.messages, slots: s.slots, unread: s.unread, byStatus: s.byStatus, traderTx: s.traderTx, paired: s.paired, coveredPct: s.coveredPct, earlierPct: s.earlierPct, leads: p.state.leads },
    { messages: 5, slots: 3, unread: 1, byStatus: { failed: 1, success: 3, unknown: 1 }, traderTx: 3, paired: 2, coveredPct: 67, earlierPct: 50, leads: [180, -40] },
  );
  // three slots with a message: 300 credits each, however few messages they held
  assert.equal(s.creditsUsed, 900);
  // a busy slot: from the 31st message on, each one costs 10 more
  for (let i = 0; i < 32; i++) early(`x${i}`, 20, 5000 + i);
  assert.equal(p.state.credits, 900 + 300 + 20);
  assert.equal(JSON.stringify(preconfSummary(p, "listening")).includes("x1"), false, "no transaction id in the status");
});

test("early stream: stops for good when the budget is spent, and counts nothing while it is not listening", () => {
  const p = makeProbe(900);
  assert.equal(p.onEarly({ slot: 1, status: "success", sig: "a" }, 1), true);
  assert.equal(p.onEarly({ slot: 2, status: "success", sig: "b" }, 2), true);
  assert.equal(p.onEarly({ slot: 3, status: "success", sig: "c" }, 3), false);
  assert.equal(p.state.done, true);
  assert.ok(CREDITS <= 300_000);
  // not started in this test: the processed stream's call is ignored
  preconfSeen("zzz");
  assert.deepEqual([preconfSummary().traderTx, preconfSummary().state], [0, "off"]);
});
