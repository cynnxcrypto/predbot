#!/usr/bin/env python3
"""Top-trader research collector (10 Nov 2026). READ-ONLY on Polymarket's public APIs; places no orders and
does not touch the bot, its data or deploy/live-rules.json. Run once on the server (it can reach data-api):

    nohup python3 ~/predbot/research/trader-collector.py > ~/trader-collector.log 2>&1 &

On the server it is started by the bot itself (src/index.ts, once, detached; TRADERS=off disables it), niced, with a
memory ceiling and a lock so a second copy exits at once. The bot always comes first: if this runs out of memory it
dies alone. Pace is about 2 requests a second so the server's address is never rate-limited for the live trader.

It publishes to the server-data branch under server/traders/ as it goes (same token as deploy/report.py):
  progress.json                 what is done so far, errors, API limits met
  leaderboards.json.gz          Polymarket profit leaderboards per category and period
  tape/<group>.json.gz          every fill (both sides, maker/taker flag) of a sample of resolved markets
  tapestats/<group>.json.gz     per-wallet profit over that sample
  wallets/<address>.json.gz     the selected wallets' own trades (30 days) plus redeems, merges, rewards
Stdlib only. Safe to re-run: finished pieces are skipped (state in ~/predbot/data/traders/v2/; marker DONE-v2).
Uses the Data API v2 routes (v1 answers 410 Gone since 2 Nov 2026)."""
import base64, fcntl, gzip, json, os, resource, sys, time, urllib.request, urllib.error, urllib.parse, collections

REPO, BRANCH = "cynnxcrypto/predbot", "server-data"
DATA, GAMMA = "https://data-api.polymarket.com", "https://gamma-api.polymarket.com"
# Our own wallet is left out of the published data. Its address is read from the server's local file and is never
# written into this public repo.
try:
    OWN = str(json.load(open(os.path.expanduser("~/predbot/data/live.json"))).get("funder") or "").strip().lower()
except Exception:
    OWN = ""
OUT = os.path.expanduser("~/predbot/data/traders")
TOKEN = open(os.path.expanduser("~/.predbot-github-token")).read().strip()
NOW = int(time.time())
PROGRESS = {"started": NOW, "steps": [], "errors": [], "limits": {}}
os.makedirs(OUT, exist_ok=True)
try:
    os.nice(15)
    resource.setrlimit(resource.RLIMIT_AS, (900 * 1024 * 1024, 900 * 1024 * 1024))
except Exception:
    pass
_lock = open(os.path.join(OUT, "lock"), "w")
try:
    fcntl.flock(_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    print("another collector is running; exiting")
    sys.exit(0)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def get(url, tries=4):
    """JSON GET; None on failure. Gentle pacing (about 2 requests a second at most)."""
    for i in range(tries):
        time.sleep(0.45)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "PredBotResearch/0.1", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(3 * (i + 1)); continue
            if len(PROGRESS["errors"]) < 60:
                PROGRESS["errors"].append(f"{e.code} {url[:140]}")
            return None
        except Exception as e:
            time.sleep(2 * (i + 1))
    if len(PROGRESS["errors"]) < 60:
        PROGRESS["errors"].append(f"fail {url[:140]}")
    return None


def pages(url, cap=20000):
    """Data API v2 (v1 answers 410 since 2 Nov 2026): rows sit in `data`, paging follows pagination.next_cursor."""
    rows, cur = [], None
    while len(rows) < cap:
        page = get(url + ("&cursor=" + urllib.parse.quote(cur) if cur else ""))
        if not isinstance(page, dict):
            break
        data = page.get("data")
        if not isinstance(data, list) or not data:
            break
        rows += data
        cur = (page.get("pagination") or {}).get("next_cursor")
        if not cur:
            break
    return rows


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
    """Saves locally and puts the file on the server-data branch (retries once on a sha race)."""
    blob = json.dumps(obj, separators=(",", ":")).encode()
    if gz:
        blob = gzip.compress(blob, 6)
    local = os.path.join(OUT, "v2", name)
    os.makedirs(os.path.dirname(local), exist_ok=True)
    open(local, "wb").write(blob)
    path = f"server/traders/{name}"
    for _ in range(3):
        code, cur = gh("GET", f"contents/{path}?ref={BRANCH}")
        body = {"message": f"traders {name}", "branch": BRANCH, "content": base64.b64encode(blob).decode()}
        if code == 200 and cur:
            body["sha"] = cur["sha"]
        code, _ = gh("PUT", f"contents/{path}", body)
        if code in (200, 201):
            log(f"published {name} {len(blob) // 1024} KB")
            return True
        time.sleep(5)
    log(f"PUBLISH FAILED {name} GitHub {code}")
    PROGRESS["errors"].append(f"publish {name} {code}")
    return False


def step(msg):
    PROGRESS["steps"].append([int(time.time()) - NOW, msg])
    PROGRESS["updated"] = int(time.time())
    publish("progress.json", PROGRESS, gz=False)


def done(name):
    return os.path.exists(os.path.join(OUT, "v2", name))


# ---------- 1. leaderboards ----------
def leaderboards():
    if done("leaderboards.json.gz"):
        return json.loads(gzip.decompress(open(os.path.join(OUT, "v2", "leaderboards.json.gz"), "rb").read()))
    out = {}
    for cat in ["OVERALL", "CRYPTO", "SPORTS", "ESPORTS", "WEATHER", "POLITICS", "ECONOMICS", "ECONOMY", "FINANCE", "TECH", "CULTURE", "MENTIONS"]:
        for per in ["WEEK", "MONTH", "ALL"]:
            rows = pages(f"{DATA}/v2/leaderboard?category={cat.lower()}&time_period={per.lower()}&sort_by=PNL&limit=100", cap=100)
            out[f"{cat}/{per}"] = [[r.get("rank"), (r.get("user_id") or "").lower(), r.get("user_name"), round(float(r.get("volume") or 0)), round(float(r.get("pnl") or 0))] for r in rows]
            log("leaderboard", cat, per, len(rows))
    publish("leaderboards.json.gz", out)
    return out


# ---------- 2. market tape ----------
def market_trades(cid, taker_only):
    """All fills of one market (up to 20,000), newest first."""
    return pages(f"{DATA}/v2/trades?condition={cid}&limit=1000&taker_only={'true' if taker_only else 'false'}")


def tkey(t):
    return (t.get("transaction_hash"), t.get("token_id"), t.get("proxy_wallet"), str(t.get("size")), str(t.get("price")))


def tape_group(name, markets):
    """markets: [{slug, cid, title, start, end, outcomes, prices, vol}]. Writes tape/<name> and tapestats/<name>."""
    if done(f"tapestats/{name}.json.gz"):
        return json.loads(gzip.decompress(open(os.path.join(OUT, "v2", f"tapestats/{name}.json.gz"), "rb").read()))
    widx, wallets, names, trades, mk = {}, [], {}, [], []
    stat = collections.defaultdict(lambda: {"m": set(), "n": 0, "nt": 0, "buy": 0.0, "sell": 0.0, "pay": 0.0, "wonm": 0, "pnl_m": collections.defaultdict(float)})
    for mi, m in enumerate(markets):
        allr = market_trades(m["cid"], False)
        tk = set(tkey(t) for t in market_trades(m["cid"], True)) if allr else set()
        mk.append({**m, "fills": len(allr), "takerFills": len(tk)})
        pos = collections.defaultdict(lambda: [0.0, 0.0])  # wallet -> shares per outcome
        for t in allr:
            w = (t.get("proxy_wallet") or "").lower()
            if not w or (OWN and w == OWN):
                continue
            if w not in widx:
                widx[w] = len(wallets); wallets.append(w)
                if t.get("name"): names[w] = t.get("name")
            oi = int(t.get("outcome_index") or 0)
            p, s, buy = float(t.get("price") or 0), float(t.get("size") or 0), t.get("side") == "BUY"
            tak = 1 if tkey(t) in tk else 0
            ts = int(float(t.get("timestamp") or 0)); ts = ts // 1000 if ts > 1e12 else ts
            trades.append([mi, ts, widx[w], 1 if buy else -1, oi, round(p, 4), round(s, 2), tak])
            st = stat[w]; st["m"].add(mi); st["n"] += 1; st["nt"] += tak
            if buy:
                st["buy"] += p * s; pos[w][min(oi, 1)] += s; st["pnl_m"][mi] -= p * s
            else:
                st["sell"] += p * s; pos[w][min(oi, 1)] -= s; st["pnl_m"][mi] += p * s
        pr = m.get("prices") or []
        if len(pr) >= 2:
            for w, sh in pos.items():
                pay = sh[0] * pr[0] + sh[1] * pr[1]
                stat[w]["pay"] += pay; stat[w]["pnl_m"][mi] += pay
        if mi % 25 == 0:
            log(f"tape {name}: {mi + 1}/{len(markets)} markets, {len(trades)} fills")
    # split big tapes so each file stays small
    CH = 400000
    for k in range(0, max(len(trades), 1), CH):
        publish(f"tape/{name}{'' if len(trades) <= CH else '-' + str(k // CH)}.json.gz",
                {"cols": ["market", "ts", "wallet", "side", "outcomeIndex", "price", "size", "taker"], "markets": mk, "wallets": wallets, "trades": trades[k:k + CH]})
    rows = []
    for w, st in stat.items():
        pm = list(st["pnl_m"].values())
        pnl = st["sell"] + st["pay"] - st["buy"]
        rows.append([w, names.get(w), len(st["m"]), st["n"], st["nt"], round(st["buy"]), round(st["sell"]), round(pnl, 1), sum(1 for x in pm if x > 0), round(max(pm), 1) if pm else 0])
    rows.sort(key=lambda r: -r[7])
    res = {"cols": ["wallet", "name", "markets", "fills", "takerFills", "bought", "sold", "pnl", "marketsWon", "bestMarket"], "markets": len(markets),
           "top": rows[:300], "bottom": rows[-100:], "wallets": len(rows)}
    publish(f"tapestats/{name}.json.gz", res)
    return res


def jl(s):
    try:
        return json.loads(s) if isinstance(s, str) else (s or [])
    except Exception:
        return []


def mrow(ev, m):
    pr = [float(x) for x in jl(m.get("outcomePrices"))] if m.get("outcomePrices") else []
    return {"slug": m.get("slug"), "event": ev.get("slug"), "cid": m.get("conditionId"), "title": (m.get("question") or ev.get("title") or "")[:120],
            "start": m.get("gameStartTime") or m.get("eventStartTime") or ev.get("startTime") or ev.get("startDate"), "end": m.get("endDate"), "closedTime": m.get("closedTime"),
            "outcomes": jl(m.get("outcomes")), "prices": pr, "vol": round(float(m.get("volumeNum") or m.get("volume") or 0)), "type": m.get("sportsMarketType")}


def crypto_markets(slug, win, hours):
    out, t0 = [], (NOW // win) * win - win * 2
    for k in range(int(hours * 3600 / win)):
        start = t0 - k * win
        ev = get(f"{GAMMA}/events?slug={slug}-{start}")
        if not ev or not ev[0].get("markets"):
            continue
        r = mrow(ev[0], ev[0]["markets"][0]); r["start"] = start; r["end"] = start + win
        if r["cid"] and len(r["prices"]) >= 2 and set(r["prices"]) == {0.0, 1.0}:
            out.append(r)
    return out


def tag_markets(tag, days_back, top, min_vol, per_event=2):
    """Resolved markets of a tag that ended recently (sports end dates sit up to a week after the match)."""
    lo = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(NOW - days_back * 86400))
    hi = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(NOW + 8 * 86400))
    evs, off = [], 0
    # Biggest events first: the default order starts with the oldest and the API refuses deep offsets (422), which
    # left the first tennis pull with 4 markets.
    while off < 1500:
        page = get(f"{GAMMA}/events?tag_slug={tag}&closed=true&end_date_min={lo}&end_date_max={hi}&limit=100&offset={off}&order=volume&ascending=false")
        if not isinstance(page, list) or not page:
            break
        evs += page; off += 100
        if len(page) < 100:
            break
    out = []
    for ev in evs:
        ms = [mrow(ev, m) for m in ev.get("markets") or [] if m.get("conditionId")]
        ms = [m for m in ms if m["vol"] >= min_vol and len(m["prices"]) >= 2 and max(m["prices"]) >= 0.5 and str(m.get("closedTime") or "9")[:19].replace(" ", "T") >= lo[:19]]
        if any(m.get("type") == "moneyline" for m in ms):
            ms = [m for m in ms if m.get("type") == "moneyline"]
        ms.sort(key=lambda m: -m["vol"])
        out += ms[:per_event]
    out.sort(key=lambda m: -m["vol"])
    log(f"tag {tag}: {len(evs)} closed events, {len(out)} markets kept, taking {min(top, len(out))}")
    return out[:top]


# ---------- 3. wallets ----------
def wallet_pull(w, why):
    name = f"wallets/{w}.json.gz"
    if done(name):
        return
    since = NOW - 30 * 86400
    # a) every activity row of the last 30 days (trades, redeems, merges, splits, rewards, rebates), newest first
    acts = pages(f"{DATA}/v2/activity?user={w}&limit=1000&start={since}", cap=40000)
    # b) taker-only trades, to mark which fills crossed the spread
    tk_rows = pages(f"{DATA}/v2/trades?user={w}&limit=1000&taker_only=true&start={since}", cap=40000)
    tk = set((t.get("transaction_hash"), t.get("token_id"), str(t.get("size")), str(t.get("price"))) for t in tk_rows)
    deepest = min((int(float(t.get("timestamp") or 0)) for t in tk_rows), default=None)
    trades, other = [], []
    for a in acts:
        ts = int(float(a.get("timestamp") or 0))
        if a.get("type") == "TRADE":
            tak = 1 if (a.get("transaction_hash"), a.get("token_id"), str(a.get("size")), str(a.get("price"))) in tk else 0
            trades.append([ts, 1 if a.get("side") == "BUY" else -1, int(a.get("outcome_index") or 0), round(float(a.get("price") or 0), 4), round(float(a.get("size") or 0), 2),
                           round(float(a.get("usdc_size") or 0), 2), a.get("slug"), a.get("event_slug"), a.get("outcome"), tak, (a.get("condition_id") or "")[:12]])
        else:
            other.append([ts, a.get("type"), round(float(a.get("usdc_size") or 0), 2), round(float(a.get("size") or 0), 2), a.get("slug")])
    pos = pages(f"{DATA}/v2/positions?user={w}&limit=200", cap=200)
    val = get(f"{DATA}/v2/value?user={w}")
    stats = get(f"{DATA}/v2/user-stats?user={w}")
    pnl = get(f"{DATA}/v2/user-pnl?user={w}&interval=1m&fidelity=1d")
    publish(name, {"wallet": w, "why": why, "name": next((a.get("name") for a in acts if a.get("name")), None), "pulled": NOW,
                   "tradeCols": ["ts", "side", "outcomeIndex", "price", "size", "usdc", "slug", "eventSlug", "outcome", "taker", "cid"], "trades": trades,
                   "otherCols": ["ts", "type", "usdc", "size", "slug"], "other": other,
                   "oldestActivity": min((int(float(a.get("timestamp") or 0)) for a in acts), default=None), "takerMarkedBackTo": deepest, "takerRows": len(tk),
                   "openPositions": [[p.get("slug"), p.get("outcome"), p.get("size"), p.get("avg_price"), p.get("current_value")] for p in pos if isinstance(p, dict)][:200],
                   "value": val, "stats": stats, "pnl30d": pnl})


def pick(stats, n, min_markets):
    return [r[0] for r in stats["top"] if r[2] >= min_markets][:n]


def main():
    lb = leaderboards(); step("leaderboards")
    chosen = collections.OrderedDict()

    def add(ws, why):
        for w in ws:
            if w and w != OWN:
                chosen.setdefault(w, []).append(why)

    def pull_all(tag):
        for i, (w, why) in enumerate(list(chosen.items())):
            if not done(f"wallets/{w}.json.gz"):
                wallet_pull(w, why); log(f"wallet {i + 1}/{len(chosen)} {w} {why}")
        step(f"wallets after {tag}: {len(chosen)}")

    # crypto first
    add([r[1] for r in lb.get("CRYPTO/MONTH", [])[:25]] + [r[1] for r in lb.get("CRYPTO/WEEK", [])[:15]], "lb-crypto")
    groups = [("crypto-15m-big3", [("btc-updown-15m", 900, 24), ("eth-updown-15m", 900, 24), ("sol-updown-15m", 900, 24)], 15, 25),
              ("crypto-5m-btc", [("btc-updown-5m", 300, 12)], 10, 25)]
    for name, series, n, mm in groups:
        if not done(f"tapestats/{name}.json.gz"):
            ms = [m for s, w, h in series for m in crypto_markets(s, w, h)]
        else:
            ms = []
        st = tape_group(name, ms); add(pick(st, n, mm), f"tape-{name}"); step(f"tape {name}")
    pull_all("crypto")

    # event categories, tennis first
    add([r[1] for r in lb.get("SPORTS/MONTH", [])[:25]] + [r[1] for r in lb.get("SPORTS/WEEK", [])[:10]], "lb-sports")
    tags = [("tennis", 12, 150, 5000), ("nba", 12, 80, 20000), ("nfl", 16, 50, 20000), ("soccer", 12, 120, 20000), ("esports", 12, 100, 5000),
            ("cricket", 14, 60, 3000), ("highest-temperature", 6, 150, 2000), ("cbb", 12, 50, 10000), ("nhl", 12, 50, 10000), ("mlb", 20, 40, 10000),
            ("up-or-down", 3, 120, 20000), ("crypto-prices", 6, 80, 10000), ("stocks", 8, 60, 5000), ("commodities", 8, 40, 3000), ("economy", 30, 40, 10000), ("politics", 30, 60, 50000)]
    for tag, days, top, mv in tags:
        try:
            grp = tag + "-m"  # "-m": second pull, biggest events first (the first tennis file had 4 markets)
            ms = [] if done(f"tapestats/{grp}.json.gz") else tag_markets(tag, days, top, mv)
            if not ms and not done(f"tapestats/{grp}.json.gz"):
                step(f"tag {tag}: no markets"); continue
            st = tape_group(grp, ms); add(pick(st, 10, 8), f"tape-{tag}"); step(f"tape {grp}: {len(ms)} markets")
            if tag in ("tennis", "soccer", "highest-temperature"):
                pull_all(tag)
        except Exception as e:
            PROGRESS["errors"].append(f"tag {tag}: {e!r}"[:200]); step(f"tag {tag} failed")
    for cat in ["WEATHER", "POLITICS", "ECONOMICS", "FINANCE", "TECH", "CULTURE", "OVERALL"]:
        add([r[1] for r in lb.get(f"{cat}/MONTH", [])[:12]], f"lb-{cat.lower()}")
    pull_all("all")
    step("DONE")
    open(os.path.join(OUT, "DONE-v2"), "w").write(str(int(time.time())))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        PROGRESS["errors"].append(f"fatal {e!r}"[:300]); step("FATAL"); raise
