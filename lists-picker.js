'use strict';
// «Guardar en lista»: centred modal shared by the visor and the route page. Needs icons.js.
// gpxListsPicker(trackId, { onChange(saved) }) — saved: the route is now in at least one list.
(function () {
  const ICO_BOOKMARK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
  const ICO_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const ICO_PLUS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  const DEFAULT_ICON = 'bookmark';
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const icon = (key, size = 18) => (window.gpxIcon ? window.gpxIcon(key || DEFAULT_ICON, { size }) : ICO_BOOKMARK);
  const toast = msg => { if (window.showToast) window.showToast(msg); };
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  window.gpxListIcon = icon;
  window.GPX_ICO_BOOKMARK = ICO_BOOKMARK;

  window.gpxListsPicker = function (trackId, { onChange } = {}) {
    let lists = [], newIcon = DEFAULT_ICON;
    const ov = document.createElement('div');
    ov.className = 'modal-overlay open lp-overlay';
    ov.innerHTML = `
      <div class="modal lp-modal" role="dialog" aria-modal="true" aria-labelledby="lp-title">
        <div class="modal-head">
          <span class="lp-head-ico">${ICO_BOOKMARK}</span>
          <div style="flex:1;min-width:0"><h3 id="lp-title">Guardar en lista</h3><div class="lp-sub">Pulsa una lista para añadir o quitar la ruta</div></div>
          <button class="icon-btn" data-close title="Cerrar" aria-label="Cerrar"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
        <div class="lp-body" id="lp-body"><div class="lp-empty">Cargando tus listas…</div></div>
        <div class="lp-new">
          <button type="button" class="gi-btn" id="lp-new-ico" title="Icono de la nueva lista">${icon(newIcon)}</button>
          <input class="input" id="lp-new-name" placeholder="Nueva lista…" maxlength="80">
          <button class="btn btn-primary" id="lp-new-btn">${ICO_PLUS}Crear y añadir</button>
        </div>
        <div class="modal-foot lp-foot">
          <a class="btn btn-ghost" href="/perfil#listas">Gestionar mis listas</a>
          <span style="flex:1"></span>
          <button class="btn" data-close>Hecho</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const $ = sel => ov.querySelector(sel);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-close]')) close(); });
    const notify = () => onChange && onChange(lists.some(l => l.has));

    function render() {
      const body = $('#lp-body');
      if (!lists.length) { body.innerHTML = '<div class="lp-empty">Todavía no tienes listas. Crea la primera abajo.</div>'; return; }
      body.innerHTML = lists.map(l => `
        <button class="lp-row${l.has ? ' on' : ''}" data-lid="${l.id}" aria-pressed="${l.has}">
          <span class="lp-ico">${icon(l.icon)}</span>
          <span class="lp-main"><span class="lp-name">${esc(l.name)}</span>
            <span class="lp-meta">${l.track_count} ruta${l.track_count === 1 ? '' : 's'}${l.visibility === 'public' ? ' · Pública' : ''}</span></span>
          <span class="lp-state">${l.has ? ICO_CHECK + 'Añadida' : ICO_PLUS + 'Añadir'}</span>
        </button>`).join('');
    }

    fetch(`/api/lists?track=${trackId}`).then(r => (r.ok ? r.json() : Promise.reject())).then(d => { lists = d; render(); })
      .catch(() => { $('#lp-body').innerHTML = '<div class="lp-empty lp-err">No se pudieron cargar tus listas.</div>'; });

    $('#lp-body').addEventListener('click', async e => {
      const row = e.target.closest('.lp-row'); if (!row || row.disabled) return;
      const l = lists.find(x => x.id === +row.dataset.lid); if (!l) return;
      row.disabled = true;
      try {
        const r = l.has
          ? await fetch(`/api/lists/${l.id}/tracks/${trackId}`, { method: 'DELETE' })
          : await post(`/api/lists/${l.id}/tracks`, { track_id: trackId });
        if (!r.ok && r.status !== 409) throw new Error();
        l.track_count += l.has ? -1 : 1;
        l.has = !l.has;
        toast(l.has ? `Añadida a «${l.name}»` : `Quitada de «${l.name}»`);
        render(); notify();
      } catch { toast('No se pudo cambiar la lista'); row.disabled = false; }
    });

    $('#lp-new-ico').addEventListener('click', e => {
      if (!window.gpxIconPicker) return;
      window.gpxIconPicker(e.currentTarget, newIcon, k => { newIcon = k; $('#lp-new-ico').innerHTML = icon(k); });
    });
    const create = async () => {
      const name = $('#lp-new-name').value.trim();
      if (!name) { $('#lp-new-name').focus(); return; }
      const btn = $('#lp-new-btn'); btn.disabled = true;
      try {
        const l = await post('/api/lists', { name, icon: newIcon }).then(r => (r.ok ? r.json() : Promise.reject()));
        const r2 = await post(`/api/lists/${l.id}/tracks`, { track_id: trackId });
        lists.unshift({ ...l, track_count: r2.ok ? 1 : 0, has: r2.ok });
        $('#lp-new-name').value = '';
        toast(`Guardada en «${name}»`);
        render(); notify();
      } catch { toast('No se pudo crear la lista'); }
      btn.disabled = false;
    };
    $('#lp-new-btn').addEventListener('click', create);
    $('#lp-new-name').addEventListener('keydown', e => { if (e.key === 'Enter') create(); });
  };
})();
