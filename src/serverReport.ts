import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./config.js";

/**
 * On the AWS server (31 Oct 2026): every 15 min, run deploy/report.py, which posts a summary to the server-data branch
 * so Claude can read the server's results. Started from the bot itself, so a push is enough to fix or change it (the
 * cron line deploy/report-setup.sh was meant to install came out empty). Only runs where the GitHub token was saved.
 */
export function startServerReport(): NodeJS.Timeout | undefined {
  if (!existsSync(join(homedir(), ".predbot-github-token"))) return undefined;
  const run = () =>
    execFile("python3", [join(ROOT, "deploy", "report.py")], { timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) console.log(`server report failed: ${String(stderr || stdout || err.message).trim().slice(0, 300)}`);
    });
  setTimeout(run, 60_000).unref();
  return setInterval(run, 15 * 60_000);
}
