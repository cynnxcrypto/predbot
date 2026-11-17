/**
 * One-off commands for the Hyperliquid wallet, run by hand on the server:
 *
 *   npm run hyperliquid -- wallet     make the wallet and the trading key if this machine has none, then print the
 *                                     deposit address (and only that: never a key). Safe to run again: it never
 *                                     replaces a wallet, it prints the same address.
 *
 * The address is printed to the terminal for MAIN to pass to enrique privately. It must not be pasted into the
 * repo, the public status or a log that is pushed.
 */
import { addressFile, hlAgent, hlWallet, hlWalletExists } from "./keys.js";

const cmd = process.argv[2];
if (cmd === "wallet") {
  const had = hlWalletExists();
  const w = hlWallet();
  hlAgent();
  console.log(had ? "Hyperliquid wallet: already here, unchanged." : "Hyperliquid wallet: made.");
  console.log(`Deposit address (Arbitrum One, ETH): ${w.address}`);
  console.log(`Also saved in ${addressFile()} (server only).`);
} else {
  console.log("usage: npm run hyperliquid -- wallet");
  process.exitCode = 1;
}
