# nft-inventory

Captures full per-NFT state for the aDAO collection from on-chain truth. Replaces the dashboard's dependency on the third-party `deving.zone/nfts/alliance_daos.json` feed, which has known bugs (16 missing stakers, 54 stakers undercounted, DAODAO staking contract incorrectly listed as a 384-NFT user, no Atrium awareness).

**Data repo:** `defipatriot/nft-inventory-data_2026`
**Output path:** `data/v2/` (Rev B.2+) — the old `data/` folder is abandoned, see "Pre-Rev-B data" below
**Render schedule:** `30 * * * *` (hourly at :30)
**Runtime:** ~70 seconds per run

## What it does

Phase by phase:

1. **Enumerate** — `all_tokens{}` paginated on the NFT contract → ~10,000 token IDs
2. **Per-NFT info** — `all_nft_info{token_id}` for each NFT (concurrency 30) → owner, broken flag, rank, image, name
3. **Enterprise stakers** — `members{}` paginated on Enterprise NFT staking contract → per-user NFT counts
4. **Marketplaces** — `auction_by_contract` (BBL), `listings_by_collection` (Atrium), `launches` (Boost) → seller-resolved active listings
5. **DAODAO stakers** — `topStakers` endpoint on daodao.zone indexer → per-staker NFT counts (DAODAO contract has no enumerable list, indexer is canonical)
6. **Backing data** — ampLUNA balance of NFT contract → per-NFT share computation
7. **Price data** — fetches already-published prices from `network-and-prices-data_2026` and `tla-chain-registry` → USD conversions for listings and backing

Phases 3-7 run in parallel. Each is independently fallible — a failure in one (e.g., Atrium contract briefly unreachable) doesn't abort the others. The cron always ships SOMETHING, even if a sub-system is degraded.

## Per-NFT record schema (data/v2/nfts.json → records[i])

```jsonc
{
  "id": "5678",                            // token_id as string
  "owner": "terra1ej4cv98e...",            // raw cw721 owner (could be a marketplace/staking contract)
  "real_owner": "terra1v0k9r7c...",        // resolved seller (when listing exists) or same as owner
  "broken": false,                          // from nft_info.extension.attributes
  "rank": 1234,                             // null if not present
  "image": "ipfs://...",
  "name": "aDAO #5678",

  // Classification flags (mutually exclusive — exactly one is true)
  "unminted": false,                        // owner == DAO main wallet
  "treasury_held": false,                   // owner == treasury contract (898 all broken)
  "dao_wallet_8ywv_held": false,            // owner == small DAO wallet (2 broken)
  "enterprise_staked": false,               // owner == enterprise && !broken (real user stakes)
  "enterprise_dao_broken": false,           // owner == enterprise && broken (DAO control via stake)
  "daodao_staked": false,                   // owner == DAODAO staking contract
  "bbl_listed": true,                       // owner == BBL marketplace
  "atrium_listed": false,                   // owner == Atrium marketplace
  "boost_listed": false,                    // owner == Boost marketplace
  "user_held": false,                       // catchall (individual wallets)

  // Listing detail (populated when *_listed is true)
  "listing": {
    "marketplace": "BBL",
    "internal_id": "17753",
    "token_id": "5678",
    "seller": "terra1v0k9r7c...",
    "price_raw": "2200000000",
    "denom": "cw20:terra17aj4ty...",
    "price_token_symbol": "bLUNA",
    "price_token_decimals": 6,
    "price_display": "2,200 bLUNA",
    "price_amount": 2200,
    "price_usd": 1875.42,
    "price_usd_source": "sister-cron",
    "listing_type": "buy_now",
    "royalty_fee": "0.05",
    "creator_address": "terra1sffd4efk...",
    "raw": { /* original marketplace response */ }
  },

  // Backward-compat aliases (kept until dashboard fully migrated)
  "dao": false,                             // alias for unminted
  "daodao": false,                          // alias for daodao_staked
  "enterprise": false,                      // alias for treasury_held (NOT enterprise_staked!)
  "minted": true                            // alias for !unminted
}
```

## Output files

| File | Purpose | Update cadence |
|---|---|---|
| `data/v2/nfts.json` | Per-NFT records (canonical full state) | Every run (~6 MB) |
| `data/v2/summary.json` | Aggregates + stakers + marketplaces + backing | Every run |
| `data/v2/heartbeat.json` | Freshness contract + stats (`runMode` = full/warm/hot) | Every run |
| `data/v2/daily/<date>.json` | End-of-day snapshot (for movement/yield timeline) | Overwritten each run; last write of day wins |
| `data/v2/pending-claims.json` | DAODAO unstaked-but-unclaimed tracking (self-maintaining state) | Every run — cron adds/removes entries automatically |
| `data/v2/hot-set.json` | Token IDs the hot path polls (user-held + marketplace + pending) | Rebuilt on **full** runs only |

## Deployment (tiered modes — Rev C.1)

One script, three Render cron jobs, distinguished by the `RUN_MODE` env var. All three share the same repo, start command (`node nft-inventory.js`), `GITHUB_TOKEN`, and `GITHUB_REPO`. `RUN_MODE` defaults to `full`, so a job with no env set runs a full scan.

Roll out in this order (each step is safe on its own):

1. **Deploy the code.** The existing job (still hourly) runs `full` by default — behaves exactly as before, and now also writes `hot-set.json`. Confirm `hot-set.json` appears with ~1,100 token IDs before continuing.
2. **Repurpose the existing job as the weekly cold/full reconcile:** set its schedule to `0 2 * * 1` (Mon 02:00 UTC); `RUN_MODE` unset or `full`.
3. **Add the warm job:** schedule `10 0 * * *` (daily 00:10 UTC), env `RUN_MODE=warm`.
4. **Add the hot job:** schedule `*/15 * * * *` (every 15 min), env `RUN_MODE=hot`.

Notes:
- Hot/warm read the last full `nfts.json` as their base. If it (or `hot-set.json`) is missing/unreadable, they auto-fall-back to a full scan, so they're safe to enable even before the first scheduled full run.
- Hot rewrites the full `nfts.json` (~6 MB) every 15 min. That's deliberate (the page reads one merged file), but it means ~96 commits/day to the data repo. The `*-data_2026` yearly rotation bounds the growth; if churn becomes a problem, stage 1.5 can split a slim `hot.json` out and merge client-side.
- Stage 2 (activity deltas) and stage 3 (rollups) are not in this rev — daily files are still last-write-wins snapshots for now.


## Pre-Rev-B data (abandoned)

The `data/` folder (no `/v2/` subdir) contains pre-Rev-B output from when the cron had classification bugs (treasury mislabeled as enterprise, no Atrium awareness, no marketplace seller resolution, no backing data, etc.). **It's frozen as of 2026-06-07 and no longer updated.** Why we abandoned it instead of overwriting:

1. **Historical archaeology** — at some point in the original cron's lifetime a bug was introduced. Going back through the daily snapshots, we may be able to identify when (e.g., when did `enterprise_count` first start being treasury-conflated?). Pre-bug data may still be valid.
2. **Auditability** — the old data documents what the dashboard WAS showing. Useful to compare against the corrected data for any communications about why numbers changed.
3. **Forward-only history reset accepted** — Rev B.2 starts fresh. We've lost continuous history. That's the cost of correctness; trying to retroactively fix wrong data is a worse trade.

If you want to migrate or salvage pre-Rev-B data later, document the analysis in `cron-scripts/nft-inventory/README.md` under "Archaeology". Don't write to `data/` from the cron going forward.

## Critical contract addresses

| Role | Address |
|---|---|
| aDAO NFT collection | `terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9` |
| DAO main wallet (unminted) | `terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm` |
| DAO treasury contract | `terra1h8psjgcsg9fef7w2yv0j6262sfcaszj8vs4tsy3uwla6zwtaspvqrp4l7v` |
| DAO wallet 8ywv | `terra1yqv0af22675wlcmgflxk4ve07vt8qlm999gk0cuw5l64r5xxgadsyg8ywv` |
| Enterprise NFT staking | `terra1e54tcdyulrtslvf79htx4zntqntd4r550cg22sj24r6gfm0anrvq0y8tdv` |
| DAODAO staking | `terra1c57ur376szdv8rtes6sa9nst4k536dynunksu8tx5zu4z5u3am6qmvqx47` |
| BBL marketplace | `terra1ej4cv98e9g2zjefr5auf2nwtq4xl3dm7x0qml58yna2ml2hk595s7gccs9` |
| Atrium marketplace | `terra15du229lqcxkn939pmjgklqunftf604q4wz87kt5awj6reghec5jqs0w0kj` |
| Boost marketplace | `terra1kj7pasyahtugajx9qud02r5jqaf60mtm7g5v9utr94rmdfftx0vqspf4at` |
| ampLUNA (cw20) | `terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct` |

## NFT count breakdown (verified live 2026-06-07)

```
10,000 total
├─ 5,828 unminted    (DAO main wallet, all unbroken — verified 0 broken)
├─   898 treasury    (DAO treasury contract, all broken — governance control)
├─     2 dao_8ywv    (small DAO wallet, broken)
├─   100 enterprise_dao_broken  (Enterprise contract, broken — DAO gov)
├─   403 enterprise_staked      (Enterprise contract, unbroken — real user stakes)
├─ 1,661 daodao_staked         (DAODAO contract — of which ~65 are broken but
│                               kept staked for VP; breaking only forfeits
│                               FUTURE ampLUNA rewards, NFT + VP retained)
├─    43 bbl_listed
├─     1 atrium_listed
├─     4 boost_listed
└─ ~1,060 user_liquid           (individual wallets — of which ~28 are broken
                                 but kept by users for collection/VP)
```

**DAO-controlled NFTs:** unminted (5,828) + treasury (898) + 8ywv (2) + enterprise DAO broken (100) = **6,828 total** (5,828 unbroken + 1,000 broken).

**Important nuance on broken NFTs:** breaking an NFT (via `break_nft` execute) only forfeits future ampLUNA rewards from the daily Alliance reward stream. The owner keeps the NFT itself plus any voting power it confers. Some users break to claim their share and then re-stake the now-empty NFT on DAODAO for governance VP (65 NFTs in this state today). Some just hold them (28 in user wallets).

## Failure modes

| Failure | Impact | Behavior |
|---|---|---|
| LCD endpoint down | Cron retries on fallback LCD; if both fail, throws | `status: 'partial'` if capture rate < 99% |
| Marketplace query fails | That marketplace's listings missing from summary | Warning logged; cron continues |
| Enterprise members query fails | `enterprise_stakers[]` empty; per-NFT classification unaffected | Warning logged |
| DAODAO indexer down | `daodao_stakers[]` empty | Warning logged |
| ampLUNA balance query fails | `summary.backing = null` | Warning logged |
| Sister cron data unavailable | USD prices null; token amounts still shown | Warning logged |
| `total_power_at_height` query fails | Pending-claim count falls back to tracked (best-effort), `reconciled: null` | Warning logged |
| Pending-claim tx-search fails | Per-wallet attribution stale; count still chain-truth (`custody − total_power`) | Warning logged; scan height not advanced |

## Known gotchas

- **Marketplace overlap**: in rare cases an NFT could be relisted on a second marketplace without the first listing being cleaned up. The merge logic keeps the first-encountered listing and logs a warning. Token-level: chain says NFT is at marketplace #1, so that's the source of truth.
- **Boost schema variance**: Boost's `to_info` can be `{native: '...'}` (with optional `cw20:` prefix in the string) or `{cw20: '...'}`. `runtime` can be `nft` (direct sale) or `la` (launch agreement). Defensive parsing handles both.
- **DAODAO indexer freshness**: known to lag ~5-15 min behind chain. Per-NFT chain truth (Phase 2) catches movements that the indexer hasn't reflected yet.
- **Rewards query is misleading for broken NFTs**: the contract's `rewards{token_id}` returns non-zero values for already-broken NFTs that can't actually claim again. We do NOT use this query directly — we compute per-NFT backing from `treasury_balance / unbroken_count` which matches the contract's actual distribution math.
- **Pending-claims is seed-once, forward-only**: `data/v2/pending-claims.json` must be committed once (the seed) because public LCDs prune history — the cron can't reconstruct old unstakes. After that it self-maintains. Never delete it (you'd lose per-wallet attribution on whatever is unclaimed at that moment); but if it IS lost, nothing breaks — the count still computes live from `custody − total_power` and the cron rebuilds state by replaying tx-search from genesis on the next run. Claim parsing reads `transfer_nft` token_ids from the event log (not the empty `claim_nfts {}` message), and events are applied in block order, so a token unstaked → claimed → unstaked-again resolves correctly (this is the token-1319 case).
- **LCD tx-search must NOT use a `tx.height` range** (Rev B.6): publicnode rejects it with `400 "Please specify tx.height with strict equality"`. The query filters only on `wasm._contract_address` + `wasm.action`; height filtering is client-side. Because the query is unbounded by height, it re-fetches the full lifetime set each run (cheap today: a few dozen txs, one page). If lifetime unstake+claim txs ever exceed `MAX_PAGES × LIMIT` (1000), the ASC paging would return the OLDEST 1000 and miss the newest — switch `buildTxSearchUrl` to `ORDER_BY_DESC` and stop once `height <= minHeight` to fix. Not a concern for years at current unstake cadence.

## Rev history

- **Rev C.1 (2026-06-07)** — Tiered run modes (stage 1: mode infrastructure + hot-set). One script, three Render jobs, selected by `RUN_MODE` env (`full` default / `warm` / `hot`). Mode changes ONLY the per-NFT scope (Phase 1+2); Phases 3-7 (cheap aggregate queries) run identically, so every mode publishes a complete 10k `nfts.json`. **full** (weekly): enumerate + fetch all 10k, full reconcile, and (re)write `data/v2/hot-set.json` = the token IDs the hot path polls (user-held + marketplace-owned + pending-claim). **warm** (daily): re-fetch hot ∪ staked (~3.2k), merge onto the last full base. **hot** (every 15 min): re-fetch the hot set only (~1.1k), merge onto base. Hot/warm load the prior full `nfts.json` as the base and overlay freshly-fetched in-scope records via `mergeRecords`; if the base or hot-set is unreadable they **fall back to a full scan** so output is never partial. Default `full` means an unconfigured deploy behaves exactly as before (plus it now emits `hot-set.json`). Merge/derive logic unit-tested across all buckets (sale/delist/claim transitions, stable carry-through). Live hot/warm cadence verified on Render. Stage 2 (per-run activity deltas) and stage 3 (daily→weekly→monthly→yearly rollups) follow. See "Deployment (tiered modes)" below.
- **Rev B.7 (2026-06-07)** — Atrium listings schema-drift fix. Atrium's `listings_by_collection` query started 500'ing with `unknown field \`collection\`` (the variant is still valid; the contract upgraded and renamed the collection field). `fetchAtriumListings` now calls `resolveAtriumCollectionField()`, which probes the common CosmWasm field-name conventions (`collection_addr`, `nft_contract`, `collection_address`, `address`, `contract`, `contract_addr`, `cw721`, `collection`), memoizes the first the contract accepts, and reuses it for pagination. If none match, it logs the contract's full untruncated "expected one of …" list so the right name can be pinned in one follow-up. No regression: Atrium-held NFTs were already classified by cw721 ownership; this only restores price/seller detail on Atrium listings. Marketplace data layer only. NOTE: the live-accepted field name is confirmed on the Render run (sandbox can't reach the contract) — watch for the `ℹ Atrium collection field resolved to '…'` line.
- **Rev B.6 (2026-06-07)** — DAODAO pending-claim tx-search fix. The LCD began rejecting the tx-search query with `HTTP 400 "Please specify tx.height with strict equality"` because the query carried a `tx.height>${minHeight}` **range** condition, which publicnode's tx index no longer accepts. Fix: dropped the height term from the query (`buildTxSearchUrl` now filters only on `wasm._contract_address` + `wasm.action`) and moved height filtering **client-side** in `fetchDaodaoTxs` (`.filter(r => r.height > minHeight)`). The event set handed to the reducer is identical to before, so per-wallet attribution tracking is restored without changing `parseUnstakeTxs` / `parseClaimTxs` / `applyPendingEvents`. Before this, the count stayed correct (chain-truth) and `reconciled` flagged honestly, but forward attribution was frozen. Logic re-verified (genesis replay → [1319,3605,6847,7123]; incremental run no-ops; forward claim removes its token). Confirmed live: `lastScannedHeight` advanced 21353559 → 21355202 on first run. Bounded result set (a few dozen lifetime unstake/claim txs); if it ever exceeds ~1000 lifetime events, switch to DESC paging (see failure modes).
- **Rev B.5 (2026-06-07)** — USD pricing fix (was silently skipped). Two bugs: (1) both sister-cron URLs were wrong — corrected to `network-and-prices-data_2026/main/data/network-and-prices.json` and `tla-chain-registry/main/2026/current.json` (the old `data/current.json` paths 404'd); (2) `fetchPriceData` parsed an assumed schema that didn't match. Now reads LUNA from `token_prices.LUNA.final_price_usd` (fallback `luna_market.usd_price`), ampLUNA from `token_prices.ampLUNA.final_price_usd` (fallback `lst_ratios.ampLUNA.ratio × luna_usd`), and joins the registry token catalog (keyed by address → symbol + decimals) with `token_prices` (keyed by symbol → `final_price_usd`) so `decodeTokenDenom` finds prices by address as it expects. Verified live: LUNA $0.0512, ampLUNA $0.1103, → `treasury_value_usd` ≈ $86.8K, `per_nft_value_usd` ≈ $9.74 (all were null before). Marketplace listing USD now resolves for LUNA/USDC/ampLUNA/SOLID/CAPA denoms. Price layer only; classification/pending-claim/marketplace-pagination logic untouched.
- **Rev B.4 (2026-06-07)** — Marketplace pagination hardening (log-spam fix). `fetchBblListings` / `fetchAtriumListings` / `fetchBoostListings` now de-dupe by listing id as they collect and **break the page loop when a page contributes zero new ids**. Root cause: when a marketplace holds more than `MARKETPLACE_PAGE` (30) active listings, pagination kicks in, but `start_after: <last id>` wasn't advancing the window on BBL — so the same ~30 auctions were re-fetched up to the 100-page cap, flooding logs with `⚠ NFT #X listed on BOTH BBL and BBL` and wasting ~100 queries/run. Surfaced now because BBL active listings crossed 30 (currently 43); was latent before. Data was always correct (the merge keeps one listing per token, classification still sums to 10000) — this only removes the noise, the wasted queries, and the slow runs. Also fixed the merge warning to fire only on genuine **cross-marketplace** conflicts (e.g. BBL vs Atrium); same-marketplace duplicates are de-duped silently. Marketplace data layer only — pending-claim/classification logic untouched.


- **Rev B.3 (2026-06-07)** — DAODAO pending-claim tracking. Adds a post-aggregate reconciliation step that surfaces NFTs unstaked from DAODAO but not yet claimed back (they sit in the 7-day claim queue, or indefinitely if the owner forgets). The count is always chain-truth (`daodao_staked_count` custody − `total_power_at_height` active stake); per-wallet attribution is tracked forward by watching `unstake`/`claim_nfts` events via LCD tx-search, persisted in `data/v2/pending-claims.json`. Reconciliation flags drift (heartbeat `daodao_pending_reconciled`) but always renders the chain count — graceful degradation. Seeded once with 4 verified legacy forgotten-claims (tokens 1319, 3605, 6847, 7123); self-maintaining thereafter (claims/unstakes add and remove themselves, no manual edits). New: `summary.daodao_pending_claim` block, heartbeat `daodao_pending_claim` + `daodao_pending_reconciled`. Additive — no schema break.

- **Rev B.2 (2026-06-07)** — Clean-break path migration. Output moved from `data/` → `data/v2/`. Pre-Rev-B data abandoned (had classification bugs). History reset accepted as the cost of accurate data going forward. Old folder retained for archaeology — see "Pre-Rev-B data" section above.
- **Rev B.1 (2026-06-07)** — Polish micro-rev. Surfaced 3 metrics that were already classified internally but missing from heartbeat: `dao_wallet_8ywv_held` (the 2 broken NFTs at the small DAO wallet), `daodao_staked_broken` (NFTs broken-then-staked-on-DAODAO for VP), `user_held_broken` (broken NFTs kept in user wallets). Added `user_liquid_count` alias for `user_held_count` (clearer naming). No schema break — all new fields are additive. Console output now shows full breakdown during runs.
- **Rev B (2026-06-06)** — Major expansion: corrected treasury vs Enterprise classification, added all 3 marketplaces with seller resolution, added backing/yield, added Enterprise stakers, daily snapshots. Schema bumped to v2.
- **Rev A (2026-05-13)** — Initial deploy: per-NFT enumeration via `all_nft_info`, DAODAO stakers via indexer. Schema v1.
