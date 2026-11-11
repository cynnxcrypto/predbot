/**
 * The Solana test wallet. REAL KEY MATERIAL: the secret is created on the machine that runs the bot and stays in
 * data/solana-wallet.json (data/ is git-ignored, file mode 600). It is never logged, never put in status, never
 * sent anywhere. Only the public address is written next to it (data/solana-wallet-address.txt) so it can be read
 * on the server and given to enrique privately. The address must not go into the public repo or public status.
 *
 * No dependencies: Node's own ed25519.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../config.js";
import { base58 } from "./whirlpool.js";

const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const FILE = () => join(DATA, "solana-wallet.json");
const ADDR = () => join(DATA, "solana-wallet-address.txt");
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Buffer.from(out);
}

export interface Wallet {
  address: string;
  pubkey: Buffer;
  sign(message: Uint8Array): Buffer;
}

function fromSeed(seed: Buffer, pubkey: Buffer): Wallet {
  const key: KeyObject = createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" });
  return { address: base58(pubkey), pubkey, sign: (m) => edSign(null, m, key) };
}

let cached: Wallet | null = null;

/** The wallet, created on first call if this machine has none yet. Same file format as solana-keygen (64 numbers). */
export function wallet(): Wallet {
  if (cached) return cached;
  if (!existsSync(FILE())) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
    const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    mkdirSync(DATA, { recursive: true });
    writeFileSync(FILE(), JSON.stringify([...seed, ...pub]), { mode: 0o600, flag: "wx" }); // wx: never overwrite a wallet
    chmodSync(FILE(), 0o600);
  }
  const raw = JSON.parse(readFileSync(FILE(), "utf8")) as number[];
  if (!Array.isArray(raw) || raw.length !== 64) throw new Error("solana-wallet.json is not a 64-byte key");
  const w = fromSeed(Buffer.from(raw.slice(0, 32)), Buffer.from(raw.slice(32)));
  // a key whose two halves do not belong together must never be used
  const probe = Buffer.from("predbot wallet self-check");
  const pubObj = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), w.pubkey]), format: "der", type: "spki" });
  if (!verify(null, probe, pubObj, w.sign(probe))) throw new Error("solana-wallet.json: secret and public halves do not match");
  if (!existsSync(ADDR()) || readFileSync(ADDR(), "utf8").trim() !== w.address) writeFileSync(ADDR(), w.address + "\n", { mode: 0o600 });
  return (cached = w);
}

/** Test hook: forget the cached wallet (tests point DATA_DIR at a scratch folder). */
export const _forget = () => (cached = null);

/**
 * Sign a transaction that an API built for us (base64, one signature slot) and return it as base64.
 * Refuses anything that is not exactly "one signer, and that signer is our wallet".
 */
export function signTransaction(b64: string, w: Wallet = wallet()): string {
  const tx = Buffer.from(b64, "base64");
  if (tx[0] !== 1) throw new Error(`transaction wants ${tx[0]} signatures, expected 1`);
  const msg = tx.subarray(65);
  const off = msg[0] & 0x80 ? 1 : 0; // versioned messages start with a version byte
  if (msg[off] !== 1) throw new Error("transaction needs more than one signer");
  const nKeys = msg[off + 3];
  const first = msg.subarray(off + 3 + (nKeys & 0x80 ? 2 : 1), off + 3 + (nKeys & 0x80 ? 2 : 1) + 32);
  if (!first.equals(w.pubkey)) throw new Error("transaction's signer is not our wallet");
  w.sign(msg).copy(tx, 1);
  return tx.toString("base64");
}

/** A minimal legacy transaction with one instruction, signed. Used to close an emptied token account (get the rent back). */
export function buildSigned(w: Wallet, blockhash: string, programId: string, accounts: { pubkey: string; writable: boolean }[], data: number[]): string {
  // account order: our wallet (signer, writable), writable others, read-only others, program (read-only)
  const writable = accounts.filter((a) => a.writable && a.pubkey !== w.address).map((a) => a.pubkey);
  const readonly = accounts.filter((a) => !a.writable && a.pubkey !== w.address).map((a) => a.pubkey);
  const keys = [...new Set([w.address, ...writable, ...readonly, programId])];
  const nReadonly = keys.length - 1 - new Set(writable).size;
  const ix = [keys.indexOf(programId), accounts.length, ...accounts.map((a) => keys.indexOf(a.pubkey)), data.length, ...data];
  const msg = Buffer.concat([Buffer.from([1, 0, nReadonly, keys.length]), ...keys.map(base58decode), base58decode(blockhash), Buffer.from([1, ...ix])]);
  return Buffer.concat([Buffer.from([1]), w.sign(msg), msg]).toString("base64");
}
