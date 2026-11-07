#!/usr/bin/env python3
"""One-off API probe for the history collector (prints to stdout)."""
import json, sys, time, urllib.request, urllib.parse
UA = {"User-Agent": "predbot-history/1.0"}
def get(url, raw=False):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
            b = r.read()
            return b if raw else json.loads(b)
    except Exception as e:
        return f"ERR {e}"
G = "https://gamma-api.polymarket.com"
sp = get(G + "/sports")
print("## /sports", len(sp) if isinstance(sp, list) else sp)
if isinstance(sp, list):
    for s in sp: print(json.dumps(s)[:300])
tags = []
for off in range(0, 5000, 500):
    b = get(G + f"/tags?limit=500&offset={off}")
    if not isinstance(b, list) or not b: break
    tags += b
print("## tags", len(tags))
KW = ["esport","counter","cs2","league-of","dota","valorant","soccer","football","la-liga","epl","premier","nba","nfl","nhl","weather","temperature","climate","s-p","spx","sp500","stock","gold","oil","commodit","up-or-down","daily","politic","election","finance","indices","economy","mlb","ucl","serie","bundes","ligue"]
for t in tags:
    s = (t.get("slug") or "").lower()
    if any(k in s for k in KW): print("tag", t.get("id"), s, "|", t.get("label"))
def show(tag, n=4):
    b = get(G + "/events?" + urllib.parse.urlencode({"tag_slug": tag, "closed": "true", "limit": n, "order": "endDate", "ascending": "false"}))
    print(f"### tag {tag}:", "n/a" if not isinstance(b, list) else len(b))
    if not isinstance(b, list): print(b); return None
    for e in b:
        print(" EV", e.get("id"), e.get("slug"), "|", e.get("title"), "| end", e.get("endDate"), "| series", [x.get("slug") for x in e.get("series") or []], "| tags", [x.get("slug") for x in e.get("tags") or []][:8])
        for m in (e.get("markets") or [])[:6]:
            print("   M", m.get("id"), "|", m.get("question"), "| smt", m.get("sportsMarketType"), "| gst", m.get("gameStartTime"), "| out", m.get("outcomes"), m.get("outcomePrices"), "| vol", m.get("volumeNum"), "| uma", m.get("umaResolutionStatus"), "| closed", m.get("closedTime"), "| cid", (m.get("conditionId") or "")[:12], "| groupItem", m.get("groupItemTitle"))
    return b
keep = {}
for tag in ["esports","counter-strike-2","cs2","league-of-legends","dota-2","soccer","la-liga","epl","nba","nfl","nhl","weather","temperature","highest-temperature","daily-temperature","up-or-down","stocks","finance","commodities","politics","elections","mlb","ucl"]:
    r = show(tag)
    if isinstance(r, list) and r: keep[tag] = r
print("## events keys sample"); 
for k, v in keep.items():
    print(k, sorted(v[0].keys())); print("market keys", sorted(v[0]["markets"][0].keys())); break
# description of one temperature / up-down market
for k in ("temperature", "weather", "highest-temperature", "up-or-down", "stocks"):
    if k in keep:
        m = keep[k][0]["markets"][0]; print("DESC", k, (m.get("description") or "")[:900]); print("resSource", m.get("resolutionSource"), keep[k][0].get("resolutionSource"))
# search
for qy in ["highest temperature", "S&P 500 up or down", "Gold up or down", "Counter-Strike", "Map 1 winner"]:
    b = get(G + "/public-search?" + urllib.parse.urlencode({"q": qy, "limit_per_type": 5, "events_status": "closed"}))
    if isinstance(b, dict):
        for e in (b.get("events") or [])[:5]: print("SEARCH", qy, "|", e.get("slug"), "|", e.get("title"), "| series", [x.get("slug") for x in e.get("series") or []] if e.get("series") else None, "| tags", [x.get("slug") for x in e.get("tags") or []][:8])
    else: print("SEARCH", qy, str(b)[:200])
# prices-history on one closed token
for k, v in keep.items():
    m = v[0]["markets"][0]; tok = json.loads(m.get("clobTokenIds") or "[]")
    if not tok: continue
    for fid in (1, 10, 60):
        st = int(time.time()) - 20 * 86400
        r = get(f"https://clob.polymarket.com/prices-history?market={tok[0]}&startTs={st}&endTs={int(time.time())}&fidelity={fid}")
        print("PH", k, fid, (len(r.get("history", [])) if isinstance(r, dict) else r), str(r)[:200])
    r = get(f"https://clob.polymarket.com/prices-history?market={tok[0]}&interval=max&fidelity=10"); print("PH max", str(r)[:200], len(r.get("history", [])) if isinstance(r, dict) else "")
    r = get(f"https://data-api.polymarket.com/trades?market={m.get('conditionId')}&limit=5"); print("TRADES", str(r)[:600])
    break
for name, url in [("stooq", "https://stooq.com/q/d/l/?s=%5Espx&i=d"), ("yahoo", "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=5d&interval=1d"),
                  ("iem", "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=KLGA&data=tmpf&year1=2026&month1=11&day1=1&year2=2026&month2=11&day2=2&tz=America/New_York&format=onlycomma&latlon=no&missing=M&trace=T&direct=no"),
                  ("iem-eglc", "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=EGLC&data=tmpf&year1=2026&month1=11&day1=1&year2=2026&month2=11&day2=2&tz=Europe/London&format=onlycomma&latlon=no&missing=M&trace=T&direct=no"),
                  ("nba", "https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json"), ("nhl", "https://api-web.nhle.com/v1/score/2026-11-05"),
                  ("nflverse", "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"), ("fdco", "https://www.football-data.co.uk/mmz4281/2526/SP1.csv"),
                  ("fdco-new", "https://www.football-data.co.uk/new/ARG.csv"), ("openmeteo", "https://archive-api.open-meteo.com/v1/archive?latitude=40.77&longitude=-73.87&start_date=2026-11-01&end_date=2026-11-03&daily=temperature_2m_max"),
                  ("fred", "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILWTICO"), ("liquipedia", "https://liquipedia.net/counterstrike/api.php?action=query&format=json&list=categorymembers&cmtitle=Category:Tournaments&cmlimit=2"),
                  ("opendota", "https://api.opendota.com/api/proMatches"), ("hko", "https://data.weather.gov.hk/weatherAPI/opendata/opendata.php?dataType=CLMMAXT&rformat=csv&station=HKO")]:
    r = get(url, raw=True)
    print("SRC", name, (r[:300] if isinstance(r, bytes) else r))
