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
    for (const [eris_name, entry] of Object.entries(prices)) {
        if (!entry || typeof entry !== 'object') continue;
        const addr = entry.contract || entry.denom || entry.address;
        if (!addr) continue;
        const key = addr.startsWith('cw20:') ? addr.slice(5) : addr;
        idx[key] = {
            eris_name, symbol: entry.symbol || eris_name,
            decimals: entry.decimals, coingecko_id: entry.coingecko_id || null,
            price_usd: entry.price_usd ?? entry.final_price_usd ?? null,
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

function buildTokenCatalog({ pools, chainRegIdx, erisIdx, astroIdx, ssIdx, amplpInfo, curated }) {
    const tokens = {};
    const get = (addr) => {
        if (!tokens[addr]) tokens[addr] = emptyTokenRecord(addr);
        return tokens[addr];
    };

    // Stage 1: chain registry
    for (const [addr, info] of Object.entries(chainRegIdx)) {
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

    // Stage 2: Eris (canonical display name, but skip if Eris's key is just an address)
    for (const [addr, info] of Object.entries(erisIdx)) {
        const t = get(addr);
        if (!t.type) {
            t.type = addr.startsWith('ibc/') ? 'ibc'
                   : addr.startsWith('factory/') ? 'factory'
                   : addr.startsWith('terra1') ? 'cw20' : 'native';
        }
        // Only use Eris's name as display if it's NOT just an address or hash.
        // (Eris sometimes uses the contract address as the price-endpoint key
        // when it doesn't have a friendly name configured.)
        const erisNameLooksLikeAddress = info.eris_name && (
            info.eris_name.startsWith('terra1') ||
            info.eris_name.startsWith('ibc/') ||
            info.eris_name.startsWith('factory/')
        );
        t.sources.eris = {
            eris_name: info.eris_name, symbol: info.symbol,
            decimals: info.decimals, price_usd: info.price_usd,
            looks_like_address: erisNameLooksLikeAddress,
        };
        if (!erisNameLooksLikeAddress && info.eris_name) {
            t.display_name = info.eris_name;
        }
        if (info.decimals != null && t.decimals == null) t.decimals = info.decimals;
        if (info.coingecko_id && !t.coingecko_id) t.coingecko_id = info.coingecko_id;
    }

    // Stage 3: Astroport
    for (const [addr, info] of Object.entries(astroIdx)) {
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
    // underlying-asset → "appears_in 16 pools" linkage gets backfilled by
    // Layer 2 (entities) when it queries each Astroport pair for its assets.
    for (const pool of pools) {
        const addr = pool.gauge_pool_id?.replace(/^cw20:/, '').replace(/^native:/, '');
        if (!addr) continue;
        const t = get(addr);
        t.category = 'lp_tokens';   // override — this is an LP, not a regular token
        t.subtype  = pool.gauge_pool_id.startsWith('native:factory/') ? 'astroport_native_lp' : 'astroport_cw20_lp';
        t.appears_in.tla_pools_count += 1;
        t.appears_in.tla_pools.push(pool.bucket);
        t.appears_in.tla_distribution_pct = pool.distribution_pct;
        t.appears_in.tla_total_vp = pool.total_vp;
        if (!t.type) t.type = pool.gauge_pool_id.startsWith('cw20:') ? 'cw20' : 'factory';
    }

    // Stage 6: amplp underlyings
    for (const info of Object.values(amplpInfo.mapping)) {
        const underlying = info.underlying_lp_address;
        if (tokens[underlying]) tokens[underlying].appears_in.is_amplp_underlying = true;
    }

    // Stage 7: curated overrides
    if (curated.token_overrides) {
        const overrides = curated.token_overrides.tokens || curated.token_overrides;
        if (typeof overrides === 'object') {
            for (const [addr, override] of Object.entries(overrides)) {
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

        if (!t.acquisition) {
            score -= 10;
            flags.push('no_acquisition_guide');
        }

        if (t.appears_in.tla_pools_count === 0
            && !t.sources.eris && !t.sources.astroport && !t.sources.skeletonswap) {
            score -= 15;
            flags.push('not_in_active_use');
        }

        t.scoring.confusion_score = Math.max(0, Math.min(100, score));
        t.scoring.flags = flags;
    }

    // Post-pass: variant detection
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

    // Post-pass: tier classification (signal-to-noise classification)
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

    console.log('\n🧬 Building catalog...');
    const tokens = buildTokenCatalog({ pools, chainRegIdx, erisIdx, astroIdx, ssIdx, amplpInfo, curated });
    const { contracts, wallets } = buildContractsCatalog({ directory, curated });
    const unmapped = findUnmapped({ tokens });
    console.log(`   tokens:    ${Object.keys(tokens).length}`);
    console.log(`   contracts: ${Object.keys(contracts).length}`);
    console.log(`   wallets:   ${Object.keys(wallets).length}`);
    console.log(`   unmapped:  ${unmapped.tokens.length}`);

    const snapshot = {
        schemaVersion: SCHEMA_VERSION, cron: CRON_NAME,
        layer: 0, layerRole: 'discovery-bootstrap-catalog',
        capturedAt: startedAt.toISOString(), capturedAtUnix: startedAt.getTime(),
        canonicalEpoch,
        directory, pools, buckets,
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
            amplp_mappings: Object.keys(amplpInfo.mapping).length,
            unmapped_tokens: unmapped.tokens.length,
            chain_errors: errors.length,
            external_source_errors: Object.keys(external.source_errors).length,
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
