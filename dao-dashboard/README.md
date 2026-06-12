# dao-dashboard — DAO dashboard aggregates cron

Successor to the dead "TLA Admin Core v3" epoch cron (last file: epoch 185,
2026-05-17). Emits the DAO-specific aggregates that `index.html`'s tiles
consume, in a legacy-v3-compatible shape, so the dashboard stops being
frozen at epoch-185 values.

## What it writes

`data/dao-dashboard.json` in **tla-snapshot-data_2026** (shared with the TLA
snapshot cron — precedent: tla-vp-holders also writes a subpath there).

```
{ meta: { version, epoch, phase:'live', generated_at, source, status: ok|partial, errors[] },
  dashboard: {
    unclaimed_rewards: { ampLUNA, zAssets, deposit_rewards_usd, deposit_luna_equivalent },
    vote_rewards:      { by_token: {SYM:{amount,price,usd}}, periods:[epochs], total_usd },
    rebase:            { ampLUNA, usd },
    tla_deposits:      { total_usd, lp_usd, zluna_usd, tokens:[{symbol,amount,price,usd}],
                         composition:'lp_underlying+zluna' },
    alliances:         { lion_dao: { description, established,
                         chain_staking:{ validators:[{name,address,staked_luna,
                         unclaimed_rewards_luna}], staking_apr_pct?, staking_apr_date? } } } },
  token_prices: { SYM: usd } }
```

## Consumer contract (index.html, verified 2026-06-12)

- `updateUnclaimedRewardsTile` reads `dashboard.unclaimed_rewards.{ampLUNA,zAssets}`,
  `dashboard.vote_rewards.{by_token,periods}`, `dashboard.rebase.ampLUNA` and
  **recomputes USD with live prices** — so amounts are the durable fields here.
- `buildTlaDeposits` reads `dashboard.tla_deposits.{total_usd,tokens[]}` with
  tokens `{symbol, amount, price, usd}` and `meta.generated_at` + `token_prices`.
- `loadLionDaoAlliance` reads `dashboard.alliances.lion_dao` incl.
  `chain_staking.staking_apr_pct/_date`.
- `fetchTlaData` (the loader) tries this file FIRST and accepts it only when
  `meta.generated_at` is **< 26h old** — a stale emitter falls back to the
  legacy epoch walk-back with its honest staleness pill. Don't "fix" a stuck
  run by hand-editing generated_at.

## Data sources

| What | Source |
|---|---|
| Deposit rewards (zLUNA→LUNA) | `all_pending_rewards` × 4 buckets + zLUNA connector `state` rates |
| Rebase | gauge controller `user_pending_rebase` |
| Vote rewards | bribe manager `user_claimable` (amount may be at claim top level **or nested in `asset`** — parser handles both; this was a live bug caught in fixture testing) |
| TLA deposits | `all_staked_balances` + amp `user_infos` per bucket; positions valued via tla-snapshot pool data; underlying token split via `lp_health` composition scaled by position share; zLUNA bank balances added as their own row |
| Lion DAO | LCD staking delegations + distribution rewards filtered to the Lion validator; APR from legacy `Staking APR.csv` (optional) |
| Prices / ampLUNA ratio | network-and-prices cron (`final_price_usd`, `lst_ratios.ampLUNA.ratio`) |

## House rules honored

- **Good data or no data**: sections build independently; failures emit `null`
  + `meta.errors` (consumers have their own fallbacks). If BOTH headline
  sections (deposits + unclaimed) fail, the run exits 1 **without publishing**.
- **No silent coercions**: chain nulls are retried (primary ×2 → fallback LCD)
  and surfaced as section errors, never coerced to `[]`.
- Unknown bribe tokens get a short-address symbol with price 0 — honest-unknown,
  rendered as-is by the tile.

## Deploy (Render) — two options

**Option A (recommended): chain into the existing tla-snapshot job.**
No new Render job. Edit the tla-snapshot cron's start command to:

    node tla-snapshot.js && node ../dao-dashboard/dao-dashboard.js

That's the only change — Root Directory stays `tla-snapshot` (Render clones
the full repo, so the sibling path resolves), schedule stays as-is, and
`GITHUB_TOKEN` is already set on that job. Sequential execution means zero
LCD rate-limit contention (better than two offset jobs). `&&` semantics:
if the snapshot run fails the job goes red (you want that alarm) and
dao-dashboard skips one hour — the consumer's 26h freshness gate shrugs
that off. The script cache-busts its snapshot fetch so it reads the
just-pushed file, not the CDN's stale copy.

**Option B: its own cron job** (if you prefer isolated logs/alerting).
1. New Cron Job → repo `defipatriot/cron-scripts`, root dir `dao-dashboard`.
2. Build: `npm install` (no-op, zero deps) · Command: `node dao-dashboard.js`
3. Schedule: `20 * * * *` (offset from tla-snapshot's :40 so concurrent
   runs never contend for LCD rate limits).
4. Env: `GITHUB_TOKEN` (same PAT as the other crons). `GITHUB_REPO`/`GITHUB_BRANCH`
   default to `defipatriot/tla-snapshot-data_2026` / `main`.

Either way, first-run verification: trigger manually, then check
   `data/dao-dashboard.json` has `meta.status: "ok"` and sane values
   (deposit LUNA-eq in the ~1,500–2,000 range, rebase ~70+ ampLUNA as of
   June 2026); load the dashboard — the rewards card should drop its
   "Stale Data" pill and the console logs `Loaded dao-dashboard cron data`.

`--dry` flag builds and prints without pushing.

## Recent changes

- **2026-06-12 — v1.0.** Initial version. Ports the query logic from
  `lib/adao-live-data.js` (the dashboard's live layer) server-side.
  Fixture-tested transforms (`aggregateDeposits`, `aggregateUnclaimed`)
  against real tla-snapshot/network-and-prices shapes; caught and fixed the
  nested-`asset.amount` bribe-claim form before first deploy. Deployed
  chained into the tla-snapshot Render job (Option A); source fetches
  cache-busted so chained runs read the just-pushed snapshot.
