// =============================================================================
// TLA Snapshot Cron — Phase A
// =============================================================================
//
// Unified TLA pool view. Consumer cron that reads all 5 producer data repos
// (votion, bribes, astroport, ss, network-and-prices) AND performs live chain
// queries (gauge_infos, total_staked_balances, distributions) to produce the
// dashboard's primary data file.
//
// Pool classification (the "active" rule):
//
//   for each pool in gauge_infos(time='next'):
//     bucket_vp     = total VP across all pools in the same bucket
//     pool_pct      = pool_vp / bucket_vp × 100
//
//     if pool_pct >= 1.0%:    status = "active"            (earning rewards)
//     elif pool_vp > 0:       status = "voted_but_inactive" (below 1% threshold)
//     else:                   status = "zero_vp"            (deprecated)
//
// (Eris hides pools with no Astroport chart data; we flag them too via the
//  astroport-pool-data cron's `deprecated` field cross-reference.)
//
// Schedule: hourly at :40 (aligned with network-and-prices)
// Runtime: ~30-60 seconds (lots of parallel chain queries)
// Output:  data/tla-snapshot.json (~150-250 KB)
// =============================================================================

const https = require('https');
const fs = require('fs');

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------

const TERRA_LCD_PRIMARY  = 'https://terra-lcd.publicnode.com';
const TERRA_LCD_FALLBACK = 'https://terra-rest.publicnode.com';

const TLA_GAUGE_CONTROLLER = 'terra1hfksrhchkmsj4qdq33wkksrslnfles6y2l77fmmzeep0xmq24l2smsd3lj';

const TLA_STAKING_CONTRACTS = {
    stable:   'terra1v399cx9drllm70wxfsgvfe694tdsd9x96p9ha36w7muffe4znlusqswspq',
    project:  'terra1awq6t7jfakg9wfjn40fk3wzwmd57mvrqtt3a39z9rmet7wdjj3ysgw3lpa',
    bluechip: 'terra14mmvqn0kthw6sre75vku263lafn5655mkjdejqjedjga4cw0qx2qlf4arv',
    single:   'terra1qdz5qgafx88kp5mf6m2tah8742g4u5g2cek0m3jrgssexexk7g4qw6e23k',
};

const BUCKETS = ['stable', 'project', 'bluechip', 'single'];

// TLA epoch math.
const TLA_EPOCH_START_MS = Date.parse('2022-10-31T00:00:00Z');
const TLA_EPOCH_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// 1% rule — pool is active if its VP is >= this % of its bucket's total VP.
const ACTIVE_THRESHOLD_PCT = 1.0;

// Hourly refresh
const REFRESH_INTERVAL_HOURS = 1;
const REFRESH_INTERVAL_MS = REFRESH_INTERVAL_HOURS * 60 * 60 * 1000;

// Data repo URLs (raw.githubusercontent.com)
const DATA_REPOS = {
    networkPricesUrl:  'https://raw.githubusercontent.com/defipatriot/network-and-prices-data_2026/main/data/network-and-prices.json',
    bribesCurrentUrl:  'https://raw.githubusercontent.com/defipatriot/bribes-data_2026/main/data/current-state.json',
    bribesHistoryUrl:  'https://raw.githubusercontent.com/defipatriot/bribes-data_2026/main/data/pd-bribes-history.json',
    votionBaseUrl:     'https://raw.githubusercontent.com/defipatriot/votion-data_2026/main/votion',
    astroportBaseUrl:  'https://raw.githubusercontent.com/defipatriot/astroport-pool-data_2026/main/astroport',
    ssPoolBaseUrl:     'https://raw.githubusercontent.com/defipatriot/ss-pool-data_2026/main',
};

// HTTP timeouts.
const HTTP_TIMEOUT_MS = 25000;

// GitHub publish config.
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/tla-snapshot-data_2026';
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
            headers: { 'Accept': 'application/json', 'User-Agent': 'aDAO-tla-snapshot/1.0' },
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

async function fetchText(url, label = url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } catch (e) {
        if (e.name === 'AbortError') throw new Error(`Timeout (${label})`);
        throw e;
    } finally {
        clearTimeout(timeout);
    }
}

async function lcdGet(path) {
    const tryLcd = async (base) => fetchJson(`${base}${path}`, `LCD ${path.split('/').slice(-1)[0].slice(0, 30)}`);
    try {
        return await tryLcd(TERRA_LCD_PRIMARY);
    } catch (e1) {
        console.log(`  ⏳ primary LCD failed (${e1.message.slice(0, 60)}), trying fallback`);
        return await tryLcd(TERRA_LCD_FALLBACK);
    }
}

async function queryContract(contractAddr, queryObj) {
    const queryB64 = Buffer.from(JSON.stringify(queryObj)).toString('base64');
    const data = await lcdGet(`/cosmwasm/wasm/v1/contract/${contractAddr}/smart/${queryB64}`);
    return data?.data;
}

// -----------------------------------------------------------------------------
// EPOCH MATH
// -----------------------------------------------------------------------------

function currentEpochInfo() {
    const now = Date.now();
    const elapsed = now - TLA_EPOCH_START_MS;
    const currentEpoch = Math.floor(elapsed / TLA_EPOCH_DURATION_MS);
    const epochStartedAt = TLA_EPOCH_START_MS + (currentEpoch * TLA_EPOCH_DURATION_MS);
    const epochEndsAt = epochStartedAt + TLA_EPOCH_DURATION_MS;
    return {
        currentEpoch,
        nextEpoch: currentEpoch + 1,
        epochStartedAt: new Date(epochStartedAt).toISOString(),
        epochEndsAt: new Date(epochEndsAt).toISOString(),
        epochProgressPct: ((now - epochStartedAt) / TLA_EPOCH_DURATION_MS) * 100,
    };
}

// -----------------------------------------------------------------------------
// PHASE 1: LOAD INPUT DATA FROM ALL 5 PRODUCER REPOS
// -----------------------------------------------------------------------------

async function loadAllInputs(currentEpoch) {
    console.log('📥 Loading input data from 5 producer repos...');

    const tasks = [
        // Token prices (hourly cron, latest is always at /data/network-and-prices.json)
        fetchJson(DATA_REPOS.networkPricesUrl, 'network-and-prices').catch(e => {
            console.log(`  ⚠ network-and-prices: ${e.message.slice(0, 60)}`);
            return null;
        }),
        // Bribes (current + full history)
        fetchJson(DATA_REPOS.bribesCurrentUrl, 'bribes-current').catch(e => {
            console.log(`  ⚠ bribes current-state: ${e.message.slice(0, 60)}`);
            return null;
        }),
        fetchJson(DATA_REPOS.bribesHistoryUrl, 'bribes-history').catch(e => {
            console.log(`  ⚠ bribes history: ${e.message.slice(0, 60)}`);
            return null;
        }),
    ];

    // Votion (epoch-numbered, try next/current/previous since the votion cron
    // captures the UPCOMING epoch's optimization data — so when current=184,
    // the latest votion file is for epoch 185 (the one being voted on right now).
    const votionTask = (async () => {
        for (const e of [currentEpoch + 1, currentEpoch, currentEpoch - 1]) {
            try {
                const data = await fetchJson(`${DATA_REPOS.votionBaseUrl}/votion-epoch-${e}.json`, `votion-${e}`);
                console.log(`  ✓ votion: loaded epoch ${e}`);
                return data;
            } catch (err) { /* try next */ }
        }
        console.log(`  ⚠ votion: no recent file found`);
        return null;
    })();

    // Astroport (epoch-numbered, try current+previous epoch)
    const astroportTask = (async () => {
        for (const e of [currentEpoch, currentEpoch - 1]) {
            try {
                const data = await fetchJson(`${DATA_REPOS.astroportBaseUrl}/astroport-epoch-${e}.json`, `astroport-${e}`);
                console.log(`  ✓ astroport: loaded epoch ${e} (${data.pools?.length || 0} pools)`);
                return data;
            } catch (err) { /* try next */ }
        }
        console.log(`  ⚠ astroport: no recent file found`);
        return null;
    })();

    // Skeleton Swap (CSVs, try today's ISO weekday)
    const ssTask = (async () => {
        try {
            // Get most recent day-N.csv (we'll try today first, then yesterday)
            const today = new Date();
            const tries = [];
            for (let offset = 0; offset < 7; offset++) {
                const d = new Date(today.getTime() - offset * 86400000);
                // ISO day: Monday=1, Sunday=7
                const isoDay = ((d.getUTCDay() + 6) % 7) + 1;
                tries.push(isoDay);
            }
            // De-dupe by first occurrence
            const seen = new Set();
            const uniqueTries = tries.filter(d => !seen.has(d) && seen.add(d));

            for (const day of uniqueTries) {
                try {
                    const text = await fetchText(`${DATA_REPOS.ssPoolBaseUrl}/day-${day}.csv`, `ss-day-${day}`);
                    if (text && text.length > 100) {
                        console.log(`  ✓ ss: loaded day-${day}.csv`);
                        return text;
                    }
                } catch { /* try next */ }
            }
            console.log(`  ⚠ ss: no recent day-N.csv found`);
        } catch (e) {
            console.log(`  ⚠ ss: ${e.message.slice(0, 60)}`);
        }
        return null;
    })();

    const [networkPrices, bribesCurrent, bribesHistory, votion, astroport, ssCsv]
        = await Promise.all([...tasks, votionTask, astroportTask, ssTask]);

    if (networkPrices) console.log(`  ✓ network-and-prices: ${Object.keys(networkPrices.token_prices || {}).length} tokens`);
    if (bribesCurrent)  console.log(`  ✓ bribes-current: ${bribesCurrent.active_bribes?.length || 0} active bribes`);
    if (bribesHistory)  console.log(`  ✓ bribes-history: ${bribesHistory.bribes?.length || 0} bribes`);

    return { networkPrices, bribesCurrent, bribesHistory, votion, astroport, ssCsv };
}

// -----------------------------------------------------------------------------
// PARSE SS CSV INTO POOL MAP
// -----------------------------------------------------------------------------

function parseSsCsv(csvText) {
    if (!csvText) return new Map();
    const lines = csvText.split('\n').filter(l => l.trim());
    if (lines.length < 2) return new Map();
    const headers = lines[0].split(',').map(h => h.trim());
    const idx = {
        pool_id:        headers.indexOf('pool_id'),
        pool_address:   headers.indexOf('pool_address'),
        tvl_usd:        headers.indexOf('tvl_usd'),
        volume_24h_usd: headers.indexOf('volume_24h_usd'),
        volume_7d_usd:  headers.indexOf('volume_7d_usd'),
        apr_7d:         headers.indexOf('apr_7d'),
        reserve_0:      headers.indexOf('reserve_0'),
        reserve_1:      headers.indexOf('reserve_1'),
        total_share:    headers.indexOf('total_share'),
    };
    const result = new Map();
    // Simple CSV parser — handles quoted fields with commas inside
    for (let i = 1; i < lines.length; i++) {
        const row = parseCsvRow(lines[i]);
        const addr = row[idx.pool_address];
        if (!addr) continue;
        result.set(addr, {
            pool_id:        (row[idx.pool_id] || '').replace(/"/g, ''),
            pool_address:   addr,
            tvl_usd:        parseFloat(row[idx.tvl_usd]) || null,
            volume_24h_usd: parseFloat(row[idx.volume_24h_usd]) || null,
            volume_7d_usd:  parseFloat(row[idx.volume_7d_usd]) || null,
            apr_7d:         parseFloat(row[idx.apr_7d]) || null,
            reserve_0:      row[idx.reserve_0] || null,
            reserve_1:      row[idx.reserve_1] || null,
            total_share:    row[idx.total_share] || null,
        });
    }
    return result;
}

function parseCsvRow(line) {
    const result = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            inQuote = !inQuote;
        } else if (c === ',' && !inQuote) {
            result.push(cur);
            cur = '';
        } else {
            cur += c;
        }
    }
    result.push(cur);
    return result;
}

// -----------------------------------------------------------------------------
// PHASE 2: CHAIN QUERIES — gauge_infos + total_staked_balances + distributions
// -----------------------------------------------------------------------------

async function fetchChainState() {
    console.log('⛓  Fetching chain state (gauge_infos × 4 + staked_balances × 4 + distributions)...');

    // Run in parallel
    const [
        stableGauge, projectGauge, bluechipGauge, singleGauge,
        stableStaked, projectStaked, bluechipStaked, singleStaked,
        distributions,
    ] = await Promise.all([
        queryContract(TLA_GAUGE_CONTROLLER, { gauge_infos: { gauge: 'stable',   time: 'next' } }),
        queryContract(TLA_GAUGE_CONTROLLER, { gauge_infos: { gauge: 'project',  time: 'next' } }),
        queryContract(TLA_GAUGE_CONTROLLER, { gauge_infos: { gauge: 'bluechip', time: 'next' } }),
        queryContract(TLA_GAUGE_CONTROLLER, { gauge_infos: { gauge: 'single',   time: 'next' } }),
        queryContract(TLA_STAKING_CONTRACTS.stable,   { total_staked_balances: {} }),
        queryContract(TLA_STAKING_CONTRACTS.project,  { total_staked_balances: {} }),
        queryContract(TLA_STAKING_CONTRACTS.bluechip, { total_staked_balances: {} }),
        queryContract(TLA_STAKING_CONTRACTS.single,   { total_staked_balances: {} }),
        queryContract(TLA_GAUGE_CONTROLLER, { distributions: {} }),
    ]);

    const gauges = {
        stable: stableGauge || [],
        project: projectGauge || [],
        bluechip: bluechipGauge || [],
        single: singleGauge || [],
    };
    const stakedBalances = {
        stable: stableStaked || [],
        project: projectStaked || [],
        bluechip: bluechipStaked || [],
        single: singleStaked || [],
    };

    // Log counts
    for (const b of BUCKETS) {
        console.log(`  ${b}: ${gauges[b].length} gauge entries, ${stakedBalances[b].length} staking entries`);
    }
    console.log(`  distributions: ${distributions?.length || 0} bucket entries`);

    return { gauges, stakedBalances, distributions: distributions || [] };
}

// -----------------------------------------------------------------------------
// PHASE 3: RESOLVE POOL IDs TO POOL ADDRESSES + NAMES
// -----------------------------------------------------------------------------
//
// A gauge_infos entry's pool_id can be:
//   - "cw20:terra1..."                      → cw20 LP token, query minter to get pool addr
//   - "native:factory/<POOL>/uLP"           → native LP, parse pool addr from path
//   - "native:factory/<HUB>/<SYMBOL>"       → single-sided gauge, no pool addr
//   - "native:ibc/<HASH>"                   → single-sided IBC token (Creda case!)
//   - "native:uluna" / similar              → single-sided native
//
// We resolve to: { poolAddr, lpAddr, isSingle, isLpPair, name (set later) }

async function resolvePoolId(poolId) {
    try {
        if (poolId.startsWith('cw20:')) {
            const lpAddr = poolId.slice(5);
            // Query minter to get the pool address
            const minterInfo = await queryContract(lpAddr, { minter: {} });
            const poolAddr = minterInfo?.minter || null;
            return { lpAddr, poolAddr, isLpPair: true, isSingle: false, sourceType: 'cw20' };
        }

        if (poolId.startsWith('native:')) {
            const denom = poolId.slice('native:'.length);
            const parts = denom.split('/');

            // Sub-case A: factory LP — "factory/<POOL>/uLP"
            if (denom.startsWith('factory/') && parts.length >= 3 && parts[parts.length - 1] === 'uLP') {
                const poolAddr = parts[1];
                return { lpAddr: null, poolAddr, isLpPair: true, isSingle: false, sourceType: 'native-lp', lpDenom: denom };
            }

            // Sub-case B: factory single — "factory/<HUB>/<SYMBOL>"
            if (denom.startsWith('factory/')) {
                return { lpAddr: null, poolAddr: null, isLpPair: false, isSingle: true, sourceType: 'native-single', lpDenom: denom, symbolFromDenom: parts.slice(2).join('/') };
            }

            // Sub-case C: IBC token — single-sided (Creda's wBTC.creda.a is here)
            if (denom.startsWith('ibc/')) {
                return { lpAddr: null, poolAddr: null, isLpPair: false, isSingle: true, sourceType: 'native-ibc', lpDenom: denom };
            }

            // Sub-case D: bare native (uluna etc.)
            return { lpAddr: null, poolAddr: null, isLpPair: false, isSingle: true, sourceType: 'native-bare', lpDenom: denom };
        }

        return null;
    } catch (e) {
        console.log(`  ⚠ resolve(${poolId.slice(0, 50)}): ${e.message.slice(0, 60)}`);
        return null;
    }
}

// -----------------------------------------------------------------------------
// PHASE 4: BUILD POOL CATALOG
// -----------------------------------------------------------------------------

async function buildPoolCatalog(chainState, astroportData) {
    console.log('🔍 Building pool catalog (resolving pool_ids)...');

    // Map from astroport-pool-data
    const astroportByPool = new Map();
    if (astroportData?.pools) {
        for (const p of astroportData.pools) {
            if (p.poolContract) astroportByPool.set(p.poolContract, p);
        }
    }
    console.log(`  ✓ Astroport cron data: ${astroportByPool.size} pools cross-referenced`);

    // First pass — compute bucket VPs
    const bucketVps = {};
    for (const bucket of BUCKETS) {
        bucketVps[bucket] = chainState.gauges[bucket].reduce(
            (sum, [, v]) => sum + (parseFloat(v?.voting_power) || 0), 0
        );
    }

    // Index staked-balance entries by their asset for joining
    // The staking entries reference LP tokens via {cw20: addr} or {native: denom}
    const stakedByAssetKey = new Map();
    for (const bucket of BUCKETS) {
        for (const entry of chainState.stakedBalances[bucket]) {
            const info = entry?.asset?.info;
            if (!info) continue;
            const key = info.cw20 ? `cw20:${info.cw20}` : (info.native ? `native:${info.native}` : null);
            if (key) stakedByAssetKey.set(key, { ...entry, _bucket: bucket });
        }
    }

    // Resolve each pool entry in parallel batches of 8
    const allEntries = [];
    for (const bucket of BUCKETS) {
        for (const [poolId, voting] of chainState.gauges[bucket]) {
            allEntries.push({ bucket, poolId, voting, bucketVp: bucketVps[bucket] });
        }
    }
    console.log(`  Resolving ${allEntries.length} pool_ids...`);

    const resolved = [];
    const BATCH_SIZE = 8;
    for (let i = 0; i < allEntries.length; i += BATCH_SIZE) {
        const batch = allEntries.slice(i, i + BATCH_SIZE);
        const batchResolved = await Promise.all(batch.map(async (e) => {
            const r = await resolvePoolId(e.poolId);
            return { ...e, resolved: r };
        }));
        resolved.push(...batchResolved);
    }

    console.log(`  ✓ Resolved ${resolved.filter(r => r.resolved).length}/${allEntries.length} pool_ids`);
    return { resolved, bucketVps, astroportByPool, stakedByAssetKey };
}

// -----------------------------------------------------------------------------
// PHASE 5: ENRICH POOLS WITH LP HEALTH, ampLP, AND ALL METRICS
// -----------------------------------------------------------------------------

async function enrichPool(entry, ctx) {
    const { bucket, poolId, voting, bucketVp, resolved } = entry;
    const { astroportByPool, stakedByAssetKey, ssByAddress, tokenPrices, lstRatios } = ctx;

    if (!resolved) return null;

    const vp = parseFloat(voting?.voting_power) || 0;
    const pctOfBucket = bucketVp > 0 ? (vp / bucketVp) * 100 : 0;

    // Pool identity from astroport cron data (most reliable for LP names)
    const astroEntry = resolved.poolAddr ? astroportByPool.get(resolved.poolAddr) : null;
    const ssEntry = resolved.poolAddr ? ssByAddress.get(resolved.poolAddr) : null;

    // Status determination
    const isAstroportPool = !!astroEntry;
    const isSsPool = !!ssEntry;
    const isDeprecated = astroEntry?.deprecated === true;
    let status;
    if (isDeprecated) status = 'deprecated';
    else if (pctOfBucket >= ACTIVE_THRESHOLD_PCT) status = 'active';
    else if (vp > 0) status = 'voted_but_below_threshold';
    else status = 'zero_vp';

    // ampLP info from staking contract
    let assetKey;
    if (resolved.lpAddr) assetKey = `cw20:${resolved.lpAddr}`;
    else if (resolved.lpDenom) assetKey = `native:${resolved.lpDenom}`;
    const stakedEntry = assetKey ? stakedByAssetKey.get(assetKey) : null;

    const ampLp = stakedEntry ? buildAmpLpInfo(stakedEntry) : null;

    // Name + DEX + dex_subtype
    let name = null, dex = null, dexSubtype = null;
    if (astroEntry) {
        name = astroEntry.name;
        dex = 'Astroport';
        dexSubtype = astroEntry.poolType || null;  // 'concentrated', 'xyk', 'stable'
    } else if (ssEntry) {
        name = ssEntry.pool_id;
        dex = 'Skeleton Swap';
        dexSubtype = null;  // could detect from name if needed
    } else if (resolved.isSingle) {
        // Single-sided gauges — derive name from denom/symbol
        if (resolved.symbolFromDenom) {
            name = resolved.symbolFromDenom;
        } else if (resolved.lpDenom?.startsWith('ibc/')) {
            // Creda case: wBTC.creda.a — IBC denom
            // Could resolve via denom_traces but for now mark by hash prefix
            name = 'Single:' + resolved.lpDenom.slice(0, 30);
        } else if (resolved.lpDenom) {
            name = resolved.lpDenom.slice(0, 30);
        }
        dex = 'Single';  // override below if pool address suggests Creda etc
        dexSubtype = 'single';
    }
    // Fallback name from pool_id if all else fails
    if (!name) name = poolId.slice(0, 50);

    // LP health — for LP-pair pools, query the pool contract for reserves
    let lpHealth = null;
    if (resolved.isLpPair && resolved.poolAddr) {
        try {
            const poolData = await queryContract(resolved.poolAddr, { pool: {} });
            if (poolData && Array.isArray(poolData.assets) && poolData.assets.length >= 2) {
                lpHealth = buildLpHealth(poolData, tokenPrices);
            }
        } catch (e) {
            // Skip — pool might be on a chain other than terra (e.g. neutron-only)
        }
    }

    // Staked-in-TLA USD value (approximation)
    // staked_lp_tokens × (lp_pool_total_value / lp_pool_total_share)
    let stakedInTlaUsd = null;
    if (stakedEntry && lpHealth?.total_pool_usd && lpHealth.total_share) {
        const stakedLpAmount = parseFloat(stakedEntry.asset.amount);
        const lpUnitValue = lpHealth.total_pool_usd / parseFloat(lpHealth.total_share);
        stakedInTlaUsd = stakedLpAmount * lpUnitValue;
    }

    // Pool depth (Astroport TVL or SS TVL)
    const depthUsd = astroEntry?.astroportTvlUsd ?? ssEntry?.tvl_usd ?? null;

    return {
        // Identity
        name,
        bucket,
        dex,
        dex_subtype: dexSubtype,
        pool_address: resolved.poolAddr,
        lp_address: resolved.lpAddr,
        is_lp_pair: resolved.isLpPair,
        is_single: resolved.isSingle,
        source_type: resolved.sourceType,
        status,

        // Voting power
        voting_power: {
            vp,
            vp_human: vp / 1e6,  // ampLP-equivalent display units
            pct_of_bucket: pctOfBucket,
        },

        // Depth + TVL
        depth_usd: depthUsd,
        staked_in_tla_usd: stakedInTlaUsd,

        // LP health (both sides)
        lp_health: lpHealth,

        // ampLP price info
        amp_lp: ampLp,

        // Cross-references (for debug + dashboard links)
        sources: {
            in_astroport_cron: !!astroEntry,
            in_ss_cron: !!ssEntry,
            in_staking_contract: !!stakedEntry,
            deprecated_in_astroport: astroEntry?.deprecatedReason || null,
        },

        // Raw pool_id from gauge (for tracing)
        gauge_pool_id: poolId,
    };
}

function buildAmpLpInfo(stakedEntry) {
    const underlying = parseFloat(stakedEntry.asset.amount);    // total LP tokens held
    const shares = parseFloat(stakedEntry.shares);              // total ampLP shares issued
    if (!underlying || !shares) return null;

    const ratio = underlying / shares;  // LP per ampLP
    let ratioType;
    if (Math.abs(ratio - 1.0) < 0.001) ratioType = 'unity';
    else if (ratio > 1.0) ratioType = 'amplified';            // rewards compounded in
    else ratioType = 'non-amplified';                          // fees taken out

    const stakeConfig = stakedEntry.config?.stake_config;
    let stakeMechanism = 'unknown';
    if (typeof stakeConfig === 'string' && stakeConfig === 'default') stakeMechanism = 'custody';
    else if (typeof stakeConfig === 'object' && stakeConfig?.astroport) stakeMechanism = 'astroport-incentives';

    return {
        underlying_lp_amount: underlying,
        shares,
        ratio,
        ratio_type: ratioType,
        stake_mechanism: stakeMechanism,
        yearly_take_rate: parseFloat(stakedEntry.config?.yearly_take_rate) || null,
        // The dashboard can compute: ampLP_usd_price = lpHealth.total_pool_usd / shares
        // We don't compute it here since lpHealth might be null for some pools
    };
}

function buildLpHealth(poolData, tokenPrices) {
    const tokenSymbolFromInfo = (info) => {
        if (info?.native_token?.denom) return resolveNativeDenom(info.native_token.denom);
        if (info?.token?.contract_addr) return null;  // cw20 — would need extra lookup
        return null;
    };

    const assets = poolData.assets;
    const assetDetails = assets.map(a => {
        const symbol = tokenSymbolFromInfo(a.info);
        const amount = parseFloat(a.amount) || 0;
        // Token decimals registry — critical for correct USD math.
        // Bridged tokens (PAXG, WBTC, ETH, etc.) have non-6 decimals.
        const decimals = TOKEN_DECIMALS[symbol] ?? 6;
        let usdValue = null;
        let amountHuman = amount / Math.pow(10, decimals);
        if (symbol && tokenPrices?.[symbol]?.final_price_usd) {
            const price = tokenPrices[symbol].final_price_usd;
            usdValue = amountHuman * price;
            return { symbol, amount_raw: amount, amount_human: amountHuman, decimals, usd_value: usdValue, price_usd: price };
        }
        return { symbol, amount_raw: amount, amount_human: amountHuman, decimals, usd_value: null, price_usd: null };
    });

    const totalUsd = assetDetails.reduce((s, a) => s + (a.usd_value || 0), 0);
    const balanceRatio = assetDetails.map(a => totalUsd > 0 ? (a.usd_value / totalUsd) * 100 : null);

    return {
        asset_0: assetDetails[0],
        asset_1: assetDetails[1],
        balance_ratio_pct: balanceRatio,
        total_pool_usd: totalUsd > 0 ? totalUsd : null,
        total_share: poolData.total_share,
    };
}

// Token decimals registry — required for correct USD math.
// Bridged tokens often have 18 or 8 decimals, not 6.
// Source: chain queries to each token's `token_info` (cw20) or known IBC mappings.
const TOKEN_DECIMALS = {
    // Native Terra (all 6)
    LUNA:    6,
    // IBC bridged 18-decimal tokens (ETH-family, EVM-side)
    PAXG:    18,
    EURE:    18,
    ETH:     18,
    WETH:    18,
    WSTETH:  18,
    BNB:     18,
    WBNB:    18,
    INJ:     18,
    // Bitcoin-family
    WBTC:    8,
    // Cosmos-family (mostly 6)
    USDC:    6,
    USDT:    6,
    ATOM:    6,
    OSMO:    6,
    STLUNA:  6,
    STATOM:  6,
    SOLID:   6,
    SWTH:    8,
    ROAR:    6,
    CAPA:    6,
    // Terra factory tokens / cw20s (default 6 for chain-native LSTs)
    ampLUNA:  6,
    arbLUNA:  6,
    bLUNA:    6,
    boneLUNA: 6,
    ampROAR:  6,
    ampCAPA:  6,
    xASTRO:   6,
    ASTRO:    6,
    FUEL:     6,
    // WHALE-family
    WHALE:    6,
    ampWHALE: 6,
    boneWHALE: 6,
};

// Resolve a native denom to a symbol (uluna → LUNA, ibc/... → known IBC tokens, factory/...)
// For Phase A we use a small inline registry. Phase B can broaden via denom_traces.
function resolveNativeDenom(denom) {
    if (denom === 'uluna') return 'LUNA';

    // IBC denoms — from network-and-prices token registry. Add as needed.
    const IBC_MAP = {
        'ibc/2C962DAB9F57FE0921435426AE75196009FAA1981BF86991203C8411F8980FDB': 'USDC',
        'ibc/9B19062D46CAB50361CE9B0A3E6D0A7A53AC9E7CB361F32A73CC733144A9A9E5': 'USDT',
        'ibc/88386AC48152D48B34B082648DF836F975506F0B57DBBFC10A54213B1BF484CB': 'WBTC',
        'ibc/0EF5630576C66968EF0787868CF09FD866FAD131BC148D24A148358A85F0EB62': 'PAXG',
        'ibc/8D52B251B447B7160421ACFBD50F6B0ABE5F98D2C404B03701130F12044439A1': 'EURE',
        'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2': 'ATOM',
        'ibc/20850C646CDDDC2270E9BBDB08558B5FEE57B647EC6827F41096AABFD8A0471B': 'ETH',
        'ibc/A356EC90DC3AE43D485514DA7260EDC7ABB5CFAA0654CE2524C739392975AD3C': 'WSTETH',
        'ibc/1319C6B38CA613C89D78C2D1461B305038B1085F6855E8CD276FE3F7C9600B4C': 'BNB',
        'ibc/4B44179AC2F0BEE50C16A673B3B886398988692885B2848A1C8AEF27148B3961': 'FUEL',
        'ibc/B3F639855EE7478750CC8F82072307ED6E131A8EFF20345E1D136B50C4E5EC36': 'ampWHALE',
        'ibc/36A02FFC4E74DF4F64305130C3DFA1B06BEAC775648927AA44467C76A77AB8DB': 'WHALE',
    };
    if (IBC_MAP[denom]) return IBC_MAP[denom];

    // Factory denoms — try to extract the symbol from the path
    if (denom.startsWith('factory/')) {
        const parts = denom.split('/');
        const symbol = parts[parts.length - 1];
        // Common ones we recognize
        const knownFactorySymbols = ['ampLUNA', 'arbLUNA', 'bLUNA', 'ampCAPA', 'ampROAR', 'xASTRO',
                                     'CAPA', 'ROAR', 'ASTRO', 'SOLID', 'FUEL', 'SWTH', 'stLUNA'];
        if (knownFactorySymbols.includes(symbol)) return symbol;
        return symbol;  // return whatever the suffix is
    }

    return null;
}

// -----------------------------------------------------------------------------
// PHASE 6: BRIBES PER POOL
// -----------------------------------------------------------------------------

function attachBribes(pools, bribesCurrent, bribesHistory) {
    if (!bribesCurrent && !bribesHistory) return;

    // Active bribes — keyed by pool asset
    const activeBribesByKey = new Map();
    if (bribesCurrent?.active_bribes) {
        for (const b of bribesCurrent.active_bribes) {
            const key = b.asset?.cw20 ? `cw20:${b.asset.cw20}` :
                       b.asset?.native ? `native:${b.asset.native}` : null;
            if (key) {
                if (!activeBribesByKey.has(key)) activeBribesByKey.set(key, []);
                activeBribesByKey.get(key).push(b);
            }
        }
    }

    // PD historical bribes — count per pool
    const pdHistoricalByKey = new Map();
    if (bribesHistory?.bribes) {
        for (const b of bribesHistory.bribes) {
            const key = b.for_pool?.cw20 ? `cw20:${b.for_pool.cw20}` :
                       b.for_pool?.native ? `native:${b.for_pool.native}` : null;
            if (key) {
                if (!pdHistoricalByKey.has(key)) pdHistoricalByKey.set(key, []);
                pdHistoricalByKey.get(key).push(b);
            }
        }
    }

    // Attach to each pool
    for (const pool of pools) {
        const assetKey = pool.lp_address ? `cw20:${pool.lp_address}` :
                        pool.is_single && pool.gauge_pool_id ? pool.gauge_pool_id : null;

        pool.bribes = {
            active_now: activeBribesByKey.get(assetKey) || [],
            pd_historical_count: (pdHistoricalByKey.get(assetKey) || []).length,
        };
    }
}

// -----------------------------------------------------------------------------
// PHASE 7: VOTION VP DETAIL PER POOL
// -----------------------------------------------------------------------------

function attachVotionDetail(pools, votionData) {
    if (!votionData?.pools) return;

    // Votion uses "{name}|{dex}" as keys (e.g. "LUNA-USDC|Astroport")
    for (const pool of pools) {
        if (!pool.name || !pool.dex) continue;
        const key = `${pool.name.replace(/ LP$/, '').trim()}|${pool.dex}`;
        const votionEntry = votionData.pools[key];
        if (votionEntry) {
            pool.voting_power.lockup_contributions = votionEntry.lockup_contributions || [];
            pool.voting_power.votion_current_vp = votionEntry.current_vp;
            pool.voting_power.votion_optimized_vp = votionEntry.optimized_vp;
        }
    }
}

// -----------------------------------------------------------------------------
// PHASE 8: TOP-LEVEL ROLLUPS
// -----------------------------------------------------------------------------

function computeRollups(pools, bucketVps) {
    const totals = {
        tla_tvl_usd: 0,
        depth_usd_total: 0,
        active_pools_count: 0,
        voted_pools_count: 0,
        deprecated_pools_count: 0,
        zero_vp_pools_count: 0,
        total_pool_count: pools.length,
    };
    const byBucket = {};
    for (const b of BUCKETS) {
        byBucket[b] = {
            bucket_vp: bucketVps[b] || 0,
            bucket_vp_human: (bucketVps[b] || 0) / 1e6,
            pool_count: 0,
            active_count: 0,
            tla_tvl_usd: 0,
            depth_usd: 0,
        };
    }

    for (const p of pools) {
        if (p.status === 'active') totals.active_pools_count++;
        else if (p.status === 'voted_but_below_threshold') totals.voted_pools_count++;
        else if (p.status === 'deprecated') totals.deprecated_pools_count++;
        else totals.zero_vp_pools_count++;

        if (p.staked_in_tla_usd) totals.tla_tvl_usd += p.staked_in_tla_usd;
        if (p.depth_usd) totals.depth_usd_total += p.depth_usd;

        const b = byBucket[p.bucket];
        if (b) {
            b.pool_count++;
            if (p.status === 'active') b.active_count++;
            if (p.staked_in_tla_usd) b.tla_tvl_usd += p.staked_in_tla_usd;
            if (p.depth_usd) b.depth_usd += p.depth_usd;
        }
    }

    return { totals, byBucket };
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
                'User-Agent': 'aDAO-tla-snapshot/1.0',
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
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
    const body = { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH, ...(sha ? { sha } : {}) };
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

async function captureTlaSnapshot() {
    const startedAt = new Date();
    const epochInfo = currentEpochInfo();

    console.log(`\n🏛️  TLA Snapshot Capture`);
    console.log(`   Started: ${startedAt.toISOString()}`);
    console.log(`   Current epoch: ${epochInfo.currentEpoch} (ends ${epochInfo.epochEndsAt}, ${epochInfo.epochProgressPct.toFixed(1)}% through)\n`);

    // Phase 1: load all 5 producer inputs
    const inputs = await loadAllInputs(epochInfo.currentEpoch);
    const tokenPrices = inputs.networkPrices?.token_prices || {};
    const lstRatios = inputs.networkPrices?.lst_ratios || {};
    const ssByAddress = parseSsCsv(inputs.ssCsv);

    // Phase 2: chain queries
    const chainState = await fetchChainState();

    // Phase 3: build pool catalog (resolve pool_ids → addresses)
    const catalog = await buildPoolCatalog(chainState, inputs.astroport);

    // Phase 4-5: enrich each pool
    console.log('💎 Enriching pools with LP health, ampLP info, USD valuations...');
    const enrichCtx = {
        astroportByPool: catalog.astroportByPool,
        stakedByAssetKey: catalog.stakedByAssetKey,
        ssByAddress,
        tokenPrices,
        lstRatios,
    };

    // Enrich in parallel batches (each does a chain query for LP health)
    const pools = [];
    const BATCH = 6;
    for (let i = 0; i < catalog.resolved.length; i += BATCH) {
        const batch = catalog.resolved.slice(i, i + BATCH);
        const enriched = await Promise.all(batch.map(e => enrichPool(e, enrichCtx)));
        pools.push(...enriched.filter(Boolean));
    }
    console.log(`  ✓ Enriched ${pools.length} pools`);

    // Phase 6: bribes
    console.log('🎁 Attaching bribes...');
    attachBribes(pools, inputs.bribesCurrent, inputs.bribesHistory);

    // Phase 7: votion VP detail
    console.log('🗳️  Attaching votion VP detail...');
    attachVotionDetail(pools, inputs.votion);

    // Phase 8: rollups
    console.log('📊 Computing rollups...');
    const { totals, byBucket } = computeRollups(pools, catalog.bucketVps);

    // Final assembly
    const snapshot = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        refreshIntervalMs: REFRESH_INTERVAL_MS,
        refreshIntervalHours: REFRESH_INTERVAL_HOURS,
        nextRefreshExpectedAt: new Date(startedAt.getTime() + REFRESH_INTERVAL_MS).toISOString(),

        epoch: epochInfo,

        sources: {
            network_and_prices: !!inputs.networkPrices,
            bribes_current:     !!inputs.bribesCurrent,
            bribes_history:     !!inputs.bribesHistory,
            votion:             !!inputs.votion,
            astroport:          !!inputs.astroport,
            skeleton_swap:      !!inputs.ssCsv,
        },

        totals,
        buckets: byBucket,
        pools,
    };

    const content = JSON.stringify(snapshot, null, 2);

    // Summary log
    console.log(`\n📋 Summary:`);
    console.log(`   Pools total: ${totals.total_pool_count}`);
    console.log(`   Active (>=1% bucket VP): ${totals.active_pools_count}`);
    console.log(`   Voted but below threshold: ${totals.voted_pools_count}`);
    console.log(`   Deprecated: ${totals.deprecated_pools_count}`);
    console.log(`   Zero VP: ${totals.zero_vp_pools_count}`);
    console.log(`   TLA TVL: $${totals.tla_tvl_usd.toFixed(0)}`);
    console.log(`   Depth (DEX) total: $${totals.depth_usd_total.toFixed(0)}`);
    for (const b of BUCKETS) {
        console.log(`   ${b}: ${byBucket[b].active_count}/${byBucket[b].pool_count} active, VP ${(byBucket[b].bucket_vp/1e6).toFixed(2)}M, TVL $${byBucket[b].tla_tvl_usd.toFixed(0)}`);
    }
    console.log(`   File size: ${(content.length / 1024).toFixed(1)} KB`);

    const dateStr = startedAt.toISOString().slice(0, 10);

    if (GITHUB_TOKEN) {
        console.log('\n📤 Publishing to GitHub...');
        await pushToGithub('data/tla-snapshot.json', content,
            `🏛️ TLA snapshot — epoch ${epochInfo.currentEpoch} (${dateStr} ${startedAt.getUTCHours().toString().padStart(2,'0')}:xx)`);
        // Only write daily archive at end-of-day (hour 23) to keep folder clean
        if (startedAt.getUTCHours() === 23) {
            await pushToGithub(`data/daily/${dateStr}.json`, content,
                `🏛️ Daily archive ${dateStr}`);
            console.log(`  ✓ End-of-day archive written`);
        } else {
            console.log(`  (skipping daily archive — only written at 23:xx UTC)`);
        }
    } else {
        console.log('\n⚠️  GITHUB_TOKEN not set — saving locally');
        fs.writeFileSync('tla-snapshot.json', content);
        console.log(`  Saved: tla-snapshot.json`);
    }

    console.log(`\n✅ Done (${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s)\n`);
    return snapshot;
}

captureTlaSnapshot()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('\n❌ Failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    });
