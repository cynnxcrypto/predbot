import { createServer } from "node:http";
import { STATUS_PORT } from "./config.js";
import type { Recorder } from "./recorder.js";
import { LOGOS } from "./logos.js";
import { VARIANTS, discarded, setDiscarded } from "./paperlive.js";
import { addLiveRule, liveConfig, MIN_SIZE, removeLiveRule, setLiveMaxLoss, setLiveRuleSize, setLiveRuleHalt } from "./live.js";

/**
 * A one-page status view on 127.0.0.1 so you can see the recorder is alive without reading logs.
 * Resolves once the port is bound; rejects (with code EADDRINUSE) when another copy holds it.
 */
export function serveStatus(recorder: Recorder, build: string, others: Recorder[] = []) {
  const server = createServer((req, res) => {
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
    if (req.url === "/api/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ build, ...recorder.status(), series: others.map((r) => r.status()) }));
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
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Pred bot</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{--bg:#0f1117;--panel:#151922;--line:#232838;--fg:#e8eaf0;--mut:#7b8294;--up:#3ddc84;--down:#ff6b6b;--acc:#f7931a;--pur:#9b7bff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
main{max-width:2400px;margin:0 auto;padding:28px 28px 60px}
.top{display:flex;align-items:center;gap:14px;margin-bottom:12px;flex-wrap:wrap}.tabs{display:flex;gap:4px;margin:0 0 16px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:10px}.tabs .tb{font:inherit;font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:6px 14px;border-radius:999px;border:1px solid transparent;background:none;color:var(--mut);cursor:pointer}.tabs .tb:hover{color:var(--fg)}.tabs .tb.on{color:var(--fg);border-color:var(--fg)}.tabs .tb .n{margin-left:6px;font-size:10px;color:var(--mut);letter-spacing:0}.hide{display:none!important}.ov td.r b{font-weight:600}.ov .mut.sm{font-size:11px}.emptytab{padding:28px 0;color:var(--mut);font-size:13px;line-height:1.7}
h1{font-size:20px;margin:0;font-weight:700;letter-spacing:.2px}
.pill{font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:4px 10px;border-radius:999px;border:1px solid var(--line);color:var(--mut)}
.pill.live{color:#0f1117;background:var(--up);border-color:var(--up);font-weight:700}
.pill.dry{color:var(--acc);border-color:var(--acc)}
.tag{font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding:2px 8px;border-radius:999px;margin-left:8px;vertical-align:middle}
.tag.real{color:#0f1117;background:var(--up)}
.wps{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}.wp{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--mut);white-space:nowrap}.wp b{color:var(--fg);font-weight:600}.wp a{color:var(--fg);text-decoration:none;border-bottom:1px dotted var(--mut)}.wp .d{width:6px;height:6px;border-radius:50%;background:var(--mut)}.wp.ok .d{background:var(--up)}.wp.bad{border-color:var(--down)}.wp.bad .d{background:var(--down)}
.tag.paper{color:var(--pur);border:1px solid var(--pur)}
.panel.real{border-color:var(--up);overflow-x:hidden}.rules td{white-space:nowrap}.rules td:first-child{max-width:190px;overflow:hidden;text-overflow:ellipsis}.rules th,.rules td{padding-left:5px;padding-right:5px}.rules td.acts{white-space:nowrap}.rules .acts .btn{margin-left:2px}.st{font-style:normal;margin-left:6px;font-size:11px;vertical-align:middle}.st.bad{color:var(--down)}.st.mut{color:var(--mut)}.st.warn{color:var(--acc,#ffb347)}.nf{color:var(--mut);font-size:10px;margin-left:5px;vertical-align:middle}.pop{position:absolute;z-index:6;background:var(--panel,#151922);border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-size:12px;min-width:210px;box-shadow:0 6px 20px rgba(0,0,0,.4)}.pop .ph{font-weight:600;margin-bottom:4px}.pop div:not(.ph):not(.sub){display:flex;justify-content:space-between;gap:16px;padding:3px 0}.pop div span:first-child{color:var(--mut)}.pop .sub{color:var(--mut);font-size:10px;margin:-2px 0 2px}.pop .sz .pen{opacity:1}
.sub{color:var(--mut);font-size:12px;margin-left:auto}
.grid{display:grid;grid-template-columns:1fr;gap:14px;margin-bottom:14px}
@media(min-width:1400px){.grid{grid-template-columns:1fr 1fr}.panel.logp{display:flex;flex-direction:column;overflow:hidden}.logwrap{flex:1;min-height:0;position:relative}.logwrap>div{position:absolute;inset:0;overflow:hidden}}
td,th{white-space:nowrap}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;overflow-x:auto}
.hero{display:flex;align-items:center;gap:28px;flex-wrap:wrap}
.clock{font-size:64px;font-weight:700;line-height:1;letter-spacing:-1px}
.clock.soon{color:var(--acc)}
.clock.small{font-size:40px;color:var(--mut)}
.clock.small.soon{color:var(--acc)}
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
.ph .k{margin:0}
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
td.pc .ldot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--up);box-shadow:0 0 5px var(--up);margin-left:5px;vertical-align:1px}
#lab td:first-child b{font-size:12px}#lab .tag.new{font-size:8px;padding:1px 5px;margin-left:5px}
.charts{display:grid;flex-basis:100%;width:100%;grid-template-columns:repeat(auto-fill,minmax(max(230px,calc(20% - 8px)),1fr));gap:10px;margin-top:16px}
.charts:empty{display:none}
@media(max-width:1200px){.charts{grid-template-columns:repeat(3,1fr)}}
@media(max-width:700px){.charts{grid-template-columns:repeat(2,1fr)}}
.chart{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 8px 4px}
.chart .t{display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px;white-space:nowrap}
.chart .t b{font-weight:600}
.chart svg{width:100%;display:block}
.chart .gl{stroke:var(--line);stroke-width:1}
.chart .gt{font-size:9px;fill:var(--mut);font-family:inherit}
.coin.img{background:none;object-fit:contain}.coin.img+.coin{display:none}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:1px;background:transparent}.dot.on{background:var(--up);box-shadow:0 0 6px var(--up);animation:pulse 1.6s ease-in-out infinite}
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
</style></head><body><main>
<div class="top"><h1>Pred bot</h1><span class="pill" id="mode">off</span><span class="pill" id="listed">—</span><span class="sub" id="sub">loading</span></div>
<div class="tabs" id="tabs"><button class="tb" data-t="overview">overview</button><button class="tb" data-t="5m">5 min<span class="n" id="n5m"></span></button><button class="tb" data-t="15m">15 min<span class="n" id="n15m"></span></button><button class="tb" data-t="1h">1 hour<span class="n" id="n1h"></span></button><button class="tb" data-t="4h">4 hours<span class="n" id="n4h"></span></button><button class="tb" data-t="24h">24 hours<span class="n" id="n24h"></span></button></div>

<div class="panel" style="margin-bottom:14px" data-tabs="overview 5m 15m 1h 4h 24h"><div class="hero">
  <div id="ck5"><div class="k" id="wlabel">5-min window</div><div class="clock" id="clock">–:––</div></div>
  <div id="ck15"><div class="k" id="wlabel15">15-min window</div><div class="clock small" id="clock15">–:––</div></div>
  <div class="stats" id="hstats"></div>
  <div id="quota"></div>
  <div class="charts" id="charts"></div>
  <div class="charts bets" id="bets"></div>
</div></div>

<div class="panel" style="margin-bottom:14px" data-tabs="overview"><div class="ph"><div class="k">by window length</div><div class="mut">real money per window length · best paper rule on those markets at $5 a trade</div></div>
<table class="ov"><thead><tr><th>window</th><th class="r">markets</th><th class="r">real rules on</th><th class="r">today</th><th class="r">all time</th><th class="r">trades</th><th class="r">won</th><th>best paper rule</th></tr></thead><tbody id="ov"></tbody></table></div>

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
      <div><div class="k">won</div><div class="v big" id="lwon">—</div></div>
    </div>
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

<div class="panel" style="margin-bottom:14px" data-tabs="overview 5m 15m 1h 4h 24h"><div class="ph"><div class="k">real money, day by day <span class="tag real">real</span></div><div class="mut">Korean days</div></div>
<table><thead><tr><th>day</th><th class="r">trades</th><th class="r">won</th><th class="r">net</th><th>by market</th></tr></thead><tbody id="cmp"></tbody></table></div>

<div class="panel" style="margin-bottom:14px" data-tabs="overview 5m 15m 1h 4h 24h"><div class="ph"><div class="k">paper lab <span class="tag paper">paper · simulated, no money</span></div><div class="mut">every rule on every market at $5 a trade; cells on real money are shown at their real bet size (@$), best first · net <span class="mut">won/trades</span></div></div>
<table id="labtable"><thead id="labhead"></thead><tbody id="lab"></tbody></table><div class="note">Discard stops a rule simulating on every market; it can be restored from the bottom of the list. A rule trading real money cannot be discarded until it is taken out of data/live.json.</div></div>

<div class="grid" data-tabs="overview 5m 15m 1h 4h 24h">
  <div class="panel"><div class="ph"><div class="k">feeds</div></div>
  <table><thead><tr><th>coin</th><th>chainlink</th><th>binance</th><th>coinbase</th><th title="Binance USDT perpetual, for the basis rules">perp</th></tr></thead><tbody id="feeds"></tbody></table></div>
  <div class="panel"><div class="ph"><div class="k">recorder</div></div>
  <div class="stats"><div><div class="k">windows</div><div class="v" id="wd">—</div></div><div><div class="k">settled</div><div class="v" id="ws">—</div></div><div><div class="k">waiting</div><div class="v" id="wp">—</div></div><div><div class="k">snapshots</div><div class="v" id="sn">—</div></div></div>
  <div class="note" id="err"></div></div>
</div>
<div class="note" id="note"></div>
</main><script>
var el=function(id){return document.getElementById(id)};
var money=function(n){return n==null?"—":"$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})};
var signed=function(n){return n==null?"—":(n<0?"-":"+")+"$"+Math.abs(n).toFixed(2)};
var cents=function(n){return n==null?"—":Math.round(n*100)+"¢"};
var COINS={btc:"\u20bf",eth:"\u039e",sol:"\u25ce",xrp:"\u2715",doge:"D",bnb:"B",hype:"H"};
var coin=function(label){var k=String(label||"").split(" ")[0].toLowerCase();if(!COINS[k])return "";
return '<img class="coin img" alt="'+k.toUpperCase()+'" title="'+k.toUpperCase()+'" src="/logo/'+k+'.png" onerror="this.remove()"><span class="coin '+k+'" title="'+k.toUpperCase()+'">'+COINS[k]+"</span>"};
var hhmm=function(sec){return new Date(sec*1000).toLocaleTimeString("en-GB",{timeZone:"Asia/Seoul",hour:"2-digit",minute:"2-digit"})};
function cls(n){return n==null?"":n<0?"bad":n>0?"ok":""}
var seen={},LABHTML="";
var WINS=["5m","15m","1h","4h","24h"];var WOF=function(lb){var m=/(\\d+)\\s?(m|h|d)\\b/.exec(String(lb||"BTC 5m"));if(!m)return "5m";return m[2]==="d"?"24h":m[1]+m[2]};
var TAB=(function(){try{var t=localStorage.getItem("wtab");return t==="overview"||WINS.indexOf(t)>=0?t:"overview"}catch(e){return "overview"}})();
var NMARK={};function showTab(t){TAB=t;try{localStorage.setItem("wtab",t)}catch(e){}var bs=document.querySelectorAll("#tabs .tb");for(var i=0;i<bs.length;i++)bs[i].classList.toggle("on",bs[i].getAttribute("data-t")===t);var empty=t!=="overview"&&!NMARK[t];var ps=document.querySelectorAll("[data-tabs]");for(var j=0;j<ps.length;j++){var p=ps[j];if(p.id==="emptytab")p.classList.toggle("hide",!empty);else p.classList.toggle("hide",empty||p.getAttribute("data-tabs").split(" ").indexOf(t)<0)}LABHTML="";WKEY="";el("emptytab").innerHTML=empty?'<b>'+t+' windows are not recorded yet.</b><br>Polymarket runs '+t+' Up/Down markets on BTC, ETH, SOL, XRP, DOGE, BNB and HYPE. Nothing here until the recorder follows them; ask in the thread to add them (paper only, no real money).':""}
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
async function poll(){try{var s=await (await fetch("/api/status")).json();var prevV=snapV();
var b=s.lastBook||{};var L=s.live||{mode:"off"};
var hasRules=function(l){return !!l&&l.mode!=="off"&&(((l.variants&&l.variants.length)?l.variants:(l.variant?[l]:[])).length>0)};var hasHistory=function(l){return !!l&&((l.trades||0)>0||(l.days||[]).length>0||(l.open||0)>0)};var OL=(s.series||[]).map(function(r){return r.live}).filter(function(l){return hasRules(l)||hasHistory(l)});
var RS={};RS[L.label||"BTC 5m"]=s;(s.series||[]).forEach(function(r){RS[r.label]=r});var ALL=[L].concat(OL);var sum=function(k){return ALL.reduce(function(a,l){return a+(l[k]||0)},0)};var inTab=function(lb){return TAB==="overview"||WOF(lb||"BTC 5m")===TAB};var ALLV=ALL.filter(function(l){return inTab(l.label||"BTC 5m")});var sumV=function(k){return ALLV.reduce(function(a,l){return a+(l[k]||0)},0)};var NM={};[s].concat(s.series||[]).forEach(function(r){var w=WOF(r.label||"BTC 5m");NM[w]=(NM[w]||0)+1});var tabsChanged=JSON.stringify(NM)!==JSON.stringify(NMARK);NMARK=NM;WINS.forEach(function(w){var e=el("n"+w);if(e)e.textContent=NM[w]?String(NM[w]):""});if(tabsChanged)showTab(TAB);el("ck5").style.display=TAB==="overview"||TAB==="5m"?"":"none";el("ck15").style.display=TAB==="overview"||TAB==="15m"?"":"none";
var left=s.window?Math.max(0,s.window+300-Math.floor(Date.now()/1000)):0;
el("clock").textContent=String(Math.floor(left/60))+":"+String(left%60).padStart(2,"0");
el("clock").className="clock"+(left<=30?" soon":"");
el("wlabel").textContent="5-min window "+(s.window?hhmm(s.window)+" kst":"—")+" · closes in";
var r15=(s.series||[]).filter(function(r){return /15m/.test(r.label)&&r.window})[0];var left15=r15?Math.max(0,r15.window+900-Math.floor(Date.now()/1000)):0;
el("clock15").textContent=r15?String(Math.floor(left15/60))+":"+String(left15%60).padStart(2,"0"):"–:––";
el("clock15").className="clock small"+(r15&&left15<=30?" soon":"");
el("wlabel15").textContent="15-min window "+(r15?hhmm(r15.window)+" kst":"—")+" · closes in";
el("mode").textContent=L.mode==="live"?"live · real money":L.mode==="dry"?"dry run":"paper only";
el("mode").className="pill "+(L.mode==="live"?"live":L.mode==="dry"?"dry":"");
el("listed").textContent=s.listed?"market listed":"not listed yet";
el("sub").textContent="build "+s.build+" · book "+(s.bookFeed&&s.bookFeed.connected?"streaming":"polling")+(s.lastError?" · error: "+s.lastError:"");
el("hstats").innerHTML=(function(){var n=0,open=0;ALLV.forEach(function(l){(l.recent||[]).forEach(function(t){if(t.pnl==null&&t.ok&&!t.dry&&t.shares>0){n++;open+=t.cost||0}})});var live=ALL.filter(function(l){return hasRules(l)}).length;var live=ALLV.filter(function(l){return hasRules(l)}).length;return '<div><div class="k">markets</div><div class="v big">'+[s].concat(s.series||[]).filter(function(r){return inTab(r.label||"BTC 5m")}).length+'</div></div><div><div class="k">real on</div><div class="v big">'+live+'</div></div><div><div class="k">open trades</div><div class="v big">'+n+(n?' <span class="mut" style="font-size:14px;font-weight:400">'+money(open)+'</span>':"")+'</div></div>'})();
var realOn=function(l){if(!l||l.mode==="off")return false;var vs=(l.variants&&l.variants.length)?l.variants:(l.variant?[{variant:l.variant}]:[]);return vs.some(function(v){return !v.paused&&!v.halted})};(function(){var C=L.claims||{};var PER_BATCH=C.perBatch||12,QUOTA=C.quota||65,RESERVE=10;var PAP={"BTC 5m":s.papers||[]};(s.series||[]).forEach(function(r){PAP[r.label]=r.papers||[]});var kst=Date.now()+9*3600000,today=new Date(kst).toISOString().slice(0,10),midnight=Date.now()-kst%86400000;var perDay=function(p){if(!p)return 0;var d=p.days||[];var full=d.filter(function(x){return x.day!==today&&x.trades>0});if(full.length)return full.reduce(function(a,x){return a+x.won},0)/full.length;var t=d.filter(function(x){return x.day===today})[0];if(!t)return 0;var hrs=Math.max(1,(Date.now()-Math.max(midnight,(t.first||0)*1000))/3600000);return t.won*24/hrs};var COL={btc:"#f7931a",eth:"#8c8cff",sol:"#9945ff",xrp:"#9aa4b2",doge:"#c2a633",bnb:"#f0b90b",hype:"#50e3c2"};var parts=[],tot=0;ALL.forEach(function(l){if(!realOn(l))return;var lb=l.label||"BTC 5m";var per=Math.round(86400/((RS[lb]||{}).windowSec||(/15m/.test(lb)?900:300)));var best=0;((l.variants&&l.variants.length)?l.variants:(l.variant?[{variant:l.variant}]:[])).forEach(function(v){if(v.paused||v.halted)return;best=Math.max(best,perDay((PAP[lb]||[]).filter(function(x){return x.name===v.variant})[0]))});var w=Math.min(per,Math.round(best));tot+=w;parts.push({label:lb,w:w,col:COL[lb.split(" ")[0].toLowerCase()]||"#888",light:/15m/.test(lb)})});
var hoursLeft=(86400000-Date.now()%86400000)/3600000;var resetKst=hhmm(Math.floor((Date.now()+hoursLeft*3600000)/1000));var used=C.usedToday||0;var perHour=tot>0?Math.ceil(tot/24/PER_BATCH):0;var ahead=Math.round(perHour*hoursLeft);var spare=Math.max(1,Math.round(RESERVE*hoursLeft/24));parts.forEach(function(q){q.tx=tot>0?ahead*q.w/tot:0});var total=used+ahead+spare;var blocked=!!C.blockedUntil;var over=blocked||total>QUOTA;var scale=Math.max(QUOTA,total);var fullDay=tot>0?Math.ceil(tot/PER_BATCH)+RESERVE:0;var lastsH=tot>0&&perHour>0?(QUOTA-used-spare)/perHour:null;
var tag=blocked?"used up · resets "+resetKst+" KST":over?"over by "+(total-QUOTA)+" · runs out ~"+(lastsH!=null&&lastsH>0?hhmm(Math.floor((Date.now()+lastsH*3600000)/1000))+" KST":"now"):"fits · resets "+resetKst+" KST";
var html='<div class="qhead"><span class="lbl">claim quota</span><b class="'+(over?"bad":"ok")+'">'+(blocked?QUOTA:total)+'</b><span class="mut"> / '+QUOTA+' transactions by reset</span><span class="mut qsub">'+used+' used · +'+ahead+' ahead · '+spare+' spare</span><span class="qtag '+(over?"bad":"ok")+'">'+tag+'</span></div><div class="qbar'+(over?" over":"")+'">'+(blocked?'<span class="seg used" style="width:100%" title="quota used up"></span>':'<span class="seg used" style="width:'+(100*used/scale)+'%" title="'+used+' sent since 09:00 KST"></span>'+parts.map(function(q){return '<span class="seg" style="width:'+(100*q.tx/scale)+'%;background:'+q.col+(q.light?";opacity:.55":"")+'" title="'+esc(q.label)+': ~'+q.w+' won windows a day, ~'+Math.round(q.tx)+' more transactions before the reset"></span>'}).join("")+'<span class="seg spare" style="width:'+(100*spare/scale)+'%" title="'+spare+' spare for wraps, swaps and retries"></span>')+(over?'':'<span class="cap" style="left:'+(100*QUOTA/scale)+'%"></span>')+'</div><div class="qleg"><span><i class="us"></i>used <b>'+used+'</b></span>'+parts.map(function(q){return '<span><i style="background:'+q.col+(q.light?";opacity:.55":"")+'"></i>'+esc(q.label)+' <b>~'+q.w+'</b>/day</span>'}).join("")+'<span><i class="sp"></i>spare <b>'+spare+'</b></span><span class="mut">full day with these rules: <b>'+fullDay+'</b></span></div>';
el("quota").innerHTML=!parts.length&&!used?'<div class="qhead"><span class="lbl">claim quota</span><span class="mut">no real rules on</span></div>':html;el("quota").title="Polymarket's gasless relayer allows ~"+QUOTA+" transactions a day per wallet, reset at 09:00 KST. Used = transactions the bot has sent since the reset. Ahead = what the rules now on should need until the reset: every won window of a market is redeemed once, "+PER_BATCH+" windows per transaction, several rules on one window count once; estimated from each market's broadest rule and its paper wins per full day."})();H={};var chartOk=function(lb,l){return TAB==="overview"?realOn(l):inTab(lb)};if(chartOk("BTC 5m",L))feedChart("btc5m","BTC 5m",300,s);(s.series||[]).forEach(function(r){if(chartOk(r.label,r.live))feedChart(r.key||r.label,r.label,r.windowSec||(/15m/.test(r.label)?900:300),r)});drawCharts();drawBets();
el("lrule").textContent=ALLV.filter(function(l){return l.mode!=="off"}).length+" live";
el("ledger").textContent=(L.startBalance!=null&&L.balance!=null)?(function(){var ch=L.chain||{};var wallet=(ch.pUSD!=null?ch.pUSD:L.balance)+(ch["USDC.e"]||0);var open=0,stake=0,exp=0,claim=0;ALL.forEach(function(l){claim+=l.toClaim||0;var rr=RS[l.label||"BTC 5m"]||{};var rb=rr.lastBook||{};(l.recent||[]).forEach(function(t){if(t.pnl==null&&t.ok&&!t.dry&&t.shares>0){open+=(t.cost||0)+feeOf(t);stake+=t.cost||0;var p=null;if(t.window===rr.window){var a=t.side==="UP"?rb.upAsk:rb.downAsk;p=a!=null?a:t.cost/t.shares}else{var pl=rr.pendingLean?rr.pendingLean[t.window]:null;p=pl==null||pl===0?t.cost/t.shares:((pl>0)===(t.side==="UP")?1:0)}exp+=t.shares*p}})});el("claim").textContent=money(claim+exp);el("esttot").textContent=money(wallet+claim+exp);el("esttot").title=money(wallet)+" in the wallet + "+money(claim)+" won and waiting for payout + "+money(exp)+" expected from open trades";el("claim").title=money(claim)+" won and waiting for payout + "+money(exp)+" expected from "+money(stake)+" in open trades";var hidNet=0,hidOpen=0;ALL.forEach(function(l){if(l.hidden){hidNet+=l.hidden.net||0;hidOpen+=l.hidden.open||0}});open+=hidOpen;exp+=hidOpen;
var dep=L.deposits||0;var expWallet=L.startBalance+dep+sum("net")+hidNet-open-claim;var gap=wallet-expWallet;
return (ch.USDC>0.5?money(ch.USDC)+" native USDC not yet converted":"")})():"";el("claim").textContent=el("claim").textContent==="—"?"—":el("claim").textContent;
el("netk").textContent=L.statsSince?"since start":"all time";var hidT=0,hidN=0;ALL.forEach(function(l){if(l.hidden){hidT+=l.hidden.trades||0;hidN+=l.hidden.net||0}});el("lsince").textContent="";
swap("lrules",ALLV.filter(function(l){return hasRules(l)}).map(function(l){var vs=(l.variants&&l.variants.length)?l.variants:[{variant:l.variant,size:l.size,trades:l.trades,won:l.won,net:l.net,halted:false,streak:0,haltAfterLosses:0}];var st=function(v){return v.halted?2:v.paused?1:0};vs=vs.slice().sort(function(a,b){return st(a)-st(b)});var lb=l.label||"BTC 5m";var sk=l.series||"";var nr=vs.filter(function(v){return !v.manual}).length;var head='<tr class="grp" data-k="'+esc("g|"+lb)+'"><td colspan="9"><span>'+coin(lb)+'<b>'+lb+'</b></span><span class="gs">today <b class="'+cls(l.todayNet)+'">'+signed(l.todayNet)+'</b> · <button class="sz" title="default daily loss stop for each rule on this market ($5 to $500); every rule stops on its own" onclick="editMaxLoss(\\''+sk+'\\','+l.maxLossPerDay+')">each rule −$'+l.maxLossPerDay+'/day<span class="pen">&#9998;</span></button> · '+nr+' rule'+(nr===1?'':'s')+'</span></td></tr>';return head+vs.map(function(v){var pct=function(x){return x.trades?(x.won/x.trades*100).toFixed(1)+"%":"—"};var d=v.today||{trades:0,won:0,net:0};var q=function(x){return "\\'"+String(x).replace(/'/g,"\\\\'")+"\\'"};var name='<td><b>'+esc(v.variant)+'</b>'+(l.mode==="dry"?'<i class="st mut" title="dry run: orders are simulated">dry</i>':'')+(v.halted?'<i class="st bad" title="halted after '+v.haltAfterLosses+' straight losses'+(v.haltedAt?' at '+hhmm(v.haltedAt/1000)+' KST':'')+'; press &#9654; to resume">&#10006;</i>':'')+(v.paused?'<i class="st mut" title="paused; press &#9654; to resume">&#8214;</i>':'')+(v.stopped?'<i class="st warn" title="reached its −$'+(v.stopAt||v.maxLossPerDay)+' daily stop today; trades again at 00:00 KST or when you raise the stop">&#9632;</i>':'')+'</td>';var size='<td class="r">'+(v.manual?'<span class="mut" title="bets you place with the UP/DOWN buttons under the charts">by hand</span>':'<span title="'+esc(v.ladderNote?'size ladder '+(v.ladder||[]).map(function(x){return "$"+x}).join(" → ")+' · '+v.ladderNote:'bet size')+'">$'+v.size+(v.ladderNote?' <span class="mut">&#8599;</span>':'')+'</span>')+'</td>';var tdy='<td class="r tdy '+(d.trades?cls(d.net):"mut")+'">'+(d.trades?signed(d.net):"—")+'</td><td class="r tdy">'+(d.trades||"—")+(d.misses?'<span class="nf" title="'+d.misses+' order'+(d.misses===1?'':'s')+' today did not fill (nothing resting at the cap, or the ask fell)">&#9675;'+d.misses+'</span>':'')+'</td><td class="r tdy">'+pct(d)+'</td>';var all='<td class="r alt '+cls(v.net)+'">'+signed(v.net)+'</td><td class="r alt">'+v.trades+'</td><td class="r alt">'+pct(v)+'</td>';var off=v.paused||v.halted;var act='<td class="r acts">'+(v.manual?'':'<button class="btn icon" title="settings: bet size, halt, daily stop" onclick="ruleMenu(this,'+q(sk)+','+q(v.variant)+','+esc(q(JSON.stringify({size:v.size,ladder:v.ladder||null,halt:v.haltAfterLosses||0,stop:v.maxLossPerDay||0,note:v.ladderNote||""})))+')">&#9881;</button> <button class="btn'+(off?' restore':'')+' icon" title="'+(off?'resume':'pause')+'" onclick="pauseRule('+q(sk)+','+q(v.variant)+','+(off?'false':'true')+')">'+(off?'&#9654;':'&#10074;&#10074;')+'</button> <button class="btn icon paper" title="back to paper only" onclick="toPaper('+q(sk)+','+q(v.variant)+',this)">&#8617;</button>')+'</td>';return '<tr class="'+(off?"dim":"")+'" data-k="'+esc(lb+"|"+v.variant)+'">'+name+size+tdy+all+act+'</tr>'}).join("")}).join("")||'<tr><td class="empty" colspan="9">real orders are off</td></tr>');
el("bal").textContent=money(L.balance);drawWallet(L.history);
var tn=sumV("todayNet"),an=sumV("net"),tr=sumV("trades"),wn=sumV("won");
el("today").textContent=signed(tn);el("today").className="v big "+cls(tn);
el("net").textContent=signed(an);el("net").className="v big "+cls(an);
el("ltr").textContent=tr;
el("lwon").textContent=tr?(wn/tr*100).toFixed(1)+"%":"—";
var LD=L.days||[];var tot={o:0,s:0};ALL.forEach(function(l){(l.days||[]).forEach(function(d){tot.o+=d.orders;tot.s+=d.skipped})});

var byDay={};ALLV.forEach(function(l){(l.days||[]).forEach(function(d){var o=byDay[d.day]||(byDay[d.day]={filled:0,settled:0,won:0,net:0,mk:[]});o.filled+=d.filled;o.settled+=d.settled;o.won+=d.won;o.net+=d.net;if(d.settled)o.mk.push({lb:l.label||"BTC 5m",net:d.net,won:d.won,settled:d.settled})})});
var daysAll=Object.keys(byDay).sort().reverse().slice(0,14);
el("cmp").innerHTML=daysAll.length?daysAll.map(function(day){var o=byDay[day];var pct=o.settled?Math.round(100*o.won/o.settled):null;return '<tr><td>'+day+'</td><td class="r">'+o.settled+'</td><td class="r">'+(pct==null?"—":pct+"%")+'</td><td class="r '+cls(o.settled?o.net:null)+'"><b>'+(o.settled?signed(o.net):"—")+'</b></td><td><span class="wps">'+o.mk.map(function(m){return '<span class="wp" title="'+esc(m.lb)+': '+m.won+'/'+m.settled+' won">'+coin(m.lb)+esc(m.lb)+' <b class="'+cls(m.net)+'">'+signed(m.net)+'</b></span>'}).join("")+'</span></td></tr>'}).join(""):'<tr><td class="empty" colspan="5">nothing yet</td></tr>';
window.ruleMenu=function(btn,series,variant,json){var o=JSON.parse(json);var pop=el("pop");if(pop.dataset.k===series+"|"+variant&&pop.style.display==="block"){pop.style.display="none";return}var lad=o.ladder&&o.ladder.length>1?o.ladder.join(","):null;pop.innerHTML='<div class="ph">'+esc(variant)+'</div><div><span>bet size</span><button class="sz" onclick="closeMenu();editSize(\\''+series+'\\',\\''+variant+'\\',\\''+(lad||o.size)+'\\')">$'+o.size+(lad?' <span class="mut">&#8599; '+esc(lad)+'</span>':'')+'<span class="pen">&#9998;</span></button></div>'+(o.note?'<div class="sub">'+esc(o.note)+'</div>':'')+'<div><span>halt after</span><button class="sz" onclick="closeMenu();editHalt(\\''+series+'\\',\\''+variant+'\\','+o.halt+')">'+(o.halt?o.halt+' losses':'never')+'<span class="pen">&#9998;</span></button></div><div><span>daily stop</span><button class="sz" onclick="closeMenu();editMaxLoss(\\''+series+'\\','+o.stop+',\\''+variant+'\\')">−$'+o.stop+'/day<span class="pen">&#9998;</span></button></div>';pop.dataset.k=series+"|"+variant;var r=btn.getBoundingClientRect();pop.style.display="block";pop.style.top=(r.bottom+window.scrollY+4)+"px";pop.style.left=Math.max(8,r.right+window.scrollX-pop.offsetWidth)+"px"};
window.closeMenu=function(){el("pop").style.display="none"};
document.addEventListener("click",function(e){var pop=el("pop");if(pop.style.display==="block"&&!pop.contains(e.target)&&!(e.target.closest&&e.target.closest("button[title^=settings]")))closeMenu()});
function esc(x){return String(x).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function addr(a,label){if(!a)return label+" —";return label+' <a href="https://polygonscan.com/address/'+a+'" target="_blank" rel="noopener" title="'+a+'">'+a.slice(0,6)+"…"+a.slice(-4)+'</a>'}
el("lstate").innerHTML=(function(){var ps=[];var pill=function(c,h,t){return '<span class="wp '+c+'"'+(t?' title="'+esc(t)+'"':'')+'><span class="d"></span>'+h+'</span>'};if(L.mode==="off")ps.push(pill("bad","real orders <b>off</b>"));else if(L.ready)ps.push(pill("ok","wallet <b>ready</b>"));else ps.push(pill("bad","wallet <b>not ready</b>",L.lastError||""));if(L.ready&&L.lastError)ps.push(pill("bad","<b>"+esc(String(L.lastError).slice(0,40))+"</b>",L.lastError));ps.push(pill("",addr(L.funder,"funds"),"deposit wallet on Polygon"));ps.push(pill("",addr(L.wallet,"signer"),"signer key"));var c=L.claims;if(c){if(c.blockedUntil)ps.push(pill("bad","claims paused · <b>"+hhmm(c.blockedUntil/1000)+"</b>","relayer quota used up, resumes "+hhmm(c.blockedUntil/1000)+" KST"));else ps.push(pill("","claims every "+c.everyMin+" min"+(c.nextAt?" · next <b>"+hhmm(c.nextAt/1000)+"</b>":""),"wins are claimed in one batch"))}if(L.statsSince)ps.push(pill("","counting since <b>"+new Date(L.statsSince).toLocaleString("en-GB",{timeZone:"Asia/Seoul",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",hour12:false})+"</b>","every real trade since then, removed rules included"));return ps.join("")})();
var rows=[];ALLV.forEach(function(l){(l.recent||[]).forEach(function(t){rows.push(Object.assign({mk:l.label||"BTC 5m"},t))})});
rows.sort(function(a,b){return (b.t||0)-(a.t||0)});
var nopen=0,nsettling=0;rows.forEach(function(t){if(t.pnl==null&&t.ok&&!t.dry){if(openState(t).done)nsettling++;else nopen++}});
var FITLOG=window.matchMedia&&window.matchMedia("(min-width:1400px)").matches;if(!FITLOG)rows=rows.slice(0,25);
function feeOf(t){if(t.fee!=null)return t.fee;if(!(t.shares>0)||!(t.cost>0))return 0;var p=t.cost/t.shares;return 0.07*t.shares*p*(1-p)}
function openState(t){if(t.shares<=0)return {txt:"open",c:"mut"};var win="+"+money(t.shares-t.cost-feeOf(t))+" if win";
var rr=RS[t.mk]||{};var b=rr.lastBook||{};if(t.window!==(rr.window||b.window)){var pl=rr.pendingLean?rr.pendingLean[t.window]:null;if(pl==null||pl===0)return {txt:"waiting for result · "+win,c:"mut",done:true};var ok=(pl>0)===(t.side==="UP");return {txt:(ok?"likely win · "+win.replace(" if win",""):"likely loss · \u2212"+money(t.cost+feeOf(t)))+" · waiting",c:ok?"ok":"bad",done:true}}
var up=(b.chainlink!=null&&b.open!=null)?(b.chainlink>b.open?1:b.chainlink<b.open?-1:0):null;
var mine=t.side==="UP"?b.upAsk:b.downAsk;var mk=mine!=null?" · "+cents(mine):"";
if(up==null)return {txt:"open"+mk+" · "+win,c:"mut"};
var ahead=up===0?0:(up>0)===(t.side==="UP")?1:-1;
return {txt:(ahead>0?"ahead":ahead<0?"behind":"even")+mk+" · "+win,c:ahead>0?"ok":ahead<0?"bad":"mut"}}
swap("log",rows.length?rows.map(function(t){var o=t.pnl==null&&t.ok&&!t.dry?openState(t):null;var res=o?o.txt:t.pnl==null?(t.ok?"dry":t.status==="skipped"?"skipped":"no fill"):signed(t.pnl);var c=o?o.c:t.pnl==null?"mut":cls(t.pnl);var px=t.shares>0?Math.round(t.cost/t.shares*100)+"¢":cents(t.ask);return '<tr class="'+(t.ok?"":"dim")+'" data-k="'+esc(t.mk+"|"+t.window+"|"+(t.variant||"")+"|"+(t.t||""))+'" data-res="'+(t.pnl==null?"open":t.pnl>=0?"ok":"bad")+'" data-pnl="'+(t.pnl==null?"":t.pnl)+'" data-w="'+(t.window||"")+'"><td><span class="dot'+(o&&!o.done?" on":"")+'"></span>'+hhmm(t.window)+'</td><td class="'+(t.side==="UP"?"ok":"bad")+'">'+coin(t.mk)+(OL.length?'<span class="mut">'+t.mk.replace(" 5m","")+'</span> ':"")+t.side+'</td><td class="mut">'+(t.variant||"")+'</td><td>'+px+(t.shares>0?" × "+t.shares.toFixed(1):"")+'</td><td class="r">'+(t.cost>0?money(t.cost):"")+'</td><td class="r '+c+'">'+res+'</td></tr>'}).join(""):'<tr><td class="empty" colspan="6">no filled orders yet</td></tr>');
if(FITLOG){var lw=el("logwrap");var lh=lw?lw.clientHeight:0;if(lh>0)Array.prototype.forEach.call(el("log").children,function(tr){tr.style.display=(tr.offsetTop+tr.offsetHeight>lh+1)?"none":""})}
var tn=0,tw=0,tnet=0,tset=0,tmin=Infinity;Array.prototype.forEach.call(el("log").children,function(tr){if(tr.style.display==="none"||!tr.hasAttribute("data-pnl"))return;tn++;var w=parseFloat(tr.getAttribute("data-w"));if(w>0&&w<tmin)tmin=w;var v=tr.getAttribute("data-pnl");if(v!==""){tset++;var pv=parseFloat(v);tnet+=pv;if(pv>=0)tw++}});
var tspanH=isFinite(tmin)?(Date.now()/1000-tmin)/3600:0;var trate=tspanH>=0.25&&tset?" · ≈ "+signed(tnet/tspanH)+"/h":"";
el("lopen").textContent=[tn?tn+" shown · "+tw+"/"+tset+" won · "+signed(tnet)+trate:"",nopen?nopen+" open":"",nsettling?nsettling+" settling":""].filter(Boolean).join(" · ");
(function(){var M=[{label:"BTC 5m",key:"",papers:s.papers}].concat((s.series||[]).map(function(r){return {label:r.label,key:r.key||"",papers:r.papers}})).filter(function(m){return inTab(m.label)});if(TAB==="overview"){M=WINS.map(function(w){var mk=M.filter(function(m){return WOF(m.label)===w});if(!mk.length)return null;var agg={};mk.forEach(function(m){(m.papers||[]).forEach(function(p){if(!p.trades)return;var ls=LIVE[m.label+"|"+p.name];var o=agg[p.name]||(agg[p.name]={name:p.name,net:0,trades:0,won:0,size:5,discarded:p.discarded});o.net+=p.net*(ls||5)/(p.size||5);o.trades+=p.trades;o.won+=p.won})});return {label:w,key:null,agg:true,papers:Object.keys(agg).map(function(k){return agg[k]})}}).filter(Boolean)}var LIVE={};ALL.forEach(function(l){if(l.mode==="off")return;var lb=l.label||"BTC 5m";((l.variants&&l.variants.length)?l.variants:(l.variant?[{variant:l.variant}]:[])).forEach(function(v){LIVE[lb+"|"+v.variant]=v.size||5})});var cid=function(k){return "cell-"+esc(k).replace(/[^a-z0-9]/gi,"_")};
var names=(s.papers||[]).map(function(p){return p.name});var rows=names.map(function(n){var meta=(s.papers||[]).filter(function(p){return p.name===n})[0]||{};var cells=[],tot=0,tr=0,wn=0;M.forEach(function(m){var p=(m.papers||[]).filter(function(x){return x.name===n})[0];if(!p||!p.trades){cells.push(null);return}var ls=m.agg?null:LIVE[m.label+"|"+n];var net=m.agg?p.net:p.net*(ls||5)/(p.size||5);tot+=net;tr+=p.trades;wn+=p.won;cells.push({net:net,won:p.won,trades:p.trades,label:m.label,key:m.key,ls:ls})});return {name:n,meta:meta,cells:cells,tot:tot,tr:tr,wn:wn}});
rows.sort(function(a,b){if(a.meta.discarded!==b.meta.discarded)return a.meta.discarded?1:-1;if(!a.tr!==!b.tr)return a.tr?-1:1;return b.tot-a.tot});if(TAB==="overview")rows=rows.filter(function(r){return !r.meta.discarded}).slice(0,10);
var isNew=function(d,tr){if(!d)return false;var age=Date.now()-Date.parse(d);return age<86400000||(age<3*86400000&&tr<30)};
el("labhead").innerHTML='<tr><th>rule</th>'+M.map(function(m){return '<th class="pc">'+(m.agg?'all '+m.label:coin(m.label)+m.label)+'</th>'}).join("")+'<th class="r">all</th><th class="r">won</th><th></th></tr>';
var labHtml=rows.map(function(r){var m=r.meta;return '<tr class="'+(m.discarded?"off":"")+'"><td><b>'+r.name+'</b>'+(isNew(m.added,r.tr)?' <span class="tag new">new</span>':"")+' <span class="info" data-tip="'+esc(m.idea||m.rule||"")+'">i</span></td>'+r.cells.map(function(c,ci){var m=M[ci];var k=m.label+"|"+r.name;var live=!!LIVE[k];var act=r.meta.discarded||m.agg?'':live?'<span class="ldot" title="on real money"></span>':'<button class="btn go" title="put '+r.name+' on real money for '+m.label+'" onclick="goLive(\\''+m.key+'\\',\\''+m.label+'\\',\\''+r.name+'\\')">&#9654;</button>';return '<td class="pc'+(live?' islive':'')+'" id="'+cid(k)+'">'+(c?'<div class="n '+cls(c.net)+'">'+signed(c.net)+'</div><div class="c">'+c.won+'/'+c.trades+(c.ls?' <span class="mut">@$'+c.ls+'</span>':'')+act+'</div>':'<div class="n mut">—</div><div class="c">'+act+'</div>')+'</td>'}).join("")+'<td class="r '+cls(r.tr?r.tot:null)+'"><b>'+(r.tr?signed(r.tot):"—")+'</b></td><td class="r">'+(r.tr?(r.wn/r.tr*100).toFixed(1)+"%":"—")+'</td><td class="r">'+(m.discarded?'<button class="btn restore" onclick="discard(\\''+r.name+'\\',true)">restore</button>':'<button class="btn" onclick="discard(\\''+r.name+'\\',false)">discard</button>')+'</td></tr>'}).join("");if(labHtml!==LABHTML){LABHTML=labHtml;el("lab").innerHTML=labHtml}})();
el("ov").innerHTML=WINS.map(function(w){var mk=[s].concat(s.series||[]).filter(function(r){return WOF(r.label||"BTC 5m")===w});if(!mk.length)return '<tr class="dim"><td><b>'+w+'</b></td><td class="r mut">0</td><td class="r mut">—</td><td class="r mut">—</td><td class="r mut">—</td><td class="r mut">—</td><td class="r mut">—</td><td class="mut sm">not recorded yet</td></tr>';var ls=ALL.filter(function(l){return WOF(l.label||"BTC 5m")===w});var on=0;ls.forEach(function(l){if(l.mode==="off")return;((l.variants&&l.variants.length)?l.variants:(l.variant?[{variant:l.variant}]:[])).forEach(function(v){if(!v.paused&&!v.halted&&!v.manual)on++})});var g=function(k){return ls.reduce(function(a,l){return a+(l[k]||0)},0)};var tn=g("todayNet"),an=g("net"),tr=g("trades"),wn=g("won");var best=null;var agg={};mk.forEach(function(r){(r.papers||[]).forEach(function(p){if(!p.trades||p.discarded)return;var o=agg[p.name]||(agg[p.name]={net:0,tr:0,wn:0});o.net+=p.net*5/(p.size||5);o.tr+=p.trades;o.wn+=p.won})});Object.keys(agg).forEach(function(n){if(!best||agg[n].net>agg[best].net)best=n});return '<tr><td><b>'+w+'</b></td><td class="r">'+mk.length+'</td><td class="r">'+(on||"—")+'</td><td class="r '+cls(tn)+'"><b>'+(ls.length?signed(tn):"—")+'</b></td><td class="r '+cls(an)+'"><b>'+(ls.length?signed(an):"—")+'</b></td><td class="r">'+(tr||"—")+'</td><td class="r">'+(tr?(wn/tr*100).toFixed(1)+"%":"—")+'</td><td>'+(best?'<b>'+esc(best)+'</b> <span class="'+cls(agg[best].net)+'">'+signed(agg[best].net)+'</span> <span class="mut sm">'+agg[best].wn+'/'+agg[best].tr+'</span>':'<span class="mut">—</span>')+'</td></tr>'}).join("");
var seenCoin={};var coinRows=[];[s].concat(s.series||[]).forEach(function(r){var lb=r.label||"BTC 5m";var k=lb.split(" ")[0];if(seenCoin[k]||!r.feeds)return;seenCoin[k]=1;coinRows.push({k:k,lb:lb,feeds:r.feeds})});
var fcell=function(f){if(!f)return '<td class="mut">—</td>';var age=f.last?Math.round((Date.now()-f.last.t)/1000):null;var ok=f.healthy&&age!=null&&age<30;return '<td title="'+f.ticks+' ticks'+(age!=null?', last '+age+'s ago':'')+'"><span class="wp '+(ok?"ok":"bad")+'"><span class="d"></span>'+(f.last?money(f.last.price):"no data")+(age!=null?' <span class="mut">'+age+'s</span>':'')+'</span></td>'};
el("feeds").innerHTML=coinRows.map(function(c){var by={};c.feeds.forEach(function(f){var n=String(f.name||"");["chainlink","binance","coinbase","futures"].forEach(function(k){if(n.indexOf(k)===0)by[k]=f})});return '<tr><td>'+coin(c.lb)+'<b>'+esc(c.k)+'</b></td>'+fcell(by.chainlink)+fcell(by.binance)+fcell(by.coinbase)+fcell(by.futures)+'</tr>'}).join("")||'<tr><td class="empty" colspan="5">no feeds</td></tr>';
el("wd").textContent=s.windowsDone;el("ws").textContent=s.windowsResolved;el("wp").textContent=s.pending;el("sn").textContent=s.snapshots;
el("err").textContent=s.lastError?"last error: "+s.lastError:"";
el("note").textContent="Data is in the data/ folder next to the app. Set \\"mode\\" to \\"off\\" in data/live.json to stop real orders.";
tickV(prevV);}catch(e){el("sub").textContent="status unavailable"}}
var H={},PREV={},DECIDED={};
function feedChart(key,label,sec,r){var b=r.lastBook||{};var w=r.window||b.window;if(!w)return;var pv=PREV[key];if(pv&&pv.w!==w&&pv.last!=null&&pv.open!=null){var v=(pv.last-pv.open)/pv.open*1e4;DECIDED[key]={side:pv.last>=pv.open?"UP":"DOWN",bp:(v<0?"\u2212":"+")+Math.abs(v).toFixed(1),at:Date.now(),until:Date.now()+5000}}
var h=H[key]={w:w,sec:sec,label:label,open:null,pts:[]};
h.left=b.window===w&&b.left!=null?b.left:Math.max(0,w+sec-Math.floor(Date.now()/1000));h.up=b.window===w?b.upAsk:null;h.down=b.window===w?b.downAsk:null;if(b.window===w&&b.open!=null)h.open=b.open;
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
function drawCharts(){var bb=el("bets");if(bb)document.querySelectorAll(".chart .bet").forEach(function(b){bb.appendChild(b)});var W=220,HT=92,L=40,R=6,T=6,B=14,pw=W-L-R,ph=HT-T-B;
el("charts").innerHTML=Object.keys(H).map(function(k){var h=H[k];var open=h.open;var ps=h.pts.map(function(p){return p.p});var vals=ps.concat(open==null?[]:[open]);
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
return '<div class="chart'+(won?" won "+(won.side==="UP"?"up":"down"):"")+(sig?" sig":"")+'"'+ag+'>'+(sig?'<div class="sigtag" title="bounce signal: UP at 20c or less, price up 5+ bps in the last 10 s, 2+ min left (the jump5-up20 paper rule)">bounce · UP '+cents(h.up)+'</div>':'')+(won?'<div class="stamp"'+ag+'><b>'+won.side+'</b><span>closed '+won.bp+' bp</span></div>':'')+'<div class="t"><span>'+coin(h.label)+'<b>'+h.label+'</b></span><span class="mut">closes in '+lf+'</span></div><div class="px"><b>'+money(h.last)+'</b><span class="'+(col==="#3ddc84"?"ok":col==="#ff6b6b"?"bad":"mut")+'">'+dl+'</span>'+mvs+'</div><svg viewBox="0 0 '+W+' '+HT+'">'+g+'</svg><div class="t"><span><span class="ok">UP '+cents(h.up)+'</span> <span class="bad">DOWN '+cents(h.down)+'</span></span>'+lean+'</div><div class="bslot" data-k="'+k+'"></div></div>'}).join("");placeBets()}
var BETKEY="";var minFor=function(a){return a==null||!(a>0)||a>=1?null:Math.max(1,Math.ceil(5*a*100)/100)};
function drawBets(){var bb=el("bets");if(!bb)return;var keys=Object.keys(H);var key=keys.join("|");if(key!==BETKEY){BETKEY=key;bb.innerHTML=keys.map(function(k){return '<div class="bet" data-k="'+k+'"><div class="brow"><span class="cur">$</span><input type="number" min="1" max="100" step="1" value="5" inputmode="decimal" title="amount in $"><button class="btn bup" data-side="UP">UP</button><button class="btn bdown" data-side="DOWN">DOWN</button></div><div class="bmin mut"></div></div>'}).join("");placeBets()}
keys.forEach(function(k){var h=H[k];var d=document.querySelector('.bet[data-k="'+k+'"]');if(!d)return;var amt=Number(d.querySelector("input").value);var ask={UP:h.up,DOWN:h.down};var open=h.left!=null&&h.left>3;d.querySelectorAll("button").forEach(function(b){var a=ask[b.dataset.side],m=minFor(a);var ok=open&&m!=null&&amt>=m&&amt<=100&&!BETBUSY;b.disabled=!ok;b.textContent=b.dataset.side+" "+(a==null?"—":cents(a));b.title=!open?"window closing":m==null?"no ask right now":amt<m?"minimum $"+m.toFixed(2)+" (5 shares at "+cents(a)+")":amt>100?"max $100 a click":"buy "+b.dataset.side+" for $"+amt+" with real money"});var mu=minFor(h.up),md=minFor(h.down);d.querySelector(".bmin").textContent="manual · min "+(mu!=null?"$"+mu.toFixed(2):"—")+" up / "+(md!=null?"$"+md.toFixed(2):"—")+" down (5 shares)"})}
var BETBUSY=false;
document.addEventListener("input",function(e){if(e.target&&e.target.closest&&e.target.closest(".bet"))drawBets()});
document.addEventListener("click",async function(e){var b=e.target&&e.target.closest&&e.target.closest(".bet button");if(!b||b.disabled)return;var d=b.closest(".bet");var k=d.dataset.k;var h=H[k];if(!h)return;var side=b.dataset.side;var amt=Number(d.querySelector("input").value);var a=side==="UP"?h.up:h.down;var m=minFor(a);if(m==null||amt<m){alert("Minimum is $"+(m!=null?m.toFixed(2):"?")+" (Polymarket fills at least 5 shares)");return}
if(!confirm("REAL MONEY\\n\\nBuy "+side+" on "+h.label+" for $"+amt+"\\nask now "+cents(a)+", pays up to "+cents(Math.min(0.99,a+0.05))+" · window closes in "+Math.floor(h.left/60)+":"+String(h.left%60).padStart(2,"0")+"\\n\\nTracked as the 'manual' strategy."))return;
BETBUSY=true;drawBets();d.classList.add("busy");try{var r=await fetch("/api/manual",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({series:k==="btc5m"?"":k,side:side,amount:amt})});var j=await r.json();d.classList.remove("busy");if(!r.ok){d.classList.add("fail");setTimeout(function(){d.classList.remove("fail")},1500);alert("Not placed: "+(j.error||"failed"))}else{var t=j.trade||{};d.classList.add("done");setTimeout(function(){d.classList.remove("done")},1500);if(t.dry)alert("Dry mode: order signed, not sent.")}}catch(err){d.classList.remove("busy");alert("Not placed: "+err)}BETBUSY=false;poll()});
showTab(TAB);poll();setInterval(poll,1000);
</script></body></html>`;
