# nft-inventory

Captures full per-NFT state for the aDAO collection from on-chain truth. Replaces the dashboard's dependency on the third-party `deving.zone/nfts/alliance_daos.json` feed, which has known bugs (16 missing stakers, 54 stakers undercounted, DAODAO staking contract incorrectly listed as a 384-NFT user, no Atrium awareness).

**Data repo:** `defipatriot/nft-inventory-data_2026`
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

## Per-NFT record schema (data/nfts.json → records[i])

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
| `data/nfts.json` | Per-NFT records (canonical full state) | Every run (~2.5 MB) |
| `data/summary.json` | Aggregates + stakers + marketplaces + backing | Every run |
| `data/heartbeat.json` | Freshness contract + stats | Every run |
| `data/daily/<date>.json` | End-of-day snapshot (for movement/yield timeline) | Overwritten each run; last write of day wins |

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

## NFT count breakdown (verified live 2026-06-06)

```
10,000 total
├─ 5,828 unminted    (DAO main wallet, all unbroken)
├─   898 treasury    (DAO treasury contract, all broken — governance control)
├─     2 dao_8ywv    (small DAO wallet, broken)
├─   100 enterprise_dao_broken  (Enterprise contract, broken — DAO gov)
├─   403 enterprise_staked      (Enterprise contract, unbroken — real user stakes)
├─ 1,661 daodao_staked         (DAODAO contract — has indexer for per-user attribution)
├─    43 bbl_listed
├─     1 atrium_listed
├─     4 boost_listed
└─ ~1,060 user_held              (individual wallets, liquid)
```

## Failure modes

| Failure | Impact | Behavior |
|---|---|---|
| LCD endpoint down | Cron retries on fallback LCD; if both fail, throws | `status: 'partial'` if capture rate < 99% |
| Marketplace query fails | That marketplace's listings missing from summary | Warning logged; cron continues |
| Enterprise members query fails | `enterprise_stakers[]` empty; per-NFT classification unaffected | Warning logged |
| DAODAO indexer down | `daodao_stakers[]` empty | Warning logged |
| ampLUNA balance query fails | `summary.backing = null` | Warning logged |
| Sister cron data unavailable | USD prices null; token amounts still shown | Warning logged |

## Known gotchas

- **Marketplace overlap**: in rare cases an NFT could be relisted on a second marketplace without the first listing being cleaned up. The merge logic keeps the first-encountered listing and logs a warning. Token-level: chain says NFT is at marketplace #1, so that's the source of truth.
- **Boost schema variance**: Boost's `to_info` can be `{native: '...'}` (with optional `cw20:` prefix in the string) or `{cw20: '...'}`. `runtime` can be `nft` (direct sale) or `la` (launch agreement). Defensive parsing handles both.
- **DAODAO indexer freshness**: known to lag ~5-15 min behind chain. Per-NFT chain truth (Phase 2) catches movements that the indexer hasn't reflected yet.
- **Rewards query is misleading for broken NFTs**: the contract's `rewards{token_id}` returns non-zero values for already-broken NFTs that can't actually claim again. We do NOT use this query directly — we compute per-NFT backing from `treasury_balance / unbroken_count` which matches the contract's actual distribution math.

## Rev history

- **Rev B (2026-06-06)** — Major expansion: corrected treasury vs Enterprise classification, added all 3 marketplaces with seller resolution, added backing/yield, added Enterprise stakers, daily snapshots. Schema bumped to v2.
- **Rev A (2026-05-13)** — Initial deploy: per-NFT enumeration via `all_nft_info`, DAODAO stakers via indexer. Schema v1.
