// =============================================================================
// Price Cron — one clean token→price table for the whole platform (Rev 1.0.0)
// =============================================================================
//
// Pricing + ratios are already computed by `network-and-prices` (Astroport LP
// prices cross-checked vs CoinGecko, LSTs via Eris hub ratios). This cron does
// NOT recompute — it CONSOLIDATES that into one flat table the dashboard + every
// module reads, and rolls a price history via the shared tier-builder.
//
//   - Reads the price/ratio engine (network-and-prices) — ONE source constant,
//     repointed in one line when that engine migrates into tla-core.
//   - Emits prices/current.json: symbol -> { price_usd, source, change_24h_pct }
//     plus the lst_ratios table (for ratio consumers).
//   - Feeds the flat {symbol: price_usd} record into tier-builder -> prices/history.json
//     (15-min raw -> hourly -> day -> epoch -> month -> year + epoch-end freeze).
//
// Runs every 15 min. No chain queries. USD on the dashboard is still live-from-
// banner at render; this table is the fallback + the source for tokens the banner
// doesn't carry.
//
// OUTPUT — tla-core repo, `prices` module:
//   prices/current.json · prices/history.json · prices/heartbeat.json
// =============================================================================

'use strict';
const fs = require('fs');
const https = require('https');
const TierBuilder = require('../lib/tier-builder.js');

const PRICES_SOURCE_URL = process.env.PRICES_SOURCE_URL
  || 'https://raw.githubusercontent.com/thealliancedao/tla-core/main/network-and-prices/current.json';
const HISTORY_RAW_URL = 'https://raw.githubusercontent.com/defipatriot/tla-core/main/prices/history.json';

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// Canonical 1-indexed epoch (matches the rest of the platform).
const EPOCH_GENESIS = Date.parse('2022-10-31T00:00:00Z');
function epochNow(now) { return Math.floor((now - EPOCH_GENESIS) / (7 * 86400 * 1000)) + 1; }

// ---- tiny HTTP GET → JSON (null on any failure / 404; never throws) ----
function httpGetJson(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'price-cron/1.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

// ---- GitHub publish (standard helper) ----
function githubApiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'api.github.com', path: apiPath, method,
      headers: { 'User-Agent': 'price-cron/1.0', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } };
    if (body) opts.headers['Content-Type'] = 'application/json';
    const req = https.request(opts, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(data)); } catch { resolve(data); } } else reject(new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${data.slice(0,200)}`)); });
    });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
async function publishFile(filePath, content, message) {
  const apiPath = `/repos/${GITHUB_REPO}/contents/${filePath}`;
  let sha = null;
  try { sha = (await githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}`)).sha; } catch (e) { /* new */ }
  const body = { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  return githubApiRequest('PUT', apiPath, body);
}

async function run() {
  const now = Date.now();
  const epoch = epochNow(now);
  console.log(`\n🚀 Price cron — ${new Date(now).toISOString()} — epoch ${epoch}\n`);

  const np = await httpGetJson(PRICES_SOURCE_URL + '?t=' + now);
  if (!np || !np.token_prices) {
    console.error('  ✗ price source unavailable — aborting (no stale write)');
    process.exit(1);
  }

  // flatten the already-computed prices into one clean table
  const prices = {}, flat = {};
  let priced = 0;
  for (const [sym, e] of Object.entries(np.token_prices)) {
    const p = e && e.final_price_usd;
    if (p == null) continue;
    const astro = (e.prices && e.prices.astroport) || {};
    prices[sym] = {
      price_usd: p,
      type: 'token',
      source: e.final_source || null,
      change_24h_pct: astro.price_change_24h_pct ?? null,
      change_7d_pct: astro.price_change_7d_pct ?? null,
    };
    flat[sym] = p;
    priced++;
  }
  const ratios = {};
  for (const [sym, e] of Object.entries(np.lst_ratios || {})) {
    ratios[sym] = { ratio: e.ratio, hub: e.hub, base_token: e.base_token, source: e.source || null };
  }
  console.log(`  ✓ ${priced} token prices, ${Object.keys(ratios).length} ratios`);


  // roll history via the shared tier-builder (reads its own prior history)
  let history = await httpGetJson(HISTORY_RAW_URL + '?t=' + now);
  history = TierBuilder.addReading(history || {}, { t: now, epoch, record: flat });
  console.log(`  ✓ history: ${history.raw.length} raw · ${history.hourly.length} hourly · ${history.daily.length} daily · ${history.epochly.length} epoch`);

  const current = {
    meta: { version: 'prices-1.0.0', schemaVersion: 1, generated_at: new Date(now).toISOString(), epoch,
      source: 'network-and-prices (consolidated)', token_count: priced },
    prices, ratios,
  };
  const heartbeat = { schemaVersion: 1, capturedAt: new Date(now).toISOString(), runId: `prices-${now}`,
    status: 'ok', currentEpoch: epoch, token_count: priced,
    next_expected_run_at: new Date(now + 16 * 60 * 1000).toISOString() };

  const curStr = JSON.stringify(current, null, 2);
  const histStr = JSON.stringify(history);
  const hbStr = JSON.stringify(heartbeat, null, 2);
  fs.writeFileSync('current.json', curStr);
  fs.writeFileSync('heartbeat.json', hbStr);

  if (GITHUB_TOKEN) {
    await publishFile('prices/current.json', curStr, `prices — ${priced} tokens @ epoch ${epoch}`);
    console.log('  ✓ prices/current.json');
    await publishFile('prices/history.json', histStr, `prices history — ${history.raw.length} raw`);
    console.log('  ✓ prices/history.json');
    await publishFile('prices/heartbeat.json', hbStr, 'prices heartbeat');
    console.log('  ✓ prices/heartbeat.json');
  } else {
    console.log('  (no GITHUB_TOKEN — wrote current.json + heartbeat.json locally only)');
  }
  console.log(`\n✅ Done — ${priced} token prices, history tiers updated`);
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
