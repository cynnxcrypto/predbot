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
  /** Ticks that came from the REST fallback rather than the stream. */
  polled = 0;
  private socket: WebSocket | null = null;
  private backoff = 1000;
  private closed = false;
  private readonly url: string;
  private readonly onOpen: (send: (text: string) => void) => void;
  private readonly onText: (text: string, push: (t: number, price: number) => void, send: (text: string) => void) => void;
  private readonly keepMs: number;
  /** Optional REST fallback: polled while the websocket is silent (some hosts block the stream but not the REST endpoint). */
  private readonly poll: { url: string; everyMs: number; parse: (body: unknown) => Tick | null } | null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: {
    name: string;
    url: string;
    onOpen?: (send: (text: string) => void) => void;
    onText: (text: string, push: (t: number, price: number) => void, send: (text: string) => void) => void;
    keepMs?: number;
    poll?: { url: string; everyMs: number; parse: (body: unknown) => Tick | null };
  }) {
    this.name = opts.name;
    this.url = opts.url;
    this.onOpen = opts.onOpen ?? (() => undefined);
    this.onText = opts.onText;
    this.keepMs = opts.keepMs ?? 12 * 60 * 1000;
    this.poll = opts.poll ?? null;
  }

  start() {
    this.closed = false;
    this.connect();
    if (this.poll && !this.pollTimer) {
      const poll = this.poll;
      this.pollTimer = setInterval(() => {
        if (this.closed || Date.now() - this.lastAt < 10000) return;
        fetch(poll.url)
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
          .then((body) => {
            const tick = poll.parse(body);
            if (tick) {
              this.push(tick.t, tick.price);
              this.polled += 1;
            }
          })
          .catch(() => {
            this.errors += 1;
          });
      }, poll.everyMs);
    }
    return this;
  }

  stop() {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
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
    return (this.socket?.readyState === WebSocket.OPEN || this.poll != null) && Date.now() - this.lastAt < 20000;
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
