import pickle, statistics as S, collections, math
rows = pickle.load(open("/tmp/wx_rows.pkl", "rb"))
def actual(r):
    if r["om"] is not None: return r["om"]
    w = next(b for b in r["bk"] if b["won"])
    if w["lo"] < -500: return w["hi"]
    if w["hi"] > 500: return w["lo"]
    return (w["lo"] + w["hi"]) / 2
for r in rows: r["act"] = actual(r)
for k in ("f0", "f1", "f2"):
    e = [(r["act"] - r[k]) / (1.8 if r["unit"] == "F" else 1) for r in rows if r[k] is not None]
    print(k, "n", len(e), "bias C %.2f" % S.mean(e), "sd C %.2f" % S.pstdev(e), "MAE %.2f" % S.mean(abs(x) for x in e))
bc = collections.defaultdict(list)
for r in rows: bc[r["city"]].append((r["act"] - r["f1"]) / (1.8 if r["unit"] == "F" else 1))
out = sorted(((S.mean(v), S.pstdev(v), len(v), c) for c, v in bc.items()))
print("city bias (C, actual-forecast lead1): most negative / most positive")
for m, s, n, c in out[:6] + out[-8:]: print(f"  {c:16s} bias {m:+.2f} sd {s:.2f} n {n}")
# split halves stability of bias
st = []
for c, v in bc.items():
    h = len(v)//2; st.append((S.mean(v[:h]), S.mean(v[h:])))
import numpy as np
a = np.array(st); print("bias corr first vs second half", np.corrcoef(a[:,0], a[:,1])[0,1])
