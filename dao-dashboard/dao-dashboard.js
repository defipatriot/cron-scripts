#!/usr/bin/env node
/* =============================================================================
 * dao-dashboard.js — DAO dashboard aggregates cron
 * =============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The legacy "TLA Admin Core v3" epoch cron died after epoch 185 (last file:
 * tla_json_storage/tla-data-epoch-185-end.json, 2026-05-17). The main dashboard
 * (index.html) reads its `dashboard` block for four tiles:
 *   - DAO Unclaimed Rewards (Deposit / Vote / Rebase)
 *   - DAO TLA Deposits (per-token breakdown + total)
 *   - Lion DAO alliance row
 *   - TLA LPs term in the DAO TOTAL VALUE strip
 * Without a successor those tiles are frozen at epoch-185 values forever
 * (the page's walk-back finds 185 and flags it stale — honest, but stuck).
 *
 * WHAT THIS EMITS
 * ---------------
 * data/dao-dashboard.json in tla-snapshot-data_2026 (same repo the TLA
 * snapshot cron writes — precedent: tla-vp-holders also shares it), in a
 * legacy-v3-compatible shape so index.html consumers work unchanged:
 *
 *   { meta: { version, epoch, phase:'live', generated_at, source, status, errors },
 *     dashboard: {
 *       unclaimed_rewards: { ampLUNA, zAssets, deposit_rewards_usd },
 *       vote_rewards:      { by_token: {SYM:{amount,price,usd}}, periods:[..] },
 *       rebase:            { ampLUNA, usd },
 *       tla_deposits:      { total_usd, tokens:[{symbol,amount,price,usd}],
 *                            composition: 'lp_underlying+zluna' },
 *       alliances:         { lion_dao: {...} } },
 *     token_prices: { SYM: usd } }
 *
 * Consumer contract (verified against index.html 2026-06-12):
 *   - unclaimed_rewards.ampLUNA  → deposit tile amount; USD recomputed live
 *   - unclaimed_rewards.zAssets  → raw zLUNA total (informational)
 *   - vote_rewards.by_token      → {SYM:{amount, usd}}; live-priced when possible
 *   - vote_rewards.periods       → epoch numbers with unclaimed bribes
 *   - rebase.ampLUNA             → rebase tile amount
 *   - tla_deposits.total_usd / .tokens[{symbol,amount,price,usd}]
 *   - alliances.lion_dao.chain_staking.validators[{name,address,staked_luna,
 *       unclaimed_rewards_luna}] (+ staking_apr_pct / staking_apr_date optional)
 *
 * DESIGN PRINCIPLES (house rules)
 * -------------------------------
 * - Good data or no data: each section builds independently; a failed section
 *   is emitted as null and listed in meta.errors (consumers have their own
 *   fallbacks). If BOTH unclaimed_rewards and tla_deposits fail, the run
 *   exits 1 without publishing — a file with nothing useful is worse than
 *   letting the dashboard fall back to the legacy walk-back.
 * - No silent coercions: chain query nulls (rate limits) are retried on both
 *   LCD endpoints and surfaced as section errors, never coerced to [].
 * - Live chain queries for DAO-specific state; cron files (tla-snapshot,
 *   network-and-prices) for pool/price context.
 *
 * RUNTIME
 * -------
 * Node >= 18 (native fetch). No npm dependencies.
 * Env: GITHUB_TOKEN (push), GITHUB_REPO (default defipatriot/tla-snapshot-data_2026),
 *      GITHUB_BRANCH (default main).
 * CLI: --dry  → build + print summary, no push (for local verification).
 * Suggested Render schedule: hourly at :20 ("20 * * * *") — offset from the
 * TLA snapshot's :40 so the two never contend for LCD rate limits.
 * ========================================================================== */

'use strict';
const https = require('https');

// ── Chain constants ──────────────────────────────────────────────────────────
const DAO_MAIN_WALLET = 'terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm';

const TLA_GAUGE_CONTROLLER = 'terra1hfksrhchkmsj4qdq33wkksrslnfles6y2l77fmmzeep0xmq24l2smsd3lj';
const TLA_BRIBE_MANAGER    = 'terra1tuuwm8yrj54qeg0c8xu00aha9ryatyhtczq8qq2q8tntuw0auzas9037wh';
const TLA_ASSET_COMPOUNDER = 'terra1zly98gvcec54m3caxlqexce7rus6rzgplz7eketsdz7nh750h2rqvu8uzx';

const TLA_BUCKETS = ['bluechip', 'project', 'single', 'stable'];
const TLA_STAKING_BY_BUCKET = {
    bluechip: 'terra14mmvqn0kthw6sre75vku263lafn5655mkjdejqjedjga4cw0qx2qlf4arv',
    project:  'terra1awq6t7jfakg9wfjn40fk3wzwmd57mvrqtt3a39z9rmet7wdjj3ysgw3lpa',
    single:   'terra1qdz5qgafx88kp5mf6m2tah8742g4u5g2cek0m3jrgssexexk7g4qw6e23k',
    stable:   'terra1v399cx9drllm70wxfsgvfe694tdsd9x96p9ha36w7muffe4znlusqswspq',
};
const ZLUNA_CONNECTORS = {
    bluechip: 'terra16l43xt2uq09yvz4axg73n8rtm0qte9lremdwm6ph0e35r2jnm43qnl8h53',
    project:  'terra1x8v9fujf3c78q2we23x0vgzmxgtt0hgvuvfsxy4w3ar9kcua4c6qqcnhyh',
    single:   'terra1u72y7gppxrsncctvgfyqduv3md6pgq77pqhz9rxgwl3dqgye00cq7vmf8u',
    stable:   'terra1ym2495f63mdx63tu96085x2vf3xpy9z9k5urxwhvmf9jldm99q5qr4q6n8',
};

// Lion DAO alliance (constants carried over from the legacy v3 dashboard block)
const LION_VALIDATOR = 'terravaloper1dcegyrekltswvyy0xy69ydgxn9x8x32zdtapd8';
// The 10K LUNA alliance stake may be delegated from the council multisig rather
// than the main wallet — check all candidates and report whichever holds it.
const LION_DELEGATOR_CANDIDATES = [
    DAO_MAIN_WALLET,
    'terra1yqv0af22675wlcmgflxk4ve07vt8qlm999gk0cuw5l64r5xxgadsyg8ywv', // council treasury (legacy v3 block)
    'terra1qjxlk5skflwhgwgknh3hdfn93pcfhcm6q9wmm3z9zsxq7auf5nrsrqurqp', // council multisig (lib constant)
];
const LION_ALLIANCE_META = {
    description: 'Alliance with Lion DAO ecosystem',
    established: '2025-08-01',
};

// Token registry — denom/contract → symbol + decimals (mirrors lib/adao-live-data.js)
const DENOM_MAP = {
    'uluna': { symbol: 'LUNA', decimals: 6 },
    'ibc/8D8A7F7253615E5F76CB6252A1E1BD921D5EDB7BBAAF8913FB1C77FF125D9995': { symbol: 'ASTRO', decimals: 6 },
    'ibc/2C962DAB9F57FE0921435426AE75196009FAA1981BF86991203C8411F8980FDB': { symbol: 'USDC', decimals: 6 },
    'ibc/88386AC48152D48B34B082648DF836F975506F0B57DBBFC10A54213B1BF484CB': { symbol: 'wBTC', decimals: 8 },
    'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct': { symbol: 'ampLUNA', decimals: 6 },
    'terra1t4p3u8khpd7f8qzurwyafxt648dya6mp6vur3vaapswt6m24gkuqrfdhar': { symbol: 'CAPA', decimals: 6 },
    'terra10aa3zdkrc7jwuf8ekl3zq7e7m42vmzqehcmu74e4egc7xkm5kr2s0muyst': { symbol: 'SOLID', decimals: 6 },
    'terra1lxx40s29qvkrcj8fsa3yzyehy7w50umdvvnls2r830rys6lu2zns63eelv': { symbol: 'ROAR', decimals: 6 },
    'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml': { symbol: 'bLUNA', decimals: 6 },
};

// ── Data sources ─────────────────────────────────────────────────────────────
const LCD_PRIMARY  = 'https://terra-lcd.publicnode.com';
const LCD_FALLBACK = 'https://terra.publicnode.com';
const URL_TLA_SNAPSHOT   = 'https://raw.githubusercontent.com/defipatriot/tla-snapshot-data_2026/main/data/tla-snapshot.json';
const URL_NETWORK_PRICES = 'https://raw.githubusercontent.com/defipatriot/network-and-prices-data_2026/main/data/network-and-prices.json';
const URL_STAKING_APR    = 'https://raw.githubusercontent.com/defipatriot/tla-ext_json_storage/main/Staking%20APR.csv';

// ── Publish target ───────────────────────────────────────────────────────────
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO || 'defipatriot/tla-snapshot-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const OUTPUT_PATH   = 'data/dao-dashboard.json';
const DRY_RUN = process.argv.includes('--dry');

// ── HTTP plumbing ────────────────────────────────────────────────────────────
async function fetchJson(url, label) {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`${label || url} HTTP ${r.status}`);
    return r.json();
}

// Smart-contract query: primary LCD with one retry, then fallback LCD.
// Returns the .data payload or null — callers must treat null as FAILURE,
// never as "empty result" (rate-limited nulls were the original sin of the
// old pipeline).
async function queryChain(contractAddr, query) {
    const enc = Buffer.from(JSON.stringify(query)).toString('base64');
    const path = `/cosmwasm/wasm/v1/contract/${contractAddr}/smart/${enc}`;
    const tryEndpoint = async (base) => {
        try {
            const r = await fetch(base + path, { signal: AbortSignal.timeout(15000) });
            if (!r.ok) return null;
            return (await r.json()).data;
        } catch (_) { return null; }
    };
    let result = await tryEndpoint(LCD_PRIMARY);
    if (result === null) {
        await new Promise(res => setTimeout(res, 250 + Math.random() * 250));
        result = await tryEndpoint(LCD_PRIMARY);
    }
    if (result === null) result = await tryEndpoint(LCD_FALLBACK);
    return result;
}

async function lcdGet(path) {
    for (const base of [LCD_PRIMARY, LCD_FALLBACK]) {
        try {
            const r = await fetch(base + path, { signal: AbortSignal.timeout(15000) });
            if (r.ok) return r.json();
        } catch (_) { /* try next */ }
    }
    return null;
}

// ── Symbol / price helpers ───────────────────────────────────────────────────
function resolveAssetInfo(info) {
    // Accepts {native_token:{denom}}, {token:{contract_addr}}, {native}, {cw20},
    // or a bare denom/address string. Returns { key, symbol, decimals }.
    let key = null;
    if (typeof info === 'string') key = info;
    else if (info?.native_token?.denom) key = info.native_token.denom;
    else if (info?.token?.contract_addr) key = info.token.contract_addr;
    else if (info?.native) key = info.native;
    else if (info?.cw20) key = info.cw20;
    if (!key) return null;
    const known = DENOM_MAP[key];
    if (known) return { key, symbol: known.symbol, decimals: known.decimals };
    // Unknown token: short-address symbol, assume 6 decimals. Honest-unknown —
    // the consumer renders the symbol and falls back to snapshot USD (0 here).
    const short = key.startsWith('terra1') ? key.slice(0, 8) + '…' + key.slice(-4)
        : key.startsWith('ibc/') ? 'ibc…' + key.slice(-4) : key;
    return { key, symbol: short, decimals: 6 };
}

function flattenPrices(networkPrices) {
    const out = {};
    const tp = networkPrices?.token_prices || {};
    for (const [sym, obj] of Object.entries(tp)) {
        const p = obj?.final_price_usd;
        if (typeof p === 'number' && p > 0) out[sym] = p;
    }
    return out;
}

// ── Section: catalog (pool indexes + amp asset configs) ─────────────────────
async function buildCatalog(snap, prices) {
    const poolByLpAddr = {}, poolByGaugeId = {};
    for (const p of (snap.pools || [])) {
        if (p.lp_address)    poolByLpAddr[p.lp_address.toLowerCase()] = p;
        if (p.gauge_pool_id) poolByGaugeId[p.gauge_pool_id] = p;
    }
    const ampConfigs = await queryChain(TLA_ASSET_COMPOUNDER, { asset_configs: {} });
    if (ampConfigs === null) throw new Error('asset_configs query failed (null after retries)');
    const ampConfigsByGauge = {};
    for (const cfg of (Array.isArray(ampConfigs) ? ampConfigs : [])) {
        if (!ampConfigsByGauge[cfg.gauge]) ampConfigsByGauge[cfg.gauge] = [];
        ampConfigsByGauge[cfg.gauge].push([cfg.gauge, cfg.asset_info]);
    }
    const findPool = (assetInfo) => {
        if (!assetInfo) return null;
        if (assetInfo.cw20) return poolByLpAddr[assetInfo.cw20.toLowerCase()] || poolByGaugeId['cw20:' + assetInfo.cw20] || null;
        if (assetInfo.native) return poolByGaugeId['native:' + assetInfo.native] || null;
        if (assetInfo.token?.contract_addr) return poolByLpAddr[assetInfo.token.contract_addr.toLowerCase()] || null;
        if (assetInfo.native_token?.denom) return poolByGaugeId['native:' + assetInfo.native_token.denom] || null;
        return null;
    };
    return { findPool, ampConfigsByGauge, prices };
}

// ── Section: TLA deposits (positions + underlying token breakdown) ──────────
// Pure transform, exported for testing: takes raw query results + catalog.
function aggregateDeposits({ stakingResults, ampResults, zlunaBank }, catalog) {
    const failures = [
        ...stakingResults.filter(r => r._err).map(r => `staked[${r.bucket}]`),
        ...ampResults.filter(r => r._err).map(r => `amp[${r.bucket}]`),
    ];
    if (failures.length) throw new Error('LP capture partial failure: ' + failures.join(', '));

    let totalLpUsd = 0;
    const positions = []; // per-pool position list (consumed by dao_tla_deposits.html)
    const bySymbol = {}; // symbol -> { amount, usd }
    const addToken = (symbol, amount, usd) => {
        if (!symbol || !(usd > 0 || amount > 0)) return;
        if (!bySymbol[symbol]) bySymbol[symbol] = { amount: 0, usd: 0 };
        bySymbol[symbol].amount += amount;
        bySymbol[symbol].usd += usd;
    };
    // Decompose a pair-pool position into underlying tokens via lp_health,
    // scaled by the position's share of the whole pool's USD.
    const decompose = (pool, positionUsd) => {
        const lh = pool?.lp_health;
        if (!lh || !(lh.total_pool_usd > 0) || !(positionUsd > 0)) return false;
        const frac = positionUsd / lh.total_pool_usd;
        for (const a of [lh.asset_0, lh.asset_1]) {
            if (!a) continue;
            addToken(a.symbol, (a.amount_human || 0) * frac, (a.usd_value || 0) * frac);
        }
        return true;
    };

    // Non-amplified staked positions
    for (const { bucket, staked } of stakingResults) {
        for (const entry of (staked || [])) {
            const shares = parseFloat(entry.shares) || 0;
            const balance = parseFloat(entry.asset?.amount) || 0;
            if ((shares <= 1 && balance === 0) || (shares === 0 && balance === 0)) continue;
            const totalShares = parseFloat(entry.total_shares) || 0;
            const pool = catalog.findPool(entry.asset?.info);
            let positionUsd = 0;
            if (totalShares > 0 && pool?.staked_in_tla_usd) {
                positionUsd = pool.staked_in_tla_usd * (shares / totalShares);
            }
            totalLpUsd += positionUsd;
            positions.push({ bucket, pool_name: pool?.name || null, dex: pool?.dex || null, is_amplified: false, position_usd: positionUsd, pool_staked_usd: pool?.staked_in_tla_usd ?? null });
            if (!decompose(pool, positionUsd) && pool) {
                // single-asset pool: the position IS the token
                const sym = pool.lp_health?.asset_0?.symbol || pool.name;
                const price = catalog.prices[sym] || pool.lp_health?.asset_0?.price_usd || 0;
                const amt = price > 0 ? positionUsd / price : 0;
                addToken(sym, amt, positionUsd);
            }
        }
    }

    // Amplified positions
    for (const { bucket, entries } of ampResults) {
        for (const entry of (entries || [])) {
            const userLp = parseFloat(entry.user_lp) || 0;
            const userAmplp = parseFloat(entry.user_amplp) || 0;
            if (userLp === 0 && userAmplp === 0) continue;
            const pool = catalog.findPool(entry.asset);
            let positionUsd = 0;
            if (pool?.lp_health?.total_share) {
                const totalShare = parseFloat(pool.lp_health.total_share) || 0;
                if (totalShare > 0) {
                    const refUsd = pool.depth_usd ?? pool.staked_in_tla_usd;
                    if (refUsd) positionUsd = refUsd * (userLp / totalShare);
                }
            } else if (pool) {
                const sym = pool.lp_health?.asset_0?.symbol || pool.name;
                const price = catalog.prices[sym] || pool.lp_health?.asset_0?.price_usd || 0;
                positionUsd = (userLp / 1e6) * price;
            }
            totalLpUsd += positionUsd;
            positions.push({ bucket, pool_name: pool?.name || null, dex: pool?.dex || null, is_amplified: true, position_usd: positionUsd, pool_staked_usd: pool?.staked_in_tla_usd ?? null });
            if (!decompose(pool, positionUsd) && pool) {
                const sym = pool.lp_health?.asset_0?.symbol || pool.name;
                const price = catalog.prices[sym] || pool.lp_health?.asset_0?.price_usd || 0;
                const amt = price > 0 ? positionUsd / price : 0;
                addToken(sym, amt, positionUsd);
            }
        }
    }

    // zLUNA wallet balances (bank) — kept as their own token row
    let zlunaUsd = 0;
    const lunaPrice = catalog.prices.LUNA || 0;
    for (const b of (zlunaBank || [])) {
        if (/zluna/i.test(b.denom)) {
            const amt = Number(b.amount) / 1e6;
            const usd = amt * lunaPrice; // zLUNA ≈ LUNA-denominated reward asset
            zlunaUsd += usd;
            addToken('zLUNA', amt, usd);
        }
    }

    const tokens = Object.entries(bySymbol)
        .map(([symbol, t]) => ({
            symbol,
            amount: t.amount,
            price: t.amount > 0 ? t.usd / t.amount : (catalog.prices[symbol] || 0),
            usd: t.usd,
        }))
        .sort((a, b) => b.usd - a.usd);

    return {
        total_usd: totalLpUsd + zlunaUsd,
        lp_usd: totalLpUsd,
        zluna_usd: zlunaUsd,
        tokens,
        positions: positions.filter(p => p.position_usd > 0.01),
        composition: 'lp_underlying+zluna',
    };
}

async function captureDeposits(catalog) {
    const stakingResults = await Promise.all(TLA_BUCKETS.map(async b => {
        const staked = await queryChain(TLA_STAKING_BY_BUCKET[b], { all_staked_balances: { address: DAO_MAIN_WALLET } });
        if (staked === null) return { bucket: b, staked: null, _err: 'all_staked_balances null' };
        return { bucket: b, staked: Array.isArray(staked) ? staked : [] };
    }));
    const ampResults = await Promise.all(TLA_BUCKETS.map(async b => {
        const assets = catalog.ampConfigsByGauge[b];
        if (!assets || assets.length === 0) return { bucket: b, entries: [] };
        const r = await queryChain(TLA_ASSET_COMPOUNDER, { user_infos: { addr: DAO_MAIN_WALLET, assets } });
        if (r === null) return { bucket: b, entries: null, _err: 'user_infos null' };
        return { bucket: b, entries: Array.isArray(r) ? r : [] };
    }));
    const bank = await lcdGet(`/cosmos/bank/v1beta1/balances/${DAO_MAIN_WALLET}?pagination.limit=200`);
    return aggregateDeposits({ stakingResults, ampResults, zlunaBank: bank?.balances || [] }, catalog);
}

// ── Section: unclaimed rewards (deposit / vote / rebase) ────────────────────
// Pure transform, exported for testing.
function aggregateUnclaimed({ bucketResps, rebaseResp, voteResp, connectorRates }, prices, ampRatio) {
    // Null responses = failed queries, NEVER zero/empty values. A claimed rebase
    // is {amount:"0"}; null is a rate-limited query that must surface as an error.
    if (rebaseResp === null) throw new Error('user_pending_rebase null after retries');
    if (voteResp === null) throw new Error('user_claimable null after retries');
    // Deposit rewards: zLUNA per bucket → LUNA via connector share_exchange_rate
    let zTotal = 0, depositLuna = 0;
    for (const bucket of TLA_BUCKETS) {
        const resp = bucketResps[bucket];
        if (resp === null) throw new Error(`all_pending_rewards[${bucket}] null`);
        let z = 0;
        for (const item of (resp || [])) z += parseFloat(item?.reward_asset?.amount) || 0;
        zTotal += z;
        const rate = connectorRates[bucket];
        if (z > 0 && rate) depositLuna += (z / 1e6) / rate;
    }
    const lunaPrice = prices.LUNA || 0;
    const unclaimed_rewards = {
        // ampLUNA-equivalent amount (consumer: deposit tile = ampLUNA × live ampLUNA price)
        ampLUNA: ampRatio > 0 ? depositLuna / ampRatio : 0,
        zAssets: zTotal / 1e6,
        deposit_rewards_usd: depositLuna * lunaPrice,
        deposit_luna_equivalent: depositLuna,
    };

    // Rebase: ampLUNA pending from gauge controller
    const rebaseAmp = (parseFloat(rebaseResp?.amount) || 0) / 1e6;
    const rebase = {
        ampLUNA: rebaseAmp,
        usd: rebaseAmp * ampRatio * lunaPrice,
    };

    // Vote rewards: bribe-manager user_claimable → by_token + periods.
    // Schema (defensive): { start, end, buckets: [{ period|epoch, claims|assets|rewards:
    //   [{ asset|info|token..., amount }] }] }
    const by_token = {};
    const periods = new Set();
    const entries = voteResp?.buckets || voteResp?.periods || [];
    for (const ep of entries) {
        const claims = ep?.claims || ep?.assets || ep?.rewards || [];
        let epochHadClaim = false;
        for (const c of claims) {
            // amount can sit at the claim top level OR nested inside asset
            const amtRaw = parseFloat(c?.amount ?? c?.asset?.amount) || 0;
            if (amtRaw === 0) continue;
            const res = resolveAssetInfo(c.asset?.info ?? c.info ?? c.asset ?? c.token ?? c.denom);
            if (!res) continue;
            const amount = amtRaw / Math.pow(10, res.decimals);
            const price = prices[res.symbol] || 0;
            if (!by_token[res.symbol]) by_token[res.symbol] = { amount: 0, price, usd: 0 };
            by_token[res.symbol].amount += amount;
            by_token[res.symbol].usd += amount * price;
            epochHadClaim = true;
        }
        const epNum = ep?.period ?? ep?.epoch ?? null;
        if (epochHadClaim && epNum != null) periods.add(Number(epNum));
    }
    // Fallback: if entries carried no epoch numbers but the response declares a
    // claimable window (start/end) and there ARE claims, report that window.
    if (periods.size === 0 && Object.keys(by_token).length > 0
        && voteResp?.start != null && voteResp?.end != null) {
        const s = Number(voteResp.start), e = Number(voteResp.end);
        if (Number.isFinite(s) && Number.isFinite(e) && e >= s && e - s < 200) {
            for (let i = s; i <= e; i++) periods.add(i);
        }
    }
    const vote_rewards = {
        by_token,
        periods: [...periods].sort((a, b) => a - b),
        total_usd: Object.values(by_token).reduce((s, t) => s + t.usd, 0),
    };

    return { unclaimed_rewards, vote_rewards, rebase };
}

async function captureUnclaimed(prices, ampRatio) {
    const [bc, pr, sn, st, rebaseResp, voteResp, prConn, snConn] = await Promise.all([
        queryChain(TLA_STAKING_BY_BUCKET.bluechip, { all_pending_rewards: { address: DAO_MAIN_WALLET } }),
        queryChain(TLA_STAKING_BY_BUCKET.project,  { all_pending_rewards: { address: DAO_MAIN_WALLET } }),
        queryChain(TLA_STAKING_BY_BUCKET.single,   { all_pending_rewards: { address: DAO_MAIN_WALLET } }),
        queryChain(TLA_STAKING_BY_BUCKET.stable,   { all_pending_rewards: { address: DAO_MAIN_WALLET } }),
        queryChain(TLA_GAUGE_CONTROLLER, { user_pending_rebase: { user: DAO_MAIN_WALLET } }),
        queryChain(TLA_BRIBE_MANAGER,    { user_claimable: { user: DAO_MAIN_WALLET } }),
        queryChain(ZLUNA_CONNECTORS.project, { state: {} }),
        queryChain(ZLUNA_CONNECTORS.single,  { state: {} }),
    ]);
    // Connector rates: project/single are the buckets the DAO uses; bluechip/
    // stable connectors exist but the DAO's zLUNA there is currently 0 — if it
    // ever isn't, those buckets contribute via the project rate as a proxy is
    // WRONG, so instead we query them lazily only when needed:
    const connectorRates = {
        project: Number(prConn?.share_exchange_rate) || null,
        single:  Number(snConn?.share_exchange_rate) || null,
        bluechip: null, stable: null,
    };
    const bucketResps = { bluechip: bc, project: pr, single: sn, stable: st };
    for (const b of ['bluechip', 'stable']) {
        let z = 0;
        for (const item of (bucketResps[b] || [])) z += parseFloat(item?.reward_asset?.amount) || 0;
        if (z > 0) {
            const conn = await queryChain(ZLUNA_CONNECTORS[b], { state: {} });
            connectorRates[b] = Number(conn?.share_exchange_rate) || null;
            if (!connectorRates[b]) throw new Error(`zLUNA in ${b} but connector rate unavailable`);
        }
    }
    return aggregateUnclaimed({ bucketResps, rebaseResp, voteResp, connectorRates }, prices, ampRatio);
}

// ── Section: DAO treasury (main-wallet balances, legacy shape) ──────────────
// Legacy v3 dashboard.treasury = [{token, amount, price, usd}] for the main
// wallet's native + cw20 holdings. dao_treasury.html uses this as the snapshot
// baseline for its "What Changed" comparison, and the daily archives give the
// treasury history charts a future. Receipt/LP tokens are not in DENOM_MAP so
// they're naturally excluded, matching the legacy isReceiptToken filtering.
async function captureTreasury(prices) {
    const bank = await lcdGet(`/cosmos/bank/v1beta1/balances/${DAO_MAIN_WALLET}?pagination.limit=200`);
    if (!bank) throw new Error('bank balances query failed');
    const tokens = [];
    for (const b of (bank.balances || [])) {
        const info = DENOM_MAP[b.denom];
        if (!info) continue;
        const amount = Number(b.amount) / Math.pow(10, info.decimals);
        if (amount <= 0) continue;
        const sym = info.symbol === 'wBTC' ? 'wBTC' : info.symbol;
        const price = prices[sym] || prices[info.symbol] || prices[info.symbol.toUpperCase()] || 0;
        tokens.push({ token: info.symbol, amount, price, usd: amount * price });
    }
    const cw20s = Object.entries(DENOM_MAP).filter(([d]) => d.startsWith('terra1'));
    const results = await Promise.all(cw20s.map(async ([contract, info]) => {
        const r = await queryChain(contract, { balance: { address: DAO_MAIN_WALLET } });
        if (r === null) return { _err: info.symbol };
        const amount = Number(r.balance || 0) / Math.pow(10, info.decimals);
        if (amount <= 0) return null;
        const price = prices[info.symbol] || prices[info.symbol.toUpperCase()] || 0;
        return { token: info.symbol, amount, price, usd: amount * price };
    }));
    const failed = results.filter(r => r?._err).map(r => r._err);
    if (failed.length) throw new Error('cw20 balance null after retries: ' + failed.join(','));
    for (const r of results) if (r && !r._err) tokens.push(r);
    tokens.sort((a, b) => b.usd - a.usd);
    return { tokens, total_usd: tokens.reduce((s, t) => s + t.usd, 0) };
}

// ── Section: Lion DAO alliance (chain staking) ──────────────────────────────
async function captureLionAlliance() {
    // Find the Lion delegation by VALIDATOR MONIKER, not a hardcoded address.
    // Lesson from 2026-06-12: the legacy epoch-185 file's validator address
    // matched no delegation, yet DAODAO's treasury page (standard staking
    // module via RPC ABCI) shows 10,000 LUNA staked to "The Lion DAO" from
    // the main wallet — i.e. the validator address rotated/differed. Matching
    // the moniker (or the legacy address as a fallback) survives rotation.
    let stakedLuna = 0, rewardLuna = 0, delegatorWallet = null, lionValoper = null, lionMoniker = null, anyQueryOk = false;
    for (const wallet of LION_DELEGATOR_CANDIDATES) {
        const dels = await lcdGet(`/cosmos/staking/v1beta1/delegations/${wallet}`);
        if (!dels) continue;
        anyQueryOk = true;
        for (const d of (dels.delegation_responses || [])) {
            const val = d.delegation?.validator_address;
            if (!val) continue;
            let moniker = '';
            const vi = await lcdGet(`/cosmos/staking/v1beta1/validators/${val}`);
            moniker = vi?.validator?.description?.moniker || '';
            if (/lion/i.test(moniker) || val === LION_VALIDATOR) {
                stakedLuna += Number(d.balance?.amount || 0) / 1e6;
                delegatorWallet = wallet;
                lionValoper = val;
                lionMoniker = moniker || 'Lion DAO';
                const rews = await lcdGet(`/cosmos/distribution/v1beta1/delegators/${wallet}/rewards`);
                const vr = (rews?.rewards || []).find(r => r.validator_address === val);
                for (const c of (vr?.reward || [])) {
                    if (c.denom === 'uluna') rewardLuna += Number(c.amount) / 1e6;
                }
            }
        }
        if (lionValoper) break;
    }
    if (!anyQueryOk) throw new Error('delegations query failed for all candidate wallets');
    const apr = await (async () => {
            try {
                const r = await fetch(URL_STAKING_APR, { signal: AbortSignal.timeout(15000) });
                if (!r.ok) return null;
                const lines = (await r.text()).replace(/^\uFEFF/, '').trim().split(/\r?\n/);
                const last = lines[lines.length - 1];
                const m = last.match(/"?(\d{4}-\d{2}-\d{2})"?\s*,\s*"?(-?\d+(?:\.\d+)?)"?/);
                return m ? { date: m[1], apr: parseFloat(m[2]) } : null;
            } catch (_) { return null; }
        })();
    const chain_staking = {
        validators: [{
            name: lionMoniker || 'Lion DAO',
            address: lionValoper || LION_VALIDATOR,
            staked_luna: stakedLuna,
            unclaimed_rewards_luna: rewardLuna,
            delegator_wallet: delegatorWallet,
        }],
    };
    if (apr) { chain_staking.staking_apr_pct = apr.apr; chain_staking.staking_apr_date = apr.date; }
    return { lion_dao: { ...LION_ALLIANCE_META, chain_staking } };
}

// ── GitHub publish (pattern from tla-snapshot.js) ────────────────────────────
function githubApiRequest(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.github.com', path: apiPath, method,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent': 'aDAO-dao-dashboard/1.0',
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
            },
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data || '{}') }); } catch { resolve({ status: res.statusCode, data: {} }); } });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function pushToGithub(filepath, content, message) {
    const apiPath = `/repos/${GITHUB_REPO}/contents/${filepath}`;
    const existing = await githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}`);
    const sha = existing.data?.sha;
    const body = { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH, ...(sha ? { sha } : {}) };
    const result = await githubApiRequest('PUT', apiPath, body);
    if (result.status === 200 || result.status === 201) { console.log(`  ✅ ${filepath}`); return true; }
    console.error(`  ❌ Push failed (HTTP ${result.status}): ${result.data?.message || '<no message>'}`);
    return false;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log(`dao-dashboard cron — ${new Date().toISOString()}${DRY_RUN ? ' (DRY RUN)' : ''}`);
    const errors = [];

    // Context: epoch + pools (tla-snapshot), prices + LST ratios (network-and-prices)
    // Cache-buster: when chained in the same Render job right after tla-snapshot,
    // the raw.githubusercontent CDN (~5 min) would otherwise serve the previous
    // hour's snapshot. Query strings are distinct cache keys, so this reads fresh.
    const bust = `?t=${Date.now()}`;
    const [snap, net] = await Promise.all([
        fetchJson(URL_TLA_SNAPSHOT + bust, 'tla-snapshot'),
        fetchJson(URL_NETWORK_PRICES + bust, 'network-and-prices'),
    ]);
    const prices = flattenPrices(net);
    const ampRatio = net?.lst_ratios?.ampLUNA?.ratio || 0;
    if (!prices.LUNA || !ampRatio) throw new Error('price context unusable (LUNA price or ampLUNA ratio missing)');
    const epoch = snap?.epoch?.currentEpoch ?? null;
    console.log(`  context: epoch ${epoch}, LUNA $${prices.LUNA}, ampLUNA ratio ${ampRatio.toFixed(4)}`);

    let catalog = null;
    try { catalog = await buildCatalog(snap, prices); }
    catch (e) { errors.push(`catalog: ${e.message}`); }

    // Independent sections — each failure is recorded, not fatal (yet)
    let deposits = null, unclaimed = null, alliances = null;
    if (catalog) {
        try { deposits = await captureDeposits(catalog); console.log(`  tla_deposits: $${deposits.total_usd.toFixed(2)} across ${deposits.tokens.length} tokens`); }
        catch (e) { errors.push(`tla_deposits: ${e.message}`); }
    } else { errors.push('tla_deposits: skipped (no catalog)'); }

    try {
        unclaimed = await captureUnclaimed(prices, ampRatio);
        console.log(`  unclaimed: deposit ${unclaimed.unclaimed_rewards.deposit_luna_equivalent.toFixed(2)} LUNA-eq, rebase ${unclaimed.rebase.ampLUNA.toFixed(2)} ampLUNA, vote tokens ${Object.keys(unclaimed.vote_rewards.by_token).length}`);
    } catch (e) { errors.push(`unclaimed_rewards: ${e.message}`); }

    try { alliances = await captureLionAlliance(); console.log(`  lion_dao: ${alliances.lion_dao.chain_staking.validators[0].staked_luna} LUNA staked`); }
    catch (e) { errors.push(`alliances: ${e.message}`); }

    let treasury = null;
    try { treasury = await captureTreasury(prices); console.log(`  treasury: $${treasury.total_usd.toFixed(2)} across ${treasury.tokens.length} tokens`); }
    catch (e) { errors.push(`treasury: ${e.message}`); }

    // Hard-fail rule: if the two headline sections both failed, don't publish.
    if (!deposits && !unclaimed) {
        console.error('  ❌ both tla_deposits and unclaimed_rewards failed — not publishing. Errors:', errors);
        process.exit(1);
    }

    const payload = {
        meta: {
            version: 'dao-dashboard-1.0',
            epoch,
            phase: 'live',
            generated_at: new Date().toISOString(),
            source: 'dao-dashboard cron (cron-scripts/dao-dashboard)',
            status: errors.length ? 'partial' : 'ok',
            errors,
        },
        dashboard: {
            treasury,
            unclaimed_rewards: unclaimed ? unclaimed.unclaimed_rewards : null,
            vote_rewards:      unclaimed ? unclaimed.vote_rewards : null,
            rebase:            unclaimed ? unclaimed.rebase : null,
            tla_deposits:      deposits,
            alliances:         alliances,
        },
        token_prices: prices,
    };

    const json = JSON.stringify(payload, null, 2);
    if (DRY_RUN) {
        console.log('\n--- DRY RUN payload (truncated) ---');
        console.log(json.slice(0, 2000));
        console.log(`\n  status: ${payload.meta.status}${errors.length ? ' — ' + errors.join('; ') : ''}`);
        return;
    }
    if (!GITHUB_TOKEN) { console.error('  ❌ GITHUB_TOKEN not set'); process.exit(1); }
    const ok = await pushToGithub(OUTPUT_PATH, json, `dao-dashboard — epoch ${epoch} ${payload.meta.status} (${new Date().toISOString().slice(0, 16)}Z)`);
    if (!ok) process.exit(1);

    // Daily archive: first successful run of each UTC day is preserved at
    // data/daily/dao-dashboard-YYYY-MM-DD.json so the dashboard's chart modals
    // can accrue TLA-metric history (deposits, vote/deposit/rebase USD) going
    // forward — the legacy per-epoch history died at 185. Skipped if today's
    // archive already exists (one commit per day, not 24).
    try {
        const day = new Date().toISOString().slice(0, 10);
        const archivePath = `data/daily/dao-dashboard-${day}.json`;
        const existing = await githubApiRequest('GET', `/repos/${GITHUB_REPO}/contents/${archivePath}?ref=${GITHUB_BRANCH}`);
        if (existing.status === 404) {
            await pushToGithub(archivePath, json, `dao-dashboard daily archive ${day}`);
        }
    } catch (e) { console.warn(`  ⚠ daily archive skipped: ${e.message}`); }

    console.log(`  done: ${payload.meta.status}${errors.length ? ' — ' + errors.join('; ') : ''}`);
}

// Exported for offline transform testing (sandbox can't reach the LCD)
module.exports = { aggregateDeposits, aggregateUnclaimed, resolveAssetInfo, flattenPrices };

if (require.main === module) {
    main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}
