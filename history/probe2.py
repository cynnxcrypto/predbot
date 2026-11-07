import json, sys, time, urllib.request, urllib.parse, collections, gzip
UA = {"User-Agent": "predbot-history/1.0", "Accept-Encoding": "gzip"}
def get(url, raw=False, data=None):
    try:
        req = urllib.request.Request(url, headers={**UA, **({"Content-Type": "application/json"} if data else {})}, data=data)
        with urllib.request.urlopen(req, timeout=40) as r:
            b = r.read()
            if r.headers.get("Content-Encoding") == "gzip": b = gzip.decompress(b)
            return b if raw else json.loads(b)
    except Exception as e:
        return f"ERR {e}"
G = "https://gamma-api.polymarket.com"
def day_events(d0, d1, extra=None):
    out, off = [], 0
    while True:
        p = {"closed": "true", "end_date_min": d0, "end_date_max": d1, "limit": 500, "offset": off}
        if extra: p.update(extra)
        b = get(G + "/events?" + urllib.parse.urlencode(p))
        if not isinstance(b, list): print("ERR page", off, b); break
        out += b
        if len(b) < 500: break
        off += 500
    return out
t = time.time()
evs = day_events("2026-11-05T00:00:00Z", "2026-11-06T00:00:00Z")
print("day events", len(evs), "in", round(time.time() - t, 1), "s")
fam = collections.Counter(); smt = collections.Counter(); vol = collections.Counter(); nm = collections.Counter()
for e in evs:
    tg = {x.get("slug") for x in e.get("tags") or []}
    k = "crypto" if "crypto" in tg or "crypto-prices" in tg else ("games:" + ",".join(sorted(tg & {"soccer","esports","nba","nfl","nhl","mlb","tennis","cricket","basketball","hockey","ncaab","cfb","college-football","ufc"})) if "games" in tg else ("temp" if "daily-temperature" in tg else ("fin" if "finance-updown" in tg or ("finance" in tg and "up-or-down" in tg) else ("pol" if tg & {"politics","elections","geopolitics"} else "other"))))
    fam[k] += 1
    for m in e.get("markets") or []:
        nm[k] += 1
        if k.startswith("games"):
            s = m.get("sportsMarketType"); smt[s] += 1
            if float(m.get("volumeNum") or 0) >= 1000: vol[s] += 1
for k, v in fam.most_common(): print("FAM", k, v, "events", nm[k], "markets")
print("SMT", smt.most_common(40)); print("SMT vol>=1k", vol.most_common(40))
oth = [e.get("title") for e in evs if not any(x.get("slug") in ("crypto","crypto-prices","games","daily-temperature") for x in e.get("tags") or [])][:60]
print("OTHER sample", oth)
# earliest games
for tag in ("games", "daily-temperature", "finance-updown", "esports"):
    b = get(G + "/events?" + urllib.parse.urlencode({"tag_slug": tag, "closed": "true", "limit": 3, "order": "endDate", "ascending": "true"}))
    print("EARLIEST", tag, [(e.get("endDate"), e.get("title")) for e in b] if isinstance(b, list) else b)
# a soccer moneyline market for history/trade probes
soc = [e for e in evs if any(x.get("slug") == "soccer" for x in e.get("tags") or []) and "games" in {x.get("slug") for x in e.get("tags") or []}]
soc.sort(key=lambda e: -float(e.get("volume") or 0))
e = soc[0]; m = e["markets"][0]
print("SOC", e.get("title"), m.get("question"), m.get("gameStartTime"), m.get("volumeNum"), m.get("conditionId"))
print("EVKEYS", sorted(e.keys())); print("MKEYS", sorted(m.keys()))
tok = json.loads(m["clobTokenIds"]); cid = m["conditionId"]
gs = int(time.mktime(time.strptime(m["gameStartTime"][:19], "%Y-%m-%d %H:%M:%S"))) - time.timezone if m.get("gameStartTime") else int(time.time()) - 2 * 86400
for q in [f"interval=max&fidelity=10", f"interval=max&fidelity=1", f"startTs={gs-6*3600}&endTs={gs+3*3600}&fidelity=1", f"startTs={gs-6*86400}&endTs={gs+3*3600}&fidelity=10", f"startTs={gs-14*86400}&endTs={gs+3*3600}&fidelity=10", "interval=1w&fidelity=1"]:
    r = get(f"https://clob.polymarket.com/prices-history?market={tok[0]}&{q}")
    h = r.get("history", []) if isinstance(r, dict) else []
    print("PH", q, len(h) if h else r, h[:1], h[-1:] )
for u in [f"https://data-api.polymarket.com/trades?market={cid}&limit=5", f"https://data-api.polymarket.com/trades?market={cid}&limit=5&takerOnly=false",
          f"https://data-api.polymarket.com/trades?asset={tok[0]}&limit=5", f"https://data-api.polymarket.com/v1/trades?market={cid}&limit=5",
          f"https://data-api.polymarket.com/activity?market={cid}&limit=5", f"https://clob.polymarket.com/trades?market={cid}",
          f"https://clob.polymarket.com/live-activity/events/{e.get('id')}", f"https://data-api.polymarket.com/trades?limit=3"]:
    print("TR", u[:90], str(get(u))[:400])
q = '{"query":"{ orderFilledEvents(first: 5, orderBy: timestamp, orderDirection: desc, where: {makerAssetId: \\"%s\\"}) { timestamp maker taker makerAssetId takerAssetId makerAmountFilled takerAmountFilled transactionHash } }"}' % tok[0]
for sg in ["https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn",
           "https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/prod/gn"]:
    print("SG", sg[-40:], str(get(sg, data=q.encode()))[:600])
for name, url in [("nba", "https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json"), ("nba-stats", "https://stats.nba.com/stats/leaguegamelog?Counter=0&Direction=DESC&LeagueID=00&PlayerOrTeam=T&Season=2025-26&SeasonType=Regular%20Season&Sorter=DATE"),
                  ("iem-eglc", "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=EGLC&data=tmpf&year1=2026&month1=11&day1=1&year2=2026&month2=11&day2=2&tz=Etc/UTC&format=onlycomma&latlon=no&missing=M&direct=no"),
                  ("iem-rksi", "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=RKSI&data=tmpf&year1=2026&month1=11&day1=1&year2=2026&month2=11&day2=2&tz=Etc/UTC&format=onlycomma&latlon=no&missing=M&direct=no"),
                  ("awc", "https://aviationweather.gov/api/data/metar?ids=KLGA&format=raw&hours=30"),
                  ("ogimet", "https://www.ogimet.com/cgi-bin/getmetar?icao=EGLC&begin=202611010000&end=202611012359"),
                  ("yahoo-gc", "https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?range=5d&interval=1d"),
                  ("opendota-pro", "https://api.opendota.com/api/proMatches?less_than_match_id=9078923915"),
                  ("lolesports", "https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US"),
                  ("hltv", "https://www.hltv.org/results"), ("liquipedia", "https://liquipedia.net/counterstrike/api.php?action=parse&page=Main_Page&format=json&prop=text")]:
    r = get(url, raw=True); print("SRC", name, (r[:250] if isinstance(r, bytes) else r))
