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
type Worth = { at: number; total: number | null; cash: number | null; claim: number; bets: number; betsN: number; betsStake: number; days: Record<string, { n: number; stake: number; value: number; win: number; lose: number }>; solBal: number | null; coinsSol: number; coinsN: number; solUsd: number | null; rulesUsd: number | null; perpsUsd: number | null };
/** Money put in or taken out: [time, dollars (+ in, - out), which wallet]. Not a gain or a loss. */
export type Flow = [number, number, string];
/** What each wallet held at the last sample, to tell a deposit from a result. */
export type Comp = { pc: number | null; pk: number; pst: number; sol: number | null; coins: number; rules: number | null; perps: number | null };
let flows: Flow[] = [];
let comp: Comp | null = null;

/**
 * Deposits and withdrawals between two samples (15 Nov 2026, enrique's deposits showed as "+$111 in 1 h"). Polymarket:
 * cash moves $20 or more while claims and open bets did not move the other way by half of it (a redeem or a sale moves
 * them). Solana wallets: SOL moves $5 or more while the coins held did not move the other way by half of it; a wallet
 * seen for the first time counts whole. px = dollars per SOL.
 */
export function flowsBetween(a: Comp | null, b: Comp, px: number | null, t: number): Flow[] {
  const out: Flow[] = [];
  const r2 = (v: number) => Math.round(v * 100) / 100;
  if (a && a.pc != null && b.pc != null) {
    const d = b.pc - a.pc;
    if (d >= 20 && b.pk - a.pk > -0.5 * d) out.push([t, r2(d), "Polymarket"]);
    if (d <= -20 && b.pst - a.pst < 0.5 * -d && b.pk - a.pk < 0.5 * -d) out.push([t, r2(d), "Polymarket"]);
  }
  if (px != null) {
    if (a && a.sol != null && b.sol != null) {
      const d = (b.sol - a.sol) * px;
      const dc = (b.coins - a.coins) * px;
      if (Math.abs(d) >= 5 && !(Math.sign(dc) === -Math.sign(d) && Math.abs(dc) >= 0.5 * Math.abs(d))) out.push([t, r2(d), "Solana spot copy"]);
    }
    for (const [k, label] of [["rules", "Solana spot rules"], ["perps", "Solana perps"]] as const) {
      const now = b[k];
      if (now == null) continue;
      const was = a ? a[k] : null;
      const d = was == null ? now : now - was;
      if (was == null ? d >= 0.5 : Math.abs(d) >= 5) out.push([t, r2(d), label]);
    }
  }
  return out;
}
/** Samples before flows were recorded: a single step of $15 or more up is taken as a deposit (run once). */
export function flowsFromJumps(h: [number, number][]): Flow[] {
  const out: Flow[] = [];
  for (let i = 1; i < h.length; i++) {
    const d = h[i][1] - h[i - 1][1];
    if (d >= 15 && h[i][0] - h[i - 1][0] <= 15 * 60_000) out.push([h[i][0], Math.round(d * 100) / 100, "deposit"]);
  }
  return out;
}
/** The series with money put in or taken out removed: each past point is lifted by what was put in after it. */
export function netOfFlows<T extends [number, number, ...unknown[]]>(h: T[], fl: Flow[]): T[] {
  return h.map((p) => {
    const add = fl.reduce((a, f) => a + (f[0] > p[0] ? f[1] : 0), 0);
    return add ? ([p[0], Math.round((p[1] + add) * 100) / 100, ...p.slice(2)] as unknown as T) : p;
  });
}
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

/**
 * Samples taken while Polymarket's prices could not be read counted the open bets at what was paid, which showed as
 * a sudden drop and a jump back (15 Nov 2026, about 40 minutes at $156). Such a dip is a gap, not a result: a run that
 * falls 12% or more below the last good sample and wins back 70% or more of that fall inside three hours is dropped.
 */
export function despike(h: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < h.length; i++) {
    const good = out[out.length - 1];
    if (good && h[i][1] < good[1] * 0.88) {
      let back = false;
      for (let j = i + 1; j < h.length && h[j][0] - h[i][0] <= 3 * 3_600_000; j++) if (h[j][1] >= h[i][1] + 0.7 * (good[1] - h[i][1])) { back = true; break; }
      if (back) continue;
    }
    out.push(h[i]);
  }
  return out;
}

/** rules / perps = what the two strategy wallets hold in dollars (null = not read). */
export async function worthView(cash: number | null, claim: number, solBal: number | null, extra: { rulesSol?: number | null; rulesUsdc?: number | null; perpsSol?: number | null; perpsUsdc?: number | null } = {}): Promise<Worth & { age: number; hist: ([number, number] | [number, number, 1])[]; flows: Flow[] }> {
  if (!hist) {
    const f = loadJson<[number, number][] | { hist?: [number, number][]; back?: [number, number, 1][]; flows?: Flow[]; comp?: Comp | null; v?: number }>(FILE, []);
    flows = Array.isArray(f) ? [] : (f.flows ?? []);
    comp = Array.isArray(f) ? null : (f.comp ?? null);
    const needJumps = Array.isArray(f) || (f.v ?? 0) < 2;
    hist = (Array.isArray(f) ? f : (f.hist ?? [])).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    back = Array.isArray(f) ? [] : (f.back ?? []);
    hist = despike(hist);
    if (needJumps) flows = flowsFromJumps(hist);
  }
  if (!memo || Date.now() - memo.at > 15_000) {
    const [bets, px, slow] = await Promise.all([openWorth().catch(() => ({ n: 0, stake: 0, value: 0, priced: 0, days: {} })), solUsd(), solSlowView().catch(() => null)]);
    const open = ((slow as { open?: { stage: string; worthSol: number | null }[] } | null)?.open ?? []).filter((c) => c.stage !== "waiting");
    const coinsSol = open.reduce((a, c) => a + (c.worthSol ?? 0), 0);
    const solPart = px != null ? ((solBal ?? 0) + coinsSol) * px : 0;
    // Unpriced bets fall back to what was paid: with more than a tenth unpriced the total is not a reading, so it is
    // shown but not added to the chart.
    const priced = bets.n === 0 || bets.priced >= bets.n * 0.9;
    // A strategy wallet that could not be read this time keeps its last reading, so the total does not dip.
    const usd = (sol: number | null | undefined, usdc: number | null | undefined, last: number | null) => ((sol == null || usdc == null) && last != null ? last : sol == null && usdc == null ? null : px != null || !sol ? (sol ?? 0) * (px ?? 0) + (usdc ?? 0) : last);
    const rulesUsd = usd(extra.rulesSol, extra.rulesUsdc, comp?.rules ?? null);
    const perpsUsd = usd(extra.perpsSol, extra.perpsUsdc, comp?.perps ?? null);
    const total = cash != null ? Math.round((cash + claim + bets.value + solPart + (rulesUsd ?? 0) + (perpsUsd ?? 0)) * 100) / 100 : null;
    memo = { at: Date.now(), v: { at: Date.now(), total, cash, claim, bets: bets.value, betsN: bets.n, betsStake: bets.stake, days: bets.days, solBal, coinsSol: Math.round(coinsSol * 1e4) / 1e4, coinsN: open.length, solUsd: px, rulesUsd, perpsUsd } };
    const last = hist[hist.length - 1];
    if (total != null && priced && (!last || Date.now() - last[0] >= 120_000)) {
      // rules / perps are kept in dollars here, so their px is 1; the SOL wallet is kept in SOL
      const nowC: Comp = { pc: cash, pk: claim + bets.value, pst: bets.stake, sol: solBal ?? comp?.sol ?? null, coins: coinsSol, rules: rulesUsd, perps: perpsUsd };
      const solOnly = flowsBetween(comp ? { ...comp, rules: null, perps: null } : null, { ...nowC, rules: null, perps: null }, px, Date.now());
      const extraOnly = flowsBetween(comp ? { ...comp, pc: null, sol: null } : { pc: null, pk: 0, pst: 0, sol: null, coins: 0, rules: null, perps: null }, { ...nowC, pc: null, sol: null }, 1, Date.now());
      flows.push(...solOnly, ...extraOnly);
      flows = flows.filter((f) => f[0] > Date.now() - 8 * 86_400_000);
      comp = nowC;
      hist.push([Date.now(), total]);
      if (hist.length > 5040) hist = hist.slice(-5040); // a week at one sample every two minutes
      if (!back.length) {
        try {
          back = backfill(hist[0][0], solBal, px);
        } catch {
          back = [];
        }
      }
      saveJson(FILE, { hist, back, flows, comp, v: 2 });
    }
  }
  const step = Math.max(1, Math.ceil(hist.length / 300));
  const first = hist.length ? hist[0][0] : Infinity;
  const series: ([number, number] | [number, number, 1])[] = [...back.filter((p) => p[0] < first), ...despike(hist).filter((_, i, a) => i % step === 0 || i === a.length - 1)];
  return { ...memo.v, age: Date.now() - memo.at, hist: netOfFlows(series, flows), flows };
}
