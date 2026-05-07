/**
 * El Pajaro — server principal.
 *
 * Estructura de rutas:
 *
 *   /                    Landing publico dinamico
 *   /enviar              Form publico de inscripcion (3 pasos mobile)
 *   /panel/cuba          Panel del streamer cubano (PIN -> role=cuba)
 *   /panel/pr            Panel del streamer puertorriqueno (PIN -> role=pr)
 *   /panel/master        Panel master (PIN -> role=master)
 *   /show                Overlay del show (OBS Browser Source)
 *
 *   /api/submit          POST publico de inscripcion (URL only, 1 por IP)
 *   /api/state           GET snapshot publico (para landing + show)
 *   /api/admin/login     POST { pin, role }
 *   /api/admin/validate  POST { token }
 *   /api/admin/logout    POST { token }
 *
 *   /api/admin/:country/list                  GET submissions del pais
 *   /api/admin/:country/approve               POST { id }
 *   /api/admin/:country/reject                POST { id }
 *   /api/admin/:country/elim/active           POST { id, durationMs }    (abre poll SI/NO en el chat)
 *   /api/admin/:country/elim/active/close     POST                       (cierra el poll sin decidir)
 *   /api/admin/:country/elim/decide           POST { id, decision }      ('passed'|'rejected')
 *   /api/admin/:country/elim/clear            POST { id }                (volver a indeciso)
 *   /api/admin/:country/lock                  POST { ids }               (8 IDs)
 *   /api/admin/:country/unlock                POST
 *   /api/admin/:country/submissions-toggle    POST { open }
 *
 *   /api/master/start-show       POST  (cuando ambos lockeados)
 *   /api/master/reset-show       POST  (preserva submissions, deshace bracket)
 *   /api/master/reset-all        POST  (purga todo)
 *
 *   /api/match/preview           POST { matchId }              (cualquier rol durante show)
 *   /api/match/play-clip         POST { side, action }         (cualquier rol)
 *   /api/match/voting/start      POST { durationMs }           (cualquier rol)
 *   /api/match/voting/end        POST                          (cualquier rol)
 *   /api/match/propose-decision  POST { matchId, winnerSide }  (solo cuba|pr — consenso 2-de-2)
 *   /api/match/cancel-decision   POST                          (cualquier rol)
 *
 *   /api/twitch/auth?from=cuba|pr      OAuth start
 *   /api/twitch/callback               OAuth callback
 *   /api/twitch/status                 GET estado de las dos conexiones
 */

try { require('dotenv').config(); } catch {}

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const stateMod   = require('./lib/state');
const wsBus      = require('./lib/ws-broadcast');
const hostAuth   = require('./lib/host-auth');
const bracketMod = require('./lib/bracket');
const voting     = require('./lib/voting');
const subs       = require('./lib/submissions');
const twitchOAuth = require('./lib/twitch-oauth');
const { createIrcClient } = require('./lib/twitch-irc');

const PORT = process.env.PORT || 3000;
const DEFAULT_VOTE_MS = parseInt(process.env.DEFAULT_VOTE_DURATION_MS || '60000', 10);
const BOT_NICK = process.env.TWITCH_BOT_NICK || 'elpajaro_bot';
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '128kb' }));
app.use((req, _res, next) => {
  if (req.url.startsWith('/api/')) console.log('[HTTP]', req.method, req.url);
  next();
});

/* ===== State boot ===== */
stateMod.loadFromDisk();
stateMod.setBroadcaster(wsBus.broadcast);

/* ===== Voting init ===== */
voting.init({
  broadcastFn: wsBus.broadcast,
  stateModule: stateMod,
  onTimeoutFn: (targetId, mode) => {
    if (mode === 'duel') {
      // Modo nuevo: auto-decide por mayoria del chat al expirar el timer.
      // (autoDecideByChat es function declaration → hoisted, accesible aca)
      const cur = stateMod.state.currentMatch;
      if (cur && cur.matchId === targetId && cur.phase === 'voting') {
        autoDecideByChat(targetId);
      }
    } else if (mode === 'binary') {
      // Eliminacion fase 1 — al expirar el poll, dejamos la card abierta
      // para que el admin del pais pulse PASA o NO PASA.
    }
  },
});

/* ===== IRC dual-channel ===== */
const ircCuba = createIrcClient({
  origin: 'cuba',
  botNick: BOT_NICK,
  onMessage: (user, msg, origin) => voting.handleChat(user, msg, origin),
  onStatus: ({ connected, login }) => stateMod.setTwitchConnection('cuba', { connected, login }),
});
const ircPr = createIrcClient({
  origin: 'pr',
  botNick: BOT_NICK,
  onMessage: (user, msg, origin) => voting.handleChat(user, msg, origin),
  onStatus: ({ connected, login }) => stateMod.setTwitchConnection('pr', { connected, login }),
});

/* ===== OAuth wiring ===== */
twitchOAuth.setOnConnected((side, info) => {
  stateMod.setTwitchConnection(side, {
    connected: true, name: info.name, login: info.broadcasterLogin,
  });
  const ircClient = side === 'cuba' ? ircCuba : ircPr;
  ircClient.connect(info.accessToken, info.broadcasterLogin);
});

/* ============================================================
 * RUTAS
 * ============================================================ */

/* ===== Twitch OAuth ===== */
app.get('/api/twitch/auth', twitchOAuth.authHandler);
app.get('/api/twitch/callback', twitchOAuth.callbackHandler);
app.get('/api/twitch/status', (_req, res) => {
  res.json({ ok: true, ...twitchOAuth.getStatus() });
});

/* ===== Public state (para landing y show — sin auth) ===== */
app.get('/api/state', (_req, res) => {
  res.json({ ok: true, state: stateMod.snapshot(), poll: voting.getActive() });
});

/* ===== Health / persistence check (sin auth, debug only) =====
 * Devuelve la ruta donde se persiste el state.json y si el archivo existe.
 * Util para verificar desde afuera si el disco persistente esta bien
 * montado (debe decir /var/data/state.json y exists:true tras el primer save).
 */
app.get('/api/health', (_req, res) => {
  const fs = require('fs');
  const path = require('path');
  const stateDir = process.env.STATE_DIR || path.join(__dirname, 'data');
  const statePath = path.join(stateDir, 'state.json');
  let exists = false, sizeBytes = 0;
  try {
    const stat = fs.statSync(statePath);
    exists = true;
    sizeBytes = stat.size;
  } catch {}
  const counts = stateMod.snapshot().countries;
  res.json({
    ok: true,
    persistence: {
      stateDir,
      statePath,
      stateFileExists: exists,
      stateFileSizeBytes: sizeBytes,
      stateDirEnvVarSet: !!process.env.STATE_DIR,
    },
    counts: {
      cuba: counts.cuba.counts.total,
      pr:   counts.pr.counts.total,
    },
    uptimeSec: Math.floor(process.uptime()),
  });
});

/* ===== Public submission ===== */
const submitRate = new Map();   // ip -> { count, resetAt }
function submitThrottle(ip) {
  const now = Date.now();
  const e = submitRate.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > e.resetAt) { e.count = 0; e.resetAt = now + 60_000; }
  e.count++;
  submitRate.set(ip, e);
  return e.count > 3;     // max 3 intentos por minuto por IP (ej. correcciones)
}

app.post('/api/submit', async (req, res) => {
  const ip = (req.ip || 'unknown').slice(0, 64);
  if (submitThrottle(ip)) {
    return res.status(429).json({ ok: false, error: 'Demasiados intentos. Espera un minuto.' });
  }
  // createSubmission ahora es async (hace fetch a noembed.com para conseguir
  // thumbnails de plataformas que no las exponen directo).
  try {
    const r = await subs.createSubmission({
      country: String(req.body?.country || ''),
      name: req.body?.name,
      instagram: req.body?.instagram,
      mediaUrl: req.body?.mediaUrl,
      ip,
    });
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
    res.json({ ok: true });
  } catch (e) {
    console.error('[SUBMIT] error:', e.message);
    res.status(500).json({ ok: false, error: 'Error interno.' });
  }
});

/* ===== Auth ===== */
const loginRate = new Map();
function loginThrottle(ip) {
  const now = Date.now();
  const e = loginRate.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > e.resetAt) { e.count = 0; e.resetAt = now + 60_000; }
  e.count++;
  loginRate.set(ip, e);
  return e.count > 6;
}

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (loginThrottle(ip)) {
    return res.status(429).json({ ok: false, error: 'Demasiados intentos. Espera un minuto.' });
  }
  const pin = String(req.body?.pin || '').trim();
  const role = String(req.body?.role || 'master');
  const r = hostAuth.login(pin, role);
  if (!r) return res.status(401).json({ ok: false, error: 'PIN incorrecto.' });
  res.json({ ok: true, token: r.token, role: r.role, state: stateMod.snapshot() });
});

app.post('/api/admin/validate', (req, res) => {
  const session = hostAuth.requireRole(req, res);
  if (!session) return;
  res.json({ ok: true, role: session.role, state: stateMod.snapshot() });
});

app.post('/api/admin/logout', (req, res) => {
  hostAuth.logout(String(req.body?.token || ''));
  res.json({ ok: true });
});

/* ===== Helper: country admin guard =====
 * cuba role accede solo a /api/admin/cuba/*. pr a /pr/*. master ve
 * todos via endpoints distintos (no usa estos).
 */
function requireCountryAdmin(req, res, country) {
  const session = hostAuth.requireRole(req, res, country);
  return session ? session : null;
}

/* ===== Per-country admin endpoints (cuba, pr) ===== */
function mountCountryRoutes(country) {
  const guard = (req, res) => requireCountryAdmin(req, res, country);

  // POST en vez de GET para que el token vaya en body (consistente con resto)
  app.post(`/api/admin/${country}/list`, (req, res) => {
    if (!guard(req, res)) return;
    const items = subs.listByCountry(country);
    res.json({ ok: true, items, counts: stateMod.countSubmissions(country) });
  });

  app.post(`/api/admin/${country}/approve`, (req, res) => {
    if (!guard(req, res)) return;
    const r = subs.approve(String(req.body?.id || ''));
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
    res.json({ ok: true });
  });

  app.post(`/api/admin/${country}/reject`, (req, res) => {
    if (!guard(req, res)) return;
    const r = subs.reject(String(req.body?.id || ''));
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
    res.json({ ok: true });
  });

  app.post(`/api/admin/${country}/elim/active`, (req, res) => {
    if (!guard(req, res)) return;
    const id = String(req.body?.id || '');
    const s = stateMod.getSubmission(id);
    if (!s || s.country !== country) {
      return res.status(400).json({ ok: false, error: 'Submission no encontrada o de otro pais.' });
    }
    if (s.status !== 'approved') {
      return res.status(400).json({ ok: false, error: 'Hay que aprobarla antes.' });
    }
    voting.endNow();
    stateMod.setActivePhase1Card(country, id);
    const durationMs = Math.min(300_000, Math.max(10_000, parseInt(req.body?.durationMs, 10) || DEFAULT_VOTE_MS));
    voting.start({ mode: 'binary', targetId: id, durationMs });
    res.json({ ok: true });
  });

  app.post(`/api/admin/${country}/elim/active/close`, (req, res) => {
    if (!guard(req, res)) return;
    voting.endNow();
    stateMod.setActivePhase1Card(null);
    res.json({ ok: true });
  });

  app.post(`/api/admin/${country}/elim/decide`, (req, res) => {
    if (!guard(req, res)) return;
    const id = String(req.body?.id || '');
    const decision = String(req.body?.decision || '');
    const s = stateMod.getSubmission(id);
    if (!s || s.country !== country) {
      return res.status(400).json({ ok: false, error: 'Submission invalida.' });
    }
    const r = subs.decideElimination(id, decision);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
    voting.endNow();
    if (stateMod.state.activePhase1Card?.cardId === id) {
      stateMod.setActivePhase1Card(null);
    }
    res.json({ ok: true });
  });

  app.post(`/api/admin/${country}/elim/clear`, (req, res) => {
    if (!guard(req, res)) return;
    const r = subs.clearElimination(String(req.body?.id || ''));
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
    res.json({ ok: true });
  });

  app.post(`/api/admin/${country}/lock`, (req, res) => {
    if (!guard(req, res)) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const r = subs.lockTeam(country, ids);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
    res.json({ ok: true });
  });

  app.post(`/api/admin/${country}/unlock`, (req, res) => {
    if (!guard(req, res)) return;
    if (stateMod.state.showStarted) {
      return res.status(400).json({ ok: false, error: 'No se puede desbloquear con el show ya empezado.' });
    }
    stateMod.unlockTeam(country);
    res.json({ ok: true });
  });

  app.post(`/api/admin/${country}/submissions-toggle`, (req, res) => {
    if (!guard(req, res)) return;
    stateMod.setSubmissionsOpen(country, !!req.body?.open);
    res.json({ ok: true });
  });

  /**
   * "ESTOY LISTO" — el streamer del pais marca su lado como listo para
   * arrancar el bracket. Requiere haber lockeado los 8.
   * Cuando ambos paises estan ready=true, el show arranca automaticamente
   * (sin boton "EMPEZAR" extra).
   */
  app.post(`/api/admin/${country}/ready`, (req, res) => {
    if (!guard(req, res)) return;
    const ready = !!req.body?.ready;
    const r = stateMod.setReady(country, ready);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });

    // Si ambos quedaron listos, auto-arranca el show
    if (r.bothReady && !stateMod.state.showStarted) {
      const cubaTeam = stateMod.state.countries.cuba.lockedTeam;
      const prTeam   = stateMod.state.countries.pr.lockedTeam;
      const built = bracketMod.buildFromTeams(cubaTeam, prTeam, { shuffle: true });
      if (built.ok) {
        const contestants = buildContestants([...cubaTeam, ...prTeam]);
        stateMod.startShow(contestants, built.pairings, built.bracket);
        return res.json({ ok: true, ready, bothReady: true, showStarted: true });
      }
    }
    res.json({ ok: true, ready, bothReady: r.bothReady });
  });
}

/**
 * Construye el dict de contestants a partir de submission IDs.
 * Incluye los formatos de embed (iframe / video / audio / link) listos
 * para que show.js los renderice sin tener que volver a parsear el URL.
 */
function buildContestants(ids) {
  const out = {};
  for (const id of ids) {
    const s = stateMod.getSubmission(id);
    if (!s) continue;
    const embed = subs.getEmbedInfo(s.mediaUrl) || { kind: 'link', embedUrl: s.mediaUrl, autoplayUrl: s.mediaUrl };
    out[id] = {
      id: s.id, name: s.name, country: s.country,
      photoUrl: '',
      bio: s.instagram ? '@' + s.instagram : '',
      clipUrl: s.mediaUrl,                      // original (para mostrar al lado)
      clipKind: embed.kind,                     // 'iframe' | 'video' | 'audio' | 'link'
      clipEmbed: embed.embedUrl,                // src cuando NO se reproduce
      clipEmbedAutoplay: embed.autoplayUrl,     // src cuando el host pulsa play
    };
  }
  return out;
}
mountCountryRoutes('cuba');
mountCountryRoutes('pr');

/* ===== Master endpoints ===== */
function requireMaster(req, res) {
  return hostAuth.requireRole(req, res, 'master');
}

app.post('/api/master/start-show', (req, res) => {
  if (!requireMaster(req, res)) return;
  const cuba = stateMod.state.countries.cuba;
  const pr   = stateMod.state.countries.pr;
  if (!cuba.teamLocked || cuba.lockedTeam.length !== 8) {
    return res.status(400).json({ ok: false, error: 'Cuba no cerro su equipo de 8.' });
  }
  if (!pr.teamLocked || pr.lockedTeam.length !== 8) {
    return res.status(400).json({ ok: false, error: 'Puerto Rico no cerro su equipo de 8.' });
  }
  const shuffle = !!req.body?.shuffle;
  const built = bracketMod.buildFromTeams(cuba.lockedTeam, pr.lockedTeam, { shuffle });
  if (!built.ok) return res.status(400).json({ ok: false, error: built.error });

  // Usar buildContestants (el mismo helper del flujo auto) para que el manual
  // tambien tenga clipKind/clipEmbed/clipEmbedAutoplay — sino el panel-master
  // no puede embedar los videos en el active match box.
  const contestants = buildContestants([...cuba.lockedTeam, ...pr.lockedTeam]);
  stateMod.startShow(contestants, built.pairings, built.bracket);
  res.json({ ok: true });
});

app.post('/api/master/reset-show', (req, res) => {
  if (!requireMaster(req, res)) return;
  voting.endNow();
  stateMod.resetShowOnly();
  res.json({ ok: true });
});

app.post('/api/master/reset-all', (req, res) => {
  if (!requireMaster(req, res)) return;
  voting.endNow();
  stateMod.resetEverything();
  res.json({ ok: true });
});

/* ===== Match flow (cualquier rol durante el show) ===== */
function requireAnyAdmin(req, res) {
  return hostAuth.requireRole(req, res, null);
}

app.post('/api/match/preview', (req, res) => {
  if (!requireAnyAdmin(req, res)) return;
  const matchId = String(req.body?.matchId || '');
  const m = stateMod.findMatch(matchId);
  if (!m) return res.status(400).json({ ok: false, error: 'Match no encontrado.' });
  if (m.status === 'done') return res.status(400).json({ ok: false, error: 'Match ya cerrado.' });
  if (!m.leftId || !m.rightId) {
    return res.status(400).json({ ok: false, error: 'El match no tiene ambos contestantes.' });
  }
  voting.endNow();
  stateMod.setCurrentMatch(matchId, 'preview');
  res.json({ ok: true });
});

app.post('/api/match/play-clip', (req, res) => {
  if (!requireAnyAdmin(req, res)) return;
  const side = req.body?.side === 'right' ? 'right' : 'left';
  const action = req.body?.action === 'pause' ? 'pause' : 'play';
  wsBus.broadcast({ type: 'clip-control', side, action, ts: Date.now() });
  res.json({ ok: true });
});

app.post('/api/match/voting/start', (req, res) => {
  if (!requireAnyAdmin(req, res)) return;
  const cur = stateMod.state.currentMatch;
  if (!cur) return res.status(400).json({ ok: false, error: 'No hay match en preview.' });
  const durationMs = Math.min(300_000, Math.max(10_000, parseInt(req.body?.durationMs, 10) || DEFAULT_VOTE_MS));
  stateMod.setCurrentMatch(cur.matchId, 'voting', durationMs);
  voting.start({ mode: 'duel', targetId: cur.matchId, durationMs });
  res.json({ ok: true });
});

app.post('/api/match/voting/end', (req, res) => {
  if (!requireAnyAdmin(req, res)) return;
  voting.endNow();
  const cur = stateMod.state.currentMatch;
  if (cur) stateMod.setCurrentMatch(cur.matchId, 'result');
  res.json({ ok: true });
});

/**
 * Consenso 2-de-2: cuba y pr cada uno propone un winnerSide. Cuando los
 * dos coinciden, ejecutamos decideMatch.
 */
app.post('/api/match/propose-decision', (req, res) => {
  const session = hostAuth.requireRole(req, res, null);
  if (!session) return;
  if (session.role !== 'cuba' && session.role !== 'pr') {
    return res.status(403).json({ ok: false, error: 'Solo cuba y pr pueden votar la decision.' });
  }
  const matchId = String(req.body?.matchId || '');
  const winnerSide = req.body?.winnerSide === 'right' ? 'right' : 'left';
  const m = stateMod.findMatch(matchId);
  if (!m) return res.status(400).json({ ok: false, error: 'Match no encontrado.' });
  if (m.status === 'done') return res.status(400).json({ ok: false, error: 'Match ya cerrado.' });

  const r = stateMod.proposeDecision(matchId, session.role, winnerSide);
  if (!r) return res.status(400).json({ ok: false, error: 'No se pudo registrar el voto.' });

  if (r.consensus) {
    // Ejecutar la decision
    const out = bracketMod.decideMatch(stateMod.state.bracket, matchId, r.winnerSide);
    if (!out.ok) {
      stateMod.clearPendingDecision();
      return res.status(400).json({ ok: false, error: out.error });
    }
    voting.endNow();
    stateMod.recordHistory({
      matchId, winnerId: out.match.winnerId, decidedAt: out.match.decidedAt,
    });
    stateMod.setCurrentMatch(null);
    stateMod.clearPendingDecision();
    return res.json({ ok: true, consensus: true, winnerId: out.match.winnerId });
  }
  res.json({ ok: true, consensus: false, votes: r.votes });
});

app.post('/api/match/cancel-decision', (req, res) => {
  if (!requireAnyAdmin(req, res)) return;
  stateMod.clearPendingDecision();
  res.json({ ok: true });
});

/* ============================================================
 * NUEVO FLOW: confirmacion de fase + auto-decide por chat majority
 * ============================================================
 *
 * POST /api/match/confirm { matchId, phase }
 *   - Auth: cuba o pr
 *   - Registra que ese rol esta listo para avanzar de la fase actual.
 *   - Cuando AMBOS estan listos, avanza:
 *       idle    + 2 ready → preview (video reproduce)
 *       preview + 2 ready → voting (chat puede votar)
 *       voting  + 2 ready (o timeout) → result (decide por mayoria del chat)
 */
app.post('/api/match/confirm', (req, res) => {
  const session = hostAuth.requireRole(req, res, null);
  if (!session) return;
  if (session.role !== 'cuba' && session.role !== 'pr') {
    return res.status(403).json({ ok: false, error: 'Solo cuba y pr confirman.' });
  }
  const matchId = String(req.body?.matchId || '');
  const phase = String(req.body?.phase || 'idle');
  if (!['idle', 'preview', 'voting'].includes(phase)) {
    return res.status(400).json({ ok: false, error: 'Fase invalida.' });
  }
  const m = stateMod.findMatch(matchId);
  if (!m) return res.status(400).json({ ok: false, error: 'Match no encontrado.' });
  if (m.status === 'done') return res.status(400).json({ ok: false, error: 'Match ya cerrado.' });
  if (!m.leftId || !m.rightId) {
    return res.status(400).json({ ok: false, error: 'El match no tiene ambos contestantes.' });
  }

  const r = stateMod.setMatchConfirmation(matchId, phase, session.role);
  if (!r) return res.status(400).json({ ok: false, error: 'No se pudo registrar.' });

  if (r.bothReady) {
    // Avanzar de fase. Solo 2 transiciones (sin fase 'preview' intermedia):
    //   idle   → voting  (chat empieza a votar)
    //   voting → result  (cierra y decide por mayoria del chat)
    // Los streamers ya estan reproduciendo los videos localmente en sus
    // master panels (cada uno cuando quiere) — no se sincroniza el play.
    if (phase === 'idle') {
      stateMod.setCurrentMatch(matchId, 'voting', DEFAULT_VOTE_MS);
      voting.start({ mode: 'duel', targetId: matchId, durationMs: DEFAULT_VOTE_MS });
      stateMod.clearMatchConfirmations();
    } else if (phase === 'voting') {
      autoDecideByChat(matchId);
      stateMod.clearMatchConfirmations();
    }
  }
  res.json({ ok: true, ...r });
});

/**
 * Cierra la votacion del match y elige al ganador por mayoria del chat.
 * En empate, gana left (arbitrario, marcado en logs).
 */
function autoDecideByChat(matchId) {
  const poll = voting.getActive() || {};
  const totals = poll.totals || { leftTotal: 0, rightTotal: 0 };
  voting.endNow();
  let winnerSide = 'left';
  if (totals.rightTotal > totals.leftTotal) winnerSide = 'right';
  if (totals.leftTotal === totals.rightTotal) {
    console.log('[MATCH]', matchId, 'tie', totals, '→ left wins by default');
  }
  const out = bracketMod.decideMatch(stateMod.state.bracket, matchId, winnerSide);
  if (!out.ok) {
    console.error('[MATCH] decideMatch failed:', out.error);
    return;
  }
  stateMod.recordHistory({
    matchId, winnerId: out.match.winnerId, decidedAt: out.match.decidedAt,
    autoDecidedByChat: true, votes: totals,
  });
  stateMod.setCurrentMatch(null);
}

/* ===== Compatibilidad: /host -> /panel/master ===== */
app.get('/host', (_req, res) => res.redirect(301, '/panel/master'));

/* ===== Static + page routes =====
 * No-store en /show para que OBS Browser Source no cachee deploys viejos.
 */
function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
}

app.get('/', noStore, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'landing.html')));
app.get('/enviar', noStore, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'enviar.html')));
app.get('/panel/cuba', noStore, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'panel-country.html')));
app.get('/panel/pr', noStore, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'panel-country.html')));
app.get('/panel/master', noStore, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'panel-master.html')));
// Versiones role-locked del master: /panel/master/cuba acepta solo PIN_CUBA
// y solo permite tocar el ESTOY LISTO de Cuba. Idem /panel/master/pr con PR.
// El JS detecta el path y enforza el rol.
app.get('/panel/master/cuba', noStore, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'panel-master.html')));
app.get('/panel/master/pr',   noStore, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'panel-master.html')));
app.get('/show', noStore, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'show.html')));

app.use(express.static(PUBLIC_DIR));
app.use('/data', express.static(path.join(__dirname, 'data')));

/* ===== WebSocket ===== */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  wsBus.add(ws);
  try {
    ws.send(JSON.stringify({ type: 'state', state: stateMod.snapshot() }));
    const poll = voting.getActive();
    if (poll) ws.send(JSON.stringify({ type: 'voting-update', poll }));
  } catch {}

  ws.on('close', () => { wsBus.remove(ws); });
});

const keepAlive = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 20_000);
wss.on('close', () => clearInterval(keepAlive));

/* ===== Boot ===== */
server.listen(PORT, () => {
  console.log(`\n┌────────────────────────────────────────────┐`);
  console.log(`│  El Pajaro corriendo en :${PORT}              │`);
  console.log(`│  /                landing                  │`);
  console.log(`│  /enviar          form publico             │`);
  console.log(`│  /panel/cuba      streamer cubano (PIN)    │`);
  console.log(`│  /panel/pr        streamer PR (PIN)        │`);
  console.log(`│  /panel/master    master (PIN)             │`);
  console.log(`│  /show            overlay OBS              │`);
  console.log(`└────────────────────────────────────────────┘\n`);
  if (!process.env.HOST_PIN) console.warn('[BOOT] HOST_PIN no esta seteado.');
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
    console.warn('[BOOT] Faltan TWITCH_CLIENT_ID/SECRET.');
  }
});
