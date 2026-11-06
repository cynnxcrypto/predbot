# Real-test pre-flight (6 Nov 2026): replay the exact shape planned for the $3 real test on the server's 1-s 15m books:
# ETH/SOL/BTC, first Chainlink move of 5+ bps in the first 2.5 min of the window, DOWN only, taker at the signal ask
# (35-60c) + fee, ONE trade per window across the three coins (the first coin to signal), and a cross-coin
# 3-loss day-halt (KST day). Also shows the same with every coin traded (no per-window cap). $3 stakes.
import json, gzip, subprocess, collections, datetime, sys
R = "/home/claude/predbot"
days = sys.argv[1:] or ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']
def show(p):
    return gzip.decompress(subprocess.check_output(['git', '-C', R, 'show', f'origin/server-data:{p}'], stderr=subprocess.DEVNULL)).decode().splitlines()
sigs = []
for c in ['btc', 'eth', 'sol']:
    for d in days:
        try:
            rows = show(f'server/hist/{c}15m/{d}.jsonl.gz')
            wins = {json.loads(l)['window']: json.loads(l) for l in show(f'server/hist/{c}15m/{d}-windows.jsonl.gz')}
        except Exception:
            continue
        hdr = json.loads(rows[0]); I = {k: i for i, k in enumerate(hdr)}
        seen = set()
        for l in rows[1:]:
            r = json.loads(l); w = r[I['window']]
            if w in seen or w not in wins or wins[w].get('resolvedUp') is None: continue
            left = r[I['left']]
            if not (720 <= left <= 870): continue
            cl, op = r[I['chainlink']], r[I['open']]
            if cl is None or not op: continue
            bp = (cl - op) / op * 1e4
            if abs(bp) < 5: continue
            seen.add(w)
            if bp > 0: continue
            ask = r[I['downAsk']]
            if ask is None or not (0.35 <= ask <= 0.60): continue
            t = r[I['t']]; t = t / 1000 if t > 1e12 else t
            sigs.append((t, w, c, ask, wins[w]['resolvedUp'] is False))
sigs.sort()
for one in (True, False):
    used = set(); streak = 0; stopped = set(); day = collections.defaultdict(lambda: [0, 0, 0.0]); n = won = 0; net = 0.0
    for t, w, c, ask, win in sigs:
        kd = datetime.datetime.fromtimestamp(w + 9 * 3600, datetime.UTC).strftime('%m-%d')
        if kd in stopped or (one and w in used): continue
        used.add(w)
        pnl = 3 * ((1 / ask if win else 0) - 1 - 0.07 * (1 - ask))
        a = day[kd]; a[0] += 1; a[1] += win; a[2] += pnl; n += 1; won += win; net += pnl
        streak = 0 if win else streak + 1
        if streak >= 3: stopped.add(kd); streak = 0
    print('one per window' if one else 'every coin', f'{won}/{n}', f'${net:+.2f}', ' '.join(f'{k}:{v[1]}/{v[0]} {v[2]:+.1f}' for k, v in sorted(day.items())), 'worst day', f'{min(v[2] for v in day.values()):+.2f}')

# Round 231 (6 Nov 2026): risk of the $3 test against enrique's $50 cap. Per-day results of the one-per-window
# dayhalt3 shape, max drawdown on the trade path, and a bootstrap of 5 / 10 trading days from the observed days.
import random
one = []; used = set(); streak = 0; stopped = set(); per = collections.defaultdict(float)
for t, w, c, ask, win in sigs:
    kd = datetime.datetime.fromtimestamp(w + 9 * 3600, datetime.UTC).strftime('%m-%d')
    if kd in stopped or w in used: continue
    used.add(w); pnl = 3 * ((1 / ask if win else 0) - 1 - 0.07 * (1 - ask)); one.append(pnl); per[kd] += pnl
    streak = 0 if win else streak + 1
    if streak >= 3: stopped.add(kd); streak = 0
peak = cum = dd = 0.0
for p in one:
    cum += p; peak = max(peak, cum); dd = min(dd, cum - peak)
print('max drawdown on the trade path', f'${dd:.2f}')
days_v = list(per.values()); random.seed(1)
for n in (5, 10):
    sims = sorted(sum(random.choice(days_v) for _ in range(n)) for _ in range(20000))
    print(f'{n} days: P(total <= -$50) {sum(x <= -50 for x in sims)/len(sims):.4f}, P(<0) {sum(x < 0 for x in sims)/len(sims):.3f}, 5th pct ${sims[len(sims)//20]:+.1f}, median ${sims[len(sims)//2]:+.1f}')
