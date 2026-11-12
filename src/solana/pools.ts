/** Pools the paper bot watches. Addresses are public pool accounts (not wallets). Each is checked against its mints at run time. */
export const SOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
export const MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
export const JUPSOL = "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v";
export const CBBTC = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
export const WBTC = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";

export interface PoolDef {
  key: string;
  label: string;
  address: string;
  mintA: string;
  mintB: string;
  decA: number;
  decB: number;
  /** the wider test only: which pair it belongs to, which rule set it gets, and what a re-centring swap costs */
  pair?: string;
  kind?: "volatile" | "pegged";
  swapCost?: number;
}

export const POOLS: PoolDef[] = [
  { key: "orca-sol-usdc-4", label: "Orca SOL/USDC 0.04%", address: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE", mintA: SOL, mintB: USDC, decA: 9, decB: 6 },
  { key: "orca-sol-usdc-30", label: "Orca SOL/USDC 0.30%", address: "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ", mintA: SOL, mintB: USDC, decA: 9, decB: 6 },
];

/**
 * The wider fee test (12 Nov 2026): more pairs, so the evidence does not rest on SOL/USDC alone. No address is
 * written here: an Orca pool's address follows from its two tokens and its tick spacing (src/solana/pda.ts), the
 * chain is asked which of them exist, and the PER_PAIR deepest of each pair are followed (src/solana/lpwide.ts).
 *   volatile: the two tokens move against each other; same nine range rules as SOL/USDC.
 *   pegged:   staked SOL against SOL, which drifts by the staking yield only; much narrower ranges.
 * swapCost is what the half that must be swapped at a re-centring is assumed to cost (pool fee on the cheapest route
 * plus price impact), on the safe side. It is an assumption, like SWAP_COST for SOL/USDC.
 */
export interface PairDef {
  key: string;
  label: string;
  mints: [string, string];
  kind: "volatile" | "pegged";
  swapCost: number;
}

export const PAIRS: PairDef[] = [
  { key: "sol-usdt", label: "SOL/USDT", mints: [SOL, USDT], kind: "volatile", swapCost: 0.0008 },
  { key: "jitosol-sol", label: "jitoSOL/SOL", mints: [SOL, JITOSOL], kind: "pegged", swapCost: 0.0003 },
  { key: "msol-sol", label: "mSOL/SOL", mints: [SOL, MSOL], kind: "pegged", swapCost: 0.0003 },
  { key: "jupsol-sol", label: "JupSOL/SOL", mints: [SOL, JUPSOL], kind: "pegged", swapCost: 0.0003 },
  { key: "cbbtc-sol", label: "cbBTC/SOL", mints: [SOL, CBBTC], kind: "volatile", swapCost: 0.001 },
  { key: "wbtc-sol", label: "WBTC/SOL", mints: [SOL, WBTC], kind: "volatile", swapCost: 0.001 },
];
export const TICK_SPACINGS = [1, 2, 4, 8, 16, 64, 96, 128, 256];
export const PER_PAIR = 2;
