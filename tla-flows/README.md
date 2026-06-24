# tla-flows

Resumable capture of TLA **deposits, withdrawals, claims, and zap entry-costs** via LCD
`tx_search`. Captures the two things the daily `adao-positions` snapshots **cannot** recover
after the fact — the exact intra-day **moment of each claim** and each deposit's **zap
slippage** (from the receipt at its block).

Code lives here in `cron-scripts/tla-flows/`. Output lands in the **unified `tla-core` repo**
as the `flows` module, mirroring the `fuel` skeleton.

## Output layout (in `tla-core`)

```
flows/
  events/
    heartbeat.json        standard heartbeat (schemaVersion/cron/capturedAt/runId/runMode/status/stats/next_expected_run_at)
    index.json            manifest: latest_height, latest_date, total_events, by_type
    cursor.json           resumption state (last processed height)
    2026/06/24.jsonl      append-only event ledger, year/month/day partitioned
```

## How it stays complete (cursor, not always-on)

read `events/cursor.json` → `tx_search` the 6 watched contracts for `tx.height >= cursor`
→ classify each new tx (dedupe by txhash) → append to `events/YYYY/MM/DD.jsonl` → write
index → **advance cursor LAST** → heartbeat. A crash leaves the cursor unmoved, so the next
run re-reads that window — no missable gap. Any query error returns **without advancing**
(fail-safe). `tx_search` is a plain REST query (not a websocket subscription), so it runs on
the free public LCD — no dedicated RPC.

**First run self-bootstraps:** with no cursor and no `TLA_START_HEIGHT`, it starts
`TLA_LOOKBACK` blocks (~2h) behind the chain head, so `node tla-flows.js` just works.

## Record shape (one JSON object per line)

`txhash`, `height`, `timestamp` (exact when — closes the claim-timing band) · `type`
(deposit|withdraw|claim), `mechanism` (amplified|non_amplified), `via_zap` · `user`,
`amount`, `amount_unit` (amplp|shares|lp) · `cost` (entry/exit slippage, deposits AND
withdrawals): `swaps[]` — every swap leg (a non-LUNA exit is multi-hop) with
`spread_amount`/`commission_amount`/`leg_cost_pct` — plus `provide_slippage_pct` for
imbalanced "Tokens" deposits · `raw_actions`. Cross-denom legs are kept raw; the analysis
layer prices the single-number rollup.

## Watched contracts (6 shared — covers every pool)

One compounder (all amplified) + four bucket staking contracts (all non-amp) + the zapper.
Share custody is centralized, so these six catch every pool; a new pool in an existing bucket
needs no change.

## Run

No npm install needed — only Node 18+ built-ins (`fetch`, `fs`).

- Parser check (no network): `node tla-flows.js --selftest`
- Live run: `node tla-flows.js` (writes to `./out/flows/` by default)

## Deploy (Render)

Every ~15 min: `node tla-flows.js`, with `TLA_OUT_DIR` pointed at the `flows/` dir of your
`tla-core` checkout (the dir your commit step pushes). Env: `TLA_LCD` (default publicnode),
optional `TLA_START_HEIGHT` / `TLA_LOOKBACK`.

## Backfill is the same loop

Pointed at a genesis `TLA_START_HEIGHT` instead of the cursor, this **is** the bribes/votes
backfill — one tool, two jobs. (Deep historical backfill may need an archive endpoint; only
affects the backfill direction.)

## First-run checks (sandbox couldn't reach Terra)

- Confirm `tx_search` works on the chosen LCD (plain query — expected to, unlike the websocket).
- Confirm the live event nesting matches the parser (SDK builds vary; logic is fixture-proven).
- Confirm `zap.pct_cost` reads the real swap `spread_amount` (self-test used placeholders).

## Recent changes

- **Rev A.3** — upgraded cost capture from deposit-only single-swap to full entry/exit
  slippage for **both** deposits and withdrawals: collects every swap leg (a withdraw zapped
  to a non-pool token like USDC is multi-hop) and the `provide_liquidity` slippage of
  imbalanced "Tokens" deposits. Field renamed `zap` → `cost`. Verified against real receipts:
  exit-to-LUNA 0.05% vs exit-to-USDC 0.43% on the same position; imbalanced Tokens deposit
  1.05%. Flow classification unchanged (still 42/42 on real data).
- **Rev A.2** — re-pointed output into the unified `tla-core` repo as the `flows` module
  (was a standalone `*-data_2026` plan); matched the `fuel` heartbeat schema + year/month/day
  partitioning; added chain-head self-bootstrap for the first run. Parser unchanged
  (still verified in `--selftest` against the three real on-chain txs).
- **Rev A.1** — initial build: tx_search core, 6-contract watch, cursor/heartbeat, zap-cost
  extraction; parser verified against the three real txs.
