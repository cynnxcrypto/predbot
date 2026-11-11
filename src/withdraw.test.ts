import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_TRIES, RETRY_WAIT_MS, nextStep, openDest, scrub, sealDest, type WithdrawState } from "./withdraw.js";

// A made-up address (all-zero but one), not anyone's.
const ADDR = "0x0000000000000000000000000000000000000001";

test("withdraw: the sealed destination opens only with the right key and only as a valid address", () => {
  const sealed = sealDest(ADDR, "key-one");
  assert.equal(openDest(sealed, "key-one"), ADDR);
  assert.equal(openDest(sealed, "key-one\n"), ADDR);
  assert.equal(openDest(sealed, "key-two"), null);
  const raw = Buffer.from(sealed, "base64");
  raw[raw.length - 1] ^= 1;
  assert.equal(openDest(raw.toString("base64"), "key-one"), null);
  assert.equal(openDest("", "key-one"), null);
  assert.equal(openDest(ADDR, "key-one"), null);
});

test("withdraw: $1 first, $49 only after the $1 arrived and on its own go, never more than $50", () => {
  const t0 = 1_000_000_000;
  const s: WithdrawState = {};
  assert.equal(nextStep(s, undefined, 0, 300, t0).do, "nothing");
  assert.equal(nextStep(s, "all", 0, 300, t0).do, "nothing");
  assert.deepEqual(nextStep(s, "test", 10, 300, t0), { do: "send", stage: "test", amount: 1 });
  // asking for the rest still starts with the test
  assert.deepEqual(nextStep(s, "rest", 10, 300, t0), { do: "send", stage: "test", amount: 1 });
  s.test = { tries: 1, lastTryAt: t0, baseline: 10, sent: true, confirmed: false, received: null, at: null, error: null };
  // not arrived yet: wait, do not send again
  assert.equal(nextStep(s, "test", 10, 300, t0 + 60_000).do, "nothing");
  assert.equal(nextStep(s, "test", 10.5, 300, t0 + 60_000).do, "nothing");
  // a second try only after the first can no longer land, and no third
  assert.equal(nextStep(s, "test", 10, 300, t0 + RETRY_WAIT_MS + 1).do, "send");
  s.test.tries = MAX_TRIES;
  assert.equal(nextStep(s, "test", 10, 300, t0 + 10 * RETRY_WAIT_MS).do, "nothing");
  // arrived
  assert.deepEqual(nextStep(s, "test", 10.999, 300, t0 + 60_000), { do: "confirm", stage: "test", amount: 1 });
  s.test.confirmed = true;
  assert.equal(nextStep(s, "test", 10.999, 300, t0).do, "nothing");
  assert.deepEqual(nextStep(s, "rest", 10.999, 300, t0), { do: "send", stage: "rest", amount: 49 });
  assert.equal(nextStep(s, "rest", 10.999, 49.5, t0).do, "nothing");
  s.rest = { tries: 1, lastTryAt: t0, baseline: 10.999, sent: true, confirmed: false, received: null, at: null, error: null };
  assert.deepEqual(nextStep(s, "rest", 59.9, 250, t0 + 60_000), { do: "confirm", stage: "rest", amount: 49 });
  s.rest.confirmed = true;
  assert.equal(nextStep(s, "rest", 59.9, 250, t0 + 100 * RETRY_WAIT_MS).do, "nothing");
  assert.equal(nextStep(s, "test", 59.9, 250, t0 + 100 * RETRY_WAIT_MS).do, "nothing");
});

test("withdraw: nothing that looks like an address or a transaction id survives scrub", () => {
  assert.equal(scrub(`failed for ${ADDR} in 0x${"ab".repeat(32)}`), "failed for 0x… in 0x…");
});
