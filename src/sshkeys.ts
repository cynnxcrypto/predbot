/**
 * Installs the PUBLIC ssh keys listed in deploy/ssh-authorized-keys.pub into ~/.ssh/authorized_keys of the user the bot
 * runs as (ubuntu on the server), once per key, at bot start, so a push to main reaches the server on the next update.
 * 8 Nov 2026 (enrique approved on a decision card): his Mac key (predbot-mac) was refused by the server; it is needed to
 * copy the Jev key into data/. Only plain "ssh-ed25519 / ssh-rsa / ecdsa-sha2-* <base64> [comment]" lines are accepted
 * (no options, no private keys). Linux only; SSH_KEYS=off disables it.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { ROOT } from "./config.js";

const LINE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]{40,}={0,3}( [\w@.-]{1,64})?$/;

export function wantedKeys(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && LINE.test(l));
}

export function installSshKeys(home = homedir(), src = join(ROOT, "deploy", "ssh-authorized-keys.pub")): number {
  if (platform() !== "linux" || process.env.SSH_KEYS === "off" || !existsSync(src)) return 0;
  const keys = wantedKeys(readFileSync(src, "utf8"));
  if (!keys.length) return 0;
  const dir = join(home, ".ssh");
  const file = join(dir, "authorized_keys");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  const have = existsSync(file) ? readFileSync(file, "utf8") : "";
  const blobs = new Set(have.split("\n").map((l) => l.trim().split(/\s+/)[1]).filter(Boolean));
  let added = 0;
  for (const k of keys) {
    if (blobs.has(k.split(" ")[1])) continue;
    appendFileSync(file, (added === 0 && have && !have.endsWith("\n") ? "\n" : "") + k + "\n");
    added++;
  }
  if (existsSync(file)) chmodSync(file, 0o600);
  if (added) console.log(`ssh: added ${added} public key(s) from deploy/ssh-authorized-keys.pub to ${file}`);
  return added;
}
