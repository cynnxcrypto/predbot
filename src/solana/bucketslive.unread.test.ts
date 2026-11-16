// From MAIN's review (16 Nov 2026), experiment B, now the fixed behaviour. Before: undoWriteOff cleared ANY halt whose text equals the write-off's loss-cap text. finish() writes its
// "could not be read back" halt as `state.halted || "..."`, so once the write-off has halted on the cap, that halt is
// masked; when the stuck coin later sells, the undo sets halted = "" and buying resumes with a finished trade whose
// transactions were never read (its result is not in netSol, and finished trades are never re-read).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "rv-b-"));
process.env.DATA_DIR = dir;

const L = await import("./bucketslive.js");
const { _bucketsTest } = await import("./buckets.js");
const { buildSigned, wallet } = await import("./keys.js");
const { base58 } = await import("./whirlpool.js");
const { SOL } = await import("./pools.js");
type Cfg = import("./bucketslive.js").BucketsLiveConfig;
type LiveDeps = import("./bucketslive.js").LiveDeps;

const SYSTEM = "11111111111111111111111111111111";
const COIN = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const COIN2 = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const COIN3 = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const RULE = "low-dip1h";
const CFG: Cfg = { on: true, stakeSol: 0.01, maxLossSol: 0.1, ruleStopSol: 0.05, maxOpen: 5, maxFeeLamports: 20_000 };
const T0 = Date.now() - 3_600_000;
const FEE = 0.000025; // 5000 base + up to 20000 priority (maxFeeLamports)
const paperTrades = (n: number, won: number, lose = 0.5, at = T0 - 1000) =>
  Array.from({ length: n }, (_, i) => ({ rule: RULE, bucket: "low" as const, symbol: "X", at: at + i, exitAt: at + i + 1, why: "target" as const, netUsd: i < won ? 1 : -lose }));
const paperOpen = (at: number, mint: string) => ({ rule: RULE, bucket: "low" as const, key: "dip1h", mint, symbol: "X", at, ref: 1, tokens: "1" });

function world() {
  const w = wallet();
  const back = new Map<string, number>([[COIN, 0.0112], [COIN2, 0.0001], [COIN3, 0.011]]);
  const held = new Map<string, bigint>();
  const made = new Map<string, { mint: string; buy: boolean }>();
  const delta = new Map<string, number>();
  const err = new Set<string>();
  const c = { n: 0, sends: 0, sol: 0.5, cfg: CFG, unreadable: false, failSells: new Set<string>(), closed: 0 };
  const sigOf = (tx: string) => base58(Buffer.from(tx, "base64").subarray(1, 65));
  const deps: LiveDeps = {
    cfg: () => c.cfg, wallet: () => w, otherHeld: () => [], sleep: async () => undefined, fixed: () => "other",
    kit: {
      quote: (async (i: string, o: string) => ({ outAmount: i === SOL ? "1000" : String(Math.round(back.get(i)! * 1e9)), mint: i === SOL ? o : i, buy: i === SOL })) as never,
      swapTx: (async (q: { mint: string; buy: boolean }) => {
        const tx = buildSigned(w, SYSTEM, SYSTEM, [{ pubkey: w.address, writable: true }], [++c.n]);
        made.set(sigOf(tx), { mint: q.mint, buy: q.buy });
        return tx;
      }) as never,
      sigOf,
      send: async (tx) => {
        const sig = sigOf(tx);
        const m = made.get(sig)!;
        if (delta.has(sig)) return;
        c.sends++;
        if (!m.buy && c.failSells.has(m.mint)) {
          // lands and fails: its fee is paid, the coin stays
          delta.set(sig, -FEE);
          err.add(sig);
          return;
        }
        const d = m.buy ? -(c.cfg.stakeSol + 0.00204 + 0.00001) : back.get(m.mint)! - 0.00001;
        held.set(m.mint, m.buy ? 1000n : 0n);
        delta.set(sig, d);
      },
      landed: async (sig) => (delta.has(sig) ? { slot: 1, err: err.has(sig) ? "failed" : null } : null),
      held: async (_a, mint) => ({ amount: held.get(mint) ?? 0n }),
      balance: async () => c.sol,
      booked: async (_w, sigs) => (c.unreadable ? { sol: 0, unread: sigs } : { sol: sigs.reduce((a, s) => a + (delta.get(s) ?? 0), 0), unread: [] }),
      closeEmpty: async (_w, _m, row) => {
        c.closed++;
        const sig = "close" + c.closed;
        delta.set(sig, 0.00204);
        row.sigs.push(sig);
      },
    },
  };
  return { c, deps, delta };
}

test("write-off undo: the stop for unread books is kept apart and never lifted by it", async () => {
  _bucketsTest.reset();
  L._test.reset();
  const st = _bucketsTest.state();
  st.trades = paperTrades(120, 80);
  const { c, deps, delta } = world();
  const s0 = L._test.state();
  s0.netSol = -0.074; // earlier real losses (0.074 of the 0.1 cap): two more coins still fit under the cap
  st.open = [paperOpen(T0, COIN), paperOpen(T0 + 1, COIN2)];
  await L.bucketsLiveTick(deps, T0 + 5000);
  assert.deepEqual(L._test.state().opens.map((p) => p.mint), [COIN, COIN2], "both bought");
  // paper sells COIN; every sale of it lands and fails (a coin whose transfer is blocked)
  c.failSells.add(COIN);
  st.open = [paperOpen(T0 + 1, COIN2)];
  for (let i = 0; i < 12; i++) {
    const p = L._test.state().opens.find((x) => x.mint === COIN)!;
    if (p.firstDeadMs) p.firstDeadMs -= 7 * 3_600_000 / 12;
    p.nextTryMs = 0;
    await L.bucketsLiveTick(deps, T0 + 70_000 + i);
  }
  let s = L._test.state();
  assert.equal(s.stuck?.length, 1, "COIN written off");
  assert.match(s.halted, /^loss cap reached/, "the write-off (stake + 72 failed-sale fees) reached the cap: halted");
  const capHalt = s.halted;
  // paper sells COIN2; its transactions cannot be read back now (RPC trouble)
  c.unreadable = true;
  st.open = [];
  await L.bucketsLiveTick(deps, T0 + 80_000);
  s = L._test.state();
  assert.equal(s.opens.length, 0, "COIN2 finished");
  assert.equal(s.halted, capHalt);
  assert.match(s.unread ?? "", /could not be read back/, "the unread stop is set in its own field");
  const coin2Row = s.rows[s.rows.length - 1];
  assert.equal(coin2Row.netSol, 0, "COIN2's real loss is not in its row nor in netSol, and a finished trade is never read again");
  // RPC fine again; COIN's sale goes through at the next hourly try
  c.unreadable = false;
  c.failSells.delete(COIN);
  s.stuck![0].nextTryMs = 0;
  await L.bucketsLiveTick(deps, T0 + 90_000);
  s = L._test.state();
  assert.equal(s.stuck?.length, 0, "COIN sold after all");
  // the undo lifts the write-off's own stop, never the one for unread books
  assert.equal(L._test.state().halted, "", "the write-off's loss-cap stop is undone: the coin sold after all");
  assert.match(L.bucketsLiveSummary().halted, /could not be read back/, "the stop for unread books stays");
  assert.equal(L.bucketsLiveSummary().on, false);
  const before = c.sends;
  st.open = [paperOpen(T0 + 100_000, COIN3)];
  await L.bucketsLiveTick(deps, T0 + 105_000);
  assert.equal(c.sends, before, "nothing is bought while a finished trade's transactions were never read");
  void delta;
});

/**
 * The same made-up wallet with token accounts that can be left empty: a buy of a coin in `routeOf` also opens an
 * account for that route coin and leaves it empty (paying its rent in the buy); closing an empty account pays it back.
 */
function accountsWorld(old: string[] = []) {
  const x = world();
  const empty = new Set<string>(old);
  const routeOf = new Map<string, string>();
  const { deps, delta } = x;
  const send0 = deps.kit.send;
  deps.kit.send = async (tx) => {
    const sig = deps.kit.sigOf(tx);
    const fresh = !delta.has(sig);
    await send0(tx);
    if (!fresh) return;
    const mint = [...routeOf.keys()].find((m) => (made.get(sig) ?? "") === m);
    if (mint && !empty.has(routeOf.get(mint)!)) {
      empty.add(routeOf.get(mint)!);
      delta.set(sig, delta.get(sig)! - 0.00204);
    }
  };
  // which coin each buy was for: read from the quote the swap was built from
  const made = new Map<string, string>();
  const swap0 = deps.kit.swapTx;
  deps.kit.swapTx = async (q, a, f) => {
    const tx = await swap0(q, a, f);
    const m = q as { mint: string; buy: boolean };
    if (m.buy) made.set(deps.kit.sigOf(tx), m.mint);
    return tx;
  };
  let n = 0;
  const closed: string[] = [];
  deps.kit.emptyMints = async () => [...empty];
  deps.kit.closeSpare = async (_w, keep, sigs, only) => {
    for (const m of [...empty]) {
      if (keep.includes(m) || (only && !only.includes(m))) continue;
      empty.delete(m);
      const sig = "spare" + ++n;
      delta.set(sig, 0.00204);
      sigs.push(sig);
      closed.push(m);
    }
  };
  return { ...x, empty, routeOf, closed };
}
const ROUTE1 = "So11111111111111111111111111111111111111112x";
const ROUTE2 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OLD = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

test("rent: old empty accounts are swept once at start and booked apart, in no trade", async () => {
  _bucketsTest.reset();
  L._test.reset();
  const st = _bucketsTest.state();
  st.trades = paperTrades(120, 80);
  const { deps, closed } = accountsWorld([OLD]);
  st.open = [paperOpen(T0, COIN)];
  await L.bucketsLiveTick(deps, T0 + 5000);
  assert.deepEqual(closed, [OLD], "swept before the first buy");
  const s = L._test.state();
  assert.ok(Math.abs((s.rentBackSol ?? 0) - 0.00204) < 1e-9);
  assert.equal(s.rows.length, 0, "no row for it");
  st.open = [];
  await L.bucketsLiveTick(deps, T0 + 65_000);
  assert.equal(L._test.state().rows.length, 1);
  assert.ok(Math.abs(L._test.state().rows[0].netSol - (0.0112 - 0.01 - 0.00002)) < 1e-9, "the first trade is not handed the old account's rent");
  assert.ok(Math.abs(L._test.state().netSol - (0.0112 - 0.01 - 0.00002 + 0.00204)) < 1e-9, "the books have both");
  assert.equal(L.bucketsLiveSummary().rentBackSol, 0.00204);
});

test("rent: each trade closes only the route accounts its own swaps left", async () => {
  _bucketsTest.reset();
  L._test.reset();
  const st = _bucketsTest.state();
  st.trades = paperTrades(120, 80);
  const { deps, routeOf, closed, empty } = accountsWorld();
  routeOf.set(COIN, ROUTE1);
  routeOf.set(COIN3, ROUTE2);
  st.open = [paperOpen(T0, COIN), paperOpen(T0 + 1, COIN3)];
  await L.bucketsLiveTick(deps, T0 + 5000);
  assert.deepEqual([...empty].sort(), [ROUTE1, ROUTE2].sort());
  assert.deepEqual(L._test.state().opens.map((p) => p.routes), [[ROUTE1], [ROUTE2]]);
  // COIN3 is sold first: only its own route account is closed, and its result holds no rent
  st.open = [paperOpen(T0, COIN)];
  await L.bucketsLiveTick(deps, T0 + 65_000);
  assert.deepEqual(closed, [ROUTE2]);
  assert.ok(Math.abs(L._test.state().rows[0].netSol - (0.011 - 0.01 - 0.00002)) < 1e-9);
  st.open = [];
  await L.bucketsLiveTick(deps, T0 + 95_000);
  assert.deepEqual(closed, [ROUTE2, ROUTE1]);
  assert.ok(Math.abs(L._test.state().rows[1].netSol - (0.0112 - 0.01 - 0.00002)) < 1e-9);
  assert.equal(L._test.state().rentOutSol ?? 0, 0);
});
