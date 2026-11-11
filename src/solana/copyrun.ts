/**
 * PAPER ONLY runner for the wallet-copy speed test (logic in copy.ts). It listens, reads and asks for quotes.
 * It holds no wallet and never signs or sends a transaction. SOLANA_COPY=off disables it.
 *
 * Keys (data API keys, never in the repo, never logged or published):
 *   Helius:  env HELIUS_API_KEY, else data/helius-key.txt. Without it the slow public RPC is used.
 *   Jupiter: env JUPITER_API_KEY, else data/jupiter-key.txt. Without it the keyless host is tried (may be shut).
 * Files: data/solana/copy-signals.jsonl (one finished signal per line), data/solana-copy-summary.json.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA } from "../config.js";
import { crowd, DELAYS, EXITS, parseBuy, STAKE_SOL, summarize, TX_SOL, type Entry, type ParsedTx, type Signal } from "./copy.js";
import { SOL, USDC } from "./pools.js";
import { validAddress, WALLETS, type Tracked } from "./wallets.js";

const SIGNALS = () => join(DATA, "solana", "copy-signals.jsonl");
const SUMMARY = () => join(DATA, "solana-copy-summary.json");
const MAX_ACTIVE = 25;
const KEEP = 5000;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ---- keys -------------------------------------------------------------------------------------------------------
const keyCache = new Map<string, { v: string; t: number }>();
function key(env: string, file: string): string {
  const c = keyCache.get(env);
  if (c && (c.v || Date.now() - c.t < 300_000)) return c.v;
  let v = (process.env[env] ?? "").trim();
  if (!v) {
    try {
      v = readFileSync(join(DATA, file), "utf8").trim();
    } catch {
      v = "";
    }
  }
  keyCache.set(env, { v, t: Date.now() });
  return v;
}
const helius = () => key("HELIUS_API_KEY", "helius-key.txt");
const jupiter = () => key("JUPITER_API_KEY", "jupiter-key.txt");
/** Remove any key from text before it is stored or shown. */
export function scrub(s: string): string {
  for (const k of [helius(), jupiter()]) if (k) s = s.split(k).join("***");
  return s.replace(/api-key=[^&\s"']+/g, "api-key=***").slice(0, 200);
}

const health = {
  startedAt: 0, feed: "public", quotes: "none", wsUp: false, subs: 0, badWallets: [] as string[],
  txSeen: 0, buys: 0, skippedBusy: 0, active: 0, rpcErrors: 0, quoteErrors: 0, quoteOk: 0, lastError: "",
};
const fail = (e: unknown) => (health.lastError = scrub(String((e as Error)?.message ?? e)));

// ---- network ----------------------------------------------------------------------------------------------------
type Fetch = typeof fetch;
let net: Fetch = fetch;
const rpcUrl = () => (helius() ? `https://mainnet.helius-rpc.com/?api-key=${helius()}` : process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com");
const wsUrl = () => (helius() ? `wss://mainnet.helius-rpc.com/?api-key=${helius()}` : "wss://api.mainnet-beta.solana.com");

let gate: Promise<unknown> = Promise.resolve();
/** After a 429 (rate limit) every RPC call waits until this time. First run on the public RPC, 11 Nov 2026: 119
 *  errors in the first minute, all "http 429", and the liquidity reader shares that limit. */
let coolUntil = 0;
/** One RPC call at a time with a small gap, so a burst of signals cannot trip the rate limit. */
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const turn = gate.then(() => sleep(Math.max(helius() ? 25 : 400, coolUntil - Date.now())));
  gate = turn.catch(() => undefined);
  await turn;
  const res = await net(rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
  if (res.status === 429) coolUntil = Date.now() + (helius() ? 1000 : 30_000);
  if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
  const j = (await res.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result as T;
}

/** Jupiter quote: raw output amount for a raw input amount, fees and price impact included. null = no quote. */
async function quote(inMint: string, outMint: string, amount: string): Promise<bigint | null> {
  const k = jupiter();
  const base = k ? "https://api.jup.ag" : "https://lite-api.jup.ag";
  try {
    const res = await net(`${base}/swap/v1/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=2000&restrictIntermediateTokens=true`, { headers: k ? { "x-api-key": k } : {}, signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`quote http ${res.status}`);
    const j = (await res.json()) as { outAmount?: string };
    if (!j.outAmount) throw new Error("quote: no outAmount");
    health.quoteOk++;
    health.quotes = k ? "jupiter (key)" : "jupiter (no key)";
    return BigInt(j.outAmount);
  } catch (e) {
    health.quoteErrors++;
    fail(e);
    return null;
  }
}

// ---- state ------------------------------------------------------------------------------------------------------
let signals: Signal[] = [];
let loaded = false;
let slotNow = 0;
let solUsd: number | null = null;
const seen = new Set<string>();
const recentPair = new Map<string, number>();
const decimals = new Map<string, number>();

function load() {
  loaded = true;
  try {
    signals = readFileSync(SIGNALS(), "utf8").split("\n").filter(Boolean).slice(-KEEP).map((l) => JSON.parse(l) as Signal);
  } catch {
    signals = [];
  }
}

function tracked(): Tracked[] {
  let list = WALLETS;
  try {
    list = JSON.parse(readFileSync(join(DATA, "solana-wallets.json"), "utf8")) as Tracked[];
  } catch {
    /* built-in list */
  }
  health.badWallets = list.filter((w) => !validAddress(w.address)).map((w) => w.name);
  return list.filter((w) => validAddress(w.address));
}

export function buildCopySummary() {
  return {
    mode: "paper",
    note: `Paper only, nothing is sent. Each copy is ${STAKE_SOL} SOL at real Jupiter quotes, minus ${TX_SOL} SOL per transaction. A quote is the best case for a fill, so paper profit is an upper bound. Bar for real: 100+ copies on one rule, half or more won, net positive.`,
    updatedAt: Date.now(),
    solUsd,
    health: { ...health, active: health.active },
    ...(() => {
      // With the Helius key, score only buys read on the Helius feed and known within 30 s. Buys from the keyless
      // period, or read late out of a backlog, say nothing about our speed and would poison the medians.
      const clean = helius() ? signals.filter((x) => x.feed.startsWith("helius") && x.leaderTime > 0 && x.knownMs - x.leaderTime * 1000 <= 30_000) : signals;
      // leftOutSlow = read on the Helius feed but known more than 30 s late. Those ARE about our speed: if this
      // number keeps growing while the feed is healthy, the medians below flatter us.
      const slow = helius() ? signals.filter((x) => x.feed.startsWith("helius") && x.leaderTime > 0 && x.knownMs - x.leaderTime * 1000 > 30_000).length : 0;
      return { leftOut: signals.length - clean.length, leftOutSlow: slow, ...summarize(clean, solUsd) };
    })(),
  };
}

function publish() {
  try {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(SUMMARY() + ".tmp", JSON.stringify(buildCopySummary()));
    renameSync(SUMMARY() + ".tmp", SUMMARY());
  } catch (e) {
    fail(e);
  }
}

export function solanaCopySummary(): unknown {
  try {
    return JSON.parse(readFileSync(SUMMARY(), "utf8"));
  } catch {
    return null;
  }
}

// ---- one signal -------------------------------------------------------------------------------------------------
async function tokenDecimals(mint: string): Promise<number> {
  const c = decimals.get(mint);
  if (c !== undefined) return c;
  const r = await rpc<{ value: { decimals: number } }>("getTokenSupply", [mint]);
  decimals.set(mint, r.value.decimals);
  return r.value.decimals;
}

async function waveAfter(mint: string, sig: string, leaderSlot: number): Promise<{ slot: number; ok: boolean }[] | null> {
  type Row = { signature: string; slot: number; err: unknown };
  const all: Row[] = [];
  let before: string | undefined;
  for (let page = 0; page < 5; page++) {
    const rows = await rpc<Row[]>("getSignaturesForAddress", [mint, { until: sig, limit: 1000, ...(before ? { before } : {}), commitment: "confirmed" }]);
    all.push(...rows);
    if (rows.length < 1000) return all.reverse().filter((x) => x.slot >= leaderSlot).map((x) => ({ slot: x.slot, ok: !x.err }));
    before = rows[rows.length - 1].signature;
  }
  return null; // too busy to count from the start
}

async function onTx(w: Tracked, sig: string, seenMs: number) {
  if (seen.has(sig)) return;
  seen.add(sig);
  if (seen.size > 20_000) seen.clear();
  health.txSeen++;
  let tx: ParsedTx | null = null;
  // Without the Helius key the public RPC refuses most of these (11 Nov 2026: 2,534 errors and 3 buys read in 45
  // min), so only two tries there: more would just add to a limit the liquidity reader shares.
  // Version 1 transactions exist on mainnet (11 Nov 2026: asking for version 0 only made Helius refuse them, 787
  // errors in a minute). A refusal like that will not change on a retry, so only "not found yet" is retried.
  let refused = false;
  for (let i = 0; i < (helius() ? 8 : 2) && !tx && !refused; i++) {
    tx = await rpc<ParsedTx | null>("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]).catch((e) => {
      health.rpcErrors++;
      fail(e);
      refused = /not supported|invalid param/i.test(String((e as Error)?.message ?? e));
      return null;
    });
    if (!tx && !refused) await sleep(250);
  }
  const buy = parseBuy(tx, w.address);
  if (!buy) return;
  const pair = `${w.address}:${buy.mint}`;
  if (Date.now() - (recentPair.get(pair) ?? 0) < 30 * 60_000) return; // only the wallet's first buy of a token
  recentPair.set(pair, Date.now());
  if (health.active >= MAX_ACTIVE) {
    health.skippedBusy++;
    return;
  }
  health.active++;
  health.buys++;
  const knownMs = Date.now();
  const s: Signal = {
    sig, wallet: w.address, name: w.name, mint: buy.mint, leaderSlot: buy.slot, leaderTime: buy.blockTime, leaderSol: buy.sol, leaderPrice: buy.price,
    seenMs, knownMs, lagSlots: slotNow ? slotNow - buy.slot : null, feed: health.feed, entries: {}, exits: {}, crowd: null,
  };
  try {
    const dec = await tokenDecimals(buy.mint).catch(() => 6);
    const stake = String(Math.round(STAKE_SOL * 1e9));
    await Promise.all(DELAYS.map(async (d) => {
      const at = knownMs + d * 1000;
      await sleep(Math.max(0, at - Date.now()));
      const out = await quote(SOL, buy.mint, stake);
      const key = `d${d}`;
      s.exits[key] = {};
      if (out === null || out === 0n) {
        s.entries[key] = null;
        return;
      }
      const e: Entry = { t: Date.now(), slot: slotNow + 1, tokens: out.toString(), price: STAKE_SOL / (Number(out) / 10 ** dec) };
      s.entries[key] = e;
      await Promise.all([0, ...EXITS].map(async (x) => {
        if (x === 0 && d !== 0) return;
        await sleep(Math.max(0, e.t + x * 1000 - Date.now()));
        const back = await quote(buy.mint, SOL, e.tokens);
        s.exits[key][`x${x}`] = back === null ? null : Number(back) / 1e9;
      }));
    }));
    await sleep(Math.max(0, knownMs + 70_000 - Date.now()));
    const wave = await waveAfter(buy.mint, sig, buy.slot).catch((e) => (health.rpcErrors++, fail(e), null));
    if (wave) s.crowd = crowd(wave, buy.slot, s.entries);
    signals.push(s);
    if (signals.length > KEEP) signals.shift();
    mkdirSync(join(DATA, "solana"), { recursive: true });
    appendFileSync(SIGNALS(), JSON.stringify(s) + "\n");
  } catch (e) {
    fail(e);
  } finally {
    health.active--;
    publish();
  }
}

// ---- live feed --------------------------------------------------------------------------------------------------
let ws: WebSocket | null = null;
let stopped = false;
/** Transactions being looked at now. Every one queues RPC reads; past this many new ones are dropped, so a very
 *  busy wallet cannot build an endless queue in the process that also runs the Polymarket bot. */
let pending = 0;
const MAX_PENDING = 200;

function connect() {
  if (stopped) return;
  const list = tracked();
  health.feed = helius() ? "helius websocket" : "public websocket";
  const subOf = new Map<number, Tracked>();
  const reqOf = new Map<number, Tracked>();
  let sock: WebSocket;
  try {
    sock = new WebSocket(wsUrl());
  } catch (e) {
    fail(e);
    setTimeout(connect, 10_000);
    return;
  }
  ws = sock;
  health.subs = 0;
  sock.onopen = () => {
    health.wsUp = true;
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slotSubscribe" }));
    list.forEach((w, i) => {
      reqOf.set(100 + i, w);
      sock.send(JSON.stringify({ jsonrpc: "2.0", id: 100 + i, method: "logsSubscribe", params: [{ mentions: [w.address] }, { commitment: "processed" }] }));
    });
  };
  sock.onmessage = (ev) => {
    const now = Date.now();
    let m: { id?: number; result?: number; error?: { message: string }; method?: string; params?: { subscription: number; result: { slot?: number; value?: { signature: string; err: unknown } } } };
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (m.id !== undefined) {
      const w = reqOf.get(m.id);
      if (w && typeof m.result === "number") {
        subOf.set(m.result, w);
        health.subs = subOf.size;
      } else if (m.error && m.id !== 2) fail(new Error(`subscribe: ${m.error.message}`)); // id 2 is only our keep-alive
      return;
    }
    if (m.method === "slotNotification" && m.params?.result.slot) slotNow = m.params.result.slot;
    else if (m.method === "logsNotification" && m.params) {
      const w = subOf.get(m.params.subscription);
      const v = m.params.result.value;
      if (w && v && !v.err && !/^1+$/.test(v.signature)) {
        if (pending >= MAX_PENDING) health.skippedBusy++;
        else {
          pending++;
          void onTx(w, v.signature, now).catch(fail).finally(() => pending--);
        }
      }
    }
  };
  sock.onerror = () => fail(new Error("websocket error"));
  sock.onclose = () => {
    health.wsUp = false;
    if (ws === sock) setTimeout(connect, 5000);
  };
}

async function refreshSolUsd() {
  const out = await quote(SOL, USDC, "1000000000");
  if (out) solUsd = Number(out) / 1e6;
}

export function startSolanaCopy(fetcher: Fetch = fetch) {
  if (process.env.SOLANA_COPY === "off") return null;
  if (typeof WebSocket === "undefined") {
    health.lastError = "this Node has no WebSocket (needs Node 22+)";
    publish();
    return null;
  }
  net = fetcher;
  if (!loaded) load();
  health.startedAt = Date.now();
  stopped = false;
  connect();
  void refreshSolUsd();
  let n = 0;
  let hadKey = !!helius();
  return setInterval(() => {
    publish();
    if (++n % 10 === 0) void refreshSolUsd();
    if (!hadKey && helius()) {
      hadKey = true; // the key file arrived: move to the faster feed without a restart
      ws?.close();
    }
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "getSlot" }));
  }, 30_000);
}

export function stopSolanaCopy() {
  stopped = true;
  ws?.close();
}

/** Test hooks. */
export const _test = { onTx, setNet: (f: Fetch) => (net = f), setSlot: (n: number) => (slotNow = n), signals: () => signals, load: () => load() };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`solana copy test: ${WALLETS.length} wallets, helius key ${helius() ? "yes" : "no"}, jupiter key ${jupiter() ? "yes" : "no"}`);
  startSolanaCopy();
  setInterval(() => console.log(new Date().toISOString(), JSON.stringify({ ...health, signals: signals.length })), 60_000);
}
