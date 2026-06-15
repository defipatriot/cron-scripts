# Network & Prices Cron (v2)

Daily snapshot of Terra network state, LST exchange rates, and token USD prices from **two independent oracle sources** (Astroport DEX + CoinGecko) with side-by-side comparison and match-quality classification.

**Data store:** [`defipatriot/network-and-prices-data_2026`](https://github.com/defipatriot/network-and-prices-data_2026)

---

## ⚠️ Pricing Doctrine (current — updated 2026-06-14)

**This supersedes the older "pick CoinGecko on mismatch" logic described below.**
Full rationale in `website-adao-core/PRICING-DOCTRINE.md`.

The rule: **match the price source to the asset's liquidity.**

- **Tier 1 — big, liquid assets** (LUNA, wBTC, USDC, ATOM): CoinGecko is reliable
  (many CEX feeds) → use it directly.
- **Tier 2 — small / derivative tokens** (arbLUNA, ampLUNA, bLUNA, ampCAPA,
  ampROAR, xASTRO): do NOT trust a direct CoinGecko or single-pool price (CoinGecko
  isn't motivated to keep small-caps fresh; a thin Astroport pool can be stale/
  manipulated). Instead **DERIVE**: `final = CoinGecko base price × on-chain Eris
  ratio`. Both inputs are rock-solid (a big-liquid price CG nails + a chain-truth
  ratio). This is the `final_price_usd` / `calculated-eris` path.

**Cross-check, never override:** the single-pool "market" price is still read and
recorded (`pool_market_price_usd`, `price_divergence_pct`, `price_divergence_flagged`)
as a DATA-QUALITY signal. If it diverges >10% from the derived price, it FLAGS the
pool as suspect — it does NOT change our price. (Proven: the arbLUNA pool read ~14%
low and the bLUNA pool ~76% low; the hub-derived price matched CoinGecko within
1.6% and was correct.)

**Output fields per Tier-2 token:** `hub_price_usd`, `pool_market_price_usd`,
`price_divergence_pct`, `price_divergence_flagged`, `price_selection`
(`hub-ratio-primary`), `final_price_usd`, `final_source`.

**The lesson:** "market" is not automatically right — a thin pool can be the broken
one. Validate against an independent aggregator before ever flipping a price.

---

## Why this cron exists

The dashboard reads this cron's output instead of hitting CoinGecko and Astroport directly. Three reasons:

1. **No per-user API calls to third-party oracles.** A dashboard with 100 visitors stops being 100 CoinGecko hits — it's 100 GitHub CDN reads (free, unlimited, instant).
2. **Predictable freshness.** Output includes `nextRefreshExpectedAt` so the dashboard shows "next update in 47m" countdown. No mystery about how fresh the data is.
3. **Rate-limit insulation.** CoinGecko free tier limits per-IP. Centralizing all CG calls to one cron with 24 calls/day stays well within limits forever, even if dashboard traffic spikes.

The cron is intentionally hourly (not every minute, not daily): fresh enough for casual dashboard browsing, infrequent enough to avoid any rate-limit risk, and aligned with deving.zones NFT data so the dashboard countdown can cover both.

---

## What it captures

### Network state (Terra LCD)

Total supply, bonded LUNA, percent staked, inflation, community tax, annual provisions, staking APR + APY (weekly + daily compound), Gini coefficient, Nakamoto index, top-5 voting power share, full 100-validator list with stake + commission, latest block.

### LUNA market data (CoinGecko)

USD price, market cap, FDV, circulating supply, 24h/7d/30d price changes, ATH/ATL.

### LST exchange rates (chain queries)

For ampLUNA, arbLUNA, ampROAR, ampCAPA, bLUNA — direct chain query of each Eris hub contract. For xASTRO — Astroport TRPC (Neutron-side staking APY + USD prices).

### Token prices from TWO sources, side-by-side

For every tracked token, the snapshot includes:

- **Astroport price** — DEX-implied USD (from `tokens.getMetrics` bulk endpoint, one call returns ~620 tokens across phoenix-1 + neutron-1)
- **CoinGecko price** — third-party reference (from `simple/price` with `precision=18` so tiny values like ROAR don't round to $0)
- **Delta** — `(astroport - coingecko) / coingecko × 100`
- **Match quality** — classification (see below)
- **Final price** — the picked price the dashboard should use
- **Final source** — which oracle was selected, with reasoning

### Calculated LST prices

For tokens like ampLUNA / arbLUNA / bLUNA / ampCAPA / ampROAR — derived as `basePrice × chainRatio` because Astroport often doesn't list LSTs directly and CG ratios lag. Chain ratios are real-time truth.

---

## Match quality classification

| Quality | Meaning | Final source picked |
|---|---|---|
| `direct_match` | Astroport and CG agree within ±5% | Astroport (DEX implied is canonical for on-chain swaps) |
| `minor_disagreement` | Sources differ 5-25% | Astroport (still within DEX slippage tolerance) |
| `flagged_mismatch` | Sources differ >25% | CoinGecko (Astroport oracle likely broken/stale) |
| `astroport_only` | Astroport has it, CG doesn't | Astroport |
| `cg_only` | CG has it, Astroport doesn't price it | CoinGecko |
| `astroport_zero_cg_only` | Astroport returned $0 but CG has a price | CoinGecko |
| `cg_zero_astroport_only` | CG returned $0 but Astroport has a price | Astroport |
| `calculated` | LST derived from chain ratio × base price | Calculated (most accurate for LSTs) |
| `both_zero` | Both sources say $0 | None |
| `no_price` | Neither source has a price | None |

The dashboard color-codes by quality so users can see at-a-glance which prices are well-supported vs. uncertain.

---

## Multi-chain handling

Some tokens exist on multiple chains (ASTRO is on both Terra `phoenix-1` and Neutron `neutron-1`). The cron captures **every chain's Astroport price** in the `all_chains` field for transparency, then picks the preferred one based on `preferChain` config.

Example: ASTRO's Terra Astroport price is currently stale ($0.0078) while Neutron's matches CoinGecko ($0.0010). The registry sets `preferChain: 'neutron-1'` so the final price is the Neutron one, but the Terra price stays visible in the output for debugging.

---

## How the address registry works

The Astroport metrics endpoint is keyed by **chain address**, not symbol. So the cron maintains a `TOKEN_REGISTRY` mapping each tracked symbol to its on-chain address(es).

### Bridged tokens (forward-compat)

For bridged variants like `wBTC.axl` — when discovered later (during the `tla-snapshot` cron's pool discovery), the cron will recognize them as a bridged token of a base asset, look up the base's Astroport price, and tag the entry as `bridged_proxy`. The current cron doesn't do bridged-token discovery itself; that's `tla-snapshot`'s job.

### Adding new tokens

When PD whitelists a new TLA pool with a token not yet in the registry, edit `TOKEN_REGISTRY` and add an entry like:

```js
NEW_TOKEN: {
    cgId: 'coingecko-id-or-null',
    astroportAddresses: { 'phoenix-1': 'terra1...' },
    preferChain: 'phoenix-1',
}
```

The cron picks it up on next run. Tokens missing from the registry are simply not priced — they don't crash the cron.

---

## How it works (timing-wise)

1. Phase 1-5 run in parallel via `Promise.allSettled` (~1-2 seconds combined)
   - Terra LCD network stats
   - CoinGecko LUNA detail
   - LST chain ratios (5 hubs + xASTRO via Astroport TRPC)
   - Astroport `tokens.getMetrics` (one call, ~290 KB, 623 tokens)
   - CoinGecko `simple/price` (one call, all tracked tokens)
2. Phase 6 (synchronous) — assemble per-token price table with match quality
3. Push to GitHub (2 commits: latest + dated daily)

Total runtime: **~2 seconds**.

---

## Run locally

```bash
node network-and-prices.js
```

Without `GITHUB_TOKEN`, saves locally.

---

## Render configuration

| Setting | Value |
|---|---|
| Type | Cron Job |
| Root Directory | `network-and-prices` |
| Build Command | `npm install` |
| Command | `node network-and-prices.js` |
| Schedule | `40 * * * *` (every hour at :40) |

The schedule is hourly so the dashboard's cached prices stay within 1 hour of true. Aligns with deving.zones NFT data (also hourly) so dashboards can show ONE "data refreshes in N minutes" countdown for both data sources.

### Environment variables

```
GITHUB_TOKEN     # PAT with write scope on network-and-prices-data_2026
GITHUB_REPO      # defipatriot/network-and-prices-data_2026
GITHUB_BRANCH    # main
```

---

## Reliability

- **LCD fallback**: primary `terra-lcd.publicnode.com`, fallback `terra-rest.publicnode.com`
- **3-try exponential backoff** on all HTTP calls
- **Section-level isolation**: each phase wrapped in `Promise.allSettled` so a single failure doesn't kill the run
- **Stateless** — every run is a complete rebuild; failures self-heal on next run

---

## Output schema

See [`network-and-prices-data_2026/README.md`](https://github.com/defipatriot/network-and-prices-data_2026/blob/main/README.md).

---

## Schema versioning

- **v1**: Initial — token prices were a flat map with one source per token
- **v2** (current): Dual-source price comparison with match_quality classification, multi-chain Astroport prices, calculated LST derivations

Consumers should check `schemaVersion` and handle both shapes.
