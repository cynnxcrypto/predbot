import pandas as pd, numpy as np
df=pd.read_pickle('wxb3.pkl'); df=df[df.w.notna()&df.ext.notna()&(df.lh>=0)&(df.lh<24)]
cur=df[(df.lo<=df.ext)&(df.ext<=df.hi)].copy()
cur['cost']=cur.ba+0.05*cur.ba*(1-cur.ba); cur['pnl']=cur.w-cur.cost; cur['usd']=cur.asz*cur.ba
def rep(x,label):
    if len(x)==0: print(label,"none"); return
    f=x.sort_values('t').groupby('slug').first()
    print(f"{label}: snapshots {len(x)} | events {len(f)} won {f.w.mean()*100:.0f}% avg ask {f.ba.mean():.3f} net {f.pnl.mean()*100:+.1f}c/share ±{f.pnl.std()/len(f)**.5*100:.1f} | $ at ask median {f.usd.median():.0f} | fillable($25+) {int((f.usd>=25).sum())}")
for k in 'LH':
    c=cur[cur.kind==k]
    print("==",k,"events with any snapshot:",c.slug.nunique())
    for h0,h1 in ((0,6),(6,9),(9,12),(12,16),(16,20),(20,24),(9,24)):
        for a0,a1 in ((0.2,0.6),(0.6,0.8),(0.8,0.9),(0.9,0.97)):
            x=c[(c.lh>=h0)&(c.lh<h1)&(c.ba>=a0)&(c.ba<a1)]
            if x.slug.nunique()>=5: rep(x,f"{k} h{h0}-{h1} ask {a0}-{a1}")
    x=c[(c.lh>=9)&(c.ba<0.9)&(c.off>=2)]; rep(x,f"{k} h9+ ask<90 temp 2+ deg past extreme")
    x=c[(c.lh>=9)&(c.ba<0.9)&(c.off>=2)&(c.usd>=25)]; rep(x,f"{k} same, $25+ at ask")
# also: any bucket NOT current & ask.. ; and non-current bucket leader: sell? show ask of losers
