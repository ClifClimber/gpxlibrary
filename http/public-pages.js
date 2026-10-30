'use strict';
// Public pages (phase 4, block A): a route, a profile and a list, readable without an account and indexable.
// The HTML is generated here (title, description, data, Open Graph, JSON-LD) so search engines and link previews
// see it without running JavaScript; the map is then drawn in the browser from data embedded in the page.
//
// What anyone may see without a session ("web visible"): a public route whose owner keeps «Mostrar mis rutas
// públicas fuera de la aplicación» on, whose source web (tracks.url) is empty or confirmed as their own, and that
// the privacy zone doesn't hide entirely. Geometry is always the privacy-trimmed geom_s1, never the original.
const { slugify } = require('../domain/slug');

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
  .pub-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; margin-bottom: 14px; }
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
  .pub-item { display: block; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; color: var(--ink); text-decoration: none; }
  .pub-item:hover { box-shadow: var(--shadow); }
  .pub-item-img { height: 130px; background: var(--soft) center/cover no-repeat; }
  .pub-item-body { padding: 10px 12px 12px; }
  .pub-item-name { font-weight: 600; font-size: 14px; line-height: 1.35; }
  .pub-item-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .pub-note { font-size: 13px; color: var(--muted); }
  .pub-note a { color: var(--accent); }
  .pub-pages { display: flex; gap: 8px; justify-content: center; margin-top: 18px; }
  .pub-empty { text-align: center; padding: 60px 20px; color: var(--ink-2); }
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
async function renderProfile(db, username, { base, viewer, pageNo = 0 }) {
  const u = await db.get(
    `SELECT id, username, display_name, bio, avatar_key, profile_public, web_visible,
            to_char(created_at, 'YYYY') AS since FROM users WHERE lower(username) = lower(?) AND active`, [username]);
  // A private profile is only for people with an account
  if (!u || (!u.profile_public && !viewer)) return { status: 404, html: notFound({ base, viewer, what: 'Este perfil' }) };
  const canonical = userPath(u.username);
  const totals = await db.get(
    `SELECT CAST(COUNT(*) AS INTEGER) AS n, COALESCE(SUM(t.distance), 0) AS km, COALESCE(SUM(t.elevation_gain), 0) AS gain
     FROM tracks t JOIN users u ON u.id = t.owner_id WHERE t.owner_id = ? AND ${WEB_VISIBLE}`, [u.id]);
  const routes = await db.all(
    `SELECT t.id, t.name, t.activity, t.sierra, t.distance, t.elevation_gain, t.cover_photo_id
     FROM tracks t JOIN users u ON u.id = t.owner_id WHERE t.owner_id = ? AND ${WEB_VISIBLE}
     ORDER BY t.date DESC NULLS LAST, t.id DESC LIMIT ${PROFILE_PAGE} OFFSET ${pageNo * PROFILE_PAGE}`, [u.id]);
  const lists = await db.all(
    `SELECT l.id, l.name, CAST((SELECT COUNT(*) FROM user_list_tracks lt WHERE lt.list_id = l.id) AS INTEGER) AS n
     FROM user_lists l WHERE l.owner_id = ? AND l.visibility = 'public' ORDER BY l.created_at DESC`, [u.id]);
  const actImg = await activityImages(db);
  const name = u.display_name || u.username;
  const description = clip(u.bio || `Rutas de ${name} en GPX Library: ${totals.n} rutas, ${nf0.format(totals.km)} km y ${nf0.format(totals.gain)} m de desnivel.`, 160);
  const pages = Math.ceil(totals.n / PROFILE_PAGE);
  const body = `
  <div class="pub-head">
    <div style="display:flex;gap:16px;align-items:center">
      ${u.avatar_key ? `<img class="pub-avatar lg" src="${esc(avatarUrl(u.avatar_key))}" alt="">` : `<span class="pub-avatar lg">${esc(name.charAt(0).toUpperCase())}</span>`}
      <div><h1 style="margin:0">${esc(name)}</h1><div class="pub-kicker">@${esc(u.username)} · en GPX Library desde ${esc(u.since)}</div></div>
    </div>
  </div>
  ${u.bio ? `<p class="pub-desc" style="max-width:68ch">${esc(u.bio)}</p>` : ''}
  <div class="pub-card" style="max-width:520px"><div class="pub-stats" style="grid-template-columns:repeat(3,minmax(0,1fr))">
    <div class="pub-stat"><b>${nf0.format(totals.n)}</b><span>Rutas</span></div>
    <div class="pub-stat"><b>${nf0.format(totals.km)} km</b><span>Distancia</span></div>
    <div class="pub-stat"><b>${nf0.format(totals.gain)} m</b><span>Desnivel +</span></div>
  </div></div>
  <h2 style="font-size:18px;margin:24px 0 12px">Rutas</h2>
  ${routes.length ? `<div class="pub-list">${routes.map(t => routeCard(t, routeImage(t, actImg))).join('')}</div>`
    : `<p class="pub-note">${u.web_visible ? 'Todavía no hay rutas públicas.' : 'Las rutas de este usuario solo se ven dentro de GPX Library.'}</p>`}
  ${pages > 1 ? `<div class="pub-pages">${pageNo > 0 ? `<a class="btn" href="${esc(canonical)}?p=${pageNo - 1}">← Anteriores</a>` : ''}
    ${pageNo < pages - 1 ? `<a class="btn" href="${esc(canonical)}?p=${pageNo + 1}">Siguientes →</a>` : ''}</div>` : ''}
  ${lists.length ? `<h2 style="font-size:18px;margin:28px 0 12px">Listas</h2><div class="pub-list">${lists.map(l =>
    `<a class="pub-item" href="${esc(listPath(l))}"><div class="pub-item-body"><div class="pub-item-name">${esc(l.name)}</div><div class="pub-item-sub">${l.n} rutas</div></div></a>`).join('')}</div>` : ''}`;
  return {
    status: 200,
    html: page({ title: name, description, canonical: canonical + (pageNo ? `?p=${pageNo}` : ''), base, viewer, body,
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
