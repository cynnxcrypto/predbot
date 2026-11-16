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
  P._test.state().dryLong = { at: Date.now(), result: "ok" };
  P._test.state().dryCloseLong = { at: Date.now(), result: "ok", tried: 1 };
  _bucketsTest.state().perpTrades = trades as never;
}

test("off unless switched on, and the hard limits hold", () => {
  assert.equal(P.parsePerpsLive("{}").on, false);
  assert.equal(P.parsePerpsLive("not json").on, false);
  assert.equal(P.parsePerpsLive('{"solanaPerps":{"on":true}}').on, false); // no loss cap = off
  const c = P.parsePerpsLive('{"solanaPerps":{"on":true,"maxLossUsd":999,"leverage":50,"collateralUsd":5000,"ruleStopUsd":500}}');
  assert.deepEqual(c, { on: true, maxLossUsd: 50, collateralUsd: 25, leverage: 2, ruleStopUsd: 10, maxOpen: 6 });
  assert.equal(P.parsePerpsLive('{"solanaPerps":{"on":true,"maxLossUsd":50,"maxOpen":99}}').maxOpen, 6);
  assert.equal(P.parsePerpsLive('{"solanaPerps":{"on":true,"maxLossUsd":50,"maxOpen":2}}').maxOpen, 2);
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
  assert.equal(P._test.pos(), null);
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
  assert.equal(P._test.pos(), null);
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
  assert.equal(P._test.pos()?.stage, "opening");
  // the transaction is paid and signed by the perps wallet alone
  const raw = Buffer.from(c.lastTx, "base64");
  assert.equal(raw[0], 1); // one signature
  assert.ok(raw.includes(Buffer.from(base58decode(w.address)))); // its public key is in the message
  await P.perpsLiveTick(deps); // still waiting
  assert.equal(P._test.pos()?.stage, "opening");
  keeper.fillOpen();
  await P.perpsLiveTick(deps);
  assert.equal(P._test.pos()?.stage, "open");
  assert.equal(c.sends, 1);
  P._test.setCfg(() => CFG);
  const open = P.perpsLiveSummary().open;
  assert.equal(open?.collateralUsd, 10.9);
  assert.equal(open?.unrealisedUsd, 0.85); // $22 short from 104 to 100

  _bucketsTest.state().perpOpen = []; // the paper short closed
  await P.perpsLiveTick(deps);
  assert.equal(c.sends, 2);
  assert.equal(P._test.pos()?.stage, "closing");
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

test("too little USDC is skipped; the daily dry run is recorded", async () => {
  setup();
  const { c, deps } = world(5);
  _bucketsTest.state().perpOpen = [paperOpen(Date.now() - 1000, 1)] as never;
  await P.perpsLiveTick(deps);
  _bucketsTest.state().perpOpen = [paperOpen(Date.now() - 500)] as never;
  await P.perpsLiveTick(deps);
  assert.equal(c.sends, 0);
  const s = P._test.state();
  assert.equal(s.skipped["too little USDC"], 2); // a long is an order like a short now
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

test("the one-time test short: opened with the switch off, closed at the next look, never again under the same name", async () => {
  setup([]);
  const { c, deps, keeper } = world(30);
  c.cfg = P.parsePerpsLive("{}"); // off
  const d = { ...deps, testId: () => "t1" };
  await P.perpsLiveTick(d);
  assert.equal(c.sends, 1);
  assert.equal(P._test.pos()?.rule, P.TEST_RULE);
  assert.equal(P._test.pos()?.sizeUsd, 20);
  keeper.fillOpen();
  await P.perpsLiveTick(d); // seen open, and with no paper position behind it the close is asked at once
  assert.equal(P._test.pos()?.stage, "closing");
  assert.equal(c.sends, 2);
  keeper.fillClose(10.95);
  await P.perpsLiveTick(d);
  assert.equal(P._test.pos(), null);
  assert.deepEqual(P._test.state().rows.map((x) => [x.rule, x.filled, x.netUsd]), [[P.TEST_RULE, true, -0.05]]);
  await P.perpsLiveTick(d);
  await P.perpsLiveTick(d);
  assert.equal(c.sends, 2); // the name is used up
  // without the funds nothing is sent, and the name is still used up
  setup([]);
  const poor = world(5);
  poor.c.cfg = P.parsePerpsLive("{}");
  await P.perpsLiveTick({ ...poor.deps, testId: () => "t2" });
  await P.perpsLiveTick({ ...poor.deps, testId: () => "t2" });
  assert.equal(poor.c.sends, 0);
  assert.equal(P._test.pos(), null);
});


test("a long: backed by the coin, bought with USDC inside the order, closed below a floor", () => {
  const w = namedWallet("perps");
  const o = P.openLongIx(w.address, "SOL", 200, 10, 101, 7n, P.longMinOut("SOL", 10, 100));
  assert.equal(o.ix.keys.length, 16);
  assert.equal(o.ix.keys[7].pubkey, P.CUSTODY.SOL);
  assert.equal(o.ix.keys[8].pubkey, P.CUSTODY.SOL, "the collateral custody of a long is the coin's own");
  assert.equal(o.ix.data.length, 8 + 8 + 8 + 1 + 8 + 9 + 8);
  assert.equal(o.ix.data[24], 1); // long
  assert.equal(o.ix.data[33], 1); // a minimum out is given
  assert.equal(Buffer.from(o.ix.data).readBigUInt64LE(34), 97_000_000n); // 0.097 SOL for $10 at $100, 3% room
  assert.notEqual(o.position, P.positionAddress(w.address, "SOL"), "a long and a short of one coin are two positions");
  assert.equal(P.closeLongIx(w.address, "SOL", 98, 8n).position, o.position);
  assert.equal(P.boundPrice(1, 100, 0.01, false), 101);
  assert.equal(P.boundPrice(1, 100, 0.02, true), 98);
  assert.equal(P.boundPrice(-1, 100, 0.01, false), 99);
  assert.equal(P.boundPrice(-1, 100, 0.02, true), 102);
  assert.equal(P.unrealUsd(1, 200, 100, 103), 6);
  assert.equal(P.unrealUsd(-1, 200, 100, 103), -6);
});

test("leverage: the trader's own, not capped by us, never above half of Jupiter's liquidation leverage", () => {
  assert.equal(P.leverageFor(37.5, 2, 500), 37.5);
  assert.equal(P.leverageFor(400, 2, 500), 250);
  assert.equal(P.leverageFor(400, 2, null), 100);
  assert.equal(P.leverageFor(undefined, 2, 500), 2); // a rule keeps the rule leverage
  assert.equal(P.leverageFor(1, 2, 500), 1.1);
  const b = Buffer.alloc(300);
  b.writeBigUInt64LE(5_000_000n, 175);
  assert.equal(P.custodyMaxLeverage(b.toString("base64")), 500);
  assert.equal(P.custodyMaxLeverage(null), null);
});

test("a copied trader at the bar: its long is opened at its leverage and closed when it closes", async () => {
  const { traderRule, TRADER_MIN_COPIES } = await import("./buckets.js");
  _bucketsTest.reset();
  P._test.reset();
  const now = Date.now();
  Object.assign(P._test.state(), { dry: { at: now, result: "ok" }, dryClose: { at: now, result: "ok", tried: 1 }, dryLong: { at: now, result: "ok" }, dryCloseLong: { at: now, result: "ok", tried: 1 } });
  const A = "0x" + "ab".repeat(20);
  _bucketsTest.state().hlTrades = Array.from({ length: TRADER_MIN_COPIES }, (_, i) => ({ trader: A, coin: "HYPE", dir: 1, at: now - 30 * 3_600_000 + i, exitAt: now - 29 * 3_600_000, net: i < 12 ? 0.02 : -0.01, why: "closed" })) as never;
  const { c, deps, keeper, w } = world(40);
  _bucketsTest.state().hlOpen = [{ trader: A, coin: "SOL", dir: 1, at: now - 1000, entry: 100, lev: 25, worst: 0 }] as never;
  await P.perpsLiveTick(deps);
  const p = P._test.pos();
  assert.equal(p?.rule, traderRule(A));
  assert.equal(p?.dir, 1);
  assert.equal(p?.lev, 25);
  assert.equal(p?.sizeUsd, 275); // $11 collateral at the trader's 25x
  assert.equal(p?.position, P.positionAddress(w.address, "SOL", 1));
  assert.equal(c.sends, 1);
  keeper.fillOpen();
  await P.perpsLiveTick(deps);
  assert.equal(P._test.pos()?.stage, "open");
  _bucketsTest.state().hlOpen = [];
  await P.perpsLiveTick(deps);
  assert.equal(P._test.pos()?.stage, "closing");
  keeper.fillClose(12.5);
  await P.perpsLiveTick(deps);
  assert.equal(P._test.pos(), null);
  assert.equal(P._test.state().netUsd, 1.5);
  assert.equal(P._test.state().rows[0].rule, traderRule(A));
});

// ---- several positions at once ------------------------------------------------------------------------------------------
/** A made-up chain that keeps a position per address: what a request does is decided when the keeper acts on it. */
function multiWorld(usdc = 100) {
  const w = namedWallet("perps");
  const c = { usdc, sizes: new Map<string, number>(), requests: new Set<string>(), sends: 0, cfg: { ...CFG, collateralUsd: 10, maxLossUsd: 50, ruleStopUsd: 10 } as Cfg };
  const deps: import("./perpslive.js").PerpDeps = {
    cfg: () => c.cfg,
    wallet: () => w,
    rpc: (async (method: string, params: unknown[]) => {
      if (method === "getLatestBlockhash") return { value: { blockhash: HASH } };
      if (method === "simulateTransaction") return { value: { err: null, logs: [] } };
      if (method === "getAccountInfo") {
        const a = params[0] as string;
        if ((params[1] as { dataSlice?: unknown }).dataSlice) return { value: c.requests.has(a) ? { data: ["", "base64"] } : null };
        const size = c.sizes.get(a) ?? 0;
        return { value: size > 0 ? { data: [posData(size), "base64"] } : null };
      }
      throw new Error("unexpected " + method);
    }) as never,
    send: async () => void c.sends++,
    landed: async () => ({ slot: 1, err: null }),
    sigOf: () => "sig",
    usdc: async () => c.usdc,
    sol: async () => 0.05,
    price: async () => 100,
    fixed: () => "other",
  };
  const moving = () => P._test.state().opens.find((x) => x.stage !== "open")!;
  const keeper = {
    /** the request on its way is filled: an open takes the collateral, a close pays `back` */
    fill: (back = 0) => {
      const p = moving();
      if (p.stage === "opening") (c.sizes.set(p.position, p.sizeUsd), (c.usdc -= 10));
      else (c.sizes.delete(p.position), (c.usdc += back));
    },
    liquidate: (position: string) => void c.sizes.delete(position),
  };
  // a request exists from the moment it is sent until the keeper acts
  const send0 = deps.send;
  deps.send = async (tx) => {
    await send0(tx);
    c.requests.add(moving().request);
  };
  const act = (back = 0) => {
    const p = moving();
    c.requests.delete(p.request);
    keeper.fill(back);
  };
  return { c, deps, keeper, act, w };
}
const T = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(20);
async function traders(n: number) {
  const { TRADER_MIN_COPIES } = await import("./buckets.js");
  _bucketsTest.reset();
  P._test.reset();
  const now = Date.now();
  Object.assign(P._test.state(), { dry: { at: now, result: "ok" }, dryClose: { at: now, result: "ok", tried: 1 }, dryLong: { at: now, result: "ok" }, dryCloseLong: { at: now, result: "ok", tried: 1 } });
  _bucketsTest.state().hlTrades = Array.from({ length: n }, (_, k) => Array.from({ length: TRADER_MIN_COPIES }, (_, i) => ({ trader: T(k + 1), coin: "HYPE", dir: 1, at: now - 30 * 3_600_000 + i, exitAt: now - 29 * 3_600_000, net: i < 12 ? 0.02 : -0.01, why: "closed" }))).flat() as never;
  return now;
}
const hl = (k: number, coin: string, dir: number, at: number, lev = 5) => ({ trader: T(k), coin, dir, at, entry: 100, lev, worst: 0 });

test("several positions at once: one per trader, one per coin and side, one request on its way at a time", async () => {
  const { traderRule } = await import("./buckets.js");
  const now = await traders(4);
  const { c, deps, act } = multiWorld(100);
  // trader 1 shorts SOL, trader 2 goes long BTC, trader 3 shorts SOL too (same coin and side), trader 1 also shorts ETH
  _bucketsTest.state().hlOpen = [hl(1, "SOL", -1, now - 4000), hl(2, "BTC", 1, now - 3000), hl(3, "SOL", -1, now - 2000), hl(1, "ETH", -1, now - 1000)] as never;
  await P.perpsLiveTick(deps);
  assert.equal(P._test.state().opens.length, 1, "the first request is on its way; the others wait");
  assert.equal(c.sends, 1);
  await P.perpsLiveTick(deps);
  assert.equal(c.sends, 1, "nothing else is sent while it is on its way");
  act(); // SOL short filled
  await P.perpsLiveTick(deps); // sees the fill
  assert.equal(P._test.state().opens[0].stage, "open");
  assert.equal(P._test.state().opens[0].paidUsd, 10);
  await P.perpsLiveTick(deps); // now the next signal
  assert.equal(c.sends, 2);
  assert.deepEqual(P._test.state().opens.map((x) => [x.rule, x.coin, x.dir, x.stage]), [[traderRule(T(1)), "SOL", -1, "open"], [traderRule(T(2)), "BTC", 1, "opening"]]);
  act();
  await P.perpsLiveTick(deps);
  await P.perpsLiveTick(deps);
  // trader 3's SOL short and trader 1's ETH short are refused: coin and side held, trader already has a position
  assert.equal(c.sends, 2);
  assert.equal(P._test.state().opens.length, 2);
  assert.equal(P._test.state().skipped["coin and side already held"], 1);
  assert.equal(P._test.state().skipped["this trader or rule already has a position"], 1);
  P._test.setCfg(() => c.cfg);
  const sum = P.perpsLiveSummary();
  assert.equal(sum.openCount, 2);
  assert.equal(sum.maxOpen, 6);
  assert.equal(sum.opens.length, 2);
  assert.equal(sum.open?.coin, "SOL");
  assert.equal(c.usdc, 80);
});

test("several positions: each one's result is its own, and a liquidation costs its collateral", async () => {
  const { traderRule } = await import("./buckets.js");
  const now = await traders(3);
  const { c, deps, act, keeper } = multiWorld(100);
  const open = async (o: ReturnType<typeof hl>) => {
    _bucketsTest.state().hlOpen = [..._bucketsTest.state().hlOpen, o] as never;
    await P.perpsLiveTick(deps);
    act();
    await P.perpsLiveTick(deps);
  };
  await open(hl(1, "SOL", -1, now - 3000));
  await open(hl(2, "BTC", 1, now - 2000));
  await open(hl(3, "ETH", -1, now - 1000));
  assert.equal(P._test.state().opens.length, 3);
  assert.equal(c.usdc, 70);
  // trader 2 closes: the BTC long is closed for $13 back (+$3); the other two stay
  _bucketsTest.state().hlOpen = _bucketsTest.state().hlOpen.filter((o) => o.trader !== T(2)) as never;
  await P.perpsLiveTick(deps);
  assert.equal(P._test.state().opens.find((x) => x.coin === "BTC")?.stage, "closing");
  act(13);
  await P.perpsLiveTick(deps);
  assert.deepEqual(P._test.state().rows.map((x) => [x.rule, x.netUsd, x.filled]), [[traderRule(T(2)), 3, true]]);
  assert.equal(P._test.state().opens.length, 2);
  // the SOL short is liquidated between two looks: nothing comes back, the $10 is the loss
  keeper.liquidate(P._test.state().opens.find((x) => x.coin === "SOL")!.position);
  // one empty answer from the chain is not proof: booked as gone at the third look in a row
  await P.perpsLiveTick(deps);
  await P.perpsLiveTick(deps);
  assert.equal(P._test.state().opens.length, 2);
  await P.perpsLiveTick(deps);
  assert.deepEqual(P._test.state().rows.map((x) => x.netUsd), [3, -10]);
  assert.equal(P._test.state().netUsd, -7);
  assert.equal(P._test.state().opens.length, 1);
  assert.ok(P._test.state().demoted[traderRule(T(1))] > 0, "a trader that lost $10 goes back to paper");
  // the ETH short closes for $9.50 back
  _bucketsTest.state().hlOpen = [];
  await P.perpsLiveTick(deps);
  act(9.5);
  await P.perpsLiveTick(deps);
  assert.deepEqual(P._test.state().rows.map((x) => x.netUsd), [3, -10, -0.5]);
  assert.equal(P._test.state().netUsd, -7.5);
  assert.equal(P._test.state().opens.length, 0);
  assert.equal(c.usdc, 100 - 7.5);
});

test("several positions: the loss cap counts every open collateral, and the wallet's USDC bounds the count", async () => {
  const now = await traders(4);
  const { c, deps, act } = multiWorld(100);
  c.cfg = { ...c.cfg, maxLossUsd: 25 }; // room for two $10 positions, not three
  const offer = async (o: ReturnType<typeof hl>) => {
    _bucketsTest.state().hlOpen = [..._bucketsTest.state().hlOpen, o] as never;
    await P.perpsLiveTick(deps);
    if (P._test.state().opens.some((x) => x.stage !== "open")) {
      act();
      await P.perpsLiveTick(deps);
    }
  };
  await offer(hl(1, "SOL", -1, now - 3000));
  await offer(hl(2, "BTC", -1, now - 2000));
  await offer(hl(3, "ETH", -1, now - 1000));
  assert.equal(P._test.state().opens.length, 2);
  assert.equal(P._test.state().skipped["no room under the cap"], 1);
  // little USDC left: nothing more is opened
  c.cfg = { ...c.cfg, maxLossUsd: 50 };
  c.usdc = 8;
  await offer(hl(4, "ETH", 1, now - 500));
  assert.equal(P._test.state().opens.length, 2);
  assert.equal(P._test.state().skipped["too little USDC"], 1);
});

test("a state file from the one-position days is carried over", async () => {
  const { writeFileSync } = await import("node:fs");
  await traders(1);
  const w = namedWallet("perps");
  const old = { netUsd: -1, pos: { rule: "x", coin: "SOL", paperId: "x:1", stage: "open", usdcBefore: 50, sizeUsd: 20, position: P.positionAddress(w.address, "SOL"), request: "r", sentMs: 1, closeTries: 0 } };
  writeFileSync(join(dir, "solana-perpslive.json"), JSON.stringify(old));
  P._test.reload();
  assert.equal(P._test.state().pos, null);
  assert.equal(P._test.state().opens.length, 1);
  assert.equal(P._test.state().opens[0].coin, "SOL");
  assert.equal(P._test.state().netUsd, -1);
  P._test.reset();
});

test("real results first: a trader ahead for real stays real under the paper bar; behind after three real trades it is cut", async () => {
  const { traderRule } = await import("./buckets.js");
  const now = await traders(1);
  const rule = traderRule(T(1));
  const { c, deps, act } = multiWorld(100);
  const row = (netUsd: number, t: number) => ({ t, rule, coin: "SOL", side: "short", leverage: 5, filled: true, netUsd, heldH: 1 });
  // two real trades, ahead; then its paper record is gone (under the bar)
  P._test.state().rows = [row(1, now - 3000), row(-0.5, now - 2000)] as never;
  _bucketsTest.state().hlTrades = [];
  assert.equal(P.promoted(rule), true);
  assert.match(P.standingOf(rule).why, /^real: its real record is ahead \(1 of 2 won\); paper record is under the bar/);
  // so its next position is still opened for real, and it loses $1: three trades, net -$0.50, far from the $10 stop
  _bucketsTest.state().hlOpen = [hl(1, "SOL", -1, now - 1000)] as never;
  await P.perpsLiveTick(deps);
  assert.equal(c.sends, 1);
  act();
  await P.perpsLiveTick(deps);
  _bucketsTest.state().hlOpen = [];
  await P.perpsLiveTick(deps);
  act(9);
  await P.perpsLiveTick(deps);
  assert.equal(P._test.state().rows.length, 3);
  assert.ok(P._test.state().demoted[rule] > 0);
  assert.equal(P._test.state().demotedWhy?.[rule], "cut: real record behind after 3 trades");
  assert.equal(P.promoted(rule), false);
  P._test.setCfg(() => c.cfg);
  const line = P.perpsLiveSummary().rules.find((x) => x.id === rule);
  assert.equal(line?.real, false);
  assert.equal(line?.why, "paper: cut: real record behind after 3 trades; returns on new paper trades at the bar");
  assert.equal(line?.trades, 3);
  assert.equal(line?.realTrades, 0, "the real record starts again after a cut");
});

test("real results first: the SOL top-up waits while any position is out; a cut missed at the finish is made before the next open; the test trades are never a rule", async () => {
  const { traderRule } = await import("./buckets.js");
  const now = await traders(2);
  const rule = traderRule(T(1));
  const { c, deps, act } = multiWorld(100);
  // the top-up's question (gas.ts): no swap while a position is open or on its way, whatever its stage
  assert.equal(P.perpsBusy(), false);
  _bucketsTest.state().hlOpen = [hl(1, "SOL", -1, now - 1000)] as never;
  await P.perpsLiveTick(deps);
  assert.equal(P._test.state().opens[0].stage, "opening");
  assert.equal(P.perpsBusy(), true, "a request on its way");
  act();
  await P.perpsLiveTick(deps);
  assert.equal(P._test.state().opens[0].stage, "open");
  assert.equal(P.perpsBusy(), true, "an open position: its result is read from the wallet's USDC");
  _bucketsTest.state().hlOpen = [];
  await P.perpsLiveTick(deps);
  act(10.4);
  await P.perpsLiveTick(deps);
  assert.equal(P._test.state().opens.length, 0);
  assert.equal(P.perpsBusy(), false);
  assert.deepEqual(P._test.state().rows.map((x) => x.netUsd), [0.4]);
  // a trade that lost the whole stop while the switch was off was not cut then (no stop is known with the switch off)
  const rule2 = traderRule(T(2));
  P._test.state().rows = [...P._test.state().rows, { t: now - 500, rule: rule2, coin: "BTC", side: "long", leverage: 5, filled: true, netUsd: -10, heldH: 1 }] as never;
  assert.equal(P._test.state().demoted[rule2], undefined);
  // its paper record is still at the bar, but its next position is not opened: the cut is made first
  _bucketsTest.state().hlOpen = [hl(2, "BTC", 1, Date.now() - 1000)] as never;
  const before = c.sends;
  await P.perpsLiveTick(deps);
  assert.equal(c.sends, before);
  assert.equal(P._test.state().demotedWhy?.[rule2], "cut: real trades reached the loss stop");
  assert.equal(P.promoted(rule2), false);
  assert.equal(P.promoted(rule), true, "the other trader is untouched");
  // three test trades that cost a few cents: the test rule is never cut and never in the rules list
  const test3 = [1, 2, 3].map((i) => ({ t: now - 100 + i, rule: P.TEST_RULE, coin: "SOL", side: "short", leverage: 2, filled: true, netUsd: -0.04, heldH: 0 }));
  P._test.state().rows = [...P._test.state().rows, ...test3] as never;
  P._test.state().demoted[P.TEST_RULE] = now; // even one written by an older build
  P._test.setCfg(() => c.cfg);
  _bucketsTest.state().hlTraders = [{ address: T(1), monthPnl: 1, monthRoi: 1 }] as never;
  const sum = P.perpsLiveSummary();
  assert.ok(!sum.rules.some((x) => x.id === P.TEST_RULE));
  assert.deepEqual([sum.rules.find((x) => x.id === rule)?.real, sum.rules.find((x) => x.id === rule)?.why], [true, "real: its real record is ahead (1 of 1 won)"]);
  // the daily list drops the trader: nothing new of it is copied, and the status says so instead of "real"
  _bucketsTest.state().hlTraders = [];
  const gone = P.perpsLiveSummary().rules.find((x) => x.id === rule);
  assert.deepEqual([gone?.real, gone?.why, gone?.realTrades], [false, "paper: not on the trader list now, nothing new of it is copied; real again when it is back", 1]);
  assert.equal(P.promoted(rule), true, "its record is kept: real again when it is back on the list");
  _bucketsTest.state().hlTraders = [{ address: T(1), monthPnl: 1, monthRoi: 1 }] as never;
  // switched off: the reason says so instead of "real"
  P._test.setCfg(() => P.parsePerpsLive("{}"));
  const off = P.perpsLiveSummary().rules.find((x) => x.id === rule);
  assert.deepEqual([off?.real, off?.why], [false, "paper: real trading is switched off"]);
  P._test.reset();
});

test("real results first: a finished test trade never cuts the test rule", async () => {
  setup([]);
  const { c, deps, keeper } = world(30);
  c.cfg = { ...CFG, ruleStopUsd: 1 };
  // two older test rows behind, then a third test trade that loses: by the numbers that would be a cut
  P._test.state().rows = [1, 2].map((i) => ({ t: Date.now() - 10_000 + i, rule: P.TEST_RULE, coin: "SOL", side: "short", leverage: 2, filled: true, netUsd: -0.6, heldH: 0 })) as never;
  const d = { ...deps, testId: () => "t9" };
  await P.perpsLiveTick(d);
  keeper.fillOpen();
  await P.perpsLiveTick(d);
  keeper.fillClose(10.5);
  await P.perpsLiveTick(d);
  assert.equal(P._test.state().rows.length, 3);
  assert.equal(P._test.state().demoted[P.TEST_RULE], undefined);
  assert.equal(P._test.state().demotedWhy?.[P.TEST_RULE], undefined);
  P._test.reset();
});
