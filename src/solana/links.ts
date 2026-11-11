/**
 * READ-ONLY: the tracer. enrique, 11 Nov 2026 17:57 KST: famous traders on the fomo app "buy from other wallets
 * first and then they buy from their fomo wallet and then it pumps", so find "what wallets are the most likely to
 * be theirs, based on receiving funding from them constantly". For each public wallet in seeds.ts it reads the
 * chain (Helius getTransactionsForAddress) and collects two kinds of evidence:
 *   - MONEY: wallets the seed sends SOL, dollars or coins to, or receives them from, in plain transfers (not
 *     trades), and one step further (seed -> wallet -> wallet);
 *   - TIMING: wallets that started holding the same coin in the half hour BEFORE the seed bought it, on several
 *     different coins, and whether they sold after the seed's buy.
 * Every wallet that shows up is then read itself: how busy it is (an exchange, a relayer or a bot is set aside),
 * how many coins it shares with the seed, and on how many of them it bought first.
 *
 * fomo trades are signed and paid for by fomo's own relayer and mostly paid in USDC, so nothing here relies on the
 * fee payer or on SOL being spent: everything is read from balance changes by owner.
 *
 * A well-known wallet is flooded with coins that strangers drop on it (first pass, 11 Nov 2026: 3,000 transactions
 * of a seed reached back 5 hours to 3 days and held 0 to 5 of its own buys). So a wallet is read three ways and the
 * results merged: what names the wallet itself (its own transfers and trades), what touched its dollar accounts
 * (every dollar-paid trade, deposit and withdrawal, and no dropped coin), and only a short stretch of everything
 * that touched any of its token accounts. A coin received for nothing is not counted as a money link.
 *
 * Second pass, 11 Nov 2026: the dollar account of a well-known fomo trader is busy too (many small payments in), so
 * 3,000 of its transactions stopped short of the 30 days while the status said 30. Now the pages are read one at a
 * time and only what the wallet did is kept, so a read can go ten times deeper; the status says how far each read
 * really got (daysRead) and how old the buys it found are (buysFromDaysAgo). daysCovered is the shorter of the two
 * reads. A candidate that turns out to be an exchange or a bot is not read past its first pages.
 *
 * This is evidence, not proof of who owns a wallet. The public status carries short tags only; the full addresses
 * stay in data/solana/wallet-links.json on the server. "Likely" and "possible" wallets are handed to the PAPER copy
 * test (never the real one). Nothing is sent. SOLANA_LINKS=off disables.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../config.js";
import { USDT } from "./copy.js";
import { makeReader, refused, scrub, type Item, type Page } from "./history.js";
import { SOL, USDC } from "./pools.js";
import { SEEDS } from "./seeds.js";
import { validAddress, type Tracked } from "./wallets.js";

export const DAYS_BACK = 30;
export const MIN_SOL = 0.05;
export const MIN_USD = 5;
/** more transactions a day than this is an exchange, a relayer or a bot, not somebody's side wallet */
export const BOT_TX_DAY = 1000;
const SLOT_SEC = 0.4;
const PRE_SLOTS = 4500; // half an hour before the seed's buy
const POST_SLOTS = 750; // five minutes after it
const NEAR_SLOTS = 75; // 30 s: the wave around the seed's own buy
const HOUR_SLOTS = 9000;
/** x100 transactions. seed = what names a seed wallet, deep = each of its dollar accounts, cand = either, for a candidate */
const depth = { seed: 100, deep: 150, cand: 10 };
const BUSY_PAGES = 3; // a candidate this many pages in and plainly a service is not read further
const TOK_PAGES = 3; // the short stretch of everything that touched its token accounts (mostly dropped coins)
/** a single plain transfer this large is a money link by itself */
const BIG_USD = 10_000;
const BIG_SOL = 50;
/** a result made by an older way of reading is read again */
const VERSION = 3;
const PRE_PAGES = 4;
const POST_PAGES = 2;
const MAX_BUYS = 40;
const MONEY_MAX = 8;
const EARLY_MAX = 8;
const STEP2_MAX = 8;
const REFRESH_MS = 24 * 3_600_000;
const CREDITS_DAY = Math.max(1000, Number(process.env.SOLANA_LINKS_CREDITS_DAY) || 300_000);
/** fomo's own accounts (its relayer signs every user's trade, its fee wallet is paid on each): never a person */
const SERVICE = new Set(["AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51", "R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX"]);
const STABLE = new Set([USDC, USDT]);

interface TokBal {
  accountIndex?: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { uiAmountString?: string; uiAmount?: number | null };
}
const ui = (b: TokBal) => Number(b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount ?? 0) || 0;
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r2 = (x: number) => Math.round(x * 100) / 100;
const tag = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
type At = { slot: number; index: number };
const earlier = (a: At, b: At) => a.slot < b.slot || (a.slot === b.slot && a.index < b.index);

// ---- reading one transaction -----------------------------------------------------------------------------------
export interface Move {
  /** true = the wallet sent it, false = the wallet received it */
  out: boolean;
  address: string;
  sol: number;
  usd: number;
  /** set when a coin itself was passed on */
  mint?: string;
}
export interface Act {
  slot: number;
  index: number;
  t: number;
  buy?: { mint: string; sol: number; usd: number };
  sell?: string;
  moves: Move[];
}

/**
 * What one transaction did for `wallet`: a buy (one coin received, SOL or dollars paid), a sale, or a plain
 * transfer to or from other wallets (only one thing moved and nothing came back for it). Read from balance changes
 * by owner, so it does not matter who signed or paid the fee.
 */
export function actOf(it: Item, wallet: string): Act | null {
  const m = it.meta;
  if (!m || m.err || !m.preBalances?.length || !m.postBalances?.length) return null;
  const keys = it.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  if (keys.length < m.preBalances.length) keys.push(...(m.loadedAddresses?.writable ?? []), ...(m.loadedAddresses?.readonly ?? []));
  const lam = m.preBalances.map((p, j) => (m.postBalances[j] - p + (j === 0 ? m.fee : 0)) / 1e9);
  const tok = new Map<string, Map<string, number>>(); // owner -> mint -> change
  const add = (b: TokBal, sign: number) => {
    if (!b.owner) return;
    let o = tok.get(b.owner);
    if (!o) tok.set(b.owner, (o = new Map()));
    o.set(b.mint, (o.get(b.mint) ?? 0) + sign * ui(b));
  };
  for (const b of (m.postTokenBalances ?? []) as TokBal[]) add(b, 1);
  for (const b of (m.preTokenBalances ?? []) as TokBal[]) add(b, -1);
  const i = keys.indexOf(wallet);
  const mine = tok.get(wallet) ?? new Map<string, number>();
  if (i < 0 && !mine.size) return null;
  const stable = (o: Map<string, number> | undefined) => (o ? [...STABLE].reduce((a, s) => a + (o.get(s) ?? 0), 0) : 0);
  const dSol = (i >= 0 ? lam[i] : 0) + (mine.get(SOL) ?? 0);
  const dUsd = stable(mine);
  const coins = [...mine].filter(([mint, x]) => mint !== SOL && !STABLE.has(mint) && Math.abs(x) > 1e-9);
  const ups = coins.filter(([, x]) => x > 0);
  const downs = coins.filter(([, x]) => x < 0);
  const act: Act = { slot: it.slot, index: it.transactionIndex, t: it.blockTime ?? 0, moves: [] };
  const paid = dSol < -0.005 || dUsd < -0.5;
  const gotPaid = dSol > 0.005 || dUsd > 0.5;
  if (ups.length === 1 && !downs.length && paid) act.buy = { mint: ups[0][0], sol: r2(Math.max(0, -dSol)), usd: r2(Math.max(0, -dUsd)) };
  else if (downs.length === 1 && !ups.length && gotPaid) act.sell = downs[0][0];
  else if (!coins.length && Math.abs(dSol) >= MIN_SOL && Math.abs(dUsd) < 0.5) {
    // only SOL moved
    if (dSol < 0) {
      for (let j = 0; j < lam.length; j++) if (j !== i && lam[j] >= Math.max(0.02, 0.2 * -dSol)) act.moves.push({ out: true, address: keys[j], sol: r2(lam[j]), usd: 0 });
    } else {
      let from = -1;
      for (let j = 0; j < lam.length; j++) if (j !== i && (from < 0 || lam[j] < lam[from])) from = j;
      if (from >= 0 && lam[from] <= -0.8 * dSol) act.moves.push({ out: false, address: keys[from], sol: r2(dSol), usd: 0 });
    }
  } else if (!coins.length && Math.abs(dUsd) >= MIN_USD && Math.abs(dSol) < 0.02) {
    // only dollars moved
    for (const [owner, o] of tok) {
      if (owner === wallet) continue;
      const x = stable(o);
      if (dUsd < 0 ? x >= 0.2 * -dUsd : x <= -0.8 * dUsd) act.moves.push({ out: dUsd < 0, address: owner, sol: 0, usd: r2(dUsd < 0 ? x : dUsd) });
    }
  } else if (coins.length === 1 && Math.abs(dSol) < 0.005 && Math.abs(dUsd) < 0.5) {
    // a coin was passed on and nothing was paid for it
    const [mint, x] = coins[0];
    for (const [owner, o] of tok) {
      if (owner === wallet) continue;
      const y = o.get(mint) ?? 0;
      if (x < 0 ? y >= 0.8 * -x : y <= 0.8 * -x) act.moves.push({ out: x < 0, address: owner, sol: 0, usd: 0, mint });
    }
  }
  return act.buy || act.sell || act.moves.length ? act : null;
}

/**
 * Who started holding the coin in this transaction (from none to some: a pool never does, it always holds some),
 * and who holds less of it afterwards.
 */
export function holders(it: Item, mint: string): { got: string[]; cut: string[] } {
  const m = it.meta;
  if (!m || m.err) return { got: [], cut: [] };
  const pre = new Map<string, number>();
  const post = new Map<string, number>();
  for (const b of (m.preTokenBalances ?? []) as TokBal[]) if (b.mint === mint && b.owner) pre.set(b.owner, (pre.get(b.owner) ?? 0) + ui(b));
  for (const b of (m.postTokenBalances ?? []) as TokBal[]) if (b.mint === mint && b.owner) post.set(b.owner, (post.get(b.owner) ?? 0) + ui(b));
  return {
    got: [...post].filter(([o, x]) => x > 0 && !(pre.get(o) ?? 0)).map(([o]) => o),
    cut: [...pre].filter(([o, x]) => x > 0 && (post.get(o) ?? 0) < x * (1 - 1e-9)).map(([o]) => o),
  };
}

/** Around one buy of the seed: who started holding the coin before it (and sold after it), and the wave either side. */
export function earlyOf(lead: At & { wallet: string; mint: string }, pre: Item[], post: Item[]) {
  const at = (it: Item): At => ({ slot: it.slot, index: it.transactionIndex });
  const early = new Map<string, { leadSlots: number; sold: boolean }>();
  const before = new Set<string>();
  const after = new Set<string>();
  for (const it of pre) {
    if (!earlier(at(it), lead)) continue;
    for (const w of holders(it, lead.mint).got) {
      if (w === lead.wallet) continue;
      const leadSlots = lead.slot - it.slot;
      const e = early.get(w);
      if (!e || leadSlots > e.leadSlots) early.set(w, { leadSlots, sold: false });
      if (leadSlots <= NEAR_SLOTS) before.add(w);
    }
  }
  for (const it of post) {
    if (!earlier(lead, at(it))) continue;
    const h = holders(it, lead.mint);
    for (const w of h.cut) {
      const e = early.get(w);
      if (e) e.sold = true;
    }
    if (it.slot - lead.slot <= NEAR_SLOTS) for (const w of h.got) if (w !== lead.wallet) after.add(w);
  }
  return { early, before30: before.size, after30: after.size };
}

// ---- one wallet's history -----------------------------------------------------------------------------------------
export interface Cp {
  out: number;
  in: number;
  sol: number;
  usd: number;
  coins: number;
}
export interface WalletRead {
  txs: number;
  days: number;
  txPerDay: number;
  /** first buy and first later sale of each coin */
  buys: Map<string, At & { t: number; sol: number; usd: number }>;
  sells: Map<string, At>;
  /** plain transfers by the other side */
  cps: Map<string, Cp>;
}

/** The wallet's own token accounts for these mints, as the transactions name them (a balance carries its account's place in the key list). */
export function tokenAccountsOf(items: Item[], wallet: string, mints: Set<string>): string[] {
  const out = new Set<string>();
  for (const it of items) {
    const m = it.meta;
    if (!m) continue;
    const keys = it.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
    if (keys.length < (m.preBalances?.length ?? 0)) keys.push(...(m.loadedAddresses?.writable ?? []), ...(m.loadedAddresses?.readonly ?? []));
    for (const b of [...(m.preTokenBalances ?? []), ...(m.postTokenBalances ?? [])] as TokBal[]) {
      const a = typeof b.accountIndex === "number" ? keys[b.accountIndex] : undefined;
      if (b.owner === wallet && mints.has(b.mint) && a && validAddress(a)) out.add(a);
    }
  }
  return [...out];
}

/** `days` = the stretch the transactions cover; `txs` = how many of them count toward how busy the wallet is. */
export function digest(wallet: string, items: Item[], days: number, txs = items.length): WalletRead {
  return digestActs(wallet, items.map((it) => actOf(it, wallet)).filter((a): a is Act => !!a), days, txs);
}
/** The same from what the wallet did in each transaction (see actOf), in any order. */
export function digestActs(wallet: string, acts: Act[], days: number, txs: number): WalletRead {
  const r: WalletRead = { txs, days, txPerDay: txs / Math.max(days, 1 / 24), buys: new Map(), sells: new Map(), cps: new Map() };
  for (const a of [...acts].sort((x, y) => x.slot - y.slot || x.index - y.index)) {
    if (a.buy && !r.buys.has(a.buy.mint)) r.buys.set(a.buy.mint, { slot: a.slot, index: a.index, t: a.t, sol: a.buy.sol, usd: a.buy.usd });
    if (a.sell && r.buys.has(a.sell) && !r.sells.has(a.sell)) r.sells.set(a.sell, { slot: a.slot, index: a.index });
    for (const mv of a.moves) {
      if (mv.address === wallet || !validAddress(mv.address)) continue;
      if (mv.mint && !mv.out) continue; // a coin that arrived for nothing: strangers drop these on well-known wallets
      let c = r.cps.get(mv.address);
      if (!c) r.cps.set(mv.address, (c = { out: 0, in: 0, sol: 0, usd: 0, coins: 0 }));
      if (mv.out) c.out++;
      else c.in++;
      c.sol = r2(c.sol + mv.sol);
      c.usd = r2(c.usd + mv.usd);
      if (mv.mint) c.coins++;
    }
  }
  return r;
}

/** How a wallet's buys line up with the seed's: coins both bought, who was first, and whether it sold into the seed's buy. */
export function compare(seed: WalletRead, cand: WalletRead) {
  let shared = 0;
  let before = 0;
  let after = 0;
  let soldInto = 0;
  let near = 0;
  const leads: number[] = [];
  for (const [mint, s] of seed.buys) {
    const c = cand.buys.get(mint);
    if (!c) continue;
    shared++;
    if (earlier(c, s)) {
      before++;
      leads.push((s.slot - c.slot) * SLOT_SEC);
      if (s.slot - c.slot <= HOUR_SLOTS) near++;
      const out = cand.sells.get(mint);
      if (out && earlier(s, out) && out.slot - s.slot <= PRE_SLOTS) soldInto++;
    } else after++;
  }
  const med = median(leads);
  return { shared, before, beforeWithin1h: near, after, soldInto, medianLeadSec: med === null ? null : Math.round(med), overlapPct: cand.buys.size ? Math.round((shared / cand.buys.size) * 100) : null };
}

export function judge(x: { transfers: number; big?: boolean; twoStep: boolean; before: number; after: number; overlapPct: number | null; txPerDay: number; seeds: number }): string {
  if (x.txPerDay > BOT_TX_DAY || x.seeds >= 3) return "service or bot";
  const money = x.transfers >= 2 || x.twoStep || !!x.big;
  const ahead = x.before >= 3 && x.before >= 2 * x.after;
  if (money && ahead) return "likely";
  if (ahead && x.before >= 5 && (x.overlapPct ?? 0) >= 20) return "possible: buys ahead, no money link";
  if (money && x.before >= 1 && x.before >= x.after) return "possible: money link, few shared coins";
  if (money) return "money link only";
  return "no sign";
}

// ---- runner -------------------------------------------------------------------------------------------------------
export interface Linked {
  address: string;
  /** "money", "timing", or "money, 2 steps" (through `through`) */
  how: string;
  through?: string;
  /** plain transfers with the seed (or with the wallet in between): the seed sent / received, and how much */
  sent: number;
  received: number;
  sol: number;
  usd: number;
  coinsPassed: number;
  /** coins it started holding in the half hour before the seed bought them, from the coins' own records */
  earlyCoins: number;
  earlySold: number;
  /** from its own record: coins both bought, on how many it was first / second, seconds ahead, sold after the seed's buy */
  shared: number;
  before: number;
  /** of `before`, bought within the hour before the seed did */
  beforeWithin1h: number;
  after: number;
  soldInto: number;
  medianLeadSec: number | null;
  overlapPct: number | null;
  txPerDay: number;
}
interface SeedResult {
  v: number;
  doneAt: number;
  /** transactions read: naming the wallet / touching its dollar accounts / the short stretch of all its token accounts */
  read: [number, number, number];
  /** how many days back the read naming the wallet got, and the read of its dollar accounts (null = it has none) */
  reach?: [number, number | null];
  /** how many days ago its newest and its oldest buy in the read were */
  span?: [number, number] | null;
  txs: number;
  days: number;
  buys: number;
  buysUsd: number;
  buysSol: number;
  checked: number;
  /** other new holders in the 30 s before / after the seed's own buys (medians) */
  before30: number | null;
  after30: number | null;
  linked: Linked[];
}
interface State {
  day: string;
  credits: number;
  seeds: Record<string, SeedResult>;
}
const FILE = () => join(DATA, "solana", "wallet-links.json");
let state: State = { day: "", credits: 0, seeds: {} };
const health = { state: "off", calls: 0, errors: 0, lastError: "", working: "" };
let stopped = true;
let cfg: { rpcUrl: () => string | null; fetch: () => typeof fetch } | null = null;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function save() {
  try {
    mkdirSync(join(DATA, "solana"), { recursive: true });
    writeFileSync(FILE() + ".tmp", JSON.stringify(state));
    renameSync(FILE() + ".tmp", FILE());
  } catch {
    /* next time */
  }
}
function today() {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== state.day) {
    state.day = d;
    state.credits = 0;
  }
}
const page = makeReader({
  url: () => cfg?.rpcUrl(),
  fetch: () => cfg!.fetch(),
  canSpend: () => (today(), state.credits < CREDITS_DAY),
  spent: (c) => (state.credits += c),
  called: () => health.calls++,
});

/** The seeds: the built-in list, or data/solana-seeds.json when it exists. */
function seeds(): Tracked[] {
  let list = SEEDS;
  try {
    list = JSON.parse(readFileSync(join(DATA, "solana-seeds.json"), "utf8")) as Tracked[];
  } catch {
    /* built-in list */
  }
  return list.filter((w) => validAddress(w.address));
}

interface Reach {
  n: number;
  /** true = stopped at the page limit, so there is more further back */
  more: boolean;
  oldest: number | null;
}
/**
 * Pages of a filter, handed on one at a time and not kept, up to `max` (or until `enough` says so). null = out of
 * credit for today, or stopped.
 */
async function scan(address: string, filters: Record<string, unknown>, order: "asc" | "desc", max: number, each: (items: Item[]) => void, enough?: (r: Reach) => boolean): Promise<Reach | null> {
  const r: Reach = { n: 0, more: false, oldest: null };
  let token: string | null = null;
  for (let p = 0; p < max; p++) {
    if (stopped) return null;
    const pg: Page = await page(address, filters, order, token);
    if (!pg) return null;
    r.n += pg.data.length;
    for (const it of pg.data) if (it.blockTime != null && (r.oldest === null || it.blockTime < r.oldest)) r.oldest = it.blockTime;
    each(pg.data);
    token = pg.paginationToken;
    if (!token || !pg.data.length) return r;
    if (enough?.(r)) break;
  }
  r.more = true;
  return r;
}
/** All pages of a filter, kept, up to `max`. null = out of credit for today. */
async function pages(address: string, filters: Record<string, unknown>, order: "asc" | "desc", max: number): Promise<{ items: Item[]; more: boolean } | null> {
  const items: Item[] = [];
  const r = await scan(address, filters, order, max, (xs) => items.push(...xs));
  return r && { items, more: r.more };
}

type Read = WalletRead & { read: [number, number, number]; reach: [number, number | null] };
const reads = new Map<string, Read>();
const sigOf = (it: Item) => it.transaction.signatures?.[0] ?? `${it.slot}:${it.transactionIndex}`;
/**
 * One wallet, read three ways (see the note at the top) and merged: what names it, a short stretch of everything
 * that changed a token balance it owns, and its dollar accounts (a trade that fomo's relayer signs need not name
 * the wallet at all). Only what the wallet did in each transaction is kept. `quick` = a candidate: stop once it is
 * plainly an exchange, a relayer or a bot. null = out of credit for today.
 */
async function readWallet(address: string, ownPages: number, deepPages: number, quick = false): Promise<Read | null> {
  const hit = reads.get(address);
  if (hit) return hit;
  const now = Math.floor(Date.now() / 1000);
  const since = now - DAYS_BACK * 86_400;
  const seen = new Set<string>();
  const acts: Act[] = [];
  const accounts = new Set<string>();
  const take = (items: Item[]) => {
    for (const it of items) {
      const k = sigOf(it);
      if (seen.has(k)) continue;
      seen.add(k);
      const a = actOf(it, address);
      if (a) acts.push(a);
    }
    for (const a of tokenAccountsOf(items, address, STABLE)) accounts.add(a);
  };
  // how far back a read got: to the start of the window when it was read to its end, else to its oldest transaction
  const daysOf = (r: Reach) => (now - (r.more ? (r.oldest ?? now) : since)) / 86_400;
  const rate = (r: Reach) => r.n / Math.max(daysOf(r), 1 / 24);
  const busy = (r: Reach) => quick && r.n >= BUSY_PAGES * 100 && rate({ ...r, more: true }) > BOT_TX_DAY;
  const own = await scan(address, { blockTime: { gt: since } }, "desc", ownPages, take, busy);
  if (!own) return null;
  let tokN = 0;
  let dollarN = 0;
  let dollarDays: number | null = null;
  if (!(quick && rate(own) > BOT_TX_DAY)) {
    const tok = await scan(address, { blockTime: { gt: since }, tokenAccounts: "balanceChanged" }, "desc", TOK_PAGES, take);
    if (!tok) return null;
    tokN = tok.n;
    for (const acc of [...accounts].slice(0, 2)) {
      const d = await scan(acc, { blockTime: { gt: since } }, "desc", deepPages, take);
      if (!d) return null;
      dollarN += d.n;
      dollarDays = Math.min(dollarDays ?? Infinity, daysOf(d));
    }
  }
  const ownDays = daysOf(own);
  // what can be said for sure: a SOL-paid trade names the wallet, a dollar-paid one touches its dollar account
  const days = dollarDays === null ? ownDays : Math.min(ownDays, dollarDays);
  const r: Read = { ...digestActs(address, acts, days, own.n), read: [own.n, dollarN, tokN], reach: [ownDays, dollarDays] };
  // how busy it is: by what names the wallet itself (dropped coins and fomo's relayer say nothing about that)
  r.txPerDay = rate(own);
  reads.set(address, r);
  return r;
}

async function doSeed(seed: Tracked): Promise<SeedResult | null> {
  const s = await readWallet(seed.address, depth.seed, depth.deep);
  if (!s) return null;
  const now = Math.floor(Date.now() / 1000);
  const buys = [...s.buys].filter(([, b]) => b.t < now - 600).sort((a, b) => b[1].slot - a[1].slot).slice(0, MAX_BUYS);
  // TIMING: who started holding each coin before the seed did
  const tally = new Map<string, { coins: number; sold: number }>();
  const b30: number[] = [];
  const a30: number[] = [];
  for (const [mint, b] of buys) {
    if (stopped) return null;
    const pre = await pages(mint, { slot: { gte: b.slot - PRE_SLOTS, lte: b.slot } }, "desc", PRE_PAGES);
    if (!pre) return null;
    const post = await pages(mint, { slot: { gte: b.slot, lte: b.slot + POST_SLOTS } }, "asc", POST_PAGES);
    if (!post) return null;
    const e = earlyOf({ wallet: seed.address, mint, slot: b.slot, index: b.index }, pre.items, post.items);
    for (const [w, x] of e.early) {
      let t = tally.get(w);
      if (!t) tally.set(w, (t = { coins: 0, sold: 0 }));
      t.coins++;
      if (x.sold) t.sold++;
    }
    b30.push(e.before30);
    a30.push(e.after30);
  }
  const ok = (a: string) => a !== seed.address && !SERVICE.has(a) && validAddress(a);
  const n = (c: Cp) => c.out + c.in;
  const worth = (c: Cp) => c.usd + c.sol * 150; // rough dollars, only to put the biggest flows first
  // MONEY: repeated or large plain transfers
  const money = [...s.cps].filter(([a, c]) => ok(a) && (n(c) >= 2 || c.sol >= 5 || c.usd >= 500)).sort((a, b) => worth(b[1]) - worth(a[1]) || n(b[1]) - n(a[1])).slice(0, MONEY_MAX);
  const early = [...tally].filter(([a, t]) => ok(a) && t.coins >= 3).sort((a, b) => b[1].coins - a[1].coins).slice(0, EARLY_MAX);
  const linked = new Map<string, Linked>();
  const row = async (address: string, how: string, c: Cp | undefined, through?: string): Promise<WalletRead | null | undefined> => {
    if (linked.has(address)) return undefined;
    const r = await readWallet(address, depth.cand, depth.cand, true);
    if (!r) return null;
    const t = tally.get(address);
    linked.set(address, {
      address, how, ...(through ? { through } : {}),
      // seen from the seed's side: `out` is what the seed (or the wallet in between) sent to it
      sent: c?.out ?? 0, received: c?.in ?? 0, sol: c?.sol ?? 0, usd: c?.usd ?? 0, coinsPassed: c?.coins ?? 0,
      earlyCoins: t?.coins ?? 0, earlySold: t?.sold ?? 0,
      ...compare(s, r), txPerDay: Math.round(r.txPerDay),
    });
    return r;
  };
  let step2 = 0;
  for (const [a, c] of money) {
    if (stopped) return null;
    const r = await row(a, "money", c);
    if (r === null) return null;
    if (!r || r.txPerDay > BOT_TX_DAY) continue;
    // one step further: where that wallet's money goes, when it is a quiet wallet and not a service
    const next = [...r.cps].filter(([x, k]) => ok(x) && n(k) >= 2 && !linked.has(x)).sort((x, y) => n(y[1]) - n(x[1])).slice(0, 3);
    for (const [x, k] of next) {
      if (step2 >= STEP2_MAX) break;
      step2++;
      if ((await row(x, "money, 2 steps", k, a)) === null) return null;
    }
  }
  for (const [a] of early) {
    if (stopped) return null;
    const have = linked.get(a);
    if (have) continue;
    if ((await row(a, "timing", s.cps.get(a))) === null) return null;
  }
  const bought = [...s.buys.values()];
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const ago = bought.map((b) => (now - b.t) / 86_400);
  return {
    v: VERSION, doneAt: Date.now(), read: s.read, reach: [r1(s.reach[0]), s.reach[1] === null ? null : r1(s.reach[1])],
    span: ago.length ? [r1(Math.min(...ago)), r1(Math.max(...ago))] : null,
    txs: s.txs, days: r1(s.days), buys: bought.length,
    buysUsd: bought.filter((b) => b.usd > 0).length, buysSol: bought.filter((b) => b.usd === 0).length,
    checked: buys.length, before30: median(b30), after30: median(a30), linked: [...linked.values()],
  };
}

async function loop() {
  while (!stopped) {
    let did = false;
    for (const w of seeds()) {
      if (stopped) return;
      const st = state.seeds[w.address];
      if (st && st.v === VERSION && Date.now() - st.doneAt < REFRESH_MS) continue;
      health.working = w.name;
      try {
        const r = await doSeed(w);
        if (!r) {
          health.state = cfg?.rpcUrl() ? "resting until tomorrow (daily credit cap)" : "waiting for the Helius key";
          break;
        }
        state.seeds[w.address] = r;
        health.state = "reading";
        did = true;
        save();
      } catch (e) {
        health.errors++;
        health.lastError = scrub(String((e as Error).message));
        if (refused(health.lastError)) {
          health.state = "refused by the plan";
          return;
        }
        await sleep(10_000);
      }
    }
    health.working = "";
    reads.clear();
    if (!did && (health.state === "reading" || health.state === "starting")) health.state = "up to date";
    await sleep(did ? 5000 : 60_000);
  }
}

export function startLinks(c: NonNullable<typeof cfg>) {
  if (process.env.SOLANA_LINKS === "off" || !stopped) return;
  stopped = false;
  cfg = c;
  try {
    state = { ...state, ...(JSON.parse(readFileSync(FILE(), "utf8")) as State) };
  } catch {
    /* first run */
  }
  health.state = "starting";
  void loop();
}
export function stopLinks() {
  if (stopped) return;
  stopped = true;
  save();
}

const ORDER = ["likely", "possible: buys ahead, no money link", "possible: money link, few shared coins", "money link only", "no sign", "service or bot"];
/** Every linked wallet with its verdict, strongest first. A wallet tied to 3+ seeds is a shared service, not a person. */
function judged() {
  const names = new Map(seeds().map((w) => [w.address, w.name]));
  const tied = new Map<string, number>();
  for (const [a, r] of Object.entries(state.seeds)) if (names.has(a)) for (const l of r.linked) tied.set(l.address, (tied.get(l.address) ?? 0) + 1);
  return Object.entries(state.seeds).filter(([a]) => names.has(a)).map(([a, r]) => ({
    name: names.get(a)!, address: a, r,
    linked: r.linked
      .map((l) => ({ ...l, verdict: judge({ transfers: l.sent + l.received, big: l.usd >= BIG_USD || l.sol >= BIG_SOL, twoStep: l.how === "money, 2 steps", before: l.before, after: l.after, overlapPct: l.overlapPct, txPerDay: l.txPerDay, seeds: tied.get(l.address) ?? 1 }) }))
      .sort((x, y) => ORDER.indexOf(x.verdict) - ORDER.indexOf(y.verdict) || y.before - x.before || y.sent + y.received - (x.sent + x.received)),
  }));
}

/** Wallets worth watching on paper: the likely and possible ones. */
export function linkedWallets(): Tracked[] {
  const out: Tracked[] = [];
  for (const s of judged()) for (const l of s.linked) if (/^(likely|possible)/.test(l.verdict) && !out.some((w) => w.address === l.address)) out.push({ name: `side of ${s.name} ${l.address.slice(0, 4)}`, address: l.address, found: true });
  return out.slice(0, 40);
}

/** Public: short tags only, never a full address of a linked wallet. */
export function linksSummary() {
  const all = judged();
  return {
    note: `For each seed wallet (public fomo traders): MONEY = plain transfers of SOL, dollars or coins with another wallet, also one step further; TIMING = wallets that started holding the same coin in the half hour before the seed bought it, on 3+ coins. Each such wallet is then read itself: shared = coins both bought, before = it bought first (beforeWithin1h: within the hour before), soldInto = it sold within half an hour after the seed's buy, overlapPct = share of its own coins that the seed also bought. "likely" = a money link AND first on 3+ shared coins (twice as often as second). A money link = 2+ plain transfers, or one of $${BIG_USD}+ or ${BIG_SOL}+ SOL. Evidence, not proof of ownership. Looks back up to ${DAYS_BACK} days: daysRead says how far the read naming the wallet and the read of its dollar accounts each got, daysCovered is the shorter of the two, buysFromDaysAgo is how old its newest and oldest buy in the read are. transactionsRead = [naming the wallet, touching its dollar accounts, a short stretch of all its token accounts]; a coin received for nothing is not a money link. Wallets shown as short tags.`,
    state: health.state,
    working: health.working,
    seedsDone: all.length,
    seedsTotal: seeds().length,
    likely: all.reduce((a, s) => a + s.linked.filter((l) => l.verdict === "likely").length, 0),
    possible: all.reduce((a, s) => a + s.linked.filter((l) => l.verdict.startsWith("possible")).length, 0),
    seeds: all.map((s) => ({
      name: s.name, address: s.address, redo: s.r.v !== VERSION, transactionsRead: s.r.read ?? null, daysCovered: s.r.days, daysRead: s.r.reach ? { own: s.r.reach[0], dollar: s.r.reach[1] } : null, buysFromDaysAgo: s.r.span ?? null, coinsBought: s.r.buys, paidInDollars: s.r.buysUsd, paidInSol: s.r.buysSol,
      buysChecked: s.r.checked, newHolders30sBefore: s.r.before30, newHolders30sAfter: s.r.after30,
      linked: s.linked.slice(0, 20).map(({ address, through, ...l }) => ({ wallet: tag(address), ...(through ? { through: tag(through) } : {}), ...l })),
    })),
    calls: health.calls,
    errors: health.errors,
    creditsToday: state.credits,
    creditsCapPerDay: CREDITS_DAY,
    lastError: health.lastError,
  };
}

/** Test hooks. */
export const _test = { doSeed, setDepth: (d: Partial<typeof depth>) => Object.assign(depth, d), setCfg: (c: typeof cfg) => ((stopped = !c), (cfg = c)), state: () => state, reset: () => ((state = { day: "", credits: 0, seeds: {} }), reads.clear()) };
