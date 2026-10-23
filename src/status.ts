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
main{max-width:1600px;margin:0 auto;padding:36px 24px 60px}
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
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;overflow-x:auto}
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
.charts{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-top:16px}
@media(max-width:1200px){.charts{grid-template-columns:repeat(3,1fr)}}
@media(max-width:700px){.charts{grid-template-columns:repeat(2,1fr)}}
.chart{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 8px 4px}
.chart .t{display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px;white-space:nowrap}
.chart .t b{font-weight:600}
.chart svg{width:100%;display:block}
.chart .gl{stroke:var(--line);stroke-width:1}
.chart .gt{font-size:9px;fill:var(--mut);font-family:inherit}
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
  <div class="charts" id="charts"></div>
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
    <table style="margin-bottom:12px"><thead><tr><th>market</th><th>strategy</th><th class="r">size</th><th class="r">stop/day</th><th class="r">today</th><th class="r">net</th><th class="r">trades</th><th class="r">won</th><th class="r">streak</th></tr></thead><tbody id="lrules"></tbody></table><div class="note" id="lsince"></div>
    <div class="mut" id="lstate" style="font-size:12px"></div>
    <div class="mut" style="font-size:12px;margin-top:6px">Only this panel, the trade log and the "real" columns below are real orders on Polymarket, settled from your wallet.</div>
  </div>
  <div class="panel real"><div class="ph"><div class="k">real trade log <span class="tag real">real</span></div><div class="mut" id="lopen"></div></div>
    <table class="log"><tbody id="log"></tbody></table>
  </div>
</div>

<div class="panel" style="margin-bottom:14px"><div class="ph"><div class="k">real vs paper, day by day <span class="tag real">real</span><span class="tag paper">paper</span></div><div class="mut" id="cmprule"></div></div>
<table><thead><tr><th>day (korean time, midnight to midnight)</th><th class="r">real orders</th><th class="r">filled</th><th class="r">skipped</th><th class="r">no fill</th><th class="r">real won</th><th class="r">real net</th><th class="r">paper trades</th><th class="r">paper won</th><th class="r">paper net</th></tr></thead><tbody id="cmp"></tbody></table>
<div class="note">Real: orders the bot actually sent, at the live size. Paper: the same rule simulated at $20 with no money, so the two are not the same scale; compare win rates, not dollars.</div></div>

<div class="panel" style="margin-bottom:14px"><div class="ph"><div class="k">paper variants <span class="tag paper">paper · simulated, no money</span></div><div class="mut">every number here is simulated at $20 a window, no money</div></div>
<table><thead><tr><th>variant</th><th>rule</th><th class="r">trades</th><th class="r">won</th><th class="r">net</th><th class="r">open</th></tr></thead><tbody id="papers"></tbody></table><div class="note">A row tagged "live on …" is the paper copy of a rule trading real money on those markets; the real results are in the real-money panel above.</div></div>

<div class="panel" style="margin-bottom:14px"><div class="ph"><div class="k">other markets <span class="tag paper">paper · simulated, no money</span></div><div class="mut">same paper rules, recording only</div></div>
<table><thead><tr><th>market</th><th>window</th><th class="r">up ask</th><th class="r">down ask</th><th class="r">settled</th><th class="r">real</th><th class="r">base</th><th class="r">band80-30</th><th class="r">band80-30-chase</th><th class="r">band80-30-j70</th><th class="r">cheap10-first90</th><th class="r">fav93</th><th class="r">fav93-mid</th><th class="r">cheap12-first60</th></tr></thead><tbody id="series"></tbody></table></div>

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
function cls(n){return n==null?"":n<0?"bad":n>0?"ok":""}
async function poll(){try{var s=await (await fetch("/api/status")).json();
var b=s.lastBook||{};var L=s.live||{mode:"off"};
var OL=(s.series||[]).map(function(r){return r.live}).filter(function(l){return l&&l.mode!=="off"});
var ALL=[L].concat(OL);var sum=function(k){return ALL.reduce(function(a,l){return a+(l[k]||0)},0)};
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
feedChart("btc5m","BTC 5m",300,s);(s.series||[]).forEach(function(r){feedChart(r.series||r.label,r.label,/15m/.test(r.label)?900:300,r)});drawCharts();
el("lrule").textContent=ALL.filter(function(l){return l.mode!=="off"}).length+" live";
el("lsince").textContent=L.statsSince?"strategy rows count real trades since "+new Date(L.statsSince).toLocaleString("en-GB",{timeZone:"Asia/Seoul",hour12:false})+" KST; the totals above cover everything":"";
el("lrules").innerHTML=ALL.filter(function(l){return l.mode!=="off"}).map(function(l){var vs=(l.variants&&l.variants.length)?l.variants:[{variant:l.variant,size:l.size,trades:l.trades,won:l.won,net:l.net,halted:false,streak:0,haltAfterLosses:0}];return vs.map(function(v,i){return '<tr class="'+(v.halted?"dim":"")+'"><td>'+(i?'':(l.label||"BTC 5m"))+'</td><td><b>'+v.variant+'</b>'+(l.mode==="dry"?' <span class="mut">dry</span>':'')+(v.halted?' <span class="tag bad">halted</span>':'')+'</td><td class="r">$'+v.size+'</td><td class="r">'+(i?'':'-$'+l.maxLossPerDay)+'</td><td class="r '+(i?'mut':cls(l.todayNet))+'">'+(i?'':signed(l.todayNet))+'</td><td class="r '+cls(v.net)+'">'+signed(v.net)+'</td><td class="r">'+v.trades+'</td><td class="r">'+(v.trades?Math.round(v.won/v.trades*100)+"%":"—")+'</td><td class="r '+(v.streak?"bad":"mut")+'">'+(v.haltAfterLosses?(v.streak+"/"+v.haltAfterLosses):"")+'</td></tr>'}).join("")}).join("")||'<tr><td class="empty" colspan="9">real orders are off</td></tr>';
el("bal").textContent=money(L.balance);
var tn=sum("todayNet"),an=sum("net"),tr=sum("trades"),wn=sum("won");
el("today").textContent=signed(tn);el("today").className="v big "+cls(tn);
el("net").textContent=signed(an);el("net").className="v big "+cls(an);
el("ltr").textContent=tr;
el("lwon").textContent=tr?Math.round(wn/tr*100)+"%":"—";
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
var nopen=sum("open");el("lopen").textContent=nopen?nopen+" open":"";
var rows=[];ALL.forEach(function(l){(l.recent||[]).forEach(function(t){rows.push(Object.assign({mk:l.label||"BTC 5m"},t))})});
rows.sort(function(a,b){return (b.t||0)-(a.t||0)});rows=rows.slice(0,40);
function openState(t){if(t.shares<=0)return {txt:"open",c:"mut"};var win="+"+money(t.shares-t.cost)+" if win";
if(t.window!==s.window)return {txt:"waiting for result · "+win,c:"mut"};
var up=(b.chainlink!=null&&b.open!=null)?(b.chainlink>b.open?1:b.chainlink<b.open?-1:0):null;
var mine=t.side==="UP"?b.upAsk:b.downAsk;var mk=mine!=null?" · "+cents(mine):"";
if(up==null)return {txt:"open"+mk+" · "+win,c:"mut"};
var ahead=up===0?0:(up>0)===(t.side==="UP")?1:-1;
return {txt:(ahead>0?"ahead":ahead<0?"behind":"even")+mk+" · "+win,c:ahead>0?"ok":ahead<0?"bad":"mut"}}
el("log").innerHTML=rows.length?rows.map(function(t){var o=t.pnl==null&&t.ok&&!t.dry?openState(t):null;var res=o?o.txt:t.pnl==null?(t.ok?"dry":t.status==="skipped"?"skipped":"no fill"):signed(t.pnl);var c=o?o.c:t.pnl==null?"mut":cls(t.pnl);var px=t.shares>0?Math.round(t.cost/t.shares*100)+"¢":cents(t.ask);return '<tr class="'+(t.ok?"":"dim")+'"><td>'+hhmm(t.window)+'</td><td class="'+(t.side==="UP"?"ok":"bad")+'">'+(OL.length?'<span class="mut">'+t.mk.replace(" 5m","")+'</span> ':"")+t.side+'</td><td class="mut">'+(t.variant||"")+'</td><td>'+px+(t.shares>0?" × "+t.shares.toFixed(1):"")+'</td><td class="r">'+(t.cost>0?money(t.cost):"")+'</td><td class="r '+c+'">'+res+'</td></tr>'}).join(""):'<tr><td class="empty" colspan="6">no filled orders yet</td></tr>';
el("papers").innerHTML=(s.papers||[]).map(function(p){return '<tr class="'+(p.name===L.variant&&L.mode!=="off"?"hi":"")+'"><td>'+p.name+(function(){var on=ALL.filter(function(l){return l.mode!=="off"&&((l.variants||[]).some(function(v){return v.variant===p.name&&!v.halted})||(!(l.variants||[]).length&&l.variant===p.name))}).map(function(l){return (l.label||"BTC 5m").replace(" 5m","")});return on.length?' <span class="tag real">live on '+on.join(", ")+'</span>':""})()+'</td><td class="mut">'+p.rule+'</td><td class="r">'+p.trades+'</td><td class="r">'+(p.trades?Math.round(p.won/p.trades*100)+"%":"—")+'</td><td class="r '+cls(p.net)+'">'+signed(p.net)+'</td><td class="r">'+(p.open||"")+'</td></tr>'}).join("");
function pv(ps,name){var p=(ps||[]).filter(function(x){return x.name===name})[0];if(!p||!p.trades)return '<td class="r mut">—</td>';return '<td class="r '+cls(p.net)+'">'+signed(p.net)+' <span class="mut">'+p.won+'/'+p.trades+'</span></td>'}
el("series").innerHTML=(s.series||[]).length?(s.series||[]).map(function(r){var rb=r.lastBook||{};return '<tr><td>'+r.label+(r.lastError?' <span class="bad" title="'+esc(r.lastError)+'">!</span>':"")+'</td><td class="mut">'+(r.window?hhmm(r.window):"—")+(r.listed?"":" · not listed")+'</td><td class="r">'+cents(rb.upAsk)+'</td><td class="r">'+cents(rb.downAsk)+'</td><td class="r">'+r.windowsResolved+'</td>'+(r.live&&r.live.mode!=="off"?'<td class="r '+cls(r.live.net)+'">'+signed(r.live.net)+' <span class="mut">'+r.live.won+'/'+r.live.trades+(r.live.open?' · '+r.live.open+' open':'')+'</span></td>':'<td class="r mut">—</td>')+pv(r.papers,"base")+pv(r.papers,"band80-30")+pv(r.papers,"band80-30-chase")+pv(r.papers,"band80-30-j70")+pv(r.papers,"cheap10-first90")+pv(r.papers,"fav93")+pv(r.papers,"fav93-mid")+pv(r.papers,"cheap12-first60")+'</tr>'}).join(""):'<tr><td class="empty" colspan="14">only the BTC 5m market is recorded</td></tr>';
el("feeds").innerHTML=s.feeds.map(function(f){return '<tr><td>'+f.name+'</td><td class="'+(f.healthy?"ok":"bad")+'">'+(f.healthy?"live":"down")+'</td><td class="r">'+money(f.last&&f.last.price)+'</td><td class="r">'+(f.last?Math.round((Date.now()-f.last.t)/1000)+"s":"—")+'</td><td class="r">'+f.ticks+'</td></tr>'}).join("");
el("wd").textContent=s.windowsDone;el("ws").textContent=s.windowsResolved;el("wp").textContent=s.pending;el("sn").textContent=s.snapshots;
el("err").textContent=s.lastError?"last error: "+s.lastError:"";
el("note").textContent="Paper rule: "+s.paper.rule+". Data is in the data/ folder next to the app. Set \\"mode\\" to \\"off\\" in data/live.json to stop real orders.";
}catch(e){el("sub").textContent="status unavailable"}}
var H={};
function feedChart(key,label,sec,r){var b=r.lastBook;if(!b||b.window==null)return;var h=H[key];if(!h||h.w!==b.window){h=H[key]={w:b.window,sec:sec,label:label,pts:[],open:null,lastT:null}}
h.left=b.left;h.up=b.upAsk;h.down=b.downAsk;if(b.open!=null)h.open=b.open;h.last=b.chainlink;
if(b.chainlink!=null&&b.t!==h.lastT){h.lastT=b.t;var x=Math.max(0,Math.min(1,1-b.left/sec));h.pts.push({x:x,p:b.chainlink})}}
function drawCharts(){var W=220,HT=92,L=40,R=6,T=6,B=14,pw=W-L-R,ph=HT-T-B;
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
return '<div class="chart"><div class="t"><span><b>'+h.label+'</b> <span class="mut">'+lf+'</span></span><span class="'+(col==="#3ddc84"?"ok":col==="#ff6b6b"?"bad":"mut")+'">'+dl+'</span></div><svg viewBox="0 0 '+W+' '+HT+'">'+g+'</svg><div class="t"><span class="mut">'+money(h.last)+'</span><span><span class="ok">UP '+cents(h.up)+'</span> <span class="bad">DOWN '+cents(h.down)+'</span></span></div></div>'}).join("")}
poll();setInterval(poll,1000);
</script></body></html>`;
