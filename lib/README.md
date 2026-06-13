# lib/ — shared cron modules

## capture-engine.js

The DAO-agnostic per-address TLA position capture, extracted from
`adao-positions.js` (2026-06-13) so every member-tracking cron shares ONE
tested core instead of copy-pasting drift-prone logic.

**Who imports it:** `adao-positions`, and (planned) `tla-participants`,
`pixellions-positions`, `liondao-positions`. Each cron keeps only its own
member-discovery + output; the expensive position logic lives here.

**Import (from any cron folder — Render clones the whole repo, so `../` resolves):**
```js
const { loadSharedData, fetchMemberPortfolio } = require('../lib/capture-engine.js');

const ctx = await loadSharedData();                    // pools, prices, lst ratios, amp configs, zluna ratio
const portfolio = await fetchMemberPortfolio(member, ctx);  // member = {address, name?, nft_count?, vp_pct_of_dao?, nft_image_url?}
```

`fetchMemberPortfolio` returns the full position object: `lp_positions`,
`pending_rewards`, `voting`, `pending_rebase`, `locks`, `pending_bribes`,
`wallet_balances`, and a computed `summary`. It works for ANY wallet — it
does not know or care how the address was discovered.

**Also exported** (so crons reuse them for discovery + ad-hoc queries):
`computeMemberSummary`, `queryContract`, `fetchBankBalances`, `fetchJson`,
`fetchText`, `encodeQuery`, `parallelMap`, `bech32AddressToHex`,
`currentEpochInfo`, `PFPK_BASE_URL`, `BATCH_CONCURRENCY`, `BUCKETS`, and the
TLA contract constants.

**Not here (cron-side only):** member discovery, treasury/council wallet
lists, rollups, GitHub publish, heartbeat/fingerprint, `main`.

### Recent changes
- **2026-06-13 — v1.1.** Foundation enrichment (additive — no existing field changed):
  - `portfolio.first_participation` `{period, approx_date, source}` — chain-native
    tenure via the gauge contract's `user_first_participation` query (null for
    wallets that lock/hold but never voted).
  - Each lock now carries `end_period`, `is_auto_max_locked`, `weeks_to_unlock`
    (parsed from the raw `end`, which is `{period:N}` or `"permanent"`). Fixes the
    consumer-side "end period None" — the flat fields are now present.
  - `summary.inactive_lp_usd` + `inactive_take_exposure_usd` (inactive LP value ×
    10% take rate — value at risk in sub-threshold pools).
  - `summary.current_vp_human` / `potential_vp_human` / `vp_gap_human` — the
    stale-VP spread (current actual vs potential-if-relocked, absolute gap).
- **2026-06-13 — v1.0.** Extracted verbatim from `adao-positions.js` (no logic
  change — same function bodies, same behavior). adao-positions slimmed
  1,723 → ~690 lines and now imports this. Verified: engine syntax-checks,
  all exports present, bech32 + epoch helpers produce correct live values,
  slim cron calls no engine internals directly (only through the public API).
