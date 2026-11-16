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
export const realRecord = (nets: number[]): RealRecord => ({ trades: nets.length, won: nets.filter((x) => x > 0).length, net: nets.reduce((a, x) => a + x, 0) });

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
