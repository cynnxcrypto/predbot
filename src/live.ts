/**
 * Real orders on Polymarket, driven by one paper variant. OFF unless data/live.json says otherwise.
 *
 * data/live.json (not in git; create it by hand on the Mac):
 *   { "mode": "off" | "dry" | "live", "variant": "band80-30", "size": 5, "maxLossPerDay": 25, "funder": "0x..." }
 *   - off:  nothing happens (the default when the file is missing).
 *   - dry:  signs the order and logs what it would send, posts nothing.
 *   - live: posts a fill-and-kill buy for `size` dollars, up to the variant's cap, whenever `variant` takes a paper
 *     trade and the ask has not fallen since (see onPaperTrade).
 *   - funder: the Polymarket deposit (proxy) wallet that holds the USDC; orders are signed by the key below.
 *   The file is re-read before every order, so changing "mode" to "off" is the kill switch.
 *
 * data/polygon-keys.json (not in git; the same file Afterclose used):
 *   { "wallet": "<private key hex>", "address": "0x..." }
 *
 * data/polygon-builder.json (not in git; the same file Afterclose used): { "key", "secret", "passphrase" }
 *   Polymarket relayer credentials. Winning shares do not turn back into pUSD by themselves: after a win the
 *   trader asks the relayer to run redeemPositions on the conditional-token contract from the deposit wallet
 *   (gasless, signed by the key above). Without this file wins stay as shares until claimed on polymarket.com.
 *
 * Trades go to data/live/<day>.jsonl and are settled with the window like paper trades.
 */
import { Interface } from "@ethersproject/abi";
import { StaticJsonRpcProvider } from "@ethersproject/providers";
import { Wallet } from "@ethersproject/wallet";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { AssetType, Chain, ClobClient, OrderType, Side, type ApiKeyCreds } from "@polymarket/clob-client-v2";
import type { PaperTrade } from "./paperlive.js";
import { book, marketFor, type Market } from "./polymarket.js";
import { append, loadJson, saveJson } from "./store.js";

export type LiveMode = "off" | "dry" | "live";
export type LiveConfig = { mode: LiveMode; variant: string; size: number; maxLossPerDay: number; funder: string };

export type LiveTrade = {
  window: number;
  t: number;
  left: number;
  variant: string;
  side: "UP" | "DOWN";
  token: string;
  /** Ask seen on the paper snapshot. */
  ask: number;
  /** Worst price the order was allowed to pay. */
  limit: number;
  /** Best ask on a fresh look at the book just before sending (null when that look failed). */
  freshAsk?: number | null;
  dry: boolean;
  ok: boolean;
  orderId: string | null;
  status: string | null;
  error: string | null;
  /** Dollars actually paid (makingAmount), shares actually received (takingAmount). */
  cost: number;
  shares: number;
  resolvedUp: boolean | null;
  won: boolean | null;
  pnl: number | null;
  /** Transaction that turned the winning shares back into pUSD, once it went through. */
  redeemTx?: string | null;
  redeemedAt?: number | null;
};

/** A win whose shares still have to be turned back into pUSD. */
export type Redeem = { window: number; shares: number; tries: number; nextAt: number; lastError: string | null };

const HOST = "https://clob.polymarket.com";
const RELAYER = "https://relayer-v2.polymarket.com";
/** The relayer client wants a signer with a chain connection, even though the relayer pays the gas. */
const RPC = "https://polygon-bor-rpc.publicnode.com";
/** Polymarket's conditional-token contract on Polygon and the collaterals its markets have used. */
const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const COLLATERALS = ["0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"];
const ZERO32 = `0x${"0".repeat(64)}`;
const TOKEN_NAMES = ["pUSD", "USDC.e", "USDC"];
const USDC_E = COLLATERALS[1];
/** Polymarket's CollateralOnramp: converts USDC.e into pUSD 1:1 (claimed winnings come out of the CTF as USDC.e). */
const ONRAMP = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
const erc20 = new Interface(["function balanceOf(address owner) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)"]);
const onrampAbi = new Interface(["function wrap(address _asset, address _to, uint256 _amount)"]);
const provider = new StaticJsonRpcProvider(RPC, 137);
const ctfAbi = new Interface(["function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)"]);
const DEFAULT: LiveConfig = { mode: "off", variant: "band80-30", size: 5, maxLossPerDay: 25, funder: "" };

export function liveConfig(): LiveConfig {
  const raw = loadJson<Partial<LiveConfig>>("live.json", {});
  const mode: LiveMode = raw.mode === "live" || raw.mode === "dry" ? raw.mode : "off";
  const size = Number(raw.size ?? DEFAULT.size);
  const maxLossPerDay = Number(raw.maxLossPerDay ?? DEFAULT.maxLossPerDay);
  return {
    mode,
    variant: String(raw.variant ?? DEFAULT.variant),
    size: Number.isFinite(size) && size > 0 ? Math.min(size, 50) : DEFAULT.size,
    maxLossPerDay: Number.isFinite(maxLossPerDay) && maxLossPerDay > 0 ? maxLossPerDay : DEFAULT.maxLossPerDay,
    funder: String(raw.funder ?? "").trim(),
  };
}

export class LiveTrader {
  config = liveConfig();
  open: LiveTrade[] = loadJson<LiveTrade[]>("live-open.json", []);
  trades = 0;
  won = 0;
  net = 0;
  todayNet = 0;
  todayKey = "";
  lastError: string | null = null;
  lastOrderAt: number | null = null;
  wallet: string | null = null;
  balance: number | null = null;
  ready = false;
  /** The last real orders, newest first, for the status page (settled, open and failed). */
  recent: LiveTrade[] = [];
  /** Wins waiting to be turned back into pUSD. */
  redeems: Redeem[] = loadJson<Redeem[]>("live-redeem.json", []);
  lastRedeem: { window: number; tx: string | null; at: number; error: string | null } | null = null;
  /** What the funds wallet holds on chain, by token, read straight from Polygon. */
  chain: Record<string, number> | null = null;
  lastWrap: { amount: number; tx: string | null; at: number; error: string | null } | null = null;
  private wrapping = false;
  private client: ClobClient | null = null;
  private signer: Wallet | null = null;
  private creds: ApiKeyCreds | null = null;
  private starting: Promise<void> | null = null;
  private redeeming = false;

  constructor() {
    const totals = loadJson<LiveTrade[]>("live-totals.json", []);
    for (const t of totals) this.count(t);
    this.recent = [...totals.slice(-30).reverse(), ...this.open];
    // Wins from before the claim step existed (or from a crash) are still shares: queue them too.
    const cutoff = Date.now() / 1000 - 3 * 86400;
    for (const t of totals) {
      if (t.won && !t.dry && t.shares > 0 && !t.redeemTx && t.window > cutoff && !this.redeems.some((r) => r.window === t.window)) {
        this.redeems.push({ window: t.window, shares: t.shares, tries: 0, nextAt: 0, lastError: null });
      }
    }
    if (this.redeems.length) saveJson("live-redeem.json", this.redeems);
  }

  private remember(row: LiveTrade) {
    this.recent = [row, ...this.recent.filter((t) => t !== row)].slice(0, 40);
  }

  private count(t: LiveTrade) {
    if (t.dry || t.pnl == null) return;
    this.trades += 1;
    if (t.won) this.won += 1;
    this.net += t.pnl;
    const day = new Date(t.window * 1000).toISOString().slice(0, 10);
    if (day !== this.todayKey) {
      this.todayKey = day;
      this.todayNet = 0;
    }
    this.todayNet += t.pnl;
  }

  private todayLoss() {
    const day = new Date().toISOString().slice(0, 10);
    return day === this.todayKey ? -this.todayNet : 0;
  }

  /** Load keys, derive API credentials, read the balance. Safe to call many times. */
  async start(): Promise<void> {
    this.config = liveConfig();
    if (this.config.mode === "off") return;
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        const keys = loadJson<{ wallet?: string; address?: string }>("polygon-keys.json", {});
        const pk = String(keys.wallet ?? "").trim();
        if (!pk) throw new Error("data/polygon-keys.json has no wallet key");
        if (!this.config.funder) throw new Error("data/live.json has no funder address");
        const signer = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
        const base = new ClobClient({ host: HOST, chain: Chain.POLYGON, signer, signatureType: 3, funderAddress: this.config.funder });
        const creds = await base.createOrDeriveApiKey();
        const client = new ClobClient({ host: HOST, chain: Chain.POLYGON, signer, creds, signatureType: 3, funderAddress: this.config.funder });
        const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        this.balance = Number(bal.balance) / 1e6;
        this.signer = signer;
        this.creds = creds;
        this.client = client;
        this.wallet = signer.address;
        this.ready = true;
        this.lastError = null;
        saveJson("live-state.json", { at: Date.now(), ...this.status() });
        console.log(`live: ${this.config.mode.toUpperCase()} mode, signer ${signer.address}, funder ${this.config.funder}, balance $${this.balance.toFixed(2)}, ${this.config.variant} at $${this.config.size} per window, stop after -$${this.config.maxLossPerDay} in a day`);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        saveJson("live-state.json", { at: Date.now(), ...this.status() });
        console.log(`live: not ready (${this.lastError})`);
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  /** Re-read the collateral balance (called about once a minute by the recorder). */
  async refreshBalance() {
    this.config = liveConfig();
    if (this.config.mode === "off") return;
    if (!this.ready) return this.start();
    if (!this.client) return;
    try {
      // The exchange caches balances; ask it to look again before reading.
      await this.client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL }).catch(() => undefined);
      const bal = await this.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      this.balance = Number(bal.balance) / 1e6;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    try {
      const data = erc20.encodeFunctionData("balanceOf", [this.config.funder]);
      const raw = await Promise.all(COLLATERALS.map((token) => provider.call({ to: token, data })));
      const chain: Record<string, number> = {};
      raw.forEach((hex, i) => { chain[TOKEN_NAMES[i]] = Number(BigInt(hex)) / 1e6; });
      this.chain = chain;
    } catch {
      // chain read is best effort
    }
    saveJson("live-state.json", { at: Date.now(), ...this.status() });
  }

  /** Called when a paper variant takes a trade. Mirrors it for real when that variant is the live one. */
  async onPaperTrade(trade: PaperTrade, market: Market, cap: number) {
    this.config = liveConfig();
    if (this.config.mode === "off" || trade.variant !== this.config.variant) return;
    if (this.open.some((t) => t.window === trade.window)) return;
    if (this.todayLoss() >= this.config.maxLossPerDay) {
      if (this.lastError !== "daily loss limit reached") console.log(`live: daily loss limit reached (-$${this.todayLoss().toFixed(2)}), no more orders today`);
      this.lastError = "daily loss limit reached";
      return;
    }
    if (!this.ready) await this.start();
    if (!this.ready || !this.client) return;
    const token = trade.side === "UP" ? market.upToken : market.downToken;
    // Fill rule from the recorded books (62 paper windows, 16-19 Oct): the fill-or-kill at ask+2c filled the
    // windows where the ask had fallen since the snapshot (76% won) and missed the ones where it had jumped
    // (100% won). So take a fresh look at the book, skip when the ask fell by 1c or more (sub-cent dips are noise), and otherwise pay up to the cap.
    let freshAsk: number | null = null;
    try {
      freshAsk = (await book(token)).bestAsk;
    } catch {
      freshAsk = null;
    }
    const limit = cap;
    const row: LiveTrade = {
      window: trade.window,
      t: Date.now(),
      left: trade.left,
      variant: trade.variant,
      side: trade.side,
      token,
      ask: trade.ask,
      limit,
      freshAsk,
      dry: this.config.mode === "dry",
      ok: false,
      orderId: null,
      status: null,
      error: null,
      cost: 0,
      shares: 0,
      resolvedUp: null,
      won: null,
      pnl: null,
    };
    if (freshAsk != null && freshAsk <= trade.ask - 0.01 + 1e-9) {
      row.status = "skipped";
      row.error = `ask fell to ${Math.round(freshAsk * 100)}c`;
      console.log(`live: skipped ${trade.side}, ask fell from ${Math.round(trade.ask * 100)}c to ${Math.round(freshAsk * 100)}c`);
      this.remember(row);
      saveJson("live-state.json", { at: Date.now(), ...this.status(), lastTrade: row });
      append("live", row, trade.window * 1000);
      return;
    }
    try {
      const order = await this.client.createMarketOrder(
        { tokenID: token, amount: this.config.size, side: Side.BUY, price: limit, orderType: OrderType.FAK },
        { tickSize: "0.01", negRisk: false },
      );
      if (row.dry) {
        row.ok = true;
        row.status = "dry";
        console.log(`live DRY: would buy ${trade.side} up to ${Math.round(limit * 100)}c for $${this.config.size} with ${trade.left}s left (order signed, not sent)`);
      } else {
        const res = await this.client.postOrder(order, OrderType.FAK);
        row.ok = Boolean(res?.success);
        row.orderId = res?.orderID ?? null;
        row.status = res?.status ?? null;
        const detail = (res as unknown as { error?: unknown })?.error;
        row.error = res?.success ? null : (res?.errorMsg || (detail ? JSON.stringify(detail).slice(0, 200) : "order rejected"));
        row.cost = Number(res?.makingAmount) || 0;
        row.shares = Number(res?.takingAmount) || 0;
        this.lastOrderAt = Date.now();
        if (row.ok && row.shares > 0) {
          console.log(`live: bought ${row.shares.toFixed(2)} ${trade.side} for $${row.cost.toFixed(2)} (${Math.round((row.cost / row.shares) * 100)}c) with ${trade.left}s left`);
        } else {
          console.log(`live: order not filled (${row.error ?? row.status ?? "no fill"})`);
        }
      }
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
      this.lastError = row.error;
      console.log(`live: order failed (${row.error})`);
    }
    this.remember(row);
    saveJson("live-state.json", { at: Date.now(), ...this.status(), lastTrade: row });
    if (row.ok && (row.dry || row.shares > 0)) {
      this.open.push(row);
      saveJson("live-open.json", this.open);
    } else {
      append("live", row, trade.window * 1000);
    }
  }

  settle(window: number, resolvedUp: boolean) {
    const trade = this.open.find((t) => t.window === window);
    if (!trade) return;
    trade.resolvedUp = resolvedUp;
    trade.won = (trade.side === "UP") === resolvedUp;
    trade.pnl = trade.dry ? 0 : (trade.won ? trade.shares : 0) - trade.cost;
    this.open = this.open.filter((t) => t !== trade);
    this.count(trade);
    this.remember(trade);
    append("live", trade, window * 1000);
    const totals = loadJson<LiveTrade[]>("live-totals.json", []);
    totals.push(trade);
    saveJson("live-totals.json", totals);
    saveJson("live-open.json", this.open);
    if (!trade.dry) console.log(`live: ${trade.side} ${trade.won ? "won" : "lost"} ${trade.pnl >= 0 ? "+" : "-"}$${Math.abs(trade.pnl).toFixed(2)}; running ${this.won}/${this.trades}, net ${this.net >= 0 ? "+" : "-"}$${Math.abs(this.net).toFixed(2)}`);
    if (trade.won && !trade.dry && trade.shares > 0) {
      this.redeems.push({ window, shares: trade.shares, tries: 0, nextAt: Date.now() + 60000, lastError: null });
      saveJson("live-redeem.json", this.redeems);
    }
  }

  /** A relayer client that runs gasless transactions from the deposit wallet, signed by our key. */
  private relay() {
    const builder = loadJson<{ key?: string; secret?: string; passphrase?: string }>("polygon-builder.json", {});
    if (!builder.key || !builder.secret || !builder.passphrase) throw new Error("data/polygon-builder.json is missing; claim on polymarket.com instead");
    const keys = loadJson<{ wallet?: string }>("polygon-keys.json", {});
    const pk = String(keys.wallet ?? "").trim();
    if (!pk || !this.config.funder) throw new Error("keys or funder missing");
    const signer = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
    return new RelayClient(RELAYER, 137, signer, new BuilderConfig({ localBuilderCreds: { key: builder.key, secret: builder.secret, passphrase: builder.passphrase } }));
  }

  /**
   * Claimed winnings arrive as USDC.e, which the exchange does not trade with. Convert any USDC.e in the funds
   * wallet into pUSD through Polymarket's onramp (1:1). Called about once a minute, after the chain balances.
   */
  async wrapPending() {
    const usdce = this.chain?.["USDC.e"] ?? 0;
    if (this.wrapping || this.config.mode === "off" || usdce < 0.5) return;
    if (this.lastWrap && !this.lastWrap.tx && Date.now() - this.lastWrap.at < 300000) return;
    this.wrapping = true;
    const units = BigInt(Math.floor(usdce * 1e6));
    try {
      const relay = this.relay();
      const calls = [
        { target: USDC_E, value: "0", data: erc20.encodeFunctionData("approve", [ONRAMP, units]) },
        { target: ONRAMP, value: "0", data: onrampAbi.encodeFunctionData("wrap", [USDC_E, this.config.funder, units]) },
      ];
      const sent = await relay.executeDepositWalletBatch(calls, this.config.funder, String(Math.floor(Date.now() / 1000) + 600));
      const done = await sent.wait();
      const hash = done?.transactionHash || sent.transactionHash || null;
      if (!hash) throw new Error(`relayer did not confirm (state ${done?.state ?? sent.state ?? "unknown"})`);
      this.lastWrap = { amount: usdce, tx: hash, at: Date.now(), error: null };
      console.log(`live: converted $${usdce.toFixed(2)} of claimed winnings into pUSD (${hash})`);
      await this.refreshBalance();
    } catch (error) {
      this.lastWrap = { amount: usdce, tx: null, at: Date.now(), error: error instanceof Error ? error.message : String(error) };
      console.log(`live: converting winnings into pUSD failed (${this.lastWrap.error}), retrying later`);
    } finally {
      this.wrapping = false;
      saveJson("live-state.json", { at: Date.now(), ...this.status() });
    }
  }

  /**
   * Turn settled winning shares back into pUSD. Called about once a minute by the recorder.
   * One redeemPositions call per collateral Polymarket has used; the ones that do not match the market are
   * no-ops, so the batch is safe whichever collateral the market was created with.
   */
  async redeemPending() {
    if (this.redeeming || !this.redeems.length) return;
    const due = this.redeems.find((r) => r.nextAt <= Date.now());
    if (!due) return;
    this.redeeming = true;
    try {
      due.tries += 1;
      const market = await marketFor(due.window);
      if (!market?.conditionId) throw new Error("market has no condition id yet");
      const relay = this.relay();
      const calls = COLLATERALS.map((collateral) => ({
        target: CTF,
        value: "0",
        data: ctfAbi.encodeFunctionData("redeemPositions", [collateral, ZERO32, market.conditionId, [1, 2]]),
      }));
      const sent = await relay.executeDepositWalletBatch(calls, this.config.funder, String(Math.floor(Date.now() / 1000) + 600));
      const done = await sent.wait();
      const hash = done?.transactionHash || sent.transactionHash || null;
      if (!hash) throw new Error(`relayer did not confirm (state ${done?.state ?? sent.state ?? "unknown"})`);
      this.redeems = this.redeems.filter((r) => r !== due);
      this.lastRedeem = { window: due.window, tx: hash, at: Date.now(), error: null };
      const totals = loadJson<LiveTrade[]>("live-totals.json", []);
      for (const t of totals) if (t.window === due.window) { t.redeemTx = hash; t.redeemedAt = Date.now(); }
      saveJson("live-totals.json", totals);
      for (const t of this.recent) if (t.window === due.window) { t.redeemTx = hash; t.redeemedAt = Date.now(); }
      console.log(`live: claimed ${due.shares.toFixed(2)} shares from the ${new Date(due.window * 1000).toISOString().slice(11, 16)} window (${hash})`);
      await this.refreshBalance();
    } catch (error) {
      due.lastError = error instanceof Error ? error.message : String(error);
      due.nextAt = Date.now() + Math.min(600000, 60000 * due.tries);
      this.lastRedeem = { window: due.window, tx: null, at: Date.now(), error: due.lastError };
      if (due.tries >= 30) {
        this.redeems = this.redeems.filter((r) => r !== due);
        console.log(`live: giving up on claiming the ${new Date(due.window * 1000).toISOString().slice(11, 16)} window after 30 tries (${due.lastError}); claim it on polymarket.com`);
      } else if (due.tries <= 3 || due.tries % 5 === 0) {
        console.log(`live: claim not done yet (${due.lastError}), retrying`);
      }
    } finally {
      this.redeeming = false;
      saveJson("live-redeem.json", this.redeems);
      saveJson("live-state.json", { at: Date.now(), ...this.status() });
    }
  }

  abandon(window: number) {
    const before = this.open.length;
    this.open = this.open.filter((t) => t.window !== window);
    if (this.open.length !== before) saveJson("live-open.json", this.open);
  }

  status() {
    const c = this.config;
    return {
      mode: c.mode,
      variant: c.variant,
      size: c.size,
      maxLossPerDay: c.maxLossPerDay,
      ready: this.ready,
      wallet: this.wallet,
      funder: c.funder || null,
      balance: this.balance,
      trades: this.trades,
      won: this.won,
      net: Math.round(this.net * 100) / 100,
      todayNet: Math.round((this.todayKey === new Date().toISOString().slice(0, 10) ? this.todayNet : 0) * 100) / 100,
      open: this.open.length,
      lastError: this.lastError,
      lastOrderAt: this.lastOrderAt,
      chain: this.chain,
      pendingRedeems: this.redeems.length,
      lastWrap: this.lastWrap,
      lastRedeem: this.lastRedeem,
      recent: this.recent.slice(0, 20),
    };
  }
}
