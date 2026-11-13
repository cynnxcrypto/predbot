import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NEG_TRIAL, _eventLiveTest, restShares, eventLiveBlock, eventLiveBuy, eventLiveConfig, negRiskBlock, parseEventLive, type EventLiveRow } from "./eventlive.js";
import { NEG_PERMS, eventClaimCalls, negRiskCalls } from "./live.js";
import { stopWhenOrderDone } from "./eventpaper.js";

const repo = JSON.stringify({ mode: "live", minBalance: 270, lossCap: { since: "2026-10-31T07:11:00Z", maxLoss: 70 }, events: { tennis: { rules: ["tennis-atp-fav90"], size: 3, maxAsk: 0.96, minDepth: 25, dayLosses: 2, maxOpen: 2, maxLoss: 9 } } }); // test fixture, not the live amount
const row = (o: Partial<EventLiveRow>): EventLiveRow => ({ t: 0, group: "tennis", rule: "tennis-atp-fav90", marketId: "m", conditionId: null, title: "", outcome: "", idx: 0, ask: 0.93, size: 3, cost: 3, shares: 3.2, fee: 0, ok: true, status: "matched", error: null, ...o });
const NOW = Date.parse("2026-11-10T09:00:00Z");

test("event live config: local off, missing funder or broken repo text all mean off; size is capped at $10 (was $5 until 13 Nov 2026)", () => {
  assert.equal(parseEventLive(repo, { mode: "live", funder: "0xabc" }).mode, "live");
  assert.equal(parseEventLive(repo, { mode: "off", funder: "0xabc" }).mode, "off");
  assert.equal(parseEventLive(repo, { mode: "live" }).mode, "off");
  assert.deepEqual(parseEventLive("{", { mode: "live", funder: "0xabc" }).groups, {});
  assert.equal(parseEventLive(JSON.stringify({ mode: "live", events: { tennis: { rules: ["x"], size: 50 } } }), { funder: "0x1" }).groups.tennis.size, 10);
  assert.deepEqual(parseEventLive(JSON.stringify({ mode: "live", events: { tennis: { rules: [], size: 3 } } }), { funder: "0x1" }).groups, {});
});

test("event live guards: rule list, mode, fillable, ask, depth, one bet per match, max open, day losses, test stop", () => {
  const cfg = parseEventLive(repo, { mode: "live", funder: "0xabc" });
  const ok = (rows: EventLiveRow[], o: { rule?: string; id?: string; ask?: number; depth?: number; fill?: boolean } = {}) => eventLiveBlock(cfg, "tennis", o.rule ?? "tennis-atp-fav90", o.id ?? "new", o.ask ?? 0.93, o.depth ?? 100, o.fill ?? true, rows, NOW);
  assert.equal(ok([]), null);
  assert.match(ok([], { rule: "tennis-fav95" })!, /not live/);
  assert.match(eventLiveBlock(parseEventLive(repo, { mode: "off", funder: "0xabc" }), "tennis", "tennis-atp-fav90", "new", 0.93, 100, true, [], NOW)!, /mode off/);
  assert.match(ok([], { fill: false })!, /fillable/);
  assert.match(ok([], { ask: 0.97 })!, /over the 96c/);
  assert.match(ok([], { depth: 10 })!, /within 2c/);
  assert.match(ok([row({ marketId: "new" })])!, /already bet/);
  assert.match(ok([row({ marketId: "a" }), row({ marketId: "b" })])!, /open \(max 2\)/);
  // an order whose reply was lost holds a slot
  assert.match(ok([row({ marketId: "a" }), row({ marketId: "b", ok: false, shares: 0, status: "unknown" })])!, /open \(max 2\)/);
  // a clean no-fill does not
  assert.equal(ok([row({ marketId: "a" }), row({ marketId: "b", shares: 0, pnl: 0, settledAt: NOW, status: "no fill" })]), null);
  const lost = (id: string, at: number) => row({ marketId: id, won: false, pnl: -3, settledAt: at });
  assert.match(ok([lost("a", NOW - 3600_000), lost("b", NOW - 60_000)])!, /2 losses today/);
  // yesterday's losses (KST) do not stop today, but three losses end the test
  assert.equal(ok([lost("a", NOW - 30 * 3600_000), lost("b", NOW - 60_000)]), null);
  assert.match(ok([lost("a", NOW - 80 * 3600_000), lost("b", NOW - 50 * 3600_000), lost("c", NOW - 30 * 3600_000)])!, /budget used up/);
  // open stakes count against the budget: $3 lost + $3 open + $3 fits $9, $6 lost + $3 open + $3 does not
  assert.equal(ok([lost("a", NOW - 80 * 3600_000), row({ marketId: "b" })]), null);
  assert.match(ok([lost("a", NOW - 80 * 3600_000), lost("b", NOW - 50 * 3600_000), row({ marketId: "c" })])!, /would pass \$9/);
});

test("deploy/live-rules.json: the tennis test stays inside enrique's limits", () => {
  const cfg = parseEventLive(readFileSync(join(process.cwd(), "deploy", "live-rules.json"), "utf8"), { mode: "live", funder: "0xabc" });
  const g = cfg.groups.tennis;
  if (!g) return;
  // 11 Nov 2026, enrique: "extend tennis budget risk to 30 so there can be 10 different bets online"
  assert.ok(g.size <= 5 && g.size * g.maxOpen <= 30);
  // 13 Nov 2026, enrique: "okay if tennis goes -10 then stop it"
  assert.ok(g.stopNet > 0 && g.stopNet <= 10 && g.maxLoss <= g.stopNet + g.size * g.maxOpen + 5);
  assert.ok(g.rules.every((r) => r.startsWith("tennis-")));
});

test("a stop waits for a real order that is being sent, starts no new one, and never waits past its limit", async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const order = (rule: string) => eventLiveBuy("tennis", { rule, marketId: "m", title: "", outcome: "", idx: 0, token: "t", ask: 0.93, depth: 100, fillable: true, feeRate: 0, conditionId: "c", negRisk: false });
  // no order in flight: the stop is immediate, as before
  let out = 0;
  stopWhenOrderDone(() => out++, 1000, 10);
  assert.equal(out, 1);
  // from here no new real order, whatever the guards say (a rule that is not live is still simply not ours)
  const rule = eventLiveConfig().groups.tennis?.rules[0];
  if (rule) assert.match((await order(rule))!, /restart pending/);
  assert.equal(await order("not-a-live-rule"), null);
  // an order is being sent: the stop waits for it
  _eventLiveTest.busy(true);
  let done = 0;
  stopWhenOrderDone(() => done++, 1000, 10);
  await sleep(50);
  assert.equal(done, 0);
  _eventLiveTest.busy(false);
  await sleep(50);
  assert.equal(done, 1);
  // an order that hangs: the stop goes at the limit
  _eventLiveTest.busy(true);
  let late = 0;
  stopWhenOrderDone(() => late++, 60, 10);
  await sleep(30);
  assert.equal(late, 0);
  await sleep(120);
  assert.equal(late, 1);
  _eventLiveTest.reset();
});

test("grouped (neg-risk) markets: off unless the group says so, wait for the wallet permissions, and 2 bets until a claim is confirmed", () => {
  const cfg = parseEventLive(JSON.stringify({ mode: "live", events: { copy: { rules: ["a"], size: 3, negRisk: true }, tennis: { rules: ["b"], size: 3 }, odd: { rules: ["c"], size: 3, negRisk: "yes" } } }), { funder: "0x1" });
  assert.deepEqual([cfg.groups.copy.negRisk, cfg.groups.tennis.negRisk, cfg.groups.odd.negRisk], [true, false, false]);
  const g = cfg.groups.copy;
  const row = (over: Partial<EventLiveRow>): EventLiveRow => ({ t: 0, group: "copy", rule: "a", marketId: "m", conditionId: "0xc1", title: "", outcome: "", idx: 0, ask: 0.5, size: 3, cost: 3, shares: 6, fee: 0, ok: true, status: "matched", error: null, negRisk: true, ...over });
  assert.match(negRiskBlock(cfg.groups.tennis, { ready: true }, [], {})!, /not switched on/);
  assert.match(negRiskBlock(g, {}, [], {})!, /permissions not ready/);
  assert.match(negRiskBlock(g, { ready: false, error: "relayer said no" }, [], {})!, /relayer said no/);
  assert.equal(negRiskBlock(g, { ready: true }, [], {}), null);
  assert.equal(negRiskBlock(g, { ready: true }, [row({})], {}), null);
  assert.equal(NEG_TRIAL, 0, "14 Nov 2026, enrique: no trial limit");
  assert.equal(negRiskBlock(g, { ready: true }, [row({}), row({ conditionId: "0xc2", status: "unknown", shares: 0 })], {}), null);
  // plain bets and lost grouped bets do not count; a won one counts until it is claimed
  const lost = row({ conditionId: "0xc3", pnl: -3, pay: 0 });
  const won = row({ conditionId: "0xc4", pnl: 3, pay: 1 });
  assert.equal(negRiskBlock(g, { ready: true }, [row({}), lost, row({ negRisk: undefined })], {}), null);
  assert.equal(negRiskBlock(g, { ready: true }, [row({}), won], {}), null);
  assert.equal(negRiskBlock(g, { ready: true }, [row({}), row({ conditionId: "0xc2" }), row({ conditionId: "0xc5" }), won], { "0xc4": { tx: "0xabc", negRisk: true } }), null, "one confirmed claim lifts the limit");
});

test("grouped markets: only the missing permissions are granted, and a claim goes to the neg-risk adapter with pUSD", () => {
  assert.equal(NEG_PERMS.length, 5);
  assert.equal(negRiskCalls([true, true, true, true, true]).length, 0);
  const calls = negRiskCalls([true, false, true, true, false]);
  assert.deepEqual(calls.map((c) => c.target.toLowerCase()), ["0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb", "0x4d97dcd97ec945f40cf65f87097ace5ea0476045"]);
  assert.ok(calls[0].data.startsWith("0x095ea7b3") && calls[0].data.toLowerCase().includes("d91e80cf2e7be2e162c6513ced06f1dd0da35296"), "approve(neg-risk adapter)");
  assert.ok(calls[1].data.startsWith("0xa22cb465") && calls[1].data.toLowerCase().includes("ada2005600dec949baf300f4c6120000bdb6eaab"), "setApprovalForAll(claim adapter)");
  const cond = `0x${"ab".repeat(32)}`;
  const neg = eventClaimCalls(cond, true);
  assert.equal(neg.length, 1);
  assert.equal(neg[0].target, "0xadA2005600Dec949baf300f4C6120000bDB6eAab");
  assert.ok(neg[0].data.toLowerCase().includes("c011a7e12a19f7b1f670d46f03b03f3342e82dfb") && neg[0].data.includes("ab".repeat(32)));
  const plain = eventClaimCalls(cond, false);
  assert.equal(plain.length, 3);
  assert.ok(plain.every((c) => c.target === "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"));
});

test("copy limits: stake between size and maxSize, and no bet that resolves more than maxDays ahead", () => {
  const NOW2 = Date.parse("2026-11-13T01:00:00Z");
  const cfg = parseEventLive(JSON.stringify({ mode: "live", events: { copy: { rules: ["a"], size: 3, maxSize: 25, maxDays: 14, perWallet: 6, maxOpen: 60, maxLoss: 1000, minDepth: 0, maxAsk: 0.97 } } }), { funder: "0x1" });
  const g = cfg.groups.copy;
  assert.deepEqual([g.size, g.maxSize, g.maxDays, g.perWallet], [3, 10, 14, 6], "maxSize is never above $10");
  const day = 86400_000;
  const blk = (resolveAt?: number, stake?: number, rows: EventLiveRow[] = []) => eventLiveBlock(cfg, "copy", "a", "m", 0.5, 10, true, rows, NOW2, stake, resolveAt);
  assert.equal(blk(NOW2 + 13 * day), null);
  assert.match(blk(NOW2 + 30 * day)!, /resolves in 30 days \(limit 14\)/);
  assert.match(blk(undefined)!, /resolve date unknown/);
  assert.match(blk(NaN)!, /resolve date unknown/);
  const open = (cost: number, i: number): EventLiveRow => ({ t: 0, group: "copy", rule: "a", marketId: `o${i}`, conditionId: null, title: "", outcome: "", idx: 0, ask: 0.5, size: cost, cost, shares: 2 * cost, fee: 0, ok: true, status: "matched", error: null });
  assert.match(blk(NOW2 + day, 10, Array.from({ length: 100 }, (_, i) => open(9.95, i)))!, /real bets open \(max 60\)/);
  const capped = parseEventLive(JSON.stringify({ mode: "live", events: { copy: { rules: ["a", "b"], size: 3, maxSize: 10, maxOpen: 999, maxLoss: 1000, openUsd: 20, walletUsd: 9, minDepth: 0, maxAsk: 0.97 } } }), { funder: "0x1" });
  const cb = (rule: string, rows: EventLiveRow[], stake = 3) => eventLiveBlock(capped, "copy", rule, "new", 0.5, 10, true, rows, NOW2, stake);
  const two = [open(3, 1), open(3, 2)];
  assert.equal(cb("a", two), null, "$6 open on wallet a + $3 = $9");
  assert.match(cb("a", two, 4)!, /would pass its \$9 stake cap/);
  assert.equal(cb("b", two, 4), null, "another wallet is not held by a's cap");
  assert.match(cb("b", [...two, open(3, 3), open(3, 4), open(3, 5)].map((r, i) => ({ ...r, rule: i < 2 ? "a" : "c" })), 6)!, /would pass the \$20 stake cap/);
  const tennis = parseEventLive(JSON.stringify({ mode: "live", events: { tennis: { rules: ["t"], size: 3 } } }), { funder: "0x1" }).groups.tennis;
  assert.deepEqual([tennis.maxSize, tennis.maxDays, tennis.perWallet], [3, 0, 0], "groups without the new keys behave as before");
});

test("deploy/live-rules.json: wallet copies stay inside enrique's 13 Nov limits", () => {
  const cfg = parseEventLive(readFileSync(join(process.cwd(), "deploy", "live-rules.json"), "utf8"), { mode: "live", funder: "0xabc" });
  const g = cfg.groups.copy;
  if (!g) return;
  assert.ok(g.size >= 3 && g.maxSize <= 10 && g.maxDays > 0 && g.maxDays <= 14);
  assert.ok(g.openUsd > 0 && g.openUsd <= 200 && g.walletUsd > 0 && g.walletUsd <= g.openUsd, "a stake cap keeps cash for tennis");
});

test("stopNet: no new bet once the settled result is that far down; open bets do not count", () => {
  const NOW3 = Date.parse("2026-11-13T08:00:00Z");
  const cfg = parseEventLive(JSON.stringify({ mode: "live", events: { tennis: { rules: ["t"], size: 3, maxOpen: 10, maxLoss: 45, stopNet: 10, dayLosses: 99, minDepth: 0 } } }), { funder: "0x1" });
  const r = (pnl: number | null, i: number): EventLiveRow => ({ t: 0, group: "tennis", rule: "t", marketId: `x${i}`, conditionId: null, title: "", outcome: "", idx: 0, ask: 0.93, size: 3, cost: 3, shares: 3.2, fee: 0, ok: true, status: "matched", error: null, pnl, won: pnl == null ? null : pnl > 0, settledAt: pnl == null ? null : 0 });
  const blk = (rows: EventLiveRow[]) => eventLiveBlock(cfg, "tennis", "t", "new", 0.93, 100, true, rows, NOW3);
  assert.equal(blk([r(-3.48, 1), ...Array.from({ length: 9 }, (_, i) => r(null, 10 + i))]), null, "-$3.48 settled and 9 open: still trading");
  assert.equal(blk([r(-3, 1), r(-3, 2), r(-3.5, 3), r(0.5, 4)]), null, "-$9.00");
  assert.match(blk([r(-3, 1), r(-3, 2), r(-3.5, 3), r(-0.5, 4)])!, /stopped for good: settled \$-10.00/);
});

test("resting bids: 5-share minimum, one bid per player, resting money counts in the caps, and the live config", () => {
  assert.equal(restShares(3, 0.4), 7.5);
  assert.equal(restShares(3, 0.9), 5, "5-share minimum");
  const NOW4 = Date.parse("2026-11-14T00:00:00Z");
  const cfg = parseEventLive(JSON.stringify({ mode: "live", events: { tennisrest: { rules: ["r"], size: 3, maxSize: 5, maxAsk: 0.97, minDepth: 0, dayLosses: 99, maxOpen: 999, openUsd: 10, stopNet: 15, maxLoss: 60 }, tennis: { rules: ["t"], size: 3, maxOpen: 10, maxLoss: 45, minDepth: 0 } } }), { funder: "0x1" });
  const rest = (idx: number, mk = "m", cost = 3): EventLiveRow => ({ t: 0, group: "tennisrest", rule: "r", marketId: mk, conditionId: null, title: "", outcome: "", idx, ask: 0.5, size: cost, cost, shares: 0, fee: 0, ok: true, status: "resting", error: null });
  const blk = (rows: EventLiveRow[], idx: number, mk = "m") => eventLiveBlock(cfg, "tennisrest", "r", mk, 0.5, Infinity, true, rows, NOW4, 3, undefined, idx);
  assert.equal(blk([rest(0)], 1), null, "the other player of the same match");
  assert.match(blk([rest(0)], 0)!, /already bet/);
  assert.match(blk([rest(0, "a"), rest(1, "a"), rest(0, "b")], 0, "c")!, /stake cap/, "$9 resting + $3 > $10");
  assert.match(eventLiveBlock(cfg, "tennis", "t", "m", 0.93, 100, true, [rest(0)], NOW4)!, /another real test/);
  const live = parseEventLive(readFileSync(join(process.cwd(), "deploy", "live-rules.json"), "utf8"), { mode: "live", funder: "0xabc" }).groups.tennisrest;
  if (live) assert.ok(live.stopNet > 0 && live.stopNet <= 15 && live.maxSize <= 5 && live.openUsd > 0 && live.openUsd <= 40);
});
