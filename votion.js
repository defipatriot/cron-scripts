// =============================================================================
// Votion Snapshot Cron — v2 (rich shape)
// =============================================================================
//
// Captures a weekly Votion epoch snapshot in the SAME shape the live tool produces:
//
//   {
//     capturedAt, capturedAtUnix, period, voteBefore, schemaVersion: 2,
//     ratios:   { arbLUNA: <number>, ampLUNA: <number> },
//     prices:   { LUNA_USD: <number>, source: 'coingecko', fetchedAt: ... },
//     total_vp: <number>,
//     lockups:  [ { type, duration, multiplier, amount, luna, vp, usd,
//                   lockApy, lstApy, votionApy, period, expectedRewards,
//                   buckets: [ { name, expectedRewards, isWorthChanging,
//                                potentialGain, pools: [ { name, current,
//                                optimized, change, address } ] } ],
//                   fetchedFromApi: true, fetchedAt } ],
//     pools:    { '<LP-name>|Astroport': { current_vp, optimized_vp,
//                                          current_pct, optimized_pct,
//                                          bucket, lockup_contributions: [...] } },
//     fetchErrors: {                            // per-lockup capture status
//       <lockupId>: 'reason'                    // omitted on success
//     }
//   }
//
// Why this shape:
//   - Total VP captured ONCE per lockup (not repeated across 4 bucket entries
//     as in the old shape — that was the raw Eris response, which had each
//     bucket include the lockup's total VP).
//   - USD value + APY decomposition captured at snapshot time so future
//     scripts don't have to retroactively figure out the LUNA price for any
//     given Sunday-23:55 capture.
//   - Pool-level rollup (votion.pools) lets dashboards show "which pools
//     have the most VP" without re-aggregating from per-lockup data on read.
//   - `current` vs `optimized` is the user's actual vote vs Eris's
//     optimizer recommendation, captured together so we can answer
//     "did the user follow the optimizer this epoch?" later.
//
// Capture timing: Sunday 23:55 UTC (cron schedule), 4 minutes before the
// epoch flips at 23:59. The Eris API serves the current-period
// optimization until the flip; calling it 4 minutes early gets the final
// state of the epoch about to close.
//
// Sources fetched (no DOM, plain Node fetch):
//   1. backend.erisprotocol.com /votion/liquidity-alliance/{lockup}/optimization
//      (6 calls — one per lockup config, staggered 500ms apart)
//   2. terra.publicnode.com /cosmwasm/wasm/v1/contract/{lst-hub}/smart/{query}
//      (3 calls — arbLUNA + ampLUNA exchange rate hubs)
//   3. api.coingecko.com /coins/terra-luna-2 (1 call — LUNA USD price)
//
// All steps are best-effort with per-source error capture. A LUNA-price
// fetch failure does NOT block the lockup snapshot; the resulting blob
// will have `prices.error` set and `usd` fields will be 0 for that
// snapshot. Better to have a partial snapshot with metadata than no
// snapshot at all.
//
// Runtime: Node 18+ (uses built-in `fetch`).
// =============================================================================

const https = require('https');
const fs = require('fs');

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------

const ERIS_VOTION_BASE = 'https://backend.erisprotocol.com/votion/liquidity-alliance';
const TERRA_LCD        = 'https://terra.publicnode.com';
const COINGECKO_LUNA   = 'https://api.coingecko.com/api/v3/simple/price?ids=terra-luna-2&vs_currencies=usd';

// Lockup configs match the tool's VOTION_LOCKUPS array exactly. multiplier
// is what Eris uses to scale amount → VP. duration is human-readable
// (the API ID encodes the duration too — see id field).
const LOCKUPS = [
    { id: 'arbluna-max', type: 'arbLUNA', duration: 'Max', multiplier: 10 },
    { id: 'ampluna-max', type: 'ampLUNA', duration: 'Max', multiplier: 10 },
    { id: 'arbluna-12',  type: 'arbLUNA', duration: '3mo', multiplier: 2  },
    { id: 'ampluna-12',  type: 'ampLUNA', duration: '3mo', multiplier: 2  },
    { id: 'arbluna-1',   type: 'arbLUNA', duration: '1wk', multiplier: 1  },
    { id: 'ampluna-1',   type: 'ampLUNA', duration: '1wk', multiplier: 1  },
];

// LST hub contracts — same addresses the tool's lstContracts table uses.
// arbLUNA needs the `{state:{}}` query for its current exchange_rate; ampLUNA
// returns it in the first entry of `{exchange_rates:{limit:1}}`. The contract
// addresses are stable and unlikely to change (multi-sig migration would be a
// protocol-level event we'd notice). Hard-coding them here keeps the cron
// self-contained — no config repo to keep in sync.
const LST_HUBS = {
    arbLUNA: {
        contract: 'terra1r9gls56glvuc4jedsvc3uwh6vj95mqm9efc7hnweqxa2nlme5cyqxygy5m',
        query:    { state: {} },
        parse:    (data) => parseFloat(data?.data?.exchange_rate || 0),
    },
    ampLUNA: {
        contract: 'terra10788fkzah89xrdm27zkj5yvhj9x3494lxawzm5qq3vvxcqz2yzaqyd3enk',
        query:    { exchange_rates: { limit: 1 } },
        parse:    (data) => parseFloat(data?.data?.exchange_rates?.[0]?.[1] || 0),
    },
};

// GitHub config from environment. The cron runs without these in dry-run mode
// (logs to stdout, writes a local file), which is what `npm run snapshot` does
// locally. On Render the env vars are set in the dashboard.
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/votion-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// HTTP timing — each fetch has its own timeout. Eris's optimization endpoint
// can take 5-8s under load; bumping to 15s leaves headroom for slow days.
const HTTP_TIMEOUT_MS = 15000;

// Stagger between Eris calls. Firing all 6 concurrently has caused
// intermittent 5xx in the tool — Eris appears to have backpressure on the
// optimization endpoint. 500ms between calls measurably reduces failure rate
// without making the overall snapshot meaningfully slower (~3s total instead
// of "all at once" which can paradoxically be slower with retries).
const STAGGER_MS = 500;

// -----------------------------------------------------------------------------
// HTTP HELPERS
// -----------------------------------------------------------------------------

// Single fetch with a hard timeout and JSON parse. Throws on non-200 or invalid
// JSON. Caller wraps in try/catch for per-source error handling.
async function fetchJson(url, label = url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'aDAO-votion-snapshot/2.0',
            },
        });
        if (!res.ok) {
            // Read body for context — Eris's "not allowed origin" 500 is browser-only;
            // server-to-server calls don't hit it. But other 5xx (rate limit, indexer
            // lag) include useful detail.
            const body = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${body.slice(0, 120)}`);
        }
        return await res.json();
    } catch (e) {
        if (e.name === 'AbortError') throw new Error(`Timeout after ${HTTP_TIMEOUT_MS}ms (${label})`);
        throw e;
    } finally {
        clearTimeout(timeout);
    }
}

// Retry with exponential backoff. Used for *all* fetches in this cron because
// the old version had zero retry — one outage = lost epoch forever. 3 tries
// with 1s/3s/9s backoff is enough to ride out short Eris blips (which they
// typically have multiple times a week) without exceeding Render's free-tier
// 30s execution budget.
async function fetchJsonWithRetry(url, label = url, maxTries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
            return await fetchJson(url, label);
        } catch (e) {
            lastErr = e;
            if (attempt < maxTries) {
                const delay = Math.pow(3, attempt - 1) * 1000;
                console.log(`  ⏳ ${label} attempt ${attempt} failed (${e.message.slice(0, 80)}), retrying in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}

// CosmWasm smart query — base64-encode the JSON query, send via Terra LCD.
// `data` is decoded base64 in the response; LCDs auto-decode it back to JSON
// under the `data` key.
async function queryContract(contractAddr, queryObj, label) {
    const queryB64 = Buffer.from(JSON.stringify(queryObj)).toString('base64');
    const url = `${TERRA_LCD}/cosmwasm/wasm/v1/contract/${contractAddr}/smart/${queryB64}`;
    return fetchJsonWithRetry(url, label);
}

// -----------------------------------------------------------------------------
// DATA SOURCES — each returns either a successful payload or throws with context
// -----------------------------------------------------------------------------

// Fetch LST exchange rates. Two parallel chain queries — independent failure
// (one can succeed while the other 5xxs). Returns { arbLUNA, ampLUNA, errors }.
async function fetchLstRatios() {
    const result = { arbLUNA: null, ampLUNA: null, errors: {} };

    const tasks = Object.entries(LST_HUBS).map(async ([key, cfg]) => {
        try {
            const data = await queryContract(cfg.contract, cfg.query, `LST-${key}`);
            const rate = cfg.parse(data);
            if (!Number.isFinite(rate) || rate <= 0) throw new Error(`parsed rate invalid: ${rate}`);
            result[key] = rate;
        } catch (e) {
            result.errors[key] = e.message;
            console.log(`  ⚠ ${key} ratio fetch failed: ${e.message}`);
        }
    });
    await Promise.all(tasks);
    return result;
}

// Fetch LUNA USD price from CoinGecko. Single source; no retry across vendors
// (the tool also has Eris's /prices as a fallback, but that one has its own
// CORS issues and isn't worth the complexity for a cron — if CoinGecko is
// down, snapshot proceeds with prices.error set, usd values become 0).
async function fetchLunaPriceUsd() {
    try {
        const data = await fetchJsonWithRetry(COINGECKO_LUNA, 'CoinGecko LUNA');
        const price = data?.['terra-luna-2']?.usd;
        if (!Number.isFinite(price) || price <= 0) throw new Error(`malformed response: ${JSON.stringify(data).slice(0, 100)}`);
        return { price, source: 'coingecko', fetchedAt: new Date().toISOString() };
    } catch (e) {
        console.log(`  ⚠ LUNA price fetch failed: ${e.message}`);
        return { price: 0, source: 'coingecko', error: e.message, fetchedAt: new Date().toISOString() };
    }
}

// Fetch a single Votion lockup's optimization data from Eris.
// Returns the raw Eris payload — transformation to the new shape happens
// in buildLockup() below (separated so testing/validation is easier).
async function fetchVotionLockup(lockupId) {
    const url = `${ERIS_VOTION_BASE}/${lockupId}/optimization`;
    return fetchJsonWithRetry(url, `Votion-${lockupId}`);
}

// -----------------------------------------------------------------------------
// DATA TRANSFORMATION — port of the tool's fetchVotionFromApi() logic
// -----------------------------------------------------------------------------

// Bucket names match what Eris emits in `optimization.id`. Order matters for
// display but not for correctness; we keep tool's order for consistency.
const BUCKET_NAMES = ['stable', 'project', 'bluechip', 'single'];

// Build the rich lockup object from the raw Eris response + ratios + LUNA price.
// Mirrors the tool's transformation exactly so the output is byte-comparable.
// Returns null if the lockup has zero VP (no position) — the caller filters
// these out before adding to the snapshot.
function buildLockup(lockupConfig, erisData, ratios, lunaPrice) {
    const ratio = lockupConfig.type === 'arbLUNA' ? ratios.arbLUNA : ratios.ampLUNA;

    // VP comes from the first optimization (all 4 buckets report the same
    // total VP — that's the lockup's total, NOT per-bucket allocation).
    const vp = erisData.optimizations?.[0]?.votingPower || 0;
    if (vp === 0) return null;   // no position in this lockup

    // Reverse-engineer amount + luna from VP. Formula: VP = amount × ratio × multiplier.
    // If ratio fetch failed (ratio = null or 0), amount/luna stay 0 — the
    // snapshot still records VP but downstream USD math will produce 0.
    const amount = (ratio && ratio > 0) ? vp / (ratio * lockupConfig.multiplier) : 0;
    const luna = amount * (ratio || 0);
    const usd = luna * (lunaPrice || 0);

    // LST APY isn't fetched live in this cron (it'd add 3 more Eris calls and
    // these APYs barely move week-to-week). Captured as 0; downstream tooling
    // that needs LST APYs already has them in the live tool's export.
    // Future TODO: lift fetchAllLstRatiosFromChain's APY computation here too,
    // since we already have the exchange_rates data for ampLUNA. For now, 0.
    const lstApy = 0;
    const expectedRewards = erisData.summary?.totalExpectedReward || 0;
    // Votion APY: weekly rewards annualized over USD value. 52 weeks * 100 for %.
    // Same formula as the tool. Guard against /0 (no USD value yet).
    const votionApy = (usd > 0 && expectedRewards > 0) ? (expectedRewards / usd) * 52 * 100 : 0;
    const lockApy = lstApy + votionApy;

    // Build the bucket array. For each optimization (Eris emits 4 — one per
    // bucket), collect pools that appear in either current or optimized votes.
    const buckets = [];
    for (const opt of erisData.optimizations || []) {
        if (!BUCKET_NAMES.includes(opt.id)) continue;

        const meta = opt.meta?.votes || [];
        const allPoolAddrs = new Set([
            ...Object.keys(opt.activeVoted || {}),
            ...Object.keys(opt.newVoted    || {}),
        ]);

        const pools = [];
        for (const addr of allPoolAddrs) {
            const m = meta.find(x => x.id === addr);
            const poolName = m?.title?.replace(' LP', '') || addr.slice(0, 8) + '...';
            const current   = opt.activeVoted?.[addr] || 0;
            const optimized = opt.newVoted?.[addr]    || 0;
            if (current > 0 || optimized > 0) {
                pools.push({
                    name: poolName,
                    current:   parseFloat(current.toFixed(2)),
                    optimized: parseFloat(optimized.toFixed(2)),
                    change:    parseFloat((optimized - current).toFixed(2)),
                    address:   addr,
                });
            }
        }
        // Sort pools by optimized weight descending — matches tool display order.
        pools.sort((a, b) => b.optimized - a.optimized);

        buckets.push({
            name: opt.id,
            expectedRewards: opt.optimization?.totalExpectedReward || 0,
            isWorthChanging: opt.diff?.isWorthChanging || false,
            potentialGain:   opt.diff?.rewardLoss      || 0,
            pools,
        });
    }

    return {
        type:       lockupConfig.type,
        duration:   lockupConfig.duration,
        multiplier: lockupConfig.multiplier,
        amount,
        luna,
        vp,
        usd,
        lockApy,
        lstApy,
        votionApy,
        period:          parseInt(erisData.period) || 0,
        expectedRewards,
        buckets,
        fetchedFromApi: true,
        fetchedAt: new Date().toISOString(),
    };
}

// Normalize a Votion pool name to match the LP-registry key format the rest
// of the toolchain uses. Lifted verbatim from the tool's normalizePoolName
// (line ~11371 of tla-tool_ext.html) so the cron output keys join cleanly
// with dex_performance and other per-pool data downstream.
function normalizePoolName(name) {
    name = name.replace(' LP', '').trim();
    // Handle suffix-without-dot (WBTCaxl → WBTC.axl)
    name = name.replace(/([^.])(atom|axl|osmo|wh)$/gi, (m, p1, p2) => p1 + '.' + p2.toLowerCase());
    // Handle wrong-case suffix (.ATOM → .atom)
    name = name.replace(/\.(ATOM|AXL|OSMO|WH)/g, (m) => m.toLowerCase());
    // LUNA-first canonical order (but preserve ampLUNA/bLUNA/arbLUNA prefixes)
    if (name.includes('-')) {
        const parts = name.split('-');
        const secondBase = parts[1].replace(/\.(atom|axl|osmo|wh)$/i, '');
        if (secondBase === 'LUNA') {
            name = `LUNA-${parts[0]}`;
        }
    }
    return name;
}

// Roll lockup data up into pool-level aggregates. For each pool, sums VP
// contributions from every lockup that has any allocation to it, and tracks
// the per-lockup contribution detail so dashboards can drill down.
// Port of buildVotionExportData() lines 11355-11461.
function buildPoolRollup(lockups, totalVp) {
    const pools = {};

    for (const lockup of lockups) {
        const lockupVp = lockup.vp || 0;
        if (lockupVp === 0) continue;

        for (const bucket of lockup.buckets || []) {
            const bucketName = (bucket.name || '').toLowerCase();

            for (const pool of bucket.pools || []) {
                const poolName = normalizePoolName(pool.name);
                const lpKey = `${poolName}|Astroport`;

                if (!pools[lpKey]) {
                    pools[lpKey] = {
                        current_vp: 0,
                        optimized_vp: 0,
                        current_pct: 0,
                        optimized_pct: 0,
                        bucket: bucketName,
                        lockup_contributions: [],
                    };
                }

                const currentVp   = lockupVp * (pool.current   / 100);
                const optimizedVp = lockupVp * (pool.optimized / 100);

                pools[lpKey].current_vp   += currentVp;
                pools[lpKey].optimized_vp += optimizedVp;

                pools[lpKey].lockup_contributions.push({
                    type:          lockup.type,
                    duration:      lockup.duration,
                    lockup_vp:     lockupVp,
                    current_pct:   pool.current,
                    optimized_pct: pool.optimized,
                    current_vp:    currentVp,
                    optimized_vp:  optimizedVp,
                });
            }
        }
    }

    // Compute percentages of total VP + round VPs for cleaner output.
    for (const key of Object.keys(pools)) {
        if (totalVp > 0) {
            pools[key].current_pct   = (pools[key].current_vp   / totalVp) * 100;
            pools[key].optimized_pct = (pools[key].optimized_vp / totalVp) * 100;
        }
        pools[key].current_vp   = Math.round(pools[key].current_vp);
        pools[key].optimized_vp = Math.round(pools[key].optimized_vp);
    }

    return pools;
}

// -----------------------------------------------------------------------------
// GITHUB PUBLISH
// -----------------------------------------------------------------------------

function githubApiRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'api.github.com',
            path,
            method,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent':    'aDAO-votion-snapshot/2.0',
                'Accept':        'application/vnd.github.v3+json',
                'Content-Type':  'application/json',
            },
        };
        const req = https.request(opts, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data || '{}') }); }
                catch { resolve({ status: res.statusCode, data: {} }); }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function pushToGithub(filepath, content, message) {
    const apiPath = `/repos/${GITHUB_REPO}/contents/${filepath}`;
    // Get existing SHA if any (PUT to /contents requires SHA for updates).
    const existing = await githubApiRequest('GET', apiPath);
    const sha = existing.data?.sha;
    const body = {
        message,
        content: Buffer.from(content).toString('base64'),
        branch: GITHUB_BRANCH,
        ...(sha ? { sha } : {}),
    };
    const result = await githubApiRequest('PUT', apiPath, body);
    if (result.status === 200 || result.status === 201) {
        console.log(`✅ Pushed to GitHub: ${filepath}`);
        return true;
    }
    console.error(`❌ GitHub push failed (HTTP ${result.status}): ${result.data?.message || '<no message>'}`);
    return false;
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------

async function captureVotionSnapshot() {
    const startedAt = new Date();
    console.log(`\n📸 Votion Epoch Snapshot (v2 — rich shape)`);
    console.log(`   Started: ${startedAt.toISOString()}\n`);

    // Step 1: parallel fetch of LST ratios + LUNA price (independent failures)
    console.log('🔍 Fetching market data (LST ratios + LUNA price)...');
    const [ratios, lunaPriceInfo] = await Promise.all([
        fetchLstRatios(),
        fetchLunaPriceUsd(),
    ]);
    console.log(`   arbLUNA ratio: ${ratios.arbLUNA?.toFixed(6) ?? 'FAILED'}`);
    console.log(`   ampLUNA ratio: ${ratios.ampLUNA?.toFixed(6) ?? 'FAILED'}`);
    console.log(`   LUNA price:    $${lunaPriceInfo.price?.toFixed(4) ?? 'FAILED'}`);

    // Step 2: sequential (staggered) fetch of all 6 lockups
    console.log(`\n🔍 Fetching ${LOCKUPS.length} lockup optimizations...`);
    const lockups = [];
    const fetchErrors = {};

    for (let i = 0; i < LOCKUPS.length; i++) {
        const cfg = LOCKUPS[i];
        const label = `${cfg.type} ${cfg.duration}`;
        try {
            const erisData = await fetchVotionLockup(cfg.id);
            const lockup = buildLockup(cfg, erisData, ratios, lunaPriceInfo.price);
            if (lockup) {
                lockups.push(lockup);
                console.log(`   ✓ ${label.padEnd(16)} VP=${lockup.vp.toLocaleString().padStart(15)}  $${lockup.usd.toFixed(2).padStart(10)}  rew=$${lockup.expectedRewards.toFixed(2)}`);
            } else {
                console.log(`   ⊘ ${label.padEnd(16)} no position (VP=0)`);
            }
        } catch (e) {
            fetchErrors[cfg.id] = e.message;
            console.log(`   ✗ ${label.padEnd(16)} ${e.message.slice(0, 100)}`);
        }
        if (i < LOCKUPS.length - 1) {
            await new Promise(r => setTimeout(r, STAGGER_MS));
        }
    }

    if (lockups.length === 0) {
        throw new Error('No lockups captured — aborting snapshot (would produce empty file)');
    }

    // Step 3: aggregate to total VP + pool-level rollup
    const totalVp = lockups.reduce((sum, lk) => sum + (lk.vp || 0), 0);
    const pools = buildPoolRollup(lockups, totalVp);
    console.log(`\n📊 Aggregated ${lockups.length} lockups, ${Object.keys(pools).length} unique pools, total_vp=${totalVp.toLocaleString()}`);

    // Period + voteBefore come from any successful lockup — they're snapshot-wide
    // (every lockup reports the same period/voteBefore since they're capturing
    // the same epoch state).
    const period     = lockups[0].period;
    const voteBefore = lockups[0]?.fetchedFromApi ? null : null;   // filled below from any erisData if we kept it
    // We didn't carry voteBefore through buildLockup — re-fetch from the first
    // lockup's response is impossible without storing. Use captured period to
    // derive: voteBefore = epoch_start + period * 7 days - 1 min. EPOCH_START
    // is 2022-10-31T00:00:00Z per the tool.
    const EPOCH_START_MS = Date.parse('2022-10-31T00:00:00Z');
    const EPOCH_MS = 7 * 24 * 60 * 60 * 1000;
    const voteBeforeMs = EPOCH_START_MS + (period * EPOCH_MS) - 60000;   // 1 min before next epoch
    const voteBeforeIso = new Date(voteBeforeMs).toISOString();

    // Step 4: assemble snapshot
    const snapshot = {
        schemaVersion:  2,                          // bumped from implicit v1 (old shape)
        capturedAt:     startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        period,
        voteBefore: voteBeforeIso,
        ratios: {
            arbLUNA: ratios.arbLUNA,
            ampLUNA: ratios.ampLUNA,
        },
        prices: lunaPriceInfo,
        total_vp: totalVp,
        lockups,
        pools,
        ...(Object.keys(fetchErrors).length || Object.keys(ratios.errors).length || lunaPriceInfo.error
            ? { fetchErrors: { ...fetchErrors,
                               ...(Object.keys(ratios.errors).length ? { ratios: ratios.errors } : {}),
                               ...(lunaPriceInfo.error ? { luna_price: lunaPriceInfo.error } : {}) } }
            : {}),
    };

    // Step 5: publish to GitHub. Path matches the existing repo layout
    // (votion/votion-epoch-{N}.json) so the cron is a drop-in upgrade.
    if (GITHUB_TOKEN && period) {
        const filename = `votion/votion-epoch-${period}.json`;
        const content  = JSON.stringify(snapshot, null, 2);
        const message  = `📸 Votion epoch ${period} snapshot (v2 rich shape) — ${startedAt.toISOString().split('T')[0]}`;
        console.log(`\n📤 Pushing to GitHub: ${filename} (${(content.length/1024).toFixed(1)} KB)...`);
        await pushToGithub(filename, content, message);
    } else if (!GITHUB_TOKEN) {
        console.log('\n⚠️  GITHUB_TOKEN not set — saving locally only');
        const filename = `votion-epoch-${period || 'test'}.json`;
        fs.writeFileSync(filename, JSON.stringify(snapshot, null, 2));
        console.log(`   Saved: ${filename}`);
    }

    console.log(`\n✅ Snapshot complete (${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s)\n`);
    return snapshot;
}

// -----------------------------------------------------------------------------
// ENTRY
// -----------------------------------------------------------------------------

captureVotionSnapshot()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('\n❌ Snapshot failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    });
