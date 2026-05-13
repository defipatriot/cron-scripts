# Skeleton Swap LP Data Cron

Captures daily Skeleton Swap pool snapshots from Backbone Labs' aggregator API. All phoenix-1 SS pools, every day.

**Data store:** [`defipatriot/ss-pool-data_2026`](https://github.com/defipatriot/ss-pool-data_2026)

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
