/**
 * WON POLYMARKET BETS POLYMARKET SAYS ARE STILL WAITING (17 Nov 2026). The truth check found Polymarket's own position
 * list holding $23 more won-and-redeemable money than the dashboard counted (7 bets): bets whose claim was marked done
 * but whose shares are still redeemable, bets the claimer gave up on, or wins not in our own bet file. Such money was
 * counted nowhere, and nothing claimed it.
 *
 * The truth check (src/truthcheck.ts) saves Polymarket's redeemable won positions here (data/pm-redeemable.json, this
 * machine only: market ids are never published). From it:
 *   - the worth counts every such win at its payout, once (src/worthdash.ts), on top of our own unclaimed wins;
 *   - the claimer claims it (src/live.ts redeemEvents), also when an earlier claim was marked done but the shares are
 *     still there, or it gave up after 5 failed tries (at most RECLAIMS more times, 2 hours after the last try, so
 *     the data API has caught up).
 */
import { loadJson, saveJson } from "./store.js";

export const PM_REDEEMABLE_FILE = "pm-redeemable.json";
/** A list older than this is not used (the truth check reads it every 30 minutes). */
export const PM_REDEEMABLE_MAX_AGE = 3 * 3600_000;
/** Extra claims of a market whose earlier claim was marked done while Polymarket still shows it redeemable. */
export const RECLAIMS = 3;
/** A market claimed less than this ago is left alone: the data API can lag the chain. */
export const RECLAIM_AFTER = 2 * 3600_000;

/** c: condition id, v: payout in dollars, neg: grouped (neg-risk) market. */
export type PmWon = { c: string; v: number; neg: boolean };
export type ClaimDone = { at?: number; tx?: string | null; tries?: number; nextAt?: number; reclaims?: number };
type BetRow = { conditionId?: string | null; shares?: number; pay?: number | null; settledAt?: number | null; pnl?: number | null };
/** Markets our books still hold as open bets: the worth already counts them at their price (about $1 a share once won). */
const openInOurs = (bets: BetRow[]) => new Set((Array.isArray(bets) ? bets : []).filter((r) => r?.conditionId && (r.shares ?? 0) > 0 && r.pnl == null && r.settledAt == null).map((r) => r.conditionId as string));

/** The redeemable positions worth something, out of Polymarket's v2 position rows. Pure. */
export function wonRows(rows: { condition_id?: unknown; conditionId?: unknown; redeemable?: unknown; current_value?: unknown; currentValue?: unknown; negative_risk?: unknown; negativeRisk?: unknown; current_size?: unknown; size?: unknown }[]): PmWon[] {
  const by = new Map<string, PmWon>();
  for (const p of Array.isArray(rows) ? rows : []) {
    const c = String(p?.condition_id ?? p?.conditionId ?? "");
    const v = Number(p?.current_value ?? p?.currentValue);
    const size = Number(p?.current_size ?? p?.size);
    if (p?.redeemable !== true || !/^0x[0-9a-fA-F]{64}$/.test(c) || !(v > 0.005) || !(size > 1e-6)) continue;
    const e = by.get(c) ?? { c, v: 0, neg: false };
    e.v = Math.round((e.v + v) * 100) / 100;
    e.neg = e.neg || p?.negative_risk === true || p?.negativeRisk === true;
    by.set(c, e);
  }
  return [...by.values()];
}

export function savePmRedeemable(rows: PmWon[], now = Date.now()) {
  saveJson(PM_REDEEMABLE_FILE, { at: now, rows });
}
export function loadPmRedeemable(now = Date.now()): PmWon[] {
  const f = loadJson<{ at?: number; rows?: PmWon[] }>(PM_REDEEMABLE_FILE, {});
  return f.at && now - f.at <= PM_REDEEMABLE_MAX_AGE && Array.isArray(f.rows) ? f.rows : [];
}

/** Our own won and not yet claimed payout per market (the worth already counts it). Pure. */
export function ourUnclaimed(bets: BetRow[], claims: Record<string, ClaimDone | undefined>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of Array.isArray(bets) ? bets : []) {
    if (!r?.conditionId || !((r.shares ?? 0) > 0) || !((r.pay ?? 0) > 0) || r.settledAt == null) continue;
    if (claims[r.conditionId]?.tx) continue;
    out.set(r.conditionId, (out.get(r.conditionId) ?? 0) + (r.shares ?? 0) * (r.pay ?? 0));
  }
  return out;
}

/** Won money Polymarket shows redeemable that our own books do not count as waiting. Pure. */
export function extraUnclaimed(pm: PmWon[], bets: BetRow[], claims: Record<string, ClaimDone | undefined>): number {
  const ours = ourUnclaimed(bets, claims);
  const open = openInOurs(bets);
  return Math.round(pm.reduce((a, w) => a + (open.has(w.c) ? 0 : Math.max(0, w.v - (ours.get(w.c) ?? 0))), 0) * 100) / 100;
}

/** What each redeemable win is in our books, for the public status (counts and dollars, no ids). Pure. */
export function waitingKinds(pm: PmWon[], bets: BetRow[], claims: Record<string, ClaimDone | undefined>) {
  const known = new Set((Array.isArray(bets) ? bets : []).map((r) => r?.conditionId).filter(Boolean) as string[]);
  const ours = ourUnclaimed(bets, claims);
  const k: Record<string, { n: number; usd: number }> = {};
  const add = (key: string, v: number) => {
    const e = (k[key] ??= { n: 0, usd: 0 });
    e.n++;
    e.usd = Math.round((e.usd + v) * 100) / 100;
  };
  for (const w of pm) {
    const d = claims[w.c];
    if (!known.has(w.c)) add("notInOurBets", w.v);
    else if (d?.tx) add("claimMarkedDone", w.v);
    else if ((d?.tries ?? 0) >= 5) add("claimGaveUp", w.v);
    else if (ours.has(w.c)) add("waitingInOurBooks", w.v);
    else if (openInOurs(bets).has(w.c)) add("stillOpenInOurBooks", w.v);
    else add("settledAsLostInOurBooks", w.v);
  }
  return k;
}

/**
 * The markets the claimer should claim beyond its own list: Polymarket shows them redeemable and either our books do
 * not have them waiting, or their claim was marked done 2+ hours ago (at most RECLAIMS times). Pure.
 */
export function extraClaims(pm: PmWon[], neg: boolean, claims: Record<string, ClaimDone | undefined>, now: number): PmWon[] {
  return pm.filter((w) => {
    if (w.neg !== neg || !(w.v > 0.01)) return false;
    const d = claims[w.c];
    if (!d) return true;
    // marked done, or given up after 5 failed tries: a few more tries now that Polymarket says it is still there
    if (d.tx || (d.tries ?? 0) >= 5) return now - (d.at ?? 0) >= RECLAIM_AFTER && (d.reclaims ?? 0) < RECLAIMS;
    return !((d.nextAt ?? 0) > now);
  });
}
