/**
 * REAL MONEY, OFF UNTIL SWITCHED ON. The real Base copy (enrique, 19 Nov 2026 15:49 KST: "we will need to do a copy
 * set up for base and fund it from solana"): the paper Base copy (basecopy.ts) decides, this file does the same
 * with the bot's own wallet on Base (src/bridge/basekey.ts, funded through the bridge). It knows no network:
 * everything outside comes through Deps (basereal.ts is the real one).
 *
 * The rules, all in code:
 *   - nothing is bought unless deploy/live-rules.json has "baseCopy": { "on": true, ... }. The sizes need
 *     enrique's own word. Off, absent or unreadable = no buy. A coin already held is still SOLD when its wallet
 *     sells, switch on or off: turning the switch off never strands money in a coin.
 *   - only wallets at the real bar are copied with money: QUALIFY copies on paper, half won, ahead (the Solana
 *     bar), and not behind on OUR real copies of them after CUT_REAL of those.
 *   - hard limits no switch can pass: HARD below.
 *   - the paper copy's own rules carry over: size by conviction (0.5x to 2x the stake), the wallet sells a part ->
 *     we sell the same part, out at 72 h.
 *   - gas: buys stop when the wallet holds under gasKeepEth of ETH; the USDC is never all spent on coins.
 *   - a mark is written before every send; after a stop the wallet's real balance says what happened, and nothing
 *     is sent twice.
 *   - the loss stop: closed real copies at maxLossUsd behind = no more buys until the switch's "resetId" changes.
 */
import type { BaseState, Copy, Event } from "./basecopy.js";
import { keyOf, QUALIFY, STAKE_USD } from "./basecopy.js";

export const HARD = { stakeUsd: 25, maxOpen: 8, maxLossUsd: 60, minGasKeepEth: 0.0003, testUsd: 3 };
export const CUT_REAL = 3;

export interface Switch {
  on: boolean;
  stakeUsd: number;
  maxOpen: number;
  maxLossUsd: number;
  gasKeepEth: number;
  /** a once-switch: a tiny buy and sale of the deepest coin to prove the whole path; each id runs once */
  testOnce: string;
  resetId: string;
}
/** The switch as written in deploy/live-rules.json, pressed inside the hard limits. Null = off. */
export function parseSwitch(text: string): Switch | null {
  try {
    const b = (JSON.parse(text) as { baseCopy?: Record<string, unknown> }).baseCopy;
    if (!b || typeof b !== "object") return null;
    const n = (x: unknown, d: number, lo: number, hi: number) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.min(hi, Math.max(lo, Number(x))) : d);
    return {
      on: b.on === true,
      stakeUsd: n(b.stakeUsd, 5, 2, HARD.stakeUsd),
      maxOpen: Math.floor(n(b.maxOpen, 4, 1, HARD.maxOpen)),
      maxLossUsd: n(b.maxLossUsd, 20, 1, HARD.maxLossUsd),
      gasKeepEth: n(b.gasKeepEth, 0.0005, HARD.minGasKeepEth, 0.01),
      testOnce: typeof b.testOnce === "string" ? b.testOnce.slice(0, 20) : "",
      resetId: typeof b.resetId === "string" ? b.resetId.slice(0, 20) : "",
    };
  } catch {
    return null;
  }
}

export interface Deps {
  switch(): Switch | null;
  /** is there a Base wallet on this machine? (it is never made here: the bridge makes it) */
  hasWallet(): boolean;
  balances(): Promise<{ usdc: number; eth: number }>;
  /** the wallet's balance of a coin, in the coin's smallest unit */
  held(token: string): Promise<bigint>;
  /** buy `usd` of the coin at about `px` dollars a coin; every check is inside; returns the coins received */
  buy(token: string, usd: number, px: number): Promise<{ raw: bigint; decimals: number }>;
  /** sell `raw` of the coin for USDC at about `px`; `force` = take the route's own price (the coin fell); returns the USDC received */
  sell(token: string, raw: bigint, px: number, force: boolean): Promise<number>;
}

export type Pos = { key: string; wallet: string; token: string; symbol: string; at: number; stage: "buying" | "held" | "selling"; usdcIn: number; raw: string; decimals: number; /** USDC back from what was already sold */ backUsd: number; parts: number; fails?: number; test?: boolean; /** part of the result is an estimate: a sale landed that we only saw by the balance */ est?: boolean };
export type Closed = { t: number; at: number; wallet: string; symbol: string; usdcIn: number; usd: number; parts: number; test?: boolean; est?: boolean };
export type LiveState = { positions: Pos[]; closed: Closed[]; tests: string[]; resetId?: string; lossBaseUsd?: number; usdc?: number; eth?: number; at?: number; error?: string; note?: string; skipped?: Record<string, number> };
export const emptyLive = (): LiveState => ({ positions: [], closed: [], tests: [] });


const short = (e: unknown) => String((e as Error)?.message ?? e).replace(/0x[0-9a-fA-F]{40,}/g, "…").slice(0, 160);
const skip = (st: LiveState, why: string) => void ((st.skipped ??= {})[why] = (st.skipped[why] ?? 0) + 1);
/** a buy mark this old with nothing in the wallet: the buy never happened */
export const BUY_WAIT_MS = 3 * 60_000;

/** At the real bar on paper (the Solana bar). */
export function atBar(paper: BaseState, wallet: string): boolean {
  const r = paper.done.reduce((a, d) => (d.wallet === wallet ? { n: a.n + 1, won: a.won + (d.usd > 0 ? 1 : 0), usd: a.usd + d.usd } : a), { n: 0, won: 0, usd: 0 });
  return r.n >= QUALIFY.copies && r.won * 2 >= r.n && r.usd > 0;
}
/** Behind on our real copies of it. */
export function realCut(st: LiveState, wallet: string): boolean {
  const mine = st.closed.filter((c) => c.wallet === wallet && !c.test);
  return mine.length >= CUT_REAL && mine.reduce((a, c) => a + c.usd, 0) < 0;
}
export const realUsd = (st: LiveState) => st.closed.reduce((a, c) => a + c.usd, 0);
/** The loss stop holds: closed copies since the last reset are maxLossUsd behind. */
export const lossStopped = (st: LiveState, sw: Switch) => realUsd(st) - (st.lossBaseUsd ?? 0) <= -sw.maxLossUsd;
/** Dollars for a real copy: the switch's stake times the paper copy's conviction (0.5x to 2x), under the hard limit. */
export const sizeUsd = (sw: Switch, c: Copy) => Math.round(Math.min(HARD.stakeUsd * 2, sw.stakeUsd * Math.min(2, Math.max(0.5, (c.stakeUsd ?? STAKE_USD) / STAKE_USD))) * 100) / 100;

function finish(st: LiveState, p: Pos, nowMs: number): void {
  st.closed.push({ t: nowMs, at: p.at, wallet: p.wallet, symbol: p.symbol, usdcIn: p.usdcIn, usd: Math.round((p.backUsd - p.usdcIn) * 1e4) / 1e4, parts: p.parts, ...(p.test ? { test: true } : {}), ...(p.est ? { est: true } : {}) });
  st.positions = st.positions.filter((x) => x !== p);
  if (st.closed.length > 500) st.closed.splice(0, st.closed.length - 500);
}

/** Sell `share` (0..1] of what a position still holds. The mark is written first; the wallet's balance settles any doubt. */
async function sellPart(st: LiveState, d: Deps, p: Pos, share: number, px: number, nowMs: number, save: () => void): Promise<void> {
  const have = await d.held(p.token);
  const mine = BigInt(p.raw);
  const base = have < mine ? have : mine;
  const whole = share >= 0.999;
  const raw = whole ? base : (base * BigInt(Math.round(share * 1e6))) / 1_000_000n;
  if (raw <= 0n) {
    // nothing of it in the wallet: it is gone (sold in a run that stopped)
    if (whole || base === 0n) finish(st, p, nowMs);
    return;
  }
  p.stage = "selling";
  save();
  try {
    const got = await d.sell(p.token, raw, px, (p.fails ?? 0) >= 3);
    p.backUsd += got;
    p.raw = (mine - raw).toString();
    if (!whole) p.parts++;
    p.fails = 0;
  } catch (e) {
    p.fails = (p.fails ?? 0) + 1;
    st.error = `sell ${p.symbol}: ${short(e)}`;
    // a sale that landed without its receipt being seen: the coins are gone, the dollars are in the wallet; their
    // amount is taken at the price asked, marked as an estimate
    const after = await d.held(p.token).catch(() => have);
    if (after < have) {
      const gone = have - after;
      p.backUsd += (Number(gone) / 10 ** p.decimals) * px * 0.98;
      p.raw = (mine > gone ? mine - gone : 0n).toString();
      p.est = true;
      if (!whole) p.parts++;
    }
  }
  p.stage = "held";
  if (BigInt(p.raw) <= 0n || (whole && BigInt(p.raw) < mine)) finish(st, p, nowMs);
  save();
}

async function buy(st: LiveState, d: Deps, p: Omit<Pos, "stage" | "raw" | "decimals" | "backUsd" | "parts">, px: number, save: () => void): Promise<Pos | null> {
  const before = await d.held(p.token);
  const pos: Pos = { ...p, stage: "buying", raw: "0", decimals: 18, backUsd: 0, parts: 0 };
  st.positions.push(pos);
  save();
  try {
    const got = await d.buy(p.token, p.usdcIn, px);
    if (got.raw <= 0n) throw new Error("the buy brought no coins");
    pos.raw = got.raw.toString();
    pos.decimals = got.decimals;
    pos.stage = "held";
    save();
    return pos;
  } catch (e) {
    st.error = `buy ${p.symbol}: ${short(e)}`;
    // sent or not? the wallet says: more of the coin than before = bought
    const after = await d.held(p.token).catch(() => before);
    if (after > before) {
      pos.raw = (after - before).toString();
      pos.stage = "held";
      pos.est = true;
      save();
      return pos;
    }
    // stays marked "buying" for BUY_WAIT_MS in case the transaction is still on its way; cleared by recover()
    save();
    return null;
  }
}

/** Marks left by a run that stopped, settled by the wallet's balance. */
async function recover(st: LiveState, d: Deps, nowMs: number): Promise<void> {
  for (const p of [...st.positions]) {
    if (p.stage === "selling") p.stage = "held"; // the next sale reads the balance first
    if (p.stage !== "buying") continue;
    const have = await d.held(p.token);
    const others = st.positions.filter((x) => x !== p && x.token === p.token).reduce((a, x) => a + BigInt(x.raw), 0n);
    if (have > others) {
      p.raw = (have - others).toString();
      p.stage = "held";
      p.est = true;
    } else if (nowMs - p.at > BUY_WAIT_MS) st.positions = st.positions.filter((x) => x !== p);
  }
}

/**
 * One round, after the paper copy has read the trades: `events` is what the paper copy just did.
 * `save` writes the state; it is called before and after every send.
 */
export async function liveRound(st: LiveState, paper: BaseState, events: Event[], d: Deps, nowMs: number, save: () => void): Promise<void> {
  const sw = d.switch();
  if (!d.hasWallet()) {
    st.note = "no Base wallet on this machine yet";
    return;
  }
  const wantsTest = !!sw?.testOnce && !st.tests.includes(sw.testOnce);
  if (!st.positions.length && !sw?.on && !wantsTest) {
    st.note = "off";
    return;
  }
  st.note = undefined;
  st.error = undefined;
  if (sw && (sw.resetId || "") !== (st.resetId ?? "")) {
    st.resetId = sw.resetId;
    st.lossBaseUsd = realUsd(st);
  }
  try {
    await recover(st, d, nowMs);
    const px = (token: string) => paper.coins[token]?.px ?? 0;
    // 1. sales first: what the wallets sold, then anything whose paper copy is gone (a round missed over a restart)
    for (const e of events) {
      if (e.kind === "open") continue;
      const p = st.positions.find((x) => x.key === e.key && x.stage === "held");
      if (p) await sellPart(st, d, p, e.kind === "close" ? 1 : e.share, px(p.token), nowMs, save);
    }
    const open = new Set(paper.open.map(keyOf));
    for (const p of [...st.positions]) if (p.stage === "held" && (p.test || !open.has(p.key))) await sellPart(st, d, p, 1, px(p.token), nowMs, save);
    // 2. the once-test: a tiny buy of the deepest coin, sold straight back
    if (sw && wantsTest) {
      st.tests.push(sw.testOnce); // before anything is sent: an id runs once whatever happens
      save();
      const coin = Object.values(paper.coins).sort((a, b) => b.liqUsd - a.liqUsd)[0];
      if (!coin) st.error = "test: no coin list yet";
      else {
        const p = await buy(st, d, { key: "test:" + sw.testOnce, wallet: "test", token: coin.token, symbol: coin.symbol, at: nowMs, usdcIn: HARD.testUsd, test: true }, coin.px, save);
        if (p) await sellPart(st, d, p, 1, coin.px, nowMs, save);
      }
    }
    // 3. buys
    if (sw?.on) {
      for (const e of events) {
        if (e.kind !== "open") continue;
        const c = e.copy;
        const key = keyOf(c);
        if (!open.has(key) || st.positions.some((x) => x.key === key)) continue;
        if (!atBar(paper, c.wallet)) continue; // not counted: most paper copies are of wallets not at the bar yet
        if (realCut(st, c.wallet)) skip(st, "wallet behind on real");
        else if (lossStopped(st, sw)) skip(st, "loss stop");
        else if (st.positions.filter((x) => !x.test).length >= sw.maxOpen) skip(st, "full");
        else if (st.positions.some((x) => x.token === c.token)) skip(st, "coin already held");
        else if (!(px(c.token) > 0)) skip(st, "no price");
        else {
          const usd = sizeUsd(sw, c);
          const b = await d.balances();
          if (b.eth < sw.gasKeepEth) skip(st, "gas low");
          else if (b.usdc < usd + 0.5) skip(st, "no cash");
          else await buy(st, d, { key, wallet: c.wallet, token: c.token, symbol: c.symbol, at: nowMs, usdcIn: usd }, px(c.token), save);
        }
      }
    }
    const b = await d.balances();
    st.usdc = b.usdc;
    st.eth = b.eth;
    st.at = nowMs;
  } catch (e) {
    st.error = short(e);
  }
  save();
}

const r2 = (x: number) => Math.round(x * 100) / 100;
/** For the status and the dashboard. No address in it. */
export function summary(st: LiveState, paper: BaseState, sw: Switch | null, hasWallet: boolean, nowMs: number) {
  const real = st.closed.filter((c) => !c.test);
  const opens = st.positions.map((p) => {
    const px = paper.coins[p.token]?.px ?? 0;
    const worth = (Number(BigInt(p.raw)) / 10 ** p.decimals) * px;
    return { coin: p.symbol, sub: p.test ? "test" : p.wallet.slice(2, 8) + (p.parts ? " · part sold" : ""), t: p.at, paid: r2(p.usdcIn), usd: px ? r2(p.backUsd + worth - p.usdcIn) : null, held: Math.round((nowMs - p.at) / 60_000), stage: p.stage };
  });
  return {
    real: true,
    on: !!sw?.on,
    wallet: hasWallet,
    switch: sw ? { stakeUsd: sw.stakeUsd, maxOpen: sw.maxOpen, maxLossUsd: sw.maxLossUsd, gasKeepEth: sw.gasKeepEth } : null,
    hard: HARD,
    usdc: st.usdc ?? null,
    eth: st.eth ?? null,
    gasLow: sw && st.eth != null ? st.eth < sw.gasKeepEth : null,
    readAt: st.at ?? null,
    closed: real.length,
    won: real.filter((c) => c.usd > 0).length,
    usd: r2(realUsd(st)),
    lossStop: sw ? lossStopped(st, sw) : false,
    inCoinsUsd: r2(opens.reduce((a, o) => a + o.paid + (o.usd ?? 0), 0)),
    opens,
    log: st.closed.slice(-40).reverse().map((c) => ({ coin: c.symbol, sub: c.test ? "test" : c.wallet.slice(2, 8) + (c.parts ? ` · sold in ${c.parts + 1} parts` : "") + (c.est ? " · estimate" : ""), t: c.t, paid: r2(c.usdcIn), usd: r2(c.usd), held: Math.round((c.t - c.at) / 60_000) })),
    tests: st.tests,
    skipped: st.skipped ?? {},
    note: st.note ?? null,
    error: st.error ?? null,
  };
}
