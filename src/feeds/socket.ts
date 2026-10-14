/**
 * A websocket that stays up: reconnects with backoff, pings, and reports its health.
 * Node 22 has a global WebSocket, so no dependency is needed.
 */
export type Tick = { t: number; price: number };

export class Feed {
  readonly name: string;
  ticks: Tick[] = [];
  lastAt = 0;
  connects = 0;
  errors = 0;
  private socket: WebSocket | null = null;
  private backoff = 1000;
  private closed = false;
  private readonly url: string;
  private readonly onOpen: (send: (text: string) => void) => void;
  private readonly onText: (text: string, push: (t: number, price: number) => void, send: (text: string) => void) => void;
  private readonly keepMs: number;

  constructor(opts: {
    name: string;
    url: string;
    onOpen?: (send: (text: string) => void) => void;
    onText: (text: string, push: (t: number, price: number) => void, send: (text: string) => void) => void;
    keepMs?: number;
  }) {
    this.name = opts.name;
    this.url = opts.url;
    this.onOpen = opts.onOpen ?? (() => undefined);
    this.onText = opts.onText;
    this.keepMs = opts.keepMs ?? 12 * 60 * 1000;
  }

  start() {
    this.closed = false;
    this.connect();
    return this;
  }

  stop() {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }

  /** The newest tick, or null if the feed has been silent for longer than staleMs. */
  last(staleMs = 15000): Tick | null {
    const tick = this.ticks[this.ticks.length - 1];
    return tick && Date.now() - tick.t <= staleMs ? tick : null;
  }

  /** Ticks with t in [fromMs, toMs]. */
  between(fromMs: number, toMs: number): Tick[] {
    return this.ticks.filter((tick) => tick.t >= fromMs && tick.t <= toMs);
  }

  /** The last tick at or before atMs, if any. */
  at(atMs: number): Tick | null {
    let best: Tick | null = null;
    for (const tick of this.ticks) {
      if (tick.t <= atMs) best = tick;
      else break;
    }
    return best;
  }

  healthy() {
    return this.socket?.readyState === WebSocket.OPEN && Date.now() - this.lastAt < 20000;
  }

  private push = (t: number, price: number) => {
    if (!Number.isFinite(t) || !Number.isFinite(price) || price <= 0) return;
    this.lastAt = Date.now();
    const last = this.ticks[this.ticks.length - 1];
    if (last && t < last.t) return;
    if (last && last.t === t) {
      last.price = price;
      return;
    }
    this.ticks.push({ t, price });
    if (this.ticks.length > 20000) {
      const cutoff = Date.now() - this.keepMs;
      this.ticks = this.ticks.filter((tick) => tick.t >= cutoff);
    }
  };

  private send = (text: string) => {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(text);
  };

  private connect() {
    if (this.closed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.errors += 1;
      this.retry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.connects += 1;
      this.backoff = 1000;
      this.onOpen(this.send);
    };
    socket.onmessage = (event) => {
      const text = typeof event.data === "string" ? event.data : "";
      if (!text) return;
      try {
        this.onText(text, this.push, this.send);
      } catch {
        this.errors += 1;
      }
    };
    socket.onerror = () => {
      this.errors += 1;
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.retry();
    };
  }

  private retry() {
    if (this.closed) return;
    const wait = this.backoff;
    this.backoff = Math.min(30000, this.backoff * 2);
    setTimeout(() => this.connect(), wait);
  }
}
