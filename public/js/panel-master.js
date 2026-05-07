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
  let pollState = null;     // ultimo snapshot del voting activo (o null)
  let voteTimerInterval = null;

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
      if (m.type === 'state') {
        serverState = m.state;
        renderAll();
      } else if (m.type === 'voting-start' || m.type === 'voting-update' || m.type === 'voting-end') {
        pollState = m.poll;
        renderVotePanel();
        if (m.lastVote) addFloatingVote(m.lastVote);
        if (m.type === 'voting-end') {
          // Cerrar timer cuando termina el poll
          stopVoteTimer();
        }
      } else if (m.type === 'match-no-votes') {
        // El backend cerro el voto pero no llego ningun voto del chat —
        // el match quedo en idle de nuevo. Mostrar toast bien visible.
        toast('⚠️ ' + (m.message || 'Voto cerrado sin votos. Reabrir.'), 6000);
      }
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

  /* ===== Show running — bracket UI =====
   * Reemplaza el placeholder "EL SHOW EN VIVO" por la UI real del bracket:
   * - Active match box: el match en juego AHORA con LOS DOS VIDEOS embebidos
   *   (siempre en pausa — cada streamer aprieta play independientemente).
   * - Match list: todos los matches del bracket organizados por ronda.
   *
   * Flujo del LISTO button (solo en role-locked views /cuba y /pr):
   *   Match en idle    → LISTO 1 → ambos confirman → voting (chat vota)
   *   Match en voting  → LISTO 2 → ambos confirman → cierra y decide por mayoria
   *                       O alternativamente espera el timeout del timer.
   *
   * Los videos NO se sincronizan: cada streamer mira/escucha cuando quiere.
   * Lo unico que se sincroniza es la apertura/cierre del voto del chat.
   *
   * En vista publica /panel/master: solo se ve, no se interactua.
   */
  function renderShowRunning() {
    const running = !!serverState?.showStarted;
    $('stage-pre-show').classList.toggle('hidden', running);
    $('stage-show-running').classList.toggle('hidden', !running);
    if (!running) return;
    renderActiveMatch();
    renderBracketList();
  }

  function findNextPendingMatch() {
    if (!serverState?.bracket) return null;
    for (const round of serverState.bracket.rounds) {
      for (const m of round) {
        if (m.status !== 'done' && m.leftId && m.rightId) return m;
      }
    }
    return null;
  }

  function renderActiveMatch() {
    const cur = serverState?.currentMatch;
    let match, phase;
    if (cur) {
      match = findMatchById(cur.matchId);
      phase = cur.phase;
    } else {
      match = findNextPendingMatch();
      phase = 'idle';
    }
    if (!match) {
      $('active-match-box').style.display = 'none';
      return;
    }
    $('active-match-box').style.display = '';
    const cs = serverState.contestants || {};
    const a = cs[match.leftId];
    const b = cs[match.rightId];

    // Phase tag — solo 3 estados: idle (videos en pausa), voting (chat decide), result.
    // 'preview' ya no existe: los videos estan SIEMPRE embebidos en pausa
    // desde que el match es el active, los streamers le dan play cuando quieren.
    const tagText = phase === 'idle'    ? 'PRÓXIMO MATCH · MIRÁ AMBOS VIDEOS'
                  : phase === 'voting'  ? 'VOTANDO · CHAT DECIDE'
                  : phase === 'result'  ? 'GANADOR'
                                        : 'IDLE';
    $('active-phase-tag').textContent = tagText;

    // Side info
    fillSide('left',  a);
    fillSide('right', b);

    // LISTO button
    const btn = $('match-listo');
    const stepEl = $('match-listo-step');
    const labelEl = $('match-listo-label');
    const statusEl = $('match-listo-status');

    if (isPublicView) {
      btn.style.display = 'none';
      statusEl.innerHTML = `Vista pública — los streamers entran a <a href="/panel/master/cuba" style="color:var(--cuba-300);">/master/cuba</a> y <a href="/panel/master/pr" style="color:var(--pr-300);">/master/pr</a>`;
      return;
    }
    btn.style.display = '';
    const myRole = session?.role;
    const conf = serverState.matchConfirmations;
    const matchesCurrent = conf && conf.matchId === match.id && conf.phase === phase;
    const myConfirmed   = matchesCurrent && (myRole === 'cuba' ? conf.cubaConfirmed : conf.prConfirmed);
    const otherConfirmed = matchesCurrent && (myRole === 'cuba' ? conf.prConfirmed : conf.cubaConfirmed);

    // Texto del boton segun fase. Solo 2 transiciones (idle→voting→result):
    //   PASO 1: ambos vieron los videos en pausa → ABRIR VOTACION
    //   PASO 2: chat ya voto bastante → CERRAR VOTACION (autodecide por mayoria)
    const buttonByPhase = {
      idle:    { step: 'PASO 1 DE 2', label: '▶ LISTO — ABRIR VOTACIÓN' },
      voting:  { step: 'PASO 2 DE 2', label: '⏹ LISTO — CERRAR VOTACIÓN' },
    };
    const phaseUI = buttonByPhase[phase];
    if (phaseUI) {
      stepEl.textContent = phaseUI.step;
      labelEl.textContent = myConfirmed ? '✓ TU LISTO YA CONFIRMADO' : phaseUI.label;
    } else {
      stepEl.textContent = '—';
      labelEl.textContent = phase.toUpperCase();
    }
    btn.disabled = myConfirmed || phase === 'result';
    btn.dataset.matchId = match.id;
    btn.dataset.phase   = phase;

    // Status del lado opuesto
    const otherName = myRole === 'cuba' ? 'PR' : 'CUBA';
    const cubaPill = myConfirmed && myRole === 'cuba' || (matchesCurrent && conf.cubaConfirmed);
    const prPill   = myConfirmed && myRole === 'pr'   || (matchesCurrent && conf.prConfirmed);
    statusEl.innerHTML = `
      <div>
        <span class="ready-pill ${cubaPill ? 'ok' : 'no'}">CUBA ${cubaPill ? '✓' : '○'}</span>
        <span class="ready-pill ${prPill   ? 'ok' : 'no'}">PR ${prPill ? '✓' : '○'}</span>
      </div>
      ${myConfirmed && !otherConfirmed ? `<div style="margin-top:6px;">Esperando ${otherName}...</div>` : ''}
    `;
  }

  /**
   * Pinta UN lado del active match: header (pais/nombre/ig) + embed.
   *
   * El embed se monta UNA SOLA VEZ por contestant (trackeo via dataset.contestantId).
   * Esto es critico: cada vez que llega un broadcast del WS, renderActiveMatch
   * vuelve a correr — si recreamos el iframe en cada render, el video se
   * resetea a 0 y el streamer pierde lo que estaba escuchando. Solo
   * destruimos+recreamos cuando cambia el contestant (match siguiente).
   *
   * El src usado es c.clipEmbed (sin autoplay) para que el iframe arranque
   * pausado. Cada streamer le da play independientemente desde su browser.
   */
  function fillSide(side, c) {
    // Header
    $(`active-${side}-name`).textContent = c?.name || '?';
    $(`active-${side}-ig`).textContent = c?.bio || (c?.instagram ? '@' + c.instagram : '');
    const country = c?.country === 'cuba' ? 'CUBA' : c?.country === 'pr' ? 'PR' : '';
    const countryEl = $(`active-${side}-country`);
    countryEl.textContent = country;
    countryEl.classList.remove('cuba', 'pr');
    if (c?.country) countryEl.classList.add(c.country);

    // Embed (solo recrear si cambio el contestant — para no resetear el video)
    const wrap = $(`active-${side}-embed`);
    if (!wrap) return;
    const currentId = wrap.dataset.contestantId || '';
    const newId = c?.id || '';
    if (currentId === newId) return;
    wrap.dataset.contestantId = newId;
    wrap.innerHTML = '';
    if (!c) return;

    const kind = c.clipKind || (c.clipEmbed ? 'iframe' : 'link');
    if (kind === 'iframe' && c.clipEmbed) {
      const ifr = document.createElement('iframe');
      ifr.src = c.clipEmbed;  // version SIN autoplay → arranca pausado
      ifr.setAttribute('allow',
        'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
      ifr.setAttribute('allowfullscreen', '');
      ifr.referrerPolicy = 'strict-origin-when-cross-origin';
      ifr.loading = 'lazy';
      wrap.appendChild(ifr);
    } else if (kind === 'video' && c.clipUrl) {
      const v = document.createElement('video');
      v.src = c.clipUrl;
      v.controls = true;
      v.preload = 'metadata';
      wrap.appendChild(v);
    } else if (kind === 'audio' && c.clipUrl) {
      const a = document.createElement('audio');
      a.src = c.clipUrl;
      a.controls = true;
      a.preload = 'metadata';
      wrap.appendChild(a);
    } else {
      // Fallback: link externo (Drive raro / kind=link / sin clipEmbed)
      const link = document.createElement('a');
      link.href = c.clipUrl || c.mediaUrl || '#';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'link-fallback';
      link.textContent = '↗ ABRIR ENLACE EN PESTAÑA NUEVA';
      wrap.appendChild(link);
    }
  }

  function renderBracketList() {
    const root = $('bracket-list');
    root.innerHTML = '';
    if (!serverState?.bracket) return;
    const cs = serverState.contestants || {};
    const roundNames = ['OCTOFINALES', 'CUARTOS', 'SEMIFINALES', 'FINAL'];
    serverState.bracket.rounds.forEach((round, ri) => {
      const sec = document.createElement('div');
      sec.className = 'match-round';
      sec.innerHTML = `<h3>${roundNames[ri] || ('RONDA ' + (ri + 1))}</h3>`;
      round.forEach((m, mi) => {
        const a = cs[m.leftId];
        const b = cs[m.rightId];
        const aName = a?.name || (m.leftId ? '?' : 'TBD');
        const bName = b?.name || (m.rightId ? '?' : 'TBD');
        const isActive = m.status === 'active' || (serverState.currentMatch?.matchId === m.id);
        const cls = ['match-row'];
        if (isActive) cls.push('active');
        if (m.status === 'done') cls.push('done');
        const aCls = m.status === 'done' ? (m.winnerId === m.leftId ? 'winner' : 'loser') : '';
        const bCls = m.status === 'done' ? (m.winnerId === m.rightId ? 'winner' : 'loser') : '';
        const aCountryCls = a?.country === 'cuba' ? 'cuba' : a?.country === 'pr' ? 'pr' : '';
        const bCountryCls = b?.country === 'cuba' ? 'cuba' : b?.country === 'pr' ? 'pr' : '';

        const row = document.createElement('div');
        row.className = cls.join(' ');
        row.innerHTML = `
          <span class="num">#${mi + 1}</span>
          <span class="side ${aCountryCls} ${aCls}">${escapeHtml(aName)}</span>
          <span class="vs">vs</span>
          <span class="side ${bCountryCls} ${bCls}">${escapeHtml(bName)}</span>
        `;
        sec.appendChild(row);
      });
      root.appendChild(sec);
    });
  }

  function findMatchById(id) {
    if (!serverState?.bracket) return null;
    for (const round of serverState.bracket.rounds) {
      const m = round.find(x => x.id === id);
      if (m) return m;
    }
    return null;
  }

  // Click handler del LISTO button
  $('match-listo').addEventListener('click', async () => {
    if (isPublicView) return;
    const matchId = $('match-listo').dataset.matchId;
    const phase   = $('match-listo').dataset.phase;
    if (!matchId || !phase) return;
    try {
      await api('/api/match/confirm', { matchId, phase });
      toast('LISTO ✓');
    } catch (e) {
      toast(e.message);
    }
  });

  /* ===== Vote panel — barras + nombres flotantes + timer =====
   * Solo visible durante phase=voting del match activo. Escucha los
   * 3 eventos del WS: voting-start, voting-update (con lastVote para
   * la lluvia de nombres), y voting-end. */
  function renderVotePanel() {
    const panel = $('vote-panel');
    if (!panel) return;
    const cur = serverState?.currentMatch;
    const visible = !!(cur && cur.phase === 'voting' && pollState
                        && pollState.targetId === cur.matchId
                        && !pollState.ended);
    panel.classList.toggle('hidden', !visible);
    if (!visible) {
      stopVoteTimer();
      return;
    }

    // Labels con nombres reales del match (CUBA: Wow Popy / PR: Tego)
    const match = findMatchById(cur.matchId);
    const cs = serverState?.contestants || {};
    const left  = match ? cs[match.leftId]  : null;
    const right = match ? cs[match.rightId] : null;
    $('vote-left-label').textContent  = (left?.name  || 'IZQUIERDA').toUpperCase();
    $('vote-right-label').textContent = (right?.name || 'DERECHA').toUpperCase();

    // Barras + conteos
    updateBars(pollState);

    // Timer countdown
    if (cur.startedAt && cur.deadlineAt) {
      startVoteTimer(cur.startedAt, cur.deadlineAt);
    }
  }

  /**
   * Barra unica de pelea (estilo TortillaTV):
   *   - Izquierda crece desde la izquierda con el % de left/total
   *   - Derecha crece desde la derecha con el % de right/total
   *   - Si total=0, queda 50/50 (estado neutro)
   *   - Suman 100% siempre, asi visualmente "se pelean" el espacio
   * No hay desglose por canal de origen (cuba/pr) — eso es info interna,
   * la audiencia solo necesita ver quien va ganando.
   */
  function updateBars(poll) {
    if (!poll || !poll.totals) return;
    const t = poll.totals;
    const total = t.leftTotal + t.rightTotal;
    let leftPct, rightPct;
    if (total === 0) {
      leftPct = 50; rightPct = 50;
    } else {
      leftPct = (t.leftTotal / total) * 100;
      rightPct = 100 - leftPct;
    }
    const leftFill  = $('vote-left-fill');
    const rightFill = $('vote-right-fill');
    if (leftFill)  leftFill.style.width  = leftPct.toFixed(1) + '%';
    if (rightFill) rightFill.style.width = rightPct.toFixed(1) + '%';
    $('vote-left-total').textContent  = t.leftTotal;
    $('vote-right-total').textContent = t.rightTotal;
  }

  function startVoteTimer(startedAt, deadlineAt) {
    stopVoteTimer();
    const total = deadlineAt - startedAt;
    if (total <= 0) return;
    const fill = $('vote-timer-fill');
    const text = $('vote-timer-text');
    const tick = () => {
      const remaining = Math.max(0, deadlineAt - Date.now());
      const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
      if (fill) fill.style.width = pct + '%';
      if (text) text.textContent = Math.ceil(remaining / 1000) + 's';
      if (remaining <= 0) stopVoteTimer();
    };
    tick();
    voteTimerInterval = setInterval(tick, 200);
  }

  function stopVoteTimer() {
    if (voteTimerInterval) { clearInterval(voteTimerInterval); voteTimerInterval = null; }
  }

  /**
   * Lluvia de nombres: cada vez que llega un voto del chat, aparece un
   * pillon flotante con el username + color del canal de origen (cuba/pr),
   * en el lado correspondiente al voto (left/right). Animacion 2.6s y se
   * autodestruye.
   */
  function addFloatingVote(vote) {
    const rain = $('vote-rain');
    if (!rain || !vote || vote.user == null) return;
    // Solo mostrar si el panel esta visible (sino vamos llenando DOM al pedo)
    const panel = $('vote-panel');
    if (panel.classList.contains('hidden')) return;

    const el = document.createElement('span');
    el.className = 'name ' + (vote.origin === 'cuba' ? 'cuba' : 'pr');
    el.textContent = vote.user;
    // Posicion horizontal segun side (left/right del match)
    const xBase = vote.side === 'left' ? 12 : 64;
    el.style.left = (xBase + Math.random() * 16) + '%';
    el.style.bottom = (8 + Math.random() * 60) + '%';
    rain.appendChild(el);
    setTimeout(() => el.remove(), 2700);
  }

  /* ===== Twitch widgets =====
   * Reglas de visibilidad/permisos:
   *   /panel/master/cuba (Kristoff)  → solo widget CUBA, solo el puede tocar
   *   /panel/master/pr   (otro)      → solo widget PR, solo el puede tocar
   *   /panel/master      (publico)   → ambos widgets visibles, NO clickeables
   *
   * Por que: nadie tiene la cuenta de Twitch del otro. Kristoff no puede
   * conectar el chat de PR aunque vea el widget — y vice versa. Ocultar
   * el widget ajeno saca un boton inutil y deja claro de quien es la tarea.
   * En la vista publica los dos se ven como info read-only.
   */
  function renderTwitchWidgets() {
    const conns = serverState?.twitchConnections || {};
    const myRole = session?.role; // 'cuba' | 'pr' | 'master' | null (publico)

    for (const side of ['cuba', 'pr']) {
      const w = $(`tw-${side}`);
      if (!w) continue;
      const c = conns[side] || {};

      // Visibilidad: en role-locked solo se ve el widget propio.
      // En publico se ven ambos. (master con PIN unico tambien ve ambos
      // por compatibilidad, aunque el flujo "real" esta separado en /cuba y /pr.)
      const isMine = myRole === side || myRole === 'master';
      const visibleHere = isPublicView || isMine;
      w.style.display = visibleHere ? '' : 'none';

      // Click solo si es mio y no soy publico.
      // (El click handler global ya esta puesto, aca solo decidimos enable/disable
      // visualmente con cursor + atributo disabled-like.)
      if (isPublicView || !isMine) {
        w.disabled = true;
        w.style.cursor = 'default';
        w.title = isPublicView
          ? `Vista publica — ${side.toUpperCase()} conecta desde su URL`
          : `Solo el rol ${side.toUpperCase()} puede conectar este chat`;
      } else {
        w.disabled = false;
        w.style.cursor = 'pointer';
        w.title = `Conectar chat de Twitch (${side.toUpperCase()})`;
      }

      w.classList.toggle('live', !!c.connected);
      w.classList.toggle('off',  !c.connected);
      const statusEl = w.querySelector('.tw-status');
      if (statusEl) {
        statusEl.textContent = c.connected
          ? (c.name ? c.name.toUpperCase() : 'ON')
          : 'OFF';
      }
    }

    renderTwitchWarning();
  }

  /**
   * Warning grande cuando entras a phase=voting sin chats conectados.
   * Misma logica de permisos que los widgets: solo mostramos el boton de
   * conectar para el rol propio. Si el OTRO lado esta off, mostramos
   * "esperando que [otro] conecte" sin boton (no podemos hacer nada por el).
   */
  function renderTwitchWarning() {
    const warn = $('twitch-warning');
    if (!warn) return;
    const conns = serverState?.twitchConnections || {};
    const cur = serverState?.currentMatch;
    const inVoting = cur && cur.phase === 'voting';
    const cubaOff = !conns.cuba?.connected;
    const prOff   = !conns.pr?.connected;
    const myRole = session?.role;

    if (!inVoting || (!cubaOff && !prOff)) {
      warn.classList.add('hidden');
      return;
    }
    warn.classList.remove('hidden');

    // Mensaje + botones segun mi rol y que esta off
    let title, detail;
    const myOff    = (myRole === 'cuba' && cubaOff) || (myRole === 'pr' && prOff);
    const otherOff = (myRole === 'cuba' && prOff)   || (myRole === 'pr' && cubaOff);
    const otherName = myRole === 'cuba' ? 'PR' : 'CUBA';

    if (isPublicView) {
      // Vista publica: solo informa, sin botones
      const both = cubaOff && prOff;
      title = both ? 'AMBOS CHATS DESCONECTADOS'
                   : (cubaOff ? 'CHAT CUBA DESCONECTADO' : 'CHAT PR DESCONECTADO');
      detail = 'Cada streamer conecta el suyo desde su panel role-locked.';
    } else if (myOff && otherOff) {
      title = 'AMBOS CHATS DESCONECTADOS';
      detail = `Conectá tu chat (${myRole.toUpperCase()}). Esperando que ${otherName} conecte el suyo.`;
    } else if (myOff) {
      title = `TU CHAT (${myRole.toUpperCase()}) ESTA OFF`;
      detail = 'Conectá ya — sino tus votos no llegan.';
    } else if (otherOff) {
      title = `CHAT ${otherName} DESCONECTADO`;
      detail = `Esperando que ${otherName} conecte. Tu lado está OK.`;
    }

    $('twitch-warning-title').textContent = title;
    $('twitch-warning-detail').textContent = detail;

    // Botones: solo el del rol propio aparece, y solo si MI chat esta off.
    const showCubaBtn = !isPublicView && myRole === 'cuba' && cubaOff;
    const showPrBtn   = !isPublicView && myRole === 'pr'   && prOff;
    $('warn-connect-cuba').style.display = showCubaBtn ? '' : 'none';
    $('warn-connect-pr').style.display   = showPrBtn   ? '' : 'none';
  }

  function openTwitchAuth(side) {
    // El popup hace el OAuth dance y al volver, el server llama a
    // setTwitchConnection → broadcast → renderTwitchWidgets se actualiza.
    window.open(`/api/twitch/auth?from=${side}`, 'twitchAuth', 'width=720,height=820');
  }

  // Click handlers (definidos una vez al cargar). Los handlers chequean
  // permisos en runtime — aunque el widget este escondido o disabled,
  // un click programatico no hace nada si no es tu rol.
  ['cuba', 'pr'].forEach(side => {
    const btn = $(`tw-${side}`);
    if (btn) btn.addEventListener('click', () => {
      if (isPublicView) return;
      const myRole = session?.role;
      if (myRole !== side && myRole !== 'master') {
        toast(`Solo el rol ${side.toUpperCase()} puede conectar ese chat`);
        return;
      }
      openTwitchAuth(side);
    });
    const warnBtn = $(`warn-connect-${side}`);
    if (warnBtn) warnBtn.addEventListener('click', () => {
      if (isPublicView) return;
      const myRole = session?.role;
      if (myRole !== side && myRole !== 'master') return;
      openTwitchAuth(side);
    });
  });

  /* ===== Round transitions =====
   * Animacion cinematica cuando cambia la ronda activa del bracket.
   * Triggers detectados al comparar 2 broadcasts consecutivos del state:
   *   - showStarted flip false→true     → "OCTOFINALES"
   *   - activeRound avanza N → N+1      → nombre de la nueva ronda
   *   - todas las rondas done           → "¡CAMPEÓN!" + nombre del ganador
   *
   * Por que comparar prev vs cur en lugar de trackear con un solo idx:
   * si el panel se carga DURANTE el show, no queremos animar todas las
   * rondas pasadas — solo las que sucedan a partir de este momento.
   * Si _prevState es null (primer broadcast), no comparamos. */
  let _prevServerState = null;

  function activeRoundIdx(bracket) {
    if (!bracket?.rounds) return -1;
    for (let i = 0; i < bracket.rounds.length; i++) {
      if (bracket.rounds[i].some(m => m.status !== 'done')) return i;
    }
    return -1; // todas done = campeón
  }

  const ROUND_TITLES = ['OCTOFINALES', 'CUARTOS DE FINAL', 'SEMIFINALES', '¡LA FINAL!'];
  const ROUND_SUBS   = [
    '8 MATCHES · 16 CANTANTES',
    '4 MATCHES · 8 SOBREVIVEN',
    '2 MATCHES · 4 GUERREROS',
    'EL ÚLTIMO COMBATE',
  ];

  function detectRoundTransition() {
    const cur  = serverState;
    const prev = _prevServerState;
    if (!cur) return;

    // 1) Show recien arranco (flip false→true entre 2 broadcasts)
    if (cur.showStarted && prev && !prev.showStarted) {
      playRoundTransition(ROUND_TITLES[0], ROUND_SUBS[0]);
    }

    // 2) Cambio de ronda mientras show activo
    if (cur.showStarted && prev?.showStarted && cur.bracket && prev.bracket) {
      const curR  = activeRoundIdx(cur.bracket);
      const prevR = activeRoundIdx(prev.bracket);

      // Champion: todas las rondas done despues de no estarlo
      if (curR === -1 && prevR !== -1) {
        const champ = cur.contestants?.[cur.bracket.championId];
        const name = champ?.name ? champ.name.toUpperCase() : '';
        playRoundTransition('¡CAMPEÓN!', name, { variant: 'champion' });
      }
      // Avance de ronda: prev en N, ahora en N+1+
      else if (curR > prevR && prevR >= 0 && curR < ROUND_TITLES.length) {
        playRoundTransition(ROUND_TITLES[curR], ROUND_SUBS[curR]);
      }
    }

    _prevServerState = cur;
  }

  function playRoundTransition(text, subtitle, opts = {}) {
    playRoundFanfare();

    const overlay = document.createElement('div');
    overlay.className = 'round-transition' + (opts.variant ? ' ' + opts.variant : '');

    // 12 sparks que vuelan radialmente desde el centro
    let sparks = '';
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const dist = 240 + Math.random() * 120;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      const delay = Math.random() * 0.3;
      sparks += `<div class="rt-spark" style="--dx:${dx}px;--dy:${dy}px;animation-delay:${delay}s;"></div>`;
    }

    overlay.innerHTML = `
      <div class="rt-content">
        ${sparks}
        <div class="rt-text">${escapeHtml(text)}</div>
        ${subtitle ? `<div class="rt-sub">${escapeHtml(subtitle)}</div>` : ''}
      </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), 4300);
  }

  /**
   * Fanfare ascendente: 4 tonos C5→E5→G5→C6 con onda triangular (mas
   * cinematico que la sine pura del LISTO sound). Reusa _audioCtx.
   */
  function playRoundFanfare() {
    try {
      _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = _audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      const tone = (freq, startOffset, dur, vol = 0.16) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'triangle';
        osc.frequency.value = freq;
        const t0 = ctx.currentTime + startOffset;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(vol, t0 + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
        osc.start(t0);
        osc.stop(t0 + dur);
      };
      // Fanfare: C5, E5, G5, C6 stacked
      tone(523.25, 0,    0.32);
      tone(659.25, 0.16, 0.32);
      tone(783.99, 0.32, 0.42);
      tone(1046.50, 0.52, 0.85, 0.22);
    } catch {}
  }

  /* ===== Render ===== */
  function renderAll() {
    if (!serverState) return;
    detectRoundTransition();      // antes de renderizar — usa state nuevo vs viejo
    renderTwitchWidgets();
    renderSlots('cuba');
    renderSlots('pr');
    renderReady();
    renderShowRunning();
    renderVotePanel();
  }

  function escapeHtml(s) {
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  /* ===== Boot ===== */
  wsConnect();
  tryResume();
})();
