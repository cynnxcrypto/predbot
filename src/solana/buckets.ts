/**
 * PAPER ONLY: rules and copy results in five buckets. Nothing is sent, no wallet is touched. SOLANA_BUCKETS=off disables.
 *
 * Where it comes from (15 Nov 2026, enrique: "develop paper strats for spot high caps, midcaps, low caps and memes -
 * and for perps. on top of it, dont forget to do paper copytrading of all of these"; "make the most out of our api
 * keys"). The history test of the same morning (research/perps-ideas.py, 84 perp rules) found no rule on SOL, BTC
 * or ETH that survives costs, so nothing here is expected to win: the smaller coins have no stored history, and
 * paper at real quotes is the only honest test of them. Copying is where the few decent results came from.
 *
 * SPOT (four buckets by market value: high $1B+, mid $100M-1B, low $10M-100M, memes under $10M):
 *   coins from Jupiter's lists, priced once a minute with Jupiter's price service, kept as 5-minute closes.
 *   A rule buys on a 5-minute close; the buy is priced with a REAL QUOTE for a $50 swap taken after the signal,
 *   and the sale with a real quote for the swap back. Fees and price impact are inside the quotes. No instant prices.
 * PERPS (SOL, BTC, ETH; shorts first): hourly Binance candles, filled at the price of the moment the hour's close
 *   is read, charged what Jupiter Perps charges (0.07% a side, borrow 0.0016% an hour).
 * COPY, spot: the paper copies of the day-holder study (slow.ts) sorted into the same four buckets by the coin.
 * COPY, perps: traders from Hyperliquid's public leaderboard (the only perp venue with public trader histories):
 *   a position they open is copied on paper at the price we read after seeing it, charged the Solana venue's costs.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../config.js";
import { SOL, USDC } from "./pools.js";
import { posRet, type Pos } from "./slow.js";
import { entryGapPct, gapStats, parseCandles, skillOf, SKILL_MIN_N, SKILL_MIN_PERIODS_AHEAD, SKILL_MIN_T, SKILL_PERIODS, type Candles as BtcCandles, type Skill, type Trip } from "../hyperliquid/skill.js";
import { hlHttp } from "../hyperliquid/ratelog.js";

export type Bucket = "high" | "mid" | "low" | "meme";
export const BUCKETS: readonly Bucket[] = ["high", "mid", "low", "meme"];
export const BUCKET_TEXT: Record<Bucket, string> = { high: "High caps ($1B+, with SOL and wrapped BTC, ETH and other majors)", mid: "Mid caps ($100M-1B)", low: "Low caps ($10M-100M)", meme: "Memes and micro caps (under $10M)" };
export const bucketOf = (mcap: number): Bucket => (mcap >= 1e9 ? "high" : mcap >= 1e8 ? "mid" : mcap >= 1e7 ? "low" : "meme");
/** how much wilder a bucket moves than the big coins: every rule's thresholds are multiplied by this */
export const SCALE: Record<Bucket, number> = { high: 1, mid: 1.5, low: 2.5, meme: 5 };

// ---- sizes (the Jupiter key is shared with the real copy: stay far inside it) ---------------------------------------
export const PER_BUCKET = 100;
export const MIN_LIQ_USD = 50_000;
export const MIN_VOL_USD = 100_000;
export const MIN_AGE_MS = 3 * 86_400_000;
const MEME_MIN_AGE_MS = 6 * 3_600_000;
const MEME_MIN_LIQ_USD = 30_000;
const UNIVERSE_MS = 6 * 3_600_000;
export const SLOT_MS = 300_000;
const KEEP_SLOTS = 300; // 25 hours of 5-minute closes
export const STAKE_USD = 50;
export const TX_USD = 0.01;
export const MAX_OPEN_PER_RULE = 4;
const COOLDOWN_MS = 2 * 3_600_000;
const UNSELLABLE_MS = 6 * 3_600_000;
/** Jupiter requests a day this module may make (prices, lists, quotes). 100 coins a bucket priced each minute is about 11,500. */
export const JUP_DAY = () => Number(process.env.SOLANA_BUCKETS_JUP_DAY) || 60_000;
const KEEP_TRADES = 4000;

// ---- coins -------------------------------------------------------------------------------------------------------------
export interface Coin {
  mint: string;
  symbol: string;
  /** Jupiter's name and tags, cleaned: shown in the status so a coin in the wrong bucket can be spotted */
  name: string;
  tags: string[];
  bucket: Bucket;
  mcap: number;
  liq: number;
  vol: number;
}
const STABLE = /USD|EUR|^DAI$|^CASH$|^USX$|^UXD$|^FRAX$|^GHO$|^LUSD$|^HNST$/i;
const STABLE_NAME = /stable|dollar|\busd\b|\beuro?\b/i;
/** Pool and vault shares (JLP and the like): they are a basket with its own fees, not a coin. */
const POOL = /^JLP$|^[A-Z]*LP$|-LP$|^[A-Za-z0-9]+-[A-Za-z0-9]+$/;
const POOL_NAME = /\blp\b|liquidity|\bpool\b|\bvault\b|\bperps?\b/i;
/** Tickers of shares that are sold tokenised without any label in the name or tags (NIO was one). */
const STOCK_TICKERS: ReadonlySet<string> = new Set(["NVDA", "TSLA", "AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "NFLX", "COIN", "MSTR", "HOOD", "SPY", "QQQ", "TTWO", "NIO", "CRCL", "GME", "AMD", "INTC", "PLTR", "BABA", "ORCL", "AVGO", "TSM", "UBER", "DIS", "JPM", "GLD", "SLV", "TLT", "IWM", "SPCX", "SNDK"]);
/**
 * Coins that live on other chains, or are simply big everywhere: Jupiter's market value counts only the supply that
 * sits on Solana (wrapped ETH came out as a low cap), so these are high caps by name. Only a VERIFIED coin with real
 * liquidity gets the name's credit: anyone can mint a token called BTC.
 */
export const MAJORS: ReadonlySet<string> = new Set(["SOL", "BTC", "CBBTC", "ZBTC", "XBTC", "TBTC", "ETH", "CBETH", "HYPE", "ZEC", "BNB", "XRP", "DOGE", "TRX", "ADA", "LINK", "AVAX", "SUI", "LTC", "XMR", "TON", "NEAR", "DOT", "UNI", "AAVE", "SHIB", "PEPE", "BCH", "XLM", "HBAR"]);
/** BTC, wBTC, WETH, wNEAR: the name with or without the "wrapped" letter. */
export const isMajor = (symbol: string) => {
  const s = symbol.toUpperCase();
  return MAJORS.has(s) || (s.startsWith("W") && MAJORS.has(s.slice(1)));
};
const MAJOR_MIN_LIQ_USD = 500_000;
/**
 * Tokenised shares and funds (NVDA, TTWO, NIO turned up among the memes): they follow a stock exchange, not the
 * crypto market, and trade thinly outside its hours. Left out. Told by the issuer's tags, by the name, or by the
 * issuer's suffix on a ticker (NVDAx, NVDAon).
 */
export function isStock(x: Record<string, unknown>): boolean {
  const tags = Array.isArray(x.tags) ? x.tags.map(String) : [];
  if (tags.some((t) => /stock|rwa|equit|etf|ondo|backed|treasur/i.test(t))) return true;
  if (/xstock|tokeni[sz]ed|\bondo\b|\bstock\b|\bshares?\b|\betf\b|\b(inc|corp|corporation|plc|ltd|holdings)\b\.?/i.test(String(x.name ?? ""))) return true;
  const sym = String(x.symbol ?? "");
  return /^[A-Z]{1,5}(x|on)$/.test(sym) || STOCK_TICKERS.has(sym.toUpperCase());
}
/** Jupiter token rows -> tradable coins with a bucket. Stables, staked SOL, pool shares, tokenised stocks, thin or new coins are left out. */
export function bucketCoins(rows: unknown, nowMs: number): Coin[] {
  if (!Array.isArray(rows)) return [];
  const out: Coin[] = [];
  for (const x of rows as Record<string, unknown>[]) {
    const mint = typeof x?.id === "string" ? x.id : null;
    if (!mint || mint === USDC || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) continue;
    const symbol = String(x.symbol ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || mint.slice(0, 4);
    const tags = Array.isArray(x.tags) ? x.tags.map(String) : [];
    if (isStock(x)) continue;
    const rawName = String(x.name ?? "");
    if (STABLE_NAME.test(rawName) || POOL.test(String(x.symbol ?? "")) || POOL_NAME.test(rawName) || tags.some((t) => /^lp$|stable/i.test(t))) continue;
    if (tags.includes("lst") || STABLE.test(symbol) || (symbol.length > 3 && symbol.toUpperCase().endsWith("SOL"))) continue;
    const mcap = Number(x.mcap);
    const liq = Number(x.liquidity);
    const st = x.stats24h as { buyVolume?: unknown; sellVolume?: unknown } | undefined;
    const vol = Number(st?.buyVolume) + Number(st?.sellVolume);
    if (!(mcap > 0) || !(liq > 0) || !(vol > 0)) continue;
    const verified = x.isVerified === true || tags.includes("verified");
    const major = mint === SOL || (verified && liq >= MAJOR_MIN_LIQ_USD && isMajor(symbol));
    const bucket = major ? "high" : bucketOf(mcap);
    const created = Date.parse(String((x.firstPool as { createdAt?: unknown } | undefined)?.createdAt ?? ""));
    const age = Number.isFinite(created) ? nowMs - created : null;
    if (bucket === "meme" ? liq < MEME_MIN_LIQ_USD || (age !== null && age < MEME_MIN_AGE_MS) : liq < MIN_LIQ_USD || (age !== null && age < MIN_AGE_MS)) continue;
    if (vol < MIN_VOL_USD) continue;
    out.push({ mint, symbol, name: rawName.replace(/[^A-Za-z0-9 .()&-]/g, "").slice(0, 40), tags: tags.map((t) => t.replace(/[^A-Za-z0-9-]/g, "").slice(0, 24)).slice(0, 8), bucket, mcap, liq, vol });
  }
  return out;
}
/** The busiest PER_BUCKET coins of each bucket, one row a mint. */
export function pickUniverse(coins: Coin[]): Coin[] {
  const seen = new Map<string, Coin>();
  for (const c of coins) if (!seen.has(c.mint) || seen.get(c.mint)!.vol < c.vol) seen.set(c.mint, c);
  return BUCKETS.flatMap((b) => [...seen.values()].filter((c) => c.bucket === b).sort((a, z) => z.vol - a.vol).slice(0, PER_BUCKET));
}

// ---- spot rules ---------------------------------------------------------------------------------------------------------
export interface SpotRule {
  key: string;
  kind: "dip" | "mom" | "brk" | "mktdip";
  /** 5-minute closes looked back over */
  look: number;
  /** % move that sets it off, before the bucket's scale */
  move: number;
  target: number | null;
  stop: number | null;
  holdMin: number;
  text: string;
}
export const SPOT_RULES: SpotRule[] = [
  { key: "dip1h", kind: "dip", look: 12, move: 2, target: 2, stop: null, holdMin: 240, text: "Buys after a fall in one hour; sells on the bounce or after 4 hours." },
  { key: "dip24h", kind: "dip", look: 288, move: 6, target: 4, stop: null, holdMin: 1440, text: "Buys after a fall in a day; sells on the bounce or after a day." },
  { key: "mktdip1h", kind: "mktdip", look: 12, move: 2, target: 2, stop: null, holdMin: 240, text: "Buys a coin that fell in one hour while SOL fell 1.5% too; sells on the bounce or after 4 hours." },
  { key: "mom1h", kind: "mom", look: 12, move: 2, target: 4, stop: 2, holdMin: 240, text: "Buys after a rise in one hour in a coin that is up on the day; target, stop, or 4 hours." },
  { key: "brk24h", kind: "brk", look: 288, move: 5, target: null, stop: 3, holdMin: 1440, text: "Buys a new 24 hour high in a coin that is up on the day; stop, or a day." },
];
export const SOL_MKT_FALL = 1.5;
export const ruleId = (b: Bucket, key: string) => `${b}-${key}`;
const ret = (p: number[], n: number): number | null => (p.length > n && p[p.length - 1 - n] > 0 ? p[p.length - 1] / p[p.length - 1 - n] - 1 : null);

/** Does the rule buy this coin on its newest 5-minute close? p = the coin's closes, sol = SOL's. */
export function spotSignal(rule: SpotRule, bucket: Bucket, p: number[], sol: number[]): boolean {
  const s = SCALE[bucket] / 100;
  const r = ret(p, rule.look);
  if (r === null) return false;
  if (rule.kind === "dip") return r <= -rule.move * s;
  if (rule.kind === "mktdip") {
    const rs = ret(sol, rule.look);
    return rs !== null && rs <= -SOL_MKT_FALL / 100 && r <= -rule.move * s;
  }
  const day = ret(p, 288);
  if (rule.kind === "mom") return r >= rule.move * s && day !== null && day > 0;
  // brk: the newest close is above every close of the 24 hours before it, and the day is up enough
  const last = p[p.length - 1];
  return r >= rule.move * s && p.slice(-1 - rule.look, -1).every((x) => x < last);
}
/** Does an open paper trade sell now? px = the price now, ref = the price when it bought. */
export function spotExit(rule: SpotRule, bucket: Bucket, ref: number, px: number, heldMs: number): "target" | "stop" | "time" | null {
  const s = SCALE[bucket] / 100;
  if (rule.target !== null && px >= ref * (1 + rule.target * s)) return "target";
  if (rule.stop !== null && px <= ref * (1 - rule.stop * s)) return "stop";
  return heldMs >= rule.holdMin * 60_000 ? "time" : null;
}

// ---- perp rules (Jupiter Perps costs) -----------------------------------------------------------------------------------
export const PERP_COINS = ["SOL", "BTC", "ETH"] as const;
export const PERP_FEE_SIDE = 0.0007;
export const PERP_BORROW_HOUR = 0.000016;
export const PERP_USD = 100;
export interface Candles {
  t: number[];
  h: number[];
  l: number[];
  c: number[];
}
export interface PerpRule {
  key: string;
  holdH: number;
  /** stays in until the opposite signal (holdH is then only a ceiling) */
  flip?: boolean;
  text: string;
  /** what the history test said (research/perps-ideas.py), in plain words */
  history: string;
  signal: (k: Candles, i: number) => -1 | 0 | 1;
}
const cr = (c: number[], i: number, n: number) => (i >= n ? c[i] / c[i - n] - 1 : NaN);
const mean = (c: number[], i: number, n: number) => (i + 1 >= n ? c.slice(i + 1 - n, i + 1).reduce((a, b) => a + b, 0) / n : NaN);
export const PERP_RULES: PerpRule[] = [
  {
    key: "short-down-week", holdH: 168, text: "Shorts for 7 days when the last 7 days and the last 30 days are both down (looked at once a day).",
    history: "+1.5% a trade in falling markets (66 trades, 44% won), loses in flat and rising ones. Rare.",
    signal: (k, i) => (k.t[i] % 24 === 23 && cr(k.c, i, 168) < 0 && cr(k.c, i, 720) < 0 ? -1 : 0),
  },
  {
    key: "short-bounce-falling", holdH: 24, text: "Shorts for a day after a 5% rise in a day while the last 30 days are down 10% or more.",
    history: "+0.41% a trade (338 trades, 54% won); won 2022, 2025, lost 2021, 2023.",
    signal: (k, i) => (cr(k.c, i, 24) >= 0.05 && cr(k.c, i, 720) < -0.1 ? -1 : 0),
  },
  {
    key: "short-bounce-under-avg", holdH: 12, text: "Shorts for 12 hours after a 3% rise in a day while the price is under its 7-day average.",
    history: "About zero (877 trades, +0.04% in falling markets).",
    signal: (k, i) => (cr(k.c, i, 24) >= 0.03 && k.c[i] < mean(k.c, i, 168) ? -1 : 0),
  },
  {
    key: "trend-7d", holdH: 168, text: "Long or short for 7 days, the way the last 7 days went (looked at once a week).",
    history: "SOL +3.8% a trade in 2025-26 (41 trades, 49% won); BTC and ETH about zero. Rare.",
    signal: (k, i) => (k.t[i] % 168 === 167 ? (Math.sign(cr(k.c, i, 168)) as -1 | 0 | 1) : 0),
  },
  {
    key: "break-24h", holdH: 720, flip: true, text: "Long on a close above the last 24 hours' high, short on a close below their low; held until the other one.",
    history: "SOL +0.16% a trade (163 a year, 37% won); BTC and ETH lose.",
    signal: (k, i) => {
      if (i < 24) return 0;
      const hi = Math.max(...k.h.slice(i - 24, i));
      const lo = Math.min(...k.l.slice(i - 24, i));
      return k.c[i] >= hi ? 1 : k.c[i] <= lo ? -1 : 0;
    },
  },
  {
    key: "short-pump-1h", holdH: 4, text: "Shorts for 4 hours after a 1.5% rise in one hour.",
    history: "Loses 0.09% a trade (880 a year). Kept as the frequent control.",
    signal: (k, i) => (cr(k.c, i, 1) >= 0.015 ? -1 : 0),
  },
  {
    key: "short-fall-1h", holdH: 4, text: "Shorts for 4 hours after a 1.5% fall in one hour.",
    history: "Loses 0.13% a trade (880 a year). Kept as the frequent control.",
    signal: (k, i) => (cr(k.c, i, 1) <= -0.015 ? -1 : 0),
  },
  // the long mirrors of the short rules (enrique, 15 Nov 2026 17:30 KST: "are we testing longs and shorts?")
  {
    key: "long-up-week", holdH: 168, text: "Longs for 7 days when the last 7 days and the last 30 days are both up (looked at once a day).",
    history: "Mirror of the down-week short; not tested apart. Rare, and silent while the market falls.",
    signal: (k, i) => (k.t[i] % 24 === 23 && cr(k.c, i, 168) > 0 && cr(k.c, i, 720) > 0 ? 1 : 0),
  },
  {
    key: "long-dip-rising", holdH: 24, text: "Longs for a day after a 5% fall in a day while the last 30 days are up 10% or more.",
    history: "Mirror of the bounce short; silent while the market falls.",
    signal: (k, i) => (cr(k.c, i, 24) <= -0.05 && cr(k.c, i, 720) > 0.1 ? 1 : 0),
  },
  {
    key: "long-dip-over-avg", holdH: 12, text: "Longs for 12 hours after a 3% fall in a day while the price is over its 7-day average.",
    history: "Mirror of the under-average short (about zero).",
    signal: (k, i) => (cr(k.c, i, 24) <= -0.03 && k.c[i] > mean(k.c, i, 168) ? 1 : 0),
  },
  {
    key: "long-fall-1h", holdH: 4, text: "Longs for 4 hours after a 1.5% fall in one hour (buys the dip).",
    history: "Loses about 0.1% a trade (880 a year). The frequent long control.",
    signal: (k, i) => (cr(k.c, i, 1) <= -0.015 ? 1 : 0),
  },
  {
    key: "long-pump-1h", holdH: 4, text: "Longs for 4 hours after a 1.5% rise in one hour (goes with the move).",
    history: "Loses about 0.1% a trade (880 a year). The frequent long control.",
    signal: (k, i) => (cr(k.c, i, 1) >= 0.015 ? 1 : 0),
  },
];

// ---- leverage on paper ------------------------------------------------------------------------------------------------------
// enrique, 15 Nov 2026 17:30 KST: "2x is gonna be almost nothing ... build a way to decide confidence on the trade to do
// variable leverage ... you can do odd numbers and decimals". Paper only: the real side keeps its 2x limit until he says.
/** The leverage tiers every closed paper trade is scored at. */
export const LEV_TIERS = [1.5, 2, 3, 5, 7.5, 10, 15, 20] as const;
/** The collateral one paper trade puts up at every tier, dollars: results are comparable across tiers. */
export const LEV_COLLATERAL_USD = 20;
/** Jupiter closes a position by force when what is left of the collateral, after the loss and the fees owed, is under
 *  about 0.2% of the position. On top of the fees this is the room that is lost. */
export const LIQ_BUFFER = 0.002;
/** How far the price may go against a position at `lev` before it is closed by force, as a fraction of the entry. */
export const liqMove = (lev: number, hours: number, feeSide = PERP_FEE_SIDE) => 1 / lev - 2 * feeSide - PERP_BORROW_HOUR * hours - LIQ_BUFFER;
/**
 * One trade at `lev`, as a fraction of the COLLATERAL: `net` is its result as a fraction of the position (after fees
 * and borrow), `worst` the furthest the price went against it while it was open. Liquidated = the collateral is gone,
 * whatever the price did afterwards.
 */
export function levResult(net: number, worst: number, hours: number, lev: number, feeSide = PERP_FEE_SIDE): { ret: number; liquidated: boolean } {
  if (worst >= liqMove(lev, hours, feeSide)) return { ret: -1, liquidated: true };
  return { ret: Math.max(-1, lev * net), liquidated: false };
}
/** Leverage by confidence score 0-4 (decimals on purpose). */
export const CONF_LEV = [1.5, 2.5, 4, 6.5, 10] as const;
/**
 * The confidence score of a trade, 0 to 4: one point for each of
 *  1. the last 7 days went the trade's way, 2. the last 30 days went the trade's way,
 *  3. the copied perp traders hold more dollars on the trade's side of this coin than against it,
 *  4. the market is quiet: the last 24 hours' range is under the median of the 30 days before (less room to be liquidated).
 * It is a guess fixed before any result. The paper table by score says whether a higher score really did better;
 * if it does not, the score is worth nothing and leverage must not follow it.
 */
export function perpConfidence(k: Candles, i: number, dir: number, tradersNet: number): number {
  let n = 0;
  if (i >= 168 && Math.sign(cr(k.c, i, 168)) === dir) n++;
  if (i >= 720 && Math.sign(cr(k.c, i, 720)) === dir) n++;
  if (Math.sign(tradersNet) === dir) n++;
  if (i >= 31 * 24) {
    const range = (e: number) => (Math.max(...k.h.slice(e - 23, e + 1)) - Math.min(...k.l.slice(e - 23, e + 1))) / k.c[e];
    const past = Array.from({ length: 30 }, (_, d) => range(i - 24 * (d + 1))).sort((a, b) => a - b);
    if (range(i) < (past[14] + past[15]) / 2) n++;
  }
  return n;
}
/** The furthest the price went against a position opened after candle hour `hour` at `entry`, in the closed candles since and at `px`. */
export function worstMove(k: Candles, hour: number, dir: number, entry: number, px: number): number {
  let w = Math.max(0, -dir * (px / entry - 1));
  for (let j = k.t.length - 1; j >= 0 && k.t[j] > hour; j--) w = Math.max(w, dir > 0 ? 1 - k.l[j] / entry : k.h[j] / entry - 1);
  return w;
}
interface LevRow {
  net: number;
  worst?: number;
  hours: number;
  dir: number;
  conf?: number;
  /** a copied trader's own leverage */
  lev?: number;
  fee?: number;
}
const levTally = (xs: LevRow[], lev: (t: LevRow) => number | undefined) => {
  let trades = 0, won = 0, liquidated = 0, sum = 0;
  for (const t of xs) {
    const L = lev(t);
    if (t.worst === undefined || !(L! > 0)) continue;
    const x = levResult(t.net, t.worst, t.hours, L!, t.fee);
    trades++;
    if (x.ret > 0) won++;
    if (x.liquidated) liquidated++;
    sum += x.ret;
  }
  return { trades, won, liquidated, netUsd: r(sum * LEV_COLLATERAL_USD), avgPctOfCollateral: trades ? r((sum / trades) * 100) : null };
};
/** Every tier side by side for one set of closed paper trades (only trades whose worst price was tracked). */
export function levTable(xs: LevRow[]) {
  return LEV_TIERS.map((lev) => ({ lev, ...levTally(xs, () => lev) }));
}
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? r(a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null;
};
/** One perp trade after Jupiter's fees and borrow, as a fraction of the position. */
export const perpNet = (dir: number, entry: number, exit: number, hours: number) => dir * (exit / entry - 1) - 2 * PERP_FEE_SIDE - PERP_BORROW_HOUR * hours;

/** Binance klines -> closed hourly candles, and the price now (the running candle's close). */
export function parseKlines(rows: unknown, now: number): { k: Candles; px: number | null } {
  const k: Candles = { t: [], h: [], l: [], c: [] };
  let px: number | null = null;
  if (!Array.isArray(rows)) return { k, px };
  for (const r of rows as unknown[][]) {
    const open = Number(r?.[0]);
    const close = Number(r?.[4]);
    if (!Number.isFinite(open) || !(close > 0)) continue;
    px = close;
    if (open + 3_600_000 > now) continue;
    k.t.push(Math.floor(open / 3_600_000));
    k.h.push(Number(r[2]));
    k.l.push(Number(r[3]));
    k.c.push(close);
  }
  return { k, px };
}

// ---- perp copy: Hyperliquid traders -------------------------------------------------------------------------------------
// enrique, 15 Nov 2026 18:23 KST: "for solana perps, do more for copying top traders, that might be way better than
// trying to come up with rules". The list went from 60 to 400 traders and smaller accounts are let in.
export const HL_FOLLOW = 400;
/** linked wallets followed on paper besides the list, at most */
export const HL_EXTRA_MAX = 20;
// enrique, 17 Nov 2026 23:10 KST: "they're playing with nothing", "find plenty of traders, with good track records,
// possibility to copy them, and balances that are not trivial". Traders are judged in DOLLARS: a $100k+ account,
// $10k+ made in the month and $50k+ all time. The month return floor went from 10% to 3%: at 10% a $2M account
// that made $100k was left out while a $25k account that made $2.5k was let in.
export const HL_MIN_ACCOUNT_USD = 100_000;
export const HL_MIN_MONTH_ROI = 0.03;
export const HL_MIN_MONTH_PNL = 10_000;
export const HL_MIN_ALL_PNL = 50_000;
export const HL_MAX_TURNOVER = 200; // month volume / account: above this it is a market maker or a bot
export const HL_MIN_POS_USD = 10_000;
export const HL_MAX_HOLD_MS = 14 * 86_400_000;
const HL_REFRESH_MS = 24 * 3_600_000;
/** traders looked at in one minute: those we hold a copy of (or have copied before) every minute, the rest in turns.
 *  One look costs 2 of Hyperliquid's 1,200 weight a minute for an address: 120 looks are 240, a fifth of it. */
const HL_PER_TICK = 120;
const HL_HOT_MAX = 50;
const HL_BATCH = 10;
/** A copied trader's own leverage is followed on paper up to this (decimals kept): above it the copy uses this. */
export const HL_LEV_CAP = 10;
/** The bar for ONE trader to be followed for real, the way Polymarket wallets go real: this many closed paper
 *  copies, half or more won, ahead after costs, and a day or more since the first of them. */
export const TRADER_MIN_COPIES = 20;
export const TRADER_MIN_AGE_MS = 24 * 3_600_000;
export const traderRule = (address: string) => `copy-${address.slice(2, 10)}`;
/** coins a Solana venue lists; SOL, BTC, ETH at Jupiter's price, the rest at an order book's (0.04% + spread) */
export const hlCost = (coin: string) => ((PERP_COINS as readonly string[]).includes(coin) ? PERP_FEE_SIDE : 0.0006);
export interface HlTrader {
  address: string;
  monthPnl: number;
  monthRoi: number;
  /** account value and all-time profit at the last leaderboard read (absent on rows saved before 17 Nov 2026) */
  acct?: number;
  allPnl?: number;
}
// ---- a trader's OWN history (enrique, 20 Nov 2026: "how come we have only found 4 traders in HL worth following, that
// sounds extremely off", then his tap "Yes, go real on history"). Of 405 followed traders 157 had been copied on paper
// and only 18 had reached 20 closed paper copies in 5 days: these traders hold for days, so the paper bar takes weeks.
// The SAME bar (20 closed, half won, ahead) is counted on the trader's own closed positions, read
// from Hyperliquid's fill record (the window is HIST_DAYS, 30 at first): only positions we would have copied ($10k+ at their largest, held 10 minutes or
// more, perps), each scored as its result after the trader's fees over its largest size, so every position weighs
// the same, as our fixed-size copies do. Our own paper copies still count against it: 5 or more and behind = no.
// 21 Nov 2026 08:15 KST, enrique: "sure yeah" to "look back 90 days instead of 30 for the same 20 closed, half won,
// ahead": of 381 histories read only 24 had 20 such positions closed in a month (they trade big, not often).
export const HIST_DAYS = 90;
export const HIST_MIN_HOLD_MS = 10 * 60_000;
export const HIST_REFRESH_MS = 24 * 3_600_000;
/** fill records read in one minute (20 of Hyperliquid's 1,200 weight each) */
const HIST_PER_TICK = 3;
const HIST_KEEP = 200;
/** 22 Nov 2026: histories now keep each position's side, open time and coin; older ones are read again */
const HIST_V = 2;
const BTC_REFRESH_MS = 6 * 3_600_000;
/** pages of 2,000 fills read from the start of the window; a trader with more gets its newest 2,000 as well */
const HIST_PAGES = 4;
export interface HlTrip { coin: string; openAt: number; closeAt: number; pct: number; dir: number }
/**
 * A trader's closed positions out of its fills (userFills or userFillsByTime rows, any order). A position counts from the fill that
 * opens it from nothing to the fill that brings it back to nothing (or turns it round); one already open at the first
 * fill we have is left out, its start was never seen.
 */
export function hlTrips(fills: unknown, sinceMs = 0): HlTrip[] {
  if (!Array.isArray(fills)) return [];
  const by = new Map<string, { t: number; px: number; d: number; start: number; pnl: number }[]>();
  const seen = new Set<string>();
  for (const f of fills as Record<string, unknown>[]) {
    const coin = typeof f?.coin === "string" ? f.coin : "";
    const [t, px, sz, start] = [Number(f?.time), Number(f?.px), Number(f?.sz), Number(f?.startPosition)];
    if (!coin || coin.startsWith("@") || coin.includes("/") || !(t > 0) || !(px > 0) || !(sz > 0) || !Number.isFinite(start) || (f.side !== "B" && f.side !== "A")) continue;
    // the same fill read twice (pages that overlap) counts once
    const key = `${coin}|${t}|${f.side}|${f.sz}|${f.startPosition}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pnl = (Number(f.closedPnl) || 0) - (Number(f.fee) || 0);
    by.set(coin, [...(by.get(coin) ?? []), { t, px, d: f.side === "B" ? sz : -sz, start, pnl }]);
  }
  const out: HlTrip[] = [];
  const zero = (v: number) => Math.abs(v) < 1e-9;
  for (const [coin, xs] of by) {
    xs.sort((a, b) => a.t - b.t);
    let trip: { openAt: number; peak: number; pnl: number; pos: number; dir: number } | null = null;
    for (const f of xs) {
      const after = f.start + f.d;
      // fills are missing between the last one and this (a gap between pages): the position is not followed across it
      if (trip && Math.abs(f.start - trip.pos) > 1e-6 * Math.max(1, Math.abs(trip.pos))) trip = null;
      if (zero(f.start)) trip = { openAt: f.t, peak: 0, pnl: 0, pos: 0, dir: Math.sign(f.d) };
      if (!trip) continue;
      trip.pos = after;
      trip.pnl += f.pnl;
      trip.peak = Math.max(trip.peak, Math.abs(f.start) * f.px, Math.abs(after) * f.px);
      const turned = !zero(after) && !zero(f.start) && Math.sign(after) !== Math.sign(f.start);
      if (zero(after) || turned) {
        if (trip.peak >= HL_MIN_POS_USD && f.t - trip.openAt >= HIST_MIN_HOLD_MS && f.t > sinceMs) out.push({ coin, openAt: trip.openAt, closeAt: f.t, pct: Math.round((trip.pnl / trip.peak) * 1e6) / 1e6, dir: trip.dir });
        // turned round: the other side starts here, but its fees and size are mixed into this fill: not counted
        trip = null;
      }
    }
  }
  return out.sort((a, b) => a.closeAt - b.closeAt);
}
/** The bar on a list of closed positions: [when closed, result]. */
export const histMeetsBar = (trips: Trip[], sinceMs: number, now: number, days = HIST_DAYS) => {
  const xs = trips.filter((x) => x[0] > Math.max(sinceMs, now - days * 86_400_000));
  return xs.length >= TRADER_MIN_COPIES && xs.filter((x) => x[1] > 0).length * 2 >= xs.length && xs.reduce((a, x) => a + x[1], 0) > 0;
};
/** The leaderboard -> traders worth following: ahead over the week, the month and all time, real size, not a machine. */
export function hlPick(board: unknown, limit = HL_FOLLOW): HlTrader[] {
  const rows = (board as { leaderboardRows?: unknown })?.leaderboardRows;
  if (!Array.isArray(rows)) return [];
  const out: HlTrader[] = [];
  for (const x of rows as Record<string, unknown>[]) {
    const address = typeof x?.ethAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(x.ethAddress) ? x.ethAddress.toLowerCase() : null;
    const acct = Number(x?.accountValue);
    if (!address || !(acct >= HL_MIN_ACCOUNT_USD) || !Array.isArray(x.windowPerformances)) continue;
    const w: Record<string, { pnl: number; roi: number; vlm: number }> = {};
    for (const e of x.windowPerformances as unknown[]) {
      if (!Array.isArray(e) || typeof e[0] !== "string") continue;
      const v = e[1] as Record<string, unknown>;
      w[e[0]] = { pnl: Number(v?.pnl), roi: Number(v?.roi), vlm: Number(v?.vlm) };
    }
    const { week, month, allTime } = w;
    if (!week || !month || !allTime) continue;
    if (!(week.pnl > 0) || !(month.pnl > 0) || !(month.pnl >= HL_MIN_MONTH_PNL) || !(allTime.pnl >= HL_MIN_ALL_PNL) || !(month.roi >= HL_MIN_MONTH_ROI)) continue;
    const turn = month.vlm / acct;
    if (!(turn >= 1) || turn > HL_MAX_TURNOVER) continue;
    out.push({ address, monthPnl: month.pnl, monthRoi: month.roi, acct, allPnl: allTime.pnl });
  }
  return out.sort((a, b) => b.monthPnl - a.monthPnl).slice(0, limit);
}
/**
 * SOL, BTC and ETH first (MAIN, 16 Nov 2026: Jupiter Perps offers only these three, so a trader cleared for real
 * whose copies are all on other coins never fills a real slot). Each trader of the leaderboard gets a tier:
 *  0: has copies on SOL, BTC or ETH, or was seen holding one of them in the last HL_MAJOR_DAYS days;
 *  1: not known yet (fewer than HL_OFF_MIN_COPIES copies and never seen holding one of them);
 *  2: HL_OFF_MIN_COPIES or more copies, none on these coins, never seen holding them: left out.
 * The list is the best of tier 0, then tier 1, by month profit, up to HL_FOLLOW.
 */
export const HL_OFF_MIN_COPIES = 10;
export const HL_MAJOR_DAYS = 30;
/**
 * The coins we can trade for real: the pool's three, and (17 Nov 2026) those of Jupiter's order book that Hyperliquid
 * traders hold too (gumlive.ts; the server's look listed BNB, HYPE, JUP, NEAR and ZEC besides the three).
 */
export const GUM_COINS = ["BNB", "HYPE", "JUP", "NEAR", "ZEC"] as const;
const onJupiter = (coin: string) => (PERP_COINS as readonly string[]).includes(coin) || (GUM_COINS as readonly string[]).includes(coin);
export function majorTier(address: string, now = Date.now()): 0 | 1 | 2 {
  const xs = [...state.hlTrades.filter((t) => t.trader === address), ...state.hlOpen.filter((o) => o.trader === address)];
  if (xs.some((t) => onJupiter(t.coin)) || now - (state.hlMajorSeen?.[address] ?? -Infinity) <= HL_MAJOR_DAYS * 86_400_000) return 0;
  return xs.length >= HL_OFF_MIN_COPIES ? 2 : 1;
}
const majorCopies = (address: string) => state.hlTrades.filter((t) => t.trader === address && onJupiter(t.coin)).length;
/** A trader's open positions out of a clearinghouseState answer: coin -> signed dollars. */
/**
 * A position already being followed stays followed down to this size. Without it a position worth about HL_MIN_POS_USD
 * went in and out of the list with every small price move, and each time was copied as a new trade and closed a
 * minute later (17 Nov 2026: three one-minute ATOM shorts for real on Hyperliquid, fees only, and the trader was cut
 * for them). It counts as closed when it is gone, turned round, or under this.
 */
export const HL_KEEP_POS_USD = 2_500;
export function hlPositions(state: unknown, held?: Record<string, number>): Record<string, number> | null {
  const rows = (state as { assetPositions?: unknown })?.assetPositions;
  if (!Array.isArray(rows)) return null;
  const out: Record<string, number> = {};
  for (const x of rows as { position?: Record<string, unknown> }[]) {
    const p = x?.position;
    const coin = typeof p?.coin === "string" && /^[A-Za-z0-9]{1,12}$/.test(p.coin) ? p.coin : null;
    const szi = Number(p?.szi);
    const val = Math.abs(Number(p?.positionValue));
    if (!coin || !Number.isFinite(szi) || szi === 0) continue;
    const following = held !== undefined && Math.sign(held[coin] ?? 0) === Math.sign(szi);
    if (!(val >= (following ? HL_KEEP_POS_USD : HL_MIN_POS_USD))) continue;
    out[coin] = Math.sign(szi) * val;
  }
  return out;
}
/** The leverage a trader has set on each open position (Hyperliquid's own number), out of a clearinghouseState answer. */
export function hlLeverage(state: unknown): Record<string, number> {
  const rows = (state as { assetPositions?: unknown })?.assetPositions;
  const out: Record<string, number> = {};
  if (!Array.isArray(rows)) return out;
  for (const x of rows as { position?: Record<string, unknown> }[]) {
    const p = x?.position;
    const lev = Number((p?.leverage as { value?: unknown })?.value);
    if (typeof p?.coin === "string" && lev >= 1 && lev <= 200) out[p.coin] = lev;
  }
  return out;
}
/** A trader's position sizes in coins (absolute), every coin it holds, out of a clearinghouseState answer. */
export function hlSizes(state: unknown): Record<string, number> {
  const rows = (state as { assetPositions?: unknown })?.assetPositions;
  const out: Record<string, number> = {};
  if (!Array.isArray(rows)) return out;
  for (const x of rows as { position?: Record<string, unknown> }[]) {
    const p = x?.position;
    const sz = Math.abs(Number(p?.szi));
    if (typeof p?.coin === "string" && sz > 0 && Number.isFinite(sz)) out[p.coin] = sz;
  }
  return out;
}
/**
 * A copy opened before sizes were kept (before 19 Nov 2026 22:07 KST) has no opening size, so the trader's partial
 * closes could not be followed (enrique, 19 Nov 2026 23:30 KST: "their traders havent taken profit? yesterday they
 * were way higher"). The trader's own fills since the copy opened give it back: the size it held when the copy opened
 * (the size now less all it bought and sold since) and its size after every fill since. Only used when that agrees
 * (within 2%) with the position Hyperliquid wrote on the first of those fills; else, or with no fills, or with a list
 * that may be cut short, the size now is the start (nothing is trimmed on a guess).
 */
export function hlSizeBack(fills: unknown, coin: string, dir: number, szNow: number): { sz0: number; hist: [number, number][] } {
  const none = { sz0: szNow, hist: [] as [number, number][] };
  if (!Array.isArray(fills) || fills.length >= 2000) return none;
  const rows = (fills as Record<string, unknown>[])
    .filter((f) => f?.coin === coin)
    .map((f) => ({ t: Number(f.time), start: Number(f.startPosition), d: (f.side === "B" ? 1 : f.side === "A" ? -1 : NaN) * Number(f.sz) }))
    .sort((x, y) => x.t - y.t);
  if (!rows.length || rows.length > 500 || rows.some((x) => !Number.isFinite(x.t) || !Number.isFinite(x.start) || !Number.isFinite(x.d))) return none;
  const sz0 = szNow - dir * rows.reduce((s, x) => s + x.d, 0);
  if (!(sz0 > 0) || !(szNow > 0) || !rows.some((x) => x.t === rows[0].t && Math.abs((dir * x.start) / sz0 - 1) <= 0.02)) return none;
  let sz = sz0;
  const hist = rows.map((x) => [x.t, Math.max(0, (sz += dir * x.d))] as [number, number]);
  return { sz0, hist };
}
/** The trader's account value on Hyperliquid (perps), or null. */
/** The trader's average entry price of each open position, out of a clearinghouseState answer: coin -> price. */
export function hlEntries(state: unknown): Record<string, number> {
  const rows = (state as { assetPositions?: unknown })?.assetPositions;
  const out: Record<string, number> = {};
  if (!Array.isArray(rows)) return out;
  for (const x of rows as { position?: Record<string, unknown> }[]) {
    const p = x?.position;
    const px = Number(p?.entryPx);
    if (typeof p?.coin === "string" && px > 0) out[p.coin] = px;
  }
  return out;
}
export function hlAccountValue(state: unknown): number | null {
  const v = Number((state as { marginSummary?: { accountValue?: unknown } })?.marginSummary?.accountValue);
  return Number.isFinite(v) && v > 0 ? v : null;
}
/** What changed between two looks at one trader: positions opened (or turned round) and positions closed. */
export function hlDiff(before: Record<string, number>, after: Record<string, number>): { opened: { coin: string; dir: number }[]; closed: string[] } {
  const opened: { coin: string; dir: number }[] = [];
  const closed: string[] = [];
  for (const [coin, v] of Object.entries(after)) {
    const was = Math.sign(before[coin] ?? 0);
    if (was !== Math.sign(v)) {
      if (was !== 0) closed.push(coin);
      opened.push({ coin, dir: Math.sign(v) });
    }
  }
  for (const coin of Object.keys(before)) if (!(coin in after)) closed.push(coin);
  return { opened, closed };
}

// ---- state --------------------------------------------------------------------------------------------------------------
interface SpotOpen {
  rule: string;
  bucket: Bucket;
  key: string;
  mint: string;
  symbol: string;
  at: number;
  ref: number;
  tokens: string;
  /** first time a sale was due and no quote came */
  dueAt?: number;
}
interface SpotTrade {
  rule: string;
  bucket: Bucket;
  symbol: string;
  at: number;
  exitAt: number;
  why: "target" | "stop" | "time" | "unsellable";
  netUsd: number;
  late?: boolean;
}
interface PerpOpen {
  rule: string;
  coin: string;
  dir: number;
  hour: number;
  at: number;
  entry: number;
  /** confidence score 0-4 when it was opened, and the furthest the price has gone against it (fraction of entry) */
  conf?: number;
  worst?: number;
}
interface PerpTrade {
  rule: string;
  coin: string;
  dir: number;
  at: number;
  exitAt: number;
  net: number;
  conf?: number;
  worst?: number;
}
interface HlOpen {
  trader: string;
  coin: string;
  dir: number;
  at: number;
  entry: number;
  /** the leverage the trader set on it, and the furthest the price has gone against it at the prices we read */
  lev?: number;
  worst?: number;
  /** the trader's position in coins when the copy opened and at the last look (partial closes, 19 Nov 2026), and the
   * position's value against the trader's account value when it opened (conviction) */
  sz0?: number;
  szNow?: number;
  share?: number;
  /** the trader's size after each of its fills since the copy opened, read back once for a copy older than sz0 */
  hist?: [number, number][];
  /** the trader's own average entry price of the position when we first saw it (22 Nov 2026: our entry against theirs) */
  their?: number;
}
interface HlTrade {
  trader: string;
  coin: string;
  dir: number;
  at: number;
  exitAt: number;
  net: number;
  why: "closed" | "max hold";
  lev?: number;
  worst?: number;
  /** our paper entry and the trader's own average entry when we saw it (22 Nov 2026) */
  entry?: number;
  their?: number;
}
interface State {
  /** version of the coin sorting: an older file's coin list is read again at once */
  v?: number;
  universe: Coin[];
  universeAt: number;
  slot: number;
  series: Record<string, number[]>;
  open: SpotOpen[];
  trades: SpotTrade[];
  cool: Record<string, number>;
  missed: number;
  perpHour: number;
  perpOpen: PerpOpen[];
  perpTrades: PerpTrade[];
  perpLast: Record<string, { px: number; d1: number | null; d7: number | null; d30: number | null }>;
  hlTraders: HlTrader[];
  hlAt: number;
  hlV?: number;
  hlSeen: Record<string, Record<string, number>>;
  /** trader -> the last time it was seen holding SOL, BTC or ETH, ms (see majorTier) */
  hlMajorSeen?: Record<string, number>;
  hlNext: number;
  /** trader -> its own closed positions of the last month ([when closed, result]) and when they were read */
  hlHist?: Record<string, { at: number; trips: Trip[]; d?: number; v?: number }>;
  /** BTC hourly closes for the beat-the-market test (src/hyperliquid/skill.ts), and when they were read */
  hlBtc?: { at: number; c: BtcCandles };
  hlOpen: HlOpen[];
  hlTrades: HlTrade[];
  mcap: Record<string, { b: Bucket | null; at: number }>;
  jupDay: number;
  jupCalls: number;
  errors: Record<string, string>;
}
const SORT_V = 4;
/** version of the rules that pick the copied perp traders: an older file's list is read again at once */
const HL_LIST_V = 3;
const fresh = (): State => ({
  v: SORT_V,
  universe: [], universeAt: 0, slot: 0, series: {}, open: [], trades: [], cool: {}, missed: 0, perpHour: 0, perpOpen: [], perpTrades: [], perpLast: {},
  hlTraders: [], hlAt: 0, hlSeen: {}, hlNext: 0, hlOpen: [], hlTrades: [], mcap: {}, jupDay: 0, jupCalls: 0, errors: {},
});
const FILE = () => join(DATA, "solana", "buckets-state.json");
const SLOW_PAPER = () => join(DATA, "solana", "slow-paper.json");
let state: State = fresh();
let loaded = false;
function load() {
  loaded = true;
  try {
    state = { ...fresh(), ...(JSON.parse(readFileSync(FILE(), "utf8")) as State) };
    if (state.v !== SORT_V) state.universeAt = 0;
    state.v = SORT_V;
    // the trader list's rules changed (60 -> 400 traders): the list is read again at once, not at its daily turn
    if (state.hlV !== HL_LIST_V) state.hlAt = 0;
    state.hlV = HL_LIST_V;
  } catch {
    state = fresh();
  }
}
function save() {
  mkdirSync(join(DATA, "solana"), { recursive: true });
  writeFileSync(FILE() + ".tmp", JSON.stringify(state));
  renameSync(FILE() + ".tmp", FILE());
}

type Quote = (inMint: string, outMint: string, amount: string) => Promise<bigint | null | undefined>;
export interface BucketDeps {
  fetch: () => typeof fetch;
  quote: Quote;
  /** a GET on Jupiter's API with our key: path -> parsed JSON */
  jup: (path: string) => Promise<unknown>;
}
/** counts a Jupiter request against the day's allowance; false = the allowance is spent */
function jupOk(now: number, n = 1): boolean {
  const day = Math.floor(now / 86_400_000);
  if (day !== state.jupDay) {
    state.jupDay = day;
    state.jupCalls = 0;
  }
  if (state.jupCalls + n > JUP_DAY()) return false;
  state.jupCalls += n;
  return true;
}
const note = (part: string, e: unknown) => {
  // fixed words only: an error text can quote what it read
  const m = String((e as Error)?.message ?? "");
  state.errors[part] = /^[a-z ]+: (http \d+|no answer|not json|nothing usable|allowance spent)$/.test(m) ? m : `${part}: failed`;
};
const r = (x: number | null | undefined, n = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);

// ---- spot: universe, prices, rules --------------------------------------------------------------------------------------
async function refreshUniverse(deps: BucketDeps, now: number) {
  const coins: Coin[] = [];
  let ok = 0;
  for (const path of ["/tokens/v2/tag?query=verified", "/tokens/v2/toptraded/24h?limit=100", "/tokens/v2/toporganicscore/24h?limit=100", "/tokens/v2/toptrending/24h?limit=100"]) {
    if (!jupOk(now)) throw new Error("coins: allowance spent");
    try {
      coins.push(...bucketCoins(await deps.jup(path), now));
      ok++;
    } catch {
      /* the other lists still count */
    }
  }
  if (!ok) throw new Error("coins: no answer");
  const picked = pickUniverse(coins);
  if (!picked.length) throw new Error("coins: nothing usable");
  state.universe = picked;
  state.universeAt = now;
  const keep = new Set([SOL, ...picked.map((c) => c.mint), ...state.open.map((o) => o.mint)]);
  for (const m of Object.keys(state.series)) if (!keep.has(m)) delete state.series[m];
  for (const c of picked) state.mcap[c.mint] = { b: c.bucket, at: now };
  delete state.errors.coins;
}

/** Jupiter price answer -> mint -> dollars. Takes both shapes the service has used. */
export function parsePrices(j: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const body = (j && typeof j === "object" && "data" in (j as object) && typeof (j as { data: unknown }).data === "object" ? (j as { data: unknown }).data : j) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return out;
  for (const [mint, v] of Object.entries(body)) {
    const px = Number((v as { usdPrice?: unknown; price?: unknown })?.usdPrice ?? (v as { price?: unknown })?.price);
    if (px > 0) out[mint] = px;
  }
  return out;
}
async function prices(deps: BucketDeps, mints: string[], now: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let i = 0; i < mints.length; i += 50) {
    if (!jupOk(now)) throw new Error("prices: allowance spent");
    try {
      Object.assign(out, parsePrices(await deps.jup(`/price/v3?ids=${mints.slice(i, i + 50).join(",")}`)));
    } catch {
      /* this batch is missing this minute */
    }
  }
  if (!Object.keys(out).length) throw new Error("prices: no answer");
  delete state.errors.prices;
  return out;
}

async function spotTick(deps: BucketDeps, now: number) {
  if (now - state.universeAt > UNIVERSE_MS || !state.universe.length) await refreshUniverse(deps, now).catch((e) => note("coins", e));
  if (!state.universe.length) return;
  const mints = [...new Set([SOL, ...state.universe.map((c) => c.mint), ...state.open.map((o) => o.mint)])];
  const px = await prices(deps, mints, now);

  // sales first, every minute, on the price now against the price it bought at
  for (const o of [...state.open]) {
    const rule = SPOT_RULES.find((x) => x.key === o.key);
    const p = px[o.mint];
    const why = !rule ? "time" : p ? spotExit(rule, o.bucket, o.ref, p, now - o.at) : now - o.at >= rule.holdMin * 60_000 ? "time" : null;
    if (!why && !o.dueAt) continue;
    const back = jupOk(now) ? await deps.quote(o.mint, USDC, o.tokens).catch(() => undefined) : undefined;
    if (back === undefined || back === null) {
      o.dueAt ??= now;
      // no route for hours: the coin cannot be sold, the stake is gone
      if (back === null && now - o.dueAt >= UNSELLABLE_MS) close(o, now, "unsellable", 0, true);
      continue;
    }
    close(o, now, why ?? "time", Number(back) / 1e6, !!o.dueAt);
  }

  // a new 5-minute close: record it, then let the rules look
  const slot = Math.floor(now / SLOT_MS);
  if (slot <= state.slot) return;
  const gap = state.slot ? slot - state.slot : 1;
  for (const m of mints) {
    const p = px[m];
    const s = (state.series[m] ??= []);
    if (!p || gap > 3) {
      // a hole in the prices: the history of this coin starts again rather than pretend it stood still
      if (gap > 3 || !s.length) state.series[m] = p ? [p] : [];
      else s.push(s[s.length - 1]);
    } else {
      for (let g = 1; g < gap; g++) s.push(s[s.length - 1] ?? p);
      s.push(p);
    }
    if (state.series[m].length > KEEP_SLOTS) state.series[m] = state.series[m].slice(-KEEP_SLOTS);
  }
  state.slot = slot;
  const sol = state.series[SOL] ?? [];
  for (const c of state.universe) {
    const p = state.series[c.mint];
    if (!p || !px[c.mint]) continue;
    for (const rule of SPOT_RULES) {
      const id = ruleId(c.bucket, rule.key);
      if (!spotSignal(rule, c.bucket, p, sol)) continue;
      if (state.open.some((o) => o.rule === id && o.mint === c.mint) || state.open.filter((o) => o.rule === id).length >= MAX_OPEN_PER_RULE) continue;
      if ((state.cool[`${id}:${c.mint}`] ?? 0) > now) continue;
      const out = jupOk(now) ? await deps.quote(USDC, c.mint, String(STAKE_USD * 1e6)).catch(() => undefined) : undefined;
      if (!out) {
        state.missed++;
        continue;
      }
      state.open.push({ rule: id, bucket: c.bucket, key: rule.key, mint: c.mint, symbol: c.symbol, at: now, ref: px[c.mint], tokens: out.toString() });
    }
  }
  for (const k of Object.keys(state.cool)) if (state.cool[k] <= now) delete state.cool[k];
}
function close(o: SpotOpen, now: number, why: SpotTrade["why"], usdOut: number, late: boolean) {
  state.trades.push({ rule: o.rule, bucket: o.bucket, symbol: o.symbol, at: o.at, exitAt: now, why, netUsd: r(usdOut - STAKE_USD - 2 * TX_USD, 4)!, ...(late ? { late: true } : {}) });
  if (state.trades.length > KEEP_TRADES) state.trades = state.trades.slice(-KEEP_TRADES);
  state.open = state.open.filter((x) => x !== o);
  state.cool[`${o.rule}:${o.mint}`] = now + COOLDOWN_MS;
}

// ---- perps: rules ---------------------------------------------------------------------------------------------------------
/** Dollars the copied traders hold long minus short on one coin, at the last look at each of them. */
const tradersNet = (coin: string) => state.hlTraders.reduce((a, t) => a + (state.hlSeen[t.address]?.[coin] ?? 0), 0);
async function perpTick(deps: BucketDeps, now: number) {
  const lastClosed = Math.floor(now / 3_600_000) - 1;
  if (lastClosed <= state.perpHour || now % 3_600_000 < 15_000) return;
  const got: Record<string, { k: Candles; px: number }> = {};
  for (const coin of PERP_COINS) {
    const res = await deps.fetch()(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=1h&limit=1000`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res) throw new Error("candles: no answer");
    if (!res.ok) throw new Error(`candles: http ${res.status}`);
    const { k, px } = parseKlines(await res.json().catch(() => null), now);
    if (!k.t.length || k.t[k.t.length - 1] < lastClosed || !px) throw new Error("candles: nothing usable");
    got[coin] = { k, px };
  }
  for (const coin of PERP_COINS) {
    const { k, px } = got[coin];
    const i = k.t.length - 1;
    const hour = k.t[i];
    const pc = (n: number) => (i >= n ? r((k.c[i] / k.c[i - n] - 1) * 100) : null);
    state.perpLast[coin] = { px, d1: pc(24), d7: pc(168), d30: pc(720) };
    for (const rule of PERP_RULES) {
      const id = `${coin}-${rule.key}`;
      const sig = rule.signal(k, i);
      const o = state.perpOpen.find((x) => x.rule === id);
      if (o && o.worst !== undefined) o.worst = r(Math.max(o.worst, worstMove(k, o.hour, o.dir, o.entry, px)), 6)!;
      if (o && (hour - o.hour >= rule.holdH || (rule.flip && sig !== 0 && sig !== o.dir))) {
        state.perpTrades.push({ rule: id, coin, dir: o.dir, at: o.at, exitAt: now, net: r(perpNet(o.dir, o.entry, px, (now - o.at) / 3_600_000), 6)!, conf: o.conf, worst: o.worst });
        state.perpOpen = state.perpOpen.filter((x) => x !== o);
      }
      if (sig !== 0 && !state.perpOpen.some((x) => x.rule === id)) state.perpOpen.push({ rule: id, coin, dir: sig, hour, at: now, entry: px, conf: perpConfidence(k, i, sig, tradersNet(coin)), worst: 0 });
    }
  }
  if (state.perpTrades.length > KEEP_TRADES) state.perpTrades = state.perpTrades.slice(-KEEP_TRADES);
  state.perpHour = lastClosed;
  delete state.errors.candles;
}

// ---- perps: copy ----------------------------------------------------------------------------------------------------------
async function hlPost(deps: BucketDeps, body: unknown): Promise<unknown> {
  const res = await deps.fetch()("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }).catch(() => null);
  hlHttp(res ? res.status : null, "paper");
  if (!res) throw new Error("traders: no answer");
  if (!res.ok) throw new Error(`traders: http ${res.status}`);
  return res.json().catch(() => {
    throw new Error("traders: not json");
  });
}
/**
 * Copied traders that stay followed when the daily list leaves them out. The real side names them (perpslive.ts
 * keptTraders): those whose real copies are ahead, or that have a real position open. The list ranks a trader's own
 * account; our real record of copying it is the better evidence (enrique, 16 Nov 2026: "real is more important",
 * "cut loser and bring winners"), so a real winner is not dropped for sliding down that ranking. It leaves when its
 * real record is no longer ahead (the real side cuts it), like any other.
 */
const keptBy = new Map<string, () => string[]>();
const keptTraders = () => [...new Set([...keptBy.values()].flatMap((f) => f()))];
/** `who` names the real side that asks (Solana perps, Hyperliquid): each keeps its own winners on the list. */
export const setKeptTraders = (f: () => string[], who = "perps") => void keptBy.set(who, f);
/**
 * Wallets followed on PAPER besides the daily list: the likely new wallets of traders we like (hyperliquid/links.ts,
 * enrique 17 Nov 2026: traders change wallets to shake off copiers). They are copied on paper like any trader of the
 * list and go real only on their own record, at the same bar. Being linked to a winner earns nothing by itself.
 */
let extraTraders: () => string[] = () => [];
export const setExtraTraders = (f: () => string[]) => void (extraTraders = f);
/** The whole leaderboard of the last daily read, address and account value only (saved beside the state). */
let boardLite: { address: string; acct: number }[] = [];
/** Kept in a file of its own: the bot restarts at every deploy and the list is read once a day, so without the file the
 *  wallet-link search had no leaderboard to look through (18 Nov 2026: 3 traders had moved out, 0 wallets were checked). */
const BOARD_FILE = () => join(DATA, "solana", "hl-board.json");
export const hlBoard = () => {
  if (!boardLite.length) {
    try {
      const xs = JSON.parse(readFileSync(BOARD_FILE(), "utf8")) as [string, number][];
      if (Array.isArray(xs)) boardLite = xs.filter((x) => Array.isArray(x) && typeof x[0] === "string" && x[1] > 0).map(([address, acct]) => ({ address, acct }));
    } catch {
      /* not read yet */
    }
  }
  return boardLite;
};
function saveBoard() {
  try {
    mkdirSync(join(DATA, "solana"), { recursive: true });
    writeFileSync(BOARD_FILE() + ".tmp", JSON.stringify(boardLite.map((x) => [x.address, Math.round(x.acct)])));
    renameSync(BOARD_FILE() + ".tmp", BOARD_FILE());
  } catch {
    /* the next daily read writes it */
  }
}
export function boardOf(board: unknown): { address: string; acct: number }[] {
  const rows = (board as { leaderboardRows?: unknown })?.leaderboardRows;
  if (!Array.isArray(rows)) return [];
  const out: { address: string; acct: number }[] = [];
  for (const x of rows as Record<string, unknown>[]) {
    const acct = Number(x?.accountValue);
    if (typeof x?.ethAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(x.ethAddress) && acct > 0) out.push({ address: x.ethAddress.toLowerCase(), acct });
  }
  return out;
}
/**
 * The traders we like, for the wallet-link search: copied for real and kept by the real side ("real"), at the bar on
 * paper ("bar"), or half way there and ahead ("paper": 10+ closed copies, half won, ahead). Judged on our own record
 * of copying them, so a trader who emptied the account and left the leaderboard is still on this list.
 */
export const LIKED_MIN_COPIES = 10;
export function likedTraders(now = Date.now(), limit = 15): { address: string; why: "real" | "bar" | "paper" }[] {
  if (!loaded) load();
  const kept = new Set(keptTraders());
  const out: { address: string; why: "real" | "bar" | "paper"; net: number }[] = [];
  for (const a of copiedTraders()) {
    const rec = traderRecord(traderRule(a));
    const why = kept.has(traderRule(a)) ? "real" : traderMeetsBar(rec, now) ? "bar" : rec.trades >= LIKED_MIN_COPIES && rec.won * 2 >= rec.trades && rec.netUsd > 0 ? "paper" : null;
    if (why) out.push({ address: a, why, net: rec.netUsd });
  }
  const rank = { real: 0, bar: 1, paper: 2 };
  return out.sort((x, y) => rank[x.why] - rank[y.why] || y.net - x.net).slice(0, limit).map(({ address, why }) => ({ address, why }));
}
/**
 * A trader's fills since `sinceMs`: pages of 2,000 from the start, oldest first. One with more than HIST_PAGES pages
 * gets its newest 2,000 as well; what lies between is not read, and hlTrips follows no position across that gap.
 * null = a page was not read (nothing is kept from a partial read).
 */
async function hlFillsBack(deps: BucketDeps, a: string, sinceMs: number): Promise<unknown[] | null> {
  const all: unknown[] = [];
  let start = Math.floor(sinceMs);
  for (let page = 0; page < HIST_PAGES; page++) {
    const xs = await hlPost(deps, { type: "userFillsByTime", user: a, startTime: start, aggregateByTime: true }).catch(() => null);
    if (!Array.isArray(xs)) return null;
    all.push(...xs);
    if (xs.length < 2000) return all;
    let last = 0;
    for (const x of xs as { time?: unknown }[]) last = Math.max(last, Number(x?.time) || 0);
    if (!(last >= start)) return all;
    start = last + 1;
  }
  const newest = await hlPost(deps, { type: "userFills", user: a, aggregateByTime: true }).catch(() => null);
  return Array.isArray(newest) ? [...all, ...newest] : null;
}
// ---- one look at one trader, from the minute's round or from a fast look (22 Nov 2026) -----------------------------------
/** every request for a trader's positions gets a number: an answer older than one already written is not written */
let lookSeq = 0;
const appliedSeq = new Map<string, number>();
/** Close a paper copy at this price. */
function shutAt(o: HlOpen, px: number, why: HlTrade["why"], now: number) {
  const fee = hlCost(o.coin);
  const net = o.dir * (px / o.entry - 1) - 2 * fee - PERP_BORROW_HOUR * ((now - o.at) / 3_600_000);
  const worst = o.worst === undefined ? undefined : r(Math.max(o.worst, -o.dir * (px / o.entry - 1)), 6)!;
  state.hlTrades.push({ trader: o.trader, coin: o.coin, dir: o.dir, at: o.at, exitAt: now, net: r(net, 6)!, why, lev: o.lev, worst, entry: o.entry, ...(o.their ? { their: o.their } : {}) });
  state.hlOpen = state.hlOpen.filter((x) => x !== o);
}
/**
 * Write down what one trader holds now and copy what changed. The prices of every coin it opened or closed are read
 * FIRST: a change written down without its price would be lost for good (MAIN's review, 16 Nov 2026). An answer
 * older than one already written (two looks at once: the minute's round and a fast look) is dropped.
 * Returns true when a paper copy opened, closed or changed size.
 */
async function hlApply(deps: BucketDeps, a: string, answer: unknown, now: number, seq: number, price: (coin: string) => Promise<number | null>, src: "poll" | "feed"): Promise<boolean> {
  const px: Record<string, number> = {};
  for (let tries = 0; tries < 3; tries++) {
    if ((appliedSeq.get(a) ?? 0) > seq) return false;
    const after = hlPositions(answer, state.hlSeen[a]);
    if (!after) return false;
    const before = state.hlSeen[a];
    const d = before ? hlDiff(before, after) : { opened: [], closed: [] };
    const listed = state.hlTraders.some((t) => t.address === a);
    const need = [...d.closed.filter((c) => state.hlOpen.some((o) => o.trader === a && o.coin === c)), ...(listed ? d.opened.map((x) => x.coin) : [])].filter((c, i, all) => all.indexOf(c) === i && !(c in px));
    if (need.length) {
      for (const c of need) {
        const p = await price(c).catch(() => null);
        if (!p) return false; // nothing written: looked at again
        px[c] = p;
      }
      continue; // the awaits may have let another look write: start again from what is written now
    }
    // ---- from here to the end of the loop nothing waits: what is read and written belongs together ----
    appliedSeq.set(a, seq);
    let changed = false;
    const levs = hlLeverage(answer);
    if (Object.keys(after).some(onJupiter)) state.hlMajorSeen = { ...(state.hlMajorSeen ?? {}), [a]: now };
    state.hlSeen[a] = after;
    // how much of each open copy the trader still holds (enrique, 19 Nov 2026: "yeah build all 3": follow partial closes)
    const sizes = hlSizes(answer);
    for (const o of state.hlOpen)
      if (o.trader === a && o.sz0 && sizes[o.coin] && Math.sign(after[o.coin] ?? 0) === o.dir && o.szNow !== sizes[o.coin]) {
        o.szNow = sizes[o.coin];
        changed = true;
      }
    if (before) {
      for (const coin of d.closed)
        for (const o of state.hlOpen.filter((x) => x.trader === a && x.coin === coin)) {
          shutAt(o, px[coin], "closed", now);
          fastHooks.note?.("paperClose", a, coin, src);
          changed = true;
        }
      if (listed)
        for (const { coin, dir } of d.opened) {
          const av = hlAccountValue(answer);
          const share = av ? r(Math.abs(after[coin] ?? 0) / av, 3) ?? undefined : undefined;
          const their = hlEntries(answer)[coin];
          if (state.hlOpen.some((x) => x.trader === a && x.coin === coin)) continue;
          state.hlOpen.push({ trader: a, coin, dir, at: now, entry: px[coin], lev: levs[coin], worst: 0, ...(sizes[coin] ? { sz0: sizes[coin], szNow: sizes[coin] } : {}), ...(share != null ? { share } : {}), ...(their ? { their } : {}) });
          fastHooks.note?.("paperOpen", a, coin, src);
          changed = true;
        }
    }
    // a copy older than the size record: its opening size is read back from the trader's own fills, once
    for (const o of state.hlOpen) {
      if (o.trader !== a || o.sz0 || !sizes[o.coin] || Math.sign(after[o.coin] ?? 0) !== o.dir) continue;
      const fills = await hlPost(deps, { type: "userFillsByTime", user: a, startTime: o.at }).catch(() => null);
      if (fills === null) continue; // not read: asked again at the next look
      const back = hlSizeBack(fills, o.coin, o.dir, sizes[o.coin]);
      o.sz0 = back.sz0;
      o.szNow = sizes[o.coin];
      if (back.hist.length) o.hist = back.hist;
    }
    return changed;
  }
  return false;
}

// ---- FAST LOOKS (enrique, 22 Nov 2026: "is there any workaround hyperliquid entries and exits being up to a minute
// late?"). A trade by a followed trader, seen on Hyperliquid's public trade feed (src/hyperliquid/watch.ts), has that
// trader looked at QUICK_FIRST_MS later and again QUICK_TAIL_MS after its last trade (an order filled in parts, a
// position that reaches HL_MIN_POS_USD later). The minute's round stays as it was: the fallback.
export const QUICK_FIRST_MS = 1_500;
export const QUICK_TAIL_MS = 8_000;
/** fast looks a minute at most (2 of Hyperliquid's 1,200 weight each); traders approved for real or holding a copy go
 *  first and may use all of it, the others QUICK_OTHERS_PER_MIN */
export const QUICK_PER_MIN = 200;
export const QUICK_OTHERS_PER_MIN = 100;
const quick = new Map<string, { next: number; tail: number }>();
let quickLog: number[] = [];
let quickBusy = false;
let quickDeps: BucketDeps | null = null;
const quickStats = { looks: 0, skipped: 0, changed: 0 };
let fastHooks: {
  /** a paper copy opened or closed: which path saw it first */
  note?: (kind: "paperOpen" | "paperClose", addr: string, coin: string, src: "poll" | "feed") => void;
  /** a fresh price from the trade feed, or null */
  px?: (coin: string) => number | null;
  /** a paper copy opened, closed or changed size in a fast look: the real side looks at once */
  changed?: () => void;
  /** a trader approved for real (looked at first) */
  priority?: (rule: string) => boolean;
} = {};
export const setHlFast = (h: typeof fastHooks) => void (fastHooks = h);
let watchedCache: { at: number; set: Set<string> } | null = null;
/** Every address followed now (the list and those with an open copy), lower case. Kept 5 s. */
export function hlWatched(now = Date.now()): Set<string> {
  if (!loaded) load();
  if (!watchedCache || now - watchedCache.at > 5_000) watchedCache = { at: now, set: new Set([...state.hlTraders.map((t) => t.address), ...state.hlOpen.map((o) => o.trader)]) };
  return watchedCache.set;
}
/** A followed trader traded: look at it soon. */
export function hlPoke(addr: string, now = Date.now()) {
  if (!hlWatched(now).has(addr)) return;
  const q = quick.get(addr);
  if (q) q.tail = Math.max(q.tail, now + QUICK_TAIL_MS);
  else quick.set(addr, { next: now + QUICK_FIRST_MS, tail: now + QUICK_TAIL_MS });
}
/** One round of fast looks: those due, at most HL_BATCH at once. Returns how many traders were looked at. Never throws. */
export async function hlQuickTick(now = Date.now(), deps: BucketDeps | null = quickDeps): Promise<number> {
  if (quickBusy || !deps) return 0;
  if (!loaded) load();
  quickLog = quickLog.filter((t) => now - t < 60_000);
  const due = [...quick.entries()].filter(([, q]) => q.next <= now);
  if (!due.length) return 0;
  const pri = (a: string) => state.hlOpen.some((o) => o.trader === a) || !!fastHooks.priority?.(traderRule(a));
  due.sort((x, y) => Number(pri(y[0])) - Number(pri(x[0])) || x[1].next - y[1].next);
  const pick: string[] = [];
  for (const [a, q] of due) {
    if (pick.length >= HL_BATCH) break;
    const used = quickLog.length + pick.length;
    if (used >= QUICK_PER_MIN || (!pri(a) && used >= QUICK_OTHERS_PER_MIN)) {
      quick.delete(a); // over the allowance: left to the minute's round
      quickStats.skipped++;
      continue;
    }
    pick.push(a);
    if (q.tail > q.next + 1_000) q.next = q.tail;
    else quick.delete(a);
  }
  if (!pick.length) return 0;
  quickBusy = true;
  try {
    let mids: Record<string, number> | null = null;
    const price = async (coin: string) => {
      const f = fastHooks.px?.(coin);
      if (f && f > 0) return f;
      mids ??= Object.fromEntries(Object.entries((await hlPost(deps, { type: "allMids" })) as Record<string, string>).map(([k, v]) => [k, Number(v)]));
      return mids[coin] > 0 ? mids[coin] : null;
    };
    const seqs = pick.map(() => ++lookSeq);
    const answers = await Promise.all(pick.map((a) => hlPost(deps, { type: "clearinghouseState", user: a }).catch(() => null)));
    quickLog.push(...pick.map(() => now));
    quickStats.looks += pick.length;
    let changed = false;
    for (let j = 0; j < pick.length; j++) if (answers[j] !== null && (await hlApply(deps, pick[j], answers[j], now, seqs[j], price, "feed").catch(() => false))) changed = true;
    if (changed) {
      quickStats.changed++;
      save();
      fastHooks.changed?.();
    }
    return pick.length;
  } finally {
    quickBusy = false;
  }
}
/** For the status: fast looks in the last minute, and since start. */
export const hlQuickSummary = (now = Date.now()) => ({ lastMinute: quickLog.filter((t) => now - t < 60_000).length, waiting: quick.size, ...quickStats, perMinute: QUICK_PER_MIN });
async function hlTick(deps: BucketDeps, now: number) {
  if (now - state.hlAt > HL_REFRESH_MS || !state.hlTraders.length) {
    const res = await deps.fetch()("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard", { signal: AbortSignal.timeout(90_000) }).catch(() => null);
    state.hlAt = now - HL_REFRESH_MS + 1_800_000; // a failed read is tried again in half an hour, not every minute: the file is big
    if (!res) throw new Error("traders: no answer");
    if (!res.ok) throw new Error(`traders: http ${res.status}`);
    const raw = await res.json().catch(() => null);
    const lite = boardOf(raw);
    if (lite.length) {
      boardLite = lite;
      saveBoard();
    }
    const board = hlPick(raw, Infinity);
    if (!board.length) throw new Error("traders: nothing usable");
    const tier = new Map(board.map((t) => [t.address, majorTier(t.address, now)]));
    const picked = board.filter((t) => tier.get(t.address)! < 2).sort((a, b) => tier.get(a.address)! - tier.get(b.address)! || b.monthPnl - a.monthPnl).slice(0, HL_FOLLOW);
    // what was seen of traders no longer on the board is forgotten after HL_MAJOR_DAYS
    for (const [a, t] of Object.entries(state.hlMajorSeen ?? {})) if (now - t > HL_MAJOR_DAYS * 86_400_000) delete state.hlMajorSeen![a];
    state.hlAt = now;
    const kept = new Set(keptTraders());
    state.hlTraders = [...picked, ...state.hlTraders.filter((t) => kept.has(traderRule(t.address)) && !picked.some((x) => x.address === t.address))];
    const keep = new Set([...state.hlTraders.map((t) => t.address), ...state.hlOpen.map((o) => o.trader)]);
    for (const a of Object.keys(state.hlSeen)) if (!keep.has(a)) delete state.hlSeen[a];
  }
  // likely new wallets of traders we like join the list (paper only); one that is no longer named leaves at the daily read
  for (const a of extraTraders().slice(0, HL_EXTRA_MAX)) if (/^0x[0-9a-f]{40}$/.test(a) && !state.hlTraders.some((t) => t.address === a)) state.hlTraders.push({ address: a, monthPnl: 0, monthRoi: 0 });
  const watch = [...new Set([...state.hlTraders.map((t) => t.address), ...state.hlOpen.map((o) => o.trader)])];
  let mids: Record<string, number> | null = null;
  const mid = async (coin: string) => {
    mids ??= Object.fromEntries(Object.entries((await hlPost(deps, { type: "allMids" })) as Record<string, string>).map(([k, v]) => [k, Number(v)]));
    return mids[coin] > 0 ? mids[coin] : null;
  };
  const shut = async (o: HlOpen, why: HlTrade["why"]) => {
    const px = await mid(o.coin);
    if (px) shutAt(o, px, why, now);
  };
  // the prices first (MAIN's review, 16 Nov 2026): what a trader holds is written down as it is read, so a close seen in
  // a look whose prices then failed would be lost for good, and a real position copied from it would stay open.
  // Without prices no trader is looked at in this look; all of them are compared again at the next
  await mid("BTC").catch(() => {
    throw new Error("traders: no prices");
  });
  // who is looked at this minute: traders with an open copy first, then those copied before (most copies on SOL, BTC
  // and ETH first, then most copies), then the rest in turns
  const copies = new Map<string, number>();
  for (const t of state.hlTrades) copies.set(t.trader, (copies.get(t.trader) ?? 0) + 1);
  const holding = [...new Set(state.hlOpen.map((o) => o.trader))];
  const majors = new Map([...copies.keys()].map((a) => [a, majorCopies(a)]));
  const before0 = [...copies.entries()].sort((x, y) => majors.get(y[0])! - majors.get(x[0])! || y[1] - x[1]).map(([a]) => a).filter((a) => watch.includes(a) && !holding.includes(a));
  const hot = [...holding, ...before0].slice(0, Math.max(HL_HOT_MAX, holding.length));
  const turn: string[] = [];
  const cold = watch.filter((a) => !hot.includes(a));
  for (let n = 0; n < Math.min(Math.max(0, HL_PER_TICK - hot.length), cold.length); n++) turn.push(cold[state.hlNext++ % cold.length]);
  const todo = [...new Set([...hot, ...turn])];
  for (let b = 0; b < todo.length; b += HL_BATCH) {
    const batch = todo.slice(b, b + HL_BATCH);
    const seqs = batch.map(() => ++lookSeq);
    const answers = await Promise.all(batch.map((a) => hlPost(deps, { type: "clearinghouseState", user: a }).catch(() => null)));
    if (b === 0 && answers.every((x) => x === null)) throw new Error("traders: no answer");
    for (let j = 0; j < batch.length; j++) if (answers[j] !== null) await hlApply(deps, batch[j], answers[j], now, seqs[j], mid, "poll");
  }
  // how far each open copy has gone against us, at the prices of this look (between looks it can have gone further)
  for (const o of state.hlOpen) {
    if (o.worst === undefined) continue;
    const px = await mid(o.coin);
    if (px) o.worst = r(Math.max(o.worst, -o.dir * (px / o.entry - 1)), 6)!;
  }
  // each followed trader's own closed positions, once a day: those holding a copy first, then the biggest month
  state.hlHist ??= {};
  const listed = new Set(state.hlTraders.map((t) => t.address));
  for (const a of Object.keys(state.hlHist)) if (!listed.has(a)) delete state.hlHist[a];
  const due = [...holding.filter((a) => listed.has(a)), ...state.hlTraders.map((t) => t.address)].filter((a, i, all) => all.indexOf(a) === i && (now - (state.hlHist![a]?.at ?? 0) > HIST_REFRESH_MS || state.hlHist![a]?.d !== HIST_DAYS || state.hlHist![a]?.v !== HIST_V)).slice(0, HIST_PER_TICK);
  for (const a of due) {
    const fills = await hlFillsBack(deps, a, now - HIST_DAYS * 86_400_000);
    if (!fills) continue; // not read: asked again at the next look
    longRank = null;
    state.hlHist[a] = { at: now, d: HIST_DAYS, v: HIST_V, trips: hlTrips(fills, now - HIST_DAYS * 86_400_000).slice(-HIST_KEEP).map((x): Trip => [x.closeAt, x.pct, x.openAt, x.dir, x.coin]) };
  }
  // BTC's hourly closes over the window, every 6 hours, for the beat-the-market ranking (paper only)
  if (now - (state.hlBtc?.at ?? 0) > BTC_REFRESH_MS) {
    const c = parseCandles(await hlPost(deps, { type: "candleSnapshot", req: { coin: "BTC", interval: "1h", startTime: now - (HIST_DAYS + 2) * 86_400_000, endTime: now } }).catch(() => null));
    state.hlBtc = c.length ? { at: now, c } : { at: now - BTC_REFRESH_MS + 1_800_000, c: state.hlBtc?.c ?? [] };
  }
  for (const o of state.hlOpen.filter((x) => now - x.at >= HL_MAX_HOLD_MS)) await shut(o, "max hold");
  if (state.hlTrades.length > KEEP_TRADES) state.hlTrades = state.hlTrades.slice(-KEEP_TRADES);
  // a trader the list dropped is looked at only while a copy of it is open. Once that is finished, what we last saw
  // it hold goes too: kept, it would be compared with what it holds on the day it is back on the list, and positions
  // it opened in between, at prices we never saw, would be copied as new (MAIN's review, 16 Nov 2026)
  const watched = new Set([...state.hlTraders.map((t) => t.address), ...state.hlOpen.map((o) => o.trader)]);
  for (const a of Object.keys(state.hlSeen)) if (!watched.has(a)) delete state.hlSeen[a];
  delete state.errors.traders;
}

// ---- spot copy by bucket (the day-holder study's own paper copies, sorted by the coin) -------------------------------------
export const COPY_ENTRY_S = 30;
export const COPY_EXIT_S = 30;
const MCAP_KEEP_MS = 7 * 86_400_000;
const LOOKUPS_PER_RUN = 20;
let copyRows: { bucket: Bucket | "unknown"; ret: number; wallet: string; closedMs: number }[] = [];
let copyAt = 0;
async function copyTick(deps: BucketDeps, now: number) {
  if (now - copyAt < 600_000) return;
  copyAt = now;
  let recent: Pos[] = [];
  try {
    recent = ((JSON.parse(readFileSync(SLOW_PAPER(), "utf8")) as { recent?: Pos[] }).recent ?? []).filter((p) => p.closed);
  } catch {
    return; // the study has not written yet
  }
  let looked = 0;
  const rows: typeof copyRows = [];
  for (const p of recent) {
    const ret = posRet(p, COPY_ENTRY_S, COPY_EXIT_S);
    if (ret === undefined) continue;
    let m = state.mcap[p.mint];
    if ((!m || now - m.at > MCAP_KEEP_MS) && looked < LOOKUPS_PER_RUN && jupOk(now)) {
      looked++;
      try {
        const row = ((await deps.jup(`/tokens/v2/search?query=${p.mint}`)) as Record<string, unknown>[])?.find?.((x) => x?.id === p.mint);
        const mcap = Number(row?.mcap);
        m = state.mcap[p.mint] = { b: mcap > 0 ? bucketOf(mcap) : null, at: now };
      } catch {
        /* next run */
      }
    }
    rows.push({ bucket: m?.b ?? "unknown", ret, wallet: p.wallet, closedMs: p.closedMs ?? 0 });
  }
  copyRows = rows;
  const live = new Set(recent.map((p) => p.mint));
  for (const k of Object.keys(state.mcap)) if (!live.has(k) && now - state.mcap[k].at > MCAP_KEEP_MS) delete state.mcap[k];
}

// ---- the loop -----------------------------------------------------------------------------------------------------------
let busy = false;
export async function bucketsTick(deps: BucketDeps, now = Date.now()): Promise<void> {
  if (busy) return;
  if (!loaded) load();
  busy = true;
  quickDeps = deps;
  try {
    await spotTick(deps, now).catch((e) => note("prices", e));
    await perpTick(deps, now).catch((e) => note("candles", e));
    await hlTick(deps, now).catch((e) => note("traders", e));
    await copyTick(deps, now).catch(() => undefined);
    save();
  } finally {
    busy = false;
  }
}

const tally = (xs: number[], unit = 1) => ({
  trades: xs.length,
  won: xs.filter((x) => x > 0).length,
  net: r(xs.reduce((a, b) => a + b, 0) * unit),
  avgPct: xs.length ? r((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) : null,
});
export function bucketsSummary() {
  if (!loaded) load();
  const spot = BUCKETS.map((b) => {
    const coins = state.universe.filter((c) => c.bucket === b);
    return {
      bucket: b,
      text: BUCKET_TEXT[b],
      coins: coins.length,
      examples: coins.slice(0, 6).map((c) => c.symbol),
      coinList: coins.map((c) => ({ symbol: c.symbol, name: c.name, tags: c.tags, mcapM: r(c.mcap / 1e6, 1) })),
      rules: SPOT_RULES.map((x) => {
        const id = ruleId(b, x.key);
        const done = state.trades.filter((t) => t.rule === id);
        return { id, text: x.text, movePct: r(x.move * SCALE[b], 1), ...tally(done.map((t) => t.netUsd / STAKE_USD), STAKE_USD), open: state.open.filter((o) => o.rule === id).length, late: done.filter((t) => t.late).length, unsellable: done.filter((t) => t.why === "unsellable").length };
      }),
      copy: tally(copyRows.filter((c) => c.bucket === b).map((c) => c.ret)),
      copyWallets: new Set(copyRows.filter((c) => c.bucket === b).map((c) => c.wallet)).size,
    };
  });
  const byTrader = new Map<string, number[]>();
  for (const t of state.hlTrades) byTrader.set(t.trader, [...(byTrader.get(t.trader) ?? []), t.net]);
  const major = (c: string) => (PERP_COINS as readonly string[]).includes(c);
  return {
    mode: "paper",
    note: `Paper only, nothing is sent. SPOT: coins from Jupiter's lists in four buckets by market value, up to ${PER_BUCKET} each, priced once a minute and kept as 5-minute closes. A rule buys on a 5-minute close; the buy is a real quote for a $${STAKE_USD} swap taken after the signal and the sale a real quote for the swap back, less $${TX_USD} a transaction. Thresholds are the rule's base move times the bucket's scale (${BUCKETS.map((b) => `${b} x${SCALE[b]}`).join(", ")}). PERPS: SOL, BTC, ETH on hourly candles, filled at the price when the hour's close is read, charged Jupiter Perps' ${PERP_FEE_SIDE * 100}% a side and ${PERP_BORROW_HOUR * 100}% an hour borrow, $${PERP_USD} a position. The history test (84 rules, 15 Nov 2026) found none that survives costs; "history" says what each did there. COPY, spot: the day-holder study's paper copies (bought ${COPY_ENTRY_S} s after we see the buy, sold ${COPY_EXIT_S} s after its first sale) sorted by the coin's bucket today. COPY, perps: up to ${HL_FOLLOW} traders from Hyperliquid's public leaderboard (ahead over week, month and all time, month +$${HL_MIN_MONTH_PNL}+ and +${HL_MIN_MONTH_ROI * 100}%+, all time +$${HL_MIN_ALL_PNL}+, account $${HL_MIN_ACCOUNT_USD}+, not a market maker), those we have copied looked at every minute and the rest about every 3 to 4 minutes; a position of $${HL_MIN_POS_USD}+ they open is copied at the price we read after seeing it and closed when they close, charged a Solana venue's costs. Bar for real: 100+ trades on one rule, half or more won, net positive; for one copied trader ${TRADER_MIN_COPIES}+ closed copies, half or more won, ahead, a day or more on paper. A quote is the best case for a fill.`,
    updatedAt: Date.now(),
    real: realSummary(),
    jupiter: { usedToday: state.jupCalls, allowance: JUP_DAY() },
    errors: Object.values(state.errors),
    missedEntries: state.missed,
    spot,
    copyUnknownBucket: tally(copyRows.filter((c) => c.bucket === "unknown").map((c) => c.ret)),
    spotRecent: state.trades.slice(-15).reverse().map((t) => ({ rule: t.rule, coin: t.symbol, boughtAt: t.at, soldAt: t.exitAt, why: t.why, pct: r((t.netUsd / STAKE_USD) * 100) })),
    spotOpen: state.open.map((o) => ({ rule: o.rule, coin: o.symbol, boughtAt: o.at })),
    perps: {
      real: perpRealSummary(),
      last: state.perpLast,
      rules: PERP_COINS.flatMap((coin) =>
        PERP_RULES.map((x) => {
          const id = `${coin}-${x.key}`;
          const o = state.perpOpen.find((p) => p.rule === id);
          return { id, coin, text: x.text, history: x.history, ...tally(state.perpTrades.filter((t) => t.rule === id).map((t) => t.net), PERP_USD), open: o ? { side: o.dir > 0 ? "long" : "short", since: o.at, entry: o.entry, nowPct: state.perpLast[coin] ? r(perpNet(o.dir, o.entry, state.perpLast[coin].px, 0) * 100) : null } : null };
        }),
      ),
      recent: state.perpTrades.slice(-15).reverse().map((t) => ({ rule: t.rule, side: t.dir > 0 ? "long" : "short", openedAt: t.at, closedAt: t.exitAt, pct: r(t.net * 100), confidence: t.conf ?? null, worstPct: t.worst === undefined ? null : r(t.worst * 100) })),
      sides: { longs: tally(state.perpTrades.filter((t) => t.dir > 0).map((t) => t.net), PERP_USD), shorts: tally(state.perpTrades.filter((t) => t.dir < 0).map((t) => t.net), PERP_USD) },
      leverage: (() => {
        const rows: LevRow[] = state.perpTrades.map((t) => ({ net: t.net, worst: t.worst, hours: (t.exitAt - t.at) / 3_600_000, dir: t.dir, conf: t.conf }));
        const byConf = (t: LevRow) => (t.conf === undefined ? undefined : CONF_LEV[t.conf]);
        return {
          note: `PAPER. Every closed rule trade scored at each leverage with $${LEV_COLLATERAL_USD} of collateral: result = leverage x the trade's result after fees and borrow; a trade whose price went against it by more than (1 / leverage - fees - 0.2%) at any hourly candle while it was open is LIQUIDATED and loses all its collateral. Confidence is a score 0-4 fixed when the trade opens (7-day trend agrees, 30-day trend agrees, copied traders lean the same way, quiet market) and sets leverage ${CONF_LEV.join(", ")}x. It is an untested guess: byConfidence shows whether higher scores really did better. Only trades opened since this was added count.`,
          collateralUsd: LEV_COLLATERAL_USD,
          tiers: levTable(rows),
          longs: levTable(rows.filter((t) => t.dir > 0)),
          shorts: levTable(rows.filter((t) => t.dir < 0)),
          variable: levTally(rows, byConf),
          byConfidence: CONF_LEV.map((lev, score) => {
            const xs = rows.filter((t) => t.conf === score && t.worst !== undefined);
            return { score, lev, ...levTally(xs, () => lev), avgPctAt1x: xs.length ? r((xs.reduce((a, t) => a + t.net, 0) / xs.length) * 100) : null, wonAt1x: xs.filter((t) => t.net > 0).length };
          }),
        };
      })(),
    },
    perpCopy: {
      traders: state.hlTraders.length,
      listReadAt: state.hlAt || null,
      all: tally(state.hlTrades.map((t) => t.net), PERP_USD),
      // copies closed within three minutes of opening: mostly a position slipping in and out of the followed list (fixed 17 Nov 2026, HL_KEEP_POS_USD), not the trader's own trades
      under3min: tally(state.hlTrades.filter((t) => t.exitAt - t.at < 180_000).map((t) => t.net), PERP_USD),
      majors: tally(state.hlTrades.filter((t) => major(t.coin)).map((t) => t.net), PERP_USD),
      others: tally(state.hlTrades.filter((t) => !major(t.coin)).map((t) => t.net), PERP_USD),
      shorts: tally(state.hlTrades.filter((t) => t.dir < 0).map((t) => t.net), PERP_USD),
      longs: tally(state.hlTrades.filter((t) => t.dir > 0).map((t) => t.net), PERP_USD),
      open: state.hlOpen.length,
      leverage: (() => {
        const rows: LevRow[] = state.hlTrades.map((t) => ({ net: t.net, worst: t.worst, hours: (t.exitAt - t.at) / 3_600_000, dir: t.dir, lev: t.lev, fee: hlCost(t.coin) }));
        const used = [...state.hlTrades, ...state.hlOpen].map((t) => t.lev).filter((x): x is number => x !== undefined);
        const sorted = [...used].sort((a, b) => a - b);
        const q = (f: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] : null);
        return {
          note: `PAPER. tradersUse is the leverage the copied traders had SET on the positions we copied (Hyperliquid's number; their real exposure can be lower when they keep spare cash). tiers scores each closed copy at every leverage with $${LEV_COLLATERAL_USD} collateral, asTheTrader at the trader's own setting. Liquidation is counted only at prices read while watching (about once a minute), so it is understated. Only copies opened since this was added count.`,
          tradersUse: { positions: used.length, median: median(used), low: q(0.25), high: q(0.75), max: sorted.length ? sorted[sorted.length - 1] : null, at10xOrMore: used.filter((x) => x >= 10).length, at20xOrMore: used.filter((x) => x >= 20).length },
          collateralUsd: LEV_COLLATERAL_USD,
          tiers: levTable(rows),
          longs: levTable(rows.filter((t) => t.dir > 0)),
          shorts: levTable(rows.filter((t) => t.dir < 0)),
          asTheTrader: levTally(rows, (t) => t.lev),
          asTheTraderCapped: levTally(rows, (t) => (t.lev === undefined ? undefined : Math.min(t.lev, HL_LEV_CAP))),
        };
      })(),
      // each copied trader's own paper record: at 1x, and at the trader's own leverage (capped) with liquidations
      copyLevCap: HL_LEV_CAP,
      traderBar: { copies: TRADER_MIN_COPIES, ageHours: TRADER_MIN_AGE_MS / 3_600_000 },
      tradersCopied: copiedTraders().length,
      tradersAtBar: copiedTraders().filter((a) => traderMeetsBar(traderRecord(traderRule(a)))).length,
      traderRecords: copiedTraders()
        .map((a) => {
          const mine = state.hlTrades.filter((t) => t.trader === a);
          const rec = traderRecord(traderRule(a));
          const levs = [...mine, ...state.hlOpen.filter((o) => o.trader === a)].map((t) => t.lev).filter((x): x is number => x !== undefined);
          const rows: LevRow[] = mine.map((t) => ({ net: t.net, worst: t.worst, hours: (t.exitAt - t.at) / 3_600_000, dir: t.dir, lev: t.lev, fee: hlCost(t.coin) }));
          const row = state.hlTraders.find((t) => t.address === a);
          const acct = hlBoard().find((t) => t.address === a)?.acct ?? row?.acct;
          return {
            // the trader's own size in dollars at the last leaderboard read (null: not on the board, or not read yet)
            accountUsd: acct ? Math.round(acct) : null, monthUsd: row?.monthPnl ? Math.round(row.monthPnl) : null, allTimeUsd: row?.allPnl ? Math.round(row.allPnl) : null,
            id: traderRule(a), trades: rec.trades, won: rec.won, net: r(rec.netUsd), firstCopyAt: rec.firstAt, open: state.hlOpen.filter((o) => o.trader === a).length,
            longs: mine.filter((t) => t.dir > 0).length, shorts: mine.filter((t) => t.dir < 0).length, majors: mine.filter((t) => major(t.coin)).length,
            leverage: median(levs), atOwnLeverage: levTally(rows, (t) => (t.lev === undefined ? undefined : Math.min(t.lev, HL_LEV_CAP))), atBar: traderMeetsBar(rec),
          };
        })
        .sort((x, y) => Number(y.atBar) - Number(x.atBar) || y.trades - x.trades || (y.net ?? 0) - (x.net ?? 0))
        .slice(0, 60),
      // traders by a short tag only: a full address of a stranger does not belong in a public status
      byTrader: [...byTrader.entries()].map(([a, xs]) => ({ trader: a.slice(0, 6) + "…" + a.slice(-4), ...tally(xs, PERP_USD) })).sort((a, b) => (b.net ?? 0) - (a.net ?? 0)).slice(0, 20),
      recent: state.hlTrades.slice(-15).reverse().map((t) => ({ trader: t.trader.slice(0, 6) + "…" + t.trader.slice(-4), coin: t.coin, side: t.dir > 0 ? "long" : "short", openedAt: t.at, closedAt: t.exitAt, pct: r(t.net * 100), why: t.why })),
    },
  };
}

// ---- what the real side (bucketslive.ts) reads --------------------------------------------------------------------------
/** The bar for real: this many paper trades of one rule, half or more won, ahead after costs. */
export const REAL_MIN_TRADES = 100;
/** One rule's closed paper trades since `sinceMs`: every one counts, a coin that could not be sold as a full loss. */
export function paperRecord(rule: string, sinceMs = 0) {
  if (!loaded) load();
  const xs = state.trades.filter((t) => t.rule === rule && t.at > sinceMs);
  return { trades: xs.length, won: xs.filter((t) => t.netUsd > 0).length, netUsd: xs.reduce((a, t) => a + t.netUsd, 0) };
}
export const meetsBar = (x: { trades: number; won: number; netUsd: number }) => x.trades >= REAL_MIN_TRADES && x.won * 2 >= x.trades && x.netUsd > 0;
export const spotRuleIds = () => BUCKETS.flatMap((b) => SPOT_RULES.map((x) => ruleId(b, x.key)));
/** The paper trades that are open now. */
/** The coin of a paper trade by its rule and buy time (ms), open or closed; "" when no longer kept. For the real trade log. */
export function paperSymbolAt(rule: string, at: number | undefined): string {
  if (at == null) return "";
  const t = state.trades.find((x) => x.rule === rule && x.at === at) ?? state.open.find((x) => x.rule === rule && x.at === at);
  return t?.symbol ?? "";
}
export function paperOpens(): { rule: string; bucket: Bucket; mint: string; symbol: string; at: number }[] {
  if (!loaded) load();
  return state.open.map((o) => ({ rule: o.rule, bucket: o.bucket, mint: o.mint, symbol: o.symbol, at: o.at }));
}
/** The rule name of the paper copies of perp traders that a real short could follow: shorts on SOL, BTC, ETH. */
export const COPY_SHORTS = "copy-shorts";
const isCopyShort = (t: { coin: string; dir: number }) => t.dir < 0 && (PERP_COINS as readonly string[]).includes(t.coin);
const copiedTraders = () => [...new Set([...state.hlTrades, ...state.hlOpen].map((t) => t.trader))];
export const perpRuleIds = () => {
  if (!loaded) load();
  return [...PERP_COINS.flatMap((c) => PERP_RULES.map((x) => `${c}-${x.key}`)), ...copiedTraders().map(traderRule)];
};
const isTraderRule = (rule: string) => rule.startsWith("copy-") && rule !== COPY_SHORTS;
/**
 * Is this copied trader on the list followed now? Off it (the daily list read left it out), hlTick only finishes its
 * open copies and copies nothing new, so nothing new of it can be opened for real either. Not a trader: true.
 */
export const traderListed = (rule: string) => {
  if (!loaded) load();
  return !isTraderRule(rule) || state.hlTraders.some((t) => traderRule(t.address) === rule);
};
/** One trader's closed paper copies since `sinceMs` (every coin, both sides: the trader is judged whole). */
export function traderRecord(rule: string, sinceMs = 0) {
  if (!loaded) load();
  const xs = state.hlTrades.filter((t) => traderRule(t.trader) === rule && t.at > sinceMs);
  // ours = the copies on the coins traded for real (SOL, BTC, ETH)
  return { trades: xs.length, won: xs.filter((t) => t.net > 0).length, netUsd: xs.reduce((a, t) => a + t.net, 0) * PERP_USD, firstAt: xs.length ? Math.min(...xs.map((t) => t.at)) : null, ours: xs.filter((t) => (PERP_COINS as readonly string[]).includes(t.coin)).length };
}
/**
 * minOurs (solanaPerps.traderMinOurs, 0 = off): that many of the closed paper copies must be on SOL, BTC or ETH, the
 * only coins traded for real (review 63 of 16 Nov 2026: fe7ce058 went real with 0 of its 28 paper copies on them).
 */
export const traderMeetsBar = (x: { trades: number; won: number; netUsd: number; firstAt: number | null; ours?: number }, now = Date.now(), minOurs = 0) =>
  x.trades >= TRADER_MIN_COPIES && x.won * 2 >= x.trades && x.netUsd > 0 && x.firstAt !== null && now - x.firstAt >= TRADER_MIN_AGE_MS && (x.ours ?? 0) >= minOurs;
/** Does this perp rule, or this copied trader, meet its bar for real on the paper trades made after `sinceMs`? */
export const perpMeetsBar = (rule: string, sinceMs = 0, now = Date.now(), minOurs = 0) => (isTraderRule(rule) ? traderMeetsBar(traderRecord(rule, sinceMs), now, minOurs) : meetsBar(perpPaperRecord(rule, sinceMs)));
/**
 * Does this trader meet the bar on its OWN closed positions made after `sinceMs` (see hlTrips)? Only a trader on the
 * list, read in the last two days, whose paper copies (when there are 5 or more) are not behind.
 */
/**
 * JUST THE BEST (enrique, 21 Nov 2026 08:17-08:23 KST: "so maybe we need some more traders but not a ton of them no?",
 * "yea just the best"; the wallets were filling up: 25 positions, about $170 free). A trader that meets the bar on
 * its last HIST_FIRST_DAYS days alone is approved as before (the traders approved until then). One that meets it
 * only on the longer look is approved when it is among the `top` best of those by its own result (the sum of its
 * positions' results, what copies of one size would have made). top = Infinity: all of them.
 */
export const HIST_FIRST_DAYS = 30;
const histSum = (trips: Trip[], now: number) => trips.filter((x) => x[0] > now - HIST_DAYS * 86_400_000).reduce((a, x) => a + x[1], 0);
const histOk = (rule: string, sinceMs: number, now: number): { at: number; trips: Trip[] } | null => {
  const t = state.hlTraders.find((x) => traderRule(x.address) === rule);
  const h = t && state.hlHist?.[t.address];
  if (!h || now - h.at > 2 * HIST_REFRESH_MS) return null;
  const paper = traderRecord(rule, sinceMs);
  return paper.trades >= 5 && !(paper.netUsd > 0) ? null : h;
};
let longRank: { now: number; rules: string[] } | null = null;
/** The traders that meet the bar only on the longer look, best first (their whole record, whatever was cut). */
function histLongOnly(now: number): string[] {
  if (longRank?.now === now) return longRank.rules;
  const rows: [string, number][] = [];
  for (const t of state.hlTraders) {
    const rule = traderRule(t.address);
    const h = histOk(rule, 0, now);
    if (h && !histMeetsBar(h.trips, 0, now, HIST_FIRST_DAYS) && histMeetsBar(h.trips, 0, now)) rows.push([rule, histSum(h.trips, now)]);
  }
  longRank = { now, rules: rows.sort((a, b) => b[1] - a[1]).map((x) => x[0]) };
  return longRank.rules;
}
export function hlHistoryMeetsBar(rule: string, sinceMs = 0, now = Date.now(), top = Infinity): boolean {
  if (!loaded) load();
  const h = histOk(rule, sinceMs, now);
  if (!h) return false;
  if (histMeetsBar(h.trips, sinceMs, now, HIST_FIRST_DAYS)) return true;
  if (!histMeetsBar(h.trips, sinceMs, now)) return false;
  const i = histLongOnly(now).indexOf(rule);
  return i >= 0 && i < top;
}
/** A trader's own closed positions of the last HIST_DAYS days: their average result, in % (null = not read or none). */
export function hlHistoryAvgPct(rule: string, now = Date.now()): number | null {
  if (!loaded) load();
  const t = state.hlTraders.find((x) => traderRule(x.address) === rule);
  const xs = t ? (state.hlHist?.[t.address]?.trips ?? []).filter((x) => x[0] > now - HIST_DAYS * 86_400_000) : [];
  return xs.length ? (xs.reduce((a, x) => a + x[1], 0) * 100) / xs.length : null;
}
/** For the status: how many histories are read, who passes on them, each by its short name. */
export function hlHistorySummary(now = Date.now(), top = Infinity) {
  if (!loaded) load();
  const rows = state.hlTraders.flatMap((t) => {
    const h = state.hlHist?.[t.address];
    if (!h) return [];
    const xs = h.trips.filter((x) => x[0] > now - HIST_DAYS * 86_400_000);
    const rule = traderRule(t.address);
    return [{ id: rule, closed: xs.length, won: xs.filter((x) => x[1] > 0).length, sumPct: r(xs.reduce((a, x) => a + x[1], 0) * 100, 2), atBar: hlHistoryMeetsBar(rule, 0, now, top), on90Only: histLongOnly(now).includes(rule), paperAtBar: traderMeetsBar(traderRecord(rule), now), accountUsd: t.acct ? Math.round(t.acct) : null }];
  });
  return {
    note: `A trader's own closed positions of the last ${HIST_DAYS} days on Hyperliquid ($${HL_MIN_POS_USD}+ at their largest, held ${HIST_MIN_HOLD_MS / 60_000}+ minutes), each as its result over its largest size. Same bar as paper: ${TRADER_MIN_COPIES}+ closed, half or more won, ahead; 5+ paper copies of ours that are behind keep it out. Met on the last ${HIST_FIRST_DAYS} days alone: approved. Met only on the ${HIST_DAYS} days: only the best ${Number.isFinite(top) ? top : "(all)"} of those by their own result.`,
    top: Number.isFinite(top) ? top : null,
    passOn90Only: histLongOnly(now).length,
    addedOn90: rows.filter((x) => x.atBar && x.on90Only).length,
    followed: state.hlTraders.length,
    read: rows.length,
    with20: rows.filter((x) => x.closed >= TRADER_MIN_COPIES).length,
    atBar: rows.filter((x) => x.atBar).length,
    atBarNotOnPaper: rows.filter((x) => x.atBar && !x.paperAtBar).length,
    traders: rows.filter((x) => x.atBar).sort((a, b) => (b.sumPct ?? 0) - (a.sumPct ?? 0)).slice(0, 200),
    skill: hlSkillSummary(now, (rule) => rows.some((x) => x.id === rule && x.atBar)),
    entryGap: hlEntryGap(),
  };
}
/**
 * PAPER ONLY second ranking (22 Nov 2026, enrique: "yeah" to building it beside the current bar; nothing live reads it):
 * each followed trader's own closed positions put through src/hyperliquid/skill.ts (beats BTC by 2+ standard errors,
 * ahead without its best 3, ahead in 2 of 3 periods), set against who the live bar approves today.
 */
/** Each listed trader's skill test (src/hyperliquid/skill.ts) on a history read in the last 2 days, kept a minute. */
let skillCache: { at: number; by: Map<string, Skill> } | null = null;
export function hlSkill(rule: string, now = Date.now()): Skill | null {
  if (!loaded) load();
  if (!skillCache || now < skillCache.at || now - skillCache.at > 60_000) {
    const by = new Map<string, Skill>();
    const btc = state.hlBtc?.c ?? [];
    for (const t of state.hlTraders) {
      const h = state.hlHist?.[t.address];
      if (h && h.v === HIST_V && now - h.at <= 2 * HIST_REFRESH_MS) by.set(traderRule(t.address), skillOf(h.trips, btc, now - HIST_DAYS * 86_400_000, now));
    }
    skillCache = { at: now, by };
  }
  return skillCache.by.get(rule) ?? null;
}
/** Does the trader pass the skill test (25 Nov 2026, enrique: "push skill bar: HL history traders must pass the skill test, passers get cash first"). */
export const hlSkillPass = (rule: string, now = Date.now()) => !!hlSkill(rule, now)?.pass;
export function hlSkillSummary(now = Date.now(), approved: (rule: string) => boolean = () => false) {
  if (!loaded) load();
  const btc = state.hlBtc?.c ?? [];
  const since = now - HIST_DAYS * 86_400_000;
  const rows = state.hlTraders.flatMap((t) => {
    const h = state.hlHist?.[t.address];
    if (!h || h.v !== HIST_V) return [];
    const rule = traderRule(t.address);
    return [{ id: rule, approvedNow: approved(rule), ...skillOf(h.trips, btc, since, now), accountUsd: t.acct ? Math.round(t.acct) : null }];
  });
  const judged = rows.filter((x) => x.n >= SKILL_MIN_N);
  const why: Record<string, number> = {};
  for (const x of judged) why[x.why] = (why[x.why] ?? 0) + 1;
  // our own closed paper copies of the traders that pass, and of those the live bar approves that fail
  const ours = (ids: string[]) => {
    const xs = state.hlTrades.filter((t) => ids.includes(traderRule(t.trader)));
    return { copies: xs.length, won: xs.filter((t) => t.net > 0).length, sumPct: r(xs.reduce((a, t) => a + t.net, 0) * 100, 2) };
  };
  const pass = judged.filter((x) => x.pass);
  const failApproved = judged.filter((x) => !x.pass && x.approvedNow);
  return {
    note: `PAPER ONLY, nothing live reads this. A trader's own closed positions of the last ${HIST_DAYS} days ($${HL_MIN_POS_USD}+, held ${HIST_MIN_HOLD_MS / 60_000}+ min), each minus what the same side on BTC made over the same hours (BTC at beta 1, so small coins keep some market move). Passes: ${SKILL_MIN_N}+ closed, average beats BTC by ${SKILL_MIN_T}+ standard errors, still ahead without its best 3, ahead in ${SKILL_MIN_PERIODS_AHEAD} of ${SKILL_PERIODS} equal periods. marketShare = part of a trader's result that BTC's move explains.`,
    btcHours: btc.length,
    read: rows.length,
    judged: judged.length,
    pass: pass.length,
    approvedNow: rows.filter((x) => x.approvedNow).length,
    approvedAndPass: pass.filter((x) => x.approvedNow).length,
    approvedButFail: failApproved.length,
    passNotApproved: pass.filter((x) => !x.approvedNow).length,
    whyNot: why,
    ourPaperCopies: { pass: ours(pass.map((x) => x.id)), approvedButFail: ours(failApproved.map((x) => x.id)) },
    traders: [...judged].sort((a, b) => (b.exT ?? -99) - (a.exT ?? -99)).slice(0, 40),
  };
}
/**
 * Our entry against the trader's (22 Nov 2026, enrique: "inform me of our delay and fill price"): the paper copy's
 * price (the mid when we saw the position) against the trader's own average entry at that moment. Positive = we got a
 * worse price than the trader. The trader's average includes adds made before we saw it, so on a position built in
 * steps it overstates what the delay cost. Looks: copied traders every minute, the rest every 3-4 minutes.
 */
export function hlEntryGap() {
  if (!loaded) load();
  const xs = [...state.hlOpen.map((o) => entryGapPct(o.dir, o.entry, o.their ?? 0)), ...state.hlTrades.map((t) => entryGapPct(t.dir, t.entry ?? 0, t.their ?? 0))].filter((x): x is number => x != null);
  return { note: "Paper copy's price (mid when we saw the position) against the trader's own average entry then, in %; positive = worse for us. Since 22 Nov 2026.", ...gapStats(xs) };
}
/** The perp paper positions that are open now (rules and copied traders' shorts), each with a name of its own. */
export function perpPaperOpens(): { id: string; rule: string; coin: string; dir: number; at: number; lev?: number }[] {
  if (!loaded) load();
  return [
    ...state.perpOpen.map((o) => ({ id: `${o.rule}:${o.at}`, rule: o.rule, coin: o.coin, dir: o.dir, at: o.at })),
    // a copied trader's long or short on SOL, BTC or ETH, under the trader's own name and with the leverage the trader
    // set: each trader is promoted on its own record
    ...state.hlOpen.filter((o) => (PERP_COINS as readonly string[]).includes(o.coin)).map((o) => ({ id: `${traderRule(o.trader)}:${o.coin}:${o.at}`, rule: traderRule(o.trader), coin: o.coin, dir: o.dir, at: o.at, lev: o.lev })),
  ];
}
/** Every copied trader's open paper copy, on EVERY coin (the Hyperliquid front trades them all; Solana perps only three). */
export function hlPaperOpens(): { id: string; rule: string; coin: string; dir: number; at: number; lev?: number; px?: number; left?: number; hist?: [number, number][]; share?: number; their?: number }[] {
  if (!loaded) load();
  // left: the share of its opening size the trader still holds (never above 1: what it adds is not followed); share:
  // the position's value against the trader's account when it opened
  return state.hlOpen.map((o) => ({ id: `${traderRule(o.trader)}:${o.coin}:${o.at}`, rule: traderRule(o.trader), coin: o.coin, dir: o.dir, at: o.at, lev: o.lev, px: o.entry, ...(o.sz0 && o.szNow ? { left: Math.min(1, o.szNow / o.sz0) } : {}), ...(o.sz0 && o.hist ? { hist: o.hist.map(([t, s]) => [t, Math.min(1, s / o.sz0!)] as [number, number]) } : {}), ...(o.share != null ? { share: o.share } : {}), ...(o.their ? { their: o.their } : {}) }));
}
/**
 * Jupiter's order-book coins (gumlive.ts, 17 Nov 2026): a copied trader's open position on one of `coins` (never SOL,
 * BTC or ETH, which the JLP pool trades), in the same shape as perpPaperOpens.
 */
export function perpPaperOpensOn(coins: string[]): { id: string; rule: string; coin: string; dir: number; at: number; lev?: number }[] {
  if (!loaded) load();
  return state.hlOpen
    .filter((o) => coins.includes(o.coin) && !(PERP_COINS as readonly string[]).includes(o.coin))
    .map((o) => ({ id: `${traderRule(o.trader)}:${o.coin}:${o.at}`, rule: traderRule(o.trader), coin: o.coin, dir: o.dir, at: o.at, lev: o.lev }));
}
/** One perp rule's closed paper trades since `sinceMs`, in the shape of the bar (net in units of one position). */
export function perpPaperRecord(rule: string, sinceMs = 0) {
  if (!loaded) load();
  const xs = rule === COPY_SHORTS ? state.hlTrades.filter((t) => isCopyShort(t) && t.at > sinceMs) : isTraderRule(rule) ? state.hlTrades.filter((t) => traderRule(t.trader) === rule && t.at > sinceMs) : state.perpTrades.filter((t) => t.rule === rule && t.at > sinceMs);
  return { trades: xs.length, won: xs.filter((t) => t.net > 0).length, netUsd: xs.reduce((a, t) => a + t.net, 0) * PERP_USD };
}
let perpRealSummary: () => unknown = () => null;
export const setPerpsRealSummary = (f: () => unknown) => void (perpRealSummary = f);
let realSummary: () => unknown = () => null;
export const setBucketsRealSummary = (f: () => unknown) => void (realSummary = f);

let timer: ReturnType<typeof setInterval> | null = null;
export function startBuckets(deps: BucketDeps) {
  if (process.env.SOLANA_BUCKETS === "off" || timer) return;
  timer = setInterval(() => void bucketsTick(deps), 60_000);
  timer.unref();
  setTimeout(() => void bucketsTick(deps), 20_000).unref();
}
export function stopBuckets() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test hooks. */
export const _bucketsTest = { reset: () => ((longRank = null), (lookSeq = 0), appliedSeq.clear(), quick.clear(), (quickLog = []), (watchedCache = null), (fastHooks = {}), (state = fresh()), (loaded = true), (copyRows = []), (copyAt = 0)), state: () => state, reload: () => load(), hlTick };
