#!/usr/bin/env python3
"""Leverage tiers and the confidence score on past prices (15 Nov 2026 KST).

enrique: "are we testing longs and shorts? and variable leverage? 2x is gonna be almost nothing ... build a way to
decide confidence on the trade to do variable leverage".

The 12 perp paper rules of src/solana/buckets.ts (7 old, 5 long mirrors), on SOL, BTC, ETH hourly candles.
Fixed before any result: the rules, Jupiter Perps costs (0.07% a side, borrow 0.0016% an hour), the tiers, the
liquidation rule and the confidence score - all the same as the live paper code.
  Fill: signal at a candle's close, trade at the NEXT candle's open.
  Liquidation at leverage L: the price went against the trade by 1/L - fees - borrow - 0.2% at any hourly high/low
  while it was open -> the whole collateral is lost. Otherwise result on collateral = L x result on the position.
  Confidence 0-3 here (the live score has a 4th point, "copied traders lean the same way", which has no history):
  7-day trend agrees, 30-day trend agrees, last 24 h range under the median of the 30 days before.
  Leverage by score: 1.5, 2.5, 4, 6.5 (10x needs the 4th point).
  python3 research/perps-leverage.py <dir with candles/>
"""
import gzip, json, os, sys
import numpy as np

D = sys.argv[1] if len(sys.argv) > 1 else "."
FEE, BORROW, BUF = 0.0007, 0.000016, 0.002
TIERS = [1.5, 2, 3, 5, 7.5, 10, 15, 20]
CONF_LEV = [1.5, 2.5, 4, 6.5, 10]
SPLIT_H = 482136  # 1 Jan 2025
COLL = 20.0


def load(sym):
    d = json.load(gzip.open(os.path.join(D, "candles", f"{sym}USDT-1h.json.gz")))
    return {k: np.array(d[k], dtype=float) for k in "tohlc"}


def cr(c, n):
    out = np.full(len(c), np.nan)
    out[n:] = c[n:] / c[:-n] - 1
    return out


def rules(k):
    c, t = k["c"], k["t"]
    r1, r24, r168, r720 = cr(c, 1), cr(c, 24), cr(c, 168), cr(c, 720)
    ma168 = np.convolve(c, np.ones(168) / 168, "full")[: len(c)]
    ma168[:167] = np.nan
    n = len(c)
    hi24 = np.full(n, np.nan); lo24 = np.full(n, np.nan)
    for i in range(24, n):
        hi24[i] = k["h"][i - 24:i].max(); lo24[i] = k["l"][i - 24:i].min()
    day = (t % 24 == 23)
    z = np.zeros(n)
    S = lambda cond, d: np.where(cond, d, 0)
    return {
        "short-down-week": (168, False, S(day & (r168 < 0) & (r720 < 0), -1)),
        "short-bounce-falling": (24, False, S((r24 >= 0.05) & (r720 < -0.1), -1)),
        "short-bounce-under-avg": (12, False, S((r24 >= 0.03) & (c < ma168), -1)),
        "trend-7d": (168, False, np.where(t % 168 == 167, np.sign(np.nan_to_num(r168)), 0)),
        "break-24h": (720, True, np.where(c >= hi24, 1, np.where(c <= lo24, -1, 0))),
        "short-pump-1h": (4, False, S(r1 >= 0.015, -1)),
        "short-fall-1h": (4, False, S(r1 <= -0.015, -1)),
        "long-up-week": (168, False, S(day & (r168 > 0) & (r720 > 0), 1)),
        "long-dip-rising": (24, False, S((r24 <= -0.05) & (r720 > 0.1), 1)),
        "long-dip-over-avg": (12, False, S((r24 <= -0.03) & (c > ma168), 1)),
        "long-fall-1h": (4, False, S(r1 <= -0.015, 1)),
        "long-pump-1h": (4, False, S(r1 >= 0.015, 1)),
    }, (r168, r720)


def conf(k, i, d, r168, r720, quiet):
    return int(np.sign(r168[i]) == d) + int(np.sign(r720[i]) == d) + int(quiet[i])


def run(sym):
    k = load(sym)
    o, h, l, c, t = k["o"], k["h"], k["l"], k["c"], k["t"]
    n = len(c)
    rs, (r168, r720) = rules(k)
    # quiet: last 24 h range under the median of the 30 days before
    rng = np.full(n, np.nan)
    for i in range(23, n):
        rng[i] = (h[i - 23:i + 1].max() - l[i - 23:i + 1].min()) / c[i]
    quiet = np.zeros(n, dtype=bool)
    for i in range(31 * 24, n):
        quiet[i] = rng[i] < np.median(rng[i - 24 * np.arange(1, 31)])
    out = []
    for name, (hold, flip, sig) in rs.items():
        pos = None  # (dir, entry index, entry price, conf)
        for i in range(31 * 24, n - 1):
            s = int(sig[i])
            if pos and (i - pos[1] + 1 >= hold or (flip and s != 0 and s != pos[0])):
                d, e, px, cf = pos
                ex = o[i + 1]
                hours = i + 1 - e
                net = d * (ex / px - 1) - 2 * FEE - BORROW * hours
                worst = max(0.0, (1 - l[e:i + 1].min() / px) if d > 0 else (h[e:i + 1].max() / px - 1))
                out.append((t[e], name, d, net, worst, hours, cf))
                pos = None
            if s != 0 and pos is None:
                pos = (s, i + 1, o[i + 1], conf(k, i, s, r168, r720, quiet))
    return out


def lev_ret(net, worst, hours, L):
    if worst >= 1 / L - 2 * FEE - BORROW * hours - BUF:
        return -1.0, True
    return max(-1.0, L * net), False


def line(label, xs, levf):
    if not xs:
        return f"  {label:<26} no trades"
    rr = [lev_ret(x[3], x[4], x[5], levf(x)) for x in xs]
    ret = np.array([a for a, _ in rr])
    liq = sum(b for _, b in rr)
    return f"  {label:<26} {len(xs):>6} trades  won {100 * (ret > 0).mean():5.1f}%  liquidated {100 * liq / len(xs):5.1f}%  avg {100 * ret.mean():+7.2f}% of collateral  total ${COLL * ret.sum():+10.0f}"


ALL = [x for s in ("SOL", "BTC", "ETH") for x in run(s)]
for title, sel in (("UP TO 2024", lambda x: x[0] < SPLIT_H), ("2025-26", lambda x: x[0] >= SPLIT_H)):
    xs = [x for x in ALL if sel(x)]
    print(f"\n===== {title}: {len(xs)} trades, 12 rules x SOL BTC ETH, ${COLL:.0f} collateral a trade =====")
    for side, f in (("all", lambda x: True), ("longs", lambda x: x[2] > 0), ("shorts", lambda x: x[2] < 0)):
        ys = [x for x in xs if f(x)]
        print(f" {side}: avg at 1x {100 * np.mean([y[3] for y in ys]):+.3f}% of the position")
        for L in TIERS:
            print(line(f"{L}x", ys, lambda x, L=L: L))
    print(" by confidence score (leverage the score sets)")
    for sc in range(4):
        ys = [x for x in xs if x[6] == sc]
        if ys:
            print(f"  score {sc}: {len(ys)} trades, at 1x avg {100 * np.mean([y[3] for y in ys]):+.3f}%, won {100 * np.mean([y[3] > 0 for y in ys]):.1f}%")
            print(line(f"   at {CONF_LEV[sc]}x", ys, lambda x, sc=sc: CONF_LEV[sc]))
    print(line("variable (by score)", xs, lambda x: CONF_LEV[x[6]]))
    print(" by rule, 2025-26 style: avg at 1x / at 5x / at 10x (liquidated share at 10x)")
    for name in sorted({x[1] for x in xs}):
        ys = [x for x in xs if x[1] == name]
        a5 = np.mean([lev_ret(y[3], y[4], y[5], 5)[0] for y in ys]); r10 = [lev_ret(y[3], y[4], y[5], 10) for y in ys]
        print(f"  {name:<24} {len(ys):>5}  1x {100 * np.mean([y[3] for y in ys]):+6.2f}%  5x {100 * a5:+7.2f}%  10x {100 * np.mean([a for a, _ in r10]):+7.2f}%  (liq {100 * np.mean([b for _, b in r10]):4.1f}%)")

# checks made after seeing the table: is score 3 one lucky stretch? By year, with the error of the average
# (trades of one day share one market, so the error is taken over daily sums, not single trades).
print("\n score 3 by year: trades, avg at 1x, at 6.5x of collateral, liquidated; t = average / its error over days")
import collections
for yr in range(2021, 2027):
    y0, y1 = (yr - 1970) * 8766, (yr - 1969) * 8766
    ys = [x for x in ALL if x[6] == 3 and y0 <= x[0] < y1]
    if not ys:
        continue
    days = collections.defaultdict(float)
    for y in ys:
        days[int(y[0] // 24)] += y[3]
    d = np.array(list(days.values()))
    tstat = d.mean() / (d.std(ddof=1) / np.sqrt(len(d))) if len(d) > 2 else float("nan")
    rr = [lev_ret(y[3], y[4], y[5], 6.5) for y in ys]
    print(f"  {yr}: {len(ys):>5}  1x {100 * np.mean([y[3] for y in ys]):+6.2f}%  6.5x {100 * np.mean([a for a, _ in rr]):+7.2f}%  liq {100 * np.mean([b for _, b in rr]):4.1f}%  longs {sum(y[2] > 0 for y in ys)}  t {tstat:+.1f}")
ys = [x for x in ALL if x[6] == 3]
print(" score 3 by rule (all years): trades, avg at 1x")
for name in sorted({x[1] for x in ys}):
    zs = [x for x in ys if x[1] == name]
    print(f"  {name:<24} {len(zs):>5}  {100 * np.mean([z[3] for z in zs]):+6.2f}%  won {100 * np.mean([z[3] > 0 for z in zs]):.0f}%")
