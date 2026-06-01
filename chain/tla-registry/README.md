# tla-registry (cron source)

**Layer 0 of the TLA chain-native data pipeline.**

This is the script source. It writes its output to a separate data repo:
`defipatriot/tla-chain-registry`.

> **Naming note:** the source folder is `chain/tla-registry/` (short) but the
> data repo is `tla-chain-registry` (descriptive). Folder and repo names
> deliberately differ — folders cluster cleanly inside `cron-scripts/chain/`,
> while public data repos keep the "chain-native" signal in their name.

## What it does

Reads the canonical contract directory + pool registry from the Eris ve3
contracts on Terra. Every other layer in the new pipeline bootstraps from
what this writes — no more hardcoded contract addresses.

## Queries (5 per run)

| # | Contract | Query | Purpose |
|---|---|---|---|
| 1 | global-config | `all_addresses` | Master contract directory (the bootstrap) |
| 2 | asset-gauge | `distributions` | Canonical pool registry (gauge_pool_id, bucket, share %) |
| 3 | asset-gauge | `last_distribution_period` | Canonical current epoch |
| 4 | asset-gauge | `config` | Gauge list, global_config_addr, rebase asset |
| 5 | voting-escrow | `num_tokens` | Sanity ping (~431 currently) |

Only the global-config address is hardcoded. Everything else is discovered.

## Output schema

Written to `defipatriot/tla-chain-registry/2026/`:

- `current.json` — latest snapshot (the dashboard / other layers read this)
- `heartbeat.json` — freshness signal for the cron-health widget
- `daily/YYYY-MM-DD.json` — per-day archive (permanent history)

Each file has:
- `schemaVersion` + `capturedAt` + `canonicalEpoch`
- `raw.*` — unmodified query responses (per Part 5.0: capture RAW, never lose source)
- `directory` — parsed role → address map
- `pools[]` — flattened pool registry, keyed by `gauge_pool_id|bucket`
- `buckets{}` — per-bucket totals (total_gauge_vp, pool_count)
- `_errors[]` — failed queries (distinct from empty results)

## Deploy on Render

| Field | Value |
|---|---|
| Service type | Cron Job |
| Name | `tla-registry-v2` (or `tla-chain-registry-v2` — just a label) |
| Region | Oregon (matches other crons) |
| Schedule | `5 0 * * *` (daily 00:05 UTC) |
| Source repo | `defipatriot/cron-scripts` |
| Root directory | `chain/tla-registry` |
| Build command | `npm install` |
| Start command | `node tla-registry.js` |

### Env vars (required)

| Var | Value |
|---|---|
| `GITHUB_TOKEN` | Same token used by other crons (needs write to `defipatriot/tla-chain-registry`) |
| `GITHUB_REPO` | `defipatriot/tla-chain-registry` |

### Env vars (optional, sensible defaults baked in)

| Var | Default | Override when |
|---|---|---|
| `GITHUB_BRANCH` | `main` | If using a non-main branch |
| `TERRA_LCD_PRIMARY` | `https://terra-lcd.publicnode.com` | LCD primary changes |
| `TERRA_LCD_FALLBACK` | `https://terra-rest.publicnode.com` | LCD fallback changes |
| `GLOBAL_CONFIG_ADDR` | `terra1hwxg6s732eparz3ys7sa4t5f64ngpd2w8syrca6z7ckv3fs9uqnsvrpcqa` | Should never change |

## Local test

To run without pushing to GitHub (prints output to stdout):

```bash
# Leave GITHUB_TOKEN unset
node tla-registry.js
```

With `GITHUB_TOKEN` set, it pushes to whatever `GITHUB_REPO` points at —
**use a test repo name for development** to avoid clobbering production data.

## Failure modes

- **Both LCDs unreachable** → exit code 1, no GitHub write. Old snapshot stays in place.
- **Watchdog (5 min ceiling)** → exit code 2. Designed to never run away.
- **Downstream query fails (gauge / escrow)** → recorded in `_errors[]` but snapshot publishes with what DID succeed. Status set to `partial`.
- **`global-config.all_addresses` returns null** → fatal; can't proceed without the bootstrap.

## Why this design

Per `CRON-FIXES-BRIEF` Part 5.1:
- Layer 0 = discovery / bootstrap (this).
- Layer 1 = pricing (next).
- Layer 2 = entities (pools, locks, staking).
- Layer 3 = participants (the expensive one; daily only).
- Layer 4 = rollups (zero chain queries; pure functions of 0-3).

This layer has to come first because:
1. Every downstream layer needs the contract directory.
2. The pool registry self-discovers (no manual list maintenance).
3. The canonical epoch number settles off-by-one issues at the source.

## Migration safety (Part 5.6)

The existing 7-cron pipeline keeps running unchanged during this build.
This layer publishes to a NEW repo (`tla-chain-registry`). Diff against
old system is the verification step before any tile is migrated to read
from here.

## Future siblings

When Layers 1-4 land, they'll join this folder structure:

```
cron-scripts/chain/
├── tla-registry/     ← Layer 0 (this)
├── tla-pricing/      ← Layer 1
├── tla-pools/        ← Layer 2 (entities)
├── tla-participants/ ← Layer 3
└── tla-rollups/      ← Layer 4
```

Each writes to a matching public data repo
(`tla-chain-pricing`, `tla-chain-pools`, etc.).
