# Price Cron

One clean `token → price` table for the whole platform, refreshed every 15 min.

**Does not compute prices.** `network-and-prices` already does the hard part
(Astroport LP prices cross-checked vs CoinGecko; LSTs via Eris hub ratios). This
cron **consolidates** that into a flat table and rolls a price history.

## Output — `tla-core` repo, `prices/` module
- `prices/current.json` — `prices{ symbol: {price_usd, source, change_24h_pct, change_7d_pct} }` + `ratios{}`
- `prices/history.json` — tier-builder tiers (15-min → hourly → day → epoch → month → year + epoch-end freeze)
- `prices/heartbeat.json` — standard heartbeat

## How it fits
- **Source:** `PRICES_SOURCE_URL` (one constant) → `network-and-prices`. When that engine
  migrates into tla-core, repoint this one line — no other change.
- **History:** uses `lib/tier-builder.js` (shared). Reads its own prior `history.json`,
  adds this reading, writes it back.
- **USD on the dashboard** is still live-from-banner at render; this table is the
  fallback and the only source for tokens the banner doesn't carry.
- No chain queries. If the source is unavailable, it aborts rather than writing stale.

## Render
Root dir `price-cron`, build `npm install`, command `node price-cron.js`,
schedule `*/15 * * * *` (every 15 min), env `GITHUB_TOKEN` + `GITHUB_REPO=defipatriot/tla-core`.
Without a token: writes `current.json`/`heartbeat.json` locally for inspection.

## Recent changes
- **1.0.0** — initial. Consolidates network-and-prices `token_prices` + `lst_ratios`
  into one table; rolls history via tier-builder. Dry-run verified: 27 tokens, 6 ratios.
