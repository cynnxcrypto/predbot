/**
 * Dashboard only (14 Nov 2026, enrique: "aint this supposed to do some trade?" / "the interface is really bad"): the
 * real day-holder copy (src/solana/slowlive.ts) coin by coin, for the Solana page. Read only: its state file, and for
 * each coin still held what a sale would bring now (the same Jupiter quote the bot sells with), cached a minute.
 * Per-coin times are served only from /api/solslow, behind the dashboard password; never in /api/status; coin addresses are not served at all.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./config.js";
import { kit } from "./solana/copylive.js";
import { shared } from "./solana/copyrun.js";
// until this moment every copy was bought with 0.01 SOL; later rows carry their own stake or none
const STAKE_RAISED_MS = Date.UTC(2026, 10, 15, 9, 0, 0);

const SOL = "So11111111111111111111111111111111111111112";
type Pos = { name: string; mint: string; stage: string; seenMs: number; boughtMs?: number; soldSeenMs?: number };
type Row = { t: number; name: string; mint: string; buy: string; exit: string; heldMin: number | null; netSol: number };
const worth = new Map<string, { at: number; sol: number | null }>();

async function worthNow(address: string, mint: string): Promise<number | null> {
  const c = worth.get(mint);
  if (c && Date.now() - c.at < 60_000) return c.sol;
  let sol: number | null = c?.sol ?? null;
  try {
    const h = await kit.held(address, mint);
    if (h.amount === 0n) sol = 0;
    else {
      const q = await kit.quote(mint, SOL, h.amount.toString(), 300);
      sol = q.outAmount ? Number(q.outAmount) / 1e9 : null;
    }
  } catch (e) {
    // the price service says the coin cannot be sold (no route: a 4xx other than 429, 401, 403, 408): it is worth
    // nothing now. Anything else (asked too fast, the network): keep the last value; tried again in a minute.
    if (/^jupiter \S+ http 4(?!29|01|03|08)\d\d\b/.test(String((e as Error)?.message ?? e))) sol = 0;
  }
  worth.set(mint, { at: Date.now(), sol });
  return sol;
}

// The coin's ticker (15 Nov 2026, enrique could not tell what a row was): read once per coin from the RPC's asset
// lookup and kept in memory; a failed read is tried again after ten minutes. Only the ticker is served, never the address.
const syms = new Map<string, { at: number; sym: string | null }>();
// Kept in a file too (data/, not in the repo): every deploy restarts the bot, and asking for 70 names at once right
// after a start was refused by the RPC, which left most coins without a name for ten minutes (15 Nov 2026).
const SYM_FILE = join(DATA, "solana-symbols.json");
let symsLoaded = false;
function loadSyms() {
  if (symsLoaded) return;
  symsLoaded = true;
  try {
    if (existsSync(SYM_FILE)) for (const [m, v] of Object.entries(JSON.parse(readFileSync(SYM_FILE, "utf8")) as Record<string, string>)) if (typeof v === "string" && v) syms.set(m, { at: Date.now(), sym: v });
  } catch {
    // start empty
  }
}
function saveSyms() {
  try {
    const o: Record<string, string> = {};
    for (const [m, v] of [...syms].slice(-2000)) if (v.sym) o[m] = v.sym;
    writeFileSync(SYM_FILE, JSON.stringify(o));
  } catch {
    // the names stay in memory
  }
}
const cleanSym = (v: unknown) => [...String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim()].slice(0, 12).join("");
async function symbolOf(mint: string): Promise<string | null> {
  const c = syms.get(mint);
  if (c && (c.sym || Date.now() - c.at < 60_000)) return c.sym;
  let sym: string | null = null;
  try {
    const r = await fetch(shared.rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: mint } }), signal: AbortSignal.timeout(4000) });
    const j = (await r.json()) as { result?: { content?: { metadata?: { symbol?: string; name?: string } }; token_info?: { symbol?: string } } };
    sym = cleanSym(j.result?.token_info?.symbol) || cleanSym(j.result?.content?.metadata?.symbol) || cleanSym(j.result?.content?.metadata?.name) || null;
  } catch {
    sym = null;
  }
  if (!sym) {
    // second source: Jupiter's token search by address
    try {
      const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`, { signal: AbortSignal.timeout(4000) });
      const rows = (await r.json()) as { id?: string; symbol?: string; name?: string }[];
      const row = Array.isArray(rows) ? rows.find((x) => x?.id === mint) : null;
      sym = cleanSym(row?.symbol) || cleanSym(row?.name) || null;
    } catch {
      sym = null;
    }
  }
  syms.set(mint, { at: Date.now(), sym });
  if (sym) saveSyms();
  return sym;
}
/** Names for these coins: the known ones at once, the unknown ones four at a time, for at most `ms`. */
async function symbolsFor(mints: string[], ms: number) {
  loadSyms();
  const need = [...new Set(mints)].filter((m) => {
    const c = syms.get(m);
    return !(c && (c.sym || Date.now() - c.at < 60_000));
  });
  const end = Date.now() + ms;
  const worker = async () => {
    while (need.length && Date.now() < end) await symbolOf(need.shift()!);
  };
  await Promise.race([Promise.all([worker(), worker(), worker(), worker()]), new Promise((ok) => setTimeout(ok, ms))]);
}

/**
 * The spot copy wallet's settled result since 00:00 KST: its books' netSol now less the netSol kept at the first
 * reading of the day (data/solslow-day.json). A reading taken after midnight is only exact when nothing closed between
 * midnight and it, so that first reading is lowered by the rows that closed in between. Every row counts, failed buys'
 * fees too, as in the books.
 */
function settledToday(st: { rows?: Row[]; netSol?: number }, kstDayOf: (ms: number) => string): number {
  const rows = Array.isArray(st.rows) ? st.rows : [];
  const day = kstDayOf(Date.now());
  const closedAt = (r: Row) => (r.heldMin != null ? r.t + r.heldMin * 60_000 : r.t);
  const sumToday = (until: number) => rows.reduce((x, r) => x + (kstDayOf(closedAt(r)) === day && closedAt(r) <= until ? Number(r.netSol) || 0 : 0), 0);
  const net = Number(st.netSol);
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  if (!Number.isFinite(net)) return r6(sumToday(Infinity));
  const f = join(DATA, "solslow-day.json");
  let k: { day?: string; startSol?: number } = {};
  try {
    if (existsSync(f)) k = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    k = {};
  }
  if (k.day !== day || !Number.isFinite(k.startSol)) {
    k = { day, startSol: net - sumToday(Date.now()) };
    try {
      writeFileSync(f, JSON.stringify(k));
    } catch {
      /* read only: worked out again next time */
    }
  }
  return r6(net - (k.startSol as number));
}

/** Every finished copy that landed, by the Korean day it closed (bought time plus minutes held), newest 30 days: what
 *  /api/solslow serves as days. Shared with the truth check (16 Nov 2026), which compares it with its own count. */
export function slowDays(allRows: Row[]): { day: string; n: number; won: number; netSol: number }[] {
  const kstDayOf = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
  const m: Record<string, { n: number; won: number; netSol: number }> = {};
  for (const r of allRows) {
    const d = (m[kstDayOf(r.heldMin != null ? r.t + r.heldMin * 60_000 : r.t)] ??= { n: 0, won: 0, netSol: 0 });
    d.n++;
    if ((r.netSol || 0) > 0) d.won++;
    d.netSol += r.netSol || 0;
  }
  return Object.keys(m).sort().reverse().slice(0, 30).map((day) => ({ day, n: m[day].n, won: m[day].won, netSol: Math.round(m[day].netSol * 1e6) / 1e6 }));
}
/** slowDays of the state file as solSlowView reads it, without its price and name lookups. */
export function slowDaysServed(): { day: string; n: number; won: number; netSol: number }[] | null {
  try {
    const f = join(DATA, "solana-slowlive.json");
    if (!existsSync(f)) return null;
    const st = JSON.parse(readFileSync(f, "utf8")) as { rows?: Row[] };
    return slowDays((Array.isArray(st.rows) ? st.rows : []).filter((r) => r.buy === "landed"));
  } catch {
    return null;
  }
}

export async function solSlowView(): Promise<unknown> {
  let st: { opens?: Pos[]; rows?: Row[]; netSol?: number } = {};
  try {
    const f = join(DATA, "solana-slowlive.json");
    if (existsSync(f)) st = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    st = {};
  }
  let addr = "";
  try {
    addr = readFileSync(join(DATA, "solana-wallet-address.txt"), "utf8").trim();
  } catch {
    addr = "";
  }
  const opens = Array.isArray(st.opens) ? st.opens : [];
  const short = (n: string) => n.replace(/^coin buyer /, "");
  const vals = new Map<string, number | null>();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) {
    // three at a time: 40+ quotes at once on the key the real copy buys with were refused for asking too fast (and
    // refused the real buys' quotes with them); what is not priced in time keeps its last value and is asked next time
    const todo = opens.filter((p) => p.stage === "held" || p.stage === "selling");
    const worker = async () => {
      for (let p = todo.shift(); p; p = todo.shift()) vals.set(p.mint, await worthNow(addr, p.mint));
    };
    await Promise.race([Promise.all([worker(), worker(), worker()]), new Promise((ok) => setTimeout(ok, 3000))]);
  }
  for (const p of opens) if (!vals.has(p.mint)) vals.set(p.mint, worth.get(p.mint)?.sol ?? null);
  const rowsAll = Array.isArray(st.rows) ? st.rows : [];
  const allRows = rowsAll.filter((r) => r.buy === "landed");
  const rows = allRows.slice(-40);
  const kstDayOf = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
  // open coins first: they are what is on screen
  await symbolsFor([...opens.map((p) => p.mint), ...rows.slice().reverse().map((r) => r.mint)], 3000);
  const sym = (m: string) => syms.get(m)?.sym ?? null;
  // no name found: the start of the address stands in (this page is behind the password)
  const ms = (m: string) => (typeof m === "string" && m.length > 8 ? m.slice(0, 4) + "…" : null);
  return {
    at: Date.now(),
    open: opens.map((p) => ({ name: short(p.name), sym: sym(p.mint), ms: ms(p.mint), stage: p.stage, t: p.boughtMs ?? p.seenMs, leaderSold: p.soldSeenMs != null, worthSol: vals.get(p.mint) ?? null, stakeSol: (p as { stakeSol?: number }).stakeSol ?? null })),
    // today's settled result: the wallet's books (its netSol) now against 00:00 KST, as the status counts it, failed
    // buys' fees included (16 Nov 2026: summing only the landed copies' rows read about $1.27 too high); the rows of the
    // day are the fallback until a reading from before midnight is kept
    todayNetSol: settledToday(st, kstDayOf),
    todayNetSolRows: Math.round(rowsAll.filter((r) => kstDayOf(r.heldMin != null ? r.t + r.heldMin * 60_000 : r.t) === kstDayOf(Date.now())).reduce((x, r) => x + (Number(r.netSol) || 0), 0) * 1e6) / 1e6,
    // every finished copy by the Korean day it closed, newest 30 days (for the overview's day by day)
    days: slowDays(allRows),
    todayN: allRows.filter((r) => kstDayOf(r.heldMin != null ? r.t + r.heldMin * 60_000 : r.t) === kstDayOf(Date.now())).length,
    closed: rows.slice().reverse().map((r) => ({ name: short(r.name), sym: sym(r.mint), ms: ms(r.mint), stakeSol: (r as { stakeSol?: number }).stakeSol ?? (r.t < STAKE_RAISED_MS ? 0.01 : null), t: r.t, closedAt: r.heldMin != null ? r.t + r.heldMin * 60_000 : null, exit: r.exit, heldMin: r.heldMin, netSol: r.netSol })),
  };
}
