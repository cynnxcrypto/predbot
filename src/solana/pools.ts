/** Pools the paper bot watches. Addresses are public pool accounts (not wallets). Each is checked against its mints at run time. */
export const SOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface PoolDef {
  key: string;
  label: string;
  address: string;
  mintA: string;
  mintB: string;
  decA: number;
  decB: number;
}

export const POOLS: PoolDef[] = [
  { key: "orca-sol-usdc-4", label: "Orca SOL/USDC 0.04%", address: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE", mintA: SOL, mintB: USDC, decA: 9, decB: 6 },
  { key: "orca-sol-usdc-30", label: "Orca SOL/USDC 0.30%", address: "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ", mintA: SOL, mintB: USDC, decA: 9, decB: 6 },
];
