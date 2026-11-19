import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "hlkeys-"));
process.env.DATA_DIR = dir;
const { _forget, addressFile, hlAgent, hlAgent2, hlWallet, hlWallet2, hlWallet2Exists, hlWalletExists } = await import("./keys.js");

test("the wallet is made once, kept private, and never replaced", () => {
  assert.equal(hlWalletExists(), false);
  const a = hlWallet().address;
  assert.match(a, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(hlWalletExists(), true);
  assert.equal(statSync(join(dir, "hyperliquid-wallet.json")).mode & 0o777, 0o600);
  assert.equal(readFileSync(addressFile(), "utf8").trim(), a);
  assert.ok(!readFileSync(addressFile(), "utf8").includes(hlWallet().privateKey.slice(2)), "the address file holds no key");
  _forget();
  assert.equal(hlWallet().address, a, "a second start reads the same wallet");
});

test("the trading key is a different key from the wallet", () => {
  assert.notEqual(hlAgent().address, hlWallet().address);
  assert.equal(statSync(join(dir, "hyperliquid-agent.json")).mode & 0o777, 0o600);
});

test("the second wallet is its own wallet with its own trading key; the address file stays the first wallet's", () => {
  assert.equal(hlWallet2Exists(), false);
  const all = [hlWallet().address, hlAgent().address, hlWallet2().address, hlAgent2().address];
  assert.equal(new Set(all).size, 4);
  assert.equal(hlWallet2Exists(), true);
  assert.equal(statSync(join(dir, "hyperliquid-wallet-2.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "hyperliquid-agent-2.json")).mode & 0o777, 0o600);
  assert.equal(readFileSync(addressFile(), "utf8").trim(), all[0]);
  _forget();
  assert.equal(hlWallet2().address, all[2], "read back, never replaced");
});

test("a key file that does not match its address is refused", () => {
  const f = join(dir, "hyperliquid-agent.json");
  const raw = JSON.parse(readFileSync(f, "utf8")) as { privateKey: string };
  writeFileSync(f, JSON.stringify({ privateKey: raw.privateKey, address: hlWallet().address }));
  _forget();
  assert.throws(() => hlAgent(), /do not match/);
});
