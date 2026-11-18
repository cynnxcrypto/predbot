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
import { isStock } from "./buckets.js";

/**
 * enrique, 14 Nov 2026 23:52 KST, with the Helius and Jupiter usage pages (Helius 695k of 10M credits with 10 days
 * left, Jupiter 1.5M of 25M): "yeah go scan way way more then". So: a month of each wallet instead of two weeks,
 * twelve of Jupiter's lists and its verified coins instead of three lists, ten sample points of three pages a coin
 * instead of four of one, 1,500 coins a week instead of 150, 30,000 coin buyers instead of 1,500, 150 wallets on
 * paper instead of 25, and a daily budget of 500,000 credits until the plan resets (24 Nov), 150,000 after.
 * The rest of the bot uses about 140,000 credits a day (4.2M a month), and the REAL copy sells through the same
 * key, so the budget leaves 1.5M+ a month unused on purpose. The pass bar itself is unchanged.
 * To keep the state file small at that size, a wallet that is neither passing nor near (see `kept`) keeps no swaps
 * and is read again whole only every two weeks, like a flipper.
 */
export const DAYS_BACK = 30;
const WALLET_PAGES = 30; // x100 transactions, newest first
const BOOST_UNTIL = Date.UTC(2026, 10, 24);
export const creditsDay = (nowMs = Date.now()) => Math.max(1000, Number(process.env.SOLANA_SLOW_CREDITS_DAY) || (nowMs < BOOST_UNTIL ? 500_000 : 150_000));
const REFRESH_MS = 24 * 3_600_000;
export const MAX_CANDIDATES = 400;
const KEEP_SWAPS = 5000;
const BOT_REFRESH_MS = 30 * 86_400_000;
/** flippers and wallets far from the bar: read again whole this often */
const OUT_REFRESH_MS = 14 * 86_400_000;
/** one pass of the loop: this many coins sampled, their best buyers promoted, this many wallets read; then again */
const COINS_PER_PASS = 25;
const PROMOTE_PER_PASS = 400;
const WALLETS_PER_PASS = 300;
// the screen
// enrique, 17 Nov 2026 23:10 KST: "they're playing with nothing", "balances that are not trivial". The screen judged
// % and counts only: the median passing wallet had made about $640 in the month with a usual buy of $36. A wallet
// now needs MIN_REALISED_SOL made over the window and a usual first buy of MIN_USUAL_SOL (also on the cap shortlist).
export const MIN_REALISED_SOL = 20;
/** the two floors in force; SOLANA_SLOW_MIN_SOL / SOLANA_SLOW_MIN_BUY_SOL override them (the tests use small wallets) */
export const minRealisedSol = () => (process.env.SOLANA_SLOW_MIN_SOL === undefined ? MIN_REALISED_SOL : Number(process.env.SOLANA_SLOW_MIN_SOL));
export const minUsualSol = () => (process.env.SOLANA_SLOW_MIN_BUY_SOL === undefined ? MIN_USUAL_SOL : Number(process.env.SOLANA_SLOW_MIN_BUY_SOL));
export const MIN_USUAL_SOL = 1;
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
/** a late price this many times off the wallet's own price on that side is a misread trade, not a move: left unpriced */
export const LATE_OFF = 5;
/** a wallet with this many late copies checked is not copyable when fewer than 1 in NO_COPY_ONE_IN of them won */
export const NO_COPY_MIN = 15;
export const NO_COPY_ONE_IN = 5;
/** proven on paper: of a followed wallet's newest PROVEN_LAST closed copies entered 5 s late, PROVEN_MIN+ priced, half or more won, ahead */
export const PROVEN_MIN = 20;
export const PROVEN_LAST = 40;
// the paper copy
export const FOLLOW_MAX = 150;
export const STAKE_SOL = 0.25;
export const TX_SOL = 0.001;
// 1 s added 16 Nov 2026 (enrique: "any way we can buy quicker after they do?", "we can definitely do faster"): we see
// a followed wallet's swap about 0.7 s after it lands (Helius websocket, solanaCopy.speed), and the real copy then
// waits 5 s on purpose. e1 / x1 price what buying / selling 1 s after we see it would have done, on the same copies.
export const ENTRY_DELAYS = [1, 5, 30, 300, 1800] as const;
export const EXIT_DELAYS = [1, 5, 30] as const;
export const MAX_HOLD_H = 72;
/** closed paper copies kept for the status (every one is also a line in slow-copies.jsonl) */
const KEEP_COPIES = 6000;
/** after a restart: pages of a wallet's transactions read to see what it sold while we were down */
const CATCH_PAGES = 8;
// cheaper reads
export const BOT_PAGE_H = 3; // 100 transactions in under 3 hours: 800+ a day
export const FAST_PAGES = 2;
export const FAST_TRIPS = 10;
export const FAST_HOLD_MIN = 10;
// day-holder candidates
export const COIN_MIN_AGE_D = 3;
export const SAMPLE_DAYS = [0.25, 1, 2, 3, 4, 5, 6, 8, 10, 13] as const;
/** pages of 100 transactions read at each sample point */
export const SAMPLE_PAGES = 3;
/** a mid or high cap is sampled wider and deeper (few such coins, and their buyers are the wallets wanted): about 1,000 credits a coin */
export const CAP_SAMPLE_DAYS = [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 13, 17, 21, 25, 29] as const;
export const CAP_SAMPLE_PAGES = 6;
/** a coin without a known first day: a sample whose first transaction comes this long after the point is its launch, or a dead stretch */
const SAMPLE_GAP_S = 3 * 3600;
export const MIN_BUYER_SOL = 0.2;
export const MAX_COINS = 1500; // sampled a week
export const MAX_COIN_BUYERS = 30_000;
const COIN_REFRESH_MS = 6 * 3_600_000;
const COIN_RESAMPLE_MS = 7 * 86_400_000;
const MAX_POOL = 40_000;
export const JUP_LISTS: readonly string[] = ["toptraded", "toporganicscore", "toptrending"].flatMap((c) => ["24h", "6h", "1h", "5m"].map((i) => `${c}/${i}`));
/** Jupiter's verified coins: thousands, most of them quiet, so only those that traded this much in a day ($, both sides) */
export const VERIFIED_MIN_VOL_USD = 50_000;
/**
 * MID AND HIGH CAPS (enrique, 17 Nov 2026 19:06 KST: "dont focus on memecoins then" / "focus on mid to high caps";
 * 19:08 KST "50m mcap sounds fine"; "why do we need them to do new trades, dont they have a history?"). A coin counts
 * when Jupiter gives it a market value of CAP_MIN_USD+, CAP_MIN_LIQ_USD+ of liquidity and a first pool CAP_MIN_AGE_D+
 * days old (no stables, staked SOL, pool shares or tokenised shares). A coin Jupiter has not described is not one.
 * REPLAY: for a wallet with CAP_MIN_TRIPS+ round trips in such coins over the month, its newest CAP_REPLAY_TRIPS are
 * replayed as our real copy makes them: in CAP_DELAY_SEC s after its first buy, out CAP_DELAY_SEC s after its first
 * sale, each priced from other people's trades of the coin, CAP_COST off for swap fees, price impact and network fees.
 */
// 18 Nov 2026 21:00 KST, enrique's tap "$20M cap, $200k liquidity" (was $50M / $500k: 83 coins over $50M on our
// lists, but only 24 counted, 23 of them left out as thin, and only 121 wallets traded them at all)
export const CAP_MIN_USD = 20_000_000;
export const CAP_MIN_LIQ_USD = 200_000;
export const CAP_MIN_AGE_D = 30;
export const CAP_MIN_TRIPS = 8;
export const CAP_REPLAY_TRIPS = 30;
export const CAP_DELAY_SEC = 5;
export const CAP_COST = 0.015;
/** the shortlist: CAP_LIST_MIN+ replayed trips priced, half or more won, ahead, ahead in both halves, no one trip half the gain */
export const CAP_LIST_MIN = 10;
export const CAP_LIST_MAX = 25;
const CAP_TTL_MS = 3 * 86_400_000;
const CAP_RESAMPLE_MS = 86_400_000;
/** Jupiter searches (100 coins each) a pass for coins our wallets traded that no list described */
const CAP_LOOKUPS = 5;
const CAP_WALLETS_PER_PASS = 20;
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
  /** filled by the cap replay: prices CAP_DELAY_SEC s after the first buy and after the first sell */
  e5?: number | null;
  x5?: number | null;
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
  // seconds after the wallet's own trade the price is near its price: far off is a misread trade (one such gave +1,462,743,570%)
  const off = (a: number, b: number) => !(a > 0 && b > 0) || a / b > LATE_OFF || b / a > LATE_OFF;
  if (off(t.x30, t.p1) || off(e, t.p0)) return null;
  return t.x30 / e - 1 - DELAY_COST;
}
/** Our copy of one past trip in a mid or high cap: in and out CAP_DELAY_SEC s after the wallet, CAP_COST off. null = not priced. */
export function capRet(t: Trip): number | null {
  if (!t.e5 || !t.x5) return null;
  if (t.t1 - t.t0 <= CAP_DELAY_SEC) return null; // it sold before our entry: no copy
  const off = (a: number, b: number) => !(a > 0 && b > 0) || a / b > LATE_OFF || b / a > LATE_OFF;
  if (off(t.x5, t.p1) || off(t.e5, t.p0)) return null;
  return t.x5 / t.e5 - 1 - CAP_COST;
}
/** A wallet's mid and high cap trips and their replay; pass = on the shortlist (see CAP_LIST_MIN). */
export function capOf(trips: Trip[], ok: (mint: string) => boolean) {
  const ts = trips.filter((t) => ok(t.mint));
  const recent = ts.slice(-CAP_REPLAY_TRIPS);
  const v = recent.map(capRet).filter((x): x is number => x !== null);
  const won = v.filter((x) => x > 0).length;
  const sum = v.reduce((a, x) => a + x, 0);
  const half = Math.floor(v.length / 2);
  const older = v.slice(0, half).reduce((a, x) => a + x, 0);
  const newer = v.slice(half).reduce((a, x) => a + x, 0);
  const best = v.reduce((a, x) => Math.max(a, x), 0);
  const topShare = sum > 0 ? best / sum : null;
  const priced = recent.filter((t) => capRet(t) !== null);
  const own = priced.map(ownRet).filter(Number.isFinite);
  return {
    trips: ts.length,
    toReplay: recent.filter((t) => t.x5 === undefined).length,
    priced: v.length,
    won,
    avgPct: v.length ? r((sum / v.length) * 100) : null,
    sumPct: r(sum * 100),
    olderPct: r(older * 100),
    newerPct: r(newer * 100),
    topSharePct: topShare === null ? null : Math.round(topShare * 100),
    ownAvgPct: r((avg(own) ?? NaN) * 100),
    holdMinMedian: r(median(ts.map(holdMin)), 0),
    usualSol: r(median(ts.map((t) => t.firstSol))),
    pass: v.length >= CAP_LIST_MIN && won * 2 >= v.length && sum > 0 && older > 0 && newer > 0 && topShare !== null && topShare < MAX_TOP_SHARE && (median(ts.map((t) => t.firstSol)) ?? 0) >= minUsualSol(),
  };
}
/**
 * Can a copier win with this wallet? Its late copies say: with NO_COPY_MIN+ checked (5 min late, else 30 s late) and
 * fewer than 1 in NO_COPY_ONE_IN won, no, however good its own record is. null = too few checked to say.
 */
export function copyableOf(late: { in30s: { n: number; won: number }; in5min: { n: number; won: number } }): boolean | null {
  const l = late.in5min.n >= NO_COPY_MIN ? late.in5min : late.in30s;
  return l.n >= NO_COPY_MIN ? l.won * NO_COPY_ONE_IN >= l.n : null;
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
  if (total < minRealisedSol() && total > 0) why.push(`made ${r(total)} SOL`);
  if (usual !== null && usual < minUsualSol()) why.push(`usual buy ${r(usual)} SOL`);
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
  const lates = { in30s: late(30), in5min: late(300) };
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
    /** false = passes on its own record, but copies of it lose: not followed */
    copyable: copyableOf(lates),
    late: {
      checked: checked.length,
      ownAvgPct: r((avg(own) ?? NaN) * 100),
      ...lates,
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
/** SOL made by the five best copies of a list of returns: when it is most of the net, the result is a few big winners, not a rule. */
export const top5Sol = (v: number[]) => r([...v].sort((a, b) => b - a).slice(0, 5).reduce((a, y) => a + Math.max(0, y), 0) * STAKE_SOL, 3);
export function paperRules(ps: Pos[]) {
  const done = ps.filter((p) => p.closed);
  return ENTRY_DELAYS.flatMap((d) =>
    EXIT_DELAYS.map((x) => {
      const v = done.map((p) => posRet(p, d, x)).filter((y): y is number => y !== undefined);
      const net = v.reduce((a, b) => a + b, 0) * STAKE_SOL;
      return { id: `slow-e${d}-x${x}`, text: `Buys ${STAKE_SOL} SOL ${when(d)} after a followed wallet buys a coin; sells ${x} s after its first sale of it.`, n: v.length, won: v.filter((y) => y > 0).length, netSol: r(net, 3), avgRetPct: v.length ? r((net / STAKE_SOL / v.length) * 100) : null, medianRetPct: r((median(v) ?? NaN) * 100), top5Sol: top5Sol(v) };
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
  /** bought a mid or high cap in the coin samples: read before the other new candidates */
  cap?: true;
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
  /** traded in a day, $, both sides, when the list says so: busier coins are sampled first */
  vol?: number;
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
  /**
   * read in full and far from the bar (see `kept`): its numbers only, no swaps; read again whole every two weeks.
   * copyable (from 16 Nov 2026) = what its late copies said when it was filed; the swaps that said so are gone.
   */
  out?: { trips: number; tripsPerDay: number | null; sol: number | null; wonPct: number | null; holdMin: number | null; why: string[]; copyable?: boolean | null };
  /** read whole at its next turn: read under a shorter window, or filed as a program on one day's pace */
  redo?: boolean;
  swaps: Packed[];
  /** delay-check prices by `${mint}|${slot0}` */
  late: Record<string, { e30?: number | null; e300?: number | null; x30?: number | null; e5?: number | null; x5?: number | null }>;
}
/** A coin's size by Jupiter: market value and liquidity ($), first pool, when asked. Only coins near the floor are kept. */
interface CapRow {
  mcap: number;
  liq: number;
  createdMs: number | null;
  stock?: boolean;
  at: number;
}
interface State {
  day: string;
  credits: number;
  /** DAYS_BACK the wallets were read under */
  window?: number;
  /** the programs filed on one day's pace have been marked for a whole read (once): how many */
  paceFix?: number;
  candidates: Cand[];
  wallets: Record<string, WState>;
  coins: Record<string, Coin>;
  /** buyers seen in the coin samples, not yet candidates: [coin keys joined by commas, SOL bought] */
  pool: Record<string, [string, number]>;
  /** coin sizes by mint (mid and high caps, see CAP_MIN_USD) */
  caps?: Record<string, CapRow>;
  /** what each followed wallet holds, by address (see balanceStep) */
  bal?: Record<string, Balance>;
  open: Pos[];
  recent: Pos[];
}
/**
 * What a followed wallet holds (enrique, 17 Nov 2026: "balances that are not trivial"): its SOL and the dollar value
 * of its priced coins, read once a day with one Helius call (getAssetsByOwner, 10 credits). Coins Helius has no
 * price for count as nothing, so the value is a floor.
 */
export interface Balance {
  sol: number;
  usd: number | null;
  at: number;
}
export const BAL_REFRESH_MS = 24 * 3_600_000;
const BAL_PER_LOOP = 5;
/** A getAssetsByOwner answer -> SOL held and dollars in SOL and priced coins; null when unreadable. */
export function balanceOf(result: unknown): { sol: number; usd: number | null } | null {
  const x = result as { nativeBalance?: { lamports?: unknown; total_price?: unknown }; items?: unknown } | null;
  const lamports = Number(x?.nativeBalance?.lamports);
  if (!Number.isFinite(lamports) || lamports < 0) return null;
  const native = Number(x?.nativeBalance?.total_price);
  let coins = 0;
  for (const it of Array.isArray(x?.items) ? (x!.items as { token_info?: { price_info?: { total_price?: unknown } } }[]) : []) {
    const v = Number(it?.token_info?.price_info?.total_price);
    if (Number.isFinite(v) && v > 0) coins += v;
  }
  return { sol: Math.round(lamports / 1e7) / 100, usd: Number.isFinite(native) ? Math.round(native + coins) : null };
}
/** Reads the balance of up to BAL_PER_LOOP followed wallets not read for a day. false = out of credits or no key. */
async function balanceStep(now = Date.now()): Promise<boolean> {
  const due = followedAll().filter((w) => now - (state.bal?.[w.address]?.at ?? 0) > BAL_REFRESH_MS).slice(0, BAL_PER_LOOP);
  for (const w of due) {
    const url = cfg?.rpcUrl();
    today();
    if (!url || state.credits >= creditsDay()) return false;
    health.calls++;
    const body = { jsonrpc: "2.0", id: 1, method: "getAssetsByOwner", params: { ownerAddress: w.address, page: 1, limit: 1000, displayOptions: { showFungible: true, showNativeBalance: true } } };
    const res = await cfg!.fetch()(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    state.credits += 10;
    const j = (await res.json().catch(() => ({}))) as { result?: unknown; error?: { message: string } };
    if (j.error || !res.ok) throw new Error(j.error?.message ?? `http ${res.status}`);
    const b = balanceOf(j.result);
    // an unreadable answer is not asked again for a day either: the wallet shows as unknown, not as empty
    (state.bal ??= {})[w.address] = b ? { ...b, at: now } : { sol: state.bal?.[w.address]?.sol ?? -1, usd: state.bal?.[w.address]?.usd ?? null, at: now };
    cache = null;
    saveScreen();
  }
  // wallets no longer followed are forgotten
  const keep = new Set(followedAll().map((w) => w.address));
  for (const a of Object.keys(state.bal ?? {})) if (!keep.has(a)) delete state.bal![a];
  return true;
}

/** The screen (large, saved at most every 5 minutes) and the paper copies (saved at most every 15 s) apart. */
const FILE = () => join(DATA, "solana", "slow-wallets.json");
const PAPER = () => join(DATA, "solana", "slow-paper.json");
const ROWS = () => join(DATA, "solana", "slow-copies.jsonl");
const empty = (): State => ({ day: "", credits: 0, candidates: [], wallets: {}, coins: {}, pool: {}, open: [], recent: [] });
let state: State = empty();
let savedAt = 0;
const health = { state: "off", calls: 0, errors: 0, lastError: "", working: "", entries: 0, exits: 0, quoteMisses: 0, sellsSeen: 0, buysSeen: 0 };
const coinHealth = { lists: "not asked", listsAt: 0, lastError: "", due: 0, sampled: 0 };
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
/** The paper copies: at most every 15 s (150 wallets change it many times a second), at once when `now`. */
const PAPER_EVERY_MS = 15_000;
let paperAt = 0;
let paperWait = false;
function save(now = false) {
  if (!now && Date.now() - paperAt < PAPER_EVERY_MS) {
    if (!paperWait) {
      paperWait = true;
      later(PAPER_EVERY_MS - (Date.now() - paperAt), () => {
        paperWait = false;
        save(true);
      });
    }
    return;
  }
  paperAt = Date.now();
  try {
    write(PAPER(), { open: state.open, recent: state.recent });
  } catch {
    /* next time */
  }
}
/** The screen, at most every 5 minutes unless `now` (it is megabytes, and written in one go). */
function saveScreen(now = false) {
  if (!now && Date.now() - savedAt < 300_000) return;
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
  canSpend: () => (today(), state.credits < creditsDay()),
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
export function jupCoins(rows: unknown): { mint: string; symbol: string; createdMs: number | null; vol: number | null; mcap: number | null; liq: number | null; stock: boolean }[] {
  if (!Array.isArray(rows)) return [];
  const out: { mint: string; symbol: string; createdMs: number | null; vol: number | null; mcap: number | null; liq: number | null; stock: boolean }[] = [];
  for (const x of rows as Record<string, unknown>[]) {
    const mint = typeof x?.id === "string" ? x.id : typeof x?.address === "string" ? x.address : null;
    if (!mint || mint === SOL_MINT || STABLES.has(mint)) continue;
    const symbol = String(x.symbol ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || mint.slice(0, 4);
    const tags = Array.isArray(x.tags) ? x.tags.map(String) : [];
    if (tags.includes("lst") || /USD/i.test(symbol) || (symbol.length > 3 && symbol.toUpperCase().endsWith("SOL"))) continue;
    const created = Date.parse(String((x.firstPool as { createdAt?: unknown } | undefined)?.createdAt ?? ""));
    const st = x.stats24h as { buyVolume?: unknown; sellVolume?: unknown } | undefined;
    const vol = Number(st?.buyVolume) + Number(st?.sellVolume);
    const mcap = Number(x.mcap);
    const liq = Number(x.liquidity);
    const name = String(x.name ?? "");
    // pool and vault shares are a basket with fees of their own, and a stablecoin by name is no mid cap
    const stock = isStock(x) || /^JLP$|LP$/i.test(symbol) || /\blp\b|liquidity|\bpool\b|\bvault\b|stable|dollar/i.test(name) || tags.some((t) => /^lp$|stable/i.test(t));
    out.push({ mint, symbol, createdMs: Number.isFinite(created) ? created : null, vol: Number.isFinite(vol) ? vol : null, mcap: Number.isFinite(mcap) && x.mcap != null ? mcap : null, liq: Number.isFinite(liq) && x.liquidity != null ? liq : null, stock });
  }
  return out;
}
/** Trades for days: its first pool is COIN_MIN_AGE_D+ days old, or (no date given) it was on a list on 2+ days, or ours. */
export const coinOld = (c: Coin, nowMs: number) => c.from === "ours" || (c.createdMs !== null ? nowMs - c.createdMs >= COIN_MIN_AGE_D * 86_400_000 : c.days.length >= 2);
/**
 * Jupiter's description of a coin, good for CAP_TTL_MS. Written to the state file only for a coin of half the floor or
 * more (thousands of memecoins are asked): the rest are only remembered as asked, in memory.
 */
function setCap(x: { mint: string; createdMs: number | null; mcap: number | null; liq: number | null; stock: boolean }, nowMs = Date.now()) {
  const caps = (state.caps ??= {});
  const was = caps[x.mint] ?? null;
  const row: CapRow | null = x.mcap !== null && x.liq !== null && x.mcap >= CAP_MIN_USD / 2 ? { mcap: Math.round(x.mcap), liq: Math.round(x.liq), createdMs: x.createdMs, ...(x.stock ? { stock: true } : {}), at: nowMs } : null;
  if (row) caps[x.mint] = row;
  else delete caps[x.mint];
  capAsked.set(x.mint, nowMs);
  if (capOkRow(was, nowMs) !== capOkRow(row, nowMs)) capsMoved = true;
}
/** Asked of Jupiter within CAP_TTL_MS (a coin it sized, or did not know). */
const capKnown = (m: string, nowMs = Date.now()) => nowMs - Math.max(state.caps?.[m]?.at ?? 0, capAsked.get(m) ?? 0) < CAP_TTL_MS;
let capsMoved = false;
/** Why a coin of CAP_MIN_USD+ is not a cap, or "" when it is. No first pool given: the old coins (Jupiter often has none for them) pass. */
const capWhy = (c: CapRow, nowMs: number) => (c.stock ? "share" : c.liq < CAP_MIN_LIQ_USD ? "thin" : c.createdMs !== null && nowMs - c.createdMs < CAP_MIN_AGE_D * 86_400_000 ? "young" : "");
const capOkRow = (c: CapRow | null, nowMs: number) => !!c && c.mcap >= CAP_MIN_USD && capWhy(c, nowMs) === "";
/** A mid or high cap by its last description: CAP_MIN_USD+ market value, CAP_MIN_LIQ_USD+ liquidity, CAP_MIN_AGE_D+ days old. */
export const capOk = (mint: string, nowMs = Date.now()) => capOkRow(state.caps?.[mint] ?? null, nowMs);
/**
 * Coins no list described lately, that our kept wallets traded or a paper copy holds: asked of Jupiter's search, 100
 * a call, CAP_LOOKUPS calls a pass. Its answer says nothing of a coin it does not know: that one is written down as null.
 */
async function capLookup(nowMs = Date.now()): Promise<number> {
  if (!cfg?.jup) return 0;
  const want = new Map<string, number>();
  const stale = (m: string) => m !== SOL_MINT && !STABLES.has(m) && !capKnown(m, nowMs);
  for (const p of state.open) if (stale(p.mint)) want.set(p.mint, 1e9);
  for (const w of Object.values(state.wallets)) for (const x of w.swaps) if (stale(x[2])) want.set(x[2], (want.get(x[2]) ?? 0) + 1);
  const mints = [...want].sort((a, b) => b[1] - a[1]).map(([m]) => m).slice(0, CAP_LOOKUPS * 100);
  let asked = 0;
  for (let i = 0; i < mints.length && !stopped; i += 100) {
    if (!(await askCaps(mints.slice(i, i + 100), nowMs))) break;
    asked++;
  }
  return asked;
}
/** One Jupiter search for up to 100 coins. false = no answer (nothing written down). */
async function askCaps(batch: string[], nowMs = Date.now()): Promise<boolean> {
  if (!cfg?.jup || !batch.length) return false;
  // the Jupiter key is shared with the real copy's quotes: one search every CAP_ASK_GAP_MS at most
  const wait = capLastAsk + CAP_ASK_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  capLastAsk = Date.now();
  let rows: ReturnType<typeof jupCoins>;
  try {
    rows = jupCoins(await cfg.jup(`/tokens/v2/search?query=${batch.join(",")}`));
  } catch (e) {
    coinHealth.lastError = scrub(String((e as Error)?.message ?? e));
    return false;
  }
  capHealth.lookups++;
  const got = new Set(rows.map((x) => x.mint));
  for (const x of rows) if (batch.includes(x.mint)) setCap(x, nowMs);
  for (const m of batch)
    if (!got.has(m)) {
      delete state.caps?.[m];
      capAsked.set(m, nowMs);
    }
  return true;
}
let capLastAsk = 0;
const CAP_ASK_GAP_MS = 1500;
/**
 * A wallet about to be filed as far from the bar (its swaps dropped) with CAP_MIN_TRIPS+ round trips in coins no list
 * has sized: those coins are asked of Jupiter first (one search), so that a mid and high cap trader whose memecoin
 * trades lose is not filed away before its cap trips are seen. true = asked.
 */
async function sizeCoins(swaps: SSwap[]): Promise<boolean> {
  const now = Date.now();
  const by = new Map<string, number>();
  for (const t of tripsOf(swaps).trips) if (!capKnown(t.mint, now) && t.mint !== SOL_MINT && !STABLES.has(t.mint)) by.set(t.mint, (by.get(t.mint) ?? 0) + 1);
  if ([...by.values()].reduce((a, n) => a + n, 0) < CAP_MIN_TRIPS) return false;
  return askCaps([...by].sort((a, b) => b[1] - a[1]).slice(0, 100).map(([m]) => m));
}
/** when a coin Jupiter did not describe was asked (in memory: after a restart it is asked again once) */
const capAsked = new Map<string, number>();
const capHealth = { lookups: 0, replayed: 0 };
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
  const add = (mint: string, symbol: string, createdMs: number | null, from: Coin["from"], vol: number | null = null) => {
    const c = (state.coins[mint] ??= { symbol, from, days: [], createdMs });
    if (createdMs !== null) c.createdMs = createdMs;
    if (vol !== null) c.vol = Math.round(vol);
    if (from === "jupiter") c.from = "jupiter";
    if (!c.days.includes(day)) c.days = [...c.days, day].slice(-7);
  };
  if (cfg?.jup) {
    let ok = 0;
    for (const l of JUP_LISTS) {
      try {
        for (const x of jupCoins(await cfg.jup(`/tokens/v2/${l}?limit=100`))) {
          add(x.mint, x.symbol, x.createdMs, "jupiter", x.vol);
          setCap(x);
        }
        ok++;
      } catch (e) {
        coinHealth.lastError = scrub(String((e as Error)?.message ?? e));
      }
    }
    // the verified coins: only the busy ones, and only where the list says how busy (else none of them)
    try {
      for (const x of jupCoins(await cfg.jup("/tokens/v2/tag?query=verified"))) {
        // every verified coin's size is written down (the mid and high caps); only the busy ones are sampled
        if ((x.mcap ?? 0) >= CAP_MIN_USD / 2 || x.mint in (state.caps ?? {})) setCap(x);
        if ((x.vol ?? 0) >= VERIFIED_MIN_VOL_USD) add(x.mint, x.symbol, x.createdMs, "jupiter", x.vol);
      }
      ok++;
    } catch (e) {
      coinHealth.lastError = scrub(String((e as Error)?.message ?? e));
    }
    coinHealth.lists = `${ok} of ${JUP_LISTS.length + 1} answered`;
  } else coinHealth.lists = "no list reader";
  for (const m of ourCoins()) add(m, m.slice(0, 4), null, "ours");
  // forget coins off every list for 14 days whose sample is over a week old
  const cut = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  for (const [m, c] of Object.entries(state.coins)) if ((c.days.at(-1) ?? "") < cut && !(c.sampledAt && Date.now() - c.sampledAt < COIN_RESAMPLE_MS)) delete state.coins[m];
}
/** One coin's buyers of MIN_BUYER_SOL+ at SAMPLE_DAYS points (SAMPLE_PAGES pages each, never its first day): into the pool. */
async function sampleCoin(mint: string): Promise<boolean> {
  const c = state.coins[mint];
  const now = Date.now();
  const seen = new Map<string, number>();
  const cap = capOk(mint, now);
  for (const d of cap ? CAP_SAMPLE_DAYS : SAMPLE_DAYS) {
    const from = now - d * 86_400_000;
    if (c.createdMs !== null && from < c.createdMs + 86_400_000) continue; // launch-day buyers are snipers
    let token: string | null = null;
    for (let i = 0; i < (cap ? CAP_SAMPLE_PAGES : SAMPLE_PAGES); i++) {
      const pg = await page(mint, { blockTime: { gte: Math.floor(from / 1000) } }, "asc", token);
      if (!pg) return false;
      // no first day given: if nothing traded for hours after the point, what comes back is its launch (or a dead stretch)
      const t0 = pg.data[0]?.blockTime;
      if (i === 0 && c.createdMs === null && t0 && t0 - from / 1000 > SAMPLE_GAP_S) break;
      for (const it of pg.data) {
        const payer = payerOf(it);
        const s = payer ? swapOf(it.meta, payer, it.slot) : null;
        if (!s || s.wallet !== payer || s.mint !== mint || !s.buy || s.sol < MIN_BUYER_SOL) continue;
        seen.set(payer!, (seen.get(payer!) ?? 0) + s.sol);
      }
      token = pg.paginationToken;
      if (!token || pg.data.length < 100) break;
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
/**
 * The pool's best buyers (more of these coins first, then more SOL) become candidates: `max` of them a pass, so that
 * a buyer of several coins found later still comes before the one-coin buyers, up to MAX_COIN_BUYERS in all.
 */
function promote(max = PROMOTE_PER_PASS) {
  const have = new Map(state.candidates.map((c) => [c.address, c]));
  const now = Date.now();
  const capKeys = new Set(Object.keys(state.caps ?? {}).filter((m) => capOk(m, now)).map((m) => m.slice(0, 6)));
  for (const [w, [k]] of Object.entries(state.pool)) {
    const c = have.get(w);
    if (!c) continue;
    // a candidate seen again buying a cap coin is marked as a cap buyer (read first while it is still unread)
    if (!c.cap && k.split(",").some((x) => capKeys.has(x))) c.cap = true;
    delete state.pool[w];
  }
  let n = state.candidates.filter((c) => srcOf(c) === "coin").length;
  const ranked = Object.entries(state.pool)
    .filter(([w]) => !have.has(w))
    .map(([w, [k, sol]]) => ({ w, coins: k.split(",").length, cap: k.split(",").some((x) => capKeys.has(x)), sol }))
    // buyers of a mid or high cap first (enrique, 17 Nov 2026: "cant u find wallets that are good at spot trading of midcaps?")
    .sort((a, b) => Number(b.cap) - Number(a.cap) || b.coins - a.coins || b.sol - a.sol);
  let added = 0;
  for (const x of ranked) {
    if (added >= max) break;
    // the coin buyers are capped, except buyers of a mid or high cap (the wallets wanted since 17 Nov 2026)
    if (n >= MAX_COIN_BUYERS && !x.cap) continue;
    state.candidates.push({ name: `coin buyer ${x.w.slice(0, 4)}`, address: x.w, source: "coin", ...(x.cap ? { cap: true as const } : {}) });
    delete state.pool[x.w];
    n++;
    added++;
  }
  // the pool keeps its best MAX_POOL for later
  const rest = Object.keys(state.pool);
  if (rest.length > MAX_POOL) {
    const keep = new Set(ranked.filter((x) => state.pool[x.w]).slice(0, MAX_POOL).map((x) => x.w));
    for (const w of rest) if (!keep.has(w)) delete state.pool[w];
  }
}
/** The coin lists every 6 h, then `max` due coins sampled (MAX_COINS a week in all), then buyers promoted. false = credit cap. */
async function coinStep(max = COINS_PER_PASS): Promise<boolean> {
  await refreshCoins();
  const now = Date.now();
  // the weekly MAX_COINS budget is for the other coins: a mid or high cap is never held back by it (on 18 Nov 2026 the
  // budget was spent, 1,500 of 1,500, and no cap coin was due for a week however short its daily clock)
  const recent = Object.entries(state.coins).filter(([m, c]) => !capOk(m, now) && c.sampledAt && now - c.sampledAt < COIN_RESAMPLE_MS).length;
  const due0 = Object.entries(state.coins)
    // a mid or high cap is sampled again daily (new buyers of it every day), the rest weekly
    .filter(([m, c]) => coinOld(c, now) && !(c.sampledAt && now - c.sampledAt < (capOk(m, now) ? CAP_RESAMPLE_MS : COIN_RESAMPLE_MS)))
    // mid and high caps first (enrique, 17 Nov 2026: "focus on mid to high caps"): their buyers are the wallets wanted
    .sort((a, b) => Number(capOk(b[0], now)) - Number(capOk(a[0], now)) || (a[1].from === b[1].from ? b[1].days.length - a[1].days.length || (b[1].vol ?? 0) - (a[1].vol ?? 0) : a[1].from === "jupiter" ? -1 : 1));
  const allDue = [...due0.filter(([m]) => capOk(m, now)), ...due0.filter(([m]) => !capOk(m, now)).slice(0, Math.max(0, MAX_COINS - recent))];
  const due = allDue.slice(0, max);
  coinHealth.due = allDue.length - due.length;
  coinHealth.sampled = 0;
  let ok = true;
  for (const [m, c] of due) {
    if (stopped) break;
    health.working = `coin ${c.symbol}`;
    if (!(await sampleCoin(m))) {
      ok = false;
      break;
    }
    coinHealth.sampled++;
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
  const whole = !prev || !!prev.bot || !!prev.fast || !!prev.out || !!prev.redo;
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
  // Its pace is judged over the whole window, as at its first read. A daily read adds one day to the days read
  // before (at least as far back as the swaps we keep): on that day alone, one busy day made a passing wallet a
  // program, unread for a month.
  const oldest = swaps.length ? (now - swaps[0].t) / 86_400 : 0;
  const before = whole ? 0 : Math.max(0, Math.min(DAYS_BACK - spanDays, Math.max(prev.spanDays, oldest - spanDays)));
  const span = spanDays + before;
  const txPerDay = (items.length + (whole ? 0 : prev.txPerDay * before)) / span;
  const buysPerDay = (fresh.filter((s) => s.buy).length + (whole ? 0 : prev.buysPerDay * before)) / span;
  const bot = early === "bot" || txPerDay > 400 || buysPerDay > 60;
  const fast = !bot && early && early !== "bot" ? early : undefined;
  state.wallets[c.address] = {
    name: c.name,
    doneAt: Date.now(),
    newest: times.length ? Math.max(...times) : (prev?.newest ?? since),
    txPerDay,
    buysPerDay,
    spanDays: Math.min(DAYS_BACK, span),
    ...(bot ? { bot } : {}),
    ...(fast ? { fast } : {}),
    swaps: bot || fast ? [] : swaps.map(pack),
    late: prev?.late ?? {},
  };
  // far from the bar: its numbers stay, its swaps do not (thousands of wallets would not fit the state file)
  if (!bot && !fast) {
    let rep = reportOf(c.address)!;
    if (!kept(rep) && (await sizeCoins(swaps))) {
      memo.delete(state.wallets[c.address]);
      rep = reportOf(c.address)!;
    }
    if (!kept(rep)) state.wallets[c.address] = { ...state.wallets[c.address], swaps: [], out: { trips: rep.trips, tripsPerDay: rep.tripsPerDay, sol: rep.realisedSol, wonPct: rep.wonPct, holdMin: rep.holdMinMedian, why: rep.why, copyable: rep.copyable } };
  }
  return true;
}
/** Worth its swaps and a daily read: it passes, or is near (10+ trips, a median hold of MIN_HOLD_MIN+ min, and ahead). */
export const kept = (x: { pass: boolean; trips: number; holdMinMedian: number | null; realisedSol: number | null; cap?: { trips: number } | null }) =>
  x.pass || (x.trips >= 10 && (x.holdMinMedian ?? 0) >= MIN_HOLD_MIN && (x.realisedSol ?? 0) > 0) || (x.cap?.trips ?? 0) >= CAP_MIN_TRIPS;

/** Step 2 for one wallet that passed the screen: its newest trips not yet checked. */
async function checkLate(address: string) {
  const w = state.wallets[address];
  const { trips } = tripsOf(w.swaps.map(unpack));
  for (const t of trips.slice(-DELAY_TRIPS)) {
    const k = `${t.mint}|${t.slot0}`;
    if (w.late[k]?.x30 !== undefined || stopped) continue;
    const at = async (slot: number, side: "entry" | "exit") => {
      const pg = await page(t.mint, { slot: { gte: slot } }, "asc", null);
      if (!pg) throw new Error("cap");
      const swaps = pg.data.map((it) => swapOf(it.meta, payerOf(it), it.slot)).filter((s): s is NonNullable<typeof s> => !!s && s.mint === t.mint && s.wallet !== address);
      return priceAfter(swaps, side);
    };
    try {
      memo.delete(w);
      w.late[k] = {
        ...w.late[k],
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

/** The cap replay for one wallet: its newest CAP_REPLAY_TRIPS mid and high cap trips not yet priced. false = credit cap. */
async function checkCap(address: string, nowMs = Date.now()) {
  const w = state.wallets[address];
  if (!w) return true;
  const { trips } = tripsOf(w.swaps.map(unpack));
  for (const t of trips.filter((x) => capOk(x.mint, nowMs)).slice(-CAP_REPLAY_TRIPS)) {
    const k = `${t.mint}|${t.slot0}`;
    if (w.late[k]?.x5 !== undefined || stopped) continue;
    const at = async (slot: number, side: "entry" | "exit") => {
      const pg = await page(t.mint, { slot: { gte: slot } }, "asc", null);
      if (!pg) throw new Error("cap");
      const swaps = pg.data.map((it) => swapOf(it.meta, payerOf(it), it.slot)).filter((s): s is NonNullable<typeof s> => !!s && s.mint === t.mint && s.wallet !== address);
      return priceAfter(swaps, side);
    };
    try {
      const steps = Math.round(CAP_DELAY_SEC * SLOTS_PER_SEC);
      const e5 = t.t1 - t.t0 > CAP_DELAY_SEC ? await at(t.slot0 + steps, "entry") : null;
      const x5 = await at(t.slot1 + steps, "exit");
      memo.delete(w);
      w.late[k] = { ...w.late[k], e5, x5 };
      capHealth.replayed++;
    } catch (e) {
      if ((e as Error).message === "cap") return false;
      throw e;
    }
  }
  return true;
}
/** The wallets due a cap replay: CAP_MIN_TRIPS+ mid and high cap trips, some not priced; most of those first. */
function capDue(max = CAP_WALLETS_PER_PASS): string[] {
  return reports()
    .filter((x) => !x.bot && !x.fast && x.cap && x.cap.trips >= CAP_MIN_TRIPS && x.cap.toReplay > 0)
    .sort((a, b) => b.cap!.trips - a.cap!.trips)
    .slice(0, max)
    .map((x) => x.address);
}
/** One pass of the cap side: coin sizes looked up, then the replay. false = credit cap. */
async function capStep(): Promise<boolean> {
  await capLookup();
  if (capsMoved) {
    capsMoved = false;
    memo = new WeakMap();
    cache = null;
  }
  for (const a of capDue()) {
    if (stopped) break;
    health.working = `replay ${state.wallets[a]?.name ?? a.slice(0, 4)}`;
    const all = await checkCap(a);
    cache = null;
    if (!all) return false;
    saveScreen();
  }
  return true;
}
/**
 * The cap shortlist (enrique, 17 Nov 2026): people (not programs, not flippers) whose replayed mid and high cap trips
 * pass (see capOf), most replayed gain first. The real copy takes its wallets from here when it runs on caps only.
 */
export function capWallets(): { name: string; address: string; priced: number; won: number; avgPct: number | null; sumPct: number | null }[] {
  return reports()
    .filter((x) => !x.bot && !x.fast && x.cap?.pass && copySafe(x.address))
    .sort((a, b) => (b.cap!.sumPct ?? 0) - (a.cap!.sumPct ?? 0))
    .slice(0, CAP_LIST_MAX)
    .map((x) => ({ name: x.name, address: x.address, priced: x.cap!.priced, won: x.cap!.won, avgPct: x.cap!.avgPct, sumPct: x.cap!.sumPct }));
}
/** A wallet's report by its stored state; a read replaces that object, a late check drops its entry. */
let memo = new WeakMap<WState, ReturnType<typeof reportNow>>();
export function reportOf(address: string) {
  const w = state.wallets[address];
  if (!w) return null;
  let v = memo.get(w);
  if (!v) memo.set(w, (v = reportNow(address, w)));
  return v;
}
function reportNow(address: string, w: WState) {
  const o = { txPerDay: w.txPerDay, buysPerDay: w.buysPerDay, spanDays: w.spanDays };
  if (w.out) {
    const s = screen([], { ...o, open: 0 });
    const x = w.out;
    return { name: w.name, address, ...s, trips: x.trips, tripsPerDay: x.tripsPerDay, realisedSol: x.sol, wonPct: x.wonPct, holdMinMedian: x.holdMin, fast: false, pass: false, why: x.why, cap: null };
  }
  if (w.fast) {
    // a flipper read only as far as its newest pages: its own numbers from those, never a pass
    const s = screen([], { ...o, open: 0 });
    const f = w.fast;
    return { name: w.name, address, ...s, trips: f.trips, realisedSol: f.sol, wonPct: f.wonPct, holdMinMedian: f.holdMin, bot: s.bot || f.holdMin < 2, fast: true, pass: false, why: [`holds ${f.holdMin} min`], cap: null };
  }
  const { trips, open } = tripsOf(w.swaps.map(unpack));
  for (const t of trips) Object.assign(t, w.late[`${t.mint}|${t.slot0}`] ?? {});
  const now = Date.now();
  return { name: w.name, address, ...screen(trips, { ...o, open }), fast: false, cap: w.bot ? null : capOf(trips, (m) => capOk(m, now)) };
}
type Report = NonNullable<ReturnType<typeof reportOf>> & { source: Source };
let cache: Report[] | null = null;
/** Every candidate read so far; worked out again only after a wallet was read or checked. */
const reports = (): Report[] =>
  (cache ??= state.candidates.flatMap((c) => {
    const x = reportOf(c.address);
    return x ? [{ ...x, source: srcOf(c) }] : [];
  }));
/** The share of a wallet's late copies that won (5 min late, else 30 s late); -1 = none checked. */
const lateWin = (x: { late: { in30s: { n: number; won: number }; in5min: { n: number; won: number } } }) => {
  const l = x.late.in5min.n ? x.late.in5min : x.late.in30s;
  return l.n ? l.won / l.n : -1;
};
/**
 * Wallets followed on paper: those that pass and are not shown uncopyable by their late copies; most late copies won
 * first (unchecked last). The share won, not the average: one mispriced coin moves an average, not a share.
 */
/** Every wallet the screen would follow, before the balance floor (their balances are read from this list). */
function followedAll(): { name: string; address: string }[] {
  const v = reports()
    .filter((x) => x.pass && x.copyable !== false)
    .sort((a, b) => lateWin(b) - lateWin(a) || (b.late.in5min.medianPct ?? -1e9) - (a.late.in5min.medianPct ?? -1e9) || (b.realisedSol ?? 0) - (a.realisedSol ?? 0))
    .slice(0, FOLLOW_MAX)
    .map((x) => ({ name: x.name, address: x.address }));
  // and the cap shortlist, followed on paper as a live check of its replay
  for (const c of capWallets()) if (!v.some((x) => x.address === c.address)) v.push({ name: c.name, address: c.address });
  return v;
}
/** A wallet whose balance was read and is under MIN_BAL_USD is not followed (unknown is not small). SOLANA_SLOW_MIN_BAL_USD overrides. */
export const MIN_BAL_USD = 5000;
const minBalUsd = () => (process.env.SOLANA_SLOW_MIN_BAL_USD === undefined ? MIN_BAL_USD : Number(process.env.SOLANA_SLOW_MIN_BAL_USD));
const balSmall = (address: string) => {
  const b = state.bal?.[address];
  return Boolean(b && b.usd != null && b.usd < minBalUsd());
};
export function followed(): { name: string; address: string }[] {
  return followedAll().filter((w) => !balSmall(w.address));
}
/**
 * Wallets proven on paper at the entry the real copy makes (5 s in, 5 s out): followed now (so it still passes the
 * screen and its late copies do not say uncopyable), and of its newest PROVEN_LAST closed paper copies PROVEN_MIN+
 * were priced, half or more won and they are ahead in SOL. Most SOL first. Only the newest copies count, so a wallet
 * that turns falls out by itself. The real copy (slowlive.ts) takes its wallets from here.
 */
export function provenWallets(): { name: string; address: string; n: number; won: number; netSol: number }[] {
  const by = new Map<string, Pos[]>();
  for (const p of state.recent) {
    if (!p.closed || !followSet.has(p.wallet)) continue;
    const l = by.get(p.wallet);
    if (l) l.push(p);
    else by.set(p.wallet, [p]);
  }
  const out: { name: string; address: string; n: number; won: number; netSol: number }[] = [];
  for (const [address, ps] of by) {
    const v = ps.slice(-PROVEN_LAST).map((p) => posRet(p, 5, 5)).filter((y): y is number => y !== undefined);
    const won = v.filter((y) => y > 0).length;
    const net = v.reduce((a, y) => a + y, 0) * STAKE_SOL;
    if (v.length >= PROVEN_MIN && won * 2 >= v.length && net > 0) out.push({ name: ps[ps.length - 1].name, address, n: v.length, won, netSol: r(net, 3)! });
  }
  return out.sort((a, b) => b.netSol - a.netSol);
}
/**
 * For the real copy, which may keep a wallet on its own real record after paper drops it: the safety screens it must
 * still pass. Read by the scan, not a program, not a flipper, and its late copies do not say it cannot be copied. The
 * paper record and the rest of the screen (trips, both halves ahead, share won) are not asked here.
 *
 * A wallet the scan filed as far from the bar (`out`) has no swaps left, so its report can no longer tell a program
 * or a flipper (a daily read never sets `bot` by the hold, nor `fast`): it is judged by what was written down when
 * it was filed. Those are the very wallets paper drops through the screen, so this is where the screens must hold:
 * the screen's own word "bot", a median hold under FAST_HOLD_MIN minutes (or none known), or late copies that said
 * it cannot be copied.
 */
export function copySafe(address: string) {
  const w = state.wallets[address];
  const x = reportOf(address);
  if (!w || !x || w.bot || w.fast || x.bot || x.fast || x.copyable === false) return false;
  const o = w.out;
  if (o && (o.why.includes("bot") || o.holdMin === null || o.holdMin < FAST_HOLD_MIN || o.copyable === false)) return false;
  return true;
}
/**
 * The address behind each screen name, from the paper copies. A name is the first letters of an address, so only a
 * wallet copied on paper can be told apart; a name two addresses share is left out.
 */
export function paperAddresses() {
  const m = new Map<string, string>();
  for (const p of [...state.recent, ...state.open]) {
    const a = m.get(p.name);
    if (a === undefined) m.set(p.name, p.wallet);
    else if (a !== p.wallet) m.set(p.name, "");
  }
  for (const [k, v] of m) if (!v) m.delete(k);
  return m;
}
/**
 * Does it matter how many followed wallets are in a coin? Every closed paper copy (5 s in, 5 s out) by how many OTHER
 * followed wallets had bought that coin before this one and had not yet sold when it bought. The real copy lets a
 * second wallet's buy of a coin it holds go (one copy a coin), so this also says what those let-go buys were worth.
 */
/**
 * Does "proven" foretell anything? Each closed paper copy (5 s in, 5 s out) by what its wallet's record said AT THE
 * TIME of that buy, from the wallet's copies already closed by then: proven (of its newest PROVEN_LAST priced copies
 * PROVEN_MIN+, half or more won, ahead), notProven (PROVEN_MIN+ but not that), tooFew. This is the real copy's own
 * choice of wallets tested on copies it had not seen yet: if `proven` is no better than `notProven`, the choice is noise.
 */
export function provenThen(closed: Pos[]) {
  const by = new Map<string, { p: Pos; v: number; end: number }[]>();
  for (const p of closed) {
    const v = posRet(p, 5, 5);
    if (v === undefined) continue;
    const x = { p, v, end: p.closedMs ?? p.soldMs ?? p.seenMs };
    const l = by.get(p.wallet);
    if (l) l.push(x);
    else by.set(p.wallet, [x]);
  }
  const g = { proven: [] as number[], notProven: [] as number[], tooFew: [] as number[] };
  for (const list of by.values()) {
    list.sort((a, b) => a.end - b.end);
    for (const x of list) {
      const prior = list.filter((y) => y.end < x.p.seenMs).slice(-PROVEN_LAST).map((y) => y.v);
      if (prior.length < PROVEN_MIN) g.tooFew.push(x.v);
      else if (prior.filter((y) => y > 0).length * 2 >= prior.length && prior.reduce((a, y) => a + y, 0) > 0) g.proven.push(x.v);
      else g.notProven.push(x.v);
    }
  }
  const stat = (v: number[]) => ({ n: v.length, won: v.filter((y) => y > 0).length, avgRetPct: v.length ? r((avg(v) ?? 0) * 100) : null, medianRetPct: r((median(v) ?? NaN) * 100), netSol: r(v.reduce((a, y) => a + y, 0) * STAKE_SOL, 3), top5Sol: top5Sol(v) });
  return { proven: stat(g.proven), notProven: stat(g.notProven), tooFew: stat(g.tooFew) };
}
/** For each copy: how many other followed wallets had bought its coin before it and not yet sold when it bought. */
function othersIn(closed: Pos[], open: Pos[]): (p: Pos) => number {
  const by = new Map<string, Pos[]>();
  for (const p of [...closed, ...open]) {
    const l = by.get(p.mint);
    if (l) l.push(p);
    else by.set(p.mint, [p]);
  }
  return (p) => {
    const others = new Set<string>();
    for (const q of by.get(p.mint) ?? []) if (q.wallet !== p.wallet && q.seenMs < p.seenMs && (q.soldMs ?? q.closedMs ?? Infinity) > p.seenMs) others.add(q.wallet);
    return others.size;
  };
}
/** The crowd rules tried: a coin is copied when at least this many other followed wallets already hold it (0 = any buy, as the real copy does). */
export const CROWD_MIN = [0, 1, 2, 3] as const;
/**
 * The crowd split as a real copy would have to run it: ONE copy a coin. In time order a closed paper copy (5 s in,
 * 5 s out) is taken when `minOthers`+ other followed wallets were already in the coin and no copy of that coin taken
 * earlier is still held; it ends with the wallet whose buy it copied. The many copies of one coin in crowdStudy
 * count once here, so this is the number to judge the lead by. `newer` = the newer half of the copies taken.
 */
export function crowdOnePerCoin(closed: Pos[], open: Pos[]) {
  const n = othersIn(closed, open);
  const list = closed
    .map((p) => ({ p, v: posRet(p, 5, 5), o: n(p) }))
    .filter((x): x is { p: Pos; v: number; o: number } => x.v !== undefined)
    .sort((a, b) => a.p.seenMs - b.p.seenMs);
  const stat = (v: number[]) => ({ n: v.length, won: v.filter((y) => y > 0).length, avgRetPct: v.length ? r((avg(v) ?? 0) * 100) : null, netSol: r(v.reduce((a, y) => a + y, 0) * STAKE_SOL, 3), top5Sol: top5Sol(v) });
  return CROWD_MIN.map((minOthers) => {
    const until = new Map<string, number>();
    const coins = new Set<string>();
    const v: number[] = [];
    for (const x of list) {
      if (x.o < minOthers || (until.get(x.p.mint) ?? 0) > x.p.seenMs) continue;
      until.set(x.p.mint, x.p.closedMs ?? x.p.soldMs ?? x.p.seenMs);
      coins.add(x.p.mint);
      v.push(x.v);
    }
    return { minOthers, ...stat(v), coins: coins.size, newer: stat(v.slice(Math.floor(v.length / 2))) };
  });
}
export function crowdStudy(closed: Pos[], open: Pos[]) {
  const n = othersIn(closed, open);
  const groups: number[][] = [[], [], []];
  for (const p of closed) {
    const v = posRet(p, 5, 5);
    if (v === undefined) continue;
    groups[Math.min(n(p), 2)].push(v);
  }
  return (["0", "1", "2+"] as const).map((othersIn, i) => {
    const v = groups[i];
    return { othersIn, n: v.length, won: v.filter((y) => y > 0).length, avgRetPct: v.length ? r((avg(v) ?? 0) * 100) : null, netSol: r(v.reduce((a, y) => a + y, 0) * STAKE_SOL, 3) };
  });
}
/** Every closed paper copy with a 5 s in, 5 s out result: whose buy, which coin, when we saw it, what it made. For the real copy's taken-versus-skipped check. */
export const paperResults = () =>
  state.recent.flatMap((p) => {
    const ret = p.closed ? posRet(p, 5, 5) : undefined;
    return ret === undefined ? [] : [{ name: p.name, mint: p.mint, seenMs: p.seenMs, ret }];
  });
let followSet = new Set<string>();
const refreshFollow = () => (followSet = new Set(followed().map((x) => x.address)));
/**
 * The real day-holder copy (slowlive.ts) is told of every swap of its own wallets that the stream carries, whether or
 * not they still pass the screen. Nothing in the paper study depends on it.
 */
export interface SlowSwap {
  wallet: string;
  mint: string;
  buy: boolean;
  sol: number;
  slot: number;
  seenMs: number;
}
let realWatch = (): string[] => [];
let realHook: ((s: SlowSwap) => void) | null = null;
export function onSlowSwap(watch: () => string[], hook: (s: SlowSwap) => void) {
  realWatch = watch;
  realHook = hook;
}
let realSummary: (() => unknown) | null = null;
export const setSlowRealSummary = (f: () => unknown) => void (realSummary = f);
/** Addresses the copy runner's stream should carry for this study: followed wallets, any with a paper copy open, and the real copy's. */
export const slowWatch = (): string[] => [...new Set([...followSet, ...state.open.map((p) => p.wallet), ...realWatch()])];

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
    if (coinHealth.sampled) did = true;
    try {
      const before = capHealth.replayed;
      if (!(await capStep())) health.state = "resting until tomorrow (daily credit cap)";
      if (capHealth.replayed > before) {
        did = true;
        refreshFollow();
      }
    } catch (e) {
      health.errors++;
      health.lastError = scrub(String((e as Error)?.message ?? e));
    }
    try {
      await balanceStep();
      refreshFollow();
    } catch (e) {
      health.errors++;
      health.lastError = scrub(String((e as Error)?.message ?? e));
    }
    for (const c of dueWallets()) {
      if (stopped) return;
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
    saveScreen(!did); // a busy pass writes on the clock; an idle one writes what it has before the long sleep
    if (!did && health.state === "reading") health.state = "up to date";
    closeOld();
    await sleep(did ? 5000 : 10 * 60_000);
  }
}
/**
 * Is this wallet due a read: never read, read under a shorter window, or older than its kind's refresh time. A wallet
 * on the real copy's watch (copied for real now, or a real copy of it still out) is read daily even when it is filed
 * as a flipper or as far from the bar: real money follows it, perhaps on its real record alone (slowlive.ts), and the
 * safety screens (copySafe) must not be judged on a read two weeks old.
 */
// a wallet on the real watch is re-read daily whatever it was filed as: a real winner held back as a bot (or as fast,
// or out) is judged again on a fresh read, so it comes back the day that screen clears (review of 16 Nov 2026)
const dueNow = (st: WState | undefined, nowMs: number, real = false) => !st || !!st.redo || nowMs - st.doneAt >= (real ? REFRESH_MS : st.bot ? BOT_REFRESH_MS : st.fast || st.out ? OUT_REFRESH_MS : REFRESH_MS);
/** One pass's wallets: those whose swaps we keep (passing or near) and the real copy's first, then the never read, then the stale rest. */
function dueWallets(max = WALLETS_PER_PASS): Cand[] {
  const now = Date.now();
  let real = new Set<string>();
  try {
    real = new Set(realWatch());
  } catch {
    // the real side cannot say: the usual times
  }
  const rank = (c: Cand) => {
    const st = state.wallets[c.address];
    // a buyer of a mid or high cap never read comes first among the new (18 Nov 2026: they waited behind 13,000)
    return real.has(c.address) ? 0 : !st ? (c.cap ? 0 : 1) : (st.bot || st.fast || st.out) && !st.redo ? 2 : 0;
  };
  return state.candidates
    .filter((c) => dueNow(state.wallets[c.address], now, real.has(c.address)))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, max);
}

// ---- paper copy: live ----------------------------------------------------------------------------------------------
function finish(p: Pos, why: NonNullable<Pos["closed"]>) {
  p.closed = why;
  p.closedMs = Date.now();
  state.open = state.open.filter((x) => x !== p);
  state.recent = [...state.recent, p].slice(-KEEP_COPIES);
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
  if (realHook && realWatch().includes(payer)) {
    const s = sswapOf(tx.meta, payer, tx.slot, Math.floor(nowMs / 1000));
    if (s) {
      try {
        realHook({ wallet: payer, mint: s.mint, buy: s.buy, sol: s.sol, slot: tx.slot, seenMs: nowMs });
      } catch {
        /* the real copy keeps its own errors */
      }
    }
  }
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
  }
  // one read a wallet, from its oldest open copy on, instead of one a copy: with 150 wallets followed there can be
  // thousands of open copies, and the bot restarts at every deploy
  const by = new Map<string, Pos[]>();
  for (const p of state.open) if (!p.soldMs) by.set(p.wallet, [...(by.get(p.wallet) ?? []), p]);
  for (const [wallet, ps] of by) {
    if (stopped) return;
    try {
      let token: string | null = null;
      for (let i = 0; i < CATCH_PAGES; i++) {
        const pg = await page(wallet, { blockTime: { gt: Math.floor(Math.min(...ps.map((p) => p.seenMs)) / 1000) }, tokenAccounts: "balanceChanged" }, "asc", token);
        if (!pg) return;
        for (const it of pg.data) {
          const sw = payerOf(it) === wallet ? sswapOf(it.meta, wallet, it.slot, it.blockTime ?? 0) : null;
          if (!sw || sw.buy) continue;
          // a sale counts for a copy only if it came after we saw that copy's buy
          for (const p of ps) if (p.mint === sw.mint && !p.soldMs && sw.t > Math.floor(p.seenMs / 1000)) onSell(p, "sold while we were down");
        }
        token = pg.paginationToken;
        if (!token || !pg.data.length || ps.every((p) => p.soldMs)) break;
      }
    } catch (e) {
      health.errors++;
      health.lastError = scrub(String((e as Error).message));
    }
  }
}

/** Wallets read under a shorter window: every person is read whole once more; until then its old swaps stand. */
function toWindow() {
  if (state.window === DAYS_BACK) return;
  for (const w of Object.values(state.wallets)) if (!w.bot && !w.fast) w.redo = true;
  state.window = DAYS_BACK;
}

/**
 * Until 16 Nov 2026 a daily read judged a wallet's pace on that one day: a passing wallet with one busy day was filed
 * as a program and left unread for a month. A program with late checks passed the screen once (only a passing wallet
 * gets them): each is read whole once more, first in the queue. Once.
 */
function rereadBusy() {
  if (state.paceFix !== undefined) return;
  const was = Object.values(state.wallets).filter((w) => w.bot && Object.keys(w.late ?? {}).length);
  for (const w of was) w.redo = true;
  state.paceFix = was.length;
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
  toWindow();
  rereadBusy();
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
  paperWait = false;
  save(true);
  saveScreen(true);
}

export function slowSummary() {
  const reps = reports();
  const people = reps.filter((x) => !x.bot && !x.fast);
  const slim = (x: (typeof reps)[number]) => ({ name: x.name, address: x.address, source: x.source, trips: x.trips, tripsPerDay: x.tripsPerDay, realisedSol: x.realisedSol, wonPct: x.wonPct, holdMinMedian: x.holdMinMedian, holdOverHourPct: x.holdOverHourPct, buySolMedian: x.buySolMedian, smallStartPct: x.smallStartPct, topTradeSharePct: x.topTradeSharePct, olderSol: x.olderSol, newerSol: x.newerSol, late: x.late, copyable: x.copyable, why: x.why });
  const pass = people.filter((x) => x.pass);
  const done = state.recent.filter((p) => p.closed);
  const fol = followed();
  const proven = provenWallets();
  return {
    note: `Paper and read-only. CANDIDATES: the listed wallets, the busiest pump.fun buyers, and (day holders) wallets that bought ${MIN_BUYER_SOL}+ SOL of coins that keep trading for days (${COIN_MIN_AGE_D}+ days old, no stables or staked SOL: on ${JUP_LISTS.length} of Jupiter's lists, or verified with $${VERIFIED_MIN_VOL_USD}+ traded in a day; and coins our wallets traded on 3+ days), sampled at ${SAMPLE_DAYS.join(" / ")} days back, ${SAMPLE_PAGES} pages each. A full first page inside ${BOT_PAGE_H} h = bot; ${FAST_TRIPS}+ trips in its newest ${FAST_PAGES * 100} transactions with a median hold under ${FAST_HOLD_MIN} min = fast (flipper); neither is read further. A wallet read in full that neither passes nor is near (10+ trips, median hold ${MIN_HOLD_MIN}+ min, ahead) keeps its numbers but not its swaps and is read again every ${OUT_REFRESH_MS / 86_400_000} days; passing and near ones daily. SCREEN: each candidate's own SOL swaps over the last ${DAYS_BACK} days as round trips (first buy until ${CLOSE_SHARE * 100}% sold). Passes = not a bot, ${MIN_TRIPS}+ trips, first sell a median ${MIN_HOLD_MIN}+ min after its first buy, realised SOL positive in BOTH halves of the period, ${MIN_WIN * 100}%+ won, no single trade half or more of the profit. Realised SOL is before network fees. LATE: for its newest ${DELAY_TRIPS} trips, a copier entering 30 s / 5 min after its first buy and selling ${EXIT_SEC} s after its first sale, priced from other people's trades, ${DELAY_COST * 100}% cost taken off: an estimate (a late price over ${LATE_OFF}x off the wallet's own is left out). NOT COPYABLE: a passing wallet with ${NO_COPY_MIN}+ late copies checked and fewer than 1 in ${NO_COPY_ONE_IN} won; it is not followed. smallStartPct = trips whose first buy was under half the wallet's usual. PAPER: followed wallets copied live with ${STAKE_SOL} SOL at Jupiter quotes, ${ENTRY_DELAYS.map(when).join(" / ")} after we see the buy, sold ${EXIT_DELAYS.join(" / ")} s after its first sale (or at ${MAX_HOLD_H} h); by wallet, in5s is the entry a real copy makes; proven = followed now, and of its newest ${PROVEN_LAST} closed 5 s copies ${PROVEN_MIN}+ priced, half or more won, ahead; provenThen = closed 5 s copies by whether their wallet counted as proven when the copy was bought (from its copies closed by then); crowd = closed 5 s copies by how many other followed wallets had bought the coin before and not yet sold; crowdOnePerCoin = that as a rule at one copy a coin (a copy taken when minOthers+ others hold the coin and none of ours is out), newer = its newer half; top5Sol = SOL made by the five best copies (most of the net = a few big winners, not a rule). Leads to test, not proof.`,
    state: health.state,
    working: health.working,
    windowDays: DAYS_BACK,
    rereadBusy: state.paceFix ?? null,
    candidates: state.candidates.length,
    read: reps.length,
    unread: state.candidates.length - reps.length,
    /** people whose swaps are kept and read daily (passing or near), and people far from the bar */
    kept: people.filter((x) => kept(x)).length,
    farOff: people.filter((x) => !kept(x)).length,
    bots: reps.filter((x) => x.bot).length,
    fast: reps.filter((x) => x.fast && !x.bot).length,
    passing: pass.length,
    /** of those: not followed, because fewer than 1 in NO_COPY_ONE_IN of NO_COPY_MIN+ late copies won; and not checked enough to say */
    notCopyable: pass.filter((x) => x.copyable === false).length,
    copyUnknown: pass.filter((x) => x.copyable === null).length,
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
      dueNow: coinHealth.due,
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
    /** each followed wallet's own size: SOL held and dollars in SOL and priced coins (a floor; null = not read yet),
     *  beside what it made over the window and its usual first buy */
    /** passing wallets not followed because their balance is under the floor: name and dollars */
    leftOutSmall: followedAll().filter((w) => balSmall(w.address)).map((w) => ({ name: w.name, usd: state.bal?.[w.address]?.usd ?? null })),
    minBalanceUsd: minBalUsd(),
    followedSizes: fol.map((x) => {
      const b = state.bal?.[x.address];
      const rep = reportOf(x.address);
      return { name: x.name, sol: b && b.sol >= 0 ? b.sol : null, usd: b?.usd ?? null, readAt: b?.at ?? null, realisedSol: rep?.realisedSol ?? null, buySolMedian: rep?.buySolMedian ?? null };
    }),
    /** mid and high caps (enrique, 17 Nov 2026): coin sizes, the replay of each wallet's past cap trips, the shortlist */
    caps: (() => {
      const now = Date.now();
      const rows = Object.values(state.caps ?? {});
      const withCap = people.filter((x) => x.cap && x.cap.trips > 0);
      const capDone = done.filter((p) => capOk(p.mint, now));
      const v = capDone.map((p) => posRet(p, 5, 5)).filter((y): y is number => y !== undefined);
      return {
        note: `A mid or high cap: Jupiter gives it $${CAP_MIN_USD / 1e6}M+ market value, $${CAP_MIN_LIQ_USD / 1e3}k+ liquidity and a first pool ${CAP_MIN_AGE_D}+ days old (no stables, staked SOL, pool or tokenised shares). REPLAY: a wallet with ${CAP_MIN_TRIPS}+ round trips in those coins over ${DAYS_BACK} days has its newest ${CAP_REPLAY_TRIPS} replayed as our real copy makes them: in ${CAP_DELAY_SEC} s after its first buy, out ${CAP_DELAY_SEC} s after its first sale, priced from other people's trades of the coin, ${CAP_COST * 100}% off for fees and price impact. SHORTLIST: ${CAP_LIST_MIN}+ priced, half or more won, ahead, ahead in both halves, no one trip half the gain, not a program or a flipper; most replayed gain first (sumPct = the replayed returns added up, in % of one stake). The shortlist is followed on paper too (paperCopies: its 5 s copies in these coins).`,
        coinsSized: rows.length,
        coinsAsked: capAsked.size,
        coinsOk: Object.keys(state.caps ?? {}).filter((m) => capOk(m, now)).length,
        /** coins of CAP_MIN_USD+ left out, by why: thin liquidity, younger than CAP_MIN_AGE_D days, a pool or tokenised share */
        coinsOverFloorLeftOut: rows.filter((c) => c.mcap >= CAP_MIN_USD && capWhy(c, now)).reduce<Record<string, number>>((a, c) => ((a[capWhy(c, now)] = (a[capWhy(c, now)] ?? 0) + 1), a), {}),
        /** buyers of a cap coin waiting in the pool (they become candidates first) */
        capBuyersInPool: (() => {
          const keys = new Set(Object.keys(state.caps ?? {}).filter((m) => capOk(m, now)).map((m) => m.slice(0, 6)));
          return Object.values(state.pool).filter(([k]) => k.split(",").some((x) => keys.has(x))).length;
        })(),
        coinsOkSampledThisWeek: Object.entries(state.coins).filter(([m, c]) => capOk(m, now) && c.sampledAt && now - c.sampledAt < COIN_RESAMPLE_MS).length,
        lookups: capHealth.lookups,
        walletsWithCapTrips: withCap.length,
        walletsReplayable: withCap.filter((x) => x.cap!.trips >= CAP_MIN_TRIPS).length,
        tripsReplayed: capHealth.replayed,
        toReplay: withCap.filter((x) => x.cap!.trips >= CAP_MIN_TRIPS).reduce((a, x) => a + x.cap!.toReplay, 0),
        shortlist: withCap.filter((x) => x.cap!.pass && copySafe(x.address)).sort((a, b) => (b.cap!.sumPct ?? 0) - (a.cap!.sumPct ?? 0)).slice(0, CAP_LIST_MAX).map((x) => ({ name: x.name, ...x.cap! })),
        /** the best replays that miss the bar, for a look at how near they come */
        near: withCap.filter((x) => !x.cap!.pass && x.cap!.priced >= 5).sort((a, b) => (b.cap!.sumPct ?? 0) - (a.cap!.sumPct ?? 0)).slice(0, 10).map((x) => ({ name: x.name, ...x.cap! })),
        paperCopies: { n: v.length, won: v.filter((y) => y > 0).length, avgRetPct: v.length ? r((avg(v) ?? 0) * 100) : null, netSol: r(v.reduce((a, y) => a + y, 0) * STAKE_SOL, 3) },
      };
    })(),
    paper: {
      open: state.open.length,
      closed: done.length,
      buysSeen: health.buysSeen,
      sellsSeen: health.sellsSeen,
      rules: paperRules(done),
      byWallet: [...new Set(done.map((p) => p.wallet))].map((w) => {
        const ps = done.filter((p) => p.wallet === w);
        const at = (d: (typeof ENTRY_DELAYS)[number], x: (typeof EXIT_DELAYS)[number]) => {
          const v = ps.map((p) => posRet(p, d, x)).filter((y): y is number => y !== undefined);
          return { n: v.length, won: v.filter((y) => y > 0).length, avgRetPct: v.length ? r((avg(v) ?? 0) * 100) : null, netSol: r(v.reduce((a, y) => a + y, 0) * STAKE_SOL, 3) };
        };
        // in5s is the entry the real copy makes; proven: see provenWallets (its newest copies only, and followed now)
        return { name: ps[0].name, copies: ps.length, in5s: at(5, 5), in5min: at(300, 30), proven: proven.some((x) => x.address === w) };
      }),
      /** the wallets the real copy may take, by their newest PROVEN_LAST closed 5 s copies */
      proven: proven.map((x) => ({ name: x.name, n: x.n, won: x.won, netSol: x.netSol })),
      /** closed 5 s copies by how many other followed wallets were already in the coin when this one bought */
      /** every closed 5 s copy by what its wallet's paper record said when it was bought: does "proven" foretell anything? */
      provenThen: provenThen(done),
      crowd: crowdStudy(done, state.open),
      /** the same lead at one copy a coin, as a real copy would run it: copy when minOthers+ other followed wallets already hold the coin */
      crowdOnePerCoin: crowdOnePerCoin(done, state.open),
      holdMinMedian: r(median(done.filter((p) => p.soldMs).map((p) => (p.soldMs! - p.seenMs) / 60_000)), 0),
    },
    /** the real day-holder copy (slowlive.ts), when it runs */
    real: realSummary ? realSummary() : null,
    calls: health.calls,
    errors: health.errors,
    creditsToday: state.credits,
    creditsCapPerDay: creditsDay(),
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
    capAsked.clear();
    capLastAsk = 0;
    for (const t of timers) clearTimeout(t);
    timers.clear();
  },
  follow: (a: string[]) => (followSet = new Set(a)),
  readWallet,
  checkLate,
  checkCap,
  capStep,
  capLookup,
  capOk,
  coinStep,
  promote,
  dueWallets,
  toWindow,
  rereadBusy,
  catchUp,
  onSell,
};
