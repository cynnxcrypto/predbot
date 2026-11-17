import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "hlsetup-"));
process.env.DATA_DIR = dir;
import type { Chain } from "./fund.js";
const { fundLook, hlPage, hlPrivate, hlPublic, parseFundMode, reachCheck, startHyperliquid } = await import("./setup.js");

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
