/**
 * Is this error the price service or the chain saying no to a SALE (as against a request that did not get through)?
 * Shared by the Solana sides that must tell a coin that cannot be sold from a bad moment on the line (slowlive.ts,
 * bucketslive.ts). Jupiter answers a coin it cannot sell with a 4xx and its own code (no route, not tradable).
 * Everything else is the service or the line and not the coin: 429 (asked too fast), 401/403 (the key), 408, 5xx, a
 * time-out, the RPC.
 */
export const saleRefused = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  return m === "no sell quote" || m === "sale failed on the chain" || /^jupiter \S+ http 4(?!29|01|03|08)\d\d\b/.test(m);
};
