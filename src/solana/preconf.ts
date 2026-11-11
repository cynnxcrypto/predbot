/**
 * PAPER / READ-ONLY: how much earlier could we know of a trader's buy? enrique, 12 Nov 2026 00:15 KST: "try
 * everything u can for speed and if we try everything and we believe the paid api next tier is good, we can try it".
 *
 * Helius has a stream called Preconfirmations (its docs, read 12 Nov 2026): a transaction is pushed the moment the
 * block's leader executes it, before the block has reached any RPC node. It is on the plan we have, paid by use.
 * Today we learn of a buy from the processed stream (copyrun.ts). This measures, for the SAME transactions, how many
 * ms earlier the early stream had them, and for what share of them it had anything at all (it only covers leaders
 * that forward to Helius or run Jito's BAM).
 *
 * That number decides the next step. If the lead is small, a faster feed is worth neither building on nor paying
 * for; if it is large, it says how much. Nothing is traded on it and nothing is sent: only the signature is read
 * out of each message, to pair it with the processed stream.
 *
 * Cost: 10 credits a message, and at least 300 for every slot that has one. So this is ONE short run with a hard
 * budget (CREDITS, kept across restarts in data/): when it is spent, or after MINUTES of listening, the socket is
 * closed for good. SOLANA_PRECONF=off disables.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../config.js";
import { base58 } from "./whirlpool.js";

export const CREDITS = Math.min(300_000, Math.max(300, Number(process.env.SOLANA_PRECONF_CREDITS) || 60_000));
export const MINUTES = 30;
const SLOT_MIN_CREDITS = 300;
const MSG_CREDITS = 10;
const LEADS_KEPT = 2000;
const PAIR_KEPT = 5000;
const FILE = () => join(DATA, "solana-preconf.json");

/** One message of the early stream: a version byte, the slot, the place in the block, a status, then the transaction as sent. */
export function decodeFrame(b: Uint8Array): { slot: number; status: "failed" | "success" | "unknown"; sig: string | null } | null {
  if (b.length < 18 + 66 || b[0] !== 1) return null;
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const slot = Number(buf.readBigUInt64LE(1));
  const status = b[17] === 0 ? "failed" : b[17] === 1 ? "success" : "unknown";
  // legacy and version 0 transactions begin with the count of signatures (one byte below 128) and then the
  // signatures; the first one is the transaction's id. A newer layout is counted as unread, never guessed.
  const n = b[18];
  const sig = n >= 1 && n <= 16 && b.length >= 19 + 64 * n ? base58(buf.subarray(19, 19 + 64)) : null;
  return { slot, status, sig };
}

interface Saved {
  credits: number;
  msgs: number;
  slots: number;
  unread: number;
  byStatus: { failed: number; success: number; unknown: number };
  /** processed-stream transactions signed by a watched trader while the early stream was listening */
  signerTx: number;
  /** ms the early stream was ahead for each paired transaction (negative: it came later); the newest LEADS_KEPT */
  leads: number[];
  paired: number;
  listenedMs: number;
  done: boolean;
}
const blank = (): Saved => ({ credits: 0, msgs: 0, slots: 0, unread: 0, byStatus: { failed: 0, success: 0, unknown: 0 }, signerTx: 0, leads: [], paired: 0, listenedMs: 0, done: false });

/** The books of one run: what it has cost, and the pairs. Pure, so it can be tested without a socket. */
export function makeProbe(budget = CREDITS, from: Saved = blank()) {
  const s = from;
  const early = new Map<string, number>();
  const processed = new Map<string, number>();
  const perSlot = new Map<number, number>();
  const bound = (m: Map<unknown, unknown>, n: number) => {
    if (m.size > n) for (const k of [...m.keys()].slice(0, m.size - n)) m.delete(k);
  };
  const pair = (lead: number) => {
    s.paired++;
    s.leads.push(Math.round(lead));
    if (s.leads.length > LEADS_KEPT) s.leads.shift();
  };
  return {
    state: s,
    /** a message of the early stream; returns false once the budget is spent */
    onEarly(m: { slot: number; status: "failed" | "success" | "unknown"; sig: string | null }, now: number): boolean {
      s.msgs++;
      s.byStatus[m.status]++;
      const n = (perSlot.get(m.slot) ?? 0) + 1;
      perSlot.set(m.slot, n);
      if (n === 1) {
        s.slots++;
        s.credits += SLOT_MIN_CREDITS;
      } else if (n * MSG_CREDITS > SLOT_MIN_CREDITS) s.credits += MSG_CREDITS;
      bound(perSlot, 256);
      if (!m.sig) s.unread++;
      else if (!early.has(m.sig)) {
        early.set(m.sig, now);
        bound(early, PAIR_KEPT);
        const p = processed.get(m.sig);
        if (p !== undefined) {
          processed.delete(m.sig);
          pair(p - now); // the processed stream had it first
        }
      }
      if (s.credits >= budget) s.done = true;
      return !s.done;
    },
    /** the same transaction on the processed stream (only those signed by a watched trader are passed in) */
    onProcessed(sig: string, now: number) {
      s.signerTx++;
      const e = early.get(sig);
      if (e !== undefined) return pair(now - e);
      processed.set(sig, now);
      bound(processed, PAIR_KEPT);
    },
  };
}

const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null);

let probe = makeProbe();
let sock: WebSocket | null = null;
let stopped = true;
let phase: "off" | "waiting" | "listening" | "done" | "refused" | "no key" = "off";
let timer: ReturnType<typeof setInterval> | null = null;
let openedAt = 0;
let tries = 0;
let subId: unknown = null;
let cfg: { url: () => string | null; signers: () => string[] } | null = null;

function save() {
  try {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(FILE() + ".tmp", JSON.stringify(probe.state));
    renameSync(FILE() + ".tmp", FILE());
  } catch {
    /* a measurement: losing it costs nothing */
  }
}
function finish() {
  probe.state.done = true;
  phase = "done";
  if (openedAt) probe.state.listenedMs += Date.now() - openedAt;
  openedAt = 0;
  try {
    if (typeof subId === "number") sock?.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "preconfUnsubscribe", params: [subId] }));
  } catch {
    /* closing anyway */
  }
  sock?.close();
  sock = null;
  save();
}
function connect() {
  const url = cfg?.url();
  if (stopped || probe.state.done || sock) return;
  if (!url) return void (phase = "no key");
  const signers = cfg!.signers().slice(0, 10_000);
  if (!signers.length) return;
  if (++tries > 6) return finish(); // it keeps dropping: stop asking
  let s: WebSocket;
  try {
    s = new WebSocket(url);
  } catch {
    return;
  }
  sock = s;
  s.binaryType = "arraybuffer";
  s.onopen = () => {
    // every status is asked for: a message whose status is not known yet would not match a "successful only" filter
    s.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "preconfSubscribe", params: [{ signerInclude: signers }] }));
  };
  s.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      let m: { id?: number; result?: unknown; error?: unknown };
      try {
        m = JSON.parse(ev.data) as typeof m;
      } catch {
        return;
      }
      if (m.id !== 1) return;
      if (m.error) {
        // our own fixed word only: the provider's text is not carried into the status
        phase = "refused";
        probe.state.done = true;
        save();
        s.close();
        return;
      }
      subId = m.result;
      phase = "listening";
      openedAt = Date.now();
      return;
    }
    const f = decodeFrame(new Uint8Array(ev.data as ArrayBuffer));
    if (!f) return void probe.state.unread++;
    if (!probe.onEarly(f, Date.now())) finish();
  };
  s.onclose = () => {
    if (sock === s) sock = null;
    if (openedAt) probe.state.listenedMs += Date.now() - openedAt;
    openedAt = 0;
    if (phase === "listening") phase = "waiting";
  };
  s.onerror = () => undefined;
}

/** The processed stream saw this transaction, signed by a watched trader. Counted only while the early stream listens. */
export function preconfSeen(sig: string, now = Date.now()) {
  if (phase === "listening") probe.onProcessed(sig, now);
}

export function startPreconf(c: NonNullable<typeof cfg>) {
  if (process.env.SOLANA_PRECONF === "off" || typeof WebSocket === "undefined" || !stopped) return;
  stopped = false;
  cfg = c;
  tries = 0;
  try {
    probe = makeProbe(CREDITS, { ...blank(), ...(JSON.parse(readFileSync(FILE(), "utf8")) as Saved) });
  } catch {
    probe = makeProbe();
  }
  phase = probe.state.done ? "done" : "waiting";
  if (probe.state.done) return;
  // not in the first minute of a start, when the bot has enough to do
  timer = setInterval(() => {
    if (probe.state.done) return;
    if (probe.state.listenedMs + (openedAt ? Date.now() - openedAt : 0) > MINUTES * 60_000) return finish();
    if (!sock) connect();
    save();
  }, 60_000);
  timer.unref?.();
}
export function stopPreconf() {
  if (stopped) return;
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
  if (openedAt) probe.state.listenedMs += Date.now() - openedAt;
  openedAt = 0;
  sock?.close();
  sock = null;
  if (phase !== "off") save();
}

export function preconfSummary(p = probe, state: string = phase) {
  const s = p.state;
  const first = s.leads.filter((v) => v > 0);
  return {
    note: "How much earlier Helius' early stream (transactions as the block's leader executes them) had the watched traders' transactions than the stream we act on today. One short measuring run with a fixed credit budget; nothing is traded on it. coveredPct: the share of the traders' transactions the early stream had at all. leadMs: how many ms earlier (negative: later).",
    state,
    creditsUsed: s.credits,
    creditsBudget: CREDITS,
    minutesListened: Math.round(s.listenedMs / 6000) / 10,
    messages: s.msgs,
    slots: s.slots,
    unread: s.unread,
    byStatus: s.byStatus,
    traderTx: s.signerTx,
    paired: s.paired,
    coveredPct: s.signerTx ? Math.round((Math.min(s.paired, s.signerTx) / s.signerTx) * 100) : null,
    earlierPct: s.leads.length ? Math.round((first.length / s.leads.length) * 100) : null,
    leadMsP25: pct(s.leads, 0.25),
    leadMsMedian: pct(s.leads, 0.5),
    leadMsP75: pct(s.leads, 0.75),
    leadMsP90: pct(s.leads, 0.9),
  };
}

export const _test = { blank };
