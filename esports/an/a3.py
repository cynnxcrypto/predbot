exec(open("an/common.py").read())
from datetime import datetime
rows=[]
for eid,ms in ev.items():
    mm=[r for r in ms if r["smt"]=="moneyline" and "BO3" in r["q"].upper()]
    m1=[r for r in ms if r["smt"]=="child_moneyline" and re.search(r"(Map|Game) 1 Winner",r["q"])]
    if not mm or not m1: continue
    M=mm[0]; A=m1[0]; g=ts(M["gst"])
    if not g or (M["vol"] or 0)<5000 or A["outs"]!=M["outs"]: continue
    P0,age=pat(M["h"],g-600)
    if P0 is None or age>3*3600: continue
    q=solve_q(P0); w1=A["win"]
    t_end=map_end(A,g,A["win"])
    if not t_end: continue
    for lag in (60,120,180,300,600):
        p,a=pat(M["h"],t_end+lag)
        if p is None: continue
        pw=p if w1==0 else 1-p; p0w=P0 if w1==0 else 1-P0
        model=1-(1-(q if w1==0 else 1-q))**2
        rows.append(dict(lag=lag,age=a,game=M["game"],p0w=p0w,pw=pw,model=model,won=M["win"]==w1,r=M,mon=datetime.utcfromtimestamp(g).strftime("%Y-%m"),vol=M["vol"]))
def ev_(s,slip=.01): return mean((1 if x['won'] else 0)-(x['pw']+slip)-fee(x['r'],x['pw']+slip) for x in s)
def show(lbl,s):
    if len(s)<10: print(f"  {lbl}: n={len(s)}"); return
    print(f"  {lbl}: n={len(s)} won {mean(x['won'] for x in s):.3f} px {mean(x['pw'] for x in s):.3f} EV 1c {ev_(s)*100:+.1f}c 3c {ev_(s,.03)*100:+.1f}c")
for name,cond in [("dog won map1 (pre<0.40)",lambda x:x['p0w']<0.40),("pre 0.40-0.50",lambda x:0.40<=x['p0w']<0.5),("gap<=-8",lambda x:x['pw']-x['model']<=-0.08)]:
    print("\n##",name)
    for lag in (60,120,180,300,600):
        s=[x for x in rows if x['lag']==lag and cond(x)]
        show(f"lag {lag}",s)
        f=[x for x in s if x['age']<=120]; show(f"  lag {lag} fresh(age<=2m)",f)
    s=[x for x in rows if x['lag']==120 and cond(x)]
    for g in ("cs2","lol","dota2","val"): show(g,[x for x in s if x['game']==g])
    for m in sorted(set(x['mon'] for x in s)): show(m,[x for x in s if x['mon']==m])
    show("vol>=50k",[x for x in s if x['vol']>=50000]); show("vol<50k",[x for x in s if x['vol']<50000])
