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
 * Re-emparejamiento al cerrar una ronda completa: prioriza CUBA vs PR
 * mientras haya cantantes de ambos paises. Solo cae en mismo-pais cuando
 * uno de los pools se agota.
 *
 * El `parentMatchId` de cada match (heredado del builder) se vuelve solo
 * informativo en este modelo — los ganadores se reagrupan dinamicamente
 * en lugar de subir por un arbol fijo. Asi el show preserva la rivalidad
 * Cuba-PR el mayor tiempo posible: si en octofinales gana Cuba en oct[0]
 * y oct[1] (que en bracket fijo darian Cuba vs Cuba en cuartos), aca se
 * re-cruzan con ganadores PR de otros octofinales.
 *
 * Reglas:
 *   - winners[] de la ronda anterior se separan por contestants[id].country
 *   - Mientras haya en ambos pools: pop random de cuba + pop random de pr
 *   - Si solo queda mismo pais: emparejar entre ellos
 *   - Si en la ronda anterior los 2 ya eran del mismo pais (final con
 *     2 cubanos), no hay forma de cross — se acepta same-country.
 *
 * @returns array de pairings [{leftId, rightId}, ...] del mismo length que
 *          la ronda destino. Los matches existentes se modifican in-place.
 */
function repopulateNextRound(bracket, nextRoundIdx, winners, contestants) {
  if (!bracket.rounds[nextRoundIdx]) return null;
  const nextRound = bracket.rounds[nextRoundIdx];
  const expectedPairs = nextRound.length;

  const cubans = [];
  const prs    = [];
  const others = []; // edge case: contestant sin pais o no encontrado
  for (const id of winners) {
    if (!id) continue;
    const c = contestants?.[id];
    if (c?.country === 'cuba')      cubans.push(id);
    else if (c?.country === 'pr')   prs.push(id);
    else                             others.push(id);
  }
  // Shuffle dentro de cada pool — para que NO sea siempre el mismo Cuba
  // vs el mismo PR cuando la disposicion del bracket te quede igual.
  _shuffleInPlace(cubans);
  _shuffleInPlace(prs);
  _shuffleInPlace(others);

  const pairs = [];
  // 1) Cruces Cuba vs PR mientras haya de ambos
  while (cubans.length && prs.length && pairs.length < expectedPairs) {
    pairs.push({ leftId: cubans.shift(), rightId: prs.shift() });
  }
  // 2) Si quedan cubanos solos, emparejar entre si
  while (cubans.length >= 2 && pairs.length < expectedPairs) {
    pairs.push({ leftId: cubans.shift(), rightId: cubans.shift() });
  }
  // 3) Idem PR
  while (prs.length >= 2 && pairs.length < expectedPairs) {
    pairs.push({ leftId: prs.shift(), rightId: prs.shift() });
  }
  // 4) Edge: un cubano + un PR + un otros (no deberia pasar pero lo cubrimos)
  const leftover = [...cubans, ...prs, ...others];
  while (leftover.length >= 2 && pairs.length < expectedPairs) {
    pairs.push({ leftId: leftover.shift(), rightId: leftover.shift() });
  }

  // Aplicar pairings a los matches de la ronda destino
  for (let i = 0; i < expectedPairs; i++) {
    const p = pairs[i];
    if (!p) {
      // Falta info — limpiar el match para que no quede zombie
      nextRound[i].leftId = null;
      nextRound[i].rightId = null;
      nextRound[i].status = 'pending';
      nextRound[i].winnerId = null;
      nextRound[i].decidedAt = null;
      continue;
    }
    nextRound[i].leftId  = p.leftId;
    nextRound[i].rightId = p.rightId;
    nextRound[i].status = 'pending';
    nextRound[i].winnerId = null;
    nextRound[i].decidedAt = null;
  }

  return pairs;
}

function _shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Marca un ganador en un match. Si con esa decision se completo la ronda,
 * re-empareja los ganadores de esa ronda en la siguiente (priorizando
 * Cuba vs PR). Tambien actualiza wingChampions / championId cuando
 * corresponde.
 *
 * @param contestants  dict { id: { country, ... } } — necesario solo si
 *                     queres que la ronda haga el re-pairing automatico
 *                     al completarse. Si lo omitis, el match se marca done
 *                     pero la siguiente ronda queda sin armar (modo legacy).
 */
function decideMatch(bracket, matchId, winnerSide, contestants = null) {
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

  // Si terminamos toda la ronda, repoblar la siguiente con re-pair Cuba-vs-PR
  let roundComplete = false;
  let nextRoundPairs = null;
  if (roundIdx < 3) {
    const round = bracket.rounds[roundIdx];
    roundComplete = round.every(m => m.status === 'done');
    if (roundComplete && contestants) {
      const winners = round.map(m => m.winnerId);
      nextRoundPairs = repopulateNextRound(bracket, roundIdx + 1, winners, contestants);
      console.log(`[BRACKET] ronda ${roundIdx} completa → repaired round ${roundIdx + 1}:`,
        nextRoundPairs?.map(p => {
          const a = contestants[p.leftId];
          const b = contestants[p.rightId];
          return `${a?.name}(${a?.country}) vs ${b?.name}(${b?.country})`;
        }).join(' | '));
    }
  }

  // Wing champions = ganadores de las 2 semifinales (round 2)
  if (roundIdx === 2) {
    if (target.wing === 'left')  bracket.wingChampions.left  = target.winnerId;
    if (target.wing === 'right') bracket.wingChampions.right = target.winnerId;
  }
  // Champion = ganador de la final
  if (roundIdx === 3) {
    bracket.championId = target.winnerId;
  }

  return { ok: true, match: target, roundComplete, nextRoundPairs };
}

/**
 * Builder de alto nivel: recibe directamente los 8 IDs cubanos + 8 IDs PR
 * (lockedTeam de cada pais) y construye el bracket lleno de octofinales
 * cruzados. Por default empareja cuban[i] vs pr[i]; el master puede
 * "barajar" antes de arrancar para randomizar.
 */
function buildFromTeams(cubaIds, prIds, { shuffle = false } = {}) {
  if (!Array.isArray(cubaIds) || cubaIds.length !== 8) {
    return { ok: false, error: 'cubaIds debe tener 8 elementos.' };
  }
  if (!Array.isArray(prIds) || prIds.length !== 8) {
    return { ok: false, error: 'prIds debe tener 8 elementos.' };
  }
  let cs = cubaIds.slice();
  let ps = prIds.slice();
  if (shuffle) {
    cs = _shuffle(cs);
    ps = _shuffle(ps);
  }
  const pairings = [];
  for (let i = 0; i < 8; i++) {
    pairings.push({ leftId: cs[i], rightId: ps[i], wing: i < 4 ? 'left' : 'right' });
  }
  const bracket = buildEmptyBracket();
  const r = applyPairings(bracket, pairings);
  if (!r.ok) return r;
  return { ok: true, bracket, pairings };
}

function _shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = {
  buildEmptyBracket,
  applyPairings,
  decideMatch,
  buildFromTeams,
  repopulateNextRound,
};
