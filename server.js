/**
 * El Pajaro — server principal.
 *
 * Levanta:
 *  - Express con rutas estaticas + API del host + OAuth Twitch
 *  - WebSocket pub/sub (overlay del show + panel del host suscriben aca)
 *  - Dos clientes IRC de Twitch (un canal cubano + un canal PR)
 *
 * Uso local:
 *   1. cp .env.example .env  ;  llenar TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, HOST_PIN
 *   2. npm install
 *   3. npm start
 *   4. abrir http://localhost:3000/host  (login con HOST_PIN)
 *   5. desde ahi conectar Twitch Cuba + Twitch PR
 *   6. abrir http://localhost:3000/show en otra pestana / Browser Source de OBS
 */

try { require('dotenv').config(); } catch {}

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const stateMod   = require('./lib/state');
const wsBus      = require('./lib/ws-broadcast');
const hostAuth   = require('./lib/host-auth');
const bracketMod = require('./lib/bracket');
const voting     = require('./lib/voting');
const twitchOAuth = require('./lib/twitch-oauth');
const { createIrcClient } = require('./lib/twitch-irc');

const PORT = process.env.PORT || 3000;
const DEFAULT_VOTE_MS = parseInt(process.env.DEFAULT_VOTE_DURATION_MS || '60000', 10);
const BOT_NICK = process.env.TWITCH_BOT_NICK || 'elpajaro_bot';
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, _res, next) => {
  if (req.url.startsWith('/api/')) console.log('[HTTP]', req.method, req.url);
  next();
});

/* ===== State boot ===== */
stateMod.loadFromDisk();
stateMod.setBroadcaster(wsBus.broadcast);

/* ===== Voting init — necesita el broadcaster + ref al state + onTimeout ===== */
voting.init({
  broadcastFn: wsBus.broadcast,
  stateModule: stateMod,
  onTimeoutFn: (matchId) => {
    // Cuando se vence el timer, cambiamos la fase a 'result' pero NO
    // cantamos ganador automatico — el host decide en base a las barras.
    // (Si quisieramos auto-decidir por mayoria, se podria hacer aca.)
    const cur = stateMod.state.currentMatch;
    if (cur && cur.matchId === matchId && cur.phase === 'voting') {
      stateMod.setCurrentMatch(matchId, 'result');
    }
  },
});

/* ===== IRC dual-channel ===== */
const ircCuba = createIrcClient({
  origin: 'cuba',
  botNick: BOT_NICK,
  onMessage: (user, msg, origin) => voting.handleChat(user, msg, origin),
  onStatus: ({ connected, login }) => {
    stateMod.setTwitchConnection('cuba', { connected, login });
  },
});
const ircPr = createIrcClient({
  origin: 'pr',
  botNick: BOT_NICK,
  onMessage: (user, msg, origin) => voting.handleChat(user, msg, origin),
  onStatus: ({ connected, login }) => {
    stateMod.setTwitchConnection('pr', { connected, login });
  },
});

/* ===== OAuth callback wiring ===== */
twitchOAuth.setOnConnected((side, info) => {
  stateMod.setTwitchConnection(side, {
    connected: true,
    name: info.name,
    login: info.broadcasterLogin,
  });
  const ircClient = side === 'cuba' ? ircCuba : ircPr;
  ircClient.connect(info.accessToken, info.broadcasterLogin);
});

/* ===== Twitch OAuth routes ===== */
app.get('/api/twitch/auth', twitchOAuth.authHandler);
app.get('/api/twitch/callback', twitchOAuth.callbackHandler);
app.get('/api/twitch/status', (_req, res) => {
  res.json({ ok: true, ...twitchOAuth.getStatus() });
});

/* ===== Host auth ===== */
const loginRate = new Map();
function loginRateLimited(ip) {
  const now = Date.now();
  const e = loginRate.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > e.resetAt) { e.count = 0; e.resetAt = now + 60_000; }
  e.count++;
  loginRate.set(ip, e);
  return e.count > 6;
}

app.post('/api/host/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (loginRateLimited(ip)) {
    return res.status(429).json({ ok: false, error: 'Demasiados intentos. Espera un minuto.' });
  }
  const pin = String(req.body?.pin || '').trim();
  const token = hostAuth.login(pin);
  if (!token) return res.status(401).json({ ok: false, error: 'PIN incorrecto.' });
  res.json({ ok: true, token, state: stateMod.snapshot() });
});

app.post('/api/host/validate', (req, res) => {
  if (!hostAuth.requireHost(req, res)) return;
  res.json({ ok: true, state: stateMod.snapshot() });
});

app.post('/api/host/logout', (req, res) => {
  hostAuth.logout(String(req.body?.token || ''));
  res.json({ ok: true });
});

/* ===== Contestants + pairings ===== */
function sanitizeContestant(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '');
  const country = raw.country === 'pr' ? 'pr' : raw.country === 'cuba' ? 'cuba' : null;
  if (!id || !country) return null;
  return {
    id,
    name: String(raw.name || '').slice(0, 80),
    country,
    photoUrl: String(raw.photoUrl || '').slice(0, 500),
    bio: String(raw.bio || '').slice(0, 300),
    clipUrl: String(raw.clipUrl || '').slice(0, 500),
    clipType: raw.clipType === 'video' ? 'video' : 'audio',
  };
}

app.post('/api/host/contestants', (req, res) => {
  if (!hostAuth.requireHost(req, res)) return;
  const arr = Array.isArray(req.body?.contestants) ? req.body.contestants : null;
  if (!arr) return res.status(400).json({ ok: false, error: 'Falta contestants[]' });
  const cleaned = arr.map(sanitizeContestant).filter(Boolean);
  if (cleaned.length !== 16) {
    return res.status(400).json({ ok: false, error: `Se esperan 16 contestants, llegaron ${cleaned.length}.` });
  }
  // 8 cubanos + 8 PR — invariante del show.
  const cubanos = cleaned.filter(c => c.country === 'cuba').length;
  if (cubanos !== 8) {
    return res.status(400).json({ ok: false, error: `Se esperan 8 cubanos y 8 puertorriqueños, llegaron ${cubanos} cubanos.` });
  }
  stateMod.setContestants(cleaned);
  res.json({ ok: true, state: stateMod.snapshot() });
});

app.post('/api/host/pairings', (req, res) => {
  if (!hostAuth.requireHost(req, res)) return;
  const arr = Array.isArray(req.body?.pairings) ? req.body.pairings : null;
  if (!arr || arr.length !== 8) {
    return res.status(400).json({ ok: false, error: 'Se esperan 8 emparejamientos.' });
  }
  // Validar que cada par sea Cuba vs PR
  const cs = stateMod.state.contestants;
  for (let i = 0; i < 8; i++) {
    const p = arr[i];
    if (!p || !p.leftId || !p.rightId) return res.status(400).json({ ok: false, error: `Par ${i+1} incompleto.` });
    const a = cs[p.leftId], b = cs[p.rightId];
    if (!a || !b) return res.status(400).json({ ok: false, error: `Par ${i+1}: contestant invalido.` });
    if (a.country === b.country) return res.status(400).json({ ok: false, error: `Par ${i+1}: octofinal debe ser Cuba vs PR.` });
  }
  stateMod.setPairings(arr);
  res.json({ ok: true, state: stateMod.snapshot() });
});

/* ===== Bracket ===== */
app.post('/api/host/bracket/build', (req, res) => {
  if (!hostAuth.requireHost(req, res)) return;
  if (!stateMod.state.pairings || stateMod.state.pairings.length !== 8) {
    return res.status(400).json({ ok: false, error: 'Falta configurar las 8 emparejamientos.' });
  }
  const bracket = bracketMod.buildEmptyBracket();
  const r = bracketMod.applyPairings(bracket, stateMod.state.pairings);
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  stateMod.setBracket(bracket);
  res.json({ ok: true, state: stateMod.snapshot() });
});

app.post('/api/host/reset', (req, res) => {
  if (!hostAuth.requireHost(req, res)) return;
  voting.endNow();
  stateMod.reset();
  res.json({ ok: true });
});

/* ===== Match flow ===== */
app.post('/api/host/match/preview', (req, res) => {
  if (!hostAuth.requireHost(req, res)) return;
  const matchId = String(req.body?.matchId || '');
  const m = stateMod.findMatch(matchId);
  if (!m) return res.status(400).json({ ok: false, error: 'Match no encontrado.' });
  if (m.status === 'done') return res.status(400).json({ ok: false, error: 'Match ya cerrado.' });
  if (!m.leftId || !m.rightId) {
    return res.status(400).json({ ok: false, error: 'El match no tiene ambos contestantes (la ronda anterior no termino).' });
  }
  voting.endNow();   // si habia votacion abierta, cerrarla
  stateMod.setCurrentMatch(matchId, 'preview');
  res.json({ ok: true });
});

app.post('/api/host/match/play-clip', (req, res) => {
  if (!hostAuth.requireHost(req, res)) return;
  const side = req.body?.side === 'right' ? 'right' : 'left';
  const action = req.body?.action === 'pause' ? 'pause' : 'play';
  // No tocamos state — solo emitimos un evento que el overlay traduce a play/pause del clip.
  wsBus.broadcast({ type: 'clip-control', side, action, ts: Date.now() });
  res.json({ ok: true });
});

app.post('/api/host/match/voting/start', (req, res) => {
  if (!hostAuth.requireHost(req, res)) return;
  const cur = stateMod.state.currentMatch;
  if (!cur) return res.status(400).json({ ok: false, error: 'No hay match en preview.' });
  const durationMs = Math.min(300_000, Math.max(10_000, parseInt(req.body?.durationMs, 10) || DEFAULT_VOTE_MS));
  stateMod.setCurrentMatch(cur.matchId, 'voting', durationMs);
  voting.start(cur.matchId, durationMs);
  res.json({ ok: true });
});

app.post('/api/host/match/voting/end', (req, res) => {
  if (!hostAuth.requireHost(req, res)) return;
  voting.endNow();
  const cur = stateMod.state.currentMatch;
  if (cur) stateMod.setCurrentMatch(cur.matchId, 'result');
  res.json({ ok: true });
});

app.post('/api/host/match/decide', (req, res) => {
  if (!hostAuth.requireHost(req, res)) return;
  const matchId = String(req.body?.matchId || '');
  const winnerSide = req.body?.winnerSide === 'right' ? 'right' : 'left';
  if (!stateMod.state.bracket) {
    return res.status(400).json({ ok: false, error: 'No hay bracket.' });
  }
  const r = bracketMod.decideMatch(stateMod.state.bracket, matchId, winnerSide);
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  voting.endNow();
  // Snapshot del resultado para el log historico
  const pollSnapshot = voting.getActive();
  stateMod.recordHistory({
    matchId, winnerId: r.match.winnerId, decidedAt: r.match.decidedAt, poll: pollSnapshot,
  });
  // Limpiamos currentMatch — el host abrira el siguiente cuando quiera
  stateMod.setCurrentMatch(null);
  res.json({ ok: true, state: stateMod.snapshot() });
});

/* ===== Uploads (foto + clip) ===== */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const kind = file.fieldname === 'photo' ? 'contestants' : 'clips';
      cb(null, path.join(PUBLIC_DIR, 'uploads', kind));
    },
    filename: (req, file, cb) => {
      const safe = String(req.body.id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
      const ext = path.extname(file.originalname).toLowerCase().slice(0, 6);
      cb(null, `${safe}_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },  // 50MB max por archivo (clip de video)
});

app.post('/api/host/upload', upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'clip', maxCount: 1 },
]), (req, res) => {
  if (!hostAuth.validate(String(req.body?.token || ''))) {
    return res.status(401).json({ ok: false, error: 'host-auth-required' });
  }
  const out = {};
  if (req.files?.photo?.[0]) {
    out.photoUrl = `/uploads/contestants/${req.files.photo[0].filename}`;
  }
  if (req.files?.clip?.[0]) {
    const fn = req.files.clip[0];
    out.clipUrl = `/uploads/clips/${fn.filename}`;
    out.clipType = /\.(mp4|webm|mov|mkv)$/i.test(fn.originalname) ? 'video' : 'audio';
  }
  res.json({ ok: true, ...out });
});

/* ===== Static + page routes =====
 * OBS Browser Source cachea HTML agresivamente. Forzamos no-store en /show
 * para que un deploy nuevo se vea sin tener que refrescar la fuente.
 */
function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
}

app.get('/', (_req, res) => res.redirect('/show'));
app.get('/show', noStore, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'show.html')));
app.get('/host', noStore, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'host.html')));

app.use(express.static(PUBLIC_DIR));
// Servir el JSON de ejemplo (si esta) — el panel del host lo fetchea via /data/...
app.use('/data', express.static(path.join(__dirname, 'data')));

/* ===== WebSocket ===== */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Cada cliente entra suscrito por defecto. Es mas simple que pedirles
  // mandar { type: 'subscribe' } primero — el overlay y el host ambos
  // necesitan recibir todo.
  wsBus.add(ws);

  // Snapshot inicial
  try {
    ws.send(JSON.stringify({ type: 'state', state: stateMod.snapshot() }));
    const poll = voting.getActive();
    if (poll) ws.send(JSON.stringify({ type: 'voting-update', poll }));
  } catch {}

  ws.on('close', () => { wsBus.remove(ws); });
});

// Keep-alive: pings cada 20s, dropea sockets que no respondan.
const keepAlive = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 20_000);
wss.on('close', () => clearInterval(keepAlive));

/* ===== Boot ===== */
server.listen(PORT, () => {
  console.log(`\n┌────────────────────────────────────────────┐`);
  console.log(`│  El Pajaro corriendo en :${PORT}              │`);
  console.log(`│  Show:  http://localhost:${PORT}/show          │`);
  console.log(`│  Host:  http://localhost:${PORT}/host          │`);
  console.log(`└────────────────────────────────────────────┘\n`);
  if (!process.env.HOST_PIN) {
    console.warn('[BOOT] HOST_PIN no esta seteado — nadie podra entrar al panel del host.');
  }
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
    console.warn('[BOOT] Faltan TWITCH_CLIENT_ID/SECRET — la conexion a Twitch no va a funcionar.');
  }
});
