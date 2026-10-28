// Line icon set shared by the whole app (activities, badges…). 24×24, drawn with currentColor so the
// same icon is white on an activity's coloured disc and grey on a badge. Keys are stored in the DB
// (config_activities.icon, gamification families); unknown values (old emojis) are shown as text.
(function () {
  const C = 'currentColor';
  // Activity silhouettes (the viewer's original drawings, now in currentColor)
  const MTB = `<circle cx="7" cy="17" r="3.2" stroke-width="2.2"/><circle cx="17" cy="17" r="3.2" stroke-width="2.2"/><path stroke-width="2" d="M10.2 17 L13 9 L16.5 13 L17 17"/><path stroke-width="2" d="M13 9 L15 9 L17 13"/><circle cx="15.5" cy="6.5" r="1.8" fill="${C}" stroke="none"/><path stroke-width="1.8" d="M15 8 L13 10 M15.5 8 L17 11"/>`;
  const PEAK = `<path fill="${C}" stroke="none" d="M3 21 L9 9 L13.5 16 L16.5 10.5 L21 21Z"/>`;
  const ICONS = {
    // ── Actividades ──
    'mtb':          { g: 'act', label: 'BTT',                 svg: MTB },
    'gravel':       { g: 'act', label: 'Gravel',              svg: `<circle cx="6.5" cy="17" r="3" stroke-width="2.2"/><circle cx="17.5" cy="17" r="3" stroke-width="2.2"/><path stroke-width="2" d="M9.5 17 L13 8 L17.5 13.5 L17.5 17"/><path stroke-width="2" d="M13 8 L15.5 8 L17.5 12"/><circle cx="16" cy="5.5" r="1.8" fill="${C}" stroke="none"/><path stroke-width="1.8" d="M15.5 7 L14 9.5 M16 7 L18 9"/>` },
    'bikepacking':  { g: 'act', label: 'Bikepacking',         svg: `<circle cx="7" cy="17" r="3" stroke-width="2.2"/><circle cx="17" cy="17" r="3" stroke-width="2.2"/><path stroke-width="2" d="M10 17 L13 9 L16.5 13 L17 17"/><path stroke-width="2" d="M13 9 L15 9 L17 13"/><rect x="12.5" y="9.5" width="3" height="2.5" rx="0.5" fill="${C}" stroke="none"/><circle cx="15.5" cy="7" r="1.8" fill="${C}" stroke="none"/>` },
    'road-bike':    { g: 'act', label: 'Carretera',           svg: `<circle cx="6" cy="17" r="3" stroke-width="2.2"/><circle cx="18" cy="17" r="3" stroke-width="2.2"/><path stroke-width="2" d="M9 17 L12 7.5 L18 13.5 L18 17"/><path stroke-width="2" d="M12 7.5 L14.5 7.5 L18 12.5"/><circle cx="15" cy="5" r="1.8" fill="${C}" stroke="none"/><path stroke-width="1.8" d="M14.5 6.5 L13 9.5 M15 6.5 L17 8"/>` },
    'trail-run':    { g: 'act', label: 'Trail running',       svg: `<circle cx="13" cy="4" r="1.8" fill="${C}" stroke="none"/><path stroke-width="2.5" d="M13 5.8 L11 11 L8 14.5 M11 11 L13.5 15 L12 20 M8 14.5 L7 20 M13 5.8 L16 9"/><path stroke-width="2" d="M11 11 L14 9.5 L16 11"/>` },
    'run':          { g: 'act', label: 'Correr',              svg: `<circle cx="14" cy="4" r="1.8" fill="${C}" stroke="none"/><path stroke-width="2.5" d="M14 5.8 L12 11 L9 9.5 M12 11 L14 16 L11 20 M14 16 L17 20 M14 5.8 L16 10"/><path stroke-width="2" d="M9 9.5 L7.5 11 M16 10 L18 9"/>` },
    'hike':         { g: 'act', label: 'Senderismo',          svg: `<circle cx="12" cy="4" r="1.8" fill="${C}" stroke="none"/><path stroke-width="2.5" d="M12 5.8 L11 12 L9.5 20 M11 12 L13 20"/><path stroke-width="2" d="M12 5.8 L15 9 M11 9 L9 10 L8.5 20"/><path stroke-width="1.5" d="M9 10 L7 8"/>` },
    'peak':         { g: 'act', label: 'Montaña',             svg: PEAK },
    'climb':        { g: 'act', label: 'Escalada',            svg: `<line x1="3.5" y1="2" x2="3.5" y2="22" stroke-width="2.5"/><path stroke-width="1.5" d="M3.5 6 L7 7 M3.5 12 L7 13 M3.5 18 L7 19"/><circle cx="17" cy="5" r="1.8" fill="${C}" stroke="none"/><path stroke-width="2" d="M17 6.8 L14.5 10 L12 9 M14.5 10 L13.5 16 L11.5 21 M13.5 16 L16.5 19 M17 6.8 L19 9"/><path stroke-width="1.5" d="M3.5 10 L12 9"/>` },
    'via-ferrata':  { g: 'act', label: 'Ferrata',             svg: `<line x1="3.5" y1="2" x2="3.5" y2="22" stroke-width="2.5"/><path stroke-width="1.5" d="M3.5 5 L6 5 M3.5 9 L6 9 M3.5 13 L6 13 M3.5 17 L6 17"/><circle cx="17" cy="5" r="1.8" fill="${C}" stroke="none"/><path stroke-width="2" d="M17 6.8 L15 10 L12 9 M15 10 L14 17 L12 21 M14 17 L17 20 M17 6.8 L19 9"/><path stroke-width="1.5" d="M3.5 9 L12 9"/>` },
    'ski-touring':  { g: 'act', label: 'Esquí de montaña',    svg: `<circle cx="13" cy="4" r="1.8" fill="${C}" stroke="none"/><path stroke-width="2.5" d="M13 5.8 L11 11 L8 12.5 M11 11 L12 18 M13 5.8 L15 9 L17 10"/><path stroke-width="1.5" d="M8 12.5 L6 14 M17 10 L18 14"/><path stroke-width="2.5" d="M5 21 L13 22 L17 21"/>` },
    'kayak':        { g: 'act', label: 'Kayak',               svg: `<circle cx="12" cy="4" r="1.8" fill="${C}" stroke="none"/><path stroke-width="2.5" d="M12 5.8 L11 9.5 L12 14"/><path stroke-width="2" d="M8.5 9.5 L15.5 9.5"/><path stroke-width="2" fill="${C}" d="M4 16 Q12 13.5 20 16 Q12 18.5 4 16Z"/><path stroke-width="2" d="M3 9 L8 10 M16 10 L21 9"/>` },
    'ridge':        { g: 'act', label: 'Crestas',             svg: `<path d="M2 19 L6 12 L8.5 14.5 L12 7 L14.5 11 L16.5 9 L22 19Z" stroke-width="2"/><circle cx="12" cy="4.2" r="1.6" fill="${C}" stroke="none"/>` },
    'pin':          { g: 'act', label: 'Otra',                svg: `<path fill="${C}" stroke="none" d="M12 2.5C8.8 2.5 6.5 5.3 6.5 8.6c0 4.9 5.5 12.9 5.5 12.9s5.5-8 5.5-12.9C17.5 5.3 15.2 2.5 12 2.5z"/>` },

    // ── Generales (insignias, etc.) ──
    'footprints':   { g: 'gen', label: 'Huellas',     svg: `<path d="M6.5 13C5 13 4 11.2 4 8.7S5 4 6.5 4 9 5.9 9 8.7 8 13 6.5 13Z"/><path d="M5 15.5h3V17a1.5 1.5 0 0 1-3 0Z"/><path d="M17.5 10c1.5 0 2.5 1.8 2.5 4.3s-1 4.7-2.5 4.7-2.5-1.9-2.5-4.7 1-4.3 2.5-4.3Z"/><path d="M16 21h3"/>` },
    'route':        { g: 'gen', label: 'Ruta',        svg: `<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H16"/>` },
    'ruler':        { g: 'gen', label: 'Distancia',   svg: `<path d="M3 15.5 15.5 3 21 8.5 8.5 21Z"/><path d="m7 12 2 2M10 9l2 2M13 6l2 2"/>` },
    'mountain':     { g: 'gen', label: 'Montaña',     svg: `<path d="m3 20 6-11 4 6 3-4 5 9Z"/>` },
    'summit':       { g: 'gen', label: 'Cumbre',      svg: `<path d="m2 21 8-13 4 6 2-3 6 10Z"/><path d="M10 8V3l4 1.5L10 6"/>` },
    'trending-up':  { g: 'gen', label: 'Subida',      svg: `<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>` },
    'flag':         { g: 'gen', label: 'Meta',        svg: `<path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/>` },
    'tent':         { g: 'gen', label: 'Tienda',      svg: `<path d="M2 20h20"/><path d="M4 20 12 5l8 15"/><path d="m9.5 20 2.5-5 2.5 5"/>` },
    'backpack':     { g: 'gen', label: 'Mochila',     svg: `<path d="M7 9a5 5 0 0 1 10 0v10.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 19.5Z"/><path d="M10 4h4M9.5 14h5v4h-5Z"/>` },
    'map':          { g: 'gen', label: 'Mapa',        svg: `<path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20Z"/><path d="M9 4v13.5M15 6.5V20"/>` },
    'compass':      { g: 'gen', label: 'Brújula',     svg: `<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5Z"/>` },
    'globe':        { g: 'gen', label: 'Mundo',       svg: `<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>` },
    'pin-line':     { g: 'gen', label: 'Lugar',       svg: `<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.5"/>` },
    'binoculars':   { g: 'gen', label: 'Explorar',    svg: `<circle cx="6.5" cy="15.5" r="3.5"/><circle cx="17.5" cy="15.5" r="3.5"/><path d="M10 15.5h4M4.5 12.5 7 5h3l1 5.5M19.5 12.5 17 5h-3l-1 5.5"/>` },
    'layers':       { g: 'gen', label: 'Capas',       svg: `<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/>` },
    'loop':         { g: 'gen', label: 'Circular',    svg: `<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4.5h-4.5"/>` },
    'calendar':     { g: 'gen', label: 'Calendario',  svg: `<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>` },
    'clock':        { g: 'gen', label: 'Tiempo',      svg: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>` },
    'camera':       { g: 'gen', label: 'Cámara',      svg: `<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.8l1.7-2.5h6l1.7 2.5h2.8A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z"/><circle cx="12" cy="13.5" r="3.5"/>` },
    'books':        { g: 'gen', label: 'Listas',      svg: `<rect x="3.5" y="4" width="4.5" height="16" rx="1"/><rect x="9.5" y="4" width="4.5" height="16" rx="1"/><path d="m15.8 5.4 3.6-1 3 15.2-3.6 1Z"/>` },
    'bookmark':     { g: 'gen', label: 'Marcador',    svg: `<path d="M6 3.5h12V21l-6-4-6 4Z"/>` },
    'trophy':       { g: 'gen', label: 'Trofeo',      svg: `<path d="M8 3.5h8V9a4 4 0 0 1-8 0Z"/><path d="M8 5.5H5v1a3.5 3.5 0 0 0 3 3.4M16 5.5h3v1a3.5 3.5 0 0 1-3 3.4"/><path d="M12 13v3.5M8.5 20.5h7M9.5 20.5c0-2 1-4 2.5-4s2.5 2 2.5 4"/>` },
    'medal':        { g: 'gen', label: 'Medalla',     svg: `<circle cx="12" cy="15" r="5.5"/><path d="M8.8 10.5 5.5 3h4.5l2 4.5M15.2 10.5 18.5 3H14l-2 4.5"/>` },
    'star':         { g: 'gen', label: 'Estrella',    svg: `<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/>` },
    'crown':        { g: 'gen', label: 'Corona',      svg: `<path d="m3 8 4.5 4L12 5l4.5 7L21 8l-2 11H5Z"/>` },
    'shield':       { g: 'gen', label: 'Escudo',      svg: `<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8 7.5 9.5 4.3-1.5 7.5-4.9 7.5-9.5V6Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>` },
    'target':       { g: 'gen', label: 'Objetivo',    svg: `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>` },
    'bolt':         { g: 'gen', label: 'Energía',     svg: `<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>` },
    'gauge':        { g: 'gen', label: 'Velocidad',   svg: `<path d="M4 18a8 8 0 1 1 16 0"/><path d="m12 18 4-6"/>` },
    'heart':        { g: 'gen', label: 'Favorito',    svg: `<path d="M12 20s-7.5-4.5-7.5-10A4.5 4.5 0 0 1 12 7.5 4.5 4.5 0 0 1 19.5 10C19.5 15.5 12 20 12 20Z"/>` },
    'sun':          { g: 'gen', label: 'Sol',         svg: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>` },
    'snowflake':    { g: 'gen', label: 'Nieve',       svg: `<path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7"/><path d="m9.5 4 2.5 2 2.5-2M9.5 20l2.5-2 2.5 2"/>` },
    'tree':         { g: 'gen', label: 'Bosque',      svg: `<path d="M12 3 6 11h3l-4 6h14l-4-6h3Z"/><path d="M12 17v4"/>` },
    'droplet':      { g: 'gen', label: 'Agua',        svg: `<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/>` },
  };

  const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** SVG markup for an icon key; unknown values (e.g. an old emoji) come back as text. */
  function gpxIcon(key, opts = {}) {
    const ic = ICONS[key];
    const size = opts.size || 20, cls = opts.cls || 'gi';
    if (!ic) return key ? `<span class="${cls} gi-txt">${escHtml(key)}</span>` : '';
    return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ic.svg}</svg>`;
  }

  /** Popover to choose an icon. Calls onPick(key) and closes; Esc or a click outside closes it. */
  let open = null;
  function gpxIconPicker(anchor, current, onPick) {
    if (open) open.close();
    const pop = document.createElement('div');
    pop.className = 'gi-picker';
    const section = (g, title) => `<div class="gi-picker-title">${title}</div><div class="gi-picker-grid">` +
      Object.entries(ICONS).filter(([, v]) => v.g === g).map(([k, v]) =>
        `<button type="button" class="gi-pick${k === current ? ' sel' : ''}" data-k="${k}" title="${escHtml(v.label)}">${gpxIcon(k, { size: 22 })}</button>`).join('') + '</div>';
    pop.innerHTML = section('act', 'Actividades') + section('gen', 'Generales');
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const left = Math.min(window.innerWidth - pop.offsetWidth - 8, Math.max(8, r.left));
    const top = r.bottom + 6 + pop.offsetHeight > window.innerHeight ? Math.max(8, r.top - pop.offsetHeight - 6) : r.bottom + 6;
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
    const close = () => { pop.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); open = null; };
    const outside = e => { if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
    const esc = e => { if (e.key === 'Escape') close(); };
    pop.addEventListener('click', e => { const b = e.target.closest('.gi-pick'); if (!b) return; onPick(b.dataset.k); close(); });
    setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', esc, true); });
    open = { close };
  }

  window.GPX_ICONS = ICONS;
  window.gpxIcon = gpxIcon;
  window.gpxIconPicker = gpxIconPicker;
})();
