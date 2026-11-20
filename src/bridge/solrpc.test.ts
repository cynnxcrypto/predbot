import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "bridge-solrpc-"));
process.env.BRIDGE_SOL_GAP_MS = "1";
process.env.BRIDGE_SOL_BACKOFF_MS = "1";
const { realDeps, SOL_TRIES } = await import("./real.js");

/** A pretend Solana RPC: answers "too many requests" `busy` times, then the balance. */
function rpc(busy: number, kind: "http" | "json" = "http") {
  const seen = { calls: 0, hosts: new Set<string>(), together: 0, most: 0 };
  const fetcher = (async (url: string | URL) => {
    seen.calls++;
    seen.hosts.add(new URL(String(url)).host);
    seen.most = Math.max(seen.most, ++seen.together);
    await new Promise((ok) => setTimeout(ok, 2));
    seen.together--;
    if (seen.calls <= busy) return kind === "http" ? new Response("Too Many Requests", { status: 429 }) : new Response(JSON.stringify({ error: { code: 429, message: "Too many requests for a specific RPC call" } }), { status: 200 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 1_500_000_000 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { seen, d: realDeps(fetcher) };
}

test("a Solana read that is turned away is tried again, and then answers", async () => {
  for (const kind of ["http", "json"] as const) {
    const { seen, d } = rpc(2, kind);
    assert.equal(await d.balance({ chain: "solana", address: "11111111111111111111111111111112", token: "SOL" }), 1.5);
    assert.equal(seen.calls, 3);
    assert.ok(seen.hosts.size >= 2); // not the same address every time
  }
});

test("it gives up in plain words after a few tries, and reads never overlap", async () => {
  const { seen, d } = rpc(99);
  const p = { chain: "solana" as const, address: "11111111111111111111111111111112", token: "SOL" as const };
  const all = await Promise.allSettled([d.balance(p), d.balance(p)]);
  assert.ok(all.every((x) => x.status === "rejected" && /turning calls away/.test(String(x.reason))));
  assert.equal(seen.calls, 2 * SOL_TRIES);
  assert.equal(seen.most, 1);
});
