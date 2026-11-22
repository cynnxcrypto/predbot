/**
 * FASTER COPIES: Hyperliquid's public trade feed (enrique, 22 Nov 2026: "is there any workaround hyperliquid entries
 * and exits being up to a minute late?").
 *
 * Until now a followed trader was looked at once a minute (the rest of the list every 3 to 4 minutes), and a real copy
 * acted at its next 20-second look: up to about 80 seconds after the trader. Hyperliquid's websocket can follow the
 * fills of only a few users from one address (10 unique users across user subscriptions, by its published limits),
 * far fewer than the 400 we follow. But its public TRADE feed names both sides of every trade (users: [buyer, seller]).
 * So the trades of every perp are followed (one subscription a coin, about 230 of the 1,000 allowed, PER_SOCKET a
 * connection), and a trade by a followed trader has that trader looked at within seconds (src/solana/buckets.ts
 * hlPoke), and the real side acts at once. The minute's round stays as the fallback.
 *
 * It also MEASURES the delay: from the first trade of the trader's burst on that coin (BURST_GAP_MS apart at most) to
 * the moment a paper copy opened or closed (by which path), and to the moment our real copy opened or closed.
 * deploy/live-rules.json hyperliquid.watch: { "on": true, "fast": true }. on = the feed runs and measures; fast = it
 * also starts the fast looks. Read-only: it signs and sends nothing.
 */

export const WS_URL = "wss://api.hyperliquid.xyz/ws";
export const PER_SOCKET = 100;
export const BURST_GAP_MS = 120_000;
/** a burst that started longer ago than this is not used for a delay (the trade was not seen, or it is not this one) */
export const BURST_MAX_MS = 15 * 60_000;
const PING_MS = 30_000;
const SILENT_MS = 90_000;
const KEEP_DELAYS = 300;
const COINS_EVERY_MS = 6 * 3_600_000;

export type DelayKind = "paperOpen" | "paperClose" | "realOpen" | "realClose";
interface Sock {
  readyState: number;
  send(text: string): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
}
export interface WatchOpts {
  /** the perps' names */
  coins(): Promise<string[]>;
  /** the addresses followed now, lower case */
  watched(): Set<string>;
  /** a followed trader traded (at the trade's own time) */
  onHit(addr: string, coin: string, t: number): void;
  /** short name of a trader (copy-xxxxxxxx) */
  rule(addr: string): string;
  open?(url: string): Sock;
  now?(): number;
}
interface Conn {
  coins: string[];
  sock: Sock | null;
  backoff: number;
  lastAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class HlTradeWatch {
  private conns: Conn[] = [];
  private stopped = true;
  private ping: ReturnType<typeof setInterval> | null = null;
  private coinTimer: ReturnType<typeof setInterval> | null = null;
  private coinList: string[] = [];
  private px = new Map<string, { px: number; t: number }>();
  private bursts = new Map<string, { start: number; last: number }>();
  private delays = new Map<string, number[]>();
  /** counts by second, the last 60 seconds */
  private secs = new Map<number, { trades: number; hits: number }>();
  stats = { connects: 0, errors: 0, trades: 0, hits: 0, unknownDelay: 0, startedAt: 0, lastMsgAt: 0 };
  constructor(private readonly o: WatchOpts) {}
  private now = () => (this.o.now ? this.o.now() : Date.now());

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.stats.startedAt = this.now();
    await this.connectAll();
    this.ping = setInterval(() => this.keepAlive(), PING_MS);
    this.ping.unref?.();
    this.coinTimer = setInterval(() => void this.refreshCoins().catch(() => undefined), COINS_EVERY_MS);
    this.coinTimer.unref?.();
  }
  stop() {
    this.stopped = true;
    if (this.ping) clearInterval(this.ping);
    if (this.coinTimer) clearInterval(this.coinTimer);
    this.ping = this.coinTimer = null;
    for (const c of this.conns) this.drop(c);
    this.conns = [];
  }
  get running() {
    return !this.stopped;
  }
  private async connectAll() {
    const coins = await this.o.coins().catch(() => [] as string[]);
    if (!coins.length) {
      this.stats.errors++;
      // no coin list: try again in a minute
      const t = setTimeout(() => void (this.stopped || this.conns.length ? undefined : this.connectAll()), 60_000);
      t.unref?.();
      return;
    }
    this.coinList = [...coins];
    for (let i = 0; i < coins.length; i += PER_SOCKET) {
      const c: Conn = { coins: coins.slice(i, i + PER_SOCKET), sock: null, backoff: 1_000, lastAt: this.now(), timer: null };
      this.conns.push(c);
      this.connect(c);
    }
  }
  /** New coins listed: all connections are made again with the new list. */
  private async refreshCoins() {
    const coins = await this.o.coins();
    if (!coins.length || (coins.length === this.coinList.length && coins.every((x, i) => x === this.coinList[i]))) return;
    for (const c of this.conns) this.drop(c);
    this.conns = [];
    await this.connectAll();
  }
  private drop(c: Conn) {
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    const s = c.sock;
    c.sock = null;
    if (s) {
      s.onclose = s.onerror = s.onmessage = s.onopen = null;
      try {
        s.close();
      } catch {
        // already closed
      }
    }
  }
  private connect(c: Conn) {
    if (this.stopped) return;
    let s: Sock;
    try {
      s = this.o.open ? this.o.open(WS_URL) : (new WebSocket(WS_URL) as unknown as Sock);
    } catch {
      this.stats.errors++;
      return this.retry(c);
    }
    c.sock = s;
    s.onopen = () => {
      this.stats.connects++;
      c.backoff = 1_000;
      c.lastAt = this.now();
      for (const coin of c.coins) s.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin } }));
    };
    s.onmessage = (e) => {
      c.lastAt = this.now();
      if (typeof e.data === "string") this.handle(e.data);
    };
    s.onerror = () => void this.stats.errors++;
    s.onclose = () => {
      if (c.sock !== s) return;
      c.sock = null;
      this.retry(c);
    };
  }
  private retry(c: Conn) {
    if (this.stopped || c.timer) return;
    c.timer = setTimeout(() => {
      c.timer = null;
      this.connect(c);
    }, c.backoff);
    c.timer.unref?.();
    c.backoff = Math.min(c.backoff * 2, 30_000);
  }
  /** a ping on every open connection; one silent too long is made again */
  keepAlive() {
    const now = this.now();
    for (const c of this.conns) {
      if (!c.sock) continue;
      if (now - c.lastAt > SILENT_MS) {
        this.drop(c);
        this.retry(c);
        continue;
      }
      if (c.sock.readyState === 1) c.sock.send(JSON.stringify({ method: "ping" }));
    }
  }

  /** One message from the feed. */
  handle(text: string) {
    const now = this.now();
    this.stats.lastMsgAt = now;
    let m: { channel?: string; data?: unknown };
    try {
      m = JSON.parse(text) as typeof m;
    } catch {
      return;
    }
    if (m.channel !== "trades" || !Array.isArray(m.data)) return;
    const watched = this.o.watched();
    for (const x of m.data as { coin?: unknown; px?: unknown; time?: unknown; users?: unknown }[]) {
      const coin = typeof x?.coin === "string" ? x.coin : "";
      const px = Number(x?.px);
      const t = Number(x?.time);
      if (!coin || !(t > 0)) continue;
      this.stats.trades++;
      this.sec(now).trades++;
      if (px > 0) this.px.set(coin, { px, t: now });
      if (!Array.isArray(x.users)) continue;
      for (const u0 of x.users) {
        const u = typeof u0 === "string" ? u0.toLowerCase() : "";
        if (!watched.has(u)) continue;
        this.stats.hits++;
        this.sec(now).hits++;
        const k = `${u}|${coin}`;
        const b = this.bursts.get(k);
        if (!b || t - b.last > BURST_GAP_MS) this.bursts.set(k, { start: t, last: t });
        else b.last = Math.max(b.last, t);
        this.o.onHit(u, coin, t);
      }
    }
    if (this.bursts.size > 20_000) for (const [k, b] of this.bursts) if (now - b.last > BURST_MAX_MS) this.bursts.delete(k);
  }
  private sec(now: number) {
    const k = Math.floor(now / 1000);
    let c = this.secs.get(k);
    if (!c) {
      c = { trades: 0, hits: 0 };
      this.secs.set(k, c);
      for (const old of this.secs.keys()) if (old <= k - 60) this.secs.delete(old);
    }
    return c;
  }
  private lastMinute(now: number) {
    const k = Math.floor(now / 1000);
    let trades = 0;
    let hits = 0;
    for (const [s, c] of this.secs) if (s > k - 60) (trades += c.trades), (hits += c.hits);
    return { trades, hits };
  }
  /** The last trade price of a coin, when it is fresh (30 s). */
  price(coin: string): number | null {
    const p = this.px.get(coin);
    return p && this.now() - p.t < 30_000 ? p.px : null;
  }
  /** Something of ours happened for a trader's coin now: the delay from the first trade of its last burst. */
  note(kind: DelayKind, addr: string, coin: string, src: "poll" | "feed" | "real") {
    const b = this.bursts.get(`${addr.toLowerCase()}|${coin}`);
    const now = this.now();
    if (!b || now - b.start > BURST_MAX_MS) {
      this.stats.unknownDelay++;
      return;
    }
    const k = `${kind}|${src}`;
    const xs = this.delays.get(k) ?? [];
    xs.push(Math.max(0, now - b.start));
    this.delays.set(k, xs.slice(-KEEP_DELAYS));
  }
  /** The same, by the trader's short name (the real side knows only that). */
  noteRule(kind: DelayKind, rule: string, coin: string) {
    for (const a of this.o.watched()) if (this.o.rule(a) === rule) return this.note(kind, a, coin, "real");
    this.stats.unknownDelay++;
  }
  /** For the status: no address. Delays in seconds. */
  summary(extra: Record<string, unknown> = {}) {
    const now = this.now();
    const m = this.lastMinute(now);
    const q = (xs: number[], f: number) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(f * s.length))] / 100) / 10 : null;
    };
    const delays: Record<string, { n: number; medianS: number | null; p90S: number | null }> = {};
    for (const [k, xs] of [...this.delays.entries()].sort()) delays[k] = { n: xs.length, medianS: q(xs, 0.5), p90S: q(xs, 0.9) };
    return {
      running: this.running,
      connections: this.conns.length,
      open: this.conns.filter((c) => c.sock && c.sock.readyState === 1).length,
      coins: this.coinList.length,
      tradesLastMinute: m.trades,
      ourTradersLastMinute: m.hits,
      lastMessageAgoS: this.stats.lastMsgAt ? Math.round((now - this.stats.lastMsgAt) / 1000) : null,
      ...this.stats,
      delays,
      ...extra,
    };
  }
}
