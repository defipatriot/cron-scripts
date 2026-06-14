// =============================================================================
// Network & Prices Cron (v2 — with dual price sources + match quality)
// =============================================================================
//
// Captures a daily snapshot of:
//   1. Terra network state (LCD direct queries)
//   2. LUNA market data (CoinGecko detail endpoint)
//   3. LST exchange rates (chain queries to each LST hub contract)
//   4. Token USD prices from TWO independent oracle sources:
//        a) Astroport's `tokens.getMetrics` — DEX-implied prices (one bulk call)
//        b) CoinGecko's `simple/price` — third-party reference (one bulk call)
//      Plus calculated LST prices via base × ratio.
//
// For each tracked token, the output shows BOTH source prices side-by-side
// with a computed delta and a `match_quality` classification:
//
//   direct_match        — both sources agree within ±5%
//   minor_disagreement  — sources differ 5-25%
//   flagged_mismatch    — sources differ >25% (likely one is stale/broken)
//   bridged_proxy       — CG price came via bridge fallback (e.g. wBTC.axl → WBTC)
//   astroport_only      — Astroport has it, CG doesn't
//   cg_only             — CG has it, Astroport doesn't price it
//   calculated          — chain-derived via base × ratio (LSTs)
//   no_price            — neither source has a price
//
// This is the "oracle reference" file. Downstream tla-snapshot consumes it.
//
// Runtime: Node 18+ (built-in fetch). CommonJS, no dependencies.
// =============================================================================

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------

const TERRA_LCD_PRIMARY  = 'https://terra-lcd.publicnode.com';
const TERRA_LCD_FALLBACK = 'https://terra-rest.publicnode.com';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const COINGECKO_LUNA_DETAIL = `${COINGECKO_BASE}/coins/terra-luna-2?localization=false&tickers=false&community_data=false&developer_data=false`;
// IMPORTANT: precision=18 prevents tiny values like ROAR ($0.00000027) from rounding to $0.
const COINGECKO_SIMPLE_BASE = `${COINGECKO_BASE}/simple/price?precision=18&include_24hr_change=true&vs_currencies=usd`;

const ASTROPORT_METRICS_URL = (() => {
    const input = encodeURIComponent(JSON.stringify({ json: { chainId: ['phoenix-1', 'neutron-1'] } }));
    return `https://app.astroport.fi/api/trpc/tokens.getMetrics?input=${input}`;
})();

// LST hub contracts and how to query them.
const LST_HUBS = {
    ampLUNA: { hub: 'terra10788fkzah89xrdm27zkj5yvhj9x3494lxawzm5qq3vvxcqz2yzaqyd3enk',
        query: { exchange_rates: {} }, parseRatio: (d) => parseFloat(d?.exchange_rates?.[0]?.[1] || 0), baseToken: 'LUNA' },
    arbLUNA: { hub: 'terra1r9gls56glvuc4jedsvc3uwh6vj95mqm9efc7hnweqxa2nlme5cyqxygy5m',
        query: { state: {} }, parseRatio: (d) => parseFloat(d?.exchange_rate || 0), baseToken: 'LUNA' },
    ampROAR: { hub: 'terra1vklefn7n6cchn0u962w3gaszr4vf52wjvd4y95t2sydwpmpdtszsqvk9wy',
        query: { state: {} }, parseRatio: (d) => parseFloat(d?.exchange_rate || 0), baseToken: 'ROAR' },
    ampCAPA: { hub: 'terra186rpfczl7l2kugdsqqedegl4es4hp624phfc7ddy8my02a4e8lgq5rlx7y',
        query: { state: {} }, parseRatio: (d) => parseFloat(d?.exchange_rate || 0), baseToken: 'CAPA' },
    bLUNA:   { hub: 'terra1l2nd99yze5fszmhl5svyh5fky9wm4nz4etlgnztfu4e8809gd52q04n3ea',
        query: { state: {} }, parseRatio: (d) => parseFloat(d?.exchange_rate || 0), baseToken: 'LUNA' },
};

// xASTRO config (Astroport TRPC, Neutron-side).
const ASTRO_DENOM_NEUTRON  = 'factory/neutron1ffus553eet978k024lmssw0czsxwr97mggyv85lpcsdkft8v9ufsz3sa07/astro';
const XASTRO_DENOM_NEUTRON = 'factory/neutron1zlf3hutsa4qnmue53lz2tfxrutp8y2e3rj4nkghg3rupgl4mqy8s5jgxsn/xASTRO';

// =============================================================================
// TOKEN REGISTRY
// =============================================================================
// Each token can have addresses on multiple chains. The Astroport metrics
// endpoint is keyed by chain address, so we need to know each token's address
// per chain in order to read its DEX-implied price.
//
// `preferChain` controls which chain's Astroport price wins when a token is
// listed on multiple chains (e.g. ASTRO is on both phoenix-1 and neutron-1,
// but neutron-1 is the "real" market — phoenix-1's price is currently stale).
//
// `cgId` is the CoinGecko ID for the simple/price endpoint.
//
// `bridgedFrom` indicates this token uses its base token's CG price as a proxy
// (e.g. wBTC.axl uses WBTC). Surfaces in match_quality as 'bridged_proxy'.

const TOKEN_REGISTRY = {
    LUNA:    { cgId: 'terra-luna-2',         astroportAddresses: { 'phoenix-1': 'uluna' }, preferChain: 'phoenix-1' },
    // All IBC denom → base traces verified via /ibc/apps/transfer/v1/denom_traces.
    // USDC: Noble USDC via channel-253. There's also a channel-6 variant (B3504E0...);
    //       we use channel-253 because it has more TVL on Astroport.
    USDC:    { cgId: 'usd-coin',             astroportAddresses: { 'phoenix-1': 'ibc/2C962DAB9F57FE0921435426AE75196009FAA1981BF86991203C8411F8980FDB' }, preferChain: 'phoenix-1' },
    // USDT: erc20/tether/usdt via channel-272 (Astroport prices this one)
    USDT:    { cgId: 'tether',               astroportAddresses: { 'phoenix-1': 'ibc/9B19062D46CAB50361CE9B0A3E6D0A7A53AC9E7CB361F32A73CC733144A9A9E5' }, preferChain: 'phoenix-1' },
    WBTC:    { cgId: 'wrapped-bitcoin',      astroportAddresses: { 'phoenix-1': 'ibc/88386AC48152D48B34B082648DF836F975506F0B57DBBFC10A54213B1BF484CB' }, preferChain: 'phoenix-1' },
    PAXG:    { cgId: 'pax-gold',             astroportAddresses: { 'phoenix-1': 'ibc/0EF5630576C66968EF0787868CF09FD866FAD131BC148D24A148358A85F0EB62' }, preferChain: 'phoenix-1' },
    // EURE: ueure native, channel-253 from Noble
    EURE:    { cgId: 'euroe-stablecoin',     astroportAddresses: { 'phoenix-1': 'ibc/8D52B251B447B7160421ACFBD50F6B0ABE5F98D2C404B03701130F12044439A1' }, preferChain: 'phoenix-1' },
    INJ:     { cgId: 'injective-protocol',   astroportAddresses: {}, preferChain: null },
    ATOM:    { cgId: 'cosmos',               astroportAddresses: { 'phoenix-1': 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2' }, preferChain: 'phoenix-1' },
    ETH:     { cgId: 'ethereum',             astroportAddresses: { 'phoenix-1': 'ibc/20850C646CDDDC2270E9BBDB08558B5FEE57B647EC6827F41096AABFD8A0471B' }, preferChain: 'phoenix-1' },
    WETH:    { cgId: 'ethereum',             astroportAddresses: {}, preferChain: null },
    WSTETH:  { cgId: 'wrapped-steth',        astroportAddresses: { 'phoenix-1': 'ibc/A356EC90DC3AE43D485514DA7260EDC7ABB5CFAA0654CE2524C739392975AD3C' }, preferChain: 'phoenix-1' },
    BNB:     { cgId: 'binancecoin',          astroportAddresses: { 'phoenix-1': 'ibc/1319C6B38CA613C89D78C2D1461B305038B1085F6855E8CD276FE3F7C9600B4C' }, preferChain: 'phoenix-1' },
    WBNB:    { cgId: 'wbnb',                 astroportAddresses: {}, preferChain: null },
    OSMO:    { cgId: 'osmosis',              astroportAddresses: {}, preferChain: null },
    STLUNA:  { cgId: 'stride-staked-luna',   astroportAddresses: {}, preferChain: null },
    STATOM:  { cgId: 'stride-staked-atom',   astroportAddresses: {}, preferChain: null },
    // SOLID: native cw20 on Terra. (Old config had wrong IBC denom for ampWHALE labeled as SOLID.)
    SOLID:   { cgId: 'solid-2',              astroportAddresses: { 'phoenix-1': 'terra10aa3zdkrc7jwuf8ekl3zq7e7m42vmzqehcmu74e4egc7xkm5kr2s0muyst' }, preferChain: 'phoenix-1' },
    SWTH:    { cgId: 'switcheo',             astroportAddresses: {}, preferChain: null },
    ROAR:    { cgId: 'lion-dao',             astroportAddresses: { 'phoenix-1': 'terra1lxx40s29qvkrcj8fsa3yzyehy7w50umdvvnls2r830rys6lu2zns63eelv' }, preferChain: 'phoenix-1' },
    // CAPA: real Astroport-priced address is the wrapped variant, NOT the original cw20.
    // Verified live 2026-05-13 via HAR-trace.
    CAPA:    { cgId: 'capapult',             astroportAddresses: { 'phoenix-1': 'terra1t4p3u8khpd7f8qzurwyafxt648dya6mp6vur3vaapswt6m24gkuqrfdhar' }, preferChain: 'phoenix-1' },
    // ASTRO: Terra-side price is broken/stale ($0.00776 vs CG $0.00111). Neutron-side
    // matches CG closely ($0.00102 vs $0.00111). Always prefer Neutron for ASTRO.
    ASTRO:   { cgId: 'astroport-fi', astroportAddresses: {
        'phoenix-1': 'terra1nsuqsk6kh58ulczatwev87ttq2z6r3pusulg9r24mfj2fvtzd4uq3exn26',
        'neutron-1': ASTRO_DENOM_NEUTRON,
    }, preferChain: 'neutron-1' },
    xASTRO:  { cgId: null, astroportAddresses: { 'neutron-1': XASTRO_DENOM_NEUTRON }, preferChain: 'neutron-1' },
};

// Calculated tokens — derived as `basePrice × chainRatio` for LSTs.
// Note: these are added IN ADDITION to whatever Astroport/CG might report.
// The chain-derived calculation is generally most trustworthy for LSTs since
// CG often lags ratio updates and Astroport may not list the LST at all.
const CALCULATED_TOKENS = {
    ampLUNA:  { base: 'LUNA',  ratioKey: 'ampLUNA'  },
    arbLUNA:  { base: 'LUNA',  ratioKey: 'arbLUNA'  },
    bLUNA:    { base: 'LUNA',  ratioKey: 'bLUNA'    },
    ampCAPA:  { base: 'CAPA',  ratioKey: 'ampCAPA'  },
    ampROAR:  { base: 'ROAR',  ratioKey: 'ampROAR'  },
    // xASTRO: skip calculated derivation; Astroport provides ratio + xASTRO USD directly.
};

// Astroport MARKET addresses for the calculated LSTs that actually trade on a
// market (phoenix-1). The hub ratio is the THEORETICAL backing; for clean staking
// derivatives (ampLUNA/bLUNA) market ≈ hub, but for STRATEGY tokens (arbLUNA =
// arbitrage; amp* = compounding strategies) the market can trade meaningfully
// BELOW the theoretical ratio. We look up the market price, compute divergence,
// and surface BOTH so a price gap is visible (and we can flag it) instead of
// silently overvaluing. Discovered 2026-06-14: arbLUNA hub-ratio price ran ~14%
// above market (vs Votion's own UI). See NOTE-arbLUNA-pricing-gap.md.
const CALCULATED_LST_MARKET_ADDR = {
    arbLUNA: { 'phoenix-1': 'terra1se7rvuerys4kd2snt6vqswh9wugu49vhyzls8ymc02wl37g2p2ms5yz490' },
    ampLUNA: { 'phoenix-1': 'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct' },
    bLUNA:   { 'phoenix-1': 'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml' },
    // ampCAPA / ampROAR market addresses TBD — add if Astroport lists them, so the
    // divergence check can confirm whether they share arbLUNA's gap.
};
// Divergence threshold: if market is more than this % from the hub-ratio price,
// flag it. arbLUNA's gap was ~14%, so 5% is a sensible alarm line.
const LST_PRICE_DIVERGENCE_FLAG_PCT = 2;   // within 2% = agreement (use robust hub); beyond = real gap (use market, show both)

// Match quality thresholds (delta-pct between Astroport and CoinGecko)
const MATCH_DIRECT_THRESHOLD_PCT  = 5;    // within ±5% → direct_match
const MATCH_MINOR_THRESHOLD_PCT   = 25;   // within ±25% → minor_disagreement
                                          // anything beyond → flagged_mismatch

// Cron refresh cadence — Render runs this every hour. The output includes
// `nextRefreshExpectedAt` so the dashboard can show a countdown timer to next
// data refresh. Used for "Next update in 47m" displays.
// Aligns with deving.zones NFT data which also updates hourly.
const REFRESH_INTERVAL_HOURS = 1;
const REFRESH_INTERVAL_MS = REFRESH_INTERVAL_HOURS * 60 * 60 * 1000;

// HTTP / GitHub config
const HTTP_TIMEOUT_MS = 20000;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/network-and-prices-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// -----------------------------------------------------------------------------
// HTTP HELPERS
// -----------------------------------------------------------------------------

async function fetchJson(url, label = url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json', 'User-Agent': 'aDAO-network-prices/2.0' },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${body.slice(0, 120)}`);
        }
        return await res.json();
    } catch (e) {
        if (e.name === 'AbortError') throw new Error(`Timeout (${label})`);
        throw e;
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchJsonWithRetry(url, label, maxTries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
            return await fetchJson(url, label);
        } catch (e) {
            lastErr = e;
            if (attempt < maxTries) {
                const delay = Math.pow(3, attempt - 1) * 1000;
                console.log(`  ⏳ ${label} attempt ${attempt} failed (${e.message.slice(0, 60)}), retry in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}

async function lcdGet(path) {
    const tryLcd = async (base) => fetchJson(`${base}${path}`, `LCD ${path.split('?')[0].split('/').slice(-1)[0]}`);
    try {
        return await tryLcd(TERRA_LCD_PRIMARY);
    } catch (e1) {
        console.log(`  ⏳ primary LCD failed (${e1.message.slice(0, 60)}), trying fallback`);
        return await tryLcd(TERRA_LCD_FALLBACK);
    }
}

async function queryContract(contractAddr, queryObj) {
    const queryB64 = Buffer.from(JSON.stringify(queryObj)).toString('base64');
    const data = await lcdGet(`/cosmwasm/wasm/v1/contract/${contractAddr}/smart/${queryB64}`);
    return data?.data;
}

// -----------------------------------------------------------------------------
// PHASE 1: TERRA NETWORK STATS
// -----------------------------------------------------------------------------

async function fetchTerraNetworkStats() {
    console.log('📊 Fetching Terra network stats from LCD...');
    const [supply, pool, validators, mintParams, distParams, block, annualProv] = await Promise.all([
        lcdGet('/cosmos/bank/v1beta1/supply/by_denom?denom=uluna'),
        lcdGet('/cosmos/staking/v1beta1/pool'),
        lcdGet('/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=500'),
        lcdGet('/cosmos/mint/v1beta1/inflation'),
        lcdGet('/cosmos/distribution/v1beta1/params'),
        lcdGet('/cosmos/base/tendermint/v1beta1/blocks/latest'),
        lcdGet('/cosmos/mint/v1beta1/annual_provisions'),
    ]);

    const totalSupplyU = Number(supply.amount.amount);
    const bondedU      = Number(pool.pool.bonded_tokens);
    const notBondedU   = Number(pool.pool.not_bonded_tokens);
    const percentStaked = totalSupplyU > 0 ? (bondedU / totalSupplyU) * 100 : 0;

    const tokens = validators.validators.map(v => Number(v.tokens)).filter(t => t > 0).sort((a, b) => b - a);
    const totalBonded = tokens.reduce((s, t) => s + t, 0);
    const top5 = tokens.slice(0, 5).map(t => totalBonded > 0 ? (t / totalBonded) * 100 : 0);

    let cumul = 0, nakamoto = 0;
    for (const t of tokens) { cumul += t; nakamoto++; if (totalBonded > 0 && cumul / totalBonded > 1 / 3) break; }

    const n = tokens.length;
    const asc = [...tokens].reverse();
    let sumCum = 0, runningTotal = 0;
    for (const t of asc) { runningTotal += t; sumCum += runningTotal; }
    const gini = (totalBonded > 0 && n > 0) ? (n + 1 - 2 * sumCum / totalBonded) / n : 0;

    const inflation = Number(mintParams.inflation);
    const commTax   = Number(distParams.params.community_tax);
    const annualProvU = Number(annualProv.annual_provisions);
    const stakingApr = bondedU > 0 ? (annualProvU / bondedU) * (1 - commTax) * 100 : 0;
    const aprDec = stakingApr / 100;
    const stakingApyWeekly = stakingApr > 0 ? (Math.pow(1 + aprDec / 52, 52) - 1) * 100 : 0;
    const stakingApyDaily  = stakingApr > 0 ? (Math.pow(1 + aprDec / 365, 365) - 1) * 100 : 0;

    console.log(`  ✓ supply ${(totalSupplyU/1e6).toLocaleString()} LUNA, bonded ${percentStaked.toFixed(2)}%, APR ${stakingApr.toFixed(2)}%`);
    console.log(`  ✓ ${n} active validators, top-5 ${top5.reduce((s,p)=>s+p,0).toFixed(1)}%, nakamoto ${nakamoto}`);

    return {
        total_supply_uluna: totalSupplyU, total_supply_luna: totalSupplyU / 1e6,
        bonded_tokens_uluna: bondedU, bonded_tokens_luna: bondedU / 1e6,
        not_bonded_tokens_luna: notBondedU / 1e6, percent_staked: percentStaked,
        inflation, community_tax: commTax, annual_provisions_uluna: annualProvU,
        staking_apr: stakingApr, staking_apy_weekly: stakingApyWeekly, staking_apy_daily: stakingApyDaily,
        gini, nakamoto_index: nakamoto, active_validators: n, top_5_voting_power_pct: top5,
        validators: validators.validators.map(v => ({
            operator_address: v.operator_address,
            moniker: v.description?.moniker || '',
            tokens: Number(v.tokens),
            commission_rate: Number(v.commission?.commission_rates?.rate || 0),
            jailed: v.jailed, status: v.status,
        })),
        latest_block_height: Number(block.block.header.height),
        latest_block_time: block.block.header.time,
    };
}

// -----------------------------------------------------------------------------
// PHASE 2: LUNA MARKET FROM COINGECKO
// -----------------------------------------------------------------------------

async function fetchLunaMarketFromCoinGecko() {
    console.log('📊 Fetching LUNA market data from CoinGecko...');
    try {
        const data = await fetchJsonWithRetry(COINGECKO_LUNA_DETAIL, 'CG LUNA detail');
        const md = data.market_data || {};
        const result = {
            usd_price: md.current_price?.usd ?? null,
            usd_market_cap: md.market_cap?.usd ?? null,
            usd_fdv: md.fully_diluted_valuation?.usd ?? null,
            circulating_supply: md.circulating_supply ?? null,
            total_supply: md.total_supply ?? null,
            price_change_pct_24h: md.price_change_percentage_24h ?? null,
            price_change_pct_7d: md.price_change_percentage_7d ?? null,
            price_change_pct_30d: md.price_change_percentage_30d ?? null,
            ath_usd: md.ath?.usd ?? null, atl_usd: md.atl?.usd ?? null,
        };
        console.log(`  ✓ LUNA $${result.usd_price?.toFixed(6)} (24h ${result.price_change_pct_24h?.toFixed(2)}%, 7d ${result.price_change_pct_7d?.toFixed(2)}%)`);
        return result;
    } catch (e) {
        console.log(`  ⚠ CoinGecko LUNA failed: ${e.message.slice(0, 80)}`);
        return null;
    }
}

// -----------------------------------------------------------------------------
// PHASE 3: LST EXCHANGE RATES FROM CHAIN
// -----------------------------------------------------------------------------

async function fetchLstRatios() {
    console.log('📊 Fetching LST exchange rates from chain...');
    const ratios = {}, errors = {};

    for (const [token, config] of Object.entries(LST_HUBS)) {
        try {
            const data = await queryContract(config.hub, config.query);
            const ratio = config.parseRatio(data);
            if (!ratio || !Number.isFinite(ratio) || ratio <= 0) throw new Error(`invalid ratio: ${ratio}`);
            ratios[token] = { ratio, hub: config.hub, base_token: config.baseToken, source: 'eris-hub-chain', fetched_at: new Date().toISOString() };
            console.log(`  ✓ ${token}: 1 = ${ratio.toFixed(6)} ${config.baseToken}`);
        } catch (e) {
            errors[token] = e.message;
            console.log(`  ✗ ${token} failed: ${e.message.slice(0, 60)}`);
        }
    }

    // xASTRO — Astroport TRPC (different mechanism)
    try {
        const xast = await fetchXastroFromAstroport();
        if (xast) {
            ratios.xASTRO = {
                ratio: xast.ratio, base_token: 'ASTRO', source: 'astroport-trpc',
                apr_week: xast.weekApr, apy_week: xast.weekApy, apr_day: xast.dayApr, apy_day: xast.dayApy,
                astro_usd: xast.astroUsd, xastro_usd: xast.xastroUsd,
                updated_at: xast.updatedAt, fetched_at: new Date().toISOString(),
            };
            console.log(`  ✓ xASTRO: ratio ${xast.ratio?.toFixed(6)} (week APY ${xast.weekApy?.toFixed(4)}%)`);
        }
    } catch (e) {
        errors.xASTRO = e.message;
        console.log(`  ✗ xASTRO failed: ${e.message.slice(0, 80)}`);
    }

    return { ratios, errors };
}

async function fetchXastroFromAstroport() {
    const mk = (obj) => encodeURIComponent(JSON.stringify({ json: obj }));
    const [apyR, astroR, xastroR] = await Promise.allSettled([
        fetchJson(`https://app.astroport.fi/api/trpc/protocol.stakingApy?input=${mk({ chainId: 'neutron-1' })}`, 'stakingApy'),
        fetchJson(`https://app.astroport.fi/api/trpc/tokens.getPrice?input=${mk({ chainId: 'neutron-1', tokenAddress: ASTRO_DENOM_NEUTRON })}`, 'ASTRO price'),
        fetchJson(`https://app.astroport.fi/api/trpc/tokens.getPrice?input=${mk({ chainId: 'neutron-1', tokenAddress: XASTRO_DENOM_NEUTRON })}`, 'xASTRO price'),
    ]);

    if (apyR.status !== 'fulfilled') throw new Error(`stakingApy: ${apyR.reason?.message || 'unknown'}`);
    const apyData = apyR.value?.result?.data?.json;
    if (!apyData) throw new Error('stakingApy: empty payload');

    const parsePrice = (s) => {
        if (s.status !== 'fulfilled') return null;
        const p = Number(s.value?.result?.data?.json);
        return Number.isFinite(p) && p > 0 ? p : null;
    };
    const astroUsd = parsePrice(astroR), xastroUsd = parsePrice(xastroR);
    const ratio = (astroUsd && xastroUsd) ? (xastroUsd / astroUsd) : null;

    return {
        weekApy: Number(apyData.weekApy), weekApr: Number(apyData.weekApr),
        dayApy: Number(apyData.dayApy), dayApr: Number(apyData.dayApr),
        astroUsd, xastroUsd, ratio,
        updatedAt: apyData.updatedAt || apyData.blockTimestamp || null,
    };
}

// -----------------------------------------------------------------------------
// PHASE 4: ASTROPORT METRICS — bulk DEX-implied prices
// -----------------------------------------------------------------------------
//
// One call returns all 600+ tokens that Astroport has price data for on
// both phoenix-1 and neutron-1. Returns keyed-by-address; each token has
// a `series` of {time, value} points where the LAST is the current price.

async function fetchAstroportMetrics() {
    console.log('📊 Fetching Astroport DEX prices (tokens.getMetrics)...');
    try {
        const data = await fetchJsonWithRetry(ASTROPORT_METRICS_URL, 'Astroport metrics');
        const byChain = data?.result?.data?.json || {};
        const tokenCount = Object.values(byChain).reduce((s, c) => s + Object.keys(c).length, 0);
        console.log(`  ✓ ${tokenCount} tokens across ${Object.keys(byChain).length} chains`);
        return byChain;
    } catch (e) {
        console.log(`  ⚠ Astroport metrics failed: ${e.message.slice(0, 80)}`);
        return null;
    }
}

// Extract latest price + full 7-day series from a token's metrics entry.
// Astroport samples each token's price every 4 hours and exposes the last 7
// days (~43 points). We preserve the full series so the dashboard can render
// a 7-day chart without making additional API calls.
function getAstroportPrice(astroData, chain, address) {
    if (!astroData || !astroData[chain]) return null;
    const tok = astroData[chain][address];
    if (!tok) return null;
    const series = tok.series;
    if (!Array.isArray(series) || series.length === 0) return null;
    const latest = series[series.length - 1];
    const price = Number(latest?.value);
    if (!Number.isFinite(price) || price < 0) return null;
    // Normalize series to a smaller per-point shape (omit nulls, round timestamps to seconds).
    const compactSeries = series
        .filter(p => p && p.value != null && Number.isFinite(Number(p.value)))
        .map(p => ({ t: Math.round(p.time), v: Number(p.value) }));
    return {
        price_usd: price,
        timestamp: latest.time,
        tvl_raw: tok.tvl,
        volume_raw: tok.volume,
        price_change_24h_pct: tok.priceChange24h != null ? tok.priceChange24h * 100 : null,
        price_change_7d_pct: tok.priceChange7d != null ? tok.priceChange7d * 100 : null,
        series: compactSeries,
        series_points: compactSeries.length,
    };
}

// -----------------------------------------------------------------------------
// PHASE 5: COINGECKO BULK PRICES
// -----------------------------------------------------------------------------
//
// One call fetches all tracked CG-listed tokens with precision=18 (so tiny
// values like ROAR's $0.00000027 don't round to $0).

async function fetchCoingeckoBulk() {
    console.log('📊 Fetching CoinGecko bulk prices...');
    const cgIds = [...new Set(Object.values(TOKEN_REGISTRY).map(t => t.cgId).filter(Boolean))];
    if (cgIds.length === 0) return {};

    const url = `${COINGECKO_SIMPLE_BASE}&ids=${cgIds.join(',')}`;
    try {
        const data = await fetchJsonWithRetry(url, 'CG simple price');
        console.log(`  ✓ ${Object.keys(data).length} tokens priced`);
        return data;
    } catch (e) {
        console.log(`  ⚠ CoinGecko bulk failed: ${e.message.slice(0, 80)}`);
        return {};
    }
}

// -----------------------------------------------------------------------------
// PHASE 6: ASSEMBLE PER-TOKEN PRICE TABLE WITH MATCH-QUALITY
// -----------------------------------------------------------------------------

function classifyMatchQuality(astroPrice, cgPrice) {
    // Both sources have a price → check delta
    if (astroPrice != null && cgPrice != null) {
        if (astroPrice === 0 && cgPrice === 0) return { quality: 'both_zero',         delta_pct: 0 };
        if (astroPrice === 0)                  return { quality: 'astroport_zero_cg_only', delta_pct: null };
        if (cgPrice === 0)                     return { quality: 'cg_zero_astroport_only', delta_pct: null };

        // Delta computed against CoinGecko reference (since CG is the third-party
        // benchmark). +X% means Astroport is X% higher than CG.
        const delta = (astroPrice - cgPrice) / cgPrice * 100;
        const absDelta = Math.abs(delta);
        if (absDelta <= MATCH_DIRECT_THRESHOLD_PCT)  return { quality: 'direct_match',        delta_pct: delta };
        if (absDelta <= MATCH_MINOR_THRESHOLD_PCT)   return { quality: 'minor_disagreement',  delta_pct: delta };
        return { quality: 'flagged_mismatch', delta_pct: delta };
    }
    if (astroPrice != null) return { quality: 'astroport_only', delta_pct: null };
    if (cgPrice != null)    return { quality: 'cg_only',        delta_pct: null };
    return { quality: 'no_price', delta_pct: null };
}

// Pick the "best" price from available sources. Logic:
//   - calculated (LSTs) → always use the calculation (most accurate, real-time)
//   - direct_match → use Astroport (DEX-implied is the truth for swaps)
//   - flagged_mismatch → prefer CoinGecko (Astroport oracle likely broken)
//   - astroport_only / cg_only → use whichever has it
function pickFinalPrice(astroPrice, cgPrice, matchQuality) {
    switch (matchQuality) {
        case 'direct_match':
        case 'minor_disagreement':
            return { price: astroPrice, source: 'astroport' };
        case 'flagged_mismatch':
            return { price: cgPrice, source: 'coingecko (astroport flagged stale)' };
        case 'astroport_only':
            return { price: astroPrice, source: 'astroport' };
        case 'cg_only':
        case 'astroport_zero_cg_only':
            return { price: cgPrice, source: 'coingecko' };
        case 'cg_zero_astroport_only':
            return { price: astroPrice, source: 'astroport' };
        default:
            return { price: null, source: 'none' };
    }
}

function assemblePriceTable({ astroData, cgData, lstRatios }) {
    console.log('📊 Assembling per-token price table...');
    const tokens = {};

    for (const [symbol, config] of Object.entries(TOKEN_REGISTRY)) {
        // Pull Astroport price from the preferred chain (or first available)
        let astroPrice = null;
        let astroChain = null;
        let astroExtra = {};
        let astroSeries = null;        // 7-day price-history points for charts
        const chainOrder = config.preferChain
            ? [config.preferChain, ...Object.keys(config.astroportAddresses).filter(c => c !== config.preferChain)]
            : Object.keys(config.astroportAddresses);
        const allAstroPrices = {};   // for full transparency, capture EVERY chain's price
        for (const chain of chainOrder) {
            const addr = config.astroportAddresses[chain];
            const result = getAstroportPrice(astroData, chain, addr);
            if (result) {
                allAstroPrices[chain] = {
                    price_usd: result.price_usd,
                    address: addr,
                    price_change_24h_pct: result.price_change_24h_pct,
                    price_change_7d_pct: result.price_change_7d_pct,
                    timestamp: result.timestamp,
                    series_points: result.series_points,
                };
                if (astroPrice == null) {
                    astroPrice = result.price_usd;
                    astroChain = chain;
                    astroExtra = result;
                    astroSeries = result.series;
                }
            }
        }

        // Pull CG price
        let cgPrice = null;
        let cgExtra = {};
        if (config.cgId && cgData[config.cgId]) {
            cgPrice = Number(cgData[config.cgId].usd);
            if (!Number.isFinite(cgPrice)) cgPrice = null;
            cgExtra = {
                price_change_24h_pct: cgData[config.cgId].usd_24h_change ?? null,
            };
        }

        // Classify and pick final
        const { quality, delta_pct } = classifyMatchQuality(astroPrice, cgPrice);
        const final = pickFinalPrice(astroPrice, cgPrice, quality);

        tokens[symbol] = {
            canonical: symbol,
            prices: {
                astroport: astroPrice != null ? {
                    price_usd: astroPrice,
                    chain: astroChain,
                    address: config.astroportAddresses[astroChain],
                    price_change_24h_pct: astroExtra.price_change_24h_pct,
                    price_change_7d_pct: astroExtra.price_change_7d_pct,
                    all_chains: allAstroPrices,   // every chain we found this token on
                    // 7-day price series at 4-hour resolution (~42 points).
                    // Schema: [{t: unix_seconds, v: usd_price}, ...]
                    // Use this to render dashboard charts without extra API calls.
                    series: astroSeries,
                } : { available: false },
                coingecko: cgPrice != null ? {
                    price_usd: cgPrice,
                    cg_id: config.cgId,
                    price_change_24h_pct: cgExtra.price_change_24h_pct,
                    match_type: 'direct',
                    source_url: `${COINGECKO_BASE}/coins/${config.cgId}`,
                } : { available: false },
            },
            match_quality: quality,
            astroport_vs_cg_delta_pct: delta_pct,
            final_price_usd: final.price,
            final_source: final.source,
        };
    }

    // Add calculated LSTs (ampLUNA, arbLUNA, etc.)
    let calcCount = 0;
    for (const [symbol, config] of Object.entries(CALCULATED_TOKENS)) {
        const basePrice = tokens[config.base]?.final_price_usd;
        const ratioObj = lstRatios?.[config.ratioKey];
        if (!basePrice || !ratioObj) continue;

        const calcPrice = basePrice * ratioObj.ratio;

        // Strategy-LST divergence check: does Astroport also price this LST on the
        // open market? If so, the market price is what users actually transact at.
        // For clean LSTs (ampLUNA/bLUNA) market≈hub; for strategy LSTs (arbLUNA,
        // amp*) it can run well below. We surface BOTH + a divergence flag rather
        // than silently overvaluing. (Non-breaking: `final_price_usd` stays the
        // calculated price for now — flip per-LST only after the divergence data
        // confirms the gap on a real run. See NOTE-arbLUNA-pricing-gap.md.)
        let marketBlock = null, divergencePct = null, divergenceFlagged = false;
        const mAddrByChain = CALCULATED_LST_MARKET_ADDR[symbol];
        if (mAddrByChain) {
            for (const [chain, addr] of Object.entries(mAddrByChain)) {
                const mpRes = getAstroportPrice(astroData, chain, addr);   // returns {price_usd,...} or null
                const mp = mpRes && mpRes.price_usd;
                if (mp && mp > 0) {
                    marketBlock = { price_usd: mp, chain, address: addr, source: 'astroport-market' };
                    divergencePct = ((calcPrice - mp) / mp) * 100;   // + = our calc is HIGH vs market
                    divergenceFlagged = Math.abs(divergencePct) > LST_PRICE_DIVERGENCE_FLAG_PCT;
                    break;
                }
            }
        }

        const pricesObj = {
            calculated: {
                price_usd: calcPrice,
                formula: `${config.base} × ${ratioObj.ratio.toFixed(6)}`,
                base_token: config.base,
                base_price: basePrice,
                ratio: ratioObj.ratio,
                ratio_source: ratioObj.source,
            },
        };
        if (marketBlock) pricesObj.market = marketBlock;

        // PRICE SELECTION — corrected 2026-06-14 after CoinGecko ground-truth check.
        // LESSON: hub-ratio (LUNA × eris ratio) is PROVEN ACCURATE — it matches
        // CoinGecko within ~1.6% for arbLUNA. The single Astroport pool price we
        // read can be thin/stale/manipulated (it read ~11% LOW for arbLUNA, the
        // outlier). So:
        //  - hub-ratio is PRIMARY and stays as final_price_usd (robust + accurate).
        //  - the single-pool "market" price is a WEAK cross-check: we surface it and
        //    compute the spread, but we DO NOT flip to it (a thin pool must not
        //    override the proven hub price).
        //  - we only FLAG a divergence for human review when the gap is large
        //    (>10%), as a data-quality signal that the pool may be broken OR the
        //    asset genuinely depegged — but we still hold hub as final until a
        //    TRUSTWORTHY source (CoinGecko) confirms otherwise.
        const REVIEW_FLAG_PCT = 10;
        const reviewFlagged = marketBlock && Math.abs(divergencePct) > REVIEW_FLAG_PCT;

        tokens[symbol] = {
            canonical: symbol,
            prices: pricesObj,
            match_quality: 'calculated',
            astroport_vs_cg_delta_pct: null,
            hub_price_usd: calcPrice,
            pool_market_price_usd: marketBlock ? marketBlock.price_usd : null,  // weak signal
            price_divergence_pct: divergencePct,              // hub vs single-pool (+ = hub high)
            price_divergence_flagged: reviewFlagged,          // large gap → review (NOT auto-flip)
            price_selection: 'hub-ratio-primary',
            final_price_usd: calcPrice,                       // HUB stays final — proven accurate
            final_source: 'calculated-' + (ratioObj.source === 'astroport-trpc' ? 'astroport' : 'eris'),
        };
        if (reviewFlagged) {
            console.warn(`  ⚠ ${symbol}: single-pool price $${marketBlock.price_usd.toFixed(5)} is ${divergencePct.toFixed(1)}% off hub $${calcPrice.toFixed(5)} — pool may be thin/stale. Holding HUB (proven vs CoinGecko). Review pool.`);
        }
        calcCount++;
    }

    // Also expose xASTRO directly from Astroport (already captured in lstRatios)
    if (lstRatios?.xASTRO && lstRatios.xASTRO.xastro_usd) {
        tokens.xASTRO = {
            canonical: 'xASTRO',
            prices: {
                astroport: {
                    price_usd: lstRatios.xASTRO.xastro_usd,
                    chain: 'neutron-1',
                    address: XASTRO_DENOM_NEUTRON,
                    source_note: 'from astroport tokens.getPrice (LST hub config)',
                },
                calculated: {
                    price_usd: lstRatios.xASTRO.astro_usd * lstRatios.xASTRO.ratio,
                    formula: `ASTRO × ${lstRatios.xASTRO.ratio?.toFixed(6)}`,
                    base_token: 'ASTRO',
                    base_price: lstRatios.xASTRO.astro_usd,
                    ratio: lstRatios.xASTRO.ratio,
                    ratio_source: 'astroport-trpc',
                },
            },
            match_quality: 'calculated',
            final_price_usd: lstRatios.xASTRO.xastro_usd,
            final_source: 'astroport-direct',
        };
        calcCount++;
    }

    // Summary log
    const qualityCounts = {};
    for (const t of Object.values(tokens)) {
        qualityCounts[t.match_quality] = (qualityCounts[t.match_quality] || 0) + 1;
    }
    console.log(`  ✓ ${Object.keys(tokens).length} tokens priced`);
    console.log(`  Quality breakdown:`);
    for (const [q, n] of Object.entries(qualityCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${q}: ${n}`);
    }

    // Surface flagged mismatches prominently
    const flagged = Object.entries(tokens).filter(([, t]) => t.match_quality === 'flagged_mismatch');
    if (flagged.length > 0) {
        console.log(`\n  ⚠️  ${flagged.length} flagged mismatch(es):`);
        for (const [sym, t] of flagged) {
            const astro = t.prices.astroport?.price_usd;
            const cg = t.prices.coingecko?.price_usd;
            console.log(`    ${sym}: Astroport $${astro} vs CG $${cg} (delta ${t.astroport_vs_cg_delta_pct?.toFixed(1)}%)`);
        }
    }

    return tokens;
}

// -----------------------------------------------------------------------------
// GITHUB PUBLISH
// -----------------------------------------------------------------------------

function githubApiRequest(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'api.github.com', path: apiPath, method,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent': 'aDAO-network-prices/2.0',
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
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
    const body = { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH, ...(sha ? { sha } : {}) };
    const result = await githubApiRequest('PUT', apiPath, body);
    if (result.status === 200 || result.status === 201) {
        console.log(`  ✅ ${filepath}`);
        return true;
    }
    console.error(`  ❌ Push failed (HTTP ${result.status}): ${result.data?.message || '<no message>'}`);
    return false;
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------

// =============================================================================
// DATA FRESHNESS MONITORING
// =============================================================================
//
// Detects upstream-oracle-frozen failures. Critical for NAP because downstream
// crons (skeletonswap, astroport, tla-snapshot) depend on NAP's prices — if
// NAP serves stale data, the entire dashboard goes silently wrong.
//
// NAP runs HOURLY (unlike daily crons). Token prices should change every minute
// in real markets, so 2 hours of identical prices is already suspicious and
// 3 hours is definitive evidence the oracle source(s) have frozen.
//
// Fingerprint contents: sorted (token_name, final_price_usd) tuples + LUNA
// market price. Excludes block height (changes constantly and would mask
// price-source freezes) and timestamps. If the fingerprint is identical to
// the previous run, either prices genuinely didn't move (extremely unlikely
// for 27 tokens hourly) or both Astroport AND CoinGecko sources are stuck.

const STUCK_THRESHOLD = 3;  // 3+ identical consecutive runs → 'stuck'

function computeDataFingerprint(snapshot) {
    const items = [];
    const tp = snapshot.token_prices || {};
    for (const [name, entry] of Object.entries(tp)) {
        const price = entry?.final_price_usd ?? null;
        items.push([name, price]);
    }
    items.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    // Include LUNA market price (independent CoinGecko detail endpoint, not in token_prices)
    const lunaPrice = snapshot.luna_market?.price_usd ?? null;
    const input = JSON.stringify({ tokens: items, luna: lunaPrice });
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

// Fetch our previous heartbeat from GitHub raw — graceful failure (returns null).
function fetchPreviousHeartbeat() {
    return new Promise((resolve) => {
        const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/data/heartbeat.json`;
        const req = https.get(url, { timeout: 8000 }, (res) => {
            if (res.statusCode !== 200) { resolve(null); return; }
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

function classifyFreshness(currentFp, prev) {
    if (!prev || !prev.dataFingerprint) {
        return { dataFreshness: 'fresh', consecutiveStuckRuns: 0, previousFingerprint: null };
    }
    const previousFingerprint = prev.dataFingerprint;
    if (currentFp !== previousFingerprint) {
        return { dataFreshness: 'fresh', consecutiveStuckRuns: 0, previousFingerprint };
    }
    const priorCount = Number(prev.consecutiveStuckRuns) || 1;
    const consecutive = priorCount + 1;
    const dataFreshness = consecutive >= STUCK_THRESHOLD ? 'stuck' : 'suspicious';
    return { dataFreshness, consecutiveStuckRuns: consecutive, previousFingerprint };
}

async function captureNetworkAndPrices() {
    const startedAt = new Date();
    const dateStr = startedAt.toISOString().slice(0, 10);

    console.log(`\n📸 Network & Prices Capture v2`);
    console.log(`   Started: ${startedAt.toISOString()}\n`);

    // Run all phases in parallel where possible
    const [networkResult, marketResult, ratiosResult, astroDataResult, cgBulkResult] = await Promise.allSettled([
        fetchTerraNetworkStats(),
        fetchLunaMarketFromCoinGecko(),
        fetchLstRatios(),
        fetchAstroportMetrics(),
        fetchCoingeckoBulk(),
    ]);

    const network  = networkResult.status  === 'fulfilled' ? networkResult.value  : null;
    const market   = marketResult.status   === 'fulfilled' ? marketResult.value   : null;
    const ratios   = ratiosResult.status   === 'fulfilled' ? ratiosResult.value   : { ratios: {}, errors: {} };
    const astroData = astroDataResult.status === 'fulfilled' ? astroDataResult.value : null;
    const cgData   = cgBulkResult.status   === 'fulfilled' ? cgBulkResult.value   : {};

    // Phase 6 (depends on 3, 4, 5)
    const tokenPrices = assemblePriceTable({ astroData, cgData, lstRatios: ratios.ratios });

    const snapshot = {
        schemaVersion: 2,    // v2 — added dual-source price comparison + match_quality + series + refresh metadata
        capturedAt: startedAt.toISOString(),
        capturedAtUnix: startedAt.getTime(),

        // Refresh-timing metadata for the dashboard countdown timer.
        // The cron runs every REFRESH_INTERVAL_HOURS; the dashboard computes
        // "next update in N minutes" by subtracting now from nextRefreshExpectedAt.
        // Aligned with deving.zones NFT data which also refreshes hourly.
        refreshIntervalMs: REFRESH_INTERVAL_MS,
        refreshIntervalHours: REFRESH_INTERVAL_HOURS,
        nextRefreshExpectedAt: new Date(startedAt.getTime() + REFRESH_INTERVAL_MS).toISOString(),

        sources: {
            terra_lcd:        network  ? { ok: true } : { ok: false, error: networkResult.reason?.message || 'unknown' },
            coingecko_luna:   market   ? { ok: true } : { ok: false, error: marketResult.reason?.message || 'unknown' },
            lst_ratios:       { ok: Object.keys(ratios.ratios).length > 0, errors: ratios.errors },
            astroport_metrics: astroData ? { ok: true, tokens_count: Object.values(astroData).reduce((s, c) => s + Object.keys(c).length, 0) } : { ok: false, error: astroDataResult.reason?.message || 'unknown' },
            coingecko_bulk:   { ok: Object.keys(cgData).length > 0, tokens_returned: Object.keys(cgData).length },
        },

        network,
        luna_market: market,
        lst_ratios: ratios.ratios,
        token_prices: tokenPrices,
    };

    const content = JSON.stringify(snapshot, null, 2);

    // Hour-of-day check — the cron now fires every hour, but we only want a
    // permanent dated archive once per day. Capture the end-of-day snapshot
    // (23:xx UTC) as the daily archive; other hourly runs only update the
    // rolling "latest" file. This keeps the GitHub repo clean without losing
    // historical resolution (intra-day points are preserved in Astroport's
    // series field within each snapshot).
    const isEndOfDay = startedAt.getUTCHours() === 23;

    // Compute data fingerprint and check freshness vs previous run (oracle-frozen guard).
    console.log('🔍 Computing data fingerprint...');
    const dataFingerprint = computeDataFingerprint(snapshot);
    const prevHeartbeat = await fetchPreviousHeartbeat();
    const freshness = classifyFreshness(dataFingerprint, prevHeartbeat);
    const freshnessIcon = { fresh: '✓', suspicious: '⚠', stuck: '🔴' }[freshness.dataFreshness];
    console.log(`   fingerprint: ${dataFingerprint}  previous: ${freshness.previousFingerprint || '(none)'}`);
    console.log(`   ${freshnessIcon} dataFreshness: ${freshness.dataFreshness}` +
                (freshness.consecutiveStuckRuns > 1
                    ? `  (${freshness.consecutiveStuckRuns} consecutive identical runs)`
                    : ''));

    if (GITHUB_TOKEN) {
        console.log('\n📤 Publishing to GitHub...');
        await pushToGithub('data/network-and-prices.json', content,
            `📊 Network & prices — ${dateStr} ${startedAt.getUTCHours().toString().padStart(2, '0')}:xx`);
        if (isEndOfDay) {
            await pushToGithub(`data/daily/${dateStr}.json`, content,
                `📊 Daily archive ${dateStr}`);
            console.log(`  ✓ End-of-day archive written to data/daily/${dateStr}.json`);
        } else {
            console.log(`  (skipping daily archive — only written at 23:xx UTC; current hour ${startedAt.getUTCHours()})`);
        }
        // Heartbeat — uniform freshness contract across all crons
        const sourceFailures = Object.entries(snapshot.sources).filter(([, v]) => !v.ok).length;
        // Status escalation (worst wins): stuck > partial > ok
        let status;
        if (freshness.dataFreshness === 'stuck') status = 'stuck';
        else if (sourceFailures > 0)             status = 'partial';
        else                                     status = 'ok';

        const heartbeat = {
            schemaVersion: 1,
            cron: 'network-and-prices',
            capturedAt: startedAt.toISOString(),
            capturedAtUnix: startedAt.getTime(),
            runId: `nap-${startedAt.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
            runMode: isEndOfDay ? 'hourly+daily-archive' : 'hourly',
            status,
            stats: {
                tokens_priced: Object.keys(tokenPrices || {}).length,
                lst_ratios:    Object.keys(ratios.ratios || {}).length,
                source_failures: sourceFailures,
            },
            // Freshness-monitoring fields (catches oracle-frozen failures)
            dataFingerprint,
            previousFingerprint:  freshness.previousFingerprint,
            dataFreshness:        freshness.dataFreshness,
            consecutiveStuckRuns: freshness.consecutiveStuckRuns,
            next_expected_run_at: snapshot.nextRefreshExpectedAt,
        };
        await pushToGithub('data/heartbeat.json', JSON.stringify(heartbeat, null, 2),
            `📍 Network & prices heartbeat`);
    } else {
        console.log('\n⚠️  GITHUB_TOKEN not set — saving locally');
        fs.writeFileSync('network-and-prices.json', content);
        fs.writeFileSync('heartbeat.json', JSON.stringify({
            schemaVersion: 1, cron: 'network-and-prices',
            capturedAt: startedAt.toISOString(), capturedAtUnix: startedAt.getTime(),
            runId: `nap-${startedAt.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
            runMode: isEndOfDay ? 'hourly+daily-archive' : 'hourly',
            status: freshness.dataFreshness === 'stuck' ? 'stuck' : 'ok',
            stats: { tokens_priced: Object.keys(tokenPrices || {}).length },
            // Freshness-monitoring fields (catches oracle-frozen failures)
            dataFingerprint,
            previousFingerprint:  freshness.previousFingerprint,
            dataFreshness:        freshness.dataFreshness,
            consecutiveStuckRuns: freshness.consecutiveStuckRuns,
            next_expected_run_at: snapshot.nextRefreshExpectedAt,
        }, null, 2));
        console.log(`  Saved: network-and-prices.json, heartbeat.json`);
    }

    console.log(`\n✅ Done (${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s) — next refresh expected ${snapshot.nextRefreshExpectedAt}\n`);
    return snapshot;
}

captureNetworkAndPrices()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('\n❌ Failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    });
