import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJev } from "./jev.js";

test("jev stake parsing", () => {
  const a = parseJev({ model: "jev-1.14", answers: { stake: { probabilities: { skip: 0.1, half: 0.2, normal: 0.6, double: 0.1 } }, confidence: { score: 71 } } }, 400, 1);
  assert.equal(a.mult, 1);
  assert.equal(a.pick, "normal");
  assert.equal(a.confidence, 71);
  assert.equal(parseJev({ answers: { stake: { choice: "double" } } }, 1, 1).mult, 2);
  assert.equal(parseJev({ answers: {} }, 1, 1).mult, null);
});
