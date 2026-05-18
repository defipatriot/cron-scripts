const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// =============================================================================
// CONFIGURATION
// =============================================================================

// -----------------------------------------------------------------------------
// Data sources for the new Skeleton Swap architecture (2026-05-18).
//
// Background: the old bulk endpoint at dex.warlock.backbonelabs.io/api/pools/phoenix-1
// went stale on 2026-04-16 — the API still responds, but every pool's data is
// frozen at the 2026-04-16T17:00:00Z snapshot (verified in HAR trace + repo
// inspection). Skeleton Swap's own front-end migrated to a hybrid architecture
// that queries the chain directly for reserves and ignores warlock for those
// fields. We mirror that approach here.
//
// Fresh fields (computed every run):
//   - reserve_0, reserve_1, total_share  → LCD smart query {"pool":{}}
//   - tvl_usd                            → reserves × prices from network-and-prices cron
//
// Permanently null fields (no longer have a trustworthy source):
//   - volume_24h_usd, volume_7d_usd, apr_7d
//   These would require indexing swap events from chain history.
//   The pre-2026-04-16 backups in this repo are the only volume history we have.
// -----------------------------------------------------------------------------
const POOLS_LIST_URL = 'https://skeletonswap.backbonelabs.io/mainnet/phoenix-1/pools_list.json';
const PRICES_URL = 'https://raw.githubusercontent.com/defipatriot/network-and-prices-data_2026/main/data/network-and-prices.json';
const LCD_URL = process.env.TERRA_LCD || 'https://terra-lcd.publicnode.com';

// Concurrency cap when querying pools in parallel. Public LCD endpoints tolerate
// ~10-15 in-flight requests comfortably; 34 pools at 8 concurrent ≈ 5 batches.
const POOL_QUERY_CONCURRENCY = 8;

// Sandbox / local-testing escape hatch. When set, read pools_list.json from disk
// instead of fetching it (skeletonswap.backbonelabs.io isn't always reachable
// from CI sandboxes). Production on Render leaves this unset and fetches live.
const POOLS_LIST_FIXTURE = process.env.SS_POOLS_LIST_FIXTURE || '';

// GitHub config (set via environment variables)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'defipatriot/ss-pool-data_2026';

// Month names for backup folders
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

// Directories (new structure)
const DIRS = {
  weeklyAvg: './data/weekly-avg',
  monthlyAvg: './data/monthly-avg'
};

// CSV Headers
// Unified daily CSV schema — common columns shared with Astroport for cross-DEX consumption.
// Common prefix: date,time,dex,pool_name,pool_address,tvl_usd,volume_24h_usd
// SS-specific extras after: volume_7d_usd,apr_7d,reserve_0,reserve_1,total_share
const DAILY_HEADERS = 'date,time,dex,pool_name,pool_address,tvl_usd,volume_24h_usd,volume_7d_usd,apr_7d,reserve_0,reserve_1,total_share';

// Aggregate CSV schema — adds data-quality metadata (snapshots_used/expected/has_gaps + period bounds).
// Every row repeats these values for that aggregate (self-describing per row).
const AGG_HEADERS = 'period,period_start,period_end,snapshots_used,snapshots_expected,has_gaps,dex,pool_name,pool_address,avg_tvl_usd,total_volume_usd,avg_apr_7d,avg_reserve_0,avg_reserve_1,avg_total_share,snapshot_count';

// =============================================================================
// UTILITIES
// =============================================================================

// HTTP helper with redirect-following, timeout, headers, and retry.
// Used for all three external calls (pools_list, prices file, LCD smart queries).
function httpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOpts = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      headers: {
        'User-Agent': 'ss-cron/1.0',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers
      },
      timeout: timeoutMs
    };
    const req = https.request(reqOpts, (res) => {
      // Follow redirects (GitHub raw → S3)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(httpRequest(next, { method, headers, body, timeoutMs }));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} from ${url}: ${data.slice(0, 200)}`));
        }
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`Timeout after ${timeoutMs}ms: ${url}`)); });
    if (body) req.write(body);
    req.end();
  });
}

async function fetchJson(url, opts = {}) {
  const { retries = 2 } = opts;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const { body } = await httpRequest(url, opts);
      return JSON.parse(body);
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error(`fetchJson failed after ${retries + 1} attempts: ${lastErr.message}`);
}

// Backward-compat shim — kept in case any other function still calls fetch()
function fetch(url) { return fetchJson(url); }

function ensureDirs() {
  // Create weekly-avg and monthly-avg folders if needed
  Object.values(DIRS).forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`Created directory: ${dir}`);
    } else {
      const files = fs.readdirSync(dir);
      console.log(`Directory ${dir} exists with ${files.length} files`);
    }
  });
}

// Get backup folder name for current month (e.g., "./data/january_backup")
function getBackupFolder() {
  const now = new Date();
  const monthName = MONTH_NAMES[now.getMonth()];
  return `./data/${monthName}_backup`;
}

function run(cmd, ignoreError = false) {
  console.log(`> ${cmd}`);
  try {
    const result = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
    if (result) console.log(result.trim());
    return result;
  } catch (e) {
    if (ignoreError) {
      console.log(`  (ignored: ${e.message})`);
      return '';
    }
    throw e;
  }
}

function setupGit() {
  if (!GITHUB_TOKEN) {
    console.log('No GITHUB_TOKEN - running in local mode');
    return false;
  }
  
  const repoUrl = `https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`;
  
  console.log('Setting up git for repo: ' + GITHUB_REPO);
  
  // Configure git
  run('git config --global user.email "bot@alliancedao.com"', true);
  run('git config --global user.name "Alliance DAO Bot"', true);
  
  // Remove any existing .git and start fresh
  if (fs.existsSync('.git')) {
    console.log('Removing existing .git directory...');
    fs.rmSync('.git', { recursive: true, force: true });
  }
  
  // Clone the repo fresh (this gets all existing files)
  console.log('Cloning repository...');
  try {
    execSync(`git clone ${repoUrl} temp_repo`, { encoding: 'utf8', stdio: 'pipe' });
    console.log('> git clone ***@github.com/' + GITHUB_REPO + '.git temp_repo');
    
    // Move files from temp to current directory
    if (fs.existsSync('temp_repo')) {
      // Copy all files including .git
      execSync('cp -r temp_repo/. .', { encoding: 'utf8', stdio: 'pipe' });
      execSync('rm -rf temp_repo', { encoding: 'utf8', stdio: 'pipe' });
      console.log('Repository cloned and files synced');
    }
  } catch (e) {
    console.log('Clone failed, initializing new repo...');
    run('git init', true);
    execSync(`git remote add origin ${repoUrl}`, { encoding: 'utf8', stdio: 'pipe' });
    run('git checkout -b main', true);
  }
  
  // Verify we have existing daily files in root
  const existingDailyFiles = fs.readdirSync('.').filter(f => f.match(/^day-\d\.csv$/));
  if (existingDailyFiles.length > 0) {
    console.log(`Found ${existingDailyFiles.length} existing daily files`);
  }
  
  console.log('Git setup complete');
  return true;
}

function gitCommitAndPush(message) {
  if (!GITHUB_TOKEN) {
    console.log('No GITHUB_TOKEN - skipping push');
    return;
  }
  
  try {
    // Add root level daily files (day-1.csv through day-7.csv, 6-day-avg.csv)
    run('git add -f day-*.csv', true);
    run('git add -f 6-day-avg.csv', true);
    
    // Add monthly backup folders inside data/ (january_backup, february_backup, etc.)
    run('git add -f data/*_backup/', true);
    
    // Add aggregation folders inside data/
    run('git add -f data/weekly-avg/', true);
    run('git add -f data/monthly-avg/', true);
    
    // Add yearly file at root
    run('git add -f *-yearly.csv', true);
    
    // Add heartbeat file (freshness signal for downstream consumers)
    run('git add -f data/heartbeat.json', true);
    
    // Check if there's anything to commit
    try {
      run(`git commit -m "${message}"`);
    } catch (e) {
      console.log('Nothing new to commit');
      return;
    }
    
    // Push
    console.log('Pushing to GitHub...');
    try {
      execSync('git push origin main', { encoding: 'utf8', stdio: 'pipe' });
      console.log('✓ Successfully pushed to GitHub!');
    } catch (e) {
      console.log('Normal push failed, trying force push...');
      execSync('git push origin main --force', { encoding: 'utf8', stdio: 'pipe' });
      console.log('✓ Force pushed to GitHub!');
    }
  } catch (e) {
    console.log('Git error:', e.message);
  }
}

function parseCSV(content) {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];
  
  const headers = lines[0].split(',');
  const rows = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const row = {};
    headers.forEach((h, idx) => {
      let val = values[idx] || '';
      val = val.replace(/^"|"$/g, ''); // Remove quotes
      row[h.trim()] = val;
    });
    rows.push(row);
  }
  return rows;
}

// =============================================================================
// AGGREGATE METADATA — embedded in every aggregate CSV row so downstream
// consumers can validate data quality without a separate sidecar file.
// =============================================================================
function computeAggMetadata(filesRead, expectedCount) {
  const dates = [];
  for (const f of filesRead) {
    try {
      const content = fs.readFileSync(f, 'utf8');
      const rows = parseCSV(content);
      if (rows.length > 0 && rows[0].date) dates.push(rows[0].date);
    } catch (e) { /* skip unreadable */ }
  }
  dates.sort();
  return {
    period_start: dates[0] || '',
    period_end:   dates[dates.length - 1] || '',
    snapshots_used: filesRead.length,
    snapshots_expected: expectedCount,
    has_gaps: filesRead.length < expectedCount,
  };
}

// Helper to read pool name from a row regardless of legacy or new schema.
// Legacy daily files have `pool_id`; new files have `pool_name`. Same value, different column.
function rowPoolName(row) { return row.pool_name || row.pool_id || ''; }

// =============================================================================
// SKELETON SWAP DATA ACQUISITION (new architecture — replaces stale warlock API)
// =============================================================================

// 1) Load pool metadata (canonical list of active pools + denoms + decimals).
//    Uses the same source the live Skeleton Swap front-end uses.
async function loadPoolsList() {
  if (POOLS_LIST_FIXTURE && fs.existsSync(POOLS_LIST_FIXTURE)) {
    console.log(`  [pools_list] reading from fixture: ${POOLS_LIST_FIXTURE}`);
    return JSON.parse(fs.readFileSync(POOLS_LIST_FIXTURE, 'utf-8'));
  }
  console.log(`  [pools_list] fetching: ${POOLS_LIST_URL}`);
  return await fetchJson(POOLS_LIST_URL, { retries: 2, timeoutMs: 15000 });
}

// 2) Load token prices from our existing network-and-prices cron's output.
//    No new external dependency — reuses the prices we already publish hourly.
async function loadPrices() {
  console.log(`  [prices] fetching: ${PRICES_URL}`);
  return await fetchJson(PRICES_URL, { retries: 2, timeoutMs: 15000 });
}

// 3) Build a fast symbol → USD-price lookup, handling SS's symbol idiosyncrasies
//    and deriving ampROAR from its LST ratio (it's not in token_prices directly).
//
//    SS pool_assets[].symbol → canonical symbol used in network-and-prices.json:
//      - USDt        → USDT          (case)
//      - wstETH      → WSTETH        (case)
//      - EURe        → EURE          (case)
//      - wBTC.osmo   → WBTC          (different bridge, same underlying)
//      - wBTC.axl    → WBTC          (different bridge, same underlying)
//      - ampROAR     → derived: ROAR_usd × lst_ratios.ampROAR.ratio
//      - dATOM       → null (no price source — pool TVL will be null)
function buildPriceLookup(napData) {
  const tokenPrices = napData.token_prices || {};
  const lstRatios = napData.lst_ratios || {};

  // Map of symbols (lowercased) → final_price_usd, with explicit aliases for
  // SS-specific symbol shapes.
  const lookup = {};
  for (const [name, entry] of Object.entries(tokenPrices)) {
    const price = entry?.prices?.astroport?.final_price_usd
      ?? entry?.final_price_usd
      ?? null;
    if (price != null) {
      lookup[name.toLowerCase()] = price;
    }
  }

  // SS symbol aliases pointing at the same canonical price entry.
  const alias = (from, to) => {
    if (lookup[to.toLowerCase()] != null) lookup[from.toLowerCase()] = lookup[to.toLowerCase()];
  };
  alias('usdt',         'USDT');
  alias('wsteth',       'WSTETH');
  alias('eure',         'EURE');
  alias('wbtc.osmo',    'WBTC');
  alias('wbtc.axl',     'WBTC');
  alias('axlusdc',      'USDC');     // Axelar-bridged USDC, par with native USDC
  alias('astro.cw20',   'ASTRO');    // legacy CW20 ASTRO, same underlying token

  // ampROAR derived from ROAR + LST ratio.
  const roarPrice = lookup['roar'];
  const ampRoarRatio = lstRatios['ampROAR']?.ratio;
  if (roarPrice != null && ampRoarRatio != null) {
    lookup['amproar'] = roarPrice * ampRoarRatio;
  }

  return lookup;
}

function priceForSymbol(symbol, lookup) {
  if (!symbol) return null;
  const v = lookup[symbol.toLowerCase()];
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}

// 4) Query one pool's on-chain state via LCD smart-contract query.
//    Returns { reserve_0, reserve_1, total_share } as raw chain strings (no
//    decimal scaling — preserves precision for the CSV's reserve_0/reserve_1
//    columns which have always been raw chain integers).
async function queryPoolChain(swapAddress) {
  const queryB64 = Buffer.from('{"pool":{}}').toString('base64');
  const url = `${LCD_URL}/cosmwasm/wasm/v1/contract/${swapAddress}/smart/${queryB64}`;
  const resp = await fetchJson(url, { retries: 2, timeoutMs: 12000 });
  const d = resp?.data;
  if (!d || !Array.isArray(d.assets) || d.assets.length < 2) {
    throw new Error(`Unexpected pool response shape for ${swapAddress}`);
  }
  return {
    reserve_0: d.assets[0].amount,
    reserve_1: d.assets[1].amount,
    total_share: d.total_share
  };
}

// 5) Compute TVL = (reserve_0 / 10^dec_0) * price_0 + (reserve_1 / 10^dec_1) * price_1
//    Returns { tvl_usd, missing: [symbol,...] } — caller can mark pool as unpriced
//    if any side is missing a price.
function computePoolTvl(poolMeta, chainData, priceLookup) {
  const assets = poolMeta.pool_assets;
  const missing = [];
  let tvl = 0;
  for (let i = 0; i < 2; i++) {
    const a = assets[i];
    const price = priceForSymbol(a.symbol, priceLookup);
    const rawAmount = i === 0 ? chainData.reserve_0 : chainData.reserve_1;
    if (price == null) {
      missing.push(a.symbol);
      continue;
    }
    const amount = Number(rawAmount) / Math.pow(10, a.decimals);
    tvl += amount * price;
  }
  if (missing.length > 0) {
    return { tvl_usd: null, missing };
  }
  return { tvl_usd: Math.round(tvl * 100) / 100, missing: [] };
}

// 6) Concurrency-limited Promise.all replacement for the per-pool chain queries.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (e) {
        results[i] = { ok: false, error: e };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// =============================================================================
// EPOCH CALCULATION (replaces week number)
// =============================================================================

// TLA epochs started 2022-10-31 00:00:00 UTC, each epoch is 7 days
const EPOCH_START = new Date('2022-10-31T00:00:00Z').getTime();
const EPOCH_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

function getEpochNumber(date = new Date()) {
  const timestamp = date.getTime();
  return Math.floor((timestamp - EPOCH_START) / EPOCH_DURATION) + 1;
}

function getDayOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  return day === 0 ? 7 : day; // 1=Monday, 7=Sunday
}

// =============================================================================
// DAILY SNAPSHOT
// =============================================================================

// =============================================================================
// DATA FRESHNESS MONITORING
// =============================================================================
//
// Detects upstream-data-frozen failures (the warlock-style bug where the cron
// runs successfully but always gets the same numbers back). Approach:
//
//   1) Compute a SHA-256 of the run's volatile fields (reserves + total_share
//      across all pools). Excludes timestamps and pool addresses — those
//      always drift even when the underlying data is frozen.
//   2) Fetch our previous heartbeat from GitHub and compare its fingerprint.
//   3) Same fingerprint = 'suspicious'. Suspicious N times in a row = 'stuck'.
//
// Threshold for SS: 2 identical runs → suspicious, 3+ → stuck. LP-share counts
// on Terra change with every deposit/withdraw — even small pools see daily
// movement. Three identical daily runs would be extraordinary.

const STUCK_THRESHOLD = 3;   // 3+ identical consecutive runs → 'stuck'
const HEARTBEAT_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/data/heartbeat.json`;

function computeDataFingerprint(poolsMetadata, chainResults) {
  // Build a deterministic string from the volatile fields only.
  // Order-stable: sort by pool_id so the hash doesn't depend on input order.
  const items = [];
  for (let i = 0; i < poolsMetadata.length; i++) {
    const meta = poolsMetadata[i];
    const res = chainResults[i];
    if (res && res.ok) {
      items.push([meta.pool_id, res.value.reserve_0, res.value.reserve_1, res.value.total_share]);
    } else {
      // Failed pools still contribute (as 'FAIL') so the fingerprint changes
      // when failure patterns change.
      items.push([meta.pool_id, 'FAIL']);
    }
  }
  items.sort((a, b) => a[0].localeCompare(b[0]));
  const input = JSON.stringify(items);
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

// Fetches the previous heartbeat from GitHub raw so we can carry forward the
// 'consecutiveStuckRuns' counter and compare fingerprints. Returns null on any
// error — a missing/unreachable previous heartbeat must NOT fail the cron run.
async function fetchPreviousHeartbeat() {
  try {
    const data = await fetchJson(HEARTBEAT_URL, { retries: 1, timeoutMs: 8000 });
    return data;
  } catch (e) {
    console.log(`  [freshness] no previous heartbeat available (${e.message.slice(0, 60)})`);
    return null;
  }
}

function classifyFreshness(currentFp, prev) {
  if (!prev || !prev.dataFingerprint) {
    return { dataFreshness: 'fresh', consecutiveStuckRuns: 0, previousFingerprint: null };
  }
  const previousFingerprint = prev.dataFingerprint;
  if (currentFp !== previousFingerprint) {
    return { dataFreshness: 'fresh', consecutiveStuckRuns: 0, previousFingerprint };
  }
  // Fingerprint matches previous run. Increment the counter from the previous heartbeat.
  const priorCount = Number(prev.consecutiveStuckRuns) || 1;
  const consecutive = priorCount + 1;
  const dataFreshness = consecutive >= STUCK_THRESHOLD ? 'stuck' : 'suspicious';
  return { dataFreshness, consecutiveStuckRuns: consecutive, previousFingerprint };
}


async function runDaily() {
  console.log('\n========== DAILY SNAPSHOT ==========\n');

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toISOString().split('T')[1].split('.')[0];
  const dayNum = getDayOfWeek(now);
  const epoch = getEpochNumber(now);

  console.log(`Date: ${dateStr} (Day ${dayNum} of week)`);
  console.log(`Time: ${timeStr} UTC`);
  console.log(`Current Epoch: ${epoch}`);
  console.log(`LCD: ${LCD_URL}\n`);

  // -- Step 1: pool metadata -------------------------------------------------
  console.log('Loading pool metadata...');
  const poolsList = await loadPoolsList();
  const pools = poolsList.pools || [];
  if (pools.length === 0) throw new Error('pools_list.json returned zero pools');
  console.log(`  ✓ ${pools.length} active pools\n`);

  // -- Step 2: token prices --------------------------------------------------
  console.log('Loading token prices (from network-and-prices cron)...');
  const napData = await loadPrices();
  const priceLookup = buildPriceLookup(napData);
  console.log(`  ✓ ${Object.keys(priceLookup).length} symbols priced (captured ${napData.capturedAt})\n`);

  // -- Step 3: per-pool chain queries (parallel, bounded) --------------------
  console.log(`Querying chain for ${pools.length} pools (concurrency=${POOL_QUERY_CONCURRENCY})...`);
  const t0 = Date.now();
  const chainResults = await mapWithConcurrency(pools, POOL_QUERY_CONCURRENCY, (p) => queryPoolChain(p.swap_address));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const okCount = chainResults.filter(r => r.ok).length;
  const failCount = chainResults.length - okCount;
  console.log(`  ✓ ${okCount}/${pools.length} pools queried in ${elapsed}s${failCount ? ` (${failCount} failed)` : ''}\n`);

  // -- Step 4: build CSV -----------------------------------------------------
  let csv = DAILY_HEADERS + '\n';
  const unpriced = [];
  const chainFailed = [];
  let tvlSum = 0;

  for (let i = 0; i < pools.length; i++) {
    const meta = pools[i];
    const res = chainResults[i];
    let tvlUsd = '';
    let r0 = '', r1 = '', ts = '';
    if (res.ok) {
      r0 = res.value.reserve_0;
      r1 = res.value.reserve_1;
      ts = res.value.total_share;
      const { tvl_usd, missing } = computePoolTvl(meta, res.value, priceLookup);
      if (tvl_usd != null) {
        tvlUsd = tvl_usd;
        tvlSum += tvl_usd;
      } else {
        unpriced.push({ pool: meta.pool_id, missing });
      }
    } else {
      chainFailed.push({ pool: meta.pool_id, error: res.error.message });
    }

    const row = [
      dateStr,
      timeStr,
      'skeletonswap',
      `"${meta.pool_id}"`,
      meta.swap_address,
      tvlUsd,
      '', // volume_24h_usd — no trustworthy source
      '', // volume_7d_usd  — no trustworthy source
      '', // apr_7d         — no trustworthy source
      r0,
      r1,
      ts
    ].join(',');
    csv += row + '\n';

    const tvlDisplay = (typeof tvlUsd === 'number')
      ? `$${tvlUsd.toLocaleString()}`
      : (res.ok ? 'no-price' : 'CHAIN-FAIL');
    console.log(`  ${meta.pool_id.padEnd(22)} TVL: ${tvlDisplay.padStart(14)}${res.ok ? '' : '  ✗'}`);
  }

  // -- Step 5: summary + write files -----------------------------------------
  console.log(`\n  Total TVL (priced pools): $${tvlSum.toLocaleString()}`);
  if (unpriced.length) {
    console.log(`  Pools without full pricing (${unpriced.length}):`);
    for (const u of unpriced) console.log(`    - ${u.pool} missing: ${u.missing.join(', ')}`);
  }
  if (chainFailed.length) {
    console.log(`  Chain query failures (${chainFailed.length}):`);
    for (const f of chainFailed) console.log(`    - ${f.pool}: ${f.error}`);
  }
  console.log();

  // Save daily file to ROOT (e.g., ./day-1.csv)
  const filename = `day-${dayNum}.csv`;
  const filepath = `./${filename}`;
  fs.writeFileSync(filepath, csv);
  console.log(`Saved: ${filepath}`);

  // Save dated backup to month folder (e.g., ./april_backup/2026-04-18.csv)
  const backupDir = getBackupFolder();
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
    console.log(`Created backup folder: ${backupDir}`);
  }
  const backupFile = path.join(backupDir, `${dateStr}.csv`);
  fs.writeFileSync(backupFile, csv);
  console.log(`Backup saved: ${backupFile}`);

  // If it's Saturday (day 6), calculate 6-day rolling average
  if (dayNum === 6) {
    await calculate6DayAverage();
  }

  // -- Step 6: data freshness check (catches upstream-frozen failures) -------
  console.log('Computing data fingerprint...');
  const dataFingerprint = computeDataFingerprint(pools, chainResults);
  const prevHeartbeat = await fetchPreviousHeartbeat();
  const freshness = classifyFreshness(dataFingerprint, prevHeartbeat);
  const freshnessIcon = { fresh: '✓', suspicious: '⚠', stuck: '🔴' }[freshness.dataFreshness];
  console.log(`  fingerprint: ${dataFingerprint}  previous: ${freshness.previousFingerprint || '(none)'}`);
  console.log(`  ${freshnessIcon} dataFreshness: ${freshness.dataFreshness}` +
              (freshness.consecutiveStuckRuns > 1
                ? `  (${freshness.consecutiveStuckRuns} consecutive identical runs)`
                : ''));
  console.log();

  return {
    pools: pools.length,
    file: filename,
    priced: pools.length - unpriced.length - chainFailed.length,
    unpriced: unpriced.length,
    chainFailed: chainFailed.length,
    tvlSum: Math.round(tvlSum * 100) / 100,
    dataFingerprint,
    previousFingerprint: freshness.previousFingerprint,
    dataFreshness: freshness.dataFreshness,
    consecutiveStuckRuns: freshness.consecutiveStuckRuns
  };
}

// =============================================================================
// 6-DAY ROLLING AVERAGE (runs on Saturday)
// =============================================================================

async function calculate6DayAverage() {
  console.log('\n--- Calculating 6-Day Average ---');
  
  // Read days 1-6 (Monday-Saturday, excluding Sunday which is oldest)
  const dailyFiles = [];
  for (let day = 1; day <= 6; day++) {
    if (fs.existsSync(`./day-${day}.csv`)) {
      dailyFiles.push(`day-${day}.csv`);
    }
  }
  
  if (dailyFiles.length === 0) {
    console.log('  No daily files found yet');
    return;
  }
  
  console.log(`  Using ${dailyFiles.length} daily files`);
  
  // Collect all rows by pool
  const poolData = {};
  
  for (const file of dailyFiles) {
    const content = fs.readFileSync(`./${file}`, 'utf8');
    const rows = parseCSV(content);
    
    for (const row of rows) {
      const poolId = rowPoolName(row);
      if (!poolData[poolId]) {
        poolData[poolId] = {
          pool_address: row.pool_address,
          tvl: [],
          volume: [],
          apr: [],
          reserve_0: [],
          reserve_1: [],
          total_share: []
        };
      }
      
      if (row.tvl_usd) poolData[poolId].tvl.push(parseFloat(row.tvl_usd));
      if (row.volume_24h_usd) poolData[poolId].volume.push(parseFloat(row.volume_24h_usd));
      if (row.apr_7d) poolData[poolId].apr.push(parseFloat(row.apr_7d));
      if (row.reserve_0) poolData[poolId].reserve_0.push(parseFloat(row.reserve_0));
      if (row.reserve_1) poolData[poolId].reserve_1.push(parseFloat(row.reserve_1));
      if (row.total_share) poolData[poolId].total_share.push(parseFloat(row.total_share));
    }
  }
  
  // Build aggregated CSV
  let csv = AGG_HEADERS + '\n';
  
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const sum = arr => arr.reduce((a, b) => a + b, 0);

  // Data-quality metadata — embedded in every row for self-describing aggregates
  const meta = computeAggMetadata(dailyFiles.map(f => `./${f}`), 6);
  
  for (const [poolId, data] of Object.entries(poolData)) {
    const row = [
      '6-day-avg',
      meta.period_start,
      meta.period_end,
      meta.snapshots_used,
      meta.snapshots_expected,
      meta.has_gaps,
      'skeletonswap',
      `"${poolId}"`,
      data.pool_address,
      avg(data.tvl).toFixed(2),
      sum(data.volume).toFixed(2),
      avg(data.apr).toFixed(4),
      avg(data.reserve_0).toFixed(0),
      avg(data.reserve_1).toFixed(0),
      avg(data.total_share).toFixed(0),
      data.tvl.length
    ].join(',');
    csv += row + '\n';
  }
  
  // Save 6-day average file to ROOT
  const avgFile = './6-day-avg.csv';
  fs.writeFileSync(avgFile, csv);
  console.log(`  Saved: ${avgFile}`);
  console.log(`  Pools processed: ${Object.keys(poolData).length}`);
}

// =============================================================================
// WEEKLY AGGREGATION (NOW USES EPOCH)
// =============================================================================

async function runWeekly() {
  console.log('\n========== WEEKLY (EPOCH) AGGREGATION ==========\n');
  
  const now = new Date();
  const year = now.getFullYear();
  const epoch = getEpochNumber(now);
  const periodStr = `${year}-epoch-${epoch}`;
  
  console.log(`Aggregating epoch: ${epoch}`);
  console.log(`Filename: ${periodStr}.csv\n`);
  
  // Read all daily files from ROOT
  const dailyFiles = [];
  for (let day = 1; day <= 7; day++) {
    if (fs.existsSync(`./day-${day}.csv`)) {
      dailyFiles.push(`day-${day}.csv`);
    }
  }
  console.log(`Found ${dailyFiles.length} daily files`);
  
  // Collect all rows by pool
  const poolData = {};
  
  for (const file of dailyFiles) {
    const content = fs.readFileSync(`./${file}`, 'utf8');
    const rows = parseCSV(content);
    
    for (const row of rows) {
      const poolId = rowPoolName(row);
      if (!poolData[poolId]) {
        poolData[poolId] = {
          pool_address: row.pool_address,
          tvl: [],
          volume: [],
          apr: [],
          reserve_0: [],
          reserve_1: [],
          total_share: []
        };
      }
      
      if (row.tvl_usd) poolData[poolId].tvl.push(parseFloat(row.tvl_usd));
      if (row.volume_24h_usd) poolData[poolId].volume.push(parseFloat(row.volume_24h_usd));
      if (row.apr_7d) poolData[poolId].apr.push(parseFloat(row.apr_7d));
      if (row.reserve_0) poolData[poolId].reserve_0.push(parseFloat(row.reserve_0));
      if (row.reserve_1) poolData[poolId].reserve_1.push(parseFloat(row.reserve_1));
      if (row.total_share) poolData[poolId].total_share.push(parseFloat(row.total_share));
    }
  }
  
  // Build aggregated CSV
  let csv = AGG_HEADERS + '\n';
  
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const sum = arr => arr.reduce((a, b) => a + b, 0);

  const meta = computeAggMetadata(dailyFiles.map(f => `./${f}`), 7);  // 7 days in an epoch
  
  for (const [poolId, data] of Object.entries(poolData)) {
    const row = [
      periodStr,
      meta.period_start,
      meta.period_end,
      meta.snapshots_used,
      meta.snapshots_expected,
      meta.has_gaps,
      'skeletonswap',
      `"${poolId}"`,
      data.pool_address,
      avg(data.tvl).toFixed(2),
      sum(data.volume).toFixed(2),
      avg(data.apr).toFixed(4),
      avg(data.reserve_0).toFixed(0),
      avg(data.reserve_1).toFixed(0),
      avg(data.total_share).toFixed(0),
      data.tvl.length
    ].join(',');
    csv += row + '\n';
    
    console.log(`  ${poolId.padEnd(20)} Avg TVL: $${avg(data.tvl).toFixed(2).padStart(10)}  Total Vol: $${sum(data.volume).toFixed(2)}`);
  }
  
  // Save weekly file to weekly-avg folder
  const filename = `${periodStr}.csv`;
  const filepath = path.join(DIRS.weeklyAvg, filename);
  fs.writeFileSync(filepath, csv);
  console.log(`\nSaved: ${filepath}`);
  
  return { pools: Object.keys(poolData).length, file: filename };
}

// =============================================================================
// MONTHLY AGGREGATION
// =============================================================================

async function runMonthly() {
  console.log('\n========== MONTHLY AGGREGATION ==========\n');
  
  const now = new Date();
  // Get previous month
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const year = prevMonth.getFullYear();
  const month = (prevMonth.getMonth() + 1).toString().padStart(2, '0');
  const periodStr = `${year}-${month}`;
  
  console.log(`Aggregating month: ${periodStr}\n`);
  
  // Read epoch files for this year (supports both old W format and new epoch format)
  const weeklyFiles = fs.readdirSync(DIRS.weeklyAvg).filter(f => 
    f.startsWith(`${year}-epoch-`) || f.startsWith(`${year}-W`)
  );
  console.log(`Found ${weeklyFiles.length} weekly/epoch files for ${year}`);
  
  // Determine which epochs belong to this month
  // Calculate epoch range for target month
  const monthStart = new Date(year, parseInt(month) - 1, 1);
  const monthEnd = new Date(year, parseInt(month), 0); // Last day of month
  const epochStart = getEpochNumber(monthStart);
  const epochEnd = getEpochNumber(monthEnd);
  
  console.log(`Month ${month} spans epochs ${epochStart} to ${epochEnd}`);
  
  const relevantFiles = weeklyFiles.filter(f => {
    // Try epoch format first
    const epochMatch = f.match(/(\d{4})-epoch-(\d+)/);
    if (epochMatch) {
      const fileEpoch = parseInt(epochMatch[2]);
      return fileEpoch >= epochStart && fileEpoch <= epochEnd;
    }
    
    // Fall back to old W format
    const weekMatch = f.match(/(\d{4})-W(\d{2})/);
    if (weekMatch) {
      const weekNum = parseInt(weekMatch[2]);
      // Rough estimate: weeks 1-4 = Jan, 5-8 = Feb, etc.
      const estMonth = Math.ceil(weekNum / 4.33);
      return estMonth === parseInt(month);
    }
    
    return false;
  });
  
  console.log(`Using ${relevantFiles.length} files for ${periodStr}`);
  
  // Collect all rows by pool
  const poolData = {};
  
  for (const file of relevantFiles) {
    const content = fs.readFileSync(path.join(DIRS.weeklyAvg, file), 'utf8');
    const rows = parseCSV(content);
    
    for (const row of rows) {
      const poolId = rowPoolName(row);
      if (!poolData[poolId]) {
        poolData[poolId] = {
          pool_address: row.pool_address,
          tvl: [],
          volume: [],
          apr: [],
          reserve_0: [],
          reserve_1: [],
          total_share: [],
          snapshots: 0
        };
      }
      
      if (row.avg_tvl_usd) poolData[poolId].tvl.push(parseFloat(row.avg_tvl_usd));
      if (row.total_volume_usd) poolData[poolId].volume.push(parseFloat(row.total_volume_usd));
      if (row.avg_apr_7d) poolData[poolId].apr.push(parseFloat(row.avg_apr_7d));
      if (row.avg_reserve_0) poolData[poolId].reserve_0.push(parseFloat(row.avg_reserve_0));
      if (row.avg_reserve_1) poolData[poolId].reserve_1.push(parseFloat(row.avg_reserve_1));
      if (row.avg_total_share) poolData[poolId].total_share.push(parseFloat(row.avg_total_share));
      if (row.snapshot_count) poolData[poolId].snapshots += parseInt(row.snapshot_count);
    }
  }
  
  // Build aggregated CSV
  let csv = AGG_HEADERS + '\n';
  
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const sum = arr => arr.reduce((a, b) => a + b, 0);

  // Month spans roughly 4-5 epochs (weekly files); expected count = epochs in this month
  const meta = computeAggMetadata(
    relevantFiles.map(f => path.join(DIRS.weeklyAvg, f)),
    epochEnd - epochStart + 1
  );
  
  for (const [poolId, data] of Object.entries(poolData)) {
    const row = [
      periodStr,
      meta.period_start,
      meta.period_end,
      meta.snapshots_used,
      meta.snapshots_expected,
      meta.has_gaps,
      'skeletonswap',
      `"${poolId}"`,
      data.pool_address,
      avg(data.tvl).toFixed(2),
      sum(data.volume).toFixed(2),
      avg(data.apr).toFixed(4),
      avg(data.reserve_0).toFixed(0),
      avg(data.reserve_1).toFixed(0),
      avg(data.total_share).toFixed(0),
      data.snapshots
    ].join(',');
    csv += row + '\n';
    
    console.log(`  ${poolId.padEnd(20)} Avg TVL: $${avg(data.tvl).toFixed(2).padStart(10)}`);
  }
  
  // Save monthly file to monthly-avg folder
  const filename = `${periodStr}.csv`;
  const filepath = path.join(DIRS.monthlyAvg, filename);
  fs.writeFileSync(filepath, csv);
  console.log(`\nSaved: ${filepath}`);
  
  return { pools: Object.keys(poolData).length, file: filename };
}

// =============================================================================
// YEARLY AGGREGATION
// =============================================================================

async function runYearly() {
  console.log('\n========== YEARLY AGGREGATION ==========\n');
  
  const now = new Date();
  const year = now.getFullYear() - 1; // Previous year
  const periodStr = `${year}`;
  
  console.log(`Aggregating year: ${periodStr}\n`);
  
  // Read monthly files for this year
  const monthlyFiles = fs.readdirSync(DIRS.monthlyAvg).filter(f => f.startsWith(`${year}-`));
  console.log(`Found ${monthlyFiles.length} monthly files for ${year}`);
  
  // Collect all rows by pool
  const poolData = {};
  
  for (const file of monthlyFiles) {
    const content = fs.readFileSync(path.join(DIRS.monthlyAvg, file), 'utf8');
    const rows = parseCSV(content);
    
    for (const row of rows) {
      const poolId = rowPoolName(row);
      if (!poolData[poolId]) {
        poolData[poolId] = {
          pool_address: row.pool_address,
          tvl: [],
          volume: [],
          apr: [],
          reserve_0: [],
          reserve_1: [],
          total_share: [],
          snapshots: 0
        };
      }
      
      if (row.avg_tvl_usd) poolData[poolId].tvl.push(parseFloat(row.avg_tvl_usd));
      if (row.total_volume_usd) poolData[poolId].volume.push(parseFloat(row.total_volume_usd));
      if (row.avg_apr_7d) poolData[poolId].apr.push(parseFloat(row.avg_apr_7d));
      if (row.avg_reserve_0) poolData[poolId].reserve_0.push(parseFloat(row.avg_reserve_0));
      if (row.avg_reserve_1) poolData[poolId].reserve_1.push(parseFloat(row.avg_reserve_1));
      if (row.avg_total_share) poolData[poolId].total_share.push(parseFloat(row.avg_total_share));
      if (row.snapshot_count) poolData[poolId].snapshots += parseInt(row.snapshot_count);
    }
  }
  
  // Build aggregated CSV
  let csv = AGG_HEADERS + '\n';
  
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const sum = arr => arr.reduce((a, b) => a + b, 0);

  // 12 monthly files expected for a full year
  const meta = computeAggMetadata(
    monthlyFiles.map(f => path.join(DIRS.monthlyAvg, f)),
    12
  );
  
  for (const [poolId, data] of Object.entries(poolData)) {
    const row = [
      periodStr,
      meta.period_start,
      meta.period_end,
      meta.snapshots_used,
      meta.snapshots_expected,
      meta.has_gaps,
      'skeletonswap',
      `"${poolId}"`,
      data.pool_address,
      avg(data.tvl).toFixed(2),
      sum(data.volume).toFixed(2),
      avg(data.apr).toFixed(4),
      avg(data.reserve_0).toFixed(0),
      avg(data.reserve_1).toFixed(0),
      avg(data.total_share).toFixed(0),
      data.snapshots
    ].join(',');
    csv += row + '\n';
    
    console.log(`  ${poolId.padEnd(20)} Avg TVL: $${avg(data.tvl).toFixed(2).padStart(10)}`);
  }
  
  // Save yearly file to ROOT
  const filename = `${periodStr}-yearly.csv`;
  const filepath = `./${filename}`;
  fs.writeFileSync(filepath, csv);
  console.log(`\nSaved: ${filepath}`);
  
  return { pools: Object.keys(poolData).length, file: filename };
}

// =============================================================================
// HEARTBEAT — written at end of every successful run
// Provides downstream consumers (page health check) a uniform freshness signal.
// =============================================================================
function writeHeartbeat(mode, result) {
  const now = new Date();
  const epoch = getEpochNumber(now);
  // Approximate next expected run by cadence
  const cadenceMs = {
    daily:   24 * 60 * 60 * 1000,
    weekly:  7 * 24 * 60 * 60 * 1000,
    monthly: 30 * 24 * 60 * 60 * 1000,
    yearly:  365 * 24 * 60 * 60 * 1000,
  }[mode] || 24 * 60 * 60 * 1000;

  // Compose overall status. Tier order (worst wins):
  //   stuck (dataFreshness)  >  chainFailed > 0  >  ok
  // 'suspicious' freshness is reported as a field but does NOT escalate the
  // overall status — one identical run can legitimately happen on quiet pools.
  // Only 3+ consecutive identical runs ('stuck') flips status.
  const chainFailed = result?.chainFailed ?? 0;
  const freshness = result?.dataFreshness ?? 'fresh';
  let status;
  if (freshness === 'stuck')      status = 'stuck';
  else if (chainFailed > 0)       status = 'partial';
  else                            status = 'ok';

  const heartbeat = {
    schemaVersion: 1,
    cron: 'skeletonswap-lp_data',
    capturedAt: now.toISOString(),
    capturedAtUnix: now.getTime(),
    runId: `ss-${now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
    runMode: mode,
    currentEpoch: epoch,
    status,
    stats: {
      poolsProcessed: result?.pools ?? null,
      poolsPriced:    result?.priced ?? null,
      poolsUnpriced:  result?.unpriced ?? null,
      poolsChainFailed: result?.chainFailed ?? null,
      tvlSumUsd:      result?.tvlSum ?? null,
      fileWritten:    result?.file ?? null,
    },
    // Freshness-monitoring fields (catches warlock-style upstream freezes)
    dataFingerprint:       result?.dataFingerprint ?? null,
    previousFingerprint:   result?.previousFingerprint ?? null,
    dataFreshness:         result?.dataFreshness ?? null,
    consecutiveStuckRuns:  result?.consecutiveStuckRuns ?? 0,
    next_expected_run_at: new Date(now.getTime() + cadenceMs).toISOString(),
  };
  // Ensure data/ exists then write
  if (!fs.existsSync('data')) fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/heartbeat.json', JSON.stringify(heartbeat, null, 2));
  console.log(`📍 Heartbeat written: data/heartbeat.json (mode=${mode}, epoch=${epoch}, status=${status}, freshness=${freshness})`);
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const mode = process.argv[2] || 'daily';
  
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║  SkeletonSwap Pool Snapshot            ║`);
  console.log(`║  Mode: ${mode.padEnd(31)}║`);
  console.log(`║  Time: ${new Date().toISOString().padEnd(31)}║`);
  console.log(`║  Epoch: ${getEpochNumber().toString().padEnd(30)}║`);
  console.log(`╚════════════════════════════════════════╝`);
  
  try {
    // Setup
    setupGit();
    ensureDirs();
    
    // Run appropriate mode
    let result;
    switch (mode) {
      case 'daily':
        result = await runDaily();
        break;
      case 'weekly':
        result = await runWeekly();
        break;
      case 'monthly':
        result = await runMonthly();
        break;
      case 'yearly':
        result = await runYearly();
        break;
      default:
        throw new Error(`Unknown mode: ${mode}`);
    }
    
    // Write freshness signal — done AFTER the mode succeeded, BEFORE git push
    // so the heartbeat is committed in the same push as the data files.
    writeHeartbeat(mode, result);
    
    // Commit to GitHub
    gitCommitAndPush(`${mode} snapshot: ${result.file}`);
    
    console.log(`\n✓ Complete! Processed ${result.pools} pools.`);
    process.exit(0);
    
  } catch (error) {
    console.error(`\n✗ Error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
