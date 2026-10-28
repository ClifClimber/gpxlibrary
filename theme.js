// Loaded in <head> (not deferred) so the saved theme applies before first paint.
(function () {
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
      if (!me) { nav.querySelector('#nav-perfil')?.remove(); return; }
      window.gpxSetNavUser(me);
      // Admin is admin-only (the server refuses it too); the catalog is open to everyone
      if (me.role !== 'admin') nav.querySelectorAll('a[href="/admin"], a.admin-only').forEach(a => a.remove());
      // "Upload Trail" chip next to the user (import/draw a single track)
      if (!nav.querySelector('#nav-upload')) {
        const up = document.createElement('a');
        up.id = 'nav-upload'; up.href = '/subir'; up.className = 'nav-upload';
        if (location.pathname === '/subir') up.classList.add('active');
        up.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span>Upload Trail</span>';
        const uicon = nav.querySelector('#nav-perfil');
        nav.insertBefore(up, uicon || null);   // just before the user icon
      }
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
  });
})();
