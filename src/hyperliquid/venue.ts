/**
 * Hyperliquid for the trading loop (src/hyperliquid/live.ts): reads through the public info API, orders signed by
 * the trading key. The wallet's own key is touched in one place only: naming the trading key for the account, once.
 */
import { approveAgent, coinsOf, leverageAction, orderAction, post, readOrder, send, type Coin } from "./exchange.js";
import { hlAgent, hlWallet } from "./keys.js";
import type { Wallet } from "@ethersproject/wallet";
import type { Account, Venue } from "./live.js";

const errOf = (answer: unknown): string => {
  const a = answer as { status?: string; response?: unknown };
  return a?.status === "ok" ? "" : (typeof a?.response === "string" ? a.response : "no ok from Hyperliquid").replace(/0x[0-9a-fA-F]{40,}/g, "…").slice(0, 160);
};

/** A clearinghouseState answer -> the account as the loop wants it. Throws when it is not one. */
export function readAccount(answer: unknown): Account {
  const a = answer as { marginSummary?: { accountValue?: unknown }; withdrawable?: unknown; assetPositions?: unknown };
  const valueUsd = Number(a?.marginSummary?.accountValue);
  if (!Number.isFinite(valueUsd) || !Array.isArray(a.assetPositions)) throw new Error("hyperliquid: no account in the answer");
  const positions: Account["positions"] = {};
  for (const x of a.assetPositions as { position?: Record<string, unknown> }[]) {
    const p = x?.position;
    const szi = Number(p?.szi);
    if (typeof p?.coin !== "string" || !Number.isFinite(szi) || szi === 0) continue;
    const lv = p.leverage as { type?: unknown; value?: unknown } | undefined;
    positions[p.coin] = { szi, entryPx: Number(p.entryPx) || 0, unrealUsd: Number(p.unrealizedPnl) || 0, marginUsd: Number(p.marginUsed) || 0, ...(Number(lv?.value) > 0 ? { lev: Number(lv?.value), isolated: lv?.type === "isolated" } : {}) };
  }
  return { valueUsd, freeUsd: Number(a.withdrawable) || 0, positions };
}

/** What Hyperliquid's fill record says a set of orders made: closed profit minus fees. Null unless every order is in it. */
export function readResult(fills: unknown, oids: number[]): number | null {
  if (!Array.isArray(fills)) return null;
  const mine = (fills as { oid?: number; closedPnl?: string; fee?: string }[]).filter((f) => oids.includes(Number(f?.oid)));
  if (!oids.every((o) => mine.some((f) => Number(f.oid) === o))) return null;
  const net = mine.reduce((s, f) => s + Number(f.closedPnl ?? 0) - Number(f.fee ?? 0), 0);
  return Number.isFinite(net) ? net : null;
}

type RawFill = { coin?: string; dir?: string; sz?: string; closedPnl?: string; fee?: string; oid?: number; time?: number };
/**
 * What a position that left WITHOUT our close made (a liquidation, or a close by hand), from Hyperliquid's own fills:
 * its opening order (by oid, else the opening fill of that coin and side within 3 minutes of when we opened), then the
 * closing fills of that side after it until its whole size is out. Null when the record does not hold all of it.
 * (26 Nov 2026: these were booked at the opening fee only, e.g. a BTC liquidation of -$22.65 as -$0.27, so our
 * closed-copy total read +$169 while Hyperliquid's own was +$59.)
 */
export function readGone(fills: unknown, coin: string, dir: number, openedMs: number, openOid: number | null): number | null {
  if (!Array.isArray(fills)) return null;
  const fs = (fills as RawFill[]).filter((f) => f?.coin === coin).sort((a, b) => Number(a.time) - Number(b.time));
  const openDir = dir > 0 ? "Open Long" : "Open Short";
  const closeDir = dir > 0 ? "Close Long" : "Close Short";
  let oid = openOid;
  if (oid == null) {
    const o = fs.find((f) => f.dir === openDir && Math.abs(Number(f.time) - openedMs) <= 180_000);
    if (!o) return null;
    oid = Number(o.oid);
  }
  const opens = fs.filter((f) => Number(f.oid) === oid);
  if (!opens.length) return null;
  const pnl = (f: RawFill) => Number(f.closedPnl ?? 0) - Number(f.fee ?? 0);
  const sz = opens.reduce((s, f) => s + Number(f.sz), 0);
  const start = Math.min(...opens.map((f) => Number(f.time)));
  let net = opens.reduce((s, f) => s + pnl(f), 0);
  let left = sz;
  for (const f of fs) {
    if (left <= sz * 0.001) break;
    if (Number(f.time) < start || f.dir !== closeDir || Number(f.oid) === oid) continue;
    left -= Number(f.sz);
    net += pnl(f);
  }
  if (left > sz * 0.01) return null;
  return Number.isFinite(net) ? Math.round(net * 100) / 100 : null;
}

/** `keys`: the wallet and the trading key of the account (the first wallet's unless given). */
export function realVenue(address: string, fetcher: typeof fetch = fetch, keys: { wallet: () => Wallet; agent: () => Wallet } = { wallet: hlWallet, agent: hlAgent }): Venue {
  let coins: { at: number; v: Record<string, Coin> } | null = null;
  return {
    coins: async () => {
      if (!coins || Date.now() - coins.at > 3_600_000) {
        const v = coinsOf(await post("info", { type: "meta" }, fetcher));
        if (!Object.keys(v).length) throw new Error("hyperliquid: no coin list");
        coins = { at: Date.now(), v };
      }
      return coins.v;
    },
    mids: async () => Object.fromEntries(Object.entries((await post("info", { type: "allMids" }, fetcher)) as Record<string, string>).map(([k, v]) => [k, Number(v)])),
    account: async () => readAccount(await post("info", { type: "clearinghouseState", user: address }, fetcher)),
    agent: async () => {
      const agent = keys.agent().address.toLowerCase();
      const named = (await post("info", { type: "extraAgents", user: address }, fetcher).catch(() => null)) as { address?: string }[] | null;
      if (Array.isArray(named) && named.some((x) => String(x?.address).toLowerCase() === agent)) return "";
      const w = keys.wallet();
      if (w.address.toLowerCase() !== address.toLowerCase()) return "the wallet key is not for this account";
      return errOf(await approveAgent(w, agent, fetcher));
    },
    setLeverage: async (coin, leverage) => errOf(await send(keys.agent(), leverageAction(coin, leverage), fetcher)),
    order: async (coin, buy, px, sz, reduceOnly) => readOrder(await send(keys.agent(), orderAction(coin, buy, px, sz, reduceOnly), fetcher)),
    gone: async (coin, dir, openedMs, openOid) => readGone(await post("info", { type: "userFillsByTime", user: address, startTime: Math.floor(openedMs - 300_000) }, fetcher), coin, dir, openedMs, openOid),
    result: async (oids, sinceMs) => readResult(await post("info", { type: "userFillsByTime", user: address, startTime: Math.floor(sinceMs) }, fetcher), oids),
    fills: async (sinceMs) => {
      const j = (await post("info", { type: "userFillsByTime", user: address, startTime: Math.floor(sinceMs) }, fetcher)) as { coin?: string; px?: string; sz?: string; time?: number; dir?: string }[];
      return (Array.isArray(j) ? j : []).map((f) => ({ coin: String(f.coin), px: Number(f.px), sz: Number(f.sz), time: Number(f.time), dir: String(f.dir ?? "") })).filter((f) => f.px > 0 && f.sz > 0);
    },
  };
}
