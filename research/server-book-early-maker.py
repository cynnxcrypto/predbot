import json,gzip,subprocess,collections,datetime
R="/home/claude/predbot"
coins=['btc','eth','sol','xrp','doge','bnb','hype']
days=['2026-10-31','2026-11-01','2026-11-02','2026-11-03','2026-11-04']
D=collections.defaultdict(lambda:[0,0,0.0,0])
for c in coins:
  g='BIG3' if c in('btc','eth','sol') else 'REST'
  for d in days:
    try:
      rows=gzip.decompress(subprocess.check_output(['git','-C',R,'show',f'origin/server-data:server/hist/{c}15m/{d}.jsonl.gz'],stderr=subprocess.DEVNULL)).decode().splitlines()
      wins={json.loads(l)['window']:json.loads(l) for l in gzip.decompress(subprocess.check_output(['git','-C',R,'show',f'origin/server-data:server/hist/{c}15m/{d}-windows.jsonl.gz'],stderr=subprocess.DEVNULL)).decode().splitlines()}
    except Exception: continue
    hdr=json.loads(rows[0]); I={k:i for i,k in enumerate(hdr)}
    sig={}; filled={}
    for l in rows[1:]:
      r=json.loads(l); w=r[I['window']]
      if w not in wins or wins[w].get('resolvedUp') is None: continue
      t=r[I['t']]
      if w in sig:
        up,bid,t0=sig[w]
        if w not in filled and t-t0<=30000*(1 if t>1e12 else 0.001):
          a=r[I['upAsk' if up else 'downAsk']]
          if a is not None and a<bid-1e-9: filled[w]=True
        continue
      left=r[I['left']]
      if not (720<=left<=870): continue
      cl,op=r[I['chainlink']],r[I['open']]
      if cl is None or not op: continue
      bp=(cl-op)/op*1e4
      if abs(bp)<5: continue
      up=bp>0; ask=r[I['upAsk' if up else 'downAsk']]
      if ask is None or ask<0.35 or ask>0.6: sig[w]=(up,-1,t); continue
      sig[w]=(up,round(ask-0.02,2),t)
    for w,(up,bid,t0) in sig.items():
      if bid<0: continue
      kd=datetime.datetime.fromtimestamp(w+9*3600,datetime.UTC).strftime('%m-%d')
      for k in [(kd,g),('ALLD',g)]: D[k][3]+=1
      if w not in filled: continue
      won=wins[w]['resolvedUp']==up; pnl=(1/bid if won else 0)-1
      for k in [(kd,g),('ALLD',g)]:
        a=D[k];a[0]+=1;a[1]+=won;a[2]+=pnl
for k in sorted(D): a=D[k];print(k,'fills',a[0],'/',a[3],'won',a[1],f"{100*a[2]/max(a[0],1):+.1f}%")
