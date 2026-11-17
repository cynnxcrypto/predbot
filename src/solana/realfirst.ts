/**
 * Real results come first (enrique, 16 Nov 2026 11:03 KST: "u have to cut loser and bring winners", "real is more
 * important"). One rule for every real side that promotes from paper (perps, spot buckets):
 *  - a trader or rule gets its FIRST real trades on its paper record (the bar);
 *  - once it has real trades, its REAL record decides: it stays real while its real net is zero or better, even if
 *    its paper record has fallen under the bar;
 *  - it is cut (back to paper) when its real net is below zero after CUT_MIN_TRADES or more real trades, or at its
 *    loss stop, whichever comes first; it returns only on paper trades made after the cut.
 * "Real record" always means the real trades made since it was last cut.
 */
export const CUT_MIN_TRADES = 3;

export interface RealRecord {
  trades: number;
  won: number;
  net: number;
}
/** The net is rounded to nine places: a sum of cents that is exactly level must read 0, not -2.8e-17 (which would be cut). */
export const realRecord = (nets: number[]): RealRecord => ({ trades: nets.length, won: nets.filter((x) => x > 0).length, net: Math.round(nets.reduce((a, x) => a + x, 0) * 1e9) / 1e9 || 0 });

/** Why a trader or rule must go back to paper now, or "" when it may stay. `stop` is its loss stop (0 = none). */
export function cutReason(real: RealRecord, stop: number): string {
  if (stop > 0 && real.net <= -stop) return "cut: real trades reached the loss stop";
  if (real.trades >= CUT_MIN_TRADES && real.net < 0) return `cut: real record behind after ${real.trades} trades`;
  return "";
}

/** Is it traded for real now, and why. `cutWhy` is the reason of its last cut, if it was ever cut. */
export function standing(real: RealRecord, paperAtBar: boolean, cutWhy = ""): { real: boolean; why: string } {
  if (real.trades > 0 && real.net >= 0) return { real: true, why: `real: its real record is ${real.net > 0 ? "ahead" : "level"} (${real.won} of ${real.trades} won)${paperAtBar ? "" : "; paper record is under the bar"}` };
  if (paperAtBar) return { real: true, why: real.trades ? `real: paper record at the bar; real record behind after ${real.trades} of ${CUT_MIN_TRADES} trades` : cutWhy ? "real: back on new paper trades at the bar" : "real: paper record at the bar" };
  if (real.trades) return { real: false, why: `paper: real record behind after ${real.trades} trades and paper record under the bar` };
  return { real: false, why: cutWhy ? `paper: ${cutWhy}; returns on new paper trades at the bar` : "paper: paper record not at the bar yet" };
}

/**
 * SCALE WHAT WORKS, SMARTLY (enrique, 17 Nov 2026 15:16 KST: "anything that is a rule that consistently goes positive
 * or a trader that consistently goes positive should be able to scale up"; "we have to be smart about how we scale up
 * and down"). Read from its OWN real trades since its last cut, oldest first (`nets`), never from paper:
 *  - up to x2 at 5+ real trades, x3 at 10+, each only when half or more won, it is ahead, and it is STILL ahead without
 *    its single best trade (x3: by 2 base stakes or more), so one lucky win never sizes it up;
 *  - down fast: one step down when its newest 3 are behind, back to x1 when its newest 5 are behind too.
 * The caller caps the stake at a share of the wallet (SCALE_WALLET_SHARE) and at its hard limits; cuts are unchanged.
 */
export const SCALE_STEPS = [1, 2, 3];
export const SCALE_WALLET_SHARE = 0.2;
export function scaleOf(nets: number[], base: number): { mult: number; step: number; why: string } {
  const n = nets.length;
  const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
  const net = sum(nets);
  const won = nets.filter((x) => x > 0).length;
  const best = n ? Math.max(0, ...nets) : 0;
  const steady = won * 2 >= n && net > 0 && net - best > 0;
  let step = steady && n >= 10 && net - best >= 2 * base - 1e-9 ? 2 : steady && n >= 5 ? 1 : 0;
  let why = step ? `x${SCALE_STEPS[step]}: ${won} of ${n} real won, ahead without its best trade` : n >= 5 && net > 0 && !(net - best > 0) ? "x1: ahead only through one big win" : "x1: learning";
  if (step > 0 && n >= 5 && sum(nets.slice(-5)) < 0 && sum(nets.slice(-3)) < 0) {
    step = 0;
    why = "x1: its newest 5 real trades are behind";
  } else if (step > 0 && sum(nets.slice(-3)) < 0) {
    step -= 1;
    why = `x${SCALE_STEPS[step]}: one step down, its newest 3 real trades are behind`;
  }
  return { mult: SCALE_STEPS[step], step, why };
}
