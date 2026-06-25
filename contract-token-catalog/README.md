# Contract-Token-Catalog Cron

Sibling to the Address-Catalog. **Address-Catalog answers WHO; this answers WHAT
exists and HOW to query it.** Every TLA / NFT / governance / ratio contract with
its verified queries, every token with address + decimals + price source, and the
dynamic active/inactive/single LP set. Price / ratio / DEX / audit-tool / portfolio
crons READ this instead of hardcoding addresses.

## Output — `tla-core` repo, `contracts/` module
- `contracts/current.json` — full registry
- `contracts/heartbeat.json` — standard heartbeat

## Structure
- **`pools.{active,inactive,single}`** — DYNAMIC, harvested from `tla-snapshot` each run.
  Per pool: `dex`, `dex_contract` (pair), `pair_type`, `bucket`, `status`,
  `lp_nonamplified` (base LP), `lp_amplified` (per-pool amplified denom matched via asset_configs; null if not amplified), `pools.amplified_configs` (raw config truth),
  `gauge_pool_id`, `token_a`/`token_b` (symbol+address+decimals), `ratio`/`ratio_type`.
  This is the part that changes as TLA adds/removes pools.
- **`tokens`** — symbol → {type, address/denom, decimals, cgId, price.from}. `price.from`:
  `lp` (TLA reserve), `ratio` (base × hub exchange-rate), `stable` (~$1).
- **`ratio_hubs`** — LST/amp hubs + the exact query and ratio path.
- **`contracts`** — `tla`, `nft`, `governance`, `dao_cores` — each with verified queries.
- **`wallets`** — labeled wallets/custody for dropdowns + audit tool.
- **`future`** — Credia (lending) seeded, not wired.

## Adding things (curate the consts at the top)
- New token → one row in `TOKENS`.
- New ally/DEX/protocol → one entry. Credia (3rd venue) slots into `future` then `contracts` when wired.

## Render
Root dir `contract-token-catalog`, build `npm install`, command `node contract-token-catalog.js`,
schedule daily (`0 7 * * *`), env `GITHUB_TOKEN` + `GITHUB_REPO=defipatriot/tla-core`.
Without a token it writes `current.json`/`heartbeat.json` locally for inspection.

## Verified query → response shapes (the contract reference)

```
# TLA — capture-engine verified
gauge_controller  {user_info:{user,time:'next'}}        -> { slope, power, end, ... } voting power at time
gauge_controller  {user_pending_rebase:{user}}          -> rebase amount
voting_escrow     {all_tokens:{limit,start_after}}      -> { tokens:[token_id,...] }
voting_escrow     {owner_of:{token_id}}                 -> { owner, approvals:[] }
voting_escrow     {num_tokens:{}}                       -> { count }
voting_escrow     {lock_info:{token_id,time:'next'}}    -> { amount, coefficient, start, end, ... }
bribe_manager     {user_claimable:{user}}               -> { start, end, buckets:[...] }
asset_compounder  {asset_configs:{}}                    -> [ { gauge, asset:{cw20|native}, ... } ]
asset_compounder  {user_infos:{addr,assets}}            -> [ { total_lp, total_amplp, user_lp, user_amplp, ... } ]
staking[bucket]   {all_staked_balances:{address}}       -> [ { shares, total_shares, config:{yearly_take_rate, taken, ...} } ]
staking[bucket]   {all_pending_rewards:{address}}       -> [ { ... reward entries } ]

# Ratio hubs — network-and-prices verified
ampLUNA hub       {exchange_rates:{}}                   -> { exchange_rates:[[epoch,[ts,rate]],...] }  (use [0][1])
arb/b/ampCAPA/ampROAR {state:{}}                        -> { exchange_rate, total_*, ... }

# NFT — cw721 standard
adao_collection   {all_tokens|owner_of|num_tokens|nft_info|contract_info}

# Governance — gov tool verified
dao_core          {dump_state:{}}                       -> { voting_module, proposal_modules:[...], config }
proposal_module   {list_proposals:{start_after,limit}}  -> { proposals:[{id, proposal:{...}, status}] }
proposal_module   {proposal:{proposal_id}}              -> { id, proposal:{title, status, votes, ...} }
proposal_module   {list_votes:{proposal_id}}            -> { votes:[{voter, vote, power}] }
voting_module     daoVotingCw721Staked/topStakers       -> [ { address, count, votingPowerPercent } ] (indexer)

# Credia (future, lending) — RPC abci_query
credia.metrics    {metrics:{}}                          -> { total_supplied_usd, total_borrowed_usd, total_collateral_usd, total_reserves_usd, assets:[{info:{cw20}}] }
```

## Recent changes
- **1.0.0** — initial. Dynamic active/inactive/single LP discovery from tla-snapshot
  (+ asset_configs for amplified denoms); static registry of TLA/ratio/NFT/governance
  contracts, tokens, wallets; Credia seeded as a future lending protocol. Addresses +
  queries harvested from verified production code and HAR decodes.
