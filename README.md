# Pred bot

Version 2 of the 5-minute BTC prediction-market bot. The first version (Afterclose) lost 163 of its bets at a 38% hit rate because it paid the market's price for information the market already had. This one starts by **recording**, not trading.

## What runs today

`npm start` runs the recorder. Every second it saves the Polymarket order book for the current 5-minute BTC window (both sides, ten levels deep), the latest Chainlink, Binance and Coinbase BTC prints, and, when each window settles, Polymarket's official open, close and result. Nothing trades. A status page opens at http://127.0.0.1:8790.

Data goes in `data/` next to the app as plain JSON lines (`data/book/<day>.jsonl`, `data/windows/<day>.jsonl`). Git ignores that folder, so updates never touch it.

`npm run report` prints what the data says so far:
1. which settlement rule actually matches Polymarket's results (must be ~100% before any model is trusted),
2. how close windows finish to the open,
3. what the book charged for the eventual winner at each checkpoint, and how often the price favourite won.

The market settles on the 60-second average of the Chainlink feed ending at close, compared with the 60-second average ending at open (the minute before the window). Found from the data on 16 Oct 2026: 401 of 402 windows.

`npm run paper -- --left 30 --cap 0.9 --size 20` replays the recorded book with the projection rule (at 30s left, half of the closing average is already known; buy the side the projection favours if its ask is at or under 90c, up to $20 taken from the levels on the book, fees included). It prints trades, win rate, net result by day and the worst trades. It reads `data/` only and sends nothing anywhere.

The recorder also paper-trades that rule live (no order is ever sent): from 30s before close it buys the projected side on paper if its ask is at or under 90c, $20 per window, filled from the levels on the book. Five variants run side by side: `base` (30s, 90c), `early45` (45s), `late20` (20s), `late15` (15s) `cheap70` (30s, ask at or under 70c), and `band80` / `band80-30` (45s / 30s, only when the ask is between 80c and 90c, i.e. when the book already leans the same way; cheaper asks turned out to be the book disagreeing, and the book was usually right). Settled paper trades go to `data/paper/<day>.jsonl` for the base variant and `data/paper-<name>/<day>.jsonl` for the others; the status page shows each variant's count, win rate and net. `PAPER_LEFT`, `PAPER_CAP`, `PAPER_SIZE` in the environment tune the base variant.

`npm run probe` checks every feed and endpoint once. Run it first on a new computer.

## Updates are automatic

`npm start` runs a supervisor. Every few minutes it checks the GitHub repo. When there is a new commit it pulls it, reinstalls dependencies if they changed, type-checks, and restarts the bot at the next window edge. If the new code dies within a minute it rolls back to the previous commit. Hand-edited files pause updates until they are committed or discarded.

On the Mac, double-click `Start Pred bot.command`. It needs Node 22+ and git.

## Next steps (in order)

1. Record for one to two weeks.
2. Confirm the settlement rule from the data.
3. Build fair value from the recorded windows and measure where the book is wrong after costs.
4. Only if an edge survives costs: one strategy, one bet per window, maker orders where possible, on Polymarket's book directly from the Polygon wallet.

## Real orders (off by default)

`src/live.ts` can mirror one paper variant with real fill-or-kill buys on Polymarket. It does nothing unless `data/live.json` exists:

```json
{ "mode": "dry", "variant": "band80-30", "size": 5, "maxLossPerDay": 25, "funder": "0x<polymarket deposit wallet>" }
```

`mode` is `off`, `dry` (sign the order, send nothing, log what would be sent) or `live`. The file is re-read before every order, so setting `mode` to `off` is the kill switch. Orders are signed with the key in `data/polygon-keys.json` (`{ "wallet": "<private key>", "address": "0x..." }`, the same file Afterclose used); the `funder` is the Polymarket deposit wallet that holds the USDC. Neither file is in git. The order pays at most the variant's cap (the seen ask plus 2c, capped at 90c for band80-30); after `maxLossPerDay` of realised loss in a UTC day no more orders go out until the next day. Real trades are written to `data/live/<day>.jsonl` and shown on the status page.

