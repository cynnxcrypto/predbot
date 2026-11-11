/**
 * PAPER / READ-ONLY: the wallet finder. enrique, 11 Nov 2026: "we need to identify which wallets get immediate
 * buying support after they buy something", and "no way you can find easily addresses of wallets that trade well?".
 *
 * Public leaderboards are what every copy bot watches. This finds wallets from the chain itself: it listens to the
 * swaps of the busiest memecoin programs on a second Helius stream and, for every sizeable buy, looks at what
 * happened in the seconds after it:
 *   - how many OTHER wallets bought the same token in the next ~3 s, against how many were buying just before;
 *   - what somebody who bought right behind it (next 1-2 slots) could have sold for 4-6 s later.
 * A wallet becomes a candidate when that keeps happening: enough buys, a wave after at least half of them, and a
 * positive typical move. Candidates are then watched by the copy test like the listed wallets (paper only: the
 * real-money test never acts on a found wallet).
 *
 * Nothing is sent, no wallet of ours is involved. Prices come from balance changes, so they include the trader's
 * fees and tips: buys look a little dearer and sells a little cheaper than the pool price, which makes the
 * measured move slightly pessimistic.
 *
 * Cost: the stream is metered by data. It stops for the rest of the hour at MB_HOUR. SOLANA_DISCOVER=off disables.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../config.js";
import { USDT } from "./copy.js";
import { SOL, USDC } from "./pools.js";

/** pump.fun (bonding curve) and PumpSwap (its AMM): where most new-token trading happens. */
export const PROGRAMS = ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"];

export const LEAD_SOL = 0.5; // a buy this big or bigger is looked at as a possible lead
const PRICE_SOL = 0.1; // smaller swaps are too noisy (fees, rent) to read a price from
const BEFORE = 10; // slots before the lead: who was already buying
const AFTER = 8; // slots after the lead (~3 s): who piled in
const ENTRY: [number, number] = [1, 2]; // where a fast copier could have bought
const EXIT: [number, number] = [10, 15]; // where it would sell (~4-6 s after the lead)
const KEEP_SLOTS = 45;
export const MIN_LEADS = 6;
export const MIN_WAVE_SHARE = 0.5;
export const MIN_MOVE_PCT = 3;
const MOVES_KEPT = 40;
const MAX_WALLETS = 30_000;

interface TokBal {
  mint: string;
  owner?: string;
  uiTokenAmount: { uiAmountString?: string; uiAmount?: number | null };
}
export interface Meta {
  err: unknown;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: TokBal[];
  postTokenBalances?: TokBal[];
}
export interface Swap {
  slot: number;
  wallet: string;
  mint: string;
  buy: boolean;
  sol: number;
  price: number;
}
const ui = (b: TokBal) => Number(b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount ?? 0) || 0;

/**
 * The fee payer's swap between SOL and exactly one token, read from the balance changes. `signer` is the fee
 * payer's address when the stream gives it; without it, the trader is taken to be the owner whose token balance
 * moved the right way.
 */
export function swapOf(meta: Meta | null | undefined, signer: string | null, slot: number): Swap | null {
  if (!meta || meta.err || !meta.preBalances?.length || !meta.postBalances?.length) return null;
  const by = new Map<string, Map<string, number>>(); // mint -> owner -> change
  let wsol = 0;
  const add = (b: TokBal, sign: number) => {
    if (!b.owner) return;
    if (b.mint === SOL) {
      if (b.owner === signer) wsol += sign * ui(b);
      return;
    }
    if (b.mint === USDC || b.mint === USDT) return;
    let m = by.get(b.mint);
    if (!m) by.set(b.mint, (m = new Map()));
    m.set(b.owner, (m.get(b.owner) ?? 0) + sign * ui(b));
  };
  for (const b of meta.postTokenBalances ?? []) add(b, 1);
  for (const b of meta.preTokenBalances ?? []) add(b, -1);
  const moved = [...by].filter(([, owners]) => [...owners.values()].some((d) => d !== 0));
  if (moved.length !== 1) return null; // no token, or token-to-token
  const [mint, owners] = moved[0];
  const sol = (meta.postBalances[0] - meta.preBalances[0] + meta.fee) / 1e9 + wsol;
  if (Math.abs(sol) < 0.01) return null;
  const buy = sol < 0;
  let wallet = signer;
  let tokens = signer ? (owners.get(signer) ?? 0) : 0;
  if (!signer) {
    for (const [o, d] of owners) if (buy ? d > tokens : d < tokens) [wallet, tokens] = [o, d];
  }
  if (!wallet || (buy ? tokens <= 0 : tokens >= 0)) return null;
  return { slot, wallet, mint, buy, sol: Math.abs(sol), price: Math.abs(sol) / Math.abs(tokens) };
}

export interface Stat {
  /** buys looked at */
  n: number;
  /** of those, how many were followed by a wave of other buyers */
  waves: number;
  /** % move a fast copier would have seen, latest last */
  moves: number[];
  after: number;
  before: number;
  sol: number;
  last: number;
}
interface Lead {
  wallet: string;
  mint: string;
  slot: number;
  price: number;
  sol: number;
}
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r1 = (x: number) => Math.round(x * 10) / 10;

export interface Candidate {
  wallet: string;
  buys: number;
  waves: number;
  wavePct: number;
  medianMovePct: number;
  /** other buyers in the ~3 s after / in the ~4 s before, on average */
  avgAfter: number;
  avgBefore: number;
  avgSol: number;
}

export class Finder {
  private mints = new Map<string, Swap[]>();
  private leads: Lead[] = [];
  private lastLead = new Map<string, number>();
  wallets = new Map<string, Stat>();
  slot = 0;
  swaps = 0;
  scored = 0;

  add(s: Swap, now = Date.now()) {
    if (s.slot > this.slot) this.slot = s.slot;
    this.swaps++;
    let list = this.mints.get(s.mint);
    if (!list) this.mints.set(s.mint, (list = []));
    list.push(s);
    if (s.buy && s.sol >= LEAD_SOL) {
      const k = `${s.wallet}|${s.mint}`;
      // one lead per wallet and token every ~60 s: a wallet buying in pieces is one decision, not five
      if (s.slot - (this.lastLead.get(k) ?? -1e9) > 150) {
        this.lastLead.set(k, s.slot);
        this.leads.push({ wallet: s.wallet, mint: s.mint, slot: s.slot, price: s.price, sol: s.sol });
      }
    }
    this.score(now);
  }

  /** Score the leads whose exit window has passed. */
  score(now = Date.now()) {
    while (this.leads.length && this.leads[0].slot + EXIT[1] < this.slot) {
      const l = this.leads.shift()!;
      const all = this.mints.get(l.mint) ?? [];
      const buyers = (from: number, to: number) => new Set(all.filter((x) => x.buy && x.wallet !== l.wallet && x.slot >= l.slot + from && x.slot <= l.slot + to).map((x) => x.wallet)).size;
      const prices = (from: number, to: number) => all.filter((x) => x.sol >= PRICE_SOL && x.wallet !== l.wallet && x.slot >= l.slot + from && x.slot <= l.slot + to).map((x) => x.price);
      const before = buyers(-BEFORE, -1);
      const after = buyers(1, AFTER);
      const entry = median(prices(ENTRY[0], ENTRY[1])) ?? l.price;
      const exit = median(prices(EXIT[0], EXIT[1])) ?? prices(ENTRY[1] + 1, EXIT[1]).at(-1) ?? null;
      // nobody traded after it: nothing to sell into, the round trip would only cost
      const move = exit === null ? 0 : Math.max(-100, Math.min(300, (exit / entry - 1) * 100));
      let st = this.wallets.get(l.wallet);
      if (!st) this.wallets.set(l.wallet, (st = { n: 0, waves: 0, moves: [], after: 0, before: 0, sol: 0, last: 0 }));
      st.n++;
      if (after >= 3 && after >= 2 * before + 1) st.waves++;
      st.moves.push(r1(move));
      if (st.moves.length > MOVES_KEPT) st.moves.shift();
      st.after += after;
      st.before += before;
      st.sol += l.sol;
      st.last = now;
      this.scored++;
    }
  }

  /** Forget old swaps and, when the table is full, the wallets seen least. */
  prune(now = Date.now()) {
    for (const [m, list] of this.mints) {
      const keep = list.filter((x) => x.slot >= this.slot - KEEP_SLOTS);
      if (keep.length) this.mints.set(m, keep);
      else this.mints.delete(m);
    }
    for (const [k, s] of this.lastLead) if (s < this.slot - 300) this.lastLead.delete(k);
    if (this.wallets.size > MAX_WALLETS) {
      for (const [w, st] of this.wallets) if (st.n <= 2 && now - st.last > 3_600_000) this.wallets.delete(w);
      if (this.wallets.size > MAX_WALLETS) {
        const byN = [...this.wallets].sort((a, b) => b[1].n - a[1].n).slice(0, MAX_WALLETS / 2);
        this.wallets = new Map(byN);
      }
    }
  }

  /** Wallets whose buys keep being followed by a wave and a rise, best first. */
  candidates(exclude: Set<string> = new Set(), max = 100): Candidate[] {
    const out: Candidate[] = [];
    for (const [wallet, st] of this.wallets) {
      if (st.n < MIN_LEADS || exclude.has(wallet)) continue;
      const mv = median(st.moves) ?? 0;
      if (st.waves / st.n < MIN_WAVE_SHARE || mv < MIN_MOVE_PCT) continue;
      out.push({ wallet, buys: st.n, waves: st.waves, wavePct: Math.round((st.waves / st.n) * 100), medianMovePct: r1(mv), avgAfter: r1(st.after / st.n), avgBefore: r1(st.before / st.n), avgSol: r1(st.sol / st.n) });
    }
    return out.sort((a, b) => b.waves - a.waves || b.medianMovePct - a.medianMovePct).slice(0, max);
  }

  dump(max = 5000): [string, Stat][] {
    return [...this.wallets].filter(([, st]) => st.n >= 2).sort((a, b) => b[1].n - a[1].n).slice(0, max);
  }
  restore(rows: [string, Stat][]) {
    for (const [w, st] of rows) if (typeof w === "string" && st && typeof st.n === "number" && Array.isArray(st.moves)) this.wallets.set(w, st);
  }
}

// ---- runner -----------------------------------------------------------------------------------------------------
const FILE = () => join(DATA, "solana", "found-wallets.json");
const MB_HOUR = Math.max(1, Number(process.env.SOLANA_DISCOVER_MB_HOUR) || 300);
/** Helius meters its stream at about 2 credits per 0.1 MB. */
const CREDITS_PER_MB = 20;
const finder = new Finder();
const health = { state: "off", detail: "accounts", wsUp: false, hour: -1, mbHour: 0, mbTotal: 0, txSeen: 0, startedAt: 0, lastError: "" };
let sock: WebSocket | null = null;
let stopped = true;
let wsUrl: () => string | null = () => null;
let timer: ReturnType<typeof setInterval> | null = null;
let picked: Candidate[] = [];
let exclude = new Set<string>();

function save() {
  try {
    mkdirSync(join(DATA, "solana"), { recursive: true });
    writeFileSync(FILE() + ".tmp", JSON.stringify({ savedAt: Date.now(), wallets: finder.dump() }));
    renameSync(FILE() + ".tmp", FILE());
  } catch {
    /* next time */
  }
}

function hourNow() {
  const h = Math.floor(Date.now() / 3_600_000);
  if (h !== health.hour) {
    health.hour = h;
    health.mbHour = 0;
  }
}

function connect() {
  const url = wsUrl();
  if (stopped || !url || sock) return;
  hourNow();
  if (health.mbHour >= MB_HOUR) return void (health.state = "resting until the next hour (data cap)");
  let s: WebSocket;
  try {
    s = new WebSocket(url);
  } catch {
    return;
  }
  sock = s;
  s.onopen = () => {
    health.wsUp = true;
    s.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "transactionSubscribe", params: [{ accountInclude: PROGRAMS, vote: false, failed: false }, { commitment: "processed", encoding: "jsonParsed", transactionDetails: health.detail, showRewards: false, maxSupportedTransactionVersion: 1 }] }));
  };
  s.onmessage = (ev) => {
    const text = String(ev.data);
    health.mbHour += text.length / 1e6;
    health.mbTotal += text.length / 1e6;
    if (health.mbHour >= MB_HOUR) {
      health.state = "resting until the next hour (data cap)";
      s.close();
      return;
    }
    let m: { id?: number; error?: { message: string }; method?: string; params?: { result?: { slot?: number; transaction?: { transaction?: unknown; meta?: Meta } } } };
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.id === 1) {
      if (!m.error) health.state = "on";
      else if (health.detail === "accounts") {
        health.detail = "full"; // this plan or endpoint wants whole transactions: heavier, same information
        s.close();
      } else {
        health.state = "refused";
        health.lastError = m.error.message.replace(/api-key=[^&\s"]+/g, "api-key=***").slice(0, 120);
      }
      return;
    }
    if (m.method !== "transactionNotification") return;
    const r = m.params?.result;
    const t = r?.transaction;
    if (!r?.slot || !t?.meta) return;
    health.txSeen++;
    const inner = t.transaction as { accountKeys?: unknown[]; message?: { accountKeys?: unknown[] } } | unknown[] | undefined;
    const keys = Array.isArray(inner) ? undefined : (inner?.accountKeys ?? inner?.message?.accountKeys);
    const k0 = keys?.[0] as string | { pubkey?: string } | undefined;
    const signer = typeof k0 === "string" ? k0 : (k0?.pubkey ?? null);
    const sw = swapOf(t.meta, signer, r.slot);
    if (sw) finder.add(sw);
  };
  s.onerror = () => undefined;
  s.onclose = () => {
    health.wsUp = false;
    if (sock === s) sock = null;
    if (!stopped && health.state !== "refused") setTimeout(connect, 5000);
  };
}

/** Start the finder. `url` gives the Helius websocket address, or null while there is no key. */
export function startDiscover(url: () => string | null, tracked: () => string[] = () => []) {
  if (process.env.SOLANA_DISCOVER === "off" || typeof WebSocket === "undefined" || !stopped) return;
  stopped = false;
  wsUrl = url;
  health.startedAt = Date.now();
  health.state = "starting";
  try {
    finder.restore((JSON.parse(readFileSync(FILE(), "utf8")) as { wallets: [string, Stat][] }).wallets);
  } catch {
    /* nothing saved yet */
  }
  connect();
  let n = 0;
  timer = setInterval(() => {
    n++;
    finder.score();
    finder.prune();
    exclude = new Set(tracked());
    picked = finder.candidates(exclude);
    if (n % 4 === 0) save();
    // accepted, data arrives, but nothing readable in it: ask for whole transactions instead
    if (health.detail === "accounts" && health.txSeen === 0 && health.mbTotal > 2) {
      health.detail = "full";
      sock?.close();
    }
    if (!sock) connect(); // also the way back after the hourly data cap
  }, 30_000);
  timer.unref?.();
}
export function stopDiscover() {
  if (stopped) return;
  stopped = true;
  if (timer) clearInterval(timer);
  sock?.close();
  save();
}

/** Found wallets for the copy test to watch as well (addresses only, best first). */
export const foundWallets = (): string[] => picked.map((c) => c.wallet);

export function discoverSummary() {
  return {
    note: `Looks at every pump.fun / PumpSwap buy of ${LEAD_SOL}+ SOL: did other wallets pile in within ~3 s, and could a fast copier have sold higher 4-6 s later. A candidate needs ${MIN_LEADS}+ such buys, a wave after half or more, and a typical move of +${MIN_MOVE_PCT}% or better. Read-only. Prices include the traders' fees, so moves are slightly pessimistic. A candidate is a lead to test, not proof.`,
    state: health.state,
    detail: health.detail,
    wsUp: health.wsUp,
    mbThisHour: Math.round(health.mbHour),
    mbCapPerHour: MB_HOUR,
    mbSinceStart: Math.round(health.mbTotal),
    creditsSinceStart: Math.round(health.mbTotal * CREDITS_PER_MB),
    txSeen: health.txSeen,
    swaps: finder.swaps,
    buysScored: finder.scored,
    walletsSeen: finder.wallets.size,
    candidates: picked.length,
    top: picked.slice(0, 20),
    lastError: health.lastError,
  };
}

/** Test hooks. */
export const _test = { finder };
