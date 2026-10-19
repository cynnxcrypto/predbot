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
    if (req.url === "/favicon.svg" || req.url === "/favicon.ico") {
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
      res.end(FAVICON);
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
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
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
<table style="margin-bottom:20px"><thead><tr><th>Paper variant</th><th>Rule</th><th class="r">Trades</th><th class="r">Won</th><th class="r">Net</th><th class="r">Open</th><th class="r">No ask</th></tr></thead><tbody id="papers"></tbody></table>
<table><thead><tr><th>Feed</th><th>State</th><th class="r">Last price</th><th class="r">Age</th><th class="r">Ticks</th><th class="r">Reconnects</th></tr></thead><tbody id="feeds"></tbody></table>
<p class="sub" style="margin-top:16px" id="note">Nothing trades for real. This records the book, three BTC feeds and every settlement, and paper-trades the projection rule. Data is in the data/ folder next to the app.</p>
</main><script>
const el=(id)=>document.getElementById(id);
const money=(n)=>n==null?"—":"$"+n.toLocaleString("en-US",{maximumFractionDigits:2});
const cents=(n)=>n==null?"—":Math.round(n*100)+"¢";
async function poll(){try{const s=await (await fetch("/api/status")).json();
const b=s.lastBook;const left=s.window?Math.max(0,s.window+300-Math.floor(Date.now()/1000)):0;
el("sub").textContent="build "+s.build+" · window "+(s.window?new Date(s.window*1000).toISOString().slice(11,19):"—")+" · "+(s.listed?"listed":"not listed yet")+" · "+String(Math.floor(left/60))+":"+String(left%60).padStart(2,"0")+" left"+(s.lastError?" · error: "+s.lastError:"");
const pairs=[["windows recorded",s.windowsDone],["settled",s.windowsResolved],["waiting for settlement",s.pending],["book snapshots",s.snapshots],["open",money(b&&b.open)],["chainlink",money(b&&b.chainlink)],["up ask",cents(b&&b.upAsk)],["down ask",cents(b&&b.downAsk)],["paper trades",s.paper.trades+(s.paper.open?" (+"+s.paper.open+" open)":"")],["paper won",s.paper.trades?Math.round(s.paper.won/s.paper.trades*100)+"%":"—"],["paper net",(s.paper.net<0?"-":"+")+"$"+Math.abs(s.paper.net).toFixed(2)],["no ask under cap",s.paper.noAsk]];
const L=s.live||{mode:"off"};
el("note").textContent=(L.mode==="off"?"Nothing trades for real. ":L.mode==="dry"?"DRY RUN: real orders are signed but not sent. ":"LIVE: real orders on "+L.variant+" at $"+L.size+" per window, stop after -$"+L.maxLossPerDay+" in a day. ")+(L.mode!=="off"?(L.ready?"Wallet ready, balance "+money(L.balance)+". ":"Wallet not ready"+(L.lastError?" ("+L.lastError+")":"")+". ")+"Real trades: "+L.trades+(L.trades?" ("+Math.round(L.won/L.trades*100)+"% won), net "+(L.net<0?"-":"+")+"$"+Math.abs(L.net).toFixed(2)+", today "+(L.todayNet<0?"-":"+")+"$"+Math.abs(L.todayNet).toFixed(2):"")+(L.open?", "+L.open+" open":"")+". ":"")+"Paper rule: "+s.paper.rule+". Data is in the data/ folder next to the app.";
el("note").style.color=L.mode==="live"?"var(--up)":"";
el("strip").innerHTML=pairs.map(([k,v])=>'<div><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join("");
el("papers").innerHTML=(s.papers||[]).map(p=>'<tr><td>'+p.name+'</td><td>'+p.rule+'</td><td class="r">'+p.trades+'</td><td class="r">'+(p.trades?Math.round(p.won/p.trades*100)+"%":"—")+'</td><td class="r '+(p.net<0?"bad":"ok")+'">'+(p.net<0?"-":"+")+"$"+Math.abs(p.net).toFixed(2)+'</td><td class="r">'+p.open+'</td><td class="r">'+p.noAsk+'</td></tr>').join("");
el("feeds").innerHTML=s.feeds.map(f=>'<tr><td>'+f.name+'</td><td class="'+(f.healthy?"ok":"bad")+'">'+(f.healthy?"live":"down")+'</td><td class="r">'+money(f.last&&f.last.price)+'</td><td class="r">'+(f.last?Math.round((Date.now()-f.last.t)/1000)+"s":"—")+'</td><td class="r">'+f.ticks+'</td><td class="r">'+f.connects+'</td></tr>').join("");
}catch(e){el("sub").textContent="status unavailable"}}
poll();setInterval(poll,2000);
</script></body></html>`;
