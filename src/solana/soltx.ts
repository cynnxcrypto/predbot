/**
 * The few pieces of Solana needed to build a transaction by hand (the repo has no Solana library): program-derived
 * addresses, associated token accounts, and a legacy message with several instructions. Used by perpslive.ts, where
 * no API hands us a finished transaction as Jupiter's swap API does. Checked in soltx.test.ts against addresses
 * published by Jupiter.
 */
import { createHash } from "node:crypto";
import { base58decode } from "./keys.js";
import { base58 } from "./whirlpool.js";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

const P = 2n ** 255n - 19n;
const mod = (a: bigint) => ((a % P) + P) % P;
function pow(b: bigint, e: bigint): bigint {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = mod(r * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return r;
}
const D = mod(-121665n * pow(121666n, P - 2n));
/** Is this 32-byte value a point on the ed25519 curve? (A program-derived address must NOT be.) */
export function onCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // x = u v^3 (u v^7)^((p-5)/8); the point exists when v x^2 is u or -u
  const v3 = mod(v * v * v);
  const x = mod(u * v3 * pow(u * v3 * v3 * v, (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  return vx2 === u || vx2 === mod(-u);
}
/** The program-derived address for these seeds: the first bump from 255 down whose hash is off the curve. */
export function pda(seeds: (Uint8Array | string)[], programId: string): { address: string; bump: number } {
  const prog = base58decode(programId);
  const parts = seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : Buffer.from(s)));
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256").update(Buffer.concat([...parts, Buffer.from([bump]), prog, Buffer.from("ProgramDerivedAddress")])).digest();
    if (!onCurve(h)) return { address: base58(h), bump };
  }
  throw new Error("no program address for these seeds");
}
const key32 = (a: string) => {
  const b = base58decode(a);
  if (b.length !== 32) throw new Error("not a 32-byte address");
  return b;
};
/** The associated token account of an owner (a wallet or a program address) for a mint. */
export const ata = (owner: string, mint: string) => pda([key32(owner), key32(TOKEN_PROGRAM), key32(mint)], ATA_PROGRAM).address;
/** An Anchor instruction's first 8 bytes. */
export const anchorDisc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
export const u64le = (v: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};

export interface Ix {
  program: string;
  keys: { pubkey: string; signer?: boolean; writable?: boolean }[];
  data: Uint8Array;
}
const shortvec = (n: number) => {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if (n) out.push(b | 0x80);
    else return out.concat(b);
  }
};
/**
 * An unsigned legacy transaction (one signature slot, zeroed) with these instructions, paid and signed by `payer`
 * alone. base64, ready for keys.ts signTransaction or for a simulation.
 */
export function buildTx(payer: string, blockhash: string, ixs: Ix[]): string {
  const meta = new Map<string, { signer: boolean; writable: boolean }>();
  const add = (k: string, signer: boolean, writable: boolean) => {
    const m = meta.get(k);
    meta.set(k, { signer: signer || !!m?.signer, writable: writable || !!m?.writable });
  };
  add(payer, true, true);
  for (const ix of ixs) {
    for (const k of ix.keys) {
      if (k.signer && k.pubkey !== payer) throw new Error("only the payer may sign");
      add(k.pubkey, !!k.signer, !!k.writable);
    }
    add(ix.program, false, false);
  }
  const all = [...meta.entries()].filter(([k]) => k !== payer);
  const keys = [payer, ...all.filter(([, m]) => m.writable).map(([k]) => k), ...all.filter(([, m]) => !m.writable).map(([k]) => k)];
  const nReadonly = all.filter(([, m]) => !m.writable).length;
  const body: Buffer[] = [Buffer.from([1, 0, nReadonly]), Buffer.from(shortvec(keys.length)), ...keys.map(key32), key32(blockhash), Buffer.from(shortvec(ixs.length))];
  for (const ix of ixs) body.push(Buffer.from([keys.indexOf(ix.program), ...shortvec(ix.keys.length), ...ix.keys.map((k) => keys.indexOf(k.pubkey)), ...shortvec(ix.data.length)]), Buffer.from(ix.data));
  const tx = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), ...body]);
  if (tx.length > 1232) throw new Error("transaction too large");
  return tx.toString("base64");
}
/** The two compute-budget instructions: a unit limit and a price (micro-lamports a unit). */
export function budget(units: number, microLamports: number): Ix[] {
  const lim = Buffer.alloc(5);
  lim[0] = 2;
  lim.writeUInt32LE(units, 1);
  return [
    { program: COMPUTE_BUDGET, keys: [], data: lim },
    { program: COMPUTE_BUDGET, keys: [], data: Buffer.concat([Buffer.from([3]), u64le(microLamports)]) },
  ];
}
