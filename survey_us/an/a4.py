import pickle,bisect,math,statistics as S,csv,gzip,io,json,datetime
rows=pickle.load(open('/home/claude/predbot/survey_us/an/rows.pkl','rb'))
byid={r['id']:r for r in rows}
g=json.load(gzip.open('/home/claude/predbot/survey_us/out/games.json.gz','rt'))
def at(r,t):
    ts=[p[0] for p in r['pts']]; i=bisect.bisect_right(ts,t)-1
    return r['pts'][i][1] if i>=0 else None
G=list(csv.DictReader(io.StringIO(gzip.open('/home/claude/predbot/survey_us/out/nflverse_games.csv.gz','rt').read())))
def imp(ml): ml=float(ml); return 100/(ml+100) if ml>0 else -ml/(-ml+100)
fix={'la':'lar','wsh':'was','lv':'lv','jac':'jax'}
idx={}
for x in G:
    if x.get('away_moneyline') and x.get('home_moneyline'):
        idx[(x['gameday'],x['away_team'].lower(),x['home_team'].lower())]=x
gaps=[];bets=[];ok=0
for e in g['nfl']:
    for m in e['markets']:
        if m.get('sportsMarketType')!='moneyline' or m['id'] not in byid: continue
        r=byid[m['id']]; parts=m['slug'].split('-')
        a,h,d=parts[1],parts[2],'-'.join(parts[3:6])
        x=None
        for dd in (d,(datetime.date.fromisoformat(d)-datetime.timedelta(days=1)).isoformat()):
            for aa in (a,fix.get(a,a)):
                for hh in (h,fix.get(h,h)):
                    x=x or idx.get((dd,aa,hh))
        if not x: continue
        ok+=1
        ia,ih=imp(x['away_moneyline']),imp(x['home_moneyline']); fa=ia/(ia+ih)
        p=at(r,r['st']-600)  # token0 = away (title Away vs Home)
        if p is None: continue
        gaps.append((p-fa)*100)
        awaywon=r['win0']
        # bet where PM cheaper than book by 2+ pts
        for pp,ff,w in ((p,fa,awaywon),(1-p,1-fa,not awaywon)):
            if ff-pp>=0.02: c=pp+0.005+r['fee']*pp*(1-pp); bets.append((w-c)/c)
        # check favourite overpricing vs book
print('matched',ok,'gaps n',len(gaps),'mean PM-book (away side) %.2f'%S.mean(gaps),'median abs %.2f'%S.median([abs(x) for x in gaps]))
print('bets PM 2+pts under book: n',len(bets),'ev %.1fc'%(100*S.mean(bets)) if bets else '')
# fav side: PM fav price vs book fav fair
fg=[]
for e in g['nfl']:
    for m in e['markets']:
        if m.get('sportsMarketType')!='moneyline' or m['id'] not in byid: continue
        r=byid[m['id']]; parts=m['slug'].split('-'); a,h,d=parts[1],parts[2],'-'.join(parts[3:6])
        x=idx.get((d,a,h)) or idx.get(((datetime.date.fromisoformat(d)-datetime.timedelta(days=1)).isoformat(),a,h))
        if not x: continue
        ia,ih=imp(x['away_moneyline']),imp(x['home_moneyline']); fa=ia/(ia+ih); p=at(r,r['st']-600)
        if p is None: continue
        if 0.5<=max(p,1-p)<0.65: fg.append((max(p,1-p)-(fa if p>=0.5 else 1-fa))*100)
print('NFL PM fav 50-65 minus book fair: n',len(fg),'mean %.2f pts'%S.mean(fg))
