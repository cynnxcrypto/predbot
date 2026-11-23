/**
 * ON-CHAIN TRANSACTIONS, EVER AND TODAY, ALL WALLETS TOGETHER (23 Nov 2026, enrique: "a tally of how many transactions
 * we've done ever and today across all wallets together ... basically like how many onchain tx").
 *
 * Every wallet is read from its own chain and counted once per transaction hash:
 *  - Solana spot copy, spot rules, perps: every signature the wallet is in (getSignaturesForAddress).
 *  - Polymarket: every on-chain activity of the wallet (trades, claims, splits, merges) from Polymarket's data API.
 *  - Hyperliquid (both wallets): every fill and every deposit, transfer or withdrawal on Hyperliquid's own chain.
 *  - Arbitrum (Hyperliquid funding wallet) and Base: the wallet's nonce, which is exactly the transactions it sent.
 * Each source keeps a count per Korean day and a cursor, so a refresh reads only what is new. A nonce has no time on its
 * own: today is the nonce now minus the first reading of the day (part = that reading came after 00:00 KST).
 * Counts only, never an address, in what is published.
 */
export type TxDay = Record<string, number>;
export type TxSrc = { days: TxDay; cursor?: string | number | null; seen?: string[]; nonce?: number | null; base?: { day: string; n: number; at: number } | null; partDay?: string; at?: number; err?: string | null };
export type TxState = Record<string, TxSrc>;
export type TxDeps = {
  fetch: typeof fetch;
  now: () => number;
  solRpc: () => string;
  wallets: () => { solana: { key: string; label: string; address: string }[]; polymarket: string; hl: { key: string; address: string }[]; evm: { key: string; label: string; chain: string; rpc: string; address: string }[] };
  load: () => TxState;
  save: (s: TxState) => void;
};

export const kday = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
const add = (d: TxDay, ms: number, n = 1) => {
  const k = kday(ms);
  d[k] = (d[k] ?? 0) + n;
};

async function post(deps: TxDeps, url: string, body: unknown): Promise<unknown> {
  const r = await deps.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json();
}
async function get(deps: TxDeps, url: string): Promise<unknown> {
  const r = await deps.fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json();
}

/** Solana: the signatures newer than the cursor, newest first, 1000 a page. */
export async function solanaNew(deps: TxDeps, address: string, s: TxSrc): Promise<void> {
  const until = typeof s.cursor === "string" ? s.cursor : undefined;
  let before: string | undefined;
  let newest: string | null = null;
  for (let page = 0; page < 200; page++) {
    const j = (await post(deps, deps.solRpc(), { jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [address, { limit: 1000, ...(until ? { until } : {}), ...(before ? { before } : {}) }] })) as { result?: { signature: string; blockTime?: number | null }[]; error?: unknown };
    if (j.error || !Array.isArray(j.result)) throw new Error("solana: signatures not read");
    const R = j.result;
    if (!R.length) break;
    if (!newest) newest = R[0].signature;
    for (const x of R) add(s.days, (x.blockTime ?? deps.now() / 1000) * 1000);
    if (R.length < 1000) break;
    before = R[R.length - 1].signature;
  }
  if (newest) s.cursor = newest;
}

/** Polymarket: the wallet's on-chain activity (trades, claims, splits, merges), newest first in cursor pages (the v2
 * endpoint; the old one answers 410 since 23 Nov 2026), down to what was read before; one count per transaction. */
export async function polymarketNew(deps: TxDeps, address: string, s: TxSrc): Promise<void> {
  const since = typeof s.cursor === "number" ? s.cursor : 0; // seconds of the newest row read before
  const seen = new Set(s.seen ?? []);
  let newest = since;
  let cursor = "";
  const ms = (t: unknown) => (Number(t) > 1e12 ? Number(t) : Number(t) * 1000);
  pages: for (let page = 0; page < 400; page++) {
    const j = (await get(deps, `https://data-api.polymarket.com/v2/activity?user=${address}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)) as { data?: Record<string, unknown>[]; pagination?: { next_cursor?: string | null } } | Record<string, unknown>[];
    const R = Array.isArray(j) ? j : (j?.data ?? []);
    if (!Array.isArray(R)) throw new Error("polymarket: activity not read");
    for (const x of R) {
      const t = ms(x?.timestamp);
      if (!isFinite(t)) continue;
      if (t / 1000 < since) break pages; // older than what was read before: done
      const h = String(x.transactionHash ?? x.transaction_hash ?? x.txHash ?? x.tx_hash ?? `${x.type}|${t}|${x.asset ?? x.conditionId ?? ""}|${x.size ?? ""}`);
      if (seen.has(h)) continue;
      seen.add(h);
      add(s.days, t);
      if (t / 1000 > newest) newest = Math.floor(t / 1000);
    }
    const next = Array.isArray(j) ? "" : (j?.pagination?.next_cursor ?? "");
    if (!R.length || !next || next === cursor) break;
    cursor = next;
  }
  s.cursor = newest;
  s.seen = [...seen].slice(-2000);
}

/** Hyperliquid: fills and ledger moves (deposits, transfers, withdrawals) from the cursor (ms) on, one per hash. */
export async function hyperliquidNew(deps: TxDeps, address: string, s: TxSrc): Promise<void> {
  const from = typeof s.cursor === "number" ? s.cursor : 0;
  const seen = new Set(s.seen ?? []);
  let last = from;
  const take = (hash: string | undefined, t: number | undefined) => {
    if (!hash || t == null || seen.has(hash) || /^0x0+$/.test(hash)) return;
    seen.add(hash);
    add(s.days, t);
    if (t > last) last = t;
  };
  for (let start = from, page = 0; page < 100; page++) {
    const R = (await post(deps, "https://api.hyperliquid.xyz/info", { type: "userFillsByTime", user: address, startTime: start, aggregateByTime: false })) as { hash?: string; time?: number }[];
    if (!Array.isArray(R)) throw new Error("hyperliquid: fills not read");
    R.forEach((x) => take(x?.hash, x?.time));
    if (R.length < 2000) break;
    start = Math.max(...R.map((x) => x.time ?? 0));
  }
  const L = (await post(deps, "https://api.hyperliquid.xyz/info", { type: "userNonFundingLedgerUpdates", user: address, startTime: from })) as { hash?: string; time?: number }[];
  if (Array.isArray(L)) L.forEach((x) => take(x?.hash, x?.time));
  s.cursor = last;
  s.seen = [...seen].slice(-500);
}

/** An EVM wallet: its nonce is the count of transactions it sent; today = the nonce now minus the day's first reading. */
export async function evmNonce(deps: TxDeps, rpc: string, address: string, s: TxSrc): Promise<void> {
  const j = (await post(deps, rpc, { jsonrpc: "2.0", id: 1, method: "eth_getTransactionCount", params: [address, "latest"] })) as { result?: string };
  if (typeof j.result !== "string") throw new Error("evm: nonce not read");
  const n = parseInt(j.result, 16);
  const now = deps.now();
  const d = kday(now);
  if (s.nonce == null) s.partDay = d; // first reading ever: what it sent earlier today is not seen as today
  if (!s.base || s.base.day !== d) s.base = { day: d, n: s.nonce ?? n, at: now };
  s.nonce = n;
  s.days = { [d]: n - s.base.n };
}

export type TxTally = { at: number; today: number; ever: number; day: string; part: string[]; wallets: { key: string; label: string; chain: string; today: number; ever: number; read: boolean; err: string | null }[] };

/** What the page shows: per wallet and in total, from the kept counts. Pure. */
export function tally(st: TxState, now: number, meta: { key: string; label: string; chain: string }[]): TxTally {
  const d = kday(now);
  const out = meta.map((m) => {
    const s = st[m.key];
    const ever = s ? (s.nonce != null ? s.nonce : Object.values(s.days).reduce((a, x) => a + x, 0)) : 0;
    return { key: m.key, label: m.label, chain: m.chain, today: s?.days[d] ?? 0, ever, read: !!s?.at && !s.err, err: s?.err ?? null };
  });
  // a nonce first read today misses what it sent before that first reading
  const part = meta.filter((m) => st[m.key]?.partDay === d).map((m) => m.label);
  return { at: now, day: d, today: out.reduce((a, x) => a + x.today, 0), ever: out.reduce((a, x) => a + x.ever, 0), part, wallets: out };
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
let last: TxTally | null = null;
let started = false;
/** For the public status: counts only. */
let runErr: string | null = null;
export const txPublic = () => last ?? (runErr ? { err: runErr } : null);
/** Reads every wallet's chain now and every 10 minutes after, one source after another. */
export function startTxCount(deps: TxDeps) {
  if (started) return;
  started = true;
  const run = async () => {
    const st = deps.load();
    const w = deps.wallets();
    const meta: { key: string; label: string; chain: string }[] = [];
    const jobs: { key: string; go: (s: TxSrc) => Promise<void> }[] = [];
    for (const x of w.solana) if (x.address) { meta.push({ key: x.key, label: x.label, chain: "Solana" }); jobs.push({ key: x.key, go: (s) => solanaNew(deps, x.address, s) }); }
    if (w.polymarket) { meta.push({ key: "pm", label: "Polymarket", chain: "Polygon" }); jobs.push({ key: "pm", go: (s) => polymarketNew(deps, w.polymarket, s) }); }
    for (const x of w.hl) if (x.address) { meta.push({ key: x.key, label: "Hyperliquid", chain: "Hyperliquid" }); jobs.push({ key: x.key, go: (s) => hyperliquidNew(deps, x.address, s) }); }
    for (const x of w.evm) if (x.address) { meta.push({ key: x.key, label: x.label, chain: x.chain }); jobs.push({ key: x.key, go: (s) => evmNonce(deps, x.rpc, x.address, s) }); }
    if (!last) last = tally(st, deps.now(), meta);
    for (const j of jobs) {
      const s = (st[j.key] ??= { days: {} });
      try {
        await j.go(s);
        s.at = deps.now();
        s.err = null;
      } catch (e) {
        // the message only: never the address or a key that a URL could carry
        s.err = String((e as Error).message ?? "error").replace(/api-key=[^&\s]+/g, "api-key=…").slice(0, 120);
      }
      deps.save(st);
      await sleep(1_000);
    }
    last = tally(st, deps.now(), meta);
  };
  const loop = async () => {
    try {
      await run();
      runErr = null;
    } catch (e) {
      runErr = String((e as Error).message ?? "error").replace(/api-key=[^&\s]+/g, "api-key=…").slice(0, 160);
      console.log(`txcount: ${runErr}`);
    }
    setTimeout(loop, 10 * 60_000);
  };
  setTimeout(loop, 30_000);
}
