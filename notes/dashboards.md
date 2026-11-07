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
1. Add `{ id, label, soon }` to `SECTIONS` in src/status.ts. It gets a tab, a deep link and a placeholder section showing `soon`.
2. To give it real content: drop `soon`, add its own `<section class="sec hide" id="sec-<id>">…</section>` in PAGE, and serve its data from its own endpoint (`/api/<id>/status`) so it never touches the crypto status or the crypto trader.
3. Its JS renders only when `SEC === "<id>"`; keep the same panel/table classes so it looks the same.
