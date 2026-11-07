/**
 * Jev (TypeSafe AI) as a stake picker for paper bets (7 Nov 2026, enrique: "I want you to use JEV to decide sizing of
 * the bet" ... "i want it for all, not only laliga"). Shared by every event paper rule (src/eventpaper.ts). For each
 * signal we send the full context (rule thesis, the rule's own paper record, live book, recent headlines, the proposed
 * flat stake and the caps) and ask for a stake: skip, half, normal or double the default stake. The answer is LOGGED next to the flat $5 paper
 * trade so "flat $5" and "Jev-sized" can be compared per rule. Nothing here places an order.
 *
 * Key: env TYPESAFE_API_KEY (or TYPESAFE_AI_API_KEY), else data/jev-key.txt, else TYPESAFE_API_KEY= in the app's .env
 * (data/ and .env are git-ignored). NEVER commit a key.
 * No key or no network: returns { err } and the paper trade simply has no Jev stake.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, ROOT } from "./config.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = process.env.JEV_MODEL || "jev-latest";
/** Multiplier on the rule's default stake (spec: /mnt/project-files/reviews/jev-sizing-spec.md). Caps apply after it. */
export const STAKES: Record<string, number> = { skip: 0, half: 0.5, normal: 1, double: 2 };
export const JEV_CONTEXT =
  "You are the risk manager for a small bettor. A rule wants to place this bet. Using everything here (news, injuries, form, motivation, market vs other prices, the rule's record), decide how much to stake. Size down or skip when the news or situation undermines the bet; size up only when you are confident the outcome is underpriced.";

let cachedKey: string | null | undefined;
let checkedAt = 0;
/** The key, re-read every 5 minutes while missing (so dropping data/jev-key.txt on the server needs no restart). */
export function jevKey(): string | null {
  if (cachedKey || (cachedKey === null && Date.now() - checkedAt < 300_000)) return cachedKey;
  checkedAt = Date.now();
  let k = (process.env.TYPESAFE_AI_API_KEY || process.env.TYPESAFE_API_KEY || "").trim();
  if (!k) {
    try {
      k = readFileSync(join(DATA, "jev-key.txt"), "utf8").trim();
    } catch {
      k = "";
    }
  }
  if (!k) {
    try {
      k = /^\s*TYPESAFE_(?:AI_)?API_KEY\s*=\s*"?([^"\s]+)"?/m.exec(readFileSync(join(ROOT, ".env"), "utf8"))?.[1] ?? "";
    } catch {
      k = "";
    }
  }
  cachedKey = k || null;
  return cachedKey;
}

export type JevStake = { mult: number | null; pick?: string; probs?: Record<string, number>; confidence?: number | null; model?: string; ms?: number; err?: string; at: number };

const QUESTIONS = {
  stake: {
    type: "choice",
    instructions: "How much should we stake on the proposed bet?",
    criteria: { skip: "Skip ($0): not worth it at this price", half: "Small ($2.50): some doubt", normal: "Normal ($5): fair-to-good bet", double: "Double ($10): high confidence it is underpriced" },
  },
  confidence: { type: "score", instructions: "How confident are you (0-100) that the bet wins?" },
};

/** Up to 12 recent headlines for a query from Google News RSS (5 s timeout, empty on any failure). */
export async function headlines(query: string): Promise<string[]> {
  try {
    const res = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}+when:3d&hl=en-US&gl=US&ceid=US:en`, { headers: { "user-agent": "PredBotPaper/0.1" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const xml = await res.text();
    return [...xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>[\s\S]*?(?:<pubDate>([^<]*)<\/pubDate>)?/g)]
      .slice(0, 12)
      .map((m) => `${m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()}${m[2] ? ` (${m[2].trim()})` : ""}`);
  } catch {
    return [];
  }
}

let calls: number[] = [];
/** Ask Jev for a stake multiplier. Rate-limited to 200 calls an hour; 3 s timeout (spec); never throws. */
export async function jevStake(state: Record<string, unknown>): Promise<JevStake> {
  const at = Date.now();
  const key = jevKey();
  if (!key) return { mult: null, err: "no key", at };
  calls = calls.filter((t) => t > at - 3600_000);
  if (calls.length >= 200) return { mult: null, err: "rate cap", at };
  calls.push(at);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, state, questions: QUESTIONS }),
      signal: AbortSignal.timeout(Number(process.env.JEV_TIMEOUT_MS) || 3000),
    });
    const ms = Date.now() - at;
    if (!res.ok) return { mult: null, err: `http ${res.status}`, ms, at };
    const j = (await res.json()) as { model?: string; answers?: Record<string, Answer> };
    return parseJev(j, ms, at);
  } catch (e) {
    return { mult: null, err: (e as Error).message.slice(0, 120), at };
  }
}
type Answer = { probabilities?: Record<string, number>; choice?: string; score?: number; value?: number; confidence?: unknown };
export function parseJev(j: { model?: string; answers?: Record<string, Answer> }, ms: number, at: number): JevStake {
  const s = j.answers?.stake;
  const probs = s?.probabilities;
  const pick = s?.choice && s.choice in STAKES ? s.choice : probs ? Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
  if (!pick || !(pick in STAKES)) return { mult: null, err: "no stake in answer", model: j.model, ms, at };
  const c = j.answers?.confidence;
  const conf = c == null ? null : Number(c.score ?? c.value ?? (typeof c === "number" ? c : NaN));
  return { mult: STAKES[pick], pick, probs, confidence: Number.isFinite(conf) ? conf : null, model: j.model, ms, at };
}
