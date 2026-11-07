import json,gzip,collections,bisect,math,sys,re,pickle,os
from datetime import datetime,timezone
def ts(s):
    if not s: return None
    s=str(s).replace(" ","T")
    if s.endswith("+00"): s+=":00"
    try: return datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()
    except:
        try: return datetime.fromisoformat(s[:19]).replace(tzinfo=timezone.utc).timestamp()
        except: return None
def pat(h,t):
    i=bisect.bisect_right(h,(t,9e9))-1
    return (h[i][1], t-h[i][0]) if i>=0 else (None,None)
def mean(xs):
    xs=list(xs); return sum(xs)/len(xs) if xs else float('nan')
def fee(r,p): f=r["fee"] or {}; return (f.get("rate") or 0)*p*(1-p)
def solve_q(P):
    lo,hi=0.0,1.0
    for _ in range(50):
        m=(lo+hi)/2
        if m*m*(3-2*m)<P: lo=m
        else: hi=m
    return (lo+hi)/2
CACHE="/tmp/claude-0/esev.pkl"
if os.path.exists(CACHE): ev=pickle.load(open(CACHE,"rb"))
else:
    R=json.load(gzip.open("out/markets.json.gz"))
    ev=collections.defaultdict(list)
    for r in R:
        if r["game"] in ("cs2","lol","dota2","val") and r["smt"] in ("moneyline","child_moneyline") and r.get("h") and r["win"] in (0,1):
            r["h"]=[tuple(x) for x in r["h"]]; ev[r["eid"]].append(r)
    del R
    os.makedirs("/tmp/claude-0",exist_ok=True); pickle.dump(dict(ev),open(CACHE,"wb"))
def map_end(A,g,w):
    # first time after which the winner's price stays >=0.95 until close
    h=[(t,(p if w==0 else 1-p)) for t,p in A["h"] if t>g]
    if not h: return None
    te=None
    for t,p in h:
        if p>=0.95:
            if te is None: te=t
        else: te=None
    return te
