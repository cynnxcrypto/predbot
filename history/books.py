#!/usr/bin/env python3
"""Order-book snapshots (fillability check): daily index/commodity series during US hours, and every game moneyline/total/spread
starting within the next 95 minutes.
Writes OUT/books/<YYYY-MM-DD>/<HHMM>.json.gz: {"t": unix, "markets": [{series, event_slug, market_id, question, group_item,
token_ids, outcomes, books: [{bids:[[p,size]..], asks:[[p,size]..], ts}] (top 5 levels per token)}]}."""
import gzip, json, os, sys, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from collect import get, jl, tsec, GAMMA, CLOB, OUT

SERIES = ["spx-daily-up-or-down", "spy-daily-close-uo", "wti-daily-close-uo", "oil-daily-up-or-down", "gold-daily-up-or-down",
          "dow-jones-daily-up-or-down", "russell-2000-daily-up-or-down", "spy-open-daily-up-or-down", "ndx-daily-up-or-down",
          "natural-gas-daily-up-or-down"]


GAME_TAGS = ["games"]
MAIN = {"moneyline", "totals", "spreads", "child_moneyline"}


def soon_games(now):
    """Open game markets (moneyline/totals/spreads) whose game starts within the next 95 minutes or started <5 min ago."""
    out, seen = [], set()
    a = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 3600))
    b = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 10 * 3600))
    for off in range(0, 3000, 100):
        r = get(GAMMA + "/events", {"tag_slug": "games", "closed": "false", "end_date_min": a, "end_date_max": b, "limit": 100, "offset": off})
        if not r:
            break
        for e in r:
            if e.get("id") in seen:
                continue
            seen.add(e.get("id"))
            fam = "esports" if any(t.get("slug") == "esports" for t in e.get("tags") or []) else ("football" if any(t.get("slug") == "soccer" for t in e.get("tags") or []) else "games")
            for m in e.get("markets") or []:
                gs = tsec(m.get("gameStartTime"))
                if not gs or not (now - 300 <= gs <= now + 95 * 60) or m.get("closed") or m.get("sportsMarketType") not in MAIN:
                    continue
                if float(m.get("volumeNum") or 0) < 1000 and m.get("sportsMarketType") != "moneyline":
                    continue
                out.append({"series": e.get("seriesSlug") or fam, "family": fam, "event_slug": e.get("slug"), "end": e.get("endDate"),
                            "game_start": m.get("gameStartTime"), "market_id": m.get("id"), "smt": m.get("sportsMarketType"),
                            "question": m.get("question"), "group_item": m.get("groupItemTitle") or "",
                            "token_ids": jl(m.get("clobTokenIds"), []), "outcomes": jl(m.get("outcomes"), [])})
        if len(r) < 100:
            break
    return out


def open_markets():
    out = []
    for s in SERIES:
        b = get(GAMMA + "/events", {"series_slug": s, "closed": "false", "active": "true", "limit": 20})
        for e in b or []:
            for m in e.get("markets") or []:
                if m.get("closed") or not m.get("acceptingOrders", True):
                    continue
                out.append({"series": s, "event_slug": e.get("slug"), "end": e.get("endDate"), "market_id": m.get("id"),
                            "question": m.get("question"), "group_item": m.get("groupItemTitle") or "",
                            "token_ids": jl(m.get("clobTokenIds"), []), "outcomes": jl(m.get("outcomes"), [])})
    return out


def book(tok):
    b = get(CLOB + "/book", {"token_id": tok}, tries=3) or {}
    lv = lambda xs, rev: [[float(x["price"]), float(x["size"])] for x in sorted(xs or [], key=lambda x: float(x["price"]), reverse=rev)[:5]]
    return {"bids": lv(b.get("bids"), True), "asks": lv(b.get("asks"), False), "ts": b.get("timestamp")}


if __name__ == "__main__":
    t = int(time.time())
    wd, hr = time.gmtime(t).tm_wday, time.gmtime(t).tm_hour
    ms = open_markets() if wd < 5 and 13 <= hr <= 21 else []
    ms += soon_games(t)
    with ThreadPoolExecutor(8) as p:
        for m in ms:
            m["books"] = list(p.map(book, m["token_ids"]))
    d = datetime.fromtimestamp(t, timezone.utc)
    path = f"{OUT}/books/{d:%Y-%m-%d}/{d:%H%M}.json.gz"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, "wt") as f:
        json.dump({"t": t, "markets": ms}, f, separators=(",", ":"))
    print("books", len(ms), "markets ->", path)
