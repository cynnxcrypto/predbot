import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "solhist-"));
const { analyseBuy, walletReport, historySummary, COST_PCT, _test } = await import("./history.js");
type ISwap = import("./history.js").ISwap;
type HBuy = import("./history.js").HBuy;

const MINT = "TokenMint1111111111111111111111111111111111";
const sw = (slot: number, index: number, wallet: string, sol: number, price: number, buy = true): ISwap => ({ slot, index, wallet, mint: MINT, buy, sol, price });

test("one past buy: the wave is counted around the wallet's own place in its block, the move from a next-block entry", () => {
  const lead = { wallet: "L", slot: 1000, index: 5, price: 1 };
  const swaps = [
    sw(995, 1, "early", 0.3, 0.95), // was buying before
    sw(1000, 2, "sameBlockBefore", 0.3, 0.98),
    sw(1000, 5, "L", 2, 1),
    sw(1000, 9, "f1", 0.3, 1.02), // same block, behind the wallet
    sw(1001, 0, "f2", 0.3, 1.05),
    sw(1002, 3, "f3", 0.3, 1.07),
    sw(1006, 0, "f4", 0.3, 1.2),
    sw(1012, 0, "s1", 0.3, 1.25, false), // somebody sells ~5 s later
    sw(1025, 0, "s2", 0.3, 1.1, false),
    sw(1075, 0, "s3", 0.3, 0.9, false),
  ];
  const a = analyseBuy(lead, swaps);
  assert.equal(a.f4, 4);
  assert.equal(a.b4, 2);
  const entry = (1.05 + 1.07) / 2;
  assert.equal(a.m5, Math.round((1.25 / entry - 1) * 1000) / 10);
  assert.equal(a.m10, Math.round((1.1 / entry - 1) * 1000) / 10);
  assert.equal(a.m30, Math.round((0.9 / entry - 1) * 1000) / 10);
  assert.equal(a.m60, Math.round((0.9 / entry - 1) * 1000) / 10, "no trade in the last window: the last traded price stands");
  // nobody came: entry at the wallet's own price, and getting out only costs the spread
  assert.deepEqual(analyseBuy(lead, [sw(1000, 5, "L", 2, 1)]), { f4: 0, b4: 0, m5: -2.5, m10: -2.5, m30: -2.5, m60: -2.5 });
  // a token too busy to read to the end: the later windows are left empty, not guessed
  const cut = analyseBuy(lead, swaps, 1020);
  assert.equal(cut.m5, a.m5);
  assert.equal(cut.m10, null);
  assert.equal(cut.m60, null);
});

const buy = (t: number, m10: number, f4 = 5, b4 = 0): HBuy => ({ t, slot: t, sol: 1, f4, b4, m5: m10, m10, m30: m10, m60: m10 });

test("a wallet is good only when both halves of its history pass; bots are set aside", () => {
  const strong = Array.from({ length: 40 }, (_, i) => buy(i, i % 4 === 0 ? -5 : 12));
  const r = walletReport("steady", "A", strong, 50, 4);
  assert.equal(r.good, true);
  assert.equal(r.wavePct, 100);
  assert.equal(r.older.n, 20);
  assert.ok(r.older.won / r.older.n >= 0.5 && r.newer.avgPct! > COST_PCT);
  // great early, bad lately: the whole history still looks fine, the newer half does not
  const faded = [...Array.from({ length: 20 }, (_, i) => buy(i, 40)), ...Array.from({ length: 20 }, (_, i) => buy(100 + i, -6))];
  const f = walletReport("faded", "B", faded, 50, 4);
  assert.ok(f.all.avgPct! > COST_PCT);
  assert.equal(f.good, false);
  assert.equal(walletReport("few", "C", strong.slice(0, 20), 50, 4).good, false, "under 30 buys");
  const bot = walletReport("machine", "D", strong, 5000, 300);
  assert.equal(bot.bot, true);
  assert.equal(bot.good, false);
});

test("runner: reads a wallet's past buys and the minute after each, counts credits, keeps no key", async () => {
  _test.reset();
  const W = "Wa11et11111111111111111111111111111111111111";
  const now = Math.floor(Date.now() / 1000);
  const tok = (owner: string, amount: number) => ({ mint: MINT, owner, uiTokenAmount: { uiAmountString: String(amount) } });
  const item = (slot: number, index: number, who: string, solOut: number, got: number, blockTime = now - 3600) => ({
    slot, transactionIndex: index, blockTime, transaction: { signatures: [`sig${slot}-${index}`], message: { accountKeys: [who, "Pool"] } },
    meta: { err: null, fee: 5000, preBalances: [10e9, 0], postBalances: [10e9 - solOut * 1e9 - 5000, 0], preTokenBalances: [tok("Pool", 1e6)], postTokenBalances: [tok("Pool", 1e6 - got), tok(who, got)] },
  });
  const calls: string[] = [];
  _test.setCfg({
    rpcUrl: () => "https://mainnet.helius-rpc.com/?api-key=SECRET",
    wallets: () => [{ name: "someone", address: W }],
    fetch: () => (async (_url: string, init: { body: string }) => {
      const { params } = JSON.parse(init.body) as { params: [string, { sortOrder: string; filters: Record<string, unknown> }] };
      calls.push(params[0]);
      const data = params[0] === W
        ? [item(5000, 3, W, 1, 1000)]
        : [item(5000, 3, W, 1, 1000), item(5001, 0, "f1", 0.5, 400), item(5001, 1, "f2", 0.5, 380), item(5002, 0, "f3", 0.5, 350), item(5025, 0, "f4", 0.5, 300)];
      return new Response(JSON.stringify({ result: { data, paginationToken: null } }));
    }) as never,
  });
  assert.equal(await _test.doWallet({ name: "someone", address: W }), true);
  const st = _test.state().wallets[W];
  assert.equal(st.buys.length, 1);
  assert.equal(st.buys[0].f4, 3);
  assert.ok(st.buys[0].m10! > 10, "followers kept paying more");
  assert.deepEqual(calls, [W, MINT]);
  assert.equal(_test.state().credits, 20);
  const sum = historySummary();
  assert.equal(sum.walletsDone, 1);
  assert.equal(sum.buysRead, 1);
  assert.ok(!JSON.stringify(sum).includes("SECRET"));
  // a second pass reads only what is new and does not count the same token again
  assert.equal(await _test.doWallet({ name: "someone", address: W }), true);
  assert.equal(_test.state().wallets[W].buys.length, 1);
});
