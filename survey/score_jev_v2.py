"""Score Jev v2 answers against results and Polymarket 10-min prices.
usage: python survey/score_jev_v2.py survey/out/jev_states_v2.json jev_answers_v2.json
answers file: {"<index or home|away|date>": {"result": {"probabilities"/"choice"...}, "value": {...}}} or a list aligned to matches."""
import json, math, sys
from collections import defaultdict
S = json.load(open(sys.argv[1]))["matches"]
A = json.load(open(sys.argv[2]))
def key(m): return f'{m["date"]}|{m["home"]}|{m["away"]}'
def ans(i, m):
    if isinstance(A, list): return A[i] if i < len(A) else None
    return A.get(str(i)) or A.get(key(m))
def probs(q):
    if not q: return None
    p = q.get("probabilities") or q.get("answers") or q
    try: v = [float(p[k]) for k in ("home", "draw", "away")]
    except Exception: return None
    t = sum(v); return [x / t for x in v] if t > 0 else None
def pick(q):
    if not q: return None
    if q.get("choice"): return q["choice"]
    p = q.get("probabilities") or {}
    return max(p, key=lambda k: float(p[k])) if p else None
FEE = 0.05
def pnl(price, won):  # 1 share at price + 1c slip + taker fee
    px = min(price + 0.01, 0.99); return (1.0 if won else 0.0) - px - FEE * px * (1 - px)
idx = {"home": 0, "draw": 1, "away": 2}; res = {"H": 0, "D": 1, "A": 2}
L = defaultdict(lambda: {"n": 0, "jev": 0.0, "pm": 0.0, "blend": 0.0})
V = defaultdict(lambda: {"n": 0, "won": 0, "pnl": 0.0})
E = defaultdict(lambda: {"n": 0, "won": 0, "pnl": 0.0})
for i, m in enumerate(S):
    a = ans(i, m); r = res.get(m.get("ftr"))
    if a is None or r is None: continue
    pm = [m["pm"]["H"], m["pm"]["D"], m["pm"]["A"]]; t = sum(pm); pmn = [x / t for x in pm]
    pj = probs(a.get("result"))
    hasnews = isinstance(m["state"].get("news_headlines_published_before_kickoff"), list)
    for g in (m["lg"], "ALL", "news" if hasnews else "no-news"):
        if pj:
            b = [0.8 * x + 0.2 * y for x, y in zip(pmn, pj)]
            L[g]["n"] += 1; L[g]["jev"] -= math.log(max(pj[r], 1e-6)); L[g]["pm"] -= math.log(max(pmn[r], 1e-6)); L[g]["blend"] -= math.log(max(b[r], 1e-6))
    v = pick(a.get("value"))
    if v in idx:
        k = idx[v]; won = k == r; p = pnl(pm[k], won)
        for g in (m["lg"], "ALL", f"side {v}"):
            V[g]["n"] += 1; V[g]["won"] += won; V[g]["pnl"] += p
    if pj:
        for k in range(3):
            if pj[k] - pmn[k] >= 0.05:
                won = k == r; p = pnl(pm[k], won)
                for g in (m["lg"], "ALL"):
                    E[g]["n"] += 1; E[g]["won"] += won; E[g]["pnl"] += p
print("## log loss per match (lower = sharper): Jev | Polymarket | 80/20 blend")
for g, x in sorted(L.items()):
    n = x["n"]; print(f"  {g:8s} n={n:5d}  jev {x['jev']/n:.4f}  pm {x['pm']/n:.4f}  blend {x['blend']/n:.4f}")
print("## Jev 'value' picks, taker at 10-min price +1c +fee")
for g, x in sorted(V.items()):
    n = x["n"]; print(f"  {g:10s} n={n:5d} won {x['won']/n:.0%} {100*x['pnl']/n:+.2f}c/share")
print("## Jev prob >= PM + 5 pts, taker")
for g, x in sorted(E.items()):
    n = x["n"]; print(f"  {g:8s} n={n:5d} won {x['won']/n:.0%} {100*x['pnl']/n:+.2f}c/share")
