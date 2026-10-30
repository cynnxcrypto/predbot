import { Agent, request } from "node:https";
import { saveJson } from "./store.js";

/**
 * Times round trips from this machine to Polymarket's order server (clob.polymarket.com/time), once a minute, so the
 * "move the bot to a server next to Polymarket" decision has real numbers (30 Oct 2026). Warm = a second request on an
 * open connection (what an order costs when the connection is kept alive); cold = new TCP + TLS + request (what the
 * first order after a quiet spell costs). Read-only, no orders. Results in data/latency.json.
 */
const URL = "https://clob.polymarket.com/time";
const KEEP = 240;
const warmAgent = new Agent({ keepAlive: true, maxSockets: 1 });
const samples: { t: number; cold: number | null; warm: number | null }[] = [];

function timed(agent: Agent | false): Promise<number | null> {
  return new Promise((resolve) => {
    const start = performance.now();
    const req = request(URL, { agent, timeout: 10_000 }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode === 200 ? Math.round(performance.now() - start) : null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

async function measure() {
  const cold = await timed(false);
  await timed(warmAgent);
  const warm = await timed(warmAgent);
  samples.push({ t: Date.now(), cold, warm });
  if (samples.length > KEEP) samples.shift();
  const pick = (k: "cold" | "warm") => samples.map((s) => s[k]).filter((v): v is number => v != null);
  saveJson("latency.json", { at: Date.now(), url: URL, n: samples.length, coldMedian: median(pick("cold")), warmMedian: median(pick("warm")), samples });
}

export function startLatencyProbe() {
  void measure();
  return setInterval(() => void measure(), 60_000);
}
