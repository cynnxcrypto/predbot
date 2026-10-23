import { WINDOW_SEC, kstDay } from "./config.js";
import { chainlink } from "./feeds/index.js";
import type { Feed } from "./feeds/socket.js";
import type { BookRow } from "./recorder.js";
import { append, loadJson, saveJson } from "./store.js";

/**
 * Live paper trading of the projection rule, inside the recorder. No order is ever sent.
 *
 * The market settles on the 60s average of the Chainlink feed ending at close, against the 60s
 * average ending at open. From PAPER_LEFT seconds before close, every second: project the closing
 * average (the part of the final minute already seen, plus the current price for the rest), pick the
 * side it favours, and if that side's best ask is at or under PAPER_CAP, "buy" up to PAPER_SIZE
 * dollars from the ask levels actually on the book. One trade per window. Fee 7% * p * (1-p).
 * Settled trades go to data/paper[-variant]/<day>.jsonl; open ones survive a restart in data/paper[-variant]-open.json.
 */
export type Variant = {
  name: string;
  left: number;
  cap: number;
  size: number;
  floor?: number;
  /** Only buy when the ask is at or above the previous second's ask (the crowd is not moving against the side). */
  noFall?: boolean;
  /** Jump guard: skip when the chosen side's ask was below this one second earlier (a book that leaps into the band from far below is usually collapsing). */
  prevFloor?: number;
  /** Early-window long shot: buy whichever side is cheapest, at or under `cap`, within the first `first` seconds of the window (no projection). */
  first?: number;
  /** Favourite rule: buy the higher-priced side the first time its best ask is at or above `favAt`, any time in the window, paying up to `cap` (no projection). */
  favAt?: number;
  /** For favAt: only act between these seconds into the window, measured on a 5-minute window and scaled for longer ones. */
  favFrom?: number;
  favTo?: number;
  /** For favAt: the Chainlink move since open, in the favourite's direction, must be between these (basis points) at the first hit. */
  leadMin?: number;
  leadMax?: number;
  /** For favAt: the favourite's ask must have read at least `holdAt` on each of the previous `holdRows` snapshots of the window. */
  holdRows?: number;
  holdAt?: number;
};

/** The variants run side by side. "base" keeps the original file names; the env vars tune it. */
export const VARIANTS: Variant[] = [
  { name: "base", left: Number(process.env.PAPER_LEFT ?? 30), cap: Number(process.env.PAPER_CAP ?? 0.9), size: Number(process.env.PAPER_SIZE ?? 20) },
  { name: "early45", left: 45, cap: 0.9, size: 20 },
  { name: "late20", left: 20, cap: 0.9, size: 20 },
  { name: "late15", left: 15, cap: 0.9, size: 20 },
  { name: "cheap70", left: 30, cap: 0.7, size: 20 },
  // Only buy when the book already leans the same way (ask 80c to 90c): the one band that was positive on all three recorded days.
  { name: "band80", left: 45, floor: 0.8, cap: 0.9, size: 20 },
  { name: "band80-30", left: 30, floor: 0.8, cap: 0.9, size: 20 },
  // band80-30 with the live fill rule: skip the second the ask fell. In the recorded books this kept 93% of wins.
  { name: "band80-30-chase", left: 30, floor: 0.8, cap: 0.9, size: 20, noFall: true },
  // band80-30 with the jump guard: every real loss up to 23 Oct came from an ask that was under ~70-75c one second before it first read 80-90c.
  { name: "band80-30-j70", left: 30, floor: 0.8, cap: 0.9, size: 20, prevFloor: 0.70 },
  // enrique's long shot (20 Oct): either side under 10c in the first 90s of the window, $5 a trade.
  { name: "cheap10-first90", left: 0, cap: 0.1, size: 5, first: 90 },
  // enrique's favourite rule (21 Oct): buy the favourite the first time its ask reaches 93c, $5. Replay: 2c a trade on BTC 5m, 12-16c on BTC 15m.
  { name: "fav93", left: 0, cap: 0.995, size: 5, favAt: 0.93 },
  // The one slice of the favourite replay that beat the price at every threshold: 93c reached between 2 and 3 minutes in.
  { name: "fav93-mid", left: 0, cap: 0.995, size: 5, favAt: 0.93, favFrom: 120, favTo: 180 },
  // Best pooled long-shot cell of the grid replay: 12c in the first 60s.
  { name: "cheap12-first60", left: 0, cap: 0.12, size: 5, first: 60 },
  // Replay of 4,507 first hits (19-23 Oct, four 5m coins): fav93 wins 93.9% (-2c a trade). Two filters lifted it:
  // a small Chainlink lead of 0-3bp with 3 minutes or less left won 95.9% (+8c), and an ask that had held 90c+ for the
  // previous ten snapshots won 96.4% (+13c, mostly BTC). Paper only, to see if either survives out of sample.
  { name: "fav93-lead", left: 0, cap: 0.995, size: 5, favAt: 0.93, favFrom: 120, leadMin: 0, leadMax: 3 },
  { name: "fav93-hold", left: 0, cap: 0.995, size: 5, favAt: 0.93, holdRows: 10, holdAt: 0.9 },
];

export type PaperTrade = {
  variant: string;
  window: number;
  t: number;
  left: number;
  side: "UP" | "DOWN";
  ask: number;
  shares: number;
  cost: number;
  fee: number;
  projected: number;
  openAverage: number;
  resolvedUp: boolean | null;
  won: boolean | null;
  pnl: number | null;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Where a paper trader runs: file-name prefix for the series, its settlement feed and window length. */
export type PaperHome = { prefix?: string; feed?: Feed; windowSec?: number };

export class PaperTrader {
  readonly v: Variant;
  private readonly feed: Feed;
  private readonly windowSec: number;
  /** File names: the base variant keeps the original ones, so its history carries on. */
  private readonly kind: string;
  private readonly openFile: string;
  private readonly totalsFile: string;
  open: PaperTrade[];
  /** Running totals for the status page, rebuilt from the totals file at start. */
  trades = 0;
  won = 0;
  net = 0;
  /** Windows where the rule wanted to buy but nothing was on offer under the cap. */
  noAsk = 0;
  private lastNoAskWindow = 0;
  /** Called right after a paper trade is taken (the live trader mirrors one variant). */
  onTrade: ((trade: PaperTrade) => void) | null = null;

  constructor(v: Variant, home: PaperHome = {}) {
    this.v = v;
    this.feed = home.feed ?? chainlink;
    this.windowSec = home.windowSec ?? WINDOW_SEC;
    const prefix = home.prefix ?? "";
    const suffix = v.name === "base" ? "" : `-${v.name}`;
    this.kind = `${prefix}paper${suffix}`;
    this.openFile = `${prefix}paper${suffix}-open.json`;
    this.totalsFile = `${prefix}paper${suffix}-totals.json`;
    this.open = loadJson<PaperTrade[]>(this.openFile, []);
    // Rows from other variants are skipped: one build wrote every variant into the base files.
    for (const t of loadJson<PaperTrade[]>(this.totalsFile, [])) if ((t.variant ?? "base") === v.name) this.count(t);
  }

  /** Per-UTC-day totals, newest first in status(). */
  private byDay = new Map<string, { day: string; trades: number; won: number; net: number }>();

  private count(t: PaperTrade) {
    if (t.pnl == null) return;
    this.trades += 1;
    if (t.won) this.won += 1;
    this.net += t.pnl;
    const day = kstDay(t.window * 1000);
    let d = this.byDay.get(day);
    if (!d) this.byDay.set(day, (d = { day, trades: 0, won: 0, net: 0 }));
    d.trades += 1;
    if (t.won) d.won += 1;
    d.net = Math.round((d.net + t.pnl) * 100) / 100;
  }

  /** Called on every book snapshot. */
  /** Previous second's best asks, for the noFall rule. */
  private prevAsk: { window: number; up: number | null; down: number | null } | null = null;
  /** Recent best asks of the window (newest last), for the holdRows rule. */
  private history: { window: number; rows: { up: number | null; down: number | null }[] } = { window: 0, rows: [] };
  /** Windows where the favourite rule already saw its first hit (taken or filtered out); it never fires twice. */
  private favSeen = 0;

  consider(row: BookRow) {
    const { left: LEFT, cap: CAP, size: SIZE } = this.v;
    const prev = this.prevAsk?.window === row.window ? this.prevAsk : null;
    this.prevAsk = { window: row.window, up: row.upAsk, down: row.downAsk };
    if (this.v.first != null) return this.considerEarly(row);
    if (this.v.favAt != null) return this.considerFav(row);
    if (row.left > LEFT || row.left < 1 || !row.chainlink) return;
    if (this.open.some((t) => t.window === row.window)) return;
    const openMs = row.window * 1000;
    const closeMs = openMs + this.windowSec * 1000;
    const before = this.feed.between(openMs - 60000, openMs).map((t) => t.price);
    const known = this.feed.between(closeMs - 60000, row.t).map((t) => t.price);
    const openAverage = mean(before);
    const knownAverage = mean(known);
    if (openAverage == null || knownAverage == null || before.length < 20) return;
    const frac = Math.min(1, (row.t - (closeMs - 60000)) / 60000);
    const projected = knownAverage * frac + row.chainlink * (1 - frac);
    const up = projected >= openAverage;
    const levels = up ? row.upAsks : row.downAsks;
    const FLOOR = this.v.floor ?? 0;
    if (this.v.noFall) {
      const before = up ? prev?.up : prev?.down;
      if (before != null && levels.length && levels[0][0] <= before - 0.01 + 1e-9) return;
    }
    if (this.v.prevFloor != null) {
      const before = up ? prev?.up : prev?.down;
      if (before == null || before < this.v.prevFloor - 1e-9) return;
    }
    if (!levels.length || levels[0][0] > CAP || levels[0][0] < FLOOR) {
      if (this.lastNoAskWindow !== row.window) {
        this.lastNoAskWindow = row.window;
        this.noAsk += 1;
      }
      return;
    }
    let budget = SIZE;
    let shares = 0;
    let cost = 0;
    let fee = 0;
    for (const [price, qty] of levels) {
      if (price > CAP || budget <= 0) break;
      const take = Math.min(qty, budget / price);
      shares += take;
      cost += take * price;
      fee += take * 0.07 * price * (1 - price);
      budget -= take * price;
    }
    if (shares <= 0) return;
    const trade: PaperTrade = {
      variant: this.v.name,
      window: row.window,
      t: row.t,
      left: row.left,
      side: up ? "UP" : "DOWN",
      ask: levels[0][0],
      shares,
      cost,
      fee,
      projected,
      openAverage,
      resolvedUp: null,
      won: null,
      pnl: null,
    };
    this.open.push(trade);
    saveJson(this.openFile, this.open);
    this.onTrade?.(trade);
    console.log(`paper ${this.v.name}: ${trade.side} at ${Math.round(trade.ask * 100)}c with ${trade.left}s left, ${shares.toFixed(1)} shares for $${cost.toFixed(2)} (projected ${projected.toFixed(2)} vs ${openAverage.toFixed(2)})`);
  }

  /** Called when a window's resolution is known. */
  settle(window: number, resolvedUp: boolean) {
    const trade = this.open.find((t) => t.window === window);
    if (!trade) return;
    trade.resolvedUp = resolvedUp;
    trade.won = (trade.side === "UP") === resolvedUp;
    trade.pnl = (trade.won ? trade.shares : 0) - trade.cost - trade.fee;
    this.open = this.open.filter((t) => t !== trade);
    this.count(trade);
    append(this.kind, trade, window * 1000);
    const totals = loadJson<PaperTrade[]>(this.totalsFile, []);
    totals.push(trade);
    saveJson(this.totalsFile, totals);
    saveJson(this.openFile, this.open);
    console.log(`paper ${this.v.name}: ${trade.side} ${trade.won ? "won" : "lost"} ${trade.pnl >= 0 ? "+" : "-"}$${Math.abs(trade.pnl).toFixed(2)}; running ${this.won}/${this.trades}, net ${this.net >= 0 ? "+" : "-"}$${Math.abs(this.net).toFixed(2)}`);
  }

  /** The `first` rule: in the first N seconds, buy the cheaper side if its best ask is at or under the cap. */
  private considerEarly(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    const elapsed = this.windowSec - row.left;
    if (elapsed < 0 || elapsed > (this.v.first ?? 0) || row.left < 1) return;
    if (this.open.some((t) => t.window === row.window)) return;
    const upBest = row.upAsks[0]?.[0];
    const downBest = row.downAsks[0]?.[0];
    const candidates = [upBest != null && upBest <= CAP ? { up: true, ask: upBest } : null, downBest != null && downBest <= CAP ? { up: false, ask: downBest } : null].filter((c): c is { up: boolean; ask: number } => c != null);
    if (!candidates.length) return;
    const pick = candidates.sort((a, b) => a.ask - b.ask)[0];
    const levels = pick.up ? row.upAsks : row.downAsks;
    let budget = SIZE;
    let shares = 0;
    let cost = 0;
    let fee = 0;
    for (const [price, qty] of levels) {
      if (price > CAP || budget <= 0) break;
      const take = Math.min(qty, budget / price);
      shares += take;
      cost += take * price;
      fee += take * 0.07 * price * (1 - price);
      budget -= take * price;
    }
    if (shares <= 0) return;
    const trade: PaperTrade = {
      variant: this.v.name,
      window: row.window,
      t: row.t,
      left: row.left,
      side: pick.up ? "UP" : "DOWN",
      ask: pick.ask,
      shares,
      cost,
      fee,
      projected: row.chainlink ?? 0,
      openAverage: row.open ?? 0,
      resolvedUp: null,
      won: null,
      pnl: null,
    };
    this.open.push(trade);
    saveJson(this.openFile, this.open);
    console.log(`paper ${this.v.name}: ${trade.side} ${shares.toFixed(1)} shares at ${Math.round(pick.ask * 100)}c, ${elapsed}s into the window`);
    this.onTrade?.(trade);
  }

  /** The `favAt` rule: the first time the favourite's best ask is at or above favAt, buy it (up to cap). */
  private considerFav(row: BookRow) {
    const { cap: CAP, size: SIZE } = this.v;
    const favAt = this.v.favAt ?? 1;
    if (row.left < 1) return;
    const scale = this.windowSec / 300;
    const elapsed = this.windowSec - row.left;
    if (this.v.favFrom != null && elapsed < this.v.favFrom * scale) return;
    if (this.v.favTo != null && elapsed > this.v.favTo * scale) return;
    if (this.open.some((t) => t.window === row.window)) return;
    const upBest = row.upAsks[0]?.[0];
    const downBest = row.downAsks[0]?.[0];
    if (this.history.window !== row.window) this.history = { window: row.window, rows: [] };
    const before = this.history.rows.slice(-Math.max(this.v.holdRows ?? 0, 1));
    this.history.rows.push({ up: upBest ?? null, down: downBest ?? null });
    if (this.history.rows.length > 30) this.history.rows.shift();
    if (upBest == null || downBest == null) return;
    if (this.favSeen === row.window) return;
    const up = upBest >= downBest;
    const ask = up ? upBest : downBest;
    if (ask < favAt - 1e-9 || ask > CAP) return;
    // The filters judge the first hit only: a window that fails them is left alone, like the replay they came from.
    this.favSeen = row.window;
    if (this.v.leadMin != null || this.v.leadMax != null) {
      if (row.chainlink == null || row.open == null) return;
      const lead = ((row.chainlink - row.open) / row.open) * 1e4 * (up ? 1 : -1);
      if (lead < (this.v.leadMin ?? -Infinity) || lead >= (this.v.leadMax ?? Infinity)) return;
    }
    if (this.v.holdRows != null) {
      if (before.length < this.v.holdRows) return;
      if (!before.every((r) => (up ? r.up : r.down) != null && (up ? r.up : r.down)! >= (this.v.holdAt ?? 0) - 1e-9)) return;
    }
    const levels = up ? row.upAsks : row.downAsks;
    let budget = SIZE;
    let shares = 0;
    let cost = 0;
    let fee = 0;
    for (const [price, qty] of levels) {
      if (price > CAP || budget <= 0) break;
      const take = Math.min(qty, budget / price);
      shares += take;
      cost += take * price;
      fee += take * 0.07 * price * (1 - price);
      budget -= take * price;
    }
    if (shares <= 0) return;
    const trade: PaperTrade = {
      variant: this.v.name,
      window: row.window,
      t: row.t,
      left: row.left,
      side: up ? "UP" : "DOWN",
      ask,
      shares,
      cost,
      fee,
      projected: row.chainlink ?? 0,
      openAverage: row.open ?? 0,
      resolvedUp: null,
      won: null,
      pnl: null,
    };
    this.open.push(trade);
    saveJson(this.openFile, this.open);
    console.log(`paper ${this.v.name}: ${trade.side} ${shares.toFixed(1)} shares at ${Math.round(ask * 100)}c, ${this.windowSec - row.left}s into the window`);
    this.onTrade?.(trade);
  }

  /** Drop open paper trades for windows that never resolved (the recorder gave up on them). */
  abandon(window: number) {
    const before = this.open.length;
    this.open = this.open.filter((t) => t.window !== window);
    if (this.open.length !== before) saveJson(this.openFile, this.open);
  }

  status() {
    const { left: LEFT, cap: CAP, size: SIZE } = this.v;
    return { name: this.v.name, rule: this.v.favAt != null ? `favourite when its ask reaches ${Math.round(this.v.favAt * 100)}c, ${this.v.favFrom != null ? `${this.v.favFrom}-${this.v.favTo}s in` : "any time"}, $${SIZE}` : this.v.first != null ? `first ${this.v.first}s, either side <= ${Math.round(CAP * 100)}c, $${SIZE}` : `<=${LEFT}s, ask ${this.v.floor ? Math.round(this.v.floor * 100) + "c to " : "<= "}${Math.round(CAP * 100)}c${this.v.noFall ? ", not falling" : ""}, $${SIZE}`, trades: this.trades, won: this.won, net: Math.round(this.net * 100) / 100, open: this.open.length, noAsk: this.noAsk, days: [...this.byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)) };
  }
}
