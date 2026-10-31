#!/usr/bin/env python3
"""Compact health summary of this copy of Pred bot, to compare the server with the Mac.
Usage: python3 deploy/check.py [since ISO time, default 2026-10-30T14:38Z]"""
import glob, json, os, statistics, sys
from datetime import datetime, timezone

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
since = datetime.fromisoformat((sys.argv[1] if len(sys.argv) > 1 else "2026-10-30T14:38:00+00:00").replace("Z", "+00:00"))
ms = since.timestamp() * 1000
days = sorted({d.strftime("%Y-%m-%d") for d in [since, datetime.now(timezone.utc)]})

try:
    lat = json.load(open("latency.json"))
    print(f"latency: n={lat['n']} warm median {lat['warmMedian']} ms, cold median {lat['coldMedian']} ms")
except Exception as e:
    print("latency: none", e)

fires = settled = won = 0
pnl = 0.0
per = {}
for f in glob.glob("*-paper-*/*.jsonl"):
    if not any(f.endswith(d + ".jsonl") for d in days):
        continue
    key = f.split("/")[0]
    for line in open(f):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if (r.get("t") or 0) < ms:
            continue
        fires += 1
        p = per.setdefault(key, [0, 0.0])
        p[0] += 1
        if r.get("won") is not None:
            settled += 1
            won += bool(r["won"])
            pnl += r.get("pnl") or 0
            p[1] += r.get("pnl") or 0
print(f"paper since {since:%m-%d %H:%M}Z: {fires} trades, {settled} settled, {won} won, pnl ${pnl:.2f}, {len(per)} rule/market lines")

