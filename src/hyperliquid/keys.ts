/**
 * The Hyperliquid wallet (enrique, 17 Nov 2026: "new tab for hyperliquid", "lets not mix it", "and it is it's own
 * wallet", "how about i send eth to the arbitrum wallet", "and u manage the swap too").
 *
 * REAL KEY MATERIAL. Two keys, both made on the machine that runs the bot, both in the git-ignored data folder,
 * file mode 600, never logged, never in status, never sent anywhere:
 *
 *   data/hyperliquid-wallet.json   the wallet itself. It holds the money: ETH and USDC on Arbitrum, and the
 *                                  Hyperliquid account under the same address. Only the money-moving steps read it
 *                                  (the ETH -> USDC swap, the deposit, naming the trading key below).
 *   data/hyperliquid-agent.json    the trading key (Hyperliquid calls it an API wallet or agent). It can place and
 *                                  cancel orders for the account and nothing else: it cannot withdraw or transfer.
 *                                  The trading loop reads only this one.
 *
 * Only the wallet's public address is written beside it (data/hyperliquid-wallet-address.txt) so it can be read on
 * the server and given to enrique privately. The address must not go into the public repo or the public status.
 *
 * Nothing here talks to a network.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "@ethersproject/wallet";
import { DATA } from "../config.js";

/**
 * A SECOND wallet with its own trading key (enrique, 19 Nov 2026: "potentially we could have more than 1 hl wallet so
 * we can properly replicate other traders", then his tap "2nd wallet for every overlap"): Hyperliquid keeps one
 * position, one leverage and one liquidation price per coin per account, so a second trader's copy on a coin the
 * first wallet already holds goes there. Same rules for its files; its address is written nowhere else.
 */
export type HlKeyName = "wallet" | "agent" | "wallet-2" | "agent-2" | "wallet-3" | "agent-3";
const file = (name: HlKeyName) => join(DATA, `hyperliquid-${name}.json`);
export const addressFile = () => join(DATA, "hyperliquid-wallet-address.txt");

const cache = new Map<string, Wallet>();

/** Read a key file, or make it on first call if this machine has none yet. A file that exists is never overwritten. */
function keyAt(name: HlKeyName): Wallet {
  const f = file(name);
  const hit = cache.get(f);
  if (hit) return hit;
  if (!existsSync(f)) {
    const made = Wallet.createRandom();
    mkdirSync(DATA, { recursive: true });
    writeFileSync(f, JSON.stringify({ privateKey: made.privateKey, address: made.address }), { mode: 0o600, flag: "wx" }); // wx: never overwrite a wallet
    chmodSync(f, 0o600);
  }
  const raw = JSON.parse(readFileSync(f, "utf8")) as { privateKey?: unknown; address?: unknown };
  if (typeof raw.privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw.privateKey)) throw new Error(`hyperliquid-${name}.json is not a 32-byte key`);
  const w = new Wallet(raw.privateKey);
  // a key that does not belong to the address saved with it must never be used
  if (typeof raw.address !== "string" || raw.address.toLowerCase() !== w.address.toLowerCase()) throw new Error(`hyperliquid-${name}.json: key and address do not match`);
  if (name === "wallet" && (!existsSync(addressFile()) || readFileSync(addressFile(), "utf8").trim() !== w.address)) writeFileSync(addressFile(), w.address + "\n", { mode: 0o600 });
  cache.set(f, w);
  return w;
}

/** The wallet that holds the money. Only the swap, the deposit and the naming of the trading key may call this. */
export const hlWallet = (): Wallet => keyAt("wallet");
/** The trading key: orders and cancels only, it cannot move money out. */
export const hlAgent = (): Wallet => keyAt("agent");
/** True when this machine already has the wallet (asking does not make one). */
export const hlWalletExists = (): boolean => existsSync(file("wallet"));
/** The second wallet and its trading key (made on first call, like the first). */
export const hlWallet2 = (): Wallet => keyAt("wallet-2");
export const hlAgent2 = (): Wallet => keyAt("agent-2");
export const hlWallet2Exists = (): boolean => existsSync(file("wallet-2"));
/** The third wallet and its trading key (26 Nov 2026; made on first call, like the others). */
export const hlWallet3 = (): Wallet => keyAt("wallet-3");
export const hlAgent3 = (): Wallet => keyAt("agent-3");

/** Test hook: forget the cached keys (tests point DATA_DIR at a scratch folder). */
export const _forget = () => cache.clear();
