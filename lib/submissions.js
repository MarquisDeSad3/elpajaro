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

/**
 * Convierte un URL crudo de cualquier plataforma reconocida a su formato
 * EMBED (apto para meter en un iframe). Devuelve { kind, embedUrl, autoplayUrl }.
 *   - kind: 'iframe' (YouTube/Vimeo/TikTok/Spotify/SoundCloud/IG/FB)
 *           'video'  (archivo directo .mp4/.webm/.mov/.mkv)
 *           'audio'  (archivo directo .mp3/.wav/.ogg/.m4a/.flac)
 *           'link'   (no reconocido — el frontend muestra solo el link)
 *   - embedUrl: URL listo para meter en iframe.src o video.src/audio.src
 *   - autoplayUrl: variante con flag de autoplay (cuando el host pulsa "play")
 *
 * Para los iframes, "play" se hace seteando src=autoplayUrl, "pause"
 * se hace seteando src='' (limpia el iframe). Es un truco pero funciona
 * en todas las plataformas sin tener que tocar postMessage APIs distintas.
 */
function getEmbedInfo(rawUrl) {
  if (!rawUrl) return null;
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  const host = u.host.toLowerCase().replace(/^www\./, '');
  const path = u.pathname;
  const search = u.search;

  // ---- YouTube ----
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const id = u.searchParams.get('v') || extractYoutubeShortPath(path);
    if (id) return iframeEmbed(`https://www.youtube.com/embed/${id}?rel=0&modestbranding=1`, `&autoplay=1`);
  }
  if (host === 'youtu.be') {
    const id = path.replace(/^\//, '').split('/')[0];
    if (id) return iframeEmbed(`https://www.youtube.com/embed/${id}?rel=0&modestbranding=1`, `&autoplay=1`);
  }

  // ---- Vimeo ----
  if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
    const id = path.replace(/^\//, '').split('/')[0];
    if (/^\d+$/.test(id)) return iframeEmbed(`https://player.vimeo.com/video/${id}`, `?autoplay=1`);
  }

  // ---- TikTok ----
  // TikTok URL: tiktok.com/@user/video/12345 → embed.tiktok.com/v2/12345
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    const m = path.match(/\/video\/(\d+)/);
    if (m) return iframeEmbed(`https://www.tiktok.com/embed/v2/${m[1]}`, '');
    // Short links vm.tiktok.com/XXX no se pueden embed sin resolver. Devolvemos link.
    return { kind: 'link', embedUrl: rawUrl, autoplayUrl: rawUrl };
  }

  // ---- Instagram ----
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
    // /reel/CODE/ o /p/CODE/ → embed via /embed/
    const m = path.match(/\/(reel|p|tv)\/([^\/]+)/);
    if (m) return iframeEmbed(`https://www.instagram.com/${m[1]}/${m[2]}/embed/`, '');
  }

  // ---- Facebook ----
  if (host === 'facebook.com' || host === 'fb.watch') {
    return iframeEmbed(`https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(rawUrl)}&show_text=false`, '&autoplay=1');
  }

  // ---- Spotify ----
  if (host === 'open.spotify.com' || host === 'spotify.com') {
    // /track/ID, /episode/ID, /playlist/ID, /album/ID
    const m = path.match(/\/(track|episode|playlist|album)\/([^\/?]+)/);
    if (m) return iframeEmbed(`https://open.spotify.com/embed/${m[1]}/${m[2]}`, '');
  }

  // ---- SoundCloud ----
  if (host === 'soundcloud.com' || host === 'on.soundcloud.com') {
    const widgetUrl = `https://w.soundcloud.com/player/?url=${encodeURIComponent(rawUrl)}&color=%23ff5500&visual=true`;
    return iframeEmbed(widgetUrl, '&auto_play=true');
  }

  // ---- Archivos directos ----
  if (/\.(mp3|wav|ogg|m4a|flac)(\?.*)?$/i.test(path)) {
    return { kind: 'audio', embedUrl: rawUrl, autoplayUrl: rawUrl };
  }
  if (/\.(mp4|webm|mov|mkv)(\?.*)?$/i.test(path)) {
    return { kind: 'video', embedUrl: rawUrl, autoplayUrl: rawUrl };
  }

  // ---- Google Drive ----
  // drive.google.com/file/d/ID/view → drive.google.com/file/d/ID/preview
  if (host === 'drive.google.com') {
    const m = path.match(/\/file\/d\/([^\/]+)/);
    if (m) return iframeEmbed(`https://drive.google.com/file/d/${m[1]}/preview`, '');
  }

  // Fallback: link clickeable, no reproducible
  return { kind: 'link', embedUrl: rawUrl, autoplayUrl: rawUrl };
}

function iframeEmbed(baseUrl, autoplayQs) {
  return {
    kind: 'iframe',
    embedUrl: baseUrl,
    autoplayUrl: baseUrl + autoplayQs,
  };
}

function extractYoutubeShortPath(path) {
  // /shorts/ID o /embed/ID o /v/ID → ID
  const m = path.match(/\/(shorts|embed|v)\/([^\/?]+)/);
  return m ? m[2] : null;
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
  getEmbedInfo,
};
