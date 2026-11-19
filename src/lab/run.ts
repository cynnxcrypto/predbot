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
  saveJson("lab-carry.json", carry);
}

// ---- Base: coins every 6 h, each coin's trades every 10 min, one request every 7 s (the free limit is 30 a minute)
let baseBusy = false;
export async function baseRound(nowMs = Date.now()): Promise<void> {
  if (baseBusy) return;
  baseBusy = true;
  try {
    if (!base.coinsAt || nowMs - base.coinsAt >= 6 * 3_600_000 || !Object.keys(base.coins).length) {
      const found: B.Coin[] = [];
      let pages = 0;
      for (let page = 1; page <= 10; page++) {
        const got = B.readPools(await getJson(`${GECKO}/pools?include=base_token,quote_token&sort=h24_volume_usd_desc&page=${page}`), Date.now());
        base.calls = (base.calls ?? 0) + 1;
        pages++;
        found.push(...got);
        await sleep(7_000);
      }
      const next = B.chooseCoins(found);
      // coins we hold a copy of stay priced even when they fall off the list
      for (const c of base.open) if (!next[c.token] && base.coins[c.token]) next[c.token] = base.coins[c.token];
      if (Object.keys(next).length) base.coins = next;
      base.coinsAt = Date.now();
      base.coinNote = `${found.length} pools passed on ${pages} pages`;
    }
    for (const token of Object.keys(base.coins)) {
      const got = B.readTrades(await getJson(`${GECKO}/pools/${base.coins[token].pool}/trades?trade_volume_in_usd_greater_than=${B.SEE_USD}`));
      base.calls = (base.calls ?? 0) + 1;
      B.take(base, token, got, Date.now());
      await sleep(7_000);
    }
    B.sweep(base, Date.now());
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
  const c0 = loadJson<Partial<C.CarryState>>("lab-carry.json", {});
  carry = { ...carry, ...c0, books: C.newBooks().map((b) => c0.books?.find((x) => x.id === b.id) ?? b) };
  base = { ...base, ...loadJson<Partial<B.BaseState>>("lab-base.json", {}) };
  const every = (fn: () => Promise<void>, firstMs: number, ms: number) => {
    const run = () => void fn().catch(() => undefined);
    setTimeout(run, firstMs).unref();
    setInterval(run, ms).unref();
  };
  every(() => vaultRound(), 40_000, 30 * 60_000);
  every(() => carryRound(), 70_000, 60 * 60_000);
  every(() => baseRound(), 100_000, 10 * 60_000);
}

/** For the status and the dashboard. Public data only: vault names, leaders' short ids, no address of ours (there is none). */
export function labSummary(nowMs = Date.now()) {
  if (!on) return { on: false as const };
  return { on: true as const, at: nowMs, vaults: V.summary(vaults, nowMs), carry: C.summary(carry, market, nowMs), base: B.summary(base, nowMs) };
}
