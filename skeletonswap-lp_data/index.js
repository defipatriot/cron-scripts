const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// =============================================================================
// CONFIGURATION
// =============================================================================

const API_URL = 'https://dex.warlock.backbonelabs.io/api/pools/phoenix-1';

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
const DAILY_HEADERS = 'date,time,pool_id,pool_address,tvl_usd,volume_24h_usd,volume_7d_usd,apr_7d,reserve_0,reserve_1,total_share';
const AGG_HEADERS = 'period,pool_id,pool_address,avg_tvl_usd,total_volume_usd,avg_apr_7d,avg_reserve_0,avg_reserve_1,avg_total_share,snapshot_count';

// =============================================================================
// UTILITIES
// =============================================================================

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse JSON'));
        }
      });
    }).on('error', reject);
  });
}

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

async function runDaily() {
  console.log('\n========== DAILY SNAPSHOT ==========\n');
  
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toISOString().split('T')[1].split('.')[0];
  const dayNum = getDayOfWeek(now);
  const epoch = getEpochNumber(now);
  
  console.log(`Date: ${dateStr} (Day ${dayNum} of week)`);
  console.log(`Time: ${timeStr} UTC`);
  console.log(`Current Epoch: ${epoch}\n`);
  
  // Fetch API
  console.log('Fetching pool data...');
  const data = await fetch(API_URL);
  
  if (!data.pools || !Array.isArray(data.pools)) {
    throw new Error('Invalid API response');
  }
  
  const pools = data.pools;
  console.log(`Found ${pools.length} pools\n`);
  
  // Build CSV content
  let csv = DAILY_HEADERS + '\n';
  
  for (const pool of pools) {
    const row = [
      dateStr,
      timeStr,
      `"${pool.id || ''}"`,
      pool.address || '',
      pool.tvl?.usd?.toFixed(2) || '0',
      pool.volume?.['24h']?.usd?.toFixed(2) || '0',
      pool.volume?.['7d']?.usd?.toFixed(2) || '0',
      pool.apr?.['7d']?.toFixed(4) || '0',
      pool.reserves?.[0]?.amount || '0',
      pool.reserves?.[1]?.amount || '0',
      pool.totalShare || '0'
    ];
    csv += row.join(',') + '\n';
  }
  
  // Save daily file to ROOT with day number (day-1.csv through day-7.csv)
  const filename = `day-${dayNum}.csv`;
  fs.writeFileSync(filename, csv);
  console.log(`Saved: ${filename}`);
  
  // Also calculate and save 6-day rolling average
  await calculate6DayAverage();
  
  return { pools: pools.length, file: filename };
}

// =============================================================================
// 6-DAY ROLLING AVERAGE
// =============================================================================

async function calculate6DayAverage() {
  console.log('\n--- Calculating 6-Day Average ---');
  
  // Read days 1-6 (excluding day 7 which is the oldest)
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
      const poolId = row.pool_id;
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
  
  for (const [poolId, data] of Object.entries(poolData)) {
    const row = [
      '6-day-avg',
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
      const poolId = row.pool_id;
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
  
  for (const [poolId, data] of Object.entries(poolData)) {
    const row = [
      periodStr,
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
      const poolId = row.pool_id;
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
  
  for (const [poolId, data] of Object.entries(poolData)) {
    const row = [
      periodStr,
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
      const poolId = row.pool_id;
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
  
  for (const [poolId, data] of Object.entries(poolData)) {
    const row = [
      periodStr,
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
