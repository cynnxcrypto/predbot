import { execSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { ROOT, SERIES, STATUS_PORT } from "./config.js";
import { Recorder } from "./recorder.js";
import { serveStatus } from "./status.js";
import { startLatencyProbe } from "./latency.js";
import { startServerReport } from "./serverReport.js";
import { installSshKeys } from "./sshkeys.js";
import { startPreopen } from "./preopen.js";
import { startPairlock } from "./pairlock.js";
import { pairliveQuiet, startPairlive } from "./pairlive.js";

function build() {
  try {
    return execSync("git log -1 --format=%h·%cd --date=format:%Y-%m-%d·%H:%M", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "local";
  }
}

/** The process holding our status port, if any (macOS and Linux have lsof). */
function portHolder(): number | null {
  try {
    const out = execSync(`lsof -ti tcp:${STATUS_PORT} -sTCP:LISTEN`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const pid = Number(out.split("\n")[0]);
    return pid > 0 && pid !== process.pid ? pid : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the status port. If an older copy of the bot still holds it (for example one left behind by
 * a restart), ask it to stop at the next window edge and wait for it, so two copies never record at once.
 * The recorders are only created after this, because the older copy keeps changing the data files
 * (settling trades, queueing windows) until it exits; state loaded earlier would be stale and a trade
 * settled by both copies would be counted twice (seen on 21 Oct 2026).
 */
async function waitForPort(): Promise<void> {
  let asked: number | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(STATUS_PORT, "127.0.0.1", () => probe.close(() => resolve()));
      });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt > 240) throw err;
      const pid = portHolder();
      if (pid && pid !== asked) {
        console.log(`an older copy (pid ${pid}) is still recording; asking it to stop at the next window edge`);
        try {
          process.kill(pid, "SIGUSR2");
        } catch {
          /* already gone */
        }
        asked = pid;
      } else if (attempt === 0) {
        console.log(`port ${STATUS_PORT} is busy; waiting for it`);
      }
      await sleep(2000);
    }
  }
}

await waitForPort();
const recorders = SERIES.map((s) => new Recorder(s));
const recorder = recorders[0];
try {
  installSshKeys(); // public keys from deploy/ssh-authorized-keys.pub (enrique approved 8 Nov 2026)
} catch (e) {
  console.log(`ssh: key install failed: ${(e as Error).message}`);
}
const server = await serveStatus(recorder, build(), recorders.slice(1));
for (const r of recorders) r.start();
const latencyTimer = startLatencyProbe();
const reportTimer = startServerReport();
const pairliveTimer = startPairlive(); // REAL: two-sided pair test (src/pairlive.ts), guarded by deploy/live-rules.json "pairs"
const pairlockTimer = startPairlock(); // paper only: two-sided pair locking on BTC/ETH/SOL 15m (src/pairlock.ts)
const preopenTimer = startPreopen(); // paper only: 49c bids on both sides of the next 15m window (src/preopen.ts)
console.log(`Pred bot recorder ${build()}. Status: http://127.0.0.1:${STATUS_PORT}. Recording ${recorders.map((r) => r.series.label).join(", ")}.`);

/**
 * The back-data downloader (src/history.ts) runs as its own process so its downloads never delay a snapshot: an hour after
 * start (5 minutes in), then every 6 hours, each run resuming where the last one stopped. HISTORY=off disables it.
 */
let stopping = false;
let history: ChildProcess | null = null;
function runHistory() {
  if (history || process.env.HISTORY === "off") return;
  const tsx = join(ROOT, "node_modules", ".bin", "tsx");
  history = spawn(tsx, [join(ROOT, "src", "history.ts")], { cwd: ROOT, stdio: "ignore", env: process.env });
  history.on("exit", () => {
    history = null;
  });
}
/** Paper loggers for esports, indices and politics markets (src/eventpaper.ts, paper only), restarted a minute after any exit. EVENTPAPER=off disables it. */
let eventPaper: ChildProcess | null = null;
let eventPaperTimer: NodeJS.Timeout | null = null;
function runEventPaper() {
  eventPaperTimer = null;
  if (eventPaper || stopping || process.env.EVENTPAPER === "off") return;
  const tsx = join(ROOT, "node_modules", ".bin", "tsx");
  eventPaper = spawn(tsx, [join(ROOT, "src", "eventpaper.ts")], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], env: process.env });
  eventPaper.on("exit", () => {
    eventPaper = null;
    if (!stopping) eventPaperTimer = setTimeout(runEventPaper, 60_000);
  });
}
eventPaperTimer = setTimeout(runEventPaper, 30_000);

/**
 * Top-trader research collector (10 Nov 2026, enrique: "find the most profitable traders of every single market we can
 * tap into"). research/trader-collector.py is read-only on Polymarket's public APIs and publishes to the server-data
 * branch. Started once, 3 minutes in, only on the server (it needs ~/.predbot-github-token), detached so bot restarts
 * do not kill it; the script holds a lock (a second copy exits), is niced and memory-capped, and writes
 * data/traders/DONE-v3 when finished so it never starts again. TRADERS=off disables it.
 */
// Tried 3 minutes in and again every 10 minutes: an older copy may still hold the lock (the new one then exits at once).
const COLLECTOR_VERSION = "3"; // bump when research/trader-collector.py changes and must restart
const startTraders = () => {
  try {
    const home = process.env.HOME ?? "";
    if (process.env.TRADERS === "off" || !home || !existsSync(join(home, ".predbot-github-token")) || existsSync(join(ROOT, "data", "traders", "DONE-v3"))) return;
    // A newer collector script: stop the copy still running the old code once (it holds the lock), then start the new one.
    const verFile = join(ROOT, "data", "traders", "VERSION");
    let ver = "";
    try {
      ver = readFileSync(verFile, "utf8").trim();
    } catch {
      /* first run */
    }
    if (ver !== COLLECTOR_VERSION) {
      try {
        execSync("pkill -f research/trader-collector.py", { stdio: "ignore" });
      } catch {
        /* none running */
      }
      mkdirSync(join(ROOT, "data", "traders"), { recursive: true });
      writeFileSync(verFile, COLLECTOR_VERSION);
    }
    const out = openSync(join(home, "trader-collector.log"), "a");
    spawn("python3", [join(ROOT, "research", "trader-collector.py")], { cwd: ROOT, detached: true, stdio: ["ignore", out, out] }).unref();
    closeSync(out);
    console.log("trader collector started or already running (research, read-only)");
  } catch (e) {
    console.log(`trader collector not started: ${(e as Error).message}`);
  }
};
setTimeout(startTraders, 180_000).unref();
setInterval(startTraders, 600_000).unref();
const historyTimer = setTimeout(runHistory, 300_000);
const historyEvery = setInterval(runHistory, 6 * 3600_000);

function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(historyTimer);
  if (eventPaperTimer) clearTimeout(eventPaperTimer);
  eventPaper?.kill("SIGTERM");
  clearInterval(historyEvery);
  clearInterval(latencyTimer);
  if (preopenTimer) clearInterval(preopenTimer);
  if (pairlockTimer) clearInterval(pairlockTimer);
  if (pairliveTimer) clearInterval(pairliveTimer);
  if (reportTimer) clearInterval(reportTimer);
  history?.kill("SIGTERM");
  for (const r of recorders) r.stop();
  server.close();
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

/** The supervisor asks "is now a good moment to restart?" by sending SIGUSR2; we answer by exiting cleanly at the next window edge. */
process.on("SIGUSR2", () => {
  const sec = Math.floor(Date.now() / 1000);
  // Ten seconds past the edge, so the closing window is queued for settlement before we exit (3s was sometimes too soon).
  const wait = ((300 - (sec % 300)) % 300) + 10;
  console.log(`update requested; restarting in ${wait}s, at the next window edge`);
  // The real pair test pulls its resting bids 20 s before the restart (orders left behind are also cancelled on start).
  setTimeout(pairliveQuiet, Math.max(0, wait - 20) * 1000);
  setTimeout(stop, wait * 1000);
});
