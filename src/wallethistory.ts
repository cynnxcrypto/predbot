/**
 * The wallet's true all-time result (11 Nov 2026, enrique: "we also lost money before making the server … it's the
 * same wallet"). The dashboard and the status file only count what this server traded since 31 Oct 2026; this reads the
 * wallet's whole activity from Polymarket's data API and adds up the money that went into and came out of positions.
 *
 *   cash flow of a row: buy and split = money out; sell, redeem, merge, reward = money in
 *   all-time result    = sum of all cash flows + what the open positions are worth now
 *   money put in (net) = what the wallet is worth now - all-time result
 *
 * Read-only. The wallet address comes from the local data/live.json and is never written anywhere; the status file on
 * GitHub gets profit and loss only (deploy/report.py), never balances or deposits. WALLETHISTORY=off disables it.
 */
import { loadJson, saveJson } from "./store.js";

/** The server placed its first real order on Friday 31 Oct 2026 16:11 KST. */
export const SERVER_START = Date.parse("2026-10-31T07:11:00Z");
const API = "https://data-api.polymarket.com";
const FILE = "wallet-history.json";

export type Row = { type?: string; side?: string; usdcSize?: number | string; usdc_size?: number | string; size?: number | string; price?: number | string; timestamp?: number | string };
export type WalletHistory = {
  at: number;
  source: string | null;
  error: string | null;
  rows: number;
  firstAt: number | null;
  lastAt: number | null;
  /** Sum of cash flows before the server started, and since. */
  before: number;
  since: number;
  /** Money in and out by kind, whole history. */
  kinds: Record<string, { n: number; usd: number }>;
  /** Kinds we did not know how to count (left out of the sums). */
  unknown: Record<string, number>;
  months: Record<string, number>;
  /** What the open positions are worth now (null when it could not be read). */
  openValue: number | null;
  truncated: boolean;
};

/** Money in (+) or out (-) of one activity row; null when the kind is not one we know. */
export function flow(r: Row): { kind: string; usd: number } | null {
  const type = String(r.type ?? "TRADE").toUpperCase();
  const side = String(r.side ?? "").toUpperCase();
  const raw = r.usdcSize ?? r.usdc_size;
  const usd = raw != null && Number.isFinite(Number(raw)) ? Number(raw) : Number(r.size) * Number(r.price);
  if (!Number.isFinite(usd)) return null;
  const a = Math.abs(usd);
  if (type === "TRADE") return side === "BUY" ? { kind: "buy", usd: -a } : side === "SELL" ? { kind: "sell", usd: a } : null;
  if (type === "REDEEM") return { kind: "redeem", usd: a };
  if (type === "MERGE") return { kind: "merge", usd: a };
  if (type === "SPLIT") return { kind: "split", usd: -a };
  if (type === "REWARD" || type === "TAKER_REBATE" || type === "MAKER_REBATE" || type === "REBATE" || type === "YIELD") return { kind: "reward", usd: a };
  if (type === "CONVERSION") return { kind: "conversion", usd: 0 };
  return null;
}

const secs = (t: unknown) => (Number(t) > 1e12 ? Math.floor(Number(t) / 1000) : Number(t));
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Adds the rows up. `start` is the moment the server began, in ms. */
export function tally(rows: Row[], start = SERVER_START): Pick<WalletHistory, "rows" | "firstAt" | "lastAt" | "before" | "since" | "kinds" | "unknown" | "months"> {
  const out = { rows: rows.length, firstAt: null as number | null, lastAt: null as number | null, before: 0, since: 0, kinds: {} as Record<string, { n: number; usd: number }>, unknown: {} as Record<string, number>, months: {} as Record<string, number> };
  for (const r of rows) {
    const t = secs(r.timestamp) * 1000;
    const f = flow(r);
    if (!f || !Number.isFinite(t)) {
      const k = `${String(r.type ?? "?").toUpperCase()}${r.side ? " " + String(r.side).toUpperCase() : ""}`;
      out.unknown[k] = (out.unknown[k] ?? 0) + 1;
      continue;
    }
    out.firstAt = out.firstAt == null ? t : Math.min(out.firstAt, t);
    out.lastAt = out.lastAt == null ? t : Math.max(out.lastAt, t);
    if (t < start) out.before += f.usd;
    else out.since += f.usd;
    const k = (out.kinds[f.kind] ??= { n: 0, usd: 0 });
    k.n += 1;
    k.usd += f.usd;
    const m = new Date(t + 9 * 3600_000).toISOString().slice(0, 7); // KST month
    out.months[m] = (out.months[m] ?? 0) + f.usd;
  }
  out.before = r2(out.before);
  out.since = r2(out.since);
  for (const k of Object.values(out.kinds)) k.usd = r2(k.usd);
  for (const m of Object.keys(out.months)) out.months[m] = r2(out.months[m]);
  return out;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

const MAX_PAGES = 400;
/** Whole activity of a wallet. Tries the v2 endpoint (cursor pages) and then the old one (offset pages). */
async function activity(user: string): Promise<{ rows: Row[]; source: string; truncated: boolean }> {
  const errors: string[] = [];
  try {
    const rows: Row[] = [];
    let cursor = "";
    let pages = 0;
    for (; pages < MAX_PAGES; pages++) {
      const j = await getJson<{ data?: Row[]; pagination?: { next_cursor?: string | null } }>(`${API}/v2/activity?user=${user}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      const page = Array.isArray(j) ? (j as Row[]) : (j.data ?? []);
      rows.push(...page);
      const next = Array.isArray(j) ? "" : (j.pagination?.next_cursor ?? "");
      if (!page.length || !next || next === cursor) break;
      cursor = next;
    }
    if (rows.length) return { rows, source: "v2/activity", truncated: pages >= MAX_PAGES };
    errors.push("v2: no rows");
  } catch (e) {
    errors.push(`v2: ${(e as Error).message}`);
  }
  try {
    const rows: Row[] = [];
    let pages = 0;
    for (; pages < MAX_PAGES; pages++) {
      const page = await getJson<Row[] | { data?: Row[] }>(`${API}/activity?user=${user}&limit=500&offset=${pages * 500}`);
      const xs = Array.isArray(page) ? page : (page.data ?? []);
      rows.push(...xs);
      if (xs.length < 500) break;
    }
    if (rows.length) return { rows, source: "activity", truncated: pages >= MAX_PAGES };
    errors.push("v1: no rows");
  } catch (e) {
    errors.push(`v1: ${(e as Error).message}`);
  }
  throw new Error(errors.join("; "));
}

/** What the open positions are worth now, from the data API; null when neither endpoint answers. */
async function openValue(user: string): Promise<number | null> {
  for (const path of ["v2/value", "value"]) {
    try {
      const j = await getJson<unknown>(`${API}/${path}?user=${user}`);
      const x = Array.isArray(j) ? j[0] : ((j as { data?: unknown }).data ?? j);
      const v = Number((Array.isArray(x) ? x[0] : (x as { value?: unknown }))?.value);
      if (Number.isFinite(v)) return r2(v);
    } catch {
      // next
    }
  }
  return null;
}

let last: WalletHistory | null = loadJson<WalletHistory | null>(FILE, null);

export async function refreshWalletHistory(): Promise<WalletHistory | null> {
  const user = String(loadJson<{ funder?: string }>("live.json", {}).funder ?? "").trim();
  if (!user) return last;
  const base = { at: Date.now(), source: null, error: null, rows: 0, firstAt: null, lastAt: null, before: 0, since: 0, kinds: {}, unknown: {}, months: {}, openValue: null, truncated: false } satisfies WalletHistory;
  try {
    const a = await activity(user);
    last = { ...base, ...tally(a.rows), source: a.source, truncated: a.truncated, openValue: await openValue(user) };
  } catch (e) {
    // Never the URL (it holds the wallet address): the short reason only.
    last = { ...(last ?? base), at: Date.now(), error: (e as Error).message.replace(/0x[0-9a-fA-F]{6,}/g, "…").slice(0, 200) };
  }
  saveJson(FILE, last);
  return last;
}

/**
 * For the dashboard (behind its password). `cash` is what the wallet holds now and `claim` what is won and waiting, so
 * the money put in can be worked out. deploy/report.py copies only the profit and loss fields to GitHub.
 */
export function walletHistorySummary(cash: number | null = null, claim = 0) {
  const h = last;
  if (!h) return null;
  const ok = h.rows > 0;
  const allTime = ok && h.openValue != null ? r2(h.before + h.since + h.openValue) : null;
  const worth = cash != null && h.openValue != null ? r2(cash + claim + h.openValue) : null;
  return {
    at: h.at,
    source: h.source,
    error: h.error,
    rows: h.rows,
    truncated: h.truncated,
    firstAt: h.firstAt,
    lastAt: h.lastAt,
    serverStart: SERVER_START,
    /** Profit or loss: before the server (positions then are assumed closed), since it (open positions at today's value), and both. */
    beforeNet: ok ? h.before : null,
    sinceNet: ok && h.openValue != null ? r2(h.since + h.openValue) : null,
    allTimeNet: allTime,
    openValue: h.openValue,
    kinds: h.kinds,
    unknown: h.unknown,
    months: h.months,
    // Private (dashboard only): what the wallet is worth and the money put in, net of anything taken out.
    worth,
    netDeposited: worth != null && allTime != null ? r2(worth - allTime) : null,
  };
}

export function startWalletHistory() {
  if (process.env.WALLETHISTORY === "off") return null;
  setTimeout(() => void refreshWalletHistory().catch(() => undefined), 45_000);
  return setInterval(() => void refreshWalletHistory().catch(() => undefined), 3 * 3600_000);
}
