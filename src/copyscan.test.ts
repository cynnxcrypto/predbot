import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "copyscan-"));

const NOW = Date.parse("2026-11-21T13:00:00Z");
const day = 86400_000;
const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");

test("paper wallets that clearly lose or give nothing to copy are dropped early", async () => {
  const { copyPromote } = await import("./copyscan.js");
  const w = (name: string, days: number, extra: Record<string, unknown> = {}) => ({ name, address: name, addedAt: NOW - days * day, stage: "paper" as const, why: "", ...extra });
  const st = { lastScan: 0, scans: 0, lastError: null, screened: 0, passed: 0, log: [], wallets: [w("loser", 4), w("young-loser", 2), w("near-flat", 4), w("idle", 8), w("idle-young", 6), w("slow-but-copied", 8)] };
  const tr = (rule: string, pnl: number | null) => ({ rule, pnl, won: pnl == null ? null : pnl > 0, fillable: true });
  const trades = [
    ...Array.from({ length: 40 }, (_, i) => tr("copy-take-loser", i < 18 ? 1 : -1)), // -$4... 18 - 22 = -4
    tr("copy-take-loser", -1),
    ...Array.from({ length: 41 }, (_, i) => tr("copy-take-young-loser", i < 18 ? 1 : -1)),
    ...Array.from({ length: 41 }, (_, i) => tr("copy-take-near-flat", i < 20 ? 1 : -1)), // -$1: stays
    tr("copy-any-idle", null),
    ...Array.from({ length: 5 }, () => tr("copy-any-slow-but-copied", null)),
  ];
  const lines = copyPromote(st, trades, NOW);
  assert.deepEqual(st.wallets.map((x) => x.stage), ["dropped", "paper", "paper", "dropped", "paper", "paper"]);
  assert.match(lines[0], /loser dropped: paper 18 of 41 won, \$-5\.00 \(40\+ settled and behind\)/);
  assert.match(lines[1], /idle dropped: 1 copies in 7 days/);
});

test("wallets seen buying on the live socket become candidates once they bought enough", async () => {
  const { seenNote, seenCandidates, seenReset, seenSave, seenStatus } = await import("./copyseen.js");
  seenReset();
  for (let i = 0; i < 20; i++) seenNote(addr(1), { side: "BUY", usdc_size: 60, title: "Highest temperature in Seoul" }, NOW);
  for (let i = 0; i < 20; i++) seenNote(addr(2), { side: "BUY", usdc_size: 60, title: "Bitcoin Up or Down" }, NOW);
  for (let i = 0; i < 20; i++) seenNote(addr(3), { side: "BUY", usdc_size: 2, title: "LoL" }, NOW);
  for (let i = 0; i < 20; i++) seenNote(addr(4), { side: "SELL", usdc_size: 60, title: "LoL" }, NOW);
  for (let i = 0; i < 5; i++) seenNote(addr(5), { side: "BUY", usdc_size: 5000, title: "Fed" }, NOW);
  assert.deepEqual(seenCandidates(), [{ address: addr(1), usd: 1200 }]);
  assert.deepEqual(seenStatus(), { wallets: 4, candidates: 1 });
  seenSave(NOW + 8 * day); // a week without a buy: forgotten
  assert.equal(seenStatus().wallets, 0);
});

test("the rescan reads deeper boards and socket wallets, counts why wallets fail, and adds the ones that pass", async () => {
  const { copyScan, autoState, autoSummary, SCAN_VER, BOARD_PAGES } = await import("./copyscan.js");
  const pts = (weekly: number[]) => {
    // daily cumulative profit over 31 days whose last 4 weeks are `weekly`
    const out: { timestamp: number; economic_pnl: number; unrealized_pnl: number }[] = [];
    for (let d = 30; d >= 0; d--) {
      const elapsed = Math.max(0, 28 - d);
      const v = weekly.reduce((sum, w, k) => sum + w * Math.min(1, Math.max(0, (elapsed - 7 * k) / 7)), 0);
      out.push({ timestamp: (NOW - d * day) / 1000, economic_pnl: v, unrealized_pnl: 0 });
    }
    return out;
  };
  const acts = (usd: number) => Array.from({ length: 30 }, (_, i) => ({ type: "TRADE", side: "BUY", timestamp: (NOW - i * 4 * 3600_000) / 1000, usdc_size: usd, title: `Market ${i % 12}`, outcome: "Yes" }));
  const board = addr(0xb1); // on a board, one small losing week: passes now
  const stream = addr(0x51); // only seen on the socket: passes
  const small = addr(0x52); // socket wallet with $900 in positions: under the floor
  const twoDown = addr(0xb2);
  const weeksOf: Record<string, number[]> = { [board]: [1500, -200, 1500, 1200], [stream]: [900, 800, 700, 900], [small]: [900, 800, 700, 900], [twoDown]: [3000, -10, -10, 3000] };
  let pagesAsked = 0;
  const get = async <T>(url: string): Promise<T> => {
    const u = new URL(url);
    const user = u.searchParams.get("user") ?? "";
    if (u.pathname.endsWith("/leaderboard")) {
      const first = !u.searchParams.get("cursor");
      if (u.searchParams.get("category") === "weather" && u.searchParams.get("time_period") === "month") {
        pagesAsked += 1;
        return { data: first ? [{ user_id: board, user_name: "Board Guy", pnl: 5000 }, { user_id: twoDown, user_name: "two", pnl: 4000 }] : [{ user_id: addr(0xdead00 + pagesAsked), pnl: -1 }], pagination: { next_cursor: "c" } } as T;
      }
      return { data: [] } as T;
    }
    if (u.pathname.endsWith("/user-pnl")) return { data: { points: pts(weeksOf[user] ?? [0, 0, 0, 0]) } } as T;
    if (u.pathname.endsWith("/activity")) return { data: acts(50) } as T;
    if (u.pathname.endsWith("/value")) return [{ value: user === small ? 900 : 20_000 }] as T;
    throw new Error("unexpected " + url);
  };
  const lines = await copyScan([], addr(0xffff), get, NOW, async () => {}, [{ address: stream, usd: 9000 }, { address: small, usd: 8000 }, { address: board, usd: 1 }]);
  assert.equal(pagesAsked, BOARD_PAGES, "a board is read to the 10th page while it has a next page");
  const s = autoState();
  assert.deepEqual(s.wallets.map((w) => [w.name, w.stage]), [["boardguy", "paper"], [`w-${stream.slice(2, 8)}`, "paper"]]);
  assert.match(lines.join("\n"), /found on the live trade feed/);
  assert.equal(s.ver, SCAN_VER);
  const sum = autoSummary([]);
  assert.equal(sum.fromStream, 2, "the board wallet is not counted twice");
  assert.equal(sum.passed, 2);
  assert.equal(sum.passedStream, 1);
  assert.deepEqual(sum.fails, { "two or more losing weeks in the last N": 1, "under N in open positions": 1 });
  // a restart that resumes a scan does not read the refused wallets again
  assert.equal(Object.keys(s.failedAt ?? {}).length, 2);
});
