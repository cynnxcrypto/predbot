import { windowStart } from "./config.js";
import { binance, chainlink, coinbase } from "./feeds/index.js";
import { book, marketFor, officialPrices, resolution } from "./polymarket.js";

/** `npm run probe`: one pass over every feed and endpoint, so a missing route is obvious before recording. */
const start = windowStart();
const line = (name: string, ok: boolean, detail: string) => console.log(`${ok ? "OK  " : "FAIL"} ${name.padEnd(22)} ${detail}`);

for (const feed of [chainlink, binance, coinbase]) feed.start();
await new Promise((resolve) => setTimeout(resolve, 6000));
for (const feed of [chainlink, binance, coinbase]) {
  const last = feed.last(60000);
  line(feed.name, Boolean(last), last ? `${last.price} (${feed.ticks.length} ticks in 6s)` : `no ticks (errors ${feed.errors})`);
  feed.stop();
}

try {
  const market = await marketFor(start);
  line("gamma market", Boolean(market), market ? `${market.title}` : "window not listed yet (normal in the first seconds)");
  if (market) {
    const [up, down] = await Promise.all([book(market.upToken), book(market.downToken)]);
    line("clob book", up.bestAsk != null && down.bestAsk != null, `up ${up.bestBid}/${up.bestAsk} down ${down.bestBid}/${down.bestAsk}`);
  }
} catch (error) {
  line("gamma/clob", false, error instanceof Error ? error.message : String(error));
}
try {
  const prev = start - 300;
  const [prices, res] = await Promise.all([officialPrices(prev), resolution(prev)]);
  line("official prices", prices.open != null, `open ${prices.open} close ${prices.close}`);
  line("resolution", res.resolvedUp != null, `previous window ${res.resolvedUp == null ? "not settled yet" : res.resolvedUp ? "UP" : "DOWN"} (${res.status ?? "?"})`);
} catch (error) {
  line("official/resolution", false, error instanceof Error ? error.message : String(error));
}
process.exit(0);
