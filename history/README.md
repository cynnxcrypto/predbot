# data/history: non-crypto Polymarket backtest data

Research data for backtests. Written by `history/collect.py` (branch `main`), run by the GitHub Action
`.github/workflows/history.yml` every 6 hours (00:23, 06:23, 12:23, 18:23 UTC). It never touches the trading bot,
`deploy/live-rules.json` or the server. No secrets are stored here (public repo).

Read any file with pandas: `pd.read_csv(path)` (gzip is detected) or `pd.read_parquet(path)`.
`COVERAGE.md` / `coverage.json` hold the current counts per family. `last-run.log` is the latest run's log.

## Layout

```
pm/<family>/<YYYY>/<YYYY-MM-DD>.markets.csv.gz    every resolved market of events whose endDate is that UTC day
pm/<family>/<YYYY>/<YYYY-MM-DD>.prices.parquet    price path of outcome 0 (token_ids[0])
pm/<family>/<YYYY>/<YYYY-MM-DD>.prices1m.parquet  1-minute path, game start -3 h .. +3 h (main game markets)
pm/<family>/<YYYY>/<YYYY-MM-DD>.fills.parquet     real on-chain fills, last 60 min before game start (moneylines)
results/...                                       independent outcome sources (below)
state.json                                        days done (a day is pulled at D+2, re-pulled once at D+8)
```

### Families (from Gamma event tags)
| family | what | sub column |
|---|---|---|
| `football` | soccer games: moneyline (one Yes/No market per side + draw), totals, spreads, exact score, halftime, corners… | series slug, e.g. `la-liga-2025`, `premier-league-2025` |
| `us_sports` | NBA / NFL / NHL / MLB / college games: moneyline, spreads, totals, props | league |
| `esports` | CS2 / LoL / Dota 2 / Valorant matches and per-map markets | `cs2`, `lol`, `dota2`, `valorant` |
| `other_sports` | tennis, cricket, UFC, F1 and other single games | series slug |
| `sports_futures` | season/tournament winners, awards, transfers | series slug |
| `temperature` | daily highest temperature by city (bracket markets, one per bracket) | series, e.g. `nyc-daily-weather` |
| `weather_other` | monthly precipitation, global temperature index, etc. | series |
| `finance_daily` | SPX / SPY / NDX / RUT / stocks / gold / WTI / NG up-or-down, opens up/down, closes-above brackets, gold 15m | series |
| `politics` | politics / elections / geopolitics | series or tag |
| `other` | everything else non-crypto (earnings beats, central banks, culture…) | tags |

Crypto markets are excluded (the bot already records those).

### markets.csv.gz columns
`day` (UTC date of event endDate), `family`, `sub`, `series`, `event_id`, `event_slug`, `event_title`, `tags` (`|`-joined),
`teams`, `event_start`, `game_start` (UTC kickoff/tip-off for games), `event_score` (final score as Polymarket's sports feed shows it),
`event_period`, `market_id`, `condition_id`, `question`, `group_item` (e.g. bracket label or team), `smt` (sportsMarketType:
`moneyline`, `totals`, `spreads`, `soccer_exact_score`, …), `line`, `outcomes` (JSON), `token_ids` (JSON, same order),
`final_prices` (JSON; 1/0 after resolution), `winner_idx` (index of the winning outcome, blank if not resolved at pull time),
`uma_status`, `last_trade`, `best_bid`, `best_ask`, `spread` (at close; mostly meaningless after resolution),
`volume`, `volume_clob`, `liquidity`, `event_volume`, `open_interest`, `created_at`, `start_date`, `end_date`, `closed_time`,
`neg_risk`, `fees_enabled`, `fee_rate`, `fee_exp` (taker fee per share = rate × (p(1−p))^exp), `tick`,
`station` (ICAO station for temperature markets), `resolution_source`, `description` (first 600 chars; blank for games).

### prices*.parquet
`market_id` (int64), `t` (unix seconds UTC), `p` (float32, price of outcome 0; outcome 1 = 1 − p for binary markets).
Source: CLOB `prices-history`. These are Polymarket's sampled prices (midpoint / last trade), **not** order-book asks:
add slippage. `prices`: ~10-minute points over the market's life, thinned to hourly when more than 7 days before the end.
Only markets with volume ≥ $1,000 (games) or ≥ $200 (other families) get price files; thinner ones have the markets row only.
`prices1m`: moneyline / totals / spreads with a game start and volume ≥ $5,000.

### fills.parquet
`market_id`, `t`, `outcome_idx` (0/1 = which token), `price` (USDC per share), `shares`, `maker_side` (`buy` = the resting order
bought, so the taker sold; `sell` = taker bought at this price), `tx`. Source: Goldsky public Polymarket orderbook subgraph
(`OrderFilled` events; the taker-order echo of each match is dropped). Football / US sports / esports moneylines with volume ≥ $5,000,
the 60 minutes before game start. Use these to check whether a price was actually fillable.

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
- `data-api.polymarket.com/trades` was retired (HTTP 410), so fills come from the subgraph; if it rate-limits a run, that day has no
  fills file.
- History starts 2025-01-01 (daily temperature markets start 2025-12-30; `finance-updown` tag March 2026).
