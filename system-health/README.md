# system-health

Reads every cron's heartbeat, evaluates freshness/status/errors, pings external
endpoints, and publishes one `system-health.json` that the Transparency Hub
renders. The operational face of the platform — one glance tells you whether the
data can be trusted right now.

## What it does
1. Fetches each monitored cron's `heartbeat.json` over GitHub raw.
2. Evaluates freshness vs expected cadence (late/stale grace multipliers), run
   status (ok/partial/error), and stuck-data (repeated fingerprint).
3. Surfaces sanitized `recent_errors` from each heartbeat (crons report errors via
   `lib/error-reporter.js`, which strips tokens/creds/paths).
4. Pings 7 external endpoints (terra-lcd, daodao indexer, pfpk, coingecko, eris,
   warlock) and reports up/down + latency.
5. Computes a confidence % (share of core+foundation feeds that are fresh) and an
   overall verdict (healthy / watch / minor / degraded).
6. Publishes `data/system-health.json` + its own `data/heartbeat.json`.

## Output: `system-health.json`
- `overall`, `overall_reason`, `confidence_pct`, `counts`
- `attention[]` — only the systems needing a look, with plain-language reasons
- `systems[]` — every cron: health, status, last_run, cadence, recent_errors,
  `data_repo_url` + `cron_source_url` (GitHub links)
- `endpoints[]` — each external dependency: up/down, latency_ms, role, reason

## Heartbeat paths (the gotcha)
Crons don't all write to `data/heartbeat.json`. Known exceptions baked into
`MONITORED`:
- `nft-inventory` → `data/v2/heartbeat.json`
- `fuel`, `ampcapa`, `backing` → `snapshots/heartbeat.json`
- `tla-registry` → `2026/heartbeat.json`
When adding/changing a cron, verify its real heartbeat path against production and
update `MONITORED` here, or it will false-flag "stale".

## Cadences (minutes)
Set per cron in `MONITORED`. A wrong cadence = a false "down". Confirmed from
production heartbeats (e.g. bribes-history runs DAILY, not 4h).

## Config / deploy
- Zero npm deps (Node `https` + `fs` only). `package.json` exists for Render's
  `npm install` step.
- Render: root `system-health`, build `npm install`, cmd `node system-health.js`,
  schedule `*/30 * * * *`.
- Env: `GITHUB_TOKEN`, `GITHUB_REPO=defipatriot/system-health-data_2026`,
  `GITHUB_BRANCH=main`.

## Notes
- Rendered by `aDAO-links-site/transparency-hub.html` (System Health + Endpoints tabs).
- An endpoint returning any HTTP response (even 404) counts as UP; only a network
  failure / 5xx / timeout is DOWN.
