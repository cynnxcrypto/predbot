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
    ["held by another strategy", (c) => (c.other = [COIN]), T0 + 5000],
    ["too little SOL", (c) => (c.sol = 0.011), T0 + 5000],
    ["wallet over the agreed size", (c) => (c.sol = 5.4), T0 + 5000],
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
  // real results first: behind after three real trades it is cut, before its 0.03 stop; the fourth paper buy is not bought
  assert.ok(s.netSol < -0.029 && s.netSol > -0.031, `three stakes lost, then cut: ${s.netSol}`);
  assert.ok(s.demoted[RULE] > 0, "cut on its real record");
  assert.equal(s.demotedWhy?.[RULE], "cut: real record behind after 3 trades");
  assert.equal(L.promoted(RULE), false, "its old paper record no longer counts");
  st.open = [paperOpen(now)];
  const before = c.sends;
  await L.bucketsLiveTick(deps, now + 5000);
  assert.equal(c.sends, before, "paper only now");
  // 120 new paper trades after the demotion, 80 won: real again
  st.trades = [...st.trades, ...paperTrades(120, 80, 0.5, Date.now() + 1000)];
  assert.equal(L.promoted(RULE), true);
  // the total cap: with 0.1 SOL allowed and 0.03 lost there is room; at 0.09 lost there is none
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
  assert.match(L._test.state().unread ?? "", /could not be read back/, "its own stop, apart from halted");
  assert.match(L.bucketsLiveSummary().halted, /could not be read back/);
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

test("the one-time test trade: bought once, sold at the next look, never again under the same name", async () => {
  setup([], []);
  const { c, deps } = world(0.0099);
  const d = { ...deps, testId: () => "t1" };
  await L.bucketsLiveTick(d);
  assert.deepEqual(L._test.state().opens.map((p) => [p.rule, p.mint, p.stage]), [[L.TEST_RULE, L.TEST_MINT, "held"]]);
  assert.equal(c.sends, 1);
  await L.bucketsLiveTick(d);
  assert.equal(L._test.state().opens.length, 0);
  assert.equal(c.sends, 2);
  assert.equal(c.closed, 1);
  const rows = L._test.state().rows;
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].netSol - (0.0099 - 0.01 - 0.00002)) < 1e-9);
  await L.bucketsLiveTick(d);
  await L.bucketsLiveTick(d);
  assert.equal(c.sends, 2); // the name is used up
  assert.equal(L._test.state().rows.length, 1);
});


test("buckets real: a coin bought before a cut and sold after it counts for the cut record, not the next one; a missed cut is made before the next buy", async () => {
  const COIN2 = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
  const st = setup(paperTrades(120, 80), []);
  const { c, deps } = world(0.0001);
  // this test holds two coins at once: each coin has its own balance and its own sale price
  const back = new Map<string, number>([[COIN, 0.0001], [COIN2, 0.02]]);
  const held = new Map<string, bigint>();
  const made = new Map<string, { mint: string; buy: boolean }>();
  const sigOf = (tx: string) => base58(Buffer.from(tx, "base64").subarray(1, 65));
  const w = wallet();
  deps.kit.quote = (async (i: string, o: string) => ({ outAmount: i === SOL ? "1000" : String(Math.round(back.get(i)! * 1e9)), mint: i === SOL ? o : i, buy: i === SOL })) as never;
  deps.kit.swapTx = (async (q: { mint: string; buy: boolean }) => {
    const tx = buildSigned(w, SYSTEM, SYSTEM, [{ pubkey: w.address, writable: true }], [++c.n]);
    made.set(sigOf(tx), { mint: q.mint, buy: q.buy });
    return tx;
  }) as never;
  deps.kit.send = async (tx) => {
    const sig = sigOf(tx);
    const m = made.get(sig)!;
    if (c.delta.has(sig)) return;
    c.sends++;
    const d = m.buy ? -(c.cfg.stakeSol + 0.00204 + 0.00001) : back.get(m.mint)! - 0.00001;
    held.set(m.mint, m.buy ? 1000n : 0n);
    c.sol += d;
    c.delta.set(sig, d);
  };
  deps.kit.held = async (_a, mint) => ({ amount: held.get(mint) ?? 0n });
  // two real losses already, each bought and sold before now
  const s = L._test.state();
  s.rows = [1, 2].map((i) => ({ t: T0 - 5000 + i, at: T0 - 9000 + i, rule: RULE, buy: "landed" as const, netSol: -0.002, heldMin: 1 }));
  assert.equal(L.promoted(RULE), true, "behind after two real trades: the paper bar still decides");
  // a dip: two coins bought for real
  st.open = [paperOpen(T0, COIN), paperOpen(T0 + 1, COIN2)];
  await L.bucketsLiveTick(deps, T0 + 5000);
  assert.deepEqual(L._test.state().opens.map((p) => p.stage), ["held", "held"]);
  // the first is sold at a loss: three real trades, behind, cut
  st.open = [paperOpen(T0 + 1, COIN2)];
  await L.bucketsLiveTick(deps, T0 + 40_000);
  assert.equal(L._test.state().demotedWhy?.[RULE], "cut: real record behind after 3 trades");
  assert.equal(L._test.state().opens.length, 1, "the coin still out is kept until paper sells it");
  // the second is sold at a gain after the cut: it was bought before the cut, so it does not make the rule real again
  await new Promise((r) => setTimeout(r, 5));
  st.open = [];
  await L.bucketsLiveTick(deps, T0 + 80_000);
  const rows = L._test.state().rows;
  assert.equal(rows.length, 4);
  assert.ok(rows[3].netSol > 0.005 && rows[3].t > L._test.state().demoted[RULE], "a winner, finished after the cut");
  assert.deepEqual(rows.slice(2).map((x) => x.at), [T0, T0 + 1], "each row keeps when its paper trade was bought");
  assert.equal(L.promoted(RULE), false);
  assert.equal(L.standingOf(RULE).why, "paper: cut: real record behind after 3 trades; returns on new paper trades at the bar");
  const before = c.sends;
  st.open = [paperOpen(T0 + 100_000, COIN)];
  await L.bucketsLiveTick(deps, T0 + 105_000);
  assert.equal(c.sends, before, "no real buy without new paper trades at the bar");
  const line = L.bucketsLiveSummary().rules.find((x) => x.id === RULE);
  assert.deepEqual([line?.real, line?.realTrades, line?.trades], [false, 0, 4]);
  // a real trade bought after the cut does count
  s.rows = [...L._test.state().rows, { t: Date.now() + 2000, at: Date.now() + 1000, rule: RULE, buy: "landed" as const, netSol: 0.001, heldMin: 1 }];
  L._test.state().rows = s.rows;
  assert.equal(L.standingOf(RULE).why, "real: its real record is ahead (1 of 1 won); paper record is under the bar");
  // a row of an older build has no buy time: it counts by its finish less the time it was held. Finished two seconds
  // after the cut and held a minute, it was bought before the cut and belongs to the record that was cut ...
  L._test.state().rows = [...rows, { t: Date.now() + 2000, rule: RULE, buy: "landed" as const, netSol: 0.001, heldMin: 1 }];
  assert.equal(L.promoted(RULE), false, "an old row sold just after the cut does not make the rule real again");
  // ... and one that can only have been bought after the cut counts
  L._test.state().rows = [...rows, { t: Date.now() + 120_000, rule: RULE, buy: "landed" as const, netSol: 0.001, heldMin: 1 }];
  assert.equal(L.promoted(RULE), true);

  // a cut missed at the finish (the switch was off then: no stop known): made before the next buy
  const st2 = setup(paperTrades(120, 80), []);
  const w2 = world(0.011);
  L._test.state().rows = [{ t: T0 - 5000, at: T0 - 9000, rule: RULE, buy: "landed" as const, netSol: -0.031, heldMin: 1 }];
  assert.equal(L._test.state().demoted[RULE], undefined);
  st2.open = [paperOpen(T0)];
  await L.bucketsLiveTick(w2.deps, T0 + 5000);
  assert.equal(w2.c.sends, 0);
  assert.equal(L._test.state().demotedWhy?.[RULE], "cut: real trades reached the loss stop");
  // switched off: the reason says so
  w2.c.cfg = { ...CFG, on: false };
  L._test.setCfg(() => w2.c.cfg);
  st2.trades = [...st2.trades, ...paperTrades(120, 80, 0.5, Date.now() + 1000)];
  const off = L.bucketsLiveSummary().rules.find((x) => x.id === RULE);
  assert.deepEqual([off?.real, off?.why], [false, "paper: real trading is switched off"]);
  L._test.reset();
});

test("buckets real: the rent of a coin account that could not be closed is in no trade's result, and is not handed to the next trade of that coin", async () => {
  const st = setup(paperTrades(120, 80), [paperOpen(T0)]);
  const { c, deps } = world(0.0112);
  // this wallet answers with the coin's accounts, and the first close does not go through
  let accts = 0;
  let closeWorks = false;
  const send0 = deps.kit.send;
  deps.kit.send = async (tx) => {
    const sig = deps.kit.sigOf(tx);
    const fresh = !c.delta.has(sig);
    await send0(tx);
    if (!fresh || c.built.get(sig) !== "buy") return;
    if (accts > 0) (c.delta.set(sig, c.delta.get(sig)! + 0.00204), (c.sol += 0.00204)); // the account is there already: no rent is paid
    else accts = 1;
  };
  deps.kit.held = async () => ({ amount: c.held, accounts: Array.from({ length: accts }) });
  const close0 = deps.kit.closeEmpty;
  deps.kit.closeEmpty = async (w, m, row) => {
    if (!closeWorks) return;
    await close0(w, m, row);
    accts = 0;
  };
  await L.bucketsLiveTick(deps, T0 + 5000);
  st.open = [];
  await L.bucketsLiveTick(deps, T0 + 65_000);
  const s = L._test.state();
  assert.equal(s.rows.length, 1);
  assert.ok(Math.abs(s.rows[0].netSol - (0.0112 - 0.01 - 0.00002)) < 1e-9, "the trade made 0.0012 less fees: the rent left in the account is not its loss");
  assert.ok(Math.abs((s.rentOutSol ?? 0) - 0.00204) < 1e-9);
  assert.ok(Math.abs(s.netSol - s.rows[0].netSol) < 1e-9);
  // the same coin again: no rent paid at the buy, and this time the close brings the old rent back
  closeWorks = true;
  st.open = [paperOpen(T0 + 100_000)];
  await L.bucketsLiveTick(deps, T0 + 105_000);
  st.open = [];
  await L.bucketsLiveTick(deps, T0 + 165_000);
  assert.equal(s === L._test.state() ? L._test.state().rows.length : 0, 2);
  assert.ok(Math.abs(L._test.state().rows[1].netSol - (0.0112 - 0.01 - 0.00002)) < 1e-9, "the rent that came back is not this trade's gain");
  assert.ok(Math.abs(L._test.state().rentOutSol ?? 0) < 1e-9);
  assert.equal(L.bucketsLiveSummary().rentOutSol, 0);
});

/** A world whose coin cannot be sold: Jupiter has no route (or the network fails) until `c2.route` is set. */
function stuckWorld(back: number, cfg: Partial<Cfg> = {}) {
  const st = setup(paperTrades(120, 80), [paperOpen(T0)]);
  const w0 = world(back);
  w0.c.cfg = { ...CFG, ...cfg };
  const c2 = { route: false, down: false, failSells: false };
  const { deps, c } = w0;
  const quote0 = deps.kit.quote;
  deps.kit.quote = async (i, o, a, s) => {
    // what copylive's jup() does in production: a 429 when asked too fast, a 400 with Jupiter's code for no route
    if (c2.down && i !== SOL) throw new Error("jupiter /swap/v1/quote http 429");
    if (i !== SOL && !c2.route) throw new Error("jupiter /swap/v1/quote http 400 COULD_NOT_FIND_ANY_ROUTE");
    return quote0(i, o, a, s);
  };
  const send0 = deps.kit.send;
  deps.kit.send = async (tx) => {
    const sig = deps.kit.sigOf(tx);
    if (c2.failSells && c.built.get(sig) === "sell" && !c.delta.has(sig)) {
      // a sale that lands and fails: it costs its fee, the coin stays
      c.delta.set(sig, -0.00001);
      c.sol -= 0.00001;
      return;
    }
    return send0(tx);
  };
  const landed0 = deps.kit.landed;
  deps.kit.landed = async (sig, ms) => (c2.failSells && c.built.get(sig) === "sell" && c.delta.has(sig) ? { slot: 1, err: "failed" } : landed0(sig, ms));
  return { st, c, c2, deps };
}
/** Sale tries, ten minutes apart in the state's clock (the module reads Date.now(): the times are moved back instead). */
async function tries(deps: LiveDeps, n: number, spanMs: number) {
  for (let i = 0; i < n; i++) {
    const p = L._test.state().opens[0];
    if (!p) return;
    if (p.firstDeadMs) p.firstDeadMs -= spanMs / n;
    p.nextTryMs = 0;
    await L.bucketsLiveTick(deps, T0 + 70_000 + i);
  }
}
type LiveDeps = import("./bucketslive.js").LiveDeps;
const STAKE_COST = 0.01 + 0.00204 + 0.00001;

test("write-off: an outage or the bot being down never writes a coin off; only refusals over six hours, read back in full", async () => {
  const { st, c, c2, deps } = stuckWorld(0.0112);
  await L.bucketsLiveTick(deps, T0 + 5000);
  st.open = [];
  // seven hours of 429s: nothing counts
  c2.down = true;
  await tries(deps, 40, 7 * 3_600_000);
  assert.equal(L._test.state().opens.length, 1);
  assert.equal(L._test.state().opens[0].deadSales ?? 0, 0);
  // no route, 11 times over seven hours: not yet
  c2.down = false;
  await tries(deps, 11, 7 * 3_600_000);
  assert.equal(L._test.state().opens[0].deadSales, 11);
  assert.equal(L._test.state().rows.length, 0);
  // the 12th, but a transaction cannot be read back: not booked from a guess
  c.unreadable = true;
  await tries(deps, 1, 0);
  assert.equal(L._test.state().opens.length, 1);
  assert.equal(L._test.state().rows.length, 0);
  c.unreadable = false;
  await tries(deps, 1, 0);
  const s = L._test.state();
  assert.equal(s.opens.length, 0);
  assert.equal(s.stuck?.length, 1);
  assert.equal(s.rows[0].stuck, true);
  assert.ok(Math.abs(s.rows[0].netSol + STAKE_COST) < 1e-9);
  assert.ok(Math.abs(s.netSol + STAKE_COST) < 1e-9);
});

test("write-off: every hourly try's fee is booked, tries are capped, a read that fails books nothing, and a sale books the true total", async () => {
  const { st, c, c2, deps } = stuckWorld(0.0112);
  await L.bucketsLiveTick(deps, T0 + 5000);
  st.open = [];
  c2.failSells = true;
  c2.route = true; // a route exists, but every sale lands and fails
  await tries(deps, 12, 7 * 3_600_000);
  let s = L._test.state();
  assert.equal(s.stuck?.length, 1, "sales that landed and failed count");
  const failedFees = c.delta.size - 1; // every transaction but the buy was a failed sale
  assert.ok(Math.abs(s.rows[0].netSol - (-STAKE_COST - failedFees * 0.00001)) < 1e-9, "the failed sales' fees are in the write-off");
  // three hourly tries that land and fail: each fee is booked, in the books and in the row
  const tick = async () => {
    L._test.state().stuck![0].nextTryMs = 0;
    await L.bucketsLiveTick(deps, T0 + 90_000);
  };
  for (let i = 0; i < 3; i++) await tick();
  s = L._test.state();
  assert.equal(s.stuck![0].tries, 3);
  assert.ok(Math.abs(s.rows[0].netSol - (-STAKE_COST - (failedFees + 3) * 0.00001)) < 1e-9);
  assert.ok(Math.abs(s.netSol - s.rows[0].netSol) < 1e-9);
  // a try whose transactions cannot be read: nothing is booked, and nothing is lost: the next read books it
  c.unreadable = true;
  await tick();
  const mid = L._test.state().rows[0].netSol;
  assert.ok(Math.abs(mid - (-STAKE_COST - (failedFees + 3) * 0.00001)) < 1e-9);
  c.unreadable = false;
  // it sells at last: the row and the books are what the wallet did, every fee in
  c2.failSells = false;
  await tick();
  s = L._test.state();
  assert.equal(s.stuck?.length, 0);
  assert.equal(s.rows[0].recovered, true);
  const truth = [...c.delta.values()].reduce((a, x) => a + x, 0);
  assert.ok(Math.abs(s.rows[0].netSol - truth) < 1e-9, "the row equals the sum of every transaction of the coin");
  assert.ok(Math.abs(s.netSol - truth) < 1e-9);
});

test("write-off: the tries stop at the cap", async () => {
  const { st, c, c2, deps } = stuckWorld(0.0112);
  await L.bucketsLiveTick(deps, T0 + 5000);
  st.open = [];
  await tries(deps, 12, 7 * 3_600_000);
  c2.route = true;
  c2.failSells = true;
  for (let i = 0; i < L.MAX_STUCK_TRIES + 3; i++) {
    L._test.state().stuck![0].nextTryMs = 0;
    await L.bucketsLiveTick(deps, T0 + 90_000);
  }
  assert.equal(L._test.state().stuck![0].tries, L.MAX_STUCK_TRIES);
  assert.equal(L._test.state().stuck![0].gaveUp, true);
  assert.equal(L.bucketsLiveSummary().stuckGaveUp, 1);
  assert.equal(c.delta.size, 1 + L.MAX_STUCK_TRIES);
});

test("write-off: a cut and a stop it caused are undone when the coin sells after all", async () => {
  const { st, c2, deps } = stuckWorld(0.0112, { ruleStopSol: 0.01, maxLossSol: 0.02 });
  await L.bucketsLiveTick(deps, T0 + 5000);
  st.open = [];
  await tries(deps, 12, 7 * 3_600_000);
  let s = L._test.state();
  assert.ok(s.demoted[RULE] > 0, "the write-off reached the rule's stop");
  assert.match(s.halted, /loss cap/);
  c2.route = true;
  s.stuck![0].nextTryMs = 0;
  await L.bucketsLiveTick(deps, T0 + 90_000);
  s = L._test.state();
  assert.equal(s.stuck?.length, 0);
  assert.ok(Math.abs(s.netSol - (0.0112 - 0.01 - 0.00002)) < 1e-9);
  assert.equal(s.demoted[RULE], undefined, "the cut is taken back: the real result is a small gain");
  assert.equal(s.halted, "", "and so is the stop");
});

test("rent: rentOutSol never goes below zero", async () => {
  const st = setup(paperTrades(120, 80), [paperOpen(T0)]);
  const { c, deps } = world(0.0112);
  // an account left from before (its rent was booked as a loss then): this trade buys into it and closes it
  let accts = 1;
  deps.kit.held = async () => ({ amount: c.held, accounts: Array.from({ length: accts }) });
  const close0 = deps.kit.closeEmpty;
  deps.kit.closeEmpty = async (w, m, row) => {
    await close0(w, m, row);
    accts = 0;
  };
  await L.bucketsLiveTick(deps, T0 + 5000);
  st.open = [];
  await L.bucketsLiveTick(deps, T0 + 65_000);
  const s = L._test.state();
  assert.equal(s.rentOutSol ?? 0, 0);
});

