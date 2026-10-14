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

/** Local status page. Only listens on this computer. */
export const STATUS_PORT = Number(process.env.STATUS_PORT ?? 8790);

export const windowStart = (sec = Math.floor(Date.now() / 1000)) => Math.floor(sec / WINDOW_SEC) * WINDOW_SEC;
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
