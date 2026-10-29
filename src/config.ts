import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (one level above src/). Data lives in data/, which git ignores, so updates never touch it. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** DATA_DIR overrides the data folder (tests point it at a scratch directory). */
export const DATA = process.env.DATA_DIR || join(ROOT, "data");

/** Window length of the market we record, in seconds. */
export const WINDOW_SEC = 300;
/** Polymarket event slug prefix for the 5-minute BTC up/down series. */
export const SLUG = "btc-updown-5m";

/** Seconds-left checkpoints at which the book is kept in the window summary. */
export const CHECKPOINTS = [299, 270, 240, 210, 180, 150, 120, 90, 60, 45, 30, 20, 10, 5, 1];

export type Symbol = "btc" | "eth" | "sol" | "xrp" | "doge" | "bnb" | "hype";
/** One up/down market series the recorder follows. The first one keeps the original file names. */
/** How an event slug is built from the series slug and the window start: "ts" = `<slug>-<unix start>` (5m/15m/4h),
 *  "et-hour" = `<slug>-<month>-<day>-<year>-<h(am|pm)>-et` in New York time (the hourly markets). */
export type SlugStyle = "ts" | "et-hour";
export type Series = { key: string; label: string; slug: string; windowSec: number; symbol: Symbol; slugStyle?: SlugStyle };
export const SERIES: Series[] = [
  { key: "", label: "BTC 5m", slug: SLUG, windowSec: WINDOW_SEC, symbol: "btc" },
  { key: "eth5m", label: "ETH 5m", slug: "eth-updown-5m", windowSec: 300, symbol: "eth" },
  { key: "sol5m", label: "SOL 5m", slug: "sol-updown-5m", windowSec: 300, symbol: "sol" },
  { key: "xrp5m", label: "XRP 5m", slug: "xrp-updown-5m", windowSec: 300, symbol: "xrp" },
  { key: "doge5m", label: "DOGE 5m", slug: "doge-updown-5m", windowSec: 300, symbol: "doge" },
  { key: "bnb5m", label: "BNB 5m", slug: "bnb-updown-5m", windowSec: 300, symbol: "bnb" },
  { key: "hype5m", label: "HYPE 5m", slug: "hype-updown-5m", windowSec: 300, symbol: "hype" },
  { key: "btc15m", label: "BTC 15m", slug: "btc-updown-15m", windowSec: 900, symbol: "btc" },
  { key: "eth15m", label: "ETH 15m", slug: "eth-updown-15m", windowSec: 900, symbol: "eth" },
  // 29 Oct 2026, enrique: "strategies for all windows, timeframes and coins available so we can gather data".
  { key: "sol15m", label: "SOL 15m", slug: "sol-updown-15m", windowSec: 900, symbol: "sol" },
  { key: "xrp15m", label: "XRP 15m", slug: "xrp-updown-15m", windowSec: 900, symbol: "xrp" },
  { key: "doge15m", label: "DOGE 15m", slug: "doge-updown-15m", windowSec: 900, symbol: "doge" },
  { key: "bnb15m", label: "BNB 15m", slug: "bnb-updown-15m", windowSec: 900, symbol: "bnb" },
  { key: "hype15m", label: "HYPE 15m", slug: "hype-updown-15m", windowSec: 900, symbol: "hype" },
  { key: "btc1h", label: "BTC 1h", slug: "bitcoin-up-or-down", windowSec: 3600, symbol: "btc", slugStyle: "et-hour" },
  { key: "eth1h", label: "ETH 1h", slug: "ethereum-up-or-down", windowSec: 3600, symbol: "eth", slugStyle: "et-hour" },
  { key: "sol1h", label: "SOL 1h", slug: "solana-up-or-down", windowSec: 3600, symbol: "sol", slugStyle: "et-hour" },
  { key: "xrp1h", label: "XRP 1h", slug: "xrp-up-or-down", windowSec: 3600, symbol: "xrp", slugStyle: "et-hour" },
  { key: "doge1h", label: "DOGE 1h", slug: "dogecoin-up-or-down", windowSec: 3600, symbol: "doge", slugStyle: "et-hour" },
  { key: "bnb1h", label: "BNB 1h", slug: "bnb-up-or-down", windowSec: 3600, symbol: "bnb", slugStyle: "et-hour" },
  { key: "hype1h", label: "HYPE 1h", slug: "hype-up-or-down", windowSec: 3600, symbol: "hype", slugStyle: "et-hour" },
  { key: "btc4h", label: "BTC 4h", slug: "btc-updown-4h", windowSec: 14400, symbol: "btc" },
  { key: "eth4h", label: "ETH 4h", slug: "eth-updown-4h", windowSec: 14400, symbol: "eth" },
  { key: "sol4h", label: "SOL 4h", slug: "sol-updown-4h", windowSec: 14400, symbol: "sol" },
  { key: "xrp4h", label: "XRP 4h", slug: "xrp-updown-4h", windowSec: 14400, symbol: "xrp" },
  { key: "doge4h", label: "DOGE 4h", slug: "doge-updown-4h", windowSec: 14400, symbol: "doge" },
  { key: "bnb4h", label: "BNB 4h", slug: "bnb-updown-4h", windowSec: 14400, symbol: "bnb" },
  { key: "hype4h", label: "HYPE 4h", slug: "hype-updown-4h", windowSec: 14400, symbol: "hype" },
];
/** The event slug of one window of a series (see SlugStyle). */
export function eventSlug(slug: string, start: number, style: SlugStyle = "ts"): string {
  if (style !== "et-hour") return `${slug}-${start}`;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric", hour: "numeric", hour12: true }).formatToParts(new Date(start * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${slug}-${get("month").toLowerCase()}-${get("day")}-${get("year")}-${get("hour")}${get("dayPeriod").toLowerCase()}-et`;
}
/** File-name prefix for a series: "" for the first, "eth5m-" and so on for the others. */
export const prefixOf = (s: Series) => (s.key ? `${s.key}-` : "");
/** Checkpoints for a longer window: the 5-minute ones plus every minute above them. */
export function checkpointsFor(windowSec: number): number[] {
  if (windowSec <= WINDOW_SEC) return CHECKPOINTS;
  const cps = new Set(CHECKPOINTS);
  cps.add(windowSec - 1);
  for (let s = 300; s < windowSec; s += 60) cps.add(s);
  return [...cps].sort((a, b) => b - a);
}

/** Local status page. Only listens on this computer. */
export const STATUS_PORT = Number(process.env.STATUS_PORT ?? 8790);

export const windowStart = (sec = Math.floor(Date.now() / 1000), windowSec = WINDOW_SEC) => Math.floor(sec / windowSec) * windowSec;
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The calendar day in Korean time (UTC+9): what "today", the day table and the daily loss stop use. Data files stay on UTC days. */
export const kstDay = (ms: number = Date.now()) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
