/**
 * Pub/sub minimo sobre WebSocket. Cada cliente que se conecta y manda
 * { type: 'subscribe' } se mete en el set; el server le pushea los
 * eventos del show en tiempo real.
 *
 * Patron prestado de TortillaTV (concursoSubscribers en server/index.js).
 */

const subscribers = new Set();

function add(ws) {
  subscribers.add(ws);
}

function remove(ws) {
  subscribers.delete(ws);
}

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of subscribers) {
    if (ws.readyState !== 1) {
      subscribers.delete(ws);
      continue;
    }
    try { ws.send(msg); } catch {}
  }
}

function size() { return subscribers.size; }

module.exports = { add, remove, broadcast, size };
