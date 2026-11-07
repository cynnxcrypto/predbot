import pickle,bisect,math,statistics as S,datetime,collections
rows=pickle.load(open('rows.pkl','rb'))
def at(r,t):
    ts=[p[0] for p in r['pts']]; i=bisect.bisect_right(ts,t)-1
    return r['pts'][i][1] if i>=0 and t-ts[i]<3*3600 else None
def ev(p,w,fee,slip=0.005): c=p+slip+fee*p*(1-p); return ((1 if w else 0)-c)/c
def summ(v,lab):
    if not v: return print('  ',lab,'n=0')
    e=[x[2] for x in v]; print(f'  {lab}: n={len(v)} p={S.mean(x[0] for x in v):.3f} won={S.mean(x[1] for x in v):.3f} ev={S.mean(e)*100:+.1f}c ±{S.pstdev(e)/math.sqrt(len(v))*100:.1f} $5 pnl={5*sum(e):+.0f}')
def sides(r):
    p=at(r,r['st']-600)
    if p is None or not(0.02<p<0.98): return []
    return [(p,r['win0'],ev(p,r['win0'],r['fee'])),(1-p,not r['win0'],ev(1-p,not r['win0'],r['fee']))]
ML=[r for r in rows if r['typ']=='moneyline']
for sps in (('nba',),('nhl',),('cbb',),('nfl',),('nba','nhl'),('nba','nhl','nfl')):
    v=[s for r in ML if r['sp'] in sps for s in sides(r) if 0.35<=s[0]<0.5]; summ(v,'dog35-50 '+'+'.join(sps))
    v=[s for r in ML if r['sp'] in sps for s in sides(r) if s[0]>=0.85]; summ(v,'fav85+ '+'+'.join(sps))
# weekly count in season & weeks positive, nba+nhl dog
wk=collections.defaultdict(list)
for r in ML:
    if r['sp'] in('nba','nhl'):
        for s in sides(r):
            if 0.35<=s[0]<0.5: wk[datetime.date.fromtimestamp(r['st']).isocalendar()[:2]].append(s[2])
ws=[sum(v) for v in wk.values() if len(v)>=10]
print('weeks>=10 trades',len(ws),'positive',sum(1 for x in ws if x>0),'median trades/wk',S.median(len(v) for v in wk.values()))
# by price sub-band 1c slip robustness
for slip in (0.005,0.01,0.02):
    v=[ev(s[0],s[1],0.03,slip) for r in ML if r['sp'] in('nba','nhl') for s in sides(r) if 0.35<=s[0]<0.5]
    print('slip',slip,'ev %.1fc'%(100*S.mean(v)))
