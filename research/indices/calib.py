import json,gzip,bisect,collections,statistics as st,re
from datetime import datetime
D="out/"
ev=json.load(gzip.open(D+"events.json.gz","rt")); H=json.load(gzip.open(D+"hist.json.gz","rt"))
def pm_at(h,t,maxage=3600):
    ks=[x[0] for x in h]; i=bisect.bisect_right(ks,t)-1
    if i<0 or t-ks[i]>maxage: return None
    return h[i][1]
B=[0,.03,.1,.2,.35,.5,.65,.8,.9,.97,1.01]
for fam in ("spy-daily-close-uo","wti-daily-close-uo","spy-hit-price-weekly","wti-crude-oil-hit-price-weekly","gold-hit-price-weekly","silver-hit-price-weekly","spx-daily-up-or-down","spx-open-daily-up-or-down"):
  for hb in (24,6,2,0.5):
    cell=collections.defaultdict(list)
    for e in ev:
        if (e["series"] or ["-"])[0]!=fam or not e["closed"]: continue
        for m in e["markets"]:
            op=json.loads(m["outcomePrices"] or "[]")
            if not op or op[0] not in("1","0"): continue
            end=int(datetime.fromisoformat(m["endDate"].replace("Z","+00:00")).timestamp())
            h=H.get(m["id"]) or []
            # true end = last time price was not 0/1 ... use endDate (21:00Z SPY=16:00 EST / 17:00 EDT)
            p=pm_at(h,end-hb*3600-3600)  # endDate ~1h after close in EDT; conservative
            if p is None: continue
            for p2,yes in ((p,op[0]=="1"),(1-p,op[0]=="0")):
                k=bisect.bisect_right(B,p2)-1; cell[k].append((p2,yes))
    out=[]
    for k in sorted(cell):
        l=cell[k]
        if len(l)<15: continue
        out.append(f"{B[k]:.2f}-{B[k+1]:.2f}: n{len(l)} px{100*st.mean(x[0] for x in l):.0f} won{100*st.mean(x[1] for x in l):.0f}")
    print(fam,f"T-{hb}h:"," | ".join(out))
