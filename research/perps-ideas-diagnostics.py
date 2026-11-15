#!/usr/bin/env python3
"""Checks run AFTER the results of perps-ideas.py were seen (15 Nov 2026 KST), so these are diagnostics, not tests.

enrique: "the market is going down all the time ... shorting the market is good". So: does any SHORT rule make
money beyond the market simply falling? Every short trade is sorted by what the coin did in the 30 days before the
entry (falling: below -10%, rising: above +10%, flat: between) and by year. Funding is charged (Binance 8 h rate).
Also: a wide spot grid that never sells its bag at a loss.
  python3 research/perps-ideas-diagnostics.py <dir with candles/ and funding/>"""
import sys, os
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "perps-ideas.py")).read()
exec(src.split("# ---------- 1.")[0])
import datetime

def regime_table(name, trades_by_coin):
    rows = []
    for s, tr in trades_by_coin.items():
        c = H1[s]; r30 = roll_ret(c["c"], 720)
        for t, net, g in tr:
            i = min(int(np.searchsorted(c["th"], t)), len(r30) - 1) - 1
            reg = "falling" if r30[i] < -0.10 else "rising" if r30[i] > 0.10 else "flat"
            rows.append((reg, datetime.datetime.utcfromtimestamp(t * 3600).year, net))
    print(f"\n{name}  ({len(rows)} trades)")
    for key, lab in ((0, "30 days before"), (1, "year")):
        for k in sorted(set(r[key] for r in rows), key=str):
            x = np.array([r[2] for r in rows if r[key] == k])
            print(f"   {lab} {k!s:8} {len(x):5d} trades, won {100*(x>0).mean():3.0f}%, average {100*x.mean():+.3f}% (se {100*x.std()/len(x)**.5:.3f}), sum {100*x.sum():+.0f}%")

def short_leg(pos): return np.where(pos < 0, -1, 0)

# 0. the plain market: short every day for 24 h
tb = {}
for s in BIG:
    c = H1[s]; tb[s] = run_events(c, np.where((c["t"] % 24) == 23, -1, 0), 24, C3, FUND[s])
regime_table("BASELINE short every day for 24 h (no rule at all)", tb)

# 1. short only when the trend is down (the short half of the trend rules)
for n in (24, 72, 168):
    tb = {}
    for s in BIG:
        c = H1[s]; cl = c["c"]; r = roll_ret(cl, n); pos = np.zeros(len(cl))
        for i in range(n, len(cl), n): pos[i:i + n] = np.sign(r[i])
        tb[s] = run_position(c, short_leg(pos), C3, FUND[s])
    regime_table(f"short for {n} h when the last {n} h were down", tb)
tb = {}
for s in BIG:
    c = H1[s]; cl = c["c"]; n = 24; hi, lo = roll_max(c["h"], n), roll_min(c["l"], n); pos = np.zeros(len(cl)); cur = 0
    for i in range(n, len(cl)):
        if cl[i] >= hi[i - 1]: cur = 1
        elif cl[i] <= lo[i - 1]: cur = -1
        pos[i] = cur
    tb[s] = run_position(c, short_leg(pos), C3, FUND[s])
regime_table("short on a break below the 24 h range, out on a break above", tb)

# 2. short the bounce inside a downtrend
for x, w, hold in [(0.03, 4, 4), (0.05, 24, 24), (0.03, 24, 12)]:
    tb = {}
    for s in BIG:
        c = H1[s]; cl = c["c"]; m1, _ = roll_mean_std(cl, 168); r = roll_ret(cl, w)
        tb[s] = run_events(c, np.where((r >= x) & (cl < np.nan_to_num(m1, nan=0)), -1, 0), hold, C3, FUND[s])
    regime_table(f"short a rise of {x*100:g}% in {w} h while below the 7-day average, hold {hold} h", tb)

# 3. short the pump / the fall, plain (rules from the main file) by regime
for x, w, hold, d in [(0.03, 4, 4, 1), (0.03, 4, 4, -1), (0.05, 24, 24, 1), (0.05, 24, 24, -1)]:
    tb = {}
    for s in BIG:
        c = H1[s]; r = roll_ret(c["c"], w)
        tb[s] = run_events(c, np.where(d * r >= x, -1, 0), hold, C3, FUND[s])
    regime_table(f"short after a {'rise' if d>0 else 'fall'} of {x*100:g}% in {w} h, hold {hold} h", tb)

# 4. what funding cost a short, by year (sum of the 8 h rates; a short RECEIVES positive funding)
print("\nFunding a short received (+) or paid (-), % of the position, by year")
for s in BIG:
    t, cs = FUND[s]; rate = np.diff(np.insert(cs, 0, 0.0)); yrs = np.array([datetime.datetime.utcfromtimestamp(x * 3600).year for x in t])
    print("  ", s[:3], "  ".join(f"{y}: {100*rate[yrs==y].sum():+.1f}%" for y in sorted(set(yrs))))

# 5. wide spot grid that keeps its bag (no rebuild): 2% steps down to -45%, and 1% steps down to -26%
def grid_keep(c, step, levels, fee, start, end):
    o, h, l, cl, th = c["o"], c["h"], c["l"], c["c"], c["th"]
    i0, i1 = np.searchsorted(th, start), np.searchsorted(th, end)
    lv = [o[i0] * (1 - step) ** k for k in range(1, levels + 1)]; held = [False] * levels; real = 0.0; trips = 0
    for i in range(i0, i1):
        for k in range(levels):
            if not held[k] and l[i] <= lv[k] * 0.9995: held[k] = True; real -= fee
            elif held[k] and h[i] >= lv[k] / (1 - step) * 1.0005: held[k] = False; real += step / (1 - step) - fee; trips += 1
    bag = sum(cl[i1 - 1] / lv[k] - 1 for k in range(levels) if held[k])
    return trips, real / levels, (real + bag) / levels, sum(held), cl[i1 - 1] / o[i0] - 1
print("\nWide spot grid on SOL that keeps its bag (never sells at a loss), 0.1% a side")
for step, levels in [(0.02, 30), (0.01, 30)]:
    for lab, a, b in [("2024", 473352, 482136), ("2025", 482136, 490896), ("2026", 490896, 499000), ("last 12 months", 498455 - 8766, 499000)]:
        tr, real, tot, nh, hold = grid_keep(M5["SOLUSDT"], step, levels, 0.001, a, b)
        print(f"   step {step*100:g}% x {levels}, {lab}: {tr} sells, banked {100*real:+.1f}%, with the bag {100*tot:+.1f}% of the money set aside ({nh} of {levels} levels still held), SOL itself {100*hold:+.0f}%")

# 6. the grid from many start dates (every month from Jan 2024, 6 months each): buy grid below (spot), sell grid
#    above (perp short, 0.05% a side), and both together. Money set aside = levels x 1 on each side.
def grid_side(c, step, levels, fee, i0, i1, side):
    o, h, l, cl = c["o"], c["h"], c["l"], c["c"]
    if side > 0: lv = [o[i0] * (1 - step) ** k for k in range(1, levels + 1)]
    else: lv = [o[i0] * (1 + step) ** k for k in range(1, levels + 1)]
    held = [False] * levels; real = 0.0; trips = 0
    for i in range(i0, i1):
        for k in range(levels):
            if side > 0:
                if not held[k] and l[i] <= lv[k] * 0.9995: held[k] = True; real -= fee
                elif held[k] and h[i] >= lv[k] / (1 - step) * 1.0005: held[k] = False; real += step / (1 - step) - fee; trips += 1
            else:
                if not held[k] and h[i] >= lv[k] * 1.0005: held[k] = True; real -= fee
                elif held[k] and l[i] <= lv[k] / (1 + step) * 0.9995: held[k] = False; real += step / (1 + step) - fee; trips += 1
    bag = sum(side * (cl[i1 - 1] / lv[k] - 1) for k in range(levels) if held[k])
    return trips, (real + bag) / levels
print("\nGrid 2% x 30 on SOL, 6 months from each month start: sells / result with the bag, % of money set aside")
c = M5["SOLUSDT"]; th = c["th"]; rows = []
for m in range(0, 29):
    y, mo = 2024 + m // 12, m % 12 + 1
    a = datetime.datetime(y, mo, 1, tzinfo=datetime.timezone.utc).timestamp() / 3600
    i0, i1 = int(np.searchsorted(th, a)), int(np.searchsorted(th, a + 4383))
    if i1 >= len(th) - 1: break
    tl, pl = grid_side(c, 0.02, 30, 0.001, i0, i1, 1); ts, ps = grid_side(c, 0.02, 30, 0.0005, i0, i1, -1)
    sol = c["c"][i1 - 1] / c["o"][i0] - 1; rows.append((pl, ps, (pl + ps) / 2, sol))
    print(f"   {y}-{mo:02d}: SOL {100*sol:+4.0f}% | buy grid {tl:3d} sells {100*pl:+6.1f}% | short grid {ts:3d} buys {100*ps:+6.1f}% | both {100*(pl+ps)/2:+6.1f}%")
r = np.array(rows)
for k, lab in enumerate(("buy grid", "short grid", "both")):
    print(f"   {lab}: {int((r[:,k]>0).sum())} of {len(r)} windows ahead, average {100*r[:,k].mean():+.1f}%, worst {100*r[:,k].min():+.1f}%, best {100*r[:,k].max():+.1f}%")

# 7. the same grid on hourly candles from 2021 (includes the 2021 rise and the 2022 collapse), by start year
print("\nGrid 2% x 30 on hourly candles, 6 months from each month start since 2021, by start year (both = half the money each side)")
by = {}
for s in ("SOLUSDT", "BTCUSDT", "ETHUSDT"):
    c = H1[s]; th = c["th"]
    for m in range(0, 66):
        y, mo = 2021 + m // 12, m % 12 + 1
        a = datetime.datetime(y, mo, 1, tzinfo=datetime.timezone.utc).timestamp() / 3600
        i0, i1 = int(np.searchsorted(th, a)), int(np.searchsorted(th, a + 4383))
        if i1 >= len(th) - 1: break
        tl, pl = grid_side(c, 0.02, 30, 0.001, i0, i1, 1); ts, ps = grid_side(c, 0.02, 30, 0.0005, i0, i1, -1)
        by.setdefault((s[:3], y), []).append((pl, ps, (pl + ps) / 2, tl + ts))
for (s, y), v in sorted(by.items()):
    r = np.array(v)
    print(f"   {s} {y}: buy grid {100*r[:,0].mean():+6.1f}% (worst {100*r[:,0].min():+6.1f}%) | short grid {100*r[:,1].mean():+6.1f}% (worst {100*r[:,1].min():+7.1f}%) | both {100*r[:,2].mean():+6.1f}% (worst {100*r[:,2].min():+6.1f}%, {int((r[:,2]>0).sum())}/{len(r)} ahead) | {r[:,3].mean():.0f} closed trades")
