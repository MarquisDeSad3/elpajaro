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

// Tokens validos por modo. En vez de regex con \b (que falla con caracteres
// acentuados como 'í' porque JS no los considera word-chars), tokenizamos
// el mensaje y comparamos cada token contra un set. Mas robusto y mas
// claro.
// Tokens 100% POSICIONALES — el lado se decide por la ubicacion en el match,
// nunca por el pais del cantante. Ojo: NO incluir 'cuba'/'pr' aca; el orden
// del bracket es aleatorio (cuba puede estar a la derecha) y ademas el chat
// usa esos nombres para referirse a los cantantes, no a los lados.
const VOTE_TOKENS = {
  binary: {
    si: new Set(['si', 'sí', 'yes', 'pasa']),
    no: new Set(['no', 'nope', 'fuera']),
  },
  duel: {
    left:  new Set(['1', 'uno', 'azul', 'blue', 'izquierda', 'left']),
    right: new Set(['2', 'dos', 'rojo', 'red',  'derecha',   'right']),
  },
};

// Tokeniza el mensaje en palabras (incluyendo letras acentuadas). Devuelve
// array de tokens en lowercase.
function tokenize(msg) {
  const lower = String(msg || '').toLowerCase();
  // Match: secuencias de letras unicode + numeros. Excluye signos y espacios.
  const matches = lower.match(/[\p{Letter}\p{Number}]+/gu);
  return matches || [];
}

function detectVote(msg, mode) {
  const tokens = tokenize(msg);
  const map = VOTE_TOKENS[mode];
  if (!map) return null;
  for (const tok of tokens) {
    for (const [side, valid] of Object.entries(map)) {
      if (valid.has(tok)) return side;
    }
  }
  return null;
}

// Si VOTE_LOCK_FINAL es true, el primer voto del user es FINAL: si vota
// "si" y despues "no", el segundo se ignora. Si esta en false, permite
// cambio de voto (resta el viejo, suma el nuevo).
// El usuario pidio "no pueden votar doble" → lo dejamos estricto.
const VOTE_LOCK_FINAL = true;

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

  // detectVote() tokeniza el mensaje y matchea contra VOTE_TOKENS por modo.
  // Robusto con acentos (sí), tildes, signos de puntuacion.
  const side = detectVote(msg, active.mode);
  if (!side) return;

  const lowerUser = String(username).toLowerCase();
  const prev = active.voters.get(lowerUser);

  let action; // 'counted' | 'locked' | 'idempotent' | 'switched'
  if (!prev) {
    // Primer voto del user — cuenta
    active.voters.set(lowerUser, { side, origin });
    active.votes[origin][side] += 1;
    action = 'counted';
  } else if (VOTE_LOCK_FINAL) {
    // El user ya voto antes — ignorar TODO (incluso si cambia su mensaje).
    // Esta es la opcion estricta: primer voto = final.
    console.log(`[VOTE] LOCKED user=${username} tried side=${side} origin=${origin} but already voted ${prev.side}/${prev.origin}`);
    return;
  } else if (prev.side === side && prev.origin === origin) {
    // Mismo voto repetido — idempotente
    return;
  } else {
    // Cambio de voto (solo si VOTE_LOCK_FINAL=false) — resta viejo, suma nuevo
    active.votes[prev.origin][prev.side] = Math.max(0, active.votes[prev.origin][prev.side] - 1);
    active.voters.set(lowerUser, { side, origin });
    active.votes[origin][side] += 1;
    action = 'switched';
  }

  active.history.push({ user: username, side, origin, ts: Date.now() });
  if (active.history.length > 200) active.history = active.history.slice(-100);

  // Logging visible: cada voto contado tira una linea con totals updated.
  // Asi cuando el usuario abre los logs de Render ve si los votos llegan.
  const t = active.mode === 'duel'
    ? `L=${active.votes.cuba.left + active.votes.pr.left} R=${active.votes.cuba.right + active.votes.pr.right}`
    : `SI=${active.votes.cuba.si + active.votes.pr.si} NO=${active.votes.cuba.no + active.votes.pr.no}`;
  console.log(`[VOTE] ${action} user=${username} side=${side} origin=${origin} msg="${msg.slice(0,50)}" totals: ${t}`);

  broadcast({
    type: 'voting-update',
    poll: snapshot(),
    lastVote: { user: username, side, origin, ts: Date.now() },
  });
}

module.exports = { init, start, endNow, getActive, handleChat };
