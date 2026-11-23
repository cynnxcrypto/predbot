/**
 * Hyperliquid's answers by HTTP status, for the status (MAIN, 23 Nov 2026: fast copies kick the real side often; a
 * refusal for too many requests, 429, must show in status, where the reviews look). No address, no body.
 */
const WINDOW_MS = 3_600_000;
const all = { ok: 0, http429: 0, otherHttp: 0, noAnswer: 0 };
const recent: { t: number; kind: "http429" | "otherHttp" | "noAnswer"; src: string }[] = [];
/** One answer (or none) from Hyperliquid's API. src: who asked ("real", "paper"). */
export function hlHttp(status: number | null, src: string, now = Date.now()) {
  if (status !== null && status >= 200 && status < 300) return void all.ok++;
  const kind = status === null ? "noAnswer" : status === 429 ? "http429" : "otherHttp";
  all[kind]++;
  recent.push({ t: now, kind, src });
  while (recent.length && (now - recent[0].t > WINDOW_MS || recent.length > 5_000)) recent.shift();
}
export function hlHttpSummary(now = Date.now()) {
  const last = recent.filter((x) => now - x.t <= WINDOW_MS);
  const by = (k: string) => {
    const xs = last.filter((x) => x.kind === k);
    const out: Record<string, number> = {};
    for (const x of xs) out[x.src] = (out[x.src] ?? 0) + 1;
    return { n: xs.length, by: out };
  };
  return { sinceStart: { ...all }, lastHour: { http429: by("http429"), otherHttp: by("otherHttp"), noAnswer: by("noAnswer") }, last429AgoS: (() => { const x = [...last].reverse().find((y) => y.kind === "http429"); return x ? Math.round((now - x.t) / 1000) : null; })() };
}
export const _rateTest = { reset: () => ((all.ok = all.http429 = all.otherHttp = all.noAnswer = 0), (recent.length = 0)) };
