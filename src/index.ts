import { execSync } from "node:child_process";
import { ROOT, STATUS_PORT } from "./config.js";
import { Recorder } from "./recorder.js";
import { serveStatus } from "./status.js";

function build() {
  try {
    return execSync("git log -1 --format=%h·%cd --date=format:%Y-%m-%d·%H:%M", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "local";
  }
}

const recorder = new Recorder().start();
const server = serveStatus(recorder, build());
console.log(`Pred bot recorder ${build()}. Status: http://127.0.0.1:${STATUS_PORT}. Nothing trades.`);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  recorder.stop();
  server.close();
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

/** The supervisor asks "is now a good moment to restart?" by sending SIGUSR2; we answer by exiting cleanly at the next window edge. */
process.on("SIGUSR2", () => {
  const sec = Math.floor(Date.now() / 1000);
  const wait = ((300 - (sec % 300)) % 300) + 3;
  console.log(`update requested; restarting in ${wait}s, at the next window edge`);
  setTimeout(stop, wait * 1000);
});
