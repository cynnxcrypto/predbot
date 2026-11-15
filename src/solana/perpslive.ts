/**
 * REAL MONEY (tiny, capped), OFF BY DEFAULT: shorts on Jupiter Perps for the perp paper rules of buckets.ts.
 * enrique, 15 Nov 2026 08:40 KST: "yes to both" (switch the spot side on; build perps now), and "so we separate
 * budgets of different things". Built ready to switch on; the switch is MAIN's change to deploy/live-rules.json.
 *
 * WHAT IS TRADED: longs and shorts on SOL, BTC or ETH. A short is backed by USDC; a long by the coin itself, which
 * the USDC we pay is swapped to inside the order. Two kinds of signal, each only while it MEETS ITS BAR on paper:
 *  - a perp paper rule (buckets.ts meetsBar: 100+ paper trades, half or more won, ahead), at the rule leverage (2x or less);
 *  - a copied perp trader (traderMeetsBar: 20+ closed copies, half won, ahead, a day on paper), at the leverage the
 *    trader set. enrique, 15 Nov 2026 18:33 KST: "yes build it, dont cap it, replicate leverage". What bounds the
 *    loss is the collateral of a position: a liquidation takes that and no more.
 * The real position is closed when the paper one closes, or after MAX_HOLD_H. ONE position at a time, so its result
 * is simply what it did to the wallet's USDC.
 * BACK TO PAPER: a rule whose real trades have lost `ruleStopUsd` is demoted until its paper trades made after that
 * meet the bar again. At `maxLossUsd` in all, nothing new is opened for good.
 *
 * HOW AN ORDER GOES (Jupiter's request model): we send a request (createIncreasePositionMarketRequest, or
 * createDecreasePositionMarketRequest to close); Jupiter's keeper fills it seconds later at the oracle price, or
 * turns it down and gives the USDC back. So after a request we watch the position account, never assume a fill.
 * No API builds these transactions, so they are built here by hand from Jupiter's published program interface
 * (github.com/julianfssen/jupiter-perps-anchor-idl-parsing, read 15 Nov 2026). Therefore:
 *  - EVERY transaction is SIMULATED on the chain first and is sent only if the simulation passes.
 *  - A dry simulation of an open order runs once a day whatever the switch says, and its result is in the status,
 *    so a change of the program is seen before money meets it.
 *
 * Guards, all in code:
 *  - OFF unless deploy/live-rules.json has "solanaPerps": { "on": true, "maxLossUsd": ... }. SOLANA_LIVE=off
 *    disables it. Anything malformed means off.
 *  - ITS OWN WALLET: keys.ts namedWallet("perps") (data/solana-wallet-perps.json, made on the server). The other
 *    wallets are never read or signed with here; keys.ts signs only what this wallet alone pays for.
 *  - Leverage at most HARD_LEVERAGE (2x), collateral at most HARD_COLLATERAL_USD, loss at most HARD_MAX_LOSS_USD.
 *  - State is written before a transaction is sent and after every step, so a restart picks up where it stood.
 *  - The public status gets rule names and numbers only.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, ROOT } from "../config.js";
import { perpMeetsBar, perpPaperOpens, perpPaperRecord, perpRuleIds, setPerpsRealSummary, REAL_MIN_TRADES, TRADER_MIN_COPIES } from "./buckets.js";
import { base58decode, namedWallet, signTransaction, type Wallet } from "./keys.js";
import { USDC } from "./pools.js";
import { fileSwap, gasSummary, gasTick, type GasDeps } from "./gas.js";
import { anchorDisc, ata, ATA_PROGRAM, budget, buildTx, pda, SYSTEM_PROGRAM, TOKEN_PROGRAM, u64le, type Ix } from "./soltx.js";

export const PERPS_PROGRAM = "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu";
export const JLP_POOL = "5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq";
export const CUSTODY: Record<string, string> = {
  SOL: "7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz",
  ETH: "AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn",
  BTC: "5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm",
};
export const USDC_CUSTODY = "G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa";
const PERPETUALS = () => pda(["perpetuals"], PERPS_PROGRAM).address;
const EVENT_AUTHORITY = () => pda(["__event_authority"], PERPS_PROGRAM).address;
const SIDE_SHORT = 2;
const SIDE_LONG = 1;
/** token decimals of the three coins as Jupiter Perps holds them (SOL, and the bridged ETH and BTC) */
const DECIMALS: Record<string, number> = { SOL: 9, ETH: 8, BTC: 8 };
/** a long is backed by the coin itself: the USDC we pay is swapped inside the order, and at least this share must come out */
export const LONG_SWAP_MIN = 0.97;
/** enrique, 15 Nov 2026 18:33 KST: "yes build it, dont cap it, replicate leverage". A copied trader's own leverage is
 *  used as it is. What bounds a position is its collateral (all that a liquidation can take) and Jupiter's own limit:
 *  the custody account's maxLeverage is where Jupiter liquidates, so we stay at half of it or lower; if it cannot
 *  be read, at this. */
export const JUP_MAX_LEV_FALLBACK = 100;
export const MIN_LEVERAGE = 1.1;

export const TEST_RULE = "test-once";
export const HARD_LEVERAGE = 2;
export const HARD_COLLATERAL_USD = 25;
export const HARD_MAX_LOSS_USD = 50;
export const HARD_RULE_STOP_USD = 10;
export const MIN_COLLATERAL_USD = 10;
/** SOL the wallet must hold for fees and the request's rent (the rent comes back when the keeper closes the request) */
export const MIN_SOL = 0.02;
export const OPEN_WINDOW_MS = 120_000;
export const MAX_HOLD_H = 24 * 8;
/** how far the oracle price may be from the one we read when the keeper fills: 1% to open; to close 2%, then wider */
export const OPEN_SLIP = 0.01;
export const CLOSE_SLIP = [0.02, 0.05, 0.1] as const;
/** a request the keeper has neither filled nor turned down after this long is taken back by us */
export const CANCEL_MS = 180_000;
/** a request that is not on the chain is taken as turned down only after this long: a transaction of ours that
 *  seemed not to land can still land for about a minute and a half */
export const GONE_MS = 100_000;
const DRY_MS = 24 * 3_600_000;
const STATE = () => join(DATA, "solana-perpslive.json");
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface PerpsLiveConfig {
  on: boolean;
  collateralUsd: number;
  leverage: number;
  maxLossUsd: number;
  ruleStopUsd: number;
}
const OFF: PerpsLiveConfig = { on: false, collateralUsd: 0, leverage: 1, maxLossUsd: 0, ruleStopUsd: 0 };
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Parse the "solanaPerps" block of deploy/live-rules.json. Hard limits are applied here; anything odd means off. */
export function parsePerpsLive(text: string): PerpsLiveConfig {
  try {
    const p = (JSON.parse(text) as { solanaPerps?: Record<string, unknown> }).solanaPerps;
    if (!p || p.on !== true) return OFF;
    const maxLossUsd = clamp(num(p.maxLossUsd, 0), 0, HARD_MAX_LOSS_USD);
    if (!(maxLossUsd > 0)) return OFF;
    return {
      on: true, maxLossUsd,
      collateralUsd: clamp(num(p.collateralUsd, MIN_COLLATERAL_USD), MIN_COLLATERAL_USD, HARD_COLLATERAL_USD),
      leverage: clamp(num(p.leverage, HARD_LEVERAGE), 1, HARD_LEVERAGE),
      ruleStopUsd: clamp(num(p.ruleStopUsd, 3), 1, HARD_RULE_STOP_USD),
    };
  } catch {
    return OFF;
  }
}

// ---- the orders -------------------------------------------------------------------------------------------------------
const usd6 = (x: number) => BigInt(Math.round(x * 1e6));
/** a short is backed by USDC, a long by the coin itself */
const collateralCustody = (coin: string, dir: number) => (dir > 0 ? CUSTODY[coin] : USDC_CUSTODY);
const sideByte = (dir: number) => (dir > 0 ? SIDE_LONG : SIDE_SHORT);
export const positionAddress = (owner: string, coin: string, dir = -1) =>
  pda(["position", base58decode(owner), base58decode(JLP_POOL), base58decode(CUSTODY[coin]), base58decode(collateralCustody(coin, dir)), Buffer.from([sideByte(dir)])], PERPS_PROGRAM).address;
/** 1 = a request to open or add, 2 = a request to close or reduce */
export const requestAddress = (position: string, counter: bigint, change: 1 | 2) =>
  pda(["position_request", base58decode(position), u64le(counter), Buffer.from([change])], PERPS_PROGRAM).address;
const tail = [{ pubkey: TOKEN_PROGRAM }, { pubkey: ATA_PROGRAM }, { pubkey: SYSTEM_PROGRAM }];

/** The request to open a short of `sizeUsd` dollars backed by `collateralUsd` USDC, refused below `minPrice`. */
export const openShortIx = (owner: string, coin: string, sizeUsd: number, collateralUsd: number, minPrice: number, counter: bigint) => openIx(owner, coin, -1, sizeUsd, collateralUsd, minPrice, counter, null);
/** The request to open a long: `collateralUsd` USDC is paid in and swapped to the coin inside the order (at least
 *  `minOut` of the coin's smallest units must come out); refused above `maxPrice`. */
export const openLongIx = (owner: string, coin: string, sizeUsd: number, collateralUsd: number, maxPrice: number, counter: bigint, minOut: bigint) => openIx(owner, coin, 1, sizeUsd, collateralUsd, maxPrice, counter, minOut);
/** What the swap of a long's USDC must bring at the least, in the coin's smallest units, at price `px`. */
export const longMinOut = (coin: string, collateralUsd: number, px: number) => BigInt(Math.floor((collateralUsd / px) * LONG_SWAP_MIN * 10 ** DECIMALS[coin]));
/** The price bound of an order: an open short is refused below it and an open long above it; a close the other way round. */
export const boundPrice = (dir: number, px: number, slip: number, closing: boolean) => px * (1 + (closing ? -dir : dir) * slip);
function openIx(owner: string, coin: string, dir: number, sizeUsd: number, collateralUsd: number, bound: number, counter: bigint, minOut: bigint | null): { ix: Ix; position: string; request: string } {
  const position = positionAddress(owner, coin, dir);
  const request = requestAddress(position, counter, 1);
  const data = Buffer.concat([anchorDisc("create_increase_position_market_request"), u64le(usd6(sizeUsd)), u64le(usd6(collateralUsd)), Buffer.from([sideByte(dir)]), u64le(usd6(bound)), minOut === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), u64le(minOut)]), u64le(counter)]);
  const keys = [
    { pubkey: owner, signer: true, writable: true },
    { pubkey: ata(owner, USDC), writable: true }, // fundingAccount
    { pubkey: PERPETUALS() },
    { pubkey: JLP_POOL },
    { pubkey: position, writable: true },
    { pubkey: request, writable: true },
    { pubkey: ata(request, USDC), writable: true },
    { pubkey: CUSTODY[coin] },
    { pubkey: collateralCustody(coin, dir) },
    { pubkey: USDC }, // inputMint
    { pubkey: PERPS_PROGRAM }, // referral: none (an absent optional account is the program itself)
    ...tail,
    { pubkey: EVENT_AUTHORITY() },
    { pubkey: PERPS_PROGRAM },
  ];
  return { ix: { program: PERPS_PROGRAM, keys, data }, position, request };
}
/** The request to close the whole short and take the USDC back, refused above `maxPrice`. */
export const closeShortIx = (owner: string, coin: string, maxPrice: number, counter: bigint) => closeIx(owner, coin, -1, maxPrice, counter);
/** The request to close the whole long and take USDC back, refused below `minPrice`. */
export const closeLongIx = (owner: string, coin: string, minPrice: number, counter: bigint) => closeIx(owner, coin, 1, minPrice, counter);
function closeIx(owner: string, coin: string, dir: number, maxPrice: number, counter: bigint): { ix: Ix; position: string; request: string } {
  const position = positionAddress(owner, coin, dir);
  const request = requestAddress(position, counter, 2);
  const data = Buffer.concat([anchorDisc("create_decrease_position_market_request"), u64le(0), u64le(0), u64le(usd6(maxPrice)), Buffer.from([0]), Buffer.from([1, 1]), u64le(counter)]);
  const keys = [
    { pubkey: owner, signer: true, writable: true },
    { pubkey: ata(owner, USDC), writable: true }, // receivingAccount
    { pubkey: PERPETUALS() },
    { pubkey: JLP_POOL },
    { pubkey: position },
    { pubkey: request, writable: true },
    { pubkey: ata(request, USDC), writable: true },
    { pubkey: CUSTODY[coin] },
    { pubkey: collateralCustody(coin, dir) },
    { pubkey: USDC }, // desiredMint
    { pubkey: PERPS_PROGRAM }, // referral: none
    ...tail,
    { pubkey: EVENT_AUTHORITY() },
    { pubkey: PERPS_PROGRAM },
  ];
  return { ix: { program: PERPS_PROGRAM, keys, data }, position, request };
}
/** Take back a request the keeper left lying (its USDC returns to our account). */
export function cancelRequestIx(owner: string, position: string, request: string): Ix {
  const keys = [
    { pubkey: PERPS_PROGRAM }, // keeper: none
    { pubkey: owner, signer: true, writable: true },
    { pubkey: ata(owner, USDC), writable: true },
    { pubkey: JLP_POOL, writable: true },
    { pubkey: request, writable: true },
    { pubkey: ata(request, USDC), writable: true },
    { pubkey: position },
    { pubkey: TOKEN_PROGRAM },
    { pubkey: EVENT_AUTHORITY() },
    { pubkey: PERPS_PROGRAM },
  ];
  return { program: PERPS_PROGRAM, keys, data: anchorDisc("close_position_request") };
}
/** A Position account (layout from the program interface): entry price at byte 153, sizeUsd at 161, collateralUsd at 169. */
export function readPosition(dataB64: string | null | undefined): { entryPx: number; sizeUsd: number; collateralUsd: number } {
  const b = dataB64 ? Buffer.from(dataB64, "base64") : Buffer.alloc(0);
  if (b.length < 177) return { entryPx: 0, sizeUsd: b.length >= 169 ? Number(b.readBigUInt64LE(161)) / 1e6 : 0, collateralUsd: 0 };
  return { entryPx: Number(b.readBigUInt64LE(153)) / 1e6, sizeUsd: Number(b.readBigUInt64LE(161)) / 1e6, collateralUsd: Number(b.readBigUInt64LE(169)) / 1e6 };
}
/** A Position account's size in dollars (0 = no position). */
export const positionSizeUsd = (dataB64: string | null | undefined) => readPosition(dataB64).sizeUsd;
/** What a short of `sizeUsd` opened at `entryPx` has made at `px`, before the fees to close. */
export const shortUnrealUsd = (sizeUsd: number, entryPx: number, px: number) => (entryPx > 0 && px > 0 ? r2((sizeUsd * (entryPx - px)) / entryPx) : 0);
/** The same for either side (dir +1 long, -1 short). */
export const unrealUsd = (dir: number, sizeUsd: number, entryPx: number, px: number) => (dir > 0 ? -1 : 1) * shortUnrealUsd(sizeUsd, entryPx, px) || 0;
/** Jupiter's liquidation leverage for a coin, out of its Custody account (pricing.maxLeverage, in hundredths of a percent, at byte 175). */
export function custodyMaxLeverage(dataB64: string | null | undefined): number | null {
  const b = dataB64 ? Buffer.from(dataB64, "base64") : Buffer.alloc(0);
  if (b.length < 183) return null;
  const x = Number(b.readBigUInt64LE(175)) / 10_000;
  return x >= 2 && x <= 5000 ? x : null;
}
/** The leverage a position is opened at: the copied trader's own when there is one, else the rule's; never above half of
 *  where Jupiter liquidates. */
export const leverageFor = (traderLev: number | undefined, ruleLev: number, jupMax: number | null) =>
  Math.max(1, Math.min(traderLev !== undefined && traderLev >= 1 ? Math.max(MIN_LEVERAGE, traderLev) : ruleLev, jupMax ? jupMax / 2 : JUP_MAX_LEV_FALLBACK));

// ---- state --------------------------------------------------------------------------------------------------------------
interface Pos {
  rule: string;
  coin: string;
  /** the paper position it follows */
  paperId: string;
  stage: "opening" | "open" | "closing";
  usdcBefore: number;
  sizeUsd: number;
  position: string;
  request: string;
  sentMs: number;
  openedMs?: number;
  closeTries: number;
  cancelled?: boolean;
  /** +1 long, -1 short (absent = short), and the leverage it was opened at */
  dir?: number;
  lev?: number;
  /** for the status: the collateral in the position and what it has made at the last price read (before closing fees) */
  collateralUsd?: number;
  entryPx?: number;
  unrealUsd?: number;
  markMs?: number;
}
interface Row {
  t: number;
  rule: string;
  coin: string;
  filled: boolean;
  netUsd: number;
  heldH: number | null;
}
interface State {
  netUsd: number;
  halted: string;
  note: string;
  pos: Pos | null;
  rows: Row[];
  demoted: Record<string, number>;
  seen: string[];
  skipped: Record<string, number>;
  dry: { at: number; result: string } | null;
  /** the one-time test trade that was made (its name in the live rules, and when): a name is used once, for good */
  test?: { id: string; at: number };
  testLong?: { id: string; at: number };
  /** the dry simulation of a CLOSE order, against a short that exists on the chain (someone else's; nothing is signed or sent) */
  dryClose?: { at: number; result: string; tried: number } | null;
  /** the same two dry simulations for a LONG: an open order of ours, and a close order against a long that exists on the chain */
  dryLong?: { at: number; result: string } | null;
  dryCloseLong?: { at: number; result: string; tried: number } | null;
  lastSim: string;
  lastError: string;
}
const fresh = (): State => ({ netUsd: 0, halted: "", note: "", pos: null, rows: [], demoted: {}, seen: [], skipped: {}, dry: null, lastSim: "", lastError: "" });
let state: State = fresh();
let loaded = false;
function load() {
  loaded = true;
  let text: string;
  try {
    text = readFileSync(STATE(), "utf8");
  } catch {
    return;
  }
  try {
    state = { ...fresh(), ...(JSON.parse(text) as State) };
  } catch {
    state.halted = "the state file could not be read: the loss count is unknown, so nothing is opened";
  }
}
function save() {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(STATE() + ".tmp", JSON.stringify(state));
  renameSync(STATE() + ".tmp", STATE());
}
const loss = () => Math.max(0, -state.netUsd);
const skip = (why: string) => void (state.skipped[why] = (state.skipped[why] ?? 0) + 1);
const ruleNet = (rule: string) => state.rows.filter((x) => x.rule === rule && x.filled && x.t > (state.demoted[rule] ?? 0)).reduce((a, x) => a + x.netUsd, 0);
export const promoted = (rule: string) => perpMeetsBar(rule, state.demoted[rule] ?? 0);

export interface PerpDeps {
  cfg: () => PerpsLiveConfig;
  wallet: () => Wallet;
  rpc: <T>(method: string, params: unknown[], timeoutMs?: number) => Promise<T>;
  send: (tx: string) => Promise<unknown>;
  landed: (sig: string, ms: number) => Promise<{ slot: number; err: unknown } | null>;
  sigOf: (tx: string) => string;
  /** the name of the one-time test trade asked for, "" = none */
  testId?: () => string;
  /** the name of the one-time test LONG asked for, "" = none */
  testLongId?: () => string;
  /** the wallet's USDC, dollars */
  usdc: (address: string) => Promise<number>;
  /** the wallet's SOL */
  sol: (address: string) => Promise<number>;
  /** the coin's price now, dollars */
  price: (coin: string) => Promise<number>;
  fixed: (e: unknown) => string;
}

/** What a simulation said, in fixed words: "ok", or which instruction failed with which program error. */
export function simVerdict(value: { err?: unknown; logs?: string[] | null } | null | undefined): string {
  if (!value) return "no answer";
  if (!value.err) return "ok";
  const name = (value.logs ?? []).map((l) => /Error Code: ([A-Za-z0-9]{1,48})/.exec(l)?.[1]).filter(Boolean).pop();
  const funds = (value.logs ?? []).some((l) => /insufficient (funds|lamports)/i.test(l));
  const e = value.err as { InstructionError?: [number, unknown] } | string;
  if (typeof e === "object" && Array.isArray(e?.InstructionError)) {
    const [i, why] = e.InstructionError;
    const code = typeof why === "object" && why && "Custom" in why ? `custom error ${Number((why as { Custom: unknown }).Custom)}` : typeof why === "string" ? why.replace(/[^A-Za-z]/g, "").slice(0, 40) : "error";
    return `failed: instruction ${Number(i)}, ${code}${name ? ` (${name})` : ""}${funds ? ", insufficient funds" : ""}`;
  }
  return `failed: ${typeof e === "string" ? e.replace(/[^A-Za-z]/g, "").slice(0, 40) : "error"}`;
}
async function simulate(d: PerpDeps, tx: string): Promise<string> {
  try {
    const r = await d.rpc<{ value: { err?: unknown; logs?: string[] | null } }>("simulateTransaction", [tx, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" }]);
    return simVerdict(r?.value);
  } catch {
    return "no answer";
  }
}
/** Build, simulate, and only if the simulation passes sign and send. True when it landed without an error. */
async function sendChecked(d: PerpDeps, w: Wallet, ixs: Ix[], units = 400_000): Promise<boolean> {
  const { value } = await d.rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const unsigned = buildTx(w.address, value.blockhash, [...budget(units, 100_000), ...ixs]);
  state.lastSim = await simulate(d, unsigned);
  if (state.lastSim !== "ok") return false;
  const tx = signTransaction(unsigned, w);
  const sig = d.sigOf(tx);
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    await d.send(tx).catch(() => undefined);
    const st = await d.landed(sig, 2500);
    if (st) return !st.err;
  }
  return false;
}
const posOf = async (d: PerpDeps, position: string) => readPosition((await d.rpc<{ value: { data?: [string, string] } | null }>("getAccountInfo", [position, { encoding: "base64", commitment: "confirmed" }]))?.value?.data?.[0]);
const sizeOf = async (d: PerpDeps, position: string) => (await posOf(d, position)).sizeUsd;
const exists = async (d: PerpDeps, address: string) => !!(await d.rpc<{ value: unknown | null }>("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } }]))?.value;
/**
 * Is our CLOSE order one the program accepts? We hold no position to try it on, and a simulation checks no
 * signature, so the same order is simulated as the owner of a SOL short that exists on the chain now. Read-only:
 * nothing is signed, nothing is sent, nobody's position is touched. Up to CLOSE_DRY_TRIES owners are tried, because
 * one owner's own state (no SOL for the request's rent, no USDC account) can fail an order that is right.
 */
export const CLOSE_DRY_TRIES = 5;
export async function dryClose(d: PerpDeps, dir = -1): Promise<{ result: string; tried: number }> {
  const b58 = (await import("./whirlpool.js")).base58;
  // Position accounts: custody at byte 72, collateral custody at 104, side at 152. Only owner..sizeUsd is fetched.
  const rows = await d.rpc<{ account: { data: [string, string] } }[]>("getProgramAccounts", [PERPS_PROGRAM, {
    encoding: "base64", commitment: "confirmed", dataSlice: { offset: 8, length: 161 },
    filters: [{ memcmp: { offset: 72, bytes: CUSTODY.SOL } }, { memcmp: { offset: 104, bytes: collateralCustody("SOL", dir) } }, { memcmp: { offset: 152, bytes: b58(Buffer.from([sideByte(dir)])) } }],
  }], 60_000);
  const owners: string[] = [];
  for (const r of rows ?? []) {
    const b = Buffer.from(r.account.data[0], "base64");
    if (b.length >= 161 && Number(b.readBigUInt64LE(153)) / 1e6 >= 50) owners.push(b58(b.subarray(0, 32)));
  }
  if (!owners.length) return { result: "no open position on the chain to try it on", tried: 0 };
  const px = await d.price("SOL");
  let result = "no answer";
  let tried = 0;
  // spread over the list, so one odd owner is not tried every time
  const start = Math.floor(Math.random() * owners.length);
  for (let i = 0; i < Math.min(CLOSE_DRY_TRIES, owners.length) && result !== "ok"; i++) {
    const owner = owners[(start + i * 7919) % owners.length];
    const { value } = await d.rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
    // a long's owner may hold no USDC account to be paid into: the simulation makes one first (ours exists)
    const pre: Ix[] = dir > 0 ? [{ program: ATA_PROGRAM, keys: [{ pubkey: owner, signer: true, writable: true }, { pubkey: ata(owner, USDC), writable: true }, { pubkey: owner }, { pubkey: USDC }, { pubkey: SYSTEM_PROGRAM }, { pubkey: TOKEN_PROGRAM }], data: Buffer.from([1]) }] : [];
    result = await simulate(d, buildTx(owner, value.blockhash, [...budget(400_000, 100_000), ...pre, closeIx(owner, "SOL", dir, boundPrice(dir, px, CLOSE_SLIP[0], true), counter()).ix]));
    tried++;
  }
  return { result, tried };
}
const counter = () => BigInt(Math.floor(Math.random() * 1_000_000_000));

/** Book what the finished (or never filled) position did to the wallet's USDC; demote its rule or stop at a limit. */
async function finish(d: PerpDeps, w: Wallet, p: Pos, filled: boolean) {
  const now = await d.usdc(w.address);
  const net = r2(now - p.usdcBefore);
  state.netUsd = r2(state.netUsd + net);
  state.rows = [...state.rows, { t: Date.now(), rule: p.rule, coin: p.coin, filled, netUsd: net, heldH: p.openedMs ? Math.round(((Date.now() - p.openedMs) / 3_600_000) * 10) / 10 : null }].slice(-2000);
  state.pos = null;
  const c = d.cfg();
  if (c.ruleStopUsd > 0 && ruleNet(p.rule) <= -c.ruleStopUsd) state.demoted[p.rule] = Date.now();
  if (!state.halted && c.maxLossUsd > 0 && loss() + c.collateralUsd > c.maxLossUsd + 1e-9) state.halted = `loss cap reached: $${r2(loss())} of $${c.maxLossUsd} (no room for another position)`;
  save();
}

let busy = false;
export async function perpsLiveTick(d: PerpDeps, now = Date.now()): Promise<void> {
  if (busy) return;
  if (!loaded) load();
  const c = d.cfg();
  busy = true;
  try {
    const w = d.wallet();
    // the daily dry run: is an open order of ours still one the program accepts? Read-only, whatever the switch says.
    if (!state.pos && now - (state.dry?.at ?? 0) > (state.dry?.result === "ok" ? DRY_MS : 3_600_000)) {
      let result = "no answer";
      try {
        const px = await d.price("SOL");
        const { value } = await d.rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
        const { ix } = openShortIx(w.address, "SOL", MIN_COLLATERAL_USD * HARD_LEVERAGE, MIN_COLLATERAL_USD, px * (1 - OPEN_SLIP), counter());
        result = await simulate(d, buildTx(w.address, value.blockhash, [...budget(400_000, 100_000), ix]));
      } catch {
        // no price or no chain answer: tried again in an hour
      }
      // hourly until it passes (so the first check after funding is at most an hour away), then daily
      state.dry = { at: now, result }; // a result that is not "ok" is looked at again in an hour (see the check above)
      save();
    }
    // the same for a close order, hourly until it passes, then daily
    if (!state.pos && now - (state.dryClose?.at ?? 0) > (state.dryClose?.result === "ok" ? DRY_MS : 3_600_000)) {
      let r = { result: "no answer", tried: 0 };
      try {
        r = await dryClose(d);
      } catch {
        // the chain did not answer (the list of positions is a big read): tried again in an hour
      }
      state.dryClose = { at: now, ...r };
      save();
    }
    // and for a long: an open order of ours, and a close order against a long that exists on the chain
    if (!state.pos && now - (state.dryLong?.at ?? 0) > (state.dryLong?.result === "ok" ? DRY_MS : 3_600_000)) {
      let result = "no answer";
      try {
        const px = await d.price("SOL");
        const { value } = await d.rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
        const { ix } = openLongIx(w.address, "SOL", MIN_COLLATERAL_USD * HARD_LEVERAGE, MIN_COLLATERAL_USD, boundPrice(1, px, OPEN_SLIP, false), counter(), longMinOut("SOL", MIN_COLLATERAL_USD, px));
        result = await simulate(d, buildTx(w.address, value.blockhash, [...budget(400_000, 100_000), ix]));
      } catch {
        // tried again in an hour
      }
      state.dryLong = { at: now, result };
      save();
    }
    if (!state.pos && now - (state.dryCloseLong?.at ?? 0) > (state.dryCloseLong?.result === "ok" ? DRY_MS : 3_600_000)) {
      let r = { result: "no answer", tried: 0 };
      try {
        r = await dryClose(d, 1);
      } catch {
        // tried again in an hour
      }
      state.dryCloseLong = { at: now, ...r };
      save();
    }
    const paper = perpPaperOpens();
    const p = state.pos;
    if (p) {
      const onChain = await posOf(d, p.position);
      const size = onChain.sizeUsd;
      if (size > 0) {
        p.collateralUsd = onChain.collateralUsd;
        p.entryPx = onChain.entryPx;
        const px = await d.price(p.coin).catch(() => 0);
        if (px > 0) {
          p.unrealUsd = unrealUsd(p.dir ?? -1, size, onChain.entryPx, px);
          p.markMs = now;
        }
      }
      const pending = await exists(d, p.request);
      if (p.stage === "opening") {
        if (size > 0) {
          p.stage = "open";
          p.openedMs = now;
          save();
        } else if (!pending && now - p.sentMs > GONE_MS) await finish(d, w, p, false); // turned down or never landed: the USDC is back
        else if (pending && now - p.sentMs > CANCEL_MS && !p.cancelled) {
          p.cancelled = await sendChecked(d, w, [cancelRequestIx(w.address, p.position, p.request)], 200_000);
          save();
        }
      } else if (p.stage === "closing") {
        if (size === 0 && !pending) await finish(d, w, p, true);
        else if (!pending && now - p.sentMs > GONE_MS) {
          p.stage = "open"; // turned down (the price ran past our bound): asked again below, with a wider bound
          save();
        }
      }
      if (state.pos === p && p.stage === "open" && (!paper.some((o) => o.id === p.paperId) || now - (p.openedMs ?? now) >= MAX_HOLD_H * 3_600_000)) {
        if (size === 0) await finish(d, w, p, true); // gone already (liquidated, or closed by hand)
        else {
          const px = await d.price(p.coin);
          const made = closeIx(w.address, p.coin, p.dir ?? -1, boundPrice(p.dir ?? -1, px, CLOSE_SLIP[Math.min(p.closeTries, CLOSE_SLIP.length - 1)], true), counter());
          p.request = made.request;
          p.sentMs = now;
          p.closeTries++;
          save();
          // "closing" even when it seemed not to land: it may still land, and a second request is made only after GONE_MS
          if ((await sendChecked(d, w, [made.ix])) || state.lastSim === "ok") p.stage = "closing";
          save();
        }
      }
      return;
    }
    // ONE TEST TRADE (enrique, 15 Nov 2026 12:28 KST: "feel free to do one test in each of the new things so we know
    // everything works, try to not lose money of course"): the smallest short on SOL (the size the dry run passes
    // with), through the very code a promoted rule uses. It follows no paper position, so the next look closes it.
    // One per name, whatever the switch says; the name is written down before anything is sent.
    const tid = d.testId?.() ?? "";
    if (tid && !state.halted && state.test?.id !== tid) {
      state.test = { id: tid, at: now };
      save();
      const usdc = await d.usdc(w.address);
      if (usdc < MIN_COLLATERAL_USD + 1 || (await d.sol(w.address)) < MIN_SOL) {
        state.note = "test trade not made: too little USDC or SOL in the perps wallet";
        save();
      } else {
        const px = await d.price("SOL");
        const sizeUsd = MIN_COLLATERAL_USD * HARD_LEVERAGE;
        const made = openShortIx(w.address, "SOL", sizeUsd, MIN_COLLATERAL_USD, px * (1 - OPEN_SLIP), counter());
        state.pos = { rule: TEST_RULE, coin: "SOL", paperId: `test:${tid}`, stage: "opening", usdcBefore: usdc, sizeUsd, position: made.position, request: made.request, sentMs: now, closeTries: 0 };
        save();
        if (!(await sendChecked(d, w, [made.ix])) && state.lastSim !== "ok") {
          state.pos = null; // the simulation said no: nothing was sent
          state.note = `test trade not sent: simulation ${state.lastSim}`;
        }
        save();
      }
      return;
    }
    // ONE TEST LONG (enrique, 15 Nov 2026 18:52 KST: "feel free to run the test then"): the smallest long on SOL at 2x,
    // through the very code a promoted long uses, closed at the next look. It waits until the open and the close of a
    // long have passed their dry simulation; the name is written down before anything is sent, so it is made once.
    const lid = d.testLongId?.() ?? "";
    if (lid && !state.halted && state.testLong?.id !== lid && state.dryLong?.result === "ok" && state.dryCloseLong?.result === "ok") {
      state.testLong = { id: lid, at: now };
      save();
      const usdc = await d.usdc(w.address);
      if (usdc < MIN_COLLATERAL_USD + 1 || (await d.sol(w.address)) < MIN_SOL) {
        state.note = "test long not made: too little USDC or SOL in the perps wallet";
        save();
      } else {
        const px = await d.price("SOL");
        const sizeUsd = MIN_COLLATERAL_USD * HARD_LEVERAGE;
        const made = openLongIx(w.address, "SOL", sizeUsd, MIN_COLLATERAL_USD, boundPrice(1, px, OPEN_SLIP, false), counter(), longMinOut("SOL", MIN_COLLATERAL_USD, px));
        state.pos = { rule: TEST_RULE, coin: "SOL", paperId: `test-long:${lid}`, stage: "opening", usdcBefore: usdc, sizeUsd, position: made.position, request: made.request, sentMs: now, closeTries: 0, dir: 1, lev: HARD_LEVERAGE };
        save();
        if (!(await sendChecked(d, w, [made.ix])) && state.lastSim !== "ok") {
          state.pos = null; // the simulation said no: nothing was sent
          state.note = `test long not sent: simulation ${state.lastSim}`;
        }
        save();
      }
      return;
    }
    for (const o of paper) {
      if (state.seen.includes(o.id)) continue;
      state.seen = [...state.seen, o.id].slice(-500);
      if (!c.on || state.halted || !promoted(o.rule)) continue; // the usual case: paper only
      if (!o.dir || !CUSTODY[o.coin]) skip("not SOL, BTC or ETH");
      // a long is new on the real side: none is sent until the open AND the close of a long have passed their dry
      // simulation on the chain (MAIN, 15 Nov 2026)
      else if (o.dir > 0 && !(state.dryLong?.result === "ok" && state.dryCloseLong?.result === "ok")) skip("long: dry run not passed yet");
      else if (now - o.at > OPEN_WINDOW_MS) skip("paper position too old");
      else if (loss() + c.collateralUsd > c.maxLossUsd + 1e-9) skip("no room under the cap");
      else {
        const usdc = await d.usdc(w.address);
        if (usdc < c.collateralUsd + 1) {
          state.note = "too little USDC in the perps wallet";
          skip("too little USDC");
        } else if ((await d.sol(w.address)) < MIN_SOL) {
          state.note = "too little SOL in the perps wallet for fees";
          skip("too little SOL");
        } else {
          state.note = "";
          const px = await d.price(o.coin);
          const dir = o.dir > 0 ? 1 : -1;
          // a copied trader's own leverage, as it is; a rule's from the live rules. The collateral is all a liquidation can take.
          const jupMax = custodyMaxLeverage((await d.rpc<{ value: { data?: [string, string] } | null }>("getAccountInfo", [CUSTODY[o.coin], { encoding: "base64", commitment: "confirmed" }]).catch(() => null))?.value?.data?.[0]);
          const lev = Math.round(leverageFor(o.lev, c.leverage, jupMax) * 100) / 100;
          const sizeUsd = r2(c.collateralUsd * lev);
          const made = openIx(w.address, o.coin, dir, sizeUsd, c.collateralUsd, boundPrice(dir, px, OPEN_SLIP, false), counter(), dir > 0 ? longMinOut(o.coin, c.collateralUsd, px) : null);
          // written down before it is sent
          state.pos = { rule: o.rule, coin: o.coin, paperId: o.id, stage: "opening", usdcBefore: usdc, sizeUsd, position: made.position, request: made.request, sentMs: now, closeTries: 0, dir, lev };
          save();
          if (!(await sendChecked(d, w, [made.ix])) && state.lastSim !== "ok") {
            state.pos = null; // the simulation said no: nothing was sent
            skip("simulation failed");
          } // sent but not seen to land: kept as "opening", settled by what the chain shows after GONE_MS
          save();
          break; // one position at a time
        }
      }
    }
    save();
  } catch (e) {
    state.lastError = d.fixed(e);
  } finally {
    busy = false;
  }
}

// ---- status (public: rule names and numbers only) -----------------------------------------------------------------------
/** The one-time test asked for in deploy/live-rules.json ("solanaPerps": { "testOnce": "<name>" }); "" = none. */
function fileTest(): string {
  if (process.env.SOLANA_LIVE === "off") return "";
  try {
    const t = (JSON.parse(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8")) as { solanaPerps?: { testOnce?: unknown } }).solanaPerps?.testOnce;
    return typeof t === "string" ? t.slice(0, 40) : "";
  } catch {
    return "";
  }
}
function fileTestLong(): string {
  if (process.env.SOLANA_LIVE === "off") return "";
  try {
    const t = (JSON.parse(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8")) as { solanaPerps?: { testLongOnce?: unknown } }).solanaPerps?.testLongOnce;
    return typeof t === "string" ? t.slice(0, 40) : "";
  } catch {
    return "";
  }
}
function fileCfg(): PerpsLiveConfig {
  if (process.env.SOLANA_LIVE === "off") return OFF;
  try {
    return parsePerpsLive(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8"));
  } catch {
    return OFF;
  }
}
let liveCfg: () => PerpsLiveConfig = fileCfg;
export function perpsLiveSummary() {
  if (!loaded) load();
  const c = liveCfg();
  const done = state.rows.filter((x) => x.filled);
  const rules = perpRuleIds().map((id) => {
    const since = state.demoted[id] ?? 0;
    const paper = perpPaperRecord(id, since);
    const mine = done.filter((x) => x.rule === id);
    return { id, real: c.on && !state.halted && perpMeetsBar(id, since), paperTrades: paper.trades, paperWon: paper.won, paperNetUsd: r2(paper.netUsd), demotedAt: since || null, trades: mine.length, won: mine.filter((x) => x.netUsd > 0).length, netUsd: r2(mine.reduce((a, x) => a + x.netUsd, 0)) };
  });
  return {
    note: `REAL, off unless the live rules switch it on. Longs and shorts on SOL, BTC or ETH on Jupiter Perps, in a wallet of its own, one position at a time, $${c.collateralUsd || MIN_COLLATERAL_USD} of collateral each (all that a liquidation can take; a short is backed by USDC, a long by the coin, bought with USDC inside the order). A perp paper rule is traded at ${c.leverage || HARD_LEVERAGE}x while its paper record meets the bar (${REAL_MIN_TRADES}+ paper trades, half or more won, ahead after costs). A copied perp trader ("copy-" and a short tag) is followed on these three coins, at the leverage the trader set (not capped by us; never above half of where Jupiter liquidates), while its own paper copies meet the trader bar (${TRADER_MIN_COPIES}+ closed copies of any coin and side, half or more won, ahead, a day or more on paper). A rule or trader whose real trades lose $${c.ruleStopUsd || 3} goes back to paper. Every transaction is simulated on the chain before it is sent. dryRun / dryRunLong: an open order of ours simulated, hourly until it passes and then daily; dryRunClose / dryRunCloseLong: a close order simulated against a position that exists on the chain. Results are what a position did to the wallet's USDC; network fees in SOL are small and not counted.`,
    on: c.on && !state.halted,
    switch: c.on ? "on" : "off",
    halted: state.halted,
    stateNote: state.note,
    collateralUsd: c.collateralUsd,
    leverage: c.leverage,
    capUsd: c.maxLossUsd,
    ruleStopUsd: c.ruleStopUsd,
    netUsd: r2(state.netUsd),
    trades: done.length,
    won: done.filter((x) => x.netUsd > 0).length,
    notFilled: state.rows.length - done.length,
    // collateralUsd is USDC that sits in the position (or in a request on its way), not spent and not withdrawn;
    // unrealisedUsd is what the short has made at the last price read, before the fees to close
    open: state.pos ? { rule: state.pos.rule, coin: state.pos.coin, side: (state.pos.dir ?? -1) > 0 ? "long" : "short", leverage: state.pos.lev ?? null, stage: state.pos.stage, sizeUsd: state.pos.sizeUsd, since: state.pos.openedMs ?? state.pos.sentMs, collateralUsd: r2(state.pos.collateralUsd ?? c.collateralUsd), entryPrice: state.pos.entryPx ?? null, unrealisedUsd: state.pos.unrealUsd ?? 0, pricedAt: state.pos.markMs ?? null } : null,
    dryRun: state.dry,
    // the close order simulated as the owner of a short that exists on the chain (nothing signed or sent); tried = owners tried
    dryRunClose: state.dryClose ?? null,
    dryRunLong: state.dryLong ?? null,
    dryRunCloseLong: state.dryCloseLong ?? null,
    gas: gasSummary(),
    // the real trades for the page, newest first
    rows: state.rows.slice(-40).reverse(),
    // the one-time test trade: its name, when, and what it did to the wallet's USDC
    testLong: state.testLong ?? null,
    test: state.test ? { ...state.test, rows: state.rows.filter((x) => x.rule === TEST_RULE).map((x) => ({ t: x.t, filled: x.filled, netUsd: x.netUsd, heldH: x.heldH })) } : null,
    lastSimulation: state.lastSim,
    skipped: state.skipped,
    lastError: state.lastError,
    rulesReal: rules.filter((x) => x.real).length,
    rules: rules.filter((x) => x.real || x.trades || x.demotedAt || x.paperTrades >= (x.id.startsWith("copy-") ? TRADER_MIN_COPIES / 2 : REAL_MIN_TRADES / 2)),
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
export async function startPerpsLive() {
  if (timer || process.env.SOLANA_LIVE === "off" || process.env.SOLANA_BUCKETS === "off") return;
  const { kit, whyNotSent } = await import("./copylive.js");
  const { shared } = await import("./copyrun.js");
  const rpc = async <T>(method: string, params: unknown[], timeoutMs = 8000): Promise<T> => {
    const res = await shared.fetch()(shared.rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
    const j = (await res.json()) as { result?: T; error?: { message: string } };
    if (j.error) throw new Error(`rpc ${method}: error`);
    return j.result as T;
  };
  const d: PerpDeps = {
    cfg: fileCfg,
    wallet: () => namedWallet("perps"),
    testId: fileTest,
    testLongId: fileTestLong,
    rpc,
    send: (tx) => kit.send(tx),
    landed: (sig, ms) => kit.landed(sig, ms),
    sigOf: (tx) => kit.sigOf(tx),
    usdc: async (a) => Number((await kit.held(a, USDC)).amount) / 1e6,
    sol: (a) => kit.balance(a),
    price: async (coin) => {
      const res = await shared.fetch()(`https://api.binance.com/api/v3/ticker/price?symbol=${coin}USDT`, { signal: AbortSignal.timeout(8000) });
      const px = Number(((await res.json()) as { price?: string }).price);
      if (!(px > 0)) throw new Error("no price");
      return px;
    },
    fixed: (e) => whyNotSent(String((e as Error)?.message ?? e)),
  };
  setPerpsRealSummary(perpsLiveSummary);
  // SOL for fees (src/solana/gas.ts): the top-up and the one swap in this wallet, and the low flags of all three
  const addrOf = (f: string) => {
    try {
      return readFileSync(join(DATA, f), "utf8").trim();
    } catch {
      return "";
    }
  };
  const g: GasDeps = { wallet: () => namedWallet("perps"), others: () => ({ copy: addrOf("solana-wallet-address.txt"), rules: addrOf("solana-wallet-buckets-address.txt") }), perpsBusy: () => busy || Boolean(state.pos), swapOnce: fileSwap, kit };
  timer = setInterval(() => void perpsLiveTick(d).then(() => gasTick(g)), 30_000);
  timer.unref();
}

/** Test hooks. */
export const _test = { reset: () => ((state = fresh()), (loaded = true)), state: () => state, reload: () => load(), setCfg: (f: () => PerpsLiveConfig) => void (liveCfg = f) };
