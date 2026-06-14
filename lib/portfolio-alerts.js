// =============================================================================
// Portfolio Alerts Ruleset — the "what should I do" brain of the companion
// =============================================================================
//
// Pure logic. Takes a unified portfolio object (NFT + TLA + Votion spliced by
// address) and returns an array of alerts: { type, severity, title, message,
// action }. Works from CURRENT state only — zero accumulation needed, so it
// delivers value on day one. This is the differentiator: no other Terra tool
// tells a user what to DO about their position.
//
// Used by both the page (client-side, immediate) and a future alerts cron
// (server-side detection → PWA push notifications).
//
// SEVERITY: 'critical' (losing money/VP now) · 'warning' (action recommended)
//           · 'info' (FYI / opportunity).
//
// Each rule is independent and defensive: missing data → skip that rule, never
// throw. Honest over alarmist — only fire when we're confident from the data.
// =============================================================================

'use strict';

// Tunable thresholds (could move to config later).
const THRESHOLDS = {
    unlockSoonWeeks: 4,          // lock unlocking within N weeks → warn
    staleVpMinHuman: 100,        // ignore trivial stale-VP dust below this
    pendingRewardsMinUsd: 5,     // ignore trivial unclaimed dust
    inactiveLpMinUsd: 10,        // ignore dust LP positions
    priceDivergencePct: 5,       // asset price feed divergence → trust warning
};

/**
 * @param {object} p unified portfolio: { identity, nfts, tla, votion, totals }
 * @param {object} [ctx] optional: { knownAddresses, priceFlags } for cross-refs
 * @returns {Array<{type,severity,title,message,action}>}
 */
function deriveAlerts(p, ctx = {}) {
    const alerts = [];
    if (!p || typeof p !== 'object') return alerts;

    // --- 1. Inactive LP (losing emissions + take-rate exposure) -----------
    // adao-positions tags LP positions with status:'inactive' + take exposure.
    const lps = (p.tla && Array.isArray(p.tla.lp_positions)) ? p.tla.lp_positions : [];
    for (const lp of lps) {
        const usd = num(lp.usd ?? lp.value_usd);
        if (lp.status === 'inactive' && usd != null && usd >= THRESHOLDS.inactiveLpMinUsd) {
            alerts.push({
                type: 'inactive_lp',
                severity: 'warning',
                title: 'LP position is inactive',
                message: `Your ${lp.pool || lp.name || 'LP'} position (~$${fmt(usd)}) is below the VP threshold, so it's earning no emissions and is exposed to the 10% take.`,
                action: 'Vote for this pool or move liquidity to an active pool.',
            });
        }
    }

    // --- 2. Stale VP (relock to reclaim) ----------------------------------
    // VP that has decayed and can be reclaimed by relocking (max-lock).
    const vpGap = num(p.tla && (p.tla.vp_gap_human ?? p.tla.stale_vp_human));
    if (vpGap != null && vpGap >= THRESHOLDS.staleVpMinHuman) {
        alerts.push({
            type: 'stale_vp',
            severity: 'warning',
            title: 'You have reclaimable voting power',
            message: `~${fmt(vpGap)} VP has decayed and isn't working for you. Relocking (max-lock) restores it.`,
            action: 'Relock or enable auto-max-lock to reclaim this VP.',
        });
    }

    // --- 3. Lock unlocking soon -------------------------------------------
    const locks = (p.tla && Array.isArray(p.tla.locks)) ? p.tla.locks : [];
    for (const lk of locks) {
        const wks = num(lk.weeks_to_unlock);
        const isPerm = lk.is_auto_max_locked || lk.lock_is_permanent || lk.end === 'permanent';
        if (!isPerm && wks != null && wks >= 0 && wks <= THRESHOLDS.unlockSoonWeeks) {
            alerts.push({
                type: 'unlock_soon',
                severity: wks <= 1 ? 'critical' : 'warning',
                title: 'A lock is unlocking soon',
                message: `Lock ${lk.lock_id != null ? '#' + lk.lock_id : ''} (${fmt(num(lk.amount))} ${lk.asset || ''}) unlocks in ~${wks} week${wks === 1 ? '' : 's'}. Its VP is decaying toward zero.`,
                action: 'Relock to keep your voting power, or plan to withdraw.',
            });
        }
    }

    // --- 4. Unclaimed rewards / bribes / rebase piling up -----------------
    const pend = p.tla && p.tla.pending;
    if (pend) {
        const totalPend = num(pend.total_usd ?? pend.usd ?? sumPending(pend));
        if (totalPend != null && totalPend >= THRESHOLDS.pendingRewardsMinUsd) {
            alerts.push({
                type: 'unclaimed_rewards',
                severity: 'info',
                title: 'You have unclaimed rewards',
                message: `~$${fmt(totalPend)} in rewards/bribes/rebase is waiting to be claimed.`,
                action: 'Claim your rewards on the Eris hub.',
            });
        }
    }

    // --- 5. NFT ready to claim (DAODAO pending-claim) ---------------------
    const nfts = p.nfts;
    if (nfts) {
        const readyToClaim = num(nfts.pending_claim ?? nfts.ready_to_claim);
        if (readyToClaim != null && readyToClaim > 0) {
            alerts.push({
                type: 'nft_ready_to_claim',
                severity: 'warning',
                title: 'You have NFTs ready to claim',
                message: `${readyToClaim} NFT${readyToClaim === 1 ? '' : 's'} unstaked from DAODAO and ${readyToClaim === 1 ? 'is' : 'are'} waiting to be claimed (or may be forgotten).`,
                action: 'Claim your unstaked NFTs so they\'re back in your wallet.',
            });
        }
    }

    // --- 6. Price-feed divergence on a held asset (trust warning) ---------
    // If an asset the user holds has a flagged price divergence, warn that the
    // USD figures for it may be off — honesty over confident-but-wrong.
    const priceFlags = ctx.priceFlags || {};
    const heldSymbols = collectHeldSymbols(p);
    for (const sym of heldSymbols) {
        const flag = priceFlags[sym];
        if (flag && flag.flagged) {
            alerts.push({
                type: 'price_divergence',
                severity: 'info',
                title: `${sym} price may be uncertain`,
                message: `Our price feed for ${sym} differs ~${fmt(Math.abs(num(flag.divergence_pct) || 0))}% from the open market, so its USD value here is approximate.`,
                action: 'Treat the USD figure for this asset as a range, not exact.',
            });
        }
    }

    // Sort: critical → warning → info; stable within.
    const rank = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
    return alerts;
}

// --- helpers (all defensive) ---------------------------------------------
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function fmt(n) { return n == null ? '?' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
function sumPending(pend) {
    let s = 0, any = false;
    for (const k of ['rewards_usd', 'bribes_usd', 'rebase_usd']) {
        const v = num(pend[k]); if (v != null) { s += v; any = true; }
    }
    return any ? s : null;
}
function collectHeldSymbols(p) {
    const set = new Set();
    const locks = (p.tla && p.tla.locks) || [];
    for (const lk of locks) if (lk.asset) set.add(lk.asset);
    const vaults = (p.votion && p.votion.vaults) || [];
    for (const vt of vaults) if (vt.lst || vt.lst_symbol) set.add(vt.lst || vt.lst_symbol);
    return [...set];
}

module.exports = { deriveAlerts, THRESHOLDS };
