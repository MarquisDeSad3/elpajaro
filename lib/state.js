/**
 * Estado central en memoria del show.
 *
 * Se persiste a disco (data/state.json) en cada cambio relevante para que
 * un restart no pierda el bracket configurado ni los resultados ya cantados.
 * Si en algun momento se conecta Firebase, esto se puede swappear por
 * Firestore sin tocar el resto del codigo.
 *
 * Forma de la data:
 *  - contestants: 16 entradas { id, name, country: 'cuba'|'pr', photoUrl, bio,
 *                              clipUrl, clipType: 'audio'|'video' }
 *  - bracket: { rounds: [[match,...], ...], wingChampions: { left, right }, championId }
 *      match: { id, round, slot, leftId, rightId, winnerId, status, decidedAt,
 *               parentMatchId? }   // status: 'pending'|'active'|'done'
 *  - currentMatch: { matchId, phase: 'preview'|'voting'|'result',
 *                    deadlineAt?, startedAt }
 *  - votes: por match, manejado en voting.js — aca solo guardamos resultado historico.
 */

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'data', 'state.json');

const state = {
  contestants: {},          // id -> contestant
  pairings: [],             // 8 octofinal pairings: [{ leftId, rightId, wing: 'left'|'right' }]
  bracket: null,            // construido por bracket.js
  currentMatch: null,       // { matchId, phase, deadlineAt, startedAt }
  history: [],              // matches resueltos (snapshots) — para auditoria
  twitchConnections: {      // estado de OAuth de cada lado
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
 * Snapshot publico del estado — lo que mandamos por WS al overlay y al host.
 * No incluye datos sensibles (tokens OAuth nunca salen del server).
 */
function snapshot() {
  return {
    contestants: state.contestants,
    pairings: state.pairings,
    bracket: state.bracket,
    currentMatch: state.currentMatch,
    twitchConnections: {
      cuba: { connected: state.twitchConnections.cuba.connected, name: state.twitchConnections.cuba.name },
      pr:   { connected: state.twitchConnections.pr.connected,   name: state.twitchConnections.pr.name },
    },
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
      contestants: state.contestants,
      pairings: state.pairings,
      bracket: state.bracket,
      currentMatch: state.currentMatch,
      history: state.history,
      // Los tokens OAuth NO se persisten. Si se reinicia el server, los
      // creadores tienen que reautorizar — es un trade-off de seguridad.
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
    state.contestants = data.contestants || {};
    state.pairings = data.pairings || [];
    state.bracket = data.bracket || null;
    // No restauramos un currentMatch que estuviese 'voting' — es muy probable
    // que sea stale despues de un crash. Lo dejamos en null y el host vuelve
    // a abrir lo que toque.
    state.currentMatch = null;
    state.history = data.history || [];
    if (data.twitchConnections) {
      state.twitchConnections.cuba.name  = data.twitchConnections.cuba?.name || null;
      state.twitchConnections.cuba.login = data.twitchConnections.cuba?.login || null;
      state.twitchConnections.pr.name    = data.twitchConnections.pr?.name || null;
      state.twitchConnections.pr.login   = data.twitchConnections.pr?.login || null;
    }
    console.log('[STATE] loaded from disk —',
      Object.keys(state.contestants).length, 'contestants,',
      state.bracket ? `${state.bracket.rounds.length} rounds` : 'no bracket');
    return true;
  } catch (e) {
    console.error('[STATE] load error:', e.message);
    return false;
  }
}

/* ===== Contestants ===== */

function setContestants(list) {
  state.contestants = {};
  for (const c of list) {
    if (!c.id) continue;
    state.contestants[c.id] = c;
  }
  broadcast({ contestantsUpdated: true });
}

function upsertContestant(c) {
  if (!c.id) return;
  state.contestants[c.id] = c;
  broadcast({ contestantUpdated: c.id });
}

function setPairings(pairings) {
  state.pairings = pairings;
  broadcast({ pairingsUpdated: true });
}

/* ===== Twitch connection state ===== */

function setTwitchConnection(side, info) {
  if (side !== 'cuba' && side !== 'pr') return;
  Object.assign(state.twitchConnections[side], info);
  broadcast({ twitchSideUpdated: side });
}

/* ===== Bracket ===== */

function setBracket(bracket) {
  state.bracket = bracket;
  state.currentMatch = null;
  broadcast({ bracketUpdated: true });
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
        matchId,
        phase,
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
  broadcast({ currentMatchUpdated: true });
  return state.currentMatch;
}

function recordHistory(entry) {
  state.history.push(entry);
  if (state.history.length > 100) state.history = state.history.slice(-50);
  schedulePersist();
}

/* ===== Reset ===== */

function reset() {
  state.bracket = null;
  state.currentMatch = null;
  state.history = [];
  broadcast({ reset: true });
}

module.exports = {
  state,
  snapshot,
  setBroadcaster,
  broadcast,
  loadFromDisk,
  persistNow,
  setContestants,
  upsertContestant,
  setPairings,
  setTwitchConnection,
  setBracket,
  findMatch,
  setCurrentMatch,
  recordHistory,
  reset,
};
