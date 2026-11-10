import pandas as pd, numpy as np
d=pd.read_pickle('games1m.pkl'); d=d[d.winner_idx.isin([0,1])].copy()
d['yr']=d.day.str[:4]
a=d.assign(side=0,px=d.p10,p0=d.p115,p60s=d.p60,won=(d.winner_idx==0).astype(float))
b=d[d.family!='football'].assign(side=1); b['px']=1-b.p10; b['p0']=1-b.p115; b['p60s']=1-b.p60; b['won']=(b.winner_idx==1).astype(float)
s=pd.concat([a,b]); s=s[s.p0.notna()]
s['fee']=s.fee_rate.fillna(0)*s.px*(1-s.px); s['pnl']=s.won-(s.px+0.01+s.fee); s['d']=s.px-s.p0; s['d60']=s.px-s.p60s
clean=s.series.fillna('').str.contains('premier-league|la-liga|serie-a|bundesliga|ligue-1|champions-league|europa-league|nba|nfl|mlb|wnba|cfb|lol|league-of-legends')|s['sub'].fillna('').isin(['nba','nfl','mlb','wnba','cfb','lol'])
s['clean']=clean
def rep(x,lab):
    if len(x)<80: return
    n=len(x); h=x.groupby('yr').pnl.agg(['mean','size'])
    print(f"{lab:55s} n {n:5d} won {x.won.mean()*100:5.1f}% px {x.px.mean()*100:5.1f} net {x.pnl.mean()*100:+5.1f}c ±{x.pnl.std()/n**.5*100:.1f} | "+" ".join(f"{y}:{r['mean']*100:+.1f}({int(r['size'])})" for y,r in h.iterrows()))
print("variants: 5 families x 2 directions x 3 thresholds x 3 bands + all-row baselines")
for fam in ['football','us_sports','tennis','esports','other_sports']:
    f=s[s.family==fam]
    rep(f[(f.px>=0.5)&(f.px<0.95)],f"{fam} BASE fav 50-95 (no filter)")
    for lo,hi in ((0.2,0.5),(0.5,0.8),(0.8,0.95)):
        g=f[(f.px>=lo)&(f.px<hi)]
        for th in (0.02,0.04,0.07):
            rep(g[g.d>=th],f"{fam} px {lo}-{hi} FOLLOW rise>={th} (T-115→T-10)")
            rep(g[g.d<=-th],f"{fam} px {lo}-{hi} BUY-DIP fall>={th}")
    g=f[(f.px>=0.5)&(f.px<0.95)&f.clean]
    rep(g[g.d>=0.03],f"{fam} CLEAN fav 50-95 rise>=3c"); rep(g[g.d<=-0.03],f"{fam} CLEAN fav 50-95 fall>=3c"); rep(g[g.d.abs()<0.01],f"{fam} CLEAN fav 50-95 flat")
