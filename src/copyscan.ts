/**
 * Daily wallet rescan for the copies (14 Nov 2026 17:08 KST, enrique: "yeah" to "an automatic rescan, say once a day,
 * that adds wallets passing the bar to paper first and moves them to real once they prove out").
 *
 * Runs inside the paper process (src/eventpaper.ts), once a day, on the server: no Claude round.
 *  1. Candidates: the Polymarket profit leaderboards (month, top 100) of every category.
 *  2. Screen (copyScreen): up in each of its last 4 weeks, no single week over half of the 4 weeks' profit, $2,000+
 *     made in them; at least 14 buys in the last 7 days (about 2 a day, so copies happen); usual buy $20 or more and
 *     $5,000+ in open positions (17 Nov 2026: money at stake; until then a usual buy over $100 was refused); at
 *     most a third of its buys in crypto "Up or Down" markets (that is the race we lose).
 *  3. At most ADD_PER_DAY new wallets a day go to PAPER copy (rules copy-rest/take/any-<name>), at most MAX_ACTIVE
 *     auto wallets followed at once.
 *  4. Promotion (copyPromote): a paper wallet goes to REAL when its paper copy-take-<name> has PROMOTE_N+ settled
 *     fillable copies, half or more won, and net above 0. Real copies then follow the same rules as every copied
 *     wallet (deploy/live-rules.json events.copy: $3-$10, 14 days at most, stake caps, back to paper at -$10 after 10
 *     settled real copies).
 *  5. A paper wallet that after DROP_DAYS has DROP_N+ settled paper copies and is behind is dropped (no longer followed).
 * 21 Nov 2026 22:18 KST, enrique: "polymarket - find more good traders then, what are u waiting for" (the scan of
 * that evening read 345 new wallets and added 1; 74 followed, 2 at the real bar). Wider, with the money-at-stake
 * floors unchanged:
 *  - the boards are read 10 pages deep (was 3), and every wallet seen buying on the live trade socket
 *    (src/copyseen.ts) is a candidate too: most traders are on no leaderboard;
 *  - one small losing week in the last 4 is allowed (at most a quarter of the 4 weeks' profit);
 *  - a wallet must have made 7+ different bets in 7 days (14 fills of one order gave wallets we never copied), and a
 *    wallet that buys over MACHINE_PER_DAY different sides a day is left out (the four such wallets on paper lost
 *    $2,658 on 13,008 paper copies in a week);
 *  - a paper wallet that has PROMOTE_N+ settled copies and is $FAST_DROP_USD or more behind after FAST_DROP_DAYS days
 *    is dropped, and so is one that gave under IDLE_N copies in IDLE_DAYS days: both only hold a place.
 * State: data/copy-auto.json (server only). Public status shows names and stages, the addresses are public wallets.
 */
import { loadJson, saveJson } from "./store.js";

export const AUTO_FILE = "copy-auto.json";
// 15 Nov 2026 00:52 KST, enrique: "if its possible do it" (widen this scan like the Solana one): every leaderboard
// window (week, month, all time), up to 300 rows a board, up to SCREEN_PER_DAY wallets read a day, 25 a day onto
// paper, 60 followed. Paper wallets are read in turns (src/eventpaper.ts), so the data API load stays near 2 calls/s.
// 18 Nov 2026 10:20 KST, enrique: "we definitely need to see those and more wallets". 60 -> 120 followed, 25 -> 40 a
// day. Paper only: who goes real is still each wallet's own paper record. The live trade stream sees their buys; the
// poll behind it reads each paper wallet about every 3 minutes at 120.
export const ADD_PER_DAY = 40;
// 21 Nov 2026: 120 -> 200 with the wider search; losing and idle paper wallets now leave sooner (copyPromote).
export const MAX_ACTIVE = 200;
export const SCREEN_PER_DAY = 3000;
/** Pages of 100 read of every leaderboard. */
export const BOARD_PAGES = 10;
/** A wallet that failed the screen is not read again for this long. */
export const RESCREEN_DAYS = 7;
const PERIODS = ["month", "week", "all"];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const PROMOTE_N = 40;
/** a wallet that is real stays real while its paper record of KEEP_N+ bets holds (16 Nov 2026: going real needs PROMOTE_N, twice as many, after three wallets promoted on 22-31 paper bets lost their first real copies) */
export const KEEP_N = 20;
export const DROP_DAYS = 14;
export const DROP_N = 10;
/** A paper wallet with the real bar's number of settled copies that is this far behind is dropped without waiting DROP_DAYS. */
export const FAST_DROP_DAYS = 3;
export const FAST_DROP_USD = 5;
/** A paper wallet that gave fewer copies than this (open or settled, any price) in IDLE_DAYS is dropped: nothing to learn from it. */
export const IDLE_DAYS = 7;
export const IDLE_N = 5;
/** Different bets (market sides) a wallet must have bought in 7 days, and the most it may buy in a day. */
export const MIN_BETS_7D = 7;
export const MACHINE_PER_DAY = 150;
const DATA = "https://data-api.polymarket.com";
const CATS = ["overall", "crypto", "sports", "esports", "weather", "politics", "economics", "economy", "finance", "tech", "culture", "mentions"];

export type AutoWallet = { name: string; address: string; addedAt: number; stage: "paper" | "real" | "dropped"; why: string; promotedAt?: number; droppedAt?: number; demotedAt?: number };
export type AutoState = { lastScan: number; scans: number; lastError: string | null; screened: number; passed: number; candidates?: number; fromStream?: number; passedStream?: number; fails?: Record<string, number>; failedVer?: number; failedAt?: Record<string, number>; runStart?: number; ver?: number; sizes?: Record<string, WalletSize>; wallets: AutoWallet[]; log: { t: number; text: string }[] };
const EMPTY: AutoState = { lastScan: 0, scans: 0, lastError: null, screened: 0, passed: 0, wallets: [], log: [] };

export function autoState(): AutoState {
  const s = loadJson<Partial<AutoState>>(AUTO_FILE, {});
  return { ...EMPTY, ...s, wallets: Array.isArray(s.wallets) ? s.wallets : [], log: Array.isArray(s.log) ? s.log : [] };
}
const save = (s: AutoState) => saveJson(AUTO_FILE, s);
/** Wallets the paper copy follows (paper and real). */
export const autoFollowed = (s = autoState()) => s.wallets.filter((w) => w.stage !== "dropped");
/** Real rules added to events.copy by this module. */
export const autoRealRules = (s = autoState()) => s.wallets.filter((w) => w.stage === "real").map((w) => `copy-take-${w.name}`);

type PnlPoint = { timestamp?: number; economic_pnl?: number; unrealized_pnl?: number };
type Act = { type?: string; side?: string; timestamp?: number | string; usdc_size?: number | string; usdcSize?: number | string; title?: string; price?: number | string; size?: number | string; outcome?: string; conditionId?: string; condition_id?: string };

/** Weekly profit over the last 4 weeks from daily cumulative points (economic + unrealized), newest week last. */
export function weeklyPnl(points: PnlPoint[], now: number): number[] | null {
  const pts = points
    .map((p) => ({ t: Number(p.timestamp) * 1000, v: Number(p.economic_pnl ?? 0) + Number(p.unrealized_pnl ?? 0) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 20) return null;
  const at = (t: number) => {
    let v: number | null = null;
    for (const p of pts) if (p.t <= t) v = p.v;
    return v;
  };
  const out: number[] = [];
  for (let k = 4; k >= 1; k--) {
    const a = at(now - k * 7 * 86400_000);
    const b = at(now - (k - 1) * 7 * 86400_000);
    if (a == null || b == null) return null;
    out.push(b - a);
  }
  return out;
}

/**
 * enrique, 17 Nov 2026 23:10 KST: "they're playing with nothing", "i dont care about someone that has done a few
 * good trades on a 500 dollar wallet", "find plenty of traders, with good track records, possibility to copy them,
 * and balances that are not trivial". The screen had it backwards: it REFUSED wallets whose usual buy was over $100.
 * Now a wallet needs money at stake: $2,000+ made over the 4 weeks, a usual buy of $20 or more (no upper limit: the
 * 5c price check decides whether a copy behind a big buy is still worth taking), and $5,000+ in open positions.
 */
export const MIN_MONTH_USD = 2000;
export const MIN_MED_BUY = 20;
export const MIN_VALUE_USD = 5000;
const tsMs = (r: Act) => (Number(r.timestamp) > 1e12 ? Number(r.timestamp) : Number(r.timestamp) * 1000);
/** Median size in dollars of the wallet's buys of the last 7 days; null when it made none. */
export function medianBuy(acts: Act[], now: number): number | null {
  // per market side, not per fill: a big bettor's order arrives as many small fills (18 Nov 2026: four wallets with
  // $150k-$500k in positions were dropped for a "usual buy" of $9-$19)
  const by = new Map<string, number>();
  for (const r of acts) {
    if (r.type !== "TRADE" || String(r.side ?? "").toUpperCase() !== "BUY" || tsMs(r) < now - 7 * 86400_000) continue;
    const x = Number(r.usdc_size ?? r.usdcSize ?? Number(r.price) * Number(r.size));
    if (!(x > 0)) continue;
    const k = `${r.conditionId ?? r.condition_id ?? r.title ?? ""}|${r.outcome ?? ""}`;
    by.set(k, (by.get(k) ?? 0) + x);
  }
  const usd = [...by.values()].sort((a, b) => a - b);
  return usd.length ? usd[usd.length >> 1] : null;
}
/** Wallets dropped as too small since the size floors began are measured once more: the first measure counted fills, not bets. */
const SMALL_DROP_FROM = Date.UTC(2026, 10, 17, 14);
/** Dollars in open positions out of a data API value answer; null when unreadable. */
export function valueOf(j: unknown): number | null {
  const x = Array.isArray(j) ? j[0] : ((j as { data?: unknown } | null)?.data ?? j);
  const n = Number((Array.isArray(x) ? x[0] : (x as { value?: unknown } | null))?.value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
/** Is a followed wallet too small to keep on paper: known numbers under the floors (unknown is not small). */
export const tooSmall = (z: WalletSize | undefined) => Boolean(z && ((z.valueUsd != null && z.valueUsd < MIN_VALUE_USD) || (z.medBuyUsd != null && z.medBuyUsd < MIN_MED_BUY)));
export type WalletSize = { valueUsd: number | null; medBuyUsd: number | null; at: number; hist?: WalletHist | null };
/**
 * A wallet's whole record from its daily profit curve (enrique, 18 Nov 2026: he asked for the full all-time record
 * beside each wallet). Months are 30-day steps back from now. bestMonthSharePct = the best month's part of all the
 * profit (high = one lucky month); drawdownUsd = the biggest fall from a high. Win rate per bet is not in this data.
 */
export type WalletHist = { allUsd: number; months: number; greenMonths: number; bestMonthSharePct: number | null; drawdownUsd: number; last3mUsd: number };
export function historyOf(points: PnlPoint[], now: number): WalletHist | null {
  const pts = points
    .map((p) => ({ t: Number(p.timestamp) * 1000, v: Number(p.economic_pnl ?? 0) + Number(p.unrealized_pnl ?? 0) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.t <= now)
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const M = 30 * 86400_000;
  const at = (t: number) => {
    let v = 0; // before its first point the wallet had made nothing
    for (const p of pts) if (p.t <= t) v = p.v;
    return v;
  };
  const months = Math.max(1, Math.ceil((now - pts[0].t) / M));
  const per = Array.from({ length: months }, (_, k) => at(now - k * M) - at(now - (k + 1) * M));
  const allUsd = pts[pts.length - 1].v;
  let high = -Infinity;
  let dd = 0;
  for (const p of pts) {
    high = Math.max(high, p.v);
    dd = Math.max(dd, high - p.v);
  }
  return {
    allUsd: Math.round(allUsd),
    months,
    greenMonths: per.filter((x) => x > 0).length,
    bestMonthSharePct: allUsd > 0 ? Math.round((Math.max(...per) / allUsd) * 100) : null,
    drawdownUsd: Math.round(dd),
    last3mUsd: Math.round(per.slice(0, 3).reduce((a, x) => a + x, 0)),
  };
}

/** The 4-week profit rule; null when it passes. One losing week is allowed when it is small. */
export function weeksWhy(weeks: number[] | null): string | null {
  if (!weeks) return "no 4-week profit history";
  const sum = weeks.reduce((a, b) => a + b, 0);
  const down = weeks.filter((w) => !(w > 0));
  if (down.length > 1) return "two or more losing weeks in the last 4";
  if (down.length === 1 && !(sum > 0 && -down[0] <= 0.25 * sum)) return "a losing week over a quarter of the 4 weeks' profit";
  if (Math.max(...weeks) > 0.5 * sum) return "one week made over half the profit";
  if (sum < MIN_MONTH_USD) return `made $${Math.round(sum)} in 4 weeks (needs $${MIN_MONTH_USD})`;
  return null;
}
const betKey = (r: Act) => `${r.conditionId ?? r.condition_id ?? r.title ?? ""}|${r.outcome ?? ""}`;
/** The screen; returns null when the wallet passes, else why not. Pure. */
export function copyScreen(weeks: number[] | null, acts: Act[], now: number): string | null {
  const w = weeksWhy(weeks);
  if (w) return w;
  const allBuys = acts.filter((r) => r.type === "TRADE" && String(r.side ?? "").toUpperCase() === "BUY" && tsMs(r) > 0);
  const buys = allBuys.filter((r) => tsMs(r) >= now - 7 * 86400_000);
  if (buys.length < 14) return `${buys.length} buys in 7 days (needs 14)`;
  const bets = new Set(buys.map(betKey)).size;
  if (bets < MIN_BETS_7D) return `${bets} different bets in 7 days (needs ${MIN_BETS_7D})`;
  // a wallet that buys hundreds of sides a day is a machine quoting markets: copied late at the ask it loses
  const spanDays = Math.max(1 / 24, (now - Math.min(...allBuys.map(tsMs))) / 86400_000);
  const perDay = new Set(allBuys.map(betKey)).size / spanDays;
  if (perDay > MACHINE_PER_DAY) return `buys ${Math.round(perDay)} different sides a day (over ${MACHINE_PER_DAY})`;
  const med = medianBuy(acts, now) ?? 0;
  if (!(med >= MIN_MED_BUY)) return `median buy $${Math.round(med)} (under $${MIN_MED_BUY})`;
  const crypto = buys.filter((r) => /up or down/i.test(String(r.title ?? ""))).length;
  if (crypto > buys.length / 3) return "mostly crypto up/down";
  return null;
}
/** A fail reason without its numbers, for the counts in the status. */
export const failKind = (why: string) => why.replace(/\$?\d[\d,.]*/g, "N").slice(0, 60);

/** Paper result of a rule from the paper trades: settled fillable count, won, net. */
export type PaperTrade = { rule: string; pnl?: number | null; won?: boolean | null; fillable?: boolean };
export function paperResult(trades: PaperTrade[], rule: string) {
  const s = trades.filter((t) => t.rule === rule && t.pnl != null && t.fillable !== false);
  return { n: s.length, won: s.filter((t) => t.won === true).length, net: Math.round(s.reduce((a, t) => a + (t.pnl ?? 0), 0) * 100) / 100 };
}
/** Promotions and drops for the auto wallets. Mutates and returns log lines. Pure apart from the state passed in. */
/** A wallet is on paper at least this long before it can go real, and again after a demotion. */
export const PAPER_MIN_MS = 24 * 3600_000;
export function copyPromote(s: AutoState, trades: PaperTrade[], now: number, real?: (rule: string) => { n: number; net: number }, promote = true): string[] {
  const out: string[] = [];
  for (const w of s.wallets) {
    if (w.stage !== "paper" && w.stage !== "real") continue;
    // the live rules keep the rescan on paper (events.copy.autoReal false; review 63 of 16 Nov 2026: the 7 wallets it
    // promoted lost $36.02 on 23 real bets, all of the real sports and same-day losses): none is promoted, and one
    // that is real goes back to paper. Drops go on as before.
    if (!promote && w.stage === "real") {
      w.stage = "paper";
      w.demotedAt = now;
      out.push(`${w.name} back to PAPER: the rescan's wallets stay on paper (live rules)`);
      continue;
    }
    const r = paperResult(trades, `copy-take-${w.name}`);
    const meets = r.n >= (w.stage === "real" ? KEEP_N : PROMOTE_N) && r.won * 2 >= r.n && r.net > 0;
    // 15 Nov 2026, enrique: "decide what to keep and what to demote and what to promote", recurrently. A real wallet
    // whose paper record (it keeps running beside the real copies) no longer meets the bar goes back to paper, and a
    // wallet waits a day on paper before it can go real (again): hours of luck are not a record.
    if (w.stage === "real") {
      // real outranks paper (enrique, 16 Nov 2026: "real is more important"): a wallet whose own real copies are
      // ahead is not sent back on its paper record; a wallet whose real copies are behind is cut in src/eventlive.ts
      const rr = real?.(`copy-take-${w.name}`);
      if (!meets && !(rr && rr.n > 0 && rr.net > 0)) {
        w.stage = "paper";
        w.demotedAt = now;
        out.push(`${w.name} back to PAPER: paper ${r.won} of ${r.n} won, $${r.net.toFixed(2)}`);
      }
      continue;
    }
    if (promote && meets && now - Math.max(w.addedAt, w.demotedAt ?? 0) >= PAPER_MIN_MS) {
      w.stage = "real";
      w.promotedAt = now;
      out.push(`${w.name} promoted to REAL: paper ${r.won} of ${r.n} won, +$${r.net.toFixed(2)}`);
    } else if (now - w.addedAt >= DROP_DAYS * 86400_000 && r.n >= DROP_N && r.net < 0) {
      w.stage = "dropped";
      w.droppedAt = now;
      out.push(`${w.name} dropped: paper ${r.won} of ${r.n} won, $${r.net.toFixed(2)} after ${DROP_DAYS} days`);
    } else if (now - Math.max(w.addedAt, w.demotedAt ?? 0) >= FAST_DROP_DAYS * 86400_000 && r.n >= PROMOTE_N && r.net <= -FAST_DROP_USD) {
      // it has the number of settled copies the real bar asks for and they lose: it only holds a place
      w.stage = "dropped";
      w.droppedAt = now;
      out.push(`${w.name} dropped: paper ${r.won} of ${r.n} won, $${r.net.toFixed(2)} (${PROMOTE_N}+ settled and behind)`);
    } else if (now - w.addedAt >= IDLE_DAYS * 86400_000 && !w.promotedAt) {
      const made = trades.filter((t) => t.rule === `copy-take-${w.name}` || t.rule === `copy-any-${w.name}`).length;
      if (made < IDLE_N) {
        w.stage = "dropped";
        w.droppedAt = now;
        out.push(`${w.name} dropped: ${made} copies in ${IDLE_DAYS} days (nothing to copy)`);
      }
    }
  }
  return out;
}

const nameFor = (user: string | undefined, address: string, taken: Set<string>) => {
  let n = String(user ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 20);
  if (!n || /^0x/.test(n)) n = `w-${address.slice(2, 8)}`;
  while (taken.has(n)) n = `${n}-${address.slice(2, 4)}`;
  return n;
};

/**
 * The daily scan. `followed` = addresses already followed (static list and auto); `own` = our wallet (left out);
 * `get` = the JSON fetcher. Adds at most ADD_PER_DAY wallets. Never throws.
 */
/** Is a scan due: a day since the last finished one, or the first one of this (wider) version. */
export const SCAN_VER = 6;
export const scanDue = (now = Date.now(), s = autoState()) => s.ver !== SCAN_VER || now - s.lastScan > 24 * 3600_000;
/** Load the file fresh, change it, save it: the scan runs for a long time next to the promotions. */
function commit(f: (s: AutoState) => void) {
  const s = autoState();
  f(s);
  save(s);
}
export async function copyScan(followed: { name: string; address: string }[], own: string, get: <T>(url: string) => Promise<T>, now = Date.now(), wait = pause, seen: { address: string; usd: number }[] = []): Promise<string[]> {
  const out: string[] = [];
  try {
    const s0 = autoState();
    // a scan cut short by a restart goes on where it stopped: failed wallets are remembered, counts are kept
    const fresh = !s0.runStart || now - s0.runStart > 24 * 3600_000;
    if (fresh) commit((s) => void ((s.runStart = now), (s.screened = 0), (s.passed = 0), (s.passedStream = 0), (s.fails = {})));
    // the screen changed: wallets it refused before are read again now, once (not again when a restart resumes the scan)
    if (s0.failedVer !== SCAN_VER) commit((s) => void ((s.failedAt = {}), (s.failedVer = SCAN_VER)));
    const known = new Set([...followed.map((w) => w.address.toLowerCase()), ...s0.wallets.map((w) => w.address.toLowerCase()), own.toLowerCase()]);
    const names = new Set([...followed.map((w) => w.name), ...s0.wallets.map((w) => w.name)]);
    const cands = new Map<string, { user?: string; pnl: number; usd: number; stream?: boolean }>();
    const failedAt: Record<string, number> = s0.failedVer !== SCAN_VER ? {} : { ...(s0.failedAt ?? {}) };
    for (const a of Object.keys(failedAt)) if (now - failedAt[a] > RESCREEN_DAYS * 86400_000) delete failedAt[a];
    for (const per of PERIODS) {
      for (const cat of CATS) {
        let cursor: string | null = null;
        for (let page = 0; page < BOARD_PAGES; page++) {
          const rows: unknown = await get<unknown>(`${DATA}/v2/leaderboard?category=${cat}&time_period=${per}&sort_by=PNL&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`).catch(() => null);
          await wait(300);
          const list = (Array.isArray(rows) ? rows : ((rows as { data?: unknown[] } | null)?.data ?? [])) as { user_id?: string; proxyWallet?: string; user_name?: string; userName?: string; pnl?: number | string }[];
          for (const r of list) {
            const a = String(r.user_id ?? r.proxyWallet ?? "").toLowerCase();
            const pnl = Number(r.pnl);
            if (!/^0x[0-9a-f]{40}$/.test(a) || known.has(a) || failedAt[a] || !(pnl > 0)) continue;
            // month boards come first, so a wallet keeps its month profit for the order below
            if (!cands.has(a)) cands.set(a, { user: r.user_name ?? r.userName, pnl: per === "month" ? pnl : 0, usd: 0 });
          }
          cursor = (rows as { pagination?: { next_cursor?: string } } | null)?.pagination?.next_cursor ?? null;
          if (!cursor || !list.length) break;
        }
      }
    }
    // wallets seen buying on the live trade socket that are on no board read above (src/copyseen.ts)
    let fromStream = 0;
    for (const x of seen) {
      const a = String(x.address).toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a) || known.has(a) || failedAt[a] || cands.has(a)) continue;
      cands.set(a, { pnl: 0, usd: Number(x.usd) || 0, stream: true });
      fromStream += 1;
    }
    // every wallet already followed is measured first (positions and usual buy, 2 calls each), so the status shows
    // what each one has at stake; a rescan wallet still on PAPER that is too small is dropped, which frees its place.
    // Wallets copied with real money are only measured: cutting one is decided on its real record or by enrique.
    const again = s0.wallets.filter((w) => w.stage === "dropped" && (w.droppedAt ?? 0) >= SMALL_DROP_FROM && (s0.sizes?.[w.name]?.valueUsd ?? 0) >= MIN_VALUE_USD && s0.ver !== SCAN_VER);
    for (const w of [...followed, ...autoFollowed(s0), ...again]) {
      await wait(350);
      const value = valueOf(await get<unknown>(`${DATA}/v2/value?user=${w.address}`).catch(() => null));
      await wait(350);
      const got = await get<{ data?: Act[] }>(`${DATA}/v2/activity?user=${w.address}&limit=500`).catch(() => null);
      const med = got ? medianBuy(got.data ?? [], now) : null;
      if (value == null && !got) continue;
      await wait(350);
      const all = await get<{ data?: { points?: PnlPoint[] } }>(`${DATA}/v2/user-pnl?user=${w.address}&interval=all&fidelity=1d`).catch(() => null);
      const hist = all ? historyOf(all?.data?.points ?? [], now) : (s0.sizes?.[w.name]?.hist ?? null);
      const size: WalletSize = { valueUsd: value == null ? null : Math.round(value), medBuyUsd: med == null ? null : Math.round(med), at: Date.now(), hist };
      commit((s) => {
        s.sizes = { ...(s.sizes ?? {}), [w.name]: size };
        const back = again.some((y) => y.address === w.address) ? s.wallets.find((x) => x.address === w.address && x.stage === "dropped") : undefined;
        if (back && !tooSmall(size)) {
          back.stage = "paper";
          back.droppedAt = undefined;
          const text = `${back.name} back on paper copy: $${size.valueUsd ?? "?"} in positions, usual bet $${size.medBuyUsd ?? "?"}`;
          s.log.push({ t: Date.now(), text });
          s.log = s.log.slice(-60);
          out.push(text);
        }
        const a = s.wallets.find((x) => x.address === w.address && x.stage === "paper");
        if (a && tooSmall(size)) {
          a.stage = "dropped";
          a.droppedAt = Date.now();
          const text = `${a.name} dropped: too small ($${size.valueUsd ?? "?"} in positions, usual buy $${size.medBuyUsd ?? "?"})`;
          s.log.push({ t: Date.now(), text });
          s.log = s.log.slice(-60);
          out.push(text);
        }
      });
    }
    const day = 86400_000;
    const addedToday = s0.wallets.filter((w) => now - w.addedAt < day).length;
    let room = Math.max(0, Math.min(ADD_PER_DAY - addedToday, MAX_ACTIVE - autoFollowed().length));
    let screened = 0;
    let passed = 0;
    let passedStream = 0;
    let unsaved = 0;
    let fails: Record<string, number> = {};
    const fail = (address: string, why: string) => {
      failedAt[address] = now;
      const k = failKind(why);
      fails[k] = (fails[k] ?? 0) + 1;
    };
    const flush = () => {
      commit((s) => {
        s.failedAt = { ...failedAt };
        s.candidates = cands.size;
        s.fromStream = fromStream;
        s.screened += screened;
        s.passed += passed;
        s.passedStream = (s.passedStream ?? 0) + passedStream;
        const f = { ...(s.fails ?? {}) };
        for (const [k, n] of Object.entries(fails)) f[k] = (f[k] ?? 0) + n;
        s.fails = f;
      });
      screened = 0;
      passed = 0;
      passedStream = 0;
      fails = {};
      unsaved = 0;
    };
    // biggest month profit first, then the socket's wallets by dollars bought, then the other boards; at most
    // SCREEN_PER_DAY wallets read a day (1-2 calls each, paced)
    for (const [address, c] of [...cands].sort((a, b) => b[1].pnl - a[1].pnl || b[1].usd - a[1].usd).slice(0, SCREEN_PER_DAY)) {
      if (room <= 0) break;
      screened += 1;
      if (++unsaved >= 40) flush();
      await wait(350);
      const pnl = await get<{ data?: { points?: PnlPoint[] } }>(`${DATA}/v2/user-pnl?user=${address}&interval=1m&fidelity=1d`).catch(() => null);
      if (!pnl) continue; // not read: tried again next time
      const weeks = weeklyPnl(pnl?.data?.points ?? [], now);
      const weeksNo = weeksWhy(weeks);
      if (weeksNo) {
        fail(address, weeksNo);
        continue;
      }
      await wait(350);
      const got = await get<{ data?: Act[] }>(`${DATA}/v2/activity?user=${address}&limit=500`).catch(() => null);
      if (!got) continue;
      const why = copyScreen(weeks, got.data ?? [], now);
      if (why) {
        fail(address, why);
        continue;
      }
      await wait(350);
      const value = valueOf(await get<unknown>(`${DATA}/v2/value?user=${address}`).catch(() => null));
      if (value == null) continue; // not read: tried again next time
      if (value < MIN_VALUE_USD) {
        fail(address, `under $${MIN_VALUE_USD} in open positions`);
        continue;
      }
      const med = medianBuy(got.data ?? [], now);
      await wait(350);
      const all = await get<{ data?: { points?: PnlPoint[] } }>(`${DATA}/v2/user-pnl?user=${address}&interval=all&fidelity=1d`).catch(() => null);
      const hist = all ? historyOf(all?.data?.points ?? [], now) : null;
      passed += 1;
      if (c.stream) passedStream += 1;
      const name = nameFor(c.user, address, names);
      names.add(name);
      const text = `${name} added to paper copy (weeks ${weeks!.map((w) => `$${Math.round(w)}`).join(", ")}${c.stream ? "; found on the live trade feed" : ""})`;
      const t = Date.now();
      commit((s) => {
        s.wallets.push({ name, address, addedAt: t, stage: "paper", why: `weeks ${weeks!.map((w) => Math.round(w)).join("/")}, month +$${Math.round(c.pnl)}, usual buy $${Math.round(med ?? 0)}, $${Math.round(value)} in positions` });
        s.sizes = { ...(s.sizes ?? {}), [name]: { valueUsd: Math.round(value), medBuyUsd: med == null ? null : Math.round(med), at: t, hist } };
        s.log.push({ t, text });
        s.log = s.log.slice(-60);
      });
      out.push(text);
      room -= 1;
    }
    flush();
    commit((s) => void ((s.lastScan = Date.now()), (s.scans += 1), (s.runStart = 0), (s.ver = SCAN_VER), (s.lastError = null)));
  } catch (e) {
    commit((s) => void (s.lastError = (e as Error).message.slice(0, 120)));
  }
  return out;
}

/** Public status: stages and paper results, no secrets (the addresses are other people's public wallets). */
export function autoSummary(trades: PaperTrade[]) {
  const s = autoState();
  return {
    lastScan: s.lastScan || null,
    running: Boolean(s.runStart),
    scans: s.scans,
    candidates: s.candidates ?? null,
    fromStream: s.fromStream ?? null,
    screened: s.screened,
    passed: s.passed,
    passedStream: s.passedStream ?? null,
    // why the wallets read in this scan were refused, by reason
    fails: s.fails ?? {},
    lastError: s.lastError,
    // what every followed wallet has at stake (hand-picked and rescan wallets, by name), read at the daily scan
    sizes: s.sizes ?? {},
    floors: { monthUsd: MIN_MONTH_USD, usualBuyUsd: MIN_MED_BUY, positionsUsd: MIN_VALUE_USD },
    bar: `added: up in its last 4 weeks (one losing week of at most a quarter of the profit allowed, no week over half) and $${MIN_MONTH_USD}+ made in them, 14+ buys and ${MIN_BETS_7D}+ different bets in 7 days, at most ${MACHINE_PER_DAY} sides a day, usual buy $${MIN_MED_BUY}+ (no upper limit), $${MIN_VALUE_USD}+ in open positions, under a third crypto up/down; a paper wallet under the size floors is dropped; ${ADD_PER_DAY} a day at most, ${MAX_ACTIVE} followed at most. REAL when paper copy-take has ${PROMOTE_N}+ settled, half won, net > 0, after a day on paper; back to paper when that no longer holds. Dropped after ${DROP_DAYS} days with ${DROP_N}+ settled and behind, after ${FAST_DROP_DAYS} days with ${PROMOTE_N}+ settled and $${FAST_DROP_USD}+ behind, or after ${IDLE_DAYS} days with under ${IDLE_N} copies.`,
    wallets: s.wallets.map((w) => ({ name: w.name, stage: w.stage, addedAt: w.addedAt, promotedAt: w.promotedAt ?? null, demotedAt: w.demotedAt ?? null, paper: paperResult(trades, `copy-take-${w.name}`) })),
    log: s.log.slice(-30).reverse(),
  };
}
