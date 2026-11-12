/**
 * PAPER ONLY: which extra pools the fee test follows (the wider test, 12 Nov 2026). Read only, no keys, nothing sent.
 *
 * For each pair in PAIRS the address of the Orca pool at every tick spacing is worked out locally (pda.ts), the chain
 * is asked once which of them exist, and the PER_PAIR pools with the most active liquidity are kept. A pool whose
 * price is more than 1% off the deepest pool of its pair is left out (a forgotten pool with a stale price). Token
 * decimals are read from the mint accounts, not typed in. The answer is written to data/solana-lp-pools.json and not
 * asked again, so a restart never swaps one pool for another in the middle of a test.
 */
import { ORCA_PROGRAM, ordered, whirlpoolAddress } from "./pda.js";
import { PAIRS, PER_PAIR, SOL, TICK_SPACINGS, USDC, USDT, type PairDef, type PoolDef } from "./pools.js";
import { decodeWhirlpool, price, type PoolSnap } from "./whirlpool.js";

export const WIDE_VERSION = "wide-v1";
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

export interface Account {
  data: Buffer;
  owner: string;
}
export type Reader = (addresses: string[]) => Promise<(Account | null)[]>;

export interface Candidate {
  pair: PairDef;
  tickSpacing: number;
  address: string;
}

let memo: Candidate[] | null = null;
/** Every pool address that could exist for the pairs. Worked out once: the arithmetic takes a few tenths of a second. */
export function candidates(pairs: PairDef[] = PAIRS): Candidate[] {
  if (pairs === PAIRS && memo) return memo;
  const out = pairs.flatMap((pair) => TICK_SPACINGS.map((tickSpacing) => ({ pair, tickSpacing, address: whirlpoolAddress(pair.mints[0], pair.mints[1], tickSpacing) })));
  if (pairs === PAIRS) memo = out;
  return out;
}

/** Decimals of a token from its mint account (SPL token layout: decimals at byte 44, initialised flag at 45). */
export function mintDecimals(acc: Account | null): number | null {
  if (!acc || !TOKEN_PROGRAMS.includes(acc.owner) || acc.data.length < 82 || acc.data[45] !== 1) return null;
  const d = acc.data[44];
  return d <= 18 ? d : null;
}

export interface Found {
  version: string;
  at: number;
  pools: PoolDef[];
  /** pairs for which the chain has no usable pool */
  none: string[];
}

/** One look at the chain. Throws when the read fails, so nothing half-found is ever saved. */
export async function discover(read: Reader, pairs: PairDef[] = PAIRS, now = Date.now()): Promise<Found> {
  const cands = candidates(pairs);
  const mints = [...new Set(pairs.flatMap((p) => p.mints))];
  const addresses = [...cands.map((c) => c.address), ...mints];
  const accs: (Account | null)[] = [];
  for (let i = 0; i < addresses.length; i += 100) accs.push(...(await read(addresses.slice(i, i + 100))));
  if (accs.length !== addresses.length) throw new Error("accounts missing from the answer");
  const dec = new Map(mints.map((m, i) => [m, mintDecimals(accs[cands.length + i])]));
  const pools: PoolDef[] = [];
  const none: string[] = [];
  for (const pair of pairs) {
    const [mintA, mintB] = ordered(pair.mints[0], pair.mints[1]);
    const decA = dec.get(mintA);
    const decB = dec.get(mintB);
    const live: { c: Candidate; snap: PoolSnap }[] = [];
    if (decA != null && decB != null) {
      cands.forEach((c, i) => {
        const acc = accs[i];
        if (c.pair !== pair || !acc || acc.owner !== ORCA_PROGRAM) return;
        let snap: PoolSnap;
        try {
          snap = decodeWhirlpool(acc.data, now);
        } catch {
          return;
        }
        if (snap.mintA !== mintA || snap.mintB !== mintB || snap.tickSpacing !== c.tickSpacing || snap.liquidity <= 0n) return;
        live.push({ c, snap });
      });
    }
    live.sort((x, y) => (y.snap.liquidity > x.snap.liquidity ? 1 : y.snap.liquidity < x.snap.liquidity ? -1 : 0));
    const ref = live.length ? price(live[0].snap, decA!, decB!) : 0;
    const kept = live.filter((x) => Math.abs(price(x.snap, decA!, decB!) / ref - 1) <= 0.01).slice(0, PER_PAIR);
    if (!kept.length) none.push(pair.key);
    for (const { c, snap } of kept) {
      pools.push({
        key: `orca-${pair.key}-ts${c.tickSpacing}`, label: `Orca ${pair.label} ${+(snap.feeRate * 100).toFixed(3)}%`, address: c.address,
        mintA, mintB, decA: decA!, decB: decB!, pair: pair.key, kind: pair.kind, swapCost: pair.swapCost,
      });
    }
  }
  return { version: WIDE_VERSION, at: now, pools, none };
}

/** A saved answer is used only if it is this version and every pool in it is one this code could have found. */
export function validFound(x: unknown, pairs: PairDef[] = PAIRS): Found | null {
  const f = x as Found | null;
  if (!f || f.version !== WIDE_VERSION || !Array.isArray(f.pools) || !Array.isArray(f.none)) return null;
  const known = new Map(candidates(pairs).map((c) => [c.address, c]));
  for (const p of f.pools) {
    const c = known.get(p?.address);
    if (!c || p.pair !== c.pair.key || p.key !== `orca-${c.pair.key}-ts${c.tickSpacing}` || !Number.isInteger(p.decA) || !Number.isInteger(p.decB)) return null;
  }
  return f;
}

/**
 * Dollar price of a pool's second token, from the pool's own price p (first token in second) and the SOL price.
 * Null when it cannot be told (neither a dollar nor a pair with SOL): such a pool is not followed.
 */
export function usdOfB(pool: PoolDef, p: number, solUsd: number): number | null {
  if (pool.mintB === USDC || pool.mintB === USDT) return 1;
  if (!(solUsd > 0) || !(p > 0)) return null;
  if (pool.mintA === SOL) return solUsd / p;
  if (pool.mintB === SOL) return solUsd;
  return null;
}
