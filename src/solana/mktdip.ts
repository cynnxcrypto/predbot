/**
 * PAPER ONLY: buying after the WHOLE market falls. Nothing is sent, no wallet is touched. SOLANA_MKTDIP=off disables.
 *
 * Where it comes from (12 Nov 2026, enrique: "we need more trading ideas or approaches"). The research thread wrote
 * down 51 slow rules before seeing results (research/slow-ideas.py on branch claude/project-thread-xtlekd; report
 * reviews/slow-crypto-ideas-2026-11-12.md). 10 passed 2021-24, 6 of them passed the untouched 2025-26. One idea
 * held: a coin bounces after the whole market fell, not after it fell alone. History, 51 rules tried, not proof.
 *
 *   both-dip         SOL or ETH 10% down in 24 h AND BTC 5% down in 24 h; sold 24 h later. 172 trades, +2.3%.
 *   mkt-dip-7        BTC 7% down in 24 h: buys SOL and ETH; sold 24 h later. 194 trades, +2.9%.
 *   mkt-dip-7-small  the same signal, buys JUP, BONK, WIF, JTO, PYTH (a separate leg: small coins failed alone).
 *   dip-scaled       BTC 6%, ETH 8%, SOL 10% down in 24 h: buys that coin; sold when a close is the same size up,
 *                    or 24 h later. 445 trades, +0.95%.
 *
 * Like dip.ts: Binance's public hourly closes decide (read once an hour, 8 small requests), and every purchase and
 * sale is priced with a real quote for a $100 swap on Solana through the paper quote line. BTC and ETH are bought
 * as their wrapped tokens on Solana. Each trade is also priced as if bought an hour late (the bar asks for that).
 * Bar: 30+ trades on 15+ separate days, average above +1% at real quotes, still positive an hour late.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../config.js";
import { closedCandles } from "./dip.js";
import { SOL, USDC } from "./pools.js";

/** coin -> its token on Solana (BTC and ETH are the wrapped tokens) */
export const MKT_MINTS: Record<string, string> = {
  SOL,
  BTC: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
  ETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  PYTH: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
};
export const MKT_COINS = Object.keys(MKT_MINTS);
export const MKT_STAKE_USD = 100;
export const MKT_TX_USD = 0.01;
export const MKT_HOLD_HOURS = 24;

/** 24 h change of each coin at the last close, as a fraction; a coin without its candles is missing */
export type Changes = Record<string, number | undefined>;
export interface MktLeg {
  rule: string;
  coin: string;
  text: string;
  buys: (ch: Changes) => boolean;
  /** sold early when a close is this far above the close it bought on (percent); none = time only */
  targetPct?: number;
}
const down = (ch: Changes, coin: string, pct: number) => ch[coin] !== undefined && ch[coin]! <= -pct / 100;
export const MKT_LEGS: MktLeg[] = [
  ...["SOL", "ETH"].map((coin) => ({ rule: "both-dip", coin, text: "SOL or ETH 10% or more down in 24 hours while BTC is 5% or more down: buys that coin, sells 24 hours later.", buys: (ch: Changes) => down(ch, coin, 10) && down(ch, "BTC", 5) })),
  ...["SOL", "ETH"].map((coin) => ({ rule: "mkt-dip-7", coin, text: "BTC 7% or more down in 24 hours: buys SOL and ETH, sells 24 hours later.", buys: (ch: Changes) => down(ch, "BTC", 7) })),
  ...["JUP", "BONK", "WIF", "JTO", "PYTH"].map((coin) => ({ rule: "mkt-dip-7-small", coin, text: "BTC 7% or more down in 24 hours: buys JUP, BONK, WIF, JTO and PYTH, sells 24 hours later.", buys: (ch: Changes) => down(ch, "BTC", 7) })),
  ...([["BTC", 6], ["ETH", 8], ["SOL", 10]] as [string, number][]).map(([coin, pct]) => ({ rule: "dip-scaled", coin, text: "BTC 6%, ETH 8% or SOL 10% down in 24 hours: buys that coin, sells when a close is the same size up, or 24 hours later.", buys: (ch: Changes) => down(ch, coin, pct), targetPct: pct })),
];

export interface MktOpen {
  rule: string;
  coin: string;
  signalHour: number;
  refPrice: number;
  at: number;
  /** token units the $100 swap was quoted */
  amount: string;
  /** the same purchase quoted an hour later: units, null when no quote came; absent until that hour */
  late?: string | null;
}
export interface MktTrade {
  rule: string;
  coin: string;
  signalHour: number;
  at: number;
  exitHour: number;
  exitAt: number;
  why: "target" | "time";
  netUsd: number;
  /** the same trade bought an hour late; null when it could not be priced */
  lateNetUsd: number | null;
  /** close to close, less 0.10% a side: how the history test counts it */
  testPct: number;
  late?: boolean;
}
export interface MktState {
  lastHour: number;
  open: MktOpen[];
  trades: MktTrade[];
  missedEntries: number;
  /** did the price service quote each coin's token once (checked once, so a wrong token shows at the start) */
  check: Record<string, boolean> | null;
  last: { hour: number; changes: Record<string, number | null> } | null;
  error: string;
}

const r = (x: number | null, n = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
const FILE = () => join(DATA, "solana", "mktdip-state.json");
const fresh = (): MktState => ({ lastHour: 0, open: [], trades: [], missedEntries: 0, check: null, last: null, error: "" });
let state: MktState = fresh();
let loaded = false;
function load() {
  loaded = true;
  try {
    state = { ...fresh(), ...(JSON.parse(readFileSync(FILE(), "utf8")) as MktState) };
  } catch {
    state = fresh();
  }
}
function save() {
  mkdirSync(join(DATA, "solana"), { recursive: true });
  writeFileSync(FILE() + ".tmp", JSON.stringify(state));
  renameSync(FILE() + ".tmp", FILE());
}

type Quote = (inMint: string, outMint: string, amount: string) => Promise<bigint | null | undefined>;
export interface MktDeps {
  fetch: () => typeof fetch;
  quote: Quote;
  retryMs?: number;
}
async function ask(q: Quote, inMint: string, outMint: string, amount: string, pause: number): Promise<bigint | null> {
  for (let i = 0; i < 3; i++) {
    const out = await q(inMint, outMint, amount).catch(() => undefined);
    if (out) return out;
    if (i < 2 && pause > 0) await new Promise((res) => setTimeout(res, pause));
  }
  return null;
}

/** when does an open trade sell at this close? */
export function mktExit(leg: MktLeg | undefined, open: { signalHour: number; refPrice: number }, hour: number, close: number | undefined): "target" | "time" | null {
  if (leg?.targetPct !== undefined && close !== undefined && close >= open.refPrice * (1 + leg.targetPct / 100)) return "target";
  return hour - open.signalHour >= MKT_HOLD_HOURS ? "time" : null;
}

let busy = false;
export async function mktTick(deps: MktDeps, now = Date.now()): Promise<void> {
  if (busy) return;
  if (!loaded) load();
  const lastClosed = Math.floor(now / 3_600_000) - 1;
  const pending = state.open.some((o) => lastClosed - o.signalHour >= MKT_HOLD_HOURS);
  if ((lastClosed <= state.lastHour && !pending && state.check) || now % 3_600_000 < 15_000) return;
  busy = true;
  const pause = deps.retryMs ?? 5000;
  const buy = () => String(MKT_STAKE_USD * 1e6);
  try {
    if (!state.check) {
      const check: Record<string, boolean> = {};
      for (const coin of MKT_COINS) check[coin] = (await ask(deps.quote, USDC, MKT_MINTS[coin], buy(), pause)) !== null;
      state.check = check;
      save();
    }
    // closes of every coin at the last closed hour; BTC, ETH and SOL are needed, a small coin may be missing
    const close: Record<string, number | undefined> = {};
    const ch: Changes = {};
    for (const coin of MKT_COINS) {
      try {
        const res = await deps.fetch()(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=1h&limit=30`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`candles http ${res.status}`);
        const { t, c } = closedCandles(await res.json(), now);
        const i = t.length - 1;
        if (i < 24 || t[i] !== lastClosed || t[i - 24] !== lastClosed - 24) throw new Error("the last hour's candle is not out yet");
        close[coin] = c[i];
        ch[coin] = c[i] / c[i - 24] - 1;
      } catch (e) {
        if (coin === "BTC" || coin === "ETH" || coin === "SOL") throw e;
      }
    }
    const hour = lastClosed;
    const newHour = hour > state.lastHour;
    const soldNow = new Set<string>();
    for (const o of [...state.open]) {
      const leg = MKT_LEGS.find((x) => x.rule === o.rule && x.coin === o.coin);
      const why = mktExit(leg, o, hour, close[o.coin]);
      if (!why) continue;
      const back = await ask(deps.quote, MKT_MINTS[o.coin], USDC, o.amount, pause);
      if (back === null) continue; // no quote: stays open, tried again at the next look, marked late
      const lateBack = o.late ? await ask(deps.quote, MKT_MINTS[o.coin], USDC, o.late, pause) : null;
      const net = (b: bigint) => r(Number(b) / 1e6 - MKT_STAKE_USD - 2 * MKT_TX_USD, 4)!;
      const late = !newHour || (why === "time" && hour - o.signalHour > MKT_HOLD_HOURS);
      state.trades.push({
        rule: o.rule, coin: o.coin, signalHour: o.signalHour, at: o.at, exitHour: hour, exitAt: now, why, netUsd: net(back), lateNetUsd: lateBack === null ? null : net(lateBack),
        testPct: close[o.coin] === undefined ? 0 : r(((close[o.coin]! / o.refPrice) * 0.999 ** 2 - 1) * 100)!, ...(late ? { late: true } : {}),
      });
      state.open = state.open.filter((x) => x !== o);
      soldNow.add(`${o.rule}:${o.coin}`);
    }
    if (newHour) {
      // the same purchase an hour late, for trades bought at the close before this one
      for (const o of state.open) {
        if (o.late !== undefined || hour <= o.signalHour) continue;
        o.late = hour === o.signalHour + 1 ? ((await ask(deps.quote, USDC, MKT_MINTS[o.coin], buy(), pause))?.toString() ?? null) : null;
      }
      for (const leg of MKT_LEGS) {
        const key = `${leg.rule}:${leg.coin}`;
        if (soldNow.has(key) || close[leg.coin] === undefined || state.open.some((o) => o.rule === leg.rule && o.coin === leg.coin) || !leg.buys(ch)) continue;
        const out = await ask(deps.quote, USDC, MKT_MINTS[leg.coin], buy(), pause);
        if (out === null) {
          state.missedEntries++;
          continue;
        }
        state.open.push({ rule: leg.rule, coin: leg.coin, signalHour: hour, refPrice: close[leg.coin]!, at: now, amount: out.toString() });
      }
      state.last = { hour, changes: Object.fromEntries(MKT_COINS.map((coin) => [coin, ch[coin] === undefined ? null : r(ch[coin]! * 100)])) };
      state.lastHour = hour;
    }
    if (state.trades.length > 2000) state.trades = state.trades.slice(-2000);
    state.error = "";
    save();
  } catch (e) {
    state.error = /candles http \d+|not out yet/.test(String((e as Error)?.message)) ? String((e as Error).message) : "the look failed (network or price service)";
  } finally {
    busy = false;
  }
}

export function mktSummary() {
  if (!loaded) load();
  const rules = [...new Set(MKT_LEGS.map((x) => x.rule))];
  const avg = (xs: number[]) => (xs.length ? r(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {
    mode: "paper",
    note: `Paper only, nothing is sent. Rules found on hourly prices 2021-26 (51 tried; history, not proof), followed live: each trade is priced with a real quote for a $${MKT_STAKE_USD} swap on Solana when the rule buys and sells (BTC and ETH as their wrapped tokens). lateAvgPct = the same trades bought an hour late. days = separate days with a trade. Bar: 30+ trades on 15+ days, average above +1%, still positive an hour late. These signals come a few times a year, so months are needed.`,
    lastLook: state.last && { hourEndsAt: (state.last.hour + 1) * 3_600_000, change24hPct: state.last.changes },
    tokenQuoted: state.check,
    missedEntries: state.missedEntries,
    error: state.error,
    rules: rules.map((id) => {
      const done = state.trades.filter((tr) => tr.rule === id);
      const lateDone = done.filter((tr) => tr.lateNetUsd !== null);
      return {
        id, text: MKT_LEGS.find((x) => x.rule === id)!.text, coins: MKT_LEGS.filter((x) => x.rule === id).map((x) => x.coin),
        trades: done.length, days: new Set(done.map((tr) => Math.floor(tr.signalHour / 24))).size, won: done.filter((tr) => tr.netUsd > 0).length,
        netUsd: r(done.reduce((a, tr) => a + tr.netUsd, 0)), avgPct: avg(done.map((tr) => (tr.netUsd / MKT_STAKE_USD) * 100)),
        lateAvgPct: avg(lateDone.map((tr) => (tr.lateNetUsd! / MKT_STAKE_USD) * 100)), avgTestPct: avg(done.map((tr) => tr.testPct)),
        open: state.open.filter((o) => o.rule === id).map((o) => ({ coin: o.coin, boughtAt: o.at, heldHours: state.last ? state.last.hour - o.signalHour : 0 })),
      };
    }),
    recent: state.trades.slice(-12).reverse().map((tr) => ({ rule: tr.rule, coin: tr.coin, boughtAt: tr.at, soldAt: tr.exitAt, why: tr.why, pct: r((tr.netUsd / MKT_STAKE_USD) * 100), latePct: tr.lateNetUsd === null ? null : r((tr.lateNetUsd / MKT_STAKE_USD) * 100), testPct: tr.testPct })),
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startMktDip(deps: MktDeps) {
  if (process.env.SOLANA_MKTDIP === "off" || timer) return;
  timer = setInterval(() => void mktTick(deps), 60_000);
  timer.unref();
  void mktTick(deps);
}
export function stopMktDip() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test hooks. */
export const _mktTest = { reset: () => ((state = fresh()), (loaded = true)), state: () => state };
