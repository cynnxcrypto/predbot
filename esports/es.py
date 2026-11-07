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
