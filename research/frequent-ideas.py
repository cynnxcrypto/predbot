#!/usr/bin/env python3
"""Rules that trade OFTEN, on hourly history (12 Nov 2026). Follows slow-ideas.py.

Why: enrique does not want a bot that trades ten times a year. The market-fall rule held on history but is rare.
This asks: is there anything that trades every day or more, needs no speed, and survives costs?

THE RULES BELOW WERE WRITTEN DOWN AND COMMITTED BEFORE ANY RESULT WAS SEEN.
Same set-up as slow-ideas.py: DEV 2021-24, HOLD 2025-26 opened once; 0.10% a side on SOL BTC ETH, 0.30% on the
small coins; signal at an hourly close, trade at the next open; one position per coin per rule; long only.
"big" = SOL, BTC, ETH pooled. "small" = JUP BONK WIF JTO RAY PYTH pooled (cross-check; they start in 2024).
Two extra columns: "gross" = average before any cost (is there a raw effect at all?) and t(days) = the t value with
all trades of one day counted as one bet.

Bar, fixed in advance (for "big"):
  DEV  : 365+ trades a year pooled (it must trade daily), average after costs > 0, t(days) >= 2, excess > 0.
  HOLD : average after costs > 0, excess > 0.
A rule that passes everything except "trades daily" is listed as "rare".

The 30 rules:
 H1 drop-X-Kh    the coin fell X% in one hour -> buy, hold K h.      X = 1 2 3, K = 1 4            (6)
 H2 pop-X-Kh     the coin rose X% in one hour -> buy, hold K h.      X = 1 2, K = 1 4              (4)
 H3 drop4-X      the coin fell X% in 4 h -> buy, hold 4 h.           X = 3 5                       (2)
 H4 btc1-X       BTC fell X% in one hour -> buy every other coin, hold 4 h.   X = 1 2              (2)
    btc4-X-Kh    BTC fell X% in 4 h -> buy every other coin, hold K h.   X = 2 3, K = 4 12         (4)
 H5 lag4         the coin did 1.5% worse than BTC over 4 h -> buy, hold 4 h                        (1)
    worst-4h / best-4h    every 4 h buy the worst / best of all listed coins over the last 4 h, hold 4 h   (2)
    worst-24h / best-24h  every day 00:00 UTC buy the worst / best over the last 24 h, hold 24 h          (2)
 H6 updip / downdip   hour drop of 1% while the price is above / below its 24 h average -> buy, hold 4 h  (2)
 H7 band-low     close 2 standard deviations under the 24 h average -> buy, sell at the average or after 12 h (1)
    band-high    close 2 standard deviations over the 24 h average -> buy, hold 12 h               (1)
 H8 red3 / green3   three falling / rising hours in a row adding to 2%+ -> buy, hold 2 h           (2)
 H9 night-dip    the coin fell 2% between 00:00 and 08:00 UTC -> buy at 08:00, sell at 16:00       (1)

Usage: frequent-ideas.py <folder> [--holdout]"""
import importlib.util, os, sys
import numpy as np
import pandas as pd

spec = importlib.util.spec_from_file_location("si", os.path.join(os.path.dirname(os.path.abspath(__file__)), "slow-ideas.py"))
si = importlib.util.module_from_spec(spec); spec.loader.exec_module(si)
D, F, n = si.load(sys.argv[1])
HOLD = "--holdout" in sys.argv
SPLIT, T0 = si.SPLIT, si.T0
hour = (np.arange(n) + T0) % 24
R = {h: {s: si.ret(D[s]["c"], h) for s in D} for h in (1, 4, 8, 24)}
MU = si.Book(D).mu
RULES = {}  # name -> list of (sym, entry, gross, hours)


def add(name, s, sig, K, tp=None):
    RULES.setdefault(name, []).extend((s, e, g, h) for e, g, h in si.events(D[s], sig, K, tp))


with np.errstate(invalid="ignore"):
    for s in D:
        a, c = D[s], pd.Series(D[s]["c"])
        r1, r4 = R[1][s], R[4][s]
        b1, b4 = R[1]["BTCUSDT"], R[4]["BTCUSDT"]
        live = ~np.isnan(a["c"])
        for x in (1, 2, 3):
            for K in (1, 4):
                add(f"H1 drop-{x}-{K}h", s, r1 <= -x / 100, K)
        for x in (1, 2):
            for K in (1, 4):
                add(f"H2 pop-{x}-{K}h", s, r1 >= x / 100, K)
        for x in (3, 5):
            add(f"H3 drop4-{x}", s, r4 <= -x / 100, 4)
        if s != "BTCUSDT":
            for x in (1, 2):
                add(f"H4 btc1-{x}", s, (b1 <= -x / 100) & live, 4)
            for x in (2, 3):
                for K in (4, 12):
                    add(f"H4 btc4-{x}-{K}h", s, (b4 <= -x / 100) & live, K)
            add("H5 lag4", s, (1 + r4) / (1 + b4) - 1 <= -0.015, 4)
        ma, sd = c.rolling(24).mean().values, c.rolling(24).std().values
        add("H6 updip", s, (r1 <= -0.01) & (a["c"] > ma), 4)
        add("H6 downdip", s, (r1 <= -0.01) & (a["c"] < ma), 4)
        # band-low: sell at the average (moving target), so walk by hand
        free, evs = 0, []
        for i in np.flatnonzero(a["c"] < ma - 2 * sd):
            if i < free or i + 14 >= n:
                continue
            j = i + 1
            while j < i + 12 and a["c"][j] < ma[j]:
                j += 1
            evs.append((s, i + 1, a["o"][j + 1] / a["o"][i + 1], j - i)); free = j + 1
        RULES.setdefault("H7 band-low", []).extend(evs)
        add("H7 band-high", s, a["c"] > ma + 2 * sd, 12)
        red = (r1 < 0) & (np.roll(r1, 1) < 0) & (np.roll(r1, 2) < 0)
        green = (r1 > 0) & (np.roll(r1, 1) > 0) & (np.roll(r1, 2) > 0)
        r3 = si.ret(a["c"], 3)
        add("H8 red3", s, red & (r3 <= -0.02), 2)
        add("H8 green3", s, green & (r3 >= 0.02), 2)
        add("H9 night-dip", s, (hour == 7) & (R[8][s] <= -0.02), 8)
    # cross-section
    syms = list(D)
    for look, step, tag in ((4, 4, "4h"), (24, 24, "24h")):
        M = np.array([R[look][s] for s in syms])
        for i in np.flatnonzero((hour % step) == step - 1):
            col = M[:, i]
            if np.isnan(col[:3]).any() or i + step + 2 >= n:
                continue
            for word, k in (("worst", int(np.nanargmin(col))), ("best", int(np.nanargmax(col)))):
                s = syms[k]
                RULES.setdefault(f"H5 {word}-{tag}", []).append((s, i + 1, D[s]["o"][i + 1 + step] / D[s]["o"][i + 1], step))


def stats(tr, years):
    if len(tr) < 3:
        return None
    net = np.array([g * (1 - si.COST[s]) ** 2 - 1 for s, e, g, h in tr])
    gross = np.array([g - 1 for s, e, g, h in tr])
    exc = np.array([g - 1 - MU[s][0 if e < SPLIT else 1] * h for s, e, g, h in tr])
    days = {}
    for (s, e, g, h), x in zip(tr, net):
        days.setdefault((e + T0) // 24, []).append(x)
    dm = np.array([np.mean(v) for v in days.values()])
    td = dm.mean() / (dm.std(ddof=1) / np.sqrt(len(dm))) if len(dm) > 2 else float("nan")
    return {"n": len(net), "yr": len(net) / years, "won": 100 * (net > 0).mean(), "avg": 100 * net.mean(), "gross": 100 * gross.mean(),
            "exc": 100 * np.nanmean(exc), "td": td, "usd": 100 * net.sum() / years}


def fmt(x):
    return f"{x['n']:6} {x['yr']:6.0f} {x['won']:4.0f} {x['gross']:+6.2f} {x['avg']:+6.2f} {x['exc']:+6.2f} {x['td']:6.2f} {x['usd']:+8.0f}" if x else " " * 55


ydev, yhold = SPLIT / 8760, (n - SPLIT) / 8760
head = f"{'n':>6} {'/yr':>6} {'won':>4} {'gross':>6} {'net%':>6} {'exc%':>6} {'t(d)':>6} {'$/yr':>8}"
print(f"{'rule':16} {'unit':5} | DEV  {head}      " + (f"| HOLD {head}" if HOLD else ""))
passed = []
for name, tr in RULES.items():
    for unit, coins, yd in (("big", si.MAJORS, ydev), ("small", si.SMALLS, 1.0)):
        sub = [t for t in tr if t[0] in coins]
        d, h = stats([t for t in sub if t[1] < SPLIT], yd), stats([t for t in sub if t[1] >= SPLIT], yhold)
        edge = bool(d) and d["avg"] > 0 and d["td"] >= 2 and d["exc"] > 0
        tag = ("DEV+" if d["yr"] >= 365 else "rare") if (edge and unit == "big") else ""
        if tag:
            passed.append((name, tag))
        line = f"{name:16} {unit:5} |      {fmt(d)} {tag:4} "
        if HOLD:
            line += f"|      {fmt(h)} " + ("HOLD+" if tag and h and h["avg"] > 0 and h["exc"] > 0 else "")
        print(line)
print(f"\nrules {len(RULES)}; passed DEV on the big coins: {passed}")
