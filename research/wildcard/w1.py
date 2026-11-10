import pickle, collections, math, datetime as dt, bisect
from zoneinfo import ZoneInfo
rows = pickle.load(open("/home/claude/wx/rows.pkl","rb"))
rnd=lambda x: math.floor(x+0.5)
def price_at(h, ts, maxage=1800):
    if not h: return None
    i=bisect.bisect_right([x["t"] for x in h], ts)-1
    if i<0 or ts-h[i]["t"]>maxage: return None
    return h[i]["p"]
LAG=20*60
out=[]
for r in rows:
    if not r["run"] or r["city"]=="Denver": continue
    tz=ZoneInfo(r["tz"]); d0=dt.datetime.fromisoformat(r["date"]).replace(tzinfo=tz).timestamp()
    H=r["kind"]=="H"
    for b in r["bk"]: b["ts"]=[x["t"] for x in b["h"]] if b["h"] else []
    death={}
    for hh2 in range(2,48):  # every 30 min local
        ts=d0+hh2*1800
        seen=[v for t,v in r["run"] if t<=ts-LAG]
        if len(seen)<2: continue
        ext=rnd(max(seen)) if H else rnd(min(seen))
        for i,b in enumerate(r["bk"]):
            dead = (b["hi"]<ext) if H else (b["lo"]>ext)
            if not dead: continue
            if i not in death: death[i]=hh2
            if not b["h"]: continue
            j=bisect.bisect_right(b["ts"],ts)-1
            if j<0 or ts-b["ts"][j]>1800: continue
            out.append((r["kind"],r["date"],r["city"],hh2/2,(hh2-death[i])/2,b["h"][j]["p"],b["won"],b["vol"],abs((b["hi"] if H else b["lo"])-ext)))
pickle.dump(out,open("dead.pkl","wb"))
import pandas as pd
d=pd.DataFrame(out,columns="kind date city hour since p won vol gap".split())
print(len(d), d.won.sum(), "dead-bucket snapshots / of which YES still won")
for k in "HL":
    x=d[d.kind==k]
    print(k,"snapshots",len(x),"won",x.won.sum())
    for lo,hi in ((0,0.006),(0.006,0.015),(0.015,0.03),(0.03,0.06),(0.06,0.15),(0.15,1)):
        y=x[(x.p>=lo)&(x.p<hi)]
        print(f"  mid {lo}-{hi}: n {len(y)} citydays {y.groupby(['date','city']).ngroups} YES won {y.won.sum()} since-death median {y.since.median()}")
    y=x[(x.p>=0.015)]
    print("  by since-death (mid>=1.5c):", y.groupby(pd.cut(y.since,[-1,0,0.5,1,2,4,30])).size().to_dict())
    print("  gap==1 share among mid>=1.5c:", (y.gap<=1).mean())
    print(y[y.won].head(10))
