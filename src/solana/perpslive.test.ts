import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// a scratch folder: the wallet these tests sign with is made there, never in the real data folder
const dir = mkdtempSync(join(tmpdir(), "perpslive-"));
process.env.DATA_DIR = dir;

const P = await import("./perpslive.js");
const { _bucketsTest, COPY_SHORTS, REAL_MIN_TRADES } = await import("./buckets.js");
const { base58decode, namedWallet, wallet } = await import("./keys.js");
type Cfg = import("./perpslive.js").PerpsLiveConfig;

const RULE = "SOL-short-down-week";
const CFG: Cfg = { on: true, collateralUsd: 11, leverage: 2, maxLossUsd: 20, ruleStopUsd: 3 };
const T0 = Date.now() - 3_600_000;
const HASH = "11111111111111111111111111111111";

const paperTrades = (n: number, won: number, at = T0 - 1000) =>
  Array.from({ length: n }, (_, i) => ({ rule: RULE, coin: "SOL", dir: -1, at: at + i, exitAt: at + i + 1, entry: 100, exit: 99, net: i < won ? 0.01 : -0.005 }));
const paperOpen = (at: number, dir = -1) => ({ rule: RULE, coin: "SOL", dir, at, entry: 100 });
const posData = (sizeUsd: number) => {
  const b = Buffer.alloc(200);
  b.writeBigUInt64LE(104_000_000n, 153); // entry price $104
  b.writeBigUInt64LE(BigInt(Math.round(sizeUsd * 1e6)), 161);
  b.writeBigUInt64LE(10_900_000n, 169); // collateral after the opening fee
  return b.toString("base64");
};

/** A made-up chain: a sent request sits until `keeper()` fills it (or turns it down). */
function world(usdc = 30) {
  const w = namedWallet("perps");
  const c = { usdc, sol: 0.05, size: 0, request: false, sims: 0, sends: 0, scans: 0, sim: { err: null as unknown, logs: [] as string[] }, cfg: CFG, lastTx: "" };
  const deps: import("./perpslive.js").PerpDeps = {
    cfg: () => c.cfg,
    wallet: () => w,
    rpc: (async (method: string, params: unknown[]) => {
      if (method === "getLatestBlockhash") return { value: { blockhash: HASH } };
      if (method === "simulateTransaction") {
        c.sims++;
        return { value: c.sim };
      }
      if (method === "getAccountInfo") {
        const sliced = !!(params[1] as { dataSlice?: unknown }).dataSlice;
        if (sliced) return { value: c.request ? { data: ["", "base64"] } : null };
        return { value: c.size > 0 ? { data: [posData(c.size), "base64"] } : null };
      }
      if (method === "getProgramAccounts") {
        c.scans++;
        const row = (sizeUsd: number, fill: number) => {
          const b = Buffer.alloc(161, 0);
          b.fill(fill, 0, 32);
          b.writeBigUInt64LE(BigInt(sizeUsd * 1e6), 153);
          return { account: { data: [b.toString("base64"), "base64"] } };
        };
        return [row(0, 1), row(500, 2), row(900, 3)];
      }
      throw new Error("unexpected " + method);
    }) as never,
    send: async (tx) => {
      c.sends++;
      c.lastTx = tx;
      c.request = true;
    },
    landed: async () => ({ slot: 1, err: null }),
    sigOf: () => "sig",
    usdc: async () => c.usdc,
    sol: async () => c.sol,
    price: async () => 100,
    fixed: () => "other",
  };
  const keeper = {
    fillOpen: () => ((c.request = false), (c.size = 22), (c.usdc -= 11)),
    fillClose: (back: number) => ((c.request = false), (c.size = 0), (c.usdc += back)),
    refuse: () => (c.request = false),
  };
  return { c, deps, keeper, w };
}
function setup(trades = paperTrades(REAL_MIN_TRADES, 60)) {
  _bucketsTest.reset();
  P._test.reset();
  P._test.state().dry = { at: Date.now(), result: "ok" }; // the daily dry run is tested on its own
  P._test.state().dryClose = { at: Date.now(), result: "ok", tried: 1 };
  _bucketsTest.state().perpTrades = trades as never;
}

test("off unless switched on, and the hard limits hold", () => {
  assert.equal(P.parsePerpsLive("{}").on, false);
  assert.equal(P.parsePerpsLive("not json").on, false);
  assert.equal(P.parsePerpsLive('{"solanaPerps":{"on":true}}').on, false); // no loss cap = off
  const c = P.parsePerpsLive('{"solanaPerps":{"on":true,"maxLossUsd":999,"leverage":50,"collateralUsd":5000,"ruleStopUsd":500}}');
  assert.deepEqual(c, { on: true, maxLossUsd: 30, collateralUsd: 25, leverage: 2, ruleStopUsd: 10 });
});

test("the orders have the shape of Jupiter's program interface", () => {
  const w = namedWallet("perps");
  const o = P.openShortIx(w.address, "SOL", 22, 11, 99, 7n);
  assert.equal(o.ix.keys.length, 16);
  assert.equal(o.ix.data.length, 8 + 8 + 8 + 1 + 8 + 1 + 8);
  assert.equal(Buffer.from(o.ix.data).readBigUInt64LE(8), 22_000_000n);
  assert.equal(Buffer.from(o.ix.data).readBigUInt64LE(16), 11_000_000n);
  assert.equal(o.ix.data[24], 2); // short
  assert.equal(o.ix.keys.filter((k) => k.signer).length, 1);
  assert.equal(o.ix.keys[0].pubkey, w.address);
  const cl = P.closeShortIx(w.address, "SOL", 102, 8n);
  assert.equal(cl.ix.keys.length, 16);
  assert.equal(cl.ix.data.length, 8 + 8 + 8 + 8 + 1 + 2 + 8);
  assert.equal(cl.position, o.position);
  assert.notEqual(cl.request, o.request);
  assert.equal(P.cancelRequestIx(w.address, o.position, o.request).keys.length, 10);
  assert.equal(P.positionSizeUsd(posData(22)), 22);
  assert.equal(P.positionSizeUsd(null), 0);
});

test("the perps wallet is its own: not the first wallet", () => {
  assert.notEqual(namedWallet("perps").address, wallet().address);
  assert.notEqual(namedWallet("perps").address, namedWallet("buckets").address);
});

test("a rule below the bar stays on paper", async () => {
  setup(paperTrades(REAL_MIN_TRADES - 1, 60));
  const { c, deps } = world();
  _bucketsTest.state().perpOpen = [paperOpen(Date.now() - 1000)] as never;
  await P.perpsLiveTick(deps);
  assert.equal(c.sends, 0);
  assert.equal(P._test.state().pos, null);
});

test("switched off: nothing is sent even for a rule that meets the bar", async () => {
  setup();
  const { c, deps } = world();
  c.cfg = { ...CFG, on: false };
  _bucketsTest.state().perpOpen = [paperOpen(Date.now() - 1000)] as never;
  await P.perpsLiveTick(deps);
  assert.equal(c.sends, 0);
});

test("a failed simulation means nothing is sent", async () => {
  setup();
  const { c, deps } = world();
  c.sim = { err: { InstructionError: [2, { Custom: 6001 }] }, logs: ["Program log: AnchorError occurred. Error Code: InvalidArgument. Error Number: 6001."] };
  _bucketsTest.state().perpOpen = [paperOpen(Date.now() - 1000)] as never;
  await P.perpsLiveTick(deps);
  assert.equal(c.sims, 1);
  assert.equal(c.sends, 0);
  assert.equal(P._test.state().pos, null);
  assert.equal(P._test.state().lastSim, "failed: instruction 2, custom error 6001 (InvalidArgument)");
  assert.equal(P._test.state().skipped["simulation failed"], 1);
});

test("open, wait for the keeper, close with the paper trade, book what the USDC did", async () => {
  setup();
  const { c, deps, keeper, w } = world();
  const at = Date.now() - 1000;
  _bucketsTest.state().perpOpen = [paperOpen(at)] as never;
  await P.perpsLiveTick(deps);
  assert.equal(c.sends, 1);
  assert.equal(P._test.state().pos?.stage, "opening");
  // the transaction is paid and signed by the perps wallet alone
  const raw = Buffer.from(c.lastTx, "base64");
  assert.equal(raw[0], 1); // one signature
  assert.ok(raw.includes(Buffer.from(base58decode(w.address)))); // its public key is in the message
  await P.perpsLiveTick(deps); // still waiting
  assert.equal(P._test.state().pos?.stage, "opening");
  keeper.fillOpen();
  await P.perpsLiveTick(deps);
  assert.equal(P._test.state().pos?.stage, "open");
  assert.equal(c.sends, 1);
  P._test.setCfg(() => CFG);
  const open = P.perpsLiveSummary().open;
  assert.equal(open?.collateralUsd, 10.9);
  assert.equal(open?.unrealisedUsd, 0.85); // $22 short from 104 to 100

  _bucketsTest.state().perpOpen = []; // the paper short closed
  await P.perpsLiveTick(deps);
  assert.equal(c.sends, 2);
  assert.equal(P._test.state().pos?.stage, "closing");
  keeper.fillClose(11.4);
  await P.perpsLiveTick(deps);
  const s = P._test.state();
  assert.equal(s.pos, null);
  assert.equal(s.netUsd, 0.4);
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].filled, true);
  await P.perpsLiveTick(deps); // the same paper position is not opened twice
  assert.equal(c.sends, 2);
});

test("an open request the keeper turns down books nothing lost", async () => {
  setup();
  const { c, deps, keeper } = world();
  _bucketsTest.state().perpOpen = [paperOpen(Date.now() - 1000)] as never;
  const t = Date.now();
  await P.perpsLiveTick(deps, t);
  keeper.refuse();
  await P.perpsLiveTick(deps, t + 110_000);
  const s = P._test.state();
  assert.equal(s.pos, null);
  assert.equal(s.netUsd, 0);
  assert.equal(s.rows[0].filled, false);
  assert.equal(c.sends, 1);
});

test("a rule that loses its stop goes back to paper until new paper trades meet the bar", async () => {
  setup();
  const { c, deps, keeper } = world(40);
  for (let i = 0; i < 2; i++) {
    const at = Date.now() - 1000 + i;
    _bucketsTest.state().perpOpen = [paperOpen(at)] as never;
    await P.perpsLiveTick(deps);
    keeper.fillOpen();
    await P.perpsLiveTick(deps);
    _bucketsTest.state().perpOpen = [];
    await P.perpsLiveTick(deps);
    keeper.fillClose(9.4); // -1.6 each
    await P.perpsLiveTick(deps);
  }
  assert.equal(P._test.state().netUsd, -3.2);
  assert.ok(P._test.state().demoted[RULE] > 0);
  assert.equal(P.promoted(RULE), false);
  const before = c.sends;
  _bucketsTest.state().perpOpen = [paperOpen(Date.now())] as never;
  await P.perpsLiveTick(deps);
  assert.equal(c.sends, before);
  // 100 new paper trades made after the demotion bring it back
  _bucketsTest.state().perpTrades = paperTrades(REAL_MIN_TRADES, 60, Date.now() + 10) as never;
  assert.equal(P.promoted(RULE), true);
});

test("longs and too little USDC are skipped; the daily dry run is recorded", async () => {
  setup();
  const { c, deps } = world(5);
  _bucketsTest.state().perpOpen = [paperOpen(Date.now() - 1000, 1)] as never;
  await P.perpsLiveTick(deps);
  _bucketsTest.state().perpOpen = [paperOpen(Date.now() - 500)] as never;
  await P.perpsLiveTick(deps);
  assert.equal(c.sends, 0);
  const s = P._test.state();
  assert.equal(s.skipped["not a short on SOL, BTC or ETH"], 1);
  assert.equal(s.skipped["too little USDC"], 1);
  s.dry = null;
  c.sim = { err: { InstructionError: [2, { Custom: 1 }] }, logs: ["Program log: Error: insufficient funds"] };
  _bucketsTest.state().perpOpen = [];
  await P.perpsLiveTick(deps);
  assert.equal(P._test.state().dry?.result, "failed: instruction 2, custom error 1, insufficient funds");
  assert.equal(c.sends, 0);
});

test("the summary names rules and numbers only", () => {
  setup();
  const w = namedWallet("perps");
  P._test.setCfg(() => CFG);
  const text = JSON.stringify(P.perpsLiveSummary());
  assert.ok(!text.includes(w.address));
  assert.ok(text.includes(RULE));
  assert.ok(P.perpsLiveSummary().rules.every((x) => x.id !== COPY_SHORTS || x.paperTrades >= 50));
});

test("the close order is tried on a short that exists on the chain, and nothing is sent", async () => {
  setup();
  const { c, deps } = world();
  P._test.state().dryClose = null;
  await P.perpsLiveTick(deps);
  assert.equal(c.scans, 1);
  assert.equal(c.sims, 1);
  assert.equal(c.sends, 0);
  assert.deepEqual({ ...P._test.state().dryClose, at: 0 }, { at: 0, result: "ok", tried: 1 });
  // a failure is tried on more owners (here both that hold a short), then looked at again in an hour
  P._test.state().dryClose = null;
  c.sim = { err: { InstructionError: [2, { Custom: 6005 }] }, logs: [] };
  const t = Date.now();
  await P.perpsLiveTick(deps, t);
  assert.equal(P._test.state().dryClose?.tried, 2);
  assert.equal(P._test.state().dryClose?.result, "failed: instruction 2, custom error 6005");
  await P.perpsLiveTick(deps, t + 30 * 60_000);
  assert.equal(c.scans, 2);
  await P.perpsLiveTick(deps, t + 61 * 60_000);
  assert.equal(c.scans, 3);
  assert.equal(c.sends, 0);
});
