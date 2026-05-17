# cron-scripts

This is the home for all scheduled data-capture jobs that power the **Alliance DAO (aDAO) website** and the **TLA tool** (`tla-tool_ext.html`).

Each subfolder is one independent Render Cron Job that captures a specific slice of TLA / Terra ecosystem data and commits it to a dedicated GitHub repo. The website (and the tool, optionally) read from those data repos to render the dashboard.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CRON LAYER  (this repo)                               │
│  Each cron is independent — one failure doesn't break the others.           │
└───────────────────┬─────────────────────────────────────────────────────────┘
                    │
                    │ writes to
                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       DATA LAYER (separate GitHub repos)                    │
│  votion-data_2026 / ss-pool-data_2026 / astroport-pool-data_2026 /          │
│  bribes-data_2026 / tla-snapshot_2026 / etc.                                │
└───────────────────┬─────────────────────────────────────────────────────────┘
                    │
                    │ read by
                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│   CONSUMER LAYER                                                            │
│   ├── thealliancedao.com website (Vercel)                                   │
│   └── tla-tool_ext.html (interactive fallback / power-user view)            │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Design principle**: every cron is a leaf — it pulls fresh data from its source, transforms it, and writes a self-contained file. No cron depends on another cron's *runtime* state. The *only* cross-cron dependency is the future `tla-snapshot` cron, which reads the output of all the other crons (from GitHub) to produce a unified dashboard file.

---

## Active crons

| Folder | Captures | Schedule (UTC) | Data repo |
|---|---|---|---|
| [`votion/`](./votion) | Weekly Votion epoch snapshot (lockups, VP, votes, USD, APYs, pool rollup) | Sun 23:55 | `votion-data_2026` |
| [`skeletonswap-lp_data/`](./skeletonswap-lp_data) | Daily Skeleton Swap pool TVL/volume + weekly + monthly rollups ⚠ (upstream source unreliable, see folder README) | Daily 23:45 | `ss-pool-data_2026` |
| [`astroport/`](./astroport) | Daily Astroport TLA-pool TVL/volume/fees/reserves/LP-supply + per-epoch chart aggregates (active+inactive) | Daily 23:50 | `astroport-pool-data_2026` |
| [`bribes-history/`](./bribes-history) | All PD bribes decoded from DAODAO proposals + current bribe-manager state | Daily 23:35 | `bribes-data_2026` |
| [`adao-positions/`](./adao-positions) | Per-member TLA portfolios (LP positions, locks, votes, pending rewards) + daily/weekly archives | **Should be daily 01:00** (currently weekly Mon — needs Render schedule update) | `adao-positions-data_2026` |
| [`tla-snapshot/`](./tla-snapshot) | Unified TLA snapshot — pools, VP, bribes, rewards, totals (consumer of other crons) | Hourly :40 + daily archive at 23:xx | `tla-snapshot-data_2026` |
| [`network-and-prices/`](./network-and-prices) | Terra network + LST ratios + dual-source token prices + 7-day price series | Hourly at :40 | `network-and-prices-data_2026` |
| [`nft-inventory/`](./nft-inventory) | aDAO NFT collection inventory (10,000 tokens, minted/unminted/broken status) | Hourly at :30 | `nft-inventory-data_2026` |
| [`marketplace-stats/`](./marketplace-stats) | BBL+Boost marketplace listings, floor prices, sales history, activity feed | Hourly at :15 | `marketplace-stats-data_2026` |
| [`ampcapa/`](./ampcapa) | ampCAPA-specific data | (legacy) | TBD |
| [`backing/`](./backing) | Backing-data snapshots | (legacy) | TBD |
| [`fuel/`](./fuel) | FUEL hourly price | (legacy — kept for hourly candles) | `fuel-data_2026` |

Each subfolder has its own `README.md` with detailed setup, schema, and reliability notes.

---

## Master schedule (UTC)

This is the staggered schedule that lets producer crons finish before the consumer cron reads their output. All times in UTC.

```
=== Hourly throughout the day ===
:15  marketplace-stats   ← BBL+Boost listings, sales, activity
:30  nft-inventory       ← 10K NFTs, minted/unminted state
:40  network-and-prices  ← refreshes price cache every hour (dashboard reads from here)
:40  tla-snapshot        ← unified snapshot (reads other crons' output)

=== Daily flow (Mon-Sat) — runs nightly ===
23:35  bribes-history       ← chain queries, ~5s
23:45  skeletonswap         ← Backbone API, ~20s ⚠ (source unreliable)
23:50  astroport            ← Astroport TRPC, ~26s
23:xx  tla-snapshot         ← end-of-day daily archive at hour 23
01:00  adao-positions       ← per-member TLA portfolios (currently weekly Mon, should be daily)

=== Sunday (epoch close) — same order plus: ===
23:55  votion               ← weekly snapshot of full epoch
─── epoch boundary Sun 23:59 → Mon 00:00 UTC ───
Mon 00:15  bribes-history    ← catches any post-flip bribe activity
Mon 01:00  adao-positions    ← post-flip member position snapshot
```

### Why staggered

If two crons fire at the same minute and one writes to a GitHub repo the other reads from, you can get race conditions where the consumer reads stale data. Staggering by 5-10 minutes guarantees each producer finishes before the next-stage consumer starts.

### TLA epoch math

All crons use the same epoch arithmetic:

```js
EPOCH_START_MS    = Date.parse('2022-10-31T00:00:00Z')
EPOCH_DURATION_MS = 7 * 24 * 60 * 60 * 1000      // 7 days
currentEpoch      = floor((now - EPOCH_START_MS) / EPOCH_DURATION_MS)
```

Epoch boundary is Sunday 23:59 → Monday 00:00 UTC. Epoch numbers are consistent across all repos (votion epoch 184 = SS epoch 184 = astroport epoch 184).

---

## Render deployment

Each cron lives in its own subfolder and is deployed as an independent Render Cron Job:

| Render setting | Value |
|---|---|
| Type | Cron Job |
| Runtime | Node 18+ |
| Branch | `main` |
| Root Directory | `<folder-name>` (e.g. `astroport`) |
| Build Command | `npm install` |
| Start Command | `node <script-name>.js` |
| Schedule | (per-cron, see table above) |
| Plan | Free |

### Environment variables (all crons)

```
GITHUB_TOKEN     # PAT with write scope on the cron's target data repo
GITHUB_REPO      # e.g. defipatriot/astroport-pool-data_2026
GITHUB_BRANCH    # main
```

Same `GITHUB_TOKEN` works across all crons if it has `repo` scope (classic PAT) or `Contents: read/write` on all relevant repos (fine-grained PAT).

### Free tier usage

Total compute across all current + planned crons: **~3 hours/month** out of Render's free 750 hours/month allowance. We use < 0.5% of free tier capacity. Cost is not a constraint.

---

## Data flow per cron

Each cron follows the same pattern:

```
1. Fetch from upstream sources (LCD, TRPC, API)
   └─ Retry with exponential backoff, fallback URLs where applicable
2. Transform and aggregate into per-epoch / per-pool / per-day structures
3. Write JSON + CSV files to /tmp scratch space
4. Push to target GitHub repo via Contents API
   └─ Overwrites same-named files with new SHAs
```

The crons are **stateless** — each run rebuilds files from scratch. If a cron misses runs, the next successful run repairs everything. No partial-state corruption possible.

---

## File formats

Two conventions across all data repos:

### JSON snapshots
- Top-level `schemaVersion` field (v1, v2, etc.)
- Top-level `capturedAt`, `capturedAtUnix`, `period` for time/epoch metadata
- Domain-specific top-level keys (e.g. `pools`, `lockups`, `bribes`)
- Pretty-printed with 2-space indent (readability over compactness — files are ≤100KB)

### CSV summaries
- First row is header
- Pool addresses use full bech32 (no truncation)
- USD numbers fixed to 2 decimals
- Boolean fields as literal `true` / `false` strings
- Empty fields are empty (no `null` / `N/A`)

---

## Repos managed by these crons

| Data repo | Cron | What's in it |
|---|---|---|
| [`defipatriot/votion-data_2026`](https://github.com/defipatriot/votion-data_2026) | `votion` | Weekly Votion epoch snapshots; `votion-old/` = v1 archive, `votion/` = v2 current |
| [`defipatriot/ss-pool-data_2026`](https://github.com/defipatriot/ss-pool-data_2026) | `skeletonswap-lp_data` | Daily SS rolling 7-day, weekly aggregates, monthly aggregates |
| [`defipatriot/astroport-pool-data_2026`](https://github.com/defipatriot/astroport-pool-data_2026) | `astroport` | Daily Astroport per-epoch + daily CSV |
| [`defipatriot/bribes-data_2026`](https://github.com/defipatriot/bribes-data_2026) | `bribes-history` | All PD bribes ever + current chain state + per-epoch rollups |

---

## Planned (not yet built)

| Folder | Purpose | Status |
|---|---|---|
| `network-and-prices/` | Terra supply/bonded/inflation + LST ratios + token prices (Eris vs CoinGecko) | Next |
| `tla-snapshot/` | Unified TLA snapshot — reads all other crons, produces dashboard file | After network-and-prices |
| `adao-positions/` | Per-aDAO-wallet TLA positions | Waits on wallet list |
| `nft-stats/` | deving.zones marketplace snapshot | After NFT API inspection |

See `CHANGES_PENDING.md` in the `website-adao-core` repo for the active backlog.

---

## When something breaks

Render sends emails on cron failures. To diagnose:

1. Open the cron service in Render dashboard → **Logs** tab
2. Check the last failed run's stack trace
3. Common failures:
   - **HTTP 401/403 from GitHub** → `GITHUB_TOKEN` expired or wrong repo scope
   - **HTTP 5xx from Terra LCD** → switch to fallback LCD (already handled by cron's retry logic, but check if both LCDs are down)
   - **Astroport TRPC 500 "Pool not found"** → handled gracefully (pool flagged deprecated, run continues)
   - **GitHub 422 "no changes"** → benign, file hash matched; nothing to commit
4. The cron is stateless — just trigger a manual run after fixing the root cause

The website is designed to gracefully degrade if a data repo goes stale — it'll show "data N hours old" rather than crash. That said, none of these crons should stay broken for long; aim for fix-within-24h.

---

## Tool ↔ cron compatibility

The TLA tool (`tla-tool_ext.html` at thealliancedao.com) can render the dashboard **either**:

1. **From cron data** (default) — reads the data repos directly
2. **From live API calls** (fallback) — pulls fresh from Eris, Astroport, Terra LCDs directly

The toggle is a one-liner at the top of the tool's code. Use the cron path for fast loads; use the live path if any cron is stale or broken.

This is intentional redundancy. The crons are the primary system but the tool can always operate standalone if needed.

---

## Project status & roadmap

This section captures cross-cutting context that doesn't fit any single cron's README. Keep it current so jumping between work sessions doesn't lose the thread.

### Strategic direction (decided 2026-05-17)

What makes TLA Stats different from the official Eris UI:

1. **Portfolio Tracker** — "Is my position actually growing? Am I earning the advertised APR? Is the LP healthy or harvesting value out of me?" Eris is the protocol; they can't tell users this. A third-party analytics site can.
2. **LP Performance & Health Scoring** — multi-epoch data that resists gaming. "Which LPs deserve votes based on data, not bribes." Surfaces ungameable history (24h data is gameable; sustained metrics over N epochs are not).
3. **Bribes Tracking** — historical view of who bribes what, with what, when.
4. **Vote Intelligence** — recommendations grounded in independent data.

The Eris UI shows current pool state well. Our value-add is **time + verification**, not "we have better APR numbers."

### Page structure decided

- **Overview tab**: keep, at-a-glance dashboard. Match Eris on numbers where we can; label methodology where we can't.
- **Pools + TLA Liquidity tabs**: rebuild with multi-epoch history once data accumulates.
- **Rankings tab**: remove (marginal value, takes effort to maintain).
- **aDAO tab**: keep.
- **Member Stats**: promote to header-level Portfolio Tracker (separate page, accessed from header dropdown).

### History strategy

**Forward-only chain-based capture. Accept 4-month wait.**

Investigated backfilling 4 months of Astroport history; concluded it's not feasible without paid archive node access. Public LCDs prune state after ~100 blocks (~10 min). Tendermint RPC disabled. Astroport's API has no historical endpoint.

Decision: start forward-looking accumulation today (most crons are already doing this; adao-positions was the gap, now fixed). In 4 months we have 4 months of trustworthy data. Eris doesn't keep this data — they discard old epochs from their UI — so the dataset itself becomes the moat.

### Data trust assessment

What's reliable vs. what isn't, as of 2026-05-17:

| Source | Status |
|---|---|
| TLA Snapshot (pools, VP, totals, depth, votion VP) | ✅ Matches Eris consistently |
| Network & Prices (LUNA, major tokens) | ✅ Reliable for 27 tracked tokens |
| aDAO Positions (raw position data per member) | ✅ Matches Eris per-wallet |
| NFT Inventory | ✅ 100% capture, cross-verified |
| Marketplace Stats | ✅ Matches BBL/Boost UIs |
| Votion (per-epoch JSONs) | ✅ Persists correctly |
| Bribes History | ✅ Comprehensive |
| Skeleton Swap (BackBone aggregator) | 🔴 Source unreliable — frozen ~30 days |
| APR computation | 🟡 Methodology differs from Eris (TLA-staked vs depth denominator) — both correct, measure different things |
| USDC-USDT, USDC-EURe APRs | 🟡 5× too high vs Eris — undiagnosed |

### Known issues across the system

These span multiple components. Per-component issues live in that component's README.

| Issue | Where | Severity |
|---|---|---|
| Skeleton Swap data frozen | upstream BackBone aggregator | 🔴 Critical — labeled "unverified" |
| Null-dex unnamed pool inflates Astroport count by 1 | `tla-snapshot` classifies; dashboard reads | 🟢 Cosmetic |
| LUNA-arbLUNA duplicate entries (same name+dex+bucket) | `tla-snapshot` raw data | 🟢 Cosmetic — dashboard now keys on `gauge_pool_id` to handle it |
| LUNA-USDC bribe IBC denom not in network-and-prices | `network-and-prices` 27-token list | 🟡 Real gap — that one bribe shows as $0 |
| APR for stable pairs (USDC-USDT, USDC-EURe) 5× too high | `tla-snapshot` APR formula | 🟡 Undiagnosed |
| `adao-positions` cron is weekly on Render | Render schedule | 🟡 Blocks Portfolio Tracker — needs to be daily |

### Roadmap (priority order)

#### P1 — Immediate
- [ ] Switch `adao-positions` Render schedule from weekly to daily (`0 1 * * *`)
- [ ] Update `next_expected_run_at` constant in `adao-positions.js` from 7 days to 25 hours
- [ ] Push current `tla-stats.html` to thealliancedao.com (bribes fix + member overlay)

#### P2 — Small bugs (one session each)
- [ ] Diagnose USDC-USDT / USDC-EURe APR outliers — likely tied to stable-pair price normalization
- [ ] Fix null-dex pool classification in `tla-snapshot`
- [ ] Add IBC denom resolution for known TLA bribes (`ibc/8D8A7F...` for LUNA-USDC, plus others as discovered)

#### P3 — Medium work (multi-session)
- [ ] **Chain-direct Skeleton Swap capture cron** — frees us from BackBone aggregator dependency
- [ ] **Match Eris APR methodology** — one-line change in `tla-snapshot` cron formula (`/staked_in_tla_usd` → `/depth_usd`). All downstream APRs match Eris exactly.
- [ ] Add chain-direct verification to Astroport cron — hourly query of each pool's `{pool:{}}` to cross-check reserves against the API

#### P4 — Major builds (after data accumulates 2-4 weeks)
- [ ] **Portfolio Tracker page** — per-member time-series of position value, fees earned, P&L. Uses `adao-positions-data_2026/data/daily/*.json` history.
- [ ] **LP Health Scoring** — composite from sustained depth, volume, fees, holder diversity, oracle source. Multi-epoch resistance to gaming.
- [ ] **Pools + TLA Liquidity tabs rebuild** — full historical view.

### Working style notes

- Same filenames on re-upload — no `_v2` suffixes
- One change at a time, verify, then next change
- Always test against real production data before declaring ready — static JS syntax check is not enough
- Preserve existing rendering code in `tla-stats.html` (~7000 lines of polished UI)
- Accuracy and reliable data are non-negotiable; would rather remove a page than ship untrustworthy data

### Project-wide changelog

Reverse chronological. New entries at the top. Cross-cutting changes only; per-cron changes live in that cron's README.

#### 2026-05-17
- **Audit + persistence sweep**: full audit of every cron's data quality. Three findings — see "Data trust assessment" above. Updated `adao-positions` to persist daily snapshots (was weekly only). Enriched `astroport` with 5 new fields (fees, reserves, LP supply, staked liquidity, assets JSON) needed for LP health scoring.
- **Dashboard `tla-stats.html`**: shipped Member Data overlay (header dropdown + member tiles + pie/waterfall/threshold integration), keyed on `gauge_pool_id` for unique pool ID. Fixed `resolveTokenPriceFromInfo` bug that priced cw20 bribe tokens as $0 (Epoch Bribes tile $820 → $1,300, ~58% increase, more accurate).
- **Strategic direction agreed**: forward-only chain-based history, four-month accumulation period, four major pages (Overview / Pools+Liquidity / aDAO / Portfolio Tracker).

#### Earlier
- 2026-05-15: `nft-inventory` and `marketplace-stats` crons deployed.
- 2026-05-12: `astroport` cron started writing dated daily CSV backups (previously rolling-only).
- 2026-05-13: `tla-snapshot` started writing `data/daily/YYYY-MM-DD.json` at hour 23.
