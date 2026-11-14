/**
 * Dashboard only (14 Nov 2026, enrique: "aint this supposed to do some trade?" / "the interface is really bad"): the
 * real day-holder copy (src/solana/slowlive.ts) coin by coin, for the Solana page. Read only: its state file, and for
 * each coin still held what a sale would bring now (the same Jupiter quote the bot sells with), cached a minute.
 * Per-coin times are served only from /api/solslow, behind the dashboard password; never in /api/status; coin addresses are not served at all.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./config.js";
import { kit } from "./solana/copylive.js";

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
  const rows = (Array.isArray(st.rows) ? st.rows : []).filter((r) => r.buy === "landed");
  return {
    at: Date.now(),
    open: opens.map((p) => ({ name: short(p.name), stage: p.stage, t: p.boughtMs ?? p.seenMs, leaderSold: p.soldSeenMs != null, worthSol: vals.get(p.mint) ?? null })),
    closed: rows.slice(-40).reverse().map((r) => ({ name: short(r.name), t: r.t, closedAt: r.heldMin != null ? r.t + r.heldMin * 60_000 : null, exit: r.exit, heldMin: r.heldMin, netSol: r.netSol })),
  };
}
