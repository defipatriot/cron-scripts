// =============================================================================
// lib/tier-builder.js — shared tier-rollup helper (Rev 1.0.0)
// =============================================================================
// Boundary-based rolling tiers + epoch bucketing + epoch-end freeze. PURE logic
// (no IO). A metric cron calls addReading() each run; a thin IO wrapper persists
// the returned history into tla-core/<module>/...
//
// TIERS (per Camron's ladder):
//   raw      the :00/:15/:30/:45 readings (kept, capped)
//   hourly   avg of the raw points in each clock hour      (finalized on hour change)
//   daily    avg of the hourly points in each day          (finalized on day change)
//   monthly  avg of the daily points in each calendar month
//   yearly   avg of the monthly points in each year
//   epochly  avg of the raw points in each EPOCH            (finalized on epoch change)
//   epoch_end[N]  the FINAL reading of epoch N, frozen once the epoch closes
//
// Calendar tiers use clock/calendar boundaries (robust to missed runs); the weekly
// tier is epoch-bucketed because TLA/Votion epochs don't land on clock marks.
// =============================================================================
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.TierBuilder = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var VERSION = '1.0.0';
  var RAW_CAP = 200;
  var CHAIN = [['hourly','hour'], ['daily','day'], ['monthly','month'], ['yearly','year']];

  function avgRecords(recs) {
    var keys = {}, out = {};
    recs.forEach(function (r) { Object.keys(r).forEach(function (k) { keys[k] = 1; }); });
    Object.keys(keys).forEach(function (k) {
      var vals = [];
      recs.forEach(function (r) { if (typeof r[k] === 'number' && isFinite(r[k])) vals.push(r[k]); });
      if (vals.length) out[k] = vals.reduce(function (s, x) { return s + x; }, 0) / vals.length;
    });
    return out;
  }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function keysOf(ts) {
    var d = new Date(ts);
    var Y = d.getUTCFullYear(), M = p2(d.getUTCMonth() + 1), D = p2(d.getUTCDate()), H = p2(d.getUTCHours());
    return { hour: Y+'-'+M+'-'+D+'T'+H, day: Y+'-'+M+'-'+D, month: Y+'-'+M, year: '' + Y };
  }
  function ensure(h) {
    h = h || {};
    h.raw = h.raw || [];
    ['hourly','daily','monthly','yearly','epochly'].forEach(function (t) { h[t] = h[t] || []; });
    h.epoch_end = h.epoch_end || {};
    h._acc = h._acc || {};
    return h;
  }

  // Accumulate `value` (a record) into a tier's open bucket. If the bucket key
  // changed, finalize the previous bucket (avg) -> push a point -> return it so
  // the caller can cascade it upward. epochNum tags epoch-tier points.
  function feedTier(h, tier, key, ts, value, epochNum) {
    var acc = h._acc[tier], finalized = null;
    if (acc && acc.key !== key && acc.recs.length) {
      var pt = { t: acc.t, v: avgRecords(acc.recs), n: acc.recs.length };
      if (acc.epoch !== undefined) pt.epoch = acc.epoch;
      h[tier].push(pt);
      finalized = pt;
      acc = null;
    }
    if (!acc || acc.key !== key) { acc = { key: key, t: ts, recs: [] }; if (epochNum !== undefined) acc.epoch = epochNum; }
    acc.recs.push(value);
    h._acc[tier] = acc;
    return finalized;
  }

  function addReading(h, opts) {
    h = ensure(h);
    var ts = typeof opts.t === 'number' ? opts.t : Date.parse(opts.t);
    var epoch = opts.epoch, record = opts.record;

    h.raw.push({ t: ts, epoch: epoch, v: record });
    if (h.raw.length > RAW_CAP) h.raw = h.raw.slice(-RAW_CAP);

    // calendar cascade: raw -> hourly -> daily -> monthly -> yearly
    var carryV = record, carryT = ts;
    for (var i = 0; i < CHAIN.length; i++) {
      var tier = CHAIN[i][0], keyName = CHAIN[i][1];
      var key = keysOf(carryT)[keyName];
      var fin = feedTier(h, tier, key, carryT, carryV);
      if (!fin) break;                 // bucket still open -> nothing to cascade up
      carryV = fin.v; carryT = fin.t;  // finalized point feeds the next tier
    }

    // epoch tier (parallel, keyed by epoch number) + running epoch-end freeze
    if (epoch !== undefined && epoch !== null) {
      feedTier(h, 'epochly', 'E' + epoch, ts, record, epoch);
      h.epoch_end[String(epoch)] = { t: ts, v: record }; // overwritten until epoch closes -> then frozen
    }
    return h;
  }

  function current(h) { return (h && h.raw && h.raw.length) ? h.raw[h.raw.length - 1].v : null; }

  return { VERSION: VERSION, addReading: addReading, current: current, avgRecords: avgRecords };
});
