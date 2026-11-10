import pickle, collections, math, datetime as dt, bisect
from zoneinfo import ZoneInfo
rows=[r for r in pickle.load(open("/home/claude/wx/rows.pkl","rb")) if r["kind"]=="L" and r["run"] and r["city"]!="Denver"]
rnd=lambda x: math.floor(x+0.5)
FEE=0.05
def pa(b,ts):
    h=b["h"]
    if not h: return None
    i=bisect.bisect_right(b["ts"],ts)-1
    if i<0 or ts-h[i]["t"]>1800: return None
    return h[i]["p"]
for r in rows:
    for b in r["bk"]: b["ts"]=[x["t"] for x in b["h"]] if b["h"] else []
dates=sorted({r["date"] for r in rows}); mid=dates[len(dates)//2]
print(len(rows),dates[0],dates[-1],"split",mid)
def run(hh,pmin,pmax,mode,slip=0.02):
    T=[]
    for r in rows:
        tz=ZoneInfo(r["tz"]); d0=dt.datetime.fromisoformat(r["date"]).replace(tzinfo=tz).timestamp(); ts=d0+hh*3600
        seen=[v for t,v in r["run"] if t<=ts-1200]
        if len(seen)<4: continue
        ext=rnd(min(seen))
        ps=[(pa(b,ts),b) for b in r["bk"]]; ps=[(p,b) for p,b in ps if p is not None]
        if not ps: continue
        if mode=="fav": p,b=max(ps,key=lambda x:x[0])
        else:
            c=[(p,b) for p,b in ps if b["lo"]<=ext<=b["hi"]]
            if not c: continue
            p,b=c[0]
        if not(pmin<=p<=pmax): continue
        T.append((r["date"],p,b["won"]))
    if len(T)<30: return
    pnl=[w-(p+slip+FEE*p*(1-p)) for _,p,w in T]; n=len(T)
    a=[x for t,x in zip(T,pnl) if t[0]<mid]; b2=[x for t,x in zip(T,pnl) if t[0]>=mid]
    sd=(sum((x-sum(pnl)/n)**2 for x in pnl)/n)**.5/n**.5
    print(f"{mode} h{hh:>2} {pmin}-{pmax}: n {n} won {sum(w for _,_,w in T)/n*100:.1f}% px {sum(p for _,p,_ in T)/n:.3f} net {sum(pnl)/n*100:+.1f}c ±{sd*100:.1f} halves {sum(a)/max(len(a),1)*100:+.1f}/{sum(b2)/max(len(b2),1)*100:+.1f} (n {len(a)}/{len(b2)})")
for mode in ("fav","cur"):
    for hh in (6,8,10,12,14,16,18,20,22):
        for band in ((0.5,0.85),(0.85,0.97)):
            run(hh,*band,mode)
