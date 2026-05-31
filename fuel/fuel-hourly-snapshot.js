const https = require('https');

// ============================================================
// CONFIGURATION
// ============================================================

const FUEL_DENOM  = 'ibc/4B44179AC2F0BEE50C16A673B3B886398988692885B2848A1C8AEF27148B3961';
const FUEL_POOL   = 'terra10yfnsqn20rzlnlzkeva5255q27zp6ws9te9uuql9e0lacfcze7zsffjct5';
const ASTRO_HOST  = 'app.astroport.fi';

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/fuel-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

// ============================================================
// ASTROPORT API PATHS
// ============================================================

const BYCHAIN_PATH = '/api/trpc/tokens.byChain?input=' +
    encodeURIComponent(JSON.stringify({ json: { chainId: 'phoenix-1' } }));

function chartPath(type, dateRange) {
    return '/api/trpc/charts.' + type + '?input=' +
        encodeURIComponent(JSON.stringify({
            json: { pools: [FUEL_POOL], dateRange, chainId: 'phoenix-1' }
        }));
}

// ============================================================
// HELPERS
// ============================================================

function fmtDate(d) { return d.toISOString().slice(0, 10); }
function zeroPad(n) { return String(n).padStart(2, '0'); }

// Filter a series to only include points on a specific UTC date
function filterSeriesByDate(series, dateStr) {
    return series.filter(p => {
        const d = new Date(Math.floor(p.time) * 1000);
        return d.toISOString().slice(0, 10) === dateStr;
    });
}

// Sum values in a series (for volume)
function sumSeries(series) {
    return parseFloat(series.reduce((s, p) => s + p.value, 0).toFixed(6));
}

// Average values in a series (for liquidity TVL)
function avgSeries(series) {
    if (!series.length) return null;
    return parseFloat((series.reduce((s, p) => s + p.value, 0) / series.length).toFixed(2));
}

function isLastDayOfMonth(d) {
    const next = new Date(d);
    next.setUTCDate(d.getUTCDate() + 1);
    return next.getUTCMonth() !== d.getUTCMonth();
}

function fetchJsonHost(hostname, path) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname, path, method: 'GET',
            headers: { 'User-Agent': 'FUEL-Hourly-Snapshot-Bot', 'Accept': 'application/json' }
        };
        https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON parse error from ${hostname}${path.slice(0,60)}: ${e.message}`)); }
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
                'User-Agent':    'FUEL-Hourly-Snapshot-Bot',
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
// FETCH FUEL DATA
// ============================================================

async function fetchFuelPrice() {
    const d = await fetchJsonHost(ASTRO_HOST, BYCHAIN_PATH);
    const tok = d?.result?.data?.json?.tokens?.[FUEL_DENOM];
    if (!tok?.priceUsd) throw new Error('FUEL price not found in tokens.byChain');
    return parseFloat(tok.priceUsd);
}

// Returns full raw series for liquidity (caller filters by date)
async function fetchLiquiditySeries(dateRange = 'HR24') {
    const d = await fetchJsonHost(ASTRO_HOST, chartPath('liquidity', dateRange));
    const series = d?.result?.data?.json?.[0]?.series || [];
    // Latest value = current spot TVL (use for display, not for daily avg)
    const latestTvl = series.length ? series[series.length - 1].value : null;
    return { latestTvl, series };
}

// Returns full raw series for volume (caller filters by date and sums)
async function fetchVolumeSeries(dateRange = 'HR24') {
    const d = await fetchJsonHost(ASTRO_HOST, chartPath('volume', dateRange));
    const series = d?.result?.data?.json?.[0]?.series || [];
    return { series };
}

// ============================================================
// LOAD ALL HOURLY FILES FOR A DATE
// ============================================================

async function loadHourlyFiles(dateStr) {
    const results = [];
    for (let h = 0; h <= 23; h++) {
        try {
            const path = `snapshots/hourly/${dateStr}/${zeroPad(h)}.json`;
            const data = await getFileFromGithub(path);
            if (data) results.push(data);
        } catch (e) {
            // hour not recorded yet — skip
        }
    }
    return results;
}

// ============================================================
// COMPUTE DAILY SUMMARY FROM HOURLY FILES
// ============================================================

function computeDailySummary(hourlyFiles, date, dayName, finalLiq, finalVol) {
    const prices = hourlyFiles.map(h => h.price).filter(Boolean);
    const tvls   = hourlyFiles.map(h => h.tvl).filter(Boolean);

    // Price stats from hourly snapshots (one per hour = clean daily candle)
    const avgPrice   = prices.length
        ? parseFloat((prices.reduce((s, v) => s + v, 0) / prices.length).toFixed(8)) : null;
    const openPrice  = prices[0]  ?? null;
    const closePrice = prices[prices.length - 1] ?? null;
    const highPrice  = prices.length ? Math.max(...prices) : null;
    const lowPrice   = prices.length ? Math.min(...prices) : null;

    // Liquidity: average the TVL snapshots from TODAY's points in the series
    const liqToday   = filterSeriesByDate(finalLiq.series, date);
    const tvlsToday  = liqToday.map(p => p.value);
    const avgTvlSeries = tvlsToday.length ? avgSeries(liqToday) : null;
    // Fallback to hourly file TVL snapshots if series filtering yields nothing
    const avgTvl = avgTvlSeries ?? (tvls.length
        ? parseFloat((tvls.reduce((s, v) => s + v, 0) / tvls.length).toFixed(2)) : null);

    // Volume: sum ONLY today's trade events from the series
    const volToday      = filterSeriesByDate(finalVol.series, date);
    const dailyVolLuna  = volToday.length ? sumSeries(volToday) : 0;

    console.log(`   Series filter (${date}):`);
    console.log(`     Liq points today: ${liqToday.length} / ${finalLiq.series.length} total`);
    console.log(`     Vol points today: ${volToday.length} / ${finalVol.series.length} total`);

    return {
        meta: {
            date, dayName,
            pricePointCount:    prices.length,
            liqPointsToday:     liqToday.length,
            volPointsToday:     volToday.length,
            generatedAt:        new Date().toISOString()
        },
        price: {
            open:  openPrice,
            high:  highPrice,
            low:   lowPrice,
            close: closePrice,
            avg:   avgPrice
        },
        pool: {
            avgTvlUsd:       avgTvl,
            latestTvlUsd:    finalLiq.latestTvl,
            dailyVolumeLuna: dailyVolLuna,
            // Store only today's filtered series for chart rendering
            liquiditySeries: liqToday,
            volumeSeries:    volToday
        }
    };
}

// ============================================================
// MAIN
// ============================================================

async function captureHourly() {
    const now     = new Date();
    const dateStr = fmtDate(now);
    const hour    = now.getUTCHours();
    const dow     = now.getUTCDay();
    const dayName = DAY_NAMES[dow];
    const hourStr = zeroPad(hour);
    const isFinal = hour === 23;   // 23:50 UTC run = daily aggregation run

    console.log(`\n⛽ FUEL Hourly Snapshot — ${dateStr} ${hourStr}:50 UTC`);
    console.log(`   Repo:  ${GITHUB_REPO}`);
    console.log(`   Final: ${isFinal ? 'YES — will aggregate daily summary' : 'no'}\n`);

    // ── 1. Fetch current data ────────────────────────────────────────────────
    console.log('   Fetching price...');
    const price = await fetchFuelPrice();
    console.log(`   Price:    $${price.toFixed(8)}`);

    console.log('   Fetching 24h liquidity series...');
    const liq = await fetchLiquiditySeries('HR24');
    console.log(`   TVL now:  $${(liq.latestTvl ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);

    console.log('   Fetching 24h volume series...');
    const vol = await fetchVolumeSeries('HR24');
    const volTodayPreview = filterSeriesByDate(vol.series, dateStr);
    const volTotalPreview = sumSeries(volTodayPreview);
    console.log(`   Vol 24h:  ${volTotalPreview.toFixed(3)} LUNA (${volTodayPreview.length} trades today)`);

    // ── 2. Save hourly snapshot ──────────────────────────────────────────────
    // For hourly file: snapshot only (spot values, not day totals)
    const hourlyData = {
        timestamp: now.toISOString(),
        date:      dateStr,
        hour:      hourStr,
        price,
        tvl:       liq.latestTvl   // latest spot TVL at this hour
    };

    if (!GITHUB_TOKEN) {
        console.log('\n   ⚠️  GITHUB_TOKEN not set — logging locally only');
        console.log(JSON.stringify(hourlyData, null, 2));
        return;
    }

    const hourlyPath = `snapshots/hourly/${dateStr}/${hourStr}.json`;
    await pushToGithub(hourlyPath, JSON.stringify(hourlyData, null, 2),
        `⛽ FUEL hourly ${dateStr} ${hourStr}:50 UTC`);

    // ── 3. If final hour: aggregate daily summary ────────────────────────────
    if (isFinal) {
        console.log('\n   🔄 Final hour — aggregating daily summary...');

        const allHourly = await loadHourlyFiles(dateStr);
        console.log(`   Hourly files loaded: ${allHourly.length}`);

        const dailySummary = computeDailySummary(allHourly, dateStr, dayName, liq, vol);

        console.log(`   Avg price:  $${dailySummary.price.avg}`);
        console.log(`   High:       $${dailySummary.price.high}`);
        console.log(`   Low:        $${dailySummary.price.low}`);
        console.log(`   Avg TVL:    $${(dailySummary.pool.avgTvlUsd ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
        console.log(`   Vol (day):  ${dailySummary.pool.dailyVolumeLuna} LUNA`);

        // ── Load index ────────────────────────────────────────────────────────
        const indexPath = 'snapshots/index.json';
        let index;
        try {
            index = await getFileFromGithub(indexPath);
        } catch (e) { index = null; }
        if (!index) index = { latest: null, daily: {}, history: [] };

        // ── 3a. Rolling daily file ────────────────────────────────────────────
        const dailyPath = `snapshots/daily/${dayName}.json`;
        await pushToGithub(dailyPath, JSON.stringify(dailySummary, null, 2),
            `⛽ FUEL daily summary ${dayName} (${dateStr})`);
        index.daily[dayName] = dateStr;
        index.latest = dateStr;

        // ── 3b. Append to history ─────────────────────────────────────────────
        const histEntry = {
            date:            dateStr,
            openPrice:       dailySummary.price.open,
            highPrice:       dailySummary.price.high,
            lowPrice:        dailySummary.price.low,
            closePrice:      dailySummary.price.close,
            avgPrice:        dailySummary.price.avg,
            avgTvlUsd:       dailySummary.pool.avgTvlUsd,
            dailyVolumeLuna: dailySummary.pool.dailyVolumeLuna
        };
        const existsIdx = index.history.findIndex(e => e.date === dateStr);
        if (existsIdx >= 0) Object.assign(index.history[existsIdx], histEntry);
        else index.history.push(histEntry);
        index.history.sort((a, b) => a.date.localeCompare(b.date));

        // ── 3c. Weekly (Sunday) ───────────────────────────────────────────────
        if (dow === 0) {
            const weeklyPath = `snapshots/weekly/${dateStr}.json`;
            await pushToGithub(weeklyPath, JSON.stringify(dailySummary, null, 2),
                `⛽ FUEL weekly snapshot (${dateStr})`);
            console.log(`   ✅ Weekly ${dateStr} saved`);
        }

        // ── 3d. Monthly (last day of month) ───────────────────────────────────
        if (isLastDayOfMonth(now)) {
            const monthlyPath = `snapshots/monthly/${dateStr}.json`;
            await pushToGithub(monthlyPath, JSON.stringify(dailySummary, null, 2),
                `⛽ FUEL monthly snapshot (${dateStr})`);
            console.log(`   ✅ Monthly ${dateStr} saved`);
        }

        // ── 3e. Update index ──────────────────────────────────────────────────
        await pushToGithub(indexPath, JSON.stringify(index, null, 2),
            `⛽ Update FUEL index (${dateStr} EOD)`);

        console.log(`\n✅ Daily summary complete — avg $${dailySummary.price.avg}\n`);

    } else {
        // Non-final hour: update index latest only
        let index;
        try { index = await getFileFromGithub('snapshots/index.json'); } catch(e) { index = null; }
        if (!index) index = { latest: null, daily: {}, history: [] };
        index.latestPrice   = price;
        index.latestTvl     = liq.latestTvl;
        index.latestUpdated = now.toISOString();
        await pushToGithub('snapshots/index.json', JSON.stringify(index, null, 2),
            `⛽ FUEL index update ${dateStr} ${hourStr}:50`);

        console.log(`\n✅ Hourly snapshot saved — $${price.toFixed(8)}\n`);
    }

    // ─── HEARTBEAT (CRON-FIXES-BRIEF 1.6) ──────────────────────────────────
    // Emit a heartbeat file in the same shape as the other 7 production crons
    // so the footer Cron Health widget can show fuel's freshness.
    //
    // No data-fingerprint here because fuel price + TVL change every block;
    // the cron is effectively self-validating via continuous movement.
    // (If a `stuck` signal is ever wanted, fingerprint `price` + `tvl` and
    // mirror the pattern used in the other crons.)
    try {
        const heartbeat = {
            schemaVersion:    1,
            cron:             'fuel',
            capturedAt:       now.toISOString(),
            capturedAtUnix:   now.getTime(),
            runId:            `fuel-${now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
            runMode:          isFinal ? 'hourly+daily-aggregation' : 'hourly',
            status:           'ok',
            stats: {
                price_usd:    price,
                tvl_usd:      liq.latestTvl ?? null,
                vol_24h_luna: volTotalPreview,
            },
            // Hourly cadence; allow ~15 min jitter / late runs before "stale"
            next_expected_run_at: new Date(now.getTime() + 75 * 60 * 1000).toISOString(),
        };
        await pushToGithub('snapshots/heartbeat.json',
            JSON.stringify(heartbeat, null, 2),
            `📍 FUEL heartbeat ${dateStr} ${hourStr}:50`);
    } catch (e) {
        console.error(`   ⚠ heartbeat push failed: ${e.message || e}`);
        // Don't fail the whole run for a heartbeat issue — log and continue.
    }
}

// ============================================================
// RUN
// ============================================================

captureHourly()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('❌ Hourly snapshot failed:', err);
        process.exit(1);
    });
