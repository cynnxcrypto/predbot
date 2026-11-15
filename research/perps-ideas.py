#!/usr/bin/env python3
"""Solana perps and new spot ideas, tested on stored price history (15 Nov 2026 KST).

enrique: "we can do more things on spot" / "and also do solana perps". He wants rules that trade OFTEN.
Everything earlier (about 110 rules) was long-only. A perp adds the short side, so this file tests what only a
perp can do: shorting, two-sided trend and fade rules, market-neutral pairs, long-short baskets, funding as a
signal; plus one new spot idea that earns the spread instead of paying it (a grid of resting orders on SOL).

Rules, costs and the pass bar are fixed HERE, before any result was seen (commit precedes the first run).

Data: server-data branch, server/research/ (Binance hourly from 2021 or 2023, 5-minute from 2024, 8 h funding).
  python3 research/perps-ideas.py <dir with candles/ and funding/>

Costs (a side), from the venues' own pages, Oct-Nov 2026:
  Jupiter Perps SOL/ETH/BTC: 0.06% fee + at least 0.01% price impact, fill at the oracle price, borrow about
  0.0016% an hour, no funding.  Pacifica 0.04% taker, Phoenix 0.035%, Velocity (ex Drift) 0.04%, plus the spread.
  Used: 0.05% a side on SOL/BTC/ETH (the cheapest order book plus a 0.01% spread; Jupiter is 0.07%), 0.08% a side
  on other coins. Funding is charged on single-coin rules from Binance's 8 h rate.
Fill: the signal is read at a candle's close, the trade is made at the NEXT candle's open (never the signal price).
Periods: first = up to 31 Dec 2024, untouched = 2025-26.
Pass bar: positive after costs in BOTH periods, 100+ trades in the untouched period, half or more won there.
"Frequent" = 100+ trades a year."""
import gzip, json, sys, os
import numpy as np

D = sys.argv[1] if len(sys.argv) > 1 else "."
C3, CALT = 0.0005, 0.0008
SPLIT_H = 482136            # 1 Jan 2025 00:00 UTC in hours
BIG = ["SOLUSDT", "BTCUSDT", "ETHUSDT"]
ALTS = ["XRPUSDT", "DOGEUSDT", "BNBUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "SUIUSDT", "TRXUSDT", "LTCUSDT",
        "DOTUSDT", "NEARUSDT", "APTUSDT", "ARBUSDT", "OPUSDT", "PEPEUSDT", "SHIBUSDT", "UNIUSDT", "AAVEUSDT",
        "INJUSDT", "TIAUSDT"]


def load(sym, iv):
    d = json.load(gzip.open(os.path.join(D, "candles", f"{sym}-{iv}.json.gz")))
    per = 1.0 if iv == "1h" else 1 / 12
    return {k: np.array(d[k], dtype=float) for k in "tohlc"} | {"th": np.array(d["t"], dtype=float) * per}


def load_funding(sym):
    d = json.load(gzip.open(os.path.join(D, "funding", f"{sym}.json.gz")))
    t = np.array(d["t"], dtype=float) / 3.6e6
    return t, np.cumsum(np.array(d["rate"], dtype=float))


def fund_between(f, t0, t1):
    """Funding a LONG pays between two times (hours): sum of the rates stamped in (t0, t1]."""
    if f is None:
        return 0.0
    t, cs = f
    a, b = np.searchsorted(t, t0, "right"), np.searchsorted(t, t1, "right")
    return (cs[b - 1] if b > 0 else 0.0) - (cs[a - 1] if a > 0 else 0.0)


RES = []


def report(name, family, trades, cost_note=""):
    """trades: list of (entry time in hours, net fraction, gross fraction)."""
    if not trades:
        RES.append((family, name, None)); return
    tr = np.array(trades)
    out = {}
    for lab, m in (("first", tr[:, 0] < SPLIT_H), ("held", tr[:, 0] >= SPLIT_H)):
        x = tr[m]
        if len(x) == 0:
            out[lab] = None; continue
        yrs = max((x[:, 0].max() - x[:, 0].min()) / 8766, 0.25)
        out[lab] = dict(n=len(x), per_year=len(x) / yrs, win=float((x[:, 1] > 0).mean()), net=float(x[:, 1].mean()),
                        gross=float(x[:, 2].mean()), total=float(x[:, 1].sum()),
                        se=float(x[:, 1].std() / max(len(x), 1) ** 0.5))
    RES.append((family, name, out))


def run_events(c, sig, hold, cost, f=None, tp=None, sl=None):
    """sig[i] in {-1,0,1} read at close i; enter at open i+1; leave at open i+1+hold, or earlier at a target or
    stop touched inside a candle (stop first if both). One trade at a time."""
    o, h, l, th = c["o"], c["h"], c["l"], c["th"]
    n = len(o); out = []; i = 0
    idx = np.nonzero(sig)[0]
    free = 0
    for i in idx:
        if i + 1 < free or i + 1 + hold >= n:
            continue
        d = sig[i]; e = o[i + 1]; j_exit = i + 1 + hold; px = o[j_exit]
        if tp or sl:
            for j in range(i + 1, j_exit):
                up, dn = h[j] / e - 1, l[j] / e - 1
                adverse, fav = (-dn, up) if d > 0 else (up, -dn)
                if sl and adverse >= sl:
                    px = e * (1 - d * sl); j_exit = j + 1; break
                if tp and fav >= tp:
                    px = e * (1 + d * tp); j_exit = j + 1; break
        g = d * (px / e - 1)
        fund = d * fund_between(f, th[i + 1], th[min(j_exit, n - 1)])
        out.append((th[i + 1], g - 2 * cost - fund, g))
        free = j_exit
    return out


def run_position(c, pos, cost, f=None):
    """pos[i] in {-1,0,1} decided at close i, held from open i+1. A trade = one unbroken stretch of a position."""
    o, th = c["o"], c["th"]; n = len(o); out = []
    cur = 0; e = 0.0; te = 0.0
    for i in range(n - 1):
        p = pos[i]
        if p != cur:
            px = o[i + 1]
            if cur != 0:
                g = cur * (px / e - 1)
                out.append((te, g - 2 * cost - cur * fund_between(f, te, th[i + 1]), g))
            cur, e, te = p, px, th[i + 1]
    return out


def roll_ret(x, w):
    r = np.zeros(len(x)); r[w:] = x[w:] / x[:-w] - 1; return r


def roll_mean_std(x, w):
    cs = np.cumsum(np.insert(x, 0, 0.0)); cs2 = np.cumsum(np.insert(x * x, 0, 0.0))
    m = np.full(len(x), np.nan); s = np.full(len(x), np.nan)
    m[w - 1:] = (cs[w:] - cs[:-w]) / w
    v = (cs2[w:] - cs2[:-w]) / w - m[w - 1:] ** 2
    s[w - 1:] = np.sqrt(np.maximum(v, 1e-18))
    return m, s


def roll_max(x, w):
    from numpy.lib.stride_tricks import sliding_window_view
    out = np.full(len(x), np.nan); out[w - 1:] = sliding_window_view(x, w).max(axis=1); return out


def roll_min(x, w):
    from numpy.lib.stride_tricks import sliding_window_view
    out = np.full(len(x), np.nan); out[w - 1:] = sliding_window_view(x, w).min(axis=1); return out


def pooled(name, family, per_coin):
    t = []
    for x in per_coin:
        t += x
    report(name, family, t)


H1 = {s: load(s, "1h") for s in BIG}
M5 = {s: load(s, "5m") for s in BIG}
FUND = {s: load_funding(s) for s in BIG}

# ---------- 1. short after a rise (fade the pump) and 2. short after a fall (ride the fall) ----------
for unit, data, grid in (("5m", M5, [(0.005, 3, 3), (0.01, 3, 12), (0.015, 12, 48), (0.02, 12, 48), (0.03, 48, 48)]),
                         ("1h", H1, [(0.03, 4, 4), (0.05, 4, 4), (0.05, 24, 24), (0.10, 24, 24)])):
    for x, w, hold in grid:
        lab = f"{x*100:g}% in {w*(5 if unit=='5m' else 60)} min, hold {hold*(5 if unit=='5m' else 60)} min ({unit})"
        up, dn = [], []
        for s in BIG:
            c = data[s]; r = roll_ret(c["c"], w)
            up.append(run_events(c, np.where(r >= x, -1, 0), hold, C3, FUND[s]))
            dn.append(run_events(c, np.where(r <= -x, -1, 0), hold, C3, FUND[s]))
        pooled("short after a rise of " + lab, "1 short the pump", up)
        pooled("short after a fall of " + lab, "2 short the fall", dn)

# ---------- 3. two-sided trend (always long or short) ----------
for s in BIG:
    c = H1[s]; cl = c["c"]
    for n in (24, 72, 168):
        hi, lo = roll_max(c["h"], n), roll_min(c["l"], n)
        pos = np.zeros(len(cl)); cur = 0
        for i in range(n, len(cl)):
            if cl[i] >= hi[i - 1]: cur = 1
            elif cl[i] <= lo[i - 1]: cur = -1
            pos[i] = cur
        report(f"{s[:3]} breakout of the {n} h range, long or short", "3 trend both ways", run_position(c, pos, C3, FUND[s]))
    for n in (24, 72, 168):
        r = roll_ret(cl, n); pos = np.zeros(len(cl))
        for i in range(n, len(cl), n):
            pos[i:i + n] = np.sign(r[i])
        report(f"{s[:3]} follow the last {n} h, reset every {n} h", "3 trend both ways", run_position(c, pos, C3, FUND[s]))
    m1, _ = roll_mean_std(cl, 24); m2, _ = roll_mean_std(cl, 168)
    report(f"{s[:3]} 24 h average above/below 168 h average", "3 trend both ways",
           run_position(c, np.nan_to_num(np.sign(m1 - m2)), C3, FUND[s]))

# ---------- 4. two-sided fade of stretched prices ----------
for unit, data, grid in (("5m", M5, [(12, 2.0, 12), (48, 2.5, 48), (288, 2.5, 144)]),
                         ("1h", H1, [(24, 2.0, 12), (24, 2.5, 24), (72, 2.5, 48)])):
    for w, z, hold in grid:
        per = []
        for s in BIG:
            c = data[s]; m, sd = roll_mean_std(c["c"], w); zz = np.nan_to_num((c["c"] - m) / sd)
            per.append(run_events(c, np.where(zz >= z, -1, np.where(zz <= -z, 1, 0)), hold, C3, FUND[s]))
        mins = 5 if unit == "5m" else 60
        pooled(f"fade {z:g} sd from the {w*mins/60:g} h average, hold {hold*mins/60:g} h ({unit})", "4 fade both ways", per)

# ---------- 5. market-neutral pairs ----------
def pair_trades(a, b, w, zin, maxhold, cost):
    n = min(len(a["c"]), len(b["c"])); assert abs(a["th"][0] - b["th"][0]) < 1e-6
    r = np.log(a["c"][:n] / b["c"][:n]); m, sd = roll_mean_std(r, w); z = np.nan_to_num((r - m) / sd)
    out = []; i = w
    while i < n - maxhold - 2:
        if abs(z[i]) >= zin:
            d = -np.sign(z[i]); j = i + 1
            while j < i + maxhold and d * z[j] < 0: j += 1      # leave when the gap has closed, or at the time limit
            ea, eb, xa, xb = a["o"][i + 1], b["o"][i + 1], a["o"][j + 1], b["o"][j + 1]
            g = d * ((xa / ea - 1) - (xb / eb - 1))
            out.append((a["th"][i + 1], g - 4 * cost, g)); i = j + 1
        else:
            i += 1
    return out

for unit, data, grid in (("5m", M5, [(48, 2.0, 48), (144, 2.5, 144), (288, 2.0, 288)]),
                         ("1h", H1, [(24, 2.0, 24), (72, 2.0, 72), (168, 2.0, 168), (168, 2.5, 168)])):
    for w, zin, mh in grid:
        mins = 5 if unit == "5m" else 60
        per = [pair_trades(data[x], data[y], w, zin, mh, C3) for x, y in (("SOLUSDT", "ETHUSDT"), ("SOLUSDT", "BTCUSDT"), ("ETHUSDT", "BTCUSDT"))]
        pooled(f"pair gap {zin:g} sd over {w*mins/60:g} h, until it closes or {mh*mins/60:g} h ({unit})", "5 pairs, no market risk", per)

# ---------- 6. long-short baskets on 23 coins ----------
ALLC = {s: load(s, "1h") for s in ALTS}; ALLC.update(H1)
t0 = max(c["t"][0] for c in ALLC.values()); t1 = min(c["t"][-1] for c in ALLC.values())
names = sorted(ALLC); T = int(t1 - t0) + 1
O = np.full((T, len(names)), np.nan); Cl = np.full((T, len(names)), np.nan)
for k, s in enumerate(names):
    c = ALLC[s]; ix = (c["t"] - t0).astype(int); ok = (ix >= 0) & (ix < T)
    O[ix[ok], k] = c["o"][ok]; Cl[ix[ok], k] = c["c"][ok]
for look, reb, k, kind in [(4, 4, 3, "rev"), (24, 24, 3, "rev"), (24, 4, 3, "rev"), (72, 24, 5, "rev"),
                           (4, 4, 3, "mom"), (24, 24, 3, "mom"), (168, 24, 5, "mom"), (168, 168, 5, "mom")]:
    tr = []
    for i in range(max(look, 1), T - reb - 2, reb):
        past = Cl[i] / Cl[i - look] - 1; fwd = O[i + 1 + reb] / O[i + 1] - 1
        ok = ~np.isnan(past) & ~np.isnan(fwd)
        if ok.sum() < 15: continue
        order = np.argsort(np.where(ok, past, np.nan)); order = order[: ok.sum()]
        lo, hi = order[:k], order[-k:]
        g = (fwd[lo].mean() - fwd[hi].mean()) * (1 if kind == "rev" else -1)
        tr.append((t0 + i + 1, g - 4 * CALT, g))
    what = "buy the worst, short the best" if kind == "rev" else "buy the best, short the worst"
    report(f"{what} {k} of the last {look} h, every {reb} h", "6 long-short basket", tr)

# ---------- 7. funding as a signal ----------
for s in BIG:
    c = H1[s]; ft, cs = FUND[s]; rate = np.diff(np.insert(cs, 0, 0.0))
    last = np.zeros(len(c["t"])); stamp = np.zeros(len(c["t"]), dtype=bool)
    ix = np.searchsorted(c["th"], ft, "left"); ok = ix < len(last)
    last[ix[ok]] = rate[ok]; stamp[ix[ok]] = True
    for thr, d, hold, lab in [(0.0003, -1, 8, "short when funding is above 0.03%"), (0.0005, -1, 24, "short when funding is above 0.05%"),
                              (-0.0001, 1, 8, "buy when funding is below -0.01%"), (0.0003, 1, 8, "buy when funding is above 0.03% (crowd is right)")]:
        sig = np.where(stamp & ((last >= thr) if thr > 0 else (last <= thr)), d, 0)
        report(f"{s[:3]} {lab}, hold {hold} h", "7 funding signal", run_events(c, sig, hold, C3, FUND[s]))

# ---------- 8. break of the last 4 h range on 5-minute candles: go with it / fade it ----------
for hold in (12, 48):
    go, fade, gostop = [], [], []
    for s in BIG:
        c = M5[s]; hi, lo = roll_max(c["h"], 48), roll_min(c["l"], 48)
        sig = np.zeros(len(c["c"])); sig[1:] = np.where(c["c"][1:] > hi[:-1], 1, np.where(c["c"][1:] < lo[:-1], -1, 0))
        go.append(run_events(c, sig, hold, C3, FUND[s])); fade.append(run_events(c, -sig, hold, C3, FUND[s]))
        gostop.append(run_events(c, sig, hold, C3, FUND[s], tp=0.015, sl=0.005))
    pooled(f"go with a break of the 4 h range, hold {hold*5} min", "8 range break (5m)", go)
    pooled(f"fade a break of the 4 h range, hold {hold*5} min", "8 range break (5m)", fade)
    pooled(f"go with the break, target 1.5%, stop 0.5%, at most {hold*5} min", "8 range break (5m)", gostop)

# ---------- 9. Bitcoin leads: short SOL and ETH after Bitcoin drops ----------
b = M5["BTCUSDT"]
for x, w, hold in [(0.005, 3, 3), (0.005, 3, 12), (0.01, 12, 12)]:
    per = []
    for s in ("SOLUSDT", "ETHUSDT"):
        c = M5[s]; n = min(len(c["c"]), len(b["c"])); r = roll_ret(b["c"][:n], w)
        sig = np.zeros(len(c["c"])); sig[:n] = np.where(r <= -x, -1, 0)
        per.append(run_events(c, sig, hold, C3, FUND[s]))
    pooled(f"Bitcoin down {x*100:g}% in {w*5} min: short SOL and ETH for {hold*5} min", "9 Bitcoin leads", per)

# ---------- 10. hours of the day, short side ----------
for lab, h0, h1 in [("Asia hours (00-08 UTC)", 0, 8), ("Europe hours (08-16 UTC)", 8, 16), ("US hours (16-24 UTC)", 16, 24)]:
    per = []
    for s in BIG:
        c = H1[s]; hr = (c["t"] % 24).astype(int)
        sig = np.where(hr == (h0 - 1) % 24, -1, 0)
        per.append(run_events(c, sig, h1 - h0, C3, FUND[s]))
    pooled(f"short through {lab}", "10 time of day", per)

# ---------- 11. SPOT: grid of resting orders on SOL (earns the spread; holds the bag when SOL falls) ----------
def grid(c, step, levels, fee, start, end):
    """Resting buy orders every `step` below the start price, each for 1 unit of dollars; a filled buy rests a sell
    one step higher. A resting order fills only when a candle trades THROUGH its price by 0.05%. The grid is rebuilt
    around the price when it leaves the band (bag sold at market, 0.1% extra). Returns round trips, realised and
    total profit as a fraction of the dollars committed (levels x 1)."""
    o, h, l, cl, th = c["o"], c["h"], c["l"], c["c"], c["th"]
    i0, i1 = np.searchsorted(th, start), np.searchsorted(th, end)
    if i1 - i0 < 100: return None
    def build(p): return [p * (1 - step) ** k for k in range(1, levels + 1)]
    lv = build(o[i0]); held = [False] * levels; real = 0.0; trips = 0; rebuilds = 0
    for i in range(i0, i1):
        for k in range(levels):
            if not held[k] and l[i] <= lv[k] * 0.9995:
                held[k] = True; real -= fee
            elif held[k] and h[i] >= lv[k] / (1 - step) * 1.0005:
                held[k] = False; real += step / (1 - step) - fee; trips += 1
        top, bot = lv[0] / (1 - step), lv[-1]
        if cl[i] > top * (1 + 2 * step) or cl[i] < bot * (1 - 2 * step):
            for k in range(levels):
                if held[k]: real += cl[i] / lv[k] - 1 - fee - 0.001
            lv = build(cl[i]); held = [False] * levels; rebuilds += 1
    openpl = sum(cl[i1 - 1] / lv[k] - 1 for k in range(levels) if held[k])
    return dict(trips=trips, rebuilds=rebuilds, realised=real / levels, total=(real + openpl) / levels,
                hold=cl[i1 - 1] / o[i0] - 1)

GRID = []
c5 = M5["SOLUSDT"]
for step, levels in [(0.005, 10), (0.01, 10), (0.02, 10), (0.01, 20)]:
    for lab, a, bb in [("2024", 473352, 482136), ("2025", 482136, 490896), ("2026", 490896, 499000)]:
        GRID.append((f"grid step {step*100:g}%, {levels} levels", lab, grid(c5, step, levels, 0.001, a, bb)))

# ---------- output ----------
def fmt(o):
    if o is None: return "      -"
    return f"{o['n']:6d} {o['per_year']:7.0f}/y {o['win']*100:4.0f}% gross {o['gross']*100:+6.3f}% net {o['net']*100:+6.3f}% (se {o['se']*100:.3f})"

fam = None; passed = []
for family, name, out in RES:
    if family != fam:
        print(f"\n== {family} =="); fam = family
    if out is None:
        print(f"{name}: no trades"); continue
    print(f"{name}\n    first {fmt(out['first'])}\n    held  {fmt(out['held'])}")
    a, b2 = out["first"], out["held"]
    if a and b2 and a["net"] > 0 and b2["net"] > 0:
        passed.append((family, name, a, b2, b2["n"] >= 100 and b2["win"] >= 0.5 and b2["per_year"] >= 100))
print("\n== 11 spot grid on SOL (fraction of the dollars committed; hold = just holding SOL) ==")
for name, lab, g in GRID:
    if g: print(f"{name} {lab}: round trips {g['trips']:5d}, rebuilt {g['rebuilds']:3d}, realised {g['realised']*100:+7.1f}%, total with bag {g['total']*100:+7.1f}%, hold {g['hold']*100:+6.1f}%")
print(f"\n{len(RES)} perp rules. Positive after costs in both periods: {len(passed)}")
for family, name, a, b2, full in passed:
    print(("  FULL BAR  " if full else "  positive  ") + f"{name}: first {a['net']*100:+.3f}% x{a['n']}, held {b2['net']*100:+.3f}% x{b2['n']} ({b2['per_year']:.0f}/y, won {b2['win']*100:.0f}%)")
