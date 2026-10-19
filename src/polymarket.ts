import { SLUG, WINDOW_SEC } from "./config.js";

const UA = "PredBotRecorder/0.1";

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${url.slice(0, 80)}`);
  return (await res.json()) as T;
}

type GammaMarket = {
  question?: string;
  conditionId?: string;
  clobTokenIds?: string;
  eventStartTime?: string;
  endDate?: string;
  outcomePrices?: string;
  closed?: boolean;
  umaResolutionStatus?: string;
  bestAsk?: number;
  bestBid?: number;
};
type GammaEvent = { title?: string; description?: string; markets?: GammaMarket[] };

export type Market = { start: number; title: string | null; upToken: string; downToken: string; description: string | null; conditionId: string | null };

const markets = new Map<number, Market | null>();

/** The Up and Down token ids for the window starting at `start`. Null when Polymarket has not listed it yet. */
export async function marketFor(start: number): Promise<Market | null> {
  const cached = markets.get(start);
  if (cached) return cached;
  const events = await getJson<GammaEvent[]>(`https://gamma-api.polymarket.com/events?slug=${SLUG}-${start}`);
  const market = events[0]?.markets?.[0];
  if (!market?.clobTokenIds) return null;
  let tokens: string[] = [];
  try {
    tokens = JSON.parse(market.clobTokenIds) as string[];
  } catch {
    tokens = [];
  }
  if (tokens.length < 2) return null;
  const row: Market = { start, title: events[0]?.title ?? market.question ?? null, upToken: tokens[0], downToken: tokens[1], description: events[0]?.description ?? null, conditionId: market.conditionId ?? null };
  markets.set(start, row);
  if (markets.size > 50) markets.delete([...markets.keys()][0]);
  return row;
}

export type Level = { price: number; size: number };
export type Book = { bids: Level[]; asks: Level[]; bestBid: number | null; bestAsk: number | null; bidDepth: number; askDepth: number };

function levels(raw: { price?: string; size?: string }[] | undefined, side: "bid" | "ask"): Level[] {
  const rows = (raw ?? [])
    .map((row) => ({ price: Number(row.price), size: Number(row.size) }))
    .filter((row) => row.price > 0 && row.price < 1 && row.size > 0);
  rows.sort((a, b) => (side === "ask" ? a.price - b.price : b.price - a.price));
  return rows.slice(0, 10);
}

/** The order book for one token. Depth is in shares, dollars at each price. */
export async function book(tokenId: string): Promise<Book> {
  const raw = await getJson<{ bids?: { price: string; size: string }[]; asks?: { price: string; size: string }[] }>(`https://clob.polymarket.com/book?token_id=${tokenId}`, 5000);
  const bids = levels(raw.bids, "bid");
  const asks = levels(raw.asks, "ask");
  return {
    bids,
    asks,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    bidDepth: Math.round(bids.reduce((sum, row) => sum + row.size, 0)),
    askDepth: Math.round(asks.reduce((sum, row) => sum + row.size, 0)),
  };
}

export type Resolution = { resolvedUp: boolean | null; closed: boolean; status: string | null };

/** How Polymarket settled the window, once it has. */
export async function resolution(start: number): Promise<Resolution> {
  const events = await getJson<GammaEvent[]>(`https://gamma-api.polymarket.com/events?slug=${SLUG}-${start}`);
  const market = events[0]?.markets?.[0];
  if (!market) return { resolvedUp: null, closed: false, status: null };
  let resolvedUp: boolean | null = null;
  try {
    const prices = JSON.parse(market.outcomePrices ?? "[]") as string[];
    const up = Number(prices[0]);
    if (up === 1) resolvedUp = true;
    if (up === 0) resolvedUp = false;
  } catch {
    resolvedUp = null;
  }
  return { resolvedUp, closed: Boolean(market.closed), status: market.umaResolutionStatus ?? null };
}

/** Polymarket's own open and close prints for the window, from the endpoint its page uses. */
export type OfficialPrices = { open: number | null; close: number | null; raw: unknown };

/** Polymarket's own open/close prints for the window. `raw` is the untouched response, kept so the settlement rule can be audited. */
export async function officialPrices(start: number): Promise<OfficialPrices> {
  const from = new Date(start * 1000).toISOString();
  const to = new Date((start + WINDOW_SEC) * 1000).toISOString();
  const body = await getJson<{ openPrice?: number | null; closePrice?: number | null }>(
    `https://polymarket.com/api/crypto/crypto-price?symbol=BTC&variant=fiveminute&eventStartTime=${encodeURIComponent(from)}&endDate=${encodeURIComponent(to)}`,
    5000,
  );
  const ok = (n: unknown) => (typeof n === "number" && n > 1000 ? n : null);
  return { open: ok(body.openPrice), close: ok(body.closePrice), raw: body };
}
