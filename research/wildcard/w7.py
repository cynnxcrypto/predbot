import pandas as pd, numpy as np
df=pd.read_pickle('wxb3.pkl'); df=df[df.w.notna()&df.ext.notna()&(df.lh>=0)&(df.lh<24)].copy()
# distance beyond the running extreme: k=1 means the next bucket the temperature would have to move into
df['k']=np.where(df.kind=='H', df.lo-df.ext, df.ext-df.hi)
df['nocost']=1-df.bb; df['fee']=0.05*df.bb*(1-df.bb); df['pnl']=(1-df.w)-(df.nocost+df.fee); df['usd']=df.bsz*(1-df.bb)
def rep(x,lab):
    f=x.sort_values('t').groupby('mid').first()
    if len(f)<8: print(lab,'n',len(f)); return
    ev=f.groupby('slug').pnl.sum()
    print(f"{lab:48s} buckets {len(f):3d} events {len(ev):3d} NO won {(1-f.w).mean()*100:5.1f}% NO cost {f.nocost.mean()*100:5.1f}c net {f.pnl.mean()*100:+5.1f}c ±{f.pnl.std()/len(f)**.5*100:.1f} | $ at bid median {f.usd.median():.0f}, $25+: {int((f.usd>=25).sum())}")
for k in 'LH':
    c=df[(df.kind==k)&(df.bb>=0.05)]
    print("==",k)
    for h0,h1 in ((0,8),(8,12),(12,16),(16,24)):
        for kk,lab in ((1,'next bucket beyond'),(2,'two beyond')):
            x=c[(c.lh>=h0)&(c.lh<h1)&((c.k>=kk)&(c.k<kk+1) if kk==1 else (c.k>=2))]
            rep(x,f"{k} h{h0}-{h1} sell YES bid>=5c, {lab}")
        x=c[(c.lh>=h0)&(c.lh<h1)&(c.k>=1)&(c.bb>=0.15)]; rep(x,f"{k} h{h0}-{h1} any beyond, YES bid>=15c")
