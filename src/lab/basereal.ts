/**
 * REAL MONEY. The network side of the real Base copy (baselive.ts): swaps between USDC and a coin on Base from the
 * bot's own Base wallet, through the same route finder the bridge uses (LI.FI, same chain on both sides).
 *
 * Before anything is signed, all of this must hold (inspectSwap, pure, and the chain checks beside it):
 *   - the RPC answers for Base, and the route finder's contract has code there;
 *   - the USDC is the one the bridge has proven on Base (never an address typed here);
 *   - the route's own description says: Base to Base, exactly the token and amount we asked, from our wallet and
 *     paying our wallet; the transaction calls the route finder's contract and nothing else, carries no ETH, wants
 *     the allowance for that same contract, and its bytes name our wallet;
 *   - the least it promises is near the price the paper copy sees (PRICE_SLACK): a bad price is refused, not taken;
 *   - the allowance given is for exactly the amount sold, never unlimited;
 *   - a call that would fail is found by the gas estimate, before signing.
 * The wallet is never made here (the bridge makes it) and its key is used only to sign these transactions.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Interface } from "@ethersproject/abi";
import { BigNumber } from "@ethersproject/bignumber";
import { formatUnits } from "@ethersproject/units";
import { DATA, ROOT } from "../config.js";
import { rpcCall } from "../hyperliquid/fund.js";
import { baseWallet } from "../bridge/basekey.js";
import { LIFI_API, LIFI_DIAMOND, realDeps as bridgeDeps, tokenAddress } from "../bridge/real.js";
import { parseSwitch, type Deps } from "./baselive.js";

export const BASE_CHAIN_ID = 8453;
/** the least a buy may promise against the paper price; a sale gets more room (a falling coin must still be sold) */
export const PRICE_SLACK = { buy: 0.97, sell: 0.93 };
const SLIPPAGE = "0.01";
const erc20 = new Interface(["function decimals() view returns (uint8)", "function balanceOf(address owner) view returns (uint256)", "function allowance(address owner, address spender) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)"]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

export interface SwapReq {
  wallet: string;
  fromToken: string;
  toToken: string;
  /** smallest units of fromToken */
  amount: bigint;
  /** the least of toToken (smallest units) the route must promise */
  minOut: bigint;
}
export interface Swap {
  to: string;
  data: string;
  minOut: bigint;
}
/** The route finder's answer checked against what we asked. Returns the problems and, with none, the transaction. Pure. */
export function inspectSwap(r: SwapReq, j: unknown): { bad: string[]; swap: Swap | null } {
  const q = j as { action?: Record<string, unknown> & { fromToken?: { address?: unknown }; toToken?: { address?: unknown } }; estimate?: Record<string, unknown>; transactionRequest?: Record<string, unknown>; message?: unknown };
  if (!q?.action || !q.estimate || !q.transactionRequest) return { bad: [`the route finder gave no route${typeof q?.message === "string" ? `: ${q.message.slice(0, 80)}` : ""}`], swap: null };
  const bad: string[] = [];
  const a = q.action;
  const t = q.transactionRequest;
  if (String(a.fromChainId) !== String(BASE_CHAIN_ID) || String(a.toChainId) !== String(BASE_CHAIN_ID)) bad.push("the route is not Base to Base");
  if (!isAddr(a.fromToken?.address) || !same(a.fromToken.address, r.fromToken)) bad.push("the route sells another token than asked");
  if (!isAddr(a.toToken?.address) || !same(a.toToken.address, r.toToken)) bad.push("the route buys another token than asked");
  if (String(a.fromAmount) !== r.amount.toString()) bad.push("the route is for another amount than asked");
  if (!isAddr(a.fromAddress) || !same(a.fromAddress, r.wallet)) bad.push("the route does not start at our wallet");
  if (!isAddr(a.toAddress) || !same(a.toAddress, r.wallet)) bad.push("the route does not pay our own wallet");
  if (!isAddr(t.to) || !same(t.to, LIFI_DIAMOND)) bad.push("the transaction does not call the route finder's own contract");
  if (!isAddr(q.estimate.approvalAddress) || !same(q.estimate.approvalAddress, LIFI_DIAMOND)) bad.push("the transaction wants the allowance for another contract");
  if (Number(t.chainId) !== BASE_CHAIN_ID) bad.push("the transaction is for another chain");
  let value = "x";
  try {
    value = BigNumber.from(t.value ?? "0x0").toString();
  } catch {
    // stays "x"
  }
  if (value !== "0") bad.push("the transaction carries ETH: a token swap needs none");
  const data = String(t.data ?? "");
  if (!/^0x[0-9a-fA-F]+$/.test(data) || !data.toLowerCase().includes(r.wallet.slice(2).toLowerCase())) bad.push("the transaction's bytes do not name our wallet");
  let minOut = 0n;
  try {
    minOut = BigInt(String(q.estimate.toAmountMin ?? "0"));
  } catch {
    // stays 0
  }
  if (minOut <= 0n || minOut < r.minOut) bad.push("the route's price is worse than the limit");
  return { bad, swap: bad.length ? null : { to: String(t.to), data, minOut } };
}

/** `n` dollars or coins as smallest units, rounded down. */
export const toRaw = (n: number, decimals: number): bigint => BigInt(Math.floor(n * 1e6)) * 10n ** BigInt(decimals) / 1_000_000n;

export function realBaseDeps(fetcher: typeof fetch = fetch): Deps {
  const rpc = <T>(method: string, params: unknown[]) => rpcCall<T>(method, params, fetcher, process.env.BASE_RPC || "https://mainnet.base.org");
  const bridge = bridgeDeps(fetcher);
  const hasWallet = () => existsSync(join(DATA, "base-wallet.json"));
  const me = () => baseWallet().address;
  let chainOk = false;
  const decimalsOf = new Map<string, number>();
  const call = async (token: string, fn: "decimals" | "balanceOf" | "allowance", args: unknown[] = []) => erc20.decodeFunctionResult(fn, await rpc<string>("eth_call", [{ to: token, data: erc20.encodeFunctionData(fn, args) }, "latest"]))[0] as BigNumber | number;
  /** the dollars in the wallet; reading them through the bridge is also what proves which USDC is the real one */
  const usdcBalance = async () => bridge.balance(bridge.place("base"));
  const usdc = async () => {
    await usdcBalance();
    return tokenAddress("base", "USDC");
  };
  const held = async (token: string) => BigInt(String(await call(token, "balanceOf", [me()])));
  const decimals = async (token: string) => {
    const c = decimalsOf.get(token.toLowerCase());
    if (c !== undefined) return c;
    const d = Number(await call(token, "decimals"));
    if (!Number.isInteger(d) || d < 0 || d > 30) throw new Error("the coin does not say its decimals");
    decimalsOf.set(token.toLowerCase(), d);
    return d;
  };
  const chain = async () => {
    if (chainOk) return;
    if (Number(await rpc<string>("eth_chainId", [])) !== BASE_CHAIN_ID) throw new Error("the RPC is not Base");
    if ((await rpc<string>("eth_getCode", [LIFI_DIAMOND, "latest"])).length <= 2) throw new Error("no contract at the route finder's address on Base");
    chainOk = true;
  };
  /** sign and send one transaction from the Base wallet and wait for it; a call that would fail is found by the estimate, before signing */
  const send = async (to: string, data: string): Promise<void> => {
    const w = baseWallet();
    const req = { from: w.address, to, data, value: "0x0" };
    const gas = BigNumber.from(await rpc<string>("eth_estimateGas", [req])).mul(13).div(10);
    const gasPrice = BigNumber.from(await rpc<string>("eth_gasPrice", [])).mul(3).div(2);
    const nonce = Number(await rpc<string>("eth_getTransactionCount", [w.address, "pending"]));
    const raw = await w.signTransaction({ to, data, value: BigNumber.from(0), nonce, gasLimit: gas, gasPrice, chainId: BASE_CHAIN_ID, type: 0 });
    const hash = await rpc<string>("eth_sendRawTransaction", [raw]);
    const until = Date.now() + 90_000;
    for (;;) {
      const rec = await rpc<{ status?: string } | null>("eth_getTransactionReceipt", [hash]).catch(() => null);
      if (rec) {
        if (rec.status !== "0x1") throw new Error("the transaction failed on chain");
        return;
      }
      if (Date.now() > until) throw new Error("sent, not seen on chain yet"); // the caller reads the balance: nothing is sent again
      await new Promise((ok) => setTimeout(ok, 2_000));
    }
  };
  const swap = async (r: SwapReq): Promise<void> => {
    await chain();
    if ((await rpc<string>("eth_getCode", [r.toToken, "latest"])).length <= 2 || (await rpc<string>("eth_getCode", [r.fromToken, "latest"])).length <= 2) throw new Error("one of the tokens is not a contract on Base");
    const qs = new URLSearchParams({ fromChain: String(BASE_CHAIN_ID), toChain: String(BASE_CHAIN_ID), fromToken: r.fromToken, toToken: r.toToken, fromAmount: r.amount.toString(), fromAddress: r.wallet, toAddress: r.wallet, slippage: SLIPPAGE });
    const res = await fetcher(`${LIFI_API}/quote?${qs}`, { signal: AbortSignal.timeout(15_000) });
    const j = (await res.json().catch(() => null)) as unknown;
    const { bad, swap: s } = inspectSwap(r, j);
    if (!s) throw new Error(bad.join("; "));
    // the allowance: exactly what this swap sells, never more
    const allowed = BigInt(String(await call(r.fromToken, "allowance", [r.wallet, LIFI_DIAMOND])));
    if (allowed < r.amount) await send(r.fromToken, erc20.encodeFunctionData("approve", [LIFI_DIAMOND, r.amount.toString()]));
    await send(s.to, s.data);
  };
  return {
    switch: () => {
      try {
        return parseSwitch(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8"));
      } catch {
        return null;
      }
    },
    hasWallet,
    balances: async () => ({ usdc: await usdcBalance(), eth: Number(formatUnits(BigNumber.from(await rpc<string>("eth_getBalance", [me(), "latest"])), 18)) }),
    held,
    buy: async (token, usd, px) => {
      if (!(px > 0) || !(usd > 0)) throw new Error("no price for the coin");
      const dec = await decimals(token);
      const before = await held(token);
      await swap({ wallet: me(), fromToken: await usdc(), toToken: token, amount: toRaw(usd, 6), minOut: toRaw((usd / px) * PRICE_SLACK.buy, dec) });
      const after = await held(token);
      return { raw: after > before ? after - before : 0n, decimals: dec };
    },
    sell: async (token, raw, px, force) => {
      const dec = await decimals(token);
      const before = await usdcBalance();
      const fair = (Number(raw) / 10 ** dec) * px;
      await swap({ wallet: me(), fromToken: token, toToken: await usdc(), amount: raw, minOut: force || !(px > 0) ? 1n : toRaw(fair * PRICE_SLACK.sell, 6) });
      // the wallet's own dollars before and after; money arriving from the bridge in the same seconds must not read as a sale's result
      const got = Math.max(0, (await usdcBalance()) - before);
      return px > 0 ? Math.min(got, fair * 1.5) : got;
    },
  };
}
