import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "soltx-"));
const { anchorDisc, ata, budget, buildTx, onCurve, pda, SYSTEM_PROGRAM, TOKEN_PROGRAM, u64le } = await import("./soltx.js");
const { base58decode, namedWallet, signTransaction, wallet } = await import("./keys.js");

const PERPS = "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu";

test("soltx: program addresses match the ones Jupiter publishes", () => {
  // the Perpetuals program's event authority, from Jupiter's own example constants
  assert.equal(pda(["__event_authority"], PERPS).address, "37hJBDnntwqhGbK7L6M1bLyvccj4u55CCUiLPdYkiqBN");
  // every real wallet address is a point on the curve; a program address never is
  assert.equal(onCurve(wallet().pubkey), true);
  assert.equal(onCurve(base58decode("37hJBDnntwqhGbK7L6M1bLyvccj4u55CCUiLPdYkiqBN")), false);
  assert.equal(onCurve(base58decode(pda(["perpetuals"], PERPS).address)), false);
  const a = ata(wallet().address, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(base58decode(a).length, 32);
  assert.equal(onCurve(base58decode(a)), false);
  assert.equal(ata(wallet().address, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), a, "the same every time");
});

test("soltx: Anchor discriminators and numbers", () => {
  assert.equal(anchorDisc("create_increase_position_market_request").length, 8);
  assert.notDeepEqual(anchorDisc("create_increase_position_market_request"), anchorDisc("create_decrease_position_market_request"));
  assert.deepEqual([...u64le(258)], [2, 1, 0, 0, 0, 0, 0, 0]);
});

test("soltx: a transaction with several instructions is one our signer accepts, and only for its own wallet", () => {
  const w = namedWallet("perps");
  const other = "G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa";
  const tx = buildTx(w.address, SYSTEM_PROGRAM, [
    ...budget(400_000, 100_000),
    { program: PERPS, keys: [{ pubkey: w.address, signer: true, writable: true }, { pubkey: other, writable: true }, { pubkey: TOKEN_PROGRAM }, { pubkey: PERPS }], data: Buffer.from([1, 2, 3]) },
  ]);
  const raw = Buffer.from(tx, "base64");
  assert.equal(raw[0], 1, "one signature slot");
  const msg = raw.subarray(65);
  assert.deepEqual([msg[0], msg[1]], [1, 0], "one signer, no read-only signer");
  const nKeys = msg[3];
  assert.equal(nKeys, 5, "payer, the writable account, token program, perps program, compute budget");
  assert.equal(msg[2], 3, "three read-only accounts");
  assert.ok(msg.subarray(4, 36).equals(w.pubkey), "the payer comes first");
  const signed = Buffer.from(signTransaction(tx, w), "base64");
  assert.ok(!signed.subarray(1, 65).equals(Buffer.alloc(64)), "signed");
  // the first wallet must refuse to sign what the perps wallet pays for: budgets stay apart
  assert.throws(() => signTransaction(tx, wallet()), /not our wallet/);
  assert.notEqual(w.address, wallet().address);
  assert.notEqual(w.address, namedWallet("buckets").address);
  assert.throws(() => buildTx(w.address, SYSTEM_PROGRAM, [{ program: PERPS, keys: [{ pubkey: other, signer: true }], data: Buffer.alloc(0) }]), /only the payer/);
});
