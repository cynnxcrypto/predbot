/**
 * Jupiter Perps' second engine, Gum (JTX), 17 Nov 2026. enrique: "from jupiter we can also do other coins im sure,
 * at least 5 or 6". He is right: since 22 Sep 2026 Jupiter Perps also lists HYPE, ZEC, JUP and tokenized stocks
 * (SPCX, SNDK, SKHYNIX), but not in the JLP pool that perpslive.ts trades (that pool holds only SOL, BTC and ETH):
 * on an order book run by Gum, on Jupnet, with its own program (JTX) and its own API (github.com/jupnet/gum-perp-sdk,
 * docs/REST_API.md, read 17 Nov 2026). Orders there are not Solana transactions: each one is a signed "action"
 * (Jupnet action format) posted to the API, which queues it for the sequencer.
 *
 * This file is the client: the market list, the lot arithmetic and the signing of an order, ported from the
 * Rust SDK (src/action.rs, src/market.rs, src/request.rs) and checked against its golden bytes (gum.test.ts).
 * It sends nothing by itself. What may be sent, and when, is decided by the caller.
 */
import { base58 } from "./whirlpool.js";
import { base58decode, type Wallet } from "./keys.js";

export const GUM_API = process.env.GUM_API || "https://api.gum.ag/perps";
export const JTX_PROGRAM_ID = "jtxQHH3ysuWRETjaynai3jowPztq2LBJApVFcEv4Wmg";
const QUOTE_DECIMALS = 6;

export interface GumLimits {
  minOrderQty: number;
  minOrderNotional: number;
  maxOpenOrderQty: number;
  maxOpenOrderNotional: number;
}
export interface GumMarket {
  symbol: string;
  baseDecimals: number;
  baseLotSize: number;
  quoteLotSize: number;
  tickSize?: number;
  stepSize?: number;
  orderLimitConfig?: { limit?: GumLimits; market?: GumLimits; postOnly?: GumLimits };
  maxAccountPositionNotional?: number;
  maxMarketOpenInterest?: number;
  indexPrice?: number;
  markPrice?: number;
  bestBid?: number;
  bestAsk?: number;
  maxLeverage?: number;
  initialMarginRatioBps?: number;
  maintenanceMarginRatioBps?: number;
  takerFeeBps?: number;
  makerFeeBps?: number;
  liquidationFeeBps?: number;
  openInterest?: number;
  volume24h?: number;
  lastTradePrice?: number;
}

/** Quantity (coins) to base lots, as the SDK rounds it. */
export function toBaseLots(m: Pick<GumMarket, "baseDecimals" | "baseLotSize">, quantity: number): bigint {
  const per = 10n ** BigInt(m.baseDecimals) / BigInt(m.baseLotSize);
  const lots = Math.round(quantity * Number(per));
  if (lots <= 0) throw new Error("gum: quantity under one lot");
  return BigInt(lots);
}
/** Price (USD per coin) to price lots, as the SDK does it (rounded product, then whole division). */
export function toPriceLots(m: Pick<GumMarket, "baseDecimals" | "baseLotSize" | "quoteLotSize">, price: number): bigint {
  const mult = 10n ** BigInt(QUOTE_DECIMALS) * BigInt(m.baseLotSize);
  const div = 10n ** BigInt(m.baseDecimals) * BigInt(m.quoteLotSize);
  const lots = BigInt(Math.round(price * Number(mult))) / div;
  if (lots <= 0n) throw new Error("gum: price under one tick");
  return lots;
}
/** Base lots back to coins. */
export const baseLotsToQty = (m: Pick<GumMarket, "baseDecimals" | "baseLotSize">, lots: bigint) => (Number(lots) * m.baseLotSize) / 10 ** m.baseDecimals;

// --- Borsh, as the SDK writes it ---
const u8 = (x: number) => Buffer.from([x]);
const u32 = (x: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(x);
  return b;
};
const u64 = (x: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(x);
  return b;
};
const u128 = (x: bigint) => Buffer.concat([u64(x & ((1n << 64n) - 1n)), u64(x >> 64n)]);
const str = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
const opt = (b: Buffer | null) => (b ? Buffer.concat([u8(1), b]) : u8(0));

export type GumSide = "Bid" | "Ask";
export type GumOrderType = "limit" | "market" | "postOnly";
export type GumTif = "GoodTilCanceled" | "ImmediateOrCancel" | "FillOrKill";
export interface GumPlace {
  subaccountId: number;
  symbol: string;
  side: GumSide;
  orderType: GumOrderType;
  /** USD per coin; for a market order the worst price accepted (0 = none) */
  price: number;
  /** coins */
  quantity: number;
  reduceOnly: boolean;
  timeInForce: GumTif;
  clientOrderId: bigint | null;
  /** isolated margin: USDC native units moved from the cross account into the isolated one (0 = its own balance) */
  collateralAmount?: bigint;
  isIsolated: boolean;
}
export interface GumCancelAll {
  subaccountId: number;
  symbol: string;
  isIsolated: boolean;
}
export interface GumCancel extends GumCancelAll {
  orderId: bigint | null;
  clientOrderId: bigint | null;
}

const SIDE = { Bid: 0, Ask: 1 } as const;
const OTYPE = { limit: 0, market: 1, postOnly: 2 } as const;
/** OnchainTimeInForce: Seconds(u32) = 0 (GTC = Seconds(0)), ImmediateOrCancel = 1, FillOrKill = 2 */
const tifBytes = (t: "gtc" | "ioc" | "fok") => (t === "gtc" ? Buffer.concat([u8(0), u32(0)]) : u8(t === "ioc" ? 1 : 2));

/** The instruction data of a place order: tag 3 (cross) or 30 (isolated), then Borsh params. */
export function placeData(m: GumMarket, o: GumPlace): Buffer {
  if (o.isIsolated !== (o.collateralAmount !== undefined)) throw new Error("gum: isIsolated and collateralAmount go together");
  if (o.reduceOnly && (o.collateralAmount ?? 0n) > 0n) throw new Error("gum: a reduce-only order draws no collateral");
  let priceLots: bigint;
  let tif: "gtc" | "ioc" | "fok";
  if (o.orderType === "market") {
    tif = o.timeInForce === "FillOrKill" ? "fok" : "ioc";
    priceLots = o.price > 0 ? toPriceLots(m, o.price) : 0n;
  } else {
    if (!(o.price > 0)) throw new Error("gum: limit and post-only orders need a price");
    tif = o.timeInForce === "ImmediateOrCancel" ? "ioc" : o.timeInForce === "FillOrKill" ? "fok" : "gtc";
    priceLots = toPriceLots(m, o.price);
  }
  const params = Buffer.concat([
    u8(o.subaccountId),
    str(o.symbol),
    u64(priceLots),
    u64(toBaseLots(m, o.quantity)),
    u8(SIDE[o.side]),
    u8(OTYPE[o.orderType]),
    u8(o.reduceOnly ? 1 : 0),
    tifBytes(tif),
    opt(o.clientOrderId ? u64(o.clientOrderId) : null),
  ]);
  return o.isIsolated ? Buffer.concat([u8(30), u64(o.collateralAmount!), params]) : Buffer.concat([u8(3), params]);
}
export function cancelData(o: GumCancel): Buffer {
  return Buffer.concat([u8(o.isIsolated ? 31 : 4), u8(o.subaccountId), str(o.symbol), opt(o.orderId !== null ? u128(o.orderId) : null), opt(o.clientOrderId ? u64(o.clientOrderId) : null)]);
}
export function cancelAllData(o: GumCancelAll): Buffer {
  return Buffer.concat([u8(o.isIsolated ? 32 : 5), u8(o.subaccountId), str(o.symbol)]);
}
const shortVec = (n: number) => {
  const out: number[] = [];
  for (;;) {
    const e = n & 0x7f;
    n >>= 7;
    if (!n) return out.push(e), Buffer.from(out);
    out.push(e | 0x80);
  }
};
/** The bytes signed for an action: blockhash, the JTX program, one signer, the data (src/action.rs serialize_action_message). */
export function actionMessage(signer: Buffer, blockhash: Buffer, data: Buffer): Buffer {
  return Buffer.concat([blockhash, base58decode(JTX_PROGRAM_ID), shortVec(1), signer, shortVec(data.length), data]);
}
/** "0:<base58 ed25519 signature>", the API's typed signature. */
export const typedSignature = (sig: Buffer) => `0:${base58(sig)}`;

/** The JSON body of a signed place order, as the SDK's PlaceOrderSigned serializes it. */
export function signedPlace(w: Wallet, m: GumMarket, o: GumPlace, tradingAccount: string, blockhash: string) {
  const sig = w.sign(actionMessage(w.pubkey, base58decode(blockhash), placeData(m, o)));
  return {
    subaccountId: o.subaccountId,
    symbol: o.symbol,
    side: o.side,
    orderType: o.orderType,
    price: o.price,
    quantity: o.quantity,
    reduceOnly: o.reduceOnly,
    timeInForce: o.timeInForce,
    clientOrderId: o.clientOrderId === null ? null : Number(o.clientOrderId),
    ...(o.collateralAmount !== undefined ? { collateralAmount: Number(o.collateralAmount) } : {}),
    isIsolated: o.isIsolated,
    tradingAccount,
    recentBlockhash: blockhash,
    signature: typedSignature(sig),
  };
}
export function signedCancelAll(w: Wallet, o: GumCancelAll, tradingAccount: string, blockhash: string) {
  const sig = w.sign(actionMessage(w.pubkey, base58decode(blockhash), cancelAllData(o)));
  return { subaccountId: o.subaccountId, isIsolated: o.isIsolated, symbol: o.symbol, tradingAccount, recentBlockhash: blockhash, signature: typedSignature(sig) };
}

/** One call to the Gum API: JSON in and out, a time-out, and the error code it gave. */
export async function gum<T>(path: string, init: { method?: string; pubkey?: string; body?: unknown } = {}, ms = 15_000): Promise<T> {
  const res = await fetch(GUM_API + path, {
    method: init.method ?? "GET",
    headers: { ...(init.pubkey ? { "X-PUBKEY": init.pubkey } : {}), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(ms),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`gum ${path.split("?")[0]} http ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}
export const gumMarkets = () => gum<GumMarket[]>("/markets");
export const gumBlockhash = () => gum<{ blockhash: string }>("/blockhash");

/**
 * Sign a transaction the Gum API built for us (deposit, transfer): its fee payer is the API, so it has two signature
 * slots. Our signature goes in the slot of our key. Refuses a transaction that wants more than two signers or does
 * not name our key among them.
 */
export function signApiTx(b64: string, w: Wallet): string {
  const tx = Buffer.from(b64, "base64");
  const nSig = tx[0];
  if (nSig < 1 || nSig > 2) throw new Error(`gum: transaction wants ${nSig} signatures`);
  const msg = tx.subarray(1 + 64 * nSig);
  const off = msg[0] & 0x80 ? 1 : 0;
  const required = msg[off];
  if (required !== nSig) throw new Error("gum: signature slots do not match the message");
  const keysAt = off + 4; // header (3 bytes), then a one-byte count while there are fewer than 128 keys
  if (msg[off + 3] & 0x80) throw new Error("gum: too many accounts");
  let slot = -1;
  for (let i = 0; i < required; i++) if (msg.subarray(keysAt + 32 * i, keysAt + 32 * (i + 1)).equals(w.pubkey)) slot = i;
  if (slot < 0) throw new Error("gum: our wallet is not a signer of this transaction");
  w.sign(msg).copy(tx, 1 + 64 * slot);
  return tx.toString("base64");
}
