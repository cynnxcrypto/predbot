exec(open("fills.py").read().split("cov=")[0])
from datetime import datetime
ev=json.load(gzip.open("out/events.json.gz","rt"))
B=[0,.05,.15,.30,.45,.55,.70,.85,.95,1.0]
res=collections.defaultdict(lambda: collections.defaultdict(list))
for e in ev:
    s=(e["series"] or ["-"])[0]
    for m in e["markets"]:
        a=IDX.get(m["id"])
        if not a: continue
        op=json.loads(m["outcomePrices"] or "[]")
        if not op or op[0] not in ("0","1"): continue
        win0=op[0]=="1"
        end=int(datetime.fromisoformat(m["endDate"].replace("Z","+00:00")).timestamp())
        for ts,acq,px,usd in a:
            if px<=0.005 or px>=0.995 or usd<1: continue
            won=win0 if acq==0 else not win0
            k=bisect.bisect_right(B,px)-1
            res[s][k].append((won-px-fee(px),won,px,e["id"]))
for s,d in sorted(res.items(),key=lambda x:-sum(len(v) for v in x[1].values())):
    tot=sum(len(v) for v in d.values())
    if tot<3000: continue
    print(f"== {s} ({tot} taker trades)")
    print("   "+" | ".join(f"{100*B[k]:.0f}-{100*B[k+1]:.0f}c n{len(v)} won{100*st.mean(w for _,w,_,_ in v):.0f} vs px{100*st.mean(p for *_,p,_ in v):.0f} net{100*st.mean(x for x,*_ in v):+.1f}" for k,v in sorted(d.items())))
