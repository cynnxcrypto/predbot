/**
 * Starts research/sol-candles.py once (12 Nov 2026): years of hourly prices and funding rates from Binance's public
 * market data, published to the server-data branch for the slow-trade research. Read-only, no key, no order.
 *
 * Only on the server (it needs ~/.predbot-github-token to publish), detached so a bot restart does not kill it;
 * the script holds a lock, is niced, and writes data/research/CANDLES-DONE-v1 when finished so it never starts
 * again. SOLANA_CANDLES=off disables it.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config.js";

export const CANDLES_DONE = "CANDLES-DONE-v1";

/** true when the script was started (or is left to a copy already running) */
export function startCandles(home = process.env.HOME ?? "", run: typeof spawn = spawn): boolean {
  try {
    if (process.env.SOLANA_CANDLES === "off" || !home || !existsSync(join(home, ".predbot-github-token"))) return false;
    if (existsSync(join(ROOT, "data", "research", CANDLES_DONE))) return false;
    const out = openSync(join(home, "sol-candles.log"), "a");
    run("python3", [join(ROOT, "research", "sol-candles.py")], { cwd: ROOT, detached: true, stdio: ["ignore", out, out] }).unref();
    closeSync(out);
    return true;
  } catch {
    return false;
  }
}
