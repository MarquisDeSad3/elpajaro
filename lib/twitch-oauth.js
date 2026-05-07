/**
 * OAuth de Twitch para los DOS canales del show.
 *
 * Flujo:
 *   1. El host hace click en "Conectar Cuba" → GET /api/twitch/auth?from=cuba
 *      → 302 a id.twitch.tv con state=cuba
 *   2. El usuario autoriza en Twitch
 *   3. Twitch hace GET /api/twitch/callback?code=...&state=cuba
 *   4. Intercambiamos code -> access_token, fetch /helix/users para
 *      sacar broadcaster_id y broadcaster_login
 *   5. Llamamos onConnected(side, { token, broadcasterId, broadcasterLogin, name })
 *      — el server.js arranca el cliente IRC correspondiente
 *   6. Mismo flujo con state=pr
 *
 * Los tokens se guardan en memoria del modulo (no se persisten). Si el
 * server reinicia, ambos creadores tienen que reautorizar.
 */

const SCOPES = 'chat:read';   // por ahora solo leer chat. bits/cheers se puede agregar despues.

const tokens = {
  cuba: { accessToken: null, broadcasterId: null, broadcasterLogin: null, name: null },
  pr:   { accessToken: null, broadcasterId: null, broadcasterLogin: null, name: null },
};

let _onConnected = null;

function setOnConnected(fn) { _onConnected = fn; }

function getStatus() {
  return {
    cuba: { connected: !!tokens.cuba.accessToken, name: tokens.cuba.name, login: tokens.cuba.broadcasterLogin },
    pr:   { connected: !!tokens.pr.accessToken,   name: tokens.pr.name,   login: tokens.pr.broadcasterLogin },
  };
}

function _resolveRedirectUri(req) {
  const host = req.get('host');
  const proto = host.includes('localhost') || host.startsWith('127.') ? 'http' : 'https';
  return `${proto}://${host}/api/twitch/callback`;
}

function _normalizeSide(s) {
  const v = String(s || '').toLowerCase();
  return (v === 'cuba' || v === 'pr') ? v : null;
}

/**
 * Express handler: GET /api/twitch/auth?from=cuba|pr
 */
function authHandler(req, res) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) {
    return res.status(500).send('TWITCH_CLIENT_ID no esta configurado en .env');
  }
  const side = _normalizeSide(req.query.from);
  if (!side) {
    return res.status(400).send('Falta o es invalido el parametro from (cuba|pr)');
  }
  const redirectUri = _resolveRedirectUri(req);
  const url =
    `https://id.twitch.tv/oauth2/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&state=${encodeURIComponent(side)}` +
    `&force_verify=true`;     // siempre que hagan click vuelve a pedir login
  res.redirect(url);
}

/**
 * Express handler: GET /api/twitch/callback
 */
async function callbackHandler(req, res) {
  const code = req.query.code;
  const side = _normalizeSide(req.query.state);
  if (!side) {
    return res.status(400).send('State invalido o ausente.');
  }
  if (!code) {
    const err = req.query.error_description || req.query.error || 'sin codigo';
    return res.status(400).send('Twitch denego la autorizacion: ' + err);
  }
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).send('Faltan TWITCH_CLIENT_ID o TWITCH_CLIENT_SECRET en .env');
  }
  const redirectUri = _resolveRedirectUri(req);

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:
        `client_id=${encodeURIComponent(clientId)}` +
        `&client_secret=${encodeURIComponent(clientSecret)}` +
        `&code=${encodeURIComponent(code)}` +
        `&grant_type=authorization_code` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}`,
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('[TWITCH-OAUTH] token exchange failed:', tokenData);
      return res.status(500).send('Twitch no devolvio access_token: ' + JSON.stringify(tokenData));
    }

    // Sacar info del broadcaster
    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Client-Id': clientId },
    });
    const userData = await userRes.json();
    const u = userData.data?.[0];
    if (!u) {
      return res.status(500).send('No se pudo leer el usuario de Twitch.');
    }

    tokens[side] = {
      accessToken: tokenData.access_token,
      broadcasterId: u.id,
      broadcasterLogin: u.login,
      name: u.display_name || u.login,
    };

    console.log(`[TWITCH-OAUTH] ${side} conectado como ${u.display_name} (${u.login})`);

    if (_onConnected) {
      try { _onConnected(side, tokens[side]); }
      catch (e) { console.error('[TWITCH-OAUTH] onConnected error:', e.message); }
    }

    // Pagina de cierre con estilo cómic.
    const sideName = side === 'cuba' ? 'CUBA' : 'PUERTO RICO';
    const sideColor = side === 'cuba' ? '#0079d2' : '#ce1126';
    res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>El Pajaro — ${sideName} conectado</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bangers&family=Archivo+Black&display=swap" rel="stylesheet">
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0e0c1a; color: #fff; font-family: 'Archivo Black', sans-serif; }
  .box { text-align: center; padding: 48px 36px; border: 6px solid #fff; border-radius: 18px;
    background: ${sideColor}; box-shadow: 12px 12px 0 #000; max-width: 480px; }
  h1 { font-family: 'Bangers', cursive; font-size: 4rem; letter-spacing: 2px;
    margin: 0 0 12px; -webkit-text-stroke: 2px #000; }
  p { margin: 8px 0; font-size: 1.05rem; }
  small { display: block; margin-top: 18px; opacity: .7; font-family: sans-serif; }
</style></head>
<body><div class="box">
  <h1>${sideName}</h1>
  <p>Conectado como <strong>${u.display_name}</strong></p>
  <p>Ya podes cerrar esta ventana y volver al panel del host.</p>
  <small>Esta ventana se cierra sola en 3 segundos.</small>
</div>
<script>setTimeout(()=>{ try{window.close()}catch{} location.href='/host';}, 3000);</script>
</body></html>`);
  } catch (e) {
    console.error('[TWITCH-OAUTH] callback error:', e.message);
    res.status(500).send('Error en OAuth: ' + e.message);
  }
}

function getTokens(side) {
  const s = _normalizeSide(side);
  return s ? tokens[s] : null;
}

module.exports = { authHandler, callbackHandler, setOnConnected, getStatus, getTokens };
