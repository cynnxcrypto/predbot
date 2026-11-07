"""Snapshot tennis moneyline order books (pre-match T-90..start and in-play) every 5 min. Research only."""
import json, os, time, urllib.request, gzip, datetime as dt
OUT="tennis/out/books"; os.makedirs(OUT,exist_ok=True)
UA={"User-Agent":"Mozilla/5.0 (research)"}
def get(u,t=20):
    with urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=t) as r: return json.loads(r.read())
END=time.time()+float(os.environ.get("LOOP","9000"))
while time.time()<END:
    t0=time.time(); now=dt.datetime.now(dt.timezone.utc); snap=[]
    try:
        evs=[]
        for off in range(0,2000,100):
            j=get(f"https://gamma-api.polymarket.com/events?tag_slug=tennis&active=true&closed=false&limit=100&offset={off}")
            if not j: break
            evs+=j
        for e in evs:
            for m in e.get("markets",[]):
                if m.get("sportsMarketType")!="moneyline" or not m.get("gameStartTime"): continue
                gs=dt.datetime.fromisoformat(m["gameStartTime"].replace("Z","+00:00").replace(" ","T"))
                if gs.tzinfo is None: gs=gs.replace(tzinfo=dt.timezone.utc)
                mins=(gs-now).total_seconds()/60
                if not (-240<=mins<=95): continue
                bks=[]
                for tk in json.loads(m["clobTokenIds"]):
                    try:
                        b=get(f"https://clob.polymarket.com/book?token_id={tk}")
                        bks.append({"bids":[[float(x["price"]),float(x["size"])] for x in b.get("bids",[])][-10:],
                                    "asks":[[float(x["price"]),float(x["size"])] for x in b.get("asks",[])][-10:]})
                    except Exception: bks.append(None)
                snap.append({"slug":e.get("slug"),"title":e.get("title"),"mins":round(mins,1),"vol":m.get("volumeNum"),
                             "outcomes":m.get("outcomes"),"books":bks})
    except Exception as ex: snap.append({"err":str(ex)})
    json.dump({"t":t0,"markets":snap},gzip.open(f"{OUT}/{int(t0)}.json.gz","wt"))
    print(now.isoformat(),len(snap),flush=True)
    time.sleep(max(5,300-(time.time()-t0)))
