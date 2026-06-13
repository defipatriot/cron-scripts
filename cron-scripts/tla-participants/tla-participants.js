// =============================================================================
// TLA Participants Cron
// =============================================================================
//
// Captures full TLA portfolio data for every TLA *participant* — defined as the
// UNION of:
//   1. All veLUNA lock holders   (CW721 enumeration of the voting-escrow NFT)
//   2. All bribe providers        (briber_address from the bribes-history feed)
//
// This is the cron that finally surfaces people who provide TLA liquidity but
// never staked an NFT into aDAO governance — invisible to adao-positions. There
// IS heavy overlap with aDAO members (many lock holders are also members); that
// is intentional. Each cron answers its own question; consumers dedupe at
// display by address using the `sources` tags.
//
// Uses the shared capture engine (../lib/capture-engine.js) for the per-address
// position logic — identical data shape to adao-positions, just a different
// discovery source.
//
// RETENTION: live-only for v1 (decision 2026-06-13). current.json is overwritten
//   each run; no daily/weekly history yet. Retention can be added later once the
//   participant set's shape is understood.
//
// Schedule:  daily (own Render service). Runtime scales with lock-holder count
//            (~431 locks → fewer unique owners; +1 briber today). Concurrency 5.
// Output:    data/current.json   (full portfolios, every participant, source-tagged)
//            data/participants.json (light: address + name + sources, no positions)
//            data/heartbeat.json
//
// =============================================================================

'use strict';

const https = require('https');
const fs = require('fs');

const {
    loadSharedData,
    fetchMemberPortfolio,
    queryContract,
    parallelMap,
    bech32AddressToHex,
    fetchJson,
    currentEpochInfo,
    PFPK_BASE_URL,
    PFPK_TIMEOUT_MS,
    BATCH_CONCURRENCY,
    TLA_VOTING_ESCROW,
} = require('../lib/capture-engine.js');

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------
const BRIBES_HISTORY_URL = 'https://raw.githubusercontent.com/defipatriot/bribes-data_2026/main/data/pd-bribes-history.json';

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/tla-participants-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

const ALL_TOKENS_PAGE = 100;   // CW721 enumeration page size (max 100)

// -----------------------------------------------------------------------------
// DISCOVERY — source 1: veLUNA lock holders (CW721 enumeration)
// -----------------------------------------------------------------------------
//
// Enumerate every lock NFT via all_tokens (paginated, cursor = last token_id —
// IDs sort lexicographically as strings, so we follow the contract's own order
// rather than assuming numeric sequence), then resolve owner_of each. Dedupe to
// the set of holder addresses.
//
// F2 guard: distinguish null (query failed) from [] (genuine end of enumeration)
// so a rate-limited page can't silently truncate the holder set.
async function discoverLockHolders() {
    console.log('🔒 Enumerating veLUNA lock holders...');

    // Sanity bound: num_tokens tells us how many locks should exist.
    let expectedCount = null;
    const numTokens = await queryContract(TLA_VOTING_ESCROW, { num_tokens: {} });
    if (numTokens && numTokens.count != null) {
        expectedCount = Number(numTokens.count);
        console.log(`  num_tokens reports ${expectedCount} locks`);
    } else {
        console.warn('  ⚠ num_tokens query failed — proceeding without a sanity bound');
    }

    // Page through all_tokens.
    const tokenIds = [];
    let startAfter = undefined;
    let enumerationOk = true;
    let pages = 0;
    while (true) {
        const query = { all_tokens: { limit: ALL_TOKENS_PAGE, ...(startAfter !== undefined ? { start_after: startAfter } : {}) } };
        const page = await queryContract(TLA_VOTING_ESCROW, query);
        pages++;
        // null = failed query (F2). Distinguish from an empty-but-valid page.
        if (page === null) {
            enumerationOk = false;
            console.error(`  ✗ all_tokens page ${pages} returned null (query failed) — enumeration INCOMPLETE`);
            break;
        }
        const ids = Array.isArray(page.tokens) ? page.tokens : [];
        if (ids.length === 0) break;   // genuine end of enumeration
        tokenIds.push(...ids);
        startAfter = ids[ids.length - 1];
        if (ids.length < ALL_TOKENS_PAGE) break;  // last partial page
        if (pages > 50) { console.warn('  ⚠ all_tokens exceeded 50 pages — stopping defensively'); enumerationOk = false; break; }
    }
    console.log(`  enumerated ${tokenIds.length} lock token_ids across ${pages} page(s)`);

    if (expectedCount != null && tokenIds.length < expectedCount && enumerationOk) {
        console.warn(`  ⚠ enumerated ${tokenIds.length} < expected ${expectedCount} — possible truncation`);
        enumerationOk = false;
    }

    // Resolve owner_of for each token. Dedupe to holder set.
    const owners = new Map();   // address -> count of locks held
    let ownerErrors = 0;
    await parallelMap(tokenIds, async (tokenId) => {
        const res = await queryContract(TLA_VOTING_ESCROW, { owner_of: { token_id: tokenId } });
        if (res && res.owner) {
            owners.set(res.owner, (owners.get(res.owner) || 0) + 1);
        } else {
            ownerErrors++;
        }
    }, BATCH_CONCURRENCY);

    console.log(`  ✓ ${owners.size} unique lock holders (${ownerErrors} owner_of errors)`);

    return {
        holders: owners,                 // Map<address, lockCount>
        token_count: tokenIds.length,
        expected_count: expectedCount,
        owner_errors: ownerErrors,
        complete: enumerationOk && ownerErrors === 0,
    };
}

// -----------------------------------------------------------------------------
// DISCOVERY — source 2: bribe providers (read from bribes-history)
// -----------------------------------------------------------------------------
async function discoverBribeProviders() {
    console.log('🎁 Reading bribe providers from bribes-history...');
    const data = await fetchJson(BRIBES_HISTORY_URL, 'bribes-history').catch(e => {
        console.warn(`  ⚠ bribes-history fetch failed: ${e.message}`);
        return null;
    });
    if (!data) return { providers: new Map(), ok: false };

    const providers = new Map();   // address -> { label, bribe_count }
    for (const b of (data.bribes || [])) {
        const addr = b.briber_address;
        if (!addr || !addr.startsWith('terra1')) continue;
        const cur = providers.get(addr) || { label: b.briber_label || null, bribe_count: 0 };
        cur.bribe_count++;
        if (!cur.label && b.briber_label) cur.label = b.briber_label;
        providers.set(addr, cur);
    }
    console.log(`  ✓ ${providers.size} unique bribe provider(s) from ${(data.bribes || []).length} bribe records`);
    return { providers, ok: true };
}

// -----------------------------------------------------------------------------
// DISCOVERY — union + PFPK names
// -----------------------------------------------------------------------------
async function resolveParticipants() {
    const [lockResult, bribeResult] = await Promise.all([
        discoverLockHolders(),
        discoverBribeProviders(),
    ]);

    // Union the two sources, tagging provenance.
    const participants = new Map();   // address -> { address, sources:[], lock_count, bribe_count, briber_label }
    for (const [addr, lockCount] of lockResult.holders) {
        participants.set(addr, { address: addr, sources: ['tla_lock'], lock_count: lockCount, bribe_count: 0, briber_label: null });
    }
    for (const [addr, info] of bribeResult.providers) {
        const cur = participants.get(addr);
        if (cur) {
            cur.sources.push('bribe_provider');
            cur.bribe_count = info.bribe_count;
            cur.briber_label = info.label;
        } else {
            participants.set(addr, { address: addr, sources: ['bribe_provider'], lock_count: 0, bribe_count: info.bribe_count, briber_label: info.label });
        }
    }

    const list = [...participants.values()];
    console.log(`👥 ${list.length} total participants (lock holders ∪ bribe providers)`);

    // PFPK name resolution (per-address, non-critical — failures leave name null).
    let named = 0;
    await parallelMap(list, async (p) => {
        try {
            const hex = bech32AddressToHex(p.address);
            const data = await fetchJson(PFPK_BASE_URL + hex, 'pfpk', PFPK_TIMEOUT_MS);
            if (data && data.name) { p.name = data.name; named++; }
            else p.name = null;
        } catch { p.name = null; }
        // Prefer a bribe label if no PFPK name resolved (e.g. "PD").
        if (!p.name && p.briber_label) p.name = p.briber_label;
    }, BATCH_CONCURRENCY);
    console.log(`  ✓ PFPK names: ${named} resolved`);

    return {
        participants: list,
        lock_discovery: lockResult,
        bribe_ok: bribeResult.ok,
    };
}

// -----------------------------------------------------------------------------
// GITHUB PUBLISH (cron-side — not in the shared engine)
// -----------------------------------------------------------------------------
function githubApiRequest(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'api.github.com', path: apiPath, method,
            headers: {
                'User-Agent': 'tla-participants-cron/1.0',
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
                } else {
                    reject(new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${data.slice(0,200)}`));
                }
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
    try {
        const existing = await githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}`);
        sha = existing.sha;
    } catch (e) { /* file doesn't exist yet */ }
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
    console.log(`\n🚀 tla-participants — epoch ${epochInfo.number} — ${startedAt.toISOString()}\n`);

    // Phase 1: discover the participant universe
    const { participants, lock_discovery, bribe_ok } = await resolveParticipants();

    // Phase 2: shared context (pools, prices, ratios)
    const ctx = await loadSharedData();

    // Phase 3: per-participant portfolio via the shared engine
    console.log(`💼 Fetching portfolios for ${participants.length} participants...`);
    const portfolios = await parallelMap(participants, async (p) => {
        const portfolio = await fetchMemberPortfolio({
            address: p.address,
            name: p.name,
            nft_count: 0,
            vp_pct_of_dao: 0,
        }, ctx);
        if (portfolio) {
            portfolio.sources = p.sources;
            portfolio.lock_count_discovered = p.lock_count;
            portfolio.bribe_count = p.bribe_count;
            portfolio.briber_label = p.briber_label;
        }
        return portfolio;
    }, BATCH_CONCURRENCY);
    const valid = portfolios.filter(p => p && !p._error);
    const withErrors = valid.filter(p => (p._errors || []).length > 0).length;
    console.log(`  ✓ ${valid.length}/${participants.length} portfolios captured (${withErrors} with per-member errors)`);

    // Phase 4: rank by VP
    valid.sort((a, b) => (b.voting?.total_voting_power_human || 0) - (a.voting?.total_voting_power_human || 0));
    valid.forEach((p, i) => { p.rank_by_vp = i + 1; });

    // Phase 5: status — partial if discovery incomplete or any member errored
    const lockComplete = lock_discovery.complete;
    let status = 'ok';
    if (!lockComplete || !bribe_ok) status = 'partial';
    if (valid.length === 0) status = 'error';

    // Phase 6: outputs
    const participantsDoc = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        epoch: epochInfo,
        retention: 'live_only',
        luna_price_used_usd: ctx.lunaPriceUsd,
        discovery: {
            lock_token_count: lock_discovery.token_count,
            lock_expected_count: lock_discovery.expected_count,
            lock_owner_errors: lock_discovery.owner_errors,
            lock_complete: lock_discovery.complete,
            bribe_source_ok: bribe_ok,
            participant_count: participants.length,
        },
        members: valid,
    };

    const lightDoc = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        epoch: epochInfo,
        participant_count: participants.length,
        participants: participants.map(p => ({
            address: p.address,
            name: p.name || null,
            sources: p.sources,
            lock_count: p.lock_count,
            bribe_count: p.bribe_count,
        })),
    };

    const heartbeat = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        runId: `tlapart-${startedAt.toISOString().replace(/[-:T.Z]/g,'').slice(0,14)}`,
        status,
        next_expected_run_at: new Date(startedAt.getTime() + 25 * 60 * 60 * 1000).toISOString(),
        stats: {
            participant_count: participants.length,
            portfolios_captured: valid.length,
            members_with_errors: withErrors,
            lock_holders: [...new Set(participants.filter(p => p.sources.includes('tla_lock')).map(p=>p.address))].length,
            bribe_providers: participants.filter(p => p.sources.includes('bribe_provider')).length,
            lock_complete: lock_discovery.complete,
            bribe_source_ok: bribe_ok,
        },
    };

    // Phase 7: publish (or save locally if no token)
    const partContent = JSON.stringify(participantsDoc, null, 2);
    const lightContent = JSON.stringify(lightDoc, null, 2);
    const hbContent = JSON.stringify(heartbeat, null, 2);

    if (!GITHUB_TOKEN) {
        console.log('⚠️  GITHUB_TOKEN not set — saving locally');
        fs.writeFileSync('current.json', partContent);
        fs.writeFileSync('participants.json', lightContent);
        fs.writeFileSync('heartbeat.json', hbContent);
        console.log(`  Saved locally (current.json ${(partContent.length/1024).toFixed(1)} KB)`);
    } else {
        await publishFile('data/current.json', partContent, `participants epoch ${epochInfo.number} (${valid.length})`);
        console.log('  ✓ data/current.json');
        await publishFile('data/participants.json', lightContent, `participants list epoch ${epochInfo.number}`);
        console.log('  ✓ data/participants.json');
        await publishFile('data/heartbeat.json', hbContent, `heartbeat ${status} epoch ${epochInfo.number}`);
        console.log('  ✓ data/heartbeat.json');
    }

    console.log(`\n✅ Done — status ${status} — ${valid.length} participants captured\n`);
    if (status === 'error') process.exit(2);
}

// Only auto-run when invoked as a script
if (require.main === module) {
    run().catch(err => {
        console.error('FATAL:', err);
        process.exit(1);
    });
}

module.exports = { discoverLockHolders, discoverBribeProviders, resolveParticipants };
