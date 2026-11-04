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
        with urllib.request.urlopen(req, timeout=30) as r:
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
    with urllib.request.urlopen(req, timeout=20) as r:
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
    for f in sorted(glob.glob(os.path.join(DATA, "*live", "*.jsonl")))[-30:]:
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
    sys.exit(0 if code in (200, 201) else 1)


if __name__ == "__main__":
    main()
