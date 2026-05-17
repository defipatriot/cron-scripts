# Astroport Snapshot Cron

Captures daily Astroport pool TVL/volume snapshots for all TLA-relevant LPs. Pool discovery uses Astroport's master pool registry (`pools.getAll`), cross-referenced against the TLA gauge controller's `distributions` query to identify which pools the DAO has voted on.

**Data store:** [`defipatriot/astroport-pool-data_2026`](https://github.com/defipatriot/astroport-pool-data_2026)

---

## What it captures

For each TLA-relevant Astroport LP:

- **Pre-computed metrics** from Astroport's indexer (single source of truth):
  - `astroportTvlUsd` — current TVL
  - `astroportDayVolumeUsd` — 24h volume
- **Per-epoch breakdown** from `charts.liquidity` + `charts.volume`:
  - `avgLiquidity` — mean TVL over each TLA epoch
  - `avgVolume` — average per-4-hour volume (raw sum / 42 expected samples)
  - `liqPointCount`, `volPointCount` — sample counts for tier selection
- **Metadata** from Astroport: `poolType` (xyk/concentrated/stable), `lpAddress`, deregistration/blocked flags
- **TLA gauge context**: `bucket` (stable/project/bluechip/single)

---

## Architecture (v2)

Two-source discovery, found via HAR-trace of Eris's own Liquidity Hub frontend:

1. **Astroport `pools.getAll?chainId=phoenix-1`** — returns all 275+ pools on Terra Phoenix-1 with name, addresses, TVL, volume, poolType, and deprecation flags pre-computed. Single 350KB response.
2. **TLA staking contracts — `total_staked_balances`** — four parallel queries, one per gauge bucket (stable/project/bluechip/single). Returns the complete list of LP tokens registered with each staking contract, including pools that currently have zero VP / zero distribution (what the Eris UI labels "Inactive"). This is the same query the Eris frontend uses to populate its Liquidity Hub page.

Each pool entry from the staking contracts is cross-referenced against Astroport's `lpAddress` field to attach the canonical `poolAddress`, then a `bucket` label is added based on which staking contract surfaced it.

Pools that have **either** a gauge bucket assignment **or** are listed in the `ALWAYS_INCLUDE_POOLS` constant get included. Pools that exist on Astroport but have no TLA staking-contract presence are dropped (they're real Astroport pools but not TLA-relevant).

### Why this is better than v1

The original cron resolved pools via `gauge_infos:next` → cw20 minter → pair → IBC denom lookup. That required:
- Two contract queries per pool to find the address
- IBC denom resolution via chainsco's indexer (~50% of TLA pools have at least one IBC side)
- Manual handling of cw20 vs factory denom formats
- And it still missed "inactive" pools entirely because they don't have current-epoch VP

The v2 approach skips all of that — Astroport already has the pool name and addresses pre-computed, and the staking contracts return ALL registered pools regardless of voting status.

**Coverage improvement**:
- v0 (gauge_infos + IBC index): 6 of 20 active pools (sandbox) / ~15 of 20 (production)
- v1 (gauge_infos + hardcoded fallback): 11 of 20 active pools
- v2 (pools.getAll + total_staked_balances): **36 of 36 pools (active + inactive)** — full coverage matching Eris UI

---

## The 4 TLA staking contracts

| Bucket | Contract |
|---|---|
| stable | `terra1v399cx9drllm70wxfsgvfe694tdsd9x96p9ha36w7muffe4znlusqswspq` |
| project | `terra1awq6t7jfakg9wfjn40fk3wzwmd57mvrqtt3a39z9rmet7wdjj3ysgw3lpa` |
| bluechip | `terra14mmvqn0kthw6sre75vku263lafn5655mkjdejqjedjga4cw0qx2qlf4arv` |
| single | `terra1qdz5qgafx88kp5mf6m2tah8742g4u5g2cek0m3jrgssexexk7g4qw6e23k` |

Each accepts `{total_staked_balances: {}}` and returns an array of staked-asset entries with `{asset, shares, total_shares, config}`. Same contracts used by the Eris Liquidity Hub UI.

---

## What's NOT captured (by design)

- **Skeleton Swap pools** — captured by the [`skeletonswap-lp_data`](../skeletonswap-lp_data) cron instead.
- **Single-sided staking gauges** (xASTRO, ampCAPA tokens, etc.) — these aren't LP pools and Astroport's chart endpoints don't index them. They appear in the staking contract responses but get filtered out because they don't have a pool address. For that data look at `votion-data_2026` (which captures lockup-level vote allocations).
- **LP tokens whose Astroport pool has been fully deregistered** — about 7 entries from the staking contracts reference cw20 LP tokens whose Astroport pool has been removed from `pools.getAll` entirely. These get dropped with a count in the log (e.g., "7 cw20 entries with no Astroport pool").

**Inactive pools ARE captured** (this changed in v2). Any pool registered with a TLA staking contract gets included, regardless of current vote share or TVL. The "Inactive" label in Eris's UI is just a display filter — the data is the same.

---

## Run modes

The cron auto-detects mode based on date:

| Date | Mode | What it writes |
|---|---|---|
| 1st of month (00:10 UTC) | `monthly` | JSON + daily CSV + weekly CSV (last completed epoch) |
| Monday (00:05 UTC) | `weekly` | JSON + daily CSV + weekly CSV |
| Other days (23:59 UTC) | `daily` | JSON + daily CSV |

Override via CLI for testing: `node astroport-snapshot.js weekly`.

---

## Run locally

```bash
npm install                   # no dependencies, but conventional
node astroport-snapshot.js    # captures current epoch; writes locally without GITHUB_TOKEN
```

---

## Render configuration

| Setting | Value |
|---|---|
| Type | Cron Job |
| Build command | `cd astroport && npm install` |
| Start command | `cd astroport && npm run snapshot` |
| Schedule | `59 23 * * *` (daily 23:59 UTC) |

### Required environment variables

```
GITHUB_TOKEN     # PAT with write scope on astroport-pool-data_2026
GITHUB_REPO      # defipatriot/astroport-pool-data_2026
GITHUB_BRANCH    # main
```

---

## Reliability

- **3-try exponential backoff** on all HTTP calls (1s/3s/9s) with immediate short-circuit on `"Pool not found"` errors.
- **LCD fallback**: tries `terra-rest.publicnode.com`, falls through to `terra.publicnode.com` on 403/5xx.
- **20-second timeout per HTTP call.**
- **200ms stagger** between per-pool chart fetches.
- **Per-source isolation**: liquidity and volume fetches fail independently per pool.
- **Aborts on empty pool list** — won't write a snapshot if Astroport returned zero pools.

---

## Field reference — JSON output

```jsonc
{
  "schemaVersion": 2,
  "capturedAt":     "2026-05-12T23:59:00.000Z",
  "capturedAtUnix": 1779497940000,
  "period":         184,
  "runMode":        "daily",
  "chartRange":     "D30",
  "discoveryMethod": "astroport-pools-getAll + tla-staking-contracts (total_staked_balances)",
  "stats":          { "ok": 19, "deprecated": 0, "failed": 0, "total": 19 },
  "pools": [
    {
      "name":           "LUNA-ampLUNA",
      "rawName":        "LUNA - ampLUNA",            // Astroport's raw " - " format
      "bucket":         "project",                   // TLA gauge bucket
      "poolContract":   "terra1cupwgntu...",
      "lpAddress":      "terra1...",                 // LP token address
      "poolType":       "concentrated",              // xyk | concentrated | stable

      "astroportTvlUsd":        1218050,             // pre-computed by Astroport indexer
      "astroportDayVolumeUsd":  12193,

      // Added 2026-05-17 for LP health scoring + portfolio tracking
      "astroportStakedLiquidityUsd": 134926.78,        // USD locked in Astroport's astro-staking
      "astroportLpTotalSupply":      "5712384927512",  // total LP tokens minted (raw, string for precision)
      "astroportDayFeesUsd":         51.024,           // 24h fee revenue (USD) — LP health signal
      "astroportFeeApr":             0.01528,          // pool fee yield rate (decimal, e.g. 0.05 = 5%)
      "astroportAssets": [                              // raw reserves at capture time
        {
          "symbol":    "LUNA",
          "denom":     "uluna",
          "amount":    "8765432109876",                // raw on-chain amount (multiply by 10^-precision)
          "price_usd": 0.0665,
          "precision": 6
        },
        {
          "symbol":    "ampLUNA",
          "denom":     "terra1ecgazyd...",
          "amount":    "5432109876543",
          "price_usd": 0.1362,
          "precision": 6
        }
      ],

      "isDeregistered":         false,
      "isBlocked":              false,
      "isHidden":               false,

      "epochs": {
        "184": {
          "avgLiquidity":  1227120.24,               // mean of liquidity samples in epoch
          "avgVolume":     745.11,                   // sum / 42 expected samples
          "liqPointCount": 3,
          "volPointCount": 2
        },
        "183": { /* ... */ },
        "182": { /* ... */ }
      },
      "latestEpoch":     184,
      "latestLiquidity": 1227120.24,
      "spotLiquidity":   1227120.24,                 // alias for latestLiquidity

      "fetchOk":         true,
      "fetchErrors":     {},                         // empty if both liq + vol succeeded
      "deprecated":      false,
      "deprecatedReason": null
    }
  ]
}
```

---

## Field reference — CSV output

### Daily CSV (`data/daily/YYYY-MM-DD.csv`) — 20 columns

The CSV's first 5 columns (`date,time,dex,pool_name,pool_address`) match the Skeleton Swap daily CSV schema so cross-DEX consumers can union them. Columns 6-15 are common per-pool metrics; columns 16-20 were added 2026-05-17 for LP health scoring and portfolio tracking.

| Column | Type | Description |
|---|---|---|
| `date` | string | Capture date, YYYY-MM-DD UTC |
| `time` | string | Capture time, HH:MM:SS UTC |
| `dex` | string | Always `astroport` |
| `pool_name` | string | Canonical pool name (LUNA-first when paired with LUNA) |
| `pool_address` | string | Astroport pool contract |
| `tvl_usd` | number | TVL from Astroport's indexer (`poolLiquidityUsd`) |
| `volume_24h_usd` | number | 24h volume from Astroport's indexer (`dayVolumeUsd`) |
| `bucket` | string | TLA gauge bucket: stable/project/bluechip/single |
| `pool_type` | string | xyk/concentrated/stable (from Astroport) |
| `is_amplified` | bool | Whether the pool is amplified (always false in current data; reserved for future use) |
| `latest_epoch_avg_liquidity` | number | Mean TVL from chart samples in latest epoch |
| `latest_epoch` | int | TLA epoch number |
| `deprecated` | bool | Astroport returned "Pool not found" (post-deletion stub) |
| `is_deregistered` | bool | Astroport's `isDeregistered` flag |
| `fetch_ok` | bool | Whether chart data fetch succeeded |
| `fees_24h_usd` | number | **New 2026-05-17.** Pool fee revenue in the last 24h (USD). From Astroport's `tradingFees.day`. Core LP-health signal. |
| `fee_apr` | number | **New 2026-05-17.** Pool fee yield rate as a decimal (e.g. 0.05 = 5% APR). From Astroport's `tradingFees.apr`. Sanity-check against the dashboard's claimed APR. |
| `lp_total_supply` | string | **New 2026-05-17.** Total LP tokens minted (raw, no decimals applied). From Astroport's `poolLiquidity`. Needed to compute any member's pct_of_pool over time as (their LP balance / total supply). Stored as a string to preserve full precision. |
| `astro_staked_usd` | number | **New 2026-05-17.** USD value locked in Astroport's astro-staking contract for this pool (`poolStakedLiquidityUsd`). Note: this is DIFFERENT from TLA's staking — separate contract, separate purpose. |
| `assets_json` | string (JSON-encoded) | **New 2026-05-17.** Raw asset reserves at capture time, as a CSV-escaped JSON array. Each entry: `{symbol, denom, amount (string), price_usd, precision}`. The `amount` field is the on-chain raw amount; multiply by `10^-precision` to get human-readable. Stored raw to preserve precision. Used for chain-direct verification and slippage analysis. |

**CSV reading note:** Because `assets_json` contains embedded commas and double-quotes, parsing this CSV requires a real CSV reader (e.g. Python's `csv` module, JavaScript's `papaparse`). Naive `split(',')` will break. The cell follows RFC 4180: enclosed in `"`, internal `"` doubled to `""`.

### Weekly CSV (`data/weekly-avg/2026-epoch-{N}.csv`)

Uses **tiered last-complete-epoch selection**:

| Column | Description |
|---|---|
| `pool_name`, `bucket`, `pool_address`, `deprecated` | Same as daily |
| `epoch` | The epoch selected by the tiered fallback |
| `avg_liquidity_usd` | TVL for that epoch |
| `total_volume_usd` | Total volume = avgVolume × 7 |
| `liq_points`, `vol_points` | Sample counts |
| `tier` | `'stable'` (volN≥5), `'sparse-volume'` (volN≥1), or `'liquidity-only'` (liqN≥1 only) |

---

## Manual pool additions

To capture a specific pool that isn't in the TLA gauge distribution (e.g., a new pool you want to monitor before voting on it), add its `poolAddress` to the `ALWAYS_INCLUDE_POOLS` array at the top of the script:

```js
const ALWAYS_INCLUDE_POOLS = [
    'terra1examplepool...',
];
```

The pool will be included as long as Astroport's `pools.getAll` knows about it.

## Recent changes

### 2026-05-17 — Five new fields for LP health scoring + portfolio tracking

Added to per-pool JSON output AND daily CSV. All come from Astroport's `pools.getAll` response (which the cron already fetches); they were just not being surfaced before.

- **`fees_24h_usd`** — pool fee revenue last 24h (from `tradingFees.day`). Core LP health signal: real revenue vs promotional emissions.
- **`fee_apr`** — fee yield rate as decimal (from `tradingFees.apr`). Sanity-check against dashboard's claimed APR.
- **`lp_total_supply`** — total LP tokens minted (from `poolLiquidity`, stored as string for precision). Needed to compute any member's pct_of_pool over time as (their LP balance / total supply).
- **`astro_staked_usd`** — USD locked in Astroport's astro-staking contract (from `poolStakedLiquidityUsd`). Separate from TLA's staking — different contract, different purpose.
- **`assets_json`** — raw asset reserves at capture time as CSV-escaped JSON. Each entry: `{symbol, denom, amount (string), price_usd, precision}`. Used for chain-direct verification and slippage analysis.

**Breaking change for CSV consumers**: the daily CSV is now 20 columns (was 15). Anything reading it column-by-position will break; readers must use a real CSV parser (Python `csv` module, papaparse, etc.) — naive `split(',')` will break on the embedded JSON in `assets_json`.

**Verified**: cron ran end-to-end against live data after the changes — 36 pools captured in 25s, all new fields populated correctly for LUNA-CAPA and other test pools.
