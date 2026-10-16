import type { WindowRow } from "./recorder.js";
import { readAll } from "./store.js";

/**
 * `npm run report`: what the recorded windows say so far.
 * 1. Which settlement rule matches Polymarket's results (this must be ~100% before any model is trusted).
 * 2. How close windows finish to the open (how much is a coin flip).
 * 3. What the book charged for the eventual winner at each checkpoint, and how often the price favourite won.
 */
const rows = readAll<WindowRow>("windows").filter((row) => row.resolvedUp != null);
if (!rows.length) {
  console.log("No settled windows recorded yet. Leave the recorder running.");
  process.exit(0);
}
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : "—");
console.log(`Settled windows: ${rows.length} (${new Date(rows[0].window * 1000).toISOString().slice(0, 16)} to ${new Date(rows[rows.length - 1].window * 1000).toISOString().slice(0, 16)})`);

console.log("\nSettlement rule check: 'UP' means close >= open under that rule. Agreement with Polymarket's result:");
const rules: [string, (r: WindowRow) => boolean | null][] = [
  ["chainlink 60s avg at close vs 60s avg at open (the market's rule)", (r) => cmp(r.chainlinkTwap60, r.chainlinkTwap60AtOpen)],
  ["official close vs official open", (r) => cmp(r.close, r.open)],
  ["chainlink last tick vs chainlink at open", (r) => cmp(r.chainlinkAtClose, r.chainlinkAtOpen)],
  ["chainlink last tick vs official open", (r) => cmp(r.chainlinkAtClose, r.open)],
  ["chainlink 60s average vs official open", (r) => cmp(r.chainlinkTwap60, r.open)],
  ["chainlink window average vs official open", (r) => cmp(r.chainlinkMean, r.open)],
  ["binance last vs binance at open", (r) => cmp(r.binanceAtClose, r.binanceAtOpen)],
  ["coinbase last vs coinbase at open", (r) => cmp(r.coinbaseAtClose, r.coinbaseAtOpen)],
];
for (const [name, rule] of rules) {
  let n = 0;
  let agree = 0;
  for (const row of rows) {
    const call = rule(row);
    if (call == null) continue;
    n += 1;
    if (call === row.resolvedUp) agree += 1;
  }
  console.log(`  ${name.padEnd(44)} ${pct(agree, n).padStart(6)}  (${agree}/${n})`);
}

const moves = rows.map((r) => (r.close != null && r.open != null ? ((r.close - r.open) / r.open) * 1e4 : null)).filter((n): n is number => n != null);
if (moves.length) {
  const abs = moves.map(Math.abs).sort((a, b) => a - b);
  const q = (p: number) => abs[Math.min(abs.length - 1, Math.floor(p * abs.length))].toFixed(1);
  console.log(`\nClose minus open, in basis points: median ${q(0.5)}, 75th ${q(0.75)}, 90th ${q(0.9)}; ups ${pct(moves.filter((m) => m >= 0).length, moves.length)}`);
}

console.log("\nBook at each checkpoint (seconds left): winner's ask, how often the cheaper side lost, and the cost to buy the winner:");
console.log("  left   n    winner ask (median)   favourite won   favourite ask (median)   both asks sum");
const byLeft = new Map<number, { winnerAsk: number[]; favWon: number; favAsk: number[]; sum: number[]; n: number }>();
for (const row of rows) {
  for (const mark of row.marks ?? []) {
    const [left, upAsk, , downAsk] = mark;
    if (left == null || upAsk == null || downAsk == null) continue;
    const slot = byLeft.get(left) ?? { winnerAsk: [], favWon: 0, favAsk: [], sum: [], n: 0 };
    const winnerAsk = row.resolvedUp ? upAsk : downAsk;
    const favUp = upAsk >= downAsk;
    slot.n += 1;
    slot.winnerAsk.push(winnerAsk);
    slot.favAsk.push(Math.max(upAsk, downAsk));
    slot.sum.push(upAsk + downAsk);
    if (favUp === row.resolvedUp) slot.favWon += 1;
    byLeft.set(left, slot);
  }
}
for (const [left, slot] of [...byLeft.entries()].sort((a, b) => b[0] - a[0])) {
  console.log(`  ${String(left).padStart(4)} ${String(slot.n).padStart(4)}   ${cents(median(slot.winnerAsk)).padStart(18)}   ${pct(slot.favWon, slot.n).padStart(12)}   ${cents(median(slot.favAsk)).padStart(22)}   ${cents(median(slot.sum)).padStart(13)}`);
}
console.log("\nRead it like this: if the favourite wins less often than its ask (plus 4 to 8 cents of cost), buying the favourite loses. If 'both asks sum' is under $1, a maker on both sides is being paid.");

function cmp(a: number | null, b: number | null): boolean | null {
  return a != null && b != null ? a >= b : null;
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function cents(n: number | null) {
  return n == null ? "—" : `${Math.round(n * 100)}¢`;
}
