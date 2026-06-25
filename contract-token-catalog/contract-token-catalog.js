// =============================================================================
// Contract-Token-Catalog Cron — the platform's "what + how" registry
// =============================================================================
//
// Sibling to the Address-Catalog (which answers WHO). This answers WHAT exists
// and HOW to query it: every TLA/NFT/governance/ratio contract with its verified
// query shapes, every token with its address + decimals + price source, and the
// dynamic active/inactive/single LP set. The price / ratio / DEX / audit-tool /
// portfolio crons all READ this instead of hardcoding addresses.
//
// TWO PARTS
//   1. DYNAMIC (runs first): active + inactive + single LPs in TLA, harvested
//      from tla-snapshot, each with dex, pool/lp/amplp addresses, token A/B,
//      bucket, status, ratio. This is what changes as TLA adds/removes pools —
//      it lets downstream crons start/stop tracking automatically.
//   2. STATIC (curated): TLA core, ratio hubs, NFT, governance, tokens, labeled
//      wallets, and future protocols (Credia). Edit the consts below to add one.
//
// OUTPUT — tla-core repo, `contracts` module:
//   contracts/current.json    full registry
//   contracts/heartbeat.json  standard heartbeat
//
// All addresses + queries below were harvested from verified production code
// (capture-engine, network-and-prices, backing, the gov tool) and HAR decodes.
// =============================================================================

'use strict';
const fs = require('fs');
const https = require('https');
const {
  queryContract, fetchJson, currentEpochInfo,
  TLA_GAUGE_CONTROLLER, TLA_VOTING_ESCROW, TLA_BRIBE_MANAGER, TLA_ASSET_COMPOUNDER, TLA_STAKING_CONTRACTS,
} = require('../lib/capture-engine.js');

const TLA_SNAPSHOT_URL = 'https://raw.githubusercontent.com/defipatriot/tla-snapshot-data_2026/main/data/tla-snapshot.json';

// -----------------------------------------------------------------------------
// STATIC REGISTRY — curate here. Adding a token/contract/protocol = one entry.
// -----------------------------------------------------------------------------

// Tokens: symbol -> identity + decimals + where its price comes from.
//   price.from: 'lp'  -> derived from a TLA LP reserve (the price oracle)
//               'ratio' -> base token price × LST/amp exchange-rate (see ratio_hubs)
//               'stable' -> ~$1
const TOKENS = {
  LUNA:    { type: 'native', denom: 'uluna', decimals: 6, cgId: 'terra-luna-2', price: { from: 'lp' } },
  USDC:    { type: 'ibc', denom: 'ibc/2C962DAB9F57FE0921435426AE75196009FAA1981BF86991203C8411F8980FDB', decimals: 6, cgId: 'usd-coin', price: { from: 'stable' } },
  USDT:    { type: 'ibc', denom: 'ibc/9B19062D46CAB50361CE9B0A3E6D0A7A53AC9E7CB361F32A73CC733144A9A9E5', decimals: 6, cgId: 'tether', price: { from: 'stable' } },
  WBTC:    { type: 'ibc', denom: 'ibc/88386AC48152D48B34B082648DF836F975506F0B57DBBFC10A54213B1BF484CB', decimals: 8, cgId: 'wrapped-bitcoin', price: { from: 'lp' } },
  PAXG:    { type: 'ibc', denom: 'ibc/0EF5630576C66968EF0787868CF09FD866FAD131BC148D24A148358A85F0EB62', decimals: 6, cgId: 'pax-gold', price: { from: 'lp' } },
  EURE:    { type: 'ibc', denom: 'ibc/8D52B251B447B7160421ACFBD50F6B0ABE5F98D2C404B03701130F12044439A1', decimals: 6, cgId: 'euroe-stablecoin', price: { from: 'lp' } },
  ATOM:    { type: 'ibc', denom: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2', decimals: 6, cgId: 'cosmos', price: { from: 'lp' } },
  ETH:     { type: 'ibc', denom: 'ibc/20850C646CDDDC2270E9BBDB08558B5FEE57B647EC6827F41096AABFD8A0471B', decimals: 18, cgId: 'ethereum', price: { from: 'lp' } },
  WSTETH:  { type: 'ibc', denom: 'ibc/A356EC90DC3AE43D485514DA7260EDC7ABB5CFAA0654CE2524C739392975AD3C', decimals: 18, cgId: 'wrapped-steth', price: { from: 'lp' } },
  BNB:     { type: 'ibc', denom: 'ibc/1319C6B38CA613C89D78C2D1461B305038B1085F6855E8CD276FE3F7C9600B4C', decimals: 18, cgId: 'binancecoin', price: { from: 'lp' } },
  xASTRO:  { type: 'ibc', denom: 'ibc/65B3EB6263482979FD7A80E3FFB9D0C85CFBF6DB63EB8DDE918B2984A40CEAB6', decimals: 6, cgId: null, price: { from: 'lp' } },

  ASTRO:   { type: 'cw20', address: 'terra1nsuqsk6kh58ulczatwev87ttq2z6r3pusulg9r24mfj2fvtzd4uq3exn26', decimals: 6, cgId: 'astroport-fi', price: { from: 'lp' } },
  CAPA:    { type: 'cw20', address: 'terra1t4p3u8khpd7f8qzurwyafxt648dya6mp6vur3vaapswt6m24gkuqrfdhar', decimals: 6, cgId: 'capapult', price: { from: 'lp' } },
  SOLID:   { type: 'cw20', address: 'terra10aa3zdkrc7jwuf8ekl3zq7e7m42vmzqehcmu74e4egc7xkm5kr2s0muyst', decimals: 6, cgId: 'solid-2', price: { from: 'lp' } },
  ROAR:    { type: 'cw20', address: 'terra1lxx40s29qvkrcj8fsa3yzyehy7w50umdvvnls2r830rys6lu2zns63eelv', decimals: 6, cgId: 'lion-dao', price: { from: 'lp' } },

  // LSTs / amplified derivatives — priced as baseToken × exchange-rate (ratio_hubs)
  ampLUNA: { type: 'cw20', address: 'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct', decimals: 6, cgId: 'eris-amplified-luna', lst: true, price: { from: 'ratio', hub: 'ampLUNA' } },
  arbLUNA: { type: 'cw20', address: 'terra1se7rvuerys4kd2snt6vqswh9wugu49vhyzls8ymc02wl37g2p2ms5yz490', decimals: 6, cgId: 'eris-arbitrage-luna', lst: true, price: { from: 'ratio', hub: 'arbLUNA' } },
  bLUNA:   { type: 'cw20', address: 'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml', decimals: 6, cgId: 'backbone-labs-staked-luna', lst: true, price: { from: 'ratio', hub: 'bLUNA' } },
  ampCAPA: { type: 'native', denom: 'factory/terra186rpfczl7l2kugdsqqedegl4es4hp624phfc7ddy8my02a4e8lgq5rlx7y/ampCAPA', decimals: 6, cgId: null, lst: true, price: { from: 'ratio', hub: 'ampCAPA' } },
  ampROAR: { type: 'native', denom: null, decimals: 6, cgId: null, lst: true, price: { from: 'ratio', hub: 'ampROAR' } }, // denom TBD — harvest if it appears in a pool
};

// Ratio / LST hub contracts — what needs a ratio and how to get it (verified).
const RATIO_HUBS = {
  ampLUNA: { hub: 'terra10788fkzah89xrdm27zkj5yvhj9x3494lxawzm5qq3vvxcqz2yzaqyd3enk', query: { exchange_rates: {} }, ratio_path: 'exchange_rates[0][1]', baseToken: 'LUNA' },
  arbLUNA: { hub: 'terra1r9gls56glvuc4jedsvc3uwh6vj95mqm9efc7hnweqxa2nlme5cyqxygy5m', query: { state: {} },          ratio_path: 'exchange_rate',         baseToken: 'LUNA' },
  bLUNA:   { hub: 'terra1l2nd99yze5fszmhl5svyh5fky9wm4nz4etlgnztfu4e8809gd52q04n3ea', query: { state: {} },          ratio_path: 'exchange_rate',         baseToken: 'LUNA' },
  ampROAR: { hub: 'terra1vklefn7n6cchn0u962w3gaszr4vf52wjvd4y95t2sydwpmpdtszsqvk9wy', query: { state: {} },          ratio_path: 'exchange_rate',         baseToken: 'ROAR' },
  ampCAPA: { hub: 'terra186rpfczl7l2kugdsqqedegl4es4hp624phfc7ddy8my02a4e8lgq5rlx7y', query: { state: {} },          ratio_path: 'exchange_rate',         baseToken: 'CAPA' },
};

// Core protocol contracts, grouped, each with the queries verified against it.
const CONTRACTS = {
  tla: {
    gauge_controller: { address: TLA_GAUGE_CONTROLLER, queries: ['user_info', 'user_pending_rebase', 'user_first_participation'] },
    voting_escrow:    { address: TLA_VOTING_ESCROW, kind: 'cw721', queries: ['all_tokens', 'owner_of', 'num_tokens', 'tokens', 'lock_info'] },
    bribe_manager:    { address: TLA_BRIBE_MANAGER, queries: ['user_claimable'] },
    asset_compounder: { address: TLA_ASSET_COMPOUNDER, queries: ['asset_configs', 'user_infos'], note: 'mints amplified LP as factory/<this>/<n>/<bucket>/amplp' },
    staking: { queries: ['all_staked_balances', 'all_pending_rewards'], buckets: TLA_STAKING_CONTRACTS },
  },
  nft: {
    adao_collection: { address: 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9', kind: 'cw721', queries: ['all_tokens', 'owner_of', 'num_tokens', 'nft_info', 'contract_info'] },
  },
  governance: {
    dao_core:           { address: 'terra1csp8gsjk2yyxzqewza6lkjvwkspn7zs2jvamk9uf05crtcakf6gszk2g8y', queries: ['dump_state', 'voting_module', 'proposal_modules', 'config'] },
    treasury_wallet:    { address: 'terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm', note: 'aDAO main treasury wallet (not the core contract)' },
    voting_module:      { address: 'terra1c57ur376szdv8rtes6sa9nst4k536dynunksu8tx5zu4z5u3am6qmvqx47', kind: 'dao-voting-cw721-staked', queries: ['daoVotingCw721Staked/topStakers (indexer)'] },
    proposal_module:    { address: 'terra1va3tny5252fca04wqzf7gqh5naa8599nzxqq2vptycgv077zhmjqetanj2', queries: ['list_proposals', 'reverse_proposals', 'proposal', 'list_votes', 'config'] },
    pd_proposal_module: { address: 'terra1660g9mle5kfsq8c0p4k4hgr9ujdyr3m48c22cawy0akr98rmwksqehqnup', note: 'Phoenix Directive gauge/bribe proposals', queries: ['list_proposals', 'proposal'] },
  },
  dao_cores: { // ally DAO cores (member discovery lives in the Address-Catalog; addresses kept here for reference)
    adao:       'terra1csp8gsjk2yyxzqewza6lkjvwkspn7zs2jvamk9uf05crtcakf6gszk2g8y',
    pixellions: 'terra1c690mdrwdetnr09zfk3tf9xz9jhrgd9wpjyf3tuccj74ql09eqmq6sh7en',
    liondao:    'terra1tkersa2mqwy2h8exj799qx2xrhdu0dkymk9psp6v0k4kz4tkxucssgluec',
  },
};

// Labeled wallets / custody contracts — for dropdowns + the audit tool.
const WALLETS = {
  'terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm': 'aDAO Treasury (main)',
  'terra1yqv0af22675wlcmgflxk4ve07vt8qlm999gk0cuw5l64r5xxgadsyg8ywv': 'aDAO Council',
  'terra1h8psjgcsg9fef7w2yv0j6262sfcaszj8vs4tsy3uwla6zwtaspvqrp4l7v': 'DAO Treasury NFT custody (broken NFTs)',
  'terra1e54tcdyulrtslvf79htx4zntqntd4r550cg22sj24r6gfm0anrvq0y8tdv': 'NFT custody (broken NFTs)',
};

// DAO-held veLUNA locks (the treasury's own voting power).
const DAO_LOCKS = [600, 711];

// Future protocols — captured, not yet wired into tracking.
const FUTURE = {
  credia: {
    type: 'lending', status: 'future', note: 'Money-market (supply/borrow/collateral). wBTC.creda = wBTC supplied as collateral. Queried via RPC.',
    metrics_contract: 'terra1y6hfmr3lxxj6srduhlfz96x7sga2984pr757a0nrfuqxa9rqxapqcjv4zz',
    queries: ['metrics'],
    metrics_returns: ['total_supplied_usd', 'total_borrowed_usd', 'total_collateral_usd', 'total_reserves_usd', 'assets[]'],
  },
  // third_dex placeholder — add a Credia/other DEX here when wired (mirrors the dex field on pools).
};

// -----------------------------------------------------------------------------
// DYNAMIC — active / inactive / single LPs, harvested from tla-snapshot.
// -----------------------------------------------------------------------------
function tokenRef(symbol) {
  const t = TOKENS[symbol];
  if (!t) return { symbol, address: null, decimals: null, type: null, note: 'not in token registry' };
  return { symbol, address: t.address || t.denom || null, decimals: t.decimals, type: t.type };
}

async function discoverPools() {
  const snap = await fetchJson(TLA_SNAPSHOT_URL, 'tla-snapshot').catch(() => null);
  if (!snap || !Array.isArray(snap.pools)) return { ok: false, active: [], inactive: [], single: [] };

  // Amplified LP denoms are PER-POOL: factory/<compounder>/<configId>/<bucket>/amplp
  // (multiple configIds per bucket). asset_configs lists every amplified pool; each
  // entry references its pool's address (e.g. the Astroport pair). We capture the raw
  // configs AND build an address->amplp map so each pool matches its OWN amplified
  // denom by address overlap — non-amplified pools correctly get null.
  let amplifiedConfigs = [];
  const amplpByAddress = {};
  try {
    const cfgs = await queryContract(TLA_ASSET_COMPOUNDER, { asset_configs: {} });
    if (Array.isArray(cfgs)) {
      for (const c of cfgs) {
        const blob = JSON.stringify(c);
        const dm = blob.match(/factory\/[a-z0-9]+\/\d+\/[a-z]+\/amplp/);
        if (!dm) continue;
        const amplp = dm[0];
        const addrs = [...new Set(blob.match(/terra1[a-z0-9]{38,}/g) || [])];
        const gm = blob.match(/"gauge":"([a-z]+)"/);
        amplifiedConfigs.push({ gauge: gm ? gm[1] : null, amplp_denom: amplp, addresses: addrs });
        // every referenced address EXCEPT the compounder itself points at this amplp denom
        for (const a of addrs) if (a !== TLA_ASSET_COMPOUNDER) amplpByAddress[a] = amplp;
      }
    }
  } catch (e) { /* amplified config enrichment best-effort */ }

  const out = { active: [], inactive: [], single: [], amplified_configs: amplifiedConfigs,
    _asset_configs_ok: amplifiedConfigs.length > 0, _amplp_matched: 0 };
  for (const p of snap.pools) {
    const assets = [];
    const h = p.lp_health || {};
    for (const side of ['asset_0', 'asset_1']) if (h[side] && h[side].symbol) assets.push(tokenRef(h[side].symbol));
    const ampDenom = amplpByAddress[p.pool_address] || amplpByAddress[p.lp_address] || null;
    if (ampDenom) out._amplp_matched++;
    const row = {
      name: p.name,
      dex: p.dex || null,
      dex_subtype: p.dex_subtype || null,
      pair_type: p.is_single ? 'single' : (p.dex_subtype || 'pair'),
      bucket: p.bucket || null,
      status: p.status,                              // active | voted_but_below_threshold | zero_vp
      dex_contract: p.pool_address || null,          // the DEX pair contract
      lp_nonamplified: p.lp_address || null,         // base LP (non-amplified, staked into bucket contract)
      lp_amplified: ampDenom,                        // amplified LP (compounder factory denom); null if not amplified
      gauge_pool_id: p.gauge_pool_id || null,        // staked-LP identifier
      token_a: assets[0] || null,
      token_b: assets[1] || null,
      ratio: (p.amp_lp || {}).ratio || null,
      ratio_type: (p.amp_lp || {}).ratio_type || null,
    };
    if (p.is_single) out.single.push(row);
    else if (p.status === 'active') out.active.push(row);
    else out.inactive.push(row);                     // voted_but_below_threshold + zero_vp
  }
  out.ok = true;
  return out;
}

// -----------------------------------------------------------------------------
// GitHub publish (standard helper)
// -----------------------------------------------------------------------------
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

function githubApiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'api.github.com', path: apiPath, method,
      headers: { 'User-Agent': 'contract-token-catalog/1.0', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } };
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

// -----------------------------------------------------------------------------
async function run() {
  const startedAt = new Date();
  const epochInfo = currentEpochInfo();
  console.log(`\n🚀 Contract-Token-Catalog — ${startedAt.toISOString()}\n`);

  const pools = await discoverPools();
  const poolsOk = pools.ok;
  console.log(`  pools: ${pools.active.length} active, ${pools.inactive.length} inactive, ${pools.single.length} single | amplified configs: ${pools.amplified_configs.length}, matched to pools: ${pools._amplp_matched}`);

  const status = poolsOk ? 'ok' : 'partial';
  const catalog = {
    meta: {
      version: 'contract-token-catalog-1.0.0', schemaVersion: 1,
      generated_at: startedAt.toISOString(), epoch: epochInfo?.number ?? null,
      status, source: 'contract-token-catalog cron (cron-scripts/contract-token-catalog)',
    },
    pools: { active: pools.active, inactive: pools.inactive, single: pools.single, amplified_configs: pools.amplified_configs },
    tokens: TOKENS,
    ratio_hubs: RATIO_HUBS,
    contracts: CONTRACTS,
    wallets: WALLETS,
    dao_locks: DAO_LOCKS,
    future: FUTURE,
  };

  const heartbeat = {
    schemaVersion: 1, capturedAt: startedAt.toISOString(), runId: `contracts-${startedAt.getTime()}`,
    status, currentEpoch: epochInfo?.number ?? null,
    counts: { active: pools.active.length, inactive: pools.inactive.length, single: pools.single.length, tokens: Object.keys(TOKENS).length, amplified_pools: pools._amplp_matched },
    next_expected_run_at: new Date(startedAt.getTime() + 25 * 3600 * 1000).toISOString(),
  };

  const catContent = JSON.stringify(catalog, null, 2);
  const hbContent  = JSON.stringify(heartbeat, null, 2);
  fs.writeFileSync('current.json', catContent);
  fs.writeFileSync('heartbeat.json', hbContent);

  if (GITHUB_TOKEN) {
    await publishFile('contracts/current.json', catContent, `contracts ${status} — ${pools.active.length}+${pools.inactive.length} LPs`);
    console.log('  ✓ contracts/current.json');
    await publishFile('contracts/heartbeat.json', hbContent, `heartbeat ${status}`);
    console.log('  ✓ contracts/heartbeat.json');
  } else {
    console.log('  (no GITHUB_TOKEN — wrote current.json + heartbeat.json locally only)');
  }
  console.log(`\n✅ Done — ${status} — ${pools.active.length} active / ${pools.inactive.length} inactive / ${pools.single.length} single LPs, ${Object.keys(TOKENS).length} tokens`);
  if (status === 'partial') process.exitCode = 0; // partial is acceptable (static registry still published)
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
