'use strict';
// perfil.js — página de perfil del usuario

(async function () {
  // ── helpers ──────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const fmtKm = m => m != null ? (m / 1000).toFixed(1) + ' km' : '—';
  const fmtGain = m => m != null ? Math.round(m) + ' m↑' : '—';
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  function setMsg(id, text, ok) {
    const el = $(id); if (!el) return;
    el.textContent = text; el.className = 'pf-msg ' + (ok ? 'ok' : 'err');
    if (ok) setTimeout(() => { el.textContent = ''; }, 3000);
  }

  async function api(url, opts = {}) {
    const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (r.status === 401) { location.href = '/login?next=/perfil'; throw new Error('401'); }
    return r;
  }

  // ── Auth check ───────────────────────────────────────────────────
  let gUser = null;
  try {
    const r = await fetch('/api/auth/me');
    if (!r.ok) { location.href = '/login?next=/perfil'; return; }
    gUser = await r.json();
  } catch { location.href = '/login?next=/perfil'; return; }

  // ── Tab switching ────────────────────────────────────────────────
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'rutas' && !gRutasLoaded) loadRutas();
      if (btn.dataset.tab === 'listas' && !gListasLoaded) loadListas();
      if (btn.dataset.tab === 'planeadas' && !gPlaneadasLoaded) loadPlaneadas();
      if (btn.dataset.tab === 'stats' && !gStatsLoaded) loadStats();
      if (btn.dataset.tab === 'logros' && !gLogrosLoaded) loadLogros();
    });
  });

  // ── Load profile ─────────────────────────────────────────────────
  let gProfile = null;
  async function loadProfile() {
    const r = await api('/api/profile/me');
    if (!r.ok) return;
    gProfile = await r.json();
    renderHeader(gProfile);
    fillForm(gProfile);
  }

  function renderHeader(p) {
    const dn = p.display_name || p.username;
    $('ph-displayname').textContent = dn;
    $('ph-username').textContent = '@' + p.username + (p.role === 'admin' ? ' · Admin' : '');
    if (p.bio) { $('ph-bio').textContent = p.bio; $('ph-bio').hidden = false; }
    if (p.avatar_url) {
      $('avatar-placeholder').outerHTML = `<img id="avatar-img" class="avatar-img" src="${esc(p.avatar_url)}" alt="Avatar">`;
    }
    // Keep the nav icon in sync after avatar/name changes
    if (window.gpxSetNavUser) window.gpxSetNavUser(p);
  }

  function fillForm(p) {
    $('inp-displayname').value = p.display_name || '';
    $('inp-bio').value        = p.bio || '';
    $('inp-username').value   = p.username;
    $('inp-email').value      = p.email;
    $('inp-created').value    = p.created_at || '';
  }

  // ── Avatar upload ────────────────────────────────────────────────
  $('avatar-edit-btn').addEventListener('click', () => $('avatar-input').click());
  $('avatar-input').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > 2 * 1024 * 1024) { alert('La imagen no puede superar 2 MB'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const b64 = reader.result.split(',')[1];
      try {
        const r = await api('/api/profile/avatar', {
          method: 'POST',
          body: JSON.stringify({ data: b64, mime: file.type })
        });
        if (!r.ok) { const e = await r.json(); alert(e.error || 'Error al subir imagen'); return; }
        const data = await r.json();
        // Update avatar display
        const existing = document.getElementById('avatar-img') || document.getElementById('avatar-placeholder');
        const img = document.createElement('img');
        img.id = 'avatar-img'; img.className = 'avatar-img';
        img.src = data.avatar_url + '?t=' + Date.now(); img.alt = 'Avatar';
        existing.replaceWith(img);
        // Refresh nav avatar
        if (gProfile) { gProfile.avatar_url = data.avatar_url; renderHeader(gProfile); }
      } catch (err) { if (err.message !== '401') alert('Error al subir imagen'); }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  // ── Save profile info ────────────────────────────────────────────
  $('btn-save-profile').addEventListener('click', async () => {
    const display_name = $('inp-displayname').value.trim();
    const bio = $('inp-bio').value.trim();
    try {
      const r = await api('/api/profile/me', {
        method: 'PATCH',
        body: JSON.stringify({ display_name, bio })
      });
      if (!r.ok) { const e = await r.json(); setMsg('msg-profile', e.error || 'Error', false); return; }
      setMsg('msg-profile', '¡Guardado!', true);
      $('ph-displayname').textContent = display_name || gProfile.username;
      if (bio) { $('ph-bio').textContent = bio; $('ph-bio').hidden = false; }
      else $('ph-bio').hidden = true;
      if (gProfile) { gProfile.display_name = display_name; gProfile.bio = bio; if (window.gpxSetNavUser) window.gpxSetNavUser(gProfile); }
    } catch (err) { if (err.message !== '401') setMsg('msg-profile', 'Error de red', false); }
  });

  // ── Change password ──────────────────────────────────────────────
  $('btn-save-pwd').addEventListener('click', async () => {
    const current = $('inp-cur-pwd').value;
    const next    = $('inp-new-pwd').value;
    const conf    = $('inp-conf-pwd').value;
    if (!current || !next) { setMsg('msg-pwd', 'Rellena todos los campos', false); return; }
    if (next !== conf)      { setMsg('msg-pwd', 'Las contraseñas no coinciden', false); return; }
    if (next.length < 6)   { setMsg('msg-pwd', 'Mínimo 6 caracteres', false); return; }
    try {
      const r = await api('/api/profile/password', {
        method: 'POST',
        body: JSON.stringify({ current, next })
      });
      if (!r.ok) { const e = await r.json(); setMsg('msg-pwd', e.error || 'Error', false); return; }
      setMsg('msg-pwd', '¡Contraseña actualizada!', true);
      $('inp-cur-pwd').value = $('inp-new-pwd').value = $('inp-conf-pwd').value = '';
    } catch (err) { if (err.message !== '401') setMsg('msg-pwd', 'Error de red', false); }
  });

  // ── Logout ───────────────────────────────────────────────────────
  $('btn-logout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.href = '/login';
  });

  // ── Mis rutas ────────────────────────────────────────────────────
  let gRutasLoaded = false;
  let gRutas = [];

  function routeRow(t) {
    const isPub = t.visibility === 'public';
    const km = t.distance != null ? t.distance.toFixed(1) : '—';
    const gain = t.elevation_gain != null ? Math.round(t.elevation_gain) : '—';
    return `<tr data-id="${t.id}">
      <td>
        <div class="rt-name"><a href="/track?id=${t.id}" target="_blank">${esc(t.name || '(sin nombre)')}</a></div>
        <div class="rt-meta">${esc(t.sierra || '')}${t.sierra && t.date ? ' · ' : ''}${t.date || ''}</div>
      </td>
      <td style="color:var(--ink-2)">${esc(t.activity || '—')}</td>
      <td style="text-align:right;color:var(--ink-2)">${km}</td>
      <td style="text-align:right;color:var(--ink-2)">${gain}</td>
      <td>
        <button class="rt-badge ${isPub ? 'pub' : 'priv'}" data-vis="${isPub ? 'public' : 'private'}" data-id="${t.id}" title="Clic para cambiar">
          ${isPub ? '🌐 Pública' : '🔒 Privada'}
        </button>
      </td>
    </tr>`;
  }

  async function loadRutas() {
    gRutasLoaded = true;
    try {
      const r = await api('/api/profile/tracks');
      if (!r.ok) return;
      gRutas = await r.json();
      renderRutas(gRutas);
    } catch {}
  }

  function renderRutas(list) {
    $('rutas-count').textContent = list.length;
    const tbody = $('rutas-tbody');
    if (!list.length) { tbody.innerHTML = ''; $('rutas-empty').hidden = false; return; }
    $('rutas-empty').hidden = true;
    tbody.innerHTML = list.map(routeRow).join('');
  }

  document.addEventListener('click', async e => {
    const btn = e.target.closest('.rt-badge[data-id]');
    if (!btn) return;
    const id = parseInt(btn.dataset.id);
    const cur = btn.dataset.vis;
    const next = cur === 'public' ? 'private' : 'public';
    try {
      const r = await api(`/api/profile/tracks/${id}/visibility`, {
        method: 'PATCH', body: JSON.stringify({ visibility: next })
      });
      if (!r.ok) return;
      // Update local data + re-render row
      const t = gRutas.find(x => x.id === id);
      if (t) { t.visibility = next; }
      const tr = document.querySelector(`tr[data-id="${id}"]`);
      if (tr) { const isPub = next === 'public'; tr.querySelector('.rt-badge').outerHTML =
        `<button class="rt-badge ${isPub ? 'pub' : 'priv'}" data-vis="${next}" data-id="${id}" title="Clic para cambiar">${isPub ? '🌐 Pública' : '🔒 Privada'}</button>`; }
    } catch {}
  });

  $('rutas-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    const filtered = q ? gRutas.filter(t => (t.name || '').toLowerCase().includes(q) || (t.activity || '').toLowerCase().includes(q) || (t.sierra || '').toLowerCase().includes(q)) : gRutas;
    renderRutas(filtered);
  });

  // ── Mis listas ───────────────────────────────────────────────────
  let gListasLoaded = false;
  let gListas = [];

  async function loadListas() {
    gListasLoaded = true;
    try {
      const r = await api('/api/lists');
      if (!r.ok) return;
      gListas = await r.json();
      renderListas();
      loadSharedLists();
    } catch {}
  }

  function renderListas() {
    const grid = $('lists-grid');
    if (!gListas.length) { $('lists-empty').hidden = false; grid.innerHTML = ''; grid.appendChild($('lists-empty')); return; }
    $('lists-empty').hidden = true;
    grid.innerHTML = gListas.map(l => `
      <div class="list-card" data-lid="${l.id}">
        <div class="list-card-head">
          <span class="list-card-name">${esc(l.name)}</span>
          ${l.visibility === 'public' ? '<span class="list-badge pub">Pública</span>' : ''}
          ${l.share_count ? `<span class="list-badge shared">${l.share_count} compartida${l.share_count !== 1 ? 's' : ''}</span>` : ''}
          <span class="list-card-count">${l.track_count} ruta${l.track_count !== 1 ? 's' : ''}</span>
          <button class="btn btn-sm btn-outline" data-share-list="${l.id}" style="margin-left:4px" title="Compartir">Compartir</button>
          <button class="btn btn-sm btn-outline btn-danger" data-del-list="${l.id}" title="Eliminar lista">✕</button>
        </div>
        ${l.description ? `<div class="list-card-desc">${esc(l.description)}</div>` : ''}
        <div class="list-share" id="list-share-${l.id}"></div>
        <div class="list-detail" id="list-detail-${l.id}">
          <div class="bar-chart" id="list-tracks-${l.id}"><span style="color:var(--muted);font-size:12px">Cargando…</span></div>
        </div>
      </div>`).join('');
  }

  // ── Compartir listas ──
  async function openSharePanel(lid) {
    const panel = $('list-share-' + lid);
    if (panel.classList.contains('open')) { panel.classList.remove('open'); return; }
    panel.classList.add('open');
    const l = gListas.find(x => x.id === lid);
    panel.innerHTML = `
      <label class="share-toggle"><input type="checkbox" id="pub-${lid}" ${l.visibility === 'public' ? 'checked' : ''}> Lista pública (cualquier usuario con sesión puede verla)</label>
      <div id="shares-${lid}"><span style="color:var(--muted);font-size:12px">Cargando…</span></div>
      <div class="share-add">
        <input type="text" id="shareu-${lid}" placeholder="usuario a invitar…" autocomplete="off">
        <label style="font-size:12px;display:flex;align-items:center;gap:4px"><input type="checkbox" id="sharee-${lid}"> puede editar</label>
        <button class="btn btn-sm" data-add-share="${lid}">Invitar</button>
      </div>`;
    $('pub-' + lid).addEventListener('change', async e => {
      try {
        await api(`/api/lists/${lid}`, { method: 'PATCH', body: JSON.stringify({ visibility: e.target.checked ? 'public' : 'private' }) });
        l.visibility = e.target.checked ? 'public' : 'private';
        updateListBadges(lid);
      } catch {}
    });
    loadShares(lid);
  }

  // Update the public/shared badges of one card without closing its panel
  function updateListBadges(lid) {
    const l = gListas.find(x => x.id === lid);
    const head = document.querySelector(`.list-card[data-lid="${lid}"] .list-card-head`);
    if (!l || !head) return;
    head.querySelectorAll('.list-badge').forEach(b => b.remove());
    const name = head.querySelector('.list-card-name');
    const add = html => name.insertAdjacentHTML('afterend', html);
    if (l.share_count) add(`<span class="list-badge shared">${l.share_count} compartida${l.share_count !== 1 ? 's' : ''}</span>`);
    if (l.visibility === 'public') add('<span class="list-badge pub">Pública</span>');
  }

  async function loadShares(lid) {
    const box = $('shares-' + lid); if (!box) return;
    try {
      const shares = await (await api(`/api/lists/${lid}/shares`)).json();
      box.innerHTML = shares.length
        ? shares.map(s => `<div class="share-row"><span class="su">@${esc(s.username)}${s.can_edit ? ' <span style="color:var(--muted)">(edita)</span>' : ''}</span><button class="btn btn-sm btn-outline btn-danger" data-rm-share="${lid}:${s.user_id}">Quitar</button></div>`).join('')
        : '<span style="color:var(--muted);font-size:12px">Nadie invitado todavía</span>';
    } catch {}
  }

  $('lists-grid').addEventListener('click', async e => {
    // Share panel toggle
    const shareBtn = e.target.closest('[data-share-list]');
    if (shareBtn) { e.stopPropagation(); openSharePanel(parseInt(shareBtn.dataset.shareList)); return; }
    // Add a share
    const addBtn = e.target.closest('[data-add-share]');
    if (addBtn) {
      e.stopPropagation();
      const lid = parseInt(addBtn.dataset.addShare);
      const username = $('shareu-' + lid).value.trim();
      if (!username) return;
      try {
        const r = await api(`/api/lists/${lid}/shares`, { method: 'POST', body: JSON.stringify({ username, can_edit: $('sharee-' + lid).checked }) });
        if (!r.ok) { const er = await r.json(); alert(er.error || 'Error'); return; }
        $('shareu-' + lid).value = '';
        const l = gListas.find(x => x.id === lid); if (l) l.share_count = (l.share_count || 0) + 1;
        updateListBadges(lid); loadShares(lid);
      } catch {}
      return;
    }
    // Remove a share
    const rmBtn = e.target.closest('[data-rm-share]');
    if (rmBtn) {
      e.stopPropagation();
      const [lid, uid] = rmBtn.dataset.rmShare.split(':').map(Number);
      try {
        await api(`/api/lists/${lid}/shares/${uid}`, { method: 'DELETE' });
        const l = gListas.find(x => x.id === lid); if (l) l.share_count = Math.max(0, (l.share_count || 0) - 1);
        updateListBadges(lid); loadShares(lid);
      } catch {}
      return;
    }
    // Delete list
    const delBtn = e.target.closest('[data-del-list]');
    if (delBtn) {
      e.stopPropagation();
      const lid = parseInt(delBtn.dataset.delList);
      if (!confirm('¿Eliminar esta lista?')) return;
      try {
        await api(`/api/lists/${lid}`, { method: 'DELETE' });
        gListas = gListas.filter(l => l.id !== lid);
        renderListas();
      } catch {}
      return;
    }
    // Expand list card
    const card = e.target.closest('.list-card[data-lid]');
    if (!card) return;
    const lid = parseInt(card.dataset.lid);
    const detail = $('list-detail-' + lid);
    if (!detail) return;
    const open = detail.classList.toggle('open');
    if (open) loadListTracks(lid);
  });

  async function loadListTracks(lid, readOnly) {
    const container = $((readOnly ? 'shared-tracks-' : 'list-tracks-') + lid); if (!container) return;
    try {
      const r = await api(`/api/lists/${lid}/tracks`); if (!r.ok) return;
      const tracks = (await r.json()).tracks || [];
      if (!tracks.length) { container.innerHTML = '<span style="color:var(--muted);font-size:12px">Lista vacía</span>'; return; }
      container.innerHTML = tracks.map(t => `
        <div class="bar-row" style="align-items:center;gap:8px">
          <a href="/track?id=${t.id}" target="_blank" style="flex:1;font-size:13px;color:var(--ink);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name || '(sin nombre)')}</a>
          <span style="font-size:11px;color:var(--muted)">${t.distance != null ? t.distance.toFixed(1)+' km' : ''}</span>
          ${readOnly ? '' : `<button class="btn btn-sm btn-outline btn-danger" data-del-track="${t.id}" data-list="${lid}" style="padding:2px 8px;font-size:11px" title="Quitar de la lista">✕</button>`}
        </div>`).join('');
    } catch {}
  }

  // ── Listas compartidas conmigo ──
  async function loadSharedLists() {
    try {
      const r = await api('/api/lists/shared'); if (!r.ok) return;
      const shared = await r.json();
      const grid = $('shared-grid');
      $('shared-title').hidden = !shared.length;
      grid.innerHTML = shared.map(l => `
        <div class="list-card" data-shared="${l.id}">
          <div class="list-card-head">
            <span class="list-card-name">${esc(l.name)}</span>
            ${l.can_edit ? '<span class="list-badge shared">puedes editar</span>' : ''}
            ${l.visibility === 'public' && !l.shared_with_me ? '<span class="list-badge pub">Pública</span>' : ''}
            <span class="list-card-count">${l.track_count} ruta${l.track_count !== 1 ? 's' : ''} · de @${esc(l.owner_username)}</span>
          </div>
          ${l.description ? `<div class="list-card-desc">${esc(l.description)}</div>` : ''}
          <div class="list-detail" id="shared-detail-${l.id}">
            <div class="bar-chart" id="shared-tracks-${l.id}"><span style="color:var(--muted);font-size:12px">Cargando…</span></div>
          </div>
        </div>`).join('');
    } catch {}
  }

  $('shared-grid').addEventListener('click', e => {
    const card = e.target.closest('.list-card[data-shared]'); if (!card) return;
    const lid = parseInt(card.dataset.shared);
    const detail = $('shared-detail-' + lid); if (!detail) return;
    if (detail.classList.toggle('open')) loadListTracks(lid, true);
  });

  $('lists-grid').addEventListener('click', async e => {
    const btn = e.target.closest('[data-del-track]');
    if (!btn) return;
    e.stopPropagation();
    const tid = parseInt(btn.dataset.delTrack);
    const lid = parseInt(btn.dataset.list);
    try {
      await api(`/api/lists/${lid}/tracks/${tid}`, { method: 'DELETE' });
      await loadListTracks(lid);
      // Update count
      const l = gListas.find(x => x.id === lid);
      if (l) { l.track_count = Math.max(0, l.track_count - 1); const el = document.querySelector(`[data-lid="${lid}"] .list-card-count`); if (el) el.textContent = l.track_count + ' ruta' + (l.track_count !== 1 ? 's' : ''); }
    } catch {}
  });

  $('btn-create-list').addEventListener('click', async () => {
    const name = $('inp-list-name').value.trim();
    const description = $('inp-list-desc').value.trim();
    if (!name) { setMsg('msg-list', 'El nombre es obligatorio', false); return; }
    try {
      const r = await api('/api/lists', { method: 'POST', body: JSON.stringify({ name, description }) });
      if (!r.ok) { const e = await r.json(); setMsg('msg-list', e.error || 'Error', false); return; }
      const lista = await r.json();
      gListas.unshift(lista);
      renderListas();
      $('inp-list-name').value = $('inp-list-desc').value = '';
      setMsg('msg-list', '¡Lista creada!', true);
    } catch {}
  });

  // ── Planeadas ────────────────────────────────────────────────────
  let gPlaneadasLoaded = false;

  async function loadPlaneadas() {
    gPlaneadasLoaded = true;
    try {
      const r = await api('/api/profile/tracks');
      if (!r.ok) return;
      const all = await r.json();
      const planned = all.filter(t => t.planned);
      const tbody = $('planeadas-tbody');
      if (!planned.length) { tbody.innerHTML = ''; $('planeadas-empty').hidden = false; return; }
      $('planeadas-empty').hidden = true;
      tbody.innerHTML = planned.map(t => {
        const km = t.distance != null ? t.distance.toFixed(1) : '—';
        const gain = t.elevation_gain != null ? Math.round(t.elevation_gain) : '—';
        return `<tr data-id="${t.id}">
          <td><div class="rt-name"><a href="/track?id=${t.id}" target="_blank">${esc(t.name || '(sin nombre)')}</a></div></td>
          <td style="color:var(--ink-2)">${esc(t.activity || '—')}</td>
          <td style="text-align:right;color:var(--ink-2)">${km}</td>
          <td style="text-align:right;color:var(--ink-2)">${gain}</td>
          <td><button class="btn btn-sm btn-outline" data-unplan="${t.id}">Marcar realizada</button></td>
        </tr>`;
      }).join('');
    } catch {}
  }

  $('planeadas-tbody').addEventListener('click', async e => {
    const btn = e.target.closest('[data-unplan]');
    if (!btn) return;
    const id = parseInt(btn.dataset.unplan);
    try {
      await api(`/api/profile/tracks/${id}/planned`, { method: 'PATCH', body: JSON.stringify({ planned: false }) });
      const tr = document.querySelector(`#planeadas-tbody tr[data-id="${id}"]`);
      if (tr) tr.remove();
      const remaining = $('planeadas-tbody').querySelectorAll('tr');
      if (!remaining.length) $('planeadas-empty').hidden = false;
    } catch {}
  });

  // ── Estadísticas ─────────────────────────────────────────────────
  let gStatsLoaded = false;

  async function loadStats() {
    gStatsLoaded = true;
    try {
      const r = await api('/api/profile/stats');
      if (!r.ok) return;
      const { totals, byActivity, byYear } = await r.json();
      renderTotals(totals);
      renderBarChart('chart-activity', byActivity, a => esc(a.activity), a => Number(a.km), a => `${fmtKmN(a.km)} · ${a.count} rutas`);
      renderBarChart('chart-year', byYear, a => String(a.year), a => Number(a.km), a => `${fmtKmN(a.km)} · ${a.count} rutas`);
    } catch {}
  }

  const fmtN = n => n == null ? '—' : Number(n).toLocaleString('es');
  const fmtKmN = n => n == null ? '—' : Number(n).toLocaleString('es', { maximumFractionDigits: 0 }) + ' km';
  const fmtGainN = n => n == null ? '—' : Number(n).toLocaleString('es') + ' m';

  function renderTotals(t) {
    if (!t) return;
    $('stats-totals').innerHTML = [
      { val: fmtN(t.total_tracks),  lbl: 'Rutas totales' },
      { val: fmtKmN(t.total_km),    lbl: 'Kilómetros totales' },
      { val: fmtGainN(t.total_gain), lbl: 'Desnivel acumulado' },
      { val: fmtN(t.circular),       lbl: 'Rutas circulares' },
    ].map(s => `<div class="stat-box"><div class="stat-val">${s.val}</div><div class="stat-lbl">${s.lbl}</div></div>`).join('');
  }

  function renderBarChart(containerId, data, labelFn, valFn, hintFn) {
    const el = $(containerId); if (!el) return;
    if (!data || !data.length) { el.innerHTML = '<span style="color:var(--muted);font-size:12px">Sin datos</span>'; return; }
    const max = Math.max(...data.map(valFn)) || 1;
    el.innerHTML = data.map(d => {
      const pct = Math.max(2, Math.round((valFn(d) / max) * 100));
      return `<div class="bar-row" title="${hintFn(d)}">
        <div class="bar-label">${labelFn(d)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="bar-val">${fmtKmN(valFn(d))}</div>
      </div>`;
    }).join('');
  }

  // ── Logros ───────────────────────────────────────────────────────
  let gLogrosLoaded = false;
  async function loadLogros() {
    gLogrosLoaded = true;
    try {
      const r = await api('/api/profile/achievements'); if (!r.ok) return;
      const d = await r.json();
      $('lv-num').textContent = d.level;
      $('lv-num2').textContent = d.level;
      $('lv-fill').style.width = Math.round(((d.xp - d.xpCur) / (d.xpNext - d.xpCur)) * 100) + '%';
      $('lv-sub').textContent = `${d.xp.toLocaleString('es')} XP · faltan ${(d.xpNext - d.xp).toLocaleString('es')} para el nivel ${d.level + 1} · ${d.unlocked}/${d.total} insignias`;
      $('ach-grid').innerHTML = d.achievements.map(a => {
        const val = a.value.toLocaleString('es');
        const prog = a.max ? `¡Completado! ${val} ${a.unit}`
          : `${val} / ${a.next.toLocaleString('es')} ${a.unit}`;
        const pips = [1, 2, 3, 4, 5].map(i => `<span class="ach-pip${i <= a.level ? ' on' : ''}"></span>`).join('');
        return `<div class="ach${a.level ? '' : ' locked'}">
          <div class="ach-head"><span class="ach-icon">${gpxIcon(a.icon, { size: 22 })}</span>
            <div style="min-width:0"><div class="ach-name">${esc(a.name)}</div>
            <span class="ach-tier t${a.level}">${a.tier || 'Bloqueado'}</span></div></div>
          <div class="ach-pips" title="Nivel ${a.level}/5">${pips}</div>
          <div class="ach-prog">${prog}</div>
        </div>`;
      }).join('');
      const md = d.multiDayRoutes || [];
      $('ach-multiday').hidden = !md.length;
      if (md.length) $('ach-multiday').innerHTML = `🏕️ Rutas detectadas como de varios días (${md.length}): ` +
        md.slice(0, 8).map(m => `<a href="/track?id=${m.id}" target="_blank">${esc(m.name)}</a> (~${m.estDays} días)`).join(', ') + (md.length > 8 ? '…' : '');
    } catch {}
  }

  // ── Init ─────────────────────────────────────────────────────────
  await loadProfile();

})();
