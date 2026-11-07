import json,gzip,collections,sys
C=json.load(gzip.open(sys.argv[1]))
print(len(C),"with fills",sum(1 for c in C if c["fills"]))
def mean(x): x=list(x); return sum(x)/len(x) if x else float('nan')
def fee(c,p): return c["fee"]*p*(1-p)
def evaluate(lbl,S):
    # real entry: fills between +60s and +600s after map1 end; take VWAP of fills in that window (any side) as achievable price; also first fill price
    got=[];miss=0
    for c in S:
        w=[f for f in c["fills"] if 60<=f[0]<=600]
        if not w: miss+=1; continue
        vw=sum(p*s for _,p,s,_,_ in w)/sum(s for *_,s,_,_ in [(f[0],f[1],f[2],f[3],f[4]) for f in w])
        first=w[0][1]
        got.append((c,vw,first,sum(s*p for _,p,s,_,_ in w)))
    if not got: print(lbl,"no fills"); return
    e=lambda k: mean((1 if c['won'] else 0)-(x+.0)-fee(c,x) for c,*xs in got for x in [xs[k]])
    print(f"{lbl}: n={len(S)} with fills {len(got)} (no fills {miss}); hist px {mean(c['pw'] for c,*_ in got):.3f} vwap {mean(v for _,v,_,_ in got):.3f} first {mean(f for _,_,f,_ in got):.3f} won {mean(c['won'] for c,*_ in got):.3f}  EV@vwap {e(0)*100:+.1f}c EV@first {e(1)*100:+.1f}c  EV@hist+1c {mean((1 if c['won'] else 0)-(c['pw']+.01)-fee(c,c['pw']+.01) for c,*_ in got)*100:+.1f}c  $traded med {sorted(u for *_,u in got)[len(got)//2]:.0f}")
R1=[c for c in C if c['p0w']>=.5 and c['pw']-c['p0w']<0.05 and c['pw']<0.9]
evaluate("RULE fav won map1, rose<5pts",R1)
evaluate("fav won map1 rose 5-10",[c for c in C if c['p0w']>=.5 and .05<=c['pw']-c['p0w']<0.10 and c['pw']<0.95])
evaluate("dog won map1 rose<20",[c for c in C if c['p0w']<.5 and c['pw']-c['p0w']<0.20])
evaluate("dog won map1 rose 10-20",[c for c in C if c['p0w']<.5 and .1<=c['pw']-c['p0w']<0.20])
evaluate("random controls",[c for c in C if not ((c['p0w']>=.5 and c['pw']-c['p0w']<0.10 and c['pw']<0.95) or (c['p0w']<.5 and c['pw']-c['p0w']<0.20))])
# example
for c in R1[:6]:
    print(c['q'][:60],"hist",c['pw'],"won",c['won'],[(f[0],f[1],f[2]) for f in c['fills'] if -60<=f[0]<=600][:8])
