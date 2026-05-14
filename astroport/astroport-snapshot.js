// =============================================================================
// Astroport Snapshot Cron (v2 — pools.getAll as primary discovery source)
// =============================================================================
//
// Captures Astroport pool data for the Terra Alliance DAO (TLA). Originally
// (v1) the cron discovered pools by querying the TLA gauge controller and
// resolving each cw20/native LP token to a pool address. That approach had
// two problems:
//   1. Required resolving IBC denoms (USDC, USDT, EURe, ATOM, INJ, PAXG, wBTC
//      variants), which depend on chainsco's indexer. Without it, ~38 of 68
//      gauge entries dropped out → cron only captured 6 of 20 active pools.
//   2. Missed "inactive" pools — pools the DAO has voted on in the past but
//      currently has near-zero VP for. These don't appear in gauge_infos:next
//      and were invisible to the v1 cron entirely.
//
// v2 inverts the discovery: use Astroport's `pools.getAll` as the source of
// truth for which pools exist. That endpoint returns ALL 275+ phoenix-1 pools
// with pre-computed name/TVL/volume/flags already attached. Then we cross-
// reference each pool against the TLA gauge controller's `distributions`
// query to attach a gauge bucket label if the pool has any vote-power
// distribution. Pools without a distribution are skipped — they're real
// Astroport pools but not TLA-relevant.
//
// Benefits of the new approach:
//   - 100% coverage of TLA-relevant Astroport pools (active + inactive)
//   - No IBC denom resolution needed (Astroport already has the names)
//   - Pool TVL and volume come pre-computed from Astroport's indexer
//     (the charts endpoints are still fetched for per-epoch breakdown)
//   - Single getAll call replaces 30+ contract queries → 10x faster
//
// Output: same as v1 — JSON per epoch + CSV summary, committed to
// `astroport-pool-data_2026`.
//
// Runtime: Node 18+ (uses built-in fetch). CommonJS, no dependencies.
// =============================================================================

const https = require('https');
const fs = require('fs');
const path = require('path');

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------

// Terra LCDs — primary + fallback. Used for the (small) gauge-controller
// distributions query, which is the only chain interaction the cron does.
const TERRA_LCD_PRIMARY  = 'https://terra-rest.publicnode.com';
const TERRA_LCD_FALLBACK = 'https://terra.publicnode.com';

// TLA gauge controller. Used as a fallback / cross-reference for pool addresses
// but no longer the primary discovery source (see TLA_STAKING_CONTRACTS).
const TLA_GAUGE_CONTROLLER = 'terra1hfksrhchkmsj4qdq33wkksrslnfles6y2l77fmmzeep0xmq24l2smsd3lj';

// TLA staking contracts — one per gauge bucket. Querying `total_staked_balances`
// on each returns the COMPLETE list of LP tokens ever registered with that
// gauge, including pools that currently have zero VP / zero distribution
// (what the Eris UI labels "Inactive"). This is the proper source of truth
// for "every pool TLA cares about" — discovered via HAR-trace of Eris's
// liquidity-hub frontend, which makes exactly these 4 queries to populate
// its pool list.
//
// Compare to the alternatives:
//   - gauge_infos:next   → 68 entries (only pools with VP going INTO the next epoch)
//   - distributions      → 28 entries (only pools currently receiving rewards)
//   - total_staked_balances → 73 entries (ALL pools, active + inactive)
const TLA_STAKING_CONTRACTS = {
    stable:   'terra1v399cx9drllm70wxfsgvfe694tdsd9x96p9ha36w7muffe4znlusqswspq',
    project:  'terra1awq6t7jfakg9wfjn40fk3wzwmd57mvrqtt3a39z9rmet7wdjj3ysgw3lpa',
    bluechip: 'terra14mmvqn0kthw6sre75vku263lafn5655mkjdejqjedjga4cw0qx2qlf4arv',
    single:   'terra1qdz5qgafx88kp5mf6m2tah8742g4u5g2cek0m3jrgssexexk7g4qw6e23k',
};

// TLA epoch math.
const TLA_EPOCH_START_MS = Date.parse('2022-10-31T00:00:00Z');
const TLA_EPOCH_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// Astroport TRPC base. Server-side (no CORS, no proxy needed).
const ASTROPORT_TRPC_BASE = 'https://app.astroport.fi/api/trpc';
const ASTROPORT_CHART_RANGE = 'D30';

// HTTP timing. Astroport's charts endpoint takes 3-5s per pool under load,
// and the getAll endpoint can take 5-10s for the full 350KB response.
const HTTP_TIMEOUT_MS = 20000;
const POOL_FETCH_STAGGER_MS = 200;

// Pools to also include even if not in the distributions list. Use for any
// pool the DAO has interest in but hasn't yet voted on (rare). Empty by default.
const ALWAYS_INCLUDE_POOLS = [];

// GitHub config from environment.
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/astroport-pool-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// Mode override for testing: `node astroport-snapshot.js weekly`.
const RUN_MODE_CLI = process.argv[2];

// -----------------------------------------------------------------------------
// HTTP HELPERS
// -----------------------------------------------------------------------------

async function fetchJson(url, label = url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json', 'User-Agent': 'aDAO-astroport-snapshot/2.0' },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${body.slice(0, 120)}`);
        }
        return await res.json();
    } catch (e) {
        if (e.name === 'AbortError') throw new Error(`Timeout after ${HTTP_TIMEOUT_MS}ms (${label})`);
        throw e;
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchJsonWithRetry(url, label = url, maxTries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
            return await fetchJson(url, label);
        } catch (e) {
            lastErr = e;
            const msg = e.message || '';
            // Terminal errors — don't retry these (saves ~10s per dead pool)
            if (msg.includes('Pool not found') || msg.includes('not found')) throw e;
            if (attempt < maxTries) {
                const delay = Math.pow(3, attempt - 1) * 1000;
                console.log(`  ⏳ ${label} attempt ${attempt} failed (${msg.slice(0, 60)}), retry in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}

// CosmWasm smart-query with LCD fallback.
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
// PHASE 1: DISCOVER POOLS FROM ASTROPORT pools.getAll
// -----------------------------------------------------------------------------

// Fetch the master pool list from Astroport. Returns an array of all phoenix-1
// pools with metadata (poolAddress, lpAddress, name, assets, poolType, TVL,
// volume, deprecation flags). Single call replaces dozens of contract queries.
async function fetchAllAstroportPools() {
    const input = encodeURIComponent(JSON.stringify({ json: { chainId: 'phoenix-1' } }));
    const url = `${ASTROPORT_TRPC_BASE}/pools.getAll?input=${input}`;
    const data = await fetchJsonWithRetry(url, 'pools.getAll');
    const pools = data?.result?.data?.json;
    if (!Array.isArray(pools)) {
        throw new Error(`pools.getAll returned malformed data: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return pools;
}

// Normalize Astroport's pool name to the LUNA-first canonical form the tool
// and downstream code expects. Astroport stores names alphabetically (e.g.
// "ATOM - LUNA" or "USDT - LUNA"), we want them with LUNA prefix on pairs
// that include LUNA.
function canonicalizePoolName(rawName) {
    if (!rawName) return '?';
    const parts = rawName.split(/\s*-\s*/).map(s => s.trim());
    if (parts.length !== 2) return rawName;

    // LUNA-first canonicalization. Special tokens: ampLUNA, bLUNA, arbLUNA,
    // stLUNA, LunaX — these are LST tokens, NOT plain LUNA. We swap only when
    // the literal "LUNA" appears in position 1.
    if (parts[1] === 'LUNA') return `LUNA-${parts[0]}`;
    return `${parts[0]}-${parts[1]}`;
}

// -----------------------------------------------------------------------------
// PHASE 2: ATTACH GAUGE BUCKET ASSIGNMENT FROM TLA CONTRACT
// -----------------------------------------------------------------------------

// Query each of the 4 staking contracts' `total_staked_balances` and build a
// poolAddress → bucket-name lookup. This is the discovery source for ALL TLA
// pools, active + inactive. The query reveals which gauge each pool belongs
// to (via the contract it's queried from) AND the full list of pools that
// have any registration with the gauge, regardless of current voting power.
//
// Each entry returned by total_staked_balances has shape:
//   { asset: { info: { cw20: <addr> } | { native: <denom> }, amount: ... },
//     shares: ..., total_shares: ..., config: { ... } }
//
// For cw20: cross-reference against Astroport's `lpAddress` field.
// For native: extract poolAddress from `factory/<addr>/uLP` path.
async function buildBucketMap(astroportPools) {
    // Build lpAddress → poolAddress lookup from Astroport data
    const lpToPool = new Map();
    for (const p of astroportPools) {
        if (p.lpAddress && p.poolAddress) {
            lpToPool.set(p.lpAddress, p.poolAddress);
        }
    }

    const bucketByPool = {};
    let resolvedCw20 = 0, resolvedNative = 0, unresolved = 0;

    // Query all 4 staking contracts in parallel — they're independent
    const results = await Promise.all(
        Object.entries(TLA_STAKING_CONTRACTS).map(async ([bucket, contractAddr]) => {
            try {
                const data = await queryContract(contractAddr, { total_staked_balances: {} });
                if (!Array.isArray(data)) {
                    console.log(`  ⚠ ${bucket}-staking: non-array response`);
                    return { bucket, entries: [] };
                }
                return { bucket, entries: data };
            } catch (e) {
                console.log(`  ⚠ ${bucket}-staking query failed: ${e.message.slice(0, 60)}`);
                return { bucket, entries: [] };
            }
        })
    );

    // Process each contract's entries → poolAddress lookup
    for (const { bucket, entries } of results) {
        for (const entry of entries) {
            const info = entry?.asset?.info;
            if (!info) continue;
            let poolAddr = null;
            if (info.cw20) {
                poolAddr = lpToPool.get(info.cw20);
                if (poolAddr) resolvedCw20++;
                else unresolved++;
            } else if (info.native) {
                const parts = info.native.split('/');
                if (parts[0] === 'factory' && parts.length >= 3 && parts[parts.length - 1] === 'uLP') {
                    poolAddr = parts[1];
                    resolvedNative++;
                }
                // Non-LP native denoms (single-sided tokens like xASTRO, ampCAPA)
                // are skipped — they don't have an Astroport pool to chart.
            }
            if (poolAddr && !bucketByPool[poolAddr]) {
                // First-write wins (a pool registered in multiple gauges keeps its first bucket)
                bucketByPool[poolAddr] = bucket;
            }
        }
    }

    console.log(`  ✓ Bucket map: ${resolvedCw20} via cw20→pool lookup, ${resolvedNative} via factory path${unresolved ? `, ${unresolved} cw20 entries with no Astroport pool` : ''}`);
    return bucketByPool;
}

// -----------------------------------------------------------------------------
// PHASE 3: FETCH CHART DATA PER POOL
// -----------------------------------------------------------------------------

async function fetchPoolChart(poolAddr, type) {
    const input = encodeURIComponent(JSON.stringify({
        json: {
            pools: [poolAddr],
            dateRange: ASTROPORT_CHART_RANGE,
            chainId: 'phoenix-1'
        }
    }));
    const url = `${ASTROPORT_TRPC_BASE}/charts.${type}?input=${input}`;
    const label = `charts.${type}`;

    const maxTries = 3;
    let lastErr;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
            const data = await fetchJson(url, label);
            if (data?.error) {
                const msg = data.error.message || JSON.stringify(data.error);
                const reason = msg.includes('not found') ? 'pool-not-found' : msg.slice(0, 80);
                return { series: [], ok: false, errorReason: reason };
            }
            const series = data?.result?.data?.json?.[0]?.series || [];
            if (!Array.isArray(series)) {
                return { series: [], ok: false, errorReason: 'malformed series' };
            }
            return { series, ok: true, errorReason: series.length === 0 ? 'empty-series' : null };
        } catch (e) {
            lastErr = e;
            const msg = e.message || String(e);
            if (msg.includes('Pool not found') || msg.includes('not found')) {
                return { series: [], ok: false, errorReason: 'pool-not-found' };
            }
            if (attempt < maxTries) {
                const delay = Math.pow(3, attempt - 1) * 1000;
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    return { series: [], ok: false, errorReason: (lastErr?.message || 'unknown').slice(0, 80) };
}

// Convert a Unix timestamp to the canonical 1-indexed TLA epoch number.
// epochIndex = Math.floor(elapsed / DURATION) is 0-indexed; we add 1 to match
// `epoch_1-300_date.json` and Eris/Votion UIs.
function timestampToEpoch(tsSeconds) {
    return Math.floor((tsSeconds * 1000 - TLA_EPOCH_START_MS) / TLA_EPOCH_DURATION_MS) + 1;
}
function timestampMsToEpoch(tsMs) {
    return Math.floor((tsMs - TLA_EPOCH_START_MS) / TLA_EPOCH_DURATION_MS) + 1;
}

function groupPointsByEpoch(series) {
    const byEpoch = {};
    for (const point of series) {
        if (!point || typeof point.time !== 'number') continue;
        const value = Number(point.value);
        if (!Number.isFinite(value)) continue;
        const ep = timestampToEpoch(point.time);
        if (!byEpoch[ep]) byEpoch[ep] = [];
        byEpoch[ep].push(value);
    }
    return byEpoch;
}

// Expected per-epoch sample count: every 4h × 7 days = 42.
// Volume averages by /42 (missing = 0 volume), liquidity averages by actual count.
const EXPECTED_POINTS_PER_EPOCH = 42;

// Fetch charts for one pool + aggregate by epoch.
async function fetchPoolEpochData(poolMeta) {
    const poolAddr = poolMeta.poolAddress;
    const [liqResult, volResult] = await Promise.all([
        fetchPoolChart(poolAddr, 'liquidity'),
        fetchPoolChart(poolAddr, 'volume'),
    ]);

    const deprecated = (liqResult.errorReason === 'pool-not-found' ||
                        volResult.errorReason === 'pool-not-found');

    const liqByEpoch = groupPointsByEpoch(liqResult.series);
    const volByEpoch = groupPointsByEpoch(volResult.series);
    const allEpochs = new Set([...Object.keys(liqByEpoch), ...Object.keys(volByEpoch)]);
    const epochs = {};
    for (const epStr of allEpochs) {
        const liqPoints = liqByEpoch[epStr] || [];
        const volPoints = volByEpoch[epStr] || [];
        const avgLiq = liqPoints.length > 0
            ? liqPoints.reduce((a, b) => a + b, 0) / liqPoints.length
            : 0;
        const sumVol = volPoints.reduce((a, b) => a + b, 0);
        const avgVol = sumVol / EXPECTED_POINTS_PER_EPOCH;
        epochs[epStr] = {
            avgLiquidity: avgLiq,
            avgVolume: avgVol,
            liqPointCount: liqPoints.length,
            volPointCount: volPoints.length,
        };
    }

    const sortedEpochs = Object.keys(epochs).map(Number).sort((a, b) => b - a);
    const latestEp = sortedEpochs[0] ?? null;
    const latestLiquidity = latestEp != null ? epochs[latestEp].avgLiquidity : 0;

    return {
        // Identity
        name:          poolMeta.canonicalName,
        rawName:       poolMeta.name,
        bucket:        poolMeta.bucket || null,
        poolContract:  poolAddr,
        lpAddress:     poolMeta.lpAddress || null,
        poolType:      poolMeta.poolType || null,

        // Pre-computed headline from pools.getAll (use these when chart data is sparse)
        astroportTvlUsd:       poolMeta.poolLiquidityUsd || 0,
        astroportDayVolumeUsd: poolMeta.dayVolumeUsd || 0,

        // Astroport indexer flags
        isDeregistered: !!poolMeta.isDeregistered,
        isBlocked:      !!poolMeta.isBlocked,
        isHidden:       !!poolMeta.isHidden,

        // Per-epoch breakdown (from charts)
        epochs,
        latestEpoch:     latestEp,
        latestLiquidity,
        spotLiquidity:   latestLiquidity,

        // Fetch status
        fetchOk:         liqResult.ok || volResult.ok,
        fetchErrors: {
            ...(liqResult.ok ? {} : { liq: liqResult.errorReason }),
            ...(volResult.ok ? {} : { vol: volResult.errorReason }),
        },
        deprecated,
        deprecatedReason: deprecated ? 'Astroport returned "Pool not found"' : null,
    };
}

// -----------------------------------------------------------------------------
// SELECTION HELPERS
// -----------------------------------------------------------------------------

function pickLastCompleteEpoch(epochs) {
    const sorted = Object.keys(epochs).map(Number).sort((a, b) => b - a);
    if (sorted.length === 0) return null;
    const latestEp = sorted[0];

    const pickTier = (minVol, minLiq, tier) => {
        for (const ep of sorted) {
            if (ep === latestEp) continue;
            const d = epochs[ep];
            if (!d) continue;
            if (minVol != null && (d.volPointCount || 0) < minVol) continue;
            if (minLiq != null && (d.liqPointCount || 0) < minLiq) continue;
            return {
                epoch: ep,
                avgLiquidity: d.avgLiquidity || 0,
                totalVolume: (d.avgVolume || 0) * 7,
                liqPointCount: d.liqPointCount || 0,
                volPointCount: d.volPointCount || 0,
                tier,
            };
        }
        return null;
    };
    return pickTier(5, null, 'stable')
        || pickTier(1, null, 'sparse-volume')
        || pickTier(null, 1, 'liquidity-only');
}

// -----------------------------------------------------------------------------
// CSV BUILDERS
// -----------------------------------------------------------------------------

function csvEscape(s) {
    s = String(s ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

function buildDailyCsv(poolsData) {
    const header = 'pool,bucket,pool_type,pool_address,astroport_tvl_usd,astroport_day_volume_usd,latest_epoch_avg_liquidity,latest_epoch,deprecated,is_deregistered,fetch_ok';
    const rows = poolsData.map(p => {
        return [
            csvEscape(p.name),
            p.bucket || '',
            p.poolType || '',
            p.poolContract,
            (p.astroportTvlUsd || 0).toFixed(2),
            (p.astroportDayVolumeUsd || 0).toFixed(2),
            (p.latestLiquidity || 0).toFixed(2),
            p.latestEpoch ?? '',
            p.deprecated ? 'true' : 'false',
            p.isDeregistered ? 'true' : 'false',
            p.fetchOk ? 'true' : 'false',
        ].join(',');
    });
    return [header, ...rows].join('\n') + '\n';
}

function buildWeeklyCsv(poolsData) {
    const header = 'pool,bucket,pool_address,epoch,avg_liquidity_usd,total_volume_usd,liq_points,vol_points,tier,deprecated';
    const rows = poolsData.map(p => {
        const lce = pickLastCompleteEpoch(p.epochs) || {};
        return [
            csvEscape(p.name),
            p.bucket || '',
            p.poolContract,
            lce.epoch ?? '',
            (lce.avgLiquidity || 0).toFixed(2),
            (lce.totalVolume || 0).toFixed(2),
            lce.liqPointCount || 0,
            lce.volPointCount || 0,
            lce.tier || '',
            p.deprecated ? 'true' : 'false',
        ].join(',');
    });
    return [header, ...rows].join('\n') + '\n';
}

// -----------------------------------------------------------------------------
// GITHUB PUBLISH
// -----------------------------------------------------------------------------

function githubApiRequest(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'api.github.com',
            path: apiPath,
            method,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent':    'aDAO-astroport-snapshot/2.0',
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
        console.log(`  ✅ Pushed: ${filepath}`);
        return true;
    }
    console.error(`  ❌ Push failed (HTTP ${result.status}): ${result.data?.message || '<no message>'}`);
    return false;
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------

function determineRunMode(now) {
    if (RUN_MODE_CLI) return RUN_MODE_CLI;
    const dayOfMonth = now.getUTCDate();
    const dayOfWeek = now.getUTCDay();
    if (dayOfMonth === 1) return 'monthly';
    if (dayOfWeek === 1)  return 'weekly';
    return 'daily';
}

async function captureAstroportSnapshot() {
    const startedAt = new Date();
    const runMode = determineRunMode(startedAt);
    const currentEpoch = timestampMsToEpoch(startedAt.getTime());

    console.log(`\n📸 Astroport Snapshot v2 — ${runMode} mode`);
    console.log(`   Started: ${startedAt.toISOString()}`);
    console.log(`   Epoch:   ${currentEpoch}\n`);

    // Phase 1: Pull master pool list from Astroport (single call)
    console.log('🔍 Fetching Astroport pool list...');
    const allPools = await fetchAllAstroportPools();
    console.log(`  ✓ ${allPools.length} pools on phoenix-1`);

    // Phase 2: Pull gauge-bucket assignments from TLA staking contracts (4 parallel queries)
    console.log('🔍 Fetching TLA staking contracts (active + inactive pool registry)...');
    const bucketByPool = await buildBucketMap(allPools);
    const gaugePoolCount = Object.keys(bucketByPool).length;
    console.log(`  ✓ ${gaugePoolCount} TLA-relevant pools (across all 4 staking contracts)`);

    // Phase 3: Filter pools to those that have a gauge bucket assignment OR
    // are in the ALWAYS_INCLUDE_POOLS override list. Everything else is dropped.
    const alwaysInclude = new Set(ALWAYS_INCLUDE_POOLS);
    const selected = allPools.filter(p => {
        if (!p.poolAddress) return false;
        return !!bucketByPool[p.poolAddress] || alwaysInclude.has(p.poolAddress);
    });

    // Annotate selected pools with bucket + canonical name
    const targetPools = selected.map(p => ({
        ...p,
        bucket: bucketByPool[p.poolAddress] || null,
        canonicalName: canonicalizePoolName(p.name),
    }));

    console.log(`\n📊 Fetching chart data for ${targetPools.length} TLA-relevant pools...`);

    // Phase 4: Fetch per-pool chart data (staggered)
    const poolsData = [];
    let ok = 0, deprecated = 0, failed = 0;
    for (let i = 0; i < targetPools.length; i++) {
        const meta = targetPools[i];
        const result = await fetchPoolEpochData(meta);
        poolsData.push(result);

        const status = result.deprecated ? '💤' : (result.fetchOk ? '✓' : '✗');
        const tvl = result.astroportTvlUsd || result.latestLiquidity || 0;
        const tvlStr = tvl > 0 ? `$${tvl.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—';
        const bucket = (meta.bucket || '-').padEnd(10);
        console.log(`  ${status} ${meta.canonicalName.padEnd(22)} ${bucket} TVL=${tvlStr.padStart(14)}`);

        if (result.deprecated) deprecated++;
        else if (result.fetchOk) ok++;
        else failed++;

        if (i < targetPools.length - 1) {
            await new Promise(r => setTimeout(r, POOL_FETCH_STAGGER_MS));
        }
    }
    console.log(`\n  Summary: ${ok} ok, ${deprecated} deprecated, ${failed} failed of ${targetPools.length}`);

    // Phase 5: Assemble snapshot
    const snapshot = {
        schemaVersion: 2,                       // bumped from v1 — discovery source changed
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        period: currentEpoch,
        runMode,
        chartRange: ASTROPORT_CHART_RANGE,
        discoveryMethod: 'astroport-pools-getAll + tla-staking-contracts (total_staked_balances)',
        stats: { ok, deprecated, failed, total: targetPools.length },
        pools: poolsData,
    };

    const jsonFilename = `astroport/astroport-epoch-${currentEpoch}.json`;
    const jsonContent = JSON.stringify(snapshot, null, 2);
    const dateStr = startedAt.toISOString().split('T')[0];
    const dailyCsvFilename = `data/daily/${dateStr}.csv`;
    const dailyCsvContent = buildDailyCsv(poolsData);
    let weeklyCsvFilename = null, weeklyCsvContent = null;
    if (runMode === 'weekly' || runMode === 'monthly') {
        const previousEpoch = currentEpoch - 1;
        weeklyCsvFilename = `data/weekly-avg/2026-epoch-${previousEpoch}.csv`;
        weeklyCsvContent = buildWeeklyCsv(poolsData);
    }

    // Phase 6: Publish
    if (GITHUB_TOKEN) {
        console.log(`\n📤 Publishing to GitHub...`);
        await pushToGithub(jsonFilename, jsonContent, `📊 Astroport epoch ${currentEpoch} — ${dateStr} (${runMode})`);
        await pushToGithub(dailyCsvFilename, dailyCsvContent, `📊 Astroport daily — ${dateStr}`);
        if (weeklyCsvFilename) {
            await pushToGithub(weeklyCsvFilename, weeklyCsvContent, `📊 Astroport weekly — epoch ${currentEpoch - 1}`);
        }
    } else {
        console.log(`\n⚠️  GITHUB_TOKEN not set — saving locally`);
        const writeLocal = (rel, content) => {
            const localPath = path.basename(rel);
            fs.writeFileSync(localPath, content);
            console.log(`   Saved: ${localPath} (${(content.length / 1024).toFixed(1)} KB)`);
        };
        writeLocal(jsonFilename, jsonContent);
        writeLocal(dailyCsvFilename, dailyCsvContent);
        if (weeklyCsvFilename) writeLocal(weeklyCsvFilename, weeklyCsvContent);
    }

    console.log(`\n✅ Snapshot complete (${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s)\n`);
    return snapshot;
}

captureAstroportSnapshot()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('\n❌ Snapshot failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    });
