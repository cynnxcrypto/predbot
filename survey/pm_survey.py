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
    out, off, seen = [], 0, set()
    while off < cap:
        p = dict(params, limit=100, offset=off)
        b = get(GAMMA + "/events", p)
        if not b: break
        new = [e for e in b if e.get("id") not in seen]
        if not new: break
        seen.update(e.get("id") for e in new)
        out += new
        if len(b) < 100: break
        off += 100
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
    evs, seen = [], set()
    for tag in ("sports", "politics", "geopolitics", "economy", "finance", "culture", "tech", "weather", "mentions", "elections", "world", "soccer", "nba", "nfl", "nhl", "tennis", "esports", "mlb", "ufc"):
        got = page_events({"closed": "true", "end_date_min": since, "tag_slug": tag, "volume_min": min_vol, "order": "endDate", "ascending": "false"}, cap=15000)
        n0 = len(evs)
        for e in got:
            if e.get("id") in seen: continue
            seen.add(e.get("id")); evs.append(e)
        say(f"  tag {tag}: {len(got)} events, {len(evs)-n0} new")
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
        end = int(j["ref"] or NOW.timestamp())
        h = get(CLOB + "/prices-history", {"market": j["tok"], "startTs": end - 8 * 86400, "endTs": end + 3600, "fidelity": 10}, tries=2)
        hist = (h or {}).get("history") if isinstance(h, dict) else None
        if not hist:
            h = get(CLOB + "/prices-history", {"market": j["tok"], "interval": "max", "fidelity": 60}, tries=2)
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
    with ThreadPoolExecutor(24) as ex:
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

KSERIES = ["KXNFLGAME", "KXNBAGAME", "KXNHLGAME", "KXNCAAFGAME", "KXNCAAMBGAME", "KXMLBGAME", "KXEPLGAME", "KXUCLGAME", "KXLALIGAGAME",
           "KXSERIEAGAME", "KXBUNDESLIGAGAME", "KXLIGUE1GAME", "KXMLSGAME", "KXATPMATCH", "KXWTAMATCH", "KXUFCFIGHT"]
KAL = "https://api.elections.kalshi.com/trade-api/v2"

def kprice(m, side):
    v = m.get(f"yes_{side}_dollars")
    if v not in (None, ""):
        try: return float(v)
        except Exception: pass
    v = m.get(f"yes_{side}")
    return float(v) / 100 if v not in (None, "") else None

def sports():
    say("## Sports: Polymarket vs Kalshi on the same games (snapshot)")
    km = []
    for se in KSERIES:
        cur, n = None, 0
        while n < 10:
            p = {"series_ticker": se, "status": "open", "limit": 1000}
            if cur: p["cursor"] = cur
            b = get(KAL + "/markets", p, tries=2)
            if not isinstance(b, dict): break
            km += [dict(m, _series=se) for m in b.get("markets") or []]
            cur = b.get("cursor"); n += 1
            if not cur: break
    say(f"Kalshi open sports game markets: {len(km)}")
    if km:
        say("  sample keys: " + ",".join(sorted(km[0].keys()))[:600])
        say("  sample: " + json.dumps({k: km[0].get(k) for k in ("ticker", "title", "yes_sub_title", "close_time", "expected_expiration_time", "yes_bid", "yes_ask", "yes_bid_dollars", "yes_ask_dollars", "volume", "open_interest")}, default=str)[:600])
    pm = page_events({"closed": "false", "active": "true", "tag_slug": "sports", "end_date_max": (NOW + timedelta(days=5)).strftime("%Y-%m-%dT%H:%M:%SZ")}, cap=20000)
    pm_mk = []
    for ev in pm:
        for m in ev.get("markets") or []:
            if m.get("sportsMarketType") != "moneyline" or m.get("closed"): continue
            outs = jl(m.get("outcomes")) or []
            if len(outs) != 2 or m.get("bestBid") is None or m.get("bestAsk") is None: continue
            label = outs[0]
            if label.lower() == "yes":
                mm = re.match(r"will (.+?) win", m.get("question") or "", re.I)
                label = mm.group(1) if mm else None
            if not label: continue
            pm_mk.append({"ev": ev.get("title"), "q": m.get("question"), "label": label, "bid": float(m["bestBid"]), "ask": float(m["bestAsk"]),
                          "start": m.get("gameStartTime") or m.get("eventStartTime"), "liq": float(m.get("liquidityNum") or 0),
                          "vol24": float(m.get("volume24hr") or 0), "slug": m.get("slug")})
    say(f"Polymarket open sports events ≤5d: {len(pm)}, binary moneyline markets: {len(pm_mk)}")
    def norm(s): return re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())
    STOP = {"will", "win", "the", "team", "club", "city", "united", "real", "state", "saint", "san", "los", "new", "york", "game", "match"}
    def words(s): return [w for w in norm(s).split() if len(w) >= 4 and w not in STOP]
    matches = []
    for m in pm_mk:
        st_ = ts(m["start"])
        lw = words(m["label"])
        if not st_ or not lw: continue
        evw = set(words(m["ev"])) - set(lw)
        best = None
        for k in km:
            ct = ts(k.get("expected_expiration_time") or k.get("close_time"))
            if not ct or not (-6 * 3600 <= (ct - st_).total_seconds() <= 3 * 86400): continue
            ytxt = norm((k.get("yes_sub_title") or "") + " " + (k.get("rules_primary") or "")[:160])
            ttxt = norm((k.get("title") or "") + " " + (k.get("rules_primary") or ""))
            if not all(w in ytxt for w in lw[-1:]): continue
            if evw and not any(w in ttxt for w in evw): continue
            if "tie" in norm(k.get("yes_sub_title")) or "draw" in norm(k.get("yes_sub_title")): continue
            best = k; break
        if not best: continue
        kb, ka = kprice(best, "bid"), kprice(best, "ask")
        if kb is None or ka is None or ka <= 0: continue
        pmid, kmid = (m["bid"] + m["ask"]) / 2, (kb + ka) / 2
        matches.append({"series": best["_series"], "pm_ev": m["ev"], "label": m["label"], "k_ticker": best.get("ticker"), "k_yes": best.get("yes_sub_title"),
                        "pm_bid": m["bid"], "pm_ask": m["ask"], "k_bid": kb, "k_ask": ka, "diff_mid": round(pmid - kmid, 4),
                        "cross": round(max(kb - m["ask"], m["bid"] - ka), 4), "pm_liq": round(m["liq"]), "k_vol": best.get("volume"), "start": m["start"]})
    say(f"matched PM↔Kalshi game sides: {len(matches)}")
    if matches:
        ds = [x["diff_mid"] for x in matches]
        say(f"PM mid − Kalshi mid: mean {100*st.mean(ds):+.2f}pts, median |d| {100*st.median([abs(d) for d in ds]):.2f}pts, p90 |d| {100*q([abs(d) for d in ds], .9):.2f}pts")
        cr = [x for x in matches if x["cross"] > 0]
        say(f"sides where one venue's bid > other's ask (raw cross, before fees): {len(cr)}; ≥3c: {sum(1 for x in cr if x['cross'] >= 0.03)}")
        by = {}
        for x in matches: by.setdefault(x["series"], []).append(x["diff_mid"])
        for lg, v in sorted(by.items()):
            say(f"  {lg}: n={len(v)} mean {100*st.mean(v):+.2f} median|d| {100*st.median([abs(a) for a in v]):.2f}")
        for x in sorted(matches, key=lambda x: -abs(x["diff_mid"]))[:15]:
            say(f"  {x['series']} {x['pm_ev'][:40]} | {x['label']} ~ {x['k_yes']} | PM {x['pm_bid']}/{x['pm_ask']} K {x['k_bid']}/{x['k_ask']} | PM liq ${x['pm_liq']:,}")
    json.dump({"matches": matches, "kalshi_n": len(km), "pm_n": len(pm_mk)}, open(f"{OUT}/sports.json", "w"), indent=1, default=str)

# ---------------------------------------------------------------- kalshi
def kalshi():
    say("## Kalshi open markets")
    cur, rows, n = None, [], 0
    evs = []
    while n < 60:
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
            d[1] += 1; d[2] += float(m.get("volume_24h") or m.get("volume_24h_fp") or m.get("volume") or 0)
    say(f"Kalshi open events fetched: {len(evs)}")
    for c, d in sorted(by.items(), key=lambda x: -x[1][2]):
        say(f"  {c}: {d[0]} ev / {d[1]} mkts, 24h contracts {d[2]:,.0f}")
    json.dump([{k: e.get(k) for k in ("event_ticker", "title", "category", "sub_title")} for e in evs], open(f"{OUT}/kalshi.json", "w"))

# ---------------------------------------------------------------- feeds
FEEDS = {
    # general news / wires
    "Google News top": "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en",
    "Google News search (any keyword)": "https://news.google.com/rss/search?q=election+results&hl=en-US&gl=US&ceid=US:en",
    "AP via Google News": "https://news.google.com/rss/search?q=source:Associated+Press&hl=en-US&gl=US&ceid=US:en",
    "Reuters via Google News": "https://news.google.com/rss/search?q=site:reuters.com&hl=en-US&gl=US&ceid=US:en",
    "Bing News search": "https://www.bing.com/news/search?q=breaking&format=rss",
    "BBC world": "https://feeds.bbci.co.uk/news/world/rss.xml",
    "Guardian world": "https://www.theguardian.com/world/rss",
    "Al Jazeera": "https://www.aljazeera.com/xml/rss/all.xml",
    "NPR news": "https://feeds.npr.org/1001/rss.xml",
    "CNBC top": "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114",
    "Yahoo News": "https://news.yahoo.com/rss/",
    "GDELT doc API": "https://api.gdeltproject.org/api/v2/doc/doc?query=election&mode=artlist&format=json&maxrecords=10&sort=datedesc",
    # politics
    "NYT politics": "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml",
    "Politico": "https://rss.politico.com/politics-news.xml",
    "The Hill": "https://thehill.com/feed/",
    "Axios": "https://api.axios.com/feed/",
    "White House news": "https://www.whitehouse.gov/news/feed/",
    "Federal Register API": "https://www.federalregister.gov/api/v1/documents.json?per_page=5&order=newest",
    "Congress.gov bills (needs key)": "https://api.congress.gov/v3/bill?format=json",
    "FiveThirtyEight-style polls (RCP)": "https://www.realclearpolling.com/",
    "Wikipedia recent changes API": "https://en.wikipedia.org/w/api.php?action=query&list=recentchanges&rclimit=5&format=json",
    # economy / official
    "Fed press releases": "https://www.federalreserve.gov/feeds/press_all.xml",
    "BLS releases": "https://www.bls.gov/feed/bls_latest.rss",
    "SEC EDGAR latest filings": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&output=atom",
    "NOAA weather alerts": "https://api.weather.gov/alerts/active?status=actual&limit=5",
    "USGS earthquakes": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson",
    # sports
    "BBC sport": "https://feeds.bbci.co.uk/sport/rss.xml",
    "BBC football": "https://feeds.bbci.co.uk/sport/football/rss.xml",
    "CBS Sports": "https://www.cbssports.com/rss/headlines/",
    "Yahoo Sports": "https://sports.yahoo.com/rss/",
    "ESPN RSS": "https://www.espn.com/espn/rss/news",
    "ESPN scoreboard API": "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
    "RotoWire NBA news": "https://www.rotowire.com/rss/news.php?sport=NBA",
    "RotoWire NFL news": "https://www.rotowire.com/rss/news.php?sport=NFL",
    "NHL official API": "https://api-web.nhle.com/v1/schedule/now",
    "MLB StatsAPI": "https://statsapi.mlb.com/api/v1/schedule?sportId=1",
    "NBA official scoreboard": "https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json",
    "NBA injury report page": "https://official.nba.com/nba-injury-report-2025-26-season/",
    "Sleeper NFL players API": "https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=5",
    "football-data.org (needs key)": "https://api.football-data.org/v4/matches",
    "OpenLigaDB Bundesliga": "https://api.openligadb.de/getmatchdata/bl1",
    "Sofascore live": "https://api.sofascore.com/api/v1/sport/football/events/live",
    "Reddit r/nba new": "https://www.reddit.com/r/nba/new/.rss",
    "Reddit r/sportsbook": "https://www.reddit.com/r/sportsbook/new/.rss",
    # social
    "Bluesky public search": "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=breaking&limit=5",
    "Bluesky firehose (Jetstream)": "https://jetstream2.us-east.bsky.network/",
    "Mastodon public timeline": "https://mastodon.social/api/v1/timelines/public?limit=5",
    "Telegram public channel preview": "https://t.me/s/disclosetv",
    "Truth Social (Trump) RSS mirror": "https://trumpstruth.org/feed",
    "Nitter (X mirror)": "https://nitter.net/AP/rss",
    # odds / markets
    "Kalshi API": "https://api.elections.kalshi.com/trade-api/v2/markets?limit=1",
    "Manifold API": "https://api.manifold.markets/v0/markets?limit=5",
    "PredictIt API": "https://www.predictit.org/api/marketdata/all/",
    "Betfair (needs account)": "https://api.betfair.com/exchange/betting/rest/v1.0/listEventTypes/",
    "The Odds API (needs key)": "https://api.the-odds-api.com/v4/sports",
    "Polymarket Gamma": "https://gamma-api.polymarket.com/events?limit=1",
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


# ---------------------------------------------------------------- football: Polymarket vs Pinnacle closing (football-data.co.uk)
import csv, io, difflib
FD_LEAGUES = {"SP1": ["la-liga", "spain"], "SP2": ["la-liga-2", "segunda-division"]}   # Spain first (enrique, 7 Nov); expand later
def fd_rows():
    rows = []
    for season in ("2425", "2526", "2627"):
        for code in FD_LEAGUES:
            b = get(f"https://www.football-data.co.uk/mmz4281/{season}/{code}.csv", tries=2)
            if not isinstance(b, str) or "HomeTeam" not in b[:400]:
                say(f"  football-data {season}/{code}: {'missing' if b is None else str(b)[:60]!r}"); continue
            n = 0
            for r in csv.DictReader(io.StringIO(b.lstrip("\ufeff"))):
                try: d = datetime.strptime(r["Date"], "%d/%m/%Y" if len(r["Date"]) == 10 else "%d/%m/%y").date()
                except Exception: continue
                r["_date"], r["_lg"] = d, code; rows.append(r); n += 1
            say(f"  football-data {season}/{code}: {n} matches; Pinnacle close cols: {'PSCH' in b[:2000]}")
    return rows

def odds3(r, pre):
    try:
        h, d, a = float(r[pre + "H"]), float(r[pre + "D"]), float(r[pre + "A"])
        t = 1 / h + 1 / d + 1 / a
        return (1 / h / t, 1 / d / t, 1 / a / t, t - 1)
    except Exception:
        return None

def tnorm(s):
    s = (s or "").lower()
    for a, b in (("manchester", "man"), ("united", "utd"), ("athletic club", "ath bilbao"), ("atlético", "ath"), ("atletico", "ath"), ("internazionale", "inter"),
                 ("borussia ", ""), ("fc ", ""), (" fc", ""), ("cf ", ""), (" cf", ""), ("rcd ", ""), ("real sociedad", "sociedad"), ("rayo vallecano", "vallecano"),
                 ("de madrid", ""), ("de barcelona", ""), ("de vigo", ""), ("ac ", ""), ("as ", ""), ("ssc ", ""), ("1. ", ""), ("tsg ", ""), ("vfb ", ""), ("vfl ", ""),
                 ("olympique ", ""), ("stade ", ""), ("paris saint-germain", "paris sg"), ("wolverhampton wanderers", "wolves"), ("nottingham forest", "nott'm forest"),
                 ("tottenham hotspur", "tottenham"), ("brighton & hove albion", "brighton"), ("west ham united", "west ham"), ("newcastle united", "newcastle"),
                 ("bayer leverkusen", "leverkusen"), ("eintracht frankfurt", "ein frankfurt"), ("mönchengladbach", "m'gladbach"), ("monchengladbach", "m'gladbach")):
        s = s.replace(a, b)
    return re.sub(r"[^a-z' ]", "", s).strip()

def sim(a, b):
    a, b = tnorm(a), tnorm(b)
    if not a or not b: return 0
    if a in b or b in a: return 0.95
    return difflib.SequenceMatcher(None, a, b).ratio()

def football():
    say("## Football: Polymarket kickoff price vs Pinnacle closing line vs result")
    fd = fd_rows()
    by_date = {}
    for r in fd: by_date.setdefault(r["_date"], []).append(r)
    pm_ev, seen = [], set()
    for code, slugs in FD_LEAGUES.items():
        for sl in slugs:
            got = page_events({"closed": "true", "tag_slug": sl, "end_date_min": "2024-08-01T00:00:00Z"}, cap=10000)
            n = 0
            for e in got:
                if e.get("id") in seen or " vs" not in (e.get("title") or ""): continue
                seen.add(e.get("id")); pm_ev.append((code, e)); n += 1
            say(f"  PM tag {sl}: {len(got)} closed events, {n} new match events")
    jobs = []
    for code, e in pm_ev:
        title = re.sub(r"\s*-\s*.*$", "", e.get("title") or "")
        parts = re.split(r"\s+vs\.?\s+", title)
        if len(parts) != 2: continue
        A, B = parts
        mk = {}
        start = None
        for m in e.get("markets") or []:
            qn = (m.get("question") or "").lower()
            toks = jl(m.get("clobTokenIds")); prices = jl(m.get("outcomePrices"))
            if not toks or not prices: continue
            if any(x in qn for x in ("halftime", "half", "score", "o/u", "over", "spread", "both teams", "corners", "exact")): continue
            start = start or ts(m.get("gameStartTime")) or ts(m.get("eventStartTime"))
            try: won = float(prices[0]) > 0.5
            except Exception: continue
            if "draw" in qn: mk["D"] = (toks[0], won, m)
            else:
                g = m.get("groupItemTitle") or qn
                sa, sb = sim(g, A), sim(g, B)
                if max(sa, sb) < 0.5: continue
                mk["H" if sa >= sb else "A"] = (toks[0], won, m)
        if len(mk) != 3 or not start: continue
        cands = by_date.get(start.date(), []) + by_date.get((start - timedelta(hours=12)).date(), [])
        best, bs = None, 0
        for r in cands:
            sc = sim(r["HomeTeam"], A) + sim(r["AwayTeam"], B)
            if sc > bs: best, bs = r, sc
        if not best or bs < 1.2: continue
        jobs.append({"lg": best["_lg"], "A": A, "B": B, "fdH": best["HomeTeam"], "fdA": best["AwayTeam"], "ftr": best.get("FTR"), "start": start.timestamp(),
                     "mk": {k: (v[0], v[1]) for k, v in mk.items()}, "vol": float(e.get("volume") or 0),
                     "pin": odds3(best, "PSC") or odds3(best, "PS"), "avg": odds3(best, "AvgC") or odds3(best, "Avg"), "b365": odds3(best, "B365C")})
    say(f"PM match events: {len(pm_ev)}, matched to football-data with 3 markets: {len(jobs)}")
    def fetch(j):
        out = dict(j)
        for k, (tok, won) in j["mk"].items():
            h = get(CLOB + "/prices-history", {"market": tok, "startTs": int(j["start"] - 2 * 86400), "endTs": int(j["start"] + 60), "fidelity": 5}, tries=2)
            hist = sorted((h or {}).get("history") or [], key=lambda x: x["t"]) if isinstance(h, dict) else []
            out[k] = {"won": won, "k10": price_at(hist, j["start"] - 600), "k75": price_at(hist, j["start"] - 75 * 60),
                      "k6h": price_at(hist, j["start"] - 6 * 3600), "k24h": price_at(hist, j["start"] - 86400), "n": len(hist)}
        return out
    with ThreadPoolExecutor(24) as ex:
        res = list(ex.map(fetch, jobs))
    json.dump(res, open(f"{OUT}/football.json", "w"), default=str)
    ok = [r for r in res if all(r.get(k, {}).get("k10") is not None for k in "HDA")]
    say(f"with kickoff prices for H/D/A: {len(ok)}")
    if not ok: return
    # 1) PM calibration at kickoff
    def cal(rows, key, lab):
        pts = [(r[k][key], 1 if r[k]["won"] else 0) for r in rows for k in "HDA" if r[k].get(key) is not None and 0.01 < r[k][key] < 0.99]
        if not pts: return
        say(f"### PM {lab} ({key}) n={len(pts)}")
        for lo, hi in ((0, .15), (.15, .25), (.25, .35), (.35, .45), (.45, .55), (.55, .65), (.65, .8), (.8, 1)):
            b = [(p, w) for p, w in pts if lo <= p < hi]
            if len(b) < 20: continue
            ap = sum(p for p, _ in b) / len(b); wr = sum(w for _, w in b) / len(b)
            say(f"  {int(lo*100):>2}-{int(hi*100):<3}c n={len(b):>4} avg {100*ap:5.1f}c won {100*wr:5.1f}% edge {100*(wr-ap):+5.1f}pts ±{200*math.sqrt(max(wr*(1-wr),1e-4)/len(b)):.1f}")
        dr = [(r["D"][key], 1 if r["D"]["won"] else 0) for r in rows if r["D"].get(key)]
        if dr: say(f"  draws only: n={len(dr)} avg {100*sum(p for p,_ in dr)/len(dr):.1f}c won {100*sum(w for _,w in dr)/len(dr):.1f}%")
    cal(ok, "k10", "10 min pre-kickoff")
    for lg in sorted(set(r["lg"] for r in ok)):
        cal([r for r in ok if r["lg"] == lg], "k10", f"{lg} 10 min pre-kickoff")
    # simple rules at the 10-min price, taker cost = price + 1c slip + fee
    def rule(name, pick):
        v = []
        for r in ok:
            for k in "HDA":
                p = r[k]["k10"]
                if p is None or not pick(k, p, r): continue
                v.append((1 if r[k]["won"] else 0) - (p + 0.01 + 0.05 * p * (1 - p)))
        if v: say(f"  RULE {name}: n={len(v)} won {100*sum(1 for x in v if x>0)/len(v):.0f}% {100*st.mean(v):+.2f}c/share, total {sum(v):+.2f} per 1-share bets")
    say("### favourite rule split (buy side priced 55c+ at 10 min, +1c slip + fee)")
    def season(r):
        d = datetime.fromtimestamp(r["start"], timezone.utc)
        return "2024-25" if d < datetime(2025, 7, 1, tzinfo=timezone.utc) else "2025-26" if d < datetime(2026, 7, 1, tzinfo=timezone.utc) else "2026-27"
    for name, f in [("season " + s_, lambda r, s_=s_: season(r) == s_) for s_ in ("2024-25", "2025-26", "2026-27")] + \
                   [("league " + l_, lambda r, l_=l_: r["lg"] == l_) for l_ in ("SP1", "SP2")] + \
                   [("side H", None), ("side A", None)]:
        v = []
        for r in ok:
            if f and not f(r): continue
            for k in "HDA":
                if name == "side H" and k != "H": continue
                if name == "side A" and k != "A": continue
                p = r[k]["k10"]
                if p is None or p < 0.55: continue
                v.append((1 if r[k]["won"] else 0) - (p + 0.01 + 0.05 * p * (1 - p)))
        if v: say(f"  {name}: n={len(v)} won {100*sum(1 for x in v if x>0)/len(v):.0f}% {100*st.mean(v):+.2f}c/share")
    for ref in ("pin", "avg"):
        v = []
        for r in ok:
            if not r.get(ref): continue
            for i, k in enumerate("HDA"):
                fp = r[ref][i]
                if fp >= 0.55: v.append((1 if r[k]["won"] else 0) - fp)
        if v: say(f"  same idea at {ref} fair (no vig): n={len(v)} won {100*sum(1 for x in v if x>0)/len(v):.0f}% {100*st.mean(v):+.2f}c/share")
    # monthly
    mon = {}
    for r in ok:
        for k in "HDA":
            p = r[k]["k10"]
            if p is None or p < 0.55: continue
            m_ = datetime.fromtimestamp(r["start"], timezone.utc).strftime("%Y-%m")
            mon.setdefault(m_, []).append((1 if r[k]["won"] else 0) - (p + 0.01 + 0.05 * p * (1 - p)))
    say("  by month: " + ", ".join(f"{m_} {len(v)}/{100*st.mean(v):+.0f}c" for m_, v in sorted(mon.items())))
    say("### simple rules (taker at 10-min price +1c slip + 5% sports fee)")
    for lo in (0.5, 0.55, 0.6, 0.65, 0.7):
        rule(f"buy side priced {int(lo*100)}c+", lambda k, p, r, lo=lo: p >= lo)
    rule("buy every draw", lambda k, p, r: k == "D")
    rule("buy draw 28c+", lambda k, p, r: k == "D" and p >= 0.28)
    rule("buy home 40-55c", lambda k, p, r: k == "H" and 0.40 <= p < 0.55)
    rule("buy away 40-55c", lambda k, p, r: k == "A" and 0.40 <= p < 0.55)
    rule("buy home any", lambda k, p, r: k == "H")
    rule("buy away any", lambda k, p, r: k == "A")
    rule("buy NO-side proxy: skip; longshot <20c", lambda k, p, r: p < 0.20)
    cal(ok, "k24h", "24 h pre-kickoff")
    # 2) PM vs Pinnacle closing
    for ref in ("pin", "avg"):
        rr = [r for r in ok if r.get(ref)]
        if not rr: continue
        diffs, bets = [], {}
        for r in rr:
            fair = dict(zip("HDA", r[ref][:3]))
            for k in "HDA":
                p = r[k]["k10"]; d = p - fair[k]; diffs.append(d)
                for th in (0.02, 0.03, 0.05, 0.08):
                    if fair[k] - p >= th:   # PM cheaper than the sharp line -> buy on PM at ~mid + 1c
                        cost = p + 0.01 + 0.05 * p * (1 - p)
                        bets.setdefault(th, []).append((1 if r[k]["won"] else 0) - cost)
        say(f"### PM 10-min-pre-kickoff vs {ref} closing (de-vigged), {len(rr)} matches")
        say(f"  mean diff {100*st.mean(diffs):+.2f}pts, median |diff| {100*st.median([abs(x) for x in diffs]):.2f}pts, p90 |diff| {100*q([abs(x) for x in diffs], .9):.2f}pts")
        for th, v in sorted(bets.items()):
            say(f"  buy PM when {int(th*100)}+pts below {ref}: n={len(v)} won {100*sum(1 for x in v if x > 0)/len(v):.0f}% net {sum(v):+.2f} per $1-share ({100*st.mean(v):+.2f}c/share after 1c slip + fee)")
        # does the sharp line beat PM at predicting results? (log loss)
        llp = llr = 0
        for r in rr:
            fair = dict(zip("HDA", r[ref][:3]))
            tot = sum(r[k]["k10"] for k in "HDA")
            for k in "HDA":
                if r[k]["won"]:
                    llp -= math.log(max(1e-4, r[k]["k10"] / tot)); llr -= math.log(max(1e-4, fair[k]))
        say(f"  log loss per match: PM {llp/len(rr):.4f} vs {ref} {llr/len(rr):.4f} (lower = sharper)")
    # 3) last-75-min move (lineups) toward/away from the close
    mv = []
    for r in ok:
        if not r.get("pin") and not r.get("avg"): continue
        fair = dict(zip("HDA", (r.get("pin") or r.get("avg"))[:3]))
        for k in "HDA":
            a, b = r[k].get("k75"), r[k]["k10"]
            if a is None: continue
            mv.append((abs(a - fair[k]), abs(b - fair[k]), b - a, r[k]["won"]))
    if mv:
        say(f"### lineup window (75→10 min pre-kickoff): |PM−close| {100*st.mean(x[0] for x in mv):.2f} → {100*st.mean(x[1] for x in mv):.2f}pts; moves ≥3c: {sum(1 for x in mv if abs(x[2]) >= .03)} of {len(mv)}")
        big = [x for x in mv if x[2] >= .03]
        if big: say(f"  sides that rose ≥3c in that window: won {100*sum(1 for x in big if x[3])/len(big):.0f}% (n={len(big)})")

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
            elif s == "football": football()
        except Exception as e:
            import traceback; traceback.print_exc(); say(f"STEP {s} FAILED: {e!r}")
        say(f"({s} took {time.time()-t0:.0f}s)")
        open(f"{OUT}/summary-{'-'.join(steps)}.md", "w").write("\n".join(SUMMARY) + "\n")
