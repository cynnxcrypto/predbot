#!/usr/bin/env python3
"""Politics / news-event Polymarket study (research only; never touches the trading bot).

Steps (argv picks which; default all):
  land     open politics/geo/econ-event markets by type: volume, spread, horizon, new-market rate
  hist     resolved politics/geo/fed markets since START + price history -> pol_out/resolved.jsonl.gz
  calib    from hist: calibration by type x horizon x band (horizons measured from SCHEDULED end,
           only while market still open -> no look-ahead), by-date decay, post-end carry, cluster-robust
  xvenue   Kalshi / PredictIt / Manifold vs Polymarket snapshots (repeated SNAPS times) -> gaps + persistence
  fed      FOMC decision markets: 1-min price path around 14:00 ET statement -> reaction lag
Stdlib only. Runs on a GitHub runner (the cloud container cannot reach these APIs).
"""
import json, os, sys, time, math, re, gzip, difflib, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "pol_out"); os.makedirs(OUT, exist_ok=True)
GAMMA, CLOB = "https://gamma-api.polymarket.com", "https://clob.polymarket.com"
KALSHI = "https://api.elections.kalshi.com/trade-api/v2"
NOW = datetime.now(timezone.utc)
START = "2024-01-01T00:00:00Z"
MIN_VOL = 10000
UA = {"User-Agent": "predbot-research/1.0"}
LOG = []

def say(*ls):
    for l in ls:
        print(l, flush=True); LOG.append(l)

def get(url, params=None, tries=4):
    if params: url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                raw = r.read()
                return json.loads(raw) if raw[:1] in (b"{", b"[") else raw.decode("utf-8", "replace")
        except Exception as e:
            if i == tries - 1:
                print("GET fail", url[:160], e, file=sys.stderr); return None
            time.sleep(1.5 * (i + 1))

def jl(x):
    if isinstance(x, str):
        try: return json.loads(x)
        except Exception: return None
    return x

def ts(s):
    if not s: return None
    s = str(s).replace(" ", "T")
    if s.endswith("+00"): s += ":00"
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).timestamp()
    except Exception:
        return None

def page_events(params, cap=20000):
    out, off, seen = [], 0, set()
    while off < cap:
        b = get(GAMMA + "/events", dict(params, limit=100, offset=off))
        if not b or not isinstance(b, list): break
        new = [e for e in b if e.get("id") not in seen]
        if not new: break
        seen.update(e.get("id") for e in new); out += new
        if len(b) < 100: break
        off += 100
    return out

def q(xs, f):
    xs = sorted(x for x in xs if x is not None)
    return xs[min(len(xs) - 1, int(f * len(xs)))] if xs else None

MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december"
def mtype(ev, m):
    t = (ev.get("title") or "") + " || " + (m.get("question") or "")
    tl = t.lower()
    labels = " ".join((x.get("label") or "").lower() for x in ev.get("tags") or [])
    if re.search(r"\bfed\b|fomc|interest rate|rate cut|rate hike|bps", tl): return "fed"
    if re.search(r"\b(say|says|mention|tweet|post)\b", tl) and "mention" in labels + tl: return "mentions"
    if re.search(r"approval rating|approval", tl): return "approval"
    if re.search(r"\bcpi\b|inflation|gdp|unemployment|jobs report|payroll|recession", tl): return "econ_data"
    if re.search(r"\bby\b[^|]*(\?|\d{4}|" + MONTHS + r"|end of|__)|before 20\d\d|\bby\.\.\.", tl): return "by_date"
    if re.search(r"elect|win the|winner|nominee|primary|seat|governor|senate|house|mayor|prime minister|president|parliament|chancellor|popular vote|electoral|speaker|majority leader|seats", tl):
        return "election"
    if re.search(r"invade|ceasefire|strike|war\b|military|troops|missile|nuclear|attack|sanction|blockade|regime", tl): return "geopolitical"
    if re.search(r"\bbill\b|\bact\b|shutdown|congress|senate pass|sign|executive order|tariff|supreme court|scotus|ruling|impeach|indict|pardon", tl): return "legislation_legal"
    if re.search(r"out as|resign|fired|leave|confirmed|nominat|cabinet|secretary", tl): return "personnel"
    return "other"

def fee_rate(m):
    fs = m.get("feeSchedule") or {}
    return float(fs.get("rate") or 0) if m.get("feesEnabled") else 0.0

POL_TAGS = ("politics", "elections", "geopolitics", "world", "us-politics", "global-elections", "fed", "economy", "trump")

# ------------------------------------------------------------------ land
def land():
    evs, seen = [], set()
    for tag in POL_TAGS:
        for e in page_events({"closed": "false", "active": "true", "tag_slug": tag}, cap=5000):
            if e.get("id") not in seen: seen.add(e.get("id")); evs.append(e)
    say(f"## Open politics/geo/econ-event landscape ({NOW:%Y-%m-%d %H:%M} UTC)", f"open events: {len(evs)}")
    by = {}
    for ev in evs:
        for m in ev.get("markets") or []:
            if m.get("closed") or not m.get("acceptingOrders", True): continue
            if (ev.get("title") or "").lower().find("bitcoin") >= 0: continue
            k = mtype(ev, m)
            d = by.setdefault(k, {"n": 0, "ev": set(), "vol24": 0.0, "liq": 0.0, "sp": [], "days": [], "new30": 0, "new7": 0, "fee": 0, "examples": []})
            d["n"] += 1; d["ev"].add(ev.get("id"))
            d["vol24"] += float(m.get("volume24hr") or 0); d["liq"] += float(m.get("liquidityNum") or 0)
            if m.get("spread") is not None and float(m.get("liquidityNum") or 0) >= 1000: d["sp"].append(float(m["spread"]))
            e = ts(m.get("endDate")); c = ts(m.get("createdAt") or m.get("startDate"))
            if e: d["days"].append((e - NOW.timestamp()) / 86400)
            if c and NOW.timestamp() - c < 30 * 86400: d["new30"] += 1
            if c and NOW.timestamp() - c < 7 * 86400: d["new7"] += 1
            if fee_rate(m) > 0: d["fee"] += 1
            if float(m.get("volume24hr") or 0) > 20000 and len(d["examples"]) < 4: d["examples"].append(m.get("question"))
    rows = []
    for k, d in sorted(by.items(), key=lambda x: -x[1]["vol24"]):
        r = {"type": k, "markets": d["n"], "events": len(d["ev"]), "vol24": round(d["vol24"]), "liq": round(d["liq"]),
             "spread_med_c": round(100 * (q(d["sp"], .5) or 0), 1), "spread_p90_c": round(100 * (q(d["sp"], .9) or 0), 1),
             "days_left_med": round(q(d["days"], .5) or 0), "end_le7d": sum(1 for x in d["days"] if 0 <= x <= 7),
             "past_end": sum(1 for x in d["days"] if x < 0), "new_30d": d["new30"], "new_7d": d["new7"], "fee_mkts": d["fee"], "examples": d["examples"]}
        rows.append(r)
        say(f"- {k}: {r['markets']} mkts/{r['events']} ev | 24h ${r['vol24']:,} | liq ${r['liq']:,} | spread med {r['spread_med_c']}c p90 {r['spread_p90_c']}c | days-left med {r['days_left_med']} | ≤7d {r['end_le7d']} | past end {r['past_end']} | new 7d {r['new_7d']} / 30d {r['new_30d']} | fee {r['fee_mkts']}")
        for x in r["examples"]: say(f"    e.g. {x}")
    json.dump(rows, open(f"{OUT}/landscape.json", "w"), indent=1)

# ------------------------------------------------------------------ hist
def hist():
    evs, seen = [], set()
    for tag in POL_TAGS:
        got = page_events({"closed": "true", "end_date_min": START, "tag_slug": tag, "volume_min": MIN_VOL}, cap=20000)
        n0 = len(evs)
        for e in got:
            if e.get("id") not in seen: seen.add(e.get("id")); evs.append(e)
        say(f"  closed tag {tag}: {len(got)} events, {len(evs)-n0} new")
    jobs, fifty, nres = [], 0, 0
    for ev in evs:
        if re.search(r"bitcoin|ethereum|solana|crypto|\bnba\b|\bnfl\b|premier league|stock|s&p|nasdaq", (ev.get("title") or "").lower()): continue
        for m in ev.get("markets") or []:
            if float(m.get("volumeNum") or 0) < MIN_VOL: continue
            outs, pr, toks = jl(m.get("outcomes")), jl(m.get("outcomePrices")), jl(m.get("clobTokenIds"))
            if not (outs and pr and toks) or len(outs) != 2: continue
            try: pr = [float(x) for x in pr]
            except Exception: continue
            nres += 1
            if max(pr) < 0.99: fifty += 1; continue
            jobs.append({"ev": ev.get("id"), "evt": ev.get("title"), "q": m.get("question"), "type": mtype(ev, m), "tok": toks[0],
                         "yes": int(pr[0] > 0.5), "end": ts(m.get("endDate")), "closed": ts(m.get("closedTime")),
                         "created": ts(m.get("createdAt") or m.get("startDate")), "vol": float(m.get("volumeNum") or 0),
                         "fee": fee_rate(m), "negRisk": bool(m.get("negRisk")), "uma": m.get("umaResolutionStatuses") or m.get("umaResolutionStatus")})
    say(f"## Resolved set (since {START[:10]}, vol>=${MIN_VOL:,})", f"binary markets: {nres}; resolved ~50-50/unclear: {fifty}; usable: {len(jobs)}")
    def fetch(j):
        a = int(j["created"] or (j["end"] or NOW.timestamp()) - 400 * 86400); b = int(max(j["closed"] or 0, j["end"] or 0) or NOW.timestamp()) + 3600
        h = None
        for p in ({"startTs": a, "endTs": b, "fidelity": 60}, {"startTs": a, "endTs": b, "fidelity": 720}, {"interval": "max", "fidelity": 60}):
            r = get(CLOB + "/prices-history", dict(p, market=j["tok"]), tries=2)
            h = (r or {}).get("history") if isinstance(r, dict) else None
            if h: break
        if not h: return None
        h.sort(key=lambda x: x["t"])
        fine_from = min(j["closed"] or b, j["end"] or b) - 4 * 86400
        keep, last = [], -1e18
        for x in h:  # hourly in the last 4 days before end/close (and after), 6-hourly before that
            if x["t"] >= fine_from or x["t"] - last >= 6 * 3600:
                keep.append([x["t"], round(float(x["p"]), 4)]); last = x["t"]
        return dict(j, h=keep)
    res = []
    with ThreadPoolExecutor(24) as ex:
        for r in ex.map(fetch, jobs):
            if r: res.append(r)
    with gzip.open(f"{OUT}/resolved.jsonl.gz", "wt") as f:
        for r in res: f.write(json.dumps(r) + "\n")
    say(f"with price history: {len(res)}")
    from collections import Counter
    say("by type: " + ", ".join(f"{k} {v}" for k, v in Counter(r["type"] for r in res).most_common()))

# ------------------------------------------------------------------ calib
def load():
    with gzip.open(f"{OUT}/resolved.jsonl.gz", "rt") as f:
        return [json.loads(l) for l in f]

def p_at(h, t):
    best = None
    for x in h:
        if x[0] <= t: best = x[1]
        else: break
    return best

BANDS = [(0, .03), (.03, .1), (.1, .2), (.2, .35), (.35, .5), (.5, .65), (.65, .8), (.8, .9), (.9, .97), (.97, 1.0)]
HZ = [("90d", 90), ("30d", 30), ("14d", 14), ("7d", 7), ("3d", 3), ("1d", 1)]
COST = 0.01  # assumed spread/slippage per share on top of fees (politics median spread 1c -> half-spread 0.5c; be conservative)

def points(rows, hz_days):
    """(price, won, fee_rate, event, end_ts, market) for both sides, only if market still open at t=end-hz."""
    out = []
    for r in rows:
        if not r["end"]: continue
        t = r["end"] - hz_days * 86400
        cl = r["closed"] or r["end"]
        if t >= cl - 600 or t < r["h"][0][0]: continue
        p = p_at(r["h"], t)
        if p is None or p <= 0.003 or p >= 0.997: continue
        out.append((p, r["yes"], r["fee"], r["ev"], t, r)); out.append((1 - p, 1 - r["yes"], r["fee"], r["ev"], t, r))
    return out

def stats(pts):
    """mean net profit per $1 staked (after fee + COST), cluster-robust SE by event."""
    if not pts: return None
    per_ev = {}
    for p, w, fr, ev, t, r in pts:
        cost = p + fr * p * (1 - p) + COST
        prof = (w - cost) / cost
        a = per_ev.setdefault(ev, [0.0, 0]); a[0] += prof; a[1] += 1
    n = sum(a[1] for a in per_ev.values()); mean = sum(a[0] for a in per_ev.values()) / n
    k = len(per_ev)
    var = sum((a[0] - a[1] * mean) ** 2 for a in per_ev.values()) / max(1, n * n) * k / max(1, k - 1)
    wr = sum(x[1] for x in pts) / len(pts); avgp = sum(x[0] for x in pts) / len(pts)
    return {"n": n, "events": k, "avgp": avgp, "won": wr, "edge_pts": 100 * (wr - avgp), "roi": mean, "se": math.sqrt(var)}

def fmt(s):
    return f"n={s['n']:>5} ev={s['events']:>4} avg {100*s['avgp']:5.1f}c won {100*s['won']:5.1f}% edge {s['edge_pts']:+5.1f}pts net ROI {100*s['roi']:+6.1f}% (±{200*s['se']:.1f})"

def calib():
    rows = load()
    say(f"## Calibration: {len(rows)} resolved markets, {len(set(r['ev'] for r in rows))} events (net of fee + {int(COST*100)}c cost; ± = 2 cluster SE)")
    groups = {"ALL": rows}
    for r in rows: groups.setdefault(r["type"], []).append(r)
    summary = {}
    for g in sorted(groups, key=lambda g: -len(groups[g])):
        rs = groups[g]
        if len(rs) < 40: continue
        say(f"### {g} ({len(rs)} mkts)")
        for hn, hd in HZ:
            pts = points(rs, hd)
            if len(pts) < 60: continue
            say(f"  [{hn} before scheduled end] {len(pts)//2} mkts")
            for lo, hi in BANDS:
                b = [x for x in pts if lo <= x[0] < hi]
                if len(b) < 20: continue
                s = stats(b); summary[f"{g}|{hn}|{lo}-{hi}"] = s
                say(f"    {int(lo*100):>2}-{int(hi*100):<3}c {fmt(s)}")
    json.dump(summary, open(f"{OUT}/calib.json", "w"), indent=1)

    # YES vs NO asymmetry: is YES systematically overpriced (people buy 'something happens')?
    say("## YES-side vs NO-side (all types; buying YES only vs NO only, price 5-95c)")
    for hn, hd in HZ:
        pts = points(rows, hd)
        yes = [x for i, x in enumerate(pts) if i % 2 == 0 and .05 <= x[0] < .95]
        no = [x for i, x in enumerate(pts) if i % 2 == 1 and .05 <= x[0] < .95]
        if len(yes) > 50: say(f"  {hn}: YES {fmt(stats(yes))}", f"  {hn}: NO  {fmt(stats(no))}")

    # by-date decay: buy NO on by-date markets with YES in band, by horizon; plus period split for stability
    bd = groups.get("by_date", []) + groups.get("geopolitical", []) + groups.get("personnel", [])
    say(f"## 'Will X happen by date' family (by_date+geopolitical+personnel, {len(bd)} mkts): buy NO")
    for hn, hd in HZ:
        pts = points(bd, hd)
        nos = [x for i, x in enumerate(pts) if i % 2 == 1]
        for lo, hi in ((.5, .8), (.8, .9), (.9, .95), (.95, .97), (.97, .99)):
            b = [x for x in nos if lo <= x[0] < hi]
            if len(b) < 20: continue
            s = stats(b)
            halves = {}
            for x in b: halves.setdefault(datetime.fromtimestamp(x[4], timezone.utc).strftime("%Y") + ("H1" if datetime.fromtimestamp(x[4], timezone.utc).month <= 6 else "H2"), []).append(x)
            hs = " ".join(f"{k}:{100*stats(v)['roi']:+.0f}%({len(v)})" for k, v in sorted(halves.items()) if len(v) >= 10)
            say(f"  {hn} NO {int(lo*100)}-{int(hi*100)}c {fmt(s)} | {hs}")
    # YES drift: avg YES price path for by-date markets that resolved NO vs YES
    say("## By-date YES price decay (median YES price at fraction of life elapsed)")
    for outcome in (0, 1):
        fr = {f: [] for f in (0.1, 0.25, 0.5, 0.75, 0.9, 0.97)}
        for r in bd:
            if r["yes"] != outcome or not r["end"]: continue
            a = r["h"][0][0]; L = r["end"] - a
            if L < 5 * 86400: continue
            for f in fr:
                t = a + f * L
                if t < (r["closed"] or r["end"]): fr[f].append(p_at(r["h"], t))
        say(f"  resolved {'YES' if outcome else 'NO '}: " + " ".join(f"{int(f*100)}%:{100*(q(v,.5) or 0):.1f}c(n{len(v)})" for f, v in fr.items()))

    # post-scheduled-end carry: market past its end date, still open, favourite 90-99.5c
    say("## Post-end carry (t = end + X, market not yet closed; favourite side)")
    for hrs in (6, 24, 48, 96):
        pts = []
        for r in rows:
            if not r["end"] or not r["closed"]: continue
            t = r["end"] + hrs * 3600
            if t >= r["closed"] - 600: continue
            p = p_at(r["h"], t)
            if p is None: continue
            fav, won = (p, r["yes"]) if p >= .5 else (1 - p, 1 - r["yes"])
            if .9 <= fav < .995:
                pts.append((fav, won, r["fee"], r["ev"], t, r))
        if len(pts) < 10: continue
        s = stats(pts); lag = q([(x[5]["closed"] - x[4]) / 86400 for x in pts], .5)
        losers = [x[5]["q"] for x in pts if not x[1]][:6]
        say(f"  end+{hrs}h fav 90-99.5c: {fmt(s)} | median days to close {lag:.1f}", *[f"    LOST: {l}" for l in losers])
        for lo, hi in ((.9, .97), (.97, .995)):
            b = [x for x in pts if lo <= x[0] < hi]
            if len(b) >= 10: say(f"    {int(lo*100)}-{hi*100:.1f}c {fmt(stats(b))}")

    # longshot NO with capital-time: return per day held
    say("## Longshot NO (YES 3-20c), return per day of capital lock")
    for hn, hd in HZ:
        pts = points(rows, hd)
        nos = [x for i, x in enumerate(pts) if i % 2 == 1 and .8 <= x[0] < .97]
        if len(nos) < 30: continue
        s = stats(nos)
        days = q([((x[5]["closed"] or x[5]["end"]) - x[4]) / 86400 for x in nos], .5)
        say(f"  {hn}: {fmt(s)} | median hold {days:.0f}d -> {100*s['roi']/max(days,1):+.3f}%/day")

    # volume split: is mispricing concentrated in thin markets?
    say("## Favourite-longshot by market volume (7d horizon, both sides)")
    pts = points(rows, 7)
    for lo, hi in ((1e4, 5e4), (5e4, 3e5), (3e5, 1e12)):
        sub = [x for x in pts if lo <= x[5]["vol"] < hi]
        for blo, bhi in ((0, .1), (.1, .35), (.65, .9), (.9, 1)):
            b = [x for x in sub if blo <= x[0] < bhi]
            if len(b) >= 20: say(f"  vol ${lo/1e3:.0f}k-{'' if hi>1e11 else f'${hi/1e3:.0f}k'} {int(blo*100)}-{int(bhi*100)}c {fmt(stats(b))}")

# ------------------------------------------------------------------ xvenue
STOP = set("will the be a an of in on to by for and or at as is who what which next win wins 2025 2026 2027 2028 before after than more less yes no".split())
def toks(s):
    return set(w for w in re.findall(r"[a-z0-9]+", (s or "").lower()) if w not in STOP and len(w) > 1)

def pm_open():
    evs, seen = [], set()
    for tag in POL_TAGS:
        for e in page_events({"closed": "false", "active": "true", "tag_slug": tag}, cap=5000):
            if e.get("id") not in seen: seen.add(e.get("id")); evs.append(e)
    out = []
    for ev in evs:
        for m in ev.get("markets") or []:
            if m.get("closed") or not m.get("acceptingOrders", True): continue
            if float(m.get("liquidityNum") or 0) < 2000: continue
            try: bid, ask = float(m.get("bestBid")), float(m.get("bestAsk"))
            except Exception: continue
            out.append({"q": m.get("question"), "evt": ev.get("title"), "git": m.get("groupItemTitle"), "bid": bid, "ask": ask,
                        "end": m.get("endDate"), "liq": float(m.get("liquidityNum") or 0), "vol24": float(m.get("volume24hr") or 0)})
    return out

def kalshi_open():
    evs, cur = [], None
    for _ in range(80):
        p = {"limit": 200, "status": "open", "with_nested_markets": "true"}
        if cur: p["cursor"] = cur
        b = get(KALSHI + "/events", p)
        if not isinstance(b, dict): break
        evs += b.get("events") or []; cur = b.get("cursor")
        if not cur: break
    out = []
    for e in evs:
        if (e.get("category") or "") not in ("Politics", "Elections", "World", "Economics", "Financials", "Companies") and "pol" not in (e.get("category") or "").lower(): continue
        for m in e.get("markets") or []:
            def f(k):
                v = m.get(k + "_dollars", m.get(k))
                try: v = float(v)
                except Exception: return None
                return v / 100 if v > 1.5 else v
            yb, ya = f("yes_bid"), f("yes_ask")
            if not ya or ya <= 0 or not yb: continue
            out.append({"venue": "kalshi", "evt": e.get("title"), "q": (e.get("title") or "") + " | " + (m.get("yes_sub_title") or m.get("title") or ""),
                        "bid": yb, "ask": ya, "end": m.get("close_time"), "cat": e.get("category"), "ticker": m.get("ticker")})
    return out

def predictit_open():
    b = get("https://www.predictit.org/api/marketdata/all/")
    out = []
    for mk in (b or {}).get("markets", []) if isinstance(b, dict) else []:
        for c in mk.get("contracts") or []:
            yb, ya = c.get("bestSellYesCost"), c.get("bestBuyYesCost")
            if not ya or not yb: continue
            nm = c.get("name") if c.get("name") != mk.get("name") else ""
            out.append({"venue": "predictit", "evt": mk.get("name"), "q": (mk.get("name") or "") + " | " + (nm or ""), "bid": float(yb), "ask": float(ya), "end": c.get("dateEnd")})
    return out

def manifold_open():
    out = []
    for term in ("election", "president", "fed", "trump", "senate", "prime minister", "war", "ceasefire", "nominee", "2028"):
        b = get("https://api.manifold.markets/v0/search-markets", {"term": term, "filter": "open", "contractType": "BINARY", "limit": 200, "sort": "liquidity"})
        for m in b or [] if isinstance(b, list) else []:
            if m.get("probability") is None or (m.get("uniqueBettorCount") or 0) < 30: continue
            out.append({"venue": "manifold", "evt": m.get("question"), "q": m.get("question"), "bid": m["probability"], "ask": m["probability"], "end": m.get("closeTime")})
    d = {}
    for x in out: d[x["q"]] = x
    return list(d.values())

def match(pm, other, thr=0.62):
    idx = {}
    for i, p in enumerate(pm):
        p["_t"] = toks(p["q"])
        for w in p["_t"]: idx.setdefault(w, []).append(i)
    res = []
    for o in other:
        ot = toks(o["q"])
        if len(ot) < 2: continue
        cand = {}
        for w in ot:
            for i in idx.get(w, []): cand[i] = cand.get(i, 0) + 1
        best, bs = None, 0
        for i, c in sorted(cand.items(), key=lambda x: -x[1])[:40]:
            pt = pm[i]["_t"]; j = len(pt & ot) / len(pt | ot)
            j = 0.6 * j + 0.4 * difflib.SequenceMatcher(None, pm[i]["q"].lower(), o["q"].lower()).ratio()
            if j > bs: best, bs = i, j
        if best is not None and bs >= thr:
            p = pm[best]; pmid, omid = (p["bid"] + p["ask"]) / 2, (o["bid"] + o["ask"]) / 2
            arb = max(o["bid"] - p["ask"], p["bid"] - o["ask"])  # crossed books (before fees)
            res.append({"venue": o["venue"], "sim": round(bs, 2), "pm_q": p["q"], "o_q": o["q"], "pm_bid": p["bid"], "pm_ask": p["ask"],
                        "o_bid": o["bid"], "o_ask": o["ask"], "gap_mid": round(omid - pmid, 3), "cross": round(arb, 3), "pm_liq": p["liq"]})
    return res

def xvenue(snaps=4, gap_min=20):
    say("## Cross-venue snapshots (Polymarket vs Kalshi / PredictIt / Manifold)")
    hist = {}
    for s in range(snaps):
        pm = pm_open(); ka = kalshi_open(); pi = predictit_open(); mf = manifold_open()
        say(f"snap {s+1} {datetime.now(timezone.utc):%H:%M} UTC: PM {len(pm)} mkts, Kalshi {len(ka)}, PredictIt {len(pi)}, Manifold {len(mf)}")
        ms = match(pm, ka) + match(pm, pi) + match(pm, mf, 0.7)
        for m in ms:
            hist.setdefault((m["venue"], m["pm_q"], m["o_q"]), []).append(m)
        if s == 0:
            json.dump({"kalshi_sample": ka[:50], "predictit_sample": pi[:50], "manifold_sample": mf[:50]}, open(f"{OUT}/xvenue_samples.json", "w"), indent=1)
        if s < snaps - 1: time.sleep(gap_min * 60)
    rows = []
    for k, v in hist.items():
        rows.append({**v[-1], "snaps": len(v), "gaps": [x["gap_mid"] for x in v], "crosses": [x["cross"] for x in v]})
    json.dump(rows, open(f"{OUT}/xvenue.json", "w"), indent=1)
    for venue in ("kalshi", "predictit", "manifold"):
        r = [x for x in rows if x["venue"] == venue and x["sim"] >= 0.7]
        if not r: say(f"- {venue}: 0 matches"); continue
        ag = sorted(abs(x["gap_mid"]) for x in r)
        say(f"- {venue}: {len(r)} matched (sim>=0.7) | |mid gap| median {100*q(ag,.5):.1f}c p90 {100*q(ag,.9):.1f}c | >=5c: {sum(1 for g in ag if g>=.05)} | crossed books: {sum(1 for x in r if x['cross']>0)}")
        for x in sorted(r, key=lambda x: -abs(x["gap_mid"]))[:12]:
            pers = sum(1 for g in x["gaps"] if abs(g) >= 0.05)
            say(f"    gap {100*x['gap_mid']:+5.1f}c cross {100*x['cross']:+4.1f}c persist {pers}/{len(x['gaps'])} | PM {x['pm_bid']:.2f}/{x['pm_ask']:.2f} vs {x['o_bid']:.2f}/{x['o_ask']:.2f} | {x['pm_q'][:70]} <> {x['o_q'][:60]}")

# ------------------------------------------------------------------ fed
def fed():
    evs = []
    for qs in ("fed decision", "fed interest rate", "fomc"):
        b = get(GAMMA + "/public-search", {"q": qs, "events_status": "closed", "limit_per_type": 50})
        evs += (b or {}).get("events", []) if isinstance(b, dict) else []
    seen, rows = set(), []
    say("## FOMC reaction (1-min prices around 14:00 ET statement)")
    for ev in evs:
        if ev.get("id") in seen or not re.search(r"fed decision", (ev.get("title") or "").lower()): continue
        seen.add(ev.get("id"))
        full = get(GAMMA + "/events/" + str(ev["id"])) or ev
        for m in full.get("markets") or []:
            pr, tk = jl(m.get("outcomePrices")), jl(m.get("clobTokenIds"))
            if not pr or not tk: continue
            yes = float(pr[0]) > 0.5
            end = ts(m.get("endDate"))
            if not end: continue
            day = datetime.fromtimestamp(end, timezone.utc).date()
            # statement 14:00 New York: 18:00 UTC during DST (Mar-Nov), else 19:00
            dst = 3 <= day.month <= 10 or (day.month == 11 and day.day < 3)
            T = datetime(day.year, day.month, day.day, 18 if dst else 19, tzinfo=timezone.utc).timestamp()
            h = get(CLOB + "/prices-history", {"market": tk[0], "startTs": int(T - 2 * 86400), "endTs": int(T + 3 * 3600), "fidelity": 1}, tries=2)
            h = sorted(((x["t"], float(x["p"])) for x in (h or {}).get("history", [])), key=lambda x: x[0]) if isinstance(h, dict) else []
            if len(h) < 10: continue
            pts = {k: p_at(h, T + s) for k, s in (("-1d", -86400), ("-1h", -3600), ("-5m", -300), ("+1m", 60), ("+2m", 120), ("+5m", 300), ("+15m", 900), ("+60m", 3600))}
            rows.append({"evt": full.get("title"), "q": m.get("question"), "yes": yes, "vol": float(m.get("volumeNum") or 0), **pts})
    json.dump(rows, open(f"{OUT}/fed.json", "w"), indent=1)
    say(f"FOMC markets with 1-min history: {len(rows)}")
    unsure = [r for r in rows if r["-1h"] is not None and 0.03 < r["-1h"] < 0.97]
    say(f"markets not decided 1h before (3-97c): {len(unsure)}")
    for r in sorted(unsure, key=lambda r: -r["vol"])[:25]:
        say(f"  {'Y' if r['yes'] else 'N'} vol ${r['vol']:,.0f} | " + " ".join(f"{k}:{(r[k] or 0)*100:.0f}" for k in ("-1d", "-1h", "-5m", "+1m", "+2m", "+5m", "+15m", "+60m")) + f" | {r['q'][:70]}")

if __name__ == "__main__":
    steps = sys.argv[1:] or ["land", "hist", "calib", "xvenue", "fed"]
    for s in steps:
        t0 = time.time()
        try:
            {"land": land, "hist": hist, "calib": calib, "xvenue": xvenue, "fed": fed}[s]()
        except Exception as e:
            import traceback; traceback.print_exc(); say(f"!! step {s} failed: {e!r}")
        say(f"({s} took {time.time()-t0:.0f}s)")
        open(f"{OUT}/summary-{'-'.join(steps)}.md", "w").write("\n".join(LOG) + "\n")
