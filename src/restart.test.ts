import assert from "node:assert/strict";
import { test } from "node:test";
import { DRAIN_SEC, extraSec, whenClear } from "./restart.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("planned restart: goes at once when nothing is out, waits for what is out, and never past the limit", async () => {
  const said: string[] = [];
  const log = (m: string) => void said.push(m);
  // nothing out: at once, in the same tick
  let went: string | null = null;
  whenClear(() => "", (left) => (went = left), 5000, 10, log);
  assert.equal(went, "");
  // a coin is out and is sold after a moment: waits for it, then goes once
  let out = true;
  let calls = 0;
  const t0 = Date.now();
  whenClear(() => (out ? "waiting for 1 open coin" : ""), () => calls++, 5000, 10, log);
  await sleep(60);
  assert.equal(calls, 0, "still waiting");
  out = false;
  await sleep(60);
  assert.equal(calls, 1);
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(said, ["restart pending: waiting for 1 open coin"]);
  // a coin that never sells: the restart goes anyway at the limit, told what was left
  let left: string | null = null;
  const t1 = Date.now();
  whenClear(() => "waiting for 2 open coins", (l) => (left = l), 80, 10, log);
  await sleep(40);
  assert.equal(left, null);
  await sleep(120);
  assert.equal(left, "waiting for 2 open coins");
  assert.ok(Date.now() - t1 < 1000);
  // a check that throws never holds the restart
  let ok = false;
  whenClear(() => { throw new Error("x"); }, () => (ok = true), 5000, 10, log);
  assert.equal(ok, true);
});

test("planned restart: always inside the supervisor's 330 s", () => {
  for (let wait = 10; wait <= 310; wait++) assert.ok(wait + extraSec(wait) <= 320 && extraSec(wait) >= 0);
  assert.equal(extraSec(10), 75);
  assert.equal(extraSec(310), 10);
  assert.ok(DRAIN_SEC >= 80);
});
