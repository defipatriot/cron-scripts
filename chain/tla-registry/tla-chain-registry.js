// =============================================================================
// tla-chain-registry  —  Layer 0 of the TLA chain-native data pipeline
// =============================================================================
//
// PURPOSE
//   Reads the canonical contract directory + pool registry directly from the
//   Eris ve3 contracts on Terra (phoenix-1). Every other layer in the new
//   pipeline (pricing, entities, participants, rollups) bootstraps from what
//   THIS cron writes — eliminating hardcoded contract addresses scattered
//   across the previous cron generation, and self-discovering pools as Eris
//   whitelists/delists them.
//
// WHAT IT CAPTURES (per CRON-FIXES-BRIEF Part 5.1 + 2.11–2.16)
//   1. global-config.all_addresses        → master contract directory
//   2. asset-gauge.distributions          → canonical pool registry
//                                            (gauge_pool_id, bucket, share %)
//   3. asset-gauge.last_distribution_period → canonical current epoch (settles
//                                              off-by-one issues at the source)
//   4. asset-gauge.config                 → gauge list + global_config + rebase
//   5. voting-escrow.num_tokens           → sanity ping (~431 currently)
//
// OUTPUT
//   defipatriot/tla-chain-registry/2026/current.json    ← latest snapshot
//   defipatriot/tla-chain-registry/2026/heartbeat.json  ← freshness signal
//   defipatriot/tla-chain-registry/2026/daily/YYYY-MM-DD.json ← daily archive
//
//   Each file carries:
//     • schemaVersion + capturedAt + capturedAtUnix
//     • raw.* keys preserving unmodified query responses (Part 5.0 principle:
//                                                       capture RAW, never lose source)
//     • derived convenience fields (parsed contract directory, pool list keyed
//       by gauge_pool_id|bucket) for dashboard ease
//     • _errors[] array — failed queries recorded distinctly from empty results
//
// CADENCE
//   Daily at 00:05 UTC (after epoch boundary settles). ~5 chain reads per run.
//
// DEPENDENCIES
//   None except chain LCD endpoints (publicnode primary + fallback).
//   Self-discovers everything — no hardcoded contract addresses past the
//   global-config bootstrap address.
//
// FAILURE MODES
//   • Both LCDs down → script exits non-zero, no GitHub write (Render shows
//     failure in dashboard, dashboard's last-good snapshot stays in place).
//   • global-config.all_addresses returns null → cannot proceed, exit 1.
//   • Individual downstream queries (gauge/escrow) fail → recorded in
//     _errors[] but snapshot still publishes with whatever DID succeed.
//
// =============================================================================

const https = require('https');
const crypto = require('crypto');

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------

const TERRA_LCD_PRIMARY  = process.env.TERRA_LCD_PRIMARY  || 'https://terra-lcd.publicnode.com';
const TERRA_LCD_FALLBACK = process.env.TERRA_LCD_FALLBACK || 'https://terra-rest.publicnode.com';

// The ONLY hardcoded contract address. Everything else is discovered from this.
const GLOBAL_CONFIG_ADDR = process.env.GLOBAL_CONFIG_ADDR
    || 'terra1hwxg6s732eparz3ys7sa4t5f64ngpd2w8syrca6z7ckv3fs9uqnsvrpcqa';

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/tla-chain-registry';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

const HTTP_TIMEOUT_MS = 20000;
const MAX_RUNTIME_MS  = 5 * 60 * 1000;  // 5min ceiling per Part 5.3

const SCHEMA_VERSION = 1;
const CRON_NAME      = 'tla-chain-registry';

// -----------------------------------------------------------------------------
// HTTP HELPERS  (vendored from adao-positions for behavior parity)
// -----------------------------------------------------------------------------

async function fetchJson(url, label, timeoutMs = HTTP_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json', 'User-Agent': 'tla-chain-registry/1.0' },
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

function encodeQuery(q) {
    return Buffer.from(JSON.stringify(q)).toString('base64');
}

// Query a CosmWasm contract via LCD. Returns the unwrapped `.data` field on
// success, or null on both-LCDs failure. Retries primary twice with brief
// jittered backoff before falling back. NEVER coerces null to {} or [] — a
// null return distinctly signals "fetch failed" vs an empty-but-successful
// query (Part 3.2 — distinguish failed from empty).
async function queryContract(contractAddr, query, label) {
    const qb = encodeQuery(query);
    const path = `/cosmwasm/wasm/v1/contract/${contractAddr}/smart/${qb}`;
    const qLabel = label || `${contractAddr.slice(0,12)} ${JSON.stringify(query).slice(0,40)}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const r = await fetchJson(TERRA_LCD_PRIMARY + path, `${qLabel} (primary try ${attempt})`);
            return r.data;
        } catch (e) {
            if (attempt < 2) {
                await new Promise(res => setTimeout(res, 200 + Math.random() * 300));
            } else {
                console.warn(`  ⚠ primary failed: ${e.message}`);
            }
        }
    }

    try {
        const r = await fetchJson(TERRA_LCD_FALLBACK + path, `${qLabel} (fallback)`);
        return r.data;
    } catch (e) {
        console.warn(`  ⚠ fallback failed: ${e.message}`);
        return null;
    }
}

// -----------------------------------------------------------------------------
// GITHUB PUSH (same shape as the other crons)
// -----------------------------------------------------------------------------

function githubApiRequest(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.github.com',
            path: apiPath,
            method,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent': 'tla-chain-registry/1.0',
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
            },
        }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(d || '{}') }); }
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
    console.error(`  ❌ ${filepath} push failed (HTTP ${result.status}): ${result.data?.message || '<no message>'}`);
    return false;
}

async function fetchJsonRaw(url) {
    try { return await fetchJson(url, `raw ${url.slice(-40)}`); }
    catch (e) { return null; }
}

// -----------------------------------------------------------------------------
// CAPTURE — the actual chain queries
// -----------------------------------------------------------------------------

async function captureChainRegistry() {
    const startedAt = new Date();
    const errors = [];

    console.log(`\n🔗 TLA Chain Registry — Layer 0`);
    console.log(`   Started: ${startedAt.toISOString()}`);
    console.log(`   Bootstrap from global-config: ${GLOBAL_CONFIG_ADDR}\n`);

    // -------------------------------------------------------------------------
    // QUERY 1 — global-config.all_addresses (THE bootstrap query)
    // -------------------------------------------------------------------------
    console.log('📋 Q1: global-config.all_addresses');
    const allAddressesRaw = await queryContract(
        GLOBAL_CONFIG_ADDR,
        { all_addresses: {} },
        'global-config.all_addresses',
    );
    if (!allAddressesRaw) {
        // This is the bootstrap query — without it we have nothing.
        // Surface the failure clearly and exit non-zero so Render shows red.
        throw new Error('global-config.all_addresses returned null — both LCDs failed. Aborting; old snapshot stays in place.');
    }
    console.log(`   ✓ received (${(JSON.stringify(allAddressesRaw).length / 1024).toFixed(1)} KB)`);

    // Parse the directory into a role → address map. The contract returns this
    // as an array of [role, address] pairs (CosmWasm convention for ordered
    // maps). We preserve the raw response under `raw.all_addresses` AND build
    // a derived `directory` object for ease of consumption downstream.
    const directory = {};
    if (Array.isArray(allAddressesRaw)) {
        for (const item of allAddressesRaw) {
            if (Array.isArray(item) && item.length >= 2) {
                directory[item[0]] = item[1];
            } else if (item && typeof item === 'object' && item.role) {
                directory[item.role] = item.address;
            }
        }
    } else if (allAddressesRaw && typeof allAddressesRaw === 'object') {
        Object.assign(directory, allAddressesRaw);
    }
    console.log(`   parsed ${Object.keys(directory).length} role→address entries`);

    // Find the asset-gauge address (named ASSET_GAUGE per Part 2.14).
    const assetGaugeAddr = directory.ASSET_GAUGE || directory.asset_gauge || directory['asset-gauge'];
    if (!assetGaugeAddr) {
        errors.push({ query: 'derive ASSET_GAUGE', error: 'no ASSET_GAUGE key in all_addresses' });
        console.warn('   ⚠ ASSET_GAUGE not found in directory — gauge queries will be skipped');
    } else {
        console.log(`   ASSET_GAUGE: ${assetGaugeAddr.slice(0,30)}...`);
    }
    const votingEscrowAddr = directory.VOTING_ESCROW || directory.voting_escrow || directory['voting-escrow'];

    // -------------------------------------------------------------------------
    // QUERY 2 — asset-gauge.distributions (canonical pool registry)
    // -------------------------------------------------------------------------
    let distributionsRaw = null;
    if (assetGaugeAddr) {
        console.log('\n📊 Q2: asset-gauge.distributions');
        distributionsRaw = await queryContract(
            assetGaugeAddr,
            { distributions: {} },
            'asset-gauge.distributions',
        );
        if (!distributionsRaw) {
            errors.push({ query: 'asset-gauge.distributions', error: 'returned null' });
            console.warn('   ⚠ returned null — pool registry will be empty');
        } else {
            console.log(`   ✓ received (${(JSON.stringify(distributionsRaw).length / 1024).toFixed(1)} KB)`);
        }
    }

    // Parse pools out of the distributions structure. Per Part 2.12, the shape
    // is: per-gauge (bucket): { total_gauge_vp, distributions: [{asset, distribution, total_vp}] }
    // We flatten into `pools[]` keyed by gauge_pool_id|bucket (Part 1.1).
    const pools = [];
    const buckets = {};  // bucket → { total_gauge_vp, pool_count }
    if (distributionsRaw && Array.isArray(distributionsRaw)) {
        for (const gaugeEntry of distributionsRaw) {
            // Shape variations: each entry could be {gauge, total_gauge_vp, distribution: [...]}
            // or a tuple [gauge, {...}]. Handle both defensively.
            let gaugeName, gaugeData;
            if (Array.isArray(gaugeEntry) && gaugeEntry.length >= 2) {
                gaugeName = gaugeEntry[0];
                gaugeData = gaugeEntry[1];
            } else if (gaugeEntry && typeof gaugeEntry === 'object') {
                gaugeName = gaugeEntry.gauge || gaugeEntry.bucket || gaugeEntry.name;
                gaugeData = gaugeEntry;
            }
            if (!gaugeName || !gaugeData) continue;

            const totalGaugeVp = gaugeData.total_gauge_vp || gaugeData.total_vp || null;
            const dists = gaugeData.distribution || gaugeData.distributions || [];
            buckets[gaugeName] = { total_gauge_vp: totalGaugeVp, pool_count: 0 };

            for (const d of (Array.isArray(dists) ? dists : [])) {
                // Per-pool entry: {asset, distribution, total_vp}
                // asset is one of {cw20:"terra1..."} | {native:"factory/..."}
                const asset = d.asset || d[0];
                const distribution = d.distribution ?? d[1] ?? null;
                const total_vp = d.total_vp ?? d[2] ?? null;
                if (!asset) continue;

                // gauge_pool_id is the canonical key (Part 1.1). Stringify the
                // asset enum: "cw20:terra1..." or "native:factory/..."
                const gaugePoolId = asset.cw20
                    ? `cw20:${asset.cw20}`
                    : asset.native
                        ? `native:${asset.native}`
                        : `unknown:${JSON.stringify(asset)}`;

                pools.push({
                    gauge_pool_id: gaugePoolId,
                    bucket: gaugeName,
                    asset_raw: asset,            // preserved exact source shape
                    distribution_pct: distribution != null ? Number(distribution) : null,
                    total_vp: total_vp != null ? String(total_vp) : null,
                });
                buckets[gaugeName].pool_count++;
            }
        }
        console.log(`   parsed ${pools.length} pools across ${Object.keys(buckets).length} buckets`);
        for (const [bn, b] of Object.entries(buckets)) {
            console.log(`     ${bn.padEnd(10)}: ${b.pool_count} pools, total_gauge_vp ${b.total_gauge_vp}`);
        }
    }

    // -------------------------------------------------------------------------
    // QUERY 3 — asset-gauge.last_distribution_period (canonical epoch)
    // -------------------------------------------------------------------------
    let lastDistributionPeriodRaw = null;
    let canonicalEpoch = null;
    if (assetGaugeAddr) {
        console.log('\n📅 Q3: asset-gauge.last_distribution_period');
        lastDistributionPeriodRaw = await queryContract(
            assetGaugeAddr,
            { last_distribution_period: {} },
            'asset-gauge.last_distribution_period',
        );
        if (lastDistributionPeriodRaw == null) {
            errors.push({ query: 'asset-gauge.last_distribution_period', error: 'returned null' });
            console.warn('   ⚠ returned null');
        } else {
            // Response could be a bare number or {period: N}
            canonicalEpoch = typeof lastDistributionPeriodRaw === 'number'
                ? lastDistributionPeriodRaw
                : (lastDistributionPeriodRaw.period ?? lastDistributionPeriodRaw);
            console.log(`   ✓ canonical epoch = ${canonicalEpoch}`);
        }
    }

    // -------------------------------------------------------------------------
    // QUERY 4 — asset-gauge.config (gauge list + global_config + rebase asset)
    // -------------------------------------------------------------------------
    let gaugeConfigRaw = null;
    if (assetGaugeAddr) {
        console.log('\n⚙️  Q4: asset-gauge.config');
        gaugeConfigRaw = await queryContract(
            assetGaugeAddr,
            { config: {} },
            'asset-gauge.config',
        );
        if (!gaugeConfigRaw) {
            errors.push({ query: 'asset-gauge.config', error: 'returned null' });
            console.warn('   ⚠ returned null');
        } else {
            console.log(`   ✓ gauges: ${(gaugeConfigRaw.gauges || []).length}, rebase_asset: ${JSON.stringify(gaugeConfigRaw.rebase_asset)?.slice(0,50)}`);
        }
    }

    // -------------------------------------------------------------------------
    // QUERY 5 — voting-escrow.num_tokens (sanity ping)
    // -------------------------------------------------------------------------
    let numTokensRaw = null;
    if (votingEscrowAddr) {
        console.log('\n🔒 Q5: voting-escrow.num_tokens');
        numTokensRaw = await queryContract(
            votingEscrowAddr,
            { num_tokens: {} },
            'voting-escrow.num_tokens',
        );
        if (numTokensRaw == null) {
            errors.push({ query: 'voting-escrow.num_tokens', error: 'returned null' });
            console.warn('   ⚠ returned null');
        } else {
            const n = typeof numTokensRaw === 'number' ? numTokensRaw : (numTokensRaw.count ?? numTokensRaw);
            console.log(`   ✓ ${n} veLUNA locks total`);
        }
    }

    // -------------------------------------------------------------------------
    // ASSEMBLE THE SNAPSHOT (raw + derived; never lose source)
    // -------------------------------------------------------------------------
    const snapshot = {
        schemaVersion: SCHEMA_VERSION,
        cron: CRON_NAME,
        layer: 0,
        layerRole: 'discovery-bootstrap',
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        canonicalEpoch,

        // RAW: every query response, unmodified. Future features re-derive
        // from these without re-querying the chain.
        raw: {
            global_config_all_addresses: allAddressesRaw,
            asset_gauge_distributions:   distributionsRaw,
            asset_gauge_last_distribution_period: lastDistributionPeriodRaw,
            asset_gauge_config:          gaugeConfigRaw,
            voting_escrow_num_tokens:    numTokensRaw,
        },

        // DERIVED: parsed, indexed, dashboard-friendly views of the same data.
        directory,
        pools,
        buckets,

        // Discovery metadata so downstream consumers can short-circuit on staleness.
        contracts: {
            global_config:   GLOBAL_CONFIG_ADDR,
            asset_gauge:     assetGaugeAddr || null,
            voting_escrow:   votingEscrowAddr || null,
        },

        // Errors: failed queries explicitly recorded. Distinct from "no data
        // existed" — see Part 3.2.
        _errors: errors,

        // Source attribution
        sources: {
            primary_lcd:  TERRA_LCD_PRIMARY,
            fallback_lcd: TERRA_LCD_FALLBACK,
        },
    };

    return { snapshot, startedAt, errors };
}

// -----------------------------------------------------------------------------
// FINGERPRINT — for heartbeat freshness signal (matches other crons' pattern)
// -----------------------------------------------------------------------------

function computeDataFingerprint(snapshot) {
    // Hash over the substantive fields that should change when the registry
    // legitimately moves (new pool added, distribution % shifted, epoch
    // advanced). Excludes capturedAt (would mask freezes around boundaries).
    const items = (snapshot.pools || [])
        .map(p => [p.gauge_pool_id, p.bucket, p.distribution_pct])
        .sort((a, b) => a[0].localeCompare(b[0]));
    const input = JSON.stringify({
        epoch: snapshot.canonicalEpoch,
        directory_size: Object.keys(snapshot.directory || {}).length,
        pools: items,
    });
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

async function fetchPreviousHeartbeat() {
    const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/2026/heartbeat.json`;
    return await fetchJsonRaw(url);
}

function classifyFreshness(currentFp, prev) {
    if (!prev || !prev.dataFingerprint) {
        return { dataFreshness: 'fresh', consecutiveStuckRuns: 0, previousFingerprint: null };
    }
    const previousFingerprint = prev.dataFingerprint;
    if (currentFp !== previousFingerprint) {
        return { dataFreshness: 'fresh', consecutiveStuckRuns: 0, previousFingerprint };
    }
    // For Layer 0, the registry can legitimately not change for days — pool
    // shape moves on epoch boundaries (weekly), not daily. So suspicious/stuck
    // thresholds are wider than other crons. After ~10 identical daily runs
    // (1.5 weeks of no registry movement) we flag suspicious; ~20 = stuck.
    const consecutive = (Number(prev.consecutiveStuckRuns) || 1) + 1;
    let dataFreshness = 'fresh';
    if (consecutive >= 20) dataFreshness = 'stuck';
    else if (consecutive >= 10) dataFreshness = 'suspicious';
    return { dataFreshness, consecutiveStuckRuns: consecutive, previousFingerprint };
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------

async function main() {
    const runStartedAt = Date.now();
    const runDeadline = runStartedAt + MAX_RUNTIME_MS;

    // Watchdog — Part 5.3 ceiling. If something goes catastrophically wrong
    // and we run past MAX_RUNTIME_MS, kill the process so Render doesn't have
    // a zombie run holding resources.
    const watchdog = setTimeout(() => {
        console.error(`\n❌ Watchdog: exceeded ${MAX_RUNTIME_MS / 1000}s runtime ceiling, aborting`);
        process.exit(2);
    }, MAX_RUNTIME_MS);
    watchdog.unref();

    const { snapshot, startedAt, errors } = await captureChainRegistry();

    const dateStr = startedAt.toISOString().slice(0, 10);  // YYYY-MM-DD
    const year    = dateStr.slice(0, 4);
    const baseDir = `${year}`;

    // Heartbeat + freshness fingerprint
    const dataFingerprint = computeDataFingerprint(snapshot);
    const prevHeartbeat = await fetchPreviousHeartbeat();
    const freshness = classifyFreshness(dataFingerprint, prevHeartbeat);

    const freshnessIcon = { fresh: '✓', suspicious: '⚠', stuck: '🔴' }[freshness.dataFreshness];
    console.log(`\n🔍 Freshness: ${freshnessIcon} ${freshness.dataFreshness} (fingerprint ${dataFingerprint}, prev ${freshness.previousFingerprint || '(none)'})`);
    if (freshness.consecutiveStuckRuns > 1) {
        console.log(`   ${freshness.consecutiveStuckRuns} consecutive identical runs`);
    }

    // Status: stuck > partial > ok. Partial = some errors but bootstrap succeeded.
    let status = 'ok';
    if (freshness.dataFreshness === 'stuck') status = 'stuck';
    else if (errors.length > 0) status = 'partial';

    const heartbeat = {
        schemaVersion: SCHEMA_VERSION,
        cron: CRON_NAME,
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        runId: `chain-registry-${startedAt.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
        runMode: 'daily',
        status,
        canonicalEpoch: snapshot.canonicalEpoch,
        stats: {
            directory_size: Object.keys(snapshot.directory || {}).length,
            pool_count:     (snapshot.pools || []).length,
            bucket_count:   Object.keys(snapshot.buckets || {}).length,
            num_locks:      typeof snapshot.raw.voting_escrow_num_tokens === 'number'
                ? snapshot.raw.voting_escrow_num_tokens
                : snapshot.raw.voting_escrow_num_tokens?.count ?? null,
            errors_count:   errors.length,
        },
        dataFingerprint,
        previousFingerprint:  freshness.previousFingerprint,
        dataFreshness:        freshness.dataFreshness,
        consecutiveStuckRuns: freshness.consecutiveStuckRuns,
        next_expected_run_at: new Date(startedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    };

    // -------------------------------------------------------------------------
    // PUBLISH
    // -------------------------------------------------------------------------
    if (!GITHUB_TOKEN) {
        console.log('\n⚠️  GITHUB_TOKEN not set — printing to stdout instead of pushing.\n');
        console.log('--- HEARTBEAT ---');
        console.log(JSON.stringify(heartbeat, null, 2));
        console.log('\n--- SNAPSHOT (current.json preview) ---');
        const preview = { ...snapshot, raw: '(omitted in stdout preview)' };
        console.log(JSON.stringify(preview, null, 2).slice(0, 2000) + '\n...');
        clearTimeout(watchdog);
        return;
    }

    console.log('\n📤 Publishing to GitHub...');
    const snapshotJson  = JSON.stringify(snapshot,  null, 2);
    const heartbeatJson = JSON.stringify(heartbeat, null, 2);
    const epochLabel    = snapshot.canonicalEpoch != null ? ` (epoch ${snapshot.canonicalEpoch})` : '';

    await pushToGithub(
        `${baseDir}/current.json`,
        snapshotJson,
        `🔗 Layer 0 registry capture${epochLabel}`,
    );
    await pushToGithub(
        `${baseDir}/daily/${dateStr}.json`,
        snapshotJson,
        `🔗 Layer 0 daily archive ${dateStr}${epochLabel}`,
    );
    await pushToGithub(
        `${baseDir}/heartbeat.json`,
        heartbeatJson,
        `📍 Layer 0 heartbeat (${freshness.dataFreshness}${epochLabel})`,
    );

    const elapsed = ((Date.now() - runStartedAt) / 1000).toFixed(1);
    console.log(`\n✅ Done in ${elapsed}s — status=${status}, errors=${errors.length}, pools=${(snapshot.pools || []).length}\n`);
    clearTimeout(watchdog);
}

if (require.main === module) {
    main().catch(err => {
        console.error('\n❌ FATAL:', err.message || err);
        if (err.stack) console.error(err.stack);
        process.exit(1);
    });
}

module.exports = {
    captureChainRegistry,
    computeDataFingerprint,
    classifyFreshness,
};
