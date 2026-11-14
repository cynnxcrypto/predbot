/**
 * PAPER ONLY runner for the wallet-copy speed test (logic in copy.ts). It listens, reads and asks for quotes.
 * It holds no wallet and never signs or sends a transaction. SOLANA_COPY=off disables it.
 *
 * Keys (data API keys, never in the repo, never logged or published):
 *   Helius:  env HELIUS_API_KEY, else data/helius-key.txt. Without it the slow public RPC is used.
 *   Jupiter: env JUPITER_API_KEY, else data/jupiter-key.txt. Without it the keyless host is tried (may be shut).
 * Files: data/solana/copy-signals.jsonl (one finished signal per line), data/solana/copy-waves.jsonl (one finished
 * second-wave trade per line; SOLANA_WAVE=off stops that measurement), data/solana-copy-summary.json.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA } from "../config.js";
import { crowd, type RealCopy, EXITS, followerPrice, fomoStudy, LATE_CHECK_MS, LATE_ENTRY_MS, parseBuy, parseDollarBuy, PATH, REAL_D, REPEAT_MIN, SIZE_EXITS, SIZES, STAKE_SOL, paceAt, summarize, TX_SOL, unlate, unrefuse, verdictAt, WAVE_ENDS, WAVE_ENTRIES, WAVE_MIN_BUYERS, WAVE_STAKE_SOL, waveQuotedStudy, type Entry, type Pace, type ParsedTx, type Signal, type Verdict, type WaveLot, type WaveTrade } from "./copy.js";
import { SOL, USDC } from "./pools.js";
import { busyWallets, discoverSummary, foundWallets, startDiscover, stopDiscover } from "./discover.js";
import { slowSummary, slowTx, slowWatch, startSlow, stopSlow } from "./slow.js";
import { historySummary, startHistory, stopHistory } from "./history.js";
import { linkedWallets, linksSummary, seedWallets, startLinks, stopLinks } from "./links.js";
import { preconfSeen, preconfSummary, startPreconf, stopPreconf } from "./preconf.js";
import { startCandles } from "./candles.js";
import { dipSummary, startDip, stopDip } from "./dip.js";
import { mktSummary, startMktDip, stopMktDip } from "./mktdip.js";
import { validAddress, WALLETS, type Tracked } from "./wallets.js";

const SIGNALS = () => join(DATA, "solana", "copy-signals.jsonl");
const SUMMARY = () => join(DATA, "solana-copy-summary.json");
const WAVES = () => join(DATA, "solana", "copy-waves.jsonl");
const WAVE_KEEP = 3000;
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
  startedAt: 0, feed: "public", stream: "not tried", streamTx: 0, quotes: "none", wsUp: false, wallets: 0, found: 0, fomo: 0, tails: 0, subs: 0, badWallets: [] as string[],
  senderPingMs: {} as Record<string, number | null>, quoteMsMedian: null as number | null,
  txSeen: 0, buys: 0, skippedBusy: 0, active: 0, rpcErrors: 0, quoteErrors: 0, quoteOk: 0, quoteRefused: 0, quoteHeld: 0, quoteLost: 0, quoteLate: 0, lateTakenOut: null as ReturnType<typeof unlate> | null, quoteWaitMsMedian: null as number | null, quoteWaitMsP90: null as number | null, waveLive: 0, waveSaved: 0, lastError: "",
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

/**
 * The real test first. Paper and real share one Jupiter key and so one request allowance. 12 Nov 2026 00:05 to 00:11
 * KST: a burst of 27 trader buys in six minutes, the paper test asked its dozens of quotes for each, and the price
 * service refused 7 of the real test's own buys ("too many requests"): never sent, while enrique was watching for a
 * trade. So the real test calls realFirst() when it starts a copy and whenever it is refused, and until that time has
 * passed the paper test asks nothing new: its checks wait (a check a second late is still a check). The paper test
 * also stands back for a moment after a refusal of its own. The one paper quote that is never held is the fastest
 * entry of a buy: it is a single request and the paper record needs the price of that very moment.
 */
let holdUntil = 0;
export const realFirst = (ms: number) => void (holdUntil = Math.max(holdUntil, Date.now() + Math.min(ms, 5000)));
const PAPER_BACKOFF_MS = 1500;
/**
 * Paper quotes leave one at a time, PAPER_GAP_MS apart. Before 12 Nov 2026 01:20 KST every quote that had been held
 * left at the same instant when the hold ended; the price service refused them in the hundreds (321 refusals in
 * half an hour) and each refusal held the rest again.
 * 12 Nov 2026 03:00 KST: at 25 ms apart (40 a second in a burst) the price service still refused 498 paper
 * requests in half an hour, and the REAL test, which shares the key, had 6 buys refused and 22 asked twice in
 * 40 minutes. Now 5 a second at most, and each buy asks for about half as much (see MEASURED_DELAYS and
 * MEASURED_SIZES). health.quoteWaitMs* says how long a paper request stands in line.
 * 12 Nov 2026 03:45 KST: at 5 a second and about 420 buys an hour the line was 39 s long in busy minutes, and a
 * check taken 39 s late was written down as the price of its moment. A request whose turn comes later than its
 * limit (LATE_CHECK_MS, LATE_ENTRY_MS for an entry) is now not sent at all: the check counts as not measured
 * (health.quoteLate), the line empties at once, and what is written down was taken on time.
 */
export const PAPER_GAP_MS = 200;
/** How often a paper quote the price service refused for asking too fast is asked again. */
export const PAPER_RETRIES = 1;
/**
 * What each buy is still measured for. The late entries (5, 10, 20 s after we know) and the stakes of 1 and 3 SOL
 * are settled questions: 579 buys say every late entry loses (5 s later: -5.5% a trade), and 625 say an in-and-out
 * costs 6% at 1 SOL and 12% at 3 SOL. They were 34 of the about 72 price requests a buy took. The buys measured
 * before keep their numbers; lateStudy and the 1 and 3 SOL rows of sizeStudy stand still from here.
 * 12 Nov 2026 03:45 KST: the entry 3 s late goes the same way (1,110 buys: -6.6% a trade, the fastest +0.8%), 8 of
 * the 37 requests a buy still put in the line. The entry 1 s late stays: the real test's own buy lands about that
 * long after we know.
 */
export const MEASURED_DELAYS: readonly number[] = [0, 1];
export const MEASURED_SIZES: readonly number[] = SIZES.filter((x) => x < 1);
const waits: number[] = [];
let lastOut = 0;
let lane: Promise<void> = Promise.resolve();
/**
 * A request's turn in the line. `since` is when the check was first asked for and `late` how long after that it may
 * still leave. false = its turn came too late: it is not sent, and the next in line does not wait for it.
 */
function paperTurn(since: number, late: number): Promise<boolean> {
  const asked = Date.now();
  const mine = lane.then(async () => {
    if (Date.now() < holdUntil) {
      health.quoteHeld++;
      // at most 6 s in all, so a string of real copies can delay a paper check but never stop it
      for (let waited = 0; Date.now() < holdUntil && waited < 6000; waited += 50) {
        if (Date.now() - since > late) return false;
        await sleep(50);
      }
    }
    // the gap is between two requests going out, so a request that finds the line empty leaves at once
    const out = Math.max(Date.now(), lastOut + PAPER_GAP_MS);
    if (out - since > late) return false;
    if (out > Date.now()) await sleep(out - Date.now());
    lastOut = Date.now();
    waits.push(lastOut - asked);
    if (waits.length > 500) waits.shift();
    const sorted = [...waits].sort((a, b) => a - b);
    health.quoteWaitMsMedian = sorted[sorted.length >> 1];
    health.quoteWaitMsP90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
    return true;
  });
  lane = mine.then(() => undefined, () => undefined);
  return mine;
}

/** Jupiter's token lists (read-only, three calls every 6 h for the slow study). Errors carry only fixed text. */
async function jupList(path: string): Promise<unknown> {
  const k = jupiter();
  const base = k ? "https://api.jup.ag" : "https://lite-api.jup.ag";
  let res: Response;
  try {
    res = await net(`${base}${path}`, { headers: k ? { "x-api-key": k } : {}, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new Error("jupiter tokens: no answer");
  }
  if (!res.ok) throw new Error(`jupiter tokens: http ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error("jupiter tokens: not json");
  }
}

/**
 * Jupiter quote: raw output amount for a raw input amount, fees and price impact included.
 * null = the price service answered and has no price (no route: the token cannot be traded that way now).
 * undefined = the request itself failed (refused for asking too fast, time-out, network, server error) or was not
 * sent because its turn came more than `late` ms after it was asked for: nothing was measured, and nothing may be
 * concluded from it.
 */
async function quote(inMint: string, outMint: string, amount: string, now = false, late = LATE_CHECK_MS): Promise<bigint | null | undefined> {
  const k = jupiter();
  const base = k ? "https://api.jup.ag" : "https://lite-api.jup.ag";
  const since = Date.now();
  for (let attempt = 0; ; attempt++) {
    // the fastest entry of a buy goes out at once, as the real test's own quote does; everything else takes its turn
    if ((!now || attempt > 0) && !(await paperTurn(since, late))) {
      health.quoteLate++;
      return undefined;
    }
    const t0 = performance.now();
    try {
      const res = await net(`${base}/swap/v1/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=2000&restrictIntermediateTokens=true`, { headers: k ? { "x-api-key": k } : {}, signal: AbortSignal.timeout(4000) });
      if (res.status === 429) {
        health.quoteRefused++;
        holdUntil = Math.max(holdUntil, Date.now() + PAPER_BACKOFF_MS);
        if (attempt < PAPER_RETRIES) continue;
      }
      if (!res.ok) throw new Error(`quote http ${res.status}`);
      const j = (await res.json()) as { outAmount?: string };
      if (!j.outAmount) throw new Error("quote: no outAmount");
      health.quoteOk++;
      quoteMs.push(performance.now() - t0);
      if (quoteMs.length > 100) quoteMs.shift();
      health.quoteMsMedian = Math.round([...quoteMs].sort((a, b) => a - b)[quoteMs.length >> 1]);
      health.quotes = k ? "jupiter (key)" : "jupiter (no key)";
      return BigInt(j.outAmount);
    } catch (e) {
      health.quoteErrors++;
      fail(e);
      // "http 400" and an answer without an amount are the price service saying no; anything else was not an answer
      const m = String((e as Error)?.message ?? e);
      if (/quote http 40[04]\b|no outAmount/.test(m)) return null;
      health.quoteLost++;
      return undefined;
    }
  }
}

const quoteMs: number[] = [];

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
    // a signal is written again once its long checks (3 to 10 min) are in: the later line replaces the earlier one
    const bySig = new Map<string, Signal>();
    for (const l of readFileSync(SIGNALS(), "utf8").split("\n").filter(Boolean).slice(-2 * KEEP)) {
      const x = unrefuse(JSON.parse(l) as Signal);
      bySig.set(x.sig, x);
    }
    signals = [...bySig.values()].slice(-KEEP);
    health.lateTakenOut = unlate(signals);
  } catch {
    signals = [];
  }
  try {
    waves = readFileSync(WAVES(), "utf8").split("\n").filter(Boolean).slice(-WAVE_KEEP).map((l) => JSON.parse(l) as WaveTrade);
  } catch {
    waves = [];
  }
  // who bought which coin in the last half hour, so a coin's count of listed buyers is not zero after a restart
  mintBuys.clear();
  for (const x of signals) if (!x.fomo && x.feed === "helius transaction stream" && Date.now() - x.knownMs <= REPEAT_MIN * 60_000) mintBuys.set(x.mint, [...(mintBuys.get(x.mint) ?? []), { wallet: x.wallet, t: x.knownMs }]);
}

/**
 * The real test's finished copies (copylive.ts writes them), read only for the buy-size table: coin, the wallet's
 * slot, how the buy went and the SOL it made or lost. Nothing else of our own wallet is read. A missing file = none.
 */
function realCopies(): RealCopy[] {
  try {
    const out: RealCopy[] = [];
    for (const l of readFileSync(join(DATA, "solana", "copylive-trades.jsonl"), "utf8").split("\n")) {
      if (!l) continue;
      try {
        const x = JSON.parse(l);
        if (typeof x?.mint === "string" && typeof x.leaderSlot === "number" && typeof x.netSol === "number" && typeof x.buy === "string") out.push({ mint: x.mint, leaderSlot: x.leaderSlot, buy: x.buy, netSol: x.netSol });
      } catch {
        /* a torn line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** With a Helius key, how many wallets also get the slower signature feed (each of its buys costs a second request). */
const LOGS_MAX = 50;

/** Most wallets the finder may add to one connection. */
const FOUND_MAX = 100;
const foundAs = (address: string): Tracked => linkedWallets().find((w) => w.address === address) ?? { name: `found ${address.slice(0, 4)}`, address, found: true };
/** Wallets watched on paper only: the tracer's side wallets first (links.ts), then the finder's (discover.ts). */
const extra = (): string[] => [...new Set([...linkedWallets().map((w) => w.address), ...foundWallets()])];

/** The listed wallets: the built-in list, or data/solana-wallets.json when it exists. */
function listed(): Tracked[] {
  let list = WALLETS;
  try {
    list = JSON.parse(readFileSync(join(DATA, "solana-wallets.json"), "utf8")) as Tracked[];
  } catch {
    /* built-in list */
  }
  health.badWallets = list.filter((w) => !validAddress(w.address)).map((w) => w.name);
  return list.filter((w) => validAddress(w.address));
}

/** The fomo traders' own wallets (seeds.ts), watched on paper only. SOLANA_FOMO=off leaves them out. */
const fomoWallets = (): Tracked[] => (process.env.SOLANA_FOMO === "off" ? [] : seedWallets());
/** A wallet's buy in this transaction. A fomo trader's is paid in dollars and need not name the wallet at all. */
const buyOf = (tx: ParsedTx | null, w: Tracked) => (w.fomo ? parseDollarBuy(tx, w.address, solUsd) : null) ?? parseBuy(tx, w.address);
/** Every address the stream should listen on for these wallets. */
const feedOf = (list: Tracked[]) => [...new Set(list.flatMap((w) => [w.address, ...(w.accounts ?? [])]))];

/** Listed wallets first (their order matters: the first LOGS_MAX keep the signature feed), then the fomo traders, then the found ones. */
function tracked(): Tracked[] {
  const list = [...listed()];
  const have = new Set(list.map((w) => w.address));
  const fomo = fomoWallets().filter((w) => !have.has(w.address));
  for (const w of fomo) have.add(w.address);
  list.push(...fomo);
  const found = extra().filter((a) => !have.has(a) && validAddress(a)).slice(0, FOUND_MAX).map(foundAs);
  list.push(...found);
  health.wallets = list.length;
  health.fomo = fomo.length;
  health.found = found.length;
  return list;
}

export function buildCopySummary() {
  return {
    mode: "paper",
    note: `Paper only, nothing is sent. Each copy is ${STAKE_SOL} SOL at real Jupiter quotes, minus ${TX_SOL} SOL per transaction, bought ${REAL_D} s or more after we know of the wallet's buy: that is where a real order lands. The quote of the instant we know is a price no order gets; rules priced there are kept apart in rulesInstant and count for nothing. A quote is still the best case for a fill, so paper profit is an upper bound. Bar for real: 100+ copies on one rule, half or more won, net positive.`,
    updatedAt: Date.now(),
    solUsd,
    health: { ...health, active: health.active },
    discovery: discoverSummary(),
    history: historySummary(),
    slow: slowSummary(),
    links: linksSummary(),
    preconf: preconfSummary(),
    fomo: fomoStudy(signals.filter((x) => x.fomo), solUsd),
    waveQuoted: waveQuotedStudy(waves),
    dip: dipSummary(),
    marketDip: mktSummary(),
    ...(() => {
      // With the Helius key, score only buys read on the Helius feed and known within 30 s. Buys from the keyless
      // period, or read late out of a backlog, say nothing about our speed and would poison the medians.
      // The fomo traders' own buys are a different thing (people in an app follow them, not bots) and are scored apart.
      const own = signals.filter((x) => !x.fomo);
      const clean = helius() ? own.filter((x) => x.feed.startsWith("helius") && x.leaderTime > 0 && x.knownMs - x.leaderTime * 1000 <= 30_000) : own;
      // leftOutSlow = read on the Helius feed but known more than 30 s late. Those ARE about our speed: if this
      // number keeps growing while the feed is healthy, the medians below flatter us.
      const slow = helius() ? own.filter((x) => x.feed.startsWith("helius") && x.leaderTime > 0 && x.knownMs - x.leaderTime * 1000 > 30_000).length : 0;
      // Speed per feed, so the fast stream and the slower signature feed are never averaged together.
      const byFeed = [...new Set(clean.map((x) => x.feed))].map((feed) => ({ feed, ...summarize(clean.filter((x) => x.feed === feed), solUsd).speed }));
      // Once the fast stream has delivered buys, rules and wallets are scored on stream buys only: that is the setup
      // we would trade with, and mixing in the slower feed's entries would blur exactly what we are trying to see.
      const fast = clean.filter((x) => x.feed === "helius transaction stream");
      const scored = fast.length ? fast : clean;
      return { leftOut: own.length - scored.length, leftOutSlow: slow, scoredFeed: fast.length ? "helius transaction stream" : "all clean feeds", byFeed, ...summarize(scored, solUsd, realCopies()) };
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

export interface StreamBuy {
  sig: string;
  /** the trader's own (public, listed) address: the key of the trader's record */
  wallet?: string;
  name: string;
  mint: string;
  leaderSlot: number;
  leaderPrice: number;
  /** decimal places of the token, when the wallet's transaction says */
  decimals?: number;
  knownMs: number;
}
let buyHook: ((b: StreamBuy) => void) | null = null;
/** copylive.ts registers here to be told of each fast-stream buy the moment it is known. */
export const onStreamBuy = (f: ((b: StreamBuy) => void) | null) => (buyHook = f);
/** What the real test shares with this runner: the keys, the RPC address, the current slot, the follower count. */
/**
 * What the paper record says of a trader right now (see verdictOf in copy.ts): the same buys the paper rules are
 * scored on, fast stream only, known within 30 s. The real test asks this before it copies.
 */
export function traderVerdict(wallet: string | undefined, atMs = Date.now()): Verdict {
  if (!wallet) return "new";
  return verdictAt(signals.filter((x) => !x.fomo && x.feed === "helius transaction stream" && x.leaderTime > 0 && x.knownMs - x.leaderTime * 1000 <= 30_000), wallet, atMs);
}
/** How often the trader has bought lately (see paceAt in copy.ts), from the same buys. */
export function traderPace(wallet: string | undefined, atMs = Date.now()): Pace {
  if (!wallet) return "calm";
  return paceAt(signals.filter((x) => !x.fomo && x.feed === "helius transaction stream" && x.leaderTime > 0 && x.knownMs - x.leaderTime * 1000 <= 30_000), wallet, atMs);
}
export const shared = { verdict: (wallet: string | undefined) => traderVerdict(wallet), pace: (wallet: string | undefined) => traderPace(wallet), realFirst: (ms: number) => realFirst(ms), helius: () => helius(), jupiter: () => jupiter(), rpcUrl: () => rpcUrl(), slot: () => slotNow, waveAfter: (mint: string, sig: string, slot: number) => waveAfter(mint, sig, slot), fetch: () => net };

// ---- one signal -------------------------------------------------------------------------------------------------
async function tokenDecimals(mint: string): Promise<number> {
  const c = decimals.get(mint);
  if (c !== undefined) return c;
  const r = await rpc<{ value: { decimals: number } }>("getTokenSupply", [mint]);
  decimals.set(mint, r.value.decimals);
  return r.value.decimals;
}

async function waveAfter(mint: string, sig: string, leaderSlot: number): Promise<{ slot: number; ok: boolean; sig: string }[] | null> {
  type Row = { signature: string; slot: number; err: unknown };
  const all: Row[] = [];
  let before: string | undefined;
  for (let page = 0; page < 5; page++) {
    const rows = await rpc<Row[]>("getSignaturesForAddress", [mint, { until: sig, limit: 1000, ...(before ? { before } : {}), commitment: "confirmed" }]);
    all.push(...rows);
    if (rows.length < 1000) return all.reverse().filter((x) => x.slot >= leaderSlot).map((x) => ({ slot: x.slot, ok: !x.err, sig: x.signature }));
    before = rows[rows.length - 1].signature;
  }
  return null; // too busy to count from the start
}

async function onTx(w: Tracked, sig: string, seenMs: number, ready: ParsedTx | null = null) {
  if (seen.has(sig)) return;
  seen.add(sig);
  if (seen.size > 20_000) seen.clear();
  health.txSeen++;
  let tx: ParsedTx | null = ready; // the transaction stream hands us the whole transaction: no lookup, no wait
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
  const buy = buyOf(tx, w);
  if (!buy) return;
  const pair = `${w.address}:${buy.mint}`;
  if (Date.now() - (recentPair.get(pair) ?? 0) < 30 * 60_000) return; // only the wallet's first buy of a token
  recentPair.set(pair, Date.now());
  // the second-wave measurement counts the same buys the real test would see: listed wallets on the fast stream
  if (ready && !w.found && !w.fomo) waveOnBuy(buy.mint, w.address, Date.now());
  if (health.active >= MAX_ACTIVE) {
    health.skippedBusy++;
    return;
  }
  health.active++;
  health.buys++;
  const knownMs = Date.now();
  // the real test (copylive.ts) acts only on fast-stream buys, and first, before any paper quote is asked for
  if (ready && buyHook && !w.found && !w.fomo) {
    try {
      buyHook({ sig, wallet: w.address, name: w.name, mint: buy.mint, leaderSlot: buy.slot, leaderPrice: buy.price, decimals: buy.decimals, knownMs });
    } catch (e) {
      fail(e);
    }
  }
  const s: Signal = {
    sig, wallet: w.address, name: w.name, mint: buy.mint, leaderSlot: buy.slot, leaderTime: buy.blockTime, leaderSol: buy.sol, leaderPrice: buy.price,
    seenMs, knownMs, lagSlots: slotNow ? slotNow - buy.slot : null, feed: ready ? "helius transaction stream" : health.feed, entries: {}, exits: {}, path: {}, crowd: null, onTime: true, ...(w.fomo ? { fomo: true } : {}),
  };
  try {
    const dec = await tokenDecimals(buy.mint).catch(() => 6);
    const stake = String(Math.round(STAKE_SOL * 1e9));
    // the size check: the same copy at other stakes, priced now and sold again at a few fixed times
    const sized = MEASURED_SIZES.map(async (sol) => {
      const out = await quote(SOL, buy.mint, String(Math.round(sol * 1e9)));
      if (!out) return;
      const t = Date.now();
      const got: Record<string, number | null> = {};
      await Promise.all(SIZE_EXITS.map(async (x) => {
        await sleep(Math.max(0, t + x * 1000 - Date.now()));
        const back = await quote(buy.mint, SOL, out.toString());
        // a request that failed is left out (not measured); only an answer of "no price" is written down as none
        if (back !== undefined) got[`x${x}`] = back === null ? null : Number(back) / 1e9;
      }));
      (s.sizes ??= {})[String(sol)] = got;
    });
    await Promise.all([...sized, ...MEASURED_DELAYS.map(async (d) => {
      const at = knownMs + d * 1000;
      await sleep(Math.max(0, at - Date.now()));
      // an entry asked for late (the token's look-up took long) has that much less time left to be on time
      const out = await quote(SOL, buy.mint, stake, d === 0, LATE_ENTRY_MS - (d === 0 ? 0 : Math.max(0, Date.now() - at)));
      const key = `d${d}`;
      s.exits[key] = {};
      if (!out) {
        s.entries[key] = null;
        return;
      }
      const e: Entry = { t: Date.now(), slot: slotNow + 1, tokens: out.toString(), price: STAKE_SOL / (Number(out) / 10 ** dec) };
      s.entries[key] = e;
      // the fastest copy is also checked at the exit study's extra times; those past the last normal check are
      // taken after the signal is saved (tail), so a restart costs only them
      const extra: number[] = d === 0 ? PATH.filter((x) => x <= EXITS[EXITS.length - 1]) : [];
      await Promise.all([0, ...EXITS, ...extra].map(async (x) => {
        if (x === 0 && d !== 0) return;
        await sleep(Math.max(0, e.t + x * 1000 - Date.now()));
        const back = await quote(buy.mint, SOL, e.tokens);
        if (back !== undefined) (extra.includes(x) ? s.path! : s.exits[key])[`x${x}`] = back === null ? null : Number(back) / 1e9;
      }));
    })]);
    await sleep(Math.max(0, knownMs + 70_000 - Date.now()));
    if (!s.leaderTime) s.leaderTime = (await rpc<number | null>("getBlockTime", [buy.slot]).catch(() => null)) ?? 0;
    const wave = await waveAfter(buy.mint, sig, buy.slot).catch((e) => (health.rpcErrors++, fail(e), null));
    if (wave) {
      s.crowd = crowd(wave, buy.slot, s.entries);
      // What the first followers really paid: up to 5 buys that landed in the wallet's block or the next one.
      const prices: number[] = [];
      for (const f of wave.filter((x) => x.ok && x.slot <= buy.slot + 1).slice(0, 12)) {
        if (prices.length >= 5) break;
        const ftx = await rpc<ParsedTx | null>("getTransaction", [f.sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]).catch(() => null);
        const p = followerPrice(ftx, buy.mint);
        if (p) prices.push(p);
      }
      prices.sort((a, b) => a - b);
      s.near = prices.length ? { n: prices.length, price: prices[(prices.length - 1) >> 1] } : null;
    }
    signals.push(s);
    if (signals.length > KEEP) signals.shift();
    mkdirSync(join(DATA, "solana"), { recursive: true });
    appendFileSync(SIGNALS(), JSON.stringify(s) + "\n");
    void tail(s).catch(fail);
  } catch (e) {
    fail(e);
  } finally {
    health.active--;
    publish();
  }
}

/** The exit study's long checks (3 to 10 min after the entry) on the fastest copy, then the signal is saved again. */
async function tail(s: Signal) {
  const e = s.entries.d0;
  if (!e) return;
  health.tails++;
  try {
    await Promise.all(PATH.filter((x) => x > EXITS[EXITS.length - 1]).map(async (x) => {
      await sleep(Math.max(0, e.t + x * 1000 - Date.now()));
      const back = await quote(s.mint, SOL, e.tokens);
      if (back !== undefined) (s.path ??= {})[`x${x}`] = back === null ? null : Number(back) / 1e9;
    }));
    appendFileSync(SIGNALS(), JSON.stringify(s) + "\n");
    publish();
  } finally {
    health.tails--;
  }
}

// ---- second wave, measured with quotes (paper) ---------------------------------------------------------------------
// Not chasing a wallet: holding a coin several listed wallets are already in when the NEXT one buys it, and selling
// into that buyer's followers. The table secondWave models it from stored checks; this asks for the real quotes.
let waves: WaveTrade[] = [];
/** listed buys of each coin in the last REPEAT_MIN */
const mintBuys = new Map<string, { wallet: string; t: number }[]>();
/** the trade being followed on each coin, and how its follower is told that the next listed buy came */
const waveLive = new Map<string, { row: WaveTrade; came: () => void }>();
const waveJobs = new Set<Promise<void>>();

function waveOnBuy(mint: string, wallet: string, t: number) {
  if (process.env.SOLANA_WAVE === "off") return;
  const list = [...(mintBuys.get(mint) ?? []).filter((x) => t - x.t <= REPEAT_MIN * 60_000), { wallet, t }];
  mintBuys.set(mint, list);
  if (mintBuys.size > 5000) for (const [k, v] of mintBuys) if (t - v[v.length - 1].t > REPEAT_MIN * 60_000) mintBuys.delete(k);
  // this buy is the next listed buyer of the trade followed on the coin: that position is sold into it
  const cur = waveLive.get(mint);
  if (cur && cur.row.nextSec === null && t - cur.row.t <= WAVE_ENDS[WAVE_ENDS.length - 1] * 1000) {
    cur.row.nextSec = (t - cur.row.t) / 1000;
    cur.came();
  }
  waveLive.delete(mint);
  const buyers = new Set(list.map((x) => x.wallet)).size;
  if (buyers < WAVE_MIN_BUYERS) return;
  const row: WaveTrade = { mint, t, buyers, nextSec: null, lots: {} };
  let came = () => {};
  const next = new Promise<void>((res) => (came = res));
  waveLive.set(mint, { row, came });
  health.waveLive++;
  const job: Promise<void> = waveFollow(row, next).catch(fail).then(() => {
    health.waveLive--;
    waveJobs.delete(job);
    if (waveLive.get(mint)?.row === row) waveLive.delete(mint);
  });
  waveJobs.add(job);
}

async function waveFollow(row: WaveTrade, next: Promise<void>) {
  const stake = String(Math.round(WAVE_STAKE_SOL * 1e9));
  const last = WAVE_ENDS[WAVE_ENDS.length - 1];
  /** waits until `sec` after the trigger; false when the next listed buy came before that moment */
  const until = async (sec: number) => {
    const at = row.t + sec * 1000;
    if (row.nextSec === null && Date.now() < at) await Promise.race([sleep(at - Date.now()), next]);
    return row.nextSec === null || row.nextSec >= sec;
  };
  const sell = async (tokens: string) => {
    const back = await quote(row.mint, SOL, tokens);
    return back === undefined ? undefined : back === null ? null : Number(back) / 1e9;
  };
  await Promise.all(WAVE_ENTRIES.map(async (entry) => {
    if (!(await until(entry))) return; // a listed buy came first: the purchase moves behind that buy
    const asked = Date.now();
    const out = await quote(SOL, row.mint, stake);
    if (out === undefined) return; // the buy was not priced in time: nothing to follow
    const lot: WaveLot = { tokens: out === null ? null : out.toString() };
    row.lots[`e${entry}`] = lot;
    if (!out) return;
    const tokens = out.toString();
    await Promise.all([
      (async () => {
        // the same buy a second later: how far the price runs from an order that lands late
        await sleep(Math.max(0, asked + 1000 - Date.now()));
        const again = await quote(SOL, row.mint, stake, false, LATE_ENTRY_MS);
        if (again !== undefined) lot.late = again === null ? null : Number(again) / Number(out);
      })(),
      (async () => {
        for (const end of WAVE_ENDS) {
          if (!(await until(end))) break;
          const back = await sell(tokens);
          if (back !== undefined) lot[`end${end}`] = back;
        }
        if (row.nextSec === null || row.nextSec > last) return;
        const at = row.t + row.nextSec * 1000;
        await sleep(Math.max(0, at + 2000 - Date.now()));
        const at2 = await sell(tokens);
        if (at2 !== undefined) lot.next2 = at2;
        await sleep(Math.max(0, at + 5000 - Date.now()));
        const at5 = await sell(tokens);
        if (at5 !== undefined) lot.next5 = at5;
      })(),
    ]);
  }));
  // written down only when the whole window has passed, whether it was sold early or not: a restart then drops
  // winners and losers alike (the first count of the modelled table kept the early sales and lost the rest)
  await sleep(Math.max(0, row.t + last * 1000 + 6000 - Date.now()));
  if (!Object.keys(row.lots).length) return;
  waves.push(row);
  if (waves.length > WAVE_KEEP) waves.shift();
  mkdirSync(join(DATA, "solana"), { recursive: true });
  appendFileSync(WAVES(), JSON.stringify(row) + "\n");
  health.waveSaved++;
}

// ---- live feed --------------------------------------------------------------------------------------------------
let ws: WebSocket | null = null;
let stopped = false;
/** Transactions being looked at now. Every one queues RPC reads; past this many new ones are dropped, so a very
 *  busy wallet cannot build an endless queue in the process that also runs the Polymarket bot. */
let pending = 0;
const MAX_PENDING = 200;

/** The wallet list of the open connection: the finder's new wallets are added to it without reconnecting. */
let current: Tracked[] = [];

/** Watch newly found wallets on the open stream (one more subscription; no reconnect, no gap in the feed). */
function watchFound() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !helius()) return;
  const have = new Set(current.map((w) => w.address));
  const room = FOUND_MAX - current.filter((w) => w.found && !w.fomo).length;
  const fresh = extra().filter((a) => !have.has(a) && validAddress(a)).slice(0, Math.max(0, room));
  current.push(...fresh.map(foundAs));
  // a fomo trader's dollar accounts become known once the tracer has read the wallet: listen on those too
  for (const f of fomoWallets()) {
    const w = current.find((x) => x.fomo && x.address === f.address);
    if (!w) continue;
    for (const a of f.accounts ?? []) {
      if ((w.accounts ??= []).includes(a)) continue;
      w.accounts.push(a);
      fresh.push(a);
    }
  }
  if (!fresh.length) return;
  health.wallets = current.length;
  health.found = current.filter((w) => w.found && !w.fomo).length;
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "transactionSubscribe", params: [{ accountInclude: fresh, vote: false, failed: false }, { commitment: "processed", encoding: "jsonParsed", transactionDetails: "full", showRewards: false, maxSupportedTransactionVersion: 1 }] }));
}

/** Slow-study wallets on the open stream (slow.ts): one more subscription for the ones not carried yet. */
let slowCarried = new Set<string>();
function watchSlow() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !helius()) return;
  const fresh = slowWatch().filter((a) => !slowCarried.has(a) && validAddress(a));
  if (!fresh.length) return;
  for (const a of fresh) slowCarried.add(a);
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "transactionSubscribe", params: [{ accountInclude: fresh, vote: false, failed: false }, { commitment: "confirmed", encoding: "jsonParsed", transactionDetails: "full", showRewards: false, maxSupportedTransactionVersion: 1 }] }));
}

function connect() {
  if (stopped) return;
  slowCarried = new Set();
  const list = tracked();
  current = list;
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
    // Fast path (Helius only): one subscription that pushes the whole transaction as soon as it is processed, so we
    // know the token without a second request. If the plan or the endpoint refuses it, the reply is an error, the
    // stream stays off and the signature feed below carries on as before.
    if (helius()) sock.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "transactionSubscribe", params: [{ accountInclude: feedOf(list), vote: false, failed: false }, { commitment: "processed", encoding: "jsonParsed", transactionDetails: "full", showRewards: false, maxSupportedTransactionVersion: 1 }] }));
    // The signature feed is kept only as the comparison (and as the fallback when there is no key): with a key the
    // stream above carries every wallet, so only the first LOGS_MAX get the slower per-wallet subscription too.
    (helius() ? list.slice(0, LOGS_MAX) : list).forEach((w, i) => {
      reqOf.set(100 + i, w);
      sock.send(JSON.stringify({ jsonrpc: "2.0", id: 100 + i, method: "logsSubscribe", params: [{ mentions: [w.address] }, { commitment: "processed" }] }));
    });
    watchSlow();
  };
  sock.onmessage = (ev) => {
    const now = Date.now();
    let m: { id?: number; result?: number; error?: { message: string }; method?: string; params?: { subscription: number; result: { slot?: number; value?: { signature: string; err: unknown } } } };
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (m.id === 5) {
      if (m.error) fail(new Error(`slow subscribe: ${m.error.message}`));
      return;
    }
    if (m.id === 3) {
      health.stream = m.error ? `refused: ${scrub(m.error.message)}` : "on";
      return;
    }
    if (m.method === "transactionNotification") {
      const r = (m.params?.result ?? {}) as unknown as { signature?: string; slot?: number; transaction?: { transaction?: ParsedTx["transaction"]; meta?: ParsedTx["meta"] } };
      const t = r.transaction;
      if (!r.signature || !r.slot || !t?.meta || t.meta.err || Array.isArray(t.transaction) || !t.transaction?.message) return;
      health.streamTx++;
      const tx: ParsedTx = { slot: r.slot, blockTime: null, meta: t.meta, transaction: t.transaction };
      try {
        slowTx(tx, now);
      } catch (e) {
        fail(e);
      }
      const keys = new Set(tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey)));
      // for the early-stream measurement: a transaction a listed trader signed (the first key pays and signs)
      const payer = keys.values().next().value;
      if (payer && list.some((x) => x.address === payer && !x.found && !x.fomo)) preconfSeen(r.signature, now);
      const w = list.find((x) => (x.fomo || keys.has(x.address)) && buyOf(tx, x));
      if (!w) {
        if (seen.size > 20_000) seen.clear(); // same bound as in onTx, which these never reach
        seen.add(r.signature); // not a buy by a tracked wallet: nothing to look up when the signature feed repeats it
        return;
      }
      if (pending >= MAX_PENDING) health.skippedBusy++;
      else {
        pending++;
        void onTx(w, r.signature, now, tx).catch(fail).finally(() => pending--);
      }
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

/**
 * How far this server is from Helius's transaction-sending hubs: fastest of 3 plain pings each (no key, nothing
 * is sent). Tells us whether Stockholm is close enough, or which city a trading server should sit in.
 */
async function pingSenders() {
  for (const city of ["fra", "ams", "lon"]) {
    let best: number | null = null;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      try {
        const res = await net(`http://${city}-sender.helius-rpc.com/ping`, { signal: AbortSignal.timeout(3000) });
        await res.text();
        const ms = performance.now() - t;
        if (res.ok && (best === null || ms < best)) best = ms;
      } catch {
        /* unreachable this time */
      }
    }
    health.senderPingMs[city] = best === null ? null : Math.round(best);
  }
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
  // the wallet finder (read-only): its own connection, its own data cap; SOLANA_DISCOVER=off disables
  startDiscover(() => (helius() ? wsUrl() : null), () => listed().map((w) => w.address));
  // the wallet history study (read-only): past buys of each listed wallet; SOLANA_HISTORY=off disables
  startHistory({ rpcUrl: () => (helius() ? rpcUrl() : null), fetch: () => net, wallets: () => listed() });
  // slow wallets (read-only screen, then a paper copy of the ones that pass); SOLANA_SLOW=off disables. A slow copy
  // waits seconds to minutes anyway, so its quotes may wait their turn up to two minutes.
  startSlow({ rpcUrl: () => (helius() ? rpcUrl() : null), fetch: () => net, listed: () => listed(), busy: (k) => busyWallets(k), quote: (a, b, amount) => quote(a, b, amount, false, 120_000), jup: (path) => jupList(path) });
  // the tracer (read-only): the wallets behind the fomo traders in seeds.ts; SOLANA_LINKS=off disables
  startLinks({ rpcUrl: () => (helius() ? rpcUrl() : null), fetch: () => net });
  // the early-stream measurement (read-only, one short run with a credit budget); SOLANA_PRECONF=off disables
  startPreconf({ url: () => (helius() ? `wss://beta.helius-rpc.com/?api-key=${helius()}` : null), signers: () => listed().map((w) => w.address) });
  // the dip rule on paper (read-only: hourly SOL candles and two quotes a trade); SOLANA_DIP=off disables
  startDip({ fetch: () => net, quote: (a, b, amount) => quote(a, b, amount) });
  // the whole-market dip rules on paper (read-only: 8 hourly candle requests, a few quotes a trade); SOLANA_MKTDIP=off disables
  startMktDip({ fetch: () => net, quote: (a, b, amount) => quote(a, b, amount) });
  // price history for the slow-trade research (read-only, public market data, runs once); SOLANA_CANDLES=off disables
  setTimeout(() => void startCandles(), 120_000).unref();
  void refreshSolUsd();
  void pingSenders();
  let n = 0;
  let hadKey = !!helius();
  return setInterval(() => {
    publish();
    if (++n % 10 === 0) {
      void refreshSolUsd();
      void pingSenders();
    }
    if (!hadKey && helius()) {
      hadKey = true; // the key file arrived: move to the faster feed without a restart
      ws?.close();
    }
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "getSlot" }));
    watchFound();
    watchSlow();
  }, 30_000);
}

export function stopSolanaCopy() {
  stopped = true;
  ws?.close();
  stopDiscover();
  stopHistory();
  stopSlow();
  stopLinks();
  stopPreconf();
  stopDip();
  stopMktDip();
}

/** Test hooks. */
export const _test = { quote, health: () => health, onTx, setNet: (f: Fetch) => (net = f), setSlot: (n: number) => (slotNow = n), setSolUsd: (v: number | null) => (solUsd = v), signals: () => signals, load: () => load(), lane: () => lane, waveOnBuy, waves: () => waves, waveIdle: () => Promise.all([...waveJobs]) };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`solana copy test: ${WALLETS.length} wallets, helius key ${helius() ? "yes" : "no"}, jupiter key ${jupiter() ? "yes" : "no"}`);
  startSolanaCopy();
  setInterval(() => console.log(new Date().toISOString(), JSON.stringify({ ...health, signals: signals.length })), 60_000);
}
