import { execSync } from "node:child_process";
import type { Server } from "node:http";
import { ROOT, SERIES, STATUS_PORT } from "./config.js";
import { Recorder } from "./recorder.js";
import { serveStatus } from "./status.js";

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
 * Bind the status port. If an older copy of the bot still holds it (for example one left behind by
 * a restart), ask it to stop at the next window edge and wait for it, so two copies never record at once.
 */
async function takeOver(recorder: Recorder, others: Recorder[]): Promise<Server> {
  let asked: number | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      return await serveStatus(recorder, build(), others);
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

const recorders = SERIES.map((s) => new Recorder(s));
const recorder = recorders[0];
const server = await takeOver(recorder, recorders.slice(1));
for (const r of recorders) r.start();
console.log(`Pred bot recorder ${build()}. Status: http://127.0.0.1:${STATUS_PORT}. Recording ${recorders.map((r) => r.series.label).join(", ")}.`);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
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
  setTimeout(stop, wait * 1000);
});
