/*
 * tla-decompose.js — shared TLA LP decomposition core (Rev 1.0.0)
 *
 * ONE implementation of the position→USD + APR math, imported by BOTH:
 *   • the dao-dashboard cron  (Node:   const D = require('../lib/tla-decompose.js'))
 *   • the live data lib       (browser: <script src="/lib/tla-decompose.js"> → window.tlaDecompose)
 *
 * Why this exists: the same decomposition was inlined separately in
 * dao-dashboard.js and adao-live-data.js, so the 2026-06-24 depth_usd
 * over-count had to be fixed in both. With one shared module the two paths
 * are the same math by construction and cannot drift. Both consumers stamp
 * D.VERSION into their output; a version mismatch = the copies diverged.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.tlaDecompose = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var SANE_APR_CAP = 300; // % — anything above is thin-pool garbage (e.g. USDC-SOLID 9.3M%)

  // Distinguish a FAILED query (null/undefined) from a legitimately EMPTY result ([]).
  // Never coerce null→[]; that silently turns a rate-limit failure into "no positions".
  function isFailedResult(r) { return r === null || r === undefined; }

  // Gated pool APR: approx_apr_pct only when it's a sane number in [0, CAP], else null.
  function aprOf(pool, cap) {
    if (cap == null) cap = SANE_APR_CAP;
    var a = (pool && pool.rewards) ? pool.rewards.approx_apr_pct : undefined;
    return (typeof a === 'number' && isFinite(a) && a >= 0 && a <= cap) ? a : null;
  }

  // Non-amplified LP position USD: user's share of the pool's staked value.
  function nonAmpPositionUsd(pool, shares, totalShares) {
    if (!(totalShares > 0) || !pool || !(pool.staked_in_tla_usd > 0)) return null;
    return pool.staked_in_tla_usd * (shares / totalShares);
  }

  // Amplified pool-pair position USD: user's LP share of the pool's TRUE reserve value.
  // Uses lp_health.total_pool_usd (asset_0+asset_1) — the SAME base decomposeTokens()
  // divides by — NOT depth_usd (runs 5-15% high, over-counts every amplified position).
  function ampPositionUsd(pool, userLp, totalShare) {
    if (!(totalShare > 0) || !pool) return null;
    var refUsd = (pool.lp_health && pool.lp_health.total_pool_usd) || pool.staked_in_tla_usd;
    if (!(refUsd > 0)) return null;
    return refUsd * (userLp / totalShare);
  }

  // Single-asset amplified pool (ampCAPA / xASTRO / ampROAR-ROAR): value held units at price.
  function singleAssetPositionUsd(pool, userLpHuman, tokenPrices) {
    if (!pool || !(userLpHuman > 0)) return null;
    var p = (tokenPrices && tokenPrices[pool.name]) ? tokenPrices[pool.name].final_price_usd : undefined;
    if (!(p > 0) && pool.lp_health && pool.lp_health.asset_0) p = pool.lp_health.asset_0.price_usd;
    return (p > 0) ? userLpHuman * p : null;
  }

  // Decompose a position's USD into underlying tokens, by fraction of the pool's
  // true reserve (total_pool_usd) — same base as ampPositionUsd.
  function decomposeTokens(pool, positionUsd) {
    var lh = pool && pool.lp_health;
    if (!lh || !(lh.total_pool_usd > 0) || !(positionUsd > 0)) return null;
    var frac = positionUsd / lh.total_pool_usd, out = [];
    ['asset_0', 'asset_1'].forEach(function (k) {
      var a = lh[k];
      if (a && a.symbol) out.push({
        symbol: a.symbol,
        amount: (parseFloat(a.amount_human) || 0) * frac,
        price: (typeof a.price_usd === 'number') ? a.price_usd : null,
        usd: (parseFloat(a.usd_value) || 0) * frac
      });
    });
    return out.length ? out : null;
  }

  // Deposit-weighted average APR across positions that carry one.
  function depositWeightedApr(positions) {
    var num = 0, den = 0;
    (positions || []).forEach(function (p) {
      if (p && typeof p.apr_pct === 'number' && p.position_usd > 0) {
        num += p.position_usd * p.apr_pct; den += p.position_usd;
      }
    });
    return den > 0 ? num / den : null;
  }

  return {
    VERSION: VERSION, SANE_APR_CAP: SANE_APR_CAP,
    isFailedResult: isFailedResult, aprOf: aprOf,
    nonAmpPositionUsd: nonAmpPositionUsd, ampPositionUsd: ampPositionUsd,
    singleAssetPositionUsd: singleAssetPositionUsd, decomposeTokens: decomposeTokens,
    depositWeightedApr: depositWeightedApr
  };
});
