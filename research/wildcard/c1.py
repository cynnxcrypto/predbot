import json, gzip, glob, numpy as np, pandas as pd, os, sys
from concurrent.futures import ProcessPoolExecutor
R='/home/claude/sd/server/hist/'
coins=['btc','eth','sol','xrp','doge','bnb','hype']
ELS=[90,120,180,240,360,480,600,720]
def one(args):
    c,f=args; day=os.path.basename(f)[:10]
    wf=f.replace('.jsonl.gz','-windows.jsonl.gz')
    if not os.path.exists(wf): return []
    wins={}
    for l in gzip.open(wf,'rt'):
        j=json.loads(l); wins[j['window']]=j
    it=gzip.open(f,'rt'); hdr=json.loads(next(it)); I={k:i for i,k in enumerate(hdr)}
    cur=None; buf=[]; out=[]
    def flush(w,buf):
        j=wins.get(w)
        if not j or j.get('resolvedUp') is None or len(buf)<600: return
        a=np.array([[np.nan if r[I[k]] is None else r[I[k]] for k in ('left','upAsk','upBid','downAsk','downBid','upAsk1','upBid1','downAsk1','downBid1','chainlink','binance','futures','upAskDepth','downAskDepth')] for r in buf],dtype=float)
        ref=j.get('chainlinkTwap60AtOpen') or buf[0][I['open']]
        if not ref: return
        el=900-a[:,0]
        for e in ELS:
            k=np.searchsorted(el,e)
            if k>=len(a) or abs(el[k]-e)>3: continue
            r=a[k]; cl=a[:k+1,9]; cl=cl[~np.isnan(cl)]
            if len(cl)<30 or np.isnan(r[9]): continue
            ret=np.diff(np.log(cl)); sig=ret.std()*1e4
            k60=max(0,k-60)
            out.append(dict(coin=c,day=day,window=w,e=e,up=int(j['resolvedUp']),upAsk=r[1],upBid=r[2],dnAsk=r[3],dnBid=r[4],
                bp=(r[9]-ref)/ref*1e4, sig=sig, mom60=(r[9]-a[k60,9])/ref*1e4, binlead=((r[10]-r[9])-(a[0,10]-a[0,9]))/ref*1e4 if not np.isnan(r[10]) else 0.0,
                futlead=((r[11]-r[9])-(a[0,11]-a[0,9]))/ref*1e4 if not np.isnan(r[11]) else 0.0,
                imb=(r[6]-r[8])/(r[6]+r[8]+1e-9) if not (np.isnan(r[6]) or np.isnan(r[8])) else 0.0, upDepth=r[12], dnDepth=r[13]))
    for l in it:
        r=json.loads(l); w=r[I['window']]
        if w!=cur:
            if cur is not None: flush(cur,buf)
            cur=w; buf=[]
        buf.append(r)
    if cur is not None: flush(cur,buf)
    return out
if __name__=='__main__':
    jobs=[(c,f) for c in coins for f in sorted(glob.glob(R+c+'15m/2026-*.jsonl.gz')) if 'windows' not in f]
    rows=[]
    with ProcessPoolExecutor(4) as ex:
        for o in ex.map(one,jobs): rows+=o
    d=pd.DataFrame(rows); d.to_pickle('crypto.pkl'); print(len(d), d.groupby('day').window.nunique().to_dict())
