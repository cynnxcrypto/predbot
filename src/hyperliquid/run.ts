/**
 * One-off commands for the Hyperliquid wallet, run by hand on the server:
 *
 *   npm run hyperliquid -- wallet     make the wallet and the trading key if this machine has none, then print the
 *                                     deposit address (and only that: never a key). Safe to run again: it never
 *                                     replaces a wallet, it prints the same address.
 *   npm run hyperliquid -- fund       DRY RUN of the funding (src/hyperliquid/fund.ts): checks the chain and the
 *                                     contracts, reads the wallet, and says what it would swap and deposit.
 *                                     Signs nothing.
 *   npm run hyperliquid -- fund --go  the same, for real: swap ETH to USDC (keeping gas), a small test deposit to
 *                                     Hyperliquid, wait until it shows there, then the rest. Safe to run again.
 *
 * The address is printed to the terminal for MAIN to pass to enrique privately. It must not be pasted into the
 * repo, the public status or a log that is pushed.
 */
import { fund, realChain } from "./fund.js";
import { addressFile, hlAgent, hlWallet, hlWalletExists } from "./keys.js";

const cmd = process.argv[2];
if (cmd === "wallet") {
  const had = hlWalletExists();
  const w = hlWallet();
  hlAgent();
  console.log(had ? "Hyperliquid wallet: already here, unchanged." : "Hyperliquid wallet: made.");
  console.log(`Deposit address (Arbitrum One, ETH): ${w.address}`);
  console.log(`Also saved in ${addressFile()} (server only).`);
} else if (cmd === "fund") {
  if (!hlWalletExists()) throw new Error("no wallet yet: run `npm run hyperliquid -- wallet` first");
  const go = process.argv.includes("--go");
  const r = await fund(realChain(hlWallet().address), { go });
  console.log(go ? "FUNDING (real)" : "FUNDING DRY RUN (nothing signed)");
  for (const p of r.problems) console.log(`  STOPPED: ${p}`);
  for (const s of r.steps) console.log(`  - ${s}`);
  console.log(`  wallet: ${r.eth} ETH, ${r.usdc} USDC on Arbitrum; Hyperliquid account: ${r.hlUsd === null ? "not reachable" : r.hlUsd + " USD"}${r.done ? "; all moved" : ""}`);
  if (r.problems.length) process.exitCode = 2;
} else {
  console.log("usage: npm run hyperliquid -- wallet | fund [--go]");
  process.exitCode = 1;
}
