import pickle,bisect,math,collections,statistics as S,datetime
rows=pickle.load(open('/home/claude/predbot/survey_us/an/rows.pkl','rb'))
def at(r,t):
    ts=[p[0] for p in r['pts']]; i=bisect.bisect_right(ts,t)-1
    return r['pts'][i][1] if i>=0 and t-ts[i]<3*3600 else None
SLIP=0.005
def ev(p,win,fee): c=p+SLIP+fee*p*(1-p); return ((1 if win else 0)-c)/c
def summ(v,lab):
    if len(v)<10: print(f'  {lab}: n={len(v)}'); return
    e=[x[2] for x in v]; print(f'  {lab}: n={len(v)} p={S.mean(x[0] for x in v):.3f} won={S.mean(x[1] for x in v):.3f} ev={S.mean(e)*100:+.1f}c ±{S.pstdev(e)/math.sqrt(len(v))*100:.1f}')
ML=[r for r in rows if r['typ']=='moneyline']
def sides(r,t):
    p0=at(r,t)
    if p0 is None or not(0.02<p0<0.98): return []
    out=[]
    for p,w,team in ((p0,r['win0'],r['o0']),(1-p0,not r['win0'],r['o1'])):
        ishome = None
        if r['home']: ishome = (team==r['home']) or (r['home'] in team) or (team in r['home'])
        out.append((p,w,ev(p,w,r['fee']),ishome))
    return out
print('== short dog 35-50c, by sport & half & time')
for sp in ['nba','nhl','cbb','cfb','nfl','mlb','ALL']:
    rs=[r for r in ML if sp=='ALL' or r['sp']==sp]
    rs.sort(key=lambda r:r['st']); mid=rs[len(rs)//2]['st'] if rs else 0
    for tm in (600,3600):
        v=[s for r in rs for s in sides(r,r['st']-tm) if 0.35<=s[0]<0.5]
        summ(v,f'{sp} T-{tm//60}m all')
    v1=[s for r in rs if r['st']<mid for s in sides(r,r['st']-600) if 0.35<=s[0]<0.5]
    v2=[s for r in rs if r['st']>=mid for s in sides(r,r['st']-600) if 0.35<=s[0]<0.5]
    summ(v1,f'{sp} first half'); summ(v2,f'{sp} second half')
    for h in (True,False):
        summ([s for r in rs for s in sides(r,r['st']-600) if 0.35<=s[0]<0.5 and s[3]==h],f'{sp} dog home={h}')
print('== longshots <15c and favs >85c, ALL')
summ([s for r in ML for s in sides(r,r['st']-600) if s[0]<0.15],'<15c')
summ([s for r in ML for s in sides(r,r['st']-600) if s[0]>=0.85],'>=85c')
summ([s for r in ML for s in sides(r,r['st']-600) if 0.5<=s[0]<0.65],'fav 50-65c')
print('== home side by band ALL (T-10)')
for lo,hi in ((0.2,0.35),(0.35,0.5),(0.5,0.65),(0.65,0.8),(0.8,0.95)):
    summ([s for r in ML for s in sides(r,r['st']-600) if lo<=s[0]<hi and s[3] is True],f'home {lo}-{hi}')
    summ([s for r in ML for s in sides(r,r['st']-600) if lo<=s[0]<hi and s[3] is False],f'away {lo}-{hi}')
# monthly stability for short dog pooled nba+nhl+cbb
print('== short dog monthly (nba,nhl,cbb)')
m=collections.defaultdict(list)
for r in ML:
    if r['sp'] not in('nba','nhl','cbb'): continue
    for s in sides(r,r['st']-600):
        if 0.35<=s[0]<0.5: m[datetime.datetime.utcfromtimestamp(r['st']).strftime('%Y-%m')].append(s)
for k in sorted(m): summ(m[k],k)
