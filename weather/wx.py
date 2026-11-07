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


from concurrent.futures import ThreadPoolExecutor
import re, datetime as dt

def paged(q):
    out = {}; off = 0
    while off < 30000:
        ev = get(f"https://gamma-api.polymarket.com/events?{q}&limit=100&offset={off}")
        if not isinstance(ev, list) or not ev: break
        for e in ev: out[e["id"]] = e
        off += len(ev)
        if len(ev) < 100: break
    return out

def collect(days="80"):
    cutoff = (dt.datetime.utcnow() - dt.timedelta(days=int(days))).strftime("%Y-%m-%d")
    allev = {}
    for slug in ("highest-temperature", "daily-temperature", "weather", "temperature", "precipitation"):
        for closed in ("true", "false"):
            allev.update(paged(f"tag_slug={slug}&closed={closed}&order=endDate&ascending=false&end_date_min={cutoff}"))
    ev = [e for e in allev.values() if (e.get("endDate") or "") >= cutoff]
    print("events", len(ev), file=sys.stderr)
    # slim events
    slim = []
    for e in ev:
        st = re.search(r"\(([A-Z0-9]{4})\)", e.get("description") or "")
        slim.append({"id": e["id"], "slug": e["slug"], "title": e["title"], "end": e.get("endDate"), "start": e.get("startDate"),
                     "created": e.get("creationDate"), "closed": e.get("closed"), "vol": e.get("volume"), "liq": e.get("liquidity"),
                     "station": st.group(1) if st else None, "desc": (e.get("description") or "")[:600],
                     "markets": [{"q": m.get("groupItemTitle") or m.get("question"), "cid": m.get("conditionId"),
                                  "tok": json.loads(m.get("clobTokenIds") or "[]"), "px": m.get("outcomePrices"), "vol": m.get("volume"),
                                  "bid": m.get("bestBid"), "ask": m.get("bestAsk"), "liq": m.get("liquidity"), "closed": m.get("closed"),
                                  "fee": m.get("feeSchedule"), "rew": m.get("clobRewards")} for m in e.get("markets") or []]})
    save("wx_events", slim)
    # price history, 10-min, YES token
    jobs = []
    for e in slim:
        if not e["title"].startswith("Highest temperature"): continue
        s0 = int(dt.datetime.fromisoformat((e["created"] or e["start"]).replace("Z","+00:00")[:19]).replace(tzinfo=dt.timezone.utc).timestamp()) - 3600
        s1 = int(dt.datetime.fromisoformat(e["end"].replace("Z","+00:00")[:19]).replace(tzinfo=dt.timezone.utc).timestamp()) + 2*86400
        for m in e["markets"]:
            if m["tok"]: jobs.append((m["tok"][0], s0, s1))
    print("price jobs", len(jobs), file=sys.stderr)
    def ph(j):
        tok, a, b = j
        r = get(f"https://clob.polymarket.com/prices-history?market={tok}&startTs={a}&endTs={b}&fidelity=10")
        return tok, (r or {}).get("history") if isinstance(r, dict) else None
    hist = {}
    with ThreadPoolExecutor(8) as ex:
        for tok, h in ex.map(ph, jobs): hist[tok] = h
    save("wx_prices", hist)
    print("prices ok", sum(1 for v in hist.values() if v), file=sys.stderr)
    # trades (real fills) for markets
    def tr(cid):
        out = []; off = 0
        while off < 3000:
            r = get(f"https://data-api.polymarket.com/trades?market={cid}&limit=500&offset={off}&takerOnly=true")
            if not isinstance(r, list) or not r: break
            out += [{"t": x.get("timestamp"), "p": x.get("price"), "s": x.get("size"), "side": x.get("side"), "o": x.get("outcomeIndex")} for x in r]
            if len(r) < 500: break
            off += 500
        return cid, out
    cids = [m["cid"] for e in slim if e["title"].startswith("Highest temperature") for m in e["markets"] if m["cid"]]
    trades = {}
    with ThreadPoolExecutor(8) as ex:
        for cid, t in ex.map(tr, cids): trades[cid] = t
    save("wx_trades", trades)
    stations = sorted({e["station"] for e in slim if e["station"]})
    json.dump(stations, open(f"{OUT}/stations.json", "w"))
    obs_fc(stations, cutoff)

def obs_fc(stations, cutoff):
    info = get("https://aviationweather.gov/api/data/stationinfo?ids=" + ",".join(stations) + "&format=json") or []
    json.dump(info, open(f"{OUT}/stationinfo.json", "w"))
    end = (dt.datetime.utcnow() + dt.timedelta(days=1)).strftime("%Y-%m-%d")
    y1, m1, d1 = cutoff.split("-"); y2, m2, d2 = end.split("-")
    def ob(st):
        u = (f"https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station={st}&data=tmpf&data=metar&year1={y1}&month1={int(m1)}&day1={int(d1)}"
             f"&year2={y2}&month2={int(m2)}&day2={int(d2)}&tz=Etc/UTC&format=onlycomma&latlon=no&missing=M&trace=T&direct=no&report_type=3&report_type=4")
        return st, get(u)
    obs = {}
    with ThreadPoolExecutor(4) as ex:
        for st, t in ex.map(ob, stations): obs[st] = t if isinstance(t, str) else None
    save("wx_obs", obs)
    print("obs ok", sum(1 for v in obs.values() if v and len(v) > 1000), file=sys.stderr)
    coords = {}
    for i in info if isinstance(info, list) else []:
        sid = i.get("icaoId") or i.get("id")
        coords[sid] = (i.get("lat"), i.get("lon"))
    fc = {}
    def f(st):
        if st not in coords: return st, None
        la, lo = coords[st]; res = {}
        for model in ("best_match", "ecmwf_ifs025", "gfs_seamless"):
            u = (f"https://previous-runs-api.open-meteo.com/v1/forecast?latitude={la}&longitude={lo}&hourly=temperature_2m,temperature_2m_previous_day1,temperature_2m_previous_day2,temperature_2m_previous_day3"
                 f"&start_date={cutoff}&end_date={end}&timezone=auto&models={model}")
            res[model] = get(u)
            time.sleep(0.5)
        return st, res
    with ThreadPoolExecutor(3) as ex:
        for st, r in ex.map(f, stations): fc[st] = r
    save("wx_fc", fc)
    print("fc ok", sum(1 for v in fc.values() if v), file=sys.stderr)

if __name__ == "__main__":
    globals()[sys.argv[1]](*sys.argv[2:])
