import { test } from "node:test";
import assert from "node:assert/strict";
import { copySkillSummary, walletSkill } from "./copyskill.js";

const c = (rule: string, t: number, pnl: number, won = pnl > 0) => ({ rule, t, cost: 3, pnl, won, fillable: true });

test("a steady winner passes; one lucky ticket meets the live bar but fails", () => {
  const steady = Array.from({ length: 60 }, (_, i) => c("copy-take-good", i, i % 3 === 0 ? -1 : 1.2));
  const s = walletSkill(steady);
  assert.equal(s.pass, true, s.why);
  assert.equal(s.liveBar, true);
  assert.equal(s.periodsAhead, 3);
  // 50 copies, half won small, one big ticket carries it
  const lucky = Array.from({ length: 50 }, (_, i) => c("copy-take-lucky", i, i === 7 ? 20 : i % 2 ? 0.3 : -0.8));
  const l = walletSkill(lucky);
  assert.equal(l.liveBar, true);
  assert.equal(l.pass, false);
  assert.equal(walletSkill(steady.slice(0, 10)).why, "under 40 settled");
  // open and unfillable copies are not counted
  assert.equal(walletSkill([{ ...steady[0], pnl: null }, { ...steady[1], fillable: false }]).n, 0);
});

test("summary groups by wallet and leaves the copy-any twins out", () => {
  const xs = [...Array.from({ length: 60 }, (_, i) => c("copy-take-good", i, i % 3 === 0 ? -1 : 1.2)), ...Array.from({ length: 50 }, (_, i) => c("copy-take-lucky", i, i === 7 ? 20 : i % 2 ? 0.3 : -0.8)), c("copy-any-good", 1, 5)];
  const s = copySkillSummary(xs);
  assert.equal(s.wallets, 2);
  assert.deepEqual([s.pass.wallets, s.liveBar.wallets, s.liveBarButFail.wallets], [1, 2, 1]);
  assert.equal(s.top[0].name, "good");
});
