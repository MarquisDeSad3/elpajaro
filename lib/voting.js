/**
 * Voting engine — recibe votos del IRC de los DOS canales (cuba y pr)
 * y los suma sobre el match activo.
 *
 * Reglas:
 *   - Solo se acepta voto si hay match activo en fase 'voting'.
 *   - 1 voto por username por match (independiente del canal). Si vota
 *     "1" desde el chat cubano y despues "2" desde el chat de PR, el
 *     primer voto se sustrae y se cuenta el segundo (vote-change).
 *   - Devolvemos el desglose por origen: votes.cuba.left, votes.cuba.right,
 *     votes.pr.left, votes.pr.right + total combinado.
 *   - history[] guarda los ultimos N votos para la animacion de nombres
 *     flotantes en el overlay.
 *
 * Patron de regex y dedup tomado de TortillaTV/server/concurso-polls.js,
 * extendido para multi-origen.
 */

const LEFT_REGEX  = /\b(1|uno|one|izq|izquierda|left|cuba|c)\b/i;
const RIGHT_REGEX = /\b(2|dos|two|der|derecha|right|pr|puerto|borinquen|p)\b/i;

let _broadcastFn = null;
let _state = null;       // ref al state.js central — para leer currentMatch
let _onTimeout = null;   // callback que llama el server cuando expira el timer

let active = null;
// Forma de active:
// {
//   matchId,
//   votes: { cuba: { left, right }, pr: { left, right } },
//   voters: Map<username, { side: 'left'|'right', origin: 'cuba'|'pr' }>,
//   history: [{ user, side, origin, ts }, ...],
//   startedAt, deadlineAt, durationMs, timer
// }

function init({ broadcastFn, stateModule, onTimeoutFn }) {
  _broadcastFn = broadcastFn;
  _state = stateModule;
  _onTimeout = onTimeoutFn;
}

function broadcast(payload) {
  if (_broadcastFn) {
    try { _broadcastFn(payload); } catch (e) { console.error('[VOTING] broadcast error:', e.message); }
  }
}

function snapshot() {
  if (!active) return null;
  const totals = {
    cubaTotal: active.votes.cuba.left + active.votes.cuba.right,
    prTotal:   active.votes.pr.left   + active.votes.pr.right,
    leftTotal:  active.votes.cuba.left  + active.votes.pr.left,
    rightTotal: active.votes.cuba.right + active.votes.pr.right,
  };
  totals.grandTotal = totals.leftTotal + totals.rightTotal;
  return {
    matchId: active.matchId,
    votes: active.votes,
    totals,
    voterCount: active.voters.size,
    history: active.history.slice(-30),
    durationMs: active.durationMs,
    remainingMs: Math.max(0, active.deadlineAt - Date.now()),
  };
}

function start(matchId, durationMs = 60_000) {
  if (active) endNow();   // cerrar cualquier votacion previa
  active = {
    matchId,
    votes: { cuba: { left: 0, right: 0 }, pr: { left: 0, right: 0 } },
    voters: new Map(),
    history: [],
    startedAt: Date.now(),
    deadlineAt: Date.now() + durationMs,
    durationMs,
    timer: null,
  };
  active.timer = setTimeout(() => {
    endNow();
    if (_onTimeout) {
      try { _onTimeout(matchId); } catch (e) { console.error('[VOTING] onTimeout error:', e.message); }
    }
  }, durationMs);
  broadcast({ type: 'voting-start', poll: snapshot() });
}

function endNow() {
  if (!active) return null;
  if (active.timer) clearTimeout(active.timer);
  const final = snapshot();
  active = null;
  if (final) {
    final.ended = true;
    broadcast({ type: 'voting-end', poll: final });
  }
  return final;
}

function getActive() {
  return active ? snapshot() : null;
}

/**
 * Llamado por twitch-irc.js para cada PRIVMSG de cualquiera de los dos canales.
 * `origin` viene del listener — siempre 'cuba' o 'pr'.
 */
function handleChat(username, rawMessage, origin) {
  if (!active) return;
  if (origin !== 'cuba' && origin !== 'pr') return;
  // Si el match activo en state.js no esta en fase 'voting', ignoramos.
  const cur = _state?.state?.currentMatch;
  if (!cur || cur.matchId !== active.matchId || cur.phase !== 'voting') return;

  const msg = String(rawMessage || '').trim();
  if (!msg) return;

  let side = null;
  if (LEFT_REGEX.test(msg))      side = 'left';
  else if (RIGHT_REGEX.test(msg)) side = 'right';
  if (!side) return;

  const lowerUser = username.toLowerCase();
  const prev = active.voters.get(lowerUser);

  // Caso 1: primer voto del usuario
  if (!prev) {
    active.voters.set(lowerUser, { side, origin });
    active.votes[origin][side] += 1;
  }
  // Caso 2: voto repetido igual — ignorar
  else if (prev.side === side && prev.origin === origin) {
    return;
  }
  // Caso 3: cambio de voto (lado o canal) — restamos el viejo, sumamos el nuevo
  else {
    active.votes[prev.origin][prev.side] = Math.max(0, active.votes[prev.origin][prev.side] - 1);
    active.voters.set(lowerUser, { side, origin });
    active.votes[origin][side] += 1;
  }

  active.history.push({ user: username, side, origin, ts: Date.now() });
  if (active.history.length > 200) active.history = active.history.slice(-100);

  broadcast({
    type: 'voting-update',
    poll: snapshot(),
    lastVote: { user: username, side, origin, ts: Date.now() },
  });
}

module.exports = { init, start, endNow, getActive, handleChat };
