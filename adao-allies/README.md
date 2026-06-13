# adao-allies

Tracks the members of aDAO's **ally DAOs** (registered names only) with full
TLA-position depth via the shared capture engine. **One cron for all allies** —
adding a future ally is a one-entry append to the `ALLIES` array, not a new
service.

## Current allies
| Ally | Stake type | DAODAO formula |
|---|---|---|
| Pixel Lions | NFT-staked | `daoVotingCw721Staked` |
| Lion DAO | ROAR (cw20-staked) | `daoVotingCw20Staked` |

## Independence (preserved even when bundled)
Each ally is captured in its own try/catch. One ally failing (indexer hiccup,
voting-module unresolvable) **never blocks the others** — its status is reported
`error` individually while the rest still publish. Pausing an ally = comment out
its `ALLIES` entry. So the "allies can't break each other / can be paused
independently" property holds without separate services.

## Discovery (live, runtime-resolved)
Per ally: core address → DAODAO indexer `daoCore/votingModule` → the voting
module → `{formula}/topStakers`. Nothing hardcoded but the core address.

## Capture
Registered (PFPK-named) members run through `../lib/capture-engine.js` → full
TLA position (LP, locks, voting, rewards, tenure, VP spread, take exposure).

## Retention
**Registered-only** (ally decision 2026-06-13). The light `participants.json`
lists ALL stakers per ally; only named members get full capture.

## Run order
Runs **after aDAO + TLA crons** — it reuses `tla-snapshot` + `network-and-prices`
data through the engine's `loadSharedData`, so those should refresh first. Hits
the DAODAO **indexer** for discovery (not the LCD), so it doesn't compete with
the LCD-heavy crons for rate limits.

## Output (repo: `adao-allies-data_2026`)
- `data/current.json` — all allies, each with registered members + TLA positions
- `data/{slug}.json` — per-ally detail (`pixellions.json`, `liondao.json`)
- `data/participants.json` — light list of all stakers across allies
- `data/heartbeat.json` — overall + per-ally status

## Status semantics (F7)
- Overall `ok` only if every ally is ok; `partial` if some allies fail;
  `error` (exit 2) only if ALL allies error.

## Stake amounts
`stake_raw` per member = NFT count (Pixel Lions) or raw ROAR micro-units (Lion
DAO, billions). v1 carries it without USD valuation. (Lion DAO ROAR pricing via
network-and-prices is a later add.)

## Env
`GITHUB_TOKEN`, `GITHUB_REPO` (default `defipatriot/adao-allies-data_2026`),
`GITHUB_BRANCH`.

## Render
Root directory `adao-allies`, build `npm install`, start `node adao-allies.js`,
daily — scheduled after the aDAO + TLA crons.

### Recent changes
- **2026-06-13 — v1.0.** Initial build. Pixel Lions + Lion DAO under one cron on
  the shared ally-capture module, per-ally isolation, registered-only retention.
