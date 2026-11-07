import json,gzip,bisect,collections,statistics as st,math,sys
T=json.load(gzip.open("out/trades.json.gz","rt"))
# per market: sorted list of (ts, effective price to acquire outcome0, effective price to acquire outcome1, usd)
IDX={}
for mid,rows in T.items():
    a=[]
    for r in rows:
        try: ts=int(r["timestamp"]); p=float(r["price"]); oi=int(r["outcome_index"]); sd=r["side"]; sz=float(r["size"])
        except Exception: continue
        if sd=="BUY": acq=oi; px=p
        else: acq=1-oi; px=1-p
        a.append((ts,acq,px,sz*p))
    a.sort(); IDX[mid]=a
def fill(mid,t,side,limit,win=900,minusd=2):
    a=IDX.get(mid)
    if not a: return None
    i=bisect.bisect_left(a,(t,))
    while i<len(a) and a[i][0]<=t+win:
        ts,acq,px,usd=a[i]
        if acq==side and px<=limit and usd>=minusd: return px
        i+=1
    return None
fee=lambda p:0.04*p*(1-p)
def report(name,sig):
    """sig: list of (mid,t,side(0/1),pm_price_of_side,won(bool))"""
    n=len(sig); f=[]; paper=[]
    for mid,t,side,p,won in sig:
        paper.append(won-p)
        x=fill(mid,t,side,p+0.02)
        if x is not None: f.append((won-x-fee(x),won))
    if not n: return
    s=f"{name}: signals {n}, paper {100*st.mean(paper):+.1f}c | fillable(<=pm+2c in 15m) {len(f)} ({100*len(f)/n:.0f}%)"
    if f: s+=f" won {100*st.mean(w for _,w in f):.0f}% net {100*st.mean(x for x,_ in f):+.1f}c/share"
    if len(f)>=10:
        sd=st.pstdev(x for x,_ in f)/math.sqrt(len(f)); s+=f" ±{100*sd:.1f}"
    print(s)
cov=sum(1 for v in IDX.values() if v); print("markets with trades",cov)
# 1) daily up/down vol gap
R=json.load(open("rows.json"))
for ser in ("spx-daily-up-or-down","spy-daily-up-or-down","gold-daily-up-or-down","silver-daily-up-or-down","oil-daily-up-or-down","dow-jones-daily-up-or-down","russell-2000-daily-up-or-down","ndx-daily-up-or-down"):
  for X in (0.05,0.10):
    for ckset,lab in (((8,5,4,3),"8-3h"),((2,1),"2-1h"),((0.5,0.25,0.083),"<=30m")):
        sig=[]
        for r in R:
            if r["s"]!=ser or r["ck"] not in ckset or r["pm"] is None or r["fair"] is None: continue
            d=r["fair"]-r["pm"]
            if d>=X: sig.append((r["mid"],r["t"],0,r["pm"],r["up"]))
            elif d<=-X: sig.append((r["mid"],r["t"],1,1-r["pm"],not r["up"]))
        report(f"{ser} gap>={X} {lab}",sig)
# 2) hit markets: buy NO when model < p - X, by family; and YES
B=json.load(open("barrier_rows.json"))
fams=sorted(set(r["f"] for r in B))
for f in fams:
    for X in (0.05,):
        sig=[(r["mid"],r["t"],1,1-r["p"],not r["yes"]) for r in B if r["f"]==f and r["fair"]<r["p"]-X and r["p"]<=0.9]
        report(f"{f} NO model<p-{X}",sig)
        sig=[(r["mid"],r["t"],0,r["p"],r["yes"]) for r in B if r["f"]==f and r["fair"]>r["p"]+X]
        report(f"{f} YES model>p+{X}",sig)
