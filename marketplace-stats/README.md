# Marketplace Stats Cron

Hourly snapshot of BBL + Boost marketplace state for the aDAO ecosystem collections. Replaces dashboard's per-page-load marketplace API hits with cached GitHub-CDN-served data.

**Data store:** [`defipatriot/marketplace-data_2026`](https://github.com/defipatriot/marketplace-data_2026)

---

## What it captures

For each collection (Alliance DAO, pixeLions, TLA Locks):

### Marketplace state (`data/marketplace.json`)
- BBL: floor price (bLUNA + USD), listed count, lifetime volume, broken/unbroken splits
- Boost: floor by payment token (LUNA/ampLUNA/arbLUNA), listed count
- Cumulative sales totals (BBL + Boost across all years)

### Live activity (`data/activity-7d.json`)
- Last 7 days of BBL events (sales, listings, cancels)
- Filtered to tracked collections
- Sorted newest-first

### Full listings (`data/listings/{marketplace}-{collection}.json`)
- All current BBL/Boost listings per collection with token IDs + prices
- Used by the dashboard's Listings tab/modal

### Sales history (`data/sales/nft-sales-{year}.json`)
- Per-year sales archive (BBL + Boost)
- Incrementally updated each run; deduped by tx_hash / launch_id
- First run does deep backfill via Boost paginated walk (BBL is limited to recent activity window)

---

## Schedule

Cron: `15 * * * *` (every hour at :15 — clear slot before all other crons)

Runtime: 30–60 seconds typical

---

## Why this cron exists

Before this cron, the dashboard hit BBL + Boost APIs directly on every page load. Three problems:

1. **CORS proxy dependency** — Cloudflare Worker (`bbl-proxy.defipatriot.workers.dev`) sat in the middle of every dashboard view; if it ever broke, marketplace tiles dark
2. **API rate limits** — busy dashboard traffic spikes risk hitting BBL's per-IP limits
3. **Stale sales history** — `nft-sales-2025.json` last updated Dec 31 2025; `nft-sales-2026.json` doesn't exist (5 months of sales missing from the site)

This cron solves all three: one server-side fetch per hour, no CORS proxy needed, sales history kept current.

---

## API endpoints used

| API | Endpoint | What we extract |
|---|---|---|
| BBL | `GET /api/v1/dapps/necropolis/collections/{contract}` | floor, lifetime volume |
| BBL | `GET /api/v1/dapps/necropolis/nfts?nftContract=X&types=buy_now` | current listings (token_id + reserve_price) |
| BBL | `GET /api/v1/dapps/necropolis/activity?chains=phoenix-1` | recent events (sales, listings, cancels) |
| Boost | `POST /graphql` Launches query (done:false) | current listings per collection |
| Boost | `POST /graphql` Launches query (done:true) | completed sales (full history) |

Server-side calls don't need a CORS proxy (CORS is a browser thing).

---

## Render setup

| Setting | Value |
|---|---|
| Name | `marketplace-stats` |
| Root Directory | `marketplace-stats` |
| Build Command | `npm install` |
| Command | `node marketplace-stats.js` |
| Schedule | `15 * * * *` |
| Env vars | `GITHUB_TOKEN`, `GITHUB_REPO=defipatriot/marketplace-data_2026`, `GITHUB_BRANCH=main` |

---

## Resilience

- **4xx errors fail fast** (no retry storm on bad endpoints or rate limits)
- **Per-collection failures don't block other collections** — BBL aDAO can fail and Boost pixeLions still updates
- **Status is `'partial'` if any sub-fetch fails**, with explicit error list in heartbeat
- **Sales history is incremental + idempotent** — re-runs safely dedupe; never overwrites good data with empty data
- **No external dependencies beyond BBL + Boost** (other than network-and-prices for USD conversion, non-fatal)

---

## Companion cron

The `nft-inventory` cron handles per-NFT chain data (owner, broken, rank). These two are deliberately independent — BBL API down? `nft-inventory` still updates. Chain unreachable? `marketplace-stats` still updates. Dashboard merges both outputs to render full UI.

---

## ⚠️ First-run notes

This cron was built from API shapes documented in `index.html` (request bodies, response field paths). The first Render run is the first end-to-end test against live BBL/Boost APIs. Watch:

1. **Heartbeat status** — should be `'ok'` after first run
2. **Cumulative sales totals** — first run does full Boost backfill; subsequent runs are incremental
3. **`data/marketplace.json` floors** — cross-check against BBL/Boost UIs manually

If the first run reports errors, the heartbeat enumerates them line-by-line for debugging.
