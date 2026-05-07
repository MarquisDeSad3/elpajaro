/**
 * Auth del panel: PIN unico (HOST_PIN) -> token con TTL en memoria.
 *
 * Cada login le asigna al token un `role` que el cliente declara: 'cuba',
 * 'pr' o 'master'. El role lo elige el admin al loguear (Pablo = cuba,
 * Kristoff = pr, alguno = master).
 *
 * El role no agrega seguridad — todos comparten el mismo PIN — pero permite:
 *   - Mostrar UI distinta segun quien se loguea
 *   - Implementar consenso 2-de-2 durante el bracket (necesitamos saber
 *     que UN token cubano y UN token PR votaron lo mismo para confirmar)
 *
 * Si el server reinicia se pierden los tokens (re-login).
 */

const crypto = require('crypto');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const VALID_ROLES = new Set(['cuba', 'pr', 'master']);
const sessions = new Map(); // token -> { role, createdAt, expiresAt }

setInterval(prune, 10 * 60 * 1000).unref?.();

function prune() {
  const now = Date.now();
  for (const [t, s] of sessions) if (now > s.expiresAt) sessions.delete(t);
}

function login(pin, role) {
  const expected = process.env.HOST_PIN;
  if (!expected) {
    console.error('[HOST-AUTH] HOST_PIN no esta seteado en .env');
    return null;
  }
  if (String(pin) !== String(expected)) return null;

  const cleanRole = VALID_ROLES.has(role) ? role : 'master';
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, { role: cleanRole, createdAt: now, expiresAt: now + SESSION_TTL_MS });
  return { token, role: cleanRole };
}

function validate(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  return { role: s.role };
}

function logout(token) {
  if (token) sessions.delete(token);
}

/**
 * Helper para Express. Si requiredRole es null, alcanza con cualquier session
 * valida (admin de cualquier rol). Si es 'cuba', 'pr' o 'master', exige ese rol
 * exacto. 'master' tambien acepta 'cuba'/'pr' como permission alta? No — cada
 * rol tiene su scope. Para acciones que cualquiera puede hacer pasamos null.
 */
function requireRole(req, res, requiredRole = null) {
  const token = String(req.body?.token || req.query?.token || '');
  const session = validate(token);
  if (!session) {
    res.status(401).json({ ok: false, error: 'auth-required' });
    return null;
  }
  if (requiredRole && session.role !== requiredRole) {
    res.status(403).json({ ok: false, error: `requires-role-${requiredRole}` });
    return null;
  }
  return session;
}

function listActiveRoles() {
  // Cuantas sesiones activas hay por rol (para que el master vea quien esta
  // adentro). No exponemos los tokens.
  const out = { cuba: 0, pr: 0, master: 0 };
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now > s.expiresAt) continue;
    if (out[s.role] != null) out[s.role]++;
  }
  return out;
}

module.exports = { login, validate, logout, requireRole, listActiveRoles };
