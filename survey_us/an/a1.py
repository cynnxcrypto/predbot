import pickle,bisect,math,collections,statistics as S
rows=pickle.load(open('/home/claude/predbot/survey_us/an/rows.pkl','rb'))
def at(r,t):
    ts=[p[0] for p in r['pts']]; i=bisect.bisect_right(ts,t)-1
    return r['pts'][i][1] if i>=0 and t-ts[i]<3*3600 else None
SLIP=0.005
def ev(p,win,fee):  # buy side at price p (+slip), per $1 staked
    c=p+SLIP+fee*p*(1-p)
    return ((1 if win else 0)-c)/c
def band(rs,lab,tmin=600):
    out=collections.defaultdict(list)
    for r in rs:
        p0=at(r,r['st']-tmin)
        if p0 is None or not(0.03<p0<0.97): continue
        for p,w in ((p0,r['win0']),(1-p0,not r['win0'])):
            b=int(p*20)/20
            out[b].append((p,w,ev(p,w,r['fee'])))
    print(f'-- {lab} (T-{tmin//60}m), n games={len(rs)}')
    for b in sorted(out):
        v=out[b]
        if len(v)<15: continue
        evs=[x[2] for x in v]; se=S.pstdev(evs)/math.sqrt(len(v))
        print(f'  {b:.2f}-{b+.05:.2f}: n={len(v):4d} avgp={S.mean(x[0] for x in v):.3f} won={S.mean(x[1] for x in v):.3f} ev/$={S.mean(evs)*100:+.1f}c ±{se*100:.1f}')
for sp in ['nba','nhl','cbb','cfb','nfl','mlb']:
    rs=[r for r in rows if r['sp']==sp and r['typ']=='moneyline']
    band(rs,sp+' moneyline')
