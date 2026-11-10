import pandas as pd, glob, json, pickle, re, datetime as dt, numpy as np
from zoneinfo import ZoneInfo
df=pd.read_pickle('wxbooks.pkl'); df['mid']=df['mid'].astype(int)
H='/home/claude/sd/data/history/pm/temperature/2026/'
ms=pd.concat(pd.read_csv(f,usecols=['market_id','winner_idx','event_id','volume']) for f in sorted(glob.glob(H+'2026-11-*.markets.csv.gz')))
win=dict(zip(ms.market_id,ms.winner_idx))
rows=pickle.load(open("/home/claude/wx/rows.pkl","rb"))
tzc={r["city"].lower().replace(' ','-'):r["tz"] for r in rows}
MON={m:i+1 for i,m in enumerate("january february march april may june july august september october november december".split())}
def parse(s):
    m=re.match(r"(highest|lowest)-temperature-in-(.+)-on-([a-z]+)-(\d+)-(\d{4})",s)
    return m.group(1)[0].upper(), m.group(2), f"{m.group(5)}-{MON[m.group(3)]:02d}-{int(m.group(4)):02d}"
P=df.slug.map(parse); df['kind']=[p[0] for p in P]; df['city']=[p[1] for p in P]; df['date']=[p[2] for p in P]
df['tz']=df.city.map(tzc); print("no tz:",df[df.tz.isna()].city.unique())
df=df[df.tz.notna()].copy()
def lh(t,tz,date):
    d0=dt.datetime.fromisoformat(date).replace(tzinfo=ZoneInfo(tz)).timestamp(); return (t-d0)/3600
df['lh']=[lh(t,tz,d) for t,tz,d in zip(df.t,df.tz,df.date)]
df['won']=df['mid'].map(win).map({0:1.0,1:0.0})
df['m']=(df.bb.fillna(0)+df.ba.fillna(1))/2
df.to_pickle('wxb2.pkl')
print(df.groupby(['kind','date']).agg(ev=('slug','nunique'),res=('won',lambda s:s.notna().mean())))
# leader per event-snapshot
g=df.sort_values('m').groupby(['slug','t']).tail(1).copy()
g['spr']=g.ba-g.bb; g['hb']=(g.lh//2*2).astype(int)
g=g[(g.lh>=0)&(g.lh<24)]
for k in 'HL':
    x=g[(g.kind==k)&(g.m>=0.5)&(g.m<=0.9)]
    print(k,'leader mid 50-90c: spread by local 2h block (median, share<=3c, median ask$ within 2c)')
    print(x.groupby('hb').agg(n=('spr','size'),ev=('slug','nunique'),spr=('spr','median'),tight=('spr',lambda s:(s<=0.031).mean()),askusd=('asz',lambda s:(s*0.7).median())).round(3).to_string())
