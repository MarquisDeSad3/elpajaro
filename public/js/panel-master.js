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

  const TOKEN_KEY = 'elpajaro.token.master';
  let token = localStorage.getItem(TOKEN_KEY) || null;
  let session = null;       // { role: 'cuba'|'pr'|'master' }
  let serverState = null;

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

  /* ===== Login =====
   * El master no sabe de antemano quien es el que se loguea — acepta los
   * dos PINs (cuba y pr) y el server le devuelve el rol asociado al pin
   * que el cliente envio. Probamos primero con role='cuba'; si falla,
   * probamos con 'pr'. Ese intento doble es el costo de tener un solo
   * input de PIN para una pantalla compartida.
   */
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = $('pin').value;
    $('login-error').textContent = '';
    for (const tryRole of ['cuba', 'pr', 'master']) {
      try {
        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin, role: tryRole }),
        });
        const data = await res.json();
        if (data.ok && data.token) {
          token = data.token;
          session = { role: data.role };
          localStorage.setItem(TOKEN_KEY, token);
          serverState = data.state;
          showMain();
          return;
        }
      } catch {}
    }
    $('login-error').textContent = 'PIN incorrecto.';
  });

  function logout(silent = false) {
    if (!silent) api('/api/admin/logout', {}).catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    token = null; session = null;
    showLogin();
  }
  $('btn-logout').addEventListener('click', () => logout());

  function showLogin() { $('login-screen').classList.remove('hidden'); $('main-panel').classList.add('hidden'); }
  function showMain()  { $('login-screen').classList.add('hidden'); $('main-panel').classList.remove('hidden'); renderAll(); }

  async function tryResume() {
    if (!token) { showLogin(); return; }
    try {
      const r = await api('/api/admin/validate', {});
      session = { role: r.role };
      serverState = r.state;
      // Update role tag color based on session role
      const tag = document.querySelector('.role-tag');
      if (tag) {
        tag.textContent = r.role.toUpperCase();
        tag.classList.remove('role-cuba', 'role-pr', 'role-master');
        tag.classList.add('role-' + r.role);
      }
      showMain();
    } catch { showLogin(); }
  }

  /* ===== Render slots ===== */
  function renderSlots(country) {
    const c = serverState?.countries?.[country];
    const grid = $(`slots-${country}`);
    grid.innerHTML = '';
    const team = c?.lockedTeam || [];
    // Si no esta lockeado, mostramos los que ya pasaron (eliminationDecision='passed')
    // Pero el snapshot publico no expone los submissions, asi que usamos lockedTeam
    // (el lock pone los 8 finalistas; antes del lock el array esta vacio).
    // Mostramos siempre 8 slots, llenos o vacios.
    for (let i = 0; i < 8; i++) {
      const id = team[i];
      const slot = document.createElement('div');
      const filledClass = id ? 'filled ' + country : 'empty';
      slot.className = 'slot ' + filledClass;
      slot.innerHTML = `
        <div class="num">${i + 1}</div>
        ${id ? renderContestantCell(id) : '<div class="name">—</div>'}
      `;
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

  function renderContestantCell(id) {
    const cs = serverState?.contestants;
    const c = cs && cs[id];
    if (c) {
      return `<div class="name">${escapeHtml(c.name)}</div>${c.bio ? `<div class="ig">${escapeHtml(c.bio)}</div>` : ''}`;
    }
    // No tenemos contestants poblado pre-show. El nombre vendria del lockedTeam ID.
    // Para mostrar el nombre real pre-show, necesitamos pedirlo al server.
    // Por ahora mostramos un placeholder que el WS update reemplazara cuando
    // el contestants este populado (al EMPEZAR show).
    return `<div class="name">FINALISTA</div><div class="ig">${id.slice(0, 6)}</div>`;
  }

  /* ===== Ready buttons ===== */
  function renderReady() {
    const cuba = serverState?.countries?.cuba;
    const pr   = serverState?.countries?.pr;
    const myRole = session?.role;

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
