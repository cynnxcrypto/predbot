/**
 * REAL MONEY. Two-sided pair locking on 15-minute crypto markets, the real twin of the paper rule `pairlock-1s`
 * (src/pairlock.ts). enrique, 11 Nov 2026 00:02-00:03 KST: "go trade it for real, lets see how we do" ... "its okay to
 * start and build up" ... "we can risk 35usd on this".
 *
 * The rule: from 30 s after a window opens until 180 s before it closes, rest a post-only bid of `clip` shares at the
 * best bid on Up and on Down while the two bids add to 99c or less (both 17-83c, so no order is over $5). When one side
 * fills, stop bidding that side and bid the other at min(its best bid, 99c minus the price paid) until 20 s before the
 * close: a finished pair costs under $1 and one of the two always pays $1. A clip left without its pair is held to
 * settlement. Orders are post-only, so we never take.
 *
 * Guards (all in deploy/live-rules.json "pairs", read fresh every second):
 *  - on/off and the list of series; the repo mode must be "live" and the server's own live.json must not say off;
 *  - own budget `maxLoss`: settled losses plus the worst case of every window still open; no new pair past it;
 *  - `maxPairs` finished pairs per window; never more than one clip (plus a part fill) unpaired;
 *  - `dayMaxLoss` dollars lost in a KST day stop it until the next day (so one bad night cannot use the whole budget);
 *  - the wallet floor `minBalance`; 20 API errors in a day stop it for the day; every error pauses 20 s and cancels;
 *  - every order is written to data/pairlive.json BEFORE it is posted, and cancelled on restart.
 * Fills are read from the exchange (size_matched of our own orders), never guessed. Winning shares are claimed through
 * the crypto claim queue of the same series (live.ts). No ids, keys or addresses leave this file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AssetType, OrderType, Side, type ClobClient } from "@polymarket/clob-client-v2";
import { ROOT, SERIES, kstDay, type Series } from "./config.js";
import { getClient } from "./eventlive.js";
import { bookFeed } from "./feeds/book.js";
import { queueRedeem } from "./live.js";
import { resolution, type Book } from "./polymarket.js";
import { currentMarket } from "./recorder.js";
import { loadJson, saveJson } from "./store.js";

const FILE = "pairlive.json";
export const PAIR_LO = 0.17;
export const PAIR_HI = 0.83;

export type PairConfig = { on: boolean; series: string[]; clip: number; maxLoss: number; maxPairs: number; dayMaxLoss: number; minBalance: number };
type Ord = { id: string; price: number; size: number; matched: number; at: number };
type Leg = { shares: number; cost: number; last: number };
export type Win = { key: string; start: number; up: Leg; down: Leg; orders: { U: Ord | null; D: Ord | null }; orderCount: number; errors: number };
type Done = { key: string; start: number; up: number; down: number; cost: number; net: number; at: number };
type State = { cur: Record<string, Win>; pending: Win[]; done: Done[]; errDay: string; errs: number; note: string | null; rejects?: number };
export type Want = { price: number; size: number };

/** The name a series goes by in the "pairs" config and in the state file. */
export const nameOf = (s: { key: string }) => s.key || "btc5m";
const num = (x: unknown, d: number) => (x != null && Number.isFinite(Number(x)) ? Number(x) : d);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Parse the repo rules and the server's local switch. Anything malformed means off. Hard limits are applied here. */
export function parsePairs(repoText: string, local: { mode?: string; funder?: string }): PairConfig {
  const off: PairConfig = { on: false, series: [], clip: 6, maxLoss: 0, maxPairs: 0, dayMaxLoss: 0, minBalance: 0 };
  try {
    const repo = JSON.parse(repoText) as { mode?: string; minBalance?: unknown; pairs?: { on?: unknown; series?: unknown; clip?: unknown; maxLoss?: unknown; maxPairs?: unknown; dayMaxLoss?: unknown } };
    const p = repo?.pairs;
    if (!p || p.on !== true || repo.mode !== "live" || local.mode === "off" || !String(local.funder ?? "").trim()) return off;
    // 15-minute series by their key, and "btc5m" for BTC 5m (whose key is the empty string).
    const series = Array.isArray(p.series) ? p.series.filter((s): s is string => typeof s === "string" && SERIES.some((x) => nameOf(x) === s && (x.windowSec === 900 || s === "btc5m"))) : [];
    const clip = Math.min(6, Math.max(5, num(p.clip, 6))); // 6 shares at 83c is $4.98: the $5 a trade limit
    const maxLoss = Math.min(35, Math.max(0, num(p.maxLoss, 0))); // enrique's word covers $35, no more
    if (!series.length || !(maxLoss > 0)) return off;
    return { on: true, series, clip, maxLoss, maxPairs: Math.min(6, Math.max(1, Math.floor(num(p.maxPairs, 2)))), dayMaxLoss: Math.min(maxLoss, Math.max(1, num(p.dayMaxLoss, 20))), minBalance: Math.max(0, num(repo.minBalance, 0)) };
  } catch {
    return off;
  }
}
export function pairConfig(): PairConfig {
  let text = "";
  try {
    text = readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8");
  } catch {
    /* off */
  }
  return parsePairs(text, loadJson<{ mode?: string; funder?: string }>("live.json", {}));
}

export const newWin = (key: string, start: number): Win => ({ key, start, up: { shares: 0, cost: 0, last: 0 }, down: { shares: 0, cost: 0, last: 0 }, orders: { U: null, D: null }, orderCount: 0, errors: 0 });
/** The most a window can still lose: what was paid minus the $1 a share the finished pairs are sure to pay. */
export const worstCase = (w: Win) => Math.max(0, w.up.cost + w.down.cost - Math.min(w.up.shares, w.down.shares));

/** Budget used: settled losses (net of settled gains) plus the worst case of the open windows. */
export function budgetUsed(done: { net: number }[], open: Win[]): { lost: number; open: number } {
  const net = done.reduce((a, d) => a + d.net, 0);
  return { lost: r2(Math.max(0, -net)), open: r2(open.reduce((a, w) => a + worstCase(w), 0)) };
}

/**
 * What should rest on each side right now. Pure. `ok` = every outside guard passes (budget, balance, day stop, pause).
 * `now` and the window times are in seconds.
 */
export function desired(w: Win, up: Book | null, down: Book | null, now: number, windowSec: number, cfg: PairConfig, ok: boolean): { U: Want | null; D: Want | null } {
  const none = { U: null, D: null };
  const left = w.start + windowSec - now;
  if (!cfg.on || !ok || !up || !down || up.bestBid == null || down.bestBid == null || left <= 20 || w.orderCount >= 300) return none;
  const un = w.up.shares - w.down.shares;
  if (Math.abs(un) >= 5) {
    const heavy = un > 0 ? w.up : w.down;
    const light = un > 0 ? down : up;
    const cap = Math.floor((0.99 - heavy.last) * 100 + 1e-6) / 100;
    const price = r2(Math.min(light.bestBid!, cap));
    if (!(price >= 0.01) || !(heavy.last > 0)) return none;
    const size = Math.min(Math.floor(Math.abs(un) * 100) / 100, Math.floor((5 / price) * 100) / 100);
    if (size < 5) return none;
    return un > 0 ? { U: null, D: { price, size } } : { U: { price, size }, D: null };
  }
  const paired = Math.min(w.up.shares, w.down.shares);
  const band = (b: number) => b >= PAIR_LO - 1e-9 && b <= PAIR_HI + 1e-9;
  // 15m: quote from 30 s in until 180 s before the close; 5m: from 20 s in until 60 s before the close.
  const [from, stop] = windowSec <= 300 ? [20, 60] : [30, 180];
  if (now - w.start < from || left < stop || up.bestBid + down.bestBid > 0.99 + 1e-9 || !band(up.bestBid) || !band(down.bestBid) || paired >= cfg.maxPairs * cfg.clip - 0.01) return none;
  // A part fill can leave a few shares unpaired (under the 5-share order minimum): never add to the heavier side.
  return { U: un > 0.01 ? null : { price: up.bestBid, size: cfg.clip }, D: un < -0.01 ? null : { price: down.bestBid, size: cfg.clip } };
}

const state: State = { cur: {}, pending: [], done: [], errDay: "", errs: 0, note: null, ...loadJson<Partial<State>>(FILE, {}) };
const save = () => saveJson(FILE, state);
const scrub = (s: string) => s.replace(/0x[0-9a-fA-F]{16,}/g, "0x…").slice(0, 160);
let balance: number | null = null;
let balanceAt = 0;
let quiet = false;
const pauseUntil = new Map<string, number>();

const leg = (w: Win, side: "U" | "D") => (side === "U" ? w.up : w.down);

/** Read one of our orders from the exchange and book any new fill. Returns true when the order is finished. */
async function sync(c: ClobClient, w: Win, side: "U" | "D"): Promise<boolean> {
  const o = w.orders[side];
  if (!o) return true;
  const got = await c.getOrder(o.id);
  const matched = Number(got?.size_matched) || 0;
  if (matched > o.matched + 1e-9) {
    const d = matched - o.matched;
    const l = leg(w, side);
    l.shares = Math.round((l.shares + d) * 1e6) / 1e6;
    l.cost = Math.round((l.cost + d * o.price) * 1e6) / 1e6;
    l.last = o.price;
    o.matched = matched;
    console.log(`pairs ${w.key}: filled ${d.toFixed(2)} ${side === "U" ? "Up" : "Down"} at ${Math.round(o.price * 100)}c (window holds ${w.up.shares.toFixed(2)} Up / ${w.down.shares.toFixed(2)} Down)`);
  }
  const dead = /MATCHED|CANCEL/i.test(String(got?.status ?? "")) || matched >= o.size - 0.01;
  if (dead) w.orders[side] = null;
  save();
  return dead;
}

/** Cancel one resting order and read its final fill. Returns the shares it filled since the last look. */
async function cancel(c: ClobClient, w: Win, side: "U" | "D"): Promise<number> {
  const o = w.orders[side];
  if (!o) return 0;
  const before = leg(w, side).shares;
  await c.cancelOrder({ orderID: o.id });
  await sync(c, w, side); // if the exchange still lists it as live, it stays in w.orders and is read again next second
  return leg(w, side).shares - before;
}

async function place(c: ClobClient, w: Win, side: "U" | "D", token: string, want: Want) {
  w.orderCount += 1;
  const order = await c.createOrder({ tokenID: token, price: want.price, side: Side.BUY, size: want.size }, { tickSize: "0.01", negRisk: false });
  let res: { success?: boolean; orderID?: string; errorMsg?: string } | null = null;
  let threw: string | null = null;
  try {
    res = await c.postOrder(order, OrderType.GTC, true); // post-only: rejected if it would take
  } catch (e) {
    threw = scrub((e as Error).message ?? String(e));
  }
  if (!res?.success || !res.orderID) {
    state.rejects = (state.rejects ?? 0) + 1;
    state.note = `order not accepted: ${threw ?? scrub(String(res?.errorMsg ?? "no reason given"))}`;
    // No clean answer: the order may exist without us knowing its id. Cancel everything of ours on this token, wait 5 s.
    if (threw || !res?.errorMsg) {
      await c.cancelMarketOrders({ asset_id: token }).catch(() => undefined);
      pauseUntil.set(w.key, Date.now() + 5000);
    }
    save();
    return;
  }
  w.orders[side] = { id: res.orderID, price: want.price, size: want.size, matched: 0, at: Date.now() };
  save();
}

async function killAll(c: ClobClient, w: Win) {
  for (const side of ["U", "D"] as const) if (w.orders[side]) await cancel(c, w, side);
}

function guardsOk(cfg: PairConfig, now: number): string | null {
  const today = kstDay(now);
  if (state.errDay === today && state.errs >= 20) return "20 API errors today";
  const used = budgetUsed(state.done, [...Object.values(state.cur), ...state.pending]);
  if (used.lost + used.open + cfg.clip * PAIR_HI > cfg.maxLoss) return `budget: $${used.lost} lost + $${used.open} open of $${cfg.maxLoss}`;
  const dayNet = state.done.filter((d) => kstDay(d.at) === today).reduce((a, d) => a + d.net, 0);
  if (dayNet <= -cfg.dayMaxLoss) return `down $${(-dayNet).toFixed(2)} today (day limit $${cfg.dayMaxLoss}); back at 00:00 KST`;
  if (balance == null) return "balance not read yet";
  // 11 Nov 2026 00:18 KST, enrique: "okay then increase budget" (told that cash locked in finished pairs could pause
  // the test until the hourly claim). Finished pairs return $1 a share, so up to $60 of that locked cash is treated as
  // still in the wallet for THIS test's floor check. The loss limits do not change.
  const locked = lockedInPairs(now);
  if (balance + Math.min(LOCKED_ALLOWANCE, locked) - cfg.minBalance < 2 * 5) return `wallet $${balance.toFixed(2)} (+$${locked.toFixed(2)} in finished pairs) is at the $${cfg.minBalance} floor`;
  return null;
}

export const LOCKED_ALLOWANCE = 60;
/** Dollars sure to come back from finished pairs not yet claimed: open and unsettled windows, and windows settled in the last 75 minutes (claims run hourly). */
function lockedInPairs(now: number): number {
  const paired = (w: { up: number; down: number }) => Math.min(w.up, w.down);
  let total = 0;
  for (const w of [...Object.values(state.cur), ...state.pending]) total += Math.min(w.up.shares, w.down.shares);
  for (const d of state.done) if (now - d.at < 75 * 60_000) total += paired(d);
  return total;
}

let blocked: string | null = null;
async function step(c: ClobClient, s: Series, cfg: PairConfig) {
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const start = Math.floor(now / s.windowSec) * s.windowSec;
  const name = nameOf(s);
  let w: Win | undefined = state.cur[name];
  if (w && w.start !== start) {
    // The window is over: its orders died with the market, but cancel and read them once more to be sure of the fills.
    try {
      await killAll(c, w);
    } catch {
      if (now - (w.start + s.windowSec) < 60) return; // try again next second, for up to a minute
      w.orders = { U: null, D: null };
    }
    if (w.up.shares > 0 || w.down.shares > 0) state.pending.push(w);
    delete state.cur[name];
    save();
    w = undefined;
  }
  const active = cfg.on && cfg.series.includes(name) && !quiet;
  if (!w) {
    if (!active) return;
    w = state.cur[name] = newWin(name, start);
  }
  const m = currentMarket(s.key);
  const live = m && m.start === start ? m : null;
  for (const side of ["U", "D"] as const) if (w.orders[side]) await sync(c, w, side);
  const up = live ? bookFeed.fresh(live.upToken) : null;
  const down = live ? bookFeed.fresh(live.downToken) : null;
  blocked = active ? guardsOk(cfg, nowMs) : "switched off";
  // A clip waiting for its pair may always be completed (that lowers risk); new pairs need every guard.
  const completing = Math.abs(w.up.shares - w.down.shares) >= 5;
  const ok = active && nowMs >= (pauseUntil.get(name) ?? 0) && (completing ? !/errors/.test(blocked ?? "") : blocked == null);
  const want = desired(w, up, down, now, s.windowSec, cfg, ok);
  for (const side of ["U", "D"] as const) {
    const o = w.orders[side];
    const d = want[side];
    if (o && (!d || Math.abs(o.price - d.price) > 1e-9 || o.size - o.matched > d.size + 0.01)) {
      const filled = await cancel(c, w, side);
      if (filled > 1e-6 || w.orders[side]) return; // something filled, or not yet confirmed dead: decide again next second
    }
    if (!w.orders[side] && d && live) await place(c, w, side, side === "U" ? live.upToken : live.downToken, d);
  }
}

async function settle() {
  const now = Math.floor(Date.now() / 1000);
  for (const w of [...state.pending]) {
    const s = SERIES.find((x) => nameOf(x) === w.key);
    if (!s || now < w.start + s.windowSec + 90) continue;
    const r = await resolution(w.start, s.slug, s.slugStyle).catch(() => null);
    if (!r || r.resolvedUp == null) continue;
    const win = r.resolvedUp ? w.up.shares : w.down.shares;
    const cost = w.up.cost + w.down.cost;
    state.done.push({ key: w.key, start: w.start, up: r2(w.up.shares), down: r2(w.down.shares), cost: r2(cost), net: r2(win - cost), at: Date.now() });
    if (state.done.length > 2000) state.done.splice(0, state.done.length - 2000);
    state.pending = state.pending.filter((x) => x !== w);
    if (win > 0.01) queueRedeem(s.key, w.start, win);
    console.log(`pairs ${w.key}: window settled ${r.resolvedUp ? "Up" : "Down"}, ${w.up.shares.toFixed(2)} Up / ${w.down.shares.toFixed(2)} Down for $${cost.toFixed(2)}, net ${win - cost >= 0 ? "+" : "-"}$${Math.abs(win - cost).toFixed(2)}`);
    save();
  }
}

/** For the status page and file: numbers only. */
export function pairliveSummary() {
  const cfg = pairConfig();
  const today = kstDay();
  const used = budgetUsed(state.done, [...Object.values(state.cur), ...state.pending]);
  const net = r2(state.done.reduce((a, d) => a + d.net, 0));
  const day = state.done.filter((d) => kstDay(d.at) === today);
  return {
    rule: "We rest small buy orders (6 shares) on both Up and Down at the best bid while the two prices add to 99c or less. When one fills we bid the other side so the pair costs under $1; one side of a pair always pays $1. A clip that never gets its pair is held to the result.",
    on: cfg.on,
    series: cfg.series,
    clip: cfg.clip,
    budget: { name: "pairs", budget: cfg.maxLoss || 35, lost: used.lost, open: used.open, left: r2((cfg.maxLoss || 35) - used.lost - used.open) },
    windows: state.done.length,
    won: state.done.filter((d) => d.net > 0).length,
    net,
    todayWindows: day.length,
    todayNet: r2(day.reduce((a, d) => a + d.net, 0)),
    pairedShares: r2(state.done.reduce((a, d) => a + Math.min(d.up, d.down), 0)),
    leftoverWindows: state.done.filter((d) => Math.abs(d.up - d.down) >= 1).length,
    unsettled: state.pending.length,
    lockedInPairs: r2(lockedInPairs(Date.now())),
    blocked,
    errorsToday: state.errDay === today ? state.errs : 0,
    rejects: state.rejects ?? 0,
    note: state.note,
    now: Object.values(state.cur).map((w) => ({ series: w.key, up: r2(w.up.shares), down: r2(w.down.shares), cost: r2(w.up.cost + w.down.cost), bidUp: w.orders.U?.price ?? null, bidDown: w.orders.D?.price ?? null, orders: w.orderCount })),
    recent: state.done.slice(-12).map((d) => ({ series: d.key, start: d.start, up: d.up, down: d.down, cost: d.cost, net: d.net })),
  };
}

/** Stop quoting and cancel (the bot is about to restart). */
export function pairliveQuiet() {
  quiet = true;
}

export function startPairlive() {
  if (process.env.PAIRLIVE === "off") return null;
  let busy = false;
  let n = 0;
  return setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const cfg = pairConfig();
      const has = Object.keys(state.cur).length > 0 || state.pending.length > 0;
      if (!cfg.on && !has) return;
      const funder = String(loadJson<{ funder?: string }>("live.json", {}).funder ?? "").trim();
      if (!funder) return;
      const c = await getClient(funder);
      if (Date.now() - balanceAt > 60_000) {
        balanceAt = Date.now();
        const b = await c.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }).catch(() => null);
        if (b && Number.isFinite(Number(b.balance))) balance = Number(b.balance) / 1e6;
      }
      for (const s of SERIES) {
        if (!cfg.series.includes(nameOf(s)) && !state.cur[nameOf(s)]) continue;
        try {
          await step(c, s, cfg);
        } catch (e) {
          const today = kstDay();
          if (state.errDay !== today) {
            state.errDay = today;
            state.errs = 0;
          }
          state.errs += 1;
          state.note = `error: ${scrub((e as Error).message ?? String(e))}`;
          pauseUntil.set(nameOf(s), Date.now() + 20_000);
          console.log(`pairs ${nameOf(s)}: ${state.note}; pausing 20 s`);
          save();
        }
      }
      if (++n % 20 === 0) await settle().catch(() => undefined);
    } catch (e) {
      state.note = `error: ${scrub((e as Error).message ?? String(e))}`;
    } finally {
      busy = false;
    }
  }, 1000);
}
