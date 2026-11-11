/**
 * One-off withdrawal from the prediction wallet (11 Nov 2026, enrique: "send me 50$ of the prediction wallet",
 * "send me regular usdc or whatever", "just adjust every number").
 *
 * What it can do, and nothing else:
 *   - two sends, fixed in code: a $1 test, then the remaining $49 ($50 in total, never more);
 *   - one destination: it is not in this public repo in readable form. deploy/live-rules.json carries it sealed
 *     (AES-256-GCM) with a key only the server holds, so a changed or made-up value does not open and nothing is sent;
 *   - the $49 goes only after the $1 was seen arriving on chain at the destination;
 *   - each send is one all-or-nothing wallet batch: pUSD -> USDC.e (Polymarket's offramp) -> native USDC (Uniswap
 *     0.01% pool), paid straight to the destination. If any step fails the whole batch is undone.
 *
 * deploy/live-rules.json: "withdraw": { "to": "<sealed>", "stage": "test" | "rest" }. No block, no send.
 * State: data/withdraw-state.json (server only). Status shows numbers only: no address, no transaction id.
 * To be removed once both sends are confirmed.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultAbiCoder } from "@ethersproject/abi";
import { DATA, ROOT } from "./config.js";
import { loadJson, saveJson } from "./store.js";

export const WITHDRAW_STAGES = { test: 1, rest: 49 } as const;
export type StageName = keyof typeof WITHDRAW_STAGES;
export const WITHDRAW_TOTAL = 50;
/** A second try only after the first one can no longer land (the relayer deadline is 10 minutes). */
export const RETRY_WAIT_MS = 20 * 60_000;
export const MAX_TRIES = 2;

export type Stage = { tries: number; lastTryAt: number; baseline: number | null; sent: boolean; confirmed: boolean; received: number | null; at: number | null; error: string | null };
export type WithdrawState = Partial<Record<StageName, Stage>>;
const FILE = "withdraw-state.json";
const fresh = (): Stage => ({ tries: 0, lastTryAt: 0, baseline: null, sent: false, confirmed: false, received: null, at: null, error: null });

/** The checksummed form of an address; throws on a mixed-case address whose checksum is wrong. */
export const getAddress = (a: string): string => String(defaultAbiCoder.decode(["address"], defaultAbiCoder.encode(["address"], [a]))[0]);

const keyOf = (secret: string) => createHash("sha256").update(`predbot-withdraw-2026-11-11:${secret.trim()}`).digest();

/** Seal an address for the repo file (used once, off the server; kept here so the test can round-trip it). */
export function sealDest(address: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const body = Buffer.concat([c.update(getAddress(address), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

/** The destination, or null when the value does not open with this key or is not a valid checksummed address. */
export function openDest(sealed: string, secret: string): string | null {
  try {
    const raw = Buffer.from(sealed, "base64");
    if (raw.length < 12 + 16 + 42) return null;
    const d = createDecipheriv("aes-256-gcm", keyOf(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
    return /^0x[0-9a-fA-F]{40}$/.test(text) && getAddress(text) === text ? text : null;
  } catch {
    return null;
  }
}

/** Nothing that looks like an address or a transaction id may reach status or logs. */
export const scrub = (text: string) => text.replace(/0x[0-9a-fA-F]{6,}/g, "0x…").slice(0, 160);

export type Step = { do: "nothing" | "confirm" | "send"; stage?: StageName; amount?: number; why?: string };

/**
 * What to do now. `destBalance` is the destination's native USDC as just read from the chain, `pusd` what the wallet holds.
 * Pure, so the limits can be tested: the stage order, the retry wait, the try limit and the $50 total all live here.
 */
export function nextStep(state: WithdrawState, wanted: string | undefined, destBalance: number, pusd: number, now: number): Step {
  if (wanted !== "test" && wanted !== "rest") return { do: "nothing", why: "no stage asked for" };
  const stage: StageName = !state.test?.confirmed ? "test" : "rest";
  if (stage === "rest" && wanted !== "rest") return { do: "nothing", why: "test done; the rest waits for its go" };
  const st = state[stage] ?? fresh();
  const amount = WITHDRAW_STAGES[stage];
  if (st.confirmed) return { do: "nothing", why: "all done" };
  if (st.baseline != null && destBalance - st.baseline >= amount * 0.99) return { do: "confirm", stage, amount };
  const done = (Object.keys(WITHDRAW_STAGES) as StageName[]).reduce((a, k) => a + (state[k]?.confirmed ? WITHDRAW_STAGES[k] : 0), 0);
  if (done + amount > WITHDRAW_TOTAL) return { do: "nothing", why: "the $50 total is reached" };
  if (st.tries >= MAX_TRIES) return { do: "nothing", why: `stopped after ${MAX_TRIES} tries; needs a look` };
  if (st.tries > 0 && now - st.lastTryAt < RETRY_WAIT_MS) return { do: "nothing", why: "waiting to see the last try arrive" };
  if (pusd < amount + 1) return { do: "nothing", why: "the wallet does not hold enough pUSD" };
  return { do: "send", stage, amount };
}

export function withdrawState(): WithdrawState {
  return loadJson<WithdrawState>(FILE, {});
}
export function saveWithdrawState(s: WithdrawState) {
  saveJson(FILE, s);
}
/** Why the last pass did nothing (server-only file, shown in status as plain words). */
export function noteWithdraw(why: string) {
  saveJson("withdraw-note.json", { at: Date.now(), why: scrub(why) });
}
export function stageOf(s: WithdrawState, k: StageName): Stage {
  return (s[k] ??= fresh());
}

/** The repo block and the opened destination; null when there is no block or it does not open with the server's key. */
export function withdrawPlan(): { stage?: string; dest: string | null } | null {
  let block: { to?: unknown; stage?: unknown } | undefined;
  try {
    block = JSON.parse(readFileSync(join(ROOT, "deploy", "live-rules.json"), "utf8")).withdraw;
  } catch {
    return null;
  }
  if (!block || typeof block.to !== "string") return null;
  let secret = "";
  try {
    secret = readFileSync(join(DATA, "jev-key.txt"), "utf8").trim();
  } catch {
    // no key on this machine: the destination stays closed
  }
  return { stage: typeof block.stage === "string" ? block.stage : undefined, dest: secret ? openDest(block.to, secret) : null };
}

/** Dollars confirmed out of the wallet: taken off "deposits" so the wallet-vs-ledger line does not read it as a loss. */
export function withdrawnUsd(): number {
  const s = withdrawState();
  return (Object.keys(WITHDRAW_STAGES) as StageName[]).reduce((a, k) => a + (s[k]?.confirmed ? WITHDRAW_STAGES[k] : 0), 0);
}

/** For status: numbers and fixed words only. */
export function withdrawSummary() {
  const plan = withdrawPlan();
  const s = withdrawState();
  const row = (k: StageName) => {
    const st = s[k];
    return st ? { amount: WITHDRAW_STAGES[k], tries: st.tries, sent: st.sent, confirmed: st.confirmed, received: st.received, at: st.at, error: st.error ? scrub(st.error) : null } : null;
  };
  if (!plan && !s.test) return null;
  return { last: loadJson<{ at: number; why: string } | null>("withdraw-note.json", null), stage: plan?.stage ?? null, destinationReadable: plan ? plan.dest != null : null, withdrawn: withdrawnUsd(), test: row("test"), rest: row("rest") };
}
