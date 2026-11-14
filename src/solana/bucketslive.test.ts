import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// a scratch folder: the wallet these tests sign with is made there, never in the real data folder
const dir = mkdtempSync(join(tmpdir(), "bucketslive-"));
process.env.DATA_DIR = dir;

const L = await import("./bucketslive.js");
const { _bucketsTest, REAL_MIN_TRADES } = await import("./buckets.js");
const { buildSigned, wallet } = await import("./keys.js");
const { base58 } = await import("./whirlpool.js");
const { SOL } = await import("./pools.js");
type Cfg = import("./bucketslive.js").BucketsLiveConfig;

const SYSTEM = "11111111111111111111111111111111";
const COIN = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const RULE = "low-dip1h";
const CFG: Cfg = { on: true, stakeSol: 0.01, maxLossSol: 0.1, ruleStopSol: 0.03, maxOpen: 5, maxFeeLamports: 20_000 };
const T0 = Date.now() - 3_600_000; // paper history lies in the past: a demotion is stamped with the clock

/** `n` closed paper trades of the rule, `won` of them winners of $1, the rest losers of `lose` dollars, made at `at`. */
const paperTrades = (n: number, won: number, lose = 0.5, at = T0 - 1000) =>
  Array.from({ length: n }, (_, i) => ({ rule: RULE, bucket: "low" as const, symbol: "X", at: at + i, exitAt: at + i + 1, why: "target" as const, netUsd: i < won ? 1 : -lose }));
const paperOpen = (at: number, mint = COIN) => ({ rule: RULE, bucket: "low" as const, key: "dip1h", mint, symbol: "X", at, ref: 1, tokens: "1" });

/** A made-up wallet and Jupiter that keep books: a buy takes the stake, a sale brings `back` SOL. */
function world(back: number, sol = 0.08) {
  const w = wallet();
  const c = { sol, held: 0n, n: 0, sends: 0, closed: 0, built: new Map<string, "buy" | "sell">(), delta: new Map<string, number>(), other: [] as string[], cfg: CFG, unreadable: false };
  const deps: import("./bucketslive.js").LiveDeps = {
    cfg: () => c.cfg,
    wallet: () => w,
    otherHeld: () => c.other,
    sleep: async () => undefined,
    fixed: () => "other",
    kit: {
      quote: async (i) => ({ outAmount: i === SOL ? "1000" : String(Math.round(back * 1e9)) }),
      swapTx: async (q) => {
        const tx = buildSigned(w, SYSTEM, SYSTEM, [{ pubkey: w.address, writable: true }], [++c.n]);
        c.built.set(base58(Buffer.from(tx, "base64").subarray(1, 65)), (q as { outAmount: string }).outAmount === "1000" ? "buy" : "sell");
        return tx;
      },
      sigOf: (tx) => base58(Buffer.from(tx, "base64").subarray(1, 65)),
      send: async (tx) => {
        const sig = base58(Buffer.from(tx, "base64").subarray(1, 65));
        if (c.delta.has(sig)) return;
        c.sends++;
        const d = c.built.get(sig) === "buy" ? -(c.cfg.stakeSol + 0.00204 + 0.00001) : back - 0.00001;
        c.held = c.built.get(sig) === "buy" ? 1000n : 0n;
        c.sol += d;
        c.delta.set(sig, d);
      },
      landed: async (sig) => (c.delta.has(sig) ? { slot: 1, err: null } : null),
      held: async () => ({ amount: c.held }),
      balance: async () => c.sol,
      booked: async (_w, sigs) => (c.unreadable ? { sol: 0, unread: sigs } : { sol: sigs.reduce((a, s) => a + (c.delta.get(s) ?? 0), 0), unread: [] }),
      closeEmpty: async (_w, _m, row) => {
        c.closed++;
        const sig = "close" + c.closed;
        c.delta.set(sig, 0.00204);
        c.sol += 0.00204;
        row.sigs.push(sig);
      },
    },
  };
  return { c, deps };
}
function setup(trades: ReturnType<typeof paperTrades>, opens: ReturnType<typeof paperOpen>[]) {
  _bucketsTest.reset();
  L._test.reset();
  const st = _bucketsTest.state();
  st.trades = trades;
  st.open = opens;
  return st;
}

test("buckets real: the switch is off unless the file says on, and the hard limits hold", () => {
  assert.equal(L.parseBucketsLive("{}").on, false);
  assert.equal(L.parseBucketsLive('{"solanaBuckets":{"on":"yes","maxLossSol":0.1}}').on, false);
  assert.equal(L.parseBucketsLive('{"solanaBuckets":{"on":true}}').on, false, "no loss cap, no trading");
  assert.equal(L.parseBucketsLive("not json").on, false);
  const c = L.parseBucketsLive('{"solanaBuckets":{"on":true,"maxLossSol":5,"stakeSol":1,"ruleStopSol":9,"maxOpen":99}}');
  assert.deepEqual([c.on, c.stakeSol, c.maxLossSol, c.ruleStopSol, c.maxOpen], [true, L.HARD_STAKE_SOL, L.HARD_MAX_LOSS_SOL, L.HARD_RULE_STOP_SOL, L.HARD_MAX_OPEN]);
  const d = L.parseBucketsLive('{"solanaBuckets":{"on":true,"maxLossSol":0.1}}');
  assert.deepEqual([d.stakeSol, d.ruleStopSol, d.maxOpen], [0.01, 0.03, 5], "the small defaults");
});

test("buckets real: a rule below the bar is never bought, however the switch stands", async () => {
  for (const trades of [paperTrades(REAL_MIN_TRADES - 1, 80), paperTrades(120, 59), paperTrades(120, 61, 2)]) {
    setup(trades, [paperOpen(T0)]);
    const { c, deps } = world(0.011);
    await L.bucketsLiveTick(deps, T0 + 5000);
    assert.equal(c.sends, 0);
    assert.equal(L._test.state().opens.length, 0);
  }
  // and a proven rule with the switch off
  setup(paperTrades(120, 80), [paperOpen(T0)]);
  const { c, deps } = world(0.011);
  c.cfg = { ...CFG, on: false };
  await L.bucketsLiveTick(deps, T0 + 5000);
  assert.equal(c.sends, 0);
});

test("buckets real: a proven rule's paper buy is bought, and sold when paper sells; the books come from the chain", async () => {
  const st = setup(paperTrades(120, 80), [paperOpen(T0)]);
  const { c, deps } = world(0.0112);
  assert.equal(L.promoted(RULE), true);
  await L.bucketsLiveTick(deps, T0 + 5000);
  assert.equal(c.sends, 1);
  assert.deepEqual(L._test.state().opens.map((p) => p.stage), ["held"]);
  await L.bucketsLiveTick(deps, T0 + 35_000);
  assert.equal(c.sends, 1, "the same paper trade is not bought twice, and nothing is sold while paper holds");
  st.open = []; // paper sold
  await L.bucketsLiveTick(deps, T0 + 65_000);
  assert.equal(c.sends, 2);
  assert.equal(c.closed, 1, "the emptied coin account is closed: its rent comes back");
  const s = L._test.state();
  assert.equal(s.opens.length, 0);
  assert.ok(Math.abs(s.netSol - (0.0112 - 0.01 - 0.00002)) < 1e-9, "what the transactions did to the wallet's SOL");
  const sum = L.bucketsLiveSummary();
  assert.equal(sum.trades, 1);
  assert.ok(!JSON.stringify(sum).includes(COIN), "no coin address in the public status");
});

test("buckets real: guards before a buy", async () => {
  const cases: [string, (c: ReturnType<typeof world>["c"], st: ReturnType<typeof setup>) => void, number][] = [
    ["held by the day-holder copy", (c) => (c.other = [COIN]), T0 + 5000],
    ["too little SOL", (c) => (c.sol = 0.011), T0 + 5000],
    ["wallet over the agreed size", (c) => (c.sol = 0.7), T0 + 5000],
    ["paper buy too old", () => undefined, T0 + L.BUY_WINDOW_MS + 1000],
    ["SOL itself", (_c, st) => (st.open = [paperOpen(T0, SOL)]), T0 + 5000],
  ];
  for (const [why, prep, at] of cases) {
    const st = setup(paperTrades(120, 80), [paperOpen(T0)]);
    const { c, deps } = world(0.011);
    prep(c, st);
    await L.bucketsLiveTick(deps, at);
    assert.equal(c.sends, 0, why);
    assert.equal(L._test.state().skipped[why], 1, why);
  }
});

test("buckets real: a rule that loses its stop goes back to paper until new paper trades meet the bar; the cap stops everything", async () => {
  const st = setup(paperTrades(120, 80), []);
  const { c, deps } = world(0.0001); // every sale brings back almost nothing
  let now = T0;
  for (let i = 0; i < 4; i++) {
    st.open = [paperOpen(now)];
    await L.bucketsLiveTick(deps, now + 5000);
    st.open = [];
    await L.bucketsLiveTick(deps, now + 40_000);
    now += 100_000;
  }
  const s = L._test.state();
  assert.ok(s.netSol < -0.039 && s.netSol > -0.041, `four stakes lost (the stop is passed on the fourth): ${s.netSol}`);
  assert.ok(s.demoted[RULE] > 0, "demoted at its own stop");
  assert.equal(L.promoted(RULE), false, "its old paper record no longer counts");
  st.open = [paperOpen(now)];
  const before = c.sends;
  await L.bucketsLiveTick(deps, now + 5000);
  assert.equal(c.sends, before, "paper only now");
  // 120 new paper trades after the demotion, 80 won: real again
  st.trades = [...st.trades, ...paperTrades(120, 80, 0.5, Date.now() + 1000)];
  assert.equal(L.promoted(RULE), true);
  // the total cap: with 0.1 SOL allowed and 0.04 lost there is room; at 0.09 lost there is none
  s.netSol = -0.09;
  st.open = [paperOpen(now + 200_000)];
  await L.bucketsLiveTick(deps, now + 205_000);
  assert.equal(c.sends, before);
  assert.equal(s.skipped["no room under the cap"], 1);
});

test("buckets real: a transaction that cannot be read back stops new buys; the state survives a restart", async () => {
  const st = setup(paperTrades(120, 80), [paperOpen(T0)]);
  const { c, deps } = world(0.0112);
  await L.bucketsLiveTick(deps, T0 + 5000);
  L._test.reload();
  assert.equal(L._test.state().opens.length, 1, "the open trade is in the file");
  c.unreadable = true;
  st.open = [];
  await L.bucketsLiveTick(deps, T0 + 40_000);
  assert.match(L._test.state().halted, /could not be read back/);
  st.open = [paperOpen(T0 + 100_000)];
  const before = c.sends;
  await L.bucketsLiveTick(deps, T0 + 105_000);
  assert.equal(c.sends, before);
  // an unreadable state file never restarts the loss count
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "solana-bucketslive.json"), "{broken");
  L._test.reset();
  L._test.reload();
  assert.match(L._test.state().halted, /loss count is unknown/);
});
