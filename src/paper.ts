import type { BookRow, WindowRow } from "./recorder.js";
import { readAll } from "./store.js";

/**
 * `npm run paper [--left 30] [--cap 0.9] [--size 20]`: replay the recorded book with the projection rule.
 *
 * The market settles on the 60s average of the Chainlink feed ending at close, compared with the 60s
 * average ending at open. With L seconds left, the first (60-L) seconds of that closing average are
 * already known. The rule: at L seconds left, project the closing average as (known part) + (current
 * price for the rest), pick the side that projection favours, and buy it if its ask is at or under
 * `cap`, taking at most `size` dollars of shares from the levels actually on the book. Fees are
 * Polymarket's 7% * p * (1-p) per share. Nothing is sent anywhere; this only reads data/.
 */
const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const LEFT = arg("left", 30);
const CAP = arg("cap", 0.9);
const SIZE = arg("size", 20);

const windows = new Map(readAll<WindowRow>("windows").filter((r) => r.resolvedUp != null).map((r) => [r.window, r]));
const book = new Map<number, BookRow[]>();
for (const row of readAll<BookRow>("book")) {
  if (!book.has(row.window)) book.set(row.window, []);
  book.get(row.window)!.push(row);
}
for (const rows of book.values()) rows.sort((a, b) => a.t - b.t);

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
/** 60s average of the feed ending at open: from the stored field, else rebuilt from the previous window's rows. */
function openAverage(w: WindowRow): number | null {
  if (w.chainlinkTwap60AtOpen != null) return w.chainlinkTwap60AtOpen;
  const prev = book.get(w.window - 300) ?? [];
  const ticks = prev.filter((r) => r.chainlink && r.t >= w.window * 1000 - 60000).map((r) => r.chainlink!);
  return ticks.length >= 20 ? mean(ticks) : null;
}

type Trade = { window: number; side: "UP" | "DOWN"; shares: number; cost: number; fee: number; won: boolean; pnl: number; ask: number };
const trades: Trade[] = [];
let seen = 0;
let noAsk = 0;
let projRight = 0;
for (const w of windows.values()) {
  const rows = book.get(w.window) ?? [];
  const at = rows.find((r) => r.left <= LEFT);
  const openAvg = openAverage(w);
  if (!at || openAvg == null || !at.chainlink) continue;
  const closeMs = (w.window + 300) * 1000;
  const known = rows.filter((r) => r.chainlink && r.t >= closeMs - 60000 && r.t <= at.t).map((r) => r.chainlink!);
  if (!known.length) continue;
  const frac = Math.min(1, (at.t - (closeMs - 60000)) / 60000);
  const projected = mean(known)! * frac + at.chainlink * (1 - frac);
  const up = projected >= openAvg;
  seen += 1;
  if (up === w.resolvedUp) projRight += 1;
  const levels = up ? at.upAsks : at.downAsks;
  if (!levels?.length || levels[0][0] > CAP) {
    noAsk += 1;
    continue;
  }
  // Walk the levels at or under the cap until SIZE dollars are spent.
  let budget = SIZE;
  let shares = 0;
  let cost = 0;
  let fee = 0;
  for (const [price, qty] of levels) {
    if (price > CAP || budget <= 0) break;
    const take = Math.min(qty, budget / price);
    shares += take;
    cost += take * price;
    fee += take * 0.07 * price * (1 - price);
    budget -= take * price;
  }
  const won = up === w.resolvedUp;
  trades.push({ window: w.window, side: up ? "UP" : "DOWN", shares, cost, fee, won, pnl: (won ? shares : 0) - cost - fee, ask: levels[0][0] });
}

const money = (x: number) => `${x < 0 ? "-" : "+"}$${Math.abs(x).toFixed(2)}`;
console.log(`Projection rule at ${LEFT}s left, buy if ask <= ${CAP}, up to $${SIZE} per window, on ${windows.size} settled windows.`);
console.log(`Projection available in ${seen} windows and right in ${projRight} (${seen ? Math.round((projRight / seen) * 1000) / 10 : 0}%). No ask at or under the cap in ${noAsk}.`);
if (!trades.length) {
  console.log("No trades.");
  process.exit(0);
}
const wins = trades.filter((t) => t.won).length;
const pnl = trades.reduce((s, t) => s + t.pnl, 0);
const spent = trades.reduce((s, t) => s + t.cost, 0);
const fees = trades.reduce((s, t) => s + t.fee, 0);
console.log(`Trades: ${trades.length}, won ${wins} (${Math.round((wins / trades.length) * 1000) / 10}%), spent $${spent.toFixed(2)}, fees $${fees.toFixed(2)}, net ${money(pnl)} (${money((pnl / spent) * 100).replace("$", "")}% of stake)`);
const asks = trades.map((t) => t.ask).sort((a, b) => a - b);
console.log(`Entry ask: median ${Math.round(asks[Math.floor(asks.length / 2)] * 100)}c, range ${Math.round(asks[0] * 100)}c to ${Math.round(asks[asks.length - 1] * 100)}c; average fill $${(spent / trades.length).toFixed(2)} of $${SIZE}`);

console.log("\nBy day:");
const byDay = new Map<string, Trade[]>();
for (const t of trades) {
  const day = new Date(t.window * 1000).toISOString().slice(0, 10);
  byDay.set(day, [...(byDay.get(day) ?? []), t]);
}
for (const [day, ts] of byDay) {
  const w = ts.filter((t) => t.won).length;
  console.log(`  ${day}  trades ${String(ts.length).padStart(3)}  won ${String(w).padStart(3)}  net ${money(ts.reduce((s, t) => s + t.pnl, 0))}`);
}
console.log("\nWorst five:");
for (const t of [...trades].sort((a, b) => a.pnl - b.pnl).slice(0, 5)) {
  console.log(`  ${new Date(t.window * 1000).toISOString().slice(5, 16)}  ${t.side.padEnd(4)} at ${Math.round(t.ask * 100)}c  ${t.shares.toFixed(1)} shares  ${money(t.pnl)}`);
}
