exec(open("analyze.py").read().split("rows = []")[0])
import csv
V={}
for r in csv.DictReader(open(D+"cboe_vix1d.csv")):
    k=[x for x in r if x.upper().startswith("DATE")][0]
    mo,d,y=r[k].split("/"); V[f"{y}-{int(mo):02d}-{int(d):02d}"]=float(r.get("CLOSE") or r.get("Close"))
V9={}
for r in csv.DictReader(open(D+"cboe_vix9d.csv")):
    k=[x for x in r if x.upper().startswith("DATE")][0]
    mo,d,y=r[k].split("/"); V9[f"{y}-{int(mo):02d}-{int(d):02d}"]=float(r.get("CLOSE") or r.get("Close"))
def ll(p,y): p=min(max(p,0.01),0.99); return -math.log(p if y else 1-p)
out=collections.defaultdict(lambda:[[],[],[],[]])
for e in ev:
    s=(e["series"] or ["-"])[0]
    if s!="spx-daily-up-or-down" or not e["closed"]: continue
    m=e["markets"][0]; op=json.loads(m["outcomePrices"] or "[]"); up=op[0]=="1"
    mm=re.search(r"on (\w+) (\d+)",e["title"])
    if not mm or mm.group(1).lower() not in MON: continue
    end=datetime.fromisoformat(m["endDate"].replace("Z","+00:00"))
    C=int(datetime(end.year,MON[mm.group(1).lower()],int(mm.group(2)),16,0,tzinfo=ET).timestamp())
    ref=None
    for k in range(1,6):
        R=C-k*86400
        if datetime.fromtimestamp(R,ET).weekday()<5:
            ref=px("ES=F",R,maxage=900)
            if ref: prevd=datetime.fromtimestamp(R,ET).strftime("%Y-%m-%d"); break
    if not ref or prevd not in V9: continue
    h=H.get(m["id"]) or []
    for ck in (8,5,4,3,2,1):
        t=int(C-ck*3600); f=px("ES=F",t,maxage=900); p=pm_at(h,t)
        if not f or p is None: continue
        vr=rem_var("ES=F",t,C); vfull=rem_var("ES=F",C-86400,C)
        if vr<=0 or vfull<=0: continue
        for i,sig in enumerate((V.get(prevd),V9[prevd])):
            if not sig: continue
            vi=(sig/100)**2/252*vr/vfull
            out[ck][i].append(ll(Phi(math.log(f/ref)/math.sqrt(vi)),up))
        out[ck][2].append(ll(Phi(math.log(f/ref)/math.sqrt(vr)),up)); out[ck][3].append(ll(p,up))
for ck,(a,b,c,d) in sorted(out.items(),reverse=True):
    print(f"T-{ck}h n{len(c)} logloss: VIX1D {st.mean(a) if a else float('nan'):.3f} (n{len(a)}) VIX9D {st.mean(b):.3f} realised {st.mean(c):.3f} Polymarket {st.mean(d):.3f}")
