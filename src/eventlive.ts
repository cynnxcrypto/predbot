/**
 * Real orders for pre-match event rules (10 Nov 2026 17:28 KST, enrique: "start tennis").
 *
 * The paper logger (src/eventpaper.ts) calls eventLiveBuy() right after it books a paper trade. A real order goes out
 * only when every guard below passes; any doubt or error means no order. Rules, size and guards come from the "events"
 * block of deploy/live-rules.json (pulled from git every few minutes), so a push can change or stop them:
 *
 *   "events": { "tennis": { "rules": ["tennis-atp-fav90"], "size": 3, "maxAsk": 0.96, "minDepth": 25,
 *                             "dayLosses": 2, "maxOpen": 4, "maxLoss": 12 } }
 *
 *   rules      paper rules whose trades are copied with real money (empty or missing = off)
 *   size       dollars per bet (never above 5)
 *   maxAsk     no order when the favourite asks more than this
 *   minDepth   dollars that must rest within 2c of the ask (the paper "fillable" test)
 *   dayLosses  after this many settled losses in one KST day the group stops until the next KST day
 *   maxOpen    unsettled real bets allowed at once
 *   maxLoss    the group's own BUDGET: dollars lost so far + open stakes + the new bet must stay inside it; once it is
 *              lost the group stops until enrique or a review gives it more. Separate from the crypto "lossCap".
 *
 * Also in force: the global "mode" (repo and the server's local kill switch) and the wallet floor "minBalance".
 * Orders are fill-and-kill buys limited to the ask the paper rule saw; nothing rests on the book.
 * data/eventlive.json is written only by this process; wins are claimed by the BTC 5m trader (src/live.ts redeemEvents).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "@ethersproject/wallet";
import { AssetType, Chain, ClobClient, OrderType, Side } from "@polymarket/clob-client-v2";
import { ROOT, kstDay } from "./config.js";
import type { LossCap } from "./live.js";
import { loadJson, saveJson } from "./store.js";

const HOST = "https://clob.polymarket.com";
export const EVENT_LIVE_FILE = "eventlive.json";

export type EventLiveRow = {
  t: number;
  group: string;
  rule: string;
  marketId: string;
  conditionId: string | null;
  title: string;
  outcome: string;
  idx: number;
  ask: number;
  size: number;
  cost: number;
  shares: number;
  fee: number;
  ok: boolean;
  status: string | null;
  error: string | null;
  won?: boolean | null;
  pay?: number | null;
  pnl?: number | null;
  settledAt?: number | null;
};
export type EventLiveGroup = { rules: string[]; size: number; maxAsk: number; minDepth: number; dayLosses: number; maxOpen: number; maxLoss: number };
export type EventLiveConfig = { mode: string; minBalance: number; lossCap?: LossCap; groups: Record<string, EventLiveGroup> };

const num = (x: unknown, fallback: number) => (Number.isFinite(Number(x)) && x != null ? Number(x) : fallback);

/** Parse the repo rules text and the server's local live.json into the event config. Anything malformed means off. */
export function parseEventLive(repoText: string, local: { mode?: string; funder?: string }): EventLiveConfig {
  const off: EventLiveConfig = { mode: "off", minBalance: 0, groups: {} };
  let repo: { mode?: string; minBalance?: unknown; lossCap?: { since?: unknown; maxLoss?: unknown }; events?: Record<string, Partial<EventLiveGroup>> };
  try {
    repo = JSON.parse(repoText);
  } catch {
    return off;
  }
  if (!repo || typeof repo !== "object") return off;
  const mode = local.mode === "off" || !String(local.funder ?? "").trim() ? "off" : String(repo.mode ?? "off");
  const groups: Record<string, EventLiveGroup> = {};
  for (const [g, v] of Object.entries(repo.events ?? {})) {
    if (!v || typeof v !== "object" || !Array.isArray(v.rules)) continue;
    const rules = v.rules.filter((r): r is string => typeof r === "string" && r.length > 0);
    const size = Math.min(5, num(v.size, 0));
    if (!rules.length || !(size >= 1)) continue;
    groups[g] = { rules, size, maxAsk: Math.min(0.99, num(v.maxAsk, 0.96)), minDepth: Math.max(0, num(v.minDepth, 25)), dayLosses: Math.max(1, Math.floor(num(v.dayLosses, 2))), maxOpen: Math.max(1, Math.floor(num(v.maxOpen, 4))), maxLoss: Math.max(0, num(v.maxLoss, 12)) };
  }
  const since = typeof repo.lossCap?.since === "number" ? repo.lossCap.since : Date.parse(String(repo.lossCap?.since ?? ""));
  const maxLoss = Number(repo.lossCap?.maxLoss);
  const lossCap = Number.isFinite(since) && Number.isFinite(maxLoss) && maxLoss >= 0 ? { since, maxLoss } : undefined;
  return { mode, minBalance: Math.max(0, num(repo.minBalance, 0)), lossCap, groups };
}
export function eventLiveConfig(): EventLiveConfig {
  let text = "";
  try {
    text = readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8");
  } catch {
    return { mode: "off", minBalance: 0, groups: {} };
  }
  return parseEventLive(text, loadJson<{ mode?: string; funder?: string }>("live.json", {}));
}

/** Why a real order must not go out, or null when every guard passes. Pure: the caller supplies the rows and the clock. */
export function eventLiveBlock(cfg: EventLiveConfig, group: string, rule: string, marketId: string, ask: number, depth: number, fillable: boolean, rows: EventLiveRow[], now: number): string | null {
  const g = cfg.groups[group];
  if (!g || !g.rules.includes(rule)) return "rule not live";
  if (cfg.mode !== "live") return `mode ${cfg.mode}`;
  if (!fillable) return "paper trade not fully fillable";
  if (!(ask > 0) || ask > g.maxAsk + 1e-9) return `ask ${Math.round(ask * 100)}c over the ${Math.round(g.maxAsk * 100)}c limit`;
  if (depth < g.minDepth - 1e-9) return `only $${depth.toFixed(0)} within 2c of the ask (needs $${g.minDepth})`;
  const mine = rows.filter((r) => r.group === group && (r.shares > 0 || !r.ok));
  if (mine.some((r) => r.marketId === marketId)) return "already bet on this match";
  // One real bet per market across ALL groups (12 Nov 2026: a copied tennis wallet and the tennis rule could otherwise
  // both bet the same match, even on opposite sides).
  if (rows.some((r) => r.marketId === marketId && r.group !== group && (r.shares > 0 || r.status === "unknown"))) return "another real test already bet on this market";
  // A row whose order outcome is unknown (ok false, no shares, status "unknown") is held as open so a fault cannot loop.
  const open = mine.filter((r) => r.pnl == null && (r.shares > 0 || r.status === "unknown"));
  if (open.length >= g.maxOpen) return `${open.length} real bets open (max ${g.maxOpen})`;
  const settled = mine.filter((r) => r.pnl != null);
  const net = settled.reduce((s, r) => s + (r.pnl ?? 0), 0);
  // The group's own budget (10 Nov 2026, enrique: "tennis should have its own little budget"): money lost so far plus
  // every open stake plus this bet must fit inside maxLoss. Wins do not raise the budget.
  const lost = Math.max(0, -net);
  const staked = open.reduce((s, r) => s + r.cost, 0);
  if (lost + staked + g.size > g.maxLoss + 1e-9) return lost >= g.maxLoss - 1e-9 ? `budget used up: $${lost.toFixed(2)} lost of $${g.maxLoss}` : `budget: $${lost.toFixed(2)} lost + $${staked.toFixed(2)} open + $${g.size} would pass $${g.maxLoss}`;
  const today = kstDay(now);
  const lostToday = settled.filter((r) => r.won === false && kstDay(r.settledAt ?? r.t) === today).length;
  if (lostToday >= g.dayLosses) return `${lostToday} losses today: stopped until the next KST day`;
  return null;
}

export function eventLiveRows(): EventLiveRow[] {
  const rows = loadJson<EventLiveRow[]>(EVENT_LIVE_FILE, []);
  return Array.isArray(rows) ? rows : [];
}

let client: ClobClient | null = null;
const timed = <T>(p: Promise<T>, what: string, ms = 20_000) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`${what} timed out`)), ms).unref())]);
export async function getClient(funder: string): Promise<ClobClient> {
  if (client) return client;
  const keys = loadJson<{ wallet?: string }>("polygon-keys.json", {});
  const pk = String(keys.wallet ?? "").trim();
  if (!pk) throw new Error("no wallet key");
  const signer = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
  const base = new ClobClient({ host: HOST, chain: Chain.POLYGON, signer, signatureType: 3, funderAddress: funder });
  const creds = await timed(base.createOrDeriveApiKey(), "deriving the API key");
  client = new ClobClient({ host: HOST, chain: Chain.POLYGON, signer, creds, signatureType: 3, funderAddress: funder });
  return client;
}

let busy = false;
/**
 * A stop is coming (the bot restarts after every update): no new real order is started, and one that is being sent
 * is finished first, see the SIGTERM handler in src/eventpaper.ts. Not kept on disk: the next start trades again.
 */
let stopping = false;
export const eventLiveStop = () => void (stopping = true);
/** A real order is being sent right now. */
export const eventLiveBusy = () => busy;
/** For tests only. */
export const _eventLiveTest = { busy: (b: boolean) => void (busy = b), reset: () => void ((busy = false), (stopping = false)) };
/**
 * Copy one paper trade with real money if the guards allow. Returns a short text for the log: what was bought or why not.
 * Never throws. `conditionId` and `negRisk` come from the caller's Gamma lookup of the market.
 */
export async function eventLiveBuy(group: string, p: { rule: string; marketId: string; title: string; outcome: string; idx: number; token: string; ask: number; depth: number; fillable: boolean; feeRate: number; conditionId: string | null; negRisk: boolean }): Promise<string | null> {
  const cfg = eventLiveConfig();
  if (!cfg.groups[group]?.rules.includes(p.rule)) return null;
  if (stopping) return "restart pending: no new real order";
  if (busy) return "another real order is in flight";
  busy = true;
  try {
    const g = cfg.groups[group];
    const rows = eventLiveRows();
    const why = eventLiveBlock(cfg, group, p.rule, p.marketId, p.ask, p.depth, p.fillable, rows, Date.now());
    if (why) return why;
    if (p.negRisk) return "neg-risk market (claims not supported)";
    if (!p.conditionId) return "no condition id";
    const funder = String(loadJson<{ funder?: string }>("live.json", {}).funder ?? "").trim();
    const c = await getClient(funder);
    const bal = Number((await timed(c.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }), "reading the balance")).balance) / 1e6;
    if (!Number.isFinite(bal)) return "balance unknown";
    if (bal - g.size < cfg.minBalance) return `wallet $${bal.toFixed(2)} would fall under the $${cfg.minBalance} floor`;
    const [tickSize, negRisk] = await timed(Promise.all([c.getTickSize(p.token), c.getNegRisk(p.token)]), "reading the market");
    if (negRisk) return "neg-risk market (claims not supported)";
    const order = await timed(c.createMarketOrder({ tokenID: p.token, amount: g.size, side: Side.BUY, price: p.ask, orderType: OrderType.FAK }, { tickSize, negRisk: false }), "signing the order");
    const row: EventLiveRow = { t: Date.now(), group, rule: p.rule, marketId: p.marketId, conditionId: p.conditionId, title: p.title, outcome: p.outcome, idx: p.idx, ask: p.ask, size: g.size, cost: g.size, shares: 0, fee: 0, ok: false, status: "unknown", error: null };
    if (stopping) return "restart pending: order not sent";
    // Written BEFORE the order is sent, as an open bet of unknown outcome: if the process dies or the reply is lost, the
    // slot and the cap stay held instead of the order being repeated.
    rows.push(row);
    saveJson(EVENT_LIVE_FILE, rows);
    try {
      const res = await timed(c.postOrder(order, OrderType.FAK), "sending the order", 30_000);
      row.ok = Boolean(res?.success);
      row.status = res?.status ?? null;
      const detail = (res as unknown as { error?: unknown })?.error;
      row.error = res?.success ? null : String(res?.errorMsg || (detail ? JSON.stringify(detail).slice(0, 200) : "order rejected"));
      row.cost = Number(res?.makingAmount) || 0;
      row.shares = Number(res?.takingAmount) || 0;
      const px = row.shares > 0 ? row.cost / row.shares : 0;
      row.fee = row.shares > 0 ? Math.round(p.feeRate * row.shares * px * (1 - px) * 1e6) / 1e6 : 0;
      // A clean reply with no fill is a finished row (nothing bought): it frees the slot but keeps the match marked.
      if (!(row.shares > 0)) {
        row.pnl = 0;
        row.won = null;
        row.settledAt = Date.now();
        row.status = row.status ?? "no fill";
      }
    } catch (e) {
      row.error = e instanceof Error ? e.message : String(e);
      row.cost = g.size;
    }
    saveJson(EVENT_LIVE_FILE, rows);
    return row.shares > 0 ? `REAL bought ${row.shares.toFixed(2)} for $${row.cost.toFixed(2)} (${Math.round((row.cost / row.shares) * 1000) / 10}c)` : `REAL order not filled (${row.error ?? row.status ?? "no fill"})`;
  } catch (e) {
    return `REAL order not sent (${e instanceof Error ? e.message : String(e)})`;
  } finally {
    busy = false;
  }
}

/** Settle real rows from a closed market's payout per share (1, 0 or 0.5). Returns how many rows changed. */
export function eventLiveSettle(marketId: string, pays: number[]): number {
  const rows = eventLiveRows();
  let n = 0;
  for (const r of rows) {
    if (r.marketId !== marketId || r.pnl != null) continue;
    const pay = pays[r.idx];
    if (!(pay === 1 || pay === 0 || pay === 0.5)) continue;
    // An order whose reply was lost has no known fill: it settles at $0 here and stays visible as status "unknown".
    r.pay = pay;
    r.won = r.shares > 0 ? (pay === 1 ? true : pay === 0 ? false : null) : null;
    r.pnl = r.shares > 0 ? r.shares * pay - r.cost - r.fee : 0;
    r.settledAt = Date.now();
    n++;
  }
  if (n) saveJson(EVENT_LIVE_FILE, rows);
  return n;
}

/** Public summary for the status file: no order ids, tokens or addresses. */
export function eventLiveSummary(group: string) {
  const cfg = eventLiveConfig();
  const g = cfg.groups[group];
  const rows = eventLiveRows().filter((r) => r.group === group);
  const filled = rows.filter((r) => r.shares > 0);
  const settled = filled.filter((r) => r.pnl != null);
  const today = kstDay(Date.now());
  return {
    on: Boolean(g) && cfg.mode === "live",
    rules: g?.rules ?? [],
    size: g?.size ?? null,
    trades: filled.length,
    settled: settled.length,
    won: settled.filter((r) => r.won === true).length,
    net: Math.round(settled.reduce((s, r) => s + (r.pnl ?? 0), 0) * 100) / 100,
    todayNet: Math.round(settled.filter((r) => kstDay(r.settledAt ?? r.t) === today).reduce((s, r) => s + (r.pnl ?? 0), 0) * 100) / 100,
    open: filled.filter((r) => r.pnl == null).length,
    unknown: rows.filter((r) => r.status === "unknown" && r.pnl == null && !(r.shares > 0)).length,
    recent: rows.slice(-20).reverse().map((r) => ({ t: r.t, rule: r.rule, title: r.title, outcome: r.outcome, ask: r.ask, cost: r.cost, shares: r.shares, status: r.shares > 0 ? "filled" : r.status, error: r.error, won: r.won ?? null, pnl: r.pnl ?? null })),
  };
}
