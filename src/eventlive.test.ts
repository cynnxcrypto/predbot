import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { _eventLiveTest, eventLiveBlock, eventLiveBuy, eventLiveConfig, parseEventLive, type EventLiveRow } from "./eventlive.js";
import { stopWhenOrderDone } from "./eventpaper.js";

const repo = JSON.stringify({ mode: "live", minBalance: 270, lossCap: { since: "2026-10-31T07:11:00Z", maxLoss: 70 }, events: { tennis: { rules: ["tennis-atp-fav90"], size: 3, maxAsk: 0.96, minDepth: 25, dayLosses: 2, maxOpen: 2, maxLoss: 9 } } }); // test fixture, not the live amount
const row = (o: Partial<EventLiveRow>): EventLiveRow => ({ t: 0, group: "tennis", rule: "tennis-atp-fav90", marketId: "m", conditionId: null, title: "", outcome: "", idx: 0, ask: 0.93, size: 3, cost: 3, shares: 3.2, fee: 0, ok: true, status: "matched", error: null, ...o });
const NOW = Date.parse("2026-11-10T09:00:00Z");

test("event live config: local off, missing funder or broken repo text all mean off; size is capped at $5", () => {
  assert.equal(parseEventLive(repo, { mode: "live", funder: "0xabc" }).mode, "live");
  assert.equal(parseEventLive(repo, { mode: "off", funder: "0xabc" }).mode, "off");
  assert.equal(parseEventLive(repo, { mode: "live" }).mode, "off");
  assert.deepEqual(parseEventLive("{", { mode: "live", funder: "0xabc" }).groups, {});
  assert.equal(parseEventLive(JSON.stringify({ mode: "live", events: { tennis: { rules: ["x"], size: 50 } } }), { funder: "0x1" }).groups.tennis.size, 5);
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
  assert.ok(g.size <= 5 && g.size * g.maxOpen <= 30 && g.maxLoss <= 30);
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
