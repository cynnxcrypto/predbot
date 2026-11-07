import pickle, collections, math
recs = pickle.load(open("/tmp/wx_recs.pkl", "rb"))
FEE = 0.05; SLIP = 0.01
def cost(p): return p + SLIP + FEE * p * (1 - p)
bins = [(0, .03), (.03, .07), (.07, .15), (.15, .3), (.3, .5), (.5, .7), (.7, .85), (.85, .93), (.93, .97), (.97, 1.01)]
dates = sorted({x["date"] for x in recs}); mid = dates[len(dates)//2]
for snap in ("D-1 12:00", "D-1 20:00", "D 08:00", "D 11:00", "D 14:00", "D 17:00"):
    print("==", snap, "(bin: n, won%, avg price, YES $/share net, NO $/share net, [1st half YES, 2nd half YES])")
    for lo, hi in bins:
        X = [(p, w, x["date"]) for x in recs if x["snap"] == snap for p, w in zip(x["ps"], x["won"]) if lo <= p < hi]
        if not X: continue
        n = len(X); wr = sum(w for _, w, _ in X) / n; ap = sum(p for p, _, _ in X) / n
        yes = sum(w - cost(p) for p, w, _ in X) / n; no = sum((1 - w) - cost(1 - p) for p, w, _ in X) / n
        h1 = [w - cost(p) for p, w, d in X if d < mid]; h2 = [w - cost(p) for p, w, d in X if d >= mid]
        print(f"  {lo:.2f}-{hi:.2f}: {n:5d} won {wr*100:5.1f}% px {ap:.3f}  YES {yes:+.3f}  NO {no:+.3f}  [{sum(h1)/max(len(h1),1):+.3f} {sum(h2)/max(len(h2),1):+.3f}]")
