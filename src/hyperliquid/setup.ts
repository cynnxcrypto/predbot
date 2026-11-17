/**
 * What the bot does for the Hyperliquid front at every start (the server runs only the bot service, so nothing here
 * waits for a command by hand):
 *   - makes the wallet and the trading key if this machine has none (src/hyperliquid/keys.ts: mode 600, never replaced);
 *   - checks that this server can reach what the front needs: Hyperliquid's API and an Arbitrum RPC;
 *   - reads which AWS region the server is in (Hyperliquid does not serve every country).
 *
 * Public status gets only yes/no answers, the chain id and the region. The deposit address is given out by
 * hlPrivate() alone, which the dashboard serves behind its password. Nothing here signs or sends anything.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config.js";
import { ARBITRUM_CHAIN_ID, ARBITRUM_RPC, HL_API, fund, realChain, type Chain, type FundReport } from "./fund.js";
import { hlAgent, hlWallet } from "./keys.js";
import { fileCfg, hlKeptTraders, hlLiveSummary, hlLiveTick, type HlDeps } from "./live.js";
import { realVenue } from "./venue.js";
import { hlPaperOpens, perpMeetsBar, setKeptTraders, traderListed } from "../solana/buckets.js";

interface Reach {
  at: number;
  hyperliquidApi: boolean;
  /** coins Hyperliquid lists for perps (0 when not read) */
  coins: number;
  arbitrumRpc: boolean;
  chainId: number | null;
  region: string | null;
  errors: string[];
}
let wallet: { ok: boolean; error?: string } = { ok: false, error: "not started" };
let address = "";
let reach: Reach | null = null;
let funding: (FundReport & { at: number; mode: FundMode; error?: string }) | null = null;
let busy = false;

/** deploy/live-rules.json "hyperliquid": { "fund": "go" } swaps and deposits for real; anything else is a dry run. */
export type FundMode = "dry" | "go";
export function parseFundMode(text: string): FundMode {
  try {
    return (JSON.parse(text) as { hyperliquid?: { fund?: unknown } }).hyperliquid?.fund === "go" ? "go" : "dry";
  } catch {
    return "dry";
  }
}
const fundMode = (): FundMode => {
  try {
    return parseFundMode(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8"));
  } catch {
    return "dry";
  }
};

/** One look at the wallet: a dry run of the funding, or the real thing when the repo file says go. Never throws. */
export async function fundLook(chain: Chain, mode: FundMode = fundMode()): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    funding = { ...(await fund(chain, { go: mode === "go" })), at: Date.now(), mode };
  } catch (e) {
    funding = { dry: mode !== "go", problems: [], steps: [], eth: funding?.eth ?? 0, usdc: funding?.usdc ?? 0, hlUsd: funding?.hlUsd ?? 0, done: false, at: Date.now(), mode, error: short(e) };
  } finally {
    busy = false;
  }
}

const short = (e: unknown) => String((e as Error)?.message ?? e).replace(/0x[0-9a-fA-F]{40,}/g, "…").slice(0, 120);

export async function reachCheck(fetcher: typeof fetch = fetch): Promise<Reach> {
  const r: Reach = { at: Date.now(), hyperliquidApi: false, coins: 0, arbitrumRpc: false, chainId: null, region: null, errors: [] };
  const post = (url: string, body: unknown) => fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  try {
    const res = await post(`${HL_API}/info`, { type: "meta" });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const n = ((await res.json()) as { universe?: unknown[] }).universe?.length ?? 0;
    r.coins = n;
    r.hyperliquidApi = n > 0;
    if (!n) r.errors.push("hyperliquid: no coin list in the answer");
  } catch (e) {
    r.errors.push(`hyperliquid: ${short(e)}`);
  }
  try {
    const res = await post(ARBITRUM_RPC, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
    if (!res.ok) throw new Error(`http ${res.status}`);
    r.chainId = Number(((await res.json()) as { result?: string }).result);
    r.arbitrumRpc = r.chainId === ARBITRUM_CHAIN_ID;
    if (!r.arbitrumRpc) r.errors.push(`arbitrum: chain id ${r.chainId}`);
  } catch (e) {
    r.errors.push(`arbitrum: ${short(e)}`);
  }
  try {
    // EC2 instance metadata, version 2: a session token first, then the region with it
    const tok = await fetcher("http://169.254.169.254/latest/api/token", { method: "PUT", headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" }, signal: AbortSignal.timeout(2_000) });
    if (!tok.ok) throw new Error(`token http ${tok.status}`);
    const res = await fetcher("http://169.254.169.254/latest/meta-data/placement/region", { headers: { "X-aws-ec2-metadata-token": await tok.text() }, signal: AbortSignal.timeout(2_000) });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const region = (await res.text()).trim();
    r.region = /^[a-z0-9-]{3,30}$/.test(region) ? region : null;
  } catch (e) {
    r.errors.push(`region: ${short(e)}`);
  }
  return r;
}

/** Called once when the bot starts. Never throws: a failure here must not stop the bot. */
export function startHyperliquid(fetcher: typeof fetch = fetch): Promise<void> {
  if (process.env.HYPERLIQUID === "off") {
    wallet = { ok: false, error: "off" };
    return Promise.resolve();
  }
  try {
    address = hlWallet().address;
    hlAgent();
    wallet = { ok: true };
  } catch (e) {
    wallet = { ok: false, error: short(e) };
  }
  const run = () => reachCheck(fetcher).then((r) => void (reach = r)).catch(() => undefined);
  setInterval(run, 6 * 3_600_000).unref();
  if (wallet.ok) {
    // money that arrives is seen within five minutes; what happens to it depends on the switch in the repo file
    const chain = realChain(address, fetcher);
    const look = () => void fundLook(chain);
    setTimeout(look, 60_000).unref();
    setInterval(look, 5 * 60_000).unref();
    // real copies (src/hyperliquid/live.ts): does nothing unless deploy/live-rules.json hyperliquid.trade says so
    const deps: HlDeps = { cfg: fileCfg, venue: realVenue(address, fetcher), paperOpens: hlPaperOpens, meetsBar, listed: traderListed };
    setKeptTraders(hlKeptTraders, "hyperliquid");
    setInterval(() => void hlLiveTick(deps), 20_000).unref();
  }
  return run();
}

/** A trader's bar on Hyperliquid counts its paper copies on every coin (the Solana perps side wants some on SOL, BTC or ETH). */
const meetsBar = (rule: string, sinceMs: number, now: number) => perpMeetsBar(rule, sinceMs, now, 0);
/** The real copies, for the status and the tab (traders by short name, no address). */
export const hlLive = () => hlLiveSummary(fileCfg(), meetsBar);

/** For the public status: no address, no key, no balance. */
export function hlPublic() {
  return { stage: "setup: wallet made, waiting for money; nothing trades", wallet, reach, funding: funding ? { at: funding.at, mode: funding.mode, dry: funding.dry, done: funding.done, problems: funding.problems, steps: funding.steps, error: funding.error ?? null } : null };
}

/** Behind the dashboard's password only. */
export function hlPrivate() {
  return { address: wallet.ok ? address : null, network: "Arbitrum One", token: "ETH", wallet, reach, funding };
}

/** The private page: the deposit address and how to send to it. */
export function hlPage(): string {
  const p = hlPrivate();
  const ok = (v: boolean | undefined) => (v ? "ok" : "FAILED");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hyperliquid wallet</title>
<body style="font:16px system-ui;background:#0e1116;color:#e6e9ee;max-width:560px;margin:0 auto;padding:20px 16px">
<h2 style="margin:0 0 12px">Hyperliquid wallet</h2>
${p.address
    ? `<p>Send <b>ETH</b> on <b>Arbitrum One</b> only.</p>
<p id="a" style="font:15px ui-monospace,monospace;word-break:break-all;background:#171b22;padding:12px;border-radius:10px">${p.address}</p>
<button onclick="navigator.clipboard.writeText(document.getElementById('a').textContent).then(()=>this.textContent='Copied')" style="font:inherit;padding:10px 16px;border-radius:10px;border:0;background:#2f6feb;color:#fff">Copy address</button>
<p style="color:#9aa4b2">Not Ethereum mainnet, not another network. Minimum about $30. The bot keeps about $3 of ETH for gas, swaps the rest to USDC and deposits it into Hyperliquid.</p>`
    : `<p>No wallet yet: ${p.wallet.error ?? "unknown"}</p>`}
${p.funding ? `<p>Wallet: <b>${p.funding.eth} ETH</b>, ${p.funding.usdc} USDC · on Hyperliquid: <b>$${p.funding.hlUsd}</b></p>` : ""}
<p style="color:#9aa4b2;font-size:14px">Server check: Hyperliquid ${ok(p.reach?.hyperliquidApi)} · Arbitrum ${ok(p.reach?.arbitrumRpc)} · region ${p.reach?.region ?? "not read"}</p></body>`;
}

export const _hlTest = { reset: () => void ((wallet = { ok: false, error: "not started" }), (address = ""), (reach = null), (funding = null)) };
