/**
 * Script de testing — pobla SOLO el lado cubano con 20 submissions
 * aprobadas, listas para que el streamer entre a la fase de eliminacion.
 * No lockea el equipo, no toca PR. Sirve para ver visualmente como queda
 * la pantalla de eliminacion con muchas cards.
 *
 *   node test-elim-cuba.js
 */

const BASE = process.env.BASE || 'https://elpajaro.onrender.com';
const PIN_CUBA = process.env.PIN_CUBA;
if (!PIN_CUBA) {
  console.error('Falta env var PIN_CUBA.');
  process.exit(1);
}

// IDs de videos REALES de YouTube (verificados que existen) — random mix de
// musica latina/popular para que cuando el user abra un modal, el clip
// suene de verdad. NO necesariamente son las canciones reales de los
// artistas nombrados — es solo demo data.
const CUBANOS = [
  { name: 'Bebeshito',         ig: 'bebeshito_oficial',   url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk' },  // Despacito
  { name: 'Chocolate MC',      ig: 'chocolatemc_oficial', url: 'https://www.youtube.com/watch?v=Cr8K88UcO5s' },  // Tití Me Preguntó
  { name: 'El Taiger',         ig: 'eltaiger_oficial',    url: 'https://www.youtube.com/watch?v=eRcox9Snpps' },  // Daddy Yankee Gasolina
  { name: 'Yomil y El Dany',   ig: 'yomilyeldany',        url: 'https://www.youtube.com/watch?v=KAwyWkksXuo' },  // Daddy Yankee
  { name: 'Charly y Manuel',   ig: 'charlymanuel',        url: 'https://www.youtube.com/watch?v=7N8Aru1MAuc' },  // El Taxi (real)
  { name: 'El Chacal',         ig: 'elchacal_oficial',    url: 'https://www.youtube.com/watch?v=tg00YEETFzg' },
  { name: 'El Micha',          ig: 'elmicha',             url: 'https://www.youtube.com/watch?v=oG1D_o6BGI0' },
  { name: 'Wampi',             ig: 'wampi_oficial',       url: 'https://www.youtube.com/watch?v=Tt6x2qKlwXE' },
  { name: 'Insurrecto',        ig: 'insurrecto',          url: 'https://www.youtube.com/watch?v=DyDfgMOUjCI' },
  { name: 'La Diosa',          ig: 'ladiosaofficial',     url: 'https://www.youtube.com/watch?v=tT9Eh8wNMkw' },
  { name: 'La Reina y la Real',ig: 'lareinaylareal',      url: 'https://www.youtube.com/watch?v=VZkwHwTeCPg' },
  { name: 'Wow Popy',          ig: 'wowpopy',             url: 'https://www.youtube.com/watch?v=fb-j4Nt1cT0' },
  { name: 'El Kimiko y Yordy', ig: 'kimikoyyordy',        url: 'https://www.youtube.com/watch?v=B6_iQvaIjXw' },
  { name: 'Lenier Mesa',       ig: 'leniermesa',          url: 'https://www.youtube.com/watch?v=q0hyYWKXF0Q' },
  { name: 'Cimafunk',          ig: 'cimafunk',            url: 'https://www.youtube.com/watch?v=wlYx1JUS6ts' },
  { name: 'El Negrito',        ig: 'elnegritopalante',    url: 'https://www.youtube.com/watch?v=pRpeEdMmmQ0' },
  { name: 'Manu Manu',         ig: 'manumanuflow',        url: 'https://www.youtube.com/watch?v=fHI8X4OXluQ' },
  { name: 'El Príncipe',       ig: 'elprincipecuba',      url: 'https://www.youtube.com/watch?v=6Ejga4kJUts' },
  { name: 'Damian',            ig: 'damianoficial',       url: 'https://www.youtube.com/watch?v=PT2_F-1esPk' },
  { name: 'Robe L. Ninja',     ig: 'robelninja',          url: 'https://www.youtube.com/watch?v=hT_nvWreIhg' },
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
