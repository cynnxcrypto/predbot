"""Tennis research pulls (runs on a GitHub runner). Research only; no bot/server changes.
1) tennis-data.co.uk ATP/WTA results + Pinnacle/avg closing odds, 2024-2026.
2) Live Polymarket tennis order books (spread / depth snapshot).
"""
import json, os, time, urllib.request, sys
OUT = "tennis/out"; os.makedirs(OUT, exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0 (research)"}
def get(url, t=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=t) as r: return r.read()
log = []
for yr in (2024, 2025, 2026):
    for tour, path in (("atp", f"{yr}/{yr}.xlsx"), ("wta", f"{yr}w/{yr}.xlsx")):
        for base in ("http://www.tennis-data.co.uk/", "https://www.tennis-data.co.uk/"):
            try:
                b = get(base + path); open(f"{OUT}/{tour}{yr}.xlsx", "wb").write(b)
                log.append(f"ok {tour}{yr} {len(b)}"); break
            except Exception as e: log.append(f"fail {base}{path} {e}")
# live books
try:
    evs = []
    for off in range(0, 1000, 100):
        j = json.loads(get(f"https://gamma-api.polymarket.com/events?tag_slug=tennis&active=true&closed=false&limit=100&offset={off}"))
        if not j: break
        evs += j
    rows = []
    for e in evs:
        for m in e.get("markets", []):
            if m.get("sportsMarketType") != "moneyline" or not m.get("clobTokenIds"): continue
            toks = json.loads(m["clobTokenIds"])
            for i, tk in enumerate(toks):
                try:
                    bk = json.loads(get(f"https://clob.polymarket.com/book?token_id={tk}", 20))
                except Exception as ex: continue
                rows.append({"slug": e.get("slug"), "title": e.get("title"), "start": m.get("gameStartTime"),
                             "vol": m.get("volumeNum"), "i": i, "bids": bk.get("bids", [])[-8:], "asks": bk.get("asks", [])[-8:]})
                time.sleep(0.05)
    json.dump({"t": time.time(), "rows": rows}, open(f"{OUT}/books_{int(time.time())}.json", "w"))
    log.append(f"books {len(evs)} events {len(rows)} tokens")
except Exception as e: log.append(f"books fail {e}")
open(f"{OUT}/fetch.log", "w").write("\n".join(log)); print("\n".join(log))
