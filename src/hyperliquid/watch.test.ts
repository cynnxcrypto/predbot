import assert from "node:assert/strict";
import { test } from "node:test";
import { BURST_GAP_MS, HlTradeWatch, PER_SOCKET } from "./watch.js";

class FakeSock {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  send(t: string) {
    this.sent.push(t);
  }
  close() {
    this.closed = true;
  }
  up() {
    this.readyState = 1;
    this.onopen?.({});
  }
}
const A = "0x" + "aa".repeat(20);
const C = "0x" + "cc".repeat(20);
const trade = (coin: string, t: number, users: string[], px = "100") => ({ coin, side: "B", px, sz: "1", hash: "0x", time: t, tid: 1, users });

test("the trade feed: coins split over connections, trades by followed traders hit, delays measured from the first trade of a burst", async () => {
  let now = 1_800_000_000_000;
  const socks: FakeSock[] = [];
  const hits: [string, string, number][] = [];
  const coins = Array.from({ length: 230 }, (_, i) => `C${i}`);
  const w = new HlTradeWatch({
    coins: async () => coins,
    watched: () => new Set([A]),
    rule: (a) => `copy-${a.slice(2, 10)}`,
    onHit: (a, c, t) => void hits.push([a, c, t]),
    open: () => {
      const s = new FakeSock();
      socks.push(s);
      return s;
    },
    now: () => now,
  });
  await w.start();
  assert.equal(socks.length, Math.ceil(230 / PER_SOCKET));
  socks.forEach((s) => s.up());
  const subs = socks.flatMap((s) => s.sent.map((x) => JSON.parse(x) as { method: string; subscription: { type: string; coin: string } }));
  assert.equal(subs.length, 230);
  assert.ok(subs.every((x) => x.method === "subscribe" && x.subscription.type === "trades"));
  assert.ok(socks.every((s) => s.sent.length <= PER_SOCKET));

  // a trade of someone else: counted, no hit; one of ours (any case, either side): a hit
  const t0 = now - 2_000;
  socks[0].onmessage!({ data: JSON.stringify({ channel: "trades", data: [trade("ETH", t0, ["0x01", "0x02"]), trade("ETH", t0, ["0x03", A.toUpperCase().replace("0X", "0x")], "2000")] }) });
  assert.deepEqual(hits, [[A, "ETH", t0]]);
  assert.equal(w.price("ETH"), 2000);
  // more fills of the same order: the same burst
  now += 3_000;
  w.handle(JSON.stringify({ channel: "trades", data: [trade("ETH", now - 500, [A, "0x09"])] }));
  now += 7_000;
  w.note("paperOpen", A, "ETH", "feed");
  w.noteRule("realOpen", `copy-${A.slice(2, 10)}`, "ETH");
  const s = w.summary();
  assert.deepEqual(s.delays["paperOpen|feed"], { n: 1, medianS: 12, p90S: 12 });
  assert.deepEqual(s.delays["realOpen|real"], { n: 1, medianS: 12, p90S: 12 });
  assert.deepEqual(s.delays["paperOpen|feed|fromLast"], { n: 1, medianS: 7.5, p90S: 7.5 }, "from the burst's last trade");
  assert.equal(s.tradesLastMinute, 3);
  assert.equal(s.ourTradersLastMinute, 2);
  assert.equal(s.open, 3);
  assert.ok(!JSON.stringify(s).includes(A.slice(4, 30)), "no address in the status");
  // no burst for this trader and coin (the trade was not seen): not measured
  w.note("paperClose", A, "BTC", "poll");
  w.note("paperClose", C, "ETH", "poll");
  assert.equal(w.summary().unknownDelay, 2);
  // a trade after a long pause starts a new burst
  now += BURST_GAP_MS + 60_000;
  w.handle(JSON.stringify({ channel: "trades", data: [trade("ETH", now - 1_000, [A, "0x09"])] }));
  now += 1_000;
  w.note("paperClose", A, "ETH", "feed");
  assert.deepEqual(w.summary().delays["paperClose|feed"], { n: 1, medianS: 2, p90S: 2 });
  // an old price is not used
  now += 31_000;
  assert.equal(w.price("ETH"), null);
  // junk is ignored
  w.handle("not json");
  w.handle(JSON.stringify({ channel: "pong" }));
  w.handle(JSON.stringify({ channel: "trades", data: [{ coin: "ETH" }, null] }));
  w.stop();
});

test("the trade feed: a connection that closes or goes silent is made again; stop closes all", async () => {
  let now = 1_800_000_000_000;
  const socks: FakeSock[] = [];
  const w = new HlTradeWatch({
    coins: async () => ["BTC", "ETH"],
    watched: () => new Set(),
    rule: () => "",
    onHit: () => undefined,
    open: () => {
      const s = new FakeSock();
      socks.push(s);
      return s;
    },
    now: () => now,
  });
  await w.start();
  socks[0].up();
  socks[0].readyState = 3;
  socks[0].onclose!({});
  await new Promise((ok) => setTimeout(ok, 1_100));
  assert.equal(socks.length, 2, "made again after a second");
  socks[1].up();
  w.keepAlive();
  assert.ok(socks[1].sent.includes(JSON.stringify({ method: "ping" })));
  now += 100_000;
  w.keepAlive();
  assert.equal(socks[1].closed, true, "silent too long: closed");
  await new Promise((ok) => setTimeout(ok, 1_100));
  assert.equal(socks.length, 3);
  w.stop();
  assert.equal(socks[2].closed, true);
  assert.equal(w.running, false);
});
