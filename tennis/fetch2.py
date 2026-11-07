"""Pre-match prices for tennis moneylines the collector skipped (low volume, mostly ITF). Removes the
volume selection bias (final volume is higher after upsets). Research only."""
import csv, gzip, json, time, urllib.request, concurrent.futures as cf, os
OUT="tennis/out"; os.makedirs(OUT,exist_ok=True)
rows=list(csv.DictReader(gzip.open("tennis/missing.csv.gz","rt")))
T0=time.time(); BUDGET=float(os.environ.get("BUDGET","2100"))
def one(r):
    if time.time()-T0>BUDGET: return None
    gs=int(r["gs"]); u=f"https://clob.polymarket.com/prices-history?market={r['tok0']}&startTs={gs-4*3600}&endTs={gs+60}&fidelity=1"
    for k in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=20) as f:
                h=json.loads(f.read()).get("history",[])
            def at(ts):
                c=[x["p"] for x in h if x["t"]<=ts and ts-x["t"]<4*3600]
                return c[-1] if c else ""
            return [r["market_id"],at(gs-3600),at(gs-1800),at(gs-600),at(gs),len(h)]
        except Exception as e: time.sleep(1+2*k)
    return [r["market_id"],"","","","",-1]
res=[]
with cf.ThreadPoolExecutor(12) as ex:
    for x in ex.map(one,rows):
        if x: res.append(x)
with gzip.open(f"{OUT}/missing_prices.csv.gz","wt") as f:
    w=csv.writer(f); w.writerow(["market_id","p60","p30","p10","p0","n"]); w.writerows(res)
print("done",len(res),"of",len(rows),"in",int(time.time()-T0),"s")
