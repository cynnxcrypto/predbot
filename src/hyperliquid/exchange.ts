/**
 * Talking to Hyperliquid's exchange: signing and the few actions the bot needs (set leverage, place an order,
 * name the trading key). No money leaves through here: Hyperliquid has no action in this file that withdraws or
 * transfers, and the trading key that signs orders could not do it anyway.
 *
 * Signing is Hyperliquid's own scheme (as in its Python SDK): the action is packed (msgpack), hashed with the nonce,
 * and that hash is signed as an EIP-712 "Agent" message. The hash routine is checked in the tests against the value
 * Hyperliquid's SDK publishes for a known order.
 */
import { arrayify, concat, hexlify, hexZeroPad, splitSignature } from "@ethersproject/bytes";
import { keccak256 } from "@ethersproject/keccak256";
import type { Wallet } from "@ethersproject/wallet";
import { HL_API } from "./fund.js";
import { hlHttp } from "./ratelog.js";

// ---- msgpack (only what an action holds: maps, lists, strings, whole numbers, true/false, null) ---------------------------
export function pack(v: unknown): Uint8Array {
  const out: number[] = [];
  const u = (n: number, bytes: number) => {
    for (let i = bytes - 1; i >= 0; i--) out.push(Number((BigInt(n) >> BigInt(8 * i)) & 255n));
  };
  const put = (x: unknown): void => {
    if (x === null || x === undefined) out.push(0xc0);
    else if (x === true) out.push(0xc3);
    else if (x === false) out.push(0xc2);
    else if (typeof x === "number") {
      if (!Number.isInteger(x) || x < 0) throw new Error("pack: only whole numbers from 0 (prices and sizes go as text)");
      if (x < 128) out.push(x);
      else if (x < 2 ** 8) out.push(0xcc, x);
      else if (x < 2 ** 16) (out.push(0xcd), u(x, 2));
      else if (x < 2 ** 32) (out.push(0xce), u(x, 4));
      else (out.push(0xcf), u(x, 8));
    } else if (typeof x === "string") {
      const b = Buffer.from(x, "utf8");
      if (b.length < 32) out.push(0xa0 | b.length);
      else if (b.length < 2 ** 8) out.push(0xd9, b.length);
      else (out.push(0xda), u(b.length, 2));
      out.push(...b);
    } else if (Array.isArray(x)) {
      if (x.length < 16) out.push(0x90 | x.length);
      else (out.push(0xdc), u(x.length, 2));
      x.forEach(put);
    } else if (typeof x === "object") {
      const ks = Object.keys(x as object);
      if (ks.length < 16) out.push(0x80 | ks.length);
      else (out.push(0xde), u(ks.length, 2));
      for (const k of ks) (put(k), put((x as Record<string, unknown>)[k]));
    } else throw new Error(`pack: cannot pack ${typeof x}`);
  };
  put(v);
  return Uint8Array.from(out);
}

/** The hash Hyperliquid signs for an action: packed action + nonce (8 bytes) + "no vault". */
export const actionHash = (action: unknown, nonce: number): string => keccak256(concat([pack(action), hexZeroPad(hexlify(nonce), 8), [0]]));

const AGENT_DOMAIN = { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" };
const AGENT_TYPES = { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] };
export type Sig = { r: string; s: string; v: number };
const sigOf = (hex: string): Sig => {
  const s = splitSignature(hex);
  return { r: s.r, s: s.s, v: s.v };
};
/** Sign a trading action (order, leverage) with the trading key. "a" = mainnet. */
export const signAction = async (key: Wallet, action: unknown, nonce: number): Promise<Sig> => sigOf(await key._signTypedData(AGENT_DOMAIN, AGENT_TYPES, { source: "a", connectionId: arrayify(actionHash(action, nonce)) }));

// ---- prices and sizes as Hyperliquid wants them ------------------------------------------------------------------------------
/** A number as Hyperliquid's text: up to 8 decimals, no trailing zeros. */
export function wire(x: number): string {
  const s = x.toFixed(8).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}
/** A perp price: at most 5 significant figures and at most (6 - size decimals) decimals. */
export function roundPx(px: number, szDecimals: number): number {
  if (!(px > 0)) throw new Error("no price");
  const sig = Number(px.toPrecision(5));
  const d = Math.max(0, 6 - szDecimals);
  return Number(sig.toFixed(d));
}
/** A size rounded DOWN to the coin's size decimals. */
export const roundSz = (sz: number, szDecimals: number): number => Math.floor(sz * 10 ** szDecimals + 1e-9) / 10 ** szDecimals;

export interface Coin {
  index: number;
  szDecimals: number;
  maxLeverage: number;
}
/** Hyperliquid's coin list (info "meta") -> coin name -> its number, size decimals and highest leverage. Delisted coins are left out. */
export function coinsOf(meta: unknown): Record<string, Coin> {
  const rows = (meta as { universe?: unknown })?.universe;
  const out: Record<string, Coin> = {};
  if (!Array.isArray(rows)) return out;
  rows.forEach((x: { name?: unknown; szDecimals?: unknown; maxLeverage?: unknown; isDelisted?: unknown }, index) => {
    const d = Number(x?.szDecimals);
    const lev = Number(x?.maxLeverage);
    if (typeof x?.name !== "string" || x.isDelisted === true || !Number.isInteger(d) || d < 0 || d > 8 || !(lev >= 1)) return;
    out[x.name] = { index, szDecimals: d, maxLeverage: lev };
  });
  return out;
}

// ---- the actions ----------------------------------------------------------------------------------------------------------
export const orderAction = (coin: Coin, buy: boolean, px: number, sz: number, reduceOnly: boolean) => ({
  type: "order",
  orders: [{ a: coin.index, b: buy, p: wire(roundPx(px, coin.szDecimals)), s: wire(sz), r: reduceOnly, t: { limit: { tif: "Ioc" } } }],
  grouping: "na",
});
/** Isolated margin: a position can lose its own collateral and nothing else in the account. */
export const leverageAction = (coin: Coin, leverage: number) => ({ type: "updateLeverage", asset: coin.index, isCross: false, leverage: Math.floor(leverage) });

export interface Fill {
  filled: boolean;
  sz: number;
  px: number;
  oid: number | null;
  error: string | null;
}
/** What an order answer says: filled (how much, at what price) or why not. */
export function readOrder(answer: unknown): Fill {
  const a = answer as { status?: string; response?: unknown };
  const none = (error: string): Fill => ({ filled: false, sz: 0, px: 0, oid: null, error });
  if (a?.status !== "ok") return none(typeof a?.response === "string" ? a.response.slice(0, 160) : "no ok from Hyperliquid");
  const st = (a.response as { data?: { statuses?: unknown[] } })?.data?.statuses?.[0] as { filled?: { totalSz?: string; avgPx?: string; oid?: number }; error?: string } | undefined;
  if (st?.filled) {
    const sz = Number(st.filled.totalSz);
    const px = Number(st.filled.avgPx);
    return sz > 0 && px > 0 ? { filled: true, sz, px, oid: st.filled.oid ?? null, error: null } : none("a fill with no size or price");
  }
  return none(typeof st?.error === "string" ? st.error.slice(0, 160) : "not filled");
}

export async function post(path: "info" | "exchange", body: unknown, fetcher: typeof fetch = fetch): Promise<unknown> {
  const res = await fetcher(`${HL_API}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }).catch((e) => {
    hlHttp(null, "real");
    throw e;
  });
  hlHttp(res.status, "real");
  if (!res.ok) throw new Error(`hyperliquid ${path} http ${res.status}`);
  return res.json();
}
let lastNonce = 0;
/** Hyperliquid wants a fresh, rising millisecond number with every action. */
export const nonce = (now = Date.now()) => (lastNonce = Math.max(now, lastNonce + 1));
/** Send a trading action signed by the trading key. */
export async function send(key: Wallet, action: unknown, fetcher: typeof fetch = fetch): Promise<unknown> {
  const n = nonce();
  return post("exchange", { action, nonce: n, signature: await signAction(key, action, n), vaultAddress: null }, fetcher);
}

/**
 * Move USDC from one Hyperliquid account to another, inside Hyperliquid (no chain, no bridge, no gas). Signed by the
 * WALLET that pays: the trading key cannot do this. Only ever called with our own second wallet as the destination.
 */
export async function usdSend(wallet: Wallet, destination: string, usd: number, fetcher: typeof fetch = fetch): Promise<unknown> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(destination) || !(usd > 0)) throw new Error("usdSend: bad destination or amount");
  const n = nonce();
  const action = { type: "usdSend", hyperliquidChain: "Mainnet", signatureChainId: "0xa4b1", destination: destination.toLowerCase(), amount: wire(usd), time: n };
  const domain = { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: "0x0000000000000000000000000000000000000000" };
  const types = { "HyperliquidTransaction:UsdSend": [{ name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "amount", type: "string" }, { name: "time", type: "uint64" }] };
  const signature = sigOf(await wallet._signTypedData(domain, types, { hyperliquidChain: action.hyperliquidChain, destination: action.destination, amount: action.amount, time: n }));
  return post("exchange", { action, nonce: n, signature }, fetcher);
}

/**
 * Name the trading key for the account. This one is signed by the WALLET itself (it is the account's own consent),
 * once. After it, the trading key can place and cancel orders for the account and nothing else.
 */
export async function approveAgent(wallet: Wallet, agentAddress: string, fetcher: typeof fetch = fetch): Promise<unknown> {
  const n = nonce();
  const action = { type: "approveAgent", hyperliquidChain: "Mainnet", signatureChainId: "0xa4b1", agentAddress: agentAddress.toLowerCase(), agentName: "predbot", nonce: n };
  const domain = { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: "0x0000000000000000000000000000000000000000" };
  const types = { "HyperliquidTransaction:ApproveAgent": [{ name: "hyperliquidChain", type: "string" }, { name: "agentAddress", type: "address" }, { name: "agentName", type: "string" }, { name: "nonce", type: "uint64" }] };
  const signature = sigOf(await wallet._signTypedData(domain, types, { hyperliquidChain: action.hyperliquidChain, agentAddress: action.agentAddress, agentName: action.agentName, nonce: n }));
  return post("exchange", { action, nonce: n, signature }, fetcher);
}
