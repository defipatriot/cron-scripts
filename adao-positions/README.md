# aDAO Positions Cron

Weekly cron that captures full TLA (Terra Liquidity Alliance) portfolio data for every named member of aDAO. Powers the dashboard's per-member "portfolio tracker" views, lock adjustment opportunities, pool status alerts, and epoch-over-epoch performance charts.

## What it captures

For each named DAO member, every Monday at 01:00 UTC:

- **LP positions** — both non-amplified (raw stake) and amplified (compounded via Eris's asset-compounder), with USD valuation, underlying token amounts, and pool status flags
- **Locks** — every voting-escrow NFT with the user's deposited assets, voting power, and a projection of what the lock would be worth if adjusted today (captures the LST-ratio drift opportunity)
- **Votes** — current epoch vote allocations per bucket
- **Pending rewards** — unclaimed zluna per pool
- **Pending rebase** — gauge controller rebase rewards
- **Pending bribes** — claimable bribes with USD pricing
- **Wallet balances** — TLA-relevant tokens (LUNA, ampLUNA, bLUNA, zluna, etc.)

The cron writes three files per run: a light member list, a heavy portfolio file with all 46 named members, and a frozen weekly archive named by epoch number.

## Architecture

### Member discovery — self-updating, 3-tier resilience

1. **Primary**: `indexer.daodao.zone` topStakers endpoint returns all 157 current DAO members with their NFT counts and voting power percentages
2. **Names**: `pfpk.daodao.zone` profile lookup per address (uses bech32-decoded hex hashes). Bech32 decoder is pure-JS, no external deps
3. **Fallback 1**: `github.com/defipatriot/adao_json_storage/main/members.csv` — the manual member CSV that DefiPatriot maintains
4. **Fallback 2**: The cron's own previous run output at `data/members.json` — used if both daodao.zone and the CSV are unreachable

If a new member registers a name on daodao.zone, the next cron run picks them up automatically — no manual CSV updates needed. The CSV remains a safety net.

### Data dependencies

The cron reads two existing data files for shared state:

- `tla-snapshot-data_2026/data/tla-snapshot.json` — pool catalog, prices, distributions, LST data
- `network-and-prices-data_2026/data/network-and-prices.json` — token prices and LST ratios

These are loaded at start; if either is unavailable the cron aborts with a clear error.

### Per-member queries

Each named member's portfolio requires ~14-20 chain queries depending on lock count:

- 4× `all_staked_balances` (one per bucket staking contract) — non-amplified LP + xASTRO
- 4× `all_pending_rewards` (one per bucket) — pending zluna per pool
- 4× `user_infos` on asset-compounder (one per bucket, batched [gauge, asset] tuples) — amplified positions
- 1× `user_info` on gauge controller — vote allocations
- 1× `user_pending_rebase` — gauge rebase rewards
- 1× `tokens` on voting-escrow — list of lock NFT IDs
- N× `lock_info` per lock — full lock details
- 1× `user_claimable` on bribe-manager — pending bribes
- 1× bank balances via Cosmos REST — wallet tokens

Total per run: ~1140 queries, ~3-5 minutes with parallelism (15 concurrent).

### Key computed insights

**Lock VP projection** — for each LST lock (ampLUNA, bLUNA, arbLUNA, stLUNA), the cron computes what the user's voting power would be if they adjusted the lock today using current LST ratios. This surfaces the "adjust for free VP" opportunity that occurs as LSTs accrue staking yield.

**Pool status flagging** — each LP position is tagged `active` / `at_risk` / `inactive` based on the pool's percentage of bucket voting power (active ≥1.5%, at-risk 1.0-1.5%, inactive <1.0%). Members with at-risk or inactive LP positions show up in alert lists.

**Amplification distinction** — every LP position carries an explicit `is_amplified` flag and `source` field (`staking_contract` vs `asset_compounder`). The Eris UI shows amplified positions with a flame icon; the cron data lets the dashboard reproduce that distinction.

**Token amount vs USD separation** — each underlying token in an LP position has both `amount_human` (raw token count) and `usd_value` separately. Weekly archives let the dashboard chart "token amounts going up" (compounded fees) versus "USD value going down" (price drops) as separate axes.

## Output schema

### `data/members.json` (~26 KB)

Lightweight metadata for all 157 members (named + unnamed). Used by the dashboard to show member rosters and for cross-cron member counts.

```json
{
  "schemaVersion": 1,
  "capturedAt": "2026-05-19T01:00:00Z",
  "epoch": { "number": 184, "starts_at": "...", "ends_at": "...", "progress_pct": 0.5 },
  "primary_source": "daodao_indexer",
  "total_members": 157,
  "named_count": 46,
  "unnamed_count": 111,
  "members": [
    {
      "address": "terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw",
      "name": "DeFi_Patriot",
      "nft_count": 291,
      "vp_pct_of_dao": 17.44,
      "nft_image_url": "ipfs://Qm...",
      "has_pfpk_profile": true
    }
  ]
}
```

### `data/current.json` (~170 KB)

Full portfolios for all named members. Rewritten every run; the dashboard reads this for current-state views.

Key fields per member:

- `summary` — rollup of all VP, USD, lock counts, position counts
- `voting` — current epoch vote allocations per bucket
- `vp_per_pool` — user's VP share in each pool they voted for
- `locks[]` — each lock with `projection` showing potential VP gain if adjusted
- `lp_positions[]` — both staking-contract (raw) and asset-compounder (amplified) positions
- `pending_rewards[]` — unclaimed zluna per pool
- `pending_rebase` — gauge controller rebase
- `pending_bribes[]` — claimable bribes with USD pricing
- `wallet_balances[]` — TLA-relevant token balances

### `data/weekly/epoch-{N}.json` (~170 KB each)

Frozen archive of `current.json` named by the epoch number at capture time. These accumulate over time and enable epoch-over-epoch dashboard charts.

### `data/daily/{YYYY-MM-DD}.json` (~170 KB each)

Added 2026-05-17 to support the Portfolio Tracker dashboard. Same payload as `current.json` but named by capture date. If the cron runs multiple times per day, the file is overwritten — the daily file always reflects the most recent capture of that calendar day, which is what's wanted for daily P&L computation.

Required for Portfolio Tracker time-series (member position value over days, fee accrual trends, "is this position actually growing"). The weekly archive above is too coarse for intra-epoch position changes.

## Configuration

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GITHUB_TOKEN` | yes | — | GitHub PAT with write access to the data repo |
| `GITHUB_REPO` | no | `defipatriot/adao-positions-data_2026` | Target data repo |
| `GITHUB_BRANCH` | no | `main` | Target branch |

If `GITHUB_TOKEN` is unset, the cron writes files locally to the working directory instead of publishing (useful for development).

### Schedule

Cron string: `0 1 * * 1` (Mondays 01:00 UTC) — historical default.

This places the run ~1 hour after the TLA epoch boundary (epochs start Monday 00:00 UTC), capturing the just-settled state after rewards distribute and gauge votes flip to the new period.

**⚠ Schedule consideration (2026-05-17)**: For the Portfolio Tracker dashboard to function, this cron needs to run **at least daily**, not weekly. The weekly cadence above produces only one snapshot every 7 days, which is too coarse for member position time-series. Recommended cron string for daily: `0 1 * * *` (every day at 01:00 UTC). When changing the schedule, also update `next_expected_run_at` in the heartbeat code (currently set to 7 days; change to 25 hours for daily, 75 minutes for hourly).

The cron is spaced from other crons in the system:
- `votion`: Sun 23:55 UTC (weekly)
- `bribes-history`: Daily 23:35 UTC
- `tla-snapshot`: Hourly :40
- `adao-positions`: **01:00 UTC** (currently weekly Mon, should be daily)

### Node.js version

Requires Node.js 18+ for native `fetch`. No external npm dependencies — the cron uses only built-in modules (`https`, `fs`, `Buffer`).

## Deployment (Render)

1. Create a new "Cron Job" service on Render pointing at the `cron-scripts` repo
2. Set:
   - **Schedule**: `0 1 * * 1`
   - **Command**: `node adao-positions/adao-positions.js`
   - **Build command**: (none — no dependencies)
3. Add environment variables `GITHUB_TOKEN` and `GITHUB_REPO`

The first run will create `data/current.json`, `data/members.json`, and `data/weekly/epoch-{N}.json` in the data repo. Subsequent runs append a new epoch file each Monday.

## Failure modes

The cron is designed to fail gracefully:

- **daodao.zone indexer down** → falls back to GitHub CSV → falls back to self-cached `members.json`. Never aborts on member discovery alone
- **pfpk.daodao.zone unreachable** → uses names from fallback CSV; logs members with missing names
- **tla-snapshot.json or network-and-prices.json missing** → aborts with clear error message. These are hard dependencies
- **One member's queries fail** → that member's portfolio gets a `_errors` field; other members continue. Run logs the count of successful captures
- **Asset-compounder query errors** → that bucket's amplified positions are missed but other data still captures. The member appears with non-amplified data only
- **GitHub publish fails** → cron exits non-zero; Render will surface the failure. Next run retries cleanly

## Maintenance notes

### When new amplified pools are added

The asset-compounder is queried for its `asset_configs` at the start of each run, so newly added amplified pools are automatically picked up. No manual update needed.

### When a member changes their name

The pfpk lookup runs every cron. Name changes propagate to the next run automatically.

### Member CSV updates

The CSV at `github.com/defipatriot/adao_json_storage/main/members.csv` is now a **fallback only**. The primary source is daodao.zone. The CSV doesn't need to be updated as new members register — but keeping it reasonably current is good insurance for daodao.zone outages.

### Schema versioning

The current schema is `schemaVersion: 1`. If breaking changes are needed, increment the version and document the migration. The dashboard should read `schemaVersion` before consuming.

## Implementation notes

- All chain queries have a 25-second timeout with automatic fallback to a secondary LCD endpoint
- Concurrency is capped at 15 parallel requests to avoid overwhelming the LCD
- Bech32 decoding is implemented inline (BIP-173 reference algorithm), no `bech32` npm package required
- Lock VP projections use LST ratios from `network-and-prices.json` rather than re-querying LST hubs
- Pool USD valuations for amplified positions use `user_lp / pool.lp_health.total_share × pool.depth_usd` (Eris's formula)
- Bribe USD pricing falls back through three paths: direct token price lookup, LST-ratio-derived price, then null (unpriced)

## Recent changes

### 2026-05-17 — Daily archive added for Portfolio Tracker history

- **Added** `data/daily/YYYY-MM-DD.json` archive — same payload as `current.json` but named by capture date. If the cron runs multiple times per day, the daily file is overwritten (last run of the calendar day wins).
- **Cleaned up** heartbeat: `runMode` field changed from hardcoded `'weekly'` to `'scheduled'` (the actual cadence is determined by Render's cron expression, not the script).
- **⚠ Action required**: this cron is currently scheduled WEEKLY on Render (`0 1 * * 1`). For the Portfolio Tracker dashboard to accumulate meaningful history, it needs to be DAILY (`0 1 * * *`). When changing the Render schedule, also update the `next_expected_run_at` constant in the script (currently 7 days; change to 25 hours for daily).
- Rationale: Portfolio Tracker needs daily snapshots to compute P&L, fee accrual, and "is my position growing" answers. The weekly per-epoch archive is too coarse (7 days between snapshots).
