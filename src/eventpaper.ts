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
  note?: string;
};
type Maker = { rule: string; marketId: string; title: string; outcome: string; idx: number; token: string; bid: number; t: number; feeRate: number; ask: number };
type State = {
  matches: Record<string, Match>;
  done: Record<string, number>;
  makers: Maker[];
  trades: PaperTrade[];
  signals: Signal[];
};
const state: State = { matches: {}, done: {}, makers: [], trades: [], signals: [], ...loadJson<Partial<State>>(STATE_FILE, {}) };
const save = () => saveJson(STATE_FILE, state);
const feeOf = (rate: number, shares: number, p: number) => rate * shares * p * (1 - p);
const log = (s: string) => console.log(`eventpaper: ${s}`);

function enter(rule: string, m: { marketId: string; title: string; outcome: string; idx: number; token: string; feeRate: number }, bk: Book, limit: number, extra: Record<string, unknown> = {}): PaperTrade | null {
  if (bk.bestAsk == null) return null;
  const w = walk(bk.asks, STAKE, limit);
  if (w.shares <= 0 || w.avg == null) return null;
  const tr: PaperTrade = { rule, ...m, t: Date.now(), ask: bk.bestAsk, avg: w.avg, shares: w.shares, cost: w.cost, fee: feeOf(m.feeRate, w.shares, w.avg), fillable: w.full, extra };
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
type GMarket = { id?: string; question?: string; sportsMarketType?: string; outcomes?: string; clobTokenIds?: string; gameStartTime?: string; closed?: boolean; outcomePrices?: string; volumeNum?: number; feeSchedule?: { rate?: number } | null; bestAsk?: number; acceptingOrders?: boolean; endDate?: string; liquidityNum?: number; conditionId?: string };
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
        m.runSide = null;
        m.runFrom = null;
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
      const ok = books
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => b && b.bestAsk != null && b.bestAsk >= s.lo - 1e-9 && b.bestAsk <= s.hi + 1e-9 && b.asks[0].size * b.asks[0].price >= STAKE);
      if (!ok.length) continue;
      ok.sort((a, b) => (s.pick === "high" ? b.b!.bestAsk! - a.b!.bestAsk! : a.b!.bestAsk! - b.b!.bestAsk!));
      const { b, i } = ok[0];
      const extra = { slug: e.slug, hoursToClose: (close - now) / 3600_000, close, asks: books.map((x) => x?.bestAsk ?? null), bids: books.map((x) => x?.bestBid ?? null), sizeAtAsk: b!.asks[0].size };
      const tr = enter(s.rule, { marketId: m.id, title: e.title ?? e.slug ?? m.id, outcome: outs[i], idx: i, token: toks[i], feeRate: Number(m.feeSchedule?.rate ?? 0.04) }, b!, 1, extra);
      signal(s.rule, e.title ?? "", Boolean(tr), extra);
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
  for (const { e, m } of seen.values()) {
    const key = `election-lock|${m.id}`;
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
const GROUPS: Record<string, string[]> = {
  esports: ["esports-map1", "esports-fav-shadow", "esports-map1-dota"],
  indices: ["gold-momentum", "spx-underdog", "spy-underdog"],
  politics: ["election-lock-taker", "election-lock-maker"],
};
function summarize() {
  const out: Record<string, unknown> = { at: Date.now() };
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
          perShare: st.length ? Math.round((st.reduce((s, t) => s + (t.pnl ?? 0), 0) / st.reduce((s, t) => s + t.shares, 0)) * 1000) / 10 : null,
        };
      }),
      recent: state.trades
        .filter((t) => rules.includes(t.rule))
        .slice(-25)
        .reverse()
        .map((t) => ({ rule: t.rule, t: t.t, title: t.title, outcome: t.outcome, ask: t.ask, cost: Math.round(t.cost * 100) / 100, fillable: t.fillable, won: t.won ?? null, pnl: t.pnl == null ? null : Math.round(t.pnl * 100) / 100 })),
      watching: g === "esports" ? Object.values(state.matches).filter((m) => !m.evaluated && m.start < Date.now() + 86400_000).length : g === "politics" ? state.makers.length : undefined,
    };
  }
  saveJson(SUMMARY_FILE, out);
}

// ---------- main loop ----------
async function guard(name: string, f: () => Promise<void>) {
  try {
    await f();
  } catch (e) {
    log(`${name} failed: ${(e as Error).message}`);
  }
}
async function main() {
  log("started (paper only)");
  let last = { esList: 0, idx: 0, pol: 0, mk: 0, settle: 0 };
  for (;;) {
    const now = Date.now();
    if (now - last.esList > 5 * 60_000) {
      last.esList = now;
      await guard("esports list", esportsRefresh);
    }
    await guard("esports", esportsTick);
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
    save();
    summarize();
    await sleep(10_000);
  }
}
if (process.argv[1] && /eventpaper\.ts$/.test(process.argv[1])) void main();
