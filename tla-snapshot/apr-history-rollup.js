#!/usr/bin/env node
/**
 * apr-history-rollup.js
 * ---------------------------------------------------------------------------
 * Per-epoch APR rollup for the TLA Stats dashboard.
 *
 * WHY THIS EXISTS
 *   Volume & liquidity get clean per-epoch history "for free" because the
 *   Astroport cron writes an epochs{} map in one file. APR has no such file —
 *   its inputs live scattered across the tla-snapshot DAILY archives
 *   (data/daily/{YYYY-MM-DD}.json). This script rolls those daily archives up
 *   into ONE compact per-epoch file so the dashboard can treat APR exactly like
 *   it treats volume/liquidity: one small fetch, a baseline epoch to diff
 *   against, and a rank-movement badge.
 *
 * WHAT IT READS
 *   Every data/daily/*.json file in the tla-snapshot data repo. Each daily file
 *   already self-reports its epoch via `epoch.currentEpoch`, so grouping is done
 *   off that tag (robust to capture-time-vs-epoch-boundary timing). Per pool it
 *   reads: name, dex, bucket, rewards.approx_apr_pct, staked_in_tla_usd.
 *
 * WHAT IT WRITES  ->  data/apr-history.json
 *   {
 *     schemaVersion: 1,
 *     cron: "apr-history",
 *     generatedAt: ISO,
 *     sourceDailyFiles: <int>,
 *     epochs: [185, 186, 187],
 *     pools: [
 *       { name, dex, bucket,
 *         epochs: { "186": { apr_pct_avg, staked_usd_avg, days } } }
 *     ]
 *   }
 *   NOTE: we store the RAW non-amplified approx_apr_pct plus avg staked. The
 *   dashboard applies the SAME amp-factor + $20K filter + 200% cap it uses for
 *   the live number, so historical and current APR are transformed identically
 *   (single source of truth for the business logic stays in the page).
 *
 * HOW TO RUN / SCHEDULE
 *   node apr-history-rollup.js [--daily <dir>] [--out <file>]
 *   Defaults: --daily ./data/daily  --out ./data/apr-history.json
 *   Idempotent: safe to re-run; recomputes from whatever daily files exist.
 *   Recommended cadence: run right after the tla-snapshot DAILY archive step
 *   (once per day is plenty — APR only changes meaningfully at epoch rollover).
 *   Adopt this repo's existing heartbeat/commit conventions to match siblings.
 *
 * SCALE NOTE
 *   Reads ALL daily files each run. At ~1 file/day this is fine for years. If
 *   the daily archive ever grows large, bound the read to the most recent
 *   ~2 epochs of files and merge into the existing apr-history.json (older
 *   completed epochs are frozen once computed).
 */

const fs = require('fs');
const path = require('path');

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { daily: './data/daily', out: './data/apr-history.json' };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--daily') out.daily = a[++i];
    else if (a[i] === '--out') out.out = a[++i];
  }
  return out;
}

function main() {
  const { daily, out } = parseArgs();

  if (!fs.existsSync(daily)) {
    console.error(`[apr-history] daily dir not found: ${daily}`);
    process.exit(1);
  }

  const files = fs.readdirSync(daily)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();

  if (files.length === 0) {
    console.error(`[apr-history] no daily files in ${daily}`);
    process.exit(1);
  }

  // accumulator: key "name|dex" -> { name, dex, bucket, epochs: { ep -> {aprSum, stakedSum, days} } }
  const acc = new Map();
  const epochSet = new Set();

  for (const f of files) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(daily, f), 'utf8'));
    } catch (e) {
      console.warn(`[apr-history] skip unreadable ${f}: ${e.message}`);
      continue;
    }
    const ep = doc?.epoch?.currentEpoch;
    if (!Number.isFinite(ep)) {
      console.warn(`[apr-history] skip ${f}: no epoch.currentEpoch`);
      continue;
    }
    epochSet.add(ep);
    const pools = Array.isArray(doc.pools) ? doc.pools : [];
    for (const p of pools) {
      const name = p?.name;
      const dex = p?.dex;
      if (!name || !dex) continue;
      const apr = Number(p?.rewards?.approx_apr_pct);
      if (!Number.isFinite(apr)) continue;             // only days with a real APR
      const staked = Number(p?.staked_in_tla_usd) || 0;

      const key = `${name}|${dex}`;
      if (!acc.has(key)) acc.set(key, { name, dex, bucket: p.bucket || null, epochs: {} });
      const rec = acc.get(key);
      if (p.bucket) rec.bucket = p.bucket;             // keep latest bucket label
      if (!rec.epochs[ep]) rec.epochs[ep] = { aprSum: 0, stakedSum: 0, days: 0 };
      const e = rec.epochs[ep];
      e.aprSum += apr;
      e.stakedSum += staked;
      e.days += 1;
    }
  }

  // finalize -> averages
  const poolsOut = [];
  for (const rec of acc.values()) {
    const epochs = {};
    for (const [ep, e] of Object.entries(rec.epochs)) {
      epochs[ep] = {
        apr_pct_avg: e.days ? e.aprSum / e.days : 0,
        staked_usd_avg: e.days ? e.stakedSum / e.days : 0,
        days: e.days,
      };
    }
    poolsOut.push({ name: rec.name, dex: rec.dex, bucket: rec.bucket, epochs });
  }
  poolsOut.sort((a, b) => a.name.localeCompare(b.name));

  const output = {
    schemaVersion: 1,
    cron: 'apr-history',
    generatedAt: new Date().toISOString(),
    sourceDailyFiles: files.length,
    epochs: [...epochSet].sort((a, b) => a - b),
    pools: poolsOut,
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(output, null, 2));
  console.log(`[apr-history] wrote ${out}: ${poolsOut.length} pools across epochs ${output.epochs.join(', ')} from ${files.length} daily files`);
}

main();
