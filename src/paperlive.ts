import { WINDOW_SEC, kstDay } from "./config.js";
import { chainlink } from "./feeds/index.js";
import type { Feed } from "./feeds/socket.js";
import type { BookRow } from "./recorder.js";
import { append, loadJson, saveJson } from "./store.js";

/**
 * Live paper trading of the projection rule, inside the recorder. No order is ever sent.
 *
 * The market settles on the 60s average of the Chainlink feed ending at close, against the 60s
 * average ending at open. From PAPER_LEFT seconds before close, every second: project the closing
 * average (the part of the final minute already seen, plus the current price for the rest), pick the
 * side it favours, and if that side's best ask is at or under PAPER_CAP, "buy" up to PAPER_SIZE
 * dollars from the ask levels actually on the book. One trade per window. Fee 7% * p * (1-p).
 * Settled trades go to data/paper[-variant]/<day>.jsonl; open ones survive a restart in data/paper[-variant]-open.json.
 */
export type Variant = {
  name: string;
  left: number;
  cap: number;
  size: number;
  floor?: number;
  /** Only buy when the ask is at or above the previous second's ask (the crowd is not moving against the side). */
  noFall?: boolean;
  /** Jump guard: skip when the chosen side's ask was below this one second earlier (a book that leaps into the band from far below is usually collapsing). */
  prevFloor?: number;
  /** Early-window long shot: buy whichever side is cheapest, at or under `cap`, within the first `first` seconds of the window (no projection). */
  first?: number;
  /** Early rule: consider only this side ("UP" or "DOWN"); the other side is ignored even when cheaper. */
  onlySide?: "UP" | "DOWN";
  /** Favourite rule: buy the higher-priced side the first time its best ask is at or above `favAt`, any time in the window, paying up to `cap` (no projection). */
  favAt?: number;
  /** For favAt: only act between these seconds into the window, measured on a 5-minute window and scaled for longer ones. */
  favFrom?: number;
  favTo?: number;
  /** For favAt: if the favourite's first look at or above favAt is already over `cap`, give the window up instead of waiting for the ask to fall back into range (falling back is adverse: replay 96.9% vs 98.8% wins on BTC 15m). */
  strictCap?: boolean;
  /** For favAt: the Chainlink move since open, in the favourite's direction, must be between these (basis points) at the first hit. */
  leadMin?: number;
  leadMax?: number;
  /** For favAt: the favourite's ask must have read at least `holdAt` on each of the previous `holdRows` snapshots of the window. */
  holdRows?: number;
  holdAt?: number;
  /** Salvage: once `salvageAt` seconds or less are left, if our side's best bid is at or under `salvageBid`, sell into the bids. */
  salvageAt?: number;
  salvageBid?: number;
  /** Stop: while a trade is open, if our side's best bid is at or under `stopBid`, sell into the bids (cut the loss early). */
  stopBid?: number;
  /** Take profit: while a trade is open, if our side's best bid is at or above `tpBid`, sell into the bids (bank the gain, skip the tail risk). */
  tpBid?: number;
  /** Two-sided arbitrage: when upAsk + downAsk is at or under `arbSum`, buy both sides for `size` each; one of them pays $1 a share. */
  arbSum?: number;
  /** Previous-window rule: in the first `first` seconds, buy the side that matches ("same") or opposes ("opposite") the direction the last window closed with (the book's favourite at its last snapshot), ask at or under `cap`. */
  prevDir?: "same" | "opposite";
  /** For `first` rules: only trade when the previous window of this series closed this way (the book's favourite at its last snapshot). */
  afterPrev?: "UP" | "DOWN";
  /** Maker test: at the trigger, instead of taking the ask, rest a bid this far under it (no fee); it fills if the ask later comes down to it, else the window is skipped. */
  rest?: number;
  /** Only trade when the UTC hour is inside [from, to). */
  hoursUtc?: [number, number];
  /** Skip when Chainlink has already moved more than this many basis points from the open, either way. */
  maxMoveBp?: number;
  /** Cross-coin check: BTC only trades when ETH's book favours the same side this window; every other coin checks BTC. */
  confirmCross?: boolean;
  /** When the idea was added (shown as "new" for a week) and what it is trying, in plain words. */
  added?: string;
  idea?: string;
};

/** Rules enrique discarded from the dashboard: they stop simulating everywhere. Kept in data/discarded.json. */
let discardedCache: { at: number; set: Set<string> } | null = null;
export function discarded(): Set<string> {
  if (discardedCache && Date.now() - discardedCache.at < 5000) return discardedCache.set;
  const set = new Set(loadJson<string[]>("discarded.json", []));
  discardedCache = { at: Date.now(), set };
  return set;
}
export function setDiscarded(name: string, on: boolean) {
  const set = discarded();
  if (on) set.add(name);
  else set.delete(name);
  saveJson("discarded.json", [...set].sort());
  discardedCache = { at: Date.now(), set };
}

/** The variants run side by side. "base" keeps the original file names; the env vars tune it. */
/** On 15-minute windows favourite rules only enter in the last 3 minutes. */
export const FAV_MAX_LEFT_15M = 180;

export const VARIANTS: Variant[] = [
  { name: "base", left: Number(process.env.PAPER_LEFT ?? 30), cap: Number(process.env.PAPER_CAP ?? 0.9), size: Number(process.env.PAPER_SIZE ?? 5) },
  { name: "early45", left: 45, cap: 0.9, size: 5 },
  { name: "late20", left: 20, cap: 0.9, size: 5 },
  { name: "late15", left: 15, cap: 0.9, size: 5 },
  { name: "cheap70", left: 30, cap: 0.7, size: 5 },
  // Only buy when the book already leans the same way (ask 80c to 90c): the one band that was positive on all three recorded days.
  { name: "band80", left: 45, floor: 0.8, cap: 0.9, size: 5 },
  { name: "band80-30", left: 30, floor: 0.8, cap: 0.9, size: 5 },
  // band80-30 with the live fill rule: skip the second the ask fell. In the recorded books this kept 93% of wins.
  { name: "band80-30-chase", left: 30, floor: 0.8, cap: 0.9, size: 5, noFall: true },
  // band80-30 with the jump guard: every real loss up to 23 Oct came from an ask that was under ~70-75c one second before it first read 80-90c.
  { name: "band80-30-j70", left: 30, floor: 0.8, cap: 0.9, size: 5, prevFloor: 0.70, added: "2026-10-22", idea: "band80-30, but skip when the side's ask was under 70c a second earlier (every real loss was such a jump)" },
  // enrique's long shot (20 Oct): either side under 10c in the first 90s of the window, $5 a trade.
  { name: "cheap10-first90", left: 0, cap: 0.1, size: 5, first: 90 },
  // enrique's favourite rule (21 Oct): buy the favourite the first time its ask reaches 93c, $5. Replay: 2c a trade on BTC 5m, 12-16c on BTC 15m.
  { name: "fav93", left: 0, cap: 0.995, size: 5, favAt: 0.93, added: "2026-10-21", idea: "buy the favourite the first time it reaches 93c" },
  // The one slice of the favourite replay that beat the price at every threshold: 93c reached between 2 and 3 minutes in.
  { name: "fav93-mid", left: 0, cap: 0.995, size: 5, favAt: 0.93, favFrom: 120, favTo: 180, added: "2026-10-21", idea: "fav93 only when 93c is reached 2-3 minutes in" },
  // Best pooled long-shot cell of the grid replay: 12c in the first 60s.
  { name: "cheap12-first60", left: 0, cap: 0.12, size: 5, first: 60, added: "2026-10-21", idea: "long shot at 12c in the first minute" },
  // Replay of 4,507 first hits (19-23 Oct, four 5m coins): fav93 wins 93.9% (-2c a trade). Two filters lifted it:
  // a small Chainlink lead of 0-3bp with 3 minutes or less left won 95.9% (+8c), and an ask that had held 90c+ for the
  // previous ten snapshots won 96.4% (+13c, mostly BTC). Paper only, to see if either survives out of sample.
  { name: "fav93-lead", left: 0, cap: 0.995, size: 5, favAt: 0.93, favFrom: 120, leadMin: 0, leadMax: 3, added: "2026-10-23", idea: "fav93 only with a small Chainlink lead (0-3bp) and 3 minutes or less left" },
  { name: "fav93-hold", left: 0, cap: 0.995, size: 5, favAt: 0.93, holdRows: 10, holdAt: 0.9, added: "2026-10-23", idea: "fav93 only when the ask held 90c+ for the previous ten snapshots" },
  // Threshold grid (23 Oct): on SOL 5m the favourite only pays from 95c up (95c +$8, 97c +$12 over ~750 windows; 93c -$19).
  { name: "fav95", left: 0, cap: 0.995, size: 5, favAt: 0.95, added: "2026-10-23", idea: "favourite at 95c, for SOL where 93c does not pay" },
  // enrique's salvage idea (23 Oct): cheap10-first90, but at 120s left sell if our side's bid is 5c or less. Replay of 713
  // long shots: 244 sold, none of them went on to win, ~$0.90 of each $5 recovered (pooled -$8 -> +$189; BTC/SOL still negative).
  { name: "cheap10-salvage", left: 0, cap: 0.1, size: 5, first: 90, salvageAt: 120, salvageBid: 0.05, added: "2026-10-23", idea: "cheap10, but sell a dead one at 120s left to get ~18% back" },
  // enrique asked for more ideas (23 Oct 16:30 KST). Variations on the two things that have paid so far: the favourite
  // at a higher price, and the lead/hold filters, plus a few that bet against the crowd. Paper only.
  { name: "fav95-lead", left: 0, cap: 0.995, size: 5, favAt: 0.95, favFrom: 120, leadMin: 0, leadMax: 3, added: "2026-10-23", idea: "fav95 with the small-lead filter (0-3bp, 3 minutes or less left)" },
  { name: "fav95-hold", left: 0, cap: 0.995, size: 5, favAt: 0.95, holdRows: 10, holdAt: 0.9, added: "2026-10-23", idea: "fav95 only when the ask held 90c+ for the previous ten snapshots" },
  { name: "fav93-lead-hold", left: 0, cap: 0.995, size: 5, favAt: 0.93, favFrom: 120, leadMin: 0, leadMax: 3, holdRows: 10, holdAt: 0.9, added: "2026-10-23", idea: "fav93 with both filters at once: small lead and a held 90c+ ask" },
  { name: "fav97", left: 0, cap: 0.995, size: 5, favAt: 0.97, added: "2026-10-23", idea: "favourite at 97c: tiny payout, should win ~98%+" },
  { name: "fav93-late", left: 0, cap: 0.995, size: 5, favAt: 0.93, favFrom: 180, favTo: 300, added: "2026-10-23", idea: "fav93 only when 93c is first reached in the last 2 minutes" },
  { name: "fav93-last3", left: 0, cap: 0.96, size: 5, favAt: 0.93, favFrom: 240, strictCap: true, added: "2026-10-24", idea: "favourite at 93-96c, only in the last 3 minutes of a 15m window (last minute of a 5m): replay 20-24 Oct 98.8% vs 95.8% any time" },
  { name: "fav95-last3", left: 0, cap: 0.97, size: 5, favAt: 0.95, favFrom: 240, strictCap: true, added: "2026-10-24", idea: "favourite at 95-97c, only in the last 3 minutes of a 15m window (last minute of a 5m)" },
  { name: "fav97-last3", left: 0, cap: 0.995, size: 5, favAt: 0.97, favFrom: 240, added: "2026-10-24", idea: "favourite at 97c+, only in the last 3 minutes of a 15m window (last minute of a 5m)" },
  { name: "fav95-hold-last3", left: 0, cap: 0.97, size: 5, favAt: 0.95, favFrom: 240, strictCap: true, holdRows: 10, holdAt: 0.9, added: "2026-10-24", idea: "fav95-hold, but only in the last 3 minutes of a 15m window (last minute of a 5m)" },
  { name: "fav93-stop", left: 0, cap: 0.995, size: 5, favAt: 0.93, stopBid: 0.7, added: "2026-10-24", idea: "fav93, but sell back the moment our side's bid drops to 70c: trade a few 30c hits for the rare -93c loss (paper only: real rules do not sell)" },
  { name: "band80-tp95", left: 30, floor: 0.8, cap: 0.9, size: 5, tpBid: 0.95, added: "2026-10-24", idea: "band80-30, but sell as soon as our side's bid reaches 95c instead of holding to the close" },
  { name: "arb97", left: 0, cap: 0.995, size: 5, arbSum: 0.97, added: "2026-10-24", idea: "buy the same number of shares on both sides whenever the two asks add up to 97c or less: 3c+ a share whichever way it goes (the live book feed catches split-second prints the old 1s snapshots missed; many may not be fillable)" },
  { name: "prev-momentum", left: 0, cap: 0.6, size: 5, first: 30, prevDir: "same", added: "2026-10-24", idea: "in the first 30s buy the side the last window closed on, at 60c or less" },
  { name: "prev-reverse", left: 0, cap: 0.6, size: 5, first: 30, prevDir: "opposite", added: "2026-10-24", idea: "in the first 30s buy against the side the last window closed on, at 60c or less" },
  { name: "fav93-against", left: 0, cap: 0.995, size: 5, favAt: 0.93, leadMax: 0, added: "2026-10-23", idea: "fav93 only while Chainlink is still on the other side of open (the book leads the price)" },
  { name: "band90-30", left: 30, floor: 0.9, cap: 0.95, size: 5, added: "2026-10-23", idea: "projection side priced 90-95c with 30s left: band80-30 one notch surer" },
  { name: "band80-30-lead", left: 30, floor: 0.8, cap: 0.9, size: 5, leadMin: 0, leadMax: 3, added: "2026-10-23", idea: "band80-30 only with a small Chainlink lead (0-3bp) toward the side" },
  { name: "cheap10-lead", left: 0, cap: 0.1, size: 5, first: 90, leadMin: 2, added: "2026-10-23", idea: "cheap10, but only when Chainlink already moved 2bp+ toward the cheap side (price and book disagree)" },
  // enrique's "paper test it, why not" (23 Oct 16:42 KST): maker order, time of day, calm windows, cross-coin confirmation.
  { name: "fav93-rest", left: 0, cap: 0.995, size: 5, favAt: 0.93, rest: 0.01, added: "2026-10-23", idea: "fav93, but rest a bid 1c under the ask instead of taking it: no fee if it fills, skipped if it never does" },
  { name: "fav93-asia", left: 0, cap: 0.995, size: 5, favAt: 0.93, hoursUtc: [0, 8], added: "2026-10-23", idea: "fav93 only 09:00-17:00 KST (Asian hours)" },
  { name: "fav93-us", left: 0, cap: 0.995, size: 5, favAt: 0.93, hoursUtc: [13, 21], added: "2026-10-23", idea: "fav93 only 22:00-06:00 KST (US hours)" },
  { name: "fav93-calm", left: 0, cap: 0.995, size: 5, favAt: 0.93, maxMoveBp: 20, added: "2026-10-23", idea: "fav93 only when the price has moved under 20bp from open either way (skip wild windows)" },
  { name: "fav93-cross", left: 0, cap: 0.995, size: 5, favAt: 0.93, confirmCross: true, added: "2026-10-23", idea: "fav93 only when the other coin's book leans the same way (BTC checks ETH, every other coin checks BTC)" },
  { name: "band80-30-cross", left: 30, floor: 0.8, cap: 0.9, size: 5, confirmCross: true, added: "2026-10-23", idea: "band80-30 only when the other coin's book leans the same way" },
  // enrique (24 Oct 23:10 KST): "more paper strats, prioritize things that would fire every window". Rules that act on
  // (almost) every window: take the favourite late at whatever it costs, or the projected side in the final seconds.
  // favFrom is in 5m seconds and scales x3 on 15m, so "last 30s" means the last 90s of a 15m window.
  { name: "fav-last30", left: 0, cap: 0.995, size: 5, favAt: 0.5, favFrom: 270, added: "2026-10-24", idea: "every window: buy the favourite at whatever it costs with 30s left (90s on 15m); the baseline for all late rules" },
  { name: "fav-last15-98", left: 0, cap: 0.98, size: 5, favAt: 0.5, favFrom: 285, strictCap: true, added: "2026-10-24", idea: "every window: favourite with 15s left, but only if it still costs 98c or less (skip the 99c ones the fee kills)" },
  { name: "fav-last5", left: 0, cap: 0.995, size: 5, favAt: 0.5, favFrom: 295, added: "2026-10-24", idea: "every window: favourite in the final 5 seconds, any price: does near-certainty beat the fee?" },
  { name: "fav90-last60", left: 0, cap: 0.95, size: 5, favAt: 0.9, favFrom: 240, strictCap: true, added: "2026-10-24", idea: "favourite at 90-95c in the last minute (last 3 min on 15m): fav93-last3 one notch cheaper, more windows" },
  { name: "fav-half", left: 0, cap: 0.85, size: 5, favAt: 0.6, favFrom: 150, favTo: 170, added: "2026-10-24", idea: "halfway through a 5m window buy the favourite at 60-85c: lower odds, bigger payout, fires most windows (15m: blocked by the 3-minute gate)" },
  { name: "fav97-hold-last3", left: 0, cap: 0.995, size: 5, favAt: 0.97, favFrom: 240, holdRows: 10, holdAt: 0.9, added: "2026-10-24", idea: "fav97-last3 with the hold filter (90c+ on the ten snapshots before)" },
  { name: "fav-lead-last30", left: 0, cap: 0.995, size: 5, favAt: 0.5, favFrom: 270, leadMin: 3, added: "2026-10-24", idea: "favourite with 30s left only when Chainlink already leads 3bp+ the same way (price agrees with the book)" },
  { name: "fav95-lead-last30", left: 0, cap: 0.995, size: 5, favAt: 0.95, favFrom: 270, leadMin: 3, added: "2026-10-26", idea: "fav-lead-last30 with a 95c floor: favourite at 95c+ with 30s left (90s on 15m) and a 3bp+ Chainlink lead; replay of 349 BTC 15m windows 20-26 Oct: 92/92, the five lead-rule losses were all 68-93c favourites" },
  { name: "up15-first100", left: 0, cap: 0.17, size: 5, first: 100, onlySide: "UP", added: "2026-10-26", idea: "buy UP only, when it costs 17c or less in the first 100s (an early sharp drop): replay 23-26 Oct, 7 coins, UP at 8-17c early won 19% vs ~15% break-even (+$740 at $5 over 1,128 trades), while the DOWN mirror lost; fills at cheap asks are the known problem" },
  { name: "down15-first100", left: 0, cap: 0.17, size: 5, first: 100, onlySide: "DOWN", added: "2026-10-26", idea: "the DOWN mirror of up15-first100, kept as the control: it lost in the replay" },
  // 27 Oct replay of the cheap-UP family (23-26 Oct books, 7 coins, $5): the edge sits in the first minute, after a window that closed UP, and in KST 04-12 / 20-24.
  { name: "up20-first60", left: 0, cap: 0.2, size: 5, first: 60, onlySide: "UP", added: "2026-10-27", idea: "UP at 20c or less in the first 60s: replay n=808, 22.6% won, +$774 (+19%/trade), positive on all 7 coins" },
  { name: "up17-first60", left: 0, cap: 0.17, size: 5, first: 60, onlySide: "UP", added: "2026-10-27", idea: "up15-first100 cut to the first 60s: replay +$667, +23%/trade, 7/7 coins positive" },
  { name: "up17-first30", left: 0, cap: 0.17, size: 5, first: 30, onlySide: "UP", added: "2026-10-27", idea: "UP at 17c or less in the first 30s only: replay n=223, +48%/trade (small sample)" },
  { name: "up15-first60", left: 0, cap: 0.15, size: 5, first: 60, onlySide: "UP", added: "2026-10-27", idea: "UP at 15c or less in the first 60s: replay +$635, +30%/trade, 4 coins positive" },
  { name: "up7-first150", left: 0, cap: 0.07, size: 5, first: 150, onlySide: "UP", added: "2026-10-27", idea: "deep long shot: UP at 7c or less in the first 150s: replay n=840, 7.4% won, +$530" },
  { name: "up20-first60-afterup", left: 0, cap: 0.2, size: 5, first: 60, onlySide: "UP", afterPrev: "UP", added: "2026-10-27", idea: "up20-first60 only when the previous window closed UP: replay n=388, +$654 (+34%/trade) vs +7%/trade after a DOWN close" },
  { name: "up17-first100-afterup", left: 0, cap: 0.17, size: 5, first: 100, onlySide: "UP", afterPrev: "UP", added: "2026-10-27", idea: "the live rule gated on a previous UP close: replay +$617 vs +$98 after a DOWN close" },
  { name: "up20-first60-night", left: 0, cap: 0.2, size: 5, first: 60, onlySide: "UP", hoursUtc: [19, 3], added: "2026-10-27", idea: "up20-first60 only 04:00-12:00 KST: replay +12..+83%/trade there, negative 12:00-04:00 KST" },
  { name: "up20-first60-eve", left: 0, cap: 0.2, size: 5, first: 60, onlySide: "UP", hoursUtc: [11, 15], added: "2026-10-27", idea: "up20-first60 only 20:00-24:00 KST: replay +60-70%/trade" },
  { name: "up13-first450", left: 0, cap: 0.13, size: 5, first: 450, onlySide: "UP", added: "2026-10-27", idea: "15m version: UP at 13c or less in the first 450s: replay n=129, 18.6% won, +$310 (+48%/trade) on BTC/ETH 15m" },
  { name: "up25-first300", left: 0, cap: 0.25, size: 5, first: 300, onlySide: "UP", added: "2026-10-27", idea: "15m version: UP at 25c or less in the first 300s: replay n=205, 31.7% won, +$303" },
  { name: "late10-any", left: 10, cap: 0.995, size: 5, added: "2026-10-24", idea: "every window: the projected side with 10s left at any price" },
  { name: "late5-98", left: 5, cap: 0.98, size: 5, added: "2026-10-24", idea: "projected side with 5s left, only if it costs 98c or less" },
];

export type PaperTrade = {
  variant: string;
  window: number;
  t: number;
  left: number;
  side: "UP" | "DOWN";
  ask: number;
  shares: number;
  cost: number;
  fee: number;
  projected: number;
  openAverage: number;
  resolvedUp: boolean | null;
  won: boolean | null;
  pnl: number | null;
  /** Set when the salvage rule sold the shares before the close: the average price received. */
  soldAt?: number;
  /** Arb rows: shares held on the other side (both sides were bought); the winner pays out whichever side resolves. */
  otherShares?: number;
};

/** How each window closed (the book's favourite at its last snapshot with both asks), per series and window start, for the prevDir and afterPrev rules.
 *  Keyed by window rather than "the last one seen" because rows of two windows can interleave while the recorder tracks the next market. */
const closeBook = new Map<string, Map<number, { left: number; up: boolean | null }>>();
function noteClose(prefix: string, row: BookRow, windowSec: number) {
  if (row.upAsk == null || row.downAsk == null) return;
  let m = closeBook.get(prefix);
  if (!m) closeBook.set(prefix, (m = new Map()));
  const cur = m.get(row.window);
  if (cur && cur.left < row.left) return;
  m.set(row.window, { left: row.left, up: row.upAsk > row.downAsk ? true : row.downAsk > row.upAsk ? false : null });
  for (const w of m.keys()) if (w < row.window - 12 * windowSec) m.delete(w);
}
/** The previous window's close for this series, or null when it was not seen (recorder restart, gap). */
function prevClose(prefix: string, window: number, windowSec: number): boolean | null {
  return closeBook.get(prefix)?.get(window - windowSec)?.up ?? null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Where a paper trader runs: file-name prefix for the series, its settlement feed and window length. */
export type PaperHome = { prefix?: string; feed?: Feed; windowSec?: number };

/** Each series' latest book lean, for the cross-coin rule. Keyed by file prefix ("" is BTC 5m). */
const latestLean = new Map<string, { window: number; up: boolean | null }>();
function partnerOf(prefix: string) {
  return prefix === "" ? "eth5m-" : "";
}

export class PaperTrader {
  readonly v: Variant;
  private readonly feed: Feed;
  private readonly windowSec: number;
  private readonly prefix: string;
  /** A resting maker bid waiting for the ask to come down (the `rest` rule). */
  private resting: { window: number; up: boolean; price: number } | null = null;
  /** File names: the base variant keeps the original ones, so its history carries on. */
  private readonly kind: string;
  private readonly openFile: string;
  private readonly totalsFile: string;
  open: PaperTrade[];
  /** Running totals for the status page, rebuilt from the totals file at start. */
  trades = 0;
  won = 0;
  net = 0;
  /** Windows where the rule wanted to buy but nothing was on offer under the cap. */
  noAsk = 0;
  private lastNoAskWindow = 0;
  /** Called right after a paper trade is taken (the live trader mirrors one variant). */
  onTrade: ((trade: PaperTrade) => void) | null = null;

  constructor(v: Variant, home: PaperHome = {}) {
    this.v = v;
    this.feed = home.feed ?? chainlink;
    this.windowSec = home.windowSec ?? WINDOW_SEC;
    const prefix = home.prefix ?? "";
    this.prefix = prefix;
    const suffix = v.name === "base" ? "" : `-${v.name}`;
    this.kind = `${prefix}paper${suffix}`;
    this.openFile = `${prefix}paper${suffix}-open.json`;
    this.totalsFile = `${prefix}paper${suffix}-totals.json`;
    this.open = loadJson<PaperTrade[]>(this.openFile, []);
    // Rows from other variants are skipped: one build wrote every variant into the base files.
    for (const t of loadJson<PaperTrade[]>(this.totalsFile, [])) if ((t.variant ?? "base") === v.name) this.count(t);
  }

  /** Per-UTC-day totals, newest first in status(). */
  private byDay = new Map<string, { day: string; trades: number; won: number; net: number; first: number }>();

  private count(t: PaperTrade) {
    if (t.pnl == null) return;
    this.trades += 1;
    if (t.won) this.won += 1;
    this.net += t.pnl;
    const day = kstDay(t.window * 1000);
    let d = this.byDay.get(day);
    if (!d) this.byDay.set(day, (d = { day, trades: 0, won: 0, net: 0, first: t.window }));
    d.first = Math.min(d.first, t.window);
    d.trades += 1;
    if (t.won) d.won += 1;
    d.net = Math.round((d.net + t.pnl) * 100) / 100;
  }

  /** Called on every book snapshot. */
  /** Previous second's best asks, for the noFall rule. */
  private prevAsk: { window: number; up: number | null; down: number | null } | null = null;
  /** Recent best asks of the window (newest last), for the holdRows rule. */
  private history: { window: number; rows: { up: number | null; down: number | null }[] } = { window: 0, rows: [] };
  /** Windows where the favourite rule already saw its first hit (taken or filtered out); it never fires twice. */
  private favSeen = 0;

  consider(row: BookRow) {
    const { left: LEFT, cap: CAP, size: SIZE } = this.v;
    if (discarded().has(this.v.name)) return;
    if (this.v.salvageAt != null || this.v.stopBid != null || this.v.tpBid != null) this.considerExit(row);
    const prev = this.prevAsk?.window === row.window ? this.prevAsk : null;
    noteClose(this.prefix, row, this.windowSec);
    this.prevAsk = { window: row.window, up: row.upAsk, down: row.downAsk };
    if (row.upAsk != null && row.downAsk != null) latestLean.set(this.prefix, { window: row.window, up: row.upAsk > row.downAsk ? true : row.downAsk > row.upAsk ? false : null });
    if (this.resting && (this.resting.window !== row.window || row.left < 1)) this.resting = null;
    if (this.resting) {
      const best = (this.resting.up ? row.upAsks : row.downAsks)[0]?.[0];
      if (best != null && best <= this.resting.price + 1e-9) {
        const r = this.resting;
        this.resting = null;
        this.book(row, r.up, r.price, SIZE / r.price, SIZE, 0);
      }
      return;
    }
    if (!this.gateOk(row)) return;
    if (this.v.arbSum != null) return this.considerArb(row);
    if (this.v.prevDir != null) return this.considerPrev(row);
    if (this.v.first != null) return this.considerEarly(row);
    if (this.v.favAt != null) return this.considerFav(row);
    if (row.left > LEFT || row.left < 1 || !row.chainlink) return;
    if (this.open.some((t) => t.window === row.window)) return;
    const openMs = row.window * 1000;
    const closeMs = openMs + this.windowSec * 1000;
    const before = this.feed.between(openMs - 60000, openMs).map((t) => t.price);
    const known = this.feed.between(closeMs - 60000, row.t).map((t) => t.price);
    const openAverage = mean(before);
    const knownAverage = mean(known);
    if (openAverage == null || knownAverage == null || before.length < 20) return;
    const frac = Math.min(1, (row.t - (closeMs - 60000)) / 60000);
    const projected = knownAverage * frac + row.chainlink * (1 - frac);
    const up = projected >= openAverage;
    if (!this.leadOk(row, up) || !this.crossOk(row, up)) return;
    const levels = up ? row.upAsks : row.downAsks;
    const FLOOR = this.v.floor ?? 0;
    if (this.v.noFall) {
      const before = up ? prev?.up : prev?.down;
      if (before != null && levels.length && levels[0][0] <= before - 0.01 + 1e-9) return;
    }
    if (this.v.prevFloor != null) {
      const before = up ? prev?.up : prev?.down;
      if (before == null || before < this.v.prevFloor - 1e-9) return;
    }
    if (!levels.length || levels[0][0] > CAP || levels[0][0] < FLOOR) {
      if (this.lastNoAskWindow !== row.window) {
        this.lastNoAskWindow = row.window;
        this.noAsk += 1;
      }
      return;
    }
    let budget = SIZE;
    let shares = 0;
    let cost = 0;
    let fee = 0;
    for (const [price, qty] of levels) {
      if (price > CAP || budget <= 0) break;
      const take = Math.min(qty, budget / price);
      shares += take;
      cost += take * price;
      fee += take * 0.07 * price * (1 - price);
      budget -= take * price;
    }
    if (shares <= 0) return;
    const trade: PaperTrade = {
      variant: this.v.name,
      window: row.window,
      t: row.t,
      left: row.left,
      side: up ? "UP" : "DOWN",
      ask: levels[0][0],
      shares,
      cost,
      fee,
      projected,
      openAverage,
      resolvedUp: null,
      won: null,
      pnl: null,
    };
    this.open.push(trade);
    saveJson(this.openFile, this.open);
    this.onTrade?.(trade);
    console.log(`paper ${this.v.name}: ${trade.side} at ${Math.round(trade.ask * 100)}c with ${trade.left}s left, ${shares.toFixed(1)} shares for $${cost.toFixed(2)} (projected ${projected.toFixed(2)} vs ${openAverage.toFixed(2)})`);
  }

  /** Called when a window's resolution is known. */
  settle(window: number, resolvedUp: boolean) {
    const trade = this.open.find((t) => t.window === window);
    if (!trade) return;
    trade.resolvedUp = resolvedUp;
    trade.won = (trade.side === "UP") === resolvedUp;
    trade.pnl = (trade.won ? trade.shares : (trade.otherShares ?? 0)) - trade.cost - trade.fee;
    if (trade.otherShares != null) trade.won = trade.pnl > 0;
    this.open = this.open.filter((t) => t !== trade);
    this.count(trade);
    append(this.kind, trade, window * 1000);
    const totals = loadJson<PaperTrade[]>(this.totalsFile, []);
    totals.push(trade);
    saveJson(this.totalsFile, totals);
    saveJson(this.openFile, this.open);
    console.log(`paper ${this.v.name}: ${trade.side} ${trade.won ? "won" : "lost"} ${trade.pnl >= 0 ? "+" : "-"}$${Math.abs(trade.pnl).toFixed(2)}; running ${this.won}/${this.trades}, net ${this.net >= 0 ? "+" : "-"}$${Math.abs(this.net).toFixed(2)}`);
  }

  /** Exits before the close: salvage (dead trade late in the window), stop (bid fell to stopBid) and take profit (bid reached tpBid), all sold into the bids. */
  private considerExit(row: BookRow) {
    const trade = this.open.find((t) => t.window === row.window);
    if (!trade || row.left < 1 || trade.otherShares != null) return;
    const bids = trade.side === "UP" ? row.upBids : row.downBids;
    const best = bids[0]?.[0];
    if (best == null) return;
    const salvage = this.v.salvageAt != null && row.left <= this.v.salvageAt && best <= (this.v.salvageBid ?? 0);
    const stop = this.v.stopBid != null && best <= this.v.stopBid + 1e-9;
    const tp = this.v.tpBid != null && best >= this.v.tpBid - 1e-9;
    if (!salvage && !stop && !tp) return;
    let left = trade.shares;
    let got = 0;
    for (const [price, qty] of [...bids].sort((a, b) => b[0] - a[0])) {
      const take = Math.min(left, qty);
      got += take * price - 0.07 * take * price * (1 - price);
      left -= take;
      if (left <= 1e-9) break;
    }
    if (left > 1e-9) return; // not enough bids to get out; hold
    trade.soldAt = Math.round((got / trade.shares) * 1000) / 1000;
    trade.pnl = got - trade.cost - trade.fee;
    trade.won = trade.pnl > 0;
    this.open = this.open.filter((t) => t !== trade);
    this.count(trade);
    append(this.kind, trade, trade.window * 1000);
    const totals = loadJson<PaperTrade[]>(this.totalsFile, []);
    totals.push(trade);
    saveJson(this.totalsFile, totals);
    saveJson(this.openFile, this.open);
    console.log(`paper ${this.v.name}: sold ${trade.side} at ${Math.round(best * 100)}c with ${row.left}s left, ${trade.pnl >= 0 ? "+" : "-"}$${Math.abs(trade.pnl).toFixed(2)}; running ${this.won}/${this.trades}, net ${this.net >= 0 ? "+" : "-"}$${Math.abs(this.net).toFixed(2)}`);
  }

  /** The `first` rule: in the first N seconds, buy the cheaper side if its best ask is at or under the cap. */
  /** The Chainlink move since open, in basis points toward the chosen side, must sit inside [leadMin, leadMax). */
  private leadOk(row: BookRow, up: boolean) {
    if (this.v.leadMin == null && this.v.leadMax == null) return true;
    if (row.chainlink == null || row.open == null) return false;
    const lead = ((row.chainlink - row.open) / row.open) * 1e4 * (up ? 1 : -1);
    return lead >= (this.v.leadMin ?? -Infinity) && lead < (this.v.leadMax ?? Infinity);
  }

  /** Time-of-day, volatility and cross-coin gates shared by every rule family. */
  private gateOk(row: BookRow) {
    if (this.v.hoursUtc) {
      const h = new Date(row.t).getUTCHours();
      const [from, to] = this.v.hoursUtc;
      if (from <= to ? h < from || h >= to : h < from && h >= to) return false;
    }
    if (this.v.maxMoveBp != null) {
      if (row.chainlink == null || row.open == null) return false;
      if (Math.abs((row.chainlink - row.open) / row.open) * 1e4 > this.v.maxMoveBp) return false;
    }
    return true;
  }

  private crossOk(row: BookRow, up: boolean) {
    if (!this.v.confirmCross) return true;
    const other = latestLean.get(partnerOf(this.prefix));
    return !!other && other.window === row.window && other.up === up;
  }

  /** Record a filled paper trade. */
  private book(row: BookRow, up: boolean, ask: number, shares: number, cost: number, fee: number) {
    const trade: PaperTrade = {
      variant: this.v.name,
      window: row.window,
      t: row.t,
      left: row.left,
      side: up ? "UP" : "DOWN",
      ask,
      shares,
      cost,
      fee,
      projected: row.chainlink ?? 0,
      openAverage: row.open ?? 0,
      resolvedUp: null,
      won: null,
      pnl: null,
    };
    this.open.push(trade);
    saveJson(this.openFile, this.open);
    console.log(`paper ${this.v.name}: ${trade.side} ${shares.toFixed(1)} shares at ${Math.round(ask * 100)}c, ${this.windowSec - row.left}s into the window${fee === 0 ? " (resting bid filled)" : ""}`);
    this.onTrade?.(trade);
  }

  /** The `arbSum` rule: both asks together under $1 means a sure payout; buy both sides, the winner pays. Once per window. */
  private considerArb(row: BookRow) {
    const { size: SIZE } = this.v;
    const sum = this.v.arbSum ?? 0;
    if (row.left < 1 || this.open.some((t) => t.window === row.window)) return;
    const upBest = row.upAsks[0]?.[0];
    const downBest = row.downAsks[0]?.[0];
    if (upBest == null || downBest == null || upBest + downBest > sum + 1e-9) return;
    // A real arbitrage holds the SAME number of shares on both sides, so the payout is fixed whichever side wins:
    // shares x $1 back for shares x (upAsk + downAsk) paid. Spending $5 on each side instead buys more of the
    // cheaper side and only pays off when that side wins, which is a bet, not an arb.
    const upQty = row.upAsks[0]?.[1] ?? 0;
    const downQty = row.downAsks[0]?.[1] ?? 0;
    const shares = Math.min(upQty, downQty, (2 * SIZE) / (upBest + downBest));
    if (shares <= 0) return;
    const legOf = (price: number) => ({ shares, cost: shares * price, fee: shares * 0.07 * price * (1 - price) });
    const up = legOf(upBest);
    const down = legOf(downBest);
    const favUp = upBest >= downBest;
    const trade: PaperTrade = {
      variant: this.v.name,
      window: row.window,
      t: row.t,
      left: row.left,
      side: favUp ? "UP" : "DOWN",
      ask: favUp ? upBest : downBest,
      shares: favUp ? up.shares : down.shares,
      otherShares: favUp ? down.shares : up.shares,
      cost: up.cost + down.cost,
      fee: up.fee + down.fee,
      projected: row.chainlink ?? 0,
      openAverage: row.open ?? 0,
      resolvedUp: null,
      won: null,
      pnl: null,
    };
    this.open.push(trade);
    saveJson(this.openFile, this.open);
    console.log(`paper ${this.v.name}: both sides at ${Math.round(upBest * 100)}c + ${Math.round(downBest * 100)}c with ${row.left}s left, $${trade.cost.toFixed(2)} for ${Math.min(up.shares, down.shares).toFixed(1)}+ shares`);
    this.onTrade?.(trade);
  }

  /** The `prevDir` rule: early in the window, follow (or fade) the way the last window closed. */
  private considerPrev(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    const elapsed = this.windowSec - row.left;
    if (elapsed < 0 || elapsed > (this.v.first ?? 0) || row.left < 1) return;
    if (this.open.some((t) => t.window === row.window)) return;
    const last = prevClose(this.prefix, row.window, this.windowSec);
    if (last == null) return;
    const up = this.v.prevDir === "same" ? last : !last;
    const levels = up ? row.upAsks : row.downAsks;
    const ask = levels[0]?.[0];
    if (ask == null || ask > CAP) return;
    let budget = SIZE;
    let shares = 0;
    let cost = 0;
    let fee = 0;
    for (const [price, qty] of levels) {
      if (price > CAP || budget <= 0) break;
      const take = Math.min(qty, budget / price);
      shares += take;
      cost += take * price;
      fee += take * 0.07 * price * (1 - price);
      budget -= take * price;
    }
    if (shares <= 0) return;
    const trade: PaperTrade = {
      variant: this.v.name,
      window: row.window,
      t: row.t,
      left: row.left,
      side: up ? "UP" : "DOWN",
      ask,
      shares,
      cost,
      fee,
      projected: row.chainlink ?? 0,
      openAverage: row.open ?? 0,
      resolvedUp: null,
      won: null,
      pnl: null,
    };
    this.open.push(trade);
    saveJson(this.openFile, this.open);
    console.log(`paper ${this.v.name}: ${trade.side} ${shares.toFixed(1)} shares at ${Math.round(ask * 100)}c, ${elapsed}s in (last window closed ${last ? "UP" : "DOWN"})`);
    this.onTrade?.(trade);
  }

  private considerEarly(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    const elapsed = this.windowSec - row.left;
    if (elapsed < 0 || elapsed > (this.v.first ?? 0) || row.left < 1) return;
    if (this.open.some((t) => t.window === row.window)) return;
    if (!this.gateOk(row)) return;
    if (this.v.afterPrev) {
      const last = prevClose(this.prefix, row.window, this.windowSec);
      if (last == null || last !== (this.v.afterPrev === "UP")) return;
    }
    const upBest = row.upAsks[0]?.[0];
    const downBest = row.downAsks[0]?.[0];
    const candidates = [upBest != null && upBest <= CAP && this.v.onlySide !== "DOWN" ? { up: true, ask: upBest } : null, downBest != null && downBest <= CAP && this.v.onlySide !== "UP" ? { up: false, ask: downBest } : null].filter((c): c is { up: boolean; ask: number } => c != null);
    if (!candidates.length) return;
    const pick = candidates.sort((a, b) => a.ask - b.ask)[0];
    if (!this.leadOk(row, pick.up)) return;
    const levels = pick.up ? row.upAsks : row.downAsks;
    let budget = SIZE;
    let shares = 0;
    let cost = 0;
    let fee = 0;
    for (const [price, qty] of levels) {
      if (price > CAP || budget <= 0) break;
      const take = Math.min(qty, budget / price);
      shares += take;
      cost += take * price;
      fee += take * 0.07 * price * (1 - price);
      budget -= take * price;
    }
    if (shares <= 0) return;
    const trade: PaperTrade = {
      variant: this.v.name,
      window: row.window,
      t: row.t,
      left: row.left,
      side: pick.up ? "UP" : "DOWN",
      ask: pick.ask,
      shares,
      cost,
      fee,
      projected: row.chainlink ?? 0,
      openAverage: row.open ?? 0,
      resolvedUp: null,
      won: null,
      pnl: null,
    };
    this.open.push(trade);
    saveJson(this.openFile, this.open);
    console.log(`paper ${this.v.name}: ${trade.side} ${shares.toFixed(1)} shares at ${Math.round(pick.ask * 100)}c, ${elapsed}s into the window`);
    this.onTrade?.(trade);
  }

  /** The `favAt` rule: the first time the favourite's best ask is at or above favAt, buy it (up to cap). */
  private considerFav(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    const favAt = this.v.favAt ?? 1;
    if (row.left < 1) return;
    const scale = this.windowSec / 300;
    const elapsed = this.windowSec - row.left;
    if (this.v.favFrom != null && elapsed < this.v.favFrom * scale) return;
    if (this.v.favTo != null && elapsed > this.v.favTo * scale) return;
    if (this.open.some((t) => t.window === row.window)) return;
    const upBest = row.upAsks[0]?.[0];
    const downBest = row.downAsks[0]?.[0];
    if (this.history.window !== row.window) this.history = { window: row.window, rows: [] };
    const before = this.history.rows.slice(-Math.max(this.v.holdRows ?? 0, 1));
    this.history.rows.push({ up: upBest ?? null, down: downBest ?? null });
    if (this.history.rows.length > 30) this.history.rows.shift();
    if (upBest == null || downBest == null) return;
    // 15-minute windows: no favourite rule enters with more than 3 minutes left (enrique, 24 Oct 2026). Replay of 340
    // BTC 15m windows: a 93c favourite first seen with 9+ minutes left won 90%, under 3 minutes 99-100%.
    if (this.windowSec >= 900 && row.left > FAV_MAX_LEFT_15M) return;
    if (this.favSeen === row.window) return;
    const up = upBest >= downBest;
    const ask = up ? upBest : downBest;
    if (ask < favAt - 1e-9) return;
    if (ask > CAP) {
      if (this.v.strictCap) this.favSeen = row.window;
      return;
    }
    // The filters judge the first hit only: a window that fails them is left alone, like the replay they came from.
    this.favSeen = row.window;
    if (!this.leadOk(row, up)) return;
    if (!this.crossOk(row, up)) return;
    if (this.v.holdRows != null) {
      if (before.length < this.v.holdRows) return;
      if (!before.every((r) => (up ? r.up : r.down) != null && (up ? r.up : r.down)! >= (this.v.holdAt ?? 0) - 1e-9)) return;
    }
    if (this.v.rest != null) {
      this.resting = { window: row.window, up, price: Math.round((ask - this.v.rest) * 100) / 100 };
      return;
    }
    const levels = up ? row.upAsks : row.downAsks;
    let budget = SIZE;
    let shares = 0;
    let cost = 0;
    let fee = 0;
    for (const [price, qty] of levels) {
      if (price > CAP || budget <= 0) break;
      const take = Math.min(qty, budget / price);
      shares += take;
      cost += take * price;
      fee += take * 0.07 * price * (1 - price);
      budget -= take * price;
    }
    if (shares <= 0) return;
    const trade: PaperTrade = {
      variant: this.v.name,
      window: row.window,
      t: row.t,
      left: row.left,
      side: up ? "UP" : "DOWN",
      ask,
      shares,
      cost,
      fee,
      projected: row.chainlink ?? 0,
      openAverage: row.open ?? 0,
      resolvedUp: null,
      won: null,
      pnl: null,
    };
    this.open.push(trade);
    saveJson(this.openFile, this.open);
    console.log(`paper ${this.v.name}: ${trade.side} ${shares.toFixed(1)} shares at ${Math.round(ask * 100)}c, ${this.windowSec - row.left}s into the window`);
    this.onTrade?.(trade);
  }

  /** Drop open paper trades for windows that never resolved (the recorder gave up on them). */
  abandon(window: number) {
    const before = this.open.length;
    this.open = this.open.filter((t) => t.window !== window);
    if (this.open.length !== before) saveJson(this.openFile, this.open);
  }

  status() {
    const { left: LEFT, cap: CAP, size: SIZE } = this.v;
    return { name: this.v.name, size: SIZE, added: this.v.added ?? null, idea: this.v.idea ?? null, discarded: discarded().has(this.v.name), rule: this.v.arbSum != null ? `both sides whenever the asks add up to ${Math.round(this.v.arbSum * 100)}c or less, $${SIZE} each` : this.v.prevDir != null ? `first ${this.v.first}s, ${this.v.prevDir === "same" ? "with" : "against"} the last close, ask <= ${Math.round(CAP * 100)}c, $${SIZE}` : this.v.favAt != null ? `favourite when its ask reaches ${Math.round(this.v.favAt * 100)}c, ${this.v.favFrom != null ? (this.v.favTo != null ? `${this.v.favFrom}-${this.v.favTo}s in` : `from ${this.v.favFrom}s in`) : "any time"}, $${SIZE}` : this.v.first != null ? `first ${this.v.first}s, either side <= ${Math.round(CAP * 100)}c, $${SIZE}${this.v.salvageAt != null ? `, sell at ${this.v.salvageAt}s left if bid <= ${Math.round((this.v.salvageBid ?? 0) * 100)}c` : ""}` : `<=${LEFT}s, ask ${this.v.floor ? Math.round(this.v.floor * 100) + "c to " : "<= "}${Math.round(CAP * 100)}c${this.v.noFall ? ", not falling" : ""}, $${SIZE}`, trades: this.trades, won: this.won, net: Math.round(this.net * 100) / 100, open: this.open.length, noAsk: this.noAsk, days: [...this.byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)) };
  }
}
