import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "solkeys-"));
process.env.DATA_DIR = dir;
const { _forget, base58decode, buildSigned, signTransaction, wallet } = await import("./keys.js");
const { base58 } = await import("./whirlpool.js");
const { validAddress } = await import("./wallets.js");

const pubObj = (pub: Buffer) => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]), format: "der", type: "spki" });

test("wallet is created once, kept private, and reloads to the same address", () => {
  const w = wallet();
  assert.ok(validAddress(w.address));
  assert.equal(statSync(join(dir, "solana-wallet.json")).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dir, "solana-wallet-address.txt"), "utf8").trim(), w.address);
  assert.equal((JSON.parse(readFileSync(join(dir, "solana-wallet.json"), "utf8")) as number[]).length, 64);
  _forget();
  assert.equal(wallet().address, w.address);
  assert.ok(base58decode(w.address).equals(w.pubkey));
  assert.equal(base58(base58decode("11111111111111111111111111111111")), "11111111111111111111111111111111");
});

test("signs an API-built transaction only when we are its single signer", () => {
  const w = wallet();
  const msg = (signer: Buffer, versioned: boolean, nSigners = 1) => Buffer.concat([versioned ? Buffer.from([0x80]) : Buffer.alloc(0), Buffer.from([nSigners, 0, 1, 2]), signer, Buffer.alloc(32, 7), Buffer.alloc(40, 9)]);
  const wrap = (m: Buffer, nSig = 1) => Buffer.concat([Buffer.from([nSig]), Buffer.alloc(64 * nSig), m]).toString("base64");
  for (const versioned of [true, false]) {
    const m = msg(w.pubkey, versioned);
    const out = Buffer.from(signTransaction(wrap(m)), "base64");
    assert.ok(verify(null, m, pubObj(w.pubkey), out.subarray(1, 65)));
    assert.ok(out.subarray(65).equals(m));
  }
  assert.throws(() => signTransaction(wrap(msg(Buffer.alloc(32, 1), true))), /not our wallet/);
  assert.throws(() => signTransaction(wrap(msg(w.pubkey, true, 2))), /more than one signer/);
  assert.throws(() => signTransaction(wrap(msg(w.pubkey, true), 2)), /expected 1/);
});

test("builds a signed close-account transaction", () => {
  const w = wallet();
  const ata = base58(Buffer.alloc(32, 3));
  const prog = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const tx = Buffer.from(buildSigned(w, base58(Buffer.alloc(32, 5)), prog, [{ pubkey: ata, writable: true }, { pubkey: w.address, writable: true }, { pubkey: w.address, writable: false }], [9]), "base64");
  const m = tx.subarray(65);
  assert.deepEqual([...m.subarray(0, 4)], [1, 0, 1, 3]); // 1 signer, 1 read-only (the program), 3 keys
  assert.ok(m.subarray(4, 36).equals(w.pubkey));
  assert.ok(m.subarray(36, 68).equals(Buffer.alloc(32, 3)));
  assert.ok(m.subarray(68, 100).equals(base58decode(prog)));
  assert.deepEqual([...m.subarray(132)], [1, 2, 3, 1, 0, 0, 1, 9]);
  assert.ok(verify(null, m, pubObj(w.pubkey), tx.subarray(1, 65)));
});

test("a damaged wallet file is refused", () => {
  const raw = JSON.parse(readFileSync(join(dir, "solana-wallet.json"), "utf8")) as number[];
  raw[40] ^= 1;
  writeFileSync(join(dir, "solana-wallet.json"), JSON.stringify(raw));
  _forget();
  assert.throws(() => wallet(), /do not match/);
});
