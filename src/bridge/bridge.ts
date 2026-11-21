/**
 * Moving money between the places the bot trades (enrique, 19 Nov 2026: "being able to bridge between the chains we
 * operate in would be useful", "same goes for in and out of polygon"). Hyperliquid (its wallet on Arbitrum), the
 * Solana strategy wallets, the Polymarket wallet on Polygon and the bot's wallet on Base.
 *
 * REAL MONEY. The rules, all in code:
 *   - a move happens only on an order in deploy/live-rules.json ("bridge": { "order": { id, from, to, usd, mode } }),
 *     and only with mode "go". Anything else is a dry run: it prices the move and says what it would do. Each id
 *     runs once. An order needs enrique's own word for that move.
 *   - money can only go to one of OUR OWN wallets: the destination is never typed anywhere, it is worked out from the
 *     wallet files on the server. The quote must name that wallet, or nothing is signed.
 *   - a small test part goes first (TEST_USD); the rest goes only after the test was seen arriving on the chain.
 *   - the quote must promise at least what was sent less MAX_COST: a bad price is refused, not taken.
 *   - one send at a time; a mark is written before every send, so nothing is ever sent twice; a move that does not
 *     arrive is stopped for a look, never retried by itself.
 *   - hard limits: MIN_USD to MAX_USD a move.
 *
 * The last step at each end is the bot's own, already running: USDC that lands in the Hyperliquid wallet is deposited
 * by the funding (src/hyperliquid/fund.ts), native USDC that lands in the Polymarket wallet is converted by live.ts.
 *
 * A move that STARTS at Polymarket goes out as one all-or-nothing batch through Polymarket's relayer (src/live.ts
 * bridgeOutBatch): pUSD back into USDC.e, an allowance for exactly the amount, the call that starts the move.
 *
 * Base (enrique, 19 Nov 2026: "also build being able to bridge with base"): a place of its own, with the bot's own
 * wallet there (src/bridge/basekey.ts) holding USDC. Sending FROM Base needs a little ETH on Base for gas.
 *
 * Between two Solana wallets (21 Nov 2026, enrique: "what about some sol from spot rules moved to spot copy"): SOL only,
 * one plain transfer signed by the sending wallet, built here and not by a route finder (src/bridge/real.ts).
 *
 * This file knows no network: everything outside comes through Deps (src/bridge/real.ts is the real one).
 */
import { loadBridge, saveBridge, PLACES, type Move, type Place } from "./state.js";

export const MIN_USD = 15;
export const MAX_USD = 250;
export const TEST_USD = 8;
/** a move this small goes in one part: the whole of it is the test */
export const ONE_PART_USD = 20;
/** the most a part may cost (what is sent less the least that arrives): the larger of the two */
export const MAX_COST_USD = 2;
export const MAX_COST_SHARE = 0.015;
/** Hyperliquid keeps this much of every withdrawal */
export const HL_WITHDRAW_FEE = 1;
/** SOL a Solana wallet keeps for its own fees when its SOL is what moves */
export const KEEP_SOL = 0.05;
/** what a trimmed rest part leaves for its own fee and rent, on top of KEEP_SOL (SOL; dollars for USDC) */
export const TRIM_MARGIN = 0.003;
export const WITHDRAW_WAIT_MS = 60 * 60_000;
export const ARRIVE_WAIT_MS = 3 * 3_600_000;
export const UNSENT_WAIT_MS = 2 * 60_000;
export const MAX_TRIES = 3;
export const DRY_EVERY_MS = 10 * 60_000;
export const RETRY_LOOK_MS = 60_000;

export type Chain = "arbitrum" | "polygon" | "base" | "solana";
export type Token = "USDC" | "SOL";
export interface PlaceInfo {
  chain: Chain;
  address: string;
  token: Token;
}
export interface Order {
  id: string;
  from: Place;
  to: Place;
  usd: number;
  mode: "dry" | "go";
  /** a Solana wallet may hold both: which one leaves (default: USDC for perps, SOL for the spot wallets) */
  token?: Token;
  /**
   * "Up to": with this, usd is the MOST that moves, and this many dollars of the token stay in the wallet (on top of
   * the SOL kept for gas). What moves is the smaller of usd and what is spare. Without it, exactly usd moves.
   */
  keepUsd?: number;
}
export interface QuoteReq {
  from: PlaceInfo;
  to: PlaceInfo;
  /** in the source token */
  amount: number;
}
export interface Quote {
  tool: string;
  minutes: number;
  /** in the destination token */
  toAmount: number;
  toAmountMin: number;
  /** what the provider says it built the transaction for: checked against what we asked */
  echo: { fromChain: Chain | null; toChain: Chain | null; fromToken: string; toToken: string; fromAddress: string; toAddress: string; fromAmount: number };
  tx: { kind: "evm"; to: string; data: string; value: string; chainId: number; approval: string } | { kind: "solana"; data: string };
}
export interface Deps {
  order(): Order | null;
  /** moves to price side by side; these are never sent */
  dryRuns?(): Order[];
  /** the wallet of a place; throws when this machine does not have it */
  place(p: Place): PlaceInfo;
  /** what the place's wallet holds of its token, on its chain */
  balance(p: PlaceInfo): Promise<number>;
  /** the figure that rises when money arrives at the place (for Polymarket: every kind of dollar it holds) */
  watch(p: Place): Promise<number>;
  solUsd(): Promise<number>;
  quote(r: QuoteReq): Promise<Quote>;
  /** problems with the built transaction that only the real chain can tell (wrong contract, wrong signer); [] = good */
  inspect(r: QuoteReq, q: Quote): Promise<string[]>;
  /** sign and send; returns the transaction id */
  send(r: QuoteReq, q: Quote): Promise<string>;
  status(tx: string, r: QuoteReq): Promise<"done" | "pending" | "failed" | "unknown">;
  /** dollars Hyperliquid would let the account withdraw now */
  hlFree(): Promise<number>;
  hlWithdraw(usd: number): Promise<void>;
  now(): number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const show = (x: number, t: Token) => (t === "USDC" ? `${r2(x)} USDC` : `${r4(x)} SOL`);
/** Nothing that looks like an address, a key or a transaction id may reach status or logs. */
export const scrub = (text: unknown) =>
  String((text as Error)?.message ?? text)
    .replace(/0x[0-9a-fA-F]{6,}/g, "0x…")
    .replace(/[1-9A-HJ-NP-Za-km-z]{30,}/g, "…")
    .replace(/api[-_]?key=[^&\s"]+/gi, "api-key=…")
    .slice(0, 180);

/** Is this an order the bridge will take? Returns what is wrong with it ([] = good). Pure. */
export function checkOrder(o: Order): string[] {
  const bad: string[] = [];
  if (!/^[a-z0-9-]{3,40}$/.test(o.id)) bad.push("the order needs an id (small letters, digits, dashes)");
  if (!PLACES.includes(o.from) || !PLACES.includes(o.to)) bad.push(`from and to must each be one of: ${PLACES.join(", ")}`);
  else if (o.from === o.to) bad.push("from and to are the same place");
  else if (o.from.startsWith("solana") && o.to.startsWith("solana") && (o.token ?? (o.from === "solana-perps" ? "USDC" : "SOL")) !== "SOL") bad.push("between two Solana wallets only SOL moves");
  if (!(o.usd >= MIN_USD && o.usd <= MAX_USD)) bad.push(`the amount must be ${MIN_USD} to ${MAX_USD} dollars`);
  if (o.token !== undefined && (!["USDC", "SOL"].includes(o.token) || !String(o.from).startsWith("solana"))) bad.push("token is USDC or SOL, and only for a move that starts at a Solana wallet");
  if (o.keepUsd !== undefined && (!(o.keepUsd >= 0 && o.keepUsd <= 100_000) || o.from === "hyperliquid")) bad.push("keepUsd is a number of dollars to leave behind, and not for a move that starts at Hyperliquid");
  return bad;
}

/** Read the order out of the text of deploy/live-rules.json. Anything unclear is no order; a mode other than "go" is a dry run. */
const orderOf = (o: Record<string, unknown>, dryOnly = false): Order => ({ id: String(o.id ?? ""), from: String(o.from ?? "") as Place, to: String(o.to ?? "") as Place, usd: Number(o.usd), mode: !dryOnly && o.mode === "go" ? "go" : "dry", ...(o.token !== undefined ? { token: String(o.token) as Token } : {}), ...(o.keepUsd !== undefined ? { keepUsd: Number(o.keepUsd) } : {}) });
export function parseOrder(text: string): Order | null {
  try {
    const o = (JSON.parse(text) as { bridge?: { order?: Record<string, unknown> | null } }).bridge?.order;
    if (!o || typeof o !== "object") return null;
    return orderOf(o);
  } catch {
    return null;
  }
}
export const MAX_DRY_RUNS = 6;
/** "bridge": { "dryRuns": [ ... ] }: several moves priced side by side. These can NEVER go: whatever mode they carry, they are dry. */
export function parseDryRuns(text: string): Order[] {
  try {
    const a = (JSON.parse(text) as { bridge?: { dryRuns?: unknown } }).bridge?.dryRuns;
    return Array.isArray(a) ? a.filter((o) => o && typeof o === "object").slice(0, MAX_DRY_RUNS).map((o) => orderOf(o as Record<string, unknown>, true)) : [];
  } catch {
    return [];
  }
}

/** The wallet a move starts at, with the token the order named. */
const source = (d: Deps, from: Place, token?: Token): PlaceInfo => {
  const p = d.place(from);
  return token && p.chain === "solana" ? { ...p, token } : p;
};
/**
 * How much leaves, in the source token. Exactly `usd` worth, or with keepUsd the smaller of that and what is spare
 * above what stays behind. Returns why not when the wallet cannot cover it. Pure.
 */
export function sized(usd: number, keepUsd: number | undefined, have: number, px: number, token: Token): { left: number; why?: string } {
  const round = (x: number) => (token === "SOL" ? Math.floor(x * 1e4) / 1e4 : Math.floor(x * 100) / 100);
  const gas = token === "SOL" ? KEEP_SOL : 0;
  if (keepUsd === undefined) {
    const left = token === "SOL" ? r4(usd / px) : r2(usd);
    return have < left + gas ? { left, why: `the wallet holds ${show(have, token)}, the move needs ${show(left + gas, token)}` } : { left };
  }
  const spare = have - gas - keepUsd / px;
  const left = round(Math.min(usd / px, spare));
  return left * px < MIN_USD ? { left: 0, why: `only $${r2(Math.max(0, spare * px))} is spare above the $${r2(keepUsd)} that stays (a move is $${MIN_USD} or more)` } : { left };
}

export const maxCost = (valueUsd: number) => Math.max(MAX_COST_USD, valueUsd * MAX_COST_SHARE);

/**
 * Everything that must hold before a built transaction is signed. Pure. `px` = dollars per unit of each token.
 * Returns the problems ([] = good).
 */
export function guard(r: QuoteReq, q: Quote, px: { from: number; to: number }): string[] {
  const bad: string[] = [];
  const same = (a: string, b: string, chain: Chain) => (chain === "solana" ? a === b : a.toLowerCase() === b.toLowerCase());
  if (q.echo.fromChain !== r.from.chain || q.echo.toChain !== r.to.chain) bad.push("the quote is for other chains than asked");
  if (q.echo.fromToken !== r.from.token || q.echo.toToken !== r.to.token) bad.push("the quote is for other tokens than asked");
  if (!same(q.echo.fromAddress, r.from.address, r.from.chain)) bad.push("the quote does not start at our wallet");
  if (!same(q.echo.toAddress, r.to.address, r.to.chain)) bad.push("the quote does not pay our own wallet");
  if (Math.abs(q.echo.fromAmount - r.amount) > r.amount * 1e-6) bad.push("the quote is for another amount than asked");
  if (!(q.toAmountMin > 0) || !(q.toAmount >= q.toAmountMin)) bad.push("the quote names no least amount to arrive");
  const inUsd = r.amount * px.from;
  const outUsd = q.toAmountMin * px.to;
  if (!(outUsd >= inUsd - maxCost(inUsd))) bad.push(`the move would cost up to $${r2(inUsd - outUsd)} of $${r2(inUsd)} (limit $${r2(maxCost(inUsd))})`);
  if (outUsd > inUsd * 1.05) bad.push("the quote promises more than was sent: not believed");
  if ((q.tx.kind === "solana") !== (r.from.chain === "solana")) bad.push("the transaction is for another kind of chain");
  return bad;
}

export interface Report {
  at: number;
  order: Order | null;
  stage: string;
  problems: string[];
  steps: string[];
}
let last: Report | null = null;
let lastDryAt = 0;
let lastDryKey = "";
let busy = false;
export const bridgeReport = () => last;

const note = (m: Move, what: string, now: number) => void (m.log = [...m.log, { t: now, what: scrub(what) }].slice(-40));
function stop(m: Move, why: string, now: number) {
  m.stage = "stopped";
  m.why = scrub(why);
  m.endedAt = now;
  note(m, `STOPPED: ${why}`, now);
}

async function prices(d: Deps, a: PlaceInfo, b: PlaceInfo) {
  const sol = a.token === "SOL" || b.token === "SOL" ? await d.solUsd() : 0;
  if ((a.token === "SOL" || b.token === "SOL") && !(sol > 0)) throw new Error("no SOL price");
  return { from: a.token === "SOL" ? sol : 1, to: b.token === "SOL" ? sol : 1 };
}

/** Price one part and check it. Returns the quote, or the problems. */
async function priced(d: Deps, r: QuoteReq): Promise<{ q: Quote; bad: string[]; px: { from: number; to: number } }> {
  const px = await prices(d, r.from, r.to);
  const q = await d.quote(r);
  const bad = guard(r, q, px);
  if (!bad.length) bad.push(...(await d.inspect(r, q)));
  return { q, bad, px };
}

/** The parts a move of `left` (in the source token, worth `px` dollars each) goes in. Pure. */
export function parts(left: number, px: number): number[] {
  const usd = left * px;
  if (usd <= ONE_PART_USD) return [left];
  const test = TEST_USD / px;
  return [test, left - test];
}

/** A dry run: prices every part and says what would happen. Signs nothing, writes nothing but the report. */
async function dry(d: Deps, o: Order): Promise<Report> {
  const steps: string[] = [];
  const problems: string[] = [];
  const from = source(d, o.from, o.token);
  const to = d.place(o.to);
  let usd = o.usd;
  if (o.from === "hyperliquid") {
    const free = await d.hlFree();
    if (free < o.usd) problems.push(`Hyperliquid would let only $${r2(free)} out now (the rest backs open positions)`);
    steps.push(`would withdraw $${r2(o.usd)} from Hyperliquid to its own wallet (Hyperliquid keeps $${HL_WITHDRAW_FEE})`);
    usd -= HL_WITHDRAW_FEE;
  }
  const px = await prices(d, from, to);
  let left = from.token === "SOL" ? r4(usd / px.from) : r2(usd);
  if (o.from !== "hyperliquid") {
    const z = sized(usd, o.keepUsd, await d.balance(from), px.from, from.token);
    if (z.why) problems.push(z.why);
    if (o.keepUsd !== undefined) {
      if (!(z.left > 0)) return { at: d.now(), order: o, stage: "dry run: would NOT go", problems, steps };
      left = z.left;
      steps.push(`would move ${show(left, from.token)} (about $${r2(left * px.from)}), leaving $${r2(o.keepUsd)} and gas behind`);
    }
  }
  let cost = o.usd - usd;
  for (const [i, amount] of parts(left, px.from).entries()) {
    const p = await priced(d, { from, to, amount });
    problems.push(...p.bad);
    cost += amount * p.px.from - p.q.toAmountMin * p.px.to;
    steps.push(`would send ${show(amount, from.token)}${i === 0 && left !== amount ? " as a test" : ""}: at least ${show(p.q.toAmountMin, to.token)} arrives (${scrub(p.q.tool)}, about ${Math.max(1, Math.round(p.q.minutes))} min)`);
  }
  steps.push(`the whole move would cost at most about $${r2(cost)}`);
  return { at: d.now(), order: o, stage: problems.length ? "dry run: would NOT go" : "dry run: ready", problems, steps };
}

/** One step of a real move. Returns when it has done one thing or has to wait. */
async function step(d: Deps, o: Order, m: Move): Promise<void> {
  const now = d.now();
  const save = () => {
    const s = loadBridge();
    s.moves[m.id] = m;
    saveBridge(s);
  };
  const from = source(d, m.from, m.token);
  const to = d.place(m.to);

  if (m.stage === "new") {
    if (m.from === "hyperliquid") {
      const free = await d.hlFree();
      if (free < m.usd) return void ((m.why = `waiting: Hyperliquid would let only $${r2(free)} out now`), save());
      // the mark goes down before the withdrawal: from here the funding leaves the wallet alone
      m.withdraw = { at: now, before: await d.balance(from), usd: m.usd, sent: false };
      m.stage = "withdraw";
      delete m.why;
      save();
      try {
        await d.hlWithdraw(m.usd);
      } catch (e) {
        // a plain "no" from Hyperliquid: nothing left, the move ends here. Anything else may have gone through: wait and see.
        if (String((e as Error)?.message).startsWith("refused:")) stop(m, `Hyperliquid did not take the withdrawal (${scrub(e)})`, now);
        else note(m, `the withdrawal request got no clear answer (${scrub(e)}): waiting to see if it shows`, now);
        return save();
      }
      m.withdraw.sent = true;
      note(m, `asked Hyperliquid for $${r2(m.usd)}`, now);
      return save();
    }
    const px = await prices(d, from, to);
    const z = sized(m.usd, m.keepUsd, await d.balance(from), px.from, from.token);
    if (z.why) return void ((m.why = `waiting: ${z.why}`), save());
    m.left = z.left;
    note(m, `moving ${show(z.left, from.token)}`, now);
    m.stage = "test";
    delete m.why;
    return save();
  }

  if (m.stage === "withdraw") {
    const w = m.withdraw!;
    const rose = (await d.balance(from)) - w.before;
    if (rose >= w.usd - HL_WITHDRAW_FEE - 0.05) {
      m.left = r2(Math.min(rose, w.usd - HL_WITHDRAW_FEE));
      m.stage = "test";
      note(m, `${show(m.left, "USDC")} came out of Hyperliquid`, now);
      return save();
    }
    if (now - w.at > WITHDRAW_WAIT_MS) stop(m, "the withdrawal from Hyperliquid did not show in the wallet within an hour; whatever arrives goes back onto Hyperliquid", now);
    return save();
  }

  // test or rest
  const p = m.pending;
  if (p) {
    const rose = (await d.watch(m.to)) - p.dstBefore;
    const st = p.tx ? await d.status(p.tx, { from, to, amount: p.amount }).catch(() => "unknown" as const) : "unknown";
    if (rose >= p.minOut * 0.9 || st === "done") {
      m.sent = m.sent + p.amount;
      m.arrived = m.arrived + (rose >= p.minOut * 0.9 ? rose : p.minOut);
      m.left = Math.max(0, m.left - p.amount);
      note(m, `${p.part} arrived: ${show(p.amount, from.token)} sent, about ${show(rose >= p.minOut * 0.9 ? rose : p.minOut, to.token)} in`, now);
      delete m.pending;
      if (p.part === "rest" || m.left * (from.token === "SOL" ? await d.solUsd() : 1) < 1) {
        m.stage = "done";
        m.endedAt = now;
      } else m.stage = "rest";
      return save();
    }
    if (st === "failed") return void (stop(m, `the ${p.part} part failed on the way; the bridge pays such a part back to the wallet it came from`, now), save());
    if (!p.tx && now - p.at > UNSENT_WAIT_MS) {
      // a send that never came back: gone only if the wallet is lighter
      if ((await d.balance(from)) >= p.srcBefore - p.amount * 0.01) {
        delete m.pending;
        m.tries++;
        note(m, `the ${p.part} part never left the wallet`, now);
        if (m.tries >= MAX_TRIES) stop(m, `${MAX_TRIES} sends in a row never left the wallet`, now);
        return save();
      }
    }
    if (now - p.at > ARRIVE_WAIT_MS) stop(m, `the ${p.part} part has not arrived after ${ARRIVE_WAIT_MS / 3_600_000} hours: needs a look, nothing more is sent`, now);
    return save();
  }

  const px = await prices(d, from, to);
  const todo = parts(m.left, px.from);
  let amount = m.stage === "test" ? todo[0] : m.left;
  const part: "test" | "rest" = m.stage === "test" && todo.length > 1 ? "test" : "rest";
  const have = await d.balance(from);
  // 20 Nov 2026: a move that takes everything ("keepUsd": 0) found the test part's fees missing for the rest
  // (0.7603 SOL held, 0.7103 + 0.05 gas needed) and waited for good. The rest part is trimmed to what is there, gas
  // kept, when it is short by no more than 5%.
  const keep = from.token === "SOL" ? KEEP_SOL : 0;
  if (part === "rest" && have < amount + keep && have - keep - TRIM_MARGIN >= amount * 0.95) {
    amount = m.left = Math.floor((have - keep - TRIM_MARGIN) * 1e4) / 1e4;
  }
  if (have < amount + (from.token === "SOL" ? KEEP_SOL : 0)) return void ((m.why = `waiting: the wallet holds ${show(have, from.token)}, this part needs ${show(amount, from.token)}`), save());
  const r: QuoteReq = { from, to, amount: from.token === "SOL" ? r4(amount) : Math.floor(amount * 100) / 100 };
  const got = await priced(d, r);
  if (got.bad.length) return void ((m.why = `waiting: ${got.bad.map(scrub).join("; ")}`), save());
  delete m.why;
  // the mark goes down BEFORE the send
  m.pending = { part, amount: r.amount, at: now, tx: "", srcBefore: have, dstBefore: await d.watch(m.to), minOut: got.q.toAmountMin, tool: scrub(got.q.tool) };
  save();
  m.pending.tx = await d.send(r, got.q);
  note(m, `sent the ${part} part: ${show(r.amount, from.token)} (${got.q.tool})`, now);
  save();
}

function describe(o: Order, m: Move): Report {
  const stage = m.stage === "done" ? "done" : m.stage === "stopped" ? "STOPPED" : m.stage === "withdraw" ? "taking the money out of Hyperliquid" : m.pending ? `the ${m.pending.part} part is on its way` : m.stage === "new" ? "starting" : `about to send the ${m.stage} part`;
  return { at: Date.now(), order: o, stage, problems: m.stage === "stopped" && m.why ? [m.why] : [], steps: [...(m.why && m.stage !== "stopped" ? [m.why] : []), ...m.log.map((l) => l.what)] };
}

/** The side-by-side dry runs (bridge.dryRuns): priced every DRY_EVERY_MS, never while a real order is on go. */
let dryRuns: Report[] = [];
let dryRunsAt = 0;
let dryRunsKey = "";
async function sideBySide(d: Deps, o: Order | null): Promise<void> {
  const list = d.dryRuns?.() ?? [];
  if (!list.length) return void ((dryRuns = []), (dryRunsKey = ""));
  if (o?.mode === "go") return;
  const key = JSON.stringify(list);
  if (key === dryRunsKey && d.now() - dryRunsAt < DRY_EVERY_MS) return;
  dryRunsKey = key;
  dryRunsAt = d.now();
  const out: Report[] = [];
  for (const x of list) {
    const bad = checkOrder(x);
    if (bad.length) out.push({ at: d.now(), order: x, stage: "order refused", problems: bad, steps: [] });
    else out.push(await dry(d, x).catch((e) => ({ at: d.now(), order: x, stage: "could not look", problems: [scrub(e)], steps: [] })));
  }
  dryRuns = out;
  // a look that could not be made is made again within a minute, not in ten
  if (out.some((x) => x.stage === "could not look")) dryRunsAt = d.now() - DRY_EVERY_MS + RETRY_LOOK_MS;
}

/**
 * Moves that are no longer the order (20 Nov 2026: an order with nothing spare was taken out of the file and its move
 * stayed at "new" for good, in the way of every later move). A part that is on its way, or a withdrawal from
 * Hyperliquid, is still followed to its end; a move with nothing on its way is ended in words. Never sends anything.
 */
async function leftBehind(d: Deps, o: Order | null): Promise<void> {
  for (const m of Object.values(loadBridge().moves)) {
    if (m.id === o?.id || m.stage === "done" || m.stage === "stopped") continue;
    try {
      if (m.pending || m.stage === "withdraw") {
        // step() only looks for the arrival here: it sends a part only when nothing is pending and the stage is test or rest
        await step(d, { id: m.id, from: m.from, to: m.to, usd: m.usd, mode: "dry" }, m);
        continue;
      }
      stop(m, m.sent > 0 ? "the order was taken out before the rest was sent: what was sent has arrived, the rest stays where it was" : "the order was taken out before anything was sent: nothing moved", d.now());
      const s = loadBridge();
      s.moves[m.id] = m;
      saveBridge(s);
    } catch {
      // not read at this look: looked at again at the next
    }
  }
}

/** One look. Never throws; never runs twice at once. */
export async function bridgeTick(d: Deps): Promise<Report | null> {
  if (busy) return last;
  busy = true;
  try {
    const o = d.order();
    await leftBehind(d, o);
    await sideBySide(d, o);
    if (!o) return (last = null);
    const bad = checkOrder(o);
    if (bad.length) return (last = { at: d.now(), order: null, stage: "order refused", problems: bad, steps: [] });
    const s = loadBridge();
    let m = s.moves[o.id];
    // an id belongs to one move: the same id with other numbers is refused, never run
    if (m && (m.from !== o.from || m.to !== o.to || m.usd !== o.usd || m.token !== o.token || m.keepUsd !== o.keepUsd)) return (last = { at: d.now(), order: o, stage: "order refused", problems: ["this id was already used for another move: a new move needs a new id"], steps: [] });
    if (o.mode !== "go" && !m) {
      const key = JSON.stringify(o);
      if (last && key === lastDryKey && d.now() - lastDryAt < DRY_EVERY_MS) return last;
      lastDryKey = key;
      lastDryAt = d.now();
      return (last = await dry(d, o));
    }
    if (!m) {
      // one real move at a time
      const other = Object.values(s.moves).find((x) => x.stage !== "done" && x.stage !== "stopped");
      if (other) return (last = { at: d.now(), order: o, stage: "waiting", problems: [`the move "${other.id}" is still going`], steps: [] });
      m = { id: o.id, from: o.from, to: o.to, usd: o.usd, ...(o.token ? { token: o.token } : {}), ...(o.keepUsd !== undefined ? { keepUsd: o.keepUsd } : {}), stage: "new", startedAt: d.now(), left: 0, tries: 0, sent: 0, arrived: 0, log: [] };
      s.moves[o.id] = m;
      saveBridge(s);
    }
    // a started move is finished even if the order goes back to "dry": only "go" sends a NEW part
    if (m.stage !== "done" && m.stage !== "stopped") {
      if (o.mode === "go" || m.pending || m.stage === "withdraw") await step(d, o, m);
      else m.why = "paused: the order is no longer on go";
    }
    return (last = describe(o, m));
  } catch (e) {
    return (last = { at: d.now(), order: last?.order ?? null, stage: "could not look", problems: [scrub(e)], steps: last?.steps ?? [] });
  } finally {
    busy = false;
  }
}

/** For the public status: places, dollars and fixed words. No address, no transaction id. */
export function bridgePublic() {
  const moves = Object.values(loadBridge().moves).map((m) => ({ id: m.id, from: m.from, to: m.to, usd: m.usd, stage: m.stage, why: m.why ?? null, startedAt: m.startedAt, endedAt: m.endedAt ?? null, sent: r4(m.sent), arrived: r4(m.arrived), inTransit: m.pending ? { part: m.pending.part, amount: m.pending.amount, since: m.pending.at, sent: !!m.pending.tx } : null }));
  return { now: last, dryRuns, moves };
}

export const _test = { reset: () => void ((dryRuns = []), (dryRunsAt = 0), (dryRunsKey = ""), (last = null), (lastDryAt = 0), (lastDryKey = ""), (busy = false)) };
