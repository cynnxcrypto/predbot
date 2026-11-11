#!/usr/bin/env python3
"""Slow rules on SOL, tested on years of hourly history (12 Nov 2026).

Why: wallet copying on Solana has no edge at our speed. These rules trade a few times a week or a month, so a second
of delay does not matter. They are long SOL or in dollars: no borrowing, no shorting. BTC and ETH run through the
same rules as a cross-check: a rule that only works on one coin is probably luck.

THE RULES WERE WRITTEN DOWN BEFORE ANY RESULT WAS SEEN (this file was committed before the price files existed):
  trend     in SOL while the price is above its average of the last N hours            N = 24 72 168 336 720 1440
  momentum  in SOL while the price is above where it was N hours ago                    N = 24 72 168 336 720
  breakout  buy at a new N hour high, sell at a new N/2 hour low                        N = 48 168 336 720
  twoavg    in SOL while price > short average and short average > long average         (72, 336) (168, 720)
  dip       buy after a fall of X% in H hours, sell at +Y% or after K hours             H = 4 24, X = 5 10 15, Y = 5 10, K = 24 72
Every signal is taken at the close of an hour and traded at the open of the next. Cost: COST per side (0.10% =
pool fee and slippage of a SOL/USDC swap at our size, on the safe side); a second run at 0.25% shows how much the
result leans on cheap trading.

How to read it. Forty-one rules were tried, so the best one is partly luck: look at each family's MIDDLE rule and at
whether a rule holds in BOTH periods (to the end of 2023, and from 2024 on) and in the last 12 months. "ok" needs:
money made after costs in both periods and the last 12 months, 30+ trades, and a smaller worst fall than just
holding. Holding SOL is shown next to everything: a rule that only made money because SOL went up is not a rule.

Usage: sol-slow-rules.py <folder with candles/<SYMBOL>-1h.json.gz and funding/<SYMBOL>.json.gz> [--json out.json]
A backtest is history, not a promise: nothing here is a result with real money."""
import gzip, json, os, statistics, sys, time
from collections import deque

COST = 0.0010
SPLIT_H = 1704067200 // 3600  # 1 Jan 2024 UTC, in hours
WARM = 1440


def load(path):
    return json.loads(gzip.decompress(open(path, "rb").read()))


def sma(c, n):
    out, s = [None] * len(c), 0.0
    for i, v in enumerate(c):
        s += v
        if i >= n:
            s -= c[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def rolling(xs, n, best):
    """best (max or min) of the n values BEFORE each index; None until n values exist"""
    out, q = [None] * len(xs), deque()
    for i, v in enumerate(xs):
        if i >= n:
            out[i] = xs[q[0]]
        while q and (xs[q[-1]] <= v if best is max else xs[q[-1]] >= v):
            q.pop()
        q.append(i)
        if q[0] <= i - n:
            q.popleft()
    return out


def trend(d, n):
    m = sma(d["c"], n)
    return [m[i] is not None and d["c"][i] > m[i] for i in range(len(d["c"]))]


def momentum(d, n):
    c = d["c"]
    return [i >= n and c[i] > c[i - n] for i in range(len(c))]


def breakout(d, n):
    hi, lo, c = rolling(d["h"], n, max), rolling(d["l"], n // 2, min), d["c"]
    out, inn = [], False
    for i in range(len(c)):
        if not inn and hi[i] is not None and c[i] > hi[i]:
            inn = True
        elif inn and lo[i] is not None and c[i] < lo[i]:
            inn = False
        out.append(inn)
    return out


def twoavg(d, a, b):
    ma, mb, c = sma(d["c"], a), sma(d["c"], b), d["c"]
    return [mb[i] is not None and c[i] > ma[i] > mb[i] for i in range(len(c))]


def dip(d, h, x, y, k):
    c, out, inn, at, px = d["c"], [], False, 0, 0.0
    for i in range(len(c)):
        if inn and (c[i] >= px * (1 + y / 100) or i - at >= k):
            inn = False
        elif not inn and i >= h and c[i] / c[i - h] - 1 <= -x / 100:
            inn, at, px = True, i, c[i]
        out.append(inn)
    return out


def rules():
    out = []
    for n in (24, 72, 168, 336, 720, 1440):
        out.append(("trend", f"trend-{n}", lambda d, n=n: trend(d, n)))
    for n in (24, 72, 168, 336, 720):
        out.append(("momentum", f"momentum-{n}", lambda d, n=n: momentum(d, n)))
    for n in (48, 168, 336, 720):
        out.append(("breakout", f"breakout-{n}", lambda d, n=n: breakout(d, n)))
    for a, b in ((72, 336), (168, 720)):
        out.append(("twoavg", f"twoavg-{a}-{b}", lambda d, a=a, b=b: twoavg(d, a, b)))
    for h in (4, 24):
        for x in (5, 10, 15):
            for y in (5, 10):
                for k in (24, 72):
                    out.append(("dip", f"dip-{h}h-{x}-tp{y}-{k}h", lambda d, h=h, x=x, y=y, k=k: dip(d, h, x, y, k)))
    return out


def run(d, pos, cost=COST, start=WARM, lo=None, hi=None):
    """Walks the hours. pos[i] is decided at the close of hour i and held from the open of hour i+1 to the open of
    hour i+2. Only hours whose number t lies in [lo, hi) count; a position open at the edge is entered or left
    there at the cost. Returns the money multiple, worst fall, trades and time in the market."""
    o, t = d["o"], d["t"]
    eq, peak, dd, held, hours, inn, entry, trades = 1.0, 1.0, 0.0, 0, 0, False, 0.0, []
    for j in range(max(start, 1), len(o) - 1):
        if (lo is not None and t[j] < lo) or (hi is not None and t[j] >= hi):
            continue
        want = bool(pos[j - 1])
        if want and not inn:
            inn, entry = True, eq  # the money before the purchase: a trade's result is counted after both costs
            eq *= 1 - cost
        elif not want and inn:
            eq *= 1 - cost
            inn = False
            trades.append(eq / entry - 1)
        hours += 1
        if inn:
            held += 1
            eq *= o[j + 1] / o[j]
        peak = max(peak, eq)
        dd = max(dd, 1 - eq / peak)
    if inn:
        eq *= 1 - cost
        trades.append(eq / entry - 1)
    years = hours / 8760 if hours else 0
    return {
        "mult": round(eq, 3), "pctPerYear": round((eq ** (1 / years) - 1) * 100, 1) if years > 0.2 and eq > 0 else None,
        "worstFallPct": round(dd * 100, 1), "trades": len(trades), "wonPct": round(100 * sum(1 for x in trades if x > 0) / len(trades)) if trades else None,
        "avgTradePct": round(100 * statistics.mean(trades), 2) if trades else None, "medianTradePct": round(100 * statistics.median(trades), 2) if trades else None,
        "inMarketPct": round(100 * held / hours) if hours else None, "years": round(years, 2),
    }


def study(d, cost=COST):
    last = d["t"][-1] + 1
    spans = {"all": (None, None), "to2023": (None, SPLIT_H), "from2024": (SPLIT_H, None), "last12m": (last - 8760, None)}
    hold = {k: run(d, [True] * len(d["c"]), cost, lo=a, hi=b) for k, (a, b) in spans.items()}
    rows = []
    for family, name, f in rules():
        pos = f(d)
        r = {k: run(d, pos, cost, lo=a, hi=b) for k, (a, b) in spans.items()}
        ok = (r["to2023"]["mult"] > 1 and r["from2024"]["mult"] > 1 and r["last12m"]["mult"] > 1 and r["all"]["trades"] >= 30
              and r["all"]["worstFallPct"] < hold["all"]["worstFallPct"])
        rows.append({"family": family, "rule": name, "ok": ok, **{k: v for k, v in r.items()}})
    return {"hold": hold, "rows": rows}


def carry(f):
    """What a short perpetual was paid (plus) or paid out (minus) in funding, by calendar year, in % of the position."""
    years, month = {}, {}
    for t, rate in zip(f["t"], f["rate"]):
        g = time.gmtime(t / 1000)
        years[g.tm_year] = years.get(g.tm_year, 0.0) + rate
        month[(g.tm_year, g.tm_mon)] = month.get((g.tm_year, g.tm_mon), 0.0) + rate
    return {"pctByYear": {y: round(v * 100, 2) for y, v in sorted(years.items())}, "periods": len(f["t"]),
            "negativePeriodsPct": round(100 * sum(1 for x in f["rate"] if x < 0) / len(f["rate"])),
            "worstMonthPct": round(min(month.values()) * 100, 2), "bestMonthPct": round(max(month.values()) * 100, 2)}


def show(sym, s):
    h = s["hold"]
    print(f"\n== {sym}  (just holding: x{h['all']['mult']} in {h['all']['years']} y, worst fall {h['all']['worstFallPct']}%; "
          f"to 2023 x{h['to2023']['mult']}, from 2024 x{h['from2024']['mult']}, last 12 m x{h['last12m']['mult']})")
    print(f"{'rule':22} {'ok':3} {'all':>7} {'%/yr':>6} {'fall%':>6} {'trades':>6} {'won%':>5} {'avg%':>6} {'in%':>4} | {'to2023':>7} {'2024+':>7} {'last12m':>7}")
    for r in s["rows"]:
        a = r["all"]
        print(f"{r['rule']:22} {'YES' if r['ok'] else '':3} {a['mult']:>7} {str(a['pctPerYear']):>6} {a['worstFallPct']:>6} {a['trades']:>6} {str(a['wonPct']):>5} "
              f"{str(a['avgTradePct']):>6} {str(a['inMarketPct']):>4} | {r['to2023']['mult']:>7} {r['from2024']['mult']:>7} {r['last12m']['mult']:>7}")
    for fam in dict.fromkeys(r["family"] for r in s["rows"]):
        rs = [r for r in s["rows"] if r["family"] == fam]
        print(f"  {fam}: {sum(1 for r in rs if r['ok'])} of {len(rs)} ok; middle rule x{statistics.median(r['all']['mult'] for r in rs):.2f} all, "
              f"x{statistics.median(r['to2023']['mult'] for r in rs):.2f} to 2023, x{statistics.median(r['from2024']['mult'] for r in rs):.2f} from 2024, "
              f"x{statistics.median(r['last12m']['mult'] for r in rs):.2f} last 12 m")


if __name__ == "__main__":
    folder = sys.argv[1]
    out = {"cost": COST, "symbols": {}, "dearer": {}, "carry": {}}
    for sym in ("SOLUSDT", "BTCUSDT", "ETHUSDT"):
        p = os.path.join(folder, "candles", f"{sym}-1h.json.gz")
        if not os.path.exists(p):
            continue
        d = load(p)
        out["symbols"][sym] = study(d)
        show(sym, out["symbols"][sym])
        dear = study(d, 0.0025)
        out["dearer"][sym] = {"ok": [r["rule"] for r in dear["rows"] if r["ok"]], "rows": dear["rows"]}
        print(f"  at 0.25% a side: ok = {out['dearer'][sym]['ok']}")
    for sym in ("SOLUSDT", "BTCUSDT", "ETHUSDT"):
        p = os.path.join(folder, "funding", f"{sym}.json.gz")
        if os.path.exists(p):
            out["carry"][sym] = carry(load(p))
            print(f"\nfunding {sym}: {out['carry'][sym]}")
    if "--json" in sys.argv:
        json.dump(out, open(sys.argv[sys.argv.index("--json") + 1], "w"))
