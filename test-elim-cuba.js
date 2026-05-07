/**
 * Script de testing — pobla SOLO el lado cubano con 20 submissions
 * aprobadas, listas para que el streamer entre a la fase de eliminacion.
 * No lockea el equipo, no toca PR. Sirve para ver visualmente como queda
 * la pantalla de eliminacion con muchas cards.
 *
 *   node test-elim-cuba.js
 */

const BASE = process.env.BASE || 'https://elpajaro.onrender.com';
const PIN_CUBA = process.env.PIN_CUBA || '090809';
const PIN_PR   = process.env.PIN_PR   || '872346';

const CUBANOS = [
  { name: 'Bebeshito',         ig: 'bebeshito_oficial',   url: 'https://www.youtube.com/watch?v=8U5N5sk0WlQ' },
  { name: 'Chocolate MC',      ig: 'chocolatemc_oficial', url: 'https://www.youtube.com/watch?v=zvCBSSwgtg4' },
  { name: 'El Taiger',         ig: 'eltaiger_oficial',    url: 'https://www.youtube.com/watch?v=7q-7iz1L9C4' },
  { name: 'Yomil y El Dany',   ig: 'yomilyeldany',        url: 'https://www.youtube.com/watch?v=6c-cWKbwQpU' },
  { name: 'Charly y Manuel',   ig: 'charlymanuel',        url: 'https://www.youtube.com/watch?v=7N8Aru1MAuc' },
  { name: 'El Chacal',         ig: 'elchacal_oficial',    url: 'https://www.youtube.com/watch?v=z9j4i3Vy9nU' },
  { name: 'El Micha',          ig: 'elmicha',             url: 'https://www.youtube.com/watch?v=v6mOuk-S6tg' },
  { name: 'Wampi',             ig: 'wampi_oficial',       url: 'https://www.youtube.com/watch?v=DmbFUBwYBV4' },
  { name: 'Insurrecto',        ig: 'insurrecto',          url: 'https://www.youtube.com/watch?v=7xkSJ7VtsCg' },
  { name: 'La Diosa',          ig: 'ladiosaofficial',     url: 'https://www.youtube.com/watch?v=Wa1nUlwPBr0' },
  { name: 'La Reina y la Real',ig: 'lareinaylareal',      url: 'https://www.youtube.com/watch?v=z0PWQAxGTDU' },
  { name: 'Wow Popy',          ig: 'wowpopy',             url: 'https://www.youtube.com/watch?v=XL7Pdx2_QDY' },
  { name: 'El Kimiko y Yordy', ig: 'kimikoyyordy',        url: 'https://www.youtube.com/watch?v=8DQH9GUC8Tg' },
  { name: 'Lenier Mesa',       ig: 'leniermesa',          url: 'https://www.youtube.com/watch?v=LRUyQJlBFmA' },
  { name: 'Cimafunk',          ig: 'cimafunk',            url: 'https://www.youtube.com/watch?v=qoq6Tl4MSwU' },
  { name: 'El Negrito',        ig: 'elnegritopalante',    url: 'https://www.youtube.com/watch?v=0EAXWmmczZE' },
  { name: 'Manu Manu',         ig: 'manumanuflow',        url: 'https://www.youtube.com/watch?v=2vV4WGTvpSE' },
  { name: 'El Príncipe',       ig: 'elprincipecuba',      url: 'https://www.youtube.com/watch?v=Q2qZTI60dCU' },
  { name: 'Damian',            ig: 'damianoficial',       url: 'https://www.youtube.com/watch?v=l1z3zQTmqU8' },
  { name: 'Robe L. Ninja',     ig: 'robelninja',          url: 'https://www.youtube.com/watch?v=4xDzrJKXOOY' },
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

async function run() {
  console.log(`→ TARGET: ${BASE}\n`);

  // Login + reset
  let r = await api('/api/admin/login', { pin: PIN_CUBA, role: 'master' });
  const tokenMaster = r.data.token;
  await api('/api/master/reset-all', {}, tokenMaster);
  console.log('reset OK\n');

  // Submissions cubanas
  console.log(`Mandando ${CUBANOS.length} submissions cubanas`);
  for (let i = 0; i < CUBANOS.length; i++) {
    const a = CUBANOS[i];
    const ip = `1.1.1.${i + 30}`;
    const res = await api('/api/submit', { country: 'cuba', name: a.name, instagram: a.ig, mediaUrl: a.url }, null, { 'X-Forwarded-For': ip });
    console.log(`  ${i+1}. ${a.name}${res.data.ok ? '' : ' [ERROR: ' + res.data.error + ']'}`);
  }

  // Login cuba + aprobar todas
  r = await api('/api/admin/login', { pin: PIN_CUBA, role: 'cuba' });
  const tokenCuba = r.data.token;
  const list = await api('/api/admin/cuba/list', {}, tokenCuba);
  const ids = list.data.items.map(s => s.id);
  console.log(`\nAprobando ${ids.length} cubanas...`);
  for (const id of ids) await api('/api/admin/cuba/approve', { id }, tokenCuba);
  console.log('  ✓ todas aprobadas\n');

  console.log(`✓ LISTO. Andá a:`);
  console.log(`   ${BASE}/panel/cuba`);
  console.log(`   PIN: ${PIN_CUBA}`);
  console.log(`   → Click "EMPEZAR" para ver la grilla de eliminacion con 20 cards`);
}

run().catch(e => { console.error('FAIL:', e.message); process.exitCode = 1; });
