/**
 * PAPER, read-only: would another sale rule have beaten "hold until the copied wallet sells" on the REAL day-holder
 * copies (slowlive.ts)? enrique, 16 Nov 2026 12:44-12:55 KST: "for solana spot copy, what are the triggers for
 * sale?", then "hmmm maybe we should do more about this".
 *
 * The real copy has no stop loss, no take profit and no time stop under 72 h: it sells when the copied wallet first
 * sells. The real record keeps each copy's result and how long it was held, not the price in between, so the past
 * cannot be replayed through such rules. This follows the copies that are out NOW: every POLL_MS it asks Jupiter what
 * selling each one would bring at that moment (a real sell quote for the tokens the buy was quoted, fees and price
 * impact in), and notes the first poll at which each rule below would have sold. When the copy is really sold, each
 * rule is scored on that same copy against what it really made:
 *
 *   a rule that fired: what its poll's quote would have brought (a half rule: half of that, half of the real result);
 *   a rule that did not fire: the real result.
 *
 * `gapPct` is how far the real result was from the last poll's quote on average (transaction fees, the minutes between
 * that poll and the sale, tokens received against tokens quoted); a rule's fired results are moved by it, so both
 * sides carry the same costs. Nothing is bought, sold or signed here, and no real copy is touched: it reads
 * slowlive's list of held copies and its result rows through the two functions it is handed.
 *
 * Numbers only in the status: no coin, no time, no wallet of ours. SOLANA_SLOW_EXITS=off disables it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../config.js";
import { SOL } from "./pools.js";

/** Each held copy is quoted this often. */
export const POLL_MS = 120_000;
/** One request at most per step: up to 120 copies a round. */
export const STEP_MS = 1000;
const LAMPORTS = 1e9;
const KEEP_DONE = 5000;
/** A copy gone from the held list with no result row after this long is dropped (its buy never counted). */
const WAIT_ROW_MS = 2 * 3_600_000;

/** What a rule sees at a poll: v = SOL a sale would bring now / SOL paid; prev = the poll before; peak = highest v so far (1 at least); heldH = hours since our buy. */
export interface Seen {
  v: number;
  prev: number | null;
  peak: number;
  heldH: number;
}
export const RULES: readonly { id: string; text: string; half?: boolean; hit: (x: Seen) => boolean }[] = [
  { id: "stop-15", text: "sell when a sale would bring 15% less than we paid", hit: (x) => x.v <= 0.85 },
  { id: "stop-30", text: "sell when a sale would bring 30% less than we paid", hit: (x) => x.v <= 0.7 },
  { id: "stop-50", text: "sell when a sale would bring 50% less than we paid", hit: (x) => x.v <= 0.5 },
  { id: "take-30", text: "sell all at +30%", hit: (x) => x.v >= 1.3 },
  { id: "take-50", text: "sell all at +50%", hit: (x) => x.v >= 1.5 },
  { id: "take-100", text: "sell all at +100%", hit: (x) => x.v >= 2 },
  { id: "half-50", text: "sell half at +50%, the rest when the wallet sells", half: true, hit: (x) => x.v >= 1.5 },
  { id: "half-100", text: "sell half at +100%, the rest when the wallet sells", half: true, hit: (x) => x.v >= 2 },
  { id: "trail-20", text: "sell when 20% under the best value seen since the buy", hit: (x) => x.v <= x.peak * 0.8 },
  { id: "trail-30", text: "sell when 30% under the best value seen since the buy", hit: (x) => x.v <= x.peak * 0.7 },
  { id: "time-2h", text: "sell 2 h after our buy if the wallet has not sold", hit: (x) => x.heldH >= 2 },
  { id: "time-4h", text: "sell 4 h after our buy if the wallet has not sold", hit: (x) => x.heldH >= 4 },
  { id: "time-8h", text: "sell 8 h after our buy if the wallet has not sold", hit: (x) => x.heldH >= 8 },
  { id: "drop-30", text: "sell when the value falls 30% between two polls (sharp drop)", hit: (x) => x.prev !== null && x.v <= x.prev * 0.7 },
];

/** A real copy that is held, as slowlive hands it over. tokens = the raw token amount its buy was quoted. */
export interface Held {
  mint: string;
  seenMs: number;
  name: string;
  boughtMs: number;
  stakeSol: number;
  tokens?: string;
}
/** A finished copy's result: null = its buy never landed; undefined = no row yet. */
export type Result = { netSol: number; stakeSol: number; heldMin: number | null } | null | undefined;
interface Track {
  mint: string;
  seenMs: number;
  name: string;
  boughtMs: number;
  stakeSol: number;
  tokens: string;
  polls: number;
  v: number | null;
  prev: number | null;
  peak: number;
  lastMs: number;
  /** when it was last asked for, ms */
  askMs: number;
  /** when it was first missing from the held list, ms */
  goneMs?: number;
  /** rule id -> v at the first poll it would have sold */
  fired: Record<string, number>;
}
interface Done {
  name: string;
  stakeSol: number;
  netSol: number;
  heldMin: number | null;
  polls: number;
  lastV: number | null;
  /** was the last poll close enough to the sale to compare the two (within 2 polls) */
  near: boolean;
  fired: Record<string, number>;
}
interface State {
  tracks: Track[];
  done: Done[];
}
type Quote = (inMint: string, outMint: string, amount: string) => Promise<bigint | null | undefined>;
interface Source {
  held: () => Held[];
  resultOf: (mint: string, seenMs: number) => Result;
}

const FILE = () => join(DATA, "solana-slowexits.json");
const fresh = (): State => ({ tracks: [], done: [] });
let state = fresh();
let loaded = false;
let source: Source | null = null;
let quote: Quote | null = null;
let timer: NodeJS.Timeout | null = null;
let busy = false;
let savedAt = 0;
const health = { quotes: 0, noRoute: 0, missed: 0, errors: 0 };

function load() {
  loaded = true;
  try {
    const s = JSON.parse(readFileSync(FILE(), "utf8")) as Partial<State>;
    state = { tracks: Array.isArray(s.tracks) ? s.tracks : [], done: Array.isArray(s.done) ? s.done : [] };
  } catch {
    state = fresh(); // first run
  }
}
function save() {
  try {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(FILE() + ".tmp", JSON.stringify(state));
    renameSync(FILE() + ".tmp", FILE());
  } catch {
    /* next time */
  }
}
/** slowlive hands over its read-only view (called at its start). */
export const setExitSource = (s: Source | null) => (source = s);

/** One poll's value for a copy: every rule that has not fired yet is asked. Pure over the track. */
export function see(t: Track, v: number, now: number) {
  const x: Seen = { v, prev: t.v, peak: Math.max(1, t.peak, v), heldH: (now - t.boughtMs) / 3_600_000 };
  for (const r of RULES) if (t.fired[r.id] === undefined && r.hit(x)) t.fired[r.id] = v;
  t.prev = t.v;
  t.v = v;
  t.peak = x.peak;
  t.polls++;
  t.lastMs = now;
}

/** Housekeeping, no request: new held copies are taken up, finished ones are scored. Returns the copies still held. */
function sync(now: number): Track[] {
  const held = source!.held();
  const key = (x: { mint: string; seenMs: number }) => `${x.mint}|${x.seenMs}`;
  const on = new Set(held.map(key));
  const have = new Set(state.tracks.map(key));
  let changed = false;
  // a copy bought before this study ran has no quoted token amount: it is not followed
  for (const h of held) {
    if (have.has(key(h)) || !h.tokens || !(h.stakeSol > 0)) continue;
    state.tracks.push({ mint: h.mint, seenMs: h.seenMs, name: h.name, boughtMs: h.boughtMs, stakeSol: h.stakeSol, tokens: h.tokens, polls: 0, v: null, prev: null, peak: 1, lastMs: 0, askMs: 0, fired: {} });
    changed = true;
  }
  const out: Track[] = [];
  for (const t of [...state.tracks]) {
    if (on.has(key(t))) {
      t.goneMs = undefined;
      out.push(t);
      continue;
    }
    // off the held list: sold (a row follows), or still being sold
    const gone = (t.goneMs ??= now);
    const r = source!.resultOf(t.mint, t.seenMs);
    if (r === undefined && now - gone < WAIT_ROW_MS) continue;
    state.tracks = state.tracks.filter((x) => x !== t);
    changed = true;
    if (!r) continue;
    state.done.push({ name: t.name, stakeSol: r.stakeSol, netSol: r.netSol, heldMin: r.heldMin, polls: t.polls, lastV: t.v, near: t.polls > 0 && gone - t.lastMs <= 2 * POLL_MS, fired: t.fired });
    if (state.done.length > KEEP_DONE) state.done = state.done.slice(-KEEP_DONE);
  }
  if (changed) save();
  return out;
}
/** One sell quote for one copy. */
async function ask(t: Track, now: number) {
  t.askMs = now;
  let out: bigint | null | undefined;
  try {
    out = await quote!(t.mint, SOL, t.tokens);
  } catch {
    out = undefined;
    health.errors++;
  }
  health.quotes++;
  if (out === undefined) health.missed++; // nothing measured: no conclusion
  else if (out === null) health.noRoute++; // no route now: not counted as zero, a route can come back
  else see(t, Number(out) / LAMPORTS / t.stakeSol, now);
}
/**
 * Every STEP_MS: the housekeeping, then ONE quote, for the held copy asked longest ago, if that is POLL_MS or more.
 * One at a time and spread over the two minutes, so the paper copy's own quotes (same line, slow.ts) never queue
 * behind a burst of these.
 */
export async function step(now = Date.now()) {
  if (busy || !source || !quote) return;
  busy = true;
  try {
    if (!loaded) load();
    const due = sync(now)
      .filter((t) => now - t.askMs >= POLL_MS)
      .sort((a, b) => a.askMs - b.askMs)[0];
    if (due) await ask(due, now);
    if (now - savedAt > 60_000) {
      savedAt = now;
      save();
    }
  } finally {
    busy = false;
  }
}
/** For tests: the housekeeping and a quote for every held copy at once. */
export async function tick(now = Date.now()) {
  if (busy || !source || !quote) return;
  busy = true;
  try {
    for (const t of sync(now)) await ask(t, now);
    save();
  } finally {
    busy = false;
  }
}

export function startSlowExits(c: { quote: Quote }) {
  if (timer || process.env.SOLANA_SLOW_EXITS === "off") return;
  quote = c.quote;
  if (!loaded) load();
  timer = setInterval(() => void step().catch(() => void health.errors++), STEP_MS);
  timer.unref();
}
export function stopSlowExits() {
  if (timer) clearInterval(timer);
  timer = null;
  if (loaded) save();
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
/** Public: numbers and the rules' own names only. */
export function slowExitsSummary() {
  if (!loaded) load();
  const done = state.done;
  const ret = (d: Done) => d.netSol / d.stakeSol;
  // how far the real result was from the last poll's quote, on the copies whose last poll was close to the sale
  const near = done.filter((d) => d.near && d.lastV !== null);
  const gap = near.length ? near.reduce((a, d) => a + (ret(d) - (d.lastV! - 1)), 0) / near.length : 0;
  const realNet = done.reduce((a, d) => a + d.netSol, 0);
  const rules = RULES.map((r) => {
    let net = 0;
    let won = 0;
    const hit = done.filter((d) => d.fired[r.id] !== undefined);
    for (const d of done) {
      const v = d.fired[r.id];
      const sold = v === undefined ? ret(d) : r.half ? 0.5 * (v - 1 + gap) + 0.5 * ret(d) : v - 1 + gap;
      net += sold * d.stakeSol;
      if (sold > 0) won++;
    }
    const avg = (f: (d: Done) => number) => (hit.length ? r1((hit.reduce((a, d) => a + f(d), 0) / hit.length) * 100) : null);
    return {
      id: r.id,
      text: r.text,
      /** copies on which it would have sold; what it made on those, and what those same copies really made, % of stake */
      fired: hit.length,
      firedAvgRetPct: avg((d) => (r.half ? 0.5 * (d.fired[r.id] - 1 + gap) + 0.5 * ret(d) : d.fired[r.id] - 1 + gap)),
      firedRealAvgRetPct: avg(ret),
      won,
      netSol: r6(net),
      /** against the real result of the same copies: above zero = the rule would have made more */
      vsRealSol: r6(net - realNet),
    };
  }).sort((a, b) => b.vsRealSol - a.vsRealSol);
  const open = state.tracks.filter((t) => t.v !== null && !t.goneMs);
  return {
    note: `PAPER beside the REAL day-holder copies (enrique, 16 Nov 2026: "maybe we should do more about this"): every ${POLL_MS / 1000} s a real sell quote for each real copy that is out; each rule is scored on the same copies against what they really made (a rule that did not fire = the real result; a fired one = its poll's quote, moved by gapPct, the average distance between the last poll's quote and the real result). copies = real copies followed from buy to sale since this began; copies bought before it are not in. Under 100 copies says little.`,
    pollSec: POLL_MS / 1000,
    copies: done.length,
    real: { won: done.filter((d) => d.netSol > 0).length, netSol: r6(realNet), avgRetPct: done.length ? r1((done.reduce((a, d) => a + ret(d), 0) / done.length) * 100) : null },
    gapPct: near.length ? r1(gap * 100) : null,
    gapCopies: near.length,
    rules,
    /** the copies out now, as a sale would bring: how many, their average, how many 30%+ under what we paid */
    open: { n: open.length, avgRetPct: open.length ? r1((open.reduce((a, t) => a + t.v! - 1, 0) / open.length) * 100) : null, under30: open.filter((t) => t.v! <= 0.7).length },
    quotes: health.quotes,
    noRoute: health.noRoute,
    missed: health.missed,
    errors: health.errors,
  };
}

/** Test hooks. */
export const _test = {
  reset: () => {
    state = fresh();
    loaded = true;
    busy = false;
    health.quotes = health.noRoute = health.missed = health.errors = 0;
  },
  state: () => state,
  setQuote: (q: Quote | null) => (quote = q),
};
