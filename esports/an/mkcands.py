exec(open("an/common.py").read())
C=[]
for eid,ms in ev.items():
    mm=[r for r in ms if r["smt"]=="moneyline" and "BO3" in r["q"].upper()]
    m1=[r for r in ms if r["smt"]=="child_moneyline" and re.search(r"(Map|Game) 1 Winner",r["q"])]
    if not mm or not m1: continue
    M=mm[0]; A=m1[0]; g=ts(M["gst"])
    if not g or (M["vol"] or 0)<5000 or A["outs"]!=M["outs"]: continue
    P0,age=pat(M["h"],g-600)
    if P0 is None or age>3*3600: continue
    w1=A["win"]; t_end=map_end(A,g,w1)
    if not t_end: continue
    pw=pat(M["h"],t_end+120)[0]; pw=pw if w1==0 else 1-pw
    C.append(dict(eid=eid,game=M["game"],tok=M["tok"][w1],tok2=M["tok"][1-w1],t=int(t_end),p0w=P0 if w1==0 else 1-P0,pw=pw,won=M["win"]==w1,vol=M["vol"],fee=(M["fee"] or {}).get("rate") or 0, q=M["q"][:80]))
json.dump(C,open("cands.json","w"))
print(len(C))
