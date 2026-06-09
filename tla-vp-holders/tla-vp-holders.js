#!/usr/bin/env node
/**
 * tla-vp-holders.js  —  NEW (schema v1, 2026-05-30)
 * ============================================================================
 * Per-wallet TLA voting-power census + concentration metrics.
 *
 * RATIONALE (CRON-FIXES-BRIEF item 2.2)
 * ----------------------------------------------------------------------------
 * The dashboard needs to show how concentrated TLA voting power is ("Control
 * of TLA" panel), but per-holder VP isn't captured anywhere. This cron walks
 * the voting-escrow CW721 enumeration (all_tokens → owner_of → lock_info),
 * aggregates VP per wallet, and emits both raw per-wallet records and
 * derived concentration metrics (top-1/5/10 share, HHI, etc).
 *
 * HONEST LIMITATION:
 *   Multi-wallet clustering (one entity → many wallets) CANNOT be proven on
 *   chain. We emit per-wallet only and label the dashboard accordingly.
 *   "wallet count" is NOT "distinct people."
 *
 * EXPECTED COST PER RUN
 *   1 num_tokens query (instant)
 *   ~5 all_tokens pages of 100 (currently ~429 locks total) = 5 queries
 *   429 owner_of + 429 lock_info queries (~858 chain calls)
 *   At concurrency 5 → ~4-5 minutes elapsed
 *   Both LCD endpoints used as primary/fallback (publicnode rate limits).
 *
 * OUTPUT
 *   data/holders.json     — per-wallet VP, lock count, lock_end summary
 *   data/concentration.json — top-N shares, HHI, Gini, distribution histograms
 *   data/heartbeat.json   — schema same as other crons + freshness fingerprint
 *
 * DEPLOY ON RENDER
 *   Create new repo: defipatriot/tla-vp-holders-data_2026
 *   Render service env:
 *     GITHUB_TOKEN  (required, repo write scope)
 *     GITHUB_REPO   = defipatriot/tla-vp-holders-data_2026
 *     GITHUB_BRANCH = main  (default)
 *     TLA_VOTING_ESCROW  = (optional override; default below is correct)
 *   Schedule: weekly (Monday 02:00 UTC) — concentration changes slowly and
 *             ~860 chain calls is expensive to run more often than needed.
 *
 *   Build command: (none — pure node)
 *   Start command: node tla-vp-holders.js
 *
 * LOCAL / TEST MODE
 *   GITHUB_TOKEN= node tla-vp-holders.js
 *   (writes ./holders.json, ./concentration.json, ./heartbeat.json)
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- Config ----
const TERRA_LCD_PRIMARY  = process.env.TERRA_LCD_PRIMARY  || 'https://terra-lcd.publicnode.com';
const TERRA_LCD_FALLBACK = process.env.TERRA_LCD_FALLBACK || 'https://terra-rest.publicnode.com';
const TLA_VOTING_ESCROW  = process.env.TLA_VOTING_ESCROW  || 'terra1uqhj8agyeaz8fu6mdggfuwr3lp32jlrx5hqag4jxexde92rzkamq3l62zg';
const GITHUB_TOKEN       = process.env.GITHUB_TOKEN;
const GITHUB_REPO        = process.env.GITHUB_REPO   || 'defipatriot/tla-vp-holders-data_2026';
const GITHUB_BRANCH      = process.env.GITHUB_BRANCH || 'main';
// Set true if all_tokens enumeration ends on a query FAILURE (null) rather than a genuine empty
// page — prevents a silently-truncated holder list from publishing as 'ok'.
let ENUM_INCOMPLETE = false;

const BATCH_CONCURRENCY  = 5;     // matches adao-positions; safe for publicnode LCD
const PAGE_LIMIT         = 100;   // all_tokens page size

// ---- HTTP helpers (vendored from adao-positions for behavior parity) ----
function fetchJson(url, label = '') {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'aDAO-vp-holders/1.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} ${label}`)); }
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function encodeQuery(q) { return Buffer.from(JSON.stringify(q)).toString('base64'); }

async function queryContract(contractAddr, query, attemptFallback = true) {
  const qb = encodeQuery(query);
  const p  = `/cosmwasm/wasm/v1/contract/${contractAddr}/smart/${qb}`;
  const label = `query ${JSON.stringify(query).slice(0, 60)}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { const r = await fetchJson(TERRA_LCD_PRIMARY + p, `${label} (try ${attempt})`); return r.data; }
    catch (e) { if (attempt < 2) await new Promise(r => setTimeout(r, 200 + Math.random() * 300)); }
  }
  if (attemptFallback) {
    try { const r = await fetchJson(TERRA_LCD_FALLBACK + p, `${label} (fallback)`); return r.data; }
    catch (e) { return null; }
  }
  return null;
}

async function parallelMap(items, fn, concurrency = BATCH_CONCURRENCY) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); }
      catch (e) { results[i] = { _error: e.message || String(e) }; }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---- GitHub helpers ----
function githubApiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.github.com', path: apiPath, method,
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'aDAO-vp-holders/1.0',
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

// ---- Holders walk ----
async function enumerateAllTokens() {
  const out = [];
  let startAfter = null;
  let page = 0;
  while (true) {
    page++;
    const q = startAfter ? { all_tokens: { limit: PAGE_LIMIT, start_after: startAfter } }
                         : { all_tokens: { limit: PAGE_LIMIT } };
    const r = await queryContract(TLA_VOTING_ESCROW, q);
    if (r === null) { ENUM_INCOMPLETE = true; console.warn(`  ⚠ all_tokens page ${page} returned null (query FAILED, not end-of-list) — holder enumeration INCOMPLETE → status partial`); break; }
    const tokens = Array.isArray(r?.tokens) ? r.tokens : [];
    if (tokens.length === 0) break;
    out.push(...tokens);
    if (tokens.length < PAGE_LIMIT) break;
    startAfter = tokens[tokens.length - 1];
    console.log(`  page ${page}: ${tokens.length} tokens (cumulative: ${out.length})`);
  }
  return out;
}

async function fetchOwnerOf(tokenId) {
  const r = await queryContract(TLA_VOTING_ESCROW, { owner_of: { token_id: tokenId } });
  return r?.owner || null;
}

async function fetchLockInfo(tokenId) {
  const r = await queryContract(TLA_VOTING_ESCROW, { lock_info: { token_id: tokenId, time: 'next' } });
  return r || null;
}

// ---- Concentration metrics ----
function computeMetrics(holders) {
  const vps = holders.map(h => h.vp).sort((a, b) => b - a);
  const total = vps.reduce((s, v) => s + v, 0);
  const n = vps.length;
  if (n === 0 || total === 0) return null;
  function topPct(k) {
    const slice = vps.slice(0, k);
    const sum = slice.reduce((s, v) => s + v, 0);
    return { count: slice.length, vp: sum, pct: (sum / total) * 100 };
  }
  // HHI ∈ [10000/n, 10000] — sum of squared market shares (×10000 for percentage form)
  let hhi = 0;
  for (const v of vps) { const s = (v / total) * 100; hhi += s * s; }
  // Gini coefficient (0 = perfect equality, 1 = one wallet owns everything)
  let gini = 0;
  for (let i = 0; i < n; i++) gini += (2 * (i + 1) - n - 1) * vps[n - 1 - i];  // sorted desc, flip for asc
  gini = gini / (n * total);
  return {
    total_vp:    total,
    holder_count: n,
    top_1:       topPct(1),
    top_5:       topPct(5),
    top_10:      topPct(10),
    top_25:      topPct(25),
    top_50:      topPct(50),
    hhi:         Math.round(hhi * 100) / 100,
    gini:        Math.round(gini * 10000) / 10000,
  };
}

function computeFingerprint(holders, metrics) {
  // Fingerprint: sorted (wallet, vp_rounded) tuples + top metrics.
  // Rounding to integer micro-LUNA keeps the hash stable across tiny floats.
  const items = holders.map(h => [h.address, Math.round(h.vp)]);
  items.sort((a, b) => a[0].localeCompare(b[0]));
  const input = JSON.stringify({
    holders: items,
    total: metrics?.total_vp ? Math.round(metrics.total_vp) : 0,
    top1_pct: metrics?.top_1?.pct ? Math.round(metrics.top_1.pct * 100) : 0,
  });
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

async function fetchPreviousHeartbeat() {
  try {
    const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/data/heartbeat.json`;
    return await fetchJson(url, 'previous-heartbeat');
  } catch (e) { return null; }
}

// ---- main ----
async function run() {
  const startedAt = new Date();
  console.log(`\n🏛  TLA VP Holders Census`);
  console.log(`   Started: ${startedAt.toISOString()}`);
  console.log(`   Escrow:  ${TLA_VOTING_ESCROW}`);

  // 1) num_tokens (quick health check + size estimate)
  const numTokensResp = await queryContract(TLA_VOTING_ESCROW, { num_tokens: {} });
  const numTokens = numTokensResp?.count ?? null;
  console.log(`   num_tokens: ${numTokens}\n`);

  // 2) Enumerate all token IDs
  console.log('📋 Enumerating all tokens...');
  const tokenIds = await enumerateAllTokens();
  console.log(`  ✓ ${tokenIds.length} token IDs collected\n`);

  // 3) Fetch owner_of + lock_info for each token, in parallel batches
  console.log(`🔎 Fetching owner + lock_info for ${tokenIds.length} tokens (concurrency=${BATCH_CONCURRENCY})...`);
  const ownerPairs = await parallelMap(tokenIds, async (tid) => {
    const [owner, lock] = await Promise.all([fetchOwnerOf(tid), fetchLockInfo(tid)]);
    return { token_id: tid, owner, lock };
  });

  // 4) Aggregate per-wallet
  const byOwner = new Map();
  let errors = 0;
  for (const r of ownerPairs) {
    if (!r || r._error || !r.owner) { errors++; continue; }
    if (!byOwner.has(r.owner)) byOwner.set(r.owner, {
      address: r.owner,
      vp: 0,
      lock_count: 0,
      locks: [],
    });
    const rec = byOwner.get(r.owner);
    // lock.voting_power is a string in chain units (LUNA decimals=6)
    const vpRaw = Number(r.lock?.voting_power || 0);
    const vpHuman = vpRaw / 1e6;
    rec.vp += vpHuman;
    rec.lock_count += 1;
    rec.locks.push({
      token_id:    r.token_id,
      vp_raw:      vpRaw,
      vp_human:    vpHuman,
      end_period:  r.lock?.end?.period ?? null,
      coefficient: r.lock?.coefficient ? Number(r.lock.coefficient) : null,
      asset:       r.lock?.asset || null,
    });
  }
  const holders = [...byOwner.values()].sort((a, b) => b.vp - a.vp);
  for (let i = 0; i < holders.length; i++) holders[i].rank = i + 1;
  console.log(`  ✓ ${holders.length} unique holders, ${errors} token-fetch errors\n`);

  // 5) Compute concentration metrics
  const metrics = computeMetrics(holders);

  // 6) Build output docs
  const holdersDoc = {
    schemaVersion: 1,
    cron: 'tla-vp-holders',
    capturedAt: startedAt.toISOString(),
    capturedAtUnix: startedAt.getTime(),
    escrow_contract: TLA_VOTING_ESCROW,
    num_tokens: numTokens,
    holder_count: holders.length,
    errors_count: errors,
    note: 'Per-wallet only. Multi-wallet clustering (one entity, many wallets) cannot be proven on chain.',
    holders,
  };
  const concentrationDoc = {
    schemaVersion: 1,
    cron: 'tla-vp-holders',
    capturedAt: startedAt.toISOString(),
    metrics,
    histogram_buckets_human: bucketize(holders.map(h => h.vp)),
    note: 'Concentration of TLA voting power across distinct wallets at capturedAt. Wallets are NOT people.',
  };

  // 7) Heartbeat with freshness fingerprint (matches the pattern used by the other 7 crons)
  const prev = await fetchPreviousHeartbeat();
  const fingerprint = computeFingerprint(holders, metrics);
  const prevFp = prev?.dataFingerprint || null;
  let dataFreshness = 'fresh';
  let consecutiveStuckRuns = 0;
  if (prevFp && prevFp === fingerprint) {
    consecutiveStuckRuns = (Number(prev?.consecutiveStuckRuns) || 1) + 1;
    dataFreshness = consecutiveStuckRuns >= 3 ? 'stuck' : 'suspicious';
  }
  const heartbeat = {
    schemaVersion: 1,
    cron: 'tla-vp-holders',
    capturedAt: startedAt.toISOString(),
    capturedAtUnix: startedAt.getTime(),
    runId: `vph-${startedAt.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
    runMode: 'weekly',
    status: dataFreshness === 'stuck' ? 'stuck' : ((errors > 0 || ENUM_INCOMPLETE) ? 'partial' : 'ok'),
    stats: {
      holder_count: holders.length,
      total_vp_human: metrics?.total_vp ?? null,
      top_1_pct: metrics?.top_1?.pct ?? null,
      top_5_pct: metrics?.top_5?.pct ?? null,
      top_10_pct: metrics?.top_10?.pct ?? null,
      num_tokens: numTokens,
      token_fetch_errors: errors,
    },
    dataFingerprint: fingerprint,
    previousFingerprint: prevFp,
    dataFreshness,
    consecutiveStuckRuns,
    next_expected_run_at: new Date(startedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };

  // 8) Publish or save locally
  if (GITHUB_TOKEN) {
    console.log('📤 Publishing to GitHub...');
    await pushToGithub('data/holders.json',       JSON.stringify(holdersDoc, null, 2),       `🏛 TLA holders (${holders.length} wallets)`);
    await pushToGithub('data/concentration.json', JSON.stringify(concentrationDoc, null, 2), `📊 TLA concentration metrics`);
    await pushToGithub('data/heartbeat.json',     JSON.stringify(heartbeat, null, 2),        `📍 TLA holders heartbeat`);
  } else {
    console.log('⚠️  GITHUB_TOKEN not set — saving locally');
    fs.writeFileSync('holders.json',       JSON.stringify(holdersDoc, null, 2));
    fs.writeFileSync('concentration.json', JSON.stringify(concentrationDoc, null, 2));
    fs.writeFileSync('heartbeat.json',     JSON.stringify(heartbeat, null, 2));
    console.log('  Saved: holders.json, concentration.json, heartbeat.json');
  }

  const elapsed = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
  console.log(`\n✅ Done (${elapsed}s) — ${holders.length} holders, top1=${metrics?.top_1?.pct?.toFixed(1)}%, top10=${metrics?.top_10?.pct?.toFixed(1)}%, freshness=${dataFreshness}\n`);
}

// Bucketize VPs for a human-readable distribution histogram.
function bucketize(vps) {
  const bounds = [0, 1e3, 1e4, 5e4, 1e5, 5e5, 1e6, 5e6, 1e7];
  const labels = ['<1k', '1k-10k', '10k-50k', '50k-100k', '100k-500k', '500k-1M', '1M-5M', '5M-10M', '>10M'];
  const counts = new Array(labels.length).fill(0);
  for (const v of vps) {
    let placed = false;
    for (let i = 0; i < bounds.length - 1; i++) {
      if (v >= bounds[i] && v < bounds[i+1]) { counts[i]++; placed = true; break; }
    }
    if (!placed) counts[counts.length - 1]++;
  }
  return labels.map((label, i) => ({ label, count: counts[i] }));
}

if (require.main === module) {
  run().catch(e => { console.error('❌ tla-vp-holders FATAL', e); process.exit(1); });
}
module.exports = { run, computeMetrics, computeFingerprint };
