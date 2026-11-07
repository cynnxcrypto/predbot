#!/usr/bin/env python3
"""Indices & commodities research collector (research only; never touches the bot).
Runs on a GitHub runner (container can't reach APIs). Stdlib only.
Steps (args): discover, hist, books, underlying.  Output: research/indices/out/
"""
import json, os, sys, time, re, urllib.request, urllib.parse, gzip
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
GAMMA, CLOB = "https://gamma-api.polymarket.com", "https://clob.polymarket.com"
UA = {"User-Agent": "Mozilla/5.0 predbot-research"}
NOW = int(time.time())
LOG = []

def log(*a):
    s = " ".join(str(x) for x in a); print(s); LOG.append(s)

def get(url, params=None, tries=4, raw=False):
    if params: url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                b = r.read()
                if raw: return b.decode("utf-8", "replace")
                return json.loads(b) if b[:1] in (b"{", b"[") else b.decode("utf-8", "replace")
        except Exception as e:
            if i == tries - 1:
                print("GET fail", url[:160], e, file=sys.stderr); return None
            time.sleep(1.5 * (i + 1))

def jl(x):
    if isinstance(x, str):
        try: return json.loads(x)
        except Exception: return None
    return x

def dump(name, obj):
    p = os.path.join(OUT, name)
    if name.endswith(".gz"):
        with gzip.open(p, "wt") as f: json.dump(obj, f)
    else:
        with open(p, "w") as f: json.dump(obj, f, indent=1)

def load(name):
    p = os.path.join(OUT, name)
    if not os.path.exists(p): return None
    if name.endswith(".gz"):
        with gzip.open(p, "rt") as f: return json.load(f)
    return json.load(open(p))

PAT = re.compile(r"(s&p|spx|\bspy\b|nasdaq|\bndx\b|\bqqq\b|dow jones|\bdow\b|russell|\brut\b|\biwm\b|gold|silver|crude|\boil\b|\bwti\b|brent|natural gas|copper|\bvix\b|\bxau\b|\bgc\b|\bcl\b|nikkei|dax|ftse|kospi|hang seng|treasury|10-year|yield)", re.I)
EXCL = re.compile(r"(bitcoin|btc|ethereum|\beth\b|solana|xrp|crypto|golden (state|globe|knights)|gold medal|gold cup|super bowl|oilers|olympic)", re.I)

def events_page(params, cap):
    out, off = [], 0
    while off < cap:
        b = get(GAMMA + "/events", dict(params, limit=100, offset=off))
        if not b: break
        out += b
        if len(b) < 100: break
        off += 100
    return out

def discover():
    seen, evs = set(), []
    def add(lst):
        for e in lst or []:
            if e.get("id") in seen: continue
            t = (e.get("title") or "") + " " + (e.get("slug") or "")
            if PAT.search(t) and not EXCL.search(t):
                seen.add(e.get("id")); evs.append(e)
    tags = ["stocks", "indices", "commodities", "gold", "oil", "finance", "economy", "equities", "sp-500", "s-p-500",
            "daily-close", "up-or-down", "spx", "nasdaq", "markets", "business", "fed", "silver", "crude-oil", "nasdaq-100", "dow-jones", "commodity"]
    for tg in tags:
        for closed in ("false", "true"):
            lst = events_page({"tag_slug": tg, "closed": closed, "order": "endDate", "ascending": "false"}, 3000 if closed == "true" else 1500)
            log(f"tag {tg} closed={closed}: {len(lst)} events"); add(lst)
    for qy in ["S&P 500", "SPX", "SPY", "Nasdaq", "NDX", "QQQ", "Dow Jones", "Russell 2000", "Gold", "Silver", "Crude Oil", "WTI", "Brent", "Natural Gas", "VIX", "Nikkei", "up or down"]:
        for st in ("active", "closed"):
            for page in range(1, 6):
                b = get(GAMMA + "/public-search", {"q": qy, "events_status": st, "limit_per_type": 50, "page": page})
                lst = (b or {}).get("events") if isinstance(b, dict) else None
                if not lst: break
                add(lst)
    # expand via series
    series = {}
    for e in evs:
        for s in e.get("series") or []:
            series[s.get("id")] = {"slug": s.get("slug"), "title": s.get("title"), "recurrence": s.get("recurrence")}
    log("series found:", len(series))
    for sid, s in series.items():
        for closed in ("false", "true"):
            lst = events_page({"series_id": sid, "closed": closed, "order": "endDate", "ascending": "false"}, 2000)
            n0 = len(evs); add(lst)
            log(f"series {s['slug']} closed={closed}: {len(lst)} (+{len(evs)-n0})")
    # full markets for each event (events list sometimes trims markets)
    slim = []
    for e in evs:
        ms = []
        for m in e.get("markets") or []:
            ms.append({k: m.get(k) for k in ["id", "question", "slug", "conditionId", "clobTokenIds", "outcomes", "outcomePrices", "volumeNum", "volume", "liquidityNum",
                                             "endDate", "startDate", "closedTime", "closed", "active", "spread", "bestBid", "bestAsk", "lastTradePrice", "umaResolutionStatus",
                                             "feesEnabled", "feeSchedule", "feeType", "groupItemTitle", "groupItemThreshold", "description", "resolutionSource", "volume24hr"]})
        slim.append({"id": e.get("id"), "title": e.get("title"), "slug": e.get("slug"), "series": [s.get("slug") for s in e.get("series") or []],
                     "tags": [t.get("slug") for t in e.get("tags") or []], "startDate": e.get("startDate"), "endDate": e.get("endDate"), "closed": e.get("closed"),
                     "volume": e.get("volume"), "volume24hr": e.get("volume24hr"), "liquidity": e.get("liquidity"), "negRisk": e.get("negRisk"),
                     "description": e.get("description"), "resolutionSource": e.get("resolutionSource"), "markets": ms})
    dump("events.json.gz", slim)
    dump("series.json", series)
    log("events kept:", len(slim), "markets:", sum(len(e["markets"]) for e in slim))
    # title families
    fam = {}
    for e in slim:
        k = re.sub(r"\d+|(january|february|march|april|may|june|july|august|september|october|november|december)|\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b", "#", (e["title"] or "").lower())
        k = re.sub(r"#[#\s,]*", "# ", k).strip()
        d = fam.setdefault(k, {"n": 0, "closed": 0, "vol": 0.0, "ex": e["title"], "series": e["series"]})
        d["n"] += 1; d["closed"] += 1 if e["closed"] else 0; d["vol"] += float(e["volume"] or 0)
    rows = sorted(fam.items(), key=lambda x: -x[1]["vol"])
    with open(os.path.join(OUT, "families.txt"), "w") as f:
        for k, d in rows: f.write(f"{d['n']:5d} ev {d['closed']:5d} closed vol ${d['vol']:>14,.0f} | {d['ex']} | {d['series']}\n")

def hist():
    evs = load("events.json.gz") or []
    jobs = []
    for e in evs:
        for m in e["markets"]:
            toks = jl(m.get("clobTokenIds")) or []
            if not toks: continue
            jobs.append({"mid": m["id"], "tok": toks[0], "end": m.get("endDate") or e.get("endDate"), "start": m.get("startDate") or e.get("startDate")})
    old = load("hist.json.gz") or {}
    def one(j):
        if j["mid"] in old and old[j["mid"]]: return j["mid"], old[j["mid"]]
        def p(s):
            try: return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
            except Exception: return None
        end = p(j["end"] or "") or NOW; start = p(j["start"] or "") or end - 10 * 86400
        start = max(start, end - 14 * 86400)
        h = get(CLOB + "/prices-history", {"market": j["tok"], "startTs": start, "endTs": min(end + 7200, NOW), "fidelity": 5}, tries=2)
        pts = (h or {}).get("history") if isinstance(h, dict) else None
        if not pts:
            h = get(CLOB + "/prices-history", {"market": j["tok"], "interval": "max", "fidelity": 10}, tries=2)
            pts = (h or {}).get("history") if isinstance(h, dict) else None
        return j["mid"], [[x["t"], x["p"]] for x in (pts or [])]
    res = {}
    with ThreadPoolExecutor(12) as ex:
        for mid, pts in ex.map(one, jobs): res[mid] = pts
    dump("hist.json.gz", res)
    log("hist markets:", len(res), "with points:", sum(1 for v in res.values() if v))

def books():
    evs = load("events.json.gz") or []
    snap = []
    def one(m):
        toks = jl(m.get("clobTokenIds")) or []
        if not toks: return None
        b = get(CLOB + "/book", {"token_id": toks[0]}, tries=2)
        if not isinstance(b, dict): return None
        bids = sorted([(float(x["price"]), float(x["size"])) for x in b.get("bids", [])], reverse=True)
        asks = sorted([(float(x["price"]), float(x["size"])) for x in b.get("asks", [])])
        return {"mid": m["id"], "q": m["question"], "bids": bids[:10], "asks": asks[:10], "t": NOW}
    open_m = [m for e in evs if not e["closed"] for m in e["markets"] if not m.get("closed")]
    with ThreadPoolExecutor(12) as ex:
        snap = [x for x in ex.map(one, open_m) if x]
    old = load("books.json.gz") or []
    dump("books.json.gz", old + snap)
    log("book snapshots:", len(snap))

DAILY = ("spx-daily-up-or-down", "spy-daily-up-or-down", "ndx-daily-up-or-down", "dow-jones-daily-up-or-down", "russell-2000-daily-up-or-down",
         "gold-daily-up-or-down", "silver-daily-up-or-down", "oil-daily-up-or-down", "natural-gas-daily-up-or-down", "spx-open-daily-up-or-down",
         "spy-daily-close-uo", "wti-daily-close-uo", "qqq-daily-up-or-down", "spy-open-daily-up-or-down")

def probe():
    evs = load("events.json.gz") or []
    m = next(m for e in evs if e["closed"] and (e["series"] or ["-"])[0] == "spx-daily-up-or-down" for m in e["markets"])
    tok = (jl(m["clobTokenIds"]) or [""])[0]
    tests = [("https://data-api.polymarket.com/trades", {"market": m["conditionId"], "limit": 5}),
             ("https://data-api.polymarket.com/trades", {"market": m["conditionId"], "limit": 5, "takerOnly": "false"}),
             ("https://data-api.polymarket.com/trades", {"limit": 3})]
    for u, pr in tests:
        url = u + "?" + urllib.parse.urlencode(pr)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                log("PROBE", url[:120], r.status, r.read()[:300])
        except Exception as e:
            body = getattr(e, "read", lambda: b"")()[:200]
            log("PROBE FAIL", url[:120], repr(e)[:150], body)
    gq = {"query": '{orderFilledEvents(first: 5, orderBy: timestamp, orderDirection: desc, where: {makerAssetId: "%s"}) {timestamp makerAmountFilled takerAmountFilled makerAssetId takerAssetId}}' % tok}
    for url in ["https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn"]:
        try:
            req = urllib.request.Request(url, data=json.dumps(gq).encode(), headers={**UA, "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r: log("PROBE goldsky", r.status, r.read()[:400])
        except Exception as e:
            log("PROBE goldsky FAIL", repr(e)[:200], getattr(e, "read", lambda: b"")()[:200])

def trades():
    evs = load("events.json.gz") or []
    old = load("trades.json.gz") or {}
    ms = [m for e in evs if e["closed"] and (e["series"] or ["-"])[0] in DAILY for m in e["markets"] if m.get("conditionId")]
    def one(m):
        if m["id"] in old: return m["id"], old[m["id"]]
        out, off = [], 0
        while off <= 20000:
            b = get("https://data-api.polymarket.com/trades", {"market": m["conditionId"], "limit": 500, "offset": off, "takerOnly": "true"}, tries=3)
            if not isinstance(b, list) or not b: break
            out += [[x.get("timestamp"), x.get("outcomeIndex"), x.get("side"), x.get("price"), x.get("size")] for x in b]
            if len(b) < 500: break
            off += 500
        return m["id"], out
    with ThreadPoolExecutor(10) as ex:
        for mid, t in ex.map(one, ms): old[mid] = t
    dump("trades.json.gz", old)
    log("trades markets:", len(old), "trades:", sum(len(v) for v in old.values()))

YSYM = ["^GSPC", "^NDX", "^IXIC", "^DJI", "^RUT", "SPY", "QQQ", "IWM", "GC=F", "SI=F", "CL=F", "BZ=F", "NG=F", "HG=F", "ES=F", "NQ=F", "YM=F", "RTY=F",
        "^VIX", "^VIX9D", "^VIX1D", "^VXN", "^OVX", "^GVZ", "^N225", "^KS11", "^TNX", "GLD", "USO", "DX-Y.NYB"]

def underlying():
    res = {}
    def one(sym):
        out = {}
        for rng, iv in (("max", "1d"), ("730d", "1h"), ("60d", "5m"), ("7d", "1m")):
            b = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}", {"range": rng, "interval": iv, "includePrePost": "true"}, tries=3)
            try:
                r = b["chart"]["result"][0]; q = r["indicators"]["quote"][0]
                rows = [[t, q["open"][i], q["high"][i], q["low"][i], q["close"][i], q["volume"][i]] for i, t in enumerate(r.get("timestamp") or [])]
                if iv == "1d": rows = [x for x in rows if x[0] > NOW - 15 * 365 * 86400]
                out[iv] = {"tz": r["meta"].get("exchangeTimezoneName"), "rows": rows}
            except Exception as e:
                out[iv] = None; print("yahoo fail", sym, iv, e, file=sys.stderr)
        return sym, out
    with ThreadPoolExecutor(6) as ex:
        for s, o in ex.map(one, YSYM): res[s] = o
    for s, o in res.items():
        log(s, {k: (len(v["rows"]) if v else 0) for k, v in o.items()})
    # stooq fallback daily
    for s in ["^spx", "^ndx", "^dji", "xauusd", "cl.f", "gc.f", "si.f"]:
        t = get("https://stooq.com/q/d/l/", {"s": s, "i": "d"}, raw=True)
        if t and t.startswith("Date"):
            with open(os.path.join(OUT, f"stooq_{s.replace('^','').replace('.','_')}.csv"), "w") as f: f.write(t)
            log("stooq", s, t.count("\n"))
        else: log("stooq fail", s)
    # existing intraday kept: merge 1m/5m so repeated runs accumulate
    old = load("underlying.json.gz") or {}
    for s, o in res.items():
        for iv in ("1m", "5m", "1h"):
            if o.get(iv) and old.get(s, {}).get(iv):
                d = {r[0]: r for r in old[s][iv]["rows"]}; d.update({r[0]: r for r in o[iv]["rows"]})
                o[iv]["rows"] = [d[k] for k in sorted(d)]
    dump("underlying.json.gz", res)
    # VIX history from CBOE, macro calendars
    for name, url in [("cboe_vix.csv", "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv"),
                      ("cboe_vix1d.csv", "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX1D_History.csv"),
                      ("cboe_vix9d.csv", "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX9D_History.csv"),
                      ("fomc.html", "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"),
                      ("bls_schedule.html", "https://www.bls.gov/schedule/news_release/cpi.htm"),
                      ("bls_empsit.html", "https://www.bls.gov/schedule/news_release/empsit.htm")]:
        t = get(url, raw=True)
        if t:
            with open(os.path.join(OUT, name), "w") as f: f.write(t)
        log(name, len(t or ""))

if __name__ == "__main__":
    steps = sys.argv[1:] or ["discover", "hist", "books", "underlying"]
    for s in steps:
        t0 = time.time()
        try: globals()[s]()
        except Exception as e: log("STEP FAIL", s, repr(e))
        log(f"step {s} {time.time()-t0:.0f}s")
    with open(os.path.join(OUT, "log.txt"), "a") as f:
        f.write(f"\n=== run {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC {steps}\n" + "\n".join(LOG) + "\n")
