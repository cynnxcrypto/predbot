import { Feed } from "./socket.js";

/** Chainlink BTC/USD as relayed by Polymarket. This is the feed the market is believed to settle on. */
export const chainlink = new Feed({
  name: "chainlink",
  url: "wss://ws-live-data.polymarket.com",
  onOpen: (send) =>
    send(JSON.stringify({ action: "subscribe", subscriptions: [{ topic: "crypto_prices_chainlink", type: "*", filters: '{"symbol":"btc/usd"}' }] })),
  onText: (text, push, send) => {
    if (text === "ping") {
      send("pong");
      return;
    }
    const body = JSON.parse(text) as { payload?: unknown };
    take(body.payload ?? body, push);
  },
});

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

/** Binance BTCUSDT trades: the fastest widely available BTC print. */
export const binance = new Feed({
  name: "binance",
  url: "wss://stream.binance.com:9443/ws/btcusdt@trade",
  onText: (text, push) => {
    const row = JSON.parse(text) as { e?: string; T?: number; p?: string };
    if (row.e === "trade" && row.T && row.p) push(row.T, Number(row.p));
  },
});

/** Coinbase BTC-USD ticker: a second, independent spot print. */
export const coinbase = new Feed({
  name: "coinbase",
  url: "wss://ws-feed.exchange.coinbase.com",
  onOpen: (send) => send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker"] })),
  onText: (text, push) => {
    const row = JSON.parse(text) as { type?: string; time?: string; price?: string };
    if (row.type === "ticker" && row.time && row.price) push(Date.parse(row.time), Number(row.price));
  },
});

export const feeds = [chainlink, binance, coinbase];
export function startFeeds() {
  for (const feed of feeds) feed.start();
}
