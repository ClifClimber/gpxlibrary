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

    // User widget
    fetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(me => {
      if (!me) return;
      const wrap = document.createElement('span');
      wrap.className = 'nav-user';
      wrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink-2)';
      wrap.innerHTML = `<span style="color:var(--ink);font-weight:500">${me.username}</span>` +
        `<button type="button" class="btn btn-outline btn-sm" id="nav-logout-btn">Salir</button>`;
      nav.appendChild(wrap);
      wrap.querySelector('#nav-logout-btn').addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        location.href = '/login';
      });
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
