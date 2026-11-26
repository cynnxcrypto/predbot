/**
 * Truth check (16 Nov 2026, enrique: "i have to know if the values are correct"). Every 30 minutes, and 4 minutes after
 * a start, the dashboard's headline figures are compared with sources that do not come from the bot's own books:
 *
 *   Polymarket cash          the three collaterals' balanceOf on Polygon
 *   Polymarket open bets     Polymarket's data API: the wallet's positions not yet redeemable, at their currentValue
 *   won, waiting for claim   the same API: redeemable positions (a lost one is worth 0)
 *   each Solana wallet       SOL, and every token account of both token programs, each coin valued by a Jupiter sale
 *                            quote (USDC and USDT at $1); an open perp is taken from the perps module's own chain read
 *   money in and out         each Solana wallet's transfers from and to wallets that are not ours (Helius, 8 days),
 *                            against the deposits and withdrawals the worth chart takes out of its windows
 *   Polymarket all time      Polymarket's own profit figure for the wallet, where its public endpoint answers
 *   day by day               each Korean day's closed real trades and net per line, as the dashboard serves them,
 *                            against a recount from the raw trade files (16 Nov 2026)
 *
 * Read-only: it sends nothing. Absolute figures (balances, deposits) stay on this machine in data/truth.json and in the
 * password-protected page; the public status gets only the differences (dashboard minus source), which give no
 * balance away, and counts. TRUTHCHECK=off disables it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./config.js";
import { loadJson, saveJson } from "./store.js";
import { savePmRedeemable, waitingKinds, wonRows } from "./pmredeem.js";

const POLY_RPC = "https://polygon-bor-rpc.publicnode.com";
/** Polymarket's collaterals, as src/live.ts reads them (pUSD, USDC.e, USDC). */
const COLLATERALS: Record<string, string> = { pUSD: "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb", "USDC.e": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" };
const DATA_API = "https://data-api.polymarket.com";
const SOL = "So11111111111111111111111111111111111111112";
const USD_MINTS = new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const r2 = (x: number) => Math.round(x * 100) / 100;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** What the dashboard shows, as src/worthdash.ts last worked it out. */
export type DashFigures = { at: number; total: number | null; cash: number | null; claim: number; bets: number; betsN: number; betsPos?: number; solBal: number | null; coinsSol: number; coinsN: number; solUsd: number | null; rulesUsd: number | null; perpsUsd: number | null; perpsPos: number; hlUsd?: number | null };
/** One compared figure: dash = the dashboard, src = the source; diff = dash - src. */
export type Item = { k: string; dash: number | null; src: number | null; diff: number | null; ok: boolean | null; why?: string };
export type Coin = { mint: string; amount: string; sol: number | null; tracked: boolean };
export type Transfer = { t: number; wallet: string; usd: number; sig: string };

/** Within a dollar, or 1.5% of the source for a figure that moves with live prices: the two are read seconds apart. */
export function compare(k: string, dash: number | null, src: number | null, tolUsd = 1, tolPct = 0.015, why?: string): Item {
  if (dash == null || src == null || !Number.isFinite(dash) || !Number.isFinite(src)) return { k, dash, src, diff: null, ok: null, why: why ?? "not read" };
  const diff = r2(dash - src);
  return { k, dash: r2(dash), src: r2(src), diff, ok: Math.abs(diff) <= Math.max(tolUsd, Math.abs(src) * tolPct), ...(why ? { why } : {}) };
}

/** Polymarket's positions for the wallet: open ones (not redeemable) and redeemable ones, at Polymarket's currentValue. */
export function splitPositions(rows: { size?: number | string; current_size?: number | string; currentValue?: number | string; current_value?: number | string; curPrice?: number | string; redeemable?: boolean }[]) {
  let open = 0;
  let openN = 0;
  let won = 0;
  let wonN = 0;
  let lostN = 0;
  for (const p of rows) {
    const size = Number(p.size ?? p.current_size); // v2 names it current_size (17 Nov 2026)
    const v = Number(p.current_value ?? p.currentValue);
    if (!(size > 1e-6) || !Number.isFinite(v)) continue;
    if (p.redeemable) {
      if (v > 0.005) {
        won += v;
        wonN++;
      } else lostN++;
    } else {
      open += v;
      openN++;
    }
  }
  return { open: r2(open), openN, won: r2(won), wonN, lostN };
}

type HeliusTx = { signature?: string; timestamp?: number; nativeTransfers?: { fromUserAccount?: string; toUserAccount?: string; amount?: number }[]; tokenTransfers?: { fromUserAccount?: string; toUserAccount?: string; mint?: string; tokenAmount?: number }[] };
/** What an account on the other side of a transfer is: a plain wallet, a token account, a program's account, or closed. */
export type AccountKind = "wallet" | "token" | "program" | "gone";

/** Every account on the other side of a SOL or USD-coin transfer of `wallet`, for classifyAccounts. */
export function counterparts(txs: HeliusTx[], wallet: string): string[] {
  const out = new Set<string>();
  for (const tx of txs) {
    for (const n of tx.nativeTransfers ?? []) {
      if (n.toUserAccount === wallet && n.fromUserAccount) out.add(n.fromUserAccount);
      if (n.fromUserAccount === wallet && n.toUserAccount) out.add(n.toUserAccount);
    }
    for (const n of tx.tokenTransfers ?? []) {
      if (!n.mint || !USD_MINTS.has(n.mint)) continue;
      if (n.toUserAccount === wallet && n.fromUserAccount) out.add(n.fromUserAccount);
      if (n.fromUserAccount === wallet && n.toUserAccount) out.add(n.toUserAccount);
    }
  }
  return [...out];
}

/**
 * Money that came into or left one of our Solana wallets from a wallet that is not ours, from Helius's parsed
 * transfers. Transfers between our own wallets (a gas top-up) are left out, so are swaps (not transfers). With `kinds`
 * (16 Nov 2026: the first run counted 30 transfers the chart did not have), only a plain wallet on the other side
 * counts: a token account (rent and wrapped SOL of our own coin accounts), a program's account (perps collateral,
 * swaps) or a closed account (a coin account closed for its rent) is trading or upkeep, not money put in or taken out.
 * usd = SOL at px plus USDC/USDT; + = in.
 */
export function externalTransfers(txs: HeliusTx[], wallet: string, ours: Set<string>, px: number, label: string, kinds?: Map<string, AccountKind>): Transfer[] {
  const out: Transfer[] = [];
  const ext = (a: string | undefined) => !!a && !ours.has(a) && (!kinds || kinds.get(a) === "wallet");
  for (const tx of txs) {
    let usd = 0;
    for (const n of tx.nativeTransfers ?? []) {
      const sol = Number(n.amount) / 1e9;
      if (!(sol > 0)) continue;
      if (n.toUserAccount === wallet && ext(n.fromUserAccount)) usd += sol * px;
      if (n.fromUserAccount === wallet && ext(n.toUserAccount)) usd -= sol * px;
    }
    for (const n of tx.tokenTransfers ?? []) {
      if (!n.mint || !USD_MINTS.has(n.mint)) continue;
      const a = Number(n.tokenAmount);
      if (!(a > 0)) continue;
      if (n.toUserAccount === wallet && ext(n.fromUserAccount)) usd += a;
      if (n.fromUserAccount === wallet && ext(n.toUserAccount)) usd -= a;
    }
    // network fees and the small change of a swap are not money put in or taken out
    if (Math.abs(usd) >= 1) out.push({ t: (Number(tx.timestamp) || 0) * 1000, wallet: label, usd: r2(usd), sig: String(tx.signature ?? "") });
  }
  return out;
}

/**
 * Each chain transfer against the flows the worth chart took out of its windows: a flow of the same wallet within 30
 * minutes and within $3 or 12% is a match (the chain's SOL is valued at today's price, the chart's at that day's).
 */
export function matchFlows(chain: Transfer[], flows: [number, number, string][]) {
  const used = new Set<number>();
  const matched: Transfer[] = [];
  const missing: Transfer[] = [];
  for (const c of chain) {
    const i = flows.findIndex((f, j) => !used.has(j) && f[2] === c.wallet && Math.abs(f[0] - c.t) <= 30 * 60_000 && Math.abs(f[1] - c.usd) <= Math.max(3, Math.abs(c.usd) * 0.12));
    if (i >= 0) {
      used.add(i);
      matched.push(c);
    } else missing.push(c);
  }
  // a flow the chart took out with no transfer behind it: a result booked as money in or out
  const extra = flows.filter((f, j) => !used.has(j) && f[2] !== "Polymarket");
  return { matched, missing, extra };
}

/**
 * For a window from `from` to now: the Solana money in and out the chart took out, minus what the chain shows. 0 = the
 * window's worth change is right as far as deposits go; +$X = the chart took out $X too much (the change reads $X too
 * high), -$X = too little.
 */
/**
 * MONEY ENRIQUE CONFIRMED (17 Nov 2026, coordinator: "flag any flow that isn't on a list of deposits enrique confirmed";
 * his only Solana-wallet deposits were about $100-101 each, on 15 Nov 2026 KST). Any other money the worth chart takes
 * out of the Solana wallets' windows is flagged: it is either a deposit we were not told of or a trade booked as one.
 */
export const CONFIRMED_SOLANA_FLOWS: { day: string; minUsd: number; maxUsd: number }[] = [{ day: "2026-11-15", minUsd: 90, maxUsd: 112 }];
export function unconfirmedFlows(flows: [number, number, string][]): [number, number, string][] {
  const day = (t: number) => new Date(t + 9 * 3_600_000).toISOString().slice(0, 10);
  return flows.filter((f) => f[2] !== "Polymarket" && !CONFIRMED_SOLANA_FLOWS.some((c) => c.day === day(f[0]) && f[1] >= c.minUsd && f[1] <= c.maxUsd));
}
export function windowFlowDiff(chain: Transfer[], flows: [number, number, string][], from: number): number {
  const ch = chain.filter((c) => c.t >= from).reduce((a, c) => a + c.usd, 0);
  const fl = flows.filter((f) => f[0] >= from && f[2] !== "Polymarket").reduce((a, f) => a + f[1], 0);
  return r2(fl - ch);
}

// ---- day by day (16 Nov 2026) -----------------------------------------------------------------------------------------
// The owner found the overview's "profit and loss by day" wrong right after this check was called done: closed counts
// piling up across days and day lines that did not add up. The check now also recounts each Korean day's closed real
// trades from the raw trade files and compares them with what the dashboard serves for that day, line by line.

/** The Korean day (UTC+9) of a time in ms; "" when there is no time. */
export const kstDay = (ms: number) => (Number.isFinite(ms) ? new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10) : "");
/** One line of one day: closed trades, how many won, and the net (USD, or SOL for the two Solana spot wallets). */
export type DayCell = { n: number; won: number; net: number };
export type DayTable = Record<string, Record<string, DayCell>>;
/** The day lines whose net is in SOL (the dashboard turns them into dollars at today's SOL price, both sides alike). */
const SOL_TYPES = new Set(["spot copy", "spot rules"]);

/** The raw rows, as the trading code writes them. Polymarket: data/eventlive.json. Solana: rows of
 *  solana-slowlive.json (t = when the copy was seen, heldMin from the buy), solana-bucketslive.json and
 *  solana-perpslive.json (t = when the trade was closed). */
export type EvRaw = { t: number; group?: string; shares?: number; pnl?: number | null; settledAt?: number | null };
export type SlowRaw = { t: number; buy?: string; heldMin?: number | null; netSol?: number };
export type RuleRaw = { t: number; buy?: string; heldMin?: number | null; netSol?: number };
export type PerpRaw = { t: number; filled?: boolean; netUsd?: number };
export type RawTrades = { events: EvRaw[]; slow: SlowRaw[]; rules: RuleRaw[]; perps: PerpRaw[] };
/** What the dashboard serves for its day panel: /api/events?sec=copy and ?sec=tennis realRec.days, /api/solslow days,
 *  and the spot rules' and perps' rows of the status (null = that part could not be read). */
export type ServedDays = {
  copy: { day: string; settled: number; won: number; net: number }[] | null;
  tennis: { day: string; settled: number; won: number; net: number }[] | null;
  slow: { day: string; n: number; won: number; netSol: number }[] | null;
  ruleRows: { t: number; buy?: string; heldMin?: number | null; netSol?: number | null }[] | null;
  perpRows: { t: number; filled?: boolean; netUsd?: number | null }[] | null;
  ruleDays?: { day: string; n: number; won: number; net: number }[] | null;
  perpDays?: { day: string; n: number; won: number; net: number }[] | null;
};

/** Adds a whole served day line (n trades, won of them, net). */
const addDay = (tab: DayTable, day: string, type: string, n: number, won: number, net: number) => {
  if (!day) return;
  const c = ((tab[day] ??= {})[type] ??= { n: 0, won: 0, net: 0 });
  c.n += n;
  c.won += won;
  c.net += net;
};
/** Adds one trade. */
const addCell = (tab: DayTable, day: string, type: string, net: number, won: boolean) => addDay(tab, day, type, 1, won ? 1 : 0, net);

/** A net with no trade in it: the fees of a buy that never landed, as the books and the dashboard count them (16 Nov 2026). */
function addFee(t: DayTable, day: string, type: string, net: number) {
  if (net) addDay(t, day, type, 0, 0, net);
}
/**
 * Each Korean day's closed real trades, counted again from the raw rows by this file's own rules: a Polymarket bet is
 * closed when it was filled (shares > 0) and has a result, on the day it settled; tennis's resting bids (group
 * tennisrest) count with tennis, as the tennis tab shows them; a spot copy is closed when its buy landed, on the day it
 * was sold (seen + minutes held); a spot rule trade when its buy landed and a perp when it filled, on the day the row was
 * written. `all` counts every row that closed on a day whatever its kind (unfilled, not landed): no day can show more.
 */
export function recountDays(raw: RawTrades): { cells: DayTable; all: DayTable; groups: DayTable } {
  const cells: DayTable = {};
  const all: DayTable = {};
  const groups: DayTable = {};
  for (const r of raw.events) {
    if (r?.pnl == null || !Number.isFinite(Number(r.pnl))) continue;
    const day = kstDay(Number(r.settledAt ?? r.t));
    const g = String(r.group ?? "unknown");
    const type = g === "tennisrest" ? "tennis" : g;
    addCell(all, day, type, 0, false);
    if (!(Number(r.shares) > 0)) continue;
    addCell(cells, day, type, Number(r.pnl), Number(r.pnl) > 0);
    addCell(groups, day, g, Number(r.pnl), Number(r.pnl) > 0);
  }
  for (const r of raw.slow) {
    const day = kstDay(Number(r?.t) + (Number(r?.heldMin) || 0) * 60_000);
    addCell(all, day, "spot copy", 0, false);
    if (r.buy === "landed") addCell(cells, day, "spot copy", Number(r.netSol) || 0, (Number(r.netSol) || 0) > 0);
    else addFee(cells, day, "spot copy", Number(r.netSol) || 0);
  }
  for (const r of raw.rules) {
    if ((r as { rule?: string }).rule === "test-once") continue;
    const day = kstDay(Number(r?.t));
    addCell(all, day, "spot rules", 0, false);
    if (r.buy === "landed") addCell(cells, day, "spot rules", Number(r.netSol) || 0, (Number(r.netSol) || 0) > 0);
    else addFee(cells, day, "spot rules", Number(r.netSol) || 0);
  }
  for (const r of raw.perps) {
    if ((r as { rule?: string }).rule === "test-once") continue;
    const day = kstDay(Number(r?.t));
    addCell(all, day, "perps", 0, false);
    if (r.filled !== false) addCell(cells, day, "perps", Number(r.netUsd) || 0, (Number(r.netUsd) || 0) > 0);
    else addFee(cells, day, "perps", Number(r.netUsd) || 0);
  }
  return { cells, all, groups };
}

/**
 * The overview's day lines as the page builds them from what the server serves (status.ts, the h-days panel): copy and
 * tennis from realRec.days, spot copy from /api/solslow's days, spot rules from the status rows (landed, with minutes
 * held, on the day of t + minutes held), perps from the status rows (filled, on the day of t). This mirrors the page's
 * script: when that script changes, change this with it. Types it cannot read are listed in notRead.
 */
export function servedDayCells(s: ServedDays): { cells: DayTable; notRead: string[] } {
  const cells: DayTable = {};
  const notRead: string[] = [];
  for (const [type, rows] of [["copy", s.copy], ["tennis", s.tennis]] as const) {
    if (!rows) notRead.push(type);
    else for (const d of rows) if (d && Number(d.settled)) addDay(cells, d.day, type, Number(d.settled), Number(d.won) || 0, Number(d.net) || 0);
  }
  if (!s.slow) notRead.push("spot copy");
  else for (const d of s.slow) if (d && Number(d.n)) addDay(cells, d.day, "spot copy", Number(d.n), Number(d.won) || 0, Number(d.netSol) || 0);
  if (s.ruleDays) for (const d of s.ruleDays) addDay(cells, d.day, "spot rules", Number(d.n) || 0, Number(d.won) || 0, Number(d.net) || 0);
  else if (!s.ruleRows) notRead.push("spot rules");
  else for (const x of s.ruleRows) if (x?.buy === "landed" && x.heldMin != null && x.netSol != null) addCell(cells, kstDay(Number(x.t) + (Number(x.heldMin) || 0) * 60_000), "spot rules", Number(x.netSol) || 0, Number(x.netSol) > 0);
  if (s.perpDays) for (const d of s.perpDays) addDay(cells, d.day, "perps", Number(d.n) || 0, Number(d.won) || 0, Number(d.net) || 0);
  else if (!s.perpRows) notRead.push("perps");
  else for (const x of s.perpRows) if (x?.filled !== false && x?.netUsd != null) addCell(cells, kstDay(Number(x.t)), "perps", Number(x.netUsd) || 0, Number(x.netUsd) > 0);
  return { cells, notRead };
}

export type DayRow = { day: string; type: string; served: DayCell; recount: DayCell; closedThatDay: number; countDiff: number; netDiff: number | null; ok: boolean; cumulative: boolean };
/**
 * The last `n` Korean days up to `now`, every line either side has: count difference and net difference (served minus
 * recount; dollars, SOL lines at `solUsd`). ok when the counts are equal and the nets within $0.02. cumulative when a
 * line shows more closed trades than rows of any kind closed that day: a running total, not that day's.
 */
export function compareDays(served: ReturnType<typeof servedDayCells>, rec: ReturnType<typeof recountDays>, now: number, solUsd: number | null, n = 8): { days: string[]; rows: DayRow[]; notRead: string[] } {
  const days = Array.from({ length: n }, (_, i) => kstDay(now - i * 86_400_000));
  const rows: DayRow[] = [];
  const z: DayCell = { n: 0, won: 0, net: 0 };
  for (const day of days) {
    const types = new Set([...Object.keys(served.cells[day] ?? {}), ...Object.keys(rec.cells[day] ?? {})].filter((t) => !served.notRead.includes(t)));
    for (const type of [...types].sort()) {
      const sv = served.cells[day]?.[type] ?? z;
      const rc = rec.cells[day]?.[type] ?? z;
      const sol = SOL_TYPES.has(type);
      const dNet = sv.net - rc.net;
      const netDiff = sol ? (solUsd != null ? r2(dNet * solUsd) : null) : r2(dNet);
      const netOk = netDiff != null ? Math.abs(netDiff) <= 0.02 : Math.abs(dNet) <= 0.0002;
      const closedThatDay = rec.all[day]?.[type]?.n ?? 0;
      const round = (c: DayCell): DayCell => ({ n: c.n, won: c.won, net: sol ? r6(c.net) : r2(c.net) });
      rows.push({ day, type, served: round(sv), recount: round(rc), closedThatDay, countDiff: sv.n - rc.n, netDiff, ok: sv.n === rc.n && netOk, cumulative: sv.n > closedThatDay });
    }
  }
  return { days, rows, notRead: served.notRead };
}

const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
/** The raw trade files on this machine (data dir), read only. */
export function readRawTrades(): RawTrades {
  return {
    events: arr<EvRaw>(loadJson<unknown>("eventlive.json", [])),
    slow: arr<SlowRaw>(loadJson<{ rows?: unknown }>("solana-slowlive.json", {})?.rows),
    rules: arr<RuleRaw>(loadJson<{ rows?: unknown }>("solana-bucketslive.json", {})?.rows),
    perps: arr<PerpRaw>(loadJson<{ rows?: unknown }>("solana-perpslive.json", {})?.rows),
  };
}

// ---- reads (the server) ------------------------------------------------------------------------------------------------
type Deps = {
  dash: () => DashFigures | null;
  flows: () => [number, number, string][];
  allTime: () => number | null;
  /** When that all-time figure was read (ms); it is kept with this time, not with the check's. */
  allTimeAt?: () => number | null;
  rpcUrl: () => string;
  helius: () => string;
  quote: (mint: string, out: string, amount: string, bps: number) => Promise<{ outAmount?: string }>;
  tracked: () => { spot: Set<string>; rules: Set<string> };
  fetch: typeof fetch;
  /** what the dashboard serves for its day by day, from the same server functions (16 Nov 2026); left out = not checked */
  dayServed?: () => ServedDays;
  /** Hyperliquid: our two wallets' addresses (null when not set up) and the positions our books hold open (20 Nov 2026) */
  hl?: () => { addrs: (string | null)[]; opens: { coin: string; wallet: 1 | 2 | 3 }[] };
};
let deps: Deps | null = null;
let last: { at: number; items: Item[]; extra: Record<string, unknown> } | null = null;

const addrFile = (f: string) => {
  try {
    const p = join(DATA, f);
    const a = existsSync(p) ? readFileSync(p, "utf8").trim() : "";
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) ? a : "";
  } catch {
    return "";
  }
};

async function getJson(url: string, init?: RequestInit, ms = 15_000): Promise<unknown> {
  const res = await deps!.fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}
async function solRpc<T>(method: string, params: unknown[]): Promise<T> {
  const j = (await getJson(deps!.rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })) as { result?: T; error?: unknown };
  if (j.error || j.result === undefined) throw new Error(`rpc ${method}: error`);
  return j.result;
}
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
let dataWaits = [3_000, 10_000, 30_000];
/** Polymarket's data API answers 429 when asked too often (16 Nov 2026 19:19 KST the positions read was refused that
 *  way): wait and ask again, three times. Any other refusal is final. */
async function getDataApi(url: string): Promise<unknown> {
  for (let i = 0; ; i++) {
    try {
      return await getJson(url);
    } catch (e) {
      if (i >= dataWaits.length || !/http (429|5\d\d)/.test((e as Error).message)) throw e;
      await sleep(dataWaits[i]);
    }
  }
}
/** One point of Polymarket's profit and loss series (data API v2 user-pnl); amounts cumulative, null = unavailable. */
type PnlPoint = { timestamp?: number; economic_pnl?: number | null; position_pnl?: number | null; wallet_income?: number | null; unrealized_pnl?: number | null; fees?: number | null };
const fin = (x: unknown): number | null => (x != null && Number.isFinite(Number(x)) ? Number(x) : null);
/** Polymarket's all-in figure. Its docs: economic_pnl = position_pnl + wallet_income, position_pnl = realised +
 *  unrealized_pnl, so the open bets at Polymarket's marks are already inside it (until 16 Nov 2026 19:45 KST this check
 *  added unrealized_pnl a second time). */
export function pnlOf(p: PnlPoint): number | null {
  const e = fin(p.economic_pnl);
  if (e != null) return e;
  const pos = fin(p.position_pnl);
  const inc = fin(p.wallet_income);
  return pos != null && inc != null ? pos + inc : null;
}
/** Our "Polymarket all time" as each run saw it, so that a Polymarket point from hours ago is compared with ours from
 *  the same time, not with ours now. Three days kept, in data/truth-alltime-v2.json. */
const SAMPLES = "truth-alltime-v2.json"; // v2 (20 Nov 2026): v1 samples were stamped with the check time, not the read time

/** A Solana wallet as the chain has it: SOL, USD coins, and every other coin at a Jupiter sale quote (in SOL). */
async function solWallet(address: string, tracked: Set<string>) {
  const lamports = (await solRpc<{ value: number }>("getBalance", [address])).value;
  type Acc = { account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; uiAmount: number | null } } } } } };
  const coins: Coin[] = [];
  let usd = 0;
  let wsol = 0;
  for (const programId of TOKEN_PROGRAMS) {
    const r = await solRpc<{ value: Acc[] }>("getTokenAccountsByOwner", [address, { programId }, { encoding: "jsonParsed" }]);
    for (const a of r.value) {
      const info = a.account.data.parsed.info;
      if (info.tokenAmount.amount === "0") continue;
      if (USD_MINTS.has(info.mint)) usd += Number(info.tokenAmount.uiAmount) || 0;
      else if (info.mint === SOL) wsol += Number(info.tokenAmount.amount) / 1e9;
      else coins.push({ mint: info.mint, amount: info.tokenAmount.amount, sol: null, tracked: tracked.has(info.mint) });
    }
  }
  let noRoute = 0;
  let unpriced = 0;
  for (const c of coins) {
    try {
      const q = await deps!.quote(c.mint, SOL, c.amount, 300);
      c.sol = q.outAmount ? Number(q.outAmount) / 1e9 : 0;
    } catch (e) {
      if (/^jupiter \S+ http 4(?!29|01|03|08)\d\d\b/.test(String((e as Error)?.message ?? e))) {
        c.sol = 0;
        noRoute++;
      } else unpriced++;
    }
    await sleep(400); // one at a time: the real copy buys with the same key
  }
  const coinsSol = coins.reduce((a, c) => a + (c.sol ?? 0), 0);
  return { sol: lamports / 1e9 + wsol, usd, coins, coinsSol, noRoute, unpriced };
}

/** What each account is, from its owner program (getMultipleAccounts, 100 at a time). A read that fails leaves it out. */
async function classifyAccounts(addrs: string[]): Promise<Map<string, AccountKind>> {
  const out = new Map<string, AccountKind>();
  for (let i = 0; i < addrs.length; i += 100) {
    const part = addrs.slice(i, i + 100);
    const r = await solRpc<{ value: ({ owner?: string } | null)[] }>("getMultipleAccounts", [part, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
    part.forEach((a, j) => {
      const acc = r.value[j];
      out.set(a, !acc ? "gone" : acc.owner === SYSTEM_PROGRAM ? "wallet" : TOKEN_PROGRAMS.includes(String(acc.owner)) ? "token" : "program");
    });
  }
  return out;
}

async function heliusTransfers(address: string, sinceMs: number): Promise<Parameters<typeof externalTransfers>[0]> {
  const key = deps!.helius();
  if (!key) throw new Error("no helius key");
  const all: Parameters<typeof externalTransfers>[0] = [];
  let before = "";
  for (let page = 0; page < 6; page++) {
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${key}&type=TRANSFER&limit=100${before ? `&before=${before}` : ""}`;
    const rows = (await getJson(url)) as Parameters<typeof externalTransfers>[0];
    if (!Array.isArray(rows) || !rows.length) break;
    all.push(...rows);
    const oldest = rows[rows.length - 1];
    if ((Number(oldest.timestamp) || 0) * 1000 < sinceMs || rows.length < 100) break;
    before = String(oldest.signature ?? "");
    await sleep(300);
  }
  return all.filter((x) => (Number(x.timestamp) || 0) * 1000 >= sinceMs);
}

/** One full check. Never throws: a part that cannot be read is reported as not read. */
export async function truthRun(now = Date.now()): Promise<typeof last> {
  if (!deps) return null;
  const d = deps.dash();
  const px = d?.solUsd ?? null;
  const items: Item[] = [];
  const extra: Record<string, unknown> = {};
  const errors: string[] = [];
  // Polymarket
  const funder = String(loadJson<{ funder?: string }>("live.json", {}).funder ?? "").trim();
  let pmCash: number | null = null;
  let pos: ReturnType<typeof splitPositions> | null = null;
  if (/^0x[0-9a-fA-F]{40}$/.test(funder)) {
    try {
      let sum = 0;
      for (const token of Object.values(COLLATERALS)) {
        const j = (await getJson(POLY_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data: `0x70a08231${funder.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"] }) })) as { result?: string };
        if (typeof j.result !== "string") throw new Error("polygon balance not read");
        sum += Number(BigInt(j.result)) / 1e6;
      }
      pmCash = sum;
    } catch (e) {
      errors.push(`polygon: ${(e as Error).message}`);
    }
    // the data API's v2 (its v1 answers 410 since 2 Nov 2026): rows in `data`, pages by pagination.next_cursor
    try {
      const rows: Parameters<typeof splitPositions>[0] = [];
      let cursor = "";
      for (let page = 0; page < 15; page++) {
        if (page) await sleep(500);
        const j = (await getDataApi(`${DATA_API}/v2/positions?user=${funder}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)) as { data?: Parameters<typeof splitPositions>[0]; pagination?: { next_cursor?: string | null } };
        if (!Array.isArray(j?.data)) throw new Error("positions not a list");
        rows.push(...j.data);
        cursor = j.pagination?.next_cursor ?? "";
        if (!cursor || !j.data.length) break;
      }
      pos = splitPositions(rows);
      // Polymarket's redeemable wins, for the worth and the claimer (src/pmredeem.ts); ids stay on this machine
      if (rows.length) {
        const won = wonRows(rows as Parameters<typeof wonRows>[0]);
        savePmRedeemable(won, now);
        extra.polymarketWaitingKinds = waitingKinds(won, loadJson("eventlive.json", []), loadJson("eventlive-claims.json", {}));
      }
      // an empty answer while the dashboard holds bets is a failed read, not $0 of bets (17 Nov 2026: srcOpen 0 vs 39 open)
      if (!rows.length && (d?.betsN ?? 0) > 0) {
        pos = null;
        errors.push(`positions: Polymarket answered with no positions while we hold ${d?.betsN}: not read`);
      } else if (pos.openN + pos.wonN + pos.lostN === 0 && (d?.betsN ?? 0) > 0) {
        // rows came back but none could be read (17 Nov 2026: srcOpen 0 vs 36 open, Polymarket all time still matched):
        // its field names differ from what splitPositions reads. The field names only (no values) are published to fix it.
        const keys = rows[0] && typeof rows[0] === "object" ? Object.keys(rows[0]).slice(0, 40).join(",") : typeof rows[0];
        pos = null;
        errors.push(`positions: ${rows.length} rows, none readable (fields: ${keys}): not read`);
      }
    } catch (e) {
      errors.push(`positions: ${(e as Error).message}`);
    }
    // Polymarket's own profit and loss for the wallet (the profile page's chart): its newest point. Its source data is
    // daily, so that point can be hours old: it is then compared with our own figure from that time (kept by each run),
    // and when we have none from then, the difference with ours now is shown but counts as no check.
    try {
      const mine = deps.allTime();
      // stamped with the time its history was read: a figure read hours ago compared as "now" drifted (20 Nov 2026, -$37.66)
      const mineAt = Math.min(now, deps.allTimeAt?.() ?? now);
      const samples = loadJson<[number, number][]>(SAMPLES, []).filter((x) => Array.isArray(x) && x[0] >= now - 3 * 86_400_000 && x[0] <= now && x[0] !== mineAt);
      if (mine != null) samples.push([mineAt, mine]);
      if (mine != null) saveJson(SAMPLES, samples);
      let pt: PnlPoint | null = null;
      for (const q of ["interval=1d&fidelity=1h", "interval=all&fidelity=1d", "interval=max&fidelity=1d"]) {
        const j = (await getDataApi(`${DATA_API}/v2/user-pnl?user=${funder}&${q}`).catch(() => null)) as { data?: { points?: PnlPoint[] } } | null;
        const pts = (j?.data?.points ?? []).filter((p) => fin(p.timestamp) != null && pnlOf(p) != null);
        if (pts.length) {
          pt = pts.reduce((a, p) => (Number(p.timestamp) > Number(a.timestamp) ? p : a));
          break;
        }
      }
      if (pt) {
        const ptMs = Number(pt.timestamp) * 1000;
        const ageMin = Math.round((now - ptMs) / 60_000);
        const at = new Date(ptMs).toISOString().slice(11, 16) + " UTC";
        const near = samples.filter((x) => Math.abs(x[0] - ptMs) <= 20 * 60_000).sort((a, b) => Math.abs(a[0] - ptMs) - Math.abs(b[0] - ptMs))[0];
        const it = near
          ? compare("Polymarket all time", near[1], pnlOf(pt), 2, 0.01, near[0] === mineAt && Math.abs(now - ptMs) <= 20 * 60_000 ? "against Polymarket's own profit and loss for the wallet (settled, open bets at its marks, and income)" : `against Polymarket's own profit and loss at ${at}, with ours from then`)
          : compare("Polymarket all time", mine, pnlOf(pt), 2, 0.01, `Polymarket's own figure is from ${at} (${ageMin} min before this check) and ours from then is not kept yet: a difference, not a check`);
        if (!near) it.ok = null;
        items.push(it);
        // the difference over time, one per Polymarket point (20 Nov 2026: to see whether it moves with the market's
        // marks or with our own trades); kept 3 days, published as differences only
        let hist = loadJson<[number, number][]>("truth-pm-diffs.json", []).filter((x) => Array.isArray(x) && x[0] >= now - 3 * 86_400_000 && x[0] !== ptMs);
        if (near && it.diff != null) hist = [...hist, [ptMs, it.diff] as [number, number]].sort((a, b) => a[0] - b[0]);
        saveJson("truth-pm-diffs.json", hist);
        extra.polymarketPnl = { asOf: ptMs, ageMin, comparedWithOursAt: near ? near[0] : null, fees: fin(pt.fees), income: fin(pt.wallet_income), unrealized: fin(pt.unrealized_pnl), diffs: hist.slice(-48), point: pt };
      } else errors.push("profit: not read");
    } catch (e) {
      errors.push(`profit: ${(e as Error).message}`);
    }
  } else errors.push("no Polymarket wallet on this machine");
  items.push(compare("Polymarket cash", d?.cash ?? null, pmCash, 0.05, 0));
  items.push(compare("Polymarket open bets", d?.bets ?? null, pos?.open ?? null, 1, 0.03, "Polymarket values a bet at its own current price; ours is the book price"));
  items.push(compare("Polymarket won, waiting for claim", d?.claim ?? null, pos?.won ?? null, 0.5, 0.01));
  if (pos) extra.polymarketCounts = { dashOpen: d?.betsN ?? null, dashPositions: d?.betsPos ?? null, srcOpen: pos.openN, srcWaiting: pos.wonN, srcLostNotRedeemed: pos.lostN };
  const pmDash = d?.cash != null ? d.cash + d.claim + d.bets : null;
  const pmSrc = pmCash != null && pos ? pmCash + pos.open + pos.won : null;
  // Polymarket's worth change since this KST day's first check, by the independent source and by the dashboard
  // (18 Nov 2026: "today" read -$33 after the unclaimed-wins fix; is that real?). Differences only, no balance.
  if (pmSrc != null && pmDash != null) {
    const day = kstDay(now);
    const f = loadJson<{ day?: string; at?: number; src?: number; dash?: number }>("truth-day.json", {});
    const first = f.day === day && Number.isFinite(f.src) && Number.isFinite(f.dash) ? f : { day, at: now, src: pmSrc, dash: pmDash };
    if (first !== f) saveJson("truth-day.json", first);
    extra.polymarketSinceFirstCheckToday = { from: first.at, source: r2(pmSrc - (first.src as number)), dashboard: r2(pmDash - (first.dash as number)), note: "money in or out of the wallet since then not taken off" };
  }
  items.push(compare("Polymarket card", pmDash, pmSrc, 1, 0.01));
  // Solana wallets
  const wallets = { spot: addrFile("solana-wallet-address.txt"), rules: addrFile("solana-wallet-buckets-address.txt"), perps: addrFile("solana-wallet-perps-address.txt") };
  const ours = new Set(Object.values(wallets).filter(Boolean));
  const tr = deps.tracked();
  const solSrc: Record<string, number | null> = { spot: null, rules: null, perps: null };
  const coinsOut: Record<string, unknown> = {};
  if (px != null) {
    for (const k of ["spot", "rules", "perps"] as const) {
      const a = wallets[k];
      if (!a) continue;
      try {
        const w = await solWallet(a, k === "spot" ? tr.spot : k === "rules" ? tr.rules : new Set());
        const perpPos = k === "perps" ? (d?.perpsPos ?? 0) : 0;
        solSrc[k] = (w.sol + w.coinsSol) * px + w.usd + perpPos;
        const untracked = w.coins.filter((c) => !c.tracked);
        coinsOut[k] = { coins: w.coins.length, priced: w.coins.filter((c) => c.sol != null).length, noRoute: w.noRoute, unpriced: w.unpriced, untracked: untracked.length, untrackedUsd: r2(untracked.reduce((x, c) => x + (c.sol ?? 0), 0) * px), detail: w.coins.map((c) => ({ ...c, sol: c.sol == null ? null : r6(c.sol) })), solBal: r6(w.sol), usd: r2(w.usd) };
      } catch (e) {
        errors.push(`solana ${k}: ${(e as Error).message}`);
      }
    }
  } else errors.push("no SOL price");
  const spotDash = d && px != null && d.solBal != null ? (d.solBal + d.coinsSol) * px : null;
  items.push(compare("Solana spot copy card", spotDash, solSrc.spot, 1, 0.015, "coins at a Jupiter sale quote; the chain's coins, tracked or not"));
  items.push(compare("Solana spot rules card", d?.rulesUsd ?? null, solSrc.rules, 1, 0.015));
  items.push(compare("Solana perps card", d?.perpsUsd ?? null, solSrc.perps, 1, 0.015, "an open perp from the perps module's own chain read"));
  // Hyperliquid positions (20 Nov 2026, enrique: "numbers and things happening need to be accurate"): every position
  // Hyperliquid holds in our two wallets is in our books, and every one our books hold is on Hyperliquid
  if (deps.hl) {
    try {
      const h = deps.hl();
      const ours = h.opens.map((o) => `${o.wallet}:${o.coin}`).sort();
      const theirs: string[] = [];
      for (const [i, a] of h.addrs.entries()) {
        if (!a) continue;
        const j = (await getJson("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "clearinghouseState", user: a }) })) as { assetPositions?: { position?: { coin?: string; szi?: string } }[] };
        for (const p of j.assetPositions ?? []) if (p.position?.coin && Number(p.position.szi) !== 0) theirs.push(`${i + 1}:${p.position.coin}`);
      }
      theirs.sort();
      const notOnHl = ours.filter((x) => !theirs.includes(x));
      const notInBooks = theirs.filter((x) => !ours.includes(x));
      items.push({ k: "Hyperliquid open positions", dash: ours.length, src: theirs.length, diff: ours.length - theirs.length, ok: !notOnHl.length && !notInBooks.length, why: "our books' open copies against Hyperliquid's positions in both wallets, coin by coin" });
      extra.hlPositions = { ours: ours.length, onHl: theirs.length, notOnHl, notInBooks };
    } catch (e) {
      errors.push(`hyperliquid positions: ${(e as Error).message}`);
    }
  }
  // Polymarket open bets, one by one count: the dashboard's against Polymarket's own
  if (pos) {
    // Polymarket counts positions (one per outcome held); two buys of one outcome are one position there (20 Nov 2026).
    const dn = d?.betsPos ?? d?.betsN ?? null;
    items.push({ k: "Polymarket open positions (count)", dash: dn, src: pos.openN, diff: dn != null ? dn - pos.openN : null, ok: dn != null ? Math.abs(dn - pos.openN) <= 1 : null, why: "positions, not bets: two buys of one outcome are one position; a bet bought in the minute of the check can show on one side only" });
  }
  // Hyperliquid (17 Nov 2026) is not read again here yet: its own reading is added so the total compares like for like
  const parts = [pmSrc, solSrc.spot, solSrc.rules, solSrc.perps, d?.hlUsd ?? 0];
  items.push(compare("Total worth", d?.total ?? null, parts.every((x) => x != null) ? parts.reduce((a: number, x) => a + (x as number), 0) : null, 2, 0.01));
  // money in and out of the Solana wallets, 8 days, against the flows the chart takes out
  if (px != null && deps.helius()) {
    const labels = { spot: "Solana spot copy", rules: "Solana spot rules", perps: "Solana perps" } as const;
    const read: Partial<Record<"spot" | "rules" | "perps", HeliusTx[]>> = {};
    for (const k of ["spot", "rules", "perps"] as const) {
      if (!wallets[k]) continue;
      try {
        read[k] = await heliusTransfers(wallets[k], now - 8 * 86_400_000);
      } catch (e) {
        errors.push(`transfers ${k}: ${(e as Error).message}`);
      }
    }
    // what is on the other side of each transfer: only a plain wallet that is not ours is money put in or taken out
    let kinds: Map<string, AccountKind> | undefined;
    const cps = [...new Set((Object.keys(read) as (keyof typeof read)[]).flatMap((k) => counterparts(read[k]!, wallets[k])))].filter((a) => !ours.has(a));
    try {
      kinds = await classifyAccounts(cps);
    } catch (e) {
      errors.push(`account kinds: ${(e as Error).message}`);
    }
    const chain: Transfer[] = [];
    const kindCount: Record<string, number> = {};
    for (const k of Object.keys(read) as (keyof typeof read)[]) {
      chain.push(...externalTransfers(read[k]!, wallets[k], ours, px, labels[k], kinds));
    }
    if (kinds) for (const a of cps) kindCount[kinds.get(a) ?? "not read"] = (kindCount[kinds.get(a) ?? "not read"] ?? 0) + 1;
    const flows = deps.flows().filter((f) => f[0] >= now - 8 * 86_400_000);
    const m = matchFlows(chain, flows);
    const midnight = Math.floor((now + 9 * 3_600_000) / 86_400_000) * 86_400_000 - 9 * 3_600_000;
    const perWallet: Record<string, { chain: number; matched: number; missing: number; notOnChain: number }> = {};
    for (const l of Object.values(labels)) perWallet[l] = { chain: chain.filter((c) => c.wallet === l).length, matched: m.matched.filter((c) => c.wallet === l).length, missing: m.missing.filter((c) => c.wallet === l).length, notOnChain: m.extra.filter((f) => f[2] === l).length };
    extra.flows = {
      chainTransfers: chain.length,
      matched: m.matched.length,
      kindsRead: !!kinds,
      from: now - 8 * 86_400_000,
      missing: m.missing.map((x) => ({ t: x.t, wallet: x.wallet, usd: x.usd, sig: x.sig })),
      notOnChain: m.extra.map((f) => ({ t: f[0], usd: f[1], wallet: f[2] })),
      unconfirmed: unconfirmedFlows(flows).map((f) => ({ t: f[0], usd: f[1], wallet: f[2] })),
      polymarketFlows: flows.filter((f) => f[2] === "Polymarket").map((f) => ({ t: f[0], usd: f[1] })),
      counterpartKinds: kindCount,
      perWallet,
      // the chart's Solana money in and out minus the chain's, per window: what each window's change is off by
      windowDiff: kinds ? { today: windowFlowDiff(chain, flows, midnight), "24h": windowFlowDiff(chain, flows, now - 86_400_000), "7d": windowFlowDiff(chain, flows, now - 7 * 86_400_000) } : null,
    };
  }
  // each Korean day's closed trades, as served, against a recount from the raw trade files
  if (deps.dayServed) {
    try {
      extra.days = compareDays(servedDayCells(deps.dayServed()), recountDays(readRawTrades()), now, px);
    } catch (e) {
      errors.push(`days: ${(e as Error).message}`);
    }
  }
  extra.coins = coinsOut;
  extra.errors = errors;
  extra.dashAt = d?.at ?? null;
  last = { at: now, items, extra };
  saveJson("truth.json", last);
  return last;
}

/** For the public status: the differences and counts only, never a balance or a deposit. */
export function truthPublic() {
  if (!last) return null;
  const ex = last.extra as { polymarketPnl?: { asOf: number; ageMin: number; comparedWithOursAt: number | null; fees: number | null; income: number | null; unrealized?: number | null; diffs?: [number, number][] }; polymarketCounts?: unknown; polymarketWaitingKinds?: unknown; polymarketSinceFirstCheckToday?: unknown; coins?: Record<string, { coins: number; noRoute: number; unpriced: number; untracked: number; untrackedUsd: number }>; flows?: { chainTransfers: number; matched: number; missing: unknown[]; notOnChain: unknown[]; unconfirmed?: { t: number; wallet: string }[]; perWallet?: unknown; counterpartKinds?: unknown; windowDiff?: unknown }; days?: { rows: DayRow[]; notRead: string[] }; errors?: string[] };
  return {
    at: last.at,
    note: "Dashboard minus an independent source (the chain, Polymarket's own position data). Within $1 or 1.5% = ok. Balances stay private.",
    items: last.items.map((i) => ({ k: i.k, diff: i.diff, ok: i.ok, ...(i.why ? { why: i.why } : {}) })),
    polymarketCounts: ex.polymarketCounts ?? null,
    // Polymarket's won-and-redeemable bets by what they are in our books (src/pmredeem.ts): counts and dollars, no ids
    polymarketWaitingKinds: ex.polymarketWaitingKinds ?? null,
    polymarketSinceFirstCheckToday: ex.polymarketSinceFirstCheckToday ?? null,
    polymarketPnl: ex.polymarketPnl ? { asOf: ex.polymarketPnl.asOf, ageMin: ex.polymarketPnl.ageMin, comparedWithOursAt: ex.polymarketPnl.comparedWithOursAt, fees: ex.polymarketPnl.fees, income: ex.polymarketPnl.income, unrealized: ex.polymarketPnl.unrealized ?? null, diffs: ex.polymarketPnl.diffs ?? [] } : null,
    coins: Object.fromEntries(Object.entries(ex.coins ?? {}).map(([k, v]) => [k, { coins: v.coins, noRoute: v.noRoute, unpriced: v.unpriced, untracked: v.untracked, untrackedUsd: v.untrackedUsd }])),
    flows: ex.flows ? { chainTransfers: ex.flows.chainTransfers, matched: ex.flows.matched, missingFromChart: ex.flows.missing.length, chartFlowsNotOnChain: ex.flows.notOnChain.length, notConfirmedByEnrique: (ex.flows.unconfirmed ?? []).map((u) => ({ at: u.t, wallet: u.wallet })), perWallet: ex.flows.perWallet ?? null, counterpartKinds: ex.flows.counterpartKinds ?? null, windowDiff: ex.flows.windowDiff ?? null } : null,
    // day by day: how many lines were compared, and only the wrong ones, as differences (no day's own figures)
    days: ex.days ? { checked: ex.days.rows.length, notRead: ex.days.notRead, wrong: ex.days.rows.filter((r) => !r.ok || r.cumulative).map((r) => ({ day: r.day, type: r.type, countDiff: r.countDiff, netDiff: r.netDiff, ...(r.cumulative ? { cumulative: true } : {}) })) } : null,
    errors: (ex.errors ?? []).map((e) => e.replace(/0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/g, "…")),
  };
}
/** For the password-protected page: everything. */
export const truthPrivate = () => last;

export function startTruthCheck(d: Deps) {
  if (process.env.TRUTHCHECK === "off" || deps) return;
  deps = d;
  last = loadJson<typeof last>("truth.json", null);
  const run = () => void truthRun().catch(() => undefined);
  setTimeout(run, 4 * 60_000).unref();
  setInterval(run, 30 * 60_000).unref();
}
/** What the worth chart should change for the two Solana strategy wallets (src/worthdash.ts mergeChainFlows): only from
 * a run that knew what was on the other side of each transfer. Behind the password only (truth.json). */
export function chainFix(): { at: number; from: number; missing: { t: number; usd: number; wallet: string }[]; notOnChain: { t: number; usd: number; wallet: string }[] } | null {
  const f = (last?.extra as { flows?: { kindsRead?: boolean; from?: number; missing?: { t: number; usd: number; wallet: string }[]; notOnChain?: { t: number; usd: number; wallet: string }[] } } | undefined)?.flows;
  if (!last || !f?.kindsRead || f.from == null) return null;
  return { at: last.at, from: f.from, missing: f.missing ?? [], notOnChain: f.notOnChain ?? [] };
}
export const _truthTest = { setDeps: (d: Deps | null) => void (deps = d), reset: () => void (last = null), setWaits: (w: number[]) => void (dataWaits = w) };
