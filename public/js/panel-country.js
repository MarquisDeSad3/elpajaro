/**
 * Panel cuba/pr — UN solo JS para los dos paises. El rol se detecta de
 * `location.pathname` (`/panel/cuba` o `/panel/pr`).
 */

(() => {
  'use strict';

  const role = location.pathname.includes('/cuba') ? 'cuba' : 'pr';
  const TOKEN_KEY = `elpajaro.token.${role}`;
  const COUNTRY_NAME = role === 'cuba' ? 'CUBA' : 'PUERTO RICO';

  // Customizar header con el rol
  document.title = `Panel ${COUNTRY_NAME} · El Pajaro`;
  document.getElementById('login-title').textContent = `PANEL ${COUNTRY_NAME}`;
  const panelTitle = document.getElementById('panel-title');
  panelTitle.textContent = `EL PAJARO · ${COUNTRY_NAME}`;
  panelTitle.style.color = role === 'cuba' ? 'var(--cuba)' : 'var(--pr)';
  const roleTag = document.getElementById('role-tag');
  roleTag.textContent = COUNTRY_NAME;
  roleTag.classList.toggle('role-cuba', role === 'cuba');
  roleTag.classList.toggle('role-pr', role === 'pr');

  let token = localStorage.getItem(TOKEN_KEY) || null;
  let serverState = null;
  let pollState = null;
  let countryItems = [];      // submissions del pais
  let openModalCardId = null;
  let teamSelection = new Set();
  let activeBracketMatchId = null;
  let voteTimerInterval = null;
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
      if (m.type === 'state') { serverState = m.state; renderAll(); }
      else if (m.type === 'voting-start' || m.type === 'voting-update' || m.type === 'voting-end') {
        pollState = m.poll;
        renderModalPoll();
        renderLivePollUI();
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
    } catch (e) {
      $('login-error').textContent = e.message;
    }
  });

  function logout(silent = false) {
    if (!silent) api('/api/admin/logout', {}).catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    token = null;
    showLogin();
  }
  $('btn-logout').addEventListener('click', () => logout());

  function showLogin() {
    $('login-screen').classList.remove('hidden');
    $('main-panel').classList.add('hidden');
  }
  function showMain() {
    $('login-screen').classList.add('hidden');
    $('main-panel').classList.remove('hidden');
    renderAll();
  }

  async function tryResume() {
    if (!token) { showLogin(); return; }
    try {
      const r = await api('/api/admin/validate', {});
      if (r.role !== role) {
        toast(`Esta sesion era de ${r.role}, refrescá y entrá de nuevo.`);
        logout(true); return;
      }
      serverState = r.state;
      showMain();
      await refreshList();
    } catch { showLogin(); }
  }

  /* ===== Tabs ===== */
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.querySelector(`.tab-panel[data-panel="${tab}"]`).classList.add('active');
    });
  });

  /* ===== Refresh list ===== */
  async function refreshList() {
    try {
      const r = await api(`/api/admin/${role}/list`, {});
      countryItems = r.items || [];
      renderAll();
    } catch (e) { toast(e.message); }
  }
  // Refrescar list cuando llega un broadcast de submission
  setInterval(() => {
    if (token && document.visibilityState === 'visible') refreshList().catch(() => {});
  }, 5000);

  /* ===== Status banner ===== */
  function renderStatus() {
    if (!serverState) return;
    const c = serverState.countries[role];
    $('b-open').textContent = c.submissionsOpen ? 'Inscripciones ABIERTAS' : 'Inscripciones CERRADAS';
    $('b-open').classList.toggle('badge-green', c.submissionsOpen);
    $('b-open').classList.toggle('badge-gray',  !c.submissionsOpen);

    $('b-locked').textContent = c.teamLocked ? 'EQUIPO LOCKEADO' : 'equipo abierto';
    $('b-locked').classList.toggle('badge-yellow', c.teamLocked);
    $('b-locked').classList.toggle('badge-gray',   !c.teamLocked);

    $('b-count').textContent = c.counts.total;
    $('b-cap').textContent = serverState.submissionsCap || 50;
    $('b-passed').textContent = c.counts.passed;

    $('btn-toggle-submissions').textContent = c.submissionsOpen ? 'Cerrar inscripciones' : 'Abrir inscripciones';
    $('btn-toggle-submissions').classList.toggle('btn-danger', c.submissionsOpen);
    $('btn-toggle-submissions').classList.toggle('btn-success', !c.submissionsOpen);

    // Tab "live" visible solo cuando show empezo
    $('tab-live').classList.toggle('hidden', !serverState.showStarted);
  }

  $('btn-toggle-submissions').addEventListener('click', async () => {
    const c = serverState?.countries?.[role];
    if (!c) return;
    try {
      await api(`/api/admin/${role}/submissions-toggle`, { open: !c.submissionsOpen });
      toast(c.submissionsOpen ? 'Inscripciones cerradas' : 'Inscripciones abiertas');
    } catch (e) { toast(e.message); }
  });

  /* ===== Lists (pending/approved/rejected) ===== */
  function renderLists() {
    const pending  = countryItems.filter(s => s.status === 'pending');
    const approved = countryItems.filter(s => s.status === 'approved');
    const rejected = countryItems.filter(s => s.status === 'rejected');
    $('tag-pending').textContent  = pending.length;
    $('tag-approved').textContent = approved.length;
    $('tag-rejected').textContent = rejected.length;
    $('list-pending').innerHTML  = renderListHtml(pending,  'pending');
    $('list-approved').innerHTML = renderListHtml(approved, 'approved');
    $('list-rejected').innerHTML = renderListHtml(rejected, 'rejected');
    bindListActions();
  }

  function renderListHtml(arr, kind) {
    if (!arr.length) return `<div class="sub-empty">— sin ${kind} —</div>`;
    return arr.map((s, i) => `
      <div class="sub-item" data-id="${s.id}">
        <div class="num">${i + 1}</div>
        <div class="meta">
          <div class="name">${escapeHtml(s.name)}</div>
          <div class="ig">${s.instagram ? '@' + escapeHtml(s.instagram) : '—'} · ${escapeHtml(s.mediaType || 'link')}</div>
          <a class="url" href="${escapeAttr(s.mediaUrl)}" target="_blank" rel="noopener">${escapeHtml(s.mediaUrl)}</a>
        </div>
        <div class="actions">
          ${kind === 'pending'  ? `<button class="btn btn-success" data-act="approve">✓ Aprobar</button>
                                    <button class="btn btn-danger"  data-act="reject">✗ Rechazar</button>` : ''}
          ${kind === 'approved' ? `<span class="badge badge-green">APROBADA</span>
                                    <button class="btn btn-ghost" data-act="reject">Rechazar</button>` : ''}
          ${kind === 'rejected' ? `<span class="badge badge-gray">RECHAZADA</span>
                                    <button class="btn btn-ghost" data-act="approve">Re-aprobar</button>` : ''}
        </div>
      </div>
    `).join('');
  }

  function bindListActions() {
    document.querySelectorAll('.sub-item .actions button').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.sub-item').dataset.id;
        const act = btn.dataset.act;
        try {
          await api(`/api/admin/${role}/${act}`, { id });
          toast(act === 'approve' ? 'Aprobada ✓' : 'Rechazada');
          await refreshList();
        } catch (e) { toast(e.message); }
      });
    });
  }

  /* ===== Phase 1 — eliminación ===== */
  function renderPhase1Grid() {
    const approved = countryItems.filter(s => s.status === 'approved');
    const passed = approved.filter(s => s.eliminationDecision === 'passed').length;
    $('p1-passed-count').textContent = passed;
    const grid = $('p1-grid');
    if (!approved.length) {
      grid.innerHTML = '<div class="sub-empty" style="grid-column: 1/-1;">No hay submissions aprobadas todavía. Volvé al tab "Pendientes" para aprobar.</div>';
      return;
    }
    const activeId = serverState?.activePhase1Card?.country === role ? serverState.activePhase1Card.cardId : null;
    grid.innerHTML = approved.map((s, i) => {
      const cls = ['p1-card'];
      if (s.eliminationDecision === 'passed')   cls.push('passed');
      if (s.eliminationDecision === 'rejected') cls.push('rejected');
      if (s.id === activeId) cls.push('active-vote');
      const decisionTxt = s.eliminationDecision === 'passed' ? '✓ PASÓ'
                       : s.eliminationDecision === 'rejected' ? '✗ FUERA' : '— pendiente —';
      return `
        <div class="${cls.join(' ')}" data-id="${s.id}">
          <div class="num">#${i + 1}</div>
          <div class="name">${escapeHtml(s.name)}</div>
          <div class="ig">${s.instagram ? '@' + escapeHtml(s.instagram) : ''}</div>
          <div class="decision">${decisionTxt}</div>
        </div>
      `;
    }).join('');
    grid.querySelectorAll('.p1-card').forEach(card => {
      card.addEventListener('click', () => openP1Modal(card.dataset.id));
    });
  }

  /* ===== Phase 1 modal ===== */
  function openP1Modal(id) {
    const s = countryItems.find(x => x.id === id);
    if (!s) return;
    openModalCardId = id;
    $('modal-name').textContent = s.name;
    $('modal-ig').textContent = s.instagram ? '@' + s.instagram : '(sin IG)';
    $('modal-mediatype').textContent = s.mediaType;
    $('modal-link').href = s.mediaUrl;
    $('modal-link').textContent = s.mediaUrl;
    $('p1-modal').classList.remove('hidden');
    pollState = null;
    renderModalPoll();
  }

  function closeP1Modal() {
    openModalCardId = null;
    $('p1-modal').classList.add('hidden');
    if (modalTimerInterval) { clearInterval(modalTimerInterval); modalTimerInterval = null; }
  }

  $('modal-close').addEventListener('click', closeP1Modal);

  $('modal-poll-start').addEventListener('click', async () => {
    if (!openModalCardId) return;
    const sec = parseInt($('modal-duration').value, 10) || 60;
    try {
      await api(`/api/admin/${role}/elim/active`, { id: openModalCardId, durationMs: sec * 1000 });
      toast('Votación abierta — chat: !si o !no');
    } catch (e) { toast(e.message); }
  });

  $('modal-poll-end').addEventListener('click', async () => {
    try {
      await api(`/api/admin/${role}/elim/active/close`, {});
      toast('Votación cerrada');
    } catch (e) { toast(e.message); }
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
    modalTimerInterval = setInterval(() => {
      if (!pollState) return;
      const remaining = Math.max(0, pollState.remainingMs - (Date.now() - (pollState._tick || Date.now())));
      const sec = Math.ceil(remaining / 1000);
      $('modal-timer').textContent = sec + 's';
      if (remaining <= 0) clearInterval(modalTimerInterval);
    }, 200);
  }

  /* ===== Equipo final ===== */
  function renderTeam() {
    const c = serverState?.countries?.[role];
    const approved = countryItems.filter(s => s.status === 'approved');
    const passedIds = approved.filter(s => s.eliminationDecision === 'passed').map(s => s.id);
    const isLocked = !!c?.teamLocked;

    // Si esta lockeado, mostrar los 8 lockeados
    if (isLocked) {
      teamSelection = new Set(c.lockedTeam);
      $('btn-lock').classList.add('hidden');
      $('btn-unlock').classList.remove('hidden');
    } else {
      // Si no esta lockeado y la seleccion esta vacia, pre-poblar con los que pasaron
      if (teamSelection.size === 0 && passedIds.length > 0) {
        teamSelection = new Set(passedIds.slice(0, 8));
      }
      $('btn-lock').classList.remove('hidden');
      $('btn-unlock').classList.add('hidden');
    }

    const pool = approved;   // Cualquier aprobada puede entrar al equipo (manual override)
    const grid = $('team-grid');
    if (!pool.length) {
      grid.innerHTML = '<div class="sub-empty" style="grid-column: 1/-1;">No hay submissions aprobadas todavía.</div>';
      return;
    }
    grid.innerHTML = pool.map((s, i) => {
      const sel = teamSelection.has(s.id);
      const cls = ['team-card'];
      if (sel) cls.push('selected');
      if (isLocked) cls.push('locked-bg');
      const passedTag = s.eliminationDecision === 'passed' ? '<span class="badge badge-green" style="font-size:.6rem;">PASÓ</span>' : '';
      return `
        <div class="${cls.join(' ')}" data-id="${s.id}">
          <div class="check">${sel ? '✓' : ''}</div>
          <div style="font-family:'Archivo Black',sans-serif; font-size:.95rem; padding-right: 28px;">${escapeHtml(s.name)}</div>
          <div style="font-size:.75rem; color:#666; margin-top:2px;">${s.instagram ? '@' + escapeHtml(s.instagram) : ''} ${passedTag}</div>
        </div>
      `;
    }).join('');
    if (!isLocked) {
      grid.querySelectorAll('.team-card').forEach(card => {
        card.addEventListener('click', () => {
          const id = card.dataset.id;
          if (teamSelection.has(id)) teamSelection.delete(id);
          else if (teamSelection.size < 8) teamSelection.add(id);
          else toast('Ya tenes 8. Sacá uno antes de elegir otro.');
          renderTeam();
        });
      });
    }
    $('btn-lock').textContent = `CERRAR EQUIPO (${teamSelection.size}/8)`;
    $('btn-lock').disabled = teamSelection.size !== 8;
  }

  $('btn-lock').addEventListener('click', async () => {
    if (teamSelection.size !== 8) { toast('Tenes que elegir exactamente 8.'); return; }
    try {
      await api(`/api/admin/${role}/lock`, { ids: Array.from(teamSelection) });
      toast('Equipo cerrado ✓');
    } catch (e) { toast(e.message); }
  });

  $('btn-unlock').addEventListener('click', async () => {
    try {
      await api(`/api/admin/${role}/unlock`, {});
      toast('Equipo desbloqueado');
    } catch (e) { toast(e.message); }
  });

  /* ===== Show en vivo (controls de bracket cuando showStarted=true) ===== */
  function renderLive() {
    if (!serverState?.showStarted) {
      $('tab-live').classList.add('hidden');
      return;
    }
    const cur = serverState.currentMatch;
    const m = cur ? findMatch(cur.matchId) : null;
    activeBracketMatchId = m?.id || null;

    const wrap = $('live-current-match');
    if (!m) {
      wrap.innerHTML = '<p class="text-muted">Sin match activo. El master lo abre desde su panel.</p>';
    } else {
      const cs = serverState.contestants || {};
      const a = cs[m.leftId], b = cs[m.rightId];
      wrap.innerHTML = `
        <div class="card" style="background: white; color: var(--ink); padding: 12px;">
          <div class="row gap-md" style="justify-content: space-between;">
            <div>
              <div style="font-family:'Archivo Black',sans-serif; font-size:.7rem; letter-spacing:1px; color:${a?.country==='cuba'?'var(--cuba)':'var(--pr)'};">
                ${a?.country === 'cuba' ? 'CUBA' : 'PR'} · IZQ
              </div>
              <div style="font-family:'Bangers',cursive; font-size:1.4rem; letter-spacing:1px;">${escapeHtml(a?.name||'?')}</div>
            </div>
            <div style="font-family:'Bangers',cursive; font-size:1.6rem; color:var(--pr);">VS</div>
            <div style="text-align:right;">
              <div style="font-family:'Archivo Black',sans-serif; font-size:.7rem; letter-spacing:1px; color:${b?.country==='cuba'?'var(--cuba)':'var(--pr)'};">
                ${b?.country === 'cuba' ? 'CUBA' : 'PR'} · DER
              </div>
              <div style="font-family:'Bangers',cursive; font-size:1.4rem; letter-spacing:1px;">${escapeHtml(b?.name||'?')}</div>
            </div>
          </div>
          <div style="margin-top:8px; font-family:'Archivo Black',sans-serif; font-size:.75rem; letter-spacing:2px;">FASE: ${cur.phase.toUpperCase()}</div>
        </div>
      `;
    }

    // Pending decision (consensus)
    const pd = serverState.pendingDecision;
    const consWrap = $('consensus-status');
    if (pd && m && pd.matchId === m.id) {
      const myVote = pd.votes[role];
      const otherRole = role === 'cuba' ? 'pr' : 'cuba';
      const otherVote = pd.votes[otherRole];
      consWrap.innerHTML = `
        <div style="font-family:'Archivo Black',sans-serif; letter-spacing:1.5px; margin-bottom:6px;">CONSENSO 2-DE-2</div>
        <div class="vote-line"><span>Cuba votó:</span> <strong>${pd.votes.cuba ? pd.votes.cuba.toUpperCase() : '— pendiente —'}</strong></div>
        <div class="vote-line"><span>PR votó:</span>   <strong>${pd.votes.pr   ? pd.votes.pr.toUpperCase()   : '— pendiente —'}</strong></div>
        ${myVote && otherVote && myVote !== otherVote ? '<div style="color:var(--pr); margin-top:6px;">⚠ Discrepancia. Alguien tiene que cambiar su voto.</div>' : ''}
      `;
      consWrap.classList.remove('hidden');
    } else {
      consWrap.classList.add('hidden');
    }

    // Buttons
    const inPreview = m && cur?.phase === 'preview';
    const inVoting  = m && cur?.phase === 'voting';
    const inResult  = m && cur?.phase === 'result';
    $('ctl-preview').disabled    = !!cur || !serverState.bracket;
    $('ctl-clip-left').disabled  = !inPreview;
    $('ctl-clip-right').disabled = !inPreview;
    $('ctl-pause-clips').disabled= !inPreview;
    $('ctl-vote-start').disabled = !inPreview;
    $('ctl-vote-end').disabled   = !inVoting;
    $('ctl-decide-left').disabled  = !(m && (inPreview || inVoting || inResult));
    $('ctl-decide-right').disabled = !(m && (inPreview || inVoting || inResult));
    $('ctl-decide-cancel').disabled = !pd;

    // El boton de PREVIEW lo necesita el master para abrir el match. Aca
    // (cuba/pr) solo lo dejamos habilitado si NO hay match abierto y hay un
    // proximo match disponible — pero asumimos que es el master quien arranca.
    // De todos modos el endpoint acepta cualquier rol.
    $('ctl-preview').disabled = true;  // dejamos el "abrir match" al master
  }

  function renderLivePollUI() {
    // Podriamos mostrar barras del poll en vivo; por simpleza, dejamos solo
    // el indicador de fase + consensus en el panel pais. El show.html ya
    // tiene barras animadas en grande.
  }

  function findMatch(matchId) {
    if (!serverState?.bracket) return null;
    for (const round of serverState.bracket.rounds) {
      const m = round.find(x => x.id === matchId);
      if (m) return m;
    }
    return null;
  }

  // Live controls
  $('ctl-clip-left').addEventListener('click', () => api('/api/match/play-clip', { side: 'left',  action: 'play' }).catch(e => toast(e.message)));
  $('ctl-clip-right').addEventListener('click', () => api('/api/match/play-clip', { side: 'right', action: 'play' }).catch(e => toast(e.message)));
  $('ctl-pause-clips').addEventListener('click', async () => {
    try {
      await api('/api/match/play-clip', { side: 'left',  action: 'pause' });
      await api('/api/match/play-clip', { side: 'right', action: 'pause' });
    } catch (e) { toast(e.message); }
  });
  $('ctl-vote-start').addEventListener('click', async () => {
    const sec = parseInt($('ctl-duration').value, 10) || 60;
    try { await api('/api/match/voting/start', { durationMs: sec * 1000 }); toast('Votación abierta'); }
    catch (e) { toast(e.message); }
  });
  $('ctl-vote-end').addEventListener('click', async () => {
    try { await api('/api/match/voting/end', {}); toast('Votación cerrada'); }
    catch (e) { toast(e.message); }
  });
  $('ctl-decide-left').addEventListener('click', () => proposeDecision('left'));
  $('ctl-decide-right').addEventListener('click', () => proposeDecision('right'));
  $('ctl-decide-cancel').addEventListener('click', async () => {
    try { await api('/api/match/cancel-decision', {}); toast('Cancelado'); }
    catch (e) { toast(e.message); }
  });

  async function proposeDecision(side) {
    if (!activeBracketMatchId) return;
    try {
      const r = await api('/api/match/propose-decision', { matchId: activeBracketMatchId, winnerSide: side });
      if (r.consensus) toast(`✓ Consenso. Gana ${side.toUpperCase()}`);
      else toast(`Tu voto: ${side.toUpperCase()}. Esperando al otro lado.`);
    } catch (e) { toast(e.message); }
  }

  /* ===== Render ===== */
  function renderAll() {
    if (!serverState) return;
    renderStatus();
    renderLists();
    renderPhase1Grid();
    renderTeam();
    renderLive();
  }

  /* ===== Helpers ===== */
  function escapeHtml(s) {
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  /* ===== Boot ===== */
  wsConnect();
  tryResume();
})();
