import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Deps, SendState } from "./sendout.js";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "sendout-"));
const { TOKEN_2022, SELL_MIN_LAMPORTS, COIN_WAIT_MS, FEE_LAMPORTS, SOL_USDC, isSolAddress, nextWalletStep, openDest, seal, sendOutTick, unseal } = await import("./sendout.js");
const { namedWallet, wallet } = await import("./keys.js");

const W = wallet();
const DEST = namedWallet("perps").address;
const fresh = () => ({ txs: [], coinsSeenAt: null, coinsLeft: 0, done: false, error: null });

test("sendout: the destination opens only with the right key and only as a Solana address", () => {
  const s = seal(DEST, "k1");
  assert.equal(openDest(s, "k1"), DEST);
  assert.equal(openDest(s, "k2"), null);
  assert.equal(openDest(seal("0x1234", "k1"), "k1"), null);
  assert.equal(unseal("garbage", "k1"), null);
  assert.equal(isSolAddress(DEST), true);
});

test("sendout: USDC first, then coins wait, then empty accounts close, then all SOL", () => {
  const usdc = { address: "U", mint: SOL_USDC, amount: 5_000_000n, decimals: 6 };
  const coin = { address: "C", mint: "M", amount: 3n, decimals: 6 };
  const empty = { address: "E", mint: "M2", amount: 0n, decimals: 6 };
  const now = 1_000_000_000;
  assert.equal(nextWalletStep(W.address, DEST, { lamports: 1e9, accounts: [usdc, coin, empty] }, fresh(), now).do, "usdc");
  assert.equal(nextWalletStep(W.address, DEST, { lamports: 1e9, accounts: [coin, empty] }, { ...fresh(), coinsSeenAt: now, sells: { [coin.mint]: 3 } }, now).do, "wait");
  assert.equal(nextWalletStep(W.address, DEST, { lamports: 1e9, accounts: [coin, empty] }, { ...fresh(), coinsSeenAt: now - COIN_WAIT_MS, sells: { [coin.mint]: 3 } }, now).do, "close");
  const s = nextWalletStep(W.address, DEST, { lamports: 1e9, accounts: [] }, fresh(), now);
  assert.equal(s.do, "sol");
  assert.equal(s.do === "sol" && s.lamports, 1e9 - FEE_LAMPORTS);
  assert.equal(nextWalletStep(W.address, DEST, { lamports: FEE_LAMPORTS, accounts: [] }, fresh(), now).do, "done");
  assert.equal(nextWalletStep(W.address, DEST, { lamports: 1e9, accounts: [] }, { ...fresh(), txs: [{ sig: "x", at: now, what: "sol", confirmed: false, dropped: false, err: null }] }, now).do, "nothing");
});

test("sendout: a coin (Token-2022 too) is sold first when there is SOL for the fee; a done wallet is looked at again", () => {
  const now = 1_800_000_000_000;
  const coin = { address: "C22", mint: "Dessa1111111111111111111111111111111111111", amount: 5n, decimals: 6, program: TOKEN_2022 };
  const done = { ...fresh(), done: true };
  assert.deepEqual(nextWalletStep(W.address, DEST, { lamports: SELL_MIN_LAMPORTS, accounts: [coin] }, done, now), { do: "sell", mint: coin.mint });
  assert.equal(nextWalletStep(W.address, DEST, { lamports: 0, accounts: [coin] }, done, now).do, "wait");
  const close = nextWalletStep(W.address, DEST, { lamports: 1e7, accounts: [{ ...coin, amount: 0n }] }, done, now);
  assert.equal(close.do, "close");
  assert.equal(close.do === "close" && close.ixs[0].program, TOKEN_2022);
  assert.equal(nextWalletStep(W.address, DEST, { lamports: 1e7, accounts: [] }, done, now).do, "sol");
  assert.equal(nextWalletStep(W.address, DEST, { lamports: 1e7, accounts: [coin] }, { ...done, sells: { [coin.mint]: 3 } }, now).do, "sol");
});

test("sendout: the test goes once, nothing else until it is confirmed; then each wallet empties", async () => {
  let st: SendState = { test: null, testTries: 0, wallets: {} };
  const sent: string[] = [];
  let lamports = 1e9;
  let stage = "test";
  let confirmed = false;
  const d: Deps = {
    plan: () => ({ stage, dest: DEST, secret: "k" }),
    wallets: () => [["spot rules", W]],
    holdings: async () => ({ lamports, accounts: [] }),
    blockhash: async () => DEST,
    send: async (b) => (sent.push(b), `sig${sent.length}`),
    status: async () => (confirmed ? "confirmed" : "unknown"),
    load: () => JSON.parse(JSON.stringify(st)),
    save: (s) => (st = JSON.parse(JSON.stringify(s))),
    now: () => 0,
  };
  await sendOutTick(d);
  await sendOutTick(d);
  assert.equal(sent.length, 1);
  stage = "all";
  await sendOutTick(d);
  assert.equal(sent.length, 1, "nothing more before the test is confirmed");
  confirmed = true;
  await sendOutTick(d);
  assert.equal(st.test?.confirmed, true);
  assert.equal(sent.length, 2);
  assert.equal(st.wallets["spot rules"].txs[0].lamports, 1e9 - FEE_LAMPORTS);
  lamports = 0;
  await sendOutTick(d);
  assert.equal(st.wallets["spot rules"].done, true);
});

test("sendout: confirmed SOL sends are booked as money taken out of their wallet", async () => {
  const { sendOutMoves, SENT_SOL_USD } = await import("./sendout.js");
  const m = sendOutMoves({ test: { sig: "t", at: 5, what: "test", lamports: 1e7, confirmed: true, dropped: false, err: null }, testTries: 2, wallets: { "spot rules": { ...fresh(), txs: [{ sig: "a", at: 9, what: "sol", lamports: 1e9, confirmed: true, dropped: false, err: null }, { sig: "b", at: 9, what: "close", confirmed: true, dropped: false, err: null }] } } });
  assert.deepEqual(m.map((x) => [x.from, Math.round(x.arrivedUsd * 100) / 100]), [["solana-spot-copy", Math.round(0.02 * SENT_SOL_USD * 100) / 100], ["solana-spot-rules", SENT_SOL_USD]]);
});
