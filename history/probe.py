import json, collections, urllib.request
RPC = "https://polygon.drpc.org"
def call(m, p):
    req = urllib.request.Request(RPC, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": m, "params": p}).encode(), headers={"Content-Type": "application/json", "User-Agent": "x"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read()).get("result")
n = int(call("eth_blockNumber", []), 16)
CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
logs = call("eth_getLogs", [{"address": CTF, "fromBlock": hex(n - 20), "toBlock": hex(n - 1)}]) or []
print("ctf logs", len(logs))
ops = collections.Counter((l["topics"][0][:10], "0x" + l["topics"][1][-40:]) for l in logs if len(l["topics"]) > 1)
for k, v in ops.most_common(15): print(" ", k, v)
txs = list({l["transactionHash"] for l in logs})[:3]
for tx in txs:
    r = call("eth_getTransactionReceipt", [tx])
    print("TX", tx, "to", r.get("to"))
    for l in r["logs"]:
        print("   ", l["address"], l["topics"][0], len(l["topics"]), len(l["data"]))
