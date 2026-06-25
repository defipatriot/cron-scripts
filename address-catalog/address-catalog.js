// =============================================================================
// Address-Catalog Cron — the platform's single "who do we track" registry
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// Member/holder discovery was happening in five places (adao-positions,
// adao-allies, tla-locks, tla-participants, tla-chain-registry), each
// re-deriving "who exists." This cron does it ONCE: it reads a config (TRACKED),
// discovers every address per the right method, resolves PFPK handles, applies
// each entity's retention rule, and writes ONE catalog file. Every portfolio /
// history cron then reads this catalog instead of re-discovering — discovery is
// done once, and onboarding a new ally is a single config row.
//
// EXTENSIBILITY (the give-back model)
// -----------------------------------
// Adding an ally = append ONE row to TRACKED, e.g. a future Solid alliance:
//   { slug:'solid', name:'Solid', stakeType:'cw20', retention:'registered_only',
//     type:'ally_member', coreAddress:'terra1...' }
// The catalog resolves its voting module, pulls stakers, keeps the registered
// (named) ones, tags them, and every downstream cron starts tracking them on the
// next run. No code changes anywhere else.
//
// DISCOVERY METHODS (stakeType)
//   nft   -> daoVotingCw721Staked   (NFTs staked to a DAODAO DAO)
//   cw20  -> daoVotingCw20Staked    (cw20 token staked, e.g. ROAR)
//   token -> daoVotingTokenStaked   (native / tokenfactory staked)
//   lock  -> veLUNA CW721 all_tokens enumeration + owner_of  (no DAO core)
//
// RETENTION
//   all              -> keep EVERY address (named + anonymous). Our own entities;
//                       anonymous kept "for the record" with handle:null.
//   registered_only  -> keep only PFPK-named addresses. Allies (give-back to
//                       identifiable community members). Anonymous are counted
//                       but NOT stored.
//
// OUTPUT — into the unified `tla-core` repo as the `catalog` module (no scattered
// per-cron data repo; future years merge in under the same module):
//   catalog/current.json   full registry (addresses + per-slug blocks + by-address index)
//   catalog/heartbeat.json standard heartbeat contract
// Membership moves slowly, so this module is daily + simple — no intra-hour tiers
// (cadence is per-module; fuel's hourly/daily/yearly ladder is for the metric modules).
//
// Reuses the proven shared engine in cron-scripts/lib (capture-engine, ally-capture).
// Render: new service, root dir cron-scripts/address-catalog, build `npm i`,
//         start `node address-catalog.js`, env GITHUB_TOKEN + (optional) GITHUB_REPO.
// =============================================================================

'use strict';
const fs = require('fs');
const https = require('https');

const {
  queryContract,
  fetchJson,
  parallelMap,
  bech32AddressToHex,
  currentEpochInfo,
  PFPK_BASE_URL,
  PFPK_TIMEOUT_MS,
  BATCH_CONCURRENCY,
  TLA_VOTING_ESCROW,
} = require('../lib/capture-engine.js');

const { resolveVotingModule, fetchStakers } = require('../lib/ally-capture.js');

// -----------------------------------------------------------------------------
// CONFIG — the entire "who do we track" policy lives here. One row per entity.
// To onboard a new ally: append a row. Nothing else in the platform changes.
// -----------------------------------------------------------------------------
const TRACKED = [
  // ---- OUR entities — retention 'all' (registered + anonymous, kept for record)
  {
    slug: 'adao',
    name: 'Alliance DAO',
    stakeType: 'nft',
    retention: 'all',
    type: 'adao_staker',
    coreAddress:  'terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm',
    votingModule: 'terra1c57ur376szdv8rtes6sa9nst4k536dynunksu8tx5zu4z5u3am6qmvqx47', // proven (adao-positions); resolveVotingModule(core) used if omitted
  },
  {
    slug: 'tla_locks',
    name: 'TLA Lock Holders',
    stakeType: 'lock',
    retention: 'all',
    type: 'lock_holder',
    // no DAO core — discovered by enumerating the veLUNA voting-escrow CW721
  },

  // ---- ALLIES — retention 'registered_only' (give-back: identifiable members only)
  {
    slug: 'pixellions',
    name: 'Pixel Lions',
    stakeType: 'nft',
    retention: 'registered_only',
    type: 'ally_member',
    coreAddress: 'terra1c690mdrwdetnr09zfk3tf9xz9jhrgd9wpjyf3tuccj74ql09eqmq6sh7en',
  },
  {
    slug: 'liondao',
    name: 'Lion DAO',
    stakeType: 'cw20',
    retention: 'registered_only',
    type: 'ally_member',
    coreAddress: 'terra1tkersa2mqwy2h8exj799qx2xrhdu0dkymk9psp6v0k4kz4tkxucssgluec',
  },
];

const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const GITHUB_REPO     = process.env.GITHUB_REPO   || 'defipatriot/tla-core';
const GITHUB_BRANCH   = process.env.GITHUB_BRANCH || 'main';
const RUN_EVERY_HOURS = Number(process.env.RUN_EVERY_HOURS || 24); // catalog cadence (membership moves slowly)

// -----------------------------------------------------------------------------
// PFPK handle resolution — for ALL methods (incl. locks), not just ally stakers.
// Failures leave handle:null (never throws away an address on a name miss).
// -----------------------------------------------------------------------------
async function resolveHandles(rows) {
  let named = 0;
  await parallelMap(rows, async (m) => {
    try {
      const hex = bech32AddressToHex(m.address);
      const data = await fetchJson(PFPK_BASE_URL + hex, 'pfpk', PFPK_TIMEOUT_MS);
      if (data && data.name && String(data.name).trim()) { m.handle = String(data.name).trim(); named++; }
      else m.handle = null;
    } catch { m.handle = null; }
  }, BATCH_CONCURRENCY);
  return named;
}

// -----------------------------------------------------------------------------
// DISCOVERY: lock holders — veLUNA CW721 all_tokens enumeration + owner_of.
// Mirrors tla-participants exactly (null != [] guard; per-owner lock tally).
// -----------------------------------------------------------------------------
async function discoverLockHolders() {
  const numTokens = await queryContract(TLA_VOTING_ESCROW, { num_tokens: {} });
  const expected = numTokens && typeof numTokens.count === 'number' ? numTokens.count : null;

  const tokenIds = [];
  let startAfter, pages = 0, enumerationOk = true;
  while (true) {
    const query = { all_tokens: { limit: 100, ...(startAfter !== undefined ? { start_after: startAfter } : {}) } };
    const page = await queryContract(TLA_VOTING_ESCROW, query);
    pages++;
    if (page === null) {                       // failed query (NOT end-of-list)
      enumerationOk = false;
      console.error(`  ✗ all_tokens page ${pages} returned null — enumeration INCOMPLETE`);
      break;
    }
    const ids = Array.isArray(page.tokens) ? page.tokens : [];
    if (ids.length === 0) break;               // genuine end of enumeration
    tokenIds.push(...ids);
    startAfter = ids[ids.length - 1];
    if (ids.length < 100) break;               // last partial page
    if (pages > 60) { console.warn('  ⚠ all_tokens > 60 pages — stopping defensively'); enumerationOk = false; break; }
  }
  console.log(`  enumerated ${tokenIds.length} lock token_ids across ${pages} page(s)`);
  if (expected != null && tokenIds.length < expected && enumerationOk) {
    console.warn(`  ⚠ enumerated ${tokenIds.length} < expected ${expected} — possible truncation`);
    enumerationOk = false;
  }

  const owners = new Map();   // address -> lock count
  let ownerErrors = 0;
  await parallelMap(tokenIds, async (tokenId) => {
    const res = await queryContract(TLA_VOTING_ESCROW, { owner_of: { token_id: tokenId } });
    if (res && res.owner) owners.set(res.owner, (owners.get(res.owner) || 0) + 1);
    else ownerErrors++;
  }, BATCH_CONCURRENCY);
  console.log(`  ✓ ${owners.size} unique lock holders (${ownerErrors} owner_of errors)`);

  const rows = [...owners.entries()].map(([address, n]) => ({
    address, stake_raw: n, vp_pct_of_dao: 0, source: 'veluna_cw721',
  }));
  return {
    rows,
    total_tokens: tokenIds.length,
    expected,
    complete: enumerationOk && ownerErrors === 0,
  };
}

// -----------------------------------------------------------------------------
// DISCOVERY: DAODAO stakers (nft / cw20 / token) via voting module + topStakers.
// votingModule resolved from the DAO core unless an override is given.
// -----------------------------------------------------------------------------
async function discoverStakers(entry) {
  let vm = entry.votingModule || null;
  if (!vm) {
    if (!entry.coreAddress) return { rows: null, voting_module: null, error: 'no coreAddress / votingModule' };
    vm = await resolveVotingModule(entry.coreAddress);
  }
  if (!vm) return { rows: null, voting_module: null, error: 'could not resolve voting module' };

  const stakers = await fetchStakers(vm, entry.stakeType);   // [{address, stake_raw, vp_pct_of_dao, source}] | null
  if (!stakers) return { rows: null, voting_module: vm, error: 'topStakers query failed' };

  const rows = stakers.map(s => ({
    address: s.address, stake_raw: s.stake_raw, vp_pct_of_dao: s.vp_pct_of_dao, source: s.source,
  }));
  return { rows, voting_module: vm, error: null };
}

// -----------------------------------------------------------------------------
// GitHub publish (mirrors the platform's standard helper)
// -----------------------------------------------------------------------------
function githubApiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com', path: apiPath, method,
      headers: {
        'User-Agent': 'address-catalog-cron/1.0',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
      },
    };
    if (body) opts.headers['Content-Type'] = 'application/json';
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else reject(new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function publishFile(filePath, content, message) {
  const apiPath = `/repos/${GITHUB_REPO}/contents/${filePath}`;
  let sha = null;
  try { sha = (await githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}`)).sha; } catch (e) { /* new file */ }
  const body = { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  return githubApiRequest('PUT', apiPath, body);
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
async function run() {
  const startedAt = new Date();
  const epochInfo = currentEpochInfo();
  console.log(`\n🚀 Address-Catalog — ${startedAt.toISOString()} — ${TRACKED.length} tracked entities\n`);

  const slugBlocks = [];
  const addresses = [];   // one row per (address, slug)

  for (const entry of TRACKED) {
    console.log(`\n🔎 ${entry.name} [${entry.slug}] — ${entry.stakeType}, retention=${entry.retention}`);
    let rows = null, voting_module = null, error = null, complete = true, expected = null, totalTokens = null;

    try {
      if (entry.stakeType === 'lock') {
        const d = await discoverLockHolders();
        rows = d.rows; complete = d.complete; expected = d.expected; totalTokens = d.total_tokens;
      } else {
        const d = await discoverStakers(entry);
        rows = d.rows; voting_module = d.voting_module; error = d.error;
      }
    } catch (e) { error = e.message; }

    if (!rows) {
      console.error(`  ✗ discovery failed: ${error}`);
      slugBlocks.push({
        slug: entry.slug, name: entry.name, type: entry.type, stake_type: entry.stakeType,
        retention: entry.retention, status: 'error', voting_module,
        total_count: 0, registered_count: 0, kept_count: 0, error,
      });
      continue;
    }

    const total = rows.length;
    console.log(`  ✓ ${total} discovered`);

    const named = await resolveHandles(rows);
    console.log(`  ✓ ${named}/${total} have PFPK handles`);

    // retention rule: allies keep only named; our entities keep everyone
    const kept = entry.retention === 'registered_only' ? rows.filter(r => r.handle) : rows;
    if (entry.retention === 'registered_only' && total - kept.length > 0)
      console.log(`  → registered_only: kept ${kept.length}, dropped ${total - kept.length} anonymous`);

    for (const r of kept) {
      addresses.push({
        address: r.address,
        slug: entry.slug,
        type: entry.type,
        handle: r.handle || null,
        retention: entry.retention,
        stake_raw: r.stake_raw ?? null,       // nft count / staked-token raw / lock count
        vp_pct_of_dao: r.vp_pct_of_dao ?? 0,
        source: r.source,
      });
    }

    const incomplete = (entry.stakeType === 'lock') ? !complete : false;
    slugBlocks.push({
      slug: entry.slug, name: entry.name, type: entry.type, stake_type: entry.stakeType,
      retention: entry.retention, status: incomplete ? 'partial' : 'ok', voting_module,
      total_count: total, registered_count: named, kept_count: kept.length,
      ...(totalTokens != null ? { lock_tokens: totalTokens, lock_expected: expected } : {}),
      error: null,
    });
  }

  // by-address index — an address can belong to several slugs (e.g. aDAO staker
  // who also holds a TLA lock). Downstream crons read this to know "who + how".
  const byAddress = {};
  for (const a of addresses) {
    const e = byAddress[a.address] || (byAddress[a.address] = { handle: a.handle, memberships: [] });
    if (!e.handle && a.handle) e.handle = a.handle;
    e.memberships.push({ slug: a.slug, type: a.type, stake_raw: a.stake_raw, vp_pct_of_dao: a.vp_pct_of_dao });
  }

  const statuses = slugBlocks.map(s => s.status);
  let overall = 'ok';
  if (statuses.length && statuses.every(s => s === 'error')) overall = 'error';
  else if (statuses.some(s => s !== 'ok')) overall = 'partial';

  const catalog = {
    meta: {
      version: 'address-catalog-1.0.0',
      schemaVersion: 1,
      generated_at: startedAt.toISOString(),
      epoch: epochInfo?.number ?? null,
      status: overall,
      source: 'address-catalog cron (cron-scripts/address-catalog)',
    },
    retention_policy: Object.fromEntries(TRACKED.map(t => [t.slug, t.retention])),
    slugs: slugBlocks,
    counts: {
      total_address_rows: addresses.length,
      unique_addresses: Object.keys(byAddress).length,
      by_slug: Object.fromEntries(slugBlocks.map(s => [s.slug, s.kept_count ?? 0])),
    },
    addresses,
    by_address: byAddress,
  };

  const heartbeat = {
    schemaVersion: 1,
    capturedAt: startedAt.toISOString(),
    runId: `catalog-${startedAt.getTime()}`,
    status: overall,
    currentEpoch: epochInfo?.number ?? null,
    unique_addresses: Object.keys(byAddress).length,
    total_address_rows: addresses.length,
    by_slug: Object.fromEntries(slugBlocks.map(s => [s.slug, s.kept_count ?? 0])),
    next_expected_run_at: new Date(startedAt.getTime() + (RUN_EVERY_HOURS + 1) * 3600 * 1000).toISOString(),
  };

  const catContent = JSON.stringify(catalog, null, 2);
  const hbContent  = JSON.stringify(heartbeat, null, 2);
  fs.writeFileSync('catalog.json', catContent);
  fs.writeFileSync('heartbeat.json', hbContent);

  if (GITHUB_TOKEN) {
    await publishFile('catalog/current.json', catContent, `catalog ${overall} — ${Object.keys(byAddress).length} addresses`);
    console.log('  ✓ catalog/current.json');
    await publishFile('catalog/heartbeat.json', hbContent, `heartbeat ${overall}`);
    console.log('  ✓ catalog/heartbeat.json');
  } else {
    console.log('  (no GITHUB_TOKEN — wrote local catalog.json + heartbeat.json only)');
  }

  console.log(`\n✅ Done — ${overall} — ${Object.keys(byAddress).length} unique addresses across ${slugBlocks.length} entities`);
  for (const s of slugBlocks) console.log(`   ${s.slug.padEnd(12)} ${String(s.kept_count).padStart(5)} kept  (${s.total_count} total, ${s.registered_count} named) — ${s.status}`);
  if (overall === 'error') process.exitCode = 1;
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
