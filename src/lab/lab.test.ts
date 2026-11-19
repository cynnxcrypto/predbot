import assert from "node:assert/strict";
import { test } from "node:test";
import * as V from "./vaults.js";
import * as C from "./carry.js";
import * as B from "./basecopy.js";

const now = Date.UTC(2026, 10, 19, 5, 0);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const addr = (n: number) => "0x" + String(n).padStart(40, "0");

test("vaults: only vaults with money, age and dollars made are picked, most dollars this month first", () => {
  const row = (n: number, tvl: number, ageD: number, month: number, all: number, extra: Record<string, unknown> = {}) => ({
    apr: 0.1,
    pnls: [["day", ["0.0", "1.0"]], ["month", ["5.0", String(5 + month)]], ["allTime", ["0.0", "3.0", String(all)]]],
    summary: { name: "v" + n, vaultAddress: addr(n), leader: addr(900 + n), tvl: String(tvl), isClosed: false, relationship: { type: "normal" }, createTimeMillis: now - ageD * DAY, ...extra },
  });
  const list = V.readList([row(1, 2e6, 200, 40_000, 300_000), row(2, 9e6, 400, 90_000, 2e6), row(3, 1000, 400, 500, 60_000), row(4, 3e6, 20, 80_000, 90_000), row(5, 3e6, 200, -5000, 900_000), row(6, 3e6, 200, 70_000, 900_000, { isClosed: true }), { junk: 1 }], now);
  assert.equal(list.length, 5, "closed and unreadable rows are dropped");
  assert.deepEqual(V.pick(list).map((v) => v.name), ["v2", "v1"]);
  const st: V.VaultState = { held: {}, hist: [] };
  V.deposit(st, list, now);
  assert.deepEqual(Object.keys(st.held), [addr(2), addr(1)]);
});

test("vaults: a deposit moves with the vault's own profit over its value; the leader's cut comes off gains only", () => {
  const h: V.Held = { name: "v", since: now, grossUsd: 100, peakUsd: 100, maxDdPct: 0, commission: 0.1, tvlUsd: 1e6, monthUsd: 1, allUsd: 1 };
  const page = (ms: number, pnl: number, av: number) => V.readDetail({ leaderCommission: 0.1, portfolio: [["day", {}], ["allTime", { accountValueHistory: [[ms - 1, "1"], [ms, String(av)]], pnlHistory: [[ms - 1, "0"], [ms, String(pnl)]] }]] });
  V.step(h, page(now, 50_000, 1_000_000) as V.Point, now);
  assert.equal(h.grossUsd, 100, "the first reading only sets the base");
  // others deposit 500k and the vault makes 20k on its 1M: +2%
  V.step(h, page(now + HOUR, 70_000, 1_520_000) as V.Point, now + HOUR);
  assert.ok(Math.abs(h.grossUsd - 102) < 1e-9);
  assert.ok(Math.abs(V.netUsd(h) - 101.8) < 1e-9);
  // the same point read again changes nothing
  V.step(h, page(now + HOUR, 70_000, 1_520_000) as V.Point, now + 2 * HOUR);
  assert.ok(Math.abs(h.grossUsd - 102) < 1e-9);
  // a loss is all ours, and the drawdown is kept
  V.step(h, page(now + 3 * HOUR, 70_000 - 152_000, 1_368_000) as V.Point, now + 3 * HOUR);
  assert.ok(Math.abs(h.grossUsd - 91.8) < 1e-9);
  assert.ok(Math.abs(V.netUsd(h) - 91.8) < 1e-9);
  assert.equal(Math.round(h.maxDdPct), 10);
  // a broken reading is not a result
  V.step(h, page(now + 4 * HOUR, 9e9, 1_368_000) as V.Point, now + 4 * HOUR);
  assert.ok(Math.abs(h.grossUsd - 91.8) < 1e-9);
  assert.equal(h.skipped, 1);
  assert.equal(V.readDetail({ portfolio: [] }), null);
});

const perpsAnswer = [
  { universe: [{ name: "BTC" }, { name: "HYPE" }, { name: "OLD", isDelisted: true }, { name: "DOGE" }] },
  [
    { funding: "0.0000125", markPx: "100000", midPx: "100000", dayNtlVlm: "2000000000" },
    { funding: "0.00005", markPx: "40", midPx: "40", dayNtlVlm: "300000000" },
    { funding: "0.1", markPx: "1", midPx: "1", dayNtlVlm: "1" },
    { funding: "0.00001", markPx: "0.2", midPx: "0.2", dayNtlVlm: "90000000" },
  ],
];

test("carry: perps, Hyperliquid spot under the perp's name, Kraken dollar pairs at the same price", () => {
  const perps = C.readPerps(perpsAnswer);
  assert.deepEqual(Object.keys(perps), ["BTC", "HYPE", "DOGE"]);
  const hl = C.readHlSpot(
    [
      { tokens: [{ name: "USDC", index: 0 }, { name: "HYPE", index: 150 }, { name: "UBTC", index: 197 }, { name: "DOGE", index: 9 }], universe: [{ name: "@107", tokens: [150, 0] }, { name: "@142", tokens: [197, 0] }, { name: "@9", tokens: [9, 0] }, { name: "@1", tokens: [150, 197] }] },
      [{ coin: "@107", midPx: "40.02", dayNtlVlm: "50000000" }, { coin: "@142", midPx: "100050", dayNtlVlm: "30000000" }, { coin: "@9", midPx: "0.0004", dayNtlVlm: "100" }],
    ],
    perps,
  );
  assert.deepEqual(Object.keys(hl).sort(), ["BTC", "HYPE"], "a spot coin that only shares a name (other price) is not the perp's coin");
  const kr = C.readKraken({ result: { XXBTZUSD: { a: ["100010"], b: ["99990"], v: ["1", "900"] }, XDGUSD: { a: ["0.2001"], b: ["0.1999"], v: ["1", "50000000"] }, HYPEUSDT: { a: ["40"], b: ["40"], v: ["1", "9"] }, HYPEEUR: { a: ["40"], b: ["40"], v: ["1", "9"] }, XETHZUSD: { a: ["3000"], b: ["2999"], v: ["1", "9"] } } }, perps);
  assert.deepEqual(Object.keys(kr).sort(), ["BTC", "DOGE"]);
  assert.equal(Math.round(kr.BTC.volUsd), 90_000_000);
});

test("carry: funding is earned on half the money, every fee is taken, and a flat price leaves funding minus fees", () => {
  const st: C.CarryState = { books: C.newBooks(), fund: {} };
  const perps = C.readPerps(perpsAnswer);
  const m: C.Market = { perps, hl: { BTC: { px: 100_000, volUsd: 3e7 }, HYPE: { px: 40, volUsd: 5e7 } }, kraken: { BTC: { px: 100_000, volUsd: 9e7 } } };
  // a week of hourly rates: HYPE 0.005% an hour (about 44% a year), BTC 0.00125% (about 11%)
  for (let h = 168; h >= 1; h--) {
    (st.fund.HYPE ??= []).push([now - h * HOUR, 0.00005]);
    (st.fund.BTC ??= []).push([now - h * HOUR, 0.0000125]);
  }
  assert.deepEqual(C.wanted(st, m, "hl", now), ["HYPE"], "BTC at 11% a year is under the 12% bar");
  assert.deepEqual(C.wanted(st, m, "kraken", now), []);
  C.tick(st, m, now);
  const by = Object.fromEntries(st.books.map((b) => [b.id, b]));
  assert.deepEqual(by["hl-pick"].open.map((p) => p.coin), ["HYPE"]);
  assert.equal(by["kraken-pick"].open.length, 0);
  assert.deepEqual(by["kraken-btc"].open.map((p) => p.coin), ["BTC"]);
  assert.equal(by["kraken-btc"].setupUsd, C.FEES.krakenMoveUsd);
  // ten hours later, prices unchanged
  for (let h = 1; h <= 10; h++) C.tick(st, m, now + h * HOUR);
  const s = C.summary(st, m, now + 10 * HOUR);
  const hp = s.books.find((b) => b.id === "hl-pick")!;
  // $125 short x 0.005% x 10 h = $0.0625; in and out on Hyperliquid 0.35% of $125 = $0.4375
  assert.equal(hp.opens[0].fundingUsd, 0.06);
  assert.equal(hp.opens[0].basisUsd, 0);
  assert.equal(hp.opens[0].feesUsd, 0.44);
  assert.ok(Math.abs(hp.usd + 0.375) < 0.006);
  const kb = s.books.find((b) => b.id === "kraken-btc")!;
  // Kraken: 0.4% + slip each way on the spot half, plus the $4 of moving money
  assert.ok(kb.usd < -5 && kb.usd > -5.5, String(kb.usd));
  // the spot and the short cancel: BTC +10% leaves the result where it was, less a margin top-up nothing
  const up: C.Market = { ...m, hl: { ...m.hl, HYPE: { px: 44, volUsd: 5e7 } }, perps: { ...perps, HYPE: { ...perps.HYPE, px: 44 } } };
  C.tick(st, up, now + 11 * HOUR);
  const hp2 = C.summary(st, up, now + 11 * HOUR).books.find((b) => b.id === "hl-pick")!;
  assert.equal(hp2.opens[0].basisUsd, 0);
});

test("carry: a picked coin is closed once three days of funding no longer pay, never in its first day", () => {
  const st: C.CarryState = { books: C.newBooks().filter((b) => b.id === "hl-pick"), fund: { HYPE: [] } };
  const perps = C.readPerps(perpsAnswer);
  const m: C.Market = { perps, hl: { HYPE: { px: 40, volUsd: 5e7 } }, kraken: {} };
  for (let h = 168; h >= 1; h--) st.fund.HYPE.push([now - h * HOUR, 0.00005]);
  C.tick(st, m, now);
  assert.equal(st.books[0].open.length, 1);
  const dead: C.Market = { ...m, perps: { ...perps, HYPE: { ...perps.HYPE, funding: -0.00001 } } };
  for (let h = 1; h <= 100 && st.books[0].open.length; h++) {
    C.remember(st, dead.perps, ["HYPE"], now + h * HOUR);
    C.tick(st, dead, now + h * HOUR);
    if (h < C.MIN_HOLD_H) assert.equal(st.books[0].open.length, 1);
  }
  assert.equal(st.books[0].open.length, 0);
  assert.equal(st.books[0].closed.length, 1);
  assert.ok(st.books[0].closed[0].netUsd < 0, "negative funding and fees: a loss, shown as one");
});

const pools = (rows: { n: number; sym: string; q?: string; mc?: number | null; fdv?: number; liq?: number; ageD?: number; px?: number }[]) => ({
  data: rows.map((r) => ({
    id: "base_" + addr(r.n),
    attributes: { address: addr(r.n), name: r.sym, pool_created_at: new Date(now - (r.ageD ?? 400) * DAY).toISOString(), market_cap_usd: r.mc === undefined ? "50000000" : r.mc === null ? null : String(r.mc), fdv_usd: String(r.fdv ?? 60_000_000), reserve_in_usd: String(r.liq ?? 1_000_000), base_token_price_usd: String(r.px ?? 2) },
    relationships: { base_token: { data: { id: "base_" + addr(1000 + r.n), type: "token" } }, quote_token: { data: { id: "base_q" + (r.q ?? "WETH") } } },
  })),
  included: [...rows.map((r) => ({ id: "base_" + addr(1000 + r.n), type: "token", attributes: { symbol: r.sym } })), { id: "base_qWETH", attributes: { symbol: "WETH" } }, { id: "base_qJUNK", attributes: { symbol: "JUNK" } }],
});

test("base: the Solana floor ($20M, $200k in the pool, 30 days), no dollar, wrapped or staked coins", () => {
  const found = B.readPools(pools([{ n: 1, sym: "AERO" }, { n: 2, sym: "SMALL", mc: 5e6 }, { n: 3, sym: "THIN", liq: 50_000 }, { n: 4, sym: "NEW", ageD: 3 }, { n: 5, sym: "USDC" }, { n: 6, sym: "cbETH" }, { n: 7, sym: "ODD", q: "JUNK" }, { n: 8, sym: "FDV", mc: null, fdv: 30e6 }, { n: 9, sym: "AERO", liq: 5e6 }]), now);
  assert.deepEqual(found.map((c) => c.symbol), ["AERO", "FDV", "AERO"]);
  assert.equal(found[1].fdvOnly, true);
  // one pool per coin: token 1001 and 1009 are different tokens here, so both stay; same token keeps the deepest
  const two = B.chooseCoins([found[0], { ...found[0], pool: addr(77), liqUsd: 9e6 }]);
  assert.equal(Object.values(two)[0].pool, addr(77));
});

const tr = (wallet: number, minsAgo: number, buy: boolean, usd: number, px: number, n = Math.random()) => ({
  attributes: { tx_hash: "0xh" + n, tx_from_address: addr(wallet), block_timestamp: new Date(now - minsAgo * 60_000).toISOString(), kind: buy ? "buy" : "sell", volume_in_usd: String(usd), price_to_in_usd: String(buy ? px : 1), price_from_in_usd: String(buy ? 1 : px) },
});

test("base: a wallet is followed for the size of its buys, copied at OUR price only after that, out when it sells", () => {
  const token = addr(1001);
  const st: B.BaseState = { coins: { [token]: { symbol: "AERO", token, pool: addr(1), mcapUsd: 5e7, liqUsd: 1e6, px: 2, pxAt: now - DAY } }, wallets: {}, seen: {}, open: [], done: [] };
  // history: wallet 5 bought three times at $3,000, wallet 6 three times at $1,200 (too small), all hours ago
  const hist = [tr(5, 600, true, 3000, 1.8), tr(5, 500, true, 3000, 1.9), tr(5, 400, true, 3000, 1.9), tr(6, 600, true, 1200, 1.8), tr(6, 500, true, 1200, 1.8), tr(6, 400, true, 1200, 1.8), tr(9, 300, true, 400, 2)];
  B.take(st, token, B.readTrades({ data: hist }), now);
  assert.equal(st.open.length, 0, "old buys are history, never copies");
  assert.equal(B.followed(st.wallets[addr(5)]), true);
  assert.equal(B.followed(st.wallets[addr(6)]), false);
  assert.equal(st.wallets[addr(9)], undefined, "a $400 trade is not looked at");
  // ten minutes later both buy; the pool's newest trade is at $2.02
  const t1 = now + 10 * 60_000;
  const round2 = [...hist, { attributes: { ...tr(5, 0, true, 3000, 2.0).attributes, block_timestamp: new Date(t1 - 4 * 60_000).toISOString() } }, { attributes: { ...tr(6, 0, true, 5000, 2.0).attributes, block_timestamp: new Date(t1 - 3 * 60_000).toISOString() } }, { attributes: { ...tr(8, 0, true, 1500, 2.02).attributes, block_timestamp: new Date(t1 - 60_000).toISOString() } }];
  B.take(st, token, B.readTrades({ data: round2 }), t1);
  assert.equal(st.open.length, 1);
  assert.equal(st.open[0].wallet, addr(5));
  assert.equal(st.open[0].px, 2.02, "bought at the price when we saw it, not the wallet's");
  // read again: nothing doubles
  B.take(st, token, B.readTrades({ data: round2 }), t1 + 1000);
  assert.equal(st.open.length, 1);
  assert.equal(st.wallets[addr(5)].buys.length, 4);
  // it sells at $2.20 an hour later
  const t2 = t1 + HOUR;
  B.take(st, token, B.readTrades({ data: [{ attributes: { ...tr(5, 0, false, 13_000, 2.2).attributes, block_timestamp: new Date(t2 - 60_000).toISOString() } }] }), t2);
  assert.equal(st.open.length, 0);
  // $100 at 2.02 -> 2.20 is +8.9%, less 0.5% each way
  assert.ok(Math.abs(st.done[0].usd - (100 * (2.2 / 2.02) * 0.995 - 100.5)) < 1e-9);
  assert.equal(st.wallets[addr(5)].trips, 1);
  assert.ok(st.wallets[addr(5)].realisedUsd > 0);
  const s = B.summary(st, t2);
  assert.equal(s.followed, 1);
  assert.equal(s.closed, 1);
  assert.equal(s.wallets[0].pass, false, "one copy is not a record");
});

test("base: a price run past the wallet's is not chased, a machine is not followed, a stale copy is closed at 72 h", () => {
  const token = addr(1001);
  const st: B.BaseState = { coins: { [token]: { symbol: "AERO", token, pool: addr(1), mcapUsd: 5e7, liqUsd: 1e6, px: 2, pxAt: now - DAY } }, wallets: {}, seen: {}, open: [], done: [] };
  const at = (x: ReturnType<typeof tr>, ms: number) => ({ attributes: { ...x.attributes, block_timestamp: new Date(ms).toISOString() } });
  B.take(st, token, B.readTrades({ data: [tr(5, 600, true, 3000, 1.8), tr(5, 500, true, 3000, 1.9), tr(5, 400, true, 3000, 1.9)] }), now);
  B.take(st, token, B.readTrades({ data: [at(tr(5, 0, true, 3000, 2.0), now - 5 * 60_000), at(tr(8, 0, true, 1500, 2.2), now - 60_000)] }), now);
  assert.equal(st.open.length, 0);
  assert.equal(st.skipped?.chase, 1);
  B.take(st, token, B.readTrades({ data: [at(tr(5, 0, true, 3000, 2.2), now + 60_000)] }), now + 2 * 60_000);
  assert.equal(st.open.length, 1);
  B.sweep(st, now + 71 * HOUR);
  assert.equal(st.open.length, 1);
  B.sweep(st, now + 73 * HOUR);
  assert.equal(st.open.length, 0);
  assert.equal(st.done[0].why, "time");
  // in and out within minutes, again and again: a machine
  const w: B.Wallet = { buys: [5000, 5000, 5000], lots: {}, trips: 3, won: 3, realisedUsd: 10, holds: [2, 3, 1], days: {}, lastMs: now };
  assert.equal(B.followed(w), false);
});
