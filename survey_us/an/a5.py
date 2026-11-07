import pickle,bisect,math,statistics as S
rows=pickle.load(open('rows.pkl','rb'))
def at(r,t,maxage=3*3600):
    ts=[p[0] for p in r['pts']]; i=bisect.bisect_right(ts,t)-1
    return r['pts'][i][1] if i>=0 and t-ts[i]<maxage else None
def summ(v,lab):
    if len(v)<10: print(f'  {lab}: n={len(v)}'); return
    e=[x[2] for x in v]; print(f'  {lab}: n={len(v)} p={S.mean(x[0] for x in v):.3f} won={S.mean(x[1] for x in v):.3f} ev={S.mean(e)*100:+.1f}c ±{S.pstdev(e)/math.sqrt(len(v))*100:.1f}')
def ev(p,w,fee): c=p+0.01+fee*p*(1-p); return ((1 if w else 0)-c)/c
print('== in-play: pregame fav (T-10) >=60c drops to <= pregame-X in play; buy fav (1c slip)')
for sp in ['nba','nhl','cbb','cfb','nfl','ALL']:
  for X in (0.15,0.25,0.35):
    v=[]
    for r in rows:
        if r['typ']!='moneyline' or (sp!='ALL' and r['sp']!=sp): continue
        p=at(r,r['st']-600)
        if p is None: continue
        fav0 = p>=0.6; fav1 = p<=0.4
        if not(fav0 or fav1): continue
        pf=p if fav0 else 1-p
        for t,q in r['pts']:
            if t<r['st']+300 or t>r['st']+5*3600: continue
            qf=q if fav0 else 1-q
            if qf<=pf-X and 0.05<qf<0.95:
                w=r['win0'] if fav0 else not r['win0']; v.append((qf,w,ev(qf,w,r['fee']))); break
    summ(v,f'{sp} drop {X}')
print('== spreads/totals calibration at T-10 (token0 side), mid-band 40-60 & tails')
for typ in ('spreads','totals'):
  for sp in ['nba','nhl','cbb','cfb','nfl']:
    v=[];tails=[]
    for r in rows:
        if r['typ']!=typ or r['sp']!=sp: continue
        p=at(r,r['st']-600)
        if p is None: continue
        for pp,w in ((p,r['win0']),(1-p,not r['win0'])):
            if 0.4<=pp<0.6: v.append((pp,w,ev(pp,w,r['fee'])))
            if pp<0.3: tails.append((pp,w,ev(pp,w,r['fee'])))
    summ(v,f'{typ} {sp} 40-60'); summ(tails,f'{typ} {sp} <30c')
