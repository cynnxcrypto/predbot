/**
 * Paper loggers for non-crypto Polymarket markets (7 Nov 2026). PAPER ONLY: nothing here signs or sends an order, and
 * nothing reads deploy/live-rules.json. Runs as its own child process (started by src/index.ts, like src/history.ts) so
 * a slow API never delays the crypto recorder. State: data/eventpaper-state.json; dashboard summary:
 * data/eventpaper-summary.json (read by /api/status and deploy/report.py).
 *
 * Rules (specs in /mnt/project-files/reviews/{esports,indices,politics}-paper-spec.md):
 *  - esports-map1 (candidate 1): CS2/LoL/Valorant Bo3; P0 = match mid at start-10 min, map chance q from
 *    P0 = q^2(3-2q); after map 1 (map-1 mid >= 95c for 60 s) model = 1-(1-q_w)^2; buy the map-1 winner's match ask
 *    60-120 s later when ask <= model - 8 pts. esports-fav-shadow (candidate 2): the pre-match favourite won map 1,
 *    match ask up < 5 pts and < 90c. esports-map1-dota: candidate 1 on Dota 2 as a shadow.
 *  - gold-momentum (P1): first ask in [55c, 70c] on the gold daily up/down, until 4 h before the 17:00 ET close.
 *    spx-underdog / spy-underdog (P2 control): first ask in [30c, 45c], until 4 h before the 16:00 ET close.
 *  - election-lock-taker / -maker: favourite of a binary election market ending in 1-7 days with its ask at 97-99c;
 *    the maker variant bids 1c under and counts as filled if the ask reaches the bid within 6 h.
 * Every rule is $5 at the real ask (walking the book), taker fee rate x p x (1-p) per share, held to settlement.
 */
import { loadJson, saveJson } from "./store.js";
import { eventLiveBusy, eventLiveBuy, eventLiveConfig, eventLiveRows, eventLiveSettle, eventLiveSummary, eventLiveStop } from "./eventlive.js";
import { JEV_CONTEXT, headlines, jevKey, jevStake, type JevStake } from "./jev.js";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const UA = "PredBotPaper/0.1";
const STAKE = 5;
const STATE_FILE = "eventpaper-state.json";
const SUMMARY_FILE = "eventpaper-summary.json";

async function getJson<T>(url: string, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${url.slice(0, 100)}`);
  return (await res.json()) as T;
}
const jl = <T>(x: unknown, d: T): T => {
  if (Array.isArray(x)) return x as T;
  try {
    return typeof x === "string" ? (JSON.parse(x) as T) : d;
  } catch {
    return d;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Level = { price: number; size: number };
export type Book = { bids: Level[]; asks: Level[]; bestBid: number | null; bestAsk: number | null; mid: number | null };
export function parseBook(raw: { bids?: { price: string; size: string }[]; asks?: { price: string; size: string }[] }): Book {
  const lv = (xs?: { price: string; size: string }[]) => (xs ?? []).map((x) => ({ price: Number(x.price), size: Number(x.size) })).filter((x) => x.price > 0 && x.size > 0);
  const bids = lv(raw.bids).sort((a, b) => b.price - a.price);
  const asks = lv(raw.asks).sort((a, b) => a.price - b.price);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  return { bids, asks, bestBid, bestAsk, mid: bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null };
}
async function book(token: string): Promise<Book> {
  return parseBook(await getJson(`${CLOB}/book?token_id=${token}`));
}
/** $stake bought by walking the asks up to `limit`: shares, cost, average price; full = the whole stake fits. */
export function walk(asks: Level[], stake: number, limit: number): { shares: number; cost: number; avg: number | null; full: boolean } {
  let cost = 0;
  let shares = 0;
  for (const a of asks) {
    if (a.price > limit + 1e-9) break;
    const take = Math.min(a.size, (stake - cost) / a.price);
    shares += take;
    cost += take * a.price;
    if (cost >= stake - 1e-6) break;
  }
  return { shares, cost, avg: shares > 0 ? cost / shares : null, full: cost >= stake - 1e-6 };
}
/** Map strength q from a Bo3 match price P = q^2(3-2q) (bisection, as esports/an/common.py solve_q). */
export function solveQ(p: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 50; i++) {
    const m = (lo + hi) / 2;
    if (m * m * (3 - 2 * m) < p) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}
/** UTC ms of a wall-clock time in a time zone (DST-aware through Intl). */
export function zonedUtc(y: number, mo: number, d: number, h: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return guess - (asUtc - guess);
}
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** "xauusd-up-or-down-on-november-9-2026" -> [2026, 11, 9]. */
export function slugDate(slug: string): [number, number, number] | null {
  const m = /-on-([a-z]+)-(\d{1,2})-(\d{4})/.exec(slug);
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1]) + 1;
  return mo > 0 ? [Number(m[3]), mo, Number(m[2])] : null;
}

export type PaperTrade = {
  rule: string;
  marketId: string;
  title: string;
  outcome: string;
  idx: number;
  token: string;
  t: number;
  ask: number;
  avg: number | null;
  shares: number;
  cost: number;
  fee: number;
  fillable: boolean;
  feeRate: number;
  extra?: Record<string, unknown>;
  won?: boolean | null;
  pnl?: number | null;
  settledAt?: number;
  /** Jev's stake multiplier on this bet (src/jev.ts); pnl x mult = the Jev-sized result. jevPending until asked. */
  jev?: JevStake;
  jevPending?: boolean;
};
type Signal = { rule: string; t: number; title: string; traded: boolean; extra: Record<string, unknown> };
type Match = {
  id: string;
  title: string;
  game: string;
  start: number;
  tokens: string[];
  outcomes: string[];
  map1Id: string;
  map1Tokens: string[];
  feeRate: number;
  volume: number | null;
  p0?: number | null;
  runSide?: number | null;
  runFrom?: number | null;
  tEnd?: number | null;
  w?: number | null;
  evaluated?: boolean;
  /** The map-1 price was seen undecided (5-95c), so a later decided run is a map end we watched, not one long over. */
  sawLive?: boolean;
  gap?: number;
  note?: string;
  /** Gamma best ask of outcome 0 at the last list refresh (dashboard only). */
  px0?: number | null;
  /** Pre-match favourite rule (esports-lol-fav90 / esports-cs2-fav90) already checked once for this match. */
  preFav?: boolean;
};
type Side = { id: string; token: string; team: string; feeRate: number };
type Fixture = { id: string; league: string; title: string; kickoff: number; home: Side; away: Side; done?: boolean; note?: string; homeAsk?: number | null; awayAsk?: number | null; pxAt?: number };
type WxEvent = { id: string; title: string; station: string; tz: string; date: [number, number, number]; buckets: { id: string; token: string; label: string; feeRate: number; no?: string; noIdx?: number; cond?: string }[] };
/** A resting paper bid on the NO side of a weather bucket (wx-no-maker). Prices are NO prices. */
export type NoMaker = { marketId: string; cond: string; title: string; label: string; yes: string; no: string; noIdx: number; bid: number; bid0: number; ahead: number; got: number; shares: number; t: number; until: number; seen: number; yesMid0: number; twin: boolean };
type TennisMatch = { id: string; title: string; tour: string; start: number; tokens: string[]; outcomes: string[]; feeRate: number; done?: boolean; mid30?: boolean; note?: string };
type CricketMatch = { id: string; title: string; start: number; tokens: string[]; outcomes: string[]; feeRate: number; done10?: boolean; done60?: boolean; note?: string };
type Maker = { rule: string; marketId: string; title: string; outcome: string; idx: number; token: string; bid: number; t: number; feeRate: number; ask: number; until?: number; mid?: number };
type UsMatch = { id: string; title: string; league: string; start: number; tokens: string[]; outcomes: string[]; feeRate: number; done?: boolean; mid30?: boolean; note?: string };
type State = {
  matches: Record<string, Match>;
  done: Record<string, number>;
  makers: Maker[];
  trades: PaperTrade[];
  signals: Signal[];
  fixtures: Record<string, Fixture>;
  wx: Record<string, WxEvent>;
  tennis: Record<string, TennisMatch>;
  cricket: Record<string, CricketMatch>;
  usports: Record<string, UsMatch>;
  nomk: NoMaker[];
  rest: RestBid[];
};
const state: State = { matches: {}, done: {}, nomk: [], rest: [], makers: [], trades: [], signals: [], fixtures: {}, wx: {}, tennis: {}, cricket: {}, usports: {}, ...loadJson<Partial<State>>(STATE_FILE, {}) };
// 7 Nov 2026 20:15 KST fix: the first run counted matches whose map 1 had ended before the logger started (map-1 price
// already decided), so it "bought" mid-map-2 prices. Drop those esports rows once; later rows need sawLive.
if (!state.done["fix:esports-sawlive"]) {
  state.trades = state.trades.filter((t) => !(t.rule.startsWith("esports") && t.t < Date.UTC(2026, 10, 7, 11, 30)));
  state.signals = state.signals.filter((x) => !(x.rule.startsWith("esports") && x.t < Date.UTC(2026, 10, 7, 11, 30)));
  for (const m of Object.values(state.matches)) if (m.tEnd != null && !m.sawLive) m.evaluated = true;
  state.done["fix:esports-sawlive"] = Date.now();
}
const save = () => saveJson(STATE_FILE, state);
const feeOf = (rate: number, shares: number, p: number) => rate * shares * p * (1 - p);
const log = (s: string) => console.log(`eventpaper: ${s}`);

function enter(rule: string, m: { marketId: string; title: string; outcome: string; idx: number; token: string; feeRate: number }, bk: Book, limit: number, extra: Record<string, unknown> = {}): PaperTrade | null {
  if (bk.bestAsk == null) return null;
  const w = walk(bk.asks, STAKE, limit);
  if (w.shares <= 0 || w.avg == null) return null;
  const tr: PaperTrade = { rule, ...m, t: Date.now(), ask: bk.bestAsk, avg: w.avg, shares: w.shares, cost: w.cost, fee: feeOf(m.feeRate, w.shares, w.avg), fillable: w.full, extra };
  tr.jevPending = true;
  state.trades.push(tr);
  log(`${rule} ${m.title} ${m.outcome} at ${Math.round(bk.bestAsk * 100)}c ($${w.cost.toFixed(2)}${w.full ? "" : ", not fully fillable"})`);
  return tr;
}
function signal(rule: string, title: string, traded: boolean, extra: Record<string, unknown>) {
  state.signals.push({ rule, t: Date.now(), title, traded, extra });
  if (state.signals.length > 2000) state.signals.splice(0, state.signals.length - 2000);
}

// ---------- esports ----------
const ESPORTS: { id: number; game: string; shadow?: boolean }[] = [
  { id: 10310, game: "cs2" },
  { id: 10311, game: "lol" },
  { id: 10369, game: "val" },
  { id: 10309, game: "dota2", shadow: true },
];
type GMarket = { id?: string; question?: string; groupItemTitle?: string; eventStartTime?: string; sportsMarketType?: string; outcomes?: string; clobTokenIds?: string; gameStartTime?: string; closed?: boolean; outcomePrices?: string; volumeNum?: number; feeSchedule?: { rate?: number } | null; bestAsk?: number; bestBid?: number; acceptingOrders?: boolean; endDate?: string; liquidityNum?: number; conditionId?: string };
type GEvent = { id?: string; title?: string; slug?: string; startTime?: string; endDate?: string; markets?: GMarket[] };
const tsOf = (s?: string) => {
  if (!s) return NaN;
  let x = s.replace(" ", "T");
  if (/[+-]\d\d$/.test(x)) x += ":00";
  return Date.parse(x);
};
async function pages(base: string, cap = 1000): Promise<GEvent[]> {
  const out: GEvent[] = [];
  for (let off = 0; off < cap; off += 100) {
    const xs = await getJson<GEvent[]>(`${base}&limit=100&offset=${off}`);
    out.push(...xs);
    if (xs.length < 100) break;
  }
  return out;
}
async function esportsRefresh() {
  const now = Date.now();
  for (const s of ESPORTS) {
    let evs: GEvent[];
    try {
      evs = await pages(`${GAMMA}/events?series_id=${s.id}&closed=false`);
    } catch (e) {
      log(`esports list ${s.game} failed: ${(e as Error).message}`);
      continue;
    }
    for (const e of evs) {
      const ms = e.markets ?? [];
      // 8 Nov 2026: any match moneyline is kept (the pre-match favourite rules need no map-1 market); the map-1 rules
      // still need a Bo3 with a "Map 1 Winner" child whose outcomes match.
      const match = ms.find((m) => m.sportsMarketType === "moneyline" && (m.question ?? "").toUpperCase().includes("BO3")) ?? ms.find((m) => m.sportsMarketType === "moneyline");
      let map1 = ms.find((m) => m.sportsMarketType === "child_moneyline" && /(Map|Game) 1 Winner/i.test(m.question ?? ""));
      if (!match?.id) continue;
      const outs = jl<string[]>(match.outcomes, []);
      if (map1 && JSON.stringify(outs) !== JSON.stringify(jl<string[]>(map1.outcomes, []))) map1 = undefined;
      const start = tsOf(match.gameStartTime) || tsOf(e.startTime);
      if (!Number.isFinite(start) || start > now + 2 * 86400_000 || start < now - 8 * 3600_000) continue;
      const cur = state.matches[match.id];
      if (cur) {
        cur.start = start;
        cur.px0 = match.bestAsk ?? cur.px0 ?? null;
        continue;
      }
      state.matches[match.id] = {
        id: match.id,
        title: match.question ?? e.title ?? match.id,
        game: s.game,
        start,
        tokens: jl<string[]>(match.clobTokenIds, []),
        outcomes: outs,
        map1Id: map1?.id ?? "",
        map1Tokens: map1 ? jl<string[]>(map1.clobTokenIds, []) : [],
        feeRate: Number(match.feeSchedule?.rate ?? 0.05),
        volume: match.volumeNum ?? null,
        px0: match.bestAsk ?? null,
      };
    }
  }
  // Forget matches long over (their trades stay in state.trades).
  for (const [k, m] of Object.entries(state.matches)) if (m.start < now - 12 * 3600_000) delete state.matches[k];
}
async function p0For(m: Match): Promise<number | null> {
  const t10 = Math.floor((m.start - 600_000) / 1000);
  try {
    const h = await getJson<{ history?: { t: number; p: number }[] }>(`${CLOB}/prices-history?market=${m.tokens[0]}&startTs=${t10 - 3 * 3600}&endTs=${t10}&fidelity=1`);
    const pts = (h.history ?? []).filter((x) => x.t <= t10);
    if (pts.length) return pts[pts.length - 1].p;
  } catch {
    /* fall back to the live book below */
  }
  if (Math.abs(Date.now() - (m.start - 600_000)) < 5 * 60_000) {
    const b = await book(m.tokens[0]).catch(() => null);
    return b?.mid ?? null;
  }
  return null;
}
// esports-lol-fav90 (high win-rate thread, 8 Nov 2026, reviews/high-winrate-2026-11-08.md): LoL match moneyline, 60-10 min
// before the start, buy the favourite asking 90-98c when the spread is <= 3c and >= $25 rests at the ask; one bet per
// match, hold to settlement. Backtest 324 matches 96.6% won +4.0c/share on mids (decaying: Aug +0.5c, Sep +2.4c, Oct
// -1.5c). esports-cs2-fav90 is the same rule on CS2 as a shadow (+1.4c over 324).
async function esportsPreFav(m: Match) {
  const rule = m.game === "lol" ? "esports-lol-fav90" : m.game === "cs2" ? "esports-cs2-fav90" : null;
  if (!rule) return;
  const books = await Promise.all(m.tokens.map((k) => book(k).catch(() => null)));
  if (books[0]?.bestAsk == null || books[1]?.bestAsk == null) return;
  const fav = books[0].bestAsk >= books[1].bestAsk ? 0 : 1;
  const bk = books[fav]!;
  const ask = bk.bestAsk!;
  if (ask < 0.9 - 1e-9 || ask > 0.98 + 1e-9) return;
  const spread = bk.bestBid != null ? ask - bk.bestBid : null;
  const atAsk = bk.asks.filter((a) => a.price <= ask + 1e-9).reduce((x, a) => x + a.price * a.size, 0);
  const extra: Record<string, unknown> = { start: m.start, minsToStart: Math.round((m.start - Date.now()) / 60_000), mid: bk.mid, bid: bk.bestBid, ask, spread, atAsk, otherAsk: books[1 - fav]!.bestAsk };
  if (spread == null || spread > 0.03 + 1e-9 || atAsk < 25 - 1e-9) {
    extra.skip = spread == null ? "no bid" : spread > 0.03 + 1e-9 ? `spread ${Math.round(spread * 100)}c` : `only $${atAsk.toFixed(0)} at the ask`;
    signal(rule, m.title, false, extra);
    return;
  }
  const tr = enter(rule, { marketId: m.id, title: m.title, outcome: m.outcomes[fav], idx: fav, token: m.tokens[fav], feeRate: m.feeRate }, bk, ask, extra);
  signal(rule, m.title, Boolean(tr), extra);
}
async function esportsTick() {
  const now = Date.now();
  for (const m of Object.values(state.matches)) {
    if (!m.preFav && m.tokens.length === 2 && now >= m.start - 60 * 60_000 && now <= m.start - 10 * 60_000) {
      m.preFav = true;
      await esportsPreFav(m);
    }
    if (m.evaluated || m.tokens.length !== 2 || m.map1Tokens.length !== 2) continue;
    if (now < m.start - 600_000) continue;
    if (m.p0 === undefined) {
      m.p0 = await p0For(m);
      if (m.p0 == null) {
        m.evaluated = true;
        m.note = "no P0";
        continue;
      }
    }
    if (now > m.start + 8 * 3600_000) {
      m.evaluated = true;
      m.note = "no map-1 end seen";
      continue;
    }
    if (m.tEnd == null) {
      const b = await book(m.map1Tokens[0]).catch(() => null);
      const mid = b?.mid ?? (b?.bestBid != null && b.bestBid >= 0.95 ? b.bestBid : b?.bestAsk != null && b.bestAsk <= 0.05 ? b.bestAsk : null);
      const side = mid == null ? null : mid >= 0.95 ? 0 : mid <= 0.05 ? 1 : null;
      if (side == null) {
        if (b && b.bestBid != null && b.bestAsk != null && b.bestAsk - b.bestBid <= 0.1) m.sawLive = true;
        m.runSide = null;
        m.runFrom = null;
      } else if (!m.sawLive) {
        m.evaluated = true;
        m.note = "map 1 already decided when first seen";
      } else if (m.runSide !== side) {
        m.runSide = side;
        m.runFrom = now;
      } else if (m.runFrom != null && now - m.runFrom >= 60_000) {
        m.tEnd = m.runFrom;
        m.w = side;
        log(`${m.title}: map 1 to ${m.outcomes[side]}`);
      }
      continue;
    }
    if (now < m.tEnd + 60_000) continue;
    m.evaluated = true;
    if (now > m.tEnd + 150_000) {
      m.note = "missed the 60-120 s window";
      continue;
    }
    const w = m.w as number;
    const bk = await book(m.tokens[w]).catch(() => null);
    if (!bk || bk.bestAsk == null) {
      m.note = "no ask";
      continue;
    }
    const q = solveQ(m.p0 as number);
    const qw = w === 0 ? q : 1 - q;
    const model = 1 - (1 - qw) ** 2;
    const p0w = w === 0 ? (m.p0 as number) : 1 - (m.p0 as number);
    const ask = bk.bestAsk;
    const depth2c = bk.asks.filter((a) => a.price <= ask + 0.02 + 1e-9).reduce((s, a) => s + a.price * a.size, 0);
    const base = { marketId: m.id, title: m.title, outcome: m.outcomes[w], idx: w, token: m.tokens[w], feeRate: m.feeRate };
    const extra = { game: m.game, p0: m.p0, q, model, gap: ask - model, p0w, bid: bk.bestBid, ask, mid: bk.mid, depth2c, volume: m.volume, start: m.start, tEnd: m.tEnd };
    m.gap = Math.round((ask - model) * 1000) / 1000; // diagnostics: how far the match ask sat from the model after map 1
    const r1 = m.game === "dota2" ? "esports-map1-dota" : "esports-map1";
    if (ask <= model - 0.08) signal(r1, m.title, Boolean(enter(r1, base, bk, ask + 0.01, extra)), extra);
    else if (ask <= model - 0.04) signal(`${r1}-nearmiss`, m.title, false, extra);
    if (m.game !== "dota2" && p0w >= 0.5 && ask - p0w < 0.05 && ask < 0.9) signal("esports-fav-shadow", m.title, Boolean(enter("esports-fav-shadow", base, bk, ask + 0.01, extra)), extra);
  }
}

// ---------- indices ----------
const INDICES: { id: number; rule: string; closeH: number; lo: number; hi: number; pick: "high" | "low" }[] = [
  { id: 11307, rule: "gold-momentum", closeH: 17, lo: 0.55, hi: 0.7, pick: "high" },
  { id: 10383, rule: "spx-underdog", closeH: 16, lo: 0.3, hi: 0.45, pick: "low" },
  { id: 11303, rule: "spy-underdog", closeH: 16, lo: 0.3, hi: 0.45, pick: "low" },
];
async function indicesTick() {
  const now = Date.now();
  for (const s of INDICES) {
    let evs: GEvent[];
    try {
      evs = await getJson<GEvent[]>(`${GAMMA}/events?series_id=${s.id}&closed=false&order=endDate&ascending=true&limit=20`);
    } catch (e) {
      log(`indices ${s.rule} failed: ${(e as Error).message}`);
      continue;
    }
    for (const e of evs) {
      const m = e.markets?.[0];
      const d = slugDate(e.slug ?? "");
      if (!m?.id || !d || m.closed) continue;
      const key = `${s.rule}|${e.slug}`;
      if (state.done[key]) continue;
      const close = zonedUtc(d[0], d[1], d[2], s.closeH, "America/New_York");
      if (now > close - 4 * 3600_000) continue;
      const toks = jl<string[]>(m.clobTokenIds, []);
      const outs = jl<string[]>(m.outcomes, ["Up", "Down"]);
      if (toks.length !== 2) continue;
      const books = await Promise.all(toks.map((t) => book(t).catch(() => null)));
      idxWatch.set(key, { rule: s.rule, title: e.title ?? e.slug ?? m.id, close, outs, asks: books.map((x) => x?.bestAsk ?? null), bids: books.map((x) => x?.bestBid ?? null), at: now, status: `waiting for an ask in ${Math.round(s.lo * 100)}-${Math.round(s.hi * 100)}c` });
      const ok = books
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => b && b.bestAsk != null && b.bestAsk >= s.lo - 1e-9 && b.bestAsk <= s.hi + 1e-9 && b.asks[0].size * b.asks[0].price >= STAKE);
      if (!ok.length) continue;
      ok.sort((a, b) => (s.pick === "high" ? b.b!.bestAsk! - a.b!.bestAsk! : a.b!.bestAsk! - b.b!.bestAsk!));
      const { b, i } = ok[0];
      const extra = { slug: e.slug, hoursToClose: (close - now) / 3600_000, close, asks: books.map((x) => x?.bestAsk ?? null), bids: books.map((x) => x?.bestBid ?? null), sizeAtAsk: b!.asks[0].size };
      const tr = enter(s.rule, { marketId: m.id, title: e.title ?? e.slug ?? m.id, outcome: outs[i], idx: i, token: toks[i], feeRate: Number(m.feeSchedule?.rate ?? 0.04) }, b!, 1, extra);
      signal(s.rule, e.title ?? "", Boolean(tr), extra);
      const iw = idxWatch.get(key);
      if (iw) iw.status = tr ? `bought ${outs[i]} at ${Math.round(b!.bestAsk! * 100)}c` : "in band, no fill";
      state.done[key] = now;
    }
  }
}

// ---------- politics ----------
const ELECT = /elect|win the|winner|nominee|primary|seat|governor|senate|house|mayor|prime minister|president|parliament|chancellor|popular vote|speaker|majority leader/i;
const TRAP = /county|votes? between|margin|by \d|%|turnout|say|seen|mention|tweet|recount|runoff|second round|from [A-Z]/;
async function politicsTick() {
  const now = Date.now();
  const seen = new Map<string, { e: GEvent; m: GMarket }>();
  for (const tag of ["elections", "politics", "global-elections"]) {
    try {
      const evs = await pages(`${GAMMA}/events?closed=false&active=true&tag_slug=${tag}&end_date_min=${new Date(now).toISOString()}&end_date_max=${new Date(now + 7 * 86400_000).toISOString()}`, 2000);
      for (const e of evs) for (const m of e.markets ?? []) if (m.id) seen.set(m.id, { e, m });
    } catch (err) {
      log(`politics ${tag} failed: ${(err as Error).message}`);
    }
  }
  const cand: PolWatch[] = [];
  for (const { e, m } of seen.values()) {
    const key = `election-lock|${m.id}`;
    {
      const end = Date.parse(m.endDate ?? e.endDate ?? "");
      const fav = (m.bestAsk ?? 0) >= 0.5 ? 0 : 1;
      const favAsk = fav === 0 ? (m.bestAsk ?? null) : m.bestBid != null ? Math.round((1 - m.bestBid) * 1000) / 1000 : null;
      const outs0 = jl<string[]>(m.outcomes, []);
      if (!m.closed && outs0.length === 2 && ELECT.test(`${e.title ?? ""} ${m.question ?? ""}`) && !TRAP.test(m.question ?? "") && end - now >= 0 && end - now <= 7 * 86400_000 && favAsk != null && favAsk >= 0.85)
        cand.push({ t: end, title: m.question ?? e.title ?? m.id!, outcome: outs0[fav], ask: favAsk, liq: m.liquidityNum ?? null, status: state.done[key] ? "bought" : end - now < 86400_000 ? "under 1 day left" : favAsk < 0.97 ? "below 97c" : favAsk > 0.99 ? "above 99c" : m.liquidityNum != null && m.liquidityNum < 2000 ? "liquidity under $2k" : "in band" });
    }
    if (state.done[key] || m.closed || m.acceptingOrders === false) continue;
    const outs = jl<string[]>(m.outcomes, []);
    const toks = jl<string[]>(m.clobTokenIds, []);
    if (outs.length !== 2 || toks.length !== 2) continue;
    const text = `${e.title ?? ""} ${m.question ?? ""}`;
    if (!ELECT.test(text) || TRAP.test(m.question ?? "")) continue;
    const end = Date.parse(m.endDate ?? e.endDate ?? "");
    if (!(end - now >= 86400_000 && end - now <= 7 * 86400_000)) continue;
    if (m.liquidityNum != null && m.liquidityNum < 2000) continue;
    const idx = (m.bestAsk ?? 0) >= 0.5 ? 0 : 1;
    const bk = await book(toks[idx]).catch(() => null);
    if (!bk || bk.bestAsk == null || bk.bestAsk < 0.97 - 1e-9 || bk.bestAsk > 0.99 + 1e-9 || bk.asks[0].size * bk.asks[0].price < STAKE) continue;
    const base = { marketId: m.id!, title: m.question ?? e.title ?? m.id!, outcome: outs[idx], idx, token: toks[idx], feeRate: Number(m.feeSchedule?.rate ?? 0.04) };
    const extra = { event: e.title, end, sizeAtAsk: bk.asks[0].size, bid: bk.bestBid };
    const tr = enter("election-lock-taker", base, bk, bk.bestAsk, extra);
    signal("election-lock-taker", base.title, Boolean(tr), extra);
    state.makers.push({ rule: "election-lock-maker", ...base, bid: Math.round((bk.bestAsk - 0.01) * 100) / 100, t: now, ask: bk.bestAsk });
    state.done[key] = now;
  }
  polWatch = cand.sort((a, b) => a.t - b.t).slice(0, 40);
  polWatchAt = now;
}
async function makersTick() {
  const now = Date.now();
  const keep: Maker[] = [];
  for (const mk of state.makers) {
    const bk = await book(mk.token).catch(() => null);
    if (bk?.bestAsk != null && bk.bestAsk <= mk.bid + 1e-9) {
      const shares = STAKE / mk.bid;
      // 10 Nov 2026 (research batch 2): fill time and the mid at the fill are logged so the mid-bid twins can show what
      // the price did after a fill (a fill because the favourite drifted down is the adverse case).
      state.trades.push({ rule: mk.rule, marketId: mk.marketId, title: mk.title, outcome: mk.outcome, idx: mk.idx, token: mk.token, t: now, ask: mk.ask, avg: mk.bid, shares, cost: STAKE, fee: 0, fillable: true, feeRate: 0, extra: { bidAt: mk.t, fillMin: Math.round((now - mk.t) / 60_000), mid0: mk.mid ?? null, midFill: bk.mid ?? null } });
      log(`${mk.rule} ${mk.title} filled at ${Math.round(mk.bid * 100)}c`);
    } else if (mk.until != null ? now < mk.until : now - mk.t < 6 * 3600_000) keep.push(mk);
    else signal(mk.rule, mk.title, false, { unfilled: true, bid: mk.bid, mid0: mk.mid ?? null, midEnd: bk?.mid ?? null });
  }
  state.makers = keep;
}

// ---------- football ----------
// Spec from the football thread (7 Nov 2026 22:22 KST, reviews/la-liga-thesis-2026-11-07.md "Update 22:30 KST"): one look
// per match 12-8 min before kickoff at the home-win and away-win YES books. MAIN: La Liga home favourite, home ask 65-80c.
// Shadows: Portugal home favourite 65-80c, Italy away favourite 65-80c, La Liga home 55-65c (control, expected ~0).
// Skip (and log why) when the spread is over 3c or less than $5 sits at <= ask+1c. $5 walking the book, fee 0.05 x p(1-p).
const FOOTBALL: { tag: string; league: string }[] = [
  { tag: "la-liga", league: "laliga" },
  { tag: "primeira-liga", league: "portugal" },
  // Tag serie-a returns ~36 events (football thread, 7 Nov 22:24 KST): Serie A is found by its series id from Gamma /sports.
  { tag: "", league: "italy" },
];
type GSport = { sport?: string; series?: string | number; tags?: string; resolution?: string };
let serieASeries: string | null = null;
/** Serie A's series id from Gamma /sports: the "sea" entry, never "bkseriea" (basketball) or "ecu1" (Ecuador). */
async function serieA(): Promise<string | null> {
  if (serieASeries) return serieASeries;
  const xs = await getJson<GSport[]>(`${GAMMA}/sports`);
  const pick = xs.find((x) => x.sport === "sea") ?? xs.find((x) => x.sport !== "bkseriea" && x.sport !== "ecu1" && /serie.?a|seriea|legaseriea/i.test(`${x.resolution ?? ""}`));
  serieASeries = pick?.series != null ? String(pick.series).split(",")[0] : "10203"; // 10203 = "sea" Serie A on 7 Nov 2026
  if (!serieASeries) log("football: no Serie A entry in /sports");
  return serieASeries;
}
const PROP = /halftime|half|score|o\/u|over|spread|both teams|corners|exact/i;
const norm = (x: string) => x.toLowerCase().normalize("NFD").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
/** Pick the "Will <team> win" market for a team named in the event title (exact name first, then first word). */
export function winMarketFor(team: string, ms: { question?: string; groupItemTitle?: string }[]): number {
  const t = norm(team);
  const qs = ms.map((m) => norm(`${m.groupItemTitle ?? ""} ${m.question ?? ""}`));
  let i = qs.findIndex((q) => q.includes(t));
  if (i < 0) {
    const w = t.split(" ").sort((a, b) => b.length - a.length)[0];
    if (w && w.length >= 4) {
      const hits = qs.map((q, k) => (q.includes(w) ? k : -1)).filter((k) => k >= 0);
      if (hits.length === 1) i = hits[0];
    }
  }
  return i;
}
async function footballRefresh() {
  const now = Date.now();
  for (const L of FOOTBALL) {
    let evs: GEvent[];
    try {
      const sel = L.tag ? `tag_slug=${L.tag}` : `series_id=${await serieA()}`;
      if (sel.endsWith("null")) continue;
      evs = await pages(`${GAMMA}/events?${sel}&closed=false&end_date_min=${new Date(now).toISOString()}&end_date_max=${new Date(now + 4 * 86400_000).toISOString()}`);
    } catch (e) {
      log(`football ${L.tag} failed: ${(e as Error).message}`);
      continue;
    }
    for (const e of evs) {
      if (!e.id) continue;
      // 9 Nov 2026: "X vs. Y - Second Half Result" events were listed as fixtures of their own (half-time win markets).
      if (/\b(first|second|1st|2nd)[ -]half\b/i.test(e.title ?? "")) continue;
      const tm = /^(.+?)\s+vs\.?\s+(.+?)$/i.exec((e.title ?? "").replace(/\s*[-:|(].*$/, "").trim());
      if (!tm) continue;
      const wins = (e.markets ?? []).filter((m) => /\bwin\b/i.test(m.question ?? "") && !/draw/i.test(m.question ?? "") && !PROP.test(m.question ?? "") && !m.closed);
      if (wins.length < 2) continue;
      const hi = winMarketFor(tm[1], wins);
      const ai = winMarketFor(tm[2], wins);
      if (hi < 0 || ai < 0 || hi === ai) continue;
      const known = state.fixtures[e.id];
      if (known) {
        if (!known.done) Object.assign(known, { homeAsk: wins[hi].bestAsk ?? null, awayAsk: wins[ai].bestAsk ?? null, pxAt: now });
        continue;
      }
      const side = (m: GMarket, team: string): Side | null => {
        const toks = jl<string[]>(m.clobTokenIds, []);
        const outs = jl<string[]>(m.outcomes, []);
        const yes = outs.findIndex((o) => /^yes$/i.test(o));
        return m.id && toks.length === 2 && yes >= 0 ? { id: m.id, token: toks[yes], team, feeRate: Number(m.feeSchedule?.rate ?? 0.05) } : null;
      };
      const home = side(wins[hi], tm[1]);
      const away = side(wins[ai], tm[2]);
      const kickoff = tsOf(wins[hi].gameStartTime) || tsOf(wins[hi].eventStartTime) || tsOf(e.startTime);
      if (!home || !away || !Number.isFinite(kickoff) || kickoff < now) continue;
      state.fixtures[e.id] = { id: e.id, league: L.league, title: e.title ?? `${tm[1]} vs. ${tm[2]}`, kickoff, home, away, homeAsk: wins[hi].bestAsk ?? null, awayAsk: wins[ai].bestAsk ?? null, pxAt: now };
    }
  }
  for (const [k, f] of Object.entries(state.fixtures)) if (f.kickoff < now - 3 * 86400_000) delete state.fixtures[k];
}
async function footballTick() {
  const now = Date.now();
  for (const f of Object.values(state.fixtures)) {
    if (f.done || now < f.kickoff - 12 * 60_000) continue;
    f.done = true;
    if (now > f.kickoff - 8 * 60_000) {
      f.note = "missed the 12-8 min window";
      continue;
    }
    const [hb, ab] = await Promise.all([book(f.home.token).catch(() => null), book(f.away.token).catch(() => null)]);
    Object.assign(f, { homeAsk: hb?.bestAsk ?? null, awayAsk: ab?.bestAsk ?? null, pxAt: now });
    const look = (rule: string, sd: Side, bk: Book | null, lo: number, hi: number) => {
      const ask = bk?.bestAsk;
      if (!bk || ask == null || ask < lo - 1e-9 || ask > hi + 1e-9) return;
      const depth = bk.asks.filter((a) => a.price <= ask + 0.01 + 1e-9).reduce((s, a) => s + a.price * a.size, 0);
      const spread = bk.bestBid != null ? ask - bk.bestBid : null;
      const extra: Record<string, unknown> = { league: f.league, kickoff: f.kickoff, team: sd.team, bid: bk.bestBid, ask, spread, depth1c: depth, homeAsk: hb?.bestAsk ?? null, awayAsk: ab?.bestAsk ?? null };
      const skip = spread == null || spread > 0.03 + 1e-9 ? `spread ${spread == null ? "no bid" : Math.round(spread * 100) + "c"}` : depth < STAKE ? `depth $${depth.toFixed(2)} at ask+1c` : null;
      if (skip) {
        extra.skip = skip;
        signal(rule, f.title, false, extra);
        f.note = `skipped: ${skip}`;
        return;
      }
      const tr = enter(rule, { marketId: sd.id, title: f.title, outcome: sd.team, idx: 0, token: sd.token, feeRate: sd.feeRate }, bk, ask + 0.01, extra);
      signal(rule, f.title, Boolean(tr), extra);
      f.note = tr ? `bought ${sd.team} at ${Math.round(ask * 100)}c` : "in band, no fill";
    };
    if (f.league === "laliga") {
      look("football-laliga-home", f.home, hb, 0.65, 0.8);
      if (hb?.bestAsk != null && hb.bestAsk < 0.65 - 1e-9) look("football-laliga-home55", f.home, hb, 0.55, 0.65);
    } else if (f.league === "portugal") look("football-portugal-home", f.home, hb, 0.65, 0.8);
    else if (f.league === "italy") look("football-italy-away", f.away, ab, 0.65, 0.8);
    f.note ??= `no rule fired: home ${hb?.bestAsk == null ? "—" : Math.round(hb.bestAsk * 100) + "c"}, away ${ab?.bestAsk == null ? "—" : Math.round(ab.bestAsk * 100) + "c"}`;
  }
}

// ---------- Jev sizing (enrique 7 Nov 2026: Jev decides the stake on every bet, all categories) ----------
// Spec: /mnt/project-files/reviews/jev-sizing-spec.md. Paper: the flat $5 trade is kept; Jev's multiplier is logged on it.
const RULE_TEXT: Record<string, [string, string]> = {
  "esports-map1": ["esports", "Bo3 CS2/LoL/Valorant match: after map 1, buy the map-1 winner's match share when its ask is 8+ pts under a map-strength model (pre-match price -> per-map chance q; model = 1-(1-q)^2), 60-120 s after map 1 ends; hold to the match result. Backtest: +3.1c/share out of sample over 171 matches."],
  "esports-fav-shadow": ["esports", "Bo3 esports shadow: the pre-match favourite won map 1 but its match price rose under 5 pts and is under 90c; buy it, hold to the match result."],
  "esports-lol-fav90": ["esports", "LoL match favourite 90-98c, 60-10 min before the start: $5 at the ask when the spread is 3c or less and $25+ rests at the ask; one bet per match, hold to settlement. Backtest 324 matches 96.6% won +4.0c/share on mids (Aug +0.5c, Sep +2.4c, Oct -1.5c)."],
  "esports-cs2-fav90": ["esports", "CS2 match favourite 90-98c, same rule as esports-lol-fav90 (shadow; backtest 324 matches +1.4c, 2c spread)."],
  "esports-map1-dota": ["esports", "Dota 2 Bo3 shadow of the map-1 under-reaction rule (buy the map-1 winner when the match ask is 8+ pts under the map model)."],
  "gold-momentum": ["indices", "Gold daily up/down: the first time a side asks 55-70c with 4+ hours to the 17:00 New York close, buy the higher-priced side; hold to settlement. Backtest: 69% won, +8.1c/share over 142 days."],
  "spx-underdog": ["indices", "S&P 500 daily up/down control: the first time a side asks 30-45c with 4+ hours to the 16:00 New York close, buy the cheaper side; expected about break-even."],
  "spy-underdog": ["indices", "SPY daily up/down control: buy the cheaper side when it first asks 30-45c with 4+ hours to the close; expected about break-even."],
  "election-lock-taker": ["politics", "Election favourite lock: a binary election market ending in 1-7 days whose favourite asks 97-99c with $5+ at the ask; buy the favourite at the ask, hold to resolution. History: favourites at 97-99c held ~+2% over 541 trades."],
  "election-lock-maker": ["politics", "Election favourite lock, maker: bid 1c under a 97-99c favourite ask in a binary election ending in 1-7 days; filled if the ask reaches the bid within 6 h."],
  "football-laliga-home": ["football", "La Liga: buy the home team to win when its ask is 65-80c 10 minutes before kickoff; hold to the result. Ten seasons of bookmaker prices: +7.6c per $1 over 462 matches, 10 of 11 seasons positive; Polymarket 2024-26: 54 bets, 83% won, +9.4c/share."],
  "football-portugal-home": ["football", "Portugal Primeira Liga shadow: buy the home favourite at 65-80c 10 minutes before kickoff; bookmaker history +8.0c per $1 over 311 matches, Polymarket sample -5.9c (24)."],
  "football-italy-away": ["football", "Serie A shadow: buy the away favourite at 65-80c 10 minutes before kickoff; bookmaker history +9.4c per $1 over 189 matches."],
  "tennis-wta-fav90": ["tennis", "WTA singles: 10 minutes before the scheduled start, buy the favourite when its mid is 90-95c and the ask is within 2c of mid (skip if the price moved over 5 pts in the last 10 minutes); hold to the result. Backtest: 298 bets, 96.0% won against an average 92.5c price, +3.0c/share after fee and 2c slip; ATP and ITF in the same band were negative."],
  "tennis-atp-fav90": ["tennis", "ATP shadow of the WTA 90-95c favourite rule (negative in backtest)."],
  "tennis-wta-fav85": ["tennis", "WTA 85-90c favourite shadow."],
  "tennis-itf-fav90": ["tennis", "ITF 90-95c favourite shadow (negative in backtest)."],
  "cricket-fav10": ["cricket", "Cricket match winner (2-way moneyline, any competition): 10 minutes before the scheduled start, buy the favourite whose best ask is 65-95c, $5 walking the book up to 2c over the best ask; hold to the result. Backtest on real buy fills May 2025-Nov 2026: 386 matches, 85.5% won, +5.1c/share; underdogs are overpriced (longshot bias)."],
  "cricket-fav60": ["cricket", "Cricket favourite 65-95c, 60 minutes before the start (shadow; backtest +3.8c over 276)."],
  "cricket-dog-control": ["cricket", "Cricket underdog control: buy the underdog asking 20-35c 10 minutes before the start (backtest -6c, expected to lose)."],
  "tennis-fav95": ["tennis", "Any tour, favourite at 95-99c, 10 minutes before the start (shadow)."],
  "weather-fav16": ["weather", "Highest-temperature city market: at 16:00 station local time buy the leading temperature bucket when its mid is 50-85c and the ask is within 2c of mid; hold to settlement (highest routine METAR reading of the local day). Backtest 43 days: 398 trades, 75.6% won, +3.7c/share after 2c slip and fees; positive 5 of 7 weeks."],
  "weather-fav16-wide": ["weather", "Shadow of the 16:00 afternoon-favourite weather rule that accepts an ask up to 5c over the mid (the main rule needs 2c and skipped every signal in its first two days)."],
  "weather-fav15": ["weather", "Shadow of the afternoon-favourite weather rule at 15:00 local: backtest 785 trades, 72% won, +1.9c/share."],
  "tennis-fav90-mid": ["tennis", "Research batch 2 (10 Nov 2026): mid-bid twin of the tennis favourite rules. At T-30 min rest $5 one tick under the ask of the 90-99c favourite, cancel at the start, hold a fill. Batch 1 says such bids lose (fills won 59% vs 77% unfilled over 935 book paths); this measures it live."],
  "nba-fav85": ["usports", "Research batch 2 (10 Nov 2026): NBA moneyline favourite asking 85-95c at T-10 min, take the ask when the spread is 1c or less and $25+ rests at the ask; hold to settlement; sits out after 3 losses in 7 days. History on mids +1c slip +fee: 156 bets 94.9% won vs 88.6c implied, +5.2c/share, 11 of 14 months positive."],
  "cbb-fav85": ["usports", "Control: college basketball favourite 85-95c, same rule as nba-fav85 (history -2.0c/share over 299)."],
  "nfl-fav85": ["usports", "Shadow: NFL favourite 85-95c, same rule as nba-fav85."],
  "us-prematch-fav-bid": ["usports", "Round 340 (11 Nov 2026 06:15 KST): the top-traders read of 7 sports says the wallets that win before the start are the ones with RESTING orders (6 of 7 sports), while pre-match takers lose; our 85-95c favourite rules have found 0 games in band in a day. This rests $5 one tick under the ask of the favourite at 55-85c, 30 min before the start, NBA, college basketball and NFL, cancelled at the start, a fill held to the result. Our own batch 1 said such bids lose on tennis (fills come when the price is falling), so this is a test of the claim, not a belief."],
  "us-prematch-dog-bid": ["usports", "Control for us-prematch-fav-bid: the same resting bid on the underdog of the same games (15-45c). If resting orders win only because of the side, the two will differ; if they win because of the spread saved, both should be near zero or better."],
  "nba-fav85-mid": ["usports", "Mid-bid twin of nba-fav85: at T-30 min rest $5 one tick under the favourite's ask (books are 1c, so this joins the bid), cancel at tip-off, hold a fill."],
  "weather-fav16-mid": ["weather", "Round 307 (9 Nov 2026 21:15 KST): maker shadow of the 16:00 rule. In three days the taker rules saw 21 signals and took none (asks 65-91c, 4c+ over mid; the mid+5c copy also took none), so this one rests a $5 bid AT the mid of the leading bucket for up to 6 h and books the trade only if the ask comes down to it. Measures whether a patient bid can trade the weather edge at all, and what it wins when it does."],
  "weather-dayahead-all": ["weather", "11 Nov 2026 02:50 KST (top-traders lead: one wallet, one week, +$3,269 on $10,573 as a pure maker buying 10-50c buckets 24-48 h before the close; a lead, not proof): the day before, at 12:00 station local time (36 h before the market day ends), rest a $5 bid at the best bid on up to 3 temperature buckets asking 10-50c; never take; cancel 20 h before the close; hold fills to settlement. This is the no-forecast baseline; the copy that only bids where a weather-model forecast disagrees with the price is still to come. Tickets win under half the time by design."],
  "weather-dayahead-yes": ["weather", "Round 341 (11 Nov 2026 07:15 KST): forecast copy of weather-dayahead-all. The day before, at 12:00 station local time, read the free Open-Meteo ensemble forecast (about 80 model runs) of the day's highest temperature at the station and count the share of runs landing in each bucket; rest a $5 bid at the best bid only on buckets asking 10-50c where that share is 15+ points over the ask; never take; cancel 20 h before the close; hold fills. Untested assumptions: the model grid point matches the airport thermometer, and raw model shares are honest odds. The forecast and the asks are logged for every city-day so both can be checked."],
  "wx-no-maker": ["weather", "11 Nov 2026 (research thread 'Find a strategy worth pursuing', reviews/strategy-worth-pursuing-2026-11-11.md): bet AGAINST the unlikely temperature buckets as a maker. 36 h before the market day ends, for every bucket whose YES trades at 8-30c with a spread of 5c or less, rest a $5 bid on NO at the best NO bid; every 10 min re-join the best bid while it is within 2c of the first; cancel 12 h before the end; hold fills. A fill counts only from real trades at our price after the shares that were ahead of us traded. History 19 Oct-8 Nov, 1,823 bucket-days: NO won 85.5% at 81.7c, +4.6% if every bid fills, -0.1% if only the bad fills happen. Bar 300+ fills, 84%+ won, net over 0; killed at 300 fills with net at or under 0 or a 30-minute markout worse than -1.5c."],
  "wx-no-maker-815": ["weather", "Twin of wx-no-maker counting only buckets whose YES was 8-15c when the bid was placed."],
  "wx-no-maker-1530": ["weather", "11 Nov 2026 19:45 KST: the other half of wx-no-maker, counting only buckets whose YES was above 15c and up to 30c when the bid was placed. With the 8-15c twin it shows which price band carries the result (a NO at 85-92c loses 6-11 wins on one miss; a NO at 70-85c loses 2-6). Same bar as the parent."],
  "prematch-rest-clv-tennis": ["tennis", "11 Nov 2026 (research thread 'Find a strategy worth pursuing'): from 6 h before a tennis match, rest a $3 bid at the best bid on BOTH players, leave it, cancel 20 min before the start; a fill counts only from real trades at our price after the shares ahead of us traded. Each fill is scored against the average traded price of the last 20 min before the start (the closing price) as well as the result. Research: resting orders averaged +0.6% against the close on tennis and esports. Bar 300+ fills averaging +0.5% against the close."],
  "prematch-rest-clv-esports": ["esports", "The same pre-match resting bids on both teams of esports match-winner markets, scored against the closing price (see prematch-rest-clv-tennis)."],
  "weather-fav16-hi": ["weather", "10 Nov 2026 17:10 KST: 16:00 rule for city-days whose leading bucket is already 85-95c (the main rule only takes 50-85c and dropped these without a line). Buys the ask when it is within 2c of mid. No backtest for this band: it measures whether late near-certain buckets pay after the spread."],
  "weather-fav15-ask1": ["weather", "10 Nov 2026 17:10 KST: 15:00 copy of the 1c-under-ask maker shadow. The 15:00 taker saw 22 signals in three days and took 1 (asks 4c+ over mid), so this rests a $5 bid 1c under the ask for up to 6 h on every 15:00 signal."],
  "weather-fav16-ask1": ["weather", "Round 317 (10 Nov 2026 07:10 KST): maker shadow of the 16:00 rule bidding 1c UNDER THE ASK for up to 6 h. The mid-bid shadow got its first fills on 10 Nov (Madrid bid 61c vs ask 70c, Buenos Aires 62c vs 75c): both filled only after the ask slid 9-13c down to the bid, so a mid bid in a 10-25c-wide weather book buys mostly when the market has turned against the bucket. This twin fills on a 1c dip instead and gives up the price; the two together say whether weather can be traded as a maker at all."],
  "football-laliga-home55": ["football", "La Liga control: buy the home team at 55-65c 10 minutes before kickoff; expected about break-even (+0.3c in bookmaker history)."],
};
function record(rule: string): string {
  const st = state.trades.filter((t) => t.rule === rule && t.pnl != null);
  if (!st.length) return "live paper: no settled bets yet";
  const won = st.filter((t) => t.won).length;
  const c = (st.reduce((a, t) => a + (t.pnl ?? 0), 0) / st.reduce((a, t) => a + t.shares, 0)) * 100;
  return `live paper: ${st.length} settled, ${Math.round((100 * won) / st.length)}% won, ${c >= 0 ? "+" : ""}${c.toFixed(1)}c/share; last 10: ${st.slice(-10).map((t) => (t.won ? "W" : t.won === false ? "L" : "T")).join("")}`;
}
async function jevTick() {
  for (const tr of state.trades.filter((t) => t.jevPending).slice(0, 5)) {
    const [cat, text] = RULE_TEXT[tr.rule] ?? ["other", tr.rule];
    const q = tr.title.replace(/\(.*?\)|-.*$|Up or Down.*$/gi, "").replace(/^(Counter-Strike|Valorant|LoL|League of Legends|Dota 2):\s*/i, "").trim() || tr.title;
    const news = jevKey() ? await headlines(q) : [];
    const { extra, ...bet } = tr;
    tr.jev = await jevStake({
      category: cat,
      market: tr.title,
      event: tr.title,
      proposed_bet: { buy: tr.outcome, price: bet.ask, avg_fill: bet.avg, best_bid: extra?.bid ?? null, depth_usd_at_ask: extra?.depth1c ?? extra?.depth2c ?? extra?.sizeAtAsk ?? null, costs: `taker fee ${tr.feeRate} x p x (1-p) per share`, default_stake_usd: 5, max_stake_usd: 10, rule: text },
      rule_track_record: record(tr.rule),
      market_context: { price_now: bet.ask },
      facts: extra ?? {},
      news_headlines: news,
      context: JEV_CONTEXT,
    });
    delete tr.jevPending;
    if (tr.jev.mult != null) log(`jev ${tr.rule} ${tr.title}: ${tr.jev.pick} (${tr.jev.ms} ms)`);
  }
}

// ---------- weather (thesis reviews/weather-thesis-2026-11-07.md, 8 Nov 00:50 KST) ----------
// "Highest temperature in <city> on <date>?" events (11 buckets). At 16:00 station local time (shadow: 15:00) find the
// bucket with the highest mid; if that mid is 50-85c and its ask <= mid + 2c, take the ask ($5 walking the book, fee
// 0.05 x p(1-p)), hold to settlement. Hong Kong excluded (resolves on the HK Observatory, not METAR). Backtest 16:00:
// 398 trades, 75.6% won, +3.7c/share after 2c slip + fee, 43 days.
const WX_TZ: Record<string, string> = { CYYZ: "America/Toronto", EDDM: "Europe/Berlin", EFHK: "Europe/Helsinki", EGLC: "Europe/London", EHAM: "Europe/Amsterdam", EPWA: "Europe/Warsaw", FACT: "Africa/Johannesburg", KATL: "America/New_York", KAUS: "America/Chicago", KDAL: "America/Chicago", KDEN: "America/Denver", KHOU: "America/Chicago", KLAX: "America/Los_Angeles", KLGA: "America/New_York", KMIA: "America/New_York", KORD: "America/Chicago", KSEA: "America/Los_Angeles", KSFO: "America/Los_Angeles", LEMD: "Europe/Madrid", LFPB: "Europe/Paris", LIMC: "Europe/Rome", LLBG: "Asia/Jerusalem", LTAC: "Europe/Istanbul", LTFM: "Europe/Istanbul", MMMX: "America/Mexico_City", MPMG: "America/Panama", NZWN: "Pacific/Auckland", OEJN: "Asia/Riyadh", OPKC: "Asia/Karachi", RCSS: "Asia/Taipei", RJTT: "Asia/Tokyo", RKPK: "Asia/Seoul", RKSI: "Asia/Seoul", RPLL: "Asia/Manila", SAEZ: "America/Argentina/Buenos_Aires", SBGR: "America/Sao_Paulo", UUWW: "Europe/Moscow", VILK: "Asia/Kolkata", WMKK: "Asia/Kuala_Lumpur", WSSS: "Asia/Singapore", ZBAA: "Asia/Shanghai", ZGGG: "Asia/Shanghai", ZGSZ: "Asia/Shanghai", ZHHH: "Asia/Shanghai", ZSPD: "Asia/Shanghai", ZSQD: "Asia/Shanghai", ZUCK: "Asia/Shanghai", ZUUU: "Asia/Shanghai" };
// 8 Nov 2026 15:10 KST: in two days the 2c rule skipped all 7 signals (asks 68-95c, spreads over 4c), so a shadow at
// 16:00 accepts an ask up to 5c over mid, walking the book to that ask, to measure what the spread filter costs.
const WX_RULES: { rule: string; hour: number; slip?: number; lo?: number; hi?: number }[] = [
  { rule: "weather-fav16", hour: 16 },
  { rule: "weather-fav15", hour: 15 },
  { rule: "weather-fav16-wide", hour: 16, slip: 0.05 },
  // 10 Nov 2026 17:10 KST: leader already 85-95c at 16:00 (the main rule drops these without a line).
  { rule: "weather-fav16-hi", hour: 16, lo: 0.85, hi: 0.95 },
];
type GEventWx = GEvent & { description?: string };
// Station coordinates (airport reference points, 0.01 degree) for the day-ahead forecast rule.
const WX_LL: Record<string, [number, number]> = { CYYZ: [43.68, -79.63], EDDM: [48.35, 11.79], EFHK: [60.32, 24.96], EGLC: [51.51, 0.05], EHAM: [52.31, 4.76], EPWA: [52.17, 20.97], FACT: [-33.97, 18.6], KATL: [33.64, -84.43], KAUS: [30.19, -97.67], KDAL: [32.85, -96.85], KDEN: [39.86, -104.67], KHOU: [29.65, -95.28], KLAX: [33.94, -118.41], KLGA: [40.78, -73.87], KMIA: [25.79, -80.29], KORD: [41.98, -87.9], KSEA: [47.45, -122.31], KSFO: [37.62, -122.37], LEMD: [40.47, -3.56], LFPB: [48.97, 2.44], LIMC: [45.63, 8.72], LLBG: [32.01, 34.89], LTAC: [40.13, 32.99], LTFM: [41.26, 28.74], MMMX: [19.44, -99.07], MPMG: [8.97, -79.56], NZWN: [-41.33, 174.81], OEJN: [21.68, 39.16], OPKC: [24.91, 67.16], RCSS: [25.07, 121.55], RJTT: [35.55, 139.78], RKPK: [35.18, 128.94], RKSI: [37.46, 126.44], RPLL: [14.51, 121.02], SAEZ: [-34.82, -58.54], SBGR: [-23.43, -46.47], UUWW: [55.6, 37.27], VILK: [26.76, 80.89], WMKK: [2.74, 101.7], WSSS: [1.36, 103.99], ZBAA: [40.08, 116.58], ZGGG: [23.39, 113.3], ZGSZ: [22.64, 113.81], ZHHH: [30.78, 114.21], ZSPD: [31.14, 121.81], ZSQD: [36.36, 120.09], ZUCK: [29.72, 106.64], ZUUU: [30.58, 103.95] };
/** Share of forecast members whose rounded daily maximum (given in Celsius) lands in the bucket named by `label`
 *  ("24°C", "70-71°F", "15°C or below", "80°F or higher"). null when the label cannot be read. */
export function wxBucketProb(label: string, maxC: number[]): number | null {
  if (!maxC.length) return null;
  const xs = maxC.map((c) => Math.round(/°\s*F/i.test(label) ? (c * 9) / 5 + 32 : c));
  const share = (ok: (x: number) => boolean) => xs.filter(ok).length / xs.length;
  const range = /(-?\d+)\s*[-\u2013]\s*(\d+)\s*°/.exec(label);
  if (range) return share((x) => x >= Number(range[1]) && x <= Number(range[2]));
  const one = /(-?\d+)\s*°/.exec(label);
  if (!one) return null;
  const n = Number(one[1]);
  if (/below|lower|less/i.test(label)) return share((x) => x <= n);
  if (/higher|above|more/i.test(label)) return share((x) => x >= n);
  return share((x) => x === n);
}
/** Daily maximum (Celsius) of every ensemble member for one station-day, from the free Open-Meteo ensemble API. */
async function wxEnsemble(ev: WxEvent): Promise<number[]> {
  const ll = WX_LL[ev.station];
  if (!ll) return [];
  const day = `${ev.date[0]}-${String(ev.date[1]).padStart(2, "0")}-${String(ev.date[2]).padStart(2, "0")}`;
  const r = await getJson<{ hourly?: Record<string, (number | null)[]> }>(`https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${ll[0]}&longitude=${ll[1]}&hourly=temperature_2m&models=gfs_seamless,ecmwf_ifs025&start_date=${day}&end_date=${day}&timezone=${encodeURIComponent(ev.tz)}`, 20_000);
  const out: number[] = [];
  for (const [k, v] of Object.entries(r.hourly ?? {})) {
    if (!k.startsWith("temperature_2m") || !Array.isArray(v)) continue;
    const xs = v.filter((x): x is number => typeof x === "number");
    if (xs.length >= 20) out.push(Math.max(...xs));
  }
  return out;
}
async function weatherRefresh() {
  let evs: GEventWx[];
  try {
    evs = (await pages(`${GAMMA}/events?tag_slug=highest-temperature&closed=false`, 2000)) as GEventWx[];
  } catch (e) {
    log(`weather list failed: ${(e as Error).message}`);
    return;
  }
  const seen = new Set<string>();
  for (const e of evs) {
    if (!e.id || !/^Highest temperature in /i.test(e.title ?? "") || /hong kong/i.test(e.title ?? "")) continue;
    seen.add(e.id);
    if (state.wx[e.id]?.buckets.every((b) => b.no && b.cond)) continue; // older entries lack the NO token: rebuilt once
    const station = /\(([A-Z0-9]{4})\)/.exec(e.description ?? "")?.[1];
    const date = slugDate(e.slug ?? "");
    const tz = station ? WX_TZ[station] : undefined;
    if (!station || !tz || !date) continue;
    const buckets = (e.markets ?? [])
      .map((m) => {
        const toks = jl<string[]>(m.clobTokenIds, []);
        const yes = jl<string[]>(m.outcomes, []).findIndex((o) => /^yes$/i.test(o));
        return m.id && toks.length === 2 && yes >= 0 ? { id: m.id, token: toks[yes], label: m.groupItemTitle ?? m.question ?? m.id, feeRate: Number(m.feeSchedule?.rate ?? 0.05), no: toks[1 - yes], noIdx: 1 - yes, cond: m.conditionId } : null;
      })
      .filter((b): b is NonNullable<typeof b> => b != null);
    if (buckets.length >= 3) state.wx[e.id] = { id: e.id, title: e.title ?? e.id, station, tz, date, buckets };
  }
  for (const k of Object.keys(state.wx)) if (!seen.has(k)) delete state.wx[k];
}
/**
 * Strict fill for a resting NO bid from taker trade rows of its market (oldest first is not assumed). A taker SELL of NO
 * at or under our bid, or a taker BUY of YES at or over 1 - our bid, reaches our level; at exactly our price the shares
 * that were ahead of us must trade first; a trade through our price fills us whatever was ahead. True when the whole
 * order has filled. Mutates ahead, got and seen (seconds).
 */
export function noMakerFill(mk: { bid: number; ahead: number; got: number; shares: number; seen: number; yes: string; no: string }, rows: { side?: string; token_id?: string; size?: number | string; price?: number | string; timestamp?: number | string }[]): boolean {
  const xs = rows
    .map((r) => ({ ts: Number(r.timestamp) > 1e12 ? Math.floor(Number(r.timestamp) / 1000) : Number(r.timestamp), price: Number(r.price), size: Number(r.size), side: String(r.side ?? "").toUpperCase(), tok: r.token_id }))
    .filter((r) => Number.isFinite(r.ts) && r.ts > mk.seen && r.size > 0 && r.price > 0)
    .sort((a, b) => a.ts - b.ts);
  for (const r of xs) {
    mk.seen = Math.max(mk.seen, r.ts);
    const lvl = r.tok === mk.no && r.side === "SELL" ? r.price : r.tok === mk.yes && r.side === "BUY" ? Math.round((1 - r.price) * 1000) / 1000 : null;
    if (lvl == null || lvl > mk.bid + 1e-9) continue;
    let size = r.size;
    if (Math.abs(lvl - mk.bid) < 1e-9) {
      const eaten = Math.min(mk.ahead, size);
      mk.ahead -= eaten;
      size -= eaten;
    } else mk.ahead = 0;
    mk.got += size;
  }
  return mk.got >= mk.shares - 1e-9;
}
/** A resting paper bid on one outcome of a match-winner market (prematch-rest-clv). */
type RestBid = { rule: string; marketId: string; cond: string; title: string; outcome: string; idx: number; token: string; other: string; bid: number; ahead: number; got: number; shares: number; t: number; until: number; seen: number; start: number };
type TapeRow = Parameters<typeof noMakerFill>[1][number];
const tapeOf = async (cond: string) => (await getJson<{ data?: TapeRow[] }>(`https://data-api.polymarket.com/v2/trades?condition=${cond}&limit=1000&taker_only=true`).catch(() => null))?.data ?? null;
/** Size-weighted average price of `token` over the trades between `from` and `to` (seconds); trades in the other token count at 1 - price. Null with fewer than `min` prints, so one stray print never sets the close. */
export function closeVwap(rows: TapeRow[], token: string, other: string, from: number, to: number, min = 5): number | null {
  let v = 0;
  let n = 0;
  let k = 0;
  for (const r of rows) {
    const ts = Number(r.timestamp) > 1e12 ? Math.floor(Number(r.timestamp) / 1000) : Number(r.timestamp);
    const price = Number(r.price);
    const size = Number(r.size);
    if (!(ts >= from && ts <= to) || !(size > 0) || !(price > 0)) continue;
    const p = r.token_id === token ? price : r.token_id === other ? 1 - price : null;
    if (p == null) continue;
    v += p * size;
    n += size;
    k += 1;
  }
  return n > 0 && k >= min ? Math.round((v / n) * 10000) / 10000 : null;
}
/**
 * prematch-rest-clv (11 Nov 2026, research thread 'Find a strategy worth pursuing'): tennis and esports match-winner
 * markets, from 6 h before the start: a $3 bid at the best bid on BOTH outcomes, left where it is, cancelled 20 min
 * before the start. Fills by the strict tape model. Every fill is scored against the size-weighted price of the last
 * 20 min before the start (the closing price) as well as the result.
 */
async function restTick() {
  const now = Date.now();
  // 1. new bids (at most 15 markets a tick)
  const cands: { rule: string; m: { id: string; title: string; start: number; tokens: string[]; outcomes: string[] } }[] = [
    ...Object.values(state.tennis).map((m) => ({ rule: "prematch-rest-clv-tennis", m })),
    ...Object.values(state.matches).map((m) => ({ rule: "prematch-rest-clv-esports", m })),
  ];
  let placed = 0;
  for (const { rule, m } of cands) {
    const key = `prematch-rest-clv|${m.id}`;
    if (placed >= 15 || state.done[key] || m.tokens.length !== 2 || m.start - now > 6 * 3600_000 || m.start - now < 40 * 60_000) continue;
    state.done[key] = now;
    placed += 1;
    const cond = (await getJson<GMarket>(`${GAMMA}/markets/${m.id}`).catch(() => null))?.conditionId;
    const books = await Promise.all(m.tokens.map((k) => book(k).catch(() => null)));
    if (!cond) continue;
    books.forEach((bk, i) => {
      if (!bk || bk.bestBid == null || bk.bestAsk == null || bk.bestBid < 0.03 || bk.bestBid > 0.97 || bk.bestAsk - bk.bestBid > 0.1) return;
      const ahead = bk.bids.filter((b) => Math.abs(b.price - bk.bestBid!) < 1e-9).reduce((x, b) => x + b.size, 0);
      state.rest.push({ rule, marketId: m.id, cond, title: m.title, outcome: m.outcomes[i] ?? String(i), idx: i, token: m.tokens[i], other: m.tokens[1 - i], bid: bk.bestBid, ahead, got: 0, shares: 3 / bk.bestBid, t: now, until: m.start - 20 * 60_000, seen: Math.floor(now / 1000), start: m.start });
    });
  }
  // 2. fills, one tape read per market
  const tapes = new Map<string, TapeRow[] | null>();
  const keep: RestBid[] = [];
  for (const rb of state.rest) {
    if (now >= rb.until) continue; // cancelled unfilled
    if (!tapes.has(rb.cond)) tapes.set(rb.cond, await tapeOf(rb.cond));
    const rows = tapes.get(rb.cond);
    const view = { bid: rb.bid, ahead: rb.ahead, got: rb.got, shares: rb.shares, seen: rb.seen, yes: rb.other, no: rb.token };
    const filled = rows ? noMakerFill(view, rows) : false;
    rb.ahead = view.ahead;
    rb.got = view.got;
    rb.seen = view.seen;
    if (!filled) {
      keep.push(rb);
      continue;
    }
    state.trades.push({ rule: rb.rule, marketId: rb.marketId, title: rb.title, outcome: rb.outcome, idx: rb.idx, token: rb.token, t: now, ask: rb.bid, avg: rb.bid, shares: rb.shares, cost: 3, fee: 0, fillable: true, feeRate: 0, extra: { bidAt: rb.t, fillMin: Math.round((now - rb.t) / 60_000), cond: rb.cond, other: rb.other, start: rb.start, close: null, clv: null } });
    log(`${rb.rule} ${rb.title} ${rb.outcome}: bid filled at ${Math.round(rb.bid * 1000) / 10}c`);
  }
  state.rest = keep;
  // 3. closing price for fills whose match has started
  for (const t of state.trades) {
    const x = t.extra;
    if (!t.rule.startsWith("prematch-rest-clv") || !x || x.clv != null || typeof x.start !== "number" || now < x.start + 60_000) continue;
    if (now > x.start + 3 * 3600_000) {
      x.clv = "missed";
      continue;
    }
    const cond = String(x.cond);
    if (!tapes.has(cond)) tapes.set(cond, await tapeOf(cond));
    const rows = tapes.get(cond);
    if (!rows) continue;
    const close = closeVwap(rows, t.token, String(x.other), Math.floor(x.start / 1000) - 1200, Math.floor(x.start / 1000));
    if (close == null || t.avg == null) {
      if (now > x.start + 3600_000) x.clv = "under 5 prints";
      continue;
    }
    x.close = close;
    x.clv = Math.round((close - t.avg) * 10000) / 10000;
  }
}
/** wx-no-maker: every 10 min read the tape and the book of each resting NO bid; fill, re-join or cancel. */
async function noMakerTick() {
  const now = Date.now();
  const keep: NoMaker[] = [];
  const one = async (mk: NoMaker) => {
    if (now >= mk.until) {
      signal("wx-no-maker", mk.title, false, { unfilled: true, bucket: mk.label, bid: mk.bid });
      return;
    }
    const tape = await getJson<{ data?: Parameters<typeof noMakerFill>[1] }>(`https://data-api.polymarket.com/v2/trades?condition=${mk.cond}&limit=1000&taker_only=true`).catch(() => null);
    if (tape && Array.isArray(tape.data) && noMakerFill(mk, tape.data)) {
      const bk = await book(mk.no).catch(() => null);
      for (const rule of mk.twin ? ["wx-no-maker", "wx-no-maker-815"] : ["wx-no-maker", "wx-no-maker-1530"])
        state.trades.push({ rule, marketId: mk.marketId, title: mk.title, outcome: `No (${mk.label})`, idx: mk.noIdx, token: mk.no, t: now, ask: bk?.bestAsk ?? mk.bid, avg: mk.bid, shares: mk.shares, cost: mk.shares * mk.bid, fee: 0, fillable: true, feeRate: 0, extra: { bidAt: mk.t, fillMin: Math.round((now - mk.t) / 60_000), yesMid0: mk.yesMid0, bid0: mk.bid0, midFill: bk?.mid ?? null, mk30: null } });
      log(`wx-no-maker ${mk.title} ${mk.label}: NO bid filled at ${Math.round(mk.bid * 1000) / 10}c`);
      return;
    }
    // Re-join the best NO bid (1 - best YES ask) only while it is within 2c of the first bid; a new price is a new queue.
    const yb = await book(mk.yes).catch(() => null);
    if (yb?.bestAsk != null) {
      const nb = Math.round((1 - yb.bestAsk) * 1000) / 1000;
      if (Math.abs(nb - mk.bid) > 1e-9 && Math.abs(nb - mk.bid0) <= 0.02 + 1e-9) {
        mk.bid = nb;
        mk.ahead = yb.asks.filter((a) => Math.abs(a.price - yb.bestAsk!) < 1e-9).reduce((x, a) => x + a.size, 0);
        mk.got = 0;
        mk.shares = 5 / nb;
      }
    }
    keep.push(mk);
  };
  for (let i = 0; i < state.nomk.length; i += 6) await Promise.all(state.nomk.slice(i, i + 6).map((mk) => one(mk).catch(() => void keep.push(mk))));
  state.nomk = keep;
  // The price 30 min after each fill (markout): NO mid then minus the price paid.
  for (const t of state.trades) {
    if (!t.rule.startsWith("wx-no-maker") || !t.extra || t.extra.mk30 != null || now - t.t < 30 * 60_000) continue;
    if (now - t.t > 3 * 3600_000) {
      t.extra.mk30 = "missed";
      continue;
    }
    const bk = await book(t.token).catch(() => null);
    if (bk?.mid != null && t.avg != null) t.extra.mk30 = Math.round((bk.mid - t.avg) * 1000) / 1000;
  }
}
async function weatherTick() {
  const now = Date.now();
  for (const ev of Object.values(state.wx)) {
    {
      // wx-no-maker: one look per city-day, 36-24 h before the market day ends (see RULES).
      const key = `wx-no-maker|${ev.id}`;
      const day0 = zonedUtc(ev.date[0], ev.date[1], ev.date[2], 0, ev.tz);
      if (!state.done[key] && now >= day0 - 12 * 3600_000 && now < day0 && ev.buckets.every((b) => b.no && b.cond)) {
        state.done[key] = now;
        const books = await Promise.all(ev.buckets.map((b) => book(b.token).catch(() => null)));
        let n = 0;
        ev.buckets.forEach((bu, i) => {
          const bk = books[i];
          if (!bk || bk.mid == null || bk.bestAsk == null || bk.bestBid == null) return;
          if (bk.mid < 0.08 - 1e-9 || bk.mid > 0.3 + 1e-9 || bk.bestAsk - bk.bestBid > 0.05 + 1e-9) return;
          const bid = Math.round((1 - bk.bestAsk) * 1000) / 1000;
          const ahead = bk.asks.filter((a) => Math.abs(a.price - bk.bestAsk!) < 1e-9).reduce((x, a) => x + a.size, 0);
          state.nomk.push({ marketId: bu.id, cond: bu.cond!, title: ev.title, label: bu.label, yes: bu.token, no: bu.no!, noIdx: bu.noIdx!, bid, bid0: bid, ahead, got: 0, shares: 5 / bid, t: now, until: day0 + 12 * 3600_000, seen: Math.floor(now / 1000), yesMid0: bk.mid, twin: bk.mid <= 0.15 + 1e-9 });
          n += 1;
        });
        signal("wx-no-maker", ev.title, false, { station: ev.station, bids: n, ...(n ? {} : { skip: "no bucket with YES at 8-30c and a spread of 5c or less" }) });
      }
    }
    {
      // weather-dayahead-all: one look per city-day, 36-24 h before the market day ends (see RULES).
      const key = `weather-dayahead-all|${ev.id}`;
      const day0 = zonedUtc(ev.date[0], ev.date[1], ev.date[2], 0, ev.tz);
      if (!state.done[key] && now >= day0 - 12 * 3600_000 && now < day0) {
        state.done[key] = now;
        const books = await Promise.all(ev.buckets.map((b) => book(b.token).catch(() => null)));
        const picks = ev.buckets
          .map((bu, i) => ({ bu, bk: books[i] }))
          .filter((x) => x.bk?.bestAsk != null && x.bk.bestBid != null && x.bk.bestAsk >= 0.1 - 1e-9 && x.bk.bestAsk <= 0.5 + 1e-9 && x.bk.bestBid >= 0.05 && x.bk.bestBid < x.bk.bestAsk)
          .sort((a, b) => b.bk!.bestAsk! - a.bk!.bestAsk!)
          .slice(0, 3);
        for (const { bu, bk } of picks) state.makers.push({ rule: "weather-dayahead-all", marketId: bu.id, title: ev.title, outcome: bu.label, idx: 0, token: bu.token, bid: bk!.bestBid!, t: now, feeRate: bu.feeRate, ask: bk!.bestAsk!, until: day0 + 4 * 3600_000, mid: bk!.mid ?? undefined });
        // weather-dayahead-yes: the forecast copy. Bid only where the ensemble's share for a bucket is 15+ points over its ask.
        try {
          const maxC = await wxEnsemble(ev);
          const fc = ev.buckets.map((bu, i) => ({ bu, bk: books[i], p: wxBucketProb(bu.label, maxC) }));
          const take = fc.filter((x) => x.p != null && x.bk?.bestAsk != null && x.bk.bestBid != null && x.bk.bestAsk >= 0.1 - 1e-9 && x.bk.bestAsk <= 0.5 + 1e-9 && x.bk.bestBid >= 0.05 && x.bk.bestBid < x.bk.bestAsk && x.p! - x.bk.bestAsk >= 0.15 - 1e-9);
          for (const { bu, bk } of take) state.makers.push({ rule: "weather-dayahead-yes", marketId: bu.id, title: ev.title, outcome: bu.label, idx: 0, token: bu.token, bid: bk!.bestBid!, t: now, feeRate: bu.feeRate, ask: bk!.bestAsk!, until: day0 + 4 * 3600_000, mid: bk!.mid ?? undefined });
          signal("weather-dayahead-yes", ev.title, false, { station: ev.station, members: maxC.length, forecast: fc.filter((x) => (x.p ?? 0) >= 0.05).map((x) => `${x.bu.label} ${Math.round(x.p! * 100)}% vs ask ${x.bk?.bestAsk != null ? Math.round(x.bk.bestAsk * 100) : "?"}c`), bids: take.map((x) => x.bu.label), ...(take.length ? {} : { skip: maxC.length ? "no bucket 15+ points over its ask at 10-50c" : "no forecast" }) });
        } catch (e) {
          signal("weather-dayahead-yes", ev.title, false, { station: ev.station, skip: `forecast failed: ${(e as Error).message.slice(0, 80)}` });
        }
        signal("weather-dayahead-all", ev.title, false, { station: ev.station, bids: picks.map((x) => `${x.bu.label} ${Math.round(x.bk!.bestBid! * 100)}c`), ...(picks.length ? {} : { skip: "no bucket asking 10-50c" }) });
      }
    }
    for (const { rule, hour, slip = 0.02, lo = 0.5, hi = 0.85 } of WX_RULES) {
      const key = `${rule}|${ev.id}`;
      if (state.done[key]) continue;
      const at = zonedUtc(ev.date[0], ev.date[1], ev.date[2], hour, ev.tz);
      if (now < at) continue;
      state.done[key] = now;
      if (now > at + 15 * 60_000) continue; // missed (logger was down): no look-back
      const books = await Promise.all(ev.buckets.map((b) => book(b.token).catch(() => null)));
      let best = -1;
      books.forEach((b, i) => {
        if (b?.mid != null && (best < 0 || b.mid > books[best]!.mid!)) best = i;
      });
      if (best < 0) continue;
      const bk = books[best]!;
      const bu = ev.buckets[best];
      const mid = bk.mid!;
      const ask = bk.bestAsk!;
      const extra: Record<string, unknown> = { station: ev.station, localHour: hour, bucket: bu.label, mid, bid: bk.bestBid, ask, spread: ask - (bk.bestBid ?? ask), depth2c: bk.asks.filter((a) => a.price <= ask + 0.02 + 1e-9).reduce((x, a) => x + a.price * a.size, 0), mids: books.map((b) => b?.mid ?? null) };
      if (mid < lo - 1e-9 || mid > hi + 1e-9) {
        // 10 Nov 2026: count the city-days the band drops instead of dropping them silently.
        if (rule === "weather-fav16" || rule === "weather-fav15") {
          extra.skip = `leading bucket mid ${Math.round(mid * 100)}c outside 50-85c`;
          signal(rule, ev.title, false, extra);
        }
        continue;
      }
      // 10 Nov 2026 17:10 KST: 15:00 copy of the 1c-under-ask maker shadow.
      if (rule === "weather-fav15" && !state.makers.some((mk) => mk.rule === "weather-fav15-ask1" && mk.marketId === bu.id)) state.makers.push({ rule: "weather-fav15-ask1", marketId: bu.id, title: ev.title, outcome: bu.label, idx: 0, token: bu.token, bid: Math.round((ask - 0.01) * 100) / 100, t: now, feeRate: bu.feeRate, ask });
      // Round 307 (9 Nov 2026): maker shadow, once per event at 16:00: rest a bid at the mid for up to 6 h (makersTick).
      if (rule === "weather-fav16" && !state.makers.some((mk) => mk.rule === "weather-fav16-mid" && mk.marketId === bu.id)) state.makers.push({ rule: "weather-fav16-mid", marketId: bu.id, title: ev.title, outcome: bu.label, idx: 0, token: bu.token, bid: Math.round(mid * 100) / 100, t: now, feeRate: bu.feeRate, ask });
      // Round 317 (10 Nov 2026): second maker shadow, bid 1c under the ask (fills on a 1c dip, not a 10c slide).
      if (rule === "weather-fav16" && !state.makers.some((mk) => mk.rule === "weather-fav16-ask1" && mk.marketId === bu.id)) state.makers.push({ rule: "weather-fav16-ask1", marketId: bu.id, title: ev.title, outcome: bu.label, idx: 0, token: bu.token, bid: Math.round((ask - 0.01) * 100) / 100, t: now, feeRate: bu.feeRate, ask });
      if (ask > mid + slip + 1e-9) {
        extra.skip = `ask ${Math.round(ask * 100)}c over mid+${Math.round(slip * 100)}c`;
        signal(rule, ev.title, false, extra);
        continue;
      }
      const tr = enter(rule, { marketId: bu.id, title: ev.title, outcome: bu.label, idx: 0, token: bu.token, feeRate: bu.feeRate }, bk, ask, extra);
      signal(rule, ev.title, Boolean(tr), extra);
    }
  }
}

// ---------- tennis (thesis reviews/tennis-thesis-2026-11-08.md, 8 Nov 02:50 KST) ----------
// Singles match moneylines. 10 min before gameStartTime (window -12..-8 min): favourite = higher mid; skip if the
// favourite's price moved > 5 pts in the last 10 min (already live). Ask <= mid + 2c, $5 walking the book, hold.
// MAIN tennis-wta-fav90: WTA, mid 90-95c (backtest 298 bets, 96.0% won vs 92.5c, +3.0c/share after fee + 2c).
// Shadows: ATP 90-95c, WTA 85-90c, ITF 90-95c, any tour 95-99c.
const TENNIS_RULES: { rule: string; tours: string[]; lo: number; hi: number }[] = [
  { rule: "tennis-wta-fav90", tours: ["wta"], lo: 0.9, hi: 0.95 },
  { rule: "tennis-atp-fav90", tours: ["atp"], lo: 0.9, hi: 0.95 },
  { rule: "tennis-wta-fav85", tours: ["wta"], lo: 0.85, hi: 0.9 },
  { rule: "tennis-itf-fav90", tours: ["itf"], lo: 0.9, hi: 0.95 },
  { rule: "tennis-fav95", tours: ["wta", "atp", "itf"], lo: 0.95, hi: 0.99 },
];
export function tennisTour(text: string): string | null {
  if (/doubles|\s\/\s|\w\/\w/i.test(text)) return null;
  if (/\bITF\b/i.test(text)) return "itf";
  if (/\bWTA\b|women/i.test(text)) return "wta";
  if (/\bATP\b|challenger/i.test(text)) return "atp";
  return null;
}
async function tennisRefresh() {
  const now = Date.now();
  let evs: GEvent[];
  try {
    evs = await pages(`${GAMMA}/events?tag_slug=tennis&closed=false&end_date_min=${new Date(now).toISOString()}&end_date_max=${new Date(now + 11 * 86400_000).toISOString()}`, 5000);
  } catch (e) {
    log(`tennis list failed: ${(e as Error).message}`);
    return;
  }
  for (const e of evs) {
    for (const m of e.markets ?? []) {
      if (!m.id || state.tennis[m.id] || m.sportsMarketType !== "moneyline" || m.closed) continue;
      const tour = tennisTour(`${e.title ?? ""} ${m.question ?? ""} ${e.slug ?? ""}`);
      const toks = jl<string[]>(m.clobTokenIds, []);
      const start = tsOf(m.gameStartTime) || tsOf(e.startTime);
      if (!tour || toks.length !== 2 || !Number.isFinite(start) || start < now) continue;
      state.tennis[m.id] = { id: m.id, title: m.question ?? e.title ?? m.id, tour, start, tokens: toks, outcomes: jl<string[]>(m.outcomes, ["A", "B"]), feeRate: Number(m.feeSchedule?.rate ?? 0.05) };
    }
  }
  for (const [k, t] of Object.entries(state.tennis)) if (t.start < now - 2 * 86400_000) delete state.tennis[k];
}
/** Research batch 2 (10 Nov 2026 01:44 KST, reviews/new-ideas-b-2026-11-10.md): mid-bid twin of a pre-match favourite rule.
 *  At T-32..-28 min rest a $5 bid one tick under the favourite's ask (joining the bid on a 1c book), cancel at the start
 *  if unfilled, hold a fill to settlement. Batch 1 found such bids lose on 935 book paths (fills won 59% vs 77% unfilled);
 *  this measures the disagreement live. Judge: fill rate 50%+ and the filled subset not worse than the taker twin by more
 *  than the spread saved. */
function midBid(rule: string, m: { id: string; title: string; start: number; tokens: string[]; outcomes: string[]; feeRate: number }, i: number, bk: Book, now: number) {
  if (bk.bestAsk == null || bk.mid == null) return;
  const tick = bk.bestAsk > 0.96 ? 0.001 : 0.01;
  const bid = Math.round((bk.bestAsk - tick) * 1000) / 1000;
  if (state.makers.some((mk) => mk.rule === rule && mk.marketId === m.id)) return;
  state.makers.push({ rule, marketId: m.id, title: m.title, outcome: m.outcomes[i], idx: i, token: m.tokens[i], bid, t: now, feeRate: m.feeRate, ask: bk.bestAsk, mid: bk.mid, until: m.start });
  log(`${rule} ${m.title} bid ${Math.round(bid * 1000) / 10}c resting until the start`);
}
/** What the real-money copy did with each tennis paper trade (bought, or the guard that held it back); not saved. */
const realNotes: { t: number; title: string; why: string }[] = [];
async function tennisTick() {
  const now = Date.now();
  for (const t of Object.values(state.tennis)) {
    if (!t.mid30 && now >= t.start - 32 * 60_000 && now <= t.start - 28 * 60_000) {
      t.mid30 = true;
      const books = await Promise.all(t.tokens.map((k) => book(k).catch(() => null)));
      if (books[0]?.mid && books[1]?.mid) {
        const i = books[0].mid >= books[1].mid ? 0 : 1;
        const mid = books[i]!.mid!;
        if (mid >= 0.9 - 1e-9 && mid < 0.992) midBid("tennis-fav90-mid", t, i, books[i]!, now);
      }
    }
    if (t.done || now < t.start - 12 * 60_000) continue;
    t.done = true;
    if (now > t.start - 8 * 60_000) {
      t.note = "missed the 12-8 min window";
      continue;
    }
    const books = await Promise.all(t.tokens.map((k) => book(k).catch(() => null)));
    if (!books[0]?.mid || !books[1]?.mid) {
      t.note = "no book";
      continue;
    }
    const i = books[0].mid >= books[1].mid ? 0 : 1;
    const bk = books[i]!;
    const mid = bk.mid!;
    const ask = bk.bestAsk!;
    const rules = TENNIS_RULES.filter((r) => r.tours.includes(t.tour) && mid >= r.lo - 1e-9 && mid < r.hi - 1e-9 + (r.hi === 0.99 ? 0.002 : 0));
    if (!rules.length) continue;
    let moved: number | null = null;
    try {
      const h = await getJson<{ history?: { t: number; p: number }[] }>(`${CLOB}/prices-history?market=${t.tokens[i]}&startTs=${Math.floor(now / 1000) - 600}&endTs=${Math.floor(now / 1000)}&fidelity=1`);
      const ps = (h.history ?? []).map((x) => x.p);
      if (ps.length) moved = Math.max(...ps, mid) - Math.min(...ps, mid);
    } catch {
      /* no history: judge on the book alone */
    }
    for (const r of rules) {
      const extra: Record<string, unknown> = { tour: t.tour, start: t.start, mid, bid: bk.bestBid, ask, moved10m: moved, depth2c: bk.asks.filter((a) => a.price <= ask + 0.02 + 1e-9).reduce((x, a) => x + a.price * a.size, 0) };
      const skip = moved != null && moved > 0.05 + 1e-9 ? `moved ${Math.round(moved * 100)} pts in 10 min (live?)` : ask > mid + 0.02 + 1e-9 ? `ask ${Math.round(ask * 100)}c over mid+2c` : null;
      if (skip) {
        extra.skip = skip;
        signal(r.rule, t.title, false, extra);
        continue;
      }
      const tr = enter(r.rule, { marketId: t.id, title: t.title, outcome: t.outcomes[i], idx: i, token: t.tokens[i], feeRate: t.feeRate }, bk, ask, extra);
      signal(r.rule, t.title, Boolean(tr), extra);
      // 10 Nov 2026 (enrique: "start tennis"): rules listed under "events".tennis in deploy/live-rules.json are copied
      // with real money through src/eventlive.ts, which holds every guard. A failure here never touches the paper side.
      if (tr && eventLiveConfig().groups.tennis?.rules.includes(r.rule)) {
        try {
          const gm = await getJson<{ conditionId?: string; negRisk?: boolean }>(`${GAMMA}/markets/${t.id}`);
          const real = await eventLiveBuy("tennis", { rule: r.rule, marketId: t.id, title: t.title, outcome: t.outcomes[i], idx: i, token: t.tokens[i], ask, depth: Number(extra.depth2c) || 0, fillable: tr.fillable, feeRate: t.feeRate, conditionId: gm.conditionId ?? null, negRisk: Boolean(gm.negRisk) });
          if (real) {
            log(`${r.rule} ${t.title}: ${real}`);
            realNotes.push({ t: Date.now(), title: t.title, why: real });
            if (realNotes.length > 50) realNotes.splice(0, realNotes.length - 50);
          }
        } catch (e) {
          log(`${r.rule} ${t.title}: real order skipped (${(e as Error).message})`);
        }
      }
    }
  }
}

// ---------- US sports (research batch 2, 10 Nov 2026 01:44 KST, reviews/new-ideas-b-2026-11-10.md) ----------
// NBA moneyline favourite asking 85-95c at T-10 min (window 12..8 min before tip-off): take the ask if the spread is 1c or
// less and $25+ rests at the ask, $5 flat, hold to settlement; the rule sits out after 3 losses in 7 days. Evidence (mids,
// +1c slip, +fee): 156 bets 94.9% won vs 88.6c implied, +5.2c/share; 2025 +4.4c (96), 2026 +6.5c (60); 11 of 14 months
// positive. Control: college basketball 85-95c (history -2.0c over 299). Shadow: NFL 85-95c. Plus a mid-bid twin (T-30).
const US_LEAGUES: { tag: string; league: string; rule: string }[] = [
  { tag: "nba", league: "nba", rule: "nba-fav85" },
  { tag: "cbb", league: "cbb", rule: "cbb-fav85" },
  { tag: "nfl", league: "nfl", rule: "nfl-fav85" },
];
async function usportsRefresh() {
  const now = Date.now();
  for (const lg of US_LEAGUES) {
    let evs: GEvent[];
    try {
      evs = await pages(`${GAMMA}/events?tag_slug=${lg.tag}&closed=false&end_date_min=${new Date(now).toISOString()}&end_date_max=${new Date(now + 11 * 86400_000).toISOString()}`, 2000);
    } catch (e) {
      log(`${lg.league} list failed: ${(e as Error).message}`);
      continue;
    }
    for (const e of evs) {
      for (const m of e.markets ?? []) {
        if (!m.id || state.usports[m.id] || m.sportsMarketType !== "moneyline" || m.closed) continue;
        const toks = jl<string[]>(m.clobTokenIds, []);
        const start = tsOf(m.gameStartTime) || tsOf(e.startTime);
        if (toks.length !== 2 || !Number.isFinite(start) || start < now) continue;
        state.usports[m.id] = { id: m.id, title: m.question ?? e.title ?? m.id, league: lg.league, start, tokens: toks, outcomes: jl<string[]>(m.outcomes, ["A", "B"]), feeRate: Number(m.feeSchedule?.rate ?? 0.05) };
      }
    }
  }
  for (const [k, m] of Object.entries(state.usports)) if (m.start < now - 2 * 86400_000) delete state.usports[k];
}
function lossesIn7d(rule: string, now: number): number {
  return state.trades.filter((t) => t.rule === rule && t.won === false && (t.settledAt ?? t.t) > now - 7 * 86400_000).length;
}
async function usportsTick() {
  const now = Date.now();
  for (const m of Object.values(state.usports)) {
    const lg = US_LEAGUES.find((x) => x.league === m.league);
    if (!lg) continue;
    if (!m.mid30 && now >= m.start - 32 * 60_000 && now <= m.start - 28 * 60_000) {
      m.mid30 = true;
      {
        const books = await Promise.all(m.tokens.map((k) => book(k).catch(() => null)));
        if (books[0]?.mid && books[1]?.mid) {
          const i = books[0].mid >= books[1].mid ? 0 : 1;
          const mid = books[i]!.mid!;
          if (m.league === "nba" && mid >= 0.85 - 1e-9 && mid < 0.95 + 1e-9) midBid("nba-fav85-mid", m, i, books[i]!, now);
          // Round 340 (11 Nov 2026): every US league, favourite 55-85c, and the underdog of the same games as a control.
          if (mid >= 0.55 - 1e-9 && mid < 0.85) {
            midBid("us-prematch-fav-bid", m, i, books[i]!, now);
            midBid("us-prematch-dog-bid", m, 1 - i, books[1 - i]!, now);
          }
        }
      }
    }
    if (m.done || now < m.start - 12 * 60_000) continue;
    m.done = true;
    if (now > m.start - 8 * 60_000) {
      m.note = "missed the 12-8 min window";
      continue;
    }
    const books = await Promise.all(m.tokens.map((k) => book(k).catch(() => null)));
    if (!books[0]?.mid || !books[1]?.mid) {
      m.note = "no book";
      continue;
    }
    const i = books[0].mid >= books[1].mid ? 0 : 1;
    const bk = books[i]!;
    const ask = bk.bestAsk!;
    const spread = ask - (bk.bestBid ?? ask);
    const atAsk = bk.asks[0] ? bk.asks[0].price * bk.asks[0].size : 0;
    const extra: Record<string, unknown> = { league: m.league, start: m.start, mid: bk.mid, bid: bk.bestBid, ask, spread, atAsk };
    // Round 320 (10 Nov 2026): log the out-of-band favourite as a skip so the dashboard shows the rule evaluating games.
    if (ask < 0.85 - 1e-9 || ask > 0.95 + 1e-9) {
      extra.skip = `favourite ask ${Math.round(ask * 100)}c outside 85-95c`;
      signal(lg.rule, m.title, false, extra);
      continue;
    }
    const losses = lossesIn7d(lg.rule, now);
    const skip = losses >= 3 ? `${losses} losses in 7 days` : spread > 0.01 + 1e-9 ? `spread ${Math.round(spread * 100)}c` : atAsk < 25 ? `$${Math.round(atAsk)} at the ask` : null;
    if (skip) {
      extra.skip = skip;
      signal(lg.rule, m.title, false, extra);
      continue;
    }
    const tr = enter(lg.rule, { marketId: m.id, title: m.title, outcome: m.outcomes[i], idx: i, token: m.tokens[i], feeRate: m.feeRate }, bk, ask, extra);
    signal(lg.rule, m.title, Boolean(tr), extra);
  }
}

// ---------- cricket (spec reviews/cricket-paper-spec.md, 8 Nov 03:30 KST) ----------
// 2-way match moneylines (tag cricket). MAIN cricket-fav10: at T-10 min (window 15..5 min before gameStartTime) buy
// the side whose best ask is 65-95c, $5 walking up to best ask + 2c; skip if < $5 offered within 2c. Shadows:
// cricket-fav60 (same at T-60, window 65..55 min) and cricket-dog-control (underdog asking 20-35c at T-10).
async function cricketRefresh() {
  const now = Date.now();
  let evs: GEvent[];
  try {
    evs = await pages(`${GAMMA}/events?tag_slug=cricket&closed=false&end_date_min=${new Date(now).toISOString()}&end_date_max=${new Date(now + 12 * 86400_000).toISOString()}`, 3000);
  } catch (e) {
    log(`cricket list failed: ${(e as Error).message}`);
    return;
  }
  for (const e of evs) {
    for (const m of e.markets ?? []) {
      if (!m.id || state.cricket[m.id] || m.sportsMarketType !== "moneyline" || m.closed) continue;
      const toks = jl<string[]>(m.clobTokenIds, []);
      const outs = jl<string[]>(m.outcomes, []);
      const start = tsOf(m.gameStartTime) || tsOf(e.startTime);
      if (toks.length !== 2 || outs.length !== 2 || outs.some((o) => /draw|tie/i.test(o)) || !Number.isFinite(start) || start < now) continue;
      state.cricket[m.id] = { id: m.id, title: m.question ?? e.title ?? m.id, start, tokens: toks, outcomes: outs, feeRate: Number(m.feeSchedule?.rate ?? 0.05) };
    }
  }
  for (const [k, c] of Object.entries(state.cricket)) if (c.start < now - 3 * 86400_000) delete state.cricket[k];
}
async function cricketCheck(c: CricketMatch, phase: 10 | 60) {
  const books = await Promise.all(c.tokens.map((k) => book(k).catch(() => null)));
  if (books[0]?.bestAsk == null || books[1]?.bestAsk == null) {
    c.note = "no book";
    return;
  }
  const fav = books[0].bestAsk >= books[1].bestAsk ? 0 : 1; // higher ask = favourite
  const picks: { rule: string; i: number }[] = [];
  const favAsk = books[fav]!.bestAsk!;
  if (favAsk >= 0.65 - 1e-9 && favAsk <= 0.95 + 1e-9) picks.push({ rule: phase === 10 ? "cricket-fav10" : "cricket-fav60", i: fav });
  const dogAsk = books[1 - fav]!.bestAsk!;
  if (phase === 10 && dogAsk >= 0.2 - 1e-9 && dogAsk <= 0.35 + 1e-9) picks.push({ rule: "cricket-dog-control", i: 1 - fav });
  for (const p of picks) {
    const bk = books[p.i]!;
    const ask = bk.bestAsk!;
    const depth2c = bk.asks.filter((a) => a.price <= ask + 0.02 + 1e-9).reduce((x, a) => x + a.price * a.size, 0);
    const extra: Record<string, unknown> = { start: c.start, phase, mid: bk.mid, bid: bk.bestBid, ask, otherAsk: books[1 - p.i]!.bestAsk, depth2c };
    if (depth2c < STAKE - 1e-9) {
      extra.skip = `only $${depth2c.toFixed(2)} within 2c of the ask`;
      signal(p.rule, c.title, false, extra);
      continue;
    }
    const tr = enter(p.rule, { marketId: c.id, title: c.title, outcome: c.outcomes[p.i], idx: p.i, token: c.tokens[p.i], feeRate: c.feeRate }, bk, ask + 0.02, extra);
    signal(p.rule, c.title, Boolean(tr), extra);
  }
}
async function cricketTick() {
  const now = Date.now();
  for (const c of Object.values(state.cricket)) {
    const left = c.start - now;
    if (!c.done60 && left <= 65 * 60_000) {
      c.done60 = true;
      if (left >= 55 * 60_000) await cricketCheck(c, 60);
    }
    if (!c.done10 && left <= 15 * 60_000) {
      c.done10 = true;
      if (left >= 5 * 60_000) await cricketCheck(c, 10);
      else c.note = "missed the 15-5 min window";
    }
  }
}

// ---------- settlement and summary ----------
async function settleTick() {
  const open = state.trades.filter((t) => t.pnl == null);
  const ids = [...new Set([...open.map((t) => t.marketId), ...eventLiveRows().filter((r) => r.pnl == null).map((r) => r.marketId)])];
  for (const id of ids) {
    let m: GMarket;
    try {
      m = await getJson<GMarket>(`${GAMMA}/markets/${id}`);
    } catch {
      continue;
    }
    if (!m.closed) continue;
    const px = jl<string[]>(m.outcomePrices, []).map(Number);
    if (px.length !== 2 || !px.every((x) => Number.isFinite(x))) continue;
    try {
      eventLiveSettle(id, px);
    } catch (e) {
      log(`real settle failed: ${(e as Error).message}`);
    }
    for (const t of open.filter((x) => x.marketId === id)) {
      const pay = px[t.idx];
      if (!(pay === 1 || pay === 0 || pay === 0.5)) continue;
      t.won = pay === 1 ? true : pay === 0 ? false : null;
      t.pnl = t.shares * pay - t.cost - t.fee;
      t.settledAt = Date.now();
    }
    await sleep(200);
  }
}
// ---------- dashboard watch lists (not saved; rebuilt by the ticks) ----------
type PolWatch = { t: number; title: string; outcome: string; ask: number; liq: number | null; status: string };
const idxWatch = new Map<string, { rule: string; title: string; close: number; outs: string[]; asks: (number | null)[]; bids: (number | null)[]; at: number; status: string }>();
let polWatch: PolWatch[] = [];
let polWatchAt = 0;
const health: Record<string, { ok?: number; err?: string; errAt?: number }> = {};
const kstDay = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const c100 = (x: unknown) => (typeof x === "number" ? Math.round(x * 1000) / 10 : null);
/** Why a logged signal did or did not become a trade, in a few words. */
function whyOf(x: Signal): string {
  const e = x.extra;
  if (typeof e.skip === "string") return `skipped: ${e.skip}`;
  if (e.unfilled) return "maker bid not filled in 6 h";
  if (x.rule.endsWith("-nearmiss")) return `near miss: ask ${c100(e.ask)}c vs model ${c100(e.model)}c`;
  return x.traded ? "traded" : "signal, no fill";
}
/** One short line of context for a trade (league + kickoff, game + model, hours to close, event). */
function infoOf(t: PaperTrade): string {
  const e = t.extra ?? {};
  if (typeof e.league === "string") return `${e.league}${typeof e.spread === "number" ? ` · spread ${Math.round(e.spread * 100)}c` : ""}`;
  if (typeof e.game === "string") return `${e.game} · model ${c100(e.model)}c · P0 ${c100(e.p0)}c`;
  if (typeof e.hoursToClose === "number") return `${e.hoursToClose.toFixed(1)} h to close`;
  if (typeof e.event === "string") return e.event.slice(0, 60);
  if (e.bidAt) return "maker bid filled";
  return "";
}
function watchOf(g: string): unknown[] {
  const now = Date.now();
  if (g === "football") {
    const ruleOf: Record<string, string> = { laliga: "football-laliga-home", portugal: "football-portugal-home", italy: "football-italy-away" };
    return Object.values(state.fixtures)
      .filter((f) => f.kickoff > now - 3 * 3600_000)
      .sort((a, b) => a.kickoff - b.kickoff)
      .slice(0, 40)
      .map((f) => ({ t: f.kickoff, title: f.title, league: f.league, home: f.home.team, away: f.away.team, homeAsk: f.homeAsk ?? null, awayAsk: f.awayAsk ?? null, pxAt: f.pxAt ?? null, rule: ruleOf[f.league] ?? null, status: f.done ? f.note ?? "looked" : "looks 12-8 min before kickoff" }));
  }
  if (g === "esports")
    return Object.values(state.matches)
      .filter((m) => m.start > now - 6 * 3600_000)
      .sort((a, b) => a.start - b.start)
      .slice(0, 40)
      .map((m) => ({ t: m.start, title: m.title, game: m.game, outs: m.outcomes, px0: m.px0 ?? null, p0: m.p0 ?? null, vol: m.volume, status: m.evaluated ? m.note ?? "evaluated" : m.tEnd != null ? `map 1 to ${m.outcomes[m.w ?? 0]}, checking price` : m.start <= now ? "live, waiting for map 1" : "upcoming" }));
  if (g === "indices") {
    for (const [k, w] of idxWatch) if (w.close < now - 3600_000) idxWatch.delete(k);
    return [...idxWatch.values()].sort((a, b) => a.close - b.close).map((w) => ({ t: w.close, title: w.title, rule: w.rule, outs: w.outs, asks: w.asks, bids: w.bids, at: w.at, status: w.status }));
  }
  if (g === "politics") return [...state.makers.filter((m) => m.rule.startsWith("election")).map((m) => ({ t: m.t + 6 * 3600_000, title: m.title, outcome: m.outcome, ask: m.ask, bid: m.bid, status: `maker bid ${Math.round(m.bid * 100)}c open` })), ...polWatch];
  return [];
}
const GROUPS: Record<string, string[]> = {
  esports: ["esports-map1", "esports-fav-shadow", "esports-map1-dota", "esports-lol-fav90", "esports-cs2-fav90", "prematch-rest-clv-esports"],
  indices: ["gold-momentum", "spx-underdog", "spy-underdog"],
  politics: ["election-lock-taker", "election-lock-maker"],
  weather: ["weather-fav16", "weather-fav15", "weather-fav16-wide", "weather-fav16-mid", "weather-fav16-ask1", "weather-fav16-hi", "weather-fav15-ask1", "weather-dayahead-all", "weather-dayahead-yes", "wx-no-maker", "wx-no-maker-815", "wx-no-maker-1530"],
  tennis: ["tennis-wta-fav90", "tennis-atp-fav90", "tennis-wta-fav85", "tennis-itf-fav90", "tennis-fav95", "tennis-fav90-mid", "prematch-rest-clv-tennis"],
  cricket: ["cricket-fav10", "cricket-fav60", "cricket-dog-control"],
  usports: ["nba-fav85", "cbb-fav85", "nfl-fav85", "nba-fav85-mid", "us-prematch-fav-bid", "us-prematch-dog-bid"],
  football: ["football-laliga-home", "football-portugal-home", "football-italy-away", "football-laliga-home55"],
};
function summarize() {
  const out: Record<string, unknown> = { at: Date.now(), health };
  for (const [g, rules] of Object.entries(GROUPS)) {
    out[g] = {
      rules: rules.map((r) => {
        const ts = state.trades.filter((t) => t.rule === r);
        const st = ts.filter((t) => t.pnl != null);
        const fl = st.filter((t) => t.fillable);
        return {
          rule: r,
          signals: state.signals.filter((s) => s.rule === r).length,
          nearMisses: state.signals.filter((s) => s.rule === `${r}-nearmiss`).length,
          trades: ts.length,
          open: ts.length - st.length,
          settled: st.length,
          won: st.filter((t) => t.won).length,
          net: Math.round(st.reduce((s, t) => s + (t.pnl ?? 0), 0) * 100) / 100,
          // Average of each fill's price move in our favour, in cents a share: against the closing price (clv) and 30 min after the fill (mk30).
          ...Object.fromEntries(
            ["clv", "mk30"].map((k) => {
              const xs = ts.map((t) => t.extra?.[k]).filter((x): x is number => typeof x === "number");
              return [k, xs.length ? { n: xs.length, avgC: Math.round((xs.reduce((a, x) => a + x, 0) / xs.length) * 1000) / 10 } : null];
            }),
          ),
          fillable: { trades: fl.length, won: fl.filter((t) => t.won).length, net: Math.round(fl.reduce((s, t) => s + (t.pnl ?? 0), 0) * 100) / 100 },
          jev: (() => {
            const js = st.filter((t) => t.jev?.mult != null);
            const b: Record<string, { n: number; won: number; net: number }> = {};
            for (const t of js) {
              const k = t.jev!.pick ?? "?";
              const x = (b[k] ??= { n: 0, won: 0, net: 0 });
              x.n++;
              x.won += t.won ? 1 : 0;
              x.net = Math.round((x.net + (t.pnl ?? 0)) * 100) / 100;
            }
            const staked = js.reduce((a, t) => a + t.cost * t.jev!.mult!, 0);
            const net = js.reduce((a, t) => a + (t.pnl ?? 0) * t.jev!.mult!, 0);
            const flat = js.reduce((a, t) => a + (t.pnl ?? 0), 0);
            return { asked: ts.filter((t) => t.jev).length, errors: ts.filter((t) => t.jev?.err).length, lastErr: ts.filter((t) => t.jev?.err).slice(-1)[0]?.jev?.err ?? null, settled: js.length, net: Math.round(net * 100) / 100, flatNet: Math.round(flat * 100) / 100, perDollar: staked > 0 ? Math.round((net / staked) * 1000) / 10 : null, buckets: b };
          })(),
          perShare: st.length ? Math.round((st.reduce((s, t) => s + (t.pnl ?? 0), 0) / st.reduce((s, t) => s + t.shares, 0)) * 1000) / 10 : null,
        };
      }),
      recent: state.trades
        .filter((t) => rules.includes(t.rule))
        .slice(-40)
        .reverse()
        .map((t) => ({ info: infoOf(t), jm: t.jev?.mult ?? null, jc: t.jev?.confidence ?? null, settledAt: t.settledAt ?? null, rule: t.rule, t: t.t, title: t.title, outcome: t.outcome, ask: t.ask, avg: t.avg == null ? null : Math.round(t.avg * 1000) / 1000, shares: Math.round(t.shares * 100) / 100, cost: Math.round(t.cost * 100) / 100, fillable: t.fillable, won: t.won ?? null, pnl: t.pnl == null ? null : Math.round(t.pnl * 100) / 100, jev: t.jev?.pick ?? (t.jev?.err ? `error: ${t.jev.err}` : t.jevPending ? "asking" : null) })),
      // Why matches ended without a trade (diagnostics: "map 1 already decided when first seen", "no P0", ...).
      notes: g === "esports" ? Object.values(state.matches).reduce<Record<string, number>>((o, m) => ((o[m.evaluated ? m.note ?? (m.tEnd != null ? "evaluated" : "done") : m.tEnd != null ? "map 1 over, waiting" : m.start <= Date.now() ? "live" : "upcoming"] = (o[m.evaluated ? m.note ?? (m.tEnd != null ? "evaluated" : "done") : m.tEnd != null ? "map 1 over, waiting" : m.start <= Date.now() ? "live" : "upcoming"] ?? 0) + 1), o), {}) : undefined,
      skips: g === "football" || g === "weather" || g === "tennis" || g === "cricket" || g === "usports" ? state.signals.filter((x) => rules.includes(x.rule) && x.extra.skip).slice(-15).reverse().map((x) => ({ rule: x.rule, t: x.t, title: x.title, why: x.extra.skip, ask: x.extra.ask })) : undefined,
      upcoming: g === "football" ? Object.values(state.fixtures).filter((f) => !f.done).length : g === "weather" ? Object.keys(state.wx).length : g === "tennis" ? Object.values(state.tennis).filter((t) => !t.done).length : g === "usports" ? Object.values(state.usports).filter((m) => !m.done).length : g === "cricket" ? Object.values(state.cricket).filter((c) => !c.done10).length : undefined,
      real: g === "tennis" ? { ...eventLiveSummary("tennis"), notes: realNotes.slice(-10).reverse() } : undefined,
      watch: watchOf(g),
      watchAt: g === "politics" ? polWatchAt : undefined,
      sigs: state.signals
        .filter((x) => rules.includes(x.rule.replace(/-nearmiss$/, "")))
        .slice(-25)
        .reverse()
        .map((x) => ({ t: x.t, rule: x.rule, title: x.title, traded: x.traded, why: whyOf(x), ask: typeof x.extra.ask === "number" ? x.extra.ask : null })),
      days: (() => {
        const d: Record<string, { day: string; n: number; won: number; net: number; fnet: number; jnet: number }> = {};
        for (const t of state.trades) {
          if (!rules.includes(t.rule) || t.pnl == null) continue;
          const k = kstDay(t.settledAt ?? t.t);
          const o = (d[k] ??= { day: k, n: 0, won: 0, net: 0, fnet: 0, jnet: 0 });
          o.n++;
          o.won += t.won ? 1 : 0;
          o.net += t.pnl;
          if (t.fillable) o.fnet += t.pnl;
          o.jnet += t.pnl * (t.jev?.mult ?? 1);
        }
        return Object.values(d)
          .sort((a, b) => (a.day < b.day ? -1 : 1))
          .map((o) => ({ ...o, net: Math.round(o.net * 100) / 100, fnet: Math.round(o.fnet * 100) / 100, jnet: Math.round(o.jnet * 100) / 100 }));
      })(),
      gaps: g === "esports" ? Object.values(state.matches).filter((m) => m.gap != null).map((m) => m.gap).slice(-30) : undefined,
      watching: g === "esports" ? Object.values(state.matches).filter((m) => !m.evaluated && m.start < Date.now() + 86400_000).length : g === "politics" ? state.makers.filter((m) => m.rule.startsWith("election")).length : undefined,
    };
  }
  saveJson(SUMMARY_FILE, out);
}

// ---------- main loop ----------
async function guard(name: string, f: () => Promise<void>) {
  const h = (health[name] ??= {});
  try {
    await f();
    h.ok = Date.now();
  } catch (e) {
    log(`${name} failed: ${(e as Error).message}`);
    h.err = (e as Error).message.slice(0, 160);
    h.errAt = Date.now();
  }
}
async function main() {
  log("started (paper only)");
  let last = { esList: 0, idx: 0, pol: 0, mk: 0, nomk: 0, settle: 0, fb: 0, wx: 0, tn: 0, ck: 0, us: 0 };
  for (;;) {
    const now = Date.now();
    if (now - last.esList > 5 * 60_000) {
      last.esList = now;
      await guard("esports list", esportsRefresh);
    }
    await guard("esports", esportsTick);
    if (now - last.fb > 15 * 60_000) {
      last.fb = now;
      await guard("football list", footballRefresh);
    }
    await guard("football", footballTick);
    if (now - last.wx > 10 * 60_000) {
      last.wx = now;
      await guard("weather list", weatherRefresh);
    }
    await guard("weather", weatherTick);
    if (now - last.tn > 10 * 60_000) {
      last.tn = now;
      await guard("tennis list", tennisRefresh);
    }
    await guard("tennis", tennisTick);
    if (now - last.ck > 10 * 60_000) {
      last.ck = now;
      await guard("cricket list", cricketRefresh);
    }
    await guard("cricket", cricketTick);
    if (now - last.us > 10 * 60_000) {
      last.us = now;
      await guard("US sports list", usportsRefresh);
    }
    await guard("US sports", usportsTick);
    if (now - last.idx > 3 * 60_000) {
      last.idx = now;
      await guard("indices", indicesTick);
    }
    if (now - last.pol > 30 * 60_000) {
      last.pol = now;
      await guard("politics", politicsTick);
    }
    if (now - last.mk > 60_000) {
      last.mk = now;
      await guard("makers", makersTick);
    }
    if (now - last.nomk > 10 * 60_000) {
      last.nomk = now;
      await guard("weather NO makers", noMakerTick);
      await guard("pre-match resting bids", restTick);
    }
    if (now - last.settle > 10 * 60_000) {
      last.settle = now;
      await guard("settle", settleTick);
    }
    {
      await guard("jev", jevTick);
    }
    save();
    summarize();
    await sleep(10_000);
  }
}
/**
 * The bot stops this process with SIGTERM on every restart. A real order that is being sent at that moment is finished
 * first, so that its outcome is on file instead of unknown (seconds; 40 s at most), and no new one is started. With no
 * order in flight the stop is immediate, as before.
 */
export function stopWhenOrderDone(exit: () => void, limitMs = 40_000, pollMs = 100) {
  eventLiveStop();
  const until = Date.now() + limitMs;
  const go = () => (!eventLiveBusy() || Date.now() > until ? exit() : void setTimeout(go, pollMs));
  go();
}
if (process.argv[1] && /eventpaper\.ts$/.test(process.argv[1])) {
  process.on("SIGTERM", () => stopWhenOrderDone(() => process.exit(0)));
  void main();
}
