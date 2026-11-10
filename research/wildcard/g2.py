import pandas as pd, glob, numpy as np, os
H='/home/claude/sd/data/history/pm/'
LABS=(('p115',115*60,600),('p60',3600,600),('p30',1800,600),('p10',600,600))
out=[]
for fam in ['football','us_sports','tennis','esports','other_sports']:
    n=0
    for f in sorted(glob.glob(H+fam+'/*/*.markets.csv.gz')):
        pf=f.replace('.markets.csv.gz','.prices1m.parquet')
        if not os.path.exists(pf): continue
        m=pd.read_csv(f,usecols=['day','event_id','market_id','smt','game_start','winner_idx','volume','fee_rate','question','group_item'])
        q=m.question.fillna('')
        ml=(m.smt=='moneyline')|(m.smt.isna()&q.str.contains(r'^Will .+ win|beat|\bvs\.? ',regex=True)&~q.str.contains(r'O/U|Spread|Handicap|Total|Both|Map \d|Game \d|Set \d|1H|Half|by KO|Round|score|Score|Over|Under',regex=True))
        m=m[ml&m.game_start.notna()].copy()
        if not len(m): continue
        e=pd.read_csv(f.replace('.markets.','.events.'),usecols=['event_id','sub','series']).drop_duplicates('event_id'); m=m.merge(e,on='event_id',how='left')
        m['gs']=pd.to_datetime(m.game_start,utc=True,errors='coerce').dt.tz_localize(None).astype('datetime64[s]').astype('int64')
        p=pd.read_parquet(pf); p=p[p.market_id.isin(set(m.market_id))].sort_values('t')
        if not len(p): continue
        for lab,off,tol in LABS:
            qq=m[['market_id','gs']].copy(); qq['tq']=qq.gs-off; qq=qq.sort_values('tq')
            r=pd.merge_asof(qq,p.rename(columns={'t':'tp'}),left_on='tq',right_on='tp',by='market_id',direction='backward',tolerance=tol)
            m=m.merge(r[['market_id','p']].rename(columns={'p':lab}),on='market_id',how='left')
        m['family']=fam; out.append(m[m.p10.notna()]); n+=m.p10.notna().sum()
    print(fam,n,flush=True)
d=pd.concat(out); d.to_pickle('games1m.pkl')
