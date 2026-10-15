import { CHECKPOINTS, WINDOW_SEC, windowStart } from "./config.js";
import { binance, chainlink, coinbase, feeds, startFeeds } from "./feeds/index.js";
import { book, marketFor, officialPrices, resolution, type Book, type Market } from "./polymarket.js";
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
  chainlinkTwap60: number | null;
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

export class Recorder {
  market: Market | null = null;
  marketWindow = 0;
  marketTriedAt = 0;
  snapshots = 0;
  windowsDone = 0;
  windowsResolved = 0;
  lastBook: BookRow | null = null;
  lastError: string | null = null;
  startedAt = Date.now();
  private marks = new Map<number, (number | null)[]>();
  private markWindow = 0;
  private listedAt: number | null = null;
  private pending: Pending[] = loadJson<Pending[]>("pending.json", []);
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  start() {
    startFeeds();
    this.timer = setInterval(() => void this.tick(), 1000);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const feed of feeds) feed.stop();
    saveJson("pending.json", this.pending);
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const start = windowStart(now);
      if (start !== this.markWindow) {
        if (this.markWindow) this.closeWindow(this.markWindow);
        this.markWindow = start;
        this.marks = new Map();
        this.listedAt = null;
      }
      if (this.marketWindow !== start || !this.market) {
        if (Date.now() - this.marketTriedAt > 3000) {
          this.marketTriedAt = Date.now();
          this.market = await marketFor(start);
          this.marketWindow = start;
          if (this.market && this.listedAt == null) this.listedAt = Date.now();
        }
      }
      if (this.market) await this.snapshot(this.market, now);
      await this.settle();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }

  private async snapshot(market: Market, now: number) {
    const [up, down] = await Promise.all([book(market.upToken), book(market.downToken)]);
    const left = market.start + WINDOW_SEC - now;
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
      chainlink: chainlink.last()?.price ?? null,
      binance: binance.last()?.price ?? null,
      coinbase: coinbase.last()?.price ?? null,
      open: chainlink.at(market.start * 1000)?.price ?? null,
    };
    append("book", row);
    this.lastBook = row;
    this.snapshots += 1;
    const checkpoint = CHECKPOINTS.find((cp) => cp >= left && !this.marks.has(cp) && cp - left <= 2);
    if (checkpoint != null) this.marks.set(checkpoint, [checkpoint, row.upAsk, row.upBid, row.downAsk, row.downBid, row.chainlink, row.binance]);
  }

  private closeWindow(start: number) {
    const openMs = start * 1000;
    const closeMs = openMs + WINDOW_SEC * 1000;
    const inWindow = chainlink.between(openMs, closeMs);
    const last60 = chainlink.between(closeMs - 60000, closeMs);
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
    this.windowsDone += 1;
    saveJson("pending.json", this.pending);
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
      const [prices, res] = await Promise.allSettled([officialPrices(item.window), resolution(item.window)]);
      if (res.status === "fulfilled") {
        item.row.status = res.value.status;
        if (res.value.resolvedUp != null) {
          item.row.resolvedUp = res.value.resolvedUp;
          item.row.resolvedAt ??= Date.now();
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
      const closeMs = (item.window + WINDOW_SEC) * 1000;
      const pricesFinal =
        item.row.close != null && item.row.pricesAt != null && item.row.resolvedAt != null && item.row.pricesAt >= item.row.resolvedAt && item.row.pricesAt >= closeMs + 120000;
      const done = item.row.resolvedUp != null && pricesFinal;
      if (done || item.tries >= 40) {
        append("windows", item.row, item.window * 1000);
        this.pending = this.pending.filter((p) => p !== item);
        if (item.row.resolvedUp != null) this.windowsResolved += 1;
      } else {
        item.nextAt = now + Math.min(300000, 15000 * item.tries);
      }
      saveJson("pending.json", this.pending);
    }
  }

  status() {
    return {
      startedAt: this.startedAt,
      window: this.markWindow,
      listed: Boolean(this.market && this.marketWindow === windowStart()),
      snapshots: this.snapshots,
      windowsDone: this.windowsDone,
      windowsResolved: this.windowsResolved,
      pending: this.pending.length,
      lastBook: this.lastBook,
      lastError: this.lastError,
      feeds: feeds.map((feed) => ({ name: feed.name, healthy: feed.healthy(), last: feed.last(60000), ticks: feed.ticks.length, connects: feed.connects, errors: feed.errors })),
    };
  }
}

function pack(side: Book): [number, number][] {
  return side.asks.map((l) => [l.price, Math.round(l.size)] as [number, number]);
}
