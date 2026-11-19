/**
 * Dashboard only: the "Paper tests" tab (19 Nov 2026, enrique: "okay paper test it"): Hyperliquid vault deposits,
 * funding carry and Base mid cap copies (src/lab/). Everything on it is paper and says so. Laid out like the other
 * tabs: a figures strip, bars, then the same position tables (ptab) every tab uses. Filled from /api/lab.
 */
export const LAB_BTN = '<div class="gb" role="button" tabindex="0" data-g="lab"><span class="gn"><i class="gd" id="gd-l"></i>Paper tests</span><span class="gv" id="gv-l">—</span><span class="n" id="grp-l"></span><span class="ga" id="ga-l"></span></div>';

const panel = (id: string, title: string) =>
  `<div class="panel" style="margin-bottom:14px"><div class="ph"><div class="k">${title} <span class="tag paper">paper · no money</span></div><div class="mut" id="${id}-sub"></div></div><div class="stats" id="${id}-st"><span class="mut">waiting for the first reading</span></div><div id="${id}-viz"></div><div id="${id}-a"></div><div id="${id}-b"></div><div id="${id}-c"></div><div class="note" id="${id}-n"></div></div>`;

export const LAB_HTML = `<section class="sec hide" id="sec-lab">
${panel("lv", "Hyperliquid vaults · $100 in each")}
${panel("lc", "Funding carry · spot + short on Hyperliquid")}
${panel("lb", "Base mid cap copies · $100 a copy")}
</section>`;

export const LAB_CSS = `.lbar{display:grid;grid-template-columns:minmax(0,18ch) minmax(0,1fr) 7ch 9ch;gap:8px;align-items:center;font-size:12px;padding:5px 0;border-top:1px solid var(--line)}.lbar:first-child{border-top:none}.lbar b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lbar .tr{height:8px;border-radius:4px;background:var(--line);overflow:hidden}.lbar .tr i{display:block;height:100%;border-radius:4px;background:var(--up);transition:width .8s}.lbar .tr i.neg{background:var(--down)}.lbar span{text-align:right;white-space:nowrap}.ltile{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:12px 0}.ltile>div{border:1px solid var(--line);border-radius:10px;padding:10px 12px;min-width:0}.ltile .v{font-size:18px;font-weight:700}.ltile i{font-style:normal;display:block;font-size:11px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lt{width:100%;font-size:12px;margin-top:10px}.lt th{font-size:10px;text-transform:uppercase;color:var(--mut);font-weight:400;text-align:left}.lt td,.lt th{padding:5px 4px;border-top:1px solid var(--line)}.lt .r{text-align:right}.lt td i{font-style:normal;display:block;font-size:10px;color:var(--mut)}.lh{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);margin:14px 0 4px}#sec-lab .stats{margin-bottom:6px}#sec-lab .note{margin-top:10px;white-space:normal;line-height:1.5}.lerr{color:var(--down);font-size:11px;margin-top:6px}.secs.grp .gb[data-g=lab] .gv{color:var(--pur)}@media(max-width:700px){.secs.grp .gb[data-g=lab]{grid-column:1/-1}.lt .hx{display:none}.lbar{grid-template-columns:minmax(0,11ch) minmax(0,1fr) 7ch 6ch;gap:6px;font-size:11px}.lt{font-size:11px;table-layout:fixed}.lt th:first-child{width:46%}.lt td{overflow:hidden;text-overflow:ellipsis}}#sec-lab .chip{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--line);border-radius:999px;padding:3px 10px;margin:0 6px 6px 0;font-size:12px}`;

// Plain browser script (no template marks inside). Uses the page's own helpers: el, money, signed, cls, ptab.
export const LAB_JS = `
(function(){
var esc=function(x){return String(x==null?"":x).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})};
var big=function(n){n=+n||0;return n>=1e9?"$"+(n/1e9).toFixed(1)+"B":n>=1e6?"$"+(n/1e6).toFixed(n>=1e7?0:1)+"M":n>=1e3?"$"+Math.round(n/1e3)+"k":"$"+Math.round(n)};
var sg=function(v){return v==null?'<span class="mut">—</span>':'<span class="'+(Math.abs(v)<0.005?"mut":cls(v))+'">'+(Math.abs(v)<0.005?"$0.00":signed(Math.round(v*100)/100))+'</span>'};
var pct=function(p){return p==null?'<span class="mut">—</span>':'<span class="'+(p>0?"ok":p<0?"bad":"mut")+'">'+(p>0?"+":"")+p+'%</span>'};
var stat=function(k,v,s){return '<div><div class="k">'+k+'</div><div class="v big">'+v+'</div>'+(s?'<span class="hsb">'+s+'</span>':'')+'</div>'};
var days=function(d){return d==null?"":d<1?Math.round(d*24)+" h":(Math.round(d*10)/10)+" days"};
var set=function(id,h){var e=el(id);if(e&&e.__h!==h){e.__h=h;e.innerHTML=h}};
var spark=function(H){if(!H||H.length<3)return "";var lo=1e99,hi=-1e99;H.forEach(function(p){lo=Math.min(lo,p[1]);hi=Math.max(hi,p[1])});lo=Math.min(lo,0);hi=Math.max(hi,0);var sp=(hi-lo)||1,t0=H[0][0],tt=(H[H.length-1][0]-t0)||1;var pts=H.map(function(p){return (100*(p[0]-t0)/tt).toFixed(1)+","+(38-36*(p[1]-lo)/sp).toFixed(1)}).join(" ");var z=(38-36*(0-lo)/sp).toFixed(1);var up=H[H.length-1][1]>=0;return '<svg viewBox="0 0 100 40" preserveAspectRatio="none" style="width:100%;height:56px;margin:8px 0"><line x1="0" x2="100" y1="'+z+'" y2="'+z+'" stroke="var(--line)" stroke-width=".6"/><polyline points="'+pts+'" fill="none" stroke="var('+(up?"--up":"--down")+')" stroke-width="1.2" vector-effect="non-scaling-stroke"/></svg>'};
var bars=function(R,max,f){return R.map(function(r){var w=Math.max(2,Math.min(100,100*Math.abs(r.v)/(max||1)));return '<div class="lbar"><b>'+r.n+'</b><div class="tr"><i class="'+(r.v<0?"neg":"")+'" style="width:'+w.toFixed(0)+'%"></i></div><span>'+f(r)+'</span><span class="mut">'+(r.x||"")+'</span></div>'}).join("")};
var err=function(e){return e?'<div class="lerr">last reading failed: '+esc(e)+' · tried again by itself</div>':""};
var BN={"hl-pick":"Hyperliquid spot · best rates","kraken-pick":"Kraken spot · best rates","hl-btc":"Hyperliquid spot · BTC only","kraken-btc":"Kraken spot · BTC only"};
function render(L){
 if(!L||!L.on){set("lv-st",'<span class="mut">paper tests are off on this machine</span>');return}
 var V=L.vaults,C=L.carry,B=L.base;
 var cu=C.books.reduce(function(a,b){return a+b.usd},0),bu=B.usd+B.openUsd,tot=V.usd+cu+bu;
 var g=el("gv-l");if(g)g.innerHTML=sg(tot).replace(/class="(ok|bad)"/,"");var gt=el("grp-l");if(gt)gt.textContent="paper";
 // vaults
 set("lv-sub",V.n?V.n+" vaults · "+days(V.days):"");
 set("lv-st",V.n?stat("result",sg(V.usd),"on "+money(V.inUsd)+" · after the leaders' cut")+stat("return",pct(V.pct))+stat("vaults ahead",V.ahead+" / "+V.n)+stat("running",days(V.days)||"just started"):'<span class="mut">'+(V.error?"no reading yet":"picking vaults")+'</span>');
 set("lv-viz",spark(V.hist));
 var mx=Math.max.apply(null,V.rows.map(function(r){return Math.abs(r.usd)}).concat([0.5]));
 set("lv-a",V.rows.length?'<div class="lh">our $100 in each</div>'+bars(V.rows.map(function(r){return {n:esc(r.name),v:r.usd,x:big(r.tvlUsd),r:r}}),mx,function(r){return sg(r.v)}):"");
 set("lv-b",V.rows.length?'<table class="lt"><thead><tr><th>vault</th><th class="r">in vault</th><th class="r">month</th><th class="r hx">all time</th><th class="r hx">leader cut</th><th class="r hx">our worst dip</th></tr></thead><tbody>'+V.rows.map(function(r){return '<tr><td><b>'+esc(r.name)+'</b>'+(r.closed?'<i>closed</i>':'')+'</td><td class="r">'+big(r.tvlUsd)+'</td><td class="r">'+big(r.monthUsd)+'</td><td class="r hx">'+big(r.allUsd)+'</td><td class="r hx">'+r.cutPct+'%</td><td class="r hx">'+(r.maxDdPct?"-"+r.maxDdPct+"%":"—")+'</td></tr>'}).join("")+'</tbody></table>':"");
 set("lv-n",(V.pass!=null?V.pass+" of "+V.listed+" open vaults hold "+big(V.floors.tvlUsd)+"+, are "+V.floors.ageD+"+ days old and are ahead; the "+V.n+" that made the most dollars this month got a pretend $100. ":"")+"Past months are the vault's record, not ours: only the result above is what a deposit made since we started."+err(V.error));
 // carry
 set("lc-sub",C.lastMs?"read hourly":"");
 var fu=C.books.reduce(function(a,b){return a+b.fundingUsd},0),fe=C.books.reduce(function(a,b){return a+b.feesUsd},0),op=C.books.reduce(function(a,b){return a+b.opens.length},0);
 set("lc-st",C.lastMs?stat("result",sg(cu),"four books together")+stat("funding paid to us",sg(fu))+stat("fees and costs",sg(-fe))+stat("open",String(op)):'<span class="mut">no reading yet</span>');
 set("lc-viz",'<div class="ltile">'+C.books.map(function(b){return '<div><i>'+BN[b.id]+'</i><div class="v">'+sg(b.usd)+'</div><i>funding '+sg(b.fundingUsd).replace(/<[^>]*>/g,"")+' · costs -$'+b.feesUsd.toFixed(2)+'</i><i>'+(b.opens.length?b.opens.map(function(o){return o.coin}).join(" "):"nothing pays enough now")+(b.days?" · "+days(b.days):"")+'</i></div>'}).join("")+'</div>');
 var rm=Math.max.apply(null,C.rates.map(function(r){return Math.abs(r.d7)}).concat([10]));
 set("lc-a",C.rates.length?'<div class="lh">what shorts are paid a year · 7-day average</div>'+bars(C.rates.map(function(r){return {n:esc(r.coin),v:r.d7,x:r.hl&&r.kraken?"both":r.hl?"HL":"Kraken",r:r}}),rm,function(r){return pct(r.v)}):"");
 var OS=[];C.books.forEach(function(b){b.opens.forEach(function(o){OS.push({coin:o.coin,lc:o.coin,sub:(b.venue==="hl"?"HL":"Kraken")+" spot · funding "+(o.fundingUsd>=0?"+":"-")+"$"+Math.abs(o.fundingUsd).toFixed(2),paid:o.paid,usd:o.usd,held:o.held,t:o.t})})});
 var CS=[];C.books.forEach(function(b){b.log.forEach(function(o){CS.push({coin:o.coin,lc:o.coin,sub:BN[b.id].split(" · ")[0],usd:o.usd,held:o.held,t:o.t})})});CS.sort(function(a,b){return b.t-a.t});
 set("lc-b",ptab("open","result if closed now, closing fees taken",OS,false));
 set("lc-c",ptab("closed","newest first",CS.slice(0,12),true));
 set("lc-n","Half of each $"+C.posUsd+" buys the coin, half backs the short, so funding is earned on half the money. A full in and out costs "+C.rule.roundTripPct.hl+"% on Hyperliquid spot and "+C.rule.roundTripPct.kraken+"% with Kraken spot, plus $4 once to move money to and from Kraken. A coin is taken at "+C.rule.enter7dPct+"%+ a year over 7 days and dropped under "+C.rule.exit3dPct+"% over 3."+err(C.error||C.krakenError));
 // base
 set("lb-sub",B.coins.length?B.coins.length+" coins · "+B.followed+" wallets followed":"");
 set("lb-st",B.coins.length?stat("closed copies",sg(B.usd),B.closed?B.won+" of "+B.closed+" won":"none closed yet")+stat("open now",sg(B.openUsd),B.opens.length+" open")+stat("wallets followed",String(B.followed),"of "+B.walletsSeen+" seen")+stat("at the real bar",String(B.passing),"10+ copies, half won, ahead"):'<span class="mut">'+(B.error?"no reading yet":"reading the coins")+'</span>');
 set("lb-a",B.wallets.length?'<table class="lt"><thead><tr><th>wallet</th><th class="r">usual buy</th><th class="r hx">its own trades</th><th class="r">our copies</th><th class="r">result</th></tr></thead><tbody>'+B.wallets.slice(0,15).map(function(w){return '<tr><td><b>'+esc(w.id)+'</b>'+(w.pass?' <span class="tag real">at the bar</span>':'')+'</td><td class="r">'+big(w.usualBuyUsd)+'</td><td class="r hx">'+(w.ownTrips?w.ownWon+"/"+w.ownTrips+" · "+(w.ownUsd<0?"-":"+")+big(Math.abs(w.ownUsd)):"—")+'</td><td class="r">'+(w.copies?w.won+"/"+w.copies:"—")+(w.open?' <span class="mut">+'+w.open+' open</span>':'')+'</td><td class="r">'+(w.copies?sg(w.usd):'<span class="mut">—</span>')+'</td></tr>'}).join("")+'</tbody></table>':"");
 set("lb-b",ptab("open","at the coin's last traded price, costs taken",B.opens,false));
 set("lb-c",ptab("closed","newest first",B.log.slice(0,12),true));
 set("lb-n",(B.coins.length?'<div style="margin-bottom:6px">'+B.coins.slice(0,24).map(function(c){return '<span class="chip">'+esc(c.coin)+' <span class="mut">'+big(c.mcapUsd)+'</span></span>'}).join("")+'</div>':"")+"Coins of "+big(B.floors.mcapUsd)+"+ with "+big(B.floors.liqUsd)+"+ in the pool, 30+ days old. Wallets whose usual buy is "+big(B.floors.usualBuyUsd)+"+; machines left out. We buy minutes after the wallet at the price then, 1% taken for fees and slip. Wallet balances are not read yet."+err(B.error));
}
window.labPoll=function(){fetch("/api/lab").then(function(r){return r.json()}).then(function(L){window.LAB=L;try{render(L)}catch(e){console.error("lab",e)}}).catch(function(){})};
setInterval(function(){if(SEC==="lab"||!window.LAB)window.labPoll()},60000);setTimeout(window.labPoll,1500);
})();
`;
