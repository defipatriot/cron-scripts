#!/usr/bin/env node
/**
 * apr-history-rollup.js  —  schema v2
 * ============================================================================
 * Per-epoch APR rollup for the TLA Stats dashboard.
 *
 * WHAT CHANGED (v1 → v2, 2026-05-30)
 * ----------------------------------------------------------------------------
 * Driven by CRON-FIXES-BRIEF item 1.1 (gauge_pool_id keying) and 2.6 (carry
 * dex_subtype). Previous version keyed on `name|dex` which collides when the
 * same pool pair exists as multiple gauges (active + voted_but_below_threshold
 * leftovers, or post-migration corpses with the same name but different curve).
 *
 *   v1 key: `${name}|${dex}`                — collides across variants
 *   v2 key: `${gauge_pool_id}|${bucket}`    — actually unique
 *
 * Per-pool fields preserved across epochs:
 *   - gauge_pool_id, name, dex, bucket
 *   - dex_subtype        (NEW — needed for IL/value-split interpretation)
 *   - pool_address       (NEW — additional id for audit)
 *   - status_at_epoch    (NEW — distinguishes active vs voted-below-threshold)
 *
 * INVARIANTS (recorded per epoch in `_invariants` block)
 * ----------------------------------------------------------------------------
 *   - multiple_active_per_name_dex_bucket: at most 1 active row per (n,d,b)
 *   - migration_corpse_candidates: name/dex/bucket where lower-VP variants
 *     exist alongside a dominant active variant
 * Violations don't throw — they're recorded for dashboard/audit consumption.
 *
 * SAFE LEGACY KEYS — output still includes `name`/`dex` per pool for humans,
 * and `legacy_name_dex_key` so a v1 consumer can migrate gracefully.
 *
 * DEPLOY ON RENDER  (same as v1)
 *   GITHUB_TOKEN, GITHUB_REPO (default defipatriot/tla-snapshot-data_2026),
 *   GITHUB_BRANCH (default main).
 *   Command:  node apr-history-rollup.js
 *
 * LOCAL / TEST MODE
 *   node apr-history-rollup.js --daily ./some/local/daily --out ./apr-history.json
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/tla-snapshot-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const OUT_PATH      = 'data/apr-history.json';

function parseArgs() {
  const a = process.argv.slice(2); const o = { daily: null, out: null };
  for (let i = 0; i < a.length; i++) { if (a[i] === '--daily') o.daily = a[++i]; else if (a[i] === '--out') o.out = a[++i]; }
  return o;
}
const epochOf = (doc) => (doc?.epoch && typeof doc.epoch === 'object') ? Number(doc.epoch.currentEpoch) : Number(doc?.epoch);
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

// Canonical pool key. gauge_pool_id is THE unique id on Eris. The same gauge
// can legitimately appear in two buckets (e.g. USDC-USDT in `bluechip` and
// `single`) so the key includes bucket. Fall back to pool_address|bucket
// then name|dex|bucket for old daily archives pre-dating gauge_pool_id.
function canonicalKey(p) {
  if (p.gauge_pool_id && p.bucket) return `${p.gauge_pool_id}|${p.bucket}`;
  if (p.pool_address  && p.bucket) return `addr:${p.pool_address}|${p.bucket}`;
  return `name:${p.name}|${p.dex}|${p.bucket || '?'}`;
}

// ---- GitHub helpers (mirrors the tla-snapshot cron verbatim) ----
function githubApiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.github.com', path: apiPath, method,
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'aDAO-apr-history/2.0',
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
    https.get(url, { headers: { 'User-Agent': 'aDAO-apr-history/2.0' } }, (res) => {
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
  const docs = [];
  for (const f of files) { try { docs.push(await fetchJsonUrl(f.download_url)); } catch (e) { console.warn(`  skip ${f.name}: ${e.message}`); } }
  return docs;
}
function loadDailyDocsLocal(dir) {
  const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } }).filter(Boolean);
}

// Invariant checks for a single snapshot's pools.
function snapshotInvariants(doc) {
  const pools = Array.isArray(doc.pools) ? doc.pools : [];
  const violations = [];
  const activeByNDB = {};
  for (const p of pools) {
    if (p.status !== 'active') continue;
    const k = `${p.name}|${p.dex}|${p.bucket}`;
    activeByNDB[k] = (activeByNDB[k] || 0) + 1;
  }
  for (const [k, n] of Object.entries(activeByNDB)) {
    if (n > 1) violations.push({ kind: 'multiple_active_per_name_dex_bucket', key: k, count: n });
  }
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
          corpse_gauge: corpse.gauge_pool_id || corpse.pool_address,
          corpse_subtype: corpse.dex_subtype,
          corpse_vp: corpseVp,
        });
      }
    }
  }
  return violations;
}

// ---- compute ----
function buildAprHistory(docs) {
  const acc = new Map();
  const epochSet = new Set();
  const invariantsPerEpoch = {};

  const repDocByEpoch = new Map();
  for (const doc of docs) {
    const ep = epochOf(doc); if (!Number.isFinite(ep)) continue;
    const cap = doc.capturedAt || doc.generatedAt || '';
    const cur = repDocByEpoch.get(ep);
    if (!cur || String(cap) > String(cur.capturedAt)) repDocByEpoch.set(ep, { capturedAt: cap, doc });
  }
  for (const [ep, { doc }] of repDocByEpoch.entries()) {
    invariantsPerEpoch[String(ep)] = snapshotInvariants(doc);
  }

  for (const doc of docs) {
    const ep = epochOf(doc); if (!Number.isFinite(ep)) continue; epochSet.add(ep);
    for (const p of (Array.isArray(doc.pools) ? doc.pools : [])) {
      const name = p?.name, dex = p?.dex; if (!name || !dex) continue;
      const apr = Number(p?.rewards?.approx_apr_pct); if (!Number.isFinite(apr)) continue;
      const staked = num(p?.staked_in_tla_usd);
      const key = canonicalKey(p);
      if (!acc.has(key)) {
        acc.set(key, {
          gauge_pool_id:  p.gauge_pool_id || null,
          pool_address:   p.pool_address || null,
          name, dex,
          bucket:         p.bucket || null,
          dex_subtype:    p.dex_subtype || null,
          legacy_name_dex_key: `${name}|${dex}`,
          epochs: {},
        });
      }
      const rec = acc.get(key);
      if (p.gauge_pool_id && !rec.gauge_pool_id) rec.gauge_pool_id = p.gauge_pool_id;
      if (p.pool_address && !rec.pool_address)   rec.pool_address  = p.pool_address;
      if (p.dex_subtype  && !rec.dex_subtype)    rec.dex_subtype   = p.dex_subtype;
      if (p.bucket       && !rec.bucket)         rec.bucket        = p.bucket;
      if (!rec.epochs[ep]) rec.epochs[ep] = { aprSum: 0, stakedSum: 0, days: 0, statuses: {} };
      const e = rec.epochs[ep];
      e.aprSum += apr; e.stakedSum += staked; e.days += 1;
      const st = p.status || 'unknown';
      e.statuses[st] = (e.statuses[st] || 0) + 1;
    }
  }

  const pools = [];
  for (const rec of acc.values()) {
    const epochs = {};
    for (const [ep, e] of Object.entries(rec.epochs)) {
      const dominantStatus = Object.entries(e.statuses).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
      epochs[ep] = {
        apr_pct_avg:    e.days ? e.aprSum / e.days : 0,
        staked_usd_avg: e.days ? e.stakedSum / e.days : 0,
        days:           e.days,
        status:         dominantStatus,
        status_breakdown: e.statuses,
      };
    }
    pools.push({
      gauge_pool_id: rec.gauge_pool_id,
      pool_address:  rec.pool_address,
      name:          rec.name,
      dex:           rec.dex,
      bucket:        rec.bucket,
      dex_subtype:   rec.dex_subtype,
      legacy_name_dex_key: rec.legacy_name_dex_key,
      epochs,
    });
  }
  pools.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return {
    schemaVersion: 2,
    cron: 'apr-history',
    generatedAt: new Date().toISOString(),
    sourceDailyFiles: docs.length,
    epochs: [...epochSet].sort((a, b) => a - b),
    pools,
    _invariants: invariantsPerEpoch,
  };
}

async function run() {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set');
  console.log('[apr-history v2] GitHub mode: ' + GITHUB_REPO + '@' + GITHUB_BRANCH);
  const docs = await listDailyDocsFromGithub();
  if (!docs.length) throw new Error('no daily docs found');
  const output = buildAprHistory(docs);
  const json = JSON.stringify(output, null, 2);
  const totalViolations = Object.values(output._invariants).reduce((s, v) => s + v.length, 0);
  console.log(`[apr-history v2] ${output.pools.length} pools across epochs ${output.epochs.join(', ')} from ${docs.length} daily files`);
  if (totalViolations > 0) console.log(`[apr-history v2] ⚠ ${totalViolations} invariant violations recorded — see _invariants in output`);
  await pushToGithub(OUT_PATH, json, '📊 APR history rollup v2 — epochs ' + output.epochs.join(', '));
  return output;
}

async function main() {
  const { daily, out } = parseArgs();
  if (daily) {
    console.log('[apr-history v2] LOCAL mode: ' + daily);
    const docs = loadDailyDocsLocal(daily);
    if (!docs.length) { console.error('[apr-history v2] no daily docs found'); process.exit(1); }
    const output = buildAprHistory(docs);
    const target = out || './apr-history.json';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(output, null, 2));
    const totalViolations = Object.values(output._invariants).reduce((s, v) => s + v.length, 0);
    console.log(`[apr-history v2] wrote ${target} (${output.pools.length} pools, epochs ${output.epochs.join(', ')}, ${totalViolations} invariant violations)`);
    return;
  }
  await run();
}

if (require.main === module) {
  main().catch(e => { console.error('[apr-history v2] FATAL', e); process.exit(1); });
}
module.exports = { run, buildAprHistory, canonicalKey, snapshotInvariants };
