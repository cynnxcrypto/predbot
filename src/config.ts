import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (one level above src/). Data lives in data/, which git ignores, so updates never touch it. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = join(ROOT, "data");

/** Window length of the market we record, in seconds. */
export const WINDOW_SEC = 300;
/** Polymarket event slug prefix for the 5-minute BTC up/down series. */
export const SLUG = "btc-updown-5m";

/** Seconds-left checkpoints at which the book is kept in the window summary. */
export const CHECKPOINTS = [299, 270, 240, 210, 180, 150, 120, 90, 60, 45, 30, 20, 10, 5, 1];

export type Symbol = "btc" | "eth" | "sol" | "xrp";
/** One up/down market series the recorder follows. The first one keeps the original file names. */
export type Series = { key: string; label: string; slug: string; windowSec: number; symbol: Symbol };
export const SERIES: Series[] = [
  { key: "", label: "BTC 5m", slug: SLUG, windowSec: WINDOW_SEC, symbol: "btc" },
  { key: "eth5m", label: "ETH 5m", slug: "eth-updown-5m", windowSec: 300, symbol: "eth" },
  { key: "sol5m", label: "SOL 5m", slug: "sol-updown-5m", windowSec: 300, symbol: "sol" },
  { key: "xrp5m", label: "XRP 5m", slug: "xrp-updown-5m", windowSec: 300, symbol: "xrp" },
  { key: "btc15m", label: "BTC 15m", slug: "btc-updown-15m", windowSec: 900, symbol: "btc" },
  { key: "eth15m", label: "ETH 15m", slug: "eth-updown-15m", windowSec: 900, symbol: "eth" },
];
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
