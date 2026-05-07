/**
 * Agrega 9 submissions cubanas + 9 PR (sin reset). NO borra nada del state
 * existente.
 *
 *   PIN_CUBA=xxx PIN_PR=yyy node test-add-9.js
 */

const BASE = process.env.BASE || 'https://elpajaro.stream';
const PIN_CUBA = process.env.PIN_CUBA;
const PIN_PR   = process.env.PIN_PR;
if (!PIN_CUBA || !PIN_PR) {
  console.error('Faltan env vars PIN_CUBA y PIN_PR.');
  process.exit(1);
}

// 9 cuba — subset del set verificado anteriormente, con thumbnails reales
const CUBANOS = [
  { name: 'Bebeshito',         ig: 'bebeshito_oficial', url: 'https://www.youtube.com/watch?v=tHT3jLdyEC8' },
  { name: 'El Taiger',         ig: 'eltaiger_oficial',  url: 'https://www.youtube.com/watch?v=mfwsv76WAxs' },
  { name: 'Yomil y El Dany',   ig: 'yomilyeldany',      url: 'https://www.youtube.com/watch?v=zgEOgOWfPT0' },
  { name: 'El Chacal',         ig: 'elchacal_oficial',  url: 'https://www.youtube.com/watch?v=gfsv1yEdhoE' },
  { name: 'El Micha',          ig: 'elmicha',           url: 'https://www.youtube.com/watch?v=cxB9DUAx5sw' },
  { name: 'Wampi',             ig: 'wampi_oficial',     url: 'https://www.youtube.com/watch?v=q8CdBZAFgRs' },
  { name: 'Wow Popy',          ig: 'wowpopy',           url: 'https://www.youtube.com/watch?v=GLMeCJA2NIk' },
  { name: 'Cimafunk',          ig: 'cimafunk',          url: 'https://www.youtube.com/watch?v=o1YBngPfU-o' },
  { name: 'Yulien Oviedo',     ig: 'yulien_oviedo',     url: 'https://www.youtube.com/watch?v=kfiMYAd8kXw' },
];

const PUERTORRIQUENOS = [
  { name: 'Bad Bunny',         ig: 'badbunnypr',        url: 'https://www.youtube.com/watch?v=Cr8K88UcO0s' },
  { name: 'Daddy Yankee',      ig: 'daddyyankee',       url: 'https://www.youtube.com/watch?v=CCF1_jI8Prk' },
  { name: 'Don Omar',          ig: 'donomar',           url: 'https://www.youtube.com/watch?v=7zp1TbLFPp8' },
  { name: 'Anuel AA',          ig: 'anuel',             url: 'https://www.youtube.com/watch?v=BgeEPK9aAp4' },
  { name: 'Wisin & Yandel',    ig: 'wisinyandel',       url: 'https://www.youtube.com/watch?v=giMhlfc6pzw' },
  { name: 'Tego Calderón',     ig: 'tegocalderonpr',    url: 'https://www.youtube.com/watch?v=E7XwDLwEb4Y' },
  { name: 'Myke Towers',       ig: 'myketowers_',       url: 'https://www.youtube.com/watch?v=2_f5Os7mKqM' },
  { name: 'Farruko',           ig: 'farrukopr',         url: 'https://www.youtube.com/watch?v=y8trd3gjJt0' },
  { name: 'Calle 13',          ig: 'calle13oficial',    url: 'https://www.youtube.com/watch?v=gcOknZbStOY' },
];

async function api(path, body, token, headers = {}) {
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ ...(body || {}), ...(token ? { token } : {}) }),
  };
  const res = await fetch(BASE + path, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// IPs random (con timestamp + index) para no chocar con submissions previas
function randomIp(seed) {
  return `9.${(Date.now() % 200) + 10}.${(seed * 7) % 200}.${(seed * 13) % 200}`;
}

async function run() {
  console.log(`→ TARGET: ${BASE}\n`);

  // Cuba
  console.log('Mandando 9 cubanas (sin reset)');
  let added = 0;
  for (let i = 0; i < CUBANOS.length; i++) {
    const a = CUBANOS[i];
    const r = await api('/api/submit', { country: 'cuba', name: a.name, instagram: a.ig, mediaUrl: a.url }, null, { 'X-Forwarded-For': randomIp(i) });
    if (r.data.ok) { added++; console.log(`  🇨🇺 ${a.name}`); }
    else            { console.log(`  ⊘ ${a.name} → ${r.data.error}`); }
  }
  console.log(`  Cuba: ${added}/9 nuevas\n`);

  // PR
  console.log('Mandando 9 PR');
  added = 0;
  for (let i = 0; i < PUERTORRIQUENOS.length; i++) {
    const a = PUERTORRIQUENOS[i];
    const r = await api('/api/submit', { country: 'pr', name: a.name, instagram: a.ig, mediaUrl: a.url }, null, { 'X-Forwarded-For': randomIp(i + 100) });
    if (r.data.ok) { added++; console.log(`  🇵🇷 ${a.name}`); }
    else            { console.log(`  ⊘ ${a.name} → ${r.data.error}`); }
  }
  console.log(`  PR: ${added}/9 nuevas\n`);

  // Aprobar todos
  let r = await api('/api/admin/login', { pin: PIN_CUBA, role: 'cuba' });
  const tokenCuba = r.data.token;
  const list = await api('/api/admin/cuba/list', {}, tokenCuba);
  const pendingCuba = list.data.items.filter(s => s.status === 'pending');
  for (const s of pendingCuba) await api('/api/admin/cuba/approve', { id: s.id }, tokenCuba);
  console.log(`✓ Cuba: aprobadas ${pendingCuba.length} pendientes`);

  r = await api('/api/admin/login', { pin: PIN_PR, role: 'pr' });
  const tokenPr = r.data.token;
  const listPr = await api('/api/admin/pr/list', {}, tokenPr);
  const pendingPr = listPr.data.items.filter(s => s.status === 'pending');
  for (const s of pendingPr) await api('/api/admin/pr/approve', { id: s.id }, tokenPr);
  console.log(`✓ PR: aprobadas ${pendingPr.length} pendientes`);

  console.log(`\n→ Probá: ${BASE}/panel/cuba  y  ${BASE}/panel/pr`);
}

run().catch(e => { console.error('FAIL:', e.message); process.exitCode = 1; });
