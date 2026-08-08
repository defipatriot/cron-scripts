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
const crypto = require('crypto');

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

// -----------------------------------------------------------------------------
// REWARDS MODEL CONSTANTS (Phase B)
// -----------------------------------------------------------------------------
//
// TLA emissions are determined by:
//   1. Chain inflation (LUNA emitted per year by the Cosmos SDK mint module)
//   2. Alliance module's "reward_weight" for each Alliance asset
//   3. Within each bucket, the gauge controller's pool distribution (varies each epoch)
//
// Each TLA bucket has a separate Alliance asset (vt token) with a chain-set
// reward_weight. These weights are governance parameters that change only via
// on-chain proposals (rare event).
//
// Source of truth: Terra block explorer "Alliances" page → Alliance Assets table
//                  https://chainsco.pe/terra2 or similar
//                  (LCD endpoints for individual alliance queries are firewalled
//                   at our LCD provider, so this comes from explorer UI)
//
// Calibrated: 2026-05-13
// To update: visit the Alliance Assets table, find the 4 TLA vt tokens, copy
//            their reward_weight values into TLA_ALLIANCE_WEIGHTS below.
//            Health page (when built) will flag if Eris UI drifts from our model.
//
// Each TLA bucket's vt token:
//   stable   factory/terra1ym2495f63mdx63tu96085x2vf3xpy9z9k5urxwhvmf9jldm99q5qr4q6n8/vt   10%
//   project  factory/terra1x8v9fujf3c78q2we23x0vgzmxgtt0hgvuvfsxy4w3ar9kcua4c6qqcnhyh/vt    5%
//   bluechip factory/terra16l43xt2uq09yvz4axg73n8rtm0qte9lremdwm6ph0e35r2jnm43qnl8h53/vt    5%
//   single   factory/terra1u72y7gppxrsncctvgfyqduv3md6pgq77pqhz9rxgwl3dqgye00cq7vmf8u/vt    5%
//   ───────────────────────────────────────────────────────────────────────────────────────
//   Total TLA share of Alliance rewards:                                                  25%
//
// Other Alliance asset (non-TLA) we observed in screenshot — for awareness only:
//   factory/terra16st8yfprkdl06kccktshd3p2vccq93xcn9mkhjl8s4jumyjtd4kqye0me5/vt   14%
//   (unknown protocol — possibly aDAO direct, not TLA)
//
const TLA_ALLIANCE_WEIGHTS = {
    stable:   0.10,
    project:  0.05,
    bluechip: 0.05,
    single:   0.05,
};

// Calibration constant: TLA's total annual LUNA emission.
//
// Derived from Eris UI displayed "Rewards $X/year" per pool, summed across all pools:
//   Sum of per-pool annual rewards $ = $1,184,056/year  (calibration)
//   At LUNA $0.067 = 17,672,478 LUNA/year
//
// This represents the LUNA emission rate for the TLA bucket's 25% Alliance share.
// Each cron run multiplies this by the LIVE LUNA price to get current $ value.
//
// If Alliance governance changes TLA's overall share (e.g. votes to raise from 25%
// to 30%), this constant needs updating. Visible signal: Eris UI's total "Rewards"
// header value diverges meaningfully from our model.
//
// Calibrated: 2026-05-13
const TLA_LUNA_EMISSIONS_PER_YEAR = 17_672_478;

const REWARDS_CALIBRATION_DATE = '2026-05-13';

// Epochs per year (TLA epoch = 1 week, so ~52.18 per year)
const EPOCHS_PER_YEAR = (365.25 * 24 * 60 * 60 * 1000) / TLA_EPOCH_DURATION_MS;


// Hourly refresh
const REFRESH_INTERVAL_HOURS = 1;
const REFRESH_INTERVAL_MS = REFRESH_INTERVAL_HOURS * 60 * 60 * 1000;

// Data repo URLs (raw.githubusercontent.com)
const DATA_REPOS = {
    networkPricesUrl:  'https://raw.githubusercontent.com/thealliancedao/tla-core/main/network-and-prices/current.json',
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
    // epochIndex is 0-indexed (count of complete weeks since TLA START on 2022-10-31).
    // We use it INTERNALLY for date math (epochStartedAt etc.) because the math
    // requires a 0-indexed offset.
    // We expose `currentEpoch` as epochIndex + 1 — the 1-indexed CANONICAL epoch
    // number that matches `epoch_1-300_date.json` and Eris/Votion UIs.
    const epochIndex = Math.floor(elapsed / TLA_EPOCH_DURATION_MS);
    const currentEpoch = epochIndex + 1;
    const epochStartedAt = TLA_EPOCH_START_MS + (epochIndex * TLA_EPOCH_DURATION_MS);
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
        // Support both legacy column 'pool_id' and new aligned column 'pool_name'.
        // The SS cron migrated to pool_name in 2026-05 to align with Astroport's schema.
        pool_id:        headers.indexOf('pool_id'),
        pool_name:      headers.indexOf('pool_name'),
        pool_address:   headers.indexOf('pool_address'),
        tvl_usd:        headers.indexOf('tvl_usd'),
        volume_24h_usd: headers.indexOf('volume_24h_usd'),
        volume_7d_usd:  headers.indexOf('volume_7d_usd'),
        apr_7d:         headers.indexOf('apr_7d'),
        reserve_0:      headers.indexOf('reserve_0'),
        reserve_1:      headers.indexOf('reserve_1'),
        total_share:    headers.indexOf('total_share'),
    };
    // Prefer pool_name when present, fall back to pool_id (legacy daily files)
    const nameIdx = idx.pool_name >= 0 ? idx.pool_name : idx.pool_id;
    const result = new Map();
    // Simple CSV parser — handles quoted fields with commas inside
    for (let i = 1; i < lines.length; i++) {
        const row = parseCsvRow(lines[i]);
        const addr = row[idx.pool_address];
        if (!addr) continue;
        result.set(addr, {
            pool_id:        (row[nameIdx] || '').replace(/"/g, ''),
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
        queryContract(TLA_GAUGE_CONTROLLER, { distributions: { time: "current" } }),
    ]);

    // COMPLETENESS GATE — these chain queries ARE the snapshot; a null is a query FAILURE
    // (vs [] = genuine empty). If any failed, do NOT continue: the `|| []` coercion below would
    // silently drop a whole bucket, `status` would still read 'ok' (it only watches sister-cron
    // input files), and at 23:xx that truncated capture is frozen into the PERMANENT daily archive
    // — irreversible. Aborting here means no publish, last-good stays, heartbeat goes stale → red.
    // Matches the documented failure contract (required source fails → fatal, no publish).
    {
        const core = { stableGauge, projectGauge, bluechipGauge, singleGauge, stableStaked, projectStaked, bluechipStaked, singleStaked, distributions };
        const failed = Object.entries(core).filter(([, v]) => v === null).map(([k]) => k);
        if (failed.length) {
            console.error(`❌ ABORT: core chain queries failed (returned null): ${failed.join(', ')}.`);
            console.error('   NOT publishing — a partial capture would corrupt the rolling snapshot and the permanent archive. Last-good stays; rerun when LCDs are healthy.');
            process.exit(2);
        }
    }

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
        } else if (resolved.lpDenom) {
            // Try to resolve the denom to a proper symbol via TokenResolver
            // (handles IBC → registry, factory → suffix)
            const tokenInfo = await ctx.tokenResolver.resolve({ native_token: { denom: resolved.lpDenom } });
            if (tokenInfo?.symbol) {
                name = tokenInfo.symbol;
            } else if (resolved.lpDenom.startsWith('ibc/')) {
                name = 'Single:' + resolved.lpDenom.slice(0, 30);
            } else {
                name = resolved.lpDenom.slice(0, 30);
            }
        }
        dex = 'Single';
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
                lpHealth = await buildLpHealth(poolData, ctx.priceResolver, ctx.tokenResolver);
                // Register reserves so price-derivation can use them for other pools
                if (lpHealth._basics) {
                    ctx.priceResolver.registerPoolReserves(name, lpHealth._basics[0], lpHealth._basics[1]);
                    delete lpHealth._basics;  // strip internal field before output
                }
            }
        } catch (e) {
            // Skip — pool might be on a chain other than terra (e.g. neutron-only)
        }
    }

    // Staked-in-TLA USD value calculation — two paths:
    //   1. LP-pair pools: staked_lp_tokens × (lp_pool_total_value / lp_pool_total_share)
    //   2. Single-sided pools: staked_token_amount × token_price (no LP math)
    let stakedInTlaUsd = null;
    if (stakedEntry) {
        if (lpHealth?.total_pool_usd && lpHealth.total_share) {
            // LP-pair path
            const stakedLpAmount = parseFloat(stakedEntry.asset.amount);
            const lpUnitValue = lpHealth.total_pool_usd / parseFloat(lpHealth.total_share);
            stakedInTlaUsd = stakedLpAmount * lpUnitValue;
        } else if (resolved.isSingle) {
            // Single-sided path: query token decimals + price
            // For factory tokens, the symbol is at the end of the denom path
            const denom = resolved.lpDenom;
            if (denom) {
                const tokenInfo = await ctx.tokenResolver.resolve({ native_token: { denom } });
                if (tokenInfo.symbol) {
                    const priceInfo = ctx.priceResolver.resolvePrice(tokenInfo.symbol);
                    if (priceInfo.price) {
                        const rawAmount = parseFloat(stakedEntry.asset.amount);
                        const humanAmount = rawAmount / Math.pow(10, tokenInfo.decimals);
                        stakedInTlaUsd = humanAmount * priceInfo.price;
                    }
                }
            }
        }
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

// =============================================================================
// TOKEN RESOLVER — dynamic, on-chain truth
// =============================================================================
//
// Strategy:
//   • cw20 tokens (terra1...)   → `token_info` query  →  canonical symbol + decimals
//   • IBC denoms (ibc/HASH...)  → IBC_REGISTRY lookup (hardcoded — see below)
//   • Native (uluna)            → hardcoded
//   • Factory (factory/...)     → parse symbol from path, assume 6 decimals
//
// Why IBC needs a hardcoded registry: `denom_traces` returns base_denoms in
// wildly inconsistent formats (`inj`, `ueure`, `0x2260...`, `factory/.../fuel`)
// that can't be normalized to price-feed symbols without per-token knowledge.
// Better to be explicit.
//
// Why cw20 auto-discovers: cw20s have a canonical `token_info` query that
// returns `{ symbol, decimals }`. New project tokens added to TLA will work
// automatically without code changes — this is the common path.
//
// Adding a new IBC-bridged token (rare event, e.g. new LST integration):
//   1. Add entry to IBC_REGISTRY below
//   2. Add the price source in network-and-prices cron
//
// Adding a new cw20 token (common event, e.g. new project votes):
//   ZERO code changes — token_info query handles it automatically.
//   Just ensure the price is in network-and-prices (or it'll show $0).
//
// Results are cached within a single cron run.
// =============================================================================

// IBC token registry — authoritative for IBC-bridged tokens on Terra.
// Decimals are the TERRA-SIDE decimals (after IBC bridging normalizes them).
// Most Terra IBC denoms are 6 decimals regardless of source chain.
// Exception: PAXG, WBTC, ETH, WSTETH, BNB are 18/8 on Terra too.
const IBC_REGISTRY = {
    'ibc/2C962DAB9F57FE0921435426AE75196009FAA1981BF86991203C8411F8980FDB':  { symbol: 'USDC',     decimals: 6  },
    'ibc/9B19062D46CAB50361CE9B0A3E6D0A7A53AC9E7CB361F32A73CC733144A9A9E5':  { symbol: 'USDT',     decimals: 6  },
    'ibc/88386AC48152D48B34B082648DF836F975506F0B57DBBFC10A54213B1BF484CB':  { symbol: 'WBTC',     decimals: 8  },
    'ibc/0EF5630576C66968EF0787868CF09FD866FAD131BC148D24A148358A85F0EB62':  { symbol: 'PAXG',     decimals: 18 },
    'ibc/8D52B251B447B7160421ACFBD50F6B0ABE5F98D2C404B03701130F12044439A1':  { symbol: 'EURE',     decimals: 6  },
    'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2':  { symbol: 'ATOM',     decimals: 6  },
    'ibc/20850C646CDDDC2270E9BBDB08558B5FEE57B647EC6827F41096AABFD8A0471B':  { symbol: 'ETH',      decimals: 18 },
    'ibc/A356EC90DC3AE43D485514DA7260EDC7ABB5CFAA0654CE2524C739392975AD3C':  { symbol: 'WSTETH',   decimals: 18 },
    'ibc/1319C6B38CA613C89D78C2D1461B305038B1085F6855E8CD276FE3F7C9600B4C':  { symbol: 'BNB',      decimals: 18 },
    'ibc/4B44179AC2F0BEE50C16A673B3B886398988692885B2848A1C8AEF27148B3961':  { symbol: 'FUEL',     decimals: 6  },
    'ibc/B3F639855EE7478750CC8F82072307ED6E131A8EFF20345E1D136B50C4E5EC36':  { symbol: 'ampWHALE', decimals: 6  },
    'ibc/36A02FFC4E74DF4F64305130C3DFA1B06BEAC775648927AA44467C76A77AB8DB':  { symbol: 'WHALE',    decimals: 6  },
    // Additions discovered May 2026:
    'ibc/08095CEDEA29977C9DD0CE9A48329FDA622C183359D5F90CF04CC4FF80CBE431':  { symbol: 'stLUNA',   decimals: 6  },
    'ibc/8D8A7F7253615E5F76CB6252A1E1BD921D5EDB7BBAAF8913FB1C77FF125D9995':  { symbol: 'ASTRO',    decimals: 6  },
    'ibc/792AAE6279F4709F66068E29A79E6F16BBC0A9B93561A91FC040606793E62D6B':  { symbol: 'SWTH',     decimals: 8  },
    'ibc/05D299885B07905B6886F554B39346EA6761246076A1120B1950049B92B922DD':  { symbol: 'WBTC',     decimals: 8  },   // wbtc-satoshi variant
    'ibc/25BC59386BB65725F735EFC0C369BB717AA8B5DAD846EAF9CBF5D0F18F207211':  { symbol: 'INJ',      decimals: 18 },
    'ibc/CF57A83CED6CEC7D706631B5DC53ABC21B7EDA7DF7490732B4361E6D5DD19C73':  { symbol: 'WBTC',     decimals: 8  },   // osmo WBTC factory
    'ibc/223FF539430381ADAB3A66AC4822E253C3F845E9841F17FEEC207B3AA9F8D915':  { symbol: 'dATOM',    decimals: 6  },   // neutron drop ATOM
    'ibc/BC8A77AFBD872FDC32A348D3FB10CC09277C266CFE52081DE341C7EC6752E674':  { symbol: 'WETH',     decimals: 18 },
    'ibc/517E13F14A1245D4DE8CF467ADD4DA0058974CDCC880FA6AE536DBCA1D16D84E':  { symbol: 'bWHALE',   decimals: 6  },   // migaloo bone WHALE
    'ibc/0E90026619DD296AD4EF9546396F292B465BAB6B5BE00ABD6162AA1CE8E68098':  { symbol: 'rSWTH',    decimals: 8  },
    'ibc/FD9DBF0DB4D301313195159303811FD2FD72185C4B11A51659EFCD49D7FF1228':  { symbol: 'stATOM',   decimals: 6  },
    'ibc/65B3EB6263482979FD7A80E3FFB9D0C85CFBF6DB63EB8DDE918B2984A40CEAB6':  { symbol: 'xASTRO',   decimals: 6  },   // Neutron channel-229
    // Add new IBC tokens here as TLA adopts them.
    // Easy to discover the hash: query `gauge_infos` and look at any unfamiliar `ibc/...` entries.
    // For decimals: most are 6; check the source chain if unsure (ETH/EVM-derived = 18, BTC-derived = 8).
};

class TokenResolver {
    constructor(queryContractFn) {
        this.queryContract = queryContractFn;
        this.cache = new Map();      // key (denom or cw20:addr) → { symbol, decimals }
        this.stats = { hits: 0, queries: 0, ibc_known: 0, ibc_unknown: 0, factory: 0, failures: 0 };
    }

    // Get { symbol, decimals } for a pool asset info object.
    async resolve(assetInfo) {
        if (assetInfo?.native_token?.denom) {
            return await this._resolveDenom(assetInfo.native_token.denom);
        }
        if (assetInfo?.token?.contract_addr) {
            return await this._resolveCw20(assetInfo.token.contract_addr);
        }
        return { symbol: null, decimals: 6 };
    }

    async _resolveDenom(denom) {
        if (this.cache.has(denom)) {
            this.stats.hits++;
            return this.cache.get(denom);
        }

        let result;

        if (denom === 'uluna') {
            result = { symbol: 'LUNA', decimals: 6 };
        }
        else if (denom.startsWith('ibc/')) {
            if (IBC_REGISTRY[denom]) {
                result = IBC_REGISTRY[denom];
                this.stats.ibc_known++;
            } else {
                // Unknown IBC — leave as null so it shows up clearly in output
                result = { symbol: null, decimals: 6, _unknown_ibc: denom };
                this.stats.ibc_unknown++;
            }
        }
        else if (denom.startsWith('factory/')) {
            // Factory denoms: factory/<contract>/<symbol or uLP>
            const parts = denom.split('/');
            const suffix = parts[parts.length - 1];
            result = {
                symbol: suffix === 'uLP' ? null : suffix,
                decimals: 6,  // Factory tokens on Terra are virtually always 6
            };
            this.stats.factory++;
        }
        else if (denom.startsWith('u') && denom.length <= 8) {
            // Cosmos convention (uusd, uatom, uosmo, ueure)
            result = { symbol: denom.slice(1).toUpperCase(), decimals: 6 };
        }
        else {
            result = { symbol: null, decimals: 6 };
            this.stats.failures++;
        }

        this.cache.set(denom, result);
        return result;
    }

    async _resolveCw20(contractAddr) {
        const key = `cw20:${contractAddr}`;
        if (this.cache.has(key)) {
            this.stats.hits++;
            return this.cache.get(key);
        }

        let result;
        try {
            const info = await this.queryContract(contractAddr, { token_info: {} });
            this.stats.queries++;
            if (info?.symbol) {
                result = { symbol: info.symbol, decimals: info.decimals ?? 6 };
            } else {
                result = { symbol: null, decimals: 6 };
                this.stats.failures++;
            }
        } catch (e) {
            result = { symbol: null, decimals: 6, _query_failed: true };
            this.stats.failures++;
        }

        this.cache.set(key, result);
        return result;
    }

    printStats(logger = console.log) {
        const s = this.stats;
        const total = s.hits + s.queries + s.ibc_known + s.ibc_unknown + s.factory;
        logger(`  Token resolver: ${total} lookups (${s.queries} cw20 queries, ${s.hits} cached, ${s.ibc_known} IBC known, ${s.ibc_unknown} IBC unknown, ${s.factory} factory)`);
        if (s.ibc_unknown > 0) {
            const unknowns = [...this.cache.entries()].filter(([k, v]) => v._unknown_ibc).map(([k]) => k);
            logger(`  ⚠ Unknown IBC denoms (add to IBC_REGISTRY if needed):`);
            for (const u of unknowns) logger(`    ${u}`);
        }
    }
}

// =============================================================================
// PRICE RESOLVER — fully-auto multi-stage price discovery
// =============================================================================
//
// Resolution chain (priority order, first hit wins):
//
//   1. DIRECT          — network-and-prices.token_prices[SYMBOL]
//      The best case: token has an authoritative external price source.
//
//   2. LST RATIO       — network-and-prices.lst_ratios[SYMBOL]
//      For LSTs (ampLUNA, arbLUNA, bLUNA, ampROAR, ampCAPA, xASTRO, etc.):
//      derived_price = on-chain hub ratio × price(base_token)
//      Example: arbLUNA = 2.907 × LUNA_price
//      Recurses through base_token resolution.
//
//   3. POOL-DERIVED    — find a TLA pool containing this token paired with
//      a token we CAN price; compute price from reserves ratio.
//      Example: FUEL price = (LUNA_amount × LUNA_price) / FUEL_amount
//      This makes the cron self-sufficient for any new token added to TLA.
//
//   4. UNKNOWN — return null, log warning.
//
// This means adding a new token to TLA requires ZERO code changes — the
// cron auto-discovers symbol+decimals (cw20 token_info), then auto-derives
// price from the pool itself if it's not in network-and-prices.
// =============================================================================

class PriceResolver {
    constructor(tokenPrices, lstRatios) {
        // Build case-insensitive index — TLA tokens come in mixed case
        // (e.g. chain says "stLUNA", network-and-prices stores "STLUNA")
        this.tokenPrices = tokenPrices || {};
        this.lstRatios = lstRatios || {};
        this.priceByLower = new Map();
        for (const [k, v] of Object.entries(this.tokenPrices)) {
            this.priceByLower.set(k.toLowerCase(), v);
        }
        this.lstByLower = new Map();
        for (const [k, v] of Object.entries(this.lstRatios)) {
            this.lstByLower.set(k.toLowerCase(), { ...v, _key: k });
        }
        this.derivedFromPool = new Map();
        this.poolReserves = [];
        this.cache = new Map();
        this.stats = { direct: 0, lst: 0, pool_derived: 0, failed: 0 };
    }

    // Register a pool's reserves so we can use it for price derivation later.
    registerPoolReserves(poolName, asset0, asset1) {
        if (!asset0 || !asset1 || !asset0.symbol || !asset1.symbol) return;
        if (!asset0.amount_human || !asset1.amount_human) return;
        this.poolReserves.push({
            pool_name: poolName,
            sym_0: asset0.symbol, amt_0: asset0.amount_human,
            sym_1: asset1.symbol, amt_1: asset1.amount_human,
        });
    }

    // Get USD price for a symbol. Case-insensitive lookup.
    resolvePrice(symbol, _recursionDepth = 0) {
        if (!symbol) return { price: null, source: 'no_symbol' };
        if (_recursionDepth > 3) return { price: null, source: 'recursion_limit' };

        const symLower = symbol.toLowerCase();
        if (this.cache.has(symLower)) {
            return this.cache.get(symLower);
        }

        let result;

        // Stage 1: DIRECT lookup (case-insensitive)
        const directEntry = this.priceByLower.get(symLower);
        if (directEntry?.final_price_usd && directEntry.final_price_usd > 0) {
            result = { price: directEntry.final_price_usd, source: 'direct' };
            this.stats.direct++;
            this.cache.set(symLower, result);
            return result;
        }

        // Stage 2: LST RATIO (case-insensitive)
        const lstEntry = this.lstByLower.get(symLower);
        if (lstEntry?.ratio && lstEntry?.base_token) {
            const base = this.resolvePrice(lstEntry.base_token, _recursionDepth + 1);
            if (base.price) {
                const derivedPrice = lstEntry.ratio * base.price;
                result = {
                    price: derivedPrice,
                    source: `lst_ratio:${lstEntry.base_token}×${lstEntry.ratio.toFixed(4)}`,
                };
                this.stats.lst++;
                this.cache.set(symLower, result);
                return result;
            }
        }
        if (lstEntry?.xastro_usd) {
            result = { price: lstEntry.xastro_usd, source: 'lst_explicit' };
            this.stats.direct++;
            this.cache.set(symLower, result);
            return result;
        }

        // Stage 3: POOL-DERIVED
        // Important: skip pools where BOTH sides are tokens with no other price source
        // to avoid circular derivation (e.g. deriving stLUNA from LUNA-stLUNA when
        // stLUNA appears only in that pool).
        for (const pool of this.poolReserves) {
            let pairedSym, pairedAmt, thisAmt;
            if (pool.sym_0?.toLowerCase() === symLower && pool.sym_1?.toLowerCase() !== symLower) {
                thisAmt = pool.amt_0; pairedSym = pool.sym_1; pairedAmt = pool.amt_1;
            } else if (pool.sym_1?.toLowerCase() === symLower && pool.sym_0?.toLowerCase() !== symLower) {
                thisAmt = pool.amt_1; pairedSym = pool.sym_0; pairedAmt = pool.amt_0;
            } else continue;

            if (!thisAmt || thisAmt === 0) continue;

            const pairedPrice = this.resolvePrice(pairedSym, _recursionDepth + 1);
            // Only trust pool-derivation if the paired token is DIRECTLY priced
            // (not transitively via another pool, which can create chains of error)
            if (pairedPrice.price && pairedPrice.source === 'direct') {
                const derivedPrice = (pairedAmt * pairedPrice.price) / thisAmt;
                result = {
                    price: derivedPrice,
                    source: `pool_derived:${pool.pool_name}(${pairedSym})`,
                };
                this.stats.pool_derived++;
                this.cache.set(symLower, result);
                return result;
            }
        }

        result = { price: null, source: 'unknown' };
        this.stats.failed++;
        this.cache.set(symLower, result);
        return result;
    }

    printStats(logger = console.log) {
        const s = this.stats;
        logger(`  Price resolver: ${s.direct} direct, ${s.lst} via LST ratio, ${s.pool_derived} pool-derived, ${s.failed} failed`);
        if (s.pool_derived > 0) {
            const derived = [...this.cache.entries()].filter(([_, v]) => v.source.startsWith('pool_derived'));
            for (const [sym, info] of derived) {
                logger(`    ✓ ${sym}: ${info.source} → $${info.price.toFixed(6)}`);
            }
        }
        if (s.lst > 0) {
            const lstDerived = [...this.cache.entries()].filter(([_, v]) => v.source.startsWith('lst_ratio'));
            for (const [sym, info] of lstDerived) {
                logger(`    ✓ ${sym}: ${info.source} → $${info.price.toFixed(6)}`);
            }
        }
    }
}

async function buildLpHealth(poolData, priceResolver, resolver) {
    const assets = poolData.assets;

    // First pass — resolve symbols + decimals + amounts (no prices yet)
    const assetBasics = await Promise.all(assets.map(async (a) => {
        const { symbol, decimals } = await resolver.resolve(a.info);
        const amount = parseFloat(a.amount) || 0;
        const amountHuman = amount / Math.pow(10, decimals);
        return { symbol, amount_raw: amount, amount_human: amountHuman, decimals };
    }));

    // Second pass — apply prices (might use info from this pool's other side)
    const assetDetails = assetBasics.map(b => {
        const { price, source } = priceResolver.resolvePrice(b.symbol);
        const usdValue = (price && b.amount_human) ? b.amount_human * price : null;
        return {
            symbol: b.symbol,
            amount_raw: b.amount_raw,
            amount_human: b.amount_human,
            decimals: b.decimals,
            usd_value: usdValue,
            price_usd: price,
            price_source: source,
        };
    });

    const totalUsd = assetDetails.reduce((s, a) => s + (a.usd_value || 0), 0);
    const balanceRatio = assetDetails.map(a => totalUsd > 0 && a.usd_value != null ? (a.usd_value / totalUsd) * 100 : null);

    return {
        asset_0: assetDetails[0],
        asset_1: assetDetails[1],
        balance_ratio_pct: balanceRatio,
        total_pool_usd: totalUsd > 0 ? totalUsd : null,
        total_share: poolData.total_share,
        _basics: assetBasics,  // expose for pool-derived registration
    };
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
// PHASE B: REWARDS MODEL
// -----------------------------------------------------------------------------
//
// Self-contained, pure-math, defensive computation. Reads:
//   • pools[].bucket
//   • pools[].gauge_pool_id  (matched against distributions for accuracy)
//   • pools[].voting_power.pct_of_bucket  (fallback if not in distributions)
//   • pools[].staked_in_tla_usd
//   • distributions  (live chain data: pools paying rewards in CURRENT epoch)
//   • lunaPriceUsd  (live from network-and-prices)
//
// Why use chain `distributions` over our own `pct_of_bucket`:
//   gauge_infos returns "next epoch" votes which may differ slightly from
//   "current epoch" (which is what Eris's $ figures use). Using distributions
//   directly avoids that drift and matches Eris exactly.
//
// Writes:
//   • pools[].rewards = { annual_emissions_luna, annual_emissions_usd,
//                         weekly_emissions_usd, approx_apr_pct,
//                         distribution_share_of_bucket, bucket_weight }
//   • byBucket[bucket].rewards = { annual_usd, weekly_usd, bucket_weight }
//   • totals.rewards = { annual_luna, annual_usd, weekly_usd, calibration }
//
// Wrapped in try/catch — any failure leaves snapshot intact without rewards.
//
function computeRewards(pools, byBucket, totals, lunaPriceUsd, distributions) {
    try {
        // Defensive: need LUNA price to compute USD values
        if (!lunaPriceUsd || lunaPriceUsd <= 0) {
            console.warn('  ⚠ Rewards: no LUNA price available, skipping rewards computation');
            return null;
        }

        // Build a lookup: gauge_pool_id → distribution_share (from chain's CURRENT epoch)
        // distributions is a list of { gauge, period, total_gauge_vp, assets: [{ asset, distribution, total_vp }] }
        // The "asset" object identifies the pool by cw20/native — same shape as gauge_pool_id
        const chainDistByPoolId = new Map();
        if (Array.isArray(distributions)) {
            for (const bucketDist of distributions) {
                for (const a of (bucketDist.assets || [])) {
                    // pool_id key matches what's in our gauge_pool_id (e.g. "cw20:terra1..." or "native:factory/...")
                    const key = a.asset?.cw20 ? `cw20:${a.asset.cw20}`
                              : a.asset?.native ? `native:${a.asset.native}`
                              : null;
                    if (key && a.distribution) {
                        chainDistByPoolId.set(key, parseFloat(a.distribution));
                    }
                }
            }
        }

        // Total TLA annual emission (calibrated constant × live LUNA price)
        const totalAnnualLuna = TLA_LUNA_EMISSIONS_PER_YEAR;
        const totalAnnualUsd  = totalAnnualLuna * lunaPriceUsd;

        // Per-bucket allocations
        // TLA_ALLIANCE_WEIGHTS sums to 0.25 (TLA's 25% share of all Alliance rewards).
        // Within TLA, normalize so they sum to 1.0 — that's each bucket's share OF TLA's emissions.
        const tlaShareTotal = Object.values(TLA_ALLIANCE_WEIGHTS).reduce((a, b) => a + b, 0);
        const bucketShareOfTla = {};
        for (const [bucket, weight] of Object.entries(TLA_ALLIANCE_WEIGHTS)) {
            bucketShareOfTla[bucket] = weight / tlaShareTotal;
        }

        // Per-bucket reward $/year and $/week
        for (const bucket of BUCKETS) {
            const share = bucketShareOfTla[bucket] || 0;
            const annualUsd = totalAnnualUsd * share;
            if (byBucket[bucket]) {
                byBucket[bucket].rewards = {
                    bucket_weight_of_tla:        share,
                    bucket_weight_of_alliance:   TLA_ALLIANCE_WEIGHTS[bucket] || 0,
                    annual_rewards_usd:          annualUsd,
                    weekly_rewards_usd:          annualUsd / EPOCHS_PER_YEAR,
                };
            }
        }

        // Per-pool rewards
        let computedCount = 0;
        let fromChainDistCount = 0;
        let fromGaugeInfosCount = 0;

        for (const pool of pools) {
            try {
                const bucket = pool.bucket;
                if (!bucket || !TLA_ALLIANCE_WEIGHTS[bucket]) continue;

                // Prefer chain distributions (current epoch — what Eris uses), fallback to gauge_infos pct
                let distShare = chainDistByPoolId.get(pool.gauge_pool_id);
                let distSource;
                if (distShare != null) {
                    distSource = 'chain_distributions_current';
                    fromChainDistCount++;
                } else {
                    // Fallback to gauge_infos pct (this pool isn't in distributions — likely below 1%)
                    const pctOfBucket = pool.voting_power?.pct_of_bucket;
                    if (pctOfBucket == null || pctOfBucket <= 0) {
                        // Pool has no VP — no rewards
                        pool.rewards = {
                            annual_emissions_luna:        0,
                            annual_emissions_usd:         0,
                            weekly_emissions_usd:         0,
                            approx_apr_pct:               null,
                            distribution_share_of_bucket: 0,
                            bucket_weight_of_tla:         bucketShareOfTla[bucket],
                            source:                       'no_vp',
                        };
                        continue;
                    }
                    distShare = pctOfBucket / 100;
                    distSource = 'gauge_infos_next_fallback';
                    fromGaugeInfosCount++;
                }

                const bucketShare = bucketShareOfTla[bucket];
                const annualLuna = totalAnnualLuna * bucketShare * distShare;
                const annualUsd  = annualLuna * lunaPriceUsd;
                const weeklyUsd  = annualUsd / EPOCHS_PER_YEAR;

                // APR: rewards / staked × 100. Defensive against zero/null staked.
                let apr = null;
                const staked = pool.staked_in_tla_usd;
                if (staked && staked > 0) {
                    apr = (annualUsd / staked) * 100;
                }

                pool.rewards = {
                    annual_emissions_luna:        annualLuna,
                    annual_emissions_usd:         annualUsd,
                    weekly_emissions_usd:         weeklyUsd,
                    approx_apr_pct:               apr,
                    distribution_share_of_bucket: distShare,
                    bucket_weight_of_tla:         bucketShare,
                    source:                       distSource,
                };
                computedCount++;
            } catch (poolErr) {
                // If one pool blows up, leave it without rewards and continue
                console.warn(`  ⚠ Rewards: skipping ${pool.name || pool.gauge_pool_id} (${poolErr.message})`);
            }
        }

        // Top-level rewards summary
        totals.rewards = {
            annual_emissions_luna: totalAnnualLuna,
            annual_emissions_usd:  totalAnnualUsd,
            weekly_emissions_usd:  totalAnnualUsd / EPOCHS_PER_YEAR,
            luna_price_used:       lunaPriceUsd,
            pools_with_rewards:    computedCount,
            pools_from_chain_dist: fromChainDistCount,
            pools_from_gauge_infos_fallback: fromGaugeInfosCount,
            calibration: {
                calibrated_at:   REWARDS_CALIBRATION_DATE,
                source:          'Terra block explorer Alliance Assets page',
                tla_alliance_weights: TLA_ALLIANCE_WEIGHTS,
                tla_total_alliance_share: tlaShareTotal,
                bucket_share_of_tla:  bucketShareOfTla,
                _note: 'Update TLA_ALLIANCE_WEIGHTS and TLA_LUNA_EMISSIONS_PER_YEAR constants if Alliance governance changes weights. Health page will flag drift between this model and Eris UI.',
            },
        };

        // Log a summary for the cron log
        console.log(`  ✓ Rewards: $${totalAnnualUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}/year total ` +
                    `across ${computedCount} pools (${fromChainDistCount} chain-dist, ${fromGaugeInfosCount} fallback)  ` +
                    `(stable $${(totalAnnualUsd * bucketShareOfTla.stable).toLocaleString('en-US', { maximumFractionDigits: 0 })}, ` +
                    `project $${(totalAnnualUsd * bucketShareOfTla.project).toLocaleString('en-US', { maximumFractionDigits: 0 })}, ` +
                    `bluechip $${(totalAnnualUsd * bucketShareOfTla.bluechip).toLocaleString('en-US', { maximumFractionDigits: 0 })}, ` +
                    `single $${(totalAnnualUsd * bucketShareOfTla.single).toLocaleString('en-US', { maximumFractionDigits: 0 })})`);

        return totals.rewards;
    } catch (e) {
        // Top-level guard — if anything goes wrong, leave the snapshot without rewards
        console.warn(`  ⚠ Rewards computation failed (${e.message}) — snapshot continues without rewards data`);
        return null;
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

// =============================================================================
// DATA FRESHNESS MONITORING
// =============================================================================
//
// Detects upstream-stuck or chain-stuck failures. TLA-snapshot is an aggregator
// of votion, bribes, astroport, ss, and network-and-prices PLUS live chain
// queries. If everything froze at once (warlock-style), per-pool values would
// be identical across runs.
//
// Fingerprint contents per pool: name + voting_power.vp + depth_usd +
// staked_in_tla_usd — the three most-volatile signals that combine upstream
// data with chain state. Plus aggregate totals as a quick top-line check.
//
// Hourly cadence + 3-run threshold means stuck detection within ~3 hours of
// a total-system freeze.

const STUCK_THRESHOLD = 3;  // 3+ identical consecutive runs → 'stuck'

function computeDataFingerprint(snapshot) {
    const items = [];
    const pools = snapshot.pools || [];
    for (const p of pools) {
        items.push([
            p.name || p.pool_address || '?',
            p.voting_power?.vp ?? null,
            p.depth_usd ?? null,
            p.staked_in_tla_usd ?? null,
        ]);
    }
    items.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const input = JSON.stringify({
        pools: items,
        tla_tvl_usd:        snapshot.totals?.tla_tvl_usd ?? null,
        depth_total:        snapshot.totals?.depth_usd_total ?? null,
        active_pools_count: snapshot.totals?.active_pools_count ?? null,
    });
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

// Fetch our own previous heartbeat — graceful failure (returns null).
async function fetchPreviousHeartbeat() {
    try {
        const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/data/heartbeat.json`;
        return await fetchJson(url, 'previous-heartbeat');
    } catch (e) {
        console.log(`   [freshness] no previous heartbeat available (${(e.message || '').slice(0, 60)})`);
        return null;
    }
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
    const tokenResolver = new TokenResolver(queryContract);
    const priceResolver = new PriceResolver(tokenPrices, lstRatios);
    const enrichCtx = {
        astroportByPool: catalog.astroportByPool,
        stakedByAssetKey: catalog.stakedByAssetKey,
        ssByAddress,
        tokenPrices,
        lstRatios,
        tokenResolver,
        priceResolver,
    };

    // ── PASS 1 — enrich all pools (this populates priceResolver.poolReserves) ──
    // During this pass, pool-derived prices CANNOT yet help — they only become
    // available after all pools have registered their reserves.
    let pools = [];
    const BATCH = 6;
    for (let i = 0; i < catalog.resolved.length; i += BATCH) {
        const batch = catalog.resolved.slice(i, i + BATCH);
        const enriched = await Promise.all(batch.map(e => enrichPool(e, enrichCtx)));
        pools.push(...enriched.filter(Boolean));
    }
    console.log(`  ✓ Pass 1: enriched ${pools.length} pools (discovering reserves)`);

    // ── PASS 2 — re-enrich pools that had unpriced sides ──
    // Now that priceResolver has all pool reserves, it can derive prices for
    // tokens whose only source was the pool they live in (e.g. FUEL via LUNA-FUEL).
    // We clear priceResolver's cache so the new pool-derived path is consulted.
    priceResolver.cache.clear();
    priceResolver.stats = { direct: 0, lst: 0, pool_derived: 0, failed: 0 };

    // Find pools that had at least one null-priced asset OR null TVL — those need re-run
    const needsRefresh = pools.filter(p => {
        if (p.staked_in_tla_usd == null && p.sources?.in_staking_contract) return true;
        if (p.lp_health) {
            const a0 = p.lp_health.asset_0;
            const a1 = p.lp_health.asset_1;
            if ((a0?.symbol && a0?.usd_value == null) || (a1?.symbol && a1?.usd_value == null)) return true;
        }
        return false;
    });
    console.log(`  Pass 2: re-enriching ${needsRefresh.length} pools that need price derivation...`);

    // Re-enrich just those pools (by reconstructing their resolved entries)
    if (needsRefresh.length > 0) {
        const poolNamesToRefresh = new Set(needsRefresh.map(p => p.name + '|' + (p.dex || '')));
        const entriesToRefresh = catalog.resolved.filter(e => {
            // We need to find the matching entry; easiest match is via the gauge_pool_id
            return needsRefresh.some(p => p.gauge_pool_id === e.poolId);
        });
        const refreshed = [];
        for (let i = 0; i < entriesToRefresh.length; i += BATCH) {
            const batch = entriesToRefresh.slice(i, i + BATCH);
            const enriched = await Promise.all(batch.map(e => enrichPool(e, enrichCtx)));
            refreshed.push(...enriched.filter(Boolean));
        }
        // Replace the corresponding pool entries
        for (const refreshedPool of refreshed) {
            const idx = pools.findIndex(p => p.gauge_pool_id === refreshedPool.gauge_pool_id);
            if (idx >= 0) pools[idx] = refreshedPool;
        }
    }

    tokenResolver.printStats(console.log);
    priceResolver.printStats(console.log);

    // Phase 6: bribes
    console.log('🎁 Attaching bribes...');
    attachBribes(pools, inputs.bribesCurrent, inputs.bribesHistory);

    // Phase 7: votion VP detail
    console.log('🗳️  Attaching votion VP detail...');
    attachVotionDetail(pools, inputs.votion);

    // Phase 8: rollups
    console.log('📊 Computing rollups...');
    const { totals, byBucket } = computeRollups(pools, catalog.bucketVps);

    // Phase B: rewards model (USD/year per pool, bucket, total)
    console.log('💰 Computing rewards model...');
    const lunaPriceUsd = tokenPrices?.LUNA?.final_price_usd || null;
    computeRewards(pools, byBucket, totals, lunaPriceUsd, chainState.distributions);

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
        const isEndOfDay = startedAt.getUTCHours() === 23;
        if (isEndOfDay) {
            await pushToGithub(`data/daily/${dateStr}.json`, content,
                `🏛️ Daily archive ${dateStr}`);
            console.log(`  ✓ End-of-day archive written`);
        } else {
            console.log(`  (skipping daily archive — only written at 23:xx UTC)`);
        }
        // Compute data fingerprint and check freshness vs previous run.
        // Catches whole-system stalls (warlock-style) — when all upstream sources
        // and chain queries return identical data across consecutive runs.
        console.log('🔍 Computing data fingerprint...');
        const dataFingerprint = computeDataFingerprint(snapshot);
        const prevHeartbeat = await fetchPreviousHeartbeat();
        const freshness = classifyFreshness(dataFingerprint, prevHeartbeat);
        const freshnessIcon = { fresh: '✓', suspicious: '⚠', stuck: '🔴' }[freshness.dataFreshness];
        console.log(`   fingerprint: ${dataFingerprint}  previous: ${freshness.previousFingerprint || '(none)'}`);
        console.log(`   ${freshnessIcon} dataFreshness: ${freshness.dataFreshness}` +
                    (freshness.consecutiveStuckRuns > 1
                        ? `  (${freshness.consecutiveStuckRuns} consecutive identical runs)`
                        : ''));

        // Heartbeat — uniform freshness contract across all crons
        const sourceFailures = Object.values(snapshot.sources || {}).filter(v => v === false).length;
        // Status escalation (worst wins): stuck > partial > ok
        let status;
        if (freshness.dataFreshness === 'stuck') status = 'stuck';
        else if (sourceFailures > 0)             status = 'partial';
        else                                     status = 'ok';

        const heartbeat = {
            schemaVersion: 1,
            cron: 'tla-snapshot',
            capturedAt: startedAt.toISOString(),
            capturedAtUnix: startedAt.getTime(),
            runId: `tla-${startedAt.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
            runMode: isEndOfDay ? 'hourly+daily-archive' : 'hourly',
            currentEpoch: epochInfo.currentEpoch,
            status,
            stats: {
                total_pools: (snapshot.pools || []).length,
                active_pools: totals.active_pools_count,
                voted_pools: totals.voted_pools_count,
                source_failures: sourceFailures,
            },
            // Freshness-monitoring fields (catches upstream/chain-frozen failures)
            dataFingerprint,
            previousFingerprint:  freshness.previousFingerprint,
            dataFreshness:        freshness.dataFreshness,
            consecutiveStuckRuns: freshness.consecutiveStuckRuns,
            next_expected_run_at: new Date(startedAt.getTime() + 60 * 60 * 1000).toISOString(),
        };
        await pushToGithub('data/heartbeat.json', JSON.stringify(heartbeat, null, 2),
            `📍 TLA snapshot heartbeat`);
    } else {
        console.log('\n⚠️  GITHUB_TOKEN not set — saving locally');
        fs.writeFileSync('tla-snapshot.json', content);
        // Compute fingerprint for local-save branch too (no remote previous to compare against)
        const dataFingerprint = computeDataFingerprint(snapshot);
        fs.writeFileSync('heartbeat.json', JSON.stringify({
            schemaVersion: 1, cron: 'tla-snapshot',
            capturedAt: startedAt.toISOString(), capturedAtUnix: startedAt.getTime(),
            runId: `tla-${startedAt.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
            runMode: 'hourly', currentEpoch: epochInfo.currentEpoch, status: 'ok',
            stats: { total_pools: (snapshot.pools || []).length, active_pools: totals.active_pools_count },
            // Freshness-monitoring fields (local-only, no comparison)
            dataFingerprint,
            previousFingerprint: null,
            dataFreshness: 'fresh',
            consecutiveStuckRuns: 0,
            next_expected_run_at: new Date(startedAt.getTime() + 60 * 60 * 1000).toISOString(),
        }, null, 2));
        console.log(`  Saved: tla-snapshot.json, heartbeat.json`);
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
