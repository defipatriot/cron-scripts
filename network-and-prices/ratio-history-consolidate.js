// =============================================================================
// ratio-history-consolidate.js  —  one-time bootstrap of ratio-history.json
// =============================================================================
//
// network-and-prices has been writing a full daily archive (data/daily/{date}.json)
// at end-of-day, and each archive already contains `lst_ratios` (every LST's
// chain exchange_rate that day). This walks every existing daily archive and
// folds those ratios into a single consolidated time-series, data/ratio-history.json
// — recovering ALL the exact ratio history captured so far (no archive node
// needed). Idempotent + merge-safe: it reads any existing ratio-history.json and
// unions, so it's fine to run alongside the cron's forward-append. Run once.
//
// USD later: LST_USD(day) = base_USD(day) × rate(day), joined to price-history's
// daily-prices.json.
//
// Env: GITHUB_TOKEN (required), GITHUB_REPO (default network-and-prices-data_2026),
//      GITHUB_BRANCH (default main).
// =============================================================================

'use strict';
const https = require('https');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/network-and-prices-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const BASES = { ampLUNA: 'LUNA', arbLUNA: 'LUNA', bLUNA: 'LUNA', ampCAPA: 'CAPA', ampROAR: 'ROAR', xASTRO: 'ASTRO' };

function gh(method, apiPath, body) {
    return new Promise((resolve, reject) => {
        const opts = { hostname: 'api.github.com', path: apiPath, method, headers: { 'User-Agent': 'aDAO-ratio-consolidate', Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } };
        if (body) opts.headers['Content-Type'] = 'application/json';
        const req = https.request(opts, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ if(res.statusCode>=200&&res.statusCode<300){try{resolve(JSON.parse(d));}catch{resolve(d);}}else reject(new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${d.slice(0,140)}`)); }); });
        req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
    });
}
function rawGet(path) {
    return new Promise((resolve) => {
        https.get(`https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${path}`, { headers: { 'User-Agent': 'aDAO', Accept: 'application/json' }, timeout: 15000 }, res => {
            if (res.statusCode !== 200) { res.resume(); return resolve(null); }
            let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch{resolve(null);} });
        }).on('error',()=>resolve(null)).on('timeout',function(){this.destroy();resolve(null);});
    });
}
async function publish(path, obj, msg) {
    let sha=null; try { const dir=path.split('/').slice(0,-1).join('/'); const name=path.split('/').pop(); const list=await gh('GET',`/repos/${GITHUB_REPO}/contents/${dir}?ref=${GITHUB_BRANCH}`); const it=Array.isArray(list)?list.find(x=>x.name===name):null; sha=it?it.sha:null; } catch {}
    const body={ message:msg, branch:GITHUB_BRANCH, content:Buffer.from(JSON.stringify(obj,null,2)).toString('base64') }; if(sha) body.sha=sha;
    return gh('PUT', `/repos/${GITHUB_REPO}/contents/${path}`, body);
}

async function run() {
    if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN missing.');
    console.log(`\n🧱 ratio-history-consolidate — ${new Date().toISOString()}\n   repo: ${GITHUB_REPO}@${GITHUB_BRANCH}\n`);

    // 1) list daily archives
    let list;
    try { list = await gh('GET', `/repos/${GITHUB_REPO}/contents/data/daily?ref=${GITHUB_BRANCH}`); }
    catch (e) { throw new Error(`cannot list data/daily: ${e.message}`); }
    const days = (Array.isArray(list) ? list : []).filter(x => /^\d{4}-\d{2}-\d{2}\.json$/.test(x.name)).map(x => x.name.replace('.json','')).sort();
    console.log(`   found ${days.length} daily archives (${days[0] || '—'} → ${days.at(-1) || '—'})`);

    // 2) seed from any existing ratio-history.json (merge-safe)
    const prev = await rawGet('data/ratio-history.json');
    const tokens = (prev && prev.tokens) ? prev.tokens : {};
    const ensure = (tok) => tokens[tok] || (tokens[tok] = { base: BASES[tok], points: [] });
    const upsert = (tok, date, rate) => { const t = ensure(tok); const i = t.points.findIndex(p => p[0] === date); if (i >= 0) t.points[i][1] = rate; else t.points.push([date, rate]); };

    // 3) walk each daily archive, fold in its lst_ratios
    let scanned = 0, points = 0, missing = 0;
    for (const date of days) {
        const arch = await rawGet(`data/daily/${date}.json`);
        const lr = arch?.lst_ratios;
        if (!lr) { missing++; continue; }
        scanned++;
        for (const tok of Object.keys(BASES)) {
            const r = Number(lr?.[tok]?.ratio);
            if (r && Number.isFinite(r) && r > 0) { upsert(tok, date, r); points++; }
        }
        if (scanned % 25 === 0) console.log(`   …${scanned} archives folded`);
    }
    for (const t of Object.values(tokens)) t.points.sort((a, b) => a[0].localeCompare(b[0]));

    const doc = { schemaVersion: 1, builtAt: new Date().toISOString(), source: 'consolidated from data/daily/*.json lst_ratios', note: 'Daily LST exchange rates (chain-exact). USD: LST_USD(day) = base_USD(day) × rate(day), join price-history daily-prices.json.', tokens };
    console.log(`\n   archives with ratios: ${scanned} (missing: ${missing}) | day-points folded: ${points}`);
    for (const [tok, t] of Object.entries(tokens)) console.log(`     ${tok.padEnd(8)} ${t.points.length} points (${t.points[0]?.[0] || '—'} → ${t.points.at(-1)?.[0] || '—'})`);

    await publish('data/ratio-history.json', doc, `🧱 consolidate ratio-history from ${scanned} daily archives`);
    console.log(`\n✅ published data/ratio-history.json — ${Object.keys(tokens).length} tokens`);
}
if (require.main === module) run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
