/**
 * Dashboard only (15 Nov 2026, enrique: "an estimated worth of the wallets based on literally everything, so we have
 * something moving constantly"): Polymarket cash + wins waiting to be claimed + every open prediction bet at the price
 * now + SOL + the Solana coins held at what a sale would bring, in dollars. Read only. Prices refresh about once a
 * minute (Polymarket's displayed price per market, one Jupiter quote for SOL and one per held coin).
 * A sample is kept every two minutes in data/worth-history.json (server only) for the small chart.
 */
import { openWorth } from "./eventdash.js";
import { solSlowView } from "./solslowdash.js";
import { kit } from "./solana/copylive.js";
import { loadJson, readAll, saveJson } from "./store.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const FILE = "worth-history.json";
type Worth = { at: number; total: number | null; cash: number | null; claim: number; bets: number; betsN: number; betsStake: number; days: Record<string, { n: number; stake: number; value: number; win: number; lose: number }>; solBal: number | null; coinsSol: number; coinsN: number; solUsd: number | null };
let memo: { at: number; v: Worth } | null = null;
let solPx: { at: number; v: number | null } = { at: 0, v: null };
let hist: [number, number][] | null = null;
/** Hourly estimates for the days before the live samples began (see backfill). */
let back: [number, number, 1][] = [];

/**
 * The past, before this page began sampling (15 Nov 2026, enrique: "it just keeps growing in time? ... show me
 * different comparisons"): one estimate an hour for up to 7 days back, from what the bot already recorded. Cash is
 * the wallet balance log; open bets count at what was paid for them (their price then is not recorded); SOL is today's
 * balance minus the recorded results of later Solana copies, at today's SOL price. Marked as estimates on the page.
 */
function backfill(firstLive: number, solBal: number | null, px: number | null): [number, number, 1][] {
  const bal = readAll<{ t: number; bal: number }>("balance").filter((r) => Number.isFinite(r?.t) && Number.isFinite(r?.bal)).sort((a, b) => a.t - b.t);
  if (!bal.length) return [];
  const bets = loadJson<{ t: number; cost: number; shares: number; pnl?: number | null; settledAt?: number | null }[]>("eventlive.json", []).filter((r) => r && r.shares > 0 && Number.isFinite(r.cost));
  const solRows: { t: number; netSol: number }[] = [];
  for (const f of ["solana-copylive.json", "solana-slowlive.json"]) for (const r of loadJson<{ rows?: { t: number; netSol?: number }[] }>(f, {}).rows ?? []) if (Number.isFinite(r?.t) && Number.isFinite(r?.netSol)) solRows.push({ t: r.t, netSol: r.netSol! });
  const solFrom = solRows.reduce((a, r) => Math.min(a, r.t), Infinity);
  const out: [number, number, 1][] = [];
  let i = 0;
  for (let T = Math.ceil(Math.max(bal[0].t, firstLive - 7 * 86_400_000) / 3_600_000) * 3_600_000; T < firstLive; T += 3_600_000) {
    while (i + 1 < bal.length && bal[i + 1].t <= T) i++;
    const open = bets.reduce((a, r) => a + (r.t <= T && (r.pnl == null || (r.settledAt ?? r.t) > T) ? r.cost : 0), 0);
    const sol = px != null && solBal != null && T >= solFrom ? Math.max(0, solBal - solRows.reduce((a, r) => a + (r.t > T ? r.netSol : 0), 0)) * px : 0;
    out.push([T, Math.round((bal[i].bal + open + sol) * 100) / 100, 1]);
  }
  return out;
}

async function solUsd(): Promise<number | null> {
  if (Date.now() - solPx.at < 60_000) return solPx.v;
  try {
    const q = await kit.quote(SOL, USDC, "1000000000", 50);
    solPx = { at: Date.now(), v: q.outAmount ? Number(q.outAmount) / 1e6 : solPx.v };
  } catch {
    solPx = { at: Date.now() - 30_000, v: solPx.v };
  }
  return solPx.v;
}

export async function worthView(cash: number | null, claim: number, solBal: number | null): Promise<Worth & { age: number; hist: ([number, number] | [number, number, 1])[] }> {
  if (!hist) {
    const f = loadJson<[number, number][] | { hist?: [number, number][]; back?: [number, number, 1][] }>(FILE, []);
    hist = (Array.isArray(f) ? f : (f.hist ?? [])).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    back = Array.isArray(f) ? [] : (f.back ?? []);
  }
  if (!memo || Date.now() - memo.at > 15_000) {
    const [bets, px, slow] = await Promise.all([openWorth().catch(() => ({ n: 0, stake: 0, value: 0, priced: 0, days: {} })), solUsd(), solSlowView().catch(() => null)]);
    const open = ((slow as { open?: { stage: string; worthSol: number | null }[] } | null)?.open ?? []).filter((c) => c.stage !== "waiting");
    const coinsSol = open.reduce((a, c) => a + (c.worthSol ?? 0), 0);
    const solPart = px != null ? ((solBal ?? 0) + coinsSol) * px : 0;
    const total = cash != null ? Math.round((cash + claim + bets.value + solPart) * 100) / 100 : null;
    memo = { at: Date.now(), v: { at: Date.now(), total, cash, claim, bets: bets.value, betsN: bets.n, betsStake: bets.stake, days: bets.days, solBal, coinsSol: Math.round(coinsSol * 1e4) / 1e4, coinsN: open.length, solUsd: px } };
    const last = hist[hist.length - 1];
    if (total != null && (!last || Date.now() - last[0] >= 120_000)) {
      hist.push([Date.now(), total]);
      if (hist.length > 5040) hist = hist.slice(-5040); // a week at one sample every two minutes
      if (!back.length) {
        try {
          back = backfill(hist[0][0], solBal, px);
        } catch {
          back = [];
        }
      }
      saveJson(FILE, { hist, back });
    }
  }
  const step = Math.max(1, Math.ceil(hist.length / 300));
  const first = hist.length ? hist[0][0] : Infinity;
  return { ...memo.v, age: Date.now() - memo.at, hist: [...back.filter((p) => p[0] < first), ...hist.filter((_, i) => i % step === 0 || i === hist!.length - 1)] };
}
