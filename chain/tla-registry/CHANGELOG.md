# Changelog — tla-registry

All notable changes to this cron's code. Daily auto-runs not listed.

## v2.0.0 — 2026-06-01

**Major expansion: Layer 0 now produces the full ecosystem catalog.**

### Added
- **Q6 chain query**: `asset-compounder.asset_configs` → amplp ↔ underlying-LP mapping
- **External source pulls** (each optional, isolated failures):
  - Cosmos Chain Registry (`raw.githubusercontent.com/cosmos/chain-registry/master/terra2/assetlist.json`)
    — 58 Terra2 assets with coingecko_id, IBC traces, decimals, logos
  - Eris prices (`backend.erisprotocol.com/prices`) — canonical display names
  - Astroport REST (`app.astroport.fi/api/pools?chainId=phoenix-1`) — cross-source names
  - Skeleton Swap (`dex.warlock.backbonelabs.io/api/pools/phoenix-1`)
- **Curated file system**: cron reads `curated/*.json` from same data repo
  - `categories.json` — taxonomy definition
  - `wallets.json` — known wallet labels
  - `protocols.json` — protocol metadata
  - `known_contracts.json` — contract labels (seeded from aDAO registry)
  - `token_overrides.json` — display name preferences
  - `acquisition_guides.json` — safe-acquisition steps per token
- **Address-first catalog assembly**:
  - Tokens indexed by Terra address (not name) — the only stable identity
  - 9-stage merge: chain-registry → Eris → Astroport → SS → pools → amplp → overrides → guides → scoring
  - Eris is the source-of-truth for display names (Camron's call)
  - Post-pass: cross-token variant detection (the wBTC.atom/.axl/.osmo case)
- **Confusion scoring per token** (0-100):
  - `-25` no CoinGecko mapping (no external price source)
  - `-15` cross-source name mismatch
  - `-15` not in active use anywhere
  - `-10` no acquisition guide
  - `-10` shared base symbol with other variants
- **LP-token category** (separate from regular tokens): pool gauge_pool_id IS an LP, not the underlying asset
- **`_unmapped[]` worklist**: surfaces tokens cron saw but couldn't name, distinguishing LP tokens (expected, named by DEX in production) from regular tokens (truly need curation)
- **Schema bumped to v2** — heartbeat and snapshot now carry richer stats:
  - `tokens_catalog`, `contracts_catalog`, `wallets_catalog`, `amplp_mappings`, `unmapped_tokens`, `external_source_errors`

### Changed
- File renamed: `tla-chain-registry.js` → `tla-registry.js`
- Folder moved: `tla-chain-registry/` → `chain/tla-registry/`
- Cron status logic: `partial` now triggers when external source errors > 0 too (not just chain errors)
- Heartbeat stats expanded with catalog-side counts

### Architecture notes
- The cron is **resilient by design**: if Astroport REST is down, catalog still publishes with chain-registry + Eris + SS data. Failure is recorded in `source_errors`, status flips to `partial`, but cron exit code stays 0.
- The cron is **address-first**: identity is by terra address (not display name). Names are metadata. This is the only safe primary key given the wBTC/USDC multi-variant reality.
- The curated folder is read from THIS SAME REPO each run — no external dependency for curation. Edit in GitHub web UI → next run picks it up.

## v1.0.0 — 2026-06-01

Initial release. Layer 0 of the chain-native pipeline. 5 queries, basic registry capture.
