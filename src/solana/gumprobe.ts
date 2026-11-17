/**
 * READ-ONLY look at Jupiter Perps' order-book markets (Gum, see gum.ts), 17 Nov 2026. Run on the server, once:
 *
 *   npx tsx src/solana/gumprobe.ts            markets, their minimums and limits; our perps wallet's accounts there
 *   npx tsx src/solana/gumprobe.ts --deposit  also BUILDS (never signs, never sends) a 1 USDC deposit, to see where
 *                                              the money would come from (our Solana USDC, or only a bridge)
 *   ... --create-account                       if the wallet has no account there, makes one (cross margin, empty;
 *                                              the API pays its fee): a deposit can only be built for an account
 *
 * Nothing else is signed or sent. The perps wallet's address is used only as the X-PUBKEY header the API asks for, and is
 * never printed or written. The result goes to data/gum-probe.json and to the screen.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../config.js";
import { gum, gumMarkets, type GumMarket } from "./gum.js";
import { namedWallet } from "./keys.js";
import { base58 } from "./whirlpool.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const r = (x: number | undefined, d = 2) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

function market(m: GumMarket) {
  const mk = m.orderLimitConfig?.market;
  const spreadBps = m.bestBid && m.bestAsk ? r(((m.bestAsk - m.bestBid) / ((m.bestAsk + m.bestBid) / 2)) * 1e4, 1) : null;
  return {
    symbol: m.symbol,
    price: r(m.markPrice ?? m.indexPrice, 6),
    maxLeverage: m.maxLeverage ?? null,
    minOrderUsd: r(mk?.minOrderNotional),
    minOrderQty: mk?.minOrderQty ?? null,
    maxOpenOrderUsd: r(mk?.maxOpenOrderNotional),
    maxPositionUsd: r(m.maxAccountPositionNotional),
    takerFeeBps: m.takerFeeBps ?? null,
    makerFeeBps: m.makerFeeBps ?? null,
    spreadBps,
    openInterestUsd: r(m.openInterest, 0),
    maxOpenInterestUsd: r(m.maxMarketOpenInterest, 0),
    volume24hUsd: r((m.volume24h ?? 0) * (m.markPrice ?? m.indexPrice ?? 0), 0),
  };
}

async function main() {
  const out: Record<string, unknown> = { at: new Date().toISOString(), api: "api.gum.ag/perps" };
  out.health = await gum<unknown>("/health").catch((e) => `error: ${String((e as Error).message)}`);
  const ms = await gumMarkets();
  out.markets = ms.map(market);
  const w = namedWallet("perps");
  // our accounts there (none until one is made: making one is a write, so it is not done here)
  const accts = await gum<{ accounts?: { pubkey?: string; tradingAccount?: string; subaccountId?: number; isolated?: boolean; data?: Record<string, unknown> }[] }>("/tradingAccount", { pubkey: w.address }).catch(
    (e) => ({ error: String((e as Error).message) }) as never,
  );
  if (process.argv.includes("--create-account") && !(accts as { accounts?: unknown[] }).accounts?.length) {
    out.created = await gum<{ subaccountId?: number }>("/tradingAccount", { method: "POST", pubkey: w.address })
      .then((x) => ({ subaccountId: x?.subaccountId }))
      .catch((e) => `error: ${String((e as Error).message)}`);
    Object.assign(accts, await gum<object>("/tradingAccount", { pubkey: w.address }).catch(() => ({})));
  }
  out.ourAccounts = Array.isArray((accts as { accounts?: unknown[] }).accounts)
    ? (accts as { accounts: { subaccountId?: number; isolated?: boolean; data?: Record<string, unknown> }[] }).accounts.map((a) => ({ subaccountId: a.subaccountId, isolated: a.isolated, data: a.data }))
    : accts;
  if (process.argv.includes("--deposit")) {
    const first = (accts as { accounts?: { pubkey?: string; tradingAccount?: string }[] }).accounts?.[0];
    const ta = first?.tradingAccount ?? first?.pubkey;
    if (!ta) out.deposit = "no trading account yet: a deposit cannot be built before one exists";
    else {
      try {
        const b = await gum<{ serializedTransaction: string }>(`/deposit?amount=1000000&trading_account=${ta}`, { pubkey: w.address });
        const tx = Buffer.from(b.serializedTransaction, "base64");
        // signatures, then the message: what accounts it names, said without any address of ours
        const nSig = tx[0];
        const msg = tx.subarray(1 + 64 * nSig);
        const off = msg[0] & 0x80 ? 1 : 0;
        const nKeys = msg[off + 3];
        const keys = Array.from({ length: nKeys }, (_, i) => base58(msg.subarray(off + 4 + 32 * i, off + 4 + 32 * (i + 1))));
        out.deposit = { signatures: nSig, accounts: nKeys, namesOurWallet: keys.includes(w.address), namesSolanaUsdcMint: keys.includes(USDC), programs: keys.filter((k) => k !== w.address && k !== ta).slice(-4) };
      } catch (e) {
        out.deposit = `error: ${String((e as Error).message)}`;
      }
    }
  }
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, "gum-probe.json"), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}
main().catch((e) => {
  console.error("gum probe failed:", String((e as Error)?.message ?? e));
  process.exit(1);
});
