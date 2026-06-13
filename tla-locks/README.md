# tla-locks

System-wide veLUNA **lock health & intelligence** — the differentiated capture.
Enumerates every TLA lock NFT and derives metrics that exist nowhere else in the
ecosystem (not even Eris surfaces them): the **stale-VP gap**, **unlock cliffs**,
**VP decay projection**, **per-asset VP totals**, and **auto-max vs decaying**
split — both system-wide and per-holder.

## Lock contract
`terra1uqhj8agyeaz8fu6mdggfuwr3lp32jlrx5hqag4jxexde92rzkamq3l62zg` (veLUNA /
"Vote Escrowed LUNA"). CW721-enumerable, 431 locks. Per-lock `lock_info` gives
owner, asset (LST), amount, `underlying_amount` (**ratio frozen at lock time**),
coefficient, start/end periods, slope, voting_power.

## Headline metrics
- **Stale-VP gap** — VP is stamped at the lock-time LST ratio. When the ratio
  rises (ampLUNA/bLUNA appreciate), the holder's true VP exceeds what's stamped
  until they touch the lock. `gap = underlying_now × coefficient − stamped_vp`
  per lock, summed system-wide = the "unclaimed VP" headline.
- **Unlock cliff** — VP-weighted histogram of decaying-lock unlocks by week
  bucket (0-4w / 4-8w / 8-13w / 13-26w / 26-52w / 52w+), each with % of decaying
  VP. The "how much VP is winding down and when" view.
- **Decay projection** — system VP at +4/+8/+13/+26/+52 weeks via
  `total_vamp{time:{period:N}}` (chain projects it for us — cheap).
- **Auto-max vs decaying** — `end=="permanent" && slope==0` = perpetually
  max-locked; otherwise decaying with an unlock period. Split by count + VP.
- **Per-asset VP** — totals by ampLUNA / bLUNA / arbLUNA / LUNA.
- **Per-holder rollups** — each holder's total VP, stale-VP upside, soonest
  unlock, auto-max/decaying split. PFPK-named where registered.

## System totals — cheap
`total_vamp` → `{fixed, voting_power, vp}` in ONE call (fixed = non-decaying
floor, voting_power = decaying part, vp = total). We also sum from per-lock VP
as a cross-check.

## Retention
**Live-only** for the full per-lock/per-holder data. The **system summary** is
also written to `data/daily/YYYY-MM-DD.json` (cheap) so decay curves and cliff
evolution accumulate history without storing 431 locks × 365 days.

## Output (repo: `tla-locks-data_2026`)
- `data/current.json` — full: system summary + every lock + per-holder rollups
- `data/summary.json` — light: system aggregates only (fast tiles)
- `data/daily/YYYY-MM-DD.json` — daily system-summary snapshot (decay/cliff history)
- `data/heartbeat.json` — status + counts

## Status semantics (F7)
`partial` if enumeration was incomplete or any lock errored; `error` (exit 2) if
zero locks captured.

## Env
`GITHUB_TOKEN`, `GITHUB_REPO` (default `defipatriot/tla-locks-data_2026`),
`GITHUB_BRANCH`.

## Render
Root directory `tla-locks`, build `npm install`, start `node tla-locks.js`,
daily — schedule after the aDAO + TLA crons (reuses network-and-prices ratios
via the engine). LCD-heavy (enumerate + lock_info × 431), so give it its own
window; concurrency 5.

### Recent changes
- **2026-06-13 — v1.0.** Initial build. System + per-holder lock intelligence on
  the shared capture engine. Stale-VP gap, unlock cliff, decay projection,
  per-asset VP, auto-max split. Live-only + daily summary archive.
