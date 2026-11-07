#!/usr/bin/env python3
"""Esports Polymarket research (research only; never touches the bot). Stdlib only."""
import json, os, sys, time, urllib.request, urllib.parse
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"); os.makedirs(OUT, exist_ok=True)
G = "https://gamma-api.polymarket.com"; C = "https://clob.polymarket.com"
UA = {"User-Agent": "Mozilla/5.0 predbot-research"}
def get(url, params=None, tries=4, raw=False, headers=None):
    if params: url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={**UA, **(headers or {})}), timeout=30) as r:
                b = r.read()
                if raw: return r.status, b
                return json.loads(b) if b[:1] in (b"{", b"[") else b.decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if raw: return e.code, b""
            if i == tries - 1: print("FAIL", url[:150], e, file=sys.stderr); return None
        except Exception as e:
            if i == tries - 1:
                print("FAIL", url[:150], e, file=sys.stderr)
                return (0, b"") if raw else None
        time.sleep(1.5 * (i + 1))
def dump(name, obj): json.dump(obj, open(f"{OUT}/{name}.json", "w"), indent=1)

def discover():
    sp = get(G + "/sports"); dump("sports", sp)
    tags = {}
    for slug in ["esports", "counter-strike-2", "cs2", "league-of-legends", "dota-2", "valorant", "lol", "dota2", "call-of-duty", "rainbow-six", "overwatch", "rocket-league", "mobile-legends"]:
        t = get(G + f"/tags/slug/{slug}"); tags[slug] = t
    dump("tags", tags)
    ev = get(G + "/events", {"tag_slug": "esports", "closed": "false", "limit": 5})
    dump("sample_open", ev)
    evc = get(G + "/events", {"tag_slug": "esports", "closed": "true", "limit": 3, "order": "endDate", "ascending": "false"})
    dump("sample_closed", evc)

if __name__ == "__main__":
    for step in sys.argv[1:]:
        globals()[step]()

# ------------------------------------------------------------------ main steps
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
NOW = datetime.now(timezone.utc)
SERIES = {"cs2": 10310, "lol": 10311, "dota2": 10309, "val": 10369, "mlbb": 10426, "codmw": 10427, "r6siege": 10432,
          "rl": 10433, "ow": 10430, "hok": 10434, "sc2": 10435, "fifa": 10428, "pubg": 10431, "wildrift": 10429}
def jl(x):
    if isinstance(x, str):
        try: return json.loads(x)
        except Exception: return None
    return x
def ts(s):
    if not s: return None
    s = str(s).replace(" ", "T")
    if s.endswith("+00"): s += ":00"
    s = s.replace("+00:00:00", "+00:00").replace("Z", "+00:00")
    try:
        d = datetime.fromisoformat(s); return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        try: return datetime.fromisoformat(s[:19]).replace(tzinfo=timezone.utc)
        except Exception: return None
def page(params, cap=20000):
    out, off = [], 0
    while off < cap:
        b = get(G + "/events", dict(params, limit=100, offset=off))
        if not b: break
        out += b
        if len(b) < 100: break
        off += 100
    return out

def landscape():
    rows = []
    for g, sid in SERIES.items():
        evs = page({"series_id": sid, "closed": "false"})
        for e in evs:
            for m in e.get("markets") or []:
                if m.get("closed"): continue
                rows.append({"game": g, "event": e.get("title"), "eslug": e.get("slug"), "q": m.get("question"), "smt": m.get("sportsMarketType"),
                             "start": m.get("gameStartTime") or e.get("startTime"), "end": m.get("endDate"), "spread": m.get("spread"),
                             "bid": m.get("bestBid"), "ask": m.get("bestAsk"), "vol": m.get("volumeNum"), "vol24": m.get("volume24hr"),
                             "liq": m.get("liquidityNum"), "fee": m.get("feeSchedule"), "tok": jl(m.get("clobTokenIds")), "accepting": m.get("acceptingOrders")})
    # depth for moneylines starting within 48h
    def book(r):
        try:
            b = get(C + "/book", {"token_id": r["tok"][0]})
            bids = sorted([(float(x["price"]), float(x["size"])) for x in b.get("bids", [])], reverse=True)
            asks = sorted([(float(x["price"]), float(x["size"])) for x in b.get("asks", [])])
            r["bb"] = bids[0] if bids else None; r["ba"] = asks[0] if asks else None
            r["depth2c_usd"] = round(sum(p * s for p, s in asks if asks and p <= asks[0][0] + .02) + sum(p * s for p, s in bids if bids and p >= bids[0][0] - .02))
        except Exception: pass
    sel = [r for r in rows if r["tok"] and r["start"] and ts(r["start"]) and timedelta(0) < ts(r["start"]) - NOW < timedelta(hours=48)]
    with ThreadPoolExecutor(8) as ex: list(ex.map(book, sel))
    dump("landscape", rows)
    print("landscape rows", len(rows), "booked", len(sel))

def collect():
    since = sys.argv[sys.argv.index("collect") + 1] if False else "2025-01-01"
    allev = []
    for g, sid in SERIES.items():
        evs = page({"series_id": sid, "closed": "true", "order": "endDate", "ascending": "false", "end_date_min": since + "T00:00:00Z"})
        for e in evs: e["_game"] = g
        allev += evs
        print(g, len(evs), file=sys.stderr)
    recs = []
    for e in allev:
        ms = e.get("markets") or []
        for m in ms:
            op = jl(m.get("outcomePrices")) or []
            try: wi = [float(x) for x in op].index(1.0)
            except Exception: wi = None
            recs.append({"game": e["_game"], "eid": e.get("id"), "event": e.get("title"), "eslug": e.get("slug"), "score": e.get("score"),
                         "estart": e.get("startTime") or e.get("startDate"), "eend": e.get("endDate"), "evol": e.get("volume"),
                         "mid": m.get("id"), "q": m.get("question"), "git": m.get("groupItemTitle"), "smt": m.get("sportsMarketType"),
                         "line": m.get("line"), "gst": m.get("gameStartTime"), "closed": m.get("closedTime"), "outs": jl(m.get("outcomes")),
                         "win": wi, "vol": m.get("volumeNum"), "fee": m.get("feeSchedule"), "tok": jl(m.get("clobTokenIds")), "tags": [t.get("slug") for t in e.get("tags") or []]})
    print("markets", len(recs), file=sys.stderr)
    def hist(r):
        if not r["tok"] or (r["vol"] or 0) < 500: return
        gs = ts(r["gst"]) or ts(r["estart"]); ce = ts(r["closed"]) or ts(r["eend"])
        if not gs: return
        st_ = int((gs - timedelta(hours=6)).timestamp()); en = int(min(ce or gs + timedelta(hours=10), gs + timedelta(hours=10)).timestamp())
        if en <= st_: en = st_ + 16 * 3600
        h = get(C + "/prices-history", {"market": r["tok"][0], "startTs": st_, "endTs": en, "fidelity": 1})
        if not h or not h.get("history"):
            h = get(C + "/prices-history", {"market": r["tok"][0], "startTs": st_, "endTs": en, "fidelity": 10})
        r["h"] = [(x["t"], x["p"]) for x in (h or {}).get("history", [])]
    with ThreadPoolExecutor(10) as ex: list(ex.map(hist, recs))
    print("with history", sum(1 for r in recs if r.get("h")), file=sys.stderr)
    import gzip
    with gzip.open(f"{OUT}/markets.json.gz", "wt") as f: json.dump(recs, f)

def sources():
    tests = {
        "liquipedia_api_cs": "https://liquipedia.net/counterstrike/api.php?action=query&list=recentchanges&format=json&rclimit=5",
        "liquipedia_transfers_cs": "https://liquipedia.net/counterstrike/Portal:Transfers",
        "liquipedia_lol_matches": "https://liquipedia.net/leagueoflegends/Liquipedia:Matches",
        "hltv_results": "https://www.hltv.org/results",
        "hltv_rss": "https://www.hltv.org/rss/news",
        "bo3gg_api": "https://api.bo3.gg/api/v1/matches?page[limit]=5",
        "opendota_pro": "https://api.opendota.com/api/proMatches",
        "opendota_teams": "https://api.opendota.com/api/teams",
        "stratz": "https://api.stratz.com/graphql",
        "lolesports_schedule": "https://esports-api.lolesports.com/persisted/gw/getSchedule?hl=en-US",
        "gol_gg": "https://gol.gg/tournament/list/",
        "oracleselixir": "https://oracleselixir.com/tools/downloads",
        "leaguepedia_cargo": "https://lol.fandom.com/api.php?action=cargoquery&tables=ScoreboardGames&fields=Team1,Team2,WinTeam,DateTime_UTC&limit=5&format=json&order_by=DateTime_UTC%20DESC",
        "vlr_gg": "https://www.vlr.gg/matches/results",
        "vlrggapi": "https://vlrggapi.vercel.app/match?q=results",
        "pandascore": "https://api.pandascore.co/matches?per_page=1",
        "gosugamers": "https://www.gosugamers.net/counterstrike/matches/results",
        "steam_cs2_news": "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=3",
        "steam_dota_news": "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=570&count=3",
        "dota_patch": "https://www.dota2.com/datafeed/patchnoteslist?language=english",
        "reddit_csgo": "https://www.reddit.com/r/GlobalOffensive/new.json?limit=3",
        "reddit_lol_comp": "https://www.reddit.com/r/leagueoflegends/new.json?limit=3",
        "dust2_us_rss": "https://www.dust2.us/rss",
        "dotabuff_esports": "https://www.dotabuff.com/esports/matches",
        "datdota": "https://www.datdota.com/api/matches?tier=1",
        "esportsearnings": "https://www.esportsearnings.com/",
        "oddsportal_esports": "https://www.oddsportal.com/esports/",
        "ggbet_api": "https://gg.bet/en/esports",
        "thunderpick": "https://thunderpick.io/en/esports",
        "pinnacle_guest": "https://guest.api.arcadia.pinnacle.com/0.1/sports/12/matchups",
        "betfair_esports": "https://www.betfair.com/sport/esports",
        "google_news_cs2": "https://news.google.com/rss/search?q=CS2+roster+stand-in&hl=en",
        "twitch": "https://www.twitch.tv/",
        "grid_open": "https://api-op.grid.gg/central-data/graphql",
        "abios": "https://api.abiosgaming.com/v3/series",
        "cs_mapstats_hltv": "https://www.hltv.org/stats/teams/maps",
        "liquipedia_val": "https://liquipedia.net/valorant/api.php?action=query&list=recentchanges&format=json&rclimit=3",
        "liquipedia_dota": "https://liquipedia.net/dota2/api.php?action=query&list=recentchanges&format=json&rclimit=3",
    }
    res = {}
    for k, u in tests.items():
        t0 = time.time(); st_, b = get(u, raw=True, tries=1)
        res[k] = {"status": st_, "bytes": len(b or b""), "sec": round(time.time() - t0, 1), "head": (b or b"")[:200].decode("utf-8", "replace")}
        time.sleep(1.2)
    dump("sources", res)
