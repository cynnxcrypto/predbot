/**
 * READ-ONLY: where did a trader we like go? enrique, 17 Nov 2026 15:58 KST: "Many times traders change wallets because
 * they get copied", "when we lock in a trader we like, we have to have a way to identify through deposits and
 * withdraws, a likelyhood of owned wallet".
 *
 * Hyperliquid first, because it is free to read: its public API gives every account's money ledger
 * (userNonFundingLedgerUpdates: deposits, withdrawals, and transfers between accounts with both addresses named).
 * For each trader we like (buckets.ts likedTraders: kept on real, at the paper bar, or half way there and ahead):
 *   MONEY (the main evidence)
 *     - a sub-account of the trader, or its master account;
 *     - wallets the trader sent money to, or got money from, inside Hyperliquid;
 *     - wallets paid by the same funder as the trader (funder -> trader and funder -> wallet), when that funder is a
 *       person's wallet and not a service with dozens of counterparts;
 *     - a deposit that lands in another wallet shortly after the trader withdrew the same amount. A withdrawal leaves
 *       Hyperliquid for Arbitrum, where the ledger cannot follow it, so those wallets are looked for among the
 *       graph's wallets and, when the trader moved most of the account out, among the leaderboard wallets of a
 *       similar size.
 *   BEHAVIOUR (a second signal, never enough alone)
 *     - trades the trader's coins, holds the same side on the same coins now, was born around the withdrawal.
 * Each wallet gets a score from 0 to 100 with its reasons in plain words: 70+ "likely", 40+ "possible".
 *
 * Evidence, not proof of who owns a wallet. A likely or possible wallet is followed on PAPER only (buckets.ts
 * setExtraTraders) and goes real on its own record at the usual bar, never because it is linked.
 * The public status carries short tags only; full addresses are served behind the dashboard password
 * (linksPrivate) and stay in data/hyperliquid-links.json on the server. Nothing is sent. HL_LINKS=off disables.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../config.js";

export const DAYS_BACK = 90;
const DAY = 86_400_000;
/** a transfer under this is dust (people drop cents on known wallets) */
export const MIN_USD = 50;
/** a wallet with more counterparts than this is a desk, a bridge or a service, not somebody's second wallet */
export const HUB_COUNTERPARTS = 25;
/** a deposit this long after a withdrawal can still be the same money (bridge out, bridge in) */
export const MATCH_WINDOW_MS = 72 * 3_600_000;
/** the trader "moved": this share of what the account held went out in the last 30 days */
export const MOVED_SHARE = 0.5;
export const MOVED_MIN_USD = 5_000;
export const LIKELY = 70;
export const POSSIBLE = 40;
const REFRESH_MS = DAY;
const READ_KEEP_MS = DAY;
const MAX_DIRECT = 8;
const MAX_STEP2 = 6;
const MAX_POOL = 40;
const LEDGER_PAGE = 500;
const LEDGER_PAGES = 6;
const VERSION = 1;

export interface Flow {
  t: number;
  kind: "deposit" | "withdraw" | "in" | "out";
  usd: number;
  /** the other account of a transfer */
  other?: string;
  /** a transfer between a master account and its sub-account */
  sub?: boolean;
}
const isAddr = (x: unknown): x is string => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
const num = (x: unknown) => Math.abs(Number(x)) || 0;

/** One account's ledger rows -> the money that came in and went out, oldest first. Anything not understood is skipped. */
export function parseLedger(raw: unknown, owner: string): Flow[] {
  if (!Array.isArray(raw)) return [];
  const me = owner.toLowerCase();
  const out: Flow[] = [];
  for (const row of raw as { time?: unknown; delta?: Record<string, unknown> }[]) {
    const t = Number(row?.time);
    const d = row?.delta;
    if (!(t > 0) || !d || typeof d.type !== "string") continue;
    if (d.type === "deposit") out.push({ t, kind: "deposit", usd: num(d.usdc) });
    else if (d.type === "withdraw") out.push({ t, kind: "withdraw", usd: num(d.usdc) });
    else if (d.type === "internalTransfer" || d.type === "spotTransfer" || d.type === "send" || d.type === "subAccountTransfer") {
      if (!isAddr(d.user) || !isAddr(d.destination)) continue;
      const from = d.user.toLowerCase();
      const to = d.destination.toLowerCase();
      if (from === to || (from !== me && to !== me)) continue; // a move between one's own books, or not ours
      const usd = d.usdc !== undefined ? num(d.usdc) : num(d.usdcValue);
      out.push({ t, kind: from === me ? "out" : "in", usd, other: from === me ? to : from, ...(d.type === "subAccountTransfer" ? { sub: true } : {}) });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface Cp {
  in: number;
  out: number;
  n: number;
  last: number;
  sub?: boolean;
}
export interface WalletRead {
  at: number;
  /** first row seen, ms (null = no money rows in the window) */
  firstAt: number | null;
  /** the read reached the start of the window (false = a busy wallet, cut short) */
  full: boolean;
  rows: number;
  cps: Record<string, Cp>;
  deposits: [t: number, usd: number][];
  withdrawals: [t: number, usd: number][];
  /** coins of its last fills; null = not read */
  coins: string[] | null;
  firstFill: number | null;
  lastFill: number | null;
  /** account value now, dollars; null = not read */
  acct: number | null;
  /** coin -> +1 long, -1 short, now */
  pos: Record<string, number>;
}
export function digest(flows: Flow[], at: number, full: boolean): WalletRead {
  const cps: Record<string, Cp> = {};
  for (const f of flows) {
    if (!f.other || (f.usd < MIN_USD && !f.sub)) continue;
    const c = (cps[f.other] ??= { in: 0, out: 0, n: 0, last: 0 });
    if (f.kind === "in") c.in += f.usd;
    else c.out += f.usd;
    c.n++;
    c.last = Math.max(c.last, f.t);
    if (f.sub) c.sub = true;
  }
  const pick = (k: Flow["kind"]) => flows.filter((f) => f.kind === k && f.usd >= MIN_USD).map((f) => [f.t, f.usd] as [number, number]);
  return { at, firstAt: flows.length ? flows[0].t : null, full, rows: flows.length, cps, deposits: pick("deposit"), withdrawals: pick("withdraw"), coins: null, firstFill: null, lastFill: null, acct: null, pos: {} };
}
export const isHub = (w: WalletRead) => Object.keys(w.cps).length > HUB_COUNTERPARTS;

/** 10,000 or 2,500 is what anybody sends; 48,731.22 is somebody's whole balance */
export const roundAmount = (usd: number) => usd % (usd >= 10_000 ? 1000 : usd >= 1000 ? 100 : 50) === 0;
/**
 * Deposits of `cand` that follow a withdrawal of `trader` with the same amount (a withdrawal costs about a dollar,
 * so a dollar and a half or 0.3% apart still counts). Each withdrawal is matched once, with the nearest deposit.
 */
export function matches(trader: WalletRead, cand: WalletRead): { out: number; in: number; hours: number; round: boolean }[] {
  const res: { out: number; in: number; hours: number; round: boolean }[] = [];
  const used = new Set<number>();
  for (const [wt, wusd] of trader.withdrawals) {
    let best = -1;
    for (let i = 0; i < cand.deposits.length; i++) {
      const [dt, dusd] = cand.deposits[i];
      if (used.has(i) || dt <= wt || dt - wt > MATCH_WINDOW_MS) continue;
      if (Math.abs(dusd - wusd) > Math.max(1.5, wusd * 0.003)) continue;
      if (best < 0 || dt < cand.deposits[best][0]) best = i;
    }
    if (best < 0) continue;
    used.add(best);
    res.push({ out: wusd, in: cand.deposits[best][1], hours: Math.round(((cand.deposits[best][0] - wt) / 3_600_000) * 10) / 10, round: roundAmount(wusd) });
  }
  return res;
}

/** What the trader took out in the last 30 days, and whether that is most of the account. */
export function movedOf(w: WalletRead, now: number) {
  const recent = w.withdrawals.filter(([t]) => now - t <= 30 * DAY);
  const out = recent.reduce((a, [, u]) => a + u, 0);
  const back = w.deposits.filter(([t]) => now - t <= 30 * DAY).reduce((a, [, u]) => a + u, 0);
  const net = Math.max(0, out - back);
  const moved = net >= MOVED_MIN_USD && net >= MOVED_SHARE * (net + (w.acct ?? 0));
  return { out30: Math.round(out), net30: Math.round(net), moved, lastOutAt: recent.length ? recent[recent.length - 1][0] : null };
}

const money = (x: number) => "$" + Math.round(x).toLocaleString("en-US");
export const tag = (a: string) => `copy-${a.slice(2, 10)}`;
export interface Evidence {
  /** money straight between the two */
  direct?: Cp;
  /** funders (not services) that paid both: tags */
  funders?: string[];
  match?: { out: number; in: number; hours: number; round: boolean }[];
  /** share of the trader's coins this wallet trades, 0..1; null = unknown */
  overlap?: number | null;
  shared?: number;
  traderCoins?: number;
  /** coins both hold on the same side now */
  sameSide?: number;
  /** days from the trader's last big withdrawal to this wallet's first money (negative = before) */
  bornDays?: number | null;
  hub?: boolean;
}
/** Evidence -> score 0..100, label and reasons. Money decides; behaviour alone tops out below "possible". */
export function judge(e: Evidence): { score: number; label: "likely" | "possible" | "weak" | "service"; reasons: string[] } {
  if (e.hub) return { score: 0, label: "service", reasons: ["a busy service wallet, not a person's"] };
  let money_ = 0;
  let behave = 0;
  const reasons: string[] = [];
  if (e.direct?.sub) {
    money_ += 95;
    reasons.push("sub-account of the same owner");
  } else if (e.direct) {
    const d = e.direct;
    const total = d.in + d.out;
    money_ += total >= 1000 || d.n >= 2 ? 50 : 30;
    if (d.in > 0 && d.out > 0) money_ += 10;
    const parts = [d.out > 0 ? `got ${money(d.out)} from the trader` : "", d.in > 0 ? `sent the trader ${money(d.in)}` : ""].filter(Boolean);
    reasons.push(`${parts.join(" and ")} (${d.n} transfer${d.n === 1 ? "" : "s"})`);
  }
  if (e.funders?.length) {
    money_ += 30;
    reasons.push(`paid by the same wallet as the trader (${e.funders.slice(0, 2).join(", ")})`);
  }
  if (e.match?.length) {
    const exact = e.match.filter((m) => !m.round);
    money_ += exact.length ? 30 + Math.min(20, 10 * (exact.length - 1)) : 10;
    if (e.match.length > 1 && !exact.length) money_ += 5;
    const m = exact[0] ?? e.match[0];
    reasons.push(`deposit of ${money(m.in)} landed ${m.hours} h after the trader withdrew ${money(m.out)}${m.round ? " (a round amount, weak)" : ""}${e.match.length > 1 ? `, ${e.match.length} such pairs` : ""}`);
  }
  if (e.overlap != null && e.traderCoins && e.traderCoins >= 3 && e.overlap >= 0.5) {
    behave += e.overlap >= 0.75 ? 10 : 6;
    reasons.push(`trades ${e.shared} of the trader's ${e.traderCoins} coins`);
  }
  if ((e.sameSide ?? 0) >= 2) {
    behave += 10;
    reasons.push(`same side as the trader on ${e.sameSide} coins now`);
  }
  if (e.bornDays != null && e.bornDays >= -3 && e.bornDays <= 14) {
    behave += 8;
    reasons.push(e.bornDays >= 0 ? `new wallet: first money ${Math.round(e.bornDays)} d after the trader's withdrawal` : `new wallet: first money ${Math.round(-e.bornDays)} d before the trader's withdrawal`);
  }
  const score = Math.min(100, money_ + Math.min(behave, money_ > 0 ? 28 : 0));
  return { score, label: score >= LIKELY ? "likely" : score >= POSSIBLE ? "possible" : "weak", reasons };
}

/** Compare a candidate with the trader: the behaviour part of the evidence. */
export function behaviour(trader: WalletRead, cand: WalletRead, lastOutAt: number | null): Pick<Evidence, "overlap" | "shared" | "traderCoins" | "sameSide" | "bornDays"> {
  const tc = trader.coins ?? [];
  const cc = new Set(cand.coins ?? []);
  const shared = tc.filter((c) => cc.has(c)).length;
  const sameSide = Object.entries(trader.pos).filter(([c, d]) => cand.pos[c] === d).length;
  const born = cand.full && cand.firstAt !== null ? cand.firstAt : null;
  return { overlap: trader.coins && cand.coins && tc.length ? shared / tc.length : null, shared, traderCoins: tc.length, sameSide, bornDays: born !== null && lastOutAt !== null ? (born - lastOutAt) / DAY : null };
}

// ---- state --------------------------------------------------------------------------------------------------------------
export interface Link {
  address: string;
  score: number;
  label: "likely" | "possible" | "weak" | "service";
  reasons: string[];
  how: "money" | "funder" | "match";
  acct: number | null;
  lastFill: number | null;
}
interface TraderState {
  at: number;
  why: string;
  acct: number | null;
  out30: number;
  net30: number;
  moved: boolean;
  lastOutAt: number | null;
  full: boolean;
  counterparts: number;
  checked: number;
  poolChecked: number;
  links: Link[];
  error?: string;
}
interface State {
  v: number;
  traders: Record<string, TraderState>;
  /** when a wallet was first named likely or possible, ms */
  since: Record<string, number>;
}
const FILE = () => join(DATA, "hyperliquid-links.json");
let state: State = { v: VERSION, traders: {}, since: {} };
let loaded = false;
function load() {
  loaded = true;
  try {
    const s = JSON.parse(readFileSync(FILE(), "utf8")) as State;
    if (s?.v === VERSION && s.traders) state = { v: VERSION, traders: s.traders, since: s.since ?? {} };
  } catch {
    /* first run */
  }
}
function save() {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(FILE() + ".tmp", JSON.stringify(state));
  renameSync(FILE() + ".tmp", FILE());
}

export interface LinkDeps {
  fetch: () => typeof fetch;
  liked: () => { address: string; why: string }[];
  /** the leaderboard: address and account value */
  board: () => { address: string; acct: number }[];
  /** our paper record of copying a wallet, by its tag */
  record: (tag: string) => { trades: number; won: number; netUsd: number };
  /** pause between two wallet reads (Hyperliquid allows 1,200 weight a minute for an address; one wallet read is 42) */
  wait: () => Promise<void>;
  now?: () => number;
}
let deps: LinkDeps | null = null;
let status = "not started";
const reads = new Map<string, WalletRead>();

async function post(body: unknown): Promise<unknown> {
  const res = await deps!.fetch()("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res) throw new Error("no answer");
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json().catch(() => {
    throw new Error("not json");
  });
}
/** One wallet: its ledger over the window and, with `whole`, its last fills and what it holds now. Kept for a day. */
async function readWallet(address: string, now: number, whole: boolean): Promise<WalletRead> {
  const had = reads.get(address);
  if (had && now - had.at < READ_KEEP_MS && (!whole || had.coins !== null)) return had;
  let w = had && now - had.at < READ_KEEP_MS ? had : null;
  if (!w) {
    await deps!.wait();
    const start = now - DAYS_BACK * DAY;
    const seen = new Set<string>();
    const rows: unknown[] = [];
    let from = start;
    let full = true;
    for (let page = 0; page < LEDGER_PAGES; page++) {
      const got = await post({ type: "userNonFundingLedgerUpdates", user: address, startTime: from });
      if (!Array.isArray(got)) throw new Error("ledger: not a list");
      let fresh = 0;
      let last = from;
      for (const x of got as { time?: number; hash?: string; delta?: { type?: string } }[]) {
        const k = `${x?.hash}:${x?.time}:${x?.delta?.type}:${JSON.stringify(x?.delta)}`;
        last = Math.max(last, Number(x?.time) || 0);
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push(x);
        fresh++;
      }
      if (got.length < LEDGER_PAGE || !fresh || last <= from) break;
      from = last;
      if (page === LEDGER_PAGES - 1) full = false;
    }
    w = digest(parseLedger(rows, address), now, full);
  }
  if (whole && w.coins === null) {
    const fills = await post({ type: "userFills", user: address });
    const fl = Array.isArray(fills) ? (fills as { coin?: unknown; time?: unknown }[]).filter((f) => typeof f?.coin === "string" && Number(f.time) > 0) : [];
    w.coins = [...new Set(fl.map((f) => f.coin as string))];
    w.firstFill = fl.length ? Math.min(...fl.map((f) => Number(f.time))) : null;
    w.lastFill = fl.length ? Math.max(...fl.map((f) => Number(f.time))) : null;
    const st = (await post({ type: "clearinghouseState", user: address })) as { marginSummary?: { accountValue?: unknown }; assetPositions?: { position?: { coin?: unknown; szi?: unknown } }[] };
    const av = Number(st?.marginSummary?.accountValue);
    w.acct = Number.isFinite(av) ? Math.round(av) : null;
    for (const p of Array.isArray(st?.assetPositions) ? st.assetPositions : []) {
      const szi = Number(p?.position?.szi);
      if (typeof p?.position?.coin === "string" && szi) w.pos[p.position.coin] = szi > 0 ? 1 : -1;
    }
  }
  reads.set(address, w);
  return w;
}

/** Everything for one trader. Throws only when the trader's own read fails; a candidate that cannot be read is skipped. */
async function doTrader(address: string, why: string, now: number): Promise<TraderState> {
  const T = await readWallet(address, now, true);
  const mv = movedOf(T, now);
  const liked = new Set(deps!.liked().map((x) => x.address));
  const ev = new Map<string, Evidence>();
  const how = new Map<string, Link["how"]>();
  const add = (a: string, h: Link["how"], e: Evidence) => {
    if (a === address) return;
    ev.set(a, { ...(ev.get(a) ?? {}), ...e });
    if (!how.has(a)) how.set(a, h);
  };
  // 1. money straight to or from the trader
  const direct = Object.entries(T.cps).filter(([, c]) => c.sub || c.in + c.out >= MIN_USD).sort((x, y) => Number(!!y[1].sub) - Number(!!x[1].sub) || y[1].in + y[1].out - (x[1].in + x[1].out)).slice(0, MAX_DIRECT);
  const got = new Map<string, WalletRead>();
  for (const [a, c] of direct) {
    const w = await readWallet(a, now, true).catch(() => null);
    if (!w) continue;
    got.set(a, w);
    add(a, "money", { direct: c, hub: isHub(w) && !c.sub });
  }
  // 2. paid by the same funder: a person's wallet that paid the trader in, and the other wallets it paid
  const step2: [string, string, number][] = [];
  for (const [f, c] of direct) {
    const w = got.get(f);
    if (!w || isHub(w) || !(c.in >= MIN_USD)) continue;
    for (const [b, c2] of Object.entries(w.cps)) if (b !== address && c2.out >= MIN_USD && !got.has(b)) step2.push([b, f, c2.out]);
  }
  for (const [b, f] of step2.sort((x, y) => y[2] - x[2]).slice(0, MAX_STEP2)) {
    const w = got.get(b) ?? (await readWallet(b, now, true).catch(() => null));
    if (!w) continue;
    got.set(b, w);
    const before = ev.get(b)?.funders ?? [];
    add(b, "funder", { funders: [...new Set([...before, tag(f)])], hub: isHub(w) });
  }
  // 3. a deposit that mirrors a withdrawal: every wallet read so far, then (the trader moved out) leaderboard wallets of that size
  for (const [a, w] of got) {
    const m = matches(T, w);
    if (m.length) add(a, how.get(a) ?? "match", { match: m });
  }
  let poolChecked = 0;
  if (mv.moved) {
    const pool = deps!.board().filter((x) => x.address !== address && !got.has(x.address) && !liked.has(x.address) && x.acct > 0).sort((x, y) => Math.abs(Math.log(x.acct / mv.net30)) - Math.abs(Math.log(y.acct / mv.net30))).slice(0, MAX_POOL);
    for (const p of pool) {
      const w = await readWallet(p.address, now, false).catch(() => null);
      if (!w) continue;
      poolChecked++;
      const m = matches(T, w);
      if (!m.length) continue;
      const whole = await readWallet(p.address, now, true).catch(() => w);
      got.set(p.address, whole);
      add(p.address, "match", { match: m, hub: isHub(whole) });
    }
  }
  const links: Link[] = [];
  for (const [a, e] of ev) {
    const w = got.get(a)!;
    const j = judge({ ...e, ...behaviour(T, w, mv.lastOutAt) });
    links.push({ address: a, score: j.score, label: j.label, reasons: j.reasons, how: how.get(a)!, acct: w.acct, lastFill: w.lastFill });
  }
  links.sort((x, y) => y.score - x.score);
  for (const l of links) if (l.score >= POSSIBLE) state.since[l.address] ??= now;
  return { at: now, why, acct: T.acct, out30: mv.out30, net30: mv.net30, moved: mv.moved, lastOutAt: mv.lastOutAt, full: T.full, counterparts: Object.keys(T.cps).length, checked: got.size, poolChecked, links: links.slice(0, 12) };
}

let busy = false;
/** One turn: the liked trader whose read is oldest (a day or more) is read again. Never throws. */
export async function linksTick(): Promise<void> {
  if (!deps || busy) return;
  if (!loaded) load();
  busy = true;
  const now = (deps.now ?? Date.now)();
  try {
    const liked = deps.liked();
    const names = new Set(liked.map((x) => x.address));
    for (const a of Object.keys(state.traders)) if (!names.has(a)) delete state.traders[a]; // no longer liked: its links leave with it
    const next = liked.filter((x) => now - (state.traders[x.address]?.at ?? 0) >= REFRESH_MS).sort((x, y) => (state.traders[x.address]?.at ?? 0) - (state.traders[y.address]?.at ?? 0))[0];
    if (!next) {
      status = liked.length ? "up to date" : "no trader we like yet";
      return;
    }
    status = `reading ${tag(next.address)}`;
    try {
      state.traders[next.address] = await doTrader(next.address, next.why, now);
    } catch (e) {
      const old = state.traders[next.address];
      // tried again in an hour, the last good result kept
      state.traders[next.address] = { ...(old ?? { acct: null, out30: 0, net30: 0, moved: false, lastOutAt: null, full: false, counterparts: 0, checked: 0, poolChecked: 0, links: [] }), why: next.why, at: now - REFRESH_MS + 3_600_000, error: String((e as Error)?.message ?? e).slice(0, 80) };
    }
    for (const [a, w] of reads) if (now - w.at > READ_KEEP_MS) reads.delete(a);
    const named = new Set(Object.values(state.traders).flatMap((t) => t.links.filter((l) => l.score >= POSSIBLE).map((l) => l.address)));
    for (const a of Object.keys(state.since)) if (!named.has(a)) delete state.since[a];
    save();
    status = "up to date";
  } catch (e) {
    status = `error: ${String((e as Error)?.message ?? e).slice(0, 80)}`;
  } finally {
    busy = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startLinks(d: LinkDeps) {
  if (process.env.HL_LINKS === "off" || timer) return;
  deps = d;
  status = "starting";
  timer = setInterval(() => void linksTick(), 5 * 60_000);
  timer.unref();
  setTimeout(() => void linksTick(), 90_000).unref();
}
export function stopLinks() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Likely and possible wallets that still trade (a fill in the last 30 days, $1,000 or more in the account): followed on paper. */
export function linkedTraders(now = Date.now()): string[] {
  if (!loaded) load();
  const best = new Map<string, number>();
  for (const t of Object.values(state.traders)) for (const l of t.links) if (l.score >= POSSIBLE && (l.acct ?? 0) >= 1000 && l.lastFill !== null && now - l.lastFill <= 30 * DAY) best.set(l.address, Math.max(best.get(l.address) ?? 0, l.score));
  return [...best.entries()].sort((x, y) => y[1] - x[1]).map(([a]) => a);
}

function rows(full: boolean, now = Date.now()) {
  if (!loaded) load();
  const onPaper = new Set(linkedTraders(now));
  return Object.entries(state.traders)
    .map(([a, t]) => ({
      id: tag(a),
      ...(full ? { address: a } : {}),
      why: t.why,
      readAt: t.at,
      acctUsd: t.acct,
      withdrawn30dUsd: t.out30,
      /** most of the account left in the last 30 days */
      moved: t.moved,
      lastWithdrawalAt: t.lastOutAt,
      checked: t.checked,
      poolChecked: t.poolChecked,
      error: t.error ?? null,
      links: t.links
        .filter((l) => l.score >= POSSIBLE)
        .map((l) => {
          const rec = deps?.record(tag(l.address));
          return { id: tag(l.address), ...(full ? { address: l.address } : {}), score: l.score, label: l.label, reasons: l.reasons, how: l.how, acctUsd: l.acct, lastTradeAt: l.lastFill, since: state.since[l.address] ?? null, onPaper: onPaper.has(l.address), paper: rec ? { trades: rec.trades, won: rec.won, net: Math.round(rec.netUsd * 100) / 100 } : null };
        }),
    }))
    .sort((x, y) => (y.links[0]?.score ?? 0) - (x.links[0]?.score ?? 0) || Number(y.moved) - Number(x.moved))
    .slice(0, full ? 100 : 30);
}

/** For the public status: short tags only, no address. */
export function linksPublic(now = Date.now()) {
  if (!loaded) load();
  const all = Object.values(state.traders);
  const ls = all.flatMap((t) => t.links);
  return {
    front: "hyperliquid",
    state: status,
    daysBack: DAYS_BACK,
    bars: { likely: LIKELY, possible: POSSIBLE },
    tradersLiked: deps?.liked().length ?? 0,
    tradersRead: all.filter((t) => !t.error).length,
    tradersMoved: all.filter((t) => t.moved).length,
    likely: new Set(ls.filter((l) => l.score >= LIKELY).map((l) => l.address)).size,
    possible: new Set(ls.filter((l) => l.score >= POSSIBLE && l.score < LIKELY).map((l) => l.address)).size,
    onPaper: linkedTraders(now).length,
    traders: rows(false, now),
  };
}
/** Behind the dashboard password only: the same, with full addresses. */
export function linksPrivate(now = Date.now()) {
  return { ...linksPublic(now), traders: rows(true, now) };
}

export const _test = {
  doTrader,
  set: (d: LinkDeps | null) => void (deps = d),
  state: () => state,
  reset: () => {
    state = { v: VERSION, traders: {}, since: {} };
    loaded = true;
    reads.clear();
    busy = false;
  },
};
