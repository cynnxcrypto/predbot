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
  /** For favAt: a sliding threshold, [secondsIntoWindow, favAt] steps in ascending order (5-minute seconds, scaled for longer windows); the last step reached sets the threshold, favAt applies before the first. */
  favSchedule?: [number, number][];
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
  /** Only trade when the Chainlink price is at least this many bps away from the window's open (the mirror of maxMoveBp). */
  minMoveBp?: number;
  /** Fresh-move rule: buy the side the Chainlink price just moved toward, when it moved at least `jumpBp` bps within the last `jumpSec` seconds (default 15) and that side's ask rose less than 1c meanwhile; ask at or under `cap`, one trade per window, not in the last 30 s. */
  jumpBp?: number;
  jumpSec?: number;
  /** Jump/bounce rules: only with at least this many seconds left (default 30). */
  jumpMinLeft?: number;
  /** Gate: only trade when the two best asks sum to at most this (a tight book; 1.02 = 2c overround). Wide books are the makers' uncertainty premium and the cheap side pays it. */
  maxOverround?: number;
  /** Pre-open rule: the Chainlink price moved at least this many bps over the 60 s before the window opened; buy the side it moved toward (per onlySide) at or under `cap`, only in the first 60 s, one trade per window. */
  preOpenBp?: number;
  /** Fade rule: the Chainlink price moved at least this many bps in `jumpSec` seconds; buy the side it moved AGAINST at or under `cap` (the no-Binance control for the feed-lead rules). */
  fadeBp?: number;
  /** Bounce rule: buy UP (or DOWN, per onlySide) when the Chainlink price has come back at least this many bps from the window's low (high for DOWN), ask at or under `cap`; no ask condition. */
  bounceBp?: number;
  /** Feed-lead rule: buy the side Binance is ahead of Chainlink on, when (Binance - Chainlink) in bps, minus its rolling median over the last ~10 minutes, is at least this much; ask at or under `cap`, one trade per window, only with `jumpMinLeft` seconds left (default 120). */
  feedLeadBp?: number;
  /** Feed-lead rule: also require Coinbase to lead Chainlink by `feedLeadBp` the same way (two independent exchanges agreeing). */
  feedBoth?: boolean;
  /** Adaptive lead threshold: the Binance lead must also exceed this percentile (e.g. 98) of the absolute lead over the stored ~600 gap samples, so the bar scales with each coin's own feed noise (BTC ~2.8 bps at p99, DOGE ~5). Combined with feedLeadBp as a floor. */
  feedLeadPct?: number;
  /** Freshness gate for the feed rules: the lead must have risen (toward the side bought) by at least this many bps since the row 1-3 s earlier, i.e. Binance just jumped; a lead that crept up over several seconds is skipped. */
  leadJumpBp?: number;
  /** Coinbase witness with its own bar: the Coinbase lead (bps over its usual gap) must agree by at least this much (feedBoth uses the Binance bar for both). */
  feedCbBp?: number;
  /** Book-depth veto for the feed rules: skip when the shares offered on our side's three best asks outnumber the shares bid on its three best bids (more sellers than buyers of that side). */
  bidOverAsk?: boolean;
  /** Feed-lead rule: book the paper fill as if we paid this many cents over the ask (every ask level shifted up, still capped at `cap`), to price a slipped FAK order. */
  payUpC?: number;
  /** Feed-lead rule: Chainlink must sit this many bps on the far side of the open from the side we buy ([min, max): for UP, open minus Chainlink in bps). */
  clOpenBp?: [number, number];
  /** Cross-coin rule: at least `crossLeadCoins` OTHER 5m series (default 1) have Binance ahead of Chainlink by this many bps (over their usual gaps) within the last 3 s; buy that side here at or under `cap`. With `feedLeadBp` too, this series' own lead must also pass. */
  crossLeadBp?: number;
  crossLeadCoins?: number;
  /** Binance burst rule: the Binance price moved at least this many bps over the last `binMoveSec` seconds (default 2); buy that side at or under `cap`, one trade per window, only with `jumpMinLeft` seconds left (default 120). No Chainlink, no median, no warm-up. */
  binMoveBp?: number;
  binMoveSec?: number;
  /** Feed-lead rule, late variant: only with at most this many seconds left (pair with a small jumpMinLeft), and `minAsk`: the side's ask must be at least this (a favourite or mid price instead of the cheap side). */
  feedMaxLeft?: number;
  minAsk?: number;
  /** Feed-lead rule: the lead must have held at or above `feedLeadBp` continuously for this many seconds before entering (a sustained lead, not a one-print blip). */
  leadHoldSec?: number;
  /** Flat-window rule (from an X post enrique shared, 28 Oct 2026): at about 2 minutes left (115-125 s), if Chainlink is within this many bps of the open, buy the CHEAPER side if it asks between `minAsk` and `cap`; one trade per window. */
  flatBp?: number;
  /** Edge-follow gate: trade only while the last `trailN` closed paper trades of variant `trailOf` (default: this variant), across every series, net more than `trailMin` dollars (default 0). Point trailOf at an ungated sibling, or the gated rule can never restart once it stops. */
  trailN?: number;
  /** Self-halt: after this many straight losses on this series, skip trades for `selfHaltMin` minutes (default 30), like the real haltAfterLosses stop; measures what the stop costs. */
  selfHaltLosses?: number;
  /** Gate: only when Binance and Coinbase disagree, i.e. |Binance-Coinbase spread minus its usual level| is at or above this percentile of the stored samples (a stress gauge). */
  xchgDisagreePct?: number;
  selfHaltMin?: number;
  /** Only run on series whose window is at least this long in seconds (900 = the 15-minute markets only). */
  minWindowSec?: number;
  trailOf?: string;
  trailMin?: number;
  /** For `first` rules: only trade when the mean Chainlink range (high minus low, bps) of the previous 6 windows is at least this. */
  prevRangeBp?: number;
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
  { name: "jump5-fresh", left: 0, cap: 0.6, size: 5, jumpBp: 5, added: "2026-10-27", idea: "buy the side the price just moved toward: 5+ bps within 15s, that side's ask not yet up, ask 60c or less, 30s+ left: replay 23-27 Oct n=657, 31.7% won at avg 28c, +$459 (4 of 5 days positive, UP side carried it)" },
  { name: "jump8-fresh", left: 0, cap: 0.6, size: 5, jumpBp: 8, added: "2026-10-27", idea: "same with an 8+ bps move: replay n=141, 35.5% won, +$511 (small sample, 4 of 5 days positive)" },
  { name: "jump5-up20", left: 0, cap: 0.2, size: 5, jumpBp: 5, jumpSec: 10, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-27", idea: "cheap UP that just started bouncing: price up 5+ bps within 10s, UP ask 20c or less and not yet up, 120s+ left: replay 23-27 Oct (1s books, 7 coins) n=250, 26.4% won at avg 12c, +$1,810, positive all 5 days and 7/7 coins; the DOWN mirror lost -$573" },
  { name: "jump4-up20-5s", left: 0, cap: 0.2, size: 5, jumpBp: 4, jumpSec: 5, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-27", idea: "faster version: 4+ bps within 5s, UP 20c or less, 120s+ left: replay n=345, 22.3% won, +$1,664, 5/5 days, 7/7 coins" },
  { name: "jump6-up20", left: 0, cap: 0.2, size: 5, jumpBp: 6, jumpSec: 10, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-27", idea: "stricter: 6+ bps within 10s: replay n=164, 31.7% won, +$1,652 (+$10/trade), 5/5 days" },
  { name: "bounce8-up20", left: 0, cap: 0.2, size: 5, bounceBp: 8, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-27", idea: "UP 20c or less once the price has come back 8+ bps from the window's low, 120s+ left (no ask condition): replay n=424, 23.6% won, +$1,292, 5/5 days, 6/7 coins" },
  { name: "feed3-up20", left: 0, cap: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-27", idea: "Binance is 3+ bps above Chainlink (against the usual gap) and UP still asks 20c or less, 120s+ left: replay 25-27 Oct (1s books, 6 coins) n=336, 23% won, +$1,649 (+$4.91/trade); the same entry without the Binance lead loses -$0.58/trade; 25 Oct -$128, 26-27 Oct +$1,777" },
  { name: "feed2-up20", left: 0, cap: 0.2, size: 5, feedLeadBp: 2, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-27", idea: "looser: Binance 2+ bps ahead: replay n=610, 20% won, +$1,953 (+$3.20/trade), fires about twice as often" },
  { name: "feed4-up30", left: 0, cap: 0.3, size: 5, feedLeadBp: 4, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-27", idea: "stricter lead, higher cap: Binance 4+ bps ahead, UP 30c or less: replay n=258, 31% won, +$1,432 (+$5.55/trade)" },
  { name: "feed2x-up20", left: 0, cap: 0.2, size: 5, feedLeadBp: 3, feedBoth: true, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-28", idea: "two exchanges agree: Binance AND Coinbase each 3+ bps above Chainlink (over their usual gaps), UP 20c or less, 120s+ left: replay 25-27 Oct (1s books, 6 coins) n=189, 29% won, +$1,461 (+$7.73/trade, vs +$4.91 for Binance alone); positive on all 6 coins. The DOWN mirror of every feed rule loses (-$0.70 to -$1.33/trade), so UP only" },
  { name: "feed3-up20-night", left: 0, cap: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", hoursUtc: [11, 3], added: "2026-10-28", idea: "feed3-up20 only 20:00-12:00 KST: replay 25-27 Oct (1s books, 6 coins) n=250, 27% won, +$1,626 (+$6.50/trade); the 12:00-20:00 KST half n=86 made +$23 (+$0.27/trade, two of three days negative)" },
  { name: "feed2-up20-night", left: 0, cap: 0.2, size: 5, feedLeadBp: 2, jumpMinLeft: 120, onlySide: "UP", hoursUtc: [11, 3], added: "2026-10-28", idea: "feed2-up20 only 20:00-12:00 KST: replay n=427, 24% won, +$1,810 (+$4.24/trade) vs +$0.78/trade 12:00-20:00 KST; twice the trades of the feed3 night rule" },
  { name: "feed5-up20", left: 0, cap: 0.2, size: 5, feedLeadBp: 5, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-28", idea: "strict lead: Binance 5+ bps above Chainlink (over the usual gap), UP 20c or less, 120s+ left. In 331 of the 336 feed3 replay entries Chainlink had just fallen 2+ bps in 10 s while Binance had not followed, so the signal is a Chainlink overshoot that Binance disputes; the bigger the dispute the better: replay 25-27 Oct n=101, 39% won, +$1,258 (+$12.45/trade) but 25 Oct 0 of 11 (-$58)" },
  { name: "cldrop3-up20", left: 0, cap: 0.2, size: 5, fadeBp: 3, jumpSec: 10, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-28", idea: "CONTROL for the feed rules: Chainlink fell 3+ bps in 10 s and UP asks 20c or less, 120s+ left, buy UP whatever Binance says. Replay 25-27 Oct n=1,818, 16% won, -$1,363 (-$0.75/trade); the same drops with Binance 3+ bps above Chainlink: n=361, 21% won, +$1,549 (+$4.29/trade). If this control loses live while feed3-up20 wins, the Binance disagreement is the edge; if both lose, it was never there" },
  { name: "feed3-up20-far", left: 0, cap: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 300, onlySide: "UP", added: "2026-10-28", idea: "15-minute markets only in practice (needs 300s+ left): Binance 3+ bps above Chainlink, UP 20c or less. Replay 25-27 Oct BTC+ETH 15m n=60, 25% won, +$179 (+$2.99/trade); the same entry without the lead -$0.56/trade; 26 Oct carried it (+$125), 25 Oct 0 of 5" },
  { name: "feed3-up40", left: 0, cap: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-28", idea: "wider cap: Binance 3+ bps above Chainlink, UP 40c or less, 120s+ left. Replay 25-27 Oct 15m n=158, 38% won, +$270 (+$1.71/trade, positive 25, 26, 27 Oct); 5m n=794, 31% won, +$1,596 (+$2.01/trade, 25 and 28 Oct negative). Three times the trades of feed3-up20 at a third of the per-trade edge" },
  { name: "stress90-cheap40", left: 0, cap: 0.4, minAsk: 0.1, size: 5, flatBp: 9999, xchgDisagreePct: 90, added: "2026-10-29", idea: "at about 2 minutes left, buy the cheaper side at 10-40c only while Binance and Coinbase disagree (their spread is off its usual level by more than it is 90% of the time). Round 34 (25-28 Oct 1-s books, 5 coins, BNB out as its Coinbase feed is thin): the cheap side at 120 s left loses -$0.54/trade when the exchanges agree (n=1,492, 22.1% won) and makes +$0.29/trade when they disagree (n=157, 26.8%); the favourite is the other way round (-$0.24 calm, -$0.56 stressed). Which exchange sits higher does not pick the winner (buying the Binance side -$0.22/trade, the Coinbase side -$0.16 on 650-700 spikes), so the disagreement is a hint that cheap tickets are underpriced, not a direction. Small edge, about 6% of stake; this rule tests whether it holds" },
  { name: "feed3-both40-15m", left: 0, cap: 0.4, minAsk: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 300, minWindowSec: 900, added: "2026-10-29", idea: "the feed rule on 15-minute markets only, both sides, ask 20-40c, at least 5 minutes left. Round 33 (25-28 Oct 1-s books, BTC and ETH 15m, about 265 windows each): UP with Binance 3+ bps over Chainlink (over its usual gap) at 20-40c won 48.8% +$2.97/trade on BTC (n=43) and 43.4% +$2.01 on ETH (99), best in the first five minutes of the window (BTC 52.2% +$3.24 on 23, ETH 46.9% +$2.10 on 64); unlike the 5m markets the DOWN side pays too on ETH 15m (39.0% won, +$1.13/trade, n=100; BTC 15m too few). Cheap <=20c tickets with under 300 s left lost 1 of 19 on 15m, and 40-60c is near flat (+$0.3 to +$0.5/trade). Lab since 09:00 KST 28 Oct on the 15m series: feed3-up40 +$158/67, cross3x2-up40 +$127/101, feed3-up40-min20 +$116/19" },
  { name: "feed3-down20-mid", left: 0, cap: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "DOWN", clOpenBp: [4, 10], added: "2026-10-29", idea: "the one DOWN cell the feed lead pays in: Binance 3+ bps under Chainlink (over its usual gap), DOWN ask <=20c, Chainlink 4-10 bps above the open. Round 32 (25-28 Oct 1-s books, 6 coins): the DOWN mirror of the feed rule is flat at every price, <=20c 13.4% won -$0.64/trade (n=463), 20-40c 32.7% -$0.02 (649), 40-60c 51.9% -$0.07 (913), while UP makes +$3.90, +$0.89 and +$0.11 in the same buckets: the edge is Polymarket underpricing cheap UP, not the feed lead itself. By how far DOWN trails the open at <=20c: over 10 bps 9.4% won -$1.64 (342, the bulk), 4-10 bps 24.5% +$2.06 (110), 1-4 bps 42.9% +$8.60 (7); DOWN with the lead 5+ bps 24.2% +$3.89 (33). So only a DOWN ticket that is cheap without the price being far gone is worth a test; expect few trades" },
  { name: "feed3-up40-halt6", left: 0, cap: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", selfHaltLosses: 6, selfHaltMin: 30, added: "2026-10-29", idea: "feed3-up40 with the real test's stop built in: after 6 straight losses on a coin it sits out 30 minutes. Round 31 (paper feed3-up40, 10 series, 526 closed trades since 25 Oct): the next trade after 6 or more straight losses won 43.3% (+$2.84/trade, n=30) against 33.5% (+$1.70) overall, after 3 or more 35.5% (+$1.74): a losing run says nothing about the next trade. Every coin has had a run of 6-9 losses (a 36% rule runs 6 losses in a row about once per 100 trades per coin), and sitting out 30 minutes after each run would have skipped 24 trades that won 45.8% and made +$90; 15 min skips +$65, 60 min +$89, 120 min +$50. The real test halted on 5 of 6 coins in its first 9 hours this way. This rule shows live what the stop costs next to plain feed3-up40" },
  { name: "feed3-up20-early", left: 0, cap: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 240, onlySide: "UP", added: "2026-10-29", idea: "feed3-up20 only in the first minute of the window (240+ s left). Round 30 (25-28 Oct 1-s books, 6 coins, feed3 triggers at UP <=20c, n=398): by seconds left at the trigger, 270-300 s 61.1% won +$14.61/trade (n=18), 240-270 s 33.3% +$12.77 (33), 180-210 s 23.7% +$4.25 (97), 210-240 s 19.3% +$2.45 (88), 150-180 s 16.5% +$2.42 (79), 120-150 s 10.8% +$0.59 (83): a cheap UP ask with Binance already leading early in the window has four minutes for Chainlink to follow, late in the window it is a lottery ticket. The 20-40c tickets show no time-left pattern (+$0.7 to +$2.3/trade in every band but one). Also by coin at 20-40c: BTC 46.3% +$2.78 (54), SOL 41.5% +$1.60 (142), BNB 41.7% +$1.86 (36), ETH 35.0% +$0.73 (137), DOGE 32.5% +$0.54 (117), XRP 30.3% -$0.05 (185)" },
  { name: "feed3-up40-near", left: 0, cap: 0.4, minAsk: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", clOpenBp: [1, 4], added: "2026-10-29", idea: "feed3-up40-min20 only when Chainlink is 1-4 bps under the open, i.e. UP is losing by a hair while Binance already leads. Round 29 (25-28 Oct 1-s books, 6 coins, feed3 triggers at UP 20-40c, n=671): Binance is already back above the open at 656 of 671 triggers while Chainlink is still below it at 649, so the trigger is Binance having crossed the open first. By how far Chainlink trails the open: 1-4 bps 46.8% won, +$2.26/trade (n=141); 4-10 bps 35.5%, +$0.88 (310); over 10 bps 31.2%, +$0.65 (157); within 1 bp 25.5%, -$1.50 (51, the ask is near 40c for a coin flip). Fee break-even at 30c is 30%. On the cheap <=20c tickets the split adds nothing (+$3.5 to +$4.1/trade everywhere)" },
  { name: "feed3-up40-pay3", left: 0, cap: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", payUpC: 3, added: "2026-10-29", idea: "feed3-up40 priced as if every fill paid 3c over the ask (levels shifted +3c, still capped at 40c): what a slipped FAK order would cost. Round 28 (25-28 Oct 1-s books, 6 coins, feed3 triggers): one second after a 20-40c trigger the UP ask has already risen in 55% of cases (median +1c, p75 +5c, p90 +11c), after 2 s in 63%; at trigger 20-40c makes +$0.57/trade (n=560), filled one second late at up to ask+3c +$0.39 (n=351), two seconds late +$0.28, five seconds late -$0.24: the 20-40c edge lives about 2 s. Cheap 3-20c triggers keep +$4.87/trade one second late and +$3.81 five seconds late. Round 27 found 27 real 20-40c orders rejected because the ask was gone, so this rule measures what paying up to catch them costs" },
  { name: "feed3-up60-min20", left: 0, cap: 0.6, minAsk: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-29", idea: "does the feed edge survive above 40c? Same trigger as feed3-up40-min20 with the cap at 60c. Round 27: on 28 Oct paper the 30-40c bucket won 48.4% against a 36.6% fee break-even (n=95), the widest margin of any bucket, and cross3x2-up40 showed 41.4% vs 36.6% there; nothing has measured 40-60c yet. Same round, fill audit of the real $2 test (75 fills vs 109 paper fires on the same windows): every fill was at the paper ask (0 of 75 paid more), outcomes agreed 75 of 75, but 34 paper fires got no real fill and 30 of those 34 were 20-40c tickets, the bucket that wins" },
  { name: "feed3-up40-min20", left: 0, cap: 0.4, minAsk: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-29", idea: "feed3-up40 without the cheap tickets: UP ask 20-40c only. Round 26 (28 Oct paper, 8 coins, no hype, by ask bucket vs the fee-adjusted break-even): 3-10c 11.8% won vs 6.9% needed (+$4.00/trade on paper), 10-20c 17.9% vs 15.9% (+$0.54), 20-30c 37.0% vs 26.3% (+$1.99), 30-40c 48.4% vs 36.6% (+$1.49); the real $2 test on the same day disagrees on the cheap end: 3-10c fills 1 of 18 won (-$13.3), 10-20c 4 of 24 (-$0.5), 20-30c 5 of 9 (+$16.2), 30-40c 7 of 9 (+$19.6). Paper assumes a fill at the best ask; the real cheap tickets are the ones the book lets us have, so this rule keeps only the 20-40c half where real and paper agree" },
  { name: "feed3-up40-eu", left: 0, cap: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", hoursUtc: [6, 12], added: "2026-10-29", idea: "feed3-up40 only 15:00-21:00 KST (06-12 UTC, the European morning). Round 25: the first full day of paper fills for the feed family (28 Oct, 8 coins, hype excluded) earned everything in that block: feed3-up40 15-18 KST 28 trades 54% +$12.75/trade, 18-21 KST 30 trades 33% +$6.40, against 21-24 KST 99 trades 28% +$0.24, 12-15 KST 21 trades 14% -$2.62, 03-06 KST 0/8; feed3-up20 and feed3-up20-x6 show the same shape (15-18 KST 50% won, 21-24 KST 9-11%). One day only, so this is the live check of the hour effect, not a verdict; the replay of 25-27 Oct (round 16) also had the burst/feed rules red 12-18 KST and green elsewhere, which disagrees on the 15-18 hour" },
  { name: "feed3-up20-bids", left: 0, cap: 0.2, size: 5, feedLeadBp: 3, bidOverAsk: true, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-28", idea: "book-depth veto on feed3-up20: skip when more UP shares sit on the three best asks than on the three best bids. Round 24 replay 25-28 Oct (1-s books, 6 coins): at feed3 triggers the UP ask side holds a median 698 shares vs 5,056 on the DOWN asks; absolute depth, thin or thick, and the UP/DOWN ask ratio change nothing (+$2.4..+$5.9/trade, all within noise), but bids under asks on the UP side marks the losers: n=57, 12.3% won, +$0.53/trade vs n=341, 22.6%, +$4.46 when bids outweigh asks. Also checked this round: the recorder's BNB 'coinbase' price is the real Coinbase BNB-USD ticker, just thin (Coinbase-only triggers on BNB won 5.6%), so Coinbase-witness rules should be read without BNB" },
  { name: "feed3-up20-cb1", left: 0, cap: 0.2, size: 5, feedLeadBp: 3, feedCbBp: 1, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-28", idea: "Coinbase as a second witness with a low bar: Binance 3+ bps ahead of Chainlink and Coinbase at least 1 bp ahead too, UP ask 20c or less, 120s+ left. Round 23 replay 25-28 Oct (1-s books, 6 coins): feed3 triggers split by the Coinbase lead at that moment: Coinbase 3+ bps n=103, 27.2% won, +$7.37/trade; 1-3 bps n=171, 22.8%, +$4.24; under 1 bp n=124, 13.7%, +$0.55 (SOL and XRP negative there). So Coinbase under 1 bp is a veto: the rule keeps n=274 at +$5.42/trade (+$1,484) vs +$3.90 unfiltered. Coinbase alone as the trigger is weaker (n=497, 17.9%, +$1.70) and the BNB 'coinbase' feed is suspect (cb3 on BNB 5.6% won, 72 trades)" },
  { name: "feed3-up20-jump2", left: 0, cap: 0.2, size: 5, feedLeadBp: 3, leadJumpBp: 2, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-28", idea: "fresh-jump filter on feed3-up20: Binance 3+ bps ahead of Chainlink AND the lead rose 2+ bps in the last 1-3 s (Binance just printed the move). Round 22 replay 25-28 Oct (1-s books, 6 coins): the lead is a one-row spike (Chainlink catches up within the next second in every case, half-life 0 s), so only being first matters; triggers where the lead jumped 2+ bps into the bar: n=278, 24.1% won, +$5.27/trade (+$1,466); triggers where it crept up over several seconds: n=120, 14.2%, +$0.72/trade (+$86). The UP ask was flat over the previous 5 s at 397 of 398 triggers, so an ask-not-moved filter adds nothing" },
  { name: "feedp98-up20", left: 0, cap: 0.2, size: 5, feedLeadBp: 2, feedLeadPct: 98, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-28", idea: "adaptive lead bar: Binance must be ahead of Chainlink by more than the 98th percentile of that coin's own |lead| over the last ~10 min (floor 2 bps), UP ask 20c or less, 120s+ left. Round 21: coins differ in feed noise (p99 of |lead|: BTC 2.8 bps, BNB 3.5, ETH 4.3, SOL 4.4, XRP 4.5, DOGE 5.0), so a fixed 3 bps is a 1-in-100 event on BTC but routine on DOGE; replay 25-28 Oct (1-s books, 6 coins): fixed 3 bps n=398, 21.1%, +$3.90/trade (+$1,553); this p98 bar n=350, 22.3%, +$5.04/trade (+$1,763), better on DOGE (+$11.6/tr vs +$5.4) and SOL (+$6.6 vs +$2.8), worse on BTC (+$2.5 vs +$6.2). p99/p99.5 bars trade less for less (+$1,032/+$847). Both lose on 25 Oct" },
  { name: "feed7-up30", left: 0, cap: 0.3, size: 5, feedLeadBp: 7, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-28", idea: "big-lead only: Binance 7+ bps above Chainlink (over the usual gap), UP ask 30c or less, 120s+ left. Round 20 replay 25-28 Oct (1-s books, 6 coins, 600-row rolling gap median): the win rate climbs with the size of the lead at UP<=20c: 3-4 bps 20% (+$3.4/trade, n=375), 4-5 bps 28% (+$6.3, n=178), 5-7 bps 34% (+$9.2, n=119), 7-10 bps 58% (+$20.9, n=31); at a 30c cap the 7+ cell is n=46, 52% won, +$14.4/trade (+$663), 40c cap n=57, 51%, +$11.9. Caveat: 25 Oct was red at every lead size (-$11 here) and the gains are 26-27 Oct; fires maybe 15 times a day across coins. Same round: Chainlink prints every second on our books (about 20 prints per 15 s), so there is no print bunching to fade; following prints are 51-52% same-direction and both fading and following the first print after a 15-60 s quiet spell lose -$0.1..-$1.7/trade" },
  { name: "cross3x2-up20-awake", left: 0, cap: 0.2, size: 5, crossLeadBp: 3, crossLeadCoins: 2, jumpMinLeft: 120, onlySide: "UP", hoursUtc: [9, 3], added: "2026-10-28", idea: "cross3x2-up20 outside 12:00-18:00 KST, the block where the Binance-lead and burst rules lose in replay (not yet split by hour for the cross rule; this measures it live). Round 19 closed two wild ideas with no rule: the shared 5m/15m clock (BTC 5m and 15m books in the last 5 minutes never violate the implied-probability bound by more than 3c except 12 times in 3 days, and the 15m book is already at 90c+ whenever the 5m favourite and the open gap imply it: 23 cases, 87% won, -$0.18/trade vs control -$0.15) and flash-dip resting bids (a 20-50c bid on the favourite placed with 2-4 min left fills 10-46% of the time and then wins 9-41%, -$0.9..-$2.8 per fill with no taker fee: the dip is information)" },
  { name: "cross3x2-up20", left: 0, cap: 0.2, size: 5, crossLeadBp: 3, crossLeadCoins: 2, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-28", idea: "cross-coin spillover: at least 2 OTHER 5m coins have Binance 3+ bps above Chainlink (over their usual gaps) within 3 s, and UP here asks 20c or less, 120s+ left; this coin's own feed is not consulted. Replay 25-27 Oct (1s books, 6 coins) n=452, 22% won, +$1,484 (+$3.28/trade) vs -$0.79/trade for the same entry without it; with this coin's own lead under 1 bp still n=393, +$2.90/trade, so the Chainlink overshoot is market-wide, not per coin. Same regime as the feed rules: 25 Oct -$52, 26 Oct +$704, 27 Oct +$869, 28 Oct 00h -$37" },
  { name: "cross3x2-up40", left: 0, cap: 0.4, size: 5, crossLeadBp: 3, crossLeadCoins: 2, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-28", idea: "cross3x2-up20 with a 40c cap: replay n=916, 31% won, +$1,375 (+$1.50/trade) vs -$0.46/trade without; the only cheap-UP entry that was not negative on 25 Oct (+$10 on 111)" },
  { name: "feed3-up40-awake", left: 0, cap: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", hoursUtc: [9, 3], added: "2026-10-28", idea: "feed3-up40 outside 12:00-18:00 KST, the block where every Binance-lead rule loses in replay (feed3 -$2.10/trade there vs +$4.7..+$8.7 elsewhere, 25-27 Oct). Live 28 Oct: the feed family was red all afternoon and turned sharply green after 15:00 KST (feed3-up40 +$336 in 3 h, feed3-up20 +$306, feed3-up20-x6 +$1,362). Round 18 also tested market-beta lag (BTC Chainlink moved 5-15 bps since open, alt book UP/DOWN at or under 30-70c, alt's own move under half): no edge, best cell +$0.05/trade on 515 vs -$0.42 control at 70c and every tighter cell negative" },
  { name: "binburst4-up20-awake", left: 0, cap: 0.2, size: 5, binMoveBp: 4, binMoveSec: 2, jumpMinLeft: 120, onlySide: "UP", hoursUtc: [9, 3], added: "2026-10-28", idea: "binburst4-up20 outside 12:00-18:00 KST. Replay 25-27 Oct (1s books, 6 coins) by KST 6-hour block: 00-06 n=27, 44% won, +$15.66/trade; 06-12 n=63, +$7.62; 18-24 n=64, +$9.80; 12-18 n=23, 9% won, -$1.53. The feed3 rule has the same dead block (12-18 KST -$2.10/trade vs +$4.7..+$8.7 elsewhere) and the live lab's red streak on 28 Oct 12:00-15:00 KST sits in it. The cross-coin DOWN mirror was tested the same hour and is a no-go (-$0.28/trade on 543 vs -$0.46 control)" },
  { name: "binburst4-up20", left: 0, cap: 0.2, size: 5, binMoveBp: 4, binMoveSec: 2, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-28", idea: "Binance alone: its price rose 4+ bps within 2 s and UP still asks 20c or less, 120s+ left; no Chainlink, no rolling median, so no warm-up after a restart. Replay 25-27 Oct (1s books, 6 coins) n=177, 29% won, +$1,495 (+$8.45/trade); 3 bps n=394, +$4.58; 6 bps n=54, 46%, +$16.33. In 174 of the 177 Chainlink had not yet moved half as much, so it is the same overshoot the feed rules catch, seen from the Binance side. Same regime: 25 Oct 0 of 20 (-$106), 26-27 Oct +$1,622, 28 Oct 00h 0 of 4. DOWN mirrors lose (-$0.4..-$1.7/trade)" },
  { name: "binburst6-up40", left: 0, cap: 0.4, size: 5, binMoveBp: 6, binMoveSec: 2, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-28", idea: "a big Binance burst (6+ bps in 2 s) with a 40c cap: replay n=104, 47% won, +$975 (+$9.38/trade); 25 Oct 1 of 9 (-$34), 26 Oct +$639, 27 Oct +$397" },
  { name: "binburst4-up20-x6", left: 0, cap: 0.2, size: 30, binMoveBp: 4, binMoveSec: 2, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-28", idea: "sizing test: binburst4-up20 at $30 instead of $5, filled through the book levels up to the 20c cap as the paper trader does. At the trigger the best UP ask held a median $70 (25th percentile $36-38; 1-s books 25-27 Oct, 6 coins), so replay fills $28.4 of the $30 on average and keeps the return (+152% of stake vs +169% at $5; +$7,628 on 177 entries). What replay cannot show is the ask reacting to a $30 taker; this rule measures it live" },
  { name: "feed3-up20-x6", left: 0, cap: 0.2, size: 30, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-28", idea: "sizing test: feed3-up20 at $30: replay fills $28.1 of $30 at the best ask on average, return +79% of stake vs +86% at $5 (+$8,253 on 371 entries). Depth at the trigger does not predict the outcome (feed3 +$3.2 to +$5.2/trade in every ask-depth tercile), and the UP spread filter equals the overround filter already in feed3-up20-tight" },
  { name: "feed2-mid-last60", left: 0, cap: 0.8, minAsk: 0.6, size: 5, feedLeadBp: 2, jumpMinLeft: 5, feedMaxLeft: 60, added: "2026-10-28", idea: "the feed lead late and on the leading side at 60-80c: in the last 60 s, buy the side Binance leads Chainlink by 2+ bps (over its usual gap) when that side asks 60-80c. Replay 25-27 Oct (1s books, 6 coins): UP n=112, 78% won, +$55 (+$0.49/trade; control 60%, -$0.81), DOWN n=124, 76%, +$41 (+$0.33; control 67%, -$0.40); lead 3+ bps UP +$0.99/trade on 45. Small, but positive on 25, 26 and 27 Oct on both sides, unlike the cheap-UP rules. Buying the side Binance leads AGAINST loses -$2.1 to -$2.3/trade (40-42% won at 60-80c), so the lead is real information late in the window; on the 80-95c favourite the same lead only lifts the win rate from 81% to 92% (+$0.21/trade)" },
  { name: "feed3-up20-hold2", left: 0, cap: 0.2, size: 5, feedLeadBp: 3, leadHoldSec: 2, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-28", idea: "feed3-up20 only after the lead has held 3+ bps for 2 s straight (a sustained divergence, not a one-print blip). Replay 25-27 Oct (1s books, 6 coins): n=110, 28% won, +$870 (+$7.91/trade) vs +$4.30 at the first print; 1 s hold n=239 +$4.91. Judged after the fact, first-print entries whose lead lasted under 1 s made +$1.99/trade (212), 1-3 s +$5.96 (144), 3-10 s +$20.81 (15). The ask rose within 3 s of the first print in 224 of 371 cases and entering 3 s late drops the edge to +$2.99, which also explains part of the live-vs-replay gap. Same regime: 25 Oct 0 of 8" },
  { name: "flat1-cheap40-trail30", left: 0, cap: 0.4, minAsk: 0.2, size: 5, flatBp: 1, trailN: 30, trailOf: "flat1-cheap40", added: "2026-10-28", idea: "flat1-cheap40 only while flat1-cheap40's last 30 paper trades (all coins) are net positive. 14-day history by day: the X-post cell made +$1,860 of its +$2,090 on 14-21 Oct and +$0.25/trade on 350 trades 22-28 Oct, same decay as our cheap-UP family; a 30-trade trailing gate in replay gives +$2.89/trade on 562 (vs +$2.53 ungated) but keeps only +$1,623 of the total, it lags both ways. Live test of whether self-gating is worth anything" },
  { name: "feed2-up20-trail30", left: 0, cap: 0.2, size: 5, feedLeadBp: 2, jumpMinLeft: 120, onlySide: "UP", trailN: 30, trailOf: "feed2-up20", added: "2026-10-28", idea: "feed2-up20 only while feed2-up20's last 30 paper trades (all coins) are net positive: the feed family is red live (feed2-up20 -$143 on 209 by 13:00 KST 28 Oct) after a green replay; this measures how much of the live loss a trailing gate would have skipped" },
  { name: "flat1-cheap40-night", left: 0, cap: 0.4, minAsk: 0.2, size: 5, flatBp: 1, hoursUtc: [15, 21], added: "2026-10-28", idea: "flat1-cheap40 only 00:00-06:00 KST (US afternoon): 14-day history +$3.93/trade on 210 there vs +$0.85 on 224 in 12:00-18:00 KST; BTC is the best coin (+$3.91 on 266), DOGE the worst (+$0.30)" },
  { name: "flat1-cheap40", left: 0, cap: 0.4, minAsk: 0.2, size: 5, flatBp: 1, added: "2026-10-28", idea: "from an X post enrique shared (28 Oct): at 2 minutes left the price is within $10 (about 1 bp) of the open yet one side already asks 20-40c; buy that side, claimed 44% won. Our 1-s books 25-27 Oct (6 coins) say no: n=209, 27% won, -$2.70/trade at $14 (BTC within $10: n=93, 30%, -$1.31); but the 14-day history (price = last trade + 1c, move from Binance 1-min candles, so the ask is understated) says n=826, 36% won, +$2.53/trade, BTC +$3.91 on 266. This rule settles it live" },
  { name: "feed3-up20-tight", left: 0, cap: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", maxOverround: 1.02, added: "2026-10-28", idea: "feed3-up20 only when the book is tight (UP ask + DOWN ask <= 1.02). Replay 25-27 Oct (1s books, 6 coins): n=249, 25% won, +$1,459 (+$5.86/trade) vs +$4.30 for feed3-up20 on 371; with a 6c+ overround only +$3.12. Buying any cheap side (<=30c, 120s+ left) is -$0.41/trade in a tight book and -$0.95 in a wide one (4,399 vs 2,787 windows): a wide spread is the makers' uncertainty premium, never a bargain" },
  { name: "up60-first60", left: 0, cap: 0.66, floor: 0.58, size: 5, first: 60, onlySide: "UP", added: "2026-10-28", idea: "grid of every minute mark x 2c favourite price over 31,434 5m windows (14 days; $HOME/an/favgrid.py): 14 of 590 cells are positive after fees on both halves of the data, all small. The two with real samples: UP at 58-66c in the first minute, n=950-1,188, 63-64% won, +$0.07..+$0.10 a trade (1.3-2% of stake; both halves positive), and UP at 84-90c at 3 min in, n=598, 88% won, +$0.07. Everything else above +$0.10 flips sign between halves, so this is the ceiling of static favourite entries. The early rule now honours `floor`" },
  { name: "fav84-at180", left: 0, cap: 0.9, size: 5, favAt: 0.84, favFrom: 150, favTo: 210, strictCap: true, onlySide: "UP", added: "2026-10-28", idea: "UP favourite 84-90c seen 2.5-3.5 min into the window: grid cell n=598, 88.0% won, +$0.073/trade, positive on both halves (+$0.04 / +$0.10); the DOWN side of the same cell is not" },
  { name: "slide90-80-70", left: 0, cap: 0.995, size: 5, favAt: 0.9, favSchedule: [[0, 0.9], [150, 0.8], [240, 0.7]], added: "2026-10-28", idea: "enrique's sliding entry (28 Oct 16:14 KST): a 90c favourite in the first 2.5 minutes, 80c in the middle, 70c in the last minute. 14-day history (31,434 5m windows, 1-min price path): the favourite's win rate barely depends on the minute: 70-80c wins 72.9% at 1 min in and 74.1% at 4.5 min in, 80-90c 82.5% -> 84.5%, only 90c+ climbs 93.8% -> 98.4% because late 90c+ is mostly 97-99c. The schedule replays -$0.070/trade on 27,814 (90.2% won), fixed 90c -$0.029, fixed 70c -$0.127: time is already in the price. Runs so the live books can disagree" },
  { name: "slide95-85-75", left: 0, cap: 0.995, size: 5, favAt: 0.95, favSchedule: [[0, 0.95], [150, 0.85], [240, 0.75]], added: "2026-10-28", idea: "the same sliding entry 5c higher: 95c early, 85c middle, 75c last minute; replay n=26,478, 92.7% won, -$0.059/trade" },
  { name: "fav95-up-only", left: 0, cap: 0.995, size: 5, favAt: 0.95, onlySide: "UP", minWindowSec: 900, added: "2026-10-28", idea: "BTC 15m favourite at 95c+ in the last 3 minutes, UP side only. 11-day history (1,002 BTC 15m windows, trade tape): the UP favourite at 95c+ seen 9-14 min in won 97.4% (n=421, +$0.023/trade), the DOWN favourite 95.5% (n=446, -$0.071/trade); mirror image: cheap DOWN tickets (<=5c, minutes 5-13) win 1-2% and lose $3.5-4.2 a trade, red 10 of 11 days (n=271-326), cheap UP tickets win 5-8% and break even. Not drift: 49.3% of windows closed UP. A floor-rate edge (about 0.5% of stake), run as the test of that asymmetry" },
  { name: "fav95-down-only", left: 0, cap: 0.995, size: 5, favAt: 0.95, onlySide: "DOWN", minWindowSec: 900, added: "2026-10-28", idea: "control for fav95-up-only: the same rule on the DOWN favourite, which the 11-day BTC 15m history says wins 95.5% at 95c+ and loses -$0.071/trade" },
  { name: "fav99-last30", left: 0, cap: 0.995, size: 5, favAt: 0.99, favFrom: 270, strictCap: true, added: "2026-10-28", idea: "the only cell of a 10,635-window calibration table (14 days, BTC/ETH/SOL 5m history, 1-min price path, 5 minute marks x 10 price buckets) that beats its fee: the favourite at 99c or more with 30 s or less left wins 99.9% (n=5,642) for +$0.016 a trade, 0.3% on the stake. Every other price level at every minute mark is priced to within +-$0.10 a trade of fair; 97-99c at 1 min left +$0.05 (n=1,371) and nothing else above noise" },
  { name: "preopen3-down60", left: 0, cap: 0.6, size: 5, preOpenBp: 3, onlySide: "DOWN", added: "2026-10-28", idea: "momentum from before the open: Chainlink fell 3+ bps in the 60 s before the window opened, buy DOWN at 60c or less in the first minute. History (Binance 1-min candles, 14 days, 6 coins' 1-s books 25-27 Oct): a 3 bps pre-open fall -> DOWN wins 55-62% at the first ask, +$0.5 a trade on 343-385 cases; the UP mirror only +$0.07..0.24. Pre-open taker-buy share predicts the close just as well (57% UP after a 65%+ buy minute, 42% after a 35%- one, 24,000 windows) but the book prices that flow: -$0.1..-$0.5 a trade" },
  { name: "feed3-cheap20", left: 0, cap: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 120, added: "2026-10-27", idea: "both sides: whichever side Binance leads by 3+ bps, at 20c or less: replay n=707, 18% won, +$1,421; the DOWN half alone lost -$265, so this mostly tests whether DOWN ever pays" },
  { name: "up15-first100-vol14", left: 0, cap: 0.17, size: 5, first: 100, onlySide: "UP", prevRangeBp: 14, added: "2026-10-27", idea: "up15-first100 only when the previous 6 windows ranged 14+ bps on average (cheap sides pay in a volatile tape): replay 25-27 Oct UP<=20c n=428, 24% won, +$417 (+$0.97/trade) vs -$1/trade in calm tape; 26 Oct carried it (+$555), 27 Oct -$96" },
  { name: "up15-first100-flat", left: 0, cap: 0.17, size: 5, first: 100, onlySide: "UP", maxMoveBp: 3, added: "2026-10-27", idea: "up15-first100 only when the price is within 3 bps of the open (the book overreacts to a tiny move): replay 23-27 Oct n=355, 21.1% won, +$462 (+$1.30/trade); drops of 3-15 bps were net -$126 over 1,281 trades" },
  { name: "up15-first100-crash", left: 0, cap: 0.17, size: 5, first: 100, onlySide: "UP", minMoveBp: 15, added: "2026-10-27", idea: "up15-first100 only after a drop of 15 bps or more (crash then rebound): replay n=98, 29.6% won, +$358 (small sample)" },
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

/** Exchange-minus-Chainlink gap in bps, per series and exchange (binance, coinbase): the last ~600 snapshots (about 10 minutes) and the median over them, for the feedLeadBp rule. */
const feedGaps = new Map<string, { t: number; gaps: number[]; median: number | null }>(
  Object.entries(loadJson<Record<string, { t: number; gaps: number[]; median: number | null }>>("feed-gaps.json", {})).filter(([, f]) => Date.now() - f.t < 1800_000),
);
let feedGapsSaved = 0;
/** The bot restarts after every deploy; without this the ~5 minutes of gap samples the median needs were lost each time and the feed rules skipped the entries in between. */
function saveFeedGaps() {
  if (Date.now() - feedGapsSaved < 30_000) return;
  feedGapsSaved = Date.now();
  saveJson("feed-gaps.json", Object.fromEntries(feedGaps));
}
function noteFeedOne(key: string, t: number, price: number | null, chainlink: number | null) {
  if (price == null || chainlink == null || !chainlink) return;
  let f = feedGaps.get(key);
  if (!f) feedGaps.set(key, (f = { t: 0, gaps: [], median: null }));
  if (f.t === t) return;
  f.t = t;
  saveFeedGaps();
  f.gaps.push(((price - chainlink) / chainlink) * 1e4);
  if (f.gaps.length > 600) f.gaps.splice(0, f.gaps.length - 600);
  if (f.gaps.length < 300) { f.median = null; return; }
  const sorted = f.gaps.slice().sort((a, b) => a - b);
  f.median = sorted[sorted.length >> 1];
}
function noteFeed(prefix: string, row: BookRow) {
  noteFeedOne(prefix + "|binance", row.t, row.binance, row.chainlink);
  noteFeedOne(prefix + "|coinbase", row.t, row.coinbase, row.chainlink);
  noteFeedOne(prefix + "|xchg", row.t, row.binance, row.coinbase);
  if (/^[a-z]*5m-$|^$/.test(prefix)) {
    const lead = feedLead(prefix, row);
    if (lead != null) latestLead.set(prefix, { t: row.t, lead });
  }
}
/** The last ~15 s of Binance prints per series, for the binMoveBp rule. */
const binTails = new Map<string, { t: number; p: number }[]>();
function noteBin(prefix: string, row: BookRow) {
  if (row.binance == null) return;
  let a = binTails.get(prefix);
  if (!a) binTails.set(prefix, (a = []));
  if (a.length && a[a.length - 1].t === row.t) return;
  a.push({ t: row.t, p: row.binance });
  while (a.length && a[0].t < row.t - 15_000) a.shift();
}
/** Binance move in bps over the last `sec` seconds (vs the first print at or before t - sec); null when the tail does not reach back that far. */
function binMove(prefix: string, t: number, sec: number): number | null {
  const a = binTails.get(prefix);
  if (!a || a.length < 2) return null;
  const now = a[a.length - 1];
  let ref: { t: number; p: number } | null = null;
  for (const x of a) if (x.t <= t - sec * 1000) ref = x;
  if (!ref || !ref.p) return null;
  return ((now.p - ref.p) / ref.p) * 1e4;
}
/** Each 5m series' latest Binance lead (bps over its usual gap), for the crossLeadBp rule. */
const latestLead = new Map<string, { t: number; lead: number }>();
/** Closed paper trades per variant across every series, oldest window first, for the trailN gate (capped at 500). */
const recentPnl = new Map<string, { window: number; pnl: number }[]>();
function notePnl(name: string, window: number, pnl: number) {
  let a = recentPnl.get(name);
  if (!a) recentPnl.set(name, (a = []));
  let i = a.length;
  while (i > 0 && a[i - 1].window > window) i--;
  a.splice(i, 0, { window, pnl });
  if (a.length > 500) a.splice(0, a.length - 500);
}
/** Net P&L of the last `n` closed trades of a variant, or null while fewer than n exist. */
export function trailSum(name: string, n: number): number | null {
  const a = recentPnl.get(name);
  if (!a || a.length < n) return null;
  let s = 0;
  for (let i = a.length - n; i < a.length; i++) s += a[i].pnl;
  return s;
}
/** How many OTHER 5m series had Binance ahead (up) or behind (down) Chainlink by `bp` within the last 3 s. */
function crossLeads(prefix: string, t: number, bp: number, up: boolean): number {
  let n = 0;
  for (const [k, v] of latestLead) if (k !== prefix && t - v.t <= 3000 && (up ? v.lead >= bp : -v.lead >= bp)) n++;
  return n;
}
/** How far an exchange (Binance by default) is ahead of Chainlink right now, in bps over the series' usual gap; null until ~5 minutes of samples exist. */
function feedLead(prefix: string, row: BookRow, exchange: "binance" | "coinbase" = "binance"): number | null {
  const f = feedGaps.get(prefix + "|" + exchange);
  const price = row[exchange];
  if (!f || f.median == null || price == null || row.chainlink == null || !row.chainlink) return null;
  return ((price - row.chainlink) / row.chainlink) * 1e4 - f.median;
}
/** Binance-Coinbase spread in bps minus its usual level (600-row median), the exchange-disagreement gauge; null until the median exists. */
function xchgDev(prefix: string, row: BookRow): number | null {
  const f = feedGaps.get(prefix + "|xchg");
  if (!f || f.median == null || row.binance == null || row.coinbase == null || !row.coinbase) return null;
  return ((row.binance - row.coinbase) / row.coinbase) * 1e4 - f.median;
}
/** The `pct`-th percentile of |gap - median| over the stored samples for a series (bps), or null until the median exists. */
function feedLeadQuantile(prefix: string, pct: number, exchange: "binance" | "coinbase" | "xchg" = "binance"): number | null {
  const f = feedGaps.get(prefix + "|" + exchange);
  if (!f || f.median == null) return null;
  const med = f.median;
  const abs = f.gaps.map((g) => Math.abs(g - med)).sort((a, b) => a - b);
  return abs[Math.min(abs.length - 1, Math.floor((pct / 100) * abs.length))];
}

/** Chainlink range (high minus low, bps from the open) of each window seen, per series, for the prevRangeBp gate. */
const ranges = new Map<string, Map<number, { min: number; max: number }>>();
function noteRange(prefix: string, row: BookRow, windowSec: number) {
  if (row.chainlink == null || !row.open) return;
  const bps = ((row.chainlink - row.open) / row.open) * 1e4;
  let m = ranges.get(prefix);
  if (!m) ranges.set(prefix, (m = new Map()));
  const cur = m.get(row.window);
  if (cur) { cur.min = Math.min(cur.min, bps); cur.max = Math.max(cur.max, bps); } else m.set(row.window, { min: bps, max: bps });
  for (const w of m.keys()) if (w < row.window - 12 * windowSec) m.delete(w);
}
/** The last ~90 s of Chainlink prints per series, so a new window can read the move over the 60 s before its open (preOpenBp rule). */
const tails = new Map<string, { t: number; p: number }[]>();
function noteTail(prefix: string, row: BookRow) {
  if (row.chainlink == null) return;
  let a = tails.get(prefix);
  if (!a) tails.set(prefix, (a = []));
  if (a.length && a[a.length - 1].t === row.t) return;
  a.push({ t: row.t, p: row.chainlink });
  while (a.length && a[0].t < row.t - 90_000) a.shift();
}
/** Chainlink move in bps over the 60 s before `openMs`, or null when the series has no prints there (recorder start, gap). */
function preOpenMove(prefix: string, openMs: number): number | null {
  const a = tails.get(prefix);
  if (!a) return null;
  const at = a.filter((x) => x.t <= openMs && x.t >= openMs - 70_000);
  if (at.length < 5) return null;
  const from = at.find((x) => x.t >= openMs - 62_000);
  const to = at[at.length - 1];
  if (!from || to.t - from.t < 45_000) return null;
  return ((to.p - from.p) / from.p) * 1e4;
}
/** Mean range of the previous 6 windows of this series (at least 4 seen), or null. */
function prevRange(prefix: string, window: number, windowSec: number): number | null {
  const m = ranges.get(prefix);
  if (!m) return null;
  const xs: number[] = [];
  for (let k = 1; k <= 6; k++) { const r = m.get(window - k * windowSec); if (r) xs.push(r.max - r.min); }
  return xs.length >= 4 ? mean(xs) : null;
}

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
  /** selfHaltLosses: current loss streak on this series and the time the self-halt lifts. */
  private lossStreak = 0;
  private haltUntil = 0;
  private byDay = new Map<string, { day: string; trades: number; won: number; net: number; first: number }>();

  private count(t: PaperTrade) {
    if (t.pnl == null) return;
    this.trades += 1;
    if (t.won) this.won += 1;
    this.net += t.pnl;
    notePnl(this.v.name, t.window, t.pnl);
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
  /** For leadHoldSec: when the lead first went past the threshold toward UP / DOWN in the current run (ms), or null. */
  private leadSince: { up: number | null; down: number | null } = { up: null, down: null };
  /** The last ~3 s of (t, lead) for the leadJumpBp gate. */
  private leadTail: { t: number; lead: number }[] = [];

  consider(row: BookRow) {
    const { left: LEFT, cap: CAP, size: SIZE } = this.v;
    if (discarded().has(this.v.name)) return;
    if (this.v.salvageAt != null || this.v.stopBid != null || this.v.tpBid != null) this.considerExit(row);
    const prev = this.prevAsk?.window === row.window ? this.prevAsk : null;
    noteClose(this.prefix, row, this.windowSec);
    noteFeed(this.prefix, row);
    noteRange(this.prefix, row, this.windowSec);
    noteTail(this.prefix, row);
    noteBin(this.prefix, row);
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
    if (this.v.feedLeadBp != null || this.v.crossLeadBp != null) return this.considerFeed(row);
    if (this.v.binMoveBp != null) return this.considerBinMove(row);
    if (this.v.flatBp != null) return this.considerFlat(row);
    if (this.v.preOpenBp != null) return this.considerPreOpen(row);
    if (this.v.jumpBp != null || this.v.bounceBp != null || this.v.fadeBp != null) return this.considerJump(row);
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
    if (this.v.selfHaltLosses != null) {
      this.lossStreak = trade.won ? 0 : this.lossStreak + 1;
      if (this.lossStreak >= this.v.selfHaltLosses) {
        this.haltUntil = (window + this.windowSec) * 1000 + (this.v.selfHaltMin ?? 30) * 60000;
        this.lossStreak = 0;
      }
    }
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
    if (this.v.maxMoveBp != null || this.v.minMoveBp != null) {
      if (row.chainlink == null || row.open == null) return false;
      const move = Math.abs((row.chainlink - row.open) / row.open) * 1e4;
      if (this.v.maxMoveBp != null && move > this.v.maxMoveBp) return false;
      if (this.v.minMoveBp != null && move < this.v.minMoveBp) return false;
    }
    if (this.v.prevRangeBp != null) {
      const r = prevRange(this.prefix, row.window, this.windowSec);
      if (r == null || r < this.v.prevRangeBp) return false;
    }
    if (this.v.minWindowSec != null && this.windowSec < this.v.minWindowSec) return false;
    if (this.v.trailN != null) {
      const s = trailSum(this.v.trailOf ?? this.v.name, this.v.trailN);
      if (s == null || s <= (this.v.trailMin ?? 0)) return false;
    }
    if (this.v.selfHaltLosses != null && row.t < this.haltUntil) return false;
    if (this.v.xchgDisagreePct != null) {
      const q = feedLeadQuantile(this.prefix, this.v.xchgDisagreePct, "xchg");
      const d = xchgDev(this.prefix, row);
      if (q == null || d == null || Math.abs(d) < q) return false;
    }
    if (this.v.maxOverround != null) {
      const ua = row.upAsks[0]?.[0];
      const da = row.downAsks[0]?.[0];
      if (ua == null || da == null || ua + da > this.v.maxOverround + 1e-9) return false;
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
    const FLOOR = this.v.floor ?? 0;
    const candidates = [upBest != null && upBest <= CAP && upBest >= FLOOR && this.v.onlySide !== "DOWN" ? { up: true, ask: upBest } : null, downBest != null && downBest <= CAP && downBest >= FLOOR && this.v.onlySide !== "UP" ? { up: false, ask: downBest } : null].filter((c): c is { up: boolean; ask: number } => c != null);
    if (!candidates.length) return;
    const pick = candidates.sort((a, b) => a.ask - b.ask)[0];
    if (!this.leadOk(row, pick.up)) return;
    this.take(row, pick, CAP, SIZE, `${elapsed}s into the window`);
  }

  /**
   * The `preOpenBp` rule (28 Oct 2026, hourly round 8): Binance taker flow and the price move in the minute before the open both
   * predict the close (55-57% UP after a strong buy minute, 41-44% after a strong sell minute, 24,000 history windows), but the
   * book prices the flow; only the price move leaves a little: DOWN after a 3 bps fall in the last pre-open minute +$0.5 a trade.
   */
  private considerPreOpen(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    if (row.left < this.windowSec - 60) return;
    if (this.open.some((t) => t.window === row.window)) return;
    const move = preOpenMove(this.prefix, row.window * 1000);
    if (move == null) return;
    const need = this.v.preOpenBp ?? 0;
    const upBest = row.upAsks[0]?.[0] ?? null;
    const downBest = row.downAsks[0]?.[0] ?? null;
    let pick: { up: boolean; ask: number } | null = null;
    if (this.v.onlySide !== "DOWN" && move >= need && upBest != null && upBest <= CAP && upBest >= 0.03) pick = { up: true, ask: upBest };
    else if (this.v.onlySide !== "UP" && -move >= need && downBest != null && downBest <= CAP && downBest >= 0.03) pick = { up: false, ask: downBest };
    if (!pick || !this.leadOk(row, pick.up)) return;
    this.take(row, pick, CAP, SIZE, `Chainlink ${move >= 0 ? "+" : ""}${move.toFixed(1)} bps in the minute before the open`);
  }

  private jumps: { window: number; min: number; max: number; rows: { t: number; bps: number; up: number | null; down: number | null }[] } = { window: 0, min: 0, max: 0, rows: [] };
  /**
   * The `feedLeadBp` rule (27 Oct 2026, from the first look at the Binance and Coinbase prices the recorder stores next to
   * Chainlink): Binance quotes a different pair (USDT) so it sits a steady few bps away from Chainlink; when it moves ahead of
   * that usual gap, Chainlink tends to follow within seconds, and a side still asking 20c has not priced it. Buys the side Binance
   * leads toward at or under `cap`, respects onlySide, one trade per window, only with `jumpMinLeft` seconds left (default 120).
   */
  /** The `binMoveBp` rule (28 Oct 2026, round 10): a Binance burst over the last 2 s, no oracle comparison at all. */
  private considerBinMove(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    if (row.left < (this.v.jumpMinLeft ?? 120)) return;
    if (this.open.some((t) => t.window === row.window)) return;
    const sec = this.v.binMoveSec ?? 2;
    const move = binMove(this.prefix, row.t, sec);
    if (move == null) return;
    const need = this.v.binMoveBp ?? 0;
    const upBest = row.upAsks[0]?.[0] ?? null;
    const downBest = row.downAsks[0]?.[0] ?? null;
    let pick: { up: boolean; ask: number } | null = null;
    if (this.v.onlySide !== "DOWN" && move >= need && upBest != null && upBest <= CAP && upBest >= 0.03) pick = { up: true, ask: upBest };
    else if (this.v.onlySide !== "UP" && -move >= need && downBest != null && downBest <= CAP && downBest >= 0.03) pick = { up: false, ask: downBest };
    if (!pick || !this.leadOk(row, pick.up)) return;
    this.take(row, pick, CAP, SIZE, `Binance ${move >= 0 ? "+" : ""}${move.toFixed(1)} bps in ${sec} s`);
  }

  /** The `flatBp` rule: the claim that a market still 20-40c on one side while the price has not moved is mispriced. */
  private considerFlat(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    if (row.left > 125 || row.left < 115 || row.chainlink == null || !row.open) return;
    if (this.open.some((t) => t.window === row.window)) return;
    const move = ((row.chainlink - row.open) / row.open) * 1e4;
    if (Math.abs(move) > (this.v.flatBp ?? 1)) return;
    const upBest = row.upAsks[0]?.[0] ?? null;
    const downBest = row.downAsks[0]?.[0] ?? null;
    if (upBest == null || downBest == null) return;
    const up = upBest <= downBest;
    const ask = up ? upBest : downBest;
    if (ask < (this.v.minAsk ?? 0.2) || ask > CAP) return;
    if (this.v.onlySide === "UP" && !up) return;
    if (this.v.onlySide === "DOWN" && up) return;
    if (!this.leadOk(row, up)) return;
    this.take(row, { up, ask }, CAP, SIZE, `price ${move >= 0 ? "+" : ""}${move.toFixed(1)} bps from the open at 2 min, cheap side ${(ask * 100).toFixed(0)}c`);
  }

  private considerFeed(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    if (row.left < (this.v.jumpMinLeft ?? 120)) return;
    if (this.open.some((t) => t.window === row.window)) return;
    if (this.v.feedMaxLeft != null && row.left > this.v.feedMaxLeft) return;
    const own = this.v.feedLeadBp != null || this.v.feedLeadPct != null;
    const lead = own ? feedLead(this.prefix, row) : 0;
    if (lead == null) return;
    const wantCb = this.v.feedBoth || this.v.feedCbBp != null;
    const cb = wantCb ? feedLead(this.prefix, row, "coinbase") : null;
    if (wantCb && cb == null) return;
    const cbNeed = this.v.feedCbBp ?? this.v.feedLeadBp ?? 0;
    let need = this.v.feedLeadBp ?? 0;
    if (this.v.feedLeadPct != null) {
      const q = feedLeadQuantile(this.prefix, this.v.feedLeadPct);
      if (q == null) return;
      need = Math.max(need, q);
    }
    const cross = this.v.crossLeadBp;
    const needCoins = this.v.crossLeadCoins ?? 1;
    const crossOk = (up: boolean) => cross == null || crossLeads(this.prefix, row.t, cross, up) >= needCoins;
    const upBest = row.upAsks[0]?.[0] ?? null;
    const downBest = row.downAsks[0]?.[0] ?? null;
    let pick: { up: boolean; ask: number } | null = null;
    const floor = this.v.minAsk ?? 0.03;
    const hold = (this.v.leadHoldSec ?? 0) * 1000;
    if (own) {
      this.leadSince.up = lead >= need ? (this.leadSince.up ?? row.t) : null;
      this.leadSince.down = -lead >= need ? (this.leadSince.down ?? row.t) : null;
    }
    let jumpOk = (_up: boolean) => true;
    if (this.v.leadJumpBp != null) {
      const ref = this.leadTail.find((x) => x.t <= row.t - 1000 && x.t >= row.t - 3000);
      this.leadTail.push({ t: row.t, lead });
      while (this.leadTail.length && this.leadTail[0].t < row.t - 3500) this.leadTail.shift();
      const need2 = this.v.leadJumpBp;
      jumpOk = (up: boolean) => ref != null && (up ? lead - ref.lead : ref.lead - lead) >= need2;
    }
    const held = (up: boolean) => hold <= 0 || (up ? this.leadSince.up : this.leadSince.down) != null && row.t - (up ? this.leadSince.up! : this.leadSince.down!) >= hold;
    if (this.v.onlySide !== "DOWN" && lead >= need && (cb == null || cb >= cbNeed) && crossOk(true) && held(true) && jumpOk(true) && upBest != null && upBest <= CAP && upBest >= floor) pick = { up: true, ask: upBest };
    else if (this.v.onlySide !== "UP" && -lead >= need && (cb == null || -cb >= cbNeed) && crossOk(false) && held(false) && jumpOk(false) && downBest != null && downBest <= CAP && downBest >= floor) pick = { up: false, ask: downBest };
    if (!pick || !this.leadOk(row, pick.up)) return;
    if (this.v.clOpenBp) {
      if (row.chainlink == null || !row.open) return;
      const behind = ((row.open - row.chainlink) / row.open) * 1e4 * (pick.up ? 1 : -1);
      if (behind < this.v.clOpenBp[0] || behind >= this.v.clOpenBp[1]) return;
    }
    if (this.v.bidOverAsk) {
      const depth = (levels: [number, number][]) => levels.slice(0, 3).reduce((s, l) => s + l[1], 0);
      const bids = depth(pick.up ? row.upBids : row.downBids);
      const asks = depth(pick.up ? row.upAsks : row.downAsks);
      if (!(bids > asks)) return;
    }
    const sign = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
    const crossNote = cross == null ? "" : `${crossLeads(this.prefix, row.t, cross, pick.up)} other coin(s) with Binance ${pick.up ? "+" : "-"}${cross}+ bps vs Chainlink`;
    const ownNote = !own ? "" : cb == null ? `Binance ${sign(lead)} bps vs Chainlink (over its usual gap${this.v.feedLeadPct != null ? `, bar ${need.toFixed(1)}` : ""})` : `Binance ${sign(lead)} and Coinbase ${sign(cb)} bps vs Chainlink (over their usual gaps)`;
    let takeRow = row;
    let takeNote = [ownNote, crossNote].filter(Boolean).join("; ");
    if (this.v.payUpC != null) {
      const c = this.v.payUpC / 100;
      const shift = (levels: [number, number][]): [number, number][] => levels.map(([p, q]) => [Math.round((p + c) * 100) / 100, q]);
      takeRow = { ...row, upAsks: shift(row.upAsks), downAsks: shift(row.downAsks) };
      pick = { up: pick.up, ask: Math.round((pick.ask + c) * 100) / 100 };
      takeNote += `; paid +${this.v.payUpC}c over the ask`;
    }
    this.take(takeRow, pick, CAP, SIZE, takeNote);
  }

  /**
   * The `jumpBp` and `bounceBp` rules (27 Oct 2026, enrique: "moments where bps has been very strong on one side but the bets
   * haven't priced it in yet"). jumpBp: the price moved at least that many bps toward a side within `jumpSec` seconds and that
   * side's ask has not risen meanwhile. bounceBp: the price has come back that many bps from the window's extreme. Both buy at
   * or under `cap`, respect onlySide, one trade per window, only with `jumpMinLeft` seconds left (default 30).
   */
  private considerJump(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    if (row.left < (this.v.jumpMinLeft ?? 30) || row.chainlink == null || !row.open) return;
    const bps = ((row.chainlink - row.open) / row.open) * 1e4;
    if (this.jumps.window !== row.window) this.jumps = { window: row.window, min: bps, max: bps, rows: [] };
    const J = this.jumps;
    J.min = Math.min(J.min, bps);
    J.max = Math.max(J.max, bps);
    const upBest = row.upAsks[0]?.[0] ?? null;
    const downBest = row.downAsks[0]?.[0] ?? null;
    const span = (this.v.jumpSec ?? 15) * 1000;
    J.rows.push({ t: row.t, bps, up: upBest, down: downBest });
    while (J.rows.length && J.rows[0].t < row.t - span - 1000) J.rows.shift();
    if (this.open.some((t) => t.window === row.window)) return;
    let pick: { up: boolean; ask: number } | null = null;
    let note = "";
    if (this.v.bounceBp != null) {
      const upOk = this.v.onlySide !== "DOWN" && bps - J.min >= this.v.bounceBp && upBest != null && upBest <= CAP;
      const downOk = this.v.onlySide !== "UP" && J.max - bps >= this.v.bounceBp && downBest != null && downBest <= CAP;
      if (upOk) pick = { up: true, ask: upBest! };
      else if (downOk) pick = { up: false, ask: downBest! };
      if (pick) note = `${(pick.up ? bps - J.min : J.max - bps).toFixed(1)} bps off the window ${pick.up ? "low" : "high"}`;
    } else if (this.v.fadeBp != null) {
      const ref = J.rows.find((r) => r.t <= row.t - span);
      if (!ref) return;
      const move = bps - ref.bps;
      const need = this.v.fadeBp;
      if (this.v.onlySide !== "DOWN" && -move >= need && upBest != null && upBest <= CAP && upBest >= 0.03) pick = { up: true, ask: upBest };
      else if (this.v.onlySide !== "UP" && move >= need && downBest != null && downBest <= CAP && downBest >= 0.03) pick = { up: false, ask: downBest };
      note = `fading ${move >= 0 ? "+" : ""}${move.toFixed(1)} bps in ${this.v.jumpSec ?? 15}s`;
    } else {
      const ref = J.rows.find((r) => r.t <= row.t - span);
      if (!ref) return;
      const move = bps - ref.bps;
      const need = this.v.jumpBp ?? 0;
      if (this.v.onlySide !== "DOWN" && move >= need && upBest != null && upBest <= CAP && ref.up != null && upBest - ref.up < 0.01) pick = { up: true, ask: upBest };
      else if (this.v.onlySide !== "UP" && -move >= need && downBest != null && downBest <= CAP && ref.down != null && downBest - ref.down < 0.01) pick = { up: false, ask: downBest };
      note = `${move >= 0 ? "+" : ""}${move.toFixed(1)} bps in ${this.v.jumpSec ?? 15}s`;
    }
    if (!pick || !this.leadOk(row, pick.up)) return;
    this.take(row, pick, CAP, SIZE, note);
  }

  /** Take the ask side's levels up to `cap` for `size` dollars and book the trade. */
  private take(row: BookRow, pick: { up: boolean; ask: number }, CAP: number, SIZE: number, note: string) {
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
    console.log(`paper ${this.v.name}: ${trade.side} ${shares.toFixed(1)} shares at ${Math.round(pick.ask * 100)}c, ${note}`);
    this.onTrade?.(trade);
  }

  /** The `favAt` rule: the first time the favourite's best ask is at or above favAt, buy it (up to cap). */
  private considerFav(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    if (row.left < 1) return;
    const scale = this.windowSec / 300;
    const elapsed = this.windowSec - row.left;
    let favAt = this.v.favAt ?? 1;
    if (this.v.favSchedule) for (const [at, p] of this.v.favSchedule) if (elapsed >= at * scale) favAt = p;
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
    if (this.v.onlySide && (up ? "UP" : "DOWN") !== this.v.onlySide) return;
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
