// =============================================================================
// Votion Positions Cron
// =============================================================================
//
// Captures every Votion vault user's position. Votion is a liquid-lock wrapper
// around veLUNA: deposit an LST, get a factory "v-token" share, the vault pools
// everything into ONE veLUNA lock it owns and auto-compounds + auto-votes. Sold
// as a {LST} × {duration} matrix — each cell its own contract (code_id 3677,
// label "votion-la").
//
// Votion users are INVISIBLE to every other cron (their LST is locked inside a
// vault's single NFT). This cron makes them visible AND re-attributes the big
// "anonymous whale" lock-holders (the vaults) to their real underlying users.
//
// v1 scope: live holdings + per-vault system view.
//   - Discover holders via tx_search of the `votion-la/deposit` action (factory
//     denoms have no all_accounts query, so we reconstruct the userbase from
//     deposit events, then read each holder's CURRENT vdenom bank balance).
//   - Value: vtoken_balance × exchange_rate (staked / vdenom_supply) = underlying
//     LST → USD; user share of vault lock VP = implied VP.
// (v1.1 = full deposit-history backfill; v1.2 = realized compounding yield from
//  the daily Compound txs. Hooks noted but not built.)
//
// Output repo: votion-positions-data_2026
//   data/current.json     — per-vault: system view + holders with positions
//   data/vaults.json       — light: vault list + exchange rates + TVL
//   data/heartbeat.json
// =============================================================================

'use strict';

const https = require('https');
const fs = require('fs');

const {
    loadSharedData,
    queryContract,
    parallelMap,
    fetchBankBalances,
    fetchJson,
    fetchText,
    bech32AddressToHex,
    currentEpochInfo,
    PFPK_BASE_URL,
    PFPK_TIMEOUT_MS,
    BATCH_CONCURRENCY,
    TERRA_LCD_PRIMARY,
    TERRA_LCD_FALLBACK,
    TLA_VOTING_ESCROW,
} = require('../lib/capture-engine.js');
const { ErrorLog } = require('../lib/error-reporter.js');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/votion-positions-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

const VOTION_CODE_ID = 3677;

// Seed vault matrix (fallback if code_id discovery is unavailable). slug + meta
// are cosmetic; the cron reads the REAL lst/duration/vdenom from each vault's
// on-chain config, so a missing label here never corrupts the data.
const SEED_VAULTS = [
    { address: 'terra13aae4futz6jk7hmdv0gwm2xs6p4nxv4xwz5tc0c2vt4960u4j6jqpqmye9', label: 'arbLUNA-MAX' },
    { address: 'terra163jnveun52hxv2kg4ys9a28h20trmccr98tnrvr92snn6yzdeg7qd9zj9l', label: 'arbLUNA-3mo' },
    { address: 'terra16xzky47caqc3krsxpla58m36ttxcjty3zpp92344m2tere5t26ysuxkjuj', label: 'arbLUNA-1wk' },
    { address: 'terra1v7aw9eartqrjrhwd6c7hkmlkspcy5q4tvc07gjmvzqezk3fttr4s3mffyz', label: 'ampLUNA-MAX' },
    { address: 'terra1dr7mv4w6chznedhp7uw6ntz9zjj4hxcdga2lmenlfuj35vmwpf0qhnzm5p', label: 'ampLUNA-3mo' },
    { address: 'terra1mzelg87h36y6wvtgj6fh9s4crgx9acw63l3zc6f9px6pc5f8h8lqs0sux0', label: 'ampLUNA-1wk' },
];

// LST contract -> symbol (for valuing underlying). Mirrors the lock-asset map.
const LST_SYMBOLS = {
    'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct': 'ampLUNA',
    'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml': 'bLUNA',
    'terra1se7rvuerys4kd2snt6vqswh9wugu49vhyzls8ymc02wl37g2p2ms5yz490': 'arbLUNA',
};

// -----------------------------------------------------------------------------
// LCD raw GET (for code-id contract listing + tx_search; engine's queryContract
// is smart-query only)
// -----------------------------------------------------------------------------
async function lcdGet(path) {
    for (const base of [TERRA_LCD_PRIMARY, TERRA_LCD_FALLBACK]) {
        try {
            const txt = await fetchText(base + path, 'lcd');
            if (txt) return JSON.parse(txt);
        } catch (e) { /* try fallback */ }
    }
    return null;
}

// -----------------------------------------------------------------------------
// Vault discovery — all code_id 3677 instances (self-maintaining); seed fallback
// -----------------------------------------------------------------------------
async function discoverVaults() {
    console.log('🔎 Discovering Votion vaults (code_id 3677)...');
    const res = await lcdGet(`/cosmwasm/wasm/v1/code/${VOTION_CODE_ID}/contracts?pagination.limit=1000`);
    let addresses = null;
    if (res && Array.isArray(res.contracts) && res.contracts.length) {
        addresses = res.contracts;
        console.log(`  ✓ ${addresses.length} vaults from chain`);
    } else {
        addresses = SEED_VAULTS.map(v => v.address);
        console.warn(`  ⚠ code_id listing unavailable — using ${addresses.length}-vault seed list`);
    }

    // Read each vault's real config (LST, vdenom, lock_id, fees)
    const vaults = await parallelMap(addresses, async (addr) => {
        const cfg = await queryContract(addr, { config: {} });
        if (!cfg) return null;
        const lstContract = cfg.lock_info?.cw20 || null;
        const seed = SEED_VAULTS.find(v => v.address === addr);
        return {
            address: addr,
            label: seed?.label || null,
            lst_contract: lstContract,
            lst_symbol: lstContract ? (LST_SYMBOLS[lstContract] || lstContract) : null,
            vdenom: cfg.vdenom || null,
            lock_id: cfg.lock_id || null,
            protocol_fee: cfg.protocol_fee != null ? Number(cfg.protocol_fee) : null,
        };
    }, BATCH_CONCURRENCY);
    return vaults.filter(Boolean);
}

// -----------------------------------------------------------------------------
// Per-vault state: total staked LST, vdenom supply -> exchange rate, lock VP
// -----------------------------------------------------------------------------
async function loadVaultState(vault, ctx) {
    // Total underlying LST = the vault's `{state:{}}` -> `staked` field. This is
    // EXACTLY the query Votion's own UI uses (verified byte-for-byte against their
    // displayed TVL: arbLUNA-MAX 207,069.98, ampLUNA-MAX 51,063.53, etc.). My
    // earlier `{staked:{}}` guess was wrong — the field lives under `state`.
    let stakedRaw = null;
    const stateRes = await queryContract(vault.address, { state: {} });
    if (stateRes && stateRes.staked != null) stakedRaw = Number(stateRes.staked);

    // Lock VP from the escrow (the vault owns one lock NFT). lock_info is the
    // known-good query tla-locks uses on all 431 locks.
    let lockVp = null;
    if (vault.lock_id) {
        const li = await queryContract(TLA_VOTING_ESCROW, { lock_info: { token_id: String(vault.lock_id), time: 'next' } });
        if (li && li.voting_power != null) lockVp = Number(li.voting_power) / 1e6;
    }

    // vdenom total supply (factory denom) via bank
    let supplyRaw = null;
    if (vault.vdenom) {
        const sup = await lcdGet(`/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(vault.vdenom)}`);
        if (sup && sup.amount && sup.amount.amount != null) supplyRaw = Number(sup.amount.amount);
    }

    // exchange rate = underlying LST (from the lock) / vdenom supply = LST per vtoken.
    // The vault's bond ratio — DISTINCT from the LST->LUNA ratio (don't conflate).
    const exchangeRate = (stakedRaw != null && supplyRaw && supplyRaw > 0) ? stakedRaw / supplyRaw : null;
    const exchangeRateSource = exchangeRate != null ? 'state_staked_div_supply' : null;

    return {
        staked_lst_raw: stakedRaw,
        staked_lst_human: stakedRaw != null ? stakedRaw / 1e6 : null,
        vdenom_supply_raw: supplyRaw,
        vdenom_supply_human: supplyRaw != null ? supplyRaw / 1e6 : null,
        exchange_rate: exchangeRate,
        exchange_rate_source: exchangeRateSource,
        lock_vp_human: lockVp,
    };
}

// -----------------------------------------------------------------------------
// Holder discovery — reconstruct from deposit events (factory denoms have no
// all_accounts). tx_search the vault for action='votion-la/deposit'.
// F1: publicnode ignores offset → page with page= + DESC; F2: null≠[].
// -----------------------------------------------------------------------------
async function discoverHolders(vault) {
    const recipients = new Set();
    let page = 1, complete = true, totalPages = null;
    const query = encodeURIComponent(`wasm._contract_address='${vault.address}' AND wasm.action='votion-la/deposit'`);
    while (true) {
        const res = await lcdGet(`/cosmos/tx/v1beta1/txs?query=${query}&order_by=ORDER_BY_DESC&page=${page}&limit=100`);
        if (res === null) { complete = false; break; }
        const txs = Array.isArray(res.tx_responses) ? res.tx_responses : [];
        if (totalPages == null && res.total != null) totalPages = Math.ceil(Number(res.total) / 100);
        if (txs.length === 0) break;
        for (const tr of txs) {
            // pull recipient from the votion-la/deposit event attrs
            for (const ev of (tr.events || tr.logs?.flatMap(l => l.events) || [])) {
                if (ev.type !== 'wasm') continue;
                const attrs = Object.fromEntries((ev.attributes || []).map(a => [a.key, a.value]));
                if (attrs.action === 'votion-la/deposit' && attrs.recipient) recipients.add(attrs.recipient);
            }
        }
        if (txs.length < 100) break;
        page++;
        if (page > 50) { complete = false; console.warn(`  ⚠ ${vault.label}: >50 deposit pages, stopping`); break; }
    }
    return { addresses: [...recipients], complete };
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
async function run() {
    const startedAt = new Date();
    const errors = new ErrorLog();   // safe, sanitized error capture for System Health
    const epochInfo = currentEpochInfo();
    console.log(`\n🗳  votion-positions — epoch ${epochInfo.number} — ${startedAt.toISOString()}\n`);

    const ctx = await loadSharedData();

    // Phase 1: vaults + their state
    const vaults = await discoverVaults();
    console.log(`📊 Loading state for ${vaults.length} vaults...`);
    for (const v of vaults) {
        try {
            v.state = await loadVaultState(v, ctx);
        } catch (e) {
            errors.add(`loading vault state for ${v.label || v.address.slice(0,10)}`, e);
            v.state = {};
        }
        const ex = v.state.exchange_rate;
        console.log(`  ${v.label || v.address.slice(0,12)}: staked ${v.state.staked_lst_human?.toFixed(2)} ${v.lst_symbol} | rate ${ex?.toFixed(4)} | lock VP ${v.state.lock_vp_human?.toLocaleString()}`);
    }

    // Phase 2: discover holders per vault, then value each holder's current balance
    const vaultBlocks = [];
    let anyIncomplete = false;
    for (const v of vaults) {
        if (!v.vdenom) { console.warn(`  ⚠ ${v.label}: no vdenom in config, skipping holders`); errors.add(`vault ${v.label || v.address.slice(0,10)} has no vdenom`, 'config missing vdenom — cannot enumerate holders'); vaultBlocks.push({ ...vaultLight(v), holders: [], holder_discovery_complete: false }); anyIncomplete = true; continue; }
        console.log(`👥 ${v.label}: discovering holders...`);
        const { addresses, complete } = await discoverHolders(v);
        if (!complete) anyIncomplete = true;
        console.log(`  ${addresses.length} historical depositors (complete: ${complete})`);

        // LST price for USD
        const lstRatio = priceOfLst(v.lst_symbol, ctx);   // LST -> LUNA multiple
        const lunaUsd = ctx.lunaPriceUsd || 0;

        const holders = await parallelMap(addresses, async (addr) => {
            // current vdenom bank balance
            const bals = await fetchBankBalances(addr);
            const entry = (bals || []).find(b => b.denom === v.vdenom);
            const vtokenRaw = entry ? Number(entry.amount) : 0;
            if (vtokenRaw <= 0) return null;   // deposited historically but no current balance (withdrew/transferred)
            const vtoken = vtokenRaw / 1e6;
            const underlyingLst = v.state.exchange_rate != null ? vtoken * v.state.exchange_rate : null;
            // USD via our network-and-prices feed (hub-ratio price). NOTE: for
            // arbLUNA this hub-ratio price runs ~14% above market (arbLUNA is an
            // arb strategy, not a clean staking LST), so we tag the source so the
            // UI can show both our feed and a market/CoinGecko feed side by side —
            // mismatched prices are exactly how users get misled.
            const underlyingUsd = (underlyingLst != null && lstRatio != null) ? underlyingLst * lstRatio * lunaUsd : null;
            const shareOfVault = v.state.vdenom_supply_human ? vtoken / v.state.vdenom_supply_human : null;
            const impliedVp = (shareOfVault != null && v.state.lock_vp_human != null) ? shareOfVault * v.state.lock_vp_human : null;
            return {
                address: addr,
                vtoken_balance: vtoken,
                underlying_lst: underlyingLst,
                underlying_usd: underlyingUsd,
                underlying_usd_price_source: 'network-and-prices/hub-ratio',
                share_of_vault_pct: shareOfVault != null ? shareOfVault * 100 : null,
                implied_vp: impliedVp,
            };
        }, BATCH_CONCURRENCY);
        const valid = holders.filter(Boolean).sort((a, b) => (b.implied_vp || 0) - (a.implied_vp || 0));

        // PFPK names
        let named = 0;
        await parallelMap(valid, async (h) => {
            try {
                const d = await fetchJson(PFPK_BASE_URL + bech32AddressToHex(h.address), 'pfpk', PFPK_TIMEOUT_MS);
                if (d && d.name) { h.name = d.name; named++; } else h.name = null;
            } catch { h.name = null; }
        }, BATCH_CONCURRENCY);

        console.log(`  ✓ ${valid.length} current holders (${named} named), ${addresses.length - valid.length} fully exited`);
        vaultBlocks.push({
            ...vaultLight(v),
            holder_count: valid.length,
            historical_depositor_count: addresses.length,
            holder_discovery_complete: complete,
            total_underlying_usd: valid.reduce((s, h) => s + (h.underlying_usd || 0), 0),
            holders: valid,
        });
    }

    // Phase 3: assemble + publish
    const status = vaults.length === 0 ? 'error' : (anyIncomplete ? 'partial' : 'ok');
    const totalTvlUsd = vaultBlocks.reduce((s, b) => s + (b.total_underlying_usd || 0), 0);
    const totalHolders = new Set(vaultBlocks.flatMap(b => b.holders.map(h => h.address))).size;

    const fullDoc = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        epoch: epochInfo,
        retention: 'live_only',
        luna_price_used_usd: ctx.lunaPriceUsd,
        vault_count: vaults.length,
        total_tvl_usd: totalTvlUsd,
        unique_holders: totalHolders,
        vaults: vaultBlocks,
    };
    const lightDoc = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        epoch: epochInfo,
        total_tvl_usd: totalTvlUsd,
        unique_holders: totalHolders,
        vaults: vaultBlocks.map(b => ({
            address: b.address, label: b.label, lst_symbol: b.lst_symbol, vdenom: b.vdenom,
            staked_lst_human: b.staked_lst_human, exchange_rate: b.exchange_rate,
            lock_vp_human: b.lock_vp_human, holder_count: b.holder_count, total_underlying_usd: b.total_underlying_usd,
        })),
    };
    const heartbeat = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        runId: `votion-${startedAt.toISOString().replace(/[-:T.Z]/g,'').slice(0,14)}`,
        status,
        next_expected_run_at: new Date(startedAt.getTime() + 25 * 60 * 60 * 1000).toISOString(),
        stats: {
            vault_count: vaults.length,
            unique_holders: totalHolders,
            total_tvl_usd: totalTvlUsd,
            any_discovery_incomplete: anyIncomplete,
            error_count: errors.count(),
        },
        recent_errors: errors.list(),   // sanitized — safe to surface on System Health
    };

    const fullContent = JSON.stringify(fullDoc, null, 2);
    const lightContent = JSON.stringify(lightDoc, null, 2);
    const hbContent = JSON.stringify(heartbeat, null, 2);

    if (!GITHUB_TOKEN) {
        console.log('⚠️  GITHUB_TOKEN not set — saving locally');
        fs.writeFileSync('current.json', fullContent);
        fs.writeFileSync('vaults.json', lightContent);
        fs.writeFileSync('heartbeat.json', hbContent);
    } else {
        try {
            await publishFile('data/current.json', fullContent, `votion epoch ${epochInfo.number} (${totalHolders} holders)`);
            console.log('  ✓ data/current.json');
            await publishFile('data/vaults.json', lightContent, `votion vaults epoch ${epochInfo.number}`);
            console.log('  ✓ data/vaults.json');
        } catch (e) {
            errors.add('publishing votion data files', e);
        }
        // rebuild heartbeat so any publish error is captured in it, then publish hb last
        heartbeat.stats.error_count = errors.count();
        heartbeat.recent_errors = errors.list();
        if (errors.hasErrors() && heartbeat.status === 'ok') heartbeat.status = 'partial';
        try {
            await publishFile('data/heartbeat.json', JSON.stringify(heartbeat, null, 2), `heartbeat ${heartbeat.status} epoch ${epochInfo.number}`);
            console.log('  ✓ data/heartbeat.json');
        } catch (e) {
            console.error('  ✗ heartbeat publish failed:', e.message);
        }
    }

    console.log(`\n✅ votion-positions — status ${status}`);
    console.log(`   ${vaults.length} vaults, ${totalHolders} unique holders, TVL $${totalTvlUsd.toLocaleString(undefined,{maximumFractionDigits:0})}\n`);
    if (status === 'error') process.exit(2);
}

function vaultLight(v) {
    return {
        address: v.address, label: v.label, lst_symbol: v.lst_symbol, vdenom: v.vdenom,
        lock_id: v.lock_id, protocol_fee: v.protocol_fee,
        staked_lst_human: v.state?.staked_lst_human ?? null,
        vdenom_supply_human: v.state?.vdenom_supply_human ?? null,
        exchange_rate: v.state?.exchange_rate ?? null,
        lock_vp_human: v.state?.lock_vp_human ?? null,
    };
}

// LST -> LUNA multiple (ratio). LUNA=1; LSTs carry a ratio from network-and-prices.
function priceOfLst(symbol, ctx) {
    if (!symbol) return null;
    if (symbol === 'LUNA') return 1;
    const r = ctx.lstRatios?.[symbol];
    if (typeof r === 'number') return r;
    if (r && typeof r.ratio === 'number') return r.ratio;
    // fallback: token price directly in USD -> convert to LUNA multiple
    const p = ctx.tokenPrices?.[symbol]?.final_price_usd;
    if (p != null && ctx.lunaPriceUsd) return p / ctx.lunaPriceUsd;
    return null;
}

// -----------------------------------------------------------------------------
// GitHub publish
// -----------------------------------------------------------------------------
function githubApiRequest(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'api.github.com', path: apiPath, method,
            headers: {
                'User-Agent': 'votion-positions-cron/1.0',
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
                } else reject(new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${data.slice(0,200)}`));
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
    try { sha = (await githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}`)).sha; } catch (e) { /* new file */ }
    const body = { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    return githubApiRequest('PUT', apiPath, body);
}

if (require.main === module) {
    run().catch(err => { console.error('FATAL:', err); process.exit(1); });
}
