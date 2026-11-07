exec(open("an/common.py").read())
from datetime import datetime,timezone
rows=[]
for eid,ms in ev.items():
    mm=[r for r in ms if r["smt"]=="moneyline" and "BO3" in r["q"].upper()]
    m1=[r for r in ms if r["smt"]=="child_moneyline" and re.search(r"(Map|Game) 1 Winner",r["q"])]
    if not mm or not m1: continue
    M=mm[0]; A=m1[0]; g=ts(M["gst"])
    if not g or (M["vol"] or 0)<5000 or A["outs"]!=M["outs"]: continue
    P0,age=pat(M["h"],g-600)
    if P0 is None or age>3*3600: continue
    w1=A["win"]; t_end=map_end(A,g,w1)
    if not t_end: continue
    pw=pat(M["h"],t_end+120)[0]; pw=pw if w1==0 else 1-pw; p0w=P0 if w1==0 else 1-P0
    win=[p for t,p in M["h"] if t_end-900<=t<=t_end+120]
    ch=sum(1 for a,b in zip(win,win[1:]) if a!=b)
    # match price before map1 started vs at map1 end: how much it moved during map 1
    pm=[(p if w1==0 else 1-p) for t,p in M["h"] if g<=t<=t_end]
    rng=(max(pm)-min(pm)) if pm else 0
    # map1 price path of winner: was it a comeback? min winner price during map
    a1=[(p if w1==0 else 1-p) for t,p in A["h"] if g<=t<=t_end]
    mn=min(a1) if a1 else None
    rows.append(dict(game=M["game"],p0w=p0w,pw=pw,won=M["win"]==w1,r=M,ch=ch,rng=rng,mn=mn,dur=(t_end-g)/60))
def e(s): return mean((1 if x['won'] else 0)-(x['pw']+.01)-fee(x['r'],x['pw']+.01) for x in s)
R=[x for x in rows if x['p0w']>=.5 and x['pw']-x['p0w']<0.05 and x['pw']<0.9]
A_=[x for x in rows if x['p0w']>=.5]
print("rule n",len(R),"changes in 17-min window: rule med",sorted(x['ch'] for x in R)[len(R)//2],"all fav-won med",sorted(x['ch'] for x in A_)[len(A_)//2])
for lo,hi in [(0,1),(1,3),(3,8),(8,99)]:
    s=[x for x in R if lo<=x['ch']<hi]
    if s: print(f" rule changes {lo}-{hi}: n={len(s)} won {mean(x['won'] for x in s):.3f} px {mean(x['pw'] for x in s):.3f} EV {e(s)*100:+.1f}c")
print("comeback (winner was <30c in map1):")
for name,S in [("rule",R),("all fav won",A_)]:
    s=[x for x in S if x['mn'] is not None and x['mn']<0.3]; t=[x for x in S if x['mn'] is not None and x['mn']>=0.3]
    print(f"  {name}: comeback n={len(s)} EV {e(s)*100:+.1f}c | no comeback n={len(t)} EV {e(t)*100:+.1f}c")
print("dur min: rule med",sorted(x['dur'] for x in R)[len(R)//2],"all",sorted(x['dur'] for x in A_)[len(A_)//2])
