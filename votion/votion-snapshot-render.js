const https = require('https');
const fs = require('fs');

// ============================================================
// CONFIGURATION
// ============================================================

const VOTION_API_BASE = 'https://backend.erisprotocol.com/votion/liquidity-alliance';

const LOCKUPS = [
    { id: 'arbluna-max', type: 'arbLUNA', duration: 'Max', multiplier: 10 },
    { id: 'ampluna-max', type: 'ampLUNA', duration: 'Max', multiplier: 10 },
    { id: 'arbluna-12', type: 'arbLUNA', duration: '3mo', multiplier: 2 },
    { id: 'ampluna-12', type: 'ampLUNA', duration: '3mo', multiplier: 2 },
    { id: 'arbluna-1', type: 'arbLUNA', duration: '1wk', multiplier: 1 },
    { id: 'ampluna-1', type: 'ampLUNA', duration: '1wk', multiplier: 1 },
];

// GitHub config from environment
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'defipatriot/tla-ext_json_storage';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Failed to parse JSON from ${url}`));
                }
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
                'User-Agent': 'Votion-Snapshot-Bot',
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data || '{}') });
                } catch (e) {
                    resolve({ status: res.statusCode, data: {} });
                }
            });
        });

        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function pushToGithub(filepath, content, message) {
    const path = `/repos/${GITHUB_REPO}/contents/${filepath}`;
    
    // Check if file exists to get SHA
    const existing = await githubApiRequest('GET', path);
    const sha = existing.data?.sha;
    
    const body = {
        message: message,
        content: Buffer.from(content).toString('base64'),
        branch: GITHUB_BRANCH
    };
    
    if (sha) {
        body.sha = sha;
    }
    
    const result = await githubApiRequest('PUT', path, body);
    
    if (result.status === 200 || result.status === 201) {
        console.log(`✅ Pushed to GitHub: ${filepath}`);
        return true;
    } else {
        console.error(`❌ GitHub push failed: ${result.status}`, result.data?.message);
        return false;
    }
}

// ============================================================
// MAIN SNAPSHOT FUNCTION
// ============================================================

async function captureVotionSnapshot() {
    const timestamp = new Date().toISOString();
    console.log(`\n📸 Votion Epoch Snapshot`);
    console.log(`   Time: ${timestamp}\n`);
    
    const snapshot = {
        capturedAt: timestamp,
        capturedAtUnix: Date.now(),
        period: null,
        voteBefore: null,
        totalExpectedRewards: 0,
        lockups: {}
    };
    
    let successCount = 0;
    
    // Fetch all lockups
    for (const lockup of LOCKUPS) {
        const url = `${VOTION_API_BASE}/${lockup.id}/optimization`;
        console.log(`   Fetching ${lockup.type} ${lockup.duration}...`);
        
        try {
            const data = await fetchJson(url);
            
            if (data && data.period) {
                // Store the full optimization data
                snapshot.lockups[lockup.id] = {
                    type: lockup.type,
                    duration: lockup.duration,
                    multiplier: lockup.multiplier,
                    period: parseInt(data.period),
                    voteBefore: data.voteBefore,
                    calculated: data.calculated,
                    votingPower: data.optimizations?.[0]?.votingPower || 0,
                    totalExpectedReward: data.summary?.totalExpectedReward || 0,
                    optimizations: data.optimizations?.map(opt => ({
                        bucket: opt.id,
                        votingPower: opt.votingPower,
                        expectedRewards: opt.optimization?.totalExpectedReward || 0,
                        isWorthChanging: opt.diff?.isWorthChanging || false,
                        potentialGain: opt.diff?.rewardLoss || 0,
                        deviation: opt.diff?.totalDeviation || "0",
                        message: opt.diff?.message || "",
                        activeVoted: opt.activeVoted || {},
                        newVoted: opt.newVoted || {},
                        pools: opt.meta?.votes?.map(v => ({
                            address: v.id,
                            name: v.title
                        })) || []
                    })) || []
                };
                
                // Capture period from first successful fetch
                if (!snapshot.period) {
                    snapshot.period = parseInt(data.period);
                    snapshot.voteBefore = data.voteBefore;
                }
                
                snapshot.totalExpectedRewards += data.summary?.totalExpectedReward || 0;
                successCount++;
                
                const vp = data.optimizations?.[0]?.votingPower || 0;
                const rewards = data.summary?.totalExpectedReward || 0;
                console.log(`      ✓ VP: ${vp.toLocaleString()}, Expected: $${rewards.toFixed(2)}`);
            } else {
                snapshot.lockups[lockup.id] = null;
                console.log(`      ⊘ No position or empty response`);
            }
        } catch (err) {
            console.error(`      ✗ Error: ${err.message}`);
            snapshot.lockups[lockup.id] = null;
        }
    }
    
    console.log(`\n   Summary:`);
    console.log(`   - Period: ${snapshot.period}`);
    console.log(`   - Lockups with positions: ${successCount}/${LOCKUPS.length}`);
    console.log(`   - Total Expected Rewards: $${snapshot.totalExpectedRewards.toFixed(2)}`);
    console.log(`   - Vote Before: ${snapshot.voteBefore}`);
    
    // Push to GitHub
    if (GITHUB_TOKEN && snapshot.period) {
        const filename = `votion/votion-epoch-${snapshot.period}.json`;
        const content = JSON.stringify(snapshot, null, 2);
        const message = `📸 Votion epoch ${snapshot.period} snapshot - ${timestamp.split('T')[0]}`;
        
        console.log(`\n   Pushing to GitHub...`);
        await pushToGithub(filename, content, message);
    } else if (!GITHUB_TOKEN) {
        console.log(`\n   ⚠️ GITHUB_TOKEN not set - skipping push`);
        // Save locally for testing
        const filename = `votion-epoch-${snapshot.period || 'test'}.json`;
        fs.writeFileSync(filename, JSON.stringify(snapshot, null, 2));
        console.log(`   Saved locally: ${filename}`);
    }
    
    console.log(`\n✅ Snapshot complete!\n`);
    return snapshot;
}

// ============================================================
// RUN
// ============================================================

captureVotionSnapshot()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('❌ Snapshot failed:', err);
        process.exit(1);
    });
