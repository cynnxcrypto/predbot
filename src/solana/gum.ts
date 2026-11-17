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

const readShortVec = (b: Buffer, at: number): [number, number] => {
  let n = 0;
  for (let i = 0; i < 3; i++) {
    const x = b[at + i];
    if (x === undefined) return [-1, at];
    n |= (x & 0x7f) << (7 * i);
    if (!(x & 0x80)) return [n, at + i + 1];
  }
  return [-1, at];
};
/**
 * How a transaction the Gum API built is laid out, said without any address (for the status): its length, its
 * signature slots, the message's version, header and keys, and where our key is.
 * Two encodings of the slots are tried (17 Nov 2026, dep-3: the API's deposit came as 544 bytes starting 2, 65, 0, 0
 * with our key at byte 169):
 *  - "plain": 64 bytes a slot, as on Solana;
 *  - "typed": Jupnet's typed signature, each slot its length (a short-vec, 65) then a type byte (0 = ed25519) and the
 *    64 bytes. With it, the dep-3 transaction reads as a legacy message at byte 133 whose second key is ours.
 * The one whose message wants exactly as many signers as there are slots, and names our key among them, is used.
 */
type SlotEnc = "plain" | "typed";
function readAs(tx: Buffer, w: Wallet, enc: SlotEnc) {
  const [nSig, sigsAt] = readShortVec(tx, 0);
  const out = { enc, nSig, sigsAt, slots: [] as [number, number][], msgAt: -1, version: null as string | null, required: -1, readonlySigned: -1, keys: -1, ourKeyAt: -1 };
  if (nSig < 0 || nSig > 8) return out;
  let at = sigsAt;
  for (let i = 0; i < nSig; i++) {
    if (enc === "plain") {
      out.slots.push([at, 64]);
      at += 64;
    } else {
      const [len, from] = readShortVec(tx, at);
      if (len !== 65) return out;
      out.slots.push([from, 65]);
      at = from + 65;
    }
  }
  if (at >= tx.length) return out;
  const msg = tx.subarray(at);
  const v = msg[0] & 0x80 ? msg[0] & 0x7f : null;
  const off = v === null ? 0 : 1;
  const [nKeys, keysAt] = readShortVec(msg, off + 3);
  Object.assign(out, { msgAt: at, version: v === null ? "legacy" : `v${v}`, required: msg[off], readonlySigned: msg[off + 1], keys: nKeys });
  for (let i = 0; i < nKeys && keysAt + 32 * (i + 1) <= msg.length; i++) if (msg.subarray(keysAt + 32 * i, keysAt + 32 * (i + 1)).equals(w.pubkey)) out.ourKeyAt = i;
  return out;
}
const fits = (r: ReturnType<typeof readAs>) => r.msgAt > 0 && (r.version === "legacy" || r.version === "v0") && r.required >= 1 && r.required <= 2 && r.required === r.nSig && r.ourKeyAt >= 0 && r.ourKeyAt < r.required;
export function txLayout(b64: string, w: Wallet) {
  const tx = Buffer.from(b64, "base64");
  const tries = (["plain", "typed"] as const).map((e) => readAs(tx, w, e));
  const r = tries.find(fits) ?? tries[0];
  const { slots: _s, ...rest } = r;
  return { bytes: tx.length, first: [...tx.subarray(0, 4)], ourBytesAt: tx.indexOf(w.pubkey), ...rest, fits: fits(r), other: tries.filter((x) => x !== r).map((x) => ({ enc: x.enc, msgAt: x.msgAt, required: x.required, keys: x.keys, ourKeyAt: x.ourKeyAt })) };
}
/**
 * Sign a transaction the Gum API built for us (deposit, transfer): the API is its fee payer and adds its own
 * signature. Only a transaction read in one of the two slot encodings with a legacy or v0 message that wants as many
 * signers as it has slots (one or two) and names our key among them is signed, in our own slot (the message's bytes,
 * ed25519), in the slot's own encoding; everything else in the transaction is left as the API sent it. Anything
 * else is refused, with its layout in the error.
 */
export function signApiTx(b64: string, w: Wallet): string {
  const tx = Buffer.from(b64, "base64");
  const r = (["plain", "typed"] as const).map((e) => readAs(tx, w, e)).find(fits);
  if (!r) throw new Error(`gum: transaction not read as one we may sign ${JSON.stringify(txLayout(b64, w))}`);
  const out = Buffer.from(tx);
  const sig = w.sign(tx.subarray(r.msgAt));
  const [at] = r.slots[r.ourKeyAt];
  if (r.enc === "plain") sig.copy(out, at);
  else {
    out[at] = 0; // ed25519
    sig.copy(out, at + 1);
  }
  return out.toString("base64");
}
