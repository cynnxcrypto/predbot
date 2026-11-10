import pandas as pd, glob, numpy as np, os
H='/home/claude/sd/data/history/pm/'
out=[]
for fam in ['sports_futures','other','weather_other','politics']:
    for f in sorted(glob.glob(H+fam+'/*/*.markets.csv.gz')):
        pf=f.replace('.markets.csv.gz','.prices.parquet')
        if not os.path.exists(pf): continue
        m=pd.read_csv(f,usecols=['day','event_id','market_id','winner_idx','volume','fee_rate','question','end_date','closed_time','neg_risk','outcomes'])
        m=m[m.winner_idx.isin([0,1])&m.outcomes.fillna('').str.startswith('["Yes"')].copy()
        if not len(m): continue
        m['te']=pd.to_datetime(m.end_date,utc=True,errors='coerce',format='ISO8601').dt.tz_localize(None).astype('datetime64[s]').astype('int64')
        m['tc']=pd.to_datetime(m.closed_time,utc=True,errors='coerce',format='mixed').dt.tz_localize(None).astype('datetime64[s]').astype('int64')
        p=pd.read_parquet(pf).sort_values('t')
        for lab,off,tol in (('d30',30*86400,2*86400),('d7',7*86400,86400),('d3',3*86400,43200),('d1',86400,7200)):
            q=m[['market_id','te']].copy(); q['tq']=q.te-off; q=q.sort_values('tq')
            r=pd.merge_asof(q,p.rename(columns={'t':'tp'}),left_on='tq',right_on='tp',by='market_id',direction='backward',tolerance=tol)
            m=m.merge(r[['market_id','p']].rename(columns={'p':lab}),on='market_id',how='left')
        m['family']=fam; out.append(m)
    print(fam,sum(len(x) for x in out),flush=True)
d=pd.concat(out); d.to_pickle('longd.pkl')
d['yes']=(d.winner_idx==0).astype(float); d['mon']=d.day.str[:7]
print(d.groupby('family')[['d30','d7','d3','d1']].count())
for fam in ['sports_futures','other','weather_other','politics']:
    for lab,off in (('d30',30),('d7',7),('d3',3),('d1',1)):
        x=d[(d.family==fam)&d[lab].notna()&(d.tc>d.te-off*86400)]
        for lo,hi in ((0.02,0.08),(0.08,0.2),(0.2,0.5),(0.5,0.8),(0.8,0.92),(0.92,0.98)):
            y=x[(x[lab]>=lo)&(x[lab]<hi)]
            if len(y)<100: continue
            p=y[lab]; fee=y.fee_rate.fillna(0)
            ny=y.yes-(p+0.01+fee*p*(1-p)); nn=(1-y.yes)-(1-p+0.01+fee*p*(1-p))
            halves=sorted(y.mon.unique()); mid=halves[len(halves)//2]
            print(f"{fam:15s} {lab:3s} YES {lo:.2f}-{hi:.2f} n {len(y):5d} events {y.event_id.nunique():4d} yes won {y.yes.mean()*100:5.1f}% px {p.mean()*100:5.1f} | buy YES {ny.mean()*100:+5.1f}c | buy NO {nn.mean()*100:+5.1f}c ±{nn.std()/len(y)**.5*100:.1f} (halves {nn[y.mon<mid].mean()*100:+.1f}/{nn[y.mon>=mid].mean()*100:+.1f})")
