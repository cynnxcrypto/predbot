/**
 * Back-data downloader (27 Oct 2026, enrique: "any way u can grab past data that we didn't directly record ourselves live?").
 *
 * Pulls, for every series, the windows we never recorded (default: the last 14 days) from public endpoints:
 *  - Polymarket Gamma: the market of each window (condition id, token ids, resolved outcome);
 *  - Polymarket CLOB: the UP token's price path at 1-minute fidelity (the DOWN side is 1 minus it, give or take the spread);
 *  - Polymarket data API: the trade tape of the window (who lifted which side, at what price and size);
 *  - Binance: 1-minute spot and futures candles with taker buy volume, funding rates and open interest (5-minute).
 * The 1-second book detail of the live recorder is not available anywhere; this fills in results, coarse prices and flow.
 *
 * Output (data/history/):
 *  - <prefix>windows.jsonl: one row per window {start, conditionId, upToken, downToken, resolvedUp, prices: [[t, upPrice]...], trades: [[t, side, price, size]...]}
 *    where side is 1 for buying UP (or selling DOWN) and -1 for buying DOWN (or selling UP), and price is always in UP terms
 *    (a DOWN-token trade at 0.15 is stored as 0.85). Rows carry tapeVersion 2 from 28 Oct 2026; earlier rows stored the traded
 *    token's own price, so the two sides cannot be told apart from the price there without the price path.
 *  - binance-<symbol>-spot-1m.jsonl / -futures-1m.jsonl: [openTimeMs, open, high, low, close, volume, trades, takerBuyVolume]
 *  - binance-<symbol>-funding.jsonl: {t, rate}; binance-<symbol>-oi-5m.jsonl: {t, oi}
 *  - state.json: progress and last run, for the status page.
 *
 * Runs as its own process (`npm run history`, or spawned by the bot 5 minutes after start and every 6 hours), paced at about
 * four requests a second, resumable: windows already in the file are skipped, so a rerun only adds what is new. Set
 * HISTORY_DAYS to change the reach, HISTORY=off to stop the bot from spawning it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, SERIES, eventSlug, noonEt, prefixOf, type Series } from "./config.js";

const DIR = join(DATA, "history");
const DAYS = Number(process.env.HISTORY_DAYS) > 0 ? Number(process.env.HISTORY_DAYS) : 14;
const UA = "PredBotHistory/0.1";
const PACE_MS = 250;
/** HISTORY_SERIES=btc1h,eth1h,... pulls only those series (and their coins' Binance candles); HISTORY_TAPE=off skips the trade tape. */
const ONLY = (process.env.HISTORY_SERIES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const TAPE = process.env.HISTORY_TAPE !== "off";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type State = { startedAt: number; lastRunAt: number | null; done: Record<string, number>; missing: Record<string, number>; binance: Record<string, number>; error: string | null; running: boolean };
let state: State = { startedAt: Date.now(), lastRunAt: null, done: {}, missing: {}, binance: {}, error: null, running: true };
function saveState() {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, "state.json"), JSON.stringify(state, null, 2));
}
function log(line: string) {
  const msg = `${new Date().toISOString()} ${line}`;
  console.log(msg);
  mkdirSync(DIR, { recursive: true });
  appendFileSync(join(DIR, "log.txt"), msg + "\n");
}

let lastRequestAt = 0;
async function getJson<T>(url: string, tries = 4): Promise<T | null> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const wait = lastRequestAt + PACE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        await sleep(5000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${url.slice(0, 90)}`);
      return (await res.json()) as T;
    } catch (error) {
      if (attempt === tries - 1) {
        log(`gave up: ${error instanceof Error ? error.message : String(error)} ${url.slice(0, 90)}`);
        return null;
      }
      await sleep(2000 * (attempt + 1));
    }
  }
  return null;
}

type GammaEvent = { markets?: { conditionId?: string; clobTokenIds?: string; outcomePrices?: string; closed?: boolean }[] };
type HistoryWindow = { start: number; conditionId: string; upToken: string; downToken: string; resolvedUp: boolean | null; prices: [number, number][]; trades: [number, number, number, number][]; tapeVersion?: number };

/** Window starts already in the file, so a rerun only fetches what is new. */
/** Starts already on file. Rows from before tapeVersion 2 (trade prices in the traded token's own terms) are dropped and
 *  rewritten out of the file, so those windows get pulled again with the tape in UP terms. */
function doneStarts(file: string): Set<number> {
  const out = new Set<number>();
  if (!existsSync(file)) return out;
  const keep: string[] = [];
  let dropped = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const w = JSON.parse(line) as { start: number; tapeVersion?: number };
      // Old tape format, or a second copy of a window (two pulls that overlapped both appended it).
      if ((w.tapeVersion ?? 1) < 2 || out.has(w.start)) { dropped += 1; continue; }
      out.add(w.start);
      keep.push(line);
    } catch {
      /* skip a torn line */
    }
  }
  if (dropped) {
    writeFileSync(file, keep.length ? keep.join("\n") + "\n" : "");
    log(`${file}: dropped ${dropped} duplicate or old-format window row(s)`);
  }
  return out;
}

async function fetchWindow(series: Series, start: number): Promise<HistoryWindow | null | "unresolved"> {
  const events = await getJson<GammaEvent[]>(`https://gamma-api.polymarket.com/events?slug=${eventSlug(series.slug, start, series.slugStyle)}`);
  const market = events?.[0]?.markets?.[0];
  if (!market?.clobTokenIds || !market.conditionId) return null;
  let tokens: string[] = [];
  try {
    tokens = JSON.parse(market.clobTokenIds) as string[];
  } catch {
    return null;
  }
  if (tokens.length < 2) return null;
  let resolvedUp: boolean | null = null;
  try {
    const up = Number((JSON.parse(market.outcomePrices ?? "[]") as string[])[0]);
    if (up === 1) resolvedUp = true;
    if (up === 0) resolvedUp = false;
  } catch {
    resolvedUp = null;
  }
  // A window that is over but not yet resolved is tried again on the next run.
  if (resolvedUp == null) return "unresolved";
  const end = start + series.windowSec;
  const ph = await getJson<{ history?: { t: number; p: number }[] }>(`https://clob.polymarket.com/prices-history?market=${tokens[0]}&startTs=${start - 60}&endTs=${end + 60}&fidelity=1`);
  const prices: [number, number][] = (ph?.history ?? []).map((h) => [h.t, h.p]);
  const trades: [number, number, number, number][] = [];
  for (let offset = 0; TAPE && offset < 10000; offset += 1000) {
    const page = await getJson<{ side?: string; asset?: string; outcome?: string; size?: number | string; price?: number | string; timestamp?: number | string }[]>(`https://data-api.polymarket.com/trades?market=${market.conditionId}&limit=1000&offset=${offset}`);
    if (!page || !Array.isArray(page)) break;
    for (const t of page) {
      const upToken = t.asset === tokens[0] || /^up$/i.test(t.outcome ?? "");
      const buyUp = (t.side === "BUY") === upToken;
      const ts = Number(t.timestamp);
      const price = Number(t.price);
      trades.push([ts > 1e12 ? Math.floor(ts / 1000) : ts, buyUp ? 1 : -1, upToken ? price : Math.round((1 - price) * 1e4) / 1e4, Number(t.size)]);
    }
    if (page.length < 1000) break;
  }
  trades.sort((a, b) => a[0] - b[0]);
  return { start, conditionId: market.conditionId, upToken: tokens[0], downToken: tokens[1], resolvedUp, prices, trades, tapeVersion: 2 };
}

async function pullWindows(series: Series) {
  const prefix = prefixOf(series);
  const file = join(DIR, `${prefix}windows.jsonl`);
  const done = doneStarts(file);
  const now = Math.floor(Date.now() / 1000);
  const first = Math.floor((now - DAYS * 86400) / series.windowSec) * series.windowSec;
  const last = Math.floor(now / series.windowSec) * series.windowSec - 2 * series.windowSec;
  // Daily windows start at noon New York time (23 or 25 hours apart across a DST change), the others on unix multiples.
  const starts: number[] = [];
  if (series.slugStyle === "et-day") for (let k = 2; k <= DAYS; k++) starts.push(noonEt(now - k * 86400));
  else for (let start = last; start >= first; start -= series.windowSec) starts.push(start);
  let added = 0;
  let missing = 0;
  let consecutiveMissing = 0;
  for (const start of starts) {
    if (done.has(start)) continue;
    const w = await fetchWindow(series, start);
    if (w === "unresolved") continue;
    if (!w) {
      missing += 1;
      // Markets older than Polymarket's listing of this series simply do not exist: stop after a long run of misses.
      if (++consecutiveMissing >= 60) {
        log(`${series.label}: 60 windows in a row not listed before ${new Date(start * 1000).toISOString()}, stopping there`);
        break;
      }
      continue;
    }
    consecutiveMissing = 0;
    appendFileSync(file, JSON.stringify(w) + "\n");
    done.add(start);
    added += 1;
    if (added % 50 === 0) {
      state.done[prefix || "btc5m-"] = done.size;
      state.missing[prefix || "btc5m-"] = missing;
      saveState();
    }
  }
  state.done[prefix || "btc5m-"] = done.size;
  state.missing[prefix || "btc5m-"] = missing;
  saveState();
  log(`${series.label}: ${added} window(s) added, ${done.size} on file, ${missing} not listed`);
}

/** Last timestamp in a jsonl of arrays/objects whose first field is the time, so Binance pulls continue where they stopped. */
function lastTime(file: string): number {
  if (!existsSync(file)) return 0;
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(lines[i]) as number[] | { t: number };
      return Array.isArray(row) ? row[0] : row.t;
    } catch {
      /* torn line */
    }
  }
  return 0;
}

async function pullBinance(symbol: string) {
  const pair = `${symbol.toUpperCase()}USDT`;
  const from = Date.now() - DAYS * 86400_000;
  for (const [kind, base] of [["spot", "https://api.binance.com/api/v3/klines"], ["futures", "https://fapi.binance.com/fapi/v1/klines"]] as const) {
    const file = join(DIR, `binance-${symbol}-${kind}-1m.jsonl`);
    let since = Math.max(from, lastTime(file) + 60_000);
    let rows = 0;
    while (since < Date.now() - 120_000) {
      const page = await getJson<unknown[][]>(`${base}?symbol=${pair}&interval=1m&startTime=${since}&limit=1000`);
      if (!page || !Array.isArray(page) || !page.length) break;
      for (const k of page) {
        // [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]
        appendFileSync(file, JSON.stringify([k[0], +k[1]!, +k[2]!, +k[3]!, +k[4]!, +k[5]!, k[8], +k[9]!]) + "\n");
        rows += 1;
      }
      since = Number(page[page.length - 1][0]) + 60_000;
      if (page.length < 1000) break;
    }
    state.binance[`${symbol}-${kind}`] = (state.binance[`${symbol}-${kind}`] ?? 0) + rows;
    if (rows) log(`binance ${pair} ${kind}: ${rows} candle(s)`);
  }
  const fund = join(DIR, `binance-${symbol}-funding.jsonl`);
  const fr = await getJson<{ fundingTime: number; fundingRate: string }[]>(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${pair}&startTime=${Math.max(from, lastTime(fund) + 1)}&limit=1000`);
  for (const f of fr ?? []) appendFileSync(fund, JSON.stringify({ t: f.fundingTime, rate: Number(f.fundingRate) }) + "\n");
  const oi = join(DIR, `binance-${symbol}-oi-5m.jsonl`);
  let oiSince = Math.max(Date.now() - 29 * 86400_000, from, lastTime(oi) + 1);
  while (oiSince < Date.now() - 600_000) {
    const page = await getJson<{ timestamp: number; sumOpenInterest: string }[]>(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${pair}&period=5m&startTime=${oiSince}&limit=500`);
    if (!page || !Array.isArray(page) || !page.length) break;
    for (const o of page) appendFileSync(oi, JSON.stringify({ t: o.timestamp, oi: Number(o.sumOpenInterest) }) + "\n");
    oiSince = page[page.length - 1].timestamp + 1;
    if (page.length < 500) break;
  }
  saveState();
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  try {
    state = { ...state, ...(JSON.parse(readFileSync(join(DIR, "state.json"), "utf8")) as Partial<State>), running: true, error: null };
  } catch {
    /* first run */
  }
  saveState();
  log(`history: pulling the last ${DAYS} day(s)`);
  const chosen = SERIES.filter((s) => !ONLY.length || ONLY.includes(s.key || "btc5m"));
  const symbols = [...new Set(chosen.map((s) => s.symbol))];
  for (const symbol of symbols) {
    try {
      await pullBinance(symbol);
    } catch (error) {
      log(`binance ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const series of chosen) {
    try {
      await pullWindows(series);
    } catch (error) {
      log(`${series.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  state.lastRunAt = Date.now();
  state.running = false;
  saveState();
  log("history: done");
}

main().catch((error) => {
  state.error = error instanceof Error ? error.message : String(error);
  state.running = false;
  saveState();
  log(`history: failed: ${state.error}`);
  process.exit(1);
});
