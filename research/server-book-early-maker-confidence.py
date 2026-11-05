# Round 212 (5 Nov 2026): how sure are we? Bootstrap the one-per-window 4c/30 s bid by fill and by whole KST day.
# From Round 201 (5 Nov 2026): the live maker mode fills when the ask TOUCHES our bid (someone sells at our price),
# while the R200 replay only counted a fill when the ask went strictly THROUGH the bid. Grid over bid offset,
# rest time and fill rule on the server's 1-second 15m books, ETH/SOL/BTC vs the other coins.
import json, gzip, subprocess, collections, datetime
R = "/home/claude/predbot"
coins = ['btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'hype']
days = ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']
OFFS = [0.04]
RESTS = [30]
FILL = ['touch']
D = collections.defaultdict(lambda: [0, 0, 0.0, 0])
DAY = collections.defaultdict(float)
BYW = collections.defaultdict(list)
def show(p):
    return gzip.decompress(subprocess.check_output(['git', '-C', R, 'show', f'origin/server-data:{p}'], stderr=subprocess.DEVNULL)).decode().splitlines()
for c in coins:
    g = 'BIG3' if c in ('btc', 'eth', 'sol') else 'REST'
    for d in days:
        try:
            rows = show(f'server/hist/{c}15m/{d}.jsonl.gz')
            wins = {json.loads(l)['window']: json.loads(l) for l in show(f'server/hist/{c}15m/{d}-windows.jsonl.gz')}
        except Exception:
            continue
        hdr = json.loads(rows[0]); I = {k: i for i, k in enumerate(hdr)}
        sig = {}; path = collections.defaultdict(list)
        for l in rows[1:]:
            r = json.loads(l); w = r[I['window']]
            if w not in wins or wins[w].get('resolvedUp') is None: continue
            t = r[I['t']]; t = t / 1000 if t > 1e12 else t
            if w in sig:
                up, ask0, t0 = sig[w]
                if ask0 > 0 and t - t0 <= 60:
                    a = r[I['upAsk' if up else 'downAsk']]
                    if a is not None: path[w].append((t - t0, a))
                continue
            left = r[I['left']]
            if not (720 <= left <= 870): continue
            cl, op = r[I['chainlink']], r[I['open']]
            if cl is None or not op: continue
            bp = (cl - op) / op * 1e4
            if abs(bp) < 5: continue
            up = bp > 0; ask = r[I['upAsk' if up else 'downAsk']]
            sig[w] = (up, ask if ask is not None and 0.35 <= ask <= 0.6 else -1, t)
        for w, (up, ask0, t0) in sig.items():
            if ask0 < 0: continue
            won = wins[w]['resolvedUp'] == up
            kd = datetime.datetime.fromtimestamp(w + 9 * 3600, datetime.UTC).strftime('%m-%d')
            for off in OFFS:
                bid = round(ask0 - off, 2)
                for rs in RESTS:
                    for f in FILL:
                        k = (g, off, rs, f); D[k][3] += 1
                        hit = any(dt > 0.5 and dt <= rs and (a <= bid + 1e-9 if f == 'touch' else a < bid - 1e-9) for dt, a in path[w])
                        if not hit: continue
                        pnl = (1 / bid if won else 0) - 1
                        a = D[k]; a[0] += 1; a[1] += won; a[2] += pnl
                        DAY[(g, off, rs, f, kd)] += pnl
                        if g == 'BIG3': BYW[w].append((c, won, pnl, ask0))
for k in sorted(D):
    a = D[k]
    days_g = sum(1 for kk, v in DAY.items() if kk[:4] == k and v > 0)
    print(*k, 'fills', a[0], '/', a[3], f"won {100*a[1]/max(a[0],1):.0f}%", f"{100*a[2]/max(a[0],1):+.1f}%", f"green {days_g}/{sum(1 for kk in DAY if kk[:4] == k)}")

import random, statistics, datetime as _dt
xs = [BYW[w][0][2] for w in sorted(BYW)]
dk = [_dt.datetime.fromtimestamp(w + 9 * 3600, _dt.UTC).strftime('%m-%d') for w in sorted(BYW)]
m = statistics.mean(xs); sd = statistics.stdev(xs)
print(f"fills {len(xs)} mean {100*m:+.1f}% sd {100*sd:.0f}% t {m/(sd/len(xs)**0.5):.2f}")
random.seed(1)
bs = sorted(statistics.mean(random.choices(xs, k=len(xs))) for _ in range(20000))
print(f"by fill: 90% interval {100*bs[1000]:+.1f}% .. {100*bs[19000]:+.1f}%, P(mean<=0) {sum(b <= 0 for b in bs)/len(bs):.3f}")
days = sorted(set(dk)); byd = {d: [x for x, k in zip(xs, dk) if k == d] for d in days}
bd = []
for _ in range(20000):
    pick = random.choices(days, k=len(days)); v = [x for d in pick for x in byd[d]]
    bd.append(sum(v) / len(v))
bd.sort()
print(f"by day ({len(days)} days): 90% interval {100*bd[1000]:+.1f}% .. {100*bd[19000]:+.1f}%, P(mean<=0) {sum(b <= 0 for b in bd)/len(bd):.3f}")
