/**
 * REAL MONEY (tiny, capped), OFF BY DEFAULT: the spot bucket rules of buckets.ts, traded for real once paper proves
 * them. enrique, 15 Nov 2026 08:20 KST, on the paper buckets: "why dont u develop that already". Built ready to
 * switch on; switching it on is his word and MAIN's change to deploy/live-rules.json, not this file's.
 *
 * WHAT IS TRADED: only a rule that MEETS THE BAR on paper (buckets.ts meetsBar: 100+ paper trades at real quotes,
 * half or more won, ahead after costs). Such a rule's next paper buys are also bought for real: `stakeSol` of the
 * coin, swapped from SOL with Jupiter, within BUY_WINDOW_MS of the paper buy; sold when the paper trade is sold (its
 * target, stop or time), or after MAX_HOLD_H whatever happens.
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
 *  - Its OWN wallet (enrique, 15 Nov 2026: "so we separate budgets of different things"): keys.ts walletNamed("buckets"),
 *    not the day-holder copy's. SOL itself is never "bought", and before each buy the wallet must cover the stake, a
 *    coin account's rent and a sale reserve for every trade that is out.
 *  - A trade is written to the state file before its order is sent and after every transaction, so a restart can
 *    finish and count it.
 *  - The public status gets rule names and numbers only; coins, signatures and our address stay on the server.
 * Perps are NOT traded here: paper only.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, ROOT } from "../config.js";
import { meetsBar, paperOpens, paperRecord, setBucketsRealSummary, spotRuleIds, REAL_MIN_TRADES, type Bucket } from "./buckets.js";
import { signTransaction, walletNamed, type Wallet } from "./keys.js";
import { SOL } from "./pools.js";

export const HARD_STAKE_SOL = 0.02;
export const HARD_MAX_LOSS_SOL = 0.2;
export const HARD_MAX_OPEN = 10;
export const HARD_RULE_STOP_SOL = 0.05;
/** the most the wallet may hold (as agreed for the day-holder copy); clearly more in it means nothing is bought */
export const MAX_WALLET_SOL = 0.6;
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
  bucket: Bucket;
  mint: string;
  /** the paper trade it follows (its buy time) */
  paperAt: number;
  stage: "buying" | "held" | "selling";
  boughtMs?: number;
  sigs: string[];
  nextTryMs?: number;
}
interface Row {
  t: number;
  rule: string;
  buy: "landed" | "did not land" | "failed";
  netSol: number;
  heldMin: number | null;
}
interface State {
  netSol: number;
  halted: string;
  note: string;
  opens: Pos[];
  rows: Row[];
  /** rule -> when it went back to paper, ms */
  demoted: Record<string, number>;
  /** paper trades already looked at (rule:mint:at), newest last */
  seen: string[];
  skipped: Record<string, number>;
  lastError: string;
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
  } catch {
    // a file that is there but unreadable must never restart the loss count from zero
    state.halted = "the state file could not be read: the loss count is unknown, so nothing is bought";
  }
}
function save() {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(STATE() + ".tmp", JSON.stringify(state));
  renameSync(STATE() + ".tmp", STATE());
}
const loss = () => Math.max(0, -state.netSol);
const skip = (why: string) => void (state.skipped[why] = (state.skipped[why] ?? 0) + 1);

/** What this module needs from the chain and from Jupiter: copylive's kit in production, fakes in tests. */
export interface Kit {
  quote: (inMint: string, outMint: string, amount: string, slippageBps: number) => Promise<{ outAmount?: string }>;
  swapTx: (quote: unknown, address: string, maxFeeLamports: number) => Promise<string>;
  send: (tx: string) => Promise<unknown>;
  landed: (sig: string, ms: number) => Promise<{ slot: number; err: unknown } | null>;
  held: (address: string, mint: string) => Promise<{ amount: bigint }>;
  sigOf: (tx: string) => string;
  balance: (address: string) => Promise<number>;
  booked: (w: Wallet, sigs: string[]) => Promise<{ sol: number; unread: string[] }>;
  /** closes the emptied coin account (its rent comes back) and adds its transaction to row.sigs */
  closeEmpty: (w: Wallet, mint: string, row: CloseRow) => Promise<unknown>;
}
type CloseRow = import("./copylive.js").Row;
export interface LiveDeps {
  kit: Kit;
  cfg: () => BucketsLiveConfig;
  wallet: () => Wallet;
  /** coins the real day-holder copy holds or is buying */
  otherHeld: () => string[];
  sleep: (ms: number) => Promise<void>;
  fixed: (e: unknown) => string;
}
function fileCfg(): BucketsLiveConfig {
  if (process.env.SOLANA_LIVE === "off") return OFF;
  try {
    return parseBucketsLive(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8"));
  } catch {
    return OFF;
  }
}

/** Real net of one rule's landed trades since it was last demoted. */
const ruleNet = (rule: string) => state.rows.filter((x) => x.rule === rule && x.buy === "landed" && x.t > (state.demoted[rule] ?? 0)).reduce((a, x) => a + x.netSol, 0);
/** Is the rule traded for real now? Paper must meet the bar, counting only paper trades made after a demotion. */
export const promoted = (rule: string) => meetsBar(paperRecord(rule, state.demoted[rule] ?? 0));

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
    if (others.includes(o.mint)) return skip("held by the day-holder copy");
    const bal = await d.kit.balance(w.address);
    if (bal > MAX_WALLET_SOL + Math.max(0, state.netSol)) {
      state.note = `the wallet holds more than was agreed (${MAX_WALLET_SOL} SOL): not buying until the extra is taken out`;
      return skip("wallet over the agreed size");
    }
    if (bal < c.stakeSol + RENT_SOL + SELL_RESERVE_SOL * (state.opens.length + others.length + 1)) {
      state.note = "wallet balance too low for a trade";
      return skip("too little SOL");
    }
    state.note = "";
    const q = await d.kit.quote(SOL, o.mint, String(Math.round(c.stakeSol * LAMPORTS)), SLIPPAGE_BPS[o.bucket]);
    if (!q.outAmount || q.outAmount === "0") return skip("no price");
    const tx = signTransaction(await d.kit.swapTx(q, w.address, c.maxFeeLamports), w);
    // written down before it is sent: a restart must know of every transaction of a trade
    p = { rule: o.rule, bucket: o.bucket, mint: o.mint, paperAt: o.at, stage: "buying", sigs: [d.kit.sigOf(tx)] };
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
  try {
    const w = d.wallet();
    for (let i = 0; i < 6; i++) {
      const h = await d.kit.held(w.address, p.mint);
      if (h.amount === 0n) return void (await closeAndFinish(d, w, p));
      const q = await d.kit.quote(p.mint, SOL, h.amount.toString(), Math.min(5000, Math.max(SLIPPAGE_BPS[p.bucket], 300) + 600 * i));
      if (!q.outAmount) throw new Error("no sell quote");
      const tx = signTransaction(await d.kit.swapTx(q, w.address, c.maxFeeLamports), w);
      p.sigs.push(d.kit.sigOf(tx));
      save();
      await sendUntil(d, tx, 30_000);
      await d.sleep(400);
    }
    if ((await d.kit.held(w.address, p.mint)).amount === 0n) return void (await closeAndFinish(d, w, p));
  } catch (e) {
    state.lastError = d.fixed(e);
  }
  // could not sell (no route, network): still held, tried again in 10 minutes
  p.stage = "held";
  p.nextTryMs = Date.now() + 600_000;
  save();
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
  if (r.unread.length) state.halted = state.halted || "a transaction of a finished trade could not be read back: the books may be short, so nothing new is bought";
  state.netSol = Math.round((state.netSol + r.sol) * 1e9) / 1e9;
  state.opens = state.opens.filter((x) => x !== p);
  state.rows = [...state.rows, { t: Date.now(), rule: p.rule, buy: buyState, netSol: r.sol, heldMin: p.boughtMs ? Math.round((Date.now() - p.boughtMs) / 60_000) : null }].slice(-5000);
  const c = d.cfg();
  if (c.ruleStopSol > 0 && ruleNet(p.rule) <= -c.ruleStopSol) state.demoted[p.rule] = Date.now();
  if (!state.halted && c.maxLossSol > 0 && loss() + c.stakeSol + TRADE_ROOM_SOL > c.maxLossSol + 1e-9) state.halted = `loss cap reached: ${r6(loss())} of ${c.maxLossSol} SOL (no room for another trade)`;
  save();
}

let busy = false;
/** One look: sell what paper has sold (or is too old), settle buys a restart cut off, buy what paper just bought. */
export async function bucketsLiveTick(d: LiveDeps, now = Date.now()): Promise<void> {
  if (busy) return;
  if (!loaded) load();
  const c = d.cfg();
  if (!c.on && !state.opens.length) return;
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
    }
    for (const o of paper) {
      const key = `${o.rule}:${o.mint}:${o.at}`;
      if (state.seen.includes(key)) continue;
      state.seen = [...state.seen, key].slice(-500);
      if (!c.on || state.halted || !promoted(o.rule)) continue; // the usual case: the rule is paper only
      if (o.mint === SOL) skip("SOL itself");
      else if (now - o.at > BUY_WINDOW_MS) skip("paper buy too old");
      else if (state.opens.some((p) => p.mint === o.mint)) skip("coin already held");
      else if (state.opens.length >= c.maxOpen) skip("too many out");
      else if (loss() + (state.opens.length + 1) * (c.stakeSol + TRADE_ROOM_SOL) > c.maxLossSol + 1e-9) skip("no room under the cap");
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
    return { id, real: c.on && !state.halted && meetsBar(paper), paperTrades: paper.trades, paperWon: paper.won, paperNetUsd: Math.round(paper.netUsd * 100) / 100, demotedAt: since || null, trades: mine.length, won: mine.filter((x) => x.netSol > 0).length, netSol: r6(mine.reduce((a, x) => a + x.netSol, 0)) };
  });
  return {
    note: `REAL, off unless the live rules switch it on. A spot bucket rule is traded for real only while its paper record meets the bar (${REAL_MIN_TRADES}+ paper trades at real quotes, half or more won, ahead after costs): then each of its paper buys is also bought with ${c.stakeSol || 0.01} SOL and sold when the paper trade is sold. A rule whose real trades lose ${c.ruleStopSol || 0.03} SOL goes back to paper until its paper trades made after that meet the bar again. Total loss is capped; perps are paper only.`,
    on: c.on && !state.halted,
    switch: c.on ? "on" : "off",
    halted: state.halted,
    stateNote: state.note,
    stakeSol: c.stakeSol,
    capSol: c.maxLossSol,
    ruleStopSol: c.ruleStopSol,
    netSol: r6(state.netSol),
    trades: done.length,
    won: done.filter((x) => x.netSol > 0).length,
    notLanded: state.rows.length - done.length,
    open: state.opens.length,
    skipped: state.skipped,
    lastError: state.lastError,
    rulesReal: rules.filter((x) => x.real).length,
    rules: rules.filter((x) => x.real || x.trades || x.demotedAt || x.paperTrades >= REAL_MIN_TRADES / 2),
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
export async function startBucketsLive() {
  if (timer || process.env.SOLANA_LIVE === "off" || process.env.SOLANA_BUCKETS === "off") return;
  const { kit, whyNotSent } = await import("./copylive.js");
  // Its own wallet (enrique, 15 Nov 2026: "so we separate budgets of different things"): data/solana-wallet-buckets.json,
  // made here on the first start so its address can be read on the server and funded. The perps wallet is made ready too.
  try {
    walletNamed("buckets");
    walletNamed("perps");
  } catch {
    return; // no usable wallet: this side stays off
  }
  const d: LiveDeps = { kit, cfg: fileCfg, wallet: () => walletNamed("buckets"), otherHeld: () => [], sleep: (ms) => new Promise((res) => setTimeout(res, ms)), fixed: (e) => whyNotSent(String((e as Error)?.message ?? e)) };
  setBucketsRealSummary(bucketsLiveSummary);
  timer = setInterval(() => void bucketsLiveTick(d), 30_000);
  timer.unref();
}

/** Test hooks. */
export const _test = { reset: () => ((state = fresh()), (loaded = true)), state: () => state, reload: () => load(), setCfg: (f: () => BucketsLiveConfig) => void (liveCfg = f) };
