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
import { ARBITRUM_CHAIN_ID, ARBITRUM_RPC, HL_API } from "./fund.js";
import { hlAgent, hlWallet } from "./keys.js";

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
  return run();
}

/** For the public status: no address, no key, no balance. */
export function hlPublic() {
  return { stage: "setup: wallet made, waiting for money; nothing trades", wallet, reach };
}

/** Behind the dashboard's password only. */
export function hlPrivate() {
  return { address: wallet.ok ? address : null, network: "Arbitrum One", token: "ETH", wallet, reach };
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
<p style="color:#9aa4b2;font-size:14px">Server check: Hyperliquid ${ok(p.reach?.hyperliquidApi)} · Arbitrum ${ok(p.reach?.arbitrumRpc)} · region ${p.reach?.region ?? "not read"}</p></body>`;
}

export const _hlTest = { reset: () => void ((wallet = { ok: false, error: "not started" }), (address = ""), (reach = null)) };
