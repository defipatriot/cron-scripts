// =============================================================================
// lib/ally-capture.js — shared ally-DAO member capture
// =============================================================================
//
// Pixel Lions and Lion DAO are both DAODAO-governed DAOs whose members we want
// to track with the same TLA-position depth as aDAO. They differ in ONE thing:
// the DAODAO voting-module type (Pixel Lions = staked NFTs → daoVotingCw721Staked;
// Lion DAO = staked ROAR token → daoVotingTokenStaked). Everything else — name
// resolution, engine-based TLA capture, registered-only filtering, output shape
// — is identical, so it lives here and each ally cron is a thin config wrapper.
//
// This module sits in lib/ alongside capture-engine.js and imports it.
//
// Discovery is fully runtime-resolved from the DAO CORE address (no hardcoded
// voting contract that could drift): core → dumpState → votingModule, then the
// type-appropriate topStakers endpoint.
// =============================================================================

'use strict';

const {
    loadSharedData,
    fetchMemberPortfolio,
    parallelMap,
    bech32AddressToHex,
    fetchJson,
    currentEpochInfo,
    PFPK_BASE_URL,
    PFPK_TIMEOUT_MS,
    BATCH_CONCURRENCY,
} = require('./capture-engine.js');

const DAODAO_INDEXER = 'https://indexer.daodao.zone/phoenix-1/contract';

// Resolve the voting module address from the DAO core via the indexer.
async function resolveVotingModule(coreAddress) {
    const url = `${DAODAO_INDEXER}/${coreAddress}/daoCore/votingModule`;
    const vm = await fetchJson(url, 'daodao-votingModule').catch(e => {
        console.warn(`  ⚠ votingModule resolve failed: ${e.message}`);
        return null;
    });
    // Some indexer builds return the bare string, others {data:"terra1..."}.
    if (typeof vm === 'string' && vm.startsWith('terra1')) return vm;
    if (vm && typeof vm.data === 'string') return vm.data;
    if (vm && typeof vm.votingModule === 'string') return vm.votingModule;
    return null;
}

// Fetch the staker list from the voting module, using the type-appropriate
// endpoint. Both return [{address, count|power, votingPowerPercent}] shape.
async function fetchStakers(votingModule, stakeType) {
    // Map our config stakeType -> the DAODAO indexer formula for that voting-
    // module contract type. Confirmed against live contract `info` queries:
    //   nft   -> crates.io:dao-voting-cw721-staked -> daoVotingCw721Staked
    //   cw20  -> crates.io:dao-voting-cw20-staked  -> daoVotingCw20Staked
    //   token -> crates.io:dao-voting-token-staked -> daoVotingTokenStaked
    // (Lion DAO is cw20-staked despite ROAR being the staked asset.)
    const FORMULA_BY_TYPE = {
        nft:   'daoVotingCw721Staked',
        cw20:  'daoVotingCw20Staked',
        token: 'daoVotingTokenStaked',
    };
    const formula = FORMULA_BY_TYPE[stakeType] || 'daoVotingTokenStaked';
    const url = `${DAODAO_INDEXER}/${votingModule}/${formula}/topStakers`;
    const data = await fetchJson(url, `daodao-topStakers-${stakeType}`).catch(e => {
        console.warn(`  ⚠ topStakers failed: ${e.message}`);
        return null;
    });
    if (!Array.isArray(data)) return null;
    return data.map(m => ({
        address: m.address,
        // For NFT DAOs `count` is NFT count; for token DAOs it's the staked
        // token amount (raw micro-units — e.g. ROAR in the billions). We carry
        // it through as `stake_raw` without valuing it (v1 skips stake USD).
        stake_raw: m.count ?? m.power ?? m.balance ?? null,
        vp_pct_of_dao: m.votingPowerPercent || 0,
        source: 'daodao_indexer',
    }));
}

// PFPK name resolution (per-address; failures leave name null).
async function resolveNames(members) {
    let named = 0;
    await parallelMap(members, async (m) => {
        try {
            const hex = bech32AddressToHex(m.address);
            const data = await fetchJson(PFPK_BASE_URL + hex, 'pfpk', PFPK_TIMEOUT_MS);
            if (data && data.name) { m.name = data.name; named++; }
            else m.name = null;
        } catch { m.name = null; }
    }, BATCH_CONCURRENCY);
    console.log(`  ✓ PFPK names: ${named}/${members.length} resolved`);
    return named;
}

// Main capture for an ally DAO. Returns the full result object the cron publishes.
//   config = { name, coreAddress, stakeType: 'nft'|'token', retention: 'registered_only' }
async function captureAlly(config) {
    const startedAt = new Date();
    const epochInfo = currentEpochInfo();
    console.log(`\n🚀 ${config.name} — epoch ${epochInfo.number} — ${startedAt.toISOString()}\n`);

    // Phase 1: resolve voting module from core
    console.log(`🔗 Resolving voting module for ${config.name} (${config.coreAddress})...`);
    const votingModule = await resolveVotingModule(config.coreAddress);
    if (!votingModule) {
        return { startedAt, epochInfo, status: 'error', error: 'could not resolve voting module', members: [], all_members: [] };
    }
    console.log(`  ✓ voting module: ${votingModule}`);

    // Phase 2: fetch stakers
    console.log(`👥 Fetching ${config.stakeType}-stakers...`);
    const allMembers = await fetchStakers(votingModule, config.stakeType);
    if (!allMembers) {
        return { startedAt, epochInfo, status: 'error', error: 'topStakers query failed', members: [], all_members: [], votingModule };
    }
    console.log(`  ✓ ${allMembers.length} stakers`);

    // Phase 3: PFPK names, then filter to registered-only (the ally retention rule)
    await resolveNames(allMembers);
    const registered = allMembers.filter(m => m.name && m.name.trim().length > 0);
    console.log(`  ✓ ${registered.length}/${allMembers.length} registered (named)`);

    // Phase 4: shared context + per-member TLA capture (registered only)
    const ctx = await loadSharedData();
    console.log(`💼 Capturing TLA positions for ${registered.length} registered members...`);
    const portfolios = await parallelMap(registered, async (m) => {
        const p = await fetchMemberPortfolio({
            address: m.address,
            name: m.name,
            nft_count: config.stakeType === 'nft' ? (m.stake_raw || 0) : 0,
            vp_pct_of_dao: m.vp_pct_of_dao,
        }, ctx);
        if (p) {
            p.ally = config.name;
            p.dao_stake_raw = m.stake_raw;       // NFT count or staked-token raw
            p.dao_stake_type = config.stakeType;
        }
        return p;
    }, BATCH_CONCURRENCY);
    const valid = portfolios.filter(p => p && !p._error);
    const withErrors = valid.filter(p => (p._errors || []).length > 0).length;
    console.log(`  ✓ ${valid.length}/${registered.length} portfolios captured (${withErrors} with errors)`);

    // Phase 5: rank by VP
    valid.sort((a, b) => (b.voting?.total_voting_power_human || 0) - (a.voting?.total_voting_power_human || 0));
    valid.forEach((p, i) => { p.rank_by_vp = i + 1; });

    const status = valid.length === 0 ? 'error' : (withErrors > 0 ? 'partial' : 'ok');

    return {
        startedAt, epochInfo, status, votingModule,
        ctx_luna_price: ctx.lunaPriceUsd,
        members: valid,                 // registered members with full TLA positions
        all_members: allMembers,        // light list (all stakers, named or not)
        registered_count: registered.length,
        total_staker_count: allMembers.length,
        with_errors: withErrors,
    };
}

module.exports = { captureAlly, resolveVotingModule, fetchStakers, resolveNames };
