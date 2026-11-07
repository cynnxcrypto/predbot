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
    tags = get("https://gamma-api.polymarket.com/tags?limit=1000") or []
    wtags = [t for t in tags if any(k in (t.get("slug","")+t.get("label","")).lower() for k in ("weather","temperat","climate","rain","snow","hurricane"))]
    json.dump(wtags, open(f"{OUT}/tags.json","w"), indent=1)
    allev = {}
    for t in wtags:
        for closed in ("false","true"):
            off = 0
            while off < 6000:
                ev = get(f"https://gamma-api.polymarket.com/events?tag_id={t['id']}&closed={closed}&limit=500&offset={off}&order=endDate&ascending=false")
                if not ev: break
                for e in ev: allev[e["id"]] = e
                if len(ev) < 500: break
                off += 500
    print("events", len(allev), file=sys.stderr)
    save("events", list(allev.values()))
    # compact summary
    rows = []
    for e in allev.values():
        ms = e.get("markets") or []
        rows.append({"slug": e.get("slug"), "title": e.get("title"), "end": e.get("endDate"), "closed": e.get("closed"),
                     "vol": e.get("volume"), "liq": e.get("liquidity"), "n": len(ms), "tags": [x.get("slug") for x in e.get("tags") or []][:6]})
    rows.sort(key=lambda r: r["end"] or "", reverse=True)
    json.dump(rows, open(f"{OUT}/events_summary.json","w"), indent=0)
    # one full sample per title pattern
    seen = {}; samp = []
    for e in allev.values():
        k = " ".join((e.get("title") or "").split()[:3])
        if k in seen: continue
        seen[k] = 1; samp.append(e)
    json.dump(samp[:40], open(f"{OUT}/samples.json","w"), indent=1)

if __name__ == "__main__":
    globals()[sys.argv[1]](*sys.argv[2:])
