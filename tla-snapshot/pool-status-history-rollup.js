#!/usr/bin/env node
/**
 * pool-status-history-rollup.js  —  schema v3
 * ============================================================================
 * Per-epoch pool history for the TLA Stats Threshold Watch and Exit-Risk panels.
 *
 * WHAT CHANGED (v2 → v3, 2026-05-30)
 * ----------------------------------------------------------------------------
 * Driven by CRON-FIXES-BRIEF items 1.1 (gauge_pool_id keying), 1.3 (depth vs
 * staked invariant), 2.6 (carry dex_subtype), 2.7 (migration corpses).
 *
 *   v2 key: `pool_address|bucket` (fallback gauge_pool_id|bucket, then name|bucket)
 *   v3 key: `gauge_pool_id|bucket` (fallback pool_address|bucket, then name|dex|bucket)
 *
 * Why the swap? gauge_pool_id is the canonical Eris gauge identifier and is
 * preserved verbatim across DAO frontends; pool_address can vary across
 * migrations. Aligning the rollup key with `gauge_pool_id` matches how
 * `bribes-history.js`, `votion-data`, and the Eris UI refer to gauges.
 *
 * Per-pool fields preserved per epoch (NEW vs v2 marked with *):
 *   - vp_human, bucket_pct, status, active
 *   - depth_usd, staked_usd
 *   - asset_0/1 symbol, amount, price, *price_source*
 *   - *dex_subtype* — required to interpret value-split correctness
 *   - *capturedAt*
 *
 * INVARIANTS (recorded per epoch in `_invariants` block)
 * ----------------------------------------------------------------------------
 *   1. one_active_per_name_dex_bucket — at most 1 active row per (n,d,b)
 *   2. staked_lte_depth — staked_in_tla_usd > depth_usd violates physics
 *   3. value_split_50_50_xyk — xyk/stable pools should be ~45-55% per side;
 *      concentrated/single pools are EXEMPT (uneven by design)
 *   4. migration_corpse_candidates — name+dex+bucket where lower-VP variants
 *      sit alongside a dominant active variant; the page can hide these
 *
 * Each violation is recorded with enough context to debug without re-fetching.
 *
 * DEPLOY ON RENDER  (same env as the tla-snapshot cron)
 *   GITHUB_TOKEN, GITHUB_REPO (default defipatriot/tla-snapshot-data_2026),
 *   GITHUB_BRANCH (default main). Run after the daily archive lands.
 *   Command:  node pool-status-history-rollup.js
 *
 * LOCAL / TEST MODE
 *   node pool-status-history-rollup.js --daily ./local/daily --out ./pool-status-history.json
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/tla-snapshot-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const OUT_PATH      = 'data/pool-status-history.json';

// Tolerance bands for invariant checks.
const VALUE_SPLIT_MIN_PCT = 45;  // xyk/stable pool side must be >= 45%
const VALUE_SPLIT_MAX_PCT = 55;  // and <= 55%
const STAKED_VS_DEPTH_TOLERANCE = 1.05; // allow 5% over depth before flagging

function parseArgs() {
  const a = process.argv.slice(2); const o = { daily: null, out: null };
  for (let i = 0; i < a.length; i++) { if (a[i] === '--daily') o.daily = a[++i]; else if (a[i] === '--out') o.out = a[++i]; }
  return o;
}
const epochOf = (doc) => (doc?.epoch && typeof doc.epoch === 'object') ? Number(doc.epoch.currentEpoch) : Number(doc?.epoch);
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

// Canonical key: gauge_pool_id|bucket (the only truly unique pair).
function canonicalKey(p) {
  if (p.gauge_pool_id && p.bucket) return `${p.gauge_pool_id}|${p.bucket}`;
  if (p.pool_address  && p.bucket) return `addr:${p.pool_address}|${p.bucket}`;
  return `name:${p.name}|${p.dex}|${p.bucket || '?'}`;
}

// ---- GitHub helpers ----
function githubApiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.github.com', path: apiPath, method,
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'aDAO-pool-status/3.0',
        'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d || '{}') }); } catch { resolve({ status: res.statusCode, data: {} }); } }); });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
async function pushToGithub(filepath, content, message) {
  const apiPath = `/repos/${GITHUB_REPO}/contents/${filepath}`;
  const existing = await githubApiRequest('GET', apiPath);
  const sha = existing.data?.sha;
  const body = { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH, ...(sha ? { sha } : {}) };
  const result = await githubApiRequest('PUT', apiPath, body);
  if (result.status === 200 || result.status === 201) { console.log(`  ✅ ${filepath}`); return true; }
  console.error(`  ❌ Push failed (HTTP ${result.status}): ${result.data?.message || '<no message>'}`); return false;
}
function fetchJsonUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'aDAO-pool-status/3.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
async function listDailyDocsFromGithub() {
  const res = await githubApiRequest('GET', `/repos/${GITHUB_REPO}/contents/data/daily?ref=${GITHUB_BRANCH}`);
  if (!Array.isArray(res.data)) throw new Error(`list data/daily failed: ${res.data?.message || res.status}`);
  const files = res.data.filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  console.log(`  found ${files.length} daily archives on GitHub`);
  const out = [];
  for (const f of files) { try { out.push({ name: f.name, doc: await fetchJsonUrl(f.download_url) }); } catch (e) { console.warn(`  skip ${f.name}: ${e.message}`); } }
  return out;
}
function loadDailyDocsLocal(dir) {
  const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.map(f => { try { return { name: f, doc: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }; } catch { return null; } }).filter(Boolean);
}

// ---- Invariant checks ----
function snapshotInvariants(doc) {
  const pools = Array.isArray(doc.pools) ? doc.pools : [];
  const violations = [];

  // 1. one_active_per_name_dex_bucket
  const activeByNDB = {};
  for (const p of pools) {
    if (p.status !== 'active') continue;
    const k = `${p.name}|${p.dex}|${p.bucket}`;
    activeByNDB[k] = (activeByNDB[k] || 0) + 1;
  }
  for (const [k, n] of Object.entries(activeByNDB)) {
    if (n > 1) violations.push({ kind: 'multiple_active_per_name_dex_bucket', key: k, count: n });
  }

  // 2. staked_lte_depth (with small tolerance)
  for (const p of pools) {
    const depth = num(p?.depth_usd);
    const staked = num(p?.staked_in_tla_usd);
    if (depth > 0 && staked > 0 && staked > depth * STAKED_VS_DEPTH_TOLERANCE) {
      violations.push({
        kind: 'staked_exceeds_depth',
        name_dex_bucket: `${p.name}|${p.dex}|${p.bucket}`,
        gauge_pool_id: p.gauge_pool_id || null,
        depth_usd: depth, staked_usd: staked,
        ratio: staked / depth,
      });
    }
  }

  // 3. value_split for xyk/stable pools only (concentrated/single exempt)
  for (const p of pools) {
    const subtype = p.dex_subtype;
    if (!subtype || subtype === 'concentrated' || subtype === 'single') continue;
    const lh = p.lp_health;
    if (!lh) continue;
    const a0 = num(lh?.asset_0?.usd_value);
    const a1 = num(lh?.asset_1?.usd_value);
    const total = a0 + a1;
    if (total <= 0) continue;
    const p0 = (a0 / total) * 100;
    if (p0 < VALUE_SPLIT_MIN_PCT || p0 > VALUE_SPLIT_MAX_PCT) {
      violations.push({
        kind: 'value_split_off_for_xyk_or_stable',
        name_dex_bucket: `${p.name}|${p.dex}|${p.bucket}`,
        gauge_pool_id: p.gauge_pool_id || null,
        subtype,
        split_pct: [p0, 100 - p0],
        symbols: [lh?.asset_0?.symbol, lh?.asset_1?.symbol],
      });
    }
  }

  // 4. migration_corpse_candidates
  const ndbGroups = {};
  for (const p of pools) {
    const k = `${p.name}|${p.dex}|${p.bucket}`;
    (ndbGroups[k] = ndbGroups[k] || []).push(p);
  }
  for (const [k, group] of Object.entries(ndbGroups)) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) =>
      num(b?.voting_power?.vp_human) - num(a?.voting_power?.vp_human));
    const dominant = sorted[0];
    const dominantVp = num(dominant?.voting_power?.vp_human);
    for (let i = 1; i < sorted.length; i++) {
      const corpse = sorted[i];
      const corpseVp = num(corpse?.voting_power?.vp_human);
      if (dominantVp > 0 && corpseVp / dominantVp < 0.05) {
        violations.push({
          kind: 'migration_corpse_candidate',
          name_dex_bucket: k,
          dominant_gauge: dominant.gauge_pool_id || dominant.pool_address,
          dominant_subtype: dominant.dex_subtype,
          dominant_vp: dominantVp,
          corpse_gauge: corpse.gauge_pool_id || corpse.pool_address,
          corpse_subtype: corpse.dex_subtype,
          corpse_vp: corpseVp,
        });
      }
    }
  }
  return violations;
}

// Returns the set of "corpse" canonical keys for a given doc so we can stamp
// the per-epoch record with `is_migration_corpse`.
function corpseKeysForDoc(doc) {
  const v = snapshotInvariants(doc);
  const corpseSet = new Set();
  for (const x of v) {
    if (x.kind !== 'migration_corpse_candidate') continue;
    // We don't have the bucket directly here, but the corpse_gauge is unique enough;
    // recompute by scanning pools to map back to canonical key
    const pools = Array.isArray(doc.pools) ? doc.pools : [];
    for (const p of pools) {
      const gid = p.gauge_pool_id || p.pool_address;
      if (gid === x.corpse_gauge) corpseSet.add(canonicalKey(p));
    }
  }
  return corpseSet;
}

// ---- compute ----
function buildPoolStatusHistory(entries) {
  // Pick one representative doc per epoch (latest capturedAt)
  const repByEpoch = new Map();
  for (const { doc } of entries) {
    const ep = epochOf(doc); if (!Number.isFinite(ep)) continue;
    const cap = doc.capturedAt || doc.generatedAt || '';
    const cur = repByEpoch.get(ep);
    if (!cur || String(cap) > String(cur.capturedAt)) repByEpoch.set(ep, { capturedAt: cap, doc });
  }

  const invariantsPerEpoch = {};
  const corpseKeysPerEpoch = {};
  for (const [ep, { doc }] of repByEpoch.entries()) {
    invariantsPerEpoch[String(ep)] = snapshotInvariants(doc);
    corpseKeysPerEpoch[String(ep)] = corpseKeysForDoc(doc);
  }

  const acc = new Map();
  for (const [ep, { capturedAt, doc }] of repByEpoch.entries()) {
    const pools = Array.isArray(doc.pools) ? doc.pools : [];
    // Bucket totals for pct_of_bucket recomputation
    const bt = {};
    for (const p of pools) { const b = p.bucket; if (b) bt[b] = (bt[b] || 0) + num(p?.voting_power?.vp_human); }
    const corpseSet = corpseKeysPerEpoch[String(ep)] || new Set();

    for (const p of pools) {
      const name = p?.name, dex = p?.dex, bucket = p?.bucket; if (!name || !bucket) continue;
      const key = canonicalKey(p);
      const vp = num(p?.voting_power?.vp_human);
      const lh = p?.lp_health || {}; const a0 = lh.asset_0 || {}; const a1 = lh.asset_1 || {};
      if (!acc.has(key)) acc.set(key, {
        gauge_pool_id: p.gauge_pool_id || null,
        pool_address:  p.pool_address || null,
        name, dex, bucket,
        dex_subtype:   p.dex_subtype || null,
        legacy_name_dex_key: `${name}|${dex}`,
        epochs: {},
      });
      const rec = acc.get(key);
      // Refresh metadata from latest if it has more info
      rec.name = name; rec.dex = dex; rec.bucket = bucket;
      if (p.gauge_pool_id && !rec.gauge_pool_id) rec.gauge_pool_id = p.gauge_pool_id;
      if (p.pool_address && !rec.pool_address)   rec.pool_address  = p.pool_address;
      if (p.dex_subtype  && !rec.dex_subtype)    rec.dex_subtype   = p.dex_subtype;

      rec.epochs[String(ep)] = {
        vp_human: vp, bucket_pct: bt[bucket] ? (vp / bt[bucket]) * 100 : 0,
        status: p?.status || 'unknown', active: p?.status === 'active',
        depth_usd: num(p?.depth_usd), staked_usd: num(p?.staked_in_tla_usd),
        a0_sym: a0.symbol ?? null, a0_amt: num(a0.amount_human),
        a0_px: num(a0.price_usd), a0_price_source: a0.price_source ?? null,
        a1_sym: a1.symbol ?? null, a1_amt: num(a1.amount_human),
        a1_px: num(a1.price_usd), a1_price_source: a1.price_source ?? null,
        is_migration_corpse: corpseSet.has(key),
        capturedAt,
      };
    }
  }

  const pools = [...acc.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return {
    schemaVersion: 3,
    cron: 'pool-status-history',
    generatedAt: new Date().toISOString(),
    sourceDailyFiles: entries.length,
    epochs: [...repByEpoch.keys()].sort((a, b) => a - b),
    pools,
    _invariants: invariantsPerEpoch,
  };
}

async function run() {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set');
  console.log('[pool-status v3] GitHub mode: ' + GITHUB_REPO + '@' + GITHUB_BRANCH);
  const entries = await listDailyDocsFromGithub();
  if (!entries.length) throw new Error('no daily docs found');
  const output = buildPoolStatusHistory(entries);
  const json = JSON.stringify(output, null, 2);
  const totalViolations = Object.values(output._invariants).reduce((s, v) => s + v.length, 0);
  console.log(`[pool-status v3] ${output.pools.length} pools across epochs ${output.epochs.join(', ')} from ${entries.length} daily files`);
  if (totalViolations > 0) console.log(`[pool-status v3] ⚠ ${totalViolations} invariant violations recorded — see _invariants in output`);
  await pushToGithub(OUT_PATH, json, '📈 Pool status history rollup v3 — epochs ' + output.epochs.join(', '));
  return output;
}

async function main() {
  const { daily, out } = parseArgs();
  if (daily) {
    console.log('[pool-status v3] LOCAL mode: ' + daily);
    const entries = loadDailyDocsLocal(daily);
    if (!entries.length) { console.error('[pool-status v3] no daily docs found'); process.exit(1); }
    const output = buildPoolStatusHistory(entries);
    const target = out || './pool-status-history.json';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(output, null, 2));
    const totalViolations = Object.values(output._invariants).reduce((s, v) => s + v.length, 0);
    console.log(`[pool-status v3] wrote ${target} (${output.pools.length} pools, epochs ${output.epochs.join(', ')}, ${totalViolations} invariant violations)`);
    return;
  }
  await run();
}

if (require.main === module) {
  main().catch(e => { console.error('[pool-status v3] FATAL', e); process.exit(1); });
}
module.exports = { run, buildPoolStatusHistory, canonicalKey, snapshotInvariants };
