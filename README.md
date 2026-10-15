# Pred bot

Version 2 of the 5-minute BTC prediction-market bot. The first version (Afterclose) lost 163 of its bets at a 38% hit rate because it paid the market's price for information the market already had. This one starts by **recording**, not trading.

## What runs today

`npm start` runs the recorder. Every second it saves the Polymarket order book for the current 5-minute BTC window (both sides, ten levels deep), the latest Chainlink, Binance and Coinbase BTC prints, and, when each window settles, Polymarket's official open, close and result. Nothing trades. A status page opens at http://127.0.0.1:8790.

Data goes in `data/` next to the app as plain JSON lines (`data/book/<day>.jsonl`, `data/windows/<day>.jsonl`). Git ignores that folder, so updates never touch it.

`npm run report` prints what the data says so far:
1. which settlement rule actually matches Polymarket's results (must be ~100% before any model is trusted),
2. how close windows finish to the open,
3. what the book charged for the eventual winner at each checkpoint, and how often the price favourite won.

`npm run probe` checks every feed and endpoint once. Run it first on a new computer.

## JEV shadow test (optional)

If a TypeSafe API key is present, the recorder also asks JEV "Up or Down?" at 180, 120, 90, 60, 30 and 10 seconds left in every window and saves each answer, with the asks at that moment, in `data/jev/<day>.jsonl`. Nothing trades on it. `npm run report` then shows how often JEV was right next to how often the price favourite was, and the profit per share of buying JEV's side at the ask after Polymarket's fee.

To turn it on, create a file named `.env` in the app folder (git ignores it, so the key never reaches GitHub) with one line:

```
TYPESAFE_API_KEY=your-key-here
```

The bot picks it up at its next restart. `JEV_MODEL` in the same file pins a model (default `jev-latest`; the report splits results by the model that answered). Without a key, or when a call fails or takes over 3 seconds, recording carries on unchanged. The status page shows how many picks were answered.

## Updates are automatic

`npm start` runs a supervisor. Every few minutes it checks the GitHub repo. When there is a new commit it pulls it, reinstalls dependencies if they changed, type-checks, and restarts the bot at the next window edge. If the new code dies within a minute it rolls back to the previous commit. Hand-edited files pause updates until they are committed or discarded.

On the Mac, double-click `Start Pred bot.command`. It needs Node 22+ and git.

## Next steps (in order)

1. Record for one to two weeks.
2. Confirm the settlement rule from the data.
3. Build fair value from the recorded windows and measure where the book is wrong after costs.
4. Only if an edge survives costs: one strategy, one bet per window, maker orders where possible, on Polymarket's book directly from the Polygon wallet.
