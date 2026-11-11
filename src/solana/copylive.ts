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
 * `holdSec`. With targetPct 0 it is the old fixed hold. No stop: on paper the stops cost more than they saved.
 *
 * Guards, all in code:
 *  - OFF unless deploy/live-rules.json has "solanaCopy": { "on": true, ... } (MAIN owns that file). SOLANA_LIVE=off
 *    also disables it. Anything malformed means off.
 *  - Stake at most HARD_STAKE_SOL per copy. Total loss at most HARD_MAX_LOSS_SOL, counted from the wallet's real
 *    SOL balance before and after each copy (so every fee is in it). At the cap it stops for good.
 *  - One position at a time. If a position cannot be sold it halts and says so.
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
/** enrique agreed to fund 0.5 SOL. With clearly more than that in the wallet nothing trades (MAIN review, 11 Nov 2026). */
export const MAX_WALLET_SOL = 0.6;
/** Room kept under the cap for the fees of one copy (a buy, up to six sale tries, an unclosed token account). */
export const FEE_ROOM_SOL = 0.03;
export const MAX_RECOVERIES = 3;
const STUCK = "could not sell a position: tokens are still in the wallet";
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
  maxPerDay: number;
  slippageBps: number;
  /** most we will pay in priority fee per transaction, lamports */
  maxFeeLamports: number;
}
const OFF: LiveConfig = { on: false, stakeSol: 0, maxLossSol: 0, holdSec: 5, targetPct: 0, maxPerDay: 0, slippageBps: 1500, maxFeeLamports: 0 };
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
      maxPerDay: clamp(Math.floor(num(p.maxPerDay, 80)), 1, 200),
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
  /** what we really paid over the wallet's price, % */
  fillGapPct?: number;
  sold?: boolean;
  sellTries?: number;
  heldSec?: number;
  /** how the position was closed: at the profit target, or because the time was up (absent = the old fixed hold) */
  exit?: "target" | "time";
  /** the best a sale would have brought back while we held, % over the stake */
  bestPct?: number;
  /** sales tried at the target (one that fails, because the price fell back first, costs a fee and the watch goes on) */
  targetTries?: number;
  /** wallet balance after minus before: the true result, every fee included */
  netSol: number;
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
  /** a copy that is under way or could not be closed: the token, the balance it is counted from, when, clean-up tries */
  open: { mint: string; bal0: number; t: number; tries: number; worthSol?: number; nowPct?: number; bestPct?: number } | null;
  rows: Row[];
}
let state: State = { netSol: 0, trades: 0, day: "", dayCount: 0, halted: "", note: "", balanceSol: null, open: null, rows: [] };
let loaded = false;
let busy = false;
let lastAt = 0;
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
  if (!res.ok) throw new Error(`jupiter ${path.split("?")[0]} http ${res.status}`);
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
async function watch(w: Wallet, mint: string, amount: bigint, c: LiveConfig, row: Row, until: number): Promise<boolean> {
  while (Date.now() < until) {
    const t = Date.now();
    try {
      const q = await quote(mint, SOL, amount.toString(), TARGET_SLIP_BPS);
      const out = Number(q.outAmount);
      if (out > 0 && c.stakeSol > 0) {
        const up = (out / 1e9 / c.stakeSol - 1) * 100;
        row.bestPct = Math.round(Math.max(row.bestPct ?? -100, up) * 10) / 10;
        if (state.open) state.open = { ...state.open, worthSol: Math.round(out / 1e3) / 1e6, nowPct: Math.round(up * 10) / 10, bestPct: row.bestPct };
        if (c.targetPct > 0 && up >= c.targetPct && (row.targetTries ?? 0) < MAX_TARGET_TRIES) {
          row.targetTries = (row.targetTries ?? 0) + 1;
          row.sellTries = (row.sellTries ?? 0) + 1;
          const tx = signTransaction(await swapTx(q, w.address, c.maxFeeLamports), w);
          row.sigs.push(sigOf(tx));
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
  if (!c.on || state.halted || state.open || busy || !walletReady) return;
  if (!shared.helius() || !shared.jupiter()) return void (state.note = "needs both API keys");
  if (Date.now() - lastAt < 10_000) return;
  const day = dayOf(Date.now());
  if (day !== state.day) {
    state.day = day;
    state.dayCount = 0;
  }
  if (state.dayCount >= c.maxPerDay) return void (state.note = "daily count reached");
  // the most one copy can cost: the stake plus every fee of one buy, six sale tries and an unclosed token account
  if (-state.netSol + c.stakeSol + FEE_ROOM_SOL > c.maxLossSol) {
    state.halted = `loss cap reached: ${(-state.netSol).toFixed(4)} of ${c.maxLossSol} SOL`;
    save();
    return;
  }
  busy = true;
  lastAt = Date.now();
  const w = wallet();
  const row: Row = { t: Date.now(), name: b.name, mint: b.mint, leaderSlot: b.leaderSlot, buy: "not sent", netSol: 0, sigs: [] };
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
    if (bal0 > MAX_WALLET_SOL) {
      state.note = `the wallet holds more than ${MAX_WALLET_SOL} SOL: not trading until the extra is taken out`;
      return;
    }
    state.note = "";
    const t0 = performance.now();
    const q = await quote(SOL, b.mint, String(Math.round(c.stakeSol * 1e9)), c.slippageBps);
    if (!q.outAmount || q.outAmount === "0") throw new Error("no buy quote");
    const t1 = performance.now();
    const tx = signTransaction(await swapTx(q, w.address, c.maxFeeLamports), w);
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
        if (c.targetPct > 0) row.exit = "time";
        row.sold = await sellAll(w, b.mint, c.maxFeeLamports, row);
      }
      row.heldSec = Math.round((Date.now() - heldFrom) / 100) / 10;
      if (!row.sold) {
        closed = false;
        state.halted = STUCK;
      }
    }
    if (closed) await closeEmpty(w, b.mint, row);
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

const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1] : null);
const nums = (xs: (number | undefined)[]) => xs.filter((x): x is number => typeof x === "number");

/**
 * For the status: numbers only. No address, token or signature. The one thing that could identify the wallet, the
 * time of each copy (recent[].at), is shown on the password-protected dashboard and removed from the public file.
 */
export function solanaCopyLiveSummary() {
  if (!loaded) load();
  const c = cfg();
  const rows = state.rows;
  const land = rows.filter((r) => r.buy === "landed");
  // the copies made since the exit became "target or time", counted apart from the fixed-hold ones before them
  const aimed = rows.filter((r) => r.exit);
  return {
    mode: "REAL",
    on: c.on && !state.halted && walletReady,
    switch: c.on ? "on" : "off",
    halted: state.halted,
    note: state.note || walletError,
    walletReady,
    stakeSol: c.stakeSol || HARD_STAKE_SOL,
    capSol: c.maxLossSol || HARD_MAX_LOSS_SOL,
    netSol: state.netSol,
    balanceSol: state.balanceSol,
    openPosition: state.open != null,
    exitRule: c.targetPct > 0 ? `sells at +${c.targetPct}% or after ${c.holdSec} s` : `sells after ${c.holdSec} s`,
    /**
     * What is held right now, in numbers only (the dashboard's "holding now" block reads these names). The token is
     * left out on purpose: a token and a moment are enough to find our transaction, and with it the wallet.
     * worthSol = what selling it all would bring back at the last look.
     */
    open: state.open ? { stakeSol: c.stakeSol || HARD_STAKE_SOL, heldSec: Math.max(0, Math.round((Date.now() - state.open.t) / 1000)), tries: state.open.tries, worthSol: state.open.worthSol ?? null, nowPct: state.open.nowPct ?? null, bestPct: state.open.bestPct ?? null } : null,
    targetExit: {
      copies: aimed.length,
      atTarget: aimed.filter((r) => r.exit === "target").length,
      atTimeUp: aimed.filter((r) => r.exit === "time").length,
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
    fillGapPctMedian: med(nums(land.map((r) => r.fillGapPct))),
    // `at` (when the copy started) is for the password-protected dashboard only: deploy/report.py takes it off the
    // public file, because the moment of a trade is enough to find the wallet that made it
    recent: rows.slice(-40).reverse().map((r) => ({ at: new Date(r.t).toISOString(), buy: r.buy, slotsBehind: r.slotsBehind ?? null, ahead: r.ahead ?? null, pipelineMs: r.pipelineMs ?? null, fillGapPct: r.fillGapPct ?? null, sold: r.sold ?? null, heldSec: r.heldSec ?? null, exit: r.exit ?? null, bestPct: r.bestPct ?? null, netSol: r.netSol })),
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
  // a position that could not be closed is tried again every 10 minutes (at most MAX_RECOVERIES times in all)
  setInterval(() => void (walletReady && state.open && !busy && recover()), 600_000).unref();
  return null;
}

/** Test hooks. */
export const _test = {
  setConfig: (c: LiveConfig | null) => (cfgOverride = c),
  reset: () => {
    state = { netSol: 0, trades: 0, day: "", dayCount: 0, halted: "", note: "", balanceSol: null, open: null, rows: [] };
    loaded = true;
    busy = false;
    lastAt = 0;
  },
  state: () => state,
  ready: () => {
    wallet();
    walletReady = true;
  },
  watch,
  setPoll: (ms: number) => (pollMs = ms),
};
