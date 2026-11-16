/**
 * Truth check (16 Nov 2026, enrique: "i have to know if the values are correct"). Every 30 minutes, and 4 minutes after
 * a start, the dashboard's headline figures are compared with sources that do not come from the bot's own books:
 *
 *   Polymarket cash          the three collaterals' balanceOf on Polygon
 *   Polymarket open bets     Polymarket's data API: the wallet's positions not yet redeemable, at their currentValue
 *   won, waiting for claim   the same API: redeemable positions (a lost one is worth 0)
 *   each Solana wallet       SOL, and every token account of both token programs, each coin valued by a Jupiter sale
 *                            quote (USDC and USDT at $1); an open perp is taken from the perps module's own chain read
 *   money in and out         each Solana wallet's transfers from and to wallets that are not ours (Helius, 8 days),
 *                            against the deposits and withdrawals the worth chart takes out of its windows
 *   Polymarket all time      Polymarket's own profit figure for the wallet, where its public endpoint answers
 *
 * Read-only: it sends nothing. Absolute figures (balances, deposits) stay on this machine in data/truth.json and in the
 * password-protected page; the public status gets only the differences (dashboard minus source), which give no
 * balance away, and counts. TRUTHCHECK=off disables it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./config.js";
import { loadJson, saveJson } from "./store.js";

const POLY_RPC = "https://polygon-bor-rpc.publicnode.com";
/** Polymarket's collaterals, as src/live.ts reads them (pUSD, USDC.e, USDC). */
const COLLATERALS: Record<string, string> = { pUSD: "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb", "USDC.e": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" };
const DATA_API = "https://data-api.polymarket.com";
const SOL = "So11111111111111111111111111111111111111112";
const USD_MINTS = new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGqPvSKUnzEZnUyiHN4bt3VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

const r2 = (x: number) => Math.round(x * 100) / 100;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** What the dashboard shows, as src/worthdash.ts last worked it out. */
export type DashFigures = { at: number; total: number | null; cash: number | null; claim: number; bets: number; betsN: number; solBal: number | null; coinsSol: number; coinsN: number; solUsd: number | null; rulesUsd: number | null; perpsUsd: number | null; perpsPos: number };
/** One compared figure: dash = the dashboard, src = the source; diff = dash - src. */
export type Item = { k: string; dash: number | null; src: number | null; diff: number | null; ok: boolean | null; why?: string };
export type Coin = { mint: string; amount: string; sol: number | null; tracked: boolean };
export type Transfer = { t: number; wallet: string; usd: number; sig: string };

/** Within a dollar, or 1.5% of the source for a figure that moves with live prices: the two are read seconds apart. */
export function compare(k: string, dash: number | null, src: number | null, tolUsd = 1, tolPct = 0.015, why?: string): Item {
  if (dash == null || src == null || !Number.isFinite(dash) || !Number.isFinite(src)) return { k, dash, src, diff: null, ok: null, why: why ?? "not read" };
  const diff = r2(dash - src);
  return { k, dash: r2(dash), src: r2(src), diff, ok: Math.abs(diff) <= Math.max(tolUsd, Math.abs(src) * tolPct), ...(why ? { why } : {}) };
}

/** Polymarket's positions for the wallet: open ones (not redeemable) and redeemable ones, at Polymarket's currentValue. */
export function splitPositions(rows: { size?: number | string; currentValue?: number | string; curPrice?: number | string; redeemable?: boolean }[]) {
  let open = 0;
  let openN = 0;
  let won = 0;
  let wonN = 0;
  let lostN = 0;
  for (const p of rows) {
    const size = Number(p.size);
    const v = Number(p.currentValue);
    if (!(size > 1e-6) || !Number.isFinite(v)) continue;
    if (p.redeemable) {
      if (v > 0.005) {
        won += v;
        wonN++;
      } else lostN++;
    } else {
      open += v;
      openN++;
    }
  }
  return { open: r2(open), openN, won: r2(won), wonN, lostN };
}

/**
 * Money that came into or left one of our Solana wallets from a wallet that is not ours, from Helius's parsed
 * transfers. Transfers between our own wallets (a gas top-up) are left out, so are swaps and account closings (not
 * transfers). usd = SOL at px plus USDC/USDT; + = in.
 */
export function externalTransfers(txs: { signature?: string; timestamp?: number; nativeTransfers?: { fromUserAccount?: string; toUserAccount?: string; amount?: number }[]; tokenTransfers?: { fromUserAccount?: string; toUserAccount?: string; mint?: string; tokenAmount?: number }[] }[], wallet: string, ours: Set<string>, px: number, label: string): Transfer[] {
  const out: Transfer[] = [];
  for (const tx of txs) {
    let usd = 0;
    for (const n of tx.nativeTransfers ?? []) {
      const sol = Number(n.amount) / 1e9;
      if (!(sol > 0)) continue;
      if (n.toUserAccount === wallet && n.fromUserAccount && !ours.has(n.fromUserAccount)) usd += sol * px;
      if (n.fromUserAccount === wallet && n.toUserAccount && !ours.has(n.toUserAccount)) usd -= sol * px;
    }
    for (const n of tx.tokenTransfers ?? []) {
      if (!n.mint || !USD_MINTS.has(n.mint)) continue;
      const a = Number(n.tokenAmount);
      if (!(a > 0)) continue;
      if (n.toUserAccount === wallet && n.fromUserAccount && !ours.has(n.fromUserAccount)) usd += a;
      if (n.fromUserAccount === wallet && n.toUserAccount && !ours.has(n.toUserAccount)) usd -= a;
    }
    // network fees and the small change of a swap are not money put in or taken out
    if (Math.abs(usd) >= 1) out.push({ t: (Number(tx.timestamp) || 0) * 1000, wallet: label, usd: r2(usd), sig: String(tx.signature ?? "") });
  }
  return out;
}

/**
 * Each chain transfer against the flows the worth chart took out of its windows: a flow of the same wallet within 30
 * minutes and within $3 or 5% (SOL moves) is a match.
 */
export function matchFlows(chain: Transfer[], flows: [number, number, string][]) {
  const used = new Set<number>();
  const matched: Transfer[] = [];
  const missing: Transfer[] = [];
  for (const c of chain) {
    const i = flows.findIndex((f, j) => !used.has(j) && f[2] === c.wallet && Math.abs(f[0] - c.t) <= 30 * 60_000 && Math.abs(f[1] - c.usd) <= Math.max(3, Math.abs(c.usd) * 0.05));
    if (i >= 0) {
      used.add(i);
      matched.push(c);
    } else missing.push(c);
  }
  // a flow the chart took out with no transfer behind it: a result booked as money in or out
  const extra = flows.filter((f, j) => !used.has(j) && f[2] !== "Polymarket");
  return { matched, missing, extra };
}

// ---- reads (the server) ------------------------------------------------------------------------------------------------
type Deps = {
  dash: () => DashFigures | null;
  flows: () => [number, number, string][];
  allTime: () => number | null;
  rpcUrl: () => string;
  helius: () => string;
  quote: (mint: string, out: string, amount: string, bps: number) => Promise<{ outAmount?: string }>;
  tracked: () => { spot: Set<string>; rules: Set<string> };
  fetch: typeof fetch;
};
let deps: Deps | null = null;
let last: { at: number; items: Item[]; extra: Record<string, unknown> } | null = null;

const addrFile = (f: string) => {
  try {
    const p = join(DATA, f);
    const a = existsSync(p) ? readFileSync(p, "utf8").trim() : "";
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) ? a : "";
  } catch {
    return "";
  }
};

async function getJson(url: string, init?: RequestInit, ms = 15_000): Promise<unknown> {
  const res = await deps!.fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}
async function solRpc<T>(method: string, params: unknown[]): Promise<T> {
  const j = (await getJson(deps!.rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })) as { result?: T; error?: unknown };
  if (j.error || j.result === undefined) throw new Error(`rpc ${method}: error`);
  return j.result;
}
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** A Solana wallet as the chain has it: SOL, USD coins, and every other coin at a Jupiter sale quote (in SOL). */
async function solWallet(address: string, tracked: Set<string>) {
  const lamports = (await solRpc<{ value: number }>("getBalance", [address])).value;
  type Acc = { account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; uiAmount: number | null } } } } } };
  const coins: Coin[] = [];
  let usd = 0;
  let wsol = 0;
  for (const programId of TOKEN_PROGRAMS) {
    const r = await solRpc<{ value: Acc[] }>("getTokenAccountsByOwner", [address, { programId }, { encoding: "jsonParsed" }]);
    for (const a of r.value) {
      const info = a.account.data.parsed.info;
      if (info.tokenAmount.amount === "0") continue;
      if (USD_MINTS.has(info.mint)) usd += Number(info.tokenAmount.uiAmount) || 0;
      else if (info.mint === SOL) wsol += Number(info.tokenAmount.amount) / 1e9;
      else coins.push({ mint: info.mint, amount: info.tokenAmount.amount, sol: null, tracked: tracked.has(info.mint) });
    }
  }
  let noRoute = 0;
  let unpriced = 0;
  for (const c of coins) {
    try {
      const q = await deps!.quote(c.mint, SOL, c.amount, 300);
      c.sol = q.outAmount ? Number(q.outAmount) / 1e9 : 0;
    } catch (e) {
      if (/^jupiter \S+ http 4(?!29|01|03|08)\d\d\b/.test(String((e as Error)?.message ?? e))) {
        c.sol = 0;
        noRoute++;
      } else unpriced++;
    }
    await sleep(400); // one at a time: the real copy buys with the same key
  }
  const coinsSol = coins.reduce((a, c) => a + (c.sol ?? 0), 0);
  return { sol: lamports / 1e9 + wsol, usd, coins, coinsSol, noRoute, unpriced };
}

async function heliusTransfers(address: string, sinceMs: number): Promise<Parameters<typeof externalTransfers>[0]> {
  const key = deps!.helius();
  if (!key) throw new Error("no helius key");
  const all: Parameters<typeof externalTransfers>[0] = [];
  let before = "";
  for (let page = 0; page < 6; page++) {
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${key}&type=TRANSFER&limit=100${before ? `&before=${before}` : ""}`;
    const rows = (await getJson(url)) as Parameters<typeof externalTransfers>[0];
    if (!Array.isArray(rows) || !rows.length) break;
    all.push(...rows);
    const oldest = rows[rows.length - 1];
    if ((Number(oldest.timestamp) || 0) * 1000 < sinceMs || rows.length < 100) break;
    before = String(oldest.signature ?? "");
    await sleep(300);
  }
  return all.filter((x) => (Number(x.timestamp) || 0) * 1000 >= sinceMs);
}

/** One full check. Never throws: a part that cannot be read is reported as not read. */
export async function truthRun(now = Date.now()): Promise<typeof last> {
  if (!deps) return null;
  const d = deps.dash();
  const px = d?.solUsd ?? null;
  const items: Item[] = [];
  const extra: Record<string, unknown> = {};
  const errors: string[] = [];
  // Polymarket
  const funder = String(loadJson<{ funder?: string }>("live.json", {}).funder ?? "").trim();
  let pmCash: number | null = null;
  let pos: ReturnType<typeof splitPositions> | null = null;
  if (/^0x[0-9a-fA-F]{40}$/.test(funder)) {
    try {
      let sum = 0;
      for (const token of Object.values(COLLATERALS)) {
        const j = (await getJson(POLY_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data: `0x70a08231${funder.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"] }) })) as { result?: string };
        if (typeof j.result !== "string") throw new Error("polygon balance not read");
        sum += Number(BigInt(j.result)) / 1e6;
      }
      pmCash = sum;
    } catch (e) {
      errors.push(`polygon: ${(e as Error).message}`);
    }
    try {
      const rows: Parameters<typeof splitPositions>[0] = [];
      for (let off = 0; off < 2500; off += 500) {
        const page = (await getJson(`${DATA_API}/positions?user=${funder}&sizeThreshold=0&limit=500&offset=${off}`)) as Parameters<typeof splitPositions>[0];
        if (!Array.isArray(page)) throw new Error("positions not a list");
        rows.push(...page);
        if (page.length < 500) break;
      }
      pos = splitPositions(rows);
    } catch (e) {
      errors.push(`positions: ${(e as Error).message}`);
    }
    // Polymarket's own profit for the wallet (the profile page's figure), where the public endpoint answers
    try {
      const lb = (await getJson(`https://lb-api.polymarket.com/profit?window=all&limit=1&address=${funder}`)) as { amount?: number | string }[];
      const amt = Array.isArray(lb) && lb.length ? Number(lb[0].amount) : NaN;
      if (Number.isFinite(amt)) items.push(compare("Polymarket all time", deps.allTime(), amt, 2, 0.01, "against Polymarket's own profit figure"));
    } catch (e) {
      errors.push(`profit: ${(e as Error).message}`);
    }
  } else errors.push("no Polymarket wallet on this machine");
  items.push(compare("Polymarket cash", d?.cash ?? null, pmCash, 0.05, 0));
  items.push(compare("Polymarket open bets", d?.bets ?? null, pos?.open ?? null, 1, 0.03, "Polymarket values a bet at its own current price; ours is the book price"));
  items.push(compare("Polymarket won, waiting for claim", d?.claim ?? null, pos?.won ?? null, 0.5, 0.01));
  if (pos) extra.polymarketCounts = { dashOpen: d?.betsN ?? null, srcOpen: pos.openN, srcWaiting: pos.wonN, srcLostNotRedeemed: pos.lostN };
  const pmDash = d?.cash != null ? d.cash + d.claim + d.bets : null;
  const pmSrc = pmCash != null && pos ? pmCash + pos.open + pos.won : null;
  items.push(compare("Polymarket card", pmDash, pmSrc, 1, 0.01));
  // Solana wallets
  const wallets = { spot: addrFile("solana-wallet-address.txt"), rules: addrFile("solana-wallet-buckets-address.txt"), perps: addrFile("solana-wallet-perps-address.txt") };
  const ours = new Set(Object.values(wallets).filter(Boolean));
  const tr = deps.tracked();
  const solSrc: Record<string, number | null> = { spot: null, rules: null, perps: null };
  const coinsOut: Record<string, unknown> = {};
  if (px != null) {
    for (const k of ["spot", "rules", "perps"] as const) {
      const a = wallets[k];
      if (!a) continue;
      try {
        const w = await solWallet(a, k === "spot" ? tr.spot : k === "rules" ? tr.rules : new Set());
        const perpPos = k === "perps" ? (d?.perpsPos ?? 0) : 0;
        solSrc[k] = (w.sol + w.coinsSol) * px + w.usd + perpPos;
        const untracked = w.coins.filter((c) => !c.tracked);
        coinsOut[k] = { coins: w.coins.length, priced: w.coins.filter((c) => c.sol != null).length, noRoute: w.noRoute, unpriced: w.unpriced, untracked: untracked.length, untrackedUsd: r2(untracked.reduce((x, c) => x + (c.sol ?? 0), 0) * px), detail: w.coins.map((c) => ({ ...c, sol: c.sol == null ? null : r6(c.sol) })), solBal: r6(w.sol), usd: r2(w.usd) };
      } catch (e) {
        errors.push(`solana ${k}: ${(e as Error).message}`);
      }
    }
  } else errors.push("no SOL price");
  const spotDash = d && px != null && d.solBal != null ? (d.solBal + d.coinsSol) * px : null;
  items.push(compare("Solana spot copy card", spotDash, solSrc.spot, 1, 0.015, "coins at a Jupiter sale quote; the chain's coins, tracked or not"));
  items.push(compare("Solana spot rules card", d?.rulesUsd ?? null, solSrc.rules, 1, 0.015));
  items.push(compare("Solana perps card", d?.perpsUsd ?? null, solSrc.perps, 1, 0.015, "an open perp from the perps module's own chain read"));
  const parts = [pmSrc, solSrc.spot, solSrc.rules, solSrc.perps];
  items.push(compare("Total worth", d?.total ?? null, parts.every((x) => x != null) ? parts.reduce((a: number, x) => a + (x as number), 0) : null, 2, 0.01));
  // money in and out of the Solana wallets, 8 days, against the flows the chart takes out
  if (px != null && deps.helius()) {
    const labels = { spot: "Solana spot copy", rules: "Solana spot rules", perps: "Solana perps" } as const;
    const chain: Transfer[] = [];
    for (const k of ["spot", "rules", "perps"] as const) {
      if (!wallets[k]) continue;
      try {
        chain.push(...externalTransfers(await heliusTransfers(wallets[k], now - 8 * 86_400_000), wallets[k], ours, px, labels[k]));
      } catch (e) {
        errors.push(`transfers ${k}: ${(e as Error).message}`);
      }
    }
    const flows = deps.flows().filter((f) => f[0] >= now - 8 * 86_400_000);
    const m = matchFlows(chain, flows);
    extra.flows = { chainTransfers: chain.length, matched: m.matched.length, missing: m.missing.map((x) => ({ t: x.t, wallet: x.wallet, usd: x.usd, sig: x.sig })), notOnChain: m.extra.map((f) => ({ t: f[0], usd: f[1], wallet: f[2] })), polymarketFlows: flows.filter((f) => f[2] === "Polymarket").map((f) => ({ t: f[0], usd: f[1] })) };
  }
  extra.coins = coinsOut;
  extra.errors = errors;
  extra.dashAt = d?.at ?? null;
  last = { at: now, items, extra };
  saveJson("truth.json", last);
  return last;
}

/** For the public status: the differences and counts only, never a balance or a deposit. */
export function truthPublic() {
  if (!last) return null;
  const ex = last.extra as { polymarketCounts?: unknown; coins?: Record<string, { coins: number; noRoute: number; unpriced: number; untracked: number; untrackedUsd: number }>; flows?: { chainTransfers: number; matched: number; missing: unknown[]; notOnChain: unknown[] }; errors?: string[] };
  return {
    at: last.at,
    note: "Dashboard minus an independent source (the chain, Polymarket's own position data). Within $1 or 1.5% = ok. Balances stay private.",
    items: last.items.map((i) => ({ k: i.k, diff: i.diff, ok: i.ok, ...(i.why ? { why: i.why } : {}) })),
    polymarketCounts: ex.polymarketCounts ?? null,
    coins: Object.fromEntries(Object.entries(ex.coins ?? {}).map(([k, v]) => [k, { coins: v.coins, noRoute: v.noRoute, unpriced: v.unpriced, untracked: v.untracked, untrackedUsd: v.untrackedUsd }])),
    flows: ex.flows ? { chainTransfers: ex.flows.chainTransfers, matched: ex.flows.matched, missingFromChart: ex.flows.missing.length, chartFlowsNotOnChain: ex.flows.notOnChain.length } : null,
    errors: (ex.errors ?? []).map((e) => e.replace(/0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/g, "…")),
  };
}
/** For the password-protected page: everything. */
export const truthPrivate = () => last;

export function startTruthCheck(d: Deps) {
  if (process.env.TRUTHCHECK === "off" || deps) return;
  deps = d;
  last = loadJson<typeof last>("truth.json", null);
  const run = () => void truthRun().catch(() => undefined);
  setTimeout(run, 4 * 60_000).unref();
  setInterval(run, 30 * 60_000).unref();
}
export const _truthTest = { setDeps: (d: Deps | null) => void (deps = d), reset: () => void (last = null) };
