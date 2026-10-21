import { createServer } from "node:http";
import { STATUS_PORT } from "./config.js";
import type { Recorder } from "./recorder.js";

/**
 * A one-page status view on 127.0.0.1 so you can see the recorder is alive without reading logs.
 * Resolves once the port is bound; rejects (with code EADDRINUSE) when another copy holds it.
 */
export function serveStatus(recorder: Recorder, build: string, others: Recorder[] = []) {
  const server = createServer((req, res) => {
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
main{max-width:1120px;margin:0 auto;padding:36px 24px 60px}
.top{display:flex;align-items:center;gap:14px;margin-bottom:18px;flex-wrap:wrap}
h1{font-size:20px;margin:0;font-weight:700;letter-spacing:.2px}
.pill{font-size:11px;letter-spacing:.14em;text-transform:uppercase;padding:4px 10px;border-radius:999px;border:1px solid var(--line);color:var(--mut)}
.pill.live{color:#0f1117;background:var(--up);border-color:var(--up);font-weight:700}
.pill.dry{color:var(--acc);border-color:var(--acc)}
.tag{font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding:2px 8px;border-radius:999px;margin-left:8px;vertical-align:middle}
.tag.real{color:#0f1117;background:var(--up)}
.tag.paper{color:var(--pur);border:1px solid var(--pur)}
.panel.real{border-color:var(--up)}
.sub{color:var(--mut);font-size:12px;margin-left:auto}
.grid{display:grid;grid-template-columns:1.1fr 1fr;gap:14px;margin-bottom:14px}
@media(max-width:820px){.grid{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
.hero{display:flex;align-items:center;gap:28px;flex-wrap:wrap}
.clock{font-size:64px;font-weight:700;line-height:1;letter-spacing:-1px}
.clock.soon{color:var(--acc)}
.k{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);margin-bottom:4px}
.v{font-size:16px}
.v.big{font-size:26px;font-weight:700}
.stats{display:flex;gap:26px;flex-wrap:wrap}
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
.log td{font-size:13px}
.empty{color:var(--mut);padding:14px 0;text-align:center}
.note{color:var(--mut);font-size:12px;margin-top:14px}
.spark{height:46px;width:100%;display:block}
</style></head><body><main>
<div class="top"><h1>Pred bot</h1><span class="pill" id="mode">off</span><span class="pill" id="listed">—</span><span class="sub" id="sub">loading</span></div>

<div class="panel" style="margin-bottom:14px"><div class="hero">
  <div><div class="k" id="wlabel">window</div><div class="clock" id="clock">–:––</div></div>
  <div class="stats">
    <div><div class="k">chainlink</div><div class="v big" id="px">—</div></div>
    <div><div class="k">vs open</div><div class="v big" id="delta">—</div></div>
    <div><div class="k">up ask</div><div class="v big" id="upask">—</div></div>
    <div><div class="k">down ask</div><div class="v big" id="downask">—</div></div>
    <div><div class="k">leaning</div><div class="v big" id="lean">—</div></div>
  </div>
  <svg class="spark" id="spark" viewBox="0 0 600 46" preserveAspectRatio="none"></svg>
</div></div>

<div class="grid">
  <div class="panel real"><div class="ph"><div class="k">real money <span class="tag real">real</span></div><div class="mut" id="lrule"></div></div>
    <div class="stats" style="margin-bottom:14px">
      <div><div class="k">balance</div><div class="v big" id="bal">—</div></div>
      <div><div class="k">today</div><div class="v big" id="today">—</div></div>
      <div><div class="k">all time</div><div class="v big" id="net">—</div></div>
      <div><div class="k">trades</div><div class="v big" id="ltr">—</div></div>
      <div><div class="k">won</div><div class="v big" id="lwon">—</div></div>
      <div><div class="k">orders</div><div class="v big" id="lord">—</div></div>
      <div><div class="k">skipped</div><div class="v big" id="lskip">—</div></div>
    </div>
    <div class="mut" id="lstate" style="font-size:12px"></div>
    <div class="mut" style="font-size:12px;margin-top:6px">Only this panel, the trade log and the "real" columns below are real orders on Polymarket, settled from your wallet.</div>
  </div>
  <div class="panel real"><div class="ph"><div class="k">real trade log <span class="tag real">real</span></div><div class="mut" id="lopen"></div></div>
    <table class="log"><tbody id="log"></tbody></table>
  </div>
</div>

<div class="panel" style="margin-bottom:14px"><div class="ph"><div class="k">real vs paper, day by day <span class="tag real">real</span><span class="tag paper">paper</span></div><div class="mut" id="cmprule"></div></div>
<table><thead><tr><th>day (utc day = 09:00–09:00 kst)</th><th class="r">real orders</th><th class="r">filled</th><th class="r">skipped</th><th class="r">no fill</th><th class="r">real won</th><th class="r">real net</th><th class="r">paper trades</th><th class="r">paper won</th><th class="r">paper net</th></tr></thead><tbody id="cmp"></tbody></table>
<div class="note">Real: orders the bot actually sent, at the live size. Paper: the same rule simulated at $20 with no money, so the two are not the same scale; compare win rates, not dollars.</div></div>

<div class="panel" style="margin-bottom:14px"><div class="ph"><div class="k">paper variants <span class="tag paper">paper · simulated, no money</span></div><div class="mut">every number here is simulated at $20 a window, no money</div></div>
<table><thead><tr><th>variant</th><th>rule</th><th class="r">trades</th><th class="r">won</th><th class="r">net</th><th class="r">open</th></tr></thead><tbody id="papers"></tbody></table><div class="note">The row tagged "live rule" is the paper copy of the rule trading real money; its real results are in the real-money panel above.</div></div>

<div class="panel" style="margin-bottom:14px"><div class="ph"><div class="k">other markets <span class="tag paper">paper · simulated, no money</span></div><div class="mut">same paper rules, recording only</div></div>
<table><thead><tr><th>market</th><th>window</th><th class="r">up ask</th><th class="r">down ask</th><th class="r">settled</th><th class="r">base</th><th class="r">band80-30</th><th class="r">band80-30-chase</th><th class="r">cheap10-first90</th></tr></thead><tbody id="series"></tbody></table></div>

<div class="grid">
  <div class="panel"><div class="ph"><div class="k">feeds</div></div>
  <table><thead><tr><th>feed</th><th>state</th><th class="r">last</th><th class="r">age</th><th class="r">ticks</th></tr></thead><tbody id="feeds"></tbody></table></div>
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
var hhmm=function(sec){return new Date(sec*1000).toLocaleTimeString("en-GB",{timeZone:"Asia/Seoul",hour:"2-digit",minute:"2-digit"})};
var hist=[];
function cls(n){return n==null?"":n<0?"bad":n>0?"ok":""}
async function poll(){try{var s=await (await fetch("/api/status")).json();
var b=s.lastBook||{};var L=s.live||{mode:"off"};
var left=s.window?Math.max(0,s.window+300-Math.floor(Date.now()/1000)):0;
el("clock").textContent=String(Math.floor(left/60))+":"+String(left%60).padStart(2,"0");
el("clock").className="clock"+(left<=30?" soon":"");
el("wlabel").textContent="window "+(s.window?hhmm(s.window)+" kst":"—")+" · closes in";
el("mode").textContent=L.mode==="live"?"live · real money":L.mode==="dry"?"dry run":"paper only";
el("mode").className="pill "+(L.mode==="live"?"live":L.mode==="dry"?"dry":"");
el("listed").textContent=s.listed?"market listed":"not listed yet";
el("sub").textContent="build "+s.build+(s.lastError?" · error: "+s.lastError:"");
el("px").textContent=money(b.chainlink);
var d=(b.chainlink!=null&&b.open!=null)?(b.chainlink-b.open)/b.open*1e4:null;
el("delta").textContent=d==null?"—":(d>=0?"+":"")+d.toFixed(1)+" bp";el("delta").className="v big "+cls(d);
el("upask").textContent=cents(b.upAsk);el("downask").textContent=cents(b.downAsk);
var lean=(b.upAsk!=null&&b.downAsk!=null)?(b.upAsk>b.downAsk?"UP "+cents(b.upAsk):"DOWN "+cents(b.downAsk)):"—";
el("lean").textContent=lean;el("lean").className="v big "+(lean.indexOf("UP")===0?"ok":lean.indexOf("DOWN")===0?"bad":"");
if(b.chainlink!=null){if(!hist.length||hist[hist.length-1].w!==s.window){if(hist.length&&hist[hist.length-1].w!==s.window)hist=[];}hist.push({w:s.window,p:b.chainlink});if(hist.length>300)hist.shift();}
drawSpark(b.open);
el("lrule").textContent=L.mode==="off"?"":L.variant+" · $"+L.size+" a window · stop after -$"+L.maxLossPerDay+" a day";
el("bal").textContent=money(L.balance);
el("today").textContent=signed(L.todayNet);el("today").className="v big "+cls(L.todayNet);
el("net").textContent=signed(L.net);el("net").className="v big "+cls(L.net);
el("ltr").textContent=L.trades==null?"—":L.trades;
el("lwon").textContent=L.trades?Math.round(L.won/L.trades*100)+"%":"—";
var LD=L.days||[];var tot=LD.reduce(function(a,d){a.o+=d.orders;a.s+=d.skipped;return a},{o:0,s:0});
el("lord").textContent=L.mode==="off"&&!LD.length?"—":tot.o;el("lskip").textContent=L.mode==="off"&&!LD.length?"—":tot.s;
var PV=(s.papers||[]).filter(function(p){return p.name===L.variant})[0]||{};var PD=PV.days||[];
el("cmprule").textContent=L.variant?"rule "+L.variant+" · real at $"+L.size+" vs paper at $20":"";
var dayset={};LD.forEach(function(d){dayset[d.day]=1});PD.forEach(function(d){dayset[d.day]=1});
var daysAll=Object.keys(dayset).sort().reverse().slice(0,14);
el("cmp").innerHTML=daysAll.length?daysAll.map(function(day){var r=LD.filter(function(d){return d.day===day})[0];var p=PD.filter(function(d){return d.day===day})[0];
return '<tr><td>'+day+'</td><td class="r">'+(r?r.orders:0)+'</td><td class="r">'+(r?r.filled:0)+'</td><td class="r">'+(r?r.skipped:0)+'</td><td class="r">'+(r?r.noFill:0)+'</td><td class="r">'+(r&&r.settled?r.won+"/"+r.settled:"—")+'</td><td class="r '+cls(r?r.net:null)+'">'+(r&&r.settled?signed(r.net):"—")+'</td><td class="r">'+(p?p.trades:0)+'</td><td class="r">'+(p&&p.trades?p.won+"/"+p.trades:"—")+'</td><td class="r '+cls(p?p.net:null)+'">'+(p&&p.trades?signed(p.net):"—")+'</td></tr>'}).join(""):'<tr><td class="empty" colspan="10">nothing yet</td></tr>';
function esc(x){return String(x).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function addr(a,label){if(!a)return label+" —";return label+' <a href="https://polygonscan.com/address/'+a+'" target="_blank" rel="noopener" title="'+a+'">'+a.slice(0,6)+"…"+a.slice(-4)+'</a>'}
el("lstate").innerHTML=L.mode==="off"?"Real orders are off. Nothing trades for real.":(L.ready?"Wallet ready · "+addr(L.funder,"funds")+" · "+addr(L.wallet,"signer"):"Wallet not ready"+(L.lastError?": "+esc(L.lastError):""))+(L.lastError&&L.ready?" · "+esc(L.lastError):"");
el("lopen").textContent=L.open?L.open+" open":"";
var rows=(L.recent||[]);
function openState(t){if(t.shares<=0)return {txt:"open",c:"mut"};var win="+"+money(t.shares-t.cost)+" if win";
if(t.window!==s.window)return {txt:"waiting for result · "+win,c:"mut"};
var up=(b.chainlink!=null&&b.open!=null)?(b.chainlink>b.open?1:b.chainlink<b.open?-1:0):null;
var mine=t.side==="UP"?b.upAsk:b.downAsk;var mk=mine!=null?" · "+cents(mine):"";
if(up==null)return {txt:"open"+mk+" · "+win,c:"mut"};
var ahead=up===0?0:(up>0)===(t.side==="UP")?1:-1;
return {txt:(ahead>0?"ahead":ahead<0?"behind":"even")+mk+" · "+win,c:ahead>0?"ok":ahead<0?"bad":"mut"}}
el("log").innerHTML=rows.length?rows.map(function(t){var o=t.pnl==null&&t.ok&&!t.dry?openState(t):null;var res=o?o.txt:t.pnl==null?(t.ok?"dry":t.status==="skipped"?"skipped":"no fill"):signed(t.pnl);var c=o?o.c:t.pnl==null?"mut":cls(t.pnl);var px=t.shares>0?Math.round(t.cost/t.shares*100)+"¢":cents(t.ask);return '<tr class="'+(t.ok?"":"dim")+'"><td>'+hhmm(t.window)+'</td><td class="'+(t.side==="UP"?"ok":"bad")+'">'+t.side+'</td><td>'+px+(t.shares>0?" × "+t.shares.toFixed(1):"")+'</td><td class="r">'+(t.cost>0?money(t.cost):"")+'</td><td class="r '+c+'">'+res+'</td></tr>'}).join(""):'<tr><td class="empty" colspan="5">no real orders yet</td></tr>';
el("papers").innerHTML=(s.papers||[]).map(function(p){return '<tr class="'+(p.name===L.variant&&L.mode!=="off"?"hi":"")+'"><td>'+p.name+(p.name===L.variant&&L.mode==="live"?' <span class="tag real">live rule</span>':"")+'</td><td class="mut">'+p.rule+'</td><td class="r">'+p.trades+'</td><td class="r">'+(p.trades?Math.round(p.won/p.trades*100)+"%":"—")+'</td><td class="r '+cls(p.net)+'">'+signed(p.net)+'</td><td class="r">'+(p.open||"")+'</td></tr>'}).join("");
function pv(ps,name){var p=(ps||[]).filter(function(x){return x.name===name})[0];if(!p||!p.trades)return '<td class="r mut">—</td>';return '<td class="r '+cls(p.net)+'">'+signed(p.net)+' <span class="mut">'+p.won+'/'+p.trades+'</span></td>'}
el("series").innerHTML=(s.series||[]).length?(s.series||[]).map(function(r){var rb=r.lastBook||{};return '<tr><td>'+r.label+(r.lastError?' <span class="bad" title="'+esc(r.lastError)+'">!</span>':"")+'</td><td class="mut">'+(r.window?hhmm(r.window):"—")+(r.listed?"":" · not listed")+'</td><td class="r">'+cents(rb.upAsk)+'</td><td class="r">'+cents(rb.downAsk)+'</td><td class="r">'+r.windowsResolved+'</td>'+pv(r.papers,"base")+pv(r.papers,"band80-30")+pv(r.papers,"band80-30-chase")+pv(r.papers,"cheap10-first90")+'</tr>'}).join(""):'<tr><td class="empty" colspan="9">only the BTC 5m market is recorded</td></tr>';
el("feeds").innerHTML=s.feeds.map(function(f){return '<tr><td>'+f.name+'</td><td class="'+(f.healthy?"ok":"bad")+'">'+(f.healthy?"live":"down")+'</td><td class="r">'+money(f.last&&f.last.price)+'</td><td class="r">'+(f.last?Math.round((Date.now()-f.last.t)/1000)+"s":"—")+'</td><td class="r">'+f.ticks+'</td></tr>'}).join("");
el("wd").textContent=s.windowsDone;el("ws").textContent=s.windowsResolved;el("wp").textContent=s.pending;el("sn").textContent=s.snapshots;
el("err").textContent=s.lastError?"last error: "+s.lastError:"";
el("note").textContent="Paper rule: "+s.paper.rule+". Data is in the data/ folder next to the app. Set \\"mode\\" to \\"off\\" in data/live.json to stop real orders.";
}catch(e){el("sub").textContent="status unavailable"}}
function drawSpark(open){var svg=el("spark");if(hist.length<2){svg.innerHTML="";return}
var ps=hist.map(function(h){return h.p});var lo=Math.min.apply(null,ps.concat(open==null?[]:[open])),hi=Math.max.apply(null,ps.concat(open==null?[]:[open]));if(hi-lo<1){hi=lo+1}
var x=function(i){return i/(hist.length-1)*600},y=function(p){return 42-(p-lo)/(hi-lo)*38};
var d=ps.map(function(p,i){return (i?"L":"M")+x(i).toFixed(1)+","+y(p).toFixed(1)}).join(" ");
var last=ps[ps.length-1];var col=open==null?"#7b8294":last>=open?"#3ddc84":"#ff6b6b";
svg.innerHTML=(open==null?"":'<line x1="0" x2="600" y1="'+y(open).toFixed(1)+'" y2="'+y(open).toFixed(1)+'" stroke="#7b8294" stroke-dasharray="4 4" stroke-width="1"/>')+'<path d="'+d+'" fill="none" stroke="'+col+'" stroke-width="1.5" vector-effect="non-scaling-stroke"/>';}
poll();setInterval(poll,1000);
</script></body></html>`;
