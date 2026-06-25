# Price Cron

One clean `token → price` table for the whole platform, refreshed every 15 min.

**Does not compute prices.** `network-and-prices` already does the hard part
(Astroport LP prices cross-checked vs CoinGecko; LSTs via Eris hub ratios). This
cron **consolidates** that into a flat table and rolls a price history.

## Output — `tla-core` repo, `prices/` module
- `prices/current.json` — one unified table `prices{ key: {price_usd, type, source, ...} }` where `type` is:
  - `token` (key = symbol) — from network-and-prices `final_price_usd` (+ 24h/7d change)
  - `lp` (key = LP token address) — `total_pool_usd / total_share` from tla-snapshot reserves
  - `amplp` (key = amplified factory denom) — LP price × `amp_lp.ratio`
  plus `ratios{}` (the LST hub ratios)
- `prices/history.json` — tier-builder tiers (15-min → hourly → day → epoch → month → year + epoch-end freeze)
- `prices/heartbeat.json` — standard heartbeat

## How it fits
- **Sources** (each a single repointable constant): `PRICES_SOURCE_URL` → network-and-prices
  (token prices/ratios); `TLA_SNAPSHOT_URL` → pool reserves (LP/ampLP per-unit prices);
  `CATALOG_URL` → tla-core/contracts (the LP/ampLP denoms to key by).
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
- **1.0.1** — added LP + ampLP per-unit prices from pool reserves (tla-snapshot ×
  contract catalog denoms): LP = total_pool_usd/total_share, ampLP = LP × amp_lp.ratio.
  Verified: 27 tokens + 41 LP + 61 ampLP. History tiers stay token-only (manageable).
- **1.0.0** — initial. Consolidates network-and-prices token_prices + lst_ratios; tier-builder history.
