/**
 * PAPER ONLY: buying SOL after a sharp fall. Nothing is sent, no wallet is touched. SOLANA_DIP=off disables.
 *
 * Where it comes from (12 Nov 2026, enrique: "u cant find a way to trade this well?"). Copying wallets has no edge
 * at our speed, so 41 slow rules, written down before the prices were seen, were run over 5.7 years of hourly SOL
 * prices (research/sol-slow-rules.py). Trend and momentum rules all failed. One family held up, in both halves of
 * the history, in the last 12 months, and on BTC and ETH as well: buy after a sharp fall, sell on the bounce.
 * "Buy after a 10% fall in 24 hours, sell at +10% or after 24 hours": 150 trades, 60% won, +1.4% a trade after
 * costs; and the deeper the fall the bigger the bounce (6%: +0.8% on 444 trades, 12%: +1.9% on 89). It failed on
 * small Solana coins. One trade lost 40%. That is history, 41 rules were tried, and nothing is proven.
 *
 * The frequent end (12 Nov 2026, enrique: "i dont want a bot that does 10 trades in a year"). Ten versions that
 * trade more often were run over the same history (research/sol-dip-frequency.py). The more often a version trades
 * the thinner it gets: those trading about 240 times a year make nothing after costs, and on BTC and ETH the
 * frequent versions lose. Two SOL versions that trade about twice a week kept a small plus (+0.2 to +0.4% a trade,
 * also in the last 12 months): a 4% fall in 24 hours sold at +5% or after 24 hours (769 trades), and a 2% fall in
 * one hour sold at +3% or after 12 hours (968 trades). They are followed here too. Fifty-one rules tried in all,
 * so a plus this thin may be luck.
 *
 * What this adds: the same rules followed live, with a real price quote for a $100 swap of USDC into SOL at the
 * moment the rule buys and for the swap back when it sells. The history priced a trade at the next hour's open
 * less 0.10% a side; this shows what a swap really costs at that moment, which is the one thing a backtest cannot.
 * The rules trade rarely (the 10% rule about once a month), so this takes months to say anything on its own.
 *
 * How it follows the history test exactly: Binance's hourly SOLUSDT candles (public, no key), read once an hour.
 * At the close of an hour a rule buys when that close is fallPct or more below the close fallHours earlier, and
 * sells when a close is targetPct above the close it bought on, or holdHours after it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../config.js";
import { SOL, USDC } from "./pools.js";

export interface DipRule {
  id: string;
  fallHours: number;
  fallPct: number;
  targetPct: number;
  holdHours: number;
}
/** The rule the reply to enrique was about, its neighbours (shallower falls trade more often), and the 4 hour one. */
export const DIP_RULES: DipRule[] = [
  { id: "dip24-10-tp10-24h", fallHours: 24, fallPct: 10, targetPct: 10, holdHours: 24 },
  { id: "dip24-10-tp5-24h", fallHours: 24, fallPct: 10, targetPct: 5, holdHours: 24 },
  { id: "dip24-12-tp10-24h", fallHours: 24, fallPct: 12, targetPct: 10, holdHours: 24 },
  { id: "dip24-8-tp10-24h", fallHours: 24, fallPct: 8, targetPct: 10, holdHours: 24 },
  { id: "dip24-6-tp10-24h", fallHours: 24, fallPct: 6, targetPct: 10, holdHours: 24 },
  { id: "dip4-5-tp10-72h", fallHours: 4, fallPct: 5, targetPct: 10, holdHours: 72 },
  // the frequent end: about two trades a week each in the history, a thin plus
  { id: "dip24-4-tp5-24h", fallHours: 24, fallPct: 4, targetPct: 5, holdHours: 24 },
  { id: "dip1-2-tp3-12h", fallHours: 1, fallPct: 2, targetPct: 3, holdHours: 12 },
];
export const DIP_STAKE_USD = 100;
/** network fee of one plain swap, in dollars (a real copy's three transactions cost 0.00016 SOL in all) */
export const DIP_TX_USD = 0.01;
/** what the history test charged a side */
export const DIP_TEST_COST = 0.001;

export interface DipOpen {
  rule: string;
  /** the hour (hours since 1970) whose close set the trade off, and that close */
  signalHour: number;
  refPrice: number;
  at: number;
  /** lamports of SOL the $100 swap was quoted, and the price that is (dollars per SOL) */
  lamports: string;
  quotePrice: number;
}
export interface DipTrade {
  rule: string;
  signalHour: number;
  refPrice: number;
  quotePrice: number;
  at: number;
  exitHour: number;
  exitRef: number;
  exitAt: number;
  why: "target" | "time";
  usdOut: number;
  /** after the swap costs inside the quotes and the two network fees */
  netUsd: number;
  /** the same trade as the history test prices it: close to close, less its cost a side */
  testPct: number;
  /** sold later than the rule says (the price service gave no quote in time, or the bot was down) */
  late?: boolean;
}
export interface DipState {
  lastHour: number;
  open: DipOpen[];
  trades: DipTrade[];
  missedEntries: number;
  /** the closes the last look saw, for the status: [hour, close] */
  last: { hour: number; close: number; change4hPct: number | null; change24hPct: number | null } | null;
  error: string;
}

/** does the rule buy at the close of hour index i? */
export const dipSignal = (rule: DipRule, c: number[], i: number) => i >= rule.fallHours && c[i] / c[i - rule.fallHours] - 1 <= -rule.fallPct / 100;
/** does an open trade of the rule sell at this hour's close? */
export const dipExit = (rule: DipRule, open: { signalHour: number; refPrice: number }, hour: number, close: number): "target" | "time" | null =>
  close >= open.refPrice * (1 + rule.targetPct / 100) ? "target" : hour - open.signalHour >= rule.holdHours ? "time" : null;

/** Closed hourly candles out of a Binance klines answer: hour numbers and closes. The candle still running is left out. */
export function closedCandles(rows: unknown, now: number): { t: number[]; c: number[] } {
  const t: number[] = [];
  const c: number[] = [];
  if (!Array.isArray(rows)) return { t, c };
  for (const k of rows as unknown[][]) {
    const open = Number(k?.[0]);
    const close = Number(k?.[4]);
    if (!Number.isFinite(open) || !(close > 0) || open + 3_600_000 > now) continue;
    t.push(Math.floor(open / 3_600_000));
    c.push(close);
  }
  return { t, c };
}

const r = (x: number | null, n = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
const FILE = () => join(DATA, "solana", "dip-state.json");
const fresh = (): DipState => ({ lastHour: 0, open: [], trades: [], missedEntries: 0, last: null, error: "" });
let state: DipState = fresh();
let loaded = false;

function load() {
  loaded = true;
  try {
    state = { ...fresh(), ...(JSON.parse(readFileSync(FILE(), "utf8")) as DipState) };
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
export interface DipDeps {
  fetch: () => typeof fetch;
  quote: Quote;
  /** pause between tries of a quote, ms (tests pass 0) */
  retryMs?: number;
}

/** a quote, tried a few times: the trades are rare, so one refused request must not lose one */
async function ask(q: Quote, inMint: string, outMint: string, amount: string, tries: number, pause: number): Promise<bigint | null> {
  for (let i = 0; i < tries; i++) {
    const out = await q(inMint, outMint, amount).catch(() => undefined);
    if (out) return out;
    if (i < tries - 1 && pause > 0) await new Promise((res) => setTimeout(res, pause));
  }
  return null;
}

let busy = false;
/**
 * One look. Does nothing until an hour has closed that was not looked at yet (and 15 s have passed, so the candle
 * is final). Then: sells what the rules say to sell, buys what they say to buy, each at a real quote.
 */
export async function dipTick(deps: DipDeps, now = Date.now()): Promise<void> {
  if (busy) return;
  if (!loaded) load();
  const lastClosed = Math.floor(now / 3_600_000) - 1;
  const pending = state.open.some((o) => {
    const rule = DIP_RULES.find((x) => x.id === o.rule);
    return !rule || lastClosed - o.signalHour >= rule.holdHours;
  });
  if ((lastClosed <= state.lastHour && !pending) || now % 3_600_000 < 15_000) return;
  busy = true;
  try {
    const res = await deps.fetch()("https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1h&limit=100", { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`candles http ${res.status}`);
    const { t, c } = closedCandles(await res.json(), now);
    const i = t.length - 1;
    if (i < 0 || t[i] < lastClosed) throw new Error("the last hour's candle is not out yet");
    const hour = t[i];
    const close = c[i];
    const newHour = hour > state.lastHour;
    const pause = deps.retryMs ?? 5000;
    // sells first: a trade past its time is sold even when its hour was looked at before (a quote was missing then)
    const soldNow = new Set<string>();
    for (const o of [...state.open]) {
      const rule = DIP_RULES.find((x) => x.id === o.rule);
      const why = rule ? dipExit(rule, o, hour, close) : "time";
      if (!why) continue;
      const back = await ask(deps.quote, SOL, USDC, o.lamports, 3, pause);
      if (back === null) continue; // no quote: stays open and is tried again at the next look, marked late
      const usdOut = Number(back) / 1e6;
      const late = !newHour || (rule ? hour - o.signalHour > rule.holdHours && why === "time" : true);
      state.trades.push({
        rule: o.rule, signalHour: o.signalHour, refPrice: o.refPrice, quotePrice: o.quotePrice, at: o.at, exitHour: hour, exitRef: close, exitAt: now, why,
        usdOut: r(usdOut, 4)!, netUsd: r(usdOut - DIP_STAKE_USD - 2 * DIP_TX_USD, 4)!, testPct: r(((close / o.refPrice) * (1 - DIP_TEST_COST) ** 2 - 1) * 100)!, ...(late ? { late: true } : {}),
      });
      state.open = state.open.filter((x) => x !== o);
      soldNow.add(o.rule);
    }
    if (newHour) {
      for (const rule of DIP_RULES) {
        // as in the history test: a rule that sold at this close does not buy again at the same close
        if (soldNow.has(rule.id) || state.open.some((o) => o.rule === rule.id) || !dipSignal(rule, c, i)) continue;
        const out = await ask(deps.quote, USDC, SOL, String(DIP_STAKE_USD * 1e6), 3, pause);
        if (out === null) {
          state.missedEntries++;
          continue;
        }
        state.open.push({ rule: rule.id, signalHour: hour, refPrice: close, at: now, lamports: out.toString(), quotePrice: r(DIP_STAKE_USD / (Number(out) / 1e9), 4)! });
      }
      const ago = (h: number) => (i >= h ? r((c[i] / c[i - h] - 1) * 100) : null);
      state.last = { hour, close, change4hPct: ago(4), change24hPct: ago(24) };
      state.lastHour = hour;
    }
    if (state.trades.length > 2000) state.trades = state.trades.slice(-2000);
    state.error = "";
    save();
  } catch (e) {
    // our own fixed words only: an error text can quote what it read
    state.error = /candles http \d+|not out yet/.test(String((e as Error)?.message)) ? String((e as Error).message) : "the look failed (network or price service)";
  } finally {
    busy = false;
  }
}

export function dipSummary() {
  if (!loaded) load();
  const text = (x: DipRule) => `Buys $${DIP_STAKE_USD} of SOL when the price is ${x.fallPct}% or more below ${x.fallHours} hour${x.fallHours === 1 ? "" : "s"} earlier; sells at +${x.targetPct}% or after ${x.holdHours} hours.`;
  return {
    mode: "paper",
    note: `Paper only, nothing is sent. Rules found on 5.7 years of hourly prices (51 tried; history, not proof), followed live: each trade is priced with a real quote for a $${DIP_STAKE_USD} swap at the moment the rule buys and sells. testPct is the same trade as the history test would count it; the difference is what a swap really costs. The 10% rule traded about once a month in the history; the two shallow ones (4% in a day, 2% in an hour) about twice a week with a much thinner plus. Weeks to months are needed.`,
    lastLook: state.last && { hourEndsAt: (state.last.hour + 1) * 3_600_000, price: state.last.close, change4hPct: state.last.change4hPct, change24hPct: state.last.change24hPct },
    missedEntries: state.missedEntries,
    error: state.error,
    rules: DIP_RULES.map((x) => {
      const done = state.trades.filter((tr) => tr.rule === x.id);
      const open = state.open.find((o) => o.rule === x.id);
      const pct = done.map((tr) => (tr.netUsd / DIP_STAKE_USD) * 100);
      return {
        id: x.id, text: text(x), trades: done.length, won: done.filter((tr) => tr.netUsd > 0).length, netUsd: r(done.reduce((a, tr) => a + tr.netUsd, 0)),
        avgPct: done.length ? r(pct.reduce((a, b) => a + b, 0) / done.length) : null, avgTestPct: done.length ? r(done.reduce((a, tr) => a + tr.testPct, 0) / done.length) : null,
        late: done.filter((tr) => tr.late).length,
        open: open ? { boughtAt: open.at, price: open.quotePrice, heldHours: state.last ? state.last.hour - open.signalHour : 0, nowPct: state.last ? r((state.last.close / open.quotePrice - 1) * 100) : null } : null,
      };
    }),
    recent: state.trades.slice(-12).reverse().map((tr) => ({ rule: tr.rule, boughtAt: tr.at, soldAt: tr.exitAt, why: tr.why, pct: r((tr.netUsd / DIP_STAKE_USD) * 100), testPct: tr.testPct, ...(tr.late ? { late: true } : {}) })),
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startDip(deps: DipDeps) {
  if (process.env.SOLANA_DIP === "off" || timer) return;
  timer = setInterval(() => void dipTick(deps), 60_000);
  timer.unref();
  void dipTick(deps);
}
export function stopDip() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test hooks. */
export const _dipTest = { reset: () => ((state = fresh()), (loaded = true)), state: () => state, reload: () => load() };
