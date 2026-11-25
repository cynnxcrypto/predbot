/**
 * What the bridge has done and is doing (data/bridge-state.json, server only). Kept apart from the bridge itself so the
 * Hyperliquid funding can ask "is a move using my wallet?" without pulling the bridge in.
 */
import { loadJson, saveJson } from "../store.js";

export type Place = "hyperliquid" | "polymarket" | "base" | "solana-perps" | "solana-spot-rules" | "solana-spot-copy";
export const PLACES: Place[] = ["hyperliquid", "polymarket", "base", "solana-perps", "solana-spot-rules", "solana-spot-copy"];
export type Stage = "new" | "withdraw" | "test" | "rest" | "done" | "stopped";

export interface Pending {
  part: "test" | "rest";
  /** in the source token (USDC or SOL) */
  amount: number;
  at: number;
  /** "" until the send came back: a crash between the mark and the send can never lead to a second send */
  tx: string;
  srcBefore: number;
  dstBefore: number;
  /** the least that must arrive, in the destination token */
  minOut: number;
  tool: string;
}

export interface Move {
  id: string;
  from: Place;
  to: Place;
  usd: number;
  /** set when the order named them: which token leaves a Solana wallet, and how many dollars of it stay behind */
  token?: "USDC" | "SOL";
  keepUsd?: number;
  stage: Stage;
  why?: string;
  startedAt: number;
  endedAt?: number;
  /** what is still to be sent, in the source token */
  left: number;
  /** the withdrawal from Hyperliquid to its own Arbitrum wallet, when the move starts there */
  withdraw?: { at: number; before: number; usd: number; sent: boolean };
  pending?: Pending;
  /** sends that never left the wallet */
  tries: number;
  /** in the source token / the destination token */
  sent: number;
  arrived: number;
  /** what arrived, in dollars at the SOL price of each arrival (21 Nov 2026: "arrived" is in the destination token, and
   *  a move into a SOL wallet was booked in the worth as that many dollars) */
  arrivedUsd?: number;
  log: { t: number; what: string }[];
}

export interface BridgeState {
  moves: Record<string, Move>;
}
const FILE = "bridge-state.json";
export const loadBridge = (): BridgeState => {
  const s = loadJson<BridgeState>(FILE, { moves: {} });
  return s && typeof s.moves === "object" && s.moves ? s : { moves: {} };
};
export const saveBridge = (s: BridgeState) => saveJson(FILE, s);

const active = (m: Move) => m.stage !== "done" && m.stage !== "stopped";

/**
 * True while a real move is going through the Hyperliquid wallet on Arbitrum. The funding (src/hyperliquid/fund.ts)
 * then leaves the wallet alone: USDC just withdrawn from Hyperliquid must not be deposited straight back, and USDC
 * on its way in is counted by the bridge before it is deposited. A move that ended or was stopped holds nothing, so
 * whatever is left in the wallet goes (back) onto Hyperliquid by itself.
 */
export function bridgeHoldsHyperliquid(): boolean {
  return Object.values(loadBridge().moves).some((m) => active(m) && m.stage !== "new" && (m.from === "hyperliquid" || m.to === "hyperliquid"));
}

/** True while a real move is still going into or out of `place` (25 Nov 2026: the Solana send-out waits for SOL a move
 *  is bringing in, so the move can see its own arrival before the wallet is emptied). */
export function bridgeHoldsPlace(place: Place): boolean {
  return Object.values(loadBridge().moves).some((m) => active(m) && (m.from === place || m.to === place));
}
