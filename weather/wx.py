"""Weather-market research helper (runs on GitHub Actions; results -> weather/out/)."""
import json, sys, time, urllib.request, urllib.parse, os, gzip
OUT = "weather/out"; os.makedirs(OUT, exist_ok=True)
UA = {"User-Agent": "predbot-research/1.0"}
def get(url, tries=3):
    for i in range(tries):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40)
            b = r.read()
            try: return json.loads(b)
            except Exception: return b.decode("utf-8", "replace")
        except Exception as e:
            err = e; time.sleep(2 + 3 * i)
    print("FAIL", url, err, file=sys.stderr); return None
def save(name, obj):
    with gzip.open(f"{OUT}/{name}.json.gz", "wt") as f: json.dump(obj, f)

def discover():
    allev = {}; log = {}
    def pull(q, cap=8000):
        off = 0; n = 0
        while off < cap:
            ev = get(f"https://gamma-api.polymarket.com/events?{q}&limit=500&offset={off}")
            if not isinstance(ev, list) or not ev: break
            for e in ev: allev[e["id"]] = e
            n += len(ev)
            if len(ev) < 500: break
            off += 500
        log[q] = n
    for slug in ("weather","temperature","climate","daily-temperature","highest-temperature","precipitation","snow","hurricanes","climate-weather"):
        for closed in ("false","true"):
            pull(f"tag_slug={slug}&closed={closed}&order=endDate&ascending=false")
    tags = get("https://gamma-api.polymarket.com/tags?limit=300&offset=0")
    log["tags_type"] = str(type(tags)); 
    if isinstance(tags, list): log["tags_sample"] = [(t.get("id"),t.get("slug")) for t in tags if any(k in (t.get("slug") or "") for k in ("weather","temp","climate","rain","snow"))]
    ps = get("https://gamma-api.polymarket.com/public-search?q=highest%20temperature&limit_per_type=50")
    log["search"] = str(ps)[:3000]
    json.dump(log, open(f"{OUT}/discover_log.json","w"), indent=1)
    save("events", list(allev.values()))
    rows = []
    for e in allev.values():
        ms = e.get("markets") or []
        rows.append({"slug": e.get("slug"), "title": e.get("title"), "end": e.get("endDate"), "closed": e.get("closed"),
                     "vol": e.get("volume"), "liq": e.get("liquidity"), "n": len(ms), "tags": [x.get("slug") for x in e.get("tags") or []][:6]})
    rows.sort(key=lambda r: r["end"] or "", reverse=True)
    json.dump(rows, open(f"{OUT}/events_summary.json","w"), indent=0)
    seen = {}; samp = []
    for e in sorted(allev.values(), key=lambda e: e.get("endDate") or "", reverse=True):
        k = " ".join((e.get("title") or "").split()[:3])
        if k in seen: continue
        seen[k] = 1; samp.append(e)
    json.dump(samp[:40], open(f"{OUT}/samples.json","w"), indent=1)

if __name__ == "__main__":
    globals()[sys.argv[1]](*sys.argv[2:])
