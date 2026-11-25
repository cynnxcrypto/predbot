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
 *   maxAbove   copy group: no real copy when the ask is more than this above the price the copied wallet paid (0 = off)
 *   autoReal   copy group: false keeps the daily rescan's wallets on paper (no promotion, the real ones go back)
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
import { copyProven } from "./copyskill.js";
import { provenCut } from "./hyperliquid/skill.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "@ethersproject/wallet";
import { AssetType, Chain, ClobClient, OrderType, Side } from "@polymarket/clob-client-v2";
import { ROOT, kstDay } from "./config.js";
import type { LossCap } from "./live.js";
import { autoRealRules } from "./copyscan.js";
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
  /** A "delayed" row that was closed as not filled before 15 Nov 2026 and has been checked against our trades since. */
  rechecked?: boolean;
};
/** A row that holds a slot and money: filled, outcome unknown, or a bid still resting on the book. */
/** Dollars really paid for a row. A resting bid keeps its whole stake in `cost` (the stake cap reserves it, as
 *  Polymarket does) until it is finished; only the filled shares are paid for. */
export const spentOf = (r: { status: string | null; shares: number; ask: number; cost: number }) => (r.status === "resting" ? Math.round(r.shares * r.ask * 1e6) / 1e6 : r.cost);
const held = (r: EventLiveRow) => r.shares > 0 || r.status === "unknown" || r.status === "resting" || (r.status === "delayed" && r.pnl == null);
export type EventLiveGroup = { rules: string[]; size: number; maxAsk: number; minDepth: number; dayLosses: number; maxOpen: number; maxLoss: number; negRisk: boolean; maxSize: number; maxDays: number; perWallet: number; stopNet: number; openUsd: number; walletUsd: number; adaptN: number; adaptStop: number; adaptBoost: number; steps: "" | "wallet" | "rule"; cutN: number; cutLoss: number; recentN: number; recentLoss: number; probationN: number; houseUsd: number; ladder: [number, number, number][]; maxAbove?: number; autoReal?: boolean; aheadSize?: number; houseBets?: number; noCrypto?: boolean; provenT?: number; stopNew?: boolean };
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
    groups[g] = { rules, size, maxAsk: Math.min(0.99, num(v.maxAsk, 0.96)), minDepth: Math.max(0, num(v.minDepth, 25)), dayLosses: Math.max(1, Math.floor(num(v.dayLosses, 2))), maxOpen: Math.max(1, Math.floor(num(v.maxOpen, 4))), maxLoss: Math.max(0, num(v.maxLoss, 12)), negRisk: v.negRisk === true, maxSize, maxDays: Math.max(0, num(v.maxDays, 0)), perWallet: Math.max(0, Math.floor(num(v.perWallet, 0))), stopNet: Math.max(0, num(v.stopNet, 0)), openUsd: Math.max(0, num(v.openUsd, 0)), walletUsd: Math.max(0, num(v.walletUsd, 0)), adaptN: Math.max(0, Math.floor(num(v.adaptN, 0))), adaptStop: Math.max(0, num(v.adaptStop, 0)), adaptBoost: Math.min(3, Math.max(1, num(v.adaptBoost, 1))), steps: v.steps === "wallet" || v.steps === "rule" ? v.steps : "", cutN: Math.max(0, Math.floor(num(v.cutN, 0))), cutLoss: Math.max(0, num(v.cutLoss, 0)), recentN: Math.max(0, Math.floor(num(v.recentN, 0))), recentLoss: Math.max(0, num(v.recentLoss, 0)), probationN: Math.max(0, Math.floor(num(v.probationN, 0))), houseUsd: Math.max(0, num(v.houseUsd, 0)), ladder: (Array.isArray(v.ladder) ? (v.ladder as unknown[]) : []).filter((x): x is number[] => Array.isArray(x) && x.length === 3 && x.every((y) => typeof y === "number" && Number.isFinite(y) && y >= 0)).map((x) => [Math.floor(x[0]), x[1], Math.min(MAX_STAKE, Math.max(size, x[2]))] as [number, number, number]), maxAbove: Math.min(0.5, Math.max(0, num(v.maxAbove, 0))), autoReal: v.autoReal !== false, aheadSize: Math.min(MAX_STAKE, Math.max(0, num(v.aheadSize, 0))), houseBets: Math.min(20, Math.max(0, num(v.houseBets, 0))), noCrypto: v.noCrypto === true, provenT: Math.min(10, Math.max(0, num(v.provenT, 0))), stopNew: v.stopNew === true };
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
  const cfg = parseEventLive(text, loadJson<{ mode?: string; funder?: string }>("live.json", {}));
  // wallets the daily rescan promoted to real (src/copyscan.ts, 14 Nov 2026) join the copy group's rules, unless the
  // live rules keep the rescan on paper (events.copy.autoReal false, review 63 of 16 Nov 2026)
  const copy = cfg.groups.copy;
  if (copy && copy.autoReal !== false) for (const r of autoRealRules()) if (!copy.rules.includes(r)) copy.rules.push(r);
  return cfg;
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
  // held(): a "delayed" order (taken, fill not yet confirmed) counts too, as its stake may already be spent (review of
  // 16 Nov 2026: a delayed copy escaped every cap and the one-bet-per-match check until the 10-minute sync)
  const mine = rows.filter((r) => r.group === group && (held(r) || !r.ok));
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
  // a stepped-up wallet may have four of its stakes open
  const walletCap = g.steps ? Math.max(g.walletUsd, 4 * bet) : g.walletUsd;
  if (g.walletUsd > 0 && ruleUsd + bet > walletCap + 1e-9) return `$${ruleUsd.toFixed(2)} open on this wallet + $${bet.toFixed(2)} would pass its $${g.walletUsd} stake cap`;
  // REAL OUTRANKS PAPER (enrique, 16 Nov 2026 11:04 KST: "real is more important", "why the fuck were u not looking at
  // real trades to decide if we should cut loser or not"). The rule's own settled real bets decide first: cut when
  // they say so (ruleAdapt), and a rule whose real bets are AHEAD is not held back by its paper record. Paper decides
  // only while the real record has nothing good to say (no real bets yet, or not ahead).
  const proven = group === "copy" && copyProven(rule, g.provenT ?? 0);
  const ad = ruleAdapt(g, rows.filter((r) => r.group === group), rule, proven);
  if (ad.state === "paper") return ad.recent != null ? `back to paper: $${ad.recent.toFixed(2)} on its last ${g.recentN} settled real bets` : `back to paper: $${ad.net.toFixed(2)} on its ${ad.n} settled real bets`;
  const pb = paperBehind.get(rule);
  if (group === "copy" && pb && !(ad.net > 0) && !proven) return `back to paper: its paper record (${pb}) is under the bar`;
  // WHAT A RULE MAY RISK (houseUsd): its open stakes may not pass houseUsd plus what its settled real bets have made
  // (less what they lost). A new wallet can so have houseUsd at risk and no more, a wallet that wins for us earns
  // more room with its own winnings (up to walletUsd), and no wallet can cost much more than houseUsd in all.
  const room = g.houseUsd > 0 ? riskRoom(g, realRecordOf(rows.filter((r) => r.group === group), rule)) : 0;
  if (g.houseUsd > 0 && ruleUsd + bet > room + 1e-9) return `$${ruleUsd.toFixed(2)} open on this wallet + $${bet.toFixed(2)} would pass what it may risk (${g.houseBets ? `$${room.toFixed(2)}: ${g.houseBets} bets` : `$${g.houseUsd}`} and its real result of $${ad.net.toFixed(2)})`;
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
 * KEEP ONLY WHAT STAYS GOOD (enrique, 15 Nov 2026 12:44 KST: "only doing real on the ones that are good and stay
 * good"). Every copied wallet of the live rules keeps its $3 paper twin running; once that paper record has
 * PAPER_GATE_N+ settled bets that could be filled and it is not ahead with half or more won, the wallet's NEW real
 * copies stop (open bets stay). It comes back by itself when the paper record meets the bar again. Under
 * PAPER_GATE_N the wallet is still being learned and stays real. Pure; the paper loop refreshes it every look.
 */
export const PAPER_GATE_N = 20;
export function paperGate(rules: string[], trades: { rule: string; pnl?: number | null; won?: boolean | null; fillable?: boolean }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of rules) {
    const s = trades.filter((t) => t.rule === rule && t.pnl != null && t.fillable !== false);
    const won = s.filter((t) => t.won === true).length;
    const net = s.reduce((a, t) => a + (t.pnl ?? 0), 0);
    if (s.length >= PAPER_GATE_N && !(won * 2 >= s.length && net > 0)) out.set(rule, `${won} of ${s.length} won, $${net.toFixed(2)}`);
  }
  return out;
}
let paperBehind = new Map<string, string>();
export const setPaperBehind = (m: Map<string, string>) => void (paperBehind = m);
/** Status: the copied wallets held on paper by their paper record (rule -> record). */
export const paperBehindStatus = () => {
  const rows = eventLiveRows().filter((r) => r.group === "copy");
  return Object.fromEntries([...paperBehind].filter(([rule]) => !(realRecordOf(rows, rule).net > 0)));
};
/**
 * SIZES THAT PROGRESS (enrique, 16 Nov 2026 11:20 KST: "how the fuck we bet 7.61 in a first bet of a first wallet
 * copy", "i thought we were doing like 3", "make it progress"). Every copied wallet starts at the base size and steps
 * up only on its OWN settled real bets. A `ladder` row is [bets, ahead, stake]: with `bets` or more settled real bets
 * that are `ahead` dollars or more in front, a bet is `stake` dollars. The highest row that holds decides, so the size
 * steps back down by itself the moment the real result falls under a row's line. The trader's own bet size no longer
 * sets ours. Each row's line is chosen so that three bets of its size fit in what the wallet may risk (houseUsd and
 * its real result). Pure.
 */
/**
 * What one copied wallet may have in open bets (enrique, 18 Nov 2026: the $9 room was "a huge blocker when we're
 * scaling up traders that seem good"): houseBets of its current bet size (at least houseUsd), plus its settled real
 * result; walletUsd stays the hard top. Without houseBets it is houseUsd plus the result, as before.
 */
export function riskRoom(g: EventLiveGroup, rec: { n: number; net: number; best?: number; last3?: number }): number {
  const base = g.houseBets ? Math.max(g.houseUsd, g.houseBets * (g.ladder.length ? ladderStake(g, rec) : g.size)) : g.houseUsd;
  const room = Math.max(0, base + rec.net);
  return g.walletUsd > 0 ? Math.min(room, g.walletUsd) : room;
}
export function ladderStake(g: EventLiveGroup, rec: { n: number; net: number; best?: number; last3?: number }): number {
  // smart, not blunt (enrique, 17 Nov 2026 15:16 KST: "we have to be smart about how we scale up and down"): the line is
  // met without its single best bet, so one lucky win never sizes it up, and its newest 3 bets behind take one row off
  const steady = rec.net - Math.max(0, rec.best ?? 0);
  const rows = g.ladder.filter(([bets, ahead]) => rec.n >= bets && rec.net >= ahead - 1e-9 && (rec.best == null || steady >= ahead - 1e-9)).map((x) => x[2]).sort((a, b) => a - b);
  if (rec.last3 != null && rec.n >= 3 && rec.last3 < 0) rows.pop();
  // a wallet ahead on its own settled real bets starts from aheadSize, not the base (enrique, 18 Nov 2026 09:55 KST:
  // "okay lets try 1" = base bet $3 -> $5 for wallets ahead on real money; the ladder still adds on top)
  const base = g.aheadSize && rec.n > 0 && rec.net > 0 ? Math.max(g.size, g.aheadSize) : g.size;
  return Math.max(base, ...rows);
}
/**
 * SIZE BY CONVICTION (enrique, 19 Nov 2026: "yeah build all 3", "this should be for any copytrading not just HL"): the
 * ladder's size moved along its own steps (base, aheadSize, the ladder's rows: $3/$5/$7/$10) by the wallet's bet against
 * its usual bet: under half one step down, twice or more one step up, four times or more two up (only for a wallet ahead
 * on 3+ settled real bets). Never under the base size, never past maxSize. Pure.
 */
export function convictionStake(g: EventLiveGroup, ladderUsd: number, ratio: number | null, rec: { n: number; net: number }): number {
  if (ratio == null || !Number.isFinite(ratio) || ratio <= 0) return ladderUsd;
  const steps = [...new Set([g.size, ...(g.aheadSize ? [g.aheadSize] : []), ...g.ladder.map((x) => x[2])])].filter((x) => x <= Math.max(g.maxSize, g.size)).sort((a, b) => a - b);
  let i = 0;
  for (let k = 0; k < steps.length; k++) if (steps[k] <= ladderUsd + 1e-9) i = k;
  const proven = rec.n >= 3 && rec.net > 0;
  const d = ratio < 0.5 ? -1 : ratio >= 4 && proven ? 2 : ratio >= 2 ? 1 : 0;
  if (!d) return ladderUsd;
  return Math.max(g.size, Math.min(Math.max(g.maxSize, g.size), steps[Math.max(0, Math.min(steps.length - 1, i + d))]));
}
/** A rule's own settled real bets: how many and what they made. Pure. */
export function realRecordOf(rows: EventLiveRow[], rule: string): { n: number; net: number; best: number; last3: number } {
  const s = rows.filter((r) => r.rule === rule && r.shares > 0 && r.pnl != null).sort((a, b) => (a.settledAt ?? a.t) - (b.settledAt ?? b.t));
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { n: s.length, net: r2(s.reduce((a, r) => a + (r.pnl ?? 0), 0)), best: r2(Math.max(0, ...s.map((r) => r.pnl ?? 0))), last3: r2(s.slice(-3).reduce((a, r) => a + (r.pnl ?? 0), 0)) };
}
/** The same from the real rows on disk, for one group. */
export const realRecord = (group: string, rule: string) => realRecordOf(eventLiveRows().filter((r) => r.group === group), rule);

/**
 * SIZE UP WHAT WORKS (enrique, 15 Nov 2026 17:40 KST: "when something actually works, remember to size up in a way
 * that makes sense"; 17:25: "if copying a trader consistently works, and that trader is using serious money himself,
 * he should size up"; plan agreed 17:52 "okay sounds good" / "lets get it all into the bot"). The step is read from
 * OUR OWN settled real bets of the rule, never from paper:
 *   "wallet" (a copied wallet): x2 at 20+ settled, half or more won, ahead; x3 at 50+ and $25+ ahead; x5 at 100+ and
 *            $75+ ahead. Above x2 only when the trader's usual bet is STEP_TRADER_USD or more.
 *   "rule"   (a rule of ours):  x5/3 at 50+ settled and ahead; x8/3 at 100+ and ahead ($3 -> $5 -> $8).
 * One step back down while its newest STEP_LAST settled bets are behind, or it has given back 5 of its stakes from
 * its best. Pure.
 */
export const STEP_TRADER_USD = 500;
export const STEP_LAST = 20;
const WALLET_STEPS = [1, 2, 3, 5];
const RULE_STEPS = [1, 5 / 3, 8 / 3];
export function sizeStep(g: EventLiveGroup, rows: EventLiveRow[], rule: string, usual?: number | null): { mult: number; step: number; n: number; net: number; why: string } {
  const s = rows.filter((r) => r.rule === rule && r.shares > 0 && r.pnl != null).sort((a, b) => (a.settledAt ?? a.t) - (b.settledAt ?? b.t));
  const n = s.length;
  const net = Math.round(s.reduce((a, r) => a + (r.pnl ?? 0), 0) * 100) / 100;
  if (!g.steps) return { mult: 1, step: 0, n, net, why: "off" };
  const won = s.filter((r) => r.won === true).length;
  const table = g.steps === "wallet" ? WALLET_STEPS : RULE_STEPS;
  let step = 0;
  if (g.steps === "wallet") step = n >= 100 && net >= 75 ? 3 : n >= 50 && net >= 25 ? 2 : n >= 20 && won * 2 >= n && net > 0 ? 1 : 0;
  else step = n >= 100 && net > 0 ? 2 : n >= 50 && net > 0 ? 1 : 0;
  let why = step ? `step ${step}` : "learning";
  if (g.steps === "wallet" && step > 1 && !((usual ?? 0) >= STEP_TRADER_USD)) {
    step = 1;
    why = `step 1: the trader's usual bet is under $${STEP_TRADER_USD}`;
  }
  if (step > 0) {
    const lastNet = s.slice(-STEP_LAST).reduce((a, r) => a + (r.pnl ?? 0), 0);
    let run = 0;
    let peak = 0;
    for (const r of s) peak = Math.max(peak, (run += r.pnl ?? 0));
    if (lastNet < 0 || peak - run >= 5 * g.size * table[step]) {
      step -= 1;
      why = lastNet < 0 ? `one step down: its newest ${STEP_LAST} are behind` : "one step down: it gave back 5 stakes from its best";
    }
  }
  return { mult: table[step], step, n, net, why };
}

/**
 * The automatic per-rule rule (see adaptN): "learning" until adaptN settled real bets with shares, then "paper" when the
 * settled result is adaptStop dollars down or worse (for good, until a review or enrique says otherwise), "up" while
 * it is ahead (stake x adaptBoost), else "flat". Pure.
 */
export function ruleAdapt(g: EventLiveGroup, rows: EventLiveRow[], rule: string, proven = false): { state: "off" | "learning" | "up" | "flat" | "paper"; n: number; net: number; recent?: number; proven?: boolean } {
  const s = rows.filter((r) => r.rule === rule && r.shares > 0 && r.pnl != null);
  const net = Math.round(s.reduce((a, r) => a + (r.pnl ?? 0), 0) * 100) / 100;
  // PROVEN TIER (25 Nov 2026, enrique: "push proven tier: 2.5+ standard errors not cut until 20+ real copies behind, bilberry back to real"):
  // a wallet that passes the skill test at provenT+ standard errors (src/copyskill.ts) skips the short-streak cuts
  // below; it goes back to paper only with PROVEN_CUT_N+ settled real bets and behind on them
  if (proven) {
    if (provenCut(s.length, net)) return { state: "paper", n: s.length, net, proven: true };
    return { state: !(g.adaptN > 0) ? "off" : s.length < g.adaptN ? "learning" : net > 0 ? "up" : "flat", n: s.length, net, proven: true };
  }
  // THE RECENT CUT (enrique, 22 Nov 2026 07:24 KST: "push polymarket cut a trader at -$15 over its last 10 real bets"):
  // a trader still ahead overall goes back to paper while its newest recentN settled real bets are recentLoss dollars
  // down or worse (three of the best gave back about $59 in a day). It returns when bets still open settle the window
  // back above the line; otherwise a review or enrique decides.
  if (g.recentN > 0 && g.recentLoss > 0 && s.length >= g.recentN) {
    const last = [...s].sort((a, b) => (a.settledAt ?? a.t) - (b.settledAt ?? b.t)).slice(-g.recentN);
    const recent = Math.round(last.reduce((a, r) => a + (r.pnl ?? 0), 0) * 100) / 100;
    if (recent <= -g.recentLoss + 1e-9) return { state: "paper", n: s.length, net, recent };
  }
  // THE CUT ON THE REAL RECORD (enrique, 16 Nov 2026 11:01 KST: "why the fuck arent we cutting bad traders copied
  // out?"). A rule goes back to paper AT ONCE when its own settled real bets are cutLoss dollars down or worse,
  // whatever their number, or behind at all after cutN or more of them. It returns only if bets still open settle it
  // back above the line; otherwise a review or enrique decides.
  if (g.cutLoss > 0 && net <= -g.cutLoss + 1e-9) return { state: "paper", n: s.length, net };
  if (g.cutN > 0 && s.length >= g.cutN && net < 0) return { state: "paper", n: s.length, net };
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
  return { n: g.adaptN, stop: g.adaptStop, boost: g.adaptBoost, cutN: g.cutN, cutLoss: g.cutLoss, recentN: g.recentN, recentLoss: g.recentLoss, probationN: g.probationN, houseUsd: g.houseUsd, ladder: g.ladder, steps: g.steps || null, provenT: g.provenT || null, rules: g.rules.map((rule) => ({ rule, ...ruleAdapt(g, rows, rule, group === "copy" && copyProven(rule, g.provenT ?? 0)), ...(g.ladder.length ? { stakeUsd: ladderStake(g, realRecordOf(rows, rule)) } : {}), ...(g.steps ? { sizeX: Math.round(sizeStep(g, rows, rule, STEP_TRADER_USD).mult * 100) / 100, stepWhy: sizeStep(g, rows, rule, STEP_TRADER_USD).why } : {}) })) };
}

export const NEG_READY_FILE = "negrisk-ready.json";
/** Written by src/live.ts negRiskSetup(): whether the wallet holds every permission grouped markets need. */
export type NegRiskReady = { at?: number; ready?: boolean; missing?: string[]; tries?: number; lastTryAt?: number; error?: string | null };
type NegClaims = Record<string, { tx?: string | null; negRisk?: boolean; pm?: boolean }>;
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
  // a claim sent from Polymarket's own list (src/pmredeem.ts) was not checked on chain: it does not lift the trial
  if (Object.values(claims).some((d) => d?.negRisk && d.tx && !d.pm)) return null;
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
/**
 * One real-order job of another module under the same one-at-a-time lock as the buys (src/copysell.ts, 19 Nov 2026:
 * selling when a copied wallet sells). It must read data/eventlive.json fresh and write it without waiting in
 * between. Not started when a restart is pending or another order is in flight (ok false).
 */
export async function eventLiveTurn<T>(f: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; why: string }> {
  if (stopping) return { ok: false, why: "restart pending: no new real order" };
  if (busy) return { ok: false, why: "another real order is in flight" };
  busy = true;
  try {
    return { ok: true, value: await f() };
  } finally {
    busy = false;
  }
}
/** For tests only. */
export const _eventLiveTest = { busy: (b: boolean) => void (busy = b), reset: () => void ((busy = false), (stopping = false)) };
/**
 * Copy one paper trade with real money if the guards allow. Returns a short text for the log: what was bought or why not.
 * Never throws. `conditionId` and `negRisk` come from the caller's Gamma lookup of the market.
 */
export async function eventLiveBuy(group: string, p: { rule: string; marketId: string; title: string; outcome: string; idx: number; token: string; ask: number; depth: number; fillable: boolean; feeRate: number; conditionId: string | null; negRisk?: boolean; stake?: number; resolveAt?: number; usual?: number | null; bet?: number | null }): Promise<string | null> {
  const cfg = eventLiveConfig();
  if (!cfg.groups[group]?.rules.includes(p.rule)) return null;
  // NO CRYPTO (24 Nov 2026): real copies of crypto markets lost $31.88 on 75 bets while the rest made $51.99 on 555;
  // with "noCrypto": true in the group, a crypto market stays on paper.
  if (cfg.groups[group]?.noCrypto && isCryptoTitle(p.title ?? "")) return "crypto market: real copies of crypto are off";
  // STOPPED (25 Nov 2026, enrique: "okay fuck polymarket, transfer that to hyperliquid"): no new real bet at all; the
  // open ones still settle, are claimed and follow their traders' sells.
  if (cfg.groups[group]?.stopNew) return "Polymarket real copies stopped: no new bets";
  if (stopping) return "restart pending: no new real order";
  if (busy) return "another real order is in flight";
  busy = true;
  try {
    const g = cfg.groups[group];
    // A caller-sized bet (wallet copies, 13 Nov 2026) stays between the group's size and maxSize, in whole cents.
    const rows = eventLiveRows();
    // with steps on, the step replaces the x1.5 rule and lifts the top of the range with it
    const boost = g.steps ? sizeStep(g, rows.filter((r) => r.group === group), p.rule, p.usual).mult : ruleAdapt(g, rows.filter((r) => r.group === group), p.rule).state === "up" ? g.adaptBoost : 1;
    const want = (p.stake ?? g.size) * boost;
    const top = g.steps ? Math.max(g.maxSize, g.size) * boost : g.maxSize;
    // ON PROBATION (16 Nov 2026): a rule bets the base size, however big the trader's bet was, until its own real
    // record is ahead after probationN or more settled bets (a wallet promoted hours before lost $7.42 on its first
    // real copy). Only a wallet that has won for us is sized by the trader's bet.
    const mineRec = realRecordOf(rows.filter((r) => r.group === group), p.rule);
    const proven = !(g.probationN > 0) || (mineRec.n >= g.probationN && mineRec.net > 0);
    // with a ladder the size comes from the wallet's own real record alone (ladderStake)
    let stake = g.ladder.length ? convictionStake(g, ladderStake(g, mineRec), p.bet != null && (p.usual ?? 0) > 0 ? p.bet / p.usual! : null, mineRec) : !proven || (p.stake == null && boost === 1) ? g.size : Math.round(Math.min(top, Math.max(g.size, want)) * 100) / 100;
    if (g.houseUsd > 0 && stake > g.size) {
      // a bigger bet is cut down to the room the wallet has left (never under the base size: the guard below decides that)
      const openMine = rows.filter((r) => r.group === group && r.rule === p.rule && r.pnl == null && held(r)).reduce((a, r) => a + r.cost, 0);
      stake = Math.max(g.size, Math.min(stake, Math.floor((riskRoom(g, mineRec) - openMine) * 100) / 100));
    }
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
      const oid = (res as unknown as { orderID?: unknown })?.orderID;
      if (typeof oid === "string" && oid) row.orderId = oid;
      const detail = (res as unknown as { error?: unknown })?.error;
      row.error = res?.success ? null : String(res?.errorMsg || (detail ? JSON.stringify(detail).slice(0, 200) : "order rejected"));
      row.cost = Number(res?.makingAmount) || 0;
      row.shares = Number(res?.takingAmount) || 0;
      const px = row.shares > 0 ? row.cost / row.shares : 0;
      row.fee = row.shares > 0 ? Math.round(p.feeRate * row.shares * px * (1 - px) * 1e6) / 1e6 : 0;
      // "delayed" (sports markets hold a taker order for a few seconds before matching it): accepted, NOT finished. It
      // usually fills right after this reply. Until 15 Nov 2026 such a row was closed as not filled, so the bet it
      // bought was in nobody's books. It stays open with its stake held; eventDelayedSync reads what it bought.
      if (row.ok && !(row.shares > 0) && isDelayed(row.status)) {
        row.status = "delayed";
        row.cost = stake;
        saveJson(EVENT_LIVE_FILE, rows);
        return "REAL order accepted with a delay: fill read on the next look";
      }
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
  if (cfg.groups[group]?.stopNew) return "Polymarket real copies stopped: no new bets";
  if (stopping) return "restart pending: no new real order";
  if (busy) return "another real order is in flight";
  busy = true;
  try {
    const g = cfg.groups[group];
    const rows = eventLiveRows();
    // a rule that has proved itself with real bets bids bigger (sizeStep)
    // with a ladder (18 Nov 2026, enrique: tennis resting bids on the copy ladder, "somewhere in the middle" = up to $7)
    // the bid size comes from the rule's own real record alone (ladderStake), as for the wallet copies
    const lad = g.ladder.length ? ladderStake(g, realRecordOf(rows.filter((r) => r.group === group), p.rule)) : 0;
    const mult = lad ? 1 : g.steps ? sizeStep(g, rows.filter((r) => r.group === group), p.rule).mult : 1;
    const shares = restShares(Math.round((lad || g.size) * mult * 100) / 100, p.price);
    const stake = Math.round(shares * p.price * 100) / 100;
    const top = lad ? Math.max(g.maxSize, lad) : g.maxSize * mult;
    if (stake > top + 1e-9) return `5-share minimum costs $${stake.toFixed(2)} (over $${top})`;
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
    // a group taken out of the live rules has its bids cancelled at once (20 Nov 2026, enrique: "stop doing tennis
    // crap, focus all cash for polymarket on copytrading"); its filled bets settle as usual
    const groups = eventLiveConfig().groups;
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
        const late = now >= (r.until ?? 0) || !groups[r.group];
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

const isDelayed = (s: string | null | undefined) => String(s ?? "").toLowerCase() === "delayed";
/** How long a delayed order is given to show a fill before its row is closed as not filled. */
export const DELAY_WAIT_MS = 5 * 60_000;
/** What our own trades say a delayed order bought: shares and dollars. Pure. */
export function delayedFill(trades: { taker_order_id?: string; side?: string; size?: string; price?: string; status?: string; trader_side?: string; match_time?: string }[], row: { orderId?: string; t: number }): { shares: number; cost: number } {
  let shares = 0;
  let cost = 0;
  for (const tr of trades) {
    if (String(tr.side).toUpperCase() !== "BUY" || /FAIL/i.test(String(tr.status))) continue;
    if (row.orderId ? tr.taker_order_id !== row.orderId : tr.trader_side !== "TAKER" || Math.abs(Number(tr.match_time) * 1000 - row.t) >= 10 * 60_000) continue;
    const size = Number(tr.size);
    const price = Number(tr.price);
    if (!(size > 0) || !(price > 0)) continue;
    shares += size;
    cost += size * price;
  }
  return { shares: Math.round(shares * 1e6) / 1e6, cost: Math.round(cost * 1e6) / 1e6 };
}
/**
 * Delayed orders: read what they bought from our own trades. Open ones ("delayed", no result yet) become a normal
 * filled row, or a finished no-fill row after DELAY_WAIT_MS. Rows closed as not filled before 15 Nov 2026 are checked
 * once (a few a call): one that did fill is opened again with its shares, so it is settled and claimed like any bet.
 */
export async function eventDelayedSync(now = Date.now()): Promise<string[]> {
  const rows = eventLiveRows();
  const open = rows.filter((r) => r.status === "delayed" && r.pnl == null && r.token);
  const old = rows.filter((r) => r.status === "delayed" && r.pnl === 0 && !(r.shares > 0) && !r.rechecked && r.token && now - r.t < 14 * 86400_000).slice(0, 4);
  if ((!open.length && !old.length) || busy) return [];
  busy = true;
  const out: string[] = [];
  try {
    const funder = String(loadJson<{ funder?: string }>("live.json", {}).funder ?? "").trim();
    const c = await getClient(funder);
    for (const r of [...open, ...old]) {
      try {
        const trades = await timed(c.getTrades({ asset_id: r.token!, after: String(Math.floor(r.t / 1000) - 60) }), "reading our trades");
        const f = delayedFill(trades as never, r);
        const wasClosed = r.pnl === 0;
        if (f.shares > 0) {
          r.shares = f.shares;
          r.cost = f.cost;
          r.status = "matched";
          delete r.pnl;
          delete r.won;
          delete r.settledAt;
          r.rechecked = true;
          out.push(`${r.rule} ${r.title} ${r.outcome}: REAL delayed order bought ${f.shares.toFixed(2)} for $${f.cost.toFixed(2)}${wasClosed ? " (found now: it had been booked as not filled)" : ""}`);
        } else if (wasClosed) r.rechecked = true;
        else if (now - r.t > DELAY_WAIT_MS) {
          r.status = "no fill";
          r.cost = 0;
          r.pnl = 0;
          r.won = null;
          r.settledAt = now;
        }
      } catch (e) {
        out.push(`${r.rule} ${r.title}: delayed order read failed (${(e as Error).message.slice(0, 80)})`);
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
    if (r.status === "resting") r.cost = spentOf(r); // settled while still resting: only the filled part was paid
    r.pnl = r.shares > 0 ? r.shares * pay - r.cost - r.fee : 0;
    r.settledAt = Date.now();
    n++;
  }
  if (n) saveJson(EVENT_LIVE_FILE, rows);
  return n;
}

/**
 * A crypto market by its title (24 Nov 2026, enrique: "is there a chance that avoiding copying crypto polymarket bets
 * improves our numbers"): "Up or Down" windows and markets naming a coin. Pure.
 */
export const isCryptoTitle = (t: string) => /up or down|\b(bitcoin|btc|ethereum|eth|solana|xrp|dogecoin|doge|bnb|hyperliquid|hype|crypto|microstrategy)\b/i.test(t);
/** Settled bets split crypto / other, all time and the last 7 days. Pure. */
export function kindSplit(settled: { title: string; pnl?: number | null; won?: boolean | null; settledAt?: number | null; t: number }[], now: number) {
  const agg = (xs: typeof settled) => ({ n: xs.length, won: xs.filter((r) => r.won === true).length, net: Math.round(xs.reduce((a, r) => a + (r.pnl ?? 0), 0) * 100) / 100 });
  const wk = settled.filter((r) => (r.settledAt ?? r.t) >= now - 7 * 86_400_000);
  const part = (xs: typeof settled, c: boolean) => xs.filter((r) => isCryptoTitle(r.title ?? "") === c);
  return { crypto: { all: agg(part(settled, true)), d7: agg(part(wk, true)) }, other: { all: agg(part(settled, false)), d7: agg(part(wk, false)) } };
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
    kinds: kindSplit(settled, Date.now()),
    open: filled.filter((r) => r.pnl == null).length,
    resting: rows.filter((r) => r.pnl == null && r.status === "resting").length,
    unknown: rows.filter((r) => r.status === "unknown" && r.pnl == null && !(r.shares > 0)).length,
    recent: rows.slice(-20).reverse().map((r) => ({ t: r.t, rule: r.rule, title: r.title, outcome: r.outcome, ask: r.ask, cost: spentOf(r), shares: r.shares, status: r.shares > 0 ? "filled" : r.status, error: r.error, won: r.won ?? null, pnl: r.pnl ?? null })),
  };
}
