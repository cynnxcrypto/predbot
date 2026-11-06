#!/usr/bin/env python3
"""Posts a compact summary of this copy of Pred bot (the AWS server) to the `server-data` branch on GitHub, so Claude
can read the server's results (no Claude session can reach the server itself). Run by cron every 15 min, see
deploy/report-setup.sh. Needs a GitHub token with Contents read/write on this repo in ~/.predbot-github-token.
The repo is public: wallet, funder, balances, order ids and tokens are left out on purpose."""
import base64, glob, gzip, json, os, sys, time, urllib.request

REPO = "cynnxcrypto/predbot"
BRANCH = "server-data"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
DATA = os.path.join(ROOT, "data")
TOKEN = open(os.path.expanduser("~/.predbot-github-token")).read().strip()


def gh(method, path, body=None):
    req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/{path}".rstrip("/"), method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json",
                                          "User-Agent": "predbot-server"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, None


def summary():
    req = urllib.request.Request("http://127.0.0.1:8790/api/status")
    try:  # the dashboard has a password since 31 Oct 2026 23:15 KST (deploy/dashboard-setup.sh)
        pw = json.load(open(os.path.join(DATA, "dashboard.json"))).get("password") or ""
        req.add_header("Authorization", "Basic " + base64.b64encode(f"report:{pw}".encode()).decode())
    except FileNotFoundError:
        pass
    with urllib.request.urlopen(req, timeout=90) as r:  # 6 Nov 2026: 5 MB status, 20 s may not be enough
        s = json.load(r)
    out = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "build": s.get("build"), "series": []}
    for x in [s] + (s.get("series") or []):
        live = x.get("live") or {}
        out["series"].append({
            "key": x.get("key") or "btc5m", "label": x.get("label"), "windowsDone": x.get("windowsDone"),
            "lastError": x.get("lastError"),
            "feeds": [{"name": f.get("name"), "healthy": f.get("healthy"), "errors": f.get("errors")} for f in x.get("feeds") or []],
            "papers": [{k: p.get(k) for k in ("name", "size", "trades", "won", "net", "fillable", "open", "discarded")} | {"days": (p.get("days") or [])[:7]}
                       for p in x.get("papers") or [] if p.get("trades")],
            "live": {k: live.get(k) for k in ("mode", "variants", "maxLossPerDay", "realByVariant", "ready", "trades", "won", "net", "todayNet", "lastError", "lastOrderAt")} if live else None,
        })
    try:
        lat = json.load(open(os.path.join(DATA, "latency.json")))
        out["latency"] = {k: lat.get(k) for k in ("n", "warmMedian", "coldMedian", "binanceMedian")}
    except Exception:
        out["latency"] = None
    rows = []
    # Newest days first across every series (sorting by the full path kept only the alphabetically last series).
    for f in sorted(glob.glob(os.path.join(DATA, "*live", "*.jsonl")), key=os.path.basename)[-60:]:
        series = os.path.basename(os.path.dirname(f)).removesuffix("-live") or "btc5m"
        for line in open(f):
            try:
                t = json.loads(line)
            except Exception:
                continue
            rows.append({"series": "btc5m" if series == "live" else series} | {k: t.get(k) for k in ("t", "window", "left", "variant", "side", "ask", "limit", "freshAsk", "dry", "ok", "status", "error", "cost", "shares", "fee", "ms", "won", "pnl")})
    out["realTrades"] = sorted(rows, key=lambda r: r.get("t") or 0)[-200:]
    return out


def put(path, obj):
    code, cur = gh("GET", f"contents/{path}?ref={BRANCH}")
    body = {"message": f"server data {time.strftime('%m-%d %H:%M', time.gmtime())}Z", "branch": BRANCH,
            "content": base64.b64encode(json.dumps(obj, indent=1).encode()).decode()}
    if code == 200 and cur:
        body["sha"] = cur["sha"]
    code, _ = gh("PUT", f"contents/{path}", body)
    return code


def upload_books():
    """Once per UTC day, post yesterday's 15m book rows for the early-move zone (first 3 minutes of each window, top 3
    levels per side) gzipped to server/books/<series>/<day>.jsonl.gz, so maker and fill studies can use the server's own
    books (4 Nov 2026). About 3 MB a day for 7 coins. Failures never stop the status post."""
    day = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 86400))
    for d in sorted(glob.glob(os.path.join(DATA, "*15m-book"))):
        series = os.path.basename(d).removesuffix("-book")
        src = os.path.join(d, f"{day}.jsonl")
        path = f"server/books/{series}/{day}.jsonl.gz"
        if not os.path.exists(src) or gh("GET", f"contents/{path}?ref={BRANCH}")[0] == 200:
            continue
        out = []
        with open(src) as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if (r.get("left") or 0) < 720:
                    continue
                for k in ("upAsks", "upBids", "downAsks", "downBids"):
                    if isinstance(r.get(k), list):
                        r[k] = r[k][:3]
                out.append(json.dumps(r, separators=(",", ":")))
        blob = gzip.compress(("\n".join(out) + "\n").encode())
        code, _ = gh("PUT", f"contents/{path}", {"message": f"server books {series} {day}", "branch": BRANCH,
                                                  "content": base64.b64encode(blob).decode()})
        print(f"books {series} {day}: {len(out)} rows, {len(blob) // 1024} KB, GitHub {code}")


HIST_FROM = "2026-10-31"  # first full day on the server (moved to Stockholm 31 Oct 2026)
HIST_COLS = ["t", "window", "left", "upAsk", "upBid", "downAsk", "downBid", "upAsk1", "upBid1", "downAsk1", "downBid1",
             "upAsk3", "upBid3", "downAsk3", "downBid3", "upAskDepth", "downAskDepth", "chainlink", "binance", "coinbase",
             "futures", "open"]


def _sz(levels, n):
    try:
        return round(sum(float(x[1]) for x in (levels or [])[:n]), 1)
    except (TypeError, ValueError, IndexError):
        return None


def upload_history(budget_s=600):
    """Backfill for the systematic strategy search (4 Nov 2026): every past day's FULL 5m and 15m books, one row per
    second (the last snapshot of each second) as compact arrays (columns in HIST_COLS, sizes of the best level and the
    top 3 levels per side), plus each window's resolution, gzipped to server/hist/<series>/<day>.jsonl.gz and
    <day>-windows.jsonl.gz. Skips files already on GitHub, stops after `budget_s` seconds, runs at the lowest CPU
    priority under a lock so the trader and the next cron run are never slowed or doubled up."""
    import fcntl
    lock = open(os.path.join(DATA, ".hist-upload.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return
    try:
        os.nice(19)
    except OSError:
        pass
    start = time.time()
    today = time.strftime("%Y-%m-%d", time.gmtime())
    dirs = sorted(glob.glob(os.path.join(DATA, "*book")))
    for d in dirs:
        prefix = os.path.basename(d).removesuffix("book")  # "" for the first series (btc5m), else "eth15m-"
        series = prefix.rstrip("-") or "btc5m"
        if not (series.endswith("5m") or series.endswith("15m")) or series.endswith("-"):
            continue
        for src in sorted(glob.glob(os.path.join(d, "*.jsonl"))):
            day = os.path.basename(src)[:-6]
            if day < HIST_FROM or day >= today:
                continue
            if time.time() - start > budget_s:
                return
            path = f"server/hist/{series}/{day}.jsonl.gz"
            if gh("GET", f"contents/{path}?ref={BRANCH}")[0] == 200:
                continue
            out, last, key = [], None, None
            with open(src) as f:
                for line in f:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    k = (r.get("window"), r.get("left"))
                    if k != key and last is not None:
                        out.append(json.dumps(last, separators=(",", ":")))
                    key = k
                    last = [int((r.get("t") or 0) // 1000), r.get("window"), r.get("left"), r.get("upAsk"), r.get("upBid"),
                            r.get("downAsk"), r.get("downBid"), _sz(r.get("upAsks"), 1), _sz(r.get("upBids"), 1),
                            _sz(r.get("downAsks"), 1), _sz(r.get("downBids"), 1), _sz(r.get("upAsks"), 3),
                            _sz(r.get("upBids"), 3), _sz(r.get("downAsks"), 3), _sz(r.get("downBids"), 3),
                            r.get("upAskDepth"), r.get("downAskDepth"), r.get("chainlink"), r.get("binance"),
                            r.get("coinbase"), r.get("futures"), r.get("open")]
            if last is not None:
                out.append(json.dumps(last, separators=(",", ":")))
            wins = {}
            wsrc = os.path.join(DATA, f"{prefix}windows", f"{day}.jsonl")
            if os.path.exists(wsrc):
                for line in open(wsrc):
                    try:
                        w = json.loads(line)
                    except ValueError:
                        continue
                    wins[w.get("window")] = {k: w.get(k) for k in ("window", "open", "close", "resolvedUp", "status",
                                                                   "chainlinkTwap60", "chainlinkTwap60AtOpen",
                                                                   "chainlinkAtOpen", "chainlinkAtClose")}
            wblob = gzip.compress(("\n".join(json.dumps(w, separators=(",", ":")) for w in wins.values()) + "\n").encode())
            gh("PUT", f"contents/server/hist/{series}/{day}-windows.jsonl.gz",
               {"message": f"server hist windows {series} {day}", "branch": BRANCH, "content": base64.b64encode(wblob).decode()})
            blob = gzip.compress(("\n".join([json.dumps(HIST_COLS)] + out) + "\n").encode())
            code, _ = gh("PUT", f"contents/{path}", {"message": f"server hist {series} {day}", "branch": BRANCH,
                                                      "content": base64.b64encode(blob).decode()})
            print(f"hist {series} {day}: {len(out)} rows, {len(blob) // 1024} KB, GitHub {code}")


def main():
    code, _ = gh("GET", "")
    if code != 200:
        sys.exit(f"GitHub said {code} reading the repo: the token is wrong or does not include predbot")
    if gh("GET", f"branches/{BRANCH}")[0] == 404:
        code, main_ref = gh("GET", "git/ref/heads/main")
        code, _ = gh("POST", "git/refs", {"ref": f"refs/heads/{BRANCH}", "sha": main_ref["object"]["sha"]})
        if code != 201:
            sys.exit(f"GitHub said {code} creating the {BRANCH} branch: the token needs Contents: Read and write")
    code = put("server/status.json", summary())
    try:
        upload_books()
    except Exception as e:  # noqa: BLE001 - never let the book upload break the status report
        print(f"book upload failed: {e}")
    print("posted" if code in (200, 201) else f"GitHub said {code}")
    if code in (200, 201) and os.fork() == 0:  # backfill runs detached so cron's status post finishes at once
        try:
            upload_history()
        except Exception as e:  # noqa: BLE001
            print(f"history upload failed: {e}")
        os._exit(0)
    sys.exit(0 if code in (200, 201) else 1)


if __name__ == "__main__":
    main()
