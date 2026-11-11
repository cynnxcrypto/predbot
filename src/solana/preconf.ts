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
 *
 * Run 2 (12 Nov 2026 01:40 KST). The first minutes of run 1 could read the id of only 3 of 58 messages: the reader
 * knew the old layout of a transaction (signatures first) and not the new one (version 1, SIMD-0385: the message
 * first, the signatures at the end). Both are read now, each kind is counted, and a message that still cannot be
 * read is counted by its first byte so the next look says why. Only successful transactions are asked for (the
 * stream we act on carries no failed ones, and 26 of the 58 were failed: each cost credits and could never be
 * paired). A state file of run 1 is not carried on: run 2 starts with its own budget.
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

export const RUN = 2;
export type Kind = "old" | "v1" | "other";
export interface Early {
  slot: number;
  status: "failed" | "success" | "unknown";
  sig: string | null;
  /** the layout the transaction came in: old (legacy and version 0), v1, or one this reader does not know */
  kind: Kind;
  /** the first byte of the transaction, kept only for a layout that could not be read */
  first?: number;
}
/** One message of the early stream: a version byte, the slot, the place in the block, a status, then the transaction as sent. */
export function decodeFrame(b: Uint8Array): Early | null {
  if (b.length < 18 + 66 || b[0] !== 1) return null;
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const slot = Number(buf.readBigUInt64LE(1));
  const status = b[17] === 0 ? "failed" : b[17] === 1 ? "success" : "unknown";
  const n = b[18];
  // legacy and version 0 transactions begin with the count of signatures (one byte below 128) and then the
  // signatures; the first one is the transaction's id.
  if (n >= 1 && n <= 16 && b.length >= 19 + 64 * n) return { slot, status, sig: base58(buf.subarray(19, 19 + 64)), kind: "old" };
  // version 1 (SIMD-0385) begins with the byte 129, then the count of signatures; the signatures are the last
  // 64 bytes each of the transaction, the fee payer's first. Before them come at least 42 bytes of message.
  if (n === 129) {
    const k = b[19];
    const at = b.length - 64 * k;
    if (k >= 1 && k <= 12 && at >= 18 + 42) return { slot, status, sig: base58(buf.subarray(at, at + 64)), kind: "v1" };
  }
  // anything else is counted as unread, never guessed. (A wrong reading could not make a false pair either: an
  // id is 64 bytes, and it only counts when the processed stream shows the very same one.)
  return { slot, status, sig: null, kind: "other", first: n };
}

interface Saved {
  /** which run wrote this (see RUN) */
  run: number;
  /** messages by the layout of their transaction, and how many of each were paired */
  kinds: Record<Kind, number>;
  pairedKinds: Record<Kind, number>;
  /** frames that were no message at all (another framing version, or too short) */
  badFrames: number;
  /** unread messages by the first byte of their transaction (at most FIRST_KEPT different ones) */
  firstBytes: Record<string, number>;
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
const FIRST_KEPT = 12;
const blank = (): Saved => ({ run: RUN, kinds: { old: 0, v1: 0, other: 0 }, pairedKinds: { old: 0, v1: 0, other: 0 }, badFrames: 0, firstBytes: {}, credits: 0, msgs: 0, slots: 0, unread: 0, byStatus: { failed: 0, success: 0, unknown: 0 }, signerTx: 0, leads: [], paired: 0, listenedMs: 0, done: false });

/** The books of one run: what it has cost, and the pairs. Pure, so it can be tested without a socket. */
export function makeProbe(budget = CREDITS, from: Saved = blank()) {
  const s = from;
  const early = new Map<string, { at: number; kind: Kind }>();
  const processed = new Map<string, number>();
  const perSlot = new Map<number, number>();
  const bound = (m: Map<unknown, unknown>, n: number) => {
    if (m.size > n) for (const k of [...m.keys()].slice(0, m.size - n)) m.delete(k);
  };
  const pair = (lead: number, kind: Kind) => {
    s.paired++;
    s.pairedKinds[kind]++;
    s.leads.push(Math.round(lead));
    if (s.leads.length > LEADS_KEPT) s.leads.shift();
  };
  return {
    state: s,
    /** a message of the early stream; returns false once the budget is spent */
    onEarly(m: { slot: number; status: "failed" | "success" | "unknown"; sig: string | null; kind?: Kind; first?: number }, now: number): boolean {
      const kind = m.kind ?? (m.sig ? "old" : "other");
      s.msgs++;
      s.byStatus[m.status]++;
      s.kinds[kind]++;
      if (!m.sig && m.first !== undefined && (String(m.first) in s.firstBytes || Object.keys(s.firstBytes).length < FIRST_KEPT)) s.firstBytes[String(m.first)] = (s.firstBytes[String(m.first)] ?? 0) + 1;
      const n = (perSlot.get(m.slot) ?? 0) + 1;
      perSlot.set(m.slot, n);
      if (n === 1) {
        s.slots++;
        s.credits += SLOT_MIN_CREDITS;
      } else if (n * MSG_CREDITS > SLOT_MIN_CREDITS) s.credits += MSG_CREDITS;
      bound(perSlot, 256);
      if (!m.sig) s.unread++;
      else if (!early.has(m.sig)) {
        early.set(m.sig, { at: now, kind });
        bound(early, PAIR_KEPT);
        const p = processed.get(m.sig);
        if (p !== undefined) {
          processed.delete(m.sig);
          pair(p - now, kind); // the processed stream had it first
        }
      }
      if (s.credits >= budget) s.done = true;
      return !s.done;
    },
    /** the same transaction on the processed stream (only those signed by a watched trader are passed in) */
    onProcessed(sig: string, now: number) {
      s.signerTx++;
      const e = early.get(sig);
      if (e !== undefined) return pair(now - e.at, e.kind);
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
    // successful ones only: the stream we act on carries no failed transactions, so a failed one could never be
    // paired and would only cost credits (26 of the first 58 messages were failed)
    s.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "preconfSubscribe", params: [{ signerInclude: signers, failed: false }] }));
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
    if (!f) return void probe.state.badFrames++;
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
    const was = JSON.parse(readFileSync(FILE(), "utf8")) as Saved;
    // a file of an earlier run is not carried on: that run could not read most of what it was sent
    probe = makeProbe(CREDITS, was.run === RUN ? { ...blank(), ...was } : blank());
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
    note: "How much earlier Helius' early stream (transactions as the block's leader executes them) had the watched traders' transactions than the stream we act on today. One short measuring run with a fixed credit budget; nothing is traded on it. coveredPct: the share of the traders' transactions the early stream had at all. leadMs: how many ms earlier (negative: later). byLayout: messages by the layout of their transaction (old = legacy and version 0, v1 = the new one) and how many of each were paired; unreadFirstBytes: messages whose id could not be read, by the first byte of the transaction.",
    state,
    run: s.run,
    byLayout: { messages: s.kinds, paired: s.pairedKinds },
    badFrames: s.badFrames,
    unreadFirstBytes: s.firstBytes,
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
