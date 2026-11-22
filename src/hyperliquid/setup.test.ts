import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "hlsetup-"));
process.env.DATA_DIR = dir;
import type { Chain } from "./fund.js";
const { fundLook, hlPage, hlPrivate, hlPublic, parseFundMode, parseSecond, parseWatch, reachCheck, serial, secondFundLook, secondPublic, startHyperliquid } = await import("./setup.js");

test("the swap is real only when the repo file says go; a look that fails is reported, not thrown", async () => {
  assert.equal(parseFundMode('{"hyperliquid":{"fund":"go"}}'), "go");
  for (const t of ['{"hyperliquid":{"fund":true}}', '{"hyperliquid":{}}', "{}", "not json"]) assert.equal(parseFundMode(t), "dry");
  const down = { chainId: async () => Promise.reject(new Error("rpc down 0x" + "a".repeat(40))) } as unknown as Chain;
  await fundLook(down, "go");
  const f = hlPublic().funding;
  assert.equal(f?.mode, "go");
  assert.match(f?.error ?? "", /rpc down …/);
});

const net = (o: { hl?: number; chain?: string; region?: string | null }) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("hyperliquid")) return new Response(JSON.stringify({ universe: Array(o.hl ?? 200).fill({}) }));
    if (u.includes("/api/token")) return o.region === null ? new Response("", { status: 404 }) : new Response("tok");
    if (u.includes("/placement/region")) return (init?.headers as Record<string, string>)["X-aws-ec2-metadata-token"] === "tok" ? new Response(o.region ?? "ap-northeast-2") : new Response("", { status: 401 });
    return new Response(JSON.stringify({ result: o.chain ?? "0xa4b1" }));
  }) as typeof fetch;

test("start makes the wallet; the address is on the private side only", async () => {
  await startHyperliquid(net({}));
  assert.ok(existsSync(join(dir, "hyperliquid-wallet.json")) && existsSync(join(dir, "hyperliquid-agent.json")));
  const a = hlPrivate().address as string;
  assert.match(a, /^0x[0-9a-fA-F]{40}$/);
  const pub = JSON.stringify(hlPublic());
  assert.ok(!/0x[0-9a-fA-F]{40}/.test(pub), "no address in the public status");
  assert.deepEqual({ ...hlPublic().reach, at: 0 }, { at: 0, hyperliquidApi: true, coins: 200, arbitrumRpc: true, chainId: 42161, region: "ap-northeast-2", errors: [] });
  assert.ok(hlPage().includes(a) && hlPage().includes("Arbitrum One"));
});

test("a wrong chain, an empty Hyperliquid answer and no metadata all read as failed, without throwing", async () => {
  const r = await reachCheck(net({ hl: 0, chain: "0x1", region: null }));
  assert.deepEqual([r.hyperliquidApi, r.arbitrumRpc, r.chainId, r.region], [false, false, 1, null]);
  assert.equal(r.errors.length, 3);
});

test("the second wallet's money: moved once per name, only with enough free, written down before it is sent", async () => {
  assert.deepEqual(parseSecond('{"hyperliquid":{"trade":{}}}'), { wanted: false, fund: null });
  assert.deepEqual(parseSecond('{"hyperliquid":{"trade":{"second":{"on":false}}}}'), { wanted: true, fund: null });
  assert.deepEqual(parseSecond('{"hyperliquid":{"trade":{"second":{"fundOnce":{"id":"f1","usd":50}}}}}'), { wanted: true, fund: { id: "f1", usd: 50 } });
  for (const f of ['{"id":"f1","usd":101}', '{"id":"f1","usd":5}', '{"id":"F 1","usd":50}', '{"id":"f1","usd":"50"}', "50"]) assert.equal(parseSecond(`{"hyperliquid":{"trade":{"second":{"fundOnce":${f}}}}}`).fund, null);
  const sent: number[] = [];
  let free: number | Error = 30;
  let answer: unknown = { status: "ok" };
  let id = "f1";
  const d = { cfg: () => ({ wanted: true, fund: { id, usd: 50 } }), free: async () => (free instanceof Error ? Promise.reject(free) : free), send: async (usd: number) => (sent.push(usd), answer) };
  assert.equal(await secondFundLook(d), "not enough free money in the first wallet");
  free = NaN;
  assert.equal(await secondFundLook(d), "first wallet not read");
  free = new Error("down");
  assert.equal(await secondFundLook(d), "first wallet not read");
  assert.deepEqual([sent, secondPublic().funds], [[], []], "nothing sent, the name not used up");
  free = 55;
  assert.equal(await secondFundLook(d), "sent");
  assert.equal(await secondFundLook(d), "nothing to do");
  assert.deepEqual(sent, [50]);
  id = "f2";
  answer = { status: "err", response: "Insufficient balance for 0x" + "c".repeat(40) };
  assert.match(await secondFundLook(d), /^refused: Insufficient balance for …/);
  assert.equal(await secondFundLook(d), "nothing to do", "a refused name is not tried again");
  id = "f3";
  d.send = async () => Promise.reject(new Error("socket hang up"));
  assert.match(await secondFundLook(d), /^not known: /);
  assert.equal(await secondFundLook(d), "nothing to do", "an answer never seen is never sent twice");
  assert.deepEqual(secondPublic().funds.map((x) => [x.id, x.usd, x.result.split(":")[0]]), [["f1", 50, "sent"], ["f2", 50, "refused"], ["f3", 50, "not known"]]);
  assert.ok(!/0x[0-9a-fA-F]{40}/.test(JSON.stringify(secondPublic())));
});

test("the trade feed switch, and real looks one at a time with a look asked for meanwhile run right after", async () => {
  assert.deepEqual(parseWatch('{"hyperliquid":{"watch":{"on":true,"fast":true}}}'), { on: true, fast: true });
  assert.deepEqual(parseWatch('{"hyperliquid":{"watch":{"on":true}}}'), { on: true, fast: false });
  assert.deepEqual(parseWatch('{"hyperliquid":{"watch":{"on":false,"fast":true}}}'), { on: false, fast: false });
  assert.deepEqual(parseWatch("not json"), { on: false, fast: false });
  let runs = 0;
  let open = 0;
  let most = 0;
  const run = serial(async () => {
    runs++;
    most = Math.max(most, ++open);
    await new Promise((ok) => setTimeout(ok, 20));
    open--;
    if (runs === 2) throw new Error("a look that fails");
  });
  await Promise.all([run(), run(), run(), run()]);
  assert.equal(runs, 2, "the three asked for during the first run make one more");
  assert.equal(most, 1);
  await run();
  assert.equal(runs, 3, "a failed run does not jam it");
});
