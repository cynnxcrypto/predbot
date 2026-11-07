# data/history: non-crypto Polymarket backtest data

Research data for backtests. Written by `history/collect.py` (branch `main`), run by the GitHub Action
`.github/workflows/history.yml` every 6 hours (00:23, 06:23, 12:23, 18:23 UTC). It never touches the trading bot,
`deploy/live-rules.json` or the server. No secrets are stored here (public repo).

Read any file with pandas: `pd.read_csv(path)` (gzip is detected) or `pd.read_parquet(path)`.
`COVERAGE.md` / `coverage.json` hold the current counts per family. `last-run.log` is the latest run's log.

## Layout

```
pm/<family>/<YYYY>/<YYYY-MM-DD>.events.csv.gz     one row per event whose endDate is that UTC day (teams, score, series)
pm/<family>/<YYYY>/<YYYY-MM-DD>.markets.csv.gz    resolved markets of those events (join on event_id)
pm/<family>/<YYYY>/<YYYY-MM-DD>.prices.parquet    price path of outcome 0 (token_ids[0])
pm/<family>/<YYYY>/<YYYY-MM-DD>.prices1m.parquet  1-minute path, game start -2 h .. +4 h (main game markets)
books/<YYYY-MM-DD>/<HHMM>.json.gz                 live order-book snapshots, from 7 Nov 2026 on (below)
results/...                                       independent outcome sources (below)
state.json                                        days done (a day is pulled at D+2, re-pulled once at D+8)
```

### Families (from Gamma event tags)
| family | what | sub column |
|---|---|---|
| `football` | soccer games: moneyline (one Yes/No market per side + draw), totals, spreads, exact score, halftime, corners… | series slug, e.g. `la-liga-2025`, `premier-league-2025` |
| `us_sports` | NBA / NFL / NHL / MLB / college games: moneyline, spreads, totals, props | league |
| `esports` | CS2 / LoL / Dota 2 / Valorant matches and per-map markets | `cs2`, `lol`, `dota2`, `valorant` |
| `tennis` | ATP / WTA / challenger matches (match + set markets) | `atp`, `wta`, … |
| `other_sports` | cricket, UFC, F1 and other single games | series slug |
| `sports_futures` | season/tournament winners, awards, transfers | series slug |
| `temperature` | daily highest temperature by city (bracket markets, one per bracket) | series, e.g. `nyc-daily-weather` |
| `weather_other` | monthly precipitation, global temperature index, etc. | series |
| `finance_daily` | SPX / SPY / NDX / RUT / stocks / gold / WTI / NG up-or-down, opens up/down, closes-above brackets, gold 15m | series |
| `politics` | politics / elections / geopolitics | series or tag |
| `other` | everything else non-crypto (earnings beats, central banks, culture…) | tags |

Crypto markets are excluded (the bot already records those).

### events.csv.gz columns
`day` (UTC date of event endDate), `family`, `sub`, `series`, `event_id`, `event_slug`, `event_title`, `tags` (`|`-joined), `teams`,
`event_start`, `event_end`, `event_score` (final score as Polymarket's sports feed shows it), `event_period`, `game_id`, `event_volume`,
`open_interest`, `neg_risk`, `n_markets`, `resolution_source`, `description` (first 600 chars; blank for games).

### markets.csv.gz columns
`day`, `family`, `event_id`, `market_id`, `condition_id`, `question`, `group_item` (bracket label / team), `smt` (sportsMarketType:
`moneyline`, `totals`, `spreads`, `soccer_exact_score`, …), `line`, `game_start` (UTC kickoff/tip-off), `outcomes` (JSON),
`token_ids` (JSON, same order), `final_prices` (JSON; 1/0 after resolution), `winner_idx` (index of the winning outcome; blank if not
resolved at pull time), `uma_status`, `last_trade`, `best_bid`, `best_ask` (at close; mostly meaningless after resolution), `volume`,
`volume_clob`, `liquidity`, `created_at`, `start_date`, `end_date`, `closed_time`, `neg_risk`, `fees_enabled`, `fee_rate`, `fee_exp`
(taker fee per share = rate × (p(1−p))^exp), `tick`, `station` (ICAO station for temperature markets), `description` (only when it
differs from the event's).
Game families keep main lines (moneyline / totals / spreads) plus any market with $500+ volume; near-empty props (most exact-score and
corner lines) are counted in `coverage.json` as `dropped_props` but not stored.

### prices*.parquet
`market_id` (int64), `t` (unix seconds UTC), `p` (float32, price of outcome 0; outcome 1 = 1 − p for binary markets).
Source: CLOB `prices-history`. These are Polymarket's sampled prices (midpoint / last trade), **not** order-book asks:
add slippage. `prices`: 10-minute points in the last 48 h before the end, hourly from 48 h to 14 days out, 6-hourly before that.
Price files: game main lines (moneyline, totals, spreads, halftime, BTTS) with $1k+ volume, game props with $10k+, other families $200+. Props keep `token_ids` only at $10k+ and no `condition_id` (size).
`prices1m`: 1-minute points from game start −2 h to +4 h for moneylines with $5k+ volume and totals/spreads with $25k+ volume.

### books/ (order-book snapshots, forward only)
Every ~10 minutes (GitHub cron; runs can slip 5-15 min): `{"t": unix, "markets": [{series, family, event_slug, game_start, market_id,
smt, question, group_item, token_ids, outcomes, books: [{bids: [[price, size], …], asks: [[price, size], …], ts}, …]}]}`, top 5 levels
per token. Covers (a) every game moneyline (plus totals/spreads with $1k+ volume) starting within the next 95 minutes, all sports and
esports, plus esports markets in play (up to 5 h after start),
(b) every open daily-temperature bucket (YES token only) resolving within 36 h, every ~30 min, and (c) the daily index/commodity series (SPX, SPY close, NDX, Dow, Russell, WTI, NG, gold, SPY open) on weekdays 13-21 UTC.
Use it to check whether a backtested price was really on offer.

## Independent results (`results/`)
| file | source | use |
|---|---|---|
| `football/fdco/<season>/<league>.csv.gz` | football-data.co.uk (E0 E1 E2 SC0 SP1 SP2 D1 D2 I1 I2 F1 F2 N1 P1 T1 B1 G1; seasons 2024-25..2026-27) | scores (FTHG/FTAG/FTR) + bookmaker odds incl. Pinnacle closing (PSC*) and market averages (AvgC*) |
| `football/fdco/extra/<country>.csv.gz` | football-data.co.uk extra leagues (ARG BRA MEX USA JPN …) | same, fewer columns |
| `us_sports/nfl_games.csv.gz` | nflverse (2024+) | scores, closing moneyline / spread / total |
| `us_sports/nhl_games.csv.gz` | NHL api-web (2025-01-01+) | final scores, OT/SO |
| `us_sports/mlb_games.csv.gz` | MLB statsapi (2025-26) | final scores |
| `finance/daily_ohlc_yahoo.csv.gz` | Yahoo chart API, 3 years daily OHLC | SPX, SPY, NDX, QQQ, RUT, DJI, VIX, gold, silver, WTI, Brent, NG, copper, megacap stocks, FX, Asian/EU indices |
| `finance/fred_*.csv.gz` | FRED | official closes (SP500, WTI, Brent, Henry Hub, Nasdaq, DJIA, VIX) |
| `temperature/metar_<ICAO>.parquet` | Iowa Environmental Mesonet ASOS/METAR archive | every temperature report (`valid_utc`, `tmpf` °F) for each station a temperature market resolves on |
| `temperature/stations.json` | derived | station → [first day, last day, series] |
| `temperature/hko_daily_max.csv.gz` | Hong Kong Observatory | official daily max (Hong Kong markets) |

Daily max temperature: convert `valid_utc` to the city's local time, take the max per local date, and compare with the bracket
(Polymarket reads Weather Underground / METAR whole degrees).

## Known gaps
- NBA and esports have no independent results feed (NBA CDN/stats and ESPN block GitHub runners; Liquipedia/HLTV/LoL Esports block or
  rate-limit). Use `winner_idx` + `event_score`. Dota 2 results could be added from OpenDota if needed.
- Politics: Polymarket resolution only.
- Markets that resolve more than 8 days after their end date (some politics) show a blank `winner_idx`.
- No historical trade fills. `data-api.polymarket.com/trades` is retired (HTTP 410), the Goldsky subgraph rate-limits GitHub runners
  (429), and Polymarket's new exchange (0xe111…996b) emits ~140k fill logs per hour with the token id unindexed, so pulling fills per
  match from a public RPC is not practical. Historical prices are sampled mids/last trades; fillability is checked going forward with
  `books/`.
- History starts 2025-01-01 (daily temperature markets start 2025-12-30; `finance-updown` tag March 2026).
