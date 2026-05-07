/**
 * Smoke test E2E del flow nuevo:
 *   - 2 PINs separados (PIN_CUBA, PIN_PR), master con cualquiera
 *   - submission publica
 *   - aprobar + lockear 8 (modo manual)
 *   - "ESTOY LISTO" por pais → cuando ambos listos, show auto-arranca
 *   - propose-decision con consenso
 *   - reset
 */

const { spawn } = require('child_process');

const PORT = 3099;
const PIN_CUBA = 'cubatest';
const PIN_PR   = 'prtest';
const BASE = `http://localhost:${PORT}`;

let serverProc;

function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, PORT: String(PORT), PIN_CUBA, PIN_PR, NODE_ENV: 'test' },
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

  // === Login con PINs separados ===
  let r = await api('/api/admin/login', { pin: 'wrong', role: 'cuba' });
  assert(r.status === 401, 'PIN cuba malo → 401');
  r = await api('/api/admin/login', { pin: PIN_PR, role: 'cuba' });
  assert(r.status === 401, 'PIN de PR no entra como cuba → 401');
  r = await api('/api/admin/login', { pin: PIN_CUBA, role: 'cuba' });
  assert(r.data.ok && r.data.role === 'cuba', 'login cuba con PIN_CUBA');
  const tokenCuba = r.data.token;

  r = await api('/api/admin/login', { pin: PIN_PR, role: 'pr' });
  assert(r.data.ok && r.data.role === 'pr', 'login pr con PIN_PR');
  const tokenPr = r.data.token;

  // Master entra con cualquiera de los dos pines
  r = await api('/api/admin/login', { pin: PIN_CUBA, role: 'master' });
  assert(r.data.ok && r.data.role === 'master', 'master acepta PIN_CUBA');
  const tokenMaster = r.data.token;
  r = await api('/api/admin/login', { pin: PIN_PR, role: 'master' });
  assert(r.data.ok && r.data.role === 'master', 'master acepta PIN_PR');

  // Reset all
  await api('/api/master/reset-all', {}, tokenMaster);

  // === Submissions publicas ===
  for (let i = 0; i < 8; i++) {
    const res = await fetch(BASE + '/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `1.1.1.${i + 10}` },
      body: JSON.stringify({ country: 'cuba', name: `Cubano ${i+1}`, instagram: `c${i+1}`, mediaUrl: `https://youtube.com/watch?v=cu${i}` }),
    });
    if (!(await res.json()).ok) throw new Error('cuba submit ' + i);
  }
  for (let i = 0; i < 8; i++) {
    const res = await fetch(BASE + '/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `2.2.2.${i + 10}` },
      body: JSON.stringify({ country: 'pr', name: `Boricua ${i+1}`, instagram: `p${i+1}`, mediaUrl: `https://youtube.com/watch?v=pr${i}` }),
    });
    if (!(await res.json()).ok) throw new Error('pr submit ' + i);
  }
  let st = (await getJson('/api/state')).state;
  assert(st.countries.cuba.counts.total === 8, 'cuba 8 submissions');
  assert(st.countries.pr.counts.total === 8, 'pr 8 submissions');

  // === Aprobar todas ===
  const cubaList = await api('/api/admin/cuba/list', {}, tokenCuba);
  for (const s of cubaList.data.items) await api('/api/admin/cuba/approve', { id: s.id }, tokenCuba);
  const prList = await api('/api/admin/pr/list', {}, tokenPr);
  for (const s of prList.data.items) await api('/api/admin/pr/approve', { id: s.id }, tokenPr);

  // Cuba intenta tocar PR — 403
  r = await api('/api/admin/pr/approve', { id: prList.data.items[0].id }, tokenCuba);
  assert(r.status === 403, 'cuba no puede tocar PR');

  // === Lock teams (modo manual) ===
  const cubaIds = cubaList.data.items.map(s => s.id);
  r = await api('/api/admin/cuba/lock', { ids: cubaIds }, tokenCuba);
  assert(r.data.ok, 'cuba lock 8');
  const prIds = prList.data.items.map(s => s.id);
  r = await api('/api/admin/pr/lock', { ids: prIds }, tokenPr);
  assert(r.data.ok, 'pr lock 8');

  // === ESTOY LISTO ===
  // Cuba pone listo (pero no PR todavia) → show no arranca
  r = await api('/api/admin/cuba/ready', { ready: true }, tokenCuba);
  assert(r.data.ok && r.data.ready === true && !r.data.showStarted, 'cuba listo, show no arranca solo');
  st = (await getJson('/api/state')).state;
  assert(st.countries.cuba.ready === true, 'cuba.ready=true en state');
  assert(st.countries.pr.ready === false, 'pr.ready aun false');
  assert(!st.showStarted, 'show NO empezo todavia');

  // PR pone listo → show arranca SOLO
  r = await api('/api/admin/pr/ready', { ready: true }, tokenPr);
  assert(r.data.ok && r.data.showStarted, 'pr listo + show auto-arranca');
  st = (await getJson('/api/state')).state;
  assert(st.showStarted, 'show empezado');
  assert(st.bracket && st.bracket.rounds.length === 4, '4 rondas');
  assert(Object.keys(st.contestants).length === 16, '16 contestants');

  // === Cuba intenta tocar /api/admin/cuba/ready desde token PR — 403 ===
  r = await api('/api/admin/cuba/ready', { ready: false }, tokenPr);
  assert(r.status === 403, 'pr no puede tocar /cuba/ready');

  // === Consenso 2-de-2 sigue funcionando ===
  const m0 = st.bracket.rounds[0][0];
  await api('/api/match/preview', { matchId: m0.id }, tokenMaster);
  await api('/api/match/voting/start', { durationMs: 5000 }, tokenMaster);
  r = await api('/api/match/propose-decision', { matchId: m0.id, winnerSide: 'left' }, tokenCuba);
  assert(!r.data.consensus, 'cuba vota, sin consenso');
  r = await api('/api/match/propose-decision', { matchId: m0.id, winnerSide: 'left' }, tokenPr);
  assert(r.data.consensus, 'pr coincide → consenso');

  st = (await getJson('/api/state')).state;
  assert(st.bracket.rounds[0][0].status === 'done', 'm0 cerrado');

  // === Reset all ===
  r = await api('/api/master/reset-all', {}, tokenMaster);
  st = (await getJson('/api/state')).state;
  assert(st.countries.cuba.counts.total === 0 && !st.showStarted, 'reset all OK');

  console.log('\n✓ TODOS LOS TESTS PASARON');
}

run()
  .catch(e => { console.error('FAIL:', e.message); process.exitCode = 1; })
  .finally(() => { if (serverProc) try { serverProc.kill(); } catch {} });
