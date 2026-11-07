#!/usr/bin/env python3
"""Order-book snapshots of open non-crypto Polymarket series (fillability check for thin markets).
Writes OUT/books/<YYYY-MM-DD>/<HHMM>.json.gz: {"t": unix, "markets": [{series, event_slug, market_id, question, group_item,
token_ids, outcomes, books: [{bids:[[p,size]..], asks:[[p,size]..], ts}] (top 10 levels per token)}]}."""
import gzip, json, os, sys, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from collect import get, jl, GAMMA, CLOB, OUT

SERIES = ["spx-daily-up-or-down", "spy-daily-close-uo", "wti-daily-close-uo", "oil-daily-up-or-down", "gold-daily-up-or-down",
          "dow-jones-daily-up-or-down", "russell-2000-daily-up-or-down", "spy-open-daily-up-or-down", "ndx-daily-up-or-down",
          "natural-gas-daily-up-or-down"]


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
    lv = lambda xs, rev: [[float(x["price"]), float(x["size"])] for x in sorted(xs or [], key=lambda x: float(x["price"]), reverse=rev)[:10]]
    return {"bids": lv(b.get("bids"), True), "asks": lv(b.get("asks"), False), "ts": b.get("timestamp")}


if __name__ == "__main__":
    t = int(time.time())
    ms = open_markets()
    with ThreadPoolExecutor(8) as p:
        for m in ms:
            m["books"] = list(p.map(book, m["token_ids"]))
    d = datetime.fromtimestamp(t, timezone.utc)
    path = f"{OUT}/books/{d:%Y-%m-%d}/{d:%H%M}.json.gz"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, "wt") as f:
        json.dump({"t": t, "markets": ms}, f, separators=(",", ":"))
    print("books", len(ms), "markets ->", path)
