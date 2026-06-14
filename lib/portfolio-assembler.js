// =============================================================================
// Portfolio Assembler — splices all sources into ONE per-address portfolio
// =============================================================================
//
// Pure join logic. Given a terra address + the loaded source JSONs, returns a
// unified portfolio: { identity, nfts, tla, votion, totals, alerts }. This is the
// shape the UI renders — the page (or a cron) fetches the source repos once, then
// calls assemblePortfolio(address, sources) per saved address.
//
// No chain access. Joins on the terra address. Defensive throughout: a missing
// source degrades that section to nulls, never throws. Runs identically
// client-side (browser fetch) or server-side (cron).
//
// SOURCES (the live data repos, by their current.json shapes — verified 2026-06-14):
//   adaoPositions : adao-positions-data_2026/data/current.json  (.members[])
//   allies        : adao-allies-data_2026/data/current.json     (per-ally .members[])
//   votion        : votion-positions-data_2026/data/current.json(.vaults[].holders[])
//   nfts          : nft-inventory-data_2026/data/nfts.json      (.records[] by owner)
//   registry      : tla-chain-registry/2026/current.json        (entity labels)
//   priceFlags    : network-and-prices .../network-and-prices.json (divergence flags)
// =============================================================================

'use strict';

const { deriveAlerts } = require('./portfolio-alerts.js');

/**
 * @param {string} address terra1... wallet
 * @param {object} sources { adaoPositions, allies, votion, nfts, registry, priceFlags }
 * @returns {object} unified portfolio
 */
function assemblePortfolio(address, sources = {}) {
    const addr = String(address || '').trim();
    const out = {
        address: addr,
        capturedAt: new Date().toISOString(),
        identity: { name: null, is_member: false, is_ally: false, known_entity_label: null },
        nfts: null,
        tla: null,
        votion: null,
        totals: { portfolio_usd: 0, vp_total: 0, pending_usd: 0 },
        alerts: [],
        _sources_present: {},
    };
    if (!addr) return out;

    // --- identity: known-entity label from registry --------------------------
    const reg = sources.registry;
    out._sources_present.registry = !!reg;
    const label = lookupEntityLabel(addr, reg);
    if (label) out.identity.known_entity_label = label;

    // --- TLA: find this address in adao-positions members (or allies) --------
    const memberRec = findMember(addr, sources.adaoPositions);
    out._sources_present.adaoPositions = !!sources.adaoPositions;
    let allyRec = null, allyName = null;
    if (!memberRec && sources.allies) {
        const found = findAllyMember(addr, sources.allies);
        allyRec = found && found.member; allyName = found && found.ally;
    }
    out._sources_present.allies = !!sources.allies;

    const rec = memberRec || allyRec;
    if (rec) {
        out.identity.name = rec.name || out.identity.name;
        out.identity.is_member = !!memberRec;
        out.identity.is_ally = !!allyRec;
        if (allyName) out.identity.ally = allyName;

        // The member record carries a pre-computed `summary` block — use it as the
        // source of truth for totals rather than re-summing (it's authoritative).
        const s = rec.summary || {};
        const vpDirect = num(s.current_vp_human ?? s.voting_power_human) || num(rec.voting && rec.voting.total_voting_power_human) || 0;
        const lps = Array.isArray(rec.lp_positions) ? rec.lp_positions : [];
        const locks = Array.isArray(rec.locks) ? rec.locks : [];
        const lpUsd = num(s.total_lp_position_usd) ?? sumBy(lps, x => num(x.estimated_position_usd));

        const rewardsUsd = num(s.total_pending_rewards_usd) ?? sumBy(asArray(rec.pending_rewards), x => num(x.usd_value));
        const bribesUsd = num(s.total_pending_bribes_usd) ?? sumBy(asArray(rec.pending_bribes), x => num(x.usd_value));
        const rebaseUsd = num(rec.pending_rebase && rec.pending_rebase.usd_value) || 0;
        const pending = {
            rewards_usd: rewardsUsd || 0, bribes_usd: bribesUsd || 0, rebase_usd: rebaseUsd || 0,
            total_usd: (rewardsUsd || 0) + (bribesUsd || 0) + (rebaseUsd || 0),
        };

        out.tla = {
            lp_positions: lps,
            locks: locks,
            voting: rec.voting || null,
            vp_direct: vpDirect,
            vp_pct_of_dao: num(rec.vp_pct_of_dao),
            pending,
            vp_gap_human: num(s.vp_gap_human ?? s.total_potential_vp_gain_human),
            take_exposure_usd: num(s.inactive_take_exposure_usd),
            lp_usd: lpUsd || 0,
            locked_usd: num(s.total_locked_usd),
            wallet_balances_usd: num(s.total_wallet_balances_usd),
            summary_portfolio_usd: num(s.total_portfolio_value_usd),
            first_participation: rec.first_participation || null,
        };
    }

    // --- Votion: scan all vaults for this address ----------------------------
    out._sources_present.votion = !!sources.votion;
    const votionVaults = collectVotionForAddress(addr, sources.votion);
    if (votionVaults.length) {
        const votionUsd = sumBy(votionVaults, v => num(v.underlying_usd));
        const votionVp = sumBy(votionVaults, v => num(v.implied_vp));
        out.votion = { vaults: votionVaults, total_usd: votionUsd, total_implied_vp: votionVp };
    }

    // --- NFTs: aggregate records owned by this address -----------------------
    out._sources_present.nfts = !!sources.nfts;
    const nftAgg = aggregateNfts(addr, sources.nfts);
    if (nftAgg) out.nfts = nftAgg;

    // --- totals: combine across layers ---------------------------------------
    // adao-positions summary already has an authoritative per-member portfolio
    // value (LP + locked + wallet). Add Votion + NFT backing on top of it.
    const tlaPortfolioUsd = (out.tla ? (num(out.tla.summary_portfolio_usd) ?? (out.tla.lp_usd || 0)) : 0);
    const votionUsd = (out.votion ? (out.votion.total_usd || 0) : 0);
    const nftUsd = (out.nfts ? (out.nfts.backing_usd || 0) : 0);
    const pendingUsd = (out.tla && out.tla.pending ? (out.tla.pending.total_usd || 0) : 0);
    out.totals.portfolio_usd = tlaPortfolioUsd + votionUsd + nftUsd;
    out.totals.vp_total = (out.tla ? (out.tla.vp_direct || 0) : 0) + (out.votion ? (out.votion.total_implied_vp || 0) : 0);
    out.totals.pending_usd = pendingUsd;
    out.totals.breakdown = { tla_portfolio_usd: tlaPortfolioUsd, votion_usd: votionUsd, nft_backing_usd: nftUsd };

    // --- alerts: run the ruleset on the assembled portfolio ------------------
    // adapt the votion shape for the alerts module (it expects vaults[].lst)
    const pForAlerts = {
        identity: out.identity,
        nfts: out.nfts ? { pending_claim: out.nfts.daodao_pending_claim, count: out.nfts.count } : null,
        tla: out.tla ? {
            lp_positions: out.tla.lp_positions,
            locks: out.tla.locks,
            vp_gap_human: out.tla.vp_gap_human,
            pending: out.tla.pending,
        } : null,
        votion: out.votion ? { vaults: out.votion.vaults.map(v => ({ lst: v.lst_symbol || v.lst, underlying: v.underlying_lst, usd: v.underlying_usd })) } : null,
    };
    out.alerts = deriveAlerts(pForAlerts, { priceFlags: sources.priceFlags || {} });

    return out;
}

// --- source-specific extractors (match real shapes) ----------------------------

function findMember(addr, adaoPositions) {
    if (!adaoPositions) return null;
    const m = adaoPositions.members;
    const list = Array.isArray(m) ? m : (m && typeof m === 'object' ? Object.values(m) : []);
    return list.find(x => x && x.wallet === addr) || null;
}

function findAllyMember(addr, allies) {
    // allies current.json: { allies: [ { ally/name, members:[...] } ] } or similar
    const groups = allies.allies || allies.results || (Array.isArray(allies) ? allies : []);
    const list = Array.isArray(groups) ? groups : Object.values(groups || {});
    for (const g of list) {
        const members = g.members || g.all_members || [];
        const hit = (Array.isArray(members) ? members : Object.values(members)).find(x => x && x.wallet === addr);
        if (hit) return { member: hit, ally: g.ally || g.name || g.ally_name || null };
    }
    return null;
}

function collectVotionForAddress(addr, votion) {
    if (!votion || !Array.isArray(votion.vaults)) return [];
    const res = [];
    for (const vault of votion.vaults) {
        const holders = Array.isArray(vault.holders) ? vault.holders : [];
        const h = holders.find(x => x && x.address === addr);
        if (h) {
            res.push({
                vault: vault.address, label: vault.label, lst_symbol: vault.lst_symbol,
                vtoken_balance: num(h.vtoken_balance), underlying_lst: num(h.underlying_lst),
                underlying_usd: num(h.underlying_usd), underlying_usd_price_source: h.underlying_usd_price_source,
                share_of_vault_pct: num(h.share_of_vault_pct), implied_vp: num(h.implied_vp),
            });
        }
    }
    return res;
}

function aggregateNfts(addr, nftsDoc) {
    if (!nftsDoc || !Array.isArray(nftsDoc.records)) return null;
    let count = 0, broken = 0, unbroken = 0, daodaoStaked = 0, pendingClaim = 0, listed = 0;
    for (const r of nftsDoc.records) {
        // real_owner resolves staking contracts back to the true holder
        const owner = r.real_owner || r.owner;
        if (owner !== addr) continue;
        count++;
        if (r.broken) broken++; else unbroken++;
        if (r.daodao_staked) daodaoStaked++;
        if (r.listing || r.bbl_listed || r.atrium_listed || r.boost_listed) listed++;
        // pending-claim heuristic: unstaked from daodao but flagged pending (if field exists)
        if (r.daodao_pending_claim) pendingClaim++;
    }
    if (count === 0) return null;
    return {
        count, broken, unbroken, daodao_staked: daodaoStaked,
        daodao_pending_claim: pendingClaim, listed,
        // backing USD requires per-NFT ampLUNA backing × price — left null here;
        // the nft-inventory doc carries backing at the collection level. The UI can
        // multiply unbroken × per-NFT backing from the nfts doc summary if present.
        backing_usd: null,
    };
}

function lookupEntityLabel(addr, registry) {
    if (!registry) return null;
    // registry current.json may carry a directory + curated known_contracts/wallets
    const buckets = [registry.known_contracts, registry.contracts, registry.wallets,
                     registry.directory, registry.addresses];
    for (const b of buckets) {
        if (!b) continue;
        if (Array.isArray(b)) { const hit = b.find(x => x && (x.address === addr)); if (hit) return hit.name || hit.label || null; }
        else if (typeof b === 'object' && b[addr]) { return b[addr].name || b[addr].label || null; }
    }
    return null;
}

// --- helpers -------------------------------------------------------------------
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function asArray(v) { return Array.isArray(v) ? v : (v && typeof v === 'object' ? [v] : []); }
function sumBy(arr, fn) { return (arr || []).reduce((s, x) => { const v = fn(x); return s + (Number.isFinite(v) ? v : 0); }, 0); }

module.exports = { assemblePortfolio };
