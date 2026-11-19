/**
 * PAPER ONLY (enrique, 19 Nov 2026 14:05 KST: "okay paper test it"): funding carry on Hyperliquid. Hold a coin on spot
 * and short the same amount of it on Hyperliquid perps: the price cancels out, and the short is paid the funding rate
 * every hour while it is positive (and pays it when negative). Nothing is signed or sent.
 *
 * Two places for the spot half, each its own pretend book of BOOK_USD:
 *   hl      spot bought on Hyperliquid itself (few coins)
 *   kraken  spot bought on Kraken (his Kraken Pro account, 19 Nov 14:07 KST), short on Hyperliquid
 * and for each a plain "always hold BTC" book to compare a picking rule against.
 *
 * Honest sizes: half of a position's money buys the spot, the other half backs a 1x short, so funding is earned on
 * HALF the money. Every cost is taken: taker fees on both halves in and out, a slip on each, on Kraken the higher fee
 * and the cost of moving money between the two places.
 */
export const BOOK_USD = 1000;
export const POS_USD = 250;
export const MAX_POS = 4;
/** per side, of the amount traded */
export const FEES = {
  hlPerp: 0.00045,
  hlSpot: 0.0007,
  hlSlip: 0.0003,
  kraken: 0.004,
  krakenSlip: 0.0005,
  /** moving money between Kraken and Hyperliquid: once when a Kraken book starts, and again each time a short needs more margin */
  krakenMoveUsd: 4,
  krakenTopUpUsd: 1,
};
export const ENTER_APR_7D = 0.12;
export const ENTER_APR_1D = 0.08;
export const EXIT_APR_3D = 0.04;
export const MIN_HOLD_H = 24;
export const MIN_SAMPLES = 48;
export const PERP_VOL_MIN = 5_000_000;
export const SPOT_VOL_MIN = 500_000;
/** a spot price further than this from the perp is not the same coin (or a broken reading) */
export const SAME_COIN = 0.03;
const HOUR = 3_600_000;
const YEAR_H = 24 * 365;

export type Venue = "hl" | "kraken";
export type Perp = { funding: number; px: number; volUsd: number };
export type Spot = { px: number; volUsd: number };
export type Market = { perps: Record<string, Perp>; hl: Record<string, Spot>; kraken: Record<string, Spot> };
export type Pos = { coin: string; at: number; size: number; spotEntry: number; perpEntry: number; fundingUsd: number; feesUsd: number; lastMs: number; spotNow: number; perpNow: number; topUps?: number };
export type Closed = { coin: string; at: number; closedAt: number; fundingUsd: number; basisUsd: number; feesUsd: number; netUsd: number };
export type Book = { id: string; venue: Venue; fixed?: string; startedAt?: number; open: Pos[]; closed: Closed[]; setupUsd: number };
export type CarryState = { books: Book[]; fund: Record<string, [number, number][]>; lastMs?: number; error?: string; krakenError?: string };

export const newBooks = (): Book[] => [
  { id: "hl-pick", venue: "hl", open: [], closed: [], setupUsd: 0 },
  { id: "kraken-pick", venue: "kraken", open: [], closed: [], setupUsd: 0 },
  { id: "hl-btc", venue: "hl", fixed: "BTC", open: [], closed: [], setupUsd: 0 },
  { id: "kraken-btc", venue: "kraken", fixed: "BTC", open: [], closed: [], setupUsd: 0 },
];

const num = (x: unknown) => {
  const n = x === null || x === undefined || x === "" ? NaN : Number(x);
  return Number.isFinite(n) ? n : null;
};

/** Hyperliquid metaAndAssetCtxs -> every listed perp with its hourly funding, price and day volume. */
export function readPerps(answer: unknown): Record<string, Perp> {
  const [meta, ctxs] = Array.isArray(answer) ? (answer as [{ universe?: { name?: string; isDelisted?: boolean }[] }, Record<string, unknown>[]]) : [null, null];
  const out: Record<string, Perp> = {};
  if (!Array.isArray(meta?.universe) || !Array.isArray(ctxs)) return out;
  meta.universe.forEach((u, i) => {
    const c = ctxs[i];
    const funding = num(c?.funding);
    const px = num(c?.midPx) ?? num(c?.markPx);
    if (!u?.name || u.isDelisted || funding === null || !px) return;
    out[u.name] = { funding, px, volUsd: num(c?.dayNtlVlm) ?? 0 };
  });
  return out;
}

/** Hyperliquid spotMetaAndAssetCtxs -> coins sold for USDC there, under their perp name (UBTC is BTC, and so on). */
export function readHlSpot(answer: unknown, perps: Record<string, Perp>): Record<string, Spot> {
  const [meta, ctxs] = Array.isArray(answer) ? (answer as [{ tokens?: { name?: string; index?: number }[]; universe?: { name?: string; tokens?: number[] }[] }, Record<string, unknown>[]]) : [null, null];
  const out: Record<string, Spot> = {};
  if (!Array.isArray(meta?.tokens) || !Array.isArray(meta?.universe) || !Array.isArray(ctxs)) return out;
  const tok = new Map(meta.tokens.map((t) => [t.index, String(t.name ?? "")]));
  const ctx = new Map(ctxs.map((c) => [String(c?.coin ?? ""), c]));
  for (const u of meta.universe) {
    if (!Array.isArray(u?.tokens) || tok.get(u.tokens[1]) !== "USDC") continue;
    const base = tok.get(u.tokens[0]) ?? "";
    const c = ctx.get(String(u.name ?? ""));
    const px = num(c?.midPx) ?? num(c?.markPx);
    if (!base || !px) continue;
    // the same coin under its perp name: as it is, or without the bridged "U" (UBTC, UETH, USOL); the price must agree
    const perp = [base, base.replace(/^U(?=[A-Z0-9]{2,})/, "")].find((n) => perps[n] && Math.abs(px / perps[n].px - 1) <= SAME_COIN);
    if (!perp) continue;
    const s = { px, volUsd: num(c?.dayNtlVlm) ?? 0 };
    if (!out[perp] || s.volUsd > out[perp].volUsd) out[perp] = s;
  }
  return out;
}

const KRAKEN_NAMES: Record<string, string> = { XBT: "BTC", XDG: "DOGE" };
/** Kraken's public ticker (every pair) -> coins sold for US dollars there that Hyperliquid has a perp for, same price. */
export function readKraken(answer: unknown, perps: Record<string, Perp>): Record<string, Spot> {
  const res = (answer as { result?: Record<string, { a?: unknown[]; b?: unknown[]; v?: unknown[] }> } | null)?.result;
  const out: Record<string, Spot> = {};
  if (!res || typeof res !== "object") return out;
  for (const [pair, t] of Object.entries(res)) {
    const m = /^X([A-Z]{3,4})ZUSD$/.exec(pair) ?? /^([A-Z0-9]{2,10})USD$/.exec(pair);
    if (!m) continue;
    const coin = KRAKEN_NAMES[m[1]] ?? m[1];
    const ask = num(t?.a?.[0]);
    const bid = num(t?.b?.[0]);
    const vol = num(t?.v?.[1]);
    const p = perps[coin];
    if (!p || !ask || !bid || vol === null) continue;
    const px = (ask + bid) / 2;
    if (Math.abs(px / p.px - 1) > SAME_COIN) continue;
    out[coin] = { px, volUsd: vol * px };
  }
  return out;
}

/** Yearly rate from the hourly samples of the last `hours`; null with too few. */
export function apr(samples: [number, number][] | undefined, nowMs: number, hours: number): number | null {
  const xs = (samples ?? []).filter((s) => nowMs - s[0] <= hours * HOUR);
  if (xs.length < Math.min(MIN_SAMPLES, hours) / 2) return null;
  return (xs.reduce((a, s) => a + s[1], 0) / xs.length) * YEAR_H;
}

/** One hourly sample per coin, a week kept. */
export function remember(st: CarryState, perps: Record<string, Perp>, coins: string[], nowMs: number): void {
  for (const c of coins) {
    const xs = (st.fund[c] ??= []);
    if (perps[c] && (!xs.length || nowMs - xs[xs.length - 1][0] >= 0.9 * HOUR)) xs.push([nowMs, perps[c].funding]);
    while (xs.length && nowMs - xs[0][0] > 7.5 * 24 * HOUR) xs.shift();
  }
  for (const c of Object.keys(st.fund)) if (!coins.includes(c) && !st.books.some((b) => b.open.some((p) => p.coin === c))) delete st.fund[c];
}

/** Hyperliquid fundingHistory -> hourly samples. */
export function readHistory(answer: unknown): [number, number][] {
  if (!Array.isArray(answer)) return [];
  return (answer as { time?: unknown; fundingRate?: unknown }[]).map((r) => [num(r?.time), num(r?.fundingRate)] as [number | null, number | null]).filter((r): r is [number, number] => r[0] !== null && r[1] !== null).sort((a, b) => a[0] - b[0]);
}

const sideCost = (v: Venue) => (v === "hl" ? FEES.hlPerp + FEES.hlSpot + 2 * FEES.hlSlip : FEES.hlPerp + FEES.hlSlip + FEES.kraken + FEES.krakenSlip);
const basis = (p: Pos) => p.size * (p.spotNow - p.spotEntry) - p.size * (p.perpNow - p.perpEntry);
/** what closing now would cost: both halves sold at today's prices */
const closeCost = (p: Pos, v: Venue) => ((p.size * (p.spotNow + p.perpNow)) / 2) * sideCost(v);

function open(b: Book, coin: string, m: Market, nowMs: number): void {
  const spot = m[b.venue][coin];
  const perp = m.perps[coin];
  if (!spot || !perp) return;
  const half = POS_USD / 2;
  if (b.venue === "kraken" && !b.startedAt) b.setupUsd += FEES.krakenMoveUsd;
  b.startedAt ??= nowMs;
  b.open.push({ coin, at: nowMs, size: half / spot.px, spotEntry: spot.px, perpEntry: perp.px, fundingUsd: 0, feesUsd: half * sideCost(b.venue), lastMs: nowMs, spotNow: spot.px, perpNow: perp.px });
}

function close(b: Book, p: Pos, nowMs: number): void {
  const fees = p.feesUsd + closeCost(p, b.venue);
  b.closed.push({ coin: p.coin, at: p.at, closedAt: nowMs, fundingUsd: p.fundingUsd, basisUsd: basis(p), feesUsd: fees, netUsd: p.fundingUsd + basis(p) - fees });
  b.open = b.open.filter((x) => x !== p);
  if (b.closed.length > 300) b.closed.splice(0, b.closed.length - 300);
}

/** The coins a picking book would hold, best week first. */
export function wanted(st: CarryState, m: Market, v: Venue, nowMs: number): string[] {
  return Object.keys(m[v])
    .filter((c) => m.perps[c] && m.perps[c].volUsd >= PERP_VOL_MIN && m[v][c].volUsd >= SPOT_VOL_MIN)
    .map((c) => ({ c, w: apr(st.fund[c], nowMs, 168), d: apr(st.fund[c], nowMs, 24), n: (st.fund[c] ?? []).length }))
    .filter((x) => x.n >= MIN_SAMPLES && x.w !== null && x.d !== null && x.w >= ENTER_APR_7D && x.d >= ENTER_APR_1D)
    .sort((a, b) => (b.w as number) - (a.w as number))
    .map((x) => x.c);
}

/** One look: pay the funding since the last one, mark prices, close what no longer pays, open what does. */
export function tick(st: CarryState, m: Market, nowMs: number): void {
  for (const b of st.books) {
    for (const p of [...b.open]) {
      const perp = m.perps[p.coin];
      const spot = m[b.venue][p.coin];
      if (perp) {
        // the short is paid (or pays) the hour's rate on what it is worth now; a gap after a stop is paid at today's rate, six hours at most
        const hours = Math.min(6, Math.max(0, (nowMs - p.lastMs) / HOUR));
        p.fundingUsd += hours * perp.funding * p.size * perp.px;
        p.perpNow = perp.px;
        // the short's margin is gone at about double the entry: more is sent before that (a transfer when the spot is on Kraken)
        const need = Math.floor(Math.max(0, perp.px / p.perpEntry - 1) / 0.3);
        if (need > (p.topUps ?? 0)) {
          if (b.venue === "kraken") p.feesUsd += FEES.krakenTopUpUsd * (need - (p.topUps ?? 0));
          p.topUps = need;
        }
      }
      if (spot) p.spotNow = spot.px;
      p.lastMs = nowMs;
      if (b.fixed) continue;
      const heldH = (nowMs - p.at) / HOUR;
      const a3 = apr(st.fund[p.coin], nowMs, 72);
      if (!perp || !spot || (heldH >= MIN_HOLD_H && a3 !== null && a3 < EXIT_APR_3D)) close(b, p, nowMs);
    }
    if (b.fixed) {
      if (!b.open.length) open(b, b.fixed, m, nowMs);
      continue;
    }
    for (const c of wanted(st, m, b.venue, nowMs)) {
      if (b.open.length >= MAX_POS) break;
      if (!b.open.some((p) => p.coin === c)) open(b, c, m, nowMs);
    }
  }
  st.lastMs = nowMs;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const pc = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 10);
export function summary(st: CarryState, m: Market | null, nowMs: number) {
  const books = st.books.map((b) => {
    const opens = b.open.map((p) => {
      const cc = closeCost(p, b.venue);
      return { coin: p.coin, t: p.at, paid: POS_USD, fundingUsd: r2(p.fundingUsd), basisUsd: r2(basis(p)), feesUsd: r2(p.feesUsd + cc), usd: r2(p.fundingUsd + basis(p) - p.feesUsd - cc), held: Math.round((nowMs - p.at) / 60_000), aprNow: m?.perps[p.coin] ? pc(m.perps[p.coin].funding * YEAR_H) : null };
    });
    const closedUsd = b.closed.reduce((s, c) => s + c.netUsd, 0);
    const usd = closedUsd + opens.reduce((s, o) => s + o.usd, 0) - b.setupUsd;
    const days = b.startedAt ? (nowMs - b.startedAt) / 86_400_000 : 0;
    return {
      id: b.id,
      venue: b.venue,
      fixed: b.fixed ?? null,
      startedAt: b.startedAt ?? null,
      days: r2(days),
      bookUsd: b.fixed ? POS_USD : BOOK_USD,
      inUseUsd: opens.length * POS_USD,
      usd: r2(usd),
      fundingUsd: r2(b.closed.reduce((s, c) => s + c.fundingUsd, 0) + b.open.reduce((s, p) => s + p.fundingUsd, 0)),
      feesUsd: r2(b.closed.reduce((s, c) => s + c.feesUsd, 0) + opens.reduce((s, o) => s + o.feesUsd, 0) + b.setupUsd),
      closed: b.closed.length,
      won: b.closed.filter((c) => c.netUsd > 0).length,
      opens,
      log: b.closed.slice(-30).reverse().map((c) => ({ coin: c.coin, t: c.closedAt, usd: r2(c.netUsd), fundingUsd: r2(c.fundingUsd), feesUsd: r2(c.feesUsd), held: Math.round((c.closedAt - c.at) / 60_000) })),
    };
  });
  const rates = m
    ? Object.keys(m.perps)
        .filter((c) => m.hl[c] || m.kraken[c])
        .map((c) => ({ coin: c, now: pc(m.perps[c].funding * YEAR_H), d1: pc(apr(st.fund[c], nowMs, 24)), d7: pc(apr(st.fund[c], nowMs, 168)), hl: !!m.hl[c], kraken: !!m.kraken[c], n: (st.fund[c] ?? []).length }))
        .filter((x) => x.d7 !== null)
        .sort((a, b) => (b.d7 as number) - (a.d7 as number))
        .slice(0, 12)
    : [];
  return {
    paper: true,
    lastMs: st.lastMs ?? null,
    posUsd: POS_USD,
    rule: { enter7dPct: ENTER_APR_7D * 100, enter1dPct: ENTER_APR_1D * 100, exit3dPct: EXIT_APR_3D * 100, roundTripPct: { hl: r2(200 * sideCost("hl")), kraken: r2(200 * sideCost("kraken")) } },
    spotCoins: m ? { hl: Object.keys(m.hl).length, kraken: Object.keys(m.kraken).length } : null,
    books,
    rates,
    error: st.error ?? null,
    krakenError: st.krakenError ?? null,
  };
}
