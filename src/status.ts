import { preopenSummary } from "./preopen.js";
import { pairliveSummary } from "./pairlive.js";
import { pairlockSummary } from "./pairlock.js";
import { pairfastSummary } from "./pairfast.js";
import { pairfastliveSummary } from "./pairfastlive.js";
import { walletHistorySummary } from "./wallethistory.js";
import { solanaSummary } from "./solana/run.js";
import { solanaCopySummary } from "./solana/copyrun.js";
import { solanaCopyLiveSummary } from "./solana/copylive.js";
import { withdrawSummary } from "./withdraw.js";
import { createServer } from "node:http";
import { loadJson } from "./store.js";
import { STATUS_PORT } from "./config.js";
import type { Recorder } from "./recorder.js";
import { LOGOS } from "./logos.js";
import { CATS, EV_CSS, EV_JS, eventsStatus, evSectionHtml } from "./eventdash.js";
import { VARIANTS, discarded, setDiscarded } from "./paperlive.js";
import { addLiveRule, budgets, liveConfig, MIN_SIZE, removeLiveRule, setLiveMaxLoss, setLiveRuleSize, setLiveRuleHalt } from "./live.js";

/**
 * A one-page status view on 127.0.0.1 so you can see the recorder is alive without reading logs.
 * Resolves once the port is bound; rejects (with code EADDRINUSE) when another copy holds it.
 */
export function serveStatus(recorder: Recorder, build: string, others: Recorder[] = []) {
  // data/dashboard.json { "password": "..." } (the AWS server, 31 Oct 2026): the page is reached through a Cloudflare tunnel,
  // so every request needs that password (browser login, any user name). Without the file the page stays open as on the Mac.
  const password = String(loadJson<{ password?: string }>("dashboard.json", {}).password ?? "");
  // On the server the rules come from git ("rules": "repo" in live.json), so the dashboard's rule edits would change nothing.
  const rulesFromRepo = loadJson<{ rules?: string }>("live.json", {}).rules === "repo";
  const RULE_EDITS = new Set(["/api/golive", "/api/topaper", "/api/size", "/api/halt", "/api/maxloss"]);
  const server = createServer((req, res) => {
    if (password) {
      const given = Buffer.from(String(req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString().split(":").slice(1).join(":");
      if (given !== password) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="Pred bot"', "content-type": "text/plain" });
        res.end("password needed");
        return;
      }
    }
    if (rulesFromRepo && req.method === "POST" && RULE_EDITS.has(req.url ?? "")) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "On the server, real rules are changed by Claude in git: ask in the chat. Pause still works here." }));
      return;
    }
    if (req.url === "/api/discard" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let name = "";
        let restore = false;
        try {
          const parsed = JSON.parse(body || "{}") as { name?: string; restore?: boolean };
          name = String(parsed.name ?? "");
          restore = Boolean(parsed.restore);
        } catch {
          name = "";
        }
        const known = VARIANTS.some((v) => v.name === name);
        const liveOn = [recorder, ...others].filter((r) => r.live && r.live.config.mode !== "off" && r.live.config.variants.some((v) => v.variant === name)).map((r) => r.series.label);
        if (!known) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unknown rule" }));
          return;
        }
        if (!restore && liveOn.length) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `${name} trades real money on ${liveOn.join(", ")}; take it out of data/live.json first` }));
          return;
        }
        setDiscarded(name, !restore);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, name, discarded: !restore }));
      });
      return;
    }
    if ((req.url === "/api/golive" || req.url === "/api/topaper") && req.method === "POST") {
      const toLive = req.url === "/api/golive";
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let series = "";
        let variant = "";
        let size = 5;
        try {
          const parsed = JSON.parse(body || "{}") as { series?: string; variant?: string; size?: number };
          series = String(parsed.series ?? "");
          variant = String(parsed.variant ?? "");
          size = Number(parsed.size ?? 5);
        } catch {
          variant = "";
        }
        const r = [recorder, ...others].find((x) => x.series.key === series);
        if (!r?.live || !VARIANTS.some((v) => v.name === variant)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unknown market or rule" }));
          return;
        }
        if (toLive && discarded().has(variant)) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "restore the rule in the paper lab first" }));
          return;
        }
        const out = toLive ? addLiveRule(series, variant, Number.isFinite(size) && size > 0 ? size : 5, 2) : removeLiveRule(series, variant);
        r.live.config = liveConfig(series);
        if (toLive) r.live.setPaused(variant, false);
        console.log(`dashboard: ${variant} on ${r.series.label} ${toLive ? "sent to real money" : "moved back to paper"}${out.changed ? "" : " (no change)"}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, series, variant, live: toLive, changed: out.changed }));
      });
      return;
    }
    if (req.url === "/api/size" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let series = "";
        let variant = "";
        let size = NaN;
        let ladder: number[] | null = null;
        try {
          const parsed = JSON.parse(body || "{}") as { series?: string; variant?: string; size?: number; ladder?: number[] };
          series = String(parsed.series ?? "");
          variant = String(parsed.variant ?? "");
          size = Number(parsed.size);
          if (Array.isArray(parsed.ladder)) ladder = parsed.ladder.map(Number).filter((x) => Number.isFinite(x) && x >= 1 && x <= 50);
        } catch {
          variant = "";
        }
        const r = [recorder, ...others].find((x) => x.series.key === series);
        if (!r?.live || !variant) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unknown market or rule" }));
          return;
        }
        if (!Number.isFinite(size) || size < MIN_SIZE || size > 50) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `bet size must be $${MIN_SIZE} to $50` }));
          return;
        }
        const out = setLiveRuleSize(series, variant, size, ladder && ladder.length > 1 ? ladder : null);
        if (out.size == null) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "that rule is not on real money" }));
          return;
        }
        r.live.config = liveConfig(series);
        console.log(`dashboard: ${variant} on ${r.series.label} bet size set to $${out.size}${out.changed ? "" : " (no change)"}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, series, variant, size: out.size, changed: out.changed }));
      });
      return;
    }
    if (req.url === "/api/halt" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let series = "";
        let variant = "";
        let losses = NaN;
        try {
          const parsed = JSON.parse(body || "{}") as { series?: string; variant?: string; losses?: number };
          series = String(parsed.series ?? "");
          variant = String(parsed.variant ?? "");
          losses = Number(parsed.losses);
        } catch {
          variant = "";
        }
        const r = [recorder, ...others].find((x) => x.series.key === series);
        if (!r?.live || !variant) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unknown market or rule" }));
          return;
        }
        if (!Number.isInteger(losses) || losses < 0 || losses > 50) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "halt must be 0 (never) to 50 losses" }));
          return;
        }
        const out = setLiveRuleHalt(series, variant, losses);
        if (out.losses == null) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "that rule is not on real money" }));
          return;
        }
        r.live.config = liveConfig(series);
        console.log(`dashboard: ${variant} on ${r.series.label} loss halt set to ${out.losses}${out.changed ? "" : " (no change)"}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, series, variant, losses: out.losses, changed: out.changed }));
      });
      return;
    }
    if (req.url === "/api/maxloss" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let series = "";
        let variant = "";
        let maxLoss = NaN;
        try {
          const parsed = JSON.parse(body || "{}") as { series?: string; maxLoss?: number; variant?: string };
          series = String(parsed.series ?? "");
          variant = String(parsed.variant ?? "");
          maxLoss = Number(parsed.maxLoss);
        } catch {
          maxLoss = NaN;
        }
        const r = [recorder, ...others].find((x) => x.series.key === series);
        if (!r?.live) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unknown market" }));
          return;
        }
        if (!Number.isFinite(maxLoss) || maxLoss < 5 || maxLoss > 500) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "daily stop must be $5 to $500" }));
          return;
        }
        const out = setLiveMaxLoss(series, maxLoss, variant);
        if (out.maxLoss == null) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "that market is not on real money" }));
          return;
        }
        r.live.config = liveConfig(series);
        console.log(`dashboard: ${r.series.label} daily stop set to $${out.maxLoss}${out.changed ? "" : " (no change)"}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, series, maxLoss: out.maxLoss, changed: out.changed }));
      });
      return;
    }
    if (req.url === "/api/manual" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        const reply = (code: number, obj: unknown) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        let series = "";
        let side = "";
        let amount = NaN;
        try {
          const parsed = JSON.parse(body || "{}") as { series?: string; side?: string; amount?: number };
          series = String(parsed.series ?? "");
          side = String(parsed.side ?? "");
          amount = Number(parsed.amount);
        } catch {
          side = "";
        }
        const r = [recorder, ...others].find((x) => x.series.key === series);
        if (!r?.live) return reply(400, { error: "unknown market" });
        if (side !== "UP" && side !== "DOWN") return reply(400, { error: "side must be UP or DOWN" });
        // $100 a click is a fat-finger guard, not a strategy limit.
        if (!Number.isFinite(amount) || amount < 1 || amount > 100) return reply(400, { error: "amount must be $1 to $100" });
        const m = r.market;
        const end = m ? m.start + r.series.windowSec : 0;
        if (!m || end <= Math.floor(Date.now() / 1000)) return reply(409, { error: "no open window right now, try again in a few seconds" });
        try {
          const out = await r.live.manualBuy(side, amount, m, end);
          if (!out.ok) return reply(409, { error: out.error ?? "not filled", trade: out.trade ?? null });
          return reply(200, { ok: true, trade: out.trade });
        } catch (error) {
          return reply(500, { error: error instanceof Error ? error.message : String(error) });
        }
      });
      return;
    }
    if (req.url === "/api/pause" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let series = "";
        let variant = "";
        let on = false;
        try {
          const parsed = JSON.parse(body || "{}") as { series?: string; variant?: string; on?: boolean };
          series = String(parsed.series ?? "");
          variant = String(parsed.variant ?? "");
          on = Boolean(parsed.on);
        } catch {
          variant = "";
        }
        const r = [recorder, ...others].find((x) => x.series.key === series);
        if (!r?.live || !r.live.config.variants.some((v) => v.variant === variant)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unknown market or rule" }));
          return;
        }
        r.live.setPaused(variant, on);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, series, variant, paused: on }));
      });
      return;
    }
    if (req.url?.startsWith("/api/events")) {
      const sec = new URL(req.url, "http://x").searchParams.get("sec") ?? "";
      eventsStatus(sec)
        .then((j) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(j));
        })
        .catch((e: Error) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        });
      return;
    }
    if (req.url === "/api/status") {
      res.writeHead(200, { "content-type": "application/json" });
      const mine = recorder.status() as { live?: { balance?: number | null; toClaim?: number; chain?: Record<string, number> | null } | null };
      const cash = mine.live?.balance != null ? (mine.live.chain?.pUSD ?? mine.live.balance) + (mine.live.chain?.["USDC.e"] ?? 0) + (mine.live.chain?.USDC ?? 0) : null;
      res.end(JSON.stringify({ build, ...mine, walletHistory: walletHistorySummary(cash, mine.live?.toClaim ?? 0), solana: solanaSummary(), solanaCopy: solanaCopySummary(), solanaCopyLive: solanaCopyLiveSummary(), withdraw: withdrawSummary(), series: others.map((r) => r.status()), eventPaper: loadJson<unknown>("eventpaper-summary.json", null), budgets: [...budgets(), pairliveSummary().budget, pairfastliveSummary().budget], pairlive: pairliveSummary(), pairfastlive: pairfastliveSummary(), preopen: preopenSummary(), pairlock: pairlockSummary(), pairfast: pairfastSummary() }));
      return;
    }
    if (req.url === "/favicon.svg" || req.url === "/favicon.ico") {
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
      res.end(FAVICON);
      return;
    }
    const logo = /^\/logo\/([a-z]+)\.png$/.exec(req.url ?? "");
    if (logo && LOGOS[logo[1]]) {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
      res.end(LOGOS[logo[1]]);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(PAGE);
  });
  return new Promise<typeof server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(STATUS_PORT, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

// Dark navy tile with a rising green line ending in an orange "live" dot, matching the page colours.
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect x="1" y="1" width="30" height="30" rx="7" fill="#151922" stroke="#2a3042" stroke-width="2"/>
<polyline points="7,22 12,17 16,19 23,10" fill="none" stroke="#3ddc84" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="24" cy="9" r="3.5" fill="#f7931a"/>
</svg>`;

// Top-level dashboards (see notes/dashboards.md). Add one here: it gets a tab, a #<id> deep link and a <section id="sec-<id>">.
// A dashboard with no content yet shows its placeholder; crypto's section is the existing page below.
// paper: true = the tab has a paper logger (src/eventpaper.ts); it shows that lab instead of the "coming" placeholder and loses the SOON badge.
const SECTIONS: { id: string; label: string; soon?: string; paper?: boolean }[] = [
  { id: "solana", label: "Solana" },
  { id: "crypto", label: "Crypto" },
  { id: "football", paper: true, label: "Football", soon: "Polymarket football (soccer) markets, in-play and pre-match, will live here with their own real-money panel, trade log and paper lab." },
  { id: "esports", paper: true, label: "Esports", soon: "Polymarket esports map and match markets will live here with their own panels and paper lab." },
  { id: "us-sports", label: "US Sports", soon: "Polymarket NBA, NFL and NHL game markets will live here with their own panels and paper lab." },
  { id: "indices", paper: true, label: "Indices & Commodities", soon: "Polymarket daily up/down markets on indices and commodities (SPX, Gold, Oil) will live here with their own panels and paper lab." },
  { id: "tennis", paper: true, label: "Tennis", soon: "Polymarket tennis match markets." },
  { id: "weather", paper: true, label: "Weather", soon: "Polymarket daily city temperature markets will live here with their own panels and paper lab." },
  { id: "politics", paper: true, label: "Politics", soon: "Polymarket politics and election markets will live here with their own panels and paper lab." },
  { id: "other", paper: true, label: "Other", soon: "Event markets that fit no other tab will live here." },
];
const hx = (x: string) => x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
// Two groups since 11 Nov 2026 (enrique: predictions "on the side", Solana in front): the top bar picks Solana or Prediction markets;
// the prediction categories keep their own bar (#secs) below it and everything inside them works as before.
const GRP_NAV = '<nav class="secs grp" id="grp"><button class="gb" data-g="solana">Solana</button><button class="gb" data-g="pred">Prediction markets<span class="n" id="grp-n"></span></button></nav>';
const SOLANA_HTML = `<section class="sec hide" id="sec-solana">
<div class="panel" style="margin-bottom:14px"><div class="hero"><div style="min-width:0"><div class="k">solana <span class="tag paper hide" id="sol-tag">paper · simulated, no money</span></div><div class="v big" style="font-size:30px" id="sol-state">being built</div><div class="mut" style="margin-top:6px;max-width:680px;line-height:1.5;white-space:normal" id="sol-note">Nothing trades on Solana yet: no wallet is connected and no order has been sent. This page fills in by itself when the Solana bot starts reporting.</div></div>
<div class="stats" id="sol-stats"><div><div class="k">real on</div><div class="v big">0</div></div><div><div class="k">real today</div><div class="v big">$0.00</div></div><div><div class="k">real all time</div><div class="v big">$0.00</div></div><div><div class="k">real trades</div><div class="v big">0</div></div></div></div></div>
<div class="grid hide" id="sol-real">
  <div class="panel"><div class="ph"><div class="k">real money <span class="tag real">real</span></div><div class="mut" id="sol-lstate"></div></div><div class="stats" id="sol-lst"></div><div class="note" id="sol-lnote" style="margin-bottom:12px"></div><div id="sol-ltbl"></div><div class="wps" id="sol-lpills" style="margin-top:10px"></div></div>
  <div class="panel"><div class="ph"><div class="k">real trade log <span class="tag real">real</span></div><div class="mut" id="sol-llsub"></div></div><div id="sol-lhold" style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:12px;line-height:1.5;white-space:normal"></div><div id="sol-llog"></div></div>
</div>
<div class="hide" id="sol-copy">
<div class="panel" style="margin-bottom:14px"><div class="ph"><div class="k">speed: how fast are we? <span class="tag paper">paper</span></div><div class="mut" id="sol-csub"></div></div><div class="stats" id="sol-cspeed"></div><div class="note" id="sol-cnote"></div></div>
<div class="grid">
  <div class="panel"><div class="ph"><div class="k">wallets we follow <span class="tag paper">paper</span></div><div class="mut">most followers in the first 4 s on top</div></div><div id="sol-cw"></div></div>
  <div class="panel"><div class="ph"><div class="k">in-and-out rules <span class="tag paper">paper</span></div><div class="mut" id="sol-crsub"></div></div><div id="sol-cr"></div></div>
</div>
<div class="panel" style="margin-bottom:14px"><div class="ph"><div class="k">trade log: wallet buys we saw <span class="tag paper">paper</span></div><div class="mut">newest first · nothing was sent</div></div><div id="sol-clog"></div></div>
<div class="panel" style="margin-bottom:14px"><div class="ph"><div class="k">feeds &amp; recorder</div><div class="mut">listens only · no wallet, no orders</div></div><div class="wps" id="sol-cfeeds"></div></div>
</div>
<div class="panel hide" style="margin-bottom:14px" id="sol-lph"><div class="k">second test: lending to a pool for fees <span class="tag paper">paper</span></div><div class="mut" style="margin-top:6px;line-height:1.5;white-space:normal" id="sol-lpnote"></div></div>
<div class="grid">
  <div class="panel"><div class="ph"><div class="k">strategies <span class="tag paper hide" id="sol-rtag">paper</span></div><div class="mut" id="sol-rsub">none yet</div></div><div id="sol-rules"><div class="empty">No Solana strategy exists yet. Real and paper strategies will be listed here, real first.</div></div></div>
  <div class="panel"><div class="ph"><div class="k">trade log <span class="tag paper hide" id="sol-ltag">paper</span></div><div class="mut" id="sol-lsub"></div></div><div id="sol-log"><div class="empty">No Solana trades yet.</div></div></div>
</div>
<div class="panel hide" style="margin-bottom:14px" id="sol-daysp"><div class="ph"><div class="k">day by day <span class="tag paper">paper</span></div><div class="mut">Korean days · all rules together, against just holding</div></div><div id="sol-days"></div></div>
<div class="panel hide" style="margin-bottom:14px" id="sol-feedp"><div class="ph"><div class="k">feeds &amp; recorder</div><div class="mut" id="sol-fsub"></div></div><div class="wps" id="sol-feeds"></div></div>
<div class="panel" style="margin-bottom:14px"><div class="ph"><div class="k">prediction markets, real money <span class="tag real">real</span></div><div class="mut">set aside, still running · <a href="#crypto/overview" style="color:var(--fg)">open</a></div></div>
<div class="stats" id="sol-pm"><span class="mut">loading</span></div><div class="note" id="sol-pmnote"></div></div>
</section>`;
const SEC_NAV = GRP_NAV + '<nav class="secs" id="secs">' + SECTIONS.filter((x) => x.id !== "solana").map((x) => `<button class="sb" data-s="${x.id}">${hx(x.label)}${x.soon && !x.paper && !CATS[x.id] ? '<span class="soon">soon</span>' : ""}</button>`).join("") + "</nav>";
// Categories in CATS (src/eventdash.ts) get the full event layout, filled from /api/events?sec=<id> by evRender() in the page.
const SEC_PLACEHOLDERS = SOLANA_HTML + "\n" + SECTIONS.filter((x) => x.id !== "crypto" && x.id !== "solana").map((x) => (CATS[x.id] ? evSectionHtml(x.id, x.label) : `<section class="sec hide" id="sec-${x.id}"><div class="panel emptytab"><b>${hx(x.label)} is coming.</b><br>${hx(x.soon ?? "")}</div></section>`)).join("\n");

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Pred bot</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{--bg:#0f1117;--panel:#151922;--line:#232838;--fg:#e8eaf0;--mut:#7b8294;--up:#3ddc84;--down:#ff6b6b;--acc:#f7931a;--pur:#9b7bff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
main{max-width:2400px;margin:0 auto;padding:28px 28px 60px}
.top{display:flex;align-items:center;gap:14px;margin-bottom:12px;flex-wrap:wrap}.tabs{display:flex;gap:4px;margin:0 0 16px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:10px}.tabs .tb{font:inherit;font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:6px 14px;border-radius:999px;border:1px solid transparent;background:none;color:var(--mut);cursor:pointer}.tabs .tb:hover{color:var(--fg)}.tabs .tb.on{color:var(--fg);border-color:var(--fg)}.tabs .tb .n{margin-left:8px;font-size:10px;color:var(--mut);letter-spacing:0;text-transform:none}.tabs .tb .n .ok{color:var(--up)}.tabs .tb .n .bad{color:var(--down)}.hide{display:none!important}.secs{display:flex;gap:2px;margin:0 0 14px;border-bottom:1px solid var(--line);overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-webkit-overflow-scrolling:touch}.secs::-webkit-scrollbar{display:none}.secs .sb{flex:0 0 auto;white-space:nowrap}@media(max-width:900px){.secs .sb{padding:8px 10px 9px;letter-spacing:.1em}.secs .sb .soon{display:none}}.secs .sb{font:inherit;font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;padding:8px 16px 9px;margin-bottom:-1px;background:none;border:0;border-bottom:2px solid transparent;color:var(--mut);cursor:pointer}.secs .sb:hover{color:var(--fg)}.secs .sb.on{color:var(--fg);border-bottom-color:var(--fg)}.secs .sb .soon{margin-left:7px;font-size:9px;font-weight:400;letter-spacing:.08em;color:var(--mut);border:1px solid var(--line);border-radius:999px;padding:1px 6px;vertical-align:1px}.ov td.r b{font-weight:600}.ov .mut.sm{font-size:11px}.emptytab{padding:28px 0;color:var(--mut);font-size:13px;line-height:1.7}
h1{font-size:20px;margin:0;font-weight:700;letter-spacing:.2px}
.pill{font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:4px 10px;border-radius:999px;border:1px solid var(--line);color:var(--mut)}
.pill.live{color:#0f1117;background:var(--up);border-color:var(--up);font-weight:700}
.pill.dry{color:var(--acc);border-color:var(--acc)}
.tag{font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding:2px 8px;border-radius:999px;margin-left:8px;vertical-align:middle;white-space:nowrap;display:inline-block}
.tag.real{color:#0f1117;background:var(--up)}
.wps{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}.wp{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--mut);white-space:nowrap}.wp b{color:var(--fg);font-weight:600}.wp a{color:var(--fg);text-decoration:none;border-bottom:1px dotted var(--mut)}.wp .d{width:6px;height:6px;border-radius:50%;background:var(--mut)}.wp.ok .d{background:var(--up)}.wp.bad{border-color:var(--down)}.wp.bad .d{background:var(--down)}
.tag.paper{color:var(--pur);border:1px solid var(--pur)}
.panel.real{border-color:var(--up);overflow-x:hidden}.rules td{white-space:nowrap}.rules td:first-child{max-width:190px;}body.ov-tab .rules td:first-child{max-width:260px;overflow:hidden;text-overflow:ellipsis}.rules th,.rules td{padding-left:5px;padding-right:5px}.rules td.acts{white-space:nowrap}.rules .acts .btn{margin-left:2px}.st{font-style:normal;margin-left:6px;font-size:11px;vertical-align:middle}.st.bad{color:var(--down)}.st.mut{color:var(--mut)}.st.warn{color:var(--acc,#ffb347)}.nf{color:var(--mut);font-size:10px;display:inline-block;width:2.4em;margin-left:4px;text-align:left;vertical-align:middle}.lad{color:var(--mut);display:inline-block;width:1.1em;margin-left:3px;text-align:left}.pop{position:absolute;z-index:6;background:var(--panel,#151922);border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-size:12px;min-width:210px;box-shadow:0 6px 20px rgba(0,0,0,.4)}.pop .ph{font-weight:600;margin-bottom:4px}.pop div:not(.ph):not(.sub){display:flex;justify-content:space-between;gap:16px;padding:3px 0}.pop div span:first-child{color:var(--mut)}.pop .sub{color:var(--mut);font-size:10px;margin:-2px 0 2px}.pop .sz .pen{opacity:1}
.sub{color:var(--mut);font-size:12px;margin-left:auto}
.grid{display:grid;grid-template-columns:1fr;gap:14px;margin-bottom:14px}
@media(min-width:1400px){.grid{grid-template-columns:1fr 1fr}.panel.logp{display:flex;flex-direction:column;overflow:hidden;min-height:520px}.logwrap{flex:1;min-height:0;position:relative}.logwrap>div{position:absolute;inset:0;overflow:hidden}}
td,th{white-space:nowrap}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;overflow-x:auto}
.hero{display:flex;align-items:center;gap:28px;flex-wrap:wrap}
.clock{font-size:64px;font-weight:700;line-height:1;letter-spacing:-1px}
.clock.soon{color:var(--acc)}
.clock.small{font-size:40px;color:var(--mut)}
.clock.small.soon{color:var(--acc)}.clocks{display:flex;gap:26px;flex-wrap:wrap;align-items:flex-end}.clocks .k{white-space:nowrap}.rules td .mk{color:var(--mut);font-weight:400;font-size:11px;margin-left:6px;text-decoration:none;border-bottom:1px dotted var(--mut)}.rules td .mk:hover{color:var(--fg)}.rules td .mk .ci{margin-right:3px}.rec{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--mut)}.rec b{color:var(--fg);font-weight:600}.ov tr.lnk{cursor:pointer}.ov tr.lnk:hover td{background:rgba(255,255,255,.03)}
.chart .px{display:flex;justify-content:space-between;align-items:baseline;margin:2px 0 4px}
.chart .px b{font-size:15px;font-weight:600}
.chart .lean{font-weight:700}
.chart{position:relative;overflow:hidden}
@keyframes wonup{0%{box-shadow:inset 0 0 0 1px var(--up),0 0 18px rgba(61,220,132,.45)}100%{box-shadow:inset 0 0 0 1px var(--up),0 0 0 rgba(61,220,132,0)}}
@keyframes wondown{0%{box-shadow:inset 0 0 0 1px var(--down),0 0 18px rgba(255,107,107,.45)}100%{box-shadow:inset 0 0 0 1px var(--down),0 0 0 rgba(255,107,107,0)}}
.chart.won.up{border-color:var(--up);animation:wonup 1.2s ease-out}
.chart.won.down{border-color:var(--down);animation:wondown 1.2s ease-out}
@keyframes stamp{0%{opacity:0;transform:translate(-50%,-50%) scale(1.6)}18%{opacity:1;transform:translate(-50%,-50%) scale(1)}80%{opacity:1}100%{opacity:0}}
.chart .stamp{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2;text-align:center;padding:8px 16px;border-radius:8px;background:rgba(15,17,23,.88);border:1px solid var(--line);animation:stamp 5s ease-out forwards;pointer-events:none}
.chart .stamp b{display:block;font-size:22px;letter-spacing:.08em}
.chart .stamp span{font-size:11px;color:var(--mut)}
.chart.won.up .stamp{border-color:var(--up)}.chart.won.up .stamp b{color:var(--up)}
.chart.won.down .stamp{border-color:var(--down)}.chart.won.down .stamp b{color:var(--down)}
.chart.sig{border-color:var(--up);box-shadow:0 0 0 1px var(--up),0 0 14px rgba(61,220,132,.35)}.chart .sigtag{position:absolute;left:50%;top:56%;transform:translate(-50%,-50%);z-index:2;background:rgba(15,17,23,.88);border:1px solid var(--up);border-radius:6px;padding:3px 9px;white-space:nowrap;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--up);font-weight:600;animation:blink 1s steps(2) infinite}@keyframes blink{50%{opacity:.35}}.chart .px .mv{font-size:11px;margin-left:auto;padding-left:8px}
.k{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);margin-bottom:4px}
.v{font-size:16px}
.v.big{font-size:26px;font-weight:700}
.stats{display:flex;gap:26px;flex-wrap:wrap}
.rules th,.rules td{padding-left:6px;padding-right:6px}.rules tr.gh th{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--mut);padding-bottom:0;border-bottom:0;text-align:center}.rules tr.gh th.grp-today{border-bottom:1px solid var(--up);color:var(--up)}.rules tr.gh th.grp-all{border-bottom:1px solid var(--line)}.rules td.tdy{color:var(--fg)}.rules td.tdy.ok{color:var(--up)}.rules td.tdy.bad{color:var(--down)}.rules td.tdy.mut{color:var(--mut)}.rules td.alt{color:var(--mut)}.rules td.alt.ok{color:var(--up);opacity:.8}.rules td.alt.bad{color:var(--down);opacity:.8}
.stats.tight{flex-wrap:nowrap;gap:0;justify-content:space-between;overflow:hidden}.stats.tight>div{flex:0 1 auto;min-width:0}.stats.tight .v.big{font-size:clamp(17px,1.5vw,26px);white-space:nowrap}
.ok{color:var(--up)}.bad{color:var(--down)}.acc{color:var(--acc)}.mut{color:var(--mut)}
a{color:var(--fg);text-decoration:none;border-bottom:1px dotted var(--mut)}a:hover{color:var(--acc);border-color:var(--acc)}
.ph{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px}
.ph .k{margin:0;flex:none;white-space:nowrap}
table{width:100%;border-collapse:collapse}
th{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);text-align:left;font-weight:500;padding:0 0 8px}
td{padding:7px 14px 7px 0;border-top:1px solid var(--line);white-space:nowrap}
td:last-child,th:last-child{padding-right:0}
th{padding-right:14px}
.r{text-align:right}
tr.hi td{color:var(--fg);font-weight:600}
tr.dim td{color:var(--mut)}
tr.grp td{padding:12px 0 6px;border-top:1px solid var(--line);background:none}
tr.grp td>span{display:inline-flex;align-items:center;gap:6px}
tr.grp td .gs{display:flex;flex-wrap:wrap;gap:0 6px;margin-top:4px;color:var(--mut);font-size:12px}
tr.grp td .gs b{font-weight:600}
tr.grp:first-child td{border-top:none;padding-top:4px}
tr.grp+tr td{border-top:none}
.log td{font-size:13px}
.rcell{display:flex;align-items:center;gap:8px;min-width:0;max-width:230px}body.ov-tab .rcell{max-width:250px}.rcell .st{flex:0 0 auto;margin-left:0}body.ov-tab .rules td:first-child{max-width:260px}.rcell .mk{margin-left:0;border-bottom:none;flex:0 0 auto}.ctk{display:inline-flex;align-items:center;white-space:nowrap}.ctk .coin{margin-right:4px}.ctk .tk{display:inline-block;min-width:3.3em;font-size:11px;color:var(--mut);letter-spacing:.04em}.rnm{display:inline-flex;min-width:0;max-width:100%;overflow:hidden;white-space:nowrap;align-items:baseline}.rnm .rh{flex:0 100 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--mut);font-weight:400}.rnm .rt{flex:0 0 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}.st.mkr{margin-left:6px;color:#7aa2ff;font-size:10px;letter-spacing:.06em}.log td.rn .rnm b{font-weight:400;color:var(--fg)}
.log tr.dsep td{padding:7px 0 3px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);border-bottom:1px solid var(--line)}
.rules tr.p2 td,body.ov-tab .rules tr.p2 td:first-child{max-width:0;overflow:visible;text-overflow:clip;padding-right:48px}.rules tr.p2 td{border-top:none;padding-top:0;padding-bottom:9px;font-size:11px;color:var(--mut);white-space:normal}.rules tr.p2 td b{color:var(--fg)}.log tr.p2 td{border-top:none;padding-top:0;font-size:12px;white-space:normal;color:var(--mut)}.log{width:100%}.log td{white-space:nowrap}.log td.rn{max-width:0;width:40%;overflow:hidden;text-overflow:ellipsis}
.empty{color:var(--mut);padding:14px 0;text-align:center}
.note{color:var(--mut);font-size:12px;margin-top:14px}
.btn{font:inherit;font-size:11px;color:var(--mut);background:none;border:1px solid var(--line);border-radius:6px;padding:2px 8px;cursor:pointer}
.btn:hover{color:var(--down);border-color:var(--down)}
.btn.restore:hover{color:var(--up);border-color:var(--up)}
.wallet{position:relative}.wallet svg{display:block;width:100%;height:200px;cursor:crosshair}.wallet .hx{stroke:#e8eaf0;stroke-width:1;stroke-dasharray:3 3;opacity:.7}.wallet .wtip{position:absolute;pointer-events:none;background:rgba(15,17,23,.94);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;line-height:1.5;white-space:nowrap;z-index:3}#wsub b{color:var(--fg);font-weight:600}.wallet .gt{font-size:10px;fill:var(--mut)}.wallet .gl{stroke:var(--line)}.wallet .est{fill:none;stroke:#8c8cff;stroke-width:1.6}.wallet .act{fill:none;stroke:#e8eaf0;stroke-width:1.2}.wallet .dep{fill:#3ddc84;opacity:.85}.wallet .fill{fill:rgba(140,140,255,.10)}.wallet .last{font-size:12px;font-weight:600;fill:#e8eaf0}.wallet .empty{color:var(--mut);font-size:12px}.rng{display:inline-flex;gap:3px;margin-left:12px;vertical-align:middle}.rng .btn{flex:none;padding:1px 7px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;border-radius:999px;font-weight:600;line-height:1.5}.rng .btn.on{color:var(--fg);border-color:var(--fg)}
.btn.icon{padding:1px 5px;font-size:10px;line-height:1.3}.charts.bets{display:none}.chart .bet{border:0;border-top:1px solid var(--line);border-radius:0;padding:6px 0 2px;margin:6px -8px 0;padding-left:8px;padding-right:8px}.bet{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 8px;transition:box-shadow .3s}.bet .brow{display:flex;align-items:center;gap:6px}.bet .cur{color:var(--mut);font-size:12px}.bet input{width:56px;min-width:0;background:transparent;border:1px solid var(--line);border-radius:6px;color:var(--fg);font:inherit;font-size:12px;padding:3px 6px}.bet .btn{flex:1;font-size:11px;padding:4px 6px;font-weight:600;letter-spacing:.04em}.bet .bup{color:var(--up);border-color:rgba(61,220,132,.45)}.bet .bdown{color:var(--down);border-color:rgba(255,107,107,.45)}.bet .bup:not(:disabled):hover{background:rgba(61,220,132,.12)}.bet .bdown:not(:disabled):hover{background:rgba(255,107,107,.12)}.bet .btn:disabled{opacity:.35;cursor:not-allowed}.bet .bmin{font-size:10px;margin-top:4px}.bet.busy{box-shadow:0 0 0 1px var(--acc)}.bet.done{box-shadow:0 0 0 1px var(--up)}.bet.fail{box-shadow:0 0 0 1px var(--down)}#quota{flex:1 1 560px;min-width:440px;max-width:960px;margin-left:auto;align-self:center}#quota .qhead>*{white-space:nowrap}#quota .qhead{display:flex;align-items:baseline;gap:8px;font-size:12px}#quota .qhead .lbl{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--mut)}#quota .qhead b{font-size:16px;font-family:var(--mono,inherit)}#quota .qtag{margin-left:auto;font-size:10px;letter-spacing:.08em;text-transform:uppercase}#quota .qbar{position:relative;display:flex;height:10px;border-radius:5px;background:rgba(255,255,255,.06);overflow:hidden;margin:6px 0 5px}#quota .seg{display:block;height:100%;transition:width .6s ease}#quota .seg+.seg{border-left:1px solid var(--bg,#0f1117)}#quota .seg.used{background:rgba(232,234,240,.55)}#quota .qleg i.us{background:rgba(232,234,240,.55)}#quota .qsub{font-size:10px}#quota .seg.spare{background:repeating-linear-gradient(135deg,rgba(255,255,255,.18) 0 3px,transparent 3px 6px)}#quota .qbar.over{box-shadow:inset 0 0 0 1px var(--down)}#quota .cap{position:absolute;top:0;bottom:0;width:2px;background:rgba(255,255,255,.5)}#quota .qleg{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:10px;color:var(--mut)}#quota .qleg b{color:var(--fg,#fff);font-weight:500}#quota .qleg i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;vertical-align:-1px}#quota .qleg i.sp{background:repeating-linear-gradient(135deg,rgba(255,255,255,.3) 0 2px,transparent 2px 4px)}.sz{background:none;border:0;color:inherit;font:inherit;cursor:pointer;padding:0}.sz .pen{color:var(--mut);font-size:10px;margin-left:4px;opacity:0;transition:opacity .15s}tr:hover .sz .pen{opacity:1}.sz:hover{color:var(--acc,#fff)}
.btn.go{padding:0 3px;font-size:7px;line-height:1.6;margin-left:5px;opacity:0;transition:opacity .2s;vertical-align:1px}
tr:hover .btn.go{opacity:1}.btn.go:hover{color:var(--up);border-color:var(--up)}
.btn.paper:hover{color:var(--pur);border-color:var(--pur)}
.tag.live{color:#0f1117;background:var(--up);margin-left:6px;padding:1px 6px;font-size:9px}
td.islive{background:rgba(61,220,132,.07)}td.pc.islive{box-shadow:inset 0 0 0 1px rgba(61,220,132,.25);border-radius:4px}
@keyframes sent{0%{background:rgba(61,220,132,.5)}100%{background:rgba(61,220,132,.07)}}
td.sent{animation:sent 1.4s ease-out}
@keyframes rowout{to{opacity:0;transform:translateX(40px)}}
tr.out>td{animation:rowout .4s ease-in forwards}
@keyframes panelpulse{0%{box-shadow:0 0 0 0 rgba(61,220,132,.6)}100%{box-shadow:0 0 0 14px rgba(61,220,132,0)}}
.panel.pulse{animation:panelpulse .9s ease-out}
tr.off td{opacity:.45}
.tag.new{color:var(--acc);border:1px solid var(--acc)}
.info{display:inline-block;width:14px;height:14px;line-height:13px;text-align:center;border-radius:50%;border:1px solid var(--line);color:var(--mut);font-size:10px;font-style:italic;cursor:help;position:relative;vertical-align:middle;margin-left:4px}
.info:hover{color:var(--fg);border-color:var(--mut)}
.info:hover::after{content:attr(data-tip);position:absolute;left:18px;top:-4px;z-index:5;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 8px;color:var(--fg);font-style:normal;font-size:11px;white-space:normal;width:280px;text-align:left;line-height:1.4}
#labtable{table-layout:auto}#lab td,#labhead th{padding-left:0;padding-right:6px}#lab .btn:not(.go){padding:1px 5px;font-size:10px}
th.pc,td.pc{text-align:right}
th.pc{white-space:nowrap}th.pc .coin{margin-right:4px;width:13px;height:13px;vertical-align:-2px}
td.pc{line-height:1.15;padding-top:5px;padding-bottom:5px}
td.pc .n{font-size:12px}td.pc .c{font-size:10px;color:var(--mut);white-space:nowrap}
td.pc.isdry{box-shadow:inset 0 0 0 1px rgba(247,147,26,.35);border-radius:4px;background:rgba(247,147,26,.06)}.ldot.dry{display:inline-block;width:6px;height:6px;border-radius:50%;margin-left:5px;vertical-align:1px;background:var(--acc)!important;box-shadow:0 0 5px var(--acc)!important}td.pc .ldot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--up);box-shadow:0 0 5px var(--up);margin-left:5px;vertical-align:1px}
#lab td:first-child b{font-size:12px}#lab .tag.new{font-size:8px;padding:1px 5px;margin-left:5px}
.charts{display:grid;flex-basis:100%;width:100%;grid-template-columns:repeat(auto-fill,minmax(max(230px,calc(20% - 8px)),1fr));gap:10px;margin-top:16px}
.charts:empty{display:none}
.charts.big{grid-template-columns:2fr 1fr 1fr 1fr}.charts.big>.chart:first-child{grid-row:span 2;display:flex;flex-direction:column}.charts.big>.chart:first-child .t{font-size:12px}.charts.big>.chart:first-child .px b{font-size:20px}.charts.big>.chart:first-child .depth{margin-top:8px}.charts.big>.chart:first-child .bslot{margin-top:auto}.charts.big>.chart:first-child .bet .btn{font-size:14px;padding:10px 8px;letter-spacing:.06em}.charts.big>.chart:first-child .bet input{width:72px;font-size:14px;padding:8px}.charts.big>.chart:first-child .bet .bmin{font-size:11px}.depth svg{width:100%;display:block}.depth.mut{font-size:11px;padding:10px 0}
@media(max-width:1200px){.charts{grid-template-columns:repeat(3,1fr)}.charts.big{grid-template-columns:repeat(3,1fr)}.charts.big>.chart:first-child{grid-row:auto;grid-column:span 3}}
@media(max-width:700px){.charts{grid-template-columns:repeat(2,1fr)}}
.chart{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 8px 4px}
.chart .t{display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px;white-space:nowrap}
.chart .t b{font-weight:600}
.chart svg{width:100%;display:block}
.chart .gl{stroke:var(--line);stroke-width:1}
.chart .gt{font-size:9px;fill:var(--mut);font-family:inherit}
.coin.img{background:none;object-fit:contain}.coin.img+.coin{display:none}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:1px;background:transparent}.dot.dry{background:var(--acc);box-shadow:0 0 6px var(--acc)}.dot.on{background:var(--up);box-shadow:0 0 6px var(--up);animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 4px var(--up);opacity:.75}50%{box-shadow:0 0 11px var(--up),0 0 2px var(--up);opacity:1}}
@keyframes rowin{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
tr.in{animation:rowin .5s ease-out}
@keyframes flashok{0%{background:rgba(61,220,132,.32)}100%{background:transparent}}
@keyframes flashbad{0%{background:rgba(255,107,107,.32)}100%{background:transparent}}
tr.flash-ok>td{animation:flashok 1.8s ease-out}
tr.flash-bad>td{animation:flashbad 1.8s ease-out}
tr.mv{transition:transform .55s cubic-bezier(.2,.8,.2,1)}
tr.dim{transition:opacity .4s}
@keyframes tick{0%{color:#fff;text-shadow:0 0 12px rgba(255,255,255,.55)}100%{text-shadow:none}}
.v.tick{animation:tick 1s ease-out}
@keyframes soon{0%,100%{opacity:1}50%{opacity:.55}}
.clock.soon{animation:soon 1s ease-in-out infinite}
.coin{display:inline-flex;width:16px;height:16px;border-radius:50%;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#0f1117;vertical-align:-3px;margin-right:6px;font-family:ui-sans-serif,system-ui,sans-serif}
.coin.btc{background:#f7931a}.coin.eth{background:#8c9eff}.coin.sol{background:#14f195}.coin.xrp{background:#b3bccb}.coin.doge{background:#c2a633}.coin.bnb{background:#f3ba2f}.coin.hype{background:#97fce4}
#sec-solana table td{white-space:normal}#sec-solana td.nw{white-space:nowrap}#sec-solana tr.m td{padding-bottom:2px}#sec-solana tr.d td{padding-top:0;border-top:none;color:var(--mut);font-size:11px;line-height:1.35}@media(max-width:700px){#sec-solana .nm{display:none}#sec-solana td,#sec-solana th{padding-right:8px}#sec-solana .ph{flex-wrap:wrap;gap:4px}}
@media(max-width:700px){#log,tbody[id$="-rlog"]{display:block}#log tr,tbody[id$="-rlog"] tr{display:grid;grid-template-columns:auto minmax(0,1fr) auto;column-gap:10px;align-items:center;border-top:1px solid var(--line);padding:6px 0}#log tr.grp,tbody[id$="-rlog"] tr.grp{display:block;border-top:none;padding:0}#log tr.dsep,tbody[id$="-rlog"] tr.dsep{display:block;border-top:none;padding:0}#log tr.p2,tbody[id$="-rlog"] tr.p2{display:block;border-top:none;padding:0 0 6px;margin-top:-4px}#log td,tbody[id$="-rlog"] td{border-top:none;padding:1px 0;min-width:0;max-width:none;width:auto}#log tr.grp td,tbody[id$="-rlog"] tr.grp td{display:block;padding:12px 0 6px}#log tr.dsep td,tbody[id$="-rlog"] tr.dsep td{display:block}#log tr.p2 td,tbody[id$="-rlog"] tr.p2 td{display:block}#log td.empty,tbody[id$="-rlog"] td.empty{grid-column:1/-1}#log td:nth-child(1),tbody[id$="-rlog"] td:nth-child(1){grid-row:1;grid-column:1}#log td:nth-child(2),tbody[id$="-rlog"] td:nth-child(2){grid-row:1;grid-column:2;overflow:hidden;text-overflow:ellipsis}#log td:nth-child(6),tbody[id$="-rlog"] td:nth-child(6){grid-row:1;grid-column:3;white-space:normal;max-width:108px;line-height:1.25;justify-self:end;text-align:right}#log td:nth-child(3),tbody[id$="-rlog"] td:nth-child(3){grid-row:2;grid-column:1/-1;justify-self:start;max-width:calc(100% - 152px);overflow:hidden;text-overflow:ellipsis;font-size:12px;text-align:left}#log td:nth-child(4),tbody[id$="-rlog"] td:nth-child(4){grid-row:2;grid-column:1/-1;justify-self:end;margin-right:50px;font-size:12px;color:var(--mut);text-align:right}#log td:nth-child(5),tbody[id$="-rlog"] td:nth-child(5){grid-row:2;grid-column:1/-1;justify-self:end;font-size:12px;color:var(--mut);text-align:right}}
.dt{display:inline-flex;flex-direction:column;line-height:1.15;vertical-align:middle}.dt i{font-style:normal;font-size:10px;color:var(--mut)}
.secs.grp{margin-bottom:10px;border-bottom:none}.secs.grp .gb{font:inherit;font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;padding:9px 18px;border-radius:999px;border:1px solid var(--line);background:none;color:var(--mut);cursor:pointer;margin-right:8px;white-space:nowrap}.secs.grp .gb:hover{color:var(--fg)}.secs.grp .gb.on{color:#0f1117;background:var(--fg);border-color:var(--fg)}.secs.grp .gb .n{margin-left:10px;font-size:11px;font-weight:400;letter-spacing:0;text-transform:none}.secs.grp .gb.on .n,.secs.grp .gb.on .n *{color:#0f1117}
${EV_CSS}</style></head><body><main>
<div class="top"><h1>Pred bot</h1><span class="pill" id="mode">off</span><span class="pill" id="listed">—</span><span class="sub" id="sub">loading</span></div>
${SEC_NAV}
<section class="sec" id="sec-crypto">
<div class="tabs" id="tabs"><button class="tb" data-t="overview">overview</button><button class="tb" data-t="5m">5 min<span class="n" id="n5m"></span></button><button class="tb" data-t="15m">15 min<span class="n" id="n15m"></span></button><button class="tb" data-t="1h">1 hour<span class="n" id="n1h"></span></button><button class="tb" data-t="4h">4 hours<span class="n" id="n4h"></span></button><button class="tb" data-t="24h">24 hours<span class="n" id="n24h"></span></button></div>

<div class="panel" style="margin-bottom:14px" data-tabs="overview 5m 15m 1h 4h 24h"><div class="hero">
  <div class="clocks" id="clocks"></div>
  <div class="stats" id="hstats"></div>
  <div id="quota"></div>
  <div class="charts" id="charts"></div>
  <div class="charts bets" id="bets"></div>
</div></div>

<div class="panel emptytab" data-tabs="1h 4h 24h" id="emptytab"></div>

<div class="grid" data-tabs="overview 5m 15m 1h 4h 24h">
  <div class="panel real"><div class="ph"><div class="k">real money <span class="tag real">real</span></div><div class="mut" id="lrule"></div></div>
    <div class="stats tight" style="margin-bottom:6px">
      <div><div class="k">balance</div><div class="v big" id="bal">—</div></div>
      <div><div class="k" title="won, waiting for Polymarket to pay out · plus what the open trades are worth at today's prices">to claim</div><div class="v big" id="claim">—</div></div>
      <div><div class="k" title="balance + to claim: what the wallet should hold once every open trade settles as it is going now and every win is claimed">est. total</div><div class="v big" id="esttot">—</div></div>
      <div><div class="k">today</div><div class="v big" id="today">—</div></div>
      <div><div class="k" id="netk">all time</div><div class="v big" id="net">—</div></div>
      <div><div class="k">trades</div><div class="v big" id="ltr">—</div></div>
      <div><div class="k" id="lwonk" title="win rate of the rules listed below (all time); every real trade ever is in the trades and all-time columns">won</div><div class="v big" id="lwon">—</div></div>
    </div>
    <div id="alltime" style="font-size:13px;margin-bottom:6px"></div>
    <div class="mut" id="ledger" style="font-size:12px;margin-bottom:12px"></div>
    <div id="pop" class="pop" style="display:none"></div><table style="margin-bottom:12px" class="rules"><thead><tr class="gh"><th></th><th></th><th colspan="3" class="grp-today">today</th><th colspan="3" class="grp-all">all time</th><th></th></tr><tr><th>strategy</th><th class="r">size</th><th class="r">net</th><th class="r">trades</th><th class="r">won</th><th class="r">net</th><th class="r">trades</th><th class="r">won</th><th></th></tr></thead><tbody id="lrules"></tbody></table><div class="note" id="lsince"></div>
    <div class="wps" id="lstate"></div>
  </div>
  <div class="panel real logp"><div class="ph"><div class="k">real trade log <span class="tag real">real</span></div><div class="mut" id="lopen"></div></div>
    <div class="logwrap" id="logwrap"><div><table class="log"><tbody id="log"></tbody></table></div></div>
  </div>
</div>

<div class="panel" style="margin-bottom:14px" data-tabs="overview"><div class="ph"><div class="k">wallet since the start <span class="tag real">real</span><span class="rng" id="wrng" title="range shown; start, top-ups and net follow it"><button class="btn on" data-r="all">all</button><button class="btn" data-r="30d">30d</button><button class="btn" data-r="7d">7d</button><button class="btn" data-r="3d">3d</button><button class="btn" data-r="24h">24h</button><button class="btn" data-r="6h">6h</button><button class="btn" data-r="1h">1h</button></span></div><div class="mut" id="wsub"></div></div>
<div id="wallet" class="wallet"></div></div>
<div class="panel" style="margin-bottom:14px" data-tabs="overview"><div class="ph"><div class="k">budgets by category <span class="tag real">real</span></div></div><div id="budgets" style="padding:10px 14px"></div></div>

<div class="panel" style="margin-bottom:14px" data-tabs="overview"><div class="ph"><div class="k">by window length</div><div class="mut">real money per window length · best paper rule on those markets at $5 a trade</div></div>
<table class="ov"><thead><tr><th>window</th><th class="r">markets</th><th class="r">real rules on</th><th class="r">today</th><th class="r">all time</th><th class="r">trades</th><th class="r">won</th><th>best paper rule</th></tr></thead><tbody id="ov"></tbody></table></div>

<div class="panel" style="margin-bottom:14px" data-tabs="overview"><div class="ph"><div class="k">by rule <span class="tag real">real</span></div><div class="mut">real money per rule and market · most positive today first, then all time · green dot = live now, amber dot = dry run (no real money), no dot = back on paper</div></div>
<table class="rules"><thead><tr class="gh"><th></th><th></th><th></th><th colspan="3" class="grp-today">today</th><th colspan="3" class="grp-all">all time</th></tr><tr><th title="green dot = trading real money now; no dot = on paper">rule</th><th>market</th><th class="r">size</th><th class="r">net</th><th class="r">trades</th><th class="r">won</th><th class="r">net</th><th class="r">trades</th><th class="r">won</th></tr></thead><tbody id="ovr"></tbody></table></div>

<div class="panel" style="margin-bottom:14px" data-tabs="overview 5m 15m 1h 4h 24h"><div class="ph"><div class="k">real money, day by day <span class="tag real">real</span></div><div class="mut">Korean days</div></div>
<table><thead><tr><th>day</th><th class="r">trades</th><th class="r">won</th><th class="r">net</th><th>by market</th></tr></thead><tbody id="cmp"></tbody></table></div>

<div class="panel" style="margin-bottom:14px" data-tabs="overview 5m 15m 1h 4h 24h"><div class="ph"><div class="k">paper lab <span class="tag paper">paper · simulated, no money</span></div><div class="mut" id="labsub" style="text-align:right">top 20 by fillable net · $5 a trade</div></div>
<table id="labtable"><thead id="labhead"></thead><tbody id="lab"></tbody></table><div class="note" data-tabs="5m 15m 1h 4h 24h">Discard stops a rule simulating on every market; it can be restored from the bottom of the list. A rule trading real money cannot be discarded until it is taken out of data/live.json.</div></div>

<div class="panel" style="margin-bottom:14px" data-tabs="overview 5m 15m"><div class="ph"><div class="k">fast pair test, paper versions <span class="tag paper">paper · simulated, no money</span></div><div class="mut" id="pfsub" style="text-align:right"></div></div>
<table><thead><tr><th>rule</th><th>market</th><th class="r">today</th><th class="r">all time</th><th class="r">windows</th><th class="r">won</th><th class="r">full pairs</th><th class="r">lone clips</th></tr></thead><tbody id="pfpaper"></tbody></table></div>

<div class="panel" style="margin-bottom:14px" data-tabs="overview"><div class="ph"><div class="k">feeds &amp; recorder</div><div class="rec"><span>windows <b id="wd">—</b></span><span>settled <b id="ws">—</b></span><span>waiting <b id="wp">—</b></span><span>snapshots <b id="sn">—</b></span><span id="err"></span></div></div>
  <table><thead><tr><th>coin</th><th>chainlink</th><th>binance</th><th>coinbase</th><th title="Binance USDT perpetual, for the basis rules">perp</th></tr></thead><tbody id="feeds"></tbody></table>
</div>
<div class="note" id="note"></div>
</section>
${SEC_PLACEHOLDERS}
</main><script>
var el=function(id){return document.getElementById(id)};
var money=function(n){return n==null?"—":"$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})};
var signed=function(n){return n==null?"—":(n<0?"-":"+")+"$"+Math.abs(n).toFixed(2)};
var cents=function(n){return n==null?"—":Math.round(n*100)+"¢"};
var COINS={btc:"\u20bf",eth:"\u039e",sol:"\u25ce",xrp:"\u2715",doge:"D",bnb:"B",hype:"H"};
var coin=function(label){var k=String(label||"").split(" ")[0].toLowerCase();if(!COINS[k])return "";
return '<img class="coin img" alt="'+k.toUpperCase()+'" title="'+k.toUpperCase()+'" src="/logo/'+k+'.png" onerror="this.remove()"><span class="coin '+k+'" title="'+k.toUpperCase()+'">'+COINS[k]+"</span>"};
var hq=function(x){return String(x).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})};var rname=function(n,mk){n=String(n||"");var tk=n.split("-").filter(function(t){return !/^\\d+(m|h)$/.test(t)});var nt=Math.min(3,Math.max(1,tk.length-2));var head=tk.length>nt?tk.slice(0,tk.length-nt).join("-")+"-":"";var tail=tk.slice(tk.length-nt).join("-");return '<span class="rnm" title="'+hq(n)+'">'+(head?'<span class="rh">'+hq(head)+'</span>':'')+'<b class="rt">'+hq(tail)+'</b>'+(mk?'<i class="st mkr" title="maker: rests a bid under the ask instead of taking it">MAKER</i>':'')+'</span>'};
var ctk=function(label){var k=String(label||"").split(" ")[0];return '<span class="ctk" title="'+hq(label||"")+'">'+coin(label)+'<span class="tk">'+hq(k.toUpperCase())+'</span></span>'};
var kday=function(sec){return new Date(sec*1000).toLocaleDateString("en-CA",{timeZone:"Asia/Seoul"})};var kdayLabel=function(sec){var k=kday(sec);var now=Date.now()/1000;var lab=new Date(sec*1000).toLocaleDateString("en-GB",{timeZone:"Asia/Seoul",weekday:"short",day:"numeric",month:"short"});return k===kday(now)?"today · "+lab:k===kday(now-86400)?"yesterday · "+lab:lab};
var hhmm=function(sec){return new Date(sec*1000).toLocaleTimeString("en-GB",{timeZone:"Asia/Seoul",hour:"2-digit",minute:"2-digit"})};var dtm=function(sec){return '<span class="dt"><i>'+new Date(sec*1000).toLocaleDateString("en-GB",{timeZone:"Asia/Seoul",day:"numeric",month:"short"})+'</i>'+hhmm(sec)+'</span>'};
function cls(n){return n==null?"":n<0?"bad":n>0?"ok":""}
var seen={},LABHTML="";
var WINS=["5m","15m","1h","4h","24h"];var WOF=function(lb){var m=/(\\d+)\\s?(m|h|d)\\b/.exec(String(lb||"BTC 5m"));if(!m)return "5m";return m[2]==="d"?"24h":m[1]+m[2]};
var SECS=${JSON.stringify(SECTIONS.map((x) => x.id))};var okTab=function(t){return t==="overview"||WINS.indexOf(t)>=0};var lsGet=function(k){try{return localStorage.getItem(k)}catch(e){return null}};
// Deep links: #crypto, #crypto/15m, #sports (a bare #15m still opens that crypto tab). Without a hash the last section and tab are remembered.
var HROUTE=function(){return String(location.hash||"").replace(/^#[/]?/,"").toLowerCase().split("/")};
var SEC=(function(){var h=HROUTE();if(SECS.indexOf(h[0])>=0)return h[0];if(okTab(h[0]))return "crypto";var s=lsGet("wsec2");return SECS.indexOf(s)>=0?s:"solana"})();var PSEC=(function(){if(SEC!=="solana")return SEC;var s=lsGet("wpsec");return SECS.indexOf(s)>=0&&s!=="solana"?s:"crypto"})();
var TAB=(function(){var h=HROUTE();if(h[0]==="crypto"&&okTab(h[1]))return h[1];if(okTab(h[0]))return h[0];var t=lsGet("wtab");return okTab(t)?t:"overview"})();
function setHash(){var r="#"+(SEC==="crypto"?"crypto/"+TAB:SEC);if(location.hash!==r)try{history.replaceState(null,"",r)}catch(e){}}
function showSec(x){SEC=x;try{localStorage.setItem("wsec2",x)}catch(e){}if(x!=="solana"){PSEC=x;try{localStorage.setItem("wpsec",x)}catch(e){}}var sn=el("secs");if(sn)sn.classList.toggle("hide",x==="solana");var gb=document.querySelectorAll("#grp .gb");for(var gi=0;gi<gb.length;gi++)gb[gi].classList.toggle("on",(gb[gi].getAttribute("data-g")==="solana")===(x==="solana"));SECS.forEach(function(k){var e=el("sec-"+k);if(e)e.classList.toggle("hide",k!==x)});var bs=document.querySelectorAll("#secs .sb");for(var i=0;i<bs.length;i++)bs[i].classList.toggle("on",bs[i].getAttribute("data-s")===x);var ab=document.querySelector("#secs .sb.on");if(ab&&ab.scrollIntoView)try{ab.scrollIntoView({block:"nearest",inline:"nearest"})}catch(e){}document.body.classList.toggle("ov-tab",x==="crypto"&&TAB==="overview");LABHTML="";WKEY="";setHash()}
document.addEventListener("click",function(e){var g=e.target&&e.target.closest?e.target.closest("#grp .gb"):null;if(!g)return;var x=g.getAttribute("data-g")==="solana"?"solana":PSEC;if(x==="crypto")showTab(TAB);showSec(x);poll();if(typeof evPoll==="function")evPoll(true)});
document.addEventListener("click",function(e){var b=e.target&&e.target.closest?e.target.closest("#secs .sb"):null;if(!b)return;showSec(b.getAttribute("data-s"));poll();if(typeof evPoll==="function")evPoll(true)});
window.addEventListener("hashchange",function(){var h=HROUTE();var x=SECS.indexOf(h[0])>=0?h[0]:okTab(h[0])?"crypto":null;if(!x)return;var t=x==="crypto"?(okTab(h[1])?h[1]:okTab(h[0])?h[0]:TAB):TAB;if(x===SEC&&t===TAB)return;if(x==="crypto")showTab(t);showSec(x);poll()});
var NMARK={};function showTab(t){TAB=t;document.body.classList.toggle("ov-tab",SEC==="crypto"&&t==="overview");if(SEC==="crypto")setHash();try{localStorage.setItem("wtab",t)}catch(e){}var bs=document.querySelectorAll("#tabs .tb");for(var i=0;i<bs.length;i++)bs[i].classList.toggle("on",bs[i].getAttribute("data-t")===t);var empty=t!=="overview"&&!NMARK[t];var ps=document.querySelectorAll("[data-tabs]");for(var j=0;j<ps.length;j++){var p=ps[j];if(p.id==="emptytab")p.classList.toggle("hide",!empty);else p.classList.toggle("hide",empty||p.getAttribute("data-tabs").split(" ").indexOf(t)<0)}LABHTML="";WKEY="";el("emptytab").innerHTML=empty?'<b>'+t+' windows are not recorded yet.</b><br>Polymarket runs '+t+' Up/Down markets on BTC, ETH, SOL, XRP, DOGE, BNB and HYPE. Nothing here until the recorder follows them.':""}
document.addEventListener("click",function(e){var b=e.target&&e.target.closest?e.target.closest("#tabs .tb"):null;if(!b)return;showTab(b.getAttribute("data-t"));poll()});
function swap(id,html){var tb=el(id);var before={};var vis=[];Array.prototype.forEach.call(tb.children,function(tr){if(tr.style.display==="none")return;var k=tr.getAttribute("data-k");if(k){before[k]={idx:vis.length,h:tr.offsetHeight,res:tr.getAttribute("data-res")};vis.push(k)}});tb.innerHTML=html;var first=!seen[id];seen[id]=true;var i=0;Array.prototype.forEach.call(tb.children,function(tr){var k=tr.getAttribute("data-k");if(!k)return;var idx=i++;var w=parseFloat(tr.getAttribute("data-w")||"");if(w>0&&Date.now()/1000-w>3600)return;var p=before[k];if(!p){if(!first)tr.classList.add("in");return}
// Rows animate by list position, not by pixel: a row that keeps its place never moves again, whatever a transition in flight did to its measured top.
if(p.idx!==idx){var d=(p.idx-idx)*(p.h||tr.offsetHeight||0);if(Math.abs(d)>1){tr.style.transform="translateY("+d+"px)";void tr.offsetWidth;tr.classList.add("mv");tr.style.transform=""}}var r=tr.getAttribute("data-res");if(r&&p.res&&r!==p.res&&(r==="ok"||r==="bad"))tr.classList.add("flash-"+r)})}
function snapV(){var o={};Array.prototype.forEach.call(document.querySelectorAll(".v.big[id]"),function(e){o[e.id]=e.textContent});return o}
function tickV(prev){Array.prototype.forEach.call(document.querySelectorAll(".v.big[id]"),function(e){if(prev[e.id]!=null&&prev[e.id]!==e.textContent){e.classList.remove("tick");void e.offsetWidth;e.classList.add("tick")}})}
async function goLive(series,label,name){if(!confirm("Put "+name+" on REAL money for "+label+" at $5 a trade, halting after 2 straight losses?"))return;var r=await fetch("/api/golive",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({series:series,variant:name,size:5})});var j=await r.json();if(!r.ok){alert(j.error||"failed");return}await poll();var c=document.getElementById("cell-"+String(label+"|"+name).replace(/[^a-z0-9]/gi,"_"));if(c){c.classList.add("sent")}var panel=el("lrules").closest(".panel");if(panel){panel.classList.remove("pulse");void panel.offsetWidth;panel.classList.add("pulse")}}
async function toPaper(series,variant,btn){if(!confirm("Take "+variant+" off real money here? It keeps simulating on paper."))return;var tr=btn&&btn.closest("tr");if(tr){tr.classList.add("out");await new Promise(function(ok){setTimeout(ok,420)})}var r=await fetch("/api/topaper",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({series:series,variant:variant})});var j=await r.json();if(!r.ok){alert(j.error||"failed");if(tr)tr.classList.remove("out");return}await poll()}
async function editSize(series,variant,cur){var v=prompt("Bet size in $ for "+variant+" (1 to 50), or a ladder like 2,4,6: it climbs a step at each 100 fills with a positive net and drops a step when the last 100 are negative. Polymarket fills 5 shares minimum: a 95c rule needs about $5, a 17c rule fills from $1.",cur);if(v==null)return;var steps=String(v).split(/[\s,→>-]+/).map(Number).filter(function(x){return x>=1&&x<=50});if(!steps.length||String(v).split(/[\s,→>-]+/).filter(Boolean).length!==steps.length){alert("Bet size must be $1 to $50, or steps like 2,4,6");return}var n=steps[0];var r=await fetch("/api/size",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({series:series,variant:variant,size:n,ladder:steps.length>1?steps:null})});var j=await r.json();if(!r.ok)alert(j.error||"failed");else poll()}
async function editHalt(series,variant,cur){var v=prompt("Stop "+variant+" after how many straight losses? 0 = never halt, up to 50. A halted rule stays off until you press play on its row.",cur);if(v==null)return;var n=Number(v);if(!(Number.isInteger(n)&&n>=0&&n<=50)){alert("Halt must be a whole number from 0 to 50");return}var r=await fetch("/api/halt",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({series:series,variant:variant,losses:n})});var j=await r.json();if(!r.ok)alert(j.error||"failed");else poll()}
async function editMaxLoss(series,cur,variant){var v=prompt(variant?"Daily loss stop in $ for "+variant+" on this market (5 to 500). This rule stops for the rest of the KST day once its own loss today reaches it; the other rules keep going.":"Default daily loss stop in $ for each rule on this market (5 to 500). Every rule stops on its own for the rest of the KST day once its loss today reaches it; a rule with its own stop keeps that.",cur);if(v==null)return;var n=Number(v);if(!(n>=5&&n<=500)){alert("Daily stop must be $5 to $500");return}var r=await fetch("/api/maxloss",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({series:series,maxLoss:n,variant:variant||""})});var j=await r.json();if(!r.ok)alert(j.error||"failed");else poll()}
async function pauseRule(series,variant,on){var r=await fetch("/api/pause",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({series:series,variant:variant,on:on})});var j=await r.json();if(!r.ok)alert(j.error||"failed");else poll()}
async function discard(name,restore){if(!restore&&!confirm("Discard "+name+" for good? It stops simulating on every market."))return;var r=await fetch("/api/discard",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:name,restore:restore})});var j=await r.json();if(!r.ok)alert(j.error||"failed");else poll()}
async function poll(){try{var s=await (await fetch("/api/status")).json();if(s.build){if(!window.BLD0)window.BLD0=s.build;else if(s.build!==window.BLD0){location.reload();return}}try{var bg=el("budgets");if(bg)bg.innerHTML=(s.budgets||[]).length?'<table style="width:100%"><tr><th style="text-align:left">category</th><th>budget</th><th>lost</th><th>open bets</th><th>left</th></tr>'+s.budgets.map(function(b){return '<tr><td>'+esc(b.name)+'</td><td style="text-align:center">'+money(b.budget)+'</td><td style="text-align:center">'+money(b.lost)+'</td><td style="text-align:center">'+money(b.open)+'</td><td style="text-align:center"><b>'+money(b.left)+'</b></td></tr>'}).join("")+'</table>':'<span class="mut">no budgets set</span>'}catch(e){}var pfNorm=function(F){if(!F)return null;var o={};for(var k in F)o[k]=F[k];var sk=(F.series||[])[0]||"btc5m";o.now=F.now?(F.now.length!=null?F.now:[{series:sk,start:F.now.start,up:F.now.up,down:F.now.down,cost:F.now.cost,bidUp:F.now.bidUp,bidDown:F.now.bidDown,orders:F.now.orders}]):[];if(o.leftoverWindows==null)o.leftoverWindows=F.loneWindows;if(!(o.series||[]).length)o.offSeries=[sk];return o};var PFL=pfNorm(s.pairfastlive);
try{var PF=(s.pairfast&&s.pairfast.rules)||[];var twin=PFL&&PFL.paperTwin;var pfr=PF.slice().sort(function(a,b){return (b.net||0)-(a.net||0)});var grn=pfr.filter(function(r){return (r.net||0)>0}).length;el("pfsub").textContent=pfr.length?pfr.length+" versions tried · "+grn+" in profit · best first":"";el("pfpaper").innerHTML=pfr.length?pfr.map(function(r){var fp=r.pairNet,ln=r.loneNet;return '<tr><td><b>'+esc(r.name)+'</b>'+(r.name===twin?' <span class="tag real" title="the real fast pair test copies this rule">real too</span>':'')+'</td><td>'+coin(r.market)+esc(r.market||"")+'</td><td class="r '+cls(r.todayNet)+'">'+signed(r.todayNet||0)+'</td><td class="r '+cls(r.net)+'"><b>'+signed(r.net||0)+'</b></td><td class="r">'+(r.windows||0)+'</td><td class="r">'+(r.windows?Math.round(100*(r.won||0)/r.windows)+"%":"—")+'</td><td class="r '+cls(fp)+'">'+(fp==null?"—":signed(fp))+'</td><td class="r '+cls(ln)+'">'+(ln==null?"—":signed(ln)+' <span class="mut">'+(r.loneWindows||0)+'</span>')+'</td></tr>'}).join(""):'<tr><td class="empty" colspan="8">no paper version running</td></tr>'}catch(e){}
var prevV=snapV();
var b=s.lastBook||{};var L=s.live||{mode:"off"};
var plLab=function(k){var m=/^([a-z]+)([0-9]+[mh])$/.exec(String(k||""));return m?m[1].toUpperCase()+" "+m[2]:String(k||"")};
var PTS=[{nm:"fast pair test",P:PFL},{nm:"slow pair test",P:s.pairlive||null}].filter(function(x){return !!x.P});
var plRowsOf=function(T){var PL=T.P;var inT=function(lb){return TAB==="overview"||WOF(lb)===TAB};var keys=(PL.series||[]).concat(PL.offSeries||[]);(PL.recent||[]).concat(PL.now||[]).forEach(function(w){if(keys.indexOf(w.series)<0)keys.push(w.series)});var full=(PL.recent||[]).length>=(PL.windows||0)||keys.length===1;var tdy=kday(Date.now()/1000);
if(keys.length===1){return inT(plLab(keys[0]))?[{T:T,lb:plLab(keys[0]),keys:keys,on:!!PL.on,today:{trades:PL.todayWindows||0,won:(PL.todayWindows||0)===(PL.windows||0)?(PL.won||0):null,net:PL.todayNet||0},all:{trades:PL.windows||0,won:PL.won||0,net:PL.net||0}}]:[]}
if(!full){var any=keys.some(function(k){return inT(plLab(k))});return any?[{T:T,lb:keys.map(plLab).join(" + "),keys:keys,on:!!PL.on,today:{trades:PL.todayWindows||0,won:(PL.todayWindows||0)===(PL.windows||0)?(PL.won||0):null,net:PL.todayNet||0},all:{trades:PL.windows||0,won:PL.won||0,net:PL.net||0}}]:[]}
return keys.filter(function(k){return inT(plLab(k))}).map(function(k){var d={trades:0,won:0,net:0},a={trades:0,won:0,net:0};(PL.recent||[]).forEach(function(w){if(w.series!==k)return;a.trades++;a.net+=w.net;if(w.net>0)a.won++;if(kday(w.start)===tdy){d.trades++;d.net+=w.net;if(w.net>0)d.won++}});return {T:T,lb:plLab(k),keys:[k],on:!!PL.on&&(PL.series||[]).indexOf(k)>=0,today:d,all:a}})};
var plRows=function(){var o=[];PTS.forEach(function(T){o=o.concat(plRowsOf(T))});return o};
var PLR=[];try{PLR=plRows()}catch(e){PLR=[]}var PLON=PLR.filter(function(r){return r.on}).length;var plNow=[];
var PLMEM=window.PLMEM;if(!PLMEM){try{PLMEM=JSON.parse(localStorage.getItem("plmem")||"{}")}catch(e){PLMEM={}}window.PLMEM=PLMEM}var plSec=Math.floor(Date.now()/1000);
PTS.forEach(function(T){var P=T.P,M=PLMEM[T.nm]||(PLMEM[T.nm]={});var cur={};(P.now||[]).forEach(function(w){if(!w.start||!(w.up>0||w.down>0))return;var k=w.series+"|"+w.start;cur[k]=1;M[k]={series:w.series,start:w.start,up:w.up,down:w.down,cost:w.cost,bidUp:null,bidDown:null}});var done={};(P.recent||[]).forEach(function(w){done[w.series+"|"+w.start]=1});
var pend=P.pending&&P.pending.length!=null?P.pending:null;if(pend)pend.forEach(function(w){var k=(w.series||(P.series||[])[0])+"|"+w.start;if(!cur[k]&&!done[k])M[k]={series:w.series||(P.series||[])[0],start:w.start,up:w.up,down:w.down,cost:w.cost,bidUp:null,bidDown:null}});
Object.keys(M).forEach(function(k){if(done[k]||plSec-M[k].start>2700)delete M[k];else if(!cur[k])M[k].gone=true});T.settling=Object.keys(M).filter(function(k){return M[k].gone}).map(function(k){return M[k]})});try{localStorage.setItem("plmem",JSON.stringify(PLMEM))}catch(e){}
PLR.forEach(function(r){if(r.T.P.on)(r.T.P.now||[]).forEach(function(w){if((w.up>0||w.down>0)&&r.keys.indexOf(w.series)>=0)plNow.push({w:w,nm:r.T.nm})});(r.T.settling||[]).forEach(function(w){if(r.keys.indexOf(w.series)>=0)plNow.push({w:w,nm:r.T.nm,mem:true})})});
var plSettling=function(x){if(x.mem)return true;var rr=RS[plLab(x.w.series)]||{};var cw=rr.window||(rr.lastBook||{}).window;return !!(cw&&x.w.start&&x.w.start!==cw)};var plSum=function(k,f){return PLR.reduce(function(a,r){return a+(r[k][f]||0)},0)};
var hasRules=function(l){return !!l&&l.mode!=="off"&&l.mode!=="dry"&&(((l.variants&&l.variants.length)?l.variants:(l.variant?[l]:[])).length>0)};var hasHistory=function(l){return !!l&&((l.trades||0)>0||(l.days||[]).length>0||(l.open||0)>0)};var OL=(s.series||[]).map(function(r){return r.live}).filter(function(l){return hasRules(l)||hasHistory(l)});
var RS={};RS[L.label||"BTC 5m"]=s;(s.series||[]).forEach(function(r){RS[r.label]=r});var ALL=[L].concat(OL);var sum=function(k){return ALL.reduce(function(a,l){return a+(l[k]||0)},0)};var inTab=function(lb){return TAB==="overview"||WOF(lb||"BTC 5m")===TAB};var ALLV=ALL.filter(function(l){return inTab(l.label||"BTC 5m")});var sumV=function(k){return ALLV.reduce(function(a,l){return a+(l[k]||0)},0)};var NM={};[s].concat(s.series||[]).forEach(function(r){var w=WOF(r.label||"BTC 5m");NM[w]=(NM[w]||0)+1});var tabsChanged=JSON.stringify(NM)!==JSON.stringify(NMARK);NMARK=NM;var TI={};ALL.forEach(function(l){var w=WOF(l.label||"BTC 5m");var o=TI[w]||(TI[w]={rules:0,today:0,tr:0});if(l.mode!=="off")((l.variants&&l.variants.length)?l.variants:(l.variant?[{variant:l.variant}]:[])).forEach(function(v){if(!v.paused&&!v.halted&&!v.manual)o.rules++});o.today+=l.todayNet||0;o.tr+=l.trades||0});WINS.forEach(function(w){var e=el("n"+w);if(!e)return;var o=TI[w];e.innerHTML=o&&(o.rules||o.tr)?'<span title="real rules on">'+o.rules+'</span> <span class="'+cls(o.today)+'" title="real net today">'+signed(o.today)+'</span>':(NM[w]?'<span class="mut" title="markets recorded, paper only">'+NM[w]+' paper</span>':'')});if(tabsChanged)showTab(TAB);var WNAME={"5m":"5-min","15m":"15-min","1h":"1-hour","4h":"4-hour","24h":"24-hour"};var fmtLeft=function(x){var h=Math.floor(x/3600),m=Math.floor(x%3600/60),sc=x%60;return (h?h+":"+String(m).padStart(2,"0"):String(m))+":"+String(sc).padStart(2,"0")};
el("clocks").innerHTML=(TAB==="overview"?WINS:[TAB]).map(function(w){var r=[s].concat(s.series||[]).filter(function(x){return WOF(x.label||"BTC 5m")===w&&x.window})[0];var ws=r?(r.windowSec||300):0;var lf=r?Math.max(0,r.window+ws-Math.floor(Date.now()/1000)):0;var cl="clock"+(TAB==="overview"?" small":"")+(r&&lf<=30?" soon":"");return '<div><div class="k">'+WNAME[w]+' window '+(r?hhmm(r.window)+' kst':'—')+' · closes in</div><div class="'+cl+'">'+(r?fmtLeft(lf):'–:––')+'</div></div>'}).join("");
el("mode").textContent=L.mode==="live"?"live · real money":L.mode==="dry"?"dry run":"paper only";
el("mode").className="pill "+(L.mode==="live"?"live":L.mode==="dry"?"dry":"");
el("listed").textContent=s.listed?"market listed":"not listed yet";
el("sub").textContent="build "+s.build+" · book "+(s.bookFeed&&s.bookFeed.connected?"streaming":"polling")+(s.lastError?" · error: "+s.lastError:"");
el("hstats").innerHTML=(function(){var n=0,open=0,sn=0,sopen=0;ALLV.forEach(function(l){var rr=RS[l.label||"BTC 5m"]||{};var cw=rr.window||(rr.lastBook||{}).window;(l.recent||[]).forEach(function(t){if(t.pnl==null&&t.ok&&!t.dry&&t.shares>0){if(cw&&t.window!==cw){sn++;sopen+=t.cost||0}else{n++;open+=t.cost||0}}})});var live=ALL.filter(function(l){return hasRules(l)}).length;var live=ALLV.filter(function(l){return hasRules(l)}).length+PLON;plNow.forEach(function(x){if(plSettling(x)){sn++;sopen+=x.w.cost||0}else{n++;open+=x.w.cost||0}});var rules=PLON;ALLV.forEach(function(l){if(l.mode==="off"||l.mode==="dry")return;((l.variants&&l.variants.length)?l.variants:(l.variant?[{variant:l.variant}]:[])).forEach(function(v){if(!v.paused&&!v.halted&&!v.manual)rules++})});var tn=0,an=0,tr=0,wn=0;ALLV.forEach(function(l){tn+=l.todayNet||0;an+=l.net||0;tr+=l.trades||0;wn+=l.won||0});tn+=plSum("today","net");an+=plSum("all","net");tr+=plSum("all","trades");wn+=plSum("all","won");var extra=TAB==="overview"?"":'<div><div class="k">real rules on</div><div class="v big">'+rules+'</div></div><div><div class="k">today</div><div class="v big '+cls(tn)+'">'+(tr?signed(tn):"—")+'</div></div><div><div class="k">all time</div><div class="v big '+cls(an)+'">'+(tr?signed(an):"—")+'</div></div><div><div class="k">trades</div><div class="v big">'+tr+'</div></div><div><div class="k">won</div><div class="v big">'+(tr?(wn/tr*100).toFixed(1)+"%":"—")+'</div></div>';return '<div><div class="k">markets</div><div class="v big">'+[s].concat(s.series||[]).filter(function(r){return inTab(r.label||"BTC 5m")}).length+'</div></div><div><div class="k">real on</div><div class="v big">'+live+'</div></div><div><div class="k" title="window still running">live trades</div><div class="v big">'+n+(n?' <span class="mut" style="font-size:14px;font-weight:400">'+money(open)+'</span>':"")+'</div></div><div><div class="k" title="window closed, waiting for the result or the payout">settling</div><div class="v big">'+sn+(sn?' <span class="mut" style="font-size:14px;font-weight:400">'+money(sopen)+'</span>':"")+'</div></div>'+extra})();
var realOn=function(l){if(!l||l.mode==="off")return false;var vs=(l.variants&&l.variants.length)?l.variants:(l.variant?[{variant:l.variant}]:[]);return vs.some(function(v){return !v.paused&&!v.halted})};(function(){var C=L.claims||{};var PER_BATCH=C.perBatch||12,QUOTA=C.quota||65,RESERVE=10;var PAP={"BTC 5m":s.papers||[]};(s.series||[]).forEach(function(r){PAP[r.label]=r.papers||[]});var kst=Date.now()+9*3600000,today=new Date(kst).toISOString().slice(0,10),midnight=Date.now()-kst%86400000;var perDay=function(p){if(!p)return 0;var d=p.days||[];var full=d.filter(function(x){return x.day!==today&&x.trades>0});if(full.length)return full.reduce(function(a,x){return a+x.won},0)/full.length;var t=d.filter(function(x){return x.day===today})[0];if(!t)return 0;var hrs=Math.max(1,(Date.now()-Math.max(midnight,(t.first||0)*1000))/3600000);return t.won*24/hrs};var COL={btc:"#f7931a",eth:"#8c8cff",sol:"#9945ff",xrp:"#9aa4b2",doge:"#c2a633",bnb:"#f0b90b",hype:"#50e3c2"};var parts=[],tot=0;ALL.forEach(function(l){if(!realOn(l))return;var lb=l.label||"BTC 5m";var per=Math.round(86400/((RS[lb]||{}).windowSec||(/15m/.test(lb)?900:300)));var best=0;((l.variants&&l.variants.length)?l.variants:(l.variant?[{variant:l.variant}]:[])).forEach(function(v){if(v.paused||v.halted)return;best=Math.max(best,perDay((PAP[lb]||[]).filter(function(x){return x.name===v.variant})[0]))});var w=Math.min(per,Math.round(best));tot+=w;parts.push({label:lb,w:w,col:COL[lb.split(" ")[0].toLowerCase()]||"#888",light:/15m/.test(lb)})});
var hoursLeft=(86400000-Date.now()%86400000)/3600000;var resetKst=hhmm(Math.floor((Date.now()+hoursLeft*3600000)/1000));var used=C.usedToday||0;var perHour=tot>0?Math.ceil(tot/24/PER_BATCH):0;var ahead=Math.round(perHour*hoursLeft);var spare=Math.max(1,Math.round(RESERVE*hoursLeft/24));parts.forEach(function(q){q.tx=tot>0?ahead*q.w/tot:0});var total=used+ahead+spare;var blocked=!!C.blockedUntil;var over=blocked||total>QUOTA;var scale=Math.max(QUOTA,total);var fullDay=tot>0?Math.ceil(tot/PER_BATCH)+RESERVE:0;var lastsH=tot>0&&perHour>0?(QUOTA-used-spare)/perHour:null;
var tag=blocked?"used up · resets "+resetKst+" KST":over?"over by "+(total-QUOTA)+" · runs out ~"+(lastsH!=null&&lastsH>0?hhmm(Math.floor((Date.now()+lastsH*3600000)/1000))+" KST":"now"):"fits · resets "+resetKst+" KST";
var html='<div class="qhead"><span class="lbl">claim quota</span><b class="'+(over?"bad":"ok")+'">'+(blocked?QUOTA:total)+'</b><span class="mut"> / '+QUOTA+' transactions by reset</span><span class="mut qsub">'+used+' used · +'+ahead+' ahead · '+spare+' spare</span><span class="qtag '+(over?"bad":"ok")+'">'+tag+'</span></div><div class="qbar'+(over?" over":"")+'">'+(blocked?'<span class="seg used" style="width:100%" title="quota used up"></span>':'<span class="seg used" style="width:'+(100*used/scale)+'%" title="'+used+' sent since 09:00 KST"></span>'+parts.map(function(q){return '<span class="seg" style="width:'+(100*q.tx/scale)+'%;background:'+q.col+(q.light?";opacity:.55":"")+'" title="'+esc(q.label)+': ~'+q.w+' won windows a day, ~'+Math.round(q.tx)+' more transactions before the reset"></span>'}).join("")+'<span class="seg spare" style="width:'+(100*spare/scale)+'%" title="'+spare+' spare for wraps, swaps and retries"></span>')+(over?'':'<span class="cap" style="left:'+(100*QUOTA/scale)+'%"></span>')+'</div><div class="qleg"><span><i class="us"></i>used <b>'+used+'</b></span>'+parts.map(function(q){return '<span><i style="background:'+q.col+(q.light?";opacity:.55":"")+'"></i>'+esc(q.label)+' <b>~'+q.w+'</b>/day</span>'}).join("")+'<span><i class="sp"></i>spare <b>'+spare+'</b></span><span class="mut">full day with these rules: <b>'+fullDay+'</b></span></div>';
el("quota").style.display=TAB==="overview"?"":"none";el("quota").innerHTML=!parts.length&&!used?'<div class="qhead"><span class="lbl">claim quota</span><span class="mut">no real rules on</span></div>':html;el("quota").title="Polymarket's gasless relayer allows ~"+QUOTA+" transactions a day per wallet, reset at 09:00 KST. Used = transactions the bot has sent since the reset. Ahead = what the rules now on should need until the reset: every won window of a market is redeemed once, "+PER_BATCH+" windows per transaction, several rules on one window count once; estimated from each market's broadest rule and its paper wins per full day."})();H={};var chartOk=function(lb,l){return TAB!=="overview"&&inTab(lb)};if(chartOk("BTC 5m",L))feedChart("btc5m","BTC 5m",300,s);(s.series||[]).forEach(function(r){if(chartOk(r.label,r.live))feedChart(r.key||r.label,r.label,r.windowSec||(/15m/.test(r.label)?900:300),r)});drawCharts();drawBets();el("charts").classList.toggle("big",TAB!=="overview"&&el("charts").children.length>=4);
el("lrule").textContent=(ALLV.filter(function(l){return l.mode!=="off"}).length+PLON)+" live";
el("ledger").textContent=(L.startBalance!=null&&L.balance!=null)?(function(){var ch=L.chain||{};var wallet=(ch.pUSD!=null?ch.pUSD:L.balance)+(ch["USDC.e"]||0);var open=0,stake=0,exp=0,claim=0;ALL.forEach(function(l){claim+=l.toClaim||0;var rr=RS[l.label||"BTC 5m"]||{};var rb=rr.lastBook||{};(l.recent||[]).forEach(function(t){if(t.pnl==null&&t.ok&&!t.dry&&t.shares>0){open+=(t.cost||0)+feeOf(t);stake+=t.cost||0;var p=null;if(t.window===rr.window){var a=t.side==="UP"?rb.upAsk:rb.downAsk;p=a!=null?a:t.cost/t.shares}else{var pl=rr.pendingLean?rr.pendingLean[t.window]:null;p=pl==null||pl===0?t.cost/t.shares:((pl>0)===(t.side==="UP")?1:0)}exp+=t.shares*p}})});el("claim").textContent=money(claim+exp);el("esttot").textContent=money(wallet+claim+exp);el("esttot").title=money(wallet)+" in the wallet + "+money(claim)+" won and waiting for payout + "+money(exp)+" expected from open trades";el("claim").title=money(claim)+" won and waiting for payout + "+money(exp)+" expected from "+money(stake)+" in open trades";var hidNet=0,hidOpen=0;ALL.forEach(function(l){if(l.hidden){hidNet+=l.hidden.net||0;hidOpen+=l.hidden.open||0}});open+=hidOpen;exp+=hidOpen;
var dep=L.deposits||0;var expWallet=L.startBalance+dep+sum("net")+hidNet-open-claim;var gap=wallet-expWallet;
return (ch.USDC>0.5?money(ch.USDC)+" native USDC not yet converted":"")})():"";el("claim").textContent=el("claim").textContent==="—"?"—":el("claim").textContent;
el("netk").textContent=L.statsSince?"since start":"all time";var hidT=0,hidN=0;ALL.forEach(function(l){if(l.hidden){hidT+=l.hidden.trades||0;hidN+=l.hidden.net||0}});el("lsince").textContent="";
var OVR=TAB==="overview";var ruleRows=function(l,vs){var lb=l.label||"BTC 5m";var sk=l.series||"";return vs.map(function(v){var pct=function(x){return x.trades?(x.won/x.trades*100).toFixed(1)+"%":"—"};var d=v.today||{trades:0,won:0,net:0};var q=function(x){return "\\'"+String(x).replace(/'/g,"\\\\'")+"\\'"};var name='<td><div class="rcell">'+(OVR?'<a class="mk" href="#" title="open the '+WOF(lb)+' tab" onclick="showTab(\\''+WOF(lb)+'\\');poll();return false">'+ctk(lb)+'</a>':'')+rname(v.variant,v.bidUnderC!=null)+(l.mode==="dry"?'<i class="st warn" title="DRY RUN: orders are signed but not sent, no real money; not in the real tally">DRY</i>':'')+(v.halted?'<i class="st bad" title="halted after '+v.haltAfterLosses+' straight losses'+(v.haltedAt?' at '+hhmm(v.haltedAt/1000)+' KST':'')+'; press &#9654; to resume">'+(OVR?'&#10006; halted'+(v.haltedAt?' '+hhmm(v.haltedAt/1000):''):'&#10006;')+'</i>':'')+(v.paused?'<i class="st mut" title="paused; press &#9654; to resume">'+(OVR?'&#8214; paused':'&#8214;')+'</i>':'')+(v.stopped?'<i class="st warn" title="reached its −$'+(v.stopAt||v.maxLossPerDay)+' daily stop today; trades again at 00:00 KST or when you raise the stop">'+(OVR?'&#9632; daily stop':'&#9632;')+'</i>':'')+'</div></td>';var size='<td class="r">'+(v.manual?'<span class="mut" title="bets you place with the UP/DOWN buttons under the charts">by hand</span>':'<span title="'+esc(v.ladderNote?'size ladder '+(v.ladder||[]).map(function(x){return "$"+x}).join(" → ")+' · '+v.ladderNote:'bet size')+'">$'+v.size+'<span class="lad">'+(v.ladderNote?'&#8599;':'')+'</span></span>')+'</td>';var tdy='<td class="r tdy '+(d.trades?cls(d.net):"mut")+'">'+(d.trades?signed(d.net):"—")+'</td><td class="r tdy">'+(d.trades||"—")+'<span class="nf"'+(d.misses?' title="'+d.misses+' order'+(d.misses===1?'':'s')+' today did not fill (nothing resting at the cap, or the ask fell)">&#9675;'+d.misses:'>')+'</span></td><td class="r tdy">'+pct(d)+'</td>';var all='<td class="r alt '+cls(v.net)+'">'+signed(v.net)+'</td><td class="r alt">'+v.trades+'</td><td class="r alt">'+pct(v)+'</td>';var off=v.paused||v.halted;var act='<td class="r acts">'+(v.manual?'':'<button class="btn icon" title="settings: bet size, halt, daily stop" onclick="ruleMenu(this,'+q(sk)+','+q(v.variant)+','+esc(q(JSON.stringify({size:v.size,ladder:v.ladder||null,halt:v.haltAfterLosses||0,stop:v.maxLossPerDay||0,note:v.ladderNote||""})))+')">&#9881;</button> <button class="btn'+(off?' restore':'')+' icon" title="'+(off?'resume':'pause')+'" onclick="pauseRule('+q(sk)+','+q(v.variant)+','+(off?'false':'true')+')">'+(off?'&#9654;':'&#10074;&#10074;')+'</button> <button class="btn icon paper" title="back to paper only" onclick="toPaper('+q(sk)+','+q(v.variant)+',this)">&#8617;</button>')+'</td>';var why=v.stopped?'<b>stopped for today</b>: daily loss limit of $'+(v.stopAt||v.maxLossPerDay)+' hit, resumes at 00:00 KST':v.halted?'<b>halted</b> after '+v.haltAfterLosses+' straight losses'+(v.haltedAt?' at '+hhmm(v.haltedAt/1000)+' KST':'')+', waits for a restart':v.paused?'<b>paused</b>, not trading until resumed':'';return '<tr class="'+(off?"dim":"")+'" data-k="'+esc(lb+"|"+v.variant)+'">'+name+size+tdy+all+act+'</tr>'+(why?'<tr class="p2" data-k="'+esc(lb+"|"+v.variant+"|why")+'"><td colspan="9">'+why+'</td></tr>':'')})};
var LR=ALLV.filter(function(l){return hasRules(l)});var variantsOf=function(l){var vs=(l.variants&&l.variants.length)?l.variants:[{variant:l.variant,size:l.size,trades:l.trades,won:l.won,net:l.net,halted:false,streak:0,haltAfterLosses:0}];var st=function(v){return v.halted?2:v.paused?1:0};return vs.slice().sort(function(a,b){return st(a)-st(b)})};
swap("lrules",((OVR?(function(){var flat=[];LR.forEach(function(l){variantsOf(l).forEach(function(v){if(!v.manual)flat.push({l:l,v:v})})});var rank=function(x){return x.v.halted?0:x.v.stopped?1:x.v.paused?2:3};flat.sort(function(a,b){var ra=rank(a),rb=rank(b);if(ra!==rb)return ra-rb;var ta=(a.v.today||{}).net||0,tb=(b.v.today||{}).net||0;if(ta!==tb)return ta-tb;return (a.v.net||0)-(b.v.net||0)});return flat.map(function(x){return ruleRows(x.l,[x.v]).join("")}).join("")})():LR.map(function(l){var vs=variantsOf(l);var lb=l.label||"BTC 5m";var sk=l.series||"";var nr=vs.filter(function(v){return !v.manual}).length;var head='<tr class="grp" data-k="'+esc("g|"+lb)+'"><td colspan="9"><span>'+coin(lb)+'<b>'+lb+'</b></span><span class="gs">today <b class="'+cls(l.todayNet)+'">'+signed(l.todayNet)+'</b> · <button class="sz" title="default daily loss stop for each rule on this market ($5 to $500); every rule stops on its own" onclick="editMaxLoss(\\''+sk+'\\','+l.maxLossPerDay+')">each rule −$'+l.maxLossPerDay+'/day<span class="pen">&#9998;</span></button> · '+nr+' rule'+(nr===1?'':'s')+'</span></td></tr>';return head+ruleRows(l,vs).join("")}).join(""))+PLR.filter(function(r){return r.on}).map(function(r){var PL=r.T.P;var pc=function(x){return x.trades&&x.won!=null?(x.won/x.trades*100).toFixed(1)+"%":"—"};var d=r.today,a=r.all;return (OVR?'':'<tr class="grp" data-k="'+esc("g|"+r.T.nm+"|"+r.lb)+'"><td colspan="9"><span>'+coin(r.lb)+'<b>'+esc(r.lb)+'</b></span><span class="gs">'+r.T.nm+' · own budget '+money((PL.budget||{}).budget||0)+' · '+money((PL.budget||{}).left||0)+' left</span></td></tr>')+'<tr class="'+(r.on?"":"dim")+'" data-k="'+esc(r.T.nm+"|"+r.lb)+'"><td><div class="rcell" title="'+esc(PL.rule||"")+'">'+(OVR?ctk(r.lb):'')+'<span class="rnm"><b>'+r.T.nm.replace(/ /g,"&nbsp;")+'</b></span><i class="st mut" style="font-style:normal" title="post-only bids on both Up and Down">MAKER</i>'+(PL.blocked?'<i class="st warn" title="'+esc(PL.blocked)+'">&#8214; paused</i>':'')+(r.on?'':'<i class="st mut">off</i>')+'</div></td><td class="r"><span title="shares per clip, each side">'+(PL.clip||0)+' sh</span></td><td class="r tdy '+(d.trades?cls(d.net):"mut")+'">'+(d.trades?signed(d.net):"—")+'</td><td class="r tdy" title="windows settled today">'+(d.trades||"—")+'<span class="nf"></span></td><td class="r tdy">'+pc(d)+'</td><td class="r alt '+cls(a.net)+'">'+signed(a.net)+'</td><td class="r alt" title="windows settled">'+a.trades+'</td><td class="r alt">'+pc(a)+'</td><td class="r acts"></td></tr>'+(function(){var B=PL.budget||{};var lw=PL.loneWindows!=null?PL.loneWindows:PL.leftoverWindows;var fp=lw!=null?(PL.windows||0)-lw:null;var bits=[r.on?'budget left <b>'+money(B.left||0)+'</b> of '+money(B.budget||0):'<b>switched off</b> · lost '+money(B.lost||0)+' of its '+money(B.budget||0)+' budget'];if(fp!=null)bits.push('<b>'+fp+'</b> full pairs'+(PL.loneNet!=null?' <span class="'+cls((PL.net||0)-PL.loneNet)+'">'+signed((PL.net||0)-PL.loneNet)+'</span>':'')+' · <b>'+lw+'</b> lone clips'+(PL.loneNet!=null?' <span class="'+cls(PL.loneNet)+'">'+signed(PL.loneNet)+'</span>':''));var ns=(r.T.settling||[]).length||PL.unsettled||0;if(r.on&&ns)bits.push(ns+" settling");if(r.on&&PL.blocked)bits.push('<span class="bad">paused: '+esc(String(PL.blocked).slice(0,50))+'</span>');return '<tr class="p2 '+(r.on?"":"dim")+'" data-k="'+esc(r.T.nm+"|p2|"+r.lb)+'"><td colspan="9">'+bits.join(" · ")+'</td></tr>'})()}).join("")+(function(){var off=PLR.filter(function(r){return !r.on});return off.length?'<tr class="p2" data-k="ended"><td colspan="9" style="padding-top:8px">ended tests, off now, still counted in today and all time: '+off.map(function(r){return '<b>'+r.T.nm+'</b> ('+esc(r.lb)+') <span class="'+cls(r.all.net)+'">'+signed(r.all.net)+'</span> over '+r.all.trades+' windows'+(r.today.trades?', today <span class="'+cls(r.today.net)+'">'+signed(r.today.net)+'</span>':'')}).join(" · ")+'</td></tr>':""})())||'<tr><td class="empty" colspan="9">real orders are off</td></tr>');
el("bal").textContent=money(L.balance);drawWallet(L.history);
try{var pmT=sum("todayNet"),pmA=sum("net"),pmN=sum("trades");PTS.forEach(function(T){pmT+=T.P.todayNet||0;pmA+=T.P.net||0;pmN+=T.P.windows||0});var EPX=s.eventPaper||{};Object.keys(EPX).forEach(function(k){var R=EPX[k]&&EPX[k].real;if(R){pmT+=R.todayNet||0;pmA+=R.net||0;pmN+=R.trades||0}});var WH=s.walletHistory||null;var pt=function(k,v,c,t){return '<div'+(t?' title="'+esc(t)+'"':'')+'><div class="k">'+k+'</div><div class="v big '+(c||"")+'">'+v+'</div></div>'};
el("sol-pm").innerHTML=pt("today",signed(pmT),cls(pmT),"real net of everything settled today (KST): crypto rules, pair tests, tennis")+pt("all time",signed(pmA),cls(pmA),"every real trade the bot has recorded")+pt("trades",pmN,"")+pt("wallet now",L.balance!=null?money(L.balance):"—","")+(WH&&WH.allTimeNet!=null?pt("whole wallet history",signed(WH.allTimeNet),cls(WH.allTimeNet),"everything this Polymarket wallet ever did, including before the bot ran on the server"):"");
el("sol-pmnote").textContent="All time counts every real trade the bot recorded (crypto rules, pair tests, tennis)."+(WH&&WH.allTimeNet!=null?" Whole wallet history is everything this Polymarket wallet ever did, including trades from before the bot ran on the server.":"")+" These markets keep running; nothing is hidden.";
el("grp-n").innerHTML='today <span class="'+cls(pmT)+'">'+signed(pmT)+'</span>';
var SO=s.solana||null;if(SO&&SO.rules){var SR=SO.rules||[];var real=SO.mode&&SO.mode!=="paper";var tried=SO.rulesTried!=null?SO.rulesTried:SR.length,ahead=SO.aheadOfHold!=null?SO.aheadOfHold:SR.filter(function(r){return r.vsHold>0}).length,qn=(SO.qualified||[]).length;
["sol-tag","sol-rtag","sol-ltag"].forEach(function(i){el(i).classList.toggle("hide",real)});el("sol-daysp").classList.remove("hide");el("sol-feedp").classList.remove("hide");
el("sol-state").textContent=real?"trading":"paper test · no real money";
var tot=SR.reduce(function(a,r){return a+(r.vsHold||0)},0),tdy=SR.reduce(function(a,r){return a+(r.todayVsHold||0)},0);var maxD=SR.reduce(function(a,r){return Math.max(a,r.closedDays||0)},0),maxDays=SR.reduce(function(a,r){return Math.max(a,r.days||0)},0);
var LPN='<b style="color:var(--fg)">'+ahead+' of '+tried+' paper rules are ahead of just holding.</b> '+(qn?qn+' passed the bar for real money.':'Nothing is proven and nothing qualifies for real money yet')+(qn?'':': the test has run '+(maxDays<1?Math.round(maxDays*24)+' hours':maxDays.toFixed(1)+' days')+' and the bar is 30 full days.')+' Each rule lends $200 of pretend SOL and USDC to an Orca pool and earns trading fees. The score is what it has now, plus fees, minus costs, compared with simply holding the same coins.';el("sol-note").innerHTML=LPN;el("sol-lpnote").innerHTML=LPN;window.SOLLP=ahead+" of "+tried;
var st1=function(k,v,c,t){return '<div'+(t?' title="'+esc(t)+'"':'')+'><div class="k">'+k+'</div><div class="v big '+(c||"")+'">'+v+'</div></div>'};var st2=function(k,v,c,t){return '<div'+(t?' title="'+esc(t)+'"':'')+'><div class="k">'+k+'</div><div class="v" style="font-size:18px;font-weight:600" class="'+(c||"")+'"><span class="'+(c||"")+'">'+v+'</span></div></div>'};
el("sol-stats").innerHTML=st1("real on","0","","no real money on Solana")+st1("real today","$0.00","")+st1("real all time","$0.00","")+st2("paper rules tried",tried,"")+st2("ahead of holding",ahead+" of "+tried,"")+st2("passed the bar",qn,"","30+ full days, at least half of them ahead of holding, ahead overall, and 100+ range cycles for rules that re-centre")+st2("all rules vs holding",signed(tot),cls(tot),"sum over every paper rule, $200 each")+st2("today",signed(tdy),cls(tdy),"change today (KST) against holding, all rules");
el("sol-rsub").textContent="$200 each · best first · score = against just holding";
var pshort=function(r){var m=/([0-9.]+%)/.exec(r.poolLabel||"");return m?m[1]+" pool":(r.poolLabel||r.pool||"")};
el("sol-rules").innerHTML=SR.length?'<table><thead><tr><th>rule</th><th class="r" title="position + fees - costs, compared with holding the starting coins">vs holding</th><th class="r nm">today</th><th class="r nm">fees</th><th class="r nm">costs</th><th class="r nm" title="full days ahead of holding / full days">days won</th><th>now</th></tr></thead><tbody>'+SR.map(function(r){var o=r.open||{};var q=(SO.qualified||[]).indexOf(r.id+"@"+r.pool)>=0;return '<tr class="m"><td><b>'+esc(r.id)+'</b> <span class="mut nw">'+esc(pshort(r))+'</span>'+(q?' <span class="tag real">passed the bar</span>':'')+'</td><td class="r nw '+cls(r.vsHold)+'"><b>'+signed(r.vsHold||0)+'</b></td><td class="r nw nm '+cls(r.todayVsHold)+'">'+signed(r.todayVsHold||0)+'</td><td class="r nw nm">'+money(r.fees||0)+'</td><td class="r nw nm">'+money(r.costs||0)+'</td><td class="r nw nm">'+(r.closedDays?r.daysWon+"/"+r.closedDays:"—")+'</td><td class="nw '+(o.inRange?"ok":"bad")+'" title="range $'+o.lo+' to $'+o.hi+', SOL at $'+o.price+'">'+(o.lo==null?"—":o.inRange?"in range":"out")+'</td></tr><tr class="d"><td colspan="7">'+esc(r.text||"")+(r.inRangePct==null?"":" In range "+Math.round(r.inRangePct)+"% of the time.")+'</td></tr>'}).join("")+'</tbody></table><div class="note">Bar for real money: 30+ full days, at least half of them ahead of holding, ahead overall, and 100+ range cycles for rules that re-centre. Longest record so far: '+maxD+' full day'+(maxD===1?'':'s')+'.</div>':'<div class="empty">no rule reported</div>';
var EV=[];SR.forEach(function(r){(r.recent||[]).forEach(function(c){EV.push({r:r,c:c})})});EV.sort(function(a,b){return b.c.t1-a.c.t1});el("sol-lsub").textContent=EV.length?Math.min(EV.length,40)+" latest closed ranges, all rules":"";
el("sol-log").innerHTML=EV.length?'<table class="log"><thead><tr><th>kst</th><th>rule</th><th class="r nm">held</th><th class="r nm">fees</th><th class="r nm">cost</th><th class="r" title="fees minus price loss minus cost, against holding what the range started with">result</th></tr></thead><tbody>'+EV.slice(0,40).map(function(x){var c=x.c;var h=(c.t1-c.t0)/3600000;return '<tr><td class="nw">'+hhmm(c.t1/1000)+'</td><td><b>'+esc(x.r.id)+'</b> <span class="mut nw">'+esc(pshort(x.r))+'</span></td><td class="r nw nm">'+(h<1?Math.round(h*60)+" min":h.toFixed(1)+" h")+'</td><td class="r nw nm ok">'+signed(c.fees||0)+'</td><td class="r nw nm">'+money(c.cost||0)+'</td><td class="r nw '+cls(c.net)+'"><b>'+signed(c.net||0)+'</b></td></tr>'}).join("")+'</tbody></table>':'<div class="empty">No range has closed yet. A row appears here each time a rule moves its range; open ranges are in the strategies table under "now".</div>';
var DM={};SR.forEach(function(r){(r.dayRows||[]).forEach(function(d){var o=DM[d.day]||(DM[d.day]={n:0,a:0,v:0,f:0});o.n++;if(d.vsHold>0)o.a++;o.v+=d.vsHold||0;o.f+=d.fees||0})});var DK=Object.keys(DM).sort().reverse();
el("sol-days").innerHTML=DK.length?'<table><thead><tr><th>day</th><th class="r">rules ahead</th><th class="r">vs holding</th><th class="r nm">fees earned</th></tr></thead><tbody>'+DK.map(function(k){var o=DM[k];return '<tr><td>'+k+'</td><td class="r">'+o.a+' of '+o.n+'</td><td class="r '+cls(o.v)+'"><b>'+signed(o.v)+'</b></td><td class="r nm">'+money(o.f)+'</td></tr>'}).join("")+'</tbody></table>':'<div class="empty">The first full day closes at 00:00 KST.</div>';
var H=SO.health||{};var pill=function(c,h,t){return '<span class="wp '+c+'"'+(t?' title="'+esc(t)+'"':'')+'><span class="d"></span>'+h+'</span>'};var age=H.lastOk?Math.round((Date.now()-H.lastOk)/1000):null;
el("sol-feeds").innerHTML=pill(age!=null&&age<180?"ok":"bad","pool reader <b>"+(age==null?"never read":age<90?age+" s ago":Math.round(age/60)+" min ago")+"</b>",H.lastError||"")+pill("","reads <b>"+(H.reads||0)+"</b>")+pill(H.errors?"bad":"","errors <b>"+(H.errors||0)+"</b>",H.lastError||"")+(SO.pools||[]).map(function(p){return pill(p.price!=null?"ok":"bad",esc(p.label||p.key)+" <b>"+(p.price!=null?"$"+p.price:"no price")+"</b>")}).join("");
el("sol-fsub").textContent="reads the pools only · no wallet, no orders"}
var SC=s.solanaCopy||null;el("sol-copy").classList.toggle("hide",!(SC&&SC.rules));el("sol-lph").classList.toggle("hide",!(SC&&SC.rules&&SO&&SO.rules));
if(SC&&SC.rules){var SP=SC.speed||{},CR=(SC.rules||[]).slice(),CW=SC.wallets||[],CQ=SC.qualified||[],nb=SP.buysSeen||0;var nv=function(v,u,d){return v==null||isNaN(v)?"—":(d!=null?Number(v).toFixed(d):v)+(u||"")};var pc=function(v){return v==null||isNaN(v)?"—":(v>0?"+":"")+Number(v).toFixed(1)+"%"};var pcc=function(v){return v==null||isNaN(v)?"mut":cls(v)};
var cs1=function(k,v,c,t){return '<div'+(t?' title="'+esc(t)+'"':'')+'><div class="k">'+k+'</div><div class="v big '+(c||"")+'">'+v+'</div></div>'};var cs2=function(k,v,c,t){return '<div'+(t?' title="'+esc(t)+'"':'')+'><div class="k">'+k+'</div><div class="v" style="font-size:18px;font-weight:600"><span class="'+(c||"")+'">'+v+'</span></div></div>'};
var inP=SC.inProfit||0,rt=SC.rulesTried!=null?SC.rulesTried:CR.length;CR.sort(function(a,b){return (b.netSol||0)-(a.netSol||0)});var best=CR[0]||null;
el("sol-tag").classList.remove("hide");el("sol-state").textContent="paper speed test · no real money";
el("sol-note").innerHTML=(nb?'<b style="color:var(--fg)">'+inP+' of '+rt+' paper rules are in profit over '+nb+' wallet buy'+(nb===1?'':'s')+' seen.</b> ':'<b style="color:var(--fg)">No wallet buy seen yet.</b> ')+(CQ.length?CQ.length+' passed the bar for real money.':'Nothing is proven and nothing qualifies for real money yet.')+' The idea: when a famous wallet buys a token, buy right behind it and sell to the followers within seconds, for a tiny profit. Nothing is sent. Paper profit is the best case, because it uses price quotes and not real fills.';
el("sol-stats").innerHTML=cs1("real on","0","","no real money on Solana")+cs1("real today","$0.00","")+cs1("real all time","$0.00","")+cs2("wallet buys seen",nb,"")+cs2("paper rules in profit",inP+" of "+rt,"")+cs2("passed the bar",CQ.length,"","100+ copies on one rule, half or more won, net positive")+(window.SOLLP&&SO&&SO.rules?cs2("pool rules ahead of holding",window.SOLLP,"","the second test, further down"):"");
el("sol-csub").textContent=nb?"middle value over "+nb+" wallet buys":"waiting for the first wallet buy";
el("sol-cspeed").innerHTML=cs2("we find out after",nv(SP.lagSecMedian," s"),"","time from the wallet's buy to us knowing the token; 9 in 10 within "+nv(SP.lagSecP90," s")+"; "+nv(SP.lagSlotsMedian)+" blocks later")+cs2("slowest 1 in 10",nv(SP.lagSecP90," s"),"")+cs2("buyers ahead of us",nv(SP.aheadMedian),"","other transactions on the token that land before our fastest paper buy would")+cs2("first in line",nv(SP.firstInLinePct,"%"),"","share of wallet buys where nobody lands ahead of us")+cs2("in the wallet's own block",nv(SP.sameSlotMedian),"","transactions on the token in the same block as the wallet's buy: bots that were faster than any follower can be")+cs2("we pay more than the wallet",pc(SP.entryGapPctMedian),"","our fastest paper entry price against the wallet's price")+cs2("move needed to break even",pc(SP.breakEvenPctMedian),"","fees and price impact both ways plus two transaction fees, for an instant in and out")+cs2("no followers came",nv(SP.noWavePct,"%"),"","share of wallet buys with no follower transaction in about 4 s");
el("sol-cnote").textContent=nb?"Read it like this: to make money, the price must rise by more than the break-even move after we buy, and we must be near the front of the line. If many buyers are ahead of us, we are the ones being sold to.":"Listening for buys from the tracked wallets. Numbers appear after the first one.";
el("sol-cw").innerHTML=CW.length?'<table><thead><tr><th>wallet</th><th class="r">buys</th><th class="r" title="follower transactions in about 4 s after the wallet buys (middle value)">followers<span class="nm"> 4 s</span></th><th class="r nm" title="follower transactions in about 60 s">60 s</th><th class="r nm" title="transactions landing before our fastest paper buy">ahead of us</th><th class="r nm" title="how much more than the wallet we pay">we pay</th><th class="r" title="middle result of the fastest paper copy sold 5 s later">5 s</th><th class="r" title="sold 30 s later">30 s</th><th class="r nm" title="sold 2 min later">2 min</th></tr></thead><tbody>'+CW.map(function(w){return '<tr><td><b>'+esc(w.name||"?")+'</b></td><td class="r nw">'+(w.buys||0)+'</td><td class="r nw"><b>'+nv(w.follow4s)+'</b></td><td class="r nw nm">'+nv(w.follow60s)+'</td><td class="r nw nm">'+nv(w.aheadOfUs)+'</td><td class="r nw nm">'+pc(w.entryGapPct)+'</td><td class="r nw '+pcc(w.ret5)+'">'+pc(w.ret5)+'</td><td class="r nw '+pcc(w.ret30)+'">'+pc(w.ret30)+'</td><td class="r nw nm '+pcc(w.ret120)+'">'+pc(w.ret120)+'</td></tr>'}).join("")+'</tbody></table><div class="note">5 s / 30 s / 2 min: middle paper result if we bought at once and sold that much later, after costs. Few buys per wallet means these are not reliable yet.</div>':'<div class="empty">No tracked wallet has bought yet.</div>';
var rnm=function(x){var m=/^copy-d([0-9]+)-(x|tp)([0-9]+)/.exec(x.id||"");if(!m)return esc(x.id||"");var w=m[1]==="0"?"buy at once":"buy "+m[1]+" s later";var n=+m[3];return w+", "+(m[2]==="x"?"sell after "+(n>=60?n/60+" min":n+" s"):"sell at +"+n+"% or after 60 s")};
el("sol-crsub").textContent=rt+" tried · best first · 0.25 SOL each";
el("sol-cr").innerHTML=CR.length?'<table><thead><tr><th>rule</th><th class="r">copies</th><th class="r">won</th><th class="r" title="paper result in dollars, all copies">result</th><th class="r nm" title="middle result per copy">per copy</th></tr></thead><tbody>'+CR.map(function(x){var q=CQ.indexOf(x.id)>=0;var u=x.netUsd!=null?x.netUsd:null;return '<tr title="'+esc((x.id||"")+": "+(x.text||""))+'"><td>'+rnm(x)+(q?' <span class="tag real">passed the bar</span>':'')+'</td><td class="r nw">'+(x.n||0)+'</td><td class="r nw">'+(x.n?x.won+" · "+Math.round(100*x.won/x.n)+"%":"—")+'</td><td class="r nw '+(x.n?cls(x.netSol):"mut")+'"><b>'+(!x.n?"—":u!=null?signed(u):((x.netSol>0?"+":"")+x.netSol+" SOL"))+'</b></td><td class="r nw nm '+(x.n?pcc(x.medianRetPct):"mut")+'">'+(x.n?pc(x.medianRetPct):"—")+'</td></tr>'}).join("")+'</tbody></table><div class="note">Bar for real money: 100+ copies on one rule, half or more won, and ahead overall. '+(CQ.length?CQ.length+' rule'+(CQ.length===1?' passes':'s pass')+'.':'No rule passes yet'+(best&&best.n?': the most any rule has is '+CR.reduce(function(a,x){return Math.max(a,x.n||0)},0)+' copies.':'.'))+' With 30 rules tried, a few will look good by luck.</div>':'<div class="empty">no rule reported</div>';
var RC=SC.recent||[];el("sol-clog").innerHTML=RC.length?'<table class="log"><thead><tr><th>kst</th><th>wallet</th><th class="nm">token</th><th class="r nm" title="size of the wallet buy">size</th><th class="r" title="time from the wallet buy to us knowing">found out</th><th class="r nm" title="transactions landing before our paper buy">ahead</th><th class="r nm" title="follower transactions in about 4 s">followers</th><th class="r nm" title="move needed to break even">needs</th><th class="r" title="paper result: buy 1 s after knowing, sell 10 s later">10 s</th><th class="r" title="sell 30 s later">30 s</th></tr></thead><tbody>'+RC.map(function(x){return '<tr><td class="nw">'+hhmm(x.t/1000)+'</td><td><b>'+esc(x.name||"?")+'</b></td><td class="nw nm mut">'+esc(String(x.mint||"").slice(0,4))+'…</td><td class="r nw nm">'+nv(x.leaderSol," SOL")+'</td><td class="r nw">'+nv(x.lagSec," s")+'</td><td class="r nw nm">'+nv(x.ahead)+'</td><td class="r nw nm">'+nv(x.follow4s)+'</td><td class="r nw nm">'+pc(x.breakEvenPct)+'</td><td class="r nw '+pcc(x.ret10Pct)+'"><b>'+pc(x.ret10Pct)+'</b></td><td class="r nw '+pcc(x.ret30Pct)+'"><b>'+pc(x.ret30Pct)+'</b></td></tr>'}).join("")+'</tbody></table>':'<div class="empty">No wallet buy seen yet. A row appears each time a tracked wallet buys a token.</div>';
var CH=SC.health||{};var cpill=function(c,h,t){return '<span class="wp '+c+'"'+(t?' title="'+esc(t)+'"':'')+'><span class="d"></span>'+h+'</span>'};
el("sol-cfeeds").innerHTML=cpill(CH.wsUp?"ok":"bad","wallet feed <b>"+(CH.wsUp?"connected":"down")+"</b>",CH.lastError||"")+cpill("","source <b>"+esc(CH.feed||"?")+"</b>")+cpill("","wallets watched <b>"+(CH.subs||0)+"</b>")+((CH.badWallets||[]).length?cpill("bad","bad wallet entries <b>"+CH.badWallets.length+"</b>",CH.badWallets.join(", ")):"")+cpill(CH.quotes&&CH.quotes!=="none"?"ok":"bad","price quotes <b>"+esc(CH.quotes||"none")+"</b>")+cpill("","transactions read <b>"+(CH.txSeen||0)+"</b>")+cpill("","buys <b>"+(CH.buys||0)+"</b>")+cpill(CH.skippedBusy?"bad":"","skipped, too busy <b>"+(CH.skippedBusy||0)+"</b>")+cpill(CH.rpcErrors||CH.quoteErrors?"bad":"","errors <b>"+((CH.rpcErrors||0)+(CH.quoteErrors||0))+"</b>",CH.lastError||"")+(SC.solUsd?cpill("","SOL <b>$"+SC.solUsd+"</b>"):"")}
var SL=s.solanaCopyLive||null;el("sol-real").classList.toggle("hide",!SL);
if(SL){var lu=(s.solanaCopy&&s.solanaCopy.solUsd)||null;var sg=function(v){v=+v||0;if(Math.abs(v)<0.00005)v=0;return (v>0?"+":v<0?"-":"")+Math.abs(v).toFixed(4)+" SOL"};var so=function(v,d){return v==null||isNaN(v)?"—":Number(v).toFixed(d==null?2:d)+" SOL"};var lv=function(v,u){return v==null||isNaN(v)?"—":v+(u||"")};
var cap=+SL.capSol||0,net=+SL.netSol||0,left=Math.max(0,cap+net),nc=SL.copies||0,nl=SL.landed||0,stake=+SL.stakeSol||0;var capHit=/^loss cap/.test(SL.halted||"");
var lstate=SL.halted?(capHit?"stopped at the cap":"halted"):SL["switch"]!=="on"?"switched off":!SL.walletReady?"wallet not ready":SL.balanceSol!=null&&SL.balanceSol<stake&&!SL.openPosition?(nc?"wallet too low for the next copy":"waiting for funds"):SL.balanceSol==null&&!nc?"waiting for funds":SL.openPosition?"running · one copy open now":"running";
var xm=/at [+]([0-9.]+)% or after ([0-9]+) s/.exec(SL.exitRule||""),xt=/after ([0-9]+) s/.exec(SL.exitRule||"");var holdS=xm?+xm[2]:xt?+xt[1]:6;var xrule=xm?"sells as soon as it is up "+xm[1]+"%, or after "+xm[2]+" seconds whatever the price":xt?"sells "+xt[1]+" seconds later":SL.exitRule?String(SL.exitRule):"sells about 5 seconds later";var ppc=function(v){return (v>0?"+":"")+Number(v).toFixed(1)+"%"};
var lwhy=SL.halted?(capHit?"It lost the "+cap+" SOL it was allowed to lose and stopped itself. It stays off until you say otherwise.":"It stopped itself: "+SL.halted+"."):SL["switch"]!=="on"?"The switch is off, so nothing is sent.":!SL.walletReady?"Nothing can be sent"+(SL.note?": "+SL.note:"")+".":/^waiting/.test(lstate)?"The wallet is empty, so nothing is sent until it is funded.":/^wallet too low/.test(lstate)?"The wallet holds less than one copy ("+stake+" SOL), so nothing is sent.":"It copies each buy of a followed wallet with "+stake+" SOL and "+xrule+"."+(SL.note?" Note: "+SL.note+".":"");
var lc=SL.on&&/^running/.test(lstate)?"ok":SL.halted||!SL.walletReady?"bad":"mut";
el("sol-lstate").innerHTML='<span class="'+lc+'">'+esc(lstate)+'</span>';
var usd=lu?" (about "+signed(net*lu)+" at SOL $"+lu+")":"";
var lt=function(k,v,c,t){return '<div'+(t?' title="'+esc(t)+'"':'')+'><div class="k">'+k+'</div><div class="v" style="font-size:18px;font-weight:600"><span class="'+(c||"")+'">'+v+'</span></div></div>'};
el("sol-lst").innerHTML=lt("result",sg(net),cls(net),"wallet balance after minus before, every fee included"+usd)+lt("left before it stops",so(left,4),left<=0?"bad":"","it may lose "+cap+" SOL in all")+lt("copies sent",nc,"")+lt("landed",nc?nl+" of "+nc:"—","","our buy made it onto the chain")+lt("same block",nl?(SL.sameBlock||0)+" of "+nl:"—","","our buy landed in the same block as the wallet we copy")+lt("won",nc?(SL.won||0)+" of "+nc:"—","")+lt("open now",SL.openPosition?"1":"0","");
el("sol-lnote").innerHTML='<b style="color:var(--fg)">'+(nc?(net>0?"Making":net<0?"Losing":"Flat on")+" money so far: "+sg(net)+" over "+nc+" cop"+(nc===1?"y":"ies")+usd+".":"No copy sent yet.")+'</b> '+esc(lwhy)+' Amounts are in SOL and are not part of the dollar totals of the prediction markets.';
el("sol-ltbl").innerHTML='<table><thead><tr><th>strategy</th><th class="r nm">size</th><th class="r">copies</th><th class="r nm">landed</th><th class="r">won</th><th class="r">result</th></tr></thead><tbody><tr class="m"><td><b>fast copy test</b></td><td class="r nw nm">'+stake+' SOL</td><td class="r nw">'+nc+'</td><td class="r nw nm">'+nl+'</td><td class="r nw">'+(SL.won||0)+'</td><td class="r nw '+cls(net)+'"><b>'+sg(net)+'</b></td></tr><tr class="d"><td colspan="6">Buys what a followed wallet just bought and '+esc(xrule)+'. May lose '+cap+' SOL in all. Now: '+esc(lstate)+'.</td></tr></tbody></table>';
var lp=function(h,t){return '<span class="wp"'+(t?' title="'+esc(t)+'"':'')+'><span class="d"></span>'+h+'</span>'};
el("sol-lpills").innerHTML=nc?lp("our speed <b>"+lv(SL.pipelineMsMedian," ms")+"</b>","from seeing the buy to sending ours: price quote "+lv(SL.quoteMsMedian," ms")+", building "+lv(SL.buildMsMedian," ms")+", sending "+lv(SL.sendMsMedian," ms"))+lp("blocks behind the wallet <b>"+lv(SL.slotsBehindMedian)+"</b>","middle value over landed copies; 0 is the same block")+lp("one block later <b>"+(SL.nextBlock||0)+"</b>")+lp("buyers ahead of us <b>"+lv(SL.aheadMedian)+"</b>","followers that landed in an earlier block than ours, middle value")+lp("paid over the wallet price <b>"+lv(SL.fillGapPctMedian==null?null:Number(SL.fillGapPctMedian).toFixed(1),"%")+"</b>")+lp("did not land <b>"+(SL.notLanded||0)+"</b>","sent but never made it onto the chain, or failed there")+(SL.targetExit&&SL.targetExit.copies?lp("sold at the target <b>"+(SL.targetExit.atTarget||0)+" of "+SL.targetExit.copies+"</b>","copies under the new exit rule; "+(SL.targetExit.won||0)+" won, "+sg(SL.targetExit.netSol))+lp("sold when time was up <b>"+(SL.targetExit.atTimeUp||0)+"</b>")+lp("best seen while held <b>"+(SL.targetExit.bestPctMedian==null?"—":ppc(SL.targetExit.bestPctMedian))+"</b>","middle value: the best a sale would have brought while we held")+lp("target sales that failed <b>"+(SL.targetExit.missedTargetSales||0)+"</b>","the price fell back before the sale went through; each costs a fee"):""):"";
var LR=SL.recent||[];var OP=SL.open&&typeof SL.open==="object"?SL.open:null;var holding=!!(SL.openPosition||OP);if(holding){if(!window.SLO)window.SLO=Date.now()}else window.SLO=0;
var hs=!holding?0:OP&&OP.heldSec!=null?+OP.heldSec:OP&&OP.since?(Date.now()-OP.since)/1000:OP&&OP.t?(Date.now()-OP.t)/1000:(Date.now()-window.SLO)/1000;var hx=OP&&(OP.heldSec!=null||OP.since||OP.t);var hd=hs<90?Math.round(hs)+" s":hs<5400?Math.round(hs/60)+" min":(hs/3600).toFixed(1)+" h";var stuck=holding&&(hs>holdS+45||(OP&&OP.tries>0)||/could not be sold|stuck/.test(SL.halted||""));var L0=LR[0]||null;
el("sol-lhold").innerHTML='<div class="k" style="margin-bottom:4px">holding now</div>'+(holding?'<b class="'+(stuck?"bad":"ok")+'">1 coin'+(OP&&(OP.token||OP.symbol)?" ("+esc(String(OP.token||OP.symbol).slice(0,12))+")":"")+' · '+(OP&&OP.stakeSol!=null?OP.stakeSol:stake)+' SOL at stake · '+(OP&&OP.nowPct!=null?'<span class="'+cls(OP.nowPct)+'">'+(OP.nowPct>0?"up "+Number(OP.nowPct).toFixed(1)+"%":OP.nowPct<0?"down "+Number(-OP.nowPct).toFixed(1)+"%":"flat")+' now</span> · ':'')+'held '+(hx?"":"at least ")+hd+(stuck||holdS<10?"":" of "+holdS+" s")+'</b><br><span class="mut">'+(stuck?"The sale has not gone through. The bot keeps trying to sell it"+(OP&&OP.tries?" ("+OP.tries+" tries so far)":"")+", and sends no new copy until it is gone.":"Exit rule: it "+esc(xrule)+". The result shows in the list below once it is sold.")+(OP&&OP.nowPct==null&&OP.worthSol==null?" Price not read yet.":"")+(OP&&OP.bestPct!=null?" Best so far "+ppc(OP.bestPct)+".":"")+(OP&&OP.worthSol!=null?" Selling now would bring back about "+Number(OP.worthSol).toFixed(4)+" SOL.":"")+'</span>':'<b>Nothing held right now.</b><br><span class="mut">Exit rule: each copy '+esc(xrule)+', so this is empty most of the time. '+(L0?"Last copy: "+esc(L0.buy||"?")+(L0.sold?", sold after "+(L0.heldSec==null?"?":Number(L0.heldSec).toFixed(1))+" s":L0.sold===false?", not sold":"")+", "+sg(L0.netSol)+".":"No copy has been sent yet.")+'</span>');var ltm=function(x){var v=x.at||x.t||x.time||null;if(typeof v==="string")v=Date.parse(v);return v&&!isNaN(v)?v:null};var LT=LR.some(function(x){return !!ltm(x)});el("sol-llsub").textContent=LR.length?LR.length+" latest copies, newest first"+(LT?"":" · date and time not reported yet"):"";
el("sol-llog").innerHTML=LR.length?'<table class="log"><thead><tr><th>'+(LT?'kst · ':'')+'our buy</th><th class="nm" title="how many blocks after the wallet we copy our buy landed">where</th><th class="r nm" title="followers that landed in an earlier block than ours">ahead</th><th class="r nm" title="what we paid over the wallet price">paid over</th><th class="r nm">held</th><th class="r nm" title="the best a sale would have brought while we held it">best</th><th>sold</th><th class="r" title="in SOL">result</th></tr></thead><tbody>'+LR.map(function(x){var ok=x.buy==="landed";var b=x.slotsBehind;var ah=x.ahead&&x.ahead.length?x.ahead[0]:x.ahead;return '<tr><td class="nw '+(ok?"ok":"bad")+'">'+(ltm(x)?'<span class="dt"><i>'+new Date(ltm(x)).toLocaleDateString("en-GB",{timeZone:"Asia/Seoul",day:"numeric",month:"short"})+' '+new Date(ltm(x)).toLocaleTimeString("en-GB",{timeZone:"Asia/Seoul",hour:"2-digit",minute:"2-digit",second:"2-digit"})+'</i>'+esc(x.buy||"?")+'</span>':esc(x.buy||"?"))+'</td><td class="nw nm">'+(b==null?"—":b===0?"same block":b===1?"+1 block":"+"+b+" blocks")+'</td><td class="r nw nm">'+lv(typeof ah==="number"?ah:null)+'</td><td class="r nw nm">'+(x.fillGapPct==null?"—":(x.fillGapPct>0?"+":"")+Number(x.fillGapPct).toFixed(1)+"%")+'</td><td class="r nw nm">'+(x.heldSec==null?"—":Number(x.heldSec).toFixed(1)+" s")+'</td><td class="r nw nm '+(x.bestPct==null?"mut":cls(x.bestPct))+'">'+(x.bestPct==null?"—":ppc(x.bestPct))+'</td><td class="nw '+(x.sold===false?"bad":x.exit==="target"?"ok":"")+'">'+(x.sold==null?"—":!x.sold?"not yet":x.exit==="target"?"at target":x.exit==="time"?"time up":"yes")+'</td><td class="r nw '+cls(x.netSol)+'"><b>'+sg(x.netSol).replace(" SOL",'<span class="nm"> SOL</span>')+'</b></td></tr>'}).join("")+'</tbody></table>':'<div class="empty">No real copy yet. A row appears here each time the bot copies a buy.</div>';
el("sol-tag").classList.add("hide");el("sol-state").textContent="real copy test · "+lstate;
if(!(SO&&SO.rules)&&!(SC&&SC.rules))el("sol-note").textContent="The paper tests have not reported yet.";var orn=document.getElementById("sol-rn");if(orn)orn.parentNode.removeChild(orn);el("sol-note").insertAdjacentHTML("afterbegin",'<span id="sol-rn"><b style="color:var(--fg)">Real money: '+(nc?sg(net)+" over "+nc+" cop"+(nc===1?"y":"ies"):"no copy sent yet")+', capped at '+cap+' SOL.</b> Everything else on this page is paper. </span>');
var ST=el("sol-stats");while(ST.firstElementChild&&/^real/.test(ST.firstElementChild.querySelector(".k").textContent))ST.removeChild(ST.firstElementChild);
var hb=function(k,v,c){return '<div><div class="k">'+k+'</div><div class="v big '+(c||"")+'">'+v+'</div></div>'};ST.insertAdjacentHTML("afterbegin",hb("real on",SL.on?"1":"0","")+hb("real result",sg(net),cls(net))+hb("real copies",nc,""))}
}catch(e){console.error(e)}
(function(){var W=s.walletHistory,a=el("alltime");if(!a)return;if(!W||W.allTimeNet==null){a.innerHTML=W&&W.error?"<span class=mut>wallet all-time result: could not be read ("+esc(W.error)+")</span>":"";return}var d=function(t){return new Date(t+9*3600000).toISOString().slice(0,10)};a.innerHTML="<b>Wallet all time</b> (since "+d(W.firstAt)+"): <b class="+cls(W.allTimeNet)+">"+signed(W.allTimeNet)+"</b> <span class=mut>= before the server "+signed(W.beforeNet)+" + since the server (31 Oct) "+signed(W.sinceNet)+""+(W.netDeposited!=null?" · money put in "+money(W.netDeposited)+", worth now "+money(W.worth):"")+"</span>";a.title="From the whole Polymarket history of this wallet ("+W.rows+" buys and payouts). Fees charged outside those rows are not in it. Read "+hhmm(W.at/1000)+" KST."})();
var tn=sumV("todayNet")+plSum("today","net"),an=sumV("net")+plSum("all","net"),tr=sumV("trades")+plSum("all","trades"),wn=sumV("won")+plSum("all","won");
el("today").textContent=signed(tn);el("today").className="v big "+cls(tn);
el("net").textContent=signed(an);el("net").className="v big "+cls(an);
el("ltr").textContent=tr;
var atr=0,awn=0;LR.forEach(function(l){variantsOf(l).forEach(function(v){if(v.manual)return;atr+=v.trades||0;awn+=v.won||0})});el("lwon").textContent=atr?(awn/atr*100).toFixed(1)+"%":"—";el("lwonk").textContent=atr&&atr!==tr?"won · listed rules":"won";el("lwon").title=tr?"all "+tr+" real trades ever: "+(wn/tr*100).toFixed(1)+"% won (1,546 of them 93-97c favourites)":"";
var LD=L.days||[];var tot={o:0,s:0};ALL.forEach(function(l){(l.days||[]).forEach(function(d){tot.o+=d.orders;tot.s+=d.skipped})});

var byDay={};ALLV.forEach(function(l){(l.days||[]).forEach(function(d){var o=byDay[d.day]||(byDay[d.day]={filled:0,settled:0,won:0,net:0,mk:[]});o.filled+=d.filled;o.settled+=d.settled;o.won+=d.won;o.net+=d.net;if(d.settled)o.mk.push({lb:l.label||"BTC 5m",net:d.net,won:d.won,settled:d.settled})})});
var daysAll=Object.keys(byDay).sort().reverse().slice(0,14);
el("cmp").innerHTML=daysAll.length?daysAll.map(function(day){var o=byDay[day];var pct=o.settled?Math.round(100*o.won/o.settled):null;return '<tr><td>'+day+'</td><td class="r">'+o.settled+'</td><td class="r">'+(pct==null?"—":pct+"%")+'</td><td class="r '+cls(o.settled?o.net:null)+'"><b>'+(o.settled?signed(o.net):"—")+'</b></td><td><span class="wps">'+o.mk.map(function(m){return '<span class="wp" title="'+esc(m.lb)+': '+m.won+'/'+m.settled+' won">'+coin(m.lb)+esc(m.lb)+' <b class="'+cls(m.net)+'">'+signed(m.net)+'</b></span>'}).join("")+'</span></td></tr>'}).join(""):'<tr><td class="empty" colspan="5">nothing yet</td></tr>';
window.ruleMenu=function(btn,series,variant,json){var o=JSON.parse(json);var pop=el("pop");if(pop.dataset.k===series+"|"+variant&&pop.style.display==="block"){pop.style.display="none";return}var lad=o.ladder&&o.ladder.length>1?o.ladder.join(","):null;pop.innerHTML='<div class="ph">'+esc(variant)+'</div><div><span>bet size</span><button class="sz" onclick="closeMenu();editSize(\\''+series+'\\',\\''+variant+'\\',\\''+(lad||o.size)+'\\')">$'+o.size+(lad?' <span class="mut">&#8599; '+esc(lad)+'</span>':'')+'<span class="pen">&#9998;</span></button></div>'+(o.note?'<div class="sub">'+esc(o.note)+'</div>':'')+'<div><span>halt after</span><button class="sz" onclick="closeMenu();editHalt(\\''+series+'\\',\\''+variant+'\\','+o.halt+')">'+(o.halt?o.halt+' losses':'never')+'<span class="pen">&#9998;</span></button></div><div><span>daily stop</span><button class="sz" onclick="closeMenu();editMaxLoss(\\''+series+'\\','+o.stop+',\\''+variant+'\\')">−$'+o.stop+'/day<span class="pen">&#9998;</span></button></div>';pop.dataset.k=series+"|"+variant;var r=btn.getBoundingClientRect();pop.style.display="block";pop.style.top=(r.bottom+window.scrollY+4)+"px";pop.style.left=Math.max(8,r.right+window.scrollX-pop.offsetWidth)+"px"};
window.closeMenu=function(){el("pop").style.display="none"};
document.addEventListener("click",function(e){var pop=el("pop");if(pop.style.display==="block"&&!pop.contains(e.target)&&!(e.target.closest&&e.target.closest("button[title^=settings]")))closeMenu()});
function esc(x){return String(x).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function addr(a,label){if(!a)return label+" —";return label+' <a href="https://polygonscan.com/address/'+a+'" target="_blank" rel="noopener" title="'+a+'">'+a.slice(0,6)+"…"+a.slice(-4)+'</a>'}
el("lstate").innerHTML=(function(){var ps=[];var pill=function(c,h,t){return '<span class="wp '+c+'"'+(t?' title="'+esc(t)+'"':'')+'><span class="d"></span>'+h+'</span>'};if(L.mode==="off")ps.push(pill("bad","real orders <b>off</b>"));else if(L.ready)ps.push(pill("ok","wallet <b>ready</b>"));else ps.push(pill("bad","wallet <b>not ready</b>",L.lastError||""));if(L.ready&&L.lastError){var le=String(L.lastError);ps.push(pill("bad","<b>"+esc(le.indexOf("paused:")===0?le:le.slice(0,40))+"</b>",le))}ps.push(pill("",addr(L.funder,"funds"),"deposit wallet on Polygon"));ps.push(pill("",addr(L.wallet,"signer"),"signer key"));var c=L.claims;if(c){if(c.blockedUntil)ps.push(pill("bad","claims paused · <b>"+hhmm(c.blockedUntil/1000)+"</b>","relayer quota used up, resumes "+hhmm(c.blockedUntil/1000)+" KST"));else ps.push(pill("","claims every "+c.everyMin+" min"+(c.nextAt?" · next <b>"+hhmm(c.nextAt/1000)+"</b>":""),"wins are claimed in one batch"))}if(L.statsSince)ps.push(pill("","counting since <b>"+new Date(L.statsSince).toLocaleString("en-GB",{timeZone:"Asia/Seoul",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",hour12:false})+"</b>","every real trade since then, removed rules included"));return ps.join("")})();
var rows=[];ALLV.forEach(function(l){(l.recent||[]).forEach(function(t){rows.push(Object.assign({mk:l.label||"BTC 5m"},t))})});
var cz=function(x){return x==null?"none":Math.round(x*100)+"¢"};var plNm=function(nm){return nm.replace(" pair test","")+' pair <b>test</b>'};var plCell=function(lb,nm){return '<td>'+coin(lb)+'<span class="mut">'+esc(lb)+'</span></td><td class="mut" style="padding-right:10px">'+plNm(nm)+'</td>'};
var plHold=function(w){var q=function(x){return String(Math.round(x*10)/10)};var lone=Math.abs(w.up-w.down)>=1;return lone?(w.up>0&&w.down>0?q(w.up)+" Up · "+q(w.down)+" Down":q(Math.max(w.up,w.down))+" "+(w.up>w.down?"Up":"Down")+" only"):q(w.up)+" Up + "+q(w.down)+" Down"};
var plState=function(w,lb){var pr=Math.min(w.up,w.down),mx=Math.max(w.up,w.down);if(!(mx>0))return {txt:"nothing bought yet",det:"",c:"mut",tip:""};var rr0=RS[lb]||{};var cw0=rr0.window||(rr0.lastBook||{}).window;var closed=!!(w.gone||(cw0&&w.start&&w.start!==cw0));if(Math.abs(w.up-w.down)<1){var lk=pr-w.cost;return {txt:"full pair · "+signed(lk)+" locked",det:(closed?"Window closed, waiting for the result. ":"")+"Both sides are held and one of them always pays $1 a share, so this result is fixed.",c:cls(lk)||"ok",tip:""}}
var side=w.up>w.down?"Up":"Down";var best=mx-w.cost,worst=pr-w.cost;var avg=w.cost/(w.up+w.down);var kind=(pr>0?"uneven, extra ":"lone ")+side+" clip"+(pr>0?"":" at "+cents(avg));var ends=signed(best)+" if "+side+" wins · "+signed(worst)+" if not";
var rr=RS[lb]||{};var b=rr.lastBook||{};var cur=rr.window||b.window;var tip="best case "+signed(best)+", worst case "+signed(worst)+(w.bidUp!=null||w.bidDown!=null?" · still bidding "+(w.bidUp!=null?"Up at "+cents(w.bidUp):"Down at "+cents(w.bidDown))+" to finish the pair":" · no bid resting for the other side");
if(closed||(w.start&&cur&&w.start!==cur)){var pl=rr.pendingLean?rr.pendingLean[w.start]:null;if(pl==null||pl===0)return {txt:"settling · waiting for the result",det:kind+" · "+ends,c:"mut",tip:tip};var ok=(pl>0)===(side==="Up");return {txt:ok?"likely to win "+signed(best):"likely to lose "+signed(worst),det:kind+" · window closed, waiting for the result",c:ok?"ok":"bad",tip:tip}}
var up=(b.chainlink!=null&&b.open!=null&&(!w.start||!cur||w.start===cur))?(b.chainlink>b.open?1:b.chainlink<b.open?-1:0):null;var now=side==="Up"?(b.upBid!=null?b.upBid:b.upAsk):(b.downBid!=null?b.downBid:b.downAsk);var np=now!=null&&up!=null?" · now "+cents(now):"";
if(up==null||up===0)return {txt:"open · no live price",det:kind+np+" · "+ends,c:"mut",tip:tip};var ah=(up>0)===(side==="Up");return {txt:ah?"winning now · "+signed(best):"losing now · "+signed(worst),det:kind+np+" · "+(ah?signed(best)+" if it holds, "+signed(worst)+" if it turns":signed(worst)+" if it stays, "+signed(best)+" if it turns"),c:ah?"ok":"bad",tip:tip}};
plNow.forEach(function(x){var w=x.w,lb=plLab(w.series);var st=w.start||Math.floor(Date.now()/1000);var o=plState(w,lb);var sg=plSettling(x);rows.push({pair:true,po:sg?1:0,mk:lb,window:st,t:st*1000,html:'<tr data-k="'+esc("pairnow|"+x.nm+"|"+w.series+"|"+st)+'"><td><span class="dot'+(sg?"":" on")+'"></span>'+(w.start?dtm(w.start):"now")+'</td>'+plCell(lb,x.nm)+'<td class="rn" style="color:inherit" title="shares held on each side">'+plHold(w)+'</td><td class="r">'+money(w.cost)+'</td><td class="r '+o.c+'" title="'+esc(o.tip)+'"><b>'+o.txt+'</b></td></tr>'+(o.det?'<tr class="p2"><td></td><td colspan="5" class="'+(o.c==="mut"?"mut":"")+'">'+o.det+'</td></tr>':'')})});
PLR.forEach(function(r){(r.T.P.recent||[]).forEach(function(w){if(r.keys.indexOf(w.series)<0)return;var lb=plLab(w.series);rows.push({pair:true,po:2,mk:lb,window:w.start,t:w.start*1000,html:'<tr data-k="'+esc("pairdone|"+r.T.nm+"|"+w.series+"|"+w.start)+'" data-res="'+(w.net>=0?"ok":"bad")+'" data-pnl="'+w.net+'" data-w="'+w.start+'"><td><span class="dot"></span>'+dtm(w.start)+'</td>'+plCell(lb,r.T.nm)+'<td class="rn" style="color:inherit" title="'+(Math.abs(w.up-w.down)<1?"full pair":"lone clip")+': shares held on each side">'+plHold(w)+'</td><td class="r">'+money(w.cost)+'</td><td class="r '+cls(w.net)+'">'+signed(w.net)+'</td></tr>'})})});
var nopen=0,nsettling=0;var orank=function(t){if(t.pair)return t.po;if(t.dry)return 3;if(!(t.pnl==null&&t.ok))return 2;return openState(t).done?1:0};rows.forEach(function(t){t.orank=orank(t);if(t.orank===0)nopen++;else if(t.orank===1)nsettling++});
// Open trades (window still running) first, then settling, then closed, then dry-run orders (no money, 7 Nov 2026: kept out of the real counts); newest first inside each group.
var tk=function(t){return t.window?t.window*1000:(t.t||0)};rows.sort(function(a,b){return a.orank-b.orank||tk(b)-tk(a)||(b.t||0)-(a.t||0)});
var FITLOG=window.matchMedia&&window.matchMedia("(min-width:1400px)").matches;if(TAB==="overview"){var perW={},nd=0;rows=rows.filter(function(t){if(t.orank<2)return true;if(t.orank===3)return ++nd<=6;var w=WOF(t.mk);perW[w]=(perW[w]||0)+1;return perW[w]<=10})}else if(!FITLOG)rows=rows.filter(function(t){return t.orank<2}).concat(rows.filter(function(t){return t.orank===2}).slice(0,25),rows.filter(function(t){return t.orank===3}).slice(0,6));
function feeOf(t){if(t.fee!=null)return t.fee;if(!(t.shares>0)||!(t.cost>0))return 0;var p=t.cost/t.shares;return 0.07*t.shares*p*(1-p)}
function openState(t){if(t.shares<=0)return {txt:"open",c:"mut"};var win="+"+money(t.shares-t.cost-feeOf(t))+" if win";
var rr=RS[t.mk]||{};var b=rr.lastBook||{};if(t.window!==(rr.window||b.window)){var pl=rr.pendingLean?rr.pendingLean[t.window]:null;if(pl==null||pl===0)return {txt:"waiting for result · "+win,c:"mut",done:true};var ok=(pl>0)===(t.side==="UP");return {txt:(ok?"likely win · "+win.replace(" if win",""):"likely loss · \u2212"+money(t.cost+feeOf(t)))+" · waiting",c:ok?"ok":"bad",done:true}}
var up=(b.chainlink!=null&&b.open!=null)?(b.chainlink>b.open?1:b.chainlink<b.open?-1:0):null;
var mine=t.side==="UP"?b.upAsk:b.downAsk;var mk=mine!=null?" · "+cents(mine):"";
if(up==null)return {txt:"open"+mk+" · "+win+" · \u2212"+money(t.cost+feeOf(t))+" if not",c:"mut"};
var ahead=up===0?0:(up>0)===(t.side==="UP")?1:-1;
var lose="\u2212"+money(t.cost+feeOf(t));return {txt:(ahead>0?"winning now"+mk+" · "+win.replace(" if win"," if it holds")+" · "+lose+" if it turns":ahead<0?"losing now"+mk+" · "+lose+" if it stays · "+win.replace(" if win"," if it turns"):"even"+mk+" · "+win+" · "+lose+" if not"),c:ahead>0?"ok":ahead<0?"bad":"mut"}}
swap("log",(rows.length?rows.map(function(t,i){var newg=i===0||rows[i-1].orank!==t.orank;var hd=newg?'<tr class="grp"><td colspan="6">'+["open orders","settling orders","settled trades","dry run · signed but not sent, no money, not counted above"][t.orank]+'</td></tr>':"";if(t.orank>=2&&t.window&&(newg||kday(rows[i-1].window||0)!==kday(t.window)))hd+='<tr class="dsep"><td colspan="6">'+kdayLabel(t.window)+'</td></tr>';if(t.pair)return hd+t.html;var o=t.pnl==null&&t.ok&&!t.dry?openState(t):null;var res=t.dry?(t.won==null?"dry · open":t.won?"dry · would win":"dry · would lose"):o?o.txt:t.pnl==null?(t.ok?"dry":t.status==="skipped"?"skipped":"no fill"):signed(t.pnl);var c=t.dry?"mut":o?o.c:t.pnl==null?"mut":cls(t.pnl);var px=t.shares>0?Math.round(t.cost/t.shares*100)+"¢":cents(t.ask);return hd+'<tr class="'+(t.ok?"":"dim")+'" data-k="'+esc(t.mk+"|"+t.window+"|"+(t.variant||"")+"|"+(t.t||""))+'" data-res="'+(t.pnl==null?"open":t.pnl>=0?"ok":"bad")+'"'+(t.dry?'':' data-pnl="'+(t.pnl==null?"":t.pnl)+'"')+' data-w="'+(t.window||"")+'"><td><span class="dot'+(o&&!o.done?" on":"")+'"></span>'+dtm(t.window)+'</td><td class="'+(t.side==="UP"?"ok":"bad")+'">'+coin(t.mk)+(OL.length?'<span class="mut">'+(TAB==="overview"?t.mk:t.mk.replace(" 5m",""))+'</span> ':"")+t.side+'</td><td class="mut rn">'+rname(t.variant)+'</td><td>'+px+(t.shares>0?" × "+t.shares.toFixed(1):"")+'</td><td class="r">'+(t.cost>0?money(t.cost):"")+'</td><td class="r '+c+'">'+res+'</td></tr>'}).join(""):'<tr><td class="empty" colspan="6">no filled orders yet</td></tr>'));
if(FITLOG){var lw=el("logwrap");var lh=lw?lw.clientHeight:0;if(lh>0)Array.prototype.forEach.call(el("log").children,function(tr){tr.style.display=(tr.offsetTop+tr.offsetHeight>lh+1)?"none":""});var kids=el("log").children;for(var ki=kids.length-1;ki>=0;ki--){var kn=kids[ki+1];if(/\\b(grp|dsep)\\b/.test(kids[ki].className)&&(!kn||kn.style.display==="none"))kids[ki].style.display="none"}}
var tn=0,tw=0,tnet=0,tset=0,tmin=Infinity;Array.prototype.forEach.call(el("log").children,function(tr){if(tr.style.display==="none"||!tr.hasAttribute("data-pnl"))return;tn++;var w=parseFloat(tr.getAttribute("data-w"));if(w>0&&w<tmin)tmin=w;var v=tr.getAttribute("data-pnl");if(v!==""){tset++;var pv=parseFloat(v);tnet+=pv;if(pv>=0)tw++}});
var tspanH=isFinite(tmin)?(Date.now()/1000-tmin)/3600:0;var trate=tspanH>=0.25&&tset?" · ≈ "+signed(tnet/tspanH)+"/h":"";
el("lopen").textContent=[tn?tn+" shown · "+tw+"/"+tset+" won · "+signed(tnet)+trate:"",nopen?nopen+" open":"",nsettling?nsettling+" settling":""].filter(Boolean).join(" · ");
(function(){var isNew=function(d,tr){if(!d)return false;var age=Date.now()-Date.parse(d);return age<86400000||(age<3*86400000&&tr<30)};var LIVE={},DRY={};ALL.forEach(function(l){if(l.mode==="off")return;var lb=l.label||"BTC 5m";((l.variants&&l.variants.length)?l.variants:(l.variant?[{variant:l.variant}]:[])).forEach(function(v){LIVE[lb+"|"+v.variant]=v.size||5;if(l.mode==="dry")DRY[lb+"|"+v.variant]=1})});var REAL={};ALL.forEach(function(l){var lb=l.label||"BTC 5m";Object.keys(l.realByVariant||{}).forEach(function(k){REAL[lb+"|"+k]=l.realByVariant[k]})});var M=[{label:"BTC 5m",key:"",papers:s.papers}].concat((s.series||[]).map(function(r){return {label:r.label,key:r.key||"",papers:r.papers}})).filter(function(m){return inTab(m.label)});if(TAB==="overview"){var cells=[];M.forEach(function(m){(m.papers||[]).forEach(function(p){var f=p.fillable||null;if(!f||p.discarded||!f.trades||f.trades<20||f.won/f.trades<0.5||f.net<=0)return;var ls=LIVE[m.label+"|"+p.name];var k=(ls||5)/(p.size||5);cells.push({name:p.name,meta:p,label:m.label,key:m.key,net:p.net*k,trades:p.trades,won:p.won,ls:ls,f:f,fnet:f.net*k})})});cells.sort(function(a,b){return b.fnet-a.fnet});cells=cells.slice(0,20);el("labsub").textContent="top 20 by fillable net among rules winning 50%+ · 20+ fillable trades · $5 a trade, real cells at their size";el("labhead").innerHTML='<tr><th>rule</th><th>market</th><th class="r" title="only trades whose ask was still there with 5+ shares 2-5 s after the signal, as a real order would need">fillable net</th><th class="r" title="fillable trades">won/trades</th><th class="r">won</th><th class="r" title="tickets that were gone before a real order could land">missed</th><th class="r" title="every paper trade, fillable or not: net · won/trades">all paper</th><th class="r" title="the same rule on this market with real money, all time: net · won/fills">real</th><th></th></tr>';var h=cells.map(function(c){var live=!!c.ls;var dry=!!DRY[c.label+"|"+c.name];var rl=REAL[c.label+"|"+c.name];var f=c.f;var pcell='<span class="'+cls(c.net)+'">'+signed(c.net)+'</span> <span class="mut">'+c.won+'/'+c.trades+'</span>';var rcell=rl?'<span class="'+cls(rl.net)+'"><b>'+signed(rl.net)+'</b></span> <span class="mut">'+rl.won+'/'+rl.trades+' · '+(rl.won/rl.trades*100).toFixed(0)+'%</span>':'<span class="mut">—</span>';return '<tr><td><b>'+esc(c.name)+'</b>'+(isNew(c.meta.added,c.trades)?' <span class="tag new">new</span>':'')+' <span class="info" data-tip="'+esc(c.meta.idea||c.meta.rule||"")+'">i</span></td><td>'+coin(c.label)+esc(c.label)+'</td><td class="r fil '+cls(c.fnet)+'"><b>'+signed(c.fnet)+'</b>'+(c.ls?' <span class="mut">@$'+c.ls+'</span>':'')+'</td><td class="r">'+f.won+'/'+f.trades+'</td><td class="r">'+(f.won/f.trades*100).toFixed(1)+'%</td><td class="r mut">'+(f.miss||0)+'</td><td class="r">'+pcell+'</td><td class="r">'+rcell+'</td><td class="r">'+(dry?'<span class="ldot dry" title="DRY RUN: orders are signed but not sent, no real money"></span>':live?'<span class="ldot" title="on real money"></span>':'<button class="btn go" title="put '+esc(c.name)+' on real money for '+esc(c.label)+'" onclick="goLive(\\''+c.key+'\\',\\''+esc(c.label)+'\\',\\''+esc(c.name)+'\\')">&#9654;</button>')+'</td></tr>'}).join("")||'<tr><td class="empty" colspan="9">no cell has 20+ fillable trades at 50%+ won and a profit yet</td></tr>';if(h!==LABHTML){LABHTML=h;el("lab").innerHTML=h}return}var cid=function(k){return "cell-"+esc(k).replace(/[^a-z0-9]/gi,"_")};
var names=(s.papers||[]).map(function(p){return p.name});var rows=names.map(function(n){var meta=(s.papers||[]).filter(function(p){return p.name===n})[0]||{};var cells=[],tot=0,tr=0,wn=0,ft=0,fw=0,fn=0,fm=0;M.forEach(function(m){var p=(m.papers||[]).filter(function(x){return x.name===n})[0];if(!p||!p.trades){cells.push(null);return}var ls=m.agg?null:LIVE[m.label+"|"+n];var net=m.agg?p.net:p.net*(ls||5)/(p.size||5);tot+=net;tr+=p.trades;wn+=p.won;var f=p.fillable||{};ft+=f.trades||0;fw+=f.won||0;fn+=(f.net||0)*(m.agg?1:(ls||5)/(p.size||5));fm+=f.miss||0;cells.push({net:net,won:p.won,trades:p.trades,label:m.label,key:m.key,ls:ls})});return {name:n,meta:meta,cells:cells,tot:tot,tr:tr,wn:wn,ft:ft,fw:fw,fn:fn,fm:fm}});
rows.sort(function(a,b){if(a.meta.discarded!==b.meta.discarded)return a.meta.discarded?1:-1;if(!a.tr!==!b.tr)return a.tr?-1:1;return b.tot-a.tot});if(TAB==="overview")rows=rows.filter(function(r){return !r.meta.discarded&&r.tr}).slice(0,20);

el("labsub").textContent=TAB==="overview"?"top 20 rules across every window · $5 a trade, summed over coins":"every rule on every market · $5 a trade, real cells at their size (@$) · net won/trades";el("labhead").innerHTML='<tr><th>rule</th>'+M.map(function(m){return '<th class="pc">'+(m.agg?m.label:coin(m.label)+m.label)+'</th>'}).join("")+'<th class="r">all</th><th class="r">won</th><th class="r" title="fillable: only trades whose ask was still there with 5+ shares 2-5 s after the signal, as a real order would need · net won/trades (misses)">fillable</th><th></th></tr>';
var labHtml=rows.map(function(r){var m=r.meta;return '<tr class="'+(m.discarded?"off":"")+'"><td><b>'+r.name+'</b>'+(isNew(m.added,r.tr)?' <span class="tag new">new</span>':"")+' <span class="info" data-tip="'+esc(m.idea||m.rule||"")+'">i</span></td>'+r.cells.map(function(c,ci){var m=M[ci];var k=m.label+"|"+r.name;var live=!!LIVE[k];var dry=!!DRY[k];var act=r.meta.discarded||m.agg?'':dry?'<span class="ldot dry" title="DRY RUN: orders are signed but not sent, no real money"></span>':live?'<span class="ldot" title="on real money"></span>':'<button class="btn go" title="put '+r.name+' on real money for '+m.label+'" onclick="goLive(\\''+m.key+'\\',\\''+m.label+'\\',\\''+r.name+'\\')">&#9654;</button>';return '<td class="pc'+(dry?' isdry':live?' islive':'')+'" id="'+cid(k)+'">'+(c?'<div class="n '+cls(c.net)+'">'+signed(c.net)+'</div><div class="c">'+c.won+'/'+c.trades+(c.ls?' <span class="mut">@$'+c.ls+'</span>':'')+act+'</div>':'<div class="n mut">—</div><div class="c">'+act+'</div>')+'</td>'}).join("")+'<td class="r '+cls(r.tr?r.tot:null)+'"><b>'+(r.tr?signed(r.tot):"—")+'</b></td><td class="r">'+(r.tr?(r.wn/r.tr*100).toFixed(1)+"%":"—")+'</td><td class="r fil">'+(r.ft||r.fm?'<span class="'+cls(r.fn)+'"><b>'+signed(r.fn)+'</b></span> <span class="mut">'+r.fw+'/'+r.ft+(r.ft?' · '+(r.fw/r.ft*100).toFixed(0)+'%':'')+(r.fm?' ('+r.fm+' miss)':'')+'</span>':'<span class="mut">—</span>')+'</td><td class="r">'+(TAB==="overview"?'':m.discarded?'<button class="btn restore" onclick="discard(\\''+r.name+'\\',true)">restore</button>':'<button class="btn" onclick="discard(\\''+r.name+'\\',false)">discard</button>')+'</td></tr>'}).join("");if(labHtml!==LABHTML){LABHTML=labHtml;el("lab").innerHTML=labHtml}})();
el("ov").innerHTML=WINS.map(function(w){var mk=[s].concat(s.series||[]).filter(function(r){return WOF(r.label||"BTC 5m")===w});if(!mk.length)return '<tr class="dim"><td><b>'+w+'</b></td><td class="r mut">0</td><td class="r mut">—</td><td class="r mut">—</td><td class="r mut">—</td><td class="r mut">—</td><td class="r mut">—</td><td class="mut sm">not recorded yet</td></tr>';var ls=ALL.filter(function(l){return WOF(l.label||"BTC 5m")===w});var on=0;ls.forEach(function(l){if(l.mode==="off")return;((l.variants&&l.variants.length)?l.variants:(l.variant?[{variant:l.variant}]:[])).forEach(function(v){if(!v.paused&&!v.halted&&!v.manual)on++})});var g=function(k){return ls.reduce(function(a,l){return a+(l[k]||0)},0)};var tn=g("todayNet"),an=g("net"),tr=g("trades"),wn=g("won");var best=null;var agg={};mk.forEach(function(r){(r.papers||[]).forEach(function(p){if(!p.trades||p.discarded)return;var o=agg[p.name]||(agg[p.name]={net:0,tr:0,wn:0});o.net+=p.net*5/(p.size||5);o.tr+=p.trades;o.wn+=p.won})});Object.keys(agg).forEach(function(n){if(!best||agg[n].net>agg[best].net)best=n});return '<tr class="lnk" title="open the '+w+' tab" onclick="showTab(\\''+w+'\\');poll()"><td><b>'+w+'</b></td><td class="r">'+mk.length+'</td><td class="r">'+(on||"—")+'</td><td class="r '+cls(tn)+'"><b>'+(ls.length?signed(tn):"—")+'</b></td><td class="r '+cls(an)+'"><b>'+(ls.length?signed(an):"—")+'</b></td><td class="r">'+(tr||"—")+'</td><td class="r">'+(tr?(wn/tr*100).toFixed(1)+"%":"—")+'</td><td>'+(best?'<b>'+esc(best)+'</b> <span class="'+cls(agg[best].net)+'">'+signed(agg[best].net)+'</span> <span class="mut sm">'+agg[best].wn+'/'+agg[best].tr+'</span>':'<span class="mut">—</span>')+'</td></tr>'}).join("");
el("ovr").innerHTML=(function(){var rows=[];ALL.forEach(function(l){var lb=l.label||"BTC 5m";var seen={};var vs=l.mode==="off"?[]:((l.variants&&l.variants.length)?l.variants:(l.variant?[{variant:l.variant,size:l.size,trades:l.trades,won:l.won,net:l.net}]:[]));vs.forEach(function(v){if(v.manual)return;seen[v.variant]=1;var td=v.today||{};rows.push({name:v.variant,mk:v.bidUnderC!=null,lb:lb,size:v.size,tn:td.net||0,ttr:td.trades||0,twn:td.won||0,an:v.net||0,atr:v.trades||0,awn:v.won||0,live:!(v.halted||v.stopped||v.paused)&&l.mode!=="dry",dry:l.mode==="dry",state:l.mode==="dry"?"dry run":v.halted?"halted, back on paper":v.stopped?"stopped for today":v.paused?"paused":"live"})});Object.keys(l.realByVariant||{}).forEach(function(k){if(seen[k])return;var r=l.realByVariant[k]||{};var td=r.today||{};rows.push({name:k,lb:lb,size:null,tn:td.net||0,ttr:td.trades||0,twn:td.won||0,an:r.net||0,atr:r.trades||0,awn:r.won||0,state:"paper now"})})});rows.sort(function(a,b){if(b.tn!==a.tn)return b.tn-a.tn;if(b.an!==a.an)return b.an-a.an;return a.name<b.name?-1:1});var pct=function(w,t){return t?(w/t*100).toFixed(0)+"%":"—"};return rows.map(function(r){return '<tr><td><span class="dot'+(r.dry?' dry':r.live?' on':'')+'"'+(r.dry?' title="DRY RUN: orders signed, not sent, no real money"':r.live?' title="trading real money now"':'')+'></span>'+rname(r.name,r.mk)+(r.dry?'<i class="st warn" title="DRY RUN: orders signed, not sent, no real money">DRY</i>':'')+'</td><td>'+ctk(r.lb)+'<span class="mut"> '+esc(r.lb.split(" ").slice(1).join(" "))+'</span></td><td class="r">'+(r.size?"$"+r.size:'<span class="mut">—</span>')+'</td><td class="r '+cls(r.ttr?r.tn:null)+'"><b>'+(r.ttr?signed(r.tn):"—")+'</b></td><td class="r">'+(r.ttr||"—")+'</td><td class="r">'+pct(r.twn,r.ttr)+'</td><td class="r '+cls(r.atr?r.an:null)+'"><b>'+(r.atr?signed(r.an):"—")+'</b></td><td class="r">'+(r.atr||"—")+'</td><td class="r">'+pct(r.awn,r.atr)+'</td></tr>'}).join("")||'<tr><td class="empty" colspan="9">no real trades yet</td></tr>'})();
var seenCoin={};var coinRows=[];[s].concat(s.series||[]).forEach(function(r){var lb=r.label||"BTC 5m";var k=lb.split(" ")[0];if(seenCoin[k]||!r.feeds)return;seenCoin[k]=1;coinRows.push({k:k,lb:lb,feeds:r.feeds})});
var fcell=function(f){if(!f)return '<td class="mut">—</td>';var age=f.last?Math.round((Date.now()-f.last.t)/1000):null;var ok=f.healthy&&age!=null&&age<30;return '<td title="'+f.ticks+' ticks'+(age!=null?', last '+age+'s ago':'')+'"><span class="wp '+(ok?"ok":"bad")+'"><span class="d"></span>'+(f.last?money(f.last.price):"no data")+(age!=null?' <span class="mut">'+age+'s</span>':'')+'</span></td>'};
el("feeds").innerHTML=coinRows.map(function(c){var by={};c.feeds.forEach(function(f){var n=String(f.name||"");["chainlink","binance","coinbase","futures"].forEach(function(k){if(n.indexOf(k)===0)by[k]=f})});return '<tr><td>'+coin(c.lb)+'<b>'+esc(c.k)+'</b></td>'+fcell(by.chainlink)+fcell(by.binance)+fcell(by.coinbase)+fcell(by.futures)+'</tr>'}).join("")||'<tr><td class="empty" colspan="5">no feeds</td></tr>';
el("wd").textContent=s.windowsDone;el("ws").textContent=s.windowsResolved;el("wp").textContent=s.pending;el("sn").textContent=s.snapshots;
el("err").textContent=s.lastError?"last error: "+s.lastError:"";
el("note").textContent="Data is in the data/ folder next to the app. Set \\"mode\\" to \\"off\\" in data/live.json to stop real orders.";
tickV(prevV);}catch(e){console.error(e);el("sub").textContent="status unavailable"}}
var H={},PREV={},DECIDED={};
function feedChart(key,label,sec,r){var b=r.lastBook||{};var w=r.window||b.window;if(!w)return;var pv=PREV[key];if(pv&&pv.w!==w&&pv.last!=null&&pv.open!=null){var v=(pv.last-pv.open)/pv.open*1e4;DECIDED[key]={side:pv.last>=pv.open?"UP":"DOWN",bp:(v<0?"\u2212":"+")+Math.abs(v).toFixed(1),at:Date.now(),until:Date.now()+5000}}
var h=H[key]={w:w,sec:sec,label:label,open:null,pts:[]};
h.left=b.window===w&&b.left!=null?b.left:Math.max(0,w+sec-Math.floor(Date.now()/1000));h.up=b.window===w?b.upAsk:null;h.down=b.window===w?b.downAsk:null;h.ua=b.window===w?(b.upAsks||[]):[];h.ub=b.window===w?(b.upBids||[]):[];if(b.window===w&&b.open!=null)h.open=b.open;
h.pts=(r.prices||[]).map(function(q){return {x:Math.max(0,Math.min(1,q[0]/sec)),p:q[1]}});if(h.open==null&&h.pts.length)h.open=h.pts[0].p;h.last=h.pts.length?h.pts[h.pts.length-1].p:b.chainlink;PREV[key]={w:w,last:h.last,open:h.open}}
var WKEY="",WPTS=null,WH=null;var RANGES={all:0,"30d":30*86400000,"7d":7*86400000,"3d":3*86400000,"24h":86400000,"6h":6*3600000,"1h":3600000};var WRANGE=(function(){try{var r=localStorage.getItem("wrange");return RANGES[r]!=null?r:"all"}catch(e){return "all"}})();document.addEventListener("click",function(e){var b=e.target&&e.target.closest?e.target.closest("#wrng .btn"):null;if(!b)return;WRANGE=b.getAttribute("data-r")||"all";try{localStorage.setItem("wrange",WRANGE)}catch(x){}var bs=document.querySelectorAll("#wrng .btn");for(var i=0;i<bs.length;i++)bs[i].classList.toggle("on",bs[i].getAttribute("data-r")===WRANGE);WKEY="";if(WH)drawWallet(WH)});
function drawWallet(hst){var w=el("wallet");if(!w)return;if(!hst||!hst.points||hst.points.length<2){w.innerHTML='<div class="empty">no real trades yet</div>';WKEY="";return}WH=hst;var pts=hst.points,act=hst.wallet||[],deps=hst.deposits||[];var key=WRANGE+"|"+pts.length+"|"+pts[pts.length-1][0]+"|"+pts[pts.length-1][1]+"|"+act.length+"|"+(w.clientWidth||0);if(key===WKEY)return;WKEY=key;var rms=RANGES[WRANGE]||0;if(rms){var now=Date.now(),cut=now-rms;var cutTo=function(a){var out=[],prev=null;a.forEach(function(q){if(q[0]<cut)prev=q;else out.push(q)});if(prev)out.unshift([cut,prev[1]]);if(out.length&&out[out.length-1][0]<now)out.push([now,out[out.length-1][1]]);return out};pts=cutTo(pts);act=act.length>1?cutTo(act):[];deps=deps.filter(function(d){return d.t>=cut});if(pts.length<2){w.innerHTML='<div class="empty">nothing in this range yet</div>';WPTS=null;var s0=el("wsub");if(s0)s0.textContent="";return}}
var W=Math.max(520,w.clientWidth||900),HT=200,Lm=48,R=16,T=18,B=24,pw=W-Lm-R,ph=HT-T-B;var t0=pts[0][0],t1=pts[pts.length-1][0];var start=pts[0][1];var inn=deps.reduce(function(a,d){return a+d.amount},0);
var mline=[[t0,start]];deps.slice().sort(function(a,b){return a.t-b.t}).forEach(function(d){var prev=mline[mline.length-1][1];mline.push([d.t,prev]);mline.push([d.t,prev+d.amount])});mline.push([t1,mline[mline.length-1][1]]);
var ys=pts.map(function(p){return p[1]}).concat(act.map(function(p){return p[1]}));var lo=Math.min.apply(null,ys),hi=Math.max.apply(null,ys);if(hi-lo<1)hi=lo+1;var pad=(hi-lo)*0.08;lo-=pad;hi+=pad;var X=function(t){return Lm+(t-t0)/(t1-t0)*pw},Y=function(v){return T+(1-(v-lo)/(hi-lo))*ph};var g="";
var day=86400000,kst=9*3600000,span=t1-t0,step=span<=5400000?600000:span<=8*3600000?3600000:span<=2*day?6*3600000:day,hourly=step<day;for(var d=Math.ceil((t0+kst)/step)*step-kst;d<=t1;d+=step){var x=X(d);var dl=new Date(d+kst).toISOString();g+='<line class="gl" x1="'+x.toFixed(1)+'" x2="'+x.toFixed(1)+'" y1="'+T+'" y2="'+(T+ph)+'"/><text class="gt" x="'+(x+4).toFixed(1)+'" y="'+(HT-7)+'">'+(hourly?dl.slice(11,16):dl.slice(5,10).replace("-","/"))+'</text>'}
var steps=4;for(var i=0;i<=steps;i++){var v=lo+(hi-lo)*i/steps,y=Y(v);g+='<line class="gl" x1="'+Lm+'" x2="'+(Lm+pw)+'" y1="'+y.toFixed(1)+'" y2="'+y.toFixed(1)+'" stroke-dasharray="2 3"/><text class="gt" x="'+(Lm-6)+'" y="'+(y+3).toFixed(1)+'" text-anchor="end">$'+(hi-lo<20?v.toFixed(1):Math.round(v))+'</text>'}
if(lo<0&&hi>0)g+='<line x1="'+Lm+'" x2="'+(Lm+pw)+'" y1="'+Y(0).toFixed(1)+'" y2="'+Y(0).toFixed(1)+'" stroke="#ff6b6b" stroke-width="1" stroke-dasharray="4 3"/>';
deps.forEach(function(d){var x=X(d.t);g+='<path class="dep" d="M'+(x-4).toFixed(1)+','+(T+ph+1)+' L'+(x+4).toFixed(1)+','+(T+ph+1)+' L'+x.toFixed(1)+','+(T+ph-6)+' Z"><title>top-up +'+money(d.amount)+'</title></path>'});
var path=pts.map(function(p,i){return (i?"L":"M")+X(p[0]).toFixed(1)+","+Y(p[1]).toFixed(1)}).join(" ");g+='<defs><linearGradient id="wg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#8c8cff" stop-opacity=".28"/><stop offset="1" stop-color="#8c8cff" stop-opacity="0"/></linearGradient></defs><path fill="url(#wg)" d="'+path+' L'+X(t1).toFixed(1)+","+Y(Math.max(lo,0)).toFixed(1)+" L"+X(t0).toFixed(1)+","+Y(Math.max(lo,0)).toFixed(1)+' Z"/><path class="est" d="'+path+'"/>';
if(act.length>1)g+='<path class="act" d="'+act.map(function(p,i){return (i?"L":"M")+X(p[0]).toFixed(1)+","+Y(p[1]).toFixed(1)}).join(" ")+'"/>';
var lp=pts[pts.length-1];g+='<circle cx="'+X(lp[0]).toFixed(1)+'" cy="'+Y(lp[1]).toFixed(1)+'" r="3.5" fill="#8c8cff"/>';
g+='<g id="whov" style="display:none"><line id="whx" class="hx" y1="'+T+'" y2="'+(T+ph)+'"/><circle id="whd" r="4" fill="#e8eaf0" stroke="#8c8cff" stroke-width="2"/></g>';
w.innerHTML='<svg id="wsvg" viewBox="0 0 '+W+' '+HT+'" width="'+W+'" height="'+HT+'">'+g+'</svg><div id="wtip" class="wtip" style="display:none"></div>';
WPTS={pts:pts,act:act,X:X,Y:Y,t0:t0,t1:t1,Lm:Lm,pw:pw,W:W,start:start,inn:inn,mline:mline};
var bs=document.querySelectorAll("#wrng .btn");for(var bi=0;bi<bs.length;bi++)bs[bi].classList.toggle("on",bs[bi].getAttribute("data-r")===WRANGE);var sub=el("wsub");if(sub)sub.innerHTML='start <b>'+money(start)+'</b> · top-ups <b class="ok">+'+money(inn)+'</b> · now <b>'+money(lp[1])+'</b> · net <b class="'+cls(lp[1]-start-inn)+'">'+signed(lp[1]-start-inn)+'</b>'+(act.length>1?' · <span class="mut">white: wallet as read</span>':'');
}
function walletHover(e){var P=WPTS,w=el("wallet"),svg=el("wsvg"),hov=el("whov"),tip=el("wtip");if(!P||!svg||!hov||!tip)return;var r=svg.getBoundingClientRect();var mx=(e.clientX-r.left)*P.W/r.width;if(mx<P.Lm||mx>P.Lm+P.pw){hov.style.display="none";tip.style.display="none";return}var t=P.t0+(mx-P.Lm)/P.pw*(P.t1-P.t0);var src=P.pts,lab="rebuilt";if(P.act.length>1&&t>=P.act[0][0]){src=P.act;lab="wallet as read"}var lo=0,hi=src.length-1;while(hi-lo>1){var m=(lo+hi)>>1;if(src[m][0]<=t)lo=m;else hi=m}var p=(t-src[lo][0]<src[hi][0]-t)?src[lo]:src[hi];var mi=P.start;P.mline.forEach(function(q){if(q[0]<=p[0])mi=q[1]});var x=P.X(p[0]),y=P.Y(p[1]);hov.style.display="";el("whx").setAttribute("x1",x);el("whx").setAttribute("x2",x);el("whd").setAttribute("cx",x);el("whd").setAttribute("cy",y);
var d=new Date(p[0]+9*3600000),when=d.toISOString().slice(5,16).replace("-","/").replace("T"," ")+" KST";tip.innerHTML='<div class="mut">'+when+'</div><div><b>'+money(p[1])+'</b> <span class="mut">'+lab+'</span></div><div class="'+cls(p[1]-mi)+'">'+signed(p[1]-mi)+' <span class="mut">vs money in '+money(mi)+'</span></div>';tip.style.display="";var px=x*r.width/P.W,left=px+14;if(left+tip.offsetWidth>w.clientWidth-4)left=px-tip.offsetWidth-14;tip.style.left=left+"px";tip.style.top=Math.max(0,Math.min(y*r.height/200-10,r.height-tip.offsetHeight-2))+"px"}
document.addEventListener("mousemove",function(e){var w=el("wallet");if(!w)return;if(w.contains(e.target))walletHover(e);else{var h=el("whov"),t=el("wtip");if(h)h.style.display="none";if(t)t.style.display="none"}});
window.addEventListener("resize",function(){WKEY=""});
function placeBets(){var bb=el("bets");if(!bb)return;document.querySelectorAll(".chart .bslot").forEach(function(sl){var b=bb.querySelector('.bet[data-k="'+sl.dataset.k+'"]');if(b)sl.appendChild(b)})}
function depthSvg(h){var W=560,HT=150,L=6,R=6,T=6,B=16,pw=W-L-R,ph=HT-T-B;var ub=(h.ub||[]).slice().sort(function(a,b){return b[0]-a[0]}),ua=(h.ua||[]).slice().sort(function(a,b){return a[0]-b[0]});if(!ub.length&&!ua.length)return '<div class="depth mut">no book yet</div>';var bb=ub.length?ub[0][0]:null,ba=ua.length?ua[0][0]:null;var bid=new Array(101).fill(0),ask=new Array(101).fill(0);var c=0,i=0;for(var p=100;p>=1;p--){while(i<ub.length&&Math.round(ub[i][0]*100)>=p){c+=ub[i][0]*ub[i][1];i++}bid[p]=bb!=null&&p<=Math.round(bb*100)?c:0}c=0;i=0;for(p=1;p<=100;p++){while(i<ua.length&&Math.round(ua[i][0]*100)<=p){c+=ua[i][0]*ua[i][1];i++}ask[p]=ba!=null&&p>=Math.round(ba*100)?c:0};var top=Math.max.apply(null,bid.concat(ask).concat([1]));var bw=pw/100,Y=function(v){return T+(1-v/top)*ph};var g="";for(p=1;p<=100;p++){var v=bid[p]||ask[p];if(!v)continue;var x=L+(p-1)*bw;g+='<rect x="'+x.toFixed(1)+'" y="'+Y(v).toFixed(1)+'" width="'+(bw-0.8).toFixed(1)+'" height="'+(T+ph-Y(v)).toFixed(1)+'" fill="'+(bid[p]?"#9be36d":"#4da3ff")+'" opacity="'+(p===Math.round((bid[p]?bb:ba)*100)?"1":".82")+'"/>'}if(bb!=null&&ba!=null){var mx=L+((bb+ba)/2*100-0.5)*bw+bw/2;g+='<line x1="'+mx.toFixed(1)+'" x2="'+mx.toFixed(1)+'" y1="'+T+'" y2="'+(T+ph)+'" stroke="#8a93a6" stroke-dasharray="2 3"/>'}[0,10,20,30,40,50,60,70,80,90,100].forEach(function(t){var x=L+t*bw;g+='<text class="gt" x="'+x.toFixed(1)+'" y="'+(HT-3)+'" text-anchor="'+(t===0?"start":t===100?"end":"middle")+'">'+t+'</text>'});var tot=function(a){return "$"+Math.round(Math.max.apply(null,a))};return '<div class="depth"><div class="t"><span class="mut">Spread: '+(bb!=null&&ba!=null?cents(Math.max(0,ba-bb)):"—")+'</span><span><span style="color:#9be36d">Bid: '+(bb!=null?cents(bb):"—")+'</span> <span class="mut">|</span> <span style="color:#4da3ff">Ask: '+(ba!=null?cents(ba):"—")+'</span></span><span class="mut">'+tot(bid)+' bid · '+tot(ask)+' offered</span></div><svg viewBox="0 0 '+W+' '+HT+'">'+g+'</svg></div>'}
function drawCharts(){var bb=el("bets");if(bb)document.querySelectorAll(".chart .bet").forEach(function(b){bb.appendChild(b)});var KEYS=Object.keys(H);var BIG=TAB!=="overview"&&KEYS.length>=4;
el("charts").innerHTML=KEYS.map(function(k,ki){var h=H[k];var big=BIG&&ki===0;var W=big?560:220,HT=big?185:92,L=40,R=6,T=6,B=14,pw=W-L-R,ph=HT-T-B;var open=h.open;var ps=h.pts.map(function(p){return p.p});var vals=ps.concat(open==null?[]:[open]);
var lo=vals.length?Math.min.apply(null,vals):0,hi=vals.length?Math.max.apply(null,vals):1;var ref=open!=null?open:(lo+hi)/2;var span=Math.max(hi-lo,ref*0.0003);var pad=span*0.2;lo=Math.min(lo,ref-span/2)-pad;hi=Math.max(hi,ref+span/2)+pad;
var X=function(x){return L+x*pw},Y=function(p){return T+(1-(p-lo)/(hi-lo))*ph};var bp=function(p){if(open==null)return "";var v=(p-open)/open*1e4;return (v<0?"\u2212":"+")+Math.abs(v).toFixed(1)};
var mins=h.sec/60,g="";for(var m=1;m<mins;m++){if(mins>5&&m%5)continue;g+='<line class="gl" x1="'+X(m/mins).toFixed(1)+'" x2="'+X(m/mins).toFixed(1)+'" y1="'+T+'" y2="'+(T+ph)+'"/>'}
for(var m=0;m<=mins;m+=(mins>5?5:1)){g+='<text class="gt" x="'+X(m/mins).toFixed(1)+'" y="'+(HT-3)+'" text-anchor="'+(m===0?"start":m===mins?"end":"middle")+'">'+m+'m</text>'}
[0.25,0.5,0.75].forEach(function(f){var y=T+f*ph;g+='<line class="gl" x1="'+L+'" x2="'+(L+pw)+'" y1="'+y.toFixed(1)+'" y2="'+y.toFixed(1)+'" stroke-dasharray="2 3"/>'});
g+='<text class="gt" x="'+(L-3)+'" y="'+(T+7)+'" text-anchor="end">'+(open==null?"":bp(hi)+"bp")+'</text><text class="gt" x="'+(L-3)+'" y="'+(T+ph)+'" text-anchor="end">'+(open==null?"":bp(lo)+"bp")+'</text>';
if(open!=null)g+='<line x1="'+L+'" x2="'+(L+pw)+'" y1="'+Y(open).toFixed(1)+'" y2="'+Y(open).toFixed(1)+'" stroke="#7b8294" stroke-dasharray="4 3" stroke-width="1"/><text class="gt" x="'+(L-3)+'" y="'+(Y(open)+3).toFixed(1)+'" text-anchor="end">open</text>';
var last=ps.length?ps[ps.length-1]:null;var col=open==null||last==null?"#7b8294":last>=open?"#3ddc84":"#ff6b6b";
if(h.pts.length>1){var d=h.pts.map(function(p,i){return (i?"L":"M")+X(p.x).toFixed(1)+","+Y(p.p).toFixed(1)}).join(" ");var lp=h.pts[h.pts.length-1];
g+='<path d="'+d+'" fill="none" stroke="'+col+'" stroke-width="1.5"/><circle cx="'+X(lp.x).toFixed(1)+'" cy="'+Y(lp.p).toFixed(1)+'" r="2" fill="'+col+'"/>'}
var lf=h.left!=null?Math.floor(h.left/60)+":"+String(h.left%60).padStart(2,"0"):"—";var dl=(last!=null&&open!=null)?bp(last)+" bp":"";
var mv10=null;if(open!=null&&h.pts.length>1){var lpt=h.pts[h.pts.length-1];var tcut=lpt.x*h.sec-10;var refp=null;for(var i=h.pts.length-1;i>=0;i--){if(h.pts[i].x*h.sec<=tcut){refp=h.pts[i];break}}if(refp)mv10=(lpt.p-refp.p)/open*1e4}
var sig=mv10!=null&&mv10>=5&&h.up!=null&&h.up<=0.2&&h.left!=null&&h.left>=120;
var mvs=mv10==null?'':'<span class="mv '+(mv10>=5?"ok":mv10<=-5?"bad":"mut")+'" title="price move over the last 10 s, in bps">10s '+(mv10<0?"\u2212":"+")+Math.abs(mv10).toFixed(1)+'</span>';
var lean=(h.up!=null&&h.down!=null)?(h.up>h.down?'<span class="lean ok">UP '+cents(h.up)+'</span>':'<span class="lean bad">DOWN '+cents(h.down)+'</span>'):'<span class="mut">—</span>';
var dc=DECIDED[k];var won=dc&&Date.now()<dc.until?dc:null;
var ag=won?' style="animation-delay:-'+((Date.now()-won.at)/1000).toFixed(2)+'s"':"";
return '<div class="chart'+(won?" won "+(won.side==="UP"?"up":"down"):"")+(sig?" sig":"")+'"'+ag+'>'+(sig?'<div class="sigtag" title="bounce signal: UP at 20c or less, price up 5+ bps in the last 10 s, 2+ min left (the jump5-up20 paper rule)">bounce · UP '+cents(h.up)+'</div>':'')+(won?'<div class="stamp"'+ag+'><b>'+won.side+'</b><span>closed '+won.bp+' bp</span></div>':'')+'<div class="t"><span>'+coin(h.label)+'<b>'+h.label+'</b></span><span class="mut">closes in '+lf+'</span></div><div class="px"><b>'+money(h.last)+'</b><span class="'+(col==="#3ddc84"?"ok":col==="#ff6b6b"?"bad":"mut")+'">'+dl+'</span>'+mvs+'</div><svg viewBox="0 0 '+W+' '+HT+'">'+g+'</svg><div class="t"><span><span class="ok">UP '+cents(h.up)+'</span> <span class="bad">DOWN '+cents(h.down)+'</span></span>'+lean+'</div>'+(big?depthSvg(h):'')+'<div class="bslot" data-k="'+k+'"></div></div>'}).join("");placeBets()}
var BETKEY="";var minFor=function(a){return a==null||!(a>0)||a>=1?null:Math.max(1,Math.ceil(5*a*100)/100)};
function drawBets(){var bb=el("bets");if(!bb)return;var keys=Object.keys(H);var key=keys.join("|");if(key!==BETKEY){BETKEY=key;bb.innerHTML=keys.map(function(k){return '<div class="bet" data-k="'+k+'"><div class="brow"><span class="cur">$</span><input type="number" min="1" max="100" step="1" value="5" inputmode="decimal" title="amount in $"><button class="btn bup" data-side="UP">UP</button><button class="btn bdown" data-side="DOWN">DOWN</button></div><div class="bmin mut"></div></div>'}).join("");placeBets()}
keys.forEach(function(k){var h=H[k];var d=document.querySelector('.bet[data-k="'+k+'"]');if(!d)return;var amt=Number(d.querySelector("input").value);var ask={UP:h.up,DOWN:h.down};var open=h.left!=null&&h.left>3;d.querySelectorAll("button").forEach(function(b){var a=ask[b.dataset.side],m=minFor(a);var ok=open&&m!=null&&amt>=m&&amt<=100&&!BETBUSY;b.disabled=!ok;b.textContent=b.dataset.side+" "+(a==null?"—":cents(a));b.title=!open?"window closing":m==null?"no ask right now":amt<m?"minimum $"+m.toFixed(2)+" (5 shares at "+cents(a)+")":amt>100?"max $100 a click":"buy "+b.dataset.side+" for $"+amt+" with real money"});var mu=minFor(h.up),md=minFor(h.down);d.querySelector(".bmin").textContent="manual · min "+(mu!=null?"$"+mu.toFixed(2):"—")+" up / "+(md!=null?"$"+md.toFixed(2):"—")+" down (5 shares)"})}
var BETBUSY=false;
document.addEventListener("input",function(e){if(e.target&&e.target.closest&&e.target.closest(".bet"))drawBets()});
document.addEventListener("click",async function(e){var b=e.target&&e.target.closest&&e.target.closest(".bet button");if(!b||b.disabled)return;var d=b.closest(".bet");var k=d.dataset.k;var h=H[k];if(!h)return;var side=b.dataset.side;var amt=Number(d.querySelector("input").value);var a=side==="UP"?h.up:h.down;var m=minFor(a);if(m==null||amt<m){alert("Minimum is $"+(m!=null?m.toFixed(2):"?")+" (Polymarket fills at least 5 shares)");return}
if(!confirm("REAL MONEY\\n\\nBuy "+side+" on "+h.label+" for $"+amt+"\\nask now "+cents(a)+", pays up to "+cents(Math.min(0.99,a+0.05))+" · window closes in "+Math.floor(h.left/60)+":"+String(h.left%60).padStart(2,"0")+"\\n\\nTracked as the 'manual' strategy."))return;
BETBUSY=true;drawBets();d.classList.add("busy");try{var r=await fetch("/api/manual",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({series:k==="btc5m"?"":k,side:side,amount:amt})});var j=await r.json();d.classList.remove("busy");if(!r.ok){d.classList.add("fail");setTimeout(function(){d.classList.remove("fail")},1500);alert("Not placed: "+(j.error||"failed"))}else{var t=j.trade||{};d.classList.add("done");setTimeout(function(){d.classList.remove("done")},1500);if(t.dry)alert("Dry mode: order signed, not sent.")}}catch(err){d.classList.remove("busy");alert("Not placed: "+err)}BETBUSY=false;poll()});
${EV_JS}
showTab(TAB);showSec(SEC);poll();setInterval(poll,1000);evPoll(true);
</script></body></html>`;
