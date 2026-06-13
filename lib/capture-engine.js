/* =============================================================================
 * capture-engine.js — shared per-address position capture (TLA)
 * =============================================================================
 *
 * v1.1 (2026-06-13): + first_participation (chain-native tenure), lock
 *   end_period/is_auto_max_locked/weeks_to_unlock parsing, inactive-position
 *   10%-take-rate exposure, and VP spread (current/potential/gap) in summary.
 *
 * Extracted from adao-positions.js (2026-06-13) so every member-tracking cron
 * (adao-positions, tla-participants, pixellions-positions, liondao-positions)
 * shares ONE tested capture core. This module is DAO-AGNOSTIC: give it any
 * wallet address + a shared ctx and it returns that wallet's full TLA position
 * (LP positions, pending rewards, voting, rebase, locks, bribes, balances,
 * summary). It knows nothing about who is a "member" or how they were
 * discovered — that stays in each cron.
 *
 * Public API:
 *   loadSharedData()                  -> ctx (pools, prices, lst ratios, amp configs, zluna ratio)
 *   fetchMemberPortfolio(member, ctx) -> full portfolio object   (member = {address, name?, nft_count?, vp_pct_of_dao?, nft_image_url?})
 *   computeMemberSummary(portfolio, ctx)
 *   queryContract, fetchBankBalances, parallelMap, bech32AddressToHex, fetchJson, fetchText, encodeQuery, currentEpochInfo
 *   PFPK_BASE_URL, BATCH_CONCURRENCY, BUCKETS, and TLA contract constants
 *
 * No GITHUB_* env, no publish, no member discovery here — those are cron-side.
 * ========================================================================== */

'use strict';

// ── Endpoints ────────────────────────────────────────────────────────────────
const TERRA_LCD_PRIMARY  = 'https://terra-lcd.publicnode.com';
const TERRA_LCD_FALLBACK = 'https://terra-rest.publicnode.com';

// ── TLA contracts (DAO-agnostic) ─────────────────────────────────────────────
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

// ── Name registry (PFPK) — used by member-discovery in the crons, exported here ─
const PFPK_BASE_URL      = 'https://pfpk.daodao.zone/bech32/';

// ── Shared data sources ──────────────────────────────────────────────────────
const TLA_SNAPSHOT_URL     = 'https://raw.githubusercontent.com/defipatriot/tla-snapshot-data_2026/main/data/tla-snapshot.json';
const NETWORK_PRICES_URL   = 'https://raw.githubusercontent.com/defipatriot/network-and-prices-data_2026/main/data/network-and-prices.json';

// ── Epoch math ───────────────────────────────────────────────────────────────
const TLA_EPOCH_START_MS = Date.parse('2022-10-31T00:00:00Z');
const TLA_EPOCH_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// ── Pool classification thresholds ───────────────────────────────────────────
const POOL_ACTIVE_THRESHOLD_PCT = 1.0;
const POOL_AT_RISK_THRESHOLD_PCT = 1.5;

// ── HTTP ─────────────────────────────────────────────────────────────────────
const HTTP_TIMEOUT_MS = 25000;
const PFPK_TIMEOUT_MS = 8000;
const BATCH_CONCURRENCY = 5;

// ── bech32 ──
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

// ── HTTP primitives ──
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

// v1.3.0 — added retry-with-backoff. Previously a single transient LCD
// failure (rate limit, brief timeout, dropped connection) caused queryContract
// to return null, which downstream callers couldn't distinguish from "no
// data exists" — so positions silently vanished from the output. Now we
// retry up to 3 times total (primary → primary → fallback) with brief
// backoff before giving up.
async function queryContract(contractAddr, query, attemptFallback = true) {
    const qb = encodeQuery(query);
    const path = `/cosmwasm/wasm/v1/contract/${contractAddr}/smart/${qb}`;
    const label = `query ${contractAddr.slice(0,20)}`;

    // Try primary endpoint up to 2x with brief backoff
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const r = await fetchJson(TERRA_LCD_PRIMARY + path, `${label} (try ${attempt})`);
            return r.data;
        } catch (e) {
            if (attempt < 2) {
                // Brief jittered backoff before retry
                await new Promise(res => setTimeout(res, 200 + Math.random() * 300));
            }
        }
    }

    // Both primary attempts failed — try fallback endpoint
    if (attemptFallback) {
        try {
            const r = await fetchJson(TERRA_LCD_FALLBACK + path, `${label} (fallback)`);
            return r.data;
        } catch (e) {
            return null;
        }
    }
    return null;
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
// ── Epoch ──
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
// ── Shared data (ctx builder) ──
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
// ── Pool / price / stake helpers ──
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

// ── Lock helpers ──
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

// ── Per-address portfolio ──
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

    // Run all the per-bucket queries in parallel.
    // v1.3.0 — surface null responses (query failed after retries) instead of
    // silently coercing them to empty arrays. Previously a transient LCD
    // failure on `all_staked_balances` would silently drop an entire bucket's
    // non-amp positions for that member.
    const stakingPromises = BUCKETS.map(b => Promise.all([
        queryContract(TLA_STAKING_CONTRACTS[b], { all_staked_balances: { address: wallet } }),
        queryContract(TLA_STAKING_CONTRACTS[b], { all_pending_rewards: { address: wallet } }),
    ]).then(([staked, pending]) => ({
        bucket: b,
        staked: staked || [],
        pending: pending || [],
        // Track which sub-queries failed so the processing loop can record them
        _stakedErr: staked === null ? 'all_staked_balances returned null after retries' : null,
        _pendingErr: pending === null ? 'all_pending_rewards returned null after retries' : null,
    })));

    // Plus per-user queries in parallel
    const otherPromises = Promise.all([
        queryContract(TLA_GAUGE_CONTROLLER, { user_info: { user: wallet, time: 'next' } }),
        queryContract(TLA_GAUGE_CONTROLLER, { user_pending_rebase: { user: wallet } }),
        queryContract(TLA_VOTING_ESCROW, { tokens: { owner: wallet, limit: 100 } }),
        queryContract(TLA_BRIBE_MANAGER, { user_claimable: { user: wallet } }),
        fetchBankBalances(wallet),
        // First epoch this wallet ever voted in — address-level tenure (chain-native,
        // not forward-accumulated). Returns {period} or null for never-voted wallets.
        queryContract(TLA_GAUGE_CONTROLLER, { user_first_participation: { user: wallet } }),
    ]);

    // Amplified positions query (one batch per bucket — each bucket has ≤21 amp pools)
    // These are stored in the asset-compounder, not the staking contract, so the 
    // staking contract returns only stale dust entries for these.
    //
    // v1.3.0 — distinguish "query failed" from "no positions". Previously a null
    // response from queryContract was silently coerced to an empty array, dropping
    // entire buckets of amp positions without any signal. Now failures propagate
    // to portfolio._errors so they're visible, and the entries field stays null
    // (not []) so downstream code can choose to handle the difference.
    const ampPromises = Promise.all(BUCKETS.map(async bucket => {
        const assets = ctx.ampConfigsByGauge?.[bucket];
        if (!assets || assets.length === 0) {
            // Bucket genuinely has no amp configs registered — return empty (not null)
            return { bucket, entries: [], queried: false };
        }
        try {
            const r = await queryContract(TLA_ASSET_COMPOUNDER, { user_infos: { addr: wallet, assets } });
            if (r === null) {
                // queryContract already retried internally and still returned null —
                // record the failure so it surfaces in _errors instead of silently
                // becoming empty entries.
                return { bucket, entries: null, queried: true, _err: 'user_infos query returned null after retries' };
            }
            return { bucket, entries: Array.isArray(r) ? r : [], queried: true };
        } catch (e) {
            return { bucket, entries: null, queried: true, _err: e.message };
        }
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
    const [userInfo, pendingRebase, locksList, userClaimable, bankBalances, firstParticipation] = otherResults;

    // ====== First participation (tenure) ======
    // Chain-native: the gauge contract tracks the first epoch a wallet voted.
    // null for wallets that hold/lock but never voted — those fall back (at the
    // consumer layer) to a lock's start_period if tenure display is needed.
    const fpPeriod = (firstParticipation && firstParticipation.period != null)
        ? Number(firstParticipation.period) : null;
    portfolio.first_participation = {
        period: fpPeriod,
        // Calendar date derived from the canonical weekly cadence (epoch 1 = 2022-10-31).
        // For display, consumers should prefer epoch_1-300_date.json; this is a convenience.
        approx_date: fpPeriod != null
            ? new Date(Date.parse('2022-10-31T00:00:00Z') + fpPeriod * 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)
            : null,
        source: fpPeriod != null ? 'user_first_participation' : null,
    };

    // ====== LP positions ======
    portfolio.lp_positions = [];

    // Step 1: NON-AMPLIFIED positions from staking contracts.
    // The staking contracts also return DUST entries (shares=1, amount=0) for users who
    // ever interacted with a pool but withdrew everything. We filter those out.
    //
    // v1.3.0 — record any per-bucket query failures so they surface in _errors.
    for (const result of stakingResults) {
        if (result._stakedErr) {
            portfolio._errors.push(`Staking query [${result.bucket}] all_staked_balances: ${result._stakedErr}`);
        }
    }
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
    //
    // v1.3.0 — handle null entries (query failed) by recording the error so it
    // surfaces in portfolio._errors. Previously failures were silently dropped.
    for (const ampBucket of ampResults || []) {
        if (!ampBucket) continue;
        if (ampBucket._err) {
            portfolio._errors.push(`Amp query [${ampBucket.bucket}] failed: ${ampBucket._err}`);
            continue;
        }
        if (!ampBucket.entries) continue;
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
    //
    // v1.3.0 — also surface per-bucket all_pending_rewards failures.
    portfolio.pending_rewards = [];
    for (const result of stakingResults) {
        if (result._pendingErr) {
            portfolio._errors.push(`Staking query [${result.bucket}] all_pending_rewards: ${result._pendingErr}`);
        }
    }
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
                    // Derived from `end` (which is either {period:N} or the string "permanent").
                    // Auto-max-lock detection: permanent + slope 0 = perpetually max-locked
                    // (not unwinding); {period:N} + slope>0 = decaying toward unlock at N.
                    end_period: (lockInfo.end && typeof lockInfo.end === 'object') ? (lockInfo.end.period ?? null) : null,
                    is_auto_max_locked: lockInfo.end === 'permanent' || (parseFloat(lockInfo.slope) || 0) === 0,
                    weeks_to_unlock: (lockInfo.end && typeof lockInfo.end === 'object' && lockInfo.end.period != null && lockInfo.from_period != null)
                        ? Math.max(0, lockInfo.end.period - lockInfo.from_period) : null,
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
// ── Summary ──
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

    // (c) Inactive-position exposure to the 10% take rate. Pools below the VP
    // threshold are "inactive" — liquidity there still has the protocol's 10%
    // take applied without earning gauge emissions, so this is value at risk.
    const TLA_TAKE_RATE = 0.10;
    const inactivePositions = portfolio.lp_positions.filter(p => p.status === 'inactive');
    const inactiveLpUsd = inactivePositions.reduce((s, p) => s + (p.estimated_position_usd || 0), 0);
    const inactiveTakeExposureUsd = inactiveLpUsd * TLA_TAKE_RATE;

    // (d) VP spread: current actual VP vs potential VP if all locks were
    // re-stamped at today's LST ratio (the stale-VP gap). Absolute gap only.
    const currentVp = portfolio.voting.total_voting_power_human || 0;
    const potentialVp = currentVp + totalPotentialVpGain;

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
        // VP spread (current vs potential-if-relocked, absolute gap)
        current_vp_human: currentVp,
        potential_vp_human: potentialVp,
        vp_gap_human: totalPotentialVpGain,
        // Inactive LP exposure to the 10% take rate
        inactive_lp_usd: inactiveLpUsd,
        inactive_take_exposure_usd: inactiveTakeExposureUsd,
        total_portfolio_value_usd: totalLpUsd + totalPendingRewardsUsd + totalPendingBribesUsd + totalWalletUsd + totalLockedUsd,
    };
}


// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
    // primary API
    loadSharedData,
    fetchMemberPortfolio,
    computeMemberSummary,
    // primitives (crons reuse for discovery + their own queries)
    queryContract,
    fetchBankBalances,
    fetchJson,
    fetchText,
    encodeQuery,
    parallelMap,
    bech32AddressToHex,
    currentEpochInfo,
    // constants
    PFPK_BASE_URL,
    BATCH_CONCURRENCY,
    HTTP_TIMEOUT_MS,
    PFPK_TIMEOUT_MS,
    BUCKETS,
    TLA_GAUGE_CONTROLLER,
    TLA_VOTING_ESCROW,
    TLA_BRIBE_MANAGER,
    TLA_ASSET_COMPOUNDER,
    TLA_STAKING_CONTRACTS,
    TERRA_LCD_PRIMARY,
    TERRA_LCD_FALLBACK,
};
