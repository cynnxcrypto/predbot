#!/usr/bin/env python3
"""More slow ideas on liquid crypto, tested on hourly history (12 Nov 2026). Goes beyond sol-slow-rules.py.

Why: enrique asked for more trading ideas that do not need speed. sol-slow-rules.py already showed that trend,
momentum and funding carry fail and that buying SOL after a 10% fall in a day held up. This file does NOT repeat
those; it asks what else is there, and whether the dip idea can be made to trade more often.

THE RULES BELOW WERE WRITTEN DOWN AND COMMITTED BEFORE ANY RESULT WAS SEEN.

Periods.  DEV  = 1 Jan 2021 to 31 Dec 2024 (rules are judged here first).
          HOLD = 1 Jan 2025 to today (kept untouched; only looked at with --holdout, after the DEV survivors are fixed).
          Honest note: the earlier thread already saw the plain SOL dip rule in 2025-26, so for the dip family the
          HOLD period is not perfectly clean. For every other family it is.
Costs.    0.10% a side on SOL, BTC, ETH; 0.30% a side on the small coins (JUP BONK WIF JTO RAY PYTH).
Trading.  A signal is read at the close of an hour and traded at the open of the next. One position per coin per rule.
          Long only unless the rule says "long-short" (those need a perpetual account and are for information).
Benchmark. "excess" = the trade's return before costs minus what a random purchase held for the same hours earned in
          the same period on the same coin. A long rule that only made money because the coin went up has excess 0.

Bar, fixed in advance.
  DEV  : 40+ trades, average after costs > 0, t >= 2.0, excess > 0.
  HOLD : 15+ trades, average after costs > 0, excess > 0.
  Unit : each rule is judged on the three big coins pooled ("majors") unless it names its coin. Small coins are a
         cross-check only (they start in 2024, so their DEV is one year).

The 51 rules (families A-G):
 A  dips with the market in mind                                   (hold 24 h)
    A1 mkt-dip-5 / mkt-dip-7   BTC fell 5% / 7% in 24 h -> buy SOL and ETH
    A2 own-dip                 coin fell 10% in 24 h while BTC fell less than 3% -> buy the coin
    A3 both-dip                coin fell 10% in 24 h and BTC fell 5% or more -> buy the coin
 B  calendar (every day or week, so costs bite)
    B1 hour-21-23              hold 21:00-23:00 UTC every day
    B2 asia 00-08, B3 europe 08-16, B4 us 16-24 UTC every day
    B5 weekend (Sat 00:00 - Mon 00:00 UTC), B6 weekdays (Mon 00:00 - Sat 00:00)
    B7-B13 each single weekday 00:00-24:00 UTC
 C  volatility
    C1 squeeze-24 / squeeze-48 close above the 24 h high after the 24 h range was in the lowest fifth of the last
                               30 days -> buy, hold 24 / 48 h
    C2 volspike-red / -green   an hour with 5x the usual (7 day) volume and a move of 2%+ down / up -> buy, hold 24 h
    C3 calm-week / wild-week   Monday 00:00 UTC: 7 day volatility below / above its 90 day median -> hold the week
 D  after funding extremes (SOL, BTC, ETH perpetual funding; buy spot)
    D1 fund-neg-24  last funding <= 0 -> hold 24 h         D2 fund-neg-72  same, hold 72 h
    D3 fund-vneg-72 last funding <= -0.01% -> hold 72 h    D4 fund-3d-neg-72 3 day average funding <= 0 -> hold 72 h
    D5 fund-hot-72  last funding >= 0.05% -> hold 72 h (expected to lose: a "stay out" signal)
 E  one coin against another
    E1 rot-best-7 / rot-best-30 / rot-worst-7 / rot-worst-30   every Monday hold the best / worst of BTC ETH SOL
                               over the last 7 / 30 days (excess is against holding all three equally)
    E2 pair-sol-8 / pair-sol-12   SOL fell 8% / 12% against BTC in 72 h -> long SOL, short BTC, 72 h (long-short)
       pair-eth-5 / pair-eth-8    ETH fell 5% / 8% against BTC in 72 h -> long ETH, short BTC, 72 h (long-short)
    E3 lag-sol-12 / lag-eth-8     the same signal as pair-sol-12 / pair-eth-8, but only buy the laggard (long only)
    E4 lead-1.5 / lead-2.5 on SOL and on ETH: BTC rose 1.5% / 2.5% in an hour and the coin rose less -> buy, hold 4 h
 F  the dip rule with a second condition (base: fell 10% in 24 h, sell at +10% or after 24 h)
    F1 dip-fund-neg   only if the last funding <= 0
    F2 dip-above-200d only if the price is above its 200 day average      F3 dip-below-200d only if below
    F4 dip-volume     only if the signal hour had 3x the usual volume
    F5 dip-scaled     the fall sized to the coin: BTC 6%, ETH 8%, SOL 10% (sell at the same size up, or after 24 h)
 G  the dip measured in the coin's own volatility (works on any coin; hold 24 h)
    G1 zdip-2.0 / zdip-2.5 / zdip-3.0   the 24 h move is 2.0 / 2.5 / 3.0 standard deviations down (30 day window)
    G2 zdip-2.5-half                    same as zdip-2.5 but sell once half the fall is won back

Usage: slow-ideas.py <folder with candles/ and funding/> [--holdout] [--json out.json]
A backtest is history, not a promise. Fifty-one rules were tried: one or two will look good by luck alone."""
import gzip, json, math, os, sys
import numpy as np
import pandas as pd

MAJORS = ["SOLUSDT", "BTCUSDT", "ETHUSDT"]
SMALLS = ["JUPUSDT", "BONKUSDT", "WIFUSDT", "JTOUSDT", "RAYUSDT", "PYTHUSDT"]
COST = {**{s: 0.0010 for s in MAJORS}, **{s: 0.0030 for s in SMALLS}}
T0 = 1609459200 // 3600
SPLIT = 1735689600 // 3600 - T0  # 1 Jan 2025 UTC, as an index on the grid


def load(folder):
    raw = {}
    for s in MAJORS + SMALLS:
        p = os.path.join(folder, "candles", f"{s}-1h.json.gz")
        if os.path.exists(p):
            raw[s] = json.loads(gzip.decompress(open(p, "rb").read()))
    n = max(r["t"][-1] for r in raw.values()) - T0 + 1
    D = {}
    for s, r in raw.items():
        a = {k: np.full(n, np.nan) for k in "ohlc"}
        a["qv"] = np.zeros(n)
        idx = np.array(r["t"]) - T0
        for k in ("o", "h", "l", "c", "qv"):
            a[k][idx] = r[k]
        c = pd.Series(a["c"])
        first = idx.min()
        cf = c.ffill()
        for k in "ohlc":  # a missing hour (exchange down) repeats the last close
            x = a[k]
            miss = np.isnan(x) & (np.arange(n) > first)
            x[miss] = cf.values[miss]
        a["first"] = first
        D[s] = a
    F = {}
    for s in MAJORS:
        p = os.path.join(folder, "funding", f"{s}.json.gz")
        if os.path.exists(p):
            f = json.loads(gzip.decompress(open(p, "rb").read()))
            F[s] = (np.array(f["t"]) // 3600000 - T0, np.array(f["rate"]))
    return D, F, n


def ret(c, h):
    out = np.full(len(c), np.nan)
    out[h:] = c[h:] / c[:-h] - 1
    return out


def events(a, sig, K, tp=None):
    """Trades for one coin. sig[i] is read at the close of hour i; buy at the open of i+1; sell at the open after the
    first close that is tp above the signal close, or after K hours. Returns (entry index, gross multiple, hours)."""
    o, c, n = a["o"], a["c"], len(a["o"])
    out, free = [], 0
    for i in np.flatnonzero(sig):
        if i < free or i + 2 >= n or np.isnan(c[i]):
            continue
        j = i + 1
        while j < i + K and j + 1 < n - 1 and not (tp is not None and c[j] >= c[i] * (1 + tp)):
            j += 1
        if j + 1 >= n:
            continue
        out.append((i + 1, o[j + 1] / o[i + 1], j - i))
        free = j + 1
    return out


class Book:
    """Collects the trades of one rule: (entry index, net return, excess return, unit)"""

    def __init__(self, D):
        self.D, self.rows = D, []
        self.mu = {}
        for s, a in D.items():
            r = a["o"][1:] / a["o"][:-1] - 1
            self.mu[s] = (np.nanmean(r[: SPLIT - 1]) if a["first"] < SPLIT - 100 else np.nan, np.nanmean(r[SPLIT:]))

    def add(self, unit, s, evs):
        c = COST[s]
        for e, g, h in evs:
            mu = self.mu[s][0 if e < SPLIT else 1]
            self.rows.append((unit, e, g * (1 - c) ** 2 - 1, g - 1 - mu * h, h))

    def raw(self, unit, e, net, excess, h):
        self.rows.append((unit, e, net, excess, h))


def stats(rows, lo, hi, years):
    x = [r for r in rows if lo <= r[1] < hi]
    if not x:
        return {"n": 0}
    net = np.array([r[2] for r in x])
    exc = np.array([r[3] for r in x])
    sd = net.std(ddof=1) if len(net) > 1 else float("nan")
    return {"n": len(x), "won": round(100 * float((net > 0).mean())), "avg": round(100 * float(net.mean()), 3),
            "t": round(float(net.mean() / (sd / math.sqrt(len(net)))), 2) if sd and sd > 0 else None,
            "excess": round(100 * float(exc.mean()), 3), "worst": round(100 * float(net.min()), 1),
            "perYear": round(len(x) / years, 1), "usdPerYear": round(100 * float(net.sum()) / years, 1),
            "hours": round(float(np.mean([r[4] for r in x])), 1)}


def build(D, F, n):
    B = {}  # rule -> Book
    hour = (np.arange(n) + T0) % 24
    dow = ((np.arange(n) + T0) // 24 + 3) % 7  # 0 = Monday
    r24 = {s: ret(D[s]["c"], 24) for s in D}
    r72 = {s: ret(D[s]["c"], 72) for s in D}
    r1 = {s: ret(D[s]["c"], 1) for s in D}
    btc24 = r24["BTCUSDT"]

    def book(name):
        B[name] = Book(D)
        return B[name]

    def fund_at(s):
        """the last funding print known at the close of each hour, and its 9 print (3 day) average"""
        idx, rate = F[s]
        last, avg = np.full(n, np.nan), np.full(n, np.nan)
        a9 = pd.Series(rate).rolling(9).mean().values
        for k, i in enumerate(idx):
            if 0 <= i < n:
                last[i], avg[i] = rate[k], a9[k]
        return pd.Series(last).ffill().values, pd.Series(avg).ffill().values, idx

    # A
    for x in (5, 7):
        b = book(f"A1 mkt-dip-{x}")
        for s in ("SOLUSDT", "ETHUSDT"):
            b.add("majors", s, events(D[s], btc24 <= -x / 100, 24))
        for s in SMALLS:
            b.add("smalls", s, events(D[s], (btc24 <= -x / 100) & ~np.isnan(D[s]["c"]), 24))
    b2, b3 = book("A2 own-dip"), book("A3 both-dip")
    for s in D:
        if s == "BTCUSDT":
            continue
        u = "majors" if s in MAJORS else "smalls"
        b2.add(u, s, events(D[s], (r24[s] <= -0.10) & (btc24 > -0.03), 24))
        b3.add(u, s, events(D[s], (r24[s] <= -0.10) & (btc24 <= -0.05), 24))

    # B
    cal = [("B1 hour-21-23", (hour == 20), 2), ("B2 asia-00-08", (hour == 23), 8), ("B3 europe-08-16", (hour == 7), 8),
           ("B4 us-16-24", (hour == 15), 8), ("B5 weekend", (hour == 23) & (dow == 4), 48), ("B6 weekdays", (hour == 23) & (dow == 6), 120)]
    names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    for k in range(7):
        cal.append((f"B{7 + k} day-{names[k]}", (hour == 23) & (dow == (k - 1) % 7), 24))
    for name, sig, K in cal:
        b = book(name)
        for s in MAJORS:
            b.add("majors", s, events(D[s], sig, K))

    # C
    for s in D:
        a = D[s]
        hi24 = pd.Series(a["h"]).rolling(24).max()
        lo24 = pd.Series(a["l"]).rolling(24).min()
        rng = ((hi24 - lo24) / pd.Series(a["c"])).shift(1)
        tight = (rng.rolling(720).rank(pct=True) <= 0.2).values
        brk = (pd.Series(a["c"]) > hi24.shift(1)).values
        vavg = pd.Series(a["qv"]).rolling(168).mean().shift(1).values
        with np.errstate(invalid="ignore", divide="ignore"):
            spike = a["qv"] >= 5 * vavg
            body = a["c"] / a["o"] - 1
        hr = pd.Series(r1[s])
        vol7 = hr.rolling(168).std()
        calm = (vol7 < vol7.rolling(2160).median()).values
        known = ~vol7.rolling(2160).median().isna().values
        monday = (hour == 23) & (dow == 6)
        u = "majors" if s in MAJORS else "smalls"
        for name, sig, K in (("C1 squeeze-24", tight & brk, 24), ("C1 squeeze-48", tight & brk, 48),
                             ("C2 volspike-red", spike & (body <= -0.02), 24), ("C2 volspike-green", spike & (body >= 0.02), 24),
                             ("C3 calm-week", monday & calm & known, 168), ("C3 wild-week", monday & ~calm & known, 168)):
            (B.get(name) or book(name)).add(u, s, events(a, sig, K))

    # D
    for s in MAJORS:
        if s not in F:
            continue
        last, avg, idx = fund_at(s)
        at = np.zeros(n, bool)
        at[idx[(idx >= 1) & (idx < n)] - 1] = True  # the close just before a funding print's hour
        lastn, avgn = np.roll(last, -1), np.roll(avg, -1)  # the print that lands at the next open
        for name, sig, K in (("D1 fund-neg-24", at & (lastn <= 0), 24), ("D2 fund-neg-72", at & (lastn <= 0), 72),
                             ("D3 fund-vneg-72", at & (lastn <= -0.0001), 72), ("D4 fund-3d-neg-72", at & (avgn <= 0), 72),
                             ("D5 fund-hot-72", at & (lastn >= 0.0005), 72)):
            (B.get(name) or book(name)).add("majors", s, events(D[s], sig, K))

    # E1 rotation, weekly, Monday 00:00 UTC
    mondays = [i for i in np.flatnonzero((hour == 0) & (dow == 0)) if i >= 720 and i + 168 < n]
    for look, tag in ((168, 7), (720, 30)):
        for pick, word in ((np.argmax, "best"), (np.argmin, "worst")):
            b, prev = book(f"E1 rot-{word}-{tag}"), None
            for i in mondays:
                past = [D[s]["o"][i] / D[s]["o"][i - look] - 1 for s in MAJORS]
                fwd = [D[s]["o"][i + 168] / D[s]["o"][i] - 1 for s in MAJORS]
                k = int(pick(past))
                cost = 0.002 if k != prev else 0.0
                b.raw("majors", i, fwd[k] - cost, fwd[k] - float(np.mean(fwd)), 168)
                prev = k
    # E2 pairs (long-short) and E3 laggard only
    for s, xs, lagx in (("SOLUSDT", (8, 12), 12), ("ETHUSDT", (5, 8), 8)):
        rel = (1 + r72[s]) / (1 + r72["BTCUSDT"]) - 1
        short = s[:3].lower()
        for x in xs:
            b = book(f"E2 pair-{short}-{x}")
            for e, g, h in events(D[s], rel <= -x / 100, 72):
                gb = D["BTCUSDT"]["o"][e + h] / D["BTCUSDT"]["o"][e]
                b.raw(s, e, (g - gb) - 4 * 0.001, g - gb, h)
        b = book(f"E3 lag-{short}-{lagx}")
        b.add(s, s, events(D[s], rel <= -lagx / 100, 72))
    # E4 lead-lag
    for x in (1.5, 2.5):
        for s in ("SOLUSDT", "ETHUSDT"):
            b = book(f"E4 lead-{x}-{s[:3].lower()}")
            b.add(s, s, events(D[s], (r1["BTCUSDT"] >= x / 100) & (r1[s] < r1["BTCUSDT"]), 4))

    # F
    base = {s: r24[s] <= -0.10 for s in D}
    for s in D:
        a = D[s]
        u = "majors" if s in MAJORS else "smalls"
        ma = pd.Series(a["c"]).rolling(4800).mean().values
        vavg = pd.Series(a["qv"]).rolling(168).mean().shift(1).values
        with np.errstate(invalid="ignore"):
            above, below, vol3 = a["c"] > ma, a["c"] < ma, a["qv"] >= 3 * vavg
        (B.get("F2 dip-above-200d") or book("F2 dip-above-200d")).add(u, s, events(a, base[s] & above, 24, 0.10))
        (B.get("F3 dip-below-200d") or book("F3 dip-below-200d")).add(u, s, events(a, base[s] & below, 24, 0.10))
        (B.get("F4 dip-volume") or book("F4 dip-volume")).add(u, s, events(a, base[s] & vol3, 24, 0.10))
        if s in F:
            last, _, _ = fund_at(s)
            (B.get("F1 dip-fund-neg") or book("F1 dip-fund-neg")).add(u, s, events(a, base[s] & (last <= 0), 24, 0.10))
    b = book("F5 dip-scaled")
    for s, x in (("BTCUSDT", 0.06), ("ETHUSDT", 0.08), ("SOLUSDT", 0.10)):
        b.add("majors", s, events(D[s], r24[s] <= -x, 24, x))

    # G
    for s in D:
        u = "majors" if s in MAJORS else "smalls"
        sd = pd.Series(r24[s]).rolling(720).std().shift(1).values
        with np.errstate(invalid="ignore"):
            z = r24[s] / sd
        for zz in (2.0, 2.5, 3.0):
            name = f"G1 zdip-{zz}"
            (B.get(name) or book(name)).add(u, s, events(D[s], z <= -zz, 24))
        # sell once half the fall is won back: tp differs per trade, so walk by hand
        name = "G2 zdip-2.5-half"
        bk = B.get(name) or book(name)
        a, free, evs = D[s], 0, []
        for i in np.flatnonzero(z <= -2.5):
            if i < free or i + 26 >= n:
                continue
            target = a["c"][i] + (a["c"][i - 24] - a["c"][i]) / 2
            j = i + 1
            while j < i + 24 and a["c"][j] < target:
                j += 1
            evs.append((i + 1, a["o"][j + 1] / a["o"][i + 1], j - i))
            free = j + 1
        bk.add(u, s, evs)
    return B


def main():
    folder = sys.argv[1]
    holdout = "--holdout" in sys.argv
    D, F, n = load(folder)
    B = build(D, F, n)
    ydev, yhold = SPLIT / 8760, (n - SPLIT) / 8760
    out, passed = {}, []
    print(f"hours {n}, DEV {ydev:.2f} y, HOLD {yhold:.2f} y, rules {len(B)}")
    print(f"{'rule':22} {'unit':8} | DEV {'n':>5} {'won':>4} {'avg%':>7} {'t':>6} {'exc%':>7} {'worst':>6} {'/yr':>6} {'$/yr':>7} {'':4}" + (f" | HOLD {'n':>5} {'won':>4} {'avg%':>7} {'t':>6} {'exc%':>7} {'worst':>6} {'/yr':>6} {'$/yr':>7}" if holdout else ""))
    for name, b in B.items():
        for unit in dict.fromkeys(r[0] for r in b.rows):
            rows = [r for r in b.rows if r[0] == unit]
            d = stats(rows, 0, SPLIT, ydev if unit != "smalls" else 1.0)
            h = stats(rows, SPLIT, n, yhold)
            ok = unit != "smalls" and d["n"] >= 40 and d["avg"] > 0 and (d["t"] or 0) >= 2.0 and d["excess"] > 0
            okh = ok and h["n"] >= 15 and h["avg"] > 0 and h["excess"] > 0
            if ok:
                passed.append((name, unit))
            out[f"{name}|{unit}"] = {"dev": d, "hold": h if holdout else None, "devOk": ok, "holdOk": okh if holdout else None}
            f = lambda s: (f"{s['n']:>5} {s['won']:>4} {s['avg']:>7} {str(s['t']):>6} {s['excess']:>7} {s['worst']:>6} {s['perYear']:>6} {s['usdPerYear']:>7}" if s["n"] else f"{0:>5}" + " " * 50)
            line = f"{name:22} {unit[:8]:8} |     {f(d)} {'DEV+' if ok else '':4}"
            if holdout:
                line += f" |      {f(h)} {'HOLD+' if okh else ''}"
            print(line)
    print(f"\npassed DEV: {len(passed)} of {len(B)} rules: {passed}")
    if "--json" in sys.argv:
        json.dump(out, open(sys.argv[sys.argv.index("--json") + 1], "w"), indent=1)


if __name__ == "__main__":
    main()
