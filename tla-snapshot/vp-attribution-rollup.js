#!/usr/bin/env node
/**
 * vp-attribution-rollup.js  —  NEW (schema v1, 2026-05-30)
 * ============================================================================
 * Per-pool aDAO-vs-member VP attribution at the daily/epoch boundary.
 *
 * RATIONALE (CRON-FIXES-BRIEF item 2.1)
 * ----------------------------------------------------------------------------
 * The TLA Stats Vote Breakdown waterfall today can only project the Votion
 * portion forward because the snapshot doesn't separate "VP that came from
 * the aDAO treasury wallet" from "VP that came from individual member wallets".
 * Without that split, the page can't attribute lock→now movement.
 *
 * The data exists already — adao-positions-data_2026/data/current.json carries
 * per-member `voting.votes_per_bucket` and a separate `treasury` wallet with
 * the same structure. Each wallet's VP allocates ONCE per bucket; their
 * weight_bps determines per-gauge attribution within the bucket.
 *
 * This rollup joins:
 *   - adao-positions current.json (per-wallet VP + per-bucket votes)
 *   - tla-snapshot daily archives (per-pool VP, gauge_pool_id, bucket)
 * and emits per gauge_pool_id|bucket, per epoch:
 *   - adao_vp        — treasury wallet attribution to this pool
 *   - member_vp      — sum across non-treasury wallets
 *   - other_vp       — total_vp on the pool minus (adao + member);
 *                       this is whales/non-aDAO holders
 *   - total_vp       — observed in the tla-snapshot
 *
 * Important: aDAO/member attribution is computed FROM the LATEST current.json,
 * not historically — adao-positions only stores the current state. So each
 * daily run captures "what the attribution looks like NOW" against that day's
 * snapshot. History accrues from when this rollup is first deployed.
 *
 * DEPLOY ON RENDER
 *   Same env as the tla-snapshot cron:
 *     GITHUB_TOKEN, GITHUB_REPO (default defipatriot/tla-snapshot-data_2026),
 *     GITHUB_BRANCH (default main).
 *   Schedule: daily, shortly after the snapshot cron's 23:xx UTC daily-archive write.
 *   Command:  node vp-attribution-rollup.js
 *
 *   Recommended: chain after the other rollups in one Render job:
 *     node apr-history-rollup.js && \
 *     node pool-status-history-rollup.js && \
 *     node vp-attribution-rollup.js
 *
 * LOCAL / TEST MODE
 *   node vp-attribution-rollup.js \
 *      --daily ./local/daily \
 *      --adao  ./local/adao-current.json \
 *      --out   ./vp-attribution-history.json
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/tla-snapshot-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const OUT_PATH      = 'data/vp-attribution-history.json';
const ADAO_CURRENT_URL = 'https://raw.githubusercontent.com/defipatriot/adao-positions-data_2026/main/data/current.json';

function parseArgs() {
  const a = process.argv.slice(2); const o = { daily: null, adao: null, out: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--daily') o.daily = a[++i];
    else if (a[i] === '--adao') o.adao = a[++i];
    else if (a[i] === '--out') o.out = a[++i];
  }
  return o;
}
const epochOf = (doc) => (doc?.epoch && typeof doc.epoch === 'object') ? Number(doc.epoch.currentEpoch) : Number(doc?.epoch);
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

// Canonical key matches the other rollups: gauge_pool_id|bucket.
// (adao-positions' votes_per_bucket carries pool_gauge_id, so this lines up.)
function canonicalKey(gauge_pool_id, bucket) { return `${gauge_pool_id}|${bucket}`; }

// ---- HTTP helpers ----
function githubApiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.github.com', path: apiPath, method,
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'aDAO-vp-attr/1.0',
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
    https.get(url, { headers: { 'User-Agent': 'aDAO-vp-attr/1.0' } }, (res) => {
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

// ---- attribution math ----

// Given an adao-positions document, compute per (gauge_pool_id|bucket) VP
// attributed to {adao, member}. Each wallet's VP allocates once PER BUCKET
// according to weight_bps (10000 = 100% of that wallet's VP into the bucket
// went to that gauge; multiple gauges share by weight_bps proportionally).
function attributionFromAdaoCurrent(adao) {
  const members = Array.isArray(adao?.members) ? adao.members : [];
  const treasuryRaw = adao?.treasury;
  const treasury = Array.isArray(treasuryRaw) ? treasuryRaw : (treasuryRaw ? [treasuryRaw] : []);

  // Map: gauge_pool_id|bucket -> { adao_vp, member_vp }
  const attr = new Map();

  // Helper: walk a wallet's votes_per_bucket and add (weight/10000) * wallet_vp
  // to each gauge it voted for, within that bucket.
  function applyWallet(wallet, totalVp, sink) {
    const vpb = wallet?.voting?.votes_per_bucket || {};
    for (const [bucket, bd] of Object.entries(vpb)) {
      const votes = Array.isArray(bd?.votes) ? bd.votes : [];
      const sumWeight = votes.reduce((s, v) => s + num(v.weight_bps), 0);
      if (sumWeight <= 0) continue;
      for (const v of votes) {
        const gpid = v.pool_gauge_id;
        if (!gpid) continue;
        const share = num(v.weight_bps) / sumWeight;     // 0..1
        const vp = totalVp * share;
        const key = canonicalKey(gpid, bucket);
        if (!attr.has(key)) attr.set(key, { adao_vp: 0, member_vp: 0 });
        attr.get(key)[sink] += vp;
      }
    }
  }

  for (const t of treasury) {
    const totalVp = num(t?.voting?.total_voting_power_human);
    if (totalVp > 0) applyWallet(t, totalVp, 'adao_vp');
  }
  for (const m of members) {
    const totalVp = num(m?.voting?.total_voting_power_human);
    if (totalVp > 0) applyWallet(m, totalVp, 'member_vp');
  }
  return attr;
}

// ---- compute ----
function buildVpAttributionHistory(docs, adao, dateLabel) {
  if (!Array.isArray(docs) || docs.length === 0) {
    throw new Error('no daily docs provided');
  }
  if (!adao || typeof adao !== 'object') {
    throw new Error('no adao-positions doc provided');
  }

  // Compute attribution from the (single) current adao-positions doc.
  const attr = attributionFromAdaoCurrent(adao);

  // Pick one representative doc per epoch (latest by capturedAt). This is the
  // boundary snapshot we attribute against.
  const repByEpoch = new Map();
  for (const doc of docs) {
    const ep = epochOf(doc); if (!Number.isFinite(ep)) continue;
    const cap = doc.capturedAt || doc.generatedAt || '';
    const cur = repByEpoch.get(ep);
    if (!cur || String(cap) > String(cur.capturedAt)) repByEpoch.set(ep, { capturedAt: cap, doc });
  }

  // Build per-pool record. For each pool record in the boundary snapshot,
  // pull its attribution slice and compute `other_vp` = total - adao - member.
  // We only emit a per-epoch entry for the CURRENT (latest) epoch, because
  // attribution comes from the current adao-positions doc — earlier epochs
  // would mix today's attribution with their own total VP, which is wrong.
  // Historical attribution accrues by running this rollup daily.
  const epochs = [...repByEpoch.keys()].sort((a, b) => a - b);
  const latestEpoch = epochs[epochs.length - 1];
  const { capturedAt: latestCapturedAt, doc: latestDoc } = repByEpoch.get(latestEpoch);

  // Load existing rollup if running on GitHub to preserve prior per-epoch entries
  // (caller handles that via mergePrevious — see run()).
  const pools = [];
  const seen = new Set();
  const pdoc = Array.isArray(latestDoc.pools) ? latestDoc.pools : [];
  for (const p of pdoc) {
    const gpid = p.gauge_pool_id;
    if (!gpid || !p.bucket) continue;
    const key = canonicalKey(gpid, p.bucket);
    const totalVp = num(p?.voting_power?.vp_human);
    const a = attr.get(key) || { adao_vp: 0, member_vp: 0 };
    const adaoVp = a.adao_vp;
    const memberVp = a.member_vp;
    const accountedVp = adaoVp + memberVp;
    const otherVp = Math.max(0, totalVp - accountedVp);
    seen.add(key);
    pools.push({
      gauge_pool_id: gpid,
      pool_address:  p.pool_address || null,
      name:          p.name,
      dex:           p.dex,
      bucket:        p.bucket,
      dex_subtype:   p.dex_subtype || null,
      epochs: {
        [String(latestEpoch)]: {
          total_vp:    totalVp,
          adao_vp:     adaoVp,
          member_vp:   memberVp,
          other_vp:    otherVp,
          adao_pct:    totalVp ? (adaoVp / totalVp) * 100 : 0,
          member_pct:  totalVp ? (memberVp / totalVp) * 100 : 0,
          other_pct:   totalVp ? (otherVp / totalVp) * 100 : 0,
          adao_source: 'adao-positions current.json',
          captured_against_snapshot_at: latestCapturedAt,
          captured_at: new Date().toISOString(),
        },
      },
    });
  }
  pools.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return {
    schemaVersion: 1,
    cron: 'vp-attribution-history',
    generatedAt: new Date().toISOString(),
    sourceDailyFiles: docs.length,
    adaoCapturedAt: adao?.capturedAt || null,
    boundaryEpoch: latestEpoch,
    boundarySnapshotAt: latestCapturedAt,
    epochs: [latestEpoch],
    pools,
  };
}

// Merge a new attribution build into a previously published rollup, so the
// per-epoch history accumulates across daily runs.
function mergeWithPrevious(prev, fresh) {
  if (!prev || !Array.isArray(prev.pools)) return fresh;
  // Build prev index
  const prevIdx = new Map();
  for (const p of prev.pools) {
    prevIdx.set(canonicalKey(p.gauge_pool_id, p.bucket), p);
  }
  // Merge: for each fresh pool, union epoch entries
  const mergedPools = [];
  const freshKeys = new Set();
  for (const f of fresh.pools) {
    const k = canonicalKey(f.gauge_pool_id, f.bucket);
    freshKeys.add(k);
    const prevP = prevIdx.get(k);
    if (prevP) {
      mergedPools.push({
        ...f,
        epochs: { ...prevP.epochs, ...f.epochs },
      });
    } else {
      mergedPools.push(f);
    }
  }
  // Keep prev-only pools (deactivated/removed in latest)
  for (const [k, p] of prevIdx.entries()) {
    if (!freshKeys.has(k)) mergedPools.push(p);
  }
  mergedPools.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  // Collect all distinct epochs across the merged set
  const allEpochs = new Set();
  for (const p of mergedPools) for (const ep of Object.keys(p.epochs)) allEpochs.add(Number(ep));
  return {
    ...fresh,
    epochs: [...allEpochs].sort((a, b) => a - b),
    pools: mergedPools,
  };
}

async function fetchPreviousRollup() {
  try {
    const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${OUT_PATH}`;
    return await fetchJsonUrl(url);
  } catch (e) {
    console.log('  (no previous rollup to merge; this is the first run)');
    return null;
  }
}

async function run() {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set');
  console.log('[vp-attribution v1] GitHub mode: ' + GITHUB_REPO + '@' + GITHUB_BRANCH);
  const docs = await listDailyDocsFromGithub();
  if (!docs.length) throw new Error('no daily docs found');
  const adao = await fetchJsonUrl(ADAO_CURRENT_URL);
  const fresh = buildVpAttributionHistory(docs, adao);
  const prev = await fetchPreviousRollup();
  const output = mergeWithPrevious(prev, fresh);
  const json = JSON.stringify(output, null, 2);
  console.log(`[vp-attribution v1] ${output.pools.length} pools, ${output.epochs.length} epochs in history, boundary epoch=${fresh.boundaryEpoch}`);
  await pushToGithub(OUT_PATH, json, '📊 VP attribution rollup — epoch ' + fresh.boundaryEpoch);
  return output;
}

async function main() {
  const { daily, adao, out } = parseArgs();
  if (daily && adao) {
    console.log('[vp-attribution v1] LOCAL mode: daily=' + daily + ', adao=' + adao);
    const docs = loadDailyDocsLocal(daily);
    const adaoDoc = JSON.parse(fs.readFileSync(adao, 'utf8'));
    if (!docs.length) { console.error('[vp-attribution v1] no daily docs found'); process.exit(1); }
    const output = buildVpAttributionHistory(docs, adaoDoc);
    const target = out || './vp-attribution-history.json';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(output, null, 2));
    console.log(`[vp-attribution v1] wrote ${target} (${output.pools.length} pools, epoch ${output.boundaryEpoch})`);
    return;
  }
  await run();
}

if (require.main === module) {
  main().catch(e => { console.error('[vp-attribution v1] FATAL', e); process.exit(1); });
}
module.exports = { run, buildVpAttributionHistory, attributionFromAdaoCurrent, mergeWithPrevious };
