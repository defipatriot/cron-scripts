// =============================================================================
// aDAO Allies Positions Cron
// =============================================================================
//
// Tracks the members of aDAO's ally DAOs (registered names only) with full
// TLA-position depth via the shared capture engine. One cron covers ALL allies
// — add a future ally by appending to the ALLIES array below; no new service.
//
// Current allies:
//   • Pixel Lions — NFT-staked DAODAO DAO  (daoVotingCw721Staked)
//   • Lion DAO    — ROAR-token-staked DAO  (daoVotingTokenStaked)
//
// Each ally is captured INDEPENDENTLY: one ally failing (indexer hiccup, etc.)
// never blocks the others, and the per-ally status is reported separately. This
// preserves the "allies can't break each other / can be paused independently"
// property even bundled in one service — a disabled ally is just a commented-out
// array entry.
//
// Discovery is runtime-resolved from each ally's CORE address (core → dumpState
// votingModule → type-appropriate topStakers). Nothing hardcoded but the core.
//
// RETENTION: registered-only (ally decision 2026-06-13).
// Output repo: adao-allies-data_2026
//   data/current.json        — all allies, each with its registered members + TLA positions
//   data/{ally_slug}.json     — per-ally detail file
//   data/participants.json    — light list of all stakers across allies
//   data/heartbeat.json       — overall + per-ally status
//
// Runs AFTER aDAO + TLA crons (it reuses tla-snapshot + network-and-prices data
// via the engine's loadSharedData, so those should be fresh first).
// =============================================================================

'use strict';

const https = require('https');
const fs = require('fs');
const { captureAlly } = require('../lib/ally-capture.js');

// -----------------------------------------------------------------------------
// ALLY REGISTRY — add a future ally here (slug must be filesystem-safe)
// -----------------------------------------------------------------------------
const ALLIES = [
    {
        slug: 'pixellions',
        name: 'Pixel Lions',
        coreAddress: 'terra1c690mdrwdetnr09zfk3tf9xz9jhrgd9wpjyf3tuccj74ql09eqmq6sh7en',
        stakeType: 'nft',
        retention: 'registered_only',
    },
    {
        slug: 'liondao',
        name: 'Lion DAO',
        coreAddress: 'terra1tkersa2mqwy2h8exj799qx2xrhdu0dkymk9psp6v0k4kz4tkxucssgluec',
        stakeType: 'token',   // ROAR — staked balances are raw micro-units (billions); not USD-valued in v1
        retention: 'registered_only',
    },
];

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/adao-allies-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// -----------------------------------------------------------------------------
// GitHub publish
// -----------------------------------------------------------------------------
function githubApiRequest(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'api.github.com', path: apiPath, method,
            headers: {
                'User-Agent': 'adao-allies-cron/1.0',
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
                } else reject(new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${data.slice(0,200)}`));
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
// MAIN — capture each ally independently, then publish combined + per-ally
// -----------------------------------------------------------------------------
async function run() {
    const startedAt = new Date();
    console.log(`\n🚀 aDAO Allies — ${startedAt.toISOString()} — ${ALLIES.length} allies\n`);

    const results = [];
    for (const ally of ALLIES) {
        try {
            const r = await captureAlly(ally);
            results.push({ ally, r });
        } catch (err) {
            console.error(`  ✗ ${ally.name} FAILED: ${err.message}`);
            results.push({ ally, r: { status: 'error', error: err.message, members: [], all_members: [], epochInfo: null, startedAt } });
        }
    }

    const epochInfo = results.find(x => x.r.epochInfo)?.r.epochInfo || null;

    // Per-ally blocks for the combined doc
    const allyBlocks = results.map(({ ally, r }) => ({
        slug: ally.slug,
        name: ally.name,
        stake_type: ally.stakeType,
        status: r.status,
        voting_module: r.votingModule || null,
        registered_count: r.registered_count ?? 0,
        total_staker_count: r.total_staker_count ?? 0,
        members: r.members || [],
        error: r.error || null,
    }));

    // Overall status: ok only if every ally is ok; partial if some ok/some not;
    // error only if ALL allies errored.
    const statuses = allyBlocks.map(a => a.status);
    let overall = 'ok';
    if (statuses.every(s => s === 'error')) overall = 'error';
    else if (statuses.some(s => s !== 'ok')) overall = 'partial';

    const combinedDoc = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        epoch: epochInfo,
        retention: 'registered_only',
        ally_count: ALLIES.length,
        luna_price_used_usd: results.find(x => x.r.ctx_luna_price != null)?.r.ctx_luna_price ?? null,
        allies: allyBlocks,
    };

    const lightDoc = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        epoch: epochInfo,
        allies: results.map(({ ally, r }) => ({
            slug: ally.slug,
            name: ally.name,
            total_staker_count: r.total_staker_count ?? 0,
            stakers: (r.all_members || []).map(m => ({ address: m.address, name: m.name || null, stake_raw: m.stake_raw, vp_pct_of_dao: m.vp_pct_of_dao })),
        })),
    };

    const heartbeat = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        runId: `adao-allies-${startedAt.toISOString().replace(/[-:T.Z]/g,'').slice(0,14)}`,
        status: overall,
        next_expected_run_at: new Date(startedAt.getTime() + 25 * 60 * 60 * 1000).toISOString(),
        stats: {
            ally_count: ALLIES.length,
            per_ally: allyBlocks.map(a => ({
                slug: a.slug,
                status: a.status,
                registered_count: a.registered_count,
                total_staker_count: a.total_staker_count,
                captured: a.members.length,
                voting_module_resolved: !!a.voting_module,
            })),
        },
    };

    // Publish: combined, per-ally detail files, light list, heartbeat
    const combinedContent = JSON.stringify(combinedDoc, null, 2);
    const lightContent = JSON.stringify(lightDoc, null, 2);
    const hbContent = JSON.stringify(heartbeat, null, 2);

    if (!GITHUB_TOKEN) {
        console.log('⚠️  GITHUB_TOKEN not set — saving locally');
        fs.writeFileSync('current.json', combinedContent);
        fs.writeFileSync('participants.json', lightContent);
        fs.writeFileSync('heartbeat.json', hbContent);
        for (const a of allyBlocks) fs.writeFileSync(`${a.slug}.json`, JSON.stringify(a, null, 2));
    } else {
        await publishFile('data/current.json', combinedContent, `allies refresh (${overall})`);
        console.log('  ✓ data/current.json');
        for (const a of allyBlocks) {
            await publishFile(`data/${a.slug}.json`, JSON.stringify(a, null, 2), `${a.slug} ${a.status} (${a.members.length})`);
            console.log(`  ✓ data/${a.slug}.json`);
        }
        await publishFile('data/participants.json', lightContent, `allies stakers list`);
        console.log('  ✓ data/participants.json');
        await publishFile('data/heartbeat.json', hbContent, `heartbeat ${overall}`);
        console.log('  ✓ data/heartbeat.json');
    }

    console.log(`\n✅ aDAO Allies — overall ${overall}`);
    for (const a of allyBlocks) console.log(`   ${a.name}: ${a.status} — ${a.members.length} registered captured (${a.total_staker_count} total stakers)`);
    console.log('');
    if (overall === 'error') process.exit(2);
}

if (require.main === module) {
    run().catch(err => { console.error('FATAL:', err); process.exit(1); });
}
