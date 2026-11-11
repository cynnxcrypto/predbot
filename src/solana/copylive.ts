/**
 * REAL MONEY (small, capped): the landing-speed test for wallet copying. enrique, 11 Nov 2026 16:21 KST: "go 0.5".
 *
 * Step 1 (this file today): make sure the test wallet exists on this machine, so it can be funded. Nothing here
 * trades yet. The wallet's secret never leaves data/solana-wallet.json; the address is only written to
 * data/solana-wallet-address.txt and is never put in status, logs or the repo.
 *
 * SOLANA_LIVE=off disables even the wallet creation.
 */
import { wallet } from "./keys.js";

const state = { walletReady: false, error: "" };

export function startSolanaCopyLive() {
  if (process.env.SOLANA_LIVE === "off") return null;
  try {
    wallet();
    state.walletReady = true;
  } catch (e) {
    state.error = String((e as Error).message).slice(0, 120);
  }
  return null;
}

/** For status: no address, no key, just whether the wallet is there. */
export function solanaCopyLiveSummary() {
  return { mode: "real test, not trading yet", walletReady: state.walletReady, error: state.error };
}
