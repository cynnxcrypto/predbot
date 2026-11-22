/**
 * REAL MONEY (tiny, capped), OFF BY DEFAULT: the spot bucket rules of buckets.ts, traded for real once paper proves
 * them. enrique, 15 Nov 2026 08:20 KST, on the paper buckets: "why dont u develop that already". Built ready to
 * switch on; switching it on is his word and MAIN's change to deploy/live-rules.json, not this file's.
 *
 * WHAT IS TRADED: only a rule that MEETS THE BAR on paper (buckets.ts meetsBar: 100+ paper trades at real quotes,
 * half or more won, ahead after costs). Such a rule's next paper buys are also bought for real: `stakeSol` of the
 * coin, swapped from SOL with Jupiter, within BUY_WINDOW_MS of the paper buy; sold when the paper trade is sold (its
 * target, stop or time), or after MAX_HOLD_H whatever happens.
 * REAL RESULTS FIRST (realfirst.ts; enrique, 16 Nov 2026: "u have to cut loser and bring winners", "real is more
 * important"): once a rule has real trades, it stays real while its real net is zero or better, whatever its paper
 * record does; it is cut when its real net is below zero after three or more real trades.
 * BACK TO PAPER: a rule whose own real trades have lost `ruleStopSol` is demoted. It trades on paper only until its
 * paper trades made AFTER the demotion meet the bar again.
 *
 * Guards, all in code (the pattern of slowlive.ts, whose wallet, signing and bookkeeping this uses):
 *  - OFF unless deploy/live-rules.json has "solanaBuckets": { "on": true, "maxLossSol": ... }. SOLANA_LIVE=off
 *    disables it. Anything malformed means off.
 *  - Stake at most HARD_STAKE_SOL; at most HARD_MAX_OPEN coins out; total loss at most maxLossSol (never above
 *    HARD_MAX_LOSS_SOL), counted from what our own transactions did to the wallet's SOL, read back from the chain.
 *    A buy is made only if the cap still holds with every open trade and the new one lost in full. At the cap it
 *    stops buying for good; what is out is still sold.
 *  - ITS OWN WALLET (enrique, 15 Nov 2026: "so we separate budgets of different things"): keys.ts
 *    namedWallet("buckets"), a file made on the server. The day-holder copy's wallet is never read or signed with
 *    here. SOL itself is never "bought", and before each buy the wallet must cover the stake, a coin account's rent
 *    and a sale reserve for every trade that is out.
 *  - A trade is written to the state file before its order is sent and after every transaction, so a restart can
 *    finish and count it.
 *  - The public status gets rule names and numbers only; coins, signatures and our address stay on the server.
 * Perps are NOT traded here: paper only.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, ROOT } from "../config.js";
import { saleRefused } from "./refused.js";
import { CUT_MIN_TRADES, cutReason, realRecord, scaleOf, standing, SCALE_WALLET_SHARE } from "./realfirst.js";
import { meetsBar, paperOpens, paperRecord, paperSymbolAt, setBucketsRealSummary, spotRuleIds, REAL_MIN_TRADES, type Bucket } from "./buckets.js";
import { namedWallet, signTransaction, type Wallet } from "./keys.js";
import { SOL } from "./pools.js";

export const HARD_STAKE_SOL = 0.1; // 23 Nov 2026 08:07 KST, enrique: "push spot rules 0.1 SOL a buy, up to 0.15 for winners, total loss stop 0.4 SOL, rule stop 0.15 SOL" (0.05 since 21 Nov)
/** The most a rule that scaled up on its own real record may put in one trade (enrique, 17 Nov 2026 15:16 KST). */
export const HARD_SCALED_STAKE_SOL = 0.15; // 23 Nov 2026, enrique: "up to 0.15 for winners" (was 0.07)
export const HARD_MAX_LOSS_SOL = 0.4; // 23 Nov 2026, enrique: "total loss stop 0.4 SOL" (was 0.2)
export const HARD_MAX_OPEN = 500; // no count limit in practice: a buy is skipped only when the wallet has no free SOL
export const HARD_RULE_STOP_SOL = 0.15; // 23 Nov 2026, enrique: "rule stop 0.15 SOL" (was 0.05)
/**
 * the most this strategy's own wallet may hold; clearly more in it means nothing is bought. 0.3 until 15 Nov 2026:
 * enrique funded the wallet himself with more than that and the guard held every buy (the test trade too). What can
 * be lost is set by the loss cap, the stake and the number of open positions, not by what sits in the wallet.
 */
export const MAX_WALLET_SOL = 5;
export const TRADE_ROOM_SOL = 0.003;
export const RENT_SOL = 0.00204;
export const SELL_RESERVE_SOL = 0.001;
/** a paper buy older than this is not followed: the price it was signalled at is gone */
export const BUY_WINDOW_MS = 120_000;
export const MAX_HOLD_H = 30;
/** how far the price may move against a buy between the quote and the fill, by bucket (basis points) */
export const SLIPPAGE_BPS: Record<Bucket, number> = { high: 100, mid: 200, low: 400, meme: 1200 };
const STATE = () => join(DATA, "solana-bucketslive.json");
const LAMPORTS = 1e9;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export interface BucketsLiveConfig {
  on: boolean;
  stakeSol: number;
  maxLossSol: number;
  ruleStopSol: number;
  maxOpen: number;
  maxFeeLamports: number;
}
const OFF: BucketsLiveConfig = { on: false, stakeSol: 0, maxLossSol: 0, ruleStopSol: 0, maxOpen: 1, maxFeeLamports: 20_000 };
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Parse the "solanaBuckets" block of deploy/live-rules.json. Hard limits are applied here; anything odd means off. */
export function parseBucketsLive(text: string): BucketsLiveConfig {
  try {
    const p = (JSON.parse(text) as { solanaBuckets?: Record<string, unknown> }).solanaBuckets;
    if (!p || p.on !== true) return OFF;
    const maxLossSol = clamp(num(p.maxLossSol, 0), 0, HARD_MAX_LOSS_SOL);
    const stakeSol = clamp(num(p.stakeSol, 0.01), 0, HARD_STAKE_SOL);
    if (!(maxLossSol > 0) || !(stakeSol >= 0.005)) return OFF;
    return {
      on: true, stakeSol, maxLossSol,
      ruleStopSol: clamp(num(p.ruleStopSol, 0.03), stakeSol, HARD_RULE_STOP_SOL),
      maxOpen: clamp(Math.floor(num(p.maxOpen, 5)), 1, HARD_MAX_OPEN),
      maxFeeLamports: clamp(Math.floor(num(p.maxFeeLamports, 20_000)), 5_000, 200_000),
    };
  } catch {
    return OFF;
  }
}

interface Pos {
  rule: string;
  /** what this trade was bought with (a rule that scaled up buys more than stakeSol) */
  stakeSol?: number;
  bucket: Bucket;
  mint: string;
  /** the paper trade it follows (its buy time) */
  paperAt: number;
  stage: "buying" | "held" | "selling";
  boughtMs?: number;
  sigs: string[];
  nextTryMs?: number;
  /** what the coins held would bring if sold now (a real sell quote), SOL, and when that was read */
  valueSol?: number;
  valueMs?: number;
  /**
   * sales that could not be made for a reason the chain or Jupiter gave (no route, or a sale that landed and failed),
   * and when the first was: a time-out, a refused request or the bot being down is not counted (see writeOff)
   */
  deadSales?: number;
  firstDeadMs?: number;
  /**
   * a written-off coin: what is in the books for it so far (rent apart), the raw SOL and the rent by account of its
   * transactions read so far, and sale transactions tried since. Coins written off by an earlier build have rentIn
   * (their rent, one sum) and rentOld (that rent, set aside for them alone; see load) instead of rentByIn
   */
  bookedSol?: number;
  solIn?: number;
  rentByIn?: Record<string, number>;
  rentIn?: number;
  rentOld?: number;
  tries?: number;
  /** no more sale tries (MAX_STUCK_TRIES reached): it stays in the books as it stands */
  gaveUp?: boolean;
  /** what the write-off changed, so that it can be undone when the coin sells after all */
  undo?: { cutAt?: number; prevDemoted?: number; prevWhy?: string; halt?: string };
}
interface Row {
  t: number;
  /** when the paper trade it followed was bought, ms (rows from 16 Nov 2026): a rule's real record counts trades BOUGHT after its last cut */
  at?: number;
  rule: string;
  /** the coin's symbol (rows from 20 Nov 2026; older rows find it from their paper trade): dashboard only, never public */
  sym?: string;
  buy: "landed" | "did not land" | "failed";
  netSol: number;
  heldMin: number | null;
  /** the coin could not be sold and was written off; "recovered" once it was sold after all (the proceeds are added to this row) */
  stuck?: boolean;
  recovered?: boolean;
}
interface State {
  netSol: number;
  halted: string;
  note: string;
  opens: Pos[];
  rows: Row[];
  /** rule -> when it went back to paper, ms */
  demoted: Record<string, number>;
  /** rule -> why it was last cut */
  demotedWhy?: Record<string, string>;
  /** paper trades already looked at (rule:mint:at), newest last */
  seen: string[];
  skipped: Record<string, number>;
  lastError: string;
  /** the one-time test trade that was made (its name in the live rules, and when): a name is used once, for good */
  test?: { id: string; at: number };
  /**
   * the stop for a finished trade whose transactions could not be read back (the books may be short): kept apart from
   * `halted`, so that nothing else (the undo of a write-off's stop) can lift it; only a person, by editing the file
   */
  unread?: string;
  /** coins written off as unsellable: out of `opens` and in their rule's record, still tried once an hour */
  stuck?: Pos[];
  /** rent that sits in coin accounts not closed yet (ours, not lost): kept out of every result (see keepRent) */
  rentOutSol?: number;
  /** rent by coin account (address) that our booked transactions opened and that is not closed yet, SOL (see keepRent) */
  rentAt?: Record<string, number>;
  /** rent kept out by an earlier build that did not know accounts (one sum): taken back by closes of accounts not in rentAt */
  rentOld?: number;
  /** what the sweeps of empty coin accounts brought back that was in no rentOutSol (old accounts' rent, less the fees); their transactions until read back */
  rentBackSol?: number;
  sweepSigs?: string[];
}
const fresh = (): State => ({ netSol: 0, halted: "", note: "", opens: [], rows: [], demoted: {}, seen: [], skipped: {}, lastError: "" });
let state: State = fresh();
let loaded = false;
function load() {
  loaded = true;
  let text: string;
  try {
    text = readFileSync(STATE(), "utf8");
  } catch {
    return;
  }
  try {
    state = { ...fresh(), ...(JSON.parse(text) as State) };
    migrate();
  } catch {
    // a file that is there but unreadable must never restart the loss count from zero
    state.halted = "the state file could not be read: the loss count is unknown, so nothing is bought";
  }
}
/**
 * State written by an earlier build (MAIN's review, 16 Nov 2026). Its written-off coins have bookedSol and rentIn but
 * no solIn: without one, the next re-read would book every transaction of the coin a second time. Under that build
 * bookedSol = SOL of its transactions + rent kept out, so solIn = bookedSol - rentIn. Its rent kept out was one sum
 * (rentOutSol): it becomes rentOld, less each such coin's own rent, which is set aside for that coin (so that the sweep
 * of an old account never takes it).
 */
function migrate() {
  if (!state.rentAt) {
    state.rentAt = {};
    state.rentOld = state.rentOutSol ?? 0;
  }
  for (const p of state.stuck ?? []) {
    p.solIn ??= n9((p.bookedSol ?? 0) - (p.rentIn ?? 0));
    if (!p.rentByIn && p.rentOld === undefined) {
      p.rentOld = Math.max(0, Math.min(p.rentIn ?? 0, state.rentOld ?? 0));
      state.rentOld = n9((state.rentOld ?? 0) - p.rentOld);
    }
  }
}
function save() {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(STATE() + ".tmp", JSON.stringify(state));
  renameSync(STATE() + ".tmp", STATE());
}
const loss = () => Math.max(0, -state.netSol);
/** Why nothing new is bought: a limit (halted), or books that may be short (unread). */
const stopped = () => state.halted || state.unread || "";
const skip = (why: string) => void (state.skipped[why] = (state.skipped[why] ?? 0) + 1);

/** What this module needs from the chain and from Jupiter: copylive's kit in production, fakes in tests. */
export interface Kit {
  quote: (inMint: string, outMint: string, amount: string, slippageBps: number) => Promise<{ outAmount?: string }>;
  swapTx: (quote: unknown, address: string, maxFeeLamports: number) => Promise<string>;
  send: (tx: string) => Promise<unknown>;
  landed: (sig: string, ms: number) => Promise<{ slot: number; err: unknown } | null>;
  held: (address: string, mint: string) => Promise<{ amount: bigint; accounts?: unknown[] }>;
  sigOf: (tx: string) => string;
  balance: (address: string) => Promise<number>;
  /** what these transactions did to the wallet's SOL, those that landed but could not be read, and the rent they moved into our coin accounts (less what they got back) */
  booked: (w: Wallet, sigs: string[]) => Promise<{ sol: number; unread: string[]; rent?: number; rentBy?: Record<string, number> }>;
  /** closes the emptied coin account (its rent comes back) and adds its transaction to row.sigs */
  closeEmpty: (w: Wallet, mint: string, row: CloseRow) => Promise<unknown>;
  /** closes every empty, unfrozen coin account of the wallet except those of `keep`, adding its transactions to `sigs` */
  closeSpare?: (w: Wallet, keep: string[], sigs: string[]) => Promise<unknown>;
}
type CloseRow = import("./copylive.js").Row;
export interface LiveDeps {
  kit: Kit;
  cfg: () => BucketsLiveConfig;
  wallet: () => Wallet;
  /** the name of the one-time test trade asked for, "" = none */
  testId?: () => string;
  /** coins another strategy holds in the same wallet (none in production: this side has a wallet of its own) */
  otherHeld: () => string[];
  sleep: (ms: number) => Promise<void>;
  fixed: (e: unknown) => string;
}
/** The one-time test asked for in deploy/live-rules.json ("solanaBuckets": { "testOnce": "<name>" }); "" = none. */
function fileTest(): string {
  if (process.env.SOLANA_LIVE === "off") return "";
  try {
    const t = (JSON.parse(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8")) as { solanaBuckets?: { testOnce?: unknown } }).solanaBuckets?.testOnce;
    return typeof t === "string" ? t.slice(0, 40) : "";
  } catch {
    return "";
  }
}
/**
 * ONE TEST TRADE (enrique, 15 Nov 2026 12:28 KST: "feel free to do one test in each of the new things so we know
 * everything works, try to not lose money of course"): the smallest stake of a big liquid coin, bought now and sold
 * at the next look (it has no paper trade to wait for), through the very code a promoted rule uses. One per name.
 */
export const TEST_RULE = "test-once";
export const TEST_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"; // JUP
/**
 * REAL ON HIS WORD (enrique, 17 Nov 2026 14:55 KST: "try that spot rule on"): a rule named in "solanaBuckets": { "realNow": [...] }
 * counts as at the paper bar until it is first cut. The usual cut still applies: behind after 3 real trades = back to paper,
 * and from then on only the paper bar brings it back.
 */
let realNowRules = new Set<string>();
export function readRealNow(text: string): Set<string> {
  try {
    const v = (JSON.parse(text) as { solanaBuckets?: { realNow?: unknown } }).solanaBuckets?.realNow;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
  } catch {
    return new Set();
  }
}
function fileCfg(): BucketsLiveConfig {
  if (process.env.SOLANA_LIVE === "off") return OFF;
  try {
    const text = readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8");
    realNowRules = readRealNow(text);
    return parseBucketsLive(text);
  } catch {
    return OFF;
  }
}

/** Is the rule traded for real now? Paper must meet the bar, counting only paper trades made after a demotion. */
/**
 * One rule's real record: its landed real trades bought since it was last cut. By the buy, not the sale: a rule can
 * have several coins out, and one bought before the cut and sold after it belongs to the record that was cut, not to
 * the next one (a late winner must not make a cut rule real again without new paper trades).
 */
const realNetsOf = (rule: string) => state.rows.filter((x) => x.rule === rule && x.buy === "landed" && boughtAt(x) > (state.demoted[rule] ?? 0)).sort((a, b) => boughtAt(a) - boughtAt(b)).map((x) => x.netSol);
const realOf = (rule: string) => realRecord(realNetsOf(rule));
/** Its stake now: the base, scaled on its own real record (realfirst.ts scaleOf), at most a fifth of the wallet and the hard limit. */
export const stakeOf = (rule: string, base: number, bal = Infinity) => (rule === TEST_RULE ? base : Math.max(Math.min(base, bal), Math.min(HARD_SCALED_STAKE_SOL, base * scaleOf(realNetsOf(rule), base).mult, SCALE_WALLET_SHARE * bal)));
/**
 * When a real trade was bought: the paper buy it followed. A row of the build before 16 Nov 2026 has no buy time, so
 * for it the earliest buy its finish time and its held minutes allow (held minutes are rounded: half a minute more).
 */
const boughtAt = (x: Row) => x.at ?? x.t - ((x.heldMin ?? 0) + 0.5) * 60_000;
/** Real results first (realfirst.ts): real record ahead or level = real; no real trades yet, or behind on fewer than three = the paper bar decides. */
export const standingOf = (rule: string) => standing(realOf(rule), meetsBar(paperRecord(rule, state.demoted[rule] ?? 0)) || (realNowRules.has(rule) && !state.demoted[rule]), state.demotedWhy?.[rule]);
export const promoted = (rule: string) => standingOf(rule).real;
/** Send a rule back to paper: its real record starts again and only paper trades made from now on count. */
function cutNow(rule: string, why: string) {
  state.demotedWhy = { ...(state.demotedWhy ?? {}), [rule]: why };
  state.demoted[rule] = Date.now();
}

/**
 * RENT IS IN NO RESULT (MAIN's reviews, 16 Nov 2026). Opening a coin account puts about 0.002 SOL of rent in it and
 * closing it gives that back: ours all along, not won or lost, but a fifth of a 0.01 SOL stake. So every booking
 * takes the rent its transactions moved out of the result, read from the transactions themselves, account by account
 * (booked().rentBy: each coin account they opened or closed, whichever coin, route coins too).
 * Rent that went into an account is kept in rentAt under that account. Rent that came back from an account comes off
 * that account's own entry; for an account no booked transaction opened, off the coin's own set-aside rent (`own`, a
 * coin written off by an earlier build), then off rentOld (an earlier build's sum); only what is beyond these counts,
 * as a gain (an account from before 16 Nov, whose rent was booked as a loss then). So no rent is counted twice, and a
 * close is set against its own account, whoever closes it and when.
 * Returns the part of the rent kept out of the result.
 */
function keepRent(by: Record<string, number>, own?: Pos): number {
  const at = (state.rentAt ??= {});
  let kept = 0;
  for (const [k, x] of Object.entries(by)) {
    if (x >= 0) {
      at[k] = n9((at[k] ?? 0) + x);
      kept += x;
      continue;
    }
    let back = -x;
    const take = (have: number) => {
      const t = Math.max(0, Math.min(back, have));
      back = n9(back - t);
      kept -= t;
      return t;
    };
    at[k] = n9((at[k] ?? 0) - take(at[k] ?? 0));
    if (at[k] <= 0) delete at[k];
    if (own) own.rentOld = n9((own.rentOld ?? 0) - take(own.rentOld ?? 0));
    state.rentOld = n9((state.rentOld ?? 0) - take(state.rentOld ?? 0));
  }
  rentOutNow();
  return n9(kept);
}
/** Rent that sits in our coin accounts not closed yet: by account, an earlier build's sum, and its coins' set-aside rent. */
function rentOutNow() {
  const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
  state.rentOutSol = n9(sum(Object.values(state.rentAt ?? {})) + (state.rentOld ?? 0) + sum((state.stuck ?? []).map((p) => p.rentOld ?? 0)));
}
/** What these transactions moved into (+) or out of (-) each coin account. A kit that gives one sum: one account "?". */
const rentMap = (r: { rent?: number; rentBy?: Record<string, number> }): Record<string, number> => r.rentBy ?? (r.rent ? { "?": r.rent } : {});
/** a less b, account by account (what is new since the last reading). */
function minus(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = n9((a[k] ?? 0) - (b[k] ?? 0));
    if (x) out[k] = x;
  }
  return out;
}
const n9 = (x: number) => Math.round(x * 1e9) / 1e9;
/**
 * The wallet's empty coin accounts (the coin of a stuck trade excepted) are closed once after each start and after
 * every finished trade: rent sitting in them comes back to the wallet. Booked apart, in no trade's row, when the
 * transactions read back (until then they wait in sweepSigs); by keepRent, it moves no result.
 * ONLY WHEN NO TRADE IS OUT (MAIN's review, 16 Nov 2026): a trade's transactions are booked when it finishes, so an
 * account its buy opened (a route coin's) and the sweep closed would be counted as old rent come back (a gain) and
 * then, at its booking, as rent still out. With nothing out, every account the sweep can close was opened by a
 * booked transaction (in rentAt) or is older than this build.
 */
let swept = false;
async function sweep(d: LiveDeps) {
  const w = d.wallet();
  if (d.kit.closeSpare && !state.opens.length) {
    const sigs: string[] = [];
    try {
      await d.kit.closeSpare(w, (state.stuck ?? []).map((x) => x.mint), sigs);
    } catch (e) {
      state.lastError = d.fixed(e);
    }
    if (sigs.length) state.sweepSigs = [...(state.sweepSigs ?? []), ...sigs];
    save();
  }
  await bookSweeps(d);
}
async function bookSweeps(d: LiveDeps) {
  if (!state.sweepSigs?.length) return;
  const r = await d.kit.booked(d.wallet(), state.sweepSigs);
  if (r.unread.length) return; // read again at the next look
  const net = n9(r.sol + keepRent(rentMap(r)));
  state.netSol = n9(state.netSol + net);
  state.rentBackSol = n9((state.rentBackSol ?? 0) + net);
  state.sweepSigs = [];
  save();
}

async function sendUntil(d: LiveDeps, tx: string, ms: number) {
  const sig = d.kit.sigOf(tx);
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await d.kit.send(tx).catch(() => undefined);
    const st = await d.kit.landed(sig, 2500);
    if (st) return st;
  }
  return null;
}

async function buy(d: LiveDeps, o: { rule: string; bucket: Bucket; mint: string; at: number }, c: BucketsLiveConfig, now: number) {
  let p: Pos | null = null;
  try {
    const w = d.wallet();
    const others = d.otherHeld();
    if (others.includes(o.mint)) return skip("held by another strategy");
    const bal = await d.kit.balance(w.address);
    if (bal > MAX_WALLET_SOL + Math.max(0, state.netSol)) {
      state.note = `the wallet holds more than was agreed (${MAX_WALLET_SOL} SOL): not buying until the extra is taken out`;
      return skip("wallet over the agreed size");
    }
    const stakeSol = stakeOf(o.rule, c.stakeSol, bal);
    if (bal < stakeSol + RENT_SOL + SELL_RESERVE_SOL * (state.opens.length + others.length + 1)) {
      state.note = "wallet balance too low for a trade";
      return skip("too little SOL");
    }
    state.note = "";
    const q = await d.kit.quote(SOL, o.mint, String(Math.round(stakeSol * LAMPORTS)), SLIPPAGE_BPS[o.bucket]);
    if (!q.outAmount || q.outAmount === "0") return skip("no price");
    const tx = signTransaction(await d.kit.swapTx(q, w.address, c.maxFeeLamports), w);
    // written down before it is sent: a restart must know of every transaction of a trade
    p = { rule: o.rule, stakeSol, bucket: o.bucket, mint: o.mint, paperAt: o.at, stage: "buying", sigs: [d.kit.sigOf(tx)] };
    state.opens.push(p);
    save();
    const st = await sendUntil(d, tx, 60_000);
    if (st?.err) return void (await finish(d, w, p, "failed"));
    if (!st) {
      await d.sleep(60_000); // once its blockhash has surely run out, the wallet says whether it went through
      if ((await d.kit.held(w.address, o.mint)).amount === 0n) return void (await finish(d, w, p, "did not land"));
    }
    p.stage = "held";
    p.boughtMs = now;
    save();
  } catch (e) {
    state.lastError = d.fixed(e);
    if (!p) skip("not sent");
    save(); // a buy that was sent stays in the file: the next look counts it
  }
}

async function sell(d: LiveDeps, p: Pos, c: BucketsLiveConfig) {
  p.stage = "selling";
  save();
  // a sale the chain or Jupiter turned down (no route, or it landed and failed): the only kind that counts toward a write-off
  let dead = false;
  try {
    const w = d.wallet();
    for (let i = 0; i < 6; i++) {
      const h = await d.kit.held(w.address, p.mint);
      if (h.amount === 0n) return void (await closeAndFinish(d, w, p));
      const q = await d.kit.quote(p.mint, SOL, h.amount.toString(), Math.min(5000, Math.max(SLIPPAGE_BPS[p.bucket], 300) + 600 * i));
      if (!q.outAmount || q.outAmount === "0") {
        dead = true; // Jupiter answered: no way to sell it now
        break;
      }
      const tx = signTransaction(await d.kit.swapTx(q, w.address, c.maxFeeLamports), w);
      p.sigs.push(d.kit.sigOf(tx));
      save();
      const st = await sendUntil(d, tx, 30_000);
      if (st?.err) dead = true;
      await d.sleep(400);
    }
    if ((await d.kit.held(w.address, p.mint)).amount === 0n) return void (await closeAndFinish(d, w, p));
  } catch (e) {
    state.lastError = d.fixed(e);
    // Jupiter's "no route" comes as a thrown 4xx (copylive's jup); the network, 429s and time-outs are not counted
    if (saleRefused(e)) dead = true;
  }
  // could not sell: still held, tried again in 10 minutes
  p.stage = "held";
  p.nextTryMs = Date.now() + 600_000;
  if (dead) {
    p.deadSales = (p.deadSales ?? 0) + 1;
    p.firstDeadMs ??= Date.now();
  }
  save();
  if ((p.deadSales ?? 0) >= DEAD_SALES && Date.now() - (p.firstDeadMs ?? Date.now()) >= WRITE_OFF_MS) await writeOff(d, d.wallet(), p);
}

/**
 * A coin that cannot be sold must reach its rule's record (MAIN's review, 16 Nov 2026): before, it sat in `opens`
 * for good, the rule's real record never saw the loss, and it held one of the places. It is written off only when
 * DEAD_SALES tries over WRITE_OFF_MS or more were turned down for a reason the chain or Jupiter gave (no route, or a
 * sale that landed and failed): an outage, rate limits or the bot being down never write a coin off. And only when
 * every one of its transactions can be read back: it is booked from the chain, never from a guess.
 * Then it is booked as it stands (what its transactions did to the wallet), its rule is judged (a cut, or the loss
 * cap, can follow), and it moves to `stuck`: a sale is tried once an hour at the bucket's slippage, a little wider
 * each time, at most MAX_STUCK_TRIES transactions; every try's fee is booked once it can be read. When it sells, the
 * difference is added to the books and to its row, and a cut or a stop that the write-off made is undone and judged
 * again on the final result.
 */
export const WRITE_OFF_MS = 6 * 3_600_000;
export const DEAD_SALES = 12;
export const STUCK_RETRY_MS = 3_600_000;
export const MAX_STUCK_TRIES = 12;
async function writeOff(d: LiveDeps, w: Wallet, p: Pos) {
  const r = await d.kit.booked(w, p.sigs);
  if (r.unread.length) return; // not booked from a guess: tried at a later look
  const before = { demoted: state.demoted[p.rule], why: state.demotedWhy?.[p.rule], halt: state.halted };
  const net = n9(r.sol + keepRent(rentMap(r)));
  book(d, p, "landed", net, true);
  const undo: NonNullable<Pos["undo"]> = {};
  if (state.demoted[p.rule] !== before.demoted) Object.assign(undo, { cutAt: state.demoted[p.rule], prevDemoted: before.demoted, prevWhy: before.why });
  if (state.halted && state.halted !== before.halt) undo.halt = state.halted;
  state.stuck = [...(state.stuck ?? []), { ...p, stage: "held", bookedSol: net, solIn: r.sol, rentByIn: rentMap(r), tries: 0, undo, nextTryMs: Date.now() + STUCK_RETRY_MS }];
  save();
}
/** One more try to sell a written-off coin; then its books are read again in full and the difference is booked. */
async function sellStuck(d: LiveDeps, p: Pos, c: BucketsLiveConfig) {
  p.nextTryMs = Date.now() + STUCK_RETRY_MS;
  save();
  try {
    const w = d.wallet();
    let h = await d.kit.held(w.address, p.mint);
    if (h.amount > 0n && !p.gaveUp) {
      if ((p.tries ?? 0) >= MAX_STUCK_TRIES) p.gaveUp = true;
      else {
        // only the sale is in its own try: no route (a thrown 4xx), a 429 or a time-out must not skip the re-read below,
        // which books the fee of a try that was sent
        try {
          const q = await d.kit.quote(p.mint, SOL, h.amount.toString(), Math.min(5000, Math.max(SLIPPAGE_BPS[p.bucket], 300) + 600 * (p.tries ?? 0)));
          if (q.outAmount && q.outAmount !== "0") {
            const tx = signTransaction(await d.kit.swapTx(q, w.address, c.maxFeeLamports), w);
            p.sigs.push(d.kit.sigOf(tx));
            p.tries = (p.tries ?? 0) + 1;
            save();
            await sendUntil(d, tx, 30_000);
          }
        } catch (e) {
          state.lastError = d.fixed(e);
        }
        h = await d.kit.held(w.address, p.mint);
      }
    }
    const sold = h.amount === 0n;
    if (sold) {
      const row: CloseRow = { t: Date.now(), name: p.rule, mint: p.mint, leaderSlot: 0, buy: "landed", netSol: 0, sigs: [] };
      await d.kit.closeEmpty(w, p.mint, row).catch(() => undefined);
      p.sigs.push(...row.sigs);
      save();
    }
    // the whole coin read again, every transaction from its buy: what changed since the last booking is booked now
    const r = await d.kit.booked(w, p.sigs);
    if (r.unread.length) return save(); // read again at the next try; nothing is booked from a guess
    // only what is new since the last booking: its SOL, less the rent it moved (see keepRent). A coin written off by an
    // earlier build knows its rent as one sum: what changed in it is set against its own set-aside rent first
    const now = rentMap(r);
    const legacy = !p.rentByIn;
    const kept = legacy ? keepRent({ [`old:${p.mint}`]: n9((r.rent ?? 0) - (p.rentIn ?? 0)) }, p) : keepRent(minus(now, p.rentByIn!), p);
    const diff = n9(r.sol - (p.solIn ?? 0) + kept);
    state.netSol = n9(state.netSol + diff);
    const mine = state.rows.find((x) => x.stuck && !x.recovered && x.rule === p.rule && x.at === p.paperAt);
    if (mine) mine.netSol = n9(mine.netSol + diff);
    p.bookedSol = n9((p.bookedSol ?? 0) + diff);
    p.solIn = r.sol;
    if (legacy) p.rentIn = r.rent ?? 0;
    else p.rentByIn = now;
    if (sold) {
      if (mine) mine.recovered = true;
      state.stuck = (state.stuck ?? []).filter((x) => x !== p);
      // what is left of its set-aside rent (an account of it the sweep closed) goes back to the earlier build's sum
      state.rentOld = n9((state.rentOld ?? 0) + (p.rentOld ?? 0));
      p.rentOld = 0;
      rentOutNow();
      undoWriteOff(d, p);
    }
    save();
  } catch (e) {
    state.lastError = d.fixed(e);
  }
}
/**
 * The coin sold after all: a cut or a stop the write-off made is taken back and judged again on the final result.
 * Only if nothing has happened to the rule since (no newer cut, no real trade bought after the cut).
 */
function undoWriteOff(d: LiveDeps, p: Pos) {
  const c = d.cfg();
  const u = p.undo ?? {};
  if (u.cutAt !== undefined && state.demoted[p.rule] === u.cutAt && !state.rows.some((x) => x.rule === p.rule && boughtAt(x) > u.cutAt!)) {
    if (u.prevDemoted === undefined) delete state.demoted[p.rule];
    else state.demoted[p.rule] = u.prevDemoted;
    if (u.prevWhy === undefined) delete state.demotedWhy?.[p.rule];
    else state.demotedWhy = { ...(state.demotedWhy ?? {}), [p.rule]: u.prevWhy };
    const cut = cutReason(realOf(p.rule), c.ruleStopSol);
    if (cut) cutNow(p.rule, cut);
  }
  if (u.halt && state.halted === u.halt) {
    state.halted = "";
    if (c.maxLossSol > 0 && loss() + c.stakeSol + TRADE_ROOM_SOL > c.maxLossSol + 1e-9) state.halted = `loss cap reached: ${r6(loss())} of ${c.maxLossSol} SOL (no room for another trade)`;
  }
}

/** The emptied coin account's rent back; its transaction is counted with the trade. Then the books. */
async function closeAndFinish(d: LiveDeps, w: Wallet, p: Pos) {
  try {
    const row: CloseRow = { t: Date.now(), name: p.rule, mint: p.mint, leaderSlot: 0, buy: "landed", netSol: 0, sigs: [] };
    await d.kit.closeEmpty(w, p.mint, row);
    p.sigs.push(...row.sigs);
    save();
  } catch (e) {
    state.lastError = d.fixed(e);
  }
  await finish(d, w, p, "landed");
}

/** Count a finished trade from its own transactions, demote its rule or stop everything if a limit is reached. */
async function finish(d: LiveDeps, w: Wallet, p: Pos, buyState: Row["buy"]) {
  let r = await d.kit.booked(w, p.sigs);
  for (let i = 0; i < 3 && r.unread.length; i++) {
    await d.sleep(5000);
    r = await d.kit.booked(w, p.sigs);
  }
  if (r.unread.length) state.unread = "a transaction of a finished trade could not be read back: the books may be short, so nothing new is bought";
  book(d, p, buyState, n9(r.sol + keepRent(rentMap(r))), false);
  await sweep(d); // empty accounts its swaps left (route coins; its own coin's, if that close did not go through), if no other trade is out
}
/** Closed real trades by the Korean day they closed (t is written at the close), newest 30 days: count, won and the
 * net with every fee in (a buy that never landed counts its fees, not a trade). For the overview's day by day. */
/** Coin symbols by mint, kept from the paper trades while they were open (a real position can outlive its paper one). */
const SYMS = new Map<string, string>();
function symOf(mint: string): string {
  if (!SYMS.has(mint)) for (const o of paperOpens()) if (o.symbol) SYMS.set(o.mint, o.symbol);
  return SYMS.get(mint) ?? "";
}
export function closeDays<R extends { t: number }>(rows: R[], net: (r: R) => number, counted: (r: R) => boolean) {
  const m: Record<string, { n: number; won: number; net: number }> = {};
  for (const r of rows) {
    if (!Number.isFinite(r.t)) continue;
    const d = (m[new Date(r.t + 9 * 3_600_000).toISOString().slice(0, 10)] ??= { n: 0, won: 0, net: 0 });
    const v = Number(net(r)) || 0;
    d.net += v;
    if (counted(r)) {
      d.n++;
      if (v > 0) d.won++;
    }
  }
  return Object.keys(m).sort().reverse().slice(0, 30).map((day) => ({ day, n: m[day].n, won: m[day].won, net: Math.round(m[day].net * 1e6) / 1e6 }));
}
/** Put a finished (or written-off) trade in the books and its rule's record; judge the rule and the loss cap. */
function book(d: LiveDeps, p: Pos, buyState: Row["buy"], net: number, stuck: boolean) {
  state.netSol = n9(state.netSol + net);
  state.opens = state.opens.filter((x) => x !== p);
  state.rows = [...state.rows, { t: Date.now(), at: p.paperAt, rule: p.rule, sym: symOf(p.mint) || paperSymbolAt(p.rule, p.paperAt), buy: buyState, netSol: net, ...(stuck ? { stuck: true } : {}), heldMin: p.boughtMs ? Math.round((Date.now() - p.boughtMs) / 60_000) : null }].slice(-5000);
  const c = d.cfg();
  // (the one-time test trade follows no rule: it is never "cut")
  const cut = p.rule === TEST_RULE ? "" : cutReason(realOf(p.rule), c.ruleStopSol);
  if (cut) cutNow(p.rule, cut);
  if (!state.halted && c.maxLossSol > 0 && loss() + c.stakeSol + TRADE_ROOM_SOL > c.maxLossSol + 1e-9) state.halted = `loss cap reached: ${r6(loss())} of ${c.maxLossSol} SOL (no room for another trade)`;
  save();
}

/** how often the coins held are valued for the status */
export const VALUE_MS = 5 * 60_000;
let busy = false;
/** One look: sell what paper has sold (or is too old), settle buys a restart cut off, buy what paper just bought. */
export async function bucketsLiveTick(d: LiveDeps, now = Date.now()): Promise<void> {
  if (busy) return;
  if (!loaded) load();
  const c = d.cfg();
  if (!c.on && !state.opens.length && !state.stuck?.length) return;
  busy = true;
  try {
    const paper = paperOpens();
    const twin = (p: Pos) => paper.some((o) => o.rule === p.rule && o.mint === p.mint && o.at === p.paperAt);
    for (const p of [...state.opens]) {
      if (p.stage === "buying" || p.stage === "selling") {
        // cut off by a restart: the wallet says where it stands
        const w = d.wallet();
        const h = await d.kit.held(w.address, p.mint).catch(() => null);
        if (!h) continue;
        if (h.amount === 0n) await (p.stage === "selling" ? closeAndFinish(d, w, p) : finish(d, w, p, "did not land"));
        else {
          p.stage = "held";
          p.boughtMs ??= now;
          save();
        }
      }
      if (p.stage === "held" && (p.nextTryMs ?? 0) <= now && (!twin(p) || now - (p.boughtMs ?? now) >= MAX_HOLD_H * 3_600_000)) await sell(d, p, c);
      else if (p.stage === "held" && now - (p.valueMs ?? 0) >= VALUE_MS) {
        // for the status only: the money is in coins, not gone
        p.valueMs = now;
        try {
          const h = await d.kit.held(d.wallet().address, p.mint);
          const q = h.amount > 0n ? await d.kit.quote(p.mint, SOL, h.amount.toString(), 300) : { outAmount: "0" };
          if (q.outAmount) p.valueSol = Number(q.outAmount) / LAMPORTS;
        } catch {
          // no quote now: the last value stays
        }
        save();
      }
    }
    for (const p of [...(state.stuck ?? [])]) if ((p.nextTryMs ?? 0) <= now) await sellStuck(d, p, c);
    if (!swept && !state.opens.length) {
      swept = true;
      await sweep(d);
    } else await bookSweeps(d);
    const tid = d.testId?.() ?? "";
    if (tid && c.on && !stopped() && state.test?.id !== tid && !state.opens.length) {
      // the name is written down before anything is sent: whatever happens next, this test is never made twice
      state.test = { id: tid, at: now };
      save();
      await buy(d, { rule: TEST_RULE, bucket: "high", mint: TEST_MINT, at: now }, { ...c, stakeSol: Math.min(c.stakeSol, 0.01) }, now);
    }
    for (const o of paper) {
      const key = `${o.rule}:${o.mint}:${o.at}`;
      if (state.seen.includes(key)) continue;
      state.seen = [...state.seen, key].slice(-500);
      if (!c.on || stopped()) continue;
      // a cut missed when its trade finished (the switch was off then, or the stop was lowered since) is made now
      const late = cutReason(realOf(o.rule), c.ruleStopSol);
      if (late) cutNow(o.rule, late);
      if (!promoted(o.rule)) continue; // the usual case: the rule is paper only
      if (o.mint === SOL) skip("SOL itself");
      else if (now - o.at > BUY_WINDOW_MS) skip("paper buy too old");
      else if (state.opens.some((p) => p.mint === o.mint) || (state.stuck ?? []).some((p) => p.mint === o.mint)) skip("coin already held");
      else if (state.opens.length >= c.maxOpen) skip("too many out");
      // the loss cap counts real losses only (21 Nov 2026): counting every open stake as already lost skipped 77 real
      // buys while most of the wallet sat idle. Free SOL is checked at the buy ("too little SOL").
      else if (loss() + stakeOf(o.rule, c.stakeSol) + TRADE_ROOM_SOL > c.maxLossSol + 1e-9) skip("no room under the cap");
      else await buy(d, o, c, now);
    }
    save();
  } catch (e) {
    state.lastError = d.fixed(e);
  } finally {
    busy = false;
  }
}

// ---- status (public: rule names and numbers only) -----------------------------------------------------------------------
let liveCfg: () => BucketsLiveConfig = fileCfg;
export function bucketsLiveSummary() {
  if (!loaded) load();
  const c = liveCfg();
  const done = state.rows.filter((x) => x.buy === "landed");
  const rules = spotRuleIds().map((id) => {
    const since = state.demoted[id] ?? 0;
    const paper = paperRecord(id, since);
    const mine = done.filter((x) => x.rule === id);
    const st = standingOf(id);
    const live = realOf(id);
    return { id, real: c.on && !stopped() && st.real, why: !c.on ? "paper: real trading is switched off" : stopped() ? "paper: real trading is stopped" : st.why, realTrades: live.trades, realWon: live.won, realNetSol: r6(live.net), paperTrades: paper.trades, paperWon: paper.won, paperNetUsd: Math.round(paper.netUsd * 100) / 100, demotedAt: since || null, trades: mine.length, won: mine.filter((x) => x.netSol > 0).length, netSol: r6(mine.reduce((a, x) => a + x.netSol, 0)) };
  });
  return {
    note: `REAL, off unless the live rules switch it on. A spot bucket rule gets its first real trades when its paper record meets the bar (${REAL_MIN_TRADES}+ paper trades at real quotes, half or more won, ahead after costs): then each of its paper buys is also bought with ${c.stakeSol || 0.01} SOL and sold when the paper trade is sold. Real results come first (enrique, 16 Nov 2026: "cut loser and bring winners", "real is more important"): once it has real trades it stays real while its real net is zero or better, even under the paper bar, and goes back to paper when its real trades are behind after ${CUT_MIN_TRADES} or more, or have lost ${c.ruleStopSol || 0.03} SOL; it returns when its paper trades made after that meet the bar again. In rules: why = the reason in words; realTrades, realWon, realNetSol = its real trades bought since it was last cut; trades, won, netSol = all its real trades ever. A coin that Jupiter or the chain refused to sell ${DEAD_SALES} times over ${WRITE_OFF_MS / 3_600_000} hours or more is written off: it counts in its rule's record as it stands (stuck), a sale is tried hourly (at most ${MAX_STUCK_TRIES}), and what a later sale brings is added, undoing a cut or stop the write-off made. The rent of a coin account is in no trade's result. Total loss is capped; the perps side has its own wallet and block.`,
    on: c.on && !stopped(),
    switch: c.on ? "on" : "off",
    halted: stopped(),
    stateNote: state.note,
    stakeSol: c.stakeSol,
    capSol: c.maxLossSol,
    ruleStopSol: c.ruleStopSol,
    netSol: r6(state.netSol),
    trades: done.length,
    won: done.filter((x) => x.netSol > 0).length,
    notLanded: state.rows.length - done.length,
    open: state.opens.length,
    // coins written off as unsellable (in their rule's record as they stood; a sale is still tried once an hour), and
    // rent that sits in coin accounts not closed yet (ours, in no result)
    stuck: state.stuck?.length ?? 0,
    stuckGaveUp: (state.stuck ?? []).filter((p) => p.gaveUp).length,
    rentOutSol: r6(state.rentOutSol ?? 0),
    rentBackSol: r6(state.rentBackSol ?? 0),
    // SOL that sits in coins now: what was paid for them, and what they would bring at a sell quote read in the last minutes
    // (a coin not yet valued counts at what was paid). Not a loss and not a withdrawal until sold.
    heldCostSol: r6(state.opens.reduce((a, p) => a + (p.stakeSol ?? c.stakeSol), 0)),
    heldValueSol: r6(state.opens.reduce((a, p) => a + (p.valueSol ?? p.stakeSol ?? c.stakeSol), 0)),
    skipped: state.skipped,
    lastError: state.lastError,
    // the real trades for the page: newest 40 closed and what is out now (rule and bucket only: no coin, no transaction,
    // and not the buy time a row keeps for its rule's record: beside the paper list that time would name the coin)
    rows: state.rows.slice(-40).reverse().map(({ at, ...x }) => ({ ...x, sym: x.sym || paperSymbolAt(x.rule, at) })),
    // every day's closed real trades in SOL, the test trade left out
    days: closeDays(state.rows.filter((x) => x.rule !== TEST_RULE), (x) => x.netSol, (x) => x.buy === "landed"),
    // for the tab (17 Nov 2026, enrique: "positions open thing with no data of size, pnl or anything"): the coin's
    // symbol (never its mint), what it cost, what it would sell for now, since when held
    opens: state.opens.map((p) => ({ rule: p.rule, bucket: p.bucket, stage: p.stage, since: p.paperAt, boughtMs: p.boughtMs ?? null, sym: symOf(p.mint), stakeSol: r6(p.stakeSol ?? c.stakeSol), valueSol: p.valueSol != null ? r6(p.valueSol) : null })),
    // the one-time test trade: its name, when, where it stands and what it did to the wallet (every fee in)
    test: state.test ? { ...state.test, open: state.opens.filter((p) => p.rule === TEST_RULE).map((p) => p.stage), rows: state.rows.filter((x) => x.rule === TEST_RULE).map((x) => ({ t: x.t, buy: x.buy, netSol: r6(x.netSol), heldMin: x.heldMin })) } : null,
    rulesReal: rules.filter((x) => x.real).length,
    rules: rules.filter((x) => x.real || x.trades || x.demotedAt || x.paperTrades >= REAL_MIN_TRADES / 2),
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
export async function startBucketsLive() {
  if (timer || process.env.SOLANA_LIVE === "off" || process.env.SOLANA_BUCKETS === "off") return;
  const { kit, whyNotSent } = await import("./copylive.js");
  try {
    namedWallet("buckets"); // made at the first start, so its address is on the server before the switch goes on
  } catch {
    return; // no usable wallet: this side stays off
  }
  // its own wallet (data/solana-wallet-buckets.json): nothing here can touch the day-holder copy's money, so no coin is shared
  const d: LiveDeps = { kit, cfg: fileCfg, wallet: () => namedWallet("buckets"), testId: fileTest, otherHeld: () => [], sleep: (ms) => new Promise((res) => setTimeout(res, ms)), fixed: (e) => whyNotSent(String((e as Error)?.message ?? e)) };
  setBucketsRealSummary(bucketsLiveSummary);
  timer = setInterval(() => void bucketsLiveTick(d), 30_000);
  timer.unref();
}

/** Test hooks. */
export const _test = { forgetSweep: () => void (swept = false), reset: () => ((state = fresh()), (loaded = true), (swept = false)), state: () => state, reload: () => load(), setCfg: (f: () => BucketsLiveConfig) => void (liveCfg = f) };
