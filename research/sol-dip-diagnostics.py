#!/usr/bin/env python3
"""Second look at the one family that came through research/sol-slow-rules.py: buying after a sharp fall (12 Nov 2026).

Not a search for a better rule. It asks whether the result is solid:
  1. by calendar year, with the worst single trades, and with the purchase an hour late;
  2. on six smaller Solana coins at a dearer cost (0.30% a side);
  3. neighbouring settings: deeper and shallower falls, shorter and longer holds. A real effect changes smoothly;
     a lucky rule stands alone.

Reading of 12 Nov 2026 (5.7 years to 08:00 KST that day):
  SOL "10% fall in 24 h, sell at +10% or after 24 h": 150 trades, 60% won, +1.42% a trade; by year 2021 +147% (51
  trades), 2022 -2% (52), 2023 +12% (10), 2024 +29% (14), 2025 +11% (17), 2026 +15% (6); worst trade -40%; an hour
  late +1.42%. Deeper falls bounce more, in SOL, BTC and ETH alike (SOL: 6% +0.77% on 444, 8% +1.13% on 248, 12%
  +1.87% on 89, 14% +2.38% on 49). Holding 24 to 72 h is best; a week gives it back. On JUP, BONK, WIF, JTO, RAY and
  PYTH the same rules make about nothing or lose: the bounce is a thing of the big coins.

Usage: sol-dip-diagnostics.py <folder with candles/> [SYMBOL ...]"""
import importlib.util, os, statistics, sys, time

_spec = importlib.util.spec_from_file_location("slow", os.path.join(os.path.dirname(os.path.abspath(__file__)), "sol-slow-rules.py"))
m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(m)
BIG = ("SOLUSDT", "BTCUSDT", "ETHUSDT")
Y23 = 1672531200 // 3600


def trades(d, pos, cost, delay=0):
    """every trade as (hour it was bought, net return); bought at the open of the hour after the signal (+delay)"""
    o, t = d["o"], d["t"]
    out, inn, e = [], False, 0
    for j in range(max(m.WARM, 1 + delay), len(o) - 1):
        want = bool(pos[j - 1 - delay])
        if want and not inn:
            inn, e = True, j
        elif not want and inn:
            inn = False
            out.append((t[e], o[j] / o[e] * (1 - cost) ** 2 - 1))
    return out


def line(v):
    return f"{len(v):4} {100 * statistics.mean(v):+6.2f}%" if v else "   0      -"


def by_year(d, name, pos, cost):
    for delay in (0, 1):
        tr = trades(d, pos, cost, delay)
        if not tr:
            print(f"{name:20} no trades")
            continue
        rs = sorted(r for _, r in tr)
        years = {}
        for h, r in tr:
            years.setdefault(time.gmtime(h * 3600).tm_year, []).append(r)
        print(f"{name:20} {delay}h late n={len(rs):3} won={100 * sum(1 for r in rs if r > 0) // len(rs)}% avg={100 * statistics.mean(rs):+.2f}% "
              f"median={100 * statistics.median(rs):+.2f}% worst={100 * rs[0]:+.1f}% 5th-worst-in-100={100 * rs[len(rs) // 20]:+.1f}% | "
              + " ".join(f"{y}:{len(v)}/{100 * sum(v):+.0f}%" for y, v in sorted(years.items())))


if __name__ == "__main__":
    folder = sys.argv[1]
    syms = sys.argv[2:] or ["SOLUSDT", "BTCUSDT", "ETHUSDT", "JUPUSDT", "BONKUSDT", "WIFUSDT", "JTOUSDT", "RAYUSDT", "PYTHUSDT"]
    picks = [("dip-24h-10-tp5-24h", (24, 10, 5, 24)), ("dip-24h-10-tp10-24h", (24, 10, 10, 24)), ("dip-4h-5-tp5-24h", (4, 5, 5, 24)), ("dip-4h-5-tp10-72h", (4, 5, 10, 72))]
    for sym in syms:
        p = os.path.join(folder, "candles", f"{sym}-1h.json.gz")
        if not os.path.exists(p):
            continue
        d = m.load(p)
        cost = 0.001 if sym in BIG else 0.003
        print(f"\n== {sym} ({len(d['t'])} hours, {cost * 100:.2f}% a side)")
        for name, a in picks:
            by_year(d, name, m.dip(d, *a), cost)
        if sym not in BIG:
            continue
        print("  fall of X% in 24 h, sell at +10% or after 24 h   [trades, average: all | since 2023]")
        for x in (4, 6, 8, 10, 12, 14, 16, 20):
            tr = trades(d, m.dip(d, 24, x, 10, 24), cost)
            print(f"  X={x:2}: {line([r for _, r in tr])} | {line([r for h, r in tr if h >= Y23])}")
        print("  fall of 10% in 24 h, sell at +10% or after K hours")
        for k in (6, 12, 24, 48, 72, 168):
            tr = trades(d, m.dip(d, 24, 10, 10, k), cost)
            print(f"  K={k:3}: {line([r for _, r in tr])} | {line([r for h, r in tr if h >= Y23])}")
