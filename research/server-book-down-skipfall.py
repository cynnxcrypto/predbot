# Round 230 (6 Nov 2026): what the live 'skip when the ask fell 1c+' check does to the BIG3 DOWN test signal: ask 1 s after the signal vs the signal ask, server 1-s books.
# ETH/SOL/BTC, first Chainlink move of 5+ bps in the first 2.5 min of the window, DOWN only, taker at the signal ask
# (35-60c) + fee, ONE trade per window across the three coins (the first coin to signal), and a cross-coin
# 3-loss day-halt (KST day). Also shows the same with every coin traded (no per-window cap). $3 stakes.
import json, gzip, subprocess, collections, datetime, sys
R = "/home/claude/predbot"
days = sys.argv[1:] or ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']
def show(p):
    return gzip.decompress(subprocess.check_output(['git', '-C', R, 'show', f'origin/server-data:{p}'], stderr=subprocess.DEVNULL)).decode().splitlines()
sigs = []
A = collections.defaultdict(lambda: [0, 0, 0.0])
for c in ['btc', 'eth', 'sol']:
    for d in days:
        try:
            rows = show(f'server/hist/{c}15m/{d}.jsonl.gz')
            wins = {json.loads(l)['window']: json.loads(l) for l in show(f'server/hist/{c}15m/{d}-windows.jsonl.gz')}
        except Exception:
            continue
        hdr = json.loads(rows[0]); I = {k: i for i, k in enumerate(hdr)}
        seen = set(); pend = {}; nxt = {}
        for l in rows[1:]:
            r = json.loads(l); w = r[I['window']]
            if w in seen or w not in wins or wins[w].get('resolvedUp') is None: continue
            left = r[I['left']]
            if not (720 <= left <= 870): continue
            cl, op = r[I['chainlink']], r[I['open']]
            if cl is None or not op: continue
            bp = (cl - op) / op * 1e4
            if abs(bp) < 5: continue
            if bp > 0: seen.add(w); continue
            ask = r[I['downAsk']]
            if ask is None or not (0.35 <= ask <= 0.60): seen.add(w); continue
            t0 = r[I['t']]; t0 = t0 / 1000 if t0 > 1e12 else t0
            seen.add(w); pend[w] = (ask, wins[w]['resolvedUp'] is False, t0)
            continue
        for l in rows[1:]:
            r = json.loads(l); w = r[I['window']]
            if w in pend and w not in nxt:
                t = r[I['t']]; t = t / 1000 if t > 1e12 else t
                if t >= pend[w][2] + 0.9: nxt[w] = r[I['downAsk']]
        for w, (ask, win, _t0) in pend.items():
            na = nxt.get(w)
            k = 'fell' if na is not None and na <= ask - 0.01 + 1e-9 else 'held'
            A[(c, k)][0] += 1; A[(c, k)][1] += win; A[(c, k)][2] += 3 * ((1 / ask if win else 0) - 1 - 0.07 * (1 - ask))
for k in sorted(A):
    a = A[k]; print(*k, f'{a[1]}/{a[0]}', f'${a[2]:+.2f}')
for g in ('fell', 'held'):
    t = [A[k] for k in A if k[1] == g]; n = sum(x[0] for x in t); wn = sum(x[1] for x in t); p = sum(x[2] for x in t)
    print('ALL', g, f'{wn}/{n}', f'${p:+.2f}')
