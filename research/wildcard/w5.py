import pandas as pd, glob, json, pickle, re, math, datetime as dt, numpy as np, bisect
from zoneinfo import ZoneInfo
df=pd.read_pickle('wxb2.pkl')
H='/home/claude/sd/data/history/'
ms=pd.concat(pd.read_csv(f,usecols=['market_id','station','question']) for f in sorted(glob.glob(H+'pm/temperature/2026/2026-1[01]-*.markets.csv.gz')))
ms['city']=ms.question.str.extract(r'temperature in (.+?) be ')[0].str.lower().str.replace(' ','-')
st=ms.dropna(subset=['station']).groupby('city').station.agg(lambda s:s.mode()[0]).to_dict()
df['st']=df.city.map(st)
rnd=lambda x: math.floor(x+0.5)
def bounds(q):
    unit="F" if "°F" in q else "C"
    q2=q.split(' be ',1)[1].rsplit(' on ',1)[0]
    n=[int(x) for x in re.findall(r"-?\d+", q2.replace("°"," "))]
    if unit=="F" and len(n)==2 and "below" not in q2 and "higher" not in q2: lo,hi=n[0],abs(n[1])
    else:
        v=n[0]; lo=hi=v
        if "below" in q2: lo=-999
        if "higher" in q2: hi=999
    return unit,lo,hi
B=df.q.map(bounds); df['unit']=[b[0] for b in B]; df['lo']=[b[1] for b in B]; df['hi']=[b[2] for b in B]
OBS={}
for s in df.st.dropna().unique():
    try: x=pd.read_parquet(H+f'results/temperature/metar_{s}.parquet')
    except Exception: continue
    x['ts']=pd.to_datetime(x.valid_utc).astype('int64')//10**9 if str(pd.to_datetime(x.valid_utc).dtype).endswith('[ns]') else pd.to_datetime(x.valid_utc).astype('datetime64[s]').astype('int64')
    OBS[s]=(x.ts.values, x.tmpf.values)
ev=df.groupby('slug').first()[['kind','city','date','tz','st','unit']]
res={}
for slug,e in ev.iterrows():
    if e.st not in OBS: continue
    d0=dt.datetime.fromisoformat(e.date).replace(tzinfo=ZoneInfo(e.tz)).timestamp()
    ts,tv=OBS[e.st]; k=(ts>=d0)&(ts<d0+86400)
    if k.sum()<20 or ts.max()<d0+86400-3600: continue
    v=tv[k] if e.unit=="F" else (tv[k]-32)/1.8
    res[slug]=rnd(float(v.max() if e.kind=="H" else v.min())+1e-6)
df['ext_final']=df.slug.map(res)
df['won2']=np.where(df.ext_final.notna(), ((df.lo<=df.ext_final)&(df.ext_final<=df.hi)).astype(float), np.nan)
c=df[df.won.notna()&df.won2.notna()].groupby(['slug','mid']).first()
print("check vs resolved: agree",(c.won==c.won2).mean(),len(c), "events with outcome:",df[df.won2.notna()].groupby(['kind','date']).slug.nunique().to_dict())
df['w']=df.won.fillna(df.won2)
# running extreme at snapshot
def runext(r):
    if r.st not in OBS: return np.nan, np.nan
    d0=dt.datetime.fromisoformat(r.date).replace(tzinfo=ZoneInfo(r.tz)).timestamp()
    ts,tv=OBS[r.st]; k=(ts>=d0)&(ts<=r.t-1200)
    if k.sum()<2: return np.nan,np.nan
    v=tv[k] if r.unit=="F" else (tv[k]-32)/1.8
    e=v.max() if r.kind=="H" else v.min()
    return rnd(float(e)+1e-6), abs(float(v[-1])-float(e))
snap=df.groupby(['slug','t']).first().reset_index()[['slug','t','st','date','tz','unit','kind']]
R=[runext(r) for r in snap.itertuples()]
snap['ext']=[a for a,b in R]; snap['off']=[b for a,b in R]
df=df.merge(snap[['slug','t','ext','off']],on=['slug','t'])
df.to_pickle('wxb3.pkl')
