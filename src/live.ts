/**
 * Real orders on Polymarket, driven by one paper variant. OFF unless data/live.json says otherwise.
 *
 * data/live.json (not in git; create it by hand on the Mac):
 *   { "mode": "off" | "dry" | "live", "variant": "band80-30", "size": 5, "maxLossPerDay": 25, "funder": "0x..." }
 *   - off:  nothing happens (the default when the file is missing).
 *   - dry:  signs the order and logs what it would send, posts nothing.
 *   - live: posts a fill-and-kill buy for `size` dollars whenever `variant` takes a paper trade.
 *   - funder: the Polymarket deposit (proxy) wallet that holds the USDC; orders are signed by the key below.
 *   The file is re-read before every order, so changing "mode" to "off" is the kill switch.
 *
 * data/polygon-keys.json (not in git; the same file Afterclose used):
 *   { "wallet": "<private key hex>", "address": "0x..." }
 *
 * Trades go to data/live/<day>.jsonl and are settled with the window like paper trades.
 */
import { Wallet } from "@ethersproject/wallet";
import { AssetType, Chain, ClobClient, OrderType, Side, type ApiKeyCreds } from "@polymarket/clob-client-v2";
import type { PaperTrade } from "./paperlive.js";
import type { Market } from "./polymarket.js";
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
};

const HOST = "https://clob.polymarket.com";
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
  private client: ClobClient | null = null;
  private signer: Wallet | null = null;
  private creds: ApiKeyCreds | null = null;
  private starting: Promise<void> | null = null;

  constructor() {
    const totals = loadJson<LiveTrade[]>("live-totals.json", []);
    for (const t of totals) this.count(t);
    this.recent = [...totals.slice(-30).reverse(), ...this.open];
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
      const bal = await this.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      this.balance = Number(bal.balance) / 1e6;
      saveJson("live-state.json", { at: Date.now(), ...this.status() });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
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
    const limit = Math.min(cap, Math.round((trade.ask + 0.02) * 100) / 100);
    const row: LiveTrade = {
      window: trade.window,
      t: Date.now(),
      left: trade.left,
      variant: trade.variant,
      side: trade.side,
      token,
      ask: trade.ask,
      limit,
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
        row.error = res?.success ? null : (res?.errorMsg || "order rejected");
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
      recent: this.recent.slice(0, 20),
    };
  }
}
