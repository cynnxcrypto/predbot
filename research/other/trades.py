"""Real fills for resolved non-crypto markets (other-categories survey). Research only.
data-api v2/trades per condition, newest first, until 8 days before the earliest anchor (max PAGES pages).
Output out/trades_NNN.parquet: market_id, t, price, size, side (0 buy 1 sell), oi (outcome index)."""
import csv, gzip, json, os, time, glob, urllib.request, urllib.parse, urllib.error
from concurrent.futures import ThreadPoolExecutor
import pyarrow as pa, pyarrow.parquet as pq
D = os.path.dirname(os.path.abspath(__file__)); OUT = D + "/out"
UA = {"User-Agent": "predbot-research/1.0 (github.com/cynnxcrypto/predbot)", "Accept-Encoding": "gzip"}
BUDGET = float(os.environ.get("BUDGET_MIN", "320")) * 60; T0 = time.time(); PAGES = 12
def get(url, params, tries=5):
    url += "?" + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                b = r.read()
                if r.headers.get("Content-Encoding") == "gzip": b = gzip.decompress(b)
                return json.loads(b)
        except urllib.error.HTTPError as e:
            if e.code in (400, 404, 410, 422): return {"err": e.code}
            time.sleep(min(60, 3 * 2 ** i) if e.code == 429 else 2 * (i + 1))
        except Exception:
            time.sleep(2 * (i + 1))
    return None
def rows_of(j):
    if isinstance(j, list): return j, None
    if not isinstance(j, dict): return [], None
    data = j.get("data") or j.get("trades") or j.get("results") or []
    return data, j.get("next_cursor") or j.get("nextCursor") or j.get("cursor")
def one(r):
    mid = int(r["market_id"]); anchors = [int(r[k]) for k in ("end", "start") if int(r[k] or 0) > 0]
    lo = (min(anchors) if anchors else 0) - 8 * 86400
    out, cur = [], None
    for _ in range(PAGES):
        p = {"condition": r["cond"], "limit": 500}
        if cur: p["cursor"] = cur
        j = get("https://data-api.polymarket.com/v2/trades", p)
        data, cur = rows_of(j)
        for x in data:
            t = int(x.get("timestamp") or x.get("t") or 0)
            out.append((mid, t, float(x.get("price") or 0), float(x.get("size") or 0),
                        0 if str(x.get("side", "")).upper() == "BUY" else 1, int(x.get("outcome_index", x.get("outcomeIndex", -1)) if x.get("outcome_index", x.get("outcomeIndex")) is not None else -1)))
        if not data or not cur or min(int(x.get("timestamp") or 0) for x in data) < lo: break
    return mid, out
def main():
    os.makedirs(OUT, exist_ok=True)
    r0 = next(csv.DictReader(gzip.open(D + "/targets.csv.gz", "rt")))
    j = get("https://data-api.polymarket.com/v2/trades", {"condition": r0["cond"], "limit": 3})
    open(OUT + "/trades_probe.txt", "w").write(json.dumps(j)[:3000]); print(json.dumps(j)[:1500], flush=True)
    done = set()
    for f in glob.glob(OUT + "/trades_*.parquet"): done |= set(pq.read_table(f, columns=["market_id"]).column(0).to_pylist())
    if os.path.exists(OUT + "/trades_empty.txt"): done |= {int(x) for x in open(OUT + "/trades_empty.txt").read().split()}
    rows = [r for r in csv.DictReader(gzip.open(D + "/targets.csv.gz", "rt")) if int(r["market_id"]) not in done]
    print("todo", len(rows), flush=True)
    k = len(glob.glob(OUT + "/trades_*.parquet")); CH = 1500
    with ThreadPoolExecutor(6) as ex:
        for i in range(0, len(rows), CH):
            if time.time() - T0 > BUDGET: print("budget hit"); break
            res = list(ex.map(one, rows[i:i + CH]))
            pts = [x for _, ps in res for x in ps]; empty = [m for m, ps in res if not ps]
            if pts:
                c = list(zip(*pts))
                pq.write_table(pa.table({"market_id": pa.array(c[0], pa.int64()), "t": pa.array(c[1], pa.int64()), "price": pa.array(c[2], pa.float32()),
                                         "size": pa.array(c[3], pa.float32()), "side": pa.array(c[4], pa.int8()), "oi": pa.array(c[5], pa.int8())}),
                               f"{OUT}/trades_{k:03d}.parquet", compression="zstd"); k += 1
            with open(OUT + "/trades_empty.txt", "a") as f: f.write("".join(f"{m}\n" for m in empty))
            print(f"chunk {i//CH} trades {len(pts)} empty {len(empty)} {time.time()-T0:.0f}s", flush=True)
            os.system(f'cd {D}/../.. && git add research/other/out && git commit -qm "other-survey trades: chunk {i//CH}" && (git push -q || (git pull -q --rebase && git push -q))')
main()
