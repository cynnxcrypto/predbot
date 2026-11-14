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
];
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
export const HL_FOLLOW = 60;
export const HL_MIN_ACCOUNT_USD = 100_000;
export const HL_MIN_MONTH_ROI = 0.1;
export const HL_MAX_TURNOVER = 200; // month volume / account: above this it is a market maker or a bot
export const HL_MIN_POS_USD = 10_000;
export const HL_MAX_HOLD_MS = 14 * 86_400_000;
const HL_REFRESH_MS = 24 * 3_600_000;
const HL_PER_TICK = 20;
/** coins a Solana venue lists; SOL, BTC, ETH at Jupiter's price, the rest at an order book's (0.04% + spread) */
export const hlCost = (coin: string) => ((PERP_COINS as readonly string[]).includes(coin) ? PERP_FEE_SIDE : 0.0006);
export interface HlTrader {
  address: string;
  monthPnl: number;
  monthRoi: number;
}
/** The leaderboard -> traders worth following: ahead over the week, the month and all time, real size, not a machine. */
export function hlPick(board: unknown): HlTrader[] {
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
    if (!(week.pnl > 0) || !(month.pnl > 0) || !(allTime.pnl > 0) || !(month.roi >= HL_MIN_MONTH_ROI)) continue;
    const turn = month.vlm / acct;
    if (!(turn >= 1) || turn > HL_MAX_TURNOVER) continue;
    out.push({ address, monthPnl: month.pnl, monthRoi: month.roi });
  }
  return out.sort((a, b) => b.monthPnl - a.monthPnl).slice(0, HL_FOLLOW);
}
/** A trader's open positions out of a clearinghouseState answer: coin -> signed dollars. */
export function hlPositions(state: unknown): Record<string, number> | null {
  const rows = (state as { assetPositions?: unknown })?.assetPositions;
  if (!Array.isArray(rows)) return null;
  const out: Record<string, number> = {};
  for (const x of rows as { position?: Record<string, unknown> }[]) {
    const p = x?.position;
    const coin = typeof p?.coin === "string" && /^[A-Za-z0-9]{1,12}$/.test(p.coin) ? p.coin : null;
    const szi = Number(p?.szi);
    const val = Math.abs(Number(p?.positionValue));
    if (!coin || !Number.isFinite(szi) || szi === 0 || !(val >= HL_MIN_POS_USD)) continue;
    out[coin] = Math.sign(szi) * val;
  }
  return out;
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
}
interface PerpTrade {
  rule: string;
  coin: string;
  dir: number;
  at: number;
  exitAt: number;
  net: number;
}
interface HlOpen {
  trader: string;
  coin: string;
  dir: number;
  at: number;
  entry: number;
}
interface HlTrade {
  trader: string;
  coin: string;
  dir: number;
  at: number;
  exitAt: number;
  net: number;
  why: "closed" | "max hold";
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
  hlSeen: Record<string, Record<string, number>>;
  hlNext: number;
  hlOpen: HlOpen[];
  hlTrades: HlTrade[];
  mcap: Record<string, { b: Bucket | null; at: number }>;
  jupDay: number;
  jupCalls: number;
  errors: Record<string, string>;
}
const SORT_V = 4;
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
      if (o && (hour - o.hour >= rule.holdH || (rule.flip && sig !== 0 && sig !== o.dir))) {
        state.perpTrades.push({ rule: id, coin, dir: o.dir, at: o.at, exitAt: now, net: r(perpNet(o.dir, o.entry, px, (now - o.at) / 3_600_000), 6)! });
        state.perpOpen = state.perpOpen.filter((x) => x !== o);
      }
      if (sig !== 0 && !state.perpOpen.some((x) => x.rule === id)) state.perpOpen.push({ rule: id, coin, dir: sig, hour, at: now, entry: px });
    }
  }
  if (state.perpTrades.length > KEEP_TRADES) state.perpTrades = state.perpTrades.slice(-KEEP_TRADES);
  state.perpHour = lastClosed;
  delete state.errors.candles;
}

// ---- perps: copy ----------------------------------------------------------------------------------------------------------
async function hlPost(deps: BucketDeps, body: unknown): Promise<unknown> {
  const res = await deps.fetch()("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res) throw new Error("traders: no answer");
  if (!res.ok) throw new Error(`traders: http ${res.status}`);
  return res.json().catch(() => {
    throw new Error("traders: not json");
  });
}
async function hlTick(deps: BucketDeps, now: number) {
  if (now - state.hlAt > HL_REFRESH_MS || !state.hlTraders.length) {
    const res = await deps.fetch()("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard", { signal: AbortSignal.timeout(90_000) }).catch(() => null);
    state.hlAt = now - HL_REFRESH_MS + 1_800_000; // a failed read is tried again in half an hour, not every minute: the file is big
    if (!res) throw new Error("traders: no answer");
    if (!res.ok) throw new Error(`traders: http ${res.status}`);
    const picked = hlPick(await res.json().catch(() => null));
    if (!picked.length) throw new Error("traders: nothing usable");
    state.hlAt = now;
    state.hlTraders = picked;
    const keep = new Set([...picked.map((t) => t.address), ...state.hlOpen.map((o) => o.trader)]);
    for (const a of Object.keys(state.hlSeen)) if (!keep.has(a)) delete state.hlSeen[a];
  }
  const watch = [...new Set([...state.hlTraders.map((t) => t.address), ...state.hlOpen.map((o) => o.trader)])];
  let mids: Record<string, number> | null = null;
  const mid = async (coin: string) => {
    mids ??= Object.fromEntries(Object.entries((await hlPost(deps, { type: "allMids" })) as Record<string, string>).map(([k, v]) => [k, Number(v)]));
    return mids[coin] > 0 ? mids[coin] : null;
  };
  const shut = async (o: HlOpen, why: HlTrade["why"]) => {
    const px = await mid(o.coin);
    if (!px) return;
    const fee = hlCost(o.coin);
    const net = o.dir * (px / o.entry - 1) - 2 * fee - PERP_BORROW_HOUR * ((now - o.at) / 3_600_000);
    state.hlTrades.push({ trader: o.trader, coin: o.coin, dir: o.dir, at: o.at, exitAt: now, net: r(net, 6)!, why });
    state.hlOpen = state.hlOpen.filter((x) => x !== o);
  };
  for (let n = 0; n < Math.min(HL_PER_TICK, watch.length); n++) {
    const a = watch[state.hlNext++ % watch.length];
    const after = hlPositions(await hlPost(deps, { type: "clearinghouseState", user: a }));
    if (!after) continue;
    const before = state.hlSeen[a];
    state.hlSeen[a] = after;
    if (!before) continue; // first look: what it already holds was opened at prices we never saw
    const { opened, closed } = hlDiff(before, after);
    for (const coin of closed) for (const o of state.hlOpen.filter((x) => x.trader === a && x.coin === coin)) await shut(o, "closed");
    if (!state.hlTraders.some((t) => t.address === a)) continue; // dropped from the list: only its open copies are finished
    for (const { coin, dir } of opened) {
      const px = await mid(coin);
      if (px && !state.hlOpen.some((x) => x.trader === a && x.coin === coin)) state.hlOpen.push({ trader: a, coin, dir, at: now, entry: px });
    }
  }
  for (const o of state.hlOpen.filter((x) => now - x.at >= HL_MAX_HOLD_MS)) await shut(o, "max hold");
  if (state.hlTrades.length > KEEP_TRADES) state.hlTrades = state.hlTrades.slice(-KEEP_TRADES);
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
    note: `Paper only, nothing is sent. SPOT: coins from Jupiter's lists in four buckets by market value, up to ${PER_BUCKET} each, priced once a minute and kept as 5-minute closes. A rule buys on a 5-minute close; the buy is a real quote for a $${STAKE_USD} swap taken after the signal and the sale a real quote for the swap back, less $${TX_USD} a transaction. Thresholds are the rule's base move times the bucket's scale (${BUCKETS.map((b) => `${b} x${SCALE[b]}`).join(", ")}). PERPS: SOL, BTC, ETH on hourly candles, filled at the price when the hour's close is read, charged Jupiter Perps' ${PERP_FEE_SIDE * 100}% a side and ${PERP_BORROW_HOUR * 100}% an hour borrow, $${PERP_USD} a position. The history test (84 rules, 15 Nov 2026) found none that survives costs; "history" says what each did there. COPY, spot: the day-holder study's paper copies (bought ${COPY_ENTRY_S} s after we see the buy, sold ${COPY_EXIT_S} s after its first sale) sorted by the coin's bucket today. COPY, perps: up to ${HL_FOLLOW} traders from Hyperliquid's public leaderboard (ahead over week, month and all time, month +${HL_MIN_MONTH_ROI * 100}%+, account $${HL_MIN_ACCOUNT_USD}+, not a market maker), each looked at about every 3 minutes; a position of $${HL_MIN_POS_USD}+ they open is copied at the price we read after seeing it and closed when they close, charged a Solana venue's costs. Bar for real: 100+ trades on one rule or trader set, half or more won, net positive. A quote is the best case for a fill.`,
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
      last: state.perpLast,
      rules: PERP_COINS.flatMap((coin) =>
        PERP_RULES.map((x) => {
          const id = `${coin}-${x.key}`;
          const o = state.perpOpen.find((p) => p.rule === id);
          return { id, coin, text: x.text, history: x.history, ...tally(state.perpTrades.filter((t) => t.rule === id).map((t) => t.net), PERP_USD), open: o ? { side: o.dir > 0 ? "long" : "short", since: o.at, entry: o.entry, nowPct: state.perpLast[coin] ? r(perpNet(o.dir, o.entry, state.perpLast[coin].px, 0) * 100) : null } : null };
        }),
      ),
      recent: state.perpTrades.slice(-15).reverse().map((t) => ({ rule: t.rule, side: t.dir > 0 ? "long" : "short", openedAt: t.at, closedAt: t.exitAt, pct: r(t.net * 100) })),
    },
    perpCopy: {
      traders: state.hlTraders.length,
      listReadAt: state.hlAt || null,
      all: tally(state.hlTrades.map((t) => t.net), PERP_USD),
      majors: tally(state.hlTrades.filter((t) => major(t.coin)).map((t) => t.net), PERP_USD),
      others: tally(state.hlTrades.filter((t) => !major(t.coin)).map((t) => t.net), PERP_USD),
      shorts: tally(state.hlTrades.filter((t) => t.dir < 0).map((t) => t.net), PERP_USD),
      longs: tally(state.hlTrades.filter((t) => t.dir > 0).map((t) => t.net), PERP_USD),
      open: state.hlOpen.length,
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
export function paperOpens(): { rule: string; bucket: Bucket; mint: string; symbol: string; at: number }[] {
  if (!loaded) load();
  return state.open.map((o) => ({ rule: o.rule, bucket: o.bucket, mint: o.mint, symbol: o.symbol, at: o.at }));
}
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
export const _bucketsTest = { reset: () => ((state = fresh()), (loaded = true), (copyRows = []), (copyAt = 0)), state: () => state, reload: () => load() };
