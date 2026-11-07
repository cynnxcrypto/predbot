exec(open("an/common.py").read())
from datetime import datetime,timezone
k=0
for eid,ms in ev.items():
    mm=[r for r in ms if r["smt"]=="moneyline" and "BO3" in r["q"].upper()]
    m1=[r for r in ms if r["smt"]=="child_moneyline" and re.search(r"(Map|Game) 1 Winner",r["q"])]
    if not mm or not m1: continue
    M=mm[0]; A=m1[0]; g=ts(M["gst"])
    if not g or (M["vol"] or 0)<5000 or A["outs"]!=M["outs"]: continue
    P0,age=pat(M["h"],g-600)
    if P0 is None or age>3*3600: continue
    w1=A["win"]; t_end=map_end(A,g,A["win"])
    if not t_end: continue
    p0w=P0 if w1==0 else 1-P0; pw=pat(M["h"],t_end+120)[0]; pw=pw if w1==0 else 1-pw
    if p0w>=.5 and pw-p0w<0.05 and pw<0.9:
        k+=1
        if k>8: break
        print("\n",M["q"][:70],"vol",int(M["vol"]),"score",M["score"],"w1",w1,"winM",M["win"],"P0w",round(p0w,3))
        f=lambda h,t:pat(h,t)[0]
        for off in range(-1800,1800,300):
            t=t_end+off; a=f(A["h"],t); m=f(M["h"],t)
            print(f"   {off/60:+5.0f}m map1 {a} match {m}")
        n_changes=len(set(p for t,p in M["h"] if t_end-3600<t<t_end+3600)); print("   distinct match px within +-1h:",n_changes)
