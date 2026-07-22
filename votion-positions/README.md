# votion-positions

Captures every **Votion vault** user's position. Votion is a liquid-lock wrapper
around veLUNA: deposit an LST, receive a factory v-token share, the vault pools
everything into ONE veLUNA lock it owns and auto-compounds + auto-votes. Offered
as a **{LST} × {duration}** matrix — each cell its own contract (`code_id 3677`,
label `votion-la`).

**Why it matters:** Votion users are invisible to every other cron (their LST is
locked inside a vault's single NFT). This cron makes them visible AND
re-attributes the big "anonymous whale" lock-holders that `tla-participants`
flagged — those whales ARE the Votion MAX vaults; this cron maps that VP to the
real underlying users.

## What Votion actually does (the mechanism)
Votion is a **vote aggregator + auto-compounder**. You lock your TLA position via
Votion; it uses your VP to **chase bribes automatically**. When bribes pay out
each epoch (in CAPA, ASTRO, LUNA, etc.), Votion **swaps them all into the vault's
LST** (e.g. ampLUNA) and adds them back to the lockup pool — compounding your
position and boosting the LST APR. "Lock and chill" — max VP, auto-bribe-chasing,
auto-compounding, no manual vote management. That's why each vault's `staked`
grows over time (the daily `Compound` txs) and why the APR is a *realized* number.

## ⚠️ Pricing transparency (arbLUNA)
Verified against Votion's own UI: our **ampLUNA** USD matches within ~1.5% (clean
staking LST — hub ratio == market). But our **arbLUNA** USD runs **~14% high**:
our `network-and-prices` feed only has arbLUNA's *hub-ratio* price (LUNA × 2.952
≈ $0.1516), while arbLUNA actually trades at a *market* price (~$0.133) because
it's an arbitrage strategy, not a clean staking derivative. The vault `staked`
LST amounts match Votion EXACTLY (same `{state:{}}` query); only the USD differs,
and only for arbLUNA. Each holder's `underlying_usd` is tagged
`underlying_usd_price_source` so the UI can show **both our feed and a market /
CoinGecko feed side by side** — mismatched prices are exactly how users get
misled, so we surface the discrepancy rather than hide it. (Proper fix:
add an arbLUNA market-price source to `network-and-prices` — affects tla-locks
and portfolios too, not just Votion. Tracked separately.)

## Price source (matches Votion's own feed)
Votion prices each vault from TWO queries on the vault contract (confirmed via
HAR of votion.money → `phoenix-rpc.erisprotocol.com`):
- `{state:{}}` → `{staked}` — total underlying LST (THIS is the TVL; we use it,
  byte-for-byte match to their UI).
- `{exchange_rates:{limit:30}}` → the vault's internal share/compound rate history.

## Vault matrix (v1 seed; cron self-discovers via code_id 3677)
| | MAX | 3 Months | 1 Week |
|---|---|---|---|
| arbLUNA | `terra13aae4f…pqmye9` | `terra163jnveu…d9zj9l` | `terra16xzky47…uxkjuj` |
| ampLUNA | `terra1v7aw9e…3mffyz` | `terra1dr7mv4w…hnzm5p` | `terra1mzelg87…s0sux0` |

Cron reads each vault's REAL config on-chain (LST, vdenom, lock_id, fee), so the
labels above are cosmetic and a new vault (bLUNA row, new duration) is picked up
automatically via the code_id listing.

## How it works
1. **Discover vaults** — LCD `code/3677/contracts` (self-maintaining; seed
   fallback). Read each `config`: `lock_info.cw20` (LST), `vdenom`, `lock_id`,
   `protocol_fee` (0.1 = Votion's 10% cut).
2. **Vault state** — `staked` (total LST) ÷ vdenom supply = **exchange rate**
   (LST per vtoken; validated against a real deposit: bond_amount/bond_share).
   Vault's lock VP via escrow `lock_info{lock_id}`.
3. **Discover holders** — factory denoms have no `all_accounts`, so reconstruct
   from deposits: `tx_search` each vault for `wasm.action='votion-la/deposit'` →
   every historical `recipient`. (F1 DESC paging, F2 null≠[].)
4. **Value each holder** — current vdenom **bank balance** × exchange rate =
   underlying LST → USD (live LST ratio × LUNA price); share of supply × vault
   lock VP = implied VP. Holders who fully exited (0 current balance) are dropped.
5. PFPK names; publish.

## Output (repo: `votion-positions-data_2026`)
- `data/current.json` — per-vault system view + holders (vtoken, underlying LST,
  USD, share %, implied VP, name)
- `data/vaults.json` — light: vault list + exchange rates + lock VP + TVL
- `data/heartbeat.json`

## Scope
v1 = live holdings + per-vault system view, FULL userbase (all vdenom holders).
**v1.1 (future)** = full deposit-history backfill (every deposit, not just current
holders — already half-built since discovery walks deposit events).
**v1.2 (future)** = realized compounding yield from the daily `Compound` txs
(observed APR per vault vs Votion's quoted number — the trust-layer metric).

## Status semantics (F7)
`partial` if any vault's holder discovery was incomplete (paging cap / null page)
or a vdenom was missing; `error` if zero vaults resolved.

## Env
`GITHUB_TOKEN`, `GITHUB_REPO` (default `defipatriot/votion-positions-data_2026`
— **needs the `defipatriot/` prefix**), `GITHUB_BRANCH`.

## Render
Root `votion-positions`, build `npm install`, start `node votion-positions.js`,
daily after aDAO+TLA. LCD-heavy (tx_search per vault + bank balance per holder),
concurrency 5.

### Recent changes
- **2026-07-21 — v1.1.0 (discovery fix).** tx_search-only discovery silently ran
  on public-node TX RETENTION (~2–3 weeks): historical depositors vanished while
  `complete:true` was asserted (observed: 2 holders vs 147K vtokens outstanding;
  DeFi_Patriot's own positions invisible). Fix: candidate universe = **org
  address-catalog** (tla-core `catalog/snapshots/current.json`, 389 community
  addresses incl. all TLA lock holders) ∪ deposit-event recipients, then ONE
  `bank/balances` sweep across the union (each call answers all 6 vdenoms).
  Completeness is now **MEASURED** per vault (`supply_coverage_pct`;
  `holder_discovery_complete` = coverage ≥ 99.5%) — never asserted.
  `total_tvl_usd` now = REAL vault TVL (staked LST × ratio × LUNA); the old
  holders-only sum survives as `discovered_holders_usd`. schemaVersion **2** +
  `discovery` meta block (universe, catalog source, candidates swept).
  Gated 14/14 on the Eris-UI fixture (1,225.39 ampLUNA / 4,363.47 arbLUNA);
  first production run: 18 holders (was 2), TVL $35,105 (was $744 mislabel).
  Note: `denom_owners` LCD endpoint is NOT served by publicnode or
  phoenix-lcd (tested) — the catalog-sweep is the durable design and is what
  the future org port inherits.
- **2026-06-14 — v1.0.** Initial build. Vault discovery + holder reconstruction
  from deposit events + live valuation via vdenom bank balances. Shared engine.
