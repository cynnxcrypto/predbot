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
import { formatUnits, parseUnits } from "@ethersproject/units";
import { loadJson, saveJson } from "../store.js";
import { bridgeHoldsHyperliquid, loadBridge } from "../bridge/state.js";
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
  /** a second ETH price that needs only the Arbitrum RPC (Chainlink's ETH / USD feed), for when Hyperliquid cannot be reached */
  refPrice(): Promise<number>;
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
  /** ETH held at the end of the last run, and every rise of it since, in dollars at the time: what enrique sent (the bot
   * only ever spends ETH). The dashboard books a rise of this as a deposit, never as a gain. */
  lastEth?: number;
  ethInUsd?: number;
  /** USDC on Arbitrum at the end of the last run, and when (25 Nov 2026: enrique sent USDC, not ETH, and the $56.23 read
   * as a gain). A rise not explained by a bridge move into the wallet is his money: added to ethInUsd (the money-in
   * total the dashboard books as deposits). */
  lastUsdc?: number;
  lastUsdcAt?: number;
  usdcInUsd?: number;
  log?: { t: number; what: string; amount: number; tx: string }[];
}
const FILE = "hyperliquid-fund.json";

/** What the funding has done so far, for the public status: amounts and times, no address, no transaction id. */
export function fundHistory() {
  const st = loadJson<FundState>(FILE, {});
  return {
    ethReceivedUsd: st.ethInUsd ?? 0,
    swappedEth: st.swappedEth ?? 0,
    gotUsdc: st.gotUsdc ?? 0,
    /** USDC that Hyperliquid has shown arriving (every deposit is counted here only once it was seen there) */
    depositedUsdcSeenOnHyperliquid: st.depositedUsdc ?? 0,
    testDepositSeen: !!st.proven,
    /** a deposit sent and not yet seen on Hyperliquid (null = none in transit) */
    inTransit: st.pending ? { usdc: st.pending.usdc, sentAt: st.pending.at, test: st.pending.test, sent: !!st.pending.tx } : null,
    steps: (st.log ?? []).map((x) => ({ t: x.t, what: x.what, amount: x.amount })),
  };
}

const NO_HL = "Hyperliquid cannot be reached from the server right now: the swap is priced against Chainlink's ETH price; a deposit waits until Hyperliquid answers";

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
  /** null = Hyperliquid could not be reached at this look */
  hlUsd: number | null;
  /** the ETH price when read (Hyperliquid's, else Chainlink's; 0 = not read), for the dashboard's worth of the ETH held */
  ethUsd?: number;
  /** USDC sent to Hyperliquid and not shown there yet: still the wallet's money */
  inTransitUsdc?: number;
  /** every dollar of ETH that ever arrived (see FundState.ethInUsd) */
  ethInUsd?: number;
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
    const now = await c.hlValue(c.address).catch(() => null);
    if (now === null) {
      steps.push(`Hyperliquid cannot be reached, so the ${r2(p.usdc)} USDC deposit cannot be confirmed yet; nothing more is sent until it is`);
      return;
    }
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
/** USDC that bridge moves into Hyperliquid's wallet brought since `since` (they land as USDC on Arbitrum). */
function bridgeArrivals(since: number): number {
  try {
    return Object.values(loadBridge().moves)
      .filter((m) => m.to === "hyperliquid" && m.stage === "done" && (m.endedAt ?? 0) >= since)
      .reduce((a, m) => a + (m.arrived || 0), 0);
  } catch {
    return 0;
  }
}
/**
 * USDC that came into the Arbitrum wallet from outside since the last run: the rise over the last reading, less what our
 * own bridge moves brought. Nothing while a bridge move uses the wallet (its money comes and goes), nothing on the
 * first reading (no baseline), and nothing under $1. Pure.
 */
export function usdcIn(st: { lastUsdc?: number }, usdc: number, bridged: number, bridgeBusy: boolean): number {
  if (bridgeBusy || st.lastUsdc == null) return 0;
  const rise = usdc - st.lastUsdc - bridged;
  return rise >= 1 ? r2(rise) : 0;
}
export async function fund(c: Chain, opt: { go: boolean; waitMs?: number; stage?: (s: string) => void } = { go: false }): Promise<FundReport> {
  const at = (s: string) => opt.stage?.(s);
  at("checking the chain and the contracts");
  const st = loadJson<FundState>(FILE, {});
  const steps: string[] = [];
  const save = () => saveJson(FILE, st);
  const note = (what: string, amount: number, tx: string) => (st.log = [...(st.log ?? []), { t: Date.now(), what, amount, tx }].slice(-50));
  const problems = await check(c);
  // Hyperliquid not answering must not stop the look: the swap needs only Arbitrum; a deposit waits until it answers
  const read = async () => ({ eth: await c.eth(c.address), usdc: await c.usdc(c.address), hlUsd: await c.hlValue(c.address).catch(() => null) });
  at("reading the wallet");
  let w = await read();
  at("reading the ETH price");
  const hl0 = await c.hlEthMid().catch(() => 0);
  const m0 = hl0 > 0 ? hl0 : await c.refPrice().catch(() => 0);
  const ethUsd = Number.isFinite(m0) && m0 > 0 ? m0 : 0;
  if (ethUsd && w.eth > (st.lastEth ?? 0) + 1e-9) st.ethInUsd = r2((st.ethInUsd ?? 0) + (w.eth - (st.lastEth ?? 0)) * ethUsd);
  const inUsdc = usdcIn(st, w.usdc, bridgeArrivals(st.lastUsdcAt ?? Date.now()), bridgeHoldsHyperliquid());
  if (inUsdc > 0) {
    st.usdcInUsd = r2((st.usdcInUsd ?? 0) + inUsdc);
    st.ethInUsd = r2((st.ethInUsd ?? 0) + inUsdc);
  }
  const out = (done: boolean): FundReport => {
    if (ethUsd) st.lastEth = w.eth;
    st.lastUsdc = w.usdc;
    st.lastUsdcAt = Date.now();
    save();
    return { dry: !opt.go, problems, steps, eth: r6(w.eth), usdc: r2(w.usdc), hlUsd: w.hlUsd === null ? null : r2(w.hlUsd), ethUsd: ethUsd ? r2(ethUsd) : 0, inTransitUsdc: r2(st.pending?.usdc ?? 0), ethInUsd: st.ethInUsd ?? 0, done };
  };
  if (problems.length) return out(false);
  // a bridge move is going through this wallet (src/bridge): USDC just taken out of Hyperliquid must not go straight back
  if (bridgeHoldsHyperliquid()) {
    steps.push("a bridge move is using this wallet: nothing is swapped or deposited until it ends");
    return out(false);
  }

  for (let i = 0; i < 6; i++) {
    if (st.pending) {
      await settle(c, st, steps, opt.go ? opt.waitMs ?? CREDIT_WAIT_MS : 0);
      save();
      if (st.pending) return out(false);
    }
    w = await read();
    at("pricing the swap");
    const hlMid = await c.hlEthMid().catch(() => 0);
    const mid = hlMid > 0 ? hlMid : await c.refPrice();
    if (!(hlMid > 0) && !steps.includes(NO_HL)) steps.push(NO_HL);
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
        if (d.do === "deposit" && w.hlUsd === null) steps.push("the deposit of the USDC would wait until Hyperliquid answers");
        else if (d.do === "deposit") steps.push(d.test ? `would deposit ${d.usdc} USDC as a test, wait for Hyperliquid to show it, then deposit the other ${r2(usdc - d.usdc)}` : `would deposit ${d.usdc} USDC`);
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
    if (w.hlUsd === null) {
      // without Hyperliquid's answer a deposit could not be confirmed: the USDC stays in the wallet
      steps.push(`${step.usdc} USDC ${step.test ? "(test first) " : ""}waits in the wallet: nothing is deposited while Hyperliquid cannot be reached`);
      return out(false);
    }
    steps.push(`${opt.go ? "deposit" : "would deposit"} ${step.usdc} USDC to Hyperliquid${step.test ? " (test first)" : ""}`);
    if (!opt.go) return out(false);
    // the mark goes down BEFORE the send: a crash between the two can never lead to a second send
    st.pending = { usdc: step.usdc, before: w.hlUsd ?? 0, walletUsdc: w.usdc, at: Date.now(), tx: "", test: step.test };
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
/** Chainlink's ETH / USD feed on Arbitrum One: checked by its own description before its price is believed */
export const CHAINLINK_ETH_USD = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612";
export const REF_MAX_AGE_S = 26 * 3600;
const feed = new Interface([
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);
const router = new Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

async function hlInfo<T>(body: unknown, fetcher: typeof fetch): Promise<T> {
  // two tries, 15 s each: one slow answer is not "unreachable"
  let last: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetcher(`${HL_API}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`hyperliquid info http ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** The real thing: Arbitrum through a JSON-RPC, Hyperliquid through its public API. `address` only reads; the key is touched by swap and deposit alone. */
/**
 * One JSON-RPC call to Arbitrum with plain fetch: 10 s, two tries, then an error that says which call. No library
 * network code is used for the chain (17 Nov 2026: a look through the ethers provider never came back on the server,
 * while the same RPC answered a plain fetch at once).
 */
export async function rpcCall<T>(method: string, params: unknown[], fetcher: typeof fetch = fetch, url = ARBITRUM_RPC): Promise<T> {
  let last = "";
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const j = (await res.json()) as { result?: T; error?: { message?: string } };
      if (j.error || j.result === undefined) return Promise.reject(new Error(`arbitrum ${method}: ${String(j.error?.message ?? "no result").slice(0, 80)}`));
      return j.result;
    } catch (e) {
      last = String((e as Error)?.message ?? e).slice(0, 80);
      if (last.startsWith("arbitrum ")) throw e; // the chain's own answer (a revert): asking again changes nothing
    }
  }
  throw new Error(`arbitrum ${method}: ${last}`);
}
export const RECEIPT_WAIT_MS = 90_000;

export function realChain(address: string, fetcher: typeof fetch = fetch): Chain {
  const rpc = <T>(method: string, params: unknown[]) => rpcCall<T>(method, params, fetcher);
  const call = (to: string, data: string) => rpc<string>("eth_call", [{ to, data }, "latest"]);
  const send = async (tx: { to: string; data: string; value?: BigNumber }): Promise<string> => {
    const signer = hlWallet();
    if (signer.address.toLowerCase() !== address.toLowerCase()) throw new Error("the wallet key is not for this address");
    const value = tx.value ?? BigNumber.from(0);
    const req = { from: address, to: tx.to, data: tx.data, value: value.toHexString().replace(/^0x0+(?=.)/, "0x") };
    // a transaction that would fail is found here, before anything is signed
    const gas = BigNumber.from(await rpc<string>("eth_estimateGas", [req])).mul(13).div(10);
    const gasPrice = BigNumber.from(await rpc<string>("eth_gasPrice", [])).mul(3).div(2);
    const nonce = Number(await rpc<string>("eth_getTransactionCount", [address, "pending"]));
    const raw = await signer.signTransaction({ to: tx.to, data: tx.data, value, nonce, gasLimit: gas, gasPrice, chainId: ARBITRUM_CHAIN_ID, type: 0 });
    const hash = await rpc<string>("eth_sendRawTransaction", [raw]);
    const until = Date.now() + RECEIPT_WAIT_MS;
    for (;;) {
      const rec = await rpc<{ status?: string } | null>("eth_getTransactionReceipt", [hash]).catch(() => null);
      if (rec) {
        if (rec.status !== "0x1") throw new Error(`transaction failed on chain: ${hash}`);
        return hash;
      }
      if (Date.now() > until) throw new Error(`transaction not confirmed after ${RECEIPT_WAIT_MS / 1000} s: ${hash}`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  };
  return {
    address,
    chainId: async () => Number(await rpc<string>("eth_chainId", [])),
    hasCode: async (a) => (await rpc<string>("eth_getCode", [a, "latest"])).length > 2,
    usdcMeta: async () => ({
      symbol: String(erc20.decodeFunctionResult("symbol", await call(USDC, erc20.encodeFunctionData("symbol")))[0]),
      decimals: Number(erc20.decodeFunctionResult("decimals", await call(USDC, erc20.encodeFunctionData("decimals")))[0]),
    }),
    eth: async (a) => Number(formatUnits(BigNumber.from(await rpc<string>("eth_getBalance", [a, "latest"])), 18)),
    usdc: async (a) => Number(formatUnits(erc20.decodeFunctionResult("balanceOf", await call(USDC, erc20.encodeFunctionData("balanceOf", [a])))[0] as BigNumber, 6)),
    quote: async (eth) => {
      const data = quoter.encodeFunctionData("quoteExactInputSingle", [{ tokenIn: WETH, tokenOut: USDC, amountIn: parseUnits(eth.toFixed(6), 18), fee: POOL_FEE, sqrtPriceLimitX96: 0 }]);
      return Number(formatUnits(quoter.decodeFunctionResult("quoteExactInputSingle", await call(QUOTER, data))[0] as BigNumber, 6));
    },
    refPrice: async () => {
      const text = String(feed.decodeFunctionResult("description", await call(CHAINLINK_ETH_USD, feed.encodeFunctionData("description")))[0]);
      const dec = Number(feed.decodeFunctionResult("decimals", await call(CHAINLINK_ETH_USD, feed.encodeFunctionData("decimals")))[0]);
      if (text !== "ETH / USD") throw new Error(`price feed answers "${text.slice(0, 20)}", not ETH / USD`);
      const r = feed.decodeFunctionResult("latestRoundData", await call(CHAINLINK_ETH_USD, feed.encodeFunctionData("latestRoundData")));
      const px = Number(formatUnits(r.answer as BigNumber, dec));
      if (!(px > 0) || Date.now() / 1000 - Number(r.updatedAt) > REF_MAX_AGE_S) throw new Error("price feed: no fresh ETH price");
      return px;
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
