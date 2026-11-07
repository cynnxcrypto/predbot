exec(open("fills.py").read().split("cov=")[0])
R=json.load(open("rows.json"))
for ser in ("spx-daily-up-or-down","spy-daily-up-or-down","gold-daily-up-or-down","oil-daily-up-or-down","dow-jones-daily-up-or-down","ndx-daily-up-or-down","silver-daily-up-or-down"):
  for ck in (2,1,0.25):
    for thr,lim in ((0.90,0.85),(0.95,0.90),(0.97,0.93)):
        out=[]; days=set()
        for r in R:
            if r["s"]!=ser or r["ck"]!=ck or r["fair"] is None: continue
            side=0 if r["fair"]>=thr else (1 if r["fair"]<=1-thr else None)
            if side is None: continue
            x=fill(r["mid"],r["t"],side,lim,win=int(ck*3600*0.75))
            won=r["up"] if side==0 else not r["up"]
            if x is not None: out.append((won-x-fee(x),won,x)); days.add(r["C"])
        if out: print(f"{ser} T-{ck}h fair>={thr} buy<={lim}: fills {len(out)} won {100*st.mean(w for _,w,_ in out):.0f}% avg px {100*st.mean(x for *_,x in out):.0f}c net {100*st.mean(a for a,*_ in out):+.1f}c")
