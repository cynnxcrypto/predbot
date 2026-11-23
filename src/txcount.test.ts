import assert from "node:assert/strict";
import { test } from "node:test";
import { evmNonce, hyperliquidNew, kday, polymarketNew, solanaNew, tally, type TxDeps, type TxSrc } from "./txcount.js";

const mk = (handler: (url: string, body: any) => unknown, now = Date.parse("2026-11-23T09:00:00+09:00")): TxDeps => ({
  fetch: (async (url: string, init?: RequestInit) => ({ ok: true, json: async () => handler(String(url), init?.body ? JSON.parse(String(init.body)) : null) })) as unknown as typeof fetch,
  now: () => now,
  solRpc: () => "https://rpc",
  wallets: () => ({ solana: [], polymarket: "", hl: [], evm: [] }),
  load: () => ({}),
  save: () => {},
});
const T = Date.parse("2026-11-23T08:00:00+09:00");
const Y = Date.parse("2026-11-22T20:00:00+09:00");

test("tx count: Solana pages back to the cursor, then reads only what is new", async () => {
  const sigs = Array.from({ length: 1500 }, (_, i) => ({ signature: "s" + (1500 - i), blockTime: (i < 10 ? T : Y) / 1000 }));
  const d = mk((_, b) => {
    const o = b.params[1];
    let L = sigs;
    if (o.before) L = L.slice(L.findIndex((x) => x.signature === o.before) + 1);
    if (o.until) L = L.slice(0, L.findIndex((x) => x.signature === o.until));
    return { result: L.slice(0, o.limit) };
  });
  const s: TxSrc = { days: {} };
  await solanaNew(d, "A", s);
  assert.equal(s.cursor, "s1500");
  assert.deepEqual(s.days, { [kday(T)]: 10, [kday(Y)]: 1490 });
  sigs.unshift({ signature: "s1501", blockTime: T / 1000 });
  await solanaNew(d, "A", s);
  assert.equal(s.days[kday(T)], 11);
});

test("tx count: Polymarket counts each transaction once, across pages and refreshes", async () => {
  const acts = Array.from({ length: 700 }, (_, i) => ({ timestamp: Math.floor(Y / 1000) + i, transactionHash: "h" + i }));
  acts.push({ timestamp: Math.floor(Y / 1000) + 5, transactionHash: "h5" }); // a second row of the same transaction
  const d = mk((url) => {
    const start = Number(new URL(url).searchParams.get("start"));
    return acts.filter((x) => x.timestamp >= start).sort((a, b) => a.timestamp - b.timestamp).slice(0, 500);
  });
  const s: TxSrc = { days: {} };
  await polymarketNew(d, "P", s);
  assert.equal(s.days[kday(Y)], 700);
  await polymarketNew(d, "P", s);
  assert.equal(s.days[kday(Y)], 700);
});

test("tx count: Hyperliquid fills and ledger moves, one per hash; an EVM nonce gives today from the day's first reading", async () => {
  const d = mk((_, b) => (b.type === "userFillsByTime" ? [{ hash: "0xa", time: T }, { hash: "0xa", time: T }, { hash: "0xb", time: Y }, { hash: "0x000", time: T }] : [{ hash: "0xc", time: T }]));
  const s: TxSrc = { days: {} };
  await hyperliquidNew(d, "H", s);
  assert.deepEqual(s.days, { [kday(T)]: 2, [kday(Y)]: 1 });
  let n = 40;
  const e = mk(() => ({ result: "0x" + n.toString(16) }));
  const a: TxSrc = { days: {} };
  await evmNonce(e, "rpc", "E", a);
  n = 43;
  await evmNonce(e, "rpc", "E", a);
  const t = tally({ a, s }, Date.parse("2026-11-23T09:00:00+09:00"), [{ key: "a", label: "Arbitrum", chain: "Arbitrum" }, { key: "s", label: "Hyperliquid", chain: "Hyperliquid" }]);
  assert.equal(t.ever, 43 + 3);
  assert.equal(t.today, 3 + 2);
  assert.deepEqual(t.part, ["Arbitrum"]);
});
