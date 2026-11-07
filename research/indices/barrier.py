import json,gzip,bisect,collections,statistics as st,re,math
from datetime import datetime,timezone
from zoneinfo import ZoneInfo
ET=ZoneInfo("America/New_York")
D="out/"
ev=json.load(gzip.open(D+"events.json.gz","rt")); H=json.load(gzip.open(D+"hist.json.gz","rt")); U=json.load(gzip.open(D+"underlying.json.gz","rt"))
FAM={"crude-oil-cl-hit":"CL=F","xauusd-hit-month":"GC=F","xagusd-hit-month":"SI=F","spy-hit-month":"SPY","sp-500-monthly-hit":"ES=F",
     "wti-crude-oil-hit-price-weekly":"CL=F","spy-hit-price-weekly":"SPY","gold-hit-price-weekly":"GC=F","silver-hit-price-weekly":"SI=F","natural-gas-hit-price-weekly":"NG=F",
     "ng-hit-month":"NG=F","what-will-gold-gc-hit":"GC=F","will-silver-si-hit":"SI=F"}
def ser(sym):
    r={}
    for iv,sec in(("1h",3600),("5m",300)):
        o=(U.get(sym) or {}).get(iv)
        if o:
            for x in o["rows"]:
                if x[4]: r[x[0]+sec]=(x[2],x[3],x[4])
    k=sorted(r); return k,[r[i] for i in k]
PX={s:ser(s) for s in set(FAM.values())}
def last(sym,t):
    k,v=PX[sym]; i=bisect.bisect_right(k,t)-1
    return v[i][2] if i>=0 and t-k[i]<4*86400 else None
def extreme(sym,a,b):
    k,v=PX[sym]; i=bisect.bisect_left(k,a); j=bisect.bisect_right(k,b)
    if j<=i: return None,None
    return max(x[0] for x in v[i:j]),min(x[1] for x in v[i:j])
def dvol(sym,t):
    # daily vol from trailing 20 days of 1h returns (sum sq / 20)
    k,v=PX[sym]; i=bisect.bisect_left(k,t-28*86400); j=bisect.bisect_right(k,t)
    ss=0;n=0
    for a in range(i+1,j):
        if k[a]-k[a-1]<=3600 and v[a-1][2]:
            ss+=math.log(v[a][2]/v[a-1][2])**2
    days=(k[j-1]-k[i])/86400*5/7 if j-1>i else 0
    return math.sqrt(ss/days) if days>5 else None
def pm_at(h,t):
    ks=[x[0] for x in h]; i=bisect.bisect_right(ks,t)-1
    return h[i][1] if i>=0 and t-ks[i]<7200 else None
def tdays(a,b):
    return max(0.0,(b-a)/86400*5/7)
Phi=lambda z:0.5*(1+math.erf(z/math.sqrt(2)))
rows=[]
for e in ev:
    f=(e["series"] or ["-"])[0]
    if f not in FAM or not e["closed"]: continue
    sym=FAM[f]
    for m in e["markets"]:
        op=json.loads(m["outcomePrices"] or "[]")
        if not op or op[0] not in("1","0"): continue
        q=m["question"]; up=("HIGH" in q) or ("↑" in (m["groupItemTitle"] or "")); dn=("LOW" in q) or ("↓" in (m["groupItemTitle"] or ""))
        if up==dn: continue
        mk=re.search(r"\$([\d,\.]+)",q)
        if not mk: continue
        K=float(mk.group(1).replace(",",""))
        st0=int(datetime.fromisoformat((m["startDate"] or e["startDate"]).replace("Z","+00:00")).timestamp())
        end=int(datetime.fromisoformat(m["endDate"].replace("Z","+00:00")).timestamp())
        h=H.get(m["id"]) or []
        yes=op[0]=="1"
        for dd in (20,10,5,3,2,1,0.5):
            t=end-int(dd*86400)
            if t<st0+3600: continue
            p=pm_at(h,t); S=last(sym,t); sv=dvol(sym,t)
            if p is None or S is None or not sv: continue
            hi,lo=extreme(sym,st0,t)
            already = hi is not None and ((up and hi>=K) or (dn and lo<=K))
            if already: continue
            tau=tdays(t,end)
            d=abs(math.log(K/S)); fair=min(1,2*(1-Phi(d/(sv*math.sqrt(tau))))) if tau>0 else 0
            rows.append(dict(f=f,dd=dd,p=p,fair=fair,yes=yes,vol=float(m["volumeNum"] or 0),wk="weekly" in f))
json.dump(rows,open("barrier_rows.json","w"))
print("rows",len(rows))
B=[0,.03,.1,.2,.35,.5,.65,.8,1.01]
for grp in ("month","weekly"):
  for key in ("p","fair"):
    cell=collections.defaultdict(list)
    for r in rows:
        if r["wk"]!=(grp=="weekly") or r["vol"]<2000: continue
        cell[bisect.bisect_right(B,r[key])-1].append(r)
    print(grp,key,"| ".join(f"{B[k]:.2f}-{B[k+1]:.2f} n{len(l)} px{100*st.mean(x['p'] for x in l):.0f} fair{100*st.mean(x['fair'] for x in l):.0f} won{100*st.mean(x['yes'] for x in l):.0f}" for k,l in sorted(cell.items()) if len(l)>=10))
# trading: buy NO where p in [0.03,0.35] and fair < p - X ; buy YES where fair > p + X
for grp in ("month","weekly"):
  for X in (0.03,0.05,0.10):
    pn=[]
    for r in rows:
        if r["wk"]!=(grp=="weekly") or r["vol"]<2000: continue
        if r["fair"]>r["p"]+X: pn.append((r["yes"]-r["p"],"Y"))
        elif r["fair"]<r["p"]-X: pn.append(((not r["yes"])-(1-r["p"]),"N"))
    y=[a for a,s in pn if s=="Y"]; n=[a for a,s in pn if s=="N"]
    print(grp,X,f"buyYES n{len(y)} {100*st.mean(y) if y else 0:+.1f}c  buyNO n{len(n)} {100*st.mean(n) if n else 0:+.1f}c")
# simple: buy NO on every longshot YES priced 3-20c
for grp in ("month","weekly"):
    l=[r for r in rows if r["wk"]==(grp=="weekly") and r["vol"]>=2000 and .03<=r["p"]<=.2]
    print(grp,"NO on 3-20c YES:",len(l),f"{100*st.mean((not r['yes'])-(1-r['p']) for r in l):+.1f}c", "by dd:",{dd:(len(x),round(100*st.mean((not r['yes'])-(1-r['p']) for r in x),1)) for dd in (20,10,5,3,2,1,0.5) for x in [[r for r in l if r['dd']==dd]] if x})
