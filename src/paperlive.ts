import { WINDOW_SEC } from "./config.js";
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
  /** Early-window long shot: buy whichever side is cheapest, at or under `cap`, within the first `first` seconds of the window (no projection). */
  first?: number;
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
  // enrique's long shot (20 Oct): either side under 10c in the first 90s of the window, $5 a trade.
  { name: "cheap10-first90", left: 0, cap: 0.1, size: 5, first: 90 },
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
    const day = new Date(t.window * 1000).toISOString().slice(0, 10);
    let d = this.byDay.get(day);
    if (!d) this.byDay.set(day, (d = { day, trades: 0, won: 0, net: 0 }));
    d.trades += 1;
    if (t.won) d.won += 1;
    d.net = Math.round((d.net + t.pnl) * 100) / 100;
  }

  /** Called on every book snapshot. */
  /** Previous second's best asks, for the noFall rule. */
  private prevAsk: { window: number; up: number | null; down: number | null } | null = null;

  consider(row: BookRow) {
    const { left: LEFT, cap: CAP, size: SIZE } = this.v;
    const prev = this.prevAsk?.window === row.window ? this.prevAsk : null;
    this.prevAsk = { window: row.window, up: row.upAsk, down: row.downAsk };
    if (this.v.first != null) return this.considerEarly(row);
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
  }

  /** Drop open paper trades for windows that never resolved (the recorder gave up on them). */
  abandon(window: number) {
    const before = this.open.length;
    this.open = this.open.filter((t) => t.window !== window);
    if (this.open.length !== before) saveJson(this.openFile, this.open);
  }

  status() {
    const { left: LEFT, cap: CAP, size: SIZE } = this.v;
    return { name: this.v.name, rule: this.v.first != null ? `first ${this.v.first}s, either side <= ${Math.round(CAP * 100)}c, $${SIZE}` : `<=${LEFT}s, ask ${this.v.floor ? Math.round(this.v.floor * 100) + "c to " : "<= "}${Math.round(CAP * 100)}c${this.v.noFall ? ", not falling" : ""}, $${SIZE}`, trades: this.trades, won: this.won, net: Math.round(this.net * 100) / 100, open: this.open.length, noAsk: this.noAsk, days: [...this.byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)) };
  }
}
