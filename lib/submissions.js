/**
 * Logica de submissions publicas + moderacion + eliminacion fase 1.
 *
 * Wraps state.js. Aca van validaciones de URL, sanitizacion de campos,
 * deteccion de mediaType desde el host (yt/soundcloud/etc), y la maquina
 * de estados de cada submission:
 *
 *   pending  → approved → (eliminationDecision: passed → en lockedTeam, o rejected)
 *            ↘ rejected (queda fuera, no entra a fase 1)
 */

const crypto = require('crypto');
const stateMod = require('./state');

const NAME_MAX = 60;
const IG_MAX = 60;
const URL_MAX = 500;

function sanitizeText(s, max) {
  return String(s || '').replace(/<[^>]*>/g, '').trim().slice(0, max);
}

function sanitizeInstagram(raw) {
  const v = sanitizeText(raw, IG_MAX);
  if (!v) return '';
  return v.replace(/^@+/, '').replace(/[^A-Za-z0-9._]/g, '');
}

/**
 * Detecta tipo de media basado en el host del URL. NO descargamos nada —
 * el browser del overlay reproduce el URL directo.
 *
 * Para audio puro (Spotify/SoundCloud) no podemos embeberlo facilmente, asi
 * que devolvemos 'link' y el frontend muestra solo un boton "Escuchar"
 * que abre el URL en otra pestana.
 */
function detectMediaType(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  const host = u.host.toLowerCase().replace(/^www\./, '');

  // Plataformas de video con embed reconocido
  const videoHosts = [
    'youtube.com', 'youtu.be', 'm.youtube.com',
    'vimeo.com',
    'tiktok.com', 'vm.tiktok.com',
    'instagram.com',
    'facebook.com', 'fb.watch',
  ];
  if (videoHosts.some(h => host === h || host.endsWith('.' + h))) return 'video';

  // Plataformas de audio
  const audioHosts = ['soundcloud.com', 'on.soundcloud.com', 'spotify.com', 'open.spotify.com'];
  if (audioHosts.some(h => host === h || host.endsWith('.' + h))) return 'audio';

  // Drive / Dropbox / archivo directo: dejamos al frontend decidir (link)
  if (/\.(mp3|wav|ogg|m4a|flac)(\?.*)?$/i.test(u.pathname)) return 'audio';
  if (/\.(mp4|webm|mov|mkv)(\?.*)?$/i.test(u.pathname)) return 'video';

  return 'link';   // fallback — el frontend muestra "Abrir link"
}

function validateUrl(rawUrl) {
  const url = sanitizeText(rawUrl, URL_MAX);
  if (!url) return { ok: false, error: 'Falta el link.' };
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, error: 'Link invalido.' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'El link debe empezar con http o https.' };
  }
  return { ok: true, url, mediaType: detectMediaType(url) };
}

/**
 * Procesa un POST a /api/submit (publico, sin auth).
 * Devuelve { ok, error?, submission? }.
 */
function createSubmission({ country, name, instagram, mediaUrl, ip }) {
  if (country !== 'cuba' && country !== 'pr') {
    return { ok: false, error: 'Pais invalido.' };
  }
  if (!stateMod.isSubmissionsOpen(country)) {
    return { ok: false, error: 'Las inscripciones de ese pais estan cerradas.' };
  }
  if (stateMod.isCountryFull(country)) {
    return { ok: false, error: 'Las inscripciones de ese pais llegaron al cap. Gracias.' };
  }

  const cleanName = sanitizeText(name, NAME_MAX);
  if (!cleanName || cleanName.length < 2) {
    return { ok: false, error: 'Falta el nombre o es muy corto.' };
  }
  const cleanIg = sanitizeInstagram(instagram);

  const urlCheck = validateUrl(mediaUrl);
  if (!urlCheck.ok) return urlCheck;

  // 1 submission por IP — anti-spam basico. La IP no se expone en snapshot publico.
  const cleanIp = String(ip || '').slice(0, 64);
  if (cleanIp && stateMod.findIpSubmission(cleanIp)) {
    return { ok: false, error: 'Ya enviaste una inscripcion antes desde este equipo.' };
  }

  const sub = {
    id: crypto.randomBytes(10).toString('hex'),
    country,
    name: cleanName,
    instagram: cleanIg,
    mediaUrl: urlCheck.url,
    mediaType: urlCheck.mediaType,
    ip: cleanIp,
    status: 'pending',
    submittedAt: Date.now(),
    eliminationDecision: null,
    eliminationDecidedAt: null,
  };

  stateMod.addSubmission(sub);
  return { ok: true, submission: sub };
}

function listByCountry(country, statusFilter = null) {
  const out = [];
  for (const s of stateMod.state.submissions) {
    if (s.country !== country) continue;
    if (statusFilter && s.status !== statusFilter) continue;
    out.push(s);
  }
  out.sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0));
  return out;
}

function approve(id) {
  const s = stateMod.getSubmission(id);
  if (!s) return { ok: false, error: 'No encontrada.' };
  if (s.status === 'approved') return { ok: true, submission: s };
  stateMod.updateSubmission(id, { status: 'approved' });
  return { ok: true, submission: stateMod.getSubmission(id) };
}

function reject(id) {
  const s = stateMod.getSubmission(id);
  if (!s) return { ok: false, error: 'No encontrada.' };
  stateMod.updateSubmission(id, {
    status: 'rejected',
    eliminationDecision: null,
    eliminationDecidedAt: null,
  });
  return { ok: true };
}

/**
 * Decision de fase 1 (eliminacion). Solo aplica a submissions ya aprobadas.
 */
function decideElimination(id, decision) {
  if (!['passed', 'rejected'].includes(decision)) {
    return { ok: false, error: 'Decision invalida.' };
  }
  const s = stateMod.getSubmission(id);
  if (!s) return { ok: false, error: 'No encontrada.' };
  if (s.status !== 'approved') {
    return { ok: false, error: 'Hay que aprobarla antes para eliminar.' };
  }
  stateMod.updateSubmission(id, {
    eliminationDecision: decision,
    eliminationDecidedAt: Date.now(),
  });
  return { ok: true };
}

function clearElimination(id) {
  const s = stateMod.getSubmission(id);
  if (!s) return { ok: false, error: 'No encontrada.' };
  stateMod.updateSubmission(id, { eliminationDecision: null, eliminationDecidedAt: null });
  return { ok: true };
}

/**
 * Devuelve los IDs candidatos a entrar al equipo de un pais —
 * approved + eliminationDecision='passed'.
 */
function getPassedIds(country) {
  return stateMod.state.submissions
    .filter(s => s.country === country && s.status === 'approved' && s.eliminationDecision === 'passed')
    .map(s => s.id);
}

/**
 * Lock del equipo del pais. Recibe explicitamente los 8 IDs (el admin elige
 * cuales en modo manual; en modo eliminacion el frontend manda los 8 que
 * pasaron la fase 1).
 */
function lockTeam(country, ids) {
  if (!Array.isArray(ids) || ids.length !== 8) {
    return { ok: false, error: 'Tienen que ser exactamente 8.' };
  }
  // Validar que cada id existe, esta aprobado y es del pais correcto
  const set = new Set(ids);
  if (set.size !== 8) return { ok: false, error: 'Hay IDs duplicados.' };
  for (const id of ids) {
    const s = stateMod.getSubmission(id);
    if (!s) return { ok: false, error: `Submission ${id} no existe.` };
    if (s.country !== country) return { ok: false, error: `Submission ${id} no es de ${country}.` };
    if (s.status !== 'approved') return { ok: false, error: `Submission ${id} no esta aprobada.` };
  }
  stateMod.lockTeam(country, ids);
  return { ok: true };
}

module.exports = {
  createSubmission,
  listByCountry,
  approve,
  reject,
  decideElimination,
  clearElimination,
  getPassedIds,
  lockTeam,
  validateUrl,
  detectMediaType,
};
