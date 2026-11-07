#!/usr/bin/env python3
"""Backtest Jev (TypeSafe AI) as a second opinion on La Liga results.

For each La Liga match (2025-26 and 2026-27 so far) we build the pre-match facts
from football-data.co.uk results only (no odds, no result), ask Jev for
home/draw/away probabilities, and save them. Scoring against Polymarket and
Pinnacle happens in jev_score.py / the report.

Usage:  TYPESAFE_AI_API_KEY=... python3 survey/jev_backtest.py [max_calls]
Output: survey/out/jev_la_liga.json (resumable: already-answered matches are skipped)
Stdlib only. Research only; does not touch the trading bot.
"""
import csv, io, json, os, sys, time, urllib.request
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor

KEY = os.environ.get("TYPESAFE_AI_API_KEY", "").strip()
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "jev_la_liga.json")
MODEL = os.environ.get("JEV_MODEL", "jev-latest")
MAXC = int(sys.argv[1]) if len(sys.argv) > 1 else 1000

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "predbot-research/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8-sig", "replace")

def load():
    rows = []
    for season in ("2425", "2526", "2627"):
        txt = fetch(f"https://www.football-data.co.uk/mmz4281/{season}/SP1.csv")
        for r in csv.DictReader(io.StringIO(txt)):
            try:
                d = datetime.strptime(r["Date"], "%d/%m/%Y" if len(r["Date"]) == 10 else "%d/%m/%y")
                rows.append({"season": season, "date": d, "home": r["HomeTeam"], "away": r["AwayTeam"],
                             "hg": int(r["FTHG"]), "ag": int(r["FTAG"]), "ftr": r["FTR"]})
            except Exception:
                pass
    rows.sort(key=lambda x: x["date"])
    return rows

def facts(rows, i):
    m = rows[i]
    prior = [r for r in rows[:i] if r["date"] < m["date"]]
    season = [r for r in prior if r["season"] == m["season"]]

    def team(t, venue=None, last=None, pool=None):
        g = [r for r in (pool or season) if r["home"] == t or r["away"] == t]
        if venue == "home": g = [r for r in g if r["home"] == t]
        if venue == "away": g = [r for r in g if r["away"] == t]
        if last: g = g[-last:]
        pts = gf = ga = 0; form = ""
        for r in g:
            mine, theirs = (r["hg"], r["ag"]) if r["home"] == t else (r["ag"], r["hg"])
            gf += mine; ga += theirs
            res = "W" if mine > theirs else "D" if mine == theirs else "L"
            pts += {"W": 3, "D": 1, "L": 0}[res]; form += res
        n = len(g)
        return {"played": n, "points": pts, "goals_for": gf, "goals_against": ga, "form_oldest_to_newest": form,
                "points_per_game": round(pts / n, 2) if n else None}

    table = {}
    for r in season:
        for t in (r["home"], r["away"]):
            table.setdefault(t, team(t)["points"])
    order = sorted(table, key=lambda t: -table[t])
    pos = lambda t: order.index(t) + 1 if t in order else None
    prev = [r for r in prior if r["season"] != m["season"]][-380:]
    def last_season(t):
        x = team(t, pool=prev)
        return {"points_per_game": x["points_per_game"], "goal_difference": x["goals_for"] - x["goals_against"]} if x["played"] else "not in La Liga last season"

    return {
        "competition": "Spanish La Liga (top division), full-time result incl. stoppage time, no extra time",
        "date": m["date"].strftime("%Y-%m-%d"),
        "home_team": m["home"], "away_team": m["away"],
        "home_team_this_season": {**team(m["home"]), "table_position": pos(m["home"])},
        "away_team_this_season": {**team(m["away"]), "table_position": pos(m["away"])},
        "home_team_last5": team(m["home"], last=5), "away_team_last5": team(m["away"], last=5),
        "home_team_at_home_this_season": team(m["home"], venue="home"),
        "away_team_away_this_season": team(m["away"], venue="away"),
        "home_team_last_season": last_season(m["home"]), "away_team_last_season": last_season(m["away"]),
        "league_base_rates": "La Liga long-run: home win ~45%, draw ~26%, away win ~29%",
    }

QUESTIONS = {
    "result": {
        "type": "choice",
        "instructions": "Predict the full-time result of this football match. Give calibrated probabilities.",
        "criteria": {"home": "The home team wins", "draw": "The match ends in a draw", "away": "The away team wins"},
    }
}

def ask(state):
    body = json.dumps({"model": MODEL, "state": state, "questions": QUESTIONS}).encode()
    for i in range(4):
        try:
            req = urllib.request.Request("https://api.typesafe.ai/v1/systemone", data=body, method="POST",
                                         headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            msg = e.read()[:300]
            if e.code in (400, 401, 403): return {"error": e.code, "msg": msg.decode("utf-8", "replace")}
            time.sleep(2 * (i + 1))
        except Exception as e:
            time.sleep(2 * (i + 1))
    return {"error": "fail"}

def main():
    if not KEY: sys.exit("set TYPESAFE_AI_API_KEY")
    rows = load()
    done = {}
    if os.path.exists(OUT):
        for r in json.load(open(OUT)): done[(r["date"], r["home"], r["away"])] = r
    todo = []
    for i, m in enumerate(rows):
        if m["season"] == "2425": continue          # used only as "last season" history
        k = (m["date"].strftime("%Y-%m-%d"), m["home"], m["away"])
        if k in done and "p" in done[k]: continue
        todo.append((i, m, k))
    todo = todo[:MAXC]
    print(f"{len(rows)} matches loaded, {len(done)} cached, asking Jev for {len(todo)} ({MODEL})")
    first = ask(facts(rows, todo[0][0])) if todo else None
    print("first response:", json.dumps(first)[:800])
    if not first or "error" in first: sys.exit(1)

    def one(t):
        i, m, k = t
        st = facts(rows, i)
        a = first if t is todo[0] else ask(st)
        rec = {"date": k[0], "home": k[1], "away": k[2], "ftr": m["ftr"], "model": (a or {}).get("model")}
        try:
            pr = a["answers"]["result"]["probabilities"]
            rec["p"] = {"H": pr["home"], "D": pr["draw"], "A": pr["away"]}
            rec["confidence"] = a["answers"]["result"].get("confidence")
            rec["usage"] = a.get("usage")
        except Exception:
            rec["err"] = str(a)[:300]
        return rec
    with ThreadPoolExecutor(6) as ex:
        res = list(ex.map(one, todo))
    for r in res: done[(r["date"], r["home"], r["away"])] = r
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(sorted(done.values(), key=lambda r: r["date"]), open(OUT, "w"), indent=0)
    ok = [r for r in done.values() if "p" in r]
    import math
    ll = -sum(math.log(max(1e-4, r["p"][r["ftr"]])) for r in ok) / max(1, len(ok))
    hit = sum(1 for r in ok if max(r["p"], key=r["p"].get) == r["ftr"]) / max(1, len(ok))
    tok = sum((r.get("usage") or {}).get("input_tokens", 0) for r in res)
    print(f"answered {len(ok)}; log loss {ll:.4f} (always-base-rate ≈1.06); top pick right {100*hit:.1f}%; input tokens this run {tok}")
    print(f"saved {OUT}")

if __name__ == "__main__":
    main()
