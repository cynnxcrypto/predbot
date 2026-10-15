import { createServer } from "node:http";
import { STATUS_PORT } from "./config.js";
import type { Recorder } from "./recorder.js";

/**
 * A one-page status view on 127.0.0.1 so you can see the recorder is alive without reading logs.
 * Resolves once the port is bound; rejects (with code EADDRINUSE) when another copy holds it.
 */
export function serveStatus(recorder: Recorder, build: string) {
  const server = createServer((req, res) => {
    if (req.url === "/api/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ build, ...recorder.status() }));
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Pred bot</title>
<style>
:root{--bg:#0f1117;--panel:#151922;--line:#232838;--fg:#e8eaf0;--mut:#7b8294;--up:#3ddc84;--down:#ff6b6b;--acc:#f7931a}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,Menlo,monospace}
main{max-width:960px;margin:40px auto;padding:0 20px}
h1{font-size:18px;margin:0 0 4px;font-weight:600}.sub{color:var(--mut);font-size:12px;margin-bottom:24px}
.strip{display:flex;flex-wrap:wrap;gap:24px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin-bottom:14px}
.k{color:var(--mut);font-size:10px;letter-spacing:.14em;text-transform:uppercase}.v{font-size:15px}
.ok{color:var(--up)}.bad{color:var(--down)}.acc{color:var(--acc)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
td,th{padding:8px 14px;border-top:1px solid var(--line);text-align:left;font-weight:400}th{color:var(--mut);font-size:10px;letter-spacing:.14em;text-transform:uppercase;border-top:0}
.r{text-align:right}
</style></head><body><main>
<h1>Pred bot <span class="acc">recorder</span></h1><div class="sub" id="sub">loading</div>
<div class="strip" id="strip"></div>
<table><thead><tr><th>Feed</th><th>State</th><th class="r">Last price</th><th class="r">Age</th><th class="r">Ticks</th><th class="r">Reconnects</th></tr></thead><tbody id="feeds"></tbody></table>
<p class="sub" style="margin-top:16px">Nothing trades. This records the book, three BTC feeds and every settlement so the next step can be measured instead of guessed. Data is in the data/ folder next to the app.</p>
</main><script>
const el=(id)=>document.getElementById(id);
const money=(n)=>n==null?"—":"$"+n.toLocaleString("en-US",{maximumFractionDigits:2});
const cents=(n)=>n==null?"—":Math.round(n*100)+"¢";
async function poll(){try{const s=await (await fetch("/api/status")).json();
const b=s.lastBook;const left=s.window?Math.max(0,s.window+300-Math.floor(Date.now()/1000)):0;
el("sub").textContent="build "+s.build+" · window "+(s.window?new Date(s.window*1000).toISOString().slice(11,19):"—")+" · "+(s.listed?"listed":"not listed yet")+" · "+String(Math.floor(left/60))+":"+String(left%60).padStart(2,"0")+" left"+(s.lastError?" · error: "+s.lastError:"");
const pairs=[["windows recorded",s.windowsDone],["settled",s.windowsResolved],["waiting for settlement",s.pending],["book snapshots",s.snapshots],["open",money(b&&b.open)],["chainlink",money(b&&b.chainlink)],["up ask",cents(b&&b.upAsk)],["down ask",cents(b&&b.downAsk)]];
el("strip").innerHTML=pairs.map(([k,v])=>'<div><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join("");
el("feeds").innerHTML=s.feeds.map(f=>'<tr><td>'+f.name+'</td><td class="'+(f.healthy?"ok":"bad")+'">'+(f.healthy?"live":"down")+'</td><td class="r">'+money(f.last&&f.last.price)+'</td><td class="r">'+(f.last?Math.round((Date.now()-f.last.t)/1000)+"s":"—")+'</td><td class="r">'+f.ticks+'</td><td class="r">'+f.connects+'</td></tr>').join("");
}catch(e){el("sub").textContent="status unavailable"}}
poll();setInterval(poll,2000);
</script></body></html>`;
