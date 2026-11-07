import json, urllib.request
RPC = "https://polygon.drpc.org"
def call(m, p):
    req = urllib.request.Request(RPC, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": m, "params": p}).encode(), headers={"Content-Type": "application/json", "User-Agent": "x"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read()).get("result")
n = int(call("eth_blockNumber", []), 16)
EX = "0xe111180000d2663c0091e4f400237545b87b996b"
logs = call("eth_getLogs", [{"address": EX, "fromBlock": hex(n - 100), "toBlock": hex(n - 1)}]) or []
import collections
print("ex logs in 100 blocks", len(logs), collections.Counter(l["topics"][0][:10] for l in logs))
shown = collections.Counter()
for l in logs:
    t0 = l["topics"][0]
    if shown[t0] >= 3: continue
    shown[t0] += 1
    d = l["data"][2:]
    words = [d[i:i+64] for i in range(0, len(d), 64)]
    print("EV", t0, "tx", l["transactionHash"][:12], "blk", int(l["blockNumber"], 16))
    for t in l["topics"][1:]: print("   topic", t)
    for w in words: print("   word", w, int(w, 16) if len(w) == 64 else "")
# old exchanges still active?
for old in ["0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e", "0xc5d563a36ae78145c45a50134d48a1215220f80a"]:
    ls = call("eth_getLogs", [{"address": old, "fromBlock": hex(n - 100), "toBlock": hex(n - 1)}]) or []
    print("old", old, len(ls))
# find when the new exchange started: binary search on first log
blk = call("eth_getBlockByNumber", [hex(n), False]); print("now ts", int(blk["timestamp"], 16))
code = call("eth_getCode", [EX, "latest"]); print("code len", len(code))
