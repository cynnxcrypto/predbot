import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "bridge-upto-"));
const { saveJson } = await import("../store.js");
import type { Deps, Order, PlaceInfo } from "./bridge.js";
import type { Place } from "./state.js";
const { bridgeTick, bridgePublic, checkOrder, parseDryRuns, parseOrder, sized, _test } = await import("./bridge.js");
const { loadBridge } = await import("./state.js");

const INFO: Record<string, PlaceInfo> = {
  hyperliquid: { chain: "arbitrum", address: "0x00000000000000000000000000000000000000Aa", token: "USDC" },
  "solana-perps": { chain: "solana", address: "Perps", token: "USDC" },
  "solana-spot-rules": { chain: "solana", address: "Rules", token: "SOL" },
  "solana-spot-copy": { chain: "solana", address: "Copy", token: "SOL" },
};
const SOL = 73;
/** wallets keyed "<address>:<token>"; the bridge takes 30 cents and delivers at the next look */
function world(bal: Record<string, number>, order: Order | null, dryRuns: Order[] = []) {
  const s = { t: 5_000_000, bal: { ...bal } as Record<string, number>, hl: 0, order, dryRuns, sends: [] as { from: string; amount: number }[], queue: [] as number[], quotes: 0 };
  const key = (p: PlaceInfo) => `${p.address}:${p.token}`;
  const d: Deps = {
    order: () => s.order,
    dryRuns: () => s.dryRuns,
    place: (p) => INFO[p],
    balance: async (p) => s.bal[key(p)] ?? 0,
    watch: async () => s.hl,
    solUsd: async () => SOL,
    quote: async (r) => {
      s.quotes++;
      const out = r.amount * (r.from.token === "SOL" ? SOL : 1) - 0.3;
      return { tool: "testbridge", minutes: 1, toAmount: out, toAmountMin: out, echo: { fromChain: r.from.chain, toChain: r.to.chain, fromToken: r.from.token, toToken: r.to.token, fromAddress: r.from.address, toAddress: r.to.address, fromAmount: r.amount }, tx: { kind: "solana", data: "AA==" } };
    },
    inspect: async () => [],
    send: async (r, q) => {
      s.bal[key(r.from)] -= r.amount;
      s.sends.push({ from: key(r.from), amount: r.amount });
      s.queue.push(q.toAmountMin);
      return "tx";
    },
    status: async () => "pending",
    hlFree: async () => 0,
    hlWithdraw: async () => undefined,
    now: () => s.t,
  };
  const look = async (n = 1) => {
    let r = null;
    for (let i = 0; i < n; i++) {
      s.hl += s.queue.reduce((a, b) => a + b, 0);
      s.queue = [];
      r = await bridgeTick(d);
      s.t += 20_000;
    }
    return r;
  };
  return { s, look };
}
beforeEach(() => {
  saveJson("bridge-state.json", { moves: {} });
  _test.reset();
});

test("sized: exactly the amount, or with keepUsd the smaller of the amount and what is spare", () => {
  assert.deepEqual(sized(50, undefined, 120, 1, "USDC"), { left: 50 });
  assert.match(sized(50, undefined, 40, 1, "USDC").why!, /holds 40 USDC, the move needs 50 USDC/);
  assert.deepEqual(sized(60, 40, 120, 1, "USDC"), { left: 60 }); // 80 spare, 60 asked
  assert.deepEqual(sized(60, 40, 85.559, 1, "USDC"), { left: 45.55 }); // rounded DOWN: never more than is spare
  assert.match(sized(60, 40, 50, 1, "USDC").why!, /only \$10 is spare above the \$40 that stays/);
  assert.match(sized(60, 40, 10, 1, "USDC").why!, /only \$0 is spare/);
  // SOL: 1 SOL at $73, keep $29.2 (0.4 SOL) and 0.05 SOL gas -> 0.55 SOL spare
  assert.deepEqual(sized(100, 29.2, 1, SOL, "SOL"), { left: 0.55 });
  assert.deepEqual(sized(20, 29.2, 1, SOL, "SOL"), { left: 0.2739 });
});

test("orders: token and keepUsd are read and checked", () => {
  const o = parseOrder('{"bridge":{"order":{"id":"a-1","from":"solana-spot-rules","to":"hyperliquid","usd":60,"mode":"go","token":"USDC","keepUsd":25}}}')!;
  assert.deepEqual([o.token, o.keepUsd, o.mode], ["USDC", 25, "go"]);
  assert.deepEqual(checkOrder(o), []);
  assert.match(checkOrder({ ...o, token: "DOGE" as "SOL" })[0], /token is USDC or SOL/);
  assert.match(checkOrder({ ...o, from: "polymarket", token: "USDC" })[0], /only for a move that starts at a Solana wallet/);
  assert.match(checkOrder({ ...o, keepUsd: -1 })[0], /keepUsd/);
  assert.match(checkOrder({ ...o, from: "hyperliquid", to: "polymarket", token: undefined })[0], /not for a move that starts at Hyperliquid/);
  // side-by-side dry runs can never go, whatever they say
  const list = parseDryRuns('{"bridge":{"dryRuns":[{"id":"x-1","from":"solana-perps","to":"hyperliquid","usd":60,"mode":"go","keepUsd":40},7,null]}}');
  assert.equal(list.length, 1);
  assert.equal(list[0].mode, "dry");
  assert.deepEqual(parseDryRuns("{}"), []);
});

test("side-by-side dry runs: each wallet priced, nothing sent, nothing written", async () => {
  const runs: Order[] = [
    { id: "d-perps", from: "solana-perps", to: "hyperliquid", usd: 250, mode: "dry", keepUsd: 40 },
    { id: "d-rules-sol", from: "solana-spot-rules", to: "hyperliquid", usd: 250, mode: "dry", keepUsd: 30 },
    { id: "d-rules-usdc", from: "solana-spot-rules", to: "hyperliquid", usd: 250, mode: "dry", keepUsd: 0, token: "USDC" },
    { id: "d-copy", from: "solana-spot-copy", to: "hyperliquid", usd: 250, mode: "go" as "dry", keepUsd: 60 },
  ];
  const w = world({ "Perps:USDC": 95.5, "Rules:SOL": 1.2, "Rules:USDC": 3, "Copy:SOL": 0.7 }, null, runs);
  assert.equal(await w.look(), null);
  const out = bridgePublic().dryRuns;
  assert.equal(out.length, 4);
  assert.equal(out[0].stage, "dry run: ready");
  assert.match(out[0].steps[0], /would move 55.5 USDC \(about \$55.5\), leaving \$40 and gas behind/);
  assert.match(out[1].steps[0], /would move 0.739 SOL \(about \$53.95\)/);
  assert.match(out[2].problems[0], /only \$3 is spare/);
  assert.match(out[3].problems[0], /only \$0 is spare above the \$60 that stays/);
  assert.deepEqual(w.s.sends, []);
  assert.deepEqual(loadBridge().moves, {});
  const asked = w.s.quotes;
  await w.look(5);
  assert.equal(w.s.quotes, asked); // not priced again at every look
});

test("a real up-to move takes only what is spare, in the token named", async () => {
  const o: Order = { id: "rules-usdc-1", from: "solana-spot-rules", to: "hyperliquid", usd: 60, mode: "go", token: "USDC", keepUsd: 10 };
  const w = world({ "Rules:SOL": 1.2, "Rules:USDC": 52.4 }, o);
  const r = (await w.look(8))!;
  assert.equal(r.stage, "done");
  assert.deepEqual(w.s.sends, [{ from: "Rules:USDC", amount: 8 }, { from: "Rules:USDC", amount: 34.4 }]);
  assert.equal(w.s.bal["Rules:SOL"], 1.2);
  assert.ok(Math.abs(w.s.bal["Rules:USDC"] - 10) < 1e-9);
  // the same id with another keep is another move: refused
  w.s.order = { ...o, keepUsd: 0 };
  assert.match((await w.look())!.problems[0], /already used/);
});
