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
// CoinGecko's full coin list with platform contract addresses. We use this
// for INDEPENDENT verification of CG mappings — when Eris claims a token
// maps to a particular CG ID, we cross-check by looking up the contract
// address in CG's own platform index. This catches:
//   - missing mappings (Eris doesn't have a CG ID but CG actually does)
//   - wrong mappings (Eris claims X but CG has the same address as Y)
//   - unverified mappings (CG doesn't index this address at all)
const URL_COINGECKO_LIST = 'https://api.coingecko.com/api/v3/coins/list?include_platform=true';

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
        coingecko_list: null,
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

    // E5: CoinGecko coin list with platform addresses. Used for independent
    // verification of CG mappings — we look up our token addresses in CG's
    // own Terra-2 platform index. Failure here is non-critical (catalog
    // still works, just without the verification stage).
    console.log('   E5: CoinGecko coin list (independent CG verification)');
    sources.coingecko_list = await tryFetchJson(URL_COINGECKO_LIST, 'coingecko-list');
    if (sources.coingecko_list && Array.isArray(sources.coingecko_list)) {
        // Count Terra-2 addresses in the list to confirm we got real data
        let t2count = 0;
        for (const coin of sources.coingecko_list) {
            const p = coin.platforms || {};
            if (p['terra-2'] || p['terra2']) t2count++;
        }
        console.log(`      ✓ ${sources.coingecko_list.length} coins, ${t2count} with terra-2 contract addresses`);
    } else {
        sources.source_errors.coingecko_list = 'fetch failed';
    }

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
    const stats = {
        contractsChecked: 0,
        contractsSucceeded: 0,
        extraLpsFound: 0,
        whitelistedFound: 0,         // whitelisted:true entries discovered (excluding already-active)
        dewhitelistedFound: 0,       // whitelisted:false entries (still subject to take rate)
    };

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

        // Use `whitelisted_asset_details` (the query Eris's own UI uses).
        // This returns BOTH currently-whitelisted LPs AND previously-whitelisted
        // (`whitelisted: false`) LPs that still have stakes accruing take rate.
        // The older `whitelisted_assets` query only returned the active subset,
        // which is why we missed boneLUNA, plain wBNB, rSWTH, wETH-wstETH and
        // others that users may still have stakes in.
        //
        // Each entry shape:
        //   { info: { cw20|native: <addr> }, whitelisted: bool,
        //     config: { last_taken_s, taken, harvested, yearly_take_rate,
        //               stake_config: {...} | "default" } }
        const result = await queryContract(stakingAddr, { whitelisted_asset_details: {} }, `asset-staking[${bucketName}].whitelisted_asset_details`);
        if (!result) {
            // Query failed — log but don't fail the whole cron. Active-only fallback.
            continue;
        }
        stats.contractsSucceeded++;

        // Response is an array of detail entries (sometimes wrapped under {data}).
        let assetList = result;
        if (result && typeof result === 'object' && !Array.isArray(result)) {
            assetList = result.data || result.assets || result.whitelisted_assets || result.list || [];
        }
        if (!Array.isArray(assetList)) continue;

        for (const entry of assetList) {
            // Each entry has .info (the asset_info) and .config (the take-rate config)
            // plus a top-level .whitelisted boolean.
            const info = entry?.info;
            if (!info || typeof info !== 'object') continue;
            const lpAddr = info.cw20 || info.native;
            if (!lpAddr) continue;

            const gaugePoolId = info.cw20 ? `cw20:${info.cw20}` : `native:${info.native}`;
            if (activeKeys.has(gaugePoolId)) continue;  // already in the active gauge set

            const isWhitelisted = entry.whitelisted === true;
            const cfg = entry.config || {};

            // Three buckets of status for non-active pools:
            //   - whitelisted:true  → in whitelist but no gauge votes ("below threshold")
            //   - whitelisted:false → previously whitelisted, removed from active set,
            //                          stakes still exposed to take rate ("dewhitelisted")
            const gaugeStatus = isWhitelisted
                ? 'inactive_below_threshold'
                : 'dewhitelisted';

            if (isWhitelisted) stats.whitelistedFound++;
            else stats.dewhitelistedFound++;

            // Determine pool type from stake_config shape: object with
            // `astroport` key = cw20 LP staked on Astroport gauge; string "default"
            // = native LP staked through Eris's own mechanism.
            let stakeMechanism = null;
            if (cfg.stake_config === 'default') {
                stakeMechanism = 'default';
            } else if (cfg.stake_config && typeof cfg.stake_config === 'object') {
                stakeMechanism = Object.keys(cfg.stake_config)[0] || null;
            }

            extraPools.push({
                gauge_pool_id: gaugePoolId,
                bucket: bucketName,
                asset_raw: info,
                distribution_pct: 0,         // not earning emissions this epoch
                total_vp: null,              // VP info doesn't come from this query
                gauge_status: gaugeStatus,
                // Take-rate metadata (preserved on the pool, applied to LP token in Stage 5)
                take_rate: {
                    yearly_rate: cfg.yearly_take_rate || null,    // e.g. "0.1" = 10%/yr
                    taken_raw: cfg.taken || null,                  // cumulative units taken
                    harvested_raw: cfg.harvested || null,          // cumulative units harvested
                    last_taken_s: cfg.last_taken_s || null,        // unix seconds
                    stake_mechanism: stakeMechanism,               // "astroport" or "default"
                },
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

        // Detect self-referential "pair" responses. Eris's single-asset
        // compounder vaults (e.g. ampCAPA at factory/terra186rpf.../ampCAPA)
        // respond to pair{} as if they were 2-asset LPs, returning their
        // input asset AND themselves as the "underlyings". They're NOT real
        // LP pairs — they're staking vaults.
        //
        // Without this detection:
        //   - is_amplp_underlying gets cascaded to the wrapper itself (self)
        //   - the input asset (CAPA) gets falsely credited as participating
        //     in the single-bucket pool (it doesn't — ampCAPA does)
        //   - tla_pools_count double-counts via Stage 5b
        //
        // Detection signal: lpAddr appears in its own resolved underlyings.
        // We strip the self-reference AND tag the entry so downstream stages
        // can treat it as a single-asset stake/vault rather than an LP pair.
        if (u.includes(lpAddr)) {
            const cleaned = u.filter(x => x !== lpAddr);
            lpToUnderlyings[lpAddr] = cleaned;
            // Mark this LP entry as a vault (single-asset stake) so consumers
            // can distinguish vault from real LP pair
            lpToUnderlyings[lpAddr]._is_vault = true;
            stats.selfReferentialVaultsDetected = (stats.selfReferentialVaultsDetected || 0) + 1;
        } else {
            lpToUnderlyings[lpAddr] = u;
        }
    }

    return { lpAddrs, underlyings, lpToUnderlyings, stats };
}


function buildTokenCatalog({ pools, chainRegIdx, erisIdx, astroIdx, ssIdx, amplpInfo, curated, scopeAddrs, lpToUnderlyings, cgList }) {
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
        // Gauge status: 'active' | 'inactive_below_threshold' | 'dewhitelisted'
        // - active: in active gauge with positive emissions
        // - inactive_below_threshold: whitelisted but below 1% vote share, no emissions
        // - dewhitelisted: previously whitelisted, removed — stakes still subject to take rate
        // (Pools coming directly from gauge distributions don't have gauge_status set;
        // those are implicitly 'active'.)
        t.appears_in.gauge_status = pool.gauge_status || 'active';
        // Take-rate metadata (only present for inactive/dewhitelisted from whitelisted_asset_details)
        if (pool.take_rate) {
            t.appears_in.take_rate = pool.take_rate;
        }
        if (!t.type) t.type = pool.gauge_pool_id.startsWith('cw20:') ? 'cw20' : 'factory';
    }

    // Stage 5b: Backfill underlying-token participation in TLA pools
    // Without this, LUNA — which underlies basically every TLA pool — shows
    // "Appears in TLA pools: no" because the stage above only credits the
    // LP token itself. The cron has lpToUnderlyings from the scope phase, so
    // we credit each underlying for every LP it appears in.
    //
    // DEDUP: track which (token_addr, lp_addr) pairs we've already credited.
    // Without this, single-asset stakes that ARE their own underlying (e.g.
    // ampCAPA wrapped by ampCAPA AMPLP — the wrapper's underlying_lp_address
    // points to ampCAPA itself) get incremented twice: once for Stage 5 (own
    // pool) and once here (as "underlying" of its own amplp). Same address
    // appearing in pools[] AND in lpToUnderlyings = double-credit.
    if (lpToUnderlyings && typeof lpToUnderlyings === 'object') {
        // Group pools by LP address so we can match each LP back to its bucket
        const poolByLpAddr = {};
        for (const pool of pools) {
            const lpAddr = pool.asset_raw?.cw20 || pool.asset_raw?.native;
            if (lpAddr) poolByLpAddr[lpAddr] = pool;
        }
        // Track which (uAddr, poolBucket) pairs are already credited from Stage 5
        // — so we don't credit the same token-bucket pair twice.
        const alreadyCredited = new Set();
        for (const pool of pools) {
            const lpAddr = pool.asset_raw?.cw20 || pool.asset_raw?.native;
            if (lpAddr) alreadyCredited.add(`${lpAddr}|${pool.bucket}`);
        }
        for (const [lpAddr, underlyings] of Object.entries(lpToUnderlyings)) {
            const pool = poolByLpAddr[lpAddr];
            if (!pool || !Array.isArray(underlyings)) continue;
            for (const uAddr of underlyings) {
                if (uAddr === lpAddr) continue;  // skip self-reference (vault, not LP)
                const ut = tokens[uAddr];
                if (!ut) continue;
                const dedupKey = `${uAddr}|${pool.bucket}`;
                if (alreadyCredited.has(dedupKey)) continue;  // already counted in Stage 5
                alreadyCredited.add(dedupKey);
                ut.appears_in.tla_pools_count += 1;
                if (!ut.appears_in.tla_pools.includes(pool.bucket)) {
                    ut.appears_in.tla_pools.push(pool.bucket);
                }
            }
        }
    }

    // Stage 5c: ensure every amplp factory denom has a token record
    //
    // Some amplp denoms (typically ones wrapping legacy/inactive LPs like
    // arbLUNA-LUNA, WHALE-bWHALE, USDC-USDt variants, LUNA-wSOL.wh) aren't
    // published in Eris's /prices endpoint. Without this stage they exist
    // in amplp_mappings but never get token records — they're missing from
    // the catalog entirely. We synthesize a minimal record using what we
    // know from amplp_mappings: bucket, wrapped LP address, reward asset.
    // The headline name is derived from the wrapped LP (e.g. "arbLUNA-LUNA AMPLP").
    let synthAmplps = 0;
    for (const [amplpDenom, info] of Object.entries(amplpInfo.mapping)) {
        if (!info) continue;
        if (tokens[amplpDenom]) continue;  // already populated by Eris/another source
        const t = get(amplpDenom);
        t.type = 'factory';
        t.subtype = 'amplp';
        // Derive a name from the wrapped LP. The wrapped LP token should already
        // be in our catalog (it came in via pools or amplp scope expansion).
        const wrappedLp = info.underlying_lp_address;
        const wrappedTok = wrappedLp ? tokens[wrappedLp] : null;
        const wrappedName = (wrappedTok && (
            wrappedTok.headline_name ||
            wrappedTok.sources?.eris?.display ||
            wrappedTok.display_name ||
            wrappedTok.symbol
        )) || null;
        if (wrappedName) {
            // Append " AMPLP" suffix unless the name already contains it
            const nameHasAmplp = /AMPLP|ampLP/.test(wrappedName);
            const synthName = nameHasAmplp
                ? wrappedName
                : wrappedName.replace(/ LP(?:\s*\(S\))?$/i, '').trim() + ' AMPLP';
            t.display_name = synthName;
            t.symbol = synthName;
        }
        // Decimals on amplp factory denoms are 6 (TLA convention for factory tokens)
        t.decimals = 6;
        synthAmplps++;
    }
    if (synthAmplps > 0) {
        console.log(`   Stage 5c: synthesized ${synthAmplps} amplp records (not in external sources)`);
    }

    // Stage 5d: Normalize ALL amplp tokens (whether synthesized in 5c or
    // pre-existing from Eris). Two bug classes this fixes:
    //
    //   Bug A: subtype inheritance. Tokens that came in via Eris's /prices
    //   are factory denoms and get subtype='native' from the generic catch-all
    //   later. Worse, the LST regex at the same later stage matches symbols
    //   like 'arbLUNA-LUNA AMPLP' (starts with arb + contains luna) and
    //   reclassifies them as 'lst'. Result before fix: 10 of 65 amplps had
    //   subtype='amplp'; the rest were 'native' or 'lst'.
    //   Stage 5d forces subtype='amplp' for everything in amplp_mappings,
    //   and the LST regex below has a guard to skip already-amplp tokens.
    //
    //   Bug B: tla_pools_count always 0 for amplps. Amplps don't appear in
    //   pools[] directly (the gauge whitelists the LP, not the amplp) and
    //   aren't in lpToUnderlyings. So Stage 5 and 5b never credit them.
    //   But conceptually amplps DEFINITELY participate in TLA pools — you
    //   stake the amplp to participate in the LP's bucket. Stage 5d mirrors
    //   the underlying LP's appears_in.tla_pools onto the amplp (with
    //   mapping.bucket fallback for cases where the underlying LP isn't
    //   itself in pools[]). Also tracks wraps_lp_address so the page can
    //   render a "Wraps: <LP name>" link.
    let amplpsNormalized = 0;
    for (const [amplpDenom, info] of Object.entries(amplpInfo.mapping)) {
        if (!info) continue;
        const t = tokens[amplpDenom];
        if (!t) continue;  // synthesized in 5c if missing; defensive here

        // (A) Force correct subtype regardless of how it was inferred earlier.
        t.subtype = 'amplp';

        // (B) Inherit TLA pool participation from the underlying LP. Falls back
        //     to mapping.bucket if the underlying LP isn't a tracked TLA pool
        //     (e.g. legacy amplps wrapping LPs not in the current gauge).
        const wrappedLp = info.underlying_lp_address;
        const wrappedTok = wrappedLp ? tokens[wrappedLp] : null;
        const inheritBuckets = (wrappedTok && wrappedTok.appears_in && wrappedTok.appears_in.tla_pools && wrappedTok.appears_in.tla_pools.length > 0)
            ? wrappedTok.appears_in.tla_pools
            : (info.bucket ? [info.bucket] : []);

        // Only set if not already populated. Defensive against future stages
        // that might populate amplps differently.
        if (t.appears_in.tla_pools_count === 0 && inheritBuckets.length > 0) {
            t.appears_in.tla_pools_count = inheritBuckets.length;
            t.appears_in.tla_pools = [...inheritBuckets];
            // Inherit gauge_status from the underlying LP. If LP isn't tracked,
            // leave undefined — the page renders "active" as default in that case.
            if (wrappedTok && wrappedTok.appears_in && wrappedTok.appears_in.gauge_status) {
                t.appears_in.gauge_status = wrappedTok.appears_in.gauge_status;
            }
        }

        // (C) Record the LP this amplp wraps so the page can render the
        //     relationship. Also useful for future DEX-badge derivation.
        t.appears_in.wraps_lp_address = wrappedLp || null;

        amplpsNormalized++;
    }
    if (amplpsNormalized > 0) {
        console.log(`   Stage 5d: normalized ${amplpsNormalized} amplp records (subtype + tla_pools inheritance + wraps_lp link)`);
    }

    // Stage 6: amplp wrapping — fixed semantic split between two flags
    //
    // Two distinct concepts that were previously conflated:
    //
    //   is_wrapped_by_amplp = true → this LP token gets wrapped by an amplp.
    //                                e.g. FUEL-LUNA LP is wrapped by FUEL-LUNA AMPLP.
    //                                Set on the LP itself.
    //
    //   is_amplp_underlying  = true → this token is an UNDERLYING ASSET of an LP
    //                                that gets wrapped by an amplp. e.g. FUEL itself
    //                                is an underlying of FUEL-LUNA LP, which is amplp'd.
    //                                Set on the actual asset tokens (LUNA, FUEL, ATOM).
    //
    // The page label "amplp underlying" should mean what users expect — the actual
    // tokens (LUNA, FUEL, ATOM) underlying any amplp-wrapped LP, NOT the LPs themselves.
    // Previously both flags were set on the LP token only, so FUEL showed "no" even
    // though FUEL-LUNA LP is amplp'd.
    for (const info of Object.values(amplpInfo.mapping)) {
        const wrappedLp = info.underlying_lp_address;
        if (tokens[wrappedLp]) {
            tokens[wrappedLp].appears_in.is_wrapped_by_amplp = true;
        }
        // Cascade: mark the LP's underlying tokens as amplp underlyings.
        // The data comes from scope phase: lpToUnderlyings[lpAddr] = [token1, token2].
        // Defense in depth: also skip self-references here. The scope phase now
        // strips them but if any old data sneaks through, this prevents an LP
        // from being marked as its own underlying.
        const underlyings = (lpToUnderlyings && lpToUnderlyings[wrappedLp]) || [];
        for (const uAddr of underlyings) {
            if (uAddr === wrappedLp) continue;  // skip self-reference (vault, not LP)
            if (tokens[uAddr]) {
                tokens[uAddr].appears_in.is_amplp_underlying = true;
            }
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

    // Stage 7d: logo aggregation — pick best logo URL per token, with priority:
    //   1. curated override (token_overrides.json logo_url field)
    //   2. cosmos chain-registry logo_uri  (most canonical for IBC/cw20 with terra2 entry)
    //   3. Skeleton Swap logo_url          (covers more wrapped tokens like wstETH)
    //   4. (future) Eris CDN, Astroport API, CoinGecko per-coin endpoint
    //
    // Result is exposed as t.logo_url so downstream consumers (catalog page,
    // tla-stats.html, future tools) read one canonical field instead of having
    // to scan all the source records.
    //
    // For LPs and amplps, this stage does NOT compute a composite logo — that's
    // a rendering concern. The page/UI composites two underlying token logos
    // visually using the lp_to_underlyings + amplp_mappings data.
    //
    // 404s are gracefully handled on the page side via <img onerror> fallback
    // to a letter-circle, so a wrong/dead URL here doesn't break anything.
    let logosResolved = 0;
    for (const t of Object.values(tokens)) {
        const s = t.sources || {};
        const best =
            (t.override && t.override.logo_url) ||
            (s.cosmos_chain_registry && s.cosmos_chain_registry.logo_uri) ||
            (s.skeletonswap && s.skeletonswap.logo_url) ||
            null;
        if (best) {
            t.logo_url = best;
            logosResolved++;
        }
    }
    console.log(`   Stage 7d: resolved ${logosResolved} token logos (of ${Object.keys(tokens).length} tokens)`);

    // Stage 7b: Hardcoded display + CG overrides (drama-not-data fixes)
    //
    // Some tokens have a name disagreement between Eris's API and Eris's UI
    // (and the wider ecosystem). These are political/historical artifacts, not
    // data bugs, so we hardcode rather than add to the curated overrides file.
    // Currently just one case:
    //   bLUNA at terra17aj4ty… — Eris's /prices returns display="bLUNA" with
    //   no CG mapping. Eris's UI shows "boneLUNA". Backbone Labs uses
    //   "boneLUNA" everywhere. CoinGecko lists it as "backbone-labs-staked-luna".
    //   The label disagreement is a holdover from Eris/BBL drama.
    const HARDCODED_OVERRIDES = {
        'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml': {
            display_name: 'boneLUNA',
            headline_name: 'boneLUNA',
            coingecko_id: 'backbone-labs-staked-luna',
            override_reason: 'eris_bbl_naming_dispute',
        },
    };
    for (const [addr, fix] of Object.entries(HARDCODED_OVERRIDES)) {
        if (!tokens[addr]) continue;
        const t = tokens[addr];
        if (fix.display_name) t.display_name = fix.display_name;
        if (fix.headline_name) t.headline_name = fix.headline_name;
        if (fix.coingecko_id && !t.coingecko_id) {
            t.coingecko_id = fix.coingecko_id;
            t.coingecko_match = 'hardcoded_override';
        }
        t.hardcoded_override_reason = fix.override_reason;
        // Propagate the corrected name through to source-level fields so the
        // cross-source naming panel reflects the override too. Preserve the
        // original Eris-API value as `_original` so anyone curious about the
        // raw disagreement can still see it.
        //
        // Without this, the page shows "Eris UI: bLUNA" because that's what
        // /prices literally returned — but Eris's UI shows "boneLUNA" and we
        // hardcoded to match. The panel should reflect what UIs show, not
        // what one underlying API quirkily returns.
        if (fix.display_name) {
            t.sources = t.sources || {};
            if (t.sources.eris) {
                if (t.sources.eris.display !== fix.display_name) {
                    t.sources.eris._display_original = t.sources.eris.display;
                    t.sources.eris.display = fix.display_name;
                    t.sources.eris._display_overridden = true;
                }
            }
        }
    }

    // Stage 7c: CoinGecko independent verification
    //
    // We've been blindly trusting Eris's claims about which CG ID corresponds
    // to which token. That trust failed visibly on rSWTH (score 100 despite
    // unverified mapping) and silently on others we haven't caught. This stage
    // cross-checks every claimed mapping against CG's own coin list, which
    // includes contract addresses per chain platform.
    //
    // Four outcomes per token:
    //   - verified           — CG has this address AND matches the claimed CG ID
    //   - mismatch           — CG has this address but a DIFFERENT CG ID than claimed
    //                          (red flag — Eris's mapping is wrong)
    //   - discovered         — CG has this address but Eris didn't claim a CG ID
    //                          (gap-filler — we add the CG ID and link)
    //   - unverified_no_addr — claimed CG ID exists, but CG doesn't index this
    //                          address on terra-2 (could be legit if CG indexes
    //                          by source chain only, but worth flagging)
    //   - no_mapping_either  — no CG ID claimed, no CG address match (genuine no-CG)
    //
    // Why this matters: an unverified mapping shouldn't be treated as 100%
    // confidence. Scoring further down uses this status to calibrate.
    if (cgList && Array.isArray(cgList)) {
        // Build TWO indexes:
        //   1. cgByAddr (terra-2 only): direct lookup at our Terra address
        //   2. cgByChainAddr (all chains): { 'ethereum:0x4580...': cgEntry, ... }
        //      Lets us verify provenance for bridged tokens whose source asset
        //      CG indexes (PAXG via Ethereum, wBTC.atom via Ethereum, etc.)
        const cgByAddr = {};
        const cgByChainAddr = {};
        for (const coin of cgList) {
            const plats = coin.platforms || {};
            for (const [platName, platAddr] of Object.entries(plats)) {
                if (!platAddr) continue;
                if (platName === 'terra-2' || platName === 'terra' || platName === 'terra2') {
                    cgByAddr[platAddr] = { cg_id: coin.id, symbol: coin.symbol, name: coin.name, platform: platName };
                }
                // Build cross-chain index: lowercase keys to handle EVM-address case variations
                const lcAddr = platAddr.toLowerCase();
                cgByChainAddr[`${platName}:${lcAddr}`] = { cg_id: coin.id, symbol: coin.symbol, name: coin.name, platform: platName, original_address: platAddr };
            }
        }

        // Helper: walk a token's bridge.all_traces looking for a CG match on
        // any source chain. Returns the first match, or null.
        // Trace format (chain-registry standard):
        //   [{ type: 'ibc'|'ibc-bridge', counterparty: { chain_name, base_denom, ... } }, ...]
        // The deepest origin is usually the last entry. We check ALL of them.
        function findCgMatchViaBridge(t) {
            const traces = (t.bridge && t.bridge.all_traces) || [];
            for (const trace of traces) {
                const cp = trace.counterparty || {};
                const chainName = cp.chain_name;
                const baseDenom = cp.base_denom;
                if (!chainName || !baseDenom) continue;
                // CG uses 'ethereum' as platform name; chain-registry uses the same.
                // For evm chains, the base_denom is the 0x... contract — match case-insensitively.
                const lookupKey = `${chainName}:${baseDenom.toLowerCase()}`;
                if (cgByChainAddr[lookupKey]) {
                    return {
                        ...cgByChainAddr[lookupKey],
                        matched_via: 'bridge_trace',
                        source_chain: chainName,
                        source_address: baseDenom,
                    };
                }
            }
            return null;
        }

        let nVerified = 0, nMismatch = 0, nDiscovered = 0, nUnverified = 0, nViaBridge = 0;
        for (const [addr, t] of Object.entries(tokens)) {
            const claimedCgId = t.coingecko_id;
            const cgEntry = cgByAddr[addr];
            // Preserve CG entry as a new source for the cross-source naming panel
            if (cgEntry) {
                t.sources = t.sources || {};
                t.sources.coingecko = cgEntry;
            }
            if (cgEntry && claimedCgId) {
                if (cgEntry.cg_id === claimedCgId) {
                    t.coingecko_match = 'verified';
                    nVerified++;
                } else {
                    t.coingecko_match = 'mismatch';
                    t.coingecko_id_claimed = claimedCgId;
                    t.coingecko_id_actual = cgEntry.cg_id;
                    nMismatch++;
                }
            } else if (cgEntry && !claimedCgId) {
                // Eris/sources missed this mapping — CG has it. Adopt it.
                t.coingecko_id = cgEntry.cg_id;
                t.coingecko_match = 'discovered';
                nDiscovered++;
            } else if (!cgEntry) {
                // No terra-2 match. Try bridge trace as fallback — for tokens
                // with chain-registry bridge data, the CG entry for the source
                // asset on its origin chain (e.g. PAX Gold on Ethereum) is a
                // valid mapping. The bridged Terra version IS that asset.
                const bridgeMatch = findCgMatchViaBridge(t);
                if (bridgeMatch) {
                    // Verified via bridge provenance — different confidence level
                    // than terra-2 direct match, but legitimate.
                    t.sources = t.sources || {};
                    t.sources.coingecko = bridgeMatch;
                    if (!claimedCgId) {
                        // Discover via bridge: adopt the source asset's CG ID
                        t.coingecko_id = bridgeMatch.cg_id;
                        t.coingecko_match = 'verified_via_bridge';
                        t.coingecko_match_source = `${bridgeMatch.source_chain}:${bridgeMatch.source_address}`;
                        nViaBridge++;
                    } else if (claimedCgId === bridgeMatch.cg_id) {
                        // Source claimed the same CG ID that bridge trace finds — confirmed
                        t.coingecko_match = 'verified_via_bridge';
                        t.coingecko_match_source = `${bridgeMatch.source_chain}:${bridgeMatch.source_address}`;
                        nViaBridge++;
                    } else {
                        // Source claimed CG ID X, bridge trace finds Y. Mismatch.
                        t.coingecko_match = 'mismatch';
                        t.coingecko_id_claimed = claimedCgId;
                        t.coingecko_id_actual = bridgeMatch.cg_id;
                        t.coingecko_match_source = `bridge:${bridgeMatch.source_chain}`;
                        nMismatch++;
                    }
                } else if (claimedCgId) {
                    // Source claims a CG ID but neither terra-2 nor bridge match
                    t.coingecko_match = 'unverified_no_terra_addr';
                    nUnverified++;
                }
                // else: no claim, no CG entry, no bridge match — leave as no_mapping
            }
        }
        console.log(`   CG verification: ${nVerified} verified (terra-2), ${nViaBridge} verified via bridge trace, ${nMismatch} mismatched, ${nDiscovered} discovered (gap-fill), ${nUnverified} unverified`);
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

    // Stage 8b: synthesize acquisition hints from bridge data
    //
    // For tokens that have no curated acquisition guide but DO have bridge
    // metadata from chain-registry (source_chain, channel, original_denom),
    // we can derive a partial guide automatically. This catches USDt (Kava
    // origin via channel-138), EURe, and others where bridge data is rich
    // but no human has written the route.
    //
    // The synthesized guide is explicitly marked unverified — we know the
    // bridge path from on-chain data, but not the consumer on-ramp to
    // acquire the source asset in the first place. A real curated guide
    // (with verified routes) would still override this when added.
    for (const t of Object.values(tokens)) {
        if (t.acquisition) continue;      // already has a curated guide
        if (!t.bridge) continue;          // no bridge data to synthesize from
        const b = t.bridge;
        // Skip if the bridge data points back at Terra itself (terra2 origin
        // = native Terra, no acquisition guide needed)
        if (b.source_chain === 'terra2' || b.source_chain === 'terra') continue;
        // Only generate for ibc tokens (factory tokens are minted natively)
        if (t.type !== 'ibc') continue;
        const sourceLabel = b.source_chain || 'unknown chain';
        const channel = b.channel ? ` (channel: ${b.channel})` : '';
        const originalDenom = b.original_denom ? `\nOn ${sourceLabel} this asset is: ${b.original_denom}` : '';
        t.acquisition = {
            native_chain: sourceLabel,
            route_to_terra: [
                `This token bridges from ${sourceLabel} to Terra via IBC${channel}.`,
                `First acquire the source asset on ${sourceLabel} — route unverified.`,
                `Then IBC transfer it to your Terra address (e.g. via Keplr cross-chain transfer).${originalDenom}`,
            ],
            warnings: [
                'This guide was auto-derived from on-chain bridge metadata, not verified by a human.',
                'The bridge path is correct, but the consumer route to acquire the source asset is unknown.',
                'If you find a working on-ramp, please contribute to acquisition_guides.json.',
            ],
            verified: false,
            source: 'auto_derived_from_bridge_data',
        };
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
        // LST detection. Guard against overriding 'amplp' — amplps wrapping LST
        // pairs (e.g. arbLUNA-LUNA AMPLP, ampWHALE-WHALE AMPLP) have symbols
        // that match this regex but are amplps, not LSTs. Stage 5d already
        // forced these to subtype='amplp'; respect that.
        if (t.subtype !== 'amplp' && /^(amp|arb|b|st)/.test(t.symbol || '') && /luna/i.test(sym)) {
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

        // CoinGecko mapping scoring — uses verification status from Stage 7c.
        // The CG verification stage runs BEFORE this and sets coingecko_match
        // to one of: verified | mismatch | discovered | unverified_no_terra_addr
        // | hardcoded_override | (unset). Anything that's not 'verified' or
        // 'discovered' is treated as unreliable — penalize accordingly.
        //
        // Previously this stage blindly stamped 'matched' whenever a CG ID was
        // present, masking unverified mappings (rSWTH's 100-score bug).
        if (!t.coingecko_id) {
            // No CG mapping AT ALL — biggest penalty
            score -= 25;
            flags.push('no_external_price_source');
            if (!t.coingecko_match) t.coingecko_match = 'no_mapping';
        } else if (t.coingecko_match === 'verified') {
            // CG ID confirmed by CG's own terra-2 platform index. Trustworthy.
            // No penalty, no flag.
        } else if (t.coingecko_match === 'verified_via_bridge') {
            // CG ID confirmed via bridge provenance — CG indexes the source
            // asset on its origin chain (e.g. PAX Gold on Ethereum), and our
            // token's bridge.all_traces match that exact source contract.
            // Slightly less specific than terra-2 direct (CG could theoretically
            // list a separate "bridged" entry), but the provenance is solid.
            // Small penalty so it's distinguishable from terra-2 verified.
            score -= 5;
            flags.push('cg_verified_via_bridge_provenance');
        } else if (t.coingecko_match === 'discovered') {
            // Gap-filled: Eris missed it but CG knew. Neutral — small bonus
            // is built in because we now have the mapping where we didn't before.
        } else if (t.coingecko_match === 'mismatch') {
            // Eris/source claimed one CG ID, CG actually has a different ID
            // for this address. Strong red flag — the mapping is wrong.
            score -= 30;
            flags.push(`cg_mapping_mismatch:claimed=${t.coingecko_id_claimed},actual=${t.coingecko_id_actual}`);
        } else if (t.coingecko_match === 'unverified_no_terra_addr') {
            // CG ID claimed, but CG doesn't index this address on terra-2.
            // Common for IBC denoms (CG indexes by origin chain). Not necessarily
            // wrong but we can't confirm — moderate penalty so score isn't 100.
            score -= 15;
            flags.push('cg_mapping_unverified');
        } else if (t.coingecko_match === 'hardcoded_override') {
            // Manually corrected mapping — trust the hardcode, no penalty.
        } else {
            // Legacy / unknown match state — penalize lightly so unverified
            // doesn't pass as perfect.
            score -= 10;
            flags.push('cg_mapping_status_unknown');
            t.coingecko_match = 'unverified';
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
        // Compute headline_name with Eris's `display` as the top priority,
        // BUT skip this entirely if we already hardcoded an override.
        // Otherwise the bLUNA→boneLUNA hardcode (and any future overrides)
        // get clobbered by Eris's stubborn naming.
        if (t.hardcoded_override_reason) {
            // already set in Stage 7b — leave it alone
        } else {
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
        console.log(`   step A: asset-staking[*].whitelisted_asset_details — ${extraPoolsResult.stats.contractsSucceeded}/${extraPoolsResult.stats.contractsChecked} buckets returned data, +${extraPoolsResult.stats.extraLpsFound} extra LPs (${extraPoolsResult.stats.whitelistedFound} below-threshold + ${extraPoolsResult.stats.dewhitelistedFound} dewhitelisted)`);
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
        below_threshold_lps:        extraPoolsResult.stats.whitelistedFound || 0,
        dewhitelisted_lps:          extraPoolsResult.stats.dewhitelistedFound || 0,
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
    const tokens = buildTokenCatalog({ pools: allPools, chainRegIdx, erisIdx, astroIdx, ssIdx, amplpInfo, curated, scopeAddrs, lpToUnderlyings: universe.lpToUnderlyings, cgList: external.coingecko_list });
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
        // Tell the page how much data each external source actually returned.
        // Lets us distinguish "we queried this source and it doesn't have this
        // token" (informative) from "we never queried" or "source failed"
        // (different problem entirely). Without this the page can only say
        // "— not listed" with no context.
        source_coverage: {
            cosmos_chain_registry: {
                asset_count: (external.cosmos_chain_registry?.assets || []).length,
                fetched_ok: !!external.cosmos_chain_registry,
                note: 'IBC asset metadata; many common tokens (e.g. ATOM) absent from terra-2 list',
            },
            eris_prices: {
                asset_count: external.eris_prices ? Object.keys(external.eris_prices).length : 0,
                fetched_ok: !!external.eris_prices,
                note: 'Eris /prices endpoint — Eris-recognized assets only',
            },
            astroport_pools: {
                pool_count: external.astroport_pools
                    ? (Array.isArray(external.astroport_pools) ? external.astroport_pools.length : (external.astroport_pools.pools || []).length)
                    : 0,
                fetched_ok: !!external.astroport_pools,
                note: 'Astroport pool data — indexes assets via active trading pairs',
            },
            skeletonswap_pools: {
                pool_count: external.skeletonswap_pools ? (external.skeletonswap_pools.pools || []).length : 0,
                fetched_ok: !!external.skeletonswap_pools,
                note: 'SkeletonSwap pool data — only assets in current SS pools',
            },
            coingecko_list: {
                coin_count: Array.isArray(external.coingecko_list) ? external.coingecko_list.length : 0,
                fetched_ok: !!external.coingecko_list,
                note: 'CG /coins/list with platforms — used for independent CG-mapping verification',
            },
        },
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
