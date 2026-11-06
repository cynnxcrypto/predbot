# Round 228 (6 Nov 2026): the early-move DOWN/UP taker (ask + fee, 35-60c) on the server's 1-s 15m books 31 Oct - 6 Nov 09:00 KST,
# split by KST block of the window start, ETH/SOL/BTC vs the rest.
# ahead5-cheap60-15m: first Chainlink move of 3+ bps in the first 2.5 min, ask 35-60c (bands up to 70c shown for context).
import json, gzip, subprocess, collections, datetime
R = "/home/claude/predbot"
coins = ['btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'hype']
days = ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']
def show(p):
    return gzip.decompress(subprocess.check_output(['git', '-C', R, 'show', f'origin/server-data:{p}'], stderr=subprocess.DEVNULL)).decode().splitlines()
A = collections.defaultdict(lambda: [0, 0, 0.0]); DAYS = collections.defaultdict(float)
for c in coins:
    g = 'BIG3' if c in ('btc', 'eth', 'sol') else 'REST'
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
            up = bp > 0; ask = r[I['upAsk' if up else 'downAsk']]
            if ask is None or not (0.35 <= ask <= 0.60): continue
            won = wins[w]['resolvedUp'] == up
            pnl = (1 / ask if won else 0) - 1 - 0.07 * (1 - ask)
            band = '35-50' if ask <= 0.50 else '51-55' if ask <= 0.55 else '56-60' if ask <= 0.60 else '61-65' if ask <= 0.65 else '66-70'
            size = '5-8bp' if abs(bp) < 8 else '8+bp'
            kd = datetime.datetime.fromtimestamp(w + 9 * 3600, datetime.UTC).strftime('%m-%d')
            hk = (datetime.datetime.fromtimestamp(w + 9 * 3600, datetime.UTC).hour // 6) * 6
            for k in [(g, 'UP' if up else 'DOWN', 'kst', f'{hk:02d}-{hk+6:02d}')]:
                a = A[k]; a[0] += 1; a[1] += won; a[2] += pnl; DAYS[k + (kd,)] += pnl
for k in sorted(A):
    a = A[k]; gd = sum(1 for kk, v in DAYS.items() if kk[:4] == k and v > 0); nd = sum(1 for kk in DAYS if kk[:4] == k)
    print(*k, a[0], f'won {100*a[1]/a[0]:.0f}%', f'{100*a[2]/a[0]:+.1f}%', f'green {gd}/{nd}')
