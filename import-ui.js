// import-ui.js — shared import log helpers (used by editor.html, compare.html)
'use strict';

function importLog(container, text) {
  if (text === null || text === undefined) return;
  for (const raw of String(text).split('\n')) {
    const t = raw.trimEnd();
    if (!t) continue;
    const row  = document.createElement('div');
    const icon = document.createElement('span');
    const msg  = document.createElement('span');
    row.className  = 'ilog-row';
    icon.className = 'ilog-icon';
    msg.className  = 'ilog-text';
    msg.textContent = t.replace(/^[\s✓✗⚠]+/, '').trim() || t;

    const trimmed = t.trimStart();
    if (trimmed.startsWith('✓') || trimmed.startsWith('  ✓')) {
      row.classList.add('ok');   icon.textContent = '✓';
      msg.textContent = trimmed.replace(/^✓\s*/, '');
    } else if (trimmed.startsWith('✗') || /^error\b/i.test(trimmed)) {
      row.classList.add('err');  icon.textContent = '✗';
      msg.textContent = trimmed.replace(/^✗\s*/, '');
    } else if (trimmed.startsWith('⚠')) {
      row.classList.add('warn'); icon.textContent = '⚠';
      msg.textContent = trimmed.replace(/^⚠\s*/, '');
    } else if (/^Importados?:\s*\d+/i.test(trimmed)) {
      row.classList.add('prog'); icon.textContent = '↑';
      msg.textContent = trimmed;
    } else if (t.startsWith('  ') || t.startsWith('\t')) {
      row.classList.add('sub');  icon.textContent = '';
      msg.textContent = trimmed;
    } else {
      icon.textContent = '·';
      msg.textContent = trimmed;
    }

    row.appendChild(icon);
    row.appendChild(msg);
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
  }
}

function importLogSummary(container, isErr) {
  const rows = [...container.querySelectorAll('.ilog-row')];

  // Parse global counts from structured summary lines
  let imported = 0, errors = 0, existing = 0, review = 0;
  for (const r of rows) {
    const t = r.querySelector('.ilog-text')?.textContent || '';
    const mI = t.match(/^Importados\s*:\s*(\d+)/i);
    const mE = t.match(/^Errores\s*:\s*(\d+)/i);
    const mX = t.match(/^Ya existían[^:]*:\s*(\d+)/i);
    const mR = t.match(/^Enviados a _REVIEW_\s*:\s*(\d+)/i);
    if (mI) imported = parseInt(mI[1]);
    if (mE) errors   = parseInt(mE[1]);
    if (mX) existing = parseInt(mX[1]);
    if (mR) review   = parseInt(mR[1]);
  }

  // Split rows into per-track blocks by [N/M] header
  const trackBlocks = [];
  let cur = null;
  for (const row of rows) {
    const t = (row.querySelector('.ilog-text')?.textContent || '').trim();
    const m = t.match(/^\[(\d+)\/(\d+)\]\s+(.+)$/);
    if (m) { if (cur) trackBlocks.push(cur); cur = { name: m[3], lines: [] }; }
    else if (cur) cur.lines.push(t);
  }
  if (cur) trackBlocks.push(cur);

  // Remove raw log rows from the UI (they go to admin logs server-side)
  rows.forEach(r => r.remove());

  // Render per-track cards
  if (trackBlocks.length) {
    const MAX = 5;
    for (const b of trackBlocks.slice(0, MAX)) {
      const txt = b.lines.join('\n');

      let st = 'error', stLabel = 'Error', stIcon = '✗', tId = null;
      const mId = txt.match(/Importado \(id=(\d+)\)/);
      if (mId)                             { st = 'ok';   stLabel = 'Importado';    stIcon = '✓'; tId = parseInt(mId[1]); }
      else if (/Ya existe en BD/.test(txt)){ st = 'skip'; stLabel = 'Ya existía';  stIcon = '⏭'; }
      else if (/_REVIEW_/.test(txt))       { st = 'warn'; stLabel = 'En revisión'; stIcon = '⚠'; }

      const mLoc    = txt.match(/Ubicaci[oó]n\s*:\s*(.+)/);
      const mSierra = txt.match(/Sierra\s*:\s*(.+)/);
      const parts   = [];
      if (mSierra) { const s = mSierra[1].trim(); if (s && s !== 'no detectada') parts.push(s); }
      if (mLoc)    parts.push(mLoc[1].trim());
      const locStr  = parts.join(' · ') || null;

      const mIbp = txt.match(/IBP\s*:\s*h=(\S+)\s+b=(\S+)\s+r=(\S+)/);
      const mOsm = txt.match(/OSM\s*:\s*(.+)/);

      const SC = {
        ok:   { fg:'#15803d', bg:'#dcfce7' },
        skip: { fg:'#0369a1', bg:'#e0f2fe' },
        warn: { fg:'#92400e', bg:'#fef9c3' },
        error:{ fg:'#b91c1c', bg:'#fee2e2' },
      }[st];

      const cleanName = b.name.replace(/\.gpx$/i,'').replace(/^(wikiloc|komoot)-(\d+)$/, '$1 #$2');

      const card = document.createElement('div');
      card.style.cssText = 'background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:6px';

      const hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--line)';
      hdr.innerHTML = `
        <span style="width:20px;height:20px;border-radius:50%;background:${SC.bg};color:${SC.fg};display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0">${stIcon}</span>
        <span style="font-size:12px;font-weight:600;color:var(--ink);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${cleanName.replace(/"/g,'&quot;')}">${cleanName}</span>
        <span style="font-size:11px;font-weight:600;color:${SC.fg};white-space:nowrap">${stLabel}${tId ? ` #${tId}` : ''}</span>`;
      card.appendChild(hdr);

      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:auto 1fr';
      const addR = (label, html, last) => {
        const bb = last ? '' : ';border-bottom:1px solid var(--line)';
        const l = document.createElement('div');
        l.style.cssText = `padding:5px 8px 5px 12px;color:var(--muted);font-size:11px;font-weight:600;white-space:nowrap${bb}`;
        l.textContent = label;
        const v = document.createElement('div');
        v.style.cssText = `padding:5px 12px;font-size:11.5px;color:var(--ink)${bb}`;
        v.innerHTML = html;
        grid.appendChild(l); grid.appendChild(v);
      };
      const na     = '<span style="color:var(--muted)">—</span>';
      const naGray = '<span style="color:var(--muted)">no calculado</span>';

      let osmHtml = naGray;
      if (mOsm) {
        const osmTxt = mOsm[1].trim();
        const mWays = osmTxt.match(/^(\d+)\s+v[ií]as aplicadas/);
        if (mWays) {
          osmHtml = `<span style="color:color-mix(in srgb,#16a34a 72%,var(--ink));font-weight:600">${mWays[1]} vías</span><span style="color:var(--muted);font-size:10.5px"> (caché)</span>`;
        } else if (/sin cach|obsoleta|sin puntos|error/i.test(osmTxt)) {
          osmHtml = naGray;
        }
      }

      addR('Ubicación', locStr || na,  false);
      addR('OSM',       osmHtml,       !mIbp);
      if (mIbp) addR('IBP', `<span style="color:var(--muted)">H</span> <b>${mIbp[1]}</b>&ensp;<span style="color:var(--muted)">B</span> <b>${mIbp[2]}</b>&ensp;<span style="color:var(--muted)">R</span> <b>${mIbp[3]}</b>`, true);

      card.appendChild(grid);
      container.appendChild(card);
    }
    if (trackBlocks.length > MAX) {
      const more = document.createElement('div');
      more.style.cssText = 'font-size:11px;color:var(--muted);text-align:center;padding:2px 0 6px';
      more.textContent = `… y ${trackBlocks.length - MAX} más`;
      container.appendChild(more);
    }
  } else {
    // Fallback badges
    const sum = document.createElement('div');
    sum.className = 'ilog-summary';
    if (imported) sum.innerHTML += `<span class="ilog-badge ok">✓ ${imported} importado${imported>1?'s':''}</span>`;
    if (existing) sum.innerHTML += `<span class="ilog-badge warn">⏭ ${existing} ya existía${existing>1?'n':''}</span>`;
    if (review)   sum.innerHTML += `<span class="ilog-badge warn">⚠ ${review} en revisión</span>`;
    if (errors)   sum.innerHTML += `<span class="ilog-badge err">✗ ${errors} error${errors>1?'es':''}</span>`;
    if (!sum.innerHTML) sum.innerHTML = isErr
      ? '<span class="ilog-badge err">Error en la importación</span>'
      : '<span class="ilog-badge ok">✓ Completado</span>';
    container.appendChild(sum);
  }

  container.scrollTop = container.scrollHeight;
}
