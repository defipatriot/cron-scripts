# NFT Inventory Cron

Hourly on-chain snapshot of the aDAO NFT collection. Replaces the dashboard's third-party dependency on `deving.zone/nfts/alliance_daos.json` with a chain-of-truth feed.

**Data store:** [`defipatriot/nft-inventory-data_2026`](https://github.com/defipatriot/nft-inventory-data_2026)

---

## What it captures

For every NFT in the aDAO collection (currently 10,000 tokens):

- **`id`** — token_id as a string
- **`owner`** — current on-chain owner address
- **`broken`** — boolean derived from `extension.attributes` `broken` trait
- **`rank`** — Rarity attribute (numeric)
- **`image`** — IPFS URL from extension
- **`name`** — full NFT name from extension
- **Classification booleans** (derived from owner):
  - `dao` — held by DAO main wallet (= unminted)
  - `minted` — !dao
  - `daodao` — held by DAODAO staking contract
  - `enterprise` — held by Enterprise treasury

Plus aggregate counts and per-owner breakdowns in `summary.json` for the dashboard's tiles.

---

## Output files

| File | Size | Purpose |
|---|---|---|
| `data/nfts.json` | ~2.8 MB | Per-NFT records (full inventory) |
| `data/summary.json` | ~20 KB | Aggregate counts + per-owner table (dashboard reads this for tiles) |
| `data/heartbeat.json` | ~500 B | Uniform freshness contract |

---

## Schedule

Cron: `30 * * * *` (every hour at :30, before all other crons at :35–:55)

Runtime: ~50 seconds typical (10k chain queries at concurrency 30)

---

## Why this cron exists

The dashboard's tiles (mint status, broken status, DAODAO staked, Enterprise staked, DAO members, supply breakdown) all depended on `deving.zone/nfts/alliance_daos.json` — a third-party feed. If deving.zone goes down or changes schema, half the dashboard breaks.

This cron replaces that dependency with chain-of-truth data and adds operational guarantees:

1. **Single source of failure removed** — no longer dependent on deving.zone
2. **Predictable freshness** — heartbeat tells the dashboard exactly how stale the data is
3. **CDN-served** — once per hour from GitHub raw, then every dashboard view is a CDN hit

---

## Discovery sources

| Source | What it provides |
|---|---|
| Terra LCD (`terra-lcd.publicnode.com`) | `num_tokens`, `all_tokens` (paginated), `all_nft_info` per token |
| Terra LCD fallback (`terra-rest.publicnode.com`) | Same queries if primary is down |
| daodao.zone indexer | DAODAO staker list (for Phase 4 modal breakdown) — non-fatal if unreachable |

---

## Render setup

| Setting | Value |
|---|---|
| Name | `nft-inventory` |
| Root Directory | `nft-inventory` |
| Build Command | `npm install` |
| Command | `node nft-inventory.js` |
| Schedule | `30 * * * *` |
| Env vars | `GITHUB_TOKEN`, `GITHUB_REPO=defipatriot/nft-inventory-data_2026`, `GITHUB_BRANCH=main` |

---

## Sanity checks the cron runs

- `Phase 1` cross-checks: `enumerated count` vs `num_tokens.count` (warns on mismatch)
- `Phase 2` reports `capture_rate` (fraction of NFTs successfully queried). Status becomes `'partial'` if <99%.
- `Phase 4` failure is non-fatal — summary aggregates already capture all the COUNTS the dashboard needs; the staker list is a UX bonus for the modal.

---

## Companion cron

The `marketplace-stats` cron handles BBL/Boost marketplace data (floor prices, listings, recent sales). These two crons are deliberately independent — if BBL API is down, `nft-inventory` still updates, and vice versa. Consumers (dashboard JS) merge the two outputs.
