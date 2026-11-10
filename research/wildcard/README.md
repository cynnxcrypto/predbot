# Wildcard search scripts (11 Nov 2026)

Report: project library `reviews/wildcard-ideas-2026-11-11.md`. Research only; nothing here touches the bot.

Inputs: `server-data` branch checked out at `/home/claude/sd` (data/history, server/hist) and the weather research
data from branch `claude/project-thread-ugx9bn` (`weather/out`). Paths are hard-coded scratch paths.

- `wx_rows.py` builds the per-event weather table (highest + lowest). `w1` ruled-out buckets, `w2` lowest leader on mids,
  `w4` price-change test (mids, artefact), `w3`/`w5`/`w6`/`w7` real books joined to station readings.
- `g2`/`g3` pre-game move follow/fade on 1-minute history, `g4` same on real books.
- `f1` long-dated YES/NO calibration by days to end.
- `c1`/`c2` crypto 15m feature table and walk-forward combined-signal model vs asks.
