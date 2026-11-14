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
import { loadJson, saveJson } from "./store.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const FILE = "worth-history.json";
type Worth = { at: number; total: number | null; cash: number | null; claim: number; bets: number; betsN: number; betsStake: number; days: Record<string, { n: number; stake: number; value: number; win: number; lose: number }>; solBal: number | null; coinsSol: number; coinsN: number; solUsd: number | null };
let memo: { at: number; v: Worth } | null = null;
let solPx: { at: number; v: number | null } = { at: 0, v: null };
let hist: [number, number][] | null = null;

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

export async function worthView(cash: number | null, claim: number, solBal: number | null): Promise<Worth & { hist: [number, number][] }> {
  hist ??= loadJson<[number, number][]>(FILE, []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
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
      saveJson(FILE, hist);
    }
  }
  const step = Math.max(1, Math.ceil(hist.length / 300));
  return { ...memo.v, hist: hist.filter((_, i) => i % step === 0 || i === hist!.length - 1) };
}
