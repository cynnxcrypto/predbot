/**
 * Dashboard only: the "Paper tests" tab (19 Nov 2026, enrique: "okay paper test it"): Hyperliquid vault deposits,
 * funding carry and Base mid cap copies (src/lab/). Everything on it is paper and says so. Laid out like the other
 * tabs: a figures strip, bars, then the same position tables (ptab) every tab uses. Filled from /api/lab.
 */
export const LAB_BTN = '<div class="gb" role="button" tabindex="0" data-g="lab"><span class="gn"><i class="gd" id="gd-l"></i>Paper tests</span><span class="gv" id="gv-l">—</span><span class="n" id="grp-l"></span><span class="ga" id="ga-l"></span></div>';

const panel = (id: string, title: string) =>
  `<div class="panel" style="margin-bottom:14px"><div class="ph"><div class="k">${title} <span class="tag paper">paper · no money</span></div><div class="mut" id="${id}-sub"></div></div><div class="stats" id="${id}-st"><span class="mut">waiting for the first reading</span></div><div id="${id}-viz"></div><div id="${id}-a"></div><div id="${id}-b"></div><div id="${id}-c"></div><div class="note" id="${id}-n"></div></div>`;

// The Base tab (19 Nov 2026, enrique: "where's the new base tab we said?"): real Base copies first, then the paper copies, then bridge moves.
export const BASE_BTN = '<div class="gb" role="button" tabindex="0" data-g="base"><span class="gn"><i class="gd" id="gd-b"></i>Base</span><span class="gv" id="gv-b">—</span><span class="n" id="grp-b"></span><span class="ga" id="ga-b"></span></div>';

export const LAB_HTML = `<section class="sec hide" id="sec-lab">
${panel("lv", "Hyperliquid vaults · $100 in each")}
${panel("lc", "Funding carry · spot + short on Hyperliquid")}
<div class="note">Base copies have their own tab: Base.</div>
</section>
<section class="sec hide" id="sec-base">
<div class="grid" id="bs-r">
  <div class="panel"><div class="ph"><div class="k">real money <span class="tag real">real</span></div><div class="mut" id="bs-rst"></div></div><div class="stats" id="bs-rs"><span class="mut">waiting for the first reading</span></div><div id="bs-rviz"></div><div id="bs-rtiles"></div><div id="bs-rtbl"></div></div>
  <div class="panel"><div class="ph"><div class="k">real trade log <span class="tag real">real</span></div><div class="mut" id="bs-rsub"></div></div><div id="bs-rbars"></div><div id="bs-rlist"></div></div>
</div>
<div class="grid" id="bs-p">
  <div class="panel"><div class="ph"><div class="k">paper copies <span class="tag paper">paper</span></div><div class="mut" id="bs-pst"></div></div><div class="stats" id="bs-ps"><span class="mut">waiting for the first reading</span></div><div id="bs-pviz"></div><div id="bs-ptiles"></div><div id="bs-ptbl"></div></div>
  <div class="panel"><div class="ph"><div class="k">paper trade log <span class="tag paper">paper</span></div><div class="mut" id="bs-psub"></div></div><div id="bs-pbars"></div><div id="bs-plist"></div></div>
</div>
<div class="panel" style="margin-bottom:14px"><div class="ph"><div class="k">money moved to and from Base</div><div class="mut" id="bs-xsub"></div></div><div id="bs-x"><div class="empty">no money moved to Base yet</div></div></div>
</section>`;

export const LAB_CSS = `.lbar{display:grid;grid-template-columns:minmax(0,18ch) minmax(0,1fr) 7ch 9ch;gap:8px;align-items:center;font-size:12px;padding:5px 0;border-top:1px solid var(--line)}.lbar:first-child{border-top:none}.lbar b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lbar .tr{height:8px;border-radius:4px;background:var(--line);overflow:hidden}.lbar .tr i{display:block;height:100%;border-radius:4px;background:var(--up);transition:width .8s}.lbar .tr i.neg{background:var(--down)}.lbar span{text-align:right;white-space:nowrap}.ltile{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:12px 0}.ltile>div{border:1px solid var(--line);border-radius:10px;padding:10px 12px;min-width:0}.ltile .v{font-size:18px;font-weight:700}.ltile i{font-style:normal;display:block;font-size:11px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lt{width:100%;font-size:12px;margin-top:10px}.lt th{font-size:10px;text-transform:uppercase;color:var(--mut);font-weight:400;text-align:left}.lt td,.lt th{padding:5px 4px;border-top:1px solid var(--line)}.lt .r{text-align:right}.lt td i{font-style:normal;display:block;font-size:10px;color:var(--mut)}.lh{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);margin:14px 0 4px}#sec-lab .stats{margin-bottom:6px}#sec-lab .note{margin-top:10px;white-space:normal;line-height:1.5}.lerr{color:var(--down);font-size:11px;margin-top:6px}.secs.grp .gb[data-g=lab] .gv{color:var(--pur)}@media(max-width:700px){.secs.grp .gb[data-g=lab]{grid-column:1/-1}.lt .hx{display:none}.lbar{grid-template-columns:minmax(0,11ch) minmax(0,1fr) 7ch 6ch;gap:6px;font-size:11px}.lt{font-size:11px;table-layout:fixed}.lt th:first-child{width:46%}.lt td{overflow:hidden;text-overflow:ellipsis}}`;

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
 var cu=C.books.reduce(function(a,b){return a+b.usd},0),tot=V.usd+cu;
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
 // the Base tab: built from the same parts as the Solana spot copy tab (figures, bars, tiles, wallet table, trade log)
 var lt3=function(k,v,c){return '<div><div class="k">'+k+'</div><div class="v" style="font-size:18px;font-weight:600"><span class="'+(c||"")+'">'+v+'</span></div></div>'};
 var vb3=function(l,r,g){return '<div class="vb"><div class="hl"><span>'+l+'</span><span>'+r+'</span></div><div class="vt">'+g.map(function(x){return x[0]>0?'<i style="width:'+Math.min(100,x[0]).toFixed(1)+'%;background:var(--'+x[1]+')"></i>':''}).join("")+'</div></div>'};
 var SD=function(v){return v==null?"—":Math.abs(v)<0.005?"even":signed(Math.round(v*100)/100)},sc3=function(v){return v==null||Math.abs(v)<0.005?"mut":cls(v)};
 var hm=function(m){return m==null?"":m<100?Math.round(m)+"m":(m/60).toFixed(1)+"h"};
 var tiles=function(O){var T=O.map(function(o){return {o:o,pc:o.usd==null||!o.paid?null:Math.round(100*o.usd/o.paid)}}).sort(function(a,b){return (b.pc==null?-999:b.pc)-(a.pc==null?-999:a.pc)});return T.length?'<div class="k" style="margin:14px 0 6px">coins held now</div><div class="sctl">'+T.map(function(x){var a=x.pc==null?0:Math.min(60,10+Math.abs(x.pc)*2);var col=x.pc==null||x.pc===0?"mut":x.pc>0?"up":"down";return '<div title="'+esc(x.o.sub)+' · held '+hm(x.o.held)+'" style="background:color-mix(in srgb,var(--'+col+') '+a+'%,transparent)"><b>'+esc(x.o.coin)+'</b><span>'+(x.pc==null?"—":(x.pc>0?"+":"")+x.pc+"%")+'</span></div>'}).join("")+'</div>':""};
 var wonlost=function(w,c){var l=Math.max(0,c-w);return c?vb3('<b class="ok">'+w+'</b> won','<b class="bad">'+l+'</b> lost',[[w/c*100,"up"],[l/c*100,"down"]]):""};
 var tlog=function(p,O,LG,nClosed,note,empty){set(p+"sub",O.length+" open · "+nClosed+" closed");var BR=LG.slice(0,40).reverse(),mx=0;BR.forEach(function(x){mx=Math.max(mx,Math.abs(+x.usd||0))});
  set(p+"bars",BR.length>1?'<div class="lbw"><div class="lbars">'+BR.map(function(x){var v=+x.usd||0;var h=mx?Math.max(4,Math.abs(v)/mx*50):4;return '<i title="'+SD(v)+'"><b style="height:'+h.toFixed(0)+'%;'+(v<0?"top:50%;background:var(--down)":"bottom:50%;background:var(--up)")+'"></b></i>'}).join("")+'</div><div class="hl"><span>last '+BR.length+' results</span><span>newest →</span></div></div>':"");
  var OS=O.slice().sort(function(a,b){return (b.usd==null?-1e9:b.usd)-(a.usd==null?-1e9:a.usd)});
  set(p+"list",(ptab("open",note,OS,false)+ptab("closed","newest first",LG.slice(0,20),true))||'<div class="empty">'+empty+'</div>')};
 var wrow=function(w){var c=w.copies||0,wp=c?Math.round(100*w.won/c):null;var own=[];own.push("usual buy <b>"+big(w.usualBuyUsd)+"</b>");if(w.ownTrips)own.push("its own trades "+w.ownWon+" of "+w.ownTrips+" won · "+(w.ownUsd<0?"-":"+")+big(Math.abs(w.ownUsd)));
  return '<tr class="m'+(w.cut?" dim":"")+'"><td class="nw"><span class="dot'+(w.pass?" on":w.cut?" dm":" nw2")+'"></span><span style="display:inline-block;min-width:74px"><span class="wtg wlk">'+esc(w.id)+'</span></span> <span class="wsg'+(w.pass?" on":w.cut?" rs":"")+'">'+(w.pass?"at the real bar":w.cut?"dropped · behind on "+(w.cut==="own"?"its own trades":"our copies"):"on paper")+'</span><span class="tsz">'+own.join(" · ")+'</span></td><td class="r nw">'+(w.open||0)+'</td><td class="r nw nm">'+c+'</td><td class="r nw">'+(wp==null?"—":wp+'%<span class="wb"><i style="width:'+wp+'%"></i></span>')+'</td><td class="r nw '+(c?sc3(w.usd):"mut")+'"><b>'+(c?SD(w.usd):"—")+'</b></td></tr>'};
 var wtbl=function(W,last){return '<div class="rtw"><table><thead><tr><th>wallet</th><th class="r">open</th><th class="r nm">closed</th><th class="r">won</th><th class="r">'+last+'</th></tr></thead><tbody>'+W.map(wrow).join("")+'</tbody></table></div>'};
 var WP=B.wallets.filter(function(w){return w.pass}),WA=B.wallets.filter(function(w){return !w.cut}),WC=B.wallets.filter(function(w){return w.cut});
 // real money (off until the sizes are given)
 var R=L.baseReal;if(R){var live=R.on&&!R.lossStop,ro=0,rn=0;R.opens.forEach(function(o){if(o.usd!=null){ro+=o.usd;rn++}});
 set("bs-rst",!R.wallet?"no wallet yet":R.lossStop?"stopped at the loss limit":R.on?"on · "+WP.length+" wallets copied":"off · waiting for your sizes");
 set("bs-rs",lt3("cash",R.usdc==null?"—":money(R.usdc))+lt3("all time",SD(R.usd),sc3(R.usd))+lt3("open now",rn?SD(ro):"—",rn?sc3(ro):"")+lt3("closed",String(R.closed||0))+lt3("holding",String(R.opens.length))+lt3("gas",R.eth==null?"—":(R.gasLow||R.eth<0.0003)?"low":"ok",R.eth==null?"":(R.gasLow||R.eth<0.0003)?"bad":"ok"));
 var cap=R.switch?+R.switch.maxLossUsd||0:0,used=Math.max(0,-(+R.usd||0));
 set("bs-rviz",wonlost(R.won||0,R.closed||0)+(cap?vb3("loss limit "+money(cap),'<b>'+money(Math.max(0,cap-used))+'</b> left',[[Math.min(100,100*used/cap),"down"]]):""));
 set("bs-rtiles",tiles(R.opens));
 set("bs-rtbl",'<div class="k" style="margin:14px 0 2px">wallets we copy · real</div><div class="mut" style="font-size:12px;margin:2px 0 6px">'+(live?"":"none copied while real is off · ")+'<b style="color:var(--up)">'+WP.length+'</b> at the real bar · 10+ paper copies, half won, ahead</div>'+(WP.length?wtbl(WP,"paper"):'<div class="empty" style="padding:8px 0;text-align:left">no wallet is at the real bar yet</div>')+err(R.error));
 tlog("bs-r",R.opens,R.log,R.closed||0,"sells when the wallet sells · 72 h max",live?"no copy yet":"no real copy yet · real Base copies are off");
 var rw=R.usdc==null?null:R.usdc+(+R.inCoinsUsd||0);var gb=el("gv-b");if(gb)gb.textContent=rw==null?"—":"≈ "+money(rw);var gt2=el("grp-b");if(gt2)gt2.innerHTML=live?'<span class="ok">real on</span>':"real off"}
 // paper copies
 set("bs-pst",B.coins.length?B.coins.length+" coins · "+B.followed+" of "+B.walletsSeen+" wallets followed":B.error?"no reading yet":"reading the coins");
 set("bs-ps",lt3("all time",SD(B.usd),sc3(B.usd))+lt3("open now",B.opens.length?SD(B.openUsd):"—",B.opens.length?sc3(B.openUsd):"")+lt3("closed",String(B.closed||0))+lt3("holding",String(B.opens.length))+lt3("at the real bar",String(B.passing)));
 set("bs-pviz",wonlost(B.won||0,B.closed||0));
 set("bs-ptiles",tiles(B.opens));
 set("bs-ptbl",(B.wallets.length?'<div class="k" style="margin:14px 0 2px">wallets we follow · paper</div><div class="mut" style="font-size:12px;margin:2px 0 6px"><b style="color:var(--up)">'+WP.length+'</b> at the real bar · <b style="color:var(--fg)">'+(WA.length-WP.length)+'</b> on paper · <b style="color:var(--down)">'+WC.length+'</b> dropped</div>'+(WA.length?wtbl(WA.slice(0,15),"paper"):"")+(WC.length?'<details class="bkd"><summary>'+WC.length+' wallets dropped for being behind</summary>'+wtbl(WC.slice(0,15),"paper")+'</details>':""):"")+(B.coins.length?'<details class="bkd"><summary>'+B.coins.length+' coins watched · '+big(B.floors.mcapUsd)+'+ with '+big(B.floors.liqUsd)+'+ in the pool</summary><div class="wps" style="margin-top:8px">'+B.coins.map(function(c){return '<span class="wpf">'+esc(c.coin)+' <i class="mut">'+big(c.mcapUsd)+'</i></span>'}).join("")+'</div></details>':"")+err(B.error));
 tlog("bs-p",B.opens,B.log,B.closed||0,"sells when the wallet sells · 72 h max · costs taken","no paper copy yet");
 // money moved between Base and the other wallets (the bridge), in the same table as trades
 var PL=function(x){return String(x||"").replace(/-/g," ").replace(/^./,function(c){return c.toUpperCase()})};
 var X=(window.LASTS&&window.LASTS.bridge)||null;if(X){var MV=(X.moves||[]).filter(function(m){return m.from==="base"||m.to==="base"}).sort(function(a,b){return (b.startedAt||0)-(a.startedAt||0)});
 var GO=MV.filter(function(m){return m.stage!=="done"&&m.stage!=="stopped"}),DN=MV.filter(function(m){return m.stage==="done"||m.stage==="stopped"});
 var mr=function(m){return {coin:PL(m.from)+" → "+PL(m.to),sub:m.stage==="done"?"arrived":m.stage==="stopped"?"stopped"+(m.why?" · "+m.why:""):"on its way"+(m.arrived?" · "+money(m.arrived)+" arrived":""),paid:m.usd,usd:m.stage==="done"&&m.sent&&m.arrived?Math.round((m.arrived-m.sent)*100)/100:null,held:m.endedAt&&m.startedAt?(m.endedAt-m.startedAt)/60000:m.startedAt?(Date.now()-m.startedAt)/60000:null,t:m.endedAt||m.startedAt}};
 var N=X.now;if(N&&N.order&&(N.order.from==="base"||N.order.to==="base")&&/^dry run|refused|waiting/.test(N.stage||"")&&!MV.some(function(m){return m.id===N.order.id}))GO.unshift({from:N.order.from,to:N.order.to,usd:N.order.usd,stage:"",why:null});
 var gr=GO.map(function(m){var r=mr(m);if(m.stage==="")r.sub=N.stage+(N.problems&&N.problems.length?" · "+N.problems[0]:"");return r});
 set("bs-xsub",MV.length?GO.length+" now · "+DN.length+" finished":"");
 set("bs-x",(ptab("now","result = what the move cost",gr,false)+ptab("finished","newest first · result = what the move cost",DN.slice(0,12).map(mr),true))||'<div class="empty">no money moved to Base yet</div>')}
}
window.labPoll=function(){fetch("/api/lab").then(function(r){return r.json()}).then(function(L){window.LAB=L;try{render(L)}catch(e){console.error("lab",e)}}).catch(function(){})};
setInterval(function(){if(SEC==="lab"||SEC==="base"||!window.LAB)window.labPoll()},60000);setTimeout(window.labPoll,1500);
})();
`;
