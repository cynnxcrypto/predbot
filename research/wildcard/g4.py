import glob,json,gzip,pandas as pd,numpy as np
rows=[]
for b in sorted(glob.glob('/home/claude/sd/data/history/books/*/*.json.gz')):
    d=json.load(gzip.open(b)); t=d['t']
    for m in d['markets']:
        if m.get('family') not in ('football','games','esports') or m.get('smt')!='moneyline' or not m.get('game_start'): continue
        bk=m.get('books') or []
        if not bk or not bk[0]: continue
        def top(x):
            bids=x.get('bids') or []; asks=x.get('asks') or []
            bb=max((float(i[0]) for i in bids),default=np.nan); ba=min((float(i[0]) for i in asks),default=np.nan)
            az=sum(float(i[1])*float(i[0]) for i in asks if float(i[0])<=ba+1e-9) if asks else 0
            return bb,ba,az
        b0=top(bk[0]); b1=top(bk[1]) if len(bk)>1 and bk[1] else (np.nan,np.nan,0)
        rows.append((t,int(m['market_id']),m['family'],m.get('series'),m['game_start'],*b0,*b1))
df=pd.DataFrame(rows,columns='t mid fam series gs bb0 ba0 az0 bb1 ba1 az1'.split())
df['gst']=pd.to_datetime(df.gs,utc=True,format='ISO8601').dt.tz_localize(None).astype('datetime64[s]').astype('int64'); df['lead']=(df.gst-df.t)/60
df=df[df.lead>0]
H='/home/claude/sd/data/history/pm/'
W=[]
for fam in ('football','us_sports','esports','tennis','other_sports'):
    for f in glob.glob(H+fam+'/2026/2026-11-*.markets.csv.gz'):
        W.append(pd.read_csv(f,usecols=['market_id','winner_idx']))
w=pd.concat(W).drop_duplicates('market_id').set_index('market_id').winner_idx
df['win']=df['mid'].map(w); df=df[df.win.isin([0,1])]
print(len(df),df['mid'].nunique(),df.groupby('fam')['mid'].nunique().to_dict())
df=df.sort_values('t'); df['m0']=(df.bb0+df.ba0)/2
first=df[df.lead>=60].groupby('mid').first(); last=df[df.lead<=25].groupby('mid').last()
x=last.join(first[['m0','lead']].rename(columns={'m0':'m_early','lead':'lead_early'}),how='inner')
x['d']=x.m0-x.m_early
S=[]
for side in (0,1):
    if side==0: s=x.assign(ask=x.ba0,bid=x.bb0,az=x.az0,won=(x.win==0).astype(float),dd=x.d)
    else: s=x[x.fam!='football'].assign(ask=lambda q:q.ba1,bid=lambda q:q.bb1,az=lambda q:q.az1,won=lambda q:(q.win==1).astype(float),dd=lambda q:-q.d)
    S.append(s)
s=pd.concat(S); s=s[s.ask.notna()&(s.ask-s.bid<=0.05)]
fee={'esports':0.07,'football':0.03,'games':0.03}
s['pnl']=s.won-(s.ask+s.fam.map(fee)*s.ask*(1-s.ask))
s.to_pickle('steam_books.pkl')
def rep(q,lab):
    if len(q)<15: print(lab,"n",len(q)); return
    print(f"{lab:45s} n {len(q):4d} won {q.won.mean()*100:5.1f}% ask {q.ask.mean()*100:5.1f} net {q.pnl.mean()*100:+5.1f}c ±{q.pnl.std()/len(q)**.5*100:.1f}  $25+ at ask: {(q.az>=25).mean()*100:.0f}%")
for fam in ('esports','football','games'):
    f=s[(s.fam==fam)&(s.ask>=0.2)&(s.ask<=0.95)]
    rep(f,fam+" all sides 20-95c at real ask")
    for th in (0.02,0.04):
        rep(f[f.dd>=th],f"{fam} FOLLOW mid rose>={th}"); rep(f[f.dd<=-th],f"{fam} BUY-DIP mid fell>={th}")
