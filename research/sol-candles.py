#!/usr/bin/env python3
"""Price history for the slow-trade research (12 Nov 2026, enrique: "u cant find a way to trade this well?").

READ-ONLY on Binance's PUBLIC market data (no key, no account, no order). It downloads hourly candles of SOL, BTC,
ETH and a few Solana tokens, plus the funding rate of their perpetuals, and publishes them to the server-data branch
under server/research/ so the research threads (which cannot reach an exchange) can test slow rules on years of
history instead of waiting weeks on paper:

  candles/<SYMBOL>-1h.json.gz   {"symbol", "interval", "t": [hour numbers since 1970], "o", "h", "l", "c", "qv"}
  funding/<SYMBOL>.json.gz      {"symbol", "t": [ms], "rate": [funding rate of that 8 h period]}
  progress.json                 what was read, errors

Started once by the Solana paper runner (src/solana/candles.ts), detached, niced, with a lock; it writes
data/research/CANDLES-DONE-v1 when finished so it never starts again. SOLANA_CANDLES=off disables it. About 500
requests at 4 a second: far under the exchange's limit, so the bot's own price feed is not put at risk. Stdlib only.
It touches nothing of the bot: no live rule, no wallet, no data file of the trading code."""
import base64, fcntl, gzip, json, os, sys, time, urllib.request, urllib.error

REPO, BRANCH = "cynnxcrypto/predbot", "server-data"
SPOT, PERP = "https://api.binance.com", "https://fapi.binance.com"
OUT = os.path.expanduser("~/predbot/data/research")
DONE = os.path.join(OUT, "CANDLES-DONE-v1")
FROM_MS = 1609459200000  # 1 Jan 2021 UTC
SYMBOLS = ["SOLUSDT", "BTCUSDT", "ETHUSDT", "JUPUSDT", "BONKUSDT", "WIFUSDT", "JTOUSDT", "RAYUSDT", "PYTHUSDT"]
FUNDING = ["SOLUSDT", "BTCUSDT", "ETHUSDT"]
PROGRESS = {"started": int(time.time()), "candles": {}, "funding": {}, "errors": []}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def get(url, tries=4):
    """JSON GET of a public endpoint; None on failure. About 4 requests a second at most."""
    for i in range(tries):
        time.sleep(0.25)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "PredBotResearch/0.1", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (418, 429):  # the exchange asks us to slow down: stop for good, the bot's feed comes first
                PROGRESS["errors"].append(f"{e.code} rate limit, stopped")
                return "stop"
            if e.code in (500, 502, 503, 504):
                time.sleep(3 * (i + 1))
                continue
            if len(PROGRESS["errors"]) < 40:
                PROGRESS["errors"].append(f"{e.code} {url[:120]}")
            return None
        except Exception:
            time.sleep(2 * (i + 1))
    if len(PROGRESS["errors"]) < 40:
        PROGRESS["errors"].append(f"fail {url[:120]}")
    return None


def gh(method, path, body=None):
    req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json",
                                          "User-Agent": "predbot-server"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return 0, None


def publish(name, obj, gz=True):
    """Saves locally and puts the file on the server-data branch (retries on a sha race)."""
    blob = json.dumps(obj, separators=(",", ":")).encode()
    if gz:
        blob = gzip.compress(blob, 9)
    local = os.path.join(OUT, name)
    os.makedirs(os.path.dirname(local), exist_ok=True)
    open(local, "wb").write(blob)
    path = f"server/research/{name}"
    for _ in range(3):
        code, cur = gh("GET", f"contents/{path}?ref={BRANCH}")
        body = {"message": f"research {name}", "branch": BRANCH, "content": base64.b64encode(blob).decode()}
        if code == 200 and cur:
            body["sha"] = cur["sha"]
        code, _ = gh("PUT", f"contents/{path}", body)
        if code in (200, 201):
            log(f"published {name} {len(blob) // 1024} KB")
            return True
        time.sleep(5)
    PROGRESS["errors"].append(f"publish {name} failed")
    return False


def candles(symbol):
    """Hourly candles from FROM_MS (or the listing) to now. Returns the column object, or None / "stop"."""
    t, o, h, l, c, qv = [], [], [], [], [], []
    start = FROM_MS
    while True:
        rows = get(f"{SPOT}/api/v3/klines?symbol={symbol}&interval=1h&startTime={start}&limit=1000")
        if rows == "stop":
            return "stop"
        if not rows:
            break
        for k in rows:
            t.append(int(k[0]) // 3600000)
            o.append(float(k[1])); h.append(float(k[2])); l.append(float(k[3])); c.append(float(k[4]))
            qv.append(round(float(k[7])))
        start = int(rows[-1][0]) + 3600000
        if len(rows) < 1000:
            break
    if not t:
        return None
    return {"symbol": symbol, "interval": "1h", "t": t, "o": o, "h": h, "l": l, "c": c, "qv": qv}


def funding(symbol):
    t, rate = [], []
    start = FROM_MS
    while True:
        rows = get(f"{PERP}/fapi/v1/fundingRate?symbol={symbol}&startTime={start}&limit=1000")
        if rows == "stop":
            return "stop"
        if not rows:
            break
        for k in rows:
            t.append(int(k["fundingTime"])); rate.append(float(k["fundingRate"]))
        start = int(rows[-1]["fundingTime"]) + 1
        if len(rows) < 1000:
            break
    return {"symbol": symbol, "t": t, "rate": rate} if t else None


def main():
    stopped = False
    for s in SYMBOLS:
        got = candles(s)
        if got == "stop":
            stopped = True
            break
        if got and publish(f"candles/{s}-1h.json.gz", got):
            PROGRESS["candles"][s] = {"rows": len(got["t"]), "from": got["t"][0] * 3600, "to": got["t"][-1] * 3600}
        else:
            PROGRESS["candles"][s] = {"rows": 0}
        publish("progress.json", PROGRESS, gz=False)
    for s in ([] if stopped else FUNDING):
        got = funding(s)
        if got == "stop":
            stopped = True
            break
        if got and publish(f"funding/{s}.json.gz", got):
            PROGRESS["funding"][s] = {"rows": len(got["t"])}
        else:
            PROGRESS["funding"][s] = {"rows": 0}
    PROGRESS["finished"] = int(time.time())
    PROGRESS["stoppedByRateLimit"] = stopped
    publish("progress.json", PROGRESS, gz=False)
    # done once SOL's own history is out; a rate-limit stop is not retried either (the bot's feed comes first)
    if PROGRESS["candles"].get("SOLUSDT", {}).get("rows") or stopped:
        open(DONE, "w").write(str(int(time.time())))
    log("finished", json.dumps(PROGRESS)[:600])


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    try:
        os.nice(15)
    except Exception:
        pass
    _lock = open(os.path.join(OUT, "candles.lock"), "w")
    try:
        fcntl.flock(_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another copy is running; exiting")
        sys.exit(0)
    if os.path.exists(DONE):
        sys.exit(0)
    TOKEN = open(os.path.expanduser("~/.predbot-github-token")).read().strip()
    main()
