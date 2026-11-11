#!/usr/bin/env python3
"""Frequent rules, last check: 5-minute candles and 20 more coins (12 Nov 2026). Follows frequent-ideas.py.

frequent-ideas.py found that no hourly rule that trades daily survives costs on 9 coins. Two things could still
change that: finer candles (minutes) and more coins (more signals a day). This file settles it.

THE RULES BELOW WERE WRITTEN DOWN AND COMMITTED BEFORE THE DATA EXISTED (collector v2 had not run yet).

Part A  5-minute candles, SOL BTC ETH, from 1 Jan 2024.   DEV = 2024, HOLD = 2025-26 (opened once, with --holdout).
  M1 drop15-X-K   the coin fell X% in 15 minutes -> buy, hold K.       X = 0.5 1 2, K = 15 m, 60 m      (6)
  M2 pop15-X-K    the coin rose X% in 15 minutes -> buy, hold K.       X = 0.5 1,   K = 15 m, 60 m      (4)
  M3 btc15-X      BTC fell X% in 15 minutes -> buy SOL and ETH, hold 60 m.   X = 0.5 1                  (2)
  M4 catchup      BTC rose 0.5% in 15 minutes and the coin rose less than half of that -> buy, hold 30 m (1)
  M5 drop60-X-K   the coin fell X% in 60 minutes -> buy, hold K.       X = 1.5 3,   K = 60 m, 240 m     (4)
  M6 band4h       close 2.5 standard deviations under the 4 hour average -> buy, sell at the average or after 2 h (1)
Part B  hourly candles, 20 more big coins plus SOL BTC ETH (23 coins), from 1 Jan 2023.   DEV = 2023-24, HOLD = 2025-26.
  N1 x-worst-4h / x-best-4h / x-worst-24h / x-best-24h   every 4 h / every day buy the 3 worst / best coins of the
                  last 4 h / 24 h, hold 4 h / 24 h                                                      (4)
  N2 x-worst-7d / x-best-7d   every Monday buy the 3 worst / best of the last 7 days, hold a week       (2)
  N3 all-drop4-3 / all-drop4-5   any coin fell 3% / 5% in 4 h -> buy it, hold 4 h                       (2)
  N4 all-btc4-2 / all-btc4-3  BTC fell 2% in 4 h -> buy every coin, hold 4 h / BTC fell 3% -> hold 12 h (2)
  N5 own-fall-5   the coin fell 5% in 24 h while BTC lost less than 1% -> buy, hold 24 h                (1)
     own-rise-5   the coin rose 5% in 24 h while BTC gained less than 1% -> buy, hold 24 h              (1)
30 rules. Cost 0.10% a side everywhere (these are the most traded coins on a big exchange; note that the 20 extra
coins cannot be bought on Solana, so they would need an exchange account).
Signal at a close, trade at the next open, one position per coin per rule, long only.
"gross" = before any cost. t(d) = t value with all trades of one day counted as one bet.

Bar, fixed in advance:
  DEV  : 365+ trades a year, average after costs > 0, t(d) >= 2, better than a random purchase.
  HOLD : average after costs > 0, better than a random purchase.

Usage: frequent-ideas-2.py <folder> [--holdout]"""
import gzip, json, os, sys
import numpy as np
import pandas as pd

COST = 0.0010
BIG = ["SOLUSDT", "BTCUSDT", "ETHUSDT"]
MORE = ["XRPUSDT", "DOGEUSDT", "BNBUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "SUIUSDT", "TRXUSDT", "LTCUSDT", "DOTUSDT", "NEARUSDT",
        "APTUSDT", "ARBUSDT", "OPUSDT", "PEPEUSDT", "SHIBUSDT", "UNIUSDT", "AAVEUSDT", "INJUSDT", "TIAUSDT"]
HOLDOUT = "--holdout" in sys.argv
SPLIT_S = 1735689600  # 1 Jan 2025 UTC


def load(folder, syms, tag, step_s, start_s):
    """arrays on one grid of step_s seconds starting at start_s; missing bars repeat the last close"""
    raw = {}
    for s in syms:
        p = os.path.join(folder, "candles", f"{s}-{tag}.json.gz")
        if os.path.exists(p):
            raw[s] = json.loads(gzip.decompress(open(p, "rb").read()))
    t0 = start_s // step_s
    n = max(r["t"][-1] for r in raw.values()) - t0 + 1
    D = {}
    for s, r in raw.items():
        idx = np.array(r["t"]) - t0
        keep = idx >= 0
        a = {}
        for k in "ohlc":
            x = np.full(n, np.nan)
            x[idx[keep]] = np.array(r[k])[keep]
            a[k] = x
        cf = pd.Series(a["c"]).ffill().values
        for k in "ohlc":
            miss = np.isnan(a[k])
            a[k][miss] = cf[miss]
        D[s] = a
    return D, n, t0


def ret(c, h):
    out = np.full(len(c), np.nan)
    out[h:] = c[h:] / c[:-h] - 1
    return out


def events(a, sig, K, tp=None):
    o, c, n = a["o"], a["c"], len(a["o"])
    out, free = [], 0
    for i in np.flatnonzero(sig):
        if i < free or i + K + 2 >= n or np.isnan(c[i]) or np.isnan(o[i + 1]):
            continue
        out.append((i + 1, o[i + 1 + K] / o[i + 1], K))
        free = i + K + 1
    return out


def table(title, RULES, D, n, t0, step_s):
    split = SPLIT_S // step_s - t0
    per_day = 86400 // step_s
    ydev, yhold = split / (per_day * 365), (n - split) / (per_day * 365)
    mu = {}
    for s, a in D.items():
        r = a["o"][1:] / a["o"][:-1] - 1
        mu[s] = (np.nanmean(r[: split - 1]), np.nanmean(r[split:]))

    def stats(tr, years):
        if len(tr) < 3:
            return None
        g = np.array([x[2] for x in tr])
        net = g * (1 - COST) ** 2 - 1
        exc = np.array([x[2] - 1 - mu[x[0]][0 if x[1] < split else 1] * x[3] for x in tr])
        days = {}
        for x, v in zip(tr, net):
            days.setdefault((x[1] + t0) // per_day, []).append(v)
        dm = np.array([np.mean(v) for v in days.values()])
        td = dm.mean() / (dm.std(ddof=1) / np.sqrt(len(dm))) if len(dm) > 2 else float("nan")
        return {"n": len(tr), "yr": len(tr) / years, "won": 100 * (net > 0).mean(), "gross": 100 * (g.mean() - 1), "avg": 100 * net.mean(),
                "exc": 100 * exc.mean(), "td": td, "usd": 100 * net.sum() / years}

    fmt = lambda x: (f"{x['n']:7} {x['yr']:6.0f} {x['won']:4.0f} {x['gross']:+7.3f} {x['avg']:+7.3f} {x['exc']:+7.3f} {x['td']:6.2f} {x['usd']:+8.0f}" if x else " " * 59)
    head = f"{'n':>7} {'/yr':>6} {'won':>4} {'gross%':>7} {'net%':>7} {'exc%':>7} {'t(d)':>6} {'$/yr':>8}"
    print(f"\n== {title}: DEV {ydev:.2f} y, HOLD {yhold:.2f} y, coins {len(D)}")
    print(f"{'rule':18} | DEV  {head}      " + (f"| HOLD {head}" if HOLDOUT else ""))
    passed = []
    for name, tr in RULES.items():
        d, h = stats([x for x in tr if x[1] < split], ydev), stats([x for x in tr if x[1] >= split], yhold)
        edge = bool(d) and d["avg"] > 0 and d["td"] >= 2 and d["exc"] > 0
        tag = ("DEV+" if d["yr"] >= 365 else "rare") if edge else ""
        if tag:
            passed.append((name, tag))
        line = f"{name:18} |      {fmt(d)} {tag:4} "
        if HOLDOUT:
            line += f"|      {fmt(h)} " + ("HOLD+" if tag and h and h["avg"] > 0 and h["exc"] > 0 else "")
        print(line)
    print(f"passed DEV: {passed}")


def part_a(folder):
    D, n, t0 = load(folder, BIG, "5m", 300, 1704067200)
    if len(D) < 3:
        print("part A: 5-minute files missing"); return
    R = {}

    def add(name, s, sig, K):
        R.setdefault(name, []).extend((s, e, g, h) for e, g, h in events(D[s], sig, K))

    with np.errstate(invalid="ignore"):
        b3 = ret(D["BTCUSDT"]["c"], 3)
        for s in BIG:
            a = D[s]
            r3, r12 = ret(a["c"], 3), ret(a["c"], 12)
            for x in (0.5, 1, 2):
                for K, kt in ((3, "15m"), (12, "60m")):
                    add(f"M1 drop15-{x}-{kt}", s, r3 <= -x / 100, K)
            for x in (0.5, 1):
                for K, kt in ((3, "15m"), (12, "60m")):
                    add(f"M2 pop15-{x}-{kt}", s, r3 >= x / 100, K)
            if s != "BTCUSDT":
                for x in (0.5, 1):
                    add(f"M3 btc15-{x}", s, b3 <= -x / 100, 12)
                add("M4 catchup", s, (b3 >= 0.005) & (r3 < b3 / 2), 6)
            for x in (1.5, 3):
                for K, kt in ((12, "60m"), (48, "240m")):
                    add(f"M5 drop60-{x}-{kt}", s, r12 <= -x / 100, K)
            c = pd.Series(a["c"])
            ma, sd = c.rolling(48).mean().values, c.rolling(48).std().values
            free, evs = 0, []
            for i in np.flatnonzero(a["c"] < ma - 2.5 * sd):
                if i < free or i + 27 >= n:
                    continue
                j = i + 1
                while j < i + 24 and a["c"][j] < ma[j]:
                    j += 1
                evs.append((s, i + 1, a["o"][j + 1] / a["o"][i + 1], j - i)); free = j + 1
            R.setdefault("M6 band4h", []).extend(evs)
    table("Part A, 5-minute candles, SOL BTC ETH", R, D, n, t0, 300)


def part_b(folder):
    D, n, t0 = load(folder, BIG + MORE, "1h", 3600, 1672531200)
    if len(D) < 10:
        print(f"part B: only {len(D)} hourly files"); return
    syms = list(D)
    hour = (np.arange(n) + t0) % 24
    dow = ((np.arange(n) + t0) // 24 + 3) % 7
    R = {}

    def add(name, s, sig, K):
        R.setdefault(name, []).extend((s, e, g, h) for e, g, h in events(D[s], sig, K))

    with np.errstate(invalid="ignore"):
        r4 = {s: ret(D[s]["c"], 4) for s in syms}
        r24 = {s: ret(D[s]["c"], 24) for s in syms}
        r168 = {s: ret(D[s]["c"], 168) for s in syms}
        b4, b24 = r4["BTCUSDT"], r24["BTCUSDT"]
        for look, step, tag, when, M in ((4, 4, "4h", (hour % 4) == 3, r4), (24, 24, "24h", hour == 23, r24), (168, 168, "7d", (hour == 23) & (dow == 6), r168)):
            A = np.array([M[s] for s in syms])
            for i in np.flatnonzero(when):
                col = A[:, i]
                okk = np.flatnonzero(~np.isnan(col))
                if len(okk) < 10 or i + step + 2 >= n:
                    continue
                order = okk[np.argsort(col[okk])]
                for word, pick in (("worst", order[:3]), ("best", order[-3:])):
                    for k in pick:
                        s = syms[k]
                        R.setdefault(f"N{1 if step < 168 else 2} x-{word}-{tag}", []).append((s, i + 1, D[s]["o"][i + 1 + step] / D[s]["o"][i + 1], step))
        for s in syms:
            live = ~np.isnan(D[s]["c"])
            add("N3 all-drop4-3", s, r4[s] <= -0.03, 4)
            add("N3 all-drop4-5", s, r4[s] <= -0.05, 4)
            if s != "BTCUSDT":
                add("N4 all-btc4-2", s, (b4 <= -0.02) & live, 4)
                add("N4 all-btc4-3", s, (b4 <= -0.03) & live, 12)
                add("N5 own-fall-5", s, (r24[s] <= -0.05) & (b24 > -0.01), 24)
                add("N5 own-rise-5", s, (r24[s] >= 0.05) & (b24 < 0.01), 24)
    table("Part B, hourly candles, 23 coins", R, D, n, t0, 3600)


if __name__ == "__main__":
    part_a(sys.argv[1])
    part_b(sys.argv[1])
