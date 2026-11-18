import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hllinks-"));
const { parseLedger, digest, matches, movedOf, judge, roundAmount, isHub, linksPublic, linksPrivate, linkedTraders, linksTick, tag, _test, LIKELY, POSSIBLE } = await import("./links.js");

const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const NOW = 1_800_000_000_000;
const H = 3_600_000;
const D = 24 * H;
const TRADER = A(1), SIDE = A(2), FUNDER = A(3), SIB = A(4), DESK = A(5), NEWW = A(6), STRANGER = A(7), SUB = A(8);
const row = (time: number, delta: Record<string, unknown>) => ({ time, hash: "0x" + time.toString(16), delta });
const xfer = (time: number, from: string, to: string, usdc: number) => row(time, { type: "internalTransfer", usdc: String(usdc), user: from, destination: to, fee: "0" });

test("parseLedger: deposits, withdrawals and transfers, by direction; own moves and strangers' rows skipped", () => {
  const f = parseLedger(
    [
      row(5, { type: "withdraw", usdc: "-500.0", nonce: 1, fee: "1.0" }),
      row(1, { type: "deposit", usdc: "1000.0" }),
      xfer(2, TRADER, SIDE, 300),
      xfer(3, FUNDER.toUpperCase().replace("0X", "0x"), TRADER, 200),
      row(4, { type: "spotTransfer", token: "USDC", amount: "10", usdcValue: "10", user: TRADER, destination: SIDE }),
      row(6, { type: "send", user: TRADER, destination: TRADER, usdcValue: "999" }),
      row(7, { type: "subAccountTransfer", usdc: "50", user: TRADER, destination: SUB }),
      row(8, { type: "accountClassTransfer", usdc: "70", toPerp: true }),
      xfer(9, SIDE, STRANGER, 5),
      { time: "x" },
      null,
    ],
    TRADER,
  );
  assert.deepEqual(f.map((x) => [x.t, x.kind, x.usd, x.other ?? null]), [
    [1, "deposit", 1000, null],
    [2, "out", 300, SIDE],
    [3, "in", 200, FUNDER],
    [4, "out", 10, SIDE],
    [5, "withdraw", 500, null],
    [7, "out", 50, SUB],
  ]);
  assert.equal(f[5].sub, true);
  assert.deepEqual(parseLedger({ nope: 1 }, TRADER), []);
});

test("digest: dust is not a counterpart, a sub-account always is", () => {
  const w = digest(parseLedger([xfer(1, TRADER, SIDE, 300), xfer(2, TRADER, SIDE, 10), xfer(3, STRANGER, TRADER, 1), row(4, { type: "subAccountTransfer", usdc: "5", user: TRADER, destination: SUB })], TRADER), NOW, true);
  assert.deepEqual(Object.keys(w.cps).sort(), [SIDE, SUB].sort());
  assert.deepEqual(w.cps[SIDE], { in: 0, out: 300, n: 1, last: 1 });
  assert.equal(w.cps[SUB].sub, true);
});

test("matches: same amount within three days, after the withdrawal, each withdrawal once; round amounts marked", () => {
  const t = digest(parseLedger([row(NOW - 10 * D, { type: "withdraw", usdc: "48731.22" }), row(NOW - 5 * D, { type: "withdraw", usdc: "10000" })], TRADER), NOW, true);
  const c = digest(
    parseLedger(
      [
        row(NOW - 11 * D, { type: "deposit", usdc: "48731.22" }), // before: no
        row(NOW - 10 * D + 3 * H, { type: "deposit", usdc: "48730.22" }), // a dollar less, 3 h later: yes
        row(NOW - 10 * D + 5 * H, { type: "deposit", usdc: "48730.22" }), // the withdrawal is used up
        row(NOW - 5 * D + 80 * H, { type: "deposit", usdc: "10000" }), // too late
        row(NOW - 5 * D + 2 * H, { type: "deposit", usdc: "10050" }), // not the same amount
      ],
      NEWW,
    ),
    NOW,
    true,
  );
  assert.deepEqual(matches(t, c), [{ out: 48731.22, in: 48730.22, hours: 3, round: false }]);
  const c2 = digest(parseLedger([row(NOW - 5 * D + 2 * H, { type: "deposit", usdc: "10000" })], NEWW), NOW, true);
  assert.deepEqual(matches(t, c2), [{ out: 10000, in: 10000, hours: 2, round: true }]);
  assert.equal(roundAmount(2500), true);
  assert.equal(roundAmount(48731.22), false);
});

test("movedOf: most of the account gone in 30 days", () => {
  const w = digest(parseLedger([row(NOW - 40 * D, { type: "withdraw", usdc: "90000" }), row(NOW - 3 * D, { type: "withdraw", usdc: "60000" }), row(NOW - 2 * D, { type: "deposit", usdc: "10000" })], TRADER), NOW, true);
  w.acct = 20_000;
  assert.deepEqual(movedOf(w, NOW), { out30: 60000, net30: 50000, moved: true, lastOutAt: NOW - 3 * D });
  w.acct = 400_000;
  assert.equal(movedOf(w, NOW).moved, false);
});

test("judge: money decides, behaviour alone is never 'possible', a service is set aside", () => {
  assert.equal(judge({ direct: { in: 0, out: 5, n: 1, last: 1, sub: true } }).label, "likely");
  const d = judge({ direct: { in: 0, out: 12_400, n: 3, last: 1 } });
  assert.equal(d.label, "possible");
  assert.match(d.reasons[0], /got \$12,400 from the trader \(3 transfers\)/);
  assert.equal(judge({ direct: { in: 0, out: 12_400, n: 3, last: 1 }, overlap: 0.8, shared: 8, traderCoins: 10, sameSide: 3 }).label, "likely");
  assert.equal(judge({ direct: { in: 0, out: 80, n: 1, last: 1 } }).label, "weak");
  assert.equal(judge({ funders: ["copy-0000aaaa"], match: [{ out: 48731.22, in: 48730.22, hours: 3, round: false }], bornDays: 1, overlap: 0.6, shared: 3, traderCoins: 5 }).label, "likely");
  assert.equal(judge({ match: [{ out: 10000, in: 10000, hours: 2, round: true }], overlap: 1, shared: 5, traderCoins: 5, sameSide: 4, bornDays: 0 }).label, "weak");
  const b = judge({ overlap: 1, shared: 9, traderCoins: 9, sameSide: 5, bornDays: 2 });
  assert.equal(b.score, 0);
  assert.equal(b.label, "weak");
  assert.equal(judge({ hub: true, direct: { in: 9e6, out: 9e6, n: 99, last: 1 } }).label, "service");
  assert.ok(LIKELY > POSSIBLE);
});

// ---- the whole read against a made-up Hyperliquid ---------------------------------------------------------------------
const fills = (coins: string[], t = NOW - D) => coins.map((coin, i) => ({ coin, time: t + i }));
const st = (acct: number, pos: Record<string, number>) => ({ marginSummary: { accountValue: String(acct) }, assetPositions: Object.entries(pos).map(([coin, szi]) => ({ position: { coin, szi: String(szi) } })) });
function world() {
  const deskRows = Array.from({ length: 40 }, (_, i) => xfer(NOW - 20 * D + i, DESK, A(100 + i), 500));
  const ledger: Record<string, unknown[]> = {
    [TRADER]: [xfer(NOW - 50 * D, FUNDER, TRADER, 20_000), xfer(NOW - 30 * D, TRADER, SIDE, 12_400), xfer(NOW - 25 * D, DESK, TRADER, 500), row(NOW - 8 * D, { type: "withdraw", usdc: "48731.22" }), xfer(NOW - 60 * D, STRANGER, TRADER, 3)],
    [SIDE]: [xfer(NOW - 30 * D, TRADER, SIDE, 12_400)],
    [FUNDER]: [xfer(NOW - 50 * D, FUNDER, TRADER, 20_000), xfer(NOW - 9 * D, FUNDER, SIB, 15_000)],
    [SIB]: [xfer(NOW - 9 * D, FUNDER, SIB, 15_000)],
    [DESK]: [xfer(NOW - 25 * D, DESK, TRADER, 500), ...deskRows],
    [NEWW]: [row(NOW - 8 * D + 4 * H, { type: "deposit", usdc: "48730.22" })],
    [STRANGER]: [row(NOW - 8 * D + 4 * H, { type: "deposit", usdc: "7000" })],
  };
  const fl: Record<string, unknown[]> = { [TRADER]: fills(["BTC", "ETH", "HYPE", "SOL"]), [SIDE]: fills(["BTC", "ETH", "HYPE", "DOGE"]), [SIB]: fills(["XRP"]), [NEWW]: fills(["BTC", "ETH", "HYPE", "SOL"]), [FUNDER]: [], [DESK]: [] };
  const cs: Record<string, unknown> = { [TRADER]: st(9000, { BTC: 1, ETH: -2 }), [SIDE]: st(30_000, { BTC: 3, ETH: -1 }), [SIB]: st(15_000, { XRP: 1 }), [NEWW]: st(50_000, { BTC: 2, ETH: -5 }), [FUNDER]: st(100, {}), [DESK]: st(1e6, {}) };
  const calls: string[] = [];
  const fetcher = (async (_u: unknown, init?: { body?: string }) => {
    const b = JSON.parse(init!.body!) as { type: string; user: string };
    calls.push(`${b.type}:${b.user}`);
    const body = b.type === "userNonFundingLedgerUpdates" ? (ledger[b.user] ?? []) : b.type === "userFills" ? (fl[b.user] ?? []) : (cs[b.user] ?? st(0, {}));
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test("a trader who moved out: side wallet, sibling by funder, new wallet by matching deposit; the desk and the stranger are not named", async () => {
  _test.reset();
  const { fetcher, calls } = world();
  const records: Record<string, { trades: number; won: number; netUsd: number }> = { [tag(SIDE)]: { trades: 4, won: 3, netUsd: 1.234 } };
  _test.set({ fetch: () => fetcher, liked: () => [{ address: TRADER, why: "real" }], board: () => [{ address: NEWW, acct: 50_000 }, { address: STRANGER, acct: 45_000 }, { address: TRADER, acct: 9000 }], record: (t) => records[t] ?? { trades: 0, won: 0, netUsd: 0 }, wait: async () => undefined, now: () => NOW });
  await linksTick();
  const t = _test.state().traders[TRADER];
  assert.equal(t.error, undefined);
  assert.equal(t.moved, true);
  assert.equal(t.poolChecked, 2);
  const by = Object.fromEntries(t.links.map((l) => [l.address, l]));
  assert.equal(by[SIDE].label, "likely"); // $12,400 straight from the trader + 3 of 4 coins + same side on 2
  assert.equal(by[SIDE].how, "money");
  assert.equal(by[NEWW].label, "possible"); // matching deposit 4 h later + all his coins + same side + born then
  assert.equal(by[NEWW].how, "match");
  assert.ok(by[NEWW].reasons.some((r) => /deposit of \$48,730 landed 4 h after the trader withdrew \$48,731/.test(r)));
  assert.equal(by[SIB].how, "funder");
  assert.equal(by[SIB].label, "weak"); // paid by the same wallet, nothing else: shown to nobody
  assert.equal(by[DESK].label, "service");
  assert.equal(by[FUNDER].label, "possible"); // sent the trader $20,000: likely the owner's own main wallet
  assert.equal(by[STRANGER], undefined);
  assert.ok(!calls.some((c) => c === `userFills:${STRANGER}`)); // a pool wallet with no match costs one read only
  // followed on paper: those that trade; the funder has no fills
  assert.deepEqual(linkedTraders(NOW).sort(), [SIDE, NEWW].sort());
  const pub = linksPublic(NOW);
  assert.equal(pub.likely, 1);
  assert.equal(pub.possible, 2);
  assert.equal(pub.onPaper, 2);
  assert.equal(pub.tradersMoved, 1);
  const text = JSON.stringify(pub);
  for (const a of [TRADER, SIDE, NEWW, SIB, FUNDER, DESK]) assert.ok(!text.includes(a), "no full address in the public status");
  const side = pub.traders[0].links.find((l) => l.id === tag(SIDE))!;
  assert.deepEqual(side.paper, { trades: 4, won: 3, net: 1.23 });
  assert.equal(side.onPaper, true);
  assert.ok(pub.traders[0].links.every((l) => l.score >= POSSIBLE));
  assert.ok(JSON.stringify(linksPrivate(NOW)).includes(SIDE));
  // nothing is read twice within the day
  const n = calls.length;
  await linksTick();
  assert.equal(calls.length, n);
});

test("a trader that cannot be read keeps the last result and is tried again; one no longer liked leaves with its links", async () => {
  _test.reset();
  const { fetcher } = world();
  let liked = [{ address: TRADER, why: "bar" }];
  let fail = false;
  let now = NOW;
  const f = (async (u: unknown, init?: unknown) => (fail ? { ok: false, status: 429, json: async () => null } : (fetcher as unknown as (a: unknown, b: unknown) => Promise<unknown>)(u, init))) as unknown as typeof fetch;
  _test.set({ fetch: () => f, liked: () => liked, board: () => [], record: () => ({ trades: 0, won: 0, netUsd: 0 }), wait: async () => undefined, now: () => now });
  await linksTick();
  assert.ok(_test.state().traders[TRADER].links.length > 0);
  assert.equal(_test.state().traders[TRADER].at, NOW - 23 * H, "moved out and no leaderboard yet: read again in an hour");
  fail = true;
  now = NOW + 25 * H;
  await linksTick();
  const t = _test.state().traders[TRADER];
  assert.equal(t.error, "http 429");
  assert.ok(t.links.length > 0);
  liked = [];
  await linksTick();
  assert.deepEqual(_test.state().traders, {});
  assert.deepEqual(linkedTraders(now), []);
  assert.equal(isHub(digest([], NOW, true)), false);
});
