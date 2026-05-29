#!/usr/bin/env node
/**
 * apr-history-rollup.js  —  self-contained Render cron
 * ---------------------------------------------------------------------------
 * Per-epoch APR rollup for the TLA Stats dashboard "Top by APR" movement badge.
 *
 * HOW IT FITS THE EXISTING SETUP
 *   The tla-snapshot cron writes a daily archive to data/daily/{YYYY-MM-DD}.json
 *   in the tla-snapshot-data_2026 repo (via the GitHub API — there is NO local
 *   data/daily folder). This script reads those daily archives straight from
 *   GitHub, averages each epoch's APR per pool, and pushes data/apr-history.json
 *   back to the same repo using the SAME push mechanism the snapshot cron uses.
 *
 * DEPLOY ON RENDER
 *   Add as a scheduled job (daily, shortly after the snapshot cron's 23:xx UTC
 *   daily-archive write — e.g. 23:40 UTC). Reuse the SAME env vars the
 *   tla-snapshot cron already has:
 *     GITHUB_TOKEN   (required to push)
 *     GITHUB_REPO    (default defipatriot/tla-snapshot-data_2026)
 *     GITHUB_BRANCH  (default main)
 *   Command:  node apr-history-rollup.js
 *   You can run this and pool-status-history-rollup.js in one job:
 *     node apr-history-rollup.js && node pool-status-history-rollup.js
 *
 * LOCAL / TEST MODE
 *   node apr-history-rollup.js --daily ./some/local/daily --out ./apr-history.json
 *   reads a local folder and writes a local file (no GitHub calls).
 *
 * APR SEMANTICS (unchanged)
 *   Stores RAW approx_apr_pct + avg staked per pool per epoch; the dashboard
 *   applies the same amp-factor + $20K filter + 200% cap as the live number.
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

// ---- GitHub helpers (mirrors the tla-snapshot cron verbatim) ----
function githubApiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.github.com', path: apiPath, method,
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'aDAO-apr-history/1.0',
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
    https.get(url, { headers: { 'User-Agent': 'aDAO-apr-history/1.0' } }, (res) => {
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

// ---- compute (unchanged semantics) ----
function buildAprHistory(docs) {
  const acc = new Map(); const epochSet = new Set();
  for (const doc of docs) {
    const ep = epochOf(doc); if (!Number.isFinite(ep)) continue; epochSet.add(ep);
    for (const p of (Array.isArray(doc.pools) ? doc.pools : [])) {
      const name = p?.name, dex = p?.dex; if (!name || !dex) continue;
      const apr = Number(p?.rewards?.approx_apr_pct); if (!Number.isFinite(apr)) continue;
      const staked = num(p?.staked_in_tla_usd);
      const key = `${name}|${dex}`;
      if (!acc.has(key)) acc.set(key, { name, dex, bucket: p.bucket || null, epochs: {} });
      const rec = acc.get(key); if (p.bucket) rec.bucket = p.bucket;
      if (!rec.epochs[ep]) rec.epochs[ep] = { aprSum: 0, stakedSum: 0, days: 0 };
      const e = rec.epochs[ep]; e.aprSum += apr; e.stakedSum += staked; e.days += 1;
    }
  }
  const pools = [];
  for (const rec of acc.values()) {
    const epochs = {};
    for (const [ep, e] of Object.entries(rec.epochs))
      epochs[ep] = { apr_pct_avg: e.days ? e.aprSum / e.days : 0, staked_usd_avg: e.days ? e.stakedSum / e.days : 0, days: e.days };
    pools.push({ name: rec.name, dex: rec.dex, bucket: rec.bucket, epochs });
  }
  pools.sort((a, b) => a.name.localeCompare(b.name));
  return { schemaVersion: 1, cron: 'apr-history', generatedAt: new Date().toISOString(),
    sourceDailyFiles: docs.length, epochs: [...epochSet].sort((a, b) => a - b), pools };
}

// ---- callable entry point (used when required by the tla-snapshot cron) ----
// GitHub mode: list+fetch daily archives from GitHub, compute, push the rollup.
async function run() {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set');
  console.log('[apr-history] GitHub mode: ' + GITHUB_REPO + '@' + GITHUB_BRANCH);
  const docs = await listDailyDocsFromGithub();
  if (!docs.length) throw new Error('no daily docs found');
  const output = buildAprHistory(docs);
  const json = JSON.stringify(output, null, 2);
  console.log('[apr-history] ' + output.pools.length + ' pools across epochs ' + output.epochs.join(', ') + ' from ' + docs.length + ' daily files');
  await pushToGithub(OUT_PATH, json, '📊 APR history rollup — epochs ' + output.epochs.join(', '));
  return output;
}

// CLI: --daily <dir> [--out <file>] = local mode (no GitHub); otherwise GitHub mode.
async function main() {
  const { daily, out } = parseArgs();
  if (daily) {
    console.log('[apr-history] LOCAL mode: ' + daily);
    const docs = loadDailyDocsLocal(daily);
    if (!docs.length) { console.error('[apr-history] no daily docs found'); process.exit(1); }
    const output = buildAprHistory(docs);
    const target = out || './apr-history.json';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(output, null, 2));
    console.log('[apr-history] wrote ' + target + ' (' + output.pools.length + ' pools, epochs ' + output.epochs.join(', ') + ')');
    return;
  }
  await run();
}

// Only auto-run when executed directly (`node apr-history-rollup.js`), NOT when require()'d by the cron.
if (require.main === module) {
  main().catch(e => { console.error('[apr-history] FATAL', e); process.exit(1); });
}

module.exports = { run };
