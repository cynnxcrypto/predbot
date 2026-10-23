/**
 * Polymarket's market websocket: order books pushed as they change, instead of polled over HTTP.
 *
 * One socket carries every token the recorders care about. A `book` event replaces a token's book, a
 * `price_change` event updates one price level (size 0 removes it). `book()` in polymarket.ts reads this
 * cache first and only falls back to the HTTP endpoint when the cache is missing or stale, so callers
 * did not change. Every 30s the cache is cross-checked against HTTP so a missed delta cannot linger.
 *
 * When the watched set changes (a new window lists), the socket sends a subscribe for the new tokens; if
 * no snapshot arrives for them within a few seconds it reconnects with the full set, which works on
 * either protocol version.
 */
import type { Book, Level } from "../polymarket.js";

const URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

type Side = Map<number, number>; // price -> size (shares)
type Entry = { bids: Side; asks: Side; at: number; updates: number };

function top(side: Side, order: "bid" | "ask"): Level[] {
  const rows = [...side.entries()].filter(([price, size]) => price > 0 && price < 1 && size > 0).map(([price, size]) => ({ price, size }));
  rows.sort((a, b) => (order === "ask" ? a.price - b.price : b.price - a.price));
  return rows.slice(0, 10);
}

export function makeBook(bids: Level[], asks: Level[]): Book {
  return {
    bids,
    asks,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    bidDepth: Math.round(bids.reduce((sum, row) => sum + row.size, 0)),
    askDepth: Math.round(asks.reduce((sum, row) => sum + row.size, 0)),
  };
}

export class BookFeed {
  private socket: WebSocket | null = null;
  private books = new Map<string, Entry>();
  private watched = new Set<string>();
  private listeners = new Set<(tokenId: string) => void>();
  private backoff = 1000;
  private closed = true;
  private pinger: NodeJS.Timeout | null = null;
  private pendingSince = new Map<string, number>();
  connects = 0;
  errors = 0;
  events = 0;
  lastAt = 0;

  /** Tokens whose books should stream. Call again whenever the set changes. */
  watch(tokenIds: string[], connect = true) {
    const next = new Set(tokenIds.filter(Boolean));
    const added = [...next].filter((id) => !this.watched.has(id));
    for (const id of this.watched) if (!next.has(id)) this.books.delete(id);
    this.watched = next;
    if (!connect) return;
    if (this.closed) {
      this.closed = false;
      this.connect();
      return;
    }
    if (!added.length) return;
    for (const id of added) this.pendingSince.set(id, Date.now());
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ assets_ids: added, type: "market", operation: "subscribe" }));
  }

  stop() {
    this.closed = true;
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
    this.socket?.close();
    this.socket = null;
  }

  /** The cached book, or null when the socket has nothing fresh enough. */
  get(tokenId: string, maxAgeMs = 3000): (Book & { at: number }) | null {
    if (!this.connected()) return null;
    return this.peek(tokenId, maxAgeMs);
  }

  /** The cached book regardless of the socket's state (for the status page and tests). */
  peek(tokenId: string, maxAgeMs = 3000): (Book & { at: number }) | null {
    const entry = this.books.get(tokenId);
    if (!entry || Date.now() - entry.at > maxAgeMs) return null;
    return { ...makeBook(top(entry.bids, "bid"), top(entry.asks, "ask")), at: entry.at };
  }

  /** Replace a token's cached book with a fresh HTTP read (the periodic cross-check). */
  reset(tokenId: string, bids: Level[], asks: Level[]) {
    if (!this.watched.has(tokenId)) return;
    const entry: Entry = { bids: new Map(bids.map((l) => [l.price, l.size])), asks: new Map(asks.map((l) => [l.price, l.size])), at: Date.now(), updates: this.books.get(tokenId)?.updates ?? 0 };
    this.books.set(tokenId, entry);
  }

  /** Called with the token id after every change to a watched book. */
  onUpdate(listener: (tokenId: string) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  connected() {
    return this.socket?.readyState === WebSocket.OPEN && Date.now() - this.lastAt < 30000;
  }

  status() {
    return { connected: this.connected(), watching: this.watched.size, cached: this.books.size, events: this.events, connects: this.connects, errors: this.errors, lastAt: this.lastAt || null };
  }

  private connect() {
    if (this.closed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(URL);
    } catch {
      this.errors += 1;
      this.retry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.connects += 1;
      this.backoff = 1000;
      this.lastAt = Date.now();
      this.pendingSince.clear();
      for (const id of this.watched) this.pendingSince.set(id, Date.now());
      if (this.watched.size) socket.send(JSON.stringify({ assets_ids: [...this.watched], type: "market" }));
      if (this.pinger) clearInterval(this.pinger);
      this.pinger = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send("PING");
        // A token subscribed on the fly that never got its snapshot: resubscribe everything on a fresh socket.
        const stuck = [...this.pendingSince.values()].some((since) => Date.now() - since > 5000);
        if (stuck && this.socket === socket) socket.close();
      }, 5000);
    };
    socket.onmessage = (event) => {
      const text = typeof event.data === "string" ? event.data : "";
      if (!text || text === "PONG") return;
      this.lastAt = Date.now();
      try {
        const body = JSON.parse(text) as unknown;
        for (const item of Array.isArray(body) ? body : [body]) this.handle(item);
      } catch {
        this.errors += 1;
      }
    };
    socket.onerror = () => {
      this.errors += 1;
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      if (this.pinger) clearInterval(this.pinger);
      this.pinger = null;
      this.retry();
    };
  }

  private retry() {
    if (this.closed) return;
    const wait = this.backoff;
    this.backoff = Math.min(30000, this.backoff * 2);
    setTimeout(() => this.connect(), wait);
  }

  /** Apply one websocket event (public so the parsing can be tested without a socket). */
  handle(item: unknown) {
    if (!item || typeof item !== "object") return;
    const ev = item as {
      event_type?: string;
      asset_id?: string;
      bids?: { price: string; size: string }[];
      asks?: { price: string; size: string }[];
      changes?: { price: string; size: string; side: string }[];
      price_changes?: { asset_id: string; price: string; size: string; side: string }[];
    };
    if (ev.event_type === "book" && ev.asset_id) {
      if (!this.watched.has(ev.asset_id)) return;
      const bids: Side = new Map();
      const asks: Side = new Map();
      for (const l of ev.bids ?? []) bids.set(Number(l.price), Number(l.size));
      for (const l of ev.asks ?? []) asks.set(Number(l.price), Number(l.size));
      const prev = this.books.get(ev.asset_id);
      this.books.set(ev.asset_id, { bids, asks, at: Date.now(), updates: (prev?.updates ?? 0) + 1 });
      this.pendingSince.delete(ev.asset_id);
      this.events += 1;
      this.emit(ev.asset_id);
      return;
    }
    if (ev.event_type === "price_change") {
      const changes = ev.price_changes ?? (ev.asset_id ? (ev.changes ?? []).map((c) => ({ ...c, asset_id: ev.asset_id as string })) : []);
      const touched = new Set<string>();
      for (const c of changes) {
        const entry = this.books.get(c.asset_id);
        if (!entry) continue;
        const side = c.side === "BUY" ? entry.bids : entry.asks;
        const price = Number(c.price);
        const size = Number(c.size);
        if (!(price > 0)) continue;
        if (size > 0) side.set(price, size);
        else side.delete(price);
        entry.at = Date.now();
        entry.updates += 1;
        touched.add(c.asset_id);
      }
      if (touched.size) this.events += 1;
      for (const id of touched) this.emit(id);
    }
  }

  private emit(tokenId: string) {
    for (const listener of this.listeners) {
      try {
        listener(tokenId);
      } catch {
        this.errors += 1;
      }
    }
  }
}

/** The one socket shared by every recorder. */
export const bookFeed = new BookFeed();
