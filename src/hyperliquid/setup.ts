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
import { loadJson, saveJson } from "../store.js";
import { ARBITRUM_CHAIN_ID, ARBITRUM_RPC, CREDIT_WAIT_MS, HL_API, fund, fundHistory, realChain, type Chain, type FundReport } from "./fund.js";
import { coinsOf, usdSend, post as hlPostApi } from "./exchange.js";
import { hlAgent, hlAgent2, hlAgent3, hlWallet, hlWallet2, hlWallet2Exists, hlWallet3 } from "./keys.js";
import { startRecon } from "./recon.js";
import { fileCfg, hlKeptTraders, hlLiveSummary, hlLiveTick, setHlDelayNote, setWalletAddrs, type HlDeps } from "./live.js";
import { HlTradeWatch } from "./watch.js";
import { hlHttpSummary } from "./ratelog.js";
import { realVenue } from "./venue.js";
import { hlPoke, hlQuickSummary, hlQuickTick, hlWatched, setHlFast, traderRule, hlBoard, hlHistoryAvgPct, hlHistoryMeetsBar, hlHistorySummary, hlProven, hlSkillPass, hlPaperOpens, likedTraders, perpMeetsBar, setExtraTraders, setKeptTraders, traderListed, traderRecord } from "../solana/buckets.js";
import { linkedTraders, startLinks } from "./links.js";

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
let lookStarted = 0;
/** what the looks did since this start, for the status: a look that never ends shows here, with the step it is at */
const looks = { started: 0, finished: 0, failed: 0, stage: "" };
const LAST = "hyperliquid-funding-last.json";
export const LOOK_MAX_MS = 90_000;

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

// ---- the second wallet (overlaps) ----------------------------------------------------------------------------------------
/** At most this much is ever moved to the second wallet by one switch. */
export const HARD_SECOND_FUND_USD = 100;
const SECOND = "hyperliquid-second.json";
interface SecondState {
  /** every fundOnce name ever tried, written BEFORE the money is sent: a name moves money once, whatever happens */
  funds: { id: string; usd: number; at: number; result: string }[];
}
/**
 * deploy/live-rules.json hyperliquid.trade.second: present = the second wallet and its trading key are made at start;
 * "fundOnce": { "id": "<a new name>", "usd": 50 } moves that much USDC to it from the first wallet, inside
 * Hyperliquid, once per name (10 to HARD_SECOND_FUND_USD).
 */
export function parseSecond(text: string): { wanted: boolean; fund: { id: string; usd: number } | null } {
  try {
    const s2 = (JSON.parse(text) as { hyperliquid?: { trade?: { second?: unknown } } }).hyperliquid?.trade?.second;
    if (!s2 || typeof s2 !== "object") return { wanted: false, fund: null };
    const f = (s2 as { fundOnce?: { id?: unknown; usd?: unknown } }).fundOnce;
    const ok = f && typeof f.id === "string" && /^[a-z0-9-]{1,40}$/.test(f.id) && typeof f.usd === "number" && f.usd >= 10 && f.usd <= HARD_SECOND_FUND_USD;
    return { wanted: true, fund: ok ? { id: f.id as string, usd: Math.round((f.usd as number) * 100) / 100 } : null };
  } catch {
    return { wanted: false, fund: null };
  }
}
const secondCfg = () => {
  try {
    return parseSecond(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8"));
  } catch {
    return { wanted: false, fund: null };
  }
};
let address2 = "";
let address3 = "";
/** the third wallet (26 Nov 2026, enrique: "yeah third wallet sounds good"): made when deploy/live-rules.json has
 *  hyperliquid.trade.third; its money comes from the cash moves between wallets (src/hyperliquid/live.ts) */
const thirdWanted = () => {
  try {
    const t = (JSON.parse(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8")) as { hyperliquid?: { trade?: { third?: unknown } } }).hyperliquid?.trade?.third;
    return !!t && typeof t === "object";
  } catch {
    return false;
  }
};
let secondBusy = false;
export interface SecondDeps {
  cfg(): { wanted: boolean; fund: { id: string; usd: number } | null };
  /** what the first wallet can take out of its Hyperliquid account now (free of positions) */
  free(): Promise<number>;
  send(usd: number): Promise<unknown>;
}
/** One look at the fundOnce switch. Never throws. Returns what it did, for the tests. */
export async function secondFundLook(d: SecondDeps, now = Date.now()): Promise<string> {
  if (secondBusy) return "busy";
  const want = d.cfg().fund;
  const st = loadJson<SecondState>(SECOND, { funds: [] });
  if (!want || st.funds.some((x) => x.id === want.id)) return "nothing to do";
  secondBusy = true;
  try {
    const free = await d.free().catch(() => null);
    // not enough free money, or not read: nothing is written, the name is tried again at the next look
    if (free === null || !Number.isFinite(free)) return "first wallet not read";
    if (free < want.usd + 5) return "not enough free money in the first wallet";
    const row = { id: want.id, usd: want.usd, at: now, result: "tried" };
    saveJson(SECOND, { funds: [...st.funds, row] });
    try {
      const a = (await d.send(want.usd)) as { status?: string; response?: unknown };
      row.result = a?.status === "ok" ? "sent" : `refused: ${(typeof a?.response === "string" ? a.response : "no ok from Hyperliquid").replace(/0x[0-9a-fA-F]{40,}/g, "…").slice(0, 120)}`;
    } catch (e) {
      row.result = `not known: ${short(e)}`;
    }
    saveJson(SECOND, { funds: [...st.funds, row] });
    return row.result;
  } finally {
    secondBusy = false;
  }
}
/** For the public status: no address. */
/** The second wallet's public address, for the password-protected dashboard only (never the public status). */
export const hlAddress2 = () => address2 || null;
export const hlAddress3 = () => address3 || null;
export const hlAddress1 = () => address || null;
export const secondPublic = () => ({ wallet: address2 ? "made" : hlWallet2Exists() ? "on disk" : "none", funds: loadJson<SecondState>(SECOND, { funds: [] }).funds });

/** One look at the wallet: a dry run of the funding, or the real thing when the repo file says go. Never throws. */
export async function fundLook(chain: Chain, mode: FundMode = fundMode()): Promise<void> {
  if (busy) return;
  busy = true;
  lookStarted = Date.now();
  looks.started++;
  looks.stage = "starting";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // a look that hangs (an RPC that never answers) is given up and reported, and the next look is free to run
    const limit = mode === "go" ? LOOK_MAX_MS + CREDIT_WAIT_MS : LOOK_MAX_MS;
    const late = new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error(`the look did not finish in ${limit / 1000} s`)), limit)));
    const run = fund(chain, { go: mode === "go", stage: (s) => void (looks.stage = s) });
    run.catch(() => undefined); // a look given up on may still fail later: that must never be an unhandled rejection (it would stop the bot)
    late.catch(() => undefined);
    const got = await Promise.race([run, late]);
    // the second wallet's money is ours too: the worth counts both accounts as one. A look in which it is not read
    // gives no figure at all (the worth then keeps its last full reading), never the first wallet's alone
    for (const a of [address2, address3]) {
      if (!a || got.hlUsd === null) continue;
      const v2 = await chain.hlValue(a).catch(() => null);
      got.hlUsd = v2 === null ? null : Math.round((got.hlUsd + v2) * 100) / 100;
    }
    funding = { ...got, at: Date.now(), mode };
    looks.finished++;
    saveJson(LAST, funding);
  } catch (e) {
    looks.failed++;
    funding = { dry: mode !== "go", problems: [], steps: [], eth: funding?.eth ?? 0, usdc: funding?.usdc ?? 0, hlUsd: funding?.hlUsd ?? null, done: false, at: Date.now(), mode, error: `${short(e)} (while ${looks.stage})` };
  } finally {
    clearTimeout(timer);
    busy = false;
  }
}

const short = (e: unknown) => String((e as Error)?.message ?? e).replace(/0x[0-9a-fA-F]{40,}/g, "…").slice(0, 120);

export async function reachCheck(fetcher: typeof fetch = fetch): Promise<Reach> {
  const r: Reach = { at: Date.now(), hyperliquidApi: false, coins: 0, arbitrumRpc: false, chainId: null, region: null, errors: [] };
  const post = (url: string, body: unknown) => fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  try {
    const res = await post(`${HL_API}/info`, { type: "meta" }).catch(() => post(`${HL_API}/info`, { type: "meta" })); // one slow answer is not "unreachable"
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

// ---- FASTER COPIES (src/hyperliquid/watch.ts) -------------------------------------------------------------------------------
/** deploy/live-rules.json hyperliquid.watch: on = the trade feed runs and measures delays; fast = its trades start fast looks. */
export function parseWatch(text: string): { on: boolean; fast: boolean } {
  try {
    const w = (JSON.parse(text) as { hyperliquid?: { watch?: { on?: unknown; fast?: unknown } } }).hyperliquid?.watch;
    const on = w?.on === true;
    return { on, fast: on && w?.fast === true };
  } catch {
    return { on: false, fast: false };
  }
}
let watchCache: { at: number; v: { on: boolean; fast: boolean } } | null = null;
const watchCfg = () => {
  const now = Date.now();
  if (!watchCache || now - watchCache.at > 30_000) {
    let v = { on: false, fast: false };
    try {
      v = parseWatch(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8"));
    } catch {
      // no file: off
    }
    watchCache = { at: now, v };
  }
  return watchCache.v;
};
let watcher: HlTradeWatch | null = null;
const liveRun = { running: false, again: false, lastKick: 0, kicks: 0, kickedAt: 0, timer: null as ReturnType<typeof setTimeout> | null };
/** the real side's look, one at a time: a look asked for while one runs follows right after it */
let runLive: () => Promise<void> = async () => undefined;
/** a fast look changed a paper copy: the real side looks at once (at most one kick every KICK_MS) */
export const KICK_MS = 3_000;
function kickLive() {
  if (liveRun.timer) return;
  const wait = Math.max(0, liveRun.lastKick + KICK_MS - Date.now());
  liveRun.timer = setTimeout(() => {
    liveRun.timer = null;
    liveRun.lastKick = Date.now();
    liveRun.kicks++;
    liveRun.kickedAt ||= Date.now();
    void runLive();
  }, wait);
  liveRun.timer.unref?.();
}
/** how long each real look took (ms), the last 300; and how long a kick waited before its look started */
const liveMs: number[] = [];
const kickWaitMs: number[] = [];
async function timed(f: () => Promise<void>) {
  const t0 = Date.now();
  if (liveRun.kickedAt) kickWaitMs.push(t0 - liveRun.kickedAt), (liveRun.kickedAt = 0), kickWaitMs.splice(0, Math.max(0, kickWaitMs.length - 300));
  try {
    await f();
  } finally {
    liveMs.push(Date.now() - t0);
    liveMs.splice(0, Math.max(0, liveMs.length - 300));
  }
}
const q = (xs: number[], f: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(f * s.length))] / 100) / 10 : null;
};
/** Serializes calls of `tick`: one asked for while one runs is run once right after it. */
export function serial(tick: () => Promise<void>, st = { running: false, again: false }): () => Promise<void> {
  return async () => {
    if (st.running) return void (st.again = true);
    st.running = true;
    try {
      do {
        st.again = false;
        await tick().catch(() => undefined);
      } while (st.again);
    } finally {
      st.running = false;
    }
  };
}
function startWatch(fetcher: typeof fetch) {
  const make = () =>
    new HlTradeWatch({
      coins: async () => Object.keys(coinsOf(await hlPostApi("info", { type: "meta" }, fetcher))),
      watched: () => hlWatched(),
      rule: traderRule,
      onHit: (a) => {
        if (watchCfg().fast) hlPoke(a);
      },
    });
  setHlFast({
    note: (kind, a, coin, src) => watcher?.note(kind, a, coin, src),
    px: (coin) => watcher?.price(coin) ?? null,
    changed: kickLive,
    priority: (rule) => meetsBar(rule, 0, Date.now()),
  });
  setHlDelayNote((kind, rule, coin) => watcher?.noteRule(kind, rule, coin));
  // the switch is read every 30 s: on starts the feed, off stops it
  const check = () => {
    const c = watchCfg();
    if (c.on && !watcher) {
      watcher = make();
      void watcher.start().catch(() => undefined);
    } else if (!c.on && watcher) {
      watcher.stop();
      watcher = null;
    }
  };
  check();
  setInterval(check, 30_000).unref();
  // fast looks that are due: twice a second (nothing is asked of Hyperliquid unless a followed trader traded)
  setInterval(() => {
    if (watcher && watchCfg().fast) void hlQuickTick().catch(() => 0);
  }, 500).unref();
}
/** For the status: no address. */
export const hlWatchSummary = () => ({ ...watchCfg(), feed: watcher ? watcher.summary() : null, quick: hlQuickSummary(), realKicks: liveRun.kicks, realLook: { n: liveMs.length, medianS: q(liveMs, 0.5), p90S: q(liveMs, 0.9), maxS: q(liveMs, 1) }, kickWait: { n: kickWaitMs.length, medianS: q(kickWaitMs, 0.5), p90S: q(kickWaitMs, 0.9) }, hlApi: hlHttpSummary() });

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
  // where a trader we like moved to (links.ts): reads Hyperliquid's public ledgers only, needs no wallet of ours;
  // the wallets it names are followed on paper. One wallet read every 10 s: about a fifth of the allowed rate.
  startLinks({ fetch: () => fetcher, liked: () => likedTraders(), board: hlBoard, record: (t) => traderRecord(t), wait: () => new Promise((ok) => setTimeout(ok, 10_000).unref()) });
  setExtraTraders(() => linkedTraders());
  setInterval(run, 6 * 3_600_000).unref();
  if (wallet.ok) {
    // money that arrives is seen within five minutes; what happens to it depends on the switch in the repo file
    const chain = realChain(address, fetcher);
    const look = () => void fundLook(chain).catch(() => undefined);
    // the last finished look of the run before is shown until this run's first one ends
    funding ??= loadJson<typeof funding>(LAST, null);
    setTimeout(look, 5_000).unref();
    setInterval(look, 5 * 60_000).unref();
    // real copies (src/hyperliquid/live.ts): does nothing unless deploy/live-rules.json hyperliquid.trade says so
    // the second wallet (overlaps): made only when the repo file names it; money moves only on its fundOnce switch
    let venue2: HlDeps["venue2"];
    if (secondCfg().wanted) {
      try {
        address2 = hlWallet2().address;
        hlAgent2();
        venue2 = realVenue(address2, fetcher, { wallet: hlWallet2, agent: hlAgent2 });
        const sd: SecondDeps = {
          cfg: secondCfg,
          free: async () => Number(((await hlPostApi("info", { type: "clearinghouseState", user: address }, fetcher)) as { withdrawable?: unknown }).withdrawable),
          send: (usd) => usdSend(hlWallet(), address2, usd, fetcher),
        };
        setInterval(() => void secondFundLook(sd).catch(() => undefined), 60_000).unref();
      } catch {
        address2 = "";
        venue2 = undefined;
      }
    }
    let venue3: HlDeps["venue3"];
    if (thirdWanted()) {
      try {
        address3 = hlWallet3().address;
        hlAgent3();
        venue3 = realVenue(address3, fetcher, { wallet: hlWallet3, agent: hlAgent3 });
      } catch {
        address3 = "";
        venue3 = undefined;
      }
    }
    setWalletAddrs(() => [address || null, address2 || null, address3 || null]);
    startRecon(() => [address || null, address2 || null, address3 || null], fetcher);
    // cash between our wallets so a copy is not skipped (src/hyperliquid/live.ts rebalancePlan, 26 Nov 2026)
    const keyOf = (w: 1 | 2 | 3) => (w === 3 ? hlWallet3() : w === 2 ? hlWallet2() : hlWallet());
    const addrOf = (w: 1 | 2 | 3) => (w === 3 ? address3 : w === 2 ? address2 : address);
    const move = async (from: 1 | 2 | 3, to: 1 | 2 | 3, usd: number): Promise<string> => {
      if (!addrOf(from) || !addrOf(to) || from === to) return "no such wallet";
      const a = (await usdSend(keyOf(from), addrOf(to), usd, fetcher)) as { status?: string; response?: unknown };
      return a?.status === "ok" ? "" : (typeof a?.response === "string" ? a.response : "no ok from Hyperliquid").replace(/0x[0-9a-fA-F]{40,}/g, "…").slice(0, 120);
    };
    const deps: HlDeps = { cfg: fileCfg, venue: realVenue(address, fetcher), ...(venue2 ? { venue2 } : {}), ...(venue3 ? { venue3 } : {}), ...(venue2 || venue3 ? { move } : {}), paperOpens: hlPaperOpens, meetsBar, listed: traderListed, histAvgPct: (r) => hlHistoryAvgPct(r), skillPass: (r) => hlSkillPass(r), proven: (r, t) => hlProven(r, t) };
    setKeptTraders(hlKeptTraders, "hyperliquid");
    runLive = serial(() => timed(() => hlLiveTick(deps)), liveRun);
    setInterval(() => void runLive(), 20_000).unref();
  }
  startWatch(fetcher);
  return run();
}

/** A trader's bar on Hyperliquid counts its paper copies on every coin (the Solana perps side wants some on SOL, BTC or ETH). */
// skill bar (25 Nov 2026, enrique: "push skill bar: HL history traders must pass the skill test, passers get cash
// first"): on its own history a trader also has to pass the skill test; the paper-copy bar is unchanged
const meetsBar = (rule: string, sinceMs: number, now: number) => {
  const c = fileCfg();
  // proven tier (25 Nov 2026): a trader at provenT+ standard errors is at the bar too
  return perpMeetsBar(rule, sinceMs, now, 0) || (!!c.historyBar && hlHistoryMeetsBar(rule, sinceMs, now, c.historyTop ?? 5) && (!c.skillBar || hlSkillPass(rule, now))) || (!!c.provenT && hlProven(rule, c.provenT, now));
};
/** The real copies, for the status and the tab (traders by short name, no address). */
export const hlLive = () => ({ ...hlLiveSummary(fileCfg(), meetsBar, Date.now(), (r) => hlHistoryAvgPct(r), (r) => hlProven(r, fileCfg().provenT ?? 0)), secondWallet: secondPublic(), history: { on: !!fileCfg().historyBar, ...hlHistorySummary(Date.now(), fileCfg().historyTop ?? 5) }, watch: hlWatchSummary() });

/** For the public status: no address, no key, no balance. */
export function hlPublic() {
  const on = funding && !funding.error && funding.hlUsd !== null ? funding.hlUsd >= 1 : null;
  const history = fundHistory();
  const stage = on ? "funded: the money is on Hyperliquid" : history.inTransit ? "funding: a deposit is on its way to Hyperliquid" : history.swappedEth > 0 ? "funding: swapped, not all deposited yet" : history.ethReceivedUsd > 0 ? "funding: ETH received, not swapped yet" : "setup: wallet made, waiting for money";
  return { stage, onHyperliquid: on, history, wallet, reach, funding: funding ? { at: funding.at, mode: funding.mode, dry: funding.dry, done: funding.done, problems: funding.problems, steps: funding.steps, error: funding.error ?? null } : lookStarted ? { at: lookStarted, mode: null, dry: true, done: false, problems: [], steps: [], error: "the first look at the wallet has not finished yet" } : null, looks: { ...looks, upMin: Math.round(process.uptime() / 60), lastStartedAt: lookStarted || null } };
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
${p.funding ? `<p>Wallet: <b>${p.funding.eth} ETH</b>, ${p.funding.usdc} USDC · on Hyperliquid: <b>${p.funding.hlUsd === null ? "not reachable now" : "$" + p.funding.hlUsd}</b></p>` : ""}
<p style="color:#9aa4b2;font-size:14px">Server check: Hyperliquid ${ok(p.reach?.hyperliquidApi)} · Arbitrum ${ok(p.reach?.arbitrumRpc)} · region ${p.reach?.region ?? "not read"}</p></body>`;
}

export const _hlTest = { reset: () => void ((wallet = { ok: false, error: "not started" }), (address = ""), (reach = null), (funding = null)) };
