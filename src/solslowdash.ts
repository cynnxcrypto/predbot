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
  } catch {
    // keep the last value; tried again in a minute
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

export async function solSlowView(): Promise<unknown> {
  let st: { opens?: Pos[]; rows?: Row[] } = {};
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
    const work = Promise.all(opens.filter((p) => p.stage === "held" || p.stage === "selling").map(async (p) => vals.set(p.mint, await worthNow(addr, p.mint))));
    await Promise.race([work, new Promise((ok) => setTimeout(ok, 3000))]);
  }
  for (const p of opens) if (!vals.has(p.mint)) vals.set(p.mint, worth.get(p.mint)?.sol ?? null);
  const rows = (Array.isArray(st.rows) ? st.rows : []).filter((r) => r.buy === "landed").slice(-40);
  // open coins first: they are what is on screen
  await symbolsFor([...opens.map((p) => p.mint), ...rows.slice().reverse().map((r) => r.mint)], 3000);
  const sym = (m: string) => syms.get(m)?.sym ?? null;
  // no name found: the start of the address stands in (this page is behind the password)
  const ms = (m: string) => (typeof m === "string" && m.length > 8 ? m.slice(0, 4) + "…" : null);
  return {
    at: Date.now(),
    open: opens.map((p) => ({ name: short(p.name), sym: sym(p.mint), ms: ms(p.mint), stage: p.stage, t: p.boughtMs ?? p.seenMs, leaderSold: p.soldSeenMs != null, worthSol: vals.get(p.mint) ?? null })),
    closed: rows.slice().reverse().map((r) => ({ name: short(r.name), sym: sym(r.mint), ms: ms(r.mint), t: r.t, closedAt: r.heldMin != null ? r.t + r.heldMin * 60_000 : null, exit: r.exit, heldMin: r.heldMin, netSol: r.netSol })),
  };
}
