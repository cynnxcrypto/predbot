/**
 * EMPTY THE SOLANA WALLETS TO ENRIQUE (24 Nov 2026, enrique: "yeah i dont like any of our solana strategies",
 * "lets pause that, empty the wallets into my wallet and move on", then "send here <his address>").
 *
 * What it can do, and nothing else:
 *   - one destination, his. deploy/live-rules.json carries it sealed (AES-256-GCM, key = the server's jev key), so a
 *     changed or made-up value does not open and nothing is sent. Never readable in the public repo, status or logs;
 *   - stage "test": 0.01 SOL from one wallet, once;
 *   - stage "all", only after the test is confirmed on chain: each of our three Solana wallets (spot copy, spot rules,
 *     perps) sends its USDC (his USDC account made if missing), closes its empty token accounts (their rent comes
 *     back) and then sends all its SOL. A wallet still holding coins waits for them to be sold, at most 12 hours,
 *     then goes anyway (the coins stay; the status says how many).
 *   - a transaction that left is never sent again: it is followed until the chain confirms or drops it (2 minutes).
 *
 * deploy/live-rules.json: "solanaSendOut": { "to": "<sealed>", "stage": "test" | "all" }. No block, nothing happens.
 * State: data/sendout-state.json (server only). The public status carries the stage, done flags and errors in words,
 * and the details (amounts, transaction ids) sealed with the same key, opened by MAIN off the server.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, ROOT } from "../config.js";
import { loadJson, saveJson } from "../store.js";
import { shared } from "./copyrun.js";
import { base58decode, namedWallet, signTransaction, wallet, type Wallet } from "./keys.js";
import { ATA_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM, ata, buildTx, u64le, type Ix } from "./soltx.js";

export const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const TEST_LAMPORTS = 10_000_000; // 0.01 SOL
export const FEE_LAMPORTS = 5_000; // one signature, no priority fee
export const COIN_WAIT_MS = 12 * 3600_000;
export const DROP_AFTER_MS = 120_000;
const FILE = "sendout-state.json";

const keyOf = (secret: string) => createHash("sha256").update(`predbot-sendout-2026-11-24:${secret.trim()}`).digest();

/** A Solana address: base58 that decodes to 32 bytes. */
export const isSolAddress = (a: string) => {
  try {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && base58decode(a).length === 32;
  } catch {
    return false;
  }
};
/** Seal text (the address, or the status details) with the server's key. */
export function seal(text: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}
export function unseal(sealed: string, secret: string): string | null {
  try {
    const raw = Buffer.from(sealed, "base64");
    if (raw.length < 29) return null;
    const d = createDecipheriv("aes-256-gcm", keyOf(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
/** The destination, or null when it does not open with this key or is not a Solana address. */
export function openDest(sealed: string, secret: string): string | null {
  const t = unseal(sealed, secret);
  return t && isSolAddress(t) ? t : null;
}

export type Tx = { sig: string; at: number; what: string; lamports?: number; usdc?: number; confirmed: boolean; dropped: boolean; err: string | null };
export type WalletState = { txs: Tx[]; coinsSeenAt: number | null; coinsLeft: number; done: boolean; error: string | null };
export type SendState = { test: Tx | null; testTries: number; wallets: Record<string, WalletState> };
const fresh = (): SendState => ({ test: null, testTries: 0, wallets: {} });
const freshW = (): WalletState => ({ txs: [], coinsSeenAt: null, coinsLeft: 0, done: false, error: null });

/** A wallet's view from the chain: SOL, token accounts (by program Tokenkeg only). */
export type Holdings = { lamports: number; accounts: { address: string; mint: string; amount: bigint; decimals: number }[] };

/** SPL Token: CreateIdempotent of `owner`'s associated account for `mint`, paid by `payer`. Pure. */
export const createAtaIx = (payer: string, owner: string, mint: string): Ix => ({
  program: ATA_PROGRAM,
  keys: [
    { pubkey: payer, signer: true, writable: true },
    { pubkey: ata(owner, mint), writable: true },
    { pubkey: owner },
    { pubkey: mint },
    { pubkey: SYSTEM_PROGRAM },
    { pubkey: TOKEN_PROGRAM },
  ],
  data: Uint8Array.from([1]),
});
/** SPL Token TransferChecked of `amount` base units. Pure. */
export const transferCheckedIx = (from: string, mint: string, to: string, owner: string, amount: bigint, decimals: number): Ix => ({
  program: TOKEN_PROGRAM,
  keys: [{ pubkey: from, writable: true }, { pubkey: mint }, { pubkey: to, writable: true }, { pubkey: owner, signer: true }],
  data: Uint8Array.from([12, ...u64le(amount), decimals]),
});
/** SPL Token CloseAccount: an empty token account's rent goes back to its owner. Pure. */
export const closeIx = (account: string, owner: string): Ix => ({
  program: TOKEN_PROGRAM,
  keys: [{ pubkey: account, writable: true }, { pubkey: owner, writable: true }, { pubkey: owner, signer: true }],
  data: Uint8Array.from([9]),
});
/** System Program Transfer. Pure. */
export const solTransferIx = (from: string, to: string, lamports: number): Ix => ({
  program: SYSTEM_PROGRAM,
  keys: [{ pubkey: from, signer: true, writable: true }, { pubkey: to, writable: true }],
  data: Uint8Array.from([2, 0, 0, 0, ...u64le(lamports)]),
});

export type Step =
  | { do: "nothing"; why: string }
  | { do: "usdc"; ixs: Ix[]; usdc: number }
  | { do: "close"; ixs: Ix[]; n: number }
  | { do: "sol"; ixs: Ix[]; lamports: number }
  | { do: "wait"; why: string }
  | { do: "done" };

/**
 * What one wallet does next, in order: USDC out, empty token accounts closed, all SOL out. Coins (any other token with a
 * balance) make it wait, up to COIN_WAIT_MS from when they were first seen. Pure.
 */
export function nextWalletStep(owner: string, dest: string, h: Holdings, ws: WalletState, now: number): Step {
  if (ws.done) return { do: "done" };
  if (ws.txs.some((t) => !t.confirmed && !t.dropped)) return { do: "nothing", why: "a transaction is on its way" };
  const usdc = h.accounts.filter((a) => a.mint === SOL_USDC && a.amount > 0n);
  if (usdc.length) {
    const a = usdc[0];
    const amt = Number(a.amount) / 10 ** a.decimals;
    return { do: "usdc", usdc: amt, ixs: [createAtaIx(owner, dest, SOL_USDC), transferCheckedIx(a.address, SOL_USDC, ata(dest, SOL_USDC), owner, a.amount, a.decimals)] };
  }
  const coins = h.accounts.filter((a) => a.mint !== SOL_USDC && a.amount > 0n);
  if (coins.length && !(ws.coinsSeenAt != null && now - ws.coinsSeenAt >= COIN_WAIT_MS)) return { do: "wait", why: `${coins.length} coin(s) still held: waiting for them to be sold` };
  const empty = h.accounts.filter((a) => a.amount === 0n).slice(0, 10);
  if (empty.length) return { do: "close", n: empty.length, ixs: empty.map((a) => closeIx(a.address, owner)) };
  const lamports = h.lamports - FEE_LAMPORTS;
  if (lamports <= 0) return { do: "done" };
  return { do: "sol", lamports, ixs: [solTransferIx(owner, dest, lamports)] };
}

type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;
export type Deps = {
  plan: () => { stage: string | null; dest: string | null; secret: string };
  wallets: () => [string, Wallet][];
  holdings: (owner: string) => Promise<Holdings>;
  blockhash: () => Promise<string>;
  send: (b64: string) => Promise<string>;
  status: (sig: string) => Promise<"confirmed" | "failed" | "unknown">;
  load: () => SendState;
  save: (s: SendState) => void;
  now: () => number;
};

async function sendIxs(d: Deps, w: Wallet, ixs: Ix[]): Promise<string> {
  const tx = signTransaction(buildTx(w.address, await d.blockhash(), ixs), w);
  return d.send(tx);
}
async function follow(d: Deps, t: Tx): Promise<void> {
  if (t.confirmed || t.dropped) return;
  const st = await d.status(t.sig);
  if (st === "confirmed") t.confirmed = true;
  else if (st === "failed") (t.dropped = true), (t.err = "failed on chain");
  else if (d.now() - t.at > DROP_AFTER_MS) (t.dropped = true), (t.err = "not seen on chain in 2 minutes");
}

let busy = false;
export async function sendOutTick(d: Deps): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const p = d.plan();
    if (p.stage !== "test" && p.stage !== "all") return;
    if (!p.dest) return;
    const s = d.load();
    const ws = d.wallets();
    // the test: 0.01 SOL from the first wallet that holds 0.02 or more, once (a dropped one may go again, 3 times at most)
    if (s.test) await follow(d, s.test);
    if (!s.test?.confirmed) {
      if ((!s.test || s.test.dropped) && s.testTries < 3) {
        for (const [, w] of ws) {
          const h = await d.holdings(w.address);
          if (h.lamports < 2 * TEST_LAMPORTS) continue;
          s.testTries++;
          s.test = { sig: "", at: d.now(), what: "test 0.01 SOL", lamports: TEST_LAMPORTS, confirmed: false, dropped: false, err: null };
          try {
            s.test.sig = await sendIxs(d, w, [solTransferIx(w.address, p.dest, TEST_LAMPORTS)]);
          } catch (e) {
            s.test.dropped = true;
            s.test.err = e instanceof Error ? e.message.slice(0, 120) : "send failed";
          }
          break;
        }
      }
      d.save(s);
      return;
    }
    if (p.stage !== "all") return d.save(s);
    for (const [label, w] of ws) {
      const st = (s.wallets[label] ??= freshW());
      for (const t of st.txs) await follow(d, t);
      try {
        const h = await d.holdings(w.address);
        const coins = h.accounts.filter((a) => a.mint !== SOL_USDC && a.amount > 0n).length;
        st.coinsLeft = coins;
        if (coins && st.coinsSeenAt == null) st.coinsSeenAt = d.now();
        const step = nextWalletStep(w.address, p.dest, h, st, d.now());
        st.error = null;
        if (step.do === "done") st.done = true;
        else if (step.do === "wait" || step.do === "nothing") st.error = step.do === "wait" ? step.why : null;
        else {
          const t: Tx = { sig: "", at: d.now(), what: step.do, confirmed: false, dropped: false, err: null, ...(step.do === "sol" ? { lamports: step.lamports } : step.do === "usdc" ? { usdc: step.usdc } : {}) };
          st.txs.push(t);
          try {
            t.sig = await sendIxs(d, w, step.ixs);
          } catch (e) {
            t.dropped = true;
            t.err = e instanceof Error ? e.message.slice(0, 120) : "send failed";
          }
          if (st.txs.filter((x) => x.dropped).length >= 6) st.error = "6 sends dropped: stopped for a review";
        }
      } catch (e) {
        st.error = e instanceof Error ? e.message.slice(0, 120) : "read failed";
      }
      d.save(s);
    }
  } finally {
    busy = false;
  }
}

/** The public view: words and flags only; amounts and transaction ids sealed. */
export function sendOutSummary(): unknown {
  const p = realPlan();
  const s = loadJson<SendState>(FILE, fresh());
  if (!p.stage && !s.test) return null;
  const sol = (l?: number) => (l == null ? undefined : Math.round(l / 1e5) / 1e4);
  const detail = { test: s.test && { sig: s.test.sig, sol: sol(s.test.lamports), confirmed: s.test.confirmed, dropped: s.test.dropped }, wallets: Object.fromEntries(Object.entries(s.wallets).map(([k, w]) => [k, w.txs.map((t) => ({ what: t.what, sig: t.sig, sol: sol(t.lamports), usdc: t.usdc, confirmed: t.confirmed, dropped: t.dropped, err: t.err }))])) };
  const clean = (x: string | null) => (x ? x.replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, "…").slice(0, 120) : null);
  return {
    stage: p.stage,
    destinationReadable: p.stage ? p.dest != null : null,
    test: s.test ? { confirmed: s.test.confirmed, dropped: s.test.dropped, tries: s.testTries, err: clean(s.test.err) } : null,
    wallets: Object.fromEntries(Object.entries(s.wallets).map(([k, w]) => [k, { done: w.done, sends: w.txs.length, confirmed: w.txs.filter((t) => t.confirmed).length, coinsLeft: w.coinsLeft, note: clean(w.error) }])),
    sealed: p.secret ? seal(JSON.stringify(detail), p.secret) : null,
  };
}

function realPlan(): { stage: string | null; dest: string | null; secret: string } {
  let secret = "";
  try {
    secret = readFileSync(join(DATA, "jev-key.txt"), "utf8").trim();
  } catch {
    /* no key: nothing opens */
  }
  try {
    const b = (JSON.parse(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8")) as { solanaSendOut?: { to?: unknown; stage?: unknown } }).solanaSendOut;
    if (!b || typeof b.to !== "string") return { stage: null, dest: null, secret };
    return { stage: typeof b.stage === "string" ? b.stage : null, dest: secret ? openDest(b.to, secret) : null, secret };
  } catch {
    return { stage: null, dest: null, secret };
  }
}

/** Called once at start. Does nothing while deploy/live-rules.json has no solanaSendOut block. */
export function startSendOut(): void {
  if (process.env.SENDOUT === "off") return;
  const rpcUrls = () => [shared.rpcUrl(), "https://api.mainnet-beta.solana.com"].filter((x): x is string => typeof x === "string" && x.length > 0);
  const rpc: Rpc = async <T>(method: string, params: unknown[]) => {
    let last: unknown = null;
    for (const url of rpcUrls()) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
        const j = (await r.json()) as { result?: T; error?: { message?: string } };
        if (j.error) throw new Error(`rpc: ${String(j.error.message ?? "error").slice(0, 80)}`);
        return j.result as T;
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error("rpc failed");
  };
  const d: Deps = {
    plan: realPlan,
    wallets: () => [
      ["spot copy", wallet()],
      ["spot rules", namedWallet("buckets")],
      ["perps", namedWallet("perps")],
    ],
    holdings: async (owner) => {
      const bal = await rpc<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]);
      const r = await rpc<{ value: { pubkey: string; account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } } } }[] }>("getTokenAccountsByOwner", [owner, { programId: TOKEN_PROGRAM }, { encoding: "jsonParsed", commitment: "confirmed" }]);
      return { lamports: bal.value, accounts: r.value.map((x) => ({ address: x.pubkey, mint: x.account.data.parsed.info.mint, amount: BigInt(x.account.data.parsed.info.tokenAmount.amount), decimals: x.account.data.parsed.info.tokenAmount.decimals })) };
    },
    blockhash: async () => (await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash,
    send: (b64) => rpc<string>("sendTransaction", [b64, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 }]),
    status: async (sig) => {
      const r = await rpc<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>("getSignatureStatuses", [[sig], { searchTransactionHistory: true }]);
      const v = r.value[0];
      if (!v) return "unknown";
      if (v.err) return "failed";
      return v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized" ? "confirmed" : "unknown";
    },
    load: () => loadJson<SendState>(FILE, fresh()),
    save: (s) => saveJson(FILE, s),
    now: () => Date.now(),
  };
  setInterval(() => void sendOutTick(d).catch(() => undefined), 30_000).unref();
}

/**
 * The send-out is money taken out, never a loss (20 Nov 2026 rule: transfers we trigger are not a win or a loss).
 * Booked on the worth chart as a withdrawal from each wallet at the SOL price of the minutes it went (24 Nov 2026
 * 07:45-07:56 UTC, status solUsd 71.53-71.60). The 0.01 SOL test went twice from the spot copy wallet: the first try
 * was given up as unseen but landed (the spot copy wallet's drop is 0.0515 SOL, not 0.0415). Read by status.ts.
 */
export const SENT_SOL_USD = 71.6;
const PLACE: Record<string, string> = { "spot copy": "solana-spot-copy", "spot rules": "solana-spot-rules", perps: "solana-perps" };
export function sendOutMoves(s: SendState = loadJson<SendState>(FILE, fresh())): { from: string; to: string; startedAt: number; endedAt: number; arrivedUsd: number }[] {
  const out: { from: string; to: string; startedAt: number; endedAt: number; arrivedUsd: number }[] = [];
  if (s.test?.confirmed && s.test.lamports) out.push({ from: "solana-spot-copy", to: "enrique", startedAt: s.test.at, endedAt: s.test.at, arrivedUsd: (2 * s.test.lamports * SENT_SOL_USD) / 1e9 });
  for (const [k, w] of Object.entries(s.wallets)) for (const t of w.txs) if (t.confirmed && t.lamports && PLACE[k]) out.push({ from: PLACE[k], to: "enrique", startedAt: t.at, endedAt: t.at, arrivedUsd: (t.lamports * SENT_SOL_USD) / 1e9 });
  return out;
}
