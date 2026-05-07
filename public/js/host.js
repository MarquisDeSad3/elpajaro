/**
 * Panel del host. Maneja:
 *  - Login con PIN
 *  - Conexion OAuth de Twitch para los dos canales
 *  - Setup de los 16 cantantes (carga manual + ejemplo)
 *  - Emparejamientos de octofinales (8 pares Cuba vs PR)
 *  - Construccion del bracket
 *  - Control del show en vivo: preview, clip play/pause, votar, decidir
 *
 * El estado lo recibe del WS. Las acciones del host pegan a /api/host/*
 * con el token de sesion.
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'elpajaro.hostToken';

  let token = localStorage.getItem(TOKEN_KEY) || null;
  let serverState = null;
  let pollState = null;
  let selectedMatchId = null;     // que match esta el host operando
  let localContestants = [];      // edicion en memoria antes de guardar

  // ============= WebSocket =============
  let ws;
  let reconnectTimer;
  function wsConnect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {};
    ws.onclose = () => {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(wsConnect, 2000);
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'state') { serverState = m.state; renderAll(); }
      else if (m.type === 'voting-start' || m.type === 'voting-update' || m.type === 'voting-end') {
        pollState = m.poll;
        renderLivePoll();
      }
    };
  }

  // ============= API =============
  async function api(path, body, method = 'POST') {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify({ ...body, token });
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      logout(true);
      throw new Error('Sesion vencida — re-ingresa el PIN.');
    }
    if (!data.ok) throw new Error(data.error || 'Error');
    return data;
  }

  function toast(text, ms = 2400) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ============= Login =============
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = $('pin').value;
    try {
      const res = await fetch('/api/host/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'PIN incorrecto');
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      serverState = data.state;
      showMain();
    } catch (e) {
      $('login-error').textContent = e.message;
    }
  });

  function logout(silent = false) {
    if (!silent) api('/api/host/logout', {}).catch(() => {});
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
      const r = await api('/api/host/validate', {});
      serverState = r.state;
      showMain();
    } catch {
      showLogin();
    }
  }

  // ============= Tabs =============
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.tab;
      document.querySelector(`.tab-panel[data-panel="${target}"]`).classList.add('active');
    });
  });

  // ============= Twitch connect buttons =============
  $('btn-conn-cuba').addEventListener('click', () => {
    window.open('/api/twitch/auth?from=cuba', 'twitchAuth', 'width=720,height=820');
  });
  $('btn-conn-pr').addEventListener('click', () => {
    window.open('/api/twitch/auth?from=pr', 'twitchAuth', 'width=720,height=820');
  });

  function renderConnections() {
    const tw = serverState?.twitchConnections || {};
    const dotC = $('dot-cuba'), dotP = $('dot-pr');
    const labC = $('label-cuba'), labP = $('label-pr');
    dotC.classList.toggle('live', !!tw.cuba?.connected);
    dotP.classList.toggle('live', !!tw.pr?.connected);
    labC.textContent = tw.cuba?.connected ? `CUBA · ${tw.cuba.name || 'on'}` : 'CONECTAR CUBA';
    labP.textContent = tw.pr?.connected   ? `PR · ${tw.pr.name || 'on'}`     : 'CONECTAR PR';
  }

  // ============= Tab 1: Contestants =============
  function ensureLocalContestants() {
    if (localContestants.length === 16) return;
    // Cargar del estado del server si hay
    if (serverState?.contestants && Object.keys(serverState.contestants).length === 16) {
      localContestants = Object.values(serverState.contestants);
      return;
    }
    // Plantilla vacia: 8 cubanos + 8 PR
    localContestants = [];
    for (let i = 1; i <= 8; i++) localContestants.push({ id: 'cuba-' + i, country: 'cuba', name: '', bio: '', photoUrl: '', clipUrl: '', clipType: 'audio' });
    for (let i = 1; i <= 8; i++) localContestants.push({ id: 'pr-' + i,   country: 'pr',   name: '', bio: '', photoUrl: '', clipUrl: '', clipType: 'audio' });
  }

  function renderContestants() {
    ensureLocalContestants();
    const grid = $('contestants-grid');
    grid.innerHTML = '';
    let filled = 0;
    localContestants.forEach((c, idx) => {
      if (c.name && c.name.trim()) filled++;
      const card = document.createElement('div');
      card.className = 'contestant-card';
      card.dataset.country = c.country;
      card.innerHTML = `
        <div class="row">
          <div class="preview-thumb" style="${c.photoUrl ? `background-image:url('${c.photoUrl}')` : ''}"></div>
          <div style="flex:1;">
            <label>Nombre</label>
            <input type="text" data-field="name" value="${escapeHtml(c.name)}" placeholder="Nombre del cantante" />
          </div>
        </div>
        <div class="row">
          <select data-field="country">
            <option value="cuba" ${c.country==='cuba'?'selected':''}>Cuba</option>
            <option value="pr"   ${c.country==='pr'?'selected':''}>Puerto Rico</option>
          </select>
          <select data-field="clipType">
            <option value="audio" ${c.clipType==='audio'?'selected':''}>Audio</option>
            <option value="video" ${c.clipType==='video'?'selected':''}>Video</option>
          </select>
        </div>
        <div class="row">
          <textarea data-field="bio" rows="2" placeholder="Bio breve">${escapeHtml(c.bio)}</textarea>
        </div>
        <div class="upload-row">
          <label class="upload-btn">📷 Foto<input type="file" accept="image/*" data-upload="photo"></label>
          <label class="upload-btn">🎵 Clip<input type="file" accept="audio/*,video/*" data-upload="clip"></label>
        </div>
        <div class="row" style="font-size:.7rem;color:#666;">
          <span>id: ${c.id}</span>
          <span>${c.photoUrl ? '✓ foto' : '○'} · ${c.clipUrl ? '✓ clip' : '○'}</span>
        </div>
      `;
      // wire inputs
      card.querySelectorAll('input[data-field], textarea[data-field], select[data-field]').forEach(el => {
        el.addEventListener('input', () => {
          c[el.dataset.field] = el.value;
          if (el.dataset.field === 'country') card.dataset.country = el.value;
        });
      });
      // wire uploads
      card.querySelectorAll('input[data-upload]').forEach(el => {
        el.addEventListener('change', async () => {
          const file = el.files?.[0];
          if (!file) return;
          await uploadFile(c, el.dataset.upload, file);
          renderContestants();   // re-render para reflejar la URL
        });
      });
      grid.appendChild(card);
    });
    $('contestants-count').textContent = `${filled} / 16`;
  }

  async function uploadFile(c, field, file) {
    const fd = new FormData();
    fd.append('id', c.id);
    fd.append('token', token);
    fd.append(field, file);
    try {
      const res = await fetch('/api/host/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'upload error');
      if (data.photoUrl) c.photoUrl = data.photoUrl;
      if (data.clipUrl)  { c.clipUrl = data.clipUrl; c.clipType = data.clipType; }
      toast('Subido ✓');
    } catch (e) { toast('Error: ' + e.message); }
  }

  $('btn-load-example').addEventListener('click', async () => {
    try {
      const res = await fetch('/data/contestants.example.json');
      const data = await res.json();
      if (Array.isArray(data) && data.length === 16) {
        localContestants = data;
        renderContestants();
        toast('Ejemplo cargado');
      }
    } catch { toast('No se pudo cargar el ejemplo'); }
  });

  $('btn-save-contestants').addEventListener('click', async () => {
    try {
      // chequear: 8 cuba + 8 PR, todos con nombre
      if (localContestants.some(c => !c.name?.trim())) {
        toast('Faltan nombres en algunos cantantes'); return;
      }
      const cubanos = localContestants.filter(c => c.country === 'cuba').length;
      if (cubanos !== 8) { toast(`Tenés ${cubanos} cubanos, deben ser 8`); return; }
      await api('/api/host/contestants', { contestants: localContestants });
      toast('Cantantes guardados ✓');
    } catch (e) { toast(e.message); }
  });

  // ============= Tab 2: Pairings =============
  let localPairings = [];
  function renderPairings() {
    const list = $('pairings-list');
    list.innerHTML = '';
    if (!serverState || Object.keys(serverState.contestants || {}).length !== 16) {
      list.innerHTML = '<p class="hint">Primero guardá los 16 cantantes en el tab anterior.</p>';
      return;
    }
    if (localPairings.length === 0 && Array.isArray(serverState.pairings) && serverState.pairings.length === 8) {
      localPairings = serverState.pairings.map(p => ({ ...p }));
    }
    if (localPairings.length === 0) {
      // default: emparejar por orden — cuba-N vs pr-N
      const cs = Object.values(serverState.contestants);
      const cubanos = cs.filter(c => c.country === 'cuba');
      const prs     = cs.filter(c => c.country === 'pr');
      for (let i = 0; i < 8; i++) {
        localPairings.push({
          leftId:  cubanos[i]?.id,
          rightId: prs[i]?.id,
          wing: i < 4 ? 'left' : 'right',
        });
      }
    }
    const cs = serverState.contestants;
    const cubaOpts = Object.values(cs).filter(c => c.country === 'cuba');
    const prOpts   = Object.values(cs).filter(c => c.country === 'pr');

    for (let i = 0; i < 8; i++) {
      const p = localPairings[i] || { leftId: '', rightId: '', wing: i < 4 ? 'left' : 'right' };
      const row = document.createElement('div');
      row.className = 'pairing-row';
      const wingLabel = p.wing === 'left' ? 'Ala IZQ' : 'Ala DER';
      row.innerHTML = `
        <div class="slot-num">${i+1}</div>
        <select data-side="left" data-idx="${i}">
          ${cubaOpts.map(o => `<option value="${o.id}" ${o.id===p.leftId?'selected':''}>🇨🇺 ${escapeHtml(o.name)}</option>`).join('')}
        </select>
        <span style="text-align:center;font-family:'Bangers',cursive;">VS</span>
        <select data-side="right" data-idx="${i}">
          ${prOpts.map(o => `<option value="${o.id}" ${o.id===p.rightId?'selected':''}>🇵🇷 ${escapeHtml(o.name)}</option>`).join('')}
        </select>
      `;
      row.querySelectorAll('select').forEach(sel => {
        sel.addEventListener('change', () => {
          const idx = parseInt(sel.dataset.idx, 10);
          if (sel.dataset.side === 'left')  localPairings[idx].leftId = sel.value;
          if (sel.dataset.side === 'right') localPairings[idx].rightId = sel.value;
        });
      });
      list.appendChild(row);
    }
  }

  $('btn-shuffle-pairings').addEventListener('click', () => {
    if (!serverState?.contestants) return;
    const cs = Object.values(serverState.contestants);
    const cubanos = shuffle(cs.filter(c => c.country === 'cuba'));
    const prs     = shuffle(cs.filter(c => c.country === 'pr'));
    localPairings = [];
    for (let i = 0; i < 8; i++) {
      localPairings.push({
        leftId: cubanos[i].id,
        rightId: prs[i].id,
        wing: i < 4 ? 'left' : 'right',
      });
    }
    renderPairings();
  });

  $('btn-save-pairings').addEventListener('click', async () => {
    try {
      // Validar duplicados
      const all = new Set();
      for (const p of localPairings) {
        if (!p.leftId || !p.rightId) return toast('Hay slots vacios');
        if (all.has(p.leftId) || all.has(p.rightId)) return toast('Hay cantantes duplicados');
        all.add(p.leftId); all.add(p.rightId);
      }
      await api('/api/host/pairings', { pairings: localPairings });
      toast('Emparejamientos guardados ✓');
    } catch (e) { toast(e.message); }
  });

  $('btn-build-bracket').addEventListener('click', async () => {
    try {
      await api('/api/host/bracket/build', {});
      toast('Bracket construido. Pasá al tab "Show en vivo".');
    } catch (e) { toast(e.message); }
  });

  // ============= Tab 3: Run =============
  function renderBracketRun() {
    const root = $('run-bracket');
    root.innerHTML = '';
    const bracket = serverState?.bracket;
    if (!bracket) {
      root.innerHTML = '<p class="hint">No hay bracket. Construilo en el tab anterior.</p>';
      return;
    }
    const cs = serverState.contestants || {};
    const roundNames = ['Octofinales', 'Cuartos', 'Semifinales', 'FINAL'];
    bracket.rounds.forEach((round, ri) => {
      const sec = document.createElement('div');
      sec.className = 'run-round';
      sec.innerHTML = `<h4>${roundNames[ri]}</h4>`;
      round.forEach(m => {
        const btn = document.createElement('button');
        btn.className = 'run-match-btn';
        if (m.status === 'active') btn.classList.add('active');
        if (m.status === 'done')   btn.classList.add('done');
        const a = cs[m.leftId];
        const b = cs[m.rightId];
        const aName = a?.name || (m.leftId ? '?' : 'TBD');
        const bName = b?.name || (m.rightId ? '?' : 'TBD');
        btn.innerHTML = `
          <span>${m.wing === 'center' ? '★' : (m.wing === 'left' ? '◀' : '▶')}</span>
          <span>${escapeHtml(aName)}</span>
          <span class="vs">vs</span>
          <span>${escapeHtml(bName)}</span>
          ${m.status === 'done' ? `<span class="winner-tag">${escapeHtml(cs[m.winnerId]?.name || 'GANO')}</span>` : ''}
        `;
        btn.addEventListener('click', () => selectMatch(m.id));
        sec.appendChild(btn);
      });
      root.appendChild(sec);
    });
  }

  function selectMatch(matchId) {
    selectedMatchId = matchId;
    renderActiveMatch();
    refreshControlButtons();
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
    const wrap = $('active-match');
    if (!selectedMatchId) {
      wrap.innerHTML = '<p class="empty">Seleccioná un match en el bracket para empezar.</p>';
      return;
    }
    const m = findMatch(selectedMatchId);
    if (!m) { wrap.innerHTML = '<p class="empty">Match no encontrado.</p>'; return; }
    const cs = serverState.contestants || {};
    const a = cs[m.leftId], b = cs[m.rightId];
    const cur = serverState.currentMatch;
    const phase = (cur && cur.matchId === m.id) ? cur.phase : (m.status === 'done' ? 'done' : 'idle');
    wrap.innerHTML = `
      <div class="phase">${phase.toUpperCase()}</div>
      <div class="vs-line">
        <div class="who">
          <div class="label">${a?.country === 'cuba' ? 'CUBA' : 'PR'} · IZQ</div>
          <div class="name">${escapeHtml(a?.name || '?')}</div>
        </div>
        <div class="vs">VS</div>
        <div class="who right">
          <div class="label">${b?.country === 'cuba' ? 'CUBA' : 'PR'} · DER</div>
          <div class="name">${escapeHtml(b?.name || '?')}</div>
        </div>
      </div>
    `;
  }

  function refreshControlButtons() {
    const m = selectedMatchId ? findMatch(selectedMatchId) : null;
    const cur = serverState?.currentMatch;
    const isCurrent = !!(m && cur && cur.matchId === m.id);
    const inPreview = isCurrent && cur.phase === 'preview';
    const inVoting  = isCurrent && cur.phase === 'voting';
    const inResult  = isCurrent && cur.phase === 'result';
    const matchReady = !!(m && m.leftId && m.rightId && m.status !== 'done');

    $('ctl-preview').disabled    = !matchReady;
    $('ctl-clip-left').disabled  = !inPreview;
    $('ctl-clip-right').disabled = !inPreview;
    $('ctl-pause-clips').disabled= !inPreview;
    $('ctl-vote-start').disabled = !inPreview;
    $('ctl-vote-end').disabled   = !inVoting;
    $('ctl-decide-left').disabled  = !(matchReady && (inPreview || inVoting || inResult));
    $('ctl-decide-right').disabled = !(matchReady && (inPreview || inVoting || inResult));
  }

  // Wire control buttons
  $('ctl-preview').addEventListener('click', async () => {
    try {
      await api('/api/host/match/preview', { matchId: selectedMatchId });
      toast('Match en preview ✓');
    } catch (e) { toast(e.message); }
  });
  $('ctl-clip-left').addEventListener('click', async () => {
    try { await api('/api/host/match/play-clip', { side: 'left', action: 'play' }); } catch (e) { toast(e.message); }
  });
  $('ctl-clip-right').addEventListener('click', async () => {
    try { await api('/api/host/match/play-clip', { side: 'right', action: 'play' }); } catch (e) { toast(e.message); }
  });
  $('ctl-pause-clips').addEventListener('click', async () => {
    try {
      await api('/api/host/match/play-clip', { side: 'left', action: 'pause' });
      await api('/api/host/match/play-clip', { side: 'right', action: 'pause' });
    } catch (e) { toast(e.message); }
  });
  $('ctl-vote-start').addEventListener('click', async () => {
    const sec = parseInt($('ctl-duration').value, 10) || 60;
    try {
      await api('/api/host/match/voting/start', { durationMs: sec * 1000 });
      toast('Votación abierta');
    } catch (e) { toast(e.message); }
  });
  $('ctl-vote-end').addEventListener('click', async () => {
    try { await api('/api/host/match/voting/end', {}); toast('Votación cerrada'); } catch (e) { toast(e.message); }
  });
  $('ctl-decide-left').addEventListener('click', async () => {
    if (!confirm('Confirmar ganador IZQ?')) return;
    try { await api('/api/host/match/decide', { matchId: selectedMatchId, winnerSide: 'left' }); toast('Ganador IZQ ✓'); selectedMatchId = null; }
    catch (e) { toast(e.message); }
  });
  $('ctl-decide-right').addEventListener('click', async () => {
    if (!confirm('Confirmar ganador DER?')) return;
    try { await api('/api/host/match/decide', { matchId: selectedMatchId, winnerSide: 'right' }); toast('Ganador DER ✓'); selectedMatchId = null; }
    catch (e) { toast(e.message); }
  });

  $('btn-reset').addEventListener('click', async () => {
    if (!confirm('Esto borra el bracket y todos los resultados. Seguro?')) return;
    try { await api('/api/host/reset', {}); toast('Reseteado'); selectedMatchId = null; }
    catch (e) { toast(e.message); }
  });

  // ============= Live poll =============
  function renderLivePoll() {
    const wrap = $('live-poll');
    if (!pollState) {
      wrap.innerHTML = '<p class="empty">Sin votación activa.</p>';
      return;
    }
    const t = pollState.totals;
    const grand = Math.max(1, t.grandTotal);
    const leftPct  = ((t.leftTotal  / grand) * 100).toFixed(1);
    const rightPct = ((t.rightTotal / grand) * 100).toFixed(1);
    const remaining = Math.ceil((pollState.remainingMs || 0) / 1000);
    wrap.innerHTML = `
      <div class="row"><div class="label">IZQ</div><div class="bar"><div class="b-cuba" style="width:${(pollState.votes.cuba.left / grand * 100).toFixed(1)}%"></div></div><div class="count">${t.leftTotal} (${leftPct}%)</div></div>
      <div class="row"><div class="label">DER</div><div class="bar"><div class="b-pr" style="width:${(pollState.votes.pr.right / grand * 100).toFixed(1)}%"></div></div><div class="count">${t.rightTotal} (${rightPct}%)</div></div>
      <div class="row" style="border-top:2px dashed #ccc; padding-top:6px;">
        <div class="label">Cuba</div><div></div><div class="count">${t.cubaTotal}</div>
      </div>
      <div class="row"><div class="label">PR</div><div></div><div class="count">${t.prTotal}</div></div>
      <div class="row"><div class="label">Total</div><div></div><div class="count">${t.grandTotal} · ${remaining}s</div></div>
    `;
  }

  // ============= Render orchestrator =============
  function renderAll() {
    if (!serverState) return;
    renderConnections();
    renderContestants();
    renderPairings();
    renderBracketRun();
    renderActiveMatch();
    refreshControlButtons();
  }

  // ============= Helpers =============
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ============= Boot =============
  wsConnect();
  tryResume();
})();
