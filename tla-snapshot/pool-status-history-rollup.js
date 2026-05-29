#!/usr/bin/env node
/**
 * pool-status-history-rollup.js  —  self-contained Render cron
 * ---------------------------------------------------------------------------
 * Per-epoch pool history for the TLA Stats Threshold Watch AND Exit-Risk panel.
 * Captures per pool per epoch: VP + active status (threshold watch) and
 * depth_usd / staked_in_tla_usd / reserve composition (exit risk).
 *
 * HOW IT FITS THE EXISTING SETUP
 *   Reads the tla-snapshot daily archives (data/daily/{YYYY-MM-DD}.json) straight
 *   from the tla-snapshot-data_2026 repo on GitHub, and pushes
 *   data/pool-status-history.json back via the SAME push mechanism the snapshot
 *   cron uses. No local data/daily folder is required.
 *
 * UNIQUE KEY: pool_address|bucket (fallback gauge_pool_id|bucket, then name|bucket)
 *   — never name alone, so same-name pools (USDC-USDT in two buckets; old/new
 *   LUNA-WBTC) can't cross-wire and produce phantom drops.
 *
 * REPRESENTATIVE SNAPSHOT PER EPOCH: latest daily capture = end-of-epoch state.
 *
 * DEPLOY ON RENDER  (same env as the tla-snapshot cron)
 *   GITHUB_TOKEN (required), GITHUB_REPO (default defipatriot/tla-snapshot-data_2026),
 *   GITHUB_BRANCH (default main). Schedule daily, after the 23:xx UTC daily archive.
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

function parseArgs() {
  const a = process.argv.slice(2); const o = { daily: null, out: null };
  for (let i = 0; i < a.length; i++) { if (a[i] === '--daily') o.daily = a[++i]; else if (a[i] === '--out') o.out = a[++i]; }
  return o;
}
const epochOf = (doc) => (doc?.epoch && typeof doc.epoch === 'object') ? Number(doc.epoch.currentEpoch) : Number(doc?.epoch);
const keyOf = (p) => `${p.pool_address || p.gauge_pool_id || p.name}|${p.bucket}`;
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

// ---- GitHub helpers (mirrors the tla-snapshot cron verbatim) ----
function githubApiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.github.com', path: apiPath, method,
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'aDAO-pool-status/1.0',
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
    https.get(url, { headers: { 'User-Agent': 'aDAO-pool-status/1.0' } }, (res) => {
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

// ---- compute (schema v2: + depth/staked/reserves; keyed by pool_address|bucket) ----
function buildPoolStatusHistory(entries) {
  const repByEpoch = new Map();
  for (const { doc } of entries) {
    const ep = epochOf(doc); if (!Number.isFinite(ep)) continue;
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
      const name = p?.name, dex = p?.dex, bucket = p?.bucket; if (!name || !bucket) continue;
      const key = keyOf(p); const vp = num(p?.voting_power?.vp_human);
      const lh = p?.lp_health || {}; const a0 = lh.asset_0 || {}; const a1 = lh.asset_1 || {};
      if (!acc.has(key)) acc.set(key, { name, dex, bucket, pool_address: p.pool_address || null, epochs: {} });
      const rec = acc.get(key); rec.name = name; rec.dex = dex; rec.bucket = bucket;
      rec.epochs[String(ep)] = {
        vp_human: vp, bucket_pct: bt[bucket] ? (vp / bt[bucket]) * 100 : 0,
        status: p?.status || 'unknown', active: p?.status === 'active',
        depth_usd: num(p?.depth_usd), staked_usd: num(p?.staked_in_tla_usd),
        a0_sym: a0.symbol ?? null, a0_amt: num(a0.amount_human), a0_px: num(a0.price_usd),
        a1_sym: a1.symbol ?? null, a1_amt: num(a1.amount_human), a1_px: num(a1.price_usd),
        capturedAt,
      };
    }
  }
  const pools = [...acc.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { schemaVersion: 2, cron: 'pool-status-history', generatedAt: new Date().toISOString(),
    sourceDailyFiles: entries.length, epochs: [...repByEpoch.keys()].sort((a, b) => a - b), pools };
}

async function main() {
  const { daily, out } = parseArgs();
  let entries;
  if (daily) { console.log(`[pool-status] LOCAL mode: ${daily}`); entries = loadDailyDocsLocal(daily); }
  else {
    if (!GITHUB_TOKEN) { console.error('[pool-status] GITHUB_TOKEN not set and no --daily; aborting.'); process.exit(1); }
    console.log(`[pool-status] GitHub mode: ${GITHUB_REPO}@${GITHUB_BRANCH}`); entries = await listDailyDocsFromGithub();
  }
  if (!entries.length) { console.error('[pool-status] no daily docs found'); process.exit(1); }
  const output = buildPoolStatusHistory(entries);
  const json = JSON.stringify(output, null, 2);
  console.log(`[pool-status] ${output.pools.length} pools across epochs ${output.epochs.join(', ')} from ${entries.length} daily files (schema v2)`);
  if (daily || out) { const target = out || './pool-status-history.json'; fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, json); console.log(`  wrote ${target}`); }
  else { await pushToGithub(OUT_PATH, json, `📈 Pool status history rollup — epochs ${output.epochs.join(', ')}`); }
}
main().catch(e => { console.error('[pool-status] FATAL', e); process.exit(1); });
