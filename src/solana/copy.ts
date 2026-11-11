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
export const DELAYS = [0, 1, 3] as const;
export const EXITS = [2, 5, 10, 20, 30, 60, 120] as const;
/** Scalp rules: sell at the first check where the return reaches the target (%), otherwise at the time stop (s). */
export const TARGETS = [3, 5, 10] as const;
export const TIME_STOP = 60;
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
}

interface TokBal {
  mint: string;
  owner?: string;
  uiTokenAmount: { uiAmountString?: string; uiAmount?: number | null };
}
export interface ParsedTx {
  slot: number;
  blockTime?: number | null;
  meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[]; preTokenBalances?: TokBal[]; postTokenBalances?: TokBal[] } | null;
  transaction: { message: { accountKeys: (string | { pubkey: string })[] } };
}

const ui = (b: TokBal) => Number(b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount ?? 0) || 0;

/** The wallet's buy in this transaction (SOL or wrapped SOL spent, exactly one other token received), or null. */
export function parseBuy(tx: ParsedTx | null, wallet: string): Buy | null {
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
  if (sol < MIN_BUY_SOL) return null;
  const [mint, tokens] = got[0];
  return { mint, tokens, sol, price: sol / tokens, slot: tx.slot, blockTime: tx.blockTime ?? 0 };
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
export function scalp(s: Signal, d: number, tp: number): number | undefined {
  for (const x of EXITS) {
    if (x > TIME_STOP) break;
    const v = ret(s, d, x);
    if (v === undefined) continue;
    if (v >= tp / 100 || x === TIME_STOP || v === -1) return v;
  }
  return undefined;
}

/** What an instant round trip loses, as a fraction of the stake: the move needed just to break even. */
export function roundTrip(s: Signal): number | null {
  const out = s.exits.d0?.x0;
  return s.entries.d0 && out != null ? 1 - (out - 2 * TX_SOL) / STAKE_SOL : null;
}

/**
 * Return of one copy as a fraction of the stake, after transaction costs. undefined = cannot be scored.
 * A missing sell quote counts as a total loss when the last quote of that entry is missing too (the token could
 * not be sold at all); when a later quote exists it was only a failed request and the trade is left out.
 */
export function ret(s: Signal, d: number, x: number): number | undefined {
  if (!s.entries[`d${d}`]) return undefined;
  const ex = s.exits[`d${d}`] ?? {};
  const out = ex[`x${x}`];
  if (out == null) return ex[`x${EXITS[EXITS.length - 1]}`] == null ? -1 : undefined;
  return (out - 2 * TX_SOL) / STAKE_SOL - 1;
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
  const rules = [
    ...DELAYS.flatMap((d) => EXITS.map((x) => ({ id: ruleId(d, x), text: ruleText(d, x), ...score(sigs, (s) => ret(s, d, x), solUsd) }))),
    ...DELAYS.flatMap((d) => TARGETS.map((tp) => ({ id: scalpId(d, tp), text: scalpText(d, tp), ...score(sigs, (s) => scalp(s, d, tp), solUsd) }))),
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
  }));
  wallets.sort((a, b) => (b.follow4s ?? -1) - (a.follow4s ?? -1) || b.buys - a.buys);
  const recent = sigs.slice(-15).reverse().map((s) => ({
    t: s.knownMs, name: s.name, mint: s.mint, leaderSol: r(s.leaderSol), lagSec: s.leaderTime ? r((s.knownMs - s.leaderTime * 1000) / 1000, 1) : null, lagSlots: s.lagSlots,
    ahead: s.crowd?.ahead.d0 ?? null, follow4s: s.crowd?.s10 ?? null, entryGapPct: s.entries.d0 ? r((s.entries.d0.price / s.leaderPrice - 1) * 100) : null,
    breakEvenPct: r((roundTrip(s) ?? NaN) * 100), ret10Pct: r((ret(s, 1, 10) ?? NaN) * 100), ret30Pct: r((ret(s, 1, 30) ?? NaN) * 100),
  }));
  const qualified = rules.filter((x) => x.n >= 100 && x.won / x.n >= 0.5 && (x.netSol ?? 0) > 0).map((x) => x.id);
  return { speed, rulesTried: rules.length, inProfit: rules.filter((x) => (x.netSol ?? 0) > 0).length, qualified, rules, wallets, recent };
}
