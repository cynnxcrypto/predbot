/**
 * REAL MONEY (small, capped): the landing-speed test for wallet copying. enrique, 11 Nov 2026 16:21 KST: "go 0.5".
 *
 * What it does: when a tracked wallet's buy arrives on the fast stream, buy STAKE of the same token at once, hold
 * it, sell everything, and record where our buy really landed (how many slots behind the wallet, how many
 * transactions ahead of us), what we really paid against the wallet's price, and what came back. The purpose is to
 * measure, not to earn: paper cannot tell whether our own order lands in time.
 *
 * The exit (enrique, 11 Nov 2026 18:13 KST, on a decision card: "Switch to +10% or 60 s"): while holding, ask every
 * moment what a sale would bring back; sell as soon as that is `targetPct` above the stake, and sell anyway after
 * `holdSec`. With targetPct 0 it is the old fixed hold. No stop unless `stopPct` is set (see LiveConfig): on the
 * first paper read the stops cost more than they saved; for the 9% band a wide one later looked better.
 *
 * Guards, all in code:
 *  - OFF unless deploy/live-rules.json has "solanaCopy": { "on": true, ... } (MAIN owns that file). SOLANA_LIVE=off
 *    also disables it. Anything malformed means off.
 *  - Stake at most HARD_STAKE_SOL per copy. Total loss at most HARD_MAX_LOSS_SOL, counted from the wallet's real
 *    SOL balance before and after each copy (so every fee is in it). At the cap it stops for good.
 *  - One position at a time, unless the repo file sets "maxOpen" (at most HARD_MAX_OPEN; see "several coins at
 *    once" below). If a position cannot be sold it halts new buys and says so.
 *  - Needs both API keys. Signs only transactions whose single signer is our wallet (keys.ts).
 *  - The wallet's secret stays in data/solana-wallet.json. The address, token and signatures of our trades are kept
 *    only in data/ on the server: the public status gets numbers only, nothing that identifies the wallet.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, ROOT } from "../config.js";
import { onStreamBuy, scrub, shared, type StreamBuy } from "./copyrun.js";
import { buildSigned, signTransaction, wallet, type Wallet } from "./keys.js";
import { SOL } from "./pools.js";
import { base58 } from "./whirlpool.js";

export const HARD_STAKE_SOL = 0.05;
export const HARD_MAX_LOSS_SOL = 0.5;
/**
 * enrique agreed to fund 0.5 SOL. With clearly more than that put into the wallet nothing trades (MAIN review, 11 Nov
 * 2026). What the test itself has won is not "more put in": the limit moves up with the booked profit (walletLimit),
 * so a winning test never stops itself. His rule: a hidden setting must never silently stop trading.
 */
export const MAX_WALLET_SOL = 0.6;
const walletLimit = () => Math.round((MAX_WALLET_SOL + Math.max(0, state.netSol)) * 1e6) / 1e6;
const tooMuch = () => `the wallet holds more than was agreed (${MAX_WALLET_SOL} SOL plus what the test has won, ${walletLimit()} SOL now): not buying until the extra is taken out`;
/** Room kept under the cap for the fees of one copy (a buy, up to six sale tries, an unclosed token account). */
export const FEE_ROOM_SOL = 0.03;
export const MAX_RECOVERIES = 3;
/** The most coins held at the same time, whatever the file says (enrique, 11 Nov 2026 21:25 KST: "im cool with 5 at a time"). */
export const HARD_MAX_OPEN = 5;
/** With several at once: the least time between two copies starting. */
const MANY_GAP_MS = 200;
const STUCK = "could not sell a position: tokens are still in the wallet";
const UNREAD = "a transaction of a finished copy could not be read back: the books may be short, so nothing new is bought";
const STATE = () => join(DATA, "solana-copylive.json");
const ROWS = () => join(DATA, "solana", "copylive-trades.jsonl");
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export interface LiveConfig {
  on: boolean;
  stakeSol: number;
  maxLossSol: number;
  holdSec: number;
  /** sell as soon as a sale would bring back this much more than the stake, %; 0 = hold the full time */
  targetPct: number;
  /**
   * Off unless set (0). With it, a copy is sold when what a sale would bring back is this many % under the stake on
   * STOP_READINGS looks in a row. Asked for by MAIN on 11 Nov 2026 22:38 KST after the 9% band's time-ups: 9 real
   * copies that ran the full 60 s lost 0.135 SOL together (17% to 64% of the stake each), and on paper (77 buys) a
   * 20% stop kept every winner and made +0.54 SOL where the plain 60 s clock made +0.13.
   */
  stopPct: number;
  /** most copies in one KST day; none set in the file = no daily limit (the loss cap is the stop) */
  maxPerDay: number;
  /**
   * Entry filter: copy only when the buy quote is already this much above the price the wallet paid, %; 0 = copy
   * every buy. Decided from the quote, before anything is signed, so a skipped buy costs nothing.
   */
  minGapPct: number;
  /** how many coins may be held at the same time; 1 = one copy at a time, counted from the wallet's balance as before */
  maxOpen: number;
  slippageBps: number;
  /** most we will pay in priority fee per transaction, lamports */
  maxFeeLamports: number;
}
const OFF: LiveConfig = { on: false, stakeSol: 0, maxLossSol: 0, holdSec: 5, targetPct: 0, stopPct: 0, maxPerDay: 0, minGapPct: 0, maxOpen: 1, slippageBps: 1500, maxFeeLamports: 0 };
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Parse the "solanaCopy" block of deploy/live-rules.json. Hard limits are applied here; anything odd means off. */
export function parseLive(text: string): LiveConfig {
  try {
    const p = (JSON.parse(text) as { solanaCopy?: Record<string, unknown> }).solanaCopy;
    if (!p || p.on !== true) return OFF;
    const maxLossSol = clamp(num(p.maxLossSol, 0), 0, HARD_MAX_LOSS_SOL);
    const stakeSol = clamp(num(p.stakeSol, HARD_STAKE_SOL), 0, HARD_STAKE_SOL);
    if (!(maxLossSol > 0) || !(stakeSol >= 0.01)) return OFF;
    return {
      on: true, stakeSol, maxLossSol,
      holdSec: clamp(num(p.holdSec, 5), 1, 60),
      targetPct: clamp(num(p.targetPct, 0), 0, 50),
      // an instant in-and-out already costs 3% to 6% of the stake, so a stop tighter than 5% would sell every copy
      stopPct: num(p.stopPct, 0) > 0 ? clamp(num(p.stopPct, 0), MIN_STOP_PCT, 90) : 0,
      // 11 Nov 2026 21:02 KST, enrique: "why a limit on amount of trades ... it makes sense maybe to stop if u lose hard".
      // No daily count unless the repo file sets one; the 0.5 SOL loss cap is the stop.
      maxPerDay: p.maxPerDay == null ? Number.MAX_SAFE_INTEGER : clamp(Math.floor(num(p.maxPerDay, 80)), 1, 1_000_000),
      minGapPct: clamp(num(p.minGapPct, 0), 0, 50),
      maxOpen: clamp(Math.floor(num(p.maxOpen, 1)), 1, HARD_MAX_OPEN),
      slippageBps: clamp(Math.floor(num(p.slippageBps, 1500)), 100, 3000),
      maxFeeLamports: clamp(Math.floor(num(p.maxFeeLamports, 1_000_000)), 10_000, 2_000_000),
    };
  } catch {
    return OFF;
  }
}
let cfgOverride: LiveConfig | null = null;
function cfg(): LiveConfig {
  if (cfgOverride) return cfgOverride;
  if (process.env.SOLANA_LIVE === "off") return OFF;
  try {
    return parseLive(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8"));
  } catch {
    return OFF;
  }
}

export interface Row {
  t: number;
  name: string;
  mint: string;
  leaderSlot: number;
  sentSlot?: number;
  landSlot?: number;
  slotsBehind?: number;
  /** ms from knowing of the wallet's buy to our order being sent, and its parts */
  pipelineMs?: number;
  quoteMs?: number;
  buildMs?: number;
  sendMs?: number;
  /** "interrupted": the bot restarted during the copy; the row is the clean-up after the restart */
  buy: "landed" | "failed on chain" | "did not land" | "not sent" | "interrupted";
  /** what the buy quote said we would pay over the wallet's price, %: known before the order is signed */
  quoteGapPct?: number;
  /** what we really paid over the wallet's price, % */
  fillGapPct?: number;
  sold?: boolean;
  sellTries?: number;
  heldSec?: number;
  /** how the position was closed: at the profit target, or because the time was up (absent = the old fixed hold) */
  exit?: "target" | "time" | "stop";
  /** the exit in force when the copy was bought, named like the paper rules ("tp10-t30", "tp10-sl20-t60") */
  exitKey?: string;
  /** when the coin began to be held, ms (several at once; older rows have only `t`, the moment the copy started) */
  heldAt?: number;
  /** the best a sale would have brought back while we held, % over the stake */
  bestPct?: number;
  /** sales tried at the target (one that fails, because the price fell back first, costs a fee and the watch goes on) */
  targetTries?: number;
  /**
   * The true result, every fee included. One at a time: the wallet's balance after minus before. Several at once:
   * what this copy's own transactions did to the wallet's SOL, read back from the chain.
   */
  netSol: number;
  /** several at once: transactions of this copy that landed but could not be read back (their SOL is not in netSol) */
  unread?: number;
  /** follower transactions that landed in an earlier slot than ours / no later than ours */
  ahead?: [number, number];
  error?: string;
  sigs: string[];
}

interface State {
  netSol: number;
  trades: number;
  day: string;
  dayCount: number;
  halted: string;
  note: string;
  balanceSol: number | null;
  /** buys left alone by the entry filter: the quote was not far enough above the wallet's price / no price to compare */
  skippedLowGap: number;
  skippedNoPrice: number;
  /** buys let go because a copy was under way, and because the last copy started under 10 s before */
  missedBusy: number;
  missedSpacing: number;
  /** rent that came back from closing left-over empty token accounts at a start, and how many: part of netSol, in no copy's row */
  rentBackSol: number;
  spareClosed: number;
  /** a copy that is under way or could not be closed: the token, the balance it is counted from, when, clean-up tries */
  open: { mint: string; bal0: number; t: number; tries: number; worthSol?: number; nowPct?: number; bestPct?: number } | null;
  /** several at once: the copies that are out. Each keeps the ids of its transactions not yet counted, so a restart can finish and count it. */
  opens: OpenPos[];
  /** several at once: the wallet's balance with nothing out, less the result so far; and wallet minus books at the last look with nothing out */
  baseSol: number | null;
  driftSol: number | null;
  /** buys let go because that coin was already held, and because the open copies left no room under the loss cap */
  missedSame: number;
  missedCap: number;
  /** buys let go because an update was about to restart the bot */
  missedRestart: number;
  /** buy orders that had to be built a second time (the price service answered 5xx the first time) */
  rebuilt?: number;
  unreadTx: number;
  rows: Row[];
}
interface OpenPos {
  mint: string;
  t: number;
  tries: number;
  sigs: string[];
  /** the coin is sold and its account closed; only `sigs` (landed, not readable yet) are still to be counted, into the row that began at rowT */
  done?: boolean;
  rowT?: number;
  worthSol?: number;
  nowPct?: number;
  bestPct?: number;
}
const fresh = (): State => ({ netSol: 0, trades: 0, day: "", dayCount: 0, halted: "", note: "", balanceSol: null, skippedLowGap: 0, skippedNoPrice: 0, missedBusy: 0, missedSpacing: 0, rentBackSol: 0, spareClosed: 0, open: null, opens: [], baseSol: null, driftSol: null, missedSame: 0, missedCap: 0, missedRestart: 0, unreadTx: 0, rows: [] });
let state: State = fresh();
let loaded = false;
let busy = false;
let lastAt = 0;
/** several at once: copies between their start and their marker being written; the coins they are for */
let entering = 0;
const enteringMints = new Set<string>();
/** open copies that a running flow is looking after (the rest are left from a restart or a sale that failed) */
const live = new Set<OpenPos>();
let recovering = false;
let recoverWaitMs = 5000;
/** the clean-up of empty token accounts is running: no copy starts meanwhile */
let sweeping = false;
/**
 * A restart is coming (every update restarts the bot): no new copy is started, so the ones that are out are sold
 * before the bot stops instead of being cut off and finished late. enrique, 11 Nov 2026 21:47 KST: "temporarily halt
 * new trades, wait for the trades to close and then send the update, after the update we resume trading". Not kept
 * on disk: the new bot starts trading again by itself.
 */
let quiet = false;
/** From now on no new copy is started; the copies that are out, and the recovery of left-over ones, carry on. */
export const solanaCopyLiveQuiet = () => void (quiet = true);
/**
 * What a stop right now would cut off, in plain words; "" when nothing of ours is in flight. A marker nobody is
 * working on (a coin that could not be sold, a transaction that could not be read back) does not count: the start
 * after a restart picks it up at once, sooner than waiting here would.
 */
export function solanaCopyLiveWaiting(): string {
  const coins = entering + live.size + (busy && state.open ? 1 : 0);
  if (coins) return `waiting for ${coins} open coin${coins === 1 ? "" : "s"}`;
  if (recovering) return "waiting for left-over coins to be sold";
  if (busy || sweeping) return "waiting for a step under way to finish";
  return "";
}
let walletReady = false;
let walletError = "";

function load() {
  loaded = true;
  let text: string;
  try {
    text = readFileSync(STATE(), "utf8");
  } catch {
    return; // no file yet: a fresh start
  }
  try {
    state = { ...state, ...(JSON.parse(text) as State) };
    if (!Array.isArray(state.opens)) state.opens = [];
  } catch {
    // a file that is there but unreadable must never restart the loss count from zero
    state.halted = "the state file could not be read: the loss count is unknown, so nothing trades";
  }
}
function save() {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(STATE() + ".tmp", JSON.stringify(state));
  renameSync(STATE() + ".tmp", STATE());
}

// ---- network (its own calls: never queued behind the paper test's requests) ---------------------------------------
async function rpc<T>(method: string, params: unknown[], ms = 6000): Promise<T> {
  const res = await shared.fetch()(shared.rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
  const j = (await res.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result as T;
}
async function jup<T>(path: string, body?: unknown): Promise<T> {
  const res = await shared.fetch()(`https://api.jup.ag${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-api-key": shared.jupiter(), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    // Jupiter's own error code says why (no route, coin not tradable...). Only capital letters and underscores are
    // taken over, so nothing else can ride along into the log or the status.
    const code = await (async () => String(((await res.json()) as { errorCode?: unknown })?.errorCode ?? ""))().catch(() => "");
    throw new Error(`jupiter ${path.split("?")[0]} http ${res.status}${/^[A-Z_]{3,40}$/.test(code) ? ` ${code}` : ""}`);
  }
  return (await res.json()) as T;
}
const quote = (inMint: string, outMint: string, amount: string, slippageBps: number) =>
  jup<{ outAmount?: string }>(`/swap/v1/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`);
async function swapTx(quoteResponse: unknown, address: string, maxLamports: number): Promise<string> {
  const j = await jup<{ swapTransaction?: string }>("/swap/v1/swap", {
    quoteResponse, userPublicKey: address, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports, priorityLevel: "veryHigh" } },
  });
  if (!j.swapTransaction) throw new Error("jupiter swap: no transaction");
  return j.swapTransaction;
}
/**
 * Build the buy order for a quote that passed the entry rule. The price service sometimes fails right here (http 5xx)
 * on a buy it has just priced: 4 buys were lost that way on 11 Nov 2026, at least 2 of them past the 9% rule. So one
 * more try, with a fresh quote that must pass the entry rule again (null = it no longer does: no copy). A second
 * failure is final. Nothing is signed or sent in here.
 */
async function buildBuy(q: { outAmount?: string }, b: StreamBuy, c: LiveConfig, address: string, row: Row): Promise<string | null> {
  try {
    return await swapTx(q, address, c.maxFeeLamports);
  } catch (e) {
    if (!/ http 5\d\d/.test(String((e as Error).message))) throw e;
    state.rebuilt = (state.rebuilt ?? 0) + 1;
    const again = await quote(SOL, b.mint, String(Math.round(c.stakeSol * 1e9)), c.slippageBps);
    if (!again.outAmount || again.outAmount === "0") throw e;
    const gap = b.leaderPrice > 0 && b.decimals !== undefined ? (c.stakeSol / (Number(again.outAmount) / 10 ** b.decimals) / b.leaderPrice - 1) * 100 : null;
    row.quoteGapPct = gap !== null && Number.isFinite(gap) ? Math.round(gap * 100) / 100 : undefined;
    if (c.minGapPct > 0 && !(row.quoteGapPct !== undefined && row.quoteGapPct >= c.minGapPct)) return null;
    return await swapTx(again, address, c.maxFeeLamports);
  }
}
/** Why a buy was never sent, in our own fixed words (the raw text stays in the server's file). */
const WHY_NOT: readonly [RegExp, string][] = [
  [/ http 429/, "the price service refused: too many requests"],
  [/quote http 4\d\d|no buy quote/, "the price service has no route for the coin"],
  [/swap http|no transaction/, "the price service could not build the order"],
  [/fetch failed|timeout|timed out|aborted|rpc/i, "network error or time-out"],
];
export const whyNotSent = (e = "") => WHY_NOT.find(([re]) => re.test(e))?.[1] ?? "other";
const send = (b64: string) => rpc<string>("sendTransaction", [b64, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]);
const balance = async (address: string) => (await rpc<{ value: number }>("getBalance", [address, { commitment: "processed" }])).value / 1e9;

/** Wait for a transaction to show up in a block. null = not seen in time. */
async function landed(sig: string, ms: number): Promise<{ slot: number; err: unknown } | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await rpc<{ value: ({ slot: number; err: unknown } | null)[] }>("getSignatureStatuses", [[sig]]).catch(() => null);
    const v = r?.value?.[0];
    if (v) return { slot: v.slot, err: v.err };
    await sleep(250);
  }
  return null;
}

interface Held {
  amount: bigint;
  decimals: number;
  accounts: { pubkey: string; program: string; amount: bigint }[];
}
async function held(address: string, mint: string): Promise<Held> {
  type Acc = { pubkey: string; account: { owner: string; data: { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } } } };
  const r = await rpc<{ value: Acc[] }>("getTokenAccountsByOwner", [address, { mint }, { encoding: "jsonParsed", commitment: "processed" }]);
  const accounts = r.value.map((a) => ({ pubkey: a.pubkey, program: a.account.owner, amount: BigInt(a.account.data.parsed.info.tokenAmount.amount) }));
  return { amount: accounts.reduce((s, a) => s + a.amount, 0n), decimals: r.value[0]?.account.data.parsed.info.tokenAmount.decimals ?? 6, accounts };
}

const dayOf = (t: number) => new Date(t + 9 * 3600_000).toISOString().slice(0, 10);

/** A transaction's id is its first signature: known before it is sent, so a send that errors can still be followed. */
const sigOf = (b64: string) => base58(Buffer.from(b64, "base64").subarray(1, 65));

/** Sell every unit of `mint` the wallet holds. True when none is left. Never throws. */
async function sellAll(w: Wallet, mint: string, maxFee: number, row: Row): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    try {
      const h = await held(w.address, mint);
      if (h.amount === 0n) return true;
      row.sellTries = (row.sellTries ?? 0) + 1;
      const q2 = await quote(mint, SOL, h.amount.toString(), Math.min(5000, 2000 + 600 * i));
      if (!q2.outAmount) throw new Error("no sell quote");
      const tx = signTransaction(await swapTx(q2, w.address, maxFee), w);
      row.sigs.push(sigOf(tx));
      if (state.opens.length) save(); // several at once: a restart must know every transaction of an open copy
      // a send whose answer got lost may still have gone out: the next pass looks at the wallet, never assumes
      await send(tx).catch((e) => void (row.error = scrub(String((e as Error).message))));
      await landed(sigOf(tx), 12_000);
      await sleep(400);
    } catch (e) {
      row.error = scrub(String((e as Error).message));
      await sleep(1000);
    }
  }
  for (let i = 0; i < 3; i++) {
    const h = await held(w.address, mint).catch(() => null);
    if (h) return h.amount === 0n;
    await sleep(1000);
  }
  return false;
}

/** How often the held position is priced, and how much of the quoted amount a target sale may give back. */
let pollMs = 750;
const TARGET_SLIP_BPS = 500;
export const MIN_STOP_PCT = 5;
/**
 * The stop needs this many looks in a row under its level (the looks are pollMs apart). One look can be a single bad
 * quote or a dip of a moment; paper only looks at 2, 5, 10, 20, 30 and 60 s, so it never sees those either.
 */
export const STOP_READINGS = 2;
/**
 * Most target sales tried per copy (MAIN review, 11 Nov 2026). A sale that fails on chain still pays its fee, and a
 * price hovering at the target could otherwise fail many times in a minute: three tries, then the copy waits for
 * the time stop. Keeps one copy's fees inside FEE_ROOM_SOL.
 */
export const MAX_TARGET_TRIES = 3;

/**
 * Hold a position until `until`: every pollMs ask what selling all of it would bring back now. With a target, sell
 * as soon as that is `targetPct` above the stake. That sale is built from the very quote that showed the profit and
 * may give back at most TARGET_SLIP_BPS of it: if the price fell back first it fails (one fee) and the watch goes on.
 * True = sold here. False = the time is up (or nothing could be priced): the caller sells at whatever the price is.
 * Never throws.
 */
async function watch(w: Wallet, mint: string, amount: bigint, c: LiveConfig, row: Row, until: number, pos?: OpenPos): Promise<boolean> {
  let under = 0;
  while (Date.now() < until) {
    const t = Date.now();
    try {
      const q = await quote(mint, SOL, amount.toString(), TARGET_SLIP_BPS);
      const out = Number(q.outAmount);
      if (out > 0 && c.stakeSol > 0) {
        const up = (out / 1e9 / c.stakeSol - 1) * 100;
        row.bestPct = Math.round(Math.max(row.bestPct ?? -100, up) * 10) / 10;
        if (pos) Object.assign(pos, { worthSol: Math.round(out / 1e3) / 1e6, nowPct: Math.round(up * 10) / 10, bestPct: row.bestPct });
        else if (state.open) state.open = { ...state.open, worthSol: Math.round(out / 1e3) / 1e6, nowPct: Math.round(up * 10) / 10, bestPct: row.bestPct };
        // the stop: nothing is sold in here. The watch ends early and the caller sells exactly as it does when the
        // time is up (fresh quote, wider slippage, several tries), because a falling coin must go, not be haggled over
        under = c.stopPct > 0 && up <= -c.stopPct ? under + 1 : 0;
        if (under >= STOP_READINGS) {
          row.exit = "stop";
          return false;
        }
        if (c.targetPct > 0 && up >= c.targetPct && (row.targetTries ?? 0) < MAX_TARGET_TRIES) {
          row.targetTries = (row.targetTries ?? 0) + 1;
          row.sellTries = (row.sellTries ?? 0) + 1;
          const tx = signTransaction(await swapTx(q, w.address, c.maxFeeLamports), w);
          row.sigs.push(sigOf(tx));
          if (state.opens.length) save();
          // as with every send: an answer that got lost proves nothing, so the wallet is looked at afterwards
          await send(tx).catch((e) => void (row.error = scrub(String((e as Error).message))));
          await landed(sigOf(tx), 8000);
          await sleep(300);
          const h = await held(w.address, mint);
          if (h.amount === 0n) {
            row.exit = "target";
            return true;
          }
          amount = h.amount;
        }
      }
    } catch (e) {
      row.error = scrub(String((e as Error).message));
    }
    await sleep(Math.max(50, pollMs - (Date.now() - t)));
  }
  return false;
}

/** Get an emptied token account's rent back (about 0.002 SOL each); best effort. */
async function closeEmpty(w: Wallet, mint: string, row: Row) {
  for (const a of (await held(w.address, mint).catch(() => ({ accounts: [] as Held["accounts"] }))).accounts.filter((x) => x.amount === 0n)) {
    try {
      const bh = (await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
      const cs = await send(buildSigned(w, bh, a.program, [{ pubkey: a.pubkey, writable: true }, { pubkey: w.address, writable: true }, { pubkey: w.address, writable: false }], [9]));
      row.sigs.push(cs);
      await landed(cs, 10_000);
    } catch {
      /* the rent stays in the account; counted as cost */
    }
  }
}

const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
/** The most accounts closed in one pass, and the accounts whose close did not go through (not tried again until a restart). */
const SPARE_MAX = 12;
const noClose = new Set<string>();
/**
 * Close the empty token accounts the wallet is left with, whatever coin they are for. A swap that is routed through
 * another coin opens an account for that coin and leaves it behind, and each one locks its rent (11 Nov 2026: ten
 * such accounts, about 0.015 SOL, found when enrique compared the wallet on Solscan with the dashboard). Closing an
 * account sends its rent back to the wallet. Only accounts that hold nothing and are not frozen: the chain itself
 * refuses to close one that holds anything. Best effort; returns how many were closed.
 */
async function closeSpare(w: Wallet, sigs: string[]): Promise<number> {
  sweeping = true;
  try {
    return await closeSpareNow(w, sigs);
  } finally {
    sweeping = false;
  }
}
async function closeSpareNow(w: Wallet, sigs: string[]): Promise<number> {
  type Acc = { pubkey: string; account: { owner: string; data: { parsed: { info: { mint?: string; state?: string; tokenAmount: { amount: string } } } } } };
  const empty: { pubkey: string; program: string }[] = [];
  // never the account of a coin that is out or being bought at this moment: its buy may be built on that account
  const inUse = (mint?: string) => !!mint && (state.open?.mint === mint || enteringMints.has(mint) || state.opens.some((o) => o.mint === mint));
  for (const programId of TOKEN_PROGRAMS) {
    const r = await rpc<{ value: Acc[] }>("getTokenAccountsByOwner", [w.address, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }]).catch(() => null);
    for (const a of r?.value ?? []) {
      const info = a.account.data.parsed.info;
      if (info.tokenAmount.amount === "0" && info.state !== "frozen" && !noClose.has(a.pubkey) && !inUse(info.mint)) empty.push({ pubkey: a.pubkey, program: a.account.owner });
    }
  }
  if (!empty.length) return 0;
  const sent: { pubkey: string; sig: string }[] = [];
  try {
    const bh = (await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
    for (const a of empty.slice(0, SPARE_MAX)) {
      const sig = await send(buildSigned(w, bh, a.program, [{ pubkey: a.pubkey, writable: true }, { pubkey: w.address, writable: true }, { pubkey: w.address, writable: false }], [9])).catch(() => null);
      if (sig) sent.push({ pubkey: a.pubkey, sig });
      else noClose.add(a.pubkey);
    }
  } catch {
    return 0; // no blockhash: nothing was sent, the next pass tries again
  }
  let closed = 0;
  for (const x of sent) {
    sigs.push(x.sig);
    const st = await landed(x.sig, 10_000);
    if (st && !st.err) closed++;
    else noClose.add(x.pubkey); // a close that fails costs a fee each time: once is enough
  }
  return closed;
}

/**
 * The clean-up on its own, at the start: whatever rent comes back is added to the result and kept apart from the
 * copies (rentBackSol), so that no single copy is credited with it. After this, the pass at the end of each copy
 * only returns what that copy itself locked.
 */
export async function tidy() {
  if (!loaded) load();
  if (!cfg().on || quiet || busy || state.open || state.opens.length || entering || recovering || !walletReady || !shared.helius()) return;
  busy = true;
  try {
    const w = wallet();
    const bal0 = await balance(w.address);
    const n = await closeSpare(w, []);
    if (!n) return;
    await sleep(800);
    const bal1 = await balance(w.address);
    const back = Math.round((bal1 - bal0) * 1e9) / 1e9;
    state.balanceSol = bal1;
    state.netSol = Math.round((state.netSol + back) * 1e9) / 1e9;
    state.rentBackSol = Math.round(((state.rentBackSol ?? 0) + back) * 1e9) / 1e9;
    state.spareClosed = (state.spareClosed ?? 0) + n;
  } catch {
    /* nothing booked: the balance could not be read, and the next copy's own count starts from the chain anyway */
  } finally {
    save();
    busy = false;
  }
}

function keep(row: Row) {
  state.rows.push(row);
  if (state.rows.length > 200) state.rows.shift();
  try {
    mkdirSync(join(DATA, "solana"), { recursive: true });
    appendFileSync(ROWS(), JSON.stringify(row) + "\n");
  } catch {
    /* state file still has it */
  }
}

/**
 * Book the wallet's change since `from` into the loss count. When the position is closed the open marker is dropped;
 * when it is not, the marker stays (counted up to the new balance) so the next start tries the sale again.
 */
async function settle(w: Wallet, row: Row, from: number, closed: boolean) {
  const bal1 = await balance(w.address);
  state.balanceSol = bal1;
  row.netSol = Math.round((bal1 - from) * 1e6) / 1e6;
  state.netSol = Math.round((state.netSol + row.netSol) * 1e6) / 1e6;
  if (closed) state.open = null;
  else if (state.open) state.open = { ...state.open, bal0: bal1 };
}

/** One real copy, start to finish. Never throws. */
export async function trade(b: StreamBuy) {
  if (!loaded) load();
  const c = cfg();
  if (!c.on || state.halted || !walletReady) return;
  if (quiet) return void (state.missedRestart = (state.missedRestart ?? 0) + 1);
  if (c.maxOpen > 1) return tradeMany(b, c);
  // one copy at a time: a buy that comes while another copy is under way is let go, and counted
  if (state.open || busy || state.opens.length || recovering) return void (state.missedBusy = (state.missedBusy ?? 0) + 1);
  if (!shared.helius() || !shared.jupiter()) return void (state.note = "needs both API keys");
  if (Date.now() - lastAt < 10_000) return void (state.missedSpacing = (state.missedSpacing ?? 0) + 1);
  const day = dayOf(Date.now());
  if (day !== state.day) {
    state.day = day;
    state.dayCount = 0;
  }
  if (state.dayCount >= c.maxPerDay) return void (state.note = "daily count reached");
  if (state.note === "daily count reached") state.note = "";
  // the most one copy can cost: the stake plus every fee of one buy, six sale tries and an unclosed token account
  if (-state.netSol + c.stakeSol + FEE_ROOM_SOL > c.maxLossSol) {
    state.halted = `loss cap reached: ${(-state.netSol).toFixed(4)} of ${c.maxLossSol} SOL`;
    save();
    return;
  }
  busy = true;
  const prevAt = lastAt;
  lastAt = Date.now();
  const w = wallet();
  const row: Row = { t: Date.now(), name: b.name, mint: b.mint, leaderSlot: b.leaderSlot, buy: "not sent", exitKey: exitKey(c), netSol: 0, sigs: [] };
  let bal0: number | null = null;
  let sent = false;
  let closed = true;
  try {
    bal0 = await balance(w.address);
    state.balanceSol = bal0;
    if (bal0 < c.stakeSol + 0.02) {
      state.note = "wallet balance too low for a copy";
      return;
    }
    // The transactions come from an API and are signed unread, so what is at risk is whatever the wallet holds:
    // with more in it than was agreed, nothing trades.
    if (bal0 > walletLimit()) {
      state.note = tooMuch();
      return;
    }
    state.note = "";
    const t0 = performance.now();
    const q = await quote(SOL, b.mint, String(Math.round(c.stakeSol * 1e9)), c.slippageBps);
    if (!q.outAmount || q.outAmount === "0") throw new Error("no buy quote");
    // how far this quote already is above what the wallet paid: known here, before anything is signed
    const gap = b.leaderPrice > 0 && b.decimals !== undefined ? (c.stakeSol / (Number(q.outAmount) / 10 ** b.decimals) / b.leaderPrice - 1) * 100 : null;
    if (gap !== null && Number.isFinite(gap)) row.quoteGapPct = Math.round(gap * 100) / 100;
    if (c.minGapPct > 0 && !(row.quoteGapPct !== undefined && row.quoteGapPct >= c.minGapPct)) {
      // the entry filter said no: nothing was sent, so it is not a copy, costs nothing and does not delay the next buy
      if (row.quoteGapPct === undefined) state.skippedNoPrice++;
      else state.skippedLowGap++;
      lastAt = prevAt;
      return;
    }
    const t1 = performance.now();
    const built = await buildBuy(q, b, c, w.address, row);
    if (built === null) {
      // the order could not be built, and the fresh price no longer passes the entry rule: no copy
      if (row.quoteGapPct === undefined) state.skippedNoPrice++;
      else state.skippedLowGap++;
      lastAt = prevAt;
      return;
    }
    const tx = signTransaction(built, w);
    const t2 = performance.now();
    const sig = sigOf(tx);
    // Written to disk before the order leaves: a restart in the middle (every deploy restarts the bot) finds this
    // marker and sells, and the count of copies can never start again from zero.
    state.open = { mint: b.mint, bal0, t: Date.now(), tries: 0 };
    state.trades++;
    state.dayCount++;
    sent = true;
    save();
    row.sigs.push(sig);
    row.sentSlot = shared.slot();
    // sent once, never again: if the answer is lost the order may still be out, so it is followed by its id
    await send(tx).catch((e) => void (row.error = scrub(String((e as Error).message))));
    row.quoteMs = Math.round(t1 - t0);
    row.buildMs = Math.round(t2 - t1);
    row.sendMs = Math.round(performance.now() - t2);
    row.pipelineMs = Date.now() - b.knownMs;
    const st = await landed(sig, 20_000);
    if (st && !st.err) {
      row.buy = "landed";
      row.landSlot = st.slot;
      row.slotsBehind = st.slot - b.leaderSlot;
    } else {
      row.buy = st ? "failed on chain" : "did not land";
      if (!st) await sleep(45_000); // its blockhash can still be valid: make sure it did not land late
    }
    let h = await held(w.address, b.mint);
    for (let i = 0; i < 10 && row.buy === "landed" && h.amount === 0n; i++) {
      await sleep(300);
      h = await held(w.address, b.mint);
    }
    if (h.amount > 0n) {
      if (b.leaderPrice > 0) row.fillGapPct = Math.round((c.stakeSol / (Number(h.amount) / 10 ** h.decimals) / b.leaderPrice - 1) * 10000) / 100;
      const heldFrom = Date.now();
      if (await watch(w, b.mint, h.amount, c, row, heldFrom + c.holdSec * 1000)) row.sold = true;
      else {
        if (c.targetPct > 0 && row.exit !== "stop") row.exit = "time";
        row.sold = await sellAll(w, b.mint, c.maxFeeLamports, row);
      }
      row.heldSec = Math.round((Date.now() - heldFrom) / 100) / 10;
      if (!row.sold) {
        closed = false;
        state.halted = STUCK;
      }
    }
    if (closed) {
      await closeEmpty(w, b.mint, row);
      // and any account a routed swap left behind, so its rent is back before this copy is counted
      await closeSpare(w, row.sigs).catch(() => 0);
    }
  } catch (e) {
    row.error = scrub(String((e as Error).message));
    // whatever went wrong, never leave without knowing whether we hold the token
    if (sent) {
      const left = await held(w.address, b.mint).catch(() => null);
      // "empty" is only believed when the buy is known not to have landed; otherwise the clean-up looks again later
      if (!left || left.amount > 0n || (row.buy !== "failed on chain" && row.buy !== "did not land")) {
        closed = false;
        state.halted = STUCK;
      }
    }
  } finally {
    try {
      if (bal0 !== null && sent) {
        await sleep(800);
        await settle(w, row, bal0, closed);
      }
    } catch {
      // the marker stays, so the next start settles from the same starting balance
      state.halted = state.halted || "could not read the wallet balance after a copy";
    }
    if (sent || row.error) keep(row);
    save();
    busy = false;
  }
  // where we stood in the queue: counted once the wave has passed
  if (row.landSlot) {
    void (async () => {
      await sleep(Math.max(0, b.knownMs + 75_000 - Date.now()));
      const wave = await shared.waveAfter(b.mint, b.sig, b.leaderSlot).catch(() => null);
      if (!wave) return;
      const ok = wave.filter((x) => x.ok && !row.sigs.includes(x.sig));
      row.ahead = [ok.filter((x) => x.slot < row.landSlot!).length, ok.filter((x) => x.slot <= row.landSlot!).length];
      save();
    })();
  }
}

/**
 * After a start: if the last run stopped with a copy under way (or a sale that failed), finish it. Sells whatever is
 * left of that token, books the result from the balance the copy started with, and only then lets copies resume.
 * At most MAX_RECOVERIES tries per position, so a token that cannot be sold cannot keep costing fees.
 */
export async function recover() {
  if (!loaded) load();
  const o = state.open;
  if (!o || busy || !walletReady) return;
  if (o.tries >= MAX_RECOVERIES) {
    state.halted = state.halted || STUCK;
    return;
  }
  busy = true;
  const row: Row = { t: Date.now(), name: "", mint: o.mint, leaderSlot: 0, buy: "interrupted", netSol: 0, sigs: [] };
  try {
    // the interrupted buy may still be on its way: wait until it can no longer land
    await sleep(Math.max(5000, o.t + 90_000 - Date.now()));
    if (!shared.helius() || !shared.jupiter()) return void (state.note = "a copy was interrupted and needs both API keys to be finished");
    const w = wallet();
    state.open = { ...o, tries: o.tries + 1 };
    save();
    row.sold = await sellAll(w, o.mint, 1_000_000, row);
    if (row.sold) await closeEmpty(w, o.mint, row);
    await sleep(800);
    await settle(w, row, o.bal0, row.sold);
    if (row.sold) {
      if (state.halted === STUCK || state.halted.startsWith("could not read the wallet balance")) state.halted = "";
    } else state.halted = STUCK;
    keep(row);
  } catch (e) {
    row.error = scrub(String((e as Error).message));
    state.halted = state.halted || STUCK;
  } finally {
    save();
    busy = false;
  }
}


// ---- several coins at once -----------------------------------------------------------------------------------------
// enrique, 11 Nov 2026 21:25 KST: "im cool with 5 at a time ... feels like if we limit the amount of positions open,
// we skip a lot ... we have to test". Switched on by "maxOpen" above 1 in the repo file; with 1 nothing here runs.
//
// What changes against one at a time:
//  - The result of a copy can no longer be "the wallet after minus before", because other copies move the balance
//    in between. It is read back from the chain instead: for each of the copy's own transactions that landed (the
//    buy, every sale try, the account close), the wallet's SOL after minus before that transaction. A transaction
//    that never landed cost nothing.
//  - The books are still checked against the wallet: whenever nothing is out, wallet minus (start + result so far)
//    is kept as driftSol and shown (booksVsWalletSol). It is shown, never folded in: money somebody sends to the
//    wallet must not turn into profit or lift the cap.
//  - The loss cap must hold even if every copy that is out, and the new one, is lost in full, so the number of
//    copies that may be out shrinks as the loss grows. With nothing out the rule is the same as before.
//  - One copy of a coin at a time: a sale sells all of that coin the wallet holds.
type TxRead = { meta: { preBalances: number[]; postBalances: number[] } | null; transaction: { message: { accountKeys: (string | { pubkey: string })[] } } };
/** What these transactions of ours did to the wallet's SOL (fees and rent included), and how many that landed could not be read. */
async function booked(w: Wallet, sigs: string[]): Promise<{ sol: number; unread: string[] }> {
  const list = [...new Set(sigs)];
  if (!list.length) return { sol: 0, unread: [] };
  let st: { value: (unknown | null)[] } | null = null;
  for (let k = 0; k < 4 && !st; k++) {
    st = await rpc<{ value: (unknown | null)[] }>("getSignatureStatuses", [list, { searchTransactionHistory: true }]).catch(() => null);
    if (!st) await sleep(400);
  }
  if (!st) return { sol: 0, unread: list };
  let lamports = 0;
  const unread: string[] = [];
  for (let i = 0; i < list.length; i++) {
    if (!st.value[i]) continue; // never landed: it cost nothing
    let d: number | null = null;
    for (let k = 0; k < 8 && d === null; k++) {
      const tx = await rpc<TxRead | null>("getTransaction", [list[i], { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]).catch(() => null);
      const at = tx?.meta ? tx.transaction.message.accountKeys.map((x) => (typeof x === "string" ? x : x.pubkey)).indexOf(w.address) : -1;
      if (tx?.meta && at >= 0) d = tx.meta.postBalances[at] - tx.meta.preBalances[at];
      else await sleep(400);
    }
    if (d === null) unread.push(list[i]);
    else lamports += d;
  }
  return { sol: Math.round(lamports) / 1e9, unread }; // to the lamport: these books are checked against the wallet
}

/**
 * Add a copy's own transactions to the books. Returns the ids of those that landed but could not be read back yet:
 * the caller leaves them on the copy's marker, and the next pass over left-over copies reads and counts them, so
 * the books cannot stay short of the chain.
 */
async function book(w: Wallet, row: Row, sigs: string[] = row.sigs): Promise<string[]> {
  const r = await booked(w, sigs);
  row.netSol = r.sol;
  if (r.unread.length) {
    row.unread = r.unread.length;
    state.unreadTx = (state.unreadTx ?? 0) + r.unread.length;
  }
  state.netSol = Math.round((state.netSol + row.netSol) * 1e9) / 1e9;
  return r.unread;
}

/** With nothing out: how far the wallet is from the books. Only looked at, never corrected. */
async function check(w: Wallet) {
  if (state.opens.length || entering || state.baseSol == null) return;
  const bal = await balance(w.address).catch(() => null);
  if (bal === null || state.opens.length || entering) return;
  state.balanceSol = bal;
  state.driftSol = Math.round((bal - state.baseSol - state.netSol) * 1e9) / 1e9;
}

/** One real copy while others may be out. Never throws. */
async function tradeMany(b: StreamBuy, c: LiveConfig) {
  // a copy from before the switch, the clean-up, or left-over copies being finished: wait for them
  if (state.open || busy || recovering || sweeping) return void (state.missedBusy = (state.missedBusy ?? 0) + 1);
  if (state.opens.length + entering >= c.maxOpen) return void (state.missedBusy = (state.missedBusy ?? 0) + 1);
  if (enteringMints.has(b.mint) || state.opens.some((o) => o.mint === b.mint)) return void (state.missedSame = (state.missedSame ?? 0) + 1);
  if (!shared.helius() || !shared.jupiter()) return void (state.note = "needs both API keys");
  if (Date.now() - lastAt < MANY_GAP_MS) return void (state.missedSpacing = (state.missedSpacing ?? 0) + 1);
  const day = dayOf(Date.now());
  if (day !== state.day) {
    state.day = day;
    state.dayCount = 0;
  }
  if (state.dayCount >= c.maxPerDay) return void (state.note = "daily count reached");
  if (state.note === "daily count reached") state.note = "";
  const out = state.opens.length + entering;
  if (-state.netSol + c.stakeSol + FEE_ROOM_SOL > c.maxLossSol) {
    // the same stop as one at a time; set once nothing is out, so the open copies are finished first
    if (!out) {
      state.halted = `loss cap reached: ${(-state.netSol).toFixed(4)} of ${c.maxLossSol} SOL`;
      save();
    }
    return;
  }
  // every copy that is out, and this one, lost in full: the cap must still hold
  if (-state.netSol + (out + 1) * (c.stakeSol + FEE_ROOM_SOL) > c.maxLossSol) return void (state.missedCap = (state.missedCap ?? 0) + 1);
  entering++;
  enteringMints.add(b.mint);
  let queued = true;
  const leave = () => {
    if (!queued) return;
    queued = false;
    entering--;
    enteringMints.delete(b.mint);
  };
  const prevAt = lastAt;
  lastAt = Date.now();
  const w = wallet();
  const row: Row = { t: Date.now(), name: b.name, mint: b.mint, leaderSlot: b.leaderSlot, buy: "not sent", exitKey: exitKey(c), netSol: 0, sigs: [] };
  let pos: OpenPos | null = null;
  let closed = true;
  try {
    const bal0 = await balance(w.address);
    state.balanceSol = bal0;
    if (bal0 < c.stakeSol + 0.02) {
      state.note = "wallet balance too low for a copy";
      return;
    }
    if (bal0 > walletLimit()) {
      state.note = tooMuch();
      return;
    }
    // the start the books are checked against: the balance with nothing out, less the result so far
    if (state.baseSol == null && !state.opens.length && entering === 1) state.baseSol = Math.round((bal0 - state.netSol) * 1e9) / 1e9;
    state.note = "";
    const t0 = performance.now();
    const q = await quote(SOL, b.mint, String(Math.round(c.stakeSol * 1e9)), c.slippageBps);
    if (!q.outAmount || q.outAmount === "0") throw new Error("no buy quote");
    const gap = b.leaderPrice > 0 && b.decimals !== undefined ? (c.stakeSol / (Number(q.outAmount) / 10 ** b.decimals) / b.leaderPrice - 1) * 100 : null;
    if (gap !== null && Number.isFinite(gap)) row.quoteGapPct = Math.round(gap * 100) / 100;
    if (c.minGapPct > 0 && !(row.quoteGapPct !== undefined && row.quoteGapPct >= c.minGapPct)) {
      if (row.quoteGapPct === undefined) state.skippedNoPrice++;
      else state.skippedLowGap++;
      lastAt = prevAt;
      return;
    }
    const t1 = performance.now();
    const built = await buildBuy(q, b, c, w.address, row);
    if (built === null) {
      // the order could not be built, and the fresh price no longer passes the entry rule: no copy
      if (row.quoteGapPct === undefined) state.skippedNoPrice++;
      else state.skippedLowGap++;
      lastAt = prevAt;
      return;
    }
    const tx = signTransaction(built, w);
    const t2 = performance.now();
    const sig = sigOf(tx);
    // written to disk before the order leaves, with the order's id: a restart finds it, sells, and counts it
    row.sigs.push(sig);
    pos = { mint: b.mint, t: Date.now(), tries: 0, sigs: row.sigs };
    state.opens.push(pos);
    live.add(pos);
    state.trades++;
    state.dayCount++;
    save();
    leave();
    row.sentSlot = shared.slot();
    await send(tx).catch((e) => void (row.error = scrub(String((e as Error).message))));
    row.quoteMs = Math.round(t1 - t0);
    row.buildMs = Math.round(t2 - t1);
    row.sendMs = Math.round(performance.now() - t2);
    row.pipelineMs = Date.now() - b.knownMs;
    const st = await landed(sig, 20_000);
    if (st && !st.err) {
      row.buy = "landed";
      row.landSlot = st.slot;
      row.slotsBehind = st.slot - b.leaderSlot;
    } else {
      row.buy = st ? "failed on chain" : "did not land";
      if (!st) await sleep(45_000); // its blockhash can still be valid: make sure it did not land late
    }
    let h = await held(w.address, b.mint);
    for (let i = 0; i < 10 && row.buy === "landed" && h.amount === 0n; i++) {
      await sleep(300);
      h = await held(w.address, b.mint);
    }
    if (h.amount > 0n) {
      if (b.leaderPrice > 0) row.fillGapPct = Math.round((c.stakeSol / (Number(h.amount) / 10 ** h.decimals) / b.leaderPrice - 1) * 10000) / 100;
      const heldFrom = Date.now();
      row.heldAt = heldFrom;
      if (await watch(w, b.mint, h.amount, c, row, heldFrom + c.holdSec * 1000, pos)) row.sold = true;
      else {
        if (c.targetPct > 0 && row.exit !== "stop") row.exit = "time";
        row.sold = await sellAll(w, b.mint, c.maxFeeLamports, row);
      }
      row.heldSec = Math.round((Date.now() - heldFrom) / 100) / 10;
      if (!row.sold) {
        closed = false;
        state.halted = STUCK;
      }
    }
    if (closed) {
      await closeEmpty(w, b.mint, row);
      // the left-over accounts of routed swaps: only when this is the last copy out
      if (state.opens.length === 1 && !entering) await closeSpare(w, row.sigs).catch(() => 0);
    }
  } catch (e) {
    row.error = scrub(String((e as Error).message));
    if (pos) {
      const left = await held(w.address, b.mint).catch(() => null);
      if (!left || left.amount > 0n || (row.buy !== "failed on chain" && row.buy !== "did not land")) {
        closed = false;
        state.halted = STUCK;
      }
    }
  } finally {
    leave();
    if (pos) {
      const mine = pos;
      await sleep(800);
      // counted up to here; what could not be read stays on the marker, and whoever finishes it counts the rest
      const later = await book(w, row, [...row.sigs]).catch(() => [...row.sigs]);
      mine.sigs = later;
      if (closed && !later.length) state.opens = state.opens.filter((o) => o !== mine);
      else if (closed) Object.assign(mine, { done: true, rowT: row.t });
      live.delete(mine);
      if (state.opens.includes(mine)) setTimeout(() => void recoverMany(), 20_000).unref();
    }
    if (pos || row.error) keep(row);
    save();
    await check(w).catch(() => undefined);
    save();
  }
  if (row.landSlot) {
    void (async () => {
      await sleep(Math.max(0, b.knownMs + 75_000 - Date.now()));
      const wave = await shared.waveAfter(b.mint, b.sig, b.leaderSlot).catch(() => null);
      if (!wave) return;
      const ok = wave.filter((x) => x.ok && !row.sigs.includes(x.sig));
      row.ahead = [ok.filter((x) => x.slot < row.landSlot!).length, ok.filter((x) => x.slot <= row.landSlot!).length];
      save();
    })();
  }
}

/** Finish the copies no running flow is looking after: left from a restart, or whose sale failed. One after the other. */
export async function recoverMany() {
  if (!loaded) load();
  if (recovering || busy || !walletReady) return;
  const left = state.opens.filter((o) => !live.has(o));
  if (!left.length) return;
  recovering = true;
  try {
    for (const o of left) {
      if (o.done) {
        // sold and closed already: only read what could not be read then, and add it to that copy's own row
        o.tries++;
        const r = await booked(wallet(), o.sigs);
        const row = state.rows.find((x) => x.t === o.rowT && x.mint === o.mint);
        if (row) {
          row.netSol = Math.round((row.netSol + r.sol) * 1e9) / 1e9;
          if (r.unread.length) row.unread = r.unread.length;
          else delete row.unread;
        }
        state.netSol = Math.round((state.netSol + r.sol) * 1e9) / 1e9;
        o.sigs = r.unread;
        if (!r.unread.length) state.opens = state.opens.filter((x) => x !== o);
        else if (o.tries >= MAX_RECOVERIES) state.halted = state.halted || UNREAD;
        save();
        continue;
      }
      if (o.tries >= MAX_RECOVERIES) {
        state.halted = state.halted || STUCK;
        continue;
      }
      // the row and the marker share one list, so every new transaction id is on disk before it is sent
      const row: Row = { t: Date.now(), name: "", mint: o.mint, leaderSlot: 0, buy: "interrupted", netSol: 0, sigs: o.sigs };
      try {
        // the interrupted buy may still be on its way: wait until it can no longer land
        await sleep(Math.max(recoverWaitMs, o.t + 90_000 - Date.now()));
        if (!shared.helius() || !shared.jupiter()) {
          state.note = "a copy was interrupted and needs both API keys to be finished";
          continue;
        }
        const w = wallet();
        o.tries++;
        save();
        row.sold = await sellAll(w, o.mint, 1_000_000, row);
        if (row.sold) await closeEmpty(w, o.mint, row);
        await sleep(800);
        const later = await book(w, row, [...row.sigs]);
        row.sigs = [...row.sigs];
        o.sigs = later;
        if (row.sold && !later.length) state.opens = state.opens.filter((x) => x !== o);
        else if (row.sold) Object.assign(o, { done: true, rowT: row.t });
        if (!row.sold) state.halted = STUCK;
        keep(row);
      } catch (e) {
        row.error = scrub(String((e as Error).message));
        state.halted = state.halted || STUCK;
      }
      save();
    }
    if (!state.opens.length && (state.halted === STUCK || state.halted === UNREAD || state.halted.startsWith("could not read the wallet balance"))) state.halted = "";
    await check(wallet()).catch(() => undefined);
  } finally {
    save();
    recovering = false;
  }
}

const openOf = (o: { t: number; tries: number; worthSol?: number; nowPct?: number; bestPct?: number } | null, c: LiveConfig) =>
  o ? { stakeSol: c.stakeSol || HARD_STAKE_SOL, heldSec: Math.max(0, Math.round((Date.now() - o.t) / 1000)), tries: o.tries, worthSol: o.worthSol ?? null, nowPct: o.nowPct ?? null, bestPct: o.bestPct ?? null } : null;
const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1] : null);
const nums = (xs: (number | undefined)[]) => xs.filter((x): x is number => typeof x === "number");

/**
 * For the status: numbers only. No address, token or signature. The one thing that could identify the wallet, the
 * time of each copy (recent[].at), is shown on the password-protected dashboard and removed from the public file.
 */
/** The exit of a config in the paper rules' own words: "tp10-t30", "tp10-sl20-t60", "t6" (no target). */
export const exitKey = (c: Pick<LiveConfig, "targetPct" | "stopPct" | "holdSec">) =>
  `${c.targetPct > 0 ? `tp${c.targetPct}-` : ""}${c.stopPct > 0 ? `sl${c.stopPct}-` : ""}t${c.holdSec}`;

/** Entry-gap bars the copies are counted between (%), from the entry rule in force upward. */
export const GAP_BARS = [12, 15, 20, 30] as const;

/** One group of copies in numbers: how many, how many won, what they made, target sales and time-ups apart. */
function tally(list: Row[]) {
  const sol = (l: Row[]) => Math.round(l.reduce((a, r) => a + r.netSol, 0) * 1e6) / 1e6;
  const [hit, late, cut] = (["target", "time", "stop"] as const).map((x) => list.filter((r) => r.exit === x));
  return { copies: list.length, won: list.filter((r) => r.netSol > 0).length, netSol: sol(list), targetSales: hit.length, targetSalesSol: sol(hit), timeUps: late.length, timeUpsSol: sol(late), stops: cut.length, stopsSol: sol(cut) };
}

/**
 * How often coins were really held side by side, from the rows kept (enrique, 11 Nov 2026 23:07 KST: "so far i
 * havent see us holding more than 1 position, are we sure there's no blockers?"). An overlap lasts seconds, so it is
 * easy to miss on the dashboard: this counts them. A row from before `heldAt` was written is placed from its start
 * plus the time the order took, which is good to about a second.
 */
export function heldTogether(rows: Row[]) {
  const spans = rows
    .filter((r) => r.heldSec !== undefined)
    .map((r) => {
      const from = r.heldAt ?? r.t + Math.min(8000, Math.max(0, r.pipelineMs ?? 0)) + 1500;
      return [from, from + r.heldSec! * 1000] as const;
    })
    .sort((x, y) => x[0] - y[0]);
  let pairs = 0;
  let most = 0;
  spans.forEach((x, i) => {
    // the coins out at the moment this one began; and the later ones that began before this one was sold
    most = Math.max(most, spans.filter((y) => y[0] <= x[0] && x[0] < y[1]).length);
    for (let j = i + 1; j < spans.length && spans[j][0] < x[1]; j++) pairs++;
  });
  return { copies: spans.length, most, pairs };
}

export function solanaCopyLiveSummary() {
  if (!loaded) load();
  const c = cfg();
  const rows = state.rows;
  const land = rows.filter((r) => r.buy === "landed");
  // the copies made since the exit became "target or time", counted apart from the fixed-hold ones before them
  const aimed = rows.filter((r) => r.exit);
  const unsent = rows.filter((r) => r.buy === "not sent");
  // sent with a price gap on file that passes the entry rule in force (a rule changed later re-reads the old rows)
  const gapped = rows.filter((r) => r.buy !== "not sent" && r.quoteGapPct !== undefined && r.quoteGapPct >= c.minGapPct);
  const sol = (list: Row[]) => Math.round(list.reduce((a, r) => a + r.netSol, 0) * 1e6) / 1e6;
  return {
    mode: "REAL",
    on: c.on && !state.halted && walletReady,
    switch: c.on ? "on" : "off",
    halted: state.halted,
    note: state.note || walletError,
    // set only in the last minute or so before an update restarts the bot: no new copy is started and the restart
    // waits for the coins that are out, so it is never a silent stop
    restartPending: quiet ? `restart pending: ${solanaCopyLiveWaiting() || "nothing open"}` : null,
    walletReady,
    stakeSol: c.stakeSol || HARD_STAKE_SOL,
    capSol: c.maxLossSol || HARD_MAX_LOSS_SOL,
    netSol: state.netSol,
    balanceSol: state.balanceSol,
    openPosition: state.open != null || state.opens.length > 0,
    // how many coins may be held at once, and how many are out now
    maxOpen: c.maxOpen,
    openCount: (state.open ? 1 : 0) + state.opens.length,
    // of the copies kept that held a coin: the most coins out at one moment, and the pairs that were out together
    heldTogether: heldTogether(rows),
    entryRule: c.minGapPct > 0 ? `buys only when our price is already ${c.minGapPct}% or more above what the wallet paid` : "buys every first buy of a listed wallet",
    skippedLowGap: state.skippedLowGap,
    skippedNoPrice: state.skippedNoPrice,
    // buys that were never looked at: a copy was under way (one coin at a time) / the last copy began under 10 s before
    missedWhileBusy: state.missedBusy ?? 0,
    missedSpacing: state.missedSpacing ?? 0,
    // rent returned by closing left-over empty token accounts: inside netSol, outside every copy's own result
    rentBackSol: state.rentBackSol ?? 0,
    spareAccountsClosed: state.spareClosed ?? 0,
    dailyLimit: c.on && c.maxPerDay < Number.MAX_SAFE_INTEGER ? c.maxPerDay : null,
    exitRule: `${c.targetPct > 0 ? `sells at +${c.targetPct}% or after ${c.holdSec} s` : `sells after ${c.holdSec} s`}${c.stopPct > 0 ? `, and sooner if it is ${c.stopPct}% down` : ""}`,
    // the same rule in numbers, for a countdown and a price bar on the dashboard (0 = no target / no stop)
    exit: { targetPct: c.targetPct, holdSec: c.holdSec, stopPct: c.stopPct },
    /**
     * What is held right now, in numbers only (the dashboard's "holding now" block reads these names). The token is
     * left out on purpose: a token and a moment are enough to find our transaction, and with it the wallet.
     * worthSol = what selling it all would bring back at the last look.
     */
    open: openOf(state.open ?? state.opens[0] ?? null, c),
    /** several at once: every coin that is out, oldest first, in the same numbers (no token) */
    opens: (state.open ? [state.open, ...state.opens] : state.opens).map((o) => openOf(o, c)),
    /**
     * Several at once: wallet minus books (start + result so far) at the last look with nothing out. 0 = every
     * lamport is accounted for. Not the balance itself. unreadTx = transactions that had to be read back later.
     */
    booksVsWalletSol: state.driftSol ?? null,
    unreadTx: state.unreadTx ?? 0,
    // buys let go because that coin was already held / because the open copies left no room under the loss cap
    missedSameCoin: state.missedSame ?? 0,
    missedNearCap: state.missedCap ?? 0,
    // buys let go in the last minute or so before an update restarted the bot (so that no copy is cut off)
    missedBeforeRestart: state.missedRestart ?? 0,
    // buy orders the price service failed to build at first (http 5xx) and that were tried once more
    rebuiltBuys: state.rebuilt ?? 0,
    // buys that were never sent (nothing bought, no fee), with the reason in fixed words
    notSent: { n: unsent.length, why: unsent.reduce<Record<string, number>>((a, r) => ((a[whyNotSent(r.error)] = (a[whyNotSent(r.error)] ?? 0) + 1), a), {}) },
    // The copies made under the entry rule in force, counted here over every row kept (the last 200), because the
    // rows in `recent` are only the last 40. Target sales and time-ups with their own sums, like targetExit.
    entryRuleCopies: c.minGapPct > 0 ? {
      minGapPct: c.minGapPct,
      copies: gapped.length,
      landed: gapped.filter((r) => r.buy === "landed").length,
      won: gapped.filter((r) => r.netSol > 0).length,
      netSol: sol(gapped),
      targetSales: gapped.filter((r) => r.exit === "target").length,
      targetSalesSol: sol(gapped.filter((r) => r.exit === "target")),
      timeUps: gapped.filter((r) => r.exit === "time").length,
      timeUpsWon: gapped.filter((r) => r.exit === "time" && r.netSol > 0).length,
      timeUpsSol: sol(gapped.filter((r) => r.exit === "time")),
      stops: gapped.filter((r) => r.exit === "stop").length,
      stopsSol: sol(gapped.filter((r) => r.exit === "stop")),
      otherSol: sol(gapped.filter((r) => r.exit !== "target" && r.exit !== "time" && r.exit !== "stop")),
      rowsKept: rows.length,
      // The same copies by how far above the wallet's price the buy quote was (toPct null = no upper end): a
      // stricter entry rule is judged on these, next to the paper rules gap12, gap15, gap20, gap30.
      byGap: [c.minGapPct, ...GAP_BARS.filter((g) => g > c.minGapPct)].map((from, i, bars) => {
        const to = bars[i + 1] ?? null;
        return { fromPct: from, toPct: to, ...tally(gapped.filter((r) => r.quoteGapPct! >= from && (to === null || r.quoteGapPct! < to))) };
      }),
      // ... and by the exit in force when each was bought, so that a change of clock or stop is counted on its own
      // copies. "earlier" = bought before the exit was written on the row (11 Nov 2026 late evening KST).
      byExit: [...new Set(gapped.map((r) => r.exitKey ?? "earlier"))].map((k) => ({ exit: k, ...tally(gapped.filter((r) => (r.exitKey ?? "earlier") === k)) })),
    } : null,
    targetExit: {
      copies: aimed.length,
      atTarget: aimed.filter((r) => r.exit === "target").length,
      atTimeUp: aimed.filter((r) => r.exit === "time").length,
      atStop: aimed.filter((r) => r.exit === "stop").length,
      won: aimed.filter((r) => r.netSol > 0).length,
      netSol: Math.round(aimed.reduce((a, r) => a + r.netSol, 0) * 1e6) / 1e6,
      bestPctMedian: med(nums(aimed.map((r) => r.bestPct))),
      missedTargetSales: aimed.reduce((a, r) => a + Math.max(0, (r.targetTries ?? 0) - (r.exit === "target" ? 1 : 0)), 0),
    },
    copies: rows.filter((r) => r.buy !== "not sent").length,
    landed: land.length,
    notLanded: rows.filter((r) => r.buy === "did not land" || r.buy === "failed on chain").length,
    won: rows.filter((r) => r.netSol > 0).length,
    sameBlock: land.filter((r) => r.slotsBehind === 0).length,
    nextBlock: land.filter((r) => r.slotsBehind === 1).length,
    slotsBehindMedian: med(nums(land.map((r) => r.slotsBehind))),
    aheadMedian: med(nums(land.map((r) => r.ahead?.[0]))),
    pipelineMsMedian: med(nums(rows.map((r) => r.pipelineMs))),
    quoteMsMedian: med(nums(rows.map((r) => r.quoteMs))),
    buildMsMedian: med(nums(rows.map((r) => r.buildMs))),
    sendMsMedian: med(nums(rows.map((r) => r.sendMs))),
    // copies whose last error was a refusal for asking too fast (several coins priced at once ask more often)
    rateLimited: rows.filter((r) => /http 429/.test(r.error ?? "")).length,
    fillGapPctMedian: med(nums(land.map((r) => r.fillGapPct))),
    quoteGapPctMedian: med(nums(land.map((r) => r.quoteGapPct))),
    // `at` (when the copy started) is for the password-protected dashboard only: deploy/report.py takes it off the
    // public file, because the moment of a trade is enough to find the wallet that made it
    recent: rows.slice(-40).reverse().map((r) => ({ at: new Date(r.t).toISOString(), buy: r.buy, slotsBehind: r.slotsBehind ?? null, ahead: r.ahead ?? null, pipelineMs: r.pipelineMs ?? null, quoteGapPct: r.quoteGapPct ?? null, fillGapPct: r.fillGapPct ?? null, sold: r.sold ?? null, heldSec: r.heldSec ?? null, exit: r.exit ?? null, bestPct: r.bestPct ?? null, netSol: r.netSol })),
  };
}

export function startSolanaCopyLive() {
  if (process.env.SOLANA_LIVE === "off") return null;
  if (!loaded) load();
  try {
    wallet();
    walletReady = true;
  } catch (e) {
    // Only our own fixed messages may reach status: a JSON parse error quotes the start of the file it read,
    // and that file is the secret key.
    const m = String((e as Error).message);
    walletError = m.startsWith("solana-wallet.json") ? m.slice(0, 120) : "the wallet file could not be created or read";
  }
  onStreamBuy((b) => void trade(b));
  if (walletReady && state.open) void recover();
  else if (walletReady && state.opens.length) void recoverMany();
  else if (walletReady) setTimeout(() => void tidy(), 20_000).unref();
  // a position that could not be closed is tried again every 10 minutes (at most MAX_RECOVERIES times in all)
  setInterval(() => {
    if (!walletReady || busy) return;
    if (state.open) void recover();
    else if (state.opens.some((o) => !live.has(o))) void recoverMany();
  }, 600_000).unref();
  return null;
}

/** Test hooks. */
export const _test = {
  setConfig: (c: LiveConfig | null) => (cfgOverride = c),
  reset: () => {
    state = fresh();
    loaded = true;
    busy = false;
    lastAt = 0;
    entering = 0;
    enteringMints.clear();
    live.clear();
    recovering = false;
    sweeping = false;
    quiet = false;
  },
  setRecoverWait: (ms: number) => (recoverWaitMs = ms),
  state: () => state,
  ready: () => {
    wallet();
    walletReady = true;
  },
  watch,
  closeSpare,
  booked,
  forgetCloses: () => noClose.clear(),
  setPoll: (ms: number) => (pollMs = ms),
};
