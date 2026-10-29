'use strict';
// Shared list page (/lista?id=N): anyone the list is shared with, or any user if it is public.
(async function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf1 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
  const toast = msg => { const t = $('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2200); };
  const fail = (title, text) => {
    $('lista-error').innerHTML = `<h2>${esc(title)}</h2><p>${esc(text)}</p><p><a href="/" style="color:var(--accent)">Ir al visor</a></p>`;
    $('lista-error').hidden = false;
  };

  const id = parseInt(new URLSearchParams(location.search).get('id'));
  if (!id) return fail('Falta la lista', 'El enlace no indica qué lista abrir.');

  const r = await fetch(`/api/lists/${id}`);
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    return fail(r.status === 404 ? 'Lista no encontrada' : 'No tienes acceso', d.error || 'Pide al dueño que la comparta contigo.');
  }
  const list = await r.json();
  const [{ tracks }, catalog, acts] = await Promise.all([
    fetch(`/api/lists/${id}/tracks`).then(r => r.json()),
    fetch('/api/catalog').then(r => r.json()).catch(() => []),
    fetch('/api/config/activities').then(r => r.json()).catch(() => []),
  ]);
  const geo = new Map(catalog.map(t => [t.id, t]));
  const colorOf = Object.fromEntries((acts || []).map(a => [a.name, a.color]));
  const canEdit = list.role === 'owner' || list.role === 'editor';

  document.title = `${list.name} — GPX Library`;
  $('l-name').textContent = list.name;
  const km = tracks.reduce((s, t) => s + (Number(t.distance) || 0), 0);
  const gain = tracks.reduce((s, t) => s + (Number(t.elevation_gain) || 0), 0);
  const roleTxt = { owner: 'Tuya', editor: 'Puedes editar', viewer: 'Solo lectura' }[list.role] || '';
  $('l-meta').innerHTML = [
    `<span>de <strong>${esc(list.owner_name || list.owner_username)}</strong></span>`,
    `<span class="badge">${list.visibility === 'public' ? 'Pública' : 'Privada'}</span>`,
    roleTxt ? `<span class="badge">${roleTxt}</span>` : '',
    `<span>${tracks.length} ruta${tracks.length === 1 ? '' : 's'} · ${nf0.format(km)} km · ${nf0.format(gain)} m+</span>`,
  ].join('');
  if (list.description) { $('l-desc').textContent = list.description; $('l-desc').hidden = false; }
  $('btn-edit').hidden = list.role !== 'owner';
  $('lista-body').hidden = false;

  $('btn-copy').addEventListener('click', async () => {
    const url = `${location.origin}/lista?id=${id}`;
    try { await navigator.clipboard.writeText(url); toast('Enlace copiado'); }
    catch { prompt('Copia el enlace:', url); }
  });

  // Map
  const map = L.map('lmap', { zoomControl: true });
  L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', { attribution: '© <a href="https://www.esri.com">Esri</a>, HERE, Garmin, © OpenStreetMap', maxZoom: 16 }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16 }),
  ]).addTo(map);
  const layers = new Map();
  const all = L.latLngBounds([]);
  for (const t of tracks) {
    const g = geo.get(t.id);
    if (!g || !g.points || g.points.length < 2) continue;
    const pts = g.points.map(p => [p[0], p[1]]);
    const c = colorOf[t.activity] || '#2563eb';
    const casing = L.polyline(pts, { color: '#555', weight: 5.5, opacity: 0.55, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(map);
    const line = L.polyline(pts, { color: c, weight: 3, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }).addTo(map);
    line.bindTooltip(esc(t.name), { sticky: true });
    line.on('click', () => { location.href = `/track?id=${t.id}`; });
    line.on('mouseover', () => highlight(t.id, true));
    line.on('mouseout', () => highlight(t.id, false));
    layers.set(t.id, { line, casing, c });
    all.extend(line.getBounds());
  }
  if (all.isValid()) map.fitBounds(all, { padding: [24, 24] });
  else map.setView([40.4, -3.7], 6);

  function highlight(tid, on) {
    const l = layers.get(tid);
    if (l) { l.line.setStyle({ weight: on ? 5 : 3, opacity: on ? 1 : 0.9 }); l.casing.setStyle({ weight: on ? 8 : 5.5 }); if (on) { l.casing.bringToFront(); l.line.bringToFront(); } }
    document.querySelector(`.lt-item[data-id="${tid}"]`)?.classList.toggle('hl', on);
  }

  // List
  const listEl = $('lt-list');
  if (!tracks.length) listEl.innerHTML = '<div class="lista-empty">Esta lista aún no tiene rutas.</div>';
  else listEl.innerHTML = tracks.map(t => {
    const c = layers.get(t.id)?.c || colorOf[t.activity] || 'var(--accent)';
    const sub = [t.activity, t.sierra, `${nf1.format(t.distance || 0)} km`, `${nf0.format(t.elevation_gain || 0)} m+`, t.date ? String(t.date).slice(0, 10) : null].filter(Boolean).join(' · ');
    return `<div class="lt-item" data-id="${t.id}" style="--c:${esc(c)}">
      <span class="lt-dot"></span>
      <div class="lt-main"><div class="lt-name">${esc(t.name)}</div><div class="lt-sub">${esc(sub)}</div></div>
      ${canEdit ? `<button class="btn btn-sm btn-ghost lt-rm" data-rm="${t.id}" title="Quitar de la lista">Quitar</button>` : ''}
    </div>`;
  }).join('');

  listEl.addEventListener('mouseover', e => { const it = e.target.closest('.lt-item'); if (it) highlight(+it.dataset.id, true); });
  listEl.addEventListener('mouseout', e => { const it = e.target.closest('.lt-item'); if (it) highlight(+it.dataset.id, false); });
  listEl.addEventListener('click', async e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      e.stopPropagation();
      const tid = +rm.dataset.rm;
      const res = await fetch(`/api/lists/${id}/tracks/${tid}`, { method: 'DELETE' });
      if (!res.ok) return toast('No se pudo quitar');
      rm.closest('.lt-item').remove();
      const l = layers.get(tid); if (l) { l.line.remove(); l.casing.remove(); }
      return toast('Ruta quitada de la lista');
    }
    const it = e.target.closest('.lt-item');
    if (it) location.href = `/track?id=${it.dataset.id}`;
  });
})();
