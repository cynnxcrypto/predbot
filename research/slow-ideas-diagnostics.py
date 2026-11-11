#!/usr/bin/env python3
"""Diagnostics for the survivors of slow-ideas.py (12 Nov 2026). Everything here was run AFTER the results were
seen, so it can only weaken a finding, never prove one: by year, by coin, distinct days (trades on the same day are
one bet, not several), an hour late, dearer trading, and the neighbouring settings.
Usage: slow-ideas-diagnostics.py <folder>"""
import importlib.util, os, sys, time
import numpy as np

spec = importlib.util.spec_from_file_location("si", os.path.join(os.path.dirname(os.path.abspath(__file__)), "slow-ideas.py"))
si = importlib.util.module_from_spec(spec); spec.loader.exec_module(si)
D, F, n = si.load(sys.argv[1])
r24 = {s: si.ret(D[s]["c"], 24) for s in D}
btc24 = r24["BTCUSDT"]
year = lambda e: time.gmtime((int(e) + si.T0) * 3600).tm_year
day = lambda e: (int(e) + si.T0) // 24


def late(sig, k):
    out = np.zeros(len(sig), bool); out[k:] = sig[:-k]; return out


def line(tag, tr, cost_of):
    """tr: list of (sym, entry, gross, hours)"""
    if not tr:
        print(f"  {tag:34} none"); return
    net = np.array([g * (1 - cost_of(s)) ** 2 - 1 for s, e, g, h in tr])
    days = {}
    for (s, e, g, h), x in zip(tr, net):
        days.setdefault(day(e), []).append(x)
    dm = np.array([np.mean(v) for v in days.values()])
    td = dm.mean() / (dm.std(ddof=1) / np.sqrt(len(dm))) if len(dm) > 2 else float("nan")
    print(f"  {tag:34} n {len(net):4}  won {100 * (net > 0).mean():3.0f}%  avg {100 * net.mean():+6.2f}%  median {100 * np.median(net):+6.2f}%  worst {100 * net.min():+6.1f}%  days {len(dm):3}  day-avg {100 * dm.mean():+6.2f}%  t(days) {td:5.2f}")


def collect(coins, sigf, K, tp=None):
    out = []
    for s in coins:
        for e, g, h in si.events(D[s], sigf(s), K, tp):
            out.append((s, e, g, h))
    return out


def report(title, coins, sigf, K, tp=None):
    """tp: None, or a function coin -> take-profit"""
    print(f"\n== {title}")
    c = lambda s: si.COST[s]
    collect_ = lambda coins, f, K, tp: [t for s in coins for t in collect([s], f, K, tp(s) if tp else None)]
    tr = collect_(coins, sigf, K, tp)
    line("all", tr, c)
    line("DEV 2021-24", [t for t in tr if t[1] < si.SPLIT], c)
    line("HOLD 2025-26", [t for t in tr if t[1] >= si.SPLIT], c)
    for y in range(2021, 2027):
        line(f"year {y}", [t for t in tr if year(t[1]) == y], c)
    for s in coins:
        line(f"coin {s}", [t for t in tr if t[0] == s], c)
    line("an hour late", collect_(coins, lambda s: late(sigf(s), 1), K, tp), c)
    line("3 hours late", collect_(coins, lambda s: late(sigf(s), 3), K, tp), c)
    line("cost 0.25% a side (majors)", tr, lambda s: max(0.0025, si.COST[s]))
    return tr


BIG2, BIG3 = ["SOLUSDT", "ETHUSDT"], si.MAJORS
ok = lambda s: ~np.isnan(D[s]["c"])
report("A1 mkt-dip-7: BTC fell 7% in 24 h -> buy SOL and ETH, 24 h", BIG2, lambda s: btc24 <= -0.07, 24)
report("A1 mkt-dip-7 on BTC itself", ["BTCUSDT"], lambda s: btc24 <= -0.07, 24)
report("A1 mkt-dip-7 on the small coins (0.30% a side)", si.SMALLS, lambda s: (btc24 <= -0.07) & ok(s), 24)
report("A1 mkt-dip-5: BTC fell 5% in 24 h -> buy SOL and ETH, 24 h", BIG2, lambda s: btc24 <= -0.05, 24)
report("A3 both-dip: coin fell 10% and BTC 5% -> buy the coin, 24 h", BIG2, lambda s: (r24[s] <= -0.10) & (btc24 <= -0.05), 24)
report("A2 own-dip (failed): coin fell 10%, BTC less than 3%", BIG2, lambda s: (r24[s] <= -0.10) & (btc24 > -0.03), 24)
X = {"BTCUSDT": 0.06, "ETHUSDT": 0.08, "SOLUSDT": 0.10}
report("F5 dip-scaled: BTC 6% / ETH 8% / SOL 10%, sell at the same size up or 24 h", BIG3, lambda s: r24[s] <= -X[s], 24, lambda s: X[s])

print("\n== neighbours of mkt-dip (SOL and ETH; BTC fall x hold), DEV / HOLD average after costs and trades")
for x in (3, 4, 5, 6, 7, 8, 10):
    row = f"  BTC -{x:2}%:"
    for K in (6, 12, 24, 48, 72):
        tr = collect(BIG2, lambda s: btc24 <= -x / 100, K)
        f = lambda sub: (f"{100 * np.mean([g * 0.999 ** 2 - 1 for _, _, g, _ in sub]):+5.2f}({len(sub):3})" if sub else "   -     ")
        row += f"  {K:2}h {f([t for t in tr if t[1] < si.SPLIT])} / {f([t for t in tr if t[1] >= si.SPLIT])}"
    print(row)
