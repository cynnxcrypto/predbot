/**
 * PAPER ONLY: following well-known wallets. Pure logic (no network): reading a wallet's buy out of a transaction,
 * scoring a simulated copy, and the summary. The runner is copyrun.ts. No wallet, no keys, nothing is ever sent.
 *
 * The question it answers, in this order:
 *  1. SPEED: how late do we learn of the buy, and how many other transactions on that token land before a buy sent
 *     from our setup would?
 *  2. SUPPORT: which wallets get a wave of buying right after they buy?
 *  3. MONEY, scalping style (in and out, tiny targets, seconds of holding): buying STAKE_SOL at the real Jupiter
 *     quote 0 s, 1 s and 3 s after we learn of it and selling at the real quote 2 s to 2 min later, or at the first
 *     check where a small target is reached with a hard time stop. Do we come out ahead, or are we the ones the
 *     early buyers sell to? With tiny targets the round trip cost decides everything, so it is measured on every
 *     signal: sell the tokens back at the same moment and see what is lost (pool fees and price impact both ways,
 *     plus TX_SOL twice).
 * A quote is the best case for a fill: a real order in a fast move usually gets a worse price or fails. So paper
 * profit here is an upper bound, and a paper loss is a real loss.
 */
import { SOL, USDC } from "./pools.js";

export const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const STAKE_SOL = 0.25;
/** Priority fee plus tip for one transaction, in SOL (assumed; a competitive tip in a hot token is often higher). */
export const TX_SOL = 0.001;
export const MIN_BUY_SOL = 0.1;
export const MIN_BUY_USD = 20;
export const DELAYS = [0, 1, 3] as const;
export const EXITS = [2, 5, 10, 20, 30, 60, 120] as const;
/**
 * The exit study (enrique, 11 Nov 2026 17:38 KST: is it right to get out on the first pump of copy traders, and if
 * it only goes up moderately, how long does it make sense to hold?). Extra checks on the fastest copy only, in
 * seconds: finer in the first seconds and out to 10 minutes. GRID is every time the fastest copy is checked at.
 */
export const PATH = [1, 3, 15, 45, 90, 180, 300, 600] as const;
export const GRID: readonly number[] = [...EXITS, ...PATH].sort((a, b) => a - b);
export const HOLD_MAX = 600;
/** Trailing exits: sell at the first check where the copy is this many points below its best level so far. */
export const TRAILS = [5, 10, 20] as const;
/** Scalp rules: sell at the first check where the return reaches the target (%), otherwise at the time stop (s). */
export const TARGETS = [3, 5, 10] as const;
export const TIME_STOP = 60;
/**
 * The size check (enrique, 11 Nov 2026 18:11 KST: "does the size of the trade affect our result in any way or is
 * everything % based"): the fastest copy is also priced at these stakes, and sold again at these times.
 */
export const SIZES = [0.05, 1, 3];
/** The 9% buys under other exits (see the note where the rules are listed): stops in %, stricter gaps in %. */
export const GAP9_STOPS = [10, 20] as const;
export const GAPS_MORE = [12, 15] as const;
export const SIZE_EXITS = [0, 10, 30, 60];
/** Network fees of one in-and-out as the real test pays them (11 Nov 2026: a failed buy cost 0.00003 SOL). */
export const SIZE_FEE_SOL = 0.0001;
/**
 * Late entries (11 Nov 2026 18:40 KST, asked by MAIN after the real test's first seven copies under "+10% or 60 s":
 * the only two that reached the target had landed 4 s and 23 s behind the wallet). The same copy is also bought
 * this many seconds after we know, on purpose, and each late entry is followed from its own purchase.
 */
export const LATE = [5, 10, 20] as const;
export const LATE_HOLDS = [30, 60] as const;
/** A late entry that uses what the wait showed: buy only when the price is then higher than at the moment we knew. */
export const RISING = [5, 10] as const;
/**
 * Early cut (enrique, 11 Nov 2026 18:17 KST, on a stop for the real test: "up to you, experiment and try to find the
 * best way"). At 72 buys a copy that was down at 5 s was up by 10 s in only 8 of 44, while stops that fire at any
 * check did worse than none. So one timed look instead: at this many seconds, sell if the copy is not up.
 */
export const CUTS = [5, 10, 20] as const;
/** The two rules shown per wallet, fixed in advance so nobody picks the best column afterwards. */
export const REF_RULES = ["copy-d1-x10", "copy-d1-x30"] as const;

export interface Buy {
  mint: string;
  tokens: number;
  sol: number;
  /** SOL per token */
  price: number;
  slot: number;
  blockTime: number;
  /** decimal places of the token, when the transaction says (lets a raw quote amount be turned into a price) */
  decimals?: number;
}

interface TokBal {
  mint: string;
  owner?: string;
  uiTokenAmount: { uiAmountString?: string; uiAmount?: number | null; decimals?: number };
}
export interface ParsedTx {
  slot: number;
  blockTime?: number | null;
  meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[]; preTokenBalances?: TokBal[]; postTokenBalances?: TokBal[] } | null;
  transaction: { message: { accountKeys: (string | { pubkey: string })[] } };
}

const ui = (b: TokBal) => Number(b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount ?? 0) || 0;
const decimalsOf = (tx: ParsedTx, mint: string) => {
  const d = (tx.meta?.postTokenBalances ?? []).find((b) => b.mint === mint)?.uiTokenAmount.decimals;
  return typeof d === "number" && d >= 0 && d <= 18 ? { decimals: d } : {};
};

/** The wallet's buy in this transaction (SOL or wrapped SOL spent, exactly one other token received), or null. */
export function parseBuy(tx: ParsedTx | null, wallet: string, minSol = MIN_BUY_SOL): Buy | null {
  if (!tx?.meta || tx.meta.err) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const i = keys.indexOf(wallet);
  if (i < 0) return null;
  const delta = new Map<string, number>();
  for (const b of tx.meta.postTokenBalances ?? []) if (b.owner === wallet) delta.set(b.mint, (delta.get(b.mint) ?? 0) + ui(b));
  for (const b of tx.meta.preTokenBalances ?? []) if (b.owner === wallet) delta.set(b.mint, (delta.get(b.mint) ?? 0) - ui(b));
  let sol = (tx.meta.postBalances[i] - tx.meta.preBalances[i] + (i === 0 ? tx.meta.fee : 0)) / 1e9 + (delta.get(SOL) ?? 0);
  const got = [...delta].filter(([m, d]) => m !== SOL && m !== USDC && m !== USDT && d > 0);
  const sold = [...delta].some(([m, d]) => m !== SOL && d < 0);
  if (got.length !== 1 || sold) return null; // token-to-token and stablecoin buys are skipped
  sol = -sol;
  if (sol < minSol) return null;
  const [mint, tokens] = got[0];
  return { mint, tokens, sol, price: sol / tokens, slot: tx.slot, blockTime: tx.blockTime ?? 0, ...decimalsOf(tx, mint) };
}

/**
 * A buy paid in dollars (USDC or USDT) by `wallet`, whoever signed and paid the fee: how the fomo app trades (its
 * relayer signs, and the transaction may name only the wallet's token accounts). Read from token balances by
 * owner. The dollars are turned into SOL at `solUsd` so the rest of the paper test can treat it like any buy.
 */
export function parseDollarBuy(tx: ParsedTx | null, wallet: string, solUsd: number | null, minUsd = MIN_BUY_USD): Buy | null {
  if (!tx?.meta || tx.meta.err || !(solUsd && solUsd > 0)) return null;
  const delta = new Map<string, number>();
  for (const b of tx.meta.postTokenBalances ?? []) if (b.owner === wallet) delta.set(b.mint, (delta.get(b.mint) ?? 0) + ui(b));
  for (const b of tx.meta.preTokenBalances ?? []) if (b.owner === wallet) delta.set(b.mint, (delta.get(b.mint) ?? 0) - ui(b));
  const dollar = (m: string) => m === USDC || m === USDT;
  const usd = -[...delta].filter(([m]) => dollar(m)).reduce((a, [, d]) => a + d, 0);
  const coins = [...delta].filter(([m, d]) => m !== SOL && !dollar(m) && Math.abs(d) > 1e-9);
  if (coins.length !== 1 || coins[0][1] <= 0 || usd < minUsd) return null; // one coin in, dollars out, nothing else
  const [mint, tokens] = coins[0];
  const sol = usd / solUsd;
  return { mint, tokens, sol, price: sol / tokens, slot: tx.slot, blockTime: tx.blockTime ?? 0, ...decimalsOf(tx, mint) };
}

export interface Entry {
  t: number;
  /** the slot a buy sent at that moment would land in at the earliest */
  slot: number;
  /** raw token units the quote gave for STAKE_SOL */
  tokens: string;
  /** SOL per whole token paid, from the quote */
  price: number;
}

export interface Signal {
  sig: string;
  wallet: string;
  name: string;
  mint: string;
  leaderSlot: number;
  leaderTime: number;
  leaderSol: number;
  leaderPrice: number;
  /** when the feed told us, and when we knew which token it was (ms) */
  seenMs: number;
  knownMs: number;
  /** slots between the wallet's buy and the moment we knew the token */
  lagSlots: number | null;
  feed: string;
  entries: Record<string, Entry | null>;
  /** SOL received selling the entry's tokens, by delay then exit; null = no quote */
  exits: Record<string, Record<string, number | null>>;
  crowd: Crowd | null;
  /** SOL received selling the fastest entry's tokens at the PATH times; a missing key = not checked (older signal, or a restart cut it short) */
  path?: Record<string, number | null>;
  /** MEASURED: what the first followers really paid, those that landed in the wallet's block or the next one (median SOL per token over n of them, at most 5) */
  near?: { n: number; price: number } | null;
  /** the size check: stake in SOL -> SOL received selling that stake's tokens at the SIZE_EXITS times; null = no quote */
  sizes?: Record<string, Record<string, number | null>>;
  /** a fomo trader's own buy (seeds.ts): scored apart from the listed wallets, never copied by the real test */
  fomo?: boolean;
}

/** The fee payer's own buy of this token in a follower's transaction: the price somebody really got at that spot in line. */
export function followerPrice(tx: ParsedTx | null, mint: string): number | null {
  const k = tx?.transaction.message.accountKeys[0];
  if (!k) return null;
  const b = parseBuy(tx, typeof k === "string" ? k : k.pubkey, 0.01);
  return b && b.mint === mint ? b.price : null;
}

export interface Crowd {
  /** other successful transactions touching the token: in the wallet's own slot after it, and within 10 / 25 / 150 slots (about 4 s / 10 s / 60 s) */
  same: number;
  s10: number;
  s25: number;
  s150: number;
  /** how many of them land no later than our buy would, per delay */
  ahead: Record<string, number>;
}

/** Count the follower wave from the token's transactions after the wallet's buy (oldest first: [slot, ok]). */
export function crowd(after: { slot: number; ok: boolean }[], leaderSlot: number, entries: Record<string, Entry | null>): Crowd {
  const ok = after.filter((x) => x.ok);
  const within = (n: number) => ok.filter((x) => x.slot <= leaderSlot + n).length;
  const ahead: Record<string, number> = {};
  for (const [d, e] of Object.entries(entries)) if (e) ahead[d] = ok.filter((x) => x.slot <= e.slot).length;
  return { same: within(0), s10: within(10), s25: within(25), s150: within(150), ahead };
}

export const ruleId = (d: number, x: number) => `copy-d${d}-x${x}`;
export const ruleText = (d: number, x: number) =>
  `When a tracked wallet buys, buy ${STAKE_SOL} SOL of the same token ${when(d)}, and sell everything ${x >= 60 ? `${x / 60} min` : `${x} s`} later.`;
const when = (d: number) => (d === 0 ? "the moment we know" : `${d} s after we know`);
export const scalpId = (d: number, tp: number) => `copy-d${d}-tp${tp}-t${TIME_STOP}`;
export const scalpText = (d: number, tp: number) =>
  `When a tracked wallet buys, buy ${STAKE_SOL} SOL of the same token ${when(d)}, sell as soon as it is up ${tp}% after costs, and sell anyway after ${TIME_STOP} s.`;

/** Scalp return: the first check at or above the target, else the time stop. Checks are only at the EXITS times, so a spike between two checks is missed. */
export function scalp(s: Signal, d: number, tp: number, stop = TIME_STOP): number | undefined {
  for (const x of EXITS) {
    if (x > stop) break;
    const v = ret(s, d, x);
    if (v === undefined) continue;
    if (v >= tp / 100 || x === stop || v === -1) return v;
  }
  return undefined;
}

/**
 * Round 351 (17:10 KST 11 Nov 2026, MAIN). After 26 fast-stream buys the 2-5 s exits lose (5 and 7 of 26 won) and the
 * typical copy is down 2-4% at every check up to 20 s, while the sums at 30-120 s are carried by a few big winners.
 * So the open question is whether cutting the losers early keeps the winners: same scalp, plus a stop that sells at
 * the first check where the copy is down `sl`% or more. Paper only; checks are only at the EXITS times.
 */
/** [target %, stop %]. The wide stops (20, 30) are a guard against a sudden collapse, not a trading stop: enrique asked on 11 Nov 2026 whether the real test should have one. */
export const STOPS: readonly [number, number][] = [[10, 5], [10, 10], [5, 5], [10, 20], [10, 30]];
export const stopId = (tp: number, sl: number) => `copy-d0-tp${tp}-sl${sl}-t${TIME_STOP}`;
export const stopText = (tp: number, sl: number) =>
  `When a tracked wallet buys, buy ${STAKE_SOL} SOL of the same token the moment we know, sell as soon as it is up ${tp}% after costs or down ${sl}%, and sell anyway after ${TIME_STOP} s.`;
export function scalpStop(s: Signal, tp: number, sl: number): number | undefined {
  for (const x of EXITS) {
    if (x > TIME_STOP) break;
    const v = ret(s, 0, x);
    if (v === undefined) continue;
    if (v >= tp / 100 || v <= -sl / 100 || x === TIME_STOP) return v;
  }
  return undefined;
}

/** How far our own buy price already is above what the wallet paid, as a fraction; null when either price is missing. */
export const gapOf = (s: Signal): number | null => (s.entries.d0 && s.leaderPrice > 0 ? s.entries.d0.price / s.leaderPrice - 1 : null);
/** The same gap read `d` seconds after we knew: what a buy made then would pay over the wallet's price. */
export const gapAt = (s: Signal, d: number): number | null => {
  const e = s.entries[`d${d}`];
  return e && s.leaderPrice > 0 ? e.price / s.leaderPrice - 1 : null;
};
const GAP9 = `When a tracked wallet buys and our price is already 9% or more above what the wallet paid, buy ${STAKE_SOL} SOL`;

/**
 * 12 Nov 2026 00:05 KST, enrique: "in the end you are copying other traders, so there will be traders that are good
 * signals and traders that are bad signals" / "keep finding traders and keep only the ones that favour us".
 *
 * A trader's record with us = every first buy of that wallet we saw, copied on paper the moment we knew and sold at
 * +10% or 30 s (the real test's exit). From TRADER_MIN copies on the record has a verdict:
 *   good  = the copies made money on average AND half or more of them won
 *   bad   = they lost on average AND fewer than half won
 *   mixed = anything between; new = fewer than TRADER_MIN copies so far.
 * Few copies per trader means a noisy verdict, so the rules below judge each buy only on the copies BEFORE it
 * (walk-forward): they show whether yesterday's good traders are still good today, which is the only thing that pays.
 */
export const TRADER_MIN = 4;
export const TRADER_EXIT_SEC = 30;
export type Verdict = "good" | "bad" | "mixed" | "new";
export const VERDICTS: readonly Verdict[] = ["good", "mixed", "bad", "new"];
export const traderRet = (s: Signal) => scalp(s, 0, 10, TRADER_EXIT_SEC);
export function verdictOf(rets: number[]): Verdict {
  if (rets.length < TRADER_MIN) return "new";
  const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
  const won = rets.filter((v) => v > 0).length;
  if (avg > 0 && won * 2 >= rets.length) return "good";
  if (avg < 0 && won * 2 < rets.length) return "bad";
  return "mixed";
}
/** A trader's verdict at the moment `atMs`: only copies whose result was already in by then (bought TRADER_EXIT_SEC or more before). */
export function verdictAt(sigs: Signal[], wallet: string, atMs: number): Verdict {
  return verdictOf(nums(sigs.filter((s) => s.wallet === wallet && s.knownMs + TRADER_EXIT_SEC * 1000 <= atMs).map(traderRet)));
}
/** Every signal with the verdict its trader had just before it. */
export function verdictsBefore(sigs: Signal[]): Map<Signal, Verdict> {
  const by = new Map<string, Signal[]>();
  for (const s of sigs) by.set(s.wallet, [...(by.get(s.wallet) ?? []), s]);
  const out = new Map<Signal, Verdict>();
  for (const s of sigs) out.set(s, verdictAt(by.get(s.wallet)!, s.wallet, s.knownMs));
  return out;
}

/**
 * 12 Nov 2026 00:35 KST. A trader's own record did not hold: judged walk-forward over 418 paper buys, the buys of
 * "good" traders lost 5.4% each (60 buys) and those of "bad" traders 0.1% (88). What did separate the buys was how
 * OFTEN a trader buys: the 7 traders with 15 or more buys in twelve hours lost 1.9% a buy over 158 buys, all the
 * others made 1.8% over 260. That count looks at the whole twelve hours, the future included, so the rules ask it
 * the honest way: how many buys of this trader had we seen in the PACE_HOURS before this one.
 */
export const PACE_HOURS = 3;
export const PACE_BUSY = 3;
export type Pace = "calm" | "busy";
export const PACES: readonly Pace[] = ["calm", "busy"];
/** A trader's pace at the moment `atMs`: busy = PACE_BUSY or more of their buys seen in the PACE_HOURS before it. */
export const paceAt = (sigs: Signal[], wallet: string, atMs: number): Pace =>
  sigs.filter((s) => s.wallet === wallet && s.knownMs < atMs && s.knownMs >= atMs - PACE_HOURS * 3600_000).length >= PACE_BUSY ? "busy" : "calm";
/** Every signal with the pace its trader had just before it. */
export function pacesBefore(sigs: Signal[]): Map<Signal, Pace> {
  const by = new Map<string, Signal[]>();
  for (const s of sigs) by.set(s.wallet, [...(by.get(s.wallet) ?? []), s]);
  const out = new Map<Signal, Pace>();
  for (const s of sigs) out.set(s, paceAt(by.get(s.wallet)!, s.wallet, s.knownMs));
  return out;
}

export const cutId = (tp: number, c: number) => `copy-d0-tp${tp}-cut${c}-t${TIME_STOP}`;
export const cutText = (tp: number, c: number) =>
  `When a tracked wallet buys, buy ${STAKE_SOL} SOL of the same token the moment we know, sell as soon as it is up ${tp}% after costs, sell at ${c} s if it is not up after costs by then, and sell anyway after ${TIME_STOP} s.`;
/** The scalp with one timed look: at `c` seconds a copy that is not up is sold. A missing check at `c` means no cut. */
export function scalpCut(s: Signal, tp: number, c: number): number | undefined {
  for (const x of EXITS) {
    if (x > TIME_STOP) break;
    const v = ret(s, 0, x);
    if (v === undefined) continue;
    if (v >= tp / 100 || (x === c && v <= 0) || x === TIME_STOP || v === -1) return v;
  }
  return undefined;
}

export const risingId = (d: number, tp: number) => `copy-d${d}-rising-tp${tp}-t${TIME_STOP}`;
export const risingText = (d: number, tp: number) =>
  `When a tracked wallet buys, wait ${d} s and buy ${STAKE_SOL} SOL of the same token only if its price is then higher than at the moment we knew; sell as soon as it is up ${tp}% after costs, and sell anyway after ${TIME_STOP} s.`;
/** Late entry taken only when the price rose during the wait (both prices are our own buy quotes, so it is knowable in time). */
export function rising(s: Signal, d: number, tp: number): number | undefined {
  const first = s.entries.d0;
  const late = s.entries[`d${d}`];
  return first && late && late.price > first.price ? scalp(s, d, tp) : undefined;
}

/** What an instant round trip loses, as a fraction of the stake: the move needed just to break even. */
export function roundTrip(s: Signal): number | null {
  const out = s.exits.d0?.x0;
  return s.entries.d0 && out != null ? 1 - (out - 2 * TX_SOL) / STAKE_SOL : null;
}

/**
 * Return of one copy as a fraction of the stake, after transaction costs. undefined = cannot be scored.
 * A missing sell quote counts as a total loss when the price service had no price at the last check of that entry
 * either (null there: the token could not be sold at all). A check that was never made, or whose request failed
 * (the key is absent), proves nothing and the trade is left out: on 12 Nov 2026 refused requests at 120 s were
 * being read as total losses.
 */
export function ret(s: Signal, d: number, x: number): number | undefined {
  if (!s.entries[`d${d}`]) return undefined;
  const ex = s.exits[`d${d}`] ?? {};
  const out = ex[`x${x}`];
  if (out == null) return ex[`x${EXITS[EXITS.length - 1]}`] === null ? -1 : undefined;
  return (out - 2 * TX_SOL) / STAKE_SOL - 1;
}

/** SOL the fastest copy would get back x seconds after its entry. undefined = not checked at that time. */
export function outAt(s: Signal, x: number): number | null | undefined {
  const k = `x${x}`;
  const ex = s.exits.d0;
  if (ex && k in ex) return ex[k];
  if (s.path && k in s.path) return s.path[k];
  return undefined;
}

/**
 * Return of the fastest copy sold x seconds after its entry, as a fraction of the stake after costs, over the whole
 * GRID. A missing quote is a total loss only when no later check got a quote either (the token could not be sold
 * any more); a time that was never checked cannot be scored.
 */
export function pathRet(s: Signal, x: number): number | undefined {
  if (!s.entries.d0) return undefined;
  const out = outAt(s, x);
  if (out === undefined) return undefined;
  if (out === null) return GRID.filter((g) => g > x).map((g) => outAt(s, g)).every((v) => v == null) ? -1 : undefined;
  return (out - 2 * TX_SOL) / STAKE_SOL - 1;
}

export const trailId = (t: number) => `copy-d0-trail${t}-t${HOLD_MAX}`;
export const trailText = (t: number) =>
  `When a tracked wallet buys, buy ${STAKE_SOL} SOL of the same token the moment we know, sell at the first check where it is ${t} points below its best level since we bought (so also at -${t}%), and sell anyway after ${HOLD_MAX / 60} min.`;
/** Trailing exit over the GRID checks. Cannot be scored when it neither triggered nor was followed to the end. */
export function trail(s: Signal, t: number): number | undefined {
  let peak = 0;
  for (const x of GRID) {
    const v = pathRet(s, x);
    if (v === undefined) continue;
    if (v > peak) peak = v;
    if (v === -1 || v <= peak - t / 100 || x === HOLD_MAX) return v;
  }
  return undefined;
}

/** Assumed extra paid over the wallet's own average price by a buy landing right behind it (same or next block). */
export const SAME_BLOCK_SLIP = 0.02;
export const sameId = (x: number) => `same-block-x${x}`;

/**
 * WHAT IF we had landed right behind the wallet: the measured copy (fastest entry, same exit quote) re-priced as if
 * the entry had been at the price the first followers REALLY paid in the wallet's block or the next one (s.near).
 * Where no such follower exists it falls back to the wallet's average price plus SAME_BLOCK_SLIP, which is a best
 * case. Still an estimate: a bigger token amount sells a little worse, and our own order would have had to win
 * that spot. It answers one thing only: is there money in the first second that our delay is giving away?
 */
export function sameBlockRet(s: Signal, x: number): number | undefined {
  const e = s.entries.d0;
  const out = s.exits.d0?.[`x${x}`];
  if (!e || !(s.leaderPrice > 0)) return undefined;
  if (out == null) return s.exits.d0?.[`x${EXITS[EXITS.length - 1]}`] === null ? -1 : undefined;
  const at = s.near?.price ?? s.leaderPrice * (1 + SAME_BLOCK_SLIP);
  return (out * (e.price / at) - 2 * TX_SOL) / STAKE_SOL - 1;
}

const med = (xs: number[]) => {
  if (!xs.length) return null;
  const a = [...xs].sort((p, q) => p - q);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
const q90 = (xs: number[]) => (xs.length ? [...xs].sort((p, q) => p - q)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))] : null);
const r = (x: number | null, n = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
const nums = (xs: (number | null | undefined)[]) => xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));

function score(sigs: Signal[], f: (s: Signal) => number | undefined, solUsd: number | null) {
  const rs = nums(sigs.map(f));
  const net = rs.reduce((a, b) => a + b, 0) * STAKE_SOL;
  return { n: rs.length, won: rs.filter((v) => v > 0).length, netSol: r(net, 4), netUsd: solUsd ? r(net * solUsd) : null, medianRetPct: r((med(rs) ?? 0) * 100), avgRetPct: rs.length ? r((net / STAKE_SOL / rs.length) * 100) : null };
}

/**
 * The fomo traders' own buys (enrique, 11 Nov 2026: famous traders on the fomo app buy "and then it pumps"; the
 * tracer measured it: a median of 50 new holders in the 30 s after frankdegods' buys against 5 before). Their
 * followers are people in an app, not bots, so the crowd may arrive slower than behind the listed wallets: the
 * holds go out to 10 minutes. Scored apart from the listed wallets.
 */
export function fomoStudy(sigs: Signal[], solUsd: number | null) {
  const pick: [string, (s: Signal) => number | undefined][] = [
    [scalpId(0, 10), (s) => scalp(s, 0, 10)],
    ...[10, 30, 60, 120].map((x): [string, (s: Signal) => number | undefined] => [ruleId(0, x), (s) => ret(s, 0, x)]),
    ...[300, 600].map((x): [string, (s: Signal) => number | undefined] => [ruleId(0, x), (s) => pathRet(s, x)]),
    [scalpId(5, 10), (s) => scalp(s, 5, 10)],
  ];
  const row = (ss: Signal[]) => ({
    buys: ss.length,
    /** other buyers' transactions in the ~4 s and ~60 s after the trader's buy (median) */
    follow4s: med(nums(ss.map((s) => s.crowd?.s10))),
    follow60s: med(nums(ss.map((s) => s.crowd?.s150))),
    lagSecMedian: r(med(nums(ss.map((s) => (s.leaderTime ? s.knownMs / 1000 - s.leaderTime : null)))), 1),
    entryGapPct: r((med(nums(ss.map((s) => (s.entries.d0 ? s.entries.d0.price / s.leaderPrice - 1 : null)))) ?? NaN) * 100),
    rules: Object.fromEntries(pick.map(([id, f]) => [id, score(ss, f, solUsd)])),
  });
  const by = new Map<string, Signal[]>();
  for (const s of sigs) by.set(s.name, [...(by.get(s.name) ?? []), s]);
  return {
    note: `Paper only, never copied by the real test. Buys of the fomo traders' own public wallets (paid in dollars, signed by fomo), copied with ${STAKE_SOL} SOL the moment we know and sold at +10% or 60 s (${scalpId(0, 10)}), after a fixed 10 s to 10 min (${ruleId(0, 10)} ... ${ruleId(0, 600)}), or bought 5 s late (${scalpId(5, 10)}). Scored apart from the listed wallets. entryGapPct is rough: the trader paid in dollars, turned into SOL at the price of the moment.`,
    n: sigs.length,
    all: row(sigs),
    traders: [...by].map(([name, ss]) => ({ name, ...row(ss) })).sort((a, b) => b.buys - a.buys),
    recent: sigs.slice(-10).reverse().map((s) => ({
      t: s.knownMs, name: s.name, leaderSol: r(s.leaderSol), lagSec: s.leaderTime ? r(s.knownMs / 1000 - s.leaderTime, 1) : null,
      follow4s: s.crowd?.s10 ?? null, follow60s: s.crowd?.s150 ?? null,
      ret10Pct: r((ret(s, 0, 10) ?? NaN) * 100), ret60Pct: r((ret(s, 0, 60) ?? NaN) * 100), ret300Pct: r((pathRet(s, 300) ?? NaN) * 100),
    })),
  };
}

/**
 * Early or late: the same buys entered at 0, 5, 10 and 20 s. Only buys priced at every one of those times count,
 * so the rows compare like with like (the rule list cannot: late entries exist only since they were added).
 */
export function lateStudy(sigs: Signal[]) {
  const ds = [0, ...LATE];
  const ss = sigs.filter((s) => ds.every((d) => s.entries[`d${d}`]));
  return {
    note: `Paper. Only buys priced at every entry time (${ds.join(", ")} s after we know), so the rows compare like with like. Each entry is sold as soon as it is up 10% after costs, else ${TIME_STOP} s after its own purchase (holdOnly = no target, just the ${TIME_STOP} s). priceVsFastestPct = how much more (+) or less (-) that entry paid than the fastest one (median). risingPct = share of buys where it paid more.`,
    n: ss.length,
    entries: ds.map((d) => {
      const rs = nums(ss.map((s) => scalp(s, d, 10)));
      const hold = nums(ss.map((s) => ret(s, d, TIME_STOP)));
      const gap = ss.map((s) => s.entries[`d${d}`]!.price / s.entries.d0!.price - 1);
      const avg = (xs: number[]) => (xs.length ? r((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) : null);
      return {
        sec: d, n: rs.length, won: rs.filter((v) => v > 0).length, medianRetPct: rs.length ? r((med(rs) ?? 0) * 100) : null, avgRetPct: avg(rs),
        holdOnly: { n: hold.length, won: hold.filter((v) => v > 0).length, avgRetPct: avg(hold) },
        priceVsFastestPct: gap.length ? r((med(gap) ?? 0) * 100) : null,
        risingPct: gap.length ? r((gap.filter((g) => g > 0).length / gap.length) * 100, 0) : null,
      };
    }),
  };
}

/**
 * The size check: the same copies at four stakes. Pool fees are a percentage, so what changes with size is the
 * price our own order moves (worse as it grows) and the fixed network fee (smaller as it grows). Only buys that
 * were priced at every stake count, the standard stake among them, so the rows compare like with like.
 */
export function sizeStudy(sigs: Signal[]) {
  const ss = sigs.filter((s) => s.sizes && s.entries.d0);
  const row = (sol: number, get: (s: Signal, x: number) => number | null | undefined) => {
    const at = (x: number) => nums(ss.map((s) => {
      const out = get(s, x);
      return out == null ? undefined : (out - SIZE_FEE_SOL) / sol - 1;
    }));
    const back = at(0);
    return {
      sol, n: back.length,
      /** lost by buying and selling straight back: pool fees, the price we move ourselves, network fees */
      inAndOutCostPct: r(-(med(back) ?? NaN) * 100),
      holds: SIZE_EXITS.filter((x) => x > 0).map((x) => {
        const rs = at(x);
        const avg = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
        return { sec: x, n: rs.length, won: rs.filter((v) => v > 0).length, medianRetPct: r((med(rs) ?? NaN) * 100), avgRetPct: avg === null ? null : r(avg * 100), avgSolPerTrade: avg === null ? null : r(avg * sol, 4) };
      }),
    };
  };
  const sizes = [...SIZES.map((sol) => row(sol, (s, x) => s.sizes?.[String(sol)]?.[`x${x}`])), row(STAKE_SOL, (s, x) => s.exits.d0?.[`x${x}`])].sort((a, b) => a.sol - b.sol);
  return {
    note: `Paper. The fastest copy priced at ${[...SIZES, STAKE_SOL].sort((a, b) => a - b).join(", ")} SOL at the same moment and sold ${SIZE_EXITS.filter((x) => x > 0).join(", ")} s later, with network fees of ${SIZE_FEE_SOL} SOL per in-and-out (what the real test pays; the other paper rules assume ${2 * TX_SOL}). A stake with no quote is left out of its row, so a big stake's row can miss the thinnest pools.`,
    n: ss.length,
    sizes,
  };
}

/**
 * The exit study: how the fastest paper copy stands at every check, when it stood best, and whether the first
 * wave's strength or the first 5 seconds tell how long to hold. Numbers only, no rule picked.
 */
export function exitStudy(sigs: Signal[]) {
  const ss = sigs.filter((s) => s.entries.d0);
  const cell = (g: Signal[], x: number) => {
    const rs = nums(g.map((s) => pathRet(s, x)));
    return { sec: x, n: rs.length, won: rs.filter((v) => v > 0).length, medianRetPct: r((med(rs) ?? NaN) * 100), avgRetPct: rs.length ? r((rs.reduce((a, b) => a + b, 0) / rs.length) * 100) : null };
  };
  const best = ss.flatMap((s) => {
    let b: { x: number; v: number } | null = null;
    for (const x of GRID) {
      const v = pathRet(s, x);
      if (v !== undefined && (!b || v > b.v)) b = { x, v };
    }
    return b ? [b] : [];
  });
  const share = (f: (b: { x: number; v: number }) => boolean) => (best.length ? r((best.filter(f).length / best.length) * 100, 0) : null);
  const cut = Math.max(1, Math.ceil(med(nums(ss.map((s) => s.crowd?.s10))) ?? 1));
  const waved = ss.filter((s) => s.crowd);
  const at5 = (lo: number, hi: number) => ss.filter((s) => {
    const v = pathRet(s, 5);
    return v !== undefined && v >= lo && v < hi;
  });
  const group = (name: string, g: Signal[], holds: number[]) => ({ group: name, n: g.length, holds: holds.map((x) => cell(g, x)), target10: (() => {
    const rs = nums(g.map((s) => scalp(s, 0, 10)));
    return { n: rs.length, won: rs.filter((v) => v > 0).length, medianRetPct: r((med(rs) ?? NaN) * 100) };
  })() });
  return {
    note: "Paper, fastest copy only, after costs. Checks are at fixed times, so a spike between two checks is missed. The 3 to 10 minute checks exist only for buys seen since 11 Nov 2026 18:00 KST. `target10` = sell at the first check up 10%, else at 60 s.",
    n: ss.length,
    /** how the copy stands at each check: how many are above zero, typical and average return */
    path: GRID.map((x) => cell(ss, x)),
    /** when each copy stood best */
    best: {
      n: best.length,
      medianBestPct: r((med(best.map((b) => b.v)) ?? NaN) * 100),
      medianBestSec: med(best.map((b) => b.x)),
      bestWithin5sPct: share((b) => b.x <= 5),
      bestWithin30sPct: share((b) => b.x <= 30),
      bestAfter2minPct: share((b) => b.x > 120),
      everUp3Pct: share((b) => b.v >= 0.03),
      everUp10Pct: share((b) => b.v >= 0.1),
    },
    /** does a strong first wave of followers change the answer */
    byWave: [
      group(`strong first wave (${cut}+ follower transactions in ~4 s)`, waved.filter((s) => s.crowd!.s10 >= cut), [5, 30, 60, 120, 300, 600]),
      group(`weak first wave (under ${cut})`, waved.filter((s) => s.crowd!.s10 < cut), [5, 30, 60, 120, 300, 600]),
    ],
    /** given where the copy stands after 5 s, what holding on did */
    byStart: [
      group("down at 5 s", at5(-Infinity, 0), [10, 30, 60, 120, 300, 600]),
      group("up moderately at 5 s (0 to 10%)", at5(0, 0.1), [10, 30, 60, 120, 300, 600]),
      group("up strongly at 5 s (10% or more)", at5(0.1, Infinity), [10, 30, 60, 120, 300, 600]),
    ],
  };
}

export function summarize(sigs: Signal[], solUsd: number | null) {
  const lagMs = nums(sigs.map((s) => (s.leaderTime ? s.knownMs - s.leaderTime * 1000 : null)));
  const speed = {
    buysSeen: sigs.length,
    /** seconds from the wallet's buy (block time, whole seconds) to us knowing the token */
    lagSecMedian: r((med(lagMs) ?? NaN) / 1000, 1),
    lagSecP90: r((q90(lagMs) ?? NaN) / 1000, 1),
    lagSlotsMedian: med(nums(sigs.map((s) => s.lagSlots))),
    /** transactions on the token that land before our fastest paper buy would (median, and share of buys where it is zero) */
    aheadMedian: med(nums(sigs.map((s) => s.crowd?.ahead.d0))),
    firstInLinePct: (() => {
      const a = nums(sigs.map((s) => s.crowd?.ahead.d0));
      return a.length ? r((a.filter((v) => v === 0).length / a.length) * 100, 0) : null;
    })(),
    sameSlotMedian: med(nums(sigs.map((s) => s.crowd?.same))),
    /** how much more than the wallet we pay at our fastest paper entry (median, %) */
    entryGapPctMedian: r((med(nums(sigs.map((s) => (s.entries.d0 ? s.entries.d0.price / s.leaderPrice - 1 : null)))) ?? NaN) * 100),
    /** the price move needed just to cover an instant in-and-out (median, %): fees and price impact both ways plus two transaction fees */
    breakEvenPctMedian: r((med(nums(sigs.map(roundTrip))) ?? NaN) * 100),
    /** share of buys where no follower transaction came within about 4 s (the wave never came) */
    noWavePct: (() => {
      const a = nums(sigs.map((s) => s.crowd?.s10));
      return a.length ? r((a.filter((v) => v === 0).length / a.length) * 100, 0) : null;
    })(),
  };
  const before = verdictsBefore(sigs);
  const pace = pacesBefore(sigs);
  const rules = [
    ...DELAYS.flatMap((d) => EXITS.map((x) => ({ id: ruleId(d, x), text: ruleText(d, x), ...score(sigs, (s) => ret(s, d, x), solUsd) }))),
    ...DELAYS.flatMap((d) => TARGETS.map((tp) => ({ id: scalpId(d, tp), text: scalpText(d, tp), ...score(sigs, (s) => scalp(s, d, tp), solUsd) }))),
    ...STOPS.map(([tp, sl]) => ({ id: stopId(tp, sl), text: stopText(tp, sl), ...score(sigs, (s) => scalpStop(s, tp, sl), solUsd) })),
    ...CUTS.map((c) => ({ id: cutId(10, c), text: cutText(10, c), ...score(sigs, (s) => scalpCut(s, 10, c), solUsd) })),
    ...LATE.flatMap((d) => [
      { id: scalpId(d, 10), text: scalpText(d, 10), ...score(sigs, (s) => scalp(s, d, 10), solUsd) },
      ...LATE_HOLDS.map((x) => ({ id: ruleId(d, x), text: ruleText(d, x), ...score(sigs, (s) => ret(s, d, x), solUsd) })),
    ]),
    ...RISING.map((d) => ({ id: risingId(d, 10), text: risingText(d, 10), ...score(sigs, (s) => rising(s, d, 10), solUsd) })),
    // Round 352 (18:10 KST 11 Nov 2026, MAIN). Exit study, 72 fast-stream buys: with 10+ follower transactions in ~4 s the
    // fastest copy is up at 5 s in 17 of 32 (avg +8.2% at 30 s); with fewer it is up in 7 of 30 and loses at every hold.
    // The fastest copy cannot know the wave yet, so these wait for it and pay the later price: buy 3 s after we know,
    // only when the wave is there (the count runs to ~4 s, so the first has about 1 s of hindsight; the second uses
    // only followers already in the wallet's own block). Same exit: +10% or 60 s.
    { id: "copy-d3-wave10-tp10-t60", text: `When a tracked wallet buys and 10 or more other wallets follow within about 4 s, buy ${STAKE_SOL} SOL of the same token 3 s after we know, sell as soon as it is up 10% after costs, and sell anyway after ${TIME_STOP} s.`, ...score(sigs, (s) => (s.crowd && s.crowd.s10 >= 10 ? scalp(s, 3, 10) : undefined), solUsd) },
    { id: "copy-d1-same2-tp10-t60", text: `When a tracked wallet buys and 2 or more other wallets bought in the same block, buy ${STAKE_SOL} SOL of the same token 1 s after we know, sell as soon as it is up 10% after costs, and sell anyway after ${TIME_STOP} s.`, ...score(sigs, (s) => (s.crowd && s.crowd.same >= 2 ? scalp(s, 1, 10) : undefined), solUsd) },
    // Round 353 (19:10 KST 11 Nov 2026, MAIN). Real test under "+10% or 60 s": 8 of 15 copies reached the target, and the
    // ones that did had gone on to +16% to +48% at best; the 7 that ran out of time lost more each than a target win
    // gains. So does a higher target pay for the copies it misses? Same copy, target 15% and 20%.
    ...[15, 20].map((tp) => ({ id: scalpId(0, tp), text: scalpText(0, tp), ...score(sigs, (s) => scalp(s, 0, tp), solUsd) })),
    // Round 354 (20:20 KST 11 Nov 2026, MAIN). Real test, 30 landed copies with a queue count: where we paid 9%+ over
    // the wallet's price (others had already bought in between) 10 of 11 won, +0.101 SOL; where we paid less than 9%
    // over, 6 of 19 won, -0.092 SOL. The price gap is known from the quote BEFORE the order leaves, unlike the wave
    // count. 30 copies is small, so on paper first: the same copy, taken only when the quote is 9%+ over the wallet's
    // price, and its mirror (under 3% over: we are nearly alone).
    { id: "copy-d0-gap9-tp10-t60", text: `When a tracked wallet buys and our price is already 9% or more above what the wallet paid, buy ${STAKE_SOL} SOL the moment we know, sell as soon as it is up 10% after costs, and sell anyway after ${TIME_STOP} s.`, ...score(sigs, (s) => (s.entries.d0 && s.leaderPrice > 0 && s.entries.d0.price / s.leaderPrice - 1 >= 0.09 ? scalp(s, 0, 10) : undefined), solUsd) },
    { id: "copy-d0-gap3under-tp10-t60", text: `When a tracked wallet buys and our price is less than 3% above what the wallet paid, buy ${STAKE_SOL} SOL the moment we know, sell as soon as it is up 10% after costs, and sell anyway after ${TIME_STOP} s.`, ...score(sigs, (s) => (s.entries.d0 && s.leaderPrice > 0 && s.entries.d0.price / s.leaderPrice - 1 < 0.03 ? scalp(s, 0, 10) : undefined), solUsd) },
    // Round 355 (21:20 KST 11 Nov 2026, MAIN). 192 paper buys: the 9%+ band (49 buys) made +1.08 SOL, under 3% (115)
    // lost 0.41, and the 28 in between were flat, so all of the paper profit sits in 1 buy of 4. Two questions about
    // that band: do its coins run far enough for a 20% target, and is a gap of 20%+ already too late?
    { id: "copy-d0-gap9-tp20-t60", text: `When a tracked wallet buys and our price is already 9% or more above what the wallet paid, buy ${STAKE_SOL} SOL the moment we know, sell as soon as it is up 20% after costs, and sell anyway after ${TIME_STOP} s.`, ...score(sigs, (s) => (s.entries.d0 && s.leaderPrice > 0 && s.entries.d0.price / s.leaderPrice - 1 >= 0.09 ? scalp(s, 0, 20) : undefined), solUsd) },
    { id: "copy-d0-gap20-tp10-t60", text: `When a tracked wallet buys and our price is already 20% or more above what the wallet paid, buy ${STAKE_SOL} SOL the moment we know, sell as soon as it is up 10% after costs, and sell anyway after ${TIME_STOP} s.`, ...score(sigs, (s) => (s.entries.d0 && s.leaderPrice > 0 && s.entries.d0.price / s.leaderPrice - 1 >= 0.2 ? scalp(s, 0, 10) : undefined), solUsd) },
    // Round 356 (22:20 KST 11 Nov 2026, MAIN). First 17 real copies under the 9% entry rule: 12 won, +0.042 SOL.
    // All 11 target sales came within 25 s of the buy (6 of them within 6 s); the 6 that ran to 60 s made -0.073 SOL
    // together and only one of them had come near the target. So a copy that has not paid by ~30 s mostly will not:
    // the same paper copy with the time stop at 30 s and at 20 s (the checks are at fixed times, so this is coarse).
    ...[30, 20].map((t) => ({ id: `copy-d0-gap9-tp10-t${t}`, text: `When a tracked wallet buys and our price is already 9% or more above what the wallet paid, buy ${STAKE_SOL} SOL the moment we know, sell as soon as it is up 10% after costs, and sell anyway after ${t} s.`, ...score(sigs, (s) => (s.entries.d0 && s.leaderPrice > 0 && s.entries.d0.price / s.leaderPrice - 1 >= 0.09 ? scalp(s, 0, 10, t) : undefined), solUsd) })),
    // 11 Nov 2026 22:30 KST (enrique: "are u actively analyzing if we can get better returns by tweaking our
    // strategies?"). Real test under the 9% rule, 20 copies: the 12 that reached +10% all did so within 25 s
    // (+0.122 SOL together); of the 8 that ran the full 60 s, 7 lost (-0.103 SOL together), ending 17% to 42% down.
    // The shorter clocks above do not help on paper (70 buys: +3.62% a trade at 30 s against +3.64% at 60 s, +3.03%
    // at 20 s): the slow ones are already down by then. So, for the 9% buys only: a look at 20 s that sells what is
    // not up, a stop at 10% and at 20%, and a stricter gap (12%, 15%). Five more rules on some 70 buys: one of them
    // will look best by chance, so a change of the real test needs the real copies to say the same.
    { id: "copy-d0-gap9-tp10-cut20-t60", text: `${GAP9} the moment we know, sell as soon as it is up 10% after costs, sell at 20 s if it is not up after costs by then, and sell anyway after ${TIME_STOP} s.`, ...score(sigs, (s) => ((gapOf(s) ?? -1) >= 0.09 ? scalpCut(s, 10, 20) : undefined), solUsd) },
    ...GAP9_STOPS.map((sl) => ({ id: `copy-d0-gap9-tp10-sl${sl}-t60`, text: `${GAP9} the moment we know, sell as soon as it is up 10% after costs or down ${sl}%, and sell anyway after ${TIME_STOP} s.`, ...score(sigs, (s) => ((gapOf(s) ?? -1) >= 0.09 ? scalpStop(s, 10, sl) : undefined), solUsd) })),
    ...GAPS_MORE.map((g) => ({ id: `copy-d0-gap${g}-tp10-t60`, text: `When a tracked wallet buys and our price is already ${g}% or more above what the wallet paid, buy ${STAKE_SOL} SOL the moment we know, sell as soon as it is up 10% after costs, and sell anyway after ${TIME_STOP} s.`, ...score(sigs, (s) => ((gapOf(s) ?? -1) >= g / 100 ? scalp(s, 0, 10) : undefined), solUsd) })),
    // 11 Nov 2026 22:55 KST. The real copies under the 9% rule, by entry gap (29 of the 30 in view): the 8 bought
    // 9-15% above the wallet lost 0.037 SOL together, the 21 bought 15%+ above made +0.054 SOL. Paper says the same
    // (85 buys: the 31 in the 9-15% band lose about 5% a trade, the 54 above 15% make about 6%). So, as the next
    // candidate for the real test: the 15% bar with the real test's own 30 s clock, the 9-15% band on its own (so
    // that nobody has to subtract), and a 30% bar (the 12 real copies above 30% made nothing together). Three more
    // rules on the same buys, picked after looking: they describe what happened, they do not prove it will repeat.
    { id: "copy-d0-gap15-tp10-t30", text: `When a tracked wallet buys and our price is already 15% or more above what the wallet paid, buy ${STAKE_SOL} SOL the moment we know, sell as soon as it is up 10% after costs, and sell anyway after 30 s.`, ...score(sigs, (s) => ((gapOf(s) ?? -1) >= 0.15 ? scalp(s, 0, 10, 30) : undefined), solUsd) },
    { id: "copy-d0-gap9to15-tp10-t60", text: `When a tracked wallet buys and our price is 9% to 15% above what the wallet paid, buy ${STAKE_SOL} SOL the moment we know, sell as soon as it is up 10% after costs, and sell anyway after ${TIME_STOP} s.`, ...score(sigs, (s) => ((gapOf(s) ?? -1) >= 0.09 && gapOf(s)! < 0.15 ? scalp(s, 0, 10) : undefined), solUsd) },
    { id: "copy-d0-gap30-tp10-t60", text: `When a tracked wallet buys and our price is already 30% or more above what the wallet paid, buy ${STAKE_SOL} SOL the moment we know, sell as soon as it is up 10% after costs, and sell anyway after ${TIME_STOP} s.`, ...score(sigs, (s) => ((gapOf(s) ?? -1) >= 0.3 ? scalp(s, 0, 10) : undefined), solUsd) },
    // 11 Nov 2026 23:55 KST. The real test went below zero (134 copies, -0.046 SOL): the 9-15% band has now lost on
    // 21 real copies (-0.072 SOL) and 38 paper buys, the 15%+ copies are flat (31 copies, +0.008 SOL), and a stop
    // beat no stop on paper at both readings of the 9% band (85 and 102 buys). The candidate for the real test is
    // therefore the 15% bar with a stop, and paper had no rule for that: the 15% bar with the 10% and the 20% stop,
    // and with the 20 s clock. Picked after looking, on the same buys: they describe, they do not prove.
    ...GAP9_STOPS.map((sl) => ({ id: `copy-d0-gap15-tp10-sl${sl}-t60`, text: `When a tracked wallet buys and our price is already 15% or more above what the wallet paid, buy ${STAKE_SOL} SOL the moment we know, sell as soon as it is up 10% after costs or down ${sl}%, and sell anyway after ${TIME_STOP} s.`, ...score(sigs, (s) => ((gapOf(s) ?? -1) >= 0.15 ? scalpStop(s, 10, sl) : undefined), solUsd) })),
    { id: "copy-d0-gap15-tp10-t20", text: `When a tracked wallet buys and our price is already 15% or more above what the wallet paid, buy ${STAKE_SOL} SOL the moment we know, sell as soon as it is up 10% after costs, and sell anyway after 20 s.`, ...score(sigs, (s) => ((gapOf(s) ?? -1) >= 0.15 ? scalp(s, 0, 10, 20) : undefined), solUsd) },
    // Traders (see verdictOf): every buy copied at once and sold at +10% or 30 s, split by what its trader's earlier
    // copies did. The four groups add up to the first rule. "not bad" and the 15% bar with it are what the real test
    // would run. Judged before the buy, never with its own result.
    { id: `copy-d0-tp10-t${TRADER_EXIT_SEC}`, text: `When a tracked wallet buys, buy ${STAKE_SOL} SOL of the same token the moment we know, sell as soon as it is up 10% after costs, and sell anyway after ${TRADER_EXIT_SEC} s.`, ...score(sigs, traderRet, solUsd) },
    ...VERDICTS.map((v) => ({ id: `copy-d0-trader-${v}-tp10-t${TRADER_EXIT_SEC}`, text: `The same, but only buys of traders whose earlier copies were ${v === "new" ? `too few to judge (under ${TRADER_MIN})` : v}.`, ...score(sigs, (s) => (before.get(s) === v ? traderRet(s) : undefined), solUsd) })),
    { id: `copy-d0-trader-notbad-tp10-t${TRADER_EXIT_SEC}`, text: `The same, but leaving out the buys of traders whose earlier copies were bad (${TRADER_MIN}+ copies, lost on average, fewer than half won).`, ...score(sigs, (s) => (before.get(s) !== "bad" ? traderRet(s) : undefined), solUsd) },
    ...(["notbad", "bad", "good"] as const).map((v) => ({ id: `copy-d0-gap15-trader-${v}-tp10-t${TRADER_EXIT_SEC}`, text: `When a tracked wallet buys and our price is already 15% or more above what the wallet paid, and the trader's earlier copies were ${v === "notbad" ? "not bad" : v}, buy ${STAKE_SOL} SOL the moment we know, sell as soon as it is up 10% after costs, and sell anyway after ${TRADER_EXIT_SEC} s.`, ...score(sigs, (s) => ((gapOf(s) ?? -1) >= 0.15 && (v === "notbad" ? before.get(s) !== "bad" : before.get(s) === v) ? traderRet(s) : undefined), solUsd) })),
    // 12 Nov 2026 00:41 KST: of 130 real copies, the 54 that landed in the very next block lost 0.111 SOL, the 38
    // that landed three or more blocks later made 0.047. So: is the 15% bar still good a second or three later?
    // Here the bar is read from the price at that later moment, and the copy is bought then.
    ...[1, 3].map((d) => ({ id: `copy-d${d}-gap15-tp10-t${TRADER_EXIT_SEC}`, text: `When a tracked wallet buys, wait ${d} s; if our price is then 15% or more above what the wallet paid, buy ${STAKE_SOL} SOL, sell as soon as it is up 10% after costs, and sell anyway after ${TRADER_EXIT_SEC} s.`, ...score(sigs, (s) => ((gapAt(s, d) ?? -1) >= 0.15 ? scalp(s, d, 10, TRADER_EXIT_SEC) : undefined), solUsd) })),
    // Pace (see paceAt): the same copy, split by how often the trader had bought in the hours before
    ...PACES.map((v) => ({ id: `copy-d0-${v}-tp10-t${TRADER_EXIT_SEC}`, text: `When a tracked wallet buys and that trader had bought ${v === "busy" ? `${PACE_BUSY} or more` : `fewer than ${PACE_BUSY}`} times in the ${PACE_HOURS} hours before, buy ${STAKE_SOL} SOL of the same token the moment we know, sell as soon as it is up 10% after costs, and sell anyway after ${TRADER_EXIT_SEC} s.`, ...score(sigs, (s) => (pace.get(s) === v ? traderRet(s) : undefined), solUsd) })),
    ...PACES.map((v) => ({ id: `copy-d0-gap15-${v}-tp10-t${TRADER_EXIT_SEC}`, text: `The same, but only when our price is already 15% or more above what the wallet paid.`, ...score(sigs, (s) => ((gapOf(s) ?? -1) >= 0.15 && pace.get(s) === v ? traderRet(s) : undefined), solUsd) })),
    ...[300, 600].map((x) => ({ id: ruleId(0, x), text: ruleText(0, x), ...score(sigs, (s) => pathRet(s, x), solUsd) })),
    ...TRAILS.map((t) => ({ id: trailId(t), text: trailText(t), ...score(sigs, (s) => trail(s, t), solUsd) })),
  ];
  const by = new Map<string, Signal[]>();
  for (const s of sigs) by.set(s.wallet, [...(by.get(s.wallet) ?? []), s]);
  const wallets = [...by].map(([address, ss]) => ({
    name: ss[0].name,
    address,
    buys: ss.length,
    /** follower transactions in the ~4 s and ~60 s after the wallet's buy (median) */
    follow4s: med(nums(ss.map((s) => s.crowd?.s10))),
    follow60s: med(nums(ss.map((s) => s.crowd?.s150))),
    entryGapPct: r((med(nums(ss.map((s) => (s.entries.d0 ? s.entries.d0.price / s.leaderPrice - 1 : null)))) ?? NaN) * 100),
    aheadOfUs: med(nums(ss.map((s) => s.crowd?.ahead.d0))),
    /** median return of the fastest paper copy sold after 5 s / 30 s / 2 min, % */
    ret5: r((med(nums(ss.map((s) => ret(s, 0, 5)))) ?? NaN) * 100),
    ret30: r((med(nums(ss.map((s) => ret(s, 0, 30)))) ?? NaN) * 100),
    ret120: r((med(nums(ss.map((s) => ret(s, 0, 120)))) ?? NaN) * 100),
    ref: Object.fromEntries(REF_RULES.map((id) => [id, score(ss, (s) => ret(s, 1, id.endsWith("x10") ? 10 : 30), solUsd)])),
    /** the trader's record with us: every buy copied at once and sold at +10% or 30 s; and the verdict it gives now */
    copy: score(ss, traderRet, solUsd),
    verdict: verdictOf(nums(ss.map(traderRet))),
  }));
  wallets.sort((a, b) => (b.follow4s ?? -1) - (a.follow4s ?? -1) || b.buys - a.buys);
  const traders = {
    note: `A trader's record = every first buy of that wallet we saw, copied on paper the moment we knew and sold at +10% or ${TRADER_EXIT_SEC} s. From ${TRADER_MIN} copies on: good = made money on average and half or more won; bad = lost on average and fewer than half won; mixed = between. Few copies make a noisy verdict: the rules copy-d0-trader-* judge each buy only on the copies before it.`,
    min: TRADER_MIN,
    seen: wallets.length,
    good: wallets.filter((w) => w.verdict === "good").length,
    mixed: wallets.filter((w) => w.verdict === "mixed").length,
    bad: wallets.filter((w) => w.verdict === "bad").length,
    new: wallets.filter((w) => w.verdict === "new").length,
  };
  const recent = sigs.slice(-15).reverse().map((s) => ({
    t: s.knownMs, name: s.name, mint: s.mint, leaderSol: r(s.leaderSol), lagSec: s.leaderTime ? r((s.knownMs - s.leaderTime * 1000) / 1000, 1) : null, lagSlots: s.lagSlots,
    ahead: s.crowd?.ahead.d0 ?? null, follow4s: s.crowd?.s10 ?? null, entryGapPct: s.entries.d0 ? r((s.entries.d0.price / s.leaderPrice - 1) * 100) : null,
    breakEvenPct: r((roundTrip(s) ?? NaN) * 100), ret10Pct: r((ret(s, 1, 10) ?? NaN) * 100), ret30Pct: r((ret(s, 1, 30) ?? NaN) * 100),
  }));
  const sameBlock = {
    note: `What if we had landed right behind the wallet: entry at the price the first followers really paid in its block or the next (where none, the wallet's price +${SAME_BLOCK_SLIP * 100}%), same exits. An estimate, kept apart from the real rules.`,
    /** how many signals have a measured same-block follower price, and what those followers paid over the wallet's price (median, %), to set beside speed.entryGapPctMedian (what we would pay) */
    measured: sigs.filter((s) => s.near).length,
    nearGapPctMedian: r((med(nums(sigs.map((s) => (s.near ? s.near.price / s.leaderPrice - 1 : null)))) ?? NaN) * 100),
    rules: EXITS.map((x) => ({ id: sameId(x), ...score(sigs, (s) => sameBlockRet(s, x), solUsd) })),
  };
  const qualified = rules.filter((x) => x.n >= 100 && x.won / x.n >= 0.5 && (x.netSol ?? 0) > 0).map((x) => x.id);
  return { speed, rulesTried: rules.length, inProfit: rules.filter((x) => (x.netSol ?? 0) > 0).length, qualified, rules, exitStudy: exitStudy(sigs), sizeStudy: sizeStudy(sigs), lateStudy: lateStudy(sigs), sameBlock, traders, wallets, recent };
}
