/**
 * Category dashboards (Football, Esports, US Sports, Indices & Commodities, Weather, Politics, Other), 7 Nov 2026.
 * enrique: "it's too plain, too little, we have to make it similar to crypto". Every category gets the crypto layout adapted
 * to events: hero (next event clock + paper totals), rules (with Jev-sized net), trade log, net chart + day by day,
 * markets watched (prices, time to start), why no trade fired, live order books (fillability), research + data collector.
 *
 * Data, all read-only (nothing here places orders or touches deploy/live-rules.json):
 *  - paper loggers: data/eventpaper-summary.json (src/eventpaper.ts);
 *  - order-book snapshots every 10 min: server-data data/history/books/<day>/<HHMM>.json.gz (history/books.py, GitHub Action);
 *  - collector coverage: server-data data/history/state.json (history/collect.py);
 *  - upcoming markets for tabs with no logger yet: Polymarket Gamma events by tag.
 * The remote reads happen only when a category tab is open (/api/events), cached 5 min, with short timeouts.
 */
import { gunzipSync } from "node:zlib";
import { loadJson } from "./store.js";

const REPO = "cynnxcrypto/predbot";
const RAW = `https://raw.githubusercontent.com/${REPO}/server-data/data/history`;
const GAMMA = "https://gamma-api.polymarket.com";
const UA = "PredBotDashboard/0.1";
const TTL = 5 * 60_000;

type Cat = { group?: string; books: (m: BookMarket) => boolean; collector: string[]; tags?: string[]; research: string[]; plan: string; report?: string };
type BookMarket = { family?: string; series?: string; question?: string; group_item?: string; game_start?: string; end?: string; smt?: string; outcomes?: string[]; books?: { bids: number[][]; asks: number[][] }[] };
const US = /\b(nba|nfl|nhl|mlb|wnba|cfb|cbb|ncaa|college)/i;
const FIN = (m: BookMarket) => !m.family;
export const CATS: Record<string, Cat> = {
  football: {
    group: "football",
    books: (m) => m.family === "football",
    collector: ["football"],
    research: [
      "11 leagues, 3,350 Polymarket matches: prices ≈ Pinnacle (median gap 0.57 pts); favourites 55c+ lose −1.7c overall.",
      "La Liga home favourites 65-80c: Polymarket 54 bets, 83% won, +9.4c/share; bookmaker data 462 matches +7.6c, 10 of 11 seasons.",
      "Portugal same on bookmaker data (+8.0c, 311) but −5.9c on Polymarket (24). England loses.",
    ],
    plan: "Real money only after 100+ fillable paper bets at +3c/share or better. About 1-2 bets a week.",
    report: "reviews/la-liga-thesis-2026-11-07.md",
  },
  esports: {
    group: "esports",
    books: (m) => m.family === "esports",
    collector: ["esports"],
    research: [
      "Pre-match prices are fair (6,054 matches, −1 to −3c after costs).",
      "Lead: Bo3 match price under-reacts after map 1, +3.1c/share out of sample (171 bets); fades in 3-10 min.",
      "Only matches under $50k volume; loses on Dota 2 (kept as a shadow). Fills not verified yet.",
    ],
    plan: "Paper logger on CS2 / LoL / Valorant (+ Dota shadow). Real only after 100+ fillable trades at +3c/share.",
    report: "reviews/esports-thesis-2026-11-07.md",
  },
  "us-sports": {
    books: (m) => m.family === "games" && US.test(m.series ?? ""),
    collector: ["us_sports"],
    tags: ["nba", "nhl", "nfl", "mlb", "cbb"],
    research: [
      "Polymarket ≈ bookmakers (NFL 0.85 pts). Following news loses −11c.",
      "Weak lead: NBA + NHL underdogs 35-50c, 10 min before tip-off, +4.3c (2,190 bets, 46% won); about 0 after 2c slippage.",
      "Volume: NBA $10.3M/day, NFL $4.8M/day. Games mostly 08:00-11:00 KST.",
    ],
    plan: "Paper tracker for NBA/NHL underdogs 35-50c once real-fill data confirms the fills (~59 bets a week). No rule running yet.",
    report: "reviews/us-sports-thesis-2026-11-07.md",
  },
  indices: {
    group: "indices",
    books: FIN,
    collector: ["finance_daily"],
    research: [
      "Fair within ±3c on 1.66M fills; stale price history fakes edges.",
      "Gold daily momentum: first ask 55-70c with 4 h+ left, 69% won, +8.1c, 142 days (54 combos tested).",
      "SPX/SPY underdog 30-45c is the control (expected ~0). Oil monthly ladder ($5.8M/mo) suits news + Jev.",
    ],
    plan: "Paper only. First trades Monday evening KST (markets trade US hours, weekdays).",
    report: "reviews/indices-thesis-2026-11-07.md",
  },
  weather: {
    group: "weather",
    books: () => false,
    collector: ["temperature", "weather_other"],
    tags: ["daily-temperature"],
    research: [
      "53 cities' daily highest temperature, 11 brackets each, settled from airport METAR.",
      "Collector stores every bracket market, its prices and the METAR readings (results/temperature).",
      "Thesis (8 Nov): free forecasts lose to the market; morning favourites fair; afternoon favourites underpriced.",
      "Paper rule: leading bucket at 16:00 local priced 50-85c, backtest 398 trades, 76% won, +3.7c/share (43 days).",
    ],
    plan: "Paper: weather-fav16 (16:00 local) and shadow weather-fav15, ~9 + ~18 trades/day; real only after 100+ fillable trades, >=50% won, positive net.",
  },
  tennis: {
    group: "tennis",
    books: (m) => /tennis|wta|atp|itf/i.test(`${m.series ?? ""} ${m.question ?? ""}`),
    collector: ["tennis"],
    tags: ["tennis"],
    research: [
      "Pre-match and in-play prices are fair; nothing for real money.",
      "One weak lead: WTA singles favourite at 90-95c, 10 min before start: 298 bets, 96.0% won vs 92.5c, +3.0c/share; ATP and ITF negative.",
    ],
    plan: "Paper: tennis-wta-fav90 plus shadows (ATP 90-95, WTA 85-90, ITF 90-95, any 95-99). ~9 main bets a week; real only after 100+ fillable at +3c/share.",
    report: "reviews/tennis-thesis-2026-11-08.md",
  },
  politics: {
    group: "politics",
    books: () => false,
    collector: ["politics"],
    research: [
      "No edge on 8,460 markets; Kalshi / PredictIt within ~2.5c.",
      "Election lock: favourite at 97-99c, 1-7 days out, 541 past trades, about +2% (449 of them from one midterm night).",
    ],
    plan: "Paper taker + maker (1c under). Cross-venue gap log. Real only after 100+ fillable trades.",
    report: "reviews/politics-thesis-2026-11-07.md",
  },
  other: {
    group: "cricket",
    books: (m) => m.family === "games" && !US.test(m.series ?? ""),
    collector: ["tennis", "other_sports", "sports_futures", "other"],
    tags: ["tennis", "ufc", "cricket"],
    research: [
      "Tennis: $9.7M ATP + $5M WTA a day, the biggest category with no research thread yet.",
      "Collector also stores cricket, UFC, F1, season futures and culture / economy markets.",
      "Cricket (8 Nov scan): favourite 65-95c 10 min before start, real buy fills: 386 matches, 85.5% won, +5.1c/share; underdogs -6.5c.",
    ],
    plan: "Paper: cricket-fav10 (favourite 65-95c, 10 min before start) + shadows cricket-fav60 and cricket-dog-control. ~2 bets/day; real only after 100+ fillable at +3c/share and 50%+ won.",
    report: "reviews/other-categories-2026-11-08.md",
  },
};
export const RULE_NAMES: Record<string, string> = {
  "football-laliga-home": "La Liga home favourite 65-80c",
  "tennis-wta-fav90": "WTA favourite 90-95c, 10 min before start",
  "tennis-atp-fav90": "ATP favourite 90-95c",
  "tennis-wta-fav85": "WTA favourite 85-90c",
  "tennis-itf-fav90": "ITF favourite 90-95c",
  "tennis-fav95": "Any tour favourite 95-99c",
  "cricket-fav10": "Cricket favourite 65-95c, 10 min before start",
  "cricket-fav60": "Cricket favourite, 60 min before start",
  "cricket-dog-control": "Cricket underdog 20-35c (control)",
  "weather-fav16": "Afternoon favourite bucket at 16:00 local, 50-85c",
  "weather-fav15": "Afternoon favourite at 15:00 local",
  "weather-fav16-wide": "16:00 favourite, ask up to mid+5c",
  "football-portugal-home": "Portugal home favourite 65-80c",
  "football-italy-away": "Italy away favourite 65-80c",
  "football-laliga-home55": "La Liga home 55-65c (control)",
  "esports-map1": "Map-1 under-reaction (CS2/LoL/Val)",
  "esports-fav-shadow": "Favourite won map 1, price stuck",
  "esports-map1-dota": "Map-1 under-reaction, Dota 2",
  "esports-lol-fav90": "LoL match favourite 90-98c, pre-match",
  "esports-cs2-fav90": "CS2 match favourite 90-98c, pre-match",
  "gold-momentum": "Gold daily momentum 55-70c",
  "spx-underdog": "SPX underdog 30-45c (control)",
  "spy-underdog": "SPY underdog 30-45c (control)",
  "election-lock-taker": "Election lock 97-99c, taker",
  "election-lock-maker": "Election lock 97-99c, maker 1c under",
};
const SHADOW = new Set(["esports-cs2-fav90", "cricket-fav60", "cricket-dog-control", "tennis-atp-fav90", "tennis-wta-fav85", "tennis-itf-fav90", "tennis-fav95", "weather-fav15", "weather-fav16-wide", "football-portugal-home", "football-italy-away", "football-laliga-home55", "esports-fav-shadow", "esports-map1-dota", "spx-underdog", "spy-underdog"]);

async function get(url: string, ms = 8000): Promise<Response> {
  const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 80)}`);
  return r;
}
const memo: Record<string, { at: number; v: unknown; err?: string; p?: Promise<void> }> = {};
/** Value cached for TTL; a failed refresh keeps the last good value and records the error. */
async function cached<T>(key: string, f: () => Promise<T>): Promise<{ v: T | null; at: number; err?: string }> {
  const c = (memo[key] ??= { at: 0, v: null });
  if (Date.now() - c.at > TTL && !c.p)
    c.p = f()
      .then((v) => Object.assign(c, { v, at: Date.now(), err: undefined }))
      .catch((e: Error) => Object.assign(c, { at: Date.now() - TTL + 60_000, err: e.message }))
      .then(() => void (c.p = undefined));
  if (c.p && c.v == null) await c.p;
  return { v: c.v as T | null, at: c.at, err: c.err };
}

type BookRow = { f: string; s: string; q: string; gi: string; gs: string | null; smt: string; o: string[]; px: (number | null)[][] };
async function latestBooks(): Promise<{ t: number; file: string; rows: BookMarket[] }> {
  for (const back of [0, 1]) {
    const day = new Date(Date.now() - back * 86400_000).toISOString().slice(0, 10);
    let names: string[] = [];
    try {
      const xs = (await (await get(`https://api.github.com/repos/${REPO}/contents/data/history/books/${day}?ref=server-data`)).json()) as { name: string }[];
      names = xs.map((x) => x.name).filter((n) => n.endsWith(".json.gz")).sort();
    } catch {
      // GitHub API limit (60/h per IP): find the newest file by trying the last 45 minutes' names on raw.githubusercontent.
      if (back === 0) {
        for (let k = 0; k < 45 && !names.length; k++) {
          const d = new Date(Date.now() - k * 60_000);
          if (d.toISOString().slice(0, 10) !== day) break;
          const n = `${d.toISOString().slice(11, 13)}${d.toISOString().slice(14, 16)}.json.gz`;
          const r = await fetch(`${RAW}/books/${day}/${n}`, { method: "HEAD", headers: { "user-agent": UA }, signal: AbortSignal.timeout(5000) }).catch(() => null);
          if (r?.ok) names = [n];
        }
      }
    }
    if (!names.length) continue;
    const file = `${day}/${names[names.length - 1]}`;
    const buf = Buffer.from(await (await get(`${RAW}/books/${file}`, 15_000)).arrayBuffer());
    const j = JSON.parse(gunzipSync(buf).toString("utf8")) as { t: number; markets: BookMarket[] };
    return { t: j.t * 1000, file, rows: j.markets };
  }
  throw new Error("no book snapshot today or yesterday");
}
const depthAt = (lv: number[][] | undefined) => (lv?.length ? Math.round(lv.filter((x) => x[0] <= lv[0][0] + 0.01 + 1e-9).reduce((s, x) => s + x[0] * x[1], 0)) : null);
function bookRow(m: BookMarket): BookRow {
  return {
    f: m.family ?? "finance",
    s: m.series ?? "",
    q: m.question ?? "",
    gi: m.group_item ?? "",
    gs: m.game_start ?? m.end ?? null,
    smt: m.smt ?? "",
    o: m.outcomes ?? [],
    px: (m.books ?? []).map((b) => [b.bids?.[0]?.[0] ?? null, b.asks?.[0]?.[0] ?? null, depthAt(b.asks)]),
  };
}

type DayStat = { events?: number; markets?: number; with_prices?: number; points_1m?: number };
async function collectorState() {
  const j = (await (await get(`${RAW}/state.json`, 15_000)).json()) as { days: Record<string, { at?: string; pass?: string; stats?: Record<string, DayStat> }> };
  const fam: Record<string, { days: number; first: string | null; last: string | null; events: number; markets: number; withPrices: number; points1m: number }> = {};
  let lastAt = "";
  for (const [day, d] of Object.entries(j.days ?? {})) {
    if ((d.at ?? "") > lastAt) lastAt = d.at ?? "";
    for (const [f, s] of Object.entries(d.stats ?? {})) {
      const o = (fam[f] ??= { days: 0, first: null, last: null, events: 0, markets: 0, withPrices: 0, points1m: 0 });
      o.days++;
      if (!o.first || day < o.first) o.first = day;
      if (!o.last || day > o.last) o.last = day;
      o.events += s.events ?? 0;
      o.markets += s.markets ?? 0;
      o.withPrices += s.with_prices ?? 0;
      o.points1m += s.points_1m ?? 0;
    }
  }
  return { lastAt: lastAt ? Date.parse(lastAt) : null, days: Object.keys(j.days ?? {}).length, fam };
}

type GM = { question?: string; groupItemTitle?: string; outcomes?: string; outcomePrices?: string; bestAsk?: number; bestBid?: number; sportsMarketType?: string; gameStartTime?: string; volumeNum?: number; closed?: boolean };
type GE = { id?: string; title?: string; startTime?: string; endDate?: string; volume24hr?: number; volume?: number; liquidity?: number; markets?: GM[]; seriesSlug?: string };
const jl = (x: unknown): string[] => {
  try {
    return Array.isArray(x) ? (x as string[]) : typeof x === "string" ? (JSON.parse(x) as string[]) : [];
  } catch {
    return [];
  }
};
const ts = (s?: string) => (s ? Date.parse(s.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")) : NaN);
/** Upcoming events for a tag list: start, title, volume and the main prices (moneyline outcomes, or the top brackets). */
async function upcoming(tags: string[]) {
  const now = Date.now();
  const out: { t: number; title: string; tag: string; vol: number | null; liq: number | null; px: { n: string; p: number }[] }[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    let evs: GE[] = [];
    try {
      evs = (await (await get(`${GAMMA}/events?tag_slug=${tag}&closed=false&end_date_min=${new Date(now).toISOString()}&end_date_max=${new Date(now + 36 * 3600_000).toISOString()}&limit=100`)).json()) as GE[];
    } catch {
      continue;
    }
    for (const e of evs) {
      if (!e.id || seen.has(e.id)) continue;
      seen.add(e.id);
      const ms = (e.markets ?? []).filter((m) => !m.closed);
      const ml = ms.filter((m) => m.sportsMarketType === "moneyline");
      const use = ml.length ? ml : ms;
      let px: { n: string; p: number }[] = [];
      if (use.length === 1) {
        const o = jl(use[0].outcomes);
        const p = jl(use[0].outcomePrices).map(Number);
        px = o.map((n, i) => ({ n, p: p[i] })).filter((x) => Number.isFinite(x.p));
      } else {
        px = use.map((m) => ({ n: m.groupItemTitle || m.question || "", p: Number(jl(m.outcomePrices)[0]) })).filter((x) => Number.isFinite(x.p));
      }
      px.sort((a, b) => b.p - a.p);
      const start = ts(use[0]?.gameStartTime) || ts(e.startTime) || ts(e.endDate);
      out.push({ t: Number.isFinite(start) ? start : ts(e.endDate), title: e.title ?? "", tag, vol: e.volume24hr ?? e.volume ?? null, liq: e.liquidity ?? null, px: px.slice(0, 3) });
    }
  }
  return out.filter((x) => x.t > now - 3 * 3600_000).sort((a, b) => a.t - b.t).slice(0, 40);
}

/** /api/events?sec=<id>: everything one category tab shows. */
export async function eventsStatus(sec: string): Promise<unknown> {
  const cat = CATS[sec];
  if (!cat) return { error: "unknown category" };
  const sum = loadJson<Record<string, unknown> & { at?: number; health?: unknown }>("eventpaper-summary.json", {});
  const [bk, col, up] = await Promise.all([cached("books", latestBooks), cached("collector", collectorState), cat.tags ? cached(`up:${sec}`, () => upcoming(cat.tags!)) : Promise.resolve(null)]);
  const books = bk.v ? bk.v.rows.filter(cat.books).slice(0, 80).map(bookRow) : [];
  const fam = col.v ? Object.fromEntries(cat.collector.map((f) => [f, col.v!.fam[f] ?? null])) : null;
  return {
    sec,
    at: Date.now(),
    paper: cat.group ? (sum[cat.group] ?? null) : null,
    paperAt: sum.at ?? null,
    health: sum.health ?? null,
    names: RULE_NAMES,
    shadow: [...SHADOW],
    research: cat.research,
    plan: cat.plan,
    report: cat.report ?? null,
    books: { at: bk.v?.t ?? null, file: bk.v?.file ?? null, err: bk.err ?? null, total: bk.v?.rows.length ?? 0, rows: books },
    collector: { at: col.v?.lastAt ?? null, days: col.v?.days ?? 0, err: col.err ?? null, fam },
    upcoming: up ? { at: up.at, err: up.err ?? null, rows: up.v ?? [] } : null,
  };
}

// ---------- page parts ----------
export const EV_CSS = String.raw`
.ev .hero{gap:22px 34px}.ev .hero .clock{font-size:52px}.ev .nxt{min-width:0;max-width:100%}.ev .nxt .t{color:var(--mut);font-size:12px;max-width:min(520px,80vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ev .chips{display:flex;flex-wrap:wrap;gap:6px;flex-basis:100%}.ev .chip{font-size:11px;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--mut);white-space:nowrap}.ev .chip b{color:var(--fg);font-weight:600}.ev .chip.ok{border-color:rgba(61,220,132,.45)}.ev .chip.bad{border-color:rgba(255,107,107,.55);color:var(--down)}
.ev .chip i{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;vertical-align:1px;background:var(--mut)}.ev .chip.ok i{background:var(--up);box-shadow:0 0 6px var(--up)}.ev .chip.bad i{background:var(--down)}
.ev table td.mk{max-width:0;width:44%;overflow:hidden;text-overflow:ellipsis}.ev table td.mk .s{display:block;color:var(--mut);font-size:11px;overflow:hidden;text-overflow:ellipsis}
.ev .panel{overflow-x:hidden}.ev table{table-layout:auto}.ev td{font-size:13px}
.ev .jv{display:inline-block;font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:1px 6px;border-radius:999px;border:1px solid var(--line);color:var(--mut)}.ev .jv.double{color:var(--up);border-color:var(--up)}.ev .jv.normal{color:var(--fg)}.ev .jv.half{color:var(--acc);border-color:var(--acc)}.ev .jv.skip{color:var(--down);border-color:var(--down)}
.ev .bar{display:inline-block;height:6px;border-radius:3px;background:var(--line);vertical-align:1px;margin-right:6px;width:60px;overflow:hidden}.ev .bar>span{display:block;height:100%;background:var(--mut)}
.ev ul.rs{margin:0;padding-left:18px}.ev ul.rs li{margin:0 0 6px;line-height:1.45}.ev .plan{margin-top:10px;padding:10px 12px;border:1px dashed var(--line);border-radius:8px}
.ev .netc svg{display:block;width:100%;height:190px}.ev .netc .gl{stroke:var(--line)}.ev .netc .gt{font-size:10px;fill:var(--mut);font-family:inherit}
.ev .lg{display:flex;gap:14px;font-size:11px;color:var(--mut);flex-wrap:wrap}.ev .lg i{display:inline-block;width:14px;height:2px;vertical-align:3px;margin-right:5px}
.ev .cd{font-weight:600}.ev .cd.soon{color:var(--acc)}.ev .cd.live{color:var(--up)}
.ev .why{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
@media(max-width:700px){.ev .ph{flex-wrap:wrap;gap:4px 10px}.ev .ph>.mut{text-align:left;flex-basis:100%;font-size:11px}.ev .chip{white-space:normal}.ev .nm{display:none}.ev .hero .clock{font-size:40px}.ev table td.mk{width:auto;min-width:110px;max-width:none;white-space:normal;overflow-wrap:anywhere}.ev table td.mk .s{white-space:normal}.ev th{font-size:9px;letter-spacing:.06em}.ev td,.ev th{padding-right:8px}.ev td{font-size:12px}.ev .stats{gap:16px}}
`;
export function evSectionHtml(id: string, label: string): string {
  const has = Boolean(CATS[id]?.group);
  return `<section class="sec hide ev" id="sec-${id}">
<div class="panel" style="margin-bottom:14px"><div class="hero">
  <div class="nxt"><div class="k" id="ev-${id}-nk">next market</div><div class="clock" id="ev-${id}-clock">–:––</div><div class="t" id="ev-${id}-nt"></div></div>
  <div class="stats" id="ev-${id}-stats"></div>
  <div class="chips" id="ev-${id}-chips"></div>
</div></div>
<div class="grid">
  <div class="panel"><div class="ph"><div class="k">${has ? 'rules <span class="tag paper">paper · $5 a bet</span>' : "research &amp; planned rule"}</div><div class="mut" id="ev-${id}-rsub"></div></div><div id="ev-${id}-rules"></div></div>
  <div class="panel"><div class="ph"><div class="k">${has ? 'trade log <span class="tag paper">paper</span>' : "markets watched"}</div><div class="mut" id="ev-${id}-lsub"></div></div><div id="ev-${id}-log"></div></div>
</div>
${has ? `<div class="grid"><div class="panel"><div class="ph"><div class="k">net over time <span class="tag paper">paper</span></div><div class="lg" id="ev-${id}-lg"></div></div><div class="netc" id="ev-${id}-chart"></div><div id="ev-${id}-days"></div></div>
<div class="panel"><div class="ph"><div class="k">why no trade fired</div><div class="mut" id="ev-${id}-wsub"></div></div><div id="ev-${id}-why"></div></div></div>
<div class="panel" style="margin-bottom:14px"><div class="ph"><div class="k">markets watched</div><div class="mut" id="ev-${id}-wtsub"></div></div><div id="ev-${id}-watch"></div></div>` : ""}
<div class="panel" style="margin-bottom:14px"><div class="ph"><div class="k">live order books <span class="mut">· can a $5 bet fill?</span></div><div class="mut" id="ev-${id}-bsub"></div></div><div id="ev-${id}-books"></div></div>
<div class="grid">
  ${has ? `<div class="panel"><div class="ph"><div class="k">research</div><div class="mut" id="ev-${id}-resub"></div></div><div id="ev-${id}-research"></div></div>` : ""}
  <div class="panel"${has ? "" : ' style="grid-column:1/-1"'}><div class="ph"><div class="k">data collector</div><div class="mut" id="ev-${id}-csub"></div></div><div id="ev-${id}-col"></div></div>
</div>
</section>`;
}

/** Client code (plain ES5 string, no template literals): evPoll() fetches /api/events for the open tab, evRender() draws it. */
export const EV_JS = String.raw`
var EVD={},EVBUSY=false;
var evE=function(x){return String(x==null?"":x).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})};
var evS=function(v){return v==null?"—":(v<0?"-$":"+$")+Math.abs(v).toFixed(2)};
var evC=function(p){return p==null||!isFinite(p)?"—":(p*100<1&&p>0?(p*100).toFixed(1):Math.round(p*100))+"c"};
var evT=function(ms){return new Date(ms).toLocaleTimeString("en-GB",{timeZone:"Asia/Seoul",hour:"2-digit",minute:"2-digit"})};
var evD=function(ms){return new Date(ms).toLocaleString("en-GB",{timeZone:"Asia/Seoul",weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})};
var evAgo=function(ms){if(!ms)return "never";var s=Math.max(0,(Date.now()-ms)/1000);return s<90?Math.round(s)+" s ago":s<5400?Math.round(s/60)+" min ago":s<172800?Math.round(s/3600)+" h ago":Math.round(s/86400)+" days ago"};
var evLeft=function(ms){var s=Math.round((ms-Date.now())/1000);if(s<=0)return s>-10800?"live":"over";var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60),x=s%60;return d?d+"d "+h+"h":h?h+"h "+(m<10?"0":"")+m+"m":m+":"+(x<10?"0":"")+x};
var evCd=function(ms){var s=(ms-Date.now())/1000;return '<span class="cd'+(s<=0&&s>-10800?" live":s<1800?" soon":"")+'" data-cd="'+ms+'">'+evLeft(ms)+'</span>'};
var evDayLab=function(ms){var k=new Date(ms+9*3600000).toISOString().slice(0,10),n=new Date(Date.now()+9*3600000).toISOString().slice(0,10),y=new Date(Date.now()-15*3600000).toISOString().slice(0,10);var lab=new Date(ms).toLocaleDateString("en-GB",{timeZone:"Asia/Seoul",weekday:"short",day:"numeric",month:"short"});return k===n?"today · "+lab:k===y?"yesterday · "+lab:lab};
var evStat=function(k,v,c,t){return '<div'+(t?' title="'+evE(t)+'"':'')+'><div class="k">'+k+'</div><div class="v big '+(c||"")+'">'+v+'</div></div>'};
var evChip=function(st,txt,t){return '<span class="chip '+st+'"'+(t?' title="'+evE(t)+'"':'')+'><i></i>'+txt+'</span>'};
var evJv=function(p,c){if(p==null)return '<span class="mut">—</span>';var k=String(p);if(k.indexOf("error")===0)return '<span class="jv skip" title="'+evE(k)+'">error</span>';return '<span class="jv '+evE(k)+'">'+evE(k)+'</span>'+(c!=null?' <span class="mut">'+Math.round(c)+'</span>':'')};
var evTbl=function(head,rows,empty){return rows.length?'<table class="log"><thead><tr>'+head.map(function(h){var a=h.split("|");return '<th class="'+(a[1]||"")+'">'+a[0]+'</th>'}).join("")+'</tr></thead><tbody>'+rows.join("")+'</tbody></table>':'<div class="empty">'+empty+'</div>'};
var evName=function(D,r){return (D.names&&D.names[r])||(D.names&&D.names[r.replace(/-nearmiss$/,"")]?D.names[r.replace(/-nearmiss$/,"")]+" (near miss)":r)};
var evShadow=function(D,r){return (D.shadow||[]).indexOf(r)>=0};
function evPoll(force){if(SEC==="crypto"||EVBUSY)return;var sec=SEC;if(!force&&EVD[sec]&&Date.now()-EVD[sec].got<20000)return;EVBUSY=true;fetch("/api/events?sec="+encodeURIComponent(sec)).then(function(r){return r.json()}).then(function(D){D.got=Date.now();EVD[sec]=D;try{evRender(sec,D)}catch(e){console.error(e)}}).catch(function(){}).then(function(){EVBUSY=false})}
function evTick(){var xs=document.querySelectorAll("[data-cd]");for(var i=0;i<xs.length;i++){var ms=Number(xs[i].getAttribute("data-cd"));xs[i].textContent=evLeft(ms);var s=(ms-Date.now())/1000;xs[i].className=(xs[i].classList.contains("clock")?"clock":"cd")+(s<=0&&s>-10800?" live":s<1800?" soon":"")}}
function evChart(days){if(!days||!days.length)return '<div class="empty">The line starts with the first settled paper bet.</div>';var a=0,f=0,j=0;var pts=[{d:"start",a:0,f:0,j:0}].concat(days.map(function(x){a+=x.net;f+=x.fnet;j+=x.jnet;return {d:x.day,a:a,f:f,j:j}}));var W=560,H=190,L=44,R=8,T=10,B=22;var vs=[0];pts.forEach(function(p){vs.push(p.a,p.f,p.j)});var lo=Math.min.apply(null,vs),hi=Math.max.apply(null,vs);if(hi-lo<1){hi+=0.5;lo-=0.5}var X=function(i){return L+(W-L-R)*(pts.length<2?0:i/(pts.length-1))},Y=function(v){return T+(H-T-B)*(1-(v-lo)/(hi-lo))};var line=function(k,col,dash){return '<polyline fill="none" stroke="'+col+'" stroke-width="2"'+(dash?' stroke-dasharray="4 3"':'')+' points="'+pts.map(function(p,i){return X(i).toFixed(1)+","+Y(p[k]).toFixed(1)}).join(" ")+'"/>'};var g='<line class="gl" x1="'+L+'" x2="'+(W-R)+'" y1="'+Y(0)+'" y2="'+Y(0)+'"/><text class="gt" x="'+(L-6)+'" y="'+(Y(0)+3)+'" text-anchor="end">$0</text><text class="gt" x="'+(L-6)+'" y="'+(Y(hi)+8)+'" text-anchor="end">'+evS(hi)+'</text><text class="gt" x="'+(L-6)+'" y="'+Y(lo)+'" text-anchor="end">'+evS(lo)+'</text>';var lab=function(i){return '<text class="gt" x="'+X(i)+'" y="'+(H-6)+'" text-anchor="'+(i===0?"start":i===pts.length-1?"end":"middle")+'">'+pts[i].d.slice(5)+'</text>'};var fin=pts[pts.length-1];var col=fin.a<0?"#ff6b6b":"#3ddc84";return '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'+g+line("f","#7b8294",true)+line("j","#f7931a",true)+line("a",col)+lab(0)+(pts.length>2?lab(pts.length-1):lab(1))+'</svg>'}
function evRender(sec,D){var P=D.paper,id="ev-"+sec,q=function(k){return el(id+"-"+k)};if(!q("stats"))return;
var W=[];
if(P&&P.watch)W=P.watch.slice();else if(D.upcoming)W=D.upcoming.rows.slice();W.sort(function(a,b){return a.t-b.t});
var now=Date.now();var nx=W.filter(function(w){return w.t>now}).sort(function(a,b){return a.t-b.t})[0];
var nk=sec==="indices"?"next close":sec==="politics"?"next to settle":sec==="weather"?"next market closes":"next kickoff";if(sec==="esports"||sec==="us-sports"||sec==="other")nk="next match starts";
q("nk").textContent=nx?nk+" · "+evT(nx.t)+" kst":nk;var ck=q("clock");if(nx){ck.setAttribute("data-cd",nx.t);ck.textContent=evLeft(nx.t)}else{ck.removeAttribute("data-cd");ck.textContent="–:––"}q("nt").textContent=nx?nx.title:"nothing scheduled in view";
var st="",chips="";
if(P){var R=P.rules||[];var sm=function(f){return R.reduce(function(a,r){return a+(f(r)||0)},0)};var net=sm(function(r){return r.net}),fn=sm(function(r){return r.fillable.net}),tr=sm(function(r){return r.trades}),op=sm(function(r){return r.open}),se=sm(function(r){return r.settled}),wn=sm(function(r){return r.won}),sg=sm(function(r){return r.signals});var jn=sm(function(r){return r.jev&&r.jev.settled?r.jev.net:0}),js=sm(function(r){return r.jev?r.jev.settled:0});
var tdy=new Date(now+9*3600000).toISOString().slice(0,10);var td=(P.days||[]).filter(function(d){return d.day===tdy})[0];
st=evStat("today",td?evS(td.net):"$0.00",td?cls(td.net):"","paper net of bets settled today (KST)")+evStat("paper net",evS(net),cls(net),"all settled paper bets, $5 each")+evStat("fillable",evS(fn),cls(fn),"only bets whose whole $5 fitted at the ask")+evStat("Jev-sized",js?evS(jn):"—",js?cls(jn):"","same bets, stake picked by Jev (skip / half / normal / double)")+evStat("bets",tr+(op?' <span class="mut" style="font-size:14px">'+op+' open</span>':''),"")+evStat("won",se?Math.round(100*wn/se)+"%":"—","",se?wn+" of "+se+" settled":"")+evStat("signals",sg,"");
var H=D.health||{};var jobs={football:["football list","football"],esports:["esports list","esports"],indices:["indices"],politics:["politics","makers"]}[sec]||[];var lastOk=0,err=null;jobs.forEach(function(j){var h=H[j]||{};if(h.ok>lastOk)lastOk=h.ok;if(h.errAt&&(!h.ok||h.errAt>h.ok))err=j+": "+h.err});var stale=!D.paperAt||now-D.paperAt>180000;
chips+=evChip(stale||err?"bad":"ok","paper logger "+(stale?"silent since "+evAgo(D.paperAt):err?"error":"running · "+evAgo(lastOk||D.paperAt)),err||"");var jh=H.jev||{};var jask=sm(function(r){return r.jev?r.jev.asked:0}),jer=sm(function(r){return r.jev?r.jev.errors:0});chips+=evChip(jer&&jer===jask?"bad":jask?"ok":"","Jev sizing · <b>"+jask+"</b> asked"+(jer?" · "+jer+" errors":""),jh.err||"")}
else{var nUp=D.upcoming?D.upcoming.rows.filter(function(w){return w.t>now}).length:0;var cf=D.collector&&D.collector.fam||{};var ev=0,dd=0;Object.keys(cf).forEach(function(k){if(cf[k]){ev+=cf[k].events;dd=Math.max(dd,cf[k].days)}});
st=evStat("rule","none yet","mut")+evStat("markets next 36 h",nUp,"")+evStat("books now",D.books.rows.length,"","markets in the latest order-book snapshot (games starting within 95 min)")+evStat("events stored",ev.toLocaleString("en-US"),"","resolved events in the backtest collector")+evStat("days",dd,"")}
var B=D.books||{},C=D.collector||{};chips+=evChip(B.err&&!B.at?"bad":B.at&&now-B.at<1800000?"ok":"","order books · "+(B.at?evAgo(B.at):"none")+(B.total?" · "+B.total+" markets":""),B.err||B.file||"");chips+=evChip(C.err&&!C.at?"bad":C.at?"ok":"","collector · "+(C.at?"last day pulled "+evAgo(C.at):"—")+(C.days?" · "+C.days+" days":""),C.err||"every 6 h on GitHub, data/history in server-data");if(D.upcoming)chips+=evChip(D.upcoming.err?"bad":"ok","Polymarket list · "+evAgo(D.upcoming.at),D.upcoming.err||"");
q("stats").innerHTML=st;q("chips").innerHTML=chips;
// rules (or research for tabs with no rule yet)
if(P){q("rsub").textContent="Jev-sized = same bets, stake picked by Jev";q("rules").innerHTML=evTbl(["rule","signals|r nm","bets|r","won|r nm","c/share|r nm","net|r","fillable|r","Jev-sized|r"],P.rules.map(function(r){var J=r.jev||{};var b=J.buckets||{};var bk=["skip","half","normal","double"].filter(function(k){return b[k]}).map(function(k){return k+" "+b[k].won+"/"+b[k].n}).join(" · ");return '<tr><td class="mk" title="'+evE(r.rule)+'">'+evE(evName(D,r.rule))+'<span class="s">'+(evShadow(D,r.rule)?"shadow · ":"")+(r.open?r.open+" open · ":"")+(r.nearMisses?r.nearMisses+" near misses · ":"")+(J.asked?"Jev asked "+J.asked+(bk?" · "+bk:""):"Jev not asked yet")+'</span></td><td class="r nm">'+r.signals+'</td><td class="r">'+r.trades+'</td><td class="r nm">'+(r.settled?r.won+"/"+r.settled+' <span class="mut">'+Math.round(100*r.won/r.settled)+"%</span>":"—")+'</td><td class="r nm '+cls(r.perShare)+'">'+(r.perShare==null?"—":(r.perShare>0?"+":"")+r.perShare+"c")+'</td><td class="r '+cls(r.settled?r.net:null)+'"><b>'+(r.settled?evS(r.net):"—")+'</b></td><td class="r '+cls(r.fillable.trades?r.fillable.net:null)+'">'+(r.fillable.trades?evS(r.fillable.net)+' <span class="mut">'+r.fillable.won+"/"+r.fillable.trades+"</span>":"—")+'</td><td class="r '+cls(J.settled?J.net:null)+'">'+(J.settled?evS(J.net)+(J.perDollar!=null?' <span class="mut">'+(J.perDollar>0?"+":"")+J.perDollar+"c/$</span>":""):"—")+'</td></tr>'}),"no rules")}
else{q("rsub").textContent=D.report||"";q("rules").innerHTML='<ul class="rs">'+(D.research||[]).map(function(x){return "<li>"+evE(x)+"</li>"}).join("")+'</ul><div class="plan"><div class="k">planned rule · Jev will size every bet</div>'+evE(D.plan||"")+'</div>'}
// trade log (or watched markets for tabs with no rule)
var watchRows=function(rows,lim){return rows.slice(0,lim).map(function(w){var px="";if(w.homeAsk!==undefined)px=evE(w.home)+" "+evC(w.homeAsk)+" · "+evE(w.away)+" "+evC(w.awayAsk);else if(w.asks)px=(w.outs||[]).map(function(o,i){return evE(o)+" "+evC(w.asks[i])}).join(" · ");else if(w.px&&w.px.map)px=w.px.map(function(x){return evE(x.n)+" "+evC(x.p)}).join(" · ");else if(w.px0!==undefined)px=(w.outs&&w.outs[0]?evE(w.outs[0])+" ":"")+evC(w.px0)+(w.p0!=null?' <span class="mut">P0 '+evC(w.p0)+"</span>":"");else if(w.ask!=null)px=evE(w.outcome)+" "+evC(w.ask);var sub=[w.league||w.game||w.tag||"",w.rule?evName(D,w.rule):"",w.vol!=null?"$"+Math.round(w.vol).toLocaleString("en-US")+" vol":"",w.liq!=null?"$"+Math.round(w.liq).toLocaleString("en-US")+" liq":""].filter(Boolean).join(" · ");return '<tr><td>'+evCd(w.t)+'<span class="mut" style="display:block;font-size:11px">'+evT(w.t)+'</span></td><td class="mk">'+evE(w.title)+'<span class="s">'+evE(sub)+'</span></td><td class="nm">'+px+'</td><td class="mut" style="white-space:normal;font-size:12px">'+evE(w.status||"")+'</td></tr>'})};
if(P){var L=P.recent||[];var open=L.filter(function(t){return t.pnl==null}),done=L.filter(function(t){return t.pnl!=null});var rows=[],lastDay="";var row=function(t){var jm=t.jm;var jp=t.pnl!=null&&jm!=null?t.pnl*jm:null;return '<tr><td>'+evT(t.t)+'</td><td class="mk" title="'+evE(t.rule)+'">'+evE(t.title)+'<span class="s">'+evE(evName(D,t.rule))+(t.info?" · "+evE(t.info):"")+'</span></td><td>'+evE(t.outcome)+'<span class="mut" style="display:block;font-size:11px">'+evC(t.ask)+(t.avg!=null&&Math.abs(t.avg-t.ask)>0.0005?" → "+(t.avg*100).toFixed(1)+"c":"")+(t.fillable?"":" · thin")+'</span></td><td>'+evJv(t.jev,t.jc)+'</td><td class="r '+cls(t.pnl)+'"><b>'+(t.pnl==null?'<span class="mut">open</span>':evS(t.pnl))+'</b>'+(jp!=null&&jm!==1?'<span class="mut" style="display:block;font-size:11px">Jev '+evS(jp)+'</span>':'')+'</td></tr>'};
if(open.length){rows.push('<tr class="dsep"><td colspan="5">open · '+open.length+' · $'+open.reduce(function(a,t){return a+t.cost},0).toFixed(0)+' at stake</td></tr>');open.forEach(function(t){rows.push(row(t))})}done.forEach(function(t){var dl=evDayLab(t.settledAt||t.t);if(dl!==lastDay){lastDay=dl;rows.push('<tr class="dsep"><td colspan="5">settled · '+dl+'</td></tr>')}rows.push(row(t))});
q("lsub").textContent=L.length?L.length+" latest":"";q("log").innerHTML=evTbl(["kst","market","bet|","Jev|","result|r"],rows,"No paper bets yet. "+(nx?"Next market "+evLeft(nx.t)+" away.":""))}
else{var U=D.upcoming?D.upcoming.rows.filter(function(w){return w.t>now-10800000}):[];q("lsub").textContent=U.length+" in the next 36 h · prices from Polymarket";q("log").innerHTML=evTbl(["starts","market","prices|nm",""],watchRows(U.map(function(w){var x={};for(var k in w)x[k]=w[k];x.status=w.t<=now?"live":"";return x}),40),D.upcoming&&D.upcoming.err?"Polymarket list failed: "+evE(D.upcoming.err):"Nothing listed in the next 36 h.")}
if(P){// chart + days
var days=P.days||[];q("lg").innerHTML='<span><i style="background:#3ddc84"></i>all</span><span><i style="background:#7b8294"></i>fillable</span><span><i style="background:#f7931a"></i>Jev-sized</span>';q("chart").innerHTML=evChart(days);q("days").innerHTML=days.length?evTbl(["day","bets|r","won|r","net|r","fillable|r nm","Jev-sized|r"],days.slice().reverse().slice(0,14).map(function(d){return '<tr><td>'+d.day+'</td><td class="r">'+d.n+'</td><td class="r">'+Math.round(100*d.won/d.n)+'%</td><td class="r '+cls(d.net)+'"><b>'+evS(d.net)+'</b></td><td class="r nm '+cls(d.fnet)+'">'+evS(d.fnet)+'</td><td class="r '+cls(d.jnet)+'">'+evS(d.jnet)+'</td></tr>'}),""):"";
// why no trade
var S=P.sigs||[];var tally={};S.forEach(function(x){if(x.traded)return;var k=x.why.replace(/[0-9.$]+c?/g,"#");tally[k]=(tally[k]||0)+1});if(P.notes)Object.keys(P.notes).forEach(function(k){if(k!=="upcoming"&&k!=="live"&&k!=="evaluated")tally["match: "+k]=(tally["match: "+k]||0)+P.notes[k]});(P.watch||[]).forEach(function(w){if(w.status&&/^(no rule fired|skipped|below|above|under|liquidity|waiting)/.test(w.status)){var k=w.status.replace(/[0-9.$—]+c?/g,"#").replace(/home #, away #/,"ask outside the band");tally[k]=(tally[k]||0)+1}});var tk=Object.keys(tally).sort(function(a,b){return tally[b]-tally[a]});
q("wsub").textContent=S.length?S.length+" latest signal"+(S.length>1?"s":""):"";q("why").innerHTML=(tk.length?'<div class="why">'+tk.slice(0,10).map(function(k){return '<span class="chip"><b>'+tally[k]+'</b> '+evE(k)+'</span>'}).join("")+'</div>':'')+evTbl(["kst","rule|nm","market","ask|r nm","outcome"],S.slice(0,15).map(function(x){return '<tr><td>'+evT(x.t)+'</td><td class="mut nm" style="font-size:11px">'+evE(evName(D,x.rule))+'</td><td class="mk">'+evE(x.title)+'</td><td class="r nm">'+evC(x.ask)+'</td><td class="'+(x.traded?"ok":"mut")+'" style="white-space:normal;font-size:12px">'+evE(x.why)+'</td></tr>'}),"No signal yet: no market has reached a rule's entry point.");
// watched
var WT=(P.watch||[]).filter(function(w){return w.t>now-10800000}).sort(function(a,b){return a.t-b.t});q("wtsub").textContent=WT.length+" markets"+(P.watching!=null?" · "+P.watching+" in the next 24 h":"")+(P.upcoming!=null?" · "+P.upcoming+" fixtures ahead":"");q("watch").innerHTML=evTbl(["starts","market","prices|nm","status"],watchRows(WT,40),"Nothing on the watch list right now.");
q("resub").textContent=D.report||"";q("research").innerHTML='<ul class="rs">'+(D.research||[]).map(function(x){return "<li>"+evE(x)+"</li>"}).join("")+'</ul><div class="plan"><div class="k">next step</div>'+evE(D.plan||"")+'</div>'}
// books
var gsOf=function(m){return m.gs?Date.parse(String(m.gs).replace(" ","T").replace(/([+-]\d\d)$/,"$1:00")):NaN};var BR=(B.rows||[]).filter(function(m){var p=m.px[0]||[];var g=gsOf(m);return p[1]!=null&&p[1]<0.99&&!(p[0]!=null&&p[0]>=0.99)&&!(isFinite(g)&&g<now-5*3600000)}).sort(function(a,b){return (gsOf(a)||0)-(gsOf(b)||0)});q("bsub").textContent=B.at?"snapshot "+evT(B.at)+" kst · every 10 min":"";q("books").innerHTML=evTbl(["starts","market","bid / ask|r","$ at ask|r","spread|r nm"],BR.slice(0,30).map(function(m){var p=m.px[0]||[];var sp=p[0]!=null&&p[1]!=null?p[1]-p[0]:null;var gs=m.gs?Date.parse(String(m.gs).replace(" ","T").replace(/([+-]\d\d)$/,"$1:00")):NaN;return '<tr><td>'+(isFinite(gs)?evCd(gs):"—")+'</td><td class="mk">'+evE(m.q)+'<span class="s">'+evE(m.s+(m.smt?" · "+m.smt:""))+'</span></td><td class="r">'+evC(p[0])+" / "+evC(p[1])+'</td><td class="r '+(p[2]!=null&&p[2]>=5?"ok":"bad")+'">'+(p[2]==null?"—":"$"+p[2])+'</td><td class="r nm '+(sp!=null&&sp>0.03?"bad":"")+'">'+(sp==null?"—":Math.round(sp*100)+"c")+'</td></tr>'}),B.err&&!B.at?"Order books unavailable: "+evE(B.err):sec==="weather"||sec==="politics"?"The book recorder covers games and daily index markets only; "+(sec==="weather"?"temperature":"politics")+" books are not snapshotted yet.":"No market of this kind starts within 95 min.");
// collector
var F=C.fam||{};var fk=Object.keys(F);q("csub").textContent=C.at?"updated "+evAgo(C.at):"";q("col").innerHTML=evTbl(["data|","days|r","events|r","markets|r nm","with prices|r","1-min points|r nm","range|nm"],fk.map(function(k){var f=F[k];if(!f)return '<tr><td>'+evE(k)+'</td><td colspan="6" class="mut">no days yet</td></tr>';return '<tr><td>'+evE(k.replace(/_/g," "))+'</td><td class="r">'+f.days+'</td><td class="r">'+f.events.toLocaleString("en-US")+'</td><td class="r nm">'+f.markets.toLocaleString("en-US")+'</td><td class="r">'+f.withPrices.toLocaleString("en-US")+'</td><td class="r nm">'+f.points1m.toLocaleString("en-US")+'</td><td class="nm mut">'+evE((f.first||"")+" → "+(f.last||""))+'</td></tr>'}),C.err?"Collector state unavailable: "+evE(C.err):"loading")+'<div class="note">Resolved Polymarket events, markets and 1-min prices for backtests (GitHub Action every 6 h; a day is pulled 2 days after it ends) + order books every 10 min. Results from independent sources in results/.</div>';
evTick()}
setInterval(evTick,1000);setInterval(function(){evPoll(false)},5000);
`;
