// =============================================================================
// Marketplace Stats Cron
// =============================================================================
//
// Captures BBL + Boost marketplace state for the aDAO ecosystem collections
// (aDAO NFTs, pixeLions, TLA Locks). Replaces the dashboard's per-page-load
// marketplace API hits with a cached snapshot.
//
// What it produces (uploaded to `marketplace-data_2026`):
//
//   data/marketplace.json           ← current floors + listed counts + collection stats
//   data/listings/bbl-{coll}.json   ← per-collection full BBL listings (token_id + price)
//   data/listings/boost-{coll}.json ← per-collection full Boost listings (launch data)
//   data/activity-7d.json           ← BBL activity feed, last 7 days (sales/listed/cancel)
//   data/sales/nft-sales-{year}.json ← yearly sales history (BBL + Boost)
//   data/sales/index.json           ← which years have files
//   data/heartbeat.json             ← uniform freshness contract
//
// Schedule: hourly at :15 (Render cron: `15 * * * *`)
// Runtime:  ~30-60 seconds (BBL + Boost paginated calls; sales backfill on first run)
//
// API endpoints (verified shapes from index.html):
//   BBL:   GET  /api/v1/dapps/necropolis/nfts?nftContract=X&types=buy_now
//          GET  /api/v1/dapps/necropolis/collections/{contract}
//          GET  /api/v1/dapps/necropolis/activity?chains=phoenix-1
//   Boost: POST /graphql  (Launches query, where launch_contract = X)
//
// Both APIs need NO proxy when called server-side (CORS only affects browsers).
// =============================================================================

const https = require('https');
const fs    = require('fs');

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------

// Collection contracts (verified from index.html constants)
const COLLECTIONS = {
    alliance_dao: {
        label: 'Alliance DAO',
        contract: 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9',
        bbl:   true,   // listed on BBL marketplace
        boost: true,   // listed on Boost marketplace
        has_broken: true,
    },
    pixelions: {
        label: 'pixeLions',
        contract: 'terra17z7fpaa8kah698xn5tarrcucvualdy4wsztkfc404g3garucpu6qmxp50g',
        bbl:   true,
        boost: true,
        has_broken: false,
    },
    tla_locks: {
        label: 'TLA Locks',
        contract: 'terra1uqhj8agyeaz8fu6mdggfuwr3lp32jlrx5hqag4jxexde92rzkamq3l62zg',
        bbl:   false,  // TLA Locks only on Boost
        boost: true,
        has_broken: false,
    },
};

// API endpoints (from index.html constants — verified live)
const BBL_API_BASE          = 'https://warlock.backbonelabs.io/api/v1/dapps/necropolis';
const BOOST_API_URL         = 'https://api.boostdao.io/graphql';
const BOOST_LAUNCH_CONTRACT = 'terra1kj7pasyahtugajx9qud02r5jqaf60mtm7g5v9utr94rmdfftx0vqspf4at';

// Network-and-prices cron output (for converting bLUNA prices to USD)
const NETWORK_PRICES_URL = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main/network-and-prices/current.json';

// Data repo where THIS cron writes (used by sales-history reads for incremental dedupe)
const SELF_REPO_RAW_BASE = 'https://raw.githubusercontent.com/defipatriot/marketplace-data_2026/main';

// Tuning
const HTTP_TIMEOUT_MS = 30000;
const BBL_PAGE_SIZE   = 100;     // BBL allows up to ~200 per page; 100 is conservative
const BOOST_PAGE_SIZE = 50;
const ACTIVITY_DAYS   = 7;       // window for activity-7d.json
const ACTIVITY_PAGES  = 3;       // 3 × 100 = up to 300 events per run (enough for last 7d)
const SALES_BACKFILL_BBL_MAX_PAGES   = 50;  // first-run only
const SALES_BACKFILL_BOOST_MAX_PAGES = 30;

// GitHub publish (matches other crons' env contract)
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/marketplace-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// TLA epoch math (for heartbeat consistency)
const TLA_EPOCH_START_MS    = Date.parse('2022-10-31T00:00:00Z');
const TLA_EPOCH_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
function currentEpoch() {
    return Math.floor((Date.now() - TLA_EPOCH_START_MS) / TLA_EPOCH_DURATION_MS) + 1;
}

// -----------------------------------------------------------------------------
// HTTP HELPERS
// -----------------------------------------------------------------------------

async function fetchJson(url, label = url, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            ...init,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'aDAO-marketplace-stats/1.0',
                ...(init.headers || {}),
            },
        });
        if (res.status === 429) {
            const err = new Error('Rate limited');
            err.code = 'RATE_LIMITED';
            throw err;
        }
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            const err = new Error(`HTTP ${res.status} ${body.slice(0, 100)}`);
            // Mark 4xx as non-retriable — they're typically permanent (auth, allowlist, bad params)
            if (res.status >= 400 && res.status < 500) err.code = 'CLIENT_ERROR';
            throw err;
        }
        return await res.json();
    } catch (e) {
        if (e.name === 'AbortError') throw new Error(`Timeout (${label})`);
        throw e;
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchJsonWithRetry(url, label, init = {}, maxTries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
            return await fetchJson(url, label, init);
        } catch (e) {
            lastErr = e;
            // Don't retry rate limits or client errors (permanent failures)
            if (e.code === 'RATE_LIMITED' || e.code === 'CLIENT_ERROR' || attempt === maxTries) throw e;
            const delay = Math.pow(2, attempt - 1) * 1000;
            console.log(`  ⏳ ${label} attempt ${attempt} failed (${e.message.slice(0, 60)}), retry in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

// -----------------------------------------------------------------------------
// BBL: collection stats + listings + activity
// -----------------------------------------------------------------------------

// GET /collections/{contract} → { floor, volume, ... }
async function fetchBblCollection(contract) {
    const url = `${BBL_API_BASE}/collections/${contract}`;
    return fetchJsonWithRetry(url, `BBL collection ${contract.slice(0, 12)}`);
}

// GET /nfts → paginated listings. Returns { nfts: [...], pagination: { totalResults } }
async function fetchBblListings(contract, page = 1, perPage = BBL_PAGE_SIZE) {
    const url = `${BBL_API_BASE}/nfts?nftContract=${contract}&page=${page}&perPage=${perPage}&types=buy_now&sort=price-asc`;
    return fetchJsonWithRetry(url, `BBL listings ${contract.slice(0, 12)} p${page}`);
}

async function fetchAllBblListings(contract) {
    const first = await fetchBblListings(contract, 1, BBL_PAGE_SIZE);
    const total = first?.pagination?.totalResults ?? (first?.nfts?.length || 0);
    const nfts  = [...(first?.nfts || [])];
    if (total > BBL_PAGE_SIZE) {
        const totalPages = Math.ceil(total / BBL_PAGE_SIZE);
        for (let page = 2; page <= Math.min(totalPages, 20); page++) {
            const r = await fetchBblListings(contract, page, BBL_PAGE_SIZE);
            if (r?.nfts) nfts.push(...r.nfts);
            if (!r?.nfts || r.nfts.length < BBL_PAGE_SIZE) break;
        }
    }
    return { listings: nfts, totalResults: total };
}

// GET /activity → { auctionHistory: [...] }
async function fetchBblActivity(page = 1, perPage = 100) {
    const url = `${BBL_API_BASE}/activity?page=${page}&perPage=${perPage}&chains=phoenix-1`;
    return fetchJsonWithRetry(url, `BBL activity p${page}`);
}

// Walk BBL activity for a window of pages — used for both 7-day feed AND sales backfill.
async function fetchBblActivityPages(maxPages) {
    const all = [];
    for (let p = 1; p <= maxPages; p++) {
        try {
            const r = await fetchBblActivity(p, 100);
            const items = r?.auctionHistory || [];
            if (items.length === 0) break;
            all.push(...items);
            if (items.length < 100) break;
        } catch (e) {
            console.warn(`  ⚠ BBL activity page ${p} failed: ${e.message}`);
            break;
        }
    }
    return all;
}

// -----------------------------------------------------------------------------
// BOOST: listings + completed sales via GraphQL
// -----------------------------------------------------------------------------

const BOOST_LAUNCH_FIELDS = `
    creator done launch_id cancelled to_id from_id name setup_msg
    from_collection_id from_nft_id launch_type from_amount to_amount
    from_usd to_usd discount real_collection_id __typename
`;
const BOOST_GQL = `query Launches($where: View_launch_preparedWhereInput, $orderBy: [View_launch_preparedOrderByWithRelationInput!], $take: Int, $skip: Int) {
    launches: view_launch_prepareds(where: $where, orderBy: $orderBy, take: $take, skip: $skip) {
        ${BOOST_LAUNCH_FIELDS}
    }
    aggregateLaunch: aggregateView_launch_prepared(where: $where) {
        _count { _all __typename }
        __typename
    }
}`;

async function boostGraphQL(variables, label) {
    return fetchJsonWithRetry(BOOST_API_URL, label, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationName: 'Launches', variables, query: BOOST_GQL }),
    });
}

async function fetchBoostListings(contract) {
    // ACTIVE listings = done:false, cancelled:false, active:true
    const variables = {
        where: {
            launch_contract: { equals: BOOST_LAUNCH_CONTRACT },
            AND: [],
            done: { equals: false },
            cancelled: { equals: false },
            real_collection_id: { equals: contract },
            discount: { gte: -0.001 },
            active: { equals: true },
            whitelist: { none: {} },
        },
        orderBy: [
            { discount: { sort: 'desc', nulls: 'last' } },
            { to_usd:   { sort: 'asc',  nulls: 'last' } },
        ],
        skip: 0,
        take: BOOST_PAGE_SIZE,
    };
    const r = await boostGraphQL(variables, `Boost listings ${contract.slice(0, 12)}`);
    return {
        listings: r?.data?.launches || [],
        totalCount: r?.data?.aggregateLaunch?._count?._all || 0,
    };
}

async function fetchBoostCompletedSales(contract, maxPages = SALES_BACKFILL_BOOST_MAX_PAGES) {
    // COMPLETED sales = done:true
    const allSales = [];
    let totalCount = null;
    let skip = 0;
    for (let p = 0; p < maxPages; p++) {
        const variables = {
            where: {
                launch_contract: { equals: BOOST_LAUNCH_CONTRACT },
                AND: [{ OR: [{ done: { equals: true } }] }],
                real_collection_id: { equals: contract },
                discount: { gte: -0.001 },
                whitelist: { none: {} },
            },
            orderBy: [
                { discount: { sort: 'desc', nulls: 'last' } },
                { to_usd:   { sort: 'asc',  nulls: 'last' } },
            ],
            skip,
            take: BOOST_PAGE_SIZE,
        };
        try {
            const r = await boostGraphQL(variables, `Boost sales ${contract.slice(0, 12)} p${p}`);
            const launches = r?.data?.launches || [];
            if (totalCount === null) totalCount = r?.data?.aggregateLaunch?._count?._all || 0;
            if (launches.length === 0) break;
            allSales.push(...launches);
            skip += BOOST_PAGE_SIZE;
            if (allSales.length >= totalCount) break;
            await new Promise(r => setTimeout(r, 150));   // courtesy
        } catch (e) {
            console.warn(`  ⚠ Boost sales page ${p} failed: ${e.message}`);
            break;
        }
    }
    return { sales: allSales, totalCount: totalCount ?? allSales.length };
}

// -----------------------------------------------------------------------------
// PARSING / SHAPING HELPERS
// -----------------------------------------------------------------------------

function microToHuman(microStr) {
    if (microStr == null) return null;
    const n = typeof microStr === 'string' ? parseInt(microStr, 10) : Number(microStr);
    if (!Number.isFinite(n)) return null;
    return n / 1_000_000;
}

// Normalize a BBL listing into a compact record
function shapeBblListing(nft) {
    const reservePriceRaw = nft?.auction?.reserve_price;
    return {
        token_id:      nft.token_id,
        price_bluna:   microToHuman(reservePriceRaw),
        broken:        nft.special_trait === 'BROKEN',
        name:          nft.name || null,
        image_url:     nft.nft_image_url || null,
        listed_at:     nft.auction?.created_at || nft.created_at || null,
        seller:        nft.auction?.seller || null,
    };
}

// Normalize a Boost listing into a compact record
function shapeBoostLaunch(l) {
    return {
        launch_id:     l.launch_id,
        nft_id:        l.from_nft_id,
        name:          l.name,
        from_amount:   l.from_amount,    // NFT side (usually 1 for single NFT)
        to_amount:     l.to_amount,      // requested payment amount
        to_id:         l.to_id,          // payment token contract / denom
        from_usd:      l.from_usd,
        to_usd:        l.to_usd,
        discount:      l.discount,
        launch_type:   l.launch_type,
        creator:       l.creator,
        done:          l.done,
        cancelled:     l.cancelled,
    };
}

// Detect the payment token from Boost's to_id (matches index.html's detectLockType etc).
// Returns one of: LUNA, ampLUNA, arbLUNA, bLUNA, or the raw contract.
function detectBoostPaymentToken(toId) {
    if (!toId) return 'unknown';
    const lc = toId.toLowerCase();
    if (lc === 'uluna') return 'LUNA';
    if (lc.includes('se7rv')) return 'arbLUNA';
    if (lc.includes('ecgaz')) return 'ampLUNA';
    if (lc.includes('17aj4')) return 'bLUNA';
    return toId.slice(0, 12) + '…';
}

// -----------------------------------------------------------------------------
// MARKETPLACE SNAPSHOT (current floors + listings counts)
// -----------------------------------------------------------------------------

async function captureMarketplaceSnapshot() {
    console.log('🏪 Phase 1: capturing current marketplace state...');
    const t0 = Date.now();
    const result = {
        bbl:   {},
        boost: {},
    };

    // BBL — per collection
    for (const [key, coll] of Object.entries(COLLECTIONS)) {
        if (!coll.bbl) continue;
        console.log(`  📦 BBL/${key}...`);
        const out = {
            collection_key: key,
            label: coll.label,
            contract: coll.contract,
        };
        // Collection stats (floor, volume)
        try {
            const stats = await fetchBblCollection(coll.contract);
            out.floor_bluna  = stats?.floor ?? null;
            out.volume_bluna = stats?.volume ?? null;
            out.collection_stats_raw = stats || null;
        } catch (e) {
            console.warn(`    ⚠ collection stats failed: ${e.message}`);
            out._stats_error = e.message;
        }
        // Full listings
        try {
            const { listings, totalResults } = await fetchAllBblListings(coll.contract);
            const shaped = listings.map(shapeBblListing);
            // Recompute floor from listings as cross-check
            const validPrices = shaped.map(l => l.price_bluna).filter(p => p != null);
            const floorFromListings = validPrices.length ? Math.min(...validPrices) : null;
            out.listings = shaped;
            out.listed_count = totalResults;
            out.floor_from_listings_bluna = floorFromListings;
            if (coll.has_broken) {
                out.broken_listed = shaped.filter(l => l.broken).length;
                out.unbroken_listed = shaped.filter(l => !l.broken).length;
                // Cleanest "unbroken floor" — what the page shows on the front tile
                const unbrokenPrices = shaped.filter(l => !l.broken && l.price_bluna != null).map(l => l.price_bluna);
                out.unbroken_floor_bluna = unbrokenPrices.length ? Math.min(...unbrokenPrices) : null;
            }
            console.log(`    ${shaped.length} listings (total ${totalResults}); floor ${out.floor_bluna ?? '?'} bLUNA`);
        } catch (e) {
            console.warn(`    ⚠ listings fetch failed: ${e.message}`);
            out._listings_error = e.message;
            out.listings = [];
            out.listed_count = null;
        }
        result.bbl[key] = out;
    }

    // Boost — per collection
    for (const [key, coll] of Object.entries(COLLECTIONS)) {
        if (!coll.boost) continue;
        console.log(`  📦 Boost/${key}...`);
        const out = {
            collection_key: key,
            label: coll.label,
            contract: coll.contract,
        };
        try {
            const { listings, totalCount } = await fetchBoostListings(coll.contract);
            const shaped = listings.map(shapeBoostLaunch);
            // Floor is the cheapest `to_amount` (in payment token units)
            const valid = shaped.filter(l => l.to_amount != null);
            // Group by payment token to compute per-token floor (since collections may accept different tokens)
            const byToken = {};
            for (const l of valid) {
                const tok = detectBoostPaymentToken(l.to_id);
                const amt = parseFloat(l.to_amount);
                if (!Number.isFinite(amt)) continue;
                if (!byToken[tok]) byToken[tok] = { token: tok, prices: [], usds: [] };
                byToken[tok].prices.push(amt);
                if (l.to_usd) byToken[tok].usds.push(parseFloat(l.to_usd));
            }
            for (const t of Object.values(byToken)) {
                t.floor = t.prices.length ? Math.min(...t.prices) : null;
                t.floor_usd = t.usds.length ? Math.min(...t.usds) : null;
            }
            out.listings = shaped;
            out.listed_count = totalCount;
            out.floor_by_token = byToken;
            console.log(`    ${shaped.length} listings (total ${totalCount})`);
        } catch (e) {
            console.warn(`    ⚠ Boost listings failed: ${e.message}`);
            out._listings_error = e.message;
            out.listings = [];
            out.listed_count = null;
        }
        result.boost[key] = out;
    }

    console.log(`  ✓ Marketplace snapshot in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return result;
}

// -----------------------------------------------------------------------------
// ACTIVITY FEED (7-day window)
// -----------------------------------------------------------------------------

async function captureActivity7d() {
    console.log('📡 Phase 2: fetching BBL activity feed (last 7 days)...');
    const events = await fetchBblActivityPages(ACTIVITY_PAGES);
    const sevenDaysAgoMs = Date.now() - (ACTIVITY_DAYS * 24 * 60 * 60 * 1000);
    const aDaoContract = COLLECTIONS.alliance_dao.contract;
    const plContract   = COLLECTIONS.pixelions.contract;

    const filtered = events.filter(item => {
        const t = new Date(item.timestamp || 0).getTime();
        if (!Number.isFinite(t) || t < sevenDaysAgoMs) return false;
        return item.nft_contract === aDaoContract || item.nft_contract === plContract;
    });

    filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const sales    = filtered.filter(i => i.event_type === 'settle');
    const listings = filtered.filter(i => i.event_type === 'listed');
    const cancels  = filtered.filter(i => i.event_type === 'cancel');
    console.log(`  ✓ ${filtered.length} events in last ${ACTIVITY_DAYS}d (${sales.length} sales, ${listings.length} listed, ${cancels.length} cancels)`);
    return {
        window_days: ACTIVITY_DAYS,
        events: filtered,
        counts: { sales: sales.length, listings: listings.length, cancels: cancels.length, total: filtered.length },
    };
}

// -----------------------------------------------------------------------------
// SALES HISTORY (backfill on first run, incremental after)
// -----------------------------------------------------------------------------

// Read existing yearly sales file from our data repo, if present.
async function readExistingSalesFile(year) {
    const url = `${SELF_REPO_RAW_BASE}/data/sales/nft-sales-${year}.json`;
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        return await r.json();
    } catch {
        return null;
    }
}

// Normalize a BBL settle event into a sales record.
function shapeBblSale(event) {
    const amountMicro = event.final_price ?? event.reserve_price;
    const amount = microToHuman(amountMicro);
    return {
        marketplace: 'bbl',
        nft_id: event.token_id,
        nft_contract: event.nft_contract,
        amount,
        token: 'bLUNA',   // BBL is always bLUNA per index.html assumptions
        timestamp: event.timestamp,
        tx_hash: event.tx_hash || event.transaction_hash || null,
        buyer: event.buyer || null,
        seller: event.seller || null,
    };
}

// Normalize a Boost completed launch into a sales record.
function shapeBoostSale(launch) {
    return {
        marketplace: 'boost',
        nft_id: launch.from_nft_id,
        nft_contract: launch.from_collection_id,
        launch_id: launch.launch_id,
        amount: launch.to_amount ? parseFloat(launch.to_amount) : null,
        token: detectBoostPaymentToken(launch.to_id),
        usd_at_time: launch.to_usd ? parseFloat(launch.to_usd) : null,
        timestamp: launch.completed_at || launch.updated_at || null,
        creator: launch.creator || null,
    };
}

function dedupeKey(sale) {
    if (sale.marketplace === 'bbl') {
        return `bbl:${sale.nft_contract}:${sale.nft_id}:${sale.timestamp}`;
    } else {
        return `boost:${sale.launch_id}`;
    }
}

async function captureSalesHistory(bblActivityEvents) {
    console.log('💰 Phase 3: capturing sales history...');

    // Build BBL sales from the already-fetched activity events (sales = settle events)
    const bblSales = bblActivityEvents
        .filter(e => e.event_type === 'settle')
        .filter(e => {
            // Only known collections
            return e.nft_contract === COLLECTIONS.alliance_dao.contract
                || e.nft_contract === COLLECTIONS.pixelions.contract;
        })
        .map(shapeBblSale);

    // Boost sales — fetch ALL completed launches for tracked collections (paginated)
    let boostSales = [];
    for (const [key, coll] of Object.entries(COLLECTIONS)) {
        if (!coll.boost) continue;
        try {
            const { sales } = await fetchBoostCompletedSales(coll.contract);
            console.log(`  ${key}: ${sales.length} Boost sales`);
            boostSales.push(...sales.map(shapeBoostSale));
        } catch (e) {
            console.warn(`  ⚠ Boost sales fetch for ${key} failed: ${e.message}`);
        }
    }

    // Merge with existing files year-by-year
    const allSales = [...bblSales, ...boostSales];
    const byYear = {};
    for (const s of allSales) {
        const ts = s.timestamp ? new Date(s.timestamp) : null;
        const year = (ts && !isNaN(ts)) ? ts.getUTCFullYear() : null;
        if (year == null) continue;
        if (!byYear[year]) byYear[year] = [];
        byYear[year].push(s);
    }

    // Read existing files, merge + dedupe
    const updatedYears = {};
    const yearsToTouch = Object.keys(byYear).map(Number);
    if (!yearsToTouch.includes(new Date().getUTCFullYear())) {
        yearsToTouch.push(new Date().getUTCFullYear());  // ensure current-year file exists even if empty
    }

    for (const year of yearsToTouch) {
        const existing = await readExistingSalesFile(year);
        const merged = {
            meta: {
                version: '1.0',
                year,
                generated_at: new Date().toISOString(),
                description: `aDAO NFT sales for ${year} (BBL + Boost)`,
            },
            sales: { bbl: [], boost: [] },
            year_totals: { bbl: { sales: 0, volume_bluna: 0 }, boost: { sales: 0, volume_usd: 0 } },
        };
        // Seed from existing if any
        const seen = new Set();
        if (existing) {
            for (const s of (existing.sales?.bbl || [])) {
                merged.sales.bbl.push(s);
                seen.add(`bbl:${s.nft_contract || COLLECTIONS.alliance_dao.contract}:${s.nft_id}:${s.timestamp}`);
            }
            for (const s of (existing.sales?.boost || [])) {
                merged.sales.boost.push(s);
                if (s.launch_id) seen.add(`boost:${s.launch_id}`);
            }
        }
        // Append new (deduped) for this year
        const newSales = byYear[year] || [];
        for (const s of newSales) {
            const k = dedupeKey(s);
            if (seen.has(k)) continue;
            seen.add(k);
            if (s.marketplace === 'bbl') merged.sales.bbl.push(s);
            else                          merged.sales.boost.push(s);
        }
        // Recompute year totals
        merged.year_totals.bbl.sales = merged.sales.bbl.length;
        merged.year_totals.bbl.volume_bluna = merged.sales.bbl.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
        merged.year_totals.boost.sales = merged.sales.boost.length;
        merged.year_totals.boost.volume_usd = merged.sales.boost.reduce((sum, s) => sum + (Number(s.usd_at_time) || 0), 0);
        updatedYears[year] = merged;
        console.log(`  ${year}: ${merged.sales.bbl.length} BBL + ${merged.sales.boost.length} Boost sales`);
    }

    // Build cumulative-totals (all years summed) attached to the latest year — matches existing index.html
    // expectation that the most-recent year's file carries cumulative totals.
    const cumulative = {
        through_year: Math.max(...Object.keys(updatedYears).map(Number)),
        bbl:   { total_sales: 0, total_volume_bluna: 0 },
        boost: { total_sales: 0, total_volume_usd: 0 },
    };
    // We don't have older-year totals in this run unless we read them — best-effort: sum what we have.
    for (const y of Object.keys(updatedYears).map(Number).sort()) {
        cumulative.bbl.total_sales        += updatedYears[y].year_totals.bbl.sales;
        cumulative.bbl.total_volume_bluna += updatedYears[y].year_totals.bbl.volume_bluna;
        cumulative.boost.total_sales      += updatedYears[y].year_totals.boost.sales;
        cumulative.boost.total_volume_usd += updatedYears[y].year_totals.boost.volume_usd;
    }
    cumulative.combined_sales = cumulative.bbl.total_sales + cumulative.boost.total_sales;
    // For backward-compat with index.html which reads cumulative_totals off ANY year's file,
    // attach the cumulative totals to every year we touched
    for (const y of Object.values(updatedYears)) {
        y.cumulative_totals = cumulative;
    }

    return { updatedYears, cumulative };
}

// -----------------------------------------------------------------------------
// LOAD network-and-prices for USD conversion
// -----------------------------------------------------------------------------

async function loadPrices() {
    try {
        const data = await fetchJsonWithRetry(NETWORK_PRICES_URL, 'network-and-prices', {}, 2);
        const tp = data?.token_prices || {};
        const get = (sym) => {
            const t = tp[sym];
            if (!t) return null;
            return t.final_price_usd ?? t.usd ?? t.price ?? null;
        };
        return {
            LUNA:   get('LUNA'),
            bLUNA:  get('bLUNA'),
            ampLUNA: get('ampLUNA'),
            arbLUNA: get('arbLUNA'),
        };
    } catch (e) {
        console.warn(`  ⚠ price load failed (non-fatal): ${e.message}`);
        return {};
    }
}

// -----------------------------------------------------------------------------
// GITHUB PUBLISH HELPERS (copy of bribes-history pattern)
// -----------------------------------------------------------------------------

function githubApiRequest(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'api.github.com', path: apiPath, method,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent':    'aDAO-marketplace-stats/1.0',
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
        console.log(`  ✅ ${filepath} (${(content.length / 1024).toFixed(1)} KB)`);
        return true;
    }
    console.error(`  ❌ Push failed (HTTP ${result.status}): ${result.data?.message || '<no message>'}`);
    return false;
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------

async function captureSnapshot() {
    const startedAt = new Date();
    const epoch = currentEpoch();
    console.log(`🚀 Marketplace Stats Cron — ${startedAt.toISOString()} (epoch ${epoch})`);
    console.log();

    const errors = [];

    // Load prices for USD conversion (non-fatal if unavailable)
    console.log('💱 Loading prices from network-and-prices...');
    const prices = await loadPrices();
    if (prices.bLUNA) console.log(`  ✓ bLUNA: $${prices.bLUNA.toFixed(4)}, LUNA: $${prices.LUNA?.toFixed(4)}`);
    console.log();

    // Phase 1: Marketplace snapshot (floors + listings)
    let marketplace = null;
    try {
        marketplace = await captureMarketplaceSnapshot();
        // Bubble per-collection errors up so heartbeat status reflects reality
        for (const [k, m] of Object.entries(marketplace.bbl || {})) {
            if (m._stats_error)    errors.push(`bbl/${k} stats: ${m._stats_error}`);
            if (m._listings_error) errors.push(`bbl/${k} listings: ${m._listings_error}`);
        }
        for (const [k, m] of Object.entries(marketplace.boost || {})) {
            if (m._listings_error) errors.push(`boost/${k} listings: ${m._listings_error}`);
        }
    } catch (e) {
        console.error(`❌ Marketplace snapshot failed: ${e.message}`);
        errors.push(`marketplace: ${e.message}`);
        marketplace = { bbl: {}, boost: {} };
    }
    console.log();

    // Phase 2: Activity feed (7-day) + collect events to feed Phase 3
    let activity = null;
    let bblActivityForSales = [];
    try {
        // Fetch a wider window for sales (more pages) than for the 7-day filter
        const wideEvents = await fetchBblActivityPages(ACTIVITY_PAGES);
        bblActivityForSales = wideEvents;
        const sevenDaysAgoMs = Date.now() - (ACTIVITY_DAYS * 24 * 60 * 60 * 1000);
        const aDaoC = COLLECTIONS.alliance_dao.contract;
        const plC   = COLLECTIONS.pixelions.contract;
        const filtered = wideEvents.filter(item => {
            const t = new Date(item.timestamp || 0).getTime();
            if (!Number.isFinite(t) || t < sevenDaysAgoMs) return false;
            return item.nft_contract === aDaoC || item.nft_contract === plC;
        });
        filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        const counts = {
            sales:    filtered.filter(i => i.event_type === 'settle').length,
            listings: filtered.filter(i => i.event_type === 'listed').length,
            cancels:  filtered.filter(i => i.event_type === 'cancel').length,
            total:    filtered.length,
        };
        activity = { window_days: ACTIVITY_DAYS, capturedAt: startedAt.toISOString(), counts, events: filtered };
        console.log(`📡 Activity (7d): ${counts.total} events (${counts.sales} sales, ${counts.listings} listed, ${counts.cancels} cancels)`);
    } catch (e) {
        console.error(`❌ Activity fetch failed: ${e.message}`);
        errors.push(`activity: ${e.message}`);
        activity = { window_days: ACTIVITY_DAYS, capturedAt: startedAt.toISOString(), counts: { sales: 0, listings: 0, cancels: 0, total: 0 }, events: [] };
    }
    console.log();

    // Phase 3: Sales history (backfill / incremental)
    let salesUpdate = null;
    try {
        salesUpdate = await captureSalesHistory(bblActivityForSales);
    } catch (e) {
        console.error(`❌ Sales history failed: ${e.message}`);
        errors.push(`sales: ${e.message}`);
        salesUpdate = { updatedYears: {}, cumulative: null };
    }
    console.log();

    // Build the master marketplace.json — small, fast-load for the dashboard
    const marketplaceDoc = {
        schemaVersion: 1,
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        epoch,
        prices_used: prices,
        bbl: {},
        boost: {},
        cumulative: salesUpdate.cumulative,
    };
    for (const [k, m] of Object.entries(marketplace.bbl || {})) {
        marketplaceDoc.bbl[k] = {
            contract: m.contract,
            label:    m.label,
            floor_bluna:           m.floor_bluna,
            floor_from_listings:   m.floor_from_listings_bluna,
            unbroken_floor_bluna:  m.unbroken_floor_bluna,
            listed_count:          m.listed_count,
            broken_listed:         m.broken_listed,
            unbroken_listed:       m.unbroken_listed,
            volume_bluna:          m.volume_bluna,
            floor_usd:             (m.floor_bluna && prices.bLUNA) ? m.floor_bluna * prices.bLUNA : null,
            volume_usd:            (m.volume_bluna && prices.bLUNA) ? m.volume_bluna * prices.bLUNA : null,
            error:                 m._stats_error || m._listings_error || null,
        };
    }
    for (const [k, m] of Object.entries(marketplace.boost || {})) {
        marketplaceDoc.boost[k] = {
            contract:     m.contract,
            label:        m.label,
            listed_count: m.listed_count,
            floor_by_token: m.floor_by_token,
            error:        m._listings_error || null,
        };
    }

    // Heartbeat
    const status = errors.length === 0 ? 'ok' : 'partial';
    const heartbeatDoc = {
        schemaVersion: 1,
        cron: 'marketplace-stats',
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),
        runId: `mkt-${startedAt.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
        runMode: 'hourly',
        currentEpoch: epoch,
        status,
        stats: {
            bbl_collections:   Object.keys(marketplaceDoc.bbl).length,
            boost_collections: Object.keys(marketplaceDoc.boost).length,
            activity_events_7d: activity?.counts?.total ?? 0,
            sales_years_touched: Object.keys(salesUpdate.updatedYears).length,
            cumulative_bbl_sales:   salesUpdate.cumulative?.bbl?.total_sales ?? null,
            cumulative_boost_sales: salesUpdate.cumulative?.boost?.total_sales ?? null,
            errors: errors.length,
        },
        errors: errors.length ? errors : undefined,
        next_expected_run_at: new Date(startedAt.getTime() + 60 * 60 * 1000).toISOString(),
    };

    // Publish or save locally
    if (GITHUB_TOKEN) {
        console.log('📤 Publishing to GitHub...');
        await pushToGithub('data/marketplace.json', JSON.stringify(marketplaceDoc, null, 2), `marketplace snapshot — ${status}`);
        // Per-collection full listings (in subdir to keep marketplace.json small)
        for (const [k, m] of Object.entries(marketplace.bbl || {})) {
            if (m.listings) {
                await pushToGithub(`data/listings/bbl-${k}.json`, JSON.stringify({
                    capturedAt: startedAt.toISOString(),
                    contract: m.contract,
                    listed_count: m.listed_count,
                    listings: m.listings,
                }, null, 2), `BBL listings: ${k}`);
            }
        }
        for (const [k, m] of Object.entries(marketplace.boost || {})) {
            if (m.listings) {
                await pushToGithub(`data/listings/boost-${k}.json`, JSON.stringify({
                    capturedAt: startedAt.toISOString(),
                    contract: m.contract,
                    listed_count: m.listed_count,
                    listings: m.listings,
                }, null, 2), `Boost listings: ${k}`);
            }
        }
        // Activity feed
        await pushToGithub('data/activity-7d.json', JSON.stringify(activity, null, 2), `activity 7d — ${activity?.counts?.total ?? 0} events`);
        // Sales history per-year
        const yearsTouched = Object.keys(salesUpdate.updatedYears).sort();
        for (const year of yearsTouched) {
            const yearDoc = salesUpdate.updatedYears[year];
            await pushToGithub(`data/sales/nft-sales-${year}.json`, JSON.stringify(yearDoc, null, 2),
                `sales ${year} — ${yearDoc.sales.bbl.length} BBL + ${yearDoc.sales.boost.length} Boost`);
        }
        // Sales index
        const indexDoc = {
            capturedAt: startedAt.toISOString(),
            years: yearsTouched,
            cumulative: salesUpdate.cumulative,
        };
        await pushToGithub('data/sales/index.json', JSON.stringify(indexDoc, null, 2), 'sales index update');
        // Heartbeat last (uniform freshness signal)
        await pushToGithub('data/heartbeat.json', JSON.stringify(heartbeatDoc, null, 2), `📍 marketplace-stats heartbeat — ${status}`);
    } else {
        console.log('⚠️  GITHUB_TOKEN not set — saving locally');
        fs.mkdirSync('data', { recursive: true });
        fs.mkdirSync('data/listings', { recursive: true });
        fs.mkdirSync('data/sales', { recursive: true });
        fs.writeFileSync('data/marketplace.json', JSON.stringify(marketplaceDoc, null, 2));
        for (const [k, m] of Object.entries(marketplace.bbl || {})) {
            if (m.listings) fs.writeFileSync(`data/listings/bbl-${k}.json`, JSON.stringify(m, null, 2));
        }
        for (const [k, m] of Object.entries(marketplace.boost || {})) {
            if (m.listings) fs.writeFileSync(`data/listings/boost-${k}.json`, JSON.stringify(m, null, 2));
        }
        fs.writeFileSync('data/activity-7d.json', JSON.stringify(activity, null, 2));
        for (const [year, doc] of Object.entries(salesUpdate.updatedYears)) {
            fs.writeFileSync(`data/sales/nft-sales-${year}.json`, JSON.stringify(doc, null, 2));
        }
        fs.writeFileSync('data/heartbeat.json', JSON.stringify(heartbeatDoc, null, 2));
        console.log('  Saved locally to data/');
    }

    const elapsed = (Date.now() - startedAt.getTime()) / 1000;
    console.log(`\n${status === 'ok' ? '✅' : '⚠️ '} Done (${elapsed.toFixed(1)}s, status=${status}, errors=${errors.length})`);
    if (errors.length) {
        console.log('Errors:');
        errors.forEach(e => console.log(`  - ${e}`));
    }
}

// -----------------------------------------------------------------------------
// ENTRY POINT
// -----------------------------------------------------------------------------

if (require.main === module) {
    captureSnapshot().catch(e => {
        console.error(`❌ FATAL: ${e.message}`);
        console.error(e.stack);
        process.exit(1);
    });
}

module.exports = {
    captureSnapshot,
    captureMarketplaceSnapshot,
    captureActivity7d,
    captureSalesHistory,
    fetchBblListings,
    fetchBoostListings,
    fetchBblActivity,
    fetchBoostCompletedSales,
};
