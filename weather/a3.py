import pickle, statistics as S, collections, math, datetime as dt, bisect, sys
from zoneinfo import ZoneInfo
rows = pickle.load(open("/tmp/wx_rows.pkl", "rb"))
exec(open("weather/a2.py").read().split("for k in")[0])  # actual()
rows.sort(key=lambda r: r["date"])
def Phi(x): return 0.5 * (1 + math.erf(x / math.sqrt(2)))
SNAP = [("D-1 12:00", -1, 12), ("D-1 20:00", -1, 20), ("D 08:00", 0, 8), ("D 11:00", 0, 11), ("D 14:00", 0, 14), ("D 17:00", 0, 17), ("D 20:00", 0, 20)]
def price_at(h, ts):
    if not h: return None
    i = bisect.bisect_right([x["t"] for x in h], ts) - 1
    if i < 0: return None
    if ts - h[i]["t"] > 6 * 3600: return None
    return h[i]["p"]
hist = collections.defaultdict(list)  # city -> list of (date, err_lead1, err_lead2) in unit C
recs = []
for r in rows:
    u = 1.8 if r["unit"] == "F" else 1
    tz = ZoneInfo(r["tz"]); d0 = dt.datetime.fromisoformat(r["date"]).replace(tzinfo=tz)
    past = [x for x in hist[r["city"]] if x[0] < r["date"]]
    allp = [x for c in hist for x in hist[c] if x[0] < r["date"]]
    if len(allp) >= 50 and r["f1"] is not None:
        for lead in (1, 2):
            g = [x[lead] for x in allp]; gb, gs = S.mean(g), S.pstdev(g)
            cv = [x[lead] for x in past]; n = len(cv)
            b = (sum(cv) + 5 * gb) / (n + 5)
            sd = math.sqrt((sum((v - b) ** 2 for v in cv) + 5 * gs ** 2) / (n + 5)) if n else gs
            r[f"mu{lead}"] = r[f"f{lead}"] + b * u; r[f"sd{lead}"] = max(sd, 0.5) * u
        for name, dd, hh in SNAP:
            T = d0 + dt.timedelta(days=dd, hours=hh); ts = T.timestamp()
            lead = 2 if dd < 0 else 1
            mu, sd = r[f"mu{lead}"], r[f"sd{lead}"]
            runmax = None
            if r["run"]:
                seen = [v for t, v in r["run"] if t <= ts - 600]  # obs published ~10 min after
                if seen: runmax = max(seen)
            ps = [price_at(b["h"], ts) for b in r["bk"]]
            if any(p is None for p in ps): continue
            qs = []
            for b in r["bk"]:
                lo, hi = b["lo"] - 0.5, b["hi"] + 0.5
                if runmax is not None and dd == 0:
                    rm = math.floor(runmax + 0.5) - 0.5  # rounded value can't go below rounded runmax
                    lo2 = max(lo, rm); den = 1 - Phi((rm - mu) / sd)
                    q = 0 if hi <= rm else (Phi((hi - mu) / sd) - Phi((lo2 - mu) / sd)) / max(den, 1e-6)
                    if den < 1e-4: q = 1.0 if lo <= rm < hi else 0.0
                else:
                    q = Phi((hi - mu) / sd) - Phi((lo - mu) / sd)
                qs.append(min(max(q, 0.002), 0.998))
            recs.append({"city": r["city"], "date": r["date"], "snap": name, "ps": ps, "qs": qs, "won": [b["won"] for b in r["bk"]],
                         "runmax": runmax, "obs": bool(r["run"]), "unit": r["unit"], "bk": [(b["lo"], b["hi"]) for b in r["bk"]]})
    hist[r["city"]].append((r["date"], (r["act"] - r["f1"]) / u, (r["act"] - r["f2"]) / u))
pickle.dump(recs, open("/tmp/wx_recs.pkl", "wb"))
print("snapshot records", len(recs))
# log loss of winning bucket
for name, _, _ in SNAP:
    R = [x for x in recs if x["snap"] == name]
    def ll(key):
        t = 0
        for x in R:
            v = x[key]; s = sum(v); i = x["won"].index(True); t += -math.log(max(v[i] / s, 1e-3))
        return t / len(R)
    blend = 0
    for x in R:
        s = sum(x["ps"]); i = x["won"].index(True)
        blend += -math.log(max(0.5 * x["ps"][i] / s + 0.5 * x["qs"][i] / sum(x["qs"]), 1e-3))
    print(f"{name}: n {len(R)}  logloss market {ll('ps'):.3f}  model {ll('qs'):.3f}  50/50 blend {blend/len(R):.3f}")
