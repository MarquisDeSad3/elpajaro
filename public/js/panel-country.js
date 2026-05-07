/**
 * Panel cuba/pr — UN solo JS para los dos paises (rol detectado por
 * location.pathname). Layout estilo TortillaTV /concurso: pantalla de
 * menu con 3 cards principales que drillean a sub-screens.
 *
 * Screens:
 *   menu     - 3 cards: VER ENVIADOS / CREAR MANUAL / EMPEZAR
 *   queue    - moderacion de submissions (pending/approved/rejected)
 *   manual   - tildar 8 desde aprobadas
 *   elim     - fase 1 con chat poll por card
 *   closed   - los 8 estan lockeados, mostrar resumen + ir a master
 */

(() => {
  'use strict';

  const role = location.pathname.includes('/cuba') ? 'cuba' : 'pr';
  const TOKEN_KEY = `elpajaro.token.${role}`;
  const COUNTRY_NAME = role === 'cuba' ? 'CUBA' : 'PUERTO RICO';

  document.title = `Panel ${COUNTRY_NAME} · El Pajaro`;
  document.getElementById('login-title').textContent = `PANEL ${COUNTRY_NAME}`;

  const panelTitle = document.getElementById('panel-title');
  panelTitle.textContent = `EL PAJARO · ${COUNTRY_NAME}`;
  panelTitle.style.background = role === 'cuba' ? 'var(--cuba-grad)' : 'var(--pr-grad)';
  panelTitle.style.webkitBackgroundClip = 'text';
  panelTitle.style.backgroundClip = 'text';
  panelTitle.style.webkitTextFillColor = 'transparent';

  const roleTag = document.getElementById('role-tag');
  roleTag.textContent = COUNTRY_NAME;
  roleTag.classList.toggle('role-cuba', role === 'cuba');
  roleTag.classList.toggle('role-pr', role === 'pr');

  let token = localStorage.getItem(TOKEN_KEY) || null;
  let serverState = null;
  let pollState = null;
  let countryItems = [];     // submissions del pais
  let openModalCardId = null;
  let teamSelection = new Set();
  let queueFilter = 'pending';
  let modalTimerInterval = null;

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
        const wasShowStarted = serverState?.showStarted;
        serverState = m.state;
        renderAll();
        // Si apenas arrancan el show, redirigimos a master (los streamers
        // controlan match flow desde sus paneles via pasos posteriores)
        if (!wasShowStarted && serverState.showStarted) {
          toast('🏆 ¡Show empezado! Yendo a master...', 1800);
          setTimeout(() => location.href = '/panel/master', 1800);
        }
      } else if (m.type === 'voting-start' || m.type === 'voting-update' || m.type === 'voting-end') {
        pollState = m.poll;
        if (m.type === 'voting-start') pollState._tick = Date.now();
        renderModalPoll();
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

  /* ===== Login ===== */
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = $('pin').value;
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, role }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'PIN incorrecto');
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      serverState = data.state;
      showMain();
      await refreshList();
    } catch (e) { $('login-error').textContent = e.message; }
  });

  function logout(silent = false) {
    if (!silent) api('/api/admin/logout', {}).catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    token = null;
    showLogin();
  }
  $('btn-logout').addEventListener('click', () => logout());

  function showLogin() { $('login-screen').classList.remove('hidden'); $('main-panel').classList.add('hidden'); }
  function showMain()  { $('login-screen').classList.add('hidden'); $('main-panel').classList.remove('hidden'); renderAll(); }

  async function tryResume() {
    if (!token) { showLogin(); return; }
    try {
      const r = await api('/api/admin/validate', {});
      if (r.role !== role) { logout(true); return; }
      serverState = r.state;
      showMain();
      await refreshList();
    } catch { showLogin(); }
  }

  /* ===== Screen routing ===== */
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(`screen-${name}`)?.classList.add('active');
  }
  document.querySelectorAll('[data-go]').forEach(btn => {
    btn.addEventListener('click', () => {
      // Si el equipo ya esta lockeado, "manual" y "elim" no tienen sentido — vamos a closed
      const locked = serverState?.countries?.[role]?.teamLocked;
      const target = btn.dataset.go;
      if (locked && (target === 'manual' || target === 'elim')) {
        showScreen('closed'); return;
      }
      showScreen(target);
    });
  });
  document.querySelectorAll('[data-back]').forEach(btn => {
    btn.addEventListener('click', () => showScreen(decideHome()));
  });
  function decideHome() {
    return serverState?.countries?.[role]?.teamLocked ? 'closed' : 'menu';
  }

  /* ===== Twitch widget ===== */
  $('twitch-widget').addEventListener('click', () => {
    window.open(`/api/twitch/auth?from=${role}`, 'twitchAuth', 'width=720,height=820');
  });

  function renderTwitchWidget() {
    const tw = serverState?.twitchConnections?.[role];
    const w = $('twitch-widget');
    const lab = $('twitch-label');
    if (tw?.connected) {
      w.classList.add('live');
      lab.textContent = tw.name ? `${tw.name.toUpperCase()}` : 'TWITCH ON';
    } else {
      w.classList.remove('live');
      lab.textContent = 'CONECTAR TWITCH';
    }
  }

  /* ===== Refresh submissions list ===== */
  async function refreshList() {
    try {
      const r = await api(`/api/admin/${role}/list`, {});
      countryItems = r.items || [];
      renderAll();
    } catch (e) { toast(e.message); }
  }
  setInterval(() => {
    if (token && document.visibilityState === 'visible') refreshList().catch(() => {});
  }, 5000);

  /* ===== Menu screen ===== */
  function renderMenu() {
    if (!serverState) return;
    const c = serverState.countries[role];
    const cap = serverState.submissionsCap || 50;
    $('m-total').textContent    = c.counts.total;
    $('m-cap').textContent      = cap;
    $('m-pending').textContent  = c.counts.pending;
    $('m-approved').textContent = c.counts.approved;
    $('m-rejected').textContent = c.counts.rejected;
    $('m-passed').textContent   = c.counts.passed;
    $('m-locked').textContent   = c.teamLocked ? 'EQUIPO' : 'no';
    $('m-locked-chip').style.color = c.teamLocked ? 'var(--gold)' : '';

    $('menu-pending-count').textContent = c.counts.pending;
    $('menu-pending-count').style.display = c.counts.pending > 0 ? 'inline-flex' : 'none';

    // Toggle subs button
    $('m-toggle-subs').textContent = c.submissionsOpen ? 'Cerrar inscripciones' : 'Abrir inscripciones';
    $('m-toggle-subs').classList.toggle('btn-danger', c.submissionsOpen);

    // Disable manual/elim cards if locked
    document.querySelectorAll('[data-go="manual"], [data-go="elim"]').forEach(card => {
      card.classList.toggle('disabled', c.teamLocked);
    });
  }

  $('m-toggle-subs').addEventListener('click', async () => {
    const c = serverState?.countries?.[role];
    if (!c) return;
    try {
      await api(`/api/admin/${role}/submissions-toggle`, { open: !c.submissionsOpen });
    } catch (e) { toast(e.message); }
  });

  /* ===== Queue (moderation) ===== */
  document.querySelectorAll('.filter-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      queueFilter = btn.dataset.filter;
      renderQueue();
    });
  });

  function renderQueue() {
    const pending  = countryItems.filter(s => s.status === 'pending');
    const approved = countryItems.filter(s => s.status === 'approved');
    const rejected = countryItems.filter(s => s.status === 'rejected');
    $('f-pending').textContent  = pending.length;
    $('f-approved').textContent = approved.length;
    $('f-rejected').textContent = rejected.length;

    const arr = queueFilter === 'pending' ? pending
              : queueFilter === 'approved' ? approved
              : rejected;
    const list = $('queue-list');
    if (!arr.length) {
      list.innerHTML = `<div style="text-align:center; padding:40px; color: var(--muted); font-style: italic;">— sin ${queueFilter} —</div>`;
      return;
    }
    list.innerHTML = arr.map((s, i) => `
      <div class="sub-item" data-id="${s.id}">
        <div class="num">${i + 1}</div>
        <div class="meta">
          <div class="name">${escapeHtml(s.name)}</div>
          <div class="ig">${s.instagram ? '@' + escapeHtml(s.instagram) : '—'} · ${escapeHtml(s.mediaType || 'link')}</div>
          <a class="url" href="${escapeAttr(s.mediaUrl)}" target="_blank" rel="noopener">${escapeHtml(s.mediaUrl)}</a>
        </div>
        <div class="actions">
          ${s.status === 'pending'  ? `<button class="btn btn-success btn-sm" data-act="approve">✓ Aprobar</button>
                                       <button class="btn btn-danger btn-sm"  data-act="reject">✗ Rechazar</button>` : ''}
          ${s.status === 'approved' ? `<span class="badge badge-green">APROBADA</span>
                                       <button class="btn btn-ghost btn-sm" data-act="reject">Rechazar</button>` : ''}
          ${s.status === 'rejected' ? `<span class="badge badge-gray">RECHAZADA</span>
                                       <button class="btn btn-ghost btn-sm" data-act="approve">Re-aprobar</button>` : ''}
        </div>
      </div>
    `).join('');
    list.querySelectorAll('.sub-item .actions button').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.sub-item').dataset.id;
        const act = btn.dataset.act;
        try { await api(`/api/admin/${role}/${act}`, { id }); toast(act === 'approve' ? 'Aprobada ✓' : 'Rechazada'); await refreshList(); }
        catch (e) { toast(e.message); }
      });
    });
  }

  /* ===== Manual (pick 8 from approved) ===== */
  function renderManual() {
    const c = serverState?.countries?.[role];
    if (c?.teamLocked) { showScreen('closed'); return; }
    const approved = countryItems.filter(s => s.status === 'approved');
    // Pre-poblar con los que ya pasaron eliminacion si la seleccion esta vacia
    if (teamSelection.size === 0) {
      const passedIds = approved.filter(s => s.eliminationDecision === 'passed').map(s => s.id);
      teamSelection = new Set(passedIds.slice(0, 8));
    }
    const grid = $('manual-grid');
    if (!approved.length) {
      grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:30px; color: var(--muted);">No hay submissions aprobadas todavía.</div>';
      $('manual-count').textContent = teamSelection.size;
      $('manual-lock').disabled = true;
      return;
    }
    grid.innerHTML = approved.map(s => {
      const sel = teamSelection.has(s.id);
      return `
        <div class="team-card ${sel ? 'selected' : ''}" data-id="${s.id}">
          <div class="check">${sel ? '✓' : ''}</div>
          <div class="name">${escapeHtml(s.name)}</div>
          <div class="ig">${s.instagram ? '@' + escapeHtml(s.instagram) : ''}${s.eliminationDecision === 'passed' ? ' · ✓ pasó fase 1' : ''}</div>
        </div>
      `;
    }).join('');
    grid.querySelectorAll('.team-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        if (teamSelection.has(id)) teamSelection.delete(id);
        else if (teamSelection.size < 8) teamSelection.add(id);
        else toast('Ya tenés 8. Sacá uno antes de elegir otro.');
        renderManual();
      });
    });
    $('manual-count').textContent = teamSelection.size;
    $('manual-lock').disabled = teamSelection.size !== 8;
  }

  $('manual-lock').addEventListener('click', async () => {
    if (teamSelection.size !== 8) return;
    try {
      await api(`/api/admin/${role}/lock`, { ids: Array.from(teamSelection) });
      toast('Equipo cerrado ✓');
      showScreen('closed');
    } catch (e) { toast(e.message); }
  });

  /* ===== Elim (phase 1) ===== */
  function renderElim() {
    const c = serverState?.countries?.[role];
    if (c?.teamLocked) { showScreen('closed'); return; }
    const approved = countryItems.filter(s => s.status === 'approved');
    const passed = approved.filter(s => s.eliminationDecision === 'passed');
    $('elim-count').textContent = passed.length;
    $('elim-lock').disabled = passed.length !== 8;

    const grid = $('p1-grid');
    const activeId = serverState?.activePhase1Card?.country === role ? serverState.activePhase1Card.cardId : null;
    if (!approved.length) {
      grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:30px; color: var(--muted);">No hay submissions aprobadas todavía. Aprobá algunas en VER ENVIADOS.</div>';
      return;
    }
    grid.innerHTML = approved.map((s, i) => {
      const cls = ['p1-card'];
      if (s.eliminationDecision === 'passed')   cls.push('passed');
      if (s.eliminationDecision === 'rejected') cls.push('rejected');
      if (s.id === activeId) cls.push('active-vote');
      const decisionTxt = s.eliminationDecision === 'passed' ? '✓ PASÓ'
                       : s.eliminationDecision === 'rejected' ? '✗ FUERA' : '— pendiente —';

      // Thumbnail: si tenemos URL real (YouTube/Vimeo), mostrar imagen. Si
      // no, mostrar un icono segun la plataforma.
      const thumbStyle = s.clipThumbnail ? `background-image:url('${escapeAttr(s.clipThumbnail)}')` : '';
      const platformIcon = platformIconFor(s.clipPlatform);
      const platformTag  = s.clipPlatform && s.clipPlatform !== 'iframe' && s.clipPlatform !== 'link'
        ? `<span class="platform-tag">${escapeHtml(s.clipPlatform)}</span>` : '';

      return `
        <div class="${cls.join(' ')}" data-id="${s.id}">
          <div class="num">#${i + 1}</div>
          <div class="thumb" style="${thumbStyle}">
            ${s.clipThumbnail ? '' : `<span class="thumb-icon">${platformIcon}</span>`}
            ${platformTag}
          </div>
          <div class="body">
            <div class="name">${escapeHtml(s.name)}</div>
            <div class="ig">${s.instagram ? '@' + escapeHtml(s.instagram) : ''}</div>
            <div class="decision">${decisionTxt}</div>
          </div>
        </div>
      `;
    }).join('');
    grid.querySelectorAll('.p1-card').forEach(card => {
      card.addEventListener('click', () => openP1Modal(card.dataset.id));
    });
  }

  $('elim-lock').addEventListener('click', async () => {
    const passedIds = countryItems
      .filter(s => s.status === 'approved' && s.eliminationDecision === 'passed')
      .map(s => s.id);
    if (passedIds.length !== 8) return toast('Necesitás exactamente 8 PASADAS.');
    try {
      await api(`/api/admin/${role}/lock`, { ids: passedIds });
      toast('Equipo cerrado ✓');
      showScreen('closed');
    } catch (e) { toast(e.message); }
  });

  /* ===== Modal phase 1 ===== */
  function openP1Modal(id) {
    const s = countryItems.find(x => x.id === id);
    if (!s) return;
    openModalCardId = id;
    $('modal-name').textContent = s.name;
    $('modal-ig').textContent = s.instagram ? '@' + s.instagram : '(sin IG)';
    $('modal-mediatype').textContent = s.mediaType || s.clipKind || 'media';
    $('modal-link').href = s.mediaUrl;
    $('modal-link').textContent = s.mediaUrl;

    // === Embed del clip ===
    // Renderizamos iframe (YouTube/Vimeo/TikTok/etc), <video> (mp4),
    // <audio> (mp3) o un link de fallback segun s.clipKind. Si la submission
    // es vieja y no tiene clipKind, intentamos detectar por mediaType.
    const embedWrap = $('modal-embed');
    embedWrap.innerHTML = '';
    const kind = s.clipKind || (s.mediaType === 'video' ? 'iframe' : s.mediaType === 'audio' ? 'audio' : 'link');
    if (kind === 'iframe') {
      const iframe = document.createElement('iframe');
      iframe.src = s.clipEmbed || s.mediaUrl;
      iframe.allow = 'autoplay; encrypted-media; picture-in-picture; clipboard-write';
      iframe.allowFullscreen = true;
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      embedWrap.appendChild(iframe);
    } else if (kind === 'video') {
      const v = document.createElement('video');
      v.src = s.mediaUrl; v.controls = true; v.preload = 'metadata';
      embedWrap.appendChild(v);
    } else if (kind === 'audio') {
      const a = document.createElement('audio');
      a.src = s.mediaUrl; a.controls = true; a.preload = 'metadata';
      embedWrap.appendChild(a);
    } else {
      // 'link' — boton clickeable hacia la URL original
      const a = document.createElement('a');
      a.href = s.mediaUrl; a.target = '_blank'; a.rel = 'noopener';
      a.className = 'link-fallback';
      a.textContent = '🔗 Abrir en otra pestaña (no se puede embeber)';
      embedWrap.appendChild(a);
    }

    $('p1-modal').classList.remove('hidden');
    pollState = null;
    renderModalPoll();
  }
  function closeP1Modal() {
    openModalCardId = null;
    // Vaciar el iframe corta el video/audio para no seguir sonando.
    const embedWrap = $('modal-embed');
    if (embedWrap) embedWrap.innerHTML = '';
    $('p1-modal').classList.add('hidden');
    if (modalTimerInterval) { clearInterval(modalTimerInterval); modalTimerInterval = null; }
  }
  $('modal-close').addEventListener('click', closeP1Modal);

  $('modal-poll-start').addEventListener('click', async () => {
    if (!openModalCardId) return;
    const sec = parseInt($('modal-duration').value, 10) || 60;
    try { await api(`/api/admin/${role}/elim/active`, { id: openModalCardId, durationMs: sec * 1000 });
      toast('Votación abierta — chat: !si o !no'); }
    catch (e) { toast(e.message); }
  });

  $('modal-poll-end').addEventListener('click', async () => {
    try { await api(`/api/admin/${role}/elim/active/close`, {}); toast('Votación cerrada'); }
    catch (e) { toast(e.message); }
  });

  document.querySelectorAll('[data-decide]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!openModalCardId) return;
      const decision = btn.dataset.decide;
      try {
        await api(`/api/admin/${role}/elim/decide`, { id: openModalCardId, decision });
        toast(decision === 'passed' ? '✓ PASÓ' : '✗ NO PASA');
        closeP1Modal();
        await refreshList();
      } catch (e) { toast(e.message); }
    });
  });

  function renderModalPoll() {
    if (!openModalCardId) return;
    if (!pollState || pollState.targetId !== openModalCardId || pollState.mode !== 'binary') {
      $('modal-timer').textContent = '--';
      $('modal-bar-si').style.width = '0%';
      $('modal-bar-no').style.width = '0%';
      $('modal-count-si').textContent = '0';
      $('modal-count-no').textContent = '0';
      if (modalTimerInterval) { clearInterval(modalTimerInterval); modalTimerInterval = null; }
      return;
    }
    const t = pollState.totals;
    const grand = Math.max(1, t.grandTotal);
    $('modal-bar-si').style.width = (t.siTotal / grand * 100).toFixed(1) + '%';
    $('modal-bar-no').style.width = (t.noTotal / grand * 100).toFixed(1) + '%';
    $('modal-count-si').textContent = t.siTotal;
    $('modal-count-no').textContent = t.noTotal;
    if (modalTimerInterval) clearInterval(modalTimerInterval);
    const startTick = pollState._tick || Date.now();
    const initialRem = pollState.remainingMs;
    modalTimerInterval = setInterval(() => {
      const elapsed = Date.now() - startTick;
      const remaining = Math.max(0, initialRem - elapsed);
      $('modal-timer').textContent = Math.ceil(remaining / 1000) + 's';
      if (remaining <= 0) clearInterval(modalTimerInterval);
    }, 200);
  }

  /* ===== Closed (8 lockeados) ===== */
  function renderClosed() {
    const c = serverState?.countries?.[role];
    if (!c?.teamLocked) return;
    const list = $('closed-list');
    list.innerHTML = c.lockedTeam.map((id, i) => {
      const s = countryItems.find(x => x.id === id);
      if (!s) return `<div class="closed-item"><div class="num">#${i+1}</div><div class="name">${id.slice(0,8)}</div></div>`;
      return `
        <div class="closed-item">
          <div class="num">#${i+1}</div>
          <div class="name">${escapeHtml(s.name)}</div>
          <div class="ig">${s.instagram ? '@' + escapeHtml(s.instagram) : ''}</div>
        </div>
      `;
    }).join('');
  }

  $('closed-unlock').addEventListener('click', async () => {
    if (serverState?.showStarted) return toast('No se puede desbloquear con el show ya empezado.');
    try {
      await api(`/api/admin/${role}/unlock`, {});
      teamSelection = new Set();
      toast('Desbloqueado');
      showScreen('menu');
    } catch (e) { toast(e.message); }
  });

  /* ===== Render orchestrator ===== */
  function renderAll() {
    if (!serverState) return;
    renderTwitchWidget();
    renderMenu();
    renderQueue();
    renderManual();
    renderElim();
    renderClosed();

    // Auto-route: si ya estan lockeados y la screen actual es menu/manual/elim, ir a closed
    const c = serverState.countries[role];
    const activeScreen = document.querySelector('.screen.active');
    if (c?.teamLocked && activeScreen && ['screen-menu', 'screen-manual', 'screen-elim'].includes(activeScreen.id)) {
      // Solo auto-redirigimos UNA vez (cuando el lock acaba de pasar). Si el
      // user clickea "← Menú" voluntariamente desde closed, no lo forzamos
      // de vuelta: por eso este check usa el _wasLocked flag.
      if (!renderAll._wasLocked) {
        showScreen('closed');
        renderAll._wasLocked = true;
      }
    } else if (!c?.teamLocked) {
      renderAll._wasLocked = false;
    }
  }

  /* ===== Helpers ===== */
  function escapeHtml(s) {
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // Icono por plataforma cuando no tenemos miniatura disponible
  function platformIconFor(platform) {
    switch (platform) {
      case 'youtube':   return '▶️';
      case 'vimeo':     return '🎬';
      case 'tiktok':    return '🎵';
      case 'instagram': return '📸';
      case 'facebook':  return '📘';
      case 'spotify':   return '🎧';
      case 'soundcloud':return '🔊';
      case 'drive':     return '📁';
      case 'audio':     return '🔊';
      case 'video':     return '🎥';
      default:          return '🎤';
    }
  }

  /* ===== Boot ===== */
  wsConnect();
  tryResume();
})();
