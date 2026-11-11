import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "sollinks-"));
const { actOf, holders, earlyOf, digest, compare, judge, linksSummary, linkedWallets, seedWallets, poolPrice, replayOf, replaySummary, REPLAY_COST, REPLAY_SECS, _test } = await import("./links.js");
const { SEEDS } = await import("./seeds.js");
const { validAddress } = await import("./wallets.js");
type Item = import("./history.js").Item;

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RELAYER = "AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51";
// made-up addresses: 32 bytes each, one per name
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const made = new Map<string, string>();
function A(name: string): string {
  let a = made.get(name);
  if (!a) {
    let n = BigInt("0x" + createHash("sha256").update(name).digest("hex")) | (1n << 255n);
    let tail = "";
    while (n > 0n) {
      tail = B58[Number(n % 58n)] + tail;
      n /= 58n;
    }
    a = tail;
    made.set(name, a);
  }
  return a;
}
const SEED = SEEDS[0].address;
const SIDE = A("Side");
const POOL = A("PooL");
const COIN = (i: number) => A(`Co${i}n`);

type Tok = [mint: string, owner: string, pre: number, post: number];
/** the token account of one owner for one coin */
const ATA = (mint: string, owner: string) => A(`ata:${mint}:${owner}`);
/**
 * One transaction: `sol` = [address, change in SOL] with the fee payer first; `tok` = token balances before and after.
 * Token accounts follow in the key list, as on the chain, so a wallet can hold a balance without being named itself.
 */
function tx(slot: number, index: number, sol: [string, number][], tok: Tok[], t = 1_794_000_000 + slot): Item {
  const fee = 5000;
  const keys = sol.map(([a]) => a);
  const at = (mint: string, owner: string) => {
    const a = ATA(mint, owner);
    const j = keys.indexOf(a);
    return j >= 0 ? j : keys.push(a) - 1;
  };
  const bal = (mint: string, owner: string, o: number) => ({ accountIndex: at(mint, owner), mint, owner, uiTokenAmount: { uiAmountString: String(o) } });
  const pre = tok.filter(([, , p]) => p >= 0).map(([mint, owner, p]) => bal(mint, owner, p));
  const post = tok.map(([mint, owner, , q]) => bal(mint, owner, q));
  return {
    slot, transactionIndex: index, blockTime: t,
    transaction: { signatures: [`s${slot}-${index}`], message: { accountKeys: keys } },
    meta: {
      err: null, fee,
      preBalances: keys.map(() => 10e9),
      postBalances: keys.map((_, j) => 10e9 + Math.round((sol[j]?.[1] ?? 0) * 1e9) - (j === 0 ? fee : 0)),
      preTokenBalances: pre,
      postTokenBalances: post,
    },
  };
}
/** A fomo-style buy: the relayer signs and pays the fee, the wallet pays in USDC. */
const fomoBuy = (slot: number, index: number, who: string, mint: string, usd = 500) => tx(slot, index, [[RELAYER, 0], [who, 0]], [[USDC, who, 5000, 5000 - usd], [USDC, POOL, 9e5, 9e5 + usd], [mint, who, -1, 1000], [mint, POOL, 5e6, 5e6 - 1000]]);
const solBuy = (slot: number, index: number, who: string, mint: string, sol = 1) => tx(slot, index, [[who, -sol], [POOL, sol]], [[mint, who, -1, 1000], [mint, POOL, 5e6, 5e6 - 1000]]);
const solSell = (slot: number, index: number, who: string, mint: string, sol = 1.2) => tx(slot, index, [[who, sol], [POOL, -sol]], [[mint, who, 1000, 0], [mint, POOL, 5e6, 5e6 + 1000]]);
const usdSend = (slot: number, index: number, from: string, to: string, usd: number) => tx(slot, index, [[RELAYER, 0], [from, 0]], [[USDC, from, 5000, 5000 - usd], [USDC, to, 100, 100 + usd]]);
const solSend = (slot: number, index: number, from: string, to: string, sol: number) => tx(slot, index, [[from, -sol], [to, sol]], []);
/** A buy that names only the relayer and token accounts: the wallet shows up as the owner of a balance, nowhere else. */
const hiddenBuy = (slot: number, index: number, who: string, mint: string, usd = 500) => tx(slot, index, [[RELAYER, 0]], [[USDC, who, 5000, 5000 - usd], [USDC, POOL, 9e5, 9e5 + usd], [mint, who, -1, 1000], [mint, POOL, 5e6, 5e6 - 1000]]);
/** A stranger drops a worthless coin on a wallet. */
const drop = (slot: number, index: number, from: string, to: string, mint: string) => tx(slot, index, [[from, 0]], [[mint, from, 1e6, 1e6 - 1000], [mint, to, -1, 1000]]);

/**
 * A made-up chain behind getTransactionsForAddress. An address finds the transactions that name it (a wallet, a
 * token account or a coin); with tokenAccounts "balanceChanged" also those that changed a balance it owns.
 */
function fakeChain(items: Item[]) {
  type TB = { mint: string; owner?: string; accountIndex?: number; uiTokenAmount: { uiAmountString?: string } };
  const index = items.map((it) => {
    const post = (it.meta!.postTokenBalances ?? []) as TB[];
    const pre = (it.meta!.preTokenBalances ?? []) as TB[];
    const was = new Map(pre.map((b) => [b.accountIndex, b.uiTokenAmount.uiAmountString]));
    return {
      it,
      named: new Set([...it.transaction.message.accountKeys.map(String), ...post.map((b) => b.mint)]),
      changed: new Set(post.filter((b) => was.get(b.accountIndex) !== b.uiTokenAmount.uiAmountString).map((b) => b.owner ?? "")),
    };
  });
  const asked: { address: string; tokenAccounts?: string }[] = [];
  const fetch = (async (_url: string, init: { body: string }) => {
    const { params } = JSON.parse(init.body) as { params: [string, { sortOrder: string; paginationToken?: string; filters: { slot?: { gte: number; lte: number }; blockTime?: { gt: number }; tokenAccounts?: string } }] };
    const [address, o] = params;
    asked.push({ address, tokenAccounts: o.filters.tokenAccounts });
    let hits = index.filter((x) => x.named.has(address) || (o.filters.tokenAccounts === "balanceChanged" && x.changed.has(address))).map((x) => x.it);
    if (o.filters.slot) hits = hits.filter((x) => x.slot >= o.filters.slot!.gte && x.slot <= o.filters.slot!.lte);
    if (o.filters.blockTime) hits = hits.filter((x) => (x.blockTime ?? 0) > o.filters.blockTime!.gt);
    hits.sort((a, b) => (o.sortOrder === "asc" ? a.slot - b.slot || a.transactionIndex - b.transactionIndex : b.slot - a.slot || b.transactionIndex - a.transactionIndex));
    const from = Number(o.paginationToken ?? 0);
    const data = hits.slice(from, from + 100);
    return new Response(JSON.stringify({ result: { data, paginationToken: from + 100 < hits.length ? String(from + 100) : null } }));
  }) as never;
  return { fetch, asked };
}

test("the seeds are well-formed addresses", () => {
  assert.ok(SEEDS.length >= 4);
  for (const s of SEEDS) assert.ok(validAddress(s.address), s.name);
  assert.equal(new Set(SEEDS.map((s) => s.address)).size, SEEDS.length);
});

test("one transaction: buys, sales and plain transfers are told apart from balance changes alone", () => {
  // a fomo buy: the wallet neither pays the fee nor spends SOL
  assert.deepEqual(actOf(fomoBuy(100, 2, SEED, COIN(1)), SEED)?.buy, { mint: COIN(1), sol: 0, usd: 500 });
  assert.equal(actOf(fomoBuy(100, 2, SEED, COIN(1)), SEED)?.moves.length, 0, "the pool and the relayer are not money links");
  assert.deepEqual(actOf(solBuy(100, 2, SIDE, COIN(1), 2), SIDE)?.buy, { mint: COIN(1), sol: 2, usd: 0 });
  assert.equal(actOf(solSell(100, 2, SIDE, COIN(1)), SIDE)?.sell, COIN(1));
  // dollars sent on: seen from both ends
  const send = usdSend(101, 0, SEED, SIDE, 800);
  assert.deepEqual(actOf(send, SEED)?.moves, [{ out: true, address: SIDE, sol: 0, usd: 800 }]);
  assert.deepEqual(actOf(send, SIDE)?.moves, [{ out: false, address: SEED, sol: 0, usd: 800 }]);
  // SOL sent on, the sender paying the fee
  const s2 = solSend(102, 0, SEED, SIDE, 3);
  assert.deepEqual(actOf(s2, SEED)?.moves, [{ out: true, address: SIDE, sol: 3, usd: 0 }]);
  assert.deepEqual(actOf(s2, SIDE)?.moves, [{ out: false, address: SEED, sol: 3, usd: 0 }]);
  // a coin passed from one wallet to the other, nothing paid
  const pass = tx(103, 0, [[SIDE, 0], [SEED, 0]], [[COIN(2), SIDE, 1000, 0], [COIN(2), SEED, -1, 1000]]);
  assert.deepEqual(actOf(pass, SEED)?.moves, [{ out: false, address: SIDE, sol: 0, usd: 0, mint: COIN(2) }]);
  assert.deepEqual(actOf(pass, SIDE)?.moves, [{ out: true, address: SEED, sol: 0, usd: 0, mint: COIN(2) }]);
  // wrapping SOL is not a transfer; dust is ignored; a failed transaction is nothing
  const wrap = tx(104, 0, [[SEED, -2], [A("Wsol"), 2]], [[SOL, SEED, 0, 2]]);
  assert.equal(actOf(wrap, SEED), null);
  assert.equal(actOf(solSend(105, 0, SEED, SIDE, 0.01), SEED), null);
  const failed = solSend(106, 0, SEED, SIDE, 3);
  failed.meta!.err = { InstructionError: [0, "Custom"] };
  assert.equal(actOf(failed, SEED), null);
  assert.equal(actOf(solSend(107, 0, A("Xa"), A("Xb"), 3), SEED), null, "not in the transaction");
});

test("who started holding a coin: a new holder counts, the pool never does", () => {
  assert.deepEqual(holders(solBuy(100, 0, SIDE, COIN(1)), COIN(1)), { got: [SIDE], cut: [POOL] });
  assert.deepEqual(holders(solSell(100, 0, SIDE, COIN(1)), COIN(1)), { got: [], cut: [SIDE] }, "the pool gaining coins on a sale is not a buyer");
  // an empty account that already existed still counts as starting from nothing
  const again = tx(100, 0, [[SIDE, -1], [POOL, 1]], [[COIN(1), SIDE, 0, 500], [COIN(1), POOL, 5e6, 5e6 - 500]]);
  assert.deepEqual(holders(again, COIN(1)).got, [SIDE]);
});

test("around one buy of the seed: who was in before it, who of them sold after it", () => {
  const lead = { wallet: SEED, mint: COIN(1), slot: 1000, index: 5 };
  const pre = [fomoBuy(1000, 5, SEED, COIN(1)), solBuy(1000, 2, A("Sm"), COIN(1)), solBuy(960, 0, SIDE, COIN(1)), solBuy(400, 0, A("Old"), COIN(1))];
  const post = [fomoBuy(1000, 5, SEED, COIN(1)), solBuy(1000, 9, A("F1"), COIN(1)), solBuy(1003, 0, A("F2"), COIN(1)), solSell(1010, 0, SIDE, COIN(1)), solBuy(1400, 0, A("Late"), COIN(1))];
  const e = earlyOf(lead, pre, post);
  assert.deepEqual([...e.early.keys()].sort(), [A("Old"), SIDE, A("Sm")].sort());
  assert.deepEqual(e.early.get(SIDE), { leadSlots: 40, sold: true });
  assert.equal(e.early.get(A("Old"))!.sold, false);
  assert.equal(e.before30, 2, "the one from 4 min earlier is not part of the wave");
  assert.equal(e.after30, 2);
});

test("a side wallet shows up on both counts; an exchange and a stranger do not", () => {
  const seedItems = [1, 2, 3, 4].flatMap((i) => [fomoBuy(1000 * i, 5, SEED, COIN(i))]).concat([usdSend(500, 0, SEED, SIDE, 900), usdSend(2500, 0, SEED, SIDE, 700), solSend(3500, 0, SIDE, SEED, 4)]);
  const sideItems = [1, 2, 3].flatMap((i) => [solBuy(1000 * i - 30, 0, SIDE, COIN(i)), solSell(1000 * i + 40, 0, SIDE, COIN(i))]).concat([solBuy(4100, 0, SIDE, COIN(4)), usdSend(500, 0, SEED, SIDE, 900), usdSend(2500, 0, SEED, SIDE, 700), solSend(3500, 0, SIDE, SEED, 4)]);
  const s = digest(SEED, seedItems, 30);
  const c = digest(SIDE, sideItems, 30);
  assert.equal(s.buys.size, 4);
  assert.deepEqual(s.cps.get(SIDE), { out: 2, in: 1, sol: 4, usd: 1600, coins: 0 });
  const cmp = compare(s, c);
  assert.deepEqual(cmp, { shared: 4, before: 3, beforeWithin1h: 3, after: 1, soldInto: 3, medianLeadSec: 12, overlapPct: 100 });
  const base = { transfers: 3, twoStep: false, before: 3, after: 1, overlapPct: 100, txPerDay: 20, seeds: 1 };
  assert.equal(judge(base), "likely");
  assert.equal(judge({ ...base, txPerDay: 5000 }), "service or bot");
  assert.equal(judge({ ...base, seeds: 3 }), "service or bot", "tied to several seeds: shared plumbing, not a person");
  assert.equal(judge({ ...base, transfers: 0 }), "no sign", "first on 3 coins without a money link is not enough");
  assert.equal(judge({ ...base, transfers: 0, before: 6 }), "possible: buys ahead, no money link");
  assert.equal(judge({ ...base, transfers: 0, before: 6, overlapPct: 2 }), "no sign", "a sniper that buys everything");
  assert.equal(judge({ ...base, before: 0, after: 0 }), "money link only");
  assert.equal(judge({ ...base, transfers: 0, twoStep: true }), "likely");
  // one transfer is not a money link, unless it is a large one
  assert.equal(judge({ ...base, transfers: 1, before: 0, after: 0 }), "no sign");
  assert.equal(judge({ ...base, transfers: 1, big: true, before: 0, after: 0 }), "money link only");
});

test("runner: traces a seed on a made-up chain; the public summary carries tags, never the address or the key", async () => {
  _test.reset();
  const now = Math.floor(Date.now() / 1000);
  const T = (slot: number) => now - 86_400 + slot; // all of it a day ago
  const CEX = A("Cex");
  const chain: Item[] = [];
  const stamp = (it: Item) => ((it.blockTime = T(it.slot)), chain.push(it), it);
  for (const i of [1, 2, 3, 4]) {
    stamp(solBuy(1000 * i - 30, 0, SIDE, COIN(i)));
    stamp(solBuy(1000 * i - 10, 0, A(`R${i}`), COIN(i))); // a different stranger each time
    stamp(fomoBuy(1000 * i, 5, SEED, COIN(i)));
    stamp(solBuy(1000 * i + 2, 0, A(`F${i}`), COIN(i)));
    stamp(solSell(1000 * i + 40, 0, SIDE, COIN(i)));
  }
  stamp(usdSend(500, 0, SEED, SIDE, 900));
  stamp(usdSend(2500, 0, SEED, SIDE, 700));
  stamp(usdSend(300, 0, CEX, SEED, 5000));
  stamp(usdSend(350, 0, CEX, SEED, 5000));
  // the exchange is busy: far more transactions than a person makes
  const busy: Item[] = Array.from({ length: 1200 }, (_, k) => ({ ...usdSend(90_000 + k, 0, CEX, A(`U${k % 7}`), 50), blockTime: now - 3600 + k }));
  const net = fakeChain([...chain, ...busy]);
  _test.setCfg({ rpcUrl: () => "https://mainnet.helius-rpc.com/?api-key=SECRET", fetch: () => net.fetch });
  const r = await _test.doSeed(SEEDS[0]);
  assert.ok(r);
  assert.equal(r.buys, 4);
  assert.equal(r.buysUsd, 4);
  assert.equal(r.checked, 4);
  assert.equal(r.after30, 1);
  assert.equal(r.replay!.length, 4, "every checked buy is replayed");
  const side = r.linked.find((l) => l.address === SIDE)!;
  assert.deepEqual({ how: side.how, sent: side.sent, received: side.received, usd: side.usd, earlyCoins: side.earlyCoins, earlySold: side.earlySold, shared: side.shared, before: side.before, soldInto: side.soldInto }, { how: "money", sent: 2, received: 0, usd: 1600, earlyCoins: 4, earlySold: 4, shared: 4, before: 4, soldInto: 4 });
  const cex = r.linked.find((l) => l.address === CEX)!;
  assert.ok(cex.txPerDay > 1000);
  assert.ok(!r.linked.some((l) => [1, 2, 3, 4].some((i) => l.address === A(`R${i}`))), "a stranger who was early once is not a lead");
  _test.state().seeds[SEED] = r;
  const sum = linksSummary();
  const row = sum.seeds.find((s) => s.name === SEEDS[0].name)!;
  assert.equal(row.linked[0].verdict, "likely");
  assert.equal(row.linked.find((l) => l.wallet.startsWith(CEX.slice(0, 4)))!.verdict, "service or bot");
  assert.equal(sum.likely, 1);
  const text = JSON.stringify(sum);
  assert.ok(!text.includes(SIDE) && !text.includes(CEX) && !text.includes("SECRET"));
  assert.ok(text.includes(`${SIDE.slice(0, 4)}…${SIDE.slice(-4)}`));
  assert.deepEqual(linkedWallets(), [{ name: `side of ${SEEDS[0].name} ${SIDE.slice(0, 4)}`, address: SIDE, found: true }]);
  assert.ok(_test.state().credits > 0 && net.asked.length > 10);
});

test("dropped coins: a stranger's coin is not a money link, a coin the wallet passes on is", () => {
  const JUNK = A("Junk");
  const items = [drop(100, 0, A("Spam"), SEED, JUNK), drop(101, 0, A("Spam"), SEED, A("Junk2")), tx(200, 0, [[SEED, 0]], [[COIN(1), SEED, 1000, 0], [COIN(1), SIDE, -1, 1000]])];
  const r = digest(SEED, items, 30);
  assert.equal(r.cps.has(A("Spam")), false);
  assert.deepEqual(r.cps.get(SIDE), { out: 1, in: 0, sol: 0, usd: 0, coins: 1 });
});

test("runner: a seed buried under dropped coins is still read, through its dollar account", async () => {
  _test.reset();
  const now = Math.floor(Date.now() / 1000);
  const chain: Item[] = [];
  const put = (it: Item, ago: number) => ((it.blockTime = now - ago), chain.push(it), it);
  // five dollar-paid buys three weeks ago that never name the wallet, each with the side wallet in just before
  for (const i of [1, 2, 3, 4, 5]) {
    put(solBuy(1000 * i - 30, 0, SIDE, COIN(i)), 21 * 86_400 - 1000 * i + 30);
    put(hiddenBuy(1000 * i, 5, SEED, COIN(i)), 21 * 86_400 - 1000 * i);
  }
  put(usdSend(20_000, 0, SEED, SIDE, 900), 10 * 86_400);
  put(usdSend(30_000, 0, SEED, SIDE, 700), 5 * 86_400);
  // and since then 400 coins dropped on it by one stranger: more than the short read holds
  const SPAM = A("Spam");
  for (let k = 0; k < 400; k++) put(drop(50_000 + k, 0, SPAM, SEED, A(`Junk${k}`)), 3600 - k);
  const net = fakeChain(chain);
  _test.setCfg({ rpcUrl: () => "https://mainnet.helius-rpc.com/?api-key=SECRET", fetch: () => net.fetch });
  const r = await _test.doSeed(SEEDS[0]);
  assert.ok(r);
  // [naming the wallet, touching its dollar account, the short stretch of all its token accounts]
  assert.deepEqual(r.read, [2, 7, 300]);
  assert.equal(r.buys, 5, "found through the dollar account, not through the flooded read");
  assert.equal(r.buysUsd, 5);
  assert.equal(r.days, 30);
  assert.deepEqual(r.reach, [30, 30], "both reads got to the start of the 30 days");
  assert.deepEqual(r.span, [20.9, 21], "its newest and oldest buy, in days ago");
  assert.ok(net.asked.some((q) => q.address === SEED && q.tokenAccounts === "balanceChanged"));
  assert.ok(net.asked.some((q) => q.address === ATA(USDC, SEED)), "its dollar account was read by its own address");
  assert.ok(!r.linked.some((l) => l.address === SPAM), "the stranger who dropped the coins is not a lead");
  const side = r.linked.find((l) => l.address === SIDE)!;
  assert.deepEqual({ how: side.how, sent: side.sent, usd: side.usd, before: side.before, beforeWithin1h: side.beforeWithin1h, after: side.after }, { how: "money", sent: 2, usd: 1600, before: 5, beforeWithin1h: 5, after: 0 });
  _test.state().seeds[SEED] = r;
  const row = linksSummary().seeds.find((s) => s.name === SEEDS[0].name)!;
  assert.equal(row.redo, false);
  assert.deepEqual(row.transactionsRead, [2, 7, 300]);
  // the seed itself goes to the paper copy test with its dollar account, marked so nothing real ever copies it
  assert.deepEqual(seedWallets()[0], { name: `fomo ${SEEDS[0].name}`, address: SEED, found: true, fomo: true, accounts: [ATA(USDC, SEED)] });
  assert.deepEqual(seedWallets()[1].accounts, [], "not read yet: the wallet alone");
  assert.ok(!JSON.stringify(linksSummary()).includes(ATA(USDC, SEED)));
  assert.equal(row.linked[0].verdict, "likely");
  // a result from the first way of reading is marked to be read again
  _test.state().seeds[SEED] = { ...r, v: 1 };
  assert.equal(linksSummary().seeds[0].redo, true);
});

test("runner: a read that stops short says so, and a deeper one finds the older buys", async () => {
  _test.reset();
  const now = Math.floor(Date.now() / 1000);
  const chain: Item[] = [];
  const put = (it: Item, ago: number) => ((it.blockTime = now - ago), chain.push(it), it);
  // three dollar-paid buys ten days ago that never name the wallet
  for (const i of [1, 2, 3]) put(hiddenBuy(1000 * i, 5, SEED, COIN(i)), 10 * 86_400 + i);
  put(usdSend(40_000, 0, SEED, SIDE, 900), 86_400);
  // and its dollar account is busy: 400 small payments in over the last two days
  const PAYER = A("Payer");
  for (let k = 1; k <= 400; k++) put(usdSend(90_000 - k, 0, PAYER, SEED, 2), 400 * k);
  const net = fakeChain(chain);
  _test.setCfg({ rpcUrl: () => "https://mainnet.helius-rpc.com/?api-key=SECRET", fetch: () => net.fetch });
  try {
    // one page of the dollar account: 100 payments, 11 hours, no buy
    _test.setDepth({ deep: 1 });
    const short = await _test.doSeed(SEEDS[0]);
    assert.ok(short);
    assert.equal(short.buys, 0);
    assert.deepEqual(short.reach, [30, 0.5]);
    assert.equal(short.days, 0.5, "the shorter of the two reads, not the 30 days asked for");
    assert.equal(short.span, null);
    _test.state().seeds[SEED] = short;
    const row = linksSummary().seeds[0];
    assert.deepEqual({ daysCovered: row.daysCovered, daysRead: row.daysRead, buysFromDaysAgo: row.buysFromDaysAgo }, { daysCovered: 0.5, daysRead: { own: 30, dollar: 0.5 }, buysFromDaysAgo: null });
    // read to its end: the buys are there
    _test.reset();
    _test.setDepth({ deep: 150 });
    const deep = await _test.doSeed(SEEDS[0]);
    assert.ok(deep);
    assert.equal(deep.buys, 3);
    assert.deepEqual(deep.reach, [30, 30]);
    assert.deepEqual(deep.span, [10, 10]);
    assert.ok(!deep.linked.some((l) => l.address === PAYER), "small payments in are not a money link");
  } finally {
    _test.setDepth({ deep: 150 });
  }
});

/** A fomo buy as it really routes: dollars into a dollar/SOL pool, the SOL on into the coin's own pool. */
const USDPOOL = A("UsdPool");
const routedBuy = (slot: number, index: number, who: string, mint: string, usd: number, sol: number, tokens: number) =>
  tx(slot, index, [[RELAYER, 0]], [[USDC, who, 50_000, 50_000 - usd], [USDC, USDPOOL, 9e5, 9e5 + usd], [SOL, USDPOOL, 5000, 5000 - sol], [SOL, POOL, 100, 100 + sol], [mint, who, -1, tokens], [mint, POOL, 5e6, 5e6 - tokens]]);
/** A trade against the coin's pool at a given price (SOL per token): a buy of 1 SOL, or a sale for 1 SOL. */
const tradeAt = (slot: number, index: number, who: string, mint: string, price: number, sell = false) =>
  tx(slot, index, [[who, sell ? 1 : -1], [POOL, sell ? -1 : 1]], [[mint, who, sell ? 1 / price : 0, sell ? 0 : 1 / price], [mint, POOL, 5e6, 5e6 + (sell ? 1 : -1) / price]]);

test("pool price: every trade is priced where the coin's pool is, whoever paid and in whatever money", () => {
  const near = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(poolPrice(solBuy(100, 0, SIDE, COIN(1), 2), COIN(1))?.sol, 2 / 1000);
  near(poolPrice(solSell(100, 0, SIDE, COIN(1), 1.2), COIN(1))?.sol, 1.2 / 1000);
  // dollars in, routed through SOL: priced in SOL at the coin's pool, like everybody else's trade
  const routed = poolPrice(routedBuy(100, 0, SEED, COIN(1), 800, 5, 1000), COIN(1))!;
  near(routed.sol, 5 / 1000);
  assert.equal(routed.usd, undefined);
  // a pool that holds dollars against the coin: priced in dollars
  near(poolPrice(fomoBuy(100, 0, SEED, COIN(1), 500), COIN(1))?.usd, 0.5);
  // a coin passed on, a transaction about another coin, a failed one: no price
  assert.equal(poolPrice(drop(100, 0, A("Spam"), SEED, COIN(1)), COIN(1)), null);
  assert.equal(poolPrice(solBuy(100, 0, SIDE, COIN(1)), COIN(2)), null);
  const failed = solBuy(100, 0, SIDE, COIN(1));
  failed.meta!.err = {};
  assert.equal(poolPrice(failed, COIN(1)), null);
});

test("replay of one past buy: in at what the next blocks paid, out at the last trade before each hold", () => {
  const M = COIN(1);
  const lead = { mint: M, slot: 1000, index: 5 };
  const after = [
    tradeAt(1000, 2, A("Before"), M, 0.004), // same block but ahead of the seed: not part of it
    routedBuy(1000, 5, SEED, M, 800, 5, 1000), // the seed: 0.005 SOL a token
    tradeAt(1001, 0, A("F1"), M, 0.0052),
    tradeAt(1002, 0, A("F2"), M, 0.0054),
    tradeAt(1003, 0, A("F3"), M, 0.0056),
    tradeAt(1010, 0, A("F4"), M, 0.0065), // 4 s
    tradeAt(1040, 0, A("F5"), M, 0.0050, true), // 16 s
    tradeAt(1700, 0, A("F6"), M, 0.0027, true), // 280 s
  ];
  const r = replayOf(lead, [...after, after[3]])!; // a transaction read twice counts once
  // entry = middle of the three trades in the next 3 blocks = 0.0054, 8% over the seed
  assert.equal(r.gap, 0.08);
  const want = (p: number) => Math.round((p / 0.0054 - 1 - REPLAY_COST) * 1e4) / 1e4;
  assert.deepEqual(REPLAY_SECS, [5, 10, 20, 30, 60, 120, 300]);
  assert.deepEqual(r.rets, [want(0.0065), want(0.0065), want(0.005), want(0.005), want(0.005), want(0.005), want(0.0027)]);
  // nobody trades after the seed: in at the seed's price, the price stays, only the cost is lost
  const quiet = replayOf(lead, after.slice(0, 2))!;
  assert.equal(quiet.gap, null);
  assert.deepEqual(quiet.rets, REPLAY_SECS.map(() => -REPLAY_COST));
  // the seed's own trade is not in what was read: nothing is made up
  assert.equal(replayOf(lead, after.slice(2)), null);
  const sum = replaySummary([r, quiet]);
  assert.equal(sum.buys, 2);
  assert.equal(sum.followedAtOnce, 1);
  assert.equal(sum.entryAboveTraderPct, 8);
  assert.deepEqual(sum.holds[0], { sec: 5, n: 2, won: 1, medianPct: Math.round(((want(0.0065) - REPLAY_COST) / 2) * 1e4) / 100, avgPct: Math.round(((want(0.0065) - REPLAY_COST) / 2) * 1e4) / 100 });
  assert.deepEqual(sum.target10, { n: 2, won: 1, medianPct: Math.round(((want(0.0065) - REPLAY_COST) / 2) * 1e4) / 100, avgPct: Math.round(((want(0.0065) - REPLAY_COST) / 2) * 1e4) / 100 });
  assert.equal(replaySummary([]).holds[0].n, 0);
});

test("runner: a busy coin is replayed past the first 200 transactions, with one page per hold", async () => {
  _test.reset();
  const now = Math.floor(Date.now() / 1000);
  const M = COIN(7);
  const chain: Item[] = [];
  const put = (it: Item) => ((it.blockTime = now - 5 * 86_400 + Math.round((it.slot - 1000) * 0.4)), chain.push(it), it);
  put(routedBuy(1000, 5, SEED, M, 800, 5, 1000)); // 0.005
  // 250 buys in the next 10 blocks, the price climbing to 0.0075
  for (let k = 0; k < 250; k++) put(tradeAt(1001 + Math.floor(k / 25), k % 25, A(`B${k}`), M, 0.005 + 0.00001 * (k + 1)));
  put(tradeAt(1100, 0, A("S1"), M, 0.006, true)); // 40 s
  put(tradeAt(1700, 0, A("S2"), M, 0.003, true)); // 280 s
  const net = fakeChain(chain);
  _test.setCfg({ rpcUrl: () => "https://mainnet.helius-rpc.com/?api-key=SECRET", fetch: () => net.fetch });
  const r = await _test.doSeed(SEEDS[0]);
  assert.ok(r);
  assert.equal(r.buys, 1);
  assert.equal(r.replay!.length, 1);
  const row = r.replay![0];
  // entry: the 75 buys of blocks 1001 to 1003, middle price 0.00538
  const entry = 0.005 + 0.00001 * 38;
  const want = (p: number) => Math.round((p / entry - 1 - REPLAY_COST) * 1e4) / 1e4;
  assert.equal(row.gap, Math.round((entry / 0.005 - 1) * 1e4) / 1e4);
  assert.deepEqual(row.rets, [want(0.0075), want(0.0075), want(0.0075), want(0.0075), want(0.006), want(0.006), want(0.003)]);
  _test.state().seeds[SEED] = r;
  const sum = linksSummary();
  assert.equal(sum.replay.buys, 1);
  assert.equal(sum.seeds[0].replay.holds.length, REPLAY_SECS.length);
  assert.ok(sum.replay.note.includes("estimate"));
});
