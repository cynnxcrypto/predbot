import assert from "node:assert/strict";
import { test } from "node:test";
import { gasTick, _test, TOPUP_USD, type GasDeps } from "./gas.js";
import { SOL, USDC } from "./pools.js";

function world(sol: number, usdc: number) {
  const s = { sol, usdc, sent: [] as string[], busy: false, ask: null as { id: string; keepSol: number } | null };
  let pending: { inMint: string; amount: number } | null = null;
  const d: GasDeps = {
    wallet: () => ({ address: "W" }) as never,
    others: () => ({ copy: "C", rules: "" }),
    perpsBusy: () => s.busy,
    swapOnce: () => s.ask,
    sign: (tx) => tx,
    kit: {
      quote: async (inMint, _o, amount) => ((pending = { inMint, amount: Number(amount) }), { outAmount: "1" }),
      swapTx: async () => "tx",
      send: async (tx) => {
        if (!pending) return;
        if (pending.inMint === SOL) ((s.sol -= pending.amount / 1e9), (s.usdc += (pending.amount / 1e9) * 150));
        else ((s.usdc -= pending.amount / 1e6), (s.sol += pending.amount / 1e6 / 150));
        pending = null;
        s.sent.push(tx);
      },
      landed: async () => ({ slot: 1, err: null }),
      sigOf: () => "sig",
      balance: async (a) => (a === "C" ? 0.001 : s.sol),
      held: async (_a, mint) => ({ amount: mint === USDC ? BigInt(Math.round(s.usdc * 1e6)) : 0n }),
    },
  };
  return { s, d };
}

test("gas: the one swap keeps the reserve and is made once; the top-up waits its gap and never runs with a position open", async () => {
  _test.reset();
  const T0 = 1_800_000_000_000;
  const { s, d } = world(0.8, 20);
  s.ask = { id: "a", keepSol: 0.05 };
  s.busy = true;
  await gasTick(d, T0);
  assert.equal(s.sent.length, 0); // a position is open: nothing swapped, flags still read
  assert.deepEqual(_test.state().low, { perps: false, copy: true, rules: null });
  s.busy = false;
  await gasTick(d, T0 + 30_000);
  assert.equal(s.sent.length, 1);
  assert.ok(Math.abs(s.sol - 0.05) < 1e-9);
  assert.deepEqual([_test.state().swap?.result, _test.state().swap?.soldSol, _test.state().swap?.gotUsdc], ["done", 0.75, 112.5]);
  await gasTick(d, T0 + 60_000);
  assert.equal(s.sent.length, 1); // the same id is never used twice
  // fees ate the SOL: one top-up of USDC, then none for six hours
  s.sol = 0.02;
  await gasTick(d, T0 + 90_000);
  assert.equal(s.sent.length, 2);
  assert.ok(Math.abs(s.usdc - (132.5 - TOPUP_USD)) < 1e-9);
  s.sol = 0.02;
  await gasTick(d, T0 + 120_000);
  assert.equal(s.sent.length, 2);
  await gasTick(d, T0 + 90_000 + 6 * 3_600_000);
  assert.equal(s.sent.length, 3);
  // too little USDC: no top-up
  s.sol = 0.01;
  s.usdc = 2;
  await gasTick(d, T0 + 20 * 3_600_000);
  assert.equal(s.sent.length, 3);
});
