# tla-participants

Captures full TLA portfolio data for every **TLA participant** — the union of
**veLUNA lock holders** and **bribe providers**. This is the cron that surfaces
people who provide TLA liquidity but never staked an NFT into aDAO governance,
so they're invisible to `adao-positions`.

Uses the shared `../lib/capture-engine.js` for per-address position capture —
identical data shape to `adao-positions`, different discovery source.

## Discovery (both live)
1. **Lock holders** — CW721 enumeration of the voting-escrow NFT
   (`terra1uqhj8…`): `num_tokens` (sanity bound) → `all_tokens` (paginated,
   cursor = last token_id; IDs sort lexicographically, follow the contract's
   order) → `owner_of` each → dedupe to holder set. F2-guarded: a null page
   (query failed) is distinguished from an empty page (genuine end), so a
   rate-limited page can't silently truncate the set.
2. **Bribe providers** — `briber_address` deduped from
   `bribes-data_2026/data/pd-bribes-history.json` (a read, no chain query).
   Today this is just PD; the field is there for when the bribe market widens.

Union is deduped; each participant tagged `sources: ['tla_lock'|'bribe_provider']`
(or both). Names via PFPK (`pfpk.daodao.zone`), falling back to the bribe label.

## Scope (v1)
Captures **ALL** lock holders + bribers, including those who are also aDAO
members (heavy overlap is intentional — each cron answers its own question;
consumers dedupe at display by address using the source tags).

## Retention
**Live-only** for v1 — `current.json` is overwritten each run, no history yet.
Retention (registered-only or full) can be added later once the participant set
is understood. Decision 2026-06-13.

## Output (repo: `tla-participants-data_2026`)
- `data/current.json` — full portfolios, every participant, source-tagged
- `data/participants.json` — light list (address, name, sources, lock/bribe counts)
- `data/heartbeat.json` — status (`ok`/`partial`/`error`), counts

## Status semantics (F7)
- `partial` if lock enumeration was incomplete (truncation/owner errors) OR the
  bribes source failed to load.
- `error` (exit 2) if zero portfolios captured.

## Env
`GITHUB_TOKEN`, `GITHUB_REPO` (default `defipatriot/tla-participants-data_2026`),
`GITHUB_BRANCH` (default `main`).

## Render
Root directory `tla-participants`, build `npm install`, start
`node tla-participants.js`, daily schedule. `../lib/` resolves because Render
clones the whole repo.

### Recent changes
- **2026-06-13 — v1.0.** Initial build. Lock-holder ∪ bribe-provider discovery
  on the shared capture engine. Live-only retention.
