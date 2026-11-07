import json,gzip,collections,bisect,math,sys,re
exec(open("an/common.py").read())
# H2: after map1 in Bo3
out=collections.defaultdict(list)
for eid,ms in ev.items():
    mm=[r for r in ms if r["smt"]=="moneyline" and "BO3" in r["q"].upper()]
    m1=[r for r in ms if r["smt"]=="child_moneyline" and re.search(r"(Map|Game) 1 Winner",r["q"])]
    m2=[r for r in ms if r["smt"]=="child_moneyline" and re.search(r"(Map|Game) 2 Winner",r["q"])]
    if not mm or not m1: continue
    M=mm[0]; A=m1[0]; g=ts(M["gst"]); c1=ts(A["closed"])
    if not g or not c1 or (M["vol"] or 0)<5000: continue
    if A["outs"]!=M["outs"]: continue
    P0,age=pat(M["h"],g-600)
    if P0 is None or age>3*3600: continue
    q=solve_q(P0)
    w1=A["win"]  # index of map1 winner
    # time of map1 end ~ when map1 market price hit >0.95 / <0.05
    t_end=None
    for t,p in A["h"]:
        if t>g and (p>0.97 or p<0.03): t_end=t; break
    if not t_end: continue
    for lag in (60,300,900):
        p,a=pat(M["h"],t_end+lag)
        if p is None or a>600: continue
        pw = p if w1==0 else 1-p   # price of map1 winner in match market
        model = 1-(1-(q if w1==0 else 1-q))**2
        won = (M["win"]==w1)
        rec=dict(game=M["game"],P0=P0 if w1==0 else 1-P0,pw=pw,model=model,won=won,r=M)
        if m2:
            B=m2[0]; p2,a2=pat(B["h"],t_end+lag)
            if p2 is not None and B["outs"]==M["outs"] and B["win"] in (0,1):
                rec["p2w"]=p2 if w1==0 else 1-p2; rec["m2won"]=(B["win"]==w1); rec["B"]=B
        out[lag].append(rec)
for lag,rows in out.items():
    print(f"\n## lag {lag}s after map1 end: n={len(rows)}")
    n=len(rows); print(f" map1 winner match price avg {mean(x['pw'] for x in rows):.3f}, model {mean(x['model'] for x in rows):.3f}, won {mean(x['won'] for x in rows):.3f}")
    # bucket by price of map1 winner
    for lo,hi in [(0,.4),(.4,.55),(.55,.7),(.7,.85),(.85,.95),(.95,1)]:
        s=[x for x in rows if lo<=x['pw']<hi]
        if len(s)<20: continue
        e=mean((1 if x['won'] else 0)-(x['pw']+.01)-fee(x['r'],x['pw']+.01) for x in s)
        e2=mean((0 if x['won'] else 1)-((1-x['pw'])+.01)-fee(x['r'],1-x['pw']+.01) for x in s)
        print(f"  winner px {lo:.2f}-{hi:.2f}: n={len(s)} won {mean(x['won'] for x in s):.3f} px {mean(x['pw'] for x in s):.3f} model {mean(x['model'] for x in s):.3f}  EV buy winner {e*100:+.1f}c  buy loser {e2*100:+.1f}c")
    # market vs model gap
    for lo,hi in [(-1,-.08),(-.08,-.04),(-.04,0),(0,.04),(.04,.08),(.08,1)]:
        s=[x for x in rows if lo<=x['pw']-x['model']<hi]
        if len(s)<20: continue
        e=mean((1 if x['won'] else 0)-(x['pw']+.01)-fee(x['r'],x['pw']+.01) for x in s)
        print(f"  mkt-model {lo:+.2f}..{hi:+.2f}: n={len(s)} won {mean(x['won'] for x in s):.3f} px {mean(x['pw'] for x in s):.3f} model {mean(x['model'] for x in s):.3f} EV buy winner {e*100:+.1f}c")
    s=[x for x in rows if 'p2w' in x]
    if s:
        print(f"  map2: n={len(s)} map1 winner map2 px {mean(x['p2w'] for x in s):.3f} won map2 {mean(x['m2won'] for x in s):.3f}")
        for lo,hi in [(0,.35),(.35,.5),(.5,.65),(.65,.8),(.8,1)]:
            t=[x for x in s if lo<=x['p2w']<hi]
            if len(t)<20: continue
            e=mean((1 if x['m2won'] else 0)-(x['p2w']+.01)-fee(x['B'],x['p2w']+.01) for x in t)
            e2=mean((0 if x['m2won'] else 1)-((1-x['p2w'])+.01)-fee(x['B'],1-x['p2w']+.01) for x in t)
            print(f"   map2 px(map1 winner) {lo:.2f}-{hi:.2f}: n={len(t)} won {mean(x['m2won'] for x in t):.3f} px {mean(x['p2w'] for x in t):.3f} EV winner {e*100:+.1f}c loser {e2*100:+.1f}c")
    for g in ("cs2","lol","dota2","val"):
        t=[x for x in rows if x['game']==g]
        if t: print(f"  {g}: n={len(t)} px {mean(x['pw'] for x in t):.3f} model {mean(x['model'] for x in t):.3f} won {mean(x['won'] for x in t):.3f}" + (f" | map2 px {mean(x['p2w'] for x in t if 'p2w' in x):.3f} won {mean(x['m2won'] for x in t if 'p2w' in x):.3f}" if any('p2w' in x for x in t) else ""))
