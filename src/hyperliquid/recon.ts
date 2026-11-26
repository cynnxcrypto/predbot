/**
 * HYPERLIQUID'S OWN BOOKS, PER WALLET (26 Nov 2026, enrique: "im checking the pnl per day and it doesnt look like
 * hyperliquid is doing as good as you're telling me, check that"). The reviews quoted the sum of our closed-copy rows
 * (+$169) while worth less money put in was about +$24. This reads, for each of our wallets since real trading began,
 * what Hyperliquid itself recorded: closed profit and fees from every fill, funding paid or received, and every money
 * movement (deposits, withdrawals, sends between wallets), plus the account value now (perp + spot USDC). The sum
 * shows where the gap went. Sealed with the server's jev key (balances never public); MAIN opens it.
 */
import { HL_API } from "./fund.js";

export const RECON_SINCE = Date.UTC(2026, 10, 17, 0, 0, 0); // 17 Nov 2026 09:00 KST, before the first real copy
const RECON_EVERY = 60 * 60_000;

export type ReconWallet = {
  at: number;
  closedPnl: number;
  fees: number;
  funding: number;
  fills: number;
  fundingRows: number;
  /** money movements by Hyperliquid's own type name: deposit, withdraw, send, accountClassTransfer, ... (signed, + = in) */
  flows: Record<string, number>;
  perpValue: number;
  spotUsdc: number;
  error?: string;
};
export type Recon = { at: number; since: number; wallets: (ReconWallet | null)[] };

const r2 = (x: number) => Math.round(x * 100) / 100;

async function info<T>(body: unknown, fetcher: typeof fetch): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetcher(`${HL_API}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`http ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  throw last;
}

/** Every row of a time-paged Hyperliquid list from `since` on (pages until a short page). */
async function paged<T extends { time: number }>(type: string, user: string, since: number, fetcher: typeof fetch, page: number): Promise<T[]> {
  const out: T[] = [];
  let from = since;
  for (let n = 0; n < 50; n++) {
    const rows = await info<T[]>({ type, user, startTime: from, endTime: Date.now(), ...(type === "userFillsByTime" ? { aggregateByTime: false } : {}) }, fetcher);
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows);
    const last = Math.max(...rows.map((r) => r.time));
    if (rows.length < page || last <= from) break;
    from = last + 1;
  }
  return out;
}

type LedgerRow = { time: number; delta?: { type?: string; usdc?: string; amount?: string; usdcValue?: string; toPerp?: boolean; user?: string; destination?: string; fee?: string; token?: string } };

/** Signed USDC of one ledger row for this wallet (+ = into the wallet). Pure. */
export function ledgerUsd(r: LedgerRow, user: string): { kind: string; usd: number } | null {
  const d = r.delta;
  if (!d?.type) return null;
  const me = user.toLowerCase();
  const num = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  switch (d.type) {
    case "deposit":
      return { kind: "deposit", usd: num(d.usdc) };
    case "withdraw":
      return { kind: "withdraw", usd: -(num(d.usdc) + num(d.fee)) };
    case "accountClassTransfer":
      // perp <-> spot inside one wallet: not money in or out of the wallet
      return { kind: "perpSpot", usd: 0 };
    case "send":
    case "spotTransfer":
    case "internalTransfer": {
      const usd = num(d.usdcValue ?? d.usdc ?? d.amount);
      const out = (d.user ?? "").toLowerCase() === me;
      const into = (d.destination ?? "").toLowerCase() === me;
      if (out === into) return { kind: d.type, usd: 0 };
      return { kind: d.type, usd: out ? -(usd + num(d.fee)) : usd };
    }
    default:
      return { kind: d.type, usd: num(d.usdc ?? d.usdcValue) };
  }
}

export async function reconWallet(user: string, since: number, fetcher: typeof fetch): Promise<ReconWallet> {
  const fills = await paged<{ time: number; closedPnl?: string; fee?: string; builderFee?: string }>("userFillsByTime", user, since, fetcher, 2000);
  const funding = await paged<{ time: number; delta?: { usdc?: string } }>("userFunding", user, since, fetcher, 500);
  const ledger = await paged<LedgerRow>("userNonFundingLedgerUpdates", user, since, fetcher, 500);
  const perp = await info<{ marginSummary?: { accountValue?: string } }>({ type: "clearinghouseState", user }, fetcher);
  const spot = await info<{ balances?: { coin: string; total: string }[] }>({ type: "spotClearinghouseState", user }, fetcher);
  const flows: Record<string, number> = {};
  for (const r of ledger) {
    const x = ledgerUsd(r, user);
    if (x) flows[x.kind] = r2((flows[x.kind] ?? 0) + x.usd);
  }
  return {
    at: Date.now(),
    closedPnl: r2(fills.reduce((s, f) => s + Number(f.closedPnl ?? 0), 0)),
    fees: r2(-fills.reduce((s, f) => s + Number(f.fee ?? 0) + Number(f.builderFee ?? 0), 0)),
    funding: r2(funding.reduce((s, f) => s + Number(f.delta?.usdc ?? 0), 0)),
    fills: fills.length,
    fundingRows: funding.length,
    flows,
    perpValue: r2(Number(perp.marginSummary?.accountValue ?? 0)),
    spotUsdc: r2(Number(spot.balances?.find((b) => b.coin === "USDC")?.total ?? 0)),
  };
}

let last: Recon | null = null;
export const reconNow = () => last;

/** Read every wallet once an hour (first read a minute after start). */
export function startRecon(addrs: () => (string | null)[], fetcher: typeof fetch) {
  const run = async () => {
    const wallets: (ReconWallet | null)[] = [];
    for (const a of addrs()) {
      if (!a) {
        wallets.push(null);
        continue;
      }
      wallets.push(
        await reconWallet(a, RECON_SINCE, fetcher).catch((e) => ({ at: Date.now(), closedPnl: 0, fees: 0, funding: 0, fills: 0, fundingRows: 0, flows: {}, perpValue: 0, spotUsdc: 0, error: String((e as Error)?.message ?? e).replace(/0x[0-9a-fA-F]{40,}/g, "…").slice(0, 100) })),
      );
    }
    last = { at: Date.now(), since: RECON_SINCE, wallets };
  };
  setTimeout(() => void run().catch(() => undefined), 60_000).unref();
  setInterval(() => void run().catch(() => undefined), RECON_EVERY).unref();
}
