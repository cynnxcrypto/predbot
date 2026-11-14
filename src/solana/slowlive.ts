/**
 * REAL MONEY (small, capped): copy three day-holding wallets. enrique, 14 Nov 2026 14:40 KST: "since we have very
 * little in the sol wallet anyways, just real trade those 3 wallets, lets see". That followed the first paper read
 * of the slow-wallet screen's passers (slow.ts): 62 paper copies, 44% won, +0.77 SOL; these three wallets made 56 of
 * them. The paper copy of all the passers keeps running beside this.
 *
 * The rule is the paper one (slow.ts, slow-e5-x5): when one of the wallets buys a coin for MIN_LEADER_SOL or more,
 * buy `stakeSol` of it `entrySec` after we see that buy; when the wallet first sells any of that coin, sell all of
 * ours `exitSec` after we see the sale; sell anyway after `maxHoldH` hours. A coin the wallet sells before our entry
 * is not bought. The wallet buying more of a coin it already holds is not copied. One copy of a coin at a time (a
 * sale sells all of that coin our wallet holds), so a second wallet buying a coin we hold is let go.
 *
 * Guards, all in code:
 *  - OFF unless deploy/live-rules.json has "solanaSlow": { "on": true, "maxLossSol": ... } (MAIN owns that file).
 *    SOLANA_LIVE=off disables it together with the first real test. Anything malformed means off.
 *  - Stake at most HARD_STAKE_SOL a copy; at most HARD_MAX_OPEN coins at once. Loss at most maxLossSol (never above
 *    HARD_MAX_LOSS_SOL, the most the wallet may hold), counted from what our own transactions did to the wallet's SOL,
 *    read back from the chain,
 *    every fee and rent included. A new copy starts only if the cap still holds with every open copy and the new one
 *    lost in full (COPY_ROOM_SOL each for fees and rent). At the cap it stops buying for good; open copies are still
 *    sold by the rule.
 *  - Before each buy the wallet's SOL must cover the stake, a coin account's rent and SELL_RESERVE_SOL for each copy
 *    that is out (so everything can always be sold); with clearly more than was agreed in it (MAX_WALLET_SOL plus
 *    what this test has won) nothing is bought: the orders come from an API and are signed unread.
 *  - A copy is written to the state file before its order is sent, and after every transaction, so a restart can
 *    finish and count it: a coin the wallet sold while we were down is sold at the start.
 *  - The same wallet file and signing as the first real test (keys.ts: only transactions whose single signer is our
 *    wallet). The public status gets numbers and the leaders' screen names only; coins, signatures, times and our
 *    address stay in data/ on the server.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, ROOT } from "../config.js";
import { kit, whyNotSent, type Row } from "./copylive.js";
import { shared } from "./copyrun.js";
import { swapOf, type Meta } from "./discover.js";
import { makeReader, type Item } from "./history.js";
import { signTransaction, wallet, type Wallet } from "./keys.js";
import { SOL } from "./pools.js";
import { onSlowSwap, setSlowRealSummary, type SlowSwap } from "./slow.js";

export const HARD_STAKE_SOL = 0.05;
/**
 * enrique, 14 Nov 2026 23:21 KST: "the solana wallet for trading can use the whole wallet, there's almost no money
 * there so no worries". The whole wallet is at stake: the cap is the most the wallet may hold for this test to buy
 * (MAX_WALLET_SOL), and what really limits it is the balance check before every buy. More than that put into the
 * wallet means nothing is bought, so money added later is never at stake without his word.
 */
export const HARD_MAX_LOSS_SOL = 0.6;
/** Open copies are limited by the wallet's SOL (stake, rent and a sale reserve each); this only bounds the count. */
export const HARD_MAX_OPEN = 50;
/** The wallet held up to 0.5 SOL for the first test; clearly more than that put in means nothing is bought. */
export const MAX_WALLET_SOL = 0.6;
/** What each copy may cost beyond its stake if it all goes wrong: fees of a buy and several sale tries, an unclosed account's rent. */
export const COPY_ROOM_SOL = 0.003;
/** A coin account's rent (comes back when the account is closed after the sale). */
export const RENT_SOL = 0.00204;
/** Kept in the wallet for each copy that is out, so its sale can always pay its fees. */
export const SELL_RESERVE_SOL = 0.001;
/** The paper rule copies a wallet's buy of this many SOL or more (slow.ts, slowTx). */
export const MIN_LEADER_SOL = 0.1;
/** The three wallets that made most of the paper copies (slow.ts screen, 14 Nov 2026). Public on-chain addresses. */
export const WALLETS: readonly { name: string; address: string }[] = [
  { name: "coin buyer AqpV", address: "AqpVFSGtTSaDVQVh9jAZ69zD4dzc8SzmHRoUv5GnLzXD" },
  { name: "coin buyer HQVe", address: "HQVe5wwC4WFwRSYR4Pm3No1Frenjz95FpaWKiZvJAKdH" },
  { name: "coin buyer 13G3", address: "13G3iHZ4v4dGUxmFKHLTXxw5XSAt24orRvMRMStf2ojP" },
];
const STATE = () => join(DATA, "solana-slowlive.json");
const ROWS = () => join(DATA, "solana", "slowlive-trades.jsonl");
const LAMPORTS = 1e9;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
/** Errors reach the status only in our own fixed words: a wallet-file error could quote the secret key. */
const fixed = (e: unknown) => whyNotSent(String((e as Error)?.message ?? e));

export interface SlowLiveConfig {
  on: boolean;
  stakeSol: number;
  maxLossSol: number;
  maxOpen: number;
  entrySec: number;
  exitSec: number;
  maxHoldH: number;
  slippageBps: number;
  /** the most any one transaction bids in priority fee, lamports: speed does not matter here, so it is kept low */
  maxFeeLamports: number;
}
const OFF: SlowLiveConfig = { on: false, stakeSol: 0, maxLossSol: 0, maxOpen: 1, entrySec: 5, exitSec: 5, maxHoldH: 72, slippageBps: 1500, maxFeeLamports: 20_000 };
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Parse the "solanaSlow" block of deploy/live-rules.json. Hard limits are applied here; anything odd means off. */
export function parseSlowLive(text: string): SlowLiveConfig {
  try {
    const p = (JSON.parse(text) as { solanaSlow?: Record<string, unknown> }).solanaSlow;
    if (!p || p.on !== true) return OFF;
    const maxLossSol = clamp(num(p.maxLossSol, 0), 0, HARD_MAX_LOSS_SOL);
    const stakeSol = clamp(num(p.stakeSol, 0.01), 0, HARD_STAKE_SOL);
    if (!(maxLossSol > 0) || !(stakeSol >= 0.005)) return OFF;
    return {
      on: true, stakeSol, maxLossSol,
      // no count unless the file sets one: the balance check before each buy is the limit
      maxOpen: clamp(Math.floor(num(p.maxOpen, HARD_MAX_OPEN)), 1, HARD_MAX_OPEN),
      entrySec: clamp(num(p.entrySec, 5), 1, 600),
      exitSec: clamp(num(p.exitSec, 5), 1, 60),
      maxHoldH: clamp(num(p.maxHoldH, 72), 1, 168),
      slippageBps: clamp(Math.floor(num(p.slippageBps, 1500)), 100, 3000),
      maxFeeLamports: clamp(Math.floor(num(p.maxFeeLamports, 20_000)), 5_000, 200_000),
    };
  } catch {
    return OFF;
  }
}
let cfgOverride: SlowLiveConfig | null = null;
function cfg(): SlowLiveConfig {
  if (cfgOverride) return cfgOverride;
  if (process.env.SOLANA_LIVE === "off") return OFF;
  try {
    return parseSlowLive(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8"));
  } catch {
    return OFF;
  }
}

/** A copy: from the leader's buy we saw to our sale. Kept in the state file until it is counted. */
export interface Pos {
  wallet: string;
  name: string;
  mint: string;
  leaderSol: number;
  /** when we saw the leader's buy, ms */
  seenMs: number;
  stage: "waiting" | "buying" | "held" | "selling";
  /** when we saw the leader's first sale of the coin, ms */
  soldSeenMs?: number;
  boughtMs?: number;
  /** every transaction of ours for this copy (buy, sale tries, account close): what they did to our SOL is the result */
  sigs: string[];
  sellRounds: number;
  /** a sale that failed is tried again from this time (ms) */
  nextTryMs?: number;
  /** when the leader's own transactions were last read for a sale the stream may have missed, ms */
  checkedMs?: number;
  exit?: Exit;
}
type Exit = "sold" | "sold, seen late" | "max hold" | "sold while we were down" | "buy did not land" | "buy failed";
export interface SRow {
  t: number;
  name: string;
  mint: string;
  leaderSol: number;
  buy: "landed" | "did not land" | "failed";
  exit: Exit;
  heldMin: number | null;
  netSol: number;
  unread?: number;
  error?: string;
  sigs: string[];
}
interface State {
  netSol: number;
  halted: string;
  note: string;
  opens: Pos[];
  rows: SRow[];
  /** buys let go: coin already held, no room under the cap, too many out, too little SOL, the leader sold before our entry */
  missedSame: number;
  missedCap: number;
  missedOpen: number;
  missedLow: number;
  skippedSold: number;
  notSent: number;
  unreadTx: number;
  credits: number;
  creditsDay: string;
  lastError: string;
}
const fresh = (): State => ({ netSol: 0, halted: "", note: "", opens: [], rows: [], missedSame: 0, missedCap: 0, missedOpen: 0, missedLow: 0, skippedSold: 0, notSent: 0, unreadTx: 0, credits: 0, creditsDay: "", lastError: "" });
let state: State = fresh();
let loaded = false;
let started = false;
let walletReady = false;
let laterLookMs = 60_000;
const timers = new Set<NodeJS.Timeout>();
const later = (ms: number, f: () => void) => {
  const t = setTimeout(() => {
    timers.delete(t);
    f();
  }, Math.max(0, ms));
  timers.add(t);
};

function load() {
  loaded = true;
  let text: string;
  try {
    text = readFileSync(STATE(), "utf8");
  } catch {
    return; // no file yet: a fresh start
  }
  try {
    state = { ...fresh(), ...(JSON.parse(text) as State) };
    if (!Array.isArray(state.opens)) state.opens = [];
    if (!Array.isArray(state.rows)) state.rows = [];
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
const wallets = () => WALLETS;
const nameOf = (a: string) => wallets().find((w) => w.address === a)?.name ?? a.slice(0, 4);

// ---- the leader's swaps ---------------------------------------------------------------------------------------------
/** Called by the slow study for every swap of our three wallets that the stream carries. Never throws. */
export function onSwap(s: SlowSwap) {
  if (!loaded) load();
  if (s.buy) return void onBuy(s);
  for (const p of state.opens) {
    if (p.wallet !== s.wallet || p.mint !== s.mint || p.soldSeenMs) continue;
    p.soldSeenMs = s.seenMs;
    if (p.stage === "waiting") {
      // it sold before our entry: no copy
      state.opens = state.opens.filter((x) => x !== p);
      state.skippedSold++;
    } else if (p.stage === "held") later(cfg().exitSec * 1000 - (Date.now() - s.seenMs), () => void sell(p, "sold"));
    // "buying": the sale follows as soon as the buy is in; "selling": already going
  }
  save();
}
function onBuy(s: SlowSwap) {
  const c = cfg();
  if (!c.on || state.halted || !walletReady || s.sol < MIN_LEADER_SOL) return;
  const same = state.opens.find((p) => p.mint === s.mint);
  if (same) {
    if (same.wallet !== s.wallet) state.missedSame++;
    return; // the wallet adding to a coin it holds is not copied
  }
  if (state.opens.length >= c.maxOpen) return void state.missedOpen++;
  // the cap must hold with every copy that is out, and this one, lost in full
  if (loss() + (state.opens.length + 1) * (c.stakeSol + COPY_ROOM_SOL) > c.maxLossSol + 1e-9) return void state.missedCap++;
  const p: Pos = { wallet: s.wallet, name: nameOf(s.wallet), mint: s.mint, leaderSol: r6(s.sol), seenMs: s.seenMs, stage: "waiting", sigs: [], sellRounds: 0 };
  state.opens.push(p);
  save();
  later(c.entrySec * 1000 - (Date.now() - s.seenMs), () => void buy(p));
}

// ---- buy, sell, count -----------------------------------------------------------------------------------------------
/** Send a signed transaction until it lands or its blockhash runs out (the chain takes it once). null = never seen. */
async function sendUntil(tx: string, ms: number) {
  const sig = kit.sigOf(tx);
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await kit.send(tx).catch(() => undefined);
    const st = await kit.landed(sig, 2500);
    if (st) return st;
  }
  return null;
}
async function buy(p: Pos) {
  if (!state.opens.includes(p) || p.stage !== "waiting") return;
  const c = cfg();
  const drop = (count: () => void) => {
    state.opens = state.opens.filter((x) => x !== p);
    count();
    save();
  };
  if (p.soldSeenMs) return drop(() => state.skippedSold++);
  if (!c.on || state.halted) return drop(() => undefined);
  let w: Wallet;
  try {
    w = wallet();
    const bal = await kit.balance(w.address);
    const out = state.opens.filter((x) => x !== p && x.stage !== "waiting").length;
    if (bal > MAX_WALLET_SOL + Math.max(0, state.netSol)) {
      state.note = `the wallet holds more than was agreed (${MAX_WALLET_SOL} SOL plus what this test has won): not buying until the extra is taken out`;
      return drop(() => state.missedLow++);
    }
    if (bal < c.stakeSol + RENT_SOL + SELL_RESERVE_SOL * (out + 1)) {
      state.note = "wallet balance too low for a copy";
      return drop(() => state.missedLow++);
    }
    state.note = "";
    if (p.soldSeenMs) return drop(() => state.skippedSold++);
    const q = await kit.quote(SOL, p.mint, String(Math.round(c.stakeSol * LAMPORTS)), c.slippageBps);
    if (!q.outAmount || q.outAmount === "0") return drop(() => state.notSent++);
    const tx = signTransaction(await kit.swapTx(q, w.address, c.maxFeeLamports), w);
    // written down before it is sent: a restart must know of every transaction of a copy
    p.sigs.push(kit.sigOf(tx));
    p.stage = "buying";
    save();
    const st = await sendUntil(tx, 60_000);
    if (st?.err) return void (await finish(w, p, "buy failed"));
    if (!st) {
      // not seen in time: once its blockhash has surely run out, the wallet says whether it went through after all
      await sleep(laterLookMs);
      if ((await kit.held(w.address, p.mint)).amount === 0n) return void (await finish(w, p, "buy did not land"));
    }
    // landed: the coin is ours (a sale finds nothing to sell if the RPC was behind and it never came)
    p.stage = "held";
    p.boughtMs = Date.now();
    save();
    if (p.soldSeenMs) later(c.exitSec * 1000 - (Date.now() - p.soldSeenMs), () => void sell(p, "sold"));
  } catch (e) {
    state.lastError = fixed(e);
    if (p.stage === "waiting") return drop(() => state.notSent++);
    // a buy that was sent: the start after a restart, or the sweep, looks at the wallet and counts it
    save();
  }
}
/** Sell every unit of the coin the wallet holds, written down after every try. True when none is left. Never throws. */
async function sellAll(w: Wallet, p: Pos, c: SlowLiveConfig): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    try {
      const h = await kit.held(w.address, p.mint);
      if (h.amount === 0n) return true;
      const q = await kit.quote(p.mint, SOL, h.amount.toString(), Math.min(5000, 2000 + 600 * i));
      if (!q.outAmount) throw new Error("no sell quote");
      const tx = signTransaction(await kit.swapTx(q, w.address, c.maxFeeLamports), w);
      p.sigs.push(kit.sigOf(tx));
      save();
      await sendUntil(tx, 30_000);
      await sleep(400);
    } catch (e) {
      state.lastError = fixed(e);
      await sleep(1000);
    }
  }
  const h = await kit.held(w.address, p.mint).catch(() => null);
  return !!h && h.amount === 0n;
}
async function sell(p: Pos, exit: Exit) {
  if (!state.opens.includes(p) || p.stage !== "held") return;
  p.stage = "selling";
  p.exit = exit;
  save();
  const c = cfg();
  try {
    const w = wallet();
    p.sellRounds++;
    if (await sellAll(w, p, c)) {
      // the emptied coin account's rent back; its transaction is counted with the copy
      const r: Row = { t: Date.now(), name: p.name, mint: p.mint, leaderSlot: 0, buy: "landed", netSol: 0, sigs: [] };
      await kit.closeEmpty(w, p.mint, r);
      p.sigs.push(...r.sigs);
      save();
      return void (await finish(w, p, exit));
    }
  } catch (e) {
    state.lastError = fixed(e);
  }
  // could not sell (no route, network): still held; tried again 10 minutes later by the sweep, six rounds at most
  p.stage = "held";
  p.nextTryMs = Date.now() + 600_000;
  save();
}
/** Count a finished copy from its own transactions, write its row, drop it. */
async function finish(w: Wallet, p: Pos, exit: Exit) {
  let r = await kit.booked(w, p.sigs);
  for (let i = 0; i < 3 && r.unread.length; i++) {
    await sleep(5000);
    r = await kit.booked(w, p.sigs);
  }
  const row: SRow = {
    t: p.seenMs, name: p.name, mint: p.mint, leaderSol: p.leaderSol,
    buy: exit === "buy did not land" ? "did not land" : exit === "buy failed" ? "failed" : "landed",
    exit, heldMin: p.boughtMs ? Math.round((Date.now() - p.boughtMs) / 60_000) : null,
    netSol: r.sol, sigs: p.sigs,
  };
  if (r.unread.length) {
    // landed but unreadable: the books may be short, so nothing new is bought until someone looks
    row.unread = r.unread.length;
    state.unreadTx += r.unread.length;
    state.halted = state.halted || "a transaction of a finished copy could not be read back: the books may be short, so nothing new is bought";
  }
  state.netSol = Math.round((state.netSol + r.sol) * 1e9) / 1e9;
  state.opens = state.opens.filter((x) => x !== p);
  state.rows = [...state.rows, row].slice(-5000);
  // at the cap, or so near it that not one more copy fits under it: it stops buying for good
  const c = cfg();
  if (!state.halted && c.maxLossSol > 0 && loss() + c.stakeSol + COPY_ROOM_SOL > c.maxLossSol + 1e-9) state.halted = `loss cap reached: ${r6(loss())} of ${c.maxLossSol} SOL (no room for another copy)`;
  try {
    mkdirSync(join(DATA, "solana"), { recursive: true });
    appendFileSync(ROWS(), JSON.stringify(row) + "\n");
  } catch {
    /* the state file has it */
  }
  save();
}

// ---- restarts and the sweep -----------------------------------------------------------------------------------------
const reader = makeReader({
  url: () => (shared.helius() ? shared.rpcUrl() : null),
  fetch: () => shared.fetch(),
  canSpend: () => {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== state.creditsDay) [state.creditsDay, state.credits] = [d, 0];
    return state.credits < 3000;
  },
  spent: (n) => (state.credits += n),
  called: () => undefined,
});
const payerOf = (it: Item) => {
  const k = it.transaction?.message?.accountKeys?.[0];
  return typeof k === "string" ? k : (k?.pubkey ?? null);
};
/** Did the leader sell any of the coin after `sinceMs`? null = could not tell (no key, credit cap, network). */
export async function soldSince(leader: string, mint: string, sinceMs: number): Promise<boolean | null> {
  let token: string | null = null;
  try {
    for (let i = 0; i < 5; i++) {
      const pg = await reader(leader, { blockTime: { gt: Math.floor(sinceMs / 1000) }, tokenAccounts: "balanceChanged" }, "asc", token);
      if (!pg) return null;
      for (const it of pg.data) {
        if (payerOf(it) !== leader) continue;
        const s = swapOf(it.meta as Meta, leader, it.slot);
        if (s && s.wallet === leader && s.mint === mint && !s.buy) return true;
      }
      token = pg.paginationToken;
      if (!token || !pg.data.length) return false;
    }
    return false;
  } catch {
    return null;
  }
}
/**
 * A copy whose buy or sale was cut off (a restart, an error): the wallet says where it is. No coin = counted and
 * dropped; coin = held again. True when it is held.
 */
async function settle(w: Wallet, p: Pos): Promise<boolean> {
  const h = await kit.held(w.address, p.mint);
  if (h.amount === 0n) {
    await finish(w, p, p.stage === "buying" ? "buy did not land" : (p.exit ?? "sold"));
    return false;
  }
  if (p.stage === "buying") p.boughtMs = p.seenMs;
  p.stage = "held";
  save();
  return true;
}
/**
 * After a start: every copy in the file is finished or picked up again. A copy still waiting for its entry missed it
 * (not bought). A buy under way is given until its blockhash has run out, then the wallet is looked at. A coin held
 * is sold now if its wallet sold while we were down, else watched as before.
 */
export async function recover() {
  if (!loaded) load();
  let w: Wallet;
  try {
    w = wallet();
  } catch {
    return;
  }
  for (const p of [...state.opens]) {
    try {
      if (p.stage === "waiting") {
        state.opens = state.opens.filter((x) => x !== p);
        state.skippedSold++; // its entry time passed while we were down
        continue;
      }
      if (p.stage === "buying") await sleep(Math.max(0, p.seenMs + cfg().entrySec * 1000 + 150_000 - Date.now()));
      if (!(await settle(w, p))) continue;
      if (p.soldSeenMs || (await soldSince(p.wallet, p.mint, p.seenMs))) void sell(p, p.exit === "max hold" ? "max hold" : "sold while we were down");
    } catch (e) {
      state.lastError = fixed(e);
    }
  }
  save();
}
const settling = new Set<Pos>();
/** How often a held coin's wallet is read for a sale the stream may have missed (it drops now and then). */
export const CHECK_MS = 3_600_000;
/**
 * Every 5 minutes: copies past maxHoldH are sold; a sale that failed is tried again (6 rounds at most); and the one
 * held copy whose wallet was read longest ago, if over CHECK_MS, is read for a sale the stream missed.
 */
export function sweep(now = Date.now()) {
  const c = cfg();
  for (const p of [...state.opens]) {
    // a buy left half-way by an error: once it can no longer land, the wallet says what happened
    if (p.stage === "buying" && now - p.seenMs - c.entrySec * 1000 > 5 * 60_000 && !settling.has(p)) {
      settling.add(p);
      void (async () => {
        try {
          if ((await settle(wallet(), p)) && p.soldSeenMs) void sell(p, "sold");
        } catch (e) {
          state.lastError = fixed(e);
        } finally {
          settling.delete(p);
        }
      })();
      continue;
    }
    if (p.stage !== "held") continue;
    if (p.exit) {
      if (p.sellRounds < 6 && now >= (p.nextTryMs ?? 0)) void sell(p, p.exit);
    } else if (now - (p.boughtMs ?? p.seenMs) > c.maxHoldH * 3_600_000) void sell(p, "max hold");
  }
  const due = state.opens
    .filter((p) => p.stage === "held" && !p.exit && !p.soldSeenMs && now - (p.checkedMs ?? p.boughtMs ?? p.seenMs) > CHECK_MS)
    .sort((a, b) => (a.checkedMs ?? a.seenMs) - (b.checkedMs ?? b.seenMs))[0];
  if (due) {
    const from = Math.max(due.seenMs, (due.checkedMs ?? 0) - 60_000);
    due.checkedMs = now;
    void soldSince(due.wallet, due.mint, from).then((sold) => {
      if (sold && due.stage === "held" && !due.soldSeenMs) {
        due.soldSeenMs = Date.now();
        void sell(due, "sold, seen late");
      }
    });
  }
}

export function startSlowLive() {
  if (started || process.env.SOLANA_LIVE === "off") return;
  started = true;
  if (!loaded) load();
  try {
    wallet();
    walletReady = true;
  } catch {
    walletReady = false; // the first real test reports why, in its own fixed words
  }
  onSlowSwap(() => (cfg().on || state.opens.length ? wallets().map((w) => w.address) : []), onSwap);
  setSlowRealSummary(slowLiveSummary);
  if (walletReady && state.opens.length) setTimeout(() => void recover(), 15_000).unref();
  setInterval(() => sweep(), 5 * 60_000).unref();
}

// ---- status (public: numbers and the leaders' screen names only) ----------------------------------------------------
export function slowLiveSummary() {
  const c = cfg();
  const done = state.rows.filter((x) => x.buy === "landed");
  const won = done.filter((x) => x.netSol > 0).length;
  const held = done.map((x) => x.heldMin).filter((x): x is number => x !== null).sort((a, b) => a - b);
  return {
    note: `REAL. Copies ${WALLETS.length} day-holding wallets (enrique, 14 Nov 2026): buys ${c.stakeSol || "?"} SOL ${c.entrySec} s after one of them buys a coin for ${MIN_LEADER_SOL}+ SOL, sells all ${c.exitSec} s after it first sells that coin, or after ${c.maxHoldH} h. Uses the whole wallet (enrique, 14 Nov 23:21 KST): as many copies at once as its SOL covers (stake, rent and a sale reserve each); loss cap ${c.maxLossSol || "?"} SOL counted from our own transactions read back from the chain, every fee included, and nothing is bought with more than ${MAX_WALLET_SOL} SOL in the wallet.`,
    on: c.on && !state.halted && walletReady,
    switch: c.on ? "on" : "off",
    halted: state.halted,
    stateNote: state.note,
    stakeSol: c.stakeSol,
    capSol: c.maxLossSol,
    maxOpen: c.maxOpen,
    netSol: r6(state.netSol),
    copies: done.length,
    won,
    notLanded: state.rows.length - done.length,
    open: state.opens.filter((p) => p.stage !== "waiting").length,
    waiting: state.opens.filter((p) => p.stage === "waiting").length,
    heldMinMedian: held.length ? held[held.length >> 1] : null,
    missedSame: state.missedSame,
    missedCap: state.missedCap,
    missedOpen: state.missedOpen,
    missedLow: state.missedLow,
    skippedSold: state.skippedSold,
    notSent: state.notSent,
    unreadTx: state.unreadTx,
    byWallet: WALLETS.map((w) => {
      const rs = done.filter((x) => x.name === w.name);
      return { name: w.name, copies: rs.length, won: rs.filter((x) => x.netSol > 0).length, netSol: r6(rs.reduce((a, x) => a + x.netSol, 0)) };
    }),
    recent: state.rows.slice(-20).map((x) => ({ name: x.name, buy: x.buy, exit: x.exit, heldMin: x.heldMin, netSol: r6(x.netSol) })),
    lastError: state.lastError,
  };
}

/** Test hooks. */
export const _test = {
  setConfig: (c: SlowLiveConfig | null) => (cfgOverride = c),
  reset: () => {
    state = fresh();
    loaded = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
  },
  ready: (v = true) => (walletReady = v),
  setLaterLook: (ms: number) => (laterLookMs = ms),
  state: () => state,
  buy,
  sell,
  finish,
  load,
};
