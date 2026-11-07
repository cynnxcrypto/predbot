import csv,gzip,json,os,urllib.request,urllib.parse
D=os.path.dirname(os.path.abspath(__file__))
rows=list(csv.DictReader(gzip.open(D+"/targets.csv.gz","rt")))
rows.sort(key=lambda r:int(r["end"] or 0))
pick=[rows[int(len(rows)*q)] for q in (0.05,0.3,0.6,0.9,0.99)]
out=[]
for r in pick:
  for params in ({"interval":"max","fidelity":10},{"interval":"max","fidelity":60},{"interval":"all","fidelity":60},{"startTs":int(r["end"])-8*86400,"endTs":int(r["closed"] or r["end"]),"fidelity":60},{"interval":"1m","fidelity":60}):
    u="https://clob.polymarket.com/prices-history?"+urllib.parse.urlencode({"market":r["tok"],**params})
    try:
      b=urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"predbot-research/1.0"}),timeout=30).read().decode()[:200]
    except Exception as e: b=repr(e)[:200]
    out.append(f'{r["market_id"]} end={r["end"]} {params} -> {b}')
open(D+"/out/probe.txt","w").write("\n".join(out))
print("\n".join(out))
os.system(f'cd {D}/../.. && git add research/other/out/probe.txt && git commit -qm probe && git push -q')
