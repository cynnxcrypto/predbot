/**
 * PAPER ONLY (enrique, 19 Nov 2026 14:05 KST: "okay paper test it"): a pretend deposit into the top trader vaults on
 * Hyperliquid, followed with the vaults' own public records. Nothing is signed or sent; no wallet of ours is read.
 *
 * Which vaults: money at stake first (his rule of 17 Nov, dollars not %): TVL_MIN_USD+ in the vault, AGE_MIN_D+ days
 * old, ALL_MIN_USD+ made all time, ahead this month; the MAX_VAULTS that made the most DOLLARS this month. A vault once
 * deposited into stays (a real deposit would not jump out the day it leaves a top list).
 *
 * What a deposit makes: between two readings the vault's own profit over its own value, which is the change of a
 * depositor's share whatever others put in or took out. The leader's cut (usually 10% of profit) comes off the gain.
 * Real deposits are locked a day (four for HLP): this test never withdraws, so that does not bite here.
 */
export const STAKE_USD = 100;
export const TVL_MIN_USD = 500_000;
export const AGE_MIN_D = 90;
export const ALL_MIN_USD = 50_000;
export const MAX_VAULTS = 10;
/** a reading that moves a vault more than this between two looks is taken as bad data, not a result */
export const MAX_STEP = 0.5;

export type Listed = { address: string; name: string; tvlUsd: number; ageD: number; monthUsd: number; allUsd: number; parent: boolean };
export type Held = {
  name: string;
  since: number;
  /** what the pretend deposit is worth before the leader's cut */
  grossUsd: number;
  peakUsd: number;
  maxDdPct: number;
  commission: number;
  /** the vault's own running profit, value and time at the reading the last step was made from */
  pnl?: number;
  av?: number;
  ptMs?: number;
  tvlUsd: number;
  monthUsd: number;
  allUsd: number;
  lastOkMs?: number;
  skipped?: number;
  closed?: boolean;
};
export type VaultState = { startedAt?: number; pickedAt?: number; held: Record<string, Held>; hist: [number, number][]; error?: string; listN?: number; passN?: number };

const num = (x: unknown) => {
  const n = x === null || x === undefined || x === "" ? NaN : Number(x);
  return Number.isFinite(n) ? n : null;
};
const span = (xs: unknown): number => {
  if (!Array.isArray(xs) || !xs.length) return 0;
  const a = num(xs[0]) ?? 0;
  const b = num(xs[xs.length - 1]) ?? 0;
  return b - a;
};

/** The public vault list -> the vaults a deposit can go to, with their dollars. Rows it cannot read are dropped. */
export function readList(answer: unknown, nowMs: number): Listed[] {
  if (!Array.isArray(answer)) return [];
  const out: Listed[] = [];
  for (const row of answer as { pnls?: unknown; summary?: Record<string, unknown> }[]) {
    const s = row?.summary;
    const address = String(s?.vaultAddress ?? "").toLowerCase();
    const tvlUsd = num(s?.tvl);
    const made = num(s?.createTimeMillis);
    const kind = String((s?.relationship as { type?: unknown } | undefined)?.type ?? "normal");
    if (!/^0x[0-9a-f]{40}$/.test(address) || tvlUsd === null || made === null || s?.isClosed === true || kind === "child") continue;
    const p = new Map((Array.isArray(row.pnls) ? (row.pnls as [string, unknown][]) : []).filter((x) => Array.isArray(x)).map((x) => [String(x[0]), x[1]]));
    out.push({ address, name: String(s?.name ?? "").slice(0, 40), tvlUsd, ageD: (nowMs - made) / 86_400_000, monthUsd: span(p.get("month")), allUsd: span(p.get("allTime")), parent: kind === "parent" });
  }
  return out;
}

/** The vaults that pass the floors, most dollars made this month first. */
export function pick(list: Listed[]): Listed[] {
  return list
    .filter((v) => v.tvlUsd >= TVL_MIN_USD && v.ageD >= AGE_MIN_D && v.allUsd >= ALL_MIN_USD && v.monthUsd > 0)
    .sort((a, b) => b.monthUsd - a.monthUsd);
}

export type Point = { ms: number; pnl: number; av: number; commission: number | null; closed: boolean };
/** A vault's own page -> its newest all-time point (running profit and value). Null when it has none. */
export function readDetail(answer: unknown): Point | null {
  const a = answer as { portfolio?: unknown; leaderCommission?: unknown; isClosed?: unknown } | null;
  if (!a || !Array.isArray(a.portfolio)) return null;
  const all = (a.portfolio as [string, { accountValueHistory?: unknown; pnlHistory?: unknown }][]).find((x) => Array.isArray(x) && x[0] === "allTime")?.[1];
  const pn = Array.isArray(all?.pnlHistory) ? (all.pnlHistory as [unknown, unknown][]) : [];
  const av = Array.isArray(all?.accountValueHistory) ? (all.accountValueHistory as [unknown, unknown][]) : [];
  const lp = pn[pn.length - 1];
  const la = av[av.length - 1];
  const ms = num(lp?.[0]);
  const pnl = num(lp?.[1]);
  const val = num(la?.[1]);
  if (ms === null || pnl === null || val === null) return null;
  return { ms, pnl, av: val, commission: num(a.leaderCommission), closed: a.isClosed === true };
}

/** One reading of a vault applied to the pretend deposit in it. */
export function step(h: Held, p: Point, nowMs: number): void {
  if (p.commission !== null && p.commission >= 0 && p.commission < 1) h.commission = p.commission;
  h.closed = p.closed || undefined;
  h.lastOkMs = nowMs;
  if (h.ptMs !== undefined && h.pnl !== undefined && h.av !== undefined && p.ms > h.ptMs && h.av > 0) {
    const r = (p.pnl - h.pnl) / h.av;
    if (Math.abs(r) > MAX_STEP) h.skipped = (h.skipped ?? 0) + 1;
    else {
      h.grossUsd *= 1 + r;
      h.peakUsd = Math.max(h.peakUsd, h.grossUsd);
      h.maxDdPct = Math.max(h.maxDdPct, h.peakUsd > 0 ? (100 * (h.peakUsd - h.grossUsd)) / h.peakUsd : 0);
    }
  }
  if (h.ptMs === undefined || p.ms > h.ptMs) {
    h.ptMs = p.ms;
    h.pnl = p.pnl;
    h.av = p.av;
  }
}

/** What the deposit would pay out now: the gain less the leader's cut of it; a loss is all ours. */
export const netUsd = (h: Held) => STAKE_USD + (h.grossUsd - STAKE_USD) * (h.grossUsd > STAKE_USD ? 1 - h.commission : 1);

/** New deposits for vaults that pass and are not held yet, up to MAX_VAULTS held; the list's dollars are refreshed. */
export function deposit(st: VaultState, list: Listed[], nowMs: number): void {
  const pass = pick(list);
  st.listN = list.length;
  st.passN = pass.length;
  st.pickedAt = nowMs;
  for (const v of list) {
    const h = st.held[v.address];
    if (h) Object.assign(h, { tvlUsd: v.tvlUsd, monthUsd: v.monthUsd, allUsd: v.allUsd, name: v.name || h.name });
  }
  for (const v of pass) {
    if (Object.keys(st.held).length >= MAX_VAULTS) break;
    if (st.held[v.address]) continue;
    st.held[v.address] = { name: v.name, since: nowMs, grossUsd: STAKE_USD, peakUsd: STAKE_USD, maxDdPct: 0, commission: v.parent ? 0 : 0.1, tvlUsd: v.tvlUsd, monthUsd: v.monthUsd, allUsd: v.allUsd };
    st.startedAt ??= nowMs;
  }
}

const r2 = (x: number) => Math.round(x * 100) / 100;
export function summary(st: VaultState, nowMs: number) {
  const rows = Object.entries(st.held)
    .map(([a, h]) => {
      const net = netUsd(h);
      return { id: a.slice(2, 8), name: h.name, since: h.since, tvlUsd: Math.round(h.tvlUsd), monthUsd: Math.round(h.monthUsd), allUsd: Math.round(h.allUsd), cutPct: Math.round(h.commission * 100), usd: r2(net - STAKE_USD), pct: r2((100 * (net - STAKE_USD)) / STAKE_USD), maxDdPct: r2(h.maxDdPct), readMs: h.lastOkMs ?? null, pointMs: h.ptMs ?? null, ...(h.closed ? { closed: true } : {}), ...(h.skipped ? { skipped: h.skipped } : {}) };
    })
    .sort((a, b) => b.usd - a.usd);
  const inUsd = rows.length * STAKE_USD;
  const usd = r2(rows.reduce((s, r) => s + r.usd, 0));
  const days = st.startedAt ? (nowMs - st.startedAt) / 86_400_000 : 0;
  return { paper: true, stakeUsd: STAKE_USD, startedAt: st.startedAt ?? null, days: r2(days), n: rows.length, ahead: rows.filter((r) => r.usd > 0).length, inUsd, usd, pct: inUsd ? r2((100 * usd) / inUsd) : 0, floors: { tvlUsd: TVL_MIN_USD, ageD: AGE_MIN_D, allUsd: ALL_MIN_USD }, listed: st.listN ?? null, pass: st.passN ?? null, rows, hist: st.hist.slice(-200), error: st.error ?? null };
}
