/**
 * Panel master — orquestacion del show.
 *
 * Funciones:
 *  - PIN gate (role=master)
 *  - Conexion OAuth de Twitch para los dos canales
 *  - Status visual de ambos paises (locked / counts / etc)
 *  - Boton EMPEZAR (cuando ambos lockeados)
 *  - Durante el show: bracket view + controles de match flow
 *    (preview, clips, abrir/cerrar votacion). La decision del ganador
 *    NO se hace aca — la votan cuba+pr desde sus paneles (consenso 2-de-2).
 *  - Reset show / reset all
 */

(() => {
  'use strict';

  const TOKEN_KEY = 'elpajaro.token.master';
  let token = localStorage.getItem(TOKEN_KEY) || null;
  let serverState = null;
  let selectedMatchId = null;

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

  /* ===== Login ===== */
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = $('pin').value;
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, role: 'master' }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'PIN incorrecto');
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      serverState = data.state;
      showMain();
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
      if (r.role !== 'master') {
        toast('Esta sesion era de otro rol — re-ingresá');
        logout(true); return;
      }
      serverState = r.state;
      showMain();
    } catch { showLogin(); }
  }

  /* ===== Twitch buttons ===== */
  $('btn-conn-cuba').addEventListener('click', () => {
    window.open('/api/twitch/auth?from=cuba', 'twitchAuth', 'width=720,height=820');
  });
  $('btn-conn-pr').addEventListener('click', () => {
    window.open('/api/twitch/auth?from=pr', 'twitchAuth', 'width=720,height=820');
  });

  function renderTwitch() {
    const tw = serverState?.twitchConnections || {};
    $('dot-cuba').classList.toggle('live', !!tw.cuba?.connected);
    $('dot-pr').classList.toggle('live',   !!tw.pr?.connected);
    $('label-cuba').textContent = tw.cuba?.connected ? `CUBA · ${tw.cuba.name || 'on'}` : 'CONECTAR CUBA';
    $('label-pr').textContent   = tw.pr?.connected   ? `PR · ${tw.pr.name || 'on'}`     : 'CONECTAR PR';
  }

  /* ===== Country status ===== */
  function renderCountryStatus() {
    if (!serverState) return;
    const cap = serverState.submissionsCap || 50;

    for (const country of ['cuba', 'pr']) {
      const c = serverState.countries[country];
      $(`${country}-count`).textContent = c.counts.total;
      $(`${country}-cap`).textContent = cap;
      $(`${country}-approved`).textContent = c.counts.approved;
      $(`${country}-passed`).textContent = `${c.counts.passed}/8`;
      $(`${country}-open`).textContent = c.submissionsOpen ? 'ABIERTAS' : 'CERRADAS';

      const ready = $(`${country}-ready`);
      if (c.teamLocked) {
        ready.textContent = '✓ EQUIPO LISTO';
        ready.classList.add('yes'); ready.classList.remove('no');
      } else {
        ready.textContent = '✗ Pendiente';
        ready.classList.add('no'); ready.classList.remove('yes');
      }
    }
  }

  /* ===== EMPEZAR section ===== */
  function renderEmpezar() {
    if (!serverState) return;
    const cuba = serverState.countries.cuba;
    const pr   = serverState.countries.pr;
    const bothReady = cuba.teamLocked && pr.teamLocked;
    const showStarted = serverState.showStarted;

    if (showStarted) {
      $('empezar-section').classList.add('hidden');
      $('show-running').classList.remove('hidden');
      renderShowRunning();
    } else {
      $('empezar-section').classList.remove('hidden');
      $('show-running').classList.add('hidden');
      $('empezar-section').classList.toggle('disabled', !bothReady);
      $('btn-empezar').disabled = !bothReady;
      $('empezar-status').textContent = bothReady
        ? '✓ Los dos paises tienen sus 8 lockeados. Listo para arrancar.'
        : `Esperando: ${cuba.teamLocked ? '' : 'Cuba '}${pr.teamLocked ? '' : 'Puerto Rico '}`;
    }
  }

  $('btn-empezar').addEventListener('click', async () => {
    const shuffle = $('shuffle-pairings').checked;
    try {
      await api('/api/master/start-show', { shuffle });
      toast('🏆 ¡Show empezado!');
    } catch (e) { toast(e.message); }
  });

  /* ===== Show running ===== */
  function renderShowRunning() {
    renderBracketList();
    renderActiveMatch();
  }

  function renderBracketList() {
    const root = $('bracket-list');
    root.innerHTML = '';
    const bracket = serverState?.bracket;
    if (!bracket) {
      root.innerHTML = '<p class="text-muted">No hay bracket.</p>';
      return;
    }
    const cs = serverState.contestants || {};
    const roundNames = ['Octofinales', 'Cuartos', 'Semifinales', 'FINAL'];
    bracket.rounds.forEach((round, ri) => {
      const sec = document.createElement('div');
      sec.className = 'round-section';
      sec.innerHTML = `<h4>${roundNames[ri]}</h4>`;
      round.forEach(m => {
        const btn = document.createElement('button');
        btn.className = 'match-btn';
        if (m.status === 'active') btn.classList.add('active');
        if (m.status === 'done')   btn.classList.add('done');
        if (m.id === selectedMatchId) btn.classList.add('active');
        const a = cs[m.leftId], b = cs[m.rightId];
        const aName = a?.name || (m.leftId ? '?' : 'TBD');
        const bName = b?.name || (m.rightId ? '?' : 'TBD');
        btn.innerHTML = `
          <span>${m.wing === 'center' ? '★' : (m.wing === 'left' ? '◀' : '▶')}</span>
          <span>${escapeHtml(aName)}</span>
          <span class="vs">vs</span>
          <span>${escapeHtml(bName)}</span>
          ${m.status === 'done' ? `<span class="winner-tag">${escapeHtml(cs[m.winnerId]?.name || '')}</span>` : ''}
        `;
        btn.addEventListener('click', () => {
          selectedMatchId = m.id;
          renderShowRunning();
        });
        sec.appendChild(btn);
      });
      root.appendChild(sec);
    });
  }

  function findMatch(matchId) {
    if (!serverState?.bracket) return null;
    for (const round of serverState.bracket.rounds) {
      const m = round.find(x => x.id === matchId);
      if (m) return m;
    }
    return null;
  }

  function renderActiveMatch() {
    const m = selectedMatchId ? findMatch(selectedMatchId) : null;
    const cur = serverState?.currentMatch;
    const isCurrent = m && cur && cur.matchId === m.id;
    const inPreview = isCurrent && cur.phase === 'preview';
    const inVoting  = isCurrent && cur.phase === 'voting';
    const inResult  = isCurrent && cur.phase === 'result';
    const matchReady = !!(m && m.leftId && m.rightId && m.status !== 'done');
    const cs = serverState?.contestants || {};

    if (!m) {
      $('active-match-title').textContent = 'Sin match activo';
      $('active-match-info').textContent = 'Seleccioná un match del bracket.';
    } else {
      const a = cs[m.leftId], b = cs[m.rightId];
      const phase = isCurrent ? cur.phase : (m.status === 'done' ? 'CERRADO' : 'IDLE');
      $('active-match-title').textContent = `${a?.name || '?'} vs ${b?.name || '?'}`;
      $('active-match-info').innerHTML = `
        <strong>${a?.country === 'cuba' ? 'CUBA' : 'PR'}</strong> vs <strong>${b?.country === 'cuba' ? 'CUBA' : 'PR'}</strong>
        · Fase: <strong>${phase.toUpperCase()}</strong>
      `;
    }

    $('ctl-preview').disabled    = !matchReady || isCurrent;
    $('ctl-clip-left').disabled  = !inPreview;
    $('ctl-clip-right').disabled = !inPreview;
    $('ctl-pause-clips').disabled= !inPreview;
    $('ctl-vote-start').disabled = !inPreview;
    $('ctl-vote-end').disabled   = !inVoting;

    // Consenso pendiente
    const pd = serverState?.pendingDecision;
    const cb = $('consensus-box');
    if (pd && m && pd.matchId === m.id) {
      cb.innerHTML = `
        <div style="font-size:1rem; letter-spacing:2px; margin-bottom:6px;">CONSENSO 2-DE-2</div>
        <div class="vote-line"><span>Cuba:</span> <strong>${pd.votes.cuba ? pd.votes.cuba.toUpperCase() : '— pendiente —'}</strong></div>
        <div class="vote-line"><span>PR:</span>   <strong>${pd.votes.pr   ? pd.votes.pr.toUpperCase()   : '— pendiente —'}</strong></div>
        ${pd.votes.cuba && pd.votes.pr && pd.votes.cuba !== pd.votes.pr ? '<div style="color:var(--pr); margin-top:4px;">⚠ Discrepancia. Alguien tiene que cambiar.</div>' : ''}
      `;
      cb.classList.remove('hidden');
      $('ctl-cancel-decision').disabled = false;
    } else {
      cb.classList.add('hidden');
      $('ctl-cancel-decision').disabled = true;
    }
  }

  /* ===== Bracket controls ===== */
  $('ctl-preview').addEventListener('click', async () => {
    if (!selectedMatchId) return;
    try { await api('/api/match/preview', { matchId: selectedMatchId }); toast('Preview ✓'); }
    catch (e) { toast(e.message); }
  });
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
  $('ctl-cancel-decision').addEventListener('click', async () => {
    try { await api('/api/match/cancel-decision', {}); toast('Voto cancelado'); }
    catch (e) { toast(e.message); }
  });

  /* ===== Reset ===== */
  let resetShowArmed = false, resetAllArmed = false;
  $('btn-reset-show').addEventListener('click', async () => {
    if (!resetShowArmed) {
      resetShowArmed = true;
      $('btn-reset-show').textContent = '¿SEGURO? click otra vez';
      setTimeout(() => { resetShowArmed = false; $('btn-reset-show').textContent = 'Resetear show (preserva submissions)'; }, 3000);
      return;
    }
    try { await api('/api/master/reset-show', {}); toast('Show reseteado'); resetShowArmed = false; $('btn-reset-show').textContent = 'Resetear show (preserva submissions)'; }
    catch (e) { toast(e.message); }
  });
  $('btn-reset-all').addEventListener('click', async () => {
    if (!resetAllArmed) {
      resetAllArmed = true;
      $('btn-reset-all').textContent = '⚠ BORRA TODO. Click de nuevo.';
      setTimeout(() => { resetAllArmed = false; $('btn-reset-all').textContent = 'RESET TOTAL (borra todo)'; }, 4000);
      return;
    }
    try { await api('/api/master/reset-all', {}); toast('Todo borrado'); resetAllArmed = false; $('btn-reset-all').textContent = 'RESET TOTAL (borra todo)'; }
    catch (e) { toast(e.message); }
  });

  /* ===== Render orchestrator ===== */
  function renderAll() {
    if (!serverState) return;
    renderTwitch();
    renderCountryStatus();
    renderEmpezar();
  }

  /* ===== Helpers ===== */
  function escapeHtml(s) {
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  /* ===== Boot ===== */
  wsConnect();
  tryResume();
})();
