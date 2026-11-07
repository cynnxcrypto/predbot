#!/usr/bin/env python3
"""Polymarket non-crypto history collector (research data only; never touches the trading bot or live-rules.json).

Writes under OUT (default ./data/history), meant to be the server-data branch:
  pm/<family>/<YYYY>/<YYYY-MM-DD>.markets.csv.gz   one row per resolved market, events whose endDate falls on that UTC day
  pm/<family>/<YYYY>/<YYYY-MM-DD>.prices.parquet   price path of outcome 0 (~10-min points, hourly once >7 days before end)
  pm/<family>/<YYYY>/<YYYY-MM-DD>.prices1m.parquet 1-min price path from game start -3 h to +3 h (main game markets only)
  pm/<family>/<YYYY>/<YYYY-MM-DD>.fills.parquet    on-chain fills (Goldsky orderbook subgraph), last 60 min before game start
  results/...                                      independent outcome sources (see README)
  state.json                                       which days are done

Usage:
  collect.py pm [--start 2025-01-01] [--budget-min 240] [--commit-cmd "..."]
  collect.py results
Stdlib + pyarrow.
"""
import argparse, csv, gzip, io, json, os, re, subprocess, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import pyarrow as pa, pyarrow.parquet as pq

VERSION = 1
GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
GOLDSKY = "https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn"
UA = {"User-Agent": "predbot-history/1.0 (research; github.com/cynnxcrypto/predbot)", "Accept-Encoding": "gzip"}
OUT = os.environ.get("OUT", "data/history")
LOG = []


def log(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)
    LOG.append(s)


def get(url, params=None, tries=5, raw=False, data=None, timeout=40):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            h = dict(UA)
            if data is not None:
                h["Content-Type"] = "application/json"
            with urllib.request.urlopen(urllib.request.Request(url, headers=h, data=data), timeout=timeout) as r:
                b = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    b = gzip.decompress(b)
                return b if raw else json.loads(b)
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 403, 404, 410, 422) or i == tries - 1:
                if e.code not in (400, 404, 422):
                    log("GET fail", e.code, url[:160])
                return None
            time.sleep(min(60, 3 * 2 ** i) if e.code == 429 else 1.5 * (i + 1))
        except Exception as e:
            if i == tries - 1:
                log("GET fail", url[:160], e)
                return None
            time.sleep(1.5 * (i + 1))


def jl(x, d=None):
    if isinstance(x, str):
        try:
            return json.loads(x)
        except Exception:
            return d
    return x if x is not None else d


def tsec(s):
    if not s:
        return None
    s = str(s).replace(" ", "T")
    if s.endswith("+00"):
        s += ":00"
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return int((d if d.tzinfo else d.replace(tzinfo=timezone.utc)).timestamp())
    except Exception:
        return None


# ------------------------------------------------------------------ classification
CRYPTO = {"crypto", "crypto-prices", "bitcoin", "ethereum", "solana", "xrp", "memecoins"}
US = {"nba", "nfl", "nhl", "mlb", "wnba", "cfb", "ncaab", "cbb", "college-football", "college-basketball", "ncaa", "basketball", "hockey", "baseball", "american-football"}
FIN = {"finance-updown", "up-or-down", "daily-close", "indicies", "indices", "stocks", "equities", "commodities"}
POL = {"politics", "elections", "geopolitics", "midterms", "global-elections", "us-politics", "world-elections"}
ESPORT_SUB = [("counter-strike", "cs2"), ("cs2", "cs2"), ("league-of-legends", "lol"), ("lol", "lol"), ("dota", "dota2"), ("valorant", "valorant")]


def classify(ev):
    tg = {(t.get("slug") or "").lower() for t in ev.get("tags") or []}
    series = [s.get("slug") for s in ev.get("series") or [] if s.get("slug")] or ([ev["seriesSlug"]] if ev.get("seriesSlug") else [])
    ser = series[0] if series else ""
    mk = ev.get("markets") or []
    gamey = "games" in tg or ev.get("gameId") or any(m.get("sportsMarketType") or m.get("gameStartTime") for m in mk)
    if "esports" in tg and gamey:
        sub = next((v for k, v in ESPORT_SUB if any(k in t for t in tg)), "other")
        return "esports", sub, ser
    if gamey:
        if "soccer" in tg:
            return "football", ser or "soccer", ser
        u = tg & US
        if u:
            lg = next((x for x in ("nba", "nfl", "nhl", "mlb", "wnba", "cfb", "college-football", "ncaab", "cbb") if x in tg), sorted(u)[0])
            return "us_sports", lg, ser
        if "tennis" in tg or any(x in tg for x in ("atp", "wta")):
            return "tennis", next((x for x in ("atp", "wta", "itf", "challenger") if x in tg), ser or "tennis"), ser
        return "other_sports", ser or (ev.get("sport") or "games"), ser
    if "daily-temperature" in tg or "highest-temperature" in tg or ser.endswith("daily-weather"):
        return "temperature", ser, ser
    if tg & CRYPTO and not (tg & {"finance-updown", "commodities", "stocks", "indicies"}):
        return None, None, ser
    if "up-or-down" in tg or "finance-updown" in tg or "daily-close" in tg:
        return "finance_daily", ser or "finance", ser
    if tg & POL:
        return "politics", ser or next(iter(sorted(tg & POL))), ser
    if "weather" in tg or "temperature" in tg:
        return "weather_other", ser, ser
    if "sports" in tg or "esports" in tg:
        return "sports_futures", ser, ser
    return "other", ser or ",".join(sorted(tg))[:60], ser


QUERY_TAGS = ["games", "sports", "esports", "soccer", "daily-temperature", "weather", "finance", "finance-updown", "daily-close", "stocks",
              "commodities", "indicies", "politics", "elections", "geopolitics", "economy"]  # not "up-or-down": it is mostly crypto 5m
MAIN_SMT = {"moneyline", "totals", "spreads", "child_moneyline", "map_winner", "soccer_halftime_result", None}


def window_events(tag, a, b, seen, depth=0):
    """All closed events with endDate in [a, b); splits the window when Gamma refuses a deep offset (422)."""
    off = 0
    while True:
        r = get(GAMMA + "/events", {"tag_slug": tag, "closed": "true", "end_date_min": a.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                    "end_date_max": b.strftime("%Y-%m-%dT%H:%M:%SZ"), "limit": 100, "offset": off})
        if r is None:
            if off > 0 and depth < 6 and (b - a).total_seconds() > 900:
                mid = a + (b - a) / 2
                window_events(tag, a, mid, seen, depth + 1)
                window_events(tag, mid, b, seen, depth + 1)
            elif off > 0:
                log("gamma: gave up deeper pages", tag, a, b, off)
            return
        for e in r:
            seen.setdefault(e.get("id"), e)
        if len(r) < 100:
            return
        off += 100


def day_events(d):
    a = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    seen = {}
    for tag in QUERY_TAGS:
        window_events(tag, a, a + timedelta(days=1), seen)
    return list(seen.values())


STATION = re.compile(r"/([A-Z]{4})(?:[/?&\"\s]|$)|ids=([A-Z]{4})|\(([A-Z]{4})\)")


def event_row(d, fam, sub, ser, ev):
    return {
        "day": str(d), "family": fam, "sub": sub, "series": ser, "event_id": ev.get("id"), "event_slug": ev.get("slug"),
        "event_title": ev.get("title"), "tags": "|".join(t.get("slug") or "" for t in ev.get("tags") or []),
        "teams": "|".join(t.get("name") or "" for t in ev.get("teams") or []) if isinstance(ev.get("teams"), list) else "",
        "event_start": ev.get("startTime") or ev.get("eventDate") or "", "event_end": ev.get("endDate") or "",
        "event_score": ev.get("score") or "", "event_period": ev.get("period") or "", "game_id": ev.get("gameId") or "",
        "event_volume": round(float(ev.get("volume") or 0), 2), "open_interest": ev.get("openInterest"),
        "neg_risk": int(bool(ev.get("negRisk"))), "n_markets": len(ev.get("markets") or []),
        "resolution_source": (ev.get("resolutionSource") or "")[:200],
        "description": "" if fam in GAME_FAMS else (ev.get("description") or "")[:600],
    }


def market_row(d, fam, ev, m):
    outs, toks, prices = jl(m.get("outcomes"), []), jl(m.get("clobTokenIds"), []), jl(m.get("outcomePrices"), [])
    win = ""
    try:
        pf = [float(x) for x in prices]
        if pf and max(pf) >= 0.99:
            win = pf.index(max(pf))
    except Exception:
        pass
    fs = m.get("feeSchedule") or {}
    desc = m.get("description") or ev.get("description") or ""
    rs = m.get("resolutionSource") or ev.get("resolutionSource") or ""
    st = ""
    if fam in ("temperature", "weather_other"):
        mm = STATION.search(rs) or STATION.search(desc)
        st = next((g for g in mm.groups() if g), "") if mm else ""
    return {
        "day": str(d), "family": fam, "event_id": ev.get("id"), "market_id": m.get("id"), "condition_id": m.get("conditionId"),
        "question": m.get("question"), "group_item": m.get("groupItemTitle") or "", "smt": m.get("sportsMarketType") or "",
        "line": m.get("line") if m.get("line") is not None else "", "game_start": m.get("gameStartTime") or "",
        "outcomes": json.dumps(outs), "token_ids": json.dumps(toks), "final_prices": json.dumps(prices), "winner_idx": win,
        "uma_status": m.get("umaResolutionStatus") or "", "last_trade": m.get("lastTradePrice"), "best_bid": m.get("bestBid"),
        "best_ask": m.get("bestAsk"), "volume": round(float(m.get("volumeNum") or 0), 2), "volume_clob": round(float(m.get("volumeClob") or 0), 2),
        "liquidity": round(float(m.get("liquidityNum") or 0), 2), "created_at": m.get("createdAt") or "", "start_date": m.get("startDate") or "",
        "end_date": m.get("endDate") or "", "closed_time": m.get("closedTime") or "", "neg_risk": int(bool(m.get("negRisk"))),
        "fees_enabled": int(bool(m.get("feesEnabled"))), "fee_rate": fs.get("rate", ""), "fee_exp": fs.get("exponent", ""),
        "tick": m.get("orderPriceMinTickSize"), "station": st,
        "description": "" if fam in GAME_FAMS or desc == (ev.get("description") or "") else desc[:400],
    }


GAME_FAMS = ("football", "us_sports", "esports", "tennis", "other_sports")


def keep_market(fam, r):
    """Game events carry dozens of near-empty prop markets (exact scores, corners); keep main lines and anything with $100+ volume."""
    return fam not in GAME_FAMS or r["volume"] >= 100 or r["smt"] in ("moneyline", "totals", "spreads", "child_moneyline")


def price_min_vol(fam):
    return 1000 if fam in GAME_FAMS else 200


def fetch_prices(row):
    toks = json.loads(row["token_ids"])
    if not toks:
        return row["market_id"], [], []
    r = get(CLOB + "/prices-history", {"market": toks[0], "interval": "max", "fidelity": 10})
    h = (r or {}).get("history") or []
    end = tsec(row["closed_time"]) or tsec(row["end_date"]) or (h[-1]["t"] if h else 0)
    pts, last_hour = [], None
    for x in h:
        t = int(x["t"])
        if t < end - 7 * 86400:  # thin out to hourly far from the end
            hr = t // 3600
            if hr == last_hour:
                continue
            last_hour = hr
        pts.append((t, float(x["p"])))
    one = []
    gs = tsec(row["game_start"])
    big = (row["smt"] in ("moneyline", "child_moneyline") and row["volume"] >= 2000) or (row["smt"] in ("totals", "spreads") and row["volume"] >= 10000)
    if gs and big:
        for a, b in ((gs - 6 * 3600, gs - 1), (gs, gs + 5 * 3600)):  # CLOB caps a 1-min window; two halves
            r = get(CLOB + "/prices-history", {"market": toks[0], "startTs": a, "endTs": b, "fidelity": 1})
            one += [(int(x["t"]), float(x["p"])) for x in (r or {}).get("history") or []]
    return row["market_id"], pts, one


EXCH = {"0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e", "0xc5d563a36ae78145c45a50134d48a1215220f80a"}
GS_STATE = {"ok": os.environ.get("FILLS", "goldsky") == "goldsky", "fails": 0}


def fetch_fills(row):
    """Fills in the hour before game start for football/us_sports moneylines (Goldsky public subgraph)."""
    if not GS_STATE["ok"]:
        return row["market_id"], []
    gs = tsec(row["game_start"])
    toks = json.loads(row["token_ids"])
    out = []
    for side, tok in enumerate(toks[:2]):
        for fld in ("makerAssetId", "takerAssetId"):
            q = ('{ orderFilledEvents(first: 1000, orderBy: timestamp, where: {%s: "%s", timestamp_gte: "%d", timestamp_lte: "%d"}) '
                 '{ timestamp transactionHash maker taker makerAssetId takerAssetId makerAmountFilled takerAmountFilled } }') % (fld, tok, gs - 3600, gs)
            r = get(GOLDSKY, data=json.dumps({"query": q}).encode(), tries=3)
            if r is None:
                GS_STATE["fails"] += 1
                if GS_STATE["fails"] >= 8:
                    GS_STATE["ok"] = False
                    log("goldsky disabled for this run (repeated failures)")
                return row["market_id"], out
            for f in ((r.get("data") or {}).get("orderFilledEvents") or []):
                if (f.get("taker") or "").lower() in EXCH:
                    continue  # taker-order echo of a match; maker fills carry the trades
                ma, ta = int(f["makerAmountFilled"]), int(f["takerAmountFilled"])
                if fld == "makerAssetId":  # maker sold outcome tokens for USDC
                    sh, usd, mside = ma, ta, "sell"
                else:  # maker bought outcome tokens with USDC
                    sh, usd, mside = ta, ma, "buy"
                if sh <= 0:
                    continue
                out.append((int(f["timestamp"]), side, round(usd / sh, 4), round(sh / 1e6, 2), mside, f["transactionHash"]))
    return row["market_id"], out


def write_csv_gz(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
    with gzip.GzipFile(path, "wb", mtime=0) as f:
        f.write(buf.getvalue().encode())


def write_pq(path, cols):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    pq.write_table(pa.table(cols), path, compression="zstd")


def do_day(d, pool):
    evs = day_events(d)
    by, evrows, dropped = {}, {}, {}
    for ev in evs:
        fam, sub, ser = classify(ev)
        if not fam:
            continue
        evrows.setdefault(fam, []).append(event_row(d, fam, sub, ser, ev))
        for m in ev.get("markets") or []:
            if not m.get("closed"):
                continue
            r = market_row(d, fam, ev, m)
            if keep_market(fam, r):
                by.setdefault(fam, []).append(r)
            else:
                dropped[fam] = dropped.get(fam, 0) + 1
    stats = {}
    for fam, rows in by.items():
        base = f"{OUT}/pm/{fam}/{d.year}/{d}"
        write_csv_gz(base + ".events.csv.gz", evrows[fam])
        write_csv_gz(base + ".markets.csv.gz", rows)
        want = [r for r in rows if r["volume"] >= price_min_vol(fam)]
        P, O = {"market_id": [], "t": [], "p": []}, {"market_id": [], "t": [], "p": []}
        for mid, pts, one in pool.map(fetch_prices, want):
            mid = int(mid)
            for t, p in pts:
                P["market_id"].append(mid); P["t"].append(t); P["p"].append(p)
            for t, p in one:
                O["market_id"].append(mid); O["t"].append(t); O["p"].append(p)
        sch = lambda c: {"market_id": pa.array(c["market_id"], pa.int64()), "t": pa.array(c["t"], pa.int64()), "p": pa.array(c["p"], pa.float32())}
        if P["t"]:
            write_pq(base + ".prices.parquet", sch(P))
        if O["t"]:
            write_pq(base + ".prices1m.parquet", sch(O))
        nf = 0
        if fam in ("football", "us_sports", "esports"):
            fw = [r for r in want if r["smt"] in ("moneyline", "child_moneyline") and r["volume"] >= 5000 and tsec(r["game_start"])]
            F = {k: [] for k in ("market_id", "t", "outcome_idx", "price", "shares", "maker_side", "tx")}
            for mid, fills in pool.map(fetch_fills, fw):
                for t, side, px, sh, ms, tx in fills:
                    F["market_id"].append(int(mid)); F["t"].append(t); F["outcome_idx"].append(side); F["price"].append(px)
                    F["shares"].append(sh); F["maker_side"].append(ms); F["tx"].append(tx)
            if F["t"]:
                write_pq(base + ".fills.parquet", F)
            nf = len(F["t"])
        stats[fam] = {"markets": len(rows), "with_prices": len(want), "points": len(P["t"]), "points_1m": len(O["t"]), "fills": nf,
                      "events": len(evrows[fam]), "dropped_props": dropped.get(fam, 0)}
    return stats


def load_state():
    p = f"{OUT}/state.json"
    if os.path.exists(p):
        return json.load(open(p))
    return {"version": VERSION, "days": {}}


def save_state(s):
    os.makedirs(OUT, exist_ok=True)
    json.dump(s, open(f"{OUT}/state.json", "w"), indent=0, sort_keys=True)


def cmd_pm(a):
    st = load_state()
    t0 = time.time()
    today = datetime.now(timezone.utc).date()
    start = date.fromisoformat(a.start)
    last_commit = time.time()
    todo = []
    d = today - timedelta(days=2)
    while d >= start:
        rec = st["days"].get(str(d))
        if not rec:
            todo.append((d, "first"))
        elif rec.get("pass") == "first" and (today - d).days >= 8:
            todo.append((d, "final"))  # one re-pull a week later for late resolutions
        d -= timedelta(days=1)
    todo.sort(key=lambda x: (x[1] != "final", -x[0].toordinal()))
    todo = [x for x in todo if x[1] == "final"] + [x for x in todo if x[1] == "first"]
    log(f"pm: {len(todo)} days to do ({sum(1 for x in todo if x[1]=='final')} re-pulls)")
    with ThreadPoolExecutor(a.threads) as pool:
        for d, kind in todo:
            if time.time() - t0 > a.budget_min * 60:
                log("budget reached")
                break
            s = do_day(d, pool)
            st["days"][str(d)] = {"pass": "final" if kind == "final" or (today - d).days >= 8 else "first", "at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "stats": s}
            log(d, kind, " ".join(f"{k}:{v['markets']}/{v['with_prices']}/{v['fills']}" for k, v in sorted(s.items())), f"{time.time()-t0:.0f}s")
            save_state(st)
            if a.commit_cmd and time.time() - last_commit > a.commit_every * 60:
                subprocess.run(a.commit_cmd, shell=True)
                last_commit = time.time()
    write_coverage(st)


def write_coverage(st):
    agg = {}
    for d, rec in st["days"].items():
        for fam, s in (rec.get("stats") or {}).items():
            a = agg.setdefault(fam, {"markets": 0, "with_prices": 0, "events": 0, "fills": 0, "first": d, "last": d, "days": 0})
            a["markets"] += s["markets"]; a["with_prices"] += s["with_prices"]; a["events"] += s.get("events", 0); a["fills"] += s.get("fills", 0)
            a["first"] = min(a["first"], d); a["last"] = max(a["last"], d); a["days"] += 1
    done = sorted(st["days"])
    with open(f"{OUT}/COVERAGE.md", "w") as f:
        f.write(f"# Coverage (auto-written {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC)\n\n")
        f.write(f"Days done: {len(done)} ({done[0] if done else '-'} .. {done[-1] if done else '-'})\n\n")
        f.write("| family | events | markets | with price history | fills | first day | last day | days with data |\n|---|---|---|---|---|---|---|---|\n")
        for fam, a in sorted(agg.items(), key=lambda x: -x[1]["markets"]):
            f.write(f"| {fam} | {a['events']:,} | {a['markets']:,} | {a['with_prices']:,} | {a['fills']:,} | {a['first']} | {a['last']} | {a['days']} |\n")
    json.dump(agg, open(f"{OUT}/coverage.json", "w"), indent=1, sort_keys=True)


# ------------------------------------------------------------------ independent results
def save_raw(path, b):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.GzipFile(path, "wb", mtime=0) as f:
        f.write(b)


FD_MAIN = ["E0", "E1", "E2", "SC0", "SP1", "SP2", "D1", "D2", "I1", "I2", "F1", "F2", "N1", "P1", "T1", "B1", "G1"]
FD_NEW = ["ARG", "BRA", "MEX", "USA", "JPN", "CHN", "AUT", "DNK", "FIN", "IRL", "NOR", "POL", "ROU", "RUS", "SWE", "SWZ"]
YAHOO = {"SPX": "^GSPC", "SPY": "SPY", "NDX": "^NDX", "QQQ": "QQQ", "RUT": "^RUT", "DJI": "^DJI", "VIX": "^VIX", "GOLD": "GC=F", "SILVER": "SI=F",
         "WTI": "CL=F", "BRENT": "BZ=F", "NATGAS": "NG=F", "COPPER": "HG=F", "AAPL": "AAPL", "MSFT": "MSFT", "AMZN": "AMZN", "NVDA": "NVDA",
         "TSLA": "TSLA", "GOOGL": "GOOGL", "META": "META", "NFLX": "NFLX", "COIN": "COIN", "PLTR": "PLTR", "DXY": "DX-Y.NYB", "EURUSD": "EURUSD=X",
         "USDJPY": "JPY=X", "NIKKEI": "^N225", "DAX": "^GDAXI", "FTSE": "^FTSE", "HSI": "^HSI", "KOSPI": "^KS11", "TNX": "^TNX"}


def res_football(R):
    n = 0
    for season in ("2425", "2526", "2627"):
        for lg in FD_MAIN:
            b = get(f"https://www.football-data.co.uk/mmz4281/{season}/{lg}.csv", raw=True)
            if b and b[:3] in (b"\xef\xbb\xbf", b"Div"):
                save_raw(f"{R}/football/fdco/{season}/{lg}.csv.gz", b); n += 1
    for lg in FD_NEW:
        b = get(f"https://www.football-data.co.uk/new/{lg}.csv", raw=True)
        if b and len(b) > 200:
            save_raw(f"{R}/football/fdco/extra/{lg}.csv.gz", b); n += 1
    log("results football-data files:", n)


def res_nfl(R):
    b = get("https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv", raw=True)
    if not b:
        return
    lines = b.decode().splitlines()
    keep = [lines[0]] + [l for l in lines[1:] if l.split(",")[1] >= "2024"]
    save_raw(f"{R}/us_sports/nfl_games.csv.gz", ("\n".join(keep) + "\n").encode())
    log("results nfl games:", len(keep) - 1)


def res_nhl(R, start):
    p = f"{R}/us_sports/nhl_games.csv.gz"
    rows = {}
    if os.path.exists(p):
        for r in csv.DictReader(io.StringIO(gzip.decompress(open(p, "rb").read()).decode())):
            rows[r["game_id"]] = r
    have = {r["date"] for r in rows.values()}
    d, end = start, datetime.now(timezone.utc).date() - timedelta(days=1)
    while d <= end:
        if str(d) in have and (end - d).days > 3:
            d += timedelta(days=1); continue
        b = get(f"https://api-web.nhle.com/v1/score/{d}")
        for g in (b or {}).get("games") or []:
            if g.get("gameState") not in ("OFF", "FINAL"):
                continue
            rows[str(g["id"])] = {"game_id": g["id"], "date": str(d), "start_utc": g.get("startTimeUTC"), "game_type": g.get("gameType"),
                                  "away": g["awayTeam"].get("abbrev"), "home": g["homeTeam"].get("abbrev"), "away_score": g["awayTeam"].get("score"),
                                  "home_score": g["homeTeam"].get("score"), "last_period": (g.get("gameOutcome") or {}).get("lastPeriodType")}
        d += timedelta(days=1)
    if rows:
        write_csv_gz(p, sorted(rows.values(), key=lambda r: (r["date"], str(r["game_id"]))))
    log("results nhl games:", len(rows))


def res_mlb(R):
    out = []
    for yr in (2025, 2026):
        b = get("https://statsapi.mlb.com/api/v1/schedule", {"sportId": 1, "startDate": f"{yr}-02-15", "endDate": f"{yr}-11-30", "gameType": "S,R,F,D,L,W"})
        for dd in (b or {}).get("dates") or []:
            for g in dd.get("games") or []:
                if (g.get("status") or {}).get("abstractGameState") != "Final":
                    continue
                t = g.get("teams") or {}
                out.append({"game_pk": g.get("gamePk"), "date": dd.get("date"), "start_utc": g.get("gameDate"), "game_type": g.get("gameType"),
                            "away": t.get("away", {}).get("team", {}).get("name"), "home": t.get("home", {}).get("team", {}).get("name"),
                            "away_score": t.get("away", {}).get("score"), "home_score": t.get("home", {}).get("score"),
                            "status": (g.get("status") or {}).get("detailedState")})
    if out:
        write_csv_gz(f"{R}/us_sports/mlb_games.csv.gz", out)
    log("results mlb games:", len(out))


def res_markets(R):
    out = []
    for name, sym in YAHOO.items():
        b = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}", {"range": "3y", "interval": "1d"})
        try:
            r = b["chart"]["result"][0]
            q = r["indicators"]["quote"][0]
            tz = r["meta"].get("exchangeTimezoneName")
            for i, t in enumerate(r["timestamp"]):
                if q["close"][i] is None:
                    continue
                out.append({"name": name, "symbol": sym, "date": datetime.fromtimestamp(t + (r["meta"].get("gmtoffset") or 0), timezone.utc).date().isoformat(),
                            "open": q["open"][i], "high": q["high"][i], "low": q["low"][i], "close": q["close"][i], "volume": q["volume"][i], "exchange_tz": tz})
        except Exception as e:
            log("yahoo fail", name, e)
        time.sleep(0.5)
    if out:
        write_csv_gz(f"{R}/finance/daily_ohlc_yahoo.csv.gz", out)
    for sid in ("SP500", "DCOILWTICO", "DCOILBRENTEU", "DHHNGSP", "NASDAQCOM", "DJIA", "VIXCLS"):
        b = get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}", raw=True)
        if b:
            save_raw(f"{R}/finance/fred_{sid}.csv.gz", b)
    log("results finance rows:", len(out))


def res_temperature(R):
    """Raw METAR temperatures (IEM ASOS, UTC) for every station named in temperature markets, from first market day."""
    stations = {}
    for root, _, files in os.walk(f"{OUT}/pm"):
        if "/temperature/" not in root + "/" and "/weather_other/" not in root + "/":
            continue
        for fn in files:
            if fn.endswith(".markets.csv.gz"):
                for r in csv.DictReader(io.StringIO(gzip.decompress(open(os.path.join(root, fn), "rb").read()).decode())):
                    if r.get("station"):
                        s = stations.setdefault(r["station"], [r["day"], r["day"], r["series"]])
                        s[0], s[1] = min(s[0], r["day"]), max(s[1], r["day"])
    os.makedirs(f"{R}/temperature", exist_ok=True)
    json.dump(stations, open(f"{R}/temperature/stations.json", "w"), indent=1, sort_keys=True)
    n = 0
    for st, (d0, d1, ser) in sorted(stations.items()):
        p = f"{R}/temperature/metar_{st}.parquet"
        old = pq.read_table(p).to_pydict() if os.path.exists(p) else {"valid_utc": [], "tmpf": []}
        have_to = max(old["valid_utc"]) if old["valid_utc"] else ""
        a = date.fromisoformat(d0) - timedelta(days=2)
        if have_to:
            a = max(a, date.fromisoformat(have_to[:10]) - timedelta(days=1))
        b_ = date.fromisoformat(d1) + timedelta(days=2)
        b = get("https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py", {"station": st, "data": "tmpf", "year1": a.year, "month1": a.month, "day1": a.day,
                "year2": b_.year, "month2": b_.month, "day2": b_.day, "tz": "Etc/UTC", "format": "onlycomma", "latlon": "no", "missing": "M", "report_type": "3,4", "direct": "no"}, raw=True, tries=6, timeout=120)
        time.sleep(4)
        if not b:
            continue
        m = dict(zip(old["valid_utc"], old["tmpf"]))
        for r in csv.DictReader(io.StringIO(b.decode())):
            if r.get("tmpf") not in (None, "", "M"):
                m[r["valid"]] = float(r["tmpf"])
        ks = sorted(m)
        write_pq(p, {"valid_utc": pa.array(ks), "tmpf": pa.array([m[k] for k in ks], pa.float32())})
        n += 1
    b = get("https://data.weather.gov.hk/weatherAPI/opendata/opendata.php", {"dataType": "CLMMAXT", "rformat": "csv", "station": "HKO"}, raw=True)
    if b:
        save_raw(f"{R}/temperature/hko_daily_max.csv.gz", b)
    log("results temperature stations:", len(stations), "updated", n)


def cmd_results(a):
    R = f"{OUT}/results"
    start = date.fromisoformat(a.start)
    for f in (lambda: res_football(R), lambda: res_nfl(R), lambda: res_nhl(R, start), lambda: res_mlb(R), lambda: res_markets(R), lambda: res_temperature(R)):
        try:
            f()
        except Exception as e:
            log("results step failed:", repr(e))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["pm", "results"])
    ap.add_argument("--start", default="2025-01-01")
    ap.add_argument("--budget-min", type=float, default=240)
    ap.add_argument("--threads", type=int, default=12)
    ap.add_argument("--commit-cmd", default="")
    ap.add_argument("--commit-every", type=float, default=20)
    a = ap.parse_args()
    {"pm": cmd_pm, "results": cmd_results}[a.cmd](a)
