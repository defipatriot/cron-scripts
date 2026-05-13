# Bribes History Cron

Captures the complete history of TLA bribes — every `add_bribe` PD has ever proposed via their DAODAO governance, plus the current chain state of active bribes.

**Data store:** [`defipatriot/bribes-data_2026`](https://github.com/defipatriot/bribes-data_2026)

---

## What it captures

For every PD proposal containing an `add_bribe` execute message:

- **Provenance**: proposal ID, title, status, briber address, briber label
- **Bribe payload**: token (native or cw20), exact amount in micro units, target pool LP address, target gauge bucket
- **Distribution**: epoch range (start_epoch, end_epoch) and distribution function type (linear)
- **Per-epoch projection**: amount divided across the epoch range (so a 4-epoch bribe of 4000 LUNA contributes 1000 LUNA to each of its 4 epochs)

Plus the current state of the bribe-manager contract (all active bribes from all sources combined).

---

## Why this approach beats parsing proposal descriptions

PD's proposal descriptions contain human-readable bribe info, but they're subjective and error-prone (typos, formatting inconsistencies, manual edits). Instead, this cron decodes the actual **execute messages** in each proposal — base64-encoded JSON that's machine-perfect:

```json
{
  "add_bribe": {
    "bribe": { "info": { "native": "uluna" }, "amount": "8817046289" },
    "distribution": { "func": { "func_type": "linear", "start": 181, "end": 184 } },
    "for_info": { "cw20": "terra1my4tml2..." },
    "gauge": "project"
  }
}
```

Every field is structured. No regex, no parsing edge cases.

---

## Data sources

| Source | What it provides | Endpoint |
|---|---|---|
| **Terra LCD** (`terra-rest.publicnode.com`) | PD's proposal module — `list_proposals` paginated | `/cosmwasm/wasm/v1/contract/{prop_module}/smart/...` |
| **Terra LCD** | Bribe-manager contract — `{bribes:{period:null}}` for current state | Same LCD, different contract |

PD's DAO contract: `terra1k8ug6dkzntczfzn76wsh24tdjmx944yj6mk063wum7n20cwd7lxq4lppjg`
PD's proposal module: `terra1660g9mle5kfsq8c0p4k4hgr9ujdyr3m48c22cawy0akr98rmwksqehqnup`
Bribe manager: `terra1tuuwm8yrj54qeg0c8xu00aha9ryatyhtczq8qq2q8tntuw0auzas9037wh`

Discovered the proposal-module endpoint via HAR-trace of daodao.zone's PD page, then verified the chain queries work directly without going through daodao.zone's indexer — more reliable and no third-party dependency.

---

## Output files

```
bribes-data_2026/
└── data/
    ├── pd-bribes-history.json    ← Master file: every PD bribe ever
    ├── current-state.json         ← Snapshot of bribe-manager right now
    ├── bribers-registry.json      ← Briber addresses → totals, labels
    └── by-epoch/
        ├── epoch-131.json
        ├── epoch-132.json
        ├── ...
        └── epoch-184.json         ← Bribes active in each specific epoch
```

### Master file — `pd-bribes-history.json`

```jsonc
{
  "schemaVersion": 1,
  "capturedAt": "2026-05-13T08:17:29.221Z",
  "currentEpoch": 184,
  "stats": {
    "total_proposals": 243,
    "total_add_bribe_msgs": 157,
    "executed_bribes": 157,
    "epochs_with_bribes": 49,
    "pools_bribed": 23,
    "bribers": 1
  },
  "bribes": [
    {
      "source": "pd-dao",
      "briber_address": "terra1k8ug6dkzntcz...",
      "briber_label": "PD",
      "proposal_id": 234,
      "proposal_title": "[tla] Adding vote incentives based on trading efficiency...",
      "proposal_status": "executed",
      "msg_index": 0,
      "funds": [{ "denom": "uluna", "amount": "8827046289" }],
      "bribe_token": { "native": "uluna" },
      "bribe_amount": "8817046289",
      "for_pool": { "cw20": "terra1my4tml2ae4zewq0u5fpq2qzq4rdpfh5pq7y3eekxxhwxdwdmce4shw9mt4" },
      "gauge": "project",
      "distribution": { "func": { "func_type": "linear", "start": 181, "end": 184 } },
      "start_epoch": 181,
      "end_epoch": 184
    }
  ]
}
```

### Per-epoch files — `data/by-epoch/epoch-{N}.json`

Each epoch's file lists every bribe that's active in that epoch (i.e., where `start_epoch <= N <= end_epoch`), with an additional `amount_this_epoch` field showing the portion attributable to that specific epoch (= `bribe_amount / (end - start + 1)`).

### Current state — `current-state.json`

Direct passthrough of bribe-manager contract's `{bribes:{period:null}}` query. Shows all 17 (or however many) currently-active bribe buckets, with their assets and amounts.

### Bribers registry — `bribers-registry.json`

For each briber address: total bribe count, total LUNA bribed, pools bribed, first/last proposal IDs, first/last epoch bribed. Currently only PD (since we walk PD's DAO proposals). Future expansion to capture non-DAO bribers via transaction history scan is documented below.

---

## Run modes

This cron is a **full rebuild** every run — it walks all 243+ PD proposals (~3.4 seconds in production). Output files are completely regenerated, not incrementally updated. This keeps the cron stateless and resilient: if it ever fails, the next run repairs everything.

---

## Run locally

```bash
node bribes-history.js
```

Without `GITHUB_TOKEN`, saves files to the current directory.

---

## Render configuration

| Setting | Value |
|---|---|
| Type | Cron Job |
| Root Directory | `bribes-history` |
| Build Command | `npm install` |
| Command | `node bribes-history.js` |
| Schedule | `0 */4 * * *` (every 4 hours) |

### Environment variables

```
GITHUB_TOKEN     # PAT with write scope on bribes-data_2026
GITHUB_REPO      # defipatriot/bribes-data_2026
GITHUB_BRANCH    # main
```

---

## Reliability

- **LCD fallback**: tries `terra-rest.publicnode.com` first, falls through to `terra.publicnode.com` on 403/5xx
- **3-try exponential backoff** on all HTTP calls
- **Pagination cap of 50 pages** = 1500 proposals (PD DAO is at ~243 currently, plenty of headroom)
- **Stateless**: each run rebuilds the entire history from chain. No partial-state corruption possible.

---

## Future enhancements

### Capture non-PD bribers (transaction-history scan)

The current cron captures bribes added **via PD's DAO governance proposals**. But the bribe-manager contract is open to anyone — individuals can call `add_bribe` directly without going through a DAO.

To capture these:
1. Walk Terra block history filtered by `wasm.contract_address = bribe-manager`
2. Decode each `MsgExecuteContract` matching the `add_bribe` pattern
3. Group by sender address, populate the bribers registry

This is bigger lift than the current cron (transaction scans are slower than contract queries) so it's deferred. Most TLA bribes today go through DAO proposals, so coverage is good for current analysis. Add this when individual bribers start showing up.

### Label lookup via DAODAO PFPK

Bribers without a hardcoded label can be looked up via:
```
https://pfpk.daodao.zone/bech32/{address}
```
This returns the DAODAO display name (if any) for an address. Add this lookup once we have non-PD bribers to label.

### Tx hashes for prop execution

The `proposal_status: "executed"` filter is conservative — only bribes from successfully-executed proposals get counted. If a future enhancement needs the execution tx hash (for cross-referencing with chain explorers), it's available in the indexer; would need to add another query per proposal.
