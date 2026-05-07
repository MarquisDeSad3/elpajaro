/**
 * Script de testing — llena producción con 16 submissions reales (8 reparto
 * cubano + 8 urbano PR), las aprueba, lockea ambos equipos, y dispara
 * "ESTOY LISTO" para que el show arranque automaticamente.
 *
 * Para correr:
 *   node test-populate.js
 *
 * Borra el state existente al inicio (reset-all). NO usar en show real.
 */

const BASE = process.env.BASE || 'https://elpajaro.onrender.com';
const PIN_CUBA = process.env.PIN_CUBA;
const PIN_PR   = process.env.PIN_PR;
if (!PIN_CUBA || !PIN_PR) {
  console.error('Faltan env vars PIN_CUBA y PIN_PR.');
  process.exit(1);
}

const CUBANOS = [
  { name: 'Bebeshito',      ig: 'bebeshito_oficial',     url: 'https://www.youtube.com/watch?v=8U5N5sk0WlQ' },  // Bebeshito - Una Loca
  { name: 'Chocolate MC',   ig: 'chocolatemc_oficial',   url: 'https://www.youtube.com/watch?v=zvCBSSwgtg4' },  // Chocolate MC
  { name: 'El Taiger',      ig: 'eltaiger_oficial',      url: 'https://www.youtube.com/watch?v=7q-7iz1L9C4' },  // El Taiger
  { name: 'Yomil y El Dany',ig: 'yomilyeldany',          url: 'https://www.youtube.com/watch?v=6c-cWKbwQpU' },
  { name: 'Charly y Manuel',ig: 'charlymanuel',          url: 'https://www.youtube.com/watch?v=7N8Aru1MAuc' },  // El Taxi
  { name: 'El Chacal',      ig: 'elchacal_oficial',      url: 'https://www.youtube.com/watch?v=z9j4i3Vy9nU' },
  { name: 'El Micha',       ig: 'elmicha',               url: 'https://www.youtube.com/watch?v=v6mOuk-S6tg' },
  { name: 'Wampi',          ig: 'wampi_oficial',         url: 'https://www.youtube.com/watch?v=DmbFUBwYBV4' },
];

const PUERTORRIQUENOS = [
  { name: 'Bad Bunny',      ig: 'badbunnypr',           url: 'https://www.youtube.com/watch?v=Cr8K88UcO5s' },  // Tití Me Preguntó
  { name: 'Daddy Yankee',   ig: 'daddyyankee',          url: 'https://www.youtube.com/watch?v=eRcox9Snpps' },  // Gasolina
  { name: 'Anuel AA',       ig: 'anuel',                url: 'https://www.youtube.com/watch?v=A3ZWUcbE1qg' },
  { name: 'Don Omar',       ig: 'donomar',              url: 'https://www.youtube.com/watch?v=7zp1TbLFPp8' },  // Danza Kuduro
  { name: 'Wisin & Yandel', ig: 'wisinyandel',          url: 'https://www.youtube.com/watch?v=DcHKOC64KnE' },
  { name: 'Tego Calderón',  ig: 'tegocalderon',         url: 'https://www.youtube.com/watch?v=g5gWvNRBA5g' },
  { name: 'Eladio Carrión', ig: 'eladiocarrionn',       url: 'https://www.youtube.com/watch?v=YH0qQ-iMZ8Q' },
  { name: 'Myke Towers',    ig: 'myketowerscolombia',   url: 'https://www.youtube.com/watch?v=mGvL14P1xek' },
];

async function api(path, body, token, headers = {}) {
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ ...(body || {}), ...(token ? { token } : {}) }),
  };
  const res = await fetch(BASE + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!data.ok && res.status !== 401 && res.status !== 403) {
    console.warn(`   [${res.status}] ${path}: ${data.error || 'error'}`);
  }
  return { status: res.status, data };
}

async function getState() {
  const r = await fetch(BASE + '/api/state');
  return (await r.json()).state;
}

async function run() {
  console.log(`→ TARGET: ${BASE}\n`);

  // 1) Login + reset
  console.log('1. Login + reset all');
  let r = await api('/api/admin/login', { pin: PIN_CUBA, role: 'cuba' });
  if (!r.data.ok) throw new Error('Login Cuba fallo. PIN: ' + PIN_CUBA);
  const tokenCuba = r.data.token;

  r = await api('/api/admin/login', { pin: PIN_PR, role: 'pr' });
  if (!r.data.ok) throw new Error('Login PR fallo. PIN: ' + PIN_PR);
  const tokenPr = r.data.token;

  r = await api('/api/admin/login', { pin: PIN_CUBA, role: 'master' });
  const tokenMaster = r.data.token;

  await api('/api/master/reset-all', {}, tokenMaster);
  console.log('   ✓ reset OK');

  // 2) Submissions publicas
  console.log('\n2. Mandando 16 submissions publicas');
  for (let i = 0; i < CUBANOS.length; i++) {
    const a = CUBANOS[i];
    const ip = `1.1.1.${i + 30}`;
    await api('/api/submit', { country: 'cuba', name: a.name, instagram: a.ig, mediaUrl: a.url }, null, { 'X-Forwarded-For': ip });
    console.log(`   🇨🇺 ${a.name}`);
  }
  for (let i = 0; i < PUERTORRIQUENOS.length; i++) {
    const a = PUERTORRIQUENOS[i];
    const ip = `2.2.2.${i + 30}`;
    await api('/api/submit', { country: 'pr', name: a.name, instagram: a.ig, mediaUrl: a.url }, null, { 'X-Forwarded-For': ip });
    console.log(`   🇵🇷 ${a.name}`);
  }

  // 3) Aprobar todas
  console.log('\n3. Aprobando todas');
  const cubaList = await api('/api/admin/cuba/list', {}, tokenCuba);
  const cubaIds = cubaList.data.items.map(s => s.id);
  for (const id of cubaIds) await api('/api/admin/cuba/approve', { id }, tokenCuba);
  console.log(`   ✓ Cuba: ${cubaIds.length} aprobados`);

  const prList = await api('/api/admin/pr/list', {}, tokenPr);
  const prIds = prList.data.items.map(s => s.id);
  for (const id of prIds) await api('/api/admin/pr/approve', { id }, tokenPr);
  console.log(`   ✓ PR: ${prIds.length} aprobados`);

  // 4) Lockear los 8 (modo manual)
  console.log('\n4. Lockeando equipos (modo manual)');
  await api('/api/admin/cuba/lock', { ids: cubaIds.slice(0, 8) }, tokenCuba);
  await api('/api/admin/pr/lock',   { ids: prIds.slice(0, 8) },   tokenPr);
  console.log('   ✓ ambos lockeados');

  // 5) "ESTOY LISTO" -> show auto-arranca
  console.log('\n5. ESTOY LISTO los dos lados');
  await api('/api/admin/cuba/ready', { ready: true }, tokenCuba);
  console.log('   ✓ Cuba listo (esperando PR)');
  const ready = await api('/api/admin/pr/ready', { ready: true }, tokenPr);
  if (ready.data.showStarted) {
    console.log('   🏆 PR listo → SHOW AUTO-ARRANCO');
  }

  // 6) Verificar
  console.log('\n6. Estado final');
  const st = await getState();
  console.log('   showStarted:', st.showStarted);
  console.log('   bracket rondas:', st.bracket?.rounds?.length);
  console.log('   contestants:', Object.keys(st.contestants).length);
  console.log('   primer match:', JSON.stringify({
    leftId: st.bracket.rounds[0][0].leftId,
    rightId: st.bracket.rounds[0][0].rightId,
    leftName: st.contestants[st.bracket.rounds[0][0].leftId]?.name,
    rightName: st.contestants[st.bracket.rounds[0][0].rightId]?.name,
  }));

  console.log('\n✓ LISTO. Abrí estas URLs en tu browser:');
  console.log(`   - Master: ${BASE}/panel/master`);
  console.log(`   - Show:   ${BASE}/show`);
}

run().catch(e => { console.error('FAIL:', e.message); process.exitCode = 1; });
