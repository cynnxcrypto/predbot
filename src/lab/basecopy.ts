/**
 * PAPER ONLY (enrique, 19 Nov 2026 14:05 KST: "okay paper test it"): copies of mid and high cap spot traders on Base,
 * built like the Solana mid cap copy (src/solana/slow.ts). Nothing is signed or sent; no wallet of ours exists on Base.
 *
 * Coins: the same floor as Solana: CAP_MIN_USD+ market value, CAP_MIN_LIQ_USD+ in the pool, a pool CAP_MIN_AGE_D+ days
 * old, no dollar coins, wrapped coins or staked ETH. That floor is what keeps memecoin launches out.
 * Traders: money at stake (his rule of 17 Nov): only buys of SEE_USD+ are looked at, and a wallet is followed once its
 * usual buy is FOLLOW_BUY_USD+ over FOLLOW_BUYS+ buys and it is not a machine (many trades a day, or in and out within
 * minutes). The data is the public trade list of each coin's biggest pool, a day back on first sight.
 * Copies: a followed wallet buys -> we pretend to buy STAKE_USD at the price when WE see it (minutes later, never the
 * wallet's own price), not at all when that is CHASE_PCT above its price; out when the wallet sells or after
 * MAX_HOLD_H. COST of the stake is taken each way for pool fee and slip.
 */
export const CAP_MIN_USD = 20_000_000;
export const CAP_MIN_LIQ_USD = 200_000;
export const CAP_MIN_AGE_D = 30;
export const MAX_COINS = 30;
export const SEE_USD = 1000;
export const FOLLOW_BUY_USD = 2000;
export const FOLLOW_BUYS = 3;
export const BOT_TRADES_DAY = 30;
export const BOT_HOLD_MIN = 10;
export const STAKE_USD = 100;
export const COST = 0.005;
export const CHASE_PCT = 3;
export const MAX_HOLD_H = 72;
export const MAX_OPEN = 30;
/** a buy older than this when first seen is history: it counts for the wallet, it is not copied */
export const FRESH_MS = 45 * 60_000;
/** would go real: the Solana bar */
export const QUALIFY = { copies: 10 };

const NOT_COINS = /^(USDC|USDBC|USDT|DAI|USDS|SUSDS|USDE|SUSDE|EURC|EURS|GHO|CRVUSD|LUSD|FRAX|USD\+|USDZ|WETH|ETH|CBETH|CBBTC|WBTC|TBTC|LBTC|WSTETH|WEETH|RETH|EZETH|RSETH|WRSETH|OSETH|SUPEROETHB|BSDETH|MSETH|MSUSD|CBXRP|CBDOGE|CBLTC|CBADA)$/i;
const QUOTES = /^(WETH|USDC|USDBC|USDT|CBBTC)$/i;

export type Coin = { symbol: string; token: string; pool: string; mcapUsd: number; liqUsd: number; px: number; pxAt: number; fdvOnly?: boolean };
export type Trade = { tx: string; wallet: string; ms: number; buy: boolean; usd: number; px: number };
type Lot = { ms: number; usd: number; px: number };
export type Wallet = { buys: number[]; lots: Record<string, Lot[]>; trips: number; won: number; realisedUsd: number; holds: number[]; days: Record<string, number>; lastMs: number; balUsd?: number | null; balAt?: number };
export type Copy = { wallet: string; token: string; symbol: string; at: number; px: number; leaderPx: number };
export type Done = { wallet: string; symbol: string; at: number; closedAt: number; usd: number; why: "sold" | "time" };
export type BaseState = { startedAt?: number; coins: Record<string, Coin>; coinsAt?: number; wallets: Record<string, Wallet>; seen: Record<string, number>; open: Copy[]; done: Done[]; skipped?: { chase: number; full: number }; error?: string; calls?: number; limited?: number; roundAt?: number; coinNote?: string };

const num = (x: unknown) => {
  const n = x === null || x === undefined || x === "" ? NaN : Number(x);
  return Number.isFinite(n) ? n : null;
};
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** One page of the pool list (with its tokens) -> the coins on it that pass the floor, keyed by token address. */
export function readPools(answer: unknown, nowMs: number): Coin[] {
  const a = answer as { data?: unknown; included?: unknown } | null;
  if (!a || !Array.isArray(a.data)) return [];
  const sym = new Map<string, string>();
  for (const t of Array.isArray(a.included) ? (a.included as { id?: string; attributes?: { symbol?: string } }[]) : []) if (t?.id) sym.set(t.id, String(t.attributes?.symbol ?? ""));
  const out: Coin[] = [];
  for (const p of a.data as { attributes?: Record<string, unknown>; relationships?: Record<string, { data?: { id?: string } }> }[]) {
    const at = p?.attributes ?? {};
    const bid = String(p?.relationships?.base_token?.data?.id ?? "");
    const qid = String(p?.relationships?.quote_token?.data?.id ?? "");
    const symbol = sym.get(bid) ?? "";
    const pool = String(at.address ?? "").toLowerCase();
    const token = bid.replace(/^base_/, "").toLowerCase();
    const mc = num(at.market_cap_usd);
    const mcapUsd = mc ?? num(at.fdv_usd);
    const liqUsd = num(at.reserve_in_usd);
    const px = num(at.base_token_price_usd);
    const made = Date.parse(String(at.pool_created_at ?? ""));
    if (!/^0x[0-9a-f]{40}$/.test(pool) || !/^0x[0-9a-f]{40}$/.test(token) || !symbol || NOT_COINS.test(symbol) || !QUOTES.test(sym.get(qid) ?? "")) continue;
    if (mcapUsd === null || liqUsd === null || !px || !Number.isFinite(made)) continue;
    if (mcapUsd < CAP_MIN_USD || liqUsd < CAP_MIN_LIQ_USD || nowMs - made < CAP_MIN_AGE_D * 86_400_000) continue;
    // a "dollar" coin under another name
    if (Math.abs(px - 1) < 0.02 && /usd|eur|dollar/i.test(symbol)) continue;
    out.push({ symbol: symbol.slice(0, 12), token, pool, mcapUsd, liqUsd, px, pxAt: nowMs, ...(mc === null ? { fdvOnly: true } : {}) });
  }
  return out;
}

/** The coins to watch: one pool per coin (the deepest), the MAX_COINS with the deepest pools. */
export function chooseCoins(found: Coin[]): Record<string, Coin> {
  const best = new Map<string, Coin>();
  for (const c of found) if (!best.has(c.token) || c.liqUsd > (best.get(c.token) as Coin).liqUsd) best.set(c.token, c);
  return Object.fromEntries([...best.values()].sort((a, b) => b.liqUsd - a.liqUsd).slice(0, MAX_COINS).map((c) => [c.token, c]));
}

/** A pool's public trade list -> its trades, oldest first. A buy is the pool's coin bought. */
export function readTrades(answer: unknown): Trade[] {
  const a = answer as { data?: unknown } | null;
  if (!a || !Array.isArray(a.data)) return [];
  const out: Trade[] = [];
  for (const r of a.data as { attributes?: Record<string, unknown> }[]) {
    const t = r?.attributes ?? {};
    const buy = t.kind === "buy";
    const ms = Date.parse(String(t.block_timestamp ?? ""));
    const usd = num(t.volume_in_usd);
    const px = num(buy ? t.price_to_in_usd : t.price_from_in_usd);
    const wallet = String(t.tx_from_address ?? "").toLowerCase();
    const tx = String(t.tx_hash ?? "");
    if ((t.kind !== "buy" && t.kind !== "sell") || !Number.isFinite(ms) || usd === null || !px || !/^0x[0-9a-f]{40}$/.test(wallet) || !tx) continue;
    out.push({ tx, wallet, ms, buy, usd, px });
  }
  return out.sort((x, y) => x.ms - y.ms);
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const tradesDay = (w: Wallet) => Math.max(0, ...Object.values(w.days));
export const isBot = (w: Wallet) => tradesDay(w) > BOT_TRADES_DAY || (w.holds.length >= 3 && median(w.holds) < BOT_HOLD_MIN);
export const usualBuy = (w: Wallet) => median(w.buys);
/** Followed on paper: money at stake and not a machine. */
export const followed = (w: Wallet) => w.buys.length >= FOLLOW_BUYS && usualBuy(w) >= FOLLOW_BUY_USD && !isBot(w);

/** A wallet's own record from a trade of SEE_USD+ (its lots are matched oldest first). */
function book(st: BaseState, token: string, t: Trade): Wallet {
  const w = (st.wallets[t.wallet] ??= { buys: [], lots: {}, trips: 0, won: 0, realisedUsd: 0, holds: [], days: {}, lastMs: 0 });
  w.lastMs = Math.max(w.lastMs, t.ms);
  w.days[dayKey(t.ms)] = (w.days[dayKey(t.ms)] ?? 0) + 1;
  const ks = Object.keys(w.days).sort();
  for (const k of ks.slice(0, Math.max(0, ks.length - 14))) delete w.days[k];
  if (t.buy) {
    w.buys.push(t.usd);
    if (w.buys.length > 60) w.buys.shift();
    (w.lots[token] ??= []).push({ ms: t.ms, usd: t.usd, px: t.px });
    return w;
  }
  let left = t.usd / t.px; // coins sold
  const lots = w.lots[token] ?? [];
  let cost = 0;
  let got = 0;
  let first: number | null = null;
  while (left > 1e-12 && lots.length) {
    const l = lots[0];
    const have = l.usd / l.px;
    const take = Math.min(have, left);
    cost += take * l.px;
    got += take * t.px;
    first ??= l.ms;
    left -= take;
    if (have - take <= have * 0.02) lots.shift();
    else l.usd = (have - take) * l.px;
  }
  if (!lots.length) delete w.lots[token];
  if (first !== null && cost > 0) {
    w.trips++;
    if (got > cost) w.won++;
    w.realisedUsd += got - cost;
    w.holds.push((t.ms - first) / 60_000);
    if (w.holds.length > 40) w.holds.shift();
  }
  return w;
}

const closeCopy = (st: BaseState, c: Copy, px: number, nowMs: number, why: Done["why"]) => {
  st.done.push({ wallet: c.wallet, symbol: c.symbol, at: c.at, closedAt: nowMs, usd: STAKE_USD * (px / c.px) * (1 - COST) - STAKE_USD * (1 + COST), why });
  st.open = st.open.filter((x) => x !== c);
  if (st.done.length > 600) st.done.splice(0, st.done.length - 600);
};

/** A coin's trade list as just read: wallets' own records, new copies, copies closed by a sale. */
export function take(st: BaseState, token: string, trades: Trade[], nowMs: number): void {
  const coin = st.coins[token];
  if (!coin) return;
  st.skipped ??= { chase: 0, full: 0 };
  const fresh = trades.filter((t) => !st.seen[t.tx + (t.buy ? "b" : "s") + t.wallet.slice(2, 8)]);
  if (trades.length) {
    const last = trades[trades.length - 1];
    if (last.ms >= coin.pxAt - 6 * 3_600_000) Object.assign(coin, { px: last.px, pxAt: Math.max(coin.pxAt, last.ms) });
  }
  for (const t of fresh) {
    st.seen[t.tx + (t.buy ? "b" : "s") + t.wallet.slice(2, 8)] = t.ms;
    if (t.usd < SEE_USD) continue;
    const was = st.wallets[t.wallet];
    const wasFollowed = !!was && followed(was);
    const w = book(st, token, t);
    if (nowMs - t.ms > FRESH_MS) continue;
    const mine = st.open.find((c) => c.wallet === t.wallet && c.token === token);
    if (!t.buy) {
      if (mine) closeCopy(st, mine, coin.px, nowMs, "sold");
      continue;
    }
    // copied only when the wallet was already followed before this buy: no copying a trade that made it pass
    if (!wasFollowed || isBot(w) || mine) continue;
    if (st.open.length >= MAX_OPEN) st.skipped.full++;
    else if (coin.px > t.px * (1 + CHASE_PCT / 100)) st.skipped.chase++;
    else {
      st.open.push({ wallet: t.wallet, token, symbol: coin.symbol, at: nowMs, px: coin.px, leaderPx: t.px });
      st.startedAt ??= nowMs;
    }
  }
}

/** Housekeeping after a round: copies held too long are closed, old sightings and idle wallets forgotten. */
export function sweep(st: BaseState, nowMs: number): void {
  for (const c of [...st.open]) {
    const coin = st.coins[c.token];
    if (nowMs - c.at >= MAX_HOLD_H * 3_600_000) closeCopy(st, c, coin?.px ?? c.px, nowMs, "time");
  }
  for (const [k, ms] of Object.entries(st.seen)) if (nowMs - ms > 36 * 3_600_000) delete st.seen[k];
  const held = new Set(st.open.map((c) => c.wallet));
  const ws = Object.entries(st.wallets);
  for (const [a, w] of ws) if (!held.has(a) && nowMs - w.lastMs > 21 * 86_400_000) delete st.wallets[a];
  if (ws.length > 4000) for (const [a] of ws.filter(([a2, w]) => !held.has(a2) && !followed(w)).sort((x, y) => x[1].lastMs - y[1].lastMs).slice(0, ws.length - 4000)) delete st.wallets[a];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
export function summary(st: BaseState, nowMs: number) {
  const per = new Map<string, { n: number; won: number; usd: number }>();
  for (const d of st.done) {
    const p = per.get(d.wallet) ?? { n: 0, won: 0, usd: 0 };
    p.n++;
    if (d.usd > 0) p.won++;
    p.usd += d.usd;
    per.set(d.wallet, p);
  }
  const fol = Object.entries(st.wallets).filter(([, w]) => followed(w));
  const wallets = fol
    .map(([a, w]) => {
      const p = per.get(a) ?? { n: 0, won: 0, usd: 0 };
      return { id: a.slice(2, 8), usualBuyUsd: Math.round(usualBuy(w)), buys: w.buys.length, ownTrips: w.trips, ownWon: w.won, ownUsd: Math.round(w.realisedUsd), balUsd: w.balUsd ?? null, copies: p.n, won: p.won, usd: r2(p.usd), open: st.open.filter((c) => c.wallet === a).length, pass: p.n >= QUALIFY.copies && p.won * 2 >= p.n && p.usd > 0 };
    })
    .sort((x, y) => Number(y.pass) - Number(x.pass) || y.usd - x.usd || y.usualBuyUsd - x.usualBuyUsd);
  const opens = st.open.map((c) => {
    const now = st.coins[c.token]?.px ?? c.px;
    return { coin: c.symbol, sub: c.wallet.slice(2, 8), t: c.at, paid: STAKE_USD, usd: r2(STAKE_USD * (now / c.px) * (1 - COST) - STAKE_USD * (1 + COST)), held: Math.round((nowMs - c.at) / 60_000) };
  });
  const usd = st.done.reduce((s, d) => s + d.usd, 0);
  return {
    paper: true,
    startedAt: st.startedAt ?? null,
    stakeUsd: STAKE_USD,
    floors: { mcapUsd: CAP_MIN_USD, liqUsd: CAP_MIN_LIQ_USD, ageD: CAP_MIN_AGE_D, seeUsd: SEE_USD, usualBuyUsd: FOLLOW_BUY_USD },
    coins: Object.values(st.coins).sort((a, b) => b.mcapUsd - a.mcapUsd).map((c) => ({ coin: c.symbol, mcapUsd: Math.round(c.mcapUsd), liqUsd: Math.round(c.liqUsd), ...(c.fdvOnly ? { fdvOnly: true } : {}) })),
    coinsAt: st.coinsAt ?? null,
    walletsSeen: Object.keys(st.wallets).length,
    followed: fol.length,
    passing: wallets.filter((w) => w.pass).length,
    closed: st.done.length,
    won: st.done.filter((d) => d.usd > 0).length,
    usd: r2(usd),
    openUsd: r2(opens.reduce((s, o) => s + o.usd, 0)),
    opens,
    wallets: wallets.slice(0, 40),
    log: st.done.slice(-40).reverse().map((d) => ({ coin: d.symbol, sub: d.wallet.slice(2, 8) + (d.why === "time" ? " · 72 h" : ""), t: d.closedAt, usd: r2(d.usd), held: Math.round((d.closedAt - d.at) / 60_000) })),
    skipped: st.skipped ?? { chase: 0, full: 0 },
    calls: st.calls ?? 0,
    limited: st.limited ?? 0,
    roundAt: st.roundAt ?? null,
    error: st.error ?? null,
    note: st.coinNote ?? null,
  };
}
