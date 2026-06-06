# cron-scripts

Source code for every production cron that powers `thealliancedao.com`.

Each cron lives in its own folder with its own README. This top-level README is an index — start here to find what you need.

## How the system fits together

```
defipatriot/cron-scripts (this repo)
   ├── one folder per cron (source code)
   └── Render runs each on its own schedule

       ↓ each cron writes to its own data repo

defipatriot/<cron-name>-data_2026  (one per cron)
   ├── 2026/data/<cron-name>.json     ← current snapshot
   ├── 2026/heartbeat.json            ← freshness signal
   └── 2026/daily/YYYY-MM-DD.json     ← per-day archive

       ↓ pages on thealliancedao.com read directly from raw.githubusercontent.com

defipatriot/aDAO-links-site  (the live website)
   └── pages render from the data repos via fetch()
```

No backend server. No database. Each cron is independent — a failure in one doesn't break the rest. Pages cache last-good data and degrade gracefully.

## Cron inventory

### 🟢 Active production crons (10)

| Folder | Writes to | Cadence | Purpose |
|---|---|---|---|
| `adao-positions/` | `adao-positions-data_2026` | Daily 01:00 UTC* | Member position snapshots (16 positions × all members) — foundation for Portfolio Tracker |
| `astroport/` | `astroport-pool-data_2026` | Daily | Astroport pool stats (liquidity, APR, volume) |
| `bribes-history/` | `bribes-data_2026` | Daily | Bribes per epoch — voting incentive history |
| `marketplace-stats/` | `marketplace-data_2026` | Daily | NFT marketplace activity for Pixel Lions |
| `network-and-prices/` | `network-and-prices-data_2026` | Daily | Token prices, chain stats, ASTRO etc. (the page-wide price source) |
| `nft-inventory/` | `nft-inventory-data_2026` | Daily | Pixel Lions ownership distribution (replacing deving.zone) |
| `skeletonswap-lp_data/` | `ss-pool-data_2026` | Daily | Skeleton Swap pool stats |
| `tla-snapshot/` | `tla-snapshot-data_2026` | Daily 23:00 UTC Sun, 00:00 UTC other days | TLA gauge state at epoch boundaries — votes, distributions, APRs |
| `tla-vp-holders/` | `tla-snapshot-data_2026` (subdirectory) | Daily | Per-wallet veLUNA holdings — voting power resolution |
| `votion/` | `votion-data_2026` | Daily | Votion bribes market — current epoch incentive offers |
| `chain/tla-registry/` | `tla-chain-registry` (no `_2026` — separate convention) | Daily 00:05 UTC | **The TLA ecosystem catalog** — 173 tokens, 75 pools, 65 amplps, 668 wallets with cross-source reconciliation. See `chain/tla-registry/README.md`. |

\* `adao-positions` is currently scheduled `0 1 * * 1` (weekly Mondays). Needs to change to `0 1 * * *` (daily) — tracked in `CHANGES_PENDING.md` P1.

### 🟡 Legacy / retired folders (in this repo for history)

| Folder | Status | Notes |
|---|---|---|
| `ampcapa/` | Last update 2026-04. No README. | Early experiment with ampCAPA-specific tracking — superseded by general `adao-positions` enumeration |
| `backing/` | Last update 2026-04. No README. | Early experiment with treasury backing analysis — superseded |
| `fuel/` | Last update 2026-05-30. No README. | Status unclear; not currently scheduled on Render |

These are kept for git history. They are NOT running as production crons. If you find yourself looking at one of these for active work, you're probably in the wrong folder.

### 📁 Root-level orphan files (safe to delete)

| File | Why it's there | Action |
|---|---|---|
| `tla-chain-registry.js` (root) | Old v1.0 catalog cron file from before the rename + folder move. | Delete — the current catalog cron is at `chain/tla-registry/tla-registry.js`. |
| `tla-registry.js` (root) | Accidentally uploaded to root instead of `chain/tla-registry/` during a deploy. The chain/ path is what Render reads. | Delete — root copy is a stale duplicate. |

## Conventions used across crons

### Data write pattern

Every cron writes three files to its data repo per run:

1. `2026/data/<cron-name>.json` — the latest snapshot (overwrites)
2. `2026/heartbeat.json` — freshness signal (`{schemaVersion, capturedAt, runId, runMode, currentEpoch, status, next_expected_run_at, ...}`)
3. `2026/daily/YYYY-MM-DD.json` — per-day archive (one file per UTC day, never overwritten)

The page-side `cron-health` widget reads heartbeat.json from each repo and shows green/yellow/red based on `next_expected_run_at` vs. current time.

### Failure semantics

- **Both LCDs unreachable** → exit clean (1 or 2), no GitHub write. Last good snapshot stays in place.
- **Watchdog** → most crons have a hard runtime ceiling (5-10 min) to prevent runaway costs.
- **External source fails** → record in `source_errors` / `_errors[]`, snapshot publishes with what DID succeed, status becomes `partial`.
- **Required source fails** → fatal, exit non-zero, no publish.

Status values in heartbeat: `ok` | `partial` | `error` | (occasionally `skipped` if scheduling logic decided to no-op).

### Environment variables

Every cron expects:
- `GITHUB_TOKEN` — write access to its data repo
- `GITHUB_REPO` — destination data repo (e.g. `defipatriot/adao-positions-data_2026`)
- `GITHUB_BRANCH` — defaults to `main`

Catalog cron (`chain/tla-registry/`) additionally uses:
- `TERRA_LCD_PRIMARY` (default `https://terra-lcd.publicnode.com`)
- `TERRA_LCD_FALLBACK` (default `https://terra-rest.publicnode.com`)
- `GLOBAL_CONFIG_ADDR` (the bootstrap contract — should never change)

## Where to find more detail

| Question | Where to look |
|---|---|
| What does cron X do specifically? | `<cron-folder>/README.md` |
| Recent changes per cron? | "Recent changes" section in each cron's README |
| The catalog system's Rev history? | `defipatriot/website-adao-core/catalog-log.md` |
| Cross-cutting architecture, design principles? | `defipatriot/website-adao-core/PROJECT_KNOWLEDGE.md` |
| What's pending to work on? | `defipatriot/website-adao-core/CHANGES_PENDING.md` |
| Per-page dashboard changes? | `defipatriot/website-adao-core/{index,tla,dao,lore,explorer}-log.md` |
| Top-level changelog for THIS repo? | `CHANGELOG.md` (same folder as this README) |

## Deploy notes

All crons run on **Render** as scheduled cron jobs in the **Oregon** region. Each Render service points at this repo with a specific `Root directory` (the cron folder). Build command is `npm install`, start command is `node <script>.js`.

Adding a new cron:
1. Create the folder + README + script + `package.json` here
2. Create a new GitHub data repo with the `_2026` suffix (use the `2026/` year-folder convention)
3. Create a Render cron service pointing at the folder
4. Set env vars (GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH)
5. Verify first run writes heartbeat.json + data file
6. Add to the cron-health widget on the dashboard

## Operational status

10 production crons running on schedule as of 2026-06-06. Catalog cron (`chain/tla-registry/`) at Rev 0.15 deployed; Rev 0.16 packaged but not yet deployed (Phase 0 lock-in). All other crons stable.

See `CHANGELOG.md` for revision history.
