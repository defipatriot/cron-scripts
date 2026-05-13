# TLA Snapshot Cron

The unified TLA pool view. Consumes all 5 producer crons + live chain queries to produce the dashboard's primary data file.

**Data store:** [`defipatriot/tla-snapshot-data_2026`](https://github.com/defipatriot/tla-snapshot-data_2026)

---

## What it captures

For every TLA-registered pool across all 4 buckets (stable / project / bluechip / single):

- **Identity**: name, bucket, DEX, dex_subtype (concentrated / xyk / stable), pool address, LP address
- **Status classification**:
  - `active` — VP ≥ 1% of bucket VP (currently earning rewards)
  - `voted_but_below_threshold` — has votes but below the 1% activation floor
  - `deprecated` — flagged by astroport-pool-data as no-chart-data
  - `zero_vp` — registered but with no current votes
- **Voting power**: VP, % of bucket, per-lockup VP contributions (from votion data)
- **DEX depth (TVL)**: from Astroport or SkeletonSwap data
- **TLA TVL (staked-in-TLA)**: USD value of LP tokens locked in TLA staking contracts
- **LP health** (for LP-pair pools):
  - Both assets with raw amount, human amount, decimals, USD value
  - Balance ratio (e.g. 50/50 LUNA/USDC)
  - Total pool USD value
- **ampLP price ratio**:
  - `underlying_lp_amount` (LP tokens held by staking contract)
  - `shares` (ampLP shares issued to users)
  - `ratio` (LP per ampLP — > 1 means amplified, < 1 means fee-eroded)
  - `ratio_type` (amplified / non-amplified / unity)
  - `stake_mechanism` (custody / astroport-incentives)
- **Bribes**:
  - Active bribes on this pool (from bribes-data current-state)
  - Historical PD bribe count

Plus top-level rollups:
- Total TLA TVL (sum of staked-in-TLA across all pools)
- Total DEX depth
- Pool counts by status
- Per-bucket VP totals + active counts + bucket TVL

---

## The "active pool" rule (verified against Eris UI)

A pool is active (earning rewards) when:

```
pool_pct_of_bucket = pool_vp / bucket_total_vp × 100 ≥ 1.0%
```

Verified empirically: chain-data + this rule produces exactly the same active-pool list as the Eris Liquidity Hub UI's "Active" tab.

---

## Architecture: consumer cron

This is the **only consumer** in the cron family. It reads:

1. `network-and-prices-data_2026/data/network-and-prices.json` — token prices + LST ratios
2. `bribes-data_2026/data/current-state.json` — active bribes
3. `bribes-data_2026/data/pd-bribes-history.json` — historical PD bribes
4. `votion-data_2026/votion/votion-epoch-{N}.json` — per-pool VP detail with lockup contributions
5. `astroport-pool-data_2026/astroport/astroport-epoch-{N}.json` — Astroport pool TVL, type, deprecated flag
6. `ss-pool-data_2026/day-{N}.csv` — SkeletonSwap pool TVL + reserves

Plus live chain queries (parallel):
- `gauge_infos` × 4 buckets (pool catalog + VP)
- `total_staked_balances` × 4 staking contracts (ampLP shares per pool)
- `distributions` × 1 (bucket reward allocations)
- `{pool: {}}` × N pools (LP reserves for health analysis)

Total runtime: ~30-60 seconds.

---

## Run locally

```bash
node tla-snapshot.js
```

Without `GITHUB_TOKEN`, saves to current directory.

---

## Render configuration

| Setting | Value |
|---|---|
| Type | Cron Job |
| Root Directory | `tla-snapshot` |
| Build Command | `npm install` |
| Command | `node tla-snapshot.js` |
| Schedule | `40 * * * *` (hourly at :40, aligned with network-and-prices) |

### Environment variables

```
GITHUB_TOKEN     # PAT with write scope on tla-snapshot-data_2026
GITHUB_REPO      # defipatriot/tla-snapshot-data_2026
GITHUB_BRANCH    # main
```

---

## Output

| File | Updated when | Purpose |
|---|---|---|
| `data/tla-snapshot.json` | Every hour | Latest unified snapshot the dashboard reads |
| `data/daily/YYYY-MM-DD.json` | Once per day at 23:xx UTC | Immutable end-of-day archive |

---

## Schema

See [`tla-snapshot-data_2026/README.md`](https://github.com/defipatriot/tla-snapshot-data_2026/blob/main/README.md) for the complete schema.

---

## Phase A scope (what's implemented now)

✅ All pool discovery via gauge_infos
✅ Pool classification (active / voted_but_below_threshold / deprecated / zero_vp)
✅ LP health: both-side asset amounts + USD via correct decimal handling
✅ ampLP price ratio per pool
✅ Bribe cross-reference (active + PD historical)
✅ Cross-reference with votion VP detail
✅ Top-level + per-bucket rollups

## Phase B (planned)

- [ ] Rewards/epoch math (LUNA emission rate × bucket allocation × pool % of bucket)
- [ ] APR / vAPR computation per pool
- [ ] Inactive Creda pool integration (Creda data not in standard gauge_infos)
- [ ] cw20 LP token name resolution for pools not in astroport-pool-data
