/**
 * Llena AMBOS lados (20 cuba + 20 PR) con submissions aprobadas, listos
 * para que los dos streamers hagan eliminaciones en sus paneles.
 *
 * NO lockea ni arranca el show — solo deja todo listo para testear el
 * flow de eliminacion en ambos /panel/cuba y /panel/pr.
 *
 *   node test-populate-both.js
 */

const BASE = process.env.BASE || 'https://elpajaro.onrender.com';
const PIN_CUBA = process.env.PIN_CUBA || '090809';
const PIN_PR   = process.env.PIN_PR   || '872346';

// IDs reales de YouTube (videos populares de musica latina) — muchos artistas
// nombrados aca NO son los duenos del video. Es solo data demo para que el
// embed reproduzca algo real cuando se abra el modal.
const CUBANOS = [
  { name: 'Bebeshito',          ig: 'bebeshito_oficial',   url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk' },  // Despacito
  { name: 'Chocolate MC',       ig: 'chocolatemc_oficial', url: 'https://www.youtube.com/watch?v=Cr8K88UcO5s' },  // Tití Me Preguntó
  { name: 'El Taiger',          ig: 'eltaiger_oficial',    url: 'https://www.youtube.com/watch?v=eRcox9Snpps' },  // Gasolina
  { name: 'Yomil y El Dany',    ig: 'yomilyeldany',        url: 'https://www.youtube.com/watch?v=7N8Aru1MAuc' },  // El Taxi (real)
  { name: 'Charly y Manuel',    ig: 'charlymanuel',        url: 'https://www.youtube.com/watch?v=KAwyWkksXuo' },
  { name: 'El Chacal',          ig: 'elchacal_oficial',    url: 'https://www.youtube.com/watch?v=tg00YEETFzg' },
  { name: 'El Micha',           ig: 'elmicha',             url: 'https://www.youtube.com/watch?v=oG1D_o6BGI0' },
  { name: 'Wampi',              ig: 'wampi_oficial',       url: 'https://www.youtube.com/watch?v=Tt6x2qKlwXE' },
  { name: 'Insurrecto',         ig: 'insurrecto',          url: 'https://www.youtube.com/watch?v=DyDfgMOUjCI' },
  { name: 'La Diosa',           ig: 'ladiosaofficial',     url: 'https://www.youtube.com/watch?v=tT9Eh8wNMkw' },
  { name: 'La Reina y la Real', ig: 'lareinaylareal',      url: 'https://www.youtube.com/watch?v=VZkwHwTeCPg' },
  { name: 'Wow Popy',           ig: 'wowpopy',             url: 'https://www.youtube.com/watch?v=fb-j4Nt1cT0' },
  { name: 'El Kimiko y Yordy',  ig: 'kimikoyyordy',        url: 'https://www.youtube.com/watch?v=B6_iQvaIjXw' },
  { name: 'Lenier Mesa',        ig: 'leniermesa',          url: 'https://www.youtube.com/watch?v=q0hyYWKXF0Q' },
  { name: 'Cimafunk',           ig: 'cimafunk',            url: 'https://www.youtube.com/watch?v=wlYx1JUS6ts' },
  { name: 'El Negrito',         ig: 'elnegritopalante',    url: 'https://www.youtube.com/watch?v=pRpeEdMmmQ0' },
  { name: 'Manu Manu',          ig: 'manumanuflow',        url: 'https://www.youtube.com/watch?v=fHI8X4OXluQ' },
  { name: 'El Príncipe',        ig: 'elprincipecuba',      url: 'https://www.youtube.com/watch?v=6Ejga4kJUts' },
  { name: 'Damian',             ig: 'damianoficial',       url: 'https://www.youtube.com/watch?v=PT2_F-1esPk' },
  { name: 'Robe L. Ninja',      ig: 'robelninja',          url: 'https://www.youtube.com/watch?v=hT_nvWreIhg' },
];

const PUERTORRIQUENOS = [
  { name: 'Bad Bunny',          ig: 'badbunnypr',          url: 'https://www.youtube.com/watch?v=Cr8K88UcO5s' },
  { name: 'Daddy Yankee',       ig: 'daddyyankee',         url: 'https://www.youtube.com/watch?v=eRcox9Snpps' },
  { name: 'Anuel AA',           ig: 'anuel',               url: 'https://www.youtube.com/watch?v=KAwyWkksXuo' },
  { name: 'Don Omar',           ig: 'donomar',             url: 'https://www.youtube.com/watch?v=7zp1TbLFPp8' },
  { name: 'Wisin & Yandel',     ig: 'wisinyandel',         url: 'https://www.youtube.com/watch?v=DcHKOC64KnE' },
  { name: 'Tego Calderón',      ig: 'tegocalderon',        url: 'https://www.youtube.com/watch?v=g5gWvNRBA5g' },
  { name: 'Eladio Carrión',     ig: 'eladiocarrionn',      url: 'https://www.youtube.com/watch?v=YH0qQ-iMZ8Q' },
  { name: 'Myke Towers',        ig: 'myketowers_',         url: 'https://www.youtube.com/watch?v=mGvL14P1xek' },
  { name: 'Rauw Alejandro',     ig: 'rauwalejandro',       url: 'https://www.youtube.com/watch?v=tT9Eh8wNMkw' },
  { name: 'Ozuna',              ig: 'ozuna',               url: 'https://www.youtube.com/watch?v=Q2qZTI60dCU' },
  { name: 'Nicky Jam',          ig: 'nickyjampr',          url: 'https://www.youtube.com/watch?v=vkM6IddtEmM' },
  { name: 'Jhay Cortez',        ig: 'jhaycortez',          url: 'https://www.youtube.com/watch?v=l1z3zQTmqU8' },
  { name: 'Lunay',              ig: 'lunay',               url: 'https://www.youtube.com/watch?v=z9j4i3Vy9nU' },
  { name: 'Cosculluela',        ig: 'cosculluela',         url: 'https://www.youtube.com/watch?v=z0PWQAxGTDU' },
  { name: 'Tempo',              ig: 'tempo_pr',            url: 'https://www.youtube.com/watch?v=4cFhYCPvGB4' },
  { name: 'Residente',          ig: 'residente',           url: 'https://www.youtube.com/watch?v=W7QZnwKqopo' },
  { name: 'Arcángel',           ig: 'arcangel',            url: 'https://www.youtube.com/watch?v=mGvL14P1xek' },
  { name: 'De La Ghetto',       ig: 'delaghettoreal',      url: 'https://www.youtube.com/watch?v=A3ZWUcbE1qg' },
  { name: 'Farruko',            ig: 'farrukopr',           url: 'https://www.youtube.com/watch?v=Q2qZTI60dCU' },
  { name: 'Plan B',              ig: 'planbpr',            url: 'https://www.youtube.com/watch?v=2vV4WGTvpSE' },
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

  // === Submissions cubanas
  console.log(`Mandando ${CUBANOS.length} cubanas`);
  for (let i = 0; i < CUBANOS.length; i++) {
    const a = CUBANOS[i];
    await api('/api/submit', { country: 'cuba', name: a.name, instagram: a.ig, mediaUrl: a.url }, null, { 'X-Forwarded-For': `1.1.1.${i + 30}` });
    console.log(`  🇨🇺 ${a.name}`);
  }

  // === Submissions PR
  console.log(`\nMandando ${PUERTORRIQUENOS.length} PR`);
  for (let i = 0; i < PUERTORRIQUENOS.length; i++) {
    const a = PUERTORRIQUENOS[i];
    await api('/api/submit', { country: 'pr', name: a.name, instagram: a.ig, mediaUrl: a.url }, null, { 'X-Forwarded-For': `2.2.2.${i + 30}` });
    console.log(`  🇵🇷 ${a.name}`);
  }

  // === Aprobar todas (cuba)
  r = await api('/api/admin/login', { pin: PIN_CUBA, role: 'cuba' });
  const tokenCuba = r.data.token;
  let list = await api('/api/admin/cuba/list', {}, tokenCuba);
  console.log(`\nAprobando ${list.data.items.length} cubanas...`);
  for (const s of list.data.items) await api('/api/admin/cuba/approve', { id: s.id }, tokenCuba);
  console.log('  ✓ Cuba todas aprobadas');

  // === Aprobar todas (pr)
  r = await api('/api/admin/login', { pin: PIN_PR, role: 'pr' });
  const tokenPr = r.data.token;
  list = await api('/api/admin/pr/list', {}, tokenPr);
  console.log(`Aprobando ${list.data.items.length} PR...`);
  for (const s of list.data.items) await api('/api/admin/pr/approve', { id: s.id }, tokenPr);
  console.log('  ✓ PR todas aprobadas');

  console.log(`\n✓ LISTO. Probá las eliminaciones:`);
  console.log(`   Cuba:   ${BASE}/panel/cuba   (PIN ${PIN_CUBA})`);
  console.log(`   PR:     ${BASE}/panel/pr     (PIN ${PIN_PR})`);
  console.log(`   Master: ${BASE}/panel/master`);
  console.log(`\n   En cada panel: click EMPEZAR → click una card → preview del video + decidís PASA / NO PASA`);
  console.log(`   Cuando los 2 lados tengan 8 PASADAS → CERRAR EQUIPO → ESTOY LISTO en master → bracket arranca`);
}

run().catch(e => { console.error('FAIL:', e.message); process.exitCode = 1; });
