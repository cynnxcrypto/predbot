/**
 * A LITTLE ARBITRUM GAS TO ENRIQUE (25 Nov 2026, enrique: "send a tiny bit of arbitrum gas to <his address> so i can
 * send some usdc"). One plain ETH transfer from the Hyperliquid wallet on Arbitrum One, once per order id.
 *
 * deploy/live-rules.json "hyperliquid.gasOut": { "id": "gas-1", "to": "<sealed>", "usd": 1.5 }.
 *   - the destination is sealed with the server's jev key (same seal as the Solana send-out): a changed or made-up value
 *     does not open, and his address is never readable in the public repo, status or logs;
 *   - at most MAX_USD dollars of ETH (Chainlink ETH/USD), and only when the wallet keeps KEEP_ETH_USD after it;
 *   - each id goes once: a transaction that left is never sent again (state data/gasout-state.json, server only).
 * The public status says what happened in words; the amount and transaction hash are sealed for MAIN.
 */
import { BigNumber } from "@ethersproject/bignumber";
import { getAddress } from "@ethersproject/address";
import { parseUnits } from "@ethersproject/units";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, ROOT } from "../config.js";
import { loadJson, saveJson } from "../store.js";
import { seal, unseal } from "../solana/sendout.js";
import { ARBITRUM_CHAIN_ID, realChain, rpcCall } from "./fund.js";
import { hlWallet } from "./keys.js";

export const MAX_USD = 3;
export const KEEP_ETH_USD = 1;
const FILE = "gasout-state.json";

export type GasOrder = { id: string; to: string; usd: number };
export type GasRun = { id: string; at: number; stage: "sent" | "refused" | "failed"; why?: string; hash?: string; eth?: number; usd?: number };
type St = { runs: GasRun[] };

/** The order's destination as a checksummed 0x address, or null. Pure. */
export function openTo(sealed: string, secret: string): string | null {
  const t = unseal(sealed, secret);
  if (!t || !/^0x[0-9a-fA-F]{40}$/.test(t)) return null;
  try {
    return getAddress(t);
  } catch {
    return null;
  }
}

/** What to send, or why not. Pure. */
export function gasPlan(o: GasOrder, to: string | null, ethBal: number, px: number): { eth: number } | { why: string } {
  if (!/^[a-z0-9-]{3,40}$/.test(o.id)) return { why: "the order needs an id" };
  if (!to) return { why: "the destination does not open with this server's key" };
  if (!(o.usd > 0 && o.usd <= MAX_USD)) return { why: `the amount must be above $0 and at most $${MAX_USD}` };
  if (!(px > 0)) return { why: "no ETH price" };
  const eth = Math.floor((o.usd / px) * 1e6) / 1e6;
  if (ethBal - eth < KEEP_ETH_USD / px) return { why: `the wallet has only $${(ethBal * px).toFixed(2)} of ETH; $${KEEP_ETH_USD} stays for its own gas` };
  return { eth };
}

function readOrder(): GasOrder | null {
  try {
    const g = (JSON.parse(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8")) as { hyperliquid?: { gasOut?: Partial<GasOrder> | null } }).hyperliquid?.gasOut;
    if (!g || typeof g.id !== "string" || typeof g.to !== "string") return null;
    return { id: g.id, to: g.to, usd: Number(g.usd) };
  } catch {
    return null;
  }
}
const secretOf = () => {
  try {
    return readFileSync(join(DATA, "jev-key.txt"), "utf8").trim();
  } catch {
    return "";
  }
};

let busy = false;
async function tick(): Promise<void> {
  if (busy) return;
  const o = readOrder();
  if (!o) return;
  const s = loadJson<St>(FILE, { runs: [] });
  if (s.runs.some((r) => r.id === o.id)) return;
  busy = true;
  const run: GasRun = { id: o.id, at: Date.now(), stage: "refused" };
  try {
    const w = hlWallet();
    const chain = realChain(w.address);
    if ((await chain.chainId()) !== ARBITRUM_CHAIN_ID) throw new Error("not Arbitrum One");
    const px = await chain.refPrice();
    const plan = gasPlan(o, openTo(o.to, secretOf()), await chain.eth(w.address), px);
    if ("why" in plan) {
      run.why = plan.why;
    } else {
      const to = openTo(o.to, secretOf()) as string;
      const value = parseUnits(plan.eth.toFixed(6), 18);
      const req = { from: w.address, to, value: value.toHexString() };
      const gas = BigNumber.from(await rpcCall<string>("eth_estimateGas", [req])).mul(13).div(10);
      const gasPrice = BigNumber.from(await rpcCall<string>("eth_gasPrice", [])).mul(3).div(2);
      const nonce = Number(await rpcCall<string>("eth_getTransactionCount", [w.address, "pending"]));
      const raw = await w.signTransaction({ to, data: "0x", value, nonce, gasLimit: gas, gasPrice, chainId: ARBITRUM_CHAIN_ID, type: 0 });
      // booked as sent before it leaves: a send whose answer is lost is never sent again
      Object.assign(run, { stage: "sent", eth: plan.eth, usd: Math.round(plan.eth * px * 100) / 100 });
      s.runs.push(run);
      saveJson(FILE, s);
      run.hash = await rpcCall<string>("eth_sendRawTransaction", [raw]);
      saveJson(FILE, s);
      return;
    }
  } catch (e) {
    run.stage = "failed";
    run.why = String((e as Error)?.message ?? e).replace(/0x[0-9a-fA-F]{8,}/g, "0x…").slice(0, 120);
  } finally {
    busy = false;
  }
  s.runs.push(run);
  saveJson(FILE, s);
}

/** Public view: words only; amounts and hash sealed. */
export function gasOutSummary(): unknown {
  const s = loadJson<St>(FILE, { runs: [] });
  if (!s.runs.length) return null;
  const secret = secretOf();
  return s.runs.slice(-5).map((r) => ({ id: r.id, stage: r.stage, why: r.why ?? null, sealed: secret ? seal(JSON.stringify({ hash: r.hash, eth: r.eth, usd: r.usd }), secret) : null }));
}
/** What left, for the worth chart: money taken out of the Hyperliquid wallet, never a loss. */
export function gasOutMoves(): { from: string; to: string; startedAt: number; endedAt: number; arrivedUsd: number }[] {
  return loadJson<St>(FILE, { runs: [] }).runs.filter((r) => r.stage === "sent" && r.usd).map((r) => ({ from: "hyperliquid", to: "enrique", startedAt: r.at, endedAt: r.at, arrivedUsd: r.usd as number }));
}
export function startGasOut(): void {
  setInterval(() => void tick().catch(() => undefined), 60_000).unref();
}
