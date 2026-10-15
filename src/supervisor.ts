import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.js";

/**
 * `npm start` runs this. It runs the bot and keeps it on the newest code in the GitHub repo:
 *  - every CHECK_MIN minutes it fetches origin; when main has new commits it pulls (fast-forward only),
 *    reinstalls dependencies if the lockfile changed, type-checks, and asks the bot to restart at the
 *    next window edge (never mid-window);
 *  - if the new build dies within a minute it rolls back to the previous commit and restarts;
 *  - if the bot crashes on its own it is restarted after a short pause.
 * Data lives in data/, which git ignores, so an update never touches it. No downloads, no clicks.
 */
const CHECK_MIN = Number(process.env.UPDATE_EVERY_MIN ?? 3);
const auto = (process.env.AUTO_UPDATE ?? "true") !== "false";
const bin = (name: string) => join(ROOT, "node_modules", ".bin", name);

const say = (m: string) => console.log(`\x1b[90m${new Date().toISOString().slice(11, 19)}\x1b[0m \x1b[36mUPDATE\x1b[0m ${m}`);

let child: ChildProcess | null = null;
let startedAt = 0;
let stopping = false;
let restarting = false;
let lastGood = head();
let checking = false;

function git(args: string[]) {
  const out = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return { ok: out.status === 0, out: (out.stdout + out.stderr).trim() };
}
function head() {
  return git(["rev-parse", "HEAD"]).out;
}
function lockHash() {
  try {
    return readFileSync(join(ROOT, "package-lock.json"), "utf8").length;
  } catch {
    return 0;
  }
}

function start() {
  startedAt = Date.now();
  // Run node directly with tsx as a loader (not the tsx CLI, which wraps node in a child process and
  // only passes SIGINT/SIGTERM through), so the restart signal below reaches the bot itself.
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: ROOT, stdio: "inherit", env: process.env });
  child.on("exit", (code) => {
    child = null;
    if (stopping) process.exit(0);
    if (restarting) {
      restarting = false;
      start();
      return;
    }
    const uptime = Date.now() - startedAt;
    if (uptime < 60_000 && head() !== lastGood) {
      say(`the new code stopped after ${Math.round(uptime / 1000)}s. Rolling back to ${lastGood.slice(0, 7)}.`);
      git(["reset", "--hard", lastGood]);
      start();
      return;
    }
    if (uptime < 15_000) {
      say(`the bot stopped right away (code ${code}). Fix the error above, or wait for the next update. Ctrl+C quits.`);
      return;
    }
    say(`the bot exited (code ${code}); starting it again in 5s`);
    setTimeout(() => !child && !stopping && start(), 5000);
  });
}

function compiles() {
  const out = spawnSync(bin("tsc"), ["--noEmit", "-p", "."], { cwd: ROOT, encoding: "utf8" });
  return { ok: out.status === 0, out: (out.stdout + out.stderr).trim() };
}

async function checkForUpdate() {
  if (checking || !auto || restarting) return;
  checking = true;
  try {
    const fetched = git(["fetch", "--quiet", "origin", "main"]);
    if (!fetched.ok) {
      say(`could not reach GitHub (${fetched.out.split("\n")[0]}). Will try again.`);
      return;
    }
    const local = head();
    const remote = git(["rev-parse", "origin/main"]).out;
    if (!remote || local === remote) return;
    const dirty = git(["status", "--porcelain", "--untracked-files=no"]).out;
    if (dirty) {
      say("local files were edited by hand, so the update is skipped. Commit or discard them to resume updates.");
      return;
    }
    const before = lockHash();
    say(`new code on GitHub (${remote.slice(0, 7)}). Pulling.`);
    const pulled = git(["pull", "--ff-only", "--quiet", "origin", "main"]);
    if (!pulled.ok) {
      say(`pull failed: ${pulled.out.split("\n")[0]}`);
      return;
    }
    if (lockHash() !== before || !existsSync(join(ROOT, "node_modules"))) {
      say("dependencies changed; installing");
      const installed = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: "inherit" });
      if (installed.status !== 0) {
        say(`install failed; rolling back to ${local.slice(0, 7)}`);
        git(["reset", "--hard", local]);
        return;
      }
    }
    const c = compiles();
    if (!c.ok) {
      say(`the new code has type errors, rolling back to ${local.slice(0, 7)}:\n${c.out.split("\n").slice(0, 6).join("\n")}`);
      git(["reset", "--hard", local]);
      return;
    }
    lastGood = local;
    if (!child) {
      start();
      return;
    }
    say(`update ${remote.slice(0, 7)} ready; the bot restarts at the next window edge`);
    restarting = true;
    child.kill("SIGUSR2");
    setTimeout(() => {
      if (restarting && child) {
        say("the bot did not stop on its own; stopping it now");
        child.kill("SIGTERM");
      }
    }, 330_000);
  } finally {
    checking = false;
  }
}

process.on("SIGINT", () => {
  stopping = true;
  if (child) child.kill("SIGTERM");
  else process.exit(0);
});
process.on("SIGTERM", () => {
  stopping = true;
  if (child) child.kill("SIGTERM");
  else process.exit(0);
});

say(`supervisor on ${head().slice(0, 7)}; ${auto ? `checking GitHub every ${CHECK_MIN} min` : "auto-update is off"}`);
start();
if (auto) setInterval(() => void checkForUpdate(), CHECK_MIN * 60_000);
