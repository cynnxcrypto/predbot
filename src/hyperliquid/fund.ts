/**
 * Funding the Hyperliquid wallet (enrique, 17 Nov 2026: "how about i send eth to the arbitrum wallet", "and u manage
 * the swap too"). He sends ETH on Arbitrum One to the wallet; this turns it into money on Hyperliquid:
 *
 *   1. keep a little ETH for gas (KEEP_GAS_USD), swap the rest to USDC (Uniswap v3, the 0.05% ETH/USDC pool);
 *   2. send a small test deposit (TEST_USDC) to Hyperliquid's bridge and wait until Hyperliquid shows it;
 *   3. only then send the rest.
 *
 * REAL MONEY, so everything is checked before anything is signed, on every run:
 *   - the chain is Arbitrum One, and every contract we name has code and is what we think (USDC says "USDC", 6 decimals);
 *   - the bridge is the real one: it holds a very large USDC balance (a wrong or made-up address would not);
 *   - the swap price is within MAX_PRICE_GAP of Hyperliquid's own ETH price, and the swap reverts under that floor.
 * A dry run (the default) does all of that and prints the plan; nothing is signed without --go.
 *
 * What it cannot do: send anything to an address other than the swap router and the bridge, both fixed here.
 * The wallet key is read only by the two send functions. State: data/hyperliquid-fund.json (server only).
 */
import { Interface } from "@ethersproject/abi";
import { BigNumber } from "@ethersproject/bignumber";
import { StaticJsonRpcProvider } from "@ethersproject/providers";
import { formatUnits, parseUnits } from "@ethersproject/units";
import { loadJson, saveJson } from "../store.js";
import { hlWallet } from "./keys.js";

export const ARBITRUM_CHAIN_ID = 42161;
export const ARBITRUM_RPC = process.env.ARBITRUM_RPC || "https://arb1.arbitrum.io/rpc";
export const HL_API = process.env.HYPERLIQUID_API || "https://api.hyperliquid.xyz";
/** Arbitrum One. Each is checked on the chain before use (see check()). */
export const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
export const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // native USDC, the only token the bridge credits
export const SWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; // Uniswap v3 SwapRouter02
export const QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"; // Uniswap v3 QuoterV2
export const HL_BRIDGE = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7"; // Hyperliquid Bridge2
export const POOL_FEE = 500;

export const KEEP_GAS_USD = 3;
/** below this much ETH over the gas reserve a swap is not worth its fee */
export const MIN_SWAP_USD = 5;
/** Hyperliquid loses a deposit under 5 USDC: we never send under this */
export const MIN_DEPOSIT_USDC = 5.5;
export const TEST_USDC = 6;
/** the swap must pay at least this share of Hyperliquid's ETH price (pool fee 0.05% + a little movement) */
export const MAX_PRICE_GAP = 0.01;
/** the real bridge holds far more than this; an address that does not is not the bridge */
export const BRIDGE_MIN_USDC = 10_000_000;
export const CREDIT_WAIT_MS = 10 * 60_000;

const r2 = (x: number) => Math.round(x * 100) / 100;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Everything the flow needs from the outside world, so tests can stand in for the chain and for Hyperliquid. */
export interface Chain {
  address: string;
  chainId(): Promise<number>;
  hasCode(address: string): Promise<boolean>;
  usdcMeta(): Promise<{ symbol: string; decimals: number }>;
  eth(address: string): Promise<number>;
  usdc(address: string): Promise<number>;
  /** USDC the pool would pay for this much ETH right now */
  quote(eth: number): Promise<number>;
  /** Hyperliquid's own ETH price */
  hlEthMid(): Promise<number>;
  /** dollars Hyperliquid shows for the account (perp account value + spot USDC) */
  hlValue(address: string): Promise<number>;
  /** USDC Hyperliquid's own ledger shows as deposited to the account since a time */
  hlDeposited(address: string, sinceMs: number): Promise<number>;
  swap(eth: number, minUsdc: number): Promise<string>;
  deposit(usdc: number): Promise<string>;
  sleep(ms: number): Promise<void>;
}

export interface FundState {
  /** a deposit sent and not yet seen on Hyperliquid: nothing more is sent while this stands */
  pending?: { usdc: number; before: number; walletUsdc: number; at: number; tx: string; test: boolean };
  /** true once any deposit of ours has been seen arriving: later ones skip the test */
  proven?: boolean;
  swappedEth?: number;
  gotUsdc?: number;
  depositedUsdc?: number;
  log?: { t: number; what: string; amount: number; tx: string }[];
}
const FILE = "hyperliquid-fund.json";

export type Step =
  | { do: "swap"; eth: number; minUsdc: number; expectUsdc: number }
  | { do: "deposit"; usdc: number; test: boolean }
  | { do: "wait"; why: string }
  | { do: "nothing"; why: string };

export interface Look {
  eth: number;
  usdc: number;
  mid: number;
  quotePerEth: number | null;
}

/** What to do next, from what the wallet holds. Pure: no network, no clock. */
export function nextStep(look: Look, st: FundState): Step {
  if (st.pending) return { do: "wait", why: `a deposit of ${r2(st.pending.usdc)} USDC is on its way to Hyperliquid` };
  if (!(look.mid > 0)) return { do: "nothing", why: "no ETH price from Hyperliquid" };
  const keep = KEEP_GAS_USD / look.mid;
  const spare = look.eth - keep;
  if (spare * look.mid >= MIN_SWAP_USD) {
    if (!look.quotePerEth) return { do: "nothing", why: "no swap quote" };
    const gap = 1 - look.quotePerEth / look.mid;
    if (gap > MAX_PRICE_GAP) return { do: "nothing", why: `the swap pays ${(gap * 100).toFixed(2)}% under Hyperliquid's ETH price (limit ${MAX_PRICE_GAP * 100}%)` };
    const eth = r6(Math.floor(spare * 1e6) / 1e6);
    return { do: "swap", eth, expectUsdc: r2(eth * look.quotePerEth), minUsdc: r2(eth * look.mid * (1 - MAX_PRICE_GAP)) };
  }
  if (look.usdc >= MIN_DEPOSIT_USDC) {
    // the first deposit is a small test; when what is left after it would be too small to send, it all goes at once
    const test = !st.proven && look.usdc - TEST_USDC >= MIN_DEPOSIT_USDC;
    return { do: "deposit", usdc: test ? TEST_USDC : Math.floor(look.usdc * 100) / 100, test };
  }
  return { do: "nothing", why: look.eth * look.mid < KEEP_GAS_USD + MIN_SWAP_USD && look.usdc < MIN_DEPOSIT_USDC ? "nothing to move: the wallet holds only the gas reserve" : "too little to move" };
}

/** The checks that must all hold before anything is signed. Returns the problems found (empty = good). */
export async function check(c: Chain): Promise<string[]> {
  const bad: string[] = [];
  const id = await c.chainId();
  if (id !== ARBITRUM_CHAIN_ID) return [`the RPC is chain ${id}, not Arbitrum One (${ARBITRUM_CHAIN_ID})`];
  for (const [name, a] of [["WETH", WETH], ["USDC", USDC], ["swap router", SWAP_ROUTER], ["quoter", QUOTER], ["Hyperliquid bridge", HL_BRIDGE]] as const)
    if (!(await c.hasCode(a))) bad.push(`${name}: no contract at its address`);
  if (bad.length) return bad;
  const m = await c.usdcMeta();
  if (m.symbol !== "USDC" || m.decimals !== 6) bad.push(`USDC address answers ${m.symbol}/${m.decimals}`);
  const held = await c.usdc(HL_BRIDGE);
  if (!(held >= BRIDGE_MIN_USDC)) bad.push(`the bridge address holds only ${Math.round(held)} USDC: not the Hyperliquid bridge`);
  return bad;
}

export interface FundReport {
  dry: boolean;
  problems: string[];
  steps: string[];
  eth: number;
  usdc: number;
  hlUsd: number;
  done: boolean;
}

/** Has the pending deposit arrived? Clears it when Hyperliquid's balance rose by (nearly) its size. */
async function settle(c: Chain, st: FundState, steps: string[], waitMs: number): Promise<void> {
  const p = st.pending;
  if (!p) return;
  const until = Date.now() + waitMs;
  for (;;) {
    // a send that failed before it left (no transaction id, and the USDC is still in the wallet) is not on its way
    if (!p.tx && Date.now() - p.at > 120_000 && (await c.usdc(c.address)) >= p.walletUsdc - 0.01) {
      steps.push(`the ${r2(p.usdc)} USDC deposit never left the wallet; cleared`);
      delete st.pending;
      return;
    }
    const now = await c.hlValue(c.address);
    // either sign is enough: Hyperliquid's ledger lists the deposit, or the account is worth that much more
    const listed = await c.hlDeposited(c.address, p.at - 60_000).catch(() => 0);
    if (listed >= p.usdc - 0.01 || now - p.before >= p.usdc - 0.05) {
      st.proven = true;
      st.depositedUsdc = r2((st.depositedUsdc ?? 0) + p.usdc);
      steps.push(`Hyperliquid shows the ${r2(p.usdc)} USDC deposit (account ${r2(now)} USD)`);
      delete st.pending;
      return;
    }
    if (Date.now() >= until) {
      steps.push(`the ${r2(p.usdc)} USDC deposit is not on Hyperliquid yet; nothing more is sent until it is (run again later)`);
      return;
    }
    await c.sleep(15_000);
  }
}

/**
 * One run. Dry (the default) reads, checks and says what it would do. With go it does it: swap, test deposit, wait
 * for Hyperliquid to show it, the rest. Safe to run again at any point: it picks up from what the wallet holds.
 */
export async function fund(c: Chain, opt: { go: boolean; waitMs?: number } = { go: false }): Promise<FundReport> {
  const st = loadJson<FundState>(FILE, {});
  const steps: string[] = [];
  const save = () => saveJson(FILE, st);
  const note = (what: string, amount: number, tx: string) => (st.log = [...(st.log ?? []), { t: Date.now(), what, amount, tx }].slice(-50));
  const problems = await check(c);
  const read = async () => ({ eth: await c.eth(c.address), usdc: await c.usdc(c.address), hlUsd: await c.hlValue(c.address) });
  let w = await read();
  const out = (done: boolean): FundReport => ({ dry: !opt.go, problems, steps, eth: r6(w.eth), usdc: r2(w.usdc), hlUsd: r2(w.hlUsd), done });
  if (problems.length) return out(false);

  for (let i = 0; i < 6; i++) {
    if (st.pending) {
      await settle(c, st, steps, opt.go ? opt.waitMs ?? CREDIT_WAIT_MS : 0);
      save();
      if (st.pending) return out(false);
    }
    w = await read();
    const mid = await c.hlEthMid();
    const spare = w.eth - KEEP_GAS_USD / mid;
    const quotePerEth = spare * mid >= MIN_SWAP_USD ? (await c.quote(spare)) / spare : null;
    const step = nextStep({ eth: w.eth, usdc: w.usdc, mid, quotePerEth }, st);
    if (step.do === "nothing" || step.do === "wait") {
      steps.push(step.why);
      return out(step.do === "nothing" && !!st.proven);
    }
    if (step.do === "swap") {
      steps.push(`${opt.go ? "swap" : "would swap"} ${step.eth} ETH for about ${step.expectUsdc} USDC (floor ${step.minUsdc}), keeping ${r6(w.eth - step.eth)} ETH for gas`);
      if (!opt.go) {
        // a dry run carries on as if the swap had paid its quote, to show the deposit steps too
        const usdc = w.usdc + step.expectUsdc;
        const d = nextStep({ eth: w.eth - step.eth, usdc, mid, quotePerEth: null }, st);
        if (d.do === "deposit") steps.push(d.test ? `would deposit ${d.usdc} USDC as a test, wait for Hyperliquid to show it, then deposit the other ${r2(usdc - d.usdc)}` : `would deposit ${d.usdc} USDC`);
        return out(false);
      }
      const before = w.usdc;
      const tx = await c.swap(step.eth, step.minUsdc);
      w = await read();
      st.swappedEth = r6((st.swappedEth ?? 0) + step.eth);
      st.gotUsdc = r2((st.gotUsdc ?? 0) + (w.usdc - before));
      note("swap", step.eth, tx);
      save();
      steps.push(`swapped: got ${r2(w.usdc - before)} USDC`);
      continue;
    }
    steps.push(`${opt.go ? "deposit" : "would deposit"} ${step.usdc} USDC to Hyperliquid${step.test ? " (test first)" : ""}`);
    if (!opt.go) return out(false);
    // the mark goes down BEFORE the send: a crash between the two can never lead to a second send
    st.pending = { usdc: step.usdc, before: w.hlUsd, walletUsdc: w.usdc, at: Date.now(), tx: "", test: step.test };
    save();
    const tx = await c.deposit(step.usdc);
    st.pending.tx = tx;
    note(step.test ? "test deposit" : "deposit", step.usdc, tx);
    save();
  }
  return out(false);
}

// ---- the real chain ---------------------------------------------------------------------------------------------------
const erc20 = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const quoter = new Interface([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const router = new Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

async function hlInfo<T>(body: unknown, fetcher: typeof fetch): Promise<T> {
  const res = await fetcher(`${HL_API}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`hyperliquid info http ${res.status}`);
  return (await res.json()) as T;
}

/** The real thing: Arbitrum through a JSON-RPC, Hyperliquid through its public API. `address` only reads; the key is touched by swap and deposit alone. */
export function realChain(address: string, fetcher: typeof fetch = fetch): Chain {
  const provider = new StaticJsonRpcProvider(ARBITRUM_RPC, ARBITRUM_CHAIN_ID);
  const call = async (to: string, data: string) => provider.call({ to, data });
  const send = async (tx: { to: string; data: string; value?: BigNumber }): Promise<string> => {
    const signer = hlWallet().connect(provider);
    if (signer.address.toLowerCase() !== address.toLowerCase()) throw new Error("the wallet key is not for this address");
    const sent = await signer.sendTransaction(tx);
    const rec = await sent.wait(1);
    if (rec.status !== 1) throw new Error(`transaction failed on chain: ${sent.hash}`);
    return sent.hash;
  };
  return {
    address,
    chainId: async () => Number(await provider.send("eth_chainId", [])),
    hasCode: async (a) => (await provider.getCode(a)).length > 2,
    usdcMeta: async () => ({
      symbol: String(erc20.decodeFunctionResult("symbol", await call(USDC, erc20.encodeFunctionData("symbol")))[0]),
      decimals: Number(erc20.decodeFunctionResult("decimals", await call(USDC, erc20.encodeFunctionData("decimals")))[0]),
    }),
    eth: async (a) => Number(formatUnits(await provider.getBalance(a), 18)),
    usdc: async (a) => Number(formatUnits(erc20.decodeFunctionResult("balanceOf", await call(USDC, erc20.encodeFunctionData("balanceOf", [a])))[0] as BigNumber, 6)),
    quote: async (eth) => {
      const data = quoter.encodeFunctionData("quoteExactInputSingle", [{ tokenIn: WETH, tokenOut: USDC, amountIn: parseUnits(eth.toFixed(6), 18), fee: POOL_FEE, sqrtPriceLimitX96: 0 }]);
      return Number(formatUnits(quoter.decodeFunctionResult("quoteExactInputSingle", await call(QUOTER, data))[0] as BigNumber, 6));
    },
    hlEthMid: async () => Number((await hlInfo<Record<string, string>>({ type: "allMids" }, fetcher)).ETH),
    hlValue: async (a) => {
      const perp = await hlInfo<{ marginSummary?: { accountValue?: string } }>({ type: "clearinghouseState", user: a }, fetcher);
      const spot = await hlInfo<{ balances?: { coin: string; total: string }[] }>({ type: "spotClearinghouseState", user: a }, fetcher);
      const v = Number(perp.marginSummary?.accountValue ?? 0) + Number(spot.balances?.find((b) => b.coin === "USDC")?.total ?? 0);
      if (!Number.isFinite(v)) throw new Error("hyperliquid: no account value");
      return v;
    },
    hlDeposited: async (a, sinceMs) => {
      const rows = await hlInfo<{ time: number; delta?: { type?: string; usdc?: string } }[]>({ type: "userNonFundingLedgerUpdates", user: a, startTime: Math.floor(sinceMs) }, fetcher);
      return rows.filter((r) => r.delta?.type === "deposit" && r.time >= sinceMs).reduce((s, r) => s + Number(r.delta?.usdc ?? 0), 0);
    },
    swap: (eth, minUsdc) => {
      const amountIn = parseUnits(eth.toFixed(6), 18);
      const data = router.encodeFunctionData("exactInputSingle", [{ tokenIn: WETH, tokenOut: USDC, fee: POOL_FEE, recipient: address, amountIn, amountOutMinimum: parseUnits(minUsdc.toFixed(2), 6), sqrtPriceLimitX96: 0 }]);
      return send({ to: SWAP_ROUTER, data, value: amountIn });
    },
    deposit: (usdc) => send({ to: USDC, data: erc20.encodeFunctionData("transfer", [HL_BRIDGE, parseUnits(usdc.toFixed(2), 6)]) }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
