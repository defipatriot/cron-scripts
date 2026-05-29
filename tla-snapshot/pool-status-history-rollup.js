#!/usr/bin/env node
/**
 * pool-status-history-rollup.js
 * ---------------------------------------------------------------------------
 * Per-epoch pool history for the TLA Stats Threshold Watch AND Exit-Risk panel.
 *
 * WHY
 *   Both features need per-epoch history the live snapshot can't give:
 *     - Threshold Watch: VP/active-status trend + 4-epoch drop reconstruction.
 *     - Exit Risk:       depth_usd / staked_in_tla_usd outflow + reserve drift
 *                        (base-asset draining, token price collapse).
 *   That history is spread across the tla-snapshot DAILY archives. This rolls it
 *   into ONE compact file consumed like apr-history.json (one fetch, ready to diff).
 *
 * UNIQUE KEY  (critical — fixes name-collision corruption)
 *   A pool is uniquely identified by `pool_address|bucket`, NOT name:
 *     - USDC-USDT / USDC-USDt list the SAME address under two buckets.
 *     - LUNA-WBTC / LUNA-arbLUNA have TWO addresses in the same bucket (old/new).
 *   Keying by name|dex scrambles all four series. We key by
 *   `pool_address|bucket` (fallback gauge_pool_id|bucket, then name|bucket when
 *   address is missing), and emit name/dex/bucket/pool_address per pool so the
 *   page can match by pool_address (exit-risk) or name+bucket (threshold watch).
 *
 * REPRESENTATIVE SNAPSHOT PER EPOCH
 *   Latest daily capture per epoch = canonical end-of-epoch state. bucketPct is
 *   computed from that file's own bucket VP totals (self-consistent).
 *
 * OUTPUT -> data/pool-status-history.json
 *   pools[].epochs[E] = {
 *     vp_human, bucket_pct, status, active,            // threshold watch
 *     depth_usd, staked_usd,                           // exit risk: outflow
 *     a0_sym, a0_amt, a0_px, a1_sym, a1_amt, a1_px,    // exit risk: reserve drift
 *     capturedAt
 *   }
 *
 * RUN:  node pool-status-history-rollup.js [--daily <dir>] [--out <file>]
 *   Defaults ./data/daily -> ./data/pool-status-history.json. Idempotent. Daily.
 */
const fs = require('fs');
const path = require('path');

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { daily: './data/daily', out: './data/pool-status-history.json' };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--daily') o.daily = a[++i];
    else if (a[i] === '--out') o.out = a[++i];
  }
  return o;
}
const epochOf = (doc) => (doc?.epoch && typeof doc.epoch === 'object') ? Number(doc.epoch.currentEpoch) : Number(doc?.epoch);
const keyOf = (p) => `${p.pool_address || p.gauge_pool_id || p.name}|${p.bucket}`;
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

function main() {
  const { daily, out } = parseArgs();
  if (!fs.existsSync(daily)) { console.error(`[pool-status] daily dir not found: ${daily}`); process.exit(1); }
  const files = fs.readdirSync(daily).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!files.length) { console.error(`[pool-status] no daily files in ${daily}`); process.exit(1); }

  // Latest-captured daily file per epoch (representative end-of-epoch state).
  const repByEpoch = new Map();
  for (const f of files) {
    let doc; try { doc = JSON.parse(fs.readFileSync(path.join(daily, f), 'utf8')); }
    catch (e) { console.warn(`[pool-status] skip ${f}: ${e.message}`); continue; }
    const ep = epochOf(doc);
    if (!Number.isFinite(ep)) { console.warn(`[pool-status] skip ${f}: no epoch`); continue; }
    const cap = doc.capturedAt || doc.generatedAt || '';
    const cur = repByEpoch.get(ep);
    if (!cur || String(cap) > String(cur.capturedAt)) repByEpoch.set(ep, { capturedAt: cap, doc });
  }

  const acc = new Map();
  for (const [ep, { capturedAt, doc }] of repByEpoch.entries()) {
    const pools = Array.isArray(doc.pools) ? doc.pools : [];
    const bt = {};
    for (const p of pools) { const b = p.bucket; if (b) bt[b] = (bt[b] || 0) + num(p?.voting_power?.vp_human); }
    for (const p of pools) {
      const name = p?.name, dex = p?.dex, bucket = p?.bucket;
      if (!name || !bucket) continue;
      const key = keyOf(p);
      const vp = num(p?.voting_power?.vp_human);
      const lh = p?.lp_health || {}; const a0 = lh.asset_0 || {}; const a1 = lh.asset_1 || {};
      if (!acc.has(key)) acc.set(key, { name, dex, bucket, pool_address: p.pool_address || null, epochs: {} });
      const rec = acc.get(key);
      rec.name = name; rec.dex = dex; rec.bucket = bucket;  // keep latest labels
      rec.epochs[String(ep)] = {
        vp_human: vp,
        bucket_pct: bt[bucket] ? (vp / bt[bucket]) * 100 : 0,
        status: p?.status || 'unknown',
        active: p?.status === 'active',
        depth_usd: num(p?.depth_usd),
        staked_usd: num(p?.staked_in_tla_usd),
        a0_sym: a0.symbol ?? null, a0_amt: num(a0.amount_human), a0_px: num(a0.price_usd),
        a1_sym: a1.symbol ?? null, a1_amt: num(a1.amount_human), a1_px: num(a1.price_usd),
        capturedAt,
      };
    }
  }

  const poolsOut = [...acc.values()].sort((a, b) => a.name.localeCompare(b.name));
  const output = {
    schemaVersion: 2,
    cron: 'pool-status-history',
    generatedAt: new Date().toISOString(),
    sourceDailyFiles: files.length,
    epochs: [...repByEpoch.keys()].sort((a, b) => a - b),
    pools: poolsOut,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(output, null, 2));
  console.log(`[pool-status] wrote ${out}: ${poolsOut.length} pools across epochs ${output.epochs.join(', ')} from ${files.length} daily files (schema v2: +depth/staked/reserves)`);
}
main();
