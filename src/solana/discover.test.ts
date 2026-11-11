import assert from "node:assert/strict";
import { test } from "node:test";
import { Finder, MIN_LEADS, swapOf, type Meta, type Swap } from "./discover.js";

const MINT = "TokenMint1111111111111111111111111111111111";
const POOL = "Pool111111111111111111111111111111111111111";
const tok = (owner: string, amount: number, mint = MINT) => ({ mint, owner, uiTokenAmount: { uiAmountString: String(amount) } });
const meta = (solBefore: number, solAfter: number, pre: ReturnType<typeof tok>[], post: ReturnType<typeof tok>[]): Meta => ({ err: null, fee: 5000, preBalances: [solBefore * 1e9, 0], postBalances: [solAfter * 1e9 - 5000, 0], preTokenBalances: pre, postTokenBalances: post });

test("a swap is read from balance changes, with or without the signer's address", () => {
  const buy = meta(10, 9, [tok(POOL, 1000)], [tok(POOL, 900), tok("A", 100)]);
  assert.deepEqual(swapOf(buy, "A", 7), { slot: 7, wallet: "A", mint: MINT, buy: true, sol: 1, price: 0.01 });
  assert.equal(swapOf(buy, null, 7)?.wallet, "A", "without the signer, the owner whose balance rose is the buyer");
  const sell = meta(9, 9.5, [tok(POOL, 900), tok("A", 100)], [tok(POOL, 950), tok("A", 50)]);
  const s = swapOf(sell, "A", 8)!;
  assert.equal(s.buy, false);
  assert.ok(Math.abs(s.price - 0.01) < 1e-12 && Math.abs(s.sol - 0.5) < 1e-9);
  assert.equal(swapOf(sell, null, 8)?.wallet, "A");
  // not swaps: failed, no token moved, two tokens moved, signer who is not the one receiving
  assert.equal(swapOf({ ...buy, err: {} }, "A", 7), null);
  assert.equal(swapOf(meta(10, 9, [], []), "A", 7), null);
  assert.equal(swapOf(meta(10, 9, [tok(POOL, 1000)], [tok(POOL, 900), tok("A", 100), tok("A", 5, "Other")]), "A", 7), null);
  assert.equal(swapOf(buy, "B", 7), null);
});

const sw = (slot: number, wallet: string, sol: number, price: number, buy = true, mint = MINT): Swap => ({ slot, wallet, mint, buy, sol, price });

test("a wallet whose buys are followed by a wave and a rise becomes a candidate; a wave rider does not", () => {
  const f = new Finder();
  for (let i = 0; i < MIN_LEADS; i++) {
    const s0 = 1000 + i * 400;
    const mint = `mint${i}`;
    f.add(sw(s0, "LEAD", 2, 1.0, true, mint));
    // four others pile in over the next slots, price climbs; RIDER buys big in the middle of the wave
    f.add(sw(s0 + 1, "f1", 0.3, 1.05, true, mint));
    f.add(sw(s0 + 2, "f2", 0.3, 1.1, true, mint));
    f.add(sw(s0 + 3, "RIDER", 1, 1.15, true, mint));
    f.add(sw(s0 + 4, "f3", 0.3, 1.2, true, mint));
    f.add(sw(s0 + 12, "f4", 0.3, 1.3, true, mint));
    f.add(sw(s0 + 13, "f1", 0.3, 1.25, false, mint));
    f.add(sw(s0 + 40, "x", 0.02, 1, true, "tick")); // time passes
  }
  const c = f.candidates();
  assert.deepEqual(c.map((x) => x.wallet), ["LEAD"]);
  assert.equal(c[0].buys, MIN_LEADS);
  assert.equal(c[0].wavePct, 100);
  assert.ok(c[0].medianMovePct > 15 && c[0].avgAfter >= 4 && c[0].avgBefore === 0);
  const rider = f.wallets.get("RIDER")!;
  assert.equal(rider.n, MIN_LEADS);
  assert.equal(rider.waves, 0, "others were already buying before it");
  assert.deepEqual(f.candidates(new Set(["LEAD"])), []);
});

test("a buy nobody follows scores zero, pieces of one buy count once, and saved stats come back", () => {
  const f = new Finder();
  f.add(sw(100, "LONE", 1, 1));
  f.add(sw(101, "LONE", 1, 1.01)); // second piece of the same decision
  f.add(sw(200, "x", 0.02, 1, true, "tick"));
  const st = f.wallets.get("LONE")!;
  assert.equal(st.n, 1);
  assert.deepEqual(st.moves, [0]);
  assert.equal(st.waves, 0);
  f.add(sw(400, "LONE", 1, 1));
  f.add(sw(500, "x", 0.02, 1, true, "tick"));
  const g = new Finder();
  g.restore(JSON.parse(JSON.stringify(f.dump())));
  assert.equal(g.wallets.get("LONE")!.n, 2);
  f.prune();
  assert.equal(f.candidates().length, 0);
});
