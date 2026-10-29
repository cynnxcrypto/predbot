/**
 * Real orders on Polymarket, driven by one paper variant. OFF unless data/live.json says otherwise.
 *
 * data/live.json (not in git; create it by hand on the Mac):
 *   { "mode": "off" | "dry" | "live", "variant": "band80-30", "size": 5, "maxLossPerDay": 25, "funder": "0x...",
 *     "variants": [{ "variant": "fav93", "size": 5, "haltAfterLosses": 2 }],
 *     "markets": [{ "series": "eth5m", "variant": "cheap10-first90", "size": 2, "maxLossPerDay": 20 }] }
 *   The top-level fields drive the BTC 5m series. `markets` adds one real trader per extra series (keys from
 *   config SERIES); a series without an entry never trades. "mode" is global: "off" stops every series.
 *   A series trades one variant ("variant" + "size") or several ("variants", each with its own size). A variant
 *   with "haltAfterLosses": N stops after N straight losses; the halt is kept in data/<prefix>live-halts.json
 *   (delete its entry, or set "halted": false, to let it trade again). "maxLossPerDay" on a market is the daily loss stop
 *   EACH rule in it gets (29 Oct 2026, enrique: "stop losses per rule, not per window", so a losing rule cannot switch a
 *   winning one off); a variant may carry its own "maxLossPerDay" to override the market's.
 *   "statsSince": "2026-10-23T02:43:00Z" (top level) makes the dashboard (totals, per-variant rows, day table,
 *   trade log) count only trades from then on; older trades stay in the data files. The daily loss stop counts
 *   from then on too.
 *   Each extra series keeps its own files, prefixed like its data (eth5m-live/, eth5m-live-open.json, ...).
 *   - off:  nothing happens (the default when the file is missing).
 *   - dry:  signs the order and logs what it would send, posts nothing.
 *   - live: posts a fill-and-kill buy for `size` dollars, up to the variant's cap, whenever `variant` takes a paper
 *     trade and the ask has not fallen since (see onPaperTrade).
 *   - funder: the Polymarket deposit (proxy) wallet that holds the USDC; orders are signed by the key below.
 *   The file is re-read before every order, so changing "mode" to "off" is the kill switch.
 *
 * data/polygon-keys.json (not in git; the same file Afterclose used):
 *   { "wallet": "<private key hex>", "address": "0x..." }
 *
 * data/polygon-builder.json (not in git; the same file Afterclose used): { "key", "secret", "passphrase" }
 *   Polymarket relayer credentials. Winning shares do not turn back into pUSD by themselves: after a win the
 *   trader asks the relayer to run redeemPositions on the conditional-token contract from the deposit wallet
 *   (gasless, signed by the key above). Without this file wins stay as shares until claimed on polymarket.com.
 *
 * Trades go to data/live/<day>.jsonl and are settled with the window like paper trades.
 */
import { Interface } from "@ethersproject/abi";
import { StaticJsonRpcProvider } from "@ethersproject/providers";
import { Wallet } from "@ethersproject/wallet";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { AssetType, Chain, ClobClient, OrderType, Side, type ApiKeyCreds } from "@polymarket/clob-client-v2";
import { SERIES, prefixOf, type Series, kstDay } from "./config.js";
import type { PaperTrade } from "./paperlive.js";
import { book, marketFor, type Market } from "./polymarket.js";
import { append, loadJson, readAll, saveJson } from "./store.js";

export type LiveMode = "off" | "dry" | "live";
/** "ladder": sizes the rule climbs through on evidence (29 Oct 2026, enrique "adapt sizing if a rule is evolving positively, automatic"):
 *  it starts on the first step; after every 100 settled real fills on this series it climbs one step if the cumulative net
 *  at that mark is positive (and stops climbing at the first mark that is not), and it drops one step whenever the last
 *  100 fills are net negative. The daily loss stop scales with the step (size / first step). See ladderLevel(). */
/** "chaseSec": after an unfilled fill-or-kill, retry every second for this many seconds while the fresh ask is at or under
 *  the cap; with "restUntilLeft" also rest a limit buy at the cap until that many seconds are left in the window (replay says
 *  resting fills 10 more of 96 but loses $65 of the gain: the late fills are the ones that stopped leading), else no rest.
 *  "cap": real order limit in dollars, overriding the paper rule's cap (0.45 on the 40c feed rules since 29 Oct 16:55 KST).
 *  29 Oct 2026 fill audit (enrique: "why are we missing the ones that would win, I want to fix that"): of 367 real feed-rule
 *  orders since the $2 test, the 264 fills won 23% on paper while the 96 "no orders found to match" misses won 59%; the ask is
 *  pulled the second Binance leads and comes back to the cap within 15 s in 71 of 96 cases (61% won, +$106 at $2). */
export type LiveVariant = { variant: string; size: number; haltAfterLosses: number; ladder?: number[]; maxLossPerDay?: number; chaseSec?: number; restUntilLeft?: number; cap?: number };
export type LiveConfig = { mode: LiveMode; variant: string; size: number; maxLossPerDay: number; funder: string; variants: LiveVariant[]; statsSince: number; startBalance: number | null; deposits: number; claimEveryMin: number; minBalance: number; claimBelow: number };
type VariantEntry = { variant?: string; size?: number; haltAfterLosses?: number; ladder?: number[]; maxLossPerDay?: number; chaseSec?: number; restUntilLeft?: number; cap?: number };
type MarketEntry = VariantEntry & { series?: string; maxLossPerDay?: number; mode?: string; variants?: VariantEntry[] };
/** Streak of straight losses per variant and whether it tripped the halt. */
export type Halt = { streak: number; halted: boolean; haltedAt: number | null; paused?: boolean };

/** Taker fee Polymarket charges on these markets (same formula the paper tests use); 0 when nothing filled. */
export function feeOf(cost: number, shares: number): number {
  if (!(shares > 0) || !(cost > 0)) return 0;
  const p = cost / shares;
  return Math.round(0.07 * shares * p * (1 - p) * 1e6) / 1e6;
}

/** Which step of a size ladder a rule has earned, from its settled real fills in order (pnl per fill):
 *  one step up per 100 fills while the cumulative net at each 100-fill mark is positive, one step back when the
 *  last 100 fills are net negative; never below the first step or above the last. */
export function ladderLevel(pnls: number[], ladder: number[]): { level: number; size: number; note: string } {
  const n = pnls.length;
  let level = 0;
  let cum = 0;
  for (let i = 0; i < n; i++) {
    cum += pnls[i];
    if ((i + 1) % 100 === 0) {
      if (cum > 0 && level < ladder.length - 1) level += 1;
      else if (cum <= 0) break;
    }
  }
  let recent = 0;
  if (n >= 100) {
    for (let i = n - 100; i < n; i++) recent += pnls[i];
    if (recent < 0 && level > 0) level -= 1;
  }
  const size = ladder[Math.min(level, ladder.length - 1)];
  const note = n < 100 ? `step 1 of ${ladder.length}: ${n} of 100 fills` : `step ${level + 1} of ${ladder.length}: ${n} fills, last 100 ${recent >= 0 ? "+" : "-"}$${Math.abs(recent).toFixed(0)}`;
  return { level, size, note };
}

/** Rows written before fees were booked: charge the fee now so totals match the wallet. */
function withFee(t: LiveTrade): LiveTrade {
  if (t.fee == null && !t.dry && t.ok && t.shares > 0) {
    t.fee = feeOf(t.cost, t.shares);
    if (t.pnl != null) t.pnl -= t.fee;
  }
  return t;
}

export type BalanceHistory = { points: [number, number][]; deposits: { t: number; amount: number }[]; wallet: [number, number][]; from: number };

/** One balance sample a minute at most, and only when it moved a cent, into data/balance/<day>.jsonl. */
let lastLogged: { t: number; bal: number } | null = null;
function logBalance(bal: number) {
  const now = Date.now();
  if (lastLogged && Math.abs(lastLogged.bal - bal) < 0.01 && now - lastLogged.t < 600_000) return;
  if (lastLogged && now - lastLogged.t < 60_000) return;
  lastLogged = { t: now, bal: Math.round(bal * 100) / 100 };
  append("balance", lastLogged, now);
}

export type LiveDay = { day: string; orders: number; filled: number; skipped: number; noFill: number; settled: number; won: number; net: number };

export type LiveTrade = {
  window: number;
  t: number;
  left: number;
  variant: string;
  side: "UP" | "DOWN";
  token: string;
  /** Ask seen on the paper snapshot. */
  ask: number;
  /** Worst price the order was allowed to pay. */
  limit: number;
  /** Best ask on a fresh look at the book just before sending (null when that look failed). */
  freshAsk?: number | null;
  dry: boolean;
  ok: boolean;
  orderId: string | null;
  status: string | null;
  error: string | null;
  /** Dollars actually paid (makingAmount), shares actually received (takingAmount). */
  cost: number;
  shares: number;
  /** Polymarket's taker fee on crypto markets, charged in pUSD on top of cost: 7% x shares x p x (1 - p). */
  fee?: number;
  resolvedUp: boolean | null;
  won: boolean | null;
  pnl: number | null;
  /** Transaction that turned the winning shares back into pUSD, once it went through. */
  redeemTx?: string | null;
  redeemedAt?: number | null;
};

/** A win whose shares still have to be turned back into pUSD. */
export type Redeem = { window: number; shares: number; tries: number; nextAt: number; lastError: string | null };

const HOST = "https://clob.polymarket.com";
const RELAYER = "https://relayer-v2.polymarket.com";
/** The relayer client wants a signer with a chain connection, even though the relayer pays the gas. */
const RPC = "https://polygon-bor-rpc.publicnode.com";
/** Polymarket's conditional-token contract on Polygon and the collaterals its markets have used. */
const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const COLLATERALS = ["0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"];
const ZERO32 = `0x${"0".repeat(64)}`;
const TOKEN_NAMES = ["pUSD", "USDC.e", "USDC"];
const USDC_E = COLLATERALS[1];
/** Polymarket's CollateralOnramp: converts USDC.e into pUSD 1:1 (claimed winnings come out of the CTF as USDC.e). */
const ONRAMP = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
const erc20 = new Interface(["function balanceOf(address owner) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)"]);
const onrampAbi = new Interface(["function wrap(address _asset, address _to, uint256 _amount)"]);
/** Native USDC (what exchanges send) is not accepted by the onramp; Uniswap v3's 0.01% USDC/USDC.e pool turns it into USDC.e first. */
const USDC_NATIVE = COLLATERALS[2];
const UNISWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const routerAbi = new Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
type Swap = { want: number; amount: number; tx: string | null; at: number; error: string | null };
const provider = new StaticJsonRpcProvider(RPC, 137);
const ctfAbi = new Interface([
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
  "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)",
  "function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)",
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
]);

/** Winning shares the funds wallet still holds for a condition, over every collateral and both outcomes. */
async function sharesHeld(funder: string, conditionId: string): Promise<number> {
  let total = 0n;
  for (const indexSet of [1, 2]) {
    const coll = await provider.call({ to: CTF, data: ctfAbi.encodeFunctionData("getCollectionId", [ZERO32, conditionId, indexSet]) });
    const collectionId = ctfAbi.decodeFunctionResult("getCollectionId", coll)[0] as string;
    for (const collateral of COLLATERALS) {
      const pos = await provider.call({ to: CTF, data: ctfAbi.encodeFunctionData("getPositionId", [collateral, collectionId]) });
      const positionId = ctfAbi.decodeFunctionResult("getPositionId", pos)[0] as { toString(): string };
      const bal = await provider.call({ to: CTF, data: ctfAbi.encodeFunctionData("balanceOf", [funder, positionId.toString()]) });
      total += BigInt(bal);
    }
  }
  return Number(total) / 1e6;
}
const DEFAULT: LiveConfig = { mode: "off", variant: "band80-30", size: 5, maxLossPerDay: 25, funder: "", variants: [], statsSince: 0, startBalance: null, deposits: 0, claimEveryMin: 60, minBalance: 0, claimBelow: 60 };

const sizeOf = (raw: unknown) => {
  const size = Number(raw ?? DEFAULT.size);
  return Number.isFinite(size) && size > 0 ? Math.min(size, 50) : DEFAULT.size;
};

type RawVariant = { variant?: string; size?: number; haltAfterLosses?: number; ladder?: number[]; maxLossPerDay?: number; chaseSec?: number; restUntilLeft?: number; cap?: number };
type RawMarket = { series?: string; mode?: string; maxLossPerDay?: number; variants?: RawVariant[] };
type RawLive = RawMarket & { markets?: RawMarket[]; variant?: string; size?: number; haltAfterLosses?: number };

/** Put a paper rule on real money for one market: adds it to data/live.json (read again before every order, so no restart). */
export function addLiveRule(seriesKey: string, variant: string, size = DEFAULT.size, haltAfterLosses = 2) {
  const file = loadJson<RawLive>("live.json", {});
  const entry: RawVariant = { variant, size: sizeOf(size), haltAfterLosses };
  if (!seriesKey) {
    const list = Array.isArray(file.variants) && file.variants.length ? file.variants : file.variant ? [{ variant: file.variant, size: file.size, haltAfterLosses: file.haltAfterLosses }] : [];
    if (list.some((v) => v.variant === variant)) return { changed: false };
    file.variants = [...list, entry];
    delete file.variant;
  } else {
    file.markets = Array.isArray(file.markets) ? file.markets : [];
    let m = file.markets.find((x) => x.series === seriesKey);
    if (!m) {
      m = { series: seriesKey, maxLossPerDay: seriesKey.includes("15m") ? 25 : 15, variants: [] };
      file.markets.push(m);
    }
    m.variants = Array.isArray(m.variants) ? m.variants : [];
    if (m.variants.some((v) => v.variant === variant)) return { changed: false };
    if (m.mode === "off") delete m.mode;
    m.variants.push(entry);
  }
  saveJson("live.json", file);
  return { changed: true };
}

/** Take a rule off real money for one market: removes it from data/live.json; a market with no rules left is removed too. */
export function removeLiveRule(seriesKey: string, variant: string) {
  const file = loadJson<RawLive>("live.json", {});
  if (!seriesKey) {
    const list = Array.isArray(file.variants) && file.variants.length ? file.variants : file.variant ? [{ variant: file.variant, size: file.size, haltAfterLosses: file.haltAfterLosses }] : [];
    if (!list.some((v) => v.variant === variant)) return { changed: false };
    file.variants = list.filter((v) => v.variant !== variant);
    delete file.variant;
  } else {
    const m = (file.markets ?? []).find((x) => x.series === seriesKey);
    if (!m || !(m.variants ?? []).some((v) => v.variant === variant)) return { changed: false };
    m.variants = (m.variants ?? []).filter((v) => v.variant !== variant);
    if (!m.variants.length) file.markets = (file.markets ?? []).filter((x) => x !== m);
  }
  saveJson("live.json", file);
  return { changed: true };
}

/** Minimum real bet: Polymarket wants $1 and at least 5 shares, so a 93c favourite needs ~$4.65 while a 17c long shot fills from $1. */
export const MIN_SIZE = 1;
/** Change one real rule's bet size in data/live.json ($1 to $50). The trader re-reads the file before every order. */
export function setLiveRuleSize(seriesKey: string, variant: string, size: number, ladder: number[] | null = null) {
  const file = loadJson<RawLive>("live.json", {});
  const clamp = (x: number) => Math.max(MIN_SIZE, Math.min(50, Math.round(x * 100) / 100));
  const steps = ladder && ladder.length > 1 ? ladder.map(clamp) : null;
  const next = steps ? steps[0] : clamp(size);
  let list: RawVariant[];
  if (!seriesKey) {
    list = Array.isArray(file.variants) && file.variants.length ? file.variants : file.variant ? [{ variant: file.variant, size: file.size, haltAfterLosses: file.haltAfterLosses }] : [];
    file.variants = list;
    delete file.variant;
  } else {
    const m = (file.markets ?? []).find((x) => x.series === seriesKey);
    list = m?.variants ?? [];
  }
  const v = list.find((x) => x.variant === variant);
  if (!v) return { changed: false, size: null };
  const sameLadder = (steps ? JSON.stringify(steps) : null) === (Array.isArray(v.ladder) && v.ladder.length > 1 ? JSON.stringify(v.ladder) : null);
  if (v.size === next && sameLadder) return { changed: false, size: next };
  v.size = next;
  if (steps) v.ladder = steps;
  else delete v.ladder;
  saveJson("live.json", file);
  return { changed: true, size: next };
}

/** Change one real rule's loss halt in data/live.json: stop after N straight losses (0 = never). Re-read before every order. */
export function setLiveRuleHalt(seriesKey: string, variant: string, losses: number) {
  const file = loadJson<RawLive>("live.json", {});
  const next = Math.max(0, Math.min(50, Math.round(losses)));
  let list: RawVariant[];
  if (!seriesKey) {
    list = Array.isArray(file.variants) && file.variants.length ? file.variants : file.variant ? [{ variant: file.variant, size: file.size, haltAfterLosses: file.haltAfterLosses }] : [];
    file.variants = list;
    delete file.variant;
  } else {
    const m = (file.markets ?? []).find((x) => x.series === seriesKey);
    list = m?.variants ?? [];
  }
  const v = list.find((x) => x.variant === variant);
  if (!v) return { changed: false, losses: null };
  if (v.haltAfterLosses === next) return { changed: false, losses: next };
  v.haltAfterLosses = next;
  saveJson("live.json", file);
  return { changed: true, losses: next };
}

/** Change one market's daily loss stop in data/live.json ($5 to $500); with a variant name, that one rule's own stop.
 *  Re-read before every order. */
export function setLiveMaxLoss(seriesKey: string, maxLoss: number, variant = "") {
  const file = loadJson<RawLive>("live.json", {});
  const next = Math.max(5, Math.min(500, Math.round(maxLoss)));
  let target: { maxLossPerDay?: number; variants?: RawVariant[] } | undefined = file;
  if (seriesKey) target = (file.markets ?? []).find((x) => x.series === seriesKey);
  if (target && variant) {
    const list = Array.isArray(target.variants) && target.variants.length ? target.variants : (target as RawLive).variant ? [{ variant: (target as RawLive).variant, size: (target as RawLive).size, haltAfterLosses: (target as RawLive).haltAfterLosses }] : [];
    const v = list.find((x) => x.variant === variant);
    if (!v) return { changed: false, maxLoss: null };
    if (!Array.isArray(target.variants) || !target.variants.length) { (target as RawLive).variants = list; delete (target as RawLive).variant; }
    target = v;
  }
  if (!target) return { changed: false, maxLoss: null };
  if (target.maxLossPerDay === next) return { changed: false, maxLoss: next };
  target.maxLossPerDay = next;
  saveJson("live.json", file);
  return { changed: true, maxLoss: next };
}

export function liveConfig(seriesKey = ""): LiveConfig {
  const file = loadJson<Partial<Omit<LiveConfig, "statsSince">> & MarketEntry & { markets?: MarketEntry[]; statsSince?: string | number }>("live.json", {});
  const since = typeof file.statsSince === "number" ? file.statsSince : Date.parse(String(file.statsSince ?? ""));
  // "startBalance": what the wallet held before the first real order; the dashboard compares wallet and ledger against it.
  const startBalance = Number.isFinite(Number(file.startBalance)) && Number(file.startBalance) > 0 ? Number(file.startBalance) : null;
  // "deposits": money added to the wallet after startBalance (top-ups), so the wallet-vs-ledger line can account for it.
  const deposits = Number.isFinite(Number(file.deposits)) ? Number(file.deposits) : 0;
  // "claimEveryMin": wins are claimed in one relayer transaction this often (the relayer has a daily quota; 23 Oct 2026 it ran
  // out after ~65 transactions). Winning shares are safe while they wait.
  const claimEveryMin = Number.isFinite(Number(file.claimEveryMin)) && Number(file.claimEveryMin) >= 1 ? Number(file.claimEveryMin) : DEFAULT.claimEveryMin;
  // "claimBelow": when the wallet drops under this many dollars, wins are claimed at once (5 min apart at most) instead of waiting for the timer; 0 turns it off.
  const claimBelow = Number.isFinite(Number(file.claimBelow)) && Number(file.claimBelow) >= 0 ? Number(file.claimBelow) : DEFAULT.claimBelow;
  // "minBalance": no new real orders while the wallet's pUSD is under this (0 = no floor). Re-read before every order.
  const minBalance = Number.isFinite(Number(file.minBalance)) && Number(file.minBalance) > 0 ? Number(file.minBalance) : 0;
  const globalMode: LiveMode = file.mode === "live" || file.mode === "dry" ? file.mode : "off";
  let raw: MarketEntry = file;
  let mode = globalMode;
  if (seriesKey) {
    const entry = (file.markets ?? []).find((m) => m.series === seriesKey);
    // A market with no entry has no rules, but manual bets from the dashboard still follow the global mode (27 Oct 2026: enrique wanted the UP/DOWN buttons on every market).
    if (!entry) return { ...DEFAULT, mode: globalMode, variants: [], variant: "", funder: String(file.funder ?? "").trim(), statsSince: Number.isFinite(since) ? since : 0, startBalance, deposits, claimEveryMin, minBalance, claimBelow };
    raw = entry;
    // A market may be quieter than the global mode (off or dry), never louder.
    if (entry.mode === "off" || (entry.mode === "dry" && globalMode === "live")) mode = entry.mode;
  }
  const maxLossPerDay = Number(raw.maxLossPerDay ?? DEFAULT.maxLossPerDay);
  // An explicit "variants" list is taken as is, even when empty (a market with no rules trades nothing); the old
  // single-"variant" form still works. There is no built-in fallback rule any more: an empty list used to turn into
  // band80-30 silently, which is how a removed rule kept reappearing on the dashboard (24 Oct 2026).
  const list: VariantEntry[] = Array.isArray(raw.variants) ? raw.variants : [raw];
  const variants: LiveVariant[] = [];
  for (const v of list) {
    const name = String(v.variant ?? "").trim();
    const halt = Number(v.haltAfterLosses ?? 0);
    const ladder = Array.isArray(v.ladder) ? v.ladder.map((x) => sizeOf(Number(x))).filter((x) => Number.isFinite(x) && x > 0) : [];
    const own = Array.isArray(raw.variants) ? Number(v.maxLossPerDay) : NaN; // single-"variant" form: the number is the market's, not the rule's
    const chase = Number(v.chaseSec ?? 0);
    const capOwn = Number(v.cap);
    const restLeft = Number(v.restUntilLeft);
    if (name && !variants.some((x) => x.variant === name)) variants.push({ variant: name, size: ladder.length ? ladder[0] : sizeOf(v.size), haltAfterLosses: Number.isFinite(halt) && halt > 0 ? Math.floor(halt) : 0, ...(ladder.length > 1 ? { ladder } : {}), ...(Number.isFinite(own) && own > 0 ? { maxLossPerDay: own } : {}), ...(Number.isFinite(capOwn) && capOwn > 0 && capOwn < 1 ? { cap: capOwn } : {}), ...(Number.isFinite(chase) && chase > 0 ? { chaseSec: Math.min(120, chase), ...(Number.isFinite(restLeft) && restLeft >= 0 ? { restUntilLeft: restLeft } : {}) } : {}) });
  }
  return {
    mode,
    variant: variants[0]?.variant ?? "",
    size: variants[0]?.size ?? DEFAULT.size,
    maxLossPerDay: Number.isFinite(maxLossPerDay) && maxLossPerDay > 0 ? maxLossPerDay : DEFAULT.maxLossPerDay,
    funder: String(file.funder ?? "").trim(),
    variants,
    statsSince: Number.isFinite(since) ? since : 0,
    startBalance,
    deposits,
    claimEveryMin,
    claimBelow,
    minBalance,
  };
}

/** Relayer transactions sent per UTC day (data/relayer-usage.json), so the dashboard can project whether the ~65/day quota lasts until the 00:00 UTC reset. */
const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
function noteRelayCall() {
  const file = loadJson<Record<string, number>>("relayer-usage.json", {});
  const day = utcDay();
  file[day] = (file[day] ?? 0) + 1;
  for (const k of Object.keys(file)) if (k < utcDay(Date.now() - 3 * 86400000)) delete file[k];
  saveJson("relayer-usage.json", file);
}
export function relayerUsedToday(): number {
  return loadJson<Record<string, number>>("relayer-usage.json", {})[utcDay()] ?? 0;
}
/** The relayer runs one batch at a time from our wallet; the traders share this lock. */
let relayBusy = false;
/** Every trader, so the BTC 5m one can claim all series' wins in one transaction. */
const traders: LiveTrader[] = [];
/** When the relayer said its daily quota is used up: nothing is sent until this time. */
let relayerBlockedUntil = 0;
/** When the last claim batch went out. */
let lastClaimAt = 0;
/** After a failed batch, try the oldest window alone next time. */
let claimSingles = false;
/** After a failed batch, leave the wrap out next time (a window claimed by hand on polymarket.com pays nothing here). */
let claimNoWrap = false;
let lastVerifyAt = 0;
/** More windows were waiting than one batch takes (after a quota pause): batches then go out every 5 minutes. */
let claimBacklog = false;

/** Reads "quota exceeded ... resets in N seconds" out of a relayer error and pauses relayer work until then. */
function noteRelayError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  const m = /resets in (\d+) seconds/.exec(text);
  if (/429|quota exceeded/i.test(text)) {
    relayerBlockedUntil = Date.now() + (m ? Number(m[1]) * 1000 : 3600_000) + 60_000;
    console.log(`live: relayer quota used up, claims and conversions wait until ${new Date(relayerBlockedUntil).toISOString().slice(11, 16)} UTC`);
  }
  return text;
}
function relayerBlocked() {
  return Date.now() < relayerBlockedUntil;
}

export class LiveTrader {
  readonly series: Series;
  /** "" for BTC 5m, "eth5m-" and so on for the others; prefixes every file this trader writes. */
  readonly prefix: string;
  config: LiveConfig;
  open: LiveTrade[];
  trades = 0;
  won = 0;
  net = 0;
  private dayNet = new Map<string, number>();
  /** Net per day and variant ("day|variant"), so the dashboard can show only the rules still configured. */
  private dayVarNet = new Map<string, number>();
  /** day|variant keys whose daily stop was logged, so the notice prints once a day per rule. */
  private dayStopped = new Set<string>();
  /** Per-day, per-variant counts (trades, won, net), keyed "day|variant", for the today columns on the dashboard. */
  private dayVar = new Map<string, { trades: number; won: number; net: number }>();
  /** Settled pnl per variant in settlement order, for the size ladder. */
  private fills = new Map<string, number[]>();
  /** Settled totals per variant, for the status page. */
  private byVariant = new Map<string, { trades: number; won: number; net: number }>();
  /** Loss streaks per variant (see haltAfterLosses). */
  halts: Record<string, Halt>;
  /** How closed windows look on our own Chainlink feed (true = up) until Polymarket settles them; see provisional(). */
  private likely = new Map<number, boolean>();
  lastError: string | null = null;
  lastOrderAt: number | null = null;
  wallet: string | null = null;
  balance: number | null = null;
  ready = false;
  /** The last real orders, newest first, for the status page (settled, open and failed). */
  recent: LiveTrade[] = [];
  /** Wins waiting to be turned back into pUSD. */
  redeems: Redeem[];
  lastRedeem: { window: number; tx: string | null; at: number; error: string | null } | null = null;
  /** What the funds wallet holds on chain, by token, read straight from Polygon. */
  chain: Record<string, number> | null = null;
  lastWrap: { amount: number; tx: string | null; at: number; error: string | null } | null = null;
  private wrapping = false;
  lastSwap: Swap | null = null;
  private swapping = false;
  private lastTradeSync = 0;
  private client: ClobClient | null = null;
  private signer: Wallet | null = null;
  private creds: ApiKeyCreds | null = null;
  private starting: Promise<void> | null = null;
  private redeeming = false;

  constructor(series: Series = SERIES[0]) {
    traders.push(this);
    this.series = series;
    this.prefix = prefixOf(series);
    this.config = liveConfig(series.key);
    this.open = loadJson<LiveTrade[]>(`${this.prefix}live-open.json`, []);
    this.redeems = loadJson<Redeem[]>(`${this.prefix}live-redeem.json`, []);
    this.halts = loadJson<Record<string, Halt>>(`${this.prefix}live-halts.json`, {});
    const totals = loadJson<LiveTrade[]>(`${this.prefix}live-totals.json`, []);
    if (totals.some((t) => t.fee == null && t.ok && t.shares > 0 && !t.dry)) saveJson(`${this.prefix}live-totals.json`, totals.map(withFee));
    for (const t of totals) this.count(withFee(t));
    // Recent rows include skipped and unfilled orders, which live only in the day files, so the log looks the same after a restart.
    const logged = readAll<LiveTrade>(`${this.prefix}live`).filter((t) => !t.dry && t.t >= this.config.statsSince).map(withFee).sort((a, b) => b.t - a.t);
    this.recent = [...this.open, ...logged].slice(0, 40);
    // Wins from before the claim step existed (or from a crash) are still shares: queue them too.
    const cutoff = Date.now() / 1000 - 3 * 86400;
    for (const t of totals) {
      if (t.won && !t.dry && t.shares > 0 && !t.redeemTx && t.window > cutoff && !this.redeems.some((r) => r.window === t.window)) {
        this.redeems.push({ window: t.window, shares: t.shares, tries: 0, nextAt: 0, lastError: null });
      }
    }
    if (this.redeems.length) saveJson(`${this.prefix}live-redeem.json`, this.redeems);
  }

  /** Today's (KST) unfilled real orders per rule (no fill or skipped), so the rule row can say "1 trade, 2 no fill"; rebuilt at most once a minute. */
  private missesCache: { at: number; day: string; misses: Map<string, number> } | null = null;
  private missesToday(): Map<string, number> {
    const day = kstDay();
    if (this.missesCache && this.missesCache.day === day && Date.now() - this.missesCache.at < 60_000) return this.missesCache.misses;
    const misses = new Map<string, number>();
    for (const t of readAll<LiveTrade>(`${this.prefix}live`)) {
      if (t.dry || t.t < this.config.statsSince || kstDay(t.window * 1000) !== day) continue;
      if (t.ok && t.shares > 0) continue;
      misses.set(t.variant, (misses.get(t.variant) ?? 0) + 1);
    }
    this.missesCache = { at: Date.now(), day, misses };
    return misses;
  }

  /** Per-UTC-day summary of every real order row (filled, skipped, no fill), rebuilt at most once a minute. */
  private daysCache: { at: number; days: LiveDay[] } | null = null;
  days(): LiveDay[] {
    if (this.daysCache && Date.now() - this.daysCache.at < 60_000) return this.daysCache.days;
    const byDay = new Map<string, LiveDay>();
    for (const t of readAll<LiveTrade>(`${this.prefix}live`)) {
      if (t.dry || t.t < this.config.statsSince) continue;
      const day = kstDay(t.window * 1000);
      let d = byDay.get(day);
      if (!d) byDay.set(day, (d = { day, orders: 0, filled: 0, skipped: 0, noFill: 0, settled: 0, won: 0, net: 0 }));
      d.orders += 1;
      if (t.status === "skipped") d.skipped += 1;
      else if (!t.ok || t.shares <= 0) d.noFill += 1;
      else d.filled += 1;
    }
    // Settled results come from the totals file (the day rows above are written at order time, before the result is known).
    for (const t of loadJson<LiveTrade[]>(`${this.prefix}live-totals.json`, []).map(withFee)) {
      if (t.dry || t.pnl == null || t.t < this.config.statsSince) continue;
      const day = kstDay(t.window * 1000);
      let d = byDay.get(day);
      if (!d) byDay.set(day, (d = { day, orders: 0, filled: 0, skipped: 0, noFill: 0, settled: 0, won: 0, net: 0 }));
      d.settled += 1;
      if (t.won) d.won += 1;
      d.net = Math.round((d.net + t.pnl) * 100) / 100;
    }
    const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
    this.daysCache = { at: Date.now(), days };
    return days;
  }

  private remember(row: LiveTrade) {
    this.daysCache = null;
    this.missesCache = null;
    this.recent = [row, ...this.recent.filter((t) => t !== row)].slice(0, 40);
  }

  private count(t: LiveTrade) {
    if (t.dry || t.pnl == null) return;
    // Everything on the dashboard (totals, day table, per-variant rows, log) starts at statsSince; older trades stay in the files.
    if (t.t < this.config.statsSince) return;
    this.trades += 1;
    if (t.won) this.won += 1;
    this.net += t.pnl;
    // Per-day totals keyed by the window's day, so a trade settled late (after a restart) still lands on its own day.
    const day = kstDay(t.window * 1000);
    this.dayNet.set(day, (this.dayNet.get(day) ?? 0) + t.pnl);
    this.dayVarNet.set(`${day}|${t.variant}`, (this.dayVarNet.get(`${day}|${t.variant}`) ?? 0) + t.pnl);
    let dv = this.dayVar.get(`${day}|${t.variant}`);
    if (!dv) this.dayVar.set(`${day}|${t.variant}`, (dv = { trades: 0, won: 0, net: 0 }));
    dv.trades += 1;
    if (t.won) dv.won += 1;
    dv.net += t.pnl;
    let v = this.byVariant.get(t.variant);
    if (!v) this.byVariant.set(t.variant, (v = { trades: 0, won: 0, net: 0 }));
    v.trades += 1;
    if (t.won) v.won += 1;
    v.net += t.pnl;
    if (t.ok && t.shares > 0) {
      let f = this.fills.get(t.variant);
      if (!f) this.fills.set(t.variant, (f = []));
      f.push(t.pnl);
    }
  }

  /** The size a rule trades at now: its ladder step when it has one, else its fixed size. */
  sizeFor(rule: LiveVariant): { size: number; mult: number; note: string | null } {
    if (!rule.ladder || rule.ladder.length < 2) return { size: rule.size, mult: 1, note: null };
    const step = ladderLevel(this.fills.get(rule.variant) ?? [], rule.ladder);
    return { size: step.size, mult: step.size / rule.ladder[0], note: step.note };
  }

  /** Update a variant's loss streak after a settled trade and trip its halt when it reaches the limit. */
  private track(t: LiveTrade) {
    if (t.dry || t.pnl == null) return;
    const rule = this.config.variants.find((v) => v.variant === t.variant);
    // Re-read first so a halt set or cleared by hand in the file is kept, not overwritten.
    this.halts = loadJson<Record<string, Halt>>(`${this.prefix}live-halts.json`, this.halts);
    const h = this.halts[t.variant] ?? { streak: 0, halted: false, haltedAt: null };
    h.streak = t.won ? 0 : h.streak + 1;
    if (rule && rule.haltAfterLosses > 0 && h.streak >= rule.haltAfterLosses && !h.halted) {
      h.halted = true;
      h.haltedAt = Date.now();
      console.log(`live ${this.series.label}: ${t.variant} HALTED after ${h.streak} straight losses (edit data/${this.prefix}live-halts.json to resume)`);
    }
    this.halts[t.variant] = h;
    saveJson(`${this.prefix}live-halts.json`, this.halts);
  }

  /** Net result of the trades settled on today's windows (Korean day). */
  get todayNet() {
    return this.dayNet.get(kstDay()) ?? 0;
  }

  /** Loss counted against the daily stop: today's rule trades only. Bets placed by hand are enrique's own call and
   *  do not switch the rules off (enrique, 25 Oct 2026: "the manual strats should for sure reset everyday"). */
  private todayLoss() {
    const manual = this.dayVarNet.get(`${kstDay()}|manual`) ?? 0;
    return -(this.todayNet - manual);
  }

  /** Today's loss of one rule, the number its own daily stop is measured against (29 Oct 2026: per rule, not per market). */
  private ruleLoss(variant: string) {
    return -(this.dayVarNet.get(`${kstDay()}|${variant}`) ?? 0);
  }

  private ruleStop(rule: LiveVariant, mult = 1) {
    return (rule.maxLossPerDay ?? this.config.maxLossPerDay) * mult;
  }

  /** Load keys, derive API credentials, read the balance. Safe to call many times. */
  async start(): Promise<void> {
    this.config = liveConfig(this.series.key);
    if (this.config.mode === "off") return;
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        const keys = loadJson<{ wallet?: string; address?: string }>("polygon-keys.json", {});
        const pk = String(keys.wallet ?? "").trim();
        if (!pk) throw new Error("data/polygon-keys.json has no wallet key");
        if (!this.config.funder) throw new Error("data/live.json has no funder address");
        const signer = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
        const base = new ClobClient({ host: HOST, chain: Chain.POLYGON, signer, signatureType: 3, funderAddress: this.config.funder });
        // Neither call has a timeout of its own: on 27 Oct 2026 the XRP 5m trader hung here from the 00:25 KST restart on
        // (no state write, no orders, while its paper rule fired 30 times) and `starting` never cleared, so nothing retried.
        // A 20 s cap turns a stalled start into a failed one, which the minute refresh retries.
        const timed = <T>(p: Promise<T>, what: string) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`${what} timed out after 20s`)), 20_000).unref())]);
        const creds = await timed(base.createOrDeriveApiKey(), "deriving the API key");
        const client = new ClobClient({ host: HOST, chain: Chain.POLYGON, signer, creds, signatureType: 3, funderAddress: this.config.funder });
        const bal = await timed(client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }), "reading the balance");
        this.balance = Number(bal.balance) / 1e6;
        this.signer = signer;
        this.creds = creds;
        this.client = client;
        this.wallet = signer.address;
        // A resting cheap-rule order left behind by a restart would fill unseen; the BTC 5m trader (first to start,
        // same signer for every market) cancels everything still open on the exchange. All other orders are fill-or-kill.
        if (!this.series.key) await client.cancelAll().then(() => console.log("live: cancelled any resting orders from before the restart")).catch((e: unknown) => console.log(`live: cancelAll failed (${e instanceof Error ? e.message : String(e)})`));
        this.ready = true;
        this.lastError = null;
        saveJson(`${this.prefix}live-state.json`, { at: Date.now(), ...this.status() });
        console.log(`live ${this.series.label}: ${this.config.mode.toUpperCase()} mode, signer ${signer.address}, funder ${this.config.funder}, balance $${this.balance.toFixed(2)}, ${this.config.variants.map((v) => `${v.variant} at $${v.size}${v.haltAfterLosses ? ` (halt after ${v.haltAfterLosses} losses)` : ""}`).join(", ")}, stop after -$${this.config.maxLossPerDay} in a day`);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        saveJson(`${this.prefix}live-state.json`, { at: Date.now(), ...this.status() });
        console.log(`live: not ready (${this.lastError})`);
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  /** Re-read the collateral balance (called about once a minute by the recorder). */
  async refreshBalance() {
    this.config = liveConfig(this.series.key);
    if (this.config.mode === "off") return;
    if (!this.ready) return this.start();
    if (!this.client) return;
    try {
      // The exchange caches balances; ask it to look again before reading.
      await this.client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL }).catch(() => undefined);
      const bal = await this.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      this.balance = Number(bal.balance) / 1e6;
      if (!this.series.key) logBalance(this.balance);
      // The "under the floor" notice used to wait for the next signal to clear; drop it as soon as the wallet is back over the floor.
      if (this.lastError && this.lastError.startsWith("paused: balance") && !(this.config.minBalance > 0 && this.balance < this.config.minBalance)) this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    if (!this.series.key) try {
      const data = erc20.encodeFunctionData("balanceOf", [this.config.funder]);
      const raw = await Promise.all(COLLATERALS.map((token) => provider.call({ to: token, data })));
      const chain: Record<string, number> = {};
      raw.forEach((hex, i) => { chain[TOKEN_NAMES[i]] = Number(BigInt(hex)) / 1e6; });
      this.chain = chain;
    } catch {
      // chain read is best effort
    }
    saveJson(`${this.prefix}live-state.json`, { at: Date.now(), ...this.status() });
    if (!this.series.key && Date.now() - this.lastTradeSync > 3600_000) void this.syncTrades();
  }

  /**
   * Once an hour, copy our fills as the exchange recorded them (price, size, fee rate, status, transaction) into
   * data/exchange-trades.json, so the ledger here can be checked against what the wallet actually paid and received.
   */
  async syncTrades() {
    if (!this.client) return;
    this.lastTradeSync = Date.now();
    try {
      const trades = await this.client.getTrades();
      const rows = trades.map((t) => ({
        id: t.id,
        time: t.match_time,
        side: t.side,
        outcome: t.outcome,
        asset: t.asset_id,
        price: Number(t.price),
        size: Number(t.size),
        feeRateBps: Number(t.fee_rate_bps),
        status: t.status,
        tx: t.transaction_hash ?? null,
        takerOrder: t.taker_order_id,
        traderSide: t.trader_side,
      }));
      saveJson("exchange-trades.json", { at: Date.now(), count: rows.length, trades: rows });
    } catch (error) {
      console.log(`live: could not fetch the exchange trade history (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /** Called when a paper variant takes a trade. Mirrors it for real when that variant is the live one. */
  /**
   * `first` is set for the early cheap rules (buy within the first `first` seconds of the window): when their
   * fill-or-kill finds nothing, the order is retried for 10 s and then left resting at the cap until that phase ends.
   */
  async onPaperTrade(trade: PaperTrade, market: Market, cap: number, skipOnFall = true, first: number | null = null) {
    this.config = liveConfig(this.series.key);
    const rule = this.config.variants.find((v) => v.variant === trade.variant);
    if (this.config.mode === "off" || !rule) return;
    // Halts are read from the file before every order, so editing data/<prefix>live-halts.json takes effect at once.
    this.halts = loadJson<Record<string, Halt>>(`${this.prefix}live-halts.json`, this.halts);
    if (this.halts[trade.variant]?.halted || this.halts[trade.variant]?.paused) return;
    if (this.open.some((t) => t.window === trade.window && t.variant === trade.variant)) return;
    // Settlement lags the close by minutes: a loss our own feed can already see counts toward the halt now.
    if (rule.haltAfterLosses > 0) {
      const pending = this.pendingLosses(trade.variant);
      if (pending && (this.halts[trade.variant]?.streak ?? 0) + pending >= rule.haltAfterLosses) {
        console.log(`live ${this.series.label}: ${trade.variant} skipped window ${trade.window}, ${pending} unsettled trade(s) look lost and would trip the halt`);
        return;
      }
    }
    const { size, mult } = this.sizeFor(rule);
    if (this.ruleLoss(trade.variant) >= this.ruleStop(rule, mult)) {
      const key = `${kstDay()}|${trade.variant}`;
      if (!this.dayStopped.has(key)) console.log(`live ${this.series.label}: ${trade.variant} reached its daily loss stop (-$${this.ruleLoss(trade.variant).toFixed(2)} of $${this.ruleStop(rule, mult)}), no more orders from it today`);
      this.dayStopped.add(key);
      return;
    }
    // A new Korean day (or a raised stop) lifts the limit: drop the stale notice so the dashboard stops showing it.
    if (this.lastError === "daily loss limit reached") this.lastError = null;
    if (this.config.minBalance > 0 && this.balance != null && this.balance < this.config.minBalance) {
      const msg = `paused: balance $${this.balance.toFixed(2)} is under the $${this.config.minBalance} floor`;
      if (this.lastError !== msg) console.log(`live ${this.series.label}: ${msg}`);
      this.lastError = msg;
      return;
    }
    if (this.lastError && this.lastError.startsWith("paused: balance")) this.lastError = null;
    if (!this.ready) await this.start();
    if (!this.ready || !this.client) return;
    const token = trade.side === "UP" ? market.upToken : market.downToken;
    // Fill rule from the recorded books (62 paper windows, 16-19 Oct): the fill-or-kill at ask+2c filled the
    // windows where the ask had fallen since the snapshot (76% won) and missed the ones where it had jumped
    // (100% won). So take a fresh look at the book, skip when the ask fell by 1c or more (sub-cent dips are noise), and otherwise pay up to the cap.
    let freshAsk: number | null = null;
    try {
      freshAsk = (await book(token, 1500)).bestAsk;
    } catch {
      freshAsk = null;
    }
    // The exchange takes prices on a 1c grid between 1c and 99c; a 99.5c cap (fav93) must be sent as 99c.
    // "cap" on the live.json entry overrides the paper rule's cap for the real order (29 Oct: enrique chose 45c for the 40c feed rules).
    const limit = Math.min(0.99, Math.max(0.01, Math.round((rule.cap ?? cap) * 100) / 100));
    const row: LiveTrade = {
      window: trade.window,
      t: Date.now(),
      left: trade.left,
      variant: trade.variant,
      side: trade.side,
      token,
      ask: trade.ask,
      limit,
      freshAsk,
      dry: this.config.mode === "dry",
      ok: false,
      orderId: null,
      status: null,
      error: null,
      cost: 0,
      shares: 0,
      resolvedUp: null,
      won: null,
      pnl: null,
    };
    if (skipOnFall && freshAsk != null && freshAsk <= trade.ask - 0.01 + 1e-9) {
      row.status = "skipped";
      row.error = `ask fell to ${Math.round(freshAsk * 100)}c`;
      console.log(`live: skipped ${trade.side}, ask fell from ${Math.round(trade.ask * 100)}c to ${Math.round(freshAsk * 100)}c`);
      this.remember(row);
      saveJson(`${this.prefix}live-state.json`, { at: Date.now(), ...this.status(), lastTrade: row });
      append(`${this.prefix}live`, row, trade.window * 1000);
      return;
    }
    try {
      const order = await this.client.createMarketOrder(
        { tokenID: token, amount: size, side: Side.BUY, price: limit, orderType: OrderType.FAK },
        { tickSize: "0.01", negRisk: false },
      );
      if (row.dry) {
        row.ok = true;
        row.status = "dry";
        console.log(`live DRY: would buy ${trade.side} up to ${Math.round(limit * 100)}c for $${size} with ${trade.left}s left (order signed, not sent)`);
      } else {
        const res = await this.client.postOrder(order, OrderType.FAK);
        row.ok = Boolean(res?.success);
        row.orderId = res?.orderID ?? null;
        row.status = res?.status ?? null;
        const detail = (res as unknown as { error?: unknown })?.error;
        row.error = res?.success ? null : (res?.errorMsg || (detail ? JSON.stringify(detail).slice(0, 200) : "order rejected"));
        row.cost = Number(res?.makingAmount) || 0;
        row.shares = Number(res?.takingAmount) || 0;
        row.fee = feeOf(row.cost, row.shares);
        this.lastOrderAt = Date.now();
        if (row.ok && row.shares > 0) {
          console.log(`live: bought ${row.shares.toFixed(2)} ${trade.side} for $${row.cost.toFixed(2)} (${Math.round((row.cost / row.shares) * 100)}c) with ${trade.left}s left`);
        } else {
          console.log(`live: order not filled (${row.error ?? row.status ?? "no fill"})`);
        }
      }
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
      this.lastError = row.error;
      console.log(`live: order failed (${row.error})`);
    }
    // Cheap early rules: at 17c there is often nothing resting the second paper fires (4 of the first 8 real orders on
    // 26 Oct 2026 died with "no orders found to match"), while on the books the ask is still at the cap within 10 s in
    // 88% of windows. enrique, 27 Oct 00:16 KST: "okay do retry and rest".
    if (first != null && !row.dry && !(row.ok && row.shares > 0)) await this.chase(row, trade, token, limit, size, (trade.window + first) * 1000, 10_000);
    else if (rule.chaseSec && !row.dry && !(row.ok && row.shares > 0) && !row.status?.toString().startsWith("skipped")) await this.chase(row, trade, token, limit, size, rule.restUntilLeft != null ? (trade.window + this.series.windowSec - rule.restUntilLeft) * 1000 : Date.now() + rule.chaseSec * 1000, rule.chaseSec * 1000);
    this.remember(row);
    saveJson(`${this.prefix}live-state.json`, { at: Date.now(), ...this.status(), lastTrade: row });
    if (row.ok && (row.dry || row.shares > 0)) {
      this.open.push(row);
      saveJson(`${this.prefix}live-open.json`, this.open);
    } else {
      append(`${this.prefix}live`, row, trade.window * 1000);
    }
  }

  /** Send one fill-or-kill buy for `size` dollars at up to `limit`; fills land on `row`. Returns true when something filled. */
  private async fak(row: LiveTrade, token: string, limit: number, size: number): Promise<boolean> {
    if (!this.client) return false;
    const order = await this.client.createMarketOrder(
      { tokenID: token, amount: size, side: Side.BUY, price: limit, orderType: OrderType.FAK },
      { tickSize: "0.01", negRisk: false },
    );
    const res = await this.client.postOrder(order, OrderType.FAK);
    this.lastOrderAt = Date.now();
    row.ok = Boolean(res?.success);
    row.orderId = res?.orderID ?? null;
    row.status = res?.status ?? null;
    const detail = (res as unknown as { error?: unknown })?.error;
    row.error = res?.success ? null : (res?.errorMsg || (detail ? JSON.stringify(detail).slice(0, 200) : "order rejected"));
    row.cost = Number(res?.makingAmount) || 0;
    row.shares = Number(res?.takingAmount) || 0;
    row.fee = feeOf(row.cost, row.shares);
    return row.ok && row.shares > 0;
  }

  /**
   * After an unfilled fill-or-kill on an early cheap rule: retry every second for 10 s while the fresh ask is still at or
   * under the cap, then rest a limit buy at the cap until the rule's phase (`first` seconds into the window) is over and
   * cancel what is left. A resting fill is a maker fill, which Polymarket does not charge the taker fee on.
   */
  private async chase(row: LiveTrade, trade: PaperTrade, token: string, limit: number, size: number, phaseEnd: number, retryMs: number) {
    const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
    const retryUntil = Math.min(Date.now() + retryMs, phaseEnd);
    let tries = 0;
    try {
      while (Date.now() < retryUntil && this.client) {
        await sleep(1000);
        let ask: number | null = null;
        try {
          ask = (await book(token, 1500)).bestAsk;
        } catch {
          ask = null;
        }
        if (ask == null || ask > limit + 1e-9) continue;
        tries += 1;
        if (await this.fak(row, token, limit, size)) {
          row.status = `matched after ${tries} ${tries === 1 ? "retry" : "retries"}`;
          console.log(`live ${this.series.label}: bought ${row.shares.toFixed(2)} ${trade.side} for $${row.cost.toFixed(2)} on retry ${tries}`);
          return;
        }
      }
      if (!this.client || phaseEnd - Date.now() < 3000) return;
      // Rest at the cap. Polymarket wants at least 5 shares and $1; `size` dollars at the cap is 8.8 shares for $1.50 at 17c.
      const shares = Math.floor((size / limit) * 100) / 100;
      const order = await this.client.createOrder({ tokenID: token, price: limit, side: Side.BUY, size: shares }, { tickSize: "0.01", negRisk: false });
      const res = await this.client.postOrder(order, OrderType.GTC);
      this.lastOrderAt = Date.now();
      if (!res?.success || !res.orderID) {
        row.error = res?.errorMsg || "resting order rejected";
        return;
      }
      row.orderId = res.orderID;
      row.status = "resting";
      row.error = null;
      console.log(`live ${this.series.label}: resting ${shares} ${trade.side} at ${Math.round(limit * 100)}c for ${Math.round((phaseEnd - Date.now()) / 1000)}s`);
      const read = async () => {
        const o = await this.client!.getOrder(res.orderID);
        return { matched: Number(o?.size_matched) || 0, status: String(o?.status ?? "") };
      };
      // Shares the order crossed with on arrival were bought at the asks (cost in makingAmount); the rest fill at the cap.
      const crossed = Number(res.takingAmount) || 0;
      const crossedCost = Number(res.makingAmount) || 0;
      let matched = crossed;
      while (Date.now() < phaseEnd) {
        await sleep(2000);
        const o = await read().catch(() => null);
        if (!o) continue;
        matched = Math.max(matched, o.matched);
        if (matched >= shares - 0.01 || /MATCHED|CANCEL/i.test(o.status)) break;
      }
      if (matched < shares - 0.01) {
        await this.client.cancelOrder({ orderID: res.orderID }).catch(() => undefined);
        const o = await read().catch(() => null);
        if (o) matched = Math.max(matched, o.matched);
      }
      if (matched > 0.01) {
        row.ok = true;
        row.shares = matched;
        row.cost = Math.round((crossedCost + Math.max(0, matched - crossed) * limit) * 1e6) / 1e6;
        row.fee = feeOf(crossedCost, crossed);
        row.status = matched >= shares - 0.01 ? "matched while resting" : "partly matched while resting";
        console.log(`live ${this.series.label}: resting order filled ${matched.toFixed(2)} ${trade.side} for $${row.cost.toFixed(2)}`);
      } else {
        row.ok = false;
        row.status = "cancelled";
        row.error = "no fill while resting";
        console.log(`live ${this.series.label}: resting order cancelled, nothing filled`);
      }
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
      console.log(`live ${this.series.label}: chase failed (${row.error})`);
    }
  }

  /**
   * A bet enrique places by hand from the dashboard, tracked as the permanent "manual" strategy. Buys `side` on the
   * running window for `amount` dollars, paying up to 2c over the fresh ask (fill-and-kill). Polymarket fills at least
   * 5 shares, so the amount must cover 5 x the ask (and $1); the daily stop, halts and the balance floor do not apply,
   * because the person clicking is the decision. Settles, books fees and gets claimed like every other real trade.
   */
  async manualBuy(side: "UP" | "DOWN", amount: number, market: Market, windowEnd: number): Promise<{ ok: boolean; error?: string; trade?: LiveTrade }> {
    this.config = liveConfig(this.series.key);
    if (this.config.mode === "off") return { ok: false, error: "real orders are off (live.json mode)" };
    const left = windowEnd - Math.floor(Date.now() / 1000);
    if (left <= 3) return { ok: false, error: "this window is closing, wait for the next one" };
    if (!this.ready) await this.start();
    if (!this.ready || !this.client) return { ok: false, error: this.lastError ?? "wallet not ready" };
    const token = side === "UP" ? market.upToken : market.downToken;
    let ask: number | null = null;
    try {
      ask = (await book(token, 1500)).bestAsk;
    } catch {
      ask = null;
    }
    if (ask == null || !(ask > 0) || ask >= 1) return { ok: false, error: `no ${side} ask on the book right now` };
    const min = Math.max(1, Math.ceil(5 * ask * 100) / 100);
    if (!(amount >= min)) return { ok: false, error: `minimum is $${min.toFixed(2)} (5 shares at ${Math.round(ask * 100)}c)` };
    // A hand bet is a decision already made: pay up to 5c over the ask, and if the book moved between the look and
    // the match ("no orders found to match"), look once more and try again with the fresh ask.
    const MANUAL_SLIP = 0.05;
    let limit = Math.min(0.99, Math.round((ask + MANUAL_SLIP) * 100) / 100);
    const size = Math.round(amount * 100) / 100;
    const row: LiveTrade = {
      window: market.start,
      t: Date.now(),
      left,
      variant: "manual",
      side,
      token,
      ask,
      limit,
      freshAsk: ask,
      dry: this.config.mode === "dry",
      ok: false,
      orderId: null,
      status: null,
      error: null,
      cost: 0,
      shares: 0,
      resolvedUp: null,
      won: null,
      pnl: null,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        if (windowEnd - Math.floor(Date.now() / 1000) <= 3) break;
        let fresh: number | null = null;
        try {
          fresh = (await book(token, 1500)).bestAsk;
        } catch {
          fresh = null;
        }
        if (fresh == null || !(fresh > 0) || fresh >= 1) break;
        row.freshAsk = fresh;
        limit = Math.min(0.99, Math.round((fresh + MANUAL_SLIP) * 100) / 100);
        row.limit = limit;
        row.error = null;
      }
      try {
        const order = await this.client.createMarketOrder(
          { tokenID: token, amount: size, side: Side.BUY, price: limit, orderType: OrderType.FAK },
          { tickSize: "0.01", negRisk: false },
        );
        if (row.dry) {
          row.ok = true;
          row.status = "dry";
        } else {
          const res = await this.client.postOrder(order, OrderType.FAK);
          row.ok = Boolean(res?.success);
          row.orderId = res?.orderID ?? null;
          row.status = res?.status ?? null;
          const detail = (res as unknown as { error?: unknown })?.error;
          row.error = res?.success ? null : (res?.errorMsg || (detail ? JSON.stringify(detail).slice(0, 200) : "order rejected"));
          row.cost = Number(res?.makingAmount) || 0;
          row.shares = Number(res?.takingAmount) || 0;
          row.fee = feeOf(row.cost, row.shares);
          this.lastOrderAt = Date.now();
        }
      } catch (error) {
        row.error = error instanceof Error ? error.message : String(error);
      }
      if (row.ok && (row.dry || row.shares > 0)) break;
      if (!/no orders found to match/i.test(row.error ?? "")) break;
      console.log(`live ${this.series.label}: MANUAL ${side} no match at ${Math.round(limit * 100)}c, looking again`);
    }
    console.log(`live ${this.series.label}: MANUAL ${side} $${size} up to ${Math.round(limit * 100)}c -> ${row.ok && (row.dry || row.shares > 0) ? `${row.dry ? "dry, signed only" : `bought ${row.shares.toFixed(2)} for $${row.cost.toFixed(2)}`}` : `not filled (${row.error ?? row.status ?? "no fill"})`}`);
    this.remember(row);
    saveJson(`${this.prefix}live-state.json`, { at: Date.now(), ...this.status(), lastTrade: row });
    if (row.ok && (row.dry || row.shares > 0)) {
      this.open.push(row);
      saveJson(`${this.prefix}live-open.json`, this.open);
      return { ok: true, trade: row };
    }
    append(`${this.prefix}live`, row, row.window * 1000);
    return { ok: false, error: row.error ?? row.status ?? "not filled", trade: row };
  }

  settle(window: number, resolvedUp: boolean) {
    // Several variants can hold the same window; each is its own trade.
    this.likely.delete(window);
    const trades = this.open.filter((t) => t.window === window);
    if (!trades.length) return;
    this.open = this.open.filter((t) => t.window !== window);
    const totals = loadJson<LiveTrade[]>(`${this.prefix}live-totals.json`, []);
    let shares = 0;
    for (const trade of trades) {
      trade.resolvedUp = resolvedUp;
      trade.won = (trade.side === "UP") === resolvedUp;
      if (trade.fee == null) trade.fee = trade.dry ? 0 : feeOf(trade.cost, trade.shares);
      trade.pnl = trade.dry ? 0 : (trade.won ? trade.shares : 0) - trade.cost - trade.fee;
      this.count(trade);
      this.track(trade);
      this.remember(trade);
      append(`${this.prefix}live`, trade, window * 1000);
      totals.push(trade);
      if (!trade.dry) console.log(`live: ${trade.variant} ${trade.side} ${trade.won ? "won" : "lost"} ${trade.pnl >= 0 ? "+" : "-"}$${Math.abs(trade.pnl).toFixed(2)}; running ${this.won}/${this.trades}, net ${this.net >= 0 ? "+" : "-"}$${Math.abs(this.net).toFixed(2)}`);
      if (trade.won && !trade.dry) shares += trade.shares;
    }
    saveJson(`${this.prefix}live-totals.json`, totals);
    saveJson(`${this.prefix}live-open.json`, this.open);
    // One claim per window turns every winning share of that market back into pUSD.
    if (shares > 0 && !this.redeems.some((r) => r.window === window)) {
      this.redeems.push({ window, shares, tries: 0, nextAt: Date.now() + 60000, lastError: null });
      saveJson(`${this.prefix}live-redeem.json`, this.redeems);
    }
  }

  /** A relayer client that runs gasless transactions from the deposit wallet, signed by our key. */
  private relay() {
    const builder = loadJson<{ key?: string; secret?: string; passphrase?: string }>("polygon-builder.json", {});
    if (!builder.key || !builder.secret || !builder.passphrase) throw new Error("data/polygon-builder.json is missing; claim on polymarket.com instead");
    const keys = loadJson<{ wallet?: string }>("polygon-keys.json", {});
    const pk = String(keys.wallet ?? "").trim();
    if (!pk || !this.config.funder) throw new Error("keys or funder missing");
    const signer = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
    return new RelayClient(RELAYER, 137, signer, new BuilderConfig({ localBuilderCreds: { key: builder.key, secret: builder.secret, passphrase: builder.passphrase } }));
  }

  /**
   * Claimed winnings arrive as USDC.e, which the exchange does not trade with. Convert any USDC.e in the funds
   * wallet into pUSD through Polymarket's onramp (1:1). Called about once a minute, after the chain balances.
   */
  async wrapPending() {
    const usdce = this.chain?.["USDC.e"] ?? 0;
    // One wallet, so the BTC trader alone converts claimed winnings (other series' claims land in the same wallet).
    if (this.series.key || this.wrapping || relayBusy || relayerBlocked() || this.config.mode === "off" || usdce < 0.5) return;
    if (this.lastWrap && !this.lastWrap.tx && Date.now() - this.lastWrap.at < 300000) return;
    this.wrapping = true;
    relayBusy = true;
    const units = BigInt(Math.floor(usdce * 1e6));
    try {
      const relay = this.relay();
      const calls = [
        { target: USDC_E, value: "0", data: erc20.encodeFunctionData("approve", [ONRAMP, units]) },
        { target: ONRAMP, value: "0", data: onrampAbi.encodeFunctionData("wrap", [USDC_E, this.config.funder, units]) },
      ];
      noteRelayCall();
      const sent = await relay.executeDepositWalletBatch(calls, this.config.funder, String(Math.floor(Date.now() / 1000) + 600));
      const done = await sent.wait();
      const hash = done?.transactionHash || sent.transactionHash || null;
      if (!hash) throw new Error(`relayer did not confirm (state ${done?.state ?? sent.state ?? "unknown"})`);
      this.lastWrap = { amount: usdce, tx: hash, at: Date.now(), error: null };
      console.log(`live: converted $${usdce.toFixed(2)} of claimed winnings into pUSD (${hash})`);
      await this.refreshBalance();
    } catch (error) {
      this.lastWrap = { amount: usdce, tx: null, at: Date.now(), error: noteRelayError(error) };
      console.log(`live: converting winnings into pUSD failed (${this.lastWrap.error}), retrying later`);
    } finally {
      this.wrapping = false;
      relayBusy = false;
      saveJson(`${this.prefix}live-state.json`, { at: Date.now(), ...this.status() });
    }
  }

  /**
   * "convertUsdc" in data/live.json: "auto" swaps any native USDC that turns up in the funds wallet (a top-up sent
   * from an exchange) into USDC.e on Uniswap, after which wrapPending turns it into pUSD; a number swaps that much
   * once (data/usdc-swaps.json remembers the amounts already done). Nothing happens below $1.
   */
  async swapNative() {
    const raw = loadJson<{ convertUsdc?: unknown }>("live.json", {}).convertUsdc;
    // "auto" converts whatever native USDC turns up (top-ups from an exchange); a number converts that much, once.
    const auto = raw === "auto" || raw === true;
    const want = auto ? Infinity : Number(raw ?? 0);
    const usdc = this.chain?.["USDC"] ?? 0;
    if (this.series.key || this.swapping || relayBusy || relayerBlocked() || this.config.mode === "off" || !(want > 0) || usdc < 1) return;
    // The relayer reports "wallet busy" for a while after a claim or wrap went through; give it a minute.
    if (this.lastWrap?.tx && Date.now() - this.lastWrap.at < 60000) return;
    const done = loadJson<Swap[]>("usdc-swaps.json", []);
    if (!auto && done.some((d) => d.tx && Math.abs(d.want - want) < 1e-6)) return;
    if (this.lastSwap && !this.lastSwap.tx && Date.now() - this.lastSwap.at < (/wallet busy/.test(this.lastSwap.error ?? "") ? 60000 : 600000)) return;
    const amount = Math.min(want, usdc);
    const units = BigInt(Math.floor(amount * 1e6));
    this.swapping = true;
    relayBusy = true;
    try {
      const relay = this.relay();
      const params = {
        tokenIn: USDC_NATIVE,
        tokenOut: USDC_E,
        fee: 100,
        recipient: this.config.funder,
        amountIn: units,
        amountOutMinimum: (units * 995n) / 1000n,
        sqrtPriceLimitX96: 0,
      };
      const calls = [
        { target: USDC_NATIVE, value: "0", data: erc20.encodeFunctionData("approve", [UNISWAP_ROUTER, units]) },
        { target: UNISWAP_ROUTER, value: "0", data: routerAbi.encodeFunctionData("exactInputSingle", [params]) },
      ];
      noteRelayCall();
      const sent = await relay.executeDepositWalletBatch(calls, this.config.funder, String(Math.floor(Date.now() / 1000) + 600));
      const finished = await sent.wait();
      const hash = finished?.transactionHash || sent.transactionHash || null;
      if (!hash) throw new Error(`relayer did not confirm (state ${finished?.state ?? sent.state ?? "unknown"})`);
      this.lastSwap = { want, amount, tx: hash, at: Date.now(), error: null };
      console.log(`live: swapped $${amount.toFixed(2)} native USDC into USDC.e (${hash}); it becomes pUSD on the next pass`);
      await this.refreshBalance();
    } catch (error) {
      this.lastSwap = { want, amount, tx: null, at: Date.now(), error: noteRelayError(error) };
      console.log(`live: swapping native USDC failed (${this.lastSwap.error}), retrying later`);
    } finally {
      saveJson("usdc-swaps.json", [...done, this.lastSwap]);
      this.swapping = false;
      relayBusy = false;
      saveJson(`${this.prefix}live-state.json`, { at: Date.now(), ...this.status() });
    }
  }

  /**
   * Turn settled winning shares back into pUSD. Called about once a minute by the recorder.
   * One redeemPositions call per collateral Polymarket has used; the ones that do not match the market are
   * no-ops, so the batch is safe whichever collateral the market was created with.
   */
  /**
   * Claim wins. The BTC 5m trader does it for every series: all windows whose result is in go into one relayer
   * transaction (redeem each market, then wrap the USDC.e that comes out into pUSD), at most once every
   * `claimEveryMin` minutes, because the relayer's daily quota ran out at ~65 transactions on 23 Oct 2026.
   */
  async redeemPending() {
    if (this.series.key || this.redeeming || relayBusy) return;
    if (relayerBlocked()) return this.verifyClaims();
    const now = Date.now();
    const due: { trader: LiveTrader; redeem: Redeem }[] = [];
    for (const trader of traders) for (const r of trader.redeems) if (r.nextAt <= now) due.push({ trader, redeem: r });
    if (!due.length) return;
    // Low on funds (orders would start failing): claim early, but never more often than every 5 minutes and only with quota to spare.
    const lowFunds = this.config.claimBelow > 0 && this.balance != null && this.balance < this.config.claimBelow && relayerUsedToday() < 60;
    if (lastClaimAt && now - lastClaimAt < (claimBacklog || lowFunds ? 5 : this.config.claimEveryMin) * 60_000) return;
    if (lowFunds) console.log(`live: balance $${this.balance!.toFixed(2)} is under the $${this.config.claimBelow} claim floor, claiming ${due.length} window(s) now`);
    due.sort((a, b) => a.redeem.window - b.redeem.window);
    const batch = claimSingles ? due.slice(0, 1) : due.slice(0, 12);
    this.redeeming = true;
    relayBusy = true;
    let shares = 0;
    try {
      const relay = this.relay();
      const calls: { target: string; value: string; data: string }[] = [];
      let units = 0n;
      for (const { trader, redeem } of batch) {
        redeem.tries += 1;
        const market = await marketFor(redeem.window, trader.series.slug, trader.series.slugStyle);
        if (!market?.conditionId) throw new Error(`${trader.series.label} ${new Date(redeem.window * 1000).toISOString().slice(11, 16)}: market has no condition id yet`);
        for (const collateral of COLLATERALS) calls.push({ target: CTF, value: "0", data: ctfAbi.encodeFunctionData("redeemPositions", [collateral, ZERO32, market.conditionId, [1, 2]]) });
        shares += redeem.shares;
        // One unit under what the market pays, so rounding can never make the wrap ask for more than arrived.
        units += BigInt(Math.round(redeem.shares * 1e6)) - 1n;
      }
      const usdce = this.chain?.["USDC.e"] ?? 0;
      if (usdce >= 0.5) units += BigInt(Math.floor(usdce * 1e6));
      if (units > 0n && !claimNoWrap) {
        calls.push({ target: USDC_E, value: "0", data: erc20.encodeFunctionData("approve", [ONRAMP, units]) });
        calls.push({ target: ONRAMP, value: "0", data: onrampAbi.encodeFunctionData("wrap", [USDC_E, this.config.funder, units]) });
      }
      noteRelayCall();
      const sent = await relay.executeDepositWalletBatch(calls, this.config.funder, String(Math.floor(Date.now() / 1000) + 600));
      const done = await sent.wait();
      const hash = done?.transactionHash || sent.transactionHash || null;
      if (!hash) throw new Error(`relayer did not confirm (state ${done?.state ?? sent.state ?? "unknown"})`);
      lastClaimAt = Date.now();
      claimSingles = false;
      claimNoWrap = false;
      claimBacklog = due.length > batch.length;
      for (const { trader, redeem } of batch) trader.markClaimed(redeem, hash);
      this.lastRedeem = { window: batch[batch.length - 1].redeem.window, tx: hash, at: Date.now(), error: null };
      this.lastWrap = { amount: Number(units) / 1e6, tx: hash, at: Date.now(), error: null };
      console.log(`live: claimed ${shares.toFixed(2)} shares from ${batch.length} window(s) and converted them into pUSD (${hash})`);
      await this.refreshBalance();
    } catch (error) {
      const text = noteRelayError(error);
      claimSingles = batch.length > 1;
      claimNoWrap = !relayerBlocked();
      for (const { trader, redeem } of batch) {
        redeem.lastError = text;
        redeem.nextAt = Math.max(relayerBlockedUntil, Date.now() + Math.min(600000, 60000 * redeem.tries));
        if (redeem.tries >= 30) {
          trader.redeems = trader.redeems.filter((r) => r !== redeem);
          console.log(`live: giving up on claiming the ${trader.series.label} ${new Date(redeem.window * 1000).toISOString().slice(11, 16)} window after 30 tries (${text}); claim it on polymarket.com`);
        }
        saveJson(`${trader.prefix}live-redeem.json`, trader.redeems);
      }
      this.lastRedeem = { window: batch[0].redeem.window, tx: null, at: Date.now(), error: text };
      if (!relayerBlocked()) console.log(`live: claim not done yet (${text}), retrying`);
    } finally {
      this.redeeming = false;
      relayBusy = false;
      saveJson(`${this.prefix}live-state.json`, { at: Date.now(), ...this.status() });
    }
  }

  /**
   * While the relayer is out of quota, enrique may claim on polymarket.com. Every ten minutes look on chain for
   * queued windows whose shares are gone and mark them claimed, so the books and the next batch stay right.
   */
  private async verifyClaims() {
    if (Date.now() - lastVerifyAt < 600_000) return;
    lastVerifyAt = Date.now();
    let found = 0;
    for (const trader of traders) {
      for (const redeem of [...trader.redeems].slice(0, 20)) {
        try {
          const market = await marketFor(redeem.window, trader.series.slug, trader.series.slugStyle);
          if (!market?.conditionId) continue;
          if ((await sharesHeld(this.config.funder, market.conditionId)) < 0.01) {
            trader.markClaimed(redeem, "manual");
            found += 1;
          }
        } catch {
          // best effort; the batch after the reset sorts it out
        }
      }
    }
    if (found) {
      console.log(`live: ${found} window(s) were claimed by hand on polymarket.com; taken off the claim queue`);
      await this.refreshBalance();
    }
  }

  /** Pause or resume one real rule by hand (dashboard button); kept in the halts file, read before every order. */
  setPaused(variant: string, on: boolean) {
    this.halts = loadJson<Record<string, Halt>>(`${this.prefix}live-halts.json`, this.halts);
    const h = this.halts[variant] ?? { streak: 0, halted: false, haltedAt: null };
    h.paused = on;
    if (!on && h.halted) {
      // Play on a halted row: lift the loss halt too and start the streak count again.
      h.halted = false;
      h.haltedAt = null;
      h.streak = 0;
    }
    this.halts[variant] = h;
    saveJson(`${this.prefix}live-halts.json`, this.halts);
    saveJson(`${this.prefix}live-state.json`, { at: Date.now(), ...this.status() });
  }

  /** A claim batch went through: drop the window from the queue and note the transaction on its trades. */
  markClaimed(redeem: Redeem, hash: string) {
    this.redeems = this.redeems.filter((r) => r !== redeem);
    saveJson(`${this.prefix}live-redeem.json`, this.redeems);
    const totals = loadJson<LiveTrade[]>(`${this.prefix}live-totals.json`, []);
    for (const t of totals) if (t.window === redeem.window) { t.redeemTx = hash; t.redeemedAt = Date.now(); }
    saveJson(`${this.prefix}live-totals.json`, totals);
    for (const t of this.recent) if (t.window === redeem.window) { t.redeemTx = hash; t.redeemedAt = Date.now(); }
    saveJson(`${this.prefix}live-state.json`, { at: Date.now(), ...this.status() });
  }


  /**
   * The recorder's own verdict on a window that just closed (Chainlink close vs open), several minutes before
   * Polymarket settles it. The halt counts those as losses so a rule cannot slip one more order in during the lag.
   */
  provisional(window: number, up: boolean | null) {
    if (up == null) return;
    this.likely.set(window, up);
    for (const w of this.likely.keys()) if (w < window - 3600) this.likely.delete(w);
  }

  /** Open trades of a variant whose window has closed and looks lost on our own feed (not yet settled). */
  private pendingLosses(variant: string) {
    return this.open.filter((t) => t.variant === variant && t.won == null && this.likely.has(t.window) && (t.side === "UP") !== this.likely.get(t.window)).length;
  }

  abandon(window: number) {
    this.likely.delete(window);
    const before = this.open.length;
    this.open = this.open.filter((t) => t.window !== window);
    if (this.open.length !== before) saveJson(`${this.prefix}live-open.json`, this.open);
  }

  /**
   * The wallet since the first real order, for the dashboard chart: one point an hour rebuilt from every market's fills (cost and
   * fee out when placed, shares back when a win settles) and the USDC top-ups, anchored so the last point is today's wallet;
   * plus the real balance samples logged once a minute since 27 Oct 2026 (data/balance/). BTC 5m trader only, rebuilt every 5 min.
   */
  private historyCache: { at: number; value: BalanceHistory | null } | null = null;
  balanceHistory(): BalanceHistory | null {
    if (this.series.key) return null;
    if (this.historyCache && Date.now() - this.historyCache.at < 300_000) return this.historyCache.value;
    const events: { t: number; d: number }[] = [];
    for (const s of SERIES) {
      const prefix = prefixOf(s);
      const open = loadJson<LiveTrade[]>(`${prefix}live-open.json`, []);
      for (const t of loadJson<LiveTrade[]>(`${prefix}live-totals.json`, []).concat(open).map(withFee)) {
        if (t.dry || !t.ok || !(t.shares > 0)) continue;
        events.push({ t: t.t, d: -(t.cost + (t.fee ?? 0)) });
        if (t.won) events.push({ t: (t.window + s.windowSec) * 1000, d: t.shares });
      }
    }
    const deposits = loadJson<Swap[]>("usdc-swaps.json", []).filter((x) => x.tx && !x.error).map((x) => ({ t: x.at, amount: x.amount }));
    for (const d of deposits) events.push({ t: d.t, d: d.amount });
    events.sort((a, b) => a.t - b.t);
    if (!events.length) return (this.historyCache = { at: Date.now(), value: null }).value;
    const now = Date.now();
    const total = events.reduce((sum, e) => sum + e.d, 0);
    const offset = this.balance != null ? this.balance - total : (this.config.startBalance ?? 0);
    const points: [number, number][] = [];
    let i = 0, cum = 0;
    for (let h = Math.floor(events[0].t / 3_600_000) * 3_600_000; h <= now; h += 3_600_000) {
      while (i < events.length && events[i].t <= h) cum += events[i++].d;
      points.push([h, Math.round((offset + cum) * 100) / 100]);
    }
    points.push([now, Math.round((offset + total) * 100) / 100]);
    const log = readAll<{ t: number; bal: number }>("balance").map((r) => [r.t, r.bal] as [number, number]);
    const step = Math.max(1, Math.ceil(log.length / 600));
    const value: BalanceHistory = { points, deposits, wallet: log.filter((_, k) => k % step === 0 || k === log.length - 1), from: events[0].t };
    this.historyCache = { at: Date.now(), value };
    return value;
  }

  status() {
    const c = this.config;
    // Halts and pauses can be edited in the file by hand; show the file's state, not the copy loaded at the last order.
    this.halts = loadJson<Record<string, Halt>>(`${this.prefix}live-halts.json`, this.halts);
    // "manual" (bets placed by hand on the dashboard) counts in the totals and the day table, but has no rule row and stays out of the
    // trade log (enrique, 27 Oct: "clear the manual stuff ... from the strats and trades").
    // Totals count every real trade since statsSince, rules since removed from live.json included (enrique, 24 Oct: "completely legit, not dependent on strategies activated").
    const shown = { trades: 0, won: 0, net: 0, today: 0 };
    for (const v of this.byVariant.values()) { shown.trades += v.trades; shown.won += v.won; shown.net += v.net; }
    for (const [key, net] of this.dayVarNet) { const [day] = key.split("|"); if (day === kstDay()) shown.today += net; }
    return {
      series: this.series.key,
      label: this.series.label,
      mode: c.mode,
      variant: c.variant,
      size: c.size,
      maxLossPerDay: c.maxLossPerDay,
      statsSince: c.statsSince || null,
      startBalance: c.startBalance,
      deposits: c.deposits,
      minBalance: c.minBalance,
      claims: this.series.key ? null : { everyMin: c.claimEveryMin, usedToday: relayerUsedToday(), perBatch: 12, quota: 65, lastAt: lastClaimAt || null, nextAt: lastClaimAt ? lastClaimAt + c.claimEveryMin * 60_000 : null, blockedUntil: relayerBlocked() ? relayerBlockedUntil : null },
      toClaim: this.redeems.reduce((sum, r) => sum + r.shares, 0),
      variants: ((misses) => c.variants.map((v) => {
        const h = this.halts[v.variant];
        const t = this.byVariant.get(v.variant);
        const d = this.dayVar.get(`${kstDay()}|${v.variant}`);
        const step = this.sizeFor(v);
        const stopAt = this.ruleStop(v, step.mult);
        return { ...v, size: step.size, ladderNote: step.note, maxLossPerDay: v.maxLossPerDay ?? c.maxLossPerDay, stopAt, stopped: this.ruleLoss(v.variant) >= stopAt, halted: Boolean(v.haltAfterLosses && h?.halted), paused: Boolean(h?.paused), streak: h?.streak ?? 0, haltedAt: h?.haltedAt ?? null, trades: t?.trades ?? 0, won: t?.won ?? 0, net: Math.round((t?.net ?? 0) * 100) / 100, today: { trades: d?.trades ?? 0, won: d?.won ?? 0, net: Math.round((d?.net ?? 0) * 100) / 100, misses: misses.get(v.variant) ?? 0 } };
      }))(this.missesToday()),
      ready: this.ready,
      wallet: this.wallet,
      funder: c.funder || null,
      balance: this.balance,
      trades: shown.trades,
      won: shown.won,
      net: Math.round(shown.net * 100) / 100,
      todayNet: Math.round(shown.today * 100) / 100,
      open: this.open.length,
      // Rules taken out of live.json: their trades stay in the files and the wallet, but off the panel.
      hidden: { trades: 0, net: 0, open: 0 },
      lastError: this.lastError,
      lastOrderAt: this.lastOrderAt,
      chain: this.chain,
      pendingRedeems: this.redeems.length,
      lastWrap: this.lastWrap,
      lastSwap: this.lastSwap,
      lastRedeem: this.lastRedeem,
      // The log shows orders that actually bought shares (or dry runs); skipped and unfilled orders only count in the day table.
      // Rules since taken off live.json stay in the log (enrique, 28 Oct: "no need to hide ... rules that are not live anymore"); hand bets stay out of it (27 Oct).
      recent: this.recent.filter((t) => t.ok && (t.shares > 0 || t.dry) && t.variant !== "manual").slice(0, 20),
      days: this.days(),
      history: this.balanceHistory(),
    };
  }
}
