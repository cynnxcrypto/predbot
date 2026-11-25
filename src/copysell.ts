/**
 * FOLLOW THE SALES of the Polymarket wallets we copy (19 Nov 2026 15:49 KST, enrique, on "follow partial closes":
 * "this should be for any copytrading not just HL").
 *
 * Until now a copy was held to the result whatever the copied wallet did. Here, when a copied wallet sells part of a
 * position we copied, we sell THE SAME SHARE of ours: it takes half off, we take half off; it gets out, we get out.
 *
 *   - What share: the sale against what the wallet held just before it, from its own trade list (the same rows the
 *     copy code reads). When that list may not reach back to its buys, what it still holds is asked from Polymarket
 *     and the share is sold / (sold + still held). Unknown = nothing is sold.
 *   - Paper: the copy-take and copy-rest twins sell at the bids we see (walked, taker fee charged), so paper mirrors
 *     real. The copy-any twin is left alone on purpose: it stays the "held to the end" side of the comparison in
 *     eventPaper.copyGap.sells.
 *   - Real: a fill-and-kill SELL on the CLOB book, limited to `slip` under the best bid. Off until the live rules say
 *     events.copy.sells.real true. The exchange takes no order under about $1, so a small part waits and goes with
 *     the wallet's next sale; when the wallet is out we sell all we hold.
 *   - Books: the part sold becomes its own finished row in data/eventlive.json (status "sold", result = what the sale
 *     paid minus its share of the cost and fees); the open row keeps the rest of the shares and of the cost, and is
 *     settled and claimed as before. Nothing here buys, so stakes, the ladder and the 14-day limit are untouched; a
 *     market we sold out of is not bought again (the row stays on file).
 *
 * Real orders run under the one-at-a-time lock of src/eventlive.ts (eventLiveTurn). data/copysell.json holds what
 * was already acted on, so the live socket and the 15 s reading can both report a sale and it is followed once.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AssetType, OrderType, Side } from "@polymarket/clob-client-v2";
import { ROOT } from "./config.js";
import { EVENT_LIVE_FILE, eventLiveBusy, eventLiveConfig, eventLiveRows, eventLiveTurn, getClient, type EventLiveRow } from "./eventlive.js";
import { loadJson, saveJson } from "./store.js";
import type { PaperTrade } from "./eventpaper.js";

const STATE_FILE = "copysell.json";
/** A sale read later than this is not followed any more (as for buys: the bot was down). */
export const SALE_MAX_AGE_S = 1800;
/** A real sale that did not go through is tried again this often, this many times, while the sale is this fresh. */
const RETRY_MS = 60_000;
const MAX_TRIES = 5;
const DUE_MS = 30 * 60_000;
/** How long an order with no clean answer (or held by the exchange) is given to show in our trades. */
const PENDING_MS = 5 * 60_000;
/** The wallet holds this little of what it had: it is out, and so are we. */
const OUT = 0.02;

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const r2 = (x: number) => Math.round(x * 100) / 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const timed = <T>(p: Promise<T>, what: string, ms = 20_000) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`${what} timed out`)), ms).unref())]);

// ---------- switch ----------
export type SellCfg = { paper: boolean; real: boolean; minUsd: number; slip: number };
/** events.copy.sells of deploy/live-rules.json. Paper follows unless told not to; real only when told to. */
export function parseSellCfg(text: string): SellCfg {
  const d: SellCfg = { paper: true, real: false, minUsd: 1, slip: 0.02 };
  try {
    const v = (JSON.parse(text) as { events?: { copy?: { sells?: Record<string, unknown> } } })?.events?.copy?.sells;
    if (!v || typeof v !== "object") return d;
    const n = (x: unknown, f: number, lo: number, hi: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : f);
    return { paper: v.paper !== false, real: v.real === true, minUsd: n(v.minUsd, 1, 0.5, 20), slip: n(v.slip, 0.02, 0, 0.2) };
  } catch {
    return d;
  }
}
let cfgTest: (SellCfg & { live?: boolean }) | null = null;
function sellCfg(): SellCfg & { live: boolean } {
  if (cfgTest) return { live: true, ...cfgTest };
  let text = "";
  try {
    text = readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8");
  } catch {
    /* no rules file: paper only */
  }
  return { ...parseSellCfg(text), live: eventLiveConfig().mode === "live" };
}

// ---------- the wallet's trades ----------
type Act = { type?: string; side?: string; price?: number | string; size?: number | string; usdc_size?: number | string; usdcSize?: number | string; timestamp?: number | string; condition_id?: string; outcome_index?: number | string };
export type Fill = { ts: number; side: "BUY" | "SELL"; cond: string; idx: number; size: number; price: number };
/** Activity rows (data API or live socket) as trades in shares. Rows that are not a usable trade are dropped. */
export function fillsOf(rows: Act[]): Fill[] {
  const out: Fill[] = [];
  for (const r of rows) {
    if (r?.type !== "TRADE") continue;
    const side = String(r.side ?? "").toUpperCase();
    const t = Number(r.timestamp);
    const ts = t > 1e12 ? Math.floor(t / 1000) : Math.floor(t);
    const cond = String(r.condition_id ?? "");
    const idx = r.outcome_index == null || r.outcome_index === "" ? NaN : Number(r.outcome_index);
    const price = Number(r.price);
    const usd = Number(r.usdc_size ?? r.usdcSize);
    const size = Number(r.size) > 0 ? Number(r.size) : usd > 0 && price > 0 ? usd / price : NaN;
    if ((side !== "BUY" && side !== "SELL") || !(ts > 0) || !/^0x[0-9a-fA-F]{64}$/.test(cond) || !(idx === 0 || idx === 1) || !(price > 0 && price < 1) || !(size > 0)) continue;
    out.push({ ts, side, cond, idx, size: r6(size), price });
  }
  return out;
}
const fkey = (f: Fill) => `${f.cond}|${f.idx}|${f.ts}|${f.side}|${f.size}|${f.price}`;
/** Two readings of the same wallet as one list: a trade in both counts once, two equal trades in one reading twice. */
export function mergeFills(a: Fill[], b: Fill[]): Fill[] {
  const count = (xs: Fill[]) => {
    const m = new Map<string, number>();
    for (const f of xs) m.set(fkey(f), (m.get(fkey(f)) ?? 0) + 1);
    return m;
  };
  const ca = count(a);
  const out = [...a];
  const used = new Map<string, number>();
  for (const f of b) {
    const k = fkey(f);
    const n = (used.get(k) ?? 0) + 1;
    used.set(k, n);
    if (n > (ca.get(k) ?? 0)) out.push(f);
  }
  return out;
}
/** The sales in `cand` newer than `minTs` that were not acted on yet (`seen`: trade -> how many of it were). Pure. */
export function newSales(cand: Fill[], seen: Record<string, { n: number; ts: number } | undefined>, wallet: string, minTs: number): Fill[] {
  const n = new Map<string, number>();
  const out: Fill[] = [];
  for (const f of cand) {
    if (f.side !== "SELL" || !(f.ts > minTs)) continue;
    const k = `${wallet}|${fkey(f)}`;
    const i = (n.get(k) ?? 0) + 1;
    n.set(k, i);
    if (i > (seen[k]?.n ?? 0)) out.push(f);
  }
  return out;
}
/**
 * What part of its position in one market side the wallet KEEPS after `sales` (the new ones, all of that side), read
 * from `all` its trades there: each sale is taken against what it held just before it. `covered` is false when the
 * list shows it selling more than the list shows it holding (its buys are older than the list). Pure.
 */
export function keepAfter(all: Fill[], sales: Fill[], cond: string, idx: number): { keep: number; covered: boolean; sold: number } {
  const mine = all.filter((f) => f.cond === cond && f.idx === idx).sort((a, b) => a.ts - b.ts || (a.side === b.side ? 0 : a.side === "BUY" ? -1 : 1));
  const fresh = new Map<string, number>();
  for (const s of sales) fresh.set(fkey(s), (fresh.get(fkey(s)) ?? 0) + 1);
  const total = new Map<string, number>();
  for (const f of mine) if (f.side === "SELL") total.set(fkey(f), (total.get(fkey(f)) ?? 0) + 1);
  const at = new Map<string, number>();
  let held = 0;
  let keep = 1;
  let covered = true;
  let sold = 0;
  for (const f of mine) {
    if (f.side === "BUY") {
      held += f.size;
      continue;
    }
    const k = fkey(f);
    const i = (at.get(k) ?? 0) + 1;
    at.set(k, i);
    // of equal trades, the newest ones are the new ones
    if (i > (total.get(k) ?? 0) - (fresh.get(k) ?? 0)) {
      sold += f.size;
      if (held >= f.size * 0.999) keep *= 1 - Math.min(1, f.size / held);
      else {
        covered = false;
        keep = 0;
      }
    }
    held = Math.max(0, held - f.size);
  }
  return { keep: keep < 1e-9 ? 0 : keep, covered, sold: r6(sold) };
}
/**
 * The share kept that we act on, or null when it cannot be known. The wallet's own list decides when it is complete
 * (`complete`: the reading returned fewer rows than it may, so nothing older is cut off) and shows the buys; else
 * what Polymarket says it still holds (`remaining` shares); else the list if it at least shows the buys. Pure.
 */
export function shareKept(k: { keep: number; covered: boolean; sold: number }, complete: boolean, remaining: number | null): number | null {
  if (k.covered && complete) return k.keep;
  if (remaining != null && remaining >= 0 && k.sold > 0) return remaining / (remaining + k.sold);
  return k.covered ? k.keep : null;
}
/**
 * How many shares to sell now. `shares0` is what we held when the wallet first sold, `keep` the part of its position
 * it still has since then, so we should hold shares0 x keep. A part worth under `minUsd` at the bid waits (the
 * exchange refuses it); once the wallet is out, all we hold goes. Pure.
 */
export function sellPlan(held: number, shares0: number, keep: number, bid: number, minUsd: number): { shares: number; all: boolean; why?: string } {
  const out = keep <= OUT;
  const want = out ? held : Math.floor((held - shares0 * keep) * 100) / 100;
  if (!(want > 0.005)) return { shares: 0, all: false };
  if (!out && want * bid < minUsd - 1e-9) return { shares: 0, all: false, why: `its sale is $${(want * bid).toFixed(2)} of ours: under $${minUsd}, goes with its next sale` };
  return { shares: Math.min(held, want), all: out || want >= held - 0.011 };
}

// ---------- books ----------
const keyOf = (r: { rule: string; marketId: string; idx: number; t: number }) => `${r.rule}|${r.marketId}|${r.idx}|${r.t}`;
const taker = (rate: number, shares: number, px: number) => rate * shares * px * (1 - px);
/**
 * Book a real sale of `sold` shares for `usd` on the open row `key`. All of it (`all`: everything the wallet held of
 * it went, which can be a little under the row's shares): the row itself is finished. A part:
 * the part becomes its own finished row and the open row keeps the rest of the shares, cost and fee. Neither carries
 * `pay`, so the claimer leaves them alone. Changes `rows`; returns the result, or null when the row is not open.
 */
export function bookSale(rows: EventLiveRow[], key: string, sold: number, usd: number, feeRate: number, now: number, all = false): { pnl: number; all: boolean; shares: number } | null {
  const r = rows.find((x) => keyOf(x) === key && x.pnl == null && x.shares > 0);
  if (!r || !(sold > 0) || !(usd >= 0)) return null;
  const s = Math.min(sold, r.shares);
  const fee = taker(feeRate, s, usd / s);
  if (all || s >= r.shares - 0.011) {
    r.fee = r6(r.fee + fee);
    r.pnl = r6(usd - r.cost - r.fee);
    r.won = r.pnl > 0;
    r.settledAt = now;
    r.status = "sold";
    return { pnl: r.pnl, all: true, shares: s };
  }
  const part = s / r.shares;
  let t = r.t + 1;
  while (rows.some((x) => x.rule === r.rule && x.marketId === r.marketId && x.idx === r.idx && x.t === t)) t++;
  const piece: EventLiveRow = { ...r, t, shares: r6(s), cost: r6(r.cost * part), size: r6(r.size * part), fee: r6(r.fee * part + fee), status: "sold", settledAt: now };
  piece.pnl = r6(usd - piece.cost - piece.fee);
  piece.won = piece.pnl > 0;
  delete piece.token;
  delete piece.orderId;
  delete piece.until;
  r.shares = r6(r.shares - s);
  r.cost = r6(r.cost * (1 - part));
  r.size = r6(r.size * (1 - part));
  r.fee = r6(r.fee * (1 - part));
  rows.push(piece);
  return { pnl: piece.pnl, all: false, shares: s };
}
type Level = { price: number; size: number };
/** `shares` sold by walking the bids (best first) down to `limit`: what fills and what it pays. */
export function walkBids(bids: Level[], shares: number, limit: number): { shares: number; usd: number } {
  let got = 0;
  let usd = 0;
  for (const b of bids) {
    if (b.price < limit - 1e-9 || got >= shares - 1e-9) break;
    const take = Math.min(b.size, shares - got);
    got += take;
    usd += take * b.price;
  }
  return { shares: got, usd };
}
/**
 * One paper copy follows a sale: `factor` is the part of its position the wallet kept through this sale. Sold at the
 * bids we see, taker fee charged. The trade is finished in place when all goes; a part comes back as its own finished
 * trade (`piece`, for the caller to add) and the open trade keeps the rest. Returns null when nothing is sold.
 */
export function paperSell(t: PaperTrade, factor: number, bids: Level[], cfg: { minUsd: number; slip: number }, now: number, their: number, feeRate = t.feeRate): { piece: PaperTrade | null; shares: number; usd: number; pnl: number } | null {
  const e = (t.extra ??= {});
  const shares0 = Number(e.shares0) > 0 ? Number(e.shares0) : t.shares;
  const keep = (typeof e.keep === "number" && Number.isFinite(e.keep) ? e.keep : 1) * factor;
  e.shares0 = shares0;
  e.keep = keep;
  const bid = bids[0]?.price;
  if (!(bid > 0) || t.pnl != null || !(t.shares > 0)) return null;
  const plan = sellPlan(t.shares, shares0, keep, bid, cfg.minUsd);
  if (!plan.shares) return null;
  const w = walkBids(bids, plan.shares, bid - cfg.slip);
  if (!(w.shares > 0)) return null;
  const fee = taker(feeRate, w.shares, w.usd / w.shares);
  const sold = { t: now, shares: r6(w.shares), usd: r6(w.usd), their };
  if (w.shares >= t.shares - 1e-6) {
    t.fee += fee;
    t.pnl = w.usd - t.cost - t.fee;
    t.won = t.pnl > 0;
    t.settledAt = now;
    e.sold = sold;
    return { piece: null, shares: w.shares, usd: w.usd, pnl: t.pnl };
  }
  const part = w.shares / t.shares;
  const piece: PaperTrade = { ...t, shares: w.shares, cost: t.cost * part, fee: t.fee * part + fee, settledAt: now, extra: { ...e, sold } };
  piece.pnl = w.usd - piece.cost - piece.fee;
  piece.won = piece.pnl > 0;
  t.shares -= w.shares;
  t.cost *= 1 - part;
  t.fee *= 1 - part;
  return { piece, shares: w.shares, usd: w.usd, pnl: piece.pnl };
}

// ---------- state ----------
type Pending = { t: number; shares: number; bid: number; all: boolean; orderId?: string };
type Pos = { wallet: string; title: string; shares0: number; keep: number; at: number; their: number; feeRate: number; tries: number; lastTry: number; pending?: Pending; last?: string };
type Note = { t: number; wallet: string; title: string; outcome: string; keptPct: number | null; theirC: number | null; real: string | null; paper: number; src: string };
type St = { seen: Record<string, { n: number; ts: number }>; pos: Record<string, Pos>; notes: Note[]; n: { sales: number; real: number; realShares: number; realUsd: number; realNet: number; paper: number; paperNet: number; unknown: number } };
const blank = (): St => ({ seen: {}, pos: {}, notes: [], n: { sales: 0, real: 0, realShares: 0, realUsd: 0, realNet: 0, paper: 0, paperNet: 0, unknown: 0 } });
let st: St | null = null;
function state(): St {
  if (st) return st;
  const got = loadJson<Partial<St>>(STATE_FILE, {});
  st = { ...blank(), ...got, n: { ...blank().n, ...(got.n ?? {}) } };
  return st;
}
const save = () => saveJson(STATE_FILE, state());
function note(x: Note) {
  const s = state();
  s.notes.push(x);
  if (s.notes.length > 60) s.notes.splice(0, s.notes.length - 60);
}

// ---------- real orders ----------
type Client = {
  getBalanceAllowance(p: { asset_type: AssetType; token_id?: string }): Promise<{ balance?: string; allowance?: string; allowances?: Record<string, string> }>;
  getTickSize(token: string): Promise<unknown>;
  getNegRisk(token: string): Promise<unknown>;
  createMarketOrder(o: { tokenID: string; amount: number; side: Side; price: number; orderType: OrderType.FAK }, opt: { tickSize: never; negRisk: boolean }): Promise<unknown>;
  postOrder(order: never, type: OrderType.FAK): Promise<{ success?: boolean; errorMsg?: string; orderID?: string; status?: string; takingAmount?: string; makingAmount?: string; error?: unknown }>;
  getTrades(p: { asset_id: string; after: string }): Promise<unknown>;
};
let clientTest: Client | null = null;
async function clientOf(): Promise<Client> {
  if (clientTest) return clientTest;
  const funder = String(loadJson<{ funder?: string }>("live.json", {}).funder ?? "").trim();
  return (await getClient(funder)) as unknown as Client;
}
/** What a SELL order's answer says was sold: shares and dollars, whichever way round the two amounts come. Pure. */
export function sellFill(res: { makingAmount?: string; takingAmount?: string } | null | undefined, asked: number): { shares: number; usd: number } {
  const a = Number(res?.makingAmount) || 0;
  const b = Number(res?.takingAmount) || 0;
  const ok = (s: number, u: number) => s > 0 && u > 0 && s <= asked * 1.001 + 1e-6 && u / s < 1;
  if (ok(a, b)) return { shares: a, usd: b };
  if (ok(b, a)) return { shares: b, usd: a };
  return { shares: 0, usd: 0 };
}
/** What our own trades say an order sold (by its id; with no id, our taker sales of the token around its time). Pure. */
export function soldFromTrades(trades: { taker_order_id?: string; side?: string; size?: string; price?: string; status?: string; trader_side?: string; match_time?: string }[], p: { orderId?: string; t: number }): { shares: number; usd: number } {
  let shares = 0;
  let usd = 0;
  for (const tr of Array.isArray(trades) ? trades : []) {
    if (String(tr.side).toUpperCase() !== "SELL" || /FAIL/i.test(String(tr.status))) continue;
    if (p.orderId ? tr.taker_order_id !== p.orderId : tr.trader_side !== "TAKER" || !(Number(tr.match_time) * 1000 >= p.t - 60_000 && Number(tr.match_time) * 1000 <= p.t + 10 * 60_000)) continue;
    const size = Number(tr.size);
    const price = Number(tr.price);
    if (!(size > 0) || !(price > 0)) continue;
    shares += size;
    usd += size * price;
  }
  return { shares: r6(shares), usd: r6(usd) };
}
/** The real order lock, waited for up to ~10 s (a buy of another rule may be in flight). null = not got. */
async function turn<T>(f: () => Promise<T>): Promise<T | null> {
  for (let i = 0; i < 20 && eventLiveBusy(); i++) await sleep(500);
  const got = await eventLiveTurn(f);
  return got.ok ? got.value : null;
}
function booked(key: string, shares: number, usd: number, p: Pos, now: number, all: boolean): string {
  // read fresh and written at once: the row file is shared with the buys and the settlement
  const rows = eventLiveRows();
  const b = bookSale(rows, key, shares, usd, p.feeRate, now, all);
  if (!b) return "sale filled but its copy was no longer open: check the books";
  saveJson(EVENT_LIVE_FILE, rows);
  const s = state();
  s.n.real += 1;
  s.n.realShares = r6(s.n.realShares + b.shares);
  s.n.realUsd = r6(s.n.realUsd + usd);
  s.n.realNet = r6(s.n.realNet + b.pnl);
  if (b.all) delete s.pos[key];
  return `REAL sold ${b.shares.toFixed(2)} for $${usd.toFixed(2)} (${Math.round((usd / b.shares) * 1000) / 10}c), ${b.all ? "all of it" : "a part"}: $${b.pnl.toFixed(2)}`;
}
/** One real sale of `want` shares of the open row `key`. Returns the line for the log. Never throws. */
async function sellReal(key: string, want: number, all: boolean, bid: number, cfg: SellCfg): Promise<string> {
  const p = state().pos[key];
  if (!p) return "nothing to sell";
  p.lastTry = Date.now();
  p.tries += 1;
  const got = await turn(async () => {
    const r = eventLiveRows().find((x) => keyOf(x) === key && x.pnl == null && x.shares > 0);
    if (!r?.token) return "copy no longer open";
    const c = await clientOf();
    const ba = await timed(c.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: r.token }), "reading the shares");
    const bal = Number(ba?.balance) / 1e6;
    if (!Number.isFinite(bal)) return "REAL sale not sent (share balance unknown)";
    const allow = ba.allowances ? Object.values(ba.allowances) : ba.allowance != null ? [ba.allowance] : [];
    if (allow.length && allow.every((x) => !(Number(x) > 0))) return "REAL sale not sent (the wallet has not yet allowed the exchange to take its shares: one-time permission missing)";
    const amount = Math.floor(Math.min(want, r.shares, bal) * 100) / 100;
    if (!(amount > 0)) return "REAL sale not sent (no shares of it in the wallet)";
    const [tickSize, negRisk] = await timed(Promise.all([c.getTickSize(r.token), c.getNegRisk(r.token)]), "reading the market");
    const tick = Number(tickSize) > 0 ? Number(tickSize) : 0.01;
    const floor = Math.max(tick, Math.round(Math.round((bid - cfg.slip) / tick) * tick * 1e4) / 1e4);
    const order = await timed(c.createMarketOrder({ tokenID: r.token, amount, side: Side.SELL, price: floor, orderType: OrderType.FAK }, { tickSize: tickSize as never, negRisk: Boolean(negRisk) }), "signing the order");
    // Written BEFORE the order is sent: if the answer is lost, the sale is looked up in our trades instead of repeated.
    p.pending = { t: Date.now(), shares: amount, bid, all };
    save();
    let res: Awaited<ReturnType<Client["postOrder"]>>;
    try {
      res = await timed(c.postOrder(order as never, OrderType.FAK), "sending the order", 30_000);
    } catch (e) {
      return `REAL sale sent, answer lost (${e instanceof Error ? e.message : String(e)}): read from our trades on the next look`;
    }
    if (typeof res?.orderID === "string" && res.orderID) p.pending.orderId = res.orderID;
    if (!res?.success) {
      delete p.pending;
      return `REAL sale refused (${String(res?.errorMsg || (res?.error ? JSON.stringify(res.error).slice(0, 160) : "order rejected")).slice(0, 200)})`;
    }
    const f = sellFill(res, amount);
    if (f.shares > 0) {
      delete p.pending;
      return booked(key, f.shares, f.usd, p, Date.now(), all && f.shares >= amount - 0.011);
    }
    // accepted with no amounts: held by the exchange for a few seconds (sports), or amounts we cannot read
    if (String(res.status ?? "").toLowerCase() === "delayed" || Number(res.makingAmount) > 0 || Number(res.takingAmount) > 0) return "REAL sale accepted with a delay: read from our trades on the next look";
    delete p.pending;
    return "REAL sale not filled (no bid at our price)";
  }).catch((e) => `REAL sale not sent (${e instanceof Error ? e.message : String(e)})`);
  const line = got ?? "REAL sale waits: another real order is in flight";
  if (got == null) p.tries -= 1;
  p.last = line;
  save();
  return line;
}

export type SellDeps = {
  /** Gamma's market of a condition: its id, the two outcome tokens and the taker fee rate. null/undefined = unknown. */
  market: (cond: string) => Promise<{ id: string; tokens: string[]; feeRate: number } | null | undefined>;
  book: (token: string) => Promise<{ bids: Level[]; bestBid: number | null } | null>;
  /** Shares the wallet still holds of a market side, or null when unknown. Default: Polymarket's positions list. */
  remaining?: (address: string, cond: string, idx: number) => Promise<number | null>;
  /** The paper trades (the caller's own list: finished parts are added to it). */
  trades: PaperTrade[];
};
let dueBusy = false;
/**
 * Sell what the real copies still owe: every open real copy whose wallet sold a share we have not sold yet (a first
 * try, or one that failed), while the sale is fresh. Also settles orders left without a clean answer. Returns log lines.
 */
export async function sellDue(deps: Pick<SellDeps, "book">, now = Date.now()): Promise<string[]> {
  if (dueBusy || !Object.keys(state().pos).length) return [];
  const cfg = sellCfg();
  dueBusy = true;
  const out: string[] = [];
  try {
    const s = state();
    const open = new Map(eventLiveRows().filter((r) => r.pnl == null && r.shares > 0).map((r) => [keyOf(r), r]));
    let changed = false;
    for (const [key, p] of Object.entries(s.pos)) {
      const r = open.get(key);
      if (!r) {
        // settled, or sold out: nothing left to follow
        if (!p.pending || now - p.pending.t > PENDING_MS) {
          delete s.pos[key];
          changed = true;
        }
        continue;
      }
      const label = `${p.wallet} ${r.title} ${r.outcome}`;
      if (p.pending) {
        const line = await settlePending(key, p, r, now);
        if (line) out.push(`${label}: ${line}`);
        continue;
      }
      if (!cfg.real || !cfg.live || !r.token) continue;
      if (now - p.at > DUE_MS || p.tries >= MAX_TRIES || now - p.lastTry < RETRY_MS) continue;
      if (!(r.shares - p.shares0 * p.keep > 0.005) && !(p.keep <= OUT)) continue;
      const bk = await deps.book(r.token).catch(() => null);
      const bid = bk?.bestBid ?? null;
      if (!(bid != null && bid > 0)) {
        p.lastTry = now;
        p.tries += 1;
        p.last = "REAL sale not sent (no bid on the book)";
        changed = true;
        continue;
      }
      const plan = sellPlan(r.shares, p.shares0, p.keep, bid, cfg.minUsd);
      if (!plan.shares) {
        if (plan.why && p.last !== plan.why) {
          p.last = plan.why;
          changed = true;
        }
        continue;
      }
      const line = await sellReal(key, plan.shares, plan.all, bid, cfg);
      out.push(`${label}: ${line}`);
      const last = s.notes.filter((x) => x.wallet === p.wallet && x.title === r.title && x.outcome === r.outcome).pop();
      if (last) last.real = line;
    }
    if (changed || out.length) save();
  } finally {
    dueBusy = false;
  }
  return out;
}
/** An order with no clean answer: what it sold is read from our own trades; nothing after PENDING_MS = not filled. */
async function settlePending(key: string, p: Pos, r: EventLiveRow, now: number): Promise<string | null> {
  const pend = p.pending!;
  const got = await turn(async () => {
    const c = await clientOf();
    const trades = await timed(c.getTrades({ asset_id: r.token!, after: String(Math.floor(pend.t / 1000) - 60) }), "reading our trades");
    const f = soldFromTrades(trades as never, pend);
    if (f.shares > 0) {
      delete p.pending;
      return booked(key, Math.min(f.shares, pend.shares), f.usd * Math.min(1, pend.shares / f.shares), p, now, pend.all && f.shares >= pend.shares - 0.011);
    }
    if (now - pend.t > PENDING_MS) {
      delete p.pending;
      return "REAL sale not filled (nothing in our trades after 5 min)";
    }
    return null;
  }).catch((e) => `REAL sale read failed (${e instanceof Error ? e.message.slice(0, 80) : String(e)})`);
  if (got) p.last = got;
  save();
  return got;
}

const DATA_API = "https://data-api.polymarket.com";
/** Shares a wallet still holds of one market side, from Polymarket's positions list; null when it cannot be told. */
export async function walletRemaining(address: string, cond: string, idx: number, get: (url: string) => Promise<unknown> = getJson): Promise<number | null> {
  let cursor = "";
  let known = false;
  for (let page = 0; page < 6; page++) {
    const j = (await get(`${DATA_API}/v2/positions?user=${address}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)) as { data?: Record<string, unknown>[]; pagination?: { next_cursor?: string | null } };
    if (!Array.isArray(j?.data)) return null;
    for (const p of j.data) {
      const c = String(p.condition_id ?? p.conditionId ?? "");
      const i = Number(p.outcome_index ?? p.outcomeIndex);
      if (!/^0x[0-9a-fA-F]{64}$/.test(c) || !(i === 0 || i === 1)) continue;
      known = true;
      if (c.toLowerCase() !== cond.toLowerCase() || i !== idx) continue;
      const size = Number(p.size ?? p.current_size);
      return Number.isFinite(size) && size >= 0 ? size : null;
    }
    cursor = String(j.pagination?.next_cursor ?? "");
    // the whole list was read and the side is not in it: it holds none (only when the rows could be read at all)
    if (!cursor || !j.data.length) return known ? 0 : null;
  }
  return null;
}
async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

/**
 * A copied wallet's trades were read (`cand`: the rows just seen, `rows`: all we have of it, `cand` included). Every
 * new sale of a side we copied is followed: paper at once, real through sellDue. `limit` is how many rows the reading
 * may return (fewer = the wallet's whole list). Returns log lines; never sells the same sale twice.
 */
export async function followSales(wl: { name: string; address: string }, cand: Act[], rows: Act[], now: number, src: string, deps: SellDeps, opt: { real?: string[]; paper?: string[]; limit?: number } = {}): Promise<string[]> {
  const s = state();
  const mine = fillsOf(cand);
  const fresh = newSales(mine, s.seen, wl.name, Math.floor(now / 1000) - SALE_MAX_AGE_S);
  if (!fresh.length) return [];
  const cfg = sellCfg();
  if (!cfg.paper && !cfg.real) return [];
  const realRules = opt.real ?? [`copy-take-${wl.name}`];
  const paperRules = opt.paper ?? [`copy-take-${wl.name}`, `copy-rest-${wl.name}`];
  // marked at once, before anything is awaited: the socket and the reading may both be handling this wallet
  const mark = (xs: Fill[], d: 1 | -1) => {
    for (const f of xs) {
      const k = `${wl.name}|${fkey(f)}`;
      const e = (s.seen[k] ??= { n: 0, ts: f.ts });
      e.n = Math.max(0, e.n + d);
      if (!e.n) delete s.seen[k];
    }
  };
  mark(fresh, 1);
  for (const [k, v] of Object.entries(s.seen)) if (v.ts < now / 1000 - 4 * SALE_MAX_AGE_S) delete s.seen[k];
  const out: string[] = [];
  const all = mergeFills(mine, fillsOf(rows));
  const sides = [...new Set(fresh.map((f) => `${f.cond}|${f.idx}`))];
  let real = false;
  for (const side of sides) {
    const [cond, i] = side.split("|");
    const idx = Number(i);
    const sales = fresh.filter((f) => f.cond === cond && f.idx === idx);
    const realOpen = () => eventLiveRows().filter((r) => r.group === "copy" && realRules.includes(r.rule) && r.pnl == null && r.shares > 0 && r.status !== "resting" && r.conditionId === cond && r.idx === idx);
    const paperOf = (id: string | null) => deps.trades.filter((t) => t.pnl == null && t.shares > 0 && paperRules.includes(t.rule) && t.idx === idx && (t.extra?.cond === cond || (id != null && t.marketId === id)));
    // only a side we hold a copy of is looked up (paper copies carry their condition since 16 Nov 2026)
    if (!realOpen().length && !paperOf(null).length) continue;
    const m = await deps.market(cond).catch(() => undefined);
    if (m === undefined) {
      mark(sales, -1); // no answer: the next reading brings the sale again
      continue;
    }
    if (!m?.id || m.tokens.length !== 2) continue;
    const paper = cfg.paper ? paperOf(m.id) : [];
    if (!realOpen().length && !paper.length) continue;
    s.n.sales += 1;
    const k = keepAfter(all, sales, cond, idx);
    const complete = rows.length < (opt.limit ?? 200) - 10;
    const remaining = k.covered && complete ? null : await (deps.remaining ?? walletRemaining)(wl.address, cond, idx).catch(() => null);
    const factor = shareKept(k, complete, remaining);
    const their = r6(sales.reduce((a, f) => a + f.size * f.price, 0) / sales.reduce((a, f) => a + f.size, 0));
    const first = realOpen()[0] ?? paper[0];
    const n: Note = { t: now, wallet: wl.name, title: first.title, outcome: first.outcome, keptPct: factor == null ? null : Math.round(factor * 1000) / 10, theirC: Math.round(their * 1000) / 10, real: null, paper: 0, src };
    note(n);
    if (factor == null) {
      s.n.unknown += 1;
      n.real = "not followed: the share it sold cannot be told (its buys are older than its trade list)";
      out.push(`${wl.name} ${first.title} ${first.outcome}: sold at ${n.theirC}c, ${n.real}`);
      continue;
    }
    if (paper.length) {
      const bk = await deps.book(m.tokens[idx]).catch(() => null);
      for (const t of paper) {
        const p = paperSell(t, factor, bk?.bids ?? [], cfg, now, their, m.feeRate);
        if (!p) continue;
        if (p.piece) deps.trades.push(p.piece);
        n.paper += 1;
        s.n.paper += 1;
        s.n.paperNet = r6(s.n.paperNet + p.pnl);
      }
    }
    if (cfg.real && cfg.live) {
      for (const r of realOpen()) {
        const p = (s.pos[keyOf(r)] ??= { wallet: wl.name, title: r.title, shares0: r.shares, keep: 1, at: now, their, feeRate: m.feeRate, tries: 0, lastTry: 0 });
        p.keep *= factor;
        p.at = now;
        p.their = their;
        p.feeRate = m.feeRate;
        p.tries = 0;
        p.lastTry = 0;
        real = true;
      }
    } else if (realOpen().length) n.real = cfg.real ? "real trading is off" : "real copies do not follow sales yet (switch off)";
    out.push(`${wl.name} ${first.title} ${first.outcome}: it sold at ${n.theirC}c and keeps ${n.keptPct}%${n.paper ? `; ${n.paper} paper cop${n.paper > 1 ? "ies" : "y"} followed` : ""}`);
  }
  save();
  if (real) out.push(...(await sellDue(deps, now)));
  return out;
}

/** Status: no addresses, tokens or order ids. */
export function copySellStatus() {
  const cfg = sellCfg();
  const s = state();
  const open = Object.values(s.pos);
  return {
    note: "When a copied wallet sells part of a side we copied, we sell the same share. paper = copy-take / copy-rest twins at the bids seen (copy-any stays held to the end, for the comparison). real = fill-and-kill sale on the book; a part under minUsd waits for the wallet's next sale. keptPct = the part of its position the wallet kept through that sale.",
    paper: cfg.paper,
    real: cfg.real && cfg.live,
    minUsd: cfg.minUsd,
    slipC: Math.round(cfg.slip * 1000) / 10,
    salesSeen: s.n.sales,
    shareUnknown: s.n.unknown,
    realSales: { n: s.n.real, shares: r2(s.n.realShares), usd: r2(s.n.realUsd), net: r2(s.n.realNet) },
    paperSales: { n: s.n.paper, net: r2(s.n.paperNet) },
    following: open.length,
    waiting: open.filter((p) => p.pending).length,
    owed: open.filter((p) => !p.pending && p.last).map((p) => ({ wallet: p.wallet, title: p.title, keptPct: Math.round(p.keep * 1000) / 10, why: String(p.last).replace(/0x[0-9a-fA-F]{8,}/g, "0x…").slice(0, 160) })).slice(-10),
    recent: s.notes.slice(-20).reverse().map((x) => ({ ...x, real: x.real ? x.real.replace(/0x[0-9a-fA-F]{8,}/g, "0x…").slice(0, 160) : null })),
  };
}

/** For tests only. */
export const _copySellTest = {
  reset: () => void ((st = blank()), (dueBusy = false)),
  cfg: (c: (SellCfg & { live?: boolean }) | null) => void (cfgTest = c),
  client: (c: unknown) => void (clientTest = c as Client | null),
  state: () => state(),
};

/**
 * SELL OUT ON HIS WORD (25 Nov 2026, enrique: "okay fuck polymarket, transfer that to hyperliquid", then "sell
 * everything that doesnt settle today or tomorrow, move that"): an open real bet is queued for a full sale through the
 * same sale path as a copied wallet's exit (keep 0 = all of it). Called by the open-marks pass for every bet whose
 * market ends after events.copy.exitAfter (a KST day). A queued sale that ran out of tries is queued afresh. Returns
 * true when it was queued now.
 */
export function queueExit(r: EventLiveRow, now: number): boolean {
  const s = state();
  const key = keyOf(r);
  const p = s.pos[key];
  if (p && p.wallet === EXIT && !p.pending && !(now - p.at > DUE_MS || p.tries >= MAX_TRIES)) return false;
  if (p?.pending) return false;
  const den = r.shares * r.ask * (1 - r.ask);
  const feeRate = den > 0 && Number.isFinite(r.fee / den) ? Math.min(0.1, Math.max(0, r.fee / den)) : 0;
  s.pos[key] = { wallet: EXIT, title: r.title, shares0: r.shares, keep: 0, at: now, their: 0, feeRate, tries: 0, lastTry: 0 };
  save();
  return true;
}
export const EXIT = "sell-out (enrique)";
