'use strict';
// subir.js — asistente "Upload Trail": importar un GPX → vista previa → detalles + fotos.

(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  let gpxText = null;        // raw GPX of the chosen file
  let parsed = null;         // { name, pts:[[lat,lon,ele]], wpts:[{lat,lon,name}], distKm, gain }
  let map = null, polyline = null, overlay = null;
  let trackId = null;        // set once imported on the server
  let editingExisting = false;   // step 3 is editing a route the user already had
  let privacy = 'public';

  // ── Auth ──
  fetch('/api/auth/me').then(r => { if (!r.ok) location.href = '/login?next=/subir'; });

  // ── Stepper ──
  function goStep(n) {
    for (let i = 1; i <= 3; i++) {
      $('step-' + i).classList.toggle('active', i === n);
      const dot = document.querySelector(`.wz-step-dot[data-dot="${i}"]`);
      dot.classList.toggle('active', i === n);
      dot.classList.toggle('done', i < n);
    }
    if (n === 2) fitRoute();
  }

  // Leaflet needs the visible size of the container to compute the zoom: resize, then frame the route
  function fitRoute() {
    if (!map || !polyline) return;
    requestAnimationFrame(() => {
      map.invalidateSize();
      map.fitBounds(polyline.getBounds(), { padding: [24, 24], maxZoom: 16 });
    });
  }

  // ── Paso 1: elegir fichero ──
  const fileInput = $('gpx-file');
  $('src-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => { if (e.target.files[0]) readFile(e.target.files[0]); });

  const drop = $('src-import');
  ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) readFile(f); });

  function readFile(file) {
    $('step1-err').textContent = '';
    trackId = null; editingExisting = false;       // a new file starts a new import
    $('dup-panel').hidden = true; $('b2-next').hidden = false; $('import-log').textContent = '';
    if (!/\.gpx$/i.test(file.name)) { $('step1-err').textContent = 'Elige un archivo .gpx'; return; }
    const reader = new FileReader();
    reader.onload = () => {
      gpxText = reader.result;
      try { parsed = parseGpx(gpxText, file.name); }
      catch (err) { $('step1-err').textContent = 'No se pudo leer el GPX: ' + err.message; return; }
      if (!parsed.pts.length) { $('step1-err').textContent = 'El GPX no tiene puntos de track.'; return; }
      goStep(2);        // show the step first so the map container has its real size
      showPreview();
    };
    reader.readAsText(file);
  }

  // ── Parseo de GPX en el navegador ──
  function parseGpx(text, fileName) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('XML inválido');
    const pts = [...doc.querySelectorAll('trkpt')].map(p => [
      parseFloat(p.getAttribute('lat')), parseFloat(p.getAttribute('lon')),
      p.querySelector('ele') ? parseFloat(p.querySelector('ele').textContent) : null,
    ]).filter(p => isFinite(p[0]) && isFinite(p[1]));
    const wpts = [...doc.querySelectorAll('wpt')].map(w => ({
      lat: parseFloat(w.getAttribute('lat')), lon: parseFloat(w.getAttribute('lon')),
      name: (w.querySelector('name')?.textContent || '').trim(),
    })).filter(w => isFinite(w.lat) && isFinite(w.lon));
    let name = (doc.querySelector('trk > name, metadata > name, gpx > name')?.textContent || '').trim();
    if (!name) name = fileName.replace(/\.gpx$/i, '').replace(/[_-]+/g, ' ');
    // distancia + desnivel
    let dist = 0, gain = 0, prevEle = null;
    for (let i = 1; i < pts.length; i++) dist += haversine(pts[i - 1], pts[i]);
    for (const p of pts) { if (p[2] != null) { if (prevEle != null && p[2] - prevEle > 2) gain += p[2] - prevEle; prevEle = p[2]; } }
    return { name, pts, wpts, distKm: dist / 1000, gain: Math.round(gain) };
  }
  function haversine(a, b) {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // ── Paso 2: vista previa ──
  function showPreview() {
    $('pv-name').textContent = parsed.name;
    $('pv-dist').textContent = parsed.distKm.toFixed(1) + ' km';
    $('pv-gain').textContent = parsed.gain + ' m';
    $('pv-wptn').textContent = parsed.wpts.length;
    $('pv-wpts').innerHTML = parsed.wpts.slice(0, 20).map(w => `<span class="pv-wpt">${esc(w.name || '·')}</span>`).join('');
    if (!map) {
      map = L.map('subir-map', { scrollWheelZoom: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(map);
    }
    if (overlay) overlay.remove();
    overlay = L.layerGroup().addTo(map);
    const latlngs = parsed.pts.map(p => [p[0], p[1]]);
    polyline = L.polyline(latlngs, { color: '#006783', weight: 4 }).addTo(overlay);
    parsed.wpts.forEach(w => L.circleMarker([w.lat, w.lon], { radius: 4, color: '#f97316', fillOpacity: 1 }).addTo(overlay).bindTooltip(w.name || ''));
    map.fitBounds(polyline.getBounds(), { padding: [24, 24], maxZoom: 16 });   // initial view (no animation glitch)
    fitRoute();
  }

  $('b2-back').addEventListener('click', () => goStep(1));
  $('b2-next').addEventListener('click', importAndEdit);

  // ── Importar en el servidor y pasar a edición ──
  async function importAndEdit() {
    if (trackId) { goStep(3); return; }   // ya importado
    const btn = $('b2-next'); btn.disabled = true;
    const log = $('import-log'); log.textContent = 'Subiendo GPX…';
    try {
      const r = await runImport(false);
      if (r.dupId) { showDuplicate(r.dupId); log.textContent = ''; return; }
      if (!r.id) throw new Error(r.code === 0 ? 'La ruta no se importó' : 'La importación falló');
      trackId = r.id;
      await loadTrackIntoForm();
      goStep(3);
    } catch (err) {
      log.innerHTML = '<span style="color:var(--danger)">✗ ' + esc(err.message) + '</span>';
    } finally { btn.disabled = false; }
  }

  // Upload the GPX and import it. Returns { id } of the new track, or { dupId } when the user
  // already has the same file (allowDup imports it again as a separate copy).
  async function runImport(allowDup) {
    const log = $('import-log');
    log.textContent = 'Subiendo GPX…';
    const day = new Date().toISOString().slice(0, 10);
    const up = await fetch('/api/import/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/gpx+xml', 'X-Filename': `${day}_${slugify(parsed.name)}.gpx` }, body: gpxText,
    });
    if (!up.ok) throw new Error('Error al subir (HTTP ' + up.status + ')');
    const { filename: savedName } = await up.json();
    log.textContent = 'Importando (ubicación, zona, dificultad)…';
    const resp = await fetch('/api/db/import-temp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: [savedName], allow_dup: allowDup }),
    });
    if (!resp.ok || !resp.body) throw new Error('Error al importar (HTTP ' + resp.status + ')');
    const reader = resp.body.getReader(), dec = new TextDecoder();
    let buf = '', code = null, id = null, dupId = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n'); buf = parts.pop();
      for (const part of parts) {
        const dl = part.split('\n').find(l => l.startsWith('data:')); if (!dl) continue;
        let evt; try { evt = JSON.parse(dl.slice(5)); } catch { continue; }
        if (evt.text?.startsWith('IMPORTED_IDS:')) id = +evt.text.split(':')[1].split(',')[0];
        else if (evt.text?.startsWith('DUPLICATE_OWN:')) dupId = +evt.text.split(':')[1];
        else if (evt.type === 'done') code = evt.code;
      }
    }
    return { id, dupId, code };
  }

  // The user already has this exact route: edit that one, or import a second copy with another name
  async function showDuplicate(dupId) {
    let name = '';
    try { name = (await fetch(`/api/tracks/${dupId}`).then(r => r.json())).name || ''; } catch {}
    $('dup-name').textContent = name || `#${dupId}`;
    $('dup-name').href = `/track?id=${dupId}`;
    $('dup-copy-name').value = (parsed.name || name) + ' (copia)';
    $('dup-panel').hidden = false;
    $('b2-next').hidden = true;
    $('dup-edit').onclick = async () => {
      trackId = dupId; editingExisting = true;
      await loadTrackIntoForm();
      goStep(3);
    };
    $('dup-copy').onclick = async () => {
      const newName = $('dup-copy-name').value.trim();
      if (!newName) { $('dup-copy-name').focus(); return; }
      $('dup-copy').disabled = true;
      try {
        const r = await runImport(true);
        if (!r.id) throw new Error('La importación falló');
        trackId = r.id;
        await loadTrackIntoForm();
        $('f-name').value = newName;
        goStep(3);
      } catch (err) { $('import-log').innerHTML = '<span style="color:var(--danger)">✗ ' + esc(err.message) + '</span>'; }
      finally { $('dup-copy').disabled = false; }
    };
  }

  function slugify(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'ruta'; }

  // ── Paso 3: cargar precálculo + datalists ──
  async function loadTrackIntoForm() {
    const [t, acts, geo] = await Promise.all([
      fetch(`/api/tracks/${trackId}`).then(r => r.json()),
      fetch('/api/config/activities').then(r => r.json()).catch(() => []),
      fetch('/api/config/provinces').then(r => r.json()).catch(() => ({})),
    ]);
    $('f-name').value = t.name || parsed.name;
    $('f-desc').value = t.notes || '';
    $('f-activity').value = t.activity || '';
    $('f-sierra').value = t.sierra || '';
    $('pc-act').textContent = t.activity ? '✓ precalculada' : '';
    $('pc-sierra').textContent = t.sierra ? '✓ precalculada' : (t.province ? 'prov. ' + t.province : '');
    const ibp = t.ibp_hiking || t.ibp_bicycle || t.ibp_running;
    $('f-ibp').textContent = ibp ? Math.round(ibp) + ' IBP' : 'sin calcular';
    $('dl-activities').innerHTML = (acts || []).map(a => `<option value="${esc(a.name)}">`).join('');
    const sierras = (geo.zones || geo.sierras || []).concat(geo.provinces || []);
    $('dl-sierras').innerHTML = [...new Set(sierras)].map(s => `<option value="${esc(s)}">`).join('');
    // waypoints → descripción
    const wNames = (t.waypoints || parsed.wpts).map(w => w.name).filter(Boolean);
    if (wNames.length) {
      const fill = $('wpt-fill'); fill.hidden = false;
      fill.onclick = () => { const cur = $('f-desc').value.trim(); $('f-desc').value = (cur ? cur + '\n\n' : '') + 'Pasa por: ' + wNames.slice(0, 12).join(', ') + '.'; fill.hidden = true; };
    }
    // Existing photos (when editing a route the user already had) and its privacy
    renderPhotos(await fetch(`/api/tracks/${trackId}/photos`).then(r => (r.ok ? r.json() : [])).catch(() => []));
    privacy = t.visibility === 'private' ? 'private' : 'public';
    document.querySelectorAll('#f-priv .priv-opt').forEach(o => o.classList.toggle('sel', o.dataset.v === privacy));
    // Duration: what the user declared before, else preselect what the automatic detection says
    try {
      const d = await fetch(`/api/tracks/${trackId}/days`).then(r => r.json());
      const det = d.detected || {};
      const REASON = { 'días con actividad': 'según las horas del GPX', 'nombre': 'por el nombre',
                       'tiempo en movimiento': 'por el tiempo en movimiento', 'distancia y desnivel': 'por distancia y desnivel' };
      if (d.declared != null) setDays(d.declared === 1 ? '1' : 'multi', d.declared >= 2 ? d.declared : '');
      else setDays(det.multiDay ? 'multi' : '1', det.multiDay ? det.days : '');
      $('pc-days').textContent = det.multiDay ? `detectado: ${det.days} días ${REASON[det.reason] || ''}` : 'detectado: un día';
    } catch { setDays('1', ''); }
  }

  // ── Duración ──
  function setDays(mode, n) {
    document.querySelectorAll('#f-days .priv-opt').forEach(o => o.classList.toggle('sel', o.dataset.v === mode));
    $('f-days-num-wrap').hidden = mode !== 'multi';
    $('f-days-num').value = mode === 'multi' && n ? n : '';
  }
  $('f-days').addEventListener('click', e => {
    const opt = e.target.closest('.priv-opt'); if (!opt) return;
    setDays(opt.dataset.v, $('f-days-num').value);
    if (opt.dataset.v === 'multi') $('f-days-num').focus();
  });
  // Value for tracks.days_declared: 1 one day · N days · 0 several without a number
  function daysDeclared() {
    if (document.querySelector('#f-days .priv-opt.sel')?.dataset.v !== 'multi') return 1;
    const n = parseInt($('f-days-num').value);
    return n >= 2 ? Math.min(n, 365) : 0;
  }

  // ── Privacidad ──
  $('f-priv').addEventListener('click', e => {
    const opt = e.target.closest('.priv-opt'); if (!opt) return;
    privacy = opt.dataset.v;
    document.querySelectorAll('#f-priv .priv-opt').forEach(o => o.classList.toggle('sel', o === opt));
  });

  // ── Fotos ──
  let photos = [];   // [{id, url, thumb, is_cover}]
  function renderPhotos(list) {
    photos = list;
    const grid = $('ph-grid');
    grid.querySelectorAll('.ph-thumb').forEach(n => n.remove());
    const add = $('ph-add');
    for (const p of photos) {
      const d = document.createElement('div');
      d.className = 'ph-thumb' + (p.is_cover ? ' is-cover' : '');
      d.innerHTML = `<img src="${esc(p.thumb || p.url)}" alt="">` +
        `<button class="ph-cover" data-cover="${p.id}" title="${p.is_cover ? 'Portada de la ruta' : 'Usar como portada'}">${p.is_cover ? '★' : '☆'}</button>` +
        `<button class="ph-del" data-id="${p.id}" title="Quitar">✕</button>` +
        (p.is_cover ? '<span class="ph-cover-lbl">Portada</span>' : '');
      grid.insertBefore(d, add);
    }
    $('ph-hint').hidden = photos.length < 2;
  }
  $('ph-add').addEventListener('click', () => { if (!trackId) return; $('photo-file').click(); });
  $('photo-file').addEventListener('change', async e => {
    for (const file of [...e.target.files]) await uploadPhoto(file);
    e.target.value = '';
  });

  // Downscale in the browser: a web-sized photo (≤1600 px) and a thumbnail (≤480 px) for lists
  async function resizeImage(file, maxSide, quality) {
    const img = await new Promise((res, rej) => {
      const url = URL.createObjectURL(file), i = new Image();
      i.onload = () => { URL.revokeObjectURL(url); res(i); };
      i.onerror = () => { URL.revokeObjectURL(url); rej(new Error('No se pudo leer la imagen')); };
      i.src = url;
    });
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);   // JPEG has no transparency
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality).split(',')[1];
  }

  async function uploadPhoto(file) {
    $('step3-err').textContent = '';
    if (!/^image\//.test(file.type)) { $('step3-err').textContent = 'Solo imágenes'; return; }
    let data, thumb;
    try { data = await resizeImage(file, 1600, 0.85); thumb = await resizeImage(file, 480, 0.8); }
    catch (err) { $('step3-err').textContent = err.message; return; }
    try {
      const r = await fetch(`/api/tracks/${trackId}/photos`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data, thumb, mime: 'image/jpeg' }),
      });
      if (!r.ok) { const e = await r.json(); $('step3-err').textContent = e.error || 'Error al subir foto'; return; }
      const d = await r.json();
      const list = d.is_cover ? photos.map(p => ({ ...p, is_cover: false })) : photos;
      renderPhotos(list.concat([{ id: d.id, url: d.url, thumb: d.thumb, is_cover: d.is_cover }]));
    } catch { $('step3-err').textContent = 'Error de red al subir la foto'; }
  }

  $('ph-grid').addEventListener('click', async e => {
    const cov = e.target.closest('button[data-cover]');
    if (cov) {
      const id = +cov.dataset.cover;
      if (photos.find(p => p.id === id)?.is_cover) return;
      try {
        const r = await fetch(`/api/tracks/${trackId}/cover`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photo_id: id }) });
        if (r.ok) renderPhotos(photos.map(p => ({ ...p, is_cover: p.id === id })));
      } catch {}
      return;
    }
    const btn = e.target.closest('button[data-id]'); if (!btn) return;
    const id = +btn.dataset.id;
    try {
      const d = await fetch(`/api/photos/${id}`, { method: 'DELETE' }).then(r => r.json());
      renderPhotos(photos.filter(p => p.id !== id).map(p => ({ ...p, is_cover: d.cover_photo_id != null ? p.id === d.cover_photo_id : p.is_cover })));
    } catch {}
  });

  // ── Guardar ──
  $('b3-save').addEventListener('click', async () => {
    const btn = $('b3-save'); btn.disabled = true; $('step3-err').textContent = '';
    try {
      const patch = {
        name: $('f-name').value.trim(),
        notes: $('f-desc').value.trim(),
        activity: $('f-activity').value.trim(),
        sierra: $('f-sierra').value.trim(),
        days_declared: daysDeclared(),
      };
      await fetch(`/api/tracks/${trackId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      await fetch(`/api/profile/tracks/${trackId}/visibility`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visibility: privacy }) });
      if ($('f-planned').checked)
        await fetch(`/api/profile/tracks/${trackId}/planned`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planned: true }) }).catch(() => {});
      location.href = `/track?id=${trackId}`;
    } catch (err) { $('step3-err').textContent = 'No se pudo guardar: ' + err.message; btn.disabled = false; }
  });
})();
