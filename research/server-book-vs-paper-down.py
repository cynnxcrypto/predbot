# Round 226 (6 Nov 2026): why does the paper twin ahead5-cheap60-15m-dayhalt3-big3-down lose while the server-book
# replay of the same signal wins? Lists replay trades (taker, ask + fee, $5) for ETH/SOL/BTC DOWN signals in windows
# from 6 Nov 04:10 KST (when the paper twin started) to 09:00 KST, per coin, next to the paper days entries.
import json, gzip, subprocess, collections, datetime
R = "/home/claude/predbot"
START = datetime.datetime(2026, 11, 5, 19, 10, tzinfo=datetime.UTC).timestamp()
def show(p):
    return gzip.decompress(subprocess.check_output(['git', '-C', R, 'show', f'origin/server-data:{p}'], stderr=subprocess.DEVNULL)).decode().splitlines()
tot = collections.defaultdict(lambda: [0, 0, 0.0])
for c in ['btc', 'eth', 'sol']:
    rows = show(f'server/hist/{c}15m/2026-11-05.jsonl.gz')
    wins = {json.loads(l)['window']: json.loads(l) for l in show(f'server/hist/{c}15m/2026-11-05-windows.jsonl.gz')}
    hdr = json.loads(rows[0]); I = {k: i for i, k in enumerate(hdr)}
    sig = {}
    for l in rows[1:]:
        r = json.loads(l); w = r[I['window']]
        if w < START or w in sig or w not in wins or wins[w].get('resolvedUp') is None: continue
        left = r[I['left']]
        if not (720 <= left <= 870): continue
        cl, op = r[I['chainlink']], r[I['open']]
        if cl is None or not op: continue
        bp = (cl - op) / op * 1e4
        if abs(bp) < 5: continue
        up = bp > 0; ask = r[I['upAsk' if up else 'downAsk']]
        sig[w] = (up, ask if ask is not None and 0.35 <= ask <= 0.6 else -1)
    for w, (up, ask) in sorted(sig.items()):
        if up or ask < 0: continue
        won = wins[w]['resolvedUp'] is False
        pnl = 5 * ((1 / ask if won else 0) - 1 - 0.07 * (1 - ask))
        print(c, datetime.datetime.fromtimestamp(w + 9 * 3600, datetime.UTC).strftime('%H:%M'), f'ask {ask:.2f}', 'won' if won else 'lost', f'{pnl:+.2f}')
        t = tot[c]; t[0] += 1; t[1] += won; t[2] += pnl
for c, t in tot.items(): print('REPLAY', c, f'{t[1]}/{t[0]}', f'{t[2]:+.2f}')
s = json.load(open('/tmp/claude-0/st.json'))
for se in s['series']:
    for p in se['papers']:
        if p['name'] == 'ahead5-cheap60-15m-dayhalt3-big3-down':
            print('PAPER', se.get('prefix', se.get('name')), p['fillable'], [d for d in p.get('days', [])])
