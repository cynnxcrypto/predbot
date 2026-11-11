/**
 * Orca Whirlpool pool account: decoding and concentrated-liquidity maths. Read only, no keys, no transactions.
 *
 * Account layout (Anchor, 8 byte discriminator first):
 *   49 liquidity u128 · 65 sqrtPrice u128 (Q64.64) · 81 tickCurrentIndex i32 · 41 tickSpacing u16 · 45 feeRate u16
 *   101 tokenMintA · 165 feeGrowthGlobalA u128 (Q64.64, fee per unit of liquidity, LP share only)
 *   181 tokenMintB · 245 feeGrowthGlobalB u128
 */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const Q64 = 2 ** 64;
const U128 = 1n << 128n;

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

function u128(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64LE(off) | (buf.readBigUInt64LE(off + 8) << 64n);
}

export interface PoolSnap {
  /** ms */
  t: number;
  /** active (in range) pool liquidity, raw units */
  liquidity: bigint;
  sqrtPrice: bigint;
  tick: number;
  tickSpacing: number;
  /** fraction of each swap paid as fee, e.g. 0.0004 */
  feeRate: number;
  mintA: string;
  mintB: string;
  feeGrowthA: bigint;
  feeGrowthB: bigint;
}

export function decodeWhirlpool(data: Buffer, t: number): PoolSnap {
  if (data.length < 261) throw new Error(`whirlpool account too short: ${data.length} bytes`);
  return {
    t,
    tickSpacing: data.readUInt16LE(41),
    feeRate: data.readUInt16LE(45) / 1e6,
    liquidity: u128(data, 49),
    sqrtPrice: u128(data, 65),
    tick: data.readInt32LE(81),
    mintA: base58(data.subarray(101, 133)),
    feeGrowthA: u128(data, 165),
    mintB: base58(data.subarray(181, 213)),
    feeGrowthB: u128(data, 245),
  };
}

/** Price of token A in token B, in whole-token units (USDC per SOL for the SOL/USDC pool). */
export function price(snap: Pick<PoolSnap, "sqrtPrice">, decA: number, decB: number): number {
  const s = Number(snap.sqrtPrice) / Q64;
  return s * s * 10 ** (decA - decB);
}

/** Fee growth between two reads (the counter wraps at 2^128), as fee in raw token units per unit of raw liquidity. */
export function growth(prev: bigint, now: bigint): number {
  const d = (now - prev + U128) % U128;
  return Number(d) / Q64;
}

/** A concentrated position in whole-token units: liquidity L between prices lo and hi. */
export interface Range {
  L: number;
  lo: number;
  hi: number;
}

/** Token amounts (A, B) the position holds at price p. */
export function amounts(r: Range, p: number): { a: number; b: number } {
  const sa = Math.sqrt(r.lo);
  const sb = Math.sqrt(r.hi);
  if (p <= r.lo) return { a: r.L * (1 / sa - 1 / sb), b: 0 };
  if (p >= r.hi) return { a: 0, b: r.L * (sb - sa) };
  const s = Math.sqrt(p);
  return { a: r.L * (1 / s - 1 / sb), b: r.L * (s - sa) };
}

/** Position value in token B (USD for SOL/USDC) at price p. */
export function value(r: Range, p: number): number {
  const { a, b } = amounts(r, p);
  return a * p + b;
}

/** The position that `usd` buys at price p with a range of ±width (0.05 = 5%) around p. */
export function open(usd: number, p: number, width: number): Range {
  const lo = p * (1 - width);
  const hi = p * (1 + width);
  const L = usd / (2 * Math.sqrt(p) - p / Math.sqrt(hi) - Math.sqrt(lo));
  return { L, lo, hi };
}

/** Whole-token liquidity to the pool's raw liquidity units. */
export function rawLiquidity(L: number, decA: number, decB: number): number {
  return L * 10 ** ((decA + decB) / 2);
}
