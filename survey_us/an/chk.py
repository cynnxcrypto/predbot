import pickle,bisect,datetime
rows=pickle.load(open('/home/claude/predbot/survey_us/an/rows.pkl','rb'))
def at(r,t):
    ts=[p[0] for p in r['pts']]; i=bisect.bisect_right(ts,t)-1
    return r['pts'][i][1] if i>=0 else None
n=0
for r in rows:
    if r['sp']=='nba' and r['typ']=='moneyline':
        p=at(r,r['st']-600)
        if p and (p<0.1 or p>0.9):
            n+=1
            if n<8: print(r['title'],datetime.datetime.utcfromtimestamp(r['st']),r['score'],r['win0'],[at(r,r['st']-k*60) for k in (240,120,60,30,10,0)], [at(r,r['st']+k*60) for k in (30,60,120,180)])
