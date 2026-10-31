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
  /** Gate (round 77, 31 Oct 2026): only trade when the two best asks sum to at least this (a wide book: 1.015 = 1.5c+ overround). On the 15m early-move rule the wide books paid and the tight ones did not. */
  minOverround?: number;
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
  /** Feed-lead rule: dollars resting on our side's best ask level (shares x price) must be within [min, max). */
  askUsd?: [number, number];
  /** Feed-lead rule (round 56, 30 Oct 2026): the microprice of our side, (ask x bidShares + bid x askShares) / (bidShares + askShares) at the best levels, must sit within this many dollars under the best ask (0.02 = the bid side carries enough size to hold the price up; a microprice far under the ask means a thin bid or a wide spread). */
  microGap?: number;
  /** Cross-coin rule: at least `crossLeadCoins` OTHER 5m series (default 1) have Binance ahead of Chainlink by this many bps (over their usual gaps) within the last 3 s; buy that side here at or under `cap`. With `feedLeadBp` too, this series' own lead must also pass. */
  crossLeadBp?: number;
  crossLeadCoins?: number;
  /** Binance burst rule: the Binance price moved at least this many bps over the last `binMoveSec` seconds (default 2); buy that side at or under `cap`, one trade per window, only with `jumpMinLeft` seconds left (default 120). No Chainlink, no median, no warm-up. */
  binMoveBp?: number;
  binMoveSec?: number;
  /** Binance perpetual basis (futures minus spot, bps) moved this much over the last basisSec seconds: up means buy UP, down means buy DOWN. */
  basisBp?: number;
  basisSec?: number;
  /** Round-number magnet: the open sits this many bps or less below (UP) or above (DOWN) the nearest fine round price level. */
  roundBp?: number;
  /** Feed-lead rule, late variant: only with at most this many seconds left (pair with a small jumpMinLeft), and `minAsk`: the side's ask must be at least this (a favourite or mid price instead of the cheap side). */
  feedMaxLeft?: number;
  minAsk?: number;
  /** Feed-lead rule: the lead must have held at or above `feedLeadBp` continuously for this many seconds before entering (a sustained lead, not a one-print blip). */
  leadHoldSec?: number;
  /** Flat-window rule (from an X post enrique shared, 28 Oct 2026): at about 2 minutes left (115-125 s), if Chainlink is within this many bps of the open, buy the CHEAPER side if it asks between `minAsk` and `cap`; one trade per window. */
  flatBp?: number;
  /** Seconds-left window for the flatBp rule (default 115-125). */
  flatLeft?: [number, number];
  /** Ahead-side rule (round 44, 29 Oct 2026): inside `flatLeft`, when Chainlink is at least this many bps from the open, buy the side it favours if that side still asks between `minAsk` and `cap` (the book has not caught up with the underlying). One trade per window. */
  aheadBp?: number;
  /** Book-imbalance fade (round 46, 29 Oct 2026): inside `flatLeft`, UP pressure = $ resting on UP bids + DOWN asks over all four sides; at or above this share buy DOWN, at or below 1 minus it buy UP, if that side asks between `minAsk` and `cap`. One trade per window. */
  imbFade?: number;
  /** Collapsed-favourite rule (round 40, 29 Oct 2026): inside `flatLeft`, buy a side whose ask reached at least `peakDrop[0]` earlier in this window and now asks at most `peakDrop[1]` (and at least `minAsk`). One trade per window. */
  peakDrop?: [number, number];
  /** Edge-follow gate: trade only while the last `trailN` closed paper trades of variant `trailOf` (default: this variant), across every series, net more than `trailMin` dollars (default 0). Point trailOf at an ungated sibling, or the gated rule can never restart once it stops. */
  trailN?: number;
  /** Self-halt: after this many straight losses on this series, skip trades for `selfHaltMin` minutes (default 30), like the real haltAfterLosses stop; measures what the stop costs. */
  selfHaltLosses?: number;
  /** Gate: only when Binance and Coinbase disagree, i.e. |Binance-Coinbase spread minus its usual level| is at or above this percentile of the stored samples (a stress gauge). */
  xchgDisagreePct?: number;
  selfHaltMin?: number;
  /** Only run on series whose window is at least this long in seconds (900 = the 15-minute markets only). */
  minWindowSec?: number;
  /** Only run on series whose window is at most this long in seconds (300 = the 5-minute markets only). */
  maxWindowSec?: number;
  /** Ahead-side rule (round 59, 30 Oct 2026): BTC 5m's own Chainlink move from its open (bps, within the last 3 s) must point the same way by at least this much (market-wide move, not a coin-only wiggle). */
  btcAheadBp?: number;
  /** Cross-coin ahead rule (round 72, 30 Oct 2026): at least `crossAheadCoins` (default 3) OTHER series of the same window length have their Chainlink price `crossAheadBp` bps or more from their open (within the last 3 s) in one direction, while this series' own move is at most `ownMaxBp` (default `aheadBp`); buy the side the others moved toward. Replaces the own-move test of `aheadBp`. */
  crossAheadBp?: number;
  crossAheadCoins?: number;
  ownMaxBp?: number;
  /** Ahead-side rule (round 76, 31 Oct 2026): Binance must also be ahead of Chainlink by this many bps (over the series' usual gap) in the move direction. */
  aheadLeadBp?: number;
  /** Ahead-side rule (round 80, 31 Oct 2026): Binance must also be this many bps from ITS OWN open (first row of the window) in the move direction. */
  binAheadBp?: number;
  /** Ahead-side rule (round 81, 31 Oct 2026): the move must be fresh: Chainlink was still within aheadBp of the open at most this many seconds ago (a first crossing, not a move the book has had minutes to price). */
  freshSec?: number;
  trailOf?: string;
  trailMin?: number;
  /** For `first` rules: only trade when the mean Chainlink range (high minus low, bps) of the previous 6 windows is at least this. */
  prevRangeBp?: number;
  /** Calm gate (round 41, 29 Oct 2026): trade only when the mean Chainlink range of the previous 6 windows is BELOW the coin's typical range (CALM_RANGE, the upper tercile of 5m window ranges on the 25-28 Oct books) times this factor; 1 = skip the wildest third of the time. */
  calmX?: number;
  /** Maker test: at the trigger, instead of taking the ask, rest a bid this far under it (no fee); it fills if the ask later comes down to it, else the window is skipped. */
  rest?: number;
  /** Only trade when the UTC hour is inside [from, to). */
  hoursUtc?: [number, number];
  /** Skip these coins (lower-case, e.g. ["xrp"]; "btc" is the 5m series with the empty prefix). */
  skipCoins?: string[];
  /** Skip when Chainlink has already moved more than this many basis points from the open, either way. */
  maxMoveBp?: number;
  /** Cross-coin check: BTC only trades when ETH's book favours the same side this window; every other coin checks BTC. */
  confirmCross?: boolean;
  /** Volatility-model rule (30 Oct 2026): fair P(UP) = Phi(ln(Binance now / Binance at the open) / (sigma_1m * sqrt(minutes left))),
   *  sigma_1m from the coin's last 6 h of Binance 1-minute closes. Buy the side whose model price beats its best ask by at least this much. */
  modelEdge?: number;
  /** For modelEdge: only act while the fraction of the window left is inside [lo, hi] (default [0.1, 1]). */
  modelLeft?: [number, number];
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
  { name: "feed3-up40-tp90", left: 0, cap: 0.4, minAsk: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", tpBid: 0.9, added: "2026-10-29", idea: "feed3-up40-min20 that sells into the UP bids once they reach 90c instead of holding to the close. Round 43 exit study on the 25-28 Oct 1-s books ($HOME/an/exit1.py, 6 coins, feed trigger: Binance 3+ bps over its usual gap, UP ask 20-40c, 120+ s left, n=665): holding pays +$0.62/trade (34.3% won); every exit pays less: take profit at 90c bid +$0.32 (sells 13 tickets that would have won), 80c +$0.09, 70c +$0.02, 60c +$0.08; stop loss at 15c bid +$0.17 (the UP bid dips to 15c in 79% of trades and 89 of those still won), at 10c +$0.06. So exits are a no-go on the feed rule; this rule is the live check of the least bad one, expected to trail feed3-up40-min20 by about $0.30 a trade" },
  { name: "feed3-up40-deep", left: 0, cap: 0.4, minAsk: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", askUsd: [500, 1e9], added: "2026-10-29", idea: "feed3-up40-min20 only when at least $500 rests on the UP best ask: a big maker who has not pulled the quote, so the ticket is fillable and the price is still stale. Round 42 on the 25-28 Oct 1-s books (6 coins, feed trigger: Binance 3+ bps over its usual gap, UP ask 20-40c, 120+ s left, n=665, $HOME/an/depth1.py), by dollars on the best UP ask: $500+ 46.6% won, +$2.67/trade (n=58); $20-100 34.6%, +$1.35 (185); $100-500 32.5%, +$0.01 (419, the bulk: no edge); UP bid depth vs ask depth adds nothing (+$0.40 / +$0.76). At 40-60c the same split is $500+ +$0.33 (196), $100-500 +$0.09 (652), $20-100 -$0.67 (102). Thin-ask tickets are the ones the fill audit found pulled before our order lands, so the deep-ask cell is also the one that fills" },
  { name: "feed3-up40-calm", left: 0, cap: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", calmX: 1, added: "2026-10-29", idea: "feed3-up40 only when the market has NOT been wild: the mean Chainlink range of the previous 6 windows is under the coin's upper-tercile range (BTC 10 bps, BNB 11, ETH/DOGE/SOL 16, XRP 18). Round 41 on the 25-28 Oct 1-s books (feed trigger: Binance 3+ bps over its usual gap to Chainlink, UP ask 20-40c, 120+ s left, n=664, regime = mean range of the previous 3 windows): calm third +$1.13/trade (n=80, 37.5% won), middle third +$0.70 (201, 34.3%), wild third +$0.43 (383, 33.4%); the cheap <=20c tickets +$8.30 / +$7.79 / +$4.05 (30/49/157). The trigger fires mostly in wild windows, where the edge is thinnest, so this keeps the calmer two thirds. Same round, two clean no-gos on the 14-day history (~27,000 windows, 6 coins, 1-minute UP price samples, $HOME/an/vol1.py and mom1.py): favourites at 60-90c are priced the same in calm, mid and wild regimes (every cell -$0.00 to -$0.04 per share, i.e. the fee, at 60/120/180/240 s left), and the UP price path inside the window carries nothing: riding momentum (price up 0.1-0.35+ between minute marks) or fading it both net -$0.05 to +$0.02 per share in all 60+ cells" },
  { name: "feed3-up40", left: 0, cap: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-28", idea: "wider cap: Binance 3+ bps above Chainlink, UP 40c or less, 120s+ left. Replay 25-27 Oct 15m n=158, 38% won, +$270 (+$1.71/trade, positive 25, 26, 27 Oct); 5m n=794, 31% won, +$1,596 (+$2.01/trade, 25 and 28 Oct negative). Three times the trades of feed3-up20 at a third of the per-trade edge" },
  { name: "round3-up60", left: 0, cap: 0.6, minAsk: 0.3, size: 5, roundBp: 3, jumpMinLeft: 240, onlySide: "UP", added: "2026-10-29", idea: "round-number magnet: when the window opens within 3 bps BELOW a fine round price level (BTC $100, ETH $10, SOL $1, XRP 1c, DOGE 0.1c, BNB $5) buy UP in the first minute at 30-60c. Round 39 on the 14-day history (~1,480 resolved 5m windows with a price path, 6 coins, Binance 1-minute open as the open): just-below windows close UP 58.6% and buying UP at the 60 s price nets +$0.056 per $1 share after fee (n=116); on BTC alone 65.6% and +$0.117 (n=61). Just-above windows show nothing (50.6%, +$0.02 UP, -$0.04 DOWN, n=85), 3-8 bps either side nothing, and the coarse levels ($1,000 / $100) nothing (n=48-59, within $0.04 of zero). So it is one-directional and thin: a classic magnet story on a small sample, run live to see if it holds" },
  { name: "basis10-both60-2m", left: 0, cap: 0.6, minAsk: 0.3, size: 5, basisBp: 1.0, basisSec: 120, jumpMinLeft: 240, added: "2026-10-29", idea: "the perpetual-basis rule with a 2-minute look-back and a 1 bps bar, so it fires on about a third of windows instead of one in eight. Round 38 on the 14-day 1-minute spot and perpetual candles, now 6 coins (~1,400 resolved 5m windows with a price path): the basis change over the last 2 minutes picks the side at every bar: +1 bps or more gives UP 55.4% and +$0.055 per $1 share buying UP at the 60 s price after fee (n=202), -1 bps or more gives UP 43.3% and +$0.030 buying DOWN (n=201); at 1.5 bps +$0.043 / +$0.027 (n=84 / 94), at 2.5 bps +$0.186 / +$0.100 (n=18 / 26). The 5-minute change carries nothing (-$0.04..-$0.13 on both tails), so the signal is a short-lived lean of the leveraged crowd. Same round: the perp websocket never delivered on the Mac (23,000 rows, all empty) while Binance's REST side works there, so the futures feed now polls the REST price every 2 s whenever the stream is silent" },
  { name: "ahead3-cheap50-15m", left: 0, cap: 0.5, minAsk: 0.1, size: 5, aheadBp: 3, flatLeft: [180, 720], minWindowSec: 900, added: "2026-10-29", idea: "15-minute markets, minutes 3-12: the underlying is 3+ bps from the open yet the side it favours still asks under 50c, i.e. the book has not caught up. Replay on 14 days of 15m history (6 coins, last trade +1c, one trade per window, $HOME/an/lag15.py): n=580, 54.5% won, +$1.31/trade at $5 (+$761), green 12 of 16 days, every coin positive except BTC (-$12/41); +3c slippage still +$1.10. Conditioning on price alone (R15) showed nothing; the mispricing only appears against the underlying." },
  { name: "ahead15-mid70-15m", left: 0, cap: 0.7, minAsk: 0.5, size: 5, aheadBp: 15, flatLeft: [180, 720], minWindowSec: 900, added: "2026-10-29", idea: "sibling of ahead3-cheap50-15m for the favourite zone: underlying 15+ bps from the open, favoured side at 50-70c. Replay (same script): n=190, 74% won, +$0.66/trade; SOL/XRP/ETH positive, DOGE flat. Fee-sensitive, so a live check." },
  { name: "ahead3-cheap50-late", left: 0, cap: 0.5, minAsk: 0.1, size: 5, aheadBp: 3, flatLeft: [60, 240], added: "2026-10-29", idea: "ahead3-cheap50-15m on every window length, 1-4 minutes before the close (minutes 1-4 of a 5m market). Round 45 replay on 14 days of 5m history (6 coins, last trade +1c): n=2,529, 53% won, +$1.72/trade at $5, but the gain grows with how stale the last trade is (<10 s old +$0.52, 30-90 s +$3.24, 90 s+ +$4.07), which is the stale-print artifact: a quiet tape understates the real ask. The fresh-print cell is close to fair, so this rule exists to measure the lag with real asks, not because the replay is trusted." },
  { name: "imbfade65-mid", left: 0, cap: 0.7, minAsk: 0.3, size: 5, imbFade: 0.65, flatLeft: [175, 185], added: "2026-10-29", idea: "resting-depth imbalance as a crowd signal, faded: at 3 minutes left, when 65%+ of the resting dollars (UP bids plus DOWN asks vs the reverse) lean one way, buy the other side at 30-70c. Round 46 replay on 25-28 Oct 1-s books (6 coins 5m, $HOME/an/imb1.py): FOLLOWING the lean wins 45-51% and loses -$0.04..-$0.39/trade in every bucket; fading the 65%+ lean wins ~53%, about fair after the fee. Live check that resting depth carries no direction." },
  { name: "ahead5-mid65-late", left: 0, cap: 0.65, minAsk: 0.5, size: 5, aheadBp: 5, flatLeft: [60, 240], added: "2026-10-29", idea: "the ahead-side rule in the 50-65c zone: 1-4 minutes before the close, price 5+ bps from the open and the favoured side asks 50-65c. Round 47 replay on 14 days of 5m history (6 coins, fresh prints only, <10 s old, $HOME/an/volmom1.py): 50-65c n=2,597, 61% won, +$0.10/trade (the only ask zone not negative; 65-80c -$0.18, 30-50c +$0.03). Binance volume behind the move adds nothing (every volume bucket within $0.2 of fair; 3x+ volume moves slightly worse). A fair-value check, not an edge claim." },
  { name: "feed3-up60-mid-deep", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", askUsd: [300, 1e9], added: "2026-10-29", idea: "feed3-up60-mid (the best real line: 41/79 won, +$2.23 at $2 since the chase went on 29 Oct 16:55 KST) only when the best UP ask has $300+ resting, so the real order can actually fill. Round 42 replay at 40-60c: $500+ on the ask +$0.33/trade (196), $100-500 +$0.09, $20-100 -$0.67. Round 48 fill audit: with chasing on, real filled 176 of 239 paper triggers (74%, same as the 73% before chasing); the missed 63 now win 40% like the fills (39%), so the adverse-selection gap closed but the fill rate did not move; 17 chased fills won 10 (+$4.55)." },
  { name: "fade15-under25-10m", left: 0, cap: 0.25, minAsk: 0.1, size: 5, flatBp: 9999, flatLeft: [595, 605], minWindowSec: 900, added: "2026-10-29", idea: "15-minute markets only: at the 10-minute mark buy the underdog at 10-25c when the favourite sits at 75-90c, whatever the price has done. Round 37 window-shape read on the 1-s books 25-28 Oct (BTC and ETH 15m, ~265 windows each): with 600 s left the 75-90c favourite wins only 26-29% less often than its price says, so the underdog returned +$299 on 180 trades at $5 (+$1.66/trade, 27% won; BTC +$218/90, ETH +$81/90), green on 3 of 4 days and in both quiet and choppy windows (window range under or over 12 bps). But the same read at 12 min (-$8 / +$52) and 7.5 min (-$14 / +$70) is flat, and 25 Oct is red at every mark, so this is most likely noise around one checkpoint; the rule is a probe to settle it live. 5m markets show nothing like it: the underdog loses -$0.10..-$0.21 per $1 in every price and range cell at 180 and 120 s" },
  { name: "basis15-both60", left: 0, cap: 0.6, minAsk: 0.3, size: 5, basisBp: 1.5, basisSec: 180, jumpMinLeft: 240, added: "2026-10-29", idea: "a signal from a feed the bot did not have until now: the Binance perpetual. When the futures-minus-spot basis has widened 1.5+ bps over the last 3 minutes the leveraged crowd is leaning long, so buy UP in the first minute (ask 30-60c); when it has shrunk 1.5+ bps buy DOWN. Round 36 on the 14-day Binance 1-minute spot and perpetual candles against ~1,250 resolved 5m windows with a price path (BTC/ETH/SOL/XRP/DOGE): basis up 1.5+ bps over 3 min gives UP 61.5% (n=78) and +$0.032 per $1 share buying UP at the 60 s price after fee; basis down 1.5+ bps gives UP 37.8% (n=90) and +$0.051 per share buying DOWN; the 1-minute change and the basis level carry nothing (within $0.03 of zero on 1,250 windows). Small samples (~5% of windows), so this is a probe: the live rule needs the new futures feed, which the recorder adds this round" },
  { name: "binburst6-up40-min20", left: 0, cap: 0.4, minAsk: 0.2, size: 5, binMoveBp: 6, binMoveSec: 2, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-29", idea: "binburst6-up40 without the cheap tickets (UP ask 20-40c only), the same cut that helped the feed rule in round 26. Thursday read 29 Oct: binburst6-up40 is the one green rule outside the feed family, +$201 on 97 paper trades since 27 Oct, 33% won, 7 of 9 coins positive. Round 35 on the 14-day Binance 1-minute candles (26,000 windows, 6 coins): taker flow does point the way (first-minute buy share >=65% gives UP 58-63%, sell share <=35% gives UP 36-39%, pre-window flow 54-55% / 43-45%) but it is fully priced by the 60 s mark: buying the flow side at the 60 s price nets -$0.0 to -$0.4/trade in every cell, with or without a 2x volume burst, so flow is not a signal we can trade; only the sub-5-second price burst is" },
  { name: "stress90-cheap40", left: 0, cap: 0.4, minAsk: 0.1, size: 5, flatBp: 9999, xchgDisagreePct: 90, added: "2026-10-29", idea: "at about 2 minutes left, buy the cheaper side at 10-40c only while Binance and Coinbase disagree (their spread is off its usual level by more than it is 90% of the time). Round 34 (25-28 Oct 1-s books, 5 coins, BNB out as its Coinbase feed is thin): the cheap side at 120 s left loses -$0.54/trade when the exchanges agree (n=1,492, 22.1% won) and makes +$0.29/trade when they disagree (n=157, 26.8%); the favourite is the other way round (-$0.24 calm, -$0.56 stressed). Which exchange sits higher does not pick the winner (buying the Binance side -$0.22/trade, the Coinbase side -$0.16 on 650-700 spikes), so the disagreement is a hint that cheap tickets are underpriced, not a direction. Small edge, about 6% of stake; this rule tests whether it holds" },
  { name: "feed3-both40-15m", left: 0, cap: 0.4, minAsk: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 300, minWindowSec: 900, added: "2026-10-29", idea: "the feed rule on 15-minute markets only, both sides, ask 20-40c, at least 5 minutes left. Round 33 (25-28 Oct 1-s books, BTC and ETH 15m, about 265 windows each): UP with Binance 3+ bps over Chainlink (over its usual gap) at 20-40c won 48.8% +$2.97/trade on BTC (n=43) and 43.4% +$2.01 on ETH (99), best in the first five minutes of the window (BTC 52.2% +$3.24 on 23, ETH 46.9% +$2.10 on 64); unlike the 5m markets the DOWN side pays too on ETH 15m (39.0% won, +$1.13/trade, n=100; BTC 15m too few). Cheap <=20c tickets with under 300 s left lost 1 of 19 on 15m, and 40-60c is near flat (+$0.3 to +$0.5/trade). Lab since 09:00 KST 28 Oct on the 15m series: feed3-up40 +$158/67, cross3x2-up40 +$127/101, feed3-up40-min20 +$116/19" },
  { name: "fav55-4h-1h", left: 0, cap: 0.92, size: 5, favAt: 0.55, favFrom: 225, favTo: 240, strictCap: true, minWindowSec: 14400, added: "2026-10-30", idea: "4-hour markets only: with about one hour left (favFrom/favTo 225-240 in 5m seconds, x48), buy the favourite the first time it asks 55-92c. Round 50 on 14 days of 4h history (7 coins, 588 windows, 1-min UP prices, last print as the ask, $HOME/an/h4cal.py): at 3,600 s left the favourite beats its price in every bucket, 50s 64.6% won +$0.146 per $1 (n=65), 60s 72.8% +$0.107 (81), 70s 80.0% +$0.047 (80), 80s 92.4% +$0.070 (92), 90s 99.5% +$0.055 (201), while the underdog loses -$0.19..-$0.89 per $1; at 30 min left 60-90c still +$0.01..+$0.05, at 2-3 h left every bucket is fair or negative. On 5m markets the same favourite cells are exactly fair (round 41). Thin, wide 4h books (the real ask is likely 2-5c over the last print, which eats most of the 50-70c edge), so a probe on the 4h series only; about 6 windows a day per coin." },
  { name: "fav70-4h-30m", left: 0, cap: 0.92, size: 5, favAt: 0.7, favFrom: 262.5, favTo: 270, strictCap: true, minWindowSec: 14400, added: "2026-10-30", idea: "second 4-hour probe: with about 30 minutes left (favFrom/favTo 262.5-270 in 5m seconds, x48 = minutes 210-216 of 240), buy the favourite the first time it asks 70-92c. Round 51 (30 Oct 2026) put the 15-minute markets through the same calibration as the 4h ones ($HOME/an/cal15.py; 14 days, 7 coins, 9,890 15m windows, last print +1c as the ask): at 600, 300, 120 and 60 s left EVERY price bucket is -$0.00 to -$0.09 per $1 after fee (e.g. 600 s: 60s -$0.070, 70s -$0.043, 80s -$0.030, 90s -$0.001; 120 s: 70s -$0.023, 80s -$0.040, 90s -$0.009), the same fair-after-fee picture as 5m (round 41). So the favourite premium found in round 50 is a 4h-only effect: at 30 min left the 4h favourite still pays 60s +$0.044, 70s +$0.020, 80s +$0.049, 90s +$0.014 per $1 (n=39-186). Thin and wide books, so a probe, next to fav55-4h-1h." },
  { name: "fav55-1h-15m", left: 0, cap: 0.92, size: 5, favAt: 0.55, favFrom: 225, favTo: 240, strictCap: true, minWindowSec: 3600, maxWindowSec: 3600, added: "2026-10-30", idea: "1-hour markets only: with about 15 minutes left (favFrom/favTo 225-240 in 5m seconds, x12 = minutes 45-48 of 60), buy the favourite the first time it asks 55-92c. Round 60 (30 Oct 2026, $HOME/an/fill2.py, 1-s books of 30 Oct, BTC/ETH/SOL): the share of asks (5+ shares) still there within 1c three seconds later, which is what a real order needs, is 68% on 5m, 81% on 15m, 92% on 1h and 96% on 4h; right after a 2c+ move it is 63% / 71% / 80-86% / 87-89%. So the 5m paper edge is mostly tickets that vanish (the fillable re-score of 30 Oct), while 1h and 4h books hold still. Calibration: 4h favourites pay at 1 h left (round 50), 15m favourites are fair at every checkpoint (round 51), the 1h series has no history yet, so this is the probe in between, next to fav55-4h-1h; judge it by the fillable column." },
  { name: "fav60-1h-early", left: 0, cap: 0.89, size: 5, favAt: 0.6, favFrom: 70, favTo: 85, strictCap: true, minWindowSec: 3600, maxWindowSec: 3600, added: "2026-10-30", idea: "1-hour markets only: about 15 minutes into the hour (favFrom/favTo 70-85 in 5m seconds, x12 = minutes 14-17 of 60), buy the favourite the first time it asks 60-89c. Round 61 (30 Oct 2026, $HOME/an/cal1h.py) calibrated the 1h favourite on the only 1h data we have, the live books and results since 29 Oct 17:05 KST (7 coins, 111 resolved windows, real asks at the checkpoint, 7% fee): with 45 min left the 50c+ favourite won 76.6% for +$0.087 per $1 (n=107; 60s +$0.109/36, 70s +$0.139/27, 80s +$0.081/15; 6 of 7 coins positive, HYPE and DOGE negative), with 30 min left 73.0% -$0.020 (89), with 15 min left 80.0% -$0.010 (60), with 5 min left -$0.158 (30). So on this small sample the 1h favourite pays only early, like the 4h favourite at 1 h left, and is fair or worse from the half-hour on. Two days of data: a probe, judged by the fillable column (1h asks persist 92%, round 60)." },
  { name: "ahead5-mid65-1h-early", left: 0, cap: 0.65, minAsk: 0.5, size: 5, aheadBp: 5, flatLeft: [2700, 3300], minWindowSec: 3600, maxWindowSec: 3600, added: "2026-10-30", idea: "the ahead rule on 1-hour markets, minutes 5-15: Binance 5+ bps from the open and the side it favours still asks 50-65c. Round 62 (30 Oct 2026, $HOME/an/ahead1h.py) tried to replay this cell on the live 1h books since 29 Oct 17:05 KST and found under 5 qualifying windows per cell (only 111 resolved 1h windows, and when Binance is 5-10 bps ahead the favoured side on 1h books usually already asks 60-70c or sits at 30-40c because the Binance-Chainlink basis dominates small moves), so there is no replay number: this is the probe that gathers the data, on the window length where asks persist 92% (round 60). Same round: the first fillable read of the lab found the fillable flag was only set on the oldest entry path, so feed, ahead and favourite trades went untagged for three hours; fixed in this build (missing flag now counts as unchecked). Among the tagged rules every fillable half is negative: band90-30 11/12 fillable -$1.0 (fair), band80 11/16 -$16.6, early45 9/20 -$45.7, late20 3/10 -$33.6." },
  { name: "fav70-1h-early", left: 0, cap: 0.89, size: 5, favAt: 0.7, favFrom: 70, favTo: 85, strictCap: true, minWindowSec: 3600, maxWindowSec: 3600, added: "2026-10-30", idea: "1-hour markets only, the narrow sibling of fav60-1h-early: at minutes 14-17 buy the favourite only when it asks 70-89c. Round 63 (30 Oct 2026, $HOME/an/h1cal.py) ran the 4h calibration over the freshly downloaded 14-day 1h history (7 coins, 2,345 windows, last print as the ask, 7% fee): at 45 min left the favourite pays only from 70c up, 70s 80.8% won +$0.065 per $1 (n=479), 80s 89.8% +$0.054 (244), while 50s -$0.043 (824) and 60s -$0.030 (724) lose; at 30 min left every bucket is +$0.01..+$0.03 (fair), at 15 min left -$0.03..-$0.16 by coin, at 5 min left 80s +$0.055 (317) and 90s +$0.017 (580). So round 61's +$0.087 on 111 windows was mostly its 60c bucket getting lucky: the 1h favourite is fair after fee like the 15m one, with a thin premium only on the 70-89c favourite early in the hour. The real ask sits above the last print on these books, so a probe, judged by the fillable column." },
  { name: "ahead5-cheap50-1h", left: 0, cap: 0.5, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [900, 3300], minWindowSec: 3600, maxWindowSec: 3600, added: "2026-10-30", idea: "1-hour markets, minutes 5-45: Binance is 5+ bps from the window open yet the side it favours still asks only 35-50c. Round 64 (30 Oct 2026, $HOME/an/ahead1hh.py and its zone variant) on the 14-day 1h history (6 coins, ~2,000 windows, Binance 1-min close vs open, last print as the ask, one trade per window and cell, 7% fee): the cheap zone pays most, 35-50c minutes 5-15 61.4% won +$0.280 per $1 (n=363), minutes 15-30 58.9% +$0.232 (299), minutes 30-45 62.6% +$0.338 (243); the 50-65c zone is thin, +$0.050 (1,695) / +$0.036 (1,370) / +$0.103 (955), and 65-80c is fair (-$0.004 / +$0.023 / +$0.044). The same pattern as the 15m lag cell (round 44) one window length up. Caveat from round 45: a last print at 35-50c while Binance already favours that side is often a stale tape, so the real ask is higher and the fillable column decides; 1h asks persist 92% (round 60), which is why this is worth a probe here and not on 5m." },
  { name: "fade-daily-mid", left: 0, cap: 0.4, minAsk: 0.2, size: 5, flatBp: 9999, flatLeft: [21600, 43200], minWindowSec: 86400, added: "2026-10-30", idea: "daily (24h) markets only: between 12 and 6 hours left, buy the underdog at 20-40c, whatever the price has done. Round 65 (30 Oct 2026) calibrated the daily favourite on the first 90 resolved daily windows of the 14-day history (7 coins, last print as the ask, 7% fee): the 50c+ favourite loses -$0.156 per $1 with 12 h left (n=90, 65.6% won) and -$0.199 with 6 h left (84, 61.9%), the 60-80c favourite worst (12 h: 60s -$0.24, 70s -$0.39; 6 h: 60s -$0.40, 70s -$0.78 on 12-28 each), while with 1 h left the favourite is paid +$0.080 (60, 90% won) and with 18 h left +$0.074 (91). So a daily market that has picked a side by midday reverses far more often than its price says, which is the underdog's edge, the opposite of the 4h favourite premium. Tiny sample (12-28 windows per cell), so a probe that fires about once a day per coin; the fillable column decides." },
  { name: "ahead10-cheap50-1h-awake", left: 0, cap: 0.5, minAsk: 0.35, size: 5, aheadBp: 10, flatLeft: [900, 3300], minWindowSec: 3600, maxWindowSec: 3600, hoursUtc: [21, 15], added: "2026-10-30", idea: "the 1-hour lag cell narrowed to what survives a realistic fill: Binance 10+ bps from the open, favoured side 35-50c, minutes 5-45, 06-24 KST only (hoursUtc 21-15). Round 66 (30 Oct 2026) re-scored round 64's cell on the 14-day 1h history (6 coins, 775 trades) three ways: at the last print +$0.266 per $1, at the last print +3c +$0.190, and filled at the price two prints later (what a resting order sees once the tape catches up) only +$0.016, so the 1h lag edge is mostly the stale-print artifact of round 45 again. What keeps a margin at the realistic fill: 10+ bps moves +$0.059 (n=176, 66.5% won) vs 5-10 bps +$0.004 (599); BTC +$0.198 (84), XRP +$0.069, DOGE +$0.059, while ETH, SOL and BNB go negative; 18-24 KST +$0.116 and 12-18 KST +$0.062, 00-06 KST -$0.098 (224). Still a thin, small-sample cell; the fillable column decides, and ahead5-cheap50-1h stays as the wide control." },
  { name: "feed3-both40-15m-deep", left: 0, cap: 0.4, minAsk: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 300, minWindowSec: 900, maxWindowSec: 900, askUsd: [100, 1e9], added: "2026-10-30", idea: "feed3-both40-15m only when at least $100 rests on the best ask of the side we buy, so the ticket is still there for a real order. Round 67 (30 Oct 2026, first 8 hours of live fillable tagging, 20,700 settled paper trades across every rule): by window length the fillable half nets 5m -$0.096 per $1 (9,441 fillable trades, 59.8% won), 15m +$0.049 (3,825, 60.0%), 1h -$0.344 (680) and 4h -$0.260 (179, one bad day of favourite reversals); inside 15m the green zone is the cheap ticket under 35c, fillable 58% of the time, 22.7% won, +$1.29 per $5 trade (n=1,223), plus the 90c+ favourite +$0.06 (1,569), while 35-90c loses -$0.6 to -$1.1 per trade. So on 15m the cheap feed tickets are the only fillable, paying zone today, and the depth filter (round 42: $100+ resting asks fill, thin ones are pulled) is the lever that should raise the 58% fill rate; low win rate by nature, so judged on fillable net per $1 and red days, not on win rate." },
  { name: "feed3-both35-15m-early", left: 0, cap: 0.35, minAsk: 0.1, size: 5, feedLeadBp: 3, jumpMinLeft: 600, minWindowSec: 900, maxWindowSec: 900, added: "2026-10-30", idea: "the 15-minute cheap feed ticket, both sides, 10-35c, only with 10+ minutes left. Round 68 (30 Oct 2026) split today's fillable 15m cheap tickets (every rule, ask under 35c, 2,654 settled since the 14:10 KST tagging fix; the counts overlap because many rules buy the same ticket) by seconds left: 600+ s left fillable 60%, 43.2% won, +$7.23 per $5 trade (n=939); 300-600 s 28.4% won +$6.90 (1,182); 120-300 s 4.7% won -$5.19 (504); under 120 s 0 of 28. And by KST block: 12-15 6% won -$4.65 (298), 15-18 +$3.13, 18-21 +$7.91. So the cheap 15m ticket pays only when bought early in the window, when the move has time to carry; late cheap tickets are the lottery tickets that lose on 5m too (round 37 fade read). The book rows carry no resting-$ figure in the trade record, so depth is tested by feed3-both40-15m-deep instead. One afternoon of data: a probe, judged on fillable net per $1 and red days." },
  { name: "ahead10-mid65-15m-first3", left: 0, cap: 0.65, minAsk: 0.35, size: 5, aheadBp: 10, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, added: "2026-10-30", idea: "15-minute markets, first three minutes (flatLeft 720-870 s): Binance already 10+ bps from the open and the side it favours still asks 35-65c. Round 69 (30 Oct 2026) measured early-move carry on the 14-day 15m history (6 coins, 8,903 windows, Binance 1-min closes): a 10-20 bps move by minute 2 resolves its own way 72.4% of the time (n=1,643), 20+ bps 82.4% (581), 6-10 bps 65.8%, 3-6 bps 60.9%, under 3 bps 54.2%; by minute 5 the same buckets carry 78-90%. The book prices this in only partly: buying the favoured side at its last print when it still asks 35-65c after a 10-20 bps move pays +$0.231 per $1 at minute 2 (68.6% won, n=746), +$0.190 at minute 3 (527), +$0.227 at minute 5 (368), and +$0.35-0.50 after 20+ bps (92-202), while the 65-90c favourite is fair or negative in every bucket (-$0.09..+$0.05). Same family as ahead15-mid70-15m (round 44) but earlier in the window and with a wider price floor; last-print caveat (round 45) applies, so the fillable column decides." },
  { name: "flat25-cheap50-4h", left: 0, cap: 0.5, minAsk: 0.35, size: 5, flatBp: 25, flatLeft: [12000, 13800], minWindowSec: 14400, added: "2026-10-30", idea: "4-hour markets, minutes 10-40: the underlying is still within 25 bps of the open, yet the book already leans (one side 50-65c); buy the cheaper side at 35-50c. Round 70 (30 Oct 2026) ran the round-69 early-move-carry test on the 14-day 4h history (6 coins, 540 windows, Binance 1-min closes): unlike 15m, small early moves do not carry on 4h. At minute 15 a move under 10 bps resolves its own way 49.5% (n=277) and 10-25 bps 48.1% (156), a coin flip, while the book's favoured side at 50-65c loses -$0.180 and -$0.215 per $1 at the last print (217 and 139); at minute 30 the same cells are 53-54% and -$0.04..-$0.06, at minute 60 51-54% and -$0.03..-$0.39. Only 25+ bps moves carry (70.7% at minute 15, 86% at minute 120) and the book prices those about fairly. So the early 4h lean is noise and its cheaper side is underpriced: a mirror of the 15m ahead family, not a port of it. Small samples (about 6 windows a day per coin); judged by the fillable column, with 4h asks persisting 96% (round 60)." },
  { name: "ahead5-cheap60-15m-first3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, added: "2026-10-30", idea: "15-minute markets, minutes 0.5-3: the underlying is 5+ bps from the open and the side it favours still asks 35-60c; buy it. Round 71 (30 Oct 2026, $HOME/an/taker15b.py) asked whether Binance taker flow in the first two minutes adds anything to the round-69 early-move carry on the 14-day 15m history (7 coins, 9,700 windows, move side priced at the minute-2 print +3c, 7% fee): it does not. Conditioned on the ask, every flow bucket lands within $0.03 of the others: move side at 35-50c +$0.36 per $1 (n=286, 62% won), 50-60c +$0.12 (781, 63%), 60-70c +$0.01 (1,412), 70c+ -$0.02 (3,394, 79% won). The one flow effect is the crowd overpaying: when heavy taker flow agrees with the move the 60-70c cell is -$0.01 against +$0.05 with neutral flow, and 70c+ is the worst cell in every bucket. So the edge, if real, is a price edge (the book under-reacting to a small move) and the paper rule needs only the ask: the move side at 60c or less, which ahead10-mid65-15m-first3 covers only for 10+ bps moves and up to 65c. Caveats: the minute-2 print lags the live ask (round 45 artifact; +3c applied), and 15m asks persist 81% (round 60). Judged by the fillable column." },
  { name: "cross5x3-flat-cheap50-15m", left: 0, cap: 0.5, minAsk: 0.3, size: 5, aheadBp: 5, crossAheadBp: 5, crossAheadCoins: 3, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, added: "2026-10-30", idea: "15-minute markets, minutes 0.5-3: three or more OTHER coins are 5+ bps from their open in one direction while this coin is still within 5 bps of its own; buy the side the others moved toward, but only while it still asks 30-50c. Round 72 (30 Oct 2026, $HOME/an/cross15.py) asked whether a market-wide early move carries to a coin that has not moved yet, on the 14-day 15m history (7 coins, Binance 1-min closes at minute 2, alt priced at its minute-2 print +3c, 7% fee). Mostly no: with 3+ others down and the coin flat the down side wins 59.2% (n=601) for -$0.01 per $1; with 3+ others up and the coin flat the up side wins 52.2% (602) for -$0.10; BTC alone leading does no better (51-53%, -$0.06..-$0.10). The lead only looks good when the coin has already moved itself (74-75%), which is the own-move carry of rounds 69 and 71, not a cross-coin effect. The one cell left is the cheap side: lead side under 50c wins 59% / 46% for +$0.33 (109) and +$0.09 (133), because a flat coin whose book has already drifted the other way is priced like a loser and is not. 65c+ loses -$0.19..-$0.35 in every lead cell. A small-sample probe (about 240 cases in 14 days), measured by the fillable column; new crossAheadBp/crossAheadCoins/ownMaxBp options." },
  { name: "calm10-down50-15m-min10", left: 0, cap: 0.5, minAsk: 0.4, size: 5, flatBp: 10, flatLeft: [240, 360], onlySide: "DOWN", minWindowSec: 900, maxWindowSec: 900, added: "2026-10-31", idea: "15-minute markets, minutes 9-11: the underlying is still within 10 bps of the open and DOWN is the cheaper side at 40-50c; buy DOWN. Round 73 (31 Oct 2026, $HOME/an/path15.py) read the UP price path of 9,700 15m windows (14 days, 7 coins) for mid-window reversals: when UP is back at 40-60c at minute 8 or 10 after having been 70c+ (or 30c-) earlier, the side that led earlier wins 53-55% but at a fair price (-$0.02..-$0.04 per $1 at the current print +3c, fee incl; n=366-484 per cell) and the other side loses -$0.11..-$0.15, so the round trip carries no tradeable momentum. The only cell with anything left is the calm one: UP 40-60c at minute 10 in a window that never left 30-70c resolves DOWN 58.6% (+$0.097 per $1, n=244; minute 8 54.3% +$0.013, n=499), i.e. the mid-window book leans UP more than it should when nothing has happened. Caveats: the 14-day sample itself resolved UP only 47-49% of the time, so part of this is drift; the live rule proxies 'calm' with |move| <= 10 bps from the open, not the ask range; and it only fires when DOWN is the cheaper side. A probe, judged by the fillable column." },
  { name: "ahead5-cheap60-15m-noxrp", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, skipCoins: ["xrp"], added: "2026-10-31", idea: "ahead5-cheap60-15m-first3 without XRP. Round 74 (31 Oct 2026, $HOME/an/hour15.py) split the round-71 cell (15m, 5+ bps from the open by minute 2, move side at 35-60c, minute-2 print +3c, 7% fee; 14 days, 7 coins, n=1,450, 63.6% won, +$0.153 per $1) by hour of day, coin, weekday and side, looking for a filter. There is none to add: every 4-hour KST block is green (+$0.09 at 08-12 KST to +$0.23 at 04-08, n=166-317), weekday +$0.154 (1,209) vs weekend +$0.149 (241), DOWN +$0.17 vs UP +$0.13, and six of seven coins sit at +$0.14..+$0.23 per $1 (ETH +$0.23, BTC +$0.21, BNB +$0.17, SOL +$0.16, HYPE +$0.15, DOGE +$0.14). The one weak coin is XRP: 58.2% won, +$0.03 per $1 (n=201), the only cell near zero. A uniform effect across hours and coins is what a real mispricing looks like (a lucky one is lumpy), which is the encouraging part; the discouraging part is that it is still 1-minute prints, and the live sibling has 39 fillable trades. This variant drops XRP so the two can be compared on the same hours; new skipCoins option." },
  { name: "ahead5-mid55-15m-first30", left: 0, cap: 0.55, minAsk: 0.45, size: 5, aheadBp: 5, flatLeft: [840, 870], minWindowSec: 900, maxWindowSec: 900, added: "2026-10-31", idea: "15-minute markets, seconds 30-60 only: the underlying is 5+ bps from the open and the side it favours still asks 45-55c; buy it. Round 75 (31 Oct 2026, $HOME/an/book15.py) replayed the round-71 rule on the REAL 1-second 15m books (data/<coin>15m-book, 20-31 Oct, 7 coins) instead of 1-minute prints, with the lab's fillable test (the same ask with 5+ shares still there 2-5 s later, filled at that later ask, 7% fee): 1,115 signals, 839 fillable, 60.4% won, +$0.072 per $1 (missed tickets 65.6% +$0.14, so some adverse selection but the fillable half stays green). That is the first rule to survive real books fillable-positive over 800 trades, but it is thin and lumpy: 4 red days of 12 (25-28 Oct, -$0.01..-$0.17), 55-60c asks (78% of trades) only +$0.04, and entries after the first 30 s make nothing (+$0.01 at 60-120 s, -$0.02 at 120-200 s). The money sits in the first 30 s and the 45-55c zone: 45-55c +$0.19 (169; first 30 s +$0.22, n=126, 61.9% won, 2 red days of 12), 10-20 bps moves +$0.28 (57). This variant is that cell; its sibling ahead5-cheap60-15m-first3 keeps the wide version for comparison. About 10 fillable trades a day across 7 coins, so 100 trades takes ~10 days." },
  { name: "ahead5-lead2-mid60-15m-first30", left: 0, cap: 0.6, minAsk: 0.45, size: 5, aheadBp: 5, aheadLeadBp: 2, flatLeft: [840, 870], minWindowSec: 900, maxWindowSec: 900, added: "2026-10-31", idea: "15-minute markets, seconds 30-60: Chainlink is 5+ bps from the open AND Binance is a further 2+ bps ahead of Chainlink in the same direction (over the coin's usual gap); buy the favoured side at 45-60c. Round 76 (31 Oct 2026, $HOME/an/book15b.py) split the round-75 real-book fillable trades (839, 20-31 Oct, 7 coins) by whether Binance confirmed the move: when Binance lagged Chainlink the rule made +$0.04 per $1 (n=506, 59.1% won); when Binance was ahead +$0.14 (354, 63.6%); 2+ bps ahead +$0.18 (171, 65.5%); 2+ bps ahead in the first 30 s +$0.24 (116, 69.0% won); 6+ bps ahead +$0.42 (46, 78%). Binance's own move from the open says the same: under 0 bps -$0.05 (79), 0-5 +$0.04 (311), 5-10 +$0.11 (336), 10+ +$0.19 (134). So the 15m book is slow to price what Binance already shows, the same mechanism as the 5m feed-lead family but at the minute scale and on asks that persist (81%, round 60). New aheadLeadBp option (feedLead needs ~5 minutes of samples per series before it fires). Judged by the fillable column; still a real-book replay, not live proof." },
  { name: "ahead5-wide15-mid60-15m-first30", left: 0, cap: 0.6, minAsk: 0.45, size: 5, aheadBp: 5, minOverround: 1.015, flatLeft: [840, 870], minWindowSec: 900, maxWindowSec: 900, added: "2026-10-31", idea: "15-minute markets, seconds 30-60: Chainlink 5+ bps from the open, favoured side at 45-60c, and the book is WIDE (best UP ask + best DOWN ask >= 1.015). Round 77 (31 Oct 2026, $HOME/an/book15c.py) split the round-75 real-book fillable trades (839, 20-31 Oct, 7 coins) by the book at the signal. Width is the one thing that mattered, and the other way round from the round-20 maxOverround idea: tight books (overround 1.005-1.015, two thirds of the trades) made +$0.04 per $1 (n=562, 59.1% won), 1.5-3c books +$0.11 (157, 63.1%), 3-6c books +$0.10 (136, 61.8%); in the first 30 s tight +$0.08 (320) against +$0.17 and +$0.18 for the two wider bands (105 each, 65.7% won). The reading: a wide book is a maker who has not yet re-quoted after the move, so the favoured ask is the stale one; a tight book has already been repriced. Best-ask size (5-50 shares +$0.09, 50-200 +$0.09, 200-1000 $0.00) and top-10 depth (+$0.06..+$0.09 in every band) did not matter, and small asks fill 73% of the time against 81-87% for bigger ones. New minOverround gate. Real-book replay, judged by the fillable column." },
  { name: "ahead5-max10-mid65-1h-first10", left: 0, cap: 0.65, minAsk: 0.45, size: 5, aheadBp: 5, maxMoveBp: 10, maxOverround: 1.03, flatLeft: [3000, 3540], minWindowSec: 3600, maxWindowSec: 3600, added: "2026-10-31", idea: "1-hour markets, minutes 1-10: Chainlink is 5-10 bps from the open (not more), the favoured side asks 45-65c and the book is tight (overround under 3c); buy it. Round 78 (31 Oct 2026, $HOME/an/book1h.py) replayed the early-move rule on the real 1-second 1h books (data/<coin>1h-book, only 29-31 Oct so far, 7 coins) with the fillable test and the 7% fee: 208 signals, 182 fillable, 62.1% won, +$0.04 per $1, days +$8.5 / +$5.6 / -$6.7 at $1 a trade. The shape is not the 15m shape: on 1h the small moves pay and the big ones lose (5-10 bps +$0.175, n=112, 68.8% won; 10-20 bps -$0.14, 48; 20+ bps -$0.25, 22), 65c+ asks lose -$0.32 (30), and wide books lose (overround 1.03+ -$0.02, n=124) while tight ones win (+$0.15, 48; +$0.30, 10), the reverse of round 77 on 15m: a wide 1h book is a wide book, not a stale one. Binance confirmation still helps (2+ bps ahead +$0.19, 49, 71%; lagging +$0.10). Only two and a half days of books, about 70 fillable trades a day across 7 coins, so this is the probe that collects the sample; its sibling ahead5-mid65-1h-early (minutes 5-15, any move size) is fillable 41/66 -$9 so far." },
  { name: "fav88-15m-late-wide", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, added: "2026-10-31", idea: "control probe, expected to make about nothing: the 15m favourite at 88-93c with 60-180 s left, only when the book is 1.5c+ wide. Round 79 (31 Oct 2026, $HOME/an/fav15.py) replayed the late favourite on the real 1-second 15m books (20-31 Oct, 7 coins, first row with 60-180 s left, ask 70-97c, fillable test, 7% fee): 1,643 signals, 1,227 fillable, 83.0% won, -$0.023 per $1, 8 red days of 12. Every band is within 6c of fair: 70-80c -$0.06 (408, 68.1% won), 80-88c -$0.01 (198), 88-93c +$0.00 (160, 89.4%), 93-97c -$0.01 (461, 94.6%); move size 0-5 bps -$0.06, 5-10 $0.00, 10-20 -$0.01, 20+ -$0.02; Binance 2+ bps ahead -$0.02 and 2+ behind -$0.03; the missed tickets +$0.07. The only cell above water is the 1.5-3c-wide book, +$0.03 (199, 87.9%), hence this probe. So the 15m favourite is priced right at the close, the same verdict as the 5m favourite (predbot-static-entry-verdicts) and the daily favourite (round 65): a 90%+ win rate with nothing left after the fee. What pays on 15m is the first minute, not the last three." },
  { name: "ahead5-bin5-mid60-15m-first3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, binAheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, added: "2026-10-31", idea: "15-minute markets, seconds 30-180: BOTH Chainlink and Binance are 5+ bps from their own opens in the same direction; buy that side at 35-60c. Round 80 (31 Oct 2026, $HOME/an/bin15.py) asked whether the 15m book lags Binance or lags Chainlink, on the real 1-second books (20-31 Oct, 7 coins, fillable test, 7% fee): take the first row where Binance is 5+ bps from its own open and buy the Binance side. 1,123 signals, 667 fillable, 57.3% won, +$0.03 per $1 overall, but it splits cleanly on Chainlink: when Chainlink had also moved 5+ bps the same way +$0.097 (n=296, 62.2% won); Chainlink 2-5 bps +$0.03 (260); Chainlink flat (under 2 bps) -$0.085 (90, 47.8%); Chainlink 2+ bps against -$0.41 (21, 28.6%). Binance alone, with Chainlink not yet confirming, is -$0.02 (371, 53.4%, 5 red days of 12) and in the first 30 s -$0.07 (232). So the book lags the settlement oracle, not the exchange: Chainlink moving is the signal, Binance agreeing is a confirmation (round 76) and Binance alone is not a trade on 15m. This variant is the both-moved cell, the strict form of ahead5-cheap60-15m-first3 (same window, same asks). New binAheadBp option (needs the Binance open row, so a restart mid-window skips that window)." },
  { name: "fresh5-mid70-15m-min3-12", left: 0, cap: 0.7, minAsk: 0.5, size: 5, aheadBp: 5, freshSec: 10, flatLeft: [180, 720], minWindowSec: 900, maxWindowSec: 900, added: "2026-10-31", idea: "control probe: the FIRST 5-bps Chainlink crossing that happens between minute 3 and 12 of a 15m window (price was inside 5 bps of the open up to 10 s before), favoured side at 50-70c. Round 81 (31 Oct 2026, $HOME/an/fresh15.py) looked for the early-move lag later in the window on the real 1-second books (20-31 Oct, 7 coins, fillable test, 7% fee): such fresh mid-window crossings are rare (99 in 12 days, 85 of them BTC and ETH; the small coins are already 5 bps away inside the first 3 minutes) and priced about right: 77 fillable, 66.2% won, +$0.016 per $1, 6 red days of 12; 60-70c asks +$0.03 (66), 50-60c -$0.06 (11); the book that is still wide pays (+$0.17, n=15) and the tight one does not (-$0.02, 62), consistent with round 77. So the lag the early rules exploit is a first-minutes effect: by minute 3 the 15m makers have found their feet and a new move is priced within a few cents at once. New freshSec option; this probe mostly checks that the live asks agree." },
  { name: "feed3-up40-tight", left: 0, cap: 0.4, minAsk: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", microGap: 0.02, added: "2026-10-30", idea: "feed3-up40-min20 only when the UP microprice sits within 2c of the best ask, i.e. the bid side carries enough size to hold the price (microprice = ask x bid shares + bid x ask shares over both). Round 56 on the 25-28 Oct 1-s books (6 coins 5m, $HOME/an/micro1.py, feed trigger: Binance 3+ bps over its usual gap, 120-200 s left, first hit per window): at 20-40c the within-2c cell wins 36.1% and makes +$1.64/trade (n=219) while the far-under cell (thin bid or wide spread) wins 23.2% and loses -$1.17 (n=69); at 40-60c the split goes the other way but both cells are positive (+$0.26 / +$0.60). The no-lead control is negative in every cell (-$0.34..-$1.01), so the microprice does not trade on its own; it filters the cheap feed tickets." },
  { name: "binmom3-mid65-late", left: 0, cap: 0.65, minAsk: 0.5, size: 5, binMoveBp: 3, binMoveSec: 60, jumpMinLeft: 60, added: "2026-10-30", idea: "the favourite at 50-65c when Binance moved 3+ bps its way over the last 60 s (any window length, 60+ s left, one trade per window). Round 57 on 14 days of 5m history (6 coins, ~16,000 favourite-zone marks at minutes 2 and 3, 1-min UP prints, Binance 1-min candles, $HOME/an/taker1.py): the favourite whose direction the just-closed Binance minute agrees with won 73.7% (+$0.231 per $1, n=6,568) against 37.7% (-$0.371) when the minute went against it and 57.0% base; taker-buy share agreeing 65.6% (+$0.095) vs 47.4% (-$0.206). Too good to be true: the 1-minute UP prints lag the candle (the round 45 stale-tape artifact), and round 35 found Binance flow fully priced by the 60 s mark on 1-s books. So this is the live check with real asks: if the 50-65c favourite plus a 60 s Binance move really wins 65%+ it is the high-win-rate rule enrique asked for on 30 Oct 09:07 KST; if it comes in near 57% the replay was the tape artifact. Sibling of ahead5-mid65-late (which keys on Chainlink vs the open)." },
  { name: "ahead5-mid65-late-awake", left: 0, cap: 0.65, minAsk: 0.5, size: 5, aheadBp: 5, flatLeft: [60, 240], hoursUtc: [18, 15], added: "2026-10-30", idea: "ahead5-mid65-late outside 00:00-03:00 KST. Round 58 on 14 days of 5m history (6 coins, $HOME/an/aheadhour.py; Binance 1-min close 5+ bps from the open as the ahead signal, favoured side at 50-65c from the 1-min prints, first hit of minutes 1-4): the cell wins 73.0% (+$0.215 per $1, n=593) but by 3-hour KST block 00-03 is the one dead block, 60.0% won -$0.010 (n=120), against 73.7-80.4% (+$0.22..+$0.35) in 03-06, 06-09, 09-12, 18-21 and 21-24; 12-18 KST has too few prints to say (n<40). By coin XRP 82.7% +$0.375 (98), BNB 76.6%, SOL 72.4%, DOGE 70.3%, HYPE 69.0%, ETH 68.3%. The level itself is inflated by the stale-print artifact (round 45), so read the block pattern, not the 73%. Live since 09:13 KST at $2 on 7 coins; this twin shows what skipping the midnight block costs or saves." },
  { name: "ahead5-mid65-late-btc", left: 0, cap: 0.65, minAsk: 0.5, size: 5, aheadBp: 5, flatLeft: [60, 240], btcAheadBp: 3, added: "2026-10-30", idea: "ahead5-mid65-late only when BTC 5m is itself 3+ bps from its own open the same way (a market-wide move, not a coin-only wiggle). Round 59 on 14 days of 5m history (5 alts, $HOME/an/aheadcross.py; Binance 1-min close vs open, favoured side 50-65c, first hit of minutes 1-4): with BTC agreeing 74.1% won +$0.229 per $1 (n=344), BTC flat 69.9% +$0.165 (193), BTC opposing almost never happens (n<30: alts rarely move 5 bps against BTC moving 3). So the BTC filter adds about +$0.06 per $1 and keeps 64% of the trades; by coin XRP 81.7% +$0.351, SOL 74.1%, BNB 74.4%, ETH 71.9%, HYPE 71.9%, DOGE 71.2%. Levels inflated by stale prints (round 45); the live lab decides whether the filter is worth the lost trades." },
  { name: "feed2-open-mid", left: 0, cap: 0.7, minAsk: 0.3, size: 5, feedLeadBp: 2, jumpMinLeft: 285, feedMaxLeft: 299, maxWindowSec: 300, added: "2026-10-30", idea: "the feed lead read in the first 15 seconds of a 5m window, both sides, ask 30-70c: does the oracle gap at the OPEN say which way the window goes? Round 49 on the 25-28 Oct 1-s books (6 coins 5m, $HOME/an/opengap1.py and opengap2.py): the raw Binance-vs-Chainlink gap at the first second is a no-go, following it at 8+ bps wins 47.6% and loses -$0.45/trade (n=3,027), every coin negative. Against the coin's rolling median gap (the same read the feed rules use) it looks fairer: 2+ bps n=186, 58.6% won, +$0.10/trade (ETH +$1.07 on 45, XRP -$0.68 on 48), under 2 bps -$0.29..-$0.59. Too thin to trust, so a live probe; expect few trades and about fair value." },
  { name: "feed3-down20-mid", left: 0, cap: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "DOWN", clOpenBp: [4, 10], added: "2026-10-29", idea: "the one DOWN cell the feed lead pays in: Binance 3+ bps under Chainlink (over its usual gap), DOWN ask <=20c, Chainlink 4-10 bps above the open. Round 32 (25-28 Oct 1-s books, 6 coins): the DOWN mirror of the feed rule is flat at every price, <=20c 13.4% won -$0.64/trade (n=463), 20-40c 32.7% -$0.02 (649), 40-60c 51.9% -$0.07 (913), while UP makes +$3.90, +$0.89 and +$0.11 in the same buckets: the edge is Polymarket underpricing cheap UP, not the feed lead itself. By how far DOWN trails the open at <=20c: over 10 bps 9.4% won -$1.64 (342, the bulk), 4-10 bps 24.5% +$2.06 (110), 1-4 bps 42.9% +$8.60 (7); DOWN with the lead 5+ bps 24.2% +$3.89 (33). So only a DOWN ticket that is cheap without the price being far gone is worth a test; expect few trades" },
  { name: "feed3-up40-halt6", left: 0, cap: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", selfHaltLosses: 6, selfHaltMin: 30, added: "2026-10-29", idea: "feed3-up40 with the real test's stop built in: after 6 straight losses on a coin it sits out 30 minutes. Round 31 (paper feed3-up40, 10 series, 526 closed trades since 25 Oct): the next trade after 6 or more straight losses won 43.3% (+$2.84/trade, n=30) against 33.5% (+$1.70) overall, after 3 or more 35.5% (+$1.74): a losing run says nothing about the next trade. Every coin has had a run of 6-9 losses (a 36% rule runs 6 losses in a row about once per 100 trades per coin), and sitting out 30 minutes after each run would have skipped 24 trades that won 45.8% and made +$90; 15 min skips +$65, 60 min +$89, 120 min +$50. The real test halted on 5 of 6 coins in its first 9 hours this way. This rule shows live what the stop costs next to plain feed3-up40" },
  { name: "feed3-up20-early", left: 0, cap: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 240, onlySide: "UP", added: "2026-10-29", idea: "feed3-up20 only in the first minute of the window (240+ s left). Round 30 (25-28 Oct 1-s books, 6 coins, feed3 triggers at UP <=20c, n=398): by seconds left at the trigger, 270-300 s 61.1% won +$14.61/trade (n=18), 240-270 s 33.3% +$12.77 (33), 180-210 s 23.7% +$4.25 (97), 210-240 s 19.3% +$2.45 (88), 150-180 s 16.5% +$2.42 (79), 120-150 s 10.8% +$0.59 (83): a cheap UP ask with Binance already leading early in the window has four minutes for Chainlink to follow, late in the window it is a lottery ticket. The 20-40c tickets show no time-left pattern (+$0.7 to +$2.3/trade in every band but one). Also by coin at 20-40c: BTC 46.3% +$2.78 (54), SOL 41.5% +$1.60 (142), BNB 41.7% +$1.86 (36), ETH 35.0% +$0.73 (137), DOGE 32.5% +$0.54 (117), XRP 30.3% -$0.05 (185)" },
  { name: "feed3-up40-near", left: 0, cap: 0.4, minAsk: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", clOpenBp: [1, 4], added: "2026-10-29", idea: "feed3-up40-min20 only when Chainlink is 1-4 bps under the open, i.e. UP is losing by a hair while Binance already leads. Round 29 (25-28 Oct 1-s books, 6 coins, feed3 triggers at UP 20-40c, n=671): Binance is already back above the open at 656 of 671 triggers while Chainlink is still below it at 649, so the trigger is Binance having crossed the open first. By how far Chainlink trails the open: 1-4 bps 46.8% won, +$2.26/trade (n=141); 4-10 bps 35.5%, +$0.88 (310); over 10 bps 31.2%, +$0.65 (157); within 1 bp 25.5%, -$1.50 (51, the ask is near 40c for a coin flip). Fee break-even at 30c is 30%. On the cheap <=20c tickets the split adds nothing (+$3.5 to +$4.1/trade everywhere)" },
  { name: "feed3-up40-pay3", left: 0, cap: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", payUpC: 3, added: "2026-10-29", idea: "feed3-up40 priced as if every fill paid 3c over the ask (levels shifted +3c, still capped at 40c): what a slipped FAK order would cost. Round 28 (25-28 Oct 1-s books, 6 coins, feed3 triggers): one second after a 20-40c trigger the UP ask has already risen in 55% of cases (median +1c, p75 +5c, p90 +11c), after 2 s in 63%; at trigger 20-40c makes +$0.57/trade (n=560), filled one second late at up to ask+3c +$0.39 (n=351), two seconds late +$0.28, five seconds late -$0.24: the 20-40c edge lives about 2 s. Cheap 3-20c triggers keep +$4.87/trade one second late and +$3.81 five seconds late. Round 27 found 27 real 20-40c orders rejected because the ask was gone, so this rule measures what paying up to catch them costs" },
  { name: "recover-up50", left: 0, cap: 0.5, minAsk: 0.3, size: 5, peakDrop: [0.8, 0.5], flatLeft: [55, 65], onlySide: "UP", added: "2026-10-29", idea: "collapsed favourite: at about one minute left, buy UP at 30-50c when UP had asked 80c or more earlier in the same window. Round 40 on the 14-day history (26,470 5m windows, 6 coins, 1-minute UP price samples, $HOME/an/collapse1.py): UP that peaked >=80c in minutes 1-3 and sits at 30-50c at minute 4 wins 44.6% against a 40% fee break-even, +$0.016 per $1 share (n=224); at 50-65c it is exactly fair (59.9%, +$0.000, n=282); the DOWN mirror loses (38.1%, -$0.042, n=223; 50-65c -$0.116) and the no-collapse control at 30-65c is fair (-$0.003, n=3,281). Thin and one-sided, so a probe. Same round, whale prints on the Polymarket tape are a no-go: windows with a $400+ print at minutes 2-4 resolve with the favourite 82-92% of the time but the print is at 90c, i.e. it follows the price; buying with the whale nets -$0.00 to -$0.12 per share in every size and side cell, and the tape is UP-token heavy (DOWN-favourite windows have almost no prints), so tape flow cannot be read for direction" },
  { name: "feed3-up60-mid", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", added: "2026-10-29", idea: "the feed trigger on the 40-60c UP tickets only, so it can run on real money next to feed3-up40 without ordering the same 20-40c ticket twice. Lab since 09:00 KST 28 Oct, feed3-up60-min20 by ask bucket (all coins, $5 paper): 40-50c 52.4% won +$0.59/trade (n=124), 50-60c 63.7% +$0.69 (n=135), 60c+ 79% +$1.42 (n=24), against 30% +$0.77 at 20-30c and 41% +$0.68 at 30-40c (n=109/94). Same money per trade as the cheap half with twice the win rate, so half the losing streaks: enrique 29 Oct 14:33 KST asked for rules that are not 30%-win lottery tickets" },
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
  // 30 Oct 2026 fresh-ideas thread (enrique: "we need better ideas for trading"): Binance-volatility fair value on the slow markets, scripts/slowmodel.py.
  { name: "model3-fav-1h", left: 0, cap: 0.95, minAsk: 0.5, size: 5, modelEdge: 0.03, modelLeft: [0.1, 1], minWindowSec: 3600, maxWindowSec: 3600, added: "2026-10-30", idea: "volatility model on the 1-hour markets: fair P(UP) = Phi(ln(Binance now / Binance at the open) / (6 h sigma of 1-min returns x sqrt(minutes left))); buy the FAVOURITE side when the model prices it 3c+ over the real best ask. 14-day history with last prints looks great everywhere (15m +$0.16/$1 on 10,148, 1h +$0.08 on 2,244) but that is stale prints: on the real 1-s books (29-30 Oct) the same rule loses -$0.15/$1 (99 trades, fillable -$0.19) because the underdog half bleeds; only the favourite half held up, 21 of 22 won, +$0.38/$1. Tiny sample, so a paper probe judged by its fillable column" },
  { name: "model3-fav-15m", left: 0, cap: 0.95, minAsk: 0.5, size: 5, modelEdge: 0.03, modelLeft: [0.1, 1], minWindowSec: 900, maxWindowSec: 900, added: "2026-10-30", idea: "control for model3-fav-1h on the 15m books (history with last prints: favourite side 68% won +$0.20/$1, n=3,404, 0 red days of 17; never checked on real asks). Shows whether the stale-print edge survives a real ask" },
  { name: "model-rest3-4h", left: 0, cap: 0.95, minAsk: 0.05, size: 5, modelEdge: 0, rest: 0.03, modelLeft: [0.1, 0.9], minWindowSec: 14400, maxWindowSec: 14400, added: "2026-10-30", idea: "maker, no fee: on the 4h markets rest a bid 3c under the volatility model's price for the side it favours; it fills only if someone sells down to it. Real 1-s books 29-30 Oct: 20 fills, 55% won, +$0.17/$1, 0 red days of 2 (1h same idea -$0.05, 24h 0 of 5). Taker on 4h books loses (-$0.47/$1). Small sample" },
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
  /** Fillable check (30 Oct 2026): 2-5 s after the signal, was the same side still asking within 1c of `ask` with 5+ shares (the Polymarket minimum)? null until checked. */
  fillable?: boolean | null;
  /** The ask seen at the fillable check. */
  fillAsk?: number;
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
function noteFeed(prefix: string, row: BookRow, windowSec = WINDOW_SEC) {
  noteFeedOne(prefix + "|binance", row.t, row.binance, row.chainlink);
  noteFeedOne(prefix + "|coinbase", row.t, row.coinbase, row.chainlink);
  noteFeedOne(prefix + "|xchg", row.t, row.binance, row.coinbase);
  if (/^[a-z]*5m-$|^$/.test(prefix)) {
    const lead = feedLead(prefix, row);
    if (lead != null) latestLead.set(prefix, { t: row.t, lead });
  }
  if (row.chainlink && row.open) latestAhead.set(prefix, { t: row.t, move: ((row.chainlink - row.open) / row.open) * 1e4, windowSec });
}
/** How many OTHER series of the same window length moved `bp`+ bps from their open in the given direction within the last 3 s (crossAheadBp rule). */
function crossAheads(prefix: string, t: number, windowSec: number, bp: number, up: boolean): number {
  let n = 0;
  for (const [k, v] of latestAhead) if (k !== prefix && v.windowSec === windowSec && t - v.t <= 3000 && (up ? v.move >= bp : -v.move >= bp)) n++;
  return n;
}
/** Fine round price levels per coin for the roundBp rule (the grid the replay used). */
const ROUND_GRID: Record<string, number> = { btc: 100, eth: 10, sol: 1, xrp: 0.01, doge: 0.001, bnb: 5, hype: 1 };
/** Upper-tercile 5m window range (bps, Chainlink high minus low) per coin on the 25-28 Oct 2026 1-s books; above it a window counts as "wild". */
const CALM_RANGE: Record<string, number> = { btc: 10.2, eth: 15.9, sol: 16.6, xrp: 18.1, doge: 16.2, bnb: 11.0, hype: 16 };
/** The last ~5 min of the Binance futures-minus-spot basis per series (bps), for the basisBp rule. */
const basisTails = new Map<string, { t: number; b: number }[]>();
function noteBasis(prefix: string, row: BookRow) {
  if (row.futures == null || row.binance == null || !row.binance) return;
  let a = basisTails.get(prefix);
  if (!a) basisTails.set(prefix, (a = []));
  if (a.length && a[a.length - 1].t === row.t) return;
  a.push({ t: row.t, b: ((row.futures - row.binance) / row.binance) * 1e4 });
  while (a.length && a[0].t < row.t - 300_000) a.shift();
}
/** Basis change in bps over the last `sec` seconds (vs the first print at or before t - sec); null when the tail does not reach back that far. */
function basisMove(prefix: string, t: number, sec: number): number | null {
  const a = basisTails.get(prefix);
  if (!a || a.length < 2) return null;
  const since = t - sec * 1000;
  let ref: { t: number; b: number } | null = null;
  for (const q of a) {
    if (q.t <= since) ref = q;
    else break;
  }
  if (!ref) return null;
  return a[a.length - 1].b - ref.b;
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
/** Each 5m series' latest Chainlink move from the window open (bps), for the btcAheadBp rule. */
const latestAhead = new Map<string, { t: number; move: number; windowSec: number }>();
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
/** Per window, the highest ask each side has shown so far (for the peakDrop rule). */
const peaks = new Map<string, { window: number; up: number; down: number }>();
function notePeak(prefix: string, row: BookRow) {
  const up = row.upAsks[0]?.[0] ?? row.upAsk ?? null;
  const down = row.downAsks[0]?.[0] ?? row.downAsk ?? null;
  const cur = peaks.get(prefix);
  if (!cur || cur.window !== row.window) { peaks.set(prefix, { window: row.window, up: up ?? 0, down: down ?? 0 }); return; }
  if (up != null) cur.up = Math.max(cur.up, up);
  if (down != null) cur.down = Math.max(cur.down, down);
}
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

/** Binance 1-minute closes per coin (the last ~6.5 h), for the modelEdge rule; saved so a restart does not lose the warm-up. */
const volMinutes = new Map<string, [number, number][]>(Object.entries(loadJson<Record<string, [number, number][]>>("vol-minutes.json", {})));
let volSaved = 0;
/** "" is BTC 5m; every other prefix starts with the coin ("eth5m-", "sol1h-"). */
const symbolOf = (prefix: string) => (prefix === "" ? "btc" : (/^([a-z]+)\d/.exec(prefix)?.[1] ?? prefix));
function noteVol(prefix: string, row: BookRow) {
  if (row.binance == null || !row.binance) return;
  const sym = symbolOf(prefix);
  let a = volMinutes.get(sym);
  if (!a) volMinutes.set(sym, (a = []));
  const m = Math.floor(row.t / 60000);
  if (a.length && a[a.length - 1][0] === m) a[a.length - 1][1] = row.binance;
  else if (!a.length || a[a.length - 1][0] < m) a.push([m, row.binance]);
  if (a.length > 400) a.splice(0, a.length - 400);
  if (Date.now() - volSaved > 60_000) {
    volSaved = Date.now();
    saveJson("vol-minutes.json", Object.fromEntries(volMinutes));
  }
}
/** Standard deviation of the coin's Binance 1-minute log returns over the last 6 h (consecutive minutes only); null under 2 h of data. */
function sigma1m(sym: string): number | null {
  const a = volMinutes.get(sym);
  if (!a) return null;
  const rs: number[] = [];
  for (let i = Math.max(1, a.length - 360); i < a.length; i++) if (a[i][0] === a[i - 1][0] + 1 && a[i - 1][1] > 0) rs.push(Math.log(a[i][1] / a[i - 1][1]));
  if (rs.length < 120) return null;
  const mu = rs.reduce((x, y) => x + y, 0) / rs.length;
  return Math.sqrt(rs.reduce((x, y) => x + (y - mu) ** 2, 0) / rs.length);
}
/** Binance price at each window's open, per series (first row seen in the window's first 10 s). */
const binOpen = new Map<string, number>();
function noteBinOpen(prefix: string, row: BookRow, windowSec: number) {
  const k = `${prefix}|${row.window}`;
  if (binOpen.has(k) || row.binance == null || !row.binance || row.left < windowSec - 10) return;
  binOpen.set(k, row.binance);
  if (binOpen.size > 500) binOpen.delete(binOpen.keys().next().value!);
}
/** Normal CDF (Abramowitz-Stegun 7.1.26 erf, error under 2e-7). */
function phi(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}
/** The model's P(UP) for this row, or null without enough data. Falls back to Chainlink vs the recorded open when the Binance open was not seen (restart mid-window). */
function modelUp(prefix: string, row: BookRow, windowSec: number): number | null {
  const sg = sigma1m(symbolOf(prefix));
  if (sg == null || row.left <= 0) return null;
  const b0 = binOpen.get(`${prefix}|${row.window}`);
  const ratio = b0 && row.binance ? row.binance / b0 : row.chainlink && row.open ? row.chainlink / row.open : null;
  if (ratio == null || !(ratio > 0)) return null;
  return phi(Math.log(ratio) / (sg * Math.sqrt(Math.min(row.left, windowSec) / 60)));
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

  /** Fillable check: 2-5 s after a paper entry, is the same side still asking within 1c with 5+ shares? Written once per trade. */
  private checkFillable(row: BookRow) {
    let dirty = false;
    for (const t of this.open) {
      if (t.fillable != null || t.window !== row.window || t.otherShares != null) continue; // null or missing: not checked yet (only take() sets the field explicitly)
      const age = row.t - t.t;
      if (age < 2000) continue;
      if (age > 5000) { t.fillable = false; dirty = true; continue; }
      const best = (t.side === "UP" ? row.upAsks : row.downAsks)[0];
      t.fillAsk = best?.[0];
      t.fillable = !!best && best[0] <= t.ask + 0.01 + 1e-9 && best[1] >= 5;
      dirty = true;
    }
    if (dirty) saveJson(this.openFile, this.open);
  }

  private count(t: PaperTrade) {
    if (t.pnl == null) return;
    this.trades += 1;
    if (t.won) this.won += 1;
    this.net += t.pnl;
    if (t.fillable === true) { this.fTrades += 1; if (t.won) this.fWon += 1; this.fNet += t.pnl; }
    else if (t.fillable === false) this.fMiss += 1;
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
  /** Fillable-scored totals (trades whose ask was still there with 5+ shares 2-5 s later) and the misses. */
  private fTrades = 0;
  private fWon = 0;
  private fNet = 0;
  private fMiss = 0;
  /** Windows where the favourite rule already saw its first hit (taken or filtered out); it never fires twice. */
  private favSeen = 0;
  /** For leadHoldSec: when the lead first went past the threshold toward UP / DOWN in the current run (ms), or null. */
  private leadSince: { up: number | null; down: number | null } = { up: null, down: null };
  /** The last ~3 s of (t, lead) for the leadJumpBp gate. */
  private leadTail: { t: number; lead: number }[] = [];

  consider(row: BookRow) {
    const { left: LEFT, cap: CAP, size: SIZE } = this.v;
    if (discarded().has(this.v.name)) return;
    this.checkFillable(row);
    if (this.v.salvageAt != null || this.v.stopBid != null || this.v.tpBid != null) this.considerExit(row);
    const prev = this.prevAsk?.window === row.window ? this.prevAsk : null;
    noteClose(this.prefix, row, this.windowSec);
    noteFeed(this.prefix, row, this.windowSec);
    noteRange(this.prefix, row, this.windowSec);
    noteTail(this.prefix, row);
    notePeak(this.prefix, row);
    noteBin(this.prefix, row);
    noteBasis(this.prefix, row);
    noteVol(this.prefix, row);
    noteBinOpen(this.prefix, row, this.windowSec);
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
    if (this.v.basisBp != null) return this.considerBasis(row);
    if (this.v.roundBp != null) return this.considerRound(row);
    if (this.v.flatBp != null) return this.considerFlat(row);
    if (this.v.aheadBp != null) return this.considerAhead(row);
    if (this.v.modelEdge != null) return this.considerModel(row);
    if (this.v.imbFade != null) return this.considerImb(row);
    if (this.v.peakDrop != null) return this.considerPeak(row);
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
      fillable: null,
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
    if (this.v.calmX != null) {
      const r = prevRange(this.prefix, row.window, this.windowSec);
      const typical = CALM_RANGE[this.prefix.replace(/\d+m-$/, "") || "btc"] ?? 15;
      if (r == null || r >= typical * this.v.calmX * (this.windowSec / 300)) return false;
    }
    if (this.v.minWindowSec != null && this.windowSec < this.v.minWindowSec) return false;
    if (this.v.maxWindowSec != null && this.windowSec > this.v.maxWindowSec) return false;
    if (this.v.skipCoins?.includes(this.prefix.replace(/\d+[mh]-$/, "") || "btc")) return false;
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
    if (this.v.minOverround != null) {
      const ua = row.upAsks[0]?.[0];
      const da = row.downAsks[0]?.[0];
      if (ua == null || da == null || ua + da < this.v.minOverround - 1e-9) return false;
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
    const floor = this.v.minAsk ?? 0.03;
    if (this.v.onlySide !== "DOWN" && move >= need && upBest != null && upBest <= CAP && upBest >= floor) pick = { up: true, ask: upBest };
    else if (this.v.onlySide !== "UP" && -move >= need && downBest != null && downBest <= CAP && downBest >= floor) pick = { up: false, ask: downBest };
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
    const floor = this.v.minAsk ?? 0.03;
    if (this.v.onlySide !== "DOWN" && move >= need && upBest != null && upBest <= CAP && upBest >= floor) pick = { up: true, ask: upBest };
    else if (this.v.onlySide !== "UP" && -move >= need && downBest != null && downBest <= CAP && downBest >= floor) pick = { up: false, ask: downBest };
    if (!pick || !this.leadOk(row, pick.up)) return;
    this.take(row, pick, CAP, SIZE, `Binance ${move >= 0 ? "+" : ""}${move.toFixed(1)} bps in ${sec} s`);
  }

  /** The `roundBp` rule: a window that opens just under a round price level tends to close above it. */
  private considerRound(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    if (row.left < (this.v.jumpMinLeft ?? 240)) return;
    if (this.open.some((t) => t.window === row.window)) return;
    if (!row.open) return;
    const grid = ROUND_GRID[this.prefix.replace(/\d+m-$/, "") || "btc"];
    if (!grid) return;
    const near = Math.round(row.open / grid) * grid;
    const d = ((row.open - near) / row.open) * 1e4;
    const need = this.v.roundBp ?? 3;
    const floor = this.v.minAsk ?? 0.03;
    const upBest = row.upAsks[0]?.[0] ?? null;
    const downBest = row.downAsks[0]?.[0] ?? null;
    let pick: { up: boolean; ask: number } | null = null;
    if (this.v.onlySide !== "DOWN" && d < 0 && -d <= need && upBest != null && upBest <= CAP && upBest >= floor) pick = { up: true, ask: upBest };
    else if (this.v.onlySide !== "UP" && d > 0 && d <= need && downBest != null && downBest <= CAP && downBest >= floor) pick = { up: false, ask: downBest };
    if (!pick) return;
    this.take(row, pick, CAP, SIZE, `open ${d.toFixed(1)} bps from ${near}`);
  }

  /** The `basisBp` rule: the perpetual's premium over spot widened (or shrank) over the last minutes, so the leveraged crowd leans that way. */
  private considerBasis(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    if (row.left < (this.v.jumpMinLeft ?? 240)) return;
    if (this.open.some((t) => t.window === row.window)) return;
    const sec = this.v.basisSec ?? 180;
    const move = basisMove(this.prefix, row.t, sec);
    if (move == null) return;
    const need = this.v.basisBp ?? 1.5;
    const floor = this.v.minAsk ?? 0.03;
    const upBest = row.upAsks[0]?.[0] ?? null;
    const downBest = row.downAsks[0]?.[0] ?? null;
    let pick: { up: boolean; ask: number } | null = null;
    if (this.v.onlySide !== "DOWN" && move >= need && upBest != null && upBest <= CAP && upBest >= floor) pick = { up: true, ask: upBest };
    else if (this.v.onlySide !== "UP" && -move >= need && downBest != null && downBest <= CAP && downBest >= floor) pick = { up: false, ask: downBest };
    if (!pick) return;
    this.take(row, pick, CAP, SIZE, `basis ${move >= 0 ? "+" : ""}${move.toFixed(2)} bps in ${sec} s`);
  }

  /** The `flatBp` rule: the claim that a market still 20-40c on one side while the price has not moved is mispriced. */
  private considerFlat(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    const [fl0, fl1] = this.v.flatLeft ?? [115, 125];
    if (row.left > fl1 || row.left < fl0 || row.chainlink == null || !row.open) return;
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
    this.take(row, { up, ask }, CAP, SIZE, `price ${move >= 0 ? "+" : ""}${move.toFixed(1)} bps from the open at ${Math.round((fl0 + fl1) / 120)} min, cheap side ${(ask * 100).toFixed(0)}c`);
  }

  /** The `aheadBp` rule: the 15-minute book lags the underlying at the minute scale (round 44 replay). */
  private lastInside: { window: number; t: number } | null = null;
  private considerAhead(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    const [fl0, fl1] = this.v.flatLeft ?? [180, 720];
    if (row.chainlink != null && row.open && Math.abs(((row.chainlink - row.open) / row.open) * 1e4) < (this.v.aheadBp ?? 3)) this.lastInside = { window: row.window, t: row.t };
    if (row.left > fl1 || row.left < fl0 || row.chainlink == null || !row.open) return;
    if (this.v.freshSec != null && (!this.lastInside || this.lastInside.window !== row.window || row.t - this.lastInside.t > this.v.freshSec * 1000)) return;
    if (this.open.some((t) => t.window === row.window)) return;
    const move = ((row.chainlink - row.open) / row.open) * 1e4;
    let up = move > 0;
    let crossNote = "";
    if (this.v.crossAheadBp != null) {
      if (Math.abs(move) > (this.v.ownMaxBp ?? this.v.aheadBp ?? 3)) return;
      const need = this.v.crossAheadCoins ?? 3;
      const nUp = crossAheads(this.prefix, row.t, this.windowSec, this.v.crossAheadBp, true);
      const nDn = crossAheads(this.prefix, row.t, this.windowSec, this.v.crossAheadBp, false);
      if (nUp >= need && nDn === 0) up = true;
      else if (nDn >= need && nUp === 0) up = false;
      else return;
      crossNote = `, ${up ? nUp : nDn} other coins ${up ? "+" : "-"}${this.v.crossAheadBp}+ bps from their open`;
    } else if (Math.abs(move) < (this.v.aheadBp ?? 3)) return;
    if (this.v.binAheadBp != null) {
      const b0 = binOpen.get(`${this.prefix}|${row.window}`);
      if (!b0 || !row.binance) return;
      const bm = ((row.binance - b0) / b0) * 1e4;
      if ((up ? bm : -bm) < this.v.binAheadBp) return;
      crossNote += `, Binance ${bm >= 0 ? "+" : ""}${bm.toFixed(1)} bps from its open`;
    }
    if (this.v.aheadLeadBp != null) {
      const lead = feedLead(this.prefix, row);
      if (lead == null || (up ? lead : -lead) < this.v.aheadLeadBp) return;
      crossNote += `, Binance ${up ? "+" : "-"}${Math.abs(lead).toFixed(1)} bps vs Chainlink`;
    }
    if (this.v.onlySide === "UP" && !up) return;
    if (this.v.onlySide === "DOWN" && up) return;
    const ask = (up ? row.upAsks[0]?.[0] : row.downAsks[0]?.[0]) ?? null;
    if (ask == null || ask < (this.v.minAsk ?? 0.1) || ask > CAP) return;
    if (this.v.btcAheadBp != null) {
      const b = latestAhead.get("");
      if (!b || row.t - b.t > 3000 || (up ? b.move < this.v.btcAheadBp : -b.move < this.v.btcAheadBp)) return;
    }
    if (!this.leadOk(row, up)) return;
    this.take(row, { up, ask }, CAP, SIZE, `price ${move >= 0 ? "+" : ""}${move.toFixed(1)} bps from the open with ${row.left}s left${crossNote}, ${up ? "UP" : "DOWN"} still ${(ask * 100).toFixed(0)}c`);
  }

  /** The `modelEdge` rule: buy the side the volatility model prices at least modelEdge over its best ask (or, with `rest`, rest a no-fee bid that far under the model price). One trade per window. */
  private considerModel(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    const [lo, hi] = this.v.modelLeft ?? [0.1, 1];
    const frac = row.left / this.windowSec;
    if (frac < lo || frac > hi || row.left < 1) return;
    if (this.open.some((t) => t.window === row.window) || this.favSeen === row.window) return;
    const p = modelUp(this.prefix, row, this.windowSec);
    const ua = row.upAsks[0]?.[0];
    const da = row.downAsks[0]?.[0];
    if (p == null || ua == null || da == null) return;
    const up = p - ua >= 1 - p - da;
    if (this.v.onlySide && (up ? "UP" : "DOWN") !== this.v.onlySide) return;
    const fair = up ? p : 1 - p;
    const ask = up ? ua : da;
    if (this.v.rest != null) {
      const price = Math.round((fair - this.v.rest) * 100) / 100;
      if (price < (this.v.minAsk ?? 0.05) || price > CAP) return;
      this.favSeen = row.window;
      if (ask <= price + 1e-9) return this.take(row, { up, ask }, price, SIZE, `model ${(fair * 100).toFixed(0)}c, ask already at ${(ask * 100).toFixed(0)}c`);
      this.resting = { window: row.window, up, price };
      return;
    }
    if (fair - ask < this.v.modelEdge! - 1e-9 || ask < (this.v.minAsk ?? 0.05) || ask > CAP) return;
    this.take(row, { up, ask }, CAP, SIZE, `model ${(fair * 100).toFixed(0)}c vs ask ${(ask * 100).toFixed(0)}c with ${Math.round(row.left / 60)} min left`);
  }

  /** The `imbFade` rule: resting depth as a crowd signal, faded (round 46 replay: following it loses, fading it is about fair). */
  private considerImb(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    const [fl0, fl1] = this.v.flatLeft ?? [175, 185];
    if (row.left > fl1 || row.left < fl0) return;
    if (this.open.some((t) => t.window === row.window)) return;
    const usd = (ls: [number, number][] | undefined) => (ls ?? []).reduce((a, l) => a + l[0] * l[1], 0);
    const upSide = usd(row.upBids) + usd(row.downAsks);
    const downSide = usd(row.upAsks) + usd(row.downBids);
    if (upSide + downSide <= 0) return;
    const pr = upSide / (upSide + downSide);
    const th = this.v.imbFade ?? 0.65;
    const up = pr <= 1 - th ? true : pr >= th ? false : null;
    if (up == null) return;
    if (this.v.onlySide === "UP" && !up) return;
    if (this.v.onlySide === "DOWN" && up) return;
    const ask = (up ? row.upAsks[0]?.[0] : row.downAsks[0]?.[0]) ?? null;
    if (ask == null || ask < (this.v.minAsk ?? 0.3) || ask > CAP) return;
    if (!this.leadOk(row, up)) return;
    this.take(row, { up, ask }, CAP, SIZE, `book leans ${up ? "DOWN" : "UP"} ${(Math.max(pr, 1 - pr) * 100).toFixed(0)}% by resting $, fading it at ${(ask * 100).toFixed(0)}c with ${row.left}s left`);
  }

  private considerPeak(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    const [fl0, fl1] = this.v.flatLeft ?? [55, 65];
    const [peakMin, nowMax] = this.v.peakDrop ?? [0.8, 0.5];
    if (row.left > fl1 || row.left < fl0) return;
    if (this.open.some((t) => t.window === row.window)) return;
    const pk = peaks.get(this.prefix);
    if (!pk || pk.window !== row.window) return;
    const upBest = row.upAsks[0]?.[0] ?? null;
    const downBest = row.downAsks[0]?.[0] ?? null;
    const cands: { up: boolean; ask: number; peak: number }[] = [];
    if (upBest != null && this.v.onlySide !== "DOWN" && pk.up >= peakMin && upBest <= nowMax) cands.push({ up: true, ask: upBest, peak: pk.up });
    if (downBest != null && this.v.onlySide !== "UP" && pk.down >= peakMin && downBest <= nowMax) cands.push({ up: false, ask: downBest, peak: pk.down });
    for (const c of cands) {
      if (c.ask < (this.v.minAsk ?? 0.3) || c.ask > CAP) continue;
      if (!this.leadOk(row, c.up)) continue;
      this.take(row, { up: c.up, ask: c.ask }, CAP, SIZE, `${c.up ? "UP" : "DOWN"} was ${(c.peak * 100).toFixed(0)}c earlier this window, now ${(c.ask * 100).toFixed(0)}c with ${row.left}s left`);
      return;
    }
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
    if (this.v.askUsd) {
      const best = (pick.up ? row.upAsks : row.downAsks)[0];
      const usd = best ? best[0] * best[1] : 0;
      if (usd < this.v.askUsd[0] || usd >= this.v.askUsd[1]) return;
    }
    if (this.v.microGap != null) {
      const bestAsk = (pick.up ? row.upAsks : row.downAsks)[0];
      const bestBid = (pick.up ? row.upBids : row.downBids)[0];
      if (!bestAsk || !bestBid || bestAsk[1] <= 0 || bestBid[1] <= 0) return;
      const micro = (bestAsk[0] * bestBid[1] + bestBid[0] * bestAsk[1]) / (bestAsk[1] + bestBid[1]);
      if (bestAsk[0] - micro > this.v.microGap) return;
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
    return { name: this.v.name, size: SIZE, added: this.v.added ?? null, idea: this.v.idea ?? null, discarded: discarded().has(this.v.name), rule: this.v.arbSum != null ? `both sides whenever the asks add up to ${Math.round(this.v.arbSum * 100)}c or less, $${SIZE} each` : this.v.prevDir != null ? `first ${this.v.first}s, ${this.v.prevDir === "same" ? "with" : "against"} the last close, ask <= ${Math.round(CAP * 100)}c, $${SIZE}` : this.v.favAt != null ? `favourite when its ask reaches ${Math.round(this.v.favAt * 100)}c, ${this.v.favFrom != null ? (this.v.favTo != null ? `${this.v.favFrom}-${this.v.favTo}s in` : `from ${this.v.favFrom}s in`) : "any time"}, $${SIZE}` : this.v.first != null ? `first ${this.v.first}s, either side <= ${Math.round(CAP * 100)}c, $${SIZE}${this.v.salvageAt != null ? `, sell at ${this.v.salvageAt}s left if bid <= ${Math.round((this.v.salvageBid ?? 0) * 100)}c` : ""}` : `<=${LEFT}s, ask ${this.v.floor ? Math.round(this.v.floor * 100) + "c to " : "<= "}${Math.round(CAP * 100)}c${this.v.noFall ? ", not falling" : ""}, $${SIZE}`, trades: this.trades, won: this.won, net: Math.round(this.net * 100) / 100, fillable: { trades: this.fTrades, won: this.fWon, net: Math.round(this.fNet * 100) / 100, miss: this.fMiss }, open: this.open.length, noAsk: this.noAsk, days: [...this.byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)) };
  }
}
