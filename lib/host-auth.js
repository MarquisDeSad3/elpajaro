/**
 * Auth del panel de host: PIN -> token con TTL en memoria.
 *
 * Si el server reinicia, se pierde el set de tokens — el host tiene que
 * volver a entrar el PIN. Es aceptable porque el host esta presente
 * cuando arranca el show, no es un sistema multiusuario.
 *
 * Patron prestado de TortillaTV (server/concurso.js).
 */

const crypto = require('crypto');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map(); // token -> { createdAt, expiresAt }

setInterval(prune, 10 * 60 * 1000).unref?.();

function prune() {
  const now = Date.now();
  for (const [t, s] of sessions) if (now > s.expiresAt) sessions.delete(t);
}

function login(pin) {
  const expected = process.env.HOST_PIN;
  if (!expected) {
    console.error('[HOST-AUTH] HOST_PIN no esta seteado en .env');
    return null;
  }
  if (String(pin) !== String(expected)) return null;

  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, { createdAt: now, expiresAt: now + SESSION_TTL_MS });
  return token;
}

function validate(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return false; }
  return true;
}

function logout(token) {
  if (token) sessions.delete(token);
}

/**
 * Middleware-style helper para Express. Extrae token de body o query y
 * responde 401 si no validates. Devuelve true si pasa.
 */
function requireHost(req, res) {
  const token = String(req.body?.token || req.query?.token || '');
  if (!validate(token)) {
    res.status(401).json({ ok: false, error: 'host-auth-required' });
    return false;
  }
  return true;
}

module.exports = { login, validate, logout, requireHost };
