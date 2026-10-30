#!/usr/bin/env python3
"""Fresh-ideas check (30 Oct 2026): does a volatility model beat the book on the slow markets (15m / 1h / 4h / 24h)?

Model: P(UP) = Phi( ln(S / S0) / (sigma_1m * sqrt(minutes left)) ), S0 = Binance price at the window open, S = Binance now,
sigma_1m = stdev of Binance 1-minute log returns over the previous 6 hours. No drift. Hourly and daily markets settle on
Binance itself; 4h/15m settle on Chainlink, which tracks Binance within a few bps.

Parts:
  A  calibration: model probability bucket vs how often UP really won (is the model honest?), and the market's own calibration.
  B  "model edge" taker rule on the 14-day history (1-min UP prices, last print + slip as the ask, 7% fee formula):
     first checkpoint where model - ask >= margin; one trade per window. By margin, time-left band, side, coin, KST day.
  C  recorded 1-second books (29 Oct onward) for the 1h/4h/24h series: real spread, real ask vs model, and the same rule
     with the fillable check (same side still asks within 1c with 5+ shares 3 s later).
  D  maker version on the recorded books: rest a bid `k` under the model price (no fee); it fills if the side's best ask
     later comes down to the bid. Adverse selection shows up as a low win rate on fills.

Usage: python3 -I scripts/slowmodel.py "<Pred bot>/data"   (stdlib only; writes <data>/../slowmodel-report.txt too)
"""
import json, math, os, sys, statistics
from collections import defaultdict

DATA = sys.argv[1] if len(sys.argv) > 1 else "data"
H = os.path.join(DATA, "history")
OUT = []
def out(*a):
    line = " ".join(str(x) for x in a)
    print(line, flush=True)
    OUT.append(line)

COINS = ["btc", "eth", "sol", "xrp", "doge", "bnb", "hype"]
LENGTHS = {"15m": 900, "1h": 3600, "4h": 14400, "24h": 86400}
# checkpoint spacing per window length (seconds)
STEP = {"15m": 60, "1h": 300, "4h": 900, "24h": 3600}
VOL_MIN = 360  # minutes of 1m returns for sigma

def phi(z): return 0.5 * (1 + math.erf(z / math.sqrt(2)))
def fee_per_dollar(ask): return 0.07 * (1 - ask)  # 0.07 * shares * p * (1-p) with shares = 1/p
def pnl_per_dollar(ask, won): return (1 / ask - 1 if won else -1) - fee_per_dollar(ask)
def kst_day(sec):
    import datetime
    return datetime.datetime.fromtimestamp(sec + 9 * 3600, datetime.timezone.utc).strftime("%m-%d")

# ---------- Binance 1m ----------
bin_close, bin_open = {}, {}
def load_binance(coin):
    f = os.path.join(H, f"binance-{coin}-spot-1m.jsonl")
    c, o = {}, {}
    if os.path.exists(f):
        for line in open(f):
            try: k = json.loads(line)
            except Exception: continue
            m = int(k[0]) // 1000
            o[m], c[m] = k[1], k[4]
    # rolling sigma of 1m log returns, cumulative sums over consecutive minutes
    mins = sorted(c)
    sig = {}
    rets = []
    for i, m in enumerate(mins):
        if i and mins[i - 1] == m - 60 and c[mins[i - 1]] > 0 and c[m] > 0:
            rets.append(math.log(c[m] / c[mins[i - 1]]))
        else:
            rets.append(None)
    s1 = s2 = n = 0
    window = []
    for i, m in enumerate(mins):
        r = rets[i]
        window.append(r)
        if r is not None: s1 += r; s2 += r * r; n += 1
        if len(window) > VOL_MIN:
            old = window.pop(0)
            if old is not None: s1 -= old; s2 -= old * old; n -= 1
        if n >= VOL_MIN * 0.8:
            var = max(s2 / n - (s1 / n) ** 2, 1e-12)
            sig[m] = math.sqrt(var)
    return c, o, sig

BIN = {}
for coin in COINS:
    BIN[coin] = load_binance(coin)
    out(f"binance {coin}: {len(BIN[coin][0])} minutes")

def model_p(coin, start, t, end):
    """Model P(UP) at time t (sec, minute-aligned) for a window [start, end). None if data missing."""
    c, o, sig = BIN[coin]
    s0 = o.get(start)
    s = c.get(t - 60)
    sg = sig.get(t - 60)
    if not s0 or not s or not sg: return None
    left_min = (end - t) / 60
    if left_min <= 0: return None
    z = math.log(s / s0) / (sg * math.sqrt(left_min))
    return phi(z), z

def series_key(coin, length):
    if length == "15m": return f"{coin}15m"
    return f"{coin}{length}"

def price_at(prices, t, fresh=180):
    best = None
    for ts, p in prices:
        if ts <= t: best = (ts, p)
        else: break
    if best and t - best[0] <= fresh: return best[1]
    return None

# ---------- A + B on history ----------
SLIP = 0.01
MARGINS = [0.03, 0.05, 0.08, 0.12]
cal_model = defaultdict(lambda: defaultdict(lambda: [0, 0]))   # length -> bucket -> [n, up]
cal_mkt = defaultdict(lambda: defaultdict(lambda: [0, 0]))
trades = defaultdict(list)  # (length, margin) -> list of dict
gaps = defaultdict(list)    # length -> |model - price|

for length, wsec in LENGTHS.items():
    nwin = 0
    for coin in COINS:
        f = os.path.join(H, f"{series_key(coin, length)}-windows.jsonl")
        if not os.path.exists(f): continue
        seen = set()  # two overlapping history pulls can append the same window twice
        for line in open(f):
            try: w = json.loads(line)
            except Exception: continue
            if w.get("resolvedUp") is None: continue
            start, end, up = w["start"], w["start"] + wsec, w["resolvedUp"]
            if start in seen: continue
            seen.add(start)
            prices = sorted((int(a), float(b)) for a, b in w.get("prices", []))
            if not prices: continue
            nwin += 1
            taken = {m: False for m in MARGINS}
            step = STEP[length]
            for t in range(start + step, end, step):
                mp = model_p(coin, start, t, end)
                px = price_at(prices, t)
                if mp is None or px is None or not (0.02 <= px <= 0.98): continue
                p, z = mp
                frac_left = (end - t) / wsec
                cal_model[length][min(int(p * 10), 9)][0] += 1
                cal_model[length][min(int(p * 10), 9)][1] += up
                cal_mkt[length][min(int(px * 10), 9)][0] += 1
                cal_mkt[length][min(int(px * 10), 9)][1] += up
                gaps[length].append(p - px)
                for m in MARGINS:
                    if taken[m]: continue
                    ask_up, ask_dn = px + SLIP, (1 - px) + SLIP
                    e_up, e_dn = p - ask_up, (1 - p) - ask_dn
                    if max(e_up, e_dn) < m: continue
                    side_up = e_up >= e_dn
                    ask = ask_up if side_up else ask_dn
                    if not (0.05 <= ask <= 0.97): continue
                    won = (up == side_up)
                    trades[(length, m)].append(dict(coin=coin, start=start, ask=ask, won=won, pnl=pnl_per_dollar(ask, won),
                        frac=frac_left, fav=ask >= 0.5, edge=max(e_up, e_dn), day=kst_day(start)))
                    taken[m] = True
    out(f"history {length}: {nwin} resolved windows with prices")

out("\n== A. calibration (P(UP) bucket -> share of UP closes) ==")
for length in LENGTHS:
    if not cal_model[length]: continue
    out(f"-- {length}: model | market (last print)")
    for b in range(10):
        n1, u1 = cal_model[length][b]; n2, u2 = cal_mkt[length][b]
        out(f"  {b*10:>2}-{b*10+10}%  model n={n1:>5} up={u1/max(n1,1):.3f}   market n={n2:>5} up={u2/max(n2,1):.3f}")
    g = gaps[length]
    if g: out(f"  mean |model-price| {statistics.mean(abs(x) for x in g):.3f}, n={len(g)}")

def summarize(rows, label):
    if not rows: return
    n = len(rows); won = sum(r["won"] for r in rows); net = sum(r["pnl"] for r in rows)
    days = defaultdict(float)
    for r in rows: days[r["day"]] += r["pnl"]
    red = sum(1 for v in days.values() if v < 0)
    half = sorted(rows, key=lambda r: r["start"]); h1, h2 = half[: n // 2], half[n // 2:]
    a = sum(r["pnl"] for r in h1) / max(len(h1), 1); b = sum(r["pnl"] for r in h2) / max(len(h2), 1)
    out(f"  {label:<28} n={n:>4} won={won/n:.1%} net/$1={net/n:+.3f}  halves {a:+.3f}/{b:+.3f}  red days {red}/{len(days)}")

out("\n== B. model-edge taker rule on history (ask = last print + 1c, 7% fee, $1 stakes) ==")
for length in LENGTHS:
    for m in MARGINS:
        rows = trades[(length, m)]
        if not rows: continue
        out(f"-- {length} margin {m:.2f}")
        summarize(rows, "all")
        summarize([r for r in rows if r["fav"]], "favourite side (ask>=50c)")
        summarize([r for r in rows if not r["fav"]], "underdog side")
        for lo, hi, lab in [(0.66, 1.01, "first third"), (0.33, 0.66, "middle third"), (0, 0.33, "last third")]:
            summarize([r for r in rows if lo <= r["frac"] < hi], lab)
        if m == 0.05:
            for coin in COINS: summarize([r for r in rows if r["coin"] == coin], coin)

# ---------- C + D on recorded 1-s books ----------
out("\n== C/D. recorded 1-second books (15m/1h/4h/24h) ==")
def load_windows(prefix):
    res = {}
    d = os.path.join(DATA, f"{prefix}windows")
    if not os.path.isdir(d): return res
    for fn in sorted(os.listdir(d)):
        for line in open(os.path.join(d, fn)):
            try: w = json.loads(line)
            except Exception: continue
            if w.get("resolvedUp") is not None: res[w["window"]] = w["resolvedUp"]
    return res

for length in ["15m", "1h", "4h", "24h"]:
    wsec = LENGTHS[length]
    spreads, overs, ask_gap = [], [], []
    taker = defaultdict(list); maker = defaultdict(list)
    for coin in COINS:
        prefix = f"{series_key(coin, length)}-"
        res = load_windows(prefix)
        d = os.path.join(DATA, f"{prefix}book")
        if not os.path.isdir(d): continue
        rows_by_window = defaultdict(list)
        for fn in sorted(os.listdir(d)):
            for line in open(os.path.join(d, fn)):
                try: r = json.loads(line)
                except Exception: continue
                rows_by_window[r["window"]].append(r)
        for win, rows in rows_by_window.items():
            if win not in res: continue
            up = res[win]; end = win + wsec
            rows.sort(key=lambda r: r["t"])
            ts = [r["t"] for r in rows]
            done_t = {m: False for m in MARGINS}
            rests = {}  # k -> (side_up, price) or 'done'
            last_mark = 0
            for i, r in enumerate(rows):
                if r.get("upAsk") is None or r.get("downAsk") is None: continue
                if r.get("upBid") is not None: spreads.append(r["upAsk"] - r["upBid"])
                overs.append(r["upAsk"] + r["downAsk"] - 1)
                sec = r["t"] // 1000
                # maker fills: resting bid filled if that side's best ask comes down to it
                for k, st in list(rests.items()):
                    if st == "done": continue
                    side_up, bid = st
                    a = r["upAsk"] if side_up else r["downAsk"]
                    if a <= bid + 1e-9:
                        won = up == side_up
                        maker[k].append(dict(ask=bid, won=won, pnl=(1 / bid - 1) if won else -1, day=kst_day(win), start=win))
                        rests[k] = "done"
                if sec - last_mark < 60: continue
                last_mark = sec
                t = sec - sec % 60
                mp = model_p(coin, win, t, end)
                if mp is None and r.get("binance") and r.get("open"):
                    # fall back to the live row: Binance now vs the recorded open, sigma from history if present
                    sg = BIN[coin][2].get(t - 60) or BIN[coin][2].get(max(BIN[coin][2]) if BIN[coin][2] else 0)
                    if sg:
                        z = math.log(r["binance"] / r["open"]) / (sg * math.sqrt(max((end - sec) / 60, 1e-6)))
                        mp = (phi(z), z)
                if mp is None: continue
                p, _ = mp
                ask_gap.append(min(abs(p - r["upAsk"]), 1))
                for m in MARGINS:
                    if done_t[m]: continue
                    e_up, e_dn = p - r["upAsk"], (1 - p) - r["downAsk"]
                    if max(e_up, e_dn) < m: continue
                    side_up = e_up >= e_dn
                    ask = r["upAsk"] if side_up else r["downAsk"]
                    if not (0.05 <= ask <= 0.97): continue
                    depth = (r.get("upAsks") if side_up else r.get("downAsks")) or []
                    # fillable: 3 s later same side asks within 1c with 5+ shares
                    j = i
                    while j < len(rows) and rows[j]["t"] < r["t"] + 3000: j += 1
                    fill = False
                    if j < len(rows):
                        lst = rows[j].get("upAsks" if side_up else "downAsks") or []
                        fill = bool(lst) and lst[0][0] <= ask + 0.01 + 1e-9 and lst[0][1] >= 5
                    won = up == side_up
                    taker[m].append(dict(ask=ask, won=won, pnl=pnl_per_dollar(ask, won), fill=fill, day=kst_day(win), start=win,
                                         frac=(end - sec) / wsec, fav=ask >= 0.5))
                    done_t[m] = True
                for k in (0.03, 0.05):
                    if k in rests: continue
                    # rest on the side the model likes more, k under the model price, only if that is under the current bid+1c (a real resting bid)
                    side_up = p >= 0.5
                    fair = p if side_up else 1 - p
                    bid = round(fair - k, 2)
                    cur_bid = r.get("upBid") if side_up else r.get("downBid")
                    if 0.05 <= bid <= 0.95 and (cur_bid is None or bid <= cur_bid + 0.01) and (end - sec) / wsec > 0.1:
                        rests[k] = (side_up, bid)
    if spreads:
        out(f"-- {length}: median spread {statistics.median(spreads):.3f}, median overround {statistics.median(overs):+.3f}, median |model-ask| {statistics.median(ask_gap) if ask_gap else float('nan'):.3f}")
    for m in MARGINS:
        rows = taker[m]
        if not rows: continue
        summarize(rows, f"taker m={m:.2f} all")
        summarize([r for r in rows if r["fill"]], f"taker m={m:.2f} fillable")
        summarize([r for r in rows if r["fav"]], f"taker m={m:.2f} favourite")
    for k, rows in maker.items():
        summarize(rows, f"maker k={k:.2f} fills")

with open(os.path.join(DATA, "..", "slowmodel-report.txt"), "w") as fh:
    fh.write("\n".join(OUT) + "\n")
out("report written to slowmodel-report.txt next to data/")
