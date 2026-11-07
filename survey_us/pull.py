#!/usr/bin/env python3
"""US sports Polymarket survey: raw pull for offline analysis (research only; never touches the bot).

Steps (args): probe landscape games prices trades nflverse sbr injury
Writes survey_us/out/*.json.gz. Stdlib (+openpyxl for sbr xlsx if present).
"""
import gzip, io, json, os, re, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
DATA = "https://data-api.polymarket.com"
UA = {"User-Agent": "predbot-research/1.0 (github.com/cynnxcrypto/predbot)"}
NOW = datetime.now(timezone.utc)
SPORTS = ["nba", "nfl", "nhl", "mlb", "cfb", "cbb"]
T0 = time.time()


def log(*a):
    print(f"[{time.time()-T0:6.0f}s]", *a, flush=True)


def get(url, params=None, tries=4, raw=False, timeout=40):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                b = r.read()
                if raw:
                    return b
                return json.loads(b) if b[:1] in (b"{", b"[") else b.decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 403, 404) or i == tries - 1:
                log("GET", e.code, url[:150]); return None
            time.sleep(min(30, 2 * 2 ** i))
        except Exception as e:
            if i == tries - 1:
                log("GET fail", url[:150], e); return None
            time.sleep(1.5 * (i + 1))


def save(name, obj):
    with gzip.open(f"{OUT}/{name}.json.gz", "wt") as f:
        json.dump(obj, f, separators=(",", ":"))
    log("saved", name, os.path.getsize(f"{OUT}/{name}.json.gz") // 1024, "KB")


def load(name):
    p = f"{OUT}/{name}.json.gz"
    return json.load(gzip.open(p, "rt")) if os.path.exists(p) else None


def jl(x, d=None):
    if isinstance(x, str):
        try: return json.loads(x)
        except Exception: return d
    return x if x is not None else d


def tsec(s):
    if not s: return None
    s = str(s).replace(" ", "T")
    if s.endswith("+00"): s += ":00"
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).timestamp()
    except Exception:
        return None


def sports_index():
    s = get(GAMMA + "/sports") or []
    idx = {}
    for x in s:
        k = (x.get("sport") or "").lower()
        if k in SPORTS:
            idx[k] = x
    return idx


def page(path, params, cap=20000):
    out, off = [], 0
    while off < cap:
        b = get(GAMMA + path, dict(params, limit=100, offset=off))
        if not b: break
        out += b
        if len(b) < 100: break
        off += 100
    return out


MK_KEYS = ["id", "question", "conditionId", "slug", "outcomes", "outcomePrices", "clobTokenIds", "sportsMarketType", "line",
           "gameStartTime", "endDate", "closedTime", "closed", "volumeNum", "liquidityNum", "spread", "bestBid", "bestAsk",
           "lastTradePrice", "groupItemTitle", "umaResolutionStatus", "feesEnabled", "feeSchedule", "volume24hr", "oneDayPriceChange",
           "acceptingOrders", "negRisk", "orderMinSize", "orderPriceMinTickSize", "gameId"]


def slim_event(e):
    ev = {k: v for k, v in e.items() if not isinstance(v, (list, dict)) and k not in ("description", "image", "icon", "resolutionSource")}
    ev["tags"] = [t.get("slug") for t in e.get("tags") or []]
    ev["teams"] = e.get("teams")
    ev["markets"] = [{k: m.get(k) for k in MK_KEYS if k in m} for m in e.get("markets") or []]
    return ev


def probe():
    idx = sports_index()
    save("sports_index", idx)
    for sp, x in idx.items():
        log("sport", sp, json.dumps(x)[:300])
    for sp in ("nba", "nfl"):
        sid = idx.get(sp, {}).get("series")
        evs = get(GAMMA + "/events", {"series_id": sid, "closed": "true", "limit": 3, "order": "startDate", "ascending": "false"}) or []
        for e in evs[:1]:
            log("EVENT KEYS", sp, sorted(e.keys()))
            log("EVENT", json.dumps({k: v for k, v in e.items() if k != "markets"})[:2500])
            for m in (e.get("markets") or [])[:4]:
                log("MARKET", json.dumps(m)[:2000])


def landscape():
    idx = sports_index()
    rows = []
    for sp, x in idx.items():
        evs = page("/events", {"series_id": x.get("series"), "closed": "false", "active": "true"}, cap=3000)
        for e in evs:
            st_ = None
            for m in e.get("markets") or []:
                st_ = st_ or tsec(m.get("gameStartTime"))
            if st_ is None or st_ - NOW.timestamp() > 8 * 86400: continue
            rows.append(dict(slim_event(e), sport=sp, start=st_))
        log("landscape", sp, len(evs), "open events")
    save("landscape", rows)


def games():
    idx = sports_index()
    allg = {}
    for sp, x in idx.items():
        evs = page("/events", {"series_id": x.get("series"), "closed": "true", "order": "startDate", "ascending": "false"}, cap=12000)
        keep = []
        for e in evs:
            if not any(m.get("sportsMarketType") or m.get("gameStartTime") for m in e.get("markets") or []): continue
            keep.append(slim_event(e))
        allg[sp] = keep
        log("games", sp, len(evs), "closed events,", len(keep), "game events")
    save("games", allg)


def main_markets(ev):
    """moneyline + main spread + main total for a game event."""
    out = []
    ms = ev.get("markets") or []
    ml = [m for m in ms if m.get("sportsMarketType") == "moneyline"]
    out += ml[:1]
    for typ in ("spreads", "totals"):
        c = [m for m in ms if m.get("sportsMarketType") == typ]
        if c:
            out.append(max(c, key=lambda m: float(m.get("volumeNum") or 0)))
    return out


def prices():
    g = load("games") or {}
    jobs = []
    for sp, evs in g.items():
        for ev in evs:
            for m in main_markets(ev):
                toks = jl(m.get("clobTokenIds"), [])
                st_ = tsec(m.get("gameStartTime"))
                if not toks or not st_ or st_ < datetime(2024, 9, 1, tzinfo=timezone.utc).timestamp(): continue
                jobs.append((sp, m["id"], m.get("sportsMarketType"), toks[0], int(st_)))
    log("price jobs", len(jobs))

    def one(j):
        sp, mid, typ, tok, st_ = j
        fine = get(CLOB + "/prices-history", {"market": tok, "startTs": st_ - 4 * 3600, "endTs": st_ + 1800, "fidelity": 1}, tries=3)
        coarse = get(CLOB + "/prices-history", {"market": tok, "startTs": st_ - 3 * 86400, "endTs": st_ - 4 * 3600, "fidelity": 60}, tries=3)
        post = None
        if typ == "moneyline":
            post = get(CLOB + "/prices-history", {"market": tok, "startTs": st_ + 1800, "endTs": st_ + 5 * 3600, "fidelity": 5}, tries=3)
        f = lambda h: [[x["t"], round(x["p"], 4)] for x in (h or {}).get("history", [])] if isinstance(h, dict) else []
        return mid, {"f": f(fine), "c": f(coarse), "p": f(post)}

    res = {}
    with ThreadPoolExecutor(12) as ex:
        for i, (mid, r) in enumerate(ex.map(one, jobs)):
            res[mid] = r
            if i % 1000 == 0: log("prices", i)
    save("prices", res)


def trades():
    """Real fills for a sample of markets: last 2h before start. Checks whether price-history mids are fillable."""
    g = load("games") or {}
    jobs = []
    for sp, evs in g.items():
        for ev in evs[:700]:
            for m in main_markets(ev):
                st_ = tsec(m.get("gameStartTime"))
                if st_ and m.get("conditionId"):
                    jobs.append((m["id"], m["conditionId"], st_))
    log("trade jobs", len(jobs))

    def one(j):
        mid, cid, st_ = j
        rows, off = [], 0
        while off < 3000:
            b = get(DATA + "/trades", {"market": cid, "limit": 500, "offset": off, "takerOnly": "true"}, tries=3)
            if not isinstance(b, list) or not b: break
            rows += [[x.get("timestamp"), x.get("side"), x.get("outcomeIndex"), x.get("price"), x.get("size")] for x in b]
            if min(int(x.get("timestamp") or 0) for x in b) < st_ - 7200 or len(b) < 500: break
            off += 500
        return mid, [r for r in rows if r[0] and st_ - 7200 <= int(r[0]) <= st_ + 600]

    res = {}
    with ThreadPoolExecutor(8) as ex:
        for mid, r in ex.map(one, jobs):
            res[mid] = r
    save("trades", res)


def nflverse():
    b = get("https://github.com/nflverse/nfldata/raw/master/data/games.csv", raw=True, timeout=90)
    if b:
        with gzip.open(f"{OUT}/nflverse_games.csv.gz", "wb") as f: f.write(b)
        log("nflverse rows", b.count(b"\n"))


def sbr():
    """Long-run closing moneylines (sportsbookreviewsonline archives)."""
    base = "https://www.sportsbookreviewsonline.com/scoresoddsarchives/"
    got = {}
    for sp, slug in (("nba", "nba"), ("nhl", "nhl"), ("mlb", "mlb"), ("nfl", "nfl")):
        for y in range(2010, 2026):
            season = f"{y}-{str(y+1)[2:]}" if sp in ("nba", "nhl", "nfl") else f"{y}"
            cands = [f"{base}{slug}/{slug}%20odds%20{season}.xlsx", f"{base}{slug}-odds-{season}/"]
            for u in cands:
                b = get(u, raw=True, tries=2, timeout=60)
                if b and len(b) > 5000:
                    ext = "xlsx" if u.endswith("xlsx") else "html"
                    fn = f"sbr_{sp}_{season}.{ext}.gz"
                    with gzip.open(f"{OUT}/{fn}", "wb") as f: f.write(b)
                    got[f"{sp} {season}"] = ext
                    break
    log("sbr got", got)
    save("sbr_index", got)


def injury():
    """NBA official injury report: which report times exist for recent days (timing / cadence)."""
    out = {}
    base = "https://ak-static.cms.nba.com/referee/injury/Injury-Report_{d}_{t}.pdf"
    for dd in range(1, 4):
        d = (NOW - timedelta(days=dd)).strftime("%Y-%m-%d")
        found = []
        for h in range(1, 13):
            for mi in ("00", "15", "30", "45"):
                for ap in ("AM", "PM"):
                    t = f"{h:02d}_{mi}{ap}"
                    req = urllib.request.Request(base.format(d=d, t=t), headers=UA, method="HEAD")
                    try:
                        with urllib.request.urlopen(req, timeout=15) as r:
                            if r.status == 200: found.append(t)
                    except Exception:
                        pass
        out[d] = found
        log("nba injury", d, found)
    save("nba_injury_times", out)


if __name__ == "__main__":
    steps = sys.argv[1:] or ["probe"]
    for s in steps:
        try:
            log("== step", s); globals()[s]()
        except Exception as e:
            import traceback; traceback.print_exc(); log("step failed", s, e)
    log("done")
