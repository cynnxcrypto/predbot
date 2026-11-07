"""Price paths for resolved non-crypto Polymarket markets (other-categories survey, Nov 2026).
Research only: never touches the bot or deploy/live-rules.json. Runs on GitHub Actions
(.github/workflows/other-survey.yml). Input targets.csv.gz (market_id, cond, tok, end, start, closed).
Output out/paths_NNN.parquet: market_id, t, p (outcome 0). Kept points: hourly from anchor-8d,
10-minute within 30h of an anchor. Resumable: markets already in out/ are skipped."""
import csv, gzip, json, os, sys, time, glob, urllib.request, urllib.parse, urllib.error
from concurrent.futures import ThreadPoolExecutor
import pyarrow as pa, pyarrow.parquet as pq
D = os.path.dirname(os.path.abspath(__file__)); OUT = D + "/out"
UA = {"User-Agent": "predbot-research/1.0 (github.com/cynnxcrypto/predbot)", "Accept-Encoding": "gzip"}
BUDGET = float(os.environ.get("BUDGET_MIN", "300")) * 60; T0 = time.time()
def get(url, params, tries=5):
    url += "?" + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                b = r.read()
                if r.headers.get("Content-Encoding") == "gzip": b = gzip.decompress(b)
                return json.loads(b)
        except urllib.error.HTTPError as e:
            if e.code in (400, 404, 410, 422): return None
            time.sleep(min(60, 3 * 2 ** i) if e.code == 429 else 2 * (i + 1))
        except Exception:
            time.sleep(2 * (i + 1))
    return None
def one(r):
    mid = int(r["market_id"]); end, st, cl = int(r["end"] or 0), int(r["start"] or 0), int(r["closed"] or 0)
    anchors = [a for a in (end, st) if a > 0]
    if not anchors: return mid, []
    lo = min(anchors) - 8 * 86400; hi = max(anchors + [cl]) + 6 * 3600
    if cl > 0: hi = min(hi, cl + 3600)
    j = get("https://clob.polymarket.com/prices-history", {"market": r["tok"], "startTs": lo, "endTs": hi, "fidelity": 10})
    if not j or "history" not in j:
        j = get("https://clob.polymarket.com/prices-history", {"market": r["tok"], "interval": "max", "fidelity": 10})
    pts = (j or {}).get("history") or []
    keep, lasth = [], None
    for x in pts:
        t, p = int(x["t"]), float(x["p"])
        if t < lo or t > hi: continue
        near = any(abs(t - a) <= 30 * 3600 for a in anchors)
        h = t // 3600
        if near or h != lasth:
            keep.append((mid, t, p)); lasth = h
    return mid, keep
def main():
    os.makedirs(OUT, exist_ok=True)
    done = set()
    for f in glob.glob(OUT + "/paths_*.parquet"): done |= set(pq.read_table(f, columns=["market_id"]).column(0).to_pylist())
    if os.path.exists(OUT + "/empty.txt"): done |= {int(x) for x in open(OUT + "/empty.txt").read().split()}
    rows = [r for r in csv.DictReader(gzip.open(D + "/targets.csv.gz", "rt")) if int(r["market_id"]) not in done]
    print("todo", len(rows), "done", len(done), flush=True)
    k = len(glob.glob(OUT + "/paths_*.parquet")); CH = 1500
    with ThreadPoolExecutor(8) as ex:
        for i in range(0, len(rows), CH):
            if time.time() - T0 > BUDGET: print("budget hit"); break
            res = list(ex.map(one, rows[i:i + CH]))
            pts = [x for _, ps in res for x in ps]; empty = [m for m, ps in res if not ps]
            if pts:
                m_, t_, p_ = zip(*pts)
                pq.write_table(pa.table({"market_id": pa.array(m_, pa.int64()), "t": pa.array(t_, pa.int64()), "p": pa.array(p_, pa.float32())}),
                               f"{OUT}/paths_{k:03d}.parquet", compression="zstd"); k += 1
            with open(OUT + "/empty.txt", "a") as f: f.write("".join(f"{m}\n" for m in empty))
            print(f"chunk {i//CH} pts {len(pts)} empty {len(empty)} {time.time()-T0:.0f}s", flush=True)
            os.system(f'cd {D}/../.. && git add research/other/out && git commit -qm "other-survey: chunk {i//CH}" && (git push -q || (git pull -q --rebase && git push -q))')
main()
