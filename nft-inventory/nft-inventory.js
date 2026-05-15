// =============================================================================
// NFT Inventory Cron
// =============================================================================
//
// Captures full per-NFT state for the aDAO collection from on-chain truth.
// Replaces the dashboard's dependency on the third-party deving.zone feed.
//
// What it produces (uploaded to `nft-inventory-data_2026`):
//
//   data/nfts.json       ← per-NFT records: { id, owner, broken, rank, ... }
//                         (large file, ~10k entries, ~1.5 MB)
//   data/summary.json    ← aggregate counts + per-holder breakdowns
//                         (small file for the dashboard's quick reads)
//   data/heartbeat.json  ← uniform freshness contract
//
// Schedule: hourly at :30 (Render cron: `30 * * * *`)
// Runtime:  ~50 seconds (10k chain queries at concurrency 30)
//
// Data model — per NFT record:
//   {
//     id:        "1",                  // token_id (string, as on chain)
//     owner:     "terra1...",          // current chain owner
//     broken:    true|false,           // from extension.attributes trait 'broken'
//     rank:      Number|null,          // if present in attributes
//     image:     "ipfs://..." | null,  // image URI from extension
//     // Classification booleans (derived from owner) — match deving.zone shape
//     // for easy site integration:
//     dao:        true|false,          // held by DAO main wallet
//     minted:     true|false,          // !dao
//     daodao:     true|false,          // staked in DAODAO contract
//     enterprise: true|false,          // held by Enterprise treasury
//   }
//
// NOTE: bbl / boost (currently-listed flags) are populated by the SEPARATE
// `marketplace-stats` cron — kept independent so a BBL API outage doesn't
// stall the per-NFT chain walk, and vice versa. Consumers (dashboard JS)
// merge the two outputs.
// =============================================================================

const https = require('https');
const fs    = require('fs');

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------

const TERRA_LCD_PRIMARY  = 'https://terra-lcd.publicnode.com';
const TERRA_LCD_FALLBACK = 'https://terra-rest.publicnode.com';

// aDAO NFT collection contract
const ADAO_NFT_CONTRACT = 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9';

// Known custody locations — used to classify owners.
// Verified live 2026-05-14 via contract_info / config queries.
const DAO_MAIN_WALLET         = 'terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm';
const DAODAO_STAKING_CONTRACT = 'terra1c57ur376szdv8rtes6sa9nst4k536dynunksu8tx5zu4z5u3am6qmvqx47';
const ENTERPRISE_TREASURY     = 'terra1h8psjgcsg9fef7w2yv0j6262sfcaszj8vs4tsy3uwla6zwtaspvqrp4l7v';

// Query/pagination tuning
const ALL_TOKENS_PAGE = 30;     // CW721 default cap
const NFT_INFO_CONCURRENCY = 30; // benchmarked: 100 queries in ~470ms; 10k → ~47s
const HTTP_TIMEOUT_MS = 15000;
const RETRIES = 3;

// GitHub publish (matches other crons' env contract)
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/nft-inventory-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// TLA epoch math (for heartbeat consistency with other crons)
const TLA_EPOCH_START_MS = Date.parse('2022-10-31T00:00:00Z');
const TLA_EPOCH_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
function currentEpoch() {
    return Math.floor((Date.now() - TLA_EPOCH_START_MS) / TLA_EPOCH_DURATION_MS) + 1;
}

// -----------------------------------------------------------------------------
// HTTP HELPERS
// -----------------------------------------------------------------------------

async function fetchJson(url, label = url, timeoutMs = HTTP_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json', 'User-Agent': 'aDAO-nft-inventory/1.0' },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${body.slice(0, 100)}`);
        }
        return await res.json();
    } catch (e) {
        if (e.name === 'AbortError') throw new Error(`Timeout (${label})`);
        throw e;
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchJsonWithRetry(url, label, maxTries = RETRIES) {
    let lastErr;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
            return await fetchJson(url, label);
        } catch (e) {
            lastErr = e;
            if (attempt < maxTries) {
                const delay = Math.pow(3, attempt - 1) * 500;
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}

async function queryContract(contract, queryObj, label = '') {
    const b64 = Buffer.from(JSON.stringify(queryObj)).toString('base64');
    const tryLcd = async (base) => {
        const url = `${base}/cosmwasm/wasm/v1/contract/${contract}/smart/${b64}`;
        return (await fetchJson(url, label || `LCD ${base.slice(8, 28)}`)).data;
    };
    try {
        return await tryLcd(TERRA_LCD_PRIMARY);
    } catch (e1) {
        return await tryLcd(TERRA_LCD_FALLBACK);
    }
}

// Parallel mapping with bounded concurrency. Errors don't abort the whole batch;
// individual failures are returned as { _error } objects so callers can decide.
async function parallelMap(items, fn, concurrency) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            try { results[i] = await fn(items[i], i); }
            catch (e) { results[i] = { _error: e.message }; }
        }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    return results;
}

// -----------------------------------------------------------------------------
// PHASE 1 — Enumerate all token IDs via paginated all_tokens
// -----------------------------------------------------------------------------

async function enumerateAllTokens() {
    console.log('🔍 Phase 1: enumerating all token IDs...');
    const t0 = Date.now();
    const all = [];
    let startAfter = null;
    let page = 0;
    while (true) {
        const query = startAfter
            ? { all_tokens: { limit: ALL_TOKENS_PAGE, start_after: startAfter } }
            : { all_tokens: { limit: ALL_TOKENS_PAGE } };
        const data = await queryContract(ADAO_NFT_CONTRACT, query, `all_tokens page ${page}`);
        const tokens = data?.tokens || [];
        if (tokens.length === 0) break;
        all.push(...tokens);
        startAfter = tokens[tokens.length - 1];
        page++;
        if (page % 50 === 0) {
            process.stdout.write(`  Page ${page}: cumulative ${all.length} tokens\r`);
        }
        if (tokens.length < ALL_TOKENS_PAGE) break;
    }
    console.log(`  ✓ ${all.length} token IDs (${page} pages) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return all;
}

// -----------------------------------------------------------------------------
// PHASE 2 — Per-NFT: owner + attributes (broken, rank, image)
// -----------------------------------------------------------------------------

function extractAttr(attributes, traitType) {
    if (!Array.isArray(attributes)) return null;
    const found = attributes.find(a => a?.trait_type === traitType);
    return found ? found.value : null;
}

function classifyOwner(owner) {
    return {
        dao:        owner === DAO_MAIN_WALLET,
        daodao:     owner === DAODAO_STAKING_CONTRACT,
        enterprise: owner === ENTERPRISE_TREASURY,
    };
}

async function fetchOneNft(tokenId) {
    const data = await queryContract(
        ADAO_NFT_CONTRACT,
        { all_nft_info: { token_id: tokenId } },
        `nft #${tokenId}`,
    );
    const owner = data?.access?.owner;
    const extension = data?.info?.extension || {};
    const attrs = extension.attributes || [];
    const brokenStr = extractAttr(attrs, 'broken');
    const rankStr   = extractAttr(attrs, 'Rarity') ?? extractAttr(attrs, 'rank');
    const broken = brokenStr === 'true' || brokenStr === true;
    const rankNum = (() => {
        const n = parseInt(rankStr, 10);
        return Number.isFinite(n) ? n : null;
    })();
    const cls = classifyOwner(owner);
    return {
        id: tokenId,
        owner,
        broken,
        rank: rankNum,
        image: extension.image || null,
        name:  extension.name  || null,
        // Classification booleans for easy site consumption
        dao:    cls.dao,
        minted: !cls.dao,                   // minted = held by anyone EXCEPT DAO main
        daodao: cls.daodao,
        enterprise: cls.enterprise,
    };
}

async function fetchAllNftInfo(tokenIds) {
    console.log(`📦 Phase 2: fetching per-NFT info for ${tokenIds.length} tokens (concurrency ${NFT_INFO_CONCURRENCY})...`);
    const t0 = Date.now();
    let progressDone = 0;
    const reportEvery = Math.max(500, Math.floor(tokenIds.length / 20));
    const records = await parallelMap(tokenIds, async (id) => {
        const r = await fetchOneNft(id);
        progressDone++;
        if (progressDone % reportEvery === 0) {
            const pct = ((progressDone / tokenIds.length) * 100).toFixed(0);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
            process.stdout.write(`  ${progressDone}/${tokenIds.length} (${pct}%) — ${elapsed}s elapsed\r`);
        }
        return r;
    }, NFT_INFO_CONCURRENCY);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const failed = records.filter(r => r._error);
    console.log(`  ✓ ${records.length - failed.length}/${records.length} NFTs captured in ${elapsed}s`);
    if (failed.length > 0) {
        console.log(`  ⚠ ${failed.length} failures (sample): ${failed.slice(0, 3).map(f => f._error).join(' | ')}`);
    }
    // Keep only successful records; drop the _error entries
    return records.filter(r => r && !r._error);
}

// -----------------------------------------------------------------------------
// PHASE 3 — Aggregate
// -----------------------------------------------------------------------------

function aggregate(records) {
    const total = records.length;
    let dao_held = 0, minted = 0, broken = 0, unbroken = 0;
    let daodao = 0, enterprise = 0;
    const perOwnerCounts = {};     // owner → count
    const perOwnerBroken = {};     // owner → broken count
    const uniqueHolders = new Set();

    for (const r of records) {
        if (r.dao) dao_held++;
        else minted++;
        if (r.broken) broken++;
        else unbroken++;
        if (r.daodao) daodao++;
        if (r.enterprise) enterprise++;
        if (r.owner) {
            uniqueHolders.add(r.owner);
            perOwnerCounts[r.owner] = (perOwnerCounts[r.owner] || 0) + 1;
            if (r.broken) {
                perOwnerBroken[r.owner] = (perOwnerBroken[r.owner] || 0) + 1;
            }
        }
    }

    // DAO members count: unique holders MINUS DAO-controlled / staking-contract addresses.
    // Matches the dashboard's intent (real individual members, not contracts).
    const excludedFromMembers = new Set([
        DAO_MAIN_WALLET,
        DAODAO_STAKING_CONTRACT,
        ENTERPRISE_TREASURY,
    ]);
    const memberHolders = [...uniqueHolders].filter(o => !excludedFromMembers.has(o));

    // Top per-owner tables (DAODAO + Enterprise stakers — used by the dashboard modals).
    // We rebuild these by walking records once more to get per-NFT detail per owner.
    function buildStakerTable(filterFn) {
        const byOwner = {};
        for (const r of records) {
            if (!filterFn(r)) continue;
            if (!byOwner[r.owner]) byOwner[r.owner] = { owner: r.owner, count: 0, broken: 0 };
            byOwner[r.owner].count++;
            if (r.broken) byOwner[r.owner].broken++;
        }
        return Object.values(byOwner).sort((a, b) => b.count - a.count);
    }
    // Note: stakers tables based on owner-equal-to-staking-contract will collapse to a single
    // row (the contract holds them all). That's not the UX the dashboard wants — it wants the
    // ORIGINAL stakers (the users who delegated). For DAODAO that requires querying the staking
    // contract's own staker list. We capture that in Phase 4 below.

    return {
        // Aggregate counts (drive the top tiles)
        total_tokens: total,
        minted_count: minted,
        unminted_count: dao_held,
        broken_count: broken,
        unbroken_count: unbroken,
        daodao_staked_count: daodao,
        enterprise_staked_count: enterprise,
        dao_held_count: dao_held,
        unique_holders: uniqueHolders.size,
        dao_members_count: memberHolders.length,

        // Useful for analytics / supply breakdown modal
        circulating_supply: Math.max(0, minted - dao_held),   // matches dashboard math
        per_owner_counts: perOwnerCounts,
        per_owner_broken: perOwnerBroken,
    };
}

// -----------------------------------------------------------------------------
// PHASE 4 — Real stakers for DAODAO (via daodao.zone indexer, which adao-positions
// also uses). The on-chain DAODAO contract (dao-voting-cw721-staked v2.5.0) has
// NO enumerable staker list — only per-address `staked_nfts(address)` queries.
// The indexer is the canonical source for "who staked what." Failures here are
// non-fatal — summary aggregate counts are still produced from chain data.
// -----------------------------------------------------------------------------

// Same indexer URL pattern used by adao-positions cron — proven to work on Render.
const DAODAO_VOTING_CONTRACT = 'terra1c57ur376szdv8rtes6sa9nst4k536dynunksu8tx5zu4z5u3am6qmvqx47';
const DAODAO_INDEXER_URL = `https://indexer.daodao.zone/phoenix-1/contract/${DAODAO_VOTING_CONTRACT}/daoVotingCw721Staked/topStakers`;

async function fetchDaodaoStakers() {
    console.log('👥 Phase 4: fetching DAODAO stakers list (via daodao.zone indexer)...');
    try {
        const data = await fetchJson(DAODAO_INDEXER_URL, 'daodao-indexer-topStakers');
        if (!Array.isArray(data)) {
            console.warn('  ⚠ Indexer returned non-array response');
            return [];
        }
        // Indexer entry shape: { address, count, votingPowerPercent }
        const stakers = data.map(s => ({
            address: s.address,
            count: s.count || 0,
            voting_power_pct: s.votingPowerPercent || 0,
        })).sort((a, b) => b.count - a.count);
        console.log(`  ✓ ${stakers.length} DAODAO stakers (from indexer)`);
        return stakers;
    } catch (e) {
        console.warn(`  ⚠ DAODAO stakers fetch failed (non-fatal): ${e.message}`);
        return [];
    }
}

// -----------------------------------------------------------------------------
// GITHUB PUBLISH
// -----------------------------------------------------------------------------

function githubApiRequest(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'api.github.com', path: apiPath, method,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent':    'aDAO-nft-inventory/1.0',
                'Accept':        'application/vnd.github.v3+json',
                'Content-Type':  'application/json',
            },
        };
        const req = https.request(opts, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data || '{}') }); }
                catch { resolve({ status: res.statusCode, data: {} }); }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function pushToGithub(filepath, content, message) {
    const apiPath = `/repos/${GITHUB_REPO}/contents/${filepath}`;
    const existing = await githubApiRequest('GET', apiPath);
    const sha = existing.data?.sha;
    const body = {
        message,
        content: Buffer.from(content).toString('base64'),
        branch: GITHUB_BRANCH,
        ...(sha ? { sha } : {}),
    };
    const result = await githubApiRequest('PUT', apiPath, body);
    if (result.status === 200 || result.status === 201) {
        console.log(`  ✅ ${filepath} (${(content.length / 1024).toFixed(1)} KB)`);
        return true;
    }
    console.error(`  ❌ Push failed (HTTP ${result.status}): ${result.data?.message || '<no message>'}`);
    return false;
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------

async function captureSnapshot() {
    const startedAt = new Date();
    const epoch = currentEpoch();
    console.log(`🚀 NFT Inventory Cron — ${startedAt.toISOString()} (epoch ${epoch})`);
    console.log();

    // Phase 1: enumerate IDs
    const tokenIds = await enumerateAllTokens();

    // Sanity check against num_tokens
    const numTokensData = await queryContract(ADAO_NFT_CONTRACT, { num_tokens: {} }, 'num_tokens');
    const declaredCount = numTokensData?.count ?? null;
    if (declaredCount != null && tokenIds.length !== declaredCount) {
        console.warn(`  ⚠ Enumerated ${tokenIds.length} but contract reports ${declaredCount}`);
    }
    console.log();

    // Phase 2: per-NFT info
    const records = await fetchAllNftInfo(tokenIds);
    const captureRate = tokenIds.length > 0 ? records.length / tokenIds.length : 0;
    console.log();

    // Phase 3: aggregate
    console.log('📊 Phase 3: aggregating...');
    const summary = aggregate(records);
    console.log(`  Minted:           ${summary.minted_count.toLocaleString()}`);
    console.log(`  Unminted (DAO):   ${summary.unminted_count.toLocaleString()}`);
    console.log(`  Broken:           ${summary.broken_count.toLocaleString()}`);
    console.log(`  Unbroken:         ${summary.unbroken_count.toLocaleString()}`);
    console.log(`  DAODAO staked:    ${summary.daodao_staked_count.toLocaleString()}`);
    console.log(`  Enterprise:       ${summary.enterprise_staked_count.toLocaleString()}`);
    console.log(`  Unique holders:   ${summary.unique_holders.toLocaleString()}`);
    console.log(`  DAO members:      ${summary.dao_members_count.toLocaleString()}`);
    console.log();

    // Phase 4: drill into staker tables
    const daodaoStakers = await fetchDaodaoStakers();
    console.log();

    // Assemble output documents
    const status = captureRate >= 0.99 ? 'ok' : 'partial';
    const nftsDoc = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        nft_contract: ADAO_NFT_CONTRACT,
        total_tokens: records.length,
        capture_rate: captureRate,
        records,
    };
    const summaryDoc = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        epoch,
        nft_contract: ADAO_NFT_CONTRACT,
        contracts: {
            dao_main_wallet:        DAO_MAIN_WALLET,
            daodao_staking:         DAODAO_STAKING_CONTRACT,
            enterprise_treasury:    ENTERPRISE_TREASURY,
        },
        ...summary,
        daodao_stakers: daodaoStakers,
        // Enterprise stakers: the treasury contract holds them all on-chain.
        // No per-staker list available via standard query — would need event log walk.
        // The dashboard modal can display the count + treasury holder count.
        enterprise_stakers_note: 'Enterprise treasury holds all migrated NFTs as a single owner. Individual staker attribution requires event log walk (not currently captured).',
    };
    const heartbeatDoc = {
        schemaVersion: 1,
        cron: 'nft-inventory',
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        runId: `nft-${startedAt.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
        runMode: 'hourly',
        currentEpoch: epoch,
        status,
        stats: {
            total_tokens: records.length,
            capture_rate: captureRate,
            minted: summary.minted_count,
            unminted: summary.unminted_count,
            broken: summary.broken_count,
            daodao: summary.daodao_staked_count,
            enterprise: summary.enterprise_staked_count,
            unique_holders: summary.unique_holders,
        },
        next_expected_run_at: new Date(startedAt.getTime() + 60 * 60 * 1000).toISOString(),
    };

    // Publish / save
    if (GITHUB_TOKEN) {
        console.log('📤 Publishing to GitHub...');
        await pushToGithub('data/nfts.json',      JSON.stringify(nftsDoc),                 `nft inventory — ${records.length} NFTs`);
        await pushToGithub('data/summary.json',   JSON.stringify(summaryDoc, null, 2),     `nft summary — ${summary.minted_count} minted / ${summary.broken_count} broken`);
        await pushToGithub('data/heartbeat.json', JSON.stringify(heartbeatDoc, null, 2),   `📍 nft-inventory heartbeat — ${status}`);
    } else {
        console.log('⚠️  GITHUB_TOKEN not set — saving locally');
        fs.writeFileSync('nfts.json', JSON.stringify(nftsDoc));
        fs.writeFileSync('summary.json', JSON.stringify(summaryDoc, null, 2));
        fs.writeFileSync('heartbeat.json', JSON.stringify(heartbeatDoc, null, 2));
        console.log(`  Saved locally: nfts.json (${(JSON.stringify(nftsDoc).length / 1024).toFixed(1)} KB), summary.json, heartbeat.json`);
    }

    const elapsed = (Date.now() - startedAt.getTime()) / 1000;
    console.log(`\n✅ Done (${elapsed.toFixed(1)}s)`);
}

// -----------------------------------------------------------------------------
// ENTRY POINT
// -----------------------------------------------------------------------------

if (require.main === module) {
    captureSnapshot().catch(e => {
        console.error(`❌ FATAL: ${e.message}`);
        console.error(e.stack);
        process.exit(1);
    });
}

module.exports = {
    captureSnapshot,
    enumerateAllTokens,
    fetchAllNftInfo,
    aggregate,
    fetchDaodaoStakers,
};
