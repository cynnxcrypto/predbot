import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "gumlive-"));
process.env.DATA_DIR = dir;

const G = await import("./gumlive.js");
const P = await import("./perpslive.js");
const { namedWallet } = await import("./keys.js");
const { signApiTx } = await import("./gum.js");
type Deps = import("./gumlive.js").GumDeps;
type Cfg = import("./gumlive.js").GumConfig;

const HYPE = { symbol: "HYPE", baseDecimals: 8, baseLotSize: 1_000_000, quoteLotSize: 1, stepSize: 0.01, markPrice: 40, maxLeverage: 25, orderLimitConfig: { market: { minOrderQty: 0.01, minOrderNotional: 5, maxOpenOrderQty: 1e6, maxOpenOrderNotional: 1e6 } } };
const ZEC = { ...HYPE, symbol: "ZEC", markPrice: 400, maxLeverage: 50 };
const SOLM = { ...HYPE, symbol: "SOL", markPrice: 150, maxLeverage: 50 };
const ON: Cfg = { on: true, createAccount: false, collateralUsd: 10, maxLossUsd: 30, ruleStopUsd: 9, maxOpen: 3 };
const T0 = Date.now();

function world(cfg: Partial<Cfg> = {}) {
  G._test.reset();
  P._test.reset();
  const c = {
    cfg: { ...ON, ...cfg } as Cfg,
    accounts: [{ pubkey: "CROSS", subaccountId: 0, isolated: false, data: { freeBalance: "50" } }] as import("./gumlive.js").GumAccount[],
    made: 0,
    placed: [] as Record<string, unknown>[],
    cancels: 0,
    held: [] as import("./gumlive.js").GumPosition[],
    history: [] as import("./gumlive.js").GumClosed[],
    paper: [] as { id: string; rule: string; coin: string; dir: number; at: number; lev?: number }[],
    fillOpens: true,
    deposits: 0,
  };
  const d: Deps = {
    cfg: () => c.cfg,
    wallet: () => namedWallet("perps"),
    markets: async () => [HYPE, ZEC, SOLM],
    accounts: async () => c.accounts,
    createAccount: async () => void (c.made++, c.accounts.push({ pubkey: "CROSS", subaccountId: 0, isolated: false, data: { freeBalance: "0" } })),
    positions: async () => c.held,
    history: async (_x, sym) => c.history.filter((h) => h.symbol === sym),
    blockhash: async () => "11111111111111111111111111111111",
    place: async (_w, body) => {
      const b = body as Record<string, unknown>;
      c.placed.push(b);
      if (b.reduceOnly) return;
      if (b.orderType === "market" && c.fillOpens) c.held.push({ symbol: String(b.symbol), side: b.side as "Bid", size: String(b.quantity), isolated: true });
    },
    cancelAll: async () => void c.cancels++,
    deposit: async () => (c.deposits++, "sig"),
    paperOpens: () => c.paper,
    fixed: (e) => String((e as Error)?.message ?? e),
    isReal: () => true,
  };
  return { c, d };
}

test("gum: off means nothing is sent, and no account is made without its switch", async () => {
  const { c, d } = world({ on: false });
  c.accounts = [];
  c.paper = [{ id: "copy-aa:HYPE:1", rule: "copy-aa", coin: "HYPE", dir: 1, at: T0, lev: 5 }];
  await G.gumLiveTick(d, T0 + 1000);
  assert.equal(c.made, 0);
  assert.equal(c.placed.length, 0);
  c.cfg = { ...c.cfg, createAccount: true };
  await G.gumLiveTick(d, T0 + 2000);
  assert.equal(c.made, 1);
  assert.equal(G._test.state().created?.result, "made");
  await G.gumLiveTick(d, T0 + 3000);
  assert.equal(c.made, 1, "made once");
  assert.equal(c.placed.length, 0, "still off: nothing placed");
});

test("gum: a real trader's position is copied (isolated, its leverage, half the market's max at most), closed when the trader closes, booked from Gum's history", async () => {
  const { c, d } = world();
  c.paper = [{ id: "copy-aa:HYPE:1", rule: "copy-aa", coin: "HYPE", dir: 1, at: T0, lev: 40 }];
  await G.gumLiveTick(d, T0 + 1000);
  assert.equal(c.placed.length, 1);
  const o = c.placed[0];
  assert.equal(o.isIsolated, true);
  assert.equal(o.side, "Bid");
  assert.equal(o.collateralAmount, 10_000_000);
  assert.equal(o.quantity, 3.12, "$10 at 12.5x (half of 25x) at $40, down to the step");
  assert.equal(String(o.signature).slice(0, 2), "0:");
  await G.gumLiveTick(d, T0 + 31_000);
  assert.equal(G._test.state().opens[0].stage, "open");
  // the trader closes: a reduce-only sell
  c.paper = [];
  await G.gumLiveTick(d, T0 + 61_000);
  const close = c.placed[1];
  assert.equal(close.reduceOnly, true);
  assert.equal(close.side, "Ask");
  assert.equal(close.quantity, 3.12);
  // gone from the book, and in the history
  c.held = [];
  c.history = [{ symbol: "HYPE", isolated: true, netPnl: "1.25", closeReason: "trade", openedAt: Math.floor((T0 + 1000) / 1000), closedAt: Math.floor((T0 + 90_000) / 1000) }];
  await G.gumLiveTick(d, T0 + 91_000);
  const s = G._test.state();
  assert.equal(s.opens.length, 0);
  assert.equal(s.rows[0].netUsd, 1.25);
  assert.deepEqual(P.perpsRealOf("copy-aa"), { trades: 1, won: 1, net: 1.25 }, "one record with the pool side");
});

test("gum: an order that did not fill books nothing; a liquidation is booked from the history and cuts the trader on both venues", async () => {
  const { c, d } = world();
  c.fillOpens = false;
  c.paper = [{ id: "copy-bb:ZEC:1", rule: "copy-bb", coin: "ZEC", dir: -1, at: T0, lev: 3 }];
  await G.gumLiveTick(d, T0 + 1000);
  await G.gumLiveTick(d, T0 + 1000 + 61_000);
  assert.equal(G._test.state().rows[0].filled, false);
  assert.equal(G._test.state().netUsd, 0);
  c.fillOpens = true;
  c.paper = [{ id: "copy-bb:ZEC:2", rule: "copy-bb", coin: "ZEC", dir: -1, at: T0 + 100_000, lev: 3 }];
  await G.gumLiveTick(d, T0 + 101_000);
  await G.gumLiveTick(d, T0 + 131_000);
  c.held = [];
  c.history = [{ symbol: "ZEC", isolated: true, netPnl: "-10", closeReason: "liquidation", openedAt: Math.floor((T0 + 101_000) / 1000), closedAt: Math.floor((T0 + 150_000) / 1000) }];
  await G.gumLiveTick(d, T0 + 161_000);
  const s = G._test.state();
  assert.equal(s.rows.at(-1)!.how, "liquidation");
  assert.equal(s.netUsd, -10);
  assert.ok(P.perpsCutAt("copy-bb").at > 0, "cut at the $9 stop, on the pool side too");
});

test("gum: SOL stays with the pool, one position per coin, the loss cap, and a result not yet in the history stops new positions", async () => {
  const { c, d } = world({ maxLossUsd: 15 });
  c.paper = [
    { id: "copy-cc:SOL:1", rule: "copy-cc", coin: "SOL", dir: 1, at: T0, lev: 2 },
    { id: "copy-cc:HYPE:1", rule: "copy-cc", coin: "HYPE", dir: 1, at: T0, lev: 2 },
    { id: "copy-dd:HYPE:1", rule: "copy-dd", coin: "HYPE", dir: -1, at: T0, lev: 2 },
  ];
  await G.gumLiveTick(d, T0 + 1000);
  assert.deepEqual(c.placed.map((x) => x.symbol), ["HYPE"]);
  await G.gumLiveTick(d, T0 + 31_000);
  // closed on Gum but not listed yet: after 30 minutes nothing new
  c.paper = [];
  c.held = [];
  await G.gumLiveTick(d, T0 + 61_000);
  c.paper = [{ id: "copy-ee:ZEC:1", rule: "copy-ee", coin: "ZEC", dir: 1, at: T0 + 40 * 60_000, lev: 2 }];
  await G.gumLiveTick(d, T0 + 40 * 60_000);
  assert.ok(G._test.state().unread);
  assert.equal(c.placed.filter((x) => x.symbol === "ZEC").length, 0);
});

test("gum: dry run and test, each once by name", async () => {
  const { c, d } = world({ on: true, dryRun: "dry-1", test: { id: "t-1", coin: "HYPE", side: "long" } });
  await G.gumLiveTick(d, T0 + 1000);
  assert.match(G._test.state().dry!.result, /^ok/);
  assert.equal(c.cancels, 1);
  assert.equal(c.placed[0].orderType, "postOnly");
  assert.equal(c.placed[1].collateralAmount, 5_000_000, "the test: $5");
  await G.gumLiveTick(d, T0 + 31_000); // filled
  await G.gumLiveTick(d, T0 + 61_000); // closed at the next look
  assert.equal(c.placed.at(-1)!.reduceOnly, true);
  await G.gumLiveTick(d, T0 + 91_000);
  assert.equal(c.cancels, 1, "the dry run is not made again");
});

test("gum: an API transaction is signed only in our own slot", () => {
  const w = namedWallet("perps");
  const other = Buffer.alloc(32, 3);
  // legacy message: header (2 signers, 0, 1), 3 keys, a blockhash, no instructions
  const msg = Buffer.concat([Buffer.from([2, 0, 1, 3]), other, w.pubkey, Buffer.alloc(32, 9), Buffer.alloc(32, 1), Buffer.from([0])]);
  const tx = Buffer.concat([Buffer.from([2]), Buffer.alloc(128), msg]).toString("base64");
  const signed = Buffer.from(signApiTx(tx, w), "base64");
  assert.ok(signed.subarray(1, 65).equals(Buffer.alloc(64)), "the API's slot is left to it");
  assert.ok(!signed.subarray(65, 129).equals(Buffer.alloc(64)));
  const notOurs = Buffer.concat([Buffer.from([2]), Buffer.alloc(128), Buffer.concat([Buffer.from([2, 0, 1, 3]), other, Buffer.alloc(32, 4), Buffer.alloc(32, 9), Buffer.alloc(32, 1), Buffer.from([0])])]).toString("base64");
  assert.throws(() => signApiTx(notOurs, w));
});

test("gum: API transactions: a v0 message with two plain slots is signed in our slot", async () => {
  const w = namedWallet("perps");
  const payer = Buffer.alloc(32, 3);
  const msg = Buffer.concat([Buffer.from([0x80, 2, 0, 1, 3]), payer, w.pubkey, Buffer.alloc(32, 9), Buffer.alloc(32, 1), Buffer.from([0]), Buffer.from([0])]);
  const out = Buffer.from(signApiTx(Buffer.concat([Buffer.from([2]), Buffer.alloc(128), msg]).toString("base64"), w), "base64");
  assert.ok(out.subarray(1, 65).equals(Buffer.alloc(64)), "the API's slot is left to it");
  assert.ok(!out.subarray(65, 129).equals(Buffer.alloc(64)), "ours is signed");
  assert.equal(out.length, 129 + msg.length);
  assert.throws(() => signApiTx(Buffer.from([9, 9, 9]).toString("base64"), w), /not read/);
});

test("gum: the dep-3 deposit as the API sent it (544 bytes, typed slots: 2, 65, 0, 0..., our key at byte 169) is read and signed in our slot", async () => {
  const { txLayout } = await import("./gum.js");
  const { createPublicKey, verify } = await import("node:crypto");
  const w = namedWallet("perps");
  const slot = () => Buffer.concat([Buffer.from([65, 0]), Buffer.alloc(64)]);
  const keys = [Buffer.alloc(32, 3), w.pubkey, ...Array.from({ length: 8 }, (_, i) => Buffer.alloc(32, 10 + i))];
  const ix = Buffer.concat([Buffer.from([1, 9, 3, 0, 1, 2, 48]), Buffer.alloc(48, 7)]);
  const msg = Buffer.concat([Buffer.from([2, 0, 6, keys.length]), ...keys, Buffer.alloc(32, 5), ix]);
  const tx = Buffer.concat([Buffer.from([2]), slot(), slot(), msg]);
  const b64 = tx.toString("base64");
  // what the status showed for dep-3
  assert.equal(tx.length, 544);
  assert.deepEqual([...tx.subarray(0, 4)], [2, 65, 0, 0]);
  const L = txLayout(b64, w);
  assert.equal(L.ourBytesAt, 169);
  assert.equal(L.enc, "typed");
  assert.equal(L.fits, true);
  assert.equal(L.msgAt, 133);
  assert.equal(L.required, 2);
  assert.equal(L.ourKeyAt, 1);
  assert.equal(L.other[0].required, 0, "read as plain 64-byte slots, as dep-3 was: no signer");
  assert.ok(!JSON.stringify(L).includes(w.address));
  const out = Buffer.from(signApiTx(b64, w), "base64");
  assert.equal(out.length, 544);
  assert.ok(out.subarray(0, 67).equals(tx.subarray(0, 67)), "the API's slot as it came");
  assert.deepEqual([out[67], out[68]], [65, 0], "our slot: length 65, type 0 (ed25519)");
  const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), w.pubkey]), format: "der", type: "spki" });
  assert.ok(verify(null, msg, pub, out.subarray(69, 133)), "a valid signature of the message");
  assert.ok(out.subarray(133).equals(msg), "the message untouched");
  // a transaction whose signers are not ours is refused
  const notOurs = Buffer.concat([Buffer.from([2]), slot(), slot(), Buffer.concat([Buffer.from([2, 0, 6, keys.length]), Buffer.alloc(32, 3), Buffer.alloc(32, 4), ...keys.slice(2), Buffer.alloc(32, 5), ix])]);
  assert.throws(() => signApiTx(notOurs.toString("base64"), w), /not read/);
});
