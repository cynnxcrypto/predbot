/**
 * Meteora DLMM pool accounts: addresses, decoding and fee arithmetic. Read only, no keys, no transactions.
 *
 * A DLMM pool keeps its liquidity in price bins (each bin is one price, binStep basis points above the one below).
 * Only the active bin trades. Each bin carries two fee counters, "swap fee per liquidity deposited", and those
 * counters are what real positions are paid from.
 *
 * Layouts are from Meteora's published program description (dlmm-sdk idls/dlmm.json, read 12 Nov 2026), 8 byte
 * discriminator first:
 *   LbPair (904 bytes):    8 baseFactor u16 · 16 variableFeeControl u32 · 40 volatilityAccumulator u32
 *                          56 lastUpdateTimestamp i64 · 76 activeId i32 · 80 binStep u16
 *                          88 tokenXMint · 120 tokenYMint · 152 reserveX · 184 reserveY
 *   BinArray (10136 bytes): 8 index i64 · 24 lbPair · 56 bins[70], 144 bytes each:
 *                          0 amountX u64 · 8 amountY u64 · 16 price u128 (Q64.64, raw Y per raw X)
 *                          32 liquiditySupply u128 · 80 feeXPerTokenStored u128 · 96 feeYPerTokenStored u128
 * Addresses: a pool is derived from its two mints and bin step (older pools), or mints, bin step and base factor;
 * a bin array from "bin_array", the pool and its index. The derivation reproduces four known SOL/USDC pool
 * addresses (dlmm.test.ts). Every account read is checked: owner, length, discriminator, and the pool it names.
 */
import { findProgramAddress, ordered, pubkeyBytes } from "./pda.js";
import { base58 } from "./whirlpool.js";

export const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export const BINS_PER_ARRAY = 70;
const LB_PAIR_DISC = Buffer.from([33, 11, 49, 98, 181, 101, 177, 13]);
const BIN_ARRAY_DISC = Buffer.from([92, 142, 92, 220, 5, 148, 70, 181]);
const Q64 = 2 ** 64;
const U128 = 1n << 128n;

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u128 = (buf: Buffer, off: number) => buf.readBigUInt64LE(off) | (buf.readBigUInt64LE(off + 8) << 64n);

/** Address of the pool for two tokens: by bin step alone (older pools) or by bin step and base factor. May not exist. */
export function lbPairAddress(m1: string, m2: string, binStep: number, baseFactor?: number): string {
  const [a, b] = ordered(m1, m2);
  return findProgramAddress([pubkeyBytes(a), pubkeyBytes(b), u16(binStep), ...(baseFactor === undefined ? [] : [u16(baseFactor)])], DLMM_PROGRAM);
}

export const arrayIndex = (binId: number) => Math.floor(binId / BINS_PER_ARRAY);

export function binArrayAddress(lbPair: string, index: number): string {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(index));
  return findProgramAddress([Buffer.from("bin_array"), pubkeyBytes(lbPair), b], DLMM_PROGRAM);
}

export interface LbPair {
  activeId: number;
  binStep: number;
  baseFactor: number;
  variableFeeControl: number;
  volatilityAccumulator: number;
  /** seconds: when the pool last traded */
  lastSwapSec: number;
  mintX: string;
  mintY: string;
  reserveX: string;
  reserveY: string;
}

export function decodeLbPair(data: Buffer): LbPair {
  if (data.length !== 904 || !data.subarray(0, 8).equals(LB_PAIR_DISC)) throw new Error("not a DLMM pool account");
  return {
    baseFactor: data.readUInt16LE(8),
    variableFeeControl: data.readUInt32LE(16),
    volatilityAccumulator: data.readUInt32LE(40),
    lastSwapSec: Number(data.readBigInt64LE(56)),
    activeId: data.readInt32LE(76),
    binStep: data.readUInt16LE(80),
    mintX: base58(data.subarray(88, 120)),
    mintY: base58(data.subarray(120, 152)),
    reserveX: base58(data.subarray(152, 184)),
    reserveY: base58(data.subarray(184, 216)),
  };
}

/** The fee a swap pays now, as a fraction: the base fee plus the part that grows with recent bin crossings. For show only. */
export function feeRate(p: LbPair): number {
  const base = p.baseFactor * p.binStep * 10;
  const variable = p.variableFeeControl > 0 ? Math.ceil((p.variableFeeControl * (p.volatilityAccumulator * p.binStep) ** 2) / 1e11) : 0;
  return Math.min(base + variable, 1e8) / 1e9;
}

export interface Bin {
  id: number;
  x: bigint;
  y: bigint;
  /** Q64.64, raw Y per raw X */
  price: bigint;
  supply: bigint;
  fx: bigint;
  fy: bigint;
}

export function decodeBinArray(data: Buffer, lbPair: string): { index: number; bins: Bin[] } {
  if (data.length !== 10136 || !data.subarray(0, 8).equals(BIN_ARRAY_DISC)) throw new Error("not a bin array account");
  if (base58(data.subarray(24, 56)) !== lbPair) throw new Error("bin array of another pool");
  const index = Number(data.readBigInt64LE(8));
  const bins: Bin[] = [];
  for (let j = 0; j < BINS_PER_ARRAY; j++) {
    const o = 56 + j * 144;
    bins.push({ id: index * BINS_PER_ARRAY + j, x: data.readBigUInt64LE(o), y: data.readBigUInt64LE(o + 8), price: u128(data, o + 16), supply: u128(data, o + 32), fx: u128(data, o + 80), fy: u128(data, o + 96) });
  }
  return { index, bins };
}

/** Price of the active bin in whole tokens: Y for one X. */
export const binPrice = (binStep: number, id: number, decX: number, decY: number) => (1 + binStep / 1e4) ** id * 10 ** (decX - decY);

export interface Mark {
  fx: bigint;
  fy: bigint;
}

/**
 * What the bins' fee counters paid since each bin was last looked at. Updates the marks.
 *   r      sum over bins of (fee paid to the bin) / (value in the bin): what a position holding one unit of value
 *          in every bin was paid, in units of that value
 *   paidY  the fees in all, raw token Y (X fees turned at the bin's own price): a sanity figure for the whole pool
 *   unseen bins with liquidity that had no mark yet: their fees over this stretch could not be counted
 *   shareValue  for bins that paid: value in the bin per unit of its liquidity supply. The arithmetic assumes this
 *          is about 1; it is reported so that a wrong assumption shows.
 * The counters are Q64.64 per unit of (liquiditySupply >> 64), as the program pays positions.
 */
export function binFees(marks: Map<number, Mark>, bins: Bin[]): { r: number; paidY: number; counted: number; unseen: number; shareValue: number[] } {
  let r = 0;
  let paidY = 0;
  let counted = 0;
  let unseen = 0;
  const shareValue: number[] = [];
  for (const b of bins) {
    const m = marks.get(b.id);
    marks.set(b.id, { fx: b.fx, fy: b.fy });
    if (!m) {
      if (b.supply > 0n) unseen++;
      continue;
    }
    const dfx = (b.fx - m.fx + U128) % U128;
    const dfy = (b.fy - m.fy + U128) % U128;
    if (dfx === 0n && dfy === 0n) continue;
    const price = Number(b.price) / Q64;
    const perShare = (Number(dfx) * price + Number(dfy)) / Q64; // raw Y per unit of (supply >> 64)
    const supply = Number(b.supply >> 64n);
    const value = price * Number(b.x) + Number(b.y);
    const sv = supply > 0 && value > 0 ? value / supply : 1;
    const ri = perShare / sv;
    if (!(ri >= 0) || ri > 0.05) continue; // a bin paying 5% of itself between two reads is a bad read
    r += ri;
    paidY += perShare * supply;
    counted++;
    if (supply > 0 && value > 0) shareValue.push(sv);
  }
  return { r, paidY, counted, unseen, shareValue };
}
