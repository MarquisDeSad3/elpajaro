/**
 * Bracket El Pajaro: 16 cantantes en eliminacion simple, mapeado sobre
 * un pajaro con dos alas.
 *
 * Estructura:
 *   - 8 cantantes "del ala izquierda" (4 cubanos + 4 PR posicionados ahi)
 *   - 8 cantantes "del ala derecha" (4 cubanos + 4 PR)
 *   - Round 0 (octofinales): 8 matches — 4 left, 4 right. Cada match es
 *     estrictamente Cuba vs PR (eso lo garantiza el host al armar las
 *     pairings).
 *   - Round 1 (cuartos): 4 matches — 2 left, 2 right. Aca pueden cruzarse
 *     dos cubanos o dos PR; manda la posicion del bracket, no la nacionalidad.
 *   - Round 2 (semifinales): 2 matches — 1 left (campeon ala izq), 1 right.
 *   - Round 3 (final): 1 match en el corazon del pajaro.
 *
 * Cada match conoce su `parentMatchId` (a donde avanza el ganador), excepto
 * la final que no tiene padre.
 */

const crypto = require('crypto');

function newId() { return crypto.randomBytes(8).toString('hex'); }

function makeMatch(round, wing, slot, leftId = null, rightId = null) {
  return {
    id: newId(),
    round,            // 0..3
    wing,             // 'left' | 'right' | 'center' (final)
    slot,             // posicion dentro de la ronda (0..N-1)
    leftId,
    rightId,
    winnerId: null,
    status: 'pending',  // 'pending' | 'active' | 'done'
    decidedAt: null,
    parentMatchId: null,
  };
}

/**
 * Construye el bracket vacio (sin contestants asignados todavia) — la
 * topologia es fija. Despues `applyPairings` rellena los octofinales.
 *
 * Layout:
 *   round 0 octofinales: 8 matches (slots 0..3 left, 4..7 right)
 *   round 1 cuartos:     4 matches (slots 0..1 left, 2..3 right)
 *     - quarter 0 = winners de octofinal 0 + 1
 *     - quarter 1 = winners de octofinal 2 + 3
 *     - quarter 2 = winners de octofinal 4 + 5
 *     - quarter 3 = winners de octofinal 6 + 7
 *   round 2 semis:       2 matches (slot 0 left, slot 1 right)
 *     - semi 0 = winners de quarter 0 + 1   (campeon ala izquierda)
 *     - semi 1 = winners de quarter 2 + 3   (campeon ala derecha)
 *   round 3 final:       1 match (center)
 */
function buildEmptyBracket() {
  const r0 = [];
  for (let i = 0; i < 8; i++) {
    const wing = i < 4 ? 'left' : 'right';
    r0.push(makeMatch(0, wing, i));
  }
  const r1 = [];
  for (let i = 0; i < 4; i++) {
    const wing = i < 2 ? 'left' : 'right';
    r1.push(makeMatch(1, wing, i));
  }
  const r2 = [
    makeMatch(2, 'left',  0),
    makeMatch(2, 'right', 1),
  ];
  const r3 = [makeMatch(3, 'center', 0)];

  // Wire parentMatchIds: cada match conoce a donde avanza su ganador.
  for (let i = 0; i < 8; i++) r0[i].parentMatchId = r1[Math.floor(i / 2)].id;
  for (let i = 0; i < 4; i++) r1[i].parentMatchId = r2[Math.floor(i / 2)].id;
  for (let i = 0; i < 2; i++) r2[i].parentMatchId = r3[0].id;

  return {
    rounds: [r0, r1, r2, r3],
    wingChampions: { left: null, right: null },
    championId: null,
    createdAt: Date.now(),
  };
}

/**
 * Aplica las 8 pairings de octofinales al bracket vacio.
 * `pairings` es un array de 8 elementos, en orden de slot 0..7:
 *   [{ leftId, rightId, wing: 'left'|'right' }, ...]
 *
 * No validamos aqui que sea estrictamente Cuba-vs-PR (eso lo valida el
 * host UI antes de mandar la peticion); aceptamos cualquier 8 pairings.
 */
function applyPairings(bracket, pairings) {
  if (!Array.isArray(pairings) || pairings.length !== 8) {
    return { ok: false, error: 'Se esperan 8 emparejamientos.' };
  }
  const r0 = bracket.rounds[0];
  for (let i = 0; i < 8; i++) {
    const p = pairings[i];
    if (!p || !p.leftId || !p.rightId || p.leftId === p.rightId) {
      return { ok: false, error: `Emparejamiento invalido en slot ${i}.` };
    }
    r0[i].leftId = p.leftId;
    r0[i].rightId = p.rightId;
    r0[i].status = 'pending';
    r0[i].winnerId = null;
    r0[i].decidedAt = null;
  }
  return { ok: true };
}

/**
 * Cuando un match termina, mete al ganador en su match padre (en la slot
 * correcta segun si era el "even" o el "odd" de su ronda).
 */
function advanceWinner(bracket, match) {
  if (!match.parentMatchId) return;
  let parent = null;
  for (const round of bracket.rounds) {
    const found = round.find(m => m.id === match.parentMatchId);
    if (found) { parent = found; break; }
  }
  if (!parent) return;

  // En cada ronda los matches estan ordenados por slot. El even-slot va al
  // leftId del padre, el odd al rightId. (slot 0,1 -> padre 0; slot 2,3 -> padre 1; etc)
  const isEven = match.slot % 2 === 0;
  if (isEven) parent.leftId = match.winnerId;
  else        parent.rightId = match.winnerId;
}

/**
 * Marca un ganador en un match. Mueve al ganador al siguiente nivel y,
 * si era una semifinal o final, actualiza wingChampions/championId.
 */
function decideMatch(bracket, matchId, winnerSide) {
  if (!['left', 'right'].includes(winnerSide)) {
    return { ok: false, error: 'Lado invalido.' };
  }
  let target = null, roundIdx = -1;
  for (let i = 0; i < bracket.rounds.length; i++) {
    const m = bracket.rounds[i].find(x => x.id === matchId);
    if (m) { target = m; roundIdx = i; break; }
  }
  if (!target) return { ok: false, error: 'Match no encontrado.' };
  if (target.status === 'done') return { ok: false, error: 'Match ya cerrado.' };
  if (!target.leftId || !target.rightId) {
    return { ok: false, error: 'El match no tiene ambos contestantes asignados.' };
  }

  target.winnerId = winnerSide === 'left' ? target.leftId : target.rightId;
  target.status = 'done';
  target.decidedAt = Date.now();

  advanceWinner(bracket, target);

  // Wing champions = ganadores de las 2 semifinales (round 2)
  if (roundIdx === 2) {
    if (target.wing === 'left')  bracket.wingChampions.left  = target.winnerId;
    if (target.wing === 'right') bracket.wingChampions.right = target.winnerId;
  }
  // Champion = ganador de la final
  if (roundIdx === 3) {
    bracket.championId = target.winnerId;
  }

  return { ok: true, match: target };
}

module.exports = {
  buildEmptyBracket,
  applyPairings,
  decideMatch,
};
