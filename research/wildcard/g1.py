import pandas as pd, glob, numpy as np, os
H='/home/claude/sd/data/history/pm/'
LABS=(('p72',72*3600,7*3600),('p24',24*3600,2*3600),('p6',6*3600,2*3600),('p1',3600,1800),('p10',600,1500))
out=[]
for fam in ['football','us_sports','tennis','esports','other_sports']:
    n=0
    for f in sorted(glob.glob(H+fam+'/*/*.markets.csv.gz')):
        try: m=pd.read_csv(f,usecols=['day','event_id','market_id','smt','game_start','winner_idx','final_prices','volume','fee_rate','question','group_item'])
        except Exception: continue
        q=m.question.fillna('')
        ml=(m.smt=='moneyline')|(m.smt.isna()&q.str.contains(r'^Will .+ win|\bvs\.? ',regex=True)&~q.str.contains(r'O/U|Spread|Handicap|Total|Both|Map \d|Game \d|Set \d|1H|Half|draw|Draw|by KO|Round|score|Score|Over|Under',regex=True))
        m=m[ml&m.game_start.notna()].copy()
        pf=f.replace('.markets.csv.gz','.prices.parquet')
        if not len(m) or not os.path.exists(pf): continue
        try: e=pd.read_csv(f.replace('.markets.','.events.'),usecols=['event_id','sub','series']).drop_duplicates('event_id'); m=m.merge(e,on='event_id',how='left')
        except Exception: pass
        m['gs']=pd.to_datetime(m.game_start,utc=True,errors='coerce').dt.tz_localize(None).astype('datetime64[s]').astype('int64')
        p=pd.read_parquet(pf); p=p[p.market_id.isin(set(m.market_id))].sort_values('t')
        m['has']=m.market_id.isin(set(p.market_id))
        for lab,off,tol in LABS:
            q=m[['market_id','gs']].copy(); q['tq']=q.gs-off; q=q.sort_values('tq')
            if len(p):
                r=pd.merge_asof(q,p.rename(columns={'t':'tp'}),left_on='tq',right_on='tp',by='market_id',direction='backward',tolerance=tol)
                m=m.merge(r[['market_id','p']].rename(columns={'p':lab}),on='market_id',how='left')
            else: m[lab]=np.nan
        m['family']=fam; out.append(m); n+=len(m)
    print(fam,n,flush=True)
d=pd.concat(out); d.to_pickle('games.pkl'); print(d[['p72','p24','p6','p1','p10']].notna().sum())
