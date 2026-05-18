// =============================================================================
// Bribes History Cron
// =============================================================================
//
// Captures the complete history of bribes added to TLA pools, with the primary
// goal of measuring how much PD (Phoenix Directive Stewardship) is driving LP
// vote allocation vs organic bribes from other parties.
//
// Three data sources:
//
//   1. PD's DAODAO proposals (Terra LCD direct query, no daodao.zone dep)
//      → Every `add_bribe` execute message PD has ever proposed, with the
//        cleanly-structured pool, gauge, token, amount, and epoch-range fields
//        embedded in the proposal message. NO description parsing needed.
//      → Discovered via HAR-trace of daodao.zone, then verified the chain
//        endpoint at `terra1660g9mle5kfsq8c0p4k4hgr9ujdyr3m48c22cawy0akr98rmwksqehqnup`
//        responds to `{list_proposals:{}}` and `{proposal:{proposal_id:N}}` queries.
//
//   2. Bribe-manager contract's current `bribes` query
//      → The chain's view of all currently-active bribes (regardless of who
//        deposited them). Used to compute "non-PD" share by subtraction.
//
//   3. (FUTURE) Terra LCD txs filtered by bribe-manager contract
//      → Captures non-DAO bribers (individuals calling `add_bribe` directly).
//        Currently a TODO — requires walking block-by-block tx history.
//        Most bribes today come via DAO props, so coverage gap is small.
//
// Output structure (`bribes-data_2026`):
//
//   data/pd-bribes-history.json         ← master file, every PD bribe ever
//   data/by-epoch/epoch-{N}.json        ← bribes active for that specific epoch
//   data/by-pool/{lp-addr}.json         ← bribes per pool across all epochs
//   data/bribers-registry.json          ← addresses → totals, labels
//   data/current-state.json             ← snapshot of bribe-manager right now
//
// Runtime: Node 18+ (built-in fetch). CommonJS, no dependencies.
// =============================================================================

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------

const TERRA_LCD_PRIMARY  = 'https://terra-rest.publicnode.com';
const TERRA_LCD_FALLBACK = 'https://terra.publicnode.com';

// PD's DAO and proposal module — verified live 2026-05-12.
// PD DAO contract config returns name "Phoenix Directive Stewardship".
const PD_DAO_CONTRACT     = 'terra1k8ug6dkzntczfzn76wsh24tdjmx944yj6mk063wum7n20cwd7lxq4lppjg';
const PD_PROPOSAL_MODULE  = 'terra1660g9mle5kfsq8c0p4k4hgr9ujdyr3m48c22cawy0akr98rmwksqehqnup';

// Bribe manager contract — receives all `add_bribe` calls regardless of source.
const BRIBE_MANAGER       = 'terra1tuuwm8yrj54qeg0c8xu00aha9ryatyhtczq8qq2q8tntuw0auzas9037wh';

// Known briber addresses — labeled so we can show "PD bribed X" vs "user bribed Y"
// in the website. Lookup goes by the proposal proposer field. The PD DAO itself
// is the proposer for DAO-passed bribes, hence the DAO address as the PD label.
const KNOWN_BRIBERS = {
    [PD_DAO_CONTRACT]: 'PD',
};

// TLA epoch math.
const TLA_EPOCH_START_MS = Date.parse('2022-10-31T00:00:00Z');
const TLA_EPOCH_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// Pagination for list_proposals (the contract caps at 30, but it's per-call so
// we just loop). Use start_after to walk through.
const PROPOSALS_PAGE_SIZE = 30;
const MAX_PAGES = 50;   // safety cap — covers 1500 proposals (current PD DAO is at ~243)

// HTTP timeouts.
const HTTP_TIMEOUT_MS = 15000;

// GitHub publish config (env-driven, matches other crons' convention).
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/bribes-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// -----------------------------------------------------------------------------
// HTTP HELPERS
// -----------------------------------------------------------------------------

async function fetchJson(url, label = url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json', 'User-Agent': 'aDAO-bribes-history/1.0' },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${body.slice(0, 120)}`);
        }
        return await res.json();
    } catch (e) {
        if (e.name === 'AbortError') throw new Error(`Timeout (${label})`);
        throw e;
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchJsonWithRetry(url, label, maxTries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
            return await fetchJson(url, label);
        } catch (e) {
            lastErr = e;
            if (attempt < maxTries) {
                const delay = Math.pow(3, attempt - 1) * 1000;
                console.log(`  ⏳ ${label} attempt ${attempt} failed (${e.message.slice(0, 60)}), retry in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}

async function queryContract(contractAddr, queryObj) {
    const queryB64 = Buffer.from(JSON.stringify(queryObj)).toString('base64');
    const tryLcd = async (base) => {
        const url = `${base}/cosmwasm/wasm/v1/contract/${contractAddr}/smart/${queryB64}`;
        const json = await fetchJson(url, `LCD ${base.slice(8, 28)}`);
        return json.data;
    };
    try {
        return await tryLcd(TERRA_LCD_PRIMARY);
    } catch (e1) {
        console.log(`  ⏳ primary LCD failed (${e1.message.slice(0, 60)}), trying fallback`);
        return await tryLcd(TERRA_LCD_FALLBACK);
    }
}

// -----------------------------------------------------------------------------
// PHASE 1: WALK ALL PD PROPOSALS, DECODE add_bribe MESSAGES
// -----------------------------------------------------------------------------

// Fetch one page of proposals from PD's proposal module.
// Returns { proposals: [...], hasMore: boolean }
async function fetchProposalsPage(startAfter = null) {
    const query = startAfter !== null
        ? { list_proposals: { start_after: startAfter, limit: PROPOSALS_PAGE_SIZE } }
        : { list_proposals: { limit: PROPOSALS_PAGE_SIZE } };
    const data = await queryContract(PD_PROPOSAL_MODULE, query);
    const proposals = data?.proposals || [];
    return {
        proposals,
        hasMore: proposals.length === PROPOSALS_PAGE_SIZE,
    };
}

// Walk ALL proposals from start_after=null forward. Single proposal cap is 1500.
async function fetchAllProposals() {
    console.log('🔍 Fetching all PD proposals from chain...');
    const all = [];
    let startAfter = null;
    for (let page = 0; page < MAX_PAGES; page++) {
        const { proposals, hasMore } = await fetchProposalsPage(startAfter);
        if (proposals.length === 0) break;
        all.push(...proposals);
        startAfter = proposals[proposals.length - 1].id;
        if (!hasMore) break;
        process.stdout.write(`  Page ${page + 1}: ${proposals.length} props (cumulative: ${all.length}, max id: ${startAfter})\r`);
    }
    console.log(`\n  ✓ Total: ${all.length} PD proposals (latest ID: ${all[all.length - 1]?.id})`);
    return all;
}

// Decode a single proposal's messages, return any add_bribe payloads.
// One proposal can contain MANY add_bribe messages (one per pool×epoch-range
// combo). Each is treated as a separate bribe record.
function extractBribesFromProposal(proposal) {
    const inner = proposal.proposal || {};
    const msgs = inner.msgs || [];
    const bribes = [];

    for (let msgIdx = 0; msgIdx < msgs.length; msgIdx++) {
        const m = msgs[msgIdx];
        const wasm = m?.wasm?.execute;
        if (!wasm) continue;

        const targetContract = wasm.contract_addr;
        const msgB64 = wasm.msg;
        if (!msgB64) continue;

        let decoded;
        try {
            decoded = JSON.parse(Buffer.from(msgB64, 'base64').toString('utf-8'));
        } catch (e) {
            continue;   // can't decode → skip
        }

        // We only care about add_bribe calls. The contract has other actions
        // (setup, withdraw_bribes, payment, etc.) which we ignore.
        if (!decoded.add_bribe) continue;

        // Verify the target contract is the bribe manager
        // (defensive: if PD ever proposed an add_bribe to a different contract
        // it would be invalid for our purposes)
        if (targetContract !== BRIBE_MANAGER) {
            console.log(`  ⚠ prop ${proposal.id}: add_bribe targets ${targetContract}, not bribe manager — skipping`);
            continue;
        }

        const ab = decoded.add_bribe;
        bribes.push({
            // Provenance — for traceability back to source
            source: 'pd-dao',
            briber_address: PD_DAO_CONTRACT,
            briber_label: KNOWN_BRIBERS[PD_DAO_CONTRACT] || 'unknown',
            proposal_id: proposal.id,
            proposal_title: (inner.title || '').slice(0, 200),
            proposal_status: inner.status,
            msg_index: msgIdx,
            funds: (wasm.funds || []),   // the `funds` field is the LUNA sent with the tx

            // Bribe payload — directly from chain message
            bribe_token: ab.bribe?.info,                 // { native: 'uluna' } or { cw20: '...' }
            bribe_amount: ab.bribe?.amount,              // string, micro units
            for_pool: ab.for_info,                       // pool LP token: { cw20: '...' } or { native: '...' }
            gauge: ab.gauge,                             // 'project' | 'single' | 'bluechip' | 'stable'
            distribution: ab.distribution,               // { func: { func_type: 'linear', start: N, end: M } }
            // Chain stores periods as 0-indexed (week of May 11-18 = chain period 184).
            // We expose them as canonical 1-indexed (epoch 185) to match
            // `epoch_1-300_date.json` and Eris/Votion UIs. The raw chain values
            // remain available in `distribution.func.start/end` above.
            start_epoch: ab.distribution?.func?.start != null
                ? ab.distribution.func.start + 1 : null,
            end_epoch: ab.distribution?.func?.end != null
                ? ab.distribution.func.end + 1 : null,
        });
    }
    return bribes;
}

// -----------------------------------------------------------------------------
// PHASE 2: SNAPSHOT CURRENT BRIBE-MANAGER STATE
// -----------------------------------------------------------------------------

async function fetchCurrentBribeState() {
    console.log('🔍 Fetching current active bribes from chain...');
    const data = await queryContract(BRIBE_MANAGER, { bribes: { period: null } });
    const buckets = data?.buckets || [];
    console.log(`  ✓ ${buckets.length} active bribe buckets on chain`);
    return buckets;
}

// -----------------------------------------------------------------------------
// PHASE 3: AGGREGATE INTO EPOCH BUCKETS AND POOL HISTORIES
// -----------------------------------------------------------------------------

// Given a list of bribe records (from phase 1), group them by epoch.
// A bribe with start=181, end=184 contributes to epochs 181, 182, 183, AND 184
// — each epoch gets 1/(N) of the amount where N is the range length, since
// the distribution is `linear`. (Confirmed from prop 234 example: 4-epoch
// distribution divides amount by 4.)
function aggregateByEpoch(bribes) {
    const byEpoch = {};   // { '184': [bribe records] }
    for (const b of bribes) {
        const start = b.start_epoch;
        const end = b.end_epoch;
        if (start == null || end == null) continue;
        const rangeLen = end - start + 1;
        const perEpochAmount = (BigInt(b.bribe_amount || '0') / BigInt(rangeLen)).toString();
        for (let ep = start; ep <= end; ep++) {
            if (!byEpoch[ep]) byEpoch[ep] = [];
            byEpoch[ep].push({
                ...b,
                // Per-epoch projected amount (the portion of this bribe that lands
                // in THIS specific epoch)
                amount_this_epoch: perEpochAmount,
            });
        }
    }
    return byEpoch;
}

// Group by pool LP address. The bribe's `for_pool` field carries either a cw20
// LP token addr or a native LP denom; we extract a stable key for grouping.
function aggregateByPool(bribes) {
    const byPool = {};
    for (const b of bribes) {
        const poolKey = b.for_pool?.cw20 || b.for_pool?.native || '?';
        if (!byPool[poolKey]) byPool[poolKey] = [];
        byPool[poolKey].push(b);
    }
    return byPool;
}

// Briber registry — addresses with totals + labels. Currently the only briber
// captured here is PD. Non-PD bribers will get added when we hook in the tx
// scan source. For now, this is mostly future-proofing the file shape.
function buildBribersRegistry(bribes) {
    const registry = {};
    for (const b of bribes) {
        const addr = b.briber_address;
        if (!registry[addr]) {
            registry[addr] = {
                address: addr,
                label: KNOWN_BRIBERS[addr] || null,
                total_bribes_count: 0,
                total_amount_uluna: '0',   // sum across all uluna-denominated bribes
                pools_bribed: new Set(),
                first_proposal_id: b.proposal_id,
                last_proposal_id: b.proposal_id,
                first_epoch_bribed: b.start_epoch,
                last_epoch_bribed: b.end_epoch,
            };
        }
        const r = registry[addr];
        r.total_bribes_count++;
        // Only sum uluna-denominated bribes for the "total_amount_uluna" field
        // — other denoms (USDC, etc.) get tracked elsewhere.
        if (b.bribe_token?.native === 'uluna') {
            r.total_amount_uluna = (BigInt(r.total_amount_uluna) + BigInt(b.bribe_amount || '0')).toString();
        }
        const poolKey = b.for_pool?.cw20 || b.for_pool?.native;
        if (poolKey) r.pools_bribed.add(poolKey);
        r.last_proposal_id = Math.max(r.last_proposal_id, b.proposal_id);
        r.first_epoch_bribed = Math.min(r.first_epoch_bribed || b.start_epoch, b.start_epoch || Infinity);
        r.last_epoch_bribed = Math.max(r.last_epoch_bribed || b.end_epoch, b.end_epoch || 0);
    }
    // Convert Sets to arrays for JSON
    const out = {};
    for (const addr of Object.keys(registry)) {
        out[addr] = { ...registry[addr], pools_bribed: [...registry[addr].pools_bribed] };
    }
    return out;
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
                'User-Agent':    'aDAO-bribes-history/1.0',
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
        console.log(`  ✅ ${filepath}`);
        return true;
    }
    console.error(`  ❌ Push failed (HTTP ${result.status}): ${result.data?.message || '<no message>'}`);
    return false;
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------

// =============================================================================
// DATA FRESHNESS MONITORING
// =============================================================================
//
// Detects upstream-frozen failures (PD DAODAO proposal queries stuck, or
// bribe-manager contract reads returning identical data across runs).
//
// Bribes-history runs daily. Two volatile signals are mixed:
//   1. PD proposal counter (only goes up — new bribes get proposed/executed)
//   2. Active bribe state (changes intra-epoch as claimers withdraw amounts)
//
// Fingerprint excludes `currentEpoch` (counter that auto-changes weekly,
// would mask freezes around epoch boundaries). Includes the substantive
// state: aggregate counters + per-bribe gauge + asset + amounts.
//
// 3 identical daily runs in a row → 'stuck'. Note: false-positive risk is
// slightly higher than other crons because quiet PD weeks with no claims
// are plausible — but over 3 days SOMEONE usually claims something, so
// fully-identical bribe amounts for 3 days running would be unusual.

const STUCK_THRESHOLD = 3;  // 3+ identical consecutive runs → 'stuck'

function computeDataFingerprint(masterFile, currentStateFile) {
    // Per-active-bribe volatile signals (amounts change as claimers withdraw)
    const bribeItems = [];
    for (const b of currentStateFile.active_bribes || []) {
        const assetKey = b.asset?.cw20 || b.asset?.native || JSON.stringify(b.asset || {});
        const amounts = (b.assets || []).map(a => a.amount).sort();
        bribeItems.push([b.gauge || '?', assetKey, ...amounts]);
    }
    bribeItems.sort((a, b) => `${a[0]}|${a[1]}`.localeCompare(`${b[0]}|${b[1]}`));

    const input = JSON.stringify({
        stats: masterFile.stats || {},
        active_bribes: bribeItems,
    });
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

// Fetch our previous heartbeat — graceful failure (returns null).
function fetchPreviousHeartbeat() {
    return new Promise((resolve) => {
        const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/data/heartbeat.json`;
        const req = https.get(url, { timeout: 8000 }, (res) => {
            if (res.statusCode !== 200) { resolve(null); return; }
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

function classifyFreshness(currentFp, prev) {
    if (!prev || !prev.dataFingerprint) {
        return { dataFreshness: 'fresh', consecutiveStuckRuns: 0, previousFingerprint: null };
    }
    const previousFingerprint = prev.dataFingerprint;
    if (currentFp !== previousFingerprint) {
        return { dataFreshness: 'fresh', consecutiveStuckRuns: 0, previousFingerprint };
    }
    const priorCount = Number(prev.consecutiveStuckRuns) || 1;
    const consecutive = priorCount + 1;
    const dataFreshness = consecutive >= STUCK_THRESHOLD ? 'stuck' : 'suspicious';
    return { dataFreshness, consecutiveStuckRuns: consecutive, previousFingerprint };
}

async function captureBribesHistory() {
    const startedAt = new Date();
    // currentEpoch is 1-indexed canonical, matching `epoch_1-300_date.json` and
    // Eris/Votion UIs. The raw Math.floor gives 0-indexed, so we add 1.
    const currentEpoch = Math.floor((startedAt.getTime() - TLA_EPOCH_START_MS) / TLA_EPOCH_DURATION_MS) + 1;

    console.log(`\n📸 Bribes History Capture`);
    console.log(`   Started: ${startedAt.toISOString()}`);
    console.log(`   Current epoch: ${currentEpoch}\n`);

    // Phase 1: Walk PD's proposals, extract every add_bribe
    const proposals = await fetchAllProposals();

    console.log('\n🔎 Decoding add_bribe messages...');
    let allBribes = [];
    for (const p of proposals) {
        const bribes = extractBribesFromProposal(p);
        allBribes = allBribes.concat(bribes);
    }
    console.log(`  ✓ Found ${allBribes.length} add_bribe records across ${proposals.length} proposals`);

    // Status breakdown
    const statusCounts = {};
    for (const b of allBribes) {
        statusCounts[b.proposal_status] = (statusCounts[b.proposal_status] || 0) + 1;
    }
    console.log(`  Status: ${Object.entries(statusCounts).map(([k, v]) => `${v} ${k}`).join(', ')}`);

    // Filter to only executed (the others are passed/failed/etc and don't actually pay out)
    const executedBribes = allBribes.filter(b => b.proposal_status === 'executed');
    console.log(`  Executed bribes: ${executedBribes.length}\n`);

    // Phase 2: Current chain state
    const currentBuckets = await fetchCurrentBribeState();

    // Phase 3: Aggregate
    console.log('\n📊 Aggregating...');
    const byEpoch = aggregateByEpoch(executedBribes);
    const byPool  = aggregateByPool(executedBribes);
    const bribers = buildBribersRegistry(executedBribes);
    console.log(`  By epoch: ${Object.keys(byEpoch).length} epochs with bribes`);
    console.log(`  By pool:  ${Object.keys(byPool).length} pools have received bribes`);
    console.log(`  Bribers:  ${Object.keys(bribers).length} unique addresses`);

    // Build snapshot files
    const masterFile = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        currentEpoch,
        stats: {
            total_proposals: proposals.length,
            total_add_bribe_msgs: allBribes.length,
            executed_bribes: executedBribes.length,
            epochs_with_bribes: Object.keys(byEpoch).length,
            pools_bribed: Object.keys(byPool).length,
            bribers: Object.keys(bribers).length,
        },
        bribes: executedBribes,   // flat list, easy to filter
    };

    const currentStateFile = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        currentEpoch,
        active_bribes: currentBuckets,   // from bribe-manager contract
    };

    const bribersFile = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        bribers,
    };

    // Compute data fingerprint and check freshness vs previous run.
    // Catches frozen PD proposal queries or frozen bribe-manager contract reads.
    console.log('🔍 Computing data fingerprint...');
    const dataFingerprint = computeDataFingerprint(masterFile, currentStateFile);
    const prevHeartbeat = await fetchPreviousHeartbeat();
    const freshness = classifyFreshness(dataFingerprint, prevHeartbeat);
    const freshnessIcon = { fresh: '✓', suspicious: '⚠', stuck: '🔴' }[freshness.dataFreshness];
    console.log(`   fingerprint: ${dataFingerprint}  previous: ${freshness.previousFingerprint || '(none)'}`);
    console.log(`   ${freshnessIcon} dataFreshness: ${freshness.dataFreshness}` +
                (freshness.consecutiveStuckRuns > 1
                    ? `  (${freshness.consecutiveStuckRuns} consecutive identical runs)`
                    : ''));

    // Status: stuck overrides ok (no chain-failure concept here)
    const status = freshness.dataFreshness === 'stuck' ? 'stuck' : 'ok';

    // Publish or save locally
    if (GITHUB_TOKEN) {
        console.log('\n📤 Publishing to GitHub...');
        await pushToGithub('data/pd-bribes-history.json', JSON.stringify(masterFile, null, 2),
            `📊 Bribes history — ${proposals.length} props, ${executedBribes.length} executed bribes`);
        await pushToGithub('data/current-state.json', JSON.stringify(currentStateFile, null, 2),
            `📊 Current bribe-manager state (epoch ${currentEpoch})`);
        await pushToGithub('data/bribers-registry.json', JSON.stringify(bribersFile, null, 2),
            `📊 Bribers registry (${Object.keys(bribers).length} addresses)`);
        // Per-epoch files
        for (const ep of Object.keys(byEpoch)) {
            const filename = `data/by-epoch/epoch-${ep}.json`;
            const content = JSON.stringify({
                schemaVersion: 1, capturedAt: startedAt.toISOString(),
                epoch: parseInt(ep), bribes: byEpoch[ep],
            }, null, 2);
            await pushToGithub(filename, content, `📊 Epoch ${ep} bribes (${byEpoch[ep].length} records)`);
        }
        // Heartbeat — written last so its presence implies all other pushes succeeded
        const heartbeat = {
            schemaVersion: 1,
            cron: 'bribes-history',
            capturedAt: startedAt.toISOString(),
            capturedAtUnix: startedAt.getTime(),
            runId: `bribes-${startedAt.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
            runMode: 'daily',
            currentEpoch,
            status,
            stats: masterFile.stats,
            // Freshness-monitoring fields (catches PD/bribe-manager frozen failures)
            dataFingerprint,
            previousFingerprint:  freshness.previousFingerprint,
            dataFreshness:        freshness.dataFreshness,
            consecutiveStuckRuns: freshness.consecutiveStuckRuns,
            next_expected_run_at: new Date(startedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        };
        await pushToGithub('data/heartbeat.json', JSON.stringify(heartbeat, null, 2),
            `📍 Bribes-history heartbeat`);
    } else {
        console.log('\n⚠️  GITHUB_TOKEN not set — saving locally');
        fs.writeFileSync('pd-bribes-history.json', JSON.stringify(masterFile, null, 2));
        fs.writeFileSync('current-state.json',     JSON.stringify(currentStateFile, null, 2));
        fs.writeFileSync('bribers-registry.json',  JSON.stringify(bribersFile, null, 2));
        // One epoch file as sample
        const sampleEp = Object.keys(byEpoch).sort((a, b) => b - a)[0];
        if (sampleEp) {
            fs.writeFileSync(`epoch-${sampleEp}.json`, JSON.stringify({
                schemaVersion: 1, capturedAt: startedAt.toISOString(),
                epoch: parseInt(sampleEp), bribes: byEpoch[sampleEp],
            }, null, 2));
        }
        // Heartbeat — local (still includes freshness fields for schema consistency)
        fs.writeFileSync('heartbeat.json', JSON.stringify({
            schemaVersion: 1, cron: 'bribes-history',
            capturedAt: startedAt.toISOString(), capturedAtUnix: startedAt.getTime(),
            runId: `bribes-${startedAt.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
            runMode: 'daily', currentEpoch, status,
            stats: masterFile.stats,
            // Freshness-monitoring fields
            dataFingerprint,
            previousFingerprint:  freshness.previousFingerprint,
            dataFreshness:        freshness.dataFreshness,
            consecutiveStuckRuns: freshness.consecutiveStuckRuns,
            next_expected_run_at: new Date(startedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        }, null, 2));
        console.log(`  Saved: pd-bribes-history.json, current-state.json, bribers-registry.json, epoch-${sampleEp}.json, heartbeat.json`);
    }

    console.log(`\n✅ Done (${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s)\n`);
    return masterFile;
}

captureBribesHistory()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('\n❌ Failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    });
