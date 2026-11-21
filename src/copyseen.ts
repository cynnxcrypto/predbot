/**
 * Wallets seen buying on Polymarket's live trade socket (21 Nov 2026 22:18 KST, enrique: "polymarket - find more good
 * traders then, what are u waiting for").
 *
 * The daily rescan (src/copyscan.ts) only read the profit leaderboards, and after ten scans those gave 345 new
 * wallets a day of which 1 passed. The socket (src/pmstream.ts) already shows every trade on the exchange with the
 * trading wallet in it, so every active trader passes by here whether or not a board lists it. This keeps a small
 * tally per wallet (buys, dollars, how many were crypto "Up or Down") and hands the rescan the ones worth reading.
 * The rescan's own screen and money-at-stake floors then decide; nothing here follows or trades anything.
 *
 * State: data/copy-seen.json (server only; other people's public wallets, no secrets).
 */
import { loadJson, saveJson } from "./store.js";

export const SEEN_FILE = "copy-seen.json";
/** A wallet not seen buying for this long is forgotten. */
export const SEEN_DAYS = 7;
/** At most this many wallets are kept in memory; the smallest by dollars go first. */
export const SEEN_MAX = 60_000;
/** Only wallets with at least this much are written to the file. */
const FILE_MIN_N = 3;
const FILE_MIN_USD = 50;
/** What the rescan asks of a wallet before it spends calls on it (its own screen is stricter). */
export const CAND_MIN_BUYS = 14;
export const CAND_MIN_USD = 500;

/** n = buys, usd = dollars bought, cr = buys in crypto "Up or Down" markets, f/l = first and last seen (ms). */
export type Seen = { n: number; usd: number; cr: number; f: number; l: number };
const seen = new Map<string, Seen>();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  const j = loadJson<Record<string, Seen>>(SEEN_FILE, {});
  for (const [a, x] of Object.entries(j)) if (x && x.n > 0 && Number.isFinite(x.usd) && Number.isFinite(x.l)) seen.set(a, { n: x.n, usd: x.usd, cr: x.cr || 0, f: x.f || x.l, l: x.l });
}

/** One trade off the socket. Sales are not counted. Cheap: runs for every trade on the exchange. */
export function seenNote(wallet: string, row: { side: string; usdc_size: number; title: string }, now = Date.now()) {
  if (row.side !== "BUY" || !(row.usdc_size > 0)) return;
  load();
  let x = seen.get(wallet);
  if (!x) seen.set(wallet, (x = { n: 0, usd: 0, cr: 0, f: now, l: now }));
  x.n += 1;
  x.usd += row.usdc_size;
  if (/up or down/i.test(row.title)) x.cr += 1;
  x.l = now;
}

/** Forget old wallets, keep the map bounded, write the file. Called every few minutes. */
export function seenSave(now = Date.now()) {
  load();
  for (const [a, x] of seen) if (now - x.l > SEEN_DAYS * 86400_000) seen.delete(a);
  if (seen.size > SEEN_MAX) {
    const keep = [...seen].sort((a, b) => b[1].usd - a[1].usd).slice(0, Math.floor(SEEN_MAX * 0.8));
    seen.clear();
    for (const [a, x] of keep) seen.set(a, x);
  }
  const out: Record<string, Seen> = {};
  for (const [a, x] of seen) if (x.n >= FILE_MIN_N && x.usd >= FILE_MIN_USD) out[a] = { n: x.n, usd: Math.round(x.usd), cr: x.cr, f: x.f, l: x.l };
  saveJson(SEEN_FILE, out);
}

/** Wallets worth a read by the rescan, biggest buyers first: enough buys, enough dollars, not mostly crypto up/down. */
export function seenCandidates(): { address: string; usd: number }[] {
  load();
  const out: { address: string; usd: number }[] = [];
  for (const [a, x] of seen) if (x.n >= CAND_MIN_BUYS && x.usd >= CAND_MIN_USD && x.cr * 3 <= x.n) out.push({ address: a, usd: Math.round(x.usd) });
  return out.sort((a, b) => b.usd - a.usd);
}

/** Public line: counts only. */
export function seenStatus() {
  let candidates = 0;
  for (const x of seen.values()) if (x.n >= CAND_MIN_BUYS && x.usd >= CAND_MIN_USD && x.cr * 3 <= x.n) candidates += 1;
  return { wallets: seen.size, candidates };
}

/** For tests. */
export function seenReset() {
  seen.clear();
  loaded = true;
}
