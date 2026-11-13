/**
 * READ ONLY. enrique, 13 Nov 2026: "if the traders are using a very small amount of their wallet for the trade, it's
 * probably something we shouldnt follow, as it might be something they're doing to bait people".
 *
 * Splits the copies already collected by the size of the copied buy:
 *  - against that wallet's usual buy: the median of its EARLIER buys only (5 or more needed), so no hindsight;
 *  - in plain SOL.
 * Paper: every stored buy the status scores (not fomo, Helius stream, known within 30 s), priced 1 s after we knew,
 * the moment the real test landed on (copy-d1-tp10-t60 = the real exit, and copy-d1-x30), plus the instant entry for
 * reference. Real: every sent copy of the real test, matched to its paper signal by coin and the wallet's slot.
 * The wallet's holdings at the time are not recorded, so "share of the wallet" cannot be read; size against its
 * usual buy is the stand-in.
 *
 * Prints totals only: no wallet, coin, signature or anything of our own wallet.
 * Run from the bot's folder (it imports the bot's own scoring): cd ~/predbot && npx tsx /path/to/solana-buy-size.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Sig = { sig: string; wallet: string; name: string; mint: string; leaderSlot: number; leaderTime: number; leaderSol: number; knownMs: number; feed: string; fomo?: boolean };
type Real = { mint: string; leaderSlot: number; buy: string; netSol: number };

const root = process.cwd();
const data = process.env.DATA_DIR || join(root, "data");
const copy = await import(pathToFileURL(join(root, "src", "solana", "copy.ts")).href);
const { unrefuse, unlate, scalp, ret, verdictsBefore } = copy;

const lines = (f: string) => {
  try {
    return readFileSync(join(data, "solana", f), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const bySig = new Map<string, Sig>();
for (const l of lines("copy-signals.jsonl")) {
  try {
    const s = unrefuse(JSON.parse(l));
    bySig.set(s.sig, s);
  } catch {
    /* a torn line */
  }
}
const all = [...bySig.values()].sort((a, b) => a.knownMs - b.knownMs);
unlate(all);
const sigs = all.filter((s) => !s.fomo && s.feed === "helius transaction stream" && s.leaderTime > 0 && s.knownMs - s.leaderTime * 1000 <= 30_000 && s.leaderSol > 0);

// size against the wallet's usual buy, from its earlier buys only
const MIN_EARLIER = 5;
const median = (a: number[]) => {
  const b = [...a].sort((x, y) => x - y);
  return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2;
};
const earlier = new Map<string, number[]>();
const ratio = new Map<Sig, number | null>();
for (const s of sigs) {
  const e = earlier.get(s.wallet) ?? [];
  ratio.set(s, e.length >= MIN_EARLIER ? s.leaderSol / median(e) : null);
  earlier.set(s.wallet, [...e, s.leaderSol]);
}
const rel = (s: Sig) => {
  const x = ratio.get(s);
  if (x == null) return "no history (under 5 earlier buys)";
  if (x < 0.25) return "a: under 1/4 of its usual";
  if (x < 0.5) return "b: 1/4 to 1/2 of its usual";
  if (x <= 2) return "c: usual (1/2 to 2x)";
  return "d: over 2x its usual";
};
const abs = (s: Sig) => (s.leaderSol < 0.5 ? "a: under 0.5 SOL" : s.leaderSol < 1 ? "b: 0.5-1 SOL" : s.leaderSol < 2 ? "c: 1-2 SOL" : s.leaderSol < 5 ? "d: 2-5 SOL" : "e: 5+ SOL");
const small = (s: Sig) => (ratio.get(s) ?? 1) < 0.5;

const pct = (v: number) => Math.round(v * 1000) / 10;
function tally(list: Sig[], f: (s: Sig) => number | undefined) {
  const v = list.map(f).filter((x): x is number => typeof x === "number");
  const won = v.filter((x) => x > 0).length;
  const avg = v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  return `${String(v.length).padStart(5)} copies  ${v.length ? String(Math.round((won / v.length) * 100)).padStart(3) : "  -"}% won  ${v.length ? `${pct(avg) >= 0 ? "+" : ""}${pct(avg)}%` : "-"} a trade`;
}
const RULES: [string, (s: Sig) => number | undefined][] = [
  ["1 s late, +10% or 60 s (the real exit)", (s) => scalp(s, 1, 10)],
  ["1 s late, sell at 30 s", (s) => ret(s, 1, 30)],
  ["instant (faster than real), +10% or 60 s", (s) => scalp(s, 0, 10)],
];
function table(title: string, key: (s: Sig) => string, list = sigs) {
  console.log(`\n== PAPER by ${title}`);
  for (const [name, f] of RULES) {
    console.log(`  ${name}`);
    for (const k of [...new Set(list.map(key))].sort()) console.log(`    ${k.padEnd(38)} ${tally(list.filter((s) => key(s) === k), f)}`);
    console.log(`    ${"ALL".padEnd(38)} ${tally(list, f)}`);
  }
}

console.log(`paper buys scored: ${sigs.length} (of ${all.length} stored), ${new Set(sigs.map((s) => s.wallet)).size} wallets`);
console.log(`buy size, median ${median(sigs.map((s) => s.leaderSol)).toFixed(2)} SOL; buys under 0.1 SOL were never recorded`);
table("size against the wallet's usual buy (earlier buys only)", rel);
table("size in SOL", abs);

// the filter he asked for, alone and with the trader record
const verdict = verdictsBefore(sigs);
console.log("\n== PAPER: skip buys under half the wallet's usual");
for (const [name, f] of RULES) {
  console.log(`  ${name}`);
  console.log(`    ${"kept".padEnd(38)} ${tally(sigs.filter((s) => !small(s)), f)}`);
  console.log(`    ${"kept, trader not bad so far".padEnd(38)} ${tally(sigs.filter((s) => !small(s) && verdict.get(s as never) !== "bad"), f)}`);
  console.log(`    ${"kept, trader good so far".padEnd(38)} ${tally(sigs.filter((s) => !small(s) && verdict.get(s as never) === "good"), f)}`);
}
// halves, to see whether a difference holds over time
const mid = sigs[Math.floor(sigs.length / 2)]?.knownMs ?? 0;
console.log("\n== PAPER: 1 s late, +10% or 60 s, older half / newer half");
for (const k of [...new Set(sigs.map(rel))].sort()) {
  const g = sigs.filter((s) => rel(s) === k);
  console.log(`    ${k.padEnd(38)} older ${tally(g.filter((s) => s.knownMs < mid), RULES[0][1])} | newer ${tally(g.filter((s) => s.knownMs >= mid), RULES[0][1])}`);
}

// real copies
const bySlot = new Map<string, Sig>();
for (const s of all) bySlot.set(`${s.mint}|${s.leaderSlot}`, s);
const real: Real[] = [];
for (const l of lines("copylive-trades.jsonl")) {
  try {
    const r = JSON.parse(l) as Real;
    if (r.buy !== "not sent" && typeof r.netSol === "number") real.push(r);
  } catch {
    /* a torn line */
  }
}
const matched = real.map((r) => ({ r, s: bySlot.get(`${r.mint}|${r.leaderSlot}`) }));
console.log(`\n== REAL: ${real.length} sent copies, ${matched.filter((m) => m.s).length} matched to their paper signal`);
const realBy = (title: string, key: (s: Sig) => string) => {
  console.log(`  by ${title}`);
  const groups = new Map<string, Real[]>();
  for (const m of matched) {
    const k = m.s ? (ratio.has(m.s) ? key(m.s) : "matched, not in the scored set") : "not matched";
    groups.set(k, [...(groups.get(k) ?? []), m.r]);
  }
  for (const k of [...groups.keys()].sort()) {
    const g = groups.get(k)!;
    const net = g.reduce((a, r) => a + r.netSol, 0);
    console.log(`    ${k.padEnd(38)} ${String(g.length).padStart(4)} copies  ${String(Math.round((g.filter((r) => r.netSol > 0).length / g.length) * 100)).padStart(3)}% won  ${net >= 0 ? "+" : ""}${net.toFixed(3)} SOL  ${pct(net / (0.05 * g.length))}% a copy`);
  }
};
realBy("size against the wallet's usual buy", rel);
realBy("size in SOL", abs);
