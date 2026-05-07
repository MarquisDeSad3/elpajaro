/**
 * Panel master — pantalla compartida para los dos streamers.
 *
 * Pre-show:
 *   - 8 slots Cuba + 8 slots PR (se llenan en tiempo real cuando cada
 *     streamer pasa cantantes en su /panel/cuba o /panel/pr).
 *   - Boton "ESTOY LISTO" por lado:
 *       · habilitado SOLO cuando ese lado tiene los 8 lockeados
 *       · clickeable SOLO por el rol que matchea (cuba session puede
 *         tocar el de Cuba; pr session el de PR; master se logueo con
 *         alguno de los dos PINs y solo puede tocar el del PIN que uso)
 *   - Cuando ambos lados quedan ready=true, el server arranca el show solo.
 *
 * Show running:
 *   - Mensaje + links a /show, /panel/cuba, /panel/pr
 */

(() => {
  'use strict';

  // 3 modos segun la URL:
  //   /panel/master/cuba  → role-locked CUBA (PIN + boton activo de Cuba)
  //   /panel/master/pr    → role-locked PR
  //   /panel/master       → vista publica read-only (SIN PIN, SIN botones)
  //                         solo muestra el estado actual del show.
  const targetRole = location.pathname.endsWith('/cuba') ? 'cuba'
                   : location.pathname.endsWith('/pr')   ? 'pr'
                   : null;
  const isPublicView = !targetRole;

  const TOKEN_KEY = 'elpajaro.token.master.' + (targetRole || 'shared');
  const PIN_KEY = TOKEN_KEY + '.pin';
  let token = localStorage.getItem(TOKEN_KEY) || null;
  let savedPin = localStorage.getItem(PIN_KEY) || null;
  let session = null;       // { role: 'cuba'|'pr'|'master' } o null en publico
  let serverState = null;

  // Customizar la pantalla de login segun el targetRole
  if (targetRole) {
    document.title = `Master ${targetRole.toUpperCase()} · El Pajaro`;
    const loginH2 = document.querySelector('#login-screen h2');
    const loginP  = document.querySelector('#login-screen p');
    if (loginH2) loginH2.textContent = targetRole === 'cuba' ? 'MASTER · CUBA' : 'MASTER · PR';
    if (loginP)  loginP.textContent  = targetRole === 'cuba'
      ? 'Solo Kristoff (PIN de Cuba). Tu boton ESTOY LISTO va a estar activo.'
      : 'Solo el streamer PR (PIN de PR). Tu boton ESTOY LISTO va a estar activo.';
  } else {
    // Vista publica — esconder cosas interactivas, mostrar CTA con URLs reales
    document.title = 'Master · El Pajaro';
  }

  const $ = (id) => document.getElementById(id);

  /* ===== WS ===== */
  let ws, reconnectTimer;
  function wsConnect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onclose = () => { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(wsConnect, 2000); };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'state') { serverState = m.state; renderAll(); }
    };
  }

  /* ===== API ===== */
  async function api(path, body, method = 'POST') {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify({ ...body, token });
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { logout(true); throw new Error('Sesion vencida'); }
    if (!data.ok) throw new Error(data.error || 'Error');
    return data;
  }

  function toast(msg, ms = 2400) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), ms);
  }

  /**
   * Beep sintetizado via Web Audio API (sin assets, sin descargas).
   * Dos tonos: A5 (880Hz) → E6 (1320Hz). Brevemente, suave, no agresivo.
   * Si el browser bloquea (sin user gesture previo), falla silenciosamente.
   */
  let _audioCtx = null;
  function playReadySound() {
    try {
      _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = _audioCtx;
      // Resume si esta suspendido (algunos browsers requieren gesture)
      if (ctx.state === 'suspended') ctx.resume();
      const tone = (freq, startOffset, dur, vol = 0.18) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t0 = ctx.currentTime + startOffset;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(vol, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
        osc.start(t0);
        osc.stop(t0 + dur);
      };
      tone(880,  0,    0.20);
      tone(1320, 0.12, 0.30);
    } catch {}
  }

  /* ===== Login =====
   * El master no sabe de antemano quien es el que se loguea — acepta los
   * dos PINs (cuba y pr) y el server le devuelve el rol asociado al pin
   * que el cliente envio. Probamos primero con role='cuba'; si falla,
   * probamos con 'pr'. Ese intento doble es el costo de tener un solo
   * input de PIN para una pantalla compartida.
   */
  // Login: si targetRole esta seteado por URL, intenta solo ese rol.
  // Si no (ruta /panel/master generica), prueba los 3 en orden.
  async function doLogin(pin) {
    const rolesToTry = targetRole ? [targetRole] : ['cuba', 'pr', 'master'];
    for (const tryRole of rolesToTry) {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, role: tryRole }),
      });
      const data = await res.json();
      if (data.ok && data.token) {
        token = data.token;
        session = { role: data.role };
        savedPin = pin;
        localStorage.setItem(TOKEN_KEY, token);
        localStorage.setItem(PIN_KEY, pin);
        serverState = data.state;
        return data;
      }
    }
    throw new Error(targetRole
      ? `Ese PIN no es del lado ${targetRole.toUpperCase()}. Esta URL solo acepta PIN ${targetRole === 'cuba' ? 'de Cuba' : 'de PR'}.`
      : 'PIN incorrecto.');
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    try {
      await doLogin($('pin').value);
      if (session) setRoleTag(session.role);
      showMain();
    } catch (e) { $('login-error').textContent = e.message; }
  });

  function logout(silentAndKeepPin = false) {
    if (!silentAndKeepPin) {
      api('/api/admin/logout', {}).catch(() => {});
      localStorage.removeItem(PIN_KEY);
      savedPin = null;
    }
    localStorage.removeItem(TOKEN_KEY);
    token = null; session = null;
    showLogin();
  }
  $('btn-logout').addEventListener('click', () => logout(false));

  function showLogin() { $('login-screen').classList.remove('hidden'); $('main-panel').classList.add('hidden'); }
  function showMain()  { $('login-screen').classList.add('hidden'); $('main-panel').classList.remove('hidden'); renderAll(); }

  function setRoleTag(role) {
    const tag = document.querySelector('.role-tag');
    if (!tag) return;
    tag.textContent = role.toUpperCase();
    tag.classList.remove('role-cuba', 'role-pr', 'role-master');
    tag.classList.add('role-' + role);
  }

  async function tryResume() {
    // VISTA PUBLICA: sin login, sin botones. Solo muestra el estado del show.
    // Los datos vienen del WS broadcast (que no incluye info sensible) +
    // un fetch inicial via /api/state.
    if (isPublicView) {
      try {
        const res = await fetch('/api/state');
        const data = await res.json();
        serverState = data.state;
      } catch {}
      showMainPublic();
      return;
    }
    // ROLE-LOCKED: necesita login.
    // 1) Token guardado: intentar validar
    if (token) {
      try {
        const r = await api('/api/admin/validate', {});
        if (targetRole && r.role !== targetRole) {
          logout(false);
          return;
        }
        session = { role: r.role };
        serverState = r.state;
        setRoleTag(r.role);
        showMain();
        return;
      } catch { /* token invalido — caer al PIN */ }
    }
    // 2) PIN guardado: re-login automatico
    if (savedPin) {
      try {
        await doLogin(savedPin);
        if (session) setRoleTag(session.role);
        showMain();
        return;
      } catch {
        localStorage.removeItem(PIN_KEY);
        savedPin = null;
      }
    }
    // 3) Sin nada — login
    showLogin();
  }

  // Vista publica: muestra los slots y status, esconde botones de accion.
  function showMainPublic() {
    $('login-screen').classList.add('hidden');
    $('main-panel').classList.remove('hidden');
    // Esconder botones de accion + reemplazarlos por CTA con URLs reales
    const btnCuba = $('ready-cuba');
    const btnPr   = $('ready-pr');
    if (btnCuba) btnCuba.style.display = 'none';
    if (btnPr)   btnPr.style.display = 'none';
    // Esconder el boton Salir
    const btnLogout = $('btn-logout');
    if (btnLogout) btnLogout.style.display = 'none';
    // Reemplazar role-tag por badge de "VISTA PUBLICA"
    const tag = document.querySelector('.role-tag');
    if (tag) {
      tag.textContent = 'VISTA PÚBLICA';
      tag.classList.remove('role-cuba', 'role-pr', 'role-master');
      tag.style.background = 'rgba(255,255,255,.12)';
      tag.style.color = 'var(--text)';
    }
    // Reemplazar el ready-status por un CTA hacia las URLs role-locked
    const status = $('ready-status');
    if (status) {
      status.innerHTML = `
        <div style="text-align:center; line-height: 1.7; color: var(--text-soft); font-size: .85rem;">
          <strong style="color: var(--gold); display:block; margin-bottom: 8px;">Vista pública (solo lectura)</strong>
          Los streamers entran desde sus URLs:<br/>
          <a href="/panel/master/cuba" style="color: var(--cuba-300); text-decoration: underline;">Kristoff → /panel/master/cuba</a><br/>
          <a href="/panel/master/pr"   style="color: var(--pr-300);   text-decoration: underline;">PR → /panel/master/pr</a>
        </div>
      `;
    }
    renderAll();
  }

  /* ===== Render slots =====
   * lockedTeam ahora viene del snapshot como array de objetos con
   * { id, name, instagram, clipThumbnail, clipKind, ... } — no solo IDs.
   * Asi el master puede mostrar miniatura + nombre en cada slot apenas
   * el streamer cierra su equipo (sin esperar a que arranque el show). */
  function renderSlots(country) {
    const c = serverState?.countries?.[country];
    const grid = $(`slots-${country}`);
    grid.innerHTML = '';
    const team = c?.lockedTeam || [];
    for (let i = 0; i < 8; i++) {
      const finalist = team[i];   // objeto o undefined
      const slot = document.createElement('div');
      slot.className = 'slot ' + (finalist ? 'filled ' + country : 'empty');
      if (finalist) {
        const thumb = finalist.clipThumbnail
          ? `<img class="slot-thumb" src="${escapeHtml(finalist.clipThumbnail)}" alt="" loading="lazy" onerror="this.style.display='none'">`
          : '';
        slot.innerHTML = `
          <div class="num">${i + 1}</div>
          ${thumb}
          <div class="slot-info">
            <div class="name">${escapeHtml(finalist.name || 'FINALISTA')}</div>
            ${finalist.instagram ? `<div class="ig">@${escapeHtml(finalist.instagram)}</div>` : ''}
          </div>
        `;
      } else {
        slot.innerHTML = `<div class="num">${i + 1}</div><div class="name">—</div>`;
      }
      grid.appendChild(slot);
    }

    // Stage status text
    const statusEl = $(`${country}-status`);
    if (c?.ready) {
      statusEl.innerHTML = `<span style="color:#5fea9f;">✓ LISTO PARA EL SHOW</span>`;
    } else if (c?.teamLocked) {
      statusEl.innerHTML = `8/8 elegidos · esperando "ESTOY LISTO"`;
    } else {
      const passed = c?.counts?.passed || 0;
      statusEl.innerHTML = `${passed}/8 pasados — siguen las eliminaciones`;
    }
  }

  /* ===== Ready buttons ===== */
  // Tracker para detectar transicion false→true del rol opuesto
  let _prevReady = { cuba: false, pr: false };

  function renderReady() {
    const cuba = serverState?.countries?.cuba;
    const pr   = serverState?.countries?.pr;
    const myRole = session?.role;

    // Detectar: el OTRO lado se acaba de poner listo y yo todavia no?
    // Solo en vistas role-locked (cuando hay session.role)
    if (!isPublicView && myRole) {
      const cubaJustReady = cuba?.ready && !_prevReady.cuba;
      const prJustReady   = pr?.ready   && !_prevReady.pr;
      if (cubaJustReady && myRole === 'pr' && !pr?.ready) {
        notifyOtherReady('CUBA', 'pr');
      }
      if (prJustReady && myRole === 'cuba' && !cuba?.ready) {
        notifyOtherReady('PR', 'cuba');
      }
      _prevReady = { cuba: !!cuba?.ready, pr: !!pr?.ready };
    }

    const btnCuba = $('ready-cuba');
    const btnPr   = $('ready-pr');

    // Cuba button
    const cubaCanReady = !!cuba?.teamLocked;
    const cubaIsReady  = !!cuba?.ready;
    const cubaIsMine   = myRole === 'cuba' || (myRole === 'master');
    btnCuba.disabled = !cubaCanReady || !cubaIsMine;
    btnCuba.classList.toggle('is-ready', cubaIsReady);
    btnCuba.querySelector('.ready-main').textContent = cubaIsReady ? '✓ CUBA LISTO' : 'ESTOY LISTO';

    // PR button
    const prCanReady = !!pr?.teamLocked;
    const prIsReady  = !!pr?.ready;
    const prIsMine   = myRole === 'pr' || (myRole === 'master');
    btnPr.disabled = !prCanReady || !prIsMine;
    btnPr.classList.toggle('is-ready', prIsReady);
    btnPr.querySelector('.ready-main').textContent = prIsReady ? '✓ PR LISTO' : 'ESTOY LISTO';

    // Status helper
    const statusEl = $('ready-status');
    if (cubaIsReady && prIsReady) {
      statusEl.innerHTML = `<span style="color: var(--gold);">¡VAMOS! Arrancando bracket…</span>`;
    } else if (!cuba?.teamLocked && !pr?.teamLocked) {
      statusEl.innerHTML = `Cada streamer cierra sus 8 desde su panel y después confirma acá.`;
    } else if (cuba?.teamLocked && !pr?.teamLocked) {
      statusEl.innerHTML = `Cuba lista. Esperando que PR cierre los suyos.`;
    } else if (!cuba?.teamLocked && pr?.teamLocked) {
      statusEl.innerHTML = `PR lista. Esperando que Cuba cierre los suyos.`;
    } else if (cubaIsReady && !prIsReady) {
      statusEl.innerHTML = `Cuba dijo listo. Esperando confirmación de PR.`;
    } else if (!cubaIsReady && prIsReady) {
      statusEl.innerHTML = `PR dijo listo. Esperando confirmación de Cuba.`;
    } else {
      statusEl.innerHTML = `Los dos lados con 8 elegidos. Click "ESTOY LISTO" cuando estés listo.`;
    }
  }

  $('ready-cuba').addEventListener('click', () => proposeReady('cuba'));
  $('ready-pr').addEventListener('click', () => proposeReady('pr'));

  /**
   * Notificacion cuando el OTRO lado se confirma listo y vos todavia no.
   * Sonido + pulso fuerte en tu boton + toast grande.
   */
  function notifyOtherReady(otherName, myRoleSide) {
    playReadySound();
    const myBtn = myRoleSide === 'cuba' ? $('ready-cuba') : $('ready-pr');
    if (myBtn) {
      myBtn.classList.add('notify-pulse');
      setTimeout(() => myBtn.classList.remove('notify-pulse'), 4500);
    }
    toast(`✨ ${otherName} LISTO — ahora vos`, 5000);
  }

  async function proposeReady(country) {
    const current = !!serverState?.countries?.[country]?.ready;
    try {
      const r = await api(`/api/admin/${country}/ready`, { ready: !current });
      if (r.showStarted) toast('🏆 Show empezando');
      else toast(r.ready ? `${country.toUpperCase()} listo` : `${country.toUpperCase()} cancelado`);
    } catch (e) { toast(e.message); }
  }

  /* ===== Show running ===== */
  function renderShowRunning() {
    const running = !!serverState?.showStarted;
    $('stage-pre-show').classList.toggle('hidden', running);
    $('stage-show-running').classList.toggle('hidden', !running);
  }

  /* ===== Render ===== */
  function renderAll() {
    if (!serverState) return;
    renderSlots('cuba');
    renderSlots('pr');
    renderReady();
    renderShowRunning();
  }

  function escapeHtml(s) {
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  /* ===== Boot ===== */
  wsConnect();
  tryResume();
})();
