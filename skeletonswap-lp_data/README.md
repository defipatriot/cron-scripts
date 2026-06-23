# Skeleton Swap LP Data Cron

Captures daily Skeleton Swap pool snapshots from Backbone Labs' aggregator API. All phoenix-1 SS pools, every day.

**Data store:** [`defipatriot/ss-pool-data_2026`](https://github.com/defipatriot/ss-pool-data_2026)

---

## ✅ Data quality warning — RESOLVED (2026-06-23)

**The warlock-aggregator reliability problem described below has been fixed.** The cron was re-architected: it no longer trusts BackBone's bulk `dex.warlock.backbonelabs.io/api/pools/phoenix-1` feed for pool state. It now reads the pool _list_ from `skeletonswap.backbonelabs.io/mainnet/phoenix-1/pools_list.json` and queries the **chain directly** for each pool's reserves (the same trustworthy approach as the Astroport cron). It also computes a per-run `dataFingerprint` and tracks `consecutiveStuckRuns`, so a frozen upstream is now _detected_ (heartbeat `dataFreshness` flips to `stuck`) instead of silently captured. Current production runs are healthy (`status: ok`, `dataFreshness: fresh`, 0 stuck runs, ~34 pools/run).

The original warning is kept below for history.

<details>
<summary>Original warning (2026-05-17) — describes the old warlock-aggregator architecture, now retired</summary>

**The upstream source for this cron is unreliable.** A full audit of the daily backup files from 2026-01-12 → 2026-05-14 found:

- **29 consecutive identical files (2026-04-16 → 2026-05-14)** — the source API has been returning cached/stale data for ~30 days running, the cron faithfully captures whatever it receives
- **Three-week missing gap** (2026-03-12 → 2026-04-01) — likely a multi-day source outage
- **Two earlier 5-day frozen runs** (2026-03-07 → 2026-03-11 and 2026-04-06 → 2026-04-10)
- **Effective unique data coverage** is roughly 50% of the calendar window, not 75% (the "files present" coverage)

**Root cause:** the cron pulls from `dex.warlock.backbonelabs.io/api/pools/phoenix-1`. That endpoint is BackBone Labs' read of Skeleton Swap pool state (they run both BBL marketplace and the SS aggregator). When their aggregator caches stale data, our cron has no way to detect it — the API still responds 200, the cron writes what it gets, the data looks current but isn't.

**Path to fix:** querying Skeleton Swap pool contracts directly from chain (same approach as Astroport) would give us trustworthy data. Skeleton pools are on-chain like any other CW20-LP. The current cron's reliance on the BackBone aggregator was a convenience tradeoff that turned out to be expensive. _(Done — see the resolution note above.)_

</details>

---

## What it captures

Every pool from Skeleton Swap (Backbone Labs' aggregator) on phoenix-1:

- **Pool ID + address** — display name and Terra contract address
- **TVL** in USD — pre-computed by Backbone
- **Volume** — 24h and 7d in USD
- **APR** — 7-day swap-fee APR
- **Reserves** — raw token amounts in each pool
- **LP supply** — total share token supply

Includes **all pools**, not just TLA-relevant ones. The dashboard / TLA tool filters down at display time.

---

## How it works

The cron runs in one of four modes depending on date:

| Mode | When | What it writes |
|---|---|---|
| `daily` | Daily 23:45 UTC | `day-{N}.csv` where N = ISO day of week |
| `weekly` | Monday 00:05 UTC | `data/weekly-avg/2026-epoch-{N}.csv` (prior epoch's average) |
| `monthly` | 1st of month 00:10 UTC | `data/monthly-avg/YYYY-MM.csv` (prior month's average) |
| `yearly` | 1st January 00:15 UTC | `data/yearly-avg/YYYY.csv` (prior year's average) |

The mode is passed as a CLI argument by the calling cron service. Saturday daily runs also write `6-day-avg.csv` for previews.

### Rolling daily files

`day-1.csv` through `day-7.csv` are overwritten every week — they always contain the most recent Monday-Sunday data. For permanent historical lookback, refer to the weekly and monthly aggregates.

### Single API call per run

One fetch to `dex.warlock.backbonelabs.io/api/pools/phoenix-1` returns the full pool list with TVL/volume pre-computed. The cron just formats and commits.

---

## Run locally

```bash
npm install
node index.js daily       # or weekly / monthly / yearly
```

Without `GITHUB_TOKEN`, files write to the current directory.

---

## Render configuration

The 3 Render services this cron uses:

| Service | Schedule | Command |
|---|---|---|
| `ss-pool-daily` | `45 23 * * *` (daily 23:45 UTC) | `node index.js daily` |
| `ss-pool-weekly` | `5 0 * * 1` (Mon 00:05 UTC) | `node index.js weekly` |
| `ss-pool-monthly` | `10 0 1 * *` (1st of month 00:10 UTC) | `node index.js monthly` |

Three services share the same script, just with different CLI args and schedules.

### Environment variables

```
GITHUB_TOKEN     # PAT with write scope on ss-pool-data_2026
GITHUB_REPO      # defipatriot/ss-pool-data_2026
GITHUB_BRANCH    # main
```

---

## Reliability

- **Single-shot fetch** — no retry currently (planned improvement). If Backbone API is down, the run fails; next day's run repairs.
- **Stateless** — each run rebuilds its output file from scratch.
- **Per-run logging** — Render captures stdout for debugging.

---

## Known issues (tracked for later)

1. **No retry-with-backoff on Backbone API failure** — single fetch only. Adding 3-try exponential backoff is a quick fix.
2. **Git clone strategy slows down as repo grows** — currently the cron clones the full data repo to update files, then pushes. Migrating to GitHub Contents API (like astroport/votion crons use) would be faster.
3. **Pool name canonicalization mismatch with Astroport** — Skeleton Swap uses `ampLUNA-LUNA` while Astroport uses `LUNA-ampLUNA`. Website handles the alignment at display time.

---

## Output schema

See [`ss-pool-data_2026/README.md`](https://github.com/defipatriot/ss-pool-data_2026/blob/main/README.md) for full column definitions.

## Recent changes

### 2026-05-17 — Data-source freeze identified and documented

A full audit of the daily backup files from 2026-01-12 → 2026-05-14 surfaced significant reliability problems with the upstream source. See the **Data quality warning** at the top of this README for details.

**Summary of findings:**
- 29 consecutive identical files (2026-04-16 → 2026-05-14, ongoing) — BackBone aggregator caching stale data
- 3-week missing gap (2026-03-12 → 2026-04-01) — likely multi-day source outage
- Two earlier 5-day frozen runs (2026-03-07 → 2026-03-11, 2026-04-06 → 2026-04-10)
- Effective unique data coverage ~50% of the calendar window, not the 75% suggested by raw file presence

**Decision (2026-05-17)**: keep capturing best-effort. Don't change the cron. Don't use the data for scoring or trend analysis. Label clearly as "unverified" wherever it surfaces in dashboards.

**Future fix tracked**: build a chain-direct Skeleton Swap capture cron that queries SS pool contracts directly (same approach as Astroport). That gives us ungameable, on-chain-verified data and lets us retire the BackBone dependency. This is on the project roadmap (see top-level README under Project Status).
