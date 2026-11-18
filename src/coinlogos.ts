/**
 * Coin logos the dashboard has not got embedded (src/logos.ts has a few): Hyperliquid lists 200+ coins. The server
 * fetches a coin's icon from Hyperliquid once, keeps it on disk, and serves it from there; a coin with no icon is
 * remembered for six hours and the page shows its first letter instead. 17 Nov 2026, enrique: "use coin logos".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./config.js";

const DIR = join(DATA, "logos");
const miss = new Map<string, number>();
const busy = new Map<string, Promise<Buffer | null>>();

/** Hyperliquid's own spelling of a coin from the page's lower-case name: BTC, kPEPE. */
export const hlName = (k: string) => (/^k[a-z0-9]{3,}$/.test(k) ? "k" + k.slice(1).toUpperCase() : k.toUpperCase());

export function coinLogo(k: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<Buffer | null> {
  if (!/^[a-z0-9]{1,12}$/.test(k)) return Promise.resolve(null);
  const f = join(DIR, `${k}.svg`);
  try {
    if (existsSync(f)) return Promise.resolve(readFileSync(f));
  } catch {
    /* read again below */
  }
  if ((miss.get(k) ?? 0) > now) return Promise.resolve(null);
  const run = busy.get(k);
  if (run) return run;
  const p = (async () => {
    try {
      const res = await fetcher(`https://app.hyperliquid.xyz/coins/${hlName(k)}.svg`, { signal: AbortSignal.timeout(5_000) });
      const body = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
      // an icon only: small, and an svg (not a page that answers every address)
      if (!body || body.length > 60_000 || !/<svg[\s>]/i.test(body.subarray(0, 600).toString("utf8"))) throw new Error("no icon");
      mkdirSync(DIR, { recursive: true });
      writeFileSync(f, body);
      return body;
    } catch {
      miss.set(k, now + 6 * 3_600_000);
      return null;
    } finally {
      busy.delete(k);
    }
  })();
  busy.set(k, p);
  return p;
}
