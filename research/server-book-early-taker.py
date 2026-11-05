import json,gzip,subprocess,collections,datetime
R="/home/claude/predbot"
coins=['btc','eth','sol','xrp','doge','bnb','hype']
days=['2026-10-31','2026-11-01','2026-11-02','2026-11-03','2026-11-04']
D=collections.defaultdict(lambda:[0,0,0.0])
for c in coins:
  for d in days:
    try:
      rows=gzip.decompress(subprocess.check_output(['git','-C',R,'show',f'origin/server-data:server/hist/{c}15m/{d}.jsonl.gz'])).decode().splitlines()
      wins={json.loads(l)['window']:json.loads(l) for l in gzip.decompress(subprocess.check_output(['git','-C',R,'show',f'origin/server-data:server/hist/{c}15m/{d}-windows.jsonl.gz'])).decode().splitlines()}
    except Exception as e: continue
    hdr=json.loads(rows[0]); I={k:i for i,k in enumerate(hdr)}
    done=set()
    for l in rows[1:]:
      r=json.loads(l); w=r[I['window']]
      if w in done or w not in wins or wins[w].get('resolvedUp') is None: continue
      left=r[I['left']]
      if not (720<=left<=870): continue
      cl,op=r[I['chainlink']],r[I['open']]
      if cl is None or not op: continue
      bp=(cl-op)/op*1e4
      if abs(bp)<5: continue
      up=bp>0; ask=r[I['upAsk' if up else 'downAsk']]
      done.add(w)
      if ask is None or ask<0.35 or ask>0.6: continue
      won=wins[w]['resolvedUp']==up
      pnl=(1/ask if won else 0)-1-0.07*(1-ask)
      kd=datetime.datetime.fromtimestamp(w+9*3600,datetime.UTC).strftime('%m-%d')
      for k in [(kd,'ALL'),(kd,c)]+([(kd,'BIG3')] if c in ('btc','eth','sol') else [(kd,'REST')]):
        a=D[k];a[0]+=1;a[1]+=won;a[2]+=pnl
for k in sorted(D):
  if k[1]=='ALL': a=D[k];print(k,a[1],a[0],f"{100*a[2]/a[0]:+.1f}%")
for c in coins:
  print(c,[ (k[0],round(100*D[k][2]/D[k][0],1)) for k in sorted(D) if k[1]==c])
for g in ('BIG3','REST'):
  print(g,[(k[0],D[k][1],D[k][0],round(100*D[k][2]/D[k][0],1)) for k in sorted(D) if k[1]==g])
