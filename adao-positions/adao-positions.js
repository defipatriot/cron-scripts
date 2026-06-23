// =============================================================================
// aDAO Positions Cron — Phase 1
// =============================================================================
//
// Captures full TLA portfolio data for EVERY aDAO member (named + unknown). The
// dashboard uses this to render per-member "portfolio tracker" views with:
//   • LP positions and their performance over epochs
//   • Lock holdings and what they'd be worth if adjusted today (LST ratio gains)
//   • Voting allocations and pool status (active / at-risk / inactive)
//   • Pending rewards (zluna), pending rebase, pending bribes
//   • Wallet balances for TLA-relevant tokens
//
// CURRENT vs HISTORY (decision 2026-06-13):
//   • current.json captures ALL members (named + unknown) — the live view is
//     complete, totals are DAO-wide. Each member is tagged `is_registered`.
//   • Retained history (daily/weekly/epoch archives) is REGISTERED-ONLY —
//     unknown wallets are counted live but not tracked across time (their
//     retained-history section is intentionally blank). Registered members
//     opted into an identity (PFPK name), so their story is persisted.
//   • current.json also carries `totals` (DAO-wide) and `totals_named`
//     (registered-only, back-compat with the prior named-only figure).
//
// Schedule: Mondays at 01:00 UTC — runs ~1 hour after each TLA epoch boundary
//           (epoch starts at Monday 00:00 UTC, so we capture the just-settled state).
//           Cron string:  "0 1 * * 1"
// Runtime:  ~3-5 minutes (~1000 chain queries with parallelism)
// Output:   data/members.json    (light: all members, named or not)
//           data/current.json    (heavy: full portfolios for ALL members, is_registered-tagged)
//           data/weekly/epoch-{n}.json  (frozen archive per epoch — REGISTERED-ONLY)
//           data/daily/YYYY-MM-DD.json  (daily snapshot — REGISTERED-ONLY)
//
// Member discovery (self-updating):
//   1. PRIMARY: indexer.daodao.zone topStakers → all current DAO members
//   2. NAMES:   pfpk.daodao.zone per-address → DAO DAO profile names
//   3. FALLBACK: github.com/defipatriot/adao_json_storage/main/members.csv
//
// If daodao.zone is unreachable, the cron falls back to the GitHub CSV.
// If both are unreachable, the cron falls back to the previous cron's
// members.json. The cron never fully fails just from a missing member list.
// =============================================================================

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

// -----------------------------------------------------------------------------
// CONFIG

// -----------------------------------------------------------------------------
// CONFIG — aDAO-specific (shared TLA logic lives in ../lib/capture-engine.js)
// -----------------------------------------------------------------------------
const {
    loadSharedData,
    fetchMemberPortfolio,
    queryContract,
    fetchBankBalances,
    fetchJson,
    fetchText,
    parallelMap,
    bech32AddressToHex,
    currentEpochInfo,
    PFPK_BASE_URL,
    BATCH_CONCURRENCY,
    PFPK_TIMEOUT_MS,
    HTTP_TIMEOUT_MS,
} = require('../lib/capture-engine.js');

// aDAO governance + treasury (discovery-side, stays here)
const ADAO_VOTING_CONTRACT = 'terra1c57ur376szdv8rtes6sa9nst4k536dynunksu8tx5zu4z5u3am6qmvqx47';

const ADAO_TREASURY_WALLETS = [
    'terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm',
];

const COUNCIL_TREASURY_WALLETS = [
    'terra1yqv0af22675wlcmgflxk4ve07vt8qlm999gk0cuw5l64r5xxgadsyg8ywv',
];

const DAODAO_INDEXER_URL = `https://indexer.daodao.zone/phoenix-1/contract/${ADAO_VOTING_CONTRACT}/daoVotingCw721Staked/topStakers`;
const FALLBACK_MEMBERS_CSV_URL = 'https://raw.githubusercontent.com/defipatriot/adao_json_storage/main/members.csv';
const SELF_CACHED_MEMBERS  = 'https://raw.githubusercontent.com/defipatriot/adao-positions-data_2026/main/data/members.json';
// Our own last-published full snapshot. Used to carry forward the last-good treasury
// VP if a live capture fails under LCD load, so history never regresses to a false 0.
const SELF_CURRENT_URL     = 'https://raw.githubusercontent.com/defipatriot/adao-positions-data_2026/main/data/current.json';

// A treasury portfolio is untrustworthy if its core chain queries failed (returned
// null after retries — LCD saturation) or it came back with no VP and no locks. The
// DAO treasury always holds locks, so an empty capture means the query failed, NOT
// that the VP is genuinely zero. We must never let that overwrite good history.
function treasuryCaptureFailed(p) {
    if (!p) return true;
    if (p._error) return true;
    const hadNullQueries = (p._errors || []).some(e => /null after retries/i.test(String(e)));
    const vp = (p.voting && p.voting.total_voting_power_human) || 0;
    const lockCount = (p.locks || []).length;
    const emptyCapture = !(vp > 0) && lockCount === 0;
    return hadNullQueries || emptyCapture;
}

// Treasury/council wallet definitions may be plain address strings or objects.
// Reading t.address on a string yields undefined — which silently targets every
// chain query at an undefined wallet (the actual epoch-189 break). Normalize both
// shapes so the address is always valid.
function normWallet(t, defLabel, defKind) {
    if (typeof t === 'string') return { address: t, label: defLabel, kind: defKind };
    return { address: t.address, label: t.label || t.name || defLabel, kind: t.kind || defKind };
}

// Publish target (cron-side only)
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/adao-positions-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// -----------------------------------------------------------------------------
// MEMBER DISCOVERY (aDAO-specific)
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// MEMBER DISCOVERY — daodao.zone primary, GitHub CSV fallback
// -----------------------------------------------------------------------------

async function fetchTopStakers() {
    try {
        const data = await fetchJson(DAODAO_INDEXER_URL, 'daodao-indexer-topStakers');
        if (Array.isArray(data)) {
            console.log(`  ✓ DAO DAO indexer: ${data.length} members fetched`);
            return data.map(m => ({
                address: m.address,
                nft_count: m.count || 0,
                vp_pct_of_dao: m.votingPowerPercent || 0,
                source: 'daodao_indexer',
            }));
        }
        return null;
    } catch (e) {
        console.warn(`  ⚠ DAO DAO indexer failed: ${e.message}`);
        return null;
    }
}

function parseCsvRow(line) {
    // Simple CSV row parser handling quoted fields
    const out = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            if (inQuote && line[i+1] === '"') { cur += '"'; i++; }
            else inQuote = !inQuote;
        } else if (c === ',' && !inQuote) {
            out.push(cur); cur = '';
        } else {
            cur += c;
        }
    }
    out.push(cur);
    return out;
}

async function fetchFallbackCsv() {
    try {
        const text = await fetchText(FALLBACK_MEMBERS_CSV_URL, 'fallback-csv');
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length < 2) return null;
        const headers = parseCsvRow(lines[0]).map(h => h.replace(/^[\ufeff"]+|"$/g, ''));
        const memberCol  = headers.findIndex(h => /member|address/i.test(h));
        const nameCol    = headers.findIndex(h => /^name$/i.test(h));
        const stakedCol  = headers.findIndex(h => /staked/i.test(h));
        const vpCol      = headers.findIndex(h => /voting/i.test(h));
        if (memberCol < 0) return null;

        const out = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = parseCsvRow(lines[i]);
            const address = cols[memberCol]?.replace(/^["']+|["']+$/g, '').trim();
            if (!address || !address.startsWith('terra1')) continue;
            out.push({
                address,
                name: (nameCol >= 0 ? cols[nameCol] : '').trim() || null,
                nft_count: parseInt(cols[stakedCol] || '0') || 0,
                vp_pct_of_dao: parseFloat(cols[vpCol] || '0') || 0,
                source: 'fallback_csv',
            });
        }
        console.log(`  ✓ Fallback CSV: ${out.length} members loaded`);
        return out;
    } catch (e) {
        console.warn(`  ⚠ Fallback CSV failed: ${e.message}`);
        return null;
    }
}

async function fetchSelfCachedMembers() {
    try {
        const data = await fetchJson(SELF_CACHED_MEMBERS, 'self-cached-members');
        if (data?.members?.length) {
            console.log(`  ✓ Self-cached: ${data.members.length} members loaded`);
            return data.members.map(m => ({ ...m, source: 'self_cached' }));
        }
        return null;
    } catch (e) {
        console.warn(`  ⚠ Self-cached members.json failed: ${e.message}`);
        return null;
    }
}

async function resolveNamesFromPfpk(members) {
    // Try to resolve names via pfpk.daodao.zone for any member without a name
    let resolved = 0, failed = 0;
    const tasks = members.filter(m => !m.name).map(m => async () => {
        const hex = bech32AddressToHex(m.address);
        if (!hex) { failed++; return; }
        try {
            const data = await fetchJson(PFPK_BASE_URL + hex, 'pfpk', PFPK_TIMEOUT_MS);
            if (data?.name) {
                m.name = data.name;
                if (data.nft?.imageUrl) m.nft_image_url = data.nft.imageUrl;
                m.has_pfpk_profile = true;
                resolved++;
            } else {
                m.has_pfpk_profile = false;
            }
        } catch (e) {
            failed++;
            m.has_pfpk_profile = false;
        }
    });
    // Run pfpk lookups in parallel (lightweight requests)
    await parallelMap(tasks, t => t(), 20);
    console.log(`  ✓ PFPK names: ${resolved} resolved, ${failed} failed`);
    return resolved;
}

async function resolveMembers() {
    console.log('👥 Discovering aDAO members...');
    // 1. Try daodao.zone indexer
    let members = await fetchTopStakers();
    let primarySource = 'daodao_indexer';

    // 2. Fallback: GitHub CSV
    if (!members || members.length === 0) {
        members = await fetchFallbackCsv();
        primarySource = 'fallback_csv';
    }

    // 3. Fallback to self-cached if both failed
    if (!members || members.length === 0) {
        members = await fetchSelfCachedMembers();
        primarySource = 'self_cached';
    }

    if (!members || members.length === 0) {
        throw new Error('Could not load member list from any source (daodao indexer / CSV / self-cache)');
    }

    // Resolve names via pfpk (if from indexer; CSV already has names baked in)
    const withoutNames = members.filter(m => !m.name).length;
    if (withoutNames > 0) {
        await resolveNamesFromPfpk(members);
    }

    // Cross-reference with fallback CSV to fill any missing names (insurance)
    if (primarySource === 'daodao_indexer') {
        const csvMembers = await fetchFallbackCsv();
        if (csvMembers) {
            const byAddr = new Map(csvMembers.map(m => [m.address, m.name]));
            let filled = 0;
            for (const m of members) {
                if (!m.name && byAddr.has(m.address)) {
                    m.name = byAddr.get(m.address);
                    filled++;
                }
            }
            if (filled > 0) console.log(`  ✓ CSV cross-reference filled ${filled} additional names`);
        }
    }

    const named = members.filter(m => m.name && m.name.trim().length > 0);
    console.log(`  ✓ Final: ${members.length} total members, ${named.length} named (${primarySource})`);

    return { allMembers: members, namedMembers: named, primarySource };
}


// -----------------------------------------------------------------------------
// ROLLUPS + OUTPUT (aDAO-specific)
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// TOP-LEVEL ROLLUPS
// -----------------------------------------------------------------------------

function computeRollups(portfolios) {
    const totals = {
        named_member_count: portfolios.length,
        total_voting_power_human: 0,
        total_locked_luna_equivalent: 0,
        total_locked_usd: 0,
        total_lp_position_usd: 0,
        amplified_lp_usd: 0,
        non_amplified_lp_usd: 0,
        total_pending_rewards_usd: 0,
        total_pending_bribes_usd: 0,
        total_wallet_balances_usd: 0,
        total_potential_vp_gain_human: 0,
        active_lp_positions: 0,
        at_risk_lp_positions: 0,
        inactive_lp_positions: 0,
        amplified_lp_positions: 0,
        non_amplified_lp_positions: 0,
        lock_count: 0,
        members_with_at_risk_positions: 0,
    };
    for (const p of portfolios) {
        const s = p.summary || {};
        totals.total_voting_power_human += s.voting_power_human || 0;
        totals.total_locked_luna_equivalent += s.total_locked_luna_equivalent || 0;
        totals.total_locked_usd += s.total_locked_usd || 0;
        totals.total_lp_position_usd += s.total_lp_position_usd || 0;
        totals.amplified_lp_usd += s.amplified_lp_usd || 0;
        totals.non_amplified_lp_usd += s.non_amplified_lp_usd || 0;
        totals.total_pending_rewards_usd += s.total_pending_rewards_usd || 0;
        totals.total_pending_bribes_usd += s.total_pending_bribes_usd || 0;
        totals.total_wallet_balances_usd += s.total_wallet_balances_usd || 0;
        totals.total_potential_vp_gain_human += s.total_potential_vp_gain_human || 0;
        totals.active_lp_positions += s.active_lp_position_count || 0;
        totals.at_risk_lp_positions += s.at_risk_lp_position_count || 0;
        totals.inactive_lp_positions += s.inactive_lp_position_count || 0;
        totals.amplified_lp_positions += s.amplified_lp_position_count || 0;
        totals.non_amplified_lp_positions += s.non_amplified_lp_position_count || 0;
        totals.lock_count += s.lock_count || 0;
        if ((s.at_risk_lp_position_count || 0) > 0 || (s.inactive_lp_position_count || 0) > 0) {
            totals.members_with_at_risk_positions++;
        }
    }
    return totals;
}


// -----------------------------------------------------------------------------
// GITHUB PUBLISH (same pattern as other crons)
// -----------------------------------------------------------------------------

function githubApiRequest(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'api.github.com', path: apiPath, method,
            headers: {
                'User-Agent': 'aDAO-positions-cron/1.0',
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
    } catch (e) {
        // File doesn't exist yet — that's fine
    }
    const body = {
        message,
        content: Buffer.from(content).toString('base64'),
        branch: GITHUB_BRANCH,
    };
    if (sha) body.sha = sha;
    return githubApiRequest('PUT', apiPath, body);
}

// -----------------------------------------------------------------------------
// MAIN CAPTURE FLOW
// -----------------------------------------------------------------------------

// =============================================================================
// DATA FRESHNESS MONITORING
// =============================================================================
//
// Detects upstream-frozen failures: chain queries returning stale balances,
// daodao.zone topStakers/pfpk frozen, or tla-snapshot upstream frozen.
//
// adao-positions has the broadest blast radius of any cron — it touches ~1000
// chain queries, multiple TLA contracts, every named member's wallet, and
// reads from the network-and-prices + tla-snapshot upstreams. If everything
// froze at once, the fingerprint catches it.
//
// Fingerprint inputs: top-level totals + per-member (address, vp, lp_position,
// pending rewards/bribes). Excludes epoch.number (counter that auto-flips).
// 3 identical consecutive runs → 'stuck'.

const STUCK_THRESHOLD = 3;  // 3+ identical consecutive runs → 'stuck'

function computeDataFingerprint(portfoliosDoc) {
    const totals = portfoliosDoc.totals || {};
    // Per-member volatile signals
    const memberItems = [];
    for (const m of portfoliosDoc.members || []) {
        const s = m.summary || {};
        memberItems.push([
            m.wallet || m.name || '?',
            s.voting_power_human ?? null,
            s.total_lp_position_usd ?? null,
            s.total_pending_rewards_usd ?? null,
            s.total_pending_bribes_usd ?? null,
            s.lock_count ?? null,
        ]);
    }
    memberItems.sort((a, b) => String(a[0]).localeCompare(String(b[0])));

    const input = JSON.stringify({
        // Pick only the numeric/scalar totals — skip nested objects
        totals: {
            named_member_count:           totals.named_member_count ?? null,
            total_voting_power_human:     totals.total_voting_power_human ?? null,
            total_lp_position_usd:        totals.total_lp_position_usd ?? null,
            total_locked_usd:             totals.total_locked_usd ?? null,
            total_pending_rewards_usd:    totals.total_pending_rewards_usd ?? null,
            total_pending_bribes_usd:     totals.total_pending_bribes_usd ?? null,
            total_wallet_balances_usd:    totals.total_wallet_balances_usd ?? null,
            active_lp_positions:          totals.active_lp_positions ?? null,
            at_risk_lp_positions:         totals.at_risk_lp_positions ?? null,
        },
        members: memberItems,
        luna_price: portfoliosDoc.luna_price_used_usd ?? null,
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

async function captureSnapshot() {
    const startedAt = new Date();
    console.log(`🚀 aDAO Positions Cron — ${startedAt.toISOString()}`);
    const epochInfo = currentEpochInfo();
    console.log(`📅 Current epoch: ${epochInfo.number} (${epochInfo.progress_pct.toFixed(1)}% through)`);

    // Phase 1: Member discovery
    const { allMembers, namedMembers, primarySource } = await resolveMembers();

    // Phase 2: Load shared data
    const ctx = await loadSharedData();

    // Phase 3: Per-member portfolio queries (parallel batched).
    // We now capture ALL members (named + unknown) so the CURRENT-run view is
    // complete (totals reflect the whole DAO, not just named members). History
    // retention, however, is registered-only — see Phase 6 (the daily/weekly/
    // epoch archives carry named members; unknowns live only in current.json).
    // Decision (2026-06-13): registered members opted into an identity (PFPK
    // name), so we persist their story; unknown wallets are counted live but
    // not tracked across time (their retained-history section is intentionally
    // blank). Each portfolio is tagged `is_registered` so consumers can split.
    console.log(`💼 Fetching portfolios for ${allMembers.length} members (${namedMembers.length} named + ${allMembers.length - namedMembers.length} unknown)...`);
    const namedSet = new Set(namedMembers.map(m => m.address));
    const portfolios = await parallelMap(allMembers, m => fetchMemberPortfolio(m, ctx).then(p => {
        if (p) p.is_registered = namedSet.has(p.wallet);
        return p;
    }), BATCH_CONCURRENCY);
    const validPortfolios = portfolios.filter(p => p && !p._error);
    const validNamed = validPortfolios.filter(p => p.is_registered);
    const validUnknown = validPortfolios.filter(p => !p.is_registered);
    console.log(`  ✓ ${validPortfolios.length}/${allMembers.length} portfolios captured (${validNamed.length} named, ${validUnknown.length} unknown)`);

    // Phase 3b: Treasury wallets (aDAO Core + any other tracked DAO addresses).
    // Tracked alongside members so the TLA Stats page can show treasury-only data.
    // Uses the same portfolio shape, just tagged with `kind`.
    console.log(`🏛️  Fetching ${ADAO_TREASURY_WALLETS.length} treasury wallet(s)...`);
    // The treasury wallet is query-heavy and its VP is critical, so under LCD load a
    // single pass can come back null-after-retries — this is what zeroed VP from epoch
    // 189 onward. Retry the WHOLE capture a few times with a cooldown before accepting
    // failure; cheap since it's only 1–2 wallets, and far more reliable than one pass.
    async function captureTreasury(t) {
        const w = normWallet(t, 'aDAO Treasury', 'treasury');
        let last = null;
        for (let attempt = 1; attempt <= 4; attempt++) {
            const p = await fetchMemberPortfolio({
                address: w.address, name: w.label, nft_count: 0, vp_pct_of_dao: 0,
            }, ctx).then(pp => { if (pp) { pp.kind = w.kind; pp.is_treasury = true; pp.name = pp.name || w.label; } return pp; })
              .catch(() => null);
            last = p;
            if (!treasuryCaptureFailed(p)) return p;        // clean capture
            if (attempt < 4) {
                console.warn(`  ⚠ treasury ${w.label} attempt ${attempt} failed (null-after-retries) — cooling down`);
                await new Promise(r => setTimeout(r, 1500 * attempt)); // let the LCD recover
            }
        }
        return last; // all attempts failed; the (failed) portfolio or null
    }
    // Concurrency 1 so the critical treasury queries run on an un-saturated LCD.
    const treasuryPortfolios = await parallelMap(ADAO_TREASURY_WALLETS, captureTreasury, 1);
    const validTreasuries = treasuryPortfolios.filter(p => p && !treasuryCaptureFailed(p));
    console.log(`  ✓ ${validTreasuries.length}/${ADAO_TREASURY_WALLETS.length} treasury portfolios captured clean`);
    for (const t of validTreasuries) {
        const s = t.summary || {};
        console.log(`    ${t.name}: VP ${s.voting_power_human?.toFixed(0)}, LP $${s.total_lp_position_usd?.toFixed(0)}, Locks ${s.lock_count}, Rewards $${s.total_pending_rewards_usd?.toFixed(2)}`);
    }

    // Guard + carry-forward: never overwrite good history with a failed (zeroed) capture.
    // VP is stable — it only changes when locks are adjusted — so the last-good value is
    // the honest figure when a run's queries fail, not a fabrication. Reuse it, stamped.
    let treasuryToWrite = validTreasuries.length >= 1 ? validTreasuries[0] : null;
    if (!treasuryToWrite) {
        console.warn('  ⚠ treasury capture failed this run — attempting carry-forward of last-good VP');
        const prev = await fetchJson(SELF_CURRENT_URL, 'self-current-treasury').catch(() => null);
        const prevT = prev && prev.treasury;
        const prevVp = prevT && prevT.voting && prevT.voting.total_voting_power_human;
        if (prevT && (prevVp > 0 || (prevT.locks || []).length)) {
            treasuryToWrite = {
                ...prevT,
                _carried_forward: true,
                _carry_reason: 'live capture failed (LCD null-after-retries) — preserved last-good VP',
                _carried_from: prev.capturedAt || null,
            };
            const cvp = treasuryToWrite.summary?.display_voting_power_human || treasuryToWrite.summary?.voting_power_human || 0;
            console.warn(`  ↻ carried forward treasury VP ${cvp.toFixed(0)} from ${prev.capturedAt || 'previous run'}`);
        } else {
            console.warn('  ✗ no prior good treasury to carry forward — treasury will be null this run');
        }
    }

    // Phase 3c: Council treasury wallets. Same fetch path as aDAO treasury, but written
    // to separate top-level fields. Council has no TLA participation so most of the
    // returned portfolio shape is empty — wallet_balances + summary.total_wallet_balances_usd
    // are the meaningful fields. Failures here never block the rest of the cron.
    console.log(`🏛️  Fetching ${COUNCIL_TREASURY_WALLETS.length} council wallet(s)...`);
    const councilPortfolios = await parallelMap(COUNCIL_TREASURY_WALLETS, t => {
        const w = normWallet(t, 'aDAO Council', 'council');
        return fetchMemberPortfolio({
            address: w.address,
            name: w.label,
            nft_count: 0,
            vp_pct_of_dao: 0,
        }, ctx).then(p => {
            if (p) {
                p.kind = w.kind;
                p.is_treasury = true;
                p.name = p.name || w.label;
            }
            return p;
        }).catch(err => {
            console.warn(`  ⚠ Council wallet ${w.label} failed: ${err.message}`);
            return null;
        });
    }, BATCH_CONCURRENCY);
    const validCouncils = councilPortfolios.filter(p => p && !p._error);
    console.log(`  ✓ ${validCouncils.length}/${COUNCIL_TREASURY_WALLETS.length} council portfolios captured`);
    for (const t of validCouncils) {
        const s = t.summary || {};
        console.log(`    ${t.name}: Wallet $${s.total_wallet_balances_usd?.toFixed(2) ?? '0.00'} (${t.wallet_balances?.length ?? 0} tokens)`);
    }

    // Phase 4: Sort + rank ALL current members by VP (registered + unknown),
    // so the live view ranks the whole DAO. Registered-only rank also stamped
    // for consumers that show the named leaderboard.
    validPortfolios.sort((a, b) => (b.voting?.total_voting_power_human || 0) - (a.voting?.total_voting_power_human || 0));
    validPortfolios.forEach((p, i) => { p.rank_by_vp = i + 1; });
    validNamed.forEach((p, i) => { p.rank_by_vp_named = i + 1; });

    // Phase 5: Rollups. Two sets — ALL-member totals (the true DAO-wide figure)
    // and named-only totals (back-compat with consumers expecting the prior
    // named-only number). `computeRollups` is reused for both.
    const totals = computeRollups(validPortfolios);
    const totalsNamed = computeRollups(validNamed);
    totals.all_member_count = validPortfolios.length;
    totals.named_only_count = validNamed.length;
    totals.unknown_count = validUnknown.length;
    console.log(`📊 Totals (all ${validPortfolios.length}): ${totals.total_voting_power_human.toFixed(0)} VP, $${totals.total_lp_position_usd.toFixed(0)} LP | named-only: ${totalsNamed.total_voting_power_human.toFixed(0)} VP`);
    if (totals.at_risk_lp_positions > 0) {
        console.log(`  ⚠ ${totals.at_risk_lp_positions} at-risk LP positions across ${totals.members_with_at_risk_positions} members`);
    }

    // Phase 6: Assemble outputs
    const membersDoc = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        epoch: epochInfo,
        primary_source: primarySource,
        total_members: allMembers.length,
        named_count: namedMembers.length,
        unnamed_count: allMembers.length - namedMembers.length,
        members: allMembers.map(m => ({
            address: m.address,
            name: m.name || null,
            nft_count: m.nft_count || 0,
            vp_pct_of_dao: m.vp_pct_of_dao || 0,
            nft_image_url: m.nft_image_url || null,
            has_pfpk_profile: m.has_pfpk_profile ?? null,
        })),
    };

    const portfoliosDoc = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        epoch: epochInfo,
        primary_source: primarySource,
        luna_price_used_usd: ctx.lunaPriceUsd,
        sources: {
            tla_snapshot_captured_at: ctx.tlaSnapshot?.capturedAt || null,
        },
        totals,            // DAO-wide (all current members)
        totals_named: totalsNamed,  // registered-only (back-compat / named leaderboard)
        treasury: treasuryToWrite,
        treasuries: treasuryToWrite ? [treasuryToWrite] : [],
        council_treasury: validCouncils.length === 1 ? validCouncils[0] : null,
        council_treasuries: validCouncils,
        members: validPortfolios,   // ALL current members (named + unknown), each tagged is_registered
    };

    // History-retention split (decision 2026-06-13): the RETAINED archives keep
    // registered members only — unknowns are live-only (blank history). So the
    // daily/weekly/epoch snapshots carry a registered-only portfolios doc.
    const portfoliosDocRetained = {
        ...portfoliosDoc,
        totals: totalsNamed,
        members: validNamed,
        retention: 'registered_only',
        note: 'Unknown (unnamed) members are intentionally excluded from retained history — see current.json for the full live view.',
    };

    // Phase 7: Save / publish
    if (!GITHUB_TOKEN) {
        console.log('⚠️  GITHUB_TOKEN not set — saving locally');
        fs.writeFileSync('members.json', JSON.stringify(membersDoc, null, 2));
        fs.writeFileSync('current.json', JSON.stringify(portfoliosDoc, null, 2));
        fs.writeFileSync(`weekly_epoch-${epochInfo.number}.json`, JSON.stringify(portfoliosDoc, null, 2));
        console.log(`  Saved locally: members.json (${(JSON.stringify(membersDoc).length/1024).toFixed(1)} KB), current.json (${(JSON.stringify(portfoliosDoc).length/1024).toFixed(1)} KB)`);
    } else {
        const membersContent = JSON.stringify(membersDoc, null, 2);
        const portfoliosContent = JSON.stringify(portfoliosDoc, null, 2);
        const portfoliosRetainedContent = JSON.stringify(portfoliosDocRetained, null, 2);
        const archivePath = `data/weekly/epoch-${epochInfo.number}.json`;

        await publishFile('data/members.json', membersContent, `members refresh epoch ${epochInfo.number}`);
        console.log(`  ✓ Published data/members.json`);
        await publishFile('data/current.json', portfoliosContent, `positions epoch ${epochInfo.number}`);
        console.log(`  ✓ Published data/current.json`);
        await publishFile(archivePath, portfoliosRetainedContent, `archive epoch ${epochInfo.number} (registered-only history)`);
        console.log(`  ✓ Published ${archivePath} (registered-only)`);

        // Daily archive — gives Portfolio Tracker enough time-series granularity
        // for P&L tracking and fee-accrual trends without bloating the repo. The
        // per-epoch archive above only fires once per 7 days (too coarse for
        // intra-epoch member position changes); 24×/day would be wasteful since
        // individual member positions don't typically change minute-to-minute.
        //
        // Strategy: write to data/daily/YYYY-MM-DD.json. If the cron runs multiple
        // times per day (hourly schedule on Render), the file is OVERWRITTEN
        // each run — so the daily file always reflects the most recent capture
        // of that calendar day. End-of-day = final state of the day, which is
        // what we actually want for daily P&L computation.
        const dateStr = startedAt.toISOString().slice(0, 10);
        const dailyPath = `data/daily/${dateStr}.json`;
        await publishFile(dailyPath, portfoliosRetainedContent, `📸 positions daily snapshot — ${dateStr} (registered-only history)`);
        console.log(`  ✓ Published ${dailyPath}`);

        // Compute data fingerprint and check freshness vs previous run.
        // Catches frozen chain queries, daodao.zone freezes, or upstream freezes.
        console.log('🔍 Computing data fingerprint...');
        const dataFingerprint = computeDataFingerprint(portfoliosDoc);
        const prevHeartbeat = await fetchPreviousHeartbeat();
        const freshness = classifyFreshness(dataFingerprint, prevHeartbeat);
        const freshnessIcon = { fresh: '✓', suspicious: '⚠', stuck: '🔴' }[freshness.dataFreshness];
        console.log(`   fingerprint: ${dataFingerprint}  previous: ${freshness.previousFingerprint || '(none)'}`);
        console.log(`   ${freshnessIcon} dataFreshness: ${freshness.dataFreshness}` +
                    (freshness.consecutiveStuckRuns > 1
                        ? `  (${freshness.consecutiveStuckRuns} consecutive identical runs)`
                        : ''));

        // Heartbeat — uniform freshness contract across all crons
        // Status is 'partial' if any tracked treasury fetch failed (council is optional but tracked).
        // 'stuck' overrides both 'ok' and 'partial' (worst wins).
        const allTreasuriesOk = validTreasuries.length === ADAO_TREASURY_WALLETS.length;
        const allCouncilsOk   = validCouncils.length === COUNCIL_TREASURY_WALLETS.length;
        // Member-level failures are recorded per-portfolio in `_errors` (visible, not silent), but
        // the run status must ALSO reflect them — otherwise the health widget stays green while a
        // member's position is incomplete, and that gap gets frozen into the permanent weekly archive.
        const membersWithErrors = validPortfolios.filter(p => Array.isArray(p._errors) && p._errors.length > 0).length;
        let status;
        if (freshness.dataFreshness === 'stuck')                                       status = 'stuck';
        else if (!allTreasuriesOk || !allCouncilsOk || membersWithErrors > 0)          status = 'partial';
        else                                                                           status = 'ok';

        const heartbeat = {
            schemaVersion: 1,
            cron: 'adao-positions',
            capturedAt: startedAt.toISOString(),
            capturedAtUnix: startedAt.getTime(),
            runId: `adao-${startedAt.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
            // runMode reflects scheduling cadence. The actual cadence is determined by
            // Render's cron schedule, not hardcoded here. Heartbeat consumers compute
            // freshness vs next_expected_run_at, so this is mainly informational.
            runMode: 'scheduled',
            currentEpoch: epochInfo.number,
            status,
            stats: {
                members_count: validPortfolios.length,
                members_with_errors: membersWithErrors,
                treasury_present: !!portfoliosDoc.treasury,
                council_present: !!portfoliosDoc.council_treasury,
                council_count: validCouncils.length,
            },
            // Freshness-monitoring fields (catches chain/upstream frozen failures)
            dataFingerprint,
            previousFingerprint:  freshness.previousFingerprint,
            dataFreshness:        freshness.dataFreshness,
            consecutiveStuckRuns: freshness.consecutiveStuckRuns,
            // Match the Render schedule. Currently set to 25 hours = daily schedule
            // (cron expression `0 1 * * *`). Slight overshoot from 24h gives jitter room.
            // If you change the Render schedule, update this:
            //   weekly: 7 * 24 * 60 * 60 * 1000  (was the original value)
            //   daily:  25 * 60 * 60 * 1000      (current)
            //   hourly: 75 * 60 * 1000           (75 min, allows for run-time + jitter)
            // The dashboard reads this value to drive its freshness indicator.
            next_expected_run_at: new Date(startedAt.getTime() + 25 * 60 * 60 * 1000).toISOString(),
        };
        await publishFile('data/heartbeat.json', JSON.stringify(heartbeat, null, 2),
            `📍 aDAO positions heartbeat — epoch ${epochInfo.number}`);
        console.log(`  ✓ Published data/heartbeat.json`);
    }

    const elapsed = (Date.now() - startedAt.getTime()) / 1000;
    console.log(`✅ Done (${elapsed.toFixed(1)}s)`);
}

// -----------------------------------------------------------------------------
// ENTRY POINT
// -----------------------------------------------------------------------------

// Only auto-run when invoked as a script (not when require()'d by a test harness)
if (require.main === module) {
    captureSnapshot().catch(e => {
        console.error(`❌ FATAL: ${e.message}`);
        console.error(e.stack);
        process.exit(1);
    });
}

// Exports for sandbox testing — does not affect production behavior
module.exports = {
    captureSnapshot,
    loadSharedData,
    fetchMemberPortfolio,
    COUNCIL_TREASURY_WALLETS,
    ADAO_TREASURY_WALLETS,
    currentEpochInfo,
};
