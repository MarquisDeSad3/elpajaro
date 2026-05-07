/**
 * Smoke test E2E del nuevo flow:
 *   - login como master
 *   - login como cuba + login como pr (3 roles distintos, mismo PIN)
 *   - submission publica (cuba + pr)
 *   - aprobar submissions
 *   - decidir eliminacion fase 1 (passed)
 *   - lock team de cada pais
 *   - master EMPEZAR show
 *   - bracket: preview, voting/start, propose-decision (cuba) + propose-decision (pr) -> consensus
 *   - reset-all
 *
 * Corre el server en puerto 3099 con HOST_PIN=smoketest.
 * No deploya nada — solo verifica regresiones locales.
 */

const { spawn } = require('child_process');
const path = require('path');

const PORT = 3099;
const PIN = 'smoketest1234';
const BASE = `http://localhost:${PORT}`;

let serverProc;

function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, PORT: String(PORT), HOST_PIN: PIN, NODE_ENV: 'test' },
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let booted = false;
    const onData = (buf) => {
      const s = buf.toString();
      if (!booted && s.includes('El Pajaro corriendo en')) { booted = true; resolve(); }
    };
    serverProc.stdout.on('data', onData);
    serverProc.stderr.on('data', onData);
    setTimeout(() => { if (!booted) reject(new Error('server no arranco a tiempo')); }, 10000);
  });
}

async function api(p, body, token) {
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(body || {}), ...(token ? { token } : {}) }),
  };
  const res = await fetch(BASE + p, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function getJson(p) {
  const res = await fetch(BASE + p);
  return res.json();
}

function assert(cond, label) {
  if (cond) console.log('  ✓', label);
  else { console.error('  ✗', label); throw new Error('FAIL: ' + label); }
}

async function run() {
  console.log('→ booting server...');
  await startServer();
  console.log('  server up\n');

  // ===== Reset previo (por si quedo state.json de pruebas anteriores)
  // No tenemos endpoint de reset sin auth — primero login y luego reset-all.

  // 1) Login como master
  let r = await api('/api/admin/login', { pin: 'wrong', role: 'master' });
  assert(r.status === 401, 'PIN malo devuelve 401');
  r = await api('/api/admin/login', { pin: PIN, role: 'master' });
  assert(r.data.ok && r.data.token && r.data.role === 'master', 'login master OK');
  const tokenMaster = r.data.token;

  // Reset all para empezar limpio
  await api('/api/master/reset-all', {}, tokenMaster);

  // Login cuba
  r = await api('/api/admin/login', { pin: PIN, role: 'cuba' });
  assert(r.data.ok && r.data.role === 'cuba', 'login cuba OK');
  const tokenCuba = r.data.token;

  // Login pr
  r = await api('/api/admin/login', { pin: PIN, role: 'pr' });
  assert(r.data.ok && r.data.role === 'pr', 'login pr OK');
  const tokenPr = r.data.token;

  // 2) Submissions publicas (sin auth)
  // Necesitamos 8 cuba + 8 pr aprobados -> al menos 8 submissions buenas por pais.
  for (let i = 0; i < 8; i++) {
    const fakeIp = `1.1.1.${i + 10}`;
    // Para "diferenciar" la IP cada submission, usamos un X-Forwarded-For.
    // Pero express con trust proxy lee req.ip de eso. Simulamos via headers.
    const res = await fetch(BASE + '/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': fakeIp },
      body: JSON.stringify({
        country: 'cuba',
        name: `Cubano ${i + 1}`,
        instagram: `cubano${i + 1}`,
        mediaUrl: `https://youtube.com/watch?v=cuba${i + 1}`,
      }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(`Cuba submit ${i+1}: ${j.error}`);
  }
  for (let i = 0; i < 8; i++) {
    const fakeIp = `2.2.2.${i + 20}`;
    const res = await fetch(BASE + '/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': fakeIp },
      body: JSON.stringify({
        country: 'pr',
        name: `Boricua ${i + 1}`,
        instagram: `boricua${i + 1}`,
        mediaUrl: `https://youtube.com/watch?v=pr${i + 1}`,
      }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(`PR submit ${i+1}: ${j.error}`);
  }
  let st = (await getJson('/api/state')).state;
  assert(st.countries.cuba.counts.total === 8, 'cuba 8 submissions');
  assert(st.countries.pr.counts.total === 8, 'pr 8 submissions');

  // 3) Aprobar todas las submissions
  r = await api('/api/admin/cuba/list', {}, tokenCuba);
  const cubaIds = r.data.items.map(s => s.id);
  for (const id of cubaIds) {
    const a = await api('/api/admin/cuba/approve', { id }, tokenCuba);
    assert(a.data.ok, `approve cuba ${id.slice(0,4)}`);
  }
  r = await api('/api/admin/pr/list', {}, tokenPr);
  const prIds = r.data.items.map(s => s.id);
  for (const id of prIds) {
    const a = await api('/api/admin/pr/approve', { id }, tokenPr);
    assert(a.data.ok, `approve pr ${id.slice(0,4)}`);
  }

  // 3b) Cuba intenta endpoint de PR — deberia fallar 403
  r = await api('/api/admin/pr/approve', { id: prIds[0] }, tokenCuba);
  assert(r.status === 403, 'cuba no puede tocar endpoints PR');

  // 4) Lock team (sin pasar por eliminacion — modo manual)
  r = await api('/api/admin/cuba/lock', { ids: cubaIds.slice(0, 8) }, tokenCuba);
  assert(r.data.ok, 'lock cuba 8');
  r = await api('/api/admin/pr/lock', { ids: prIds.slice(0, 8) }, tokenPr);
  assert(r.data.ok, 'lock pr 8');

  st = (await getJson('/api/state')).state;
  assert(st.countries.cuba.teamLocked, 'cuba lockeada');
  assert(st.countries.pr.teamLocked, 'pr lockeada');

  // 5) Master arranca el show
  r = await api('/api/master/start-show', { shuffle: false }, tokenMaster);
  assert(r.data.ok, 'master start-show OK');
  st = (await getJson('/api/state')).state;
  assert(st.showStarted, 'show empezado');
  assert(st.bracket && st.bracket.rounds.length === 4, 'bracket 4 rondas');
  assert(st.bracket.rounds[0].length === 8, '8 octofinales');
  assert(Object.keys(st.contestants).length === 16, '16 contestants en state');

  // 6) Master no puede decidir match (solo cuba/pr)
  const m0 = st.bracket.rounds[0][0];
  r = await api('/api/match/propose-decision', { matchId: m0.id, winnerSide: 'left' }, tokenMaster);
  assert(r.status === 403, 'master no puede proponer-decision');

  // 7) Cuba propone left, PR propone left -> consenso
  r = await api('/api/match/propose-decision', { matchId: m0.id, winnerSide: 'left' }, tokenCuba);
  assert(r.data.ok && !r.data.consensus, 'cuba vota, sin consenso aun');
  r = await api('/api/match/propose-decision', { matchId: m0.id, winnerSide: 'left' }, tokenPr);
  assert(r.data.ok && r.data.consensus, 'pr vota mismo lado -> consenso');

  st = (await getJson('/api/state')).state;
  const m0After = st.bracket.rounds[0][0];
  assert(m0After.status === 'done', 'm0 cerrado');
  assert(m0After.winnerId === m0After.leftId, 'gano left');

  // 8) Cuba propone right, PR propone left -> sin consenso, hay discrepancia
  const m1 = st.bracket.rounds[0][1];
  r = await api('/api/match/propose-decision', { matchId: m1.id, winnerSide: 'right' }, tokenCuba);
  assert(r.data.ok && !r.data.consensus, 'cuba vota right, sin consenso');
  r = await api('/api/match/propose-decision', { matchId: m1.id, winnerSide: 'left' }, tokenPr);
  assert(r.data.ok && !r.data.consensus, 'pr vota left, discrepancia');
  // Cancel decision
  r = await api('/api/match/cancel-decision', {}, tokenMaster);
  assert(r.data.ok, 'master cancela');
  st = (await getJson('/api/state')).state;
  assert(!st.pendingDecision, 'pendingDecision limpio');

  // 9) Reset show (preserva submissions)
  r = await api('/api/master/reset-show', {}, tokenMaster);
  assert(r.data.ok, 'reset show');
  st = (await getJson('/api/state')).state;
  assert(!st.showStarted, 'show no started');
  assert(st.countries.cuba.teamLocked, 'cuba sigue lockeada');
  assert(st.countries.cuba.counts.total === 8, 'cuba mantiene 8 submissions');

  // 10) Reset all
  r = await api('/api/master/reset-all', {}, tokenMaster);
  assert(r.data.ok, 'reset all');
  st = (await getJson('/api/state')).state;
  assert(st.countries.cuba.counts.total === 0, 'cuba 0 submissions');
  assert(!st.countries.cuba.teamLocked, 'cuba unlock');

  console.log('\n✓ TODOS LOS TESTS PASARON');
}

run()
  .catch(e => { console.error('FAIL:', e.message); process.exitCode = 1; })
  .finally(() => { if (serverProc) try { serverProc.kill(); } catch {} });
