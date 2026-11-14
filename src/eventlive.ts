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
 *   size       dollars per bet (the smallest bet when the caller sizes it)
 *   maxSize    largest bet when the caller sizes it (13 Nov 2026 copy sizing; never above MAX_STAKE = $10)
 *   maxDays    no bet on a market that resolves more than this many days ahead (0 = no limit; 13 Nov 2026, enrique:
 *              "make sure we dont enter anything that takes more than 2 weeks to resolve")
 *   stopNet    stop for good once the settled net result is this many dollars down or worse (0 = off; open bets
 *              still settle; 13 Nov 2026, enrique: "okay if tennis goes -10 then stop it")
 *   openUsd    dollars that may sit in open bets of the group at once (0 = off). A stake cap, not a trade-count cap:
 *              14 Nov 2026, enrique: "i want way more bets in general" with the whole wallet as budget, so the copies
 *              cannot tie up all the cash and starve tennis.
 *   walletUsd  dollars that may sit in open bets of ONE rule (one copied wallet) at once (0 = off)
 *   adaptN     per-rule automatic rule (14 Nov 2026 11:48 KST, enrique: "yeah that rule sounds alright"): once a rule
 *   adaptStop  (one copied wallet) has adaptN settled real bets, it goes back to paper when its settled result is
 *   adaptBoost adaptStop dollars down or worse, and its stake is multiplied by adaptBoost (still inside size..maxSize)
 *              while it is ahead. 0 / 1 = off. See ruleAdapt().
 *   perWallet  copies only: real bets open at once per copied wallet (0 = no own limit)
 *   maxAsk     no order when the favourite asks more than this
 *   minDepth   dollars that must rest within 2c of the ask (the paper "fillable" test)
 *   dayLosses  after this many settled losses in one KST day the group stops until the next KST day
 *   maxOpen    unsettled real bets allowed at once
 *   negRisk    true lets the group also bet grouped ("neg-risk") markets such as weather buckets (12 Nov 2026); see
 *              negRiskBlock() for the extra guards
 *   maxLoss    the group's own BUDGET: dollars lost so far + open stakes + the new bet must stay inside it; once it is
 *              lost the group stops until enrique or a review gives it more. Separate from the crypto "lossCap".
 *
 * Also in force: the global "mode" (repo and the server's local kill switch) and the wallet floor "minBalance".
 * Orders are fill-and-kill buys limited to the ask the paper rule saw, except the resting bids of eventRestBid (14 Nov 2026).
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
  /** Grouped ("neg-risk") market: claimed through Polymarket's neg-risk adapter (src/live.ts redeemEvents). */
  negRisk?: boolean;
  /** The outcome token bought; kept so the claim can be checked on chain. Never in the status file. */
  token?: string;
  /** Resting bid (status "resting" while on the book): order id and the time it is cancelled. Never in the status file. */
  orderId?: string;
  until?: number;
};
/** A row that holds a slot and money: filled, outcome unknown, or a bid still resting on the book. */
const held = (r: EventLiveRow) => r.shares > 0 || r.status === "unknown" || r.status === "resting";
export type EventLiveGroup = { rules: string[]; size: number; maxAsk: number; minDepth: number; dayLosses: number; maxOpen: number; maxLoss: number; negRisk: boolean; maxSize: number; maxDays: number; perWallet: number; stopNet: number; openUsd: number; walletUsd: number; adaptN: number; adaptStop: number; adaptBoost: number };
export type EventLiveConfig = { mode: string; minBalance: number; lossCap?: LossCap; groups: Record<string, EventLiveGroup> };

/** No single real event bet is ever larger than this (13 Nov 2026, enrique: "Min $3 max $10"). */
export const MAX_STAKE = 10;
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
    const size = Math.min(MAX_STAKE, num(v.size, 0));
    if (!rules.length || !(size >= 1)) continue;
    const maxSize = Math.min(MAX_STAKE, Math.max(size, num(v.maxSize, size)));
    groups[g] = { rules, size, maxAsk: Math.min(0.99, num(v.maxAsk, 0.96)), minDepth: Math.max(0, num(v.minDepth, 25)), dayLosses: Math.max(1, Math.floor(num(v.dayLosses, 2))), maxOpen: Math.max(1, Math.floor(num(v.maxOpen, 4))), maxLoss: Math.max(0, num(v.maxLoss, 12)), negRisk: v.negRisk === true, maxSize, maxDays: Math.max(0, num(v.maxDays, 0)), perWallet: Math.max(0, Math.floor(num(v.perWallet, 0))), stopNet: Math.max(0, num(v.stopNet, 0)), openUsd: Math.max(0, num(v.openUsd, 0)), walletUsd: Math.max(0, num(v.walletUsd, 0)), adaptN: Math.max(0, Math.floor(num(v.adaptN, 0))), adaptStop: Math.max(0, num(v.adaptStop, 0)), adaptBoost: Math.min(3, Math.max(1, num(v.adaptBoost, 1))) };
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
export function eventLiveBlock(cfg: EventLiveConfig, group: string, rule: string, marketId: string, ask: number, depth: number, fillable: boolean, rows: EventLiveRow[], now: number, stake?: number, resolveAt?: number, side?: number): string | null {
  const g = cfg.groups[group];
  if (!g || !g.rules.includes(rule)) return "rule not live";
  if (cfg.mode !== "live") return `mode ${cfg.mode}`;
  if (!fillable) return "paper trade not fully fillable";
  if (!(ask > 0) || ask > g.maxAsk + 1e-9) return `ask ${Math.round(ask * 100)}c over the ${Math.round(g.maxAsk * 100)}c limit`;
  const bet = stake ?? g.size;
  if (g.maxDays > 0) {
    if (!(resolveAt != null && Number.isFinite(resolveAt))) return "resolve date unknown";
    const days = (resolveAt - now) / 86400_000;
    if (days > g.maxDays) return `resolves in ${Math.round(days)} days (limit ${g.maxDays})`;
  }
  if (depth < g.minDepth - 1e-9) return `only $${depth.toFixed(0)} within 2c of the ask (needs $${g.minDepth})`;
  const mine = rows.filter((r) => r.group === group && (r.shares > 0 || !r.ok || r.status === "resting"));
  // A resting-bid rule bids on both players of a match: then one bet per player (side), not per match.
  if (mine.some((r) => r.marketId === marketId && (side == null || r.idx === side))) return "already bet on this match";
  // One real bet per market across ALL groups (12 Nov 2026: a copied tennis wallet and the tennis rule could otherwise
  // both bet the same match, even on opposite sides).
  if (rows.some((r) => r.marketId === marketId && r.group !== group && held(r))) return "another real test already bet on this market";
  // A row whose order outcome is unknown (ok false, no shares, status "unknown") is held as open so a fault cannot loop.
  const open = mine.filter((r) => r.pnl == null && held(r));
  if (open.length >= g.maxOpen) return `${open.length} real bets open (max ${g.maxOpen})`;
  const openUsd = open.reduce((s, r) => s + r.cost, 0);
  if (g.openUsd > 0 && openUsd + bet > g.openUsd + 1e-9) return `$${openUsd.toFixed(2)} in open bets + $${bet.toFixed(2)} would pass the $${g.openUsd} stake cap`;
  const ruleUsd = open.filter((r) => r.rule === rule).reduce((s, r) => s + r.cost, 0);
  if (g.walletUsd > 0 && ruleUsd + bet > g.walletUsd + 1e-9) return `$${ruleUsd.toFixed(2)} open on this wallet + $${bet.toFixed(2)} would pass its $${g.walletUsd} stake cap`;
  const ad = ruleAdapt(g, rows.filter((r) => r.group === group), rule);
  if (ad.state === "paper") return `back to paper: $${ad.net.toFixed(2)} on its first ${ad.n}+ settled real bets`;
  const settled = mine.filter((r) => r.pnl != null);
  const net = settled.reduce((s, r) => s + (r.pnl ?? 0), 0);
  // The group's own budget (10 Nov 2026, enrique: "tennis should have its own little budget"): money lost so far plus
  // every open stake plus this bet must fit inside maxLoss. Wins do not raise the budget.
  if (g.stopNet > 0 && net <= -g.stopNet + 1e-9) return `stopped for good: settled $${net.toFixed(2)} (stop at -$${g.stopNet})`;
  const lost = Math.max(0, -net);
  const staked = open.reduce((s, r) => s + r.cost, 0);
  if (lost + staked + bet > g.maxLoss + 1e-9) return lost >= g.maxLoss - 1e-9 ? `budget used up: $${lost.toFixed(2)} lost of $${g.maxLoss}` : `budget: $${lost.toFixed(2)} lost + $${staked.toFixed(2)} open + $${bet.toFixed(2)} would pass $${g.maxLoss}`;
  const today = kstDay(now);
  const lostToday = settled.filter((r) => r.won === false && kstDay(r.settledAt ?? r.t) === today).length;
  if (lostToday >= g.dayLosses) return `${lostToday} losses today: stopped until the next KST day`;
  return null;
}

/**
 * The automatic per-rule rule (see adaptN): "learning" until adaptN settled real bets with shares, then "paper" when the
 * settled result is adaptStop dollars down or worse (for good, until a review or enrique says otherwise), "up" while
 * it is ahead (stake x adaptBoost), else "flat". Pure.
 */
export function ruleAdapt(g: EventLiveGroup, rows: EventLiveRow[], rule: string): { state: "off" | "learning" | "up" | "flat" | "paper"; n: number; net: number } {
  const s = rows.filter((r) => r.rule === rule && r.shares > 0 && r.pnl != null);
  const net = Math.round(s.reduce((a, r) => a + (r.pnl ?? 0), 0) * 100) / 100;
  if (!(g.adaptN > 0)) return { state: "off", n: s.length, net };
  if (s.length < g.adaptN) return { state: "learning", n: s.length, net };
  if (g.adaptStop > 0 && net <= -g.adaptStop + 1e-9) return { state: "paper", n: s.length, net };
  return { state: net > 0 ? "up" : "flat", n: s.length, net };
}
/** Status: every rule of the group with its automatic state (no ids, tokens or addresses). */
export function eventLiveAdapt(group: string) {
  const g = eventLiveConfig().groups[group];
  if (!g || !(g.adaptN > 0)) return null;
  const rows = eventLiveRows().filter((r) => r.group === group);
  return { n: g.adaptN, stop: g.adaptStop, boost: g.adaptBoost, rules: g.rules.map((rule) => ({ rule, ...ruleAdapt(g, rows, rule) })) };
}

export const NEG_READY_FILE = "negrisk-ready.json";
/** Written by src/live.ts negRiskSetup(): whether the wallet holds every permission grouped markets need. */
export type NegRiskReady = { at?: number; ready?: boolean; missing?: string[]; tries?: number; lastTryAt?: number; error?: string | null };
type NegClaims = Record<string, { tx?: string | null; negRisk?: boolean }>;
/**
 * Grouped-market bets allowed before the first claim of one has been confirmed on chain (0 = no limit). 2 from
 * 12 Nov 2026; 0 since 14 Nov 2026 01:25 KST, enrique: "u are copying a guy tht does 100 bets a day on weather and is
 * profitable. u copy two random trades of 100 and are waitin for a win". A failed claim shows as claimErrors in status.
 */
export const NEG_TRIAL = 0;
/**
 * Extra guards for a grouped ("neg-risk") market, or null when the bet may go (12 Nov 2026, enrique: "we cant claim
 * weather buys so we are not trading"). The group must allow it, the wallet's permissions must have been checked on
 * chain, and until one claim of such a bet is confirmed at most NEG_TRIAL of them may be open or won and unclaimed:
 * the claim path could only be tested with a real win.
 */
export function negRiskBlock(g: EventLiveGroup, ready: NegRiskReady, rows: EventLiveRow[], claims: NegClaims): string | null {
  if (!g.negRisk) return "neg-risk market (not switched on for this test)";
  if (!ready.ready) return `grouped market: wallet permissions not ready${ready.error ? ` (${ready.error.slice(0, 60)})` : ""}`;
  if (Object.values(claims).some((d) => d?.negRisk && d.tx)) return null;
  const pending = rows.filter((r) => r.negRisk && (r.shares > 0 || r.status === "unknown") && (r.pnl == null || ((r.pay ?? 0) > 0 && !claims[r.conditionId ?? ""]?.tx))).length;
  return NEG_TRIAL > 0 && pending >= NEG_TRIAL ? `grouped market test: ${pending} bets until the first claim is confirmed` : null;
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
export async function eventLiveBuy(group: string, p: { rule: string; marketId: string; title: string; outcome: string; idx: number; token: string; ask: number; depth: number; fillable: boolean; feeRate: number; conditionId: string | null; negRisk?: boolean; stake?: number; resolveAt?: number }): Promise<string | null> {
  const cfg = eventLiveConfig();
  if (!cfg.groups[group]?.rules.includes(p.rule)) return null;
  if (stopping) return "restart pending: no new real order";
  if (busy) return "another real order is in flight";
  busy = true;
  try {
    const g = cfg.groups[group];
    // A caller-sized bet (wallet copies, 13 Nov 2026) stays between the group's size and maxSize, in whole cents.
    const rows = eventLiveRows();
    const boost = ruleAdapt(g, rows.filter((r) => r.group === group), p.rule).state === "up" ? g.adaptBoost : 1;
    const want = (p.stake ?? g.size) * boost;
    const stake = p.stake == null && boost === 1 ? g.size : Math.round(Math.min(g.maxSize, Math.max(g.size, want)) * 100) / 100;
    const why = eventLiveBlock(cfg, group, p.rule, p.marketId, p.ask, p.depth, p.fillable, rows, Date.now(), stake, p.resolveAt);
    if (why) return why;
    if (!p.conditionId) return "no condition id";
    // The bot claims through the conditional-token contract and its adapters only; newer markets with a 31-byte id
    // are claimed another way that is not built.
    if (!/^0x[0-9a-fA-F]{64}$/.test(p.conditionId)) return "market type the bot cannot claim";
    const funder = String(loadJson<{ funder?: string }>("live.json", {}).funder ?? "").trim();
    const c = await getClient(funder);
    const bal = Number((await timed(c.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }), "reading the balance")).balance) / 1e6;
    if (!Number.isFinite(bal)) return "balance unknown";
    if (bal - stake < cfg.minBalance) return `wallet $${bal.toFixed(2)} would fall under the $${cfg.minBalance} floor`;
    const [tickSize, negRisk] = await timed(Promise.all([c.getTickSize(p.token), c.getNegRisk(p.token)]), "reading the market");
    const neg = Boolean(negRisk);
    if (neg) {
      const no = negRiskBlock(g, loadJson<NegRiskReady>(NEG_READY_FILE, {}), rows, loadJson<NegClaims>("eventlive-claims.json", {}));
      if (no) return no;
    }
    const order = await timed(c.createMarketOrder({ tokenID: p.token, amount: stake, side: Side.BUY, price: p.ask, orderType: OrderType.FAK }, { tickSize, negRisk: neg }), "signing the order");
    const row: EventLiveRow = { t: Date.now(), group, rule: p.rule, marketId: p.marketId, conditionId: p.conditionId, title: p.title, outcome: p.outcome, idx: p.idx, ask: p.ask, size: stake, cost: stake, shares: 0, fee: 0, ok: false, status: "unknown", error: null, token: p.token, ...(neg ? { negRisk: true } : {}) };
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
      row.cost = stake;
    }
    saveJson(EVENT_LIVE_FILE, rows);
    return row.shares > 0 ? `REAL bought ${row.shares.toFixed(2)} for $${row.cost.toFixed(2)} (${Math.round((row.cost / row.shares) * 1000) / 10}c)` : `REAL order not filled (${row.error ?? row.status ?? "no fill"})`;
  } catch (e) {
    return `REAL order not sent (${e instanceof Error ? e.message : String(e)})`;
  } finally {
    busy = false;
  }
}

/**
 * Resting bids (14 Nov 2026 01:26 KST, enrique: more real bets "on anything that might be good and looks good on past
 * data and paper"; the only paper rule over the bar is prematch-rest-clv-tennis). A post-only GTC buy at `price` for
 * `stake` dollars (at least the exchange's 5-share minimum), cancelled at `until`. Same guards as eventLiveBuy; the
 * row is written before the order is sent and holds its money in the group's caps while it rests.
 */
export const REST_MIN_SHARES = 5;
export function restShares(stake: number, price: number): number {
  return Math.max(REST_MIN_SHARES, Math.floor((stake / price) * 100) / 100);
}
export async function eventRestBid(group: string, p: { rule: string; marketId: string; title: string; outcome: string; idx: number; token: string; price: number; conditionId: string | null; until: number; resolveAt?: number }): Promise<string | null> {
  const cfg = eventLiveConfig();
  if (!cfg.groups[group]?.rules.includes(p.rule)) return null;
  if (stopping) return "restart pending: no new real order";
  if (busy) return "another real order is in flight";
  busy = true;
  try {
    const g = cfg.groups[group];
    const shares = restShares(g.size, p.price);
    const stake = Math.round(shares * p.price * 100) / 100;
    if (stake > g.maxSize + 1e-9) return `5-share minimum costs $${stake.toFixed(2)} (over $${g.maxSize})`;
    const rows = eventLiveRows();
    const why = eventLiveBlock(cfg, group, p.rule, p.marketId, p.price, Infinity, true, rows, Date.now(), stake, p.resolveAt, p.idx);
    if (why) return why;
    if (!p.conditionId || !/^0x[0-9a-fA-F]{64}$/.test(p.conditionId)) return "market type the bot cannot claim";
    if (Date.now() > p.until - 5 * 60_000) return "too close to the start";
    const funder = String(loadJson<{ funder?: string }>("live.json", {}).funder ?? "").trim();
    const c = await getClient(funder);
    const bal = Number((await timed(c.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }), "reading the balance")).balance) / 1e6;
    if (!Number.isFinite(bal)) return "balance unknown";
    if (bal - stake < cfg.minBalance) return `wallet $${bal.toFixed(2)} would fall under the $${cfg.minBalance} floor`;
    const [tickSize, negRisk] = await timed(Promise.all([c.getTickSize(p.token), c.getNegRisk(p.token)]), "reading the market");
    const neg = Boolean(negRisk);
    if (neg) {
      const no = negRiskBlock(g, loadJson<NegRiskReady>(NEG_READY_FILE, {}), rows, loadJson<NegClaims>("eventlive-claims.json", {}));
      if (no) return no;
    }
    const order = await timed(c.createOrder({ tokenID: p.token, price: p.price, side: Side.BUY, size: shares }, { tickSize, negRisk: neg }), "signing the order");
    const row: EventLiveRow = { t: Date.now(), group, rule: p.rule, marketId: p.marketId, conditionId: p.conditionId, title: p.title, outcome: p.outcome, idx: p.idx, ask: p.price, size: stake, cost: stake, shares: 0, fee: 0, ok: false, status: "unknown", error: null, token: p.token, until: p.until, ...(neg ? { negRisk: true } : {}) };
    if (stopping) return "restart pending: order not sent";
    rows.push(row);
    saveJson(EVENT_LIVE_FILE, rows);
    try {
      const res = await timed(c.postOrder(order, OrderType.GTC, true), "sending the order", 30_000);
      if (res?.success && res.orderID) {
        row.ok = true;
        row.status = "resting";
        row.orderId = res.orderID;
      } else {
        // A clean refusal (post-only would have taken, too small, ...): nothing rests, the row is finished.
        row.error = String(res?.errorMsg || "order rejected").slice(0, 200);
        row.status = "not placed";
        row.cost = 0;
        row.pnl = 0;
        row.won = null;
        row.settledAt = Date.now();
      }
    } catch (e) {
      // No clean answer: the order may exist without its id. Cancel every order of ours on this token.
      row.error = e instanceof Error ? e.message : String(e);
      await c.cancelMarketOrders({ asset_id: p.token }).catch(() => undefined);
    }
    saveJson(EVENT_LIVE_FILE, rows);
    return row.status === "resting" ? `REAL bid resting: ${shares} at ${Math.round(p.price * 1000) / 10}c ($${stake.toFixed(2)})` : `REAL bid not placed (${row.error ?? row.status})`;
  } catch (e) {
    return `REAL bid not sent (${e instanceof Error ? e.message : String(e)})`;
  } finally {
    busy = false;
  }
}
/**
 * Read every resting bid from the exchange: book fills, cancel those past their time, and finish a row once its
 * order is done (no fill = finished at $0). Also cancels, by token, any row whose placement had no clean answer.
 * Returns log lines.
 */
export async function eventRestSync(now = Date.now()): Promise<string[]> {
  const rows = eventLiveRows();
  const live = rows.filter((r) => r.pnl == null && r.until != null && (r.status === "resting" || (r.status === "unknown" && !(r.shares > 0))));
  if (!live.length || busy) return [];
  busy = true;
  const out: string[] = [];
  try {
    const funder = String(loadJson<{ funder?: string }>("live.json", {}).funder ?? "").trim();
    const c = await getClient(funder);
    for (const r of live) {
      try {
        if (r.status === "unknown") {
          // Placement with no clean answer: make sure nothing of ours rests on that token, then finish the row.
          if (r.token) await timed(c.cancelMarketOrders({ asset_id: r.token }), "cancelling");
          r.status = "no fill";
          r.cost = 0;
          r.pnl = 0;
          r.won = null;
          r.settledAt = now;
          out.push(`${r.rule} ${r.title} ${r.outcome}: unknown placement cancelled`);
          continue;
        }
        const late = now >= (r.until ?? 0);
        if (late) await timed(c.cancelOrder({ orderID: r.orderId! }), "cancelling");
        const got = await timed(c.getOrder(r.orderId!), "reading the order");
        const matched = Number(got?.size_matched) || 0;
        const price = Number(got?.price) || r.ask;
        if (matched > r.shares + 1e-9) out.push(`${r.rule} ${r.title} ${r.outcome}: REAL bid filled ${matched.toFixed(2)} at ${Math.round(price * 1000) / 10}c`);
        r.shares = matched;
        const status = String(got?.status ?? "").toUpperCase();
        const done = late || /MATCHED|CANCEL/.test(status) || matched >= Number(got?.original_size ?? Infinity) - 1e-6;
        if (!done) continue;
        r.status = matched > 0 ? "matched" : "no fill";
        r.cost = Math.round(matched * price * 1e6) / 1e6;
        if (!(matched > 0)) {
          r.pnl = 0;
          r.won = null;
          r.settledAt = now;
        }
      } catch (e) {
        out.push(`${r.rule} ${r.title}: resting bid read failed (${(e as Error).message.slice(0, 80)})`);
      }
    }
    saveJson(EVENT_LIVE_FILE, rows);
  } finally {
    busy = false;
  }
  return out;
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
    resting: rows.filter((r) => r.pnl == null && r.status === "resting").length,
    unknown: rows.filter((r) => r.status === "unknown" && r.pnl == null && !(r.shares > 0)).length,
    recent: rows.slice(-20).reverse().map((r) => ({ t: r.t, rule: r.rule, title: r.title, outcome: r.outcome, ask: r.ask, cost: r.cost, shares: r.shares, status: r.shares > 0 ? "filled" : r.status, error: r.error, won: r.won ?? null, pnl: r.pnl ?? null })),
  };
}
