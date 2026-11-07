#!/usr/bin/env python3
"""Non-crypto Polymarket survey (research only; does not touch the trading bot).

Steps (each writes survey/out/<step>.json and a line block in survey/out/summary.md):
  landscape   open events/markets by category: counts, volume, liquidity, spread, time to end, fees
  calib       closed markets (last N days): price at fixed times before close vs outcome, by category
  sports      Polymarket game moneylines vs ESPN-listed sportsbook moneylines (de-vigged)
  overdue     open markets past their end date still priced 90-99c (resolution-lag carry)
  kalshi      Kalshi open-market counts by category
  feeds       reachability + freshness of free news feeds
Stdlib only.
"""
import json, os, sys, time, math, re, statistics as st, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
NOW = datetime.now(timezone.utc)
UA = {"User-Agent": "predbot-survey/1.0"}
SUMMARY = []

def get(url, params=None, tries=4, headers=None):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={**UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
                return json.loads(raw) if raw[:1] in (b"{", b"[") else raw.decode("utf-8", "replace")
        except Exception as e:
            if i == tries - 1:
                print("GET fail", url[:140], e, file=sys.stderr)
                return None
            time.sleep(1.5 * (i + 1))

def jl(x):
    if isinstance(x, str):
        try: return json.loads(x)
        except Exception: return None
    return x

def ts(s):
    if not s: return None
    s = s.replace(" ", "T").replace("+00", "+00:00") if s.endswith("+00") else s.replace(" ", "T")
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return None

CATS = ["Sports", "Politics", "Elections", "Geopolitics", "Crypto", "Economy", "Business", "Finance",
        "Tech", "Science", "Culture", "Pop Culture", "Weather", "Mentions", "World"]
SPORT_HINT = re.compile(r"\b(nfl|nba|nhl|mlb|ncaa|epl|premier league|la liga|serie a|bundesliga|ligue 1|champions league|ufc|tennis|atp|wta|f1|formula 1|golf|pga|soccer|football|basketball|hockey|cricket|esports|valorant|cs2|counter-strike|league of legends|lol|dota)\b", re.I)

def category(ev):
    labels = [t.get("label", "") for t in (ev.get("tags") or [])]
    ls = {l.lower() for l in labels}
    if any(m.get("sportsMarketType") or m.get("gameStartTime") for m in ev.get("markets") or []):
        return "Sports"
    for c in CATS:
        if c.lower() in ls:
            if c in ("Elections",): return "Politics"
            if c in ("Pop Culture",): return "Culture"
            if c in ("Business", "Finance"): return "Economy"
            if c in ("Science",): return "Tech"
            if c in ("World",): return "Geopolitics"
            return c
    if SPORT_HINT.search(" ".join(labels) + " " + (ev.get("title") or "")): return "Sports"
    return "Other"

def page_events(params, cap=40000):
    out, off = [], 0
    while off < cap:
        p = dict(params, limit=500, offset=off)
        b = get(GAMMA + "/events", p)
        if not b: break
        out += b
        if len(b) < 500: break
        off += 500
    return out

def q(xs, f):
    xs = sorted(xs)
    if not xs: return None
    return xs[min(len(xs) - 1, int(f * len(xs)))]

def fee_per_share(m, p):
    fs = m.get("feeSchedule") or {}
    if not m.get("feesEnabled") or not fs: return 0.0
    r, e = fs.get("rate", 0) or 0, fs.get("exponent", 1) or 1
    return r * (p * (1 - p)) ** e

def say(*lines):
    for l in lines:
        print(l); SUMMARY.append(l)

# ---------------------------------------------------------------- landscape
def landscape():
    evs = page_events({"closed": "false", "active": "true"})
    say(f"## Landscape ({NOW:%Y-%m-%d %H:%M} UTC)", f"open events fetched: {len(evs)}")
    by = {}
    feetypes = {}
    for ev in evs:
        c = category(ev)
        d = by.setdefault(c, {"events": 0, "markets": 0, "vol24": 0.0, "liq": 0.0, "spreads": [], "days_left": [], "liq_mkts": 0, "fee_mkts": 0, "neg_risk": 0})
        d["events"] += 1
        d["vol24"] += float(ev.get("volume24hr") or 0)
        d["liq"] += float(ev.get("liquidity") or 0)
        d["neg_risk"] += 1 if ev.get("negRisk") else 0
        for m in ev.get("markets") or []:
            if m.get("closed") or not m.get("acceptingOrders", True): continue
            d["markets"] += 1
            sp = m.get("spread")
            if sp is not None and float(m.get("liquidityNum") or 0) >= 1000:
                d["spreads"].append(float(sp)); d["liq_mkts"] += 1
            e = ts(m.get("endDate"))
            if e: d["days_left"].append((e - NOW).total_seconds() / 86400)
            if m.get("feesEnabled"):
                d["fee_mkts"] += 1
                k = (c, m.get("feeType"), json.dumps(m.get("feeSchedule"), sort_keys=True))
                feetypes[k] = feetypes.get(k, 0) + 1
    rows = []
    for c, d in sorted(by.items(), key=lambda x: -x[1]["vol24"]):
        r = {"cat": c, "events": d["events"], "markets": d["markets"], "vol24_usd": round(d["vol24"]),
             "liquidity_usd": round(d["liq"]), "mkts_liq1k": d["liq_mkts"],
             "spread_med_c": round(100 * (q(d["spreads"], .5) or 0), 1), "spread_p90_c": round(100 * (q(d["spreads"], .9) or 0), 1),
             "days_left_med": round(q(d["days_left"], .5) or 0, 1), "share_ending_7d": round(sum(1 for x in d["days_left"] if x <= 7) / max(1, len(d["days_left"])), 2),
             "fee_mkts": d["fee_mkts"]}
        rows.append(r)
        say(f"- {c}: {r['events']} ev / {r['markets']} mkts, 24h vol ${r['vol24_usd']:,}, liq ${r['liquidity_usd']:,}, spread med {r['spread_med_c']}c p90 {r['spread_p90_c']}c (liq>=1k: {r['mkts_liq1k']}), days-left med {r['days_left_med']}, ≤7d {r['share_ending_7d']}, fee mkts {r['fee_mkts']}")
    say("fee schedules:")
    for (c, ft, sch), n in sorted(feetypes.items(), key=lambda x: -x[1])[:25]:
        say(f"  {c} {ft} {sch}: {n}")
    top = sorted(evs, key=lambda e: -float(e.get("volume24hr") or 0))[:40]
    say("top 40 events by 24h volume:")
    for e in top:
        say(f"  {category(e)} | {e.get('title')} | 24h ${float(e.get('volume24hr') or 0):,.0f} | liq ${float(e.get('liquidity') or 0):,.0f} | end {str(e.get('endDate'))[:10]}")
    json.dump({"rows": rows, "fees": [list(k) + [n] for k, n in feetypes.items()]}, open(f"{OUT}/landscape.json", "w"), indent=1)
    return evs

# ---------------------------------------------------------------- overdue (resolution lag)
def overdue(evs):
    say("## Overdue: open markets past end date")
    rows = []
    for ev in evs:
        for m in ev.get("markets") or []:
            if m.get("closed"): continue
            e = ts(m.get("endDate"))
            if not e or e > NOW - timedelta(hours=2): continue
            bb, ba = m.get("bestBid"), m.get("bestAsk")
            if ba is None or bb is None: continue
            ba, bb = float(ba), float(bb)
            # the favoured side's ask
            fav_ask = ba if bb + ba > 1 else None
            fav = max(bb, 1 - ba)
            side_ask = ba if (bb + ba) / 2 >= 0.5 else 1 - bb
            if not (0.85 <= side_ask <= 0.995): continue
            liq = float(m.get("liquidityNum") or 0)
            rows.append({"cat": category(ev), "q": m.get("question"), "end": m.get("endDate"), "hours_over": round((NOW - e).total_seconds() / 3600, 1),
                         "fav_ask": round(side_ask, 3), "liq": round(liq), "uma": m.get("umaResolutionStatuses"), "slug": m.get("slug")})
    rows.sort(key=lambda r: -r["liq"])
    by = {}
    for r in rows: by[r["cat"]] = by.get(r["cat"], 0) + 1
    say(f"overdue markets with favourite ask 85-99.5c: {len(rows)} {by}")
    for r in rows[:40]:
        say(f"  {r['cat']} | ask {r['fav_ask']} | +{r['hours_over']}h | liq ${r['liq']:,} | {r['q'][:90]}")
    json.dump(rows, open(f"{OUT}/overdue.json", "w"), indent=1)

# ---------------------------------------------------------------- calibration
def price_at(hist, t):
    best = None
    for h in hist:
        if h["t"] <= t: best = h["p"]
        else: break
    return best

def calib(days=120, min_vol=5000):
    since = (NOW - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    evs = page_events({"closed": "true", "end_date_min": since, "order": "endDate", "ascending": "false"}, cap=60000)
    say(f"## Calibration (closed events since {since[:10]}, vol>=${min_vol:,})", f"closed events fetched: {len(evs)}")
    jobs = []
    for ev in evs:
        c = category(ev)
        for m in ev.get("markets") or []:
            if float(m.get("volumeNum") or 0) < min_vol: continue
            outs, prices, toks = jl(m.get("outcomes")), jl(m.get("outcomePrices")), jl(m.get("clobTokenIds"))
            if not (outs and prices and toks) or len(outs) != 2: continue
            try: pr = [float(x) for x in prices]
            except Exception: continue
            if max(pr) < 0.99: continue  # unresolved / 50-50
            yes_won = pr[0] > 0.5
            ref = ts(m.get("closedTime")) or ts(m.get("umaEndDate")) or ts(m.get("endDate"))
            gs = ts(m.get("gameStartTime")) or (ts(m.get("eventStartTime")) if m.get("sportsMarketType") else None)
            jobs.append({"cat": c, "sub": m.get("sportsMarketType") or "", "q": m.get("question"), "tok": toks[0], "yes_won": yes_won,
                         "ref": ref.timestamp() if ref else None, "game": gs.timestamp() if gs else None, "vol": float(m.get("volumeNum") or 0),
                         "fee": fee_per_share(m, 0.5) > 0, "feeSchedule": m.get("feeSchedule"), "feesEnabled": m.get("feesEnabled"),
                         "tags": [t.get("label") for t in ev.get("tags") or []][:6]})
    say(f"binary resolved markets: {len(jobs)}")
    def fetch(j):
        h = get(CLOB + "/prices-history", {"market": j["tok"], "interval": "max", "fidelity": 10})
        hist = (h or {}).get("history") if isinstance(h, dict) else None
        if not hist: return None
        hist.sort(key=lambda x: x["t"])
        j = dict(j)
        last = hist[-1]["t"]
        ref = j["ref"] or last
        ref = min(ref, last + 60)
        j["n_pts"] = len(hist)
        for name, sec in (("p1h", 3600), ("p6h", 6 * 3600), ("p24h", 86400), ("p7d", 7 * 86400)):
            j[name] = price_at(hist, ref - sec)
        if j["game"]:
            j["p_pre"] = price_at(hist, j["game"] - 600)      # 10 min before start
            j["p_pre6h"] = price_at(hist, j["game"] - 6 * 3600)
            j["p_open"] = hist[0]["p"]
        return j
    with ThreadPoolExecutor(16) as ex:
        res = [r for r in ex.map(fetch, jobs) if r]
    json.dump(res, open(f"{OUT}/calib_raw.json", "w"))
    say(f"with price history: {len(res)}")
    bands = [(0.0, .05), (.05, .1), (.1, .2), (.2, .3), (.3, .4), (.4, .5), (.5, .6), (.6, .7), (.7, .8), (.8, .9), (.9, .95), (.95, 1.0)]
    def table(rows, key, label):
        # both sides: YES at p, NO at 1-p
        pts = []
        for r in rows:
            p = r.get(key)
            if p is None or p <= 0.005 or p >= 0.995: continue
            pts.append((p, 1 if r["yes_won"] else 0)); pts.append((1 - p, 0 if r["yes_won"] else 1))
        if len(pts) < 40: return
        say(f"### {label} [{key}] n_mkts={len(pts)//2}")
        for lo, hi in bands:
            b = [(p, w) for p, w in pts if lo <= p < hi]
            if len(b) < 15: continue
            avgp = sum(p for p, _ in b) / len(b); wr = sum(w for _, w in b) / len(b)
            se = math.sqrt(max(wr * (1 - wr), 1e-4) / len(b))
            say(f"  {int(lo*100):>2}-{int(hi*100):<3}c n={len(b):>5} avg {avgp*100:5.1f}c won {wr*100:5.1f}% edge {100*(wr-avgp):+5.1f}pts (±{200*se:.1f}) ROI {100*(wr/avgp-1):+6.1f}%")
    groups = {}
    for r in res:
        groups.setdefault(r["cat"], []).append(r)
        if r["cat"] == "Sports":
            groups.setdefault("Sports/" + (r["sub"] or "other"), []).append(r)
            for t in r["tags"]:
                if t and t.lower() in ("nfl", "nba", "nhl", "mlb", "soccer", "tennis", "esports", "ufc", "ncaaf", "cfb", "college football", "epl", "mls", "cricket"):
                    groups.setdefault("Sports/" + t.upper(), []).append(r)
    for g in sorted(groups, key=lambda g: -len(groups[g])):
        rows = groups[g]
        if len(rows) < 60: continue
        say(f"#### {g}: {len(rows)} markets")
        if g.startswith("Sports"):
            table(rows, "p_pre", g + " 10 min pre-game")
            table(rows, "p_pre6h", g + " 6 h pre-game")
        for k in ("p24h", "p7d"):
            table(rows, k, g + " before close")

# ---------------------------------------------------------------- sports vs books
ESPN_LEAGUES = ["football/nfl", "football/college-football", "basketball/nba", "basketball/mens-college-basketball", "hockey/nhl",
                "soccer/eng.1", "soccer/esp.1", "soccer/ita.1", "soccer/ger.1", "soccer/fra.1", "soccer/uefa.champions", "soccer/usa.1", "mma/ufc"]

def ml_to_p(ml):
    try: ml = float(str(ml).replace("+", ""))
    except Exception: return None
    if ml == 0: return None
    return 100 / (ml + 100) if ml > 0 else -ml / (-ml + 100)

def sports():
    say("## Sports: Polymarket vs ESPN-listed sportsbook moneylines")
    games = []
    for lg in ESPN_LEAGUES:
        for d in range(0, 3):
            day = (NOW + timedelta(days=d)).strftime("%Y%m%d")
            b = get(f"https://site.api.espn.com/apis/site/v2/sports/{lg}/scoreboard", {"dates": day, "limit": 300})
            if not isinstance(b, dict): continue
            for e in b.get("events") or []:
                comp = (e.get("competitions") or [{}])[0]
                if (comp.get("status") or {}).get("type", {}).get("state") != "pre": continue
                odds = (comp.get("odds") or [{}])
                o = odds[0] if odds else {}
                teams = {c.get("homeAway"): c.get("team", {}) for c in comp.get("competitors") or []}
                hml = (o.get("homeTeamOdds") or {}).get("moneyLine"); aml = (o.get("awayTeamOdds") or {}).get("moneyLine")
                ml = o.get("moneyline") or {}
                if hml is None and ml:
                    hml = ((ml.get("home") or {}).get("close") or {}).get("odds"); aml = ((ml.get("away") or {}).get("close") or {}).get("odds")
                dml = None
                if ml and ml.get("draw"):
                    dml = ((ml.get("draw") or {}).get("close") or {}).get("odds")
                if o.get("drawOdds"): dml = (o.get("drawOdds") or {}).get("moneyLine", dml)
                games.append({"lg": lg, "date": e.get("date"), "name": e.get("name"), "provider": (o.get("provider") or {}).get("name"),
                              "home": teams.get("home", {}), "away": teams.get("away", {}), "hml": hml, "aml": aml, "dml": dml})
    say(f"ESPN pre-game events: {len(games)}, with moneylines: {sum(1 for g in games if g['hml'] is not None)}")
    pm = page_events({"closed": "false", "active": "true", "tag_slug": "sports"}, cap=10000)
    pm_mk = []
    for ev in pm:
        for m in ev.get("markets") or []:
            if m.get("sportsMarketType") != "moneyline" or m.get("closed"): continue
            outs = jl(m.get("outcomes")) or []
            pm_mk.append({"ev": ev.get("title"), "q": m.get("question"), "outs": outs, "bid": m.get("bestBid"), "ask": m.get("bestAsk"),
                          "start": m.get("gameStartTime") or m.get("eventStartTime"), "liq": float(m.get("liquidityNum") or 0), "slug": m.get("slug"),
                          "fee": m.get("feeSchedule")})
    say(f"Polymarket open moneyline markets: {len(pm_mk)}")
    def norm(s): return re.sub(r"[^a-z0-9 ]", "", (s or "").lower())
    matches = []
    for g in games:
        if g["hml"] is None or g["aml"] is None: continue
        gd = ts(g["date"])
        hn = [norm(g["home"].get(k)) for k in ("shortDisplayName", "name", "displayName", "location") if g["home"].get(k)]
        an = [norm(g["away"].get(k)) for k in ("shortDisplayName", "name", "displayName", "location") if g["away"].get(k)]
        for m in pm_mk:
            st_ = ts(m["start"])
            if not st_ or not gd or abs((st_ - gd).total_seconds()) > 6 * 3600: continue
            text = norm(m["ev"] + " " + m["q"] + " " + " ".join(m["outs"]))
            if not (any(x and x in text for x in hn) and any(x and x in text for x in an)): continue
            ph, pa = ml_to_p(g["hml"]), ml_to_p(g["aml"]); pd = ml_to_p(g["dml"]) if g["dml"] else 0
            if not ph or not pa: continue
            tot = ph + pa + (pd or 0)
            # which team does YES (outcome 0) refer to?
            o0 = norm(m["outs"][0]) if m["outs"] else ""
            qn = norm(m["q"])
            if len(m["outs"]) == 2 and o0 not in ("yes", "no"):
                yes_home = any(x and (x in o0 or o0 in x) for x in hn)
            else:
                yes_home = any(x and x in qn for x in hn) and not any(x and x in qn for x in an)
            book_p = (ph if yes_home else pa) / tot
            if m["bid"] is None or m["ask"] is None: continue
            mid = (float(m["bid"]) + float(m["ask"])) / 2
            matches.append({"lg": g["lg"], "game": g["name"], "provider": g["provider"], "pm_q": m["q"], "yes_home": yes_home, "book_p": round(book_p, 4),
                            "pm_bid": float(m["bid"]), "pm_ask": float(m["ask"]), "pm_mid": round(mid, 4), "diff_mid": round(mid - book_p, 4),
                            "liq": round(m["liq"]), "start": m["start"], "overround": round(tot - 1, 4), "slug": m["slug"]})
            break
    say(f"matched games: {len(matches)}")
    if matches:
        ds = [x["diff_mid"] for x in matches]
        say(f"PM mid − de-vigged book prob: mean {100*st.mean(ds):+.2f}pts, median abs {100*st.median([abs(d) for d in ds]):.2f}pts, p90 abs {100*q([abs(d) for d in ds], .9):.2f}pts")
        edge = [x for x in matches if x["book_p"] - x["pm_ask"] >= 0.03 or (1 - x["book_p"]) - (1 - x["pm_bid"]) >= 0.03]
        say(f"games where buying on PM at the ask beats book fair by ≥3pts: {len(edge)}")
        by = {}
        for x in matches: by.setdefault(x["lg"], []).append(x["diff_mid"])
        for lg, v in by.items():
            say(f"  {lg}: n={len(v)} mean {100*st.mean(v):+.2f} median|d| {100*st.median([abs(a) for a in v]):.2f}")
        for x in sorted(matches, key=lambda x: -abs(x["diff_mid"]))[:15]:
            say(f"  {x['lg']} {x['game']} | {x['pm_q'][:50]} | book {x['book_p']:.3f} ({x['provider']}) PM {x['pm_bid']}/{x['pm_ask']} | liq ${x['liq']:,}")
    json.dump({"games": games, "matches": matches}, open(f"{OUT}/sports.json", "w"), indent=1, default=str)

# ---------------------------------------------------------------- kalshi
def kalshi():
    say("## Kalshi open markets")
    cur, rows, n = None, [], 0
    evs = []
    while n < 40:
        p = {"limit": 200, "status": "open", "with_nested_markets": "true"}
        if cur: p["cursor"] = cur
        b = get("https://api.elections.kalshi.com/trade-api/v2/events", p)
        if not isinstance(b, dict): break
        evs += b.get("events") or []
        cur = b.get("cursor"); n += 1
        if not cur: break
    by = {}
    for e in evs:
        c = e.get("category") or "?"
        d = by.setdefault(c, [0, 0, 0.0])
        d[0] += 1
        for m in e.get("markets") or []:
            d[1] += 1; d[2] += float(m.get("volume_24h") or 0)
    say(f"Kalshi open events fetched: {len(evs)}")
    for c, d in sorted(by.items(), key=lambda x: -x[1][2]):
        say(f"  {c}: {d[0]} ev / {d[1]} mkts, 24h contracts {d[2]:,.0f}")
    json.dump([{k: e.get(k) for k in ("event_ticker", "title", "category", "sub_title")} for e in evs], open(f"{OUT}/kalshi.json", "w"))

# ---------------------------------------------------------------- feeds
FEEDS = {
    "Google News top": "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en",
    "Google News politics search": "https://news.google.com/rss/search?q=election+results&hl=en-US&gl=US&ceid=US:en",
    "BBC world": "https://feeds.bbci.co.uk/news/world/rss.xml",
    "BBC sport": "https://feeds.bbci.co.uk/sport/rss.xml",
    "ESPN top": "https://www.espn.com/espn/rss/news",
    "ESPN NFL": "https://www.espn.com/espn/rss/nfl/news",
    "CBS Sports": "https://www.cbssports.com/rss/headlines/",
    "NYT politics": "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml",
    "Politico": "https://rss.politico.com/politics-news.xml",
    "Guardian world": "https://www.theguardian.com/world/rss",
    "AP via Google": "https://news.google.com/rss/search?q=source:Associated+Press&hl=en-US&gl=US&ceid=US:en",
    "Reddit r/sportsbook": "https://www.reddit.com/r/sportsbook/new/.rss",
    "ESPN NBA injuries API": "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries",
    "Pinnacle guest (no key)": "https://guest.api.arcadia.pinnacle.com/0.1/sports",
    "The Odds API (no key)": "https://api.the-odds-api.com/v4/sports",
    "GDELT doc API": "https://api.gdeltproject.org/api/v2/doc/doc?query=polymarket&mode=artlist&format=json&maxrecords=10",
}
def feeds():
    say("## News/data feeds from a GitHub runner (US)")
    for name, url in FEEDS.items():
        t0 = time.time()
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=20) as r:
                body = r.read().decode("utf-8", "replace"); code = r.status
        except urllib.error.HTTPError as e:
            say(f"- {name}: HTTP {e.code}"); continue
        except Exception as e:
            say(f"- {name}: FAIL {type(e).__name__}"); continue
        ms = int(1000 * (time.time() - t0))
        dates = []
        for m in re.findall(r"<pubDate>([^<]+)</pubDate>|<updated>([^<]+)</updated>", body):
            s = m[0] or m[1]
            try:
                d = parsedate_to_datetime(s) if m[0] else datetime.fromisoformat(s.replace("Z", "+00:00"))
                dates.append((NOW - d).total_seconds() / 60)
            except Exception: pass
        fresh = f", items {len(dates)}, newest {min(dates):.0f} min old" if dates else ""
        say(f"- {name}: HTTP {code} in {ms} ms, {len(body)//1024} KB{fresh}")

if __name__ == "__main__":
    steps = sys.argv[1:] or ["feeds", "landscape", "sports", "kalshi", "calib"]
    evs = None
    for s in steps:
        t0 = time.time()
        try:
            if s == "landscape": evs = landscape(); overdue(evs)
            elif s == "calib": calib()
            elif s == "sports": sports()
            elif s == "kalshi": kalshi()
            elif s == "feeds": feeds()
        except Exception as e:
            import traceback; traceback.print_exc(); say(f"STEP {s} FAILED: {e!r}")
        say(f"({s} took {time.time()-t0:.0f}s)")
        open(f"{OUT}/summary.md", "w").write("\n".join(SUMMARY) + "\n")
