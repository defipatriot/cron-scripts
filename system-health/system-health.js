// =============================================================================
// System Health Monitor
// =============================================================================
//
// Reads every cron's heartbeat.json, evaluates freshness vs expected cadence,
// status, and stuck-data signals, then writes ONE system-health.json that the
// System Health page renders. This is the operational face of the whole platform
// — one glance tells you whether the data can be trusted right now.
//
// It catches: stale feeds (cron stopped running), failed/partial runs, stuck data
// (same fingerprint repeatedly = upstream frozen), and surfaces price-divergence
// flags + large swings as accuracy signals. Plain-language reasons for every
// non-green state.
//
// Reads from GitHub raw (no chain access). Writes to system-health-data_2026.
// Should run FREQUENTLY (every 15-30 min) so the page is always current.
// =============================================================================

'use strict';

const https = require('https');
const fs = require('fs');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/system-health-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const RAW = 'https://raw.githubusercontent.com/defipatriot';

// Each monitored cron: repo, heartbeat path, expected cadence (minutes), and
// whether staleness is EXPECTED (e.g. frozen upstream) so we don't false-alarm.
const MONITORED = [
    { key: 'network-and-prices', repo: 'network-and-prices-data_2026', path: 'data/heartbeat.json', cadenceMin: 60,   tier: 'foundation' },
    { key: 'tla-registry',       repo: 'tla-chain-registry',           path: '2026/heartbeat.json', cadenceMin: 1440, tier: 'foundation' },
    { key: 'tla-snapshot',       repo: 'tla-snapshot-data_2026',       path: 'data/heartbeat.json', cadenceMin: 60,   tier: 'core' },
    { key: 'nft-inventory',      repo: 'nft-inventory-data_2026',      path: 'data/v2/heartbeat.json', cadenceMin: 60, tier: 'core' },
    { key: 'marketplace',        repo: 'marketplace-data_2026',        path: 'data/heartbeat.json', cadenceMin: 60,   tier: 'core' },
    { key: 'fuel',               repo: 'tla-core',                     path: 'fuel/snapshots/heartbeat.json', cadenceMin: 60, tier: 'aux', note: 'Migrated to tla-core/fuel (2026-06) ✓' },
    { key: 'bribes-history',     repo: 'bribes-data_2026',             path: 'data/heartbeat.json', cadenceMin: 1440, tier: 'core' },
    { key: 'adao-positions',     repo: 'adao-positions-data_2026',     path: 'data/heartbeat.json', cadenceMin: 1440, tier: 'core' },
    { key: 'tla-participants',   repo: 'tla-participants-data_2026',   path: 'data/heartbeat.json', cadenceMin: 1440, tier: 'core' },
    { key: 'adao-allies',        repo: 'adao-allies-data_2026',        path: 'data/heartbeat.json', cadenceMin: 1440, tier: 'core' },
    { key: 'tla-locks',          repo: 'tla-locks-data_2026',          path: 'data/heartbeat.json', cadenceMin: 1440, tier: 'core' },
    { key: 'votion-positions',   repo: 'votion-positions-data_2026',   path: 'data/heartbeat.json', cadenceMin: 1440, tier: 'core' },
    { key: 'votion',             repo: 'votion-data_2026',             path: 'data/heartbeat.json', cadenceMin: 10080, tier: 'aux' },
    { key: 'ampcapa',            repo: 'ampcapa-data_2026',            path: 'snapshots/heartbeat.json', cadenceMin: 1440, tier: 'aux' },
    { key: 'backing',            repo: 'backing-data_2026',            path: 'snapshots/heartbeat.json', cadenceMin: 1440, tier: 'aux' },
    { key: 'astroport',          repo: 'astroport-pool-data_2026',     path: 'data/heartbeat.json', cadenceMin: 1440, tier: 'core' },
    { key: 'tla-vp-holders',     repo: 'tla-vp-holders-data_2026',     path: 'data/heartbeat.json', cadenceMin: 1440, tier: 'aux' },
    { key: 'skeletonswap',       repo: 'ss-pool-data_2026',            path: 'data/heartbeat.json', cadenceMin: 1440, tier: 'aux', stale_expected: true, stale_reason: 'Upstream SkeletonSwap API frozen ~30d — data labeled unverified by design.' },
];

// External endpoints the platform depends on. We ping each and report up/down +
// latency, so "is our data trustworthy" extends down to "are the chain endpoints
// we rely on even alive right now." A cron failing is often downstream of one of
// these being down.
const ENDPOINTS = [
    { key: 'terra-lcd (primary)', url: 'https://terra-lcd.publicnode.com/cosmos/base/tendermint/v1beta1/blocks/latest', role: 'Terra LCD — chain queries (primary)' },
    { key: 'terra-rest (fallback)', url: 'https://terra-rest.publicnode.com/cosmos/base/tendermint/v1beta1/blocks/latest', role: 'Terra LCD — chain queries (fallback)' },
    { key: 'daodao indexer', url: 'https://indexer.daodao.zone', role: 'DAODAO indexer — staker resolution' },
    { key: 'pfpk', url: 'https://pfpk.daodao.zone', role: 'PFPK — wallet name resolution' },
    { key: 'coingecko', url: 'https://api.coingecko.com/api/v3/ping', role: 'CoinGecko — base asset prices' },
    { key: 'eris backend', url: 'https://backend.erisprotocol.com', role: 'Eris Protocol — LST/pool data' },
    { key: 'warlock (BBL)', url: 'https://warlock.backbonelabs.io', role: 'BackBone Labs — marketplace listings' },
];

function pingEndpoint(ep) {
    return new Promise((resolve) => {
        const start = Date.now();
        const req = https.get(ep.url, { timeout: 8000 }, res => {
            res.on('data', () => {});
            res.on('end', () => {
                const ms = Date.now() - start;
                const up = res.statusCode < 500;
                resolve({ key: ep.key, role: ep.role, up, status: res.statusCode, latency_ms: ms,
                    health: up ? (ms > 4000 ? 'warn' : 'ok') : 'down',
                    reason: up ? (ms > 4000 ? `Responding slowly (${ms}ms).` : `Up (${ms}ms, HTTP ${res.statusCode}).`) : `Returned server error ${res.statusCode}.` });
            });
        });
        req.on('error', () => resolve({ key: ep.key, role: ep.role, up: false, status: null, latency_ms: null, health: 'down', reason: 'No response — endpoint unreachable.' }));
        req.on('timeout', () => { req.destroy(); resolve({ key: ep.key, role: ep.role, up: false, status: null, latency_ms: null, health: 'down', reason: 'Timed out after 8s.' }); });
    });
}

// Grace multiplier: a cron is "late" only after cadence × this (tolerates jitter).
const LATE_GRACE = 1.5;
// "stale/down" after cadence × this.
const DOWN_GRACE = 3;

function fetchJson(url) {
    return new Promise((resolve) => {
        https.get(url, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        }).on('error', () => resolve(null));
    });
}

function evaluate(mon, hb, now) {
    const r = {
        key: mon.key, repo: mon.repo, tier: mon.tier,
        present: !!hb, status: null, health: null, reason: null,
        last_run: null, age_min: null, cadence_min: mon.cadenceMin,
        run_status: null, stuck: false, stats: null,
        note: mon.note || null,
    };
    if (!hb) {
        if (mon.no_heartbeat_yet) {
            r.health = 'info'; r.status = 'no_heartbeat_capability';
            r.reason = 'This cron does not yet write a heartbeat — health can\'t be auto-checked. (Add heartbeat.json to enable monitoring.)';
            return r;
        }
        r.health = mon.stale_expected ? 'warn' : 'down';
        r.status = 'no_heartbeat';
        r.reason = mon.stale_expected ? mon.stale_reason : 'No heartbeat found — the cron may never have run, or the repo/path is wrong.';
        return r;
    }
    const capMs = hb.capturedAtUnix || Date.parse(hb.capturedAt || '');
    r.last_run = hb.capturedAt || null;
    r.run_status = hb.status || null;
    r.stats = hb.stats || null;
    r.recent_errors = Array.isArray(hb.recent_errors) ? hb.recent_errors.slice(-5) : [];   // already sanitized by the cron
    r.stuck = (hb.consecutiveStuckRuns || 0) >= 3 || hb.dataFreshness === 'stuck';

    const ageMin = capMs ? Math.round((now - capMs) / 60000) : null;
    r.age_min = ageMin;

    // freshness vs cadence
    let fresh = 'fresh';
    if (ageMin != null) {
        if (ageMin > mon.cadenceMin * DOWN_GRACE) fresh = 'stale';
        else if (ageMin > mon.cadenceMin * LATE_GRACE) fresh = 'late';
    }

    // roll up health
    if (mon.stale_expected && fresh !== 'fresh') {
        r.health = 'warn'; r.status = 'stale_expected';
        r.reason = mon.stale_reason;
    } else if (fresh === 'stale') {
        r.health = 'down'; r.status = 'stale';
        r.reason = `Last update ${fmtAge(ageMin)} ago — expected every ${fmtDur(mon.cadenceMin)}. The cron may be failing or paused. Check Render logs.`;
    } else if (hb.status === 'error') {
        r.health = 'down'; r.status = 'error';
        r.reason = `Last run reported an ERROR. ${errHint(hb)}`;
    } else if (hb.status === 'partial') {
        r.health = 'warn'; r.status = 'partial';
        r.reason = `Last run was PARTIAL — some data captured, some failed. ${errHint(hb)}`;
    } else if (r.stuck) {
        r.health = 'warn'; r.status = 'stuck';
        r.reason = `Data fingerprint unchanged for ${hb.consecutiveStuckRuns || '3+'} runs — upstream source may be frozen (same data each run).`;
    } else if (fresh === 'late') {
        r.health = 'warn'; r.status = 'late';
        r.reason = `Slightly overdue (last ${fmtAge(ageMin)} ago, expected every ${fmtDur(mon.cadenceMin)}). Usually catches up on next run.`;
    } else {
        r.health = 'ok'; r.status = 'ok';
        r.reason = `Healthy — last updated ${fmtAge(ageMin)} ago.`;
    }
    return r;
}

function errHint(hb) {
    const s = hb.stats || {};
    const errs = s.error_count ?? s.members_with_errors ?? s.lock_errors ?? null;
    if (errs && errs > 0) return `${errs} item(s) had errors this run.`;
    if (s.any_discovery_incomplete) return 'Discovery was incomplete (paging/null).';
    return 'See the cron log for the specific cause.';
}
function fmtAge(min) { if (min == null) return '?'; if (min < 60) return `${min}m`; if (min < 1440) return `${Math.round(min/60)}h`; return `${Math.round(min/1440)}d`; }
function fmtDur(min) { if (min < 60) return `${min} min`; if (min < 1440) return `${min/60} h`; if (min === 1440) return 'day'; if (min === 10080) return 'week'; return `${Math.round(min/1440)} d`; }

// Map a system key to its cron source folder in the cron-scripts repo (public).
const CRON_FOLDER = {
    'network-and-prices':'network-and-prices', 'tla-registry':'chain/tla-registry',
    'tla-snapshot':'tla-snapshot', 'nft-inventory':'nft-inventory', 'marketplace':'marketplace-stats',
    'fuel':'fuel', 'bribes-history':'bribes-history', 'adao-positions':'adao-positions',
    'tla-participants':'tla-participants', 'adao-allies':'adao-allies', 'tla-locks':'tla-locks',
    'votion-positions':'votion-positions', 'votion':'votion', 'ampcapa':'ampcapa', 'backing':'backing',
    'astroport':'astroport', 'tla-vp-holders':'tla-vp-holders', 'skeletonswap':'skeletonswap-lp_data',
};
function cronSourceUrl(key) {
    const f = CRON_FOLDER[key];
    return f ? `https://github.com/defipatriot/cron-scripts/tree/main/${f}` : 'https://github.com/defipatriot/cron-scripts';
}

async function run() {
    const started = new Date();
    const now = started.getTime();
    console.log(`\n🩺 system-health — ${started.toISOString()}\n`);

    const results = [];
    for (const mon of MONITORED) {
        const hb = await fetchJson(`${RAW}/${mon.repo}/${GITHUB_BRANCH}/${mon.path}?t=${now}`);
        const r = evaluate(mon, hb, now);
        results.push(r);
        const icon = r.health === 'ok' ? '✓' : r.health === 'warn' ? '⚠' : '✗';
        console.log(`  ${icon} ${r.key.padEnd(20)} ${String(r.health).padEnd(5)} ${r.status} (${fmtAge(r.age_min)} ago)`);
    }

    // roll up overall
    const counts = { ok: 0, warn: 0, down: 0 };
    for (const r of results) counts[r.health] = (counts[r.health] || 0) + 1;
    // foundation/core down weighs heavier
    const criticalDown = results.filter(r => r.health === 'down' && (r.tier === 'foundation' || r.tier === 'core'));
    let overall = 'healthy', overallReason = 'All systems reporting fresh data.';
    if (criticalDown.length) {
        overall = 'degraded';
        overallReason = `${criticalDown.length} core system(s) stale/down: ${criticalDown.map(r => r.key).join(', ')}. Data on the site may be out of date.`;
    } else if (counts.down) {
        overall = 'minor';
        overallReason = `${counts.down} auxiliary feed(s) down — core data unaffected.`;
    } else if (counts.warn) {
        overall = 'watch';
        overallReason = `${counts.warn} feed(s) need a look (late/partial/stuck) — core data still fresh.`;
    }

    // confidence score: weighted % of core+foundation that are ok
    const coreSet = results.filter(r => r.tier !== 'aux');
    const coreOk = coreSet.filter(r => r.health === 'ok').length;
    const confidence = coreSet.length ? Math.round((coreOk / coreSet.length) * 100) : 0;

    // ping external endpoints
    console.log('\n🔌 checking endpoints...');
    const endpoints = await Promise.all(ENDPOINTS.map(pingEndpoint));
    for (const e of endpoints) console.log(`  ${e.health==='ok'?'✓':e.health==='warn'?'⚠':'✗'} ${e.key.padEnd(22)} ${e.reason}`);
    const epDown = endpoints.filter(e => e.health === 'down');

    const doc = {
        schemaVersion: 1,
        capturedAt: started.toISOString(),
        capturedAtUnix: now,
        overall, overall_reason: overallReason,
        confidence_pct: confidence,
        counts,
        attention: results.filter(r => r.health !== 'ok').map(r => ({ key: r.key, health: r.health, status: r.status, reason: r.reason, recent_errors: r.recent_errors || [] })),
        systems: results.map(r => ({
            ...r,
            data_repo_url: `https://github.com/defipatriot/${r.repo}`,
            cron_source_url: cronSourceUrl(r.key),
        })),
        endpoints,
        endpoints_down: epDown.length,
        next_self_run_hint: 'Run every 15–30 min so the page stays current.',
    };
    const content = JSON.stringify(doc, null, 2);

    const hbDoc = {
        schemaVersion: 1, capturedAt: started.toISOString(), status: 'ok',
        next_expected_run_at: new Date(now + 30 * 60000).toISOString(),
        stats: { overall, confidence_pct: confidence, ...counts },
    };

    if (!GITHUB_TOKEN) {
        fs.writeFileSync('system-health.json', content);
        console.log('\n(no token — wrote local system-health.json)');
    } else {
        await publishFile('data/system-health.json', content, `health: ${overall} (${confidence}% confidence)`);
        await publishFile('data/heartbeat.json', JSON.stringify(hbDoc, null, 2), `health monitor heartbeat`);
        console.log('  ✓ published data/system-health.json');
    }

    console.log(`\n${overall === 'healthy' ? '✅' : overall === 'watch' ? '👀' : '⚠️'}  OVERALL: ${overall} — ${confidence}% confidence`);
    console.log(`   ${overallReason}\n`);
}

// --- GitHub publish ---
function ghReq(method, apiPath, body) {
    return new Promise((resolve, reject) => {
        const opts = { hostname: 'api.github.com', path: apiPath, method,
            headers: { 'User-Agent': 'system-health/1.0', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } };
        if (body) opts.headers['Content-Type'] = 'application/json';
        const req = https.request(opts, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ res.statusCode>=200&&res.statusCode<300 ? resolve(JSON.parse(d||'{}')) : reject(new Error(`GitHub ${res.statusCode}: ${d.slice(0,150)}`)); }); });
        req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
    });
}
async function publishFile(path, content, message) {
    const apiPath = `/repos/${GITHUB_REPO}/contents/${path}`;
    let sha = null;
    try { sha = (await ghReq('GET', apiPath + `?ref=${GITHUB_BRANCH}`)).sha; } catch {}
    const body = { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    return ghReq('PUT', apiPath, body);
}

if (require.main === module) run().catch(e => { console.error('FATAL', e); process.exit(1); });
