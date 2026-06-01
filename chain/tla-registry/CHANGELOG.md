# Changelog — tla-chain-registry

All notable changes to this cron's code. Daily auto-runs not listed.

## v1.0.0 — 2026-06-01

Initial release. Layer 0 of the chain-native pipeline.

### Added
- `tla-chain-registry.js` — 5-query daily capture:
  - `global-config.all_addresses`
  - `asset-gauge.distributions`
  - `asset-gauge.last_distribution_period`
  - `asset-gauge.config`
  - `voting-escrow.num_tokens`
- Output schema v1: `raw.*` (unmodified source responses) + `directory` +
  `pools[]` (keyed by `gauge_pool_id|bucket` per Part 1.1) + `buckets{}` +
  `_errors[]` (per Part 3.2: failed ≠ empty).
- Heartbeat with freshness fingerprint (matches the schema used by the
  other 7 production crons). Stuck threshold widened to 20 consecutive
  identical runs because the registry legitimately moves only weekly
  (on epoch boundaries).
- Watchdog: 5-min hard runtime ceiling (Part 5.3).
- Both LCDs unreachable → fail clean (exit 1), no GitHub write, old
  snapshot stays in place.

### Notes
- Only the global-config contract address is hardcoded. Everything else
  is discovered from that bootstrap query.
- Output repo: `defipatriot/tla-chain-registry` (NEW). Year-folder
  structure `2026/...` so the repo itself outlives the calendar year.
- Render service named `tla-chain-registry-v2` per Part 5.6 parallel-run
  convention. The existing 7-cron pipeline is unaffected.
