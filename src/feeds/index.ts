import type { Symbol } from "../config.js";
import { Feed } from "./socket.js";

/** The three price feeds for one coin. */
export type FeedSet = { chainlink: Feed; binance: Feed; coinbase: Feed; futures: Feed };

const sets = new Map<Symbol, FeedSet>();

function make(symbol: Symbol): FeedSet {
  const tag = symbol === "btc" ? "" : ` ${symbol}`;
  return {
    /** Chainlink <coin>/USD as relayed by Polymarket. This is the feed the market is believed to settle on. */
    chainlink: new Feed({
      name: `chainlink${tag}`,
      url: "wss://ws-live-data.polymarket.com",
      onOpen: (send) =>
        send(JSON.stringify({ action: "subscribe", subscriptions: [{ topic: "crypto_prices_chainlink", type: "*", filters: `{"symbol":"${symbol}/usd"}` }] })),
      onText: (text, push, send) => {
        if (text === "ping") {
          send("pong");
          return;
        }
        const body = JSON.parse(text) as { payload?: unknown };
        take(body.payload ?? body, push);
      },
    }),
    /** Binance <coin>USDT trades: the fastest widely available print. */
    binance: new Feed({
      name: `binance${tag}`,
      url: `wss://stream.binance.com:9443/ws/${symbol}usdt@trade`,
      onText: (text, push) => {
        const row = JSON.parse(text) as { e?: string; T?: number; p?: string };
        if (row.e === "trade" && row.T && row.p) push(row.T, Number(row.p));
      },
    }),
    /** Binance USDT-margined perpetual <coin>USDT trades: the leveraged crowd, for the futures-minus-spot basis. */
    futures: new Feed({
      name: `futures${tag}`,
      url: `wss://fstream.binance.com/ws/${symbol}usdt@aggTrade`,
      onText: (text, push) => {
        const row = JSON.parse(text) as { e?: string; T?: number; p?: string };
        if (row.e === "aggTrade" && row.T && row.p) push(row.T, Number(row.p));
      },
    }),
    /** Coinbase <coin>-USD ticker: a second, independent spot print. */
    coinbase: new Feed({
      name: `coinbase${tag}`,
      url: "wss://ws-feed.exchange.coinbase.com",
      onOpen: (send) => send(JSON.stringify({ type: "subscribe", product_ids: [`${symbol.toUpperCase()}-USD`], channels: ["ticker"] })),
      onText: (text, push) => {
        const row = JSON.parse(text) as { type?: string; time?: string; price?: string };
        if (row.type === "ticker" && row.time && row.price) push(Date.parse(row.time), Number(row.price));
      },
    }),
  };
}

function take(value: unknown, push: (t: number, price: number) => void) {
  if (!value || typeof value !== "object") return;
  const row = value as { timestamp?: number | string; value?: number | string; data?: unknown[] };
  if (Array.isArray(row.data)) {
    for (const point of row.data) take(point, push);
    return;
  }
  if (row.timestamp != null && row.value != null) {
    const t = Number(row.timestamp);
    push(t < 1e12 ? t * 1000 : t, Number(row.value));
  }
}

/** The feeds for one coin, created on first use and shared by every series on that coin. */
export function feedsFor(symbol: Symbol): FeedSet {
  let set = sets.get(symbol);
  if (!set) {
    set = make(symbol);
    sets.set(symbol, set);
  }
  return set;
}

export const { chainlink, binance, coinbase } = feedsFor("btc");
/** Every feed created so far. */
export function allFeeds(): Feed[] {
  return [...sets.values()].flatMap((s) => [s.chainlink, s.binance, s.coinbase, s.futures]);
}
/** Kept for older callers: the BTC feeds. */
export const feeds = [chainlink, binance, coinbase];

const started = new Set<Feed>();
/** Start every feed created so far; safe to call more than once. */
export function startFeeds() {
  for (const feed of allFeeds()) {
    if (started.has(feed)) continue;
    started.add(feed);
    feed.start();
  }
}
