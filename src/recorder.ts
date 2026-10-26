import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, SERIES, checkpointsFor, dayOf, prefixOf, windowStart, type Series } from "./config.js";
import { feedsFor, startFeeds, type FeedSet } from "./feeds/index.js";
import { PaperTrader, VARIANTS } from "./paperlive.js";
import { LiveTrader } from "./live.js";
import { bookFeed } from "./feeds/book.js";
import { book, bookHttp, marketFor, officialPrices, resolution, type Book, type Market } from "./polymarket.js";
import { append, loadJson, saveJson } from "./store.js";

/** One book snapshot row, written every second while a window is listed. */
export type BookRow = {
  t: number;
  window: number;
  left: number;
  upAsk: number | null;
  upBid: number | null;
  downAsk: number | null;
  downBid: number | null;
  upAskDepth: number;
  downAskDepth: number;
  upAsks: [number, number][];
  upBids: [number, number][];
  downAsks: [number, number][];
  downBids: [number, number][];
  chainlink: number | null;
  binance: number | null;
  coinbase: number | null;
  open: number | null;
};

/** One row per window, written at close and rewritten when the resolution arrives. */
export type WindowRow = {
  window: number;
  title: string | null;
  /** Polymarket's market description, verbatim, since it states the resolution source. */
  description: string | null;
  listedAt: number | null;
  snapshots: number;
  /** Polymarket's own open/close prints. */
  open: number | null;
  close: number | null;
  /** The first open/close we fetched (about 20s after close), to see whether the print changes later. */
  firstOpen: number | null;
  firstClose: number | null;
  /** When the final open/close were fetched, and the raw response, so the settlement rule can be audited. */
  pricesAt: number | null;
  pricesRaw: unknown;
  /** Candidate settlement prices from our own feeds, so the rule can be checked. */
  chainlinkAtOpen: number | null;
  chainlinkAtClose: number | null;
  /** 60s average of the Chainlink feed ending at close: what the market settles on. */
  chainlinkTwap60: number | null;
  /** 60s average of the Chainlink feed ending at open (the minute before the window): the "price at the beginning". */
  chainlinkTwap60AtOpen: number | null;
  chainlinkMean: number | null;
  binanceAtOpen: number | null;
  binanceAtClose: number | null;
  coinbaseAtOpen: number | null;
  coinbaseAtClose: number | null;
  /** Book at each seconds-left checkpoint: [left, upAsk, upBid, downAsk, downBid, chainlink, binance]. */
  marks: (number | null)[][];
  resolvedUp: boolean | null;
  resolvedAt: number | null;
  status: string | null;
};

type Pending = { window: number; row: WindowRow; tries: number; nextAt: number };

/**
 * Records one market series (BTC 5m by default). Every series gets its own book, windows and paper
 * files, named with the series prefix; the first series keeps the original names. Every series has a
 * real trader; it only acts when data/live.json names that series (see live.ts).
 */
/** The current window's tokens per series, so the one shared socket watches all of them. */
const watchedTokens = new Map<string, string[]>();

export class Recorder {
  readonly series: Series;
  readonly prefix: string;
  private readonly f: FeedSet;
  private readonly checkpoints: number[];
  market: Market | null = null;
  marketWindow = 0;
  marketTriedAt = 0;
  snapshots = 0;
  windowsDone = 0;
  windowsResolved = 0;
  lastBook: BookRow | null = null;
  lastError: string | null = null;
  papers: PaperTrader[];
  /** The real trader for this series (idle unless live.json configures it). */
  live: LiveTrader | null;
  startedAt = Date.now();
  private marks = new Map<number, (number | null)[]>();
  private markWindow = 0;
  private listedAt: number | null = null;
  private pending: Pending[];
  private timer: NodeJS.Timeout | null = null;
  private balanceTimer: NodeJS.Timeout | null = null;
  private busy = false;
  private unwatch: (() => void) | null = null;
  private lastSnapshotAt = 0;
  private lastCheckAt = 0;
  /** Snapshots taken because the websocket pushed a change (the rest come from the 1s timer). */
  pushedSnapshots = 0;

  constructor(series: Series = SERIES[0]) {
    this.series = series;
    this.prefix = prefixOf(series);
    this.f = feedsFor(series.symbol);
    this.checkpoints = checkpointsFor(series.windowSec);
    this.papers = VARIANTS.map((v) => new PaperTrader(v, { prefix: this.prefix, feed: this.f.chainlink, windowSec: series.windowSec }));
    this.live = new LiveTrader(series);
    this.pending = loadJson<Pending[]>(`${this.prefix}pending.json`, []);
    this.adoptOrphans();
  }

  /**
   * A restart right at a window edge can exit before the closing window is queued for settlement, which
   * leaves paper and real trades on that window open for ever (seen on 21 Oct 2026: three restarts in ten
   * minutes lost three windows and a real $5 trade). Queue every window that still has an open trade but no
   * settlement entry, so settle() fetches its result from Polymarket like any other window.
   */
  private adoptOrphans() {
    const now = Math.floor(Date.now() / 1000);
    const windows = new Set<number>();
    for (const p of this.papers) for (const t of p.open) windows.add(t.window);
    for (const t of this.live?.open ?? []) windows.add(t.window);
    let added = 0;
    for (const window of windows) {
      if (window + this.series.windowSec > now - 30 || this.pending.some((p) => p.window === window)) continue;
      const row: WindowRow = {
        window,
        title: null,
        description: null,
        listedAt: null,
        snapshots: 0,
        open: null,
        close: null,
        firstOpen: null,
        firstClose: null,
        pricesAt: null,
        pricesRaw: null,
        chainlinkAtOpen: null,
        chainlinkAtClose: null,
        chainlinkTwap60: null,
        chainlinkTwap60AtOpen: null,
        chainlinkMean: null,
        binanceAtOpen: null,
        binanceAtClose: null,
        coinbaseAtOpen: null,
        coinbaseAtClose: null,
        marks: [],
        resolvedUp: null,
        resolvedAt: null,
        status: null,
      };
      this.pending.push({ window, row, tries: 0, nextAt: Date.now() + 5000 });
      added += 1;
    }
    if (added) {
      console.log(`${this.series.label}: ${added} window(s) with open trades were never queued for settlement (lost in a restart); settling them now`);
      saveJson(`${this.prefix}pending.json`, this.pending);
    }
  }

  start() {
    startFeeds();
    const live = this.live;
    if (live) {
      void live.start();
      this.balanceTimer = setInterval(() => {
        void live.refreshBalance().then(() => live.wrapPending()).then(() => live.swapNative());
        void live.redeemPending();
      }, 60000);
    }
    this.timer = setInterval(() => void this.tick(), 1000);
    // A pushed book change takes a snapshot at once (at most four a second), so a signal is seen the moment it appears.
    this.unwatch = bookFeed.onUpdate((tokenId) => {
      const m = this.market;
      if (!m || (tokenId !== m.upToken && tokenId !== m.downToken) || this.busy) return;
      if (Date.now() - this.lastSnapshotAt < 250) return;
      const now = Math.floor(Date.now() / 1000);
      if (m.start + this.series.windowSec - now < 1) return;
      this.busy = true;
      this.pushedSnapshots += 1;
      void this.snapshot(m, now)
        .catch((error) => {
          this.lastError = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          this.busy = false;
        });
    });
    return this;
  }

  stop() {
    this.unwatch?.();
    if (this.timer) clearInterval(this.timer);
    if (this.balanceTimer) clearInterval(this.balanceTimer);
    for (const feed of [this.f.chainlink, this.f.binance, this.f.coinbase]) feed.stop();
    saveJson(`${this.prefix}pending.json`, this.pending);
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const start = windowStart(now, this.series.windowSec);
      if (start !== this.markWindow) {
        if (this.markWindow) this.closeWindow(this.markWindow);
        this.markWindow = start;
        this.marks = new Map();
        this.listedAt = null;
      }
      if (this.marketWindow !== start || !this.market) {
        if (Date.now() - this.marketTriedAt > 3000) {
          this.marketTriedAt = Date.now();
          this.market = await marketFor(start, this.series.slug);
          this.marketWindow = start;
          if (this.market && this.listedAt == null) this.listedAt = Date.now();
          if (this.market) {
            watchedTokens.set(this.series.key, [this.market.upToken, this.market.downToken]);
            bookFeed.watch([...watchedTokens.values()].flat());
          }
        }
      }
      // The extra series poll the book every other second until the last minute, to go easy on Polymarket's rate limit.
      const left = this.market ? this.market.start + this.series.windowSec - now : 0;
      // The timer snapshot is the floor; pushed book changes already took one if it is fresher than half a second.
      if (this.market && Date.now() - this.lastSnapshotAt >= 500 && (this.series.key === "" || left <= 60 || now % 2 === 0)) await this.snapshot(this.market, now);
      await this.settle();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }

  private async snapshot(market: Market, now: number) {
    this.lastSnapshotAt = Date.now();
    // Every 30s read both books over HTTP anyway, which resets the websocket cache in case a delta was missed.
    const check = Date.now() - this.lastCheckAt > 30000;
    if (check) this.lastCheckAt = Date.now();
    const read = check ? bookHttp : book;
    const [up, down] = await Promise.all([read(market.upToken), read(market.downToken)]);
    const left = market.start + this.series.windowSec - now;
    const row: BookRow = {
      t: Date.now(),
      window: market.start,
      left,
      upAsk: up.bestAsk,
      upBid: up.bestBid,
      downAsk: down.bestAsk,
      downBid: down.bestBid,
      upAskDepth: up.askDepth,
      downAskDepth: down.askDepth,
      upAsks: pack(up),
      upBids: up.bids.map((l) => [l.price, Math.round(l.size)] as [number, number]),
      downAsks: pack(down),
      downBids: down.bids.map((l) => [l.price, Math.round(l.size)] as [number, number]),
      chainlink: this.f.chainlink.last()?.price ?? null,
      binance: this.f.binance.last()?.price ?? null,
      coinbase: this.f.coinbase.last()?.price ?? null,
      open: this.f.chainlink.at(market.start * 1000)?.price ?? this.openFromDisk(market.start),
    };
    append(`${this.prefix}book`, row);
    this.lastBook = row;
    this.snapshots += 1;
    const live = this.live;
    for (const p of this.papers) {
      // The skip-when-the-ask-fell rule is for favourite buys; a long shot getting cheaper is not a reason to skip.
      p.onTrade = live ? (trade) => void live.onPaperTrade(trade, market, p.v.cap, p.v.first == null, p.v.first ?? null) : null;
      p.consider(row);
    }
    const checkpoint = this.checkpoints.find((cp) => cp >= left && !this.marks.has(cp) && cp - left <= 2);
    if (checkpoint != null) this.marks.set(checkpoint, [checkpoint, row.upAsk, row.upBid, row.downAsk, row.downBid, row.chainlink, row.binance]);
  }

  private closeWindow(start: number) {
    const openMs = start * 1000;
    const closeMs = openMs + this.series.windowSec * 1000;
    const { chainlink, binance, coinbase } = this.f;
    const inWindow = chainlink.between(openMs, closeMs);
    const last60 = chainlink.between(closeMs - 60000, closeMs);
    const before60 = chainlink.between(openMs - 60000, openMs);
    const mean = (ticks: { price: number }[]) => (ticks.length ? ticks.reduce((sum, t) => sum + t.price, 0) / ticks.length : null);
    const row: WindowRow = {
      window: start,
      title: this.marketWindow === start ? (this.market?.title ?? null) : null,
      description: this.marketWindow === start ? (this.market?.description ?? null) : null,
      listedAt: this.listedAt,
      snapshots: [...this.marks.keys()].length,
      open: null,
      close: null,
      firstOpen: null,
      firstClose: null,
      pricesAt: null,
      pricesRaw: null,
      chainlinkAtOpen: chainlink.at(openMs)?.price ?? null,
      chainlinkAtClose: chainlink.at(closeMs)?.price ?? null,
      chainlinkTwap60: mean(last60),
      chainlinkTwap60AtOpen: mean(before60),
      chainlinkMean: mean(inWindow),
      binanceAtOpen: binance.at(openMs)?.price ?? null,
      binanceAtClose: binance.at(closeMs)?.price ?? null,
      coinbaseAtOpen: coinbase.at(openMs)?.price ?? null,
      coinbaseAtClose: coinbase.at(closeMs)?.price ?? null,
      marks: [...this.marks.values()].sort((a, b) => (b[0] ?? 0) - (a[0] ?? 0)),
      resolvedUp: null,
      resolvedAt: null,
      status: null,
    };
    this.pending.push({ window: start, row, tries: 0, nextAt: Date.now() + 20000 });
    const o = row.chainlinkAtOpen, c = row.chainlinkAtClose;
    this.live?.provisional(start, o != null && c != null && c !== o ? c > o : null);
    this.windowsDone += 1;
    saveJson(`${this.prefix}pending.json`, this.pending);
  }

  /**
   * Fetch the official prices and the resolution for closed windows; give up after about an hour.
   * The prices are only trusted once they were fetched after the market resolved and at least two
   * minutes after close, because the first print can be provisional.
   */
  private async settle() {
    const now = Date.now();
    const due = this.pending.filter((p) => p.nextAt <= now).slice(0, 2);
    for (const item of due) {
      item.tries += 1;
      const [prices, res] = await Promise.allSettled([
        officialPrices(item.window, this.series.symbol.toUpperCase(), this.series.windowSec),
        resolution(item.window, this.series.slug),
      ]);
      if (res.status === "fulfilled") {
        item.row.status = res.value.status;
        if (res.value.resolvedUp != null) {
          item.row.resolvedUp = res.value.resolvedUp;
          item.row.resolvedAt ??= Date.now();
          for (const p of this.papers) p.settle(item.window, res.value.resolvedUp);
          this.live?.settle(item.window, res.value.resolvedUp);
        }
      }
      if (prices.status === "fulfilled") {
        if (item.row.firstOpen == null) item.row.firstOpen = prices.value.open;
        if (item.row.firstClose == null) item.row.firstClose = prices.value.close;
        item.row.open = prices.value.open ?? item.row.open;
        item.row.close = prices.value.close ?? item.row.close;
        item.row.pricesRaw = prices.value.raw;
        item.row.pricesAt = Date.now();
      }
      const closeMs = (item.window + this.series.windowSec) * 1000;
      const pricesFinal =
        item.row.close != null && item.row.pricesAt != null && item.row.resolvedAt != null && item.row.pricesAt >= item.row.resolvedAt && item.row.pricesAt >= closeMs + 120000;
      const done = item.row.resolvedUp != null && pricesFinal;
      if (done || item.tries >= 60) {
        if (item.row.resolvedUp == null) {
          for (const p of this.papers) p.abandon(item.window);
          this.live?.abandon(item.window);
        }
        append(`${this.prefix}windows`, item.row, item.window * 1000);
        this.pending = this.pending.filter((p) => p !== item);
        if (item.row.resolvedUp != null) this.windowsResolved += 1;
      } else {
        // Polymarket usually resolves 3-5 minutes after close; check every 15s for the first ten minutes, then back off.
        item.nextAt = now + (item.tries < 40 ? 15000 : Math.min(300000, 15000 * (item.tries - 39)));
      }
      saveJson(`${this.prefix}pending.json`, this.pending);
    }
  }

  private seedWindow = 0;
  private seed: { t: number; price: number }[] = [];
  private seedOpen: number | null = null;

  /** The window's open price as the book rows written before a restart recorded it (the feed only knows ticks since it started). */
  private openFromDisk(start: number): number | null {
    if (start !== this.markWindow) return null;
    this.seedPrices(start * 1000);
    return this.seedOpen;
  }

  /** After a restart the feed has no ticks from before it started; the book rows on disk have the window's earlier prices. */
  private seedPrices(openMs: number): { t: number; price: number }[] {
    if (this.seedWindow === this.markWindow) return this.seed;
    this.seedWindow = this.markWindow;
    this.seed = [];
    this.seedOpen = null;
    const first = this.f.chainlink.between(openMs, openMs + this.series.windowSec * 1000)[0];
    const until = first ? first.t : Date.now();
    if (until - openMs < 3000) return this.seed;
    try {
      const file = join(DATA, `${this.prefix}book`, `${dayOf(until)}.jsonl`);
      if (!existsSync(file)) return this.seed;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.includes(`"window":${this.markWindow},`)) continue;
        try {
          const row = JSON.parse(line) as { t: number; window: number; chainlink: number | null; open?: number | null };
          if (row.window !== this.markWindow) continue;
          if (this.seedOpen == null && row.open != null) this.seedOpen = row.open;
          if (row.chainlink != null && row.t >= openMs && row.t < until) this.seed.push({ t: row.t, price: row.chainlink });
        } catch {
          // skip a half-written line
        }
      }
    } catch {
      // the chart simply starts at the restart
    }
    return this.seed;
  }

  private windowPrices(): [number, number][] {
    if (!this.markWindow) return [];
    const openMs = this.markWindow * 1000;
    const ticks = [...this.seedPrices(openMs), ...this.f.chainlink.between(openMs, openMs + this.series.windowSec * 1000)];
    const step = Math.max(1, Math.ceil(ticks.length / 180));
    const out: [number, number][] = [];
    ticks.forEach((t, i) => { if (i % step === 0 || i === ticks.length - 1) out.push([Math.round((t.t - openMs) / 100) / 10, t.price]); });
    return out;
  }

  status() {
    const feeds = [this.f.chainlink, this.f.binance, this.f.coinbase];
    return {
      key: this.series.key,
      label: this.series.label,
      windowSec: this.series.windowSec,
      startedAt: this.startedAt,
      window: this.markWindow,
      // Chainlink prices of the current window as [seconds into the window, price], thinned to about 180 points, for the charts.
      prices: this.windowPrices(),
      listed: Boolean(this.market && this.marketWindow === windowStart(undefined, this.series.windowSec)),
      snapshots: this.snapshots,
      pushedSnapshots: this.pushedSnapshots,
      bookFeed: bookFeed.status(),
      windowsDone: this.windowsDone,
      windowsResolved: this.windowsResolved,
      pending: this.pending.length,
      // Best guess for closed windows still waiting for Polymarket's result: the close print against the open (official if fetched, else Chainlink).
      pendingLean: Object.fromEntries(
        this.pending.map((p) => {
          const open = p.row.open ?? p.row.chainlinkAtOpen;
          const close = p.row.close ?? p.row.chainlinkAtClose;
          return [p.window, p.row.resolvedUp != null ? (p.row.resolvedUp ? 1 : -1) : open == null || close == null ? null : close > open ? 1 : close < open ? -1 : 0];
        }),
      ),
      lastBook: this.lastBook,
      lastError: this.lastError,
      paper: this.papers[0].status(),
      papers: this.papers.map((p) => p.status()),
      live: this.live?.status() ?? null,
      feeds: feeds.map((feed) => ({ name: feed.name, healthy: feed.healthy(), last: feed.last(60000), ticks: feed.ticks.length, connects: feed.connects, errors: feed.errors })),
    };
  }
}

function pack(side: Book): [number, number][] {
  return side.asks.map((l) => [l.price, Math.round(l.size)] as [number, number]);
}
