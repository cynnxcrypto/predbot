/**
 * Program derived addresses, worked out locally: no network, no keys, nothing signed. Used to find the PUBLIC
 * addresses of pool accounts (an Orca pool's address follows from its two tokens and its tick spacing), so the paper
 * tests never depend on an address copied by hand. Read only.
 */
import { createHash } from "node:crypto";
import { base58 } from "./whirlpool.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const P = (1n << 255n) - 19n;

/** A 32 byte public address from its base58 text. Throws on anything else. */
export function pubkeyBytes(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const out = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 255n);
    n >>= 8n;
  }
  if (n > 0n) throw new Error("longer than 32 bytes");
  return out;
}

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

/** True when the 32 bytes are a point on the ed25519 curve (a derived address must NOT be one). */
export function onCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= P) return false;
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  // x = u v^3 (u v^7)^((p-5)/8); a point exists when v x^2 is u or -u
  const x = mod(u * pow(v, 3n) * pow(u * pow(v, 7n), (P - 5n) / 8n));
  const vxx = mod(v * x * x);
  return vxx === u || vxx === mod(-u);
}

/** The address a program derives from the seeds (the first bump from 255 down that is off the curve). */
export function findProgramAddress(seeds: Uint8Array[], programId: string): string {
  const program = pubkeyBytes(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    const out = h.update(Uint8Array.of(bump)).update(program).update("ProgramDerivedAddress").digest();
    if (!onCurve(out)) return base58(out);
  }
  throw new Error("no address");
}

export const ORCA_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
export const ORCA_CONFIG = "2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ";

/** The two mints in the order the pool stores them (A is the smaller address). */
export function ordered(m1: string, m2: string): [string, string] {
  return Buffer.compare(pubkeyBytes(m1), pubkeyBytes(m2)) <= 0 ? [m1, m2] : [m2, m1];
}

/** Address of the Orca pool for two tokens at one tick spacing. The pool may not exist: the chain is asked. */
export function whirlpoolAddress(m1: string, m2: string, tickSpacing: number): string {
  const [a, b] = ordered(m1, m2);
  const ts = Buffer.alloc(2);
  ts.writeUInt16LE(tickSpacing);
  return findProgramAddress([Buffer.from("whirlpool"), pubkeyBytes(ORCA_CONFIG), pubkeyBytes(a), pubkeyBytes(b), ts], ORCA_PROGRAM);
}
