import json,gzip,collections,bisect,math,sys
from datetime import datetime,timezone
R=json.load(gzip.open(sys.argv[1]))
def ts(s):
    if not s: return None
    s=str(s).replace(" ","T")
    if s.endswith("+00"): s+=":00"
    try: return datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()
    except: 
        try: return datetime.fromisoformat(s[:19]).replace(tzinfo=timezone.utc).timestamp()
        except: return None
def pat(h,t):
    ts_=[x[0] for x in h]; i=bisect.bisect_right(ts_,t)-1
    return (h[i][1], t-h[i][0]) if i>=0 else (None,None)
ev=collections.defaultdict(list)
for r in R:
    if r["game"] in ("cs2","lol","dota2","val") and r["smt"] in ("moneyline","child_moneyline") and r.get("h") and r["win"] in (0,1):
        ev[r["eid"]].append(r)
def fee(r,p): f=r["fee"] or {}; return (f.get("rate") or 0)*p*(1-p)
SLIP=0.01
# H1 pre-match calibration of match moneyline (favourite side), 10 min before gst
rows=[]
for eid,ms in ev.items():
    for r in ms:
        if r["smt"]!="moneyline" or (r["vol"] or 0)<5000: continue
        g=ts(r["gst"]); 
        if not g: continue
        p,age=pat(r["h"],g-600)
        if p is None or age>3*3600: continue
        bo = "Bo1" if "BO1" in r["q"].upper() else "Bo3" if "BO3" in r["q"].upper() else "Bo5" if "BO5" in r["q"].upper() else "?"
        rows.append((r["game"],bo,p,r["win"]==0,r))
def band(rows,label):
    print("\n##",label)
    B=[(0.5,0.6),(0.6,0.7),(0.7,0.8),(0.8,0.9),(0.9,0.97)]
    for lo,hi in B:
        sel=[]
        for g,bo,p,w0,r in rows:
            fp,fw=(p,w0) if p>=0.5 else (1-p,not w0)
            if lo<=fp<hi: sel.append((fp,fw,r))
        if not sel: continue
        n=len(sel); wr=sum(w for _,w,_ in sel)/n; ap=sum(p for p,_,_ in sel)/n
        ev_=sum((1 if w else 0)-(p+SLIP)-fee(r,p+SLIP) for p,w,r in sel)/n
        se=math.sqrt(ap*(1-ap)/n)
        print(f"fav {lo:.2f}-{hi:.2f}: n={n} win {wr:.3f} vs price {ap:.3f} (se {se:.3f})  EV/share fav {ev_*100:+.1f}c | dog EV {(-(ev_)-2*SLIP- 0)*100:+.1f}c approx")
band(rows,"ALL games pre-match fav (10m before)")
for g in ("cs2","lol","dota2","val"):
    band([x for x in rows if x[0]==g],g)
for bo in ("Bo1","Bo3","Bo5"):
    band([x for x in rows if x[1]==bo],bo)
print("n rows",len(rows), collections.Counter((x[0],x[1]) for x in rows))
