import { SERIES, WINDOW_SEC, kstDay, prefixOf } from "./config.js";
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
  /** For favAt: Binance must be at least this many bps ahead of Chainlink (over the series' usual gap, see feedLead) in the favourite's direction at the first hit. */
  favBinLeadBp?: number;
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
  /** Previous-window relation (round 102, 1 Nov 2026): for the aheadBp and favAt rules, the side taken must be "opposite" to (or the "same" as) the way the previous window of this series closed (the book's favourite at its last snapshot); skipped when that close was not seen. */
  prevRel?: "same" | "opposite";
  /** BTC agreement (round 103, 1 Nov 2026): for the favAt rule on a non-BTC series, the BTC series of the same window length must be at least this many bps from its own open in the favourite's direction (Chainlink, within the last 3 s); skipped when BTC is flat, opposed or not seen. */
  btcAgreeBp?: number;
  /** Round 107 (1 Nov 2026): for the aheadBp rule on a non-BTC series, skip when the BTC series of the same window length is this many bps or more from its own open AGAINST the side we would buy (Chainlink, within the last 3 s); BTC flat or agreeing passes, BTC not seen passes. */
  btcNotAgainstBp?: number;
  /** Round 104 (1 Nov 2026): when true, prevRel and btcAgreeBp are an OR (pass when either holds) instead of both being required; the only cell skipped is "BTC not confirming AND the previous window closed the same way". */
  eitherGate?: boolean;
  /** Round 108 (1 Nov 2026): for the favAt rule, how the favourite relates to the window's own early move (this series' Chainlink vs its open at minutes 1.5-2.5): "continue" = the favourite is the side of a favEarlyBp+ bps early move, "reverse" = the other side of one (a V-shaped window), "flat" = the early move was under favEarlyBp (default 5); skipped when that minute was not seen. */
  favEarly?: "continue" | "reverse" | "flat";
  favEarlyBp?: number;
  /** Favourite rule (round 118, 1 Nov 2026): at least this many OTHER series of the same window length showed a favourite of `favAt`+ on the same side at the 20% mark of this window (lateFav note), i.e. the favourite has company across coins. */
  favBreadthMin?: number;
  /** Favourite rule (round 158, 3 Nov 2026): at most this many OTHER series of the same window length may show a favourite of `favAt`+ on the SAME side at the 20% mark (lateFav note); 0 = the favourite must be alone across coins. */
  favBreadthMax?: number;
  /** Favourite rule (round 141, 2 Nov 2026): at most this many OTHER series of the same window length may show a favourite of `favAt`+ on the OPPOSITE side at the 20% mark (lateFav note); 0 = skip when any other coin's favourite dissents. */
  favDissentMax?: number;
  /** Favourite rule (round 123, 2 Nov 2026): the side bought must have had its best ask at or under this price at some row with `favDipLeft` seconds left (default 180-360 s, i.e. 3-6 minutes before the end), so the favourite is fresh (the window was still open or leaning the other way a few minutes earlier) rather than a side that has sat at 88c+ for minutes near the strike; skipped when those rows were not seen. */
  favDipBelow?: number;
  favDipLeft?: [number, number];
  /** Favourite rule (round 119, 1 Nov 2026): on a 15m (or longer) series, the concurrent 5m market of the same coin (the 5m window that ends with this window) must show the favourite's side at this ask or higher, i.e. the last five minutes moved the favourite's way too; skipped when that 5m book is not seen within 5 s. */
  favShortMin?: number;
  /** 15m favourite gate (round 127): the PREVIOUS window's Binance range (high minus low, bps of its open) must be at least this fraction of the coin's median 15m range; skips the favourite that follows a dead window. */
  favPrevRangeMin?: number;
  /** Crowded-favourite gate (round 136): the dollars resting on the favourite's own BIDS within 3c under its best ask must stay below this, i.e. skip the favourite everybody is already queuing to buy. */
  favBidMaxUsd?: number;
  /** Round 109 (1 Nov 2026): for the aheadBp rule, the PREVIOUS window of this series must have been "contested" (its book favourite still under prevLateAt, default 0.88, with a fifth of the window left: 3 min on 15m) or "decided" (at or above it); skipped when that moment of the previous window was not seen. */
  prevLate?: "contested" | "decided";
  prevLateAt?: number;
  /** Round 110 (1 Nov 2026): for the aheadBp rule, at least one spot exchange (Binance or Coinbase) must itself be this many bps from the window's Chainlink open in the move's direction; a Chainlink-only move (neither exchange confirming) is skipped. */
  spotConfirmBp?: number;
  /** Round 112 (1 Nov 2026): for the aheadBp rule, the previous windows of this series must form a run of same-way closes whose length is within [min, max] (closeBook, so a restart leaves it unseen), and the side bought must be "against" (default) or "with" that run. */
  prevRun?: [number, number];
  prevRunRel?: "with" | "against";
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
  /** Family day-halt (round 147, 3 Nov 2026): after this many straight losses of THIS VARIANT across every series (one shared record per variant name, so a market-wide bad run on any coins counts), skip trades on all series until the next KST midnight. Round 140 found the early move's bad days are market-wide, so a per-series stop never sees them. */
  familyHaltLosses?: number;
  /** Round 175 (4 Nov 2026): with familyHaltLosses, sit out this many minutes after the streak instead of until KST midnight. */
  familyHaltMin?: number;
  /** Round 240 (7 Nov 2026): with familyHaltLosses, a window counts once toward the streak (its first settled trade);
   *  the other coins settling in the same window are skipped, so 3 coins losing one move is one loss, not three. */
  familyStreakPerWindow?: boolean;
  /** Round 170 (4 Nov 2026): at most this many entries per window across ALL coins of this window length for this variant (first come, first served). */
  familyMaxPerWindow?: number;
  /** Round 281 (8 Nov 2026): with familyMaxPerWindow, also skip the window right after one where the family took a trade
   *  (what live maxOpen 1 does in practice: the fill is still unsettled when the next window's signal comes). */
  familySkipNextWindow?: boolean;
  /** Round 151 (3 Nov 2026): take at most this many trades per KST day on this series, then sit out until KST midnight (in memory, so a restart resets the count). Tests the quiet-day finding: the feed rule's coin-days with few signals are the ones that win. */
  maxPerDay?: number;
  /** Round 280 (8 Nov 2026): trade a coin only when the named paper rule's net on THIS coin was positive on the previous KST day (round 198's prevDayGreenOf sums every coin). */
  prevDayCoinGreenOf?: string;
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
  /** Ahead-side rule (round 113, 1 Nov 2026): besides the coin's own move, at least this many OTHER series of the same window length must be `breadthBp` (default `aheadBp`) bps from their open the same way within the last 3 s, i.e. a market-wide move; counted from the same latestAhead prints as crossAheadBp. */
  breadthMin?: number;
  breadthBp?: number;
  /** Ahead-side rule (round 115, 1 Nov 2026): per-coin minimum move in bps (keys btc, eth, sol, xrp, doge, bnb, hype), replacing `aheadBp` for that coin, so that "moved" is judged against the coin's own usual 15-minute range. */
  aheadBpBy?: Record<string, number>;
  /** Round 227 (6 Nov 2026): for the aheadBp rule, skip rows where the move is MORE than this many bps (a jump the book already priced; server books: 8+ bp DOWN moves lose). */
  aheadMaxBp?: number;
  /** Round 228 (6 Nov 2026): for the aheadBp rule, buy the side AGAINST the move (filters above this point see the move's side; onlySide, cap and minAsk apply to the side bought). */
  aheadFade?: boolean;
  /** Ahead-side rule (round 116, 1 Nov 2026): the book's overround at the trigger (best UP ask + best DOWN ask) must lie in [lo, hi): a slightly wide book means the makers have stepped back after the move and the cheap asks left are stale. */
  aheadOverround?: [number, number];
  /** Round 121 (2 Nov 2026): for the aheadBp rule on a 15m series, the coin's concurrent 5m market (the 5m window that opened with this one) must still quote the side we buy UNDER this ask, i.e. the faster market has not repriced the move yet; skipped when that 5m book is not seen within 4 s or the 15m trigger is past the 5m window. */
  aheadShortMax?: number;
  /** 1h-market gate for the ahead rule: the coin's 1h book (window containing this one, fresh within 5 s) must quote the side we buy within [lo, hi) (round 125). */
  aheadHourAsk?: [number, number];
  /** 4h-market gate for the ahead rule (round 133): the coin's 4h book (window containing this one, fresh within 5 s) must quote the side we buy within [lo, hi). [0, 0.7) skips moves that merely extend a 4-hour run the 4h market has already priced. */
  aheadFourAsk?: [number, number];
  /** Regime gate for the ahead rule (round 135): the win rate of the last `aheadRegimeN` (default 10) resolved early moves across ALL series (one per series and window, at most 2 h old) must lie in [lo, hi); skipped while fewer than that many have resolved (e.g. right after a restart). */
  aheadRegime?: [number, number];
  aheadRegimeN?: number;
  /** Cross-market early move (round 134): instead of this series' own move, trigger on the coin's FASTER series (e.g. "15m") showing a fresh `aheadFromBp` move from its open within its first `aheadFromAge` seconds (default [30, 180]), and buy THAT side on this (slower) market. `aheadOwnMinBp` additionally requires this window's own move toward the side. One trade per window. */
  aheadFromSeries?: string;
  aheadFromBp?: number;
  aheadFromAge?: [number, number];
  aheadOwnMinBp?: number;
  /** Round-number barrier for the ahead rule (round 126): skip the move when a COARSE round level (BTC $500, ETH $50, SOL $5, XRP 5c, DOGE 0.5c, BNB $25, HYPE 50c) lies between the Chainlink price and the strike, or within this many bps behind the price in the move's direction. */
  aheadRoundClearBp?: number;
  /** Opening-lean gate for the ahead rule (round 128): the side we buy must have asked within [lo, hi) on the first row of the window (first 15 s), i.e. the book opened undecided. */
  aheadOpenAsk?: [number, number];
  /** Support gate for the ahead rule (round 131): on the side we buy, the dollars resting on BIDS within 3c under the best ask must be at least this fraction of the dollars on ASKS within 3c above it, i.e. buyers stand under the price we pay instead of a seller overhang above it. Scale-free, so it reads the same on a $20 DOGE book and a $2,000 BTC book. */
  aheadBidRatio?: number;
  /** Spread gate for the ahead rule (round 215, 6 Nov 2026): skip unless our side's best ask minus best bid is at most this many dollars (0.01 = a tight book). */
  aheadMaxSpread?: number;
  aheadAskStaleSec?: number;
  /** Early-move rule (round 142, 2 Nov 2026): where this window's Binance open sits in the PREVIOUS window's high-low range, measured toward the move's side (0 = at the far extreme, 1 = at the extreme the move heads for); the open must fall inside [from, to). [0, 0.5] = the move travels back across the old range. */
  aheadPrevPos?: [number, number];
  /** Exchange-lead gate for the ahead rule (round 146, 3 Nov 2026): Coinbase minus Binance in bps over the series' usual spread (xchgDev), measured toward the side we buy, must fall inside [from, to). [1, 99] = Coinbase leads the move (US flow), [-99, -1] = Binance leads. Null until the 600-row spread median exists. */
  aheadXchgLead?: [number, number];
  /** Pullback re-entry (round 143, 3 Nov 2026): the window's Binance price must have moved at least this many bps from its open within the FIRST 2 MINUTES (one side only), and now, inside `flatLeft` (default minutes 3-5, left 600-720), sit within `pullbackWithin` bps of the open measured toward that side (default [-3, 1]); buy the breakout side again if it asks between `minAsk` and `cap`. One trade per window. */
  pullbackBp?: number;
  pullbackWithin?: [number, number];
  /** Round 122 (2 Nov 2026): for the aheadBp rule (also the feed rule since round 149 and the favAt rule since round 155), do not buy at the trigger; arm the window and buy `confirmSec` seconds later at the then-current ask (up to `confirmCap`, default `cap`) only if the side's best ask never dipped `confirmDipC` (default 3c) below the trigger ask in between. One attempt per window. */
  confirmSec?: number;
  /** Round 149 (3 Nov 2026): with `confirmSec`, buy ONLY if the trigger ask is pulled or lifted (the side's best ask rises above it) within the wait, paying up to this many cents over the trigger ask and never over `confirmCap`; an ask still sitting there when the wait ends is skipped, a `confirmDipC` dip cancels. Works for the aheadBp and feed rules. Tests the lab's missed-ticket column live: the asks that vanish before the fill audit are the ones that win. */
  pulledChaseC?: number;
  confirmDipC?: number;
  /** Round 159 (3 Nov 2026): skip a signal that comes less than this many minutes after this rule's previous signal on this series (each window's first signal counts, taken or skipped; reset on restart). */
  coolMin?: number;
  confirmCap?: number;
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
  /** Round 176 (4 Nov 2026): with `rest`, cancel the resting bid this many seconds after it was placed (default: window end). Also works on the aheadBp and feed rules. */
  restSec?: number;
  /** Maker study (4 Nov 2026): with `rest`, book the fill only when the side's best ask goes strictly BELOW the bid (the price traded through it, so a real bid anywhere in the queue was filled), not when it merely touches; the fill is marked fillable. */
  restThrough?: boolean;
  /** Only trade when the UTC hour is inside [from, to). */
  hoursUtc?: [number, number];
  /** Round 132 (2 Nov 2026): skip windows whose trigger falls in any of these UTC hours (by the row's clock, like hoursUtc). Used for the two hours around the non-funding 4-hour candle closes (04, 12, 20 UTC), where the 15m early move loses. */
  skipHoursUtc?: number[];
  /** Round 198 (5 Nov 2026): trade only on KST days that follow a GREEN previous KST day for the named variant (paper net summed over every series). */
  prevDayGreenOf?: string;
  /** Round 117 (1 Nov 2026): skip the window that closes exactly on the hour (xx:55-xx:00 on 5m, xx:45-xx:00 on 15m), where the hourly markets settle too and late reversals cluster. */
  skipHourClose?: boolean;
  /** Round 105 (1 Nov 2026): only trade windows whose START falls in these quarters of the hour (0 = xx:00, 1 = xx:15, 2 = xx:30, 3 = xx:45). */
  quarters?: number[];
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
  { name: "ahead5-cheap60-15m-x4", left: 0, cap: 0.6, minAsk: 0.35, size: 20, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, added: "2026-10-31", idea: "sizing test: ahead5-cheap60-15m-first3 at $20 instead of $5, filled through the book levels up to the 60c cap as the paper trader does. Round 82 (31 Oct 2026, $HOME/an/out3 from book15c.py) measured how much money the favoured ask can take at the signal on the real 15m books (20-31 Oct, 1,163 signals, 880 fillable): the best ask holds a median $18 (p10 $3, p25 $6, p75 $53), with BTC $98 and ETH $22 but BNB, SOL, DOGE, XRP and HYPE only $6-9; the top-10 levels hold a median $1,300. 84% of fillable signals have $5+ at the best ask, 64% $10+, 46% $20+, and the edge does not depend on it: fillable net per $1 is +$0.07 at every liquidity threshold from $3 to $20 and +$0.06 at $50+. So $2-5 a trade fits every coin at the best price, $10 fits BTC and ETH, and anything bigger pays the next levels on the small coins. What replay cannot show is the ask reacting to a $20 taker; this rule measures that live, as binburst4-up20-x6 did for the 5m feed rule. Judged by the fillable column against ahead5-cheap60-15m-first3 (same signals at $5)." },
  { name: "ahead5-cheap70-15m-first3", left: 0, cap: 0.7, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, added: "2026-10-31", idea: "ahead5-cheap60-15m-first3 that chases: the 15m early-move ticket bought at whatever the ask is up to 70c instead of refusing above 60c. Round 83 (31 Oct 2026, $HOME/an/slow15.py, outslow/) re-ran the 1,252 signals on the real 15m books (20-31 Oct) with the fill taken 2-5, 5-10, 10-20, 20-40 and 40-80 s after the signal. Waiting for the same price (ask+1c, 5+ shares) fills 76%, 66%, 57%, 53%, 47% of signals and nets +$0.08, +$0.06, +$0.09, +$0.10, +$0.09 per $1; taking the ask that is there (5+ shares, up to 75c) keeps 99%, 98%, 98%, 96%, 90% of the trades at +$0.08, +$0.08, +$0.07, +$0.07, +$0.06 with a median slip of 0c, 0c, 0c, 1c, 2c. So the edge is not speed: the book takes about a minute to price a 5 bps Chainlink move, and a Mac-speed order loses little to a server-speed one. By the price actually paid at 2-5 s: 35-50c +$0.08 (n=109), 50-60c +$0.08 (744), 60-65c +$0.05 (350), 65-70c +$0.18 (34), 70-75c -$0.09 (3). This rule measures live what the 60-70c tickets the 60c cap throws away are worth; judged by the fillable column next to ahead5-cheap60-15m-first3." },
  { name: "ahead5-cheap60-15m-tp85", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, tpBid: 0.85, added: "2026-10-31", idea: "ahead5-cheap60-15m-first3 that sells into the bids once our side bids 85c instead of holding to the close. Round 87 exit study (31 Oct 2026, $HOME/an/exit15.py, outexit/) on the real 15m books 20-31 Oct: 965 fillable early-move entries (filled 2-5 s after the signal at the surviving ask), own-side bid path sampled every 5 s to the close. Holding nets +$0.062 per $1 (60.0% won). Every take profit is about the same or slightly worse: 70c bid +$0.057 (sells 81% of trades early, 577 of 782 would have won anyway), 75c +$0.059, 80c +$0.056, 85c +$0.060, 90c +$0.052, 95c +$0.060. Every stop loss is worse: at 10c bid +$0.048 (sells 43%, 43 of 419 still won), 15c +$0.037, 20c +$0.012 (sells 52%, 118 of 500 still won), 25c -$0.001, 30c +$0.001, 35c -$0.014; combined tp90+stop20 +$0.010, tp95+stop10 +$0.046. So this entry is a hold-to-close trade: the bid whipsaws through 20c in half the trades and a quarter of those come back, while the winners run to 90c+ in about two thirds of trades regardless. This rule is the live check of the least bad exit (85c), expected to match ahead5-cheap60-15m-first3 within a cent per $1 and to show whether real bids at 85c are actually there to sell into." },
  { name: "feed3-both40-15m-min30", left: 0, cap: 0.4, minAsk: 0.3, size: 5, feedLeadBp: 3, jumpMinLeft: 300, minWindowSec: 900, added: "2026-10-31", idea: "feed3-both40-15m without the 20-30c tickets: both sides, ask 30-40c, Binance 3+ bps over its usual gap to Chainlink, 5+ minutes left in a 15m window. Round 88 (31 Oct 2026) compared every paper rule on the Stockholm server (fresh Polymarket book) with the same rule on the Mac (stale book) over the same 16.5 hours since 30 Oct 23:38 KST, fillable trades only (123 rules with 40+ fillable trades on both; server/status.json on the server-data branch vs the Mac's paper files): the two agree on direction (correlation of per-rule net +0.70) but only 9 rules are green on both, 97 are red on both, 8 are green on the Mac and red on the server (feedp98-up20 Mac +$49 / server -$221, feed3-up40-min20 +$64 / -$10, feed3-up40-tp90 +$26 / -$55, ahead5-cheap60-15m-first3 +$30 / -$3 on 188) and 9 the other way (binburst4-up20-x6 Mac -$1,966 / server +$537, a lottery outlier). Green on both: feed3-both40-15m +$129 on each (Mac 70/189 won, server 101/292), feed3-both35-15m-early +$23 / +$90, up20-first60 +$29 / +$30, up20-first60-night +$136 / +$93, fav93-hold +$35 / +$17, fav88-15m-late-wide +$21 / +$11, feed3-up40-tight +$19 / +$27. The server misses fewer tickets (23% vs 28%). So the 15m feed rule is the one lead rule the fresh book confirms, but it wins only 35%; this rule drops its cheapest third to see if the 30-40c half carries the edge with a win rate nearer 45%, as round 26 found on the 5m feed rule." },
  { name: "ahead5-cheap60-15m-first3-us", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, hoursUtc: [12, 18], added: "2026-10-31", idea: "ahead5-cheap60-15m-first3 only from 21:00 to 03:00 KST (12-18 UTC, the US session). Round 89 (31 Oct 2026) split the 880 fillable early-move entries on the real 15m books (20-30 Oct, $HOME/an/out3 from book15c.py) by 3-hour KST block: 21-24 KST 169 trades 66% won +$0.187 per $1, 00-03 KST 161 trades 68% +$0.207, 09-12 KST 113 trades 64% +$0.137, 06-09 KST 72 61% +$0.084, 18-21 KST 118 59% +$0.048, 15-18 KST 98 57% -$0.023, 12-15 KST 77 48% -$0.125, 03-06 KST 72 47% -$0.184. So the 5 bps Chainlink move in the first 3 minutes is followed through when US desks are active and fades in the Asian lunch and the US night, which fits the lead being real-flow momentum rather than an oracle quirk. The all-hours rule made +$0.07 per $1; this block made +$0.20 on 330 trades, about a third of the signals. Also by weekday: Saturday 105 trades 69% +$0.21, Monday 61 54% -$0.05, the rest +$0.03..+$0.09. Both splits are post-hoc on 11 days, so this is a probe next to the all-hours rule, not a reason to change the real test." },
  { name: "fav88-15m-late-bin2", left: 0, cap: 0.97, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, favBinLeadBp: 2, minWindowSec: 900, maxWindowSec: 900, added: "2026-10-31", idea: "the 15m favourite at 88-97c with 60-180 s left, only when Binance is 2+ bps ahead of Chainlink (over its usual gap) in the favourite's direction, i.e. the settlement feed still has to catch up towards the favourite. Round 90 (31 Oct 2026, $HOME/an/outfav from fav15.py: first favourite look at 180 s left on the real 15m books, 20-30 Oct, fillable at 2-5 s, raw Binance-Chainlink gap): at 88-93c Binance 2+ bps WITH the favourite wins 91.8% and nets +$0.022 per $1 (n=98), Binance 2+ bps AGAINST it wins 88.1% and loses -$0.020 (109); at 94-97c WITH wins 98.4% +$0.025 (182), AGAINST 92.2% -$0.038 (230). So a favourite with Binance behind it is a 98% ticket and one with Binance against it is where the 93c losses live; all favourites together are fee-neutral (-$0.010 at 94-97c, +$0.001 at 88-93c). The width gate of fav88-15m-late-wide adds +$0.02 on 49 trades but with Binance behind it as well only 27 remain (+$0.031); this rule drops the width gate and keeps the Binance gate so it trades about every other window. By coin on the wide rule the ETH 15m cell, now the real test, is the weakest (14 trades 85.7% -$0.043), too few to judge." },
  { name: "ahead7-cheap60-15m-first60", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 7, flatLeft: [840, 900], minWindowSec: 900, maxWindowSec: 900, added: "2026-10-31", idea: "15-minute markets, the first 60 seconds only: the underlying is already 7+ bps from the open and the side it favours still asks 35-60c; buy it and hold to close. Round 95 (31 Oct 2026, $HOME/an/out3, the 880 fillable real-book trades of the 15m early move, 20-30 Oct) split the base rule (60.7% won, +$0.076 per $1, 3 red days of 11) three ways. Move size: 7+ bps 65.2% won +$0.172 per $1 (n=115) against 60.0% +$0.062 under 7 bps (765). Seconds into the window: first 60 s 62.5% +$0.120 (530), 60-120 s +$0.053 (163), 120-180 s -$0.05 (135). Ask: 45-55c 60.3% +$0.188 (179), 55-60c +$0.068 (425), 60c+ +$0.013 (260). Futures ahead of spot in the move's direction +$0.129 (190) vs behind +$0.076 (202), only two days of futures data. The two gates together, 7+ bps in the first 60 s: 87 trades, 66.7% won, +$0.194 per $1, 3 red days of 9. Sibling of ahead5-cheap60-15m-first3 (the BNB real rule) and ahead5-mid55-15m-first30; judged by the server's fillable column." },
  { name: "ahead3-mid60-15m-min3", left: 0, cap: 0.6, minAsk: 0.5, size: 5, aheadBp: 3, flatLeft: [700, 740], minWindowSec: 900, maxWindowSec: 900, added: "2026-11-01", idea: "15-minute markets, a second look at minute 3 (flatLeft 700-740 s): the underlying is still 3+ bps from the open in one direction and that side asks only 50-60c; buy it. Round 96 (1 Nov 2026, $HOME/an/dip15.py, 1,280 real-book early-move signals 20-31 Oct, 7 coins: Chainlink 5+ bps from the open in the first 3 minutes, favoured side 35-60c with 5+ shares) asked whether waiting for a pullback beats buying at the signal. It does not: when the favoured ask later dropped 5c or more below the signal ask while Chainlink still led by 3+ bps (49% of signals) the trade won only 53.0% and netted +$0.058 per $1 even bought at the lower price, while signals with no such dip won 69.4% for +$0.207; the earlier the dip the less it hurt (first 2 minutes +$0.115, minutes 4-8 -$0.08). A pullback is the market correcting its first-minute lag, not a discount. After minute 3 the favoured side is priced fairly in almost every cell (-$0.08..+$0.05 per $1 at 70-80c, 60-70c and under 50c, at 3, 5 and 7 minutes); the one cell that still pays is 50-60c at minute 3 with Chainlink 3+ bps ahead: 140 trades, 65.0% won, +$0.155 per $1, 4 red days of 12 (5+ bps: 78 trades, 65.4%, +$0.159). Thin cell, so a probe, judged by the server's fillable column." },
  { name: "feed3-both40-15m-xds", left: 0, cap: 0.4, minAsk: 0.2, size: 5, feedLeadBp: 3, jumpMinLeft: 300, minWindowSec: 900, maxWindowSec: 900, skipCoins: ["btc", "eth", "bnb", "hype"], added: "2026-11-01", idea: "feed3-both40-15m on XRP, DOGE and SOL only. Round 97 (1 Nov 2026) split the Mac paper trades of the two cheap 15m feed tickets since 30 Oct (fillable-tagged only; stale Mac books, so directions not levels): feed3-both40-15m, 251 fillable trades, 37.8% won, +$0.18 per $1 overall, but by coin XRP 52.5% won +$0.66 (n=40), DOGE 53.7% +$0.72 (41), SOL 43.2% +$0.36 (44) against ETH 15.4% -$0.53 (26), BNB 25.0% -$0.25 (32), BTC -$0.13 (17), HYPE -$0.04 (51); feed3-both35-15m-early shows the same ranking (DOGE +$0.79, XRP +$0.22, SOL +$0.13, the rest -$0.19 to -$0.86). The server's own 24-hour lab agreed on the ranking before this (XRP +$69, DOGE +$36, SOL +$38, ETH -$21, BTC -$2 fillable). Other splits: UP and DOWN equal (+$0.19 / +$0.18), the first five minutes best (750-900 s left +$0.16 on 140, 600-750 s +$0.27 on 69, under 450 s negative), 15-18 KST +$0.54 (47) and 03-06 KST +$0.32 (39) good, 21-03 KST -$0.13..-$0.18 (92) bad, which is the opposite of the 15m early move's hours. Small coins have thinner, slower books, so the cheap ticket after a feed move survives there; a two-day, 40-trade-per-coin read, so a probe next to the all-coin rule. XRP 15m is the live real test of the all-coin rule since 31 Oct 22:45 KST." },
  { name: "ahead5-cheap57-15m-first3", left: 0, cap: 0.57, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, added: "2026-11-01", idea: "ahead5-cheap60-15m-first3 (the BNB real rule) with the cap 3c lower, so the live limit order always has room above the quoted ask. Round 98 (1 Nov 2026) read the server's first 30 real orders (31 Oct 16:57-01:50 KST, server/status.json realTrades): 27 matched, every one at exactly the ask the signal saw (freshAsk = ask, no slippage; when the ask sat under the cap the fill was at the lower ask, e.g. fav88 at 88-91c under its 93c limit), round trip 235-734 ms, median about 280 ms; the 3 rejects were all fill-or-kill orders whose ask sat at or within 1c of the rule's cap (BNB DOWN at 60c with a 60c limit, twice; XRP UP at 39c with a 40c limit), i.e. the ticket at the edge of the band had already gone. Same round, window-shape on the 14-day 15m history (8,713 windows, 1-min prints): the number of times the price crossed 50c before minute 5 or 10 does not change the leader's odds beyond its price (at minute 5, leader 65-75c: no crossing 69.2% won, one crossing 71.7%, two or more 68.4%; every cell -$0.09..+$0.05 per $1 at the last print), so chop is already priced and path patterns are a no-go. The server lab after 24 h has every early-move sibling red or flat on fillable trades (ahead5-cheap70 -$42 on 157, tp85 -$37 on 40, first30 -$30 on 36, bin5 -$28 on 58, base +$0.5 on 214), so this is a fill-mechanics probe, not a new edge." },
  { name: "ahead5-cheap60-15m-vol30", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, prevRangeBp: 30, added: "2026-11-01", idea: "ahead5-cheap60-15m-first3 only when the previous six 15m windows ranged 30+ bps on average: a control for the volatility regime. Round 99 (1 Nov 2026, $HOME/an, out3 joined with the Binance 1-min history) split the 880 fillable real-book early-move trades of 20-30 Oct by the market's recent volatility and found none of the dependence the cheap-UP family had (round 'up15-first100-vol14'): previous-6-window average range under 30 bps 59.2% won +$0.034 per $1 (n=174, 5 red days of 11) against 30+ bps 60.6% +$0.081 (665, 3 red of 11); previous hour's range under 60 bps +$0.06 (227) vs 60+ +$0.08 (653); previous 15 minutes under 25 bps +$0.05 (169) vs 25+ +$0.08 (711); the 15-20 bps and under-25 bps cells that look better are 10-27 trades. The 5 bps trigger is small next to a typical 30-60 bps hourly range (851 of 880 signals moved under 0.3 of the previous six windows' range), and the few relatively large moves did better (0.3-0.5 of the range: 68% won, +$0.18 on 25). So the early-move lag is a fixed-size effect, not a volatility play; this variant should track its parent, and a gap between the two would say otherwise." },
  { name: "fav88-15m-late-asia", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [3, 12], added: "2026-11-01", idea: "fav88-15m-late-wide between 12:00 and 21:00 KST only (hoursUtc 3-12). Round 100 (1 Nov 2026, $HOME/an/outfav, the 621 fillable late-favourite trades at 88-97c on the real 15m books, 20-31 Oct, 7 coins) split the late favourite by hour of day: 15-18 KST 98.9% won +$0.046 per $1 (n=90, 0 red days of 11), 18-21 KST 98.8% +$0.047 (84, 1 red of 11), 12-15 KST 94.2% +$0.003 (69), while every other block loses: 21-24 KST 90.8% -$0.025 (87, 6 red of 11), 00-03 91.4% -$0.032 (70), 03-06 91.7% -$0.019 (84, 7 red of 10), 06-09 87.9% -$0.057 (66), 09-12 90.1% -$0.036 (71). ETH alone, the real test coin: 12-24 KST four blocks all green (+$0.02..+$0.06, 96-100% won, n=24-33 each) and 03-12 KST three blocks all red (81.6-87.9% won, -$0.06..-$0.13). A 93c favourite needs about 93.5% won to break even after the 7% fee on winnings, and in the quiet Asian afternoon and European morning it wins 98-99%, in the US session and the Asian night 88-92%: the late reversals that kill the favourite come with US-hours volume. Weekday, ask (88c +$0.05, 94c +$0.02, the rest fair) and coin add nothing stable. Pooled the rule is fee-neutral (-$0.01 per $1 over 621), so the hours are the whole edge; judged by the server fillable column against its parent." },
  { name: "fav88-15m-late-deep", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, askUsd: [300, 1e9], added: "2026-11-01", idea: "fav88-15m-late-wide only when $300 or more rests on the favourite's best ask: a fill-rate probe, not an edge claim. Round 101 (1 Nov 2026, $HOME/an/favdep.py, 1,884 first looks at a 88-97c favourite with 50-180 s left on the real 15m books of 20-31 Oct, 7 coins) asked whether the size behind the favourite's ask says anything. On outcome it does not: with the best ask worth under $50 the fillable trades won 92.1% for -$0.000 per $1 (n=810), $50-100 93.1% +$0.008 (188), $100-300 90.9% -$0.017 (274), $300-1,000 90.2% -$0.022 (132), $1,000+ 94.1% +$0.006 (34); the whole ask side (top ten levels) under $500 -$0.008, $1,000-3,000 +$0.019, $10,000+ -$0.018: every band fee-neutral, as the favourite has been in every cut but the hour of day (round 100). On fills it does: the ticket was still there with 5+ shares 2-5 s later 74% of the time under $50, 75% at $50-100, 80% at $100-300, 84% at $300-1,000 and 87% above $1,000 (overall 76%). So depth buys about ten points of fill rate and nothing in win rate; with the hours gate the deep cell is 54 trades 96.3% +$0.048, the thin cell 372 trades 94.1% +$0.020, both green. Also from this round: overround under 1.01 (a tight book) 97.0% +$0.017 on 66, 1.01-1.04 fee-neutral, 1.04+ +$0.002; 88c tickets +$0.009 and 94c +$0.009, 90-92c and 96c slightly negative. Judged by the server fillable column and miss count against its parent." },
  { name: "ahead5-cheap60-15m-rev", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, prevRel: "opposite", added: "2026-11-01", idea: "ahead5-cheap60-15m-first3 only when the previous 15m window closed AGAINST the side the move favours (a down window, then an early up move, buy UP). Round 102 (1 Nov 2026, $HOME/an/prev1.py) joined the real-book 15m early-move looks of 20-30 Oct (out3, 7 coins) and the 88c+ favourite looks at 3 minutes left (outfav) with the previous window's resolution from data/history: early move after an opposite close 542 trades, 64.2% won, +$0.117 per $1; after a same-direction close 621 trades, 59.9% won, +$0.046. Late favourite against the previous close 529 looks, 88.5% won, +$0.018 per $1; with it 503, 84.5%, -$0.036, and two windows of the same direction before it 85.8% (-$0.023) while two opposite 88.8% (+$0.023); per coin ETH 89.7% vs 84.0%, BTC 87.5% vs 85.4%, SOL 92.9% vs 86.7%, XRP 83.3% vs 72.7%, HYPE 89.7% vs 80.0%, only DOGE the other way on 18 looks. So the book prices the second window of a run too richly: after a move the crowd expects more of it and pays up for the trend side, while a reversal window is bought at a discount. The 30-minute open-interest change had no effect on the favourite (OI up 87.3%, down 83.9%, flat 86.7%, all within noise). Live the previous close is the book's favourite at its last snapshot (prevClose, as afterPrev uses), so a restart or gap skips the first window. New prevRel option; judged against the parent on the same hours." },
  { name: "fav88-15m-late-asia-rev", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [3, 12], prevRel: "opposite", added: "2026-11-01", idea: "fav88-15m-late-asia only when the favourite is the OPPOSITE side to the previous window's close (round 102: late 88c+ favourite against the previous close 529 looks 88.5% won +$0.018 per $1, with it 503 looks 84.5% -$0.036, on the 20-30 Oct real books, 7 coins; ETH 89.7% vs 84.0%). Same 12-21 KST hours as the real ETH rule, so the gap between the two is the value of the gate; the 'same' half is the real rule's weak half and would be the first thing to cut." },
  { name: "fav88-15m-late-asia-btc5", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [3, 12], btcAgreeBp: 5, added: "2026-11-01", idea: "fav88-15m-late-asia only when BTC's own 15m window has moved 5+ bps the same way as the favourite (BTC itself excluded). Round 103 (1 Nov 2026, $HOME/an/xfav1.py) joined the 641 non-BTC 88c+ favourite looks at 3 minutes left on the 20-30 Oct real books (outfav, 6 alts) with BTC's Binance move from the window open to that minute: BTC agreeing by 5+ bps 319 looks, 93.7% won, +$0.072 per $1; BTC agreeing by under 5 bps 154, 83.8%, -$0.031; BTC the other way 168, 75.6%, -$0.124 (77 of them with BTC 5+ bps against: 68.8%, -$0.195). Every alt shows the split: ETH 90.6% vs 75.0%, SOL 96.9% vs 72.7%, DOGE 92.7% vs 76.9%, HYPE 87.8% vs 76.9%, BNB 88.6% vs 86.7%, XRP 84.6% vs 70.0%. A coin-only move into the last 3 minutes is the kind that reverts; a market-wide move holds. For the early move the same join says the opposite about size: BTC 3+ bps against the move 47.8% won -$0.20 (67), otherwise +$0.02..+$0.17. Live the BTC move comes from the btc15m series' latest Chainlink print (latestAhead), so the gate needs that recorder alive. Same 12-21 KST hours as the real ETH rule; the gap to fav88-15m-late-asia is the value of the gate, and 'BTC disagreeing' is the half to drop from the real rule if the lab agrees." },
  { name: "fav88-15m-late-asia-either", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [3, 12], prevRel: "opposite", btcAgreeBp: 5, eitherGate: true, added: "2026-11-01", idea: "fav88-15m-late-asia skipping only the cell where BTC is NOT 5+ bps the favourite's way AND the previous window closed the same way as the favourite (either confirmation is enough). Round 104 (1 Nov 2026, $HOME/an/favcombo.py, favtaker.py, favmom.py; 641 non-BTC 88c+ looks at 3 min left on the 20-30 Oct real books joined with BTC's Binance move and the previous window's resolution): BTC agreeing 94.7% won +$0.079 per $1 (151) and BTC agreeing plus a reversal window 92.9% +$0.067 (168) are the same thing; a reversal window alone 85.2% -$0.012 (169); neither 73.2% won, -$0.155 (153). In the 12-21 KST hours: both 96.9% +$0.128 (65), BTC-only 96.4% +$0.099 (56), reversal-only 90.6% +$0.058 (64), neither 75.4% -$0.125 (65). So round 102's previous-window effect was mostly BTC agreement in disguise, and the one bad cell is a coin-only move that continues a run. Two things that do NOT help the favourite, checked the same hour: Binance taker-buy share over the last 3 minutes (heavy flow with the favourite 87.0% -$0.007 on 346, mild flow with it 90.4% +$0.024 on 178, heavy flow against 82.7% -$0.044 on 278; BTC/ETH lean one way, SOL/DOGE/HYPE the other) and Binance's own 3-minute move into the look (toward the favourite 5+ bps 88.1% -$0.004 on 295, away 5+ bps 85.0% -$0.009 on 167; every cell within $0.02 of fair). The book has priced the last three minutes; what it misses is the cross-coin and cross-window context. Live gates: prevClose (book favourite at the previous window's last snapshot) and latestAhead of the btc15m series." },
  { name: "ahead5-cheap60-15m-q0", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, quarters: [0], added: "2026-11-01", idea: "ahead5-cheap60-15m-first3 only in the window that starts on the hour (xx:00-xx:15). Round 105 (1 Nov 2026, $HOME/an/quarter1.py; out3 real-book early-move looks of 20-30 Oct, 7 coins, 1,163 looks) split by the window's place in the hour: the xx:00 window 66.2% won, +$0.145 per $1 (305; fillable 64.9% +$0.121 on 222), against xx:15 59.6% +$0.041 (292), xx:30 62.5% +$0.090 (293), xx:45 59.0% +$0.036 (273). The hour open is when Binance's hourly candle, funding marks and most scheduled flow land, so the underlying moves more in those minutes and the 15m book, which prices every window alike, lags most there. Four buckets of ~290, one 11-day sample: a quarter-of-hour effect is the kind that can be luck, so this is a probe against the parent, not a replacement. New `quarters` option (window start quarter)." },
  { name: "fav88-15m-late-asia-q2", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [3, 12], quarters: [2], added: "2026-11-01", idea: "fav88-15m-late-asia only in the window that starts at xx:30 (ends at xx:45). Round 105 (1 Nov 2026, $HOME/an/quarter1.py; outfav 88c+ favourite looks at 3 minutes left, 20-30 Oct, 7 coins, 1,032 looks) by the window's place in the hour: the xx:30 window 92.8% won, +$0.068 per $1 (265), the xx:15 window 81.7%, -$0.062 (262), xx:00 87.1% -$0.004 (271), xx:45 84.2% -$0.040 (234); inside 12-21 KST the same order, xx:30 91.5% +$0.062 (106) and xx:15 86.7% -$0.002 (83). Reading: the xx:15 window carries the hour-open move's aftershocks into its last minutes (late reversals), the xx:30 window is the quietest quarter and its favourite holds. One 11-day sample and four buckets, so a probe next to the real rule; if the lab agrees, the xx:15 window is the one to drop from the real favourite." },
  { name: "ahead5-cheap60-15m-thin", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, askUsd: [0, 50], added: "2026-11-01", idea: "ahead5-cheap60-15m-first3 only when the ticket we buy has under $50 resting on its best ask: the thin, stale quote. Round 106 (1 Nov 2026, $HOME/an/emdep.py; 1,163 real-book 15m early-move looks of 20-30 Oct, 7 coins) split by dollars on the best ask of the move side: under $20 62.7% won, +$0.094 per $1 (652, fillable 72%, and the fillable half still +$0.063 on 472), $20-50 62.0% +$0.084 (216, fill 78%), $50-100 61.5% +$0.076 (130, fill 80%), $100-300 57.9% +$0.014 (114, fill 82%), $300+ 60.8% +$0.031 (51). By whole-side depth the 1-3k band is best (65.0% +$0.132 on 391) and 10k+ worst (59.4% +$0.038 on 106). The opposite of the cheap feed ticket (round 42: deep asks paid, thin ones were pulled): here a big resting ask is a market maker who has already repriced to the move, while a small one is a retail quote left behind, which is the lag this rule lives on. Fill rate costs about ten points on the thin tickets, and the fillable column decides. New askUsd gate in considerAhead; probe next to the parent on the same hours." },
  { name: "ahead5-cheap60-15m-btcok", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, btcNotAgainstBp: 3, added: "2026-11-01", idea: "ahead5-cheap60-15m-first3 on the alts, skipping the move when BTC's own 15m window is 3+ bps the OTHER way. Round 107 (1 Nov 2026) is mostly a no-go result: the Polymarket trade tape carries no edge on 15m either ($HOME/an/whale15.py, 11,395 windows of 20-31 Oct, 7 coins, data/history tape): following a single $300-1,000 taker trade in the first 10 minutes at the next 1-minute print 66.4% won, +$0.001 per $1 (1,430); a $1,000+ trade 74.1% +$0.02 (151, and -$0.13 on the 35 in the first three minutes); by cost every band within $0.06 of fair; net tape flow of the first 3 minutes 70%+ one way: UP-heavy +$0.004 (559), DOWN-heavy -$0.07 (588). Whales and flow are priced in at the minute, as they were on 5m (rounds 1-6, 35). The usable number this hour comes from round 103's cross-coin join of the same early-move looks: BTC 3+ bps against the alt's move 47.8% won, -$0.20 per $1 (67 of 913 looks); the other 846 looks 62.8% won, +$0.098, against +$0.076 for all 913. So the alt move that BTC contradicts is the one to skip, and the gate costs 7% of the trades. New btcNotAgainstBp option (BTC flat or unseen passes; the BTC series itself is never gated). Probe next to the real rule; the fillable column decides." },
  { name: "fav88-15m-late-asia-vshape", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [3, 12], favEarly: "reverse", favEarlyBp: 5, added: "2026-11-01", idea: "fav88-15m-late-asia only when the favourite is the OTHER side of the window's own early move (this series' Chainlink 5+ bps from the open at minute 2): a V-shaped window. Round 108 (1 Nov 2026, $HOME/an/favpath.py) joined the 544 real-book 88c+ favourite looks at 3 minutes left (outfav, 20-30 Oct, 7 coins) with the window's Binance move over its first two minutes: favourite reversing a 5+ bps early move 95.8% won, +$0.025 per $1 (96); favourite continuing it 91.9%, -$0.024 (185); no early move 93.2%, -$0.003 (263). In the 12-21 KST hours the three cells are 100% +$0.076 (37), 95.9% +$0.020 (49) and 96.7% +$0.032 (122); fillable-only 94.9% +$0.012 vs 91.4% -$0.031 vs 92.1% -$0.015. The 11,000-window history (favourite = the minute-12 print at 88c+, +1c) says the book prices its own path: continue 97.6% -$0.003 (2,834), flat 97.0% -$0.003 (2,738), reverse 96.9% -$0.000 (779), and a reversed 10+ bps move is the worst cell there (95.1% -$0.017 on 307). So the window's shape is worth a couple of cents on the real books and nothing in the history: a small probe, not an edge claim; the cross-coin gate of round 103 stays the one that matters. Live: the early move is the series' own Chainlink print at minutes 1.5-2.5 (new earlyMove note, like binOpen); windows whose minute 2 was not seen are skipped." },
  { name: "ahead5-cheap60-15m-coiled", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, prevLate: "contested", added: "2026-11-01", idea: "ahead5-cheap60-15m-first3 only when the PREVIOUS window of this coin was still contested with 3 minutes left (its book favourite under 88c): a coiled market, not one that has just moved. Round 109 (1 Nov 2026, $HOME/an/favshock.py, favshock2.py) joined the 1,036 real-book 15m early-move looks of 26-30 Oct (out3, 7 coins) with the previous window's minute-12 print from data/history: after a contested window 66.1% won, +$0.150 per $1 (372); after a decided one 59.2%, +$0.032 (664); monotone in how decided it was (previous favourite under 70c +$0.133 on 152, 70-88c +$0.161 on 220, 88-95c +$0.083 on 127, 95c+ +$0.020 on 537); after a favourite that LOST 50% -$0.12 (18). Holds in every hour band (21-03 KST +$0.29 vs +$0.16, 03-12 +$0.20 vs +$0.00, 12-21 -$0.04 vs -$0.07), on both sides (DOWN +$0.19 vs -$0.02, UP +$0.10 vs +$0.08) and on BTC (+$0.32 vs -$0.05), SOL (+$0.31 vs +$0.04), BNB (+$0.37 vs +$0.09), ETH and DOGE mildly; HYPE is the exception (-$0.10 vs +$0.16). Best cell: contested previous window AND the move against its result 71.4% +$0.242 (185), round 102's reversal effect sharpened. The coarse history replay (Binance 2-min move, minute-2 print +3c) shows no gap (52.3% vs 51.9%), so the effect lives in the real asks: after a decided window the makers have already repriced to the trend and the 35-60c ticket is fair; after a coiled one the move is new and the quote is stale. Live: new lateFav note (book favourite's ask with a fifth of the window left) and prevLate gate; windows whose previous window's 3-minute mark was not seen are skipped. Probe next to the real rule on the same hours; the fillable column decides." },
  { name: "ahead5-cheap60-15m-spot", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, spotConfirmBp: 5, added: "2026-11-01", idea: "ahead5-cheap60-15m-first3 only when a spot exchange is behind the move: Binance or Coinbase itself 5+ bps from the window's Chainlink open in the move's direction, so a Chainlink-only move (feed print off, no spot move) is skipped. Round 110 (1 Nov 2026, $HOME/an/cbem.py; 1,113 real-book 15m early-move looks of 26-30 Oct with Coinbase and Binance prints, 7 coins): neither exchange 5+ bps 54.6% won, -$0.050 per $1 (163, 15% of looks; fillable 55.2% -$0.038 on 125); Coinbase only 64.1% +$0.111 (409); both 62.9% +$0.110 (291); Binance only 62.4% +$0.076 (250); fillable halves +$0.066..+$0.073. Which exchange leads does not matter (Coinbase 1+ bps ahead of Binance +$0.063 on 576, behind +$0.098 on 536; a Coinbase premium in the move's direction +$0.067, against it +$0.105), and Coinbase above or below the Chainlink print is a wash (+$0.086 / +$0.074). By coin the Coinbase confirmation matters most on ETH (62.7% +$0.092 on 284 vs 54.2% -$0.060 on 166 without), DOGE (68.1% +$0.186 vs 51.5% -$0.126) and HYPE (65.5% +$0.147 vs 52.9% -$0.047); BTC, SOL and XRP pay either way. Round 76 found the same shape for Binance alone (lagging Chainlink +$0.04 vs ahead +$0.14); this is the 'any exchange' form, which keeps 85% of the trades and drops the one losing cell. New spotConfirmBp option (measured against the Chainlink open, as the replay was). Probe next to the real rule; the fillable column decides." },
  { name: "fav88-15m-late-near", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, leadMin: 0, leadMax: 4, added: "2026-11-01", idea: "fav88-15m-late-wide (any hour) only when the favourite's margin is SMALL: Chainlink under 4 bps from the open in the favourite's direction with 3 minutes left. Round 111 (1 Nov 2026, $HOME/an/favmargin.py; 527 real-book 88c+ favourite looks at 180 s left, outfav 20-30 Oct, 7 coins) cut by that margin: under 4 bps 97.3% won, +$0.066 per $1 (37; fillable 96.8% +$0.063 on 31); 4 bps or more 92.9%, -$0.011 (490; fillable 92.0% -$0.022 on 412). Inside the 88-93c band the margin runs the wrong way for intuition: 2-4 bps 96.2% +$0.062 (26), 4-7 bps 89.9% -$0.011 (69), 7-12 bps 91.3% +$0.003 (69), 12+ bps 88.4% -$0.034 (69); outside the 12-21 KST hours the big-margin cells lose -$0.06..-$0.07 (133 looks) while the 2-4 bps cell wins 16 of 16 (+$0.105). In 12-21 KST every margin band is green (4-7 +$0.064 on 31, 7-12 +$0.105 on 27, 12+ +$0.086 on 16) and the 2-4 cell is 9 of 10. Reading: the book does not quote 88c for a 12 bps lead unless the coin is wild right now, so a big margin is not safety, and an 88c favourite sitting only 2-4 bps from the strike exists when the coin is calm and the book is a touch too careful. Small-sample probe (about 4 looks a day across 7 coins): leadMin 0 / leadMax 4 (existing signed-lead gate), all hours, same cap and overround as the wide rule; judged by the fillable column." },
  { name: "ahead5-cheap60-15m-break", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, prevRun: [2, 3], prevRunRel: "against", added: "2026-11-01", idea: "ahead5-cheap60-15m-first3 only when the move BREAKS a run: the previous two or three 15m windows of this coin all closed the same way and the move goes the other way. Round 112 (1 Nov 2026, $HOME/an/streak.py; 1,163 real-book 15m early-move looks of 20-30 Oct joined with the run of same-way resolutions before each window, data/history): against a run of 2-3 windows 67.1% won, +$0.165 per $1 (207; fillable 65.5% +$0.135 on 165); extending a run of 2-3 windows 56.7%, -$0.016 (233; fillable 54.0% -$0.064 on 176). After a single window (no run) the split is round 102's: against +$0.078 (282), with +$0.043 (310). After 4+ same-way windows the trend day takes over: with the run 70.5% +$0.247 (78; fillable 75.5% +$0.348 on 53), against it 66.0% +$0.138 (53). The late favourite does not care about runs at all: on 6,386 history windows every run-length cell is within $0.02 of fair (97-98% won), and the real-book looks are mixed. So the book prices the trend side of a 2-3 window run too richly on the early move and nothing else, the same crowd behaviour as round 102 seen one window deeper. Live: closeBook already keeps 12 windows per series; new prevRun/prevRunRel options; a restart leaves the first windows unseen and skipped. Probe next to the real rule; the fillable column decides." },
  { name: "ahead5-cheap60-15m-broad", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, breadthMin: 4, added: "2026-11-01", idea: "ahead5-cheap60-15m-first3 only when the move is market-wide: at least four OTHER coins' 15m windows are already 5+ bps from their open the same way when this coin triggers. Round 113 (1 Nov 2026, $HOME/an/breadth1.py; the 1,163 real-book 15m early-move looks of 20-30 Oct, 7 coins, 500 windows, grouped by window): counting the other coins that had triggered the same way by the time of each look, 4+ others 72.9% won, +$0.287 per $1 (144 looks; fillable 77.3% +$0.358 on 97) against 60.1% +$0.043 (501) with no other coin, 61.0% +$0.066 (290) with one and 60.1% +$0.044 (228) with two or three; fillable 58.7% / 60.4% / 56.2% for those. By hours the broad cell is 83.9% +$0.501 in 21-03 KST (56), 76.3% +$0.343 in 03-12 KST (38) and only 58.0% +$0.003 in 12-21 KST (50), where two-to-four coins moving together is actually red (51.9% -$0.110 on 81, 45.7% -$0.216 on 92). BTC and the alts show the same step (BTC 75.8% +$0.341 on 33, alts 72.1% +$0.270 on 111). Round 72 found that a market-wide move does NOT carry to a coin that has not moved itself; this is the other half: when the coin has moved AND the whole market moved with it, the book still asks 45-55c for the side that wins three times in four. Caveat: 144 looks sit in about 30 distinct windows, so the independent sample is small and one macro day could be most of it; live, crossAheads counts a coin only while its latest Chainlink print is still 5+ bps out (within 3 s), so the live count runs a little lower than the replay's. Probe next to the real rule; the fillable column decides." },
  { name: "fav95-hold-min60", left: 0, cap: 0.995, size: 5, favAt: 0.95, holdRows: 10, holdAt: 0.9, favTo: 240, maxWindowSec: 300, added: "2026-11-01", idea: "fav95-hold on the 5m markets only, and never in the last 60 s of the window (favTo 240 = at most 240 s elapsed). Round 114 (1 Nov 2026, $HOME/an/favhour5.py) read the Mac paper lab's own fav95-hold / fav93-hold trade logs for the six 5m coins, 23 Oct to 1 Nov: the 5m favourite is fee-neutral over ten days. BTC fav95-hold 1,591 trades, 95.6% won, +$0.001 per $1 (fillable 290, 96.6%, +$0.011), 5 of 10 days green (-$13.5, -$22.3, -$17.2 on the red ones); ETH fav93-hold 834, 94.6%, +$0.008; DOGE fav93-hold 558, 96.1%, +$0.016 (7 of 10 days green, fillable +$0.024 on 120); SOL -$0.017, XRP -$0.014, BNB -$0.013. The server's two green days (31 Oct, 1 Nov; +$27 fillable on 291) were a good stretch of a coin flip, and the real rule's two $5 losses today (16:34 and 17:29 KST) both came with under 60 s left, the one bucket that is red on the Mac for BTC: last 60 s 94.2% won -$0.015 (207; fillable 92.9% -$0.028 on 28) against 60-120 s 96.1% +$0.006 (567), 120-180 s 95.2% -$0.003 (523; fillable 98.9% +$0.036 on 94), 180 s+ 96.3% +$0.008 (294). By KST band the worst BTC cell is 15-18 (92.9%, -$0.028 on 226) and the best 06-09 and 12-15 (+$0.014 / +$0.015), DOGE/XRP/BNB are all 100% in 09-12 KST (77 / 81 / 56) and ETH/XRP/BNB are red 21-24 KST; at 95% win rates every one of those cells is within two losses of its neighbour, so none is a rule on its own. The last-minute cut is the one filter with a mechanism (a 95c ask with under a minute left is a few bps from the strike and a wobble cannot recover) and it costs 13% of the trades; probe it next to fav95-hold and judge on the fillable column with 300+ trades, not on a good day." },
  { name: "ahead5-cheap60-15m-scaled", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, aheadBpBy: { btc: 5, bnb: 5.5, eth: 7, xrp: 8, sol: 8.5, doge: 9, hype: 11 }, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, added: "2026-11-01", idea: "ahead5-cheap60-15m-first3 with the 5 bps trigger scaled to each coin: the move must be at least 0.6 of the coin's usual 15-minute range (BTC 5, BNB 5.5, ETH 7, XRP 8, SOL 8.5, DOGE 9, HYPE 11 bps). Round 115 (1 Nov 2026, $HOME/an/relmove.py): the median absolute 15-minute move on Binance over the 14-day history is BTC 7.9 bps, BNB 9.1, ETH 11.4, XRP 13.6, SOL 14.0, DOGE 14.5, HYPE 18.2, so the same 5 bps is two thirds of a normal window for BTC and a quarter of one for HYPE. On the 1,163 real-book early-move looks of 20-30 Oct, bucketed by move over the coin's median: under 0.4 of it 53.7% won, -$0.046 per $1 (121; fillable 56.5% +$0.002 on 92); 0.4-0.6 61.6% +$0.072 (552; fillable +$0.043 on 419); 0.6-0.8 64.1% +$0.117 (329; fillable +$0.078 on 254); 0.8-1.0 61.2% +$0.065 (98; fillable +$0.079); 1.0-1.5 75.6% +$0.286 (45; fillable 69.0% +$0.163 on 29); 1.5+ 55.6% (18). Everything at 0.6 or more together is +$0.12 per $1 on 490 looks (fillable +$0.085 on 358) against +$0.05 below it (fillable +$0.036 on 511), so the scaled trigger roughly doubles the net per dollar and keeps 42% of the looks. In absolute bps the same looks are flat from 5 to 9 bps (+$0.06..0.07) and only pick up at 9+ (+$0.171 on 145), which is why round 91's 7 bps cut helped less than this: a 6 bps move is a real move for BTC and noise for DOGE. By coin the small-for-the-coin half is the weak one on HYPE (56.5% -$0.001 on 69 vs 75.8% +$0.321 on 33), DOGE (+$0.029 vs +$0.171), XRP (+$0.112 vs +$0.296) and ETH (+$0.023 vs +$0.061); BNB is the exception (small +$0.234 on 32, big +$0.143 on 56) and SOL is flat. Scaling by the last hour's realized range instead of the coin's median gives nothing clean (0.4-0.6 of recent +$0.151 on 253, under 0.4 +$0.047 on 692, fillable +$0.075 vs +$0.042), so the trigger uses a fixed per-coin table. New aheadBpBy option (coinOf the series prefix). Probe next to the real rule; the fillable column decides." },
  { name: "ahead5-cheap60-15m-ovr2", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, aheadOverround: [1.015, 1.035], added: "2026-11-01", idea: "ahead5-cheap60-15m-first3 only when the book is 2-3c wide at the trigger (best UP ask + best DOWN ask between 1.02 and 1.03), i.e. the makers have stepped back after the move. Round 116 (1 Nov 2026, $HOME/an/overr15.py; the 1,163 real-book 15m early-move looks of 20-30 Oct, 7 coins): overround under 1.02 (a tight, competitively quoted book) 60.4% won, +$0.052 per $1 (737; fillable 59.2% +$0.030 on 566); 1.02-1.04 64.9% +$0.128 (319; fillable 63.3% +$0.103 on 229); 1.04-1.07 61.9% +$0.075 (84; fillable +$0.066 on 67, only 3 of 9 days green); under 1.00 (a crossed book) 66.7% +$0.262 on 18. The 2-4c band beats the tight book inside both paying hour bands, 03-12 KST 71.6% +$0.247 (88; fillable +$0.144 on 61) against 58.7% +$0.021 (225; fillable -$0.035 on 178) and 21-03 KST 70.8% +$0.244 (120; fillable +$0.220 on 92) against 66.4% +$0.170 (283; fillable +$0.154 on 212), and both are red in 12-21 KST (-$0.09 and -$0.04); the tight and the 2-4c bands are each green on 10 of 12 days. Reading: when the book is quoted to the cent on both sides the makers have already repriced the move; a book that has opened up by a couple of cents is one where they pulled quotes and the resting cheap ask is a stale retail order, the same picture as round 106's thin asks. UP and DOWN early moves do not differ cleanly (UP +$0.101 on 555, DOWN +$0.060 on 608; the sign flips between hour bands). Live gate uses the two best asks of the same book row; probe next to the real rule, the fillable column decides." },
  { name: "fav95-hold-offhour", left: 0, cap: 0.995, size: 5, favAt: 0.95, holdRows: 10, holdAt: 0.9, skipHourClose: true, maxWindowSec: 300, added: "2026-11-01", idea: "fav95-hold on the 5m markets, skipping the one window per hour that closes on the hour (xx:55 to xx:00). Round 117 (1 Nov 2026, $HOME/an/slot5.py) read the Mac paper lab's fav95-hold / fav93-hold logs for six 5m coins, 23 Oct to 1 Nov, 4,874 trades, by the window's place in the hour. Which five-minute slot of the quarter it is makes no difference at all (slots 0/1/2: 94.1% / 94.1% / 94.9% won, -$0.006 / -$0.006 / +$0.004 per $1; fillable -$0.013 / +$0.013 / +$0.007), and neither does the quarter of the hour, but the window that ends on the hour is the weak one: 93.5% won, -$0.011 per $1 (400 trades; fillable 90.2% won, -$0.046 on 92) against 94.4% and -$0.002 for the other eleven (4,474; fillable 95.2% +$0.007 on 916). BTC fav95-hold there: 94.1% -$0.015 (135; fillable 90.6% -$0.050 on 32) against 95.8% +$0.003 elsewhere (fillable 97.5% +$0.021 on 282); DOGE 90.2% -$0.042 (41; fillable 5 of 7); XRP 91.7% (48, fillable 12 of 14); ETH, SOL and BNB show nothing. The hour close is where the 1-hour and 15-minute markets settle as well, so the last minutes of that window carry everyone's closing flow and the late reversal that kills a 95c favourite is more common there. One trade in twelve, and 9 fillable losses where 4 or 5 were expected, so a probe: judged on the fillable column against fav95-hold with 300+ trades." },
  { name: "fav88-15m-late-asia-company", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [3, 12], favBreadthMin: 1, added: "2026-11-01", idea: "fav88-15m-late-asia only when at least one OTHER coin's 15m window shows an 88c+ favourite on the same side at the 3-minute mark, i.e. the favourite has company. Round 118 (1 Nov 2026, $HOME/an/favbreadth.py; the 1,032 real-book favourite looks at 180 s left on the 20-30 Oct outfav files, 7 coins, 588 windows, grouped by window): a lone 88c+ favourite (no other coin at 88c+ the same way) won 90.6% for -$0.031 per $1 (308; fillable 89.1% -$0.048 on 257); with one or two other coins the same way 96.3% +$0.027 (219; fillable 96.2% +$0.023 on 185); with three or more 17 of 17. In the 12-21 KST hours the lone favourite is 95.3% +$0.020 (128) and the accompanied one 100% +$0.065 (80); off hours 87.2% -$0.068 (180) against 94.2% +$0.005 (139). Round 103's BTC agreement is the special case: an alt favourite with BTC's favourite the same way 96.9% +$0.030 (96) against 92.7% -$0.009 with no BTC favourite (220); any coin's company works, not only BTC's. Losses do cluster across coins (of 157 same-side pairs one lost both, against 0.1 expected if independent), so size the set, not the rule. Live the gate reads the lateFav notes (favourite price at 180 s left, now with side) of the other 15m series for the same window; the first coin to pass 180 s in a quiet market sees no company yet, so the live count runs a little under the replay's. Probe next to the real rule; the fillable column decides." },
  { name: "fav88-15m-late-asia-5mok", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [3, 12], favShortMin: 0.6, added: "2026-11-01", idea: "fav88-15m-late-asia only when the coin's concurrent 5m market (the 5m window that ends with this 15m window) also has the favourite's side at 60c or more at the 3-minute mark, i.e. the last five minutes moved the favourite's way as well. Round 119 (1 Nov 2026, $HOME/an/cross5.py; 418 BTC and ETH 88c+ favourite looks at 180 s left on the 20-30 Oct real 15m books, each joined with the same coin's 5m book row within 6 s): 5m side with the favourite at 60c+ 96.0% won, +$0.023 per $1 (219; fillable 95.0% +$0.013 on 184); 5m a toss-up (both sides under 60c) 89.4% -$0.044 (85; fillable 87.5% -$0.065 on 72); 5m leaning against at 60-85c 91.9% -$0.017 (86; fillable 90.7% -$0.031 on 75); 5m at 85c+ AGAINST the favourite 75.0% -$0.199 (28; fillable 73.7% -$0.214 on 19). In the 12-21 KST hours the gate keeps 85 looks at 100% +$0.066 and drops 69 at 91.3% -$0.028. The mechanism is a reversal in progress: a 5m favourite the other way means the price has been falling back toward the 15m strike for the last few minutes while the 15m book still prices the old favourite; the 15m book lags, so the shorter market tells first. Alt coins were not in the join yet (their 5m books were still being extracted); check them next round. Live the gate reads latestBook of the coin's 5m series (BTC 5m is prefix ''), so it needs both recorders alive; the gap to fav88-15m-late-asia is the gate's value." },
  { name: "fav75-15m-late-asia", left: 0, cap: 0.85, size: 5, favAt: 0.75, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [3, 12], added: "2026-11-02", idea: "control probe for the lower rung of the favourite ladder: the 15m favourite at 75-85c in the last 3 minutes, 12-21 KST only, same hours and book-width gate as the real fav88-15m-late-asia, which takes 88-93c. Round 120 (2 Nov 2026, $HOME/an outfav looks at 180 s left on the 20-30 Oct real books, 7 coins, fee 7%): the 15m favourite pays in exactly one cell, 88-93c in 12-21 KST, 97.3% won +$0.077 per $1 (75; fillable 96.6% +$0.069 on 59). Below it the ladder's extra rungs are fair or worse: 75-85c 78.3% -$0.032 (267; fillable -$0.038 on 192), of which 12-21 KST 82.0% +$0.015 (111; fillable 79.8% -$0.013 on 84) and BTC/ETH in those hours 85.2% +$0.051 (88; fillable 84.4% +$0.040 on 64), the only sub-88c cell above water; 85-88c 84.5% -$0.026 (103; fillable -$0.077 on 75), 12-21 KST -$0.094 (42). Above it 93-97c is fair everywhere (+$0.01 to +$0.02 on 257) and a 97c+ favourite off hours is the worst cell of all, 83.9% -$0.137 (56; fillable -$0.156 on 50). Round 79 said the same over 12 days and 7 coins (70-80c -$0.06 on 408, 80-88c -$0.01 on 198). So the server's ETH slide95-85-75 (+$21 fillable on 128 in 2.5 days, day 3 only +$3.8) is a good stretch of a rule whose rungs below 88c lose on the longer record; it is not promoted. This probe measures the 75-85c daytime rung live, mainly for BTC and ETH; if its fillable column stays above +$0.03 per $1 over 100+ trades the ladder earns a second look, otherwise 88-93c stays the only favourite cell worth real money." },
  { name: "ahead5-cheap60-15m-5mquiet", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, aheadShortMax: 0.6, added: "2026-11-02", idea: "ahead5-cheap60-15m-first3 only when the coin's 5m market, which opened at the same moment, still quotes the side we buy under 60c, i.e. the faster market has NOT repriced the move either. Round 121 (2 Nov 2026, $HOME/an/early5.py; 396 BTC and ETH early-move looks of 26-30 Oct from the real 15m books, each joined with the same coin's 5m book row within 4 s): the expected confirmation runs the wrong way. When the 5m book already shows the side at 60-70c the 15m early move won 50.9% for -$0.135 per $1 (163; fillable -$0.130 on 131), at 70-85c 58.9% -$0.025 (129; fillable -$0.090 on 98); when the 5m book is still under 50c 57.6% +$0.187 (33; fillable 62.5% +$0.274 on 24) and at 50-60c 54.1% +$0.005 (61; fillable -$0.116 on 48). As a gap: the 5m book 5c+ above the 15m book (the 15m book lagging the 5m) 56.3% -$0.054 (284; fillable -$0.077 on 226), the two within 5c 52.5% -$0.016 (99), the 5m below 46.2% (13). Reading: a move both books have already priced is the ordinary kind that reverts as often as not; the early move's edge is a feed move the books have not caught up with, and the 5m book being asleep too is the better sign of that than the 5m book confirming. The hour effect of round 89 still dominates (21-03 KST +$0.04 to +$0.14 per $1 in every gap cell, other hours -$0.08 to -$0.14). Live gate reads latestBook of the coin's 5m series for the same window start; the probe keeps about a quarter of the real rule's trades, so judge it on its fillable column after 100+." },
  { name: "ahead5-cheap60-15m-wait60", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, confirmSec: 60, confirmCap: 0.65, added: "2026-11-02", idea: "ahead5-cheap60-15m-first3 that does not buy at the trigger: it arms the window and buys 60 s later at the then-current ask (up to 65c) only if the side's best ask never dipped 3c below the trigger ask in between. Round 122 (2 Nov 2026, $HOME/an/dip15.py; the 702 BTC and ETH early-move looks of 20-30 Oct followed through the next 3 minutes of the real 15m books): taken at the trigger the looks won 60.5% for +$0.052 per $1. The path afterwards is informative but hard to use: in 159 looks the ask dipped 5c+ within 2 min and those won 45.9% (-$0.207), in 541 it ran up 5c+ and those won 64.7% (+$0.125). A resting bid 3c under the trigger fills in 75% of looks (527) and those win 55.0% for +$0.006 at the better price, while the 25% that never dip win 77.1% (+$0.350): the dip is information, as the 5m flash-dip study found, so resting gives the edge away. Waiting to see the ask hold and then paying up: 15 s or 30 s later is worse than the trigger at any cap (-$0.01 to -$0.11 per $1), because the winners have run past 60c; 60 s later with a 65c cap is the one cell above the baseline, 115 looks taken (16%), 67.0% won, +$0.115 per $1 (ETH 70.7% +$0.163 on 75, BTC 60.0% +$0.026 on 40; 434 skipped for dipping, 153 for running past 65c), with a 60c cap 62 taken +$0.068 and a 70c cap 180 taken +$0.049. So being first is still the edge and this is a thin probe, not a replacement: it keeps one trade in six and its BTC half is fair. Live it reuses the resting-order plumbing (armed state per window, one attempt); judge on the fillable column after 100+ trades against the real rule's." },
  { name: "fav88-15m-late-asia-fresh", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [3, 12], favDipBelow: 0.6, added: "2026-11-02", idea: "fav88-15m-late-asia only when the side bought was still at 60c or under at some point 3-6 minutes before the end, i.e. a FRESH favourite that was decided in the last few minutes, not one that has sat at 88c+ for minutes. Round 123 (2 Nov 2026, $HOME/an/held15.py; the 421 BTC and ETH 88c+ favourite looks at 180 s left on the 20-30 Oct real 15m books, each with its own book's rows from 7 to 3 minutes left): the settled favourite is the bad one. A side that had held 88c+ continuously for 3+ minutes before the 3-minute mark won 86.5% for -$0.097 per $1 (37; fillable -$0.108 on 28); held 1-3 minutes 90.9% -$0.045 (99; fillable -$0.056 on 90); under a minute (fresh) 93.3% +$0.005 (285; fillable -$0.007 on 235), and in 12-21 KST the fresh favourite is 97.1% +$0.045 (102; fillable 96.4% +$0.035 on 83). Sharper by the side's lowest ask 3-6 minutes out: never under 80c 87.1% -$0.085 (93; 12-21 KST 86.8% -$0.088 on 38), dipped to 60-80c 93.7% +$0.004 (174; 12-21 KST 98.2% +$0.051 on 56), dipped under 60c 93.5% +$0.004 (154; 12-21 KST 100% won +$0.074 on 61, fillable 100% +$0.070 on 49); a side that was the underdog at some point in those minutes is 100% on 45 daytime looks. Reading: an 88-93c favourite that has not moved for minutes is a price hovering a few bps from the strike (otherwise it would be 97c+), and that is the favourite a last-minute wobble kills; a side that was 60c three minutes earlier got there on a decisive move that carries into the close. Live the gate tracks each side's minimum best ask over the 180-360 s span of the window in this instance, so a recorder restart inside those minutes skips the window. Same 12-21 KST hours as the real rule; the gap to fav88-15m-late-asia is the gate's value." },
  { name: "fav88-15m-late-asia-stop60", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [3, 12], stopBid: 0.6, added: "2026-11-02", idea: "control probe, expected to trail the real rule: fav88-15m-late-asia that sells into the bids once the side's best bid falls to 60c instead of holding to the close. Round 124 (2 Nov 2026, $HOME/an/exit15.py; the 151 BTC and ETH 88-93c favourite looks at 180 s left on the 20-30 Oct real 15m books, each followed through its own book's bids to the close, 7% fee on the sale too): holding pays -$0.038 per $1 over all hours and +$0.058 in 12-21 KST (49), and every stop pays less in the paying hours: stop at a 75c bid -$0.022 (17 of 49 stopped, 15 of them would have won), 60c +$0.010 (9 stopped, 7 would have won), 50c +$0.022 (6 stopped, 4 would have won), 35c +$0.040, 20c +$0.046. Off hours a stop trims the loss (-$0.084 held, -$0.046 at 60c, -$0.044 at 75c) but nothing turns green. Skipping the last 20 s (no time to react) changes no cell. Reading: three of four wobbles in an 88-93c favourite are noise that recovers by the close, so a stop sells winners to save a quarter of the losers, the same verdict round 43 gave the feed rule and round 87 the early move. Live this uses the stopBid exit; the gap to fav88-15m-late-asia measures the cost of the stop." },
  { name: "ahead5-cheap60-15m-houropen", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, aheadHourAsk: [0.35, 0.65], added: "2026-11-02", idea: "ahead5-cheap60-15m-first3 only when the coin's 1-HOUR market (the 1h window this 15m window sits in) still quotes the side we buy at 35-65c, i.e. the hour is undecided and this move tilts it. Round 125 (2 Nov 2026, $HOME/an/hour15.py and hour15b.py; 624 early-move looks of 29-30 Oct from the real 15m books, 7 coins, each joined with the same coin's 1h book row within 2 s): 1h same-side ask 35-50c 68.5% won +$0.197 per $1 (54; fillable +$0.153 on 41), 50-65c 68.5% +$0.194 (213; fillable 70.8% +$0.234 on 144); under 35c (the hour runs the other way) 61.2% +$0.088 (134; fillable +$0.043 on 102); 65-80c 61.2% +$0.062 (85; fillable -$0.019 on 66); 80c+ (the hour already ran this way) 57.2% +$0.006 (138; fillable +$0.004 on 101). By the hour's own move toward the side: 5-15 bps 71.0% +$0.226 (155) against 15+ bps 59.5% +$0.038 (205; fillable -$0.004 on 151). BTC and ETH alone: 1h side 50-65c 71.0% +$0.243 (62; fillable 75.0% +$0.304 on 44) while 65c+ is -$0.019 and -$0.099 (48; fillable -$0.203 and -$0.094). Reading: a 15m move that merely extends an hour-long run the 1h book has already priced is the ordinary continuation that reverts as often as not (round 112's run-break result one window length up), while the move that tilts an undecided hour is the one the books lag. The 21-03 KST hours stay green in every band (80c+ only +$0.047 on 40). The late 88c+ favourite does not care about the 1h lean (every band +$0.00 to +$0.06 on 161). Live the gate reads latestBook of the coin's 1h series (prefix coin + '1h-', window containing this one, fresh within 5 s), so it needs the 1h recorder alive; keeps about 43% of the real rule's trades, judge on the fillable column after 100+." },
  { name: "ahead5-cheap60-15m-noround", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, aheadRoundClearBp: 5, added: "2026-11-02", idea: "ahead5-cheap60-15m-first3 minus the moves that have just broken through a BIG round number: skip when a coarse level (BTC $500, ETH $50, SOL $5, XRP 5c, DOGE 0.5c, BNB $25, HYPE 50c) lies between the Chainlink price and the strike, or the price is within 5 bps past such a level in the move's direction. Round 126 (2 Nov 2026, $HOME/an/round15.py; all 1,163 early-move looks of 20-30 Oct from the real 15m books, 7 coins): a coarse level between the price and the strike 49.3% won, -$0.141 per $1 (67; fillable 42.2% -$0.269 on 45) against 62.7% +$0.093 without one (1,096; fillable 61.7% +$0.076 on 835); price 0-5 bps past a coarse level 44.4% -$0.210 (45; fillable 37.9% -$0.337 on 29), 5-10 bps past 61.2% +$0.067 (49), 10-20 bps past 69.8% +$0.200 (96), i.e. once the level is cleared by 10+ bps the move runs on. The red cell survives the good hours: 21-03 KST with a level between 58.3% +$0.014 (24; fillable 46.7% -$0.201 on 15) vs 68.3% +$0.203 (410). The FINE grid (BTC $100, ETH $10, round 39's grid) shows nothing on either rule (every band +$0.04 to +$0.14), and the late 88c+ favourite ignores both grids (+$0.00 to +$0.07 in every band on 531 looks), so this is a barrier effect of the big levels on breakouts only: the first push through $500/$50 stalls and comes back often enough to lose. Removes about 6% of the real rule's trades (the gate skips when the row has no Chainlink or open price); the gap to ahead5-cheap60-15m-first3 on the fillable column is the test." },
  { name: "fav88-15m-late-asia-active", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [3, 12], favPrevRangeMin: 0.5, added: "2026-11-02", idea: "fav88-15m-late-asia minus the favourite that follows a DEAD window: skip when the previous 15m window's Binance range (high minus low) was under half the coin's median range (medians BTC 17.6, ETH 26.0, SOL 31.6, XRP 30.8, DOGE 32.1, BNB 20.2, HYPE 41.1 bps). Round 127 (2 Nov 2026, $HOME/an/quiet15.py; 544 88c+ favourite looks at 180 s left from the real 15m books of 20-30 Oct, 7 coins, joined with the 14-day Binance 1-min candles): previous window under 0.5x the median 82.8% won, -$0.121 per $1 (29; fillable 80.0% -$0.153 on 25); 0.5-1x 96.0% +$0.029 (177; fillable +$0.020 on 147); 1-1.5x 92.0% -$0.018 (137); 1.5-2.5x 92.2% -$0.019 (115); 2.5x and more 94.2% +$0.003 (86). In the 12-21 KST hours the dead-window cell is the only red one: 88.2% -$0.066 (17; fillable -$0.093 on 14) against 100% +$0.068 (78) after a 0.5-1x window, 95.3% +$0.023 (64), 97.6% +$0.035 (41) and 100% +$0.077 (8) after busier ones. Reading: an 88c favourite born right after a dead quarter hour is the first move after a lull, and first moves reverse more often than the book prices. The compression idea itself failed on the early move: a move after 1+ quiet windows (range under the median) pays +$0.02 to +$0.04 per $1 (197 looks) against +$0.090 after an ordinary one (966), and the early move after a wild previous window (2.5x+) is +$0.142 on all coins (284) but mixed on BTC and ETH, so no early-move rule from it. Live the gate uses the Binance print on each row to keep the running high/low per series and needs one full window after a restart before it can judge; removes about 5% of the real rule's trades, so its gap to fav88-15m-late-asia on the fillable column is the test." },
  { name: "ahead5-cheap60-15m-openmid", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, aheadOpenAsk: [0.4, 0.6], added: "2026-11-02", idea: "ahead5-cheap60-15m-first3 only when the book OPENED undecided: the side we buy asked 40-60c on the first row of the window (first 15 s). Round 128 (2 Nov 2026, $HOME/an/openlean.py; 694 BTC and ETH early-move looks of 20-30 Oct from the real 15m books, each joined with its own window's opening row): side ask at the open under 40c (the book opened leaning hard AGAINST the move) 45.5% won, -$0.119 per $1 (44; fillable 46.9% -$0.107 on 32); 40-47c 58.7% +$0.037 (225; fillable -$0.015 on 176); 47-53c 62.7% +$0.073 (255; fillable +$0.063 on 202); 53-60c 67.1% +$0.137 (152; fillable +$0.075 on 117); 60c and over (opened leaning hard WITH the move) 44.4% -$0.249 (18; fillable -$0.209 on 15). As the implied share ask/(UP ask + DOWN ask): under 0.42 51.5% -$0.035 (97), 0.42-0.58 61-66% +$0.06 to +$0.12 (576), over 0.58 52.4% -$0.117 (21); the 21-03 KST hours keep the shape with every middle band +$0.15 to +$0.19. Both extremes lose, not just one: a book that opened leaning against the move is a book that knows something (a trend or a 5m/1h lean the move is fighting), and a book that opened already leaning with it has priced the move before it happened, so the 60c ask is no bargain. Same family as rounds 112 and 125: the edge is a move that tilts an undecided market. The ask's rise since the open adds little (rose 10c+ 60.1% +$0.023 on 271, fillable -$0.020; rose under 5c +$0.072 on 148). Live the gate reads openBook, the first row of the window per series (set within 15 s of the open); removes about 9% of the real rule's trades, so its gap to ahead5-cheap60-15m-first3 on the fillable column is the test." },
  { name: "ahead5-cheap60-15m-undecided", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, aheadHourAsk: [0.35, 0.65], aheadRoundClearBp: 5, aheadOpenAsk: [0.4, 0.6], added: "2026-11-02", idea: "ahead5-cheap60-15m-first3 with the three 'undecided market' gates of rounds 125, 126 and 128 together: the coin's 1h market still quotes our side at 35-65c, no big round number (BTC $500, ETH $50, SOL $5, XRP 5c, DOGE 0.5c, BNB $25, HYPE 50c) between the price and the strike or within 5 bps behind the price, and the 15m book itself opened with our side at 40-60c. Each gate alone, on the real 15m books of 20-30 Oct: 1h side 35-65c 68.5% won +$0.195 per $1 (267 looks of 29-30 Oct; fillable +$0.216 on 185) against +$0.006 when the 1h book already had it at 80c+ (138); a big level in the way 49.3% -$0.141 (67) against 62.7% +$0.093 without (1,096); opened 40-60c 62.3% +$0.078 (632 BTC/ETH looks) against 45.2% -$0.157 when the book opened leaning hard either way (62). Round 129 (2 Nov 2026) could not run a fresh replay (the Mac was offline), so this is the combination probe the three singles asked for: the gates remove different trades (the 1h one keeps ~43%, the other two drop ~6% and ~9%), so together they should keep about a third of the real rule's trades. Server lab after the first hours: houropen 6/6 fillable +$19.7, noround 10/15 +$5.6, openmid 1/2. Judge the probe on its fillable column against ahead5-cheap60-15m-first3 and the three singles after 100+ trades; it needs the 1h recorder alive and the first row of each window." },
  { name: "ahead5-cheap60-15m-hold5", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, confirmSec: 5, confirmCap: 0.6, confirmDipC: 0.03, added: "2026-11-02", idea: "ahead5-cheap60-15m-first3 that gives the book five seconds: arm at the trigger, buy 5 s later at the then-current ask if it is still 35-60c and never dipped 3c in between (the round-122 confirm plumbing with the shortest wait). Round 130 (2 Nov 2026, $HOME/an/prepath.py; 638 BTC and ETH early-move looks of 20-30 Oct followed from the window open to the trigger on the real 15m books): the path BEFORE the trigger carries little. Adverse excursion first (how far the price went the other way before the move): under 1 bp 59.8% won +$0.029 per $1 (311; fillable -$0.003 on 251), 1-2 bps 65.4% +$0.124 (104), 2-4 bps 57.7% +$0.001 (111), 4 bps and more 59.8% +$0.030 (112; fillable 51.8% -$0.100 on 83), and it flips by coin (BTC clean moves +$0.14 on 121, ETH clean moves -$0.041 on 190), so no path rule. What does separate the looks is how long the move had already been 5+ bps when the rule could buy at 60c or less: the trigger row being the very first 5-bps print 56.5% +$0.000 (239; fillable 54.8% -$0.030 on 186); the move 5+ bps for 3-10 s already 71.2% +$0.217 (80; fillable 66.7% +$0.139 on 63); for 10-30 s 59.9% +$0.027 (142); for 30 s and more 60.4% +$0.023 (139; fillable -$0.020). In 03-12 KST the first-print cell is 51.3% -$0.101 (76; fillable -$0.196) against 70.0% +$0.205 for the 3-10 s one (30); in 21-03 KST both are green (+$0.12 and +$0.21). Reading: a book that has refused to reprice a 5-bps move for several seconds is a lagging book (the round-122 never-dip result at the shortest horizon), while the very first print is often the moment the book is about to catch up and our fill is the last cheap one. Round 122 found 15 s and 30 s waits worse than the trigger and only 60 s at 65c better; the 3-10 s band was not tried, so this probe fills that gap. The replay cell is not exactly a 5-second wait (it is triggers that came 3-10 s after the first 5-bps print), so judge the probe on its own fillable column against ahead5-cheap60-15m-first3 after 100+ trades." },
  { name: "ahead5-cheap60-15m-support", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, aheadBidRatio: 0.6, added: "2026-11-02", idea: "ahead5-cheap60-15m-first3 only when the side we buy is SUPPORTED: the dollars resting on bids within 3c under the best ask are at least 0.6x the dollars on asks within 3c above it. Round 131 (2 Nov 2026, $HOME/an/bookshape.py to bookshape4.py; 702 BTC and ETH early-move looks of 20-30 Oct joined to the real 15m book row at the trigger): the shape of the book at the trigger is mostly noise. Own-side spread (ask minus bid) is 0-3c on 665 of 702 looks, so it separates nothing; absolute depth bands (own asks within 5c, own bids within 5c, opposite asks within 10c) and the opposite-vs-own ask ratio all flip sign between the 12-21 KST band and the night band or between the first and second half of the days (own bids $300+ within 5c 61.7% won +$0.077 per $1 on 569 overall but 53.8% -$0.073 in 12-21 KST on 160), and absolute dollars cannot travel to small coins anyway (median own-side bid depth within 5c at 750-870 s left: BTC $1,757, ETH $432, SOL $152, XRP $138, DOGE $27, BNB $27, HYPE $16). The microprice gap of round 56 is weaker here (gap 1c+ 50.0% -$0.141 on 48, but 69.2% fillable in 12-21 KST on 13). The one measure that holds in every split is the RELATIVE depth on our own side, bids within 3c over asks within 3c: ratio 0.6 and above 66.3% won +$0.164 per $1 (335; fillable 65.3% +$0.125 on 251) against under 0.6 55.3% -$0.051 (367; fillable 54.5% -$0.063 on 297); 21-03 KST +$0.269 vs +$0.051 (119/150), 03-12 KST +$0.172 vs -$0.135 (112/119; fillable +$0.091 vs -$0.204), 12-21 KST +$0.035 vs -$0.102 (104/98), first-half days +$0.241 vs +$0.048, second-half days +$0.084 vs -$0.145 (165/187), BTC +$0.212 vs -$0.043 (130/120), ETH +$0.134 vs -$0.054 (205/247). Reading: a side whose asks dwarf its bids is a seller overhang waiting to unload the move onto us; bids standing under the price we pay are other buyers who agree. Keeps about half the trades; judge against ahead5-cheap60-15m-first3 on the fillable column after 100+ trades." },
  { name: "ahead5-cheap60-15m-off4h", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, skipHoursUtc: [3, 4, 11, 12, 19, 20], added: "2026-11-02", idea: "ahead5-cheap60-15m-first3 that sits out the two hours around the 4-hour candle closes that are NOT funding times: windows starting 03:00-04:59, 11:00-12:59 and 19:00-20:59 UTC (12-13, 20-21 and 04-05 KST). Round 132 (2 Nov 2026, $HOME/an/prevout.py and fundcyc.py; 1,163 early-move looks of 20-30 Oct, 7 coins). The angle started as funding-cycle proximity: looks 180-241 minutes from the nearest 00/08/16 UTC funding settlement win 51.8% and make -$0.105 per $1 (249; fillable 53.5% -$0.081 on 187) while every closer band is green (15-60 min 65.7% +$0.146 on 239, 60-180 min 64.4% +$0.125 on 626). That band is the hour before and after the 04/12/20 UTC 4h candle closes: within 30 min of one of those closes 46.6% -$0.208 (73) and 30-60 min 48.0% -$0.165 (123), against 63.5% +$0.116 and 66.9% +$0.160 at the same distances from the funding closes 00/08/16 UTC. The six skipped hours together: 49.8% won -$0.140 per $1 (223; fillable 50.3% -$0.137 on 167) against 64.8% +$0.132 for the other eighteen (940; fillable 63.1% +$0.104 on 713). It holds in the first half of the days (-$0.176 vs +$0.081) and the second (-$0.115 vs +$0.186), on BTC+ETH (-$0.176 vs +$0.102), on SOL/XRP/DOGE/HYPE (-$0.129 vs +$0.170), on cheap and on 50c+ tickets, and the skipped hours underperform the rest on 10 of 11 days (the exception is 27 Oct, a red day everywhere). BNB is the soft spot (+$0.056 vs +$0.209 on 19/69). Caveat: this overlaps the known hour-of-day picture (12-15 KST and 04-06 KST were already weak), so part of it is the old finding seen through a 4h lens; what is new is that the same phase of the cycle is red three times a day, including 20-21 KST inside the otherwise green evening, which argues for a mechanism (positioning into and out of the 4h close) rather than three coincidences. Drops about 19% of the base rule's trades; judge against ahead5-cheap60-15m-first3 on the fillable column after 100+ trades." },
  { name: "ahead5-cheap60-15m-4hfresh", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, aheadFourAsk: [0, 0.7], added: "2026-11-02", idea: "ahead5-cheap60-15m-first3 only when the coin's 4-HOUR market still quotes the side we buy under 70c, i.e. the 15m move is not just the continuation of a 4-hour run the 4h book has already priced. Round 133 (2 Nov 2026, $HOME/an/long15.py; 623 early-move looks of 29-30 Oct from the real 15m books, 7 coins, each joined with the same coin's 4h and 24h book row within 2 s; the long books exist only from 29 Oct). By the 4h market's ask for our side: under 70c 66.2% won +$0.166 per $1 (429; fillable +$0.157 on 313; the bands under 30c, 30-45c, 45-55c and 55-70c are all +$0.09 to +$0.21), 70c and above 56.7% -$0.016 (194; fillable 54.9% -$0.044 on 142). By the 4h window's own move toward our side: 50+ bps already run 58.7% +$0.009 (172; fillable -$0.023 on 120) against 68.5% +$0.215 when the 15m move goes AGAINST a 50+ bps 4h move (130; fillable 68.3% +$0.212 on 104). BTC and ETH carry the effect hardest: 4h side 70c+ 46.3% -$0.198 (54; fillable 43.9% -$0.232 on 41) against 60-77% won and +$0.07 to +$0.39 in every lower band (110); the alts show the same order but milder (70c+ 60.7% +$0.054 on 140 vs +$0.08 to +$0.22). In 03-21 KST the 70c+ band is the red one, 53.9% -$0.069 (152; fillable -$0.101 on 110), while 21-03 KST is green in every band (70c+ +$0.177 on 42; under 30c 82.9% +$0.483 on 41). The DAILY (24h) market carries nothing usable: its 70c+ band is 61.2% +$0.062 (286) and its bands reorder between day and night. The late 88c+ favourite ignores both long markets (every band -$0.03 to +$0.07 on 172). This is the round-112 run-break and the round-125 1h result one length up again: the 15m early move pays when it is NOT the continuation of a longer move the slower books have already priced, and a 15m move against the 4h trend is the best cell. Live the gate reads latestBook of the coin's 4h series (prefix coin + '4h-', window containing this one, fresh within 5 s), so it needs the 4h recorder alive; keeps about 69% of the real rule's trades, judge on the fillable column against ahead5-cheap60-15m-first3 and -houropen after 100+." },
  { name: "ahead5-1h-from15m", left: 0, cap: 0.65, minAsk: 0.35, size: 5, aheadFromSeries: "15m", aheadFromBp: 5, aheadFromAge: [30, 180], aheadOwnMinBp: 5, flatLeft: [600, 3600], minWindowSec: 3600, maxWindowSec: 3600, added: "2026-11-02", idea: "first CROSS-MARKET rule: on the coin's 1-HOUR market, buy the side that the coin's 15m window has just moved 5+ bps toward (within the 15m window's first 30-180 s, print fresh within 3 s), at 35-65c, when the hour's own move toward that side is already 5+ bps; one trade per hour, not in the last 10 minutes. Round 134 (2 Nov 2026, $HOME/an/cross1h.py; 614 early-move looks of 29-30 Oct joined with the coin's 1h book row within 2 s and scored on the HOUR's own resolution, 7 coins): the 15m early-move signal does NOT carry to the slower markets. Buying the 1h side at 35-65c: 260 looks, the hour resolved that way 55.8% against 54.0% implied by the ask, +$0.003 per $1 (-$0.033 with 2c slippage); by 1h ask band 50-60c 60.8% vs 55.7% implied +$0.069 is the best, every other band within 2 points of its implied probability (under 30c 13.8% vs 14.0%, 80c+ 89.9% vs 92.0%); it flips by day (29 Oct +$0.177 on 85, 30 Oct -$0.081 on 175) and by half. Same on the 4h market: 35-65c 54.8% vs 51.4% implied +$0.053 (239; +$0.012 with slippage), 03-12 KST -$0.240. So the 1h book's 'lag' of round 125 is only about the 15m window: the move persists for the remaining 12-14 minutes (68.5% in round 125) but the hour itself resolves as the 1h book prices it. The one structured cell is the hour already 5-15 bps toward the side: 65.1% won vs 57.1% implied, +$0.119 per $1 (126; +$0.081 with slippage), against 33.3% -$0.269 when the hour had moved the other way (60). This probe trades that cell live so the fillable column can settle it; expect few trades (about one per coin-hour with a qualifying move) and judge only after 100+. Live it reads latestAhead of the coin's 15m series, so it needs the 15m recorder alive." },
  { name: "ahead5-cheap60-15m-hot", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, aheadRegime: [0.6, 1.01], aheadRegimeN: 10, added: "2026-11-02", idea: "ahead5-cheap60-15m-first3 only while the early move is 'hot': at least 6 of the last 10 resolved early moves across all coins (one per coin and window, at most 2 h old) won. This probe exists to settle a hypothesis the replay REJECTS. Round 135 (2 Nov 2026, $HOME/an/regime.py; 1,163 early-move looks and 544 late 88c+ favourite looks of 20-30 Oct, 7 coins; for each look the win rate of the last 5, 10 or 20 early moves whose windows had already resolved): the recent market-wide win rate carries no stable information. Last 10 under 40% won: 59.6% won +$0.032 per $1 (166; fillable +$0.030 on 130); 40-60%: 59.0% +$0.023 (251; fillable +$0.045); 60-80%: 62.2% +$0.087 (378; fillable +$0.061); 80%+: 64.2% +$0.124 (341; fillable +$0.069). The mild upward slope flips: in the first half of the days the cold band is the best (+$0.094 vs -$0.036 for 60-80%), in the second half the hot bands lead (+$0.19 and +$0.21 vs -$0.083 cold); BTC+ETH are flat in every band (+$0.03 to +$0.06); 12-21 KST has both extremes green and the middle red. The last 5 and last 20 behave the same way. The late favourite ignores the early-move regime entirely (every band 91-95% won, -$0.03 to +$0.01, 544) and its own recent streak too (80%+ of the last 10 favourites 92.8% -$0.011 on 470). Per day, the first ten looks' win rate does not predict the rest of the day (20 Oct 100% then +$0.235; 26 Oct 40% then -$0.11; 29 Oct 70% then +$0.24). Reading: a run of lost early moves is not a regime, it is variance, so pausing a rule after a red hour (or sizing up after a green one) has no basis in the data; the rules' edge, where it exists, is per window. Live the gate reads a shared log of resolved early-move outcomes written at settlement (lost on restart, so the probe sleeps until 10 windows have resolved, about 30 min); if after 100+ trades its fillable column matches ahead5-cheap60-15m-first3, the hot-hand idea is dead for good." },
  { name: "fav88-15m-late-asia-uncrowded", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [3, 12], favBidMaxUsd: 1000, added: "2026-11-02", idea: "fav88-15m-late-asia that skips the CROWDED favourite: when more than $1,000 is already resting on the favourite's own bids within 3c under its best ask, stand aside. Round 136 (2 Nov 2026, $HOME/an/favbook.py; 544 late 88c+ favourite looks at 3 minutes left on the 20-30 Oct real 15m books, 7 coins, each joined with the book row at the look): the order book does NOT grade the late favourite. Favourite-side spread, favourite ask depth, the underdog's best bid, the underdog's bid and ask depth and the favourite-to-underdog bid ratio all land at 90-98% won and within +/-$0.05 per $1 of each other, and every split (BTC+ETH vs alts, first vs second half of the days) reorders the bands: the underdog carrying under 200 bid shares is 100% +$0.066 on the alts (48) and 87.5% -$0.047 on BTC+ETH (8); the underdog best bid under 6c is -$0.053 in the first half and -$0.007 in the second. So, as rounds 103, 104, 118 and 119 found from the other side, the book has already priced the last three minutes and the favourite's edge is context (hours, BTC agreement, the coin's own 5m market), not book shape. The one band that leans the same way in every cut is the crowded favourite: $1,000+ of bids within 3c under the favourite 91.2% won -$0.029 per $1 (204; fillable 89.5% -$0.048 on 172) against 94.2% +$0.006 for the rest (340); in the real rule's 12-21 KST hours 94.9% +$0.009 (78; fillable 93.8% -$0.005 on 65) against 98.5% +$0.054 (130; fillable 98.2% +$0.056 on 110); on BTC+ETH 91.1% -$0.030 (202) against 93.3% -$0.006 (220). Reading, if it is real: a wall of resting bids under a 90c favourite is the crowd queuing to buy the sure thing, and the sure thing that fails is the one everybody owns. It is a thin margin on an absolute dollar threshold that only BTC and ETH books reach, so this is a probe against fav88-15m-late-asia on the fillable column after 100+ trades, not a finding to act on." },
  { name: "ahead5-cheap60-15m-stale", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, aheadAskStaleSec: 3, added: "2026-11-02", idea: "ahead5-cheap60-15m-first3 only when the best ask on the side we buy has sat at the SAME price for 3+ seconds of 1-s rows, i.e. the market maker has not repriced it during the move. Round 137 (2 Nov 2026, $HOME/an/stale1.py to stale3.py; 702 BTC and ETH early-move looks of 20-30 Oct from the real 15m books, staleness = consecutive prior seconds with an identical best-ask price): the maker is fast. On 530 of 702 triggers the ask had changed in that same second, on 645 within 3 s; only 57 (8%) met an ask 3+ s old. Those 57 won 68.4% for +$0.224 per $1 (fillable 48, 64.6% +$0.150) against 59.8% +$0.037 for the fresh 645 (fillable 500, 58.4% +$0.011). The lean holds on both coins (BTC 74.1% +$0.309 on 27, ETH 63.3% +$0.147 on 30), in both halves of the days (20-25 Oct +$0.362 vs +$0.166 on 21/281; 26-30 Oct +$0.143 vs -$0.063 on 36/364), at 50c+ (69.4% +$0.207 on 49 vs 60.4% +$0.029 on 598), in the evening (21-03 KST 84.0% +$0.518 on 25 vs 63.5% +$0.109 on 244) and the day (12-21 KST 66.7% +$0.249 on 9 vs 56.0% -$0.044 on 193), and fails in the 03-12 KST mornings like every early-move cut (52.2% -$0.107 on 23). The ask 1-2 s old is the odd red band (56.5% -$0.011 on 115; at 45-55c 45.5% -$0.124 on 33, fillable 37.0% -$0.287): a maker that has just repriced to this level is chasing the move, a maker that has not touched the quote for 3 s is asleep or away, and an untouched quote is also the one still there when the order lands. Caveat: 57 looks is a lean, not a pillar, and the spot move during the stale span adds nothing (0-2 bps on 645 of 702). Live the gate reads a per-series record of when each side's best-ask price last changed (reset on restart), and because gates retry on later rows the probe can fire a few seconds after first3 would, once the ask has sat still for 3 s during the move; expect about a tenth of first3's trades, so it needs weeks to reach 100." },
  { name: "fav88-15m-late-up-eve", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [3, 18], onlySide: "UP", added: "2026-11-02", idea: "fav88-15m-late-asia's UP side only, extended through the evening to 03:00 KST (hoursUtc 3-18). Round 138 (2 Nov 2026, $HOME/an/side1.py and side2.py; 740 late-favourite looks at 88c+ of 20-30 Oct on the real 15m books, 7 coins): the UP favourite wins 96.1% for +$0.019 per $1 (336; fillable 96.1% +$0.016 on 282), the DOWN favourite 91.3% -$0.033 (404; fillable 90.9% -$0.039 on 339). The gap is an OFF-HOURS effect: 21-03 KST UP 98.8% +$0.041 (86) vs DOWN 88.6% -$0.064 (114; fillable 85.7% -$0.095 on 91); 03-12 KST 92.4% -$0.019 vs 88.8% -$0.056 (118/134); in the live rule's 12-21 KST band the sides are level (UP 97.7% +$0.037 on 132, DOWN 95.5% +$0.009 on 156; BTC+ETH fillable 97.5% +$0.030 vs 96.8% +$0.022). It holds in both halves of the days (UP 97.0% and 95.8% vs DOWN 88.5% and 92.7%), on 5 of 7 coins (BTC 97.2 vs 89.9, ETH 94.3 vs 91.2, HYPE 100 vs 91.3, XRP 100 vs 90.9, BNB 92.3 vs 90.5; DOGE and SOL win both sides), at 93c+ (97.9% vs 92.1% on 236/302) and in the 5-20 bps margin bands (UP 98.0% and 95.6% vs DOWN 89.4% and 90.2%), but not at 20+ bps (96.5 vs 95.7) nor under 5 bps (89.7 vs 95.7). Reading: in thin hours a 5-20 bps dip gets bought back more often than a 5-20 bps pop gets sold, so the DOWN favourite is the one that reverses into the close; rounds 14-15 saw the same at 95c on tape data. Caveats: the server's own fav95-up-only vs fav95-down-only rows (all hours, 95c+, 31 Oct to 2 Nov) show no UP advantage (BTC 113/120 -$15.7 vs 116/120 +$0.5; ETH -$10.8 vs -$5.3), and the real late favourite since 1 Nov is UP 21/24 -$2.60 vs DOWN 20/24 -$9.51, so side does not explain this week's losses and would not have rescued the daytime rule. This probe asks the one question the replay supports: does the UP favourite carry the daytime rule into the 21-03 KST evening (98.8% on 86 looks, where the base rule's DOWN side loses)? Judge against fav88-15m-late-asia on the fillable column after 100+." },
  { name: "fav88-15m-late-pm", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [6, 12], added: "2026-11-02", idea: "fav88-15m-late-asia narrowed to 15:00-21:00 KST (hoursUtc 6-12), dropping the 12-15 KST block. Round 139 (2 Nov 2026, 19:30 KST; the Mac was offline, so this round's data is the server's own record: the 181 settled real fills of 1 Nov 16:51 to 2 Nov 17:46 KST in server/status.json, plus the round-100 replay already in this file). The real late favourite (48 fills, BTC/ETH/DOGE/SOL at $3-5) reproduces the replay's hour profile: 12-14 KST 10/14 won -$13.97 (71%), 15-21 KST 31/34 +$1.86 (91%; 15-16 KST 8/8, 18-20 KST 17/18). Round 100 had the same shape on 621 fillable replay trades: 12-15 KST 94.2% won +$0.003 per $1 (69, fee-neutral) against 15-18 KST 98.9% +$0.046 (90) and 18-21 KST 98.8% +$0.047 (84). The real losses also sit at the cheap end of the band: 89-90c asks 12/17 -$15.54 while 91-93c went 20/21 +$2.05 and 88c 9/10 +$1.37, the mirror of a favourite that is still being doubted (90c) rather than settled (92c); with 17 fills that is a note, not a rule. Reading: the European morning is the quiet block; 12-15 KST still carries the tail of the Asian session's volume and the late reversals that come with it, so the rule's hours should start where the replay goes from fee-neutral to +$0.045: 15:00 KST. Live this probe trades about two thirds of fav88-15m-late-asia's windows; judge it against the parent on the fillable column after 100+ trades, and against the real fills by hour at each review." },
  { name: "ahead5-55to60-15m-first3", left: 0, cap: 0.6, minAsk: 0.55, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, added: "2026-11-02", idea: "ahead5-cheap60-15m-first3 restricted to the top of its price band, asks 55-60c only. Round 140 (2 Nov 2026, 20:30 KST; the Mac was offline for the second hour running, so the data is the server's own: the 38 settled real early-move fills of 1-2 Nov and the paper lab's per-day rows in server/status.json). Real fills by ask: 55-60c 22/31 won +$17.64 (71%), 50-55c 1/4 -$6.62, 45-50c 1/2 -$0.09, 35-45c 0/1 -$3.12, i.e. the seven cheaper tickets went 2/7 -$9.83. This runs against round 91's replay, where 45-55c was the best band (ahead7-cheap60-15m-first60), so the probe exists to see which is right on the server: a 55c+ ticket means the maker has already priced most of the move, which should mean less edge, unless the cheaper tickets are the ones the maker leaves standing because it knows something (round 122: a ticket that gets cheaper after the trigger loses). Also from the lab's day rows: the early move's bad days are MARKET-WIDE. 2 Nov was red on 6 of 7 coins (paper -$168; SOL -$76, HYPE -$53, XRP -$28, only DOGE +$1), 1 Nov red on 4 of 6, 31 Oct red on 4 of 7 (-$40), and the late favourite likewise red on 6 of 7 coins on both 1 Nov (-$73) and 2 Nov (-$53). The coins do not diversify the rule: a day is one market-wide bet, so per-market loss halts do not protect against the bad day, only the daily cap does. Fill rates differ by coin: the early-move ticket vanishes before the fill 35-38% of the time on DOGE, BNB and HYPE against 16-22% on BTC, ETH, SOL and XRP (favourite: BTC 31%, ETH 16%, the rest 18-28%). Judge against ahead5-cheap60-15m-first3 on the fillable column after 100+ trades." },
  { name: "fav88-15m-late-asia-nodissent", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [3, 12], favDissentMax: 0, added: "2026-11-02", idea: "fav88-15m-late-asia that stands down when any OTHER coin's 15m window shows an 88c+ favourite on the OPPOSITE side at the 3-minute mark, i.e. this coin is the odd one out. Round 141 (2 Nov 2026, 21:40 KST; the Mac was offline for the third hour, so the data is the server's own 181 settled real fills of 1-2 Nov). Of the 48 real late-favourite fills, 17 windows carried two or three coins at once; 13 of those windows ended the same way for every coin, and the only two fills whose favourite pointed AGAINST another coin's favourite in the same window both lost: 2 Nov 13:12 ETH DOWN at 90c (BTC and DOGE favourites UP, both won) and 17:27 BTC DOWN at 90c (ETH and DOGE UP, both won). Round 118 measured the lone favourite (no company) at 90.6% -$0.031 against 96.3% +$0.027 with company, but never isolated the dissenting one; two fills are a hypothesis, not a result, so this probe measures it live until the replay can be run. The same fills by quarter of the hour agree with round 105's replay on direction: the early move pays in the xx:00 and xx:15 windows (15/19 +$19.64) and loses in xx:30 and xx:45 (9/19 -$11.82); the late favourite the other way round, xx:30 and xx:45 19/20 +$3.25 against xx:00 and xx:15 22/28 -$15.37 (round 105: late favourite best at xx:30, worst at xx:15). Mechanism if real: a market-wide move at the close carries every coin's favourite; a coin whose favourite leans against the others is being pulled by its own flow, which the market-wide close reverses. Live the gate reads the same lateFav notes as fav88-15m-late-asia-company (the first coin to reach the mark sees no notes yet, so it only ever bites on the later coins); judge against the parent and against -company on the fillable column after 100+." },
  { name: "ahead5-cheap60-15m-farside", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, aheadPrevPos: [0, 0.5], added: "2026-11-02", idea: "ahead5-cheap60-15m-first3 only when the window OPENED in the FAR half of the previous window's range relative to the move: for an UP move the open sits in the lower half of the previous 15 minutes' Binance high-low range, for a DOWN move in the upper half, so the move travels back across the old range instead of breaking straight out of it. Round 142 (2 Nov 2026, $HOME/an/brk1.py and brk2.py; all 1,163 early-move looks of 20-30 Oct on the real 15m books, 7 coins, each joined with the Binance 1-minute candles of the previous window and this window's opening candle): far half 593 looks 64.6% won +$0.133 per $1 (fillable 449, 62.8% +$0.102) against near half 556 looks 59.2% +$0.024 (fillable 421, 58.4% +$0.013); the band 25-50% across is the best, 67.1% +$0.181 (222). The effect lives in DOWN moves: DOWN from the upper half 66.5% +$0.164 (322; fillable 64.2% +$0.122 on 240) against DOWN from the lower half 55.3% -$0.050 (282; fillable 54.7% -$0.057 on 212); UP moves are flat (62.4% +$0.098 vs 63.1% +$0.100 on 271/274). Holds on BTC (+$0.178 vs +$0.001 on 125/125), ETH (+$0.081 vs -$0.025 on 239/213), SOL, XRP and HYPE, not on BNB (level) or DOGE (fillable reversed); in 21-03 KST (+$0.28 vs +$0.10) and 12-21 KST (+$0.05 vs -$0.19; the near half's 50-75% band is 43.6% on 78) but REVERSED in the 03-12 KST morning (+$0.02 vs +$0.15); first half of the days +$0.28 vs +$0.07, second +$0.09 vs +$0.01. The companion view, the trigger price's distance from the previous window's extreme in the move's direction: still 10-20 bps inside the old range 66.9% +$0.164 (245; fillable +$0.140 on 180), green in every cut; just broken out by 0-3 bps 57.3% -$0.029 (103; fillable 52.6% -$0.113 on 78). The size of the previous range itself carries nothing (35-60 bps is the weakest band, 60+ and 20-35 both green). Reading: a move with the old range still to cross meets the resting orders placed inside it and keeps going; a move that opens at the old extreme and breaks out at once is the one the makers fade. Caveat: moderate, DOWN-driven, and the morning disagrees. Live the gate uses this window's Binance open (winRange) and the previous window's Binance high and low (prevWinRange, now kept with the range); judge against ahead5-cheap60-15m-first3 on the fillable column after 100+." },
  { name: "pull5-reentry-15m", left: 0, cap: 0.6, minAsk: 0.35, size: 5, pullbackBp: 5, pullbackWithin: [-3, 1], flatLeft: [600, 720], minWindowSec: 900, maxWindowSec: 900, added: "2026-11-03", idea: "Pullback re-entry: when the coin moved 5+ bps from its open within the first 2 minutes of a 15m window (one side only) and by minutes 3-5 the price has come back to within -3..+1 bps of the open (measured toward the breakout side), buy the BREAKOUT side again if it still asks 35-60c. Round 143 (3 Nov 2026, $HOME/an/fade1.py to fade3.py; 12,248 15m windows of 14 Oct-2 Nov on 7 coins, Binance 1-minute candles joined with each window's 1-minute UP price path): 7,396 windows broke 5 bps in minutes 0-1 and 67.6% resolved that way. Where the minute-3 close sits moves the price more than the odds: still 5+ bps toward, 76.6% continue but the side costs 78c (-$0.03 per $1); back at the open (-1..+1 bps) 56.7% still continue while the side costs 51c, +$0.087 per $1 (337; +$0.044 with 2c of slippage); crossed 1-3 bps against, 51.6% at 46c, +$0.102 (275; +$0.054 with slip). The two together, this rule's band, 612 windows 54.6% +$0.094 (+$0.049 with slip): 21-03 KST 63.9% +$0.274 (147), 03-12 KST 52.3% +$0.058 (222), 12-21 KST 50.6% +$0.018 (243); DOWN breakouts 56.6% +$0.133 (320) vs UP 52.1% +$0.051 (292); ETH +$0.196 (95), XRP +$0.217 (92), HYPE +$0.116, SOL +$0.079, BTC and BNB level, DOGE -$0.027; a 5-8 bps breakout +$0.203 (219) beats 8-12 +$0.082 (207) and 12+ -$0.021 (186); first half of the days +$0.110, second +$0.073; 11 of 20 days green with slip. The mirror, FADING the failed breakout (buying the other side), loses in every band (-$0.04 to -$0.16 per $1 on 1,446 failed breakouts): the book already prices the return and overshoots it, so the pullback is where the breakout side is cheap, not where the fade is. Caveat: minute prices from the history, not the real book, so fills and the slippage column are the honest read; a moderate, evening-driven edge. Live: winRange keeps the first-2-minute Binance high and low (hi2/lo2); entry in minutes 3-5 (flatLeft [600, 720]); judge on the fillable column after 100+." },
  { name: "pull5-reentry-15m-eve", left: 0, cap: 0.6, minAsk: 0.35, size: 5, pullbackBp: 5, pullbackWithin: [-3, 1], flatLeft: [600, 720], minWindowSec: 900, maxWindowSec: 900, hoursUtc: [12, 18], added: "2026-11-03", idea: "pull5-reentry-15m in 21-03 KST only, the band where the round 143 replay paid most: 147 windows 63.9% won +$0.274 per $1 (+$0.222 with 2c of slippage) against +$0.058 in 03-12 KST and +$0.018 in 12-21 KST. The US session is also where the early move itself pays (round 89), so the two rules read the same tape: an evening breakout that pauses is a breakout that resumes." },
  { name: "ahead5-cheap60-15m-deep100", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, askUsd: [100, 1e9], added: "2026-11-03", idea: "ahead5-cheap60-15m-first3 only when at least $100 rests on the best ask of the side we buy (the deep quote), the mirror of ahead5-cheap60-15m-thin. Round 144 (3 Nov 2026 01:40 KST; the Mac was offline, so this round reads the server's own paper lab, 5 KST days 30 Oct-3 Nov, fillable column): the day-consistency ranking (20+ fillable trades) has three rules green on most days: feed3-up60-mid-deep 4 of 5 days, fillable 36/61 +$31 (59% won) next to the live feed3-up60-mid's 9/12 real; up20-first60-eve 3/0 days (fillable 38/154 +$116, a 25% win-rate cheap ticket); ahead5-cheap60-15m-break 2/1 (22/33 +$18). The early-move parent first3 is green 1 day of 5 (paper -$375, fillable 289/485 -$266) and every favourite family (fav93, fav95, slide) is red 5 of 5. Inside the early move the server books split by coin the same way in every gated version: fillable ETH 35/55 +$16.5 and DOGE 38/60 +$9.3 carry it, BNB 29/48 level, BTC 20/38 -$22, XRP 27/55 -$53, SOL 45/98 -$104, HYPE 64/131 -$113 (houropen: ETH +$24, SOL -$11.5, HYPE -$10.5; undecided: ETH +$13.7, HYPE -$10.9; break: HYPE -$10.4, SOL -$8.7 while BTC, DOGE and BNB are green), and round 140 measured the miss rate at 35-38% on the thin DOGE, BNB and HYPE books against 16-22% on BTC and ETH. The deep gate is the structural answer to a thin-book loss: a $100+ resting ask is still there when the order lands and is quoted by a maker who means it. Round 106's replay said thin asks pay MORE per look (under $20 +$0.094 per $1 against $100-300 +$0.014) but fill ten points less often, and the 5m deep cousin is now the lab's most consistent rule, so this probe settles it on the 15m books. Judge against first3 and thin on the fillable column after 100+." },
  { name: "ahead5-cheap60-15m-first60", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [840, 870], minWindowSec: 900, maxWindowSec: 900, added: "2026-11-03", idea: "ahead5-cheap60-15m-first3 restricted to the FIRST 60 seconds of the window (flatLeft 840-870): the price is 5+ bps from the open within a minute of the open and the side still asks 35-60c. Round 145 (3 Nov 2026 02:25 KST; the Mac bridge was down again, so this round reads the server's 47 settled REAL early-move fills of 1 Nov 18:18 to 3 Nov 01:45 KST, ETH, BNB and DOGE at $3): by seconds into the window, 30-60 s 11/17 won +$5.69 (+$0.11 per $1), 61-90 s 4/12 -$16.19 (-$0.45), 91-120 s 2/7 -$10.79 (-$0.51), 121-150 s 8/9 +$14.22 (+$0.53), 151-180 s 1/2 -$1.17. The second minute holds the family's whole loss: -$27 on 19 fills, against +$5.69 on the first minute. ETH first minute 9/13 +$6.62 (+$0.17) against later 7/15 -$9.69 (-$0.22); UP first minute 8/10 +$11.99 (+$0.40) against later 9/18 -$8.60; at 55-60c (where 39 of the 47 fills sit) 10/14 +$8.89 first minute against 14/25 -$4.20 later; 21-03 KST first minute 5/8 +$2.29 against later 4/12 -$14.85; the 03-12 KST morning is the one band that flips (2/4 -$2.05 against 6/9 +$3.36). BNB is level either way (2/4 against 7/13). This is the real-money echo of round 91's paper replay (early move pays most in the first 60 s, 45-55c, 7+ bps), which spawned ahead7-cheap60-15m-first60; that probe sits at 7 bps and has few trades, so this one keeps the 5 bps threshold and changes only the clock. Reading: a move that shows 5 bps within the first minute is a reaction to news or flow that arrived at the open and has 14 minutes to run; a move that only reaches 5 bps in the second or third minute is a slow drift the makers have had time to reprice. Caveat: 47 fills, and the 121-150 s band (8/9) says the picture is not a clean decay; judge on the fillable column against first3 after 100+, and the 04:40 reviews decide whether the live ETH rule narrows to the first minute." },
  { name: "ahead5-cheap60-15m-cblead", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, aheadXchgLead: [1, 99], added: "2026-11-03", idea: "ahead5-cheap60-15m-first3 only when COINBASE leads the move: Coinbase sits 1+ bps further toward the side we buy than its usual spread to Binance (the 600-row median of the Binance-Coinbase gap, the round 34 gauge), i.e. the US venue is driving. Twin: ahead5-cheap60-15m-binlead takes the mirror (Binance 1+ bps ahead). Round 146 (3 Nov 2026 03:30 KST): NO REPLAY NUMBER. The Mac bridge was offline for the third hour running, so the written replay ($HOME/an/xlead1.py: 1,163 real-book early-move looks of 20-30 Oct split by the de-meaned Coinbase-Binance gap toward the move) has not run; these two probes gather the live data instead, the way the 1h probes of round 62 did. What is known: round 110 found an early move confirmed by any exchange pays +$0.08 to +$0.11 per $1 while a Chainlink-only move loses, so exchange agreement matters; round 34 found which exchange sits higher did not pick the winner for CHEAP tickets at 2 minutes left on 5m books (Binance side -$0.22, Coinbase side -$0.16 per trade), which was a different cell (late, 10-40c, 5m). Hypothesis: a 15m early move led by Coinbase is US spot flow (ETFs, US desks) that Chainlink's aggregate follows with a lag, while a Binance-led move is perp-driven and more often faded; the pair answers it on the fillable column. Server facts this hour: the newest probes opened first60 5/5 +$14.9 and deep100 6/8 +$10.0 fillable in their first hours, while pull5-reentry opened 3/12 -$34.6, the minute-price replay's 49c pullback price not matching what the real book asks (the stale-print lesson of rounds 45 and 66 again); the real BTC 5m feed3-up60-mid stands 12/17 +$15.12 with 5/5 +$14.81 in 03-12 KST against 6/12 -$1.69 in 21-03 KST, and no decay by seconds into the window (first 60 s 6/9 +$7.6, later 6/8 +$5.5). Judge the pair against first3 after 100+ fillable each." },
  { name: "ahead5-cheap60-15m-binlead", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, aheadXchgLead: [-99, -1], added: "2026-11-03", idea: "the mirror of ahead5-cheap60-15m-cblead: the early move only when BINANCE sits 1+ bps further toward the side we buy than its usual spread to Coinbase (perp-driven move). Round 146 (3 Nov 2026), no replay number yet (Mac offline); the two probes together say which venue's lead, if either, pays on the 15m books." },
  { name: "ahead5-cheap60-15m-dayhalt3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, added: "2026-11-03", idea: "ahead5-cheap60-15m-first3 with a FAMILY day-halt: after 3 straight losses of this rule across ALL coins together, it sits out on every coin until the next KST midnight. Twin: ahead5-cheap60-15m-dayhalt5 waits for 5. Round 147 (3 Nov 2026 04:25 KST; the Mac was offline for the fourth hour, so this reads the server's own lab): the early move has been under break-even on EVERY server day since the move. Paper first3 across 7 coins: 30 Oct 6/7 +$13 (the first evening), 31 Oct 165/286 57.7% -$40, 1 Nov 55/109 50.5% -$86, 2 Nov 120/250 48.0% -$258, 3 Nov 42/78 53.8% -$36 so far; 723 trades at an average ask near 55c need about 58.5% to break even and ran 53%, against the 62% the 20-30 Oct Mac replays showed. Every gated version added since (first60, deep100, break, farside, stale, 55to60, cblead/binlead, houropen, undecided, coiled, hot) runs on the same tape and inherits the red regime; only break (26/41 fillable +$13.5), the one gate that filters on the previous windows' outcomes, is green. The regime probe ahead5-cheap60-15m-hot (trade only after the last 10 early moves won 60%+) is red too (fillable 24/58 -$80): a hot streak does not predict the next trade, and round 31 found the same for loss streaks on the feed rule (the next trade after 6 straight losses won 43% vs 34% overall). What the per-series stop cannot see is round 140's finding that the bad days are MARKET-WIDE (2 Nov: red on 6 of 7 coins; 1 Nov 4/6; 31 Oct 4/7), so coins do not diversify and a per-coin halt keeps paying on the other six coins. This probe tests the one stop that matches the shape of the loss: count the family's losses across coins, and when 3 come in a row stop the whole family for the KST day. The cost side is round 31's lesson (a stop skips winners too), so the twin at 5 losses measures the trade-off. The real rules use haltAfterLosses per market (ETH 4, BNB 4), and BNB's halt on 3 Nov 00:01 KST came after the family had already lost 5 of 6 across ETH and BNB since 23:00. Judge both against first3 on the fillable column after 100+ and on the number of red days." },
  { name: "ahead5-cheap60-15m-dayhalt5", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 5, added: "2026-11-03", idea: "ahead5-cheap60-15m-dayhalt3 with the family stop at 5 straight losses across all coins instead of 3 (round 147, 3 Nov 2026): the looser twin, to measure how many winners each stop skips against how much of a market-wide bad day it avoids." },
  { name: "feed3-down60-mid", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "DOWN", added: "2026-11-03", idea: "the DOWN mirror of feed3-up60-mid, the one real rule with a positive record: Binance 3+ bps BELOW Chainlink (over the series' usual gap), 120+ s left, buy DOWN while it still asks 40-60c. Round 148 (3 Nov 2026 05:20 KST; the Mac was offline for the fifth hour, so this reads the server lab since 30 Oct): the 5m feed rule is a BTC-ONLY edge. feed3-up60-mid fillable on btc5m 20/32 +$36.6 (real 14/23 +$12.27, 4 of 5 paper days green) against the other six 5m coins together 451/1047 -$980 (every one red: ETH -$11, SOL -$104, XRP -$73, DOGE -$105, BNB -$88, HYPE -$278) and the seven 15m series 241/538 -$395 (only ETH 15m +$14 and BTC 15m -$31 are near flat); the 1h series are red on every coin and the 4h too thin. The same split holds for the cheaper feed3-up60-min20 (BTC fill 17/36 -$17, so the 20-40c tickets are where even BTC loses) and for round3-up60 (BTC 90/171 +$41, every alt red). Reading: a 3 bps Binance-vs-Chainlink lead is a signal on the one book deep enough for the maker to lag it honestly; on thin alt books the same lead is already in the ask, or the ask is gone (BTC misses 70 of 102 signals, the alts 40-50%). Open question this probe answers: is the BTC edge an UP-side effect? Every paying feed rule is UP-only (round 26's cheap-UP bias), and the only DOWN feed rule in the lab, feed3-down20-mid, buys the 10-20c ticket (fillable 0/4 on BTC, 11/97 -$79 overall), which is the wrong price zone to compare. This is the exact mirror at 40-60c, all series, judged on btc5m first; if DOWN pays on BTC too, the real rule can run both sides; if it loses while UP keeps paying, the edge is the UP skew of the 5m book, not the feed lead. Judge after 100+ fillable on BTC against feed3-up60-mid." },
  { name: "feed3-up60-mid-pulled3", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", confirmSec: 5, confirmCap: 0.63, confirmDipC: 0.03, pulledChaseC: 3, added: "2026-11-03", idea: "feed3-up60-mid that does not buy the ask it sees: it arms the window at the trigger and buys only if that ask is pulled or lifted (the UP best ask rises) within 5 s, paying up to 3c over the trigger ask and never over 63c; an ask still sitting there after 5 s is skipped and a 3c dip cancels. Round 149 (3 Nov 2026, server paper lab since 30 Oct; paper minus fillable = the tickets the fill audit found gone 2-5 s later): across the whole feed family the fillable tickets won 22.0% (6661/30338, -$45.6k) and the missed ones 33.8% (5682/16834, +$17.0k); for feed3-up60-mid the gap is 7-24 points on every 5m coin (BTC fillable 20/32 62.5% +$37 vs missed 51/73 69.9% +$132; ETH 50.0% vs 63.3%; SOL 44.7 vs 54.6; BNB 38.2 vs 62.5; HYPE 41.1 vs 54.3; DOGE 43.8 vs 51.9; XRP 43.4 vs 50.0), with 40% of signals missed overall and 70% on BTC, and the same gap on the 15m series (BTC 43 vs 54, XRP 47 vs 63). The 15m early move shows no such gap (ahead5-cheap60-15m-first3 fillable 53.0% vs missed 53.8%; the favourites 89.0 vs 89.9), so it is the feed signal itself that the fast makers also watch: the quote that vanishes is the one that was right, and every feed rule's paper record is inflated by exactly those tickets while its fillable record is the adverse-selected rest. This probe buys the repriced book after the pull: break-even at 53c is 53.9% won, so it needs the missed column's win rate to survive a 3c chase. Judge on its fillable column against feed3-up60-mid after 100+ trades; if the chase loses too, the pull already consumed the edge and the feed family is a BTC-deep-ask story only." },
  { name: "feed3-up60-mid-hold1", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", confirmSec: 1, confirmCap: 0.6, confirmDipC: 0.03, added: "2026-11-03", idea: "feed3-up60-mid that buys what a real order gets: it arms at the trigger and buys 1 s later whatever the UP side asks up to 60c (a 3c dip cancels), so its paper column counts only quotes that survived about the server's round trip. Round 150 (3 Nov 2026, the server's last 200 real orders against the lab's fillable tag on the same series): the real bot filled 180/200 (90.0%; median order round trip 280 ms, fills 94.5% under 300 ms, 85.7% at 300-500 ms, 67% above 500 ms; all 19 misses were FAK orders that found nothing although the quote was there at order time). The audit tags far fewer tickets as fillable than the bot fills: BTC 5m feed3-up60-mid real 27/37 filled (73%) against 33/107 tagged (30.8%); ETH 15m early move 35/38 (92%) against 65/83 (78%); BNB early move 76% against 68%; round3-up60 100% against 74%; the favourites 90-100% against 53-88%. So the fillable column, which the whole lab is judged on, is 2-3x too strict for the feed rule (its quotes are pulled fast, but not within 300 ms), and round 149 showed the tickets it drops are the better half. This twin and feed3-up60-mid-pulled3 split every signal: pulled within the second (pulled3 chases it) or still there after the second (hold1 takes it). Judge hold1's paper column directly against the real BTC rule's fills, no fillable discount; if it tracks real, the 1-s hold is the lab's honest column for fast-pulled rules." },
  { name: "ahead5-cheap60-15m-first60-hold1", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [840, 870], minWindowSec: 900, maxWindowSec: 900, confirmSec: 1, confirmCap: 0.6, confirmDipC: 0.03, added: "2026-11-03", idea: "the live ETH rule (ahead5-cheap60-15m-first60) that buys what a real order gets: arm at the trigger, buy 1 s later at the then-current ask up to 60c, a 3c dip cancels. Round 150 (3 Nov 2026): the early move's audit is closer to real than the feed rule's (ETH real 35/38 filled, 92%, vs 65/83 tagged, 78%; first60 itself 5/5 real vs 5/8 tagged), so this twin should run near its base rule; a gap would mean the first-minute quotes are pulled inside the second. Companion to feed3-up60-mid-hold1; judge against the real ETH fills." },
  { name: "feed3-up60-mid-quota16", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", maxPerDay: 16, added: "2026-11-03", idea: "feed3-up60-mid with a quota: at most 16 trades per coin per KST day, then it sits out until midnight. Round 151 (3 Nov 2026, the server lab's per-day records, full days 31 Oct-2 Nov, 42 coin-days of the 5m feed rule): the coin-days with few signals are the ones that win. Under 17 signals a day: 81 trades, 60.5% won, +$61 (+$0.75 a trade); 17 or more: 1,821 trades, 48.6%, -$702 (-$0.39); under 25: 202 trades 55.4% +$54 against 48.4% -$694 above. The 20-40c cousin feed3-up60-min20 splits the same way (under 17: 42 trades 64.3% +$158; 17+: 44.3% -$605), and within a coin its quieter-than-median days beat its busier ones for every family member (feed3-up60-mid 56.5% +$113 against 48.5% -$612 with the partial days in). The early move has no such split on full days (first3 under 17 signals 51.5% against 52.9% above) and neither do the favourites, so it is a property of the feed signal: on a busy tape a 3-bps Binance lead is routine noise, on a quiet one it is information. The quiet coin-days are Saturday 1 Nov on BTC, ETH and XRP and BTC on 2 Nov, so day-of-week and coin are tangled in it, and the day's count is only known at the close; this quota asks the live question instead: do the FIRST 16 signals of every day carry the quiet-day edge, or is it the day itself that is good? Judge the fillable column against feed3-up60-mid after 100+ trades; feedp95-up60-mid tests the other reading (a bar that rises with the day's noise)." },
  { name: "feedp95-up60-mid", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, feedLeadPct: 95, jumpMinLeft: 120, onlySide: "UP", added: "2026-11-03", idea: "feed3-up60-mid whose bar rises with the coin's own feed noise: Binance must lead Chainlink by the larger of 3 bps and the 95th percentile of that coin's |lead| over the last ~10 minutes (the round-21 feedLeadPct plumbing, here in the 40-60c band instead of the 20c tickets). Round 151 (3 Nov 2026): the feed rule's coin-days with few signals win (under 17 signals 60.5% won +$0.75 a trade on 81; 17 or more 48.6% -$0.39 on 1,821, full days 31 Oct-2 Nov) and the early move shows no such split, so the reading is that on a noisy tape a fixed 3-bps lead is routine. An adaptive bar fires less exactly when the tape is noisy, which is what a quiet day looks like from the inside. The 20c version (feedp98-up20) never beat its fixed-bar twin on real asks (fillable 84/909 -$1,614), so this is a probe for the mid band only; judge it against feed3-up60-mid and feed3-up60-mid-quota16 on the fillable column after 100+ trades." },
  { name: "fav91-15m-late-wide", left: 0, cap: 0.93, size: 5, favAt: 0.91, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, added: "2026-11-03", idea: "the 15m late favourite with the floor raised to 91c: between 4 and 4:40 minutes before the close buy the favourite the first time it asks 91-93c, any hour. Round 152 (3 Nov 2026, the server's 39 real 15m favourite fills of 1-2 Nov cross-tabbed by hour block and ask): the 88-90c tickets lost in BOTH blocks (12-15 KST 6/9 -$10.25, 15-24 KST 9/11 -$3.75; 15/20, 75.0%, -$14.00 together, against 88.7-90% needed) while the 91c+ tickets won 18/19 (94.7%, +$1.00; 15-24 KST 14/14 +$4.73, 12-15 KST 4/5 -$3.72). So most of what the 15-21 KST hour gate buys is the ask floor: a favourite that has only reached 88-90c with four minutes left is a contested window, and the afternoon looks good because its favourites run richer (average ask 91.6c in 15-20 KST against 89.8c in 12-15 KST). The day-to-day read on the same records adds nothing to lean on: across 3,593 rule-and-series day pairs a green day is followed by a green day 61% of the time, mostly the base rate of red, and after a green day every family still runs red (feed3-up60-mid 50.1% vs 47.5% after red, early move 49.0 vs 47.5, fav93 92.6 vs 90.0), so no streak gate. Break-even at 92c is 92.5% won, so this is a thin-margin rule by nature: judge on the fillable column after 100+ trades against fav88-15m-late-wide (no hour gate, 88c floor) and fav91-15m-late-pm (the hour gate on top)." },
  { name: "fav91-15m-late-pm", left: 0, cap: 0.93, size: 5, favAt: 0.91, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [6, 12], added: "2026-11-03", idea: "fav91-15m-late-wide restricted to 15-21 KST, i.e. the live fav88-15m-late-pm rule with its floor raised from 88c to 91c. Round 152 (3 Nov 2026): on the server's real 15m favourite fills the 91c+ tickets won 18/19 (14/14 in 15-24 KST, +$4.73) while the 88-90c tickets won 15/20 and lost -$14.00 in every hour block, so the floor is the lever and the hour gate a proxy for it. The candidate to replace the live rule if the lab agrees: judge on the fillable column after 100+ trades against fav88-15m-late-pm and fav91-15m-late-wide." },
  { name: "fav93-feedgreen", left: 0, cap: 0.995, size: 5, favAt: 0.93, trailN: 20, trailOf: "feed3-up60-mid", added: "2026-11-03", idea: "the 5m favourite (fav93: buy the 93c+ side) only while the feed rule feed3-up60-mid's last 20 settled paper trades across all coins are net positive, i.e. only on the kind of day the Binance lead is paying. Round 153 (3 Nov 2026, the server lab's per-day records, 31 Oct-2 Nov): the families share their good and bad coin-days on 5m but not on 15m. On the same coin and KST day the feed rule and the 5m favourite move together (correlation of net per trade +0.39 over 63 coin-days; round3-up60 and fav93 +0.42): fav93 won 93.7% (2211/2360) on coin-days the feed rule was green and 89.6% (4767/5318) on the days it was red, a four-point swing that is the favourite's whole margin at 93c (break-even 93.3%), though it stayed red in both (-$109 and -$1,480). The two LIVE families do not share days: the 5m feed rule and the 15m early move correlate -0.04 over 19 coin-days, and the 15m early move and the 15m late favourite +0.07, so the real set is diversified across them and the per-market daily caps are the right level; the early move does share days with the previous-window momentum rules (+0.25 with prev-momentum, -0.30 with prev-reverse: trend days). This probe asks whether the feed rule's live record can time the 5m favourite inside the day (R147's self-streak gate on the early move was red; a cross-family gate was never tried). 5m favourites are off for real for good (fee-neutral), so this is lab research on day regimes, not a promotion candidate: judge on the fillable column against fav93 after 200+ trades." },
  { name: "feed3-up60-mid-pulled5", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", confirmSec: 5, confirmCap: 0.65, confirmDipC: 0.03, pulledChaseC: 5, added: "2026-11-03", idea: "feed3-up60-mid-pulled3 with a longer leash: buy only after the trigger ask is pulled within 5 s, paying up to 5c over it (65c max). Round 154 (3 Nov 2026, the pulled3 probe's first five hours on the server, fillable column): 28/46 won (60.9%) for +$41.3 across every series, and the edge sits where the base rule is worst: on the 5m alts it is 14/16 +$54.8 (SOL 6/7 +$21.6, HYPE 3/3 +$11.4, DOGE 2/2 +$10.1, ETH 1/1, BNB 1/1, BTC 1/2) on a day the base feed rule's paper record on the same coins ran DOGE 24/55 -$50 and HYPE 33/70 -$39; on 15m it is 11/20 +$11.1 and on 1h 3/10 -$24.6. So the round-149 reading holds live: the feed signal's edge is in the tickets the fast makers pull, and buying the repriced book recovers it on coins where buying the resting ask never did (round 148 found the base rule BTC-only). This probe asks how much chase the edge can pay for: 3c is the round-149 setting, 5c tests whether the pulled tickets that reprice harder (the ones pulled3 skips as over its 63c cap) still win enough at 61-65c (break-even at 63c is 63.5% won). Judge on the fillable column against pulled3 after 100+ trades; a 5m-only twin is unnecessary because the per-series rows show the split." },
  { name: "feed3-up60-mid-pulled3-w10", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", confirmSec: 10, confirmCap: 0.63, confirmDipC: 0.03, pulledChaseC: 3, added: "2026-11-03", idea: "feed3-up60-mid-pulled3 that waits up to 10 s instead of 5 s for the trigger ask to be pulled (same 3c chase, 63c cap). Round 154 (3 Nov 2026): pulled3 is 28/46 +$41.3 fillable in its first five hours (5m alts 14/16 +$54.8, 15m 11/20 +$11.1, 1h 3/10 -$24.6) while its sibling hold1, which buys the ask that is still there after 1 s, is 29/66 -$35.7, so the pull is the signal and the unpulled quote the adverse-selected rest (round 149). The open question is how long a maker takes to react: a 10-s window catches slower pulls at the cost of entering later in the move. Judge against pulled3 on the fillable column after 100+ trades; if it loses, the pulls that matter happen inside 5 s." },
  { name: "fav91-15m-late-pm-firm", left: 0, cap: 0.93, size: 5, favAt: 0.91, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [6, 12], confirmSec: 1, confirmCap: 0.93, confirmDipC: 0.01, added: "2026-11-03", idea: "fav91-15m-late-pm that arms at the 91c hit, waits 1 s and buys at the then-current ask (up to 93c) only if the side's best ask has not dropped 1c or more in between; one attempt per window. Round 155 (3 Nov 2026): the server's 180 settled real fills graded by where the fill landed against the signal ask (an order takes ~250 ms): the favourite fills that landed 1c UNDER the signal ask, i.e. the ask was already falling as the order went in, won 6/10 for -$13.95, half the family's real loss (-$27.57 over 70 fills), while fills at the ask won 41/46 (89%) and fills above it 12/14; by rule, fav88-15m-late-asia 5/8 -$11.17 under the ask against 20/21 +$5.40 at it. The other families agree that the direction of the slip is the signal: BTC feed fills that paid over the signal ask (the ask was lifted first and the order chased to 60c) 12/25 48% -$6.35 against 8/10 +$19.65 at the ask or better; the early move 3/7 over the ask against 11/17 under it. Order latency itself says nothing (median 256 ms on favourite winners vs 250 ms on losers). Mechanism: a favourite whose ask is falling at the hit is being sold into, and the ~300 ms an order takes is long enough for that to show in the fill; waiting one second and requiring the ask to hold makes it a gate. First use of the confirmSec arming on the favAt rule. Judge against fav91-15m-late-pm on the fillable column after 100+ trades; if it holds, the live fav91 rule is the candidate for this gate." },
  { name: "feed3-up60-mid-cool30", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", coolMin: 30, added: "2026-11-03", idea: "feed3-up60-mid (the live BTC 5m rule) that skips any signal coming less than 30 minutes after its previous one on the same coin. Round 159 (3 Nov 2026): the server's ~180 settled real fills graded by the gap since the same rule family's previous signal on the same market: 10-30 min after the last one 43/79 54% -$49.38, 30-90 min 33/44 75% +$19.15, under 10 min 24/33 -$4.98, over 90 min 11/16 +$0.28. BTC feed alone: 10-30 min 7/21 -$21.74, under 10 min 8/15 +$1.56, 30-90 min 7/10 +$11.04, 90+ 2/3 +$2.21; a 30-minute cooldown keeps 9/13 +$13.25 and drops 15/36 -$20.18. Early move 10-30 min (the previous one or two 15m windows) 18/34 -$9.10 vs 30-90 min 13/20 +$8.21; late favourite 10-30 min 18/24 -$18.54 vs 30-90 min 13/14. The intraday echo of the feed's busy-day finding (wins on days under 17 fires): a signal soon after another is the market chopping, an isolated one is news. New coolMin option. Judge against feed3-up60-mid on the fillable column." },
  { name: "ahead5-cheap60-15m-first60-cool30", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [840, 870], minWindowSec: 900, maxWindowSec: 900, coolMin: 30, added: "2026-11-03", idea: "ahead5-cheap60-15m-first60 (the live ETH rule) that skips a signal within 30 minutes of its previous one on the same coin, i.e. when it also fired in one of the last two 15m windows. Round 159 (3 Nov 2026): real early-move fills 10-30 min after the previous signal 18/34 -$9.10, 30-90 min 13/20 +$8.21. See feed3-up60-mid-cool30 for the family-wide numbers." },
  { name: "ahead5-cheap60-15m-break-nohype", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, prevRun: [2, 3], prevRunRel: "against", skipCoins: ["hype"], added: "2026-11-03", idea: "ahead5-cheap60-15m-break (the lab's steadiest early-move rule) without HYPE. Round 160 (3 Nov 2026, server lab at 18:00 KST): break is 40/64 +$17.9 fillable, but HYPE 15m alone is 10/22 -$23.7 (all trades 12/28 -$39.2, red on all three days: -$2, -$11, -$27), while the other six coins are 30/42 71% +$41.6 (DOGE 10/10 +$31.3, BNB 4/4 +$12.2, XRP 3/4 +$7.4, ETH 3/4 +$5.0; BTC 4/8 -$6.8, SOL 6/12 -$7.5). HYPE 15m also drags the pulled-ask chase (4/11 -$17.7 while HYPE 5m is 6/9 +$11.7), so the thin HYPE 15m book (35-38% of tickets missed, round 140) is where both lab leaders lose. Promotion-track twin: if break reaches 100 fillable trades, this is the version a review should weigh." },
  { name: "feed3-up60-mid-pulled3-5m-alts", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", confirmSec: 5, confirmCap: 0.63, confirmDipC: 0.03, pulledChaseC: 3, maxWindowSec: 300, skipCoins: ["btc"], added: "2026-11-03", idea: "feed3-up60-mid-pulled3 on the 5m alts only (ETH, SOL, XRP, DOGE, BNB, HYPE). Round 160 (3 Nov 2026, server lab at 18:00 KST, pulled3's first full day): fillable by window length 5m 23/36 +$38.0, 15m 18/35 +$1.6, 1h 11/22 -$16.7; inside 5m BTC 1/3 -$3.9 and the alts 22/33 +$41.9 (DOGE 5/6 +$18.6, HYPE 6/9 +$11.7, SOL 9/14 +$11.3). Round 154 saw the same split in its first hours; this twin tracks the cell on its own so a review can judge it at 100 fillable trades without the 15m/1h noise." },
  { name: "feed3-up60-mid-q0", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", quarters: [0], added: "2026-11-03", idea: "feed3-up60-mid (the live BTC 5m rule) only in the first quarter of the hour: windows starting xx:00, xx:05 or xx:10. Round 161 (3 Nov 2026): the server's 179 settled real fills by the quarter of the hour their window starts in: xx:00-14 43/58 74% +$7.97, xx:15-29 24/40 -$19.81, xx:30-44 27/48 -$22.88, xx:45-59 19/33 -$14.85, so every quarter but the first is red. The BTC feed carries it: xx:00-14 11/16 +$16.32, xx:15 3/9 -$8.42, xx:30 5/18 -$24.07, xx:45 5/8 +$3.04. The top of the hour is when hourly candles, the 1h markets and scheduled news land, so a Binance lead then is information; later in the hour it is drift. Caveat: the early move's q0 twin (ahead5-cheap60-15m-q0, round 105) is 61/109 -$28.94 fillable on paper, so the quarter effect has not held for that family; judge this one against feed3-up60-mid on the fillable column after 100." },
  { name: "fav91-92-15m-late-pm", left: 0, cap: 0.92, size: 5, favAt: 0.91, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [6, 12], added: "2026-11-03", idea: "fav91-15m-late-pm (the live ETH/BTC/DOGE rule) with the cap lowered from 93c to 92c, so the top 1c of the band is never bought. Round 162 (3 Nov 2026): the server's 40 real 15m favourite fills by the signal ask: 91c 9/10 +$0.46, 92c 6/6 +$1.90, 93c 9/11 82% -$6.74 (break-even at 93c is about 93.5%, so one loss in eleven wipes the band); below the floor 88-90c 9/13 -$13.85 (Review 11's cut). 91-92c together 15/16 +$2.36. The first live 91c afternoon (3 Nov 15:00-20:00 KST) agrees: the one loss on ETH was a 93c ticket. At 93c the favourite pays 7c to risk 93c and needs 13 wins per loss; at 91c it needs 10. Paper's own fav91-15m-late-wide is 81/90 -$12.3 fillable across all coins, so the band is thin everywhere; this twin measures whether dropping 93c fixes it. Judge against fav91-15m-late-pm on the fillable column; the live lever is the order cap (\"cap\": 0.92 in deploy/live-rules.json)." },
  { name: "fav91-15m-late-wide-xebh", left: 0, cap: 0.93, size: 5, favAt: 0.91, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, skipCoins: ["eth", "bnb", "hype"], added: "2026-11-03", idea: "fav91-15m-late-wide (any hour, 91-93c) without ETH, BNB and HYPE. Round 163 (3 Nov 2026, server lab 21:00 KST): the 15m late favourite's fillable record by coin is the same ranking in all four favourite rules. fav91-15m-late-wide: DOGE 16/16 +$6.4, XRP 15/16 +$0.9, SOL 11/12 -$0.6, BTC 10/11 -$0.9 = 52/55 +$5.8, against ETH 9/11 -$6.0, BNB 14/16 -$4.4, HYPE 10/13 -$11.0 = 33/40 -$21.4. fav88-15m-late-asia (178 fillable): HYPE 26/36 -$37.2, ETH 26/32 -$17.9, the other five 132/152 -$9.6 (DOGE 32/35 +$1.2). fav88-15m-late-pm: DOGE 13/13 +$7.1, SOL 7/7 +$3.3; ETH 8/11 -$11.6, HYPE 6/9 -$11.8. This contradicts the old note that only BTC/ETH favourites are trustworthy by sample: on the server's own books DOGE is the most reliable favourite and ETH the second worst after HYPE. The rules share windows, so these are not independent samples, and reversals still hit coins together (round 140). The live fav91 rule trades ETH, BTC and DOGE; judge this twin against fav91-15m-late-wide on the fillable column before any review moves ETH off the live favourite." },
  { name: "feed3-up60-mid-noasiapm", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", skipHoursUtc: [3, 4, 5, 6, 7, 8], added: "2026-11-03", idea: "feed3-up60-mid (the live BTC 5m rule) off from 12:00 to 18:00 KST (03-09 UTC). Round 164 (3 Nov 2026): the BTC feed's 51 settled real fills since 1 Nov 20:26 KST by 3-hour KST block: 06-12 KST 10/13 +$20.04, 12-15 KST 4/12 -$13.99, 15-18 KST 0/5 -$15.55, the rest (18-06 KST) 11/22 -$0.30. The 12-18 KST hole holds the rule's whole real loss over two days: -$29.54 on 17 fills (24% won) against +$19.74 on 35 fills elsewhere. 12-18 KST is the European morning, when the BTC book is busiest and Binance moves are least informative for the Chainlink settle (the feed's busy-day finding, intraday). Judge against feed3-up60-mid on the fillable column; the live lever would be the same skip on the real rule." },
  { name: "feed3-up53-mid", left: 0, cap: 0.53, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", added: "2026-11-03", idea: "feed3-up60-mid that only signals at asks of 40-53c, i.e. the signal leaves at least 3c of room under the live rule's 56c order cap (Review 12). Round 165 (3 Nov 2026): the BTC feed's real orders since 1 Nov 20:26 KST whose signal ask sat at or under the order limit: 14 of 66 found nothing to match (21%, against 7 of 70 for the early move and 4 of 58 for the favourite), every time with the fresh book still showing that ask, i.e. the maker pulled it in the ~360 ms the order took. Since the limit dropped from 60c to 56c the feed misses 5 of 8 such orders (19:00 at 56c, 21:21 53c, 21:35 54c, 22:21 54c, 22:42 52c) against 9 of 58 before: with 6c of room the fill-and-kill could take the next level up, with 0-4c it cannot. The early move kept filling (first60 ETH 3/3 +$7.61 since the cap) because 15m books are deeper. Lab side: the paper twin feed3-up56-mid is 65/126 +$16.8 fillable and pulled3, which pays up to 3c over the pulled ask, is 83/143 +$71.2, so chase room is worth more than the cheaper ticket. This twin measures the 40-53c signals alone; the live lever for Review 14 is the feed's order cap (56c -> 58c, or the paper cap 53c with the order cap at 56c)." },
  { name: "ahead5-cheap60-15m-first60-day", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [840, 870], minWindowSec: 900, maxWindowSec: 900, skipHoursUtc: [12, 13, 14, 15, 16, 17], added: "2026-11-04", idea: "ahead5-cheap60-15m-first60 (the live ETH rule) off from 21:00 to 03:00 KST (12-18 UTC), the US session. Round 166 (4 Nov 2026 00:10 KST): the server's 63 settled real early-move fills since 1 Nov 20:26 KST by KST block: 21-24 2/8 -$13.84 (all UP), 00-03 6/12 -$3.65, 03-12 18/28 64% +$9.06 (UP 10/13 +$11.83), 12-21 9/15 +$1.08; together 21-03 KST 8/20 -$17.49 against 03-21 KST 27/43 +$10.14. This reverses both halves of the 20-30 Oct replay verdict (early move pays in the US session 21-03 KST, loses 03-12 KST): on real money the US open is where the 15m early move gets run over, likely because the US-session moves are larger and the makers reprice them faster. 3 Nov's last hour shows it: ETH first60 0/2 -$6.21 at 22:45 and 23:00 KST while BTC's feed fired 10 times in the hour. Judge against ahead5-cheap60-15m-first60 on the fillable column; live lever for a review would need an hours option in deploy/live-rules.json." },
  { name: "feed3-up60-mid-dayhalt3", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", familyHaltLosses: 3, added: "2026-11-04", idea: "feed3-up60-mid (the live BTC 5m rule) with the family day-halt: after 3 straight losses across all coins and window lengths it sits out until KST midnight. Round 167 (4 Nov 2026 01:10 KST): the feed family's paper record is made by a few blow-up hours. Between 23:00 and 01:00 KST the fillable record of feed3-up56-mid went from 65/126 +$16.8 to 94/209 -$130.2 (about -$147 in two hours, red on 12 of 14 5m/15m markets in the first hour of 4 Nov), feed3-up53-mid to 19/61 -$106.8, feed3-up60-mid-q0 from +$20.0 to -$26.4 and pulled3 from +$71.2 to +$40.4; the real BTC feed lost only 2/6 -$6.44 in the same span because the 56c cap killed six of its orders. The one rule that has held up across days on the server is the early move's day-halt twin: ahead5-cheap60-15m-dayhalt3 98/165 +$20.5 fillable against its base ahead5-cheap60-15m-first3 392/730 -$335.5 (dayhalt5 105/185 -$18.0), i.e. stopping for the day after three straight family losses removes exactly these market-wide bad stretches (round 140: bad days are market-wide). This applies the same brake to the feed. Judge against feed3-up60-mid on the fillable column; the live lever would be a family-wide halt in live.ts." },
  { name: "feed3-up60-mid-pulled3-dayhalt3", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", confirmSec: 5, confirmCap: 0.63, confirmDipC: 0.03, pulledChaseC: 3, familyHaltLosses: 3, added: "2026-11-04", idea: "feed3-up60-mid-pulled3 (the lab's best feed rule, 100/182 +$40.4 fillable, down from +$71.2 two hours earlier) with the 3-loss family day-halt. Round 167: see feed3-up60-mid-dayhalt3." },
  { name: "ahead5-cheap60-15m-first60-dayhalt3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [840, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, added: "2026-11-04", idea: "ahead5-cheap60-15m-first60 (the live ETH rule) with the 3-loss family day-halt (sit out until KST midnight after three straight losses across all coins). Round 168 (4 Nov 2026 02:10 KST): the halt works by shrinking the bad day, not by picking winners. ahead5-cheap60-15m-dayhalt3 against its base ahead5-cheap60-15m-first3, all trades by KST day: 3 Nov 119/205 +$2 vs 180/333 -$118; 4 Nov so far 14/19 +$29 vs 22/32 +$38. So it keeps three quarters of a green day and turns the red day flat; fillable 103/170 +$40.9 against the base's deep red (392/730 -$335 at 01:00). The same brake on the feed (round 167) started 1/7 -$25.1, and pulled3, the 1-day lab leader, fell from +$71.2 to +$8.2 in three hours, so day-level robustness, not hourly peaks, is what to judge by. The live first60 rule is 73/138 -$63 (3 Nov) and 13/21 +$15 (4 Nov) on paper; this twin shows what the halt would have done to it." },
  { name: "feed3-up60-mid-pulled3-one", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", confirmSec: 5, confirmCap: 0.63, confirmDipC: 0.03, pulledChaseC: 3, familyMaxPerWindow: 1, familyHaltLosses: 3, added: "2026-11-04", idea: "feed3-up60-mid-pulled3-dayhalt3 that buys only ONE coin per window across the family (the first to signal), so a 3-loss day-halt counts three separate windows. Round 170 (4 Nov 2026 04:10 KST): the family day-halt fails on the feed because the feed fires on many coins in the same 5-minute window and they all settle together, so the halt only trips after the whole bad window is already bought. 4 Nov (KST) all paper trades: feed3-up60-mid-dayhalt3 4/30 -$107.1 against its base feed3-up60-mid 75/178 -$181.5, pulled3-dayhalt3 7/23 -$46.1 against pulled3 39/83 -$47.0 (no saving at all), while the early move's halt, whose 15m signals spread across the window, kept 33/44 +$60.4 against first3 41/57 +$69.3. pulled3 fillable went +$29.1 to -$0.3 in the hour to 04:00 KST, red on the 5m alts together. One window is one market-wide bet, so one ticket per window is the honest size. Twin feed3-up60-mid-one without the pull confirm. New familyMaxPerWindow option." },
  { name: "ahead5-cheap60-15m-break-dayhalt3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, prevRun: [2, 3], prevRunRel: "against", familyHaltLosses: 3, added: "2026-11-04", idea: "the two early-move protections stacked: break (the move breaks a 2-3 window run) plus the 3-loss family day-halt. Round 174 (4 Nov 2026 08:10 KST): they protect different days. All trades by KST day, base first3 / break / dayhalt3: 1 Nov -$86 / +$14.6 / n.a., 2 Nov -$258 / +$9.9 / n.a., 3 Nov -$118 / -$22.9 / +$2.2, 4 Nov +$61 / +$4.4 / +$52.5. break was the only early-move gate green on the worst day (2 Nov) but red on 3 Nov, while the halt flattened 3 Nov. Fillable now: break 55/91 +$11.4, dayhalt3 132/216 +$45.5. break takes about one base trade in six to eight, so the halt rarely trips inside it; the question is whether the stack keeps break's selectivity and loses its red day. Judge against both on fillable net and red days." },
  { name: "mk-early-dayhalt3-r3-30", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, rest: 0.03, restSec: 30, restThrough: true, added: "2026-11-04", idea: "MAKER version of the live rule ahead5-cheap60-15m-dayhalt3: at the signal rest a bid 3c under the ask for 30 s; filled only if the ask trades through it (restThrough). Maker study (4 Nov 2026, thread 'Make money as a maker', report reviews/maker-study-2026-11-04.md). On the Mac's 1-s books (30 Oct-2 Nov, 7 coins, 521 first3 signals) with an honest queue rule (filled only if the ask trades strictly BELOW the bid, fill at the bid, no fee): taker 293/521 56% -5.1% of stake (-$132 at $5); resting 3c under the signal ask for 30 s filled 252/521 (48%), won 58%, +7.3% of stake (+$92); 2c/30 s 284 fills 57% +3.1%; resting longer is worse (3c until window end: 88% filled, 51% won, -4.7%), because late fills are the move reversing. By KST day the maker beat the taker every day (31 Oct +$80 vs +$39, 1 Nov -$15 vs -$84, 2 Nov -$9 vs -$126) but was still red on the two red days, so it shrinks a bad day rather than fixing it. Every other maker approach tested lost: two-sided quoting around the book mid or a Binance fair value -5% to -12% of stake over 18-28k fills, early-window bids on both sides -7%, near-close favourite bids mostly -1% to -32%. Polymarket's crypto maker rebate is 20% of the taker-fee pool (about 0.014 x p x (1-p) per share, 0.35c at 50c), paid daily and not booked here. Judge against dayhalt3 and its touch-fill twins maker1/maker2 on fillable net over 100+ fills." },
  { name: "mk-early-first3-r3-30", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.03, restSec: 30, restThrough: true, added: "2026-11-04", idea: "MAKER version of ahead5-cheap60-15m-first3 (no day-halt, all coins, the bigger sample): rest a bid 3c under the signal ask for 30 s, filled only on a trade-through. Maker study (4 Nov 2026, thread 'Make money as a maker', report reviews/maker-study-2026-11-04.md). On the Mac's 1-s books (30 Oct-2 Nov, 7 coins, 521 first3 signals) with an honest queue rule (filled only if the ask trades strictly BELOW the bid, fill at the bid, no fee): taker 293/521 56% -5.1% of stake (-$132 at $5); resting 3c under the signal ask for 30 s filled 252/521 (48%), won 58%, +7.3% of stake (+$92); 2c/30 s 284 fills 57% +3.1%; resting longer is worse (3c until window end: 88% filled, 51% won, -4.7%), because late fills are the move reversing. By KST day the maker beat the taker every day (31 Oct +$80 vs +$39, 1 Nov -$15 vs -$84, 2 Nov -$9 vs -$126) but was still red on the two red days, so it shrinks a bad day rather than fixing it. Every other maker approach tested lost: two-sided quoting around the book mid or a Binance fair value -5% to -12% of stake over 18-28k fills, early-window bids on both sides -7%, near-close favourite bids mostly -1% to -32%. Polymarket's crypto maker rebate is 20% of the taker-fee pool (about 0.014 x p x (1-p) per share, 0.35c at 50c), paid daily and not booked here." },
  { name: "mk-early-first3-r3-30-eth", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.03, restSec: 30, restThrough: true, skipCoins: ["btc", "sol", "xrp", "doge", "bnb", "hype"], added: "2026-11-04", idea: "mk-early-first3-r3-30 on ETH 15m only. Round 183 (4 Nov 2026 17:10 KST): the maker early move's coin ranking flips between samples. The maker thread's 5-day server-book study (31 Oct-4 Nov, bid 3c under for 30 s) had BNB +9%, ETH +8%, SOL/XRP -15%; today's server lab for mk-early-first3-r3-30 has BNB 1/4 -$11.2, DOGE 4/8 -$4.8, SOL 6/9 +$11.3, XRP 8/13 +$9.0, HYPE 10/15 +$26.6, BTC 7/11 +$6.9, ETH 11/13 +$33.8. So picking coins from one sample is mostly noise; ETH is the only coin green in both (and the real taker early move was also best on ETH: first60 12/20 +$3.83). This isolates ETH so its record builds its own fillable count toward the 100-trade bar instead of hiding in the 7-coin total. Judge only after several days." },
  { name: "ahead5-cheap60-15m-dayhalt3-eth", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, skipCoins: ["btc", "sol", "xrp", "doge", "bnb", "hype"], added: "2026-11-04", idea: "TAKER twin of round 183's mk-early-first3-r3-30-eth: the early move on ETH 15m bought at the ask with the 3-loss day-halt, so ETH gets a clean same-signal taker vs maker comparison. Round 184 (4 Nov 2026 18:10 KST), a consistency scan of the whole server lab by KST day (completed days 31 Oct-3 Nov): 127 variants have 5 full days and their green-day counts are 0 of 5: 45, 1: 44, 2: 24, 3: 11, 4: 2, 5: 1, far worse than a coin flip (which would give about 4 at 5/5 and 21 at 4/5). The one 5/5 variant is arb97 (+$394 paper) with ZERO fillable trades; the near-consistent ones (green all but one day) are cheap tickets at 20-25% won (up20-first60-eve 51/211, up20-first60-night 87/437) or red on the fillable column (fav-lead-last30 1029/1096 -$34.0, feed3-down20-mid -$82.5). So no variant in the lab is green on most days with 50%+ won and fillable profit; ETH early move is the one cell positive in both the 5-day study and today, and this pair decides whether the maker or taker form carries it." },
  { name: "mk-early-first3-r2-30-nobinlead", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, aheadXchgLead: [-1, 99], rest: 0.02, restSec: 30, restThrough: true, added: "2026-11-04", idea: "mk-early-first3-r2-30 (maker bid 2c under the early-move ask, 30 s, through-fill only) EXCLUDING the signals where Binance leads Coinbase. Round 185 (4 Nov 2026 19:10 KST): the strongest TAKER gate is the worst MAKER gate. On the server today the binlead taker is green (ahead5-cheap60-15m-binlead 120/202 +$26.1 on 4 Nov), but its maker form ahead5-cheap60-15m-binlead-maker2 is the only red early-move maker: 21/46 46% -$41.1, while the ungated maker mk-early-first3-r2-30 is 60/97 +$65.9, so the non-binlead part of it is about 39/51 +$107. Reading: when Binance already leads, the move is real and the price runs away from a resting bid, so the bid fills only when the move fails (adverse selection); on the weaker signals the price wobbles back to the bid and still wins. One day, so judge against mk-early-first3-r2-30 and binlead-maker2 over several days." },
  { name: "ahead5-cheap56-15m-pulled2-dayhalt3", left: 0, cap: 0.56, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, confirmSec: 5, confirmCap: 0.58, confirmDipC: 0.03, pulledChaseC: 2, familyHaltLosses: 3, added: "2026-11-04", idea: "the 15m early move bought only when its ask is PULLED or lifted within 5 s of the signal (paying at most 2c over the trigger ask and never over 58c), with the 3-loss family day-halt. Round 186 (4 Nov 2026 20:10 KST): across the whole early-move taker family on the server, the tickets the fill audit marks as missed win clearly more than the ones that fill: ahead5-cheap60-15m-first3 fills 515/942 55% -$351.5 vs missed 188/331 57%; ahead5-cheap70-15m-first3 60% vs 67%; ahead5-mid65-late 57% vs 66%; -tp85 62% vs 66%; -spot 55% vs 60%; -ovr2 53% vs 61%. Every big variant shows it: an ask that disappears before we can hit it is the market agreeing with the signal, an ask that stays is someone happy to sell to us. The feed version of this test (feed3-up60-mid-pulled3) failed, 249/493 -$109.8, but it has never been run on the early move. Signal ask capped at 56c (round 157: fills at 56-60c leak) so the chase tops out at 58c. Judge against ahead5-cheap60-15m-dayhalt3 on fillable won % and net." },
  { name: "mk-early-first3-r2-30-skipnight", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.02, restSec: 30, restThrough: true, skipHoursUtc: [12, 13, 14, 15, 16, 17], added: "2026-11-04", idea: "mk-early-first3-r2-30 with the 21-03 KST hours skipped. Round 187 (4 Nov 2026 21:10 KST), an out-of-sample check of round 182's leaders over the four hours since (16:10 -> 21:00 KST, fillable): mk-early-dayhalt3-r3-30 37/54 +$70.8 -> 57/92 +$68.1 (the evening 20/38 -$2.7), mk-early-first3-r2-30 47/72 +$69.7 -> 72/116 +$77.9 (25/44 +$8.2), ahead5-cheap60-5m-maker2 29/36 +$80.1 -> 46/71 +$59.1 (17/35 49% -$21.0), the new 5m-maker3 14/30 -$21.2, against the taker dayhalt3 +$4.5 (22/37). The early-move maker went from about 70% won to about 53% within hours, i.e. toward the 5-day server-book result (-7.1%), so the day-time green was not a stable edge. The real early move lost 21-03 KST and won 03-21 KST (MEMORY), so this tests whether the maker's good stretch is a time-of-day effect rather than luck. Judge on several days." },
  { name: "ahead5-cheap60-15m-halt3-3h", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, familyHaltMin: 180, added: "2026-11-04", idea: "ahead5-cheap60-15m-dayhalt3 with the 3-loss family stop lasting 3 HOURS instead of until KST midnight. Round 189 (4 Nov 2026 23:10 KST): the stop strength has a sweet spot, it is not 'tighter is better'. Paper by KST day: base first3 3 Nov -$118.3, 4 Nov +$40.2; dayhalt5 -$40.9 / +$30.8 (fillable 237/416 -$56.0); dayhalt3 +$2.2 / +$76.3 (fillable 208/349 +$27.3, the only green one); dayhalt2 (4 Nov only) +$1.8 (fillable 69/123 -$33.6); dayhalt3-one (one coin per window) -$50.5 (fillable -$56.0). So 2 losses stops too early on a good day and 5 too late on a bad one. A 3-hour pause tests whether the gain comes from skipping the rest of a bad day or just a bad stretch (the round 175 feed version, feed3-up60-mid-halt2h, tested this on the feed). Judge against dayhalt3 on fillable net per day." },
  { name: "mk-early-dayhalt3-r2-30", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.02, restSec: 30, restThrough: true, familyHaltLosses: 3, added: "2026-11-05", idea: "the early-move maker bid 2c under the ask (30 s, through-fill) with round 189's 3-loss family day-halt, the one stop length that is fillable-green on the taker side (dayhalt3 +$27.3 vs dayhalt2 -$33.6, dayhalt5 -$56.0). Round 190 (5 Nov 2026 00:10 KST), day-to-day persistence across the whole server lab (31 Oct-4 Nov, 812 variant-day pairs with |net| > $1): a variant green one day was green the next 36% of the time (44/121), a red one 18% (122/691). Each day's top-10 variants made -$65, -$1,171, +$638 and -$88 the next day (-$686 in all). So yesterday's winners are twice as likely as losers to win again but still lose on balance: confirms 'one-day leaders are not promotable' with lab-wide numbers. This rule is not a leader pick: it combines the two parts that each held for more than one sample (the stop length and the 2c bid, mk-early-first3-r2-30 the only early maker still green after round 187's evening). Judge over several days." },
  { name: "ahead15-cheap60-4h-first10", left: 0, cap: 0.6, minAsk: 0.4, size: 5, aheadBp: 15, flatLeft: [13800, 14370], minWindowSec: 14400, maxWindowSec: 14400, added: "2026-11-05", idea: "the early move scaled to the 4-HOUR markets: in the first 10 minutes, the underlying 15+ bps from the open, buy that side at 40-60c. Round 192 (5 Nov 2026 02:10 KST) corrects round 191: the 4h lab's break-even (+$58 on 2,069 fillable trades) is ALL cheap tickets. Its top cells are binburst4-up20-x6 8/26 +$479.8, binburst4-up20-awake 8/18 +$168.8, binburst4-up20 8/26 +$127.8, cross3x2-up20-awake 8/21 +$111.1, i.e. 20c UP tickets winning about a third of the time, the kind of result enrique rejected and that one more loss streak wipes out; the bottom is basis15-both60 23/66 -$97.3, model-rest3-4h -$102.5, flat25-cheap50-4h -$114.1. So there is no 50%+ rule on 4h yet. The 15m early move (53% won, the lab's most-studied signal) has never been tried on 4h windows, where a 15 bps start is a smaller share of the window's range and the market has hours to price it. Few windows (6 per coin per day): judge on 100 fillable trades." },
  { name: "ahead5-cheap60-15m-dayhalt3-down", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, onlySide: "DOWN", added: "2026-11-05", idea: "ahead5-cheap60-15m-dayhalt3 buying only the DOWN side. Round 194 (5 Nov 2026 04:10 KST): the server's 151 settled real fills (31 Oct-4 Nov) split by side: early move DOWN 12/19 63% +$6.65 vs UP 14/34 41% -$29.83; all rules DOWN 30/42 -$9.56 vs UP 52/109 -$75.16 (UP includes the UP-only feed 20/46 -$19.34 and round3 2/11 -$23.86). The lab has never split the early move by side. A falling coin's early move may be the more real one (sellers in a hurry), while UP starts get faded; round 169 found the opposite for late favourites (UP better), so this is about the early window only. Small real sample; twin -up. Judge both on fillable over several days." },
  { name: "ahead5-cheap60-15m-dayhalt3-up", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, onlySide: "UP", added: "2026-11-05", idea: "UP-only twin of ahead5-cheap60-15m-dayhalt3-down (round 194)." },
  { name: "mk-early-dayhalt3-r2-30-cap65", left: 0, cap: 0.65, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.02, restSec: 30, restThrough: true, familyHaltLosses: 3, added: "2026-11-05", idea: "mk-early-dayhalt3-r2-30 taking signals up to a 65c ask (bid at most 63c). Round 195 (5 Nov 2026 05:10 KST): on the server the early-move maker fills win exactly as often as the taker trades on the same signal, so the maker's whole gain is price, not selection. Fillable: taker dayhalt3 259/436 59% +$0.10 a $5 trade; maker1 (1c under) 115/197 58% +$0.28; maker2 (2c under) 113/190 59% +$0.46; mk-early-dayhalt3-r3-30 105/182 58% +$0.44. Expected gain over the taker at a 55c ask: no fee (7% x 45% of $5 = $0.16) plus 1c x 9 shares = $0.09 per cent, i.e. $0.25 for 1c and $0.34 for 2c; measured $0.18 and $0.36. So (unlike October's replay and the binlead gate, round 185) these fills show no adverse selection yet. If price is the whole edge, the 56c taker cap (round 157: 56-60c fills leaked) need not bind a maker: a 62c signal bid at 60c pays no fee and still sits at the old taker level. Judge against mk-early-dayhalt3-r2-30 on fillable per-trade net." },
  { name: "mk-early-dayhalt3-r2-30-skipnight", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.02, restSec: 30, restThrough: true, familyHaltLosses: 3, skipHoursUtc: [12, 13, 14, 15, 16, 17], added: "2026-11-05", idea: "mk-early-dayhalt3-r2-30 with 21-03 KST skipped. Round 196 (5 Nov 2026 06:10 KST), the early-move maker over its first night (21:00 -> 06:00 KST, fillable): mk-early-first3-r2-30 72/116 +$77.9 -> 145/250 +$84.7, so the night added 73/134 54% +$6.8 ($0.05 a trade) after a daytime +$0.67 a trade; mk-early-dayhalt3-r3-30 night 52/96 +$19.7; the taker dayhalt3 night 64/112 +$2.0. The maker's day edge mostly vanished at night, the same clock pattern the real early move showed (lost 21-03 KST, won 03-21). Stacks round 187's skipnight with the 3-loss halt and the 2c bid. Judge against mk-early-dayhalt3-r2-30 over several days." },
  { name: "mk-early-dayhalt3-r2-30-big3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.02, restSec: 30, restThrough: true, familyHaltLosses: 3, skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-05", idea: "mk-early-dayhalt3-r2-30 on ETH, SOL and BTC 15m only. Round 197 (5 Nov 2026 07:10 KST): the early move's green markets are exactly the three cheapest coins of round 193's all-rules cost table (15m fillable $/trade: ETH -0.27, SOL -0.28, BTC -0.38 vs BNB -0.39, HYPE -0.57, DOGE -0.62, XRP -0.78), for taker and maker alike. Taker dayhalt3 fillable: ETH 47/67 +$60.2, BTC 35/52 +$42.3, SOL 48/76 +$34.7 (+$137) vs BNB +$7.5, HYPE -$8.9, XRP -$28.6, DOGE -$58.1 (-$88). Maker mk-early-first3-r2-30: ETH 29/40 +$61.7, SOL +$43.3, BTC +$21.8 (+$127) vs BNB -$14.6, HYPE -$13.1, XRP -$7.2, DOGE -$3.4 (-$38). The filter comes from the structural table, not from these numbers, so it is not a one-day pick (rounds 183/188 warned against those: the 1h feed-maker pick from round 188, 25/36 +$78, has since gone 11/32 -$56.8 on its own variant). Judge against mk-early-dayhalt3-r2-30 over several days." },
  { name: "ahead5-cheap60-15m-dayhalt3-prevgreen", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, prevDayGreenOf: "ahead5-cheap60-15m-first3", added: "2026-11-05", idea: "ahead5-cheap60-15m-dayhalt3 only on KST days after a day on which the whole early-move family (ahead5-cheap60-15m-first3, all coins) closed green. Round 198 (5 Nov 2026 08:10 KST): the early move's sign comes in multi-day runs, not single days. first3 paper by KST day: 31 Oct -$40, 1 Nov -$86, 2 Nov -$258, 3 Nov -$118, then 4 Nov +$30 and 5 Nov +$107 so far (dayhalt3 4 Nov +$73.5, 5 Nov +$79.2; the makers flipped green on the same day). 4 of the 5 day-to-day steps kept the sign, unlike the lab as a whole (round 190: 36% green after green). An intraday regime gate failed (ahead5-cheap60-15m-hot, last 10 early moves >= 60% won: fillable 168/320 -$149.1, 2 Nov -$110.8, 3 Nov -$155.2), so this tests the slower, day-level version: on these numbers it would have sat out 1-4 Nov (saving the base about $462, giving up 4 Nov's +$30) and traded 5 Nov. New prevDayGreenOf option (in-memory day totals rebuilt from the totals files at start). Judge against dayhalt3 over a week." },
  { name: "ahead5-cheap60-15m-dayhalt3-big3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-05", idea: "the TAKER early move with the 3-loss day-halt on ETH, SOL and BTC 15m only (taker twin of round 197's mk-early-dayhalt3-r2-30-big3). Round 199 (5 Nov 2026 09:10 KST), checked on the SERVER's own 1-row-a-second books (server/hist, 31 Oct-5 Nov 09:00 KST), not the lab: first 5+ bps Chainlink move in seconds 30-180 of a 15m window, buy that side at the signal ask if 35-60c, hold to close, taker fee 7% x (1 - p). By KST day, ETH+SOL+BTC: 31 Oct 5/11 -24.6%, 1 Nov 5/7 +22.3%, 2 Nov 22/48 -23.3%, 3 Nov 36/59 +8.2%, 4 Nov 46/72 +11.8%, 5 Nov (to 09:00) 33/47 +22.8%; the other four coins: -20.7%, -49.8%, -33.0%, -7.1%, -9.0%, +3.1%. Per coin 3-5 Nov: ETH +7.8/+18.3/+36.5%, SOL +6.9/+9.1/+28.6%, BTC +10.8/+8.5/+1.1% (all nine green), XRP and DOGE red on 3 and 4 Nov. So on server books the early move turned from deep red to green on 3 Nov and stayed green three days on the three cheapest coins (round 193), matching rounds 197-198. Signal-ask fills ignore the ~23% real miss rate. Judge against dayhalt3 and the maker big3 twin." },
  { name: "ahead5-cheap60-15m-dayhalt3-big3-down", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, onlySide: "DOWN", skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-06", idea: "TAKER twin of the DOWN-only ETH/SOL/BTC bid: take the ask (fee paid) on early DOWN moves only, day-halt 3. Round 218 (6 Nov 2026 04:10 KST), research/server-book-side-days.py on the server's 1-s 15m books 31 Oct-5 Nov 09:00 KST, by side and KST day, taker vs 4c/30 s bid: ETH/SOL/BTC DOWN taker 104 trades about +20.7% (-47.3, +13.1, -14.6, +21.9, +36.2, +38.9% by day; green 4/6, last 3 days all green), bid 62 fills +42.9%; ETH/SOL/BTC UP taker -28.5% on 2 Nov, -7.0, -2.1, +7.3 since; other coins UP red EVERY day as taker (-9.6% to -62.2%) and as bid (-4.2% to -67.9%) = the single worst segment in the lab. The live trader can already take the ask, so a DOWN-only taker needs no new order type; the bid still roughly doubles the edge per fill." },
  { name: "ahead5-cheap60-15m-dayhalt3w", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, familyStreakPerWindow: true, added: "2026-11-07", idea: "ahead5-cheap60-15m-dayhalt3 where the 3-loss day stop counts WINDOWS, not coins (first settled trade of each window counts, the rest of that window is ignored). Round 240 (7 Nov 2026 02:10 KST): now that the paper stop survives deploys, dayhalt3 tripped by 00:45 KST on 7 Nov after just 3 windows (00:00-00:30, all signals DOWN) at 15/24 won +$23.6, and sits out the other 23 hours; dayhalt3-down and halt3-3h tripped on the identical sequence. With 7 coins settling the same window one after another, 3 straight losses is one bad 15-minute move, so the stop fires on nearly any red window. The UP-only twin kept trading (2/2 +$5.1 btc after 00:45). Counting per window should keep the market-wide bad-day protection without a single red window ending the day." },
  { name: "ahead5-cheap60-15m-dayhalt3-ethbtc-down-one", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, familyMaxPerWindow: 1, onlySide: "DOWN", skipCoins: ["sol", "xrp", "doge", "bnb", "hype"], added: "2026-11-07", idea: "The real-test shape on ETH and BTC only (no SOL). A probe, not a pick: coin choices from one sample have faded every time. Round 239 (7 Nov 2026 01:10 KST), fresh paper since 6 Nov (ahead5-cheap60-15m-dayhalt3-down, all fills): SOL DOWN 18/36 -$25.0 is the worst coin; ETH 19/33 +$6.8, BTC 17/28 +$4.3; BIG3 together 54/97 -$13.9 vs the other four DOWN 91/150 +$33.9 (HYPE +$23.0, BNB +$19.5). The test twin is 6/12 -$5.7 (SOL 3/5, ETH 3/6, BTC 0/1). On the books SOL was the weakest BIG3 coin too (R224 -13.5% fresh bid, R226 paper 6/16 -$29.6). Paper and the BIG3 book replay disagree, so this only tracks whether SOL is the drag." },
  { name: "ahead5-cheap60-15m-dayhalt2-big3-down-one", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 2, familyMaxPerWindow: 1, onlySide: "DOWN", skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-06", idea: "The real-test shape with a 2-loss day stop instead of 3. Round 234 (6 Nov 2026 20:10 KST): the paper day stop was memory-only and every hourly deploy wiped it (now saved to data/paper-family-halts.json). The test twin lost 16:30 BTC, 17:01 SOL, 17:31 ETH, tripped at ~17:46 KST, the 18:09 deploy cleared it and it took 18:45 SOL (won): twin now 5/10 -$7.0. So every dayhalt paper number so far includes trades after a tripped stop, and the 2-vs-3 comparison (R209, all coins: 2 worse) was never run cleanly on BIG3 DOWN. The real trader keeps its stop in data/live-family-halts.json, so live is not affected." },
  { name: "ahead5-cheap60-15m-dayhalt3-big3-down-one-noafternoon", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, familyMaxPerWindow: 1, onlySide: "DOWN", skipCoins: ["xrp", "doge", "bnb", "hype"], skipHoursUtc: [3, 4, 5, 6, 7, 8], added: "2026-11-06", idea: "The real-test shape skipping 12:00-18:00 KST. Round 232 (6 Nov 2026 18:10 KST). Dry pre-flight check: the paper twin took 4 trades after the rule went on the server at 14:18 KST and the server signed exactly 4 dry orders on the same windows (15:00 ETH 59c won, 16:30 BTC 57c lost, 17:01 SOL 60c lost, 17:31 ETH 58c lost): firing matches paper 1 for 1. But the afternoon lost 3 of 4; on the server books (R228, research/server-book-side-kst.py) ETH/SOL/BTC DOWN taker by KST block was 00-06 75 trades +31.6%, 06-12 27 trades +18.6%, 12-18 31 trades 58% +1.1% (green 3/5), 18-24 25 trades +26.7%: the afternoon block is the only flat one, and today's fresh afternoon agrees. Paper DOWN taker all coins went from +$34.0 at 13:10 to $0.0 now." },
  { name: "ahead5-cheap60-15m-dayhalt3-big3-down-one-cap4", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, familyMaxPerWindow: 1, maxPerDay: 4, onlySide: "DOWN", skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-06", idea: "The real-test shape with at most 4 trades a day per coin (about 12 a day in all), to see how much profit a hard daily count costs. Round 231 (6 Nov 2026 17:10 KST), research/server-book-down-test-shape.py, risk of the $3 test against the $50 cap: one per window + dayhalt3 replay 83 trades +$46.4, days -4.3 / +1.2 / -9.3 / +6.1 / +16.4 / +15.6 / +20.6, max drawdown on the trade path -$12.4; bootstrap of whole days: 5 days P(loss) 9.5%, 5th percentile -$6.1, median +$34; 10 days P(loss) 2.5%, P(<= -$50) about 0.01%. Only 7 days, two of them with few BTC books, so the tails are understated; the hard guards are the $320 floor, $9/day/coin and the 3-loss halt. Second dry order 16:30 KST BTC DOWN 57c lost (first: 15:00 ETH DOWN 59c won)." },
  { name: "ahead5-cheap60-15m-big3-down-one", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyMaxPerWindow: 1, onlySide: "DOWN", skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-06", idea: "The real-test shape WITHOUT the 3-loss day-halt, to measure on fresh days what the halt costs or saves. Round 230 (6 Nov 2026 16:10 KST). Server pre-flight: the DRY test rule signed its first order at 15:00:45 KST (ETH DOWN, signal 59c, fresh ask 59c, limit 60c; the window won). Replay research/server-book-down-skipfall.py on the 1-s books 31 Oct - 6 Nov 09:00 KST, ETH/SOL/BTC DOWN signals 35-60c: when the DOWN ask was 1c+ lower one second after the signal, 36 trades won 29 (81%), +$50.9 at $3; when it held, 122 trades won 80 (66%), +$56.4. The live trader skipped every 'ask fell' order by default (a rule written for favourites), which would have dropped the best quarter of this rule's tickets; the test now sends them (new live option skipOnFall: false). Replay of the halt (R test-shape): one per window with dayhalt3 83 trades +$46.4 at $3; this twin shows the no-halt side on fresh windows." },
  { name: "ahead5-cheap60-15m-dayhalt3-rest4-down-one", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, familyMaxPerWindow: 1, onlySide: "DOWN", skipCoins: ["btc", "eth", "sol"], added: "2026-11-06", idea: "Mirror of the real-test shape (ahead5-cheap60-15m-dayhalt3-big3-down-one, DRY on the server since 14:15 KST) on XRP/DOGE/BNB/HYPE, so the lab keeps measuring whether DOWN alone carries the edge or ETH/SOL/BTC matter too. Round 229 (6 Nov 2026 15:10 KST). Order check for the test from the server's 199 real orders in status.json: limit above the signal ask 138 orders 123 filled (89%), limit equal to the ask 33 orders 28 filled (85%), limit below the ask 28 orders 0 filled (all 'no orders found to match with FAK'; the old 56c live cap under 59-60c signals on 4-5 Nov). The test's 60c limit equals the paper cap, so a 60c signal still fills about 85% of the time and nothing is silently refused. Taker DOWN on these four coins on the server books: 7 days 35-60c ~+1%, fresh 6 Nov 00-09 KST +18.6% (42 trades)." },
  { name: "fade-up5-15m-rest-night-one", left: 0, cap: 0.7, minAsk: 0.3, size: 5, aheadBp: 5, aheadFade: true, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, onlySide: "DOWN", skipCoins: ["btc", "eth", "sol"], hoursUtc: [9, 21], familyHaltLosses: 3, familyMaxPerWindow: 1, added: "2026-11-06", idea: "Night fade of the early UP move on XRP/DOGE/BNB/HYPE, but ONE trade per window across the four coins. Round 233 (6 Nov 2026 19:10 KST): the parent fade-up5-15m-rest-night went 1/8 -$27.8 on its first evening, and all 8 trades came from just 2 windows (18:00 KST on all four coins, then one more window on all four): XRP 0/2 -$10.4, DOGE 0/2 -$10.4, HYPE 0/2 -$10.4, BNB 1/2 +$3.5. The four small coins move together, so 4 fills in one window are one bet at 4x size, and the 3-loss day stop cannot act inside a window. Same lesson as R208 on BIG3 bids. The book edge it cites (R228: fade 18-24 KST 66% +37.5%, 5/6 nights) counted every coin separately, so it is overstated by the same clustering." },
  { name: "fade-up5-15m-rest-night", left: 0, cap: 0.7, minAsk: 0.3, size: 5, aheadBp: 5, aheadFade: true, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, onlySide: "DOWN", skipCoins: ["btc", "eth", "sol"], hoursUtc: [9, 21], familyHaltLosses: 3, added: "2026-11-06", idea: "FADE the early UP move on XRP/DOGE/BNB/HYPE at night: when the first 5+ bps move in the first 2.5 min is UP, buy DOWN (30-70c, taker), 18:00-06:00 KST only. Round 228 (6 Nov 2026 14:10 KST), research/server-book-side-kst.py and research/server-book-up-fade.py on the server's 1-s 15m books 31 Oct - 6 Nov 09:00 KST: following the UP signal on the other four coins loses in every KST block and worst at night (18-24 KST 59 trades 34% won -42.2%, green 0/6; 00-06 57 trades 39% -32.3%). Fading it (buy DOWN at its ask + fee): 18-24 KST 59 trades 66% won +37.5% (green 5/6), 00-06 57 trades 61% +28.6% (4/6); daytime fades lose (06-12 -7.6%, 12-18 -4.4%) and fading ETH/SOL/BTC is weak (+5% at night, -17% midday). Thin night books on small coins let an UP print overshoot. Also: ETH/SOL/BTC DOWN taker by block 00-06 75 trades +31.6%, 06-12 +18.6%, 12-18 +1.1%, 18-24 +26.7% (no dead block). New option aheadFade. One sample of 6 nights, so paper first." },
  { name: "ahead5to8-cheap60-15m-dayhalt3-big3-down", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, aheadMaxBp: 8, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, onlySide: "DOWN", skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-06", idea: "ETH/SOL/BTC DOWN taker only on moderate moves (5-8 bps). Round 227 (6 Nov 2026 13:10 KST), research/server-book-down-taker-ask.py on the server's 1-s 15m books 31 Oct - 6 Nov 09:00 KST, first 5+ bps move in the first 2.5 min, taker (ask + fee): ETH/SOL/BTC DOWN by ask: 35-50c 29 trades 62% +28.8%, 51-55c 42 76% +38.3%, 56-60c 87 68% +13.0% (green 5/7), 61-65c 158 59% -8.9%, 66-70c 138 -4.4%: the 60c cap is right, the 56c cap would drop a still-green band. By move size (35-70c): 5-8 bps 399 trades 66% +4.7% vs 8+ bps 55 trades 58% -5.7%; UP red in every band (-0.6% to -43%), other coins' DOWN ~+1% at 35-60c. Big jumps are already priced. New option aheadMaxBp (paper re-checks later rows, so a window whose move falls back under 8 bps can still trade)." },
  { name: "ahead5-cheap56-15m-dayhalt3-big3-down", left: 0, cap: 0.56, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, onlySide: "DOWN", skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-06", idea: "ahead5-cheap60-15m-dayhalt3-big3-down with the old 56c taker cap (real fills at 56-60c lost, under 56c won: memory PRICE PAID). Round 226 (6 Nov 2026 12:10 KST), research/server-book-vs-paper-down.py: replay of the ETH/SOL/BTC DOWN taker signal on the server books for windows 6 Nov 04:10-09:00 KST (the paper twin's first hours) gives 13 of 17 won, +$36.1 at $5 (BTC 3/4 +$6.9, ETH 7/8 +$27.6, SOL 3/5 +$1.6). The paper twin's day to 12:10 is BTC 7/10 +$6.8, ETH 9/14 +$10.3, SOL 6/16 -$29.6, so the R225 'paper vs replay disagree' was mostly different hours (09-12 KST, not yet in the books), not a fill-model gap; SOL carries the loss. In the replay 11 of 17 DOWN entries asked 55-60c and those went 9/11 (+$20.9), so the 56c cap may cost winners on this side; this twin tests it." },
  { name: "ahead5-cheap60-15m-dayhalt3-big3-down-one", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, familyMaxPerWindow: 1, onlySide: "DOWN", skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-06", idea: "TAKER DOWN on ETH/SOL/BTC, one trade per window, 3-loss day-halt: the simplest shape the live trader can already run (no maker mode). Round 225 (6 Nov 2026 11:10 KST), research/server-book-side-days.py with the fresh 2026-11-05 UTC books, taker (ask + fee) vs 4c/30 s bid by KST day: ETH/SOL/BTC DOWN taker 2 Nov 18 trades -14.6%, 3 Nov 31 +21.9%, 4 Nov 26 +36.2%, 5 Nov 38 +31.6%, 6 Nov 00-09 (all fresh) 39 +28.7%; the 4c bid on 6 Nov only +7.5% (22 fills). Green 4 days running as a taker, and on the fresh morning the taker beat the bid by 21 points because strong DOWN moves run away from a resting bid. ETH/SOL/BTC UP taker red 5 of 7 days (6 Nov 19 trades -37.5%); other coins DOWN taker +13.9% / +18.6% on 5-6 Nov but red 2 Nov (-32.4%). Paper twin without the per-window cap: ahead5-cheap60-15m-dayhalt3-big3-down." },
  { name: "ahead5-cheap60-15m-dayhalt3-big3-down-one-maker1", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, familyMaxPerWindow: 1, onlySide: "DOWN", skipCoins: ["xrp", "doge", "bnb", "hype"], rest: 0.01, restSec: 60, added: "2026-11-07", idea: "Round 252 (7 Nov 2026 14:10 KST): the two live rules crossed: the BIG3 DOWN signal, one per window, but resting a bid 1c under for 60 s like the live maker. First real taker fill 13:30 KST SOL DOWN at 56c, $3 for 5.36 shares, fee $0.09, won +$2.26 (300 ms, fresh ask = signal ask). The taker fee at 55c is ~3% of stake; the maker twin of the all-coin rule fills 85-89% of signals with ~3 pts lower win rate (round 250). On the one subset with an out-of-sample edge (BIG3 DOWN), does skipping the fee beat the adverse selection?" },
  { name: "mk-early-first3-r4-30-touch-down-one-dayhalt3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.04, restSec: 30, onlySide: "DOWN", familyMaxPerWindow: 1, familyHaltLosses: 3, added: "2026-11-06", idea: "4c/30 s DOWN bid on ALL seven coins (no coin filter), one per window, 3-loss day-halt. Round 224 (6 Nov 2026 10:10 KST): which in-sample filters survived the first fresh day (server books 2026-11-05 UTC = 5 Nov 09:00 - 6 Nov 09:00 KST, 4c/30 s touch)? COIN SPLIT FAILED: BTC 11 fills +19.6%, ETH 20 +1.4%, SOL 27 44% -13.5% (BIG3 ~-2%/fill) vs XRP 15 +16.6%, HYPE 29 +18.6%, BNB 9 +7.9%, DOGE 19 -18.9% (rest ~+7%/fill). TIGHT-BOOK SPLIT FAILED: BIG3 101c overround 44 fills +6.9%, other coins 103c+ (wide) 39 fills 59% +13.6%. QUARTER: noise as expected. SIDE HELD on both groups: BIG3 DOWN 34 fills +17.1% vs UP 24 fills 38% -29.3%; other coins DOWN 41 fills +11.7% vs UP +0.6%. 7-day totals: BIG3 DOWN 96 fills +33.8%, other DOWN 149 fills +6.0%, UP red on both. DOWN is the only split that held out of sample, so this twin drops the coin filter." },
  { name: "mk-early-first3-r4-30-touch-big3-down-one-dayhalt3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.04, restSec: 30, onlySide: "DOWN", skipCoins: ["xrp", "doge", "bnb", "hype"], familyMaxPerWindow: 1, familyHaltLosses: 3, added: "2026-11-06", idea: "The test shape (ETH/SOL/BTC 4c/30 s bid, one per window, 3-loss day-halt) on DOWN signals only. Round 223 (6 Nov 2026 09:10 KST): FIRST OUT-OF-SAMPLE REPLAY, server books for 2026-11-05 UTC (5 Nov 09:00 - 6 Nov 09:00 KST) just arrived. Fresh fills only (difference vs the 31 Oct-5 Nov 09:00 replay): one-per-window dayhalt3 25 fills about +2.0 stakes (+8%/fill; 5 Nov 09-24 KST +1.5, 6 Nov 00-09 +0.5 after the halt saved ~2.5); all BIG3 4c/30 fills 58 fills about -1.1 stakes (-2%/fill; was +20.4% in-sample); taker BIG3 6 Nov 00-09 +7.0% vs bid -10.7%. Side split HELD fresh: BIG3 DOWN 34 fresh fills about +5.8 stakes (+17%/fill), UP 24 fresh fills about -7.0 (-29%/fill); all 7 days DOWN 96 fills 68% +33.8% (5/7) vs UP 89 fills 48% -8.6%. The in-sample +20% edge shrank to ~0 fresh; only the DOWN side kept a positive edge. Paper said the candidate lost $36.6 on 6 Nov while the replay says +0.5 stakes: paper maker fills are not evidence." },
  { name: "ahead5-cheap60-15m-dayhalt3-down-one", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, familyMaxPerWindow: 1, onlySide: "DOWN", added: "2026-11-06", idea: "ahead5-cheap60-15m-dayhalt3-down limited to one trade per 15m window across coins. Round 222 (6 Nov 2026 08:10 KST), paper days for KST 6 Nov to 08:00: the early-move taker split by side, all coins: DOWN 115 trades 69 won +$28.1 vs UP 80 trades 36 won -$93.5; since added (5 Nov) DOWN 100/168 fillable +$29.4 vs UP 86/161 -$78.4. Meanwhile the ETH/SOL/BTC maker candidate had its first bad fresh day: mk-early-first3-r4-30-touch-big3-one-dayhalt3 6 Nov 22/49 -$36.6 (fillable since 5 Nov 19:10 25/52 -$23.7), every BIG3 4c bid about -$38, while the plain taker dayhalt3 was +$7.4. So on fresh windows the DOWN side holds as a taker on all coins and the BIG3 bid does not. Coins in one window win or lose together (R208), so this twin keeps one DOWN bet per window." },
  { name: "mk-early-first3-r4-30-touch-big3-up", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.04, restSec: 30, onlySide: "UP", skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-06", idea: "CONTROL for the DOWN split: UP-only ETH/SOL/BTC 4c/30 s bid, mirror of mk-early-first3-r4-30-touch-big3-down. Round 221 (6 Nov 2026 07:10 KST). Server books 31 Oct-5 Nov 09:00 KST (R217): DOWN 62 fills 73% +42.9%, UP 65 fills 52% -1.0%. First fresh hours disagree: since 03:10 KST the DOWN bid twin is 6/13 -$4.6 and the DOWN taker twin (ahead5-cheap60-15m-dayhalt3-big3-down) 9/16 -$2.7 on paper. Without an UP twin on the same windows the lab cannot tell whether DOWN is still the better side or both are red tonight. Also checked research/server-book-early-maker-overround.py (upAsk + downAsk at the signal): ETH/SOL/BTC 101c 105 fills 65% +25.6% (5/6), 102c 18 fills +6.9%, 103c+ 3 fills all lost; other coins 101c -11.8%, 102c +3.1%, 103c+ -14.6%. Same information as the 1c-spread filter (R215), nothing new." },
  { name: "mk-early-first3-r4-30-touch-big3-noq2", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.04, restSec: 30, skipCoins: ["xrp", "doge", "bnb", "hype"], quarters: [0, 1, 3], added: "2026-11-06", idea: "PROBE, likely noise: the ETH/SOL/BTC 4c/30 s bid skipping windows that start at xx:30. Round 220 (6 Nov 2026 06:10 KST), research/server-book-early-maker-quarter.py on the server's 1-s 15m books 31 Oct-5 Nov 09:00 KST, touch fill, by window start: ETH/SOL/BTC xx:00 27 fills 63% +25.2% (green 4/6), xx:15 40 fills 60% +14.8% (4/5), xx:30 26 fills 58% +13.5% (2/6), xx:45 34 fills 68% +28.6% (4/5). Other coins: xx:00 52 fills 37% -29.9% (0/6), xx:15 -11.5%, xx:30 44 fills 59% +20.4% (4/6), xx:45 -3.9%. The order flips between coin groups and does not match R105 (taker, xx:00 best, whose paper twin ahead5-cheap60-15m-q0 then went 61/109 -$28.94). BIG3 is green in every quarter, so the quarter is not where the edge lives; this probe exists to show that on fresh windows." },
  { name: "mk-early-first3-r4-30-touch-eth", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.04, restSec: 30, skipCoins: ["btc", "sol", "xrp", "doge", "bnb", "hype"], added: "2026-11-06", idea: "ETH-only 4c/30 s bid. Round 219 (6 Nov 2026 05:10 KST), research/server-book-early-maker-coin.py on the server's 1-s 15m books 31 Oct-5 Nov 09:00 KST, touch fill, by coin: ETH 76 signals 40 fills 70% won +33.9% (green 4/5 KST days), SOL 60 fills 58% +13.9% (4/5), BTC 27 fills 59% +15.1% (2/4, fewer book days); BNB -15.2%, XRP -13.6%, HYPE -4.6% (96 fills), DOGE -4.3%. ETH carries the edge; matches the all-rules cost table (ETH cheapest coin at every length). But paper since 5 Nov 17:10 disagrees: r4-30-touch-big3 ETH 7/15 -$3.7, SOL 10/20 -$4.4, BTC 9/13 +$18.2. Not a coin pick from one day (R183/R188 rule): this checks the 5-day split on fresh windows only." },
  { name: "mk-early-first3-r4-30-touch-big3-down", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.04, restSec: 30, onlySide: "DOWN", skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-06", idea: "DOWN-only ETH/SOL/BTC 4c/30 s bid. Round 217 (6 Nov 2026 03:10 KST), research/server-book-early-maker-side.py on the server's 1-s 15m books 31 Oct-5 Nov 09:00 KST, touch fill, by side: ETH/SOL/BTC DOWN 104 signals 62 fills 73% won +42.9% (green 4/6), UP 140 signals 65 fills 52% -1.0% (5/6); other coins DOWN 108 fills 53% +3.9%, UP 102 fills 41% -20.1% (green 0/6). Not a falling market: BTC rose on 4 of 5 UTC days (+4.2% on 4 Nov) and windows resolved UP 39-52% of the time (BTC), yet early UP moves keep failing. Matches the real fills (UP -$75 vs DOWN -$10, memory). Likely crowd buying of UP makes the UP side dear after a move. The whole maker edge may be a DOWN edge." },
  { name: "mk-early-90to180-r4-30-touch-big3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 810], minWindowSec: 900, maxWindowSec: 900, rest: 0.04, restSec: 30, skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-06", idea: "The ETH/SOL/BTC 4c/30 s bid only when the window's first 5 bps move comes late (90-180 s in). Round 216 (6 Nov 2026 02:10 KST), research/server-book-early-maker-timing.py on the server's 1-s 15m books 31 Oct-5 Nov 09:00 KST, touch fill, by when the first move fires: ETH/SOL/BTC 30-60 s 173 signals 90 fills 59% +14.4% (green 3/6); 60-90 s 15 fills 53% +3.6%; 90-120 s 17 fills 76% +47.1%; 120-180 s 5 fills 100% +89.4%. Other coins red in every bucket except 120-180 s (+3.7%, 11 fills). Small samples after 90 s (22 fills, 82% won); a slow-building move that the book has not priced yet may be the real edge, or noise. Watch, do not promote." },
  { name: "mk-early-first3-r4-30-touch-big3-tight", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.04, restSec: 30, skipCoins: ["xrp", "doge", "bnb", "hype"], aheadMaxSpread: 0.01, added: "2026-11-06", idea: "The ETH/SOL/BTC 4c/30 s bid only when our side's book is tight (ask - bid <= 1c) at the signal. Round 215 (6 Nov 2026 01:10 KST), research/server-book-early-maker-spread.py on the server's 1-s 15m books 31 Oct-5 Nov 09:00 KST, touch fill, by spread at the signal: ETH/SOL/BTC 1c 201 signals 106 fills 65% +26.2% green 5/6; 2c 38 signals 18 fills 56% +6.9%; 3c+ 5 signals 3 fills all lost. Other 4 coins: 1c 39 fills -11.8%, 2c 75 fills +3.1%, 3c+ 96 fills -14.6% (most of their signals come from wide books). Ties to the old lesson that losses concentrate in thin books. New option aheadMaxSpread. Note: the replay drops a window whose first signal was wide; paper may re-check later rows of the same window." },
  { name: "mk-early-first3-r3-15-touch-rest4", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.03, restSec: 15, skipCoins: ["btc", "eth", "sol"], added: "2026-11-06", idea: "CONTROL, expected red: the 3c/15 s touch bid on XRP/DOGE/BNB/HYPE only, the mirror of mk-early-first3-r3-15-touch-big3, so the lab keeps testing the coin split on fresh days. Round 214 (6 Nov 2026 00:10 KST), paper days for KST 5 Nov (final): taker ahead5-cheap60-15m-dayhalt3 +$58.5 vs bid ahead5-cheap60-15m-dayhalt3-maker2 +$44.7 overall, but split by coin the bid won on ETH/SOL/BTC (+$71.0 vs taker +$53.9: BTC +4.7 vs -5.6, ETH +17.7 vs +22.0, SOL +48.6 vs +37.5) and lost on the other four (-$26.2 vs taker +$4.6: XRP -38.4 vs -27.7, HYPE -10.5 vs -0.8, BNB +10.5 vs +20.9, DOGE +12.2 both). Same split as the 6-day server-book replay (R200: BIG3 bid +10.9%, rest -13.2%). If this control turns green on fresh days, the coin filter is not real." },
  { name: "mk-early-first3-r4-10-touch-big3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.04, restSec: 10, skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-05", idea: "Pure bid 4c under for only 10 s; the unfilled rest is NOT chased. Round 213 (5 Nov 2026 23:10 KST), research/server-book-early-hybrid.py on the server's 1-s 15m books 31 Oct-5 Nov 09:00 KST, ETH/SOL/BTC: hybrid 'bid N c under for S s, then take the ask (fee paid) if still <= 60c': 4c/10 s 181 trades 60% +10.1% (about 87 bid fills worth ~+17.7 stakes plus ~94 fallback takes worth ~+0.6), 3c/10 s 184 +9.6%, 2c/10 s 187 +8.7%, 4c/20 s 171 +10.5%; pure bid 4c/30 s 127 fills +20.4% (+25.9 stakes). The taker fallback is break-even, so unfilled bids are not hidden winners on these coins (unlike R186 lab-wide); chasing adds risk, not money. Paper today (5 Nov, paper days): maker2 +$30.6 vs taker dayhalt3 +$44.2; since 21:10 maker2 -$21.6 vs taker -$5.6 (BTC -$10.1, XRP -$6.1, BNB -$5.0, ETH -$5.0)." },
  { name: "mk-early-first3-r4-30-touch-big3-one-nobinlead", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.04, restSec: 30, skipCoins: ["xrp", "doge", "bnb", "hype"], familyMaxPerWindow: 1, aheadXchgLead: [-1, 99], added: "2026-11-05", idea: "The one-per-window ETH/SOL/BTC 4c/30 s bid, skipping signals where Binance leads Coinbase (R185: binlead-maker2 21/46 -$41.1, strong moves run away from a bid). Round 212 (5 Nov 2026 22:15 KST), research/server-book-early-maker-confidence.py on the server's 1-s 15m books 31 Oct-5 Nov 09:00 KST: 92 fills, mean +21.0%/fill, sd 94%, t = 2.14; bootstrap 90% interval by fill +4.7%..+37.0% (P(mean<=0) 1.7%), resampling whole KST days (6) +5.1%..+32.6% (1.8%). Honest caveat: this shape was picked from ~50 settings tried in Rounds 200-211 (coins, offset, rest time, fill rule, trigger size, cap), so the true chance it is luck is well above 2%. Only fresh days (5-7 Nov books, Review 21) count as a real test. This twin checks whether the R185 binlead finding holds on the narrowed rule." },
  { name: "mk-early-first3-r4-30-touch-big3-one-cap4", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.04, restSec: 30, skipCoins: ["xrp", "doge", "bnb", "hype"], familyMaxPerWindow: 1, maxPerDay: 4, added: "2026-11-05", idea: "Daily fill cap on the one-per-window bid (maxPerDay is per coin, so 4 x 3 coins ~ 12 a day). Round 211 (5 Nov 2026 21:10 KST), research/server-book-maker-vs-taker-days.py on the server's 1-s 15m books, ETH/SOL/BTC by KST day, taker vs bid 4c/30 s touch: 31 Oct -24.6% vs +11.2%, 1 Nov +22.3% vs +30.4%, 2 Nov -23.3% vs -23.8%, 3 Nov +8.2% vs +34.4%, 4 Nov +11.8% vs +32.6%, 5 Nov (to 09:00) +22.8% vs +34.1%. The bid adds 10-26 points on normal days but does NOT soften a bad day (2 Nov: same -24%). Day-halt 3 barely helps (R209). research/server-book-early-maker-daycap.py, one fill per window, cap per KST day across the 3 coins: none 92 fills +19.3 stakes (2 Nov -2.2); cap 16 72 fills +15.8 (2 Nov -1.4); cap 12 56 fills 62% +11.1, green all 6 days (2 Nov +0.8); cap 8 40 fills +8.5, green 6/6. A cap trades about 40% of the profit for no red day in the sample; worth it for a first real test." },
  { name: "mk-early-first3-r4-30-thru-big3-one-dayhalt3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.04, restSec: 30, restThrough: true, skipCoins: ["xrp", "doge", "bnb", "hype"], familyMaxPerWindow: 1, familyHaltLosses: 3, added: "2026-11-05", idea: "Conservative paper twin of the proposed real test (through-fill instead of touch), because the paper lab overstates maker fills. Round 210 (5 Nov 2026 20:10 KST), research/server-book-vs-paper.py: same rule (mk-early-first3-r2-30, 2c/30 s through) on KST 4 Nov, paper lab vs replay on the server's 1-s books, $5: paper 156 trades 91 won +$48.1, replay 108 fills 60 won +$23.2. Per coin paper/replay: BTC 17/9 trades +$12.2/+$1.2, ETH 25/12 +$46.3/+$30.8, SOL 26/20 +$16.8/+$13.2, XRP 25/18 +$10.6/+$11.1, DOGE 23/14 -$17.3/-$21.8, BNB 8/7 -$14.1/-$35.0, HYPE 32/28 -$6.4/+$23.7. Signs agree on 6 of 7 coins, but paper has ~45% more fills and about 2x the profit. Judge Review 21 on server-book replays of 5-6 Nov, and on this stricter twin, not on the touch-fill paper numbers." },
  { name: "mk-early-first3-r4-30-touch-big3-one-dayhalt3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.04, restSec: 30, skipCoins: ["xrp", "doge", "bnb", "hype"], familyMaxPerWindow: 1, familyHaltLosses: 3, added: "2026-11-05", idea: "The exact shape proposed for a real $3 test: ETH/SOL/BTC early move, bid 4c under for 30 s, touch fill, one fill per window, cross-coin 3-loss day-halt. Round 209 (5 Nov 2026 19:10 KST), research/server-book-early-maker-dayhalt.py on the server's 1-s 15m books 31 Oct-5 Nov 09:00 KST, one fill per window: no halt 92 fills 63% +19.3 stakes (+21.0%/fill), by KST day +0.6 +0.9 -2.2 +6.8 +9.1 +4.2; dayhalt3 87 fills 64% +20.2 stakes (+23.2%/fill), 2 Nov -1.4; dayhalt2 48 fills 58% +6.5 (cuts winners); dayhalt4 never fires. Halt 3 is a free safety net, not an edge. At $3 a fill the replay is about +$58 over 5.4 days, worst day about -$7." },
  { name: "mk-early-first3-r4-30-touch-big3-one", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.04, restSec: 30, skipCoins: ["xrp", "doge", "bnb", "hype"], familyMaxPerWindow: 1, added: "2026-11-05", idea: "mk-early-first3-r4-30-touch-big3 limited to one fill per 15m window across ETH/SOL/BTC. Round 208 (5 Nov 2026 18:10 KST), research/server-book-early-maker-cluster.py on the server's 1-s 15m books 31 Oct-5 Nov 09:00 KST, 4c/30 s touch: 127 fills in 92 windows; 65 windows with 1 fill 63% won +21.4%, 19 with 2 fills 63% +22.0%, 8 with 3 fills 58% +15.6%. In 17 of 27 multi-fill windows every coin got the same result (independent coins at 62% would agree ~53% of the time), so two or three fills in one window are mostly one bet at double or triple size. First fill only: 92 fills 63% +21.0%, the same edge per fill as all 127 (+20.4%) with smaller loss days. Candidate shape for a real $3 test (one $3 bid live per window)." },
  { name: "mk-early-first3-r4-30-touch-big3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.04, restSec: 30, skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-05", idea: "Deeper bid: 4c under the early-move ask for 30 s, ETH/SOL/BTC, touch fill. Round 207 (5 Nov 2026 17:10 KST), research/server-book-early-maker-atfill.py on the server's 1-s 15m books 31 Oct-5 Nov 09:00 KST: at the moment the 3c/15 s bid fills, the Chainlink move has almost never reversed (ETH/SOL/BTC: 76 fills still 5+ bps ahead 61% +15.6%, 32 fills 2-5 bps 69% +29.7%, only 5 fills at 0-2 bps or reversed). So fills come from dips in the order book, not from the move failing, and a deeper bid costs little in fill count: grid (touch fill, 244 signals) 3c/15 s 113 fills +18.6%, 4c/15 s 87 fills 62% +20.3%, 4c/30 s 127 fills 62% +20.4% green 5/6, 5c/30 s 112 fills 62% +23.6% green 4/6. 4c/30 s gives the most profit per signal (about +26 stake-units vs +21 for 3c/15 s). Live equivalent bidUnderC 4, bidSec 30." },
  { name: "mk-early3bp-r3-15-touch-big3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 3, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.03, restSec: 15, skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-05", idea: "Volume twin of mk-early-first3-r3-15-touch-big3 with a 3 bps trigger instead of 5. Round 206 (5 Nov 2026 16:10 KST), research/server-book-early-maker-bp3.py on the server's 1-s 15m books 31 Oct-5 Nov 09:00 KST, ETH/SOL/BTC, bid 3c under the signal ask for 15 s, touch fill, by size of the first Chainlink move: 3 bps 461 signals 188 fills 55% +7.7% green 5 of 6 days; 5 bps 244 signals 113 fills 62% +18.6% (4/6); 8 bps 87 signals 46 fills 59% +10.3%; 12 bps 30 signals 20 fills 30% -43.0%. 5 bps is the sweet spot; a big move whose side still asks 60c or less is one the market does not believe. 3 bps gives 1.7x the fills at less than half the edge per fill; this twin checks whether that holds on fresh windows." },
  { name: "mk-early-5m-r3-15-touch-big3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [240, 290], minWindowSec: 300, maxWindowSec: 300, rest: 0.03, restSec: 15, skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-05", idea: "CONTROL, expected red: the 15m maker candidate moved to 5m windows, to check that the paper lab agrees with the server books. Round 205 (5 Nov 2026 15:10 KST), research/server-book-early-maker-5m.py on the server's 1-s 5m books 31 Oct-5 Nov 09:00 KST (first 5+ bps move in seconds 10-60, side asking 35-60c, touch fill): ETH/SOL/BTC 3c/15 s 180 fills 44% -11.2%, 2c/15 s 200 fills 46% -8.3%, green 2 of 6 days; other coins -1% to -7%. And on 15m a first move that comes later (3-6 min in, research/server-book-early-maker-15m-late.py) is flat: ETH/SOL/BTC 67 fills 54% +1.5%, green 1/5. The maker edge is only in the FIRST move of the first 3 minutes of a 15m window on ETH/SOL/BTC (113 fills 62% +18.6%). If this 5m twin shows green on paper, distrust the paper maker fill model." },
  { name: "mk-early-first3-r3-15-touch-big3-night", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.03, restSec: 15, skipCoins: ["xrp", "doge", "bnb", "hype"], skipHoursUtc: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 18, 19, 20, 21, 22, 23], added: "2026-11-05", idea: "Night-only (21-03 KST) twin of mk-early-first3-r3-15-touch-big3. Round 204 (5 Nov 2026 14:10 KST), research/server-book-early-maker-hour.py on the server's 1-s 15m books 31 Oct-5 Nov 09:00 KST, bid 3c under for 15 s, touch fill, by KST block: ETH/SOL/BTC 03-09 22 fills 59% +13.2%, 09-15 30 fills 60% +10.3%, 15-21 16 fills 75% +45.9%, 21-03 45 fills 60% +17.1% green 5 of 6 nights. Other 4 coins 21-03 79 fills 42% -18.5%. The real taker lost 21-03 KST, but the night loss belongs to the thin coins, not to ETH/SOL/BTC as makers, so the live candidate needs no night skip. The night is also where most signals fire (77 of 244). This twin isolates the block with the most fills." },
  { name: "mk-early-first3-r3-15-touch-66to70", left: 0, cap: 0.7, minAsk: 0.66, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.03, restSec: 15, added: "2026-11-05", idea: "Out-of-sample check of a band the bid rules never traded. Round 203 (5 Nov 2026 13:10 KST), research/server-book-early-maker-price.py and -price70.py on the server's 1-s 15m books 31 Oct-5 Nov 09:00 KST, early move bid 3c under the signal ask for 15 s, touch fill. Inside 35-60c the signal price does not sort winners for the maker (ETH/SOL/BTC 35-55c 54 fills +21.9%, 56-57c +15.0%, 58c 14 fills -35.1%, 59c +37.4%, 60c +38.5%): unlike the taker, where 56-60c fills lost, the 3c discount fixes the price leak. Above the 60c cap: 61-65c ETH/SOL/BTC 101 fills 55% -7.1% (green 1/6), other coins -7.7%; 66-70c ETH/SOL/BTC 97 fills 69% +6.1% (green 4/6), other coins 154 fills 67% +2.9% (green 4/6). Not monotone, so likely noise; this rule (all 7 coins, 66-70c) tests it on fresh windows. Keep the live candidate at the 60c cap." },
  { name: "mk-early-first3-r3-15-touch-big3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.03, restSec: 15, skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-05", idea: "Round 202 (5 Nov 2026 12:10 KST), research/server-book-early-maker-speed.py on the server's 1-s 15m books 31 Oct-5 Nov 09:00 KST: ETH/SOL/BTC early move, bid 3c under the signal ask, touch fill, split by how long the bid waited. Filled in 0-5 s: 56 fills 55% +5.4%; 5-15 s: 57 fills 68% +31.5%; 15-30 s: 35 fills 51% -5.0%; 30-60 s: 37 fills 51% -3.9%. Bids that fill after 15 s are moves that already failed (the other 4 coins: 30-60 s fills 39% won -25.6%). Grid: 3c/15 s touch 113 fills 62% +18.6% vs 3c/30 s 148 fills 59% +13.0%. Same rule as mk-early-first3-r3-30-touch-big3 with the bid pulled after 15 s; live equivalent is bidUnderC 3, bidSec 15." },
  { name: "mk-early-first3-r3-30-touch-big3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.03, restSec: 30, skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-05", idea: "The live maker mode (bidUnderC, 6293087) fills when the ask TOUCHES the bid, not only when it trades through, so this paper twin counts touch fills. Round 201 (5 Nov 2026 11:10 KST), research/server-book-early-maker-grid.py on the server's 1-s 15m books 31 Oct-5 Nov 09:00 KST, ETH/SOL/BTC early move (244 signals): bid 2c under for 30 s THROUGH 148 fills 59% +10.9% but TOUCH 163 fills 57% +6.5% (the 15 extra touch fills are the losers); bid 3c under 30 s TOUCH 148 fills 59% +13.0%, green 5 of 6 KST days; 3c through 127 fills 62% +18.1%. Other 4 coins red in every one of 18 cells (-9.5% to -15.5%, green 1-2 of 5). So a live bid should sit 3c under, not 2c. Judge against mk-early-first3-r2-30-big3 (through-fill)." },
  { name: "mk-early-first3-r2-30-big3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.02, restSec: 30, restThrough: true, skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-05", idea: "mk-early-first3-r2-30 on ETH, SOL and BTC only, no halt: the exact rule replayed in research/server-book-early-maker.py. Round 200 (5 Nov 2026 10:10 KST), on the SERVER's 1-s books (server/hist 31 Oct-5 Nov 09:00 KST): first 5+ bps Chainlink move in seconds 30-180 of a 15m window with the side asking 35-60c, rest a bid 2c under that ask for 30 s, filled only if the ask trades strictly below the bid, no fee, hold to close. ETH+SOL+BTC: 148 fills from 244 signals, 88 won (59%), +10.9% of stake over six KST days; by day 31 Oct +7.2% (5 fills), 1 Nov +25.5% (3), 2 Nov -28.9% (33), 3 Nov +16.5% (33), 4 Nov +22.0% (41), 5 Nov +30.4% (33). Other four coins: 230 fills, 106 won (46%), -13.2%. The same signal taken at the ask (research/server-book-early-taker.py) made ETH+SOL+BTC +8.2/+11.8/+22.8% on 3-5 Nov, so the bid adds about 8 points a day there (round 195: fee plus price). This is the first rule that clears the promotion numbers on the server's own books (100+ fills, 59% won, positive, green 5 of 6 days), but 2 Nov shows it can lose 29% in a day. Judge with the lab twin over the next days." },
  { name: "mk-early-first3-r2-30", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.02, restSec: 30, restThrough: true, added: "2026-11-04", idea: "mk-early-first3-r3-30 resting 2c under the ask (more fills, thinner discount). Study: 284/521 filled, 57% won, +3.1% of stake." },
  { name: "ahead5-cheap60-15m-dayhalt3-maker1", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, rest: 0.01, restSec: 60, added: "2026-11-04", idea: "MAKER twin of the live ahead5-cheap60-15m-dayhalt3: at the signal it does not take the ask, it rests a bid 1c under it for 60 s (cancelled after that or at window end) and books a fill, at the bid price and with NO fee, only if the side's best ask comes down to the bid. Round 176 (4 Nov 2026, enrique: 'so we're only takers?'): yes, every real order so far has been a taker FAK, and Polymarket's taker fee on these crypto up/down markets is 0.07 x price x (1 - price) per share = 7% x (1 - price) of the stake: 3.2% at 55c (about 1.7 points of win rate added to break-even), 0.6% at 91c; makers pay none. Against that, round 122's October replay of 702 BTC/ETH early-move looks found a resting bid 3c under the trigger filled 75% of the time but those fills won only 55.0% (+$0.006 per $1) while the 25% that never dipped won 77.1%: the fill itself is bad news (adverse selection). This settles it on the server's live books at 1c and 2c (twin maker2). Judge fill rate, won % of fills and net against dayhalt3." },
  { name: "ahead5-cheap60-15m-dayhalt3-maker1-down", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, rest: 0.01, restSec: 60, onlySide: "DOWN", added: "2026-11-07", idea: "Round 250 (7 Nov 2026 12:10 KST, the hour maker1 went live with real money): the live maker bid on DOWN signals only. Paper maker1 books a fill on 85-89% of the taker signals (5 Nov UTC 245 of 274, 6 Nov 286 of 335) but wins 57-59% vs the taker's 60-62% on the same signals: the bids that fill are the ones the market moved through, about 3 points of win rate lost to adverse selection, about what the ~3% taker fee costs. DOWN held out of sample on server books (BIG3 DOWN +17.1% vs UP -29.3%; other coins DOWN +11.7% vs UP +0.6%), so the maker's UP half may be the drag. Same day stop (3 straight losses across coins)." },
  { name: "ahead5-cheap60-15m-dayhalt3-maker1-30s", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, rest: 0.01, restSec: 30, added: "2026-11-07", idea: "Round 251 (7 Nov 2026 13:10 KST): the live maker (1c under, 60 s) in its first real hour: 3 signals, 3 real bids, 1:1 with the paper taker signals (fire check passed); 2 filled and both lost (XRP DOWN 38c 11:58 KST, XRP UP 57c 12:28), 1 cancelled unfilled (HYPE UP 54c). Round 250 found paper maker fills win 57-59% vs the taker's 60-62% on the same signals: a bid that fills late in its 60 s is one the price moved back through. This twin rests only 30 s, so it keeps the early dip fills and drops the late ones; compare against maker1 (60 s) on win rate per fill." },
  { name: "ahead5-cheap60-15m-first3-maker1-ask50", left: 0, cap: 0.6, minAsk: 0.5, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, added: "2026-11-07", idea: "Round 254 (7 Nov 2026 16:10 KST): the live maker (first3 signal, 1c-under bid, 60 s, real-loss day stop) went 0/3 on its first real day, all XRP (DOWN 38c, UP 57c, DOWN 56c, -$9.0), then hit its 3-loss stop at ~15:30. The BIG3 DOWN server-book split by price paid (R225: 35-50c +28.8%, 51-55c +38.3%, 56-60c +13%) says cheap asks are not where the edge is lost, but on the thin coins a 35-49c ask on a 5 bp move is the market saying the move is noise. This twin of the live maker only bids when the signal ask is 50c or more (no paper day stop, like the live copy)." },
  { name: "ahead5-cheap60-15m-first3-maker1-noday", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, skipHoursUtc: [3, 4, 5, 6, 7, 8], added: "2026-11-07", idea: "Round 255 (7 Nov 2026 17:10 KST): the live maker skipping 12:00-18:00 KST. First live afternoon: the first3 signal fired 19 times 11:55-15:55 KST but only once 16:51-17:10, and the real maker went 0/3 (XRP 12:00, 12:30, 15:15); R228/R232 found the BIG3 DOWN taker flat on server books 12-18 KST (+1.1% vs +18.6% to +31.6% in the other blocks). Same live shape (1c-under bid, 60 s, no paper day stop), off in the afternoon block." },
  { name: "ahead5-cheap60-15m-first3-maker1-15s", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 15, added: "2026-11-07", idea: "Round 256 (7 Nov 2026 18:10 KST): first real day of the live maker (1c-under bid, 60 s): 8 bids, 6 filled (75%, paper maker1 books 85-89%), fills won 2/6 (XRP UP 57c +2.26 and 58c +2.17 after 17:00; XRP 38c/57c/56c and HYPE 59c/59c lost), -$7.5. Paper first3 (taking the ask) won 13/19 on the same afternoon signals. Fills that come late in the 60 s are the adverse ones; this twin rests only 15 s, so it keeps only the fills from the ask blipping down right at the signal (the 30 s twin is round 251)." },
  { name: "ahead5-cheap60-15m-first3-maker1-noxrphype", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, skipCoins: ["xrp", "hype"], added: "2026-11-07", idea: "Round 257 (7 Nov 2026 19:10 KST): every real maker bid since 15:00 KST was on XRP or HYPE (12 maker fills today, 4 won, about -$14.6; BTC/ETH/SOL/DOGE/BNB none). With maxOpen 3 across coins, the thin-book coins whose 5 bp early moves come most often take the open slots. Paper first3 over 3-7 Nov: XRP -$39.5 and HYPE +$1.6 fillable vs ETH +$95 and BTC +$63 (coin picks from one sample fade, so this is a probe, not a pick). The live maker without XRP and HYPE." },
  { name: "ahead5-cheap60-15m-first3-maker1-ask58", left: 0, cap: 0.6, minAsk: 0.58, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, added: "2026-11-07", idea: "Round 258 (7 Nov 2026 20:10 KST): the live maker's REAL fills today split by the ask it bid under: asks 58-60c 10 fills, 6 won, +$0.79; asks under 58c 4 fills, 0 won, -$11.99 (XRP 54c, HYPE 48c and 54c). A cheaper favoured side after a 5 bps move means the book has not believed the move, and a maker bid there fills when it is right not to. Tiny sample (14 fills, one day), so paper only: the live maker with a 58c floor, judged by fillable trades against ahead5-cheap60-15m-first3-maker1 and the 50c-floor sibling (round 254)." },
  { name: "ahead5-cheap60-15m-first3-ask58", left: 0, cap: 0.6, minAsk: 0.58, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, added: "2026-11-07", idea: "Round 259 (7 Nov 2026 21:10 KST): on the same early-move signal today, paper TAKING the ask (ahead5-cheap60-15m-first3) is 194 trades, 114 won (58.8%), +$13.72, while paper maker bids 1c under fill the losers: maker1-ask50 17 fills 6 won -$33.58, maker1-noday 12 fills 4 won -$25.97, maker1-15s 7 fills 1 won -$26.53. A bid under the ask fills when the price comes back down to it, i.e. when the move is fading. Round 258 saw real maker fills under 58c go 0/4. This is the taker with the 58c floor, to measure whether the taker side of the round-258 split holds without the maker's adverse fills." },
  { name: "ahead5-cheap60-15m-first3-big4", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, skipCoins: ["sol", "xrp", "hype"], added: "2026-11-07", idea: "Round 260 (7 Nov 2026 22:10 KST): paper taker ahead5-cheap60-15m-first3 today split by coin: BTC/ETH/BNB/DOGE 68 trades, 48 won (70.6%), +$76.8 (BTC 9/13 +$13.9, ETH 12/20 +$5.6, BNB 10/12 +$24.0, DOGE 17/23 +$29.2); SOL/XRP/HYPE 126 trades, 66 won (52%), -$59.1 (HYPE 22/46 -$38.7). The live maker, limited to 3 open bids, fills almost only on XRP and HYPE because they move first: 16 of 17 real maker fills today, 7 won. The coins that move first and most often are the ones where a 5 bps move means least. One day only (round 74 over 14 days had XRP the only weak coin), so this is the taker on the four calmer coins to see whether the split repeats on new days." },
  { name: "ahead5-cheap60-15m-first3-maker1-us", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, hoursUtc: [12, 18], added: "2026-11-07", idea: "Round 261 (7 Nov 2026 23:10 KST): the live maker restricted to 21:00-03:00 KST (US session). Today the paper taker ahead5-cheap60-15m-first3-us made 80 trades, 72.5% won, +$111.95, while the same signal over the rest of the KST day made 124 trades, 51.6% won, -$78.41 (first3 all day 204, +$33.54). Real fills split the same way: since 21:00 KST 8 fills, 7 won, +$11.45; before 21:00 20 fills, 8 won, -$18.84. Round 89 (31 Oct) saw the US-session tilt over 11 days; this is the first time real fills agree. Paper maker on US hours only, to set against the all-day live maker." },
  { name: "ahead5-cheap60-15m-first3-maker1-ask55", left: 0, cap: 0.6, minAsk: 0.55, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, added: "2026-11-08", idea: "Round 262 (8 Nov 2026 00:10 KST): all 29 real fills since go-live (7 Nov 11:44 KST, maker + BIG3 taker) by the ask at the signal: under 55c 5 fills, 0 won, -$14.99; 55-58c 3 fills, 2 won, +$1.62; 58-59.5c 8 fills, 7 won, +$12.01; 60c 13 fills, 7 won, -$3.81. The cheap end is the only cell that never won: a favoured side still under 55c after a 5 bps move is one the book does not believe. Between the 50c (round 254) and 58c (round 258) floors: the live maker with a 55c floor, judged on fillable trades." },
  { name: "ahead5-cheap60-15m-first3-maker1-down", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, onlySide: "DOWN", added: "2026-11-08", idea: "Round 263 (8 Nov 2026 01:10 KST): all 33 real fills since go-live (7 Nov 11:44 KST) by side: DOWN 19 fills, 12 won (63%), +$4.45; UP 14 fills, 7 won (50%), -$6.12. The BIG3 taker is DOWN-only by design (its replay favoured DOWN), and the maker now shows the same tilt on real money. ahead5-cheap60-15m-dayhalt3-maker1-down already tests this but carries the dayhalt3 stop that silenced it on 7 Nov (round 253); this is the stop-free live maker, DOWN only, to compare on fillable trades against the all-sides maker." },
  { name: "ahead5-cheap60-15m-first3-maker1-big4", left: 0, cap: 0.6, minAsk: 0.55, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, skipCoins: ["sol", "xrp", "hype"], added: "2026-11-08", idea: "Round 264 (8 Nov 2026 02:10 KST): real fills since go-live (42, 7 Nov 11:44 KST on) split two ways. By price: under 55c 11 fills, 1 won, -$25.36 (01:30 KST alone: ETH 36c, XRP 45c, DOGE 54c lost, BTC 41c won). By crowding: windows where 3+ coins filled at once 11 fills, 4 won, -$10.18; single fills 19, 10 won, -$5.08; pairs 12, 7 won, -$0.69. Crowded windows are one market-wide move bet several times over. Combines the 55c floor (round 262) with round 260's calmer-coin split (paper taker BTC/ETH/BNB/DOGE 71% won vs SOL/XRP/HYPE 52% on 7 Nov): the maker on BTC/ETH/BNB/DOGE only, bidding only at 55c+." },
  { name: "ahead5-cheap60-15m-first3-maker1-us55", left: 0, cap: 0.6, minAsk: 0.55, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, hoursUtc: [12, 18], added: "2026-11-08", idea: "Round 265 (8 Nov 2026 03:05 KST): real fills since go-live (43) split by session and price: 21:00-03:00 KST with ask 55c+ 16 fills, 12 won, +$13.55; 21-03 under 55c 7, 1 won, -$13.37; other hours 55c+ 16, 8 won, -$6.85; other hours under 55c 4, 0 won, -$11.99. Only one cell makes money. The live maker restricted to US hours AND a 55c floor (rounds 261 + 262 combined)." },
  { name: "ahead5-cheap60-15m-first3-maker1-after60", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 840], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, added: "2026-11-08", idea: "Round 266 (8 Nov 2026 04:10 KST): real fills since go-live (43) by minute of the 15m window they were placed in: minute 0 (0-60 s) 20 fills, 7 won, -$21.06; minute 1 18, 9 won, -$7.95; minute 2 5, 5 won, +$10.35. The earliest 5 bps moves reverse most; a move that is still 5 bps ahead after a minute is sturdier. The live maker, but only once 60 s of the window have passed (left 720-840)." },
  { name: "ahead5-cheap70-15m-first3-maker1-66to70", left: 0, cap: 0.7, minAsk: 0.66, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, added: "2026-11-08", idea: "Round 267 (8 Nov 2026 05:10 KST): the server paper maker mk-early-first3-r3-15-touch-66to70 (early 5 bp move, signal ask 66-70c, bid 3c under for 15 s, touch fill) is 567 trades, 378 won (66.7%), +$92.15 over 5-8 Nov, green 3 of 4 days (5 Nov +$96.85, 6 Nov -$52.49, 7 Nov +$33.14, 8 Nov so far 20 trades +$14.65), while the live 35-60c band is -$7.93 today and real under 55c is 1 of 11. Touch fills overstate maker fills (~2x), so this copies the LIVE maker mechanics instead (1c under the ask, 60 s) on the 66-70c band, all 7 coins, to see if the band survives a realistic bid." },
  { name: "ahead10-cheap60-15m-first3-maker1", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 10, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, added: "2026-11-08", idea: "Round 268 (8 Nov 2026 06:10 KST): real fills since go-live 48, 23 won, -$23.01 (avg ask 56.4c vs 47.9% won). XRP + HYPE are 32 of the 48 fills (67%), 13 won, -$28.20; the other five coins 16 fills, 10 won, +$5.18 (HYPE lost 3 in a row 04:45-05:32). A fixed 5 bp trigger fires far more often on the noisy coins, and those are the bids that fill against us. Rather than drop coins on one sample, this is the live maker (1c under, 60 s, all 7 coins) with the early-move trigger doubled to 10 bps, so only moves large for any coin count." },
  { name: "ahead5-cheap60-15m-first3-maker2", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.02, restSec: 60, added: "2026-11-08", idea: "Round 269 (8 Nov 2026 07:10 KST): the paper twin of the live maker (ahead5-cheap60-15m-first3-maker1-noday, no day stop) now tracks real almost exactly: paper 46 trades, 22 won, -$32.96 at $5 (about -$19.8 at $3) vs real maker 47 fills, 23 won, -$16.64 since 7 Nov 11:44 KST. So the paper lab is faithful for this rule, and it says the rule has lost since go-live; its +$125 (710 trades) came from 4-6 Nov. The 2c-under version (dayhalt3-maker2) was +$84 on 666 over the same days. This bids 2c under with no day stop (same as live otherwise) to test whether a deeper bid escapes the adverse fills." },
  { name: "ahead5-cheap60-15m-rev-maker1", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, prevRel: "opposite", rest: 0.01, restSec: 60, added: "2026-11-08", idea: "Round 269b (8 Nov 2026 08:10 KST): the paper taker ahead5-cheap60-15m-rev (live early-move rule, only when the previous 15m window closed against the move) over 4-7 Nov: 596 trades, 382 won (64.1%), +$260.3, +$0.44/trade, green all 4 days (7 Nov 106 trades 68% +$94.1); the plain first3 taker over the same days 1,340 trades 61.3% +$224.4, +$0.17/trade. 8 Nov so far rev 11 trades 4 won -$18.8. Real fills since go-live also hint at reversal: after a losing real fill the next fill on the OPPOSITE side won 8 of 11 (+$12.91) vs 5 of 9 on the same side. The live maker mechanics (1c under, 60 s) on the rev filter." },
  { name: "ahead5-cheap60-15m-first3-maker1-kst21", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, hoursUtc: [12, 15], added: "2026-11-08", idea: "Round 271 (8 Nov 2026 09:10 KST): real fills since go-live (61, 7 Nov 11:44 KST on) by 3-hour KST block: 21-24 10 fills, 8 won, +$10.68; every other block red: 00-03 13 fills 5 won -$10.49, 03-06 5/2 -$4.35, 06-09 13/6 -$4.83, 12-15 4/1 -$6.81, 15-18 5/2 -$4.54, 18-21 11/5 -$7.48 (51 fills, 21 won, -$38.50). Round 261 tested 21-03; the 00-03 half has since turned red. The live maker only 21:00-24:00 KST (12-15 UTC, the US pre-market and open)." },
  { name: "ahead5-cheap60-15m-first3-maker1-one", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, familyMaxPerWindow: 1, added: "2026-11-08", idea: "Round 272 (8 Nov 2026 10:10 KST): real fills since go-live (62) fell in 40 windows. The first fill of each window: 40 fills, 21 won, -$7.28; the extra fills in the same window (other coins, or maker + taker on one coin): 22 fills, 9 won (41%), -$18.39, i.e. 70% of the loss from a third of the fills. Extra fills repeat one market-wide bet. The live maker (all 7 coins, 1c under, 60 s) capped at one entry per 15m window across all coins." },
  { name: "ahead5-cheap60-15m-q0-maker1-calm3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, quarters: [0], skipCoins: ["sol", "xrp", "doge", "hype"], rest: 0.01, restSec: 60, added: "2026-11-08", idea: "Round 273 (8 Nov 2026 11:10 KST): scan of every paper variant with 150+ trades over 5-8 Nov. ahead5-cheap60-15m-q0 (live entry, only the xx:00 window) is green 3 of 4 days, and its FILLABLE record splits by coin: BTC 41 fills +$34.14, ETH 50 +$68.03, BNB 28 +$8.65 (119 fills, 82 won, 68.9%, +$110.8) vs SOL/XRP/DOGE/HYPE 262 fills, 137 won (52%), -$140.1. The calm-coin vs noisy-coin split keeps recurring (rounds 260, 264, 268). arb97 tops the scan (+$426, 4/4 days) but has 0 fillable trades, so it is ignored. This is the live maker (1c under, 60 s) on the xx:00 window, BTC/ETH/BNB only." },
  { name: "ahead5-cheap60-15m-first3-maker1-day2", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, maxPerDay: 2, added: "2026-11-08", idea: "Round 274 (8 Nov 2026 12:10 KST): real MAKER fills since go-live (53) by their order within the coin's KST day: the first 2 fills per coin per day 20 fills, 12 won, +$5.26; the 3rd and later 33 fills, 13 won (39%), -$29.55 (HYPE 8 Nov: 7 fills, 2 won, day stop hit at 11:01). Busy coin-days are choppy days where early moves keep reversing (round 151 saw the same on the feed rule). Today all eight overnight maker paper variants are red and only 11 of 169 15m paper rules with 20+ trades are green. The live maker, at most 2 entries per coin per KST day." },
  { name: "ahead5-cheap60-15m-dayhalt2-maker1", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 2, rest: 0.01, restSec: 60, added: "2026-11-08", idea: "Round 275 (8 Nov 2026 13:10 KST): ranking every paper rule by FILLABLE result 4-8 Nov (100+ fillable trades), the best large one is the live maker WITH the cross-coin 3-loss day stop, ahead5-cheap60-15m-dayhalt3-maker1: 589 fillable, 338 won (57.4%), +$101.9, green 4 of 5 days (8 Nov only -$9 while the stop-free twin maker1-noday is -$33 on 46 since 7 Nov and real maker is -$27 since go-live). The stop was removed from the live maker on 7 Nov 16:52. Round 274 found the 3rd+ fills of a coin-day lose. A tighter cross-coin stop: after 2 straight losses, sit out until KST midnight." },
  { name: "ahead5-cheap60-15m-big3-up-one", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyMaxPerWindow: 1, onlySide: "UP", skipCoins: ["xrp", "doge", "bnb", "hype"], added: "2026-11-08", idea: "Round 276 (8 Nov 2026 14:10 KST): the live BIG3 DOWN taker has not held its replay (83 trades, 66% won, +$46). Its stop-free paper twin ahead5-cheap60-15m-big3-down-one: 6 Nov 4 trades -$12.1, 7 Nov 22 (11 won) -$13.2, 8 Nov 9 (4 won) -$11.8 = 35 trades, 46% won, -$37.1 (fillable 29, 12 won, -$38.8); real since go-live 11 fills, 5 won, -$7.48. Red every day. This is the UP mirror (same coins ETH/SOL/BTC, one per window) as a control: if UP does as badly, the DOWN choice carried no edge and the rule is just the early-move rule on three coins." },
  { name: "ahead5-cheap60-15m-first3-maker1-one-day2", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, familyMaxPerWindow: 1, maxPerDay: 2, added: "2026-11-08", idea: "Round 277 (8 Nov 2026 15:10 KST): the two crowding cuts together. Real since go-live: extra fills in a window that already had one 22 fills, 9 won, -$18.39 (round 272); 3rd+ maker fills of a coin-day 33 fills, 13 won, -$29.55 (round 274). The live maker capped at one entry per 15m window across coins AND two per coin per KST day. Real fills 12:16-15:00 KST: none (quiet Asian afternoon, as on 7 Nov)." },
  { name: "ahead5-cheap60-15m-big3-down-one-hold5", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyMaxPerWindow: 1, onlySide: "DOWN", skipCoins: ["xrp", "doge", "bnb", "hype"], confirmSec: 5, confirmCap: 0.6, confirmDipC: 0.03, added: "2026-11-08", idea: "Round 278 (8 Nov 2026 16:10 KST): ranking paper rules by FILLABLE result 4-8 Nov, ahead5-cheap60-15m-hold5 (wait 5 s after the trigger, buy only if the ask never dipped 3c) is one of the few large positive ones: 623 fillable, +$60.1, green 4 of 5 days, vs the plain taker it refines. The live BIG3 DOWN taker is red every day since 6 Nov (paper 35 trades 46% -$37.1, real 11 fills 5 won -$7.48; round 276). This is the live taker with the 5 s no-dip confirmation, to see whether the confirmation rescues it before Review 32 decides on it." },
  { name: "ahead3-cheap60-15m-first3-maker1-midday", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 3, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, familyMaxPerWindow: 1, hoursUtc: [0, 6], added: "2026-11-08", idea: "Round 279 (8 Nov 2026 17:10 KST): the no-trades afternoon was a signal drought, not a block. After the 12:15 window the 5 bp first3 signal fired on no live coin except HYPE (stopped) through 17:00 KST; the status skip log (83817f7) showed 0 skips and 0 open fills. Live maker bids by KST block since 7 Nov 15:15 (75 bids): 00-03 16, 18-21 12, 21-24 11, but 09-12 only 6 and 12-15 only 2. The live maker with a 3 bp trigger in 09:00-15:00 KST only, one fill per window across coins: does a smaller move in the quiet Asian midday carry the same follow-through, or is it noise?" },
  { name: "ahead5-cheap60-15m-first3-maker1-hotcoin", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, familyMaxPerWindow: 1, prevDayCoinGreenOf: "ahead5-cheap60-15m-first3", added: "2026-11-08", idea: "Round 280 (8 Nov 2026 18:10 KST): coin-level day momentum in the early-move rule. Server paper days (up to 7 KST days x 7 coins, status.json): ahead5-cheap60-15m-first3 on a coin whose previous KST day was green: 766 trades 59.7% won +$74.26; previous day red: 978 trades 58.3% -$29.75. Same split on the cross-coin day-stop maker (dayhalt3-maker1): prev green 308 trades 58.8% +$97.94, prev red 253 trades 55.7% +$5.79. Busy vs quiet coin-days does not explain it (busy -$0.07/trade, quiet -$0.22). The live maker shape (1c under for 60 s, one fill per window) only on coins where first3 was green yesterday; on 8 Nov that is BTC, ETH, DOGE and BNB (green 7 Nov), not SOL, XRP or HYPE. Small sample (about 6 day transitions per coin): judge after 100+ fillable trades." },
  { name: "ahead5-cheap60-15m-first3-maker1-one-gap", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, familyMaxPerWindow: 1, familySkipNextWindow: true, added: "2026-11-08", idea: "Round 281 (8 Nov 2026 19:10 KST): the exact paper copy of the live maker since Review 31 (maxOpen 1). The new skip log (83817f7) caught it: the 18:16 XRP fill (won +$2.36) was still unsettled when the 18:30 window signalled, so SOL UP and DOGE DOWN were skipped with max 1 open fill. Polymarket settles 3-5 min after the close and the signal comes 0.5-3 min into the next window, so live maxOpen 1 means one fill per window AND nothing in the window after a fill. The paper maker1-one rule (one per window, R272) misses the second part, so it overstates what live can take. This twin skips the window after any family fill; compare with maker1-one to price the gap." },
  { name: "ahead5-61to62-15m-first3-maker2", left: 0, cap: 0.62, minAsk: 0.605, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.02, restSec: 60, familyMaxPerWindow: 1, added: "2026-11-08", idea: "Round 282 (8 Nov 2026 20:10 KST): the 60c cap is what made the afternoon quiet, and it is right: across the server lab (2-8 Nov) ahead5-cheap70-15m-first3 is fillable 2810 trades 61.4% won -$759.3 against ahead5-cheap60-15m-first3 1793 trades 56.3% -$373.6, so the extra 1017 signals asking 60-70c lost about -$386 (the 66-70c maker twin is 82 fillable 59.8% -$47.5 today). The price, not the move, is the problem above 60c. This probe keeps only signals asking 61-62c and rests a bid 2c under (59-60c), so a fill lands inside the live price band: do near-miss signals that come back to 60c win like the in-band ones, or is a falling ask after a 61c signal adverse selection?" },
  { name: "ahead5-55to59-15m-first3-maker1", left: 0, cap: 0.59, minAsk: 0.55, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, familyMaxPerWindow: 1, added: "2026-11-08", idea: "Round 283 (8 Nov 2026 21:10 KST): real live-maker fills since 7 Nov 15:15 KST (56 settled, status.json realTrades) by the signal ask: exactly 60c 20 fills 8 won -$19.44; 58-59c 15 fills 12 won +$17.05; 55-57c 7 fills 5 won +$6.16; under 55c 14 fills 4 won -$15.50. The 55-59c band is 22 fills 17 won (77%) +$23.21 while both edges lose: at 60c the signal sits on the cap (the move is already priced, R282 showed 60-70c signals lose), under 55c the move has not convinced the book. 19:46 BNB UP at 60c lost again. The live maker shape, one fill per window, only on signals asking 55-59c. Small real sample: judge on fillable paper after 100+." },
  { name: "ahead5-cheap60-15m-min2-maker1-one", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 780], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, familyMaxPerWindow: 1, added: "2026-11-08", idea: "Round 284 (8 Nov 2026 22:10 KST): real live-maker fills since 7 Nov 15:15 KST (58 settled) by when the signal came (order time minus window start): first 60 s 22 fills 9 won -$14.92; 60-120 s 26 fills 13 won -$9.91; 120 s or later 10 fills 7 won +$7.10. A 5 bp move that is still there 2 minutes in has survived the opening noise; the earliest triggers are the ones that reverse. Memory had min 2 placed 5/5 +$10.35 from the 3-hour cut; this is the same split on all 58 fills. The live maker shape (1c under for 60 s, one per window) only for signals 120-180 s into the window." },
  { name: "fav90-bigmove-5m", left: 0, cap: 0.97, strictCap: true, size: 5, favAt: 0.9, favFrom: 100, favTo: 200, leadMin: 25, minWindowSec: 300, maxWindowSec: 300, added: "2026-11-08", idea: "High win-rate thread (8 Nov 2026 23:00 KST, reviews/high-winrate-2026-11-08.md; enrique: try high wr things): 5-minute favourite at 90c+ (up to 97c) between 100 and 200 s into the window, only when Chainlink is already 25+ bp from the open toward that side. Replay 31 Oct-7 Nov: 267 trades 96.6% won +2.0c/share, 7 of 7 days green, but 43% of the trades fell on 5 Nov (big-move days only). Every other crypto favourite rule in the lab (121 at 78-97% won) is red on fillable trades, so this is the one favourite shape with a positive replay; judge on fillable after 100+." },
  { name: "fav93-hold-1h-maker1", left: 0, cap: 0.97, strictCap: true, size: 5, favAt: 0.93, holdRows: 10, holdAt: 0.9, rest: 0.01, restSec: 60, minWindowSec: 3600, maxWindowSec: 3600, added: "2026-11-08", idea: "Round 285 (8 Nov 2026 23:10 KST; enrique: try high wr things). Of the 121 crypto favourite rules at 78-97% won, the one nearest break-even on fillable trades is fav93-hold on the 1-hour markets: 427 fillable, 97.2% won, -$7.3, i.e. -1.7c per $1 (15m -5.3c on 2,425; 5m -6.4c on 4,256: the longer the window, the less the favourite overpays). At 93-97c the taker fee is under 1% of the stake and the loss is the price itself, so a 1c maker bid (rest 1c under the ask for 60 s) is worth about +1c per share plus the fee, roughly the whole gap. The 1h favourite as a maker, strict 97c cap." },
  { name: "ahead5-cheap60-15m-first3-maker1-one-nohype", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, familyMaxPerWindow: 1, familySkipNextWindow: true, skipCoins: ["hype"], added: "2026-11-09", idea: "Round 286 (9 Nov 2026 00:10 KST): real live-maker fills since go-live (64 settled, 7 Nov 15:15 - 8 Nov 23:46 KST) by coin: HYPE 20 fills 8 won -$19.06; the other six coins 44 fills 26 won (59%) +$8.31 (SOL 12/9 +$11.11, XRP 19/11 +$3.69, BTC 2/1 +$1.50, ETH 3/2 +$1.12, BNB 3/1 -$3.57, DOGE 5/2 -$4.60). HYPE is 31% of the fills and more than the whole loss; its 15m book is the thinnest (35-38% of tickets missed, round 140) and its paper first3 is -$44.6 today alone. The exact live shape (1c under for 60 s, one fill per window, skip the window after a fill) without HYPE. Also: real fills after a loss 29 fills 17 won +$3.62, after a win 34 fills 17 won -$10.43, so no hot hand." },
  { name: "fav90-bigmove-5m-maker1", left: 0, cap: 0.97, strictCap: true, size: 5, favAt: 0.9, favFrom: 100, favTo: 200, leadMin: 25, rest: 0.01, restSec: 30, minWindowSec: 300, maxWindowSec: 300, added: "2026-11-09", idea: "Round 287 (9 Nov 2026 01:10 KST): the live maker since go-live has placed 93 real bids and filled 65 (70%): HYPE 20 of 28, XRP 20 of 26, SOL 12 of 18, DOGE 5 of 11, ETH 3 of 5, BNB 3 of 3, BTC 2 of 2; the 6 partial fills went 2 won -$7.17 against 59 full fills 32 won -$5.63 (a bid that only half fills is one the ask touched and bounced). A resting bid 1c under a 90-97c favourite ask (the live lead-2 shape, fav90-bigmove-5m) is worth about 1c per share plus the fee, half of that rule's +2c replay edge. Rest 30 s inside the 100-200 s window. Judge the fill rate and the won% against the taker twin." },
  { name: "fav90-bigmove-5m-lead15", left: 0, cap: 0.97, strictCap: true, size: 5, favAt: 0.9, favFrom: 100, favTo: 200, leadMin: 15, minWindowSec: 300, maxWindowSec: 300, added: "2026-11-09", idea: "Round 288 (9 Nov 2026 02:10 KST): the live lead-2 rule fav90-bigmove-5m (25+ bp Chainlink lead, 90-97c, 100-200 s in) has had 0 paper signals on all 7 coins in its first 3 h and 0 real orders on XRP/DOGE/SOL, against a replay average of about 17 a day (43% of which fell on 5 Nov). The same night the live maker saw 11 early-move signals. Same rule with a 15 bp lead to measure how much of the drought is the 25 bp bar and whether the won rate holds at the smaller lead (replay only covered 25+ bp). Frequency probe first, edge second; judge on fillable after 100+." },
  { name: "ahead5-cheap60-15m-first3-maker1-one-broad2", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, familyMaxPerWindow: 1, familySkipNextWindow: true, breadthMin: 2, added: "2026-11-09", idea: "Round 289 (9 Nov 2026 03:10 KST): the 69 real maker fills since go-live split by how many coins filled in the same 15m window: solo windows 37 fills 19 won -$11.31; windows with 2+ coins 32 fills 18 won +$1.94, and inside those the FIRST coin to fill went 13 of 13 windows 10 won +$16.65 while the later fills went 19/8 -$14.71. A move that one coin makes alone is noise; a market-wide move is real, but only the first ticket in it gets a fair price. The lab's breadth filter (ahead5-cheap60-15m-broad, 4+ other coins moving) lifts the taker from 56.4% to 58.8% won on 924 fillable trades (-$42.6 vs -$369.5 for the base) without going green. This twin crosses the live maker shape (1c under, 60 s, one fill per window and the next window skipped) with a 2-coin breadth bar, so it takes the first bid of a broad move and nothing else." },
  { name: "ahead5-cheap60-15m-first3-maker1-two-gap", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, familyMaxPerWindow: 2, familySkipNextWindow: true, added: "2026-11-09", idea: "Round 290 (9 Nov 2026 04:10 KST): the live maker's max-1-open counts FILLS, and a resting bid is only written down when its 60 s rest ends, so bids that go out within the same minute all rest together. Since Review 31 (8 Nov 10:45 KST) 17 windows carried a live bid and 4 of them carried 2-3 bids placed 1-20 s apart (22:00 XRP+SOL, 23:00 ETH+SOL, 02:00 HYPE+DOGE, 03:30 SOL+DOGE+HYPE): 9 fills 7 won +$9.22, the later bids 5/4 +$5.52. The paper one-per-window twins count placements, so live has been looser than its paper copy. This twin allows two tickets per window (then skips the next window) to measure what the live shape actually does, against maker1-one-gap (strict one). Before Review 31 the later fills in a window went 8/19 -$14.71 (R289), so the question is whether the second ticket within the same minute is the good kind of follower." },
  { name: "ahead5-cheap60-15m-first3-maker1-one-cap59", left: 0, cap: 0.59, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, familyMaxPerWindow: 1, familySkipNextWindow: true, added: "2026-11-09", idea: "Round 291 (9 Nov 2026 05:10 KST): real maker bids since go-live by the signal ask: exactly 60c 43 bids, 28 fills, 15 won, -$7.88; 58-59c 26 bids, 20 fills, 13 won, +$7.32; under 58c 36 bids, 25 fills, 11 won, -$10.64. The 60c signals fill as often as the rest (65% vs 77%/69%) but win only 54%, and they are 41% of all bids. The 55-59c twin (R283) also drops the cheap end; this one keeps everything under 60c and only removes the exact-cap signals, on the live shape (1c under, 60 s, one per window, next window skipped). Also noted this hour, the event lab's Jev sizing: 19 of 19 tennis favourites at 90c+ skipped by Jev, all 19 won (+$4.39 flat); the 3 cricket bets at 67-73c were sized normal, half and skip and went lost, lost, won; Jev-sized net +$3.43 vs flat +$9.49 across the event rules so far." },
  { name: "ahead8-cheap60-15m-first3-maker1-one-gap", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 8, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, rest: 0.01, restSec: 60, familyMaxPerWindow: 1, familySkipNextWindow: true, added: "2026-11-09", idea: "Round 292 (9 Nov 2026 06:10 KST): fresh-day check of the whole maker-1c family on the server paper days 8 and 9 Nov (all coins, $5): 23 of 25 twins are red; the only green ones are the 21-24 KST cut (+$15.4 on 16 trades, none yet on 9 Nov) and the 10 bp trigger (4 trades, +$5.9, fillable 2 trades -$1.4). Every one-per-window and day-cap twin shows the same -$17.8 on 9 Nov (same trades), the plain maker1 -$17.8 to -$57 on 8 Nov, and the live maker's real copy beat them all today (-$2.31 on 11 fills at $3, because max-1-open skipped 9 of its signals). Neither the price cut, the time cut nor the coin cut saved the fresh days; the one dial not yet tried with the live shape is the trigger size. 8 bp (the 10 bp twin has too few trades to judge), one per window, next window skipped." },
  { name: "fav90-bigmove-5m-lead20", left: 0, cap: 0.97, strictCap: true, size: 5, favAt: 0.9, favFrom: 100, favTo: 200, leadMin: 20, minWindowSec: 300, maxWindowSec: 300, added: "2026-11-09", idea: "Round 293 (9 Nov 2026 07:10 KST): the lead bar explains the lead-2 drought. In the same 4 h on the same 7 coins the 15 bp probe (fav90-bigmove-5m-lead15, R288) took 5 paper trades (BTC 1, ETH 2, DOGE 1, HYPE 1), all 5 won, +$0.50 each at $5, while the live 25 bp rule took 0 signals in 8 h (0 real orders on XRP/DOGE/SOL). About 30 a day at 15 bp against 0 at 25 bp on a quiet Sunday night; the replay's 17 a day average came from trend days. Also the lab's other 5m favourite shapes with a small lead (fav93-lead 0-3 bp, fav95-lead) are red on every coin (BTC 770 fillable 91% -$111.8, DOGE -$128, BNB -$369.5): at 93c+ a tiny lead is no edge, only a big one pays. 20 bp sits between the two; the three together give the won-rate curve against the lead size." },
  { name: "fav90-bigmove-5m-one", left: 0, cap: 0.97, strictCap: true, size: 5, favAt: 0.9, favFrom: 100, favTo: 200, leadMin: 25, familyMaxPerWindow: 1, minWindowSec: 300, maxWindowSec: 300, added: "2026-11-09", idea: "Round 294 (9 Nov 2026 08:10 KST): lead 2's first live hour. 07:01-07:38 KST 12 real orders on XRP/DOGE/SOL, all 12 won, +$2.83 in total (8 to 31 cents each); 07:47 DOGE 93c and XRP 90c both lost, -$6.04, net -$3.21 after 14 orders (86% won; break-even at these prices is about 93%). The two losses came in the same 5-minute window on two coins moving together, so one reversal cost two tickets: the same clustering the maker showed (R289, R208). Paper twins in the same hour: 25 bp all coins 27 trades 24 won -$6.42, 15 bp 47/43 -$3.23, 20 bp 16/13 -$9.49. This twin takes one ticket per 5m window across the family (the first coin to qualify), so a market-wide reversal costs one loss, not two or three." },
  { name: "fav94-bigmove-5m", left: 0, cap: 0.97, strictCap: true, size: 5, favAt: 0.94, favFrom: 100, favTo: 200, leadMin: 25, minWindowSec: 300, maxWindowSec: 300, added: "2026-11-09", idea: "Round 295 (9 Nov 2026 09:10 KST): lead 2 after its first two live hours: 20 real orders on XRP/DOGE/SOL, 18 won, -$2.48 (90% won; break-even at these prices is about 93%). By fill price: 94-97c 10 orders, 10 won, +$1.32; 88-93c 10 orders, 8 won, -$3.80. The dearer favourite wins more often than its price falls in payout, so the cheap end of the 90-97c band carries the losses. Paper in the same hours, all 7 coins, fillable: 25 bp 39 trades 35 won -$8.82, 15 bp 76/68 -$14.19, 20 bp 38/33 -$13.19, one-per-window 7/6 -$2.52: every probe sits near 90% won against the replay's 96.6%. This twin lifts the floor to 94c (same 25 bp lead, same 100-200 s window). Ten real fills is a tiny sample; judge on 100+ fillable." },
  { name: "fav90-bigmove-5m-lead40", left: 0, cap: 0.97, strictCap: true, size: 5, favAt: 0.9, favFrom: 100, favTo: 200, leadMin: 40, minWindowSec: 300, maxWindowSec: 300, added: "2026-11-09", idea: "Round 296 (9 Nov 2026 10:15 KST): lead 2 collapsed in its third live hour. 09:16 KST SOL, XRP and DOGE all bought UP at 96-97c with a 25+ bp lead and all three lost (-$9.03); 09:21 XRP and SOL DOWN at 91c lost again. Real total 25 orders 18 won -$17.54 (72% won against a 93% break-even); SOL and XRP hit the 2-loss halt, so the rule goes back to paper (policy). Paper in the same hours, fillable, all coins: 25 bp 48 trades 40 won -$26.96 (83%), 15 bp 113/97 -$40.86, 20 bp 63/52 -$34.65, one-per-window 16/11 -$20.69, 94c floor 8/6 -$8.33. The replay said 96.6% over 267 trades; the first fresh day says 83% on paper and 72% real, and the misses come in clusters where every coin reverses in the same minute. This probe asks whether a much bigger lead (40 bp, about the 5m range on a trend day) still carries the replay's win rate, or whether a 25 bp lead at 100 s was never enough." },
  { name: "mk-early-90to180-r4-30-touch-big3-one-dayhalt3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 810], minWindowSec: 900, maxWindowSec: 900, rest: 0.04, restSec: 30, skipCoins: ["xrp", "doge", "bnb", "hype"], familyMaxPerWindow: 1, familyHaltLosses: 3, added: "2026-11-09", idea: "Round 297 (9 Nov 2026 11:10 KST): with nothing live, a scan of every paper cell on the server: 25 rules meet the bar on all-time fillable trades (100+, 50%+, net > 0), but only ONE is green on each fresh day 7, 8 and 9 Nov: mk-early-90to180-r4-30-touch-big3 (ETH/SOL/BTC, early move, signal 90-180 s into the 15m window, bid 4c under for 30 s): 109 fillable 58.7% won +$41.3, days +9.1 / +9.4 / +30.9. Its siblings that fire in the first 3 minutes went -$20 on 8 Nov and +$30 to +$48 on 9 Nov, while the 1c-under maker on all coins (the live shape until Review 35) lost on both days. The 4c bid on BIG3 was the test shape of 5-6 Nov that faded fresh (R223: in-sample +20% to about 0); the 90-180 s timing cut was never tested with the one-per-window cap and the 3-loss day stop that the live trader uses. Caveat: the paper lab overstates resting fills about 2x (R210), so judge on the server-book replay before any promotion." },
  { name: "ahead5-cheap60-5m-maker2", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [240, 290], minWindowSec: 300, maxWindowSec: 300, familyHaltLosses: 3, rest: 0.02, restSec: 20, restThrough: true, added: "2026-11-04", idea: "the early move on the 5-MINUTE markets, placed as a maker bid 2c under the ask for 20 s (through-fill only), with the 3-loss family day-halt. Round 180 (4 Nov 2026 14:10 KST): the 5m early move was dropped as a taker rule because the 5m books are too thin to buy cheap tickets (every real 5m cheap-ticket test lost), but a resting bid does not need the thin ask side at all. On the 15m markets the maker version has beaten the taker one all day on the server's books (mk-early-first3-r2-30 28/44 +$40.6, dayhalt3-maker1 26/41 +$28.8 vs taker dayhalt3 +$8.7 since 10:00 KST). Also: the 5m feed maker results swing by about $100 an hour (feed3-up60-mid-maker1-thru -$51.9 at 13:00, +$81.1 at 14:00), so feed day numbers say nothing; this tests whether the early-move maker edge carries to 5m windows (first minute, 5+ bps move)." },
  { name: "ahead5-cheap60-5m-maker3", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [240, 290], minWindowSec: 300, maxWindowSec: 300, familyHaltLosses: 3, rest: 0.03, restSec: 20, restThrough: true, added: "2026-11-04", idea: "ahead5-cheap60-5m-maker2 with the bid 3c under the ask instead of 2c. Round 182 (4 Nov 2026 16:10 KST): on the server's own books (not the lagging Mac books the systematic search flagged) the early move as a through-fill maker bid is the lab's best family today: 5m ahead5-cheap60-5m-maker2 29/36 +$80.1 in its first three hours, 15m mk-early-dayhalt3-r3-30 37/54 +$70.8, mk-early-first3-r2-30 47/72 +$69.7, against the taker ahead5-cheap60-15m-dayhalt3 178/296 +$36.0 all-time. One day only, and the search thread found model-signal bids -1% to -11% over 15 days, so this is a probe: does a deeper bid keep the 5m win rate (81%) at a better price or just fill the losers." },
  { name: "ahead5-cheap60-15m-binlead-maker2", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, aheadXchgLead: [-99, -1], rest: 0.02, restSec: 30, restThrough: true, added: "2026-11-04", idea: "the best taker gate on the early move (binlead: Binance 1+ bps further toward our side than its usual spread to Coinbase) placed as the maker thread's bid 2c under the ask for 30 s, through-fill only. Round 179 (4 Nov 2026 13:10 KST): binlead is now the strongest taker early-move rule on the server, 126/211 +$48.3 fillable (+$23 since 08:00 KST), ahead of dayhalt3 159/266 +$29.4, and the plain maker version of the whole family keeps beating the taker one over the same hours (mk-early-first3-r2-30 19/29 +$33.8, mk-early-first3-r3-30 16/26 +$21.0, dayhalt3-maker1 19/31 +$15.8). This stacks the two. Judge against binlead and mk-early-first3-r2-30." },
  { name: "ahead5-cheap60-15m-dayhalt3-maker3-60", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, rest: 0.03, restSec: 60, restThrough: true, added: "2026-11-04", idea: "the maker thread's mk-early-dayhalt3-r3-30 (bid 3c under the early-move ask, through-fill only) left resting 60 s instead of 30. Round 178 (4 Nov 2026 12:10 KST): on the early move the maker side is beating the taker side on the server's own books today: mk-early-dayhalt3-r3-30 11/14 +$34.1, ahead5-cheap60-15m-dayhalt3-maker1 14/20 +$27.3, -maker2 12/17 +$23.6, while the taker dayhalt3 added +$18 over the same hours (139/233 -> 153/254). On the feed it is the opposite: feed3-up60-mid-maker1 29/72 -$54.6 and its through-fill twin 9/35 -$82.2 (round 177's early green was noise). And the live dayhalt3 taker missed 9 of 11 orders today because the signal asks sat at 59-60c, over its 56c cap, so a resting bid is also the only way the live rule gets filled at a good price. Live has the plumbing (chaseSec/restUntilLeft rest a limit at the cap); Review 16 candidate. Judge fill count, won % and net against r3-30." },
  { name: "ahead5-cheap60-15m-dayhalt3-maker2", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, rest: 0.02, restSec: 60, added: "2026-11-04", idea: "ahead5-cheap60-15m-dayhalt3-maker1 resting 2c under the ask (round 176)." },
  { name: "feed3-up60-mid-maker1-thru-5m-alts", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", rest: 0.01, restSec: 30, restThrough: true, maxWindowSec: 300, skipCoins: ["btc", "eth", "bnb"], familyHaltLosses: 3, added: "2026-11-04", idea: "feed3-up60-mid-maker1-thru only on the 5-minute SOL, XRP, DOGE and HYPE markets, with the 3-loss family day-halt. Round 181 (4 Nov 2026 15:10 KST): the feed maker's gain sits exactly where the feed TAKER bleeds most. feed3-up60-mid-maker1-thru by market: 5m SOL 17/25 +$51.3, XRP 13/16 +$52.3, DOGE 16/25 +$33.1, HYPE 16/25 +$31.2 (62/91 +$168), against 5m BTC 5/9 +$9.5, ETH 11/22 +$0.7, BNB 4/8 +$2.4 and the 15m markets 32/65 +$3.8 in all; the same signal taken at the ask on those four 5m alts is the lab's worst cell (fillable SOL -$98, XRP -$111, DOGE -$135, HYPE -$290). Reading: on thin alt books the ask the feed signal sees is often stale or about to be pulled, so a taker pays the worst price, while a bid that only fills when sellers trade through it buys from the late sellers instead. It has swung by $100+ an hour (-$82 at 12:00, +$214 at 15:00), so judge only on several days." },
  { name: "feed3-up60-mid-maker1-thru-1h", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", rest: 0.01, restSec: 30, restThrough: true, minWindowSec: 3600, maxWindowSec: 3600, added: "2026-11-04", idea: "feed3-up60-mid-maker1-thru on the 1-HOUR markets only, so their record is kept apart from the 5m noise. Round 188 (4 Nov 2026 22:10 KST): round 181's market pick did not hold. At 15:10 KST the feed maker's 5m SOL/XRP/DOGE/HYPE stood at 62/91 +$168; at 22:00 they are 100/183 +$87.1, i.e. 38/92 41% -$81 out of sample in seven hours (HYPE 27/55 -$17.8 now, XRP 19/34, SOL 25/48 +$17.0), and the dedicated 5m-alts variant is 27/52 +$9.1. The second one-day market pick in a row to fade (round 183: maker coin ranking flips). The only cells still clearly green are the small 1h markets: 25/36 69% +$78.4 across seven coins (BTC 3/3 +$20.3, ETH 4/5 +$18.9, SOL 5/7 +$17.6, DOGE 5/7 +$14.9). A small sample (MEMORY: 1h+ has too few windows) and picked from the same day, so this is a watch-list entry: judge only after 100 fillable trades." },
  { name: "feed3-up60-mid-maker1-long", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", rest: 0.01, restSec: 30, minWindowSec: 14400, added: "2026-11-05", idea: "the BTC-feed signal as a 1c-under maker bid (touch fill) on the 4-HOUR and 24-HOUR markets only. Round 191 (5 Nov 2026 01:10 KST), the whole server lab's fillable results by window length: 5m 237,695 trades -$140,286 (-$0.59 a trade, 159 of 1,112 rule-market cells green), 15m 124,230 -$56,034 (-$0.45, 452/1,782 green), 1h 24,409 -$26,100 (-$1.07, 210/852), but 4h 2,069 trades +$58 (+$0.03, 248/542 green) and 24h 1,272 -$66 (-$0.05, 314/555 green). The long markets are the only place the lab as a whole breaks even, i.e. the only place the market price is not clearly beating our rules after the fee. The taker feed signal there is 43/83 -$11.2 and the through-fill maker version never fills on them, so this tries the touch-fill bid. Few windows: judge only on 100 fillable trades." },
  { name: "feed3-up60-mid-maker1-thru-eth", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", rest: 0.01, restSec: 30, restThrough: true, skipCoins: ["btc", "sol", "xrp", "doge", "bnb", "hype"], added: "2026-11-05", idea: "feed3-up60-mid-maker1-thru on ETH markets only (5m, 15m, 1h). Round 193 (5 Nov 2026 03:10 KST): unlike round 183's one-day coin ranking, a coin's cost across ALL lab rules and all days is stable. Fillable loss per trade by coin: ETH is the cheapest coin at every length (15m -$0.27, 1h -$0.29, 5m -$0.31) with the most green rule cells (15m 93/256, 1h 45/128, 5m 43/157); HYPE the dearest (15m -$0.57, 1h -$2.29, 5m -$0.96; 5m green 7/159), then XRP 15m -$0.78 and DOGE 15m -$0.62. ETH has the deepest books after BTC, so less of each trade goes to the spread and to stale asks. ETH's feed maker cells are currently 5m 19/36 +$14.8, 15m 8/19 -$14.9, 1h 6/7 +$29.7. A coin filter chosen from 7 days of every rule is a structural choice, not a one-day pick; judge on 100 fillable trades." },
  { name: "feed3-up60-mid-maker1-thru", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", rest: 0.01, restSec: 30, restThrough: true, added: "2026-11-04", idea: "feed3-up60-mid-maker1 with the stricter through-fill (the ask must go strictly below the bid, the maker thread's restThrough) so the queue position is not assumed. Round 177 (4 Nov 2026 11:10 KST): in the first hours the touch-fill maker twin of the BTC feed rule is the only green feed variant: feed3-up60-mid-maker1 16/33 +$5.96 fillable while the same signal taken at the ask (feed3-up60-mid-halt2h) went 10/36 -$83.61 over the same span. A touch fill is the optimistic case (we would be behind the resting size at that price), so this twin tells how much of the gap survives a realistic fill." },
  { name: "feed3-up60-mid-maker1", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", rest: 0.01, restSec: 30, added: "2026-11-04", idea: "maker twin of feed3-up60-mid (the BTC 5m feed rule, back on paper at Review 15): rest a bid 1c under the signal ask for 30 s, no fee, filled only if the ask comes down to it (round 176; see ahead5-cheap60-15m-dayhalt3-maker1). The feed's missed tickets win more than its fills (makers pull the ask when the signal is right), so expect a low fill rate on the winners." },
  { name: "fav91-92-15m-late-pm-maker1", left: 0, cap: 0.92, size: 5, favAt: 0.91, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [6, 12], rest: 0.01, restSec: 30, added: "2026-11-04", idea: "maker twin of fav91-92-15m-late-pm (the 15m late favourite, back on paper at Review 15): rest a bid 1c under the 91-92c ask for 30 s, no fee (round 176). At 91c the taker fee is only about 0.6% of the stake, so the maker gain is mostly the 1c of price; R157 found favourites filled while the ask was falling lost (6/10 -$14), which is exactly when this bid fills." },
  { name: "feed3-up60-mid-halt2h", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", familyHaltLosses: 3, familyHaltMin: 120, added: "2026-11-04", idea: "feed3-up60-mid with a 2-HOUR family pause after 3 straight losses across all coins, instead of the rest of the KST day. Round 175 (4 Nov 2026 09:10 KST): the feed's losses come in short blow-ups and it recovers in between, so a day-long halt throws away the good hours. feed3-up56-mid fillable: about -$147 between 23:00 and 01:00 KST, then +$64 between 04:00 and 08:00 KST (-$201.6 -> -$137.8), then -$35.8 in 08:00-09:00 KST (-> -$173.6). The day-halted twins (feed3-up60-mid-one, pulled3-one) went from +$20.4 / +$17.9 to -$2.9 / -$7.9 in that last hour and now sit out until midnight; one ticket per window did not help in this blow-up (the losses came in consecutive windows, not on many coins at once). New familyHaltMin option. Judge against feed3-up60-mid-dayhalt3 and the base on fillable net and worst hour." },
  { name: "ahead5-cheap60-15m-dayhalt2", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 2, added: "2026-11-04", idea: "ahead5-cheap60-15m-dayhalt3 with the family day-halt after 2 straight losses instead of 3. Round 173 (4 Nov 2026 07:10 KST): the early-move family moves day by day as one block and the only thing that has added value is the stop. Base first3 by KST day: 31 Oct -$40, 1 Nov -$86, 2 Nov -$258, 3 Nov -$118, then 4 Nov 57/84 68% +$61 so far; every gate follows the day (binlead 3 Nov -$23.3 then 4 Nov +$34.7, break -$22.9 then +$4.4). The stop is monotone so far: dayhalt5 fillable 132/226 +$5.5 (on 4 Nov it never tripped and matched the base trade for trade), dayhalt3 130/213 +$44.2 (3 Nov +$2.2 against the base's -$118). This tests one notch tighter: it gives up more of a green day and should cut more of a red one. Judge against dayhalt3 on fillable net and red days." },
  { name: "ahead5-cheap60-15m-dayhalt3-one", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, familyMaxPerWindow: 1, added: "2026-11-04", idea: "ahead5-cheap60-15m-dayhalt3 (the lab leader) buying only the FIRST coin to signal in each 15m window. Round 171 (4 Nov 2026 05:10 KST): even the early move's halt is beaten by same-window clusters. In the hour to 05:00 KST dayhalt3 and its base first3 lost the same 2/7 -$18.8 (dayhalt3 4 Nov 33/44 +$60.4 -> 35/51 +$41.6; fillable +$70.8 -> +$48.3), i.e. five coins lost in one or two windows before any 3-loss streak could stop the family, because their tickets were all bought before the first one settled. Round 170 found the same on the feed (dayhalt3 saved nothing). One ticket per window turns a market-wide move into one bet and lets the halt count windows, not coins. Twin ahead5-cheap60-15m-dayhalt3-two allows 2 per window. Judge both against dayhalt3 on fillable net AND the size of the worst hour." },
  { name: "ahead5-cheap60-15m-dayhalt3-two", left: 0, cap: 0.6, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [720, 870], minWindowSec: 900, maxWindowSec: 900, familyHaltLosses: 3, familyMaxPerWindow: 2, added: "2026-11-04", idea: "ahead5-cheap60-15m-dayhalt3-one with up to 2 coins per window (round 171)." },
  { name: "feed3-up60-mid-one", left: 0, cap: 0.6, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", familyMaxPerWindow: 1, familyHaltLosses: 3, added: "2026-11-04", idea: "feed3-up60-mid with one coin per window across the family plus the 3-loss family day-halt. Round 170: see feed3-up60-mid-pulled3-one." },
  { name: "fav91-92-15m-late-pm-up", left: 0, cap: 0.92, size: 5, favAt: 0.91, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, hoursUtc: [6, 12], onlySide: "UP", added: "2026-11-04", idea: "the live favourite rule exactly as it trades now (15-21 KST, 91-92c, fav91-92-15m-late-pm) but UP only. Round 172 (4 Nov 2026 06:10 KST): round 169's side split held out of sample. On 4 Nov (KST) the lab's fav91-15m-late-wide went 45/50 -$6.4 in all, of which UP (fav91-15m-late-up) 10/10 +$4.3 and so DOWN 35/40 87.5% -$10.7; real 15m favourite fills since 2 Nov were UP 18/20 -$1.16 vs DOWN 19/24 -$15.75. The live rule's own paper twin fav91-15m-late-pm is 34/41 83% -$21.5 fillable (real 16/18 about -$1.9), so the favourite family is only near break-even where it buys the rising side. This is the form a review could put live; judge it against fav91-92-15m-late-pm on the fillable column." },
  { name: "fav91-15m-late-up", left: 0, cap: 0.92, size: 5, favAt: 0.91, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, onlySide: "UP", added: "2026-11-04", idea: "fav91-15m-late-wide (any hour, 91-92c) on the UP side only. Round 169 (4 Nov 2026 03:10 KST): the server's 44 settled real 15m favourite fills since 2 Nov split by side: UP 18/20 90% -$1.16, DOWN 19/24 79% -$15.75; DOWN lost on both days (2 Nov 12/16 -$13.62, 3 Nov 7/8 -$2.13) and ETH DOWN is the worst cell (8/11 -$11.45 vs ETH UP 5/5 +$2.32). A falling coin's favourite reverts more often than a rising one's. Small sample: judge against fav91-15m-late-wide on the fillable column over several days before any live change." },
  { name: "fav91-15m-late-alone", left: 0, cap: 0.93, size: 5, favAt: 0.91, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, favBreadthMax: 0, added: "2026-11-03", idea: "fav91-15m-late-wide (any hour, 91-93c) only when NO other coin's 15m window shows a 91c+ favourite on the same side at the 3-minute mark, i.e. the favourite is alone. Round 158 (3 Nov 2026): the server's real 15m favourite fills grouped by window: a favourite that fired alone won 6/6 +$2.52, one that fired with another coin's favourite on the same side won 14/18 78% -$10.43 (split-side windows 10/12 -$6.22); 5m alike, alone 18/20 -$4.11 vs crowd 9/12 -$9.21; the first live 91c session (15:42 KST) bought BTC and DOGE UP together and DOGE lost. The server lab says the same on 178 fillable fav88-15m-late-asia trades: with company (fav88-15m-late-asia-company, favBreadthMin 1) 77/91 85% -$34.2, without it 78/87 90% -$5.8. This reverses round 118's 20-30 Oct replay (alone 90.6%, company 96.3%): live, a crowd of favourites is one market-wide bet, and the alt that reached 91c only because the whole market moved is the one that reverts. New favBreadthMax option. Judge against fav91-15m-late-wide on the fillable column; if it holds, the live fav91 rule is the candidate for this gate." },
  { name: "fav88-15m-late-alone", left: 0, cap: 0.93, size: 5, favAt: 0.88, favFrom: 240, favTo: 280, minOverround: 1.015, minWindowSec: 900, maxWindowSec: 900, favBreadthMax: 0, added: "2026-11-03", idea: "The 88c+ 15m late favourite (any hour) only when no other coin's 15m favourite is 88c+ on the same side at the 3-minute mark: the bigger-sample twin of fav91-15m-late-alone (round 158), so the solo-vs-crowd split reaches 100 fillable trades sooner. See fav91-15m-late-alone for the numbers." },
  { name: "ahead5-cheap56-15m-first60", left: 0, cap: 0.56, minAsk: 0.35, size: 5, aheadBp: 5, flatLeft: [840, 870], minWindowSec: 900, maxWindowSec: 900, added: "2026-11-03", idea: "ahead5-cheap60-15m-first60 with the cap lowered from 60c to 56c. Round 157 (3 Nov 2026): the server's settled real fills graded by the price actually PAID (the live rules chase up to their 60c limit): early move paid 50-56c 11/16 69% +$11.63 against paid 56-60c 22/43 51% -$20.55 (break-even at 58c is 61%); BTC feed paid under 50c 10/17 +$14.54, 50-56c 6/10 +$2.92, 56-60c 4/9 44% -$7.28. Both live rules together: fills that landed at 56-60c 26/52 50% -$27.83, fills under 56c 29/47 62% +$29.43, so the last 4c of the 60c limit is where the real money has leaked. By signal ask the split is flat (early 52-60c 32/56 57%), so it is the chase into 56-60c, not the signal, that hurts. The lab fills at the signal ask, so this twin measures the signal-ask side of the cut; for the live rule the lever is the order limit (Review 12 item: 60c -> 56c on ETH first60 and BTC feed). Judge against ahead5-cheap60-15m-first60 on the fillable column." },
  { name: "feed3-up56-mid", left: 0, cap: 0.56, minAsk: 0.4, size: 5, feedLeadBp: 3, jumpMinLeft: 120, onlySide: "UP", added: "2026-11-03", idea: "feed3-up60-mid with the cap lowered from 60c to 56c, the feed twin of ahead5-cheap56-15m-first60 (round 157, 3 Nov 2026): on the real BTC feed fills the price paid decides, under 56c 16/27 59% +$17.46, 56-60c 4/9 44% -$7.28. Judge against feed3-up60-mid per series on the fillable column." },
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
/** The run of same-way closes ending at the previous window (k = 1 when only that window closed that way), stopping at the first unseen, tied or opposite window and capped at 6; null when the previous window's close was not seen. */
function prevRun(prefix: string, window: number, windowSec: number): { k: number; up: boolean } | null {
  const m = closeBook.get(prefix);
  const last = m?.get(window - windowSec)?.up;
  if (last == null) return null;
  let k = 1;
  while (k < 6) {
    const c = m!.get(window - windowSec * (k + 1))?.up;
    if (c == null || c !== last) break;
    k++;
  }
  return { k, up: last };
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
  latestBook.set(prefix, { t: row.t, window: row.window, up: row.upAsks[0]?.[0] ?? null, down: row.downAsks[0]?.[0] ?? null });
  {
    const upP = row.upAsks[0]?.[0] ?? null, downP = row.downAsks[0]?.[0] ?? null;
    const prev = askSince.get(prefix);
    askSince.set(prefix, { up: upP, down: downP, upT: prev && prev.up === upP ? prev.upT : row.t, downT: prev && prev.down === downP ? prev.downT : row.t });
  }
  if (row.left >= windowSec - 15) {
    const ob = openBook.get(prefix);
    if (!ob || ob.window !== row.window) openBook.set(prefix, { window: row.window, up: row.upAsks[0]?.[0] ?? null, down: row.downAsks[0]?.[0] ?? null });
  }
  const px = row.binance ?? row.chainlink;
  if (px) {
    const wr = winRange.get(prefix);
    if (!wr || wr.window !== row.window) {
      if (wr && wr.window < row.window) prevWinRange.set(prefix, { window: wr.window, bps: ((wr.hi - wr.lo) / wr.open) * 1e4, hi: wr.hi, lo: wr.lo });
      winRange.set(prefix, { window: row.window, open: px, hi: px, lo: px, hi2: px, lo2: px });
    } else {
      if (px > wr.hi) wr.hi = px;
      if (px < wr.lo) wr.lo = px;
      if (row.left >= windowSec - 120) {
        if (px > wr.hi2) wr.hi2 = px;
        if (px < wr.lo2) wr.lo2 = px;
      }
    }
  }
}
/** The coin of a series prefix ("" is BTC 5m, "eth15m-" is ETH), for per-coin options such as aheadBpBy. */
function coinOf(prefix: string): string {
  return prefix === "" ? "btc" : prefix.replace(/\d.*$/, "");
}
/** How many OTHER series of the same window length moved `bp`+ bps from their open in the given direction within the last 3 s (crossAheadBp rule). */
function crossAheads(prefix: string, t: number, windowSec: number, bp: number, up: boolean): number {
  let n = 0;
  for (const [k, v] of latestAhead) if (k !== prefix && v.windowSec === windowSec && t - v.t <= 3000 && (up ? v.move >= bp : -v.move >= bp)) n++;
  return n;
}
/** Fine round price levels per coin for the roundBp rule (the grid the replay used). */
const ROUND_GRID: Record<string, number> = { btc: 100, eth: 10, sol: 1, xrp: 0.01, doge: 0.001, bnb: 5, hype: 1 };
/** Coarse round price levels per coin for the aheadRoundClearBp gate (round 126). */
const COARSE_GRID: Record<string, number> = { btc: 500, eth: 50, sol: 5, xrp: 0.05, doge: 0.005, bnb: 25, hype: 0.5 };
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
/** Latest best asks per series prefix, for cross-window gates such as favShortMin (round 119). */
const latestBook = new Map<string, { t: number; window: number; up: number | null; down: number | null }>();
/** When each side's best-ask price last changed per series prefix, for the aheadAskStaleSec gate (round 137). */
const askSince = new Map<string, { up: number | null; down: number | null; upT: number; downT: number }>();
/** Best asks on the first row of each window per series (first 15 s), for the aheadOpenAsk gate (round 128). */
const openBook = new Map<string, { window: number; up: number | null; down: number | null }>();
/** Running high/low of the current window per series and the finished previous window's range (bps), from the Binance print on each row (round 127). */
/** This window's Binance (Chainlink fallback) open, high and low per series prefix; hi2/lo2 are the high and low of the first 2 minutes only (round 143 pullback rule). */
const winRange = new Map<string, { window: number; open: number; hi: number; lo: number; hi2: number; lo2: number }>();
const prevWinRange = new Map<string, { window: number; bps: number; hi: number; lo: number }>();
/** Median 15m window range per coin (Binance 1-min high minus low, bps of the open; 1,859 windows per coin, 14 days to 30 Oct 2026, round 127). */
const MEDIAN_RANGE_15M: Record<string, number> = { btc: 17.6, eth: 26.0, sol: 31.6, xrp: 30.8, doge: 32.1, bnb: 20.2, hype: 41.1 };
/** Each 5m series' latest Chainlink move from the window open (bps), for the btcAheadBp rule. */
const latestAhead = new Map<string, { t: number; move: number; windowSec: number }>();
/** Round 135: resolved early-move outcomes across all series (one per series and window, in settlement order) for the aheadRegime gate. */
const aheadLog: { key: string; end: number; won: boolean }[] = [];
/** familyHaltLosses: loss streak of a variant across every series and the time its family day-halt lifts (next KST midnight).
 *  Round 234 (6 Nov 2026): kept in data/paper-family-halts.json. It was memory-only, so every deploy (one an hour)
 *  wiped a tripped halt: the test twin lost 3 straight by 17:46 KST, the 18:09 deploy cleared it and it traded at 18:45. */
const FAMILY_PAPER_FILE = "paper-family-halts.json";
const familyStreak = new Map<string, { streak: number; haltUntil: number; lastWindow?: number }>(Object.entries(loadJson<Record<string, { streak: number; haltUntil: number; lastWindow?: number }>>(FAMILY_PAPER_FILE, {})));
function saveFamilyStreak(): void {
  saveJson(FAMILY_PAPER_FILE, Object.fromEntries(familyStreak));
}
/** One-shot day-stop resets, applied once at start-up (the server restarts on every deploy). 7 Nov 2026 11:49 KST,
 *  enrique on going live: "are u kidding, i want it to trade" — the paper/dry day stops tripped this morning would have
 *  kept both live rules silent until midnight. Clears the paper family halt and the live family streak for each rule;
 *  the 3-loss stop counts again from here. */
const DAY_STOP_RESETS: Record<string, string> = {
  "ahead5-cheap60-15m-dayhalt3-big3-down-one": "2026-11-07T02:50:00Z",
  "ahead5-cheap60-15m-dayhalt3": "2026-11-07T02:50:00Z",
};
{
  const done = loadJson<Record<string, string>>("day-stop-resets-done.json", {});
  const live = loadJson<Record<string, unknown>>("live-family-halts.json", {});
  let changed = false;
  for (const [name, at] of Object.entries(DAY_STOP_RESETS)) {
    if (done[name] === at || Date.now() < Date.parse(at)) continue;
    familyStreak.delete(name);
    delete live[name];
    done[name] = at;
    changed = true;
    console.log(`paper: day stop of ${name} reset (${at})`);
  }
  // 7 Nov 15:10 KST: the live rules moved to the paper twins WITHOUT the paper day stop (only real losses stop them);
  // carry today's real loss streak over to the new names once.
  const moves: [string, string][] = [["ahead5-cheap60-15m-dayhalt3", "ahead5-cheap60-15m-first3"], ["ahead5-cheap60-15m-dayhalt3-big3-down-one", "ahead5-cheap60-15m-big3-down-one"]];
  for (const [from, to] of moves) {
    const key = `move:${from}`;
    if (done[key]) continue;
    if (live[from] && !live[to]) live[to] = live[from];
    done[key] = to;
    changed = true;
  }
  // 7 Nov 15:30 KST (enrique: "does this look right?"): the by-rule table showed "—" today and BNB first3 "halted 00:19"
  // (an old halt from when first3 was live on 31 Oct-3 Nov). Re-label today's real rows (since go-live 02:44Z) to the new
  // names so per-rule today/loss stops see them, and give each series' new name the old name's halt state (or a clean one).
  if (!done["relabel:2026-11-07"]) {
    const since = Date.parse("2026-11-07T02:44:00Z");
    for (const s of SERIES) {
      const pre = prefixOf(s);
      for (const f of [`${pre}live-totals.json`, `${pre}live-open.json`]) {
        const rows = loadJson<{ t?: number; variant?: string }[]>(f, []);
        let n = 0;
        for (const r of rows) for (const [from, to] of moves) if (r.variant === from && (r.t ?? 0) >= since) (r.variant = to), n++;
        if (n) saveJson(f, rows);
      }
      const halts = loadJson<Record<string, unknown>>(`${pre}live-halts.json`, {});
      let hc = false;
      for (const [from, to] of moves) {
        const old = halts[from] as { halted?: boolean; haltedAt?: number | null } | undefined;
        if (old) halts[to] = old.halted && (old.haltedAt ?? 0) < since ? { ...old, halted: false, haltedAt: null, streak: 0 } : old;
        else if (halts[to]) halts[to] = { streak: 0, halted: false, haltedAt: null };
        else continue;
        hc = true;
      }
      if (hc) saveJson(`${pre}live-halts.json`, halts);
    }
    done["relabel:2026-11-07"] = "done";
    changed = true;
  }
  if (changed) {
    saveFamilyStreak();
    saveJson("live-family-halts.json", live);
    saveJson("day-stop-resets-done.json", done);
  }
}
/** familyMaxPerWindow: entries taken by a variant in the current window, per window length. */
const familyWindowTaken = new Map<string, { window: number; n: number }>();
function nextKstMidnight(t: number): number {
  const d = new Date(t + 9 * 3600 * 1000);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime() - 9 * 3600 * 1000;
}
function aheadRegimeRate(t: number, n: number, maxAgeMs = 7200000): number | null {
  const xs = aheadLog.filter((x) => x.end <= t && t - x.end <= maxAgeMs).slice(-n);
  if (xs.length < n) return null;
  return xs.filter((x) => x.won).length / xs.length;
}
/** Round 198 (5 Nov 2026): paper net per variant per KST day across every series (rebuilt from the totals files at start), for prevDayGreenOf. */
const familyDayNet = new Map<string, number>();
/** Net per series, variant and KST day ("prefix|name|day"), for prevDayCoinGreenOf (round 280). */
const coinDayNet = new Map<string, number>();
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
/** Chainlink move from the window's open (bps) at minutes 1.5-2.5 of each window, per series: the window's own early move (favEarly rule, round 108). */
const earlyMove = new Map<string, number>();
function noteEarlyMove(prefix: string, row: BookRow, windowSec: number) {
  const k = `${prefix}|${row.window}`;
  if (earlyMove.has(k) || row.chainlink == null || !row.open || row.left > windowSec - 90 || row.left < windowSec - 150) return;
  earlyMove.set(k, ((row.chainlink - row.open) / row.open) * 1e4);
  if (earlyMove.size > 500) earlyMove.delete(earlyMove.keys().next().value!);
}
/** The book favourite's best ask with a fifth of the window left (3 min on 15m), per series and window: how decided the window was late (prevLate rule, round 109). */
const lateFav = new Map<string, number>();
/** Side and window length of each lateFav note, for the favBreadthMin gate (round 118). */
const lateFavSide = new Map<string, { up: boolean; windowSec: number }>();
function noteLateFav(prefix: string, row: BookRow, windowSec: number) {
  const k = `${prefix}|${row.window}`;
  const mark = windowSec * 0.2;
  if (lateFav.has(k) || Math.abs(row.left - mark) > 15) return;
  const u = row.upAsks[0]?.[0];
  const d = row.downAsks[0]?.[0];
  if (u == null || d == null) return;
  lateFav.set(k, Math.max(u, d));
  lateFavSide.set(k, { up: u >= d, windowSec });
  if (lateFav.size > 500) lateFav.delete(lateFav.keys().next().value!);
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
  private resting: { window: number; up: boolean; price: number; t0?: number } | null = null;
  /** Armed early-move trigger awaiting confirmation (confirmSec rule, round 122). */
  private armed: { window: number; up: boolean; ask0: number; t0: number; note: string } | null = null;
  private armedDone = -1;
  /** coolMin: time of this rule's last signal on this series and the window it fell in. */
  private lastSig: number | null = null;
  private lastSigWindow = -1;
  /** Per-window minimum best ask of each side over the favDipLeft span (favDipBelow rule, round 123). */
  private favDip = { window: -1, up: 1, down: 1 };
  /** Trades taken today (KST) on this series, for the maxPerDay quota (round 151). */
  private dayTaken: { day: string | null; n: number } = { day: null, n: 0 };
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
    familyDayNet.set(`${this.v.name}|${day}`, (familyDayNet.get(`${this.v.name}|${day}`) ?? 0) + t.pnl);
    coinDayNet.set(`${this.prefix}|${this.v.name}|${day}`, (coinDayNet.get(`${this.prefix}|${this.v.name}|${day}`) ?? 0) + t.pnl);
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
    noteEarlyMove(this.prefix, row, this.windowSec);
    noteLateFav(this.prefix, row, this.windowSec);
    this.prevAsk = { window: row.window, up: row.upAsk, down: row.downAsk };
    if (row.upAsk != null && row.downAsk != null) latestLean.set(this.prefix, { window: row.window, up: row.upAsk > row.downAsk ? true : row.downAsk > row.upAsk ? false : null });
    if (this.resting && (this.resting.window !== row.window || row.left < 1 || (this.v.restSec != null && this.resting.t0 != null && row.t - this.resting.t0 > this.v.restSec * 1000))) this.resting = null;
    if (this.resting) {
      const best = (this.resting.up ? row.upAsks : row.downAsks)[0]?.[0];
      if (best != null && (this.v.restThrough ? best < this.resting.price - 1e-9 : best <= this.resting.price + 1e-9)) {
        const r = this.resting;
        this.resting = null;
        this.book(row, r.up, r.price, SIZE / r.price, SIZE, 0, this.v.restThrough ? true : undefined);
      }
      return;
    }
    if (this.armed && (this.armed.window !== row.window || row.left < 1)) this.armed = null;
    if (this.armed) {
      const a = this.armed;
      const best = (a.up ? row.upAsks : row.downAsks)[0]?.[0];
      if (best == null) return;
      if (best <= a.ask0 - (this.v.confirmDipC ?? 0.03) + 1e-9) {
        this.armed = null;
        this.armedDone = row.window;
        return;
      }
      if (this.v.pulledChaseC != null) {
        if (best > a.ask0 + 1e-9) {
          this.armed = null;
          this.armedDone = row.window;
          const cap = Math.min(this.v.confirmCap ?? this.v.cap, a.ask0 + this.v.pulledChaseC / 100);
          if (best <= cap + 1e-9) this.take(row, { up: a.up, ask: best }, cap, this.v.size, `${a.note}; the ${(a.ask0 * 100).toFixed(0)}c ask was pulled after ${((row.t - a.t0) / 1000).toFixed(1)} s, chasing at ${(best * 100).toFixed(0)}c`);
          return;
        }
        if (row.t - a.t0 >= (this.v.confirmSec ?? 0) * 1000) {
          this.armed = null;
          this.armedDone = row.window;
        }
        return;
      }
      if (row.t - a.t0 >= (this.v.confirmSec ?? 0) * 1000) {
        this.armed = null;
        this.armedDone = row.window;
        const cap = this.v.confirmCap ?? this.v.cap;
        if (best <= cap + 1e-9) this.take(row, { up: a.up, ask: best }, cap, this.v.size, `${a.note}; ask held ${Math.round((row.t - a.t0) / 1000)} s without a ${Math.round((this.v.confirmDipC ?? 0.03) * 100)}c dip, taking ${(best * 100).toFixed(0)}c`);
      }
      return;
    }
    if (this.armedDone === row.window) return;
    if (!this.gateOk(row)) return;
    if (this.v.aheadFromSeries != null) return this.considerAheadFrom(row);
    if (this.v.arbSum != null) return this.considerArb(row);
    if (this.v.prevDir != null) return this.considerPrev(row);
    if (this.v.feedLeadBp != null || this.v.crossLeadBp != null) return this.considerFeed(row);
    if (this.v.binMoveBp != null) return this.considerBinMove(row);
    if (this.v.basisBp != null) return this.considerBasis(row);
    if (this.v.roundBp != null) return this.considerRound(row);
    if (this.v.flatBp != null) return this.considerFlat(row);
    if (this.v.pullbackBp != null) return this.considerPullback(row);
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
    if (this.v.aheadBp != null && this.v.crossAheadBp == null && trade.won != null) {
      const key = `${this.prefix}|${window}`;
      if (!aheadLog.some((x) => x.key === key)) {
        aheadLog.push({ key, end: (window + this.windowSec) * 1000, won: trade.won });
        if (aheadLog.length > 200) aheadLog.splice(0, aheadLog.length - 200);
      }
    }
    if (this.v.selfHaltLosses != null) {
      this.lossStreak = trade.won ? 0 : this.lossStreak + 1;
      if (this.lossStreak >= this.v.selfHaltLosses) {
        this.haltUntil = (window + this.windowSec) * 1000 + (this.v.selfHaltMin ?? 30) * 60000;
        this.lossStreak = 0;
      }
    }
    if (this.v.familyHaltLosses != null && trade.won != null) {
      const f: { streak: number; haltUntil: number; lastWindow?: number } = familyStreak.get(this.v.name) ?? { streak: 0, haltUntil: 0 };
      const sameWindow = this.v.familyStreakPerWindow && f.lastWindow === window;
      f.lastWindow = window;
      if (!sameWindow) f.streak = trade.won ? 0 : f.streak + 1;
      if (f.streak >= this.v.familyHaltLosses) {
        f.haltUntil = this.v.familyHaltMin != null ? (window + this.windowSec) * 1000 + this.v.familyHaltMin * 60000 : nextKstMidnight((window + this.windowSec) * 1000);
        f.streak = 0;
        console.log(`paper ${this.v.name}: ${this.v.familyHaltLosses} straight losses across the family, sitting out until KST midnight`);
      }
      familyStreak.set(this.v.name, f);
      saveFamilyStreak();
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
    if (this.v.skipHourClose && (row.window + this.windowSec) % 3600 === 0) return false;
    if (this.v.hoursUtc) {
      const h = new Date(row.t).getUTCHours();
      const [from, to] = this.v.hoursUtc;
      if (from <= to ? h < from || h >= to : h < from && h >= to) return false;
    }
    if (this.v.skipHoursUtc && this.v.skipHoursUtc.includes(new Date(row.t).getUTCHours())) return false;
    if (this.v.prevDayGreenOf && !((familyDayNet.get(`${this.v.prevDayGreenOf}|${kstDay(row.t - 86400000)}`) ?? 0) > 0)) return false;
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
    if (this.v.quarters && !this.v.quarters.includes(Math.floor((row.window % 3600) / 900))) return false;
    if (this.v.skipCoins?.includes(this.prefix.replace(/\d+[mh]-$/, "") || "btc")) return false;
    if (this.v.trailN != null) {
      const s = trailSum(this.v.trailOf ?? this.v.name, this.v.trailN);
      if (s == null || s <= (this.v.trailMin ?? 0)) return false;
    }
    if (this.v.selfHaltLosses != null && row.t < this.haltUntil) return false;
    if (this.v.familyHaltLosses != null) {
      const f = familyStreak.get(this.v.name);
      if (f && row.t < f.haltUntil) return false;
    }
    if (this.v.maxPerDay != null && this.dayTaken.day === kstDay(row.t) && this.dayTaken.n >= this.v.maxPerDay) return false;
    if (this.v.prevDayCoinGreenOf != null && !((coinDayNet.get(`${this.prefix}|${this.v.prevDayCoinGreenOf}|${kstDay(row.t - 86400_000)}`) ?? 0) > 0)) return false;
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
  private book(row: BookRow, up: boolean, ask: number, shares: number, cost: number, fee: number, fillable?: boolean) {
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
    if (fillable != null) trade.fillable = fillable;
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

  /** Round 143 (3 Nov 2026): the pullback re-entry. A 5+ bps breakout in the first 2 minutes that has come back to the open by minutes 3-5 still resolves its way about 55% of the time while the book prices that side near 49c. */
  private considerPullback(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    const [fl0, fl1] = this.v.flatLeft ?? [600, 720];
    if (row.left > fl1 || row.left < fl0 || !row.binance) return;
    if (this.open.some((t) => t.window === row.window)) return;
    const wr = winRange.get(this.prefix);
    if (!wr || wr.window !== row.window || !wr.open) return;
    const bp = this.v.pullbackBp ?? 5;
    const hiBp = ((wr.hi2 - wr.open) / wr.open) * 1e4;
    const loBp = ((wr.open - wr.lo2) / wr.open) * 1e4;
    if (hiBp >= bp === loBp >= bp) return; // exactly one side must have broken out in the first 2 minutes (no whipsaw, no quiet open)
    const up = hiBp >= bp;
    const now = (((row.binance - wr.open) / wr.open) * 1e4) * (up ? 1 : -1); // bps from the open, measured toward the breakout side
    const [w0, w1] = this.v.pullbackWithin ?? [-3, 1];
    if (now < w0 || now >= w1) return;
    if (this.v.onlySide === "UP" && !up) return;
    if (this.v.onlySide === "DOWN" && up) return;
    const ask = (up ? row.upAsks[0]?.[0] : row.downAsks[0]?.[0]) ?? null;
    if (ask == null || ask < (this.v.minAsk ?? 0.35) || ask > CAP) return;
    if (!this.leadOk(row, up)) return;
    this.take(row, { up, ask }, CAP, SIZE, `broke ${up ? "+" : "-"}${(up ? hiBp : loBp).toFixed(1)} bps in the first 2 min, back to ${now >= 0 ? "+" : ""}${now.toFixed(1)} bps toward ${up ? "UP" : "DOWN"} with ${row.left}s left, ${up ? "UP" : "DOWN"} ${(ask * 100).toFixed(0)}c`);
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
    } else if (Math.abs(move) < (this.v.aheadBpBy?.[coinOf(this.prefix)] ?? this.v.aheadBp ?? 3)) return;
    if (this.v.aheadMaxBp != null && Math.abs(move) > this.v.aheadMaxBp) return;
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
    if (this.v.spotConfirmBp != null) {
      const o = row.open;
      const bps = (x: number | null | undefined) => (x ? ((up ? x - o : o - x) / o) * 1e4 : -Infinity);
      const best = Math.max(bps(row.binance), bps(row.coinbase));
      if (best < this.v.spotConfirmBp) return;
      crossNote += `, spot ${best >= 0 ? "+" : ""}${best.toFixed(1)} bps from the open`;
    }
    if (this.v.breadthMin != null) {
      const bp = this.v.breadthBp ?? this.v.aheadBp ?? 5;
      const n = crossAheads(this.prefix, row.t, this.windowSec, bp, up);
      if (n < this.v.breadthMin) return;
      crossNote += `, ${n} other coins ${up ? "+" : "-"}${bp}+ bps from their open too`;
    }
    if (this.v.aheadFade) {
      up = !up;
      crossNote += ", FADED (buying the side against the move)";
    }
    if (this.v.onlySide === "UP" && !up) return;
    if (this.v.onlySide === "DOWN" && up) return;
    if (!this.prevRelOk(row, up)) return;
    if (this.v.prevLate) {
      const d = lateFav.get(`${this.prefix}|${row.window - this.windowSec}`);
      if (d == null) return;
      if (d < (this.v.prevLateAt ?? 0.88) !== (this.v.prevLate === "contested")) return;
    }
    if (this.v.prevRun) {
      const r = prevRun(this.prefix, row.window, this.windowSec);
      if (!r || r.k < this.v.prevRun[0] || r.k > this.v.prevRun[1]) return;
      if ((this.v.prevRunRel ?? "against") === "against" ? r.up === up : r.up !== up) return;
    }
    if (this.v.aheadOverround) {
      const ua = row.upAsks[0]?.[0], da = row.downAsks[0]?.[0];
      if (ua == null || da == null) return;
      const ovr = ua + da;
      if (ovr < this.v.aheadOverround[0] || ovr >= this.v.aheadOverround[1]) return;
      crossNote += `, book ${(ovr * 100).toFixed(0)}c wide`;
    }
    if (this.v.aheadShortMax != null) {
      const coin = coinOf(this.prefix);
      const b = latestBook.get(coin === "btc" ? "" : `${coin}5m-`);
      if (!b || row.t - b.t > 4000 || b.window !== row.window) return;
      const s5 = up ? b.up : b.down;
      if (s5 == null || s5 >= this.v.aheadShortMax) return;
      crossNote += `, 5m book still ${(s5 * 100).toFixed(0)}c`;
    }
    if (this.v.aheadHourAsk != null) {
      const b = latestBook.get(`${coinOf(this.prefix)}1h-`);
      if (!b || row.t - b.t > 5000 || b.window > row.window || b.window + 3600 <= row.window) return;
      const s1h = up ? b.up : b.down;
      if (s1h == null || s1h < this.v.aheadHourAsk[0] - 1e-9 || s1h >= this.v.aheadHourAsk[1]) return;
      crossNote += `, 1h book ${(s1h * 100).toFixed(0)}c`;
    }
    if (this.v.aheadFourAsk != null) {
      const b = latestBook.get(`${coinOf(this.prefix)}4h-`);
      if (!b || row.t - b.t > 5000 || b.window > row.window || b.window + 14400 <= row.window) return;
      const s4h = up ? b.up : b.down;
      if (s4h == null || s4h < this.v.aheadFourAsk[0] - 1e-9 || s4h >= this.v.aheadFourAsk[1]) return;
      crossNote += `, 4h book ${(s4h * 100).toFixed(0)}c`;
    }
    if (this.v.aheadRegime != null) {
      const r = aheadRegimeRate(row.t, this.v.aheadRegimeN ?? 10);
      if (r == null || r < this.v.aheadRegime[0] - 1e-9 || r >= this.v.aheadRegime[1]) return;
      crossNote += `, last ${this.v.aheadRegimeN ?? 10} early moves ${(r * 100).toFixed(0)}% won`;
    }
    if (this.v.aheadRoundClearBp != null && row.chainlink && row.open) {
      const step = COARSE_GRID[coinOf(this.prefix)];
      if (step) {
        const px = row.chainlink;
        const lo = Math.min(px, row.open), hi = Math.max(px, row.open);
        if (Math.floor(hi / step) * step > lo) return; // a big round number sits between the price and the strike: the move just broke through it
        const behind = ((up ? px - Math.floor(px / step) * step : Math.ceil(px / step) * step - px) / px) * 1e4;
        if (behind < this.v.aheadRoundClearBp) return;
      }
    }
    if (this.v.aheadOpenAsk != null) {
      const ob = openBook.get(this.prefix);
      if (!ob || ob.window !== row.window) return;
      const so = up ? ob.up : ob.down;
      if (so == null || so < this.v.aheadOpenAsk[0] - 1e-9 || so >= this.v.aheadOpenAsk[1]) return;
      crossNote += `, opened ${(so * 100).toFixed(0)}c`;
    }
    if (this.v.aheadMaxSpread != null) {
      const a0 = (up ? row.upAsks : row.downAsks)[0]?.[0];
      const b0 = ((up ? row.upBids : row.downBids) ?? [])[0]?.[0];
      if (a0 == null || b0 == null || a0 - b0 > this.v.aheadMaxSpread + 1e-9) return;
      crossNote += `, spread ${Math.round((a0 - b0) * 100)}c`;
    }
    if (this.v.aheadBidRatio != null) {
      const asksL = up ? row.upAsks : row.downAsks;
      const bidsL = (up ? row.upBids : row.downBids) ?? [];
      const best = asksL[0]?.[0];
      if (best == null) return;
      const usdWithin = (ls: [number, number][], ok: (p: number) => boolean) => ls.reduce((acc, l) => acc + (ok(l[0]) ? l[0] * l[1] : 0), 0);
      const askUsd = usdWithin(asksL, (p) => p <= best + 0.03 + 1e-9);
      const bidUsd = usdWithin(bidsL, (p) => p >= best - 0.03 - 1e-9);
      if (bidUsd < this.v.aheadBidRatio * (askUsd + 1)) return;
      crossNote += `, bids $${Math.round(bidUsd)} vs asks $${Math.round(askUsd)} within 3c`;
    }
    if (this.v.aheadAskStaleSec != null) {
      const s = askSince.get(this.prefix);
      const since = s ? (up ? s.upT : s.downT) : null;
      if (since == null || row.t - since < this.v.aheadAskStaleSec * 1000) return;
      crossNote += `, ask unchanged ${((row.t - since) / 1000).toFixed(0)} s`;
    }
    if (this.v.aheadPrevPos != null) {
      const pr = prevWinRange.get(this.prefix);
      const wr = winRange.get(this.prefix);
      if (!pr || !wr || pr.window !== row.window - this.windowSec || wr.window !== row.window || pr.hi <= pr.lo) return;
      const pos = up ? (wr.open - pr.lo) / (pr.hi - pr.lo) : (pr.hi - wr.open) / (pr.hi - pr.lo);
      if (pos < this.v.aheadPrevPos[0] || pos >= this.v.aheadPrevPos[1]) return;
      crossNote += `, opened at ${(pos * 100).toFixed(0)}% of the previous range toward ${up ? "UP" : "DOWN"}`;
    }
    if (this.v.aheadXchgLead != null) {
      const d = xchgDev(this.prefix, row);
      if (d == null) return;
      const lead = -d * (up ? 1 : -1); // Coinbase ahead of Binance toward the side we buy, bps over the usual spread
      if (lead < this.v.aheadXchgLead[0] || lead >= this.v.aheadXchgLead[1]) return;
      crossNote += `, Coinbase ${lead >= 0 ? "+" : ""}${lead.toFixed(1)} bps vs Binance toward ${up ? "UP" : "DOWN"}`;
    }
    const ask = (up ? row.upAsks[0]?.[0] : row.downAsks[0]?.[0]) ?? null;
    if (ask == null || ask < (this.v.minAsk ?? 0.1) || ask > CAP) return;
    if (this.v.askUsd) {
      const best = (up ? row.upAsks : row.downAsks)[0];
      const usd = best ? best[0] * best[1] : 0;
      if (usd < this.v.askUsd[0] || usd >= this.v.askUsd[1]) return;
    }
    if (this.v.btcNotAgainstBp != null && !this.prefix.startsWith("btc") && this.prefix !== "") {
      const b = latestAhead.get(this.windowSec === 300 ? "" : `btc${Math.round(this.windowSec / 60)}m-`);
      if (b && row.t - b.t <= 3000 && (up ? -b.move : b.move) >= this.v.btcNotAgainstBp) return;
    }
    if (this.v.btcAheadBp != null) {
      const b = latestAhead.get("");
      if (!b || row.t - b.t > 3000 || (up ? b.move < this.v.btcAheadBp : -b.move < this.v.btcAheadBp)) return;
    }
    if (!this.leadOk(row, up)) return;
    const aheadNote = `price ${move >= 0 ? "+" : ""}${move.toFixed(1)} bps from the open with ${row.left}s left${crossNote}, ${up ? "UP" : "DOWN"} still ${(ask * 100).toFixed(0)}c`;
    if (this.v.rest != null) {
      this.resting = { window: row.window, up, price: Math.round((ask - this.v.rest) * 100) / 100, t0: row.t };
      this.armedDone = row.window;
      return;
    }
    if (this.v.confirmSec != null) {
      this.armed = { window: row.window, up, ask0: ask, t0: row.t, note: aheadNote };
      return;
    }
    this.take(row, { up, ask }, CAP, SIZE, aheadNote);
  }

  /** Round 134: buy this series' side when the coin's faster `aheadFromSeries` window shows a fresh early move. */
  private considerAheadFrom(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    const [fl0, fl1] = this.v.flatLeft ?? [0, this.windowSec];
    if (row.left > fl1 || row.left < fl0 || row.chainlink == null || !row.open) return;
    if (this.open.some((t) => t.window === row.window)) return;
    const src = latestAhead.get(`${coinOf(this.prefix)}${this.v.aheadFromSeries}-`);
    if (!src || row.t - src.t > 3000 || src.windowSec >= this.windowSec) return;
    const [a0, a1] = this.v.aheadFromAge ?? [30, 180];
    const age = src.t / 1000 - Math.floor(src.t / 1000 / src.windowSec) * src.windowSec;
    if (age < a0 || age > a1) return;
    if (Math.abs(src.move) < (this.v.aheadFromBp ?? 5)) return;
    const up = src.move > 0;
    const own = (((row.chainlink - row.open) / row.open) * 1e4) * (up ? 1 : -1);
    if (this.v.aheadOwnMinBp != null && own < this.v.aheadOwnMinBp) return;
    if (this.v.onlySide && (up ? "UP" : "DOWN") !== this.v.onlySide) return;
    const ask = (up ? row.upAsks[0]?.[0] : row.downAsks[0]?.[0]) ?? null;
    if (ask == null || ask < (this.v.minAsk ?? 0.1) || ask > CAP) return;
    this.take(row, { up, ask }, CAP, SIZE, `${this.v.aheadFromSeries} window ${src.move >= 0 ? "+" : ""}${src.move.toFixed(1)} bps from its open ${Math.round(age)}s in, this window ${own >= 0 ? "+" : ""}${own.toFixed(1)} bps toward ${up ? "UP" : "DOWN"} with ${row.left}s left, ${(ask * 100).toFixed(0)}c`);
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
    if (this.v.rest != null) {
      this.resting = { window: row.window, up: pick.up, price: Math.round((pick.ask - this.v.rest) * 100) / 100, t0: row.t };
      this.armedDone = row.window;
      return;
    }
    if (this.v.confirmSec != null) {
      this.armed = { window: row.window, up: pick.up, ask0: pick.ask, t0: row.t, note: takeNote };
      return;
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
    if (this.v.coolMin != null) {
      const prev = this.lastSig;
      if (this.lastSigWindow !== row.window) {
        this.lastSigWindow = row.window;
        this.lastSig = row.t;
      }
      if (prev != null && row.t - prev < this.v.coolMin * 60000) return;
    }
    const famKey = `${this.v.name}|${this.windowSec}`;
    if (this.v.familyMaxPerWindow != null) {
      const f = familyWindowTaken.get(famKey);
      if (f && f.window === row.window && f.n >= this.v.familyMaxPerWindow) return;
      if (this.v.familySkipNextWindow && f && f.window === row.window - this.windowSec) return;
    }
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
    if (this.v.familyMaxPerWindow != null) {
      const f = familyWindowTaken.get(famKey);
      familyWindowTaken.set(famKey, f && f.window === row.window ? { window: row.window, n: f.n + 1 } : { window: row.window, n: 1 });
    }
    this.open.push(trade);
    saveJson(this.openFile, this.open);
    if (this.v.maxPerDay != null) {
      const day = kstDay(row.t);
      if (this.dayTaken.day !== day) this.dayTaken = { day, n: 0 };
      this.dayTaken.n++;
    }
    console.log(`paper ${this.v.name}: ${trade.side} ${shares.toFixed(1)} shares at ${Math.round(pick.ask * 100)}c, ${note}`);
    this.onTrade?.(trade);
  }

  /** The `favAt` rule: the first time the favourite's best ask is at or above favAt, buy it (up to cap). */
  /** The `prevRel` gate: true when the variant has none, else when the previous window's close is known and relates to `up` as asked. */
  private prevRelOk(row: BookRow, up: boolean): boolean {
    if (this.v.prevRel == null) return true;
    const last = prevClose(this.prefix, row.window, this.windowSec);
    if (last == null) return false;
    return this.v.prevRel === "opposite" ? last !== up : last === up;
  }

  /** The `btcAgreeBp` gate: true when the variant has none or this is the BTC series itself, else when BTC's series of the same window length is `btcAgreeBp`+ bps from its open the way of `up` within the last 3 s. */
  private btcAgreeOk(row: BookRow, up: boolean): boolean {
    if (this.v.btcAgreeBp == null || this.prefix.startsWith("btc") || this.prefix === "") return true;
    const b = latestAhead.get(this.windowSec === 300 ? "" : `btc${Math.round(this.windowSec / 60)}m-`);
    return !!b && row.t - b.t <= 3000 && (up ? b.move >= this.v.btcAgreeBp : -b.move >= this.v.btcAgreeBp);
  }

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
    if (this.v.favDipBelow != null) {
      const [dl0, dl1] = this.v.favDipLeft ?? [180, 360];
      if (this.favDip.window !== row.window) this.favDip = { window: row.window, up: 1, down: 1 };
      if (row.left > dl0 && row.left <= dl1) {
        this.favDip.up = Math.min(this.favDip.up, upBest);
        this.favDip.down = Math.min(this.favDip.down, downBest);
      }
    }
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
    const prevOk = this.prevRelOk(row, up);
    const btcOk = this.btcAgreeOk(row, up);
    if (this.v.eitherGate ? !prevOk && !btcOk : !prevOk || !btcOk) return;
    if (this.v.favEarly) {
      const e = earlyMove.get(`${this.prefix}|${row.window}`);
      if (e == null) return;
      const k = Math.abs(e) < (this.v.favEarlyBp ?? 5) ? "flat" : (e > 0) === up ? "continue" : "reverse";
      if (k !== this.v.favEarly) return;
    }
    if (this.v.favBreadthMin != null) {
      let n = 0;
      for (const [key, p] of lateFav) {
        const side = lateFavSide.get(key);
        if (!side || side.windowSec !== this.windowSec || key === `${this.prefix}|${row.window}` || !key.endsWith(`|${row.window}`)) continue;
        if (p >= (this.v.favAt ?? 0.88) && side.up === up) n++;
      }
      if (n < this.v.favBreadthMin) return;
    }
    if (this.v.favBreadthMax != null) {
      let n = 0;
      for (const [key, p] of lateFav) {
        const side = lateFavSide.get(key);
        if (!side || side.windowSec !== this.windowSec || key === `${this.prefix}|${row.window}` || !key.endsWith(`|${row.window}`)) continue;
        if (p >= (this.v.favAt ?? 0.88) && side.up === up) n++;
      }
      if (n > this.v.favBreadthMax) return;
    }
    if (this.v.favDissentMax != null) {
      let n = 0;
      for (const [key, p] of lateFav) {
        const side = lateFavSide.get(key);
        if (!side || side.windowSec !== this.windowSec || key === `${this.prefix}|${row.window}` || !key.endsWith(`|${row.window}`)) continue;
        if (p >= (this.v.favAt ?? 0.88) && side.up !== up) n++;
      }
      if (n > this.v.favDissentMax) return;
    }
    if (this.v.favDipBelow != null) {
      if (this.favDip.window !== row.window) return;
      if ((up ? this.favDip.up : this.favDip.down) > this.v.favDipBelow + 1e-9) return;
    }
    if (this.v.favShortMin != null) {
      const coin = coinOf(this.prefix);
      const b = latestBook.get(coin === "btc" ? "" : `${coin}5m-`);
      if (!b || row.t - b.t > 5000 || b.window !== row.window + this.windowSec - 300) return;
      const s = up ? b.up : b.down;
      if (s == null || s < this.v.favShortMin - 1e-9) return;
    }
    if (this.v.favPrevRangeMin != null) {
      const pr = prevWinRange.get(this.prefix);
      const med = MEDIAN_RANGE_15M[coinOf(this.prefix)];
      if (!pr || !med || pr.window !== row.window - this.windowSec) return;
      if (pr.bps < this.v.favPrevRangeMin * med) return;
    }
    if (this.v.favBidMaxUsd != null) {
      const fa = (up ? row.upAsks : row.downAsks)[0]?.[0];
      const fb = (up ? row.upBids : row.downBids) ?? [];
      if (fa == null) return;
      const bidUsd = fb.reduce((acc, l) => acc + (l[0] >= fa - 0.03 - 1e-9 ? l[0] * l[1] : 0), 0);
      if (bidUsd >= this.v.favBidMaxUsd) return;
    }
    if (!this.leadOk(row, up)) return;
    if (!this.crossOk(row, up)) return;
    if (this.v.favBinLeadBp != null) {
      const bl = feedLead(this.prefix, row);
      if (bl == null || (up ? bl : -bl) < this.v.favBinLeadBp) return;
    }
    if (this.v.holdRows != null) {
      if (before.length < this.v.holdRows) return;
      if (!before.every((r) => (up ? r.up : r.down) != null && (up ? r.up : r.down)! >= (this.v.holdAt ?? 0) - 1e-9)) return;
    }
    if (this.v.rest != null) {
      this.resting = { window: row.window, up, price: Math.round((ask - this.v.rest) * 100) / 100 };
      return;
    }
    if (this.v.confirmSec != null) {
      this.armed = { window: row.window, up, ask0: ask, t0: row.t, note: `favourite ${(ask * 100).toFixed(0)}c with ${row.left}s left` };
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
