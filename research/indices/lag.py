exec(open("analyze.py").read().split("rows = []")[0])
import statistics as st
res=collections.defaultdict(list)
for e in ev:
    s=(e["series"] or ["-"])[0]
    if s not in ("spx-daily-up-or-down","gold-daily-up-or-down","oil-daily-up-or-down") or not e["closed"]: continue
    m=e["markets"][0]; mm=re.search(r"on (\w+) (\d+)",e["title"])
    if not mm or mm.group(1).lower() not in MON: continue
    end=datetime.fromisoformat(m["endDate"].replace("Z","+00:00")); sym,ch,cm=SER[s]
    C=int(datetime(end.year,MON[mm.group(1).lower()],int(mm.group(2)),ch,cm,tzinfo=ET).timestamp())
    ref=None
    for k in range(1,6):
        R=C-k*86400
        if datetime.fromtimestamp(R,ET).weekday()<5:
            ref=px(sym,R,maxage=300)
            if ref: break
    if not ref: continue
    h=H.get(m["id"]) or []
    for t in range(C-6*3600,C-1800,300):
        f=px(sym,t,maxage=300); p=pm_at(h,t,600)
        if not f or p is None: continue
        v=rem_var(sym,t,C)
        if v<=0: continue
        fair=Phi(math.log(f/ref)/math.sqrt(v))
        for L in (5,15,30,60):
            p2=pm_at(h,t+L*60,600)
            if p2 is not None: res[(s,L)].append((fair-p,p2-p))
for (s,L),l in sorted(res.items()):
    xs=[a for a,b in l]; ys=[b for a,b in l]
    beta=sum(a*b for a,b in l)/sum(a*a for a in xs)
    print(f"{s} lag {L}m: n{len(l)} share of gap closed {beta:.2f}  corr {st.correlation(xs,ys):.2f}")
