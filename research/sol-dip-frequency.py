#!/usr/bin/env python3
"""The frequent end of the dip rule, on hourly history (12 Nov 2026).

Why: buying SOL after a 10% fall in a day held up in history but trades about once a month, and enrique does not
want a bot that trades ten times a year. This runs ten versions that trade more often (shallower falls, shorter
windows, nearer targets) over the same history, on SOL, BTC and ETH, the same way as research/sol-slow-rules.py:
the signal at an hour's close, bought and sold at the next hour's open, 0.10% a side.

What it shows: the more often a version trades, the thinner it gets. Versions trading about 240 times a year make
nothing after costs; on BTC and ETH the frequent versions lose; on SOL two versions trading about twice a week
keep a small plus (4% in 24 hours sold at +5% or after 24 hours; 2% in one hour sold at +3% or after 12 hours).
With the 41 rules of the first search that is 51 rules tried: a plus this thin may be luck. History, not money.

Usage: sol-dip-frequency.py <folder with candles/<SYMBOL>-1h.json.gz>
"""
import importlib.util, os, statistics, sys

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("slow", os.path.join(here, "sol-slow-rules.py"))
slow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(slow)

VERSIONS = [(24, 3, 5, 24), (24, 4, 5, 24), (24, 4, 10, 24), (24, 6, 10, 24), (4, 2, 3, 12), (4, 3, 5, 24), (4, 3, 10, 72), (4, 5, 10, 72), (1, 1.5, 2, 6), (1, 2, 3, 12)]
SINCE_2023 = slow.SPLIT_H - 8760


def trades(d, h, x, y, k, cost=slow.COST):
    """(hour bought, result after both costs) of every trade of: buy after a fall of x% in h hours, sell at +y% or after k hours"""
    c, o, t, out, inn, at, px, entry = d["c"], d["o"], d["t"], [], False, 0, 0.0, 0.0
    for i in range(slow.WARM, len(c) - 2):
        if inn and (c[i] >= px * (1 + y / 100) or i - at >= k):
            out.append((t[at], o[i + 1] / entry * (1 - cost) ** 2 - 1))
            inn = False
        elif not inn and i >= h and c[i] / c[i - h] - 1 <= -x / 100:
            inn, at, px, entry = True, i, c[i], o[i + 1]
    return out


def part(tr, lo):
    s = [r for (t, r) in tr if t >= lo]
    if not s:
        return "   0"
    return f"{len(s):4} trades {100 * statistics.mean(s):+.2f}% won {100 * sum(1 for r in s if r > 0) / len(s):.0f}% worst {100 * min(s):+.0f}%"


if __name__ == "__main__":
    for sym in ("SOLUSDT", "BTCUSDT", "ETHUSDT"):
        d = slow.load(os.path.join(sys.argv[1], "candles", f"{sym}-1h.json.gz"))
        end = d["t"][-1]
        years = (end - SINCE_2023) / 8760
        print(f"\n== {sym}   fall, target, longest hold | all | since 2023 (trades a year) | last 12 months")
        for h, x, y, k in VERSIONS:
            tr = trades(d, h, x, y, k)
            n23 = sum(1 for (t, _) in tr if t >= SINCE_2023)
            print(f"  -{x}% in {h} h, +{y}%, {k} h".ljust(30) + f"| {part(tr, 0)} | {part(tr, SINCE_2023)} ({n23 / years:.0f} a year) | {part(tr, end - 8760)}")
