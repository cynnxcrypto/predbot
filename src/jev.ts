import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, WINDOW_SEC } from "./config.js";
import { binance, chainlink, coinbase } from "./feeds/index.js";
import type { BookRow } from "./recorder.js";
import { append } from "./store.js";

/**
 * Shadow test of JEV (typesafe.ai): at a few checkpoints in every window we ask it "Up or Down?" and
 * save its answer next to what the book was charging. Nothing trades on it. `npm run report` scores it
 * against the settled results, so we only use it if it beats the book after costs.
 *
 * Off unless TYPESAFE_API_KEY is set (in the environment or in a .env file next to the app, which git
 * ignores). Calls never block or break recording: they run in the background with a short timeout.
 */
const envFile = join(ROOT, ".env");
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // a malformed .env just leaves JEV off
  }
}
const URL = "https://api.typesafe.ai/v1/systemone";
const KEY = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? "";
const MODEL = process.env.JEV_MODEL ?? "jev-latest";
const TIMEOUT_MS = 3000;

/** Seconds-left points at which JEV is asked. The old bot decided between 100 and 70 seconds left. */
export const JEV_CHECKPOINTS = [180, 120, 90, 60, 30, 10];

export type JevRow = {
  t: number;
  window: number;
  left: number;
  /** Model that answered, as JEV reports it (jev-latest moves between versions). */
  model: string | null;
  pickUp: boolean | null;
  pUp: number | null;
  confidence: number | null;
  ms: number;
  /** Book when asked, so the report can price a bet on JEV's side. */
  upAsk: number | null;
  downAsk: number | null;
  error: string | null;
};

export const jevStats = { enabled: Boolean(KEY), model: MODEL, asked: 0, answered: 0, failed: 0, lastError: null as string | null, last: null as JevRow | null };

let askedWindow = 0;
const asked = new Set<number>();

/** Called on every book snapshot; fires a background call when a checkpoint is reached. */
export function maybeAskJev(row: BookRow) {
  if (!KEY) return;
  if (row.window !== askedWindow) {
    askedWindow = row.window;
    asked.clear();
  }
  const checkpoint = JEV_CHECKPOINTS.find((cp) => cp >= row.left && cp - row.left <= 2 && !asked.has(cp));
  if (checkpoint == null) return;
  asked.add(checkpoint);
  void ask(row);
}

async function ask(row: BookRow) {
  jevStats.asked += 1;
  const started = Date.now();
  const out: JevRow = { t: started, window: row.window, left: row.left, model: null, pickUp: null, pUp: null, confidence: null, ms: 0, upAsk: row.upAsk, downAsk: row.downAsk, error: null };
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, state: stateFor(row), questions: { direction: QUESTION } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
    const body = (await res.json()) as { model?: string; answers?: { direction?: { choice?: string; probabilities?: Record<string, number>; confidence?: number } } };
    const answer = body.answers?.direction;
    if (!answer?.choice) throw new Error("no answer in response");
    out.model = body.model ?? null;
    out.pickUp = answer.choice === "up";
    out.pUp = answer.probabilities?.up ?? null;
    out.confidence = answer.confidence ?? null;
    jevStats.answered += 1;
    jevStats.lastError = null;
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error);
    jevStats.failed += 1;
    jevStats.lastError = out.error;
  }
  out.ms = Date.now() - started;
  jevStats.last = out;
  try {
    append("jev", out, row.window * 1000);
  } catch {
    // a full disk must not take the recorder down with it
  }
}

const QUESTION = {
  type: "choice",
  instructions:
    "This is a Polymarket market on whether Bitcoin's price at the end of a 5-minute window will be at or above its price at the start of the window. " +
    "It settles on the Chainlink BTC/USD price. Using the state (time left, price now versus the window open, the recent price path from three feeds, and what the market charges for each side), " +
    "which side will win?",
  criteria: {
    up: "BTC finishes the window at or above the open price",
    down: "BTC finishes the window below the open price",
  },
};

function stateFor(row: BookRow) {
  const now = row.t;
  const openMs = row.window * 1000;
  const path = (feed: typeof chainlink, fromMs: number, stepMs: number) => {
    const points: { secondsAgo: number; price: number }[] = [];
    for (let at = fromMs; at <= now; at += stepMs) {
      const tick = feed.at(at);
      if (tick) points.push({ secondsAgo: Math.round((now - at) / 1000), price: tick.price });
    }
    return points;
  };
  const vsOpen = row.open != null && row.chainlink != null ? row.chainlink - row.open : null;
  return {
    secondsLeft: row.left,
    windowSeconds: WINDOW_SEC,
    windowOpenPrice: row.open,
    chainlinkNow: row.chainlink,
    binanceNow: row.binance,
    coinbaseNow: row.coinbase,
    dollarsAboveOpen: vsOpen,
    basisPointsAboveOpen: vsOpen != null && row.open ? Math.round((vsOpen / row.open) * 1e5) / 10 : null,
    market: {
      upAsk: row.upAsk,
      upBid: row.upBid,
      downAsk: row.downAsk,
      downBid: row.downBid,
      note: "Asks are the price in dollars of a share paying $1 if that side wins, so they read as the market's probability.",
    },
    chainlinkSinceOpenEvery10s: path(chainlink, openMs, 10000),
    binanceLast60sEvery5s: path(binance, now - 60000, 5000),
    coinbaseLast60sEvery5s: path(coinbase, now - 60000, 5000),
  };
}
