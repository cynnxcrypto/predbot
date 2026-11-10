import pickle, collections, math, datetime as dt, bisect, sys
from zoneinfo import ZoneInfo
KIND=sys.argv[1]
rows=[r for r in pickle.load(open("/home/claude/wx/rows.pkl","rb")) if r["kind"]==KIND and r["run"] and r["city"]!="Denver"]
rnd=lambda x: math.floor(x+0.5)
dates=sorted({r["date"] for r in rows}); mid=dates[len(dates)//2]
def run(h0,h1,pmin,pmax,drop=0,first=True,verbose=False):
    T=[]
    for r in rows:
        tz=ZoneInfo(r["tz"]); d0=dt.datetime.fromisoformat(r["date"]).replace(tzinfo=tz).timestamp()
        done=False
        obs=r["run"]
        for b in r["bk"]:
            h=b["h"]
            if not h or done: continue
            for i in range(1,len(h)):
                t=h[i]["t"]; lh=(t-d0)/3600
                if lh<h0 or lh>=h1: continue
                if abs(h[i]["p"]-h[i-1]["p"])<0.005: continue   # no print
                p=h[i]["p"]
                if not(pmin<=p<=pmax): continue
                seen=[v for tt,v in obs if tt<=t-1500]
                if len(seen)<4: continue
                ext=rnd(min(seen)) if KIND=="L" else rnd(max(seen))
                if not(b["lo"]<=ext<=b["hi"]): continue
                if drop and abs(seen[-1]-(min(seen) if KIND=="L" else max(seen)))<drop: continue
                T.append((r["date"],r["city"],lh,p,b["won"]))
                if first: done=True; break
    if len(T)<20: return
    n=len(T); pnl=[w-p for *_,p,w in T]
    a=[x for t,x in zip(T,pnl) if t[0]<mid]; b2=[x for t,x in zip(T,pnl) if t[0]>=mid]
    sd=(sum((x-sum(pnl)/n)**2 for x in pnl)/n)**.5/n**.5
    print(f"{KIND} h{h0}-{h1} px {pmin}-{pmax} drop {drop}: prints {n} ({n/len(dates):.1f}/day) won {sum(t[4] for t in T)/n*100:.1f}% avg px {sum(t[3] for t in T)/n:.3f} net at print {sum(pnl)/n*100:+.1f}c ±{sd*100:.1f} halves {sum(a)/max(len(a),1)*100:+.1f}/{sum(b2)/max(len(b2),1)*100:+.1f} n {len(a)}/{len(b2)}")
print(len(rows),"events",len(dates),"days")
if KIND=="L":
    for h0,h1 in ((7,10),(10,14),(14,18),(18,22),(22,24),(9,22)):
        for band in ((0.3,0.6),(0.6,0.85),(0.85,0.95)):
            for drop in (0,2):
                run(h0,h1,*band,drop)
else:
    for h0,h1 in ((14,16),(16,18),(18,20),(20,24)):
        for band in ((0.3,0.6),(0.6,0.85),(0.85,0.95)):
            for drop in (0,2):
                run(h0,h1,*band,drop)
