import json, time, urllib.request
def post(url, body):
    try:
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "User-Agent": "predbot-history/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r: return r.read()[:600]
    except Exception as e: return f"ERR {e}"
EX = ["0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E", "0xC5d563A36AE78145C45a50134d48A1215220f80a"]
TOPIC = "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6"
for rpc in ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org", "https://polygon-rpc.com", "https://1rpc.io/matic", "https://polygon.llamarpc.com"]:
    bn = post(rpc, {"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []})
    print(rpc, bn)
    try: n = int(json.loads(bn)["result"], 16)
    except Exception: continue
    t = time.time(); r = post(rpc, {"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs", "params": [{"address": EX, "fromBlock": hex(n - 30), "toBlock": hex(n - 1)}]})
    print(" logs30", round(time.time() - t, 1), "s", r[:300])
    t = time.time()
    try:
        req = urllib.request.Request(rpc, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs", "params": [{"address": EX, "fromBlock": hex(n - 30), "toBlock": hex(n - 1)}]}).encode(), headers={"Content-Type": "application/json", "User-Agent": "x"})
        d = json.loads(urllib.request.urlopen(req, timeout=60).read()); res = d.get("result") or []
        print(" n logs", len(res), "topics0", {x["topics"][0] for x in res} if res else d)
    except Exception as e: print(" err", e)
for i in range(3):
    print("goldsky", post("https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn", {"query": "{ orderFilledEvents(first: 2) { timestamp } }"})[:200]); time.sleep(20)
print("gamma offset", )
import urllib.parse
for off in (900, 1000, 1500, 2000, 3000):
    try:
        u = "https://gamma-api.polymarket.com/events?" + urllib.parse.urlencode({"tag_slug": "games", "closed": "true", "end_date_min": "2026-10-31T00:00:00Z", "end_date_max": "2026-11-01T00:00:00Z", "limit": 100, "offset": off})
        b = json.loads(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "x"}), timeout=30).read()); print(off, len(b))
    except Exception as e: print(off, e)
