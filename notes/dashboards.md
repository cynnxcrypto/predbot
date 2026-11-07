# Dashboards

The dashboard (src/status.ts) is one shell with several top-level dashboards: Crypto, Football, Esports, US Sports, Indices & Commodities, Weather, Politics, Other.

## What is shared vs per dashboard
- Shared shell: page header (bot mode pill, build line), password, cloudflare tunnel URL, theme (dark navy, monospace numerals, green/red), `/api/*` server.
- Per dashboard: everything under its `<section id="sec-<id>">`. Crypto holds the whole existing page: overview, 5m/15m/1h/4h/24h window tabs, real-money panel, trade log, dry-run block, wallet chart, by-window/by-rule/day tables, paper lab, feeds.

## Deep links
- `#crypto`, `#crypto/<tab>` (overview, 5m, 15m, 1h, 4h, 24h), `#football`, `#esports`, `#us-sports`, `#indices`, `#weather`, `#politics`, `#other`.
- The tab bar scrolls sideways on narrow screens (the page itself never does).
- Old `#15m`-style links still open that crypto tab. With no hash the last dashboard and tab are remembered (localStorage `wsec`, `wtab`).

## Adding or filling a dashboard
1. Add `{ id, label, soon }` to `SECTIONS` in src/status.ts. It gets a tab, a deep link and a placeholder section showing `soon` (with a SOON badge).
   Add `paper: true` once the category has a paper logger (src/eventpaper.ts): the badge and placeholder go, the paper lab panel shows instead.
2. To give it real content: drop `soon`, add its own `<section class="sec hide" id="sec-<id>">…</section>` in PAGE, and serve its data from its own endpoint (`/api/<id>/status`) so it never touches the crypto status or the crypto trader.
3. Its JS renders only when `SEC === "<id>"`; keep the same panel/table classes so it looks the same.

## Category tabs (7 Nov 2026, src/eventdash.ts)
Every non-crypto category in `CATS` gets the crypto-style layout: hero (next event clock, today / paper net / fillable / Jev-sized / bets / won / signals, health chips), rules table (with Jev-sized net and pick buckets), paper trade log (open first, day rows, Jev pick + confidence), net-over-time chart + day table, why no trade fired (reason tally + latest signals), markets watched (prices, countdown, status), live order books (latest `data/history/books` snapshot: bid/ask, $ at ask), research + next step, data collector coverage (`data/history/state.json`).
Tabs without a paper logger (US Sports, Weather, Other) show research + planned rule and upcoming markets from Gamma by tag.
Data: `/api/events?sec=<id>` (eventpaper-summary.json + GitHub raw books/state + Gamma, fetched only while a tab is open, cached 5 min). Watch lists, signals, day stats and job health come from `summarize()` in src/eventpaper.ts.
