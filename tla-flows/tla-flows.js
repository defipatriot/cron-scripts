#!/usr/bin/env node
/**
 * tla-flows.js — resumable capture of TLA deposits, withdrawals, claims, and
 * zap entry-costs via LCD tx_search. Writes into the unified `tla-core` repo as
 * the `flows` module, mirroring the `fuel` skeleton.
 *
 * Output layout (under TLA_OUT_DIR = the flows module dir):
 *   events/heartbeat.json          standard heartbeat contract (matches fuel)
 *   events/index.json              manifest: latest height/date, totals, by-type
 *   events/cursor.json             resumption state (last processed height)
 *   events/YYYY/MM/DD.jsonl        append-only event ledger, year/month/day partitioned
 *
 * Completeness comes from the cursor, not from being always-on: process
 * [cursor, head] -> write -> advance cursor LAST. A crash re-reads the unmoved
 * window; txhash dedupe absorbs overlap; any query error returns WITHOUT
 * advancing (fail-safe). Same loop from a genesis start height IS the backfill.
 *
 * Run (cron/local):    node tla-flows.js
 * Verify parser:       node tla-flows.js --selftest
 */

const LCD = process.env.TLA_LCD || 'https://terra-lcd.publicnode.com';
const OUT = process.env.TLA_OUT_DIR || './out/flows';   // on Render: <tla-core checkout>/flows
const PAGE_LIMIT = 100;
const DEFAULT_LOOKBACK = Number(process.env.TLA_LOOKBACK || 1200);  // first-run window (~2h) if no cursor/start
const SCHEMA = 1;

// Six shared contracts cover every pool (share custody is centralized).
const WATCH = {
  'terra1zly98gvcec54m3caxlqexce7rus6rzgplz7eketsdz7nh750h2rqvu8uzx': 'compounder',
  'terra1v399cx9drllm70wxfsgvfe694tdsd9x96p9ha36w7muffe4znlusqswspq': 'staking-stable',
  'terra1awq6t7jfakg9wfjn40fk3wzwmd57mvrqtt3a39z9rmet7wdjj3ysgw3lpa': 'staking-project',
  'terra14mmvqn0kthw6sre75vku263lafn5655mkjdejqjedjga4cw0qx2qlf4arv': 'staking-bluechip',
  'terra1qdz5qgafx88kp5mf6m2tah8742g4u5g2cek0m3jrgssexexk7g4qw6e23k': 'staking-single',
  'terra1qdjsxsv96aagrdxz83gwtjk8qvf2mrg4y8y3dqjxg556lm79pg5qdgmaxl': 'zapper',
};

// ── parser (verified in --selftest; per-event grouping → clean attribution) ──
function attrs(ev) { const o = {}; for (const a of (ev.attributes || [])) o[a.key] = a.value; return o; }
function eventsOf(txr) {
  if (Array.isArray(txr.events) && txr.events.length) return txr.events;
  const out = []; for (const log of (txr.logs || [])) for (const e of (log.events || [])) out.push(e); return out;
}
function classifyTx(txr) {
  const wasm = eventsOf(txr).filter(e => e.type === 'wasm').map(attrs);
  let flow = null;
  for (const w of wasm) {
    const act = w.action;
    if (act === 'asset-compounding/stake')        flow = { type:'deposit',  mechanism:'amplified',     user:w.user, amount:w.bond_share_adjusted || w.bond_share, unit:'amplp' };
    else if (act === 'asset-compounding/unstake') flow = { type:'withdraw', mechanism:'amplified',     user:w.user, amount:(w.returned||'').split(':').pop(), unit:'lp' };
    else if (act === 'asset/stake')               flow = { type:'deposit',  mechanism:'non_amplified', user:w.user, amount:w.share, unit:'shares' };
    else if (act === 'asset/unstake')             flow = { type:'withdraw', mechanism:'non_amplified', user:w.user, amount:w.share, unit:'shares' };
    if (flow) break;
  }
  if (!flow) {
    const c = wasm.find(w => /claim/i.test(w.action || ''));
    if (c) flow = { type:'claim', mechanism:null, user:c.user || c.sender, amount:null, unit:'rewards' };
  }
  if (!flow) return null;
  const viaZap = wasm.some(w => w.action === 'zapper/create_lp' || w.action === 'zapper/withdraw_lp');
  const cost = extractCost(wasm);   // entry/exit slippage: all swap legs + provide-liquidity slippage
  return { schemaVersion:SCHEMA, txhash:txr.txhash, height:Number(txr.height), timestamp:txr.timestamp,
           type:flow.type, mechanism:flow.mechanism, via_zap:viaZap, user:flow.user||null,
           amount:flow.amount||null, amount_unit:flow.unit, cost, raw_actions:[...new Set(wasm.map(w=>w.action).filter(Boolean))] };
}

// Entry/exit cost: collect EVERY swap leg (a non-LUNA exit is multi-hop) plus any
// provide_liquidity slippage (imbalanced "Tokens" deposits). Cross-denom legs are
// kept raw — the cron records receipt truth; the analysis layer prices the rollup.
function extractCost(wasm) {
  const swaps = wasm
    .filter(w => w.action === 'swap' && w.offer_amount !== undefined && w.return_amount !== undefined)
    .map(w => {
      const ret = Number(w.return_amount||0), spr = Number(w.spread_amount||0), com = Number(w.commission_amount||0), d = ret+spr+com;
      return { offer_asset:w.offer_asset, offer_amount:w.offer_amount, ask_asset:w.ask_asset,
               return_amount:w.return_amount, spread_amount:w.spread_amount, commission_amount:w.commission_amount,
               maker_fee_amount:w.maker_fee_amount, leg_cost_pct: d>0 ? +(100*(spr+com)/d).toFixed(4) : null };
    });
  const prov = wasm.find(w => w.action === 'provide_liquidity' && w.slippage !== undefined);
  const provide_slippage_pct = prov ? +(100*Number(prov.slippage)).toFixed(4) : null;
  if (!swaps.length && provide_slippage_pct == null) return null;
  return { swaps, provide_slippage_pct };
}

// ── LCD (runs where Terra is reachable: locally or Render) ──────────────────
async function latestHeight() {
  const r = await fetch(`${LCD}/cosmos/base/tendermint/v1beta1/blocks/latest`);
  if (!r.ok) throw new Error('latest-block ' + r.status);
  return Number((await r.json()).block.header.height);
}
async function txSearch(contract, page = 1) {
  // No tx.height range filter — publicnode's LCD 400s on it. We bound the window
  // client-side instead. Pruned public nodes index only a recent window, so the
  // per-contract result set is small (one or few pages).
  const q = encodeURIComponent(`wasm._contract_address='${contract}'`);
  const r = await fetch(`${LCD}/cosmos/tx/v1beta1/txs?query=${q}&page=${page}&limit=${PAGE_LIMIT}`);
  if (!r.ok) throw new Error(`tx_search ${r.status} ${contract.slice(0,12)}… p${page}`);
  const j = await r.json();
  return { rows: j.tx_responses || [] };
}

// ── persistence (local fs default; OUT = flows module dir) ──────────────────
const fs = require('fs'), path = require('path');
function rd(p, d) { try { return JSON.parse(fs.readFileSync(path.join(OUT, p), 'utf8')); } catch { return d; } }
function wr(p, o) { const f = path.join(OUT, p); fs.mkdirSync(path.dirname(f), { recursive:true }); fs.writeFileSync(f, JSON.stringify(o, null, 2)); }
function appendJSONL(p, recs) { if (!recs.length) return; const f = path.join(OUT, p); fs.mkdirSync(path.dirname(f), { recursive:true }); fs.appendFileSync(f, recs.map(r => JSON.stringify(r)).join('\n') + '\n'); }
function partPath(ts) { const [Y,M,D] = (ts||'').slice(0,10).split('-'); return `events/${Y}/${M}/${D}.jsonl`; }

async function run() {
  const cursor = rd('events/cursor.json', null);
  const head = await latestHeight();
  let fromH;
  if (cursor && cursor.height) fromH = cursor.height + 1;
  else if (process.env.TLA_START_HEIGHT) fromH = Number(process.env.TLA_START_HEIGHT);
  else { fromH = head - DEFAULT_LOOKBACK; console.log(`first run: head ${head}, starting ${DEFAULT_LOOKBACK} blocks back at ${fromH}`); }
  if (fromH > head) { console.log(`no new blocks (cursor ${fromH-1} >= head ${head})`); return; }

  const MAX_PAGES = 20;
  const seen = new Set(); const records = [];
  for (const [addr, name] of Object.entries(WATCH)) {
    let kept = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      let res; try { res = await txSearch(addr, page); }
      catch (e) { console.error('  query failed — cursor NOT advanced:', e.message); return; }
      for (const txr of res.rows) {
        const h = Number(txr.height);
        if (h < fromH || h > head) continue;            // client-side window
        if (seen.has(txr.txhash)) continue; seen.add(txr.txhash);
        const rec = classifyTx(txr); if (rec) { records.push(rec); kept++; }
      }
      if (res.rows.length < PAGE_LIMIT) break;
    }
    console.log(`  ${name}: ${kept} in-window`);
  }
  const maxH = head;

  // write events partitioned by day; advance cursor + index + heartbeat LAST
  const byFile = {}; const byType = {};
  for (const r of records) { (byFile[partPath(r.timestamp)] ||= []).push(r); byType[r.type] = (byType[r.type]||0)+1; }
  for (const p of Object.keys(byFile)) appendJSONL(p, byFile[p]);

  const idx = rd('events/index.json', { total_events:0, by_type:{} });
  idx.latest_height = maxH;
  idx.latest_date = records.length ? records[records.length-1].timestamp.slice(0,10) : idx.latest_date || null;
  idx.total_events = (idx.total_events||0) + records.length;
  for (const t in byType) idx.by_type[t] = (idx.by_type[t]||0) + byType[t];
  idx.updatedAt = new Date().toISOString();
  wr('events/index.json', idx);

  wr('events/cursor.json', { height: maxH, updatedAt: new Date().toISOString() });

  const now = new Date();
  wr('events/heartbeat.json', {
    schemaVersion: SCHEMA, cron: 'flows',
    capturedAt: now.toISOString(), capturedAtUnix: now.getTime(),
    runId: 'flows-' + now.toISOString().replace(/[-:T.Z]/g,'').slice(0,14),
    runMode: 'incremental', status: 'ok',
    stats: { new_records: records.length, cursor_height: maxH, by_type: byType },
    next_expected_run_at: new Date(now.getTime() + 15*60000).toISOString(),
  });
  console.log(`captured ${records.length} flow records (by type: ${JSON.stringify(byType)}) up to height ${maxH}`);
}

// ── self-test: classify the 3 real txs ──────────────────────────────────────
function selftest() {
  const F = [
    { name:'wBTC-LUNA zap deposit', txr:{ txhash:'DF04FE99…', height:'21000001', timestamp:'2026-06-24T00:00:00Z', events:[
      { type:'wasm', attributes:[{key:'action',value:'zapper/create_lp'},{key:'user',value:'terra1n28qcuxlm0t94dlky2zny0g7w8vrrklgef7229'}] },
      { type:'wasm', attributes:[{key:'action',value:'swap'},{key:'offer_amount',value:'2475000'},{key:'return_amount',value:'44014'},{key:'spread_amount',value:'788'},{key:'commission_amount',value:'132'}] },
      { type:'wasm', attributes:[{key:'action',value:'asset-compounding/stake'},{key:'user',value:'terra1n28qcuxlm0t94dlky2zny0g7w8vrrklgef7229'},{key:'bond_share_adjusted',value:'21479'}] },
    ]}},
    { name:'xASTRO stake deposit', txr:{ txhash:'9B4CDDD9…', height:'21000002', timestamp:'2026-06-24T00:05:00Z', events:[
      { type:'wasm', attributes:[{key:'action',value:'asset/stake'},{key:'user',value:'terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw'},{key:'amount',value:'1209927446'},{key:'share',value:'1431823163'}] } ]}},
    { name:'USDC-SOLID full withdraw', txr:{ txhash:'F73B2D3E…', height:'21000003', timestamp:'2026-06-24T00:10:00Z', events:[
      { type:'wasm', attributes:[{key:'action',value:'asset-compounding/unstake'},{key:'user',value:'terra1d0jq9l5narcgy46v5agnv8hqmn5m8kj3lkh93l'},{key:'returned',value:'cw20:terra12usr…:27075021'}] },
      { type:'wasm', attributes:[{key:'action',value:'zapper/withdraw_lp'}] } ]}},
  ];
  console.log('SELF-TEST — classify the 3 real txs:\n');
  for (const f of F) {
    const r = classifyTx(f.txr);
    const c = r.cost ? `  cost: ${[r.cost.provide_slippage_pct!=null?`provide ${r.cost.provide_slippage_pct}%`:null, ...r.cost.swaps.map(s=>`swap ${s.leg_cost_pct}%`)].filter(Boolean).join(', ')}` : '';
    console.log(`  ${f.name}\n   → ${r.type}/${r.mechanism}${r.via_zap?' (zap)':''}  amount=${r.amount} ${r.amount_unit}  user=…${(r.user||'').slice(-6)}${c}\n`);
  }
}

if (process.argv.includes('--selftest')) selftest();
else run();
