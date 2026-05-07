/**
 * Show overlay — escucha el WS, renderiza el bracket sobre el pajaro y
 * abre el modal de match cuando el host arranca un preview/voting/result.
 *
 * Layout del bracket: posiciones fijas en porcentaje del viewport. Las
 * coordenadas estan calibradas para coincidir con la silueta del pajaro
 * en show.html.
 */

(() => {
  'use strict';

  // ============= Layout =============
  // Cada match tiene una posicion fija por (round, slot). Coordenadas en %
  // del viewport. Calibradas para coincidir con la silueta del pajaro
  // (alas que arrancan en ~13% y terminan en ~87%, alto util ~25-75%).
  const LAYOUT = {
    // Round 0 — octofinales (8): 4 por ala. La curva del ala es mas gruesa
    // en el medio que en los extremos, por eso slot 0 y 3 (top/bottom outer)
    // van mas adentro que slot 1 y 2 (medio del ala).
    0: [
      { top: 30, left: 17 },   // L slot 0 (top-outer)
      { top: 43, left: 13 },   // L slot 1
      { top: 56, left: 13 },   // L slot 2
      { top: 69, left: 17 },   // L slot 3 (bottom-outer)
      { top: 30, left: 83 },   // R slot 4 (mirror)
      { top: 43, left: 87 },   // R slot 5
      { top: 56, left: 87 },   // R slot 6
      { top: 69, left: 83 },   // R slot 7
    ],
    // Round 1 — cuartos (4)
    1: [
      { top: 36, left: 28 },   // L top
      { top: 63, left: 28 },   // L bottom
      { top: 36, left: 72 },   // R top
      { top: 63, left: 72 },   // R bottom
    ],
    // Round 2 — semis (2): a los lados del corazon
    2: [
      { top: 50, left: 39 },   // L wing champion
      { top: 50, left: 61 },   // R wing champion
    ],
    // Round 3 — final: justo abajo del corazon, sobre el cuerpo
    3: [
      { top: 65, left: 50 },
    ],
  };

  // ============= Estado local =============
  let serverState = null;
  let pollState = null;
  let voteTimerInterval = null;

  // Refs DOM
  const $ = (id) => document.getElementById(id);
  const elBracketLayer = $('bracket-layer');
  const elBracketLines = $('bracket-lines');
  const elModal = $('match-modal');
  const elPhaseTag = $('phase-tag');
  const elResultBanner = $('result-banner');
  const elWinnerName = $('winner-name');
  const elVoteRain = $('vote-rain');
  const elTimerFill = $('vote-timer-fill');
  const elTimerText = $('vote-timer-text');
  const elDotCuba = $('dot-cuba');
  const elDotPr = $('dot-pr');
  const elWsStatus = $('ws-status');

  // ============= WebSocket =============
  let ws = null;
  let reconnectTimer = null;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}`;
    ws = new WebSocket(url);
    ws.onopen = () => { elWsStatus.textContent = 'live'; };
    ws.onclose = () => {
      elWsStatus.textContent = 'desconectado…';
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 2000);
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'state':
        serverState = msg.state;
        renderEverything();
        break;
      case 'voting-start':
      case 'voting-update':
      case 'voting-end':
        pollState = msg.poll;
        renderModal();
        if (msg.lastVote) addFloatingVote(msg.lastVote);
        break;
      case 'clip-control':
        handleClipControl(msg);
        break;
    }
  }

  // ============= Render principal =============
  function renderEverything() {
    if (!serverState) return;
    renderConnections();
    renderBracket();
    renderModal();
    renderHeart();
  }

  function renderConnections() {
    const tw = serverState.twitchConnections || {};
    elDotCuba.classList.toggle('live', !!tw.cuba?.connected);
    elDotPr.classList.toggle('live',   !!tw.pr?.connected);
  }

  // ============= Bracket nodes =============
  function renderBracket() {
    const bracket = serverState.bracket;
    elBracketLayer.innerHTML = '';
    elBracketLines.innerHTML = '';
    if (!bracket) return;

    const cs = serverState.contestants || {};

    // 1) Renderizar cada match como nodo absolutamente posicionado
    const positionMap = new Map();   // matchId -> {top, left}
    for (let r = 0; r < bracket.rounds.length; r++) {
      const round = bracket.rounds[r];
      const layout = LAYOUT[r];
      for (let i = 0; i < round.length; i++) {
        const m = round[i];
        const pos = layout[i];
        positionMap.set(m.id, pos);

        const node = document.createElement('div');
        node.className = `match-node round-${r}`;
        if (m.status === 'active') node.classList.add('active');
        if (m.status === 'done')   node.classList.add('done');
        node.style.top  = pos.top + '%';
        node.style.left = pos.left + '%';

        node.appendChild(renderSlot(m.leftId, cs, m, 'left'));
        node.appendChild(renderSlot(m.rightId, cs, m, 'right'));
        elBracketLayer.appendChild(node);
      }
    }

    // 2) Renderizar lineas entre matches y su match padre
    const ns = 'http://www.w3.org/2000/svg';
    for (let r = 0; r < bracket.rounds.length; r++) {
      const round = bracket.rounds[r];
      for (const m of round) {
        if (!m.parentMatchId) continue;
        const a = positionMap.get(m.id);
        const b = positionMap.get(m.parentMatchId);
        if (!a || !b) continue;

        const line = document.createElementNS(ns, 'line');
        // Convertimos % a coordenadas viewBox (1600x900)
        line.setAttribute('x1', (a.left / 100 * 1600));
        line.setAttribute('y1', (a.top  / 100 * 900));
        line.setAttribute('x2', (b.left / 100 * 1600));
        line.setAttribute('y2', (b.top  / 100 * 900));
        if (m.status === 'done') line.classList.add('lit');
        elBracketLines.appendChild(line);
      }
    }
  }

  function renderSlot(contestantId, cs, match, side) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    if (!contestantId) {
      slot.textContent = 'TBD';
      return slot;
    }
    const c = cs[contestantId];
    if (c) {
      slot.classList.add('country-' + c.country);
      const flag = document.createElement('span');
      flag.className = 'flag ' + c.country;
      slot.appendChild(flag);
      const text = document.createElement('span');
      text.textContent = c.name;
      slot.appendChild(text);
    } else {
      slot.textContent = contestantId.slice(0, 8);
    }
    if (match.status === 'done') {
      if (match.winnerId === contestantId) slot.classList.add('winner');
      else                                 slot.classList.add('loser');
    }
    return slot;
  }

  function renderHeart() {
    const heart = document.getElementById('heart');
    if (!heart) return;
    if (serverState.bracket?.championId) {
      heart.classList.add('beating');
    } else {
      heart.classList.remove('beating');
    }
  }

  // ============= Modal =============
  function renderModal() {
    if (!serverState) return;
    const cur = serverState.currentMatch;
    if (!cur) {
      elModal.classList.add('hidden');
      stopVoteTimer();
      return;
    }
    const m = findMatch(cur.matchId);
    if (!m) { elModal.classList.add('hidden'); return; }

    const cs = serverState.contestants || {};
    const left  = cs[m.leftId];
    const right = cs[m.rightId];
    if (!left || !right) { elModal.classList.add('hidden'); return; }

    elModal.classList.remove('hidden');
    elModal.setAttribute('data-phase', cur.phase);
    elPhaseTag.textContent = cur.phase === 'preview' ? 'PREVIEW'
                          : cur.phase === 'voting'  ? 'VOTANDO'
                          :                            'RESULTADO';

    // Llenar contestants
    setContestant('left', left);
    setContestant('right', right);

    // Voto bars
    if (pollState && pollState.matchId === m.id) {
      updateBars(pollState);
    } else {
      resetBars();
    }

    // Result banner
    if (cur.phase === 'result' && m.status === 'done') {
      const winner = cs[m.winnerId];
      elWinnerName.textContent = winner ? winner.name : 'Ganador';
      elResultBanner.classList.remove('hidden');
    } else {
      elResultBanner.classList.add('hidden');
    }

    // Timer (solo durante voting)
    if (cur.phase === 'voting' && cur.deadlineAt) {
      startVoteTimer(cur.startedAt, cur.deadlineAt);
    } else {
      stopVoteTimer();
    }
  }

  function setContestant(side, c) {
    const photo = document.getElementById(`${side}-photo`);
    const name  = document.getElementById(`${side}-name`);
    const bio   = document.getElementById(`${side}-bio`);
    const flag  = document.getElementById(`${side}-flag`);
    if (photo) {
      if (c.photoUrl) photo.src = c.photoUrl;
      else photo.removeAttribute('src');
    }
    if (name) name.textContent = c.name || '—';
    if (bio)  bio.textContent  = c.bio || '';
    if (flag) {
      flag.textContent = c.country === 'cuba' ? 'CUBA' : 'PR';
      flag.classList.toggle('flag-cuba', c.country === 'cuba');
      flag.classList.toggle('flag-pr',   c.country === 'pr');
    }
    // Clip player — multi-format
    //  - iframe: YouTube, Vimeo, TikTok, Spotify, SoundCloud, IG, Drive, etc.
    //    Play/pause: setear src=autoplayUrl (play) o src='' (pause).
    //  - video / audio: HTML5 nativo, .play() / .pause() funcionan.
    //  - link: solo mostrar boton "Abrir link" (no se puede embed).
    const wrap = document.getElementById(`${side}-clip-wrap`);
    if (wrap) {
      wrap.innerHTML = '';
      if (!c.clipUrl) return;
      const kind = c.clipKind || 'link';
      if (kind === 'iframe') {
        const iframe = document.createElement('iframe');
        iframe.src = c.clipEmbed || c.clipUrl;
        iframe.id = `${side}-clip-el`;
        iframe.dataset.kind = 'iframe';
        iframe.dataset.embed = c.clipEmbed || '';
        iframe.dataset.autoplay = c.clipEmbedAutoplay || '';
        iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
        iframe.frameBorder = '0';
        iframe.style.cssText = 'width:100%; aspect-ratio:16/9; border-radius:6px; background:black; border:3px solid var(--ink);';
        wrap.appendChild(iframe);
      } else if (kind === 'video' || kind === 'audio') {
        const el = document.createElement(kind);
        el.src = c.clipUrl;
        el.controls = true;
        el.preload = 'metadata';
        el.id = `${side}-clip-el`;
        el.dataset.kind = kind;
        wrap.appendChild(el);
      } else {
        // 'link' — boton clickeable
        const a = document.createElement('a');
        a.href = c.clipUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = '🔗 Abrir cancion';
        a.style.cssText = 'display:block; padding:12px; text-align:center; background:var(--ink); color:var(--accent-yellow); border-radius:6px; text-decoration:none; font-family:Archivo Black;';
        wrap.appendChild(a);
      }
    }
  }

  function updateBars(poll) {
    if (!poll || !poll.totals) return;
    const t = poll.totals;
    const totalLeft  = t.leftTotal;
    const totalRight = t.rightTotal;
    const grand = Math.max(1, t.grandTotal);   // evitar div-by-zero
    // Barra del lado izquierdo: Cuba_left + PR_left, mostrando proporcion
    const leftBar  = document.getElementById('left-bar');
    const rightBar = document.getElementById('right-bar');
    if (leftBar) {
      const cubaWidth = (poll.votes.cuba.left  / grand * 100).toFixed(1);
      const prWidth   = (poll.votes.pr.left    / grand * 100).toFixed(1);
      leftBar.querySelector('.vote-bar-cuba').style.width = cubaWidth + '%';
      leftBar.querySelector('.vote-bar-pr').style.width   = prWidth + '%';
    }
    if (rightBar) {
      const cubaWidth = (poll.votes.cuba.right / grand * 100).toFixed(1);
      const prWidth   = (poll.votes.pr.right   / grand * 100).toFixed(1);
      rightBar.querySelector('.vote-bar-cuba').style.width = cubaWidth + '%';
      rightBar.querySelector('.vote-bar-pr').style.width   = prWidth + '%';
    }
    document.getElementById('left-cuba-count').textContent  = poll.votes.cuba.left;
    document.getElementById('left-pr-count').textContent    = poll.votes.pr.left;
    document.getElementById('left-total-count').textContent = totalLeft;
    document.getElementById('right-cuba-count').textContent = poll.votes.cuba.right;
    document.getElementById('right-pr-count').textContent   = poll.votes.pr.right;
    document.getElementById('right-total-count').textContent= totalRight;
  }

  function resetBars() {
    document.querySelectorAll('.vote-bar-cuba, .vote-bar-pr').forEach(el => el.style.width = '0%');
    ['left-cuba-count','left-pr-count','left-total-count',
     'right-cuba-count','right-pr-count','right-total-count'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '0';
    });
  }

  function startVoteTimer(startedAt, deadlineAt) {
    stopVoteTimer();
    const total = deadlineAt - startedAt;
    const tick = () => {
      const remaining = Math.max(0, deadlineAt - Date.now());
      const pct = (remaining / total) * 100;
      elTimerFill.style.width = pct + '%';
      const sec = Math.ceil(remaining / 1000);
      elTimerText.textContent = sec + 's';
      if (remaining <= 0) stopVoteTimer();
    };
    tick();
    voteTimerInterval = setInterval(tick, 200);
  }

  function stopVoteTimer() {
    if (voteTimerInterval) { clearInterval(voteTimerInterval); voteTimerInterval = null; }
  }

  // ============= Floating vote names =============
  function addFloatingVote(vote) {
    if (!vote || !elVoteRain) return;
    const el = document.createElement('span');
    el.className = 'name ' + vote.origin;
    el.textContent = vote.user;
    // Posicion horizontal segun side (left/right) + jitter vertical
    const xBase = vote.side === 'left' ? 15 : 75;
    el.style.left = (xBase + Math.random() * 10) + '%';
    el.style.bottom = (10 + Math.random() * 30) + '%';
    elVoteRain.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  // ============= Clip control (host triggers play/pause) =============
  function handleClipControl(msg) {
    const el = document.getElementById(`${msg.side}-clip-el`);
    if (!el) return;
    const kind = el.dataset.kind || el.tagName.toLowerCase();
    if (kind === 'iframe') {
      // Truco simple para play/pause sin postMessage APIs distintas por
      // plataforma: setear src al embed con autoplay (play) o cargar el
      // src base sin autoplay (pause). Para plataformas que no respetan
      // autoplay del query string, esto al menos recarga el clip.
      if (msg.action === 'play') {
        el.src = el.dataset.autoplay || el.dataset.embed;
      } else if (msg.action === 'pause') {
        // Reseteamos a embed sin autoplay para "parar" el video.
        el.src = el.dataset.embed;
      }
      return;
    }
    if (kind === 'video' || kind === 'audio') {
      if (msg.action === 'play') {
        el.play().catch(() => { /* autoplay puede estar bloqueado por el browser */ });
      } else if (msg.action === 'pause') {
        el.pause();
      }
    }
  }

  // ============= Helpers =============
  function findMatch(matchId) {
    if (!serverState?.bracket) return null;
    for (const round of serverState.bracket.rounds) {
      const m = round.find(x => x.id === matchId);
      if (m) return m;
    }
    return null;
  }

  // ============= Boot =============
  connect();
})();
