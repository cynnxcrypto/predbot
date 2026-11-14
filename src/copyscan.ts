/**
 * Daily wallet rescan for the copies (14 Nov 2026 17:08 KST, enrique: "yeah" to "an automatic rescan, say once a day,
 * that adds wallets passing the bar to paper first and moves them to real once they prove out").
 *
 * Runs inside the paper process (src/eventpaper.ts), once a day, on the server: no Claude round.
 *  1. Candidates: the Polymarket profit leaderboards (month, top 100) of every category.
 *  2. Screen (copyScreen): up in each of its last 4 weeks, no single week over half of the 4 weeks' profit; at least
 *     14 buys in the last 7 days (about 2 a day, so copies happen); median buy $100 or less (copyable at $3-$10); at
 *     most a third of its buys in crypto "Up or Down" markets (that is the race we lose).
 *  3. At most ADD_PER_DAY new wallets a day go to PAPER copy (rules copy-rest/take/any-<name>), at most MAX_ACTIVE
 *     auto wallets followed at once.
 *  4. Promotion (copyPromote): a paper wallet goes to REAL when its paper copy-take-<name> has PROMOTE_N+ settled
 *     fillable copies, half or more won, and net above 0. Real copies then follow the same rules as every copied
 *     wallet (deploy/live-rules.json events.copy: $3-$10, 14 days at most, stake caps, back to paper at -$10 after 10
 *     settled real copies).
 *  5. A paper wallet that after DROP_DAYS has DROP_N+ settled paper copies and is behind is dropped (no longer followed).
 * State: data/copy-auto.json (server only). Public status shows names and stages, the addresses are public wallets.
 */
import { loadJson, saveJson } from "./store.js";

export const AUTO_FILE = "copy-auto.json";
export const ADD_PER_DAY = 5;
export const MAX_ACTIVE = 10; // every followed wallet is read every 15 s: keep the data API load near 2 calls a second
export const PROMOTE_N = 20;
export const DROP_DAYS = 14;
export const DROP_N = 10;
const DATA = "https://data-api.polymarket.com";
const CATS = ["overall", "crypto", "sports", "esports", "weather", "politics", "economics", "economy", "finance", "tech", "culture", "mentions"];

export type AutoWallet = { name: string; address: string; addedAt: number; stage: "paper" | "real" | "dropped"; why: string; promotedAt?: number; droppedAt?: number };
export type AutoState = { lastScan: number; scans: number; lastError: string | null; screened: number; passed: number; wallets: AutoWallet[]; log: { t: number; text: string }[] };
const EMPTY: AutoState = { lastScan: 0, scans: 0, lastError: null, screened: 0, passed: 0, wallets: [], log: [] };

export function autoState(): AutoState {
  const s = loadJson<Partial<AutoState>>(AUTO_FILE, {});
  return { ...EMPTY, ...s, wallets: Array.isArray(s.wallets) ? s.wallets : [], log: Array.isArray(s.log) ? s.log : [] };
}
const save = (s: AutoState) => saveJson(AUTO_FILE, s);
/** Wallets the paper copy follows (paper and real). */
export const autoFollowed = (s = autoState()) => s.wallets.filter((w) => w.stage !== "dropped");
/** Real rules added to events.copy by this module. */
export const autoRealRules = (s = autoState()) => s.wallets.filter((w) => w.stage === "real").map((w) => `copy-take-${w.name}`);

type PnlPoint = { timestamp?: number; economic_pnl?: number; unrealized_pnl?: number };
type Act = { type?: string; side?: string; timestamp?: number | string; usdc_size?: number | string; usdcSize?: number | string; title?: string; price?: number | string; size?: number | string };

/** Weekly profit over the last 4 weeks from daily cumulative points (economic + unrealized), newest week last. */
export function weeklyPnl(points: PnlPoint[], now: number): number[] | null {
  const pts = points
    .map((p) => ({ t: Number(p.timestamp) * 1000, v: Number(p.economic_pnl ?? 0) + Number(p.unrealized_pnl ?? 0) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 20) return null;
  const at = (t: number) => {
    let v: number | null = null;
    for (const p of pts) if (p.t <= t) v = p.v;
    return v;
  };
  const out: number[] = [];
  for (let k = 4; k >= 1; k--) {
    const a = at(now - k * 7 * 86400_000);
    const b = at(now - (k - 1) * 7 * 86400_000);
    if (a == null || b == null) return null;
    out.push(b - a);
  }
  return out;
}

/** The screen; returns null when the wallet passes, else why not. Pure. */
export function copyScreen(weeks: number[] | null, acts: Act[], now: number): string | null {
  if (!weeks) return "no 4-week profit history";
  if (!weeks.every((w) => w > 0)) return "a losing week in the last 4";
  const sum = weeks.reduce((a, b) => a + b, 0);
  if (Math.max(...weeks) > 0.5 * sum) return "one week made over half the profit";
  const buys = acts.filter((r) => r.type === "TRADE" && String(r.side ?? "").toUpperCase() === "BUY" && (Number(r.timestamp) > 1e12 ? Number(r.timestamp) : Number(r.timestamp) * 1000) >= now - 7 * 86400_000);
  if (buys.length < 14) return `${buys.length} buys in 7 days (needs 14)`;
  const usd = buys.map((r) => Number(r.usdc_size ?? r.usdcSize ?? Number(r.price) * Number(r.size))).filter((x) => x > 0).sort((a, b) => a - b);
  const med = usd.length ? usd[usd.length >> 1] : Infinity;
  if (!(med <= 100)) return `median buy $${Math.round(med)} (over $100)`;
  const crypto = buys.filter((r) => /up or down/i.test(String(r.title ?? ""))).length;
  if (crypto > buys.length / 3) return "mostly crypto up/down";
  return null;
}

/** Paper result of a rule from the paper trades: settled fillable count, won, net. */
export type PaperTrade = { rule: string; pnl?: number | null; won?: boolean | null; fillable?: boolean };
export function paperResult(trades: PaperTrade[], rule: string) {
  const s = trades.filter((t) => t.rule === rule && t.pnl != null && t.fillable !== false);
  return { n: s.length, won: s.filter((t) => t.won === true).length, net: Math.round(s.reduce((a, t) => a + (t.pnl ?? 0), 0) * 100) / 100 };
}
/** Promotions and drops for the auto wallets. Mutates and returns log lines. Pure apart from the state passed in. */
export function copyPromote(s: AutoState, trades: PaperTrade[], now: number): string[] {
  const out: string[] = [];
  for (const w of s.wallets) {
    if (w.stage !== "paper") continue;
    const r = paperResult(trades, `copy-take-${w.name}`);
    if (r.n >= PROMOTE_N && r.won * 2 >= r.n && r.net > 0) {
      w.stage = "real";
      w.promotedAt = now;
      out.push(`${w.name} promoted to REAL: paper ${r.won} of ${r.n} won, +$${r.net.toFixed(2)}`);
    } else if (now - w.addedAt >= DROP_DAYS * 86400_000 && r.n >= DROP_N && r.net < 0) {
      w.stage = "dropped";
      w.droppedAt = now;
      out.push(`${w.name} dropped: paper ${r.won} of ${r.n} won, $${r.net.toFixed(2)} after ${DROP_DAYS} days`);
    }
  }
  return out;
}

const nameFor = (user: string | undefined, address: string, taken: Set<string>) => {
  let n = String(user ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 20);
  if (!n || /^0x/.test(n)) n = `w-${address.slice(2, 8)}`;
  while (taken.has(n)) n = `${n}-${address.slice(2, 4)}`;
  return n;
};

/**
 * The daily scan. `followed` = addresses already followed (static list and auto); `own` = our wallet (left out);
 * `get` = the JSON fetcher. Adds at most ADD_PER_DAY wallets. Never throws.
 */
export async function copyScan(followed: { name: string; address: string }[], own: string, get: <T>(url: string) => Promise<T>, now = Date.now()): Promise<string[]> {
  const s = autoState();
  const out: string[] = [];
  s.lastScan = now;
  s.scans += 1;
  try {
    const known = new Set([...followed.map((w) => w.address.toLowerCase()), ...s.wallets.map((w) => w.address.toLowerCase()), own.toLowerCase()]);
    const names = new Set([...followed.map((w) => w.name), ...s.wallets.map((w) => w.name)]);
    const cands = new Map<string, { user?: string; pnl: number }>();
    for (const cat of CATS) {
      const rows = await get<unknown>(`${DATA}/v2/leaderboard?category=${cat}&time_period=month&sort_by=PNL&limit=100`).catch(() => null);
      const list = (Array.isArray(rows) ? rows : ((rows as { data?: unknown[] } | null)?.data ?? [])) as { user_id?: string; proxyWallet?: string; user_name?: string; userName?: string; pnl?: number | string }[];
      for (const r of list) {
        const a = String(r.user_id ?? r.proxyWallet ?? "").toLowerCase();
        const pnl = Number(r.pnl);
        if (!/^0x[0-9a-f]{40}$/.test(a) || known.has(a) || !(pnl > 0)) continue;
        if (!cands.has(a) || cands.get(a)!.pnl < pnl) cands.set(a, { user: r.user_name ?? r.userName, pnl });
      }
    }
    const active = autoFollowed(s).length;
    let room = Math.max(0, Math.min(ADD_PER_DAY, MAX_ACTIVE - active));
    let screened = 0;
    let passed = 0;
    // biggest month profit first; at most 120 wallets read a day (2 calls each)
    for (const [address, c] of [...cands].sort((a, b) => b[1].pnl - a[1].pnl).slice(0, 120)) {
      if (room <= 0) break;
      screened += 1;
      const pnl = await get<{ data?: { points?: PnlPoint[] } }>(`${DATA}/v2/user-pnl?user=${address}&interval=1m&fidelity=1d`).catch(() => null);
      const weeks = weeklyPnl(pnl?.data?.points ?? [], now);
      if (!weeks || !weeks.every((w) => w > 0)) continue;
      const acts = (await get<{ data?: Act[] }>(`${DATA}/v2/activity?user=${address}&limit=500`).catch(() => null))?.data ?? [];
      const why = copyScreen(weeks, acts, now);
      if (why) continue;
      passed += 1;
      const name = nameFor(c.user, address, names);
      names.add(name);
      s.wallets.push({ name, address, addedAt: now, stage: "paper", why: `weeks ${weeks.map((w) => Math.round(w)).join("/")}, month +$${Math.round(c.pnl)}` });
      out.push(`${name} added to paper copy (weeks ${weeks.map((w) => `$${Math.round(w)}`).join(", ")})`);
      room -= 1;
    }
    s.screened = screened;
    s.passed = passed;
    s.lastError = null;
  } catch (e) {
    s.lastError = (e as Error).message.slice(0, 120);
  }
  for (const t of out) s.log.push({ t: now, text: t });
  s.log = s.log.slice(-30);
  save(s);
  return out;
}

/** Public status: stages and paper results, no secrets (the addresses are other people's public wallets). */
export function autoSummary(trades: PaperTrade[]) {
  const s = autoState();
  return {
    lastScan: s.lastScan || null,
    scans: s.scans,
    screened: s.screened,
    passed: s.passed,
    lastError: s.lastError,
    bar: `added: up each of its last 4 weeks (no week over half), 14+ buys in 7 days, median buy <= $100, under a third crypto up/down; ${ADD_PER_DAY} a day at most, ${MAX_ACTIVE} followed at most. REAL when paper copy-take has ${PROMOTE_N}+ settled, half won, net > 0. Dropped after ${DROP_DAYS} days with ${DROP_N}+ settled and behind.`,
    wallets: s.wallets.map((w) => ({ name: w.name, stage: w.stage, addedAt: w.addedAt, promotedAt: w.promotedAt ?? null, paper: paperResult(trades, `copy-take-${w.name}`) })),
    log: s.log.slice(-10).reverse(),
  };
}
