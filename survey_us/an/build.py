import json,gzip,bisect,pickle,os
D='/home/claude/predbot/survey_us/out/'
g=json.load(gzip.open(D+'games.json.gz','rt'))
P=json.load(gzip.open(D+'prices.json.gz','rt'))
from datetime import datetime,timezone
def tsec(s):
    s=str(s).replace(' ','T'); s=s+':00' if s.endswith('+00') else s
    return datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
rows=[]
for sp,evs in g.items():
    for e in evs:
        teams=e.get('teams') or []
        ordr={t.get('ordering'):(t.get('alias') or t.get('name')) for t in teams}
        for m in e['markets']:
            typ=m.get('sportsMarketType')
            if typ not in('moneyline','spreads','totals'): continue
            if m['id'] not in P: continue
            try: op=[float(x) for x in json.loads(m['outcomePrices'])]
            except: continue
            if max(op)<0.99: continue
            outs=json.loads(m['outcomes'])
            pr=P[m['id']]
            pts=sorted(pr['c']+pr['f']+pr['p'])
            if len(pr['f'])<5: continue
            st=tsec(m['gameStartTime'])
            r=dict(sp=sp,typ=typ,id=m['id'],st=st,o0=outs[0],o1=outs[1],win0=op[0]>0.5,
                   home=ordr.get('home'),away=ordr.get('away'),title=e.get('title'),
                   vol=float(m.get('volumeNum') or 0),fee=(m.get('feeSchedule') or {}).get('rate',0) if m.get('feesEnabled') else 0,
                   line=m.get('line'),q=m.get('question'),pts=pts,score=e.get('score'))
            rows.append(r)
pickle.dump(rows,open('/home/claude/predbot/survey_us/an/rows.pkl','wb'))
import collections
print(collections.Counter((r['sp'],r['typ']) for r in rows))
