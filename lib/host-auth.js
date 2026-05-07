/**
 * Auth del panel: PIN unico (HOST_PIN) -> token con TTL en memoria.
 *
 * Cada login le asigna al token un `role` que el cliente declara: 'cuba',
 * 'pr' o 'master'. El role lo elige el admin al loguear segun el lado
 * que va a manejar.
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

/**
 * PINs separados por pais. El master entra con cualquiera de los dos
 * (es la pantalla compartida que miran ambos streamers).
 *
 * Fallback: si solo hay HOST_PIN seteado (deploy viejo), funciona como
 * antes para los 3 roles. Apenas se setea PIN_CUBA o PIN_PR, ese rol
 * exige su pin propio.
 */
function login(pin, role) {
  const cleanRole = VALID_ROLES.has(role) ? role : 'master';
  const provided = String(pin || '');
  if (!provided) return null;

  const pinCuba   = process.env.PIN_CUBA  || '';
  const pinPr     = process.env.PIN_PR    || '';
  const pinMaster = process.env.PIN_MASTER || '';
  const pinFallback = process.env.HOST_PIN || '';

  let accepts = [];
  if (cleanRole === 'cuba')   accepts = [pinCuba   || pinFallback];
  if (cleanRole === 'pr')     accepts = [pinPr     || pinFallback];
  if (cleanRole === 'master') {
    // master acepta CUALQUIERA de los pines de pais (pantalla compartida).
    // Si hay pin master propio tambien lo acepta.
    accepts = [pinMaster, pinCuba, pinPr, pinFallback].filter(Boolean);
  }
  accepts = accepts.filter(Boolean);
  if (accepts.length === 0) {
    console.error('[HOST-AUTH] no hay pin configurado para rol', cleanRole);
    return null;
  }
  if (!accepts.some(p => p === provided)) return null;

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
