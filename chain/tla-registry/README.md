# tla-registry (cron source) — v2.0

**Layer 0 of the TLA chain-native data pipeline.**
Now produces a full ecosystem catalog (tokens + contracts + wallets +
acquisition guides) by merging chain queries + external registries + curated data.

This is the script source. It writes its output to:
`defipatriot/tla-chain-registry/2026/`.

> **Naming note:** the source folder is `chain/tla-registry/` (short) but the
> data repo is `tla-chain-registry` (descriptive). Folder and repo names
> deliberately differ.

## What it does

Reads from THREE kinds of sources, merges by Terra address, publishes a unified catalog.

### Chain queries (Q1-Q6)

| # | Contract | Query | Purpose |
|---|---|---|---|
| 1 | global-config | `all_addresses` | Master contract directory (bootstrap) |
| 2 | asset-gauge | `distributions` | Pool registry (gauge_pool_id, bucket, share %) |
| 3 | asset-gauge | `last_distribution_period` | Canonical current epoch |
| 4 | asset-gauge | `config` | Gauge list, global_config_addr, rebase asset |
| 5 | voting-escrow | `num_tokens` | Sanity ping |
| 6 | asset-compounder | `asset_configs` | amplp ↔ LP mapping (NEW in v2) |

Only the global-config address is hardcoded. Everything else discovered.

### External sources (each optional)

If any single one fails, the catalog still publishes using the rest. Status becomes `partial`.

- **Cosmos Chain Registry** (`raw.githubusercontent.com/cosmos/chain-registry`) — 58 Terra2 assets with CoinGecko IDs, IBC traces, decimals
- **Eris prices** (`backend.erisprotocol.com/prices`) — canonical display names
- **Astroport REST** (`app.astroport.fi/api/pools`)
- **Skeleton Swap** (`dex.warlock.backbonelabs.io/api/pools/phoenix-1`)

### Curated files (in the same data repo, edit via GitHub UI)

The cron pulls these from `defipatriot/tla-chain-registry/curated/` each run:

- `categories.json` — taxonomy
- `wallets.json` — known wallet labels
- `protocols.json` — protocol metadata
- `known_contracts.json` — contract labels (seeded from aDAO registry)
- `token_overrides.json` — display name preferences
- `acquisition_guides.json` — how to safely acquire each token

See `defipatriot/tla-chain-registry/curated/README.md` for the editing guide.

## Output schema (`current.json` v2)

```jsonc
{
  "schemaVersion": 2,
  "canonicalEpoch": 187,

  // Chain-derived
  "directory": { "ASSET_GAUGE": "terra1...", ... },
  "pools": [ {gauge_pool_id, bucket, distribution_pct, ...} ],
  "buckets": {...},

  // Catalog
  "tokens": {
    "<terra_address>": {
      "address", "type", "category", "subtype",
      "symbol", "display_name", "decimals",
      "coingecko_id", "coingecko_match",
      "sources": { cosmos_chain_registry, eris, astroport, skeletonswap },
      "bridge": { source_chain, original_denom, channel_id, via },
      "appears_in": { tla_pools_count, tla_pools, is_lockable, is_amplp_underlying },
      "wallet_import": { symbol, name, decimals, address },
      "scoring": { confusion_score, flags },
      "override": null,                  // from token_overrides.json
      "acquisition": null,               // from acquisition_guides.json
      "related_variants": []             // other token addrs sharing base symbol
    }
  },
  "amplp_mappings": { "<amplp_denom>": { underlying_lp_address, bucket, ... } },
  "lp_to_amplp": { "<lp>": "<amplp_denom>" },
  "contracts_catalog": { "<addr>": { label, protocol, category, subtype, source } },
  "wallets_catalog":   { "<addr>": { label, subtype, ... } },
  "protocols": {...},
  "categories": {...},

  // Worklist
  "_unmapped": { tokens: [...], contracts: [], wallets: [] },

  // Raw chain responses preserved
  "raw": {...}
}
```

## Deploy on Render

| Field | Value |
|---|---|
| Service type | Cron Job |
| Name | `tla-registry-v2` |
| Region | Oregon (matches other crons) |
| Schedule | `5 0 * * *` (daily 00:05 UTC) |
| Source repo | `defipatriot/cron-scripts` |
| Root directory | `chain/tla-registry` |
| Build command | `npm install` |
| Start command | `node tla-registry.js` |

### Env vars (required)

| Var | Value |
|---|---|
| `GITHUB_TOKEN` | Token with write access to `defipatriot/tla-chain-registry` |
| `GITHUB_REPO` | `defipatriot/tla-chain-registry` |

### Env vars (optional, defaults baked in)

| Var | Default |
|---|---|
| `GITHUB_BRANCH` | `main` |
| `TERRA_LCD_PRIMARY` | `https://terra-lcd.publicnode.com` |
| `TERRA_LCD_FALLBACK` | `https://terra-rest.publicnode.com` |
| `GLOBAL_CONFIG_ADDR` | `terra1hwxg6s732eparz3ys7sa4t5f64ngpd2w8syrca6z7ckv3fs9uqnsvrpcqa` |

## Local test

```bash
# Without GITHUB_TOKEN, prints summary instead of pushing
node tla-registry.js
```

## Failure modes

- **Both LCDs unreachable** → exit 1, no GitHub write, old snapshot stays.
- **Watchdog (5 min ceiling)** → exit 2.
- **External source fails** (chain-registry / Eris / Astroport / SS) → recorded in `source_errors`, snapshot still publishes with remaining sources, status=`partial`.
- **Missing curated file** → cron continues without it.
- **`global-config.all_addresses` returns null** → fatal; can't proceed.

## Why this design

Per `CRON-FIXES-BRIEF` Parts 5.1 + 5.0:
- Layer 0 = discovery / bootstrap / catalog (this).
- Layer 1 = pricing (next session).
- Layer 2 = entities (pools reserves, locks, staking).
- Layer 3 = participants.
- Layer 4 = rollups.

**Address-first** identity is non-negotiable: the wBTC.atom vs wBTC.axl
case proves that names lie but addresses don't. Names from sources
become metadata; the catalog primary key is always the Terra address.

**Catalog merging is layered**: chain registry → Eris → Astroport → SS →
pool participation → amplp → curated overrides → acquisition guides →
scoring. Each stage non-destructively augments. Eris wins on display name.

## Future siblings

```
cron-scripts/chain/
├── tla-registry/      ← Layer 0 (this) — discovery + catalog
├── tla-pricing/       ← Layer 1 — multi-source token prices
├── tla-pools/         ← Layer 2 — pool entities (reserves, APR)
├── tla-participants/  ← Layer 3 — voter/locker/staker enumeration
└── tla-rollups/       ← Layer 4 — pure functions of 0-3
```

## Recent changes

Authoritative Rev-by-Rev log is at `defipatriot/website-adao-core/catalog-log.md`. Brief summary of the last several:

- **Rev 0.16 (2026-06-06)** — Phase 0 lock-in. 5 polish fixes: Eris vault no longer labeled as DEX; `pair_type` normalized to canonical names; `queryContract` recognizes definitional failures (no retry/warn for "unknown variant" / "not supported query"); SS source synthesis for tokens missing from SS API; freshness fingerprint expanded to include architecture data.
- **Rev 0.15 (2026-06-06)** — Critical fix: contract architecture via cw2 **raw storage** query (`/raw/contract_info`) instead of broken `{contract_version: {}}` smart query. New helper `queryContractRaw()`. Result: 0 → 72 pools with full architecture; ~140 fewer error lines per run; runtime 120s → 77s. Also: SS indexer correction (relocate mislabeled denoms), avatar defensive ungating, curation candidates file.
- **Rev 0.14 (2026-06-05)** — Pool architecture surfacing. Every pool gets `architecture: {pair_address, pair_type, contract, version, dex}` object. Closes the last major Phase 0 data gap.
- **Rev 0.13 (2026-06-05)** — Wallet enrichment fully wired. 668/668 wallets get a meaningful `headline_name` (curated > PFPK > "{DAO} member" synthesized).
- **Rev 0.12.x (2026-06-05)** — Token logo system (3-layer: curated > cron > page composite), URL audit hotfix, SHA-pinned curated file URLs (bypasses Fastly 5-min CDN cache).
- **Rev 0.11 (2026-06-05)** — amplp classification fix. 65/65 amplps correctly typed with bucket inheritance.
- **Rev 0.10 (2026-06-02)** — 10 systemic correctness fixes during audit night. Self-referential vault detection, dedup, missing amplp synthesis, source_coverage transparency block.

Phase 0 (data foundation) is LOCKED IN as of Rev 0.16. Subsequent work (Member Stats, Portfolio Tracker, etc.) builds on this foundation without changes to catalog schema or contents.
