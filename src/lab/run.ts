/**
 * The three paper tests of 19 Nov 2026 (enrique: "okay paper test it"), run inside the bot: Hyperliquid vault deposits
 * (vaults.ts), funding carry (carry.ts) and Base mid cap copies (basecopy.ts). PAPER ONLY: public data is read, nothing
 * is signed, no wallet or key is touched. LAB=off disables all three. Every failure is kept as a short note in the
 * status and tried again at the next look; nothing here can stop the bot.
 */
import { loadJson, saveJson } from "../store.js";
import { post } from "../hyperliquid/exchange.js";
import * as V from "./vaults.js";
import * as C from "./carry.js";
import * as B from "./basecopy.js";

const VAULT_LIST = "https://stats-data.hyperliquid.xyz/Mainnet/vaults";
const KRAKEN = "https://api.kraken.com/0/public/Ticker";
const GECKO = "https://api.geckoterminal.com/api/v2/networks/base";
const short = (e: unknown) => String((e as Error)?.message ?? e).replace(/0x[0-9a-fA-F]{40,}/g, "…").slice(0, 140);
const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms).unref());

let fetcher: typeof fetch = fetch;
async function getJson(url: string, timeoutMs = 20_000): Promise<unknown> {
  const res = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} http ${res.status}`);
  return res.json();
}

let vaults: V.VaultState = { held: {}, hist: [] };
let carry: C.CarryState = { books: C.newBooks(), fund: {} };
let base: B.BaseState = { coins: {}, wallets: {}, seen: {}, open: [], done: [] };
let market: C.Market | null = null;
let on = false;

// ---- vaults: the list every 6 h, each held vault's own page every 30 min
export async function vaultRound(nowMs = Date.now()): Promise<void> {
  try {
    if (!vaults.pickedAt || nowMs - vaults.pickedAt >= 6 * 3_600_000) {
      const list = V.readList(await getJson(VAULT_LIST, 60_000), nowMs);
      if (!list.length) throw new Error("vault list: nothing readable in it");
      V.deposit(vaults, list, nowMs);
    }
    let bad = "";
    for (const [address, h] of Object.entries(vaults.held)) {
      try {
        const p = V.readDetail(await post("info", { type: "vaultDetails", vaultAddress: address }, fetcher));
        if (p) V.step(h, p, nowMs);
        else bad = "a vault page had no record in it";
      } catch (e) {
        bad = short(e);
      }
      await sleep(400);
    }
    const rows = Object.values(vaults.held);
    if (rows.length) {
      vaults.hist.push([nowMs, Math.round(rows.reduce((s, h) => s + V.netUsd(h) - V.STAKE_USD, 0) * 100) / 100]);
      if (vaults.hist.length > 1500) vaults.hist.splice(0, vaults.hist.length - 1500);
    }
    vaults.error = bad || undefined;
  } catch (e) {
    vaults.error = short(e);
  }
  saveJson("lab-vaults.json", vaults);
}

// ---- carry: every hour
export async function carryRound(nowMs = Date.now()): Promise<void> {
  try {
    const perps = C.readPerps(await post("info", { type: "metaAndAssetCtxs" }, fetcher));
    if (!Object.keys(perps).length) throw new Error("hyperliquid: no perps in the answer");
    const hl = C.readHlSpot(await post("info", { type: "spotMetaAndAssetCtxs" }, fetcher), perps);
    let kraken: Record<string, C.Spot> = {};
    try {
      kraken = C.readKraken(await getJson(KRAKEN), perps);
      carry.krakenError = Object.keys(kraken).length ? undefined : "kraken: no coin matched";
    } catch (e) {
      carry.krakenError = short(e);
      // a look without Kraken: its books keep their last prices and are still paid the funding
    }
    market = { perps, hl, kraken };
    const coins = [...new Set([...Object.keys(hl), ...Object.keys(kraken)])].filter((c) => perps[c].volUsd >= C.PERP_VOL_MIN);
    // the week of hourly rates behind a coin first seen: Hyperliquid's own record, a few coins a look
    let asked = 0;
    for (const c of coins) {
      if ((carry.fund[c] ?? []).length >= C.MIN_SAMPLES || asked >= 25) continue;
      asked++;
      try {
        const h = C.readHistory(await post("info", { type: "fundingHistory", coin: c, startTime: nowMs - 7 * 86_400_000 }, fetcher));
        if (h.length) carry.fund[c] = h.slice(-180);
      } catch {
        /* next look */
      }
      await sleep(500);
    }
    C.remember(carry, perps, coins, nowMs);
    C.tick(carry, market, nowMs);
    carry.error = undefined;
  } catch (e) {
    carry.error = short(e);
  }
  // the last prices are kept with the books, so the page has them straight after a restart (before the next look)
  saveJson("lab-carry.json", { ...carry, market });
}

// ---- Base: coins every 6 h, then each coin's trades in turn. The free limit turned out far under the published
// 30 a minute (429 after 5 calls at one every 7 s, 19 Nov 2026): one request every GAP_MIN_MS, and after a 429 a
// minute's wait and twice the gap (halved back slowly). A round that is stopped picks up where it was.
const GAP_MIN_MS = 20_000;
const GAP_MAX_MS = 180_000;
let gapMs = GAP_MIN_MS;
let baseBusy = false;
let found: B.Coin[] = [];
let nextPage = 1;
let nextCoin = 0;
const PAGES = 6;
async function gecko(path: string): Promise<unknown> {
  for (let tries = 0; ; tries++) {
    await sleep(gapMs);
    base.calls = (base.calls ?? 0) + 1;
    try {
      const got = await getJson(`${GECKO}${path}`);
      gapMs = Math.max(GAP_MIN_MS, Math.round(gapMs * 0.9));
      return got;
    } catch (e) {
      if (!/http 429/.test(String((e as Error)?.message)) || tries >= 2) throw e;
      base.limited = (base.limited ?? 0) + 1;
      gapMs = Math.min(GAP_MAX_MS, gapMs * 2);
      await sleep(60_000);
    }
  }
}
export async function baseRound(nowMs = Date.now()): Promise<void> {
  if (baseBusy) return;
  baseBusy = true;
  try {
    if (!base.coinsAt || nowMs - base.coinsAt >= 6 * 3_600_000 || !Object.keys(base.coins).length) {
      for (; nextPage <= PAGES; nextPage++) found.push(...B.readPools(await gecko(`/pools?include=base_token,quote_token&sort=h24_volume_usd_desc&page=${nextPage}`), Date.now()));
      const next = B.chooseCoins(found);
      // coins we hold a copy of stay priced even when they fall off the list
      for (const c of base.open) if (!next[c.token] && base.coins[c.token]) next[c.token] = base.coins[c.token];
      if (Object.keys(next).length) base.coins = next;
      base.coinsAt = Date.now();
      base.coinNote = `${found.length} pools passed on ${PAGES} pages`;
      found = [];
      nextPage = 1;
      saveJson("lab-base.json", base);
    }
    const tokens = Object.keys(base.coins);
    if (nextCoin >= tokens.length) nextCoin = 0;
    for (; nextCoin < tokens.length; nextCoin++) {
      const token = tokens[nextCoin];
      if (!base.coins[token]) continue;
      B.take(base, token, B.readTrades(await gecko(`/pools/${base.coins[token].pool}/trades?trade_volume_in_usd_greater_than=${B.SEE_USD}`)), Date.now());
    }
    nextCoin = 0;
    B.sweep(base, Date.now());
    base.roundAt = Date.now();
    base.error = undefined;
  } catch (e) {
    base.error = short(e);
  } finally {
    baseBusy = false;
  }
  saveJson("lab-base.json", base);
}

export function startLab(f: typeof fetch = fetch): void {
  if (process.env.LAB === "off" || on) return;
  on = true;
  fetcher = f;
  vaults = { ...vaults, ...loadJson<Partial<V.VaultState>>("lab-vaults.json", {}) };
  const { market: m0, ...c0 } = loadJson<Partial<C.CarryState> & { market?: C.Market | null }>("lab-carry.json", {});
  if (m0?.perps && m0.hl && m0.kraken) market = m0;
  carry = { ...carry, ...c0, books: C.newBooks().map((b) => c0.books?.find((x) => x.id === b.id) ?? b) };
  base = { ...base, ...loadJson<Partial<B.BaseState>>("lab-base.json", {}) };
  const every = (fn: () => Promise<void>, firstMs: number, ms: number) => {
    const run = () => void fn().catch(() => undefined);
    setTimeout(run, firstMs).unref();
    setInterval(run, ms).unref();
  };
  every(() => vaultRound(), 40_000, 30 * 60_000);
  every(() => carryRound(), 70_000, 60 * 60_000);
  every(() => baseRound(), 100_000, 5 * 60_000);
}

/** For the status and the dashboard. Public data only: vault names, leaders' short ids, no address of ours (there is none). */
export function labSummary(nowMs = Date.now()) {
  if (!on) return { on: false as const };
  return { on: true as const, at: nowMs, vaults: V.summary(vaults, nowMs), carry: C.summary(carry, market, nowMs), base: B.summary(base, nowMs) };
}
