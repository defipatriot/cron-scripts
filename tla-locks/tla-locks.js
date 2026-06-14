// =============================================================================
// TLA Locks Cron — system-wide veLUNA lock health & intelligence
// =============================================================================
//
// The differentiated capture: stale-VP gap, unlock cliffs, VP decay, per-asset
// VP totals, auto-max vs decaying split — metrics that exist nowhere else in the
// ecosystem (not even Eris surfaces them). Enumerates every veLUNA lock NFT and
// derives both a SYSTEM view and a PER-HOLDER view.
//
// Lock contract (veLUNA / "Vote Escrowed LUNA"):
//   terra1uqhj8agyeaz8fu6mdggfuwr3lp32jlrx5hqag4jxexde92rzkamq3l62zg
// CW721-enumerable. lock_info per token gives owner, asset (LST), amount,
// underlying_amount (RATIO FROZEN AT LOCK TIME), coefficient, start/end periods,
// slope (VP decay/wk), voting_power, fixed_amount.
//
// Key derived metrics:
//   • Auto-max detection: end=="permanent" && slope==0  → perpetually max-locked
//   • Stale-VP gap: VP is stamped at lock-time LST ratio. If the ratio rose,
//     the holder's true VP is higher than stamped until they touch the lock.
//     gap = (amount × current_ratio − frozen_underlying) × coefficient
//   • Unlock cliff: VP-weighted histogram of upcoming unlocks by week.
//   • System totals: ONE total_vamp call → {fixed, voting_power, vp}.
//
// Uses the shared engine for chain primitives + prices/ratios (loadSharedData).
// RETENTION: live-only for v1 (system snapshot + per-holder). Daily archive of
//   the system summary is cheap and enables decay/cliff history — included.
//
// Output repo: tla-locks-data_2026
//   data/current.json    — full: system summary + every lock + per-holder rollups
//   data/summary.json     — light: system aggregates only (for fast tiles)
//   data/daily/YYYY-MM-DD.json — daily system-summary snapshot (decay/cliff history)
//   data/heartbeat.json
// =============================================================================

'use strict';

const https = require('https');
const fs = require('fs');

const {
    loadSharedData,
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

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/tla-locks-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

const ALL_TOKENS_PAGE = 100;
const EPOCH_START_MS = Date.parse('2022-10-31T00:00:00Z');

// Lockable-asset symbol map (fixed, small set — confirmed via token_info 2026-06-13).
// More robust than matching the lock config against the price list. Keyed by the
// assetKey() form: 'cw20:<addr>' or 'native:<denom>'.
const LOCK_ASSET_SYMBOLS = {
    'native:uluna': 'LUNA',
    'cw20:terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct': 'ampLUNA',
    'cw20:terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml': 'bLUNA',
    'cw20:terra1se7rvuerys4kd2snt6vqswh9wugu49vhyzls8ymc02wl37g2p2ms5yz490': 'arbLUNA',
    'native:ibc/08095CEDEA29977C9DD0CE9A48329FDA622C183359D5F90CF04CC4FF80CBE431': 'stLUNA',
};
const WEEK_MS = 7 * 24 * 3600 * 1000;

function epochToDate(period) {
    if (period == null) return null;
    return new Date(EPOCH_START_MS + period * WEEK_MS).toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------
// Enumerate all lock token_ids (CW721, cursor-paginated, F2-guarded)
// -----------------------------------------------------------------------------
async function enumerateLockTokens() {
    let expected = null;
    const nt = await queryContract(TLA_VOTING_ESCROW, { num_tokens: {} });
    if (nt && nt.count != null) expected = Number(nt.count);

    const ids = [];
    let startAfter, pages = 0, ok = true;
    while (true) {
        const q = { all_tokens: { limit: ALL_TOKENS_PAGE, ...(startAfter !== undefined ? { start_after: startAfter } : {}) } };
        const page = await queryContract(TLA_VOTING_ESCROW, q);
        pages++;
        if (page === null) { ok = false; console.error(`  ✗ all_tokens page ${pages} null — INCOMPLETE`); break; }
        const t = Array.isArray(page.tokens) ? page.tokens : [];
        if (t.length === 0) break;
        ids.push(...t);
        startAfter = t[t.length - 1];
        if (t.length < ALL_TOKENS_PAGE) break;
        if (pages > 50) { ok = false; console.warn('  ⚠ >50 pages, stopping'); break; }
    }
    if (expected != null && ids.length < expected && ok) ok = false;
    return { ids, expected, complete: ok };
}

// -----------------------------------------------------------------------------
// LST asset registry — resolve a lock's asset.info to a symbol + current ratio.
// Built from the lock contract's config (deposit_assets) crossed with the
// network-and-prices LST ratios loaded via the engine ctx.
// -----------------------------------------------------------------------------
function assetKey(info) {
    if (!info) return 'unknown';
    if (info.native) return `native:${info.native}`;
    if (info.cw20) return `cw20:${info.cw20}`;
    return JSON.stringify(info);
}

// Map a lock asset to {symbol, current_ratio} using ctx.lstRatios + a denom map.
function resolveAssetMeta(info, ctx, denomToSymbol) {
    const key = assetKey(info);
    const symbol = LOCK_ASSET_SYMBOLS[key] || denomToSymbol[key] || (info?.native === 'uluna' ? 'LUNA' : key);
    // LUNA is the base (ratio 1). LSTs carry a ratio from network-and-prices.
    let ratio = 1;
    if (symbol !== 'LUNA') {
        const r = ctx.lstRatios?.[symbol]?.ratio ?? ctx.lstRatios?.[symbol];
        if (typeof r === 'number') ratio = r;
        else if (r && typeof r.ratio === 'number') ratio = r.ratio;
    }
    return { symbol, current_ratio: ratio };
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
async function run() {
    const startedAt = new Date();
    const epochInfo = currentEpochInfo();
    const currentPeriod = epochInfo.number;
    console.log(`\n🔒 tla-locks — epoch ${currentPeriod} — ${startedAt.toISOString()}\n`);

    // Phase 1: shared ctx (prices + LST ratios) and the lock contract config (oracles + denom map)
    console.log('📂 Loading shared data + lock config...');
    const ctx = await loadSharedData();
    const config = await queryContract(TLA_VOTING_ESCROW, { config: {} });
    const denomToSymbol = {};
    // Build a denom→symbol map from the network-and-prices token list where possible.
    // deposit_assets gives us the lockable set; we label LUNA natively and leave
    // others to the LST-ratio symbol lookup (ampLUNA/bLUNA/arbLUNA already keyed there).
    if (config && Array.isArray(config.deposit_assets)) {
        for (const da of config.deposit_assets) {
            const k = assetKey(da.info);
            if (da.info?.native === 'uluna') denomToSymbol[k] = 'LUNA';
            // cw20 LSTs: try to match against ctx token prices by contract
            if (da.info?.cw20 && ctx.tokenPrices) {
                for (const [sym, p] of Object.entries(ctx.tokenPrices)) {
                    if (p && (p.address === da.info.cw20 || p.contract === da.info.cw20)) { denomToSymbol[k] = sym; break; }
                }
            }
        }
    }

    // Phase 2: system totals — ONE call
    console.log('📊 System totals (total_vamp)...');
    const totalVamp = await queryContract(TLA_VOTING_ESCROW, { total_vamp: {} });
    const sysFixed = totalVamp ? Number(totalVamp.fixed || 0) / 1e6 : null;
    const sysDecaying = totalVamp ? Number(totalVamp.voting_power || 0) / 1e6 : null;
    const sysVp = totalVamp ? Number(totalVamp.vp || 0) / 1e6 : null;
    console.log(`  fixed ${sysFixed?.toLocaleString()} | decaying ${sysDecaying?.toLocaleString()} | total ${sysVp?.toLocaleString()}`);

    // Phase 2b: forward decay projection — system VP at +4, +8, +13, +26, +52 weeks
    const projWeeks = [4, 8, 13, 26, 52];
    const projection = [];
    for (const w of projWeeks) {
        const tv = await queryContract(TLA_VOTING_ESCROW, { total_vamp: { time: { period: currentPeriod + w } } });
        projection.push({
            weeks_ahead: w,
            at_period: currentPeriod + w,
            approx_date: epochToDate(currentPeriod + w),
            vp: tv ? Number(tv.vp || 0) / 1e6 : null,
        });
    }

    // Phase 3: enumerate + fetch every lock
    console.log('🔢 Enumerating locks...');
    const { ids, expected, complete: enumComplete } = await enumerateLockTokens();
    console.log(`  ${ids.length} lock token_ids (expected ${expected})`);

    let lockErrors = 0;
    const locks = await parallelMap(ids, async (tokenId) => {
        const info = await queryContract(TLA_VOTING_ESCROW, { lock_info: { token_id: tokenId, time: 'next' } });
        if (!info) { lockErrors++; return null; }
        const meta = resolveAssetMeta(info.asset?.info, ctx, denomToSymbol);
        const amount = Number(info.asset?.amount || 0) / 1e6;
        const underlyingFrozen = Number(info.underlying_amount || 0) / 1e6;
        const coefficient = Number(info.coefficient || 0);
        const vp = Number(info.voting_power || 0) / 1e6;
        const slope = Number(info.slope || 0);
        const isPermanent = info.end === 'permanent';
        const isAutoMax = isPermanent || slope === 0;
        const endPeriod = (info.end && typeof info.end === 'object') ? (info.end.period ?? null) : null;
        const weeksToUnlock = (endPeriod != null && info.from_period != null) ? Math.max(0, endPeriod - info.from_period) : null;

        // Stale-VP gap: underlying re-stamped at today's ratio vs frozen underlying.
        const underlyingNow = amount * meta.current_ratio;
        const underlyingGain = underlyingNow - underlyingFrozen;       // extra underlying not yet credited
        const vpIfRestamped = underlyingNow * coefficient;
        const staleVpGap = Math.max(0, vpIfRestamped - vp);

        return {
            token_id: tokenId,
            owner: info.owner,
            asset_symbol: meta.symbol,
            current_ratio: meta.current_ratio,
            amount_human: amount,
            underlying_frozen_human: underlyingFrozen,
            underlying_now_human: underlyingNow,
            underlying_gain_human: underlyingGain,
            coefficient,
            voting_power_human: vp,
            vp_if_restamped_human: vpIfRestamped,
            stale_vp_gap_human: staleVpGap,
            slope,
            start_period: info.start,
            from_period: info.from_period,
            end_period: endPeriod,
            is_auto_max_locked: isAutoMax,
            weeks_to_unlock: weeksToUnlock,
            unlock_date: endPeriod != null ? epochToDate(endPeriod) : null,
        };
    }, BATCH_CONCURRENCY);
    const validLocks = locks.filter(Boolean);
    console.log(`  ✓ ${validLocks.length}/${ids.length} locks captured (${lockErrors} errors)`);

    // Phase 4: derive system intelligence
    // Per-asset VP totals
    const byAsset = {};
    for (const l of validLocks) {
        const a = byAsset[l.asset_symbol] || { asset: l.asset_symbol, vp: 0, locks: 0, amount: 0, stale_vp_gap: 0, underlying_now: 0 };
        a.vp += l.voting_power_human;
        a.locks += 1;
        a.amount += l.amount_human;
        a.underlying_now += l.underlying_now_human;
        a.stale_vp_gap += l.stale_vp_gap_human;
        byAsset[l.asset_symbol] = a;
    }

    // Auto-max vs decaying split
    const autoMax = validLocks.filter(l => l.is_auto_max_locked);
    const decaying = validLocks.filter(l => !l.is_auto_max_locked);
    const autoMaxVp = autoMax.reduce((s, l) => s + l.voting_power_human, 0);
    const decayingVp = decaying.reduce((s, l) => s + l.voting_power_human, 0);

    // System-wide stale-VP gap (the headline "unclaimed VP" number)
    const systemStaleVpGap = validLocks.reduce((s, l) => s + l.stale_vp_gap_human, 0);

    // Unlock-cliff histogram: VP-weighted unlocks by week bucket (decaying locks only)
    const cliffBuckets = [
        { label: '0-4w', max: 4 }, { label: '4-8w', max: 8 }, { label: '8-13w', max: 13 },
        { label: '13-26w', max: 26 }, { label: '26-52w', max: 52 }, { label: '52w+', max: Infinity },
    ];
    const cliff = cliffBuckets.map(b => ({ bucket: b.label, vp: 0, lock_count: 0 }));
    for (const l of decaying) {
        if (l.weeks_to_unlock == null) continue;
        const idx = cliffBuckets.findIndex(b => l.weeks_to_unlock <= b.max);
        if (idx >= 0) { cliff[idx].vp += l.voting_power_human; cliff[idx].lock_count += 1; }
    }
    const totalDecayingForPct = decayingVp || 1;
    for (const c of cliff) c.pct_of_decaying_vp = (c.vp / totalDecayingForPct) * 100;

    // Phase 5: per-holder rollups (with PFPK names)
    const holders = {};
    for (const l of validLocks) {
        const h = holders[l.owner] || { address: l.owner, lock_count: 0, total_vp: 0, total_stale_vp_gap: 0, total_underlying_now: 0, auto_max_locks: 0, decaying_locks: 0, soonest_unlock_weeks: null };
        h.lock_count += 1;
        h.total_vp += l.voting_power_human;
        h.total_stale_vp_gap += l.stale_vp_gap_human;
        h.total_underlying_now += l.underlying_now_human;
        if (l.is_auto_max_locked) h.auto_max_locks += 1; else h.decaying_locks += 1;
        if (l.weeks_to_unlock != null) h.soonest_unlock_weeks = h.soonest_unlock_weeks == null ? l.weeks_to_unlock : Math.min(h.soonest_unlock_weeks, l.weeks_to_unlock);
        holders[l.owner] = h;
    }
    const holderList = Object.values(holders).sort((a, b) => b.total_vp - a.total_vp);

    // PFPK names for holders
    let named = 0;
    await parallelMap(holderList, async (h) => {
        try {
            const data = await fetchJson(PFPK_BASE_URL + bech32AddressToHex(h.address), 'pfpk', PFPK_TIMEOUT_MS);
            if (data && data.name) { h.name = data.name; named++; } else h.name = null;
        } catch { h.name = null; }
    }, BATCH_CONCURRENCY);
    console.log(`  ✓ ${holderList.length} unique holders (${named} named)`);

    // Phase 6: assemble
    const lockComplete = enumComplete && lockErrors === 0;
    const status = validLocks.length === 0 ? 'error' : (lockComplete ? 'ok' : 'partial');

    const systemSummary = {
        captured_at: startedAt.toISOString(),
        epoch: currentPeriod,
        total_locks: validLocks.length,
        unique_holders: holderList.length,
        system_vp: { total: sysVp, fixed: sysFixed, decaying: sysDecaying },
        system_vp_sum_from_locks: validLocks.reduce((s, l) => s + l.voting_power_human, 0),
        system_stale_vp_gap: systemStaleVpGap,
        auto_max: { lock_count: autoMax.length, vp: autoMaxVp },
        decaying: { lock_count: decaying.length, vp: decayingVp },
        by_asset: Object.values(byAsset),
        unlock_cliff: cliff,
        decay_projection: projection,
    };

    const fullDoc = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        epoch: epochInfo,
        retention: 'live_only',
        luna_price_used_usd: ctx.lunaPriceUsd,
        enumeration: { token_count: ids.length, expected, complete: lockComplete, lock_errors: lockErrors },
        system: systemSummary,
        holders: holderList,
        locks: validLocks,
    };

    const heartbeat = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        runId: `tla-locks-${startedAt.toISOString().replace(/[-:T.Z]/g,'').slice(0,14)}`,
        status,
        next_expected_run_at: new Date(startedAt.getTime() + 25 * 60 * 60 * 1000).toISOString(),
        stats: {
            total_locks: validLocks.length,
            unique_holders: holderList.length,
            lock_errors: lockErrors,
            enumeration_complete: lockComplete,
            system_vp: sysVp,
            system_stale_vp_gap: systemStaleVpGap,
        },
    };

    // Phase 7: publish
    const fullContent = JSON.stringify(fullDoc, null, 2);
    const summaryContent = JSON.stringify({ schemaVersion: 1, ...systemSummary }, null, 2);
    const hbContent = JSON.stringify(heartbeat, null, 2);
    const dateStr = startedAt.toISOString().slice(0, 10);

    if (!GITHUB_TOKEN) {
        console.log('⚠️  GITHUB_TOKEN not set — saving locally');
        fs.writeFileSync('current.json', fullContent);
        fs.writeFileSync('summary.json', summaryContent);
        fs.writeFileSync('heartbeat.json', hbContent);
    } else {
        await publishFile('data/current.json', fullContent, `locks epoch ${currentPeriod} (${validLocks.length})`);
        console.log('  ✓ data/current.json');
        await publishFile('data/summary.json', summaryContent, `locks summary epoch ${currentPeriod}`);
        console.log('  ✓ data/summary.json');
        await publishFile(`data/daily/${dateStr}.json`, summaryContent, `📸 locks summary — ${dateStr}`);
        console.log(`  ✓ data/daily/${dateStr}.json`);
        await publishFile('data/heartbeat.json', hbContent, `heartbeat ${status} epoch ${currentPeriod}`);
        console.log('  ✓ data/heartbeat.json');
    }

    console.log(`\n✅ tla-locks — status ${status}`);
    console.log(`   ${validLocks.length} locks, ${holderList.length} holders, system VP ${sysVp?.toLocaleString()}`);
    console.log(`   stale-VP gap (unclaimed): ${systemStaleVpGap.toLocaleString(undefined,{maximumFractionDigits:0})}`);
    console.log(`   auto-max ${autoMax.length} / decaying ${decaying.length} locks\n`);
    if (status === 'error') process.exit(2);
}

// -----------------------------------------------------------------------------
// GitHub publish
// -----------------------------------------------------------------------------
function githubApiRequest(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'api.github.com', path: apiPath, method,
            headers: {
                'User-Agent': 'tla-locks-cron/1.0',
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

if (require.main === module) {
    run().catch(err => { console.error('FATAL:', err); process.exit(1); });
}
