'use strict';
// Public pages (phase 4, block A): a route, a profile and a list, readable without an account and indexable.
// The HTML is generated here (title, description, data, Open Graph, JSON-LD) so search engines and link previews
// see it without running JavaScript; the map is then drawn in the browser from data embedded in the page.
//
// What anyone may see without a session ("web visible"): a public route whose owner keeps «Mostrar mis rutas
// públicas fuera de la aplicación» on, whose source web (tracks.url) is empty or confirmed as their own, and that
// the privacy zone doesn't hide entirely. Geometry is always the privacy-trimmed geom_s1, never the original.
const { slugify } = require('../domain/slug');
const { authorPoints } = require('../repo/points');

// SQL condition on tracks t JOIN users u (the owner)
const WEB_VISIBLE = `t.visibility = 'public' AND u.active AND u.web_visible
  AND (COALESCE(t.url, '') = '' OR t.source_confirmed)
  AND t.geom_view IS NOT NULL AND t.geom_s1 IS NOT NULL AND t.sw_lat IS NOT NULL`;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// JSON inside <script>: no "</script>" breakout, no line separators that end a JS string
const jsonForScript = v => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const nf1 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
const trackPath = t => `/ruta/${t.id}${slugify(t.name) ? '-' + slugify(t.name) : ''}`;
const listPath = l => `/lista/${l.id}${slugify(l.name) ? '-' + slugify(l.name) : ''}`;
const userPath = username => `/u/${encodeURIComponent(username)}`;
const avatarUrl = key => (key ? `/api/profile/avatar/${encodeURIComponent(key)}` : null);
const fmtTime = s => { if (!s) return null; const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min`; };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };

// ── Page shell ──────────────────────────────────────────────────────
function page({ title, description, canonical, image, base, jsonLd, noindex, viewer, body, head = '', scripts = '' }) {
  const abs = u => (u && u.startsWith('/') ? base + u : u);
  const next = encodeURIComponent(canonical);
  const navRight = viewer
    ? `<a href="/">Visor</a><a href="/perfil" id="nav-perfil" class="nav-user" aria-label="Mi perfil"></a>`
    : `<a class="nav-login nav-keep" href="/login?next=${next}">Entrar</a><a href="/registro" class="nav-upload nav-keep">Crear cuenta</a>`;
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} · GPX Library</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(abs(canonical))}">
${noindex ? '<meta name="robots" content="noindex">' : ''}
<meta property="og:site_name" content="GPX Library">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(abs(canonical))}">
${image ? `<meta property="og:image" content="${esc(abs(image))}">\n<meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}
${jsonLd ? `<script type="application/ld+json">${jsonForScript(jsonLd)}</script>` : ''}
<link rel="stylesheet" href="/shared.css">
<script src="/theme.js"></script>
${head}
<style>
  .pub { max-width: 1080px; margin: 0 auto; padding: 24px 20px 64px; }
  .pub-head { display: flex; gap: 18px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; margin-bottom: 18px; }
  .pub-head h1 { font-size: 28px; letter-spacing: -.02em; margin: 4px 0 6px; text-wrap: balance; }
  .pub-kicker { font-size: 13px; color: var(--muted); display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .pub-kicker a { color: var(--ink-2); }
  .pub-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .pub-card { background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow); padding: 16px 18px; margin-bottom: 14px; }
  .pub-card h2 { font-size: 15px; margin: 0 0 10px; }
  .pub-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
  .pub-stat b { display: block; font-size: 18px; font-variant-numeric: tabular-nums; }
  .pub-stat span { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .pub-desc { white-space: pre-line; color: var(--ink-2); line-height: 1.6; }
  .pub-owner { display: flex; gap: 10px; align-items: center; color: var(--ink); text-decoration: none; }
  .pub-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: var(--accent); color: #fff;
                display: inline-flex; align-items: center; justify-content: center; font-weight: 700; flex-shrink: 0; }
  .pub-avatar.lg { width: 84px; height: 84px; font-size: 32px; }
  .pub-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
  .pub-item { display: block; background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; color: var(--ink); text-decoration: none; transition: transform .15s; }
  .pub-item:hover { transform: translateY(-2px); }
  .pub-item-img { height: 150px; background: var(--soft) center/cover no-repeat; }
  .pub-item-body { padding: 10px 12px 12px; }
  .pub-item-name { font-weight: 600; font-size: 14px; line-height: 1.35; }
  .pub-item-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .pub-note { font-size: 13px; color: var(--muted); }
  .pub-note a { color: var(--accent); }
  .pub-pages { display: flex; gap: 8px; justify-content: center; margin-top: 18px; }
  .pub-empty { text-align: center; padding: 60px 20px; color: var(--ink-2); background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow); max-width: 560px; margin: 32px auto; }
</style>
</head>
<body>
<nav>
  <a href="/" class="logo">GPX Library</a>
  <span style="flex:1"></span>
  ${navRight}
</nav>
<main class="pub">
${body}
</main>
<div id="toast"></div>
${scripts}
</body>
</html>`;
}

function notFound({ base, viewer, what = 'Esta ruta' }) {
  return page({
    title: 'No disponible', description: 'Contenido no disponible públicamente.', canonical: '/', base, noindex: true, viewer,
    body: `<div class="pub-empty"><h1 style="font-size:22px">${esc(what)} no está disponible públicamente</h1>
      <p>Puede que sea privada, que su autor no la muestre fuera de GPX Library o que no exista.</p>
      ${viewer ? '<p><a class="btn" href="/">Ir al visor</a></p>' : '<p><a class="btn btn-primary" href="/login">Entrar</a> <a class="btn" href="/registro">Crear cuenta</a></p>'}</div>`,
  });
}

const routeCard = (t, img) => `<a class="pub-item" href="${esc(trackPath(t))}">
  <div class="pub-item-img" style="background-image:url('${esc(img || '')}')"></div>
  <div class="pub-item-body"><div class="pub-item-name">${esc(t.name)}</div>
  <div class="pub-item-sub">${esc([t.activity, t.sierra, `${nf1.format(t.distance || 0)} km`, `${nf0.format(t.elevation_gain || 0)} m+`].filter(Boolean).join(' · '))}</div></div></a>`;

// Image for a route: its cover, else the default image of its activity
async function activityImages(db) {
  const rows = await db.all('SELECT name, image FROM config_activities').catch(() => []);
  return Object.fromEntries(rows.map(r => [r.name, r.image]));
}
const routeImage = (t, actImg) => (t.cover_photo_id ? `/api/photos/${t.cover_photo_id}?size=thumb` : actImg[t.activity] || null);

// ── Route ───────────────────────────────────────────────────────────
// /ruta/{id}-{slug} serves the same track page as the app (track.html, so it looks the same and keeps the map
// layers, profile and tabs); the server only adds the metadata for search engines and link previews, a summary
// for clients without JavaScript, and the route id. Without a session the page is read-only and reads the
// route from the API with the privacy zone applied.
// Returns { status, location } (redirect), { status, html } (not found) or { status: 200, meta }.
async function routeMeta(db, id, { base, viewer, slug }) {
  const t = await db.get(
    `SELECT t.id, t.name, t.activity, t.sierra, t.province, t.date, t.distance, t.elevation_gain, t.elevation_loss,
            t.max_elevation, t.moving_time, t.notes, t.circular, t.cover_photo_id, t.owner_id, t.visibility,
            u.username, u.display_name, u.profile_public, (${WEB_VISIBLE}) AS web
     FROM tracks t LEFT JOIN users u ON u.id = t.owner_id WHERE t.id = ?`, [id]);
  // Members also open routes that are only visible inside the app (not indexed); everybody else only web-visible ones
  const inApp = t && viewer && (t.visibility === 'public' || t.owner_id === viewer.sub || viewer.role === 'admin');
  if (!t || !(t.web || inApp)) return { status: 404, html: notFound({ base, viewer }) };
  const canonical = trackPath(t);
  if (slug !== canonical.slice(`/ruta/${t.id}`.length)) return { status: 301, location: canonical };

  const actImg = await activityImages(db);
  const owner = t.display_name || t.username || 'GPX Library';
  const where = [t.sierra, t.province].filter(Boolean).join(', ');
  const description = t.notes ? clip(t.notes, 160)
    : clip(`Ruta de ${(t.activity || 'montaña').toLowerCase()} de ${nf1.format(t.distance || 0)} km y ${nf0.format(t.elevation_gain || 0)} m de desnivel positivo${where ? ` en ${where}` : ''}${t.circular ? ', circular' : ''}. Por ${owner}.`, 160);
  const image = t.cover_photo_id ? `/api/photos/${t.cover_photo_id}` : actImg[t.activity] || null;
  const abs = u => (u && u.startsWith('/') ? base + u : u);
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'TouristTrip', name: t.name, description, url: base + canonical,
    ...(image ? { image: abs(image) } : {}),
    ...(t.activity ? { touristType: t.activity } : {}),
    author: { '@type': 'Person', name: owner, ...(t.profile_public && t.username ? { url: base + userPath(t.username) } : {}) },
    ...(where ? { contentLocation: { '@type': 'Place', name: where } } : {}),
    additionalProperty: [
      { '@type': 'PropertyValue', name: 'Distancia', value: Math.round((t.distance || 0) * 10) / 10, unitText: 'km' },
      { '@type': 'PropertyValue', name: 'Desnivel positivo', value: t.elevation_gain || 0, unitText: 'm' },
    ],
  };
  const head = `<title>${esc(t.name)} · GPX Library</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${esc(base + canonical)}">
  ${t.web ? '' : '<meta name="robots" content="noindex">'}
  <meta property="og:site_name" content="GPX Library">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${esc(t.name)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(base + canonical)}">
  ${image ? `<meta property="og:image" content="${esc(abs(image))}">\n  <meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}
  <script type="application/ld+json">${jsonForScript(jsonLd)}</script>`;
  const summary = `<noscript><main class="pub"><h1>${esc(t.name)}</h1>
    <p>${esc([t.activity, where, `${nf1.format(t.distance || 0)} km`, `${nf0.format(t.elevation_gain || 0)} m de desnivel`, fmtTime(t.moving_time)].filter(Boolean).join(' · '))}</p>
    ${t.notes ? `<p>${esc(t.notes)}</p>` : ''}<p>Por ${esc(owner)}.</p></main></noscript>`;
  return { status: 200, meta: { id: t.id, head, summary, anon: !viewer } };
}

// The track page with the route's metadata, its id and (without a session) the read-only flag
function injectRoute(trackHtml, meta) {
  return trackHtml
    .replace(/<title>[^<]*<\/title>/, meta.head)
    .replace('<body>', `<body${meta.anon ? ' class="anon"' : ''}>\n<script>window.GPX_TRACK_ID = ${Number(meta.id)};${meta.anon ? ' window.GPX_ANON = true;' : ''}</script>\n${meta.summary}`);
}

// ── Profile ─────────────────────────────────────────────────────────
const PROFILE_PAGE = 24;
// IBP → difficulty label + CSS class
function ibpDiff(ibp) {
  if (ibp == null) return null;
  if (ibp < 50)  return { label: 'Fácil',       cls: 'diff-easy' };
  if (ibp < 100) return { label: 'Moderado',    cls: 'diff-mod' };
  if (ibp < 200) return { label: 'Difícil',     cls: 'diff-hard' };
  if (ibp < 400) return { label: 'Muy difícil', cls: 'diff-vhard' };
  return                 { label: 'Extremo',     cls: 'diff-xtreme' };
}

async function renderProfile(db, username, { base, viewer, pageNo = 0 }) {
  const u = await db.get(
    `SELECT id, username, display_name, bio, avatar_key, profile_public, web_visible,
            to_char(created_at, 'YYYY-MM') AS since FROM users WHERE lower(username) = lower(?) AND active`, [username]);
  if (!u || (!u.profile_public && !viewer)) return { status: 404, html: notFound({ base, viewer, what: 'Este perfil' }) };
  const canonical = userPath(u.username);
  const [totals, routes, lists, actImg, followCounts, statsByActivity, statsByYear, points] = await Promise.all([
    db.get(`SELECT CAST(COUNT(*) AS INTEGER) AS n, COALESCE(SUM(t.distance),0) AS km, COALESCE(SUM(t.elevation_gain),0) AS gain,
                   CAST(SUM(CASE WHEN t.circular=1 THEN 1 ELSE 0 END) AS INTEGER) AS circular
            FROM tracks t JOIN users u ON u.id=t.owner_id WHERE t.owner_id=? AND ${WEB_VISIBLE}`, [u.id]),
    db.all(`SELECT t.id, t.name, t.activity, t.sierra, t.province, t.date, t.distance, t.elevation_gain, t.cover_photo_id,
                   t.ibp_hiking, t.ibp_bicycle, t.ibp_running
            FROM tracks t JOIN users u ON u.id=t.owner_id WHERE t.owner_id=? AND ${WEB_VISIBLE}
            ORDER BY t.date DESC NULLS LAST, t.id DESC LIMIT ${PROFILE_PAGE} OFFSET ${pageNo * PROFILE_PAGE}`, [u.id]),
    db.all(`SELECT l.id, l.name, l.description,
                   CAST((SELECT COUNT(*) FROM user_list_tracks lt WHERE lt.list_id=l.id) AS INTEGER) AS n
            FROM user_lists l WHERE l.owner_id=? AND l.visibility='public' ORDER BY l.created_at DESC`, [u.id]),
    activityImages(db),
    db.get(`SELECT CAST((SELECT COUNT(*) FROM follows WHERE followee_id=?) AS INTEGER) AS followers,
                   CAST((SELECT COUNT(*) FROM follows WHERE follower_id=?) AS INTEGER) AS following`, [u.id, u.id]),
    db.all(`SELECT t.activity, CAST(COUNT(*) AS INTEGER) AS count,
                   ROUND(CAST(SUM(t.distance) AS NUMERIC),1) AS km, CAST(SUM(t.elevation_gain) AS INTEGER) AS gain
            FROM tracks t JOIN users u ON u.id=t.owner_id
            WHERE t.owner_id=? AND t.activity IS NOT NULL AND ${WEB_VISIBLE}
            GROUP BY t.activity ORDER BY count DESC`, [u.id]),
    db.all(`SELECT CAST(left(t.date,4) AS INTEGER) AS year, CAST(COUNT(*) AS INTEGER) AS count,
                   ROUND(CAST(SUM(t.distance) AS NUMERIC),1) AS km
            FROM tracks t JOIN users u ON u.id=t.owner_id
            WHERE t.owner_id=? AND t.date IS NOT NULL AND length(t.date)>=4 AND ${WEB_VISIBLE}
            GROUP BY year ORDER BY year DESC`, [u.id]),
    authorPoints(db, u.id).catch(() => null),
  ]);

  const name = u.display_name || u.username;
  const sinceFormatted = u.since ? new Date(u.since + '-01').toLocaleDateString('es-ES', { year: 'numeric', month: 'long' }) : '';
  const description = clip(u.bio || `Rutas de ${name} en GPX Library: ${totals.n} rutas, ${nf0.format(totals.km)} km y ${nf0.format(totals.gain)} m de desnivel.`, 160);
  const pages = Math.ceil(totals.n / PROFILE_PAGE);
  const viewerIsOwner = viewer && viewer.sub === u.id;

  const avatarEl = u.avatar_key
    ? `<img src="${esc(avatarUrl(u.avatar_key))}" alt="${esc(name)}">`
    : `<span class="hero-avatar-init">${esc(name.charAt(0).toUpperCase())}</span>`;

  // Follow button (JS fills in state for logged-in non-owners; static "Entrar" for anonymous)
  const followBtn = viewerIsOwner ? `<a class="btn btn-outline" href="/perfil">Editar mi perfil</a>`
    : viewer
      ? `<button class="btn btn-accent up-follow-btn" id="follow-btn" data-uid="${u.id}">Seguir</button>`
      : `<a class="btn btn-accent up-follow-btn" href="/login?next=${encodeURIComponent(canonical)}">Seguir</a>`;
  const svg = (p, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const heroStat = (ico, val, lbl) => `<div class="hs"><span class="hs-ico">${svg(ico)}</span><div><div class="hs-val">${val}</div><div class="hs-lbl">${lbl}</div></div></div>`;

  // Bar chart helper (same style as perfil.js)
  const barChart = (data, labelFn, valFn, hintFn) => {
    if (!data || !data.length) return '<span style="color:var(--muted);font-size:12px">Sin datos</span>';
    const max = Math.max(...data.map(valFn)) || 1;
    return data.map(d => {
      const pct = Math.max(2, Math.round((valFn(d) / max) * 100));
      return `<div class="bar-row" title="${esc(hintFn(d))}">
        <div class="bar-label">${esc(labelFn(d))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="bar-val">${esc(String(valFn(d)))}</div>
      </div>`;
    }).join('');
  };
  const fmtKm = n => n == null ? '—' : Number(n).toLocaleString('es', { maximumFractionDigits: 0 }) + ' km';

  // Tabs: anchor-based, JS switches active class
  const tabRoutes  = `Rutas<span class="pill-count">${totals.n}</span>`;
  const tabLists   = lists.length ? `Listas<span class="pill-count">${lists.length}</span>` : null;

  // Route cards (feed style)
  const trailCards = routes.map(t => {
    const img = routeImage(t, actImg);
    const ibp = t.ibp_hiking ?? t.ibp_bicycle ?? t.ibp_running;
    const diff = ibpDiff(ibp);
    const stats = [
      t.distance ? `<span class="up-trail-stat"><b>${nf1.format(t.distance)}</b> km</span>` : '',
      t.elevation_gain ? `<span class="up-trail-stat"><b>${nf0.format(t.elevation_gain)}</b> m+</span>` : '',
      diff ? `<span class="up-trail-diff ${diff.cls}">${diff.label}</span>` : '',
    ].filter(Boolean).join('');
    const where = [t.sierra, t.province].filter(Boolean).join(' · ');
    return `<a class="up-trail-card" href="${esc(trackPath(t))}">
      <div class="up-trail-photo" ${img ? `style="background-image:url('${esc(img)}')"` : ''}>
        <span class="up-trail-act">${esc(t.activity || 'Ruta')}</span>
      </div>
      <div class="up-trail-body">
        <div class="up-trail-name">${esc(t.name)}</div>
        ${where ? `<div class="up-trail-where">${esc(where)}</div>` : ''}
        <div class="up-trail-stats">${stats}</div>
        ${t.date ? `<div class="up-trail-date">${new Date(t.date + 'T00:00:00').toLocaleDateString('es-ES', { year:'numeric', month:'short', day:'numeric' })}</div>` : ''}
      </div>
    </a>`;
  }).join('');

  const listCards = lists.map(l =>
    `<a class="up-list-card" href="${esc(listPath(l))}">
      <span class="up-list-icon">${svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>', 16)}</span>
      <div>
        <div class="up-list-name">${esc(l.name)}</div>
        <div class="up-list-sub">${l.n} ruta${l.n === 1 ? '' : 's'}</div>
        ${l.description ? `<div class="up-list-desc">${esc(clip(l.description, 80))}</div>` : ''}
      </div>
    </a>`).join('');

  const pager = pages > 1 ? `<div class="pub-pages">${pageNo > 0 ? `<a class="btn" href="${esc(canonical)}?p=${pageNo - 1}">← Anteriores</a>` : ''}${pageNo < pages - 1 ? `<a class="btn" href="${esc(canonical)}?p=${pageNo + 1}">Siguientes →</a>` : ''}</div>` : '';

  const body = `
<section class="hero">
  <div class="hero-cover cover-bg"></div>
  <div class="hero-body">
    <div class="hero-avatar">${avatarEl}</div>
    <div class="hero-id">
      <h1 class="hero-name">${esc(name)}</h1>
      <div class="hero-sub">@${esc(u.username)}${sinceFormatted ? ` · Miembro desde ${esc(sinceFormatted)}` : ''}</div>
      ${u.bio ? `<p class="hero-bio">${esc(u.bio)}</p>` : ''}
    </div>
    <div class="hero-actions">
      ${followBtn}
      <button class="btn btn-outline" id="up-share-btn" title="Copiar el enlace del perfil">
        ${svg('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>', 14)}
        Compartir
      </button>
      ${viewer && !viewerIsOwner ? `
      <button class="btn btn-ghost up-block-btn" id="block-btn" data-uid="${u.id}">Bloquear</button>
      <button class="btn btn-ghost up-report-btn" id="report-user-btn" data-uid="${u.id}" onclick="openUserReport(${u.id})">Denunciar</button>` : ''}
    </div>
  </div>
  <div class="hero-stats">
    ${points && points.enabled ? heroStat('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>', nf0.format(points.total), 'Puntos de autor') : ''}
    ${heroStat('<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>', nf0.format(totals.n), 'Rutas')}
    ${heroStat('<path d="M3 12h4l3-8 4 16 3-8h4"/>', nf0.format(totals.km), 'Kilómetros')}
    ${heroStat('<path d="m8 3 4 8 5-5 5 15H2L8 3z"/>', `${nf0.format(totals.gain)} m`, 'Desnivel +')}
    ${heroStat('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>', nf0.format(followCounts.followers), 'Seguidores')}
    ${heroStat('<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/>', nf0.format(followCounts.following), 'Siguiendo')}
  </div>
</section>

<div class="pill-tabs" id="up-tabs" role="tablist">
  <button class="pill-tab up-tab active" data-section="up-sec-rutas">${tabRoutes}</button>
  ${tabLists ? `<button class="pill-tab up-tab" data-section="up-sec-listas">${tabLists}</button>` : ''}
  <button class="pill-tab up-tab" data-section="up-sec-stats">Estadísticas</button>
</div>

<div id="up-sec-rutas" class="up-section">
  ${trailCards ? `<div class="up-trail-grid">${trailCards}</div>` : `<div class="empty-state up-panel">${u.web_visible ? 'Todavía no hay rutas públicas.' : 'Las rutas de este usuario solo se ven dentro de GPX Library.'}</div>`}
  ${pager}
</div>

${tabLists ? `<div id="up-sec-listas" class="up-section" hidden>
  <div class="up-list-grid">${listCards}</div>
</div>` : ''}

<div id="up-sec-stats" class="up-section" hidden>
  <div class="up-stats-boxes">
    <div class="up-stat-box"><div class="up-stat-val">${nf0.format(totals.n)}</div><div class="up-stat-lbl">Rutas públicas</div></div>
    <div class="up-stat-box"><div class="up-stat-val">${fmtKm(totals.km)}</div><div class="up-stat-lbl">Kilómetros</div></div>
    <div class="up-stat-box"><div class="up-stat-val">${nf0.format(totals.gain)} m</div><div class="up-stat-lbl">Desnivel acumulado</div></div>
    <div class="up-stat-box"><div class="up-stat-val">${nf0.format(totals.circular)}</div><div class="up-stat-lbl">Rutas circulares</div></div>
  </div>
  <div class="up-charts">
    ${statsByActivity.length ? `<div class="up-panel"><h3 class="up-chart-title">Por actividad</h3>
    <div class="bar-chart">${barChart(statsByActivity, d => d.activity, d => Number(d.km), d => `${fmtKm(d.km)} · ${d.count} rutas`)}</div></div>` : ''}
    ${statsByYear.length ? `<div class="up-panel"><h3 class="up-chart-title">Por año</h3>
    <div class="bar-chart">${barChart(statsByYear, d => String(d.year), d => Number(d.km), d => `${fmtKm(d.km)} · ${d.count} rutas`)}</div></div>` : ''}
  </div>
</div>

${viewer && !viewerIsOwner ? `<script>
(async function() {
  const uid = ${u.id};

  // Follow button
  const followBtn = document.getElementById('follow-btn');
  if (followBtn) {
    try {
      const r = await fetch('/api/users/' + uid + '/follow-status');
      if (r.ok) {
        const d = await r.json();
        followBtn.textContent = d.following ? 'Dejar de seguir' : 'Seguir';
        followBtn.classList.toggle('active', d.following);
        followBtn.addEventListener('click', async () => {
          followBtn.disabled = true;
          const method = d.following ? 'DELETE' : 'POST';
          const res = await fetch('/api/users/' + uid + '/follow', { method });
          if (res.ok) { const j = await res.json(); d.following = j.following; followBtn.textContent = d.following ? 'Dejar de seguir' : 'Seguir'; followBtn.classList.toggle('active', d.following); }
          followBtn.disabled = false;
        });
      }
    } catch {}
  }

  // Block button
  const blockBtn = document.getElementById('block-btn');
  if (blockBtn) {
    let blocked = false;
    try {
      const r = await fetch('/api/profile/blocks');
      if (r.ok) { const list = await r.json(); blocked = list.some(b => b.id === uid); }
    } catch {}
    blockBtn.textContent = blocked ? 'Desbloquear' : 'Bloquear';
    blockBtn.classList.toggle('active', blocked);
    blockBtn.addEventListener('click', async () => {
      blockBtn.disabled = true;
      const res = await fetch('/api/users/' + uid + '/block', { method: blocked ? 'DELETE' : 'POST' });
      if (res.ok) { blocked = !blocked; blockBtn.textContent = blocked ? 'Desbloquear' : 'Bloquear'; blockBtn.classList.toggle('active', blocked); }
      blockBtn.disabled = false;
    });
  }
})();

// Report user modal
function openUserReport(uid) {
  const reason = prompt('Motivo de la denuncia (máx. 500 caracteres):');
  if (!reason || !reason.trim()) return;
  fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'user', target_id: uid, reason: reason.trim().slice(0, 500) }) })
    .then(r => r.ok ? alert('Denuncia enviada. La revisaremos en breve.') : alert('Error al enviar la denuncia.'))
    .catch(() => alert('Error al enviar la denuncia.'));
}
</script>` : ''}
<script>
// Tab switching
document.getElementById('up-tabs')?.addEventListener('click', e => {
  const btn = e.target.closest('.up-tab'); if (!btn) return;
  document.querySelectorAll('.up-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.up-section').forEach(s => s.hidden = true);
  btn.classList.add('active');
  const sec = document.getElementById(btn.dataset.section);
  if (sec) sec.hidden = false;
});
// Share button
document.getElementById('up-share-btn')?.addEventListener('click', async () => {
  const url = location.href;
  try { await navigator.clipboard.writeText(url); } catch { prompt('Copia el enlace:', url); }
});
</script>`;

  const head = `<style>
/* ── Perfil público: hero, pestañas, barras y estado vacío en shared.css ── */
.pub { max-width: 1080px; padding-top: 22px; }
.hero-name { margin: 0; }
.hero-bio { margin-bottom: 0; }
.up-follow-btn.active { background: var(--soft); color: var(--ink); }
.up-block-btn.active { color: var(--danger); }
.up-panel { background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px 20px; }

/* Rutas */
.up-trail-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 14px; }
.up-trail-card { display: flex; flex-direction: column; background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow);
  overflow: hidden; color: var(--ink); text-decoration: none; transition: transform .15s, box-shadow .15s; }
.up-trail-card:hover { transform: translateY(-2px); box-shadow: var(--shadow), 0 10px 26px rgba(15,23,42,.10); }
.up-trail-photo { position: relative; height: 170px; background: var(--soft) center/cover no-repeat; }
.up-trail-act { position: absolute; left: 12px; top: 12px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
  padding: 4px 10px; border-radius: 999px; background: color-mix(in srgb, var(--surface) 92%, transparent); color: var(--ink); box-shadow: 0 2px 8px rgba(0,0,0,.15); }
.up-trail-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 4px; flex: 1; }
.up-trail-name { font-size: 16px; font-weight: 700; line-height: 1.3; letter-spacing: -.01em; }
.up-trail-card:hover .up-trail-name { color: var(--accent); }
.up-trail-where { font-size: 12px; color: var(--muted); }
.up-trail-stats { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 6px; }
.up-trail-stat { font-size: 13px; color: var(--ink-2); }
.up-trail-stat b { color: var(--ink); }
.up-trail-date { font-size: 12px; color: var(--muted); margin-top: auto; padding-top: 8px; }
.up-trail-diff { font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 999px; }
.diff-easy   { background: color-mix(in srgb, #22c55e 18%, transparent); color: color-mix(in srgb, #15803d 80%, var(--ink)); }
.diff-mod    { background: color-mix(in srgb, #eab308 20%, transparent); color: color-mix(in srgb, #a16207 80%, var(--ink)); }
.diff-hard   { background: color-mix(in srgb, #f97316 18%, transparent); color: color-mix(in srgb, #c2410c 80%, var(--ink)); }
.diff-vhard  { background: color-mix(in srgb, #ef4444 18%, transparent); color: color-mix(in srgb, #b91c1c 80%, var(--ink)); }
.diff-xtreme { background: var(--solid); color: var(--on-solid); }

/* Listas */
.up-list-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.up-list-card { display: flex; align-items: flex-start; gap: 12px; background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow);
  padding: 16px; color: var(--ink); text-decoration: none; transition: transform .15s; }
.up-list-card:hover { transform: translateY(-2px); }
.up-list-icon { width: 34px; height: 34px; border-radius: 10px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  background: var(--accent-soft); color: var(--accent); }
.up-list-name { font-weight: 600; font-size: 14px; line-height: 1.3; }
.up-list-sub { font-size: 12px; color: var(--muted); margin-top: 3px; }
.up-list-desc { font-size: 12px; color: var(--ink-2); margin-top: 4px; line-height: 1.4; }

/* Estadísticas */
.up-stats-boxes { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 16px; }
.up-stat-box { background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px 20px; position: relative; overflow: hidden; }
.up-stat-box::after { content: ''; position: absolute; right: -18px; top: -18px; width: 70px; height: 70px; border-radius: 50%; background: var(--accent-soft); opacity: .7; }
.up-stat-val { font-size: 24px; font-weight: 700; letter-spacing: -.02em; font-variant-numeric: tabular-nums; position: relative; z-index: 1; }
.up-stat-lbl { font-size: 12px; color: var(--muted); margin-top: 2px; font-weight: 500; position: relative; z-index: 1; }
.up-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 16px; }
.up-chart-title { font-size: 15px; font-weight: 600; margin: 0 0 14px; }
</style>`;

  return {
    status: 200,
    html: page({ title: name, description, canonical: canonical + (pageNo ? `?p=${pageNo}` : ''), base, viewer, body, head,
      image: avatarUrl(u.avatar_key), noindex: !u.profile_public,
      jsonLd: { '@context': 'https://schema.org', '@type': 'ProfilePage', mainEntity: { '@type': 'Person', name, alternateName: u.username, url: base + canonical } } }),
  };
}

// ── List ────────────────────────────────────────────────────────────
async function renderList(db, id, { base, viewer, slug }) {
  const l = await db.get(
    `SELECT l.id, l.name, l.description, u.username, u.display_name, u.profile_public
     FROM user_lists l JOIN users u ON u.id = l.owner_id WHERE l.id = ? AND l.visibility = 'public' AND u.active`, [id]);
  if (!l) return { status: 404, html: notFound({ base, viewer, what: 'Esta lista' }) };
  const canonical = listPath(l);
  if (slug !== canonical.slice(`/lista/${l.id}`.length)) return { status: 301, location: canonical };
  const routes = await db.all(
    `SELECT t.id, t.name, t.activity, t.sierra, t.distance, t.elevation_gain, t.cover_photo_id
     FROM user_list_tracks lt JOIN tracks t ON t.id = lt.track_id JOIN users u ON u.id = t.owner_id
     WHERE lt.list_id = ? AND ${WEB_VISIBLE} ORDER BY lt.position, t.name`, [l.id]);
  const actImg = await activityImages(db);
  const owner = l.display_name || l.username;
  const description = clip(l.description || `Lista de ${routes.length} rutas de ${owner} en GPX Library.`, 160);
  const body = `
  <div class="pub-head"><div>
    <div class="pub-kicker">Lista de ${l.profile_public ? `<a href="${esc(userPath(l.username))}">${esc(owner)}</a>` : esc(owner)} · ${routes.length} rutas</div>
    <h1>${esc(l.name)}</h1>
    ${l.description ? `<p class="pub-desc" style="max-width:68ch">${esc(l.description)}</p>` : ''}
  </div>${viewer ? `<div class="pub-actions"><a class="btn" href="/lista?id=${l.id}">Ver con el mapa</a></div>` : ''}</div>
  ${routes.length ? `<div class="pub-list">${routes.map(t => routeCard(t, routeImage(t, actImg))).join('')}</div>`
    : '<p class="pub-note">Esta lista no tiene rutas visibles públicamente.</p>'}`;
  return { status: 200, html: page({ title: l.name, description, canonical, base, viewer, body,
    image: routes[0] ? routeImage(routes[0], actImg) : null,
    jsonLd: { '@context': 'https://schema.org', '@type': 'ItemList', name: l.name, numberOfItems: routes.length,
      itemListElement: routes.map((t, i) => ({ '@type': 'ListItem', position: i + 1, url: base + trackPath(t), name: t.name })) } }) };
}

// ── Sitemap and robots ──────────────────────────────────────────────
const SITEMAP_MAX = 50000;
async function renderSitemap(db, { base }) {
  const routes = await db.all(
    `SELECT t.id, t.name, to_char(t.imported_at, 'YYYY-MM-DD') AS d FROM tracks t JOIN users u ON u.id = t.owner_id
     WHERE ${WEB_VISIBLE} ORDER BY t.id LIMIT ${SITEMAP_MAX}`);
  const users = await db.all(
    `SELECT u.username FROM users u WHERE u.active AND u.profile_public
       AND EXISTS (SELECT 1 FROM tracks t WHERE t.owner_id = u.id AND ${WEB_VISIBLE}) ORDER BY u.id`);
  const lists = await db.all(
    `SELECT l.id, l.name FROM user_lists l JOIN users o ON o.id = l.owner_id WHERE l.visibility = 'public' AND o.active
       AND EXISTS (SELECT 1 FROM user_list_tracks lt JOIN tracks t ON t.id = lt.track_id JOIN users u ON u.id = t.owner_id
                   WHERE lt.list_id = l.id AND ${WEB_VISIBLE}) ORDER BY l.id`);
  const url = (loc, lastmod) => `  <url><loc>${esc(base + loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...routes.map(t => url(trackPath(t), t.d)), ...users.map(u => url(userPath(u.username))), ...lists.map(l => url(listPath(l)))].join('\n')}
</urlset>
`;
}

function renderRobots({ base }) {
  return `User-agent: *
Allow: /ruta/
Allow: /u/
Allow: /lista/
Disallow: /api/
Disallow: /admin
Disallow: /editor
Disallow: /perfil
Disallow: /login
Disallow: /registro
Disallow: /restablecer

Sitemap: ${base}/sitemap.xml
`;
}

module.exports = { WEB_VISIBLE, routeMeta, injectRoute, renderProfile, renderList, renderSitemap, renderRobots, trackPath, listPath, userPath, jsonForScript, esc };
