import pickle,bisect,math,collections,statistics as S,datetime,csv,gzip,io
rows=pickle.load(open('/home/claude/predbot/survey_us/an/rows.pkl','rb'))
def at(r,t,maxage=3*3600):
    ts=[p[0] for p in r['pts']]; i=bisect.bisect_right(ts,t)-1
    return r['pts'][i][1] if i>=0 and t-ts[i]<maxage else None
SLIP=0.005
def ev(p,win,fee): c=p+SLIP+fee*p*(1-p); return ((1 if win else 0)-c)/c
def summ(v,lab):
    if len(v)<10: print(f'  {lab}: n={len(v)}'); return
    e=[x[2] for x in v]; print(f'  {lab}: n={len(v)} p={S.mean(x[0] for x in v):.3f} won={S.mean(x[1] for x in v):.3f} ev={S.mean(e)*100:+.1f}c ±{S.pstdev(e)/math.sqrt(len(v))*100:.1f}')
ML=[r for r in rows if r['typ']=='moneyline' and r['sp'] in('nba','nhl','cbb','cfb','nfl','mlb')]
# 1 drift: open (T-24h) -> T-10; follow vs fade
print('== drift T-24h -> T-2h, then bet the mover at T-2h (hold) ; and continuation T-2h->T-10')
for sp in ['nba','nhl','cbb','cfb','nfl','ALL']:
    fol=[];cont=[]
    for r in ML:
        if sp!='ALL' and r['sp']!=sp: continue
        a=at(r,r['st']-86400,6*3600); b=at(r,r['st']-7200); c=at(r,r['st']-600)
        if None in(a,b,c) or not(0.1<b<0.9): continue
        d=b-a
        if abs(d)>=0.04:
            if d>0: fol.append((b,r['win0'],ev(b,r['win0'],r['fee']))); cont.append(c-b)
            else: fol.append((1-b,not r['win0'],ev(1-b,not r['win0'],r['fee']))); cont.append(b-c)
    summ(fol,f'{sp} follow 4c+ drift'); 
    if cont: print(f'     continuation T-2h->T-10m: {S.mean(cont)*100:+.2f}c')
# 2 jumps in last 4h: >=3c within 3 min; continuation next 15 min
print('== jumps >=3c in <=3min (T-4h..T-5m): continuation next 15m and 60m (to start)')
for sp in ['nba','nhl','cbb','cfb','nfl','ALL']:
    c15=[];c60=[];bets=[]
    for r in ML:
        if sp!='ALL' and r['sp']!=sp: continue
        f=[p for p in r['pts'] if r['st']-4*3600<=p[0]<=r['st']-300]
        last=-1e18
        for i in range(3,len(f)):
            if f[i][0]-last<1800: continue
            j=max(k for k in range(i) if f[i][0]-f[k][0]>=180) if f[i][0]-f[0][0]>=180 else None
            if j is None: continue
            d=f[i][1]-f[j][1]
            if abs(d)>=0.03 and 0.1<f[i][1]<0.9:
                last=f[i][0]; sgn=1 if d>0 else -1
                x15=at(r,f[i][0]+900); xs=at(r,r['st']-60)
                if x15 is not None: c15.append(sgn*(x15-f[i][1]))
                if xs is not None: c60.append(sgn*(xs-f[i][1]))
                p=f[i][1] if d>0 else 1-f[i][1]; w=r['win0'] if d>0 else not r['win0']
                pe=at(r,f[i][0]+120); 
                if pe is None: continue
                pe=pe if d>0 else 1-pe
                bets.append((pe,w,ev(pe,w,r['fee'])))
    if c15: print(f'  {sp}: jumps={len(c15)} cont15={S.mean(c15)*100:+.2f}c contToStart={S.mean(c60)*100:+.2f}c')
    summ(bets,f'{sp} follow jump, enter 2 min later')
# 3 back-to-back (nba/nhl): team played previous calendar day (ET ~ UTC-5)
print('== back-to-back')
for sp in ('nba','nhl'):
    g=[r for r in ML if r['sp']==sp]
    days=collections.defaultdict(set)
    for r in g:
        d=datetime.datetime.utcfromtimestamp(r['st']-5*3600).date()
        days[r['o0']].add(d); days[r['o1']].add(d)
    vb=[];vr=[]
    for r in g:
        d=datetime.datetime.utcfromtimestamp(r['st']-5*3600).date(); y=d-datetime.timedelta(days=1)
        b0=y in days[r['o0']]; b1=y in days[r['o1']]
        p=at(r,r['st']-600)
        if p is None or not(0.05<p<0.95) or b0==b1: continue
        # bet against b2b team = bet rested team
        if b0: vr.append((1-p,not r['win0'],ev(1-p,not r['win0'],r['fee'])))
        else: vr.append((p,r['win0'],ev(p,r['win0'],r['fee'])))
    summ(vr,f'{sp} bet rested team vs B2B team')
# 4 NFL gap vs nflverse
print('== NFL PM vs nflverse closing ML')
txt=gzip.open('/home/claude/predbot/survey_us/out/nflverse_games.csv.gz','rt').read()
G=list(csv.DictReader(io.StringIO(txt)))
def imp(ml):
    ml=float(ml); return 100/(ml+100) if ml>0 else -ml/(-ml+100)
idx={}
for x in G:
    if x.get('away_moneyline') and x.get('home_moneyline') and x['gameday']>='2024-08-01':
        idx[(x['gameday'],x['home_team'])]=x
print('  nflverse 2024+ rows with ML', len(idx), 'latest', max(k[0] for k in idx))
gaps=[];bets=[]
for r in [r for r in rows if r['sp']=='nfl' and r['typ']=='moneyline']:
    pass
