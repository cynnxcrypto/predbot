/**
 * REAL MONEY (small, capped): the landing-speed test for wallet copying. enrique, 11 Nov 2026 16:21 KST: "go 0.5".
 *
 * What it does: when a tracked wallet's buy arrives on the fast stream, buy STAKE of the same token at once, hold a
 * few seconds, sell everything, and record where our buy really landed (how many slots behind the wallet, how
 * many transactions ahead of us), what we really paid against the wallet's price, and what came back. The purpose
 * is to measure, not to earn: paper cannot tell whether our own order lands in time.
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
import { buildSigned, signTransaction, wallet } from "./keys.js";
import { SOL } from "./pools.js";

export const HARD_STAKE_SOL = 0.05;
export const HARD_MAX_LOSS_SOL = 0.5;
const STATE = () => join(DATA, "solana-copylive.json");
const ROWS = () => join(DATA, "solana", "copylive-trades.jsonl");
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export interface LiveConfig {
  on: boolean;
  stakeSol: number;
  maxLossSol: number;
  holdSec: number;
  maxPerDay: number;
  slippageBps: number;
  /** most we will pay in priority fee per transaction, lamports */
  maxFeeLamports: number;
}
const OFF: LiveConfig = { on: false, stakeSol: 0, maxLossSol: 0, holdSec: 5, maxPerDay: 0, slippageBps: 1500, maxFeeLamports: 0 };
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
  buy: "landed" | "failed on chain" | "did not land" | "not sent";
  /** what we really paid over the wallet's price, % */
  fillGapPct?: number;
  sold?: boolean;
  sellTries?: number;
  heldSec?: number;
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
  rows: Row[];
}
let state: State = { netSol: 0, trades: 0, day: "", dayCount: 0, halted: "", note: "", balanceSol: null, rows: [] };
let loaded = false;
let busy = false;
let lastAt = 0;
let walletReady = false;
let walletError = "";

function load() {
  loaded = true;
  try {
    state = { ...state, ...(JSON.parse(readFileSync(STATE(), "utf8")) as State) };
  } catch {
    /* fresh */
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

/** One real copy, start to finish. Never throws. */
export async function trade(b: StreamBuy) {
  if (!loaded) load();
  const c = cfg();
  if (!c.on || state.halted || busy || !walletReady) return;
  if (!shared.helius() || !shared.jupiter()) return void (state.note = "needs both API keys");
  if (Date.now() - lastAt < 10_000) return;
  const day = dayOf(Date.now());
  if (day !== state.day) {
    state.day = day;
    state.dayCount = 0;
  }
  if (state.dayCount >= c.maxPerDay) return void (state.note = "daily count reached");
  if (-state.netSol + c.stakeSol + 0.01 > c.maxLossSol) {
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
  try {
    bal0 = await balance(w.address);
    state.balanceSol = bal0;
    if (bal0 < c.stakeSol + 0.02) {
      state.note = "wallet balance too low for a copy";
      return;
    }
    state.note = "";
    const t0 = performance.now();
    const q = await quote(SOL, b.mint, String(Math.round(c.stakeSol * 1e9)), c.slippageBps);
    if (!q.outAmount || q.outAmount === "0") throw new Error("no buy quote");
    const t1 = performance.now();
    const tx = signTransaction(await swapTx(q, w.address, c.maxFeeLamports), w);
    const t2 = performance.now();
    row.sentSlot = shared.slot();
    const sig = await send(tx);
    sent = true;
    state.trades++;
    state.dayCount++;
    row.sigs.push(sig);
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
      await sleep(c.holdSec * 1000);
      row.sold = false;
      row.sellTries = 0;
      for (let i = 0; i < 6 && !row.sold; i++) {
        h = await held(w.address, b.mint);
        if (h.amount === 0n) {
          row.sold = true;
          break;
        }
        row.sellTries++;
        try {
          const q2 = await quote(b.mint, SOL, h.amount.toString(), Math.min(5000, 2000 + 600 * i));
          if (!q2.outAmount) throw new Error("no sell quote");
          const s2 = await send(signTransaction(await swapTx(q2, w.address, c.maxFeeLamports), w));
          row.sigs.push(s2);
          await landed(s2, 12_000);
        } catch (e) {
          row.error = scrub(String((e as Error).message));
          await sleep(1000);
        }
      }
      if (!row.sold) row.sold = (await held(w.address, b.mint)).amount === 0n;
      row.heldSec = Math.round((Date.now() - heldFrom) / 100) / 10;
      if (!row.sold) state.halted = "could not sell a position: tokens are still in the wallet";
    }
    // get the token account's rent back (about 0.002 SOL each); best effort
    if (row.sold !== false) {
      for (const a of (await held(w.address, b.mint).catch(() => ({ accounts: [] as Held["accounts"] }))).accounts.filter((x) => x.amount === 0n)) {
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
  } catch (e) {
    row.error = scrub(String((e as Error).message));
    // whatever went wrong, never leave without knowing whether we hold the token
    if (sent) {
      const left = await held(w.address, b.mint).catch(() => null);
      if (!left || left.amount > 0n) state.halted = "an error left a position open or unknown: check the wallet";
    }
  } finally {
    try {
      if (bal0 !== null && sent) {
        await sleep(800);
        const bal1 = await balance(w.address);
        state.balanceSol = bal1;
        row.netSol = Math.round((bal1 - bal0) * 1e6) / 1e6;
        state.netSol = Math.round((state.netSol + row.netSol) * 1e6) / 1e6;
      }
    } catch {
      state.halted = state.halted || "could not read the wallet balance after a copy";
    }
    if (sent || row.error) {
      state.rows.push(row);
      if (state.rows.length > 200) state.rows.shift();
      try {
        mkdirSync(join(DATA, "solana"), { recursive: true });
        appendFileSync(ROWS(), JSON.stringify(row) + "\n");
      } catch {
        /* state file still has it */
      }
    }
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

const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1] : null);
const nums = (xs: (number | undefined)[]) => xs.filter((x): x is number => typeof x === "number");

/** For the public status: numbers only. No address, token, signature or time that could identify the wallet. */
export function solanaCopyLiveSummary() {
  if (!loaded) load();
  const c = cfg();
  const rows = state.rows;
  const land = rows.filter((r) => r.buy === "landed");
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
    recent: rows.slice(-15).reverse().map((r) => ({ buy: r.buy, slotsBehind: r.slotsBehind ?? null, ahead: r.ahead ?? null, pipelineMs: r.pipelineMs ?? null, fillGapPct: r.fillGapPct ?? null, sold: r.sold ?? null, heldSec: r.heldSec ?? null, netSol: r.netSol })),
  };
}

export function startSolanaCopyLive() {
  if (process.env.SOLANA_LIVE === "off") return null;
  if (!loaded) load();
  try {
    wallet();
    walletReady = true;
  } catch (e) {
    walletError = String((e as Error).message).slice(0, 120);
  }
  onStreamBuy((b) => void trade(b));
  return null;
}

/** Test hooks. */
export const _test = {
  setConfig: (c: LiveConfig | null) => (cfgOverride = c),
  reset: () => {
    state = { netSol: 0, trades: 0, day: "", dayCount: 0, halted: "", note: "", balanceSol: null, rows: [] };
    loaded = true;
    busy = false;
    lastAt = 0;
  },
  state: () => state,
  ready: () => {
    wallet();
    walletReady = true;
  },
};
