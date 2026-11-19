/**
 * The bridge's hands (see bridge.ts for the rules): the real chains, the real wallets, and the route finder (LI.FI,
 * which prices the move over the bridges it knows and builds the one transaction that starts it).
 *
 * What is checked HERE before a built transaction is signed, on top of bridge.ts's guard:
 *   - from Arbitrum: the transaction calls LI.FI's own contract and nothing else, on Arbitrum One, the contract has
 *     code, the USDC allowance is for exactly the amount, the bytes name our destination wallet, and the chain itself
 *     accepts the call (gas estimate) before anything is signed;
 *   - from Solana: the transaction has one signer and it is our wallet, and a simulation on the chain shows the wallet
 *     losing no more than the amount being sent plus a small fee.
 * Keys are read only by the send functions. Nothing here logs an address or a transaction id.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Interface } from "@ethersproject/abi";
import { BigNumber } from "@ethersproject/bignumber";
import { splitSignature } from "@ethersproject/bytes";
import { formatUnits } from "@ethersproject/units";
import { DATA, ROOT } from "../config.js";
import { loadJson } from "../store.js";
import { ARBITRUM_CHAIN_ID, ARBITRUM_RPC, HL_API, USDC as ARB_USDC, rpcCall } from "../hyperliquid/fund.js";
import { hlWallet, hlWalletExists } from "../hyperliquid/keys.js";
import { base58decode, namedWallet, signTransaction, wallet as solWallet, type Wallet as SolWallet } from "../solana/keys.js";
import { ata } from "../solana/soltx.js";
import { base58 } from "../solana/whirlpool.js";
import { bridgeTick, parseOrder, scrub, type Chain, type Deps, type PlaceInfo, type Quote, type QuoteReq, type Token } from "./bridge.js";
import type { Place } from "./state.js";

export const LIFI_API = process.env.LIFI_API || "https://li.quest/v1";
/** LI.FI's contract (the "diamond"): the same address on Arbitrum and Polygon. Checked for code before use. */
export const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const POLYGON_RPC = process.env.POLYGON_RPC || "https://polygon-bor-rpc.publicnode.com";
/** pUSD, USDC.e, native USDC on Polygon: every kind of dollar the Polymarket wallet holds (as in src/live.ts) */
const POLYGON_DOLLARS = ["0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"];
const POLYGON_USDC = POLYGON_DOLLARS[2];
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_NATIVE = "11111111111111111111111111111111";
/** native USDC on Base */
const BASE_USDC = "0x833589fCD6eDb6E4f93BF2a8dF9FcF4a5b0b2913";
const CHAIN_ID: Record<Chain, number> = { arbitrum: ARBITRUM_CHAIN_ID, polygon: 137, base: 8453, solana: 1151111081099710 };
/** the most native coin a bridge transaction may carry as its own fee (Arbitrum ETH) */
export const MAX_VALUE_ETH = 0.0005;
/** the most SOL a bridge transaction may take on top of what is sent */
export const MAX_SOL_FEE = 0.02;
const TIMEOUT = 15_000;

export const tokenAddress = (chain: Chain, token: Token): string => {
  if (chain === "solana") return token === "SOL" ? SOL_NATIVE : SOL_USDC;
  if (token !== "USDC") throw new Error("only USDC moves on this chain");
  return chain === "arbitrum" ? ARB_USDC : chain === "base" ? BASE_USDC : POLYGON_USDC;
};
const decimals = (t: Token) => (t === "SOL" ? 9 : 6);
const units = (amount: number, t: Token) => BigInt(Math.round(amount * 10 ** decimals(t)));
const human = (raw: unknown, t: Token) => Number(BigInt(String(raw ?? "0"))) / 10 ** decimals(t);
const chainOf = (id: unknown): Chain | null => (Object.keys(CHAIN_ID) as Chain[]).find((c) => String(CHAIN_ID[c]) === String(id)) ?? (String(id) === "SOL" ? "solana" : null);
const tokenOf = (chain: Chain | null, address: unknown): string => {
  if (!chain) return "?";
  for (const t of ["USDC", "SOL"] as Token[]) {
    try {
      const a = tokenAddress(chain, t);
      if (chain === "solana" ? a === address : a.toLowerCase() === String(address).toLowerCase()) return t;
    } catch {
      // this chain has no such token
    }
  }
  return "?";
};

/** Turn LI.FI's answer into the plain quote bridge.ts checks. Throws when a field it needs is missing. Pure. */
export function readQuote(j: unknown, r: QuoteReq): Quote {
  const q = j as { tool?: unknown; action?: Record<string, unknown> & { fromToken?: { address?: unknown }; toToken?: { address?: unknown } }; estimate?: Record<string, unknown>; transactionRequest?: Record<string, unknown> };
  if (!q?.action || !q.estimate || !q.transactionRequest) throw new Error(`the route finder gave no route${typeof (j as { message?: unknown })?.message === "string" ? `: ${(j as { message: string }).message}` : ""}`);
  const fromChain = chainOf(q.action.fromChainId);
  const toChain = chainOf(q.action.toChainId);
  const t = q.transactionRequest;
  const data = String(t.data ?? "");
  if (!data) throw new Error("the route finder built no transaction");
  return {
    tool: String(q.tool ?? "?").replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 30),
    minutes: Number(q.estimate.executionDuration ?? 0) / 60,
    toAmount: human(q.estimate.toAmount, r.to.token),
    toAmountMin: human(q.estimate.toAmountMin, r.to.token),
    echo: { fromChain, toChain, fromToken: tokenOf(fromChain, q.action.fromToken?.address), toToken: tokenOf(toChain, q.action.toToken?.address), fromAddress: String(q.action.fromAddress ?? ""), toAddress: String(q.action.toAddress ?? ""), fromAmount: human(q.action.fromAmount, r.from.token) },
    tx: r.from.chain === "solana" ? { kind: "solana", data } : { kind: "evm", to: String(t.to ?? ""), data, value: String(t.value ?? "0x0"), chainId: Number(t.chainId ?? 0), approval: String(q.estimate.approvalAddress ?? "") },
  };
}

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** The checks on an Arbitrum transaction that need no network. Returns the problems. Pure. */
export function inspectEvm(r: QuoteReq, q: Quote): string[] {
  if (q.tx.kind !== "evm") return ["not an Arbitrum transaction"];
  const bad: string[] = [];
  if (!sameHex(q.tx.to, LIFI_DIAMOND)) bad.push("the transaction does not call the route finder's own contract");
  if (!sameHex(q.tx.approval, LIFI_DIAMOND)) bad.push("the transaction wants the USDC allowance for another contract");
  if (q.tx.chainId !== CHAIN_ID[r.from.chain]) bad.push("the transaction is for another chain");
  let value = -1;
  try {
    value = Number(formatUnits(BigNumber.from(q.tx.value || "0x0"), 18));
  } catch {
    // stays -1
  }
  if (!(value >= 0 && value <= MAX_VALUE_ETH)) bad.push(`the transaction carries more ETH than a bridge fee (limit ${MAX_VALUE_ETH})`);
  const dest = r.to.chain === "solana" ? base58decode(r.to.address).toString("hex") : r.to.address.slice(2).toLowerCase();
  if (!/^0x[0-9a-fA-F]+$/.test(q.tx.data) || !q.tx.data.toLowerCase().includes(dest)) bad.push("the transaction's bytes do not name our destination wallet");
  return bad;
}

/** One signer, and it is ours? The same test signTransaction makes, without signing. Pure. */
export function inspectSolana(b64: string, pubkey: Buffer): string[] {
  const tx = Buffer.from(b64, "base64");
  if (tx.length < 100 || tx[0] !== 1) return ["the transaction wants more than our one signature"];
  const msg = tx.subarray(65);
  const off = msg[0] & 0x80 ? 1 : 0;
  if (msg[off] !== 1) return ["the transaction needs more than one signer"];
  const n = msg[off + 3] & 0x80 ? 2 : 1;
  return msg.subarray(off + 3 + n, off + 3 + n + 32).equals(pubkey) ? [] : ["the transaction's signer is not our wallet"];
}

const erc20 = new Interface(["function balanceOf(address owner) view returns (uint256)", "function allowance(address owner, address spender) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)"]);

function solRpcUrl(): string {
  let k = process.env.HELIUS_API_KEY ?? "";
  if (!k)
    try {
      k = readFileSync(join(DATA, "helius-key.txt"), "utf8").trim();
    } catch {
      k = "";
    }
  return k ? `https://mainnet.helius-rpc.com/?api-key=${k}` : process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
}

export function realDeps(fetcher: typeof fetch = fetch): Deps {
  const getJson = async (url: string, init?: RequestInit) => {
    const res = await fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
    const j = (await res.json().catch(() => null)) as unknown;
    if (!res.ok && !j) throw new Error(`http ${res.status}`);
    return j;
  };
  const arb = <T>(method: string, params: unknown[]) => rpcCall<T>(method, params, fetcher, ARBITRUM_RPC);
  const poly = <T>(method: string, params: unknown[]) => rpcCall<T>(method, params, fetcher, POLYGON_RPC);
  const base = <T>(method: string, params: unknown[]) => rpcCall<T>(method, params, fetcher, process.env.BASE_RPC || "https://mainnet.base.org");
  const sol = async <T>(method: string, params: unknown[]): Promise<T> => {
    const j = (await getJson(solRpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })) as { result?: T; error?: { message?: string } };
    if (!j || j.error || j.result === undefined) throw new Error(`solana ${method}: ${String(j?.error?.message ?? "no result").slice(0, 80)}`);
    return j.result;
  };
  const erc20Of = async (rpc: typeof arb, token: string, owner: string) => Number(formatUnits(BigNumber.from(await rpc<string>("eth_call", [{ to: token, data: erc20.encodeFunctionData("balanceOf", [owner]) }, "latest"])), 6));
  const solWalletOf = (p: Place): SolWallet => (p === "solana-perps" ? namedWallet("perps") : p === "solana-spot-rules" ? namedWallet("buckets") : solWallet());
  const signerFor = (address: string): SolWallet => {
    const w = (["solana-perps", "solana-spot-rules", "solana-spot-copy"] as Place[]).map(solWalletOf).find((x) => x.address === address);
    if (!w) throw new Error("no key on this machine for that Solana wallet");
    return w;
  };
  const solBalance = async (address: string, token: Token) => {
    if (token === "SOL") return (await sol<{ value: number }>("getBalance", [address, { commitment: "confirmed" }])).value / 1e9;
    const r = await sol<{ value: { account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }[] }>("getTokenAccountsByOwner", [address, { mint: SOL_USDC }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    return r.value.reduce((a, x) => a + Number(x.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
  };
  const place = (p: Place): PlaceInfo => {
    if (p === "hyperliquid") {
      if (!hlWalletExists()) throw new Error("this machine has no Hyperliquid wallet");
      return { chain: "arbitrum", address: hlWallet().address, token: "USDC" };
    }
    if (p === "polymarket") {
      const funder = String(loadJson<{ funder?: string }>("live.json", {}).funder ?? "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(funder)) throw new Error("this machine does not know the Polymarket wallet");
      return { chain: "polygon", address: funder, token: "USDC" };
    }
    return { chain: "solana", address: solWalletOf(p).address, token: p === "solana-perps" ? "USDC" : "SOL" };
  };
  const balance = (p: PlaceInfo) => (p.chain === "solana" ? solBalance(p.address, p.token) : erc20Of(p.chain === "arbitrum" ? arb : p.chain === "base" ? base : poly, tokenAddress(p.chain, "USDC"), p.address));
  const hlInfo = (body: unknown) => getJson(`${HL_API}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  /** sign and send one Arbitrum transaction from the Hyperliquid wallet, and wait for it */
  const arbSend = async (from: string, tx: { to: string; data: string; value?: BigNumber }): Promise<string> => {
    const signer = hlWallet();
    if (!sameHex(signer.address, from)) throw new Error("the wallet key is not for this address");
    const value = tx.value ?? BigNumber.from(0);
    const req = { from, to: tx.to, data: tx.data, value: value.toHexString().replace(/^0x0+(?=.)/, "0x") };
    const gas = BigNumber.from(await arb<string>("eth_estimateGas", [req])).mul(13).div(10); // a call that would fail is found here, before anything is signed
    const gasPrice = BigNumber.from(await arb<string>("eth_gasPrice", [])).mul(3).div(2);
    const nonce = Number(await arb<string>("eth_getTransactionCount", [from, "pending"]));
    const raw = await signer.signTransaction({ to: tx.to, data: tx.data, value, nonce, gasLimit: gas, gasPrice, chainId: ARBITRUM_CHAIN_ID, type: 0 });
    const hash = await arb<string>("eth_sendRawTransaction", [raw]);
    const until = Date.now() + 90_000;
    for (;;) {
      const rec = await arb<{ status?: string } | null>("eth_getTransactionReceipt", [hash]).catch(() => null);
      if (rec) {
        if (rec.status !== "0x1") throw new Error("transaction failed on chain");
        return hash;
      }
      if (Date.now() > until) return hash; // sent and not seen yet: the bridge waits for the arrival, it does not send again
      await new Promise((ok) => setTimeout(ok, 2_000));
    }
  };

  return {
    order: () => {
      try {
        return parseOrder(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8"));
      } catch {
        return null;
      }
    },
    place,
    balance,
    watch: async (p) => {
      const info = place(p);
      if (p !== "polymarket") return balance(info);
      let total = 0;
      for (const t of POLYGON_DOLLARS) total += await erc20Of(poly, t, info.address);
      return total;
    },
    solUsd: async () => Number(((await hlInfo({ type: "allMids" })) as Record<string, string>)?.SOL),
    quote: async (r) => {
      const qs = new URLSearchParams({ fromChain: String(CHAIN_ID[r.from.chain]), toChain: String(CHAIN_ID[r.to.chain]), fromToken: tokenAddress(r.from.chain, r.from.token), toToken: tokenAddress(r.to.chain, r.to.token), fromAmount: units(r.amount, r.from.token).toString(), fromAddress: r.from.address, toAddress: r.to.address, slippage: "0.005", order: "CHEAPEST" });
      return readQuote(await getJson(`${LIFI_API}/quote?${qs}`), r);
    },
    inspect: async (r, q) => {
      if (q.tx.kind === "evm") {
        const bad = inspectEvm(r, q);
        if (Number(await arb<string>("eth_chainId", [])) !== ARBITRUM_CHAIN_ID) bad.push("the RPC is not Arbitrum One");
        else if ((await arb<string>("eth_getCode", [LIFI_DIAMOND, "latest"])).length <= 2) bad.push("no contract at the route finder's address");
        return bad;
      }
      const w = signerFor(r.from.address);
      const bad = inspectSolana(q.tx.data, w.pubkey);
      if (bad.length) return bad;
      // what the chain says the transaction would do to the wallet
      const usdcAcc = ata(w.address, SOL_USDC);
      const before = { sol: await solBalance(w.address, "SOL"), usdc: await solBalance(w.address, "USDC") };
      const sim = await sol<{ value: { err?: unknown; accounts?: ({ lamports: number; data: [string, string] } | null)[] | null } }>("simulateTransaction", [q.tx.data, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: [w.address, usdcAcc] } }]);
      if (sim.value.err) return ["the chain would refuse the transaction (simulation failed)"];
      const [a, t] = sim.value.accounts ?? [];
      if (!a) return ["the simulation did not show the wallet"];
      const solLost = before.sol - a.lamports / 1e9;
      const tokenRaw = t ? Buffer.from(t.data[0], "base64") : null;
      const usdcAfter = tokenRaw && tokenRaw.length >= 72 ? Number(tokenRaw.readBigUInt64LE(64)) / 1e6 : before.usdc;
      const usdcLost = before.usdc - usdcAfter;
      if (solLost > (r.from.token === "SOL" ? r.amount : 0) + MAX_SOL_FEE) bad.push("the transaction would take more SOL than the move and a small fee");
      if (usdcLost > (r.from.token === "USDC" ? r.amount : 0) + 0.01) bad.push("the transaction would take more USDC than the move");
      return bad;
    },
    send: async (r, q) => {
      if (q.tx.kind === "solana") {
        const signed = signTransaction(q.tx.data, signerFor(r.from.address));
        const sig = base58(Buffer.from(signed, "base64").subarray(1, 65));
        await sol<string>("sendTransaction", [signed, { encoding: "base64", skipPreflight: false, maxRetries: 5 }]);
        const until = Date.now() + 120_000;
        for (;;) {
          const st = (await sol<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [[sig]]).catch(() => null))?.value?.[0];
          if (st?.err) throw new Error("transaction failed on chain");
          if (st && st.confirmationStatus !== "processed") return sig;
          if (Date.now() > until) throw new Error("the transaction never landed"); // its blockhash is long dead by now: it cannot land later
          await new Promise((ok) => setTimeout(ok, 2_000));
        }
      }
      const bad = inspectEvm(r, q);
      if (bad.length) throw new Error(bad[0]);
      const amount = BigNumber.from(units(r.amount, "USDC").toString());
      const allowed = BigNumber.from(await arb<string>("eth_call", [{ to: ARB_USDC, data: erc20.encodeFunctionData("allowance", [r.from.address, LIFI_DIAMOND]) }, "latest"]));
      if (allowed.lt(amount)) await arbSend(r.from.address, { to: ARB_USDC, data: erc20.encodeFunctionData("approve", [LIFI_DIAMOND, amount]) });
      return arbSend(r.from.address, { to: LIFI_DIAMOND, data: q.tx.data, value: BigNumber.from(q.tx.value || "0x0") });
    },
    status: async (tx, r) => {
      const j = (await getJson(`${LIFI_API}/status?${new URLSearchParams({ txHash: tx, fromChain: String(CHAIN_ID[r.from.chain]), toChain: String(CHAIN_ID[r.to.chain]) })}`)) as { status?: string } | null;
      return j?.status === "DONE" ? "done" : j?.status === "FAILED" ? "failed" : j?.status === "PENDING" ? "pending" : "unknown";
    },
    hlFree: async () => Number(((await hlInfo({ type: "clearinghouseState", user: place("hyperliquid").address })) as { withdrawable?: string })?.withdrawable ?? 0),
    hlWithdraw: async (usd) => {
      // signed by the wallet itself, and the destination is the wallet's own address on Arbitrum: money cannot leave to anyone else
      const w = hlWallet();
      const time = Date.now();
      const action = { type: "withdraw3", hyperliquidChain: "Mainnet", signatureChainId: "0xa4b1", destination: w.address.toLowerCase(), amount: String(Math.round(usd * 100) / 100), time };
      const domain = { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: "0x0000000000000000000000000000000000000000" };
      const types = { "HyperliquidTransaction:Withdraw": [{ name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "amount", type: "string" }, { name: "time", type: "uint64" }] };
      const s = splitSignature(await w._signTypedData(domain, types, { hyperliquidChain: action.hyperliquidChain, destination: action.destination, amount: action.amount, time }));
      const j = (await getJson(`${HL_API}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, nonce: time, signature: { r: s.r, s: s.s, v: s.v } }) })) as { status?: string; response?: unknown } | null;
      if (j?.status !== "ok") throw new Error(`refused: ${scrub(typeof j?.response === "string" ? j.response : "Hyperliquid did not take the withdrawal")}`);
    },
    now: () => Date.now(),
  };
}

/** Called once when the bot starts. Does nothing at all while deploy/live-rules.json carries no bridge order. */
export function startBridge(fetcher: typeof fetch = fetch): void {
  if (process.env.BRIDGE === "off") return;
  const d = realDeps(fetcher);
  setInterval(() => void bridgeTick(d).catch(() => undefined), 20_000).unref();
}
