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
  // Cada match (id sera asignado al construir el bracket) tiene una posicion
  // fija. Aca solo definimos la posicion por (round, slot).
  // Coordenadas en % del viewport — top, left.
  const LAYOUT = {
    // Round 0 — octofinales (8 matches): 4 sobre cada ala, hacia el borde exterior
    0: [
      { top: 22, left:  9 },   // L0
      { top: 38, left:  6 },   // L1
      { top: 58, left:  6 },   // L2
      { top: 74, left:  9 },   // L3
      { top: 22, left: 91 },   // R0
      { top: 38, left: 94 },   // R1
      { top: 58, left: 94 },   // R2
      { top: 74, left: 91 },   // R3
    ],
    // Round 1 — cuartos (4): mas hacia el centro
    1: [
      { top: 30, left: 24 },   // L
      { top: 66, left: 24 },   // L
      { top: 30, left: 76 },   // R
      { top: 66, left: 76 },   // R
    ],
    // Round 2 — semis (2)
    2: [
      { top: 48, left: 36 },   // L (campeon ala izq)
      { top: 48, left: 64 },   // R (campeon ala der)
    ],
    // Round 3 — final
    3: [
      { top: 56, left: 50 },
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
    // Clip player
    const wrap = document.getElementById(`${side}-clip-wrap`);
    if (wrap) {
      wrap.innerHTML = '';
      if (c.clipUrl) {
        const tag = c.clipType === 'video' ? 'video' : 'audio';
        const el = document.createElement(tag);
        el.src = c.clipUrl;
        el.controls = true;
        el.preload = 'metadata';
        el.id = `${side}-clip-el`;
        wrap.appendChild(el);
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
    if (msg.action === 'play') {
      // Mejor esfuerzo: ambas browser sources arrancan a la vez. Hay drift
      // de red ~100-300ms entre los dos OBS — flagged en el README.
      el.play().catch(() => { /* autoplay puede estar bloqueado */ });
    } else if (msg.action === 'pause') {
      el.pause();
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
