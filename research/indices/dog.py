exec(open("fills.py").read().split("cov=")[0])
from datetime import datetime
ev=json.load(gzip.open("out/events.json.gz","rt"))
def run(series,lo,hi,minleft_h=0,maxleft_h=99,once="first"):
    res=[]
    for e in ev:
        if (e["series"] or ["-"])[0] not in series: continue
        for m in e["markets"]:
            a=IDX.get(m["id"]); op=json.loads(m["outcomePrices"] or "[]")
            if not a or not op or op[0] not in("0","1"): continue
            end=int(datetime.fromisoformat(m["endDate"].replace("Z","+00:00")).timestamp())
            for ts,acq,px,usd in a:
                left=(end-ts)/3600
                if lo<=px<=hi and usd>=2 and minleft_h<=left<=maxleft_h:
                    won=(op[0]=="1") if acq==0 else (op[0]=="0")
                    res.append((ts,won-px-fee(px),won,px)); break
    res.sort()
    if not res: return
    n=len(res); h=n//2
    f=lambda l: f"n{len(l)} won{100*st.mean(x[2] for x in l):.0f}% px{100*st.mean(x[3] for x in l):.0f} net{100*st.mean(x[1] for x in l):+.1f}c ±{100*st.pstdev(x[1] for x in l)/math.sqrt(len(l)):.1f}"
    print(f"{','.join(s[:14] for s in series)} {lo}-{hi} left {minleft_h}-{maxleft_h}h: ALL {f(res)} | 1st half {f(res[:h])} | 2nd half {f(res[h:])} | last 60d {f([x for x in res if x[0]>res[-1][0]-60*86400])}")
for S in (["spx-daily-up-or-down"],["spy-daily-up-or-down"],["spx-daily-up-or-down","spy-daily-up-or-down"],["spx-open-daily-up-or-down"],["oil-daily-up-or-down"],["gold-daily-up-or-down"]):
    for lo,hi in ((0.30,0.45),(0.20,0.30),(0.55,0.70)):
        for a,b in ((0,99),(4,99),(0,4)):
            run(S,lo,hi,a,b)
