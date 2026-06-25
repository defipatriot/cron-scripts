# Address-Catalog Cron

The platform's **single "who do we track" registry.** Discovery used to happen in
five crons (`adao-positions`, `adao-allies`, `tla-locks`, `tla-participants`,
`tla-chain-registry`), each re-deriving who exists. This cron does it **once** and
publishes one catalog every other cron reads — so discovery is no longer duplicated,
and onboarding a new ally is a single config row.

## Output

Writes into the unified **`tla-core`** repo as the `catalog/` module (no separate data repo — keeps your GitHub clean, future years merge in under the same module):

- `catalog/current.json` — full registry
- `catalog/heartbeat.json` — standard heartbeat contract (`next_expected_run_at`, `status`, per-slug counts)

`catalog.json` shape:

```
meta             { version, schemaVersion, generated_at, epoch, status, source }
retention_policy { adao:'all', tla_locks:'all', pixellions:'registered_only', liondao:'registered_only' }
slugs[]          per-entity block { slug, name, type, stake_type, retention, status,
                   voting_module, total_count, registered_count, kept_count, [lock_tokens] }
counts           { total_address_rows, unique_addresses, by_slug{} }
addresses[]      one row per (address, slug): { address, slug, type, handle, retention,
                   stake_raw, vp_pct_of_dao, source }
by_address{}     index: address -> { handle, memberships:[{slug,type,stake_raw,vp_pct_of_dao}] }
```

Downstream crons read `addresses` (filter by `slug`/`retention`) or `by_address`.

## Adding an ally (the give-back model)

Append **one row** to `TRACKED` at the top of `address-catalog.js`. Nothing else
in the platform changes — the catalog discovers them and every downstream cron
starts tracking them on the next run. Example (future Solid alliance):

```js
{ slug:'solid', name:'Solid', stakeType:'cw20', retention:'registered_only',
  type:'ally_member', coreAddress:'terra1...' }
```

## Discovery methods (`stakeType`)

| type   | how                                                   | used by            |
|--------|-------------------------------------------------------|--------------------|
| `nft`  | `daoVotingCw721Staked` -> `topStakers`                | aDAO, Pixel Lions  |
| `cw20` | `daoVotingCw20Staked` -> `topStakers`                 | Lion DAO (ROAR)    |
| `token`| `daoVotingTokenStaked` -> `topStakers`                | (future)           |
| `lock` | veLUNA CW721 `all_tokens` enumeration + `owner_of`    | TLA Lock Holders   |

`votingModule` is resolved from the DAO `coreAddress` unless an override is given
(aDAO uses the proven override). `lock` needs no core.

## Retention

- `all` — keep every address (named + anonymous); anonymous kept for the record with `handle:null`. Our own entities (aDAO, TLA locks).
- `registered_only` — keep only PFPK-named addresses; anonymous are **counted** (`total_count`/`registered_count`) but **not stored**. Allies — a give-back to identifiable community members.

## Render setup

New service:
- Root dir: `cron-scripts/address-catalog`
- Build: `npm i` (uses shared `../lib`)
- Start: `node address-catalog.js`
- Schedule: daily is plenty (membership moves slowly); `RUN_EVERY_HOURS` env tunes the heartbeat's expected cadence.
- Env: `GITHUB_TOKEN` (required to publish), `GITHUB_REPO` (optional, defaults to `defipatriot/tla-core`)

Without `GITHUB_TOKEN` it writes `catalog.json` + `heartbeat.json` locally only — handy for a first dry run.

## Recent changes

- **1.0.0** — initial. Config-driven discovery (nft/cw20/token/lock), PFPK handle
  resolution for all methods, per-entity retention, one catalog + heartbeat.
  Reuses `lib/capture-engine.js` + `lib/ally-capture.js`. null != [] guards on lock
  enumeration (matches `tla-participants`).
