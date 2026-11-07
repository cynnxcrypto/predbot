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
  note?: string;
  /** Gamma best ask of outcome 0 at the last list refresh (dashboard only). */
  px0?: number | null;
};
type Side = { id: string; token: string; team: string; feeRate: number };
type Fixture = { id: string; league: string; title: string; kickoff: number; home: Side; away: Side; done?: boolean; note?: string; homeAsk?: number | null; awayAsk?: number | null; pxAt?: number };
type Maker = { rule: string; marketId: string; title: string; outcome: string; idx: number; token: string; bid: number; t: number; feeRate: number; ask: number };
type State = {
  matches: Record<string, Match>;
  done: Record<string, number>;
  makers: Maker[];
  trades: PaperTrade[];
  signals: Signal[];
  fixtures: Record<string, Fixture>;
};
const state: State = { matches: {}, done: {}, makers: [], trades: [], signals: [], fixtures: {}, ...loadJson<Partial<State>>(STATE_FILE, {}) };
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
      const match = ms.find((m) => m.sportsMarketType === "moneyline" && (m.question ?? "").toUpperCase().includes("BO3"));
      const map1 = ms.find((m) => m.sportsMarketType === "child_moneyline" && /(Map|Game) 1 Winner/i.test(m.question ?? ""));
      if (!match?.id || !map1?.id) continue;
      const outs = jl<string[]>(match.outcomes, []);
      if (JSON.stringify(outs) !== JSON.stringify(jl<string[]>(map1.outcomes, []))) continue;
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
        map1Id: map1.id,
        map1Tokens: jl<string[]>(map1.clobTokenIds, []),
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
async function esportsTick() {
  const now = Date.now();
  for (const m of Object.values(state.matches)) {
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
      state.trades.push({ rule: mk.rule, marketId: mk.marketId, title: mk.title, outcome: mk.outcome, idx: mk.idx, token: mk.token, t: now, ask: mk.ask, avg: mk.bid, shares, cost: STAKE, fee: 0, fillable: true, feeRate: 0, extra: { bidAt: mk.t } });
      log(`${mk.rule} ${mk.title} filled at ${Math.round(mk.bid * 100)}c`);
    } else if (now - mk.t < 6 * 3600_000) keep.push(mk);
    else signal(mk.rule, mk.title, false, { unfilled: true, bid: mk.bid });
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
  "esports-map1-dota": ["esports", "Dota 2 Bo3 shadow of the map-1 under-reaction rule (buy the map-1 winner when the match ask is 8+ pts under the map model)."],
  "gold-momentum": ["indices", "Gold daily up/down: the first time a side asks 55-70c with 4+ hours to the 17:00 New York close, buy the higher-priced side; hold to settlement. Backtest: 69% won, +8.1c/share over 142 days."],
  "spx-underdog": ["indices", "S&P 500 daily up/down control: the first time a side asks 30-45c with 4+ hours to the 16:00 New York close, buy the cheaper side; expected about break-even."],
  "spy-underdog": ["indices", "SPY daily up/down control: buy the cheaper side when it first asks 30-45c with 4+ hours to the close; expected about break-even."],
  "election-lock-taker": ["politics", "Election favourite lock: a binary election market ending in 1-7 days whose favourite asks 97-99c with $5+ at the ask; buy the favourite at the ask, hold to resolution. History: favourites at 97-99c held ~+2% over 541 trades."],
  "election-lock-maker": ["politics", "Election favourite lock, maker: bid 1c under a 97-99c favourite ask in a binary election ending in 1-7 days; filled if the ask reaches the bid within 6 h."],
  "football-laliga-home": ["football", "La Liga: buy the home team to win when its ask is 65-80c 10 minutes before kickoff; hold to the result. Ten seasons of bookmaker prices: +7.6c per $1 over 462 matches, 10 of 11 seasons positive; Polymarket 2024-26: 54 bets, 83% won, +9.4c/share."],
  "football-portugal-home": ["football", "Portugal Primeira Liga shadow: buy the home favourite at 65-80c 10 minutes before kickoff; bookmaker history +8.0c per $1 over 311 matches, Polymarket sample -5.9c (24)."],
  "football-italy-away": ["football", "Serie A shadow: buy the away favourite at 65-80c 10 minutes before kickoff; bookmaker history +9.4c per $1 over 189 matches."],
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

// ---------- settlement and summary ----------
async function settleTick() {
  const open = state.trades.filter((t) => t.pnl == null);
  const ids = [...new Set(open.map((t) => t.marketId))];
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
  if (g === "politics") return [...state.makers.map((m) => ({ t: m.t + 6 * 3600_000, title: m.title, outcome: m.outcome, ask: m.ask, bid: m.bid, status: `maker bid ${Math.round(m.bid * 100)}c open` })), ...polWatch];
  return [];
}
const GROUPS: Record<string, string[]> = {
  esports: ["esports-map1", "esports-fav-shadow", "esports-map1-dota"],
  indices: ["gold-momentum", "spx-underdog", "spy-underdog"],
  politics: ["election-lock-taker", "election-lock-maker"],
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
      skips: g === "football" ? state.signals.filter((x) => rules.includes(x.rule) && x.extra.skip).slice(-15).reverse().map((x) => ({ rule: x.rule, t: x.t, title: x.title, why: x.extra.skip, ask: x.extra.ask })) : undefined,
      upcoming: g === "football" ? Object.values(state.fixtures).filter((f) => !f.done).length : undefined,
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
      watching: g === "esports" ? Object.values(state.matches).filter((m) => !m.evaluated && m.start < Date.now() + 86400_000).length : g === "politics" ? state.makers.length : undefined,
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
  let last = { esList: 0, idx: 0, pol: 0, mk: 0, settle: 0, fb: 0 };
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
    if (now - last.idx > 3 * 60_000) {
      last.idx = now;
      await guard("indices", indicesTick);
    }
    if (now - last.pol > 30 * 60_000) {
      last.pol = now;
      await guard("politics", politicsTick);
    }
    if (now - last.mk > 5 * 60_000) {
      last.mk = now;
      await guard("makers", makersTick);
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
if (process.argv[1] && /eventpaper\.ts$/.test(process.argv[1])) void main();
