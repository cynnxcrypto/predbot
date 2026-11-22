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
import { extraUnclaimed, loadPmRedeemable, pmRedeemableAt } from "./pmredeem.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const FILE = "worth-history.json";
type Today = { usd: number; at: number; from?: number; est?: boolean } | null;
type Worth = { today?: Record<string, Today>; at: number; total: number | null; cash: number | null; claim: number; bets: number; betsN: number; betsPos?: number; betsStake: number; days: Record<string, { n: number; stake: number; value: number; win: number; lose: number }>; solBal: number | null; coinsSol: number; coinsN: number; solUsd: number | null; rulesUsd: number | null; perpsUsd: number | null; hlUsd?: number | null; rulesPos: number; perpsPos: number; parts?: Record<string, { sol: number | null; usdc: number | null; pos: number } | { eth: number; usdc: number; account: number } | null> };
/** Money put in or taken out: [time, dollars (+ in, - out), which wallet]. Not a gain or a loss. */
export type Flow = [number, number, string];
/** What each wallet held at the last sample, to tell a deposit from a result. */
export type Comp = { pc: number | null; pk: number; pst: number; sol: number | null; coins: number; rules: number | null; perps: number | null; pkh?: number[]; rulesPos?: number; perpsPos?: number; hl?: number | null; hlIn?: number | null };
let flows: Flow[] = [];
/**
 * MONEY IN AND OUT OF THE TWO SOLANA STRATEGY WALLETS FROM THE CHAIN (17 Nov 2026). Opening and closing perps positions
 * had been booked as deposits and withdrawals; dropping every small one (0e817998) then also dropped enrique's real
 * deposits, made in parts on 15 Nov, and 15 Nov read +$100. The truth check reads every transfer of these wallets from
 * the chain and keeps only those with a plain wallet that is not ours on the other side: that list is what was put in
 * or taken out. Where it has been read, it replaces what the chart guessed for these two wallets; after its last read
 * the chart's own detection (which no longer takes a position for a deposit) fills in. Set from status.ts.
 */
const CHAIN_WALLETS = new Set(["Solana perps", "Solana spot rules"]);
export type ChainFix = { at: number; from: number; missing: { t: number; usd: number; wallet: string }[]; notOnChain: { t: number; usd: number; wallet: string }[] };
let chainSrc: () => ChainFix | null = () => null;
export const setChainFlows = (f: typeof chainSrc) => void (chainSrc = f);
/** The chart's flows with, for the two strategy wallets, a flow the chain does not show taken out (a trade read as money
 * in or out) and a transfer the chain shows that the chart missed put in. Matched ones keep the chart's own figure (SOL
 * at that day's price). Only what the last chain read covered. Pure. */
export function mergeChainFlows(fl: Flow[], ch: ChainFix | null): Flow[] {
  if (!ch) return fl;
  const span = (t: number) => t >= ch.from && t <= ch.at;
  const drop = ch.notOnChain.filter((x) => CHAIN_WALLETS.has(x.wallet) && span(x.t));
  const keep = fl.filter((f) => !(CHAIN_WALLETS.has(f[2]) && span(f[0]) && drop.some((x) => x.t === f[0] && x.wallet === f[2] && Math.abs(x.usd - f[1]) < 0.005)));
  const add = ch.missing.filter((x) => CHAIN_WALLETS.has(x.wallet) && span(x.t)).map((x) => [x.t, Math.round(x.usd * 100) / 100, x.wallet] as Flow);
  return [...keep, ...add].sort((a, b) => a[0] - b[0]);
}
/** Deposits seen at the last reading and not yet in a chart sample. */
let pending: Flow[] = [];
/**
 * THE MONEY ENRIQUE PUT INTO THE SOLANA WALLETS (17 Nov 2026, MAIN's truth check: the flows booked for 15 Nov were not his
 * confirmed deposits, and the chain read does not reach back to all of 15 Nov). His word, 15 Nov 17:38-17:47 KST: about
 * $101 into Solana spot copy, $101 into Solana spot rules, $100 into Solana perps, and nothing else into these three
 * wallets since. For these wallets exactly these are booked: at the time and figure the chart saw it (same wallet, same
 * Korean day, within 15%), else on that day at 17:40 KST at his figure. Every other step on them is a result or a move
 * inside the wallet. Hyperliquid keeps its own ledger of ETH that arrived; Polymarket keeps its own detection.
 */
export const CONFIRMED: { wallet: string; day: string; usd: number }[] = [
  { wallet: "Solana spot copy", day: "2026-11-15", usd: 101 },
  { wallet: "Solana spot rules", day: "2026-11-15", usd: 101 },
  { wallet: "Solana perps", day: "2026-11-15", usd: 100 },
];
const CONFIRMED_WALLETS = new Set(CONFIRMED.map((c) => c.wallet));
const kday = (t: number) => new Date(t + 9 * 3_600_000).toISOString().slice(0, 10);
/** The flows with, for the three Solana wallets, exactly the confirmed deposits. Pure. */
export function withConfirmed(fl: Flow[]): Flow[] {
  const keep = fl.filter((f) => !CONFIRMED_WALLETS.has(f[2]));
  for (const c of CONFIRMED) {
    const seen = fl.filter((f) => f[2] === c.wallet && kday(f[0]) === c.day && Math.abs(f[1] - c.usd) <= 0.15 * c.usd).sort((a, b) => Math.abs(a[1] - c.usd) - Math.abs(b[1] - c.usd))[0];
    // his figure, at the time the chart saw it (else 17:40 KST that day): the SOL price of the moment must not change it
    keep.push([seen ? seen[0] : Date.parse(c.day + "T17:40:00+09:00"), c.usd, c.wallet]);
  }
  return keep.sort((a, b) => a[0] - b[0]);
}
/** For the public status, per wallet: "booked" = the deposits the worth figures actually take out (every window, card and
 * day uses these), "confirmed" = his, offUsd = booked minus confirmed (0 when right). "chartSaw" = what the 2-minute
 * readings and the chain read detected on their own before his figures replace them (diagnostic only, not used).
 * No amount of a deposit itself. */
export function depositCheck(fl: Flow[], since: number) {
  const out: Record<string, { booked: number; confirmed: number; offUsd: number; chartSaw: { n: number; offUsd: number } }> = {};
  const used = withConfirmed(fl);
  const sum = (a: Flow[]) => a.reduce((x, f) => x + f[1], 0);
  for (const w of CONFIRMED_WALLETS) {
    const raw = fl.filter((f) => f[2] === w && f[0] >= since);
    const b = used.filter((f) => f[2] === w && f[0] >= since);
    const conf = sum(CONFIRMED.filter((c) => c.wallet === w && Date.parse(c.day + "T23:59:59+09:00") >= since).map((c) => [0, c.usd, w] as Flow));
    const n = CONFIRMED.filter((c) => c.wallet === w && Date.parse(c.day + "T23:59:59+09:00") >= since).length;
    out[w] = { booked: b.length, confirmed: n, offUsd: Math.round((sum(b) - conf) * 100) / 100, chartSaw: { n: raw.length, offUsd: Math.round((sum(raw) - conf) * 100) / 100 } };
  }
  const other = used.filter((f) => f[0] >= since && !CONFIRMED_WALLETS.has(f[2]));
  return { ...out, otherFlows: other.map((f) => ({ at: f[0], wallet: f[2] })) };
}
/**
 * MOVES BETWEEN OUR OWN WALLETS ARE NOT A WIN OR A LOSS (20 Nov 2026, enrique: "yeah the transfers you trigger should
 * definitely not be counted as win or loss"; the morning's bridge moves showed Hyperliquid today +$159.73 and the three
 * Solana wallets -$141). Each bridge move is booked as money taken out of the wallet it left (when it started) and put
 * into the wallet it reached (when it ended), both at the dollars that ARRIVED: the two cancel in the total, and only
 * the bridge's fee stays on the wallet that paid it. A move to or from a wallet outside these (Base) books its one side.
 * Moves inside Hyperliquid (to the second wallet) need nothing: both accounts are one Hyperliquid figure. Set from status.ts.
 */
export type OwnMove = { from: string; to: string; startedAt: number; endedAt: number | null; arrivedUsd: number };
const PLACE_LABEL: Record<string, string> = { hyperliquid: "Hyperliquid", polymarket: "Polymarket", "solana-perps": "Solana perps", "solana-spot-rules": "Solana spot rules", "solana-spot-copy": "Solana spot copy" };
let movesSrc: () => OwnMove[] = () => [];
export const setOwnMoves = (f: typeof movesSrc) => void (movesSrc = f);
/** The flows for our own moves (done ones; a move still on its way books nothing yet). Pure. */
export function ownMoveFlows(moves: OwnMove[]): Flow[] {
  const out: Flow[] = [];
  for (const m of moves) {
    if (m.endedAt == null || !(m.arrivedUsd > 0)) continue;
    const usd = Math.round(m.arrivedUsd * 100) / 100;
    if (PLACE_LABEL[m.from]) out.push([m.startedAt, -usd, PLACE_LABEL[m.from]]);
    if (PLACE_LABEL[m.to]) out.push([m.endedAt, usd, PLACE_LABEL[m.to]]);
  }
  return out;
}
const effFlows = () => {
  const own = (() => {
    try {
      return ownMoveFlows(movesSrc());
    } catch {
      return [];
    }
  })();
  const base = alignMemo(withConfirmed(mergeChainFlows(pending.length ? [...flows, ...pending] : flows, chainSrc())));
  return own.length ? [...base, ...own].sort((a, b) => a[0] - b[0]) : base;
};
let comp: Comp | null = null;
/**
 * Each wallet's own worth at every sample (16 Nov 2026, MAIN for enrique: every card's "today" is that wallet's real
 * worth change since 00:00 KST): [time, Polymarket (cash + claims + open bets), Solana spot copy (SOL + coins),
 * Solana spot rules, Solana perps], dollars, null = not read.
 */
export type WalletPoint = [number, number | null, number | null, number | null, number | null, (number | null)?];
let wallHist: WalletPoint[] = [];
/** The wallets in WalletPoint order, with the label their deposits and withdrawals carry. */
export const WALLETS = [["poly", "Polymarket"], ["sc", "Solana spot copy"], ["sr", "Solana spot rules"], ["pp", "Solana perps"], ["hl", "Hyperliquid"]] as const;
/** A wallet the overview's sum can do without while it has no reading from 00:00 (Hyperliquid, 17 Nov 2026: new). */
const OPTIONAL = new Set<string>(["hl"]);
/**
 * TODAY FOR EACH WALLET: its worth now against its last sample at or before 00:00 KST (the first sample of the day when
 * none is older, as just after this began), less what was put in or taken out of that wallet since. at = the sample
 * compared with. Pure.
 */
export function walletsToday(wh: WalletPoint[], fl: Flow[], now: (number | null)[], t: number): Record<string, { usd: number; at: number } | null> {
  const T = kstMidnight(t);
  const out: Record<string, { usd: number; at: number } | null> = {};
  WALLETS.forEach(([k, label], i) => {
    const v = now[i];
    let b: WalletPoint | null = null;
    for (const p of wh) {
      if (p[i + 1] == null) continue;
      if (p[0] <= T || !b) b = p;
      if (p[0] > T) break;
    }
    // no reading from near midnight: no "today" for this wallet (16 Nov 2026, enrique: "since 18:03, how is that a
    // thing"); the page shows the settled figure, labelled so
    // a wallet made today (Hyperliquid, 17 Nov 2026): it held nothing at 00:00, so its today is what it is worth now
    // less everything put into it since 00:00. Only for a wallet with no reading at all from before today.
    if (v != null && b && b[0] > T + 30 * 60e3 && OPTIONAL.has(k)) {
      const put0 = fl.reduce((a, f) => a + (f[2] === label && f[0] > T && f[0] <= t ? f[1] : 0), 0);
      return void (out[k] = { usd: Math.round((v - put0) * 100) / 100, at: T });
    }
    if (v == null || !b || b[0] > T + 30 * 60e3) return void (out[k] = null);
    const put = fl.reduce((a, f) => a + (f[2] === label && f[0] > b![0] && f[0] <= t ? f[1] : 0), 0);
    out[k] = { usd: Math.round((v - (b[i + 1] as number) - put) * 100) / 100, at: b[0] };
  });
  return out;
}

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
    // a claim can leave the "waiting" side a few samples before the cash shows it: compare with the most that was
    // waiting over the last samples, not only the last one
    if (d >= 20 && b.pk - Math.max(a.pk, ...(a.pkh ?? [])) > -0.5 * d) out.push([t, r2(d), "Polymarket"]);
    if (d <= -20 && b.pst - a.pst < 0.5 * -d && b.pk - a.pk < 0.5 * -d) out.push([t, r2(d), "Polymarket"]);
  }
  if (px != null) {
    if (a && a.sol != null && b.sol != null) {
      const d = (b.sol - a.sol) * px;
      const dc = (b.coins - a.coins) * px;
      if (Math.abs(d) >= 5 && !(Math.sign(dc) === -Math.sign(d) && Math.abs(dc) >= 0.5 * Math.abs(d))) out.push([t, r2(d), "Solana spot copy"]);
    }
    for (const [k, label, pk] of [["rules", "Solana spot rules", "rulesPos"], ["perps", "Solana perps", "perpsPos"]] as const) {
      const now = b[k];
      if (now == null) continue;
      const was = a ? a[k] : null;
      const d = was == null ? now : now - was;
      // a position opened or closed between the two readings moves money between the wallet's cash and the position,
      // and the two are read at slightly different times: not a deposit or a withdrawal (17 Nov 2026, enrique: "didnt
      // do those deposits", a perps open read as +$11.06 deposited and its close as -$11.98 withdrawn)
      const moved = a != null && Math.abs((b[pk] ?? 0) - (a[pk] ?? 0)) >= 0.5;
      if (was == null ? d >= 0.5 : Math.abs(d) >= 5 && !moved) out.push([t, r2(d), label]);
    }
  }
  // Hyperliquid (17 Nov 2026): money comes in only as ETH enrique sends on Arbitrum, and the bot only ever spends ETH
  // (swap, gas), so its funding run keeps a running total of every rise in the ETH held (hlIn, dollars). A rise of that
  // total is a deposit; swapping, moving USDC into Hyperliquid and trading move money inside the wallet. A wallet seen
  // for the first time counts whole.
  if (b.hl != null) {
    if (a?.hl == null) {
      if (b.hl >= 0.5) out.push([t, r2(b.hl), "Hyperliquid"]);
    } else if (a.hlIn != null && b.hlIn != null && b.hlIn - a.hlIn >= 0.5) out.push([t, r2(b.hlIn - a.hlIn), "Hyperliquid"]);
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
/**
 * DEPOSITS BOOKED BEFORE THE WORTH SHOWED THEM (22 Nov 2026, MAIN: the 7 d figure went from +$117.77 to -$32.83 in an
 * hour while the worth barely moved). A deposit is booked at its confirmed time, but the wallet's worth can show the
 * money only some samples later; every sample in between was lifted by the deposit without holding it, so a window
 * starting there counted the deposit as a gain. Each deposit or withdrawal of $20 or more is moved to just before the
 * first live sample (within a day) that steps by half of it from the sample before; when no such step is found it stays
 * where it was. Moves between our own wallets are not passed here. Pure.
 */
export function alignFlows(series: [number, number, ...unknown[]][], fl: Flow[]): Flow[] {
  if (series.length < 2) return fl;
  return fl
    .map((f): Flow => {
      if (Math.abs(f[1]) < 20) return f;
      // the first STEP between two live samples (15 min apart at most, neither an hourly estimate) of half the flow or
      // more, in its direction, from the last sample at or before it to a day after: where the worth took the money in.
      // A step, not a rise from the sample before: the hourly estimates before the live samples are too rough to
      // measure from (22 Nov 2026: the 15 Nov 08:37Z deposits sat there and were not moved).
      let j = 1;
      while (j < series.length && series[j][0] <= f[0]) j++;
      for (; j < series.length && series[j][0] <= f[0] + 86_400_000; j++) {
        const a = series[j - 1];
        const b = series[j];
        if (a[2] === 1 || b[2] === 1 || b[0] - a[0] > 15 * 60_000) continue;
        const d = b[1] - a[1];
        if (f[1] > 0 ? d >= 0.5 * f[1] : d <= 0.5 * f[1]) return b[0] - 1 > f[0] ? [b[0] - 1, f[1], f[2]] : f;
      }
      return f;
    })
    .sort((a, b) => a[0] - b[0]);
}
/** For the public status: each deposit or withdrawal the alignment moved, by wallet and minutes (no amount). */
function flowsMoved(): { wallet: string; at: number; min: number }[] {
  const before = withConfirmed(mergeChainFlows(pending.length ? [...flows, ...pending] : flows, chainSrc())).slice().sort((a, b) => a[0] - b[0]);
  const after = alignMemo(before);
  const out: { wallet: string; at: number; min: number }[] = [];
  for (const f of before) {
    const g = after.find((x) => x[2] === f[2] && x[1] === f[1] && x[0] >= f[0] && x[0] - f[0] <= 86_400_000);
    if (g && g[0] !== f[0]) out.push({ wallet: f[2], at: f[0], min: Math.round((g[0] - f[0]) / 60_000) });
  }
  return out;
}
let alignKey = "";
let alignOut: Flow[] = [];
function alignMemo(fl: Flow[]): Flow[] {
  if (!hist?.length) return fl;
  const first = hist[0][0];
  const key = `${hist.length}:${hist[hist.length - 1][0]}:${back.length}:${JSON.stringify(fl)}`;
  if (key !== alignKey) {
    alignKey = key;
    alignOut = alignFlows([...back.filter((p) => p[0] < first), ...hist], fl);
  }
  return alignOut;
}
/** The series with money put in or taken out removed: each past point is lifted by what was put in after it. */
export function netOfFlows<T extends [number, number, ...unknown[]]>(h: T[], fl: Flow[]): T[] {
  return h.map((p) => {
    const add = fl.reduce((a, f) => a + (f[0] > p[0] ? f[1] : 0), 0);
    return add ? ([p[0], Math.round((p[1] + add) * 100) / 100, ...p.slice(2)] as unknown as T) : p;
  });
}
/**
 * WON EVENT BETS WAITING FOR THEIR CLAIM (15 Nov 2026, enrique: "is it real that we've lost 62usd in 24h??"). A won
 * bet left the open bets when it settled and its money reached the cash only with the claim, up to hours later (one
 * claim transaction every 3 hours). In between it was counted nowhere, and when a batch of $20+ was claimed the cash
 * step was taken for a deposit and taken OFF the result. A span is one won bet: [settled, claimed (Infinity = not
 * yet), payout in dollars].
 */
export type WinSpan = [number, number, number];
export function winSpans(rows: { shares?: number; pay?: number | null; settledAt?: number | null; conditionId?: string | null }[], claims: Record<string, { at?: number; tx?: string | null } | undefined>): WinSpan[] {
  const out: WinSpan[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !((r.shares ?? 0) > 0) || !((r.pay ?? 0) > 0) || r.settledAt == null) continue;
    const c = claims[r.conditionId ?? ""];
    out.push([r.settledAt, c?.tx ? (c.at ?? r.settledAt) : Infinity, (r.shares ?? 0) * (r.pay ?? 0)]);
  }
  return out;
}
/** Dollars won and not yet claimed at time T. */
export const unclaimedAt = (spans: WinSpan[], T: number) => Math.round(spans.reduce((a, s) => a + (s[0] <= T && s[1] > T ? s[2] : 0), 0) * 100) / 100;
/** Dollars claimed between two times. */
const claimedBetween = (spans: WinSpan[], from: number, to: number) => spans.reduce((a, s) => a + (s[1] >= from && s[1] <= to ? s[2] : 0), 0);
function loadSpans(): WinSpan[] {
  try {
    return winSpans(loadJson<Parameters<typeof winSpans>[0]>("eventlive.json", []), loadJson<Parameters<typeof winSpans>[1]>("eventlive-claims.json", {}));
  } catch {
    return [];
  }
}
/**
 * The one-time repair of what was already kept: every sample gets the wins that were waiting at its time, and a
 * "deposit" that was a claim (half or more of it claimed in the quarter hour before it) is taken off the list. Pure.
 */
export function repairClaims(h: [number, number][], fl: Flow[], spans: WinSpan[]): { hist: [number, number][]; flows: Flow[]; removed: number; removedUsd: number } {
  const hist = h.map((p) => [p[0], Math.round((p[1] + unclaimedAt(spans, p[0])) * 100) / 100] as [number, number]);
  const keep = fl.filter((f) => !(f[1] > 0 && (f[2] === "Polymarket" || f[2] === "deposit") && claimedBetween(spans, f[0] - 15 * 60_000, f[0] + 2 * 60_000) >= 0.5 * f[1]));
  const gone = fl.filter((f) => !keep.includes(f));
  return { hist, flows: keep, removed: gone.length, removedUsd: Math.round(gone.reduce((a, f) => a + f[1], 0) * 100) / 100 };
}
let fix: { removed: number; removedUsd: number } | null = null;
type Point = [number, number] | [number, number, 1];
/** The series the page draws: the hourly estimates before the live samples, then the live samples thinned to about
 * 300 points, deposits and withdrawals left out. */
function pageSeries(): Point[] {
  if (!hist) return [];
  const step = Math.max(1, Math.ceil(hist.length / 300));
  const first = hist.length ? hist[0][0] : Infinity;
  const series: Point[] = [...back.filter((p) => p[0] < first), ...despike(hist).filter((_, i, a) => i % step === 0 || i === a.length - 1)];
  return netOfFlows(series, effFlows());
}
/**
 * The windows of the page's "estimated total worth" panel (1 h, 24 h, 7 d, then "since" its first point), worked out
 * exactly as the page does: the worth now against the last point at or before the window's start. est = that point is
 * an hourly estimate (the page shows "≈"). 16 Nov 2026, enrique: "how do u go from telling me polymarket +20 to
 * polymarket -10": every review quotes these windows only, so they must be the page's own numbers. Pure.
 */
export function worthWindows(h: Point[], total: number, now: number): { k: string; usd: number; est: boolean; from: number }[] {
  if (h.length < 2) return [];
  const out: { k: string; usd: number; est: boolean; from: number; b: Point }[] = [];
  for (const [k, w] of [["1h", 3_600_000], ["24h", 86_400_000], ["7d", 604_800_000]] as const) {
    const T = now - w;
    if (h[0][0] > T + w * 0.1) continue;
    let b = h[0];
    for (const p of h) {
      if (p[0] <= T) b = p;
      else break;
    }
    out.push({ k, usd: Math.round((total - b[1]) * 100) / 100, est: b[2] === 1, from: T, b });
  }
  if (!out.length || out[out.length - 1].b !== h[0]) out.push({ k: "since", usd: Math.round((total - h[0][1]) * 100) / 100, est: h[0][2] === 1, from: h[0][0], b: h[0] });
  return out.map(({ k, usd, est, from }) => ({ k, usd, est, from }));
}
/** 00:00 KST (UTC+9) of the day that holds `now`. */
export function kstMidnight(now: number): number {
  return Math.floor((now + 9 * 3_600_000) / 86_400_000) * 86_400_000 - 9 * 3_600_000;
}
/**
 * TODAY = the real worth change since 00:00 KST (16 Nov 2026, enrique: "and whats the real since midnight? like the
 * today ... im just wondering if that is correct"). The cards' "today" counts bets settled today at their full profit,
 * so a bet that had already risen before midnight shows its whole win today; at 17:15 KST they said +$14.66 while the
 * worth had fallen about $19.50. This is the worth now against the last sample at or before midnight, deposits and
 * withdrawals left out, every sample kept (not the page's thinned series). at = that sample's time: later than `from`
 * only when no sample before midnight exists, and then the change covers less than the day. Pure.
 */
export function worthToday(h: Point[], total: number, now: number): { usd: number; est: boolean; from: number; at: number } | null {
  if (!h.length) return null;
  const T = kstMidnight(now);
  let b = h[0];
  for (const p of h) {
    if (p[0] <= T) b = p;
    else break;
  }
  return { usd: Math.round((total - b[1]) * 100) / 100, est: b[2] === 1, from: T, at: b[0] };
}
/**
 * THE REAL WORTH CHANGE OF EACH KST DAY (16 Nov 2026, enrique on the day-by-day panel: "do u realise u still have
 * this", the settled +$17 beside a real -$19). A day = its last point at or before the next 00:00 KST (now for today)
 * against its last point at or before its own 00:00; with no point before the day began, its first point, and the day
 * is `part` (it covers less than the whole day). The series is net of deposits; est = an hourly estimate was used.
 * Newest first, `n` days at most. Pure.
 */
export function worthDays(h: Point[], total: number | null, now: number, n = 30): { day: string; usd: number; est: boolean; part: boolean }[] {
  const out: { day: string; usd: number; est: boolean; part: boolean }[] = [];
  if (!h.length) return out;
  const dayOf = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
  for (let m = kstMidnight(now), i = 0; i < n && m + 86_400_000 > h[0][0]; m -= 86_400_000, i++) {
    let a: Point | null = null;
    let b: Point | null = null;
    for (const p of h) {
      if (p[0] <= m) a = p;
      else if (!a && p[0] < m + 86_400_000) a = p;
      if (p[0] <= m + 86_400_000) b = p;
    }
    if (!a || !b || a[0] >= m + 86_400_000) continue;
    const end = i === 0 && total != null ? total : b[1];
    out.push({ day: dayOf(m), usd: Math.round((end - a[1]) * 100) / 100, est: a[2] === 1 || (i > 0 && b[2] === 1), part: a[0] > m + 30 * 60_000 });
  }
  return out;
}
/** The same for each wallet, from its own samples and its own deposits. now = the wallets' worth now. Pure. */
export function walletDays(wh: WalletPoint[], fl: Flow[], now: (number | null)[], t: number, n = 30): Record<string, Record<string, { usd: number; part: boolean }>> {
  const out: Record<string, Record<string, { usd: number; part: boolean }>> = {};
  if (!wh.length) return out;
  const dayOf = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
  for (let m = kstMidnight(t), d = 0; d < n && m + 86_400_000 > wh[0][0]; m -= 86_400_000, d++) {
    const row: Record<string, { usd: number; part: boolean }> = {};
    WALLETS.forEach(([k, label], i) => {
      let a: WalletPoint | null = null;
      let b: WalletPoint | null = null;
      for (const p of wh) {
        if (p[i + 1] == null) continue;
        if (p[0] <= m) a = p;
        else if (!a && p[0] < m + 86_400_000) a = p;
        if (p[0] <= m + 86_400_000) b = p;
      }
      // no reading from near that midnight: no worth change for this wallet that day (a part day would pass a few
      // hours off as the day; 16 Nov 2026: today's lines read +$8 against a day of -$20)
      if (!a || !b || a[0] > m + 30 * 60_000) return;
      const endT = d === 0 ? t : b[0];
      const end = d === 0 && now[i] != null ? (now[i] as number) : (b[i + 1] as number);
      const put = fl.reduce((x, f) => x + (f[2] === label && f[0] > a![0] && f[0] <= endT ? f[1] : 0), 0);
      row[k] = { usd: Math.round((end - (a[i + 1] as number) - put) * 100) / 100, part: a[0] > m + 30 * 60_000 };
    });
    if (Object.keys(row).length) out[dayOf(m)] = row;
  }
  return out;
}
/** The day-by-day panel's real figures, from the last full reading (the "today" rule). */
let dayMemo: { at: number; v: { worthDays: ReturnType<typeof worthDays>; walletDays: ReturnType<typeof walletDays> } } | null = null;
/**
 * When every wallet has its own change for the day, the day's change is their sum, so the overview and the four
 * wallet cards agree to the cent (16 Nov 2026, enrique: "not even this sums up properly"). Pure.
 */
export function sumOfWallets<T extends { usd: number }>(all: T | null, w: Record<string, { usd: number } | null>): T | null {
  if (!all || !WALLETS.every(([k]) => w[k] != null || OPTIONAL.has(k))) return all;
  return { ...all, usd: Math.round(WALLETS.reduce((a, [k]) => a + (w[k]?.usd ?? 0), 0) * 100) / 100 };
}
export function daySum<T extends { usd: number }>(d: T, w: Record<string, { usd: number }> | undefined): T & { summed?: boolean } {
  const s = sumOfWallets(d, w ?? {});
  return s === d ? d : { ...(s as T), summed: true };
}
/** Each open coin's worth for the total: its quote now, else its last quote (mem, updated here), else its cost once held
 * 30 min (a coin that never had a sale route). Only a fresh coin with no quote yet stays unpriced. */
export function priceCoins<C extends { worthSol: number | null; stakeSol?: number | null; name?: string; t?: number }>(open: C[], mem: Map<string, number>, now: number): C[] {
  return open.map((c) => {
    const k = `${c.name ?? ""}|${c.t ?? ""}`;
    if (c.worthSol != null) mem.set(k, c.worthSol);
    const last = mem.get(k);
    const old = c.t != null && now - c.t > 30 * 60_000;
    return { ...c, worthSol: c.worthSol ?? last ?? (old ? (c.stakeSol ?? 0.01) : null) };
  });
}
function dayView() {
  if (dayMemo && Date.now() - dayMemo.at < 60_000) return dayMemo.v;
  const w = wallHist[wallHist.length - 1];
  const wd = w ? walletDays(wallHist, effFlows(), w.slice(1) as (number | null)[], Date.now()) : {};
  const v = { worthDays: worthDays(fullSeries(), null, Date.now()).map((d) => daySum(d, wd[d.day])), walletDays: wd };
  dayMemo = { at: Date.now(), v };
  return v;
}
/** Every sample, spikes taken out as the page does, deposits and withdrawals left out. */
function fullSeries(): Point[] {
  if (!hist) return [];
  const first = hist.length ? hist[0][0] : Infinity;
  return netOfFlows<Point>([...back.filter((p) => p[0] < first), ...despike(hist)], effFlows());
}
/** For the public status: no balance and no deposit in it, only what the repair took off and the results (changes in
 * dollars, never the worth itself and never a percentage, which would give the worth away). */
export function worthCheck() {
  if (!hist || !memo?.v.total) return null;
  const series = netOfFlows([...back.filter((p) => p[0] < (hist![0]?.[0] ?? Infinity)), ...hist] as [number, number][], effFlows());
  const T = Date.now() - 86_400_000;
  const base = [...series].reverse().find((p) => p[0] <= T);
  // the windows are measured from the last FULL reading (bets and coins priced, SOL balance read), never from a partial
  // one: none yet after a start means no windows rather than wrong ones (16 Nov 2026: 1 h read -$55 on a partial one)
  const now = full?.total ?? null;
  const windows: Record<string, { usd: number; est: boolean; from: number; at?: number }> = now == null ? {} : Object.fromEntries(worthWindows(pageSeries(), now, full!.at).map((w) => [w.k, { usd: w.usd, est: w.est, from: w.from }]));
  // the page's own figure, which keeps the last full reading through a partial one
  const today = memo.v.today?.all ?? null;
  if (today) windows.today = today as { usd: number; est: boolean; from: number; at: number };
  const tw = memo.v.today ?? {};
  const todayByWallet = Object.fromEntries(WALLETS.map(([k, label]) => [label, tw[k] ? { usd: tw[k]!.usd, at: tw[k]!.at } : null]));
  return { deposits: depositCheck(mergeChainFlows(flows, chainSrc()), Date.now() - 8 * 86_400_000), todayByWallet, claimStepsTakenForDeposits: fix?.removed ?? null, thatWasUsd: fix?.removedUsd ?? null, wonWaitingForClaimUsd: unclaimedAt(loadSpans(), Date.now()), change24hUsd: base && now != null ? Math.round((now - base[1]) * 100) / 100 : null, flows24h: flows.filter((f) => f[0] > T).length, windows, flowsMoved: flowsMoved(), worthAt: full?.at ?? null, notFull: whyNot };
}
let memo: { at: number; v: Worth } | null = null;
/** The dashboard's last worth reading and the deposits and withdrawals it takes out of its windows (src/truthcheck.ts). */
export const worthLast = () => memo?.v ?? null;
export const worthFlows = () => flows.slice(); // the chart's own detection, for the truth check to judge
/** The last full reading's total (see worthCheck). */
let full: { at: number; total: number } | null = null;
/** Why the last reading was not a full one (counts and yes/no only, no balance): 19 Nov 2026, the windows stayed blank
 * for hours after a restart and the status could not say which part failed. */
let whyNot: { at: number; betsN: number; betsPriced: number; coinsPriced: boolean; solRead: boolean; cashRead: boolean } | null = null;
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
  const spansNow = loadSpans();
  let i = 0;
  for (let T = Math.ceil(Math.max(bal[0].t, firstLive - 7 * 86_400_000) / 3_600_000) * 3_600_000; T < firstLive; T += 3_600_000) {
    while (i + 1 < bal.length && bal[i + 1].t <= T) i++;
    const open = bets.reduce((a, r) => a + (r.t <= T && (r.pnl == null || (r.settledAt ?? r.t) > T) ? r.cost : 0), 0) + unclaimedAt(spansNow, T);
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

/**
 * A claim is not a deposit (18 Nov 2026: the claimer collected $28.5 of wins from Polymarket's own list at 00:12 KST;
 * the cash rose while the waiting list still held them until the next truth check, so the step was booked as money
 * put in and taken off "today", which read -$33 on +$3 settled). A Polymarket money-in within 15 minutes after, or 2
 * before, a claim transaction is dropped. Pure.
 */
const CLAIM_FLOWS_FROM = Date.UTC(2026, 10, 17, 14, 0);
export function dropClaimFlows(fl: Flow[], claimTimes: number[]): Flow[] {
  // only from the day the claimer began claiming from Polymarket's own list: older claims are handled by repairClaims,
  // and a real deposit that happened near a claim (15 Nov 2026) must stay one
  return fl.filter((f) => !(f[1] > 0 && f[2] === "Polymarket" && f[0] >= CLAIM_FLOWS_FROM && claimTimes.some((t) => f[0] >= t - 2 * 60_000 && f[0] <= t + 15 * 60_000)));
}
const claimTimes = () => Object.values(loadJson<Record<string, { at?: number; tx?: string | null }>>("eventlive-claims.json", {})).filter((d) => d?.tx && Number.isFinite(d.at)).map((d) => d.at as number);
/** Samples in [from, to] take column col of the first sample after to that has it. Pure. */
export function flatten<P extends (number | null | undefined)[]>(h: P[], from: number, to: number, col: number): P[] {
  const after = h.find((p) => (p[0] as number) > to && p[col] != null);
  if (!after) return h;
  return h.map((p) => ((p[0] as number) >= from && (p[0] as number) <= to && p[col] != null ? (Object.assign([...p], { [col]: after[col] }) as P) : p));
}
const r2w = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
/**
 * data/wallet-seed.json (server only): wallet readings rebuilt by hand for times before the wallet samples began, as
 * [time ms, Polymarket, spot copy, spot rules, perps] in dollars (null = not known). Only points earlier than the first
 * real sample are taken, so a seed never overrides a reading.
 */
const SEED = "wallet-seed.json";
const COINS = "worth-coins.json";
const coinPx = new Map<string, number>(Object.entries(loadJson<Record<string, number>>(COINS, {})).filter(([, v]) => Number.isFinite(v)));
let coinPxSaved = 0;
export function withSeed(wh: WalletPoint[], seed: unknown): WalletPoint[] {
  if (!Array.isArray(seed)) return wh;
  const first = wh.length ? wh[0][0] : Infinity;
  const ok = (x: unknown) => x == null || (typeof x === "number" && Number.isFinite(x));
  const add = seed.filter((p): p is WalletPoint => Array.isArray(p) && (p.length === 5 || p.length === 6) && typeof p[0] === "number" && Number.isFinite(p[0]) && p[0] < first && p.slice(1).every(ok))
    .map((p) => [p[0], p[1] ?? null, p[2] ?? null, p[3] ?? null, p[4] ?? null, p[5] ?? null] as WalletPoint)
    .sort((a, b) => a[0] - b[0]);
  return add.length ? [...add, ...wh] : wh;
}
/** Each wallet's worth in WalletPoint order. */
function wallNow(cash: number | null, claim: number, bets: number, sol: number | null, rules: number | null, perps: number | null, hl: number | null): [number | null, number | null, number | null, number | null, number | null] {
  return [cash == null ? null : r2w(cash + claim + bets), r2w(sol), r2w(rules), r2w(perps), r2w(hl)];
}
/** rules / perps = what the two strategy wallets hold in dollars (null = not read). */
export async function worthView(cash: number | null, claim: number, solBal: number | null, extra: { rulesSol?: number | null; rulesUsdc?: number | null; perpsSol?: number | null; perpsUsdc?: number | null; rulesHeldSol?: number; perpsPosUsd?: number; hl?: { eth: number; usdc: number; hlUsd: number; ethUsd: number; inTransitUsdc: number; ethInUsd: number } | null } = {}): Promise<Worth & { age: number; hist: ([number, number] | [number, number, 1])[]; flows: Flow[] }> {
  if (!hist) {
    const f = loadJson<[number, number][] | { hist?: [number, number][]; back?: [number, number, 1][]; flows?: Flow[]; comp?: Comp | null; v?: number; fix?: { removed: number; removedUsd: number } | null; wall?: WalletPoint[] }>(FILE, []);
    wallHist = Array.isArray(f) ? [] : (f.wall ?? []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]));
    wallHist = withSeed(wallHist, loadJson<unknown>(SEED, []));
    flows = Array.isArray(f) ? [] : (f.flows ?? []);
    comp = Array.isArray(f) ? null : (f.comp ?? null);
    const needJumps = Array.isArray(f) || (f.v ?? 0) < 2;
    hist = (Array.isArray(f) ? f : (f.hist ?? [])).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    back = Array.isArray(f) ? [] : (f.back ?? []);
    hist = despike(hist);
    // 16 Nov 2026 17:24-18:00 KST: after two restarts the spot copy's coins went unpriced and counted as nothing (fixed
    // in 235fa6ad), so those samples read up to $58 low with about $3 really lost. Taken out, so that no window (1 h,
    // today, a card's today) is measured from them. Done at every load; nothing else falls in that half hour.
    const badFrom = Date.UTC(2026, 10, 16, 8, 24);
    const badTo = Date.UTC(2026, 10, 16, 9, 0);
    hist = hist.filter((p) => p[0] < badFrom || p[0] > badTo);
    wallHist = wallHist.filter((p) => p[0] < badFrom || p[0] > badTo);
    // 17 Nov 2026 23:40-00:42 KST: Polymarket's won-and-unclaimed list was first counted (src/pmredeem.ts) and the
    // claimer then claimed those wins while the list still held them, so the samples counted them twice, up to about
    // $28 high, and the 00:00 KST reading was taken from them ("today" read -$30 on +$3 settled). Those samples take
    // the first clean reading after them, so today is measured from 00:42 KST. Done at every load.
    hist = flatten(hist, Date.UTC(2026, 10, 17, 14, 40), Date.UTC(2026, 10, 17, 15, 42), 1);
    wallHist = flatten(wallHist, Date.UTC(2026, 10, 17, 14, 40), Date.UTC(2026, 10, 17, 15, 42), 1);
    if (needJumps) flows = flowsFromJumps(hist);
    if (Array.isArray(f) || (f.v ?? 0) < 3) {
      const rep = repairClaims(hist, flows, loadSpans());
      hist = rep.hist;
      flows = rep.flows;
      fix = { removed: rep.removed, removedUsd: rep.removedUsd };
      back = []; // the hourly estimates are made again, with the waiting wins in them
    } else fix = f.fix ?? null;
    flows = dropClaimFlows(flows, claimTimes());
    // 5e243720 (18 Nov 2026) dropped the 15 Nov 10:53 KST money-in by mistake (a claim was near it). It is put back
    // from the series' own jump at that time (the amount stays on this machine).
    const lostAt = Date.UTC(2026, 10, 15, 1, 53, 5);
    if (!flows.some((f) => f[2] === "deposit" && Math.abs(f[0] - lostAt) < 5 * 60_000)) {
      const back1 = flowsFromJumps(hist.filter((p) => Math.abs(p[0] - lostAt) <= 20 * 60_000)).filter((f) => Math.abs(f[0] - lostAt) < 5 * 60_000);
      if (back1.length) flows = [...flows, ...back1].sort((a, b) => a[0] - b[0]);
    }
  }
  claim += unclaimedAt(loadSpans(), Date.now());
  // won money Polymarket shows redeemable that our books do not have waiting (src/pmredeem.ts, 17 Nov 2026)
  try {
    claim += extraUnclaimed(loadPmRedeemable(), loadJson("eventlive.json", []), loadJson("eventlive-claims.json", {}), pmRedeemableAt());
  } catch {
    /* no list: our own books only */
  }
  if (!memo || Date.now() - memo.at > 15_000) {
    const [bets, px, slow] = await Promise.all([openWorth().catch(() => ({ n: 0, positions: 0, stake: 0, value: 0, priced: 0, days: {} })), solUsd(), solSlowView().catch(() => null)]);
    const open0 = ((slow as { open?: { stage: string; worthSol: number | null; stakeSol?: number | null; name?: string; t?: number }[] } | null)?.open ?? []).filter((c) => c.stage !== "waiting");
    // A coin whose quote fails this time keeps its last price (kept across restarts); one never priced at all and held
    // over 30 min counts at cost, as it has every time, so it moves nothing. 17 Nov 2026: dead coins with no sale route
    // kept every reading "partial", so after a restart no today showed anywhere for hours.
    const open = priceCoins(open0, coinPx, Date.now());
    if (Date.now() - coinPxSaved > 120_000) {
      coinPxSaved = Date.now();
      const keep = new Set(open0.map((c) => `${c.name ?? ""}|${c.t ?? ""}`));
      for (const k of [...coinPx.keys()]) if (!keep.has(k)) coinPx.delete(k);
      saveJson(COINS, Object.fromEntries(coinPx));
    }
    // A coin whose sale could not be priced this time counts at what it cost, and a SOL balance that could not be read
    // keeps its last reading. Both used to count as nothing: after the 17:25 restart on 16 Nov 2026 the coins' quotes
    // were refused for a while and the worth read $58 lower in one sample, with about $3 really lost.
    const coinsSol = open.reduce((a, c) => a + (c.worthSol ?? c.stakeSol ?? 0.01), 0);
    // not a reading when the coins counted at cost stand for more than a tenth of what the coins cost (and 3+ coins)
    const unpricedSol = open.reduce((a, c) => a + (c.worthSol == null ? (c.stakeSol ?? 0.01) : 0), 0);
    const coinsPriced = unpricedSol <= Math.max(0.06, 0.1 * open.reduce((a, c) => a + (c.stakeSol ?? 0.01), 0));
    const solNow = solBal ?? comp?.sol ?? null;
    const solPart = px != null ? ((solNow ?? 0) + coinsSol) * px : 0;
    // Unpriced bets fall back to what was paid: with more than a tenth unpriced (bets, or the spot copy's coins), or the
    // SOL balance not read, the total is not a reading, so it is shown but not added to the chart.
    const priced = (bets.n === 0 || bets.priced >= bets.n * 0.9) && coinsPriced && solBal != null;
    // A strategy wallet that could not be read this time keeps its last reading, so the total does not dip.
    const usd = (sol: number | null | undefined, usdc: number | null | undefined, last: number | null) => ((sol == null || usdc == null) && last != null ? last : sol == null && usdc == null ? null : px != null || !sol ? (sol ?? 0) * (px ?? 0) + (usdc ?? 0) : last);
    // In positions: the coins the spot rules hold and the perps collateral with its result so far. Counted in the
    // wallet's worth so that opening a position does not read as money leaving it.
    const rulesPos = px != null ? Math.round((extra.rulesHeldSol ?? 0) * px * 100) / 100 : 0;
    const perpsPos = Math.round((extra.perpsPosUsd ?? 0) * 100) / 100;
    const rulesUsd = usd(extra.rulesSol == null ? null : extra.rulesSol + (extra.rulesHeldSol ?? 0), extra.rulesUsdc, comp?.rules ?? null);
    const perpsUsd = usd(extra.perpsSol, extra.perpsUsdc == null ? null : extra.perpsUsdc + perpsPos, comp?.perps ?? null);
    // What each strategy wallet's figure is made of, in dollars, for the card's tooltip (null = that read failed).
    const d2 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100) / 100);
    const parts = {
      rules: { sol: d2(extra.rulesSol == null || px == null ? null : extra.rulesSol * px), usdc: d2(extra.rulesUsdc), pos: rulesPos },
      perps: { sol: d2(extra.perpsSol == null || px == null ? null : extra.perpsSol * px), usdc: d2(extra.perpsUsdc), pos: perpsPos },
    };
    // Hyperliquid: the account there (positions at their value) + USDC + money on its way there + ETH at its price; a
    // failed read keeps the last one
    const h = extra.hl;
    const hlUsd = h && h.ethUsd > 0 ? Math.round((h.hlUsd + h.usdc + h.inTransitUsdc + h.eth * h.ethUsd) * 100) / 100 : (comp?.hl ?? null);
    const total = cash != null ? Math.round((cash + claim + bets.value + solPart + (rulesUsd ?? 0) + (perpsUsd ?? 0) + (hlUsd ?? 0)) * 100) / 100 : null;
    const wn = wallNow(cash, claim, bets.value, px != null ? solPart : null, rulesUsd, perpsUsd, hlUsd);
    // Money put in shows in the total at once, but was booked as a deposit only with the next chart sample (up to 2 min
    // later): in between, every window read it as a gain (17 Nov 2026: enrique's $46.70 into Hyperliquid read as 1 h
    // +$52.97). The deposits since the last sample are now worked out at every reading and taken out at once.
    const hadPending = pending.length > 0;
    pending = [];
    if (total != null && priced) {
      const c0: Comp = { pc: cash, pk: claim + bets.value, pst: bets.stake, sol: solBal ?? comp?.sol ?? null, coins: coinsSol, rules: rulesUsd, perps: perpsUsd, pkh: comp ? [...(comp.pkh ?? []), comp.pk].slice(-10) : [], rulesPos, perpsPos, hl: hlUsd, hlIn: h && h.ethUsd > 0 ? h.ethInUsd : (comp?.hlIn ?? null) };
      pending = [...flowsBetween(comp ? { ...comp, rules: null, perps: null, hl: null } : null, { ...c0, rules: null, perps: null, hl: null }, px, Date.now()), ...flowsBetween(comp ? { ...comp, pc: null, sol: null } : { pc: null, pk: 0, pst: 0, sol: null, coins: 0, rules: null, perps: null }, { ...c0, pc: null, sol: null }, 1, Date.now())];
    }
    if (pending.length || hadPending) dayMemo = null;
    const all = total != null ? worthToday(fullSeries(), total, Date.now()) : null;
    // a partial reading (bets or coins not priced, the SOL balance not read) gives no new "today": the last full one is
    // kept, as the chart keeps no sample from it (16 Nov 2026: after a restart unpriced coins read as -$84 today)
    const wt = priced ? walletsToday(wallHist, effFlows(), wn, Date.now()) : null;
    const today = wt ? { all: sumOfWallets(all, wt), ...wt } : (memo?.v.today ?? undefined);
    memo = { at: Date.now(), v: { at: Date.now(), total, cash, claim, bets: bets.value, betsN: bets.n, betsPos: bets.positions, betsStake: bets.stake, days: bets.days, solBal, coinsSol: Math.round(coinsSol * 1e4) / 1e4, coinsN: open.length, solUsd: px, rulesUsd, perpsUsd, hlUsd, parts: { ...parts, hl: h && h.ethUsd > 0 ? { eth: Math.round(h.eth * h.ethUsd * 100) / 100, usdc: Math.round((h.usdc + h.inTransitUsdc) * 100) / 100, account: h.hlUsd } : null }, rulesPos, perpsPos, today } };
    if (total != null && priced) full = { at: Date.now(), total };
    whyNot = total != null && priced ? null : { at: Date.now(), betsN: bets.n, betsPriced: bets.priced, coinsPriced, solRead: solBal != null, cashRead: cash != null };
    const last = hist[hist.length - 1];
    if (total != null && priced && (!last || Date.now() - last[0] >= 120_000)) {
      pending = [];
      // rules / perps are kept in dollars here, so their px is 1; the SOL wallet is kept in SOL
      const nowC: Comp = { pc: cash, pk: claim + bets.value, pst: bets.stake, sol: solBal ?? comp?.sol ?? null, coins: coinsSol, rules: rulesUsd, perps: perpsUsd, pkh: comp ? [...(comp.pkh ?? []), comp.pk].slice(-10) : [], rulesPos, perpsPos, hl: hlUsd, hlIn: h && h.ethUsd > 0 ? h.ethInUsd : (comp?.hlIn ?? null) };
      const solOnly = flowsBetween(comp ? { ...comp, rules: null, perps: null, hl: null } : null, { ...nowC, rules: null, perps: null, hl: null }, px, Date.now());
      const extraOnly = flowsBetween(comp ? { ...comp, pc: null, sol: null } : { pc: null, pk: 0, pst: 0, sol: null, coins: 0, rules: null, perps: null }, { ...nowC, pc: null, sol: null }, 1, Date.now());
      flows.push(...solOnly, ...extraOnly);
      flows = dropClaimFlows(flows, claimTimes());
      flows = flows.filter((f) => f[0] > Date.now() - 8 * 86_400_000);
      comp = nowC;
      hist.push([Date.now(), total]);
      if (hist.length > 5040) hist = hist.slice(-5040); // a week at one sample every two minutes
      wallHist.push([Date.now(), ...wallNow(cash, claim, bets.value, px != null ? solPart : null, rulesUsd, perpsUsd, hlUsd)]);
      if (wallHist.length > 1500) wallHist = wallHist.slice(-1500); // two days
      if (!back.length) {
        try {
          back = backfill(hist[0][0], solBal, px);
        } catch {
          back = [];
        }
      }
      saveJson(FILE, { hist, back, flows, comp, fix, wall: wallHist, v: 3 });
    }
  }
  return { ...memo.v, age: Date.now() - memo.at, hist: pageSeries(), flows: effFlows(), ...dayView() };
}
