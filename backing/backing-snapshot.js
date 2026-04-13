const https = require('https');

// ============================================================
// CONFIGURATION
// ============================================================

// NFT contract — query any unbroken NFT to get the shared rewards attribute
const NFT_CONTRACT   = 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9';
const SAMPLE_NFT_ID  = '9068';  // Any unbroken NFT — rewards attribute is shared across all

// Eris Protocol ampLUNA hub — for ampLUNA → LUNA exchange rate
const AMPLUNA_HUB    = 'terra10788fkzah89xrdm27zkj5yvhj9x3494lxawzm5qq3vvxcqz2yzaqyd3enk';

const LCD            = 'https://terra.publicnode.com';

// GitHub config from environment
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_REPO    = process.env.GITHUB_REPO   || 'defipatriot/backing-data_2026';
const GITHUB_BRANCH  = process.env.GITHUB_BRANCH || 'main';

const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

// ============================================================
// HELPERS
// ============================================================

function fmtDate(d) { return d.toISOString().slice(0, 10); }

function isLastDayOfMonth(d) {
    const next = new Date(d);
    next.setUTCDate(d.getUTCDate() + 1);
    return next.getUTCMonth() !== d.getUTCMonth();
}

function b64(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64'); }

function fetchJsonLcd(path) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: LCD.replace('https://', ''),
            path,
            method: 'GET',
            headers: { 'User-Agent': 'Backing-Snapshot-Bot', 'Accept': 'application/json' }
        };
        https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`LCD ${res.statusCode} for ${path}`));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
            });
        }).on('error', reject);
    });
}

function githubApiRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path, method,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent':    'Backing-Snapshot-Bot',
                'Accept':        'application/vnd.github.v3+json',
                'Content-Type':  'application/json'
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

async function pushToGithub(filePath, content, message) {
    const encoded = Buffer.from(content).toString('base64');
    const getRes  = await githubApiRequest('GET', `/repos/${GITHUB_REPO}/contents/${filePath}`);
    const sha     = getRes.data?.sha;
    const body    = { message, content: encoded, branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    const putRes = await githubApiRequest('PUT', `/repos/${GITHUB_REPO}/contents/${filePath}`, body);
    if (putRes.status !== 200 && putRes.status !== 201) {
        throw new Error(`GitHub push failed for ${filePath}: ${putRes.status}`);
    }
    console.log(`   ✅ ${putRes.status === 201 ? 'Created' : 'Updated'}: ${filePath}`);
    return putRes;
}

async function getFileFromGithub(filePath) {
    const res = await githubApiRequest('GET', `/repos/${GITHUB_REPO}/contents/${filePath}`);
    if (!res.data?.sha) return null;
    return JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
}

// ============================================================
// FETCH BACKING DATA
// ============================================================

async function fetchAmpLunaPerNft() {
    // Query the NFT contract — rewards attribute is shared across all unbroken NFTs
    const query = b64({ all_nft_info: { token_id: SAMPLE_NFT_ID } });
    const path  = `/cosmwasm/wasm/v1/contract/${NFT_CONTRACT}/smart/${query}`;
    const data  = await fetchJsonLcd(path);

    const attributes = data?.data?.info?.extension?.attributes || [];
    const rewardsAttr = attributes.find(a => a.trait_type === 'rewards');
    if (!rewardsAttr?.value) throw new Error('rewards attribute not found in NFT contract response');

    const ampLunaPerNft = parseFloat(rewardsAttr.value) / 1_000_000;
    console.log(`   ampLUNA per NFT:  ${ampLunaPerNft.toFixed(6)} ampLUNA`);
    return ampLunaPerNft;
}

async function fetchAmpLunaRate() {
    // Query Eris Protocol hub for ampLUNA → LUNA exchange rate
    const query = b64({ exchange_rates: {} });
    const path  = `/cosmwasm/wasm/v1/contract/${AMPLUNA_HUB}/smart/${query}`;
    const data  = await fetchJsonLcd(path);

    const rates = data?.data?.exchange_rates;
    if (!rates?.length) throw new Error('exchange_rates not found in Eris hub response');

    // exchange_rates is an array of [denom, rate] pairs — first entry is uluna rate
    const rate = parseFloat(rates[0][1]);
    if (isNaN(rate)) throw new Error(`Invalid exchange rate: ${rates[0][1]}`);

    console.log(`   ampLUNA → LUNA:   ${rate.toFixed(6)}`);
    return rate;
}

// ============================================================
// MAIN
// ============================================================

async function captureSnapshot() {
    const now     = new Date();
    const dateStr = fmtDate(now);
    const dow     = now.getUTCDay();
    const dayName = DAY_NAMES[dow];

    console.log(`\n🌕 Backing-in-LUNA Snapshot`);
    console.log(`   Time:  ${now.toISOString()}`);
    console.log(`   Date:  ${dateStr}  (${dayName})`);
    console.log(`   Repo:  ${GITHUB_REPO}\n`);

    // Fetch both values in parallel
    console.log('   Querying Terra LCD...');
    const [ampLunaPerNft, ampLunaToLunaRate] = await Promise.all([
        fetchAmpLunaPerNft(),
        fetchAmpLunaRate()
    ]);

    const backingInLuna = parseFloat((ampLunaPerNft * ampLunaToLunaRate).toFixed(6));

    console.log(`   ─────────────────────────────`);
    console.log(`   Backing per NFT: ${backingInLuna.toFixed(4)} LUNA`);

    const snapshot = {
        timestamp:       now.toISOString(),
        date:            dateStr,
        dayName,
        ampLunaPerNft:   parseFloat(ampLunaPerNft.toFixed(6)),
        ampLunaRate:     parseFloat(ampLunaToLunaRate.toFixed(6)),
        backingInLuna
    };

    if (!GITHUB_TOKEN) {
        console.log('\n   ⚠️  GITHUB_TOKEN not set — logging locally');
        console.log(JSON.stringify(snapshot, null, 2));
        return;
    }

    // ── Load index ─────────────────────────────────────────────────────────
    const indexPath = 'snapshots/index.json';
    let index;
    try { index = await getFileFromGithub(indexPath); } catch(e) { index = null; }
    if (!index) index = { latest: null, daily: {}, history: [] };

    // ── 1. Permanent dated daily file ─────────────────────────────────────
    const dailyPath = `snapshots/daily/${dateStr}.json`;
    await pushToGithub(dailyPath, JSON.stringify(snapshot, null, 2),
        `🌕 Backing snapshot ${dateStr}`);
    index.latest = dateStr;

    // ── 2. Permanent history entry ──────────────────────────────────────────
    const histEntry = {
        date:            dateStr,
        backingInLuna,
        ampLunaPerNft:   snapshot.ampLunaPerNft,
        ampLunaRate:     snapshot.ampLunaRate
    };
    const existsIdx = index.history.findIndex(e => e.date === dateStr);
    if (existsIdx >= 0) Object.assign(index.history[existsIdx], histEntry);
    else index.history.push(histEntry);
    index.history.sort((a, b) => a.date.localeCompare(b.date));

    // ── 3. Weekly (Sunday) ──────────────────────────────────────────────────
    if (dow === 0) {
        await pushToGithub(`snapshots/weekly/${dateStr}.json`,
            JSON.stringify(snapshot, null, 2),
            `🌕 Backing weekly snapshot (${dateStr})`);
        console.log(`   ✅ Weekly ${dateStr} saved`);
    }

    // ── 4. Monthly (last day of month) ──────────────────────────────────────
    if (isLastDayOfMonth(now)) {
        await pushToGithub(`snapshots/monthly/${dateStr}.json`,
            JSON.stringify(snapshot, null, 2),
            `🌕 Backing monthly snapshot (${dateStr})`);
        console.log(`   ✅ Monthly ${dateStr} saved`);
    }

    // ── 5. Update index ─────────────────────────────────────────────────────
    await pushToGithub(indexPath, JSON.stringify(index, null, 2),
        `🌕 Update backing index (${dateStr})`);

    // ── 6. Log daily gain vs yesterday ─────────────────────────────────────
    if (index.history.length >= 2) {
        const prev = index.history[index.history.length - 2];
        const gain = backingInLuna - prev.backingInLuna;
        console.log(`\n   vs yesterday (${prev.date}):  ${gain >= 0 ? '+' : ''}${gain.toFixed(6)} LUNA/NFT`);
    }

    console.log(`\n✅ Snapshot complete — ${backingInLuna.toFixed(4)} LUNA/NFT\n`);
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
