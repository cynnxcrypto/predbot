/**
 * The bot's wallet on Base (enrique, 19 Nov 2026: "also build being able to bridge with base"). REAL KEY MATERIAL,
 * kept like the Hyperliquid wallet's: made on the machine that runs the bot the first time a bridge order names Base,
 * in the git-ignored data folder (data/base-wallet.json, mode 600), never logged, never in status, never sent anywhere.
 * A file that exists is never overwritten. Nothing here talks to a network.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "@ethersproject/wallet";
import { DATA } from "../config.js";

const file = () => join(DATA, "base-wallet.json");
let cached: { f: string; w: Wallet } | null = null;

export function baseWallet(): Wallet {
  const f = file();
  if (cached?.f === f) return cached.w;
  if (!existsSync(f)) {
    const made = Wallet.createRandom();
    mkdirSync(DATA, { recursive: true });
    writeFileSync(f, JSON.stringify({ privateKey: made.privateKey, address: made.address }), { mode: 0o600, flag: "wx" }); // wx: never overwrite a wallet
    chmodSync(f, 0o600);
  }
  const raw = JSON.parse(readFileSync(f, "utf8")) as { privateKey?: unknown; address?: unknown };
  if (typeof raw.privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw.privateKey)) throw new Error("base-wallet.json is not a 32-byte key");
  const w = new Wallet(raw.privateKey);
  if (typeof raw.address !== "string" || raw.address.toLowerCase() !== w.address.toLowerCase()) throw new Error("base-wallet.json: key and address do not match");
  cached = { f, w };
  return w;
}
export const _forgetBase = () => void (cached = null);
