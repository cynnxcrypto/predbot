"""Weather thesis analysis: loads weather/out/*.json.gz, builds per-event table."""
import json, gzip, re, collections, math, datetime as dt, sys, pickle
from zoneinfo import ZoneInfo
D = sys.argv[1] if len(sys.argv) > 1 else "weather/out"
L = lambda n: json.load(gzip.open(f"{D}/{n}.json.gz", "rt"))
ev, pr, ob, fc = L("wx_events"), L("wx_prices"), L("wx_obs"), L("wx_fc")
MON = {m: i+1 for i, m in enumerate("january february march april may june july august september october november december".split())}
def city(e): return e["title"].split(" in ", 1)[1].rsplit(" on ", 1)[0]
st_of = {}
for e in ev:
    if e["station"] and e["title"].startswith("Highest"): st_of[city(e)] = e["station"]
def bounds(q):
    unit = "F" if "°F" in q else "C"
    n = [int(x) for x in re.findall(r"-?\d+", q.replace("°", " "))]
    if "-" in q and unit == "F" and len(n) == 2 and "below" not in q: lo, hi = n[0], abs(n[1])
    else:
        v = n[0]; lo = hi = v
        if "below" in q: lo = -999
        if "higher" in q: hi = 999
    return unit, lo, hi
def fcmax(st, date, key):
    out = []
    for model, r in (fc.get(st) or {}).items():
        if not isinstance(r, dict) or "hourly" not in r: continue
        h = r["hourly"]; vals = [v for t, v in zip(h["time"], h[key]) if t.startswith(date) and v is not None]
        if len(vals) >= 20: out.append(max(vals))
    return sum(out)/len(out) if out else None, out
tz_of = {st: (r.get("best_match") or {}).get("timezone") for st, r in fc.items() if r}
def obs_series(st):
    t = ob.get(st)
    if not t or len(t) < 1000: return None
    rows = []
    for line in t.splitlines()[1:]:
        p = line.split(",", 3)
        if len(p) < 4: continue
        m = p[3]
        if m.startswith("SPECI"): continue
        g = re.search(r" T([01])(\d{3})\d{4}", m)
        if g: c = (-1 if g.group(1) == "1" else 1) * int(g.group(2)) / 10
        else:
            g = re.search(r" (M?\d{2})/(M?\d{2})? ", m)
            if not g: continue
            c = int(g.group(1).replace("M", "-"))
        # routine only: IEM gives both; drop non-:5x minute specials heuristically via 'SPECI' absent; keep all
        rows.append((dt.datetime.strptime(p[1], "%Y-%m-%d %H:%M").replace(tzinfo=dt.timezone.utc), c))
    return rows
def rnd(x): return math.floor(x + 0.5)
OBS = {st: obs_series(st) for st in set(st_of.values())}
rows = []
for e in ev:
    if not e["closed"]: continue
    kind="H" if e["title"].startswith("Highest") else ("L" if e["title"].startswith("Lowest") else None)
    if not kind: continue
    c = city(e); st = st_of.get(c)
    m = re.search(r"-on-([a-z]+)-(\d+)-(\d{4})", e["slug"])
    if not m or not st or not tz_of.get(st): continue
    date = f"{m.group(3)}-{MON[m.group(1)]:02d}-{int(m.group(2)):02d}"
    tz = ZoneInfo(tz_of[st])
    bk = []
    for mk in e["markets"]:
        unit, lo, hi = bounds(mk["q"])
        won = json.loads(mk["px"] or "[0,0]")[0] in ("1", 1)
        bk.append({"q": mk["q"], "lo": lo, "hi": hi, "won": won, "h": pr.get(mk["tok"][0]) if mk["tok"] else None, "tok": mk["tok"], "vol": float(mk["vol"] or 0)})
    if sum(b["won"] for b in bk) != 1: continue
    bk.sort(key=lambda b: b["lo"])
    f1, f1m = fcmax(st, date, "temperature_2m_previous_day1"); f2, _ = fcmax(st, date, "temperature_2m_previous_day2")
    f0, _ = fcmax(st, date, "temperature_2m")
    conv = (lambda x: x * 9/5 + 32) if unit == "F" else (lambda x: x)
    # observed max from METAR (station local date)
    om = None; run = []
    if OBS.get(st):
        d0 = dt.datetime.fromisoformat(date).replace(tzinfo=tz)
        pts = [(t, c_) for t, c_ in OBS[st] if d0 <= t.astimezone(tz) < d0 + dt.timedelta(days=1)]
        if len(pts) >= 18: om = (max if kind=="H" else min)(c_ for _, c_ in pts); run = pts
    rows.append({"kind": kind, "city": c, "st": st, "date": date, "unit": unit, "tz": tz_of[st], "bk": bk,
                 "f0": conv(f0) if f0 is not None else None, "f1": conv(f1) if f1 is not None else None, "f2": conv(f2) if f2 is not None else None,
                 "f1m": [conv(x) for x in f1m], "om": conv(om) if om is not None else None, "run": [(t.timestamp(), conv(c_)) for t, c_ in run],
                 "vol": float(e["vol"] or 0)})

pickle.dump(rows, open("/home/claude/wx/rows.pkl","wb"))
import collections
for k in "HL":
    R=[r for r in rows if r["kind"]==k]; ok=bad=0; bc=collections.Counter()
    for r in R:
        if r["om"] is None: continue
        v=rnd(r["om"]); w=next(b for b in r["bk"] if b["won"])
        if w["lo"]<=v<=w["hi"]: ok+=1
        else: bad+=1; bc[r["city"]]+=1
    print(k,len(R),"obs",ok,bad,bc.most_common(6), min(r["date"] for r in R), max(r["date"] for r in R))
