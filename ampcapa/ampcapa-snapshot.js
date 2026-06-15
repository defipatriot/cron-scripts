const https = require('https');

// ============================================================
// CONFIGURATION
// ============================================================

const LCD              = 'https://terra-lcd.publicnode.com';
const STAKING_CONTRACT = 'terra186rpfczl7l2kugdsqqedegl4es4hp624phfc7ddy8my02a4e8lgq5rlx7y';
const VE3_CONTRACT     = 'terra1zly98gvcec54m3caxlqexce7rus6rzgplz7eketsdz7nh750h2rqvu8uzx';
const VOTING_MODULE    = 'terra1juj3ymejnug9p92upphcq0prq4e0hpw6rcu20njf8tk7n9sl2wxqldr0mt';
const AMPCAPA_DENOM    = 'factory/terra186rpfczl7l2kugdsqqedegl4es4hp624phfc7ddy8my02a4e8lgq5rlx7y/ampCAPA';
const EPOCH_SCHEDULE_URL = 'https://raw.githubusercontent.com/defipatriot/tla_json_storage/main/epoch_1-300_date.json';

// GitHub config from environment
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/ampcapa-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'ampCAPA-Snapshot-Bot' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`Failed to parse JSON from ${url}`)); }
            });
        }).on('error', reject);
    });
}

function githubApiRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: path,
            method: method,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent': 'ampCAPA-Snapshot-Bot',
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data || '{}') }); }
                catch (e) { resolve({ status: res.statusCode, data: {} }); }
            });
        });

        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function pushToGithub(filepath, content, message) {
    const path = `/repos/${GITHUB_REPO}/contents/${filepath}`;

    // Get existing SHA if file already exists (required to overwrite)
    const existing = await githubApiRequest('GET', path);
    const sha = existing.data?.sha;

    const body = {
        message: message,
        content: Buffer.from(content).toString('base64'),
        branch: GITHUB_BRANCH
    };
    if (sha) body.sha = sha;

    const result = await githubApiRequest('PUT', path, body);

    if (result.status === 200 || result.status === 201) {
        console.log(`   ✅ Pushed: ${filepath}`);
        return true;
    } else {
        console.error(`   ❌ Push failed (${result.status}): ${filepath}`, result.data?.message);
        return false;
    }
}

// ============================================================
// DATE UTILITIES
// ============================================================

const pad2      = n => String(n).padStart(2, '0');
const fmtDate   = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function isLastDayOfMonth(date) {
    const tomorrow = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
    return tomorrow.getUTCMonth() !== date.getUTCMonth();
}

function findEpochEndingOn(schedule, dateStr) {
    return schedule.find(e => e.end_time.slice(0, 10) === dateStr) || null;
}

function findCurrentEpoch(schedule, date) {
    const t = date.getTime();
    return schedule.find(e => {
        const s  = new Date(e.start_time).getTime();
        const en = new Date(e.end_time).getTime();
        return t >= s && t < en;
    }) || null;
}

// ============================================================
// TERRA LCD QUERIES
// ============================================================

function queryContract(contractAddress, query) {
    const encoded = Buffer.from(JSON.stringify(query)).toString('base64');
    const url = `${LCD}/cosmwasm/wasm/v1/contract/${contractAddress}/smart/${encoded}`;
    return fetchJson(url).then(json => json.data !== undefined ? json.data : json);
}

async function fetchRates() {
    console.log('\n   Fetching exchange rates...');

    const stateData   = await queryContract(STAKING_CONTRACT, { state: {} });
    const rateStaking = parseFloat(stateData.exchange_rate);
    console.log(`      ampCAPA→CAPA: ${rateStaking}`);

    const ve3q    = { exchange_rates: { assets: [['single', { native: AMPCAPA_DENOM }]], limit: 1 } };
    const ve3Data = await queryContract(VE3_CONTRACT, ve3q);
    const rates   = ve3Data[0]?.exchange_rates;
    if (!rates?.length) throw new Error('No ve3 exchange rate returned');
    const latest  = rates.sort((a, b) => b[0] - a[0])[0];
    const rateVe3 = parseFloat(latest[1].exchange_rate);
    console.log(`      ampLP→ampCAPA: ${rateVe3}`);

    return { rateStaking, rateVe3 };
}

async function fetchAllStakers(rateStaking, rateVe3) {
    console.log('\n   Fetching all DAO stakers...');
    const all = [];
    let startAfter = null;
    const LIMIT = 30;

    for (let page = 1; ; page++) {
        const query = startAfter
            ? { list_stakers: { limit: LIMIT, start_after: startAfter } }
            : { list_stakers: { limit: LIMIT } };

        const data  = await queryContract(VOTING_MODULE, query);
        const batch = data.stakers || [];
        console.log(`      Page ${page}: ${batch.length} stakers (total: ${all.length + batch.length})`);

        for (const s of batch) {
            const raw     = parseFloat(s.balance);
            const ampLP   = raw / 1_000_000;
            const ampCapa = ampLP * rateVe3;
            const capa    = ampCapa * rateStaking;
            all.push({
                address:    s.address,
                rawBalance: raw,
                ampLP:      parseFloat(ampLP.toFixed(6)),
                ampCapa:    parseFloat(ampCapa.toFixed(6)),
                capa:       parseFloat(capa.toFixed(6))
            });
        }

        if (batch.length < LIMIT) break;
        startAfter = batch[batch.length - 1].address;
    }

    // Sort by CAPA descending, calculate VP%
    all.sort((a, b) => b.capa - a.capa);
    const totalRaw = all.reduce((s, m) => s + m.rawBalance, 0);
    all.forEach(m => {
        m.vpPct = totalRaw > 0 ? parseFloat(((m.rawBalance / totalRaw) * 100).toFixed(4)) : 0;
    });

    return all;
}

// ============================================================
// MAIN SNAPSHOT FUNCTION
// ============================================================

async function captureSnapshot() {
    const now     = new Date();
    const dateStr = fmtDate(now);
    const dow     = now.getUTCDay();   // 0=Sun … 6=Sat
    const dayName = DAY_NAMES[dow];

    console.log(`\n📸 ampCAPA DAO Member Snapshot`);
    console.log(`   Time:    ${now.toISOString()}`);
    console.log(`   Date:    ${dateStr}  (${dayName})`);
    console.log(`   Repo:    ${GITHUB_REPO}`);

    // Load epoch schedule
    console.log('\n   Fetching epoch schedule...');
    const epochSchedule = await fetchJson(EPOCH_SCHEDULE_URL);
    const currentEpoch  = findCurrentEpoch(epochSchedule, now);
    console.log(`      Current epoch: ${currentEpoch?.epoch ?? 'unknown'}`);

    // Fetch blockchain data
    const { rateStaking, rateVe3 } = await fetchRates();
    const members = await fetchAllStakers(rateStaking, rateVe3);

    const totalCapa = members.reduce((s, m) => s + m.capa, 0);

    console.log(`\n   Summary:`);
    console.log(`   - Total members:   ${members.length}`);
    console.log(`   - Active stakers:  ${members.filter(m => m.rawBalance > 0).length}`);
    console.log(`   - Total CAPA:      ${totalCapa.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);

    const snapshot = {
        meta: {
            timestamp:  now.toISOString(),
            date:       dateStr,
            dayName,
            epoch:      currentEpoch?.epoch      ?? null,
            epochStart: currentEpoch?.start_time ?? null,
            epochEnd:   currentEpoch?.end_time   ?? null
        },
        rates: { rateStaking, rateVe3 },
        summary: {
            totalMembers:  members.length,
            activeStakers: members.filter(m => m.rawBalance > 0).length,
            totalCapa:     parseFloat(totalCapa.toFixed(2))
        },
        members
    };

    if (!GITHUB_TOKEN) {
        console.log('\n   ⚠️  GITHUB_TOKEN not set — skipping push');
        const fs = require('fs');
        fs.writeFileSync(`snapshot-test-${dateStr}.json`, JSON.stringify(snapshot, null, 2));
        console.log(`   Saved locally for testing.`);
        return;
    }

    // ── Load current index ────────────────────────────────────────────────────
    const indexPath = 'snapshots/index.json';
    const indexRes  = await githubApiRequest('GET', `/repos/${GITHUB_REPO}/contents/${indexPath}`);
    const index     = indexRes.data?.sha
        ? JSON.parse(Buffer.from(indexRes.data.content, 'base64').toString('utf8'))
        : { latest_daily: null, daily: {}, weekly: [], monthly: [] };

    console.log('\n   Pushing to GitHub...');

    // ── 1. Daily — overwrite the day-of-week file (max 7 files) ──────────────
    const dailyPath = `snapshots/daily/${dayName}.json`;
    const dailyMsg  = `📸 Daily snapshot ${dayName} (${dateStr})`;
    await pushToGithub(dailyPath, JSON.stringify(snapshot, null, 2), dailyMsg);
    index.daily[dayName] = dateStr;
    index.latest_daily   = dateStr;

    // ── 2. Weekly — permanent file on Sunday, named by epoch + date ──────────
    if (dow === 0) {
        const endingEpoch = findEpochEndingOn(epochSchedule, dateStr);
        const epochNum    = endingEpoch?.epoch ?? currentEpoch?.epoch ?? 'unknown';
        const weeklyKey   = `epoch-${epochNum}-${dateStr}`;
        const weeklyPath  = `snapshots/weekly/${weeklyKey}.json`;
        const weeklyData  = { ...snapshot, meta: { ...snapshot.meta, type: 'weekly', weeklyKey } };
        const weeklyMsg   = `📸 Weekly snapshot epoch-${epochNum} (${dateStr})`;
        await pushToGithub(weeklyPath, JSON.stringify(weeklyData, null, 2), weeklyMsg);
        if (!index.weekly.includes(weeklyKey)) index.weekly.push(weeklyKey);
        console.log(`   ✅ Weekly epoch-${epochNum} saved permanently`);
    }

    // ── 3. Monthly — permanent file on last day of month ─────────────────────
    if (isLastDayOfMonth(now)) {
        const monthlyPath = `snapshots/monthly/${dateStr}.json`;
        const monthlyData = { ...snapshot, meta: { ...snapshot.meta, type: 'monthly' } };
        const monthlyMsg  = `📸 Monthly snapshot end of month (${dateStr})`;
        await pushToGithub(monthlyPath, JSON.stringify(monthlyData, null, 2), monthlyMsg);
        if (!index.monthly.includes(dateStr)) index.monthly.push(dateStr);
        console.log(`   ✅ Monthly ${dateStr} saved permanently`);
    }

    // ── 4. Update index ───────────────────────────────────────────────────────
    const indexContent = JSON.stringify(index, null, 2);
    const indexMsg     = `📸 Update snapshot index (${dateStr})`;
    await pushToGithub(indexPath, indexContent, indexMsg);

    // ── 5. Heartbeat — so System Health can monitor this cron ────────────────
    const heartbeat = {
        schemaVersion: 1,
        cron: 'ampcapa',
        capturedAt: new Date().toISOString(),
        capturedAtUnix: Date.now(),
        status: 'ok',
        next_expected_run_at: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(),
        stats: {
            latest_daily: index.latest_daily || dateStr,
        },
    };
    await pushToGithub('snapshots/heartbeat.json', JSON.stringify(heartbeat, null, 2), `heartbeat ok (${dateStr})`);
    console.log('   ✅ Pushed: snapshots/heartbeat.json');

    console.log(`\n✅ Snapshot complete!\n`);
}

// ============================================================
// RUN
// ============================================================

captureSnapshot()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('❌ Snapshot failed:', err);
        process.exit(1);
    });
