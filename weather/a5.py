import pickle, collections, math, datetime as dt, bisect
from zoneinfo import ZoneInfo
rows = pickle.load(open("/tmp/wx_rows.pkl", "rb"))
FEE = 0.05; SLIP = 0.01
def cost(p, slip=SLIP): return p + slip + FEE * p * (1 - p)
def price_at(h, ts):
    if not h: return None
    i = bisect.bisect_right([x["t"] for x in h], ts) - 1
    if i < 0 or ts - h[i]["t"] > 3 * 3600: return None
    return h[i]["p"]
rnd = lambda x: math.floor(x + 0.5)
dates = sorted({r["date"] for r in rows}); mid = dates[len(dates)//2]
def run(drop, hours, pmin, pmax, slip=SLIP, verbose=False):
    T = []; dead = []
    for r in rows:
        if not r["run"]: continue
        tz = ZoneInfo(r["tz"]); d0 = dt.datetime.fromisoformat(r["date"]).replace(tzinfo=tz)
        for hh in hours:
            ts = (d0 + dt.timedelta(hours=hh)).timestamp()
            seen = [(t, v) for t, v in r["run"] if t <= ts - 900]
            if len(seen) < 6: continue
            rm = max(v for _, v in seen); last = seen[-1][1]
            if rm - last < drop: continue
            b = next((b for b in r["bk"] if b["lo"] <= rnd(rm) <= b["hi"]), None)
            if not b: continue
            p = price_at(b["h"], ts)
            if p is None or not (pmin <= p <= pmax): continue
            T.append((r["date"], r["city"], hh, p, b["won"], rm - last))
            break
    if not T: return None
    n = len(T); w = sum(t[4] for t in T); pnl = [t[4] - cost(t[3], slip) for t in T]
    h1 = [x for t, x in zip(T, pnl) if t[0] < mid]; h2 = [x for t, x in zip(T, pnl) if t[0] >= mid]
    days = collections.defaultdict(float)
    for t, x in zip(T, pnl): days[t[0]] += x
    red = sum(1 for v in days.values() if v < 0)
    return n, w / n, sum(pnl) / n, sum(h1) / max(len(h1), 1), sum(h2) / max(len(h2), 1), red, len(days), sum(t[3] for t in T) / n
print("locked-bucket rule: running max bucket, temp already fell by >= drop, take YES if price in band")
for drop in (0.5, 1.0, 1.5, 2.0, 3.0):
    for hours in ((13, 14, 15, 16, 17, 18), (15, 16, 17, 18), (17, 18, 19)):
        for pmin, pmax in ((0.5, 0.9), (0.5, 0.95), (0.7, 0.95), (0.3, 0.97)):
            res = run(drop, hours, pmin, pmax)
            if res and res[0] >= 40:
                n, wr, pps, a, b, red, nd, ap = res
                print(f"drop {drop} hrs {hours[0]}-{hours[-1]} px {pmin}-{pmax}: n {n} won {wr*100:.1f}% avg px {ap:.3f} net {pps:+.3f}/sh  halves {a:+.3f} {b:+.3f}  red days {red}/{nd}")
