// Loaded in <head> (not deferred) so the saved theme applies before first paint.
(function () {
  // The Inter font is imported by shared.css: open the connections to its servers as early as possible
  for (const [h, co] of [['https://fonts.googleapis.com', false], ['https://fonts.gstatic.com', true]]) {
    const l = document.createElement('link'); l.rel = 'preconnect'; l.href = h; if (co) l.crossOrigin = ''; document.head.appendChild(l);
  }
  const KEY = 'gpx-theme';
  const root = document.documentElement;
  try { const t = localStorage.getItem(KEY); if (t === 'dark' || t === 'light') root.dataset.theme = t; } catch {}

  const mq = matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : mq.matches;
  window.gpxIsDark = isDark;

  const SUN  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  document.addEventListener('DOMContentLoaded', () => {
    const nav = document.querySelector('nav');
    if (!nav) return;

    // User icon in the top-right corner (avatar or initial); the name shows on hover via data-name.
    window.gpxSetNavUser = me => {
      let link = nav.querySelector('#nav-perfil');
      if (!link) {
        link = document.createElement('a');
        link.id = 'nav-perfil'; link.href = '/perfil'; link.className = 'nav-user';
        if (location.pathname === '/perfil') link.classList.add('active');
      }
      const name = me.display_name || me.username;
      link.removeAttribute('title');
      link.setAttribute('aria-label', name);
      link.dataset.name = name;
      link.textContent = '';
      if (me.avatar_url) {
        const img = document.createElement('img');
        img.className = 'nav-avatar'; img.alt = ''; img.src = me.avatar_url;
        link.appendChild(img);
      } else {
        const span = document.createElement('span');
        span.className = 'nav-avatar';
        span.textContent = name.charAt(0).toUpperCase();
        link.appendChild(span);
      }
      nav.appendChild(link);   // always last: right of the theme toggle
    };
    fetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(me => {
      if (!me) {
        // Without a session (public pages): the app links would only lead to the login, so offer that instead
        nav.querySelector('#nav-perfil')?.remove();
        nav.querySelectorAll('a:not(.logo):not(.nav-keep)').forEach(a => a.remove());
        if (!nav.querySelector('.nav-login')) {
          const next = encodeURIComponent(location.pathname + location.search);
          nav.insertAdjacentHTML('beforeend', '<span style="flex:1"></span>' +
            `<a class="nav-login nav-keep" href="/login?next=${next}">Entrar</a><a class="nav-upload nav-keep" href="/registro">Crear cuenta</a>`);
        }
        return;
      }
      window.gpxMe = me;
      window.gpxSetNavUser(me);
      if (!(me.prefs && me.prefs.web_notice_seen) && location.pathname !== '/perfil') {
        const bar = document.createElement('div');
        bar.className = 'web-notice';
        bar.innerHTML = '<span><b>Novedad:</b> tus rutas públicas ya se pueden ver en Internet sin cuenta y compartir con un enlace.' +
          '<span class="wn-more"> Puedes desactivarlo o activar una zona de privacidad en tu perfil.</span></span>' +
          '<a class="btn btn-sm wn-settings" href="/perfil">Ajustes</a><button class="btn btn-sm btn-primary" type="button">Entendido</button>';
        const seen = () => fetch('/api/profile/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ web_notice_seen: true }) }).catch(() => {});
        bar.querySelector('button').addEventListener('click', () => { seen(); bar.remove(); });
        bar.querySelector('a').addEventListener('click', seen);
        nav.after(bar);
      }
      // Admin is admin-only (the server refuses it too); the catalog is open to everyone
      if (me.role !== 'admin') nav.querySelectorAll('a[href="/admin"], a.admin-only').forEach(a => a.remove());
      // "Actividad" link (feed) for logged-in users
      if (!nav.querySelector('#nav-actividad')) {
        const act = document.createElement('a');
        act.id = 'nav-actividad'; act.href = '/actividad';
        if (location.pathname === '/actividad') act.classList.add('active');
        act.textContent = 'Actividad';
        const uicon = nav.querySelector('#nav-perfil');
        nav.insertBefore(act, uicon || null);
      }
      // "Upload Trail" chip next to the user (import/draw a single track)
      if (!nav.querySelector('#nav-upload')) {
        const up = document.createElement('a');
        up.id = 'nav-upload'; up.href = '/subir'; up.className = 'nav-upload';
        if (location.pathname === '/subir') up.classList.add('active');
        up.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span>Upload Trail</span>';
        const uicon = nav.querySelector('#nav-perfil');
        nav.insertBefore(up, uicon || null);
      }
      // Notification bell
      _initNotifBell(nav);
    }).catch(() => {});

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    const paint = () => {
      const dark = isDark();
      btn.innerHTML = dark ? SUN : MOON;
      btn.title = dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
      btn.setAttribute('aria-label', btn.title);
    };
    btn.addEventListener('click', () => {
      const next = isDark() ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem(KEY, next); } catch {}
      paint();
      window.dispatchEvent(new Event('themechange'));
    });
    mq.addEventListener('change', () => { if (!root.dataset.theme) { paint(); window.dispatchEvent(new Event('themechange')); } });
    paint();
    nav.appendChild(btn);
    _initNavMenu(nav, btn);
  });

  // Narrow screens (≤720 px, see shared.css): the text links and the theme toggle collapse into a dropdown.
  // The panel is filled when it opens, so it reflects the links theme.js adds or removes after /api/auth/me.
  function _initNavMenu(nav, themeBtn) {
    const MENU = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
    const mbtn = document.createElement('button');
    mbtn.type = 'button'; mbtn.className = 'nav-menu-btn';
    mbtn.setAttribute('aria-label', 'Menú'); mbtn.setAttribute('aria-haspopup', 'true');
    mbtn.setAttribute('aria-expanded', 'false'); mbtn.setAttribute('aria-controls', 'nav-menu');
    mbtn.innerHTML = MENU;
    nav.insertBefore(mbtn, nav.firstChild);
    const menu = document.createElement('div');
    menu.id = 'nav-menu'; menu.className = 'nav-menu';
    document.body.appendChild(menu);

    const close = () => { menu.classList.remove('open'); mbtn.setAttribute('aria-expanded', 'false'); };
    const fill = () => {
      menu.textContent = '';
      nav.querySelectorAll(':scope > a:not(.logo):not(.nav-user):not(.nav-upload):not(.nav-login)').forEach(a => {
        const c = document.createElement('a');
        c.href = a.getAttribute('href'); c.textContent = a.textContent.trim();
        if (a.classList.contains('active')) c.className = 'active';
        menu.appendChild(c);
      });
      if (menu.children.length) menu.insertAdjacentHTML('beforeend', '<div class="nav-menu-sep"></div>');
      const t = document.createElement('button');
      t.type = 'button';
      const dark = isDark();
      t.innerHTML = (dark ? SUN : MOON) + `<span>${dark ? 'Modo claro' : 'Modo oscuro'}</span>`;
      t.addEventListener('click', () => { themeBtn.click(); close(); });
      menu.appendChild(t);
    };
    mbtn.addEventListener('click', () => {
      if (menu.classList.contains('open')) return close();
      fill();
      menu.classList.add('open'); mbtn.setAttribute('aria-expanded', 'true');
    });
    // Capture phase: other nav handlers (the bell) stop propagation
    document.addEventListener('click', e => { if (!menu.contains(e.target) && !mbtn.contains(e.target)) close(); }, true);
    menu.addEventListener('click', e => { if (e.target.closest('a')) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && menu.classList.contains('open')) { close(); mbtn.focus(); } });
    matchMedia('(min-width: 721px)').addEventListener('change', e => { if (e.matches) close(); });
  }

  function _initNotifBell(nav) {
    if (nav.querySelector('#nav-notif')) return;

    // Bell button
    const bell = document.createElement('button');
    bell.id = 'nav-notif';
    bell.type = 'button';
    bell.setAttribute('aria-label', 'Notificaciones');
    bell.style.cssText = 'position:relative;background:none;border:none;cursor:pointer;padding:4px 6px;color:var(--ink-2);display:flex;align-items:center;border-radius:var(--radius)';
    bell.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

    // Badge
    const badge = document.createElement('span');
    badge.id = 'nav-notif-badge';
    badge.style.cssText = 'position:absolute;top:2px;right:2px;background:var(--danger);color:#fff;font-size:10px;font-weight:700;line-height:1;padding:1px 4px;border-radius:8px;display:none;min-width:16px;text-align:center';
    bell.appendChild(badge);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'nav-notif-panel';
    panel.style.cssText = 'position:fixed;top:48px;right:8px;width:320px;max-width:calc(100vw - 16px);max-height:420px;overflow-y:auto;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);z-index:1200;display:none;font-size:13px';
    document.body.appendChild(panel);

    const ICONS = { comment: '💬', rating: '⭐', done: '✓', follow: '👤' };
    const TEXTS = {
      comment: (r) => `<b>${r.actor_display_name || r.actor_username}</b> comentó en <b>${r.track_name || 'tu ruta'}</b>`,
      rating:  (r) => `<b>${r.actor_display_name || r.actor_username}</b> valoró <b>${r.track_name || 'tu ruta'}</b>`,
      done:    (r) => `<b>${r.actor_display_name || r.actor_username}</b> hizo <b>${r.track_name || 'tu ruta'}</b>`,
      follow:  (r) => `<b>${r.actor_display_name || r.actor_username}</b> ha empezado a seguirte`,
    };
    function relTime(ts) {
      const d = Date.now() - new Date(ts).getTime();
      if (d < 60000) return 'ahora';
      if (d < 3600000) return Math.floor(d / 60000) + ' min';
      if (d < 86400000) return Math.floor(d / 3600000) + ' h';
      return Math.floor(d / 86400000) + ' d';
    }
    function notifUrl(r) {
      if (r.track_id) return `/track?id=${r.track_id}`;
      if (r.type === 'follow' && r.actor_username) return `/u/${r.actor_username}`;
      return '#';
    }
    function renderPanel(rows) {
      if (!rows.length) {
        panel.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">Sin notificaciones</div>';
        return;
      }
      panel.innerHTML = rows.map(r => `
        <a href="${notifUrl(r)}" style="display:flex;gap:10px;align-items:flex-start;padding:10px 14px;text-decoration:none;color:var(--ink);border-bottom:1px solid var(--line);background:${r.read_at ? 'transparent' : 'color-mix(in srgb,var(--accent) 6%,transparent)'}">
          <span style="font-size:16px;flex-shrink:0;margin-top:1px">${ICONS[r.type] || '•'}</span>
          <span style="flex:1;min-width:0">
            <span style="display:block;line-height:1.4">${(TEXTS[r.type] || (() => r.type))(r)}</span>
            <span style="font-size:11px;color:var(--muted)">${relTime(r.created_at)}</span>
          </span>
        </a>`).join('');
    }

    let pollTimer;
    async function fetchNotifs(renderIfOpen) {
      try {
        const d = await fetch('/api/notifications').then(r => r.ok ? r.json() : null);
        if (!d) return;
        badge.textContent = d.unread > 9 ? '9+' : d.unread;
        badge.style.display = d.unread ? 'block' : 'none';
        if (renderIfOpen && panel.style.display !== 'none') renderPanel(d.rows);
        return d;
      } catch {}
    }

    async function openPanel() {
      const d = await fetchNotifs(false);
      if (d) renderPanel(d.rows);
      panel.style.display = 'block';
      badge.style.display = 'none';
      badge.textContent = '0';
      fetch('/api/notifications/read', { method: 'POST' }).catch(() => {});
    }
    function closePanel() { panel.style.display = 'none'; }

    bell.addEventListener('click', e => {
      e.stopPropagation();
      panel.style.display === 'none' ? openPanel() : closePanel();
    });
    document.addEventListener('click', e => {
      if (!panel.contains(e.target) && e.target !== bell) closePanel();
    });
    panel.addEventListener('click', () => closePanel());

    const uicon = nav.querySelector('#nav-perfil');
    nav.insertBefore(bell, uicon || null);

    fetchNotifs(false);
    pollTimer = setInterval(() => fetchNotifs(true), 60000);
    window.addEventListener('beforeunload', () => clearInterval(pollTimer));
  }
})();
