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
    w1=A["win"]; t_end=map_end(A,g,A["win"])
    if not t_end: continue
    p0w=P0 if w1==0 else 1-P0
    pts=[(p if w1==0 else 1-p) for t,p in M["h"] if t_end+60<=t<=t_end+180]
    if not pts: continue
    pw=pat(M["h"],t_end+120)[0]; pw=pw if w1==0 else 1-pw
    # price of winner at map1 start-ish and min during map1
    dur=(t_end-g)/60
    rows.append(dict(game=M["game"],p0w=p0w,pw=pw,worst=max(pts),won=M["win"]==w1,r=M,t=t_end,dur=dur,vol=M["vol"],fee=(M["fee"] or {}).get("rate")))
def evs(s,k='pw',slip=.01): return mean((1 if x['won'] else 0)-(x[k]+slip)-fee(x['r'],x[k]+slip) for x in s)
print("fee rates",collections.Counter((x['game'],x['fee']) for x in rows))
print("\n## pre-match fav (p0w>=.5) won map1: by match price 2 min after")
for lo,hi in [(.3,.5),(.5,.6),(.6,.7),(.7,.8),(.8,.9),(.9,1)]:
    s=[x for x in rows if x['p0w']>=.5 and lo<=x['pw']<hi]
    if s: print(f" px {lo}-{hi}: n={len(s)} won {mean(x['won'] for x in s):.3f} px {mean(x['pw'] for x in s):.3f} p0 {mean(x['p0w'] for x in s):.3f} EV {evs(s)*100:+.1f}c worst-of-1-3min {evs(s,'worst')*100:+.1f}c")
print("\n## by jump = pw - p0w (fav won map1)")
for lo,hi in [(-1,0),(0,.05),(.05,.10),(.10,.15),(.15,.2),(.2,1)]:
    s=[x for x in rows if x['p0w']>=.5 and lo<=x['pw']-x['p0w']<hi]
    if s: print(f" jump {lo:+.2f}..{hi:+.2f}: n={len(s)} won {mean(x['won'] for x in s):.3f} px {mean(x['pw'] for x in s):.3f} p0 {mean(x['p0w'] for x in s):.3f} EV {evs(s)*100:+.1f}c worst {evs(s,'worst')*100:+.1f}c")
print("\n## dog won map1, by jump")
for lo,hi in [(-1,.1),(.1,.2),(.2,.3),(.3,1)]:
    s=[x for x in rows if x['p0w']<.5 and lo<=x['pw']-x['p0w']<hi]
    if s: print(f" jump {lo:+.2f}..{hi:+.2f}: n={len(s)} won {mean(x['won'] for x in s):.3f} px {mean(x['pw'] for x in s):.3f} p0 {mean(x['p0w'] for x in s):.3f} EV {evs(s)*100:+.1f}c worst {evs(s,'worst')*100:+.1f}c")
# candidate rule: fav won map1 and jump < 0.05
C=[x for x in rows if x['p0w']>=.5 and x['pw']-x['p0w']<0.05 and x['pw']<0.9]
print("\n## RULE fav won map1, match px rose <5pts, px<90c: n",len(C), "won",round(mean(x['won'] for x in C),3),"EV",round(evs(C)*100,1),"worst",round(evs(C,'worst')*100,1))
for g in ("cs2","lol","dota2","val"):
    s=[x for x in C if x['game']==g]; print(" ",g,len(s),round(mean(x['won'] for x in s),3),round(evs(s)*100,1))
wk=collections.defaultdict(list)
for x in C: wk[datetime.fromtimestamp(x['t'],timezone.utc).strftime("%Y-%m")].append(x)
for k in sorted(wk): s=wk[k]; print(" ",k,len(s),round(mean(x['won'] for x in s),3),f"{evs(s)*100:+.1f}c")
hrs=collections.Counter((datetime.fromtimestamp(x['t'],timezone.utc).hour+9)%24 for x in C); print(" KST hours",sorted(hrs.items()))
last8=[x for x in C if x['t']>datetime(2026,9,10,tzinfo=timezone.utc).timestamp()]; print(" last 8 weeks n",len(last8),"per week",round(len(last8)/8,1))
print(" by vol: >=50k", len([x for x in C if x['vol']>=5e4]), round(evs([x for x in C if x['vol']>=5e4])*100,1), "<50k", round(evs([x for x in C if x['vol']<5e4])*100,1))
