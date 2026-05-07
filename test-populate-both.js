/**
 * Llena AMBOS lados (20 cuba + 20 PR) con submissions REALES verificadas
 * via WebSearch — todos los YouTube IDs apuntan a videos que existen.
 * Las miniaturas (thumbnails) deben aparecer correctas en el grid.
 *
 * NO lockea ni arranca el show — solo deja todo listo para testear el
 * flow de eliminacion en ambos /panel/cuba y /panel/pr.
 *
 *   node test-populate-both.js
 */

const BASE = process.env.BASE || 'https://elpajaro.onrender.com';
const PIN_CUBA = process.env.PIN_CUBA || '090809';
const PIN_PR   = process.env.PIN_PR   || '872346';

// ===== CUBA (reparto / urbano cubano) — 20 artistas, links verificados =====
const CUBANOS = [
  { name: 'Bebeshito',          ig: 'bebeshito_oficial',   url: 'https://www.youtube.com/watch?v=tHT3jLdyEC8' },  // Una Locura Mi Amor
  { name: 'El Taiger',          ig: 'eltaiger_oficial',    url: 'https://www.youtube.com/watch?v=mfwsv76WAxs' },  // Zelle
  { name: 'Yomil y El Dany',    ig: 'yomilyeldany',        url: 'https://www.youtube.com/watch?v=zgEOgOWfPT0' },  // De lo que uno se entera
  { name: 'El Chacal',          ig: 'elchacal_oficial',    url: 'https://www.youtube.com/watch?v=gfsv1yEdhoE' },  // Los Cubanos
  { name: 'El Micha',           ig: 'elmicha',             url: 'https://www.youtube.com/watch?v=cxB9DUAx5sw' },  // UUU Que Dolor
  { name: 'Wampi',              ig: 'wampi_oficial',       url: 'https://www.youtube.com/watch?v=q8CdBZAFgRs' },  // Traqueteo
  { name: 'Insurrecto',         ig: 'insurrecto',          url: 'https://www.youtube.com/watch?v=YPRVJvjrNLU' },  // 7 Mujeres
  { name: 'La Diosa',           ig: 'ladiosaofficial',     url: 'https://www.youtube.com/watch?v=viT213LA0ts' },  // Por debajo del Agua
  { name: 'Wow Popy',           ig: 'wowpopy',             url: 'https://www.youtube.com/watch?v=GLMeCJA2NIk' },  // El Bárbaro del Reparto
  { name: 'El Kimiko y Yordy',  ig: 'kimikoyyordy',        url: 'https://www.youtube.com/watch?v=rxkKpTM2tb0' },  // El Campeón
  { name: 'Lenier Mesa',        ig: 'lenieroficial',       url: 'https://www.youtube.com/watch?v=G3_GpxWWvHA' },  // Te Amo Mamá
  { name: 'Cimafunk',           ig: 'cimafunk',            url: 'https://www.youtube.com/watch?v=o1YBngPfU-o' },  // Me Voy
  { name: 'El Negrito y Manu',  ig: 'elnegritopalante',    url: 'https://www.youtube.com/watch?v=85WDrXyc0Zc' },  // Mi Jevita Se Fundió
  { name: 'Charly y Johayron',  ig: 'charlyjohayron',      url: 'https://www.youtube.com/watch?v=oQAjnw0eA-E' },  // MELA
  { name: 'Jacob Forever',      ig: 'jacobforever',        url: 'https://www.youtube.com/watch?v=iMow7JqblH0' },  // La Dura
  { name: 'Yulien Oviedo',      ig: 'yulien_oviedo',       url: 'https://www.youtube.com/watch?v=kfiMYAd8kXw' },  // Cuba está de Moda
  { name: 'Baby Lores',         ig: 'babylores537',        url: 'https://www.youtube.com/watch?v=2IhSxR5ItYQ' },  // Sugar Daddy
  { name: 'Los 4',              ig: 'los4cuba',            url: 'https://www.youtube.com/watch?v=A3HFu5d-XsA' },  // Yo Si Y Tu No (con El Taiger)
  { name: 'El Chulo',           ig: 'elchulocuba',         url: 'https://www.youtube.com/watch?v=vL8XiovJAFU' },  // Avanza (con Divan)
  { name: 'Dany Ome',           ig: 'danyome',             url: 'https://www.youtube.com/watch?v=xPXrduoXa-I' },  // La Carpintera
];

// ===== PUERTO RICO (reggaeton / rap urbano) — 20 artistas, links verificados =====
const PUERTORRIQUENOS = [
  { name: 'Bad Bunny',          ig: 'badbunnypr',          url: 'https://www.youtube.com/watch?v=Cr8K88UcO0s' },  // Tití Me Preguntó
  { name: 'Daddy Yankee',       ig: 'daddyyankee',         url: 'https://www.youtube.com/watch?v=CCF1_jI8Prk' },  // Gasolina
  { name: 'Don Omar',           ig: 'donomar',             url: 'https://www.youtube.com/watch?v=7zp1TbLFPp8' },  // Danza Kuduro
  { name: 'Anuel AA',           ig: 'anuel',               url: 'https://www.youtube.com/watch?v=BgeEPK9aAp4' },  // Sola
  { name: 'Wisin & Yandel',     ig: 'wisinyandel',         url: 'https://www.youtube.com/watch?v=giMhlfc6pzw' },  // Rakata
  { name: 'Tego Calderón',      ig: 'tegocalderonpr',      url: 'https://www.youtube.com/watch?v=E7XwDLwEb4Y' },  // Pa Que Retozen
  { name: 'Eladio Carrión',     ig: 'eladiocarrionn',      url: 'https://www.youtube.com/watch?v=yDhxCiLXEHs' },  // Mbappé
  { name: 'Myke Towers',        ig: 'myketowers_',         url: 'https://www.youtube.com/watch?v=2_f5Os7mKqM' },  // Diosa
  { name: 'Rauw Alejandro',     ig: 'rauwalejandro',       url: 'https://www.youtube.com/watch?v=CFPLIaMpGrY' },  // Todo De Ti
  { name: 'Ozuna',              ig: 'ozuna',               url: 'https://www.youtube.com/watch?v=eAN7vxdQP2s' },  // Te Boté Remix Solo
  { name: 'Nicky Jam',          ig: 'nickyjampr',          url: 'https://www.youtube.com/watch?v=hXI8RQYC36Q' },  // El Perdón
  { name: 'Jhay Cortez',        ig: 'jhaycortez',          url: 'https://www.youtube.com/watch?v=TmKh7lAwnBI' },  // Dakiti (con Bad Bunny)
  { name: 'Lunay',              ig: 'lunay',               url: 'https://www.youtube.com/watch?v=8zQTfGbyY5I' },  // Soltera Remix
  { name: 'Cosculluela',        ig: 'cosculluela',         url: 'https://www.youtube.com/watch?v=SyJVurthfTA' },  // LA QUE HAY
  { name: 'Calle 13',           ig: 'calle13oficial',      url: 'https://www.youtube.com/watch?v=gcOknZbStOY' },  // Atrévete-te-te
  { name: 'Arcángel',           ig: 'arcangel',            url: 'https://www.youtube.com/watch?v=VRUjdlCynU0' },  // Sigues Con Él
  { name: 'Farruko',            ig: 'farrukopr',           url: 'https://www.youtube.com/watch?v=y8trd3gjJt0' },  // Pepas
  { name: 'Plan B',             ig: 'planbpr',             url: 'https://www.youtube.com/watch?v=SB8-YY2DyHI' },  // Mi Vecinita
  { name: 'Ivy Queen',          ig: 'ivyqueendiva',        url: 'https://www.youtube.com/watch?v=xAK8M2vRqe0' },  // Yo Quiero Bailar
  { name: 'Tito El Bambino',    ig: 'titoelbambino',       url: 'https://www.youtube.com/watch?v=KI1yOlb1uWA' },  // El Amor
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

  // Login. NO HACEMOS RESET — para no borrar inscripciones reales que
  // pudieran haber llegado entre runs. Si querés un reset, correlo manualmente
  // pasando RESET=1 como env var: RESET=1 node test-populate-both.js
  let r = await api('/api/admin/login', { pin: PIN_CUBA, role: 'master' });
  const tokenMaster = r.data.token;
  if (process.env.RESET === '1') {
    await api('/api/master/reset-all', {}, tokenMaster);
    console.log('⚠ RESET=1 — wipe completo OK\n');
  } else {
    console.log('(no reset — agregando submissions sobre el state actual)\n');
  }

  // Submissions cubanas
  console.log(`Mandando ${CUBANOS.length} cubanas`);
  for (let i = 0; i < CUBANOS.length; i++) {
    const a = CUBANOS[i];
    await api('/api/submit', { country: 'cuba', name: a.name, instagram: a.ig, mediaUrl: a.url }, null, { 'X-Forwarded-For': `1.1.1.${i + 30}` });
    console.log(`  🇨🇺 ${a.name}`);
  }

  // Submissions PR
  console.log(`\nMandando ${PUERTORRIQUENOS.length} PR`);
  for (let i = 0; i < PUERTORRIQUENOS.length; i++) {
    const a = PUERTORRIQUENOS[i];
    await api('/api/submit', { country: 'pr', name: a.name, instagram: a.ig, mediaUrl: a.url }, null, { 'X-Forwarded-For': `2.2.2.${i + 30}` });
    console.log(`  🇵🇷 ${a.name}`);
  }

  // Aprobar todas
  r = await api('/api/admin/login', { pin: PIN_CUBA, role: 'cuba' });
  const tokenCuba = r.data.token;
  let list = await api('/api/admin/cuba/list', {}, tokenCuba);
  console.log(`\nAprobando ${list.data.items.length} cubanas...`);
  for (const s of list.data.items) await api('/api/admin/cuba/approve', { id: s.id }, tokenCuba);
  console.log('  ✓ Cuba todas aprobadas');

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
}

run().catch(e => { console.error('FAIL:', e.message); process.exitCode = 1; });
