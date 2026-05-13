# cron-scripts

This is the home for all scheduled data-capture jobs that power the **Alliance DAO (aDAO) website** and the **TLA tool** (`tla-tool_ext.html`).

Each subfolder is one independent Render Cron Job that captures a specific slice of TLA / Terra ecosystem data and commits it to a dedicated GitHub repo. The website (and the tool, optionally) read from those data repos to render the dashboard.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CRON LAYER  (this repo)                               │
│  Each cron is independent — one failure doesn't break the others.           │
└───────────────────┬─────────────────────────────────────────────────────────┘
                    │
                    │ writes to
                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       DATA LAYER (separate GitHub repos)                    │
│  votion-data_2026 / ss-pool-data_2026 / astroport-pool-data_2026 /          │
│  bribes-data_2026 / tla-snapshot_2026 / etc.                                │
└───────────────────┬─────────────────────────────────────────────────────────┘
                    │
                    │ read by
                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│   CONSUMER LAYER                                                            │
│   ├── thealliancedao.com website (Vercel)                                   │
│   └── tla-tool_ext.html (interactive fallback / power-user view)            │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Design principle**: every cron is a leaf — it pulls fresh data from its source, transforms it, and writes a self-contained file. No cron depends on another cron's *runtime* state. The *only* cross-cron dependency is the future `tla-snapshot` cron, which reads the output of all the other crons (from GitHub) to produce a unified dashboard file.

---

## Active crons

| Folder | Captures | Schedule (UTC) | Data repo |
|---|---|---|---|
| [`votion/`](./votion) | Weekly Votion epoch snapshot (lockups, VP, votes, USD, APYs, pool rollup) | Sun 23:55 | `votion-data_2026` |
| [`skeletonswap-lp_data/`](./skeletonswap-lp_data) | Daily Skeleton Swap pool TVL/volume + weekly + monthly rollups | Daily 23:45 | `ss-pool-data_2026` |
| [`astroport/`](./astroport) | Daily Astroport TLA-pool TVL/volume + per-epoch chart aggregates (active+inactive) | Daily 23:50 | `astroport-pool-data_2026` |
| [`bribes-history/`](./bribes-history) | All PD bribes decoded from DAODAO proposals + current bribe-manager state | Daily 23:35 | `bribes-data_2026` |
| [`network-and-prices/`](./network-and-prices) | Terra network + LST ratios + dual-source token prices + 7-day price series | Hourly at :40 | `network-and-prices-data_2026` |
| [`ampcapa/`](./ampcapa) | ampCAPA-specific data | (legacy) | TBD |
| [`backing/`](./backing) | Backing-data snapshots | (legacy) | TBD |
| [`fuel/`](./fuel) | FUEL hourly price | (legacy — kept for hourly candles) | `fuel-data_2026` |

Each subfolder has its own `README.md` with detailed setup, schema, and reliability notes.

---

## Master schedule (UTC)

This is the staggered schedule that lets producer crons finish before the consumer cron reads their output. All times in UTC.

```
=== Hourly throughout the day ===
:40  network-and-prices  ← refreshes price cache every hour (dashboard reads from here)

=== Daily flow (Mon-Sat) — runs nightly ===
23:35  bribes-history       ← chain queries, ~5s
23:45  skeletonswap         ← Backbone API, ~20s
23:50  astroport            ← Astroport TRPC, ~26s
23:58  tla-snapshot         ← consumer (reads all above, ~60s)  [planned]

=== Sunday (epoch close) — same order plus: ===
23:55  votion               ← weekly snapshot of full epoch
23:58  tla-snapshot 'pre-flip'   ← frozen sample of epoch's final state
─── epoch boundary 00:00 UTC ───
Mon 00:08  tla-snapshot 'post-flip'   ← frozen sample of new-epoch start
Mon 00:15  bribes-history    ← catches any post-flip bribe activity

=== Mid-epoch (tla-snapshot only) ===
Every 4h: 03:55, 07:55, 11:55, 15:55, 19:55 — rolling sample
```

### Why staggered

If two crons fire at the same minute and one writes to a GitHub repo the other reads from, you can get race conditions where the consumer reads stale data. Staggering by 5 minutes guarantees each producer finishes before the next-stage consumer starts.

### TLA epoch math

All crons use the same epoch arithmetic:

```js
EPOCH_START_MS    = Date.parse('2022-10-31T00:00:00Z')
EPOCH_DURATION_MS = 7 * 24 * 60 * 60 * 1000      // 7 days
currentEpoch      = floor((now - EPOCH_START_MS) / EPOCH_DURATION_MS)
```

Epoch boundary is Sunday 23:59 → Monday 00:00 UTC. Epoch numbers are consistent across all repos (votion epoch 184 = SS epoch 184 = astroport epoch 184).

---

## Render deployment

Each cron lives in its own subfolder and is deployed as an independent Render Cron Job:

| Render setting | Value |
|---|---|
| Type | Cron Job |
| Runtime | Node 18+ |
| Branch | `main` |
| Root Directory | `<folder-name>` (e.g. `astroport`) |
| Build Command | `npm install` |
| Start Command | `node <script-name>.js` |
| Schedule | (per-cron, see table above) |
| Plan | Free |

### Environment variables (all crons)

```
GITHUB_TOKEN     # PAT with write scope on the cron's target data repo
GITHUB_REPO      # e.g. defipatriot/astroport-pool-data_2026
GITHUB_BRANCH    # main
```

Same `GITHUB_TOKEN` works across all crons if it has `repo` scope (classic PAT) or `Contents: read/write` on all relevant repos (fine-grained PAT).

### Free tier usage

Total compute across all current + planned crons: **~3 hours/month** out of Render's free 750 hours/month allowance. We use < 0.5% of free tier capacity. Cost is not a constraint.

---

## Data flow per cron

Each cron follows the same pattern:

```
1. Fetch from upstream sources (LCD, TRPC, API)
   └─ Retry with exponential backoff, fallback URLs where applicable
2. Transform and aggregate into per-epoch / per-pool / per-day structures
3. Write JSON + CSV files to /tmp scratch space
4. Push to target GitHub repo via Contents API
   └─ Overwrites same-named files with new SHAs
```

The crons are **stateless** — each run rebuilds files from scratch. If a cron misses runs, the next successful run repairs everything. No partial-state corruption possible.

---

## File formats

Two conventions across all data repos:

### JSON snapshots
- Top-level `schemaVersion` field (v1, v2, etc.)
- Top-level `capturedAt`, `capturedAtUnix`, `period` for time/epoch metadata
- Domain-specific top-level keys (e.g. `pools`, `lockups`, `bribes`)
- Pretty-printed with 2-space indent (readability over compactness — files are ≤100KB)

### CSV summaries
- First row is header
- Pool addresses use full bech32 (no truncation)
- USD numbers fixed to 2 decimals
- Boolean fields as literal `true` / `false` strings
- Empty fields are empty (no `null` / `N/A`)

---

## Repos managed by these crons

| Data repo | Cron | What's in it |
|---|---|---|
| [`defipatriot/votion-data_2026`](https://github.com/defipatriot/votion-data_2026) | `votion` | Weekly Votion epoch snapshots; `votion-old/` = v1 archive, `votion/` = v2 current |
| [`defipatriot/ss-pool-data_2026`](https://github.com/defipatriot/ss-pool-data_2026) | `skeletonswap-lp_data` | Daily SS rolling 7-day, weekly aggregates, monthly aggregates |
| [`defipatriot/astroport-pool-data_2026`](https://github.com/defipatriot/astroport-pool-data_2026) | `astroport` | Daily Astroport per-epoch + daily CSV |
| [`defipatriot/bribes-data_2026`](https://github.com/defipatriot/bribes-data_2026) | `bribes-history` | All PD bribes ever + current chain state + per-epoch rollups |

---

## Planned (not yet built)

| Folder | Purpose | Status |
|---|---|---|
| `network-and-prices/` | Terra supply/bonded/inflation + LST ratios + token prices (Eris vs CoinGecko) | Next |
| `tla-snapshot/` | Unified TLA snapshot — reads all other crons, produces dashboard file | After network-and-prices |
| `adao-positions/` | Per-aDAO-wallet TLA positions | Waits on wallet list |
| `nft-stats/` | deving.zones marketplace snapshot | After NFT API inspection |

See `CHANGES_PENDING.md` in the `website-adao-core` repo for the active backlog.

---

## When something breaks

Render sends emails on cron failures. To diagnose:

1. Open the cron service in Render dashboard → **Logs** tab
2. Check the last failed run's stack trace
3. Common failures:
   - **HTTP 401/403 from GitHub** → `GITHUB_TOKEN` expired or wrong repo scope
   - **HTTP 5xx from Terra LCD** → switch to fallback LCD (already handled by cron's retry logic, but check if both LCDs are down)
   - **Astroport TRPC 500 "Pool not found"** → handled gracefully (pool flagged deprecated, run continues)
   - **GitHub 422 "no changes"** → benign, file hash matched; nothing to commit
4. The cron is stateless — just trigger a manual run after fixing the root cause

The website is designed to gracefully degrade if a data repo goes stale — it'll show "data N hours old" rather than crash. That said, none of these crons should stay broken for long; aim for fix-within-24h.

---

## Tool ↔ cron compatibility

The TLA tool (`tla-tool_ext.html` at thealliancedao.com) can render the dashboard **either**:

1. **From cron data** (default) — reads the data repos directly
2. **From live API calls** (fallback) — pulls fresh from Eris, Astroport, Terra LCDs directly

The toggle is a one-liner at the top of the tool's code. Use the cron path for fast loads; use the live path if any cron is stale or broken.

This is intentional redundancy. The crons are the primary system but the tool can always operate standalone if needed.
