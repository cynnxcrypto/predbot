#!/usr/bin/env python3
"""Fee earning in a SOL/USDC pool against the cost of the price moves, on hourly history (12 Nov 2026).

Why: enrique wants something that is active all day and needs no speed; fee earning in pools is the one idea of
that kind. The paper rules (src/solana/lp.ts) are scored by where the price happens to end, so their first days
say little. This asks the question that does not depend on the end price:

  cost  what the price moves cost one unit of liquidity against holding its two tokens: a quarter of the squared
        hourly moves (exact for a position that stays in range; the same in every range width);
  fee   what the pool paid that unit of liquidity.

The cost is known for every day since 2021 from the candles. THE FEE IS NOT: there is no fee history here. It is
measured for one window by the paper test (pass it with --fee, per day per unit of liquidity, and --from/--hours for
the window) and then ASSUMED to move with Binance's SOLUSDT volume. That assumption cannot be checked from here:
the pool's share of trading and its depth changed over the years. So:

  - the line for the measured window is a measurement (fee against that window's cost);
  - every other line is an ESTIMATE resting on the volume assumption, and the years before 2024 mostly show that
    the assumption breaks down, not what a provider earned.

The live reading (src/solana/lpedge.ts, status solana.edge) measures fee and cost for real, day by day; this script
is only the first look. Nothing here is a result with money.

Usage: sol-lp-fee-vs-cost.py <SOLUSDT-1h.json.gz> --fee 2.218e-4 --from "2026-11-11 03" --hours 21 [--width 0.05]
"""
import calendar, gzip, json, math, statistics, sys, time


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def main():
    d = json.loads(gzip.decompress(open(sys.argv[1], "rb").read()))
    t, c, qv = d["t"], d["c"], d["qv"]
    n = len(t)
    fee_day = float(arg("--fee"))
    h0 = calendar.timegm(time.strptime(arg("--from"), "%Y-%m-%d %H")) // 3600
    hours = int(arg("--hours"))
    w = float(arg("--width", "0.05"))
    share = 2 - 1 / math.sqrt(1 + w) - math.sqrt(1 - w)  # value of a unit of liquidity in a range of +-w
    r2 = [0.0] + [math.log(c[i] / c[i - 1]) ** 2 for i in range(1, n)]
    win = [i for i in range(n) if h0 <= t[i] < h0 + hours]
    if len(win) != hours:
        sys.exit(f"the window is not in the file: {len(win)} of {hours} hours")
    days = hours / 24
    var = sum(r2[i] for i in win) / days
    vol = sum(qv[i] for i in win) / days
    print(f"measured window: {hours} h from {arg('--from')} UTC")
    print(f"  SOL moved {100 * math.sqrt(var):.2f}% a day (hourly closes); Binance volume ${vol / 1e6:.0f}M a day")
    print(f"  fee {100 * fee_day / share:.3f}% a day on a +-{100 * w:g}% range; price cost {100 * var / 4 / share:.3f}% a day; fee / cost = {fee_day / (var / 4):.2f}")
    print(f"  at that fee the pool breaks even when SOL moves {100 * math.sqrt(4 * fee_day):.2f}% a day")
    k = fee_day / vol  # ASSUMPTION: fee per unit of liquidity moves with Binance volume
    byday = {}
    for i in range(1, n):
        a = byday.setdefault(t[i] // 24, [0.0, 0.0, 0])
        a[0] += r2[i]
        a[1] += qv[i]
        a[2] += 1
    rows = [(day, v) for day, v in sorted(byday.items()) if v[2] == 24]
    last = rows[-1][0]

    def show(name, sub):
        if not sub:
            return
        fee = [k * v[1] for _, v in sub]
        cost = [v[0] / 4 for _, v in sub]
        net = [f - x for f, x in zip(fee, cost)]
        print(f"  {name:10} {len(sub):5} days  SOL {100 * math.sqrt(statistics.median(v[0] for _, v in sub)):.2f}% a day (median)  "
              f"fee {100 * statistics.mean(fee) / share:.3f}%  cost {100 * statistics.mean(cost) / share:.3f}%  net {100 * statistics.mean(net) / share:+.3f}% a day  "
              f"fee/cost {sum(fee) / sum(cost):.2f}  days ahead {100 * sum(1 for x in net if x > 0) / len(sub):.0f}%  worst day {100 * min(net) / share:+.1f}%")

    print(f"\nESTIMATE (fee assumed to move with Binance volume), +-{100 * w:g}% range always in range, % of the position:")
    for y in range(2021, 2027):
        show(str(y), [x for x in rows if time.gmtime(x[0] * 86400).tm_year == y])
    show("last 12 m", [x for x in rows if x[0] > last - 365])
    show("last 90 d", [x for x in rows if x[0] > last - 90])
    show("last 30 d", [x for x in rows if x[0] > last - 30])
    sub = sorted([x for x in rows if x[0] > last - 365], key=lambda x: x[1][0])
    q = len(sub) // 5
    print("  last 12 months, days sorted from calm to wild, in fifths:")
    for i in range(5):
        b = sub[i * q:(i + 1) * q] if i < 4 else sub[i * q:]
        f = statistics.mean(k * v[1] for _, v in b)
        x = statistics.mean(v[0] / 4 for _, v in b)
        print(f"    {i + 1}: SOL {100 * math.sqrt(statistics.mean(v[0] for _, v in b)):.2f}% a day  fee {100 * f / share:.3f}%  cost {100 * x / share:.3f}%  net {100 * (f - x) / share:+.3f}%")


if __name__ == "__main__":
    main()
