import pickle, collections, math, datetime as dt, bisect
from zoneinfo import ZoneInfo
rows = pickle.load(open("/tmp/wx_rows.pkl", "rb"))
FEE = 0.05
def cost(p, slip): return p + slip + FEE * p * (1 - p)
def price_at(h, ts):
    if not h: return None
    i = bisect.bisect_right([x["t"] for x in h], ts) - 1
    if i < 0 or ts - h[i]["t"] > 3 * 3600: return None
    return h[i]["p"]
dates = sorted({r["date"] for r in rows}); mid = dates[len(dates)//2]
print("favourite bucket (highest price) at local hour H, buy YES if price in band; slip 1c / 2c")
for hh in (8, 10, 11, 12, 13, 14, 15, 16):
    for lo, hi in ((0.5, 0.7), (0.7, 0.85), (0.85, 0.93), (0.5, 0.93), (0.6, 0.9)):
        T = []
        for r in rows:
            tz = ZoneInfo(r["tz"]); ts = (dt.datetime.fromisoformat(r["date"]).replace(tzinfo=tz) + dt.timedelta(hours=hh)).timestamp()
            ps = [price_at(b["h"], ts) for b in r["bk"]]
            if any(p is None for p in ps): continue
            i = max(range(len(ps)), key=lambda k: ps[k]); p = ps[i]
            if lo <= p < hi: T.append((r["date"], p, r["bk"][i]["won"], r["city"]))
        if len(T) < 40: continue
        n = len(T); w = sum(t[2] for t in T) / n
        for slip in (0.02, 0.03):
            pnl = [t[2] - cost(t[1], slip) for t in T]
            h1 = [x for t, x in zip(T, pnl) if t[0] < mid]; h2 = [x for t, x in zip(T, pnl) if t[0] >= mid]
            days = collections.defaultdict(float)
            for t, x in zip(T, pnl): days[t[0]] += x
            red = sum(v < 0 for v in days.values())
            if slip == 0.02: s1 = f"{sum(pnl)/n:+.3f} [{sum(h1)/len(h1):+.3f} {sum(h2)/len(h2):+.3f}] red {red}/{len(days)}"
            else: s2 = f"{sum(pnl)/n:+.3f}"
        print(f"H{hh:02d} {lo}-{hi}: n {n} ({n/43:.1f}/day) won {w*100:.1f}% avgpx {sum(t[1] for t in T)/n:.3f}  net2c {s1}  net3c {s2}")
