import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installSshKeys, wantedKeys } from "./sshkeys.js";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEu4yTYuGwoo2uI2LJuK+cYZEfrzR7P0XEa1PuENna7B predbot-mac";

test("ssh public keys: only plain public key lines, installed once", () => {
  assert.deepEqual(wantedKeys(`# c\n${KEY}\n-----BEGIN OPENSSH PRIVATE KEY-----\ncommand="x" ssh-rsa AAAA`), [KEY]);
  if (platform() !== "linux") return;
  const home = mkdtempSync(join(tmpdir(), "home-"));
  assert.equal(installSshKeys(home), 1);
  assert.equal(installSshKeys(home), 0);
  assert.equal(readFileSync(join(home, ".ssh", "authorized_keys"), "utf8").split("\n").filter(Boolean).length, 1);
});
