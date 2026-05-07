/**
 * Smoke test E2E del flow completo (login -> contestants -> pairings ->
 * bracket -> preview -> votar -> decidir -> verificar avance).
 *
 * Corre el server, le pega via fetch, verifica respuestas, mata el server.
 * Util para detectar regresiones rapidas. NO se incluye en el deploy.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 3099;
const PIN = 'smoketest1234';
const BASE = `http://localhost:${PORT}`;

let serverProc;

function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, PORT: String(PORT), HOST_PIN: PIN },
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let booted = false;
    const onData = (buf) => {
      const s = buf.toString();
      if (!booted && s.includes('El Pajaro corriendo en')) {
        booted = true;
        resolve();
      }
    };
    serverProc.stdout.on('data', onData);
    serverProc.stderr.on('data', onData);
    setTimeout(() => { if (!booted) reject(new Error('server no arranco a tiempo')); }, 10000);
  });
}

async function api(p, body, token) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(body || {}), ...(token ? { token } : {}) }),
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function run() {
  console.log('→ booting server...');
  await startServer();
  console.log('  server up');

  // 1. Login con PIN malo
  let r = await api('/api/host/login', { pin: 'wrong' });
  assert(r.status === 401, '1.a bad PIN devuelve 401');
  // 2. Login con PIN bueno
  r = await api('/api/host/login', { pin: PIN });
  assert(r.data.ok && r.data.token, '1.b PIN bueno devuelve token');
  const token = r.data.token;

  // 3. Cargar 16 contestants del ejemplo
  const ex = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'contestants.example.json'), 'utf8'));
  r = await api('/api/host/contestants', { contestants: ex }, token);
  assert(r.data.ok, '2. guardar 16 contestants');
  assert(Object.keys(r.data.state.contestants).length === 16, '   16 contestants en state');

  // 4. Pairings cuba-N vs pr-N, 4 left + 4 right
  const pairings = [];
  for (let i = 1; i <= 8; i++) {
    pairings.push({ leftId: 'cuba-' + i, rightId: 'pr-' + i, wing: i <= 4 ? 'left' : 'right' });
  }
  r = await api('/api/host/pairings', { pairings }, token);
  assert(r.data.ok, '3. guardar 8 pairings');

  // 5. Construir bracket
  r = await api('/api/host/bracket/build', {}, token);
  assert(r.data.ok, '4.a bracket build ok');
  const bracket = r.data.state.bracket;
  assert(bracket.rounds.length === 4, '   4 rondas');
  assert(bracket.rounds[0].length === 8, '   8 octofinales');
  assert(bracket.rounds[1].length === 4, '   4 cuartos');
  assert(bracket.rounds[2].length === 2, '   2 semis');
  assert(bracket.rounds[3].length === 1, '   1 final');
  // Cada match round 0 tiene leftId + rightId
  assert(bracket.rounds[0].every(m => m.leftId && m.rightId), '   octofinales completos');
  // Padres de cada match
  assert(bracket.rounds[0].every(m => !!m.parentMatchId), '   octofinales tienen parent');
  assert(bracket.rounds[3][0].parentMatchId === null, '   final no tiene parent');

  const m0 = bracket.rounds[0][0];

  // 6. Preview match 0
  r = await api('/api/host/match/preview', { matchId: m0.id }, token);
  assert(r.data.ok, '5. match en preview');

  // 7. Abrir votacion (5s)
  r = await api('/api/host/match/voting/start', { durationMs: 5000 }, token);
  assert(r.data.ok, '6. voting abierta');

  // 8. Decidir ganador izq -> verificar avance al QF
  r = await api('/api/host/match/decide', { matchId: m0.id, winnerSide: 'left' }, token);
  assert(r.data.ok, '7.a decision OK');
  const updatedM0 = r.data.state.bracket.rounds[0][0];
  assert(updatedM0.status === 'done', '   m0 cerrado');
  assert(updatedM0.winnerId === m0.leftId, '   ganador = leftId');
  // El ganador debe estar en el QF padre, slot leftId (porque m0 es slot 0 = even)
  const qf0 = r.data.state.bracket.rounds[1][0];
  assert(qf0.leftId === m0.leftId, '   QF.leftId = m0.winnerId');

  // 9. Decidir m1 -> ese ganador debe entrar a qf0.rightId
  const m1 = r.data.state.bracket.rounds[0][1];
  await api('/api/host/match/preview', { matchId: m1.id }, token);
  r = await api('/api/host/match/decide', { matchId: m1.id, winnerSide: 'right' }, token);
  assert(r.data.ok, '7.b decision m1');
  const qf0After = r.data.state.bracket.rounds[1][0];
  assert(qf0After.rightId === m1.rightId, '   QF.rightId = m1.winnerId');

  // 10. Reset
  r = await api('/api/host/reset', {}, token);
  assert(r.data.ok, '8. reset');

  console.log('\n✓ TODOS LOS TESTS PASARON');
}

function assert(cond, label) {
  if (cond) console.log('  ✓', label);
  else { console.error('  ✗', label); throw new Error('FAIL: ' + label); }
}

run()
  .catch(e => { console.error('FAIL:', e.message); process.exitCode = 1; })
  .finally(() => {
    if (serverProc) {
      try { serverProc.kill(); } catch {}
    }
  });
