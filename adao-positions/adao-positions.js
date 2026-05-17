// =============================================================================
// aDAO Positions Cron — Phase 1
// =============================================================================
//
// Captures full TLA portfolio data for every named aDAO member. The dashboard
// uses this to render per-member "portfolio tracker" views with:
//   • LP positions and their performance over epochs
//   • Lock holdings and what they'd be worth if adjusted today (LST ratio gains)
//   • Voting allocations and pool status (active / at-risk / inactive)
//   • Pending rewards (zluna), pending rebase, pending bribes
//   • Wallet balances for TLA-relevant tokens
//
// Schedule: Mondays at 01:00 UTC — runs ~1 hour after each TLA epoch boundary
//           (epoch starts at Monday 00:00 UTC, so we capture the just-settled state).
//           Cron string:  "0 1 * * 1"
// Runtime:  ~3-5 minutes (~1000 chain queries with parallelism)
// Output:   data/members.json    (light: all 157 members, named or not)
//           data/current.json    (heavy: full portfolios for ~46 named)
//           data/weekly/epoch-{n}.json  (frozen archive per epoch)
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

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------

// Terra LCD endpoints
const TERRA_LCD_PRIMARY  = 'https://terra-lcd.publicnode.com';
const TERRA_LCD_FALLBACK = 'https://terra-rest.publicnode.com';

// TLA contracts
const TLA_GAUGE_CONTROLLER = 'terra1hfksrhchkmsj4qdq33wkksrslnfles6y2l77fmmzeep0xmq24l2smsd3lj';
const TLA_VOTING_ESCROW    = 'terra1uqhj8agyeaz8fu6mdggfuwr3lp32jlrx5hqag4jxexde92rzkamq3l62zg';
const TLA_BRIBE_MANAGER    = 'terra1tuuwm8yrj54qeg0c8xu00aha9ryatyhtczq8qq2q8tntuw0auzas9037wh';
const TLA_ASSET_COMPOUNDER = 'terra1zly98gvcec54m3caxlqexce7rus6rzgplz7eketsdz7nh750h2rqvu8uzx';

const TLA_STAKING_CONTRACTS = {
    stable:   'terra1v399cx9drllm70wxfsgvfe694tdsd9x96p9ha36w7muffe4znlusqswspq',
    project:  'terra1awq6t7jfakg9wfjn40fk3wzwmd57mvrqtt3a39z9rmet7wdjj3ysgw3lpa',
    bluechip: 'terra14mmvqn0kthw6sre75vku263lafn5655mkjdejqjedjga4cw0qx2qlf4arv',
    single:   'terra1qdz5qgafx88kp5mf6m2tah8742g4u5g2cek0m3jrgssexexk7g4qw6e23k',
};

const BUCKETS = ['stable', 'project', 'bluechip', 'single'];

// aDAO contracts
const ADAO_VOTING_CONTRACT = 'terra1c57ur376szdv8rtes6sa9nst4k536dynunksu8tx5zu4z5u3am6qmvqx47';

// aDAO treasury wallet — the aDAO Core contract that holds the DAO's collective TLA positions.
// Tracked separately from named members so the TLA Stats page can render its "aDAO" tab
// from treasury data while the Member Stats page renders per-member portfolios.
const ADAO_TREASURY_WALLETS = [
    {
        address: 'terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm',
        label: 'aDAO Treasury',
        kind: 'adao_core',
    },
];

// Council treasury wallet — separate Council DAO holding wallet. Not a TLA participant
// (no LP positions / locks / votes expected) but tracked here because it's a peer treasury
// to the aDAO Core wallet. fetchMemberPortfolio is reused — the TLA-related fields will be
// empty for this wallet, only wallet_balances + summary.total_wallet_balances_usd are
// meaningful. Output goes to a separate top-level `council_treasury` field so existing
// consumers reading `treasury` (aDAO Core) are unaffected.
const COUNCIL_TREASURY_WALLETS = [
    {
        address: 'terra1yqv0af22675wlcmgflxk4ve07vt8qlm999gk0cuw5l64r5xxgadsyg8ywv',
        label: 'Council Treasury',
        kind: 'council_core',
    },
];

// External data sources
const DAODAO_INDEXER_URL = `https://indexer.daodao.zone/phoenix-1/contract/${ADAO_VOTING_CONTRACT}/daoVotingCw721Staked/topStakers`;
const PFPK_BASE_URL      = 'https://pfpk.daodao.zone/bech32/';
const FALLBACK_MEMBERS_CSV_URL = 'https://raw.githubusercontent.com/defipatriot/adao_json_storage/main/members.csv';

const TLA_SNAPSHOT_URL     = 'https://raw.githubusercontent.com/defipatriot/tla-snapshot-data_2026/main/data/tla-snapshot.json';
const NETWORK_PRICES_URL   = 'https://raw.githubusercontent.com/defipatriot/network-and-prices-data_2026/main/data/network-and-prices.json';
const SELF_CACHED_MEMBERS  = 'https://raw.githubusercontent.com/defipatriot/adao-positions-data_2026/main/data/members.json';

// TLA epoch math
const TLA_EPOCH_START_MS = Date.parse('2022-10-31T00:00:00Z');
const TLA_EPOCH_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// Pool status thresholds
const POOL_ACTIVE_THRESHOLD_PCT = 1.0;
const POOL_AT_RISK_THRESHOLD_PCT = 1.5;  // active but < 1.5% gets flagged

// HTTP
const HTTP_TIMEOUT_MS = 25000;
const PFPK_TIMEOUT_MS = 8000;  // faster timeout for non-critical lookups
const BATCH_CONCURRENCY = 15;

// GitHub publish
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/adao-positions-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// -----------------------------------------------------------------------------
// BECH32 DECODER — for pfpk hex lookup (converts terra1... → 20-byte hex)
// -----------------------------------------------------------------------------
//
// pfpk.daodao.zone expects the raw 20-byte hash of an address (the data
// portion of bech32 encoding), formatted as hex. This is pure-JS, no deps.
//

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values) {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
        const b = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let i = 0; i < 5; i++) {
            if ((b >> i) & 1) chk ^= GEN[i];
        }
    }
    return chk;
}

function bech32HrpExpand(hrp) {
    const ret = [];
    for (const c of hrp) ret.push(c.charCodeAt(0) >> 5);
    ret.push(0);
    for (const c of hrp) ret.push(c.charCodeAt(0) & 31);
    return ret;
}

function bech32VerifyChecksum(hrp, data) {
    return bech32Polymod(bech32HrpExpand(hrp).concat(data)) === 1;
}

function bech32Decode(bech) {
    if (!bech || typeof bech !== 'string') return null;
    bech = bech.toLowerCase();
    const pos = bech.lastIndexOf('1');
    if (pos < 1 || pos + 7 > bech.length) return null;
    const hrp = bech.slice(0, pos);
    const data = [];
    for (const c of bech.slice(pos + 1)) {
        const idx = BECH32_CHARSET.indexOf(c);
        if (idx < 0) return null;
        data.push(idx);
    }
    if (!bech32VerifyChecksum(hrp, data)) return null;
    return { hrp, data: data.slice(0, -6) };
}

function convertBits(data, fromBits, toBits, pad) {
    let acc = 0, bits = 0;
    const ret = [];
    const maxv = (1 << toBits) - 1;
    for (const v of data) {
        if (v < 0 || (v >> fromBits) > 0) return null;
        acc = (acc << fromBits) | v;
        bits += fromBits;
        while (bits >= toBits) {
            bits -= toBits;
            ret.push((acc >> bits) & maxv);
        }
    }
    if (pad && bits > 0) ret.push((acc << (toBits - bits)) & maxv);
    return ret;
}

function bech32AddressToHex(addr) {
    const decoded = bech32Decode(addr);
    if (!decoded) return null;
    const bytes = convertBits(decoded.data, 5, 8, false);
    if (!bytes) return null;
    return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

// -----------------------------------------------------------------------------
// HTTP HELPERS
// -----------------------------------------------------------------------------

async function fetchJson(url, label, timeoutMs = HTTP_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json', 'User-Agent': 'aDAO-positions-cron/1.0' },
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

async function fetchText(url, label, timeoutMs = HTTP_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'aDAO-positions-cron/1.0' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
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

async function queryContract(contractAddr, query, attemptFallback = true) {
    const qb = encodeQuery(query);
    const path = `/cosmwasm/wasm/v1/contract/${contractAddr}/smart/${qb}`;
    try {
        const r = await fetchJson(TERRA_LCD_PRIMARY + path, `query ${contractAddr.slice(0,20)}`);
        return r.data;
    } catch (e) {
        if (attemptFallback) {
            try {
                const r = await fetchJson(TERRA_LCD_FALLBACK + path, `query-fallback ${contractAddr.slice(0,20)}`);
                return r.data;
            } catch (e2) {
                return null;
            }
        }
        return null;
    }
}

async function fetchBankBalances(address) {
    const url = `${TERRA_LCD_PRIMARY}/cosmos/bank/v1beta1/balances/${address}`;
    try {
        const r = await fetchJson(url, `bank-balances-${address.slice(0,20)}`);
        return r.balances || [];
    } catch (e) {
        return [];
    }
}

// Parallel batcher with concurrency limit
async function parallelMap(items, fn, concurrency = BATCH_CONCURRENCY) {
    const results = new Array(items.length);
    let idx = 0;
    async function worker() {
        while (true) {
            const i = idx++;
            if (i >= items.length) return;
            try {
                results[i] = await fn(items[i], i);
            } catch (e) {
                results[i] = { _error: e.message };
            }
        }
    }
    await Promise.all(Array(Math.min(concurrency, items.length)).fill(0).map(() => worker()));
    return results;
}

// -----------------------------------------------------------------------------
// EPOCH MATH
// -----------------------------------------------------------------------------

function currentEpochInfo() {
    const now = Date.now();
    // epochIndex is 0-indexed (count of complete weeks since TLA START on 2022-10-31).
    // We use it INTERNALLY for date math (epochStart etc.) because the math
    // requires a 0-indexed offset.
    // We expose `number` as epochIndex + 1 — the 1-indexed CANONICAL epoch
    // number that matches `epoch_1-300_date.json` and Eris/Votion UIs.
    const epochIndex = Math.floor((now - TLA_EPOCH_START_MS) / TLA_EPOCH_DURATION_MS);
    const number = epochIndex + 1;
    const epochStart = TLA_EPOCH_START_MS + epochIndex * TLA_EPOCH_DURATION_MS;
    const epochEnd   = epochStart + TLA_EPOCH_DURATION_MS;
    return {
        number,
        starts_at: new Date(epochStart).toISOString(),
        ends_at: new Date(epochEnd).toISOString(),
        progress_pct: ((now - epochStart) / TLA_EPOCH_DURATION_MS) * 100,
    };
}

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
// SHARED DATA LOAD — tla-snapshot.json and network-and-prices.json
// -----------------------------------------------------------------------------

async function loadSharedData() {
    console.log('📂 Loading shared data (tla-snapshot, network-and-prices)...');
    const [tlaSnapshot, networkPrices] = await Promise.all([
        fetchJson(TLA_SNAPSHOT_URL, 'tla-snapshot').catch(e => { console.warn(`  ⚠ tla-snapshot: ${e.message}`); return null; }),
        fetchJson(NETWORK_PRICES_URL, 'network-and-prices').catch(e => { console.warn(`  ⚠ network-and-prices: ${e.message}`); return null; }),
    ]);

    if (!tlaSnapshot) throw new Error('tla-snapshot.json required — aborting');
    if (!networkPrices) throw new Error('network-and-prices.json required — aborting');

    const tokenPrices = networkPrices.token_prices || {};
    const lstRatios = networkPrices.lst_ratios || {};
    const lunaPriceUsd = tokenPrices?.LUNA?.final_price_usd || null;

    // Build pool lookup: lp_address → pool, gauge_pool_id → pool
    const poolByLpAddr = new Map();
    const poolByGaugeId = new Map();
    for (const p of (tlaSnapshot.pools || [])) {
        if (p.lp_address) poolByLpAddr.set(p.lp_address.toLowerCase(), p);
        if (p.gauge_pool_id) poolByGaugeId.set(p.gauge_pool_id, p);
    }

    console.log(`  ✓ ${tlaSnapshot.pools?.length || 0} pools indexed`);
    console.log(`  ✓ ${Object.keys(tokenPrices).length} token prices, ${Object.keys(lstRatios).length} LST ratios`);
    console.log(`  ✓ LUNA price: $${lunaPriceUsd?.toFixed(6)}`);

    // Fetch asset-compounder configs (amplified pools list) — used for per-member queries
    console.log('  ⛓  Fetching asset-compounder configs...');
    const ampConfigs = await queryContract(TLA_ASSET_COMPOUNDER, { asset_configs: {} });
    const ampConfigsByGauge = {};
    if (Array.isArray(ampConfigs)) {
        for (const cfg of ampConfigs) {
            const gauge = cfg.gauge;
            if (!ampConfigsByGauge[gauge]) ampConfigsByGauge[gauge] = [];
            ampConfigsByGauge[gauge].push([gauge, cfg.asset_info]);
        }
        console.log(`  ✓ ${ampConfigs.length} amplified pool configs (${Object.keys(ampConfigsByGauge).length} buckets)`);
    } else {
        console.warn('  ⚠ asset_configs failed — amplified positions may be missed');
    }

    // Fetch zluna hub state — needed for accurate pending-reward pricing.
    // zluna is a yield-bearing share token; its LUNA-equivalent value is
    // last_exchange_rate × share_exchange_rate (>1, grows as Alliance rewards accrue).
    console.log('  ⛓  Fetching zluna hub state...');
    const zlunaHub = 'terra1u72y7gppxrsncctvgfyqduv3md6pgq77pqhz9rxgwl3dqgye00cq7vmf8u';
    let zlunaToLunaRatio = 1;  // safe fallback
    const zlunaState = await queryContract(zlunaHub, { state: {} }).catch(() => null);
    if (zlunaState?.last_exchange_rate && zlunaState?.share_exchange_rate) {
        const lastEx = parseFloat(zlunaState.last_exchange_rate);
        const shareEx = parseFloat(zlunaState.share_exchange_rate);
        zlunaToLunaRatio = lastEx * shareEx;
        console.log(`  ✓ zluna → LUNA ratio: ${zlunaToLunaRatio.toFixed(6)} (last_ex=${lastEx.toFixed(4)}, share_ex=${shareEx.toFixed(4)})`);
    } else {
        console.warn('  ⚠ zluna hub state unavailable — pending rewards will use 1:1 LUNA assumption');
    }

    return { tlaSnapshot, tokenPrices, lstRatios, lunaPriceUsd, poolByLpAddr, poolByGaugeId, ampConfigsByGauge, zlunaToLunaRatio };
}

// -----------------------------------------------------------------------------
// POOL LOOKUP HELPERS
// -----------------------------------------------------------------------------

function findPoolByAssetInfo(assetInfo, ctx) {
    // assetInfo is { cw20: "terra1..." } or { native: "factory/..." } or { native: "ibc/..." }
    if (!assetInfo) return null;
    if (assetInfo.cw20) {
        return ctx.poolByLpAddr.get(assetInfo.cw20.toLowerCase()) || null;
    }
    if (assetInfo.native) {
        const gaugeKey = `native:${assetInfo.native}`;
        return ctx.poolByGaugeId.get(gaugeKey) || null;
    }
    return null;
}

function poolStatusFlag(pool) {
    const pct = pool?.voting_power?.pct_of_bucket;
    if (pct == null) return { status: 'unknown', pct_of_bucket: null, distance_from_threshold_pp: null };
    if (pct >= POOL_AT_RISK_THRESHOLD_PCT) {
        return { status: 'active', pct_of_bucket: pct, distance_from_threshold_pp: pct - POOL_ACTIVE_THRESHOLD_PCT };
    } else if (pct >= POOL_ACTIVE_THRESHOLD_PCT) {
        return { status: 'at_risk', pct_of_bucket: pct, distance_from_threshold_pp: pct - POOL_ACTIVE_THRESHOLD_PCT };
    } else {
        return { status: 'inactive', pct_of_bucket: pct, distance_from_threshold_pp: pct - POOL_ACTIVE_THRESHOLD_PCT };
    }
}

// Resolve a token (cw20 / native / IBC) to its USD price using network-and-prices data.
// Returns { symbol, price_usd } or { symbol: null, price_usd: null } if unknown.
// Caches symbol lookups for cw20 tokens (chain queries) to avoid duplicate work.
async function resolveTokenPrice(assetInfo, ctx, symbolCache) {
    if (!assetInfo) return { symbol: null, price_usd: null };
    let symbol = null;
    let denom = null;

    if (assetInfo.native) {
        denom = assetInfo.native;
        if (denom === 'uluna') {
            symbol = 'LUNA';
        } else {
            // Last segment of factory/ibc/... path is the symbol
            const parts = denom.split('/');
            symbol = parts[parts.length - 1];
        }
    } else if (assetInfo.cw20) {
        denom = assetInfo.cw20;
        if (symbolCache?.has(denom)) {
            symbol = symbolCache.get(denom);
        } else {
            try {
                const info = await queryContract(assetInfo.cw20, { token_info: {} });
                symbol = info?.symbol || null;
            } catch { symbol = null; }
            if (symbolCache) symbolCache.set(denom, symbol);
        }
    }

    // Look up price in network-and-prices tokenPrices
    let priceUsd = null;
    if (symbol && ctx.tokenPrices) {
        // Try exact match, then case-insensitive
        const entry = ctx.tokenPrices[symbol] ||
                      ctx.tokenPrices[symbol?.toUpperCase()] ||
                      ctx.tokenPrices[symbol?.toLowerCase()];
        priceUsd = entry?.final_price_usd || null;
    }
    // Fallback: LST tokens that may not be in token_prices directly — use LUNA × ratio
    if (priceUsd == null && symbol && ctx.lstRatios && ctx.lunaPriceUsd) {
        const lstEntry = ctx.lstRatios[symbol] || ctx.lstRatios[symbol?.toLowerCase()];
        if (lstEntry?.ratio) {
            priceUsd = lstEntry.ratio * ctx.lunaPriceUsd;
        }
    }
    return { symbol, price_usd: priceUsd };
}

// Identify whether a staking entry is amplified (Astroport incentives) or not.
// Returns { is_amplified: bool, position_type: 'amplified' | 'non_amplified', stake_config_kind: ... }
function classifyStakeMechanism(entry) {
    const cfg = entry?.config?.stake_config;
    const stakeConfigKind = (cfg && typeof cfg === 'object' && cfg.astroport)
        ? 'astroport_incentives'
        : (cfg === 'default' ? 'default' : (typeof cfg === 'string' ? cfg : 'unknown'));

    // Amplification is determined by the STAKED ASSET, not the stake_config.
    // The asset-compounder mints factory denoms (e.g. factory/<compounder>/N/<gauge>/amplp).
    // If a user staked a factory token minted by the compounder, the position is amplified.
    // If they staked a cw20 LP token directly, the position is non-amplified (raw LP).
    const assetInfo = entry?.asset?.info || {};
    const nativeDenom = assetInfo.native || '';
    const cw20Addr = assetInfo.cw20 || '';
    const isCompounderFactoryDenom = nativeDenom.startsWith(`factory/${TLA_ASSET_COMPOUNDER}/`);

    return {
        is_amplified: isCompounderFactoryDenom,
        position_type: isCompounderFactoryDenom ? 'amplified' : 'non_amplified',
        stake_config_kind: stakeConfigKind,
        stake_config_detail: (cfg && typeof cfg === 'object') ? cfg : null,
        staked_denom_type: cw20Addr ? 'cw20' : (isCompounderFactoryDenom ? 'compounder_factory' : 'other_native'),
    };
}

// -----------------------------------------------------------------------------
// LOCK VP PROJECTION — "what would you have if you adjusted today?"
// -----------------------------------------------------------------------------
//
// Each lock captured an underlying LUNA amount at the moment it was created
// (or last adjusted). Since LSTs accrue staking yield, the ratio increases
// over time, so the SAME amount of ampLUNA/bLUNA/etc. now represents MORE
// underlying LUNA than at lock time. Adjusting the lock re-snapshots the
// underlying, increasing voting power "for free".
//
// Formula (for permanent locks, slope=0):
//   underlying_now      = asset_amount × current_lst_ratio
//   voting_power_now    = underlying_now × coefficient  (coefficient is 9 for permanent)
//   potential_gain      = voting_power_now - current_voting_power
//
// For time-limited locks (with slope > 0), VP decays over time. The cron
// reports the projection but the dashboard can interpret it differently.
//
async function resolveLockAssetSymbol(assetInfo, symbolCache) {
    if (!assetInfo) return null;
    if (assetInfo.native === 'uluna') return 'LUNA';
    if (assetInfo.cw20) {
        if (symbolCache.has(assetInfo.cw20)) return symbolCache.get(assetInfo.cw20);
        try {
            const info = await queryContract(assetInfo.cw20, { token_info: {} });
            const sym = info?.symbol || null;
            symbolCache.set(assetInfo.cw20, sym);
            return sym;
        } catch {
            symbolCache.set(assetInfo.cw20, null);
            return null;
        }
    }
    if (assetInfo.native) {
        // IBC or factory — last part is the symbol
        const parts = assetInfo.native.split('/');
        return parts[parts.length - 1] || null;
    }
    return null;
}

function projectLockVp(lock, symbolToLstRatio) {
    // Returns the projection fields to attach to the lock
    const assetAmount = parseFloat(lock.asset?.amount) || 0;
    const underlyingAtLock = parseFloat(lock.underlying_amount) || 0;
    const currentVp = parseFloat(lock.voting_power) || 0;
    const coefficient = parseFloat(lock.coefficient) || 0;
    const slope = parseFloat(lock.slope) || 0;

    const projection = {
        underlying_at_lock_human: underlyingAtLock / 1e6,
        underlying_now_human: null,
        voting_power_if_adjusted_human: null,
        potential_vp_gain_human: null,
        potential_vp_gain_pct: null,
        lst_ratio_used: null,
        is_lst_lock: false,
    };

    // Look up LST ratio for this asset's symbol
    const sym = lock._assetSymbol;  // attached earlier
    if (!sym) return projection;

    const lstEntry = symbolToLstRatio.get(sym.toLowerCase());
    if (!lstEntry?.ratio) return projection;  // Not an LST, no projection possible

    projection.is_lst_lock = true;
    projection.lst_ratio_used = lstEntry.ratio;

    // New underlying = asset_amount × current_lst_ratio (both in micro units, ratio is float)
    const newUnderlying = assetAmount * lstEntry.ratio;
    const newVp = newUnderlying * coefficient;

    projection.underlying_now_human = newUnderlying / 1e6;
    projection.voting_power_if_adjusted_human = newVp / 1e6;
    projection.potential_vp_gain_human = (newVp - currentVp) / 1e6;
    projection.potential_vp_gain_pct = currentVp > 0 ? ((newVp - currentVp) / currentVp) * 100 : null;

    return projection;
}

// -----------------------------------------------------------------------------
// PER-MEMBER PORTFOLIO QUERIES
// -----------------------------------------------------------------------------

async function fetchMemberPortfolio(member, ctx) {
    const wallet = member.address;
    const portfolio = {
        wallet,
        name: member.name,
        nft_count: member.nft_count || 0,
        vp_pct_of_dao: member.vp_pct_of_dao || 0,
        nft_image_url: member.nft_image_url || null,
        _errors: [],
    };

    // Run all the per-bucket queries in parallel
    const stakingPromises = BUCKETS.map(b => Promise.all([
        queryContract(TLA_STAKING_CONTRACTS[b], { all_staked_balances: { address: wallet } }),
        queryContract(TLA_STAKING_CONTRACTS[b], { all_pending_rewards: { address: wallet } }),
    ]).then(([staked, pending]) => ({ bucket: b, staked: staked || [], pending: pending || [] })));

    // Plus per-user queries in parallel
    const otherPromises = Promise.all([
        queryContract(TLA_GAUGE_CONTROLLER, { user_info: { user: wallet, time: 'next' } }),
        queryContract(TLA_GAUGE_CONTROLLER, { user_pending_rebase: { user: wallet } }),
        queryContract(TLA_VOTING_ESCROW, { tokens: { owner: wallet, limit: 100 } }),
        queryContract(TLA_BRIBE_MANAGER, { user_claimable: { user: wallet } }),
        fetchBankBalances(wallet),
    ]);

    // Amplified positions query (one batch per bucket — each bucket has ≤21 amp pools)
    // These are stored in the asset-compounder, not the staking contract, so the 
    // staking contract returns only stale dust entries for these.
    const ampPromises = Promise.all(BUCKETS.map(bucket => {
        const assets = ctx.ampConfigsByGauge?.[bucket];
        if (!assets || assets.length === 0) return Promise.resolve(null);
        return queryContract(TLA_ASSET_COMPOUNDER, { user_infos: { addr: wallet, assets } })
            .then(r => ({ bucket, entries: Array.isArray(r) ? r : [] }))
            .catch(() => ({ bucket, entries: [], _err: true }));
    }));

    let stakingResults, otherResults, ampResults;
    try {
        [stakingResults, otherResults, ampResults] = await Promise.all([
            Promise.all(stakingPromises),
            otherPromises,
            ampPromises,
        ]);
    } catch (e) {
        portfolio._errors.push(`Main query batch failed: ${e.message}`);
        return portfolio;
    }
    const [userInfo, pendingRebase, locksList, userClaimable, bankBalances] = otherResults;

    // ====== LP positions ======
    portfolio.lp_positions = [];

    // Step 1: NON-AMPLIFIED positions from staking contracts.
    // The staking contracts also return DUST entries (shares=1, amount=0) for users who
    // ever interacted with a pool but withdrew everything. We filter those out.
    for (const { bucket, staked } of stakingResults) {
        for (const entry of staked) {
            try {
                const assetInfo = entry.asset?.info;
                const shares = parseFloat(entry.shares) || 0;
                const balance = parseFloat(entry.asset?.amount) || 0;
                const totalShares = parseFloat(entry.total_shares) || 0;

                // Dust filter: shares=1 with amount=0 means stale leftover, not real position
                if (shares <= 1 && balance === 0) continue;
                if (shares === 0 && balance === 0) continue;

                const pool = findPoolByAssetInfo(assetInfo, ctx);
                const mechanism = classifyStakeMechanism(entry);

                let position = {
                    bucket,
                    pool_name: pool?.name || null,
                    dex: pool?.dex || null,
                    pool_gauge_id: pool?.gauge_pool_id || null,
                    pool_address: pool?.pool_address || null,
                    is_amplified: mechanism.is_amplified,
                    position_type: mechanism.position_type,
                    stake_config_kind: mechanism.stake_config_kind,
                    source: 'staking_contract',
                    amplp_shares_raw: entry.shares,
                    amplp_balance_raw: entry.asset?.amount,
                    user_shares_human: shares / 1e6,
                    user_balance_human: balance / 1e6,
                    pool_total_shares: entry.total_shares || null,
                    user_pct_of_pool: null,
                    estimated_position_usd: null,
                    pool_apr_pct: pool?.rewards?.approx_apr_pct || null,
                };

                if (totalShares > 0) {
                    position.user_pct_of_pool = (shares / totalShares) * 100;
                }

                if (pool && position.user_pct_of_pool != null) {
                    const poolStakedUsd = pool.staked_in_tla_usd;
                    if (poolStakedUsd) {
                        position.estimated_position_usd = poolStakedUsd * (position.user_pct_of_pool / 100);
                    }
                }

                position.underlying_token_amounts = [];
                if (pool?.lp_health) {
                    for (const k of ['asset_0', 'asset_1']) {
                        const a = pool.lp_health[k];
                        if (!a) continue;
                        const userAmount = (a.amount_human || 0) * (position.user_pct_of_pool / 100 || 0);
                        position.underlying_token_amounts.push({
                            symbol: a.symbol,
                            amount_human: userAmount,
                            usd_value: a.price_usd ? userAmount * a.price_usd : null,
                            price_usd: a.price_usd,
                        });
                    }
                }

                Object.assign(position, poolStatusFlag(pool));
                portfolio.lp_positions.push(position);
            } catch (e) {
                portfolio._errors.push(`LP position parse ${bucket}: ${e.message}`);
            }
        }
    }

    // Step 2: AMPLIFIED positions from the asset-compounder.
    // These are stored in the compounder, not the staking contract. Each entry has
    // user_amplp (user's share of the compounder) and user_lp (the underlying LP amount).
    for (const ampBucket of ampResults || []) {
        if (!ampBucket?.entries) continue;
        const { bucket, entries } = ampBucket;
        for (const entry of entries) {
            try {
                const userLp = parseFloat(entry.user_lp) || 0;
                const userAmplp = parseFloat(entry.user_amplp) || 0;
                if (userLp === 0 && userAmplp === 0) continue;

                const assetInfo = entry.asset;
                const pool = findPoolByAssetInfo(assetInfo, ctx);

                let position = {
                    bucket,
                    pool_name: pool?.name || null,
                    dex: pool?.dex || null,
                    pool_gauge_id: pool?.gauge_pool_id || null,
                    pool_address: pool?.pool_address || null,
                    is_amplified: true,
                    position_type: 'amplified',
                    stake_config_kind: 'compounder',
                    source: 'asset_compounder',
                    user_amplp_raw: entry.user_amplp,
                    user_lp_raw: entry.user_lp,
                    user_amplp_human: userAmplp / 1e6,
                    user_lp_human: userLp / 1e6,
                    compounder_total_lp: entry.total_lp,
                    compounder_total_amplp: entry.total_amplp,
                    user_pct_of_pool: null,
                    estimated_position_usd: null,
                    pool_apr_pct: pool?.rewards?.approx_apr_pct || null,
                };

                // user_pct_of_pool = user_lp / pool's total LP token supply
                // pool's total LP supply lives in pool.lp_health.total_share (LP pools)
                // For single-asset pools, no lp_health exists — use the staking-side denominator
                if (pool?.lp_health?.total_share) {
                    const totalSupply = parseFloat(pool.lp_health.total_share) || 0;
                    if (totalSupply > 0) {
                        position.user_pct_of_pool = (userLp / totalSupply) * 100;
                    }
                }
                // USD valuation: prefer pool.depth_usd (full DEX TVL), fall back to
                // staked_in_tla_usd (only what's staked in TLA) when depth_usd unavailable
                if (position.user_pct_of_pool != null) {
                    const referenceUsd = pool?.depth_usd ?? pool?.staked_in_tla_usd;
                    if (referenceUsd) {
                        position.estimated_position_usd = referenceUsd * (position.user_pct_of_pool / 100);
                    }
                }
                // Single-asset amplified pools (e.g. ampCAPA): no lp_health, no depth_usd.
                // user_lp is the underlying token amount (NOT LP shares). Price it directly
                // by looking up the pool's symbol in token_prices (most accurate).
                if (position.estimated_position_usd == null && !pool?.lp_health) {
                    const symbol = pool?.name;
                    const priceUsd = symbol ? ctx.tokenPrices?.[symbol]?.final_price_usd : null;
                    if (priceUsd) {
                        position.estimated_position_usd = (userLp / 1e6) * priceUsd;
                        position.price_source = `token_prices[${symbol}]`;
                    } else {
                        // Last-resort fallback: compounder share × pool TLA-staked USD.
                        // Less accurate because the compounder may be only a portion of
                        // total stakers in the single bucket — kept only to avoid null USD.
                        const totalLp = parseFloat(entry.total_lp) || 0;
                        if (totalLp > 0 && pool?.staked_in_tla_usd) {
                            const compounderShare = userLp / totalLp;
                            position.user_pct_of_pool = compounderShare * 100;
                            position.estimated_position_usd = pool.staked_in_tla_usd * compounderShare;
                            position.price_source = 'compounder_share_fallback';
                        }
                    }
                }

                position.underlying_token_amounts = [];
                if (pool?.lp_health && position.user_pct_of_pool != null) {
                    for (const k of ['asset_0', 'asset_1']) {
                        const a = pool.lp_health[k];
                        if (!a) continue;
                        const userAmount = (a.amount_human || 0) * (position.user_pct_of_pool / 100);
                        position.underlying_token_amounts.push({
                            symbol: a.symbol,
                            amount_human: userAmount,
                            usd_value: a.price_usd ? userAmount * a.price_usd : null,
                            price_usd: a.price_usd,
                        });
                    }
                }

                Object.assign(position, poolStatusFlag(pool));
                portfolio.lp_positions.push(position);
            } catch (e) {
                portfolio._errors.push(`Amp position parse ${bucket}: ${e.message}`);
            }
        }
    }

    // ====== Pending rewards ======
    // Rewards are paid in zluna (Alliance reward shares). 1 zluna ≠ 1 LUNA;
    // zluna accrues yield over time so its LUNA-equivalent value > 1.
    // Use the zluna→LUNA ratio fetched at shared-data load time.
    portfolio.pending_rewards = [];
    const zlunaRatio = ctx.zlunaToLunaRatio || 1;
    for (const { bucket, pending } of stakingResults) {
        for (const entry of pending) {
            try {
                const stakedInfo = entry.staked_asset_share?.info;
                const rewardInfo = entry.reward_asset?.info;
                const rewardAmount = parseFloat(entry.reward_asset?.amount) || 0;
                if (rewardAmount === 0) continue;

                const pool = findPoolByAssetInfo(stakedInfo, ctx);
                const rewardSymbol = rewardInfo?.native?.includes('zluna') ? 'zluna'
                                   : rewardInfo?.native ? rewardInfo.native.split('/').pop()
                                   : rewardInfo?.cw20 ? 'cw20' : 'unknown';

                const amountHuman = rewardAmount / 1e6;
                // For zluna: convert to LUNA-equivalent using hub ratio, then to USD
                const lunaEquivalent = rewardSymbol === 'zluna' ? amountHuman * zlunaRatio : amountHuman;
                const usdValue = ctx.lunaPriceUsd ? lunaEquivalent * ctx.lunaPriceUsd : null;

                portfolio.pending_rewards.push({
                    bucket,
                    pool_name: pool?.name || null,
                    pool_gauge_id: pool?.gauge_pool_id || null,
                    reward_symbol: rewardSymbol,
                    amount_raw: entry.reward_asset?.amount,
                    amount_human: amountHuman,
                    luna_equivalent: lunaEquivalent,
                    usd_value: usdValue,
                });
            } catch (e) {
                portfolio._errors.push(`Pending reward parse ${bucket}: ${e.message}`);
            }
        }
    }

    // ====== Voting allocations (user_info from gauge controller) ======
    portfolio.voting = {
        total_voting_power_raw: userInfo?.voting_power || '0',
        total_voting_power_human: (parseFloat(userInfo?.voting_power) || 0) / 1e6,
        fixed_amount_raw: userInfo?.fixed_amount || '0',
        fixed_amount_human: (parseFloat(userInfo?.fixed_amount) || 0) / 1e6,
        slope: userInfo?.slope || '0',
        votes_per_bucket: {},
    };
    if (Array.isArray(userInfo?.gauge_votes)) {
        for (const gv of userInfo.gauge_votes) {
            const gauge = gv.gauge;
            const votes = gv.votes || [];
            // Each vote is [poolKey, weight_bps]
            const detailed = votes.map(([poolKey, weight]) => {
                const pool = ctx.poolByGaugeId.get(poolKey);
                return {
                    pool_gauge_id: poolKey,
                    pool_name: pool?.name || null,
                    dex: pool?.dex || null,
                    weight_bps: weight,
                };
            });
            portfolio.voting.votes_per_bucket[gauge] = {
                period: gv.period,
                votes: detailed,
            };
        }
    }

    // ====== Pending rebase (gauge controller) ======
    // Rebase is paid in ampLUNA. Convert ampLUNA → LUNA via LST ratio, then to USD.
    if (pendingRebase) {
        const rebaseAmount = parseFloat(pendingRebase.amount || pendingRebase.rebase || 0) || 0;
        const amountHuman = rebaseAmount / 1e6;
        const ampLunaRatio = ctx.lstRatios?.ampLUNA?.ratio || 1;
        const lunaEquivalent = amountHuman * ampLunaRatio;
        const usdValue = ctx.lunaPriceUsd ? lunaEquivalent * ctx.lunaPriceUsd : null;
        portfolio.pending_rebase = {
            amount_raw: pendingRebase.amount || pendingRebase.rebase || '0',
            amount_human: amountHuman,
            asset_symbol: 'ampLUNA',
            luna_equivalent: lunaEquivalent,
            usd_value: usdValue,
            _raw: pendingRebase,  // include raw for debugging shape variations
        };
    } else {
        portfolio.pending_rebase = null;
    }

    // ====== Locks — get IDs, then fetch details in parallel ======
    portfolio.locks = [];
    const lockTokens = Array.isArray(locksList?.tokens) ? locksList.tokens : [];
    if (lockTokens.length > 0) {
        // Build symbol→lst_ratio map (case-insensitive)
        const symbolToLstRatio = new Map();
        for (const [k, v] of Object.entries(ctx.lstRatios)) {
            symbolToLstRatio.set(k.toLowerCase(), v);
        }

        const lockInfos = await parallelMap(lockTokens, async (tokenId) => {
            const lockInfo = await queryContract(TLA_VOTING_ESCROW, { lock_info: { token_id: tokenId, time: 'next' } });
            return { tokenId, lockInfo };
        }, 10);

        // Cache symbol lookups for cw20 assets (across all locks)
        const symbolCache = new Map();

        for (const { tokenId, lockInfo } of lockInfos) {
            if (!lockInfo || lockInfo._error) continue;
            try {
                const assetInfo = lockInfo.asset?.info;
                const assetSymbol = await resolveLockAssetSymbol(assetInfo, symbolCache);

                const lockWithSymbol = { ...lockInfo, _assetSymbol: assetSymbol };
                const projection = projectLockVp(lockWithSymbol, symbolToLstRatio);

                portfolio.locks.push({
                    token_id: tokenId,
                    asset_symbol: assetSymbol,
                    asset_info: assetInfo,
                    amount_raw: lockInfo.asset?.amount,
                    amount_human: (parseFloat(lockInfo.asset?.amount) || 0) / 1e6,
                    underlying_at_lock_raw: lockInfo.underlying_amount,
                    coefficient: parseFloat(lockInfo.coefficient) || 0,
                    voting_power_raw: lockInfo.voting_power,
                    voting_power_human: (parseFloat(lockInfo.voting_power) || 0) / 1e6,
                    fixed_amount_raw: lockInfo.fixed_amount,
                    slope: lockInfo.slope,
                    start_period: lockInfo.start,
                    from_period: lockInfo.from_period,
                    end: lockInfo.end,
                    projection,
                });
            } catch (e) {
                portfolio._errors.push(`Lock ${tokenId} parse: ${e.message}`);
            }
        }
    }

    // ====== Pending bribes ======
    // Response shape: { start, end, buckets: [{gauge, asset (pool LP), assets: [{info, amount}]}] }
    // Each bucket represents accrued bribes for ONE pool across epochs (start → end).
    // The bucket.assets[] array contains the individual reward tokens.
    portfolio.pending_bribes = [];
    const bribeSymbolCache = new Map();
    if (userClaimable?.buckets && Array.isArray(userClaimable.buckets)) {
        for (const bucket of userClaimable.buckets) {
            const poolAssetInfo = bucket.asset;
            const poolForBucket = poolAssetInfo ? findPoolByAssetInfo(poolAssetInfo, ctx) : null;
            const rewardAssets = Array.isArray(bucket.assets) ? bucket.assets : [];
            for (const rewardEntry of rewardAssets) {
                try {
                    // rewardEntry shape: { info: {cw20|native}, amount: "..." }
                    const rawAmount = rewardEntry.amount;
                    const amount = parseFloat(rawAmount) || 0;
                    if (amount === 0) continue;
                    const amountHuman = amount / 1e6;
                    const rewardAssetInfo = rewardEntry.info;
                    const priceInfo = await resolveTokenPrice(rewardAssetInfo, ctx, bribeSymbolCache);
                    portfolio.pending_bribes.push({
                        gauge: bucket.gauge || null,
                        pool_name: poolForBucket?.name || null,
                        pool_gauge_id: poolForBucket?.gauge_pool_id || null,
                        asset: rewardAssetInfo,
                        asset_symbol: priceInfo.symbol,
                        amount_raw: rawAmount,
                        amount_human: amountHuman,
                        price_usd: priceInfo.price_usd,
                        usd_value: priceInfo.price_usd ? amountHuman * priceInfo.price_usd : null,
                    });
                } catch (e) {
                    portfolio._errors.push(`Bribe parse: ${e.message}`);
                }
            }
        }
    }
    portfolio.pending_bribes_meta = {
        claim_period_start: userClaimable?.start || null,
        claim_period_end: userClaimable?.end || null,
    };

    // ====== Wallet balances (filter to TLA-relevant tokens) ======
    portfolio.wallet_balances = [];
    const TLA_RELEVANT_NATIVES = new Set(['uluna']);
    const TLA_RELEVANT_CW20S = new Set([
        'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct',  // ampLUNA
        'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml',  // bLUNA
    ]);
    for (const b of bankBalances) {
        const denom = b.denom;
        const amount = parseFloat(b.amount) || 0;
        if (amount === 0) continue;
        // Include uluna, zluna×4, and other LUNA-equivalent tokens
        const isUluna = denom === 'uluna';
        const isZluna = denom.includes('/zluna');
        const isFactoryLst = denom.startsWith('factory/') && /\/(amp|b|st|arb)?[Ll][Uu][Nn][Aa]$/.test(denom);
        if (isUluna || isZluna || isFactoryLst || TLA_RELEVANT_NATIVES.has(denom)) {
            const sym = isUluna ? 'LUNA' : (denom.split('/').pop() || denom.slice(0, 30));
            const lunaEquiv = (isUluna || isZluna || isFactoryLst) ? amount / 1e6 : null;
            portfolio.wallet_balances.push({
                denom,
                symbol: sym,
                amount_raw: b.amount,
                amount_human: amount / 1e6,
                luna_equivalent: lunaEquiv,
                usd_value: lunaEquiv && ctx.lunaPriceUsd ? lunaEquiv * ctx.lunaPriceUsd : null,
            });
        }
    }

    // ====== Summary rollup ======
    portfolio.summary = computeMemberSummary(portfolio, ctx);
    return portfolio;
}

function computeMemberSummary(portfolio, ctx) {
    const totalLpUsd = portfolio.lp_positions.reduce((s, p) => s + (p.estimated_position_usd || 0), 0);
    const totalPendingRewardsUsd = portfolio.pending_rewards.reduce((s, r) => s + (r.usd_value || 0), 0);
    const totalPendingBribesUsd = portfolio.pending_bribes.reduce((s, b) => s + (b.usd_value || 0), 0);
    const totalWalletUsd = portfolio.wallet_balances.reduce((s, w) => s + (w.usd_value || 0), 0);
    const totalLockedLunaEquiv = portfolio.locks.reduce((s, l) => {
        const u = l.projection?.underlying_now_human ?? l.projection?.underlying_at_lock_human ?? 0;
        return s + u;
    }, 0);
    const totalLockedUsd = totalLockedLunaEquiv * (ctx.lunaPriceUsd || 0);
    const totalPotentialVpGain = portfolio.locks.reduce((s, l) => s + (l.projection?.potential_vp_gain_human || 0), 0);

    // Amplified vs non-amplified LP counts and USD totals
    const ampPositions = portfolio.lp_positions.filter(p => p.is_amplified);
    const nonAmpPositions = portfolio.lp_positions.filter(p => !p.is_amplified);
    const ampPositionsUsd = ampPositions.reduce((s, p) => s + (p.estimated_position_usd || 0), 0);
    const nonAmpPositionsUsd = nonAmpPositions.reduce((s, p) => s + (p.estimated_position_usd || 0), 0);

    return {
        voting_power_human: portfolio.voting.total_voting_power_human,
        // Display VP = fixed_amount × 10 (the "potential" VP shown in Eris UI).
        // Use this for headline display to match what users see in Eris.
        // The voting_power_human field is the actual VP that determines vote weights.
        display_voting_power_human: portfolio.voting.fixed_amount_human * 10,
        fixed_amount_human: portfolio.voting.fixed_amount_human,
        lock_count: portfolio.locks.length,
        active_lp_position_count: portfolio.lp_positions.filter(p => p.status === 'active').length,
        at_risk_lp_position_count: portfolio.lp_positions.filter(p => p.status === 'at_risk').length,
        inactive_lp_position_count: portfolio.lp_positions.filter(p => p.status === 'inactive').length,
        amplified_lp_position_count: ampPositions.length,
        non_amplified_lp_position_count: nonAmpPositions.length,
        amplified_lp_usd: ampPositionsUsd,
        non_amplified_lp_usd: nonAmpPositionsUsd,
        total_lp_position_usd: totalLpUsd,
        total_pending_rewards_usd: totalPendingRewardsUsd,
        total_pending_bribes_usd: totalPendingBribesUsd,
        total_pending_bribes_count: portfolio.pending_bribes.length,
        total_wallet_balances_usd: totalWalletUsd,
        total_locked_luna_equivalent: totalLockedLunaEquiv,
        total_locked_usd: totalLockedUsd,
        total_potential_vp_gain_human: totalPotentialVpGain,
        total_portfolio_value_usd: totalLpUsd + totalPendingRewardsUsd + totalPendingBribesUsd + totalWalletUsd + totalLockedUsd,
    };
}

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

async function captureSnapshot() {
    const startedAt = new Date();
    console.log(`🚀 aDAO Positions Cron — ${startedAt.toISOString()}`);
    const epochInfo = currentEpochInfo();
    console.log(`📅 Current epoch: ${epochInfo.number} (${epochInfo.progress_pct.toFixed(1)}% through)`);

    // Phase 1: Member discovery
    const { allMembers, namedMembers, primarySource } = await resolveMembers();

    // Phase 2: Load shared data
    const ctx = await loadSharedData();

    // Phase 3: Per-member portfolio queries (parallel batched)
    console.log(`💼 Fetching portfolios for ${namedMembers.length} named members...`);
    const portfolios = await parallelMap(namedMembers, m => fetchMemberPortfolio(m, ctx), BATCH_CONCURRENCY);
    const validPortfolios = portfolios.filter(p => p && !p._error);
    console.log(`  ✓ ${validPortfolios.length}/${namedMembers.length} portfolios captured`);

    // Phase 3b: Treasury wallets (aDAO Core + any other tracked DAO addresses).
    // Tracked alongside members so the TLA Stats page can show treasury-only data.
    // Uses the same portfolio shape, just tagged with `kind`.
    console.log(`🏛️  Fetching ${ADAO_TREASURY_WALLETS.length} treasury wallet(s)...`);
    const treasuryPortfolios = await parallelMap(ADAO_TREASURY_WALLETS, t => {
        // Reuse fetchMemberPortfolio by passing a member-shaped object
        return fetchMemberPortfolio({
            address: t.address,
            name: t.label,
            nft_count: 0,
            vp_pct_of_dao: 0,
        }, ctx).then(p => {
            if (p) {
                p.kind = t.kind;
                p.is_treasury = true;
            }
            return p;
        });
    }, BATCH_CONCURRENCY);
    const validTreasuries = treasuryPortfolios.filter(p => p && !p._error);
    console.log(`  ✓ ${validTreasuries.length}/${ADAO_TREASURY_WALLETS.length} treasury portfolios captured`);
    for (const t of validTreasuries) {
        const s = t.summary || {};
        console.log(`    ${t.name}: VP ${s.voting_power_human?.toFixed(0)}, LP $${s.total_lp_position_usd?.toFixed(0)}, Locks ${s.lock_count}, Rewards $${s.total_pending_rewards_usd?.toFixed(2)}`);
    }

    // Phase 3c: Council treasury wallets. Same fetch path as aDAO treasury, but written
    // to separate top-level fields. Council has no TLA participation so most of the
    // returned portfolio shape is empty — wallet_balances + summary.total_wallet_balances_usd
    // are the meaningful fields. Failures here never block the rest of the cron.
    console.log(`🏛️  Fetching ${COUNCIL_TREASURY_WALLETS.length} council wallet(s)...`);
    const councilPortfolios = await parallelMap(COUNCIL_TREASURY_WALLETS, t => {
        return fetchMemberPortfolio({
            address: t.address,
            name: t.label,
            nft_count: 0,
            vp_pct_of_dao: 0,
        }, ctx).then(p => {
            if (p) {
                p.kind = t.kind;
                p.is_treasury = true;
            }
            return p;
        }).catch(err => {
            console.warn(`  ⚠ Council wallet ${t.label} failed: ${err.message}`);
            return null;
        });
    }, BATCH_CONCURRENCY);
    const validCouncils = councilPortfolios.filter(p => p && !p._error);
    console.log(`  ✓ ${validCouncils.length}/${COUNCIL_TREASURY_WALLETS.length} council portfolios captured`);
    for (const t of validCouncils) {
        const s = t.summary || {};
        console.log(`    ${t.name}: Wallet $${s.total_wallet_balances_usd?.toFixed(2) ?? '0.00'} (${t.wallet_balances?.length ?? 0} tokens)`);
    }

    // Phase 4: Sort + rank
    validPortfolios.sort((a, b) => (b.voting?.total_voting_power_human || 0) - (a.voting?.total_voting_power_human || 0));
    validPortfolios.forEach((p, i) => { p.rank_by_vp = i + 1; });

    // Phase 5: Rollups
    const totals = computeRollups(validPortfolios);
    console.log(`📊 Totals: ${totals.named_member_count} members, ${totals.total_voting_power_human.toFixed(0)} VP, $${totals.total_lp_position_usd.toFixed(0)} LP`);
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
        totals,
        treasury: validTreasuries.length === 1 ? validTreasuries[0] : null,
        treasuries: validTreasuries,
        council_treasury: validCouncils.length === 1 ? validCouncils[0] : null,
        council_treasuries: validCouncils,
        members: validPortfolios,
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
        const archivePath = `data/weekly/epoch-${epochInfo.number}.json`;

        await publishFile('data/members.json', membersContent, `members refresh epoch ${epochInfo.number}`);
        console.log(`  ✓ Published data/members.json`);
        await publishFile('data/current.json', portfoliosContent, `positions epoch ${epochInfo.number}`);
        console.log(`  ✓ Published data/current.json`);
        await publishFile(archivePath, portfoliosContent, `archive epoch ${epochInfo.number}`);
        console.log(`  ✓ Published ${archivePath}`);

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
        await publishFile(dailyPath, portfoliosContent, `📸 positions daily snapshot — ${dateStr}`);
        console.log(`  ✓ Published ${dailyPath}`);

        // Heartbeat — uniform freshness contract across all crons
        // Status is 'partial' if any tracked treasury fetch failed (council is optional but tracked).
        const allTreasuriesOk = validTreasuries.length === ADAO_TREASURY_WALLETS.length;
        const allCouncilsOk   = validCouncils.length === COUNCIL_TREASURY_WALLETS.length;
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
            status: (allTreasuriesOk && allCouncilsOk) ? 'ok' : 'partial',
            stats: {
                members_count: validPortfolios.length,
                treasury_present: !!portfoliosDoc.treasury,
                council_present: !!portfoliosDoc.council_treasury,
                council_count: validCouncils.length,
            },
            // Match the Render schedule. If you change Render to daily, change this to 25h.
            // If you change Render to hourly, change to 75min. The dashboard reads this
            // value to drive its freshness indicator — keep it consistent with reality.
            next_expected_run_at: new Date(startedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
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
