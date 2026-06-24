# cron-scripts

Source code for every production cron that powers `thealliancedao.com`.

Each cron lives in its own folder with its own README. This top-level README is an index — start here to find what you need.

## How the system fits together

```
defipatriot/cron-scripts (this repo)
   ├── one folder per cron (source code)
   └── Render runs each on its own schedule

       ↓ each cron writes to its own data repo

defipatriot/<cron-name>-data_2026  (one per cron)
   ├── 2026/data/<cron-name>.json     ← current snapshot
   ├── 2026/heartbeat.json            ← freshness signal
   └── 2026/daily/YYYY-MM-DD.json     ← per-day archive

       ↓ pages on thealliancedao.com read directly from raw.githubusercontent.com

defipatriot/aDAO-links-site  (the live website)
   └── pages render from the data repos via fetch()
```

No backend server. No database. Each cron is independent — a failure in one doesn't break the rest. Pages cache last-good data and degrade gracefully.

## Cron inventory

### 🟢 Active production crons (16 live + 1 built/pending: `tla-flows`)

| Folder | Writes to | Cadence | Purpose |
|---|---|---|---|
| `adao-positions/` | `adao-positions-data_2026` | Daily `0 1 * * *` | Member position snapshots for **ALL aDAO members** (named + unknown) via the shared capture engine. current.json = full live view (156 members, `is_registered`-tagged); daily/weekly archives = registered-only history. Foundation for Portfolio Tracker. **Schedule switched to daily 2026-06-13 — daily P&L history now accumulating.** |
| `dao-dashboard/` | `tla-snapshot-data_2026` (`data/dao-dashboard.json` + `data/daily/` archives) | Hourly — **chained into the tla-snapshot job** (`node tla-snapshot.js && node ../dao-dashboard/dao-dashboard.js`) | Successor to the dead "TLA Admin Core v3" epoch cron. DAO-specific live aggregates (treasury, unclaimed/vote/rebase rewards, TLA deposits + per-pool positions, Lion alliance) in a legacy-v3-compatible shape. Feeds index.html's rewards/deposits/Lion tiles + the two deep-dive pages. Self-archives daily for chart history. See its README. |
| `tla-participants/` | `tla-participants-data_2026` | Daily | **All TLA participants** = veLUNA lock holders (CW721 enumeration) ∪ bribe providers (from bribes-data). Surfaces TLA liquidity providers who never staked an aDAO NFT — the full ~26.8M-VP electorate (~203 participants), invisible to adao-positions. Live-only retention. Shared engine. |
| `adao-allies/` | `adao-allies-data_2026` | Daily (after aDAO+TLA) | **All ally DAOs in one cron** (Pixel Lions NFT-staked + Lion DAO cw20-staked). Registered-members-only TLA-position capture. Per-ally isolation (one failing can't break others; pause = comment out an `ALLIES` entry). Add a future ally = one array entry. Shared `lib/ally-capture.js` + engine. |
| `tla-locks/` | `tla-locks-data_2026` | Daily (after aDAO+TLA) | **System-wide veLUNA lock intelligence** — stale-VP gap (~3.5M VP unclaimed system-wide!), unlock cliffs, VP decay projection, per-asset VP totals, auto-max vs decaying split, per-holder rollups. The differentiated capture (exists nowhere else, not even Eris). Live-only + daily summary archive. Shared engine. |
| `lib/` (shared modules, not a cron) | — | — | `capture-engine.js` (DAO-agnostic per-address TLA position capture, extracted from adao-positions 2026-06-13 — every member cron imports it) + `ally-capture.js` (shared ally discovery/capture). See `lib/README.md`. |
| `astroport/` | `astroport-pool-data_2026` | Daily | Astroport pool stats (liquidity, APR, volume) |
| `bribes-history/` | `bribes-data_2026` | Daily | Bribes per epoch — voting incentive history |
| `marketplace-stats/` | `marketplace-data_2026` | Daily | NFT marketplace activity for Pixel Lions |
| `network-and-prices/` | `network-and-prices-data_2026` | Daily | Token prices, chain stats, ASTRO etc. (the page-wide price source) |
| `nft-inventory/` | `nft-inventory-data_2026` | Daily | Pixel Lions ownership distribution (replacing deving.zone) |
| `skeletonswap-lp_data/` | `ss-pool-data_2026` | Daily | Skeleton Swap pool stats |
| `tla-snapshot/` | `tla-snapshot-data_2026` | Daily 23:00 UTC Sun, 00:00 UTC other days | TLA gauge state at epoch boundaries — votes, distributions, APRs |
| `tla-vp-holders/` | `tla-snapshot-data_2026` (subdirectory) | Daily | Per-wallet veLUNA holdings — voting power resolution |
| `votion/` | `votion-data_2026` | Daily | Votion bribes market — current epoch incentive offers |
| `chain/tla-registry/` | `tla-chain-registry` (no `_2026` — separate convention) | Daily 00:05 UTC | **The TLA ecosystem catalog** — 173 tokens, 75 pools, 65 amplps, 668 wallets with cross-source reconciliation. See `chain/tla-registry/README.md`. |
| `tla-flows/` | **`tla-core` repo, `flows/` module** (new unified-repo storage) | 15 min — **pending Render deploy** | **LP deposit/withdraw/claim event capture + zap costs/fees.** Resumable `tx_search` over 6 shared contracts — the exact claim *timing* + entry/exit *slippage* the daily snapshots can't recover. Sibling to `tla-history` (vote+lock events). Built + locally verified 2026-06-24; parser 42/42 on real data. See `tla-flows/README.md`. |

\* `adao-positions` is currently scheduled `0 1 * * 1` (weekly Mondays). Needs to change to `0 1 * * *` (daily) — tracked in `CHANGES_PENDING.md` P1.

### 🟡 Legacy / retired folders (in this repo for history)

| Folder | Status | Notes |
|---|---|---|
| `ampcapa/` | LIVE — daily. Heartbeat added 2026-06-15 (`snapshots/heartbeat.json`). | Was an early ampCAPA experiment; still runs daily and is now System-Health-monitored. Candidate to fold into `tla-core` when next touched. |
| `backing/` | LIVE — daily. Heartbeat added 2026-06-15 (`snapshots/heartbeat.json`). | Treasury backing (ampLUNA/NFT) snapshot; still runs daily and is now monitored. Candidate to fold into `tla-core`. |

> **`fuel/` is NOT legacy — it's the live pilot of the `tla-core` migration.** It
> runs hourly and writes to the unified `defipatriot/tla-core` repo as the
> `fuel/snapshots/` module (its heartbeat shows current hourly runs). It is the
> **reference SNAPSHOT module** for the new module→product→files storage pattern
> (sibling to `tla-flows`' `flows/events/`). See
> `website-adao-core/TLA-CORE-STORAGE-DESIGN.md`.

These are kept for git history. They are NOT running as production crons. If you find yourself looking at one of these for active work, you're probably in the wrong folder.

### 📁 Root-level orphan files (safe to delete)

| File | Why it's there | Action |
|---|---|---|
| `tla-chain-registry.js` (root) | Old v1.0 catalog cron file from before the rename + folder move. | Delete — the current catalog cron is at `chain/tla-registry/tla-registry.js`. |
| `tla-registry.js` (root) | Accidentally uploaded to root instead of `chain/tla-registry/` during a deploy. The chain/ path is what Render reads. | Delete — root copy is a stale duplicate. |

## Conventions used across crons

### Data write pattern

Every cron writes three files to its data repo per run:

1. `2026/data/<cron-name>.json` — the latest snapshot (overwrites)
2. `2026/heartbeat.json` — freshness signal (`{schemaVersion, capturedAt, runId, runMode, currentEpoch, status, next_expected_run_at, ...}`)
3. `2026/daily/YYYY-MM-DD.json` — per-day archive (one file per UTC day, never overwritten)

The page-side `cron-health` widget reads heartbeat.json from each repo and shows green/yellow/red based on `next_expected_run_at` vs. current time.

### Failure semantics

- **Both LCDs unreachable** → exit clean (1 or 2), no GitHub write. Last good snapshot stays in place.
- **Watchdog** → most crons have a hard runtime ceiling (5-10 min) to prevent runaway costs.
- **External source fails** → record in `source_errors` / `_errors[]`, snapshot publishes with what DID succeed, status becomes `partial`.
- **Required source fails** → fatal, exit non-zero, no publish.

Status values in heartbeat: `ok` | `partial` | `error` | (occasionally `skipped` if scheduling logic decided to no-op).

### Environment variables

Every cron expects:
- `GITHUB_TOKEN` — write access to its data repo
- `GITHUB_REPO` — destination data repo (e.g. `defipatriot/adao-positions-data_2026`)
- `GITHUB_BRANCH` — defaults to `main`

Catalog cron (`chain/tla-registry/`) additionally uses:
- `TERRA_LCD_PRIMARY` (default `https://terra-lcd.publicnode.com`)
- `TERRA_LCD_FALLBACK` (default `https://terra-rest.publicnode.com`)
- `GLOBAL_CONFIG_ADDR` (the bootstrap contract — should never change)

## Reliability audit & failure-class checklist (2026-06-09)

A systemwide audit (triggered by a publicnode pagination quirk silently dropping unstakes in `nft-inventory` for months) hardened 6 crons. Common root: **code that couldn't distinguish "query failed" (`null`) from "no data" (`[]`/end-of-list)** → silent incomplete data, sometimes reaching permanent archives. Full record + per-file fixes: `website-adao-core/CHANGES_PENDING.md` → "Systemwide reliability audit".

**Run this checklist against any new or modified cron:**
- **F1 — Pagination truncation.** publicnode IGNORES `pagination.offset` (use `page` + `ORDER_BY_DESC`); also watch `page`-caps and `start_after` loops that stop early.
- **F2 — Silent null-coercion.** `r || []` / `Array.isArray(r) ? r : []` right after a query that returns `null` on rate-limit → empty masquerades as "no data." Distinguish `null` (failed) from `[]` (genuine end).
- **F3 — Overwrite-with-partial.** Never clobber last-good / a permanent archive with fewer/empty records on a bad run (history is append-only → guard before publish).
- **F4 — Corrupt-vs-absent input.** A `try/catch` must treat a *corrupt* file (throw) differently from a *missing* one (skip) — else a whole source drops silently.
- **F5 — Staleness / schema drift.** Static reference data going stale; upstream field renames silently zeroing a parser.
- **F6 — Required-vs-optional.** A source that should be fatal must abort, not publish a partial marked `ok`.
- **F7 — Heartbeat honesty.** `status` must flip to `partial`/`error`/`stuck` on real failure, or the health widget green-lights a quiet failure. `network-and-prices` is the model (per-source `.ok`, fingerprint staleness detector).
- **F8 — Epoch/time boundary.** Off-by-one epoch, UTC flip, missed end-of-epoch window → irreversible wrong-epoch capture. (`epochIndex` 0-based internal; `currentEpoch = epochIndex + 1` canonical.)

## Project status & roadmap (2026-06-13)

### Recently shipped (this multi-day arc)
- **NFT Explorer v6.0** — chain-of-truth migration, full Analytics tab, deep-linking. (`explorer-log.md`)
- **Dashboard Revs 3.51–3.54** — marketplace v2 (Atrium, multi-venue feed, tier floors), dao-dashboard cron repoint, cron-first instant paint (~9s→3-5s cold load), deving.zone eliminated, chart history revived past epoch 185, heartbeat false-stale fix, deep-dive pages onto the live layer. (`index-log.md`)
- **dao-dashboard cron** built + deployed (chained into tla-snapshot). Notable bug caught in fixture testing: bribe-manager `user_claimable` claims can nest `amount` inside `asset`. Notable production discovery: the legacy Lion DAO validator address (`terravaloper1dce…`) was WRONG — the real validator is **`terravaloper1pet430t7ykswxuyhh56d4gk6rt7qgu9as6a5r0`** ("🦁 The Lion DAO", 10,000 LUNA staked from the DAO main wallet). The cron now discovers it by moniker (`/lion/i`) rather than hardcoded address, and emits a `delegation_scan` diagnostic block. **Lesson: never trust a recorded validator/contract address that yields zero — scan and resolve by moniker.**
- **ally.html** — live daily gain + staking share, deving.zone removed.

### TLA Stats — the four product pillars (the "what makes us different from Eris" work)
Goals: **Portfolio Tracker** (member position time-series + P&L), **LP Performance & Health Scoring** (multi-epoch ungameable metrics), **Bribes Tracking**, **Vote Intelligence**. History strategy is **forward-only chain capture** (public LCDs prune ~100 blocks; no archive node) — so the accumulation clock matters, every un-captured week is lost.

**Phase status:**
- Phase 1 (chain-query discovery) — ✅ done (all Eris ve3 contracts mapped).
- Phase 2 (pipeline-in-scripts) — ✅ done.
- Phase 3 (forward accumulation) — ✅ **running.** adao-positions switched to daily 2026-06-13; the full member-expansion + lock-capture layer built and live (see below). Every capture cron the pillars need now exists and is accumulating.
- Phase 4 (the four pillars on tla-stats.html) — 🔲 not started. **All raw data feeds now exist** — this is the next major work.

### Member-expansion + lock-capture layer — ✅ BUILT & LIVE (2026-06-13)
Architecture as decided: **shared `lib/capture-engine.js`** (DAO-agnostic per-address TLA position capture, extracted verbatim from `adao-positions.js`) imported by every member cron. Each cron keeps only its own discovery + output. Membership is always LIVE (DAODAO topStakers / lock enumeration / bribes read) — no hardcoded member lists.

| Cron | Status | Tracks | Discovery |
|---|---|---|---|
| `adao-positions` | ✅ widened | ALL aDAO members (named + unknown) | DAODAO topStakers + PFPK. current.json = all 156; archives = registered-only. Surfaced ~510K VP (21%) previously invisible. |
| `tla-participants` | ✅ built | Lock holders ∪ bribe providers | CW721 enumeration (431 locks → 202 holders) + bribes-data read (today: just PD). ~203 participants, 26.8M VP — the full electorate. |
| `adao-allies` | ✅ built | Pixel Lions + Lion DAO (registered only) | core → votingModule → type-appropriate topStakers. **Bundled — one cron, both allies, per-ally isolation.** |
| `tla-locks` | ✅ built | System + per-holder lock intelligence | Enumerate all 431 + total_vamp. Stale-VP gap 3.49M VP, unlock cliffs, decay, per-asset VP. |

**Engine v1.1 enrichments (all additive, live):** `first_participation` (chain-native tenure via gauge `user_first_participation` — NOT forward-accumulated, it's a direct read); lock `end_period`/`is_auto_max_locked`/`weeks_to_unlock`; `inactive_take_exposure_usd` (inactive LP × 10%); VP spread (`current_vp_human`/`potential_vp_human`/`vp_gap_human`).

**⚠️ GOTCHAS LEARNED 2026-06-13 (cost real time — preserve):**
1. **`GITHUB_REPO` env var MUST include the `defipatriot/` owner prefix.** Setting just `tla-locks-data_2026` → 404 on publish (capture succeeds, publish fails). Bit us 3×. Every working cron uses full `owner/repo`.
2. **DAODAO voting-module formula depends on the contract TYPE** (from `{info:{}}`): `dao-voting-cw721-staked`→`daoVotingCw721Staked`, `dao-voting-cw20-staked`→`daoVotingCw20Staked`, `dao-voting-token-staked`→`daoVotingTokenStaked`. **Lion DAO is cw20-staked** (ROAR is a cw20), NOT token-staked — wrong formula returns 0 stakers (empty, not an error). Confirm type via the voting module's `info` query.
3. **Lock-asset symbols must resolve correctly for stale-VP math.** The LST-ratio lookup keys off symbol; raw contract-address "symbols" default ratio→1 and silently UNDERCOUNT the gap (saw 269K with raw keys → 3.49M with correct symbols). Hardcoded map in tla-locks. Lock assets: `native:uluna`=LUNA, `cw20:terra1ecgaz…`=ampLUNA, `cw20:terra17aj4ty…`=bLUNA, `cw20:terra1se7rvue…`=arbLUNA (ERIS Arbitrage LUNA, 15M VP — biggest), `native:ibc/08095CED…`=stLUNA.
4. **GitHub web-UI partial commits**: double-underscore filenames upload as NEW files instead of replacing; edit existing file in place (pencil→select-all→paste) and verify via codeload tarball (raw.githubusercontent.com CDN lags ~5min → false "not committed" alarms).

**Name registry (live):** DAODAO names via **PFPK** `pfpk.daodao.zone/bech32/{hexAddress}` → `{name}` (non-null = registered). Every member cron reuses it — registrations reflect next run.

### `tla-locks` cron — ✅ BUILT & LIVE (2026-06-13)
**The highest-value capture** — stale-VP-gap and unlock-cliff metrics exist nowhere else (not even Eris). First live run (epoch 189): system VP 26.86M (fixed 2.88M + decaying 23.98M), **stale-VP gap 3.49M (≈13% of all VP unclaimed)**, 277 auto-max locks holding 94% of VP vs 154 decaying, no unlock cliff for 6mo (95% of decaying VP 26w+ out), per-asset: arbLUNA 15.1M / ampLUNA 7.78M / bLUNA 757K / LUNA 287K / stLUNA 22.9K. Cross-check passes (per-lock VP sum = decaying total). Schema reference retained below.

Lock contract (veLUNA / "Vote Escrowed LUNA"): **`terra1uqhj8agyeaz8fu6mdggfuwr3lp32jlrx5hqag4jxexde92rzkamq3l62zg`**. CW721-enumerable (confirmed: `num_tokens`→431, `all_tokens` works). Per-lock `lock_info` returns: `owner`, `asset.info` (LST type), `asset.amount`, `underlying_amount` (with the **ratio frozen at lock time**), `coefficient` (VP multiplier tier 1–10ish), `start`/`end` periods, `slope` (exact VP decay/week), `voting_power`, `fixed_amount`.

Capture design:
- **System totals: ONE call.** `total_vamp` → `{fixed, voting_power, vp}` (fixed = non-decaying floor, voting_power = decaying part, vp = total). Decay *projection* via `total_vamp{time:{period:N}}` (NOT `at_period` — that variant is rejected; valid: current/next/last/time/period).
- **Per-lock (×431):** `lock_info` + `owner_of`.
- **Auto-max-lock detection (no extra query):** `end=="permanent"` && `slope==0` = auto-max ON; `end=={period:N}` && `slope>0` = decaying, N = unlock period.
- **Stale-VP gap (the unique metric):** VP is stamped at lock-time ratio. Compute "VP if re-stamped today" = `amount × current_ratio × coefficient` vs the frozen `underlying`. Asset oracles are in the lock contract's `config.deposit_assets[].config.exchange_rate.contract` (LUNA native 1:1; ampLUNA, bLUNA, arbLUNA-ibc, + a 4th cw20 each carry their oracle).
- **Participation order = free:** ascending `token_id` is the lock order (NFT #1 = first participant); `start` period dates it.
- **Per-member rollups:** group locks by owner → total VP, stale-VP upside, personal unlock cliff, first-participation.
- **Marketplace cross-ref:** locks are listable on Boost (already in the marketplace pipeline) → discounted-VP-for-sale flagging.
- **Voter behavior (rides along):** vote churn + votes-on-dead-LPs from gauge controller `user_info.gauge_votes` snapshots (changes between runs = churn).

### `tla-flows` cron — ✅ BUILT + locally verified 2026-06-24 (Render deploy pending)
The **LP-flow event sibling to `tla-history`** (which backfills votes+locks). Captures the **deposit / withdraw / claim** stream + **zap entry/exit costs/fees** — the exact intra-day claim *timing* and per-tx *slippage* that daily `adao-positions` snapshots and the vote/lock backfill cannot recover after the fact. Code in `tla-flows/`; **output to the new unified `tla-core` repo, `flows/` module** (first cron on the tla-core storage pattern — storage design documented separately).

- **Resumable, completeness from a cursor:** read cursor → `tx_search [cursor,head]` over **6 shared contracts** (1 compounder = all amplified; 4 bucket staking = non-amp; the zapper) → classify (txhash-dedupe) → append `events/YYYY/MM/DD.jsonl` → **advance cursor LAST**. Error → return without advancing. Same loop from a genesis start height = the backfill. No npm deps.
- **⚠️ `tx_search` gotcha:** publicnode LCD **400s on `AND tx.height>=N`** — query by contract only, bound the window client-side, paginate to last page. Pruned public nodes keep result sets small.
- **Parser verified on REAL data (not fixtures):** 42/42 on a live compounder dump + 8 chainscope variations. Routes on wasm `action` (`asset-compounding/*`=amplified, `asset/*`=non-amp, `/claim/`=claim); takes the FIRST flow action so cascades keep the real user. Arbitrage-Vault deposit correctly skipped (arbLUNA mint, not a TLA flow).
- **Cost capture (Rev A.3):** all swap legs (multi-hop exits) + `provide_liquidity.slippage` (imbalanced Tokens deposits), deposits AND withdrawals. Proof: exit-to-LUNA 0.05% vs exit-to-USDC 0.43%; imbalanced Tokens deposit 1.05%.
- **⚠️ Realized-APR correction (preserve):** bribes go to VOTERS (`pending_bribes`), NOT LPs (`pending_rewards`) — separate stream, out of scope. The apparent realized≫advertised gap was APR-vs-APY (amp realized is APY; the compounder auto-compounds — the ≈−3pt drag is its reward fee) + a claim-day double-count bug. Corrected: TLA pays ≈ what it advertises, marginally under. `tla-flows`' exact claim timing collapses the wide non-amp band.
- **Cohort tagging = aDAO NFT stakers** — applied downstream as a label (join nft-inventory/registry), not a capture filter; the cron catches every depositor regardless.
- **Open:** deploy to Render (15-min, `TLA_OUT_DIR`→tla-core checkout `flows/`, commit step as fuel). Downstream tools (Net-P&L waterfall, realized-APR audit, slippage/fee ledger, Zap-Out Optimizer) spec'd in `CHANGES_PENDING.md`.

### Open cron-side items (routed to cron chat, see CRON-FIXES-BRIEF.md)
- **Stake/destake event sweep** (extend nft-inventory pending-claims tx-search → `data/v2/staking-events.json`) — unlocks Stake/Destake in the dashboard feed + DAO-Members chart history.
- SOLID + ampLUNA daily price oracles (improves Atrium floor-band valuation), bid/offer capture, wash-trade flagging.

## Where to find more detail

| Question | Where to look |
|---|---|
| What does cron X do specifically? | `<cron-folder>/README.md` |
| Recent changes per cron? | "Recent changes" section in each cron's README |
| The catalog system's Rev history? | `defipatriot/website-adao-core/catalog-log.md` |
| Cross-cutting architecture, design principles? | `defipatriot/website-adao-core/PROJECT_KNOWLEDGE.md` |
| What's pending to work on? | `defipatriot/website-adao-core/CHANGES_PENDING.md` |
| Per-page dashboard changes? | `defipatriot/website-adao-core/{index,tla,dao,lore,explorer}-log.md` |
| Top-level changelog for THIS repo? | `CHANGELOG.md` (same folder as this README) |

## Deploy notes

All crons run on **Render** as scheduled cron jobs in the **Oregon** region. Each Render service points at this repo with a specific `Root directory` (the cron folder). Build command is `npm install`, start command is `node <script>.js`.

Adding a new cron:
1. Create the folder + README + script + `package.json` here
2. Create a new GitHub data repo with the `_2026` suffix (use the `2026/` year-folder convention)
3. Create a Render cron service pointing at the folder
4. Set env vars (GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH)
5. Verify first run writes heartbeat.json + data file
6. Add to the cron-health widget on the dashboard

## Operational status

10 production crons running on schedule as of 2026-06-06. Catalog cron (`chain/tla-registry/`) at Rev 0.15 deployed; Rev 0.16 packaged but not yet deployed (Phase 0 lock-in). All other crons stable.
# Data & Pipeline Registry (NFT pipeline) — audited 2026-06-11

> **Why this exists:** on 2026-06-11 we nearly built a second wallet-name capture
> because nobody remembered `adao-positions` already owns names via pfpk. Every fact
> must have exactly ONE producer; everyone else consumes its output file. Before
> building capture for anything, read this table first. Before deleting anything,
> check its Consumers column.
>
> **Status legend:**
> `CANONICAL` actively produced + consumed · `FROZEN-LEGACY` old system, kept read-only,
> nothing should read it · `ORPHAN-REMOVE` safe to delete · `ONE-TIME-DONE` seed job,
> finished, keep script for re-seeds

## 1. Producers → outputs → consumers

| Producer (job) | Runs | Output file(s) | Status | Consumed by |
|---|---|---|---|---|
| `cron-scripts/nft-inventory/nft-inventory.js` (Render ×3: hot 15m / warm daily / full weekly) | live | `nft-inventory-data_2026:data/v2/` → `nfts.json`, `summary.json`, `heartbeat.json`, `daily/YYYY-MM-DD.json`, `pending-claims.json`, `hot-set.json` (full only), `floor-history.json` + `listing-first-seen.json` (full/warm only) | CANONICAL | NFT Explorer (`data/v2/nfts.json`, `summary.json`), Analytics tab (floor panel), future unstaked-wallets UI (`pending-claims.json`) |
| `nft-inventory-data_2026` Action: **NFT Incremental Update** (6h) — `nft-forward-incremental.js` + `nft-analytics-builder.js` | live | `data/v2/` → `sales-history.json` (BBL), `atrium-sales.json`, `boost-sales.json`, `nft-provenance.json`, `sales-enriched.json`, `nft-analytics.json` | CANONICAL | Analytics tab (`nft-analytics.json`, `sales-enriched.json`), nft-inventory floor-history (sales floor ← `sales-enriched.json`), events-backfill outcome derivation |
| `nft-inventory-data_2026` Action: **NFT Full Reconcile** (weekly Sun) | live | re-verifies the same files | CANONICAL (backstop) | same as above |
| `nft-inventory-data_2026` Action: **NFT History Backfill** (`nft-backfill.yml` + `bbl-sales-backfill.js`, `atrium-sales-backfill.js`, `nft-provenance-backfill.js`) | one-time, done | seeded sales + provenance | ONE-TIME-DONE — keep scripts (pager is `require`d by other scripts!), workflow can be disabled | — |
| `nft-inventory-data_2026` Action: **NFT Events Backfill** (`nft-events-backfill.yml` + `.js`) | one-time, done 2026-06-11 | `data/v2/broken-at.json` (1,093), `data/v2/listing-history.json` (3,264) | ONE-TIME-DONE — re-runnable (shrink-guarded); NOTE: forward capture of NEW breaks/creates is NOT yet wired into the incremental — new events after 2026-06-11 are not appended. Decide: fold into incremental, or re-run periodically | Explorer broken-tier classification (`broken-at.json`), days-on-market / floor history backstory (`listing-history.json`) |
| `boost-sales-fetch.js` (within incremental) | live | `data/v2/boost-sales.json` | CANONICAL | `sales-enriched.json` build |
| `cron-scripts/adao-positions/adao-positions.js` (Render, daily + 25h archives) | live | `adao-positions-data_2026:data/` → `members.json` (**SOLE OWNER of wallet names** via pfpk.daodao.zone), `current.json`, `weekly_epoch-N.json`, `daily/YYYY-MM-DD.json`, `heartbeat.json` | CANONICAL | future Member Stats page, any UI needing wallet→name (e.g. unstaked-wallets panel). **Never create a second name source.** |
| `cron-scripts/network-and-prices/network-and-prices.js` (Render, hourly + EOD archive) | live | `network-and-prices-data_2026:data/` → `network-and-prices.json`, `daily/YYYY-MM-DD.json`, **`ratio-history.json`** (NEW 2026-06-15: daily LST exchange rates, 6 LSTs, EOD append), `heartbeat.json` | CANONICAL | price tiles, downstream crons, **Portfolio P&L** (`ratio-history.json` × `daily-prices.json` → ampCAPA/ampROAR USD) |
| `tla-history-data_2026` Action: **TLA History Backfill** (`tla-history-backfill.yml` + `.js`; `tla-history-annotate.js` one-time) | one-time done 2026-06-15, forward-maintain wired | `2026/data/` → `vote-events.json` (5,858), `lock-events.json` (11,520, **`canonical` flag**), `rollups.json` (249 wallets), `heartbeat.json` | ONE-TIME-DONE + forward-capable — keep scripts | **Vote Intelligence**, **Portfolio Tracker** lock timeline (sum `canonical===true` only) |
| `price-history-data_2026` Action: **Price History Backfill** (`price-history-backfill.yml` + `.js`) | one-time done 2026-06-15 | `2026/data/daily-prices.json` (23 tokens × ~365d), `coverage.json`, `heartbeat.json` | ONE-TIME-DONE — re-runnable (idempotent) | **Portfolio P&L** USD history. ⚠ ORPHAN-REMOVE the dead `ratio-history-backfill.*` + `ratio-history-probe.*` committed here during the abandoned archive-node attempt (ratio history lives in network-and-prices) |
| `network-and-prices-data_2026` Action: **Ratio History Consolidate** (`ratio-history-consolidate.yml` + `.js`) | one-time done 2026-06-15 | `data/ratio-history.json` (bootstrap from `daily/*.json`) | ONE-TIME-DONE — idempotent/merge-safe | Portfolio P&L (then maintained by the NAP cron's EOD append) |
| `nft-metadata` Action: **BBL Rarity Refresh** (weekly Mon) — `bbl-rarity.js` | live | `nft-metadata:adao-rarity-bbl.json` | CANONICAL | Explorer rank toggle (pending wiring), rarity-explained.html references |
| `nft-metadata:adao-rarity-intended.json` | static (collection immutable) | itself | CANONICAL (never changes) | Explorer rank toggle, rarity page, DAO proposal |
| `nft-metadata:all_nfts_metadata.json` | static | itself | CANONICAL (never changes) | Explorer traits, rarity builds |

## 2. Cleanup actions (verified safe order)

1. **DELETE `nft-inventory-data_2026:nft-inventory.js`** — ORPHAN-REMOVE. Misplaced upload (the cron lives in `cron-scripts/nft-inventory/`); now two revisions stale. Nothing executes it (no workflow references it). *Still present as of 2026-06-11.*
2. **`nft-inventory-data_2026:data/nfts.json`** — FROZEN-LEGACY (pre-v2 path, last write 2026-06-07; explorer reads `data/v2/nfts.json`). Before deleting: grep `aDAO-links-site` for the string `data/nfts.json` (only the v2 path was found in the explorer; the other 15 site pages were NOT audited this pass). Until then treat as frozen, not orphan.
3. Check for any other pre-v2 stragglers under `data/` (e.g. old `data/daily/`) the same way: grep the site repo for the path before removing.
4. **DELETE `price-history-data_2026:ratio-history-backfill.js` + `.yml` + `ratio-history-probe.js` + `.yml`** — ORPHAN-REMOVE (2026-06-15). Built during the archive-node ratio attempt that was abandoned (no free Terra archive node serves historical state — surveyed TFL/publicnode/polkachu, all pruned). The working ratio solution is forward-capture in `network-and-prices` + `ratio-history-consolidate.js` in `network-and-prices-data_2026`. These 4 files in price-history do nothing; safe to delete. (The protobuf abci_query survey code in `ratio-history-backfill.js` is worth keeping as a reference IF a paid archive endpoint is ever acquired — move it to an archive folder rather than leaving it loose in price-history.)

## 3. Hardcoded-value inventory (NFT pipeline)

Risk classes: `IMMUTABLE` safe forever · `CONFIG` tunable, ages fine · `ASSUMPTION` breaks if an external party changes behavior — monitored/guarded · `STALE-PRONE` will drift, has a plan.

| Where | What | Class | Notes / mitigation |
|---|---|---|---|
| nft-inventory.js, backfills, explorer | Contract addresses (NFT, BBL, Atrium, Boost, DAODAO, Enterprise, ampLUNA) | IMMUTABLE | Contracts can't change address. Single-sourced per file top. |
| nft-inventory.js | `PHOENIX_TOKEN_IDS` (25 ids) | IMMUTABLE | Collection fully minted; ids can never change. Provenance comment points to adao-rarity-intended.json. |
| nft-inventory.js, bbl-rarity.js | `EXPECTED_TOTAL = 10000` | IMMUTABLE | Supply fixed. |
| nft-inventory.js | `SALES_FLOOR_K = {broken:5, base:10, phoenix:3}` | CONFIG | Methodology choice from the brief; change = methodology change, not breakage. |
| nft-inventory.js | Warlock URL + response shape (`nfts[].auction`), `WARLOCK_PAGE_CAP=12`, price-asc-lists-auctions-first | ASSUMPTION | **Top external-breakage risk.** Guarded: warlock-down/empty ⇒ unfiltered + warning, never blanked. If BBL redesigns the API, the `warlock_unavailable` warning fires — watch heartbeat `listing_resolver_warnings`. |
| nft-inventory.js | BBL `auction_by_contract` cursor semantics (known to skip entries) | ASSUMPTION | Mitigated: warlock recovery + `warlock_only_…` warnings make any regression visible. Contract-side root cause never found — documented, accepted. |
| nft-events-backfill.js | sales-enriched shape quirk: BBL rows have `auction_id` and NO `marketplace` field | ASSUMPTION | If analytics-builder ever adds the label, matching still works (auction_id branch first). If it RENAMES auction_id, the creates≥sales gate fails loudly. |
| nft-events-backfill.js | Escrow capture via `send_nft` only | ASSUMPTION | If a marketplace uses pull-based `transfer_nft` listing, historical creates under-capture. Evidence it doesn't: all current live listings (BBL/Atrium/Boost) have matched creates. |
| bbl-rarity.js | `MIN_CAPTURED = 8500` sanity floor; null-block fill logic | CONFIG/ASSUMPTION | Tied to BBL's unstable null-block pagination. 5 structural self-checks fail the run before a bad file publishes. |
| nft-provenance-backfill.js | Mint PHASES table (date windows → LUNA price) | STALE-PRONE by design | Marked "rough but honest" in-file; refinement = later per-tx pass. Won't silently break anything. |
| adao-positions.js | pfpk.daodao.zone URL + bech32-hex scheme; fallback CSV column guessing | ASSUMPTION | Names degrade to null (not wrong) if pfpk dies; `named_count` in members.json is the canary. |
| nft-explorer-app.js | System-wallet label map (3 addresses), `SYSTEM_ADDRESSES` set, `PLANET_*` maps, CDN/IPFS URLs | IMMUTABLE + ASSUMPTION | Addresses immutable. PLANET maps had the Pampa typo (fix queued in CHANGES_PENDING P1 item 9). CDN URL is an external assumption with IPFS fallback already in place. |
| rarity-explained.html | Trait-count tables + match stats (967 / 80) baked into HTML | IMMUTABLE | Collection immutable ⇒ counts can never drift. Safe forever. |
| floor-history.json rows | `sales_tiering: current_broken_flag` | STALE-PRONE, planned | broken-at.json now exists ⇒ next floor-history improvement is timestamp-aware tiering (queued). Rows self-describe their basis, so old rows stay honest. |

## 4. Not audited this pass (do these the same way before touching)

- The other Render crons + their data repos: `tla-snapshot`, `astroport-snapshot`, `bribes-history`, skeleton-swap, treasury (TLA side of the house).
- The 15 non-explorer site pages in `aDAO-links-site` (which data paths they fetch).
- `website-adao-core` knowledge files for references to retired paths.

## 5. Next project (queued): TLA Lock NFT backfill

Same playbook as the aDAO events backfill, new subject: the TLA Locks CW721
(`terra1uqhj8agyeaz8fu6mdggfuwr3lp32jlrx5hqag4jxexde92rzkamq3l62zg`) — lifecycle events
for member lock creation, merges, unlock starts/completions, plus Boost marketplace
activity for lock NFTs (listings/sales already partially covered by the Boost machinery
above; locks need their own event probes first, browser-probe style).
