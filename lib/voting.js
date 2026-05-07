/**
 * Voting engine.
 *
 * Dos modos:
 *   - 'binary': SI/NO para fase 1 (eliminacion por pais — ¿esta cantante pasa?)
 *   - 'duel':   1/2 para el bracket (cuba vs pr u otros cruces)
 *
 * Reglas:
 *   - Solo se acepta voto si hay match/card activa.
 *   - 1 voto por username Twitch. Cambio de voto: resta el viejo y suma el nuevo.
 *   - Origen del voto (cuba|pr) se guarda para mostrar desglose en barras,
 *     PERO no filtra: ambos chats votan en todo lo que este abierto. La
 *     decision de no filtrar viene del usuario (mas viewers, mas chat, mas show).
 *   - history[] guarda los ultimos N para la animacion de nombres flotantes.
 */

const SI_REGEX  = /\b(si|sí|s|yes|y|pasa|keep)\b/i;
const NO_REGEX  = /\b(no|n|fuera|kick|out)\b/i;
const ONE_REGEX = /\b(1|uno|one|izq|izquierda|left|cuba|c|a)\b/i;
const TWO_REGEX = /\b(2|dos|two|der|derecha|right|pr|puerto|borinquen|p|b)\b/i;

let _broadcastFn = null;
let _stateModule = null;
let _onTimeoutFn  = null;

let active = null;
// Forma de active:
// {
//   mode: 'binary'|'duel',
//   targetId: matchId o cardId,         // que match/card es esta votacion
//   votes:  // segun mode:
//     binary: { cuba: { si, no }, pr: { si, no } }
//     duel:   { cuba: { left, right }, pr: { left, right } }
//   voters: Map<lowerUsername, { side, origin }>,
//   history: [{ user, side, origin, ts }],
//   startedAt, deadlineAt, durationMs, timer
// }

function init({ broadcastFn, stateModule, onTimeoutFn }) {
  _broadcastFn = broadcastFn;
  _stateModule = stateModule;
  _onTimeoutFn  = onTimeoutFn;
}

function broadcast(payload) {
  if (_broadcastFn) {
    try { _broadcastFn(payload); } catch (e) { console.error('[VOTING] broadcast error:', e.message); }
  }
}

function emptyVotes(mode) {
  if (mode === 'binary') return { cuba: { si: 0, no: 0 }, pr: { si: 0, no: 0 } };
  return { cuba: { left: 0, right: 0 }, pr: { left: 0, right: 0 } };
}

function snapshot() {
  if (!active) return null;
  let totals;
  if (active.mode === 'binary') {
    totals = {
      siTotal: active.votes.cuba.si + active.votes.pr.si,
      noTotal: active.votes.cuba.no + active.votes.pr.no,
      cubaTotal: active.votes.cuba.si + active.votes.cuba.no,
      prTotal:   active.votes.pr.si + active.votes.pr.no,
    };
    totals.grandTotal = totals.siTotal + totals.noTotal;
  } else {
    totals = {
      leftTotal:  active.votes.cuba.left  + active.votes.pr.left,
      rightTotal: active.votes.cuba.right + active.votes.pr.right,
      cubaTotal:  active.votes.cuba.left  + active.votes.cuba.right,
      prTotal:    active.votes.pr.left    + active.votes.pr.right,
    };
    totals.grandTotal = totals.leftTotal + totals.rightTotal;
  }
  return {
    mode: active.mode,
    targetId: active.targetId,
    votes: active.votes,
    totals,
    voterCount: active.voters.size,
    history: active.history.slice(-30),
    durationMs: active.durationMs,
    remainingMs: Math.max(0, active.deadlineAt - Date.now()),
  };
}

function start({ mode, targetId, durationMs = 60_000 }) {
  if (!['binary', 'duel'].includes(mode)) {
    console.warn('[VOTING] modo invalido:', mode);
    return null;
  }
  if (active) endNow();
  active = {
    mode,
    targetId,
    votes: emptyVotes(mode),
    voters: new Map(),
    history: [],
    startedAt: Date.now(),
    deadlineAt: Date.now() + durationMs,
    durationMs,
    timer: null,
  };
  active.timer = setTimeout(() => {
    const tid = active?.targetId;
    endNow();
    if (_onTimeoutFn) {
      try { _onTimeoutFn(tid, mode); } catch (e) { console.error('[VOTING] onTimeout error:', e.message); }
    }
  }, durationMs);
  broadcast({ type: 'voting-start', poll: snapshot() });
  return snapshot();
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
 * Llamado por twitch-irc.js para cada PRIVMSG. `origin` es 'cuba' o 'pr'.
 * El voto cuenta independientemente del origen (decision del usuario:
 * todo el chat de los dos canales vota). El origen solo se guarda para
 * mostrar el desglose en barras.
 */
function handleChat(username, rawMessage, origin) {
  if (!active) return;
  if (origin !== 'cuba' && origin !== 'pr') return;
  const msg = String(rawMessage || '').trim();
  if (!msg) return;

  let side = null;
  if (active.mode === 'binary') {
    if (SI_REGEX.test(msg))      side = 'si';
    else if (NO_REGEX.test(msg)) side = 'no';
  } else {
    if (ONE_REGEX.test(msg))      side = 'left';
    else if (TWO_REGEX.test(msg)) side = 'right';
  }
  if (!side) return;

  const lowerUser = String(username).toLowerCase();
  const prev = active.voters.get(lowerUser);

  if (!prev) {
    active.voters.set(lowerUser, { side, origin });
    active.votes[origin][side] += 1;
  } else if (prev.side === side && prev.origin === origin) {
    return;  // mismo voto repetido
  } else {
    // cambio de voto — restamos el viejo, sumamos el nuevo
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
