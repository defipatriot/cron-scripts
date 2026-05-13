# Votion Snapshot Cron

Captures the full state of aDAO's TLA lockup positions at the close of every epoch. Schema-rich format that mirrors what `tla-tool_ext.html` exports.

**Data store:** [`defipatriot/votion-data_2026`](https://github.com/defipatriot/votion-data_2026)

---

## What it captures

For each aDAO multisig lockup:

- **Lockup metadata**: type (amp/arb/etc.), duration, multiplier
- **Position size**: amount, equivalent LUNA, VP, USD value
- **Yield breakdown**: lock APY, LST APY, votion APY, compound APY
- **Vote allocation per bucket**: which pools the lockup is voting for, with optimization deltas vs current
- **Expected rewards** for the closing epoch

Plus top-level aggregates:
- Total VP across all aDAO lockups
- LST ratios (arbLUNA, ampLUNA, etc.) with their APRs
- LUNA + LST USD prices
- Pool-level rollup: VP-per-pool computed across all aDAO lockups

---

## How it works

1. **Fetch live epoch info** from Eris's Votion API to determine current epoch number and `voteBefore` cutoff
2. **For each lockup ID** (the 5 aDAO multisig lockups), call Eris's optimization endpoint to get the optimal vote allocation + current state
3. **Fetch LST ratios** from each LST hub contract on Terra LCD
4. **Fetch token prices** from CoinGecko (LUNA + LSTs)
5. **Derive per-lockup APYs** using the captured ratios + prices
6. **Roll up to per-pool registry** showing total VP across all aDAO lockups per pool
7. **Commit** to `votion-data_2026/votion/votion-epoch-{N}.json`

The cron is **idempotent** — running it multiple times for the same epoch produces the same output (modulo ratio/price drift between runs). In practice it runs once per epoch, locking in the pre-flip state.

---

## Run modes

This cron runs **once per epoch**, scheduled Sunday 23:55 UTC. There is no daily/weekly toggle — every run captures the current epoch.

---

## Run locally

```bash
npm install
node votion-snapshot.js
```

Without `GITHUB_TOKEN`, files write to the current directory.

---

## Render configuration

| Setting | Value |
|---|---|
| Type | Cron Job |
| Root Directory | `votion` |
| Build Command | `npm install` |
| Command | `node votion-snapshot.js` |
| Schedule | `55 23 * * 0` (Sunday 23:55 UTC) |

### Environment variables

```
GITHUB_TOKEN     # PAT with write scope on votion-data_2026
GITHUB_REPO      # defipatriot/votion-data_2026
GITHUB_BRANCH    # main
```

---

## Reliability

- **3-try exponential backoff** on Eris API + Terra LCD calls
- **LCD fallback** for LST ratio queries
- **Per-lockup isolation** — if one lockup's optimization call fails, the others still succeed; partial captures are flagged via the `fetchErrors` field
- **Schema v2** (current) preserved alongside v1 archive in the data repo

---

## Output schema

See [`votion-data_2026/README.md`](https://github.com/defipatriot/votion-data_2026/blob/main/README.md) for the complete schema definition.

---

## Schema upgrade history

- **v1** (epochs 175-184): thin wrapper over raw Eris API responses
- **v2** (epoch 185+): rich shape matching `tla-tool_ext.html` exports — includes derived APYs, USD values, per-pool rollup, source tracking, error tracking

v1 files preserved in `votion-data_2026/votion-old/` for historical reference. Schema-versioned files mean future v3 upgrades can again preserve old data without rewriting it.
