/**
 * SOL FOR FEES (15 Nov 2026, enrique: "in general we need some mechanic to prevent running out of sol for gas, do we
 * have that"; and of the perps wallet: "i sent too much sol but it uses usdc no?" / "yeah do the swap").
 *
 * What was there already: the two spot wallets (day-holder copy, spot rules) never buy unless the SOL left covers the
 * stake, the coin account's rent and a sell fee for every coin held, and a sell is never held back; the perps wallet
 * opens nothing under MIN_SOL and a close is never held back.
 *
 * What this adds, in the PERPS wallet only (the one whose money is USDC):
 *  - TOP-UP: when its SOL falls under TOPUP_UNDER_SOL, TOPUP_USD of USDC is swapped into SOL with Jupiter, at most once
 *    every TOPUP_GAP_MS, and only while no position is open or on its way.
 *  - ONE SWAP ON HIS WORD: deploy/live-rules.json solanaPerps.swapSolOnce { id, keepSol }: the SOL above keepSol is
 *    swapped into USDC, once per id (the id is written down before anything is sent).
 * And for every Solana wallet a LOW flag for the status and the dashboard (no balance, only the flag).
 * State: data/solana-gas.json. Off with SOLANA_LIVE=off.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, ROOT } from "../config.js";
import { signTransaction, type Wallet } from "./keys.js";
import { SOL, USDC } from "./pools.js";

export const TOPUP_UNDER_SOL = 0.03;
export const TOPUP_USD = 3;
export const TOPUP_GAP_MS = 6 * 3_600_000;
/** the least SOL the one swap may leave behind, whatever the file says */
export const KEEP_MIN_SOL = 0.03;
/** a spot wallet under this has little left for fees */
export const LOW_SPOT_SOL = 0.005;
const LAMPORTS = 1e9;
const MAX_FEE = 20_000;

type Swap = { id: string; at: number; result: string; soldSol?: number; gotUsdc?: number };
type Top = { t: number; usd: number; gotSol: number; result: string };
type State = { swap?: Swap; topups: Top[]; low: Record<string, boolean | null>; lowAt: number };
let state: State = { topups: [], low: {}, lowAt: 0 };
let loaded = false;
let busy = false;
const FILE = () => join(DATA, "solana-gas.json");
function load() {
  loaded = true;
  try {
    const s = JSON.parse(readFileSync(FILE(), "utf8")) as Partial<State>;
    state = { swap: s.swap, topups: Array.isArray(s.topups) ? s.topups : [], low: s.low ?? {}, lowAt: s.lowAt ?? 0 };
  } catch {
    /* first run */
  }
}
function save() {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(FILE() + ".tmp", JSON.stringify(state));
  renameSync(FILE() + ".tmp", FILE());
}

export interface GasDeps {
  /** the perps wallet */
  wallet: () => Wallet;
  /** other wallets to flag: name -> address ("" = none) */
  others: () => Record<string, string>;
  /** true while a perps position is open or on its way: nothing is swapped then */
  perpsBusy: () => boolean;
  swapOnce: () => { id: string; keepSol: number } | null;
  /** signs a transaction with the wallet (tests replace it) */
  sign?: (tx: string, w: Wallet) => string;
  kit: {
    quote: (inMint: string, outMint: string, amount: string, slippageBps: number) => Promise<{ outAmount?: string }>;
    swapTx: (quote: unknown, address: string, maxFeeLamports: number) => Promise<string>;
    send: (tx: string) => Promise<unknown>;
    landed: (sig: string, ms: number) => Promise<{ slot: number; err: unknown } | null>;
    sigOf: (tx: string) => string;
    balance: (address: string) => Promise<number>;
    held: (address: string, mint: string) => Promise<{ amount: bigint }>;
  };
}

/** The swap asked for in deploy/live-rules.json (solanaPerps.swapSolOnce), or null. */
export function fileSwap(): { id: string; keepSol: number } | null {
  if (process.env.SOLANA_LIVE === "off") return null;
  try {
    const s = (JSON.parse(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8")) as { solanaPerps?: { swapSolOnce?: { id?: unknown; keepSol?: unknown } } }).solanaPerps?.swapSolOnce;
    if (!s || typeof s.id !== "string" || !s.id) return null;
    return { id: s.id.slice(0, 40), keepSol: Math.max(KEEP_MIN_SOL, Number(s.keepSol) || 0.05) };
  } catch {
    return null;
  }
}

/** One Jupiter swap, sent until it lands (40 s). Returns what the wallet's SOL and USDC did, or why not. */
async function swap(d: GasDeps, w: Wallet, inMint: string, outMint: string, amount: string): Promise<{ result: string; dSol: number; dUsdc: number }> {
  const sol0 = await d.kit.balance(w.address);
  const usdc0 = Number((await d.kit.held(w.address, USDC)).amount) / 1e6;
  const q = await d.kit.quote(inMint, outMint, amount, 50);
  if (!q.outAmount) return { result: "no quote", dSol: 0, dUsdc: 0 };
  const tx = (d.sign ?? signTransaction)(await d.kit.swapTx(q, w.address, MAX_FEE), w);
  const sig = d.kit.sigOf(tx);
  const until = Date.now() + 40_000;
  let st: { slot: number; err: unknown } | null = null;
  while (!st && Date.now() < until) {
    await d.kit.send(tx).catch(() => undefined);
    st = await d.kit.landed(sig, 2500);
  }
  if (!st) return { result: "did not land", dSol: 0, dUsdc: 0 };
  if (st.err) return { result: "failed on chain", dSol: 0, dUsdc: 0 };
  const sol1 = await d.kit.balance(w.address);
  const usdc1 = Number((await d.kit.held(w.address, USDC)).amount) / 1e6;
  return { result: "done", dSol: sol1 - sol0, dUsdc: usdc1 - usdc0 };
}
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const r2 = (v: number) => Math.round(v * 100) / 100;

export async function gasTick(d: GasDeps, now = Date.now()): Promise<void> {
  if (busy) return;
  if (!loaded) load();
  busy = true;
  try {
    const w = d.wallet();
    const sol = await d.kit.balance(w.address);
    // the flags, every five minutes
    if (now - state.lowAt >= 300_000) {
      const low: Record<string, boolean | null> = { perps: sol < TOPUP_UNDER_SOL };
      for (const [name, address] of Object.entries(d.others())) low[name] = address ? await d.kit.balance(address).then((b) => b < LOW_SPOT_SOL, () => null) : null;
      state.low = low;
      state.lowAt = now;
      save();
    }
    if (d.perpsBusy()) return;
    const ask = d.swapOnce();
    if (ask && state.swap?.id !== ask.id) {
      state.swap = { id: ask.id, at: now, result: "started" };
      save();
      const spare = sol - ask.keepSol;
      if (spare < 0.01) state.swap.result = "nothing spare";
      else {
        const r = await swap(d, w, SOL, USDC, String(Math.floor(spare * LAMPORTS))).catch(() => ({ result: "not sent", dSol: 0, dUsdc: 0 }));
        state.swap = { ...state.swap, result: r.result, soldSol: r4(-r.dSol), gotUsdc: r2(r.dUsdc) };
      }
      save();
      return;
    }
    const last = state.topups[state.topups.length - 1];
    if (sol < TOPUP_UNDER_SOL && now - (last?.t ?? 0) >= TOPUP_GAP_MS) {
      const usdc = Number((await d.kit.held(w.address, USDC)).amount) / 1e6;
      if (usdc < TOPUP_USD + 1) return;
      const t: Top = { t: now, usd: TOPUP_USD, gotSol: 0, result: "started" };
      state.topups = [...state.topups, t].slice(-20);
      save();
      const r = await swap(d, w, USDC, SOL, String(Math.round(TOPUP_USD * 1e6))).catch(() => ({ result: "not sent", dSol: 0, dUsdc: 0 }));
      t.result = r.result;
      t.gotSol = r4(r.dSol);
      t.usd = r2(-r.dUsdc) || TOPUP_USD;
      save();
    }
  } catch {
    /* the next look tries again */
  } finally {
    busy = false;
  }
}

/** Status: flags and what was swapped. No balance and no address. */
export function gasSummary() {
  if (!loaded) load();
  return {
    note: `SOL for fees. Spot wallets: no buy unless the SOL left covers the stake, the rent and a sell fee for every coin held; sells are never held back; low = under ${LOW_SPOT_SOL} SOL. Perps wallet: opens nothing under its minimum; when its SOL is under ${TOPUP_UNDER_SOL}, $${TOPUP_USD} of USDC is swapped into SOL (at most once every ${TOPUP_GAP_MS / 3_600_000} h, never while a position is open).`,
    low: state.low,
    lowAt: state.lowAt || null,
    swapOnce: state.swap ?? null,
    topups: state.topups.slice(-5),
  };
}

/** Test hooks. */
export const _test = { reset: () => ((state = { topups: [], low: {}, lowAt: 0 }), (loaded = true), (busy = false)), state: () => state };
