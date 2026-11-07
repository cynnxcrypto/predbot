import pickle, collections, datetime as dt, bisect
from zoneinfo import ZoneInfo
rows = pickle.load(open("/tmp/wx_rows.pkl", "rb"))
def cost(p, slip=0.01): return p + slip + 0.05 * p * (1 - p)
def price_at(h, ts):
    if not h: return None
    i = bisect.bisect_right([x["t"] for x in h], ts) - 1
    if i < 0 or ts - h[i]["t"] > 3 * 3600: return None
    return h[i]["p"]
T = []
for r in rows:
    tz = ZoneInfo(r["tz"]); ts = (dt.datetime.fromisoformat(r["date"]).replace(tzinfo=tz) + dt.timedelta(hours=15)).timestamp()
    ps = [price_at(b["h"], ts) for b in r["bk"]]
    if any(p is None for p in ps): continue
    i = max(range(len(ps)), key=lambda k: ps[k]); p = ps[i]
    if 0.5 <= p < 0.93: T.append((r, p, r["bk"][i]["won"], i, ps))
byc = collections.defaultdict(list)
for r, p, w, i, ps in T: byc[r["city"]].append(w - cost(p))
pos = sum(1 for v in byc.values() if sum(v) > 0)
print("cities positive", pos, "of", len(byc))
for c, v in sorted(byc.items(), key=lambda kv: sum(kv[1])): print(f"  {c:16s} n {len(v):3d} net/sh {sum(v)/len(v):+.3f}")
# where does the loss go when favourite fails: adjacent above or below?
adj = collections.Counter()
for r, p, w, i, ps in T:
    if w: continue
    j = next(k for k, b in enumerate(r["bk"]) if b["won"]); adj["higher" if j > i else "lower"] += 1
print("favourite lost -> winner was", adj)
# weekly
wk = collections.defaultdict(list)
for r, p, w, i, ps in T: wk[dt.date.fromisoformat(r["date"]).isocalendar()[1]].append(w - cost(p))
print("by ISO week:", {k: (len(v), round(sum(v)/len(v), 3)) for k, v in sorted(wk.items())})
