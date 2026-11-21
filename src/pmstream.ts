/**
 * Polymarket's live trade stream (16 Nov 2026, enrique: "any way we can buy quicker after they do? buying minutes
 * after sounds off af", "if there's any apis that help with ... knowing faster so we can act faster do it").
 *
 * The wallet copies read each copied wallet's activity from the data API every 15 s, one wallet after another, so a
 * buy reached us 7-15 s after it happened for the real wallets (median per wallet in the status snapshots of 12-16
 * Nov) and 20-80 s for the rescan's paper wallets. Polymarket's real-time data socket (the one its site uses) pushes
 * every trade on the exchange as it happens, with the trading wallet (proxyWallet) in each message. This keeps that
 * socket open, picks out the trades of the wallets we copy, and hands them to the copy code at once. The 15 s reading
 * stays as the backstop, and both say which of them saw each buy first, so the gain is measured, not assumed.
 *
 * No key, no cost. Nothing here trades: it only tells eventpaper.ts sooner.
 */
const URL = "wss://ws-live-data.polymarket.com";

/** One trade as the copy code reads it (the data API's activity row shape). */
export type StreamRow = {
  type: "TRADE";
  side: string;
  price: number;
  size: number;
  usdc_size: number;
  timestamp: number;
  condition_id: string;
  outcome_index: number;
  outcome: string;
  title: string;
  /** the outcome token traded; the copy code checks it against Gamma's token for outcome_index */
  asset?: string;
};

/** A message of the socket's activity/trades topic as a copy row, or null when it is not a usable trade. */
export function streamRow(msg: unknown): { wallet: string; row: StreamRow } | null {
  const m = msg as { topic?: string; type?: string; payload?: Record<string, unknown> };
  // trades only: orders_matched is neither subscribed nor known to give each wallet its own side (MAIN review)
  if (!m || m.topic !== "activity" || m.type !== "trades") return null;
  const p = m.payload ?? {};
  const wallet = String(p.proxyWallet ?? "").toLowerCase();
  const cond = String(p.conditionId ?? "");
  const idx = Number(p.outcomeIndex);
  const price = Number(p.price);
  const size = Number(p.size);
  let ts = Number(p.timestamp);
  if (ts > 1e12) ts = Math.floor(ts / 1000);
  if (!/^0x[0-9a-f]{40}$/.test(wallet) || !/^0x[0-9a-fA-F]{64}$/.test(cond) || !(idx === 0 || idx === 1) || !(price > 0 && price < 1) || !(size > 0) || !(ts > 0)) return null;
  return { wallet, row: { type: "TRADE", side: String(p.side ?? "").toUpperCase(), price, size, usdc_size: Math.round(price * size * 1e6) / 1e6, timestamp: ts, condition_id: cond, outcome_index: idx, outcome: String(p.outcome ?? ""), title: String(p.title ?? ""), ...(p.asset != null && String(p.asset) !== "" ? { asset: String(p.asset) } : {}) } };
}

type Handler = (wallet: string, rows: StreamRow[], seenMs: number) => void;

/** Fills of one order arrive as several messages: gather a wallet's rows this long, then hand them over together. */
export const GATHER_MS = 1200;

const health = { on: false, up: false, connects: 0, reopened: 0, msgs: 0, trades: 0, matched: 0, handed: 0, errors: 0, lastMsgAt: 0, lastTradeAt: 0, lastMatchAt: 0, lastError: "" };
let sock: WebSocket | null = null;
let watched = (): Set<string> => new Set();
let handler: Handler | null = null;
/** Every trade on the exchange, whoever made it (the rescan's tally of active wallets, src/copyseen.ts). */
let tap: ((wallet: string, row: StreamRow) => void) | null = null;
export const setTradeTap = (f: typeof tap) => void (tap = f);
const pending = new Map<string, { rows: StreamRow[]; firstMs: number; timer: ReturnType<typeof setTimeout> }>();
let backoff = 1000;
let pinger: ReturnType<typeof setInterval> | null = null;

function take(text: string) {
  health.msgs++;
  health.lastMsgAt = Date.now();
  if (text === "ping") {
    try {
      sock?.send("pong");
    } catch {
      /* closed */
    }
    return;
  }
  if (text === "pong" || !text.startsWith("{")) return;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return;
  }
  const got = streamRow(body);
  if (!got) return;
  health.trades++;
  health.lastTradeAt = Date.now();
  if (tap) {
    try {
      tap(got.wallet, got.row);
    } catch {
      /* the tally must never stop the copies */
    }
  }
  if (!watched().has(got.wallet)) return;
  health.matched++;
  health.lastMatchAt = Date.now();
  const p = pending.get(got.wallet);
  if (p) {
    p.rows.push(got.row);
    return;
  }
  const firstMs = Date.now();
  pending.set(got.wallet, {
    rows: [got.row],
    firstMs,
    timer: setTimeout(() => {
      const x = pending.get(got.wallet);
      pending.delete(got.wallet);
      if (!x || !handler) return;
      health.handed++;
      try {
        handler(got.wallet, x.rows, x.firstMs);
      } catch (e) {
        health.errors++;
        health.lastError = String((e as Error).message).slice(0, 80);
      }
    }, GATHER_MS),
  });
}

/** Drop the current socket without waiting for its close (a silent peer may never send one) and open a new one. */
function reopen(why: string) {
  const old = sock;
  sock = null;
  health.up = false;
  health.reopened++;
  health.lastError = why;
  if (old) {
    old.onopen = old.onmessage = old.onerror = old.onclose = null;
    try {
      old.close();
    } catch {
      /* ignore */
    }
  }
  setTimeout(connect, 1000);
}

function connect() {
  if (!health.on || sock) return;
  try {
    sock = new WebSocket(URL);
  } catch (e) {
    health.errors++;
    health.lastError = String((e as Error).message).slice(0, 80);
    setTimeout(connect, (backoff = Math.min(backoff * 2, 60_000)));
    return;
  }
  sock.onopen = () => {
    health.up = true;
    health.connects++;
    backoff = 1000;
    health.lastTradeAt = Date.now(); // the silence clock starts at the open
    sock?.send(JSON.stringify({ action: "subscribe", subscriptions: [{ topic: "activity", type: "trades" }] }));
  };
  sock.onmessage = (ev) => take(typeof ev.data === "string" ? ev.data : String(ev.data));
  sock.onerror = () => {
    health.errors++;
    health.lastError = "socket error";
  };
  const me = sock;
  sock.onclose = () => {
    if (sock !== me) return;
    health.up = false;
    sock = null;
    if (health.on) setTimeout(connect, (backoff = Math.min(backoff * 2, 60_000)));
  };
}

/**
 * Start the stream. `watch` returns the lower-case wallet addresses whose trades we want; `onRows` gets each wallet's
 * gathered rows and the time we first saw them. PMSTREAM=off leaves it off (the 15 s reading then does it all).
 */
export function startTradeStream(watch: () => Set<string>, onRows: Handler) {
  if (process.env.PMSTREAM === "off" || health.on) return;
  watched = watch;
  handler = onRows;
  health.on = true;
  connect();
  // The socket wants a ping every few seconds; a silent minute means it is dead, so it is opened again.
  // Silence is measured by trades, not pings: the exchange-wide topic carries trades every few seconds, so a minute
  // without one means the subscription or the link is dead (MAIN review). A socket stuck opening or closing is replaced too.
  pinger = setInterval(() => {
    if (!health.on) return;
    if (!sock) return;
    if (sock.readyState === 1) {
      try {
        sock.send("ping");
      } catch {
        /* handled below */
      }
    }
    if (health.lastTradeAt && Date.now() - health.lastTradeAt > 60_000) reopen("no trade for a minute, reopened");
  }, 5000);
  pinger.unref?.();
}

/** Public line: counts only, no addresses. */
export function tradeStreamStatus() {
  const now = Date.now();
  return { ...health, lastMsgSecAgo: health.lastMsgAt ? Math.round((now - health.lastMsgAt) / 1000) : null, lastTradeSecAgo: health.lastTradeAt ? Math.round((now - health.lastTradeAt) / 1000) : null, lastMatchMinAgo: health.lastMatchAt ? Math.round((now - health.lastMatchAt) / 60_000) : null, lastMsgAt: undefined, lastTradeAt: undefined, lastMatchAt: undefined };
}
