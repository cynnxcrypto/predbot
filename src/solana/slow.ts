/**
 * PAPER / READ-ONLY: slow wallets. enrique, 13 Nov 2026: "search solana wallets". The idea from 12 Nov: find
 * traders who hold for hours or days and are verifiably ahead, so a copier a few seconds (or minutes) late loses
 * little of the move. Three steps, each a lead for the next, none a result:
 *
 *  1. SCREEN (cheap: the wallet's own transactions, about 10 Helius credits per 100). For each candidate (the listed
 *     wallets, then the busiest buyers the wallet finder has seen) the last DAYS_BACK days of its own SOL swaps are
 *     turned into round trips per coin (first buy until 90% of what it bought is sold). Realised SOL, how many trips
 *     a day, how long from its first buy to its first sell, how often it won, how much of its profit is one trade,
 *     and whether BOTH the older and the newer half of the period were profitable. Bots are left out.
 *  2. DELAY CHECK (only for wallets that pass): for its newest trips, what the coin traded at 30 s and 5 min after
 *     its first buy, and 30 s after its first sell, read from other people's swaps. The copier's round trip = enter
 *     late, sell 30 s after the wallet's first sell. Prices come from others' trades, so they are estimates.
 *  3. PAPER COPY (live, Jupiter quotes, nothing sent): when a followed wallet buys a coin it does not hold, buy
 *     STAKE_SOL of it ENTRY_DELAYS seconds later; when it first sells that coin, sell EXIT_DELAYS seconds later; an
 *     entry not made before its sale is dropped. MAX_HOLD_H closes what it never sold. The copy runner's stream
 *     hands over the followed wallets' transactions (slowTx).
 *
 * DAY HOLDERS (enrique, 13 Nov: "what about wallets that are not about quick fast trades?"). The first pass found
 * none among the listed wallets and the busiest pump.fun buyers: they flip in minutes. A third source of candidates:
 * coins that keep trading for days (Jupiter's most-traded, top organic and trending lists, 3+ days old, no stables or
 * staked SOL; plus coins our read wallets traded on 3+ different days), and the wallets that bought 0.2 SOL or more of
 * them at a few points over the past week (one page of 100 transactions a point, launch day left out). Buyers of more
 * of these coins come first. Cheaper reads: a full first page inside BOT_PAGE_H hours is a program and is not read
 * further; a wallet whose newest FAST_PAGES pages are already FAST_TRIPS+ trips with a median hold under FAST_HOLD_MIN
 * min is a flipper and is not read further either. Both are read again weekly.
 *
 * Small-buy bait (enrique, 13 Nov): every trip records the wallet's first buy size; the screen reports how many
 * trips started under half its usual size and the delay check splits the copier's result the same way.
 * Prices are before our own fees except where TX_SOL is taken off; realised SOL is before network fees.
 * SOLANA_SLOW=off disables. SOLANA_SLOW_CREDITS_DAY caps its own Helius credits (default 60,000 a day).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../config.js";
import { swapOf, type Meta } from "./discover.js";
import { makeReader, refused, scrub, type Item } from "./history.js";
import type { Tracked } from "./wallets.js";

export const DAYS_BACK = 14;
const WALLET_PAGES = 12; // x100 transactions, newest first
const CREDITS_DAY = Math.max(1000, Number(process.env.SOLANA_SLOW_CREDITS_DAY) || 60_000);
const REFRESH_MS = 24 * 3_600_000;
export const MAX_CANDIDATES = 400;
const KEEP_SWAPS = 2000;
const BOT_REFRESH_MS = 7 * 86_400_000;
// the screen
export const MIN_TRIPS = 20;
export const MIN_HOLD_MIN = 30;
export const MIN_WIN = 0.4;
export const MAX_TOP_SHARE = 0.5;
export const CLOSE_SHARE = 0.9;
// the delay check
export const DELAY_TRIPS = 30;
export const DELAY_SEC = [30, 300] as const;
export const EXIT_SEC = 30;
const SLOTS_PER_SEC = 2.5;
const SPREAD = 0.02; // the other side's price marked to ours when no same-side trade is there
export const DELAY_COST = 0.01; // fees and price impact of a small copy, both ways
// the paper copy
export const FOLLOW_MAX = 25;
export const STAKE_SOL = 0.25;
export const TX_SOL = 0.001;
export const ENTRY_DELAYS = [5, 30, 300, 1800] as const;
export const EXIT_DELAYS = [5, 30] as const;
export const MAX_HOLD_H = 72;
// cheaper reads
export const BOT_PAGE_H = 3; // 100 transactions in under 3 hours: 800+ a day
export const FAST_PAGES = 2;
export const FAST_TRIPS = 10;
export const FAST_HOLD_MIN = 10;
// day-holder candidates
export const COIN_MIN_AGE_D = 3;
export const SAMPLE_DAYS = [0.5, 2, 4, 6] as const;
export const MIN_BUYER_SOL = 0.2;
export const MAX_COINS = 150; // sampled a week
export const MAX_COIN_BUYERS = 1500;
const COIN_REFRESH_MS = 6 * 3_600_000;
const COIN_RESAMPLE_MS = 7 * 86_400_000;
const MAX_POOL = 6000;
const JUP_LISTS = ["toptraded/24h", "toporganicscore/24h", "toptrending/24h"] as const;
const LAMPORTS = 1e9;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const STABLES = new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r = (x: number | null | undefined, n = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ---- step 1: round trips and the screen --------------------------------------------------------------------------
export interface SSwap {
  t: number;
  slot: number;
  mint: string;
  buy: boolean;
  sol: number;
  tokens: number;
}
export interface Trip {
  mint: string;
  /** first buy: time, slot, price (SOL a token), size */
  t0: number;
  slot0: number;
  p0: number;
  firstSol: number;
  /** first sell */
  t1: number;
  slot1: number;
  p1: number;
  /** the sell that brought it to CLOSE_SHARE sold */
  tClose: number;
  buySol: number;
  sellSol: number;
  buys: number;
  sells: number;
  /** filled by the delay check: prices at 30 s and 5 min after the first buy, and 30 s after the first sell */
  e30?: number | null;
  e300?: number | null;
  x30?: number | null;
}

/** A wallet's swaps turned into closed round trips per coin; a coin it held before the window, or still holds, is left out. */
export function tripsOf(swaps: SSwap[]): { trips: Trip[]; open: number } {
  const by = new Map<string, SSwap[]>();
  for (const s of swaps) {
    const l = by.get(s.mint);
    if (l) l.push(s);
    else by.set(s.mint, [s]);
  }
  const trips: Trip[] = [];
  let open = 0;
  for (const [mint, list] of by) {
    list.sort((a, b) => a.slot - b.slot || a.t - b.t);
    let o: (Omit<Trip, "t1" | "slot1" | "p1" | "tClose"> & { t1: number | null; slot1: number; p1: number; bought: number; sold: number }) | null = null;
    for (const s of list) {
      if (s.tokens <= 0 || s.sol <= 0) continue;
      if (s.buy) {
        o ??= { mint, t0: s.t, slot0: s.slot, p0: s.sol / s.tokens, firstSol: s.sol, t1: null, slot1: 0, p1: 0, buySol: 0, sellSol: 0, buys: 0, sells: 0, bought: 0, sold: 0 };
        o.buySol += s.sol;
        o.bought += s.tokens;
        o.buys++;
        continue;
      }
      if (!o) continue; // bought before the window
      if (o.t1 === null) [o.t1, o.slot1, o.p1] = [s.t, s.slot, s.sol / s.tokens];
      o.sellSol += s.sol;
      o.sold += s.tokens;
      o.sells++;
      if (o.sold >= CLOSE_SHARE * o.bought) {
        const { bought: _b, sold: _s, ...rest } = o;
        trips.push({ ...rest, t1: o.t1, tClose: s.t });
        o = null;
      }
    }
    if (o) open++;
  }
  trips.sort((a, b) => a.t0 - b.t0);
  return { trips, open };
}

const pnl = (t: Trip) => t.sellSol - t.buySol;
const holdMin = (t: Trip) => (t.t1 - t.t0) / 60;

/** The copier's round trip on one past trip, entering `d` seconds late and selling 30 s after the wallet's first sell. */
export function lateRet(t: Trip, d: (typeof DELAY_SEC)[number]): number | null {
  const e = d === 30 ? t.e30 : t.e300;
  if (!e || !t.x30) return null;
  // the wallet had already sold before a 5 min entry: no copy
  if (t.t1 - t.t0 <= d) return null;
  return t.x30 / e - 1 - DELAY_COST;
}
/** The wallet's own first-sell-over-first-buy, the same exit the copier follows. */
export const ownRet = (t: Trip) => t.p1 / t.p0 - 1;

export function screen(trips: Trip[], o: { txPerDay: number; buysPerDay: number; spanDays: number; open: number }) {
  const n = trips.length;
  const total = trips.reduce((a, t) => a + pnl(t), 0);
  const won = trips.filter((t) => pnl(t) > 0).length;
  const holds = trips.map(holdMin);
  const hold = median(holds);
  const usual = median(trips.map((t) => t.firstSol));
  const small = usual ? trips.filter((t) => t.firstSol < usual / 2) : [];
  const best = trips.reduce((a, t) => Math.max(a, pnl(t)), 0);
  const topShare = total > 0 ? best / total : null;
  const older = trips.slice(0, Math.floor(n / 2)).reduce((a, t) => a + pnl(t), 0);
  const newer = trips.slice(Math.floor(n / 2)).reduce((a, t) => a + pnl(t), 0);
  // hundreds of transactions a day, dozens of fresh coins a day or a typical hold of a minute or two is a program
  const bot = o.txPerDay > 400 || o.buysPerDay > 60 || (hold !== null && hold < 2);
  const why: string[] = [];
  if (bot) why.push("bot");
  if (n < MIN_TRIPS) why.push(`${n} trips`);
  if (hold === null || hold < MIN_HOLD_MIN) why.push(`holds ${r(hold, 0)} min`);
  if (total <= 0) why.push("lost");
  else if (older <= 0 || newer <= 0) why.push("one half lost");
  if (n && won / n < MIN_WIN) why.push(`${Math.round((won / n) * 100)}% won`);
  if (topShare !== null && topShare >= MAX_TOP_SHARE) why.push("one trade");
  const late = (d: (typeof DELAY_SEC)[number], list = trips) => {
    const v = list.map((t) => lateRet(t, d)).filter((x): x is number => x !== null);
    return { n: v.length, won: v.filter((x) => x > 0).length, avgPct: r((avg(v) ?? NaN) * 100), medianPct: r((median(v) ?? NaN) * 100) };
  };
  const checked = trips.filter((t) => t.x30 !== undefined);
  const own = checked.map(ownRet).filter(Number.isFinite);
  return {
    trips: n,
    open: o.open,
    tripsPerDay: r(n / Math.max(o.spanDays, 1 / 24)),
    spanDays: r(o.spanDays),
    realisedSol: r(total, 2),
    wonPct: n ? Math.round((won / n) * 100) : null,
    holdMinMedian: r(hold, 0),
    holdOverHourPct: n ? Math.round((holds.filter((h) => h >= 60).length / n) * 100) : null,
    buySolMedian: r(usual, 2),
    smallStartPct: n ? Math.round((small.length / n) * 100) : null,
    topTradeSharePct: topShare === null ? null : Math.round(topShare * 100),
    olderSol: r(older, 2),
    newerSol: r(newer, 2),
    txPerDay: Math.round(o.txPerDay),
    bot,
    pass: why.length === 0,
    why,
    late: {
      checked: checked.length,
      ownAvgPct: r((avg(own) ?? NaN) * 100),
      in30s: late(30),
      in5min: late(300),
      in5minSmallStarts: late(300, small),
      in5minUsualStarts: late(300, trips.filter((t) => !small.includes(t))),
    },
  };
}

/** A price from the first trades of a coin after a slot: same-side trades when there are two, else the other side marked over. */
export function priceAfter(swaps: { buy: boolean; sol: number; price: number }[], side: "entry" | "exit"): number | null {
  const first = swaps.filter((s) => s.sol >= 0.05 && s.price > 0).slice(0, 8);
  const same = first.filter((s) => (side === "entry" ? s.buy : !s.buy)).map((s) => s.price);
  if (same.length >= 2) return median(same);
  if (!first.length) return null;
  return median(first.map((s) => (s.buy === (side === "entry") ? s.price : side === "entry" ? s.price * (1 + SPREAD) : s.price * (1 - SPREAD))));
}

// ---- step 3: the paper copy --------------------------------------------------------------------------------------
export interface Pos {
  wallet: string;
  name: string;
  mint: string;
  /** when we saw its buy, ms; its size */
  seenMs: number;
  leaderSol: number;
  /** our tokens per entry delay (raw units as text); null = no price; "cancel" = it sold before this entry */
  entries: Record<string, string | null | "cancel" | "missed">;
  /** when we saw its first sell, ms */
  soldMs?: number;
  /** SOL back per `e{entry}-x{exit}` */
  exits: Record<string, number | null>;
  closed?: "sold" | "max hold" | "sold while we were down";
  closedMs?: number;
}
export const entryKey = (d: number) => `e${d}`;
export const exitKey = (d: number, x: number) => `e${d}-x${x}`;
/** One copy's return after costs, or undefined when it was not made or not priced. */
export function posRet(p: Pos, d: number, x: number): number | undefined {
  const tok = p.entries[entryKey(d)];
  if (tok == null || tok === "cancel" || tok === "missed") return undefined;
  const back = p.exits[exitKey(d, x)];
  if (back === undefined) return undefined;
  if (back === null) return -1; // nothing could be sold
  return (back - 2 * TX_SOL) / STAKE_SOL - 1;
}
export function paperRules(ps: Pos[]) {
  const done = ps.filter((p) => p.closed);
  return ENTRY_DELAYS.flatMap((d) =>
    EXIT_DELAYS.map((x) => {
      const v = done.map((p) => posRet(p, d, x)).filter((y): y is number => y !== undefined);
      const net = v.reduce((a, b) => a + b, 0) * STAKE_SOL;
      return { id: `slow-e${d}-x${x}`, text: `Buys ${STAKE_SOL} SOL ${when(d)} after a followed wallet buys a coin; sells ${x} s after its first sale of it.`, n: v.length, won: v.filter((y) => y > 0).length, netSol: r(net, 3), avgRetPct: v.length ? r((net / STAKE_SOL / v.length) * 100) : null, medianRetPct: r((median(v) ?? NaN) * 100) };
    }),
  );
}
const when = (d: number) => (d < 60 ? `${d} s` : `${d / 60} min`);

// ---- runner ------------------------------------------------------------------------------------------------------
/** A swap as stored: [time, slot, coin, 1 = buy, SOL, tokens] (the file holds hundreds of wallets). */
type Packed = [number, number, string, 0 | 1, number, number];
const pack = (s: SSwap): Packed => [s.t, s.slot, s.mint, s.buy ? 1 : 0, Math.round(s.sol * 1e6) / 1e6, Number(s.tokens.toPrecision(8))];
const unpack = ([t, slot, mint, b, sol, tokens]: Packed): SSwap => ({ t, slot, mint, buy: b === 1, sol, tokens });
type Source = "list" | "busy" | "coin";
interface Cand {
  name: string;
  address: string;
  source?: Source;
}
const srcOf = (c: Cand): Source => c.source ?? (c.name.startsWith("seen ") ? "busy" : "list");
/** A coin that trades for days: where it came from, the days it was on a list, when its buyers were sampled. */
interface Coin {
  symbol: string;
  from: "jupiter" | "ours";
  days: string[];
  createdMs: number | null;
  sampledAt?: number;
  buyers?: number;
}
interface WState {
  name: string;
  doneAt: number;
  newest: number;
  txPerDay: number;
  buysPerDay: number;
  spanDays: number;
  /** a program by its pace: its swaps are not kept and it is read again only weekly */
  bot?: boolean;
  /** a flipper by its newest transactions (not read further): trips, median hold, realised SOL, % won; read again weekly */
  fast?: { trips: number; holdMin: number; sol: number; wonPct: number };
  swaps: Packed[];
  /** delay-check prices by `${mint}|${slot0}` */
  late: Record<string, { e30: number | null; e300: number | null; x30: number | null }>;
}
interface State {
  day: string;
  credits: number;
  candidates: Cand[];
  wallets: Record<string, WState>;
  coins: Record<string, Coin>;
  /** buyers seen in the coin samples, not yet candidates: [coin keys joined by commas, SOL bought] */
  pool: Record<string, [string, number]>;
  open: Pos[];
  recent: Pos[];
}
/** The screen (large, saved at most once a minute) and the paper copies (small, saved at every change) apart. */
const FILE = () => join(DATA, "solana", "slow-wallets.json");
const PAPER = () => join(DATA, "solana", "slow-paper.json");
const ROWS = () => join(DATA, "solana", "slow-copies.jsonl");
const empty = (): State => ({ day: "", credits: 0, candidates: [], wallets: {}, coins: {}, pool: {}, open: [], recent: [] });
let state: State = empty();
let savedAt = 0;
const health = { state: "off", calls: 0, errors: 0, lastError: "", working: "", entries: 0, exits: 0, quoteMisses: 0, sellsSeen: 0, buysSeen: 0 };
const coinHealth = { lists: "not asked", listsAt: 0, lastError: "" };
let stopped = true;
type Quote = (inMint: string, outMint: string, amount: string) => Promise<bigint | null | undefined>;
let cfg: { rpcUrl: () => string | null; fetch: () => typeof fetch; listed: () => Tracked[]; busy: (k: number) => string[]; quote: Quote; jup?: (path: string) => Promise<unknown> } | null = null;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const timers = new Set<NodeJS.Timeout>();
const later = (ms: number, f: () => void) => {
  const t = setTimeout(() => {
    timers.delete(t);
    f();
  }, Math.max(0, ms));
  timers.add(t);
};

const write = (f: string, x: unknown) => {
  mkdirSync(join(DATA, "solana"), { recursive: true });
  writeFileSync(f + ".tmp", JSON.stringify(x));
  renameSync(f + ".tmp", f);
};
/** The paper copies, now. */
function save() {
  try {
    write(PAPER(), { open: state.open, recent: state.recent });
  } catch {
    /* next time */
  }
}
/** The screen, at most once a minute unless `now`. */
function saveScreen(now = false) {
  if (!now && Date.now() - savedAt < 60_000) return;
  savedAt = Date.now();
  try {
    const { open: _o, recent: _r, ...screen } = state;
    write(FILE(), screen);
  } catch {
    /* next time */
  }
}
function today() {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== state.day) {
    state.day = d;
    state.credits = 0;
  }
}
const page = makeReader({
  url: () => cfg?.rpcUrl(),
  fetch: () => cfg!.fetch(),
  canSpend: () => (today(), state.credits < CREDITS_DAY),
  spent: (c) => (state.credits += c),
  called: () => health.calls++,
});
const payerOf = (it: { transaction?: { message?: { accountKeys?: (string | { pubkey: string })[] } } }) => {
  const k = it.transaction?.message?.accountKeys?.[0];
  return typeof k === "string" ? k : (k?.pubkey ?? null);
};
const sswapOf = (meta: Meta | null | undefined, wallet: string, slot: number, t: number): SSwap | null => {
  const s = swapOf(meta, wallet, slot);
  return s && s.wallet === wallet && s.price > 0 ? { t, slot, mint: s.mint, buy: s.buy, sol: s.sol, tokens: s.sol / s.price } : null;
};

/** Candidates: the listed wallets, then the busiest buyers the finder has seen, kept across restarts. */
function refreshCandidates() {
  const have = new Set(state.candidates.map((c) => c.address));
  for (const w of cfg?.listed() ?? []) {
    if (have.has(w.address) || w.fomo) continue;
    have.add(w.address);
    state.candidates.push({ name: w.name, address: w.address, source: "list" });
  }
  let base = state.candidates.filter((c) => srcOf(c) !== "coin").length;
  for (const a of cfg?.busy(MAX_CANDIDATES) ?? []) {
    if (base >= MAX_CANDIDATES) break;
    if (have.has(a)) continue;
    have.add(a);
    state.candidates.push({ name: `seen ${a.slice(0, 4)}`, address: a, source: "busy" });
    base++;
  }
}

// ---- day-holder candidates: buyers of coins that keep trading for days ---------------------------------------------
/** Coins from one of Jupiter's token lists: no SOL, no stablecoins, no staked SOL. createdMs = its first pool, if given. */
export function jupCoins(rows: unknown): { mint: string; symbol: string; createdMs: number | null }[] {
  if (!Array.isArray(rows)) return [];
  const out: { mint: string; symbol: string; createdMs: number | null }[] = [];
  for (const x of rows as Record<string, unknown>[]) {
    const mint = typeof x?.id === "string" ? x.id : typeof x?.address === "string" ? x.address : null;
    if (!mint || mint === SOL_MINT || STABLES.has(mint)) continue;
    const symbol = String(x.symbol ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || mint.slice(0, 4);
    const tags = Array.isArray(x.tags) ? x.tags.map(String) : [];
    if (tags.includes("lst") || /USD/i.test(symbol) || (symbol.length > 3 && symbol.toUpperCase().endsWith("SOL"))) continue;
    const created = Date.parse(String((x.firstPool as { createdAt?: unknown } | undefined)?.createdAt ?? ""));
    out.push({ mint, symbol, createdMs: Number.isFinite(created) ? created : null });
  }
  return out;
}
/** Trades for days: its first pool is COIN_MIN_AGE_D+ days old, or (no date given) it was on a list on 2+ days, or ours. */
export const coinOld = (c: Coin, nowMs: number) => c.from === "ours" || (c.createdMs !== null ? nowMs - c.createdMs >= COIN_MIN_AGE_D * 86_400_000 : c.days.length >= 2);
/** Coins the read wallets traded on 3+ different days (free: from swaps already read). */
function ourCoins(): string[] {
  const days = new Map<string, Set<number>>();
  for (const w of Object.values(state.wallets))
    for (const s of w.swaps) {
      let d = days.get(s[2]);
      if (!d) days.set(s[2], (d = new Set()));
      d.add(Math.floor(s[0] / 86_400));
    }
  return [...days]
    .filter(([m, d]) => d.size >= 3 && m !== SOL_MINT && !STABLES.has(m))
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 50)
    .map(([m]) => m);
}
async function refreshCoins() {
  if (Date.now() - coinHealth.listsAt < COIN_REFRESH_MS) return;
  coinHealth.listsAt = Date.now();
  const day = new Date().toISOString().slice(0, 10);
  const add = (mint: string, symbol: string, createdMs: number | null, from: Coin["from"]) => {
    const c = (state.coins[mint] ??= { symbol, from, days: [], createdMs });
    if (createdMs !== null) c.createdMs = createdMs;
    if (from === "jupiter") c.from = "jupiter";
    if (!c.days.includes(day)) c.days = [...c.days, day].slice(-7);
  };
  if (cfg?.jup) {
    let ok = 0;
    for (const l of JUP_LISTS) {
      try {
        for (const x of jupCoins(await cfg.jup(`/tokens/v2/${l}?limit=100`))) add(x.mint, x.symbol, x.createdMs, "jupiter");
        ok++;
      } catch (e) {
        coinHealth.lastError = scrub(String((e as Error)?.message ?? e));
      }
    }
    coinHealth.lists = `${ok} of ${JUP_LISTS.length} answered`;
  } else coinHealth.lists = "no list reader";
  for (const m of ourCoins()) add(m, m.slice(0, 4), null, "ours");
  // forget coins off every list for 14 days whose sample is over a week old
  const cut = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  for (const [m, c] of Object.entries(state.coins)) if ((c.days.at(-1) ?? "") < cut && !(c.sampledAt && Date.now() - c.sampledAt < COIN_RESAMPLE_MS)) delete state.coins[m];
}
/** One coin's buyers of MIN_BUYER_SOL+ at SAMPLE_DAYS points (one page each, never its first day): into the pool. */
async function sampleCoin(mint: string): Promise<boolean> {
  const c = state.coins[mint];
  const now = Date.now();
  const seen = new Map<string, number>();
  for (const d of SAMPLE_DAYS) {
    const from = now - d * 86_400_000;
    if (c.createdMs !== null && from < c.createdMs + 86_400_000) continue; // launch-day buyers are snipers
    const pg = await page(mint, { blockTime: { gte: Math.floor(from / 1000) } }, "asc", null);
    if (!pg) return false;
    for (const it of pg.data) {
      const payer = payerOf(it);
      const s = payer ? swapOf(it.meta, payer, it.slot) : null;
      if (!s || s.wallet !== payer || s.mint !== mint || !s.buy || s.sol < MIN_BUYER_SOL) continue;
      seen.set(payer!, (seen.get(payer!) ?? 0) + s.sol);
    }
  }
  c.sampledAt = now;
  c.buyers = seen.size;
  const key = mint.slice(0, 6);
  for (const [w, sol] of seen) {
    const p = state.pool[w] ?? ["", 0];
    const keys = p[0] ? p[0].split(",") : [];
    if (!keys.includes(key)) keys.push(key);
    state.pool[w] = [keys.slice(-20).join(","), Math.round((p[1] + sol) * 1000) / 1000];
  }
  return true;
}
/** The pool's best buyers (more of these coins first, then more SOL) become candidates, up to MAX_COIN_BUYERS. */
function promote() {
  const have = new Set(state.candidates.map((c) => c.address));
  for (const w of Object.keys(state.pool)) if (have.has(w)) delete state.pool[w];
  let n = state.candidates.filter((c) => srcOf(c) === "coin").length;
  const ranked = Object.entries(state.pool)
    .filter(([w]) => !have.has(w))
    .map(([w, [k, sol]]) => ({ w, coins: k.split(",").length, sol }))
    .sort((a, b) => b.coins - a.coins || b.sol - a.sol);
  for (const x of ranked) {
    if (n >= MAX_COIN_BUYERS) break;
    state.candidates.push({ name: `coin buyer ${x.w.slice(0, 4)}`, address: x.w, source: "coin" });
    delete state.pool[x.w];
    n++;
  }
  // the pool keeps its best MAX_POOL for later
  const rest = Object.keys(state.pool);
  if (rest.length > MAX_POOL) {
    const keep = new Set(ranked.filter((x) => state.pool[x.w]).slice(0, MAX_POOL).map((x) => x.w));
    for (const w of rest) if (!keep.has(w)) delete state.pool[w];
  }
}
/** The coin lists every 6 h, then due coins sampled (MAX_COINS a week), then buyers promoted. false = credit cap. */
async function coinStep(): Promise<boolean> {
  await refreshCoins();
  const now = Date.now();
  const recent = Object.values(state.coins).filter((c) => c.sampledAt && now - c.sampledAt < COIN_RESAMPLE_MS).length;
  const due = Object.entries(state.coins)
    .filter(([, c]) => coinOld(c, now) && !(c.sampledAt && now - c.sampledAt < COIN_RESAMPLE_MS))
    .sort((a, b) => (a[1].from === b[1].from ? b[1].days.length - a[1].days.length : a[1].from === "jupiter" ? -1 : 1))
    .slice(0, Math.max(0, MAX_COINS - recent));
  let ok = true;
  for (const [m, c] of due) {
    if (stopped) break;
    health.working = `coin ${c.symbol}`;
    if (!(await sampleCoin(m))) {
      ok = false;
      break;
    }
    saveScreen();
  }
  promote();
  return ok;
}

async function readWallet(c: { name: string; address: string }) {
  const now = Math.floor(Date.now() / 1000);
  const prev = state.wallets[c.address];
  const cut = now - DAYS_BACK * 86_400;
  // a program or a flipper kept nothing: read its whole window again
  const whole = !prev || !!prev.bot || !!prev.fast;
  const since = whole ? cut : Math.max(prev.newest, cut);
  const items: Item[] = [];
  const own = (list: Item[]) => {
    const out: SSwap[] = [];
    for (const it of list) {
      if (!it.blockTime || payerOf(it) !== c.address) continue;
      const s = sswapOf(it.meta, c.address, it.slot, it.blockTime);
      if (s) out.push(s);
    }
    return out;
  };
  let token: string | null = null;
  let more = false;
  let early: "bot" | WState["fast"] | null = null;
  for (let p = 0; p < WALLET_PAGES; p++) {
    const pg = await page(c.address, { blockTime: { gt: since }, tokenAccounts: "balanceChanged" }, "desc", token);
    if (!pg) return false;
    items.push(...pg.data);
    token = pg.paginationToken;
    more = !!token;
    if (!token || !pg.data.length) break;
    if (!whole) continue;
    // cheaper: a full first page inside BOT_PAGE_H hours is a program; a flipper shows in its newest pages
    if (p === 0) {
      const ts = pg.data.map((x) => x.blockTime ?? 0).filter(Boolean);
      if (ts.length && (Math.max(...ts) - Math.min(...ts)) / 3600 < BOT_PAGE_H) {
        early = "bot";
        break;
      }
    }
    if (p === FAST_PAGES - 1) {
      const { trips } = tripsOf(own(items));
      const hold = median(trips.map(holdMin));
      if (trips.length >= FAST_TRIPS && hold !== null && hold < FAST_HOLD_MIN) {
        const sol = trips.reduce((a, t) => a + pnl(t), 0);
        early = { trips: trips.length, holdMin: r(hold, 0)!, sol: r(sol, 2)!, wonPct: Math.round((trips.filter((t) => pnl(t) > 0).length / trips.length) * 100) };
        break;
      }
    }
  }
  const times = items.map((x) => x.blockTime ?? 0).filter(Boolean);
  const spanDays = Math.max(1 / 24, (now - (more && times.length ? Math.min(...times) : since)) / 86_400);
  const fresh = own(items);
  const swaps = [...(whole ? [] : prev.swaps.map(unpack)), ...fresh].filter((s) => s.t > cut).sort((a, b) => a.slot - b.slot).slice(-KEEP_SWAPS);
  const firstPass = whole || spanDays >= 1;
  const txPerDay = firstPass ? items.length / spanDays : prev.txPerDay;
  const buysPerDay = firstPass ? fresh.filter((s) => s.buy).length / spanDays : prev.buysPerDay;
  const bot = early === "bot" || txPerDay > 400 || buysPerDay > 60;
  const fast = !bot && early && early !== "bot" ? early : undefined;
  state.wallets[c.address] = {
    name: c.name,
    doneAt: Date.now(),
    newest: times.length ? Math.max(...times) : (prev?.newest ?? since),
    txPerDay,
    buysPerDay,
    spanDays: firstPass ? Math.min(DAYS_BACK, spanDays) : prev.spanDays,
    ...(bot ? { bot } : {}),
    ...(fast ? { fast } : {}),
    swaps: bot || fast ? [] : swaps.map(pack),
    late: prev?.late ?? {},
  };
  return true;
}

/** Step 2 for one wallet that passed the screen: its newest trips not yet checked. */
async function checkLate(address: string) {
  const w = state.wallets[address];
  const { trips } = tripsOf(w.swaps.map(unpack));
  for (const t of trips.slice(-DELAY_TRIPS)) {
    const k = `${t.mint}|${t.slot0}`;
    if (w.late[k] || stopped) continue;
    const at = async (slot: number, side: "entry" | "exit") => {
      const pg = await page(t.mint, { slot: { gte: slot } }, "asc", null);
      if (!pg) throw new Error("cap");
      const swaps = pg.data.map((it) => swapOf(it.meta, payerOf(it), it.slot)).filter((s): s is NonNullable<typeof s> => !!s && s.mint === t.mint && s.wallet !== address);
      return priceAfter(swaps, side);
    };
    try {
      w.late[k] = {
        e30: await at(t.slot0 + Math.round(30 * SLOTS_PER_SEC), "entry"),
        e300: t.t1 - t.t0 > 300 ? await at(t.slot0 + Math.round(300 * SLOTS_PER_SEC), "entry") : null,
        x30: await at(t.slot1 + Math.round(EXIT_SEC * SLOTS_PER_SEC), "exit"),
      };
    } catch (e) {
      if ((e as Error).message === "cap") return false;
      throw e;
    }
  }
  return true;
}

export function reportOf(address: string) {
  const w = state.wallets[address];
  if (!w) return null;
  const o = { txPerDay: w.txPerDay, buysPerDay: w.buysPerDay, spanDays: w.spanDays };
  if (w.fast) {
    // a flipper read only as far as its newest pages: its own numbers from those, never a pass
    const s = screen([], { ...o, open: 0 });
    const f = w.fast;
    return { name: w.name, address, ...s, trips: f.trips, realisedSol: f.sol, wonPct: f.wonPct, holdMinMedian: f.holdMin, bot: s.bot || f.holdMin < 2, fast: true, pass: false, why: [`holds ${f.holdMin} min`] };
  }
  const { trips, open } = tripsOf(w.swaps.map(unpack));
  for (const t of trips) Object.assign(t, w.late[`${t.mint}|${t.slot0}`] ?? {});
  return { name: w.name, address, ...screen(trips, { ...o, open }), fast: false };
}
type Report = NonNullable<ReturnType<typeof reportOf>> & { source: Source };
let cache: Report[] | null = null;
/** Every candidate read so far; worked out again only after a wallet was read or checked. */
const reports = (): Report[] =>
  (cache ??= state.candidates.flatMap((c) => {
    const x = reportOf(c.address);
    return x ? [{ ...x, source: srcOf(c) }] : [];
  }));
/** Wallets followed on paper: those that pass, best 5 min late result first (unchecked last). */
export function followed(): { name: string; address: string }[] {
  return reports()
    .filter((x) => x.pass)
    .sort((a, b) => (b.late.in5min.avgPct ?? -1e9) - (a.late.in5min.avgPct ?? -1e9) || (b.realisedSol ?? 0) - (a.realisedSol ?? 0))
    .slice(0, FOLLOW_MAX)
    .map((x) => ({ name: x.name, address: x.address }));
}
let followSet = new Set<string>();
const refreshFollow = () => (followSet = new Set(followed().map((x) => x.address)));
/** Addresses the copy runner's stream should carry for this study: followed wallets and any with a paper copy open. */
export const slowWatch = (): string[] => [...new Set([...followSet, ...state.open.map((p) => p.wallet)])];

async function loop() {
  while (!stopped) {
    refreshCandidates();
    let did = false;
    try {
      if (!(await coinStep())) health.state = cfg?.rpcUrl() ? "resting until tomorrow (daily credit cap)" : "waiting for the Helius key";
      else if (health.state.startsWith("resting") || health.state === "starting") health.state = "reading";
      cache = null;
    } catch (e) {
      health.errors++;
      coinHealth.lastError = scrub(String((e as Error)?.message ?? e));
    }
    for (const c of state.candidates) {
      if (stopped) return;
      const st = state.wallets[c.address];
      if (st && Date.now() - st.doneAt < (st.bot ? BOT_REFRESH_MS : REFRESH_MS)) continue;
      health.working = c.name;
      try {
        const read = await readWallet(c);
        cache = null;
        if (!read) {
          health.state = cfg?.rpcUrl() ? "resting until tomorrow (daily credit cap)" : "waiting for the Helius key";
          break;
        }
        if (reportOf(c.address)?.pass) {
          const all = await checkLate(c.address);
          cache = null;
          if (!all) {
            health.state = "resting until tomorrow (daily credit cap)";
            break;
          }
        }
        health.state = "reading";
        did = true;
        refreshFollow();
        saveScreen();
      } catch (e) {
        health.errors++;
        health.lastError = scrub(String((e as Error).message));
        if (refused(health.lastError)) {
          health.state = "refused by the plan";
          return;
        }
        await sleep(10_000);
      }
    }
    health.working = "";
    saveScreen(true);
    if (!did && health.state === "reading") health.state = "up to date";
    closeOld();
    await sleep(did ? 5000 : 10 * 60_000);
  }
}

// ---- paper copy: live ----------------------------------------------------------------------------------------------
function finish(p: Pos, why: NonNullable<Pos["closed"]>) {
  p.closed = why;
  p.closedMs = Date.now();
  state.open = state.open.filter((x) => x !== p);
  state.recent = [...state.recent, p].slice(-2000);
  try {
    mkdirSync(join(DATA, "solana"), { recursive: true });
    appendFileSync(ROWS(), JSON.stringify(p) + "\n");
  } catch {
    /* the state file has it */
  }
  save();
}
async function buyAt(p: Pos, d: number) {
  if (stopped || p.closed) return;
  const k = entryKey(d);
  if (p.entries[k] !== undefined) return;
  if (p.soldMs) {
    p.entries[k] = "cancel"; // it sold before this entry: no copy
    return;
  }
  const out = await cfg!.quote(SOL_MINT, p.mint, String(Math.round(STAKE_SOL * LAMPORTS))).catch(() => undefined);
  if (p.entries[k] === "cancel") return; // it sold while we asked
  if (out === undefined) health.quoteMisses++;
  p.entries[k] = out ? out.toString() : null;
  health.entries++;
  save();
}
async function sellAt(p: Pos, x: number) {
  const jobs = ENTRY_DELAYS.map(async (d) => {
    const tok = p.entries[entryKey(d)];
    if (tok == null || tok === "cancel" || tok === "missed") return;
    const back = await cfg!.quote(p.mint, SOL_MINT, tok).catch(() => undefined);
    if (back === undefined) {
      health.quoteMisses++; // not an answer: this copy is left out rather than counted as a loss
      return;
    }
    p.exits[exitKey(d, x)] = back === null ? null : Number(back) / LAMPORTS;
    health.exits++;
  });
  await Promise.all(jobs);
}
/** The wallet's first sale of a coin we copy: every entry made so far is sold EXIT_DELAYS seconds later. */
function onSell(p: Pos, why: NonNullable<Pos["closed"]> = "sold") {
  if (p.soldMs) return;
  p.soldMs = Date.now();
  for (const d of ENTRY_DELAYS) if (p.entries[entryKey(d)] === undefined) p.entries[entryKey(d)] = "cancel";
  const last = Math.max(...EXIT_DELAYS);
  for (const x of EXIT_DELAYS) later(x * 1000, () => void sellAt(p, x).catch(() => undefined).finally(() => x === last && finish(p, why)));
}
function schedule(p: Pos) {
  for (const d of ENTRY_DELAYS) {
    const k = entryKey(d);
    if (p.entries[k] !== undefined) continue;
    const due = p.seenMs + d * 1000;
    // a restart longer than a minute past an entry's time: that entry was not made on time
    if (Date.now() - due > 60_000) p.entries[k] = "missed";
    else later(due - Date.now(), () => void buyAt(p, d).catch(() => undefined));
  }
}
/** Called by the copy runner for every stream transaction. Cheap unless its payer is a wallet of this study. */
export function slowTx(tx: { slot: number; meta: Meta | null; transaction: { message: { accountKeys: (string | { pubkey: string })[] } } }, nowMs = Date.now()) {
  if (stopped || !cfg) return;
  const payer = payerOf(tx);
  if (!payer) return;
  const mine = state.open.filter((p) => p.wallet === payer);
  if (!followSet.has(payer) && !mine.length) return;
  const s = sswapOf(tx.meta, payer, tx.slot, Math.floor(nowMs / 1000));
  if (!s) return;
  const p = mine.find((x) => x.mint === s.mint);
  if (!s.buy) {
    health.sellsSeen++;
    if (p) onSell(p);
    return;
  }
  if (p || !followSet.has(payer) || s.sol < 0.1) return; // adding to a coin we already copy, or a dust buy
  health.buysSeen++;
  const pos: Pos = { wallet: payer, name: state.wallets[payer]?.name ?? payer.slice(0, 4), mint: s.mint, seenMs: nowMs, leaderSol: r(s.sol, 3)!, entries: {}, exits: {} };
  state.open.push(pos);
  schedule(pos);
  save();
}
/** Positions never sold are closed at MAX_HOLD_H. */
function closeOld() {
  for (const p of [...state.open]) if (!p.soldMs && Date.now() - p.seenMs > MAX_HOLD_H * 3_600_000) onSell(p, "max hold");
}
/** After a restart: a copy whose wallet sold while we were down is sold now, marked as such. */
async function catchUp() {
  for (const p of [...state.open]) {
    if (stopped) return;
    if (p.soldMs) {
      // the restart cut its sale short: sell now
      p.soldMs = undefined;
      onSell(p, "sold while we were down");
      continue;
    }
    schedule(p);
    try {
      let token: string | null = null;
      for (let i = 0; i < 3; i++) {
        const pg = await page(p.wallet, { blockTime: { gt: Math.floor(p.seenMs / 1000) }, tokenAccounts: "balanceChanged" }, "asc", token);
        if (!pg) return;
        const sold = pg.data.some((it) => {
          const sw = payerOf(it) === p.wallet ? sswapOf(it.meta, p.wallet, it.slot, it.blockTime ?? 0) : null;
          return !!sw && sw.mint === p.mint && !sw.buy;
        });
        if (sold) {
          onSell(p, "sold while we were down");
          break;
        }
        token = pg.paginationToken;
        if (!token || !pg.data.length) break;
      }
    } catch (e) {
      health.errors++;
      health.lastError = scrub(String((e as Error).message));
    }
  }
}

export function startSlow(c: NonNullable<typeof cfg>) {
  if (process.env.SOLANA_SLOW === "off" || !stopped) return;
  stopped = false;
  cfg = c;
  for (const f of [FILE(), PAPER()]) {
    try {
      state = { ...state, ...(JSON.parse(readFileSync(f, "utf8")) as Partial<State>) };
    } catch {
      /* first run */
    }
  }
  health.state = "starting";
  refreshFollow();
  // copies never sold are closed at MAX_HOLD_H even while the screen is busy reading
  const t = setInterval(() => (stopped ? clearInterval(t) : closeOld()), 5 * 60_000);
  t.unref();
  void catchUp().finally(() => void loop());
}
export function stopSlow() {
  if (stopped) return;
  stopped = true;
  for (const t of timers) clearTimeout(t);
  timers.clear();
  save();
  saveScreen(true);
}

export function slowSummary() {
  const reps = reports();
  const people = reps.filter((x) => !x.bot && !x.fast);
  const slim = (x: (typeof reps)[number]) => ({ name: x.name, address: x.address, source: x.source, trips: x.trips, tripsPerDay: x.tripsPerDay, realisedSol: x.realisedSol, wonPct: x.wonPct, holdMinMedian: x.holdMinMedian, holdOverHourPct: x.holdOverHourPct, buySolMedian: x.buySolMedian, smallStartPct: x.smallStartPct, topTradeSharePct: x.topTradeSharePct, olderSol: x.olderSol, newerSol: x.newerSol, late: x.late, why: x.why });
  const pass = people.filter((x) => x.pass);
  const done = state.recent.filter((p) => p.closed);
  const fol = followed();
  return {
    note: `Paper and read-only. CANDIDATES: the listed wallets, the busiest pump.fun buyers, and (day holders) wallets that bought ${MIN_BUYER_SOL}+ SOL of coins that keep trading for days (Jupiter's lists, ${COIN_MIN_AGE_D}+ days old, no stables or staked SOL; coins our wallets traded on 3+ days), sampled at ${SAMPLE_DAYS.join(" / ")} days back. A full first page inside ${BOT_PAGE_H} h = bot; ${FAST_TRIPS}+ trips in its newest ${FAST_PAGES * 100} transactions with a median hold under ${FAST_HOLD_MIN} min = fast (flipper); neither is read further. SCREEN: each candidate's own SOL swaps over the last ${DAYS_BACK} days as round trips (first buy until ${CLOSE_SHARE * 100}% sold). Passes = not a bot, ${MIN_TRIPS}+ trips, first sell a median ${MIN_HOLD_MIN}+ min after its first buy, realised SOL positive in BOTH halves of the period, ${MIN_WIN * 100}%+ won, no single trade half or more of the profit. Realised SOL is before network fees. LATE: for its newest ${DELAY_TRIPS} trips, a copier entering 30 s / 5 min after its first buy and selling ${EXIT_SEC} s after its first sale, priced from other people's trades, ${DELAY_COST * 100}% cost taken off: an estimate. smallStartPct = trips whose first buy was under half the wallet's usual. PAPER: followed wallets copied live with ${STAKE_SOL} SOL at Jupiter quotes, ${ENTRY_DELAYS.map(when).join(" / ")} after we see the buy, sold ${EXIT_DELAYS.join(" / ")} s after its first sale (or at ${MAX_HOLD_H} h). Leads to test, not proof.`,
    state: health.state,
    working: health.working,
    candidates: state.candidates.length,
    read: reps.length,
    bots: reps.filter((x) => x.bot).length,
    fast: reps.filter((x) => x.fast && !x.bot).length,
    passing: pass.length,
    bySource: Object.fromEntries(
      (["list", "busy", "coin"] as const).map((s) => {
        const rs = reps.filter((x) => x.source === s);
        return [s, { candidates: state.candidates.filter((c) => srcOf(c) === s).length, read: rs.length, bots: rs.filter((x) => x.bot).length, fast: rs.filter((x) => x.fast && !x.bot).length, passing: rs.filter((x) => x.pass).length }];
      }),
    ),
    coins: {
      lists: coinHealth.lists,
      kept: Object.keys(state.coins).length,
      oldEnough: Object.values(state.coins).filter((c) => coinOld(c, Date.now())).length,
      sampledThisWeek: Object.values(state.coins).filter((c) => c.sampledAt && Date.now() - c.sampledAt < COIN_RESAMPLE_MS).length,
      buyersInPool: Object.keys(state.pool).length,
      lastError: coinHealth.lastError,
    },
    /** people (not bots, not flippers) with 10+ trips whose median hold is MIN_HOLD_MIN+ min, most realised SOL first */
    holders: people.filter((x) => x.trips >= 10 && (x.holdMinMedian ?? 0) >= MIN_HOLD_MIN).sort((a, b) => (b.realisedSol ?? 0) - (a.realisedSol ?? 0)).slice(0, 15).map(slim),
    tripsPerDayPassing: r(pass.reduce((a, x) => a + (x.tripsPerDay ?? 0), 0)),
    pass: pass.map(slim),
    /** people with 10+ trips, most realised SOL first: a ranking, not a pick */
    near: people.filter((x) => !x.pass && x.trips >= 10).sort((a, b) => (b.realisedSol ?? 0) - (a.realisedSol ?? 0)).slice(0, 15).map(slim),
    followed: fol.map((x) => x.name),
    paper: {
      open: state.open.length,
      closed: done.length,
      buysSeen: health.buysSeen,
      sellsSeen: health.sellsSeen,
      rules: paperRules(done),
      byWallet: [...new Set(done.map((p) => p.wallet))].map((w) => {
        const ps = done.filter((p) => p.wallet === w);
        const v = ps.map((p) => posRet(p, 300, 30)).filter((y): y is number => y !== undefined);
        return { name: ps[0].name, copies: ps.length, in5min: { n: v.length, won: v.filter((y) => y > 0).length, avgRetPct: v.length ? r((avg(v) ?? 0) * 100) : null } };
      }),
      holdMinMedian: r(median(done.filter((p) => p.soldMs).map((p) => (p.soldMs! - p.seenMs) / 60_000)), 0),
    },
    calls: health.calls,
    errors: health.errors,
    creditsToday: state.credits,
    creditsCapPerDay: CREDITS_DAY,
    quoteMisses: health.quoteMisses,
    lastError: health.lastError,
  };
}

/** Test hooks. */
export const _test = {
  setCfg: (c: typeof cfg) => ((stopped = !c), (cfg = c)),
  state: () => state,
  reset: () => {
    state = empty();
    cache = null;
    coinHealth.listsAt = 0;
    coinHealth.lists = "not asked";
    coinHealth.lastError = "";
    followSet = new Set();
    for (const t of timers) clearTimeout(t);
    timers.clear();
  },
  follow: (a: string[]) => (followSet = new Set(a)),
  readWallet,
  checkLate,
  coinStep,
  catchUp,
  onSell,
};
