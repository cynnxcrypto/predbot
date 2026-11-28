#!/usr/bin/env python3
"""Posts a compact summary of this copy of Pred bot (the AWS server) to the `server-data` branch on GitHub, so Claude
can read the server's results (no Claude session can reach the server itself). Run by cron every 15 min, see
deploy/report-setup.sh. Needs a GitHub token with Contents read/write on this repo in ~/.predbot-github-token.
The repo is public: wallet, funder, balances, order ids and tokens are left out on purpose."""
import base64, glob, gzip, json, os, re, shutil, subprocess, sys, time, urllib.request

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


def dashboard_url():
    """Current tunnel address; if it no longer answers, restart the tunnel once (EC2 ubuntu has passwordless sudo)."""
    url = _tunnel_url()
    # 20 Nov 2026 07:05 KST: the tunnel's address went missing from its log and nothing restarted it (only a dead
    # address was restarted). Now a missing address is restarted too, at most once in 20 minutes, and waited for longer.
    if not url or not _answers(url):
        mark = os.path.join(DATA, "tunnel-restart.txt")
        try:
            last = float(open(mark).read().strip() or 0)
        except Exception:  # noqa: BLE001
            last = 0
        if time.time() - last > 20 * 60:
            try:
                open(mark, "w").write(str(time.time()))
            except Exception:  # noqa: BLE001
                pass
            subprocess.run(["sudo", "-n", "systemctl", "restart", "predbot-dashboard"], capture_output=True, timeout=30)
            for _ in range(6):
                time.sleep(10)
                url = _tunnel_url()
                if url and _answers(url):
                    break
    return url


def tunnel_errors():
    """The tunnel's last error lines, for the status when there is no address (no addresses or IPs kept)."""
    try:
        out = subprocess.run(["sudo", "-n", "journalctl", "-u", "predbot-dashboard", "--no-pager", "-o", "cat", "-n", "200"],
                             capture_output=True, text=True, timeout=20).stdout
    except Exception:  # noqa: BLE001
        return []
    rows = [re.sub(r"\d+\.\d+\.\d+\.\d+|[0-9a-f:]{8,}", "…", x)[:160] for x in out.splitlines() if " ERR " in x or "error" in x.lower()]
    return rows[-4:]


def _answers(url):
    try:
        urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "predbot-server"}), timeout=15)
        return True
    except urllib.error.HTTPError as e:
        return e.code < 500  # 401 login prompt = the tunnel works; Cloudflare 530/502 = tunnel dead
    except Exception:  # noqa: BLE001
        return False


def _tunnel_url():
    """The Cloudflare quick-tunnel address changes whenever the tunnel restarts (7 Nov 2026: enrique lost the link and
    must never need AWS to find it). The dashboard itself is password protected."""
    for cmd in (["journalctl", "-u", "predbot-dashboard", "--no-pager", "-o", "cat", "-n", "3000"],
                ["sudo", "-n", "journalctl", "-u", "predbot-dashboard", "--no-pager", "-o", "cat", "-n", "3000"]):
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout
        except Exception:  # noqa: BLE001
            continue
        urls = re.findall(r"https://[a-z0-9-]+\.trycloudflare\.com", out)
        if urls:
            return urls[-1]
    return None


def _kst_day(ms):
    return time.strftime("%Y-%m-%d", time.gmtime(ms / 1000 + 9 * 3600)) if isinstance(ms, (int, float)) else None



def public_events(ep):
    """16 Nov 2026 review: a real Polymarket bet's exact time with its market and share count is enough to find our
    wallet in the market's public trades. Real rows and notes keep the KST day only; shares and cost are rounded."""
    if not isinstance(ep, dict):
        return ep
    ep = json.loads(json.dumps(ep))
    for g in ep.values():
        if not isinstance(g, dict):
            continue
        reals = [g.get("real")] + ([g["real"].get("rest")] if isinstance(g.get("real"), dict) else [])
        for real in reals:
            if not isinstance(real, dict):
                continue
            for key in ("recent", "notes"):
                for r in real.get(key) or []:
                    if not isinstance(r, dict):
                        continue
                    t = r.pop("t", None)
                    if isinstance(t, (int, float)):
                        r["day"] = time.strftime("%Y-%m-%d", time.gmtime(t / 1000 + 9 * 3600))
                    for k in ("shares", "cost"):
                        if isinstance(r.get(k), (int, float)):
                            r[k] = round(r[k])
                    if isinstance(r.get("why"), str) and "REAL" in r["why"]:
                        r["why"] = "REAL bought"
    return ep

def public_solana(sc):
    """16 Nov 2026 (privacy): on this public file the moment of a real trade of the two strategy wallets (spot rules,
    perps), with its coin, would be enough to find the wallet on the chain. Their results and counts stay; the trade
    times go, no open real perp is shown (a closed one keeps no leverage or time held), and the gas swap and top-ups
    keep only what they were. Each side's "today" (the dashboard card's figure: rows by the KST day of their time) is worked out here
    first. A copy: the bot's own data is not touched. The spot copy's own summary was public-safe from the start (no coin with a time)."""
    if not isinstance(sc, dict):
        return sc
    sc = json.loads(json.dumps(sc))
    bk = sc.get("buckets") if isinstance(sc.get("buckets"), dict) else {}
    perps = bk.get("perps") if isinstance(bk.get("perps"), dict) else {}
    today = _kst_day(time.time() * 1000)
    for real, key in ((bk.get("real"), "netSol"), (perps.get("real"), "netUsd"), (bk.get("perpsReal"), "netUsd")):
        if not isinstance(real, dict):
            continue
        rows = [r for r in real.get("rows") or [] if isinstance(r, dict)]
        real["today" + key[0].upper() + key[1:]] = round(sum(r.get(key) or 0 for r in rows if _kst_day(r.get("t")) == today), 6)
        for r in rows:
            r.pop("t", None)
            r.pop("sym", None)  # 20 Nov 2026: a real trade's coin is on the dashboard only, never in this public file
        opens = [o for o in real.get("opens") or [] if isinstance(o, dict)] + ([real["open"]] if isinstance(real.get("open"), dict) else [])
        for o in opens:
            o.pop("since", None)
            # review of 16 Nov 2026: an open perp's size (to the cent, as Jupiter stores it on the position), or its
            # leverage with the published collateral, finds the position on the chain in one search, and its owner is
            # the wallet; the unrealised result with its time and the public price give the entry back however it is
            # rounded. An open position here keeps only its rule, coin, side and stage.
            for k in ("sizeUsd", "collateralUsd", "leverage", "entryPrice", "unrealisedUsd", "pricedAt"):
                o.pop(k, None)
        if key == "netUsd":
            # second reader of the same review: an open perp's rule gives the trader's leverage in perpCopy.traderRecords,
            # so its exact size again, and even its coin and side, the 15 minutes in which it first shows here and the
            # $10 collateral of the live rules narrow a scan of Jupiter's positions to ours. So no open real perp is in
            # this file at all (the dashboard has them), and a closed one keeps no leverage or time held.
            for k in ("open", "opens", "openCount", "inPositionsUsd", "unrealisedUsd"):
                real.pop(k, None)
            for r in rows:
                r.pop("leverage", None)
                r.pop("heldH", None)
        for k in ("test", "testLong"):
            t = real.get(k)
            if isinstance(t, dict):
                t.pop("at", None)
                for r in t.get("rows") or []:
                    if isinstance(r, dict):
                        r.pop("t", None)
        g = real.get("gas")
        if isinstance(g, dict):
            if isinstance(g.get("swapOnce"), dict):
                g["swapOnce"] = {k: g["swapOnce"].get(k) for k in ("id", "result")}
            if isinstance(g.get("topups"), list):
                g["topups"] = len(g["topups"])
        # MAIN's fourth review, 16 Nov 2026: the dry runs run only when nothing is open (so their time is the first look
        # after a real position closed), and a rule's cut is stamped when its trade is booked (a liquidation's moment).
        # No moment of the real side is left here: every time in it becomes its KST day. A price failure keeps only its count
        # (its coin said a real perp on it was open).
        _days_only(real)
        if isinstance(real.get("priceFails"), dict):
            real["priceFails"] = {"n": real["priceFails"].get("n")}
        if key == "netSol":
            # an open real spot trade's rule, with the paper side's coin of that rule, gave the coin and the 2 minutes of the buy
            real.pop("opens", None)
            t = real.get("test")
            if isinstance(t, dict) and isinstance(t.get("open"), list):
                t["open"] = len(t["open"])
    _paper_of_real_rules(bk, perps)
    return sc


_TIME_KEYS = ("t", "at", "since", "boughtAt", "soldAt", "openedAt", "closedAt", "pricedAt")


def _days_only(o):
    """Every time in o (ms, under a key named like one) becomes its KST day."""
    if isinstance(o, dict):
        for k, v in list(o.items()):
            if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 1e12 and (k in _TIME_KEYS or k.endswith("At") or k.endswith("Ms")):
                o[k] = _kst_day(v)
            else:
                _days_only(v)
    elif isinstance(o, list):
        for v in o:
            _days_only(v)


def _paper_of_real_rules(bk, perps):
    """MAIN's fourth review, 16 Nov 2026: a real rule buys within 2 minutes of its paper twin, the same coin and side,
    at the published stake. So the paper side shows no open or recent trade (coin, side, time, price) of a rule that
    is real or has real trades, spot or perps; its paper record (counts, results) stays."""
    def real_ids(real):
        out = set()
        for r in (real or {}).get("rules") or []:
            if isinstance(r, dict) and (r.get("real") or r.get("realTrades") or r.get("trades")):
                out.add(r.get("id"))
        return out
    spot = real_ids(bk.get("real"))
    perp = real_ids(perps.get("real")) | real_ids(bk.get("perpsReal"))
    for k in ("spotOpen", "spotRecent"):
        if isinstance(bk.get(k), list):
            bk[k] = [x for x in bk[k] if not (isinstance(x, dict) and x.get("rule") in spot)]
    for r in perps.get("rules") or []:
        if isinstance(r, dict) and r.get("id") in perp:
            r["open"] = bool(r.get("open"))
    if isinstance(perps.get("recent"), list):
        perps["recent"] = [x for x in perps["recent"] if not (isinstance(x, dict) and x.get("rule") in perp)]
    # a copied trader that is real: its paper copies here are its own Hyperliquid trades (coin, side, time)
    pc = bk.get("perpCopy") if isinstance(bk.get("perpCopy"), dict) else {}
    tags = {"0x" + i[5:9] for i in perp if isinstance(i, str) and i.startswith("copy-") and len(i) >= 9}
    for k in ("recent", "byTrader"):
        if isinstance(pc.get(k), list):
            pc[k] = [x for x in pc[k] if not (isinstance(x, dict) and str(x.get("trader", ""))[:6] in tags)]
    for x in pc.get("traderRecords") or []:
        if isinstance(x, dict) and x.get("id") in perp:
            x.pop("open", None)


def summary():
    req = urllib.request.Request("http://127.0.0.1:8790/api/status")
    try:  # the dashboard has a password since 31 Oct 2026 23:15 KST (deploy/dashboard-setup.sh)
        pw = json.load(open(os.path.join(DATA, "dashboard.json"))).get("password") or ""
        req.add_header("Authorization", "Basic " + base64.b64encode(f"report:{pw}".encode()).decode())
    except FileNotFoundError:
        pass
    with urllib.request.urlopen(req, timeout=90) as r:  # 6 Nov 2026: 5 MB status, 20 s may not be enough
        s = json.load(r)
    du = shutil.disk_usage(ROOT)  # 6 Nov 2026: a full disk killed the bot for hours; watch it in every report
    out = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "build": s.get("build"),
           "diskFreeGB": round(du.free / 1e9, 2), "diskTotalGB": round(du.total / 1e9, 2),
           "dashboardUrl": dashboard_url(), "series": []}
    if not out["dashboardUrl"]:
        out["dashboardTunnel"] = tunnel_errors()
    for x in [s] + (s.get("series") or []):
        live = x.get("live") or {}
        out["series"].append({
            "key": x.get("key") or "btc5m", "label": x.get("label"), "windowsDone": x.get("windowsDone"),
            "lastError": x.get("lastError"),
            "feeds": [{"name": f.get("name"), "healthy": f.get("healthy"), "errors": f.get("errors")} for f in x.get("feeds") or []],
            "papers": [{k: p.get(k) for k in ("name", "size", "trades", "won", "net", "fillable", "open", "discarded")} | {"days": (p.get("days") or [])[:7]}
                       for p in x.get("papers") or [] if p.get("trades")],
            "live": {k: live.get(k) for k in ("mode", "variants", "maxLossPerDay", "realByVariant", "ready", "trades", "won", "net", "todayNet", "lastError", "lastOrderAt", "open", "openFills", "lastSkip", "skipsToday")} if live else None,
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
    out["eventPaper"] = public_events(s.get("eventPaper"))  # 7 Nov 2026: esports/indices/politics paper loggers (src/eventpaper.ts)
    out["budgets"] = s.get("budgets")
    out["preopen"] = s.get("preopen")
    out["pairlock"] = s.get("pairlock")
    out["pairfastlive"] = s.get("pairfastlive")  # 11 Nov 2026: REAL fast pair bot on BTC 5m, own $15 budget (src/pairfastlive.ts)
    out["pairfast"] = s.get("pairfast")  # 11 Nov 2026: feed-driven paper pair bot (src/pairfast.ts)
    # 11 Nov 2026: the wallet's all-time result from its whole history (src/wallethistory.ts). Profit and loss only:
    # what the wallet is worth and the money put in stay on the password-protected dashboard.
    wh = s.get("walletHistory") or {}
    out["walletHistory"] = {k: wh.get(k) for k in ("at", "source", "error", "rows", "truncated", "firstAt", "lastAt", "serverStart", "beforeNet", "sinceNet", "allTimeNet", "kinds", "unknown", "months")} if wh else None
    # the worth check: counts and results only, no balance and no deposit (src/worthdash.ts worthCheck)
    out["worthCheck"] = s.get("worthCheck")
    # the truth check: the dashboard minus the chain and Polymarket's own data, differences and counts only (src/truthcheck.ts)
    out["truthCheck"] = s.get("truthCheck")
    out["hyperliquid"] = s.get("hyperliquid")  # 17 Nov 2026: wallet made yes/no, reach checks, region; never the address
    if isinstance(out["hyperliquid"], dict) and isinstance(out["hyperliquid"].get("live"), dict):
        out["hyperliquid"]["live"].pop("account", None)  # the balance stays on the private page
        if isinstance(out["hyperliquid"]["live"].get("second"), dict):  # 19 Nov 2026: the second wallet's balances too
            out["hyperliquid"]["live"]["second"].pop("account", None)
            out["hyperliquid"]["live"]["second"].pop("first", None)
        if isinstance(out["hyperliquid"]["live"].get("third"), dict):  # 26 Nov 2026: the third wallet's balance too
            out["hyperliquid"]["live"]["third"].pop("account", None)
    # 19 Nov 2026: the bridge (src/bridge, stage, problems and steps of a move; dry by default) and the paper tests
    # (src/lab): both say no address by design; anything that still looks like one is cut here as well
    def _noaddr(v):
        if v is None:
            return None
        t = json.dumps(v)
        t = re.sub(r"0x[0-9a-fA-F]{16,}", "0x…", t)
        t = re.sub(r"\b[1-9A-HJ-NP-Za-km-z]{32,88}\b", "…", t)
        return json.loads(t)
    out["bridge"] = _noaddr(s.get("bridge"))
    out["paperTests"] = _noaddr(s.get("paperTests"))
    out["walletLinks"] = s.get("walletLinks")  # 17 Nov 2026: likely new wallets of liked Hyperliquid traders, counts and short tags only (full addresses behind the password)
    out["solanaCopy"] = public_solana(s.get("solanaCopy"))  # 11 Nov 2026: paper wallet-copy speed test on Solana (src/solana/copyrun.ts), read-only; keys are scrubbed there
    out["txTally"] = _noaddr(s.get("txTally"))  # 23 Nov 2026: on-chain transaction counts per wallet, ever and today (src/txcount.ts); counts only
    out["solanaSendOut"] = s.get("solanaSendOut")  # emptying the Solana wallets: flags and words only; amounts and tx ids sealed with the server key
    out["withdraw"] = s.get("withdraw")  # one-off withdrawal: stage, tries, confirmed, amounts; never an address or a transaction id
    # numbers only: never an address, token, signature or key; the wallet's balance stays off the public file too
    scl = {k: v for k, v in (s.get("solanaCopyLive") or {}).items() if k != "balanceSol"}
    # 11 Nov 2026: each copy's time (recent[].at) is for the password-protected dashboard only. On the public file the
    # moment of a trade would be enough to find the wallet that made it.
    if isinstance(scl.get("recent"), list):
        scl["recent"] = [{k: v for k, v in r.items() if k != "at"} for r in scl["recent"] if isinstance(r, dict)]
    out["solanaCopyLive"] = scl or None
    out["solana"] = s.get("solana")  # 11 Nov 2026: paper liquidity provision on Orca SOL/USDC (src/solana/), read-only
    out["pairlive"] = s.get("pairlive")  # 10 Nov 2026: budget, lost, open and left per real-money category
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
    try:
        upload_prints(today)
    except Exception as e:  # noqa: BLE001
        print(f"prints upload failed: {e}")
    dirs = sorted(glob.glob(os.path.join(DATA, "*book")))
    for d in dirs:
        prefix = os.path.basename(d).removesuffix("book")  # "" for the first series (btc5m), else "eth15m-"
        series = prefix.rstrip("-") or "btc5m"
        # 10 Nov 2026 (fair-value research): 1h, 4h and 24h books are published too, thinned so the upload stays small:
        # one row every 5 s for 1h, every 15 s for 4h and 24h (5m and 15m keep every second).
        step = 1 if (series.endswith("5m") or series.endswith("15m")) else 5 if series.endswith("1h") else 15 if (series.endswith("4h") or series.endswith("24h")) else 0
        if not step or series.endswith("-"):
            continue
        for src in sorted(glob.glob(os.path.join(d, "*.jsonl"))):
            day = os.path.basename(src)[:-6]
            if day < HIST_FROM or day >= today:
                continue
            if time.time() - start > budget_s:
                return
            path = f"server/hist/{series}/{day}.jsonl.gz"
            if gh("GET", f"contents/{path}?ref={BRANCH}")[0] == 200:
                # 6 Nov 2026: the raw books filled the server disk (ENOSPC 19:39 KST, bot dead for hours). A day that is
                # safely on GitHub is dropped locally once it is 3+ days old.
                if day <= time.strftime("%Y-%m-%d", time.gmtime(time.time() - 3 * 86400)):
                    try:
                        os.remove(src)
                        print(f"pruned {src} (on GitHub)")
                    except OSError:
                        pass
                continue
            out, last, key = [], None, None
            with open(src) as f:
                for line in f:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    k = (r.get("window"), r.get("left"))
                    if k != key and last is not None and (step == 1 or (last[2] or 0) % step == 0):
                        out.append(json.dumps(last, separators=(",", ":")))
                    key = k
                    last = [int((r.get("t") or 0) // 1000), r.get("window"), r.get("left"), r.get("upAsk"), r.get("upBid"),
                            r.get("downAsk"), r.get("downBid"), _sz(r.get("upAsks"), 1), _sz(r.get("upBids"), 1),
                            _sz(r.get("downAsks"), 1), _sz(r.get("downBids"), 1), _sz(r.get("upAsks"), 3),
                            _sz(r.get("upBids"), 3), _sz(r.get("downAsks"), 3), _sz(r.get("downBids"), 3),
                            r.get("upAskDepth"), r.get("downAskDepth"), r.get("chainlink"), r.get("binance"),
                            r.get("coinbase"), r.get("futures"), r.get("open")]
            if last is not None and (step == 1 or (last[2] or 0) % step == 0):
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


def upload_prints(today):
    """Trade prints (10 Nov 2026, venue-mechanics research): data/<prefix>prints/<day>.jsonl rows {"p": [t ms, window,
    seconds left, U|D, taker side B|S, price, shares]} go to server/hist/<series>/<day>-prints.jsonl.gz once the day is
    over, and the running day goes to server/hist/<series>/today-prints.jsonl.gz at most once an hour (overwritten).
    Uploaded days are dropped locally after 3 days, like the books."""
    cols = json.dumps(["t", "window", "left", "outcome", "takerSide", "price", "shares"])
    old = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 3 * 86400))
    for d in sorted(glob.glob(os.path.join(DATA, "*prints"))):
        prefix = os.path.basename(d).removesuffix("prints")
        series = prefix.rstrip("-") or "btc5m"
        for src in sorted(glob.glob(os.path.join(d, "*.jsonl"))):
            day = os.path.basename(src)[:-6]
            if day > today:
                continue
            body = {"branch": BRANCH}
            if day == today:
                stamp = os.path.join(d, ".uploaded")
                if os.path.exists(stamp) and time.time() - os.path.getmtime(stamp) < 3300:
                    continue
                path = f"server/hist/{series}/today-prints.jsonl.gz"
                code, cur = gh("GET", f"contents/{path}?ref={BRANCH}")
                if code == 200 and isinstance(cur, dict) and cur.get("sha"):
                    body["sha"] = cur["sha"]
            else:
                path = f"server/hist/{series}/{day}-prints.jsonl.gz"
                if gh("GET", f"contents/{path}?ref={BRANCH}")[0] == 200:
                    if day <= old:
                        try:
                            os.remove(src)
                        except OSError:
                            pass
                    continue
            rows = []
            for line in open(src):
                try:
                    rows.append(json.dumps(json.loads(line).get("p"), separators=(",", ":")))
                except ValueError:
                    continue
            blob = gzip.compress(("\n".join([cols] + rows) + "\n").encode())
            body.update({"message": f"server prints {series} {day}", "content": base64.b64encode(blob).decode()})
            code, _ = gh("PUT", f"contents/{path}", body)
            print(f"prints {series} {day}: {len(rows)} rows, {len(blob) // 1024} KB, GitHub {code}")
            if day == today and code in (200, 201):
                open(os.path.join(d, ".uploaded"), "w").close()


def down_report(err):
    """What we can still see when the bot's status page is down: code version, disk, and the bot's last log lines
    (wallet-like hex strings removed, the repo is public)."""
    def run(cmd):
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout.strip()
        except Exception as e:  # noqa: BLE001
            return f"failed: {e}"
    du = shutil.disk_usage(ROOT)
    log = run(["journalctl", "-u", "predbot", "-n", "60", "--no-pager", "-o", "short-iso"])
    log = re.sub(r"0x[0-9a-fA-F]{16,}", "0x…", log)
    return {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "error": str(err),
            "git": run(["git", "-C", ROOT, "log", "-1", "--format=%h %ci"]),
            "gitStatus": run(["git", "-C", ROOT, "status", "--short", "--untracked-files=no"]),
            "diskFreeGB": round(du.free / 1e9, 2), "diskTotalGB": round(du.total / 1e9, 2),
            "service": run(["systemctl", "is-active", "predbot"]), "journal": log.splitlines()[-60:]}


def post_link(url):
    """28 Nov 2026, enrique: "the link changed again wtf is it now". The quick tunnel's address changes whenever the
    tunnel restarts. Post just the address to server/link.json (tiny) when it changes, so a fixed page (docs/index.html,
    served by GitHub Pages) can always forward to the current one. The dashboard itself stays password protected."""
    if not url:
        return
    code, cur = gh("GET", f"contents/server/link.json?ref={BRANCH}")
    if code == 200 and cur:
        try:
            if json.loads(base64.b64decode(cur.get("content", "")).decode()).get("url") == url:
                return
        except ValueError:
            pass
    print(f"dashboard link now {url}: GitHub {put('server/link.json', {'url': url, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})}")


def main():
    code, _ = gh("GET", "")
    if code != 200:
        sys.exit(f"GitHub said {code} reading the repo: the token is wrong or does not include predbot")
    if gh("GET", f"branches/{BRANCH}")[0] == 404:
        code, main_ref = gh("GET", "git/ref/heads/main")
        code, _ = gh("POST", "git/refs", {"ref": f"refs/heads/{BRANCH}", "sha": main_ref["object"]["sha"]})
        if code != 201:
            sys.exit(f"GitHub said {code} creating the {BRANCH} branch: the token needs Contents: Read and write")
    try:
        status = summary()
    except Exception as e:  # noqa: BLE001 - 6 Nov 2026: the bot's status page went dark for hours and we were blind
        put("server/down.json", down_report(e))
        sys.exit(f"bot status page not answering ({e}); posted server/down.json")
    code = put("server/status.json", status)
    try:
        post_link(status.get("dashboardUrl"))
    except Exception as e:  # noqa: BLE001 - never let the link post break the status report
        print(f"link post failed: {e}")
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
