#!/usr/bin/env node
/**
 * pool-status-history-rollup.js
 * ---------------------------------------------------------------------------
 * Per-epoch pool VP + active-status history for the TLA Stats Threshold Watch.
 *
 * WHY THIS EXISTS
 *   The Threshold Watch needs to answer two questions the live snapshot can't:
 *     1. "Which active pools are TRENDING toward the 1% threshold?" (about to drop)
 *     2. "Which pools dropped in each of the last 4 epochs?"
 *   Both need per-epoch history of each pool's VP, bucket, and active status.
 *   That history is spread across the tla-snapshot DAILY archives
 *   (data/daily/{YYYY-MM-DD}.json) — this script rolls it into ONE compact file
 *   so the dashboard reads it like apr-history.json: one fetch, ready to diff.
 *
 * REPRESENTATIVE SNAPSHOT PER EPOCH
 *   For each epoch we keep the LATEST daily capture (closest to epoch end) as the
 *   canonical end-of-epoch state — that's the vote picture that decided activation.
 *   bucketPct is computed from that file's own bucket VP totals (self-consistent),
 *   never mixed across files.
 *
 * ACTIVE STATUS
 *   We record the snapshot's own `status` field verbatim ('active',
 *   'voted_but_below_threshold', 'zero_vp') AND a derived boolean `active`
 *   (status === 'active'). The dashboard decides drops by comparing `active`
 *   across consecutive epochs (active -> not active = a drop).
 *
 * OUTPUT  ->  data/pool-status-history.json
 *   {
 *     schemaVersion: 1, cron: "pool-status-history", generatedAt: ISO,
 *     sourceDailyFiles: <int>, epochs: [185,186,187],
 *     pools: [
 *       { name, dex, bucket,
 *         epochs: { "186": { vp_human, bucket_pct, status, active, capturedAt } } }
 *     ]
 *   }
 *
 * RUN / SCHEDULE
 *   node pool-status-history-rollup.js [--daily <dir>] [--out <file>]
 *   Defaults: --daily ./data/daily  --out ./data/pool-status-history.json
 *   Idempotent. Run alongside apr-history (same daily archives). Daily cadence.
 */

const fs = require('fs');
const path = require('path');

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { daily: './data/daily', out: './data/pool-status-history.json' };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--daily') out.daily = a[++i];
    else if (a[i] === '--out') out.out = a[++i];
  }
  return out;
}

function epochOf(doc) {
  const e = doc?.epoch;
  if (e && typeof e === 'object') return Number(e.currentEpoch);
  return Number(e);
}

function main() {
  const { daily, out } = parseArgs();
  if (!fs.existsSync(daily)) { console.error(`[pool-status] daily dir not found: ${daily}`); process.exit(1); }

  const files = fs.readdirSync(daily)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (files.length === 0) { console.error(`[pool-status] no daily files in ${daily}`); process.exit(1); }

  // Pick the latest-captured daily file per epoch (representative end-of-epoch state).
  const repByEpoch = new Map(); // epoch -> { capturedAt, doc }
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(daily, f), 'utf8')); }
    catch (e) { console.warn(`[pool-status] skip unreadable ${f}: ${e.message}`); continue; }
    const ep = epochOf(doc);
    if (!Number.isFinite(ep)) { console.warn(`[pool-status] skip ${f}: no epoch`); continue; }
    const cap = doc.capturedAt || doc.generatedAt || '';
    const cur = repByEpoch.get(ep);
    if (!cur || String(cap) > String(cur.capturedAt)) repByEpoch.set(ep, { capturedAt: cap, doc });
  }

  // Accumulate per-pool per-epoch records.
  const acc = new Map(); // "name|dex" -> { name, dex, bucket, epochs: {} }
  for (const [ep, { capturedAt, doc }] of repByEpoch.entries()) {
    const pools = Array.isArray(doc.pools) ? doc.pools : [];
    // bucket VP totals for this file (self-consistent bucketPct)
    const bt = {};
    for (const p of pools) {
      const b = p.bucket; const vp = Number(p?.voting_power?.vp_human) || 0;
      if (b) bt[b] = (bt[b] || 0) + vp;
    }
    for (const p of pools) {
      const name = p?.name, dex = p?.dex, bucket = p?.bucket;
      if (!name || !dex) continue;
      const vp = Number(p?.voting_power?.vp_human) || 0;
      const pct = bt[bucket] ? (vp / bt[bucket]) * 100 : 0;
      const status = p?.status || 'unknown';
      const key = `${name}|${dex}`;
      if (!acc.has(key)) acc.set(key, { name, dex, bucket, epochs: {} });
      const rec = acc.get(key);
      if (bucket) rec.bucket = bucket;
      rec.epochs[String(ep)] = {
        vp_human: vp,
        bucket_pct: pct,
        status,
        active: status === 'active',
        capturedAt,
      };
    }
  }

  const poolsOut = [...acc.values()].sort((a, b) => a.name.localeCompare(b.name));
  const output = {
    schemaVersion: 1,
    cron: 'pool-status-history',
    generatedAt: new Date().toISOString(),
    sourceDailyFiles: files.length,
    epochs: [...repByEpoch.keys()].sort((a, b) => a - b),
    pools: poolsOut,
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(output, null, 2));
  console.log(`[pool-status] wrote ${out}: ${poolsOut.length} pools across epochs ${output.epochs.join(', ')} from ${files.length} daily files`);
}

main();
