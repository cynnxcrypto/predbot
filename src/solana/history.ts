/**
 * PAPER / READ-ONLY: the wallet history study. enrique, 11 Nov 2026 17:53 KST: a real human trader "cant have a
 * million tx a day", so waiting for 30 live copies of one wallet takes days. This looks BACKWARDS instead: it reads
 * each listed wallet's past buys from the chain (Helius getTransactionsForAddress) and, for each buy, everything
 * that traded that token from just before it to about a minute after. From that:
 *   - was there a wave: how many other wallets bought in the ~4 s after, against the ~4 s before;
 *   - what a copier landing in the next block or two (where our real test lands) could have sold for about 5, 10,
 *     30 and 60 s later;
 *   - how busy the wallet is, to tell bots from people.
 * A wallet is called good only if it passes on BOTH halves of its history (older and newer): 30+ buys, and in each
 * half the 10 s move beats COST_PCT at least half the time and on average. Picking on the whole history and then
 * believing it is how the Polymarket rules fooled us.
 *
 * Nothing is sent. Prices are read from balance changes, so they contain the traders' own fees: a follower's buy
 * price is taken as it is for our entry, and for our exit a buy is marked down and a sale taken as it is. The move
 * is before our own transaction fees (about 0.002 SOL a round trip), which COST_PCT stands for.
 *
 * Cost: about 10 Helius credits per 100 transactions read. Capped per day. SOLANA_HISTORY=off disables.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../config.js";
import { parseBuy, type ParsedTx } from "./copy.js";
import { swapOf, type Meta, type Swap } from "./discover.js";
import type { Tracked } from "./wallets.js";

export const DAYS_BACK = 14;
export const COST_PCT = 3;
const SPREAD = 0.025; // a buy price marked down to what a seller would get, and the other way round
const MAX_BUYS = 40; // analysed per wallet and pass, newest first
const KEEP_BUYS = 120;
const WALLET_PAGES = 12; // x100 transactions
const MINT_PAGES = 4;
const REFRESH_MS = 6 * 3_600_000;
const CREDITS_DAY = Math.max(1000, Number(process.env.SOLANA_HISTORY_CREDITS_DAY) || 150_000);
const WINDOWS = { m5: [10, 15], m10: [22, 28], m30: [70, 80], m60: [140, 160] } as const;

export type ISwap = Swap & { index: number };
export interface HBuy {
  t: number;
  slot: number;
  sol: number;
  /** other buyers in the ~4 s after / before */
  f4: number;
  b4: number;
  /** % move from a next-block entry to about 5 / 10 / 30 / 60 s later; null = the window was not read */
  m5: number | null;
  m10: number | null;
  m30: number | null;
  m60: number | null;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r1 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

/**
 * What happened around one buy. `swaps` are the token's swaps from ~10 slots before it to ~160 after, any order;
 * `covered` is the last slot that was fully read (a very busy token can outrun the pages we read).
 */
export function analyseBuy(lead: { wallet: string; slot: number; index: number; price: number }, swaps: ISwap[], covered = Infinity) {
  const rel = (s: ISwap) => (s.slot !== lead.slot ? s.slot - lead.slot : s.index > lead.index ? 0.5 : s.index < lead.index ? -0.5 : 0);
  const others = swaps.filter((s) => s.wallet !== lead.wallet);
  const buyers = (lo: number, hi: number) => new Set(others.filter((s) => s.buy && rel(s) >= lo && rel(s) <= hi).map((s) => s.wallet)).size;
  const priced = others.filter((s) => s.sol >= 0.1);
  const asBuy = (s: ISwap) => (s.buy ? s.price : s.price * (1 + SPREAD));
  const asSale = (s: ISwap) => (s.buy ? s.price * (1 - SPREAD) : s.price);
  const entry = median(priced.filter((s) => rel(s) >= 1 && rel(s) <= 2).map(asBuy)) ?? lead.price;
  const move = ([a, b]: readonly [number, number]): number | null => {
    if (covered < lead.slot + b) return null;
    const inWin = priced.filter((s) => rel(s) >= a && rel(s) <= b).map(asSale);
    const last = priced.filter((s) => rel(s) > 2 && rel(s) < a).sort((x, y) => x.slot - y.slot || x.index - y.index).at(-1);
    // nothing traded after our entry: selling straight back only costs the spread
    const exit = median(inWin) ?? (last ? asSale(last) : entry * (1 - SPREAD));
    return r1(Math.max(-100, Math.min(500, (exit / entry - 1) * 100)));
  };
  return { f4: buyers(0.5, 10), b4: buyers(-10, -0.5), m5: move(WINDOWS.m5), m10: move(WINDOWS.m10), m30: move(WINDOWS.m30), m60: move(WINDOWS.m60) };
}

const half = (bs: HBuy[]) => {
  const m = bs.map((b) => b.m10).filter((x): x is number => x !== null);
  return { n: m.length, won: m.filter((x) => x > COST_PCT).length, medianPct: r1(median(m)), avgPct: m.length ? r1(m.reduce((a, b) => a + b, 0) / m.length) : null };
};
const passes = (h: ReturnType<typeof half>) => h.n >= 15 && h.won / h.n >= 0.5 && (h.avgPct ?? -1) > COST_PCT;

/** One wallet's record: how busy it is, how often a wave follows, the typical move, and both halves of its history. */
export function walletReport(name: string, address: string, buys: HBuy[], txPerDay: number, buysPerDay: number) {
  const bs = [...buys].sort((a, b) => a.t - b.t);
  const med = (k: "m5" | "m10" | "m30" | "m60") => r1(median(bs.map((b) => b[k]).filter((x): x is number => x !== null)));
  const older = half(bs.slice(0, Math.floor(bs.length / 2)));
  const newer = half(bs.slice(Math.floor(bs.length / 2)));
  // hundreds of transactions or dozens of fresh tokens a day is a program, not a person
  const bot = txPerDay > 400 || buysPerDay > 60;
  return {
    name, address, buys: bs.length, txPerDay: Math.round(txPerDay), buysPerDay: r1(buysPerDay), bot,
    wavePct: bs.length ? Math.round((bs.filter((b) => b.f4 >= 3 && b.f4 >= 2 * b.b4 + 1).length / bs.length) * 100) : null,
    followers4s: r1(median(bs.map((b) => b.f4))),
    medianMove5s: med("m5"), medianMove10s: med("m10"), medianMove30s: med("m30"), medianMove60s: med("m60"),
    all: half(bs), older, newer,
    good: !bot && bs.length >= 30 && passes(older) && passes(newer),
  };
}

// ---- runner -----------------------------------------------------------------------------------------------------
interface WState {
  doneAt: number;
  /** newest block time read, so the next pass only reads what is new */
  newest: number;
  txPerDay: number;
  buysPerDay: number;
  mints: string[];
  buys: HBuy[];
}
interface State {
  day: string;
  credits: number;
  wallets: Record<string, WState>;
}
const FILE = () => join(DATA, "solana", "wallet-history.json");
let state: State = { day: "", credits: 0, wallets: {} };
const health = { state: "off", calls: 0, errors: 0, creditsToday: 0, lastError: "", working: "" };
let stopped = true;
let cfg: { rpcUrl: () => string | null; fetch: () => typeof fetch; wallets: () => Tracked[] } | null = null;
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
  health.creditsToday = state.credits;
}

export interface Item {
  slot: number;
  transactionIndex: number;
  blockTime: number | null;
  transaction: { signatures?: string[]; message: { accountKeys: (string | { pubkey: string })[] } };
  meta: (Meta & { loadedAddresses?: { writable?: string[]; readonly?: string[] } }) | null;
}
export type Page = { data: Item[]; paginationToken: string | null } | null;
/**
 * A reader of one address's transactions, 100 a page (Helius getTransactionsForAddress). Each user keeps its own
 * credit count: `canSpend` says whether today's cap allows another page, `spent` books what a page cost. A page
 * throws on refusal and is null when the cap is reached or there is no key.
 */
export function makeReader(o: { url: () => string | null | undefined; fetch: () => typeof fetch; canSpend: () => boolean; spent: (credits: number) => void; called: () => void }) {
  return async (address: string, filters: Record<string, unknown>, sortOrder: "asc" | "desc", token: string | null): Promise<Page> => {
    if (!o.canSpend()) return null;
    const url = o.url();
    if (!url) return null;
    const body = { jsonrpc: "2.0", id: 1, method: "getTransactionsForAddress", params: [address, { transactionDetails: "full", sortOrder, limit: 100, encoding: "json", maxSupportedTransactionVersion: 1, ...(token ? { paginationToken: token } : {}), filters: { status: "succeeded", ...filters } }] };
    for (let i = 0; ; i++) {
      await sleep(250);
      o.called();
      const res = await o.fetch()(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 && i < 3) {
        await sleep(5000 * (i + 1));
        continue;
      }
      const j = (await res.json().catch(() => ({}))) as { result?: { data?: Item[]; paginationToken?: string | null }; error?: { message: string } };
      if (j.error || !res.ok) throw new Error(j.error?.message ?? `http ${res.status}`);
      const data = j.result?.data ?? [];
      o.spent(Math.max(10, Math.ceil(data.length / 100) * 10));
      return { data, paginationToken: j.result?.paginationToken ?? null };
    }
  };
}
/** Never let a key reach a status line: an error text can quote the address it was sent to. */
export const scrub = (s: string) => s.replace(/api-key=[^&\s"]+/g, "api-key=***").slice(0, 140);
/** The plan does not serve this method: stop asking. */
export const refused = (msg: string) => /not (available|supported|found)|upgrade|plan|unauthorized|forbidden/i.test(msg);
const page = makeReader({
  url: () => cfg?.rpcUrl(),
  fetch: () => cfg!.fetch(),
  canSpend: () => (today(), state.credits < CREDITS_DAY),
  spent: (c) => (state.credits += c),
  called: () => health.calls++,
});
const signerOf = (it: Item) => {
  const k = it.transaction?.message?.accountKeys?.[0];
  return typeof k === "string" ? k : (k?.pubkey ?? null);
};

async function doWallet(w: Tracked) {
  const now = Math.floor(Date.now() / 1000);
  const prev = state.wallets[w.address];
  const since = Math.max(prev?.newest ?? 0, now - DAYS_BACK * 86_400);
  const items: Item[] = [];
  let token: string | null = null;
  let more = false;
  for (let p = 0; p < WALLET_PAGES; p++) {
    const pg = await page(w.address, { blockTime: { gt: since }, tokenAccounts: "balanceChanged" }, "desc", token);
    if (!pg) return false;
    items.push(...pg.data);
    token = pg.paginationToken;
    more = !!token;
    if (!token || !pg.data.length) break;
  }
  const times = items.map((x) => x.blockTime ?? 0).filter(Boolean);
  // how long a stretch the transactions we read cover: all of it when the pages ran out before the window did
  const spanDays = Math.max(1 / 24, (now - (more && times.length ? Math.min(...times) : since)) / 86_400);
  const seen = new Set(prev?.mints ?? []);
  const fresh: { it: Item; mint: string; sol: number; price: number }[] = [];
  for (const it of [...items].reverse()) {
    if (!it.blockTime || it.blockTime > now - 300) continue; // too new: its minute after is not final yet
    const b = parseBuy({ slot: it.slot, blockTime: it.blockTime, meta: it.meta, transaction: it.transaction } as ParsedTx, w.address);
    if (!b || seen.has(b.mint)) continue;
    seen.add(b.mint);
    fresh.push({ it, mint: b.mint, sol: b.sol, price: b.price });
  }
  const buys: HBuy[] = [];
  for (const f of fresh.slice(-MAX_BUYS)) {
    if (stopped) return false;
    const swaps: ISwap[] = [];
    let tk: string | null = null;
    let covered = Infinity;
    for (let p = 0; p < MINT_PAGES; p++) {
      const pg = await page(f.mint, { slot: { gte: f.it.slot - 10, lte: f.it.slot + WINDOWS.m60[1] } }, "asc", tk);
      if (!pg) return false;
      for (const it of pg.data) {
        const s = swapOf(it.meta, signerOf(it), it.slot);
        if (s && s.mint === f.mint) swaps.push({ ...s, index: it.transactionIndex });
      }
      tk = pg.paginationToken;
      if (!tk || !pg.data.length) break;
      if (p === MINT_PAGES - 1) covered = (pg.data.at(-1)?.slot ?? f.it.slot) - 1; // more remains: later windows were not read
    }
    buys.push({ t: f.it.blockTime!, slot: f.it.slot, sol: Math.round(f.sol * 100) / 100, ...analyseBuy({ wallet: w.address, slot: f.it.slot, index: f.it.transactionIndex, price: f.price }, swaps, covered) });
  }
  state.wallets[w.address] = {
    doneAt: Date.now(),
    newest: times.length ? Math.max(...times) : since,
    // a later pass reads only a short new stretch: keep the first pass's rates unless the new stretch is a day or more
    txPerDay: prev && spanDays < 1 ? prev.txPerDay : items.length / spanDays,
    buysPerDay: prev && spanDays < 1 ? prev.buysPerDay : fresh.length / spanDays,
    mints: [...seen].slice(-600),
    buys: [...(prev?.buys ?? []), ...buys].slice(-KEEP_BUYS),
  };
  return true;
}

async function loop() {
  while (!stopped) {
    let did = false;
    for (const w of cfg?.wallets() ?? []) {
      if (stopped) return;
      const st = state.wallets[w.address];
      if (st && Date.now() - st.doneAt < REFRESH_MS) continue;
      health.working = w.name;
      try {
        const ok = await doWallet(w);
        if (!ok) {
          health.state = cfg?.rpcUrl() ? "resting until tomorrow (daily credit cap)" : "waiting for the Helius key";
          break;
        }
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
    if (!did && health.state === "reading") health.state = "up to date";
    await sleep(did ? 5000 : 10 * 60_000);
  }
}

export function startHistory(c: NonNullable<typeof cfg>) {
  if (process.env.SOLANA_HISTORY === "off" || !stopped) return;
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
export function stopHistory() {
  if (stopped) return;
  stopped = true;
  save();
}

export function historySummary() {
  const names = new Map((cfg?.wallets() ?? []).map((w) => [w.address, w.name]));
  const reps = Object.entries(state.wallets).filter(([a]) => names.has(a)).map(([a, st]) => walletReport(names.get(a)!, a, st.buys, st.txPerDay, st.buysPerDay));
  const people = reps.filter((x) => !x.bot);
  const slim = (x: (typeof reps)[number]) => ({ name: x.name, address: x.address, buys: x.buys, buysPerDay: x.buysPerDay, wavePct: x.wavePct, followers4s: x.followers4s, medianMove10s: x.medianMove10s, medianMove30s: x.medianMove30s, all: x.all, older: x.older, newer: x.newer, good: x.good });
  return {
    note: `Looks back ${DAYS_BACK} days at each listed wallet's first buys of a token and reads what traded in the minute after. Move = from the price paid one or two blocks behind the wallet to the price about 10 s later, before our own fees; "won" = better than +${COST_PCT}%. Good = not a bot, 30+ buys, and passing (half or more won, average above +${COST_PCT}%) on BOTH the older and the newer half of its buys. History is not a live fill: a lead to test, not proof.`,
    state: health.state,
    working: health.working,
    walletsDone: reps.length,
    walletsTotal: names.size,
    buysRead: reps.reduce((a, x) => a + x.buys, 0),
    bots: reps.filter((x) => x.bot).length,
    good: people.filter((x) => x.good).map(slim),
    /** people with 15+ buys, best average 10 s move first: a ranking, not a pick */
    top: people.filter((x) => x.all.n >= 15).sort((a, b) => (b.all.avgPct ?? -999) - (a.all.avgPct ?? -999)).slice(0, 20).map(slim),
    calls: health.calls,
    errors: health.errors,
    creditsToday: state.credits,
    creditsCapPerDay: CREDITS_DAY,
    lastError: health.lastError,
  };
}

/** Test hooks. */
export const _test = { page, doWallet, setCfg: (c: typeof cfg) => ((stopped = !c), (cfg = c)), state: () => state, reset: () => (state = { day: "", credits: 0, wallets: {} }) };
