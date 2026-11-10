import pandas as pd, numpy as np
d=pd.read_pickle('crypto.pkl'); d=d.dropna(subset=['upAsk','upBid','dnAsk','dnBid']).copy()
d['left']=900-d.e; d['z']=d.bp/(d.sig.clip(lower=0.3)*np.sqrt(d.left))
d['mid']=((d.upAsk+d.upBid)/2).clip(0.02,0.98); d['lm']=np.log(d.mid/(1-d.mid))
g=d.groupby(['window','e'])
d['br_sign']=(g.bp.transform(lambda s:np.sign(s).sum())-np.sign(d.bp))/6
d['br_z']=(g.z.transform('sum')-d.z)/6
d['br_lm']=(g.lm.transform('sum')-d.lm)/6
prev=d[d.e==720][['coin','window','up','bp']].copy(); prev['window']+=900; prev=prev.rename(columns={'up':'pup','bp':'pbp'})
d=d.merge(prev,on=['coin','window'],how='left'); d['pup']=d.pup.fillna(0.5)-0.5; d['pbp']=d.pbp.fillna(0).clip(-50,50)
d['hr']=((d.window//3600+9)%24)
F=['lm','z','bp','mom60','binlead','futlead','imb','br_sign','br_z','br_lm','pup','pbp']
d[F]=d[F].replace([np.inf,-np.inf],np.nan).fillna(0)
for f in F[1:]: d[f]=d[f].clip(d[f].quantile(0.005),d[f].quantile(0.995))
def fit(X,y,l2=1.0):
    w=np.zeros(X.shape[1])
    for _ in range(50):
        p=1/(1+np.exp(-X@w)); g=X.T@(p-y)+l2*w; Hs=(X*(p*(1-p))[:,None]).T@X+l2*np.eye(X.shape[1]); st=np.linalg.solve(Hs,g); w-=st
        if np.abs(st).max()<1e-8: break
    return w
days=sorted(d.day.unique()); res=[]
ll=lambda p,y: -(y*np.log(p)+(1-y)*np.log(1-p)).mean()
for e in sorted(d.e.unique()):
    x=d[d.e==e]
    for i,day in enumerate(days):
        if i<3: continue
        tr=x[x.day<day]; te=x[x.day==day].copy()
        mu=tr[F].mean(); sd=tr[F].std()+1e-9
        X=np.c_[np.ones(len(tr)),((tr[F]-mu)/sd).values]; w=fit(X,tr.up.values.astype(float))
        te['pm']=1/(1+np.exp(-np.c_[np.ones(len(te)),((te[F]-mu)/sd).values]@w)); res.append(te)
r=pd.concat(res); r.to_pickle('crypto_pred.pkl')
print("out-of-sample (walk-forward by day, days 4-10). log loss: market mid vs ensemble model")
for e,x in r.groupby('e'): print(f"  {e:4d}s in: market {ll(x.mid.values,x.up.values):.4f}  model {ll(x.pm.clip(.01,.99).values,x.up.values):.4f}  n {len(x)}")
x=d[d.e==180]; mu=x[F].mean(); sd=x[F].std()+1e-9; w=fit(np.c_[np.ones(len(x)),((x[F]-mu)/sd).values],x.up.values.astype(float))
print("coefs at 180s (standardised):",dict(zip(['c']+F,np.round(w,3))))
FEE=0.07
def trades(r,thr,lo,hi,es,coins=None,first=True):
    T=[]
    for (c,w),x in r[r.e.isin(es)].sort_values('e').groupby(['coin','window']):
        if coins and c not in coins: continue
        for q in x.itertuples():
            eu=q.pm-q.upAsk-FEE*q.upAsk*(1-q.upAsk); ed=(1-q.pm)-q.dnAsk-FEE*q.dnAsk*(1-q.dnAsk)
            if eu>=thr and lo<=q.upAsk<=hi: T.append((q.day,c,w,q.e,q.upAsk,q.up,q.up-q.upAsk-FEE*q.upAsk*(1-q.upAsk),q.hr)); break
            if ed>=thr and lo<=q.dnAsk<=hi: T.append((q.day,c,w,q.e,q.dnAsk,1-q.up,(1-q.up)-q.dnAsk-FEE*q.dnAsk*(1-q.dnAsk),q.hr)); break
    return pd.DataFrame(T,columns='day coin window e ask won pnl hr'.split())
print("\nrule: buy the side where model prob - ask - fee >= thr, ask band, first trigger per coin-window; pnl per share")
for es,lab in (([90,120,180],'90-180s'),([240,360,480],'4-8min'),([600,720],'10-12min')):
    for lo,hi in ((0.35,0.65),(0.55,0.85)):
        for thr in (0.02,0.04,0.06):
            t=trades(r,thr,lo,hi,es)
            if len(t)<50: continue
            wk=t.groupby('window').pnl.sum(); 
            print(f"  {lab:9s} ask {lo}-{hi} thr {thr}: n {len(t):5d} won {t.won.mean()*100:.1f}% ask {t.ask.mean()*100:.1f} net {t.pnl.mean()*100:+.2f}c/share  window-SE {wk.std()/len(wk)**.5*len(wk)/len(t)*100:.2f}  days+ {(t.groupby('day').pnl.sum()>0).sum()}/{t.day.nunique()}  by day: "+" ".join(f"{v*100:+.0f}" for v in t.groupby('day').pnl.sum().values))
