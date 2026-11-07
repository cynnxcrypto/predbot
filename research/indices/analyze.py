#!/usr/bin/env python3
"""Daily up/down: Polymarket price vs vol-model fair value, by hours before close."""
import json, gzip, math, bisect, collections, statistics as st, sys, re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
ET = ZoneInfo("America/New_York")
D = "/home/claude/predbot/research/indices/out/"
ev = json.load(gzip.open(D + "events.json.gz", "rt"))
H = json.load(gzip.open(D + "hist.json.gz", "rt"))
U = json.load(gzip.open(D + "underlying.json.gz", "rt"))
# series -> (futures proxy, close hour ET, close minute)
SER = {"spx-daily-up-or-down": ("ES=F", 16, 0), "spy-daily-up-or-down": ("ES=F", 16, 0), "ndx-daily-up-or-down": ("NQ=F", 16, 0),
       "dow-jones-daily-up-or-down": ("YM=F", 16, 0), "russell-2000-daily-up-or-down": ("RTY=F", 16, 0),
       "gold-daily-up-or-down": ("GC=F", 17, 0), "silver-daily-up-or-down": ("SI=F", 17, 0),
       "oil-daily-up-or-down": ("CL=F", 14, 30), "natural-gas-daily-up-or-down": ("NG=F", 14, 30)}
# NB oil: ICE WTI 'close' per rules = final minute of regular hours; checked both 14:30 and 18:00 below via env
if len(sys.argv) > 1 and sys.argv[1] == "oil18": SER["oil-daily-up-or-down"] = ("CL=F", 18, 0)
def series_px(sym):
    rows = {}
    for iv, sec in (("1h", 3600), ("5m", 300), ("1m", 60)):
        o = U.get(sym, {}).get(iv)
        if not o: continue
        for r in o["rows"]:
            if r[4] is not None: rows[r[0] + sec] = r[4]  # time the bar CLOSES
    ks = sorted(rows); return ks, [rows[k] for k in ks]
PX = {s: series_px(s) for s in set(v[0] for v in SER.values())}
def px(sym, t, maxage=3 * 3600):
    ks, vs = PX[sym]; i = bisect.bisect_right(ks, t) - 1
    if i < 0 or t - ks[i] > maxage: return None
    return vs[i]
# hourly log returns for vol: per symbol, list of (t, r) on 1h bars
def hourly(sym):
    o = U[sym]["1h"]["rows"]; out = []
    for a, b in zip(o, o[1:]):
        if a[4] and b[4] and b[0] - a[0] == 3600: out.append((b[0] + 3600, math.log(b[4] / a[4])))
    return out
HR = {s: hourly(s) for s in PX}
HRT = {s: [x[0] for x in HR[s]] for s in PX}
def rem_var(sym, t, C):
    """expected variance from t to C: avg squared hourly return over trailing 20 days for each hour-of-day in (t, C]"""
    ts, rs = HRT[sym], HR[sym]
    lo = bisect.bisect_left(ts, t - 20 * 86400); hi = bisect.bisect_left(ts, t)
    prof = collections.defaultdict(list)
    for tt, r in rs[lo:hi]:
        prof[datetime.fromtimestamp(tt, ET).hour].append(r * r)
    v = 0.0; x = t
    while x < C:
        step = min(3600 - (x % 3600), C - x)
        h = datetime.fromtimestamp(x + step - 1, ET).hour
        l = prof.get(h)
        v += (st.mean(l) if l else 0) * step / 3600
        x += step
    return v
def Phi(z): return 0.5 * (1 + math.erf(z / math.sqrt(2)))
def pm_at(h, t, maxage=1800):
    ks = [x[0] for x in h]; i = bisect.bisect_right(ks, t) - 1
    if i < 0 or t - ks[i] > maxage: return None
    return h[i][1]
MON = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"], 1)}
CK = [20, 16, 12, 8, 6.5, 5, 4, 3, 2, 1.5, 1, 0.5, 0.25, 0.083]
rows = []
for e in ev:
    s = (e["series"] or ["-"])[0]
    if s not in SER or not e["closed"]: continue
    m = e["markets"][0]; op = json.loads(m["outcomePrices"] or "[]")
    if not op or op[0] not in ("1", "0"): continue
    up = op[0] == "1"
    mm = re.search(r"on (\w+) (\d+)", e["title"]);
    if not mm or mm.group(1).lower() not in MON: continue
    end = datetime.fromisoformat(m["endDate"].replace("Z", "+00:00"))
    sym, ch, cm = SER[s]
    C = datetime(end.year, MON[mm.group(1).lower()], int(mm.group(2)), ch, cm, tzinfo=ET)
    if C > end + timedelta(days=2): C = C.replace(year=C.year - 1)
    C = int(C.timestamp())
    # reference: futures at previous trading day's close time
    ref = None
    for k in range(1, 6):
        R = C - k * 86400
        if datetime.fromtimestamp(R, ET).weekday() < 5:
            ref = px(sym, R, maxage=900)
            if ref: break
    h = H.get(m["id"]) or []
    fut_close = px(sym, C, maxage=900)
    for ckh in CK:
        t = int(C - ckh * 3600)
        p = pm_at(h, t)
        f = px(sym, t, maxage=900)
        fair = None
        if ref and f:
            v = rem_var(sym, t, C)
            if v > 0: fair = Phi(math.log(f / ref) / math.sqrt(v))
        rows.append({"mid": m["id"], "t": t, "s": s, "C": C, "ck": ckh, "pm": p, "fair": fair, "up": up, "vol": m["volumeNum"],
                     "futok": (fut_close > ref) == up if (ref and fut_close) else None})
json.dump(rows, open(D + "../rows.json", "w"))
def ll(p, y): p = min(max(p, 0.01), 0.99); return -math.log(p if y else 1 - p)
print("series | events | futures-proxy agrees w/ outcome")
g = collections.defaultdict(list)
for r in rows:
    if r["ck"] == 1: g[r["s"]].append(r)
for s, l in g.items():
    fo = [r["futok"] for r in l if r["futok"] is not None]
    print(f"{s:32s} {len(l):4d}  proxy agree {sum(fo)}/{len(fo)}  up-rate {sum(r['up'] for r in l)/len(l):.2f}")
print("\nck(h) series: n | logloss PM vs fair | mean|PM-fair| | buy side where fair-PM>=X")
for s in SER:
    for ck in CK:
        l = [r for r in rows if r["s"] == s and r["ck"] == ck and r["pm"] is not None and r["fair"] is not None]
        if len(l) < 20: continue
        a = st.mean(ll(r["pm"], r["up"]) for r in l); b = st.mean(ll(r["fair"], r["up"]) for r in l)
        gap = st.mean(abs(r["pm"] - r["fair"]) for r in l)
        out = []
        for X in (0.05, 0.10, 0.15):
            pnl = []
            for r in l:
                d = r["fair"] - r["pm"]
                if d >= X: pnl.append((1 if r["up"] else 0) - r["pm"])
                elif d <= -X: pnl.append((0 if r["up"] else 1) - (1 - r["pm"]))
            out.append(f"{X:.2f}:{len(pnl)} {100*st.mean(pnl):+.1f}c" if pnl else f"{X:.2f}:0")
        print(f"{ck:5} {s:30s} n{len(l):4d} LL pm {a:.3f} fair {b:.3f} |gap| {100*gap:4.1f}c  " + "  ".join(out))
