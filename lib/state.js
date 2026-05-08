/**
 * Estado central en memoria del show.
 *
 * Modelo de datos:
 *
 *   submissions: array de inscripciones publicas (cualquiera puede mandar via /enviar)
 *     { id, country, name, instagram, mediaUrl, mediaType: 'audio'|'video',
 *       ip, status: 'pending'|'approved'|'rejected', submittedAt,
 *       eliminationDecision: 'passed'|'rejected'|null,
 *       eliminationDecidedAt }
 *
 *   countries[cuba|pr]:
 *     { submissionsOpen: bool,    // si /enviar acepta de este pais
 *       teamLocked: bool,         // si los 8 finalistas estan bloqueados
 *       lockedAt: timestamp|null,
 *       lockedTeam: array de 8 submission IDs }
 *
 *   activePhase1Card: { country, cardId } | null
 *     — la card que el admin tiene abierta ahora con el chat votando si/no
 *
 *   showStarted: bool — cuando el master toca "EMPEZAR" tras ambos lockeados
 *
 *   contestants / bracket / currentMatch — igual que antes, populados cuando
 *     showStarted=true a partir de los lockedTeam de cada pais.
 *
 *   pendingDecision: consenso 2-de-2 durante el bracket
 *     { matchId, votes: { cuba: 'left'|'right'|null, pr: ... } }
 *
 * Persistencia: data/state.json local. Tokens OAuth NO se persisten.
 */

const fs = require('fs');
const path = require('path');

// STATE_DIR es donde se persiste el state.json. En produccion (Render con
// disco persistente) se setea a /var/data via env var. En local, fallback
// a la carpeta data/ del repo.
const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, '..', 'data');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const SUBMISSIONS_CAP = 50;
console.log('[STATE] persisting to:', STATE_PATH);

const state = {
  submissions: [],
  countries: {
    cuba: { submissionsOpen: true, teamLocked: false, lockedAt: null, lockedTeam: [], ready: false, readyAt: null },
    pr:   { submissionsOpen: true, teamLocked: false, lockedAt: null, lockedTeam: [], ready: false, readyAt: null },
  },
  activePhase1Card: null,
  showStarted: false,

  // Datos del bracket (poblados al EMPEZAR)
  contestants: {},
  pairings: [],
  bracket: null,
  currentMatch: null,
  history: [],

  pendingDecision: null,
  matchConfirmations: null,

  twitchConnections: {
    cuba: { connected: false, name: null, login: null },
    pr:   { connected: false, name: null, login: null },
  },
};

let _persistTimer = null;
let _broadcastFn = null;

function setBroadcaster(fn) { _broadcastFn = fn; }

function broadcast(extra = {}) {
  schedulePersist();
  if (!_broadcastFn) return;
  try {
    _broadcastFn({ type: 'state', state: snapshot(), ...extra });
  } catch (e) {
    console.error('[STATE] broadcast error:', e.message);
  }
}

/**
 * Snapshot publico del estado. NO incluye:
 *  - tokens OAuth (sensibles)
 *  - IPs de submissions (privacy)
 *  - submissions rechazadas en la lista publica /
 *
 * El admin tiene endpoints separados que devuelven info no filtrada con auth.
 */
function snapshot() {
  // Para el publico/master: stats por pais sin exponer todas las submissions
  return {
    countries: {
      cuba: {
        submissionsOpen: state.countries.cuba.submissionsOpen,
        teamLocked: state.countries.cuba.teamLocked,
        lockedTeam: resolveLockedTeam('cuba'),  // array de objetos con name/thumbnail/etc
        ready: state.countries.cuba.ready,
        counts: countSubmissions('cuba'),
      },
      pr: {
        submissionsOpen: state.countries.pr.submissionsOpen,
        teamLocked: state.countries.pr.teamLocked,
        lockedTeam: resolveLockedTeam('pr'),
        ready: state.countries.pr.ready,
        counts: countSubmissions('pr'),
      },
    },
    activePhase1Card: state.activePhase1Card,
    showStarted: state.showStarted,
    submissionsCap: SUBMISSIONS_CAP,

    // Bracket data — solo poblada si showStarted
    contestants: state.contestants,
    bracket: state.bracket,
    currentMatch: state.currentMatch,
    pendingDecision: state.pendingDecision,
    matchConfirmations: state.matchConfirmations || null,

    twitchConnections: {
      cuba: { connected: state.twitchConnections.cuba.connected, name: state.twitchConnections.cuba.name },
      pr:   { connected: state.twitchConnections.pr.connected,   name: state.twitchConnections.pr.name },
    },
  };
}

/**
 * Resuelve los IDs del lockedTeam a objetos con name, instagram y datos
 * de embed/thumbnail. Asi el master puede mostrar miniatura + nombre en
 * cada slot SIN exponer las submissions completas (que tienen IPs etc.).
 */
function resolveLockedTeam(country) {
  const c = state.countries[country];
  if (!c?.teamLocked || !c.lockedTeam?.length) return [];
  return c.lockedTeam.map(id => {
    const s = state.submissions.find(x => x.id === id);
    if (!s) return { id, name: 'FINALISTA', clipKind: 'link', clipThumbnail: null, clipPlatform: 'link' };
    return {
      id: s.id,
      name: s.name,
      instagram: s.instagram || '',
      mediaUrl: s.mediaUrl,
      clipKind: s.clipKind || 'link',
      clipPlatform: s.clipPlatform || 'link',
      clipThumbnail: s.clipThumbnail || null,
      clipEmbed: s.clipEmbed,
      clipEmbedAutoplay: s.clipEmbedAutoplay,
    };
  });
}

function countSubmissions(country) {
  let pending = 0, approved = 0, rejected = 0, passed = 0, eliminated = 0;
  for (const s of state.submissions) {
    if (s.country !== country) continue;
    if (s.status === 'pending')  pending++;
    else if (s.status === 'approved') approved++;
    else if (s.status === 'rejected') rejected++;
    if (s.eliminationDecision === 'passed')   passed++;
    else if (s.eliminationDecision === 'rejected') eliminated++;
  }
  // total = TODO lo recibido (info historica)
  // active = lo que cuenta contra el cap (pending + approved). Las rechazadas
  // liberan slot — el admin que limpia basura desbloquea espacio para
  // candidatos reales sin tener que subir el cap manualmente.
  return {
    pending, approved, rejected, passed, eliminated,
    total: pending + approved + rejected,
    active: pending + approved,
  };
}

function schedulePersist() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(persistNow, 250);
}

function persistNow() {
  _persistTimer = null;
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const payload = {
      submissions: state.submissions,
      countries: state.countries,
      activePhase1Card: null,         // No persistimos la card abierta — stale despues de un crash
      showStarted: state.showStarted,
      contestants: state.contestants,
      pairings: state.pairings,
      bracket: state.bracket,
      currentMatch: null,             // No persistimos la fase activa
      history: state.history,
      pendingDecision: null,
      twitchConnections: {
        cuba: { connected: false, name: state.twitchConnections.cuba.name, login: state.twitchConnections.cuba.login },
        pr:   { connected: false, name: state.twitchConnections.pr.name,   login: state.twitchConnections.pr.login },
      },
      savedAt: Date.now(),
    };
    fs.writeFileSync(STATE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    console.error('[STATE] persist error:', e.message);
  }
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(STATE_PATH)) return false;
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const data = JSON.parse(raw);

    state.submissions = data.submissions || [];
    // Backfill embed info para submissions creadas antes del campo clipKind.
    // Cargamos lazy el modulo de submissions para evitar circular require.
    let getEmbedInfo;
    try { getEmbedInfo = require('./submissions').getEmbedInfo; } catch {}
    if (getEmbedInfo) {
      for (const s of state.submissions) {
        if ((!s.clipKind || !('clipThumbnail' in s)) && s.mediaUrl) {
          const e = getEmbedInfo(s.mediaUrl) || { kind: 'link', embedUrl: s.mediaUrl, autoplayUrl: s.mediaUrl, thumbnailUrl: null, platform: 'link' };
          s.clipKind = e.kind;
          s.clipEmbed = e.embedUrl;
          s.clipEmbedAutoplay = e.autoplayUrl;
          s.clipThumbnail = e.thumbnailUrl;
          s.clipPlatform = e.platform;
        }
      }
    }
    if (data.countries) {
      state.countries.cuba = { ...state.countries.cuba, ...data.countries.cuba };
      state.countries.pr   = { ...state.countries.pr,   ...data.countries.pr };
    }
    state.activePhase1Card = null;
    state.showStarted = !!data.showStarted;
    state.contestants = data.contestants || {};
    state.pairings = data.pairings || [];
    state.bracket = data.bracket || null;
    state.currentMatch = null;
    state.history = data.history || [];
    state.pendingDecision = null;
    if (data.twitchConnections) {
      state.twitchConnections.cuba.name  = data.twitchConnections.cuba?.name || null;
      state.twitchConnections.cuba.login = data.twitchConnections.cuba?.login || null;
      state.twitchConnections.pr.name    = data.twitchConnections.pr?.name || null;
      state.twitchConnections.pr.login   = data.twitchConnections.pr?.login || null;
    }
    console.log('[STATE] loaded from disk —',
      state.submissions.length, 'submissions,',
      'cuba locked:', state.countries.cuba.teamLocked,
      ', pr locked:', state.countries.pr.teamLocked,
      ', show:', state.showStarted);
    return true;
  } catch (e) {
    console.error('[STATE] load error:', e.message);
    return false;
  }
}

/* ===== Twitch connection ===== */

function setTwitchConnection(side, info) {
  if (side !== 'cuba' && side !== 'pr') return;
  Object.assign(state.twitchConnections[side], info);
  broadcast({ twitchSideUpdated: side });
}

/* ===== Submissions ===== */

function getSubmission(id) {
  return state.submissions.find(s => s.id === id) || null;
}

function findIpSubmission(ip) {
  return state.submissions.find(s => s.ip === ip) || null;
}

function isCountryFull(country) {
  // Cap aplica al "active" (pending + approved). Las rejected NO consumen
  // slot — si el admin filtra basura, ese espacio se libera para otros.
  return countSubmissions(country).active >= SUBMISSIONS_CAP;
}

function isSubmissionsOpen(country) {
  return !!state.countries[country]?.submissionsOpen;
}

function addSubmission(sub) {
  state.submissions.push(sub);
  broadcast({ submissionAdded: sub.id });
}

function updateSubmission(id, patch) {
  const s = getSubmission(id);
  if (!s) return null;
  Object.assign(s, patch);
  broadcast({ submissionUpdated: id });
  return s;
}

function setSubmissionsOpen(country, open) {
  if (!state.countries[country]) return;
  state.countries[country].submissionsOpen = !!open;
  broadcast();
}

function setActivePhase1Card(country, cardId) {
  if (!cardId) {
    state.activePhase1Card = null;
  } else {
    state.activePhase1Card = { country, cardId };
  }
  broadcast();
}

function lockTeam(country, ids) {
  if (!state.countries[country]) return false;
  state.countries[country].teamLocked = true;
  state.countries[country].lockedAt = Date.now();
  state.countries[country].lockedTeam = ids.slice(0, 8);
  state.countries[country].submissionsOpen = false;  // se cierran los envios al lockear
  broadcast({ teamLocked: country });
  return true;
}

function unlockTeam(country) {
  if (!state.countries[country]) return false;
  state.countries[country].teamLocked = false;
  state.countries[country].lockedAt = null;
  state.countries[country].lockedTeam = [];
  state.countries[country].ready = false;
  state.countries[country].readyAt = null;
  broadcast({ teamUnlocked: country });
  return true;
}

/**
 * Marcar un pais como "listo" para arrancar el show. Requiere que el equipo
 * de 8 este lockeado. Cuando AMBOS paises estan ready=true, el caller (server)
 * arranca el show automaticamente.
 */
function setReady(country, ready) {
  if (!state.countries[country]) return { ok: false, error: 'pais invalido' };
  if (ready && !state.countries[country].teamLocked) {
    return { ok: false, error: 'Hay que cerrar el equipo de 8 primero.' };
  }
  state.countries[country].ready = !!ready;
  state.countries[country].readyAt = ready ? Date.now() : null;
  broadcast({ countryReadyChanged: country });
  return { ok: true, bothReady: state.countries.cuba.ready && state.countries.pr.ready };
}

/* ===== Show / bracket ===== */

function startShow(contestants, pairings, bracket) {
  state.contestants = contestants;
  state.pairings = pairings;
  state.bracket = bracket;
  state.showStarted = true;
  state.currentMatch = null;
  state.pendingDecision = null;
  broadcast({ showStarted: true });
}

function findMatch(matchId) {
  if (!state.bracket) return null;
  for (const round of state.bracket.rounds) {
    const m = round.find(x => x.id === matchId);
    if (m) return m;
  }
  return null;
}

function setCurrentMatch(matchId, phase, durationMs = 0) {
  const m = matchId ? findMatch(matchId) : null;
  if (matchId && !m) return null;

  if (m && phase) {
    if (phase === 'voting' && durationMs > 0) {
      state.currentMatch = {
        matchId, phase,
        startedAt: Date.now(),
        deadlineAt: Date.now() + durationMs,
        durationMs,
      };
    } else {
      state.currentMatch = { matchId, phase, startedAt: Date.now() };
    }
    if (m.status !== 'done') m.status = 'active';
  } else {
    state.currentMatch = null;
  }
  state.pendingDecision = null;
  broadcast({ currentMatchUpdated: true });
  return state.currentMatch;
}

function recordHistory(entry) {
  state.history.push(entry);
  if (state.history.length > 100) state.history = state.history.slice(-50);
  schedulePersist();
}

/* ===== 2-of-2 consensus (decision del ganador, modo viejo) ===== */

function proposeDecision(matchId, role, winnerSide) {
  if (!matchId || (role !== 'cuba' && role !== 'pr')) return null;
  if (!state.pendingDecision || state.pendingDecision.matchId !== matchId) {
    state.pendingDecision = { matchId, votes: { cuba: null, pr: null }, startedAt: Date.now() };
  }
  state.pendingDecision.votes[role] = winnerSide;
  broadcast({ pendingDecisionUpdated: true });
  const v = state.pendingDecision.votes;
  if (v.cuba && v.pr && v.cuba === v.pr) {
    return { consensus: true, winnerSide: v.cuba };
  }
  return { consensus: false, votes: { ...v } };
}

function clearPendingDecision() {
  state.pendingDecision = null;
  broadcast({ pendingDecisionCleared: true });
}

/* ===== Phase confirmations (modo nuevo, los streamers no deciden) =====
 *
 * Cada match avanza por fases (idle → preview → voting → result) cuando
 * AMBOS streamers (cuba+pr) presionan LISTO desde sus paneles.
 *
 * matchConfirmations es un objeto temporal:
 *   { matchId, phase: 'idle'|'preview'|'voting',
 *     cubaConfirmed: bool, prConfirmed: bool }
 *
 * Cuando los dos confirmaron la fase actual, el server avanza:
 *   idle    + 2 ready → preview (video reproduce para todos)
 *   preview + 2 ready → voting  (chat puede votar)
 *   voting  + 2 ready (o timeout) → result (decide por mayoria del chat)
 */
function setMatchConfirmation(matchId, phase, role) {
  if (!matchId || !['idle','preview','voting'].includes(phase)) return null;
  if (role !== 'cuba' && role !== 'pr') return null;
  if (!state.matchConfirmations
      || state.matchConfirmations.matchId !== matchId
      || state.matchConfirmations.phase !== phase) {
    state.matchConfirmations = {
      matchId, phase,
      cubaConfirmed: false, prConfirmed: false,
      startedAt: Date.now(),
    };
  }
  if (role === 'cuba') state.matchConfirmations.cubaConfirmed = true;
  if (role === 'pr')   state.matchConfirmations.prConfirmed   = true;
  broadcast({ matchConfirmationUpdated: true });
  const c = state.matchConfirmations;
  return {
    bothReady: c.cubaConfirmed && c.prConfirmed,
    cubaConfirmed: c.cubaConfirmed,
    prConfirmed:   c.prConfirmed,
  };
}

function clearMatchConfirmations() {
  state.matchConfirmations = null;
  broadcast({ matchConfirmationsCleared: true });
}

/* ===== Reset ===== */

function resetEverything() {
  state.submissions = [];
  state.countries.cuba = { submissionsOpen: true, teamLocked: false, lockedAt: null, lockedTeam: [], ready: false, readyAt: null };
  state.countries.pr   = { submissionsOpen: true, teamLocked: false, lockedAt: null, lockedTeam: [], ready: false, readyAt: null };
  state.activePhase1Card = null;
  state.showStarted = false;
  state.contestants = {};
  state.pairings = [];
  state.bracket = null;
  state.currentMatch = null;
  state.history = [];
  state.pendingDecision = null;
  broadcast({ reset: true });
}

function resetShowOnly() {
  // Conserva submissions y locked teams pero desarma el bracket
  state.showStarted = false;
  state.contestants = {};
  state.pairings = [];
  state.bracket = null;
  state.currentMatch = null;
  state.history = [];
  state.pendingDecision = null;
  broadcast({ showReset: true });
}

module.exports = {
  state,
  snapshot,
  setBroadcaster,
  broadcast,
  loadFromDisk,
  persistNow,
  SUBMISSIONS_CAP,

  setTwitchConnection,

  getSubmission,
  findIpSubmission,
  isCountryFull,
  isSubmissionsOpen,
  addSubmission,
  updateSubmission,
  countSubmissions,
  setSubmissionsOpen,
  setActivePhase1Card,
  lockTeam,
  unlockTeam,
  setReady,

  startShow,
  findMatch,
  setCurrentMatch,
  recordHistory,

  proposeDecision,
  clearPendingDecision,
  setMatchConfirmation,
  clearMatchConfirmations,

  resetEverything,
  resetShowOnly,
};
