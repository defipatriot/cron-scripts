// =============================================================================
// tla-registry  —  Layer 0 (chain-native discovery + ecosystem catalog)  v2.0
// =============================================================================
//
// v1.0 (2026-06-01): 5 chain queries (global-config, asset-gauge, voting-escrow)
// v2.0 (2026-06-01): EXPANDED — full ecosystem catalog
//   - Adds asset-compounder.asset_configs query (amplp ↔ LP mapping)
//   - Pulls Cosmos Chain Registry assetlist for Terra2 (token metadata, IBC traces)
//   - Pulls Eris prices, Astroport REST, Skeleton Swap APIs (cross-source naming)
//   - Reads curated/*.json files from this same data repo
//   - Merges everything address-first into a unified catalog
//   - Computes confusion scoring + flags per token
//   - Surfaces _unmapped[] worklist for human curation
//
// FAULT TOLERANCE
//   - Both LCDs down → exit 1, no GitHub write, prior snapshot stays.
//   - Any external source (chain-registry, Eris, Astroport, SS) down →
//     recorded in source_errors but catalog still publishes with what
//     remaining sources provide. Status becomes 'partial'.
//   - Any curated/*.json file missing → cron continues without it.
//
// OUTPUT
//   defipatriot/tla-chain-registry/2026/current.json     ← merged catalog
//   defipatriot/tla-chain-registry/2026/heartbeat.json   ← freshness signal
//   defipatriot/tla-chain-registry/2026/daily/<date>.json ← daily archive
// =============================================================================

const https = require('https');
const crypto = require('crypto');

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------

const TERRA_LCD_PRIMARY  = process.env.TERRA_LCD_PRIMARY  || 'https://terra-lcd.publicnode.com';
const TERRA_LCD_FALLBACK = process.env.TERRA_LCD_FALLBACK || 'https://terra-rest.publicnode.com';
const GLOBAL_CONFIG_ADDR = process.env.GLOBAL_CONFIG_ADDR || 'terra1hwxg6s732eparz3ys7sa4t5f64ngpd2w8syrca6z7ckv3fs9uqnsvrpcqa';

const URL_COSMOS_CHAIN_REGISTRY_TERRA2 = 'https://raw.githubusercontent.com/cosmos/chain-registry/master/terra2/assetlist.json';
const URL_ERIS_PRICES   = 'https://backend.erisprotocol.com/prices';
const URL_ASTROPORT     = 'https://app.astroport.fi/api/pools?chainId=phoenix-1';
const URL_SKELETONSWAP  = 'https://dex.warlock.backbonelabs.io/api/pools/phoenix-1';

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/tla-chain-registry';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

const CURATED_BASE_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/curated`;

const HTTP_TIMEOUT_MS = 20000;
const MAX_RUNTIME_MS  = 5 * 60 * 1000;

const SCHEMA_VERSION = 2;
const CRON_NAME      = 'tla-registry';

// -----------------------------------------------------------------------------
// HTTP HELPERS
// -----------------------------------------------------------------------------

async function fetchJson(url, label, timeoutMs = HTTP_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json', 'User-Agent': 'tla-registry/2.0' },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${body.slice(0, 100)}`);
        }
        return await res.json();
    } catch (e) {
        if (e.name === 'AbortError') throw new Error(`Timeout (${label})`);
        throw e;
    } finally { clearTimeout(timeout); }
}

function encodeQuery(q) { return Buffer.from(JSON.stringify(q)).toString('base64'); }

async function queryContract(contractAddr, query, label) {
    const qb = encodeQuery(query);
    const path = `/cosmwasm/wasm/v1/contract/${contractAddr}/smart/${qb}`;
    const qLabel = label || `${contractAddr.slice(0,12)} ${JSON.stringify(query).slice(0,40)}`;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const r = await fetchJson(TERRA_LCD_PRIMARY + path, `${qLabel} (primary try ${attempt})`);
            return r.data;
        } catch (e) {
            if (attempt < 2) await new Promise(res => setTimeout(res, 200 + Math.random() * 300));
            else console.warn(`  ⚠ primary failed: ${e.message}`);
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

async function tryFetchJson(url, label) {
    try { return await fetchJson(url, label); }
    catch (e) {
        console.warn(`  ⚠ ${label} failed: ${e.message}`);
        return null;
    }
}

// -----------------------------------------------------------------------------
// GITHUB PUSH
// -----------------------------------------------------------------------------

function githubApiRequest(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.github.com', path: apiPath, method,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent': 'tla-registry/2.0',
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
        message, content: Buffer.from(content).toString('base64'),
        branch: GITHUB_BRANCH, ...(sha ? { sha } : {}),
    };
    const result = await githubApiRequest('PUT', apiPath, body);
    if (result.status === 200 || result.status === 201) {
        console.log(`  ✅ ${filepath}`);
        return true;
    }
    console.error(`  ❌ ${filepath} push failed (HTTP ${result.status}): ${result.data?.message || '<no message>'}`);
    return false;
}

// -----------------------------------------------------------------------------
// CHAIN QUERIES
// -----------------------------------------------------------------------------

async function captureChainRegistry() {
    const startedAt = new Date();
    const errors = [];

    console.log(`\n🔗 TLA Registry — Layer 0 v2`);
    console.log(`   Started: ${startedAt.toISOString()}`);
    console.log(`   Bootstrap: ${GLOBAL_CONFIG_ADDR}\n`);

    // Q1
    console.log('📋 Q1: global-config.all_addresses');
    const allAddressesRaw = await queryContract(GLOBAL_CONFIG_ADDR, { all_addresses: {} }, 'global-config.all_addresses');
    if (!allAddressesRaw) {
        throw new Error('global-config.all_addresses returned null — both LCDs failed. Aborting.');
    }
    console.log('   ✓ received');

    const directory = {};
    if (Array.isArray(allAddressesRaw)) {
        for (const item of allAddressesRaw) {
            if (Array.isArray(item) && item.length >= 2) directory[item[0]] = item[1];
            else if (item && typeof item === 'object' && item.role) directory[item.role] = item.address;
        }
    } else if (allAddressesRaw && typeof allAddressesRaw === 'object') {
        Object.assign(directory, allAddressesRaw);
    }
    console.log(`   parsed ${Object.keys(directory).length} role→address entries`);

    const assetGaugeAddr = directory.ASSET_GAUGE || directory.asset_gauge || directory['asset-gauge'];
    const votingEscrowAddr = directory.VOTING_ESCROW || directory.voting_escrow || directory['voting-escrow'];
    const assetCompounderAddr = directory.ASSET_COMPOUNDING || directory.ASSET_COMPOUNDER || directory.asset_compounder
        || 'terra1zly98gvcec54m3caxlqexce7rus6rzgplz7eketsdz7nh750h2rqvu8uzx';

    if (!assetGaugeAddr) errors.push({ query: 'derive ASSET_GAUGE', error: 'not in directory' });

    // Q2
    let distributionsRaw = null;
    if (assetGaugeAddr) {
        console.log('\n📊 Q2: asset-gauge.distributions');
        distributionsRaw = await queryContract(assetGaugeAddr, { distributions: {} }, 'asset-gauge.distributions');
        if (!distributionsRaw) errors.push({ query: 'asset-gauge.distributions', error: 'returned null' });
        else console.log('   ✓ received');
    }

    const pools = [];
    const buckets = {};
    if (distributionsRaw && Array.isArray(distributionsRaw)) {
        for (const gaugeEntry of distributionsRaw) {
            let gaugeName, gaugeData;
            if (Array.isArray(gaugeEntry) && gaugeEntry.length >= 2) { gaugeName = gaugeEntry[0]; gaugeData = gaugeEntry[1]; }
            else if (gaugeEntry && typeof gaugeEntry === 'object') {
                gaugeName = gaugeEntry.gauge || gaugeEntry.bucket || gaugeEntry.name;
                gaugeData = gaugeEntry;
            }
            if (!gaugeName || !gaugeData) continue;
            const dists = gaugeData.assets || gaugeData.distribution || gaugeData.distributions || [];
            buckets[gaugeName] = { total_gauge_vp: gaugeData.total_gauge_vp || gaugeData.total_vp || null, pool_count: 0 };
            for (const d of (Array.isArray(dists) ? dists : [])) {
                const asset = d.asset || d[0];
                const distribution = d.distribution ?? d[1] ?? null;
                const total_vp = d.total_vp ?? d[2] ?? null;
                if (!asset) continue;
                const gaugePoolId = asset.cw20 ? `cw20:${asset.cw20}`
                    : asset.native ? `native:${asset.native}` : `unknown:${JSON.stringify(asset)}`;
                pools.push({
                    gauge_pool_id: gaugePoolId, bucket: gaugeName, asset_raw: asset,
                    distribution_pct: distribution != null ? Number(distribution) : null,
                    total_vp: total_vp != null ? String(total_vp) : null,
                });
                buckets[gaugeName].pool_count++;
            }
        }
        console.log(`   parsed ${pools.length} pools across ${Object.keys(buckets).length} buckets`);
    }

    // Q3
    let canonicalEpoch = null;
    let lastDistributionPeriodRaw = null;
    if (assetGaugeAddr) {
        console.log('\n📅 Q3: asset-gauge.last_distribution_period');
        lastDistributionPeriodRaw = await queryContract(assetGaugeAddr, { last_distribution_period: {} }, 'asset-gauge.last_distribution_period');
        if (lastDistributionPeriodRaw == null) errors.push({ query: 'asset-gauge.last_distribution_period', error: 'returned null' });
        else {
            canonicalEpoch = typeof lastDistributionPeriodRaw === 'number' ? lastDistributionPeriodRaw
                : (lastDistributionPeriodRaw.period ?? lastDistributionPeriodRaw);
            console.log(`   ✓ canonical epoch = ${canonicalEpoch}`);
        }
    }

    // Q4
    let gaugeConfigRaw = null;
    if (assetGaugeAddr) {
        console.log('\n⚙️  Q4: asset-gauge.config');
        gaugeConfigRaw = await queryContract(assetGaugeAddr, { config: {} }, 'asset-gauge.config');
        if (!gaugeConfigRaw) errors.push({ query: 'asset-gauge.config', error: 'returned null' });
        else console.log('   ✓ received');
    }

    // Q5
    let numTokensRaw = null;
    if (votingEscrowAddr) {
        console.log('\n🔒 Q5: voting-escrow.num_tokens');
        numTokensRaw = await queryContract(votingEscrowAddr, { num_tokens: {} }, 'voting-escrow.num_tokens');
        if (numTokensRaw == null) errors.push({ query: 'voting-escrow.num_tokens', error: 'returned null' });
        else {
            const n = typeof numTokensRaw === 'number' ? numTokensRaw : (numTokensRaw.count ?? numTokensRaw);
            console.log(`   ✓ ${n} veLUNA locks`);
        }
    }

    // Q6 — NEW: amplp ↔ LP mapping
    let assetConfigsRaw = null;
    if (assetCompounderAddr) {
        console.log('\n💰 Q6: asset-compounder.asset_configs');
        assetConfigsRaw = await queryContract(assetCompounderAddr, { asset_configs: {} }, 'asset-compounder.asset_configs');
        if (!assetConfigsRaw) errors.push({ query: 'asset-compounder.asset_configs', error: 'returned null' });
        else {
            const n = Array.isArray(assetConfigsRaw) ? assetConfigsRaw.length : 'object';
            console.log(`   ✓ received (${n} vaults)`);
        }
    }

    return {
        startedAt, errors, canonicalEpoch, directory, pools, buckets,
        votingEscrowAddr, assetGaugeAddr, assetCompounderAddr,
        raw: {
            global_config_all_addresses: allAddressesRaw,
            asset_gauge_distributions: distributionsRaw,
            asset_gauge_last_distribution_period: lastDistributionPeriodRaw,
            asset_gauge_config: gaugeConfigRaw,
            voting_escrow_num_tokens: numTokensRaw,
            asset_compounder_asset_configs: assetConfigsRaw,
        },
    };
}

// -----------------------------------------------------------------------------
// EXTERNAL SOURCES
// -----------------------------------------------------------------------------

async function fetchExternalSources() {
    console.log('\n🌐 External sources (each optional, isolated failures)...');
    const sources = {
        cosmos_chain_registry: null, eris_prices: null,
        astroport_pools: null, skeletonswap_pools: null,
        source_errors: {},
    };

    console.log('   E1: Cosmos Chain Registry');
    sources.cosmos_chain_registry = await tryFetchJson(URL_COSMOS_CHAIN_REGISTRY_TERRA2, 'chain-registry');
    if (sources.cosmos_chain_registry) console.log(`      ✓ ${(sources.cosmos_chain_registry.assets || []).length} assets`);
    else sources.source_errors.cosmos_chain_registry = 'fetch failed';

    console.log('   E2: Eris prices');
    sources.eris_prices = await tryFetchJson(URL_ERIS_PRICES, 'eris-prices');
    if (sources.eris_prices) console.log(`      ✓ ${Object.keys(sources.eris_prices).length} entries`);
    else sources.source_errors.eris_prices = 'fetch failed';

    console.log('   E3: Astroport REST');
    sources.astroport_pools = await tryFetchJson(URL_ASTROPORT, 'astroport-pools');
    if (sources.astroport_pools) {
        const n = Array.isArray(sources.astroport_pools) ? sources.astroport_pools.length
            : (sources.astroport_pools.pools || []).length;
        console.log(`      ✓ ${n} pools`);
    } else sources.source_errors.astroport_pools = 'fetch failed';

    console.log('   E4: Skeleton Swap');
    sources.skeletonswap_pools = await tryFetchJson(URL_SKELETONSWAP, 'ss-pools');
    if (sources.skeletonswap_pools) {
        const n = (sources.skeletonswap_pools.pools || []).length;
        console.log(`      ✓ ${n} pools`);
    } else sources.source_errors.skeletonswap_pools = 'fetch failed';

    return sources;
}

// -----------------------------------------------------------------------------
// CURATED
// -----------------------------------------------------------------------------

async function fetchCurated() {
    console.log('\n📚 Curated files...');
    const files = ['categories', 'wallets', 'protocols', 'known_contracts', 'token_overrides', 'acquisition_guides'];
    const curated = {};
    for (const f of files) {
        const url = `${CURATED_BASE_URL}/${f}.json`;
        const data = await tryFetchJson(url, `curated/${f}.json`);
        curated[f] = data;
        console.log(data ? `   ✓ ${f}.json` : `   - ${f}.json not present`);
    }
    return curated;
}

// -----------------------------------------------------------------------------
// CATALOG ASSEMBLY
// -----------------------------------------------------------------------------

function emptyTokenRecord(address) {
    return {
        address, type: null, category: 'tokens', subtype: null,
        symbol: null, display_name: null, decimals: null,
        coingecko_id: null, coingecko_match: 'no_mapping',
        sources: { cosmos_chain_registry: null, eris: null, astroport: null, skeletonswap: null },
        bridge: null,
        appears_in: { tla_pools_count: 0, tla_pools: [], is_lockable: false, is_amplp_underlying: false },
        wallet_import: null,
        scoring: { confusion_score: 100, flags: [] },
        override: null, notes: null,
    };
}

function indexChainRegistry(registry) {
    const idx = {};
    if (!registry || !Array.isArray(registry.assets)) return idx;
    for (const a of registry.assets) {
        const base = a.base || a.address;
        if (!base) continue;
        const key = base.startsWith('cw20:') ? base.slice(5) : base;

        let type;
        if (base.startsWith('ibc/')) type = 'ibc';
        else if (base.startsWith('factory/')) type = 'factory';
        else if (a.type_asset === 'cw20' || base.startsWith('cw20:')) type = 'cw20';
        else type = 'native';

        let bridge = null;
        if (a.traces && Array.isArray(a.traces) && a.traces.length > 0) {
            const ibcTrace = a.traces.find(t => t.type === 'ibc') || a.traces[0];
            const cp = ibcTrace.counterparty || {};
            bridge = {
                source_chain: cp.chain_name || null,
                original_denom: cp.base_denom || null,
                channel_id: cp.channel_id || null,
                via: ibcTrace.type || null,
                provider: ibcTrace.provider || null,
                all_traces: a.traces,
            };
        }

        let decimals = null;
        if (Array.isArray(a.denom_units)) {
            const displayUnit = a.denom_units.find(u => u.denom === a.display);
            if (displayUnit) decimals = displayUnit.exponent;
        }

        idx[key] = {
            symbol: a.symbol, name: a.name, display: a.display, decimals,
            coingecko_id: a.coingecko_id || null, type, bridge,
            description: a.description,
            logo_uri: (a.images && a.images[0])?.png || (a.logo_URIs && a.logo_URIs.png) || null,
        };
    }
    return idx;
}

function indexErisPrices(prices) {
    const idx = {};
    if (!prices || typeof prices !== 'object') return idx;
    // The Eris /prices endpoint structure (verified from HAR):
    //   { "<denom>": { denom, display, coingecko_id, decimals, price_usd } }
    // The KEY is the address; `display` is the UI label Eris shows on its
    // website (e.g. "wBTC.atom", "ampLUNA", "LUNA-USDC LP"); `coingecko_id`
    // is the CoinGecko slug (e.g. "terra-luna-2"). These are three DIFFERENT
    // values and the catalog preserves all three.
    for (const [denom, entry] of Object.entries(prices)) {
        if (!entry || typeof entry !== 'object') continue;
        const addr = entry.contract || entry.denom || denom;
        if (!addr) continue;
        const key = addr.startsWith('cw20:') ? addr.slice(5) : addr;
        idx[key] = {
            // Eris's user-facing UI label — this is the authoritative name to
            // show in dashboards. Falls back to denom only if missing.
            display: entry.display || null,
            // CoinGecko ID slug. Separate field, NOT a fallback for display.
            coingecko_id: entry.coingecko_id || null,
            // Price + decimals
            decimals: entry.decimals,
            price_usd: entry.price_usd ?? entry.final_price_usd ?? null,
            // Legacy fields preserved for backwards compatibility — these
            // were misnamed in earlier versions (eris_name was the address).
            // New code should read `display` instead.
            eris_name: entry.display || denom,
            symbol: entry.display || denom,
        };
    }
    return idx;
}

function indexAstroport(astroportData) {
    const idx = {};
    const pools = Array.isArray(astroportData) ? astroportData : (astroportData?.pools || []);
    if (!Array.isArray(pools)) return idx;
    for (const p of pools) {
        const assets = p.assets || [];

        // 1. Index the underlying assets within each pool
        for (const asset of assets) {
            const addr = asset.address || asset.denom;
            if (!addr) continue;
            const key = addr.startsWith('cw20:') ? addr.slice(5) : addr;
            idx[key] = {
                symbol: asset.symbol, name: asset.name || asset.symbol,
                decimals: asset.precision || asset.decimals,
                price_usd: asset.price ?? null,
            };
        }

        // 2. NEW: also index the LP token itself with a derived "X-Y LP" name.
        // Astroport returns the LP token under various field names depending on
        // pool type and API version. We try each known location.
        const lpAddr = p.liquidity_token || p.lp_address || p.lp_token
                    || p.lpAddress || p.share_token || p.lpToken
                    || (p.lp && (p.lp.address || p.lp.denom));
        if (lpAddr) {
            const lpKey = lpAddr.startsWith('cw20:') ? lpAddr.slice(5) : lpAddr;
            const symbols = assets.map(a => a.symbol).filter(Boolean);
            const lpName = symbols.length >= 2 ? `${symbols.join('-')} LP` : 'Astroport LP';
            const poolType = p.pool_type || p.type || p.poolType;
            const typeBadge = poolType ? ` (${poolType})` : '';
            idx[lpKey] = {
                symbol: lpName,
                name: lpName + typeBadge,
                decimals: 6,
                is_lp_token: true,
                pool_type: poolType,
                underlying_addresses: assets.map(a => a.address || a.denom).filter(Boolean),
                underlying_symbols: symbols,
            };
        }
    }
    return idx;
}

function indexSkeletonSwap(ssData) {
    const idx = {};
    const pools = ssData?.pools || [];
    for (const p of pools) {
        // 1. Underlying assets
        const assetTokens = [p.token_0, p.token_1].filter(Boolean);
        for (const tk of assetTokens) {
            if (!tk.denom) continue;
            const key = tk.denom.startsWith('cw20:') ? tk.denom.slice(5) : tk.denom;
            idx[key] = {
                symbol: tk.symbol, name: tk.name || tk.symbol,
                decimals: tk.decimals, logo_url: tk.logo_url,
            };
        }

        // 2. LP token itself
        const lpAddr = p.liquidity_token || p.lp_address || p.lp_token
                    || p.lpAddress || p.share_token;
        if (lpAddr) {
            const lpKey = lpAddr.startsWith('cw20:') ? lpAddr.slice(5) : lpAddr;
            const symbols = assetTokens.map(t => t.symbol).filter(Boolean);
            const lpName = symbols.length >= 2 ? `${symbols.join('-')} LP` : 'Skeleton Swap LP';
            idx[lpKey] = {
                symbol: lpName, name: lpName,
                decimals: 6,
                is_lp_token: true,
                underlying_addresses: assetTokens.map(t => t.denom).filter(Boolean),
                underlying_symbols: symbols,
                dex: 'SkeletonSwap',
            };
        }
    }
    return idx;
}

function indexAmplpMapping(assetConfigs) {
    const mapping = {};
    const lpToAmplp = {};
    if (!Array.isArray(assetConfigs)) return { mapping, lpToAmplp };
    for (const cfg of assetConfigs) {
        const ampDenom = cfg.amp_denom;
        const assetInfo = cfg.asset_info;
        if (!ampDenom || !assetInfo) continue;
        const lpKey = assetInfo.cw20 || assetInfo.native;
        if (!lpKey) continue;
        mapping[ampDenom] = {
            underlying_lp_address: lpKey,
            underlying_lp_type: assetInfo.cw20 ? 'cw20' : 'native',
            bucket: cfg.gauge || null,
            zasset_denom: cfg.zasset_denom || null,
            reward_asset_info: cfg.reward_asset_info || null,
            fee_override: cfg.fee || null,
        };
        lpToAmplp[lpKey] = ampDenom;
    }
    return { mapping, lpToAmplp };
}

// -----------------------------------------------------------------------------
// SCOPE FILTER (per CRON-FIXES-BRIEF item 2.21 + 2.21b)
// -----------------------------------------------------------------------------
// The catalog used to enumerate the entire chain's tokens (~622) and then try
// to score down to relevance. That produced a mostly-noise output dominated
// by dead meme LPs. The brief calls for the opposite: SCOPE IN from the TLA
// gauge LPs and include ONLY the tokens those LPs contain.
//
// Two passes:
//   1) expandToInactiveLPs  — extend the LP set beyond the 28 active to also
//                              include below-threshold LPs (each bucket's
//                              asset-staking contract has the full whitelist).
//   2) buildLpUniverse       — for each LP, query `pair{}` on its Astroport
//                              pair contract to get the two underlying token
//                              addresses. Both LP token AND underlyings go in
//                              the in-scope set.
//
// Either pass failing is recoverable: scope shrinks but the catalog still
// builds. We log what worked and emit counters in the heartbeat so we can
// see if the chain is degrading.

// Best-effort: extend the LP list to include below-threshold LPs that each
// bucket's asset-staking contract still tracks (the "inactive" set from
// brief 2.21).
//
// We try `whitelisted_assets` on each bucket's asset-staking contract. If the
// schema doesn't match what we expect, the contract returns null and we
// silently fall back to active-only. The active 28 LPs are NEVER lost — this
// only adds.
//
// Returns: array of pool-like records for any LP we discover beyond the active
// set. Empty array on total failure (which is fine, catalog still works).
async function expandToInactiveLPs(activePools, directory) {
    const extraPools = [];
    const stats = { contractsChecked: 0, contractsSucceeded: 0, extraLpsFound: 0 };

    const stakingRoles = [
        ['ASSET_STAKING__stable',   'stable'],
        ['ASSET_STAKING__project',  'project'],
        ['ASSET_STAKING__bluechip', 'bluechip'],
        ['ASSET_STAKING__single',   'single'],
    ];
    // Build a set of active LP addresses for dedup
    const activeKeys = new Set(activePools.map(p => p.gauge_pool_id));

    for (const [role, bucketName] of stakingRoles) {
        const stakingAddr = directory[role];
        if (!stakingAddr) continue;
        stats.contractsChecked++;

        // Try the most likely query name first. Per the brief Part 6:
        //   asset-staking → whitelisted_assets (returns the bucket's full LP set)
        const result = await queryContract(stakingAddr, { whitelisted_assets: {} }, `asset-staking[${bucketName}].whitelisted_assets`);
        if (!result) {
            // Query failed — log but don't fail the whole cron. Active-only fallback.
            continue;
        }
        stats.contractsSucceeded++;

        // Response shape per the brief is unconfirmed in full detail, but the
        // CW721/Astroport pattern is an array of asset_info entries. Be
        // defensive about the wrapper.
        let assetList = result;
        if (result && typeof result === 'object' && !Array.isArray(result)) {
            // Common wrappers: {assets: [...]} or {whitelisted_assets: [...]}
            assetList = result.assets || result.whitelisted_assets || result.list || result.data || [];
        }
        if (!Array.isArray(assetList)) continue;

        for (const entry of assetList) {
            // Each entry could be a bare asset_info {cw20|native} or wrapped.
            const asset = (entry && (entry.asset || entry.info)) || entry;
            if (!asset || (typeof asset !== 'object')) continue;
            const lpAddr = asset.cw20 || asset.native;
            if (!lpAddr) continue;

            const gaugePoolId = asset.cw20 ? `cw20:${asset.cw20}` : `native:${asset.native}`;
            if (activeKeys.has(gaugePoolId)) continue;  // already in active set

            extraPools.push({
                gauge_pool_id: gaugePoolId,
                bucket: bucketName,
                asset_raw: asset,
                distribution_pct: 0,     // inactive: not earning emissions this epoch
                total_vp: null,          // VP info doesn't come from this query
                gauge_status: 'inactive_below_threshold',
            });
            activeKeys.add(gaugePoolId);
            stats.extraLpsFound++;
        }
    }
    return { extraPools, stats };
}

// For each LP in the union (active + inactive), query the Astroport pair
// to discover the two underlying token addresses. Both the LP itself and its
// underlyings join the in-scope set.
//
// The LP's contract address is the LP TOKEN address (not the pair address).
// To find the pair address we query the LP token's `minter` query — every
// Astroport LP cw20 has the pair as its minter. For native/factory LPs the
// path differs and we skip the pair lookup for now (still includes the LP).
async function buildLpUniverse(pools) {
    const lpAddrs = new Set();
    const underlyings = new Set();
    const lpToUnderlyings = {};  // lpAddr → [tokenAddr, tokenAddr]
    const stats = { totalLps: 0, pairLookupSucceeded: 0, pairLookupFailed: 0, nativeLpsResolved: 0, nativeLpsSkipped: 0 };

    for (const pool of pools) {
        stats.totalLps++;
        const raw = pool.asset_raw || {};
        const lpAddr = raw.cw20 || raw.native;
        if (!lpAddr) continue;
        lpAddrs.add(lpAddr);

        let pairAddr = null;
        if (raw.native) {
            // Factory/native LPs (Astroport newer pool format).
            // The pair address is encoded in the denom path:
            //   factory/{PAIR_ADDR}/uLP
            // So we extract it directly — no minter query needed.
            const m = lpAddr.match(/^factory\/(terra1[a-z0-9]+)\//);
            if (m) pairAddr = m[1];
            // If the denom doesn't follow the factory pattern (e.g. an IBC denom
            // that ended up classified as an LP — unusual but possible), we skip
            // and let the LP itself stay in scope without underlyings.
            if (!pairAddr) {
                stats.nativeLpsSkipped++;
                continue;
            }
        } else {
            // cw20 LP: minter query gives the pair address.
            const minterResp = await queryContract(lpAddr, { minter: {} }, `lp[${lpAddr.slice(-8)}].minter`);
            pairAddr = minterResp?.minter || minterResp?.address;
            if (!pairAddr) {
                stats.pairLookupFailed++;
                continue;
            }
        }

        const pairResp = await queryContract(pairAddr, { pair: {} }, `pair[${pairAddr.slice(-8)}].pair`);
        if (!pairResp || !Array.isArray(pairResp.asset_infos)) {
            if (raw.native) stats.nativeLpsSkipped++;
            else stats.pairLookupFailed++;
            continue;
        }
        if (raw.native) stats.nativeLpsResolved++;
        else stats.pairLookupSucceeded++;

        const u = [];
        for (const info of pairResp.asset_infos) {
            const t = info.token?.contract_addr || info.native_token?.denom;
            if (t) {
                underlyings.add(t);
                u.push(t);
            }
        }
        lpToUnderlyings[lpAddr] = u;
    }

    return { lpAddrs, underlyings, lpToUnderlyings, stats };
}


function buildTokenCatalog({ pools, chainRegIdx, erisIdx, astroIdx, ssIdx, amplpInfo, curated, scopeAddrs, lpToUnderlyings }) {
    const tokens = {};
    // scopeAddrs (Set<string>) is the in-scope set built from TLA gauge LPs +
    // their underlyings per brief 2.21. Stages 1-4 (chain registry / Eris /
    // Astroport / Skeleton) check against it and skip out-of-scope addresses
    // at the source instead of enumerating everything then trying to score down.
    //
    // OPT-IN: pass `null` to keep the old "enumerate everything" behavior. The
    // cron always passes a non-null set once the scope phase runs — at minimum
    // it contains the 28 active LP addresses, so the catalog can't lose them.
    const inScope = (addr) => {
        if (!scopeAddrs) return true;  // legacy: no filter
        return scopeAddrs.has(addr);
    };

    const get = (addr) => {
        if (!tokens[addr]) tokens[addr] = emptyTokenRecord(addr);
        return tokens[addr];
    };

    // Stage 1: chain registry
    for (const [addr, info] of Object.entries(chainRegIdx)) {
        if (!inScope(addr)) continue;
        const t = get(addr);
        t.type = info.type;
        t.symbol = info.symbol;
        t.display_name = info.name;
        t.decimals = info.decimals;
        t.coingecko_id = info.coingecko_id;
        t.bridge = info.bridge;
        t.sources.cosmos_chain_registry = {
            symbol: info.symbol, name: info.name,
            description: info.description, logo_uri: info.logo_uri,
        };
    }

    // Stage 2: Eris — the AUTHORITATIVE source for the UI label
    //
    // The Eris price endpoint has been giving us the right label all along
    // in the `display` field. Earlier versions of this cron read the wrong
    // field (the address) and then added slug-detection heuristics to filter
    // out the bad output. With `display` read correctly, those heuristics
    // are unnecessary — Eris hands us "wBTC.atom", "ampLUNA", "LUNA-USDC LP"
    // exactly as shown on the website.
    //
    // Three independent fields are preserved on each token:
    //   sources.eris.display         → UI label (e.g. "wBTC.atom")
    //   sources.eris.coingecko_id    → CG slug (e.g. "eureka-bridged-wbtc-terra")
    //   sources.cosmos_chain_registry.name → registry full name (e.g. "Eureka Bridged WBTC")
    //
    // The dashboard can render all three side-by-side; the catalog never
    // collapses them.
    for (const [addr, info] of Object.entries(erisIdx)) {
        if (!inScope(addr)) continue;
        const t = get(addr);
        if (!t.type) {
            t.type = addr.startsWith('ibc/') ? 'ibc'
                   : addr.startsWith('factory/') ? 'factory'
                   : addr.startsWith('terra1') ? 'cw20' : 'native';
        }
        t.sources.eris = {
            display: info.display,                  // authoritative UI label
            coingecko_id: info.coingecko_id,        // separate — NOT a name
            decimals: info.decimals,
            price_usd: info.price_usd,
            // Legacy fields — same values, kept for backwards compatibility
            eris_name: info.display,
            symbol: info.display,
        };
        // Eris's display IS the user-facing name. Use it as the canonical
        // display_name. Falling back to whatever an earlier stage set only
        // when Eris has no entry for this token.
        if (info.display) {
            t.display_name = info.display;
        }
        if (info.decimals != null && t.decimals == null) t.decimals = info.decimals;
        if (info.coingecko_id && !t.coingecko_id) t.coingecko_id = info.coingecko_id;
    }

    // Stage 3: Astroport
    for (const [addr, info] of Object.entries(astroIdx)) {
        if (!inScope(addr)) continue;
        const t = get(addr);
        t.sources.astroport = info;
        if (!t.type) {
            t.type = addr.startsWith('ibc/') ? 'ibc'
                   : addr.startsWith('factory/') ? 'factory'
                   : addr.startsWith('terra1') ? 'cw20' : 'native';
        }
        if (!t.symbol) t.symbol = info.symbol;
        if (info.decimals && !t.decimals) t.decimals = info.decimals;
    }

    // Stage 4: SS
    for (const [addr, info] of Object.entries(ssIdx)) {
        if (!inScope(addr)) continue;
        const t = get(addr);
        t.sources.skeletonswap = info;
        if (!t.type) {
            t.type = addr.startsWith('ibc/') ? 'ibc'
                   : addr.startsWith('factory/') ? 'factory'
                   : addr.startsWith('terra1') ? 'cw20' : 'native';
        }
        if (!t.symbol) t.symbol = info.symbol;
    }

    // Stage 5: TLA pool participation
    // Note: gauge_pool_id is an LP TOKEN address (not underlying asset).
    // The LP token represents a position in a pool. We mark it as such; the
    // underlying-asset → "appears_in N pools" linkage is backfilled below.
    //
    // BUT: not everything in `pools` is an LP pair. The asset-staking
    // whitelist also includes single-asset stakes (ampCAPA, xASTRO,
    // wBTC.creda.a) — you can stake just one token, no pair involved.
    // These show up in pools because they're stakeable assets, but
    // categorizing them as `lp_tokens` is wrong — they're regular tokens
    // that happen to be stakeable.
    //
    // Detection: Eris's display field tells us. LPs and AMPLPs have:
    //   - a hyphen ("X-Y LP")
    //   - or end with "LP" / "AMPLP"
    //   - or "LP (S)" suffix for stableswap variants
    // Single-asset stakes are just the token name ("ampCAPA", "xASTRO",
    // "wBTC.creda.a").
    const looksLikeLpName = (display) => {
        if (!display) return null;  // unknown — can't decide
        const d = display.toUpperCase();
        return d.includes('-')                   // X-Y pattern
            || /\b(LP|AMPLP)\b/.test(d)          // standalone LP / AMPLP word
            || /\sLP(\s|\(|$)/.test(d);          // " LP" as suffix
    };
    for (const pool of pools) {
        const addr = pool.gauge_pool_id?.replace(/^cw20:/, '').replace(/^native:/, '');
        if (!addr) continue;
        const t = get(addr);

        // Use Eris's display to tell apart LP from single-asset stake.
        // If Eris doesn't know (display is missing), fall back to "looks like
        // an LP" — assume it IS an LP since most things in pools are.
        const erisDisplay = t.sources?.eris?.display;
        const isLpShaped = erisDisplay != null ? looksLikeLpName(erisDisplay) : true;

        if (isLpShaped) {
            t.category = 'lp_tokens';
            t.subtype  = pool.gauge_pool_id.startsWith('native:factory/') ? 'astroport_native_lp' : 'astroport_cw20_lp';
        } else {
            // Single-asset stake (ampCAPA, xASTRO, wBTC.creda.a etc.)
            // Keep as a regular token; mark with a flag so consumers can tell.
            t.category = 'tokens';
            t.appears_in.is_single_asset_stake = true;
        }
        t.appears_in.tla_pools_count += 1;
        t.appears_in.tla_pools.push(pool.bucket);
        t.appears_in.tla_distribution_pct = pool.distribution_pct;
        t.appears_in.tla_total_vp = pool.total_vp;
        if (!t.type) t.type = pool.gauge_pool_id.startsWith('cw20:') ? 'cw20' : 'factory';
    }

    // Stage 5b: Backfill underlying-token participation in TLA pools
    // Without this, LUNA — which underlies basically every TLA pool — shows
    // "Appears in TLA pools: no" because the stage above only credits the
    // LP token itself. The cron has lpToUnderlyings from the scope phase, so
    // we credit each underlying for every LP it appears in.
    if (lpToUnderlyings && typeof lpToUnderlyings === 'object') {
        // Group pools by LP address so we can match each LP back to its bucket
        const poolByLpAddr = {};
        for (const pool of pools) {
            const lpAddr = pool.asset_raw?.cw20 || pool.asset_raw?.native;
            if (lpAddr) poolByLpAddr[lpAddr] = pool;
        }
        for (const [lpAddr, underlyings] of Object.entries(lpToUnderlyings)) {
            const pool = poolByLpAddr[lpAddr];
            if (!pool || !Array.isArray(underlyings)) continue;
            for (const uAddr of underlyings) {
                const ut = tokens[uAddr];
                if (!ut) continue;
                ut.appears_in.tla_pools_count += 1;
                if (!ut.appears_in.tla_pools.includes(pool.bucket)) {
                    ut.appears_in.tla_pools.push(pool.bucket);
                }
            }
        }
    }

    // Stage 6: amplp wrapping
    // For each amplp factory denom, mark the LP token it wraps. The field
    // means: "this LP token gets wrapped by an amplp" — NOT "this token is an
    // amplp underlying" (which would be 2 layers — the LP's underlying tokens).
    // The original field name `is_amplp_underlying` was misleading.
    for (const info of Object.values(amplpInfo.mapping)) {
        const wrappedLp = info.underlying_lp_address;
        if (tokens[wrappedLp]) {
            tokens[wrappedLp].appears_in.is_wrapped_by_amplp = true;
            // Keep the legacy field for backwards compatibility — same value
            tokens[wrappedLp].appears_in.is_amplp_underlying = true;
        }
    }

    // Stage 7: curated overrides
    //
    // Skip entries whose KEY isn't a real chain address. The token_overrides
    // file can contain documentation/example entries with placeholder keys
    // like "_example_wBTCatom_disabled" — the convention is a leading
    // underscore means "this is a template, ignore me." If we don't skip
    // these, they become user-visible token cards with fake data alongside
    // the real token, which is a trust problem (e.g. two "wBTC.atom" tiles).
    //
    // Real addresses on Terra: terra1..., ibc/..., factory/..., or a raw
    // native denom (uluna). Anything else is a stub.
    const isRealAddress = (a) => a && (
        a.startsWith('terra1') || a.startsWith('ibc/') ||
        a.startsWith('factory/') || /^u[a-z]+$/.test(a)
    );
    if (curated.token_overrides) {
        const overrides = curated.token_overrides.tokens || curated.token_overrides;
        if (typeof overrides === 'object') {
            for (const [addr, override] of Object.entries(overrides)) {
                if (!isRealAddress(addr)) {
                    // Template/example entry — skip silently. The file author
                    // signaled this is not real data via the underscore prefix
                    // (or other non-address-shaped key).
                    continue;
                }
                if (!tokens[addr]) tokens[addr] = emptyTokenRecord(addr);
                const t = tokens[addr];
                t.override = override;
                if (override.display_name) t.display_name = override.display_name;
                if (override.subtype) t.subtype = override.subtype;
                if (override.notes) t.notes = override.notes;
            }
        }
    }

    // Stage 8: acquisition guides
    if (curated.acquisition_guides) {
        const guides = curated.acquisition_guides.tokens || curated.acquisition_guides;
        if (typeof guides === 'object') {
            for (const [addr, guide] of Object.entries(guides)) {
                if (tokens[addr]) tokens[addr].acquisition = guide;
            }
        }
    }

    // Stage 9: subtype + wallet_import + scoring
    //
    // Acquisition classification (brief 2.21 follow-up — Camron's 4 buckets):
    //   1. native_terra         — LUNA, cw20s minted on Terra, Terra factory tokens (LSTs ampLUNA/bLUNA/arbLUNA,
    //                             SOLID, ROAR, CAPA, ampCAPA, ampROAR). Zero acquisition friction.
    //   2. ibc_cosmos_native    — ibc/* assets that are native on their source Cosmos chain
    //                             (ATOM, INJ, ASTRO, FUEL, stATOM, stLUNA). One-hop IBC, low friction.
    //   3. wrapped_disclosed    — wrapped tokens that say so in the symbol (`.axl`, `.atom`, etc.).
    //                             User can SEE it's wrapped — friction is medium.
    //   4. wrapped_looks_native — wrapped tokens with a symbol that hides the wrapping
    //                             (USDC, USDt, WBTC, PAXG, EURe). HIGH friction — without a guide,
    //                             users may bridge from the wrong source chain and end up with a
    //                             token that won't deposit into TLA (e.g. Polygon-USDC vs Noble-USDC).
    //
    // The `no_acquisition_guide` flag only fires on classes 3 and 4 — classes 1 and 2 don't need a guide.
    // Class 4 is the highest-priority candidate for a curated guide entry.
    const WRAPPED_LOOKS_NATIVE_SYMBOLS = new Set([
        'USDC', 'USDt', 'USDT', 'wBTC', 'WBTC', 'wETH', 'WETH', 'PAXG', 'EURe', 'EURE', 'DAI',
    ]);
    const WRAPPED_DISCLOSED_PATTERNS = ['.axl', '.atom', '.eth', '.wormhole', '.gravity'];

    function classifyAcquisition(t) {
        // LP tokens aren't "acquired" the same way — they're minted by depositing
        if (t.category === 'lp_tokens') return 'lp_token';
        const sym = t.symbol || '';
        // Bucket 3: wrapped + disclosed (bridge tag in symbol)
        if (WRAPPED_DISCLOSED_PATTERNS.some(p => sym.includes(p))) return 'wrapped_disclosed';
        // Bucket 4: IBC asset whose symbol hides the wrapping
        if (t.type === 'ibc' && WRAPPED_LOOKS_NATIVE_SYMBOLS.has(sym)) return 'wrapped_looks_native';
        // Bucket 2: any other IBC asset (one-hop Cosmos-native)
        if (t.type === 'ibc') return 'ibc_cosmos_native';
        // Bucket 1: anything else (cw20, factory, native — all Terra-native)
        return 'native_terra';
    }

    for (const t of Object.values(tokens)) {
        if (!t.subtype) {
            if (t.type === 'ibc') t.subtype = 'ibc';
            else if (t.type === 'factory') t.subtype = 'native';
            else if (t.type === 'cw20') t.subtype = 'cw20';
            else t.subtype = 'native';
        }
        const sym = (t.display_name || t.symbol || '').toLowerCase();
        if (/^(amp|arb|b|st)/.test(t.symbol || '') && /luna/i.test(sym)) {
            t.subtype = 'lst';
        }

        // Classify acquisition friction — used to gate `no_acquisition_guide`
        t.acquisition_class = classifyAcquisition(t);

        if (t.symbol && t.decimals != null) {
            t.wallet_import = {
                symbol: t.symbol, name: t.display_name || t.symbol,
                decimals: t.decimals, address: t.address,
            };
        }

        let score = 100;
        const flags = [];

        // Helper: a "name" that's actually just the address shouldn't count as a real source-named token
        const isNameLikeAddress = (n) => n && (n.startsWith('terra1') || n.startsWith('ibc/') || n.startsWith('factory/'));
        const realNamesAcrossSources = [
            t.sources.cosmos_chain_registry?.symbol,
            t.sources.eris?.symbol,
            t.sources.astroport?.symbol,
            t.sources.skeletonswap?.symbol,
        ].filter(n => n && !isNameLikeAddress(n));
        const distinctNames = [...new Set(realNamesAcrossSources.map(n => n.toLowerCase().replace(/\.[a-z]+$/, '')))];
        if (distinctNames.length > 1) {
            score -= 15;
            flags.push('cross_source_name_mismatch:' + realNamesAcrossSources.join(','));
        }

        if (!t.coingecko_id) {
            score -= 25;
            flags.push('no_external_price_source');
            t.coingecko_match = 'no_mapping';
        } else {
            t.coingecko_match = 'matched';
        }

        // no_acquisition_guide ONLY fires when a guide is genuinely needed:
        //   - class 1 (native_terra)       — already on Terra, no guide ever needed
        //   - class 2 (ibc_cosmos_native)  — one-hop IBC, no guide needed
        //   - class 3 (wrapped_disclosed)  — guide useful; flag if missing
        //   - class 4 (wrapped_looks_native) — guide REQUIRED; flag if missing (higher penalty)
        //   - LP tokens                    — not acquired directly; flag not applicable
        if (!t.acquisition) {
            if (t.acquisition_class === 'wrapped_looks_native') {
                score -= 20;  // higher penalty: this is the danger bucket
                flags.push('no_acquisition_guide:required');
            } else if (t.acquisition_class === 'wrapped_disclosed') {
                score -= 10;
                flags.push('no_acquisition_guide:useful');
            }
            // class 1, 2, and lp_token: silent — no flag, no penalty
        }

        if (t.appears_in.tla_pools_count === 0
            && !t.sources.eris && !t.sources.astroport && !t.sources.skeletonswap) {
            score -= 15;
            flags.push('not_in_active_use');
        }

        t.scoring.confusion_score = Math.max(0, Math.min(100, score));
        t.scoring.flags = flags;
    }

    // -------------------------------------------------------------------------
    // Stage 10: LP display-name composition (brief 2.21 follow-up)
    // -------------------------------------------------------------------------
    // For LP tokens that don't have a display_name from any external source
    // (typical for inactive/abandoned LPs that data sources no longer track),
    // we compose one from the underlying token symbols: "TOKEN_A-TOKEN_B LP".
    //
    // Source of truth is lpToUnderlyings (built in the scope phase). This runs
    // AFTER stages 1-4 so external names always win — we only fill blanks.
    if (lpToUnderlyings && typeof lpToUnderlyings === 'object') {
        for (const [lpAddr, underlyingAddrs] of Object.entries(lpToUnderlyings)) {
            const lp = tokens[lpAddr];
            if (!lp || lp.display_name) continue;  // skip if already named
            if (!Array.isArray(underlyingAddrs) || underlyingAddrs.length === 0) continue;
            const names = underlyingAddrs.map(a => {
                const u = tokens[a];
                return (u && (u.symbol || u.display_name)) || a.slice(0, 8) + '…';
            });
            lp.display_name = names.join('-') + ' LP';
            lp.scoring.flags.push('name_composed_from_underlyings');
        }
    }

    // -------------------------------------------------------------------------
    // Stage 11: Buy-the-wrong-variant warning (brief 2.21)
    // -------------------------------------------------------------------------
    // Same display-name LP resolving to DIFFERENT underlying token addresses
    // across pools = the danger described in brief 2.21:
    //
    //   "an abandoned-pool ampLUNA at a different address than the
    //    active-pool ampLUNA"
    //
    // We group LPs by display name (after stage 10 has filled in any blanks)
    // and compare each name-group's underlying addresses. If divergent, fire
    // a warning on every member of the group with a reference to the others.
    //
    // Per the brief: "the hypothesis (hopeful case) is that variants share
    // underlying token addresses and only the LP contract + amplp differ." So
    // most name-groups will NOT trigger this — and that's the right outcome.
    if (lpToUnderlyings && typeof lpToUnderlyings === 'object') {
        // Group LPs by display name
        const lpNameGroups = {};
        for (const [lpAddr, ulst] of Object.entries(lpToUnderlyings)) {
            const lp = tokens[lpAddr];
            if (!lp || !lp.display_name) continue;
            // Sort underlyings so two LPs with the same pair in different order match
            const sortedU = [...ulst].sort();
            const key = lp.display_name;
            (lpNameGroups[key] = lpNameGroups[key] || []).push({ lpAddr, sortedU });
        }
        for (const [name, members] of Object.entries(lpNameGroups)) {
            if (members.length < 2) continue;
            // Check if any underlying address diverges across the group
            const firstU = JSON.stringify(members[0].sortedU);
            const allSame = members.every(m => JSON.stringify(m.sortedU) === firstU);
            if (allSame) continue;  // benign — same name, same underlyings, just different LP contracts
            // Divergent — fire the warning on every member
            for (const m of members) {
                const lp = tokens[m.lpAddr];
                if (!lp) continue;
                const others = members.filter(x => x.lpAddr !== m.lpAddr).map(x => x.lpAddr);
                lp.scoring.flags.push(`buy_the_wrong_variant:${others.join(',')}`);
                lp.scoring.confusion_score = Math.max(0, lp.scoring.confusion_score - 20);
                lp.variant_warning = {
                    display_name: name,
                    this_lp_underlyings: m.sortedU,
                    conflicting_lps: others.map(o => ({
                        lp_address: o,
                        underlyings: lpNameGroups[name].find(x => x.lpAddr === o).sortedU,
                    })),
                };
            }
        }
    }


    const symbolGroups = {};
    for (const [addr, t] of Object.entries(tokens)) {
        const baseSym = (t.symbol || '').toLowerCase().split('.')[0].replace(/^w/, '');
        if (!baseSym || baseSym.length < 2) continue;
        (symbolGroups[baseSym] = symbolGroups[baseSym] || []).push(addr);
    }
    for (const [, addrs] of Object.entries(symbolGroups)) {
        if (addrs.length < 2) continue;
        for (const addr of addrs) {
            const t = tokens[addr];
            t.scoring.confusion_score = Math.max(0, t.scoring.confusion_score - 10);
            t.scoring.flags.push(`shared_base_symbol_with:${addrs.filter(a => a !== addr).map(a => tokens[a].symbol).join(',')}`);
            t.related_variants = addrs.filter(a => a !== addr);
        }
    }

    // Post-pass: display_name / headline_name sanitation
    //
    // After Eris's `display` field is read correctly (the bug fix in this
    // batch), display_name is reliably the Eris UI label for tokens Eris
    // knows about. For the few tokens Eris doesn't price (USDt, stLUNA,
    // ampCAPA, ampROAR), fall back to other sources.
    //
    // Three named fields the dashboard can use:
    //   headline_name  → primary user-facing label, matches Eris UI conventions
    //   display_name   → same as headline for most tokens, may be longer for some
    //   symbol         → short ticker
    //
    // Priority order for headline_name:
    //   eris.display  >  astroport.symbol  >  chain-registry.symbol/name  >  truncated address
    const looksLikeCoinGeckoSlug = (s) => s && /^[a-z0-9]+(-[a-z0-9]+)+$/.test(s);
    const isAddressShape = (s) => !s || s.startsWith('terra1') || s.startsWith('ibc/')
                                  || s.startsWith('factory/') || s.startsWith('neutron1')
                                  || s.startsWith('osmo1') || s.startsWith('inj1');

    for (const t of Object.values(tokens)) {
        // Compute headline_name with Eris's `display` as the top priority
        const erisDisplay = t.sources.eris?.display;
        const astroSymbol = t.sources.astroport?.symbol;
        const crSymbol = t.sources.cosmos_chain_registry?.symbol;
        const crName = t.sources.cosmos_chain_registry?.name;

        let h = null;
        if (erisDisplay && !isAddressShape(erisDisplay) && !looksLikeCoinGeckoSlug(erisDisplay)) {
            h = erisDisplay;
        } else if (astroSymbol && !isAddressShape(astroSymbol) && !looksLikeCoinGeckoSlug(astroSymbol)) {
            h = astroSymbol;
        } else if (crSymbol && !isAddressShape(crSymbol) && !looksLikeCoinGeckoSlug(crSymbol)) {
            h = crSymbol;
        } else if (t.symbol && !isAddressShape(t.symbol) && !looksLikeCoinGeckoSlug(t.symbol)) {
            h = t.symbol;
        } else if (t.display_name && !isAddressShape(t.display_name) && !looksLikeCoinGeckoSlug(t.display_name)) {
            h = t.display_name;
        } else if (t.address) {
            h = t.address.length > 18 ? (t.address.slice(0, 12) + '…' + t.address.slice(-6)) : t.address;
            if (!t.scoring.flags.includes('no_display_name')) t.scoring.flags.push('no_display_name');
        }
        t.headline_name = h;

        // Also ensure display_name isn't a CG slug — fall back to a clean source
        if (looksLikeCoinGeckoSlug(t.display_name)) {
            t.display_name = erisDisplay || crName || h;
        }
    }


    //   'core'    → must show: in TLA pool, has CG mapping, LP token, curated override, or
    //                acquisition guide. Things we actively care about.
    //   'tracked' → has a real name from a quality source (chain registry, Eris, Astroport) but
    //                no strong participation signal. Worth keeping searchable, lower priority.
    //   'noise'   → unnamed addresses, no participation, no external mapping. Hidden by default.
    //
    // Important: chain-registry alone is NOT enough for 'core' because the Cosmos Chain Registry
    // contains many random Terra cw20 tokens (e.g. dinheiro/DINHEIROS, alentejo.money) that have
    // no TLA relevance and no external price source. Chain registry → 'tracked'.
    for (const t of Object.values(tokens)) {
        const isAddressShaped = (s) => !s
            || s.startsWith('terra1') || s.startsWith('ibc/')
            || s.startsWith('factory/') || s.startsWith('neutron1')
            || s.startsWith('osmo1') || s.startsWith('inj1');
        const hasRealName = t.display_name && !isAddressShaped(t.display_name);
        const hasSymbol   = t.symbol && !isAddressShaped(t.symbol);
        const hasCG       = !!t.coingecko_id;
        const inTLAPool   = t.appears_in.tla_pools_count > 0;
        const isAmplpUnderlying = t.appears_in.is_amplp_underlying;
        const hasOverride = !!t.override;
        const hasAcq      = !!t.acquisition;
        const isLpToken   = t.category === 'lp_tokens';
        const isLst       = t.subtype === 'lst';
        const hasBridgeInfo = !!t.bridge;  // chain registry attached bridge metadata = known cross-chain asset

        if (hasCG || inTLAPool || isAmplpUnderlying || hasOverride || hasAcq || isLpToken || isLst || hasBridgeInfo) {
            t.tier = 'core';
        } else if (hasRealName || hasSymbol) {
            t.tier = 'tracked';
        } else {
            t.tier = 'noise';
        }
    }

    return tokens;
}

function buildContractsCatalog({ directory, curated }) {
    const contracts = {};
    const wallets = {};

    for (const [role, addr] of Object.entries(directory)) {
        if (!addr || !addr.startsWith('terra1')) continue;
        contracts[addr] = {
            address: addr, label: role, protocol: 'Eris',
            category: 'contracts', subtype: 'protocol_core',
            source: 'auto_discovered',
            auto_data: { ve3_role: role, discovered_via: 'global-config.all_addresses' },
            flags: [],
        };
    }

    const knownC = curated.known_contracts;
    if (knownC) {
        const entries = knownC.contracts || knownC;
        if (typeof entries === 'object') {
            for (const [addr, info] of Object.entries(entries)) {
                if (!addr.startsWith('terra1')) continue;
                if (!contracts[addr]) {
                    contracts[addr] = { address: addr, category: 'contracts', source: 'curated', flags: [] };
                } else {
                    contracts[addr].source = 'merged';
                }
                const c = contracts[addr];
                if (info.name) c.label = info.name;
                if (info.type) c.subtype = info.type;
                if (info.protocol) c.protocol = info.protocol;
                if (info.description) c.description = info.description;
                if (info.validActions) c.valid_actions = info.validActions;
                if (info.canReceiveFunds != null) c.can_receive_funds = info.canReceiveFunds;
                if (info.seen_in_props) c.seen_in_props = info.seen_in_props;
                if (info.risk_level) c.risk_level = info.risk_level;
                if (info.staking_module) c.staking_module = info.staking_module;
                if (info.notes) c.notes = info.notes;
            }
        }
    }

    const wal = curated.wallets;
    if (wal) {
        const entries = wal.wallets || wal;
        if (typeof entries === 'object') {
            for (const [addr, info] of Object.entries(entries)) {
                if (!addr.startsWith('terra1')) continue;
                wallets[addr] = { address: addr, category: 'wallets', source: 'curated', ...info };
            }
        }
    }

    return { contracts, wallets };
}

// -----------------------------------------------------------------------------
// WALLET ENRICHMENT — Phase 0 catalog expansion
// -----------------------------------------------------------------------------
// Three independent paths, each defensive (failures don't break the cron):
//
//   1. enrichWalletsWithDaodaoStakers  — direct list_stakers on cw20-staked DAOs
//                                        (Lion DAO ROAR Staking works; ~346 stakers)
//
//   2. enrichWalletsWithDaodaoIndexer  — DAODAO indexer attempt for cw721 DAOs
//                                        (Pixel Lions, aDAO NFT-staked, etc.)
//                                        The on-chain contract doesn't expose
//                                        list_stakers but the indexer can derive
//                                        it from indexed wasm events.
//
//   3. enrichWalletsWithTLALocks       — voting-escrow.all_tokens then lock_info
//                                        per token. ~431 chain queries at
//                                        concurrency 3.
//
// Each adds to wallets[addr].dao_memberships[] so the picker UI can filter by
// group (All / aDAO / Lion DAO / TLA) and sort by per-group stake/VP descending.
// Staker entries are NOT auto-labeled — they stay as truncated addresses in
// the dropdown but become recognizable on paste. To promote a discovered staker
// to a named wallet, edit it via tla-catalog.html and save the label to
// wallets.json as a curated override.

// Batched concurrent execution helper. Keeps concurrency low (3) by default
// because Terra LCDs rate-limit aggressively; the adao-positions cron learned
// this the hard way (had to drop concurrency from 15 → 5).
async function batchedAsync(items, concurrency, fn) {
    const results = new Array(items.length);
    for (let i = 0; i < items.length; i += concurrency) {
        const batch = items.slice(i, i + concurrency);
        const batchResults = await Promise.allSettled(batch.map((item, j) => fn(item, i + j)));
        for (let k = 0; k < batchResults.length; k++) {
            const r = batchResults[k];
            results[i + k] = r.status === 'fulfilled' ? r.value : null;
        }
    }
    return results;
}

// -----------------------------------------------------------------------------
// BECH32 ADDRESS DECODER  (terra1xxxx... → 20-byte hex)
// -----------------------------------------------------------------------------
// Used to build DAODAO PFPK profile URLs which require the address in 20-byte
// hex form, not bech32. Verified against a known HAR sample:
//   terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw → b8ce282438bd7c022305d60f9d0c566a97edf520
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32ToHex(addr) {
    const sepIdx = addr.lastIndexOf('1');
    if (sepIdx < 1) throw new Error('Invalid bech32: no separator');
    const data = addr.slice(sepIdx + 1);
    if (data.length < 7) throw new Error('Invalid bech32: too short');
    let acc = 0, bits = 0;
    const bytes = [];
    for (let i = 0; i < data.length - 6; i++) {
        const v = BECH32_CHARSET.indexOf(data[i]);
        if (v < 0) throw new Error('Invalid bech32 char: ' + data[i]);
        acc = (acc << 5) | v;
        bits += 5;
        while (bits >= 8) {
            bits -= 8;
            bytes.push((acc >> bits) & 0xff);
        }
    }
    return Buffer.from(bytes).toString('hex');
}

// -----------------------------------------------------------------------------
// DAODAO PFPK PROFILE NAME ENRICHMENT
// -----------------------------------------------------------------------------
// DAODAO's PFPK service (Profile Friends Profile Pic K??) lets users register
// a display name + NFT avatar tied to their wallet across multiple Cosmos chains.
// We look up each discovered wallet to surface known names like "DeFi_Patriot",
// "Crypto007", etc. so the picker shows real names instead of just addresses.
//
// Endpoint: https://pfpk.daodao.zone/bech32/{hex40}
// Response: { uuid, name, nft, chains, createdAt, updatedAt }
// Hit rate observed from HAR sample: ~28% of addresses have a registered name.
//
// We only look up wallets that DON'T already have a curated label (no point
// overriding a manually-set name from wallets.json).
async function enrichWalletsWithPfpkNames(wallets) {
    const PFPK_BASE = 'https://pfpk.daodao.zone/bech32';
    const candidates = Object.entries(wallets).filter(([_, w]) =>
        !w.label && !w.daodao_name && w.discovery_source
    );
    if (candidates.length === 0) {
        return { totalLookups: 0, namesFound: 0 };
    }
    let namesFound = 0;
    await batchedAsync(candidates, 5, async ([addr, w]) => {
        try {
            const hex = bech32ToHex(addr);
            const r = await fetch(`${PFPK_BASE}/${hex}`, {
                signal: AbortSignal.timeout(5000),
                headers: { 'User-Agent': 'tla-registry/2.0' },
            });
            if (!r.ok) return;
            const data = await r.json();
            if (data?.name) {
                w.daodao_name = data.name;
                // Capture the avatar URL too if present (lets the UI render it later)
                if (data.nft?.imageUrl) {
                    w.daodao_avatar = data.nft.imageUrl;
                }
                namesFound++;
            }
        } catch (e) { /* silent — name lookups are best-effort */ }
    });
    return { totalLookups: candidates.length, namesFound };
}

// -----------------------------------------------------------------------------
// DAODAO STAKER ENRICHMENT (cw20-staked path)
// -----------------------------------------------------------------------------
// Pagination: each `list_stakers` call returns at most 30. We follow `start_after`
// pagination up to a hard cap to avoid runaway calls on unbounded DAOs.
async function enrichWalletsWithDaodaoStakers(wallets, contracts) {
    const MAX_PAGES_PER_DAO = 20;       // ≈ 600 stakers max per DAO
    const PAGE_SIZE = 30;
    let totalDiscovered = 0;
    const perDaoCounts = {};

    const stakingContracts = Object.entries(contracts).filter(([, c]) =>
        c.subtype === 'staking' && (c.staking_module === 'cw20' || (!c.staking_module && c.protocol === 'DAODAO'))
    );

    if (stakingContracts.length === 0) {
        console.log('[daodao_stakers] No DAODAO staking contracts in catalog — skipping');
        return { totalDiscovered: 0, perDaoCounts };
    }

    for (const [contractAddr, contract] of stakingContracts) {
        const daoName = contract.label || contract.name || contractAddr.slice(0, 16);
        // staking_module hint from known_contracts.json — 'cw20' or 'cw721'.
        // cw721_staked DAOs use the dao_voting_cw721_staked module which does NOT expose
        // list_stakers; trying it returns HTTP 500 from the LCD. Skip explicitly to keep logs clean.
        const stakingModule = contract.staking_module || (contract.auto_data?.staking_module);
        if (stakingModule === 'cw721') {
            console.log(`[daodao_stakers] ${daoName}: skipped — cw721-staked (no enumeration query; needs NFT-contract walk, deferred to follow-up)`);
            perDaoCounts[daoName] = 'unsupported_cw721';
            continue;
        }

        let pageStart = null;
        let pageCount = 0;
        let daoCount = 0;

        try {
            while (pageCount < MAX_PAGES_PER_DAO) {
                pageCount++;
                const msg = { list_stakers: { limit: PAGE_SIZE, ...(pageStart ? { start_after: pageStart } : {}) } };
                const result = await queryContract(contractAddr, msg, `${daoName}.list_stakers[p${pageCount}]`);
                const batch = result?.stakers || result || [];
                if (!Array.isArray(batch) || batch.length === 0) break;

                for (const s of batch) {
                    const walletAddr = s.address || s.staker || s.owner;
                    if (!walletAddr || !walletAddr.startsWith('terra1')) continue;

                    if (wallets[walletAddr]) {
                        // Already in catalog (curated or previously discovered) — just
                        // annotate with DAO membership and stake balance.
                        const w = wallets[walletAddr];
                        w.dao_memberships = w.dao_memberships || [];
                        if (!w.dao_memberships.find(d => d.staking_contract === contractAddr)) {
                            w.dao_memberships.push({
                                dao: daoName,
                                staking_contract: contractAddr,
                                stake_balance: s.balance || s.amount || null,
                            });
                        }
                    } else {
                        wallets[walletAddr] = {
                            address: walletAddr,
                            category: 'wallets',
                            subtype: 'member',
                            protocol: 'DAODAO',
                            source: 'auto_discovered',
                            discovery_source: 'daodao_staker',
                            dao_memberships: [{
                                dao: daoName,
                                staking_contract: contractAddr,
                                stake_balance: s.balance || s.amount || null,
                            }],
                            verified: false,
                        };
                        daoCount++;
                        totalDiscovered++;
                    }

                    pageStart = walletAddr;
                }

                if (batch.length < PAGE_SIZE) break; // last page
            }
            perDaoCounts[daoName] = daoCount;
            console.log(`[daodao_stakers] ${daoName}: +${daoCount} new stakers (${pageCount} page${pageCount === 1 ? '' : 's'})`);
        } catch (e) {
            // Don't fail the cron — log and continue. The staking contract might use
            // a different query schema (some DAODAO modules don't expose list_stakers).
            console.warn(`[daodao_stakers] ${daoName} failed: ${e.message}`);
            perDaoCounts[daoName] = null; // null = failed (vs 0 = empty)
        }
    }

    return { totalDiscovered, perDaoCounts };
}

// -----------------------------------------------------------------------------
// TLA LOCK HOLDER ENRICHMENT (voting-escrow)
// -----------------------------------------------------------------------------
// Enumerates every veLUNA lock NFT on the voting-escrow contract, derives the
// per-holder summary (lock_count, total_vp, token_ids), and adds each holder to
// wallets_catalog with dao_memberships: [{dao: 'TLA', ...}].
//
// Cost: ~num_tokens chain queries (~431 today) at concurrency 3. The
// voting-escrow contract has lock_info per token which returns owner + VP +
// period in one call. We use lock_info instead of just owner_of so we can
// compute total VP per holder for the picker's sort key.
//
// Bounded to MAX_LOCKS so a runaway num_tokens value can't DoS the cron.
async function enrichWalletsWithTLALocks(wallets, votingEscrowAddr) {
    const MAX_LOCKS = 2000;
    const ENUMERATION_CONCURRENCY = 3;
    const PAGE_SIZE = 30;

    if (!votingEscrowAddr) {
        console.log('[tla_locks] No voting-escrow address — skipping');
        return { uniqueHolders: 0, totalLocks: 0, totalDiscovered: 0 };
    }

    // Step 1: paginate all_tokens to get every lock NFT ID
    let tokenIds = [];
    let pageStart = null;
    let pageCount = 0;
    try {
        while (pageCount < 100 && tokenIds.length < MAX_LOCKS) {
            pageCount++;
            const msg = { all_tokens: { limit: PAGE_SIZE, ...(pageStart ? { start_after: pageStart } : {}) } };
            const result = await queryContract(votingEscrowAddr, msg, `voting-escrow.all_tokens[p${pageCount}]`);
            const batch = result?.tokens || result || [];
            if (!Array.isArray(batch) || batch.length === 0) break;
            tokenIds.push(...batch);
            pageStart = batch[batch.length - 1];
            if (batch.length < PAGE_SIZE) break;
        }
    } catch (e) {
        console.warn(`[tla_locks] all_tokens enumeration failed: ${e.message}`);
        return { uniqueHolders: 0, totalLocks: 0, totalDiscovered: 0 };
    }
    console.log(`[tla_locks] enumerated ${tokenIds.length} lock NFTs (${pageCount} pages)`);

    if (tokenIds.length === 0) {
        return { uniqueHolders: 0, totalLocks: 0, totalDiscovered: 0 };
    }

    // Step 2: fetch lock_info for each in batched parallel
    const lockInfos = await batchedAsync(tokenIds, ENUMERATION_CONCURRENCY, async (token_id) => {
        try {
            const r = await queryContract(votingEscrowAddr, { lock_info: { token_id: String(token_id) } }, null);
            return r ? { token_id, owner: r.owner, voting_power: r.voting_power, end_period: r.end?.period } : null;
        } catch (e) {
            return null;
        }
    });
    const successfulInfos = lockInfos.filter(l => l && l.owner);
    console.log(`[tla_locks] fetched lock_info for ${successfulInfos.length}/${tokenIds.length} locks`);

    // Step 3: aggregate by owner
    const byOwner = {};
    for (const lock of successfulInfos) {
        if (!byOwner[lock.owner]) {
            byOwner[lock.owner] = { lock_count: 0, total_vp: 0, token_ids: [] };
        }
        byOwner[lock.owner].lock_count++;
        byOwner[lock.owner].total_vp += parseFloat(lock.voting_power || 0);
        byOwner[lock.owner].token_ids.push(lock.token_id);
    }

    // Step 4: add to wallets
    let newWallets = 0;
    for (const [owner, summary] of Object.entries(byOwner)) {
        const tlaMembership = {
            dao: 'TLA',
            kind: 'velluna_locker',
            total_vp: summary.total_vp,
            lock_count: summary.lock_count,
            token_ids: summary.token_ids,
        };
        if (!wallets[owner]) {
            wallets[owner] = {
                address: owner,
                category: 'wallets',
                subtype: 'member',
                protocol: 'TLA',
                source: 'auto_discovered',
                discovery_source: 'velluna_locker',
                dao_memberships: [tlaMembership],
                verified: false,
            };
            newWallets++;
        } else {
            const w = wallets[owner];
            w.dao_memberships = w.dao_memberships || [];
            if (!w.dao_memberships.find(m => m.dao === 'TLA')) {
                w.dao_memberships.push(tlaMembership);
            }
        }
    }

    return {
        uniqueHolders: Object.keys(byOwner).length,
        totalLocks: successfulInfos.length,
        totalDiscovered: newWallets,
    };
}

// -----------------------------------------------------------------------------
// DAODAO INDEXER (cw721-staked path)
// -----------------------------------------------------------------------------
// For DAODAO DAOs that use cw721 (NFT) staking, the on-chain contract doesn't
// expose list_stakers. The DAODAO indexer at indexer.daodao.zone derives staker
// lists from indexed wasm events and serves them via a public formula API.
//
// URL pattern (verified from DAODAO HAR captures):
//   https://indexer.daodao.zone/phoenix-1/contract/{voting_module}/daoVotingCw721Staked/topStakers
// Returns: [{ address, count, votingPowerPercent }, ...] sorted desc by count
//
// This is what powers the "Members" page on daodao.zone. If the indexer is
// down (rare) we log and skip — no fallback enumeration path.
async function enrichWalletsWithDaodaoIndexer(wallets, contracts) {
    const CHAIN_ID = 'phoenix-1';
    const INDEXER_BASE = 'https://indexer.daodao.zone';
    const cw721Contracts = Object.entries(contracts).filter(([, c]) =>
        c.subtype === 'staking' && c.staking_module === 'cw721'
    );

    if (cw721Contracts.length === 0) {
        return { totalDiscovered: 0, perDaoCounts: {} };
    }

    let totalDiscovered = 0;
    const perDaoCounts = {};

    for (const [contractAddr, contract] of cw721Contracts) {
        const daoName = contract.label || contract.name || contractAddr.slice(0, 16);
        const url = `${INDEXER_BASE}/${CHAIN_ID}/contract/${contractAddr}/daoVotingCw721Staked/topStakers`;

        try {
            const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (!r.ok) {
                console.log(`[daodao_indexer] ${daoName}: HTTP ${r.status} from indexer — skipped`);
                perDaoCounts[daoName] = 'http_error';
                continue;
            }
            const stakers = await r.json();
            if (!Array.isArray(stakers)) {
                console.log(`[daodao_indexer] ${daoName}: unexpected response shape — skipped`);
                perDaoCounts[daoName] = 'bad_shape';
                continue;
            }

            let daoCount = 0;
            for (const s of stakers) {
                const addr = s.address;
                if (!addr || !addr.startsWith('terra1')) continue;

                const membership = {
                    dao: daoName,
                    kind: 'cw721_staker',
                    staking_contract: contractAddr,
                    nft_count: s.count || null,
                    voting_power_percent: s.votingPowerPercent || null,
                };

                if (!wallets[addr]) {
                    wallets[addr] = {
                        address: addr,
                        category: 'wallets',
                        subtype: 'member',
                        protocol: 'DAODAO',
                        source: 'auto_discovered',
                        discovery_source: 'daodao_indexer',
                        dao_memberships: [membership],
                        verified: false,
                    };
                    daoCount++;
                    totalDiscovered++;
                } else {
                    const w = wallets[addr];
                    w.dao_memberships = w.dao_memberships || [];
                    if (!w.dao_memberships.find(m => m.staking_contract === contractAddr)) {
                        w.dao_memberships.push(membership);
                    }
                }
            }
            perDaoCounts[daoName] = daoCount;
            console.log(`[daodao_indexer] ${daoName}: ${stakers.length} stakers from indexer (+${daoCount} new wallets)`);
        } catch (e) {
            console.log(`[daodao_indexer] ${daoName}: ${e.message.slice(0, 80)} — skipped`);
            perDaoCounts[daoName] = 'exception';
        }
    }

    return { totalDiscovered, perDaoCounts };
}


function findUnmapped({ tokens }) {
    const unmappedTokens = [];
    for (const [addr, t] of Object.entries(tokens)) {
        if (t.appears_in.tla_pools_count > 0 && !t.display_name && !t.symbol) {
            // LP tokens are expected to be unnamed from chain-registry; only
            // surface them as truly "needs curation" if Astroport AND SS
            // also failed to name them (rare — usually one of them will).
            const isLikelyLp = t.category === 'lp_tokens';
            const namedByDex = t.sources.astroport?.symbol || t.sources.skeletonswap?.symbol;
            unmappedTokens.push({
                address: addr,
                appears_in_pools: t.appears_in.tla_pools,
                is_likely_lp: isLikelyLp,
                named_by_dex: !!namedByDex,
                note: isLikelyLp
                    ? (namedByDex
                        ? 'LP token — named by DEX (no curation needed)'
                        : 'LP token — no DEX returned a name. Check Astroport / SS reachability.')
                    : 'Token in TLA pool but unnamed from any source — needs curation',
            });
        }
    }
    return { tokens: unmappedTokens, contracts: [], wallets: [] };
}

// -----------------------------------------------------------------------------
// FRESHNESS
// -----------------------------------------------------------------------------

function computeDataFingerprint(snapshot) {
    const items = (snapshot.pools || [])
        .map(p => [p.gauge_pool_id, p.bucket, p.distribution_pct])
        .sort((a, b) => a[0].localeCompare(b[0]));
    const input = JSON.stringify({
        epoch: snapshot.canonicalEpoch,
        directory_size: Object.keys(snapshot.directory || {}).length,
        tokens_count: Object.keys(snapshot.tokens || {}).length,
        contracts_count: Object.keys(snapshot.contracts_catalog || {}).length,
        pools: items,
    });
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

async function fetchPreviousHeartbeat() {
    try {
        const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/2026/heartbeat.json`;
        return await fetchJson(url, 'previous-heartbeat');
    } catch (e) { return null; }
}

function classifyFreshness(currentFp, prev) {
    if (!prev || !prev.dataFingerprint) {
        return { dataFreshness: 'fresh', consecutiveStuckRuns: 0, previousFingerprint: null };
    }
    const previousFingerprint = prev.dataFingerprint;
    if (currentFp !== previousFingerprint) {
        return { dataFreshness: 'fresh', consecutiveStuckRuns: 0, previousFingerprint };
    }
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
    const watchdog = setTimeout(() => {
        console.error(`\n❌ Watchdog: exceeded ${MAX_RUNTIME_MS / 1000}s runtime ceiling`);
        process.exit(2);
    }, MAX_RUNTIME_MS);
    watchdog.unref();

    const chainData = await captureChainRegistry();
    const { startedAt, errors, canonicalEpoch, directory, pools, buckets, raw } = chainData;

    const external = await fetchExternalSources();
    const curated = await fetchCurated();

    console.log('\n🔧 Indexing sources by address...');
    const chainRegIdx = indexChainRegistry(external.cosmos_chain_registry);
    const erisIdx     = indexErisPrices(external.eris_prices);
    const astroIdx    = indexAstroport(external.astroport_pools);
    const ssIdx       = indexSkeletonSwap(external.skeletonswap_pools);
    const amplpInfo   = indexAmplpMapping(raw.asset_compounder_asset_configs);
    console.log(`   chain-registry: ${Object.keys(chainRegIdx).length} tokens`);
    console.log(`   eris:           ${Object.keys(erisIdx).length} tokens`);
    console.log(`   astroport:      ${Object.keys(astroIdx).length} tokens`);
    console.log(`   skeletonswap:   ${Object.keys(ssIdx).length} tokens`);
    console.log(`   amplp_mappings: ${Object.keys(amplpInfo.mapping).length}`);

    // -------------------------------------------------------------------------
    // SCOPE PHASE — build the in-scope address set BEFORE buildTokenCatalog,
    // so stages 1-4 there can filter at the source.
    // -------------------------------------------------------------------------
    // Step A: extend pools beyond the 28 active to include below-threshold
    //         LPs (each bucket's asset-staking contract has the full whitelist).
    //         Defensive — if the chain query schema doesn't match, this
    //         silently falls back to active-only.
    // Step B: for each LP (cw20 only), discover its two underlying token
    //         addresses by querying the LP's `minter` (Astroport pair address)
    //         then the pair's `pair{}` query for asset_infos. Both LP and
    //         underlyings go in the scope set.
    // Step C: also include each LP's amplp denom (auto-compounded wrapper) so
    //         those records aren't dropped from the catalog.
    //
    // No matter what fails, the active 28 LP addresses are always in scope.
    console.log('\n🎯 SCOPE PHASE (brief 2.21): building in-scope address set');
    console.log(`   start: ${pools.length} active pools`);

    let extraPoolsResult = { extraPools: [], stats: { contractsChecked: 0, contractsSucceeded: 0, extraLpsFound: 0 } };
    try {
        extraPoolsResult = await expandToInactiveLPs(pools, directory);
        console.log(`   step A: asset-staking[*].whitelisted_assets — ${extraPoolsResult.stats.contractsSucceeded}/${extraPoolsResult.stats.contractsChecked} buckets returned data, +${extraPoolsResult.stats.extraLpsFound} inactive LPs`);
    } catch (e) {
        console.warn(`   step A failed (continuing with active-only): ${e.message}`);
    }
    const allPools = [...pools, ...extraPoolsResult.extraPools];
    console.log(`   total LPs after step A: ${allPools.length}`);

    let universe = { lpAddrs: new Set(), underlyings: new Set(), lpToUnderlyings: {}, stats: { totalLps: 0, pairLookupSucceeded: 0, pairLookupFailed: 0, nativeLpsSkipped: 0 } };
    try {
        universe = await buildLpUniverse(allPools);
        console.log(`   step B: pair{} lookups — ${universe.stats.pairLookupSucceeded} succeeded, ${universe.stats.pairLookupFailed} failed, ${universe.stats.nativeLpsSkipped} native LPs skipped`);
        console.log(`           ${universe.lpAddrs.size} LP addresses, ${universe.underlyings.size} underlying token addresses`);
    } catch (e) {
        console.warn(`   step B failed (will scope to LPs only, no underlyings): ${e.message}`);
        // Minimal safety net: always include the LP addresses themselves
        for (const p of allPools) {
            const a = p.asset_raw?.cw20 || p.asset_raw?.native;
            if (a) universe.lpAddrs.add(a);
        }
    }

    // Build the final scope set: LPs + their underlyings + amplp denoms
    const scopeAddrs = new Set();
    for (const a of universe.lpAddrs) scopeAddrs.add(a);
    for (const a of universe.underlyings) scopeAddrs.add(a);
    // Step C: amplp denoms (auto-compounded LP wrappers) — these wrap an LP
    // that's already in scope, so the amplp's own factory denom should be too.
    // The amplp denom IS the dict key in amplpInfo.mapping (e.g.
    // "factory/.../single/amplp"). Earlier this code looked inside the value
    // object for an amplp_denom field that doesn't exist — fixed to iterate keys.
    let amplpAdded = 0;
    for (const amplpDenom of Object.keys(amplpInfo.mapping)) {
        if (amplpDenom && !scopeAddrs.has(amplpDenom)) {
            scopeAddrs.add(amplpDenom);
            amplpAdded++;
        }
    }
    console.log(`   step C: +${amplpAdded} amplp denoms`);

    // Step D: amplp wrapped-LP underlyings (brings wBTC.osmo, wBTC.axl, dATOM,
    // SWTH, etc. into scope as their own token entries).
    //
    // Each amplp wraps an `underlying_lp_address`. Many of those LPs ARE in
    // our TLA gauge whitelist already (so already in scope). But amplps also
    // exist for LPs OUTSIDE TLA's gauge (broader Eris product). The
    // underlyings of those LPs — wBTC.osmo, wBTC.axl, dATOM, SWTH, etc. —
    // only appear in display names like "WBTC.axl-WBTC.osmo AMPLP" but never
    // become real token entries in the catalog. This step fixes that.
    let extraLpsResolved = 0;
    let extraUnderlyings = 0;
    for (const info of Object.values(amplpInfo.mapping)) {
        const underlyingLp = info.underlying_lp_address;
        if (!underlyingLp) continue;
        // Skip if we already resolved this LP (TLA gauge LPs)
        if (universe.lpAddrs.has(underlyingLp) && universe.lpToUnderlyings[underlyingLp]) continue;
        // Pair-resolve it
        let pairAddr = null;
        if (underlyingLp.startsWith('factory/')) {
            // Astroport native LP: factory/{PAIR_ADDR}/uLP — extract pair addr
            const m = underlyingLp.match(/^factory\/(terra1[a-z0-9]+)\//);
            if (m) pairAddr = m[1];
        } else {
            // cw20 LP: query minter → pair address
            const minterResp = await queryContract(underlyingLp, { minter: {} }, `amplp-lp[${underlyingLp.slice(-8)}].minter`);
            pairAddr = minterResp?.minter || minterResp?.address;
        }
        if (!pairAddr) continue;
        const pairResp = await queryContract(pairAddr, { pair: {} }, `amplp-pair[${pairAddr.slice(-8)}].pair`);
        if (!pairResp || !Array.isArray(pairResp.asset_infos)) continue;
        extraLpsResolved++;
        scopeAddrs.add(underlyingLp);  // also include the wrapped LP token
        const u = [];
        for (const ai of pairResp.asset_infos) {
            const t = ai.token?.contract_addr || ai.native_token?.denom;
            if (t && !scopeAddrs.has(t)) {
                scopeAddrs.add(t);
                extraUnderlyings++;
                u.push(t);
            } else if (t) {
                u.push(t);  // already in scope but track underlying for the LP
            }
        }
        if (u.length) universe.lpToUnderlyings[underlyingLp] = u;
    }
    console.log(`   step D: amplp wrapped-LP universe — resolved ${extraLpsResolved} extra LPs, +${extraUnderlyings} extra underlying tokens`);

    console.log(`   FINAL SCOPE: ${scopeAddrs.size} addresses (was ${Object.keys(chainRegIdx).length + Object.keys(erisIdx).length + Object.keys(astroIdx).length + Object.keys(ssIdx).length} candidates from external sources)`);

    // Save scope stats for the heartbeat
    const scopeStats = {
        active_lps:                 pools.length,
        inactive_lps_discovered:    extraPoolsResult.stats.extraLpsFound,
        total_lps:                  allPools.length,
        pair_lookups_succeeded:     universe.stats.pairLookupSucceeded,
        pair_lookups_failed:        universe.stats.pairLookupFailed,
        native_lps_skipped:         universe.stats.nativeLpsSkipped,
        underlyings_discovered:     universe.underlyings.size,
        amplp_denoms_added:         amplpAdded,
        amplp_wrapped_lps_resolved: extraLpsResolved,
        amplp_extra_underlyings:    extraUnderlyings,
        total_in_scope_addresses:   scopeAddrs.size,
        whitelist_buckets_checked:  extraPoolsResult.stats.contractsChecked,
        whitelist_buckets_succeeded: extraPoolsResult.stats.contractsSucceeded,
    };

    console.log('\n🧬 Building catalog (scope-filtered)...');
    const tokens = buildTokenCatalog({ pools: allPools, chainRegIdx, erisIdx, astroIdx, ssIdx, amplpInfo, curated, scopeAddrs, lpToUnderlyings: universe.lpToUnderlyings });
    const { contracts, wallets } = buildContractsCatalog({ directory, curated });
    const unmapped = findUnmapped({ tokens });
    console.log(`   tokens:    ${Object.keys(tokens).length} (in-scope only; previously enumerated whole chain)`);
    console.log(`   contracts: ${Object.keys(contracts).length}`);
    console.log(`   wallets:   ${Object.keys(wallets).length} (curated only)`);
    console.log(`   unmapped:  ${unmapped.tokens.length}`);

    // Enrich wallets with DAODAO stakers (Lion DAO, Pixel Lions, etc.)
    console.log('\n🦁 Enriching wallets from DAODAO staking contracts (cw20 path)...');
    let stakerEnrichment = { totalDiscovered: 0, perDaoCounts: {} };
    try {
        stakerEnrichment = await enrichWalletsWithDaodaoStakers(wallets, contracts);
        console.log(`   discovered: ${stakerEnrichment.totalDiscovered} new staker wallets`);
    } catch (e) {
        console.warn(`   ⚠ cw20 staker enrichment failed entirely: ${e.message}`);
        errors.push({ stage: 'daodao_stakers', error: e.message });
    }

    // Enrich wallets via DAODAO indexer for cw721-staked DAOs (Pixel Lions, etc.)
    console.log('\n🦁 Enriching wallets via DAODAO indexer (cw721 path)...');
    let indexerEnrichment = { totalDiscovered: 0, perDaoCounts: {} };
    try {
        indexerEnrichment = await enrichWalletsWithDaodaoIndexer(wallets, contracts);
        console.log(`   discovered: ${indexerEnrichment.totalDiscovered} new staker wallets via indexer`);
    } catch (e) {
        console.warn(`   ⚠ indexer enrichment failed entirely: ${e.message}`);
        errors.push({ stage: 'daodao_indexer', error: e.message });
    }

    // Enrich wallets with TLA lock holders (voting-escrow enumeration)
    console.log('\n🔒 Enriching wallets from TLA voting-escrow locks...');
    let tlaEnrichment = { uniqueHolders: 0, totalLocks: 0, totalDiscovered: 0 };
    try {
        tlaEnrichment = await enrichWalletsWithTLALocks(wallets, chainData.votingEscrowAddr);
        console.log(`   scanned ${tlaEnrichment.totalLocks} locks · ${tlaEnrichment.uniqueHolders} unique holders · ${tlaEnrichment.totalDiscovered} new wallets`);
    } catch (e) {
        console.warn(`   ⚠ TLA lock enrichment failed entirely: ${e.message}`);
        errors.push({ stage: 'tla_locks', error: e.message });
    }

    // Look up DAODAO PFPK profile names for every discovered wallet
    console.log('\n🎭 Looking up DAODAO profile names (PFPK)...');
    let pfpkEnrichment = { totalLookups: 0, namesFound: 0 };
    try {
        pfpkEnrichment = await enrichWalletsWithPfpkNames(wallets);
        console.log(`   ${pfpkEnrichment.totalLookups} addresses checked · ${pfpkEnrichment.namesFound} profile names found`);
    } catch (e) {
        console.warn(`   ⚠ PFPK lookup failed entirely: ${e.message}`);
        errors.push({ stage: 'pfpk_names', error: e.message });
    }

    console.log(`\n   wallets total: ${Object.keys(wallets).length} (curated + discovered from all sources)`);

    const snapshot = {
        schemaVersion: SCHEMA_VERSION, cron: CRON_NAME,
        layer: 0, layerRole: 'discovery-bootstrap-catalog',
        capturedAt: startedAt.toISOString(), capturedAtUnix: startedAt.getTime(),
        canonicalEpoch,
        directory, pools: allPools, buckets,
        // pools = active 28; allPools = active + inactive discovered via
        // asset-staking.whitelisted_assets per brief 2.21. The consumer can
        // distinguish via each pool's `gauge_status` field (active pools have
        // no such field; inactive ones get 'inactive_below_threshold').
        scope: {
            ...scopeStats,
            lp_to_underlyings: universe.lpToUnderlyings,
        },
        contracts: {
            global_config: GLOBAL_CONFIG_ADDR,
            asset_gauge: chainData.assetGaugeAddr || null,
            voting_escrow: chainData.votingEscrowAddr || null,
            asset_compounder: chainData.assetCompounderAddr || null,
        },
        tokens,
        amplp_mappings: amplpInfo.mapping,
        lp_to_amplp: amplpInfo.lpToAmplp,
        contracts_catalog: contracts,
        wallets_catalog: wallets,
        protocols: curated.protocols || {},
        categories: curated.categories || {},
        _unmapped: unmapped,
        raw, _errors: errors, source_errors: external.source_errors,
        sources: { primary_lcd: TERRA_LCD_PRIMARY, fallback_lcd: TERRA_LCD_FALLBACK },
    };

    const dataFingerprint = computeDataFingerprint(snapshot);
    const prevHeartbeat = await fetchPreviousHeartbeat();
    const freshness = classifyFreshness(dataFingerprint, prevHeartbeat);
    const freshnessIcon = { fresh: '✓', suspicious: '⚠', stuck: '🔴' }[freshness.dataFreshness];
    console.log(`\n🔍 Freshness: ${freshnessIcon} ${freshness.dataFreshness} (fp ${dataFingerprint}, prev ${freshness.previousFingerprint || '(none)'})`);

    let status = 'ok';
    if (freshness.dataFreshness === 'stuck') status = 'stuck';
    else if (errors.length > 0 || Object.keys(external.source_errors).length > 0) status = 'partial';

    const tierCounts = { core: 0, tracked: 0, noise: 0 };
    for (const t of Object.values(tokens)) {
        if (t.tier && tierCounts[t.tier] != null) tierCounts[t.tier]++;
    }
    // Acquisition class breakdown (brief 2.21 follow-up — Camron's 4 buckets):
    const acqClassCounts = { native_terra: 0, ibc_cosmos_native: 0, wrapped_disclosed: 0, wrapped_looks_native: 0, lp_token: 0, unclassified: 0 };
    for (const t of Object.values(tokens)) {
        const cls = t.acquisition_class || 'unclassified';
        if (acqClassCounts[cls] != null) acqClassCounts[cls]++;
        else acqClassCounts.unclassified++;
    }

    const heartbeat = {
        schemaVersion: SCHEMA_VERSION, cron: CRON_NAME,
        capturedAt: startedAt.toISOString(), capturedAtUnix: startedAt.getTime(),
        runId: `tla-registry-${startedAt.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
        runMode: 'daily', status, canonicalEpoch,
        stats: {
            directory_size: Object.keys(directory).length,
            pool_count: pools.length,
            bucket_count: Object.keys(buckets).length,
            tokens_catalog: Object.keys(tokens).length,
            tokens_core: tierCounts.core,
            tokens_tracked: tierCounts.tracked,
            tokens_noise: tierCounts.noise,
            contracts_catalog: Object.keys(contracts).length,
            wallets_catalog: Object.keys(wallets).length,
            wallets_discovered_via_daodao: stakerEnrichment.totalDiscovered,
            wallets_discovered_via_indexer: indexerEnrichment.totalDiscovered,
            wallets_discovered_via_tla_locks: tlaEnrichment.totalDiscovered,
            wallets_per_dao: stakerEnrichment.perDaoCounts,
            indexer_per_dao: indexerEnrichment.perDaoCounts,
            tla_unique_holders: tlaEnrichment.uniqueHolders,
            tla_total_locks_scanned: tlaEnrichment.totalLocks,
            pfpk_names_found: pfpkEnrichment.namesFound,
            pfpk_lookups_attempted: pfpkEnrichment.totalLookups,
            amplp_mappings: Object.keys(amplpInfo.mapping).length,
            unmapped_tokens: unmapped.tokens.length,
            chain_errors: errors.length,
            external_source_errors: Object.keys(external.source_errors).length,
            // Scope phase (brief 2.21) — how the in-scope set was built
            scope: scopeStats,
            // Acquisition class breakdown (brief 2.21 follow-up)
            acquisition_classes: acqClassCounts,
        },
        dataFingerprint, previousFingerprint: freshness.previousFingerprint,
        dataFreshness: freshness.dataFreshness,
        consecutiveStuckRuns: freshness.consecutiveStuckRuns,
        next_expected_run_at: new Date(startedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    };

    const dateStr = startedAt.toISOString().slice(0, 10);
    const year = dateStr.slice(0, 4);
    const baseDir = year;

    if (!GITHUB_TOKEN) {
        console.log('\n⚠️  GITHUB_TOKEN not set — printing summary instead of pushing.\n');
        console.log(JSON.stringify(heartbeat, null, 2));
        clearTimeout(watchdog);
        return;
    }

    console.log('\n📤 Publishing to GitHub...');
    const snapshotJson = JSON.stringify(snapshot, null, 2);
    const heartbeatJson = JSON.stringify(heartbeat, null, 2);
    const epochLabel = canonicalEpoch != null ? ` (epoch ${canonicalEpoch})` : '';

    await pushToGithub(`${baseDir}/current.json`,          snapshotJson, `🔗 Layer 0 v2 catalog${epochLabel}`);
    await pushToGithub(`${baseDir}/daily/${dateStr}.json`, snapshotJson, `🔗 Layer 0 daily archive ${dateStr}${epochLabel}`);
    await pushToGithub(`${baseDir}/heartbeat.json`,        heartbeatJson, `📍 Layer 0 heartbeat (${freshness.dataFreshness}${epochLabel})`);

    const elapsed = ((Date.now() - runStartedAt) / 1000).toFixed(1);
    console.log(`\n✅ Done in ${elapsed}s — status=${status}, tokens=${Object.keys(tokens).length}, contracts=${Object.keys(contracts).length}, unmapped=${unmapped.tokens.length}\n`);
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
    captureChainRegistry, fetchExternalSources, fetchCurated,
    indexChainRegistry, indexErisPrices, indexAstroport, indexSkeletonSwap, indexAmplpMapping,
    buildTokenCatalog, buildContractsCatalog, findUnmapped,
};
