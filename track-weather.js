'use strict';
// Forecast for a ride along the route (Tiempo tab of the route page) and the «Viento en la ruta» map layer.
// The user picks the start day and time; the end comes from the route duration (recorded time, or an
// estimate from distance and ascent). Open-Meteo is asked for the hourly forecast at points spread along
// the route, and every value is read at the moment the rider is expected to pass that point.
// Air quality: Open-Meteo air-quality API (European AQI, CAMS), which only covers the next ~5 days.
// Public API: window.gpxRideWeather.init(panelEl, { track, map, layersCtl, onHover(idx|null) }).
(function () {
  const H = 3600e3;
  const WMO = {
    0:['☀️','Despejado'], 1:['🌤️','Mayormente despejado'], 2:['⛅','Parcialmente nublado'], 3:['☁️','Nublado'],
    45:['🌫️','Niebla'], 48:['🌫️','Niebla con escarcha'], 51:['🌦️','Llovizna ligera'], 53:['🌦️','Llovizna'],
    55:['🌧️','Llovizna intensa'], 56:['🌧️','Llovizna helada'], 57:['🌧️','Llovizna helada'], 61:['🌧️','Lluvia ligera'],
    63:['🌧️','Lluvia'], 65:['🌧️','Lluvia intensa'], 66:['🌧️','Lluvia helada'], 67:['🌧️','Lluvia helada'],
    71:['❄️','Nieve ligera'], 73:['❄️','Nieve'], 75:['❄️','Nevada intensa'], 77:['❄️','Granizo fino'],
    80:['🌦️','Chubascos'], 81:['🌦️','Chubascos fuertes'], 82:['⛈️','Chubascos muy fuertes'],
    85:['❄️','Chubascos de nieve'], 86:['❄️','Chubascos de nieve fuertes'],
    95:['⛈️','Tormenta'], 96:['⛈️','Tormenta con granizo'], 99:['⛈️','Tormenta fuerte'],
  };
  // Same effort groups as the multi-day detector (domain/gamification.js): hours = km / kmh + ascent / climbMh
  const GROUPS = [
    { kmh: 22,  climbMh: 900, re: /carretera/i },
    { kmh: 16,  climbMh: 800, re: /mtb|btt|gravel|bikepacking|bici|ciclis/i },
    { kmh: 8,   climbMh: 700, re: /running|trail|correr/i },
    { kmh: 4.5, climbMh: 500, re: /./ },
  ];
  // European AQI bands with the Spanish ICA names
  const AQI_BANDS = [
    [0, 20, 'Buena', '#50f0e6'], [20, 40, 'Razonablemente buena', '#50ccaa'], [40, 60, 'Regular', '#f0e641'],
    [60, 80, 'Desfavorable', '#ff5050'], [80, 100, 'Muy desfavorable', '#960032'], [100, 1e9, 'Extremadamente desfavorable', '#7d2181'],
  ];
  // [sub-index, label, concentration (µg/m³)]
  const AQ_VARS = [
    ['european_aqi', 'ICA general', null], ['european_aqi_pm2_5', 'PM2.5', 'pm2_5'], ['european_aqi_pm10', 'PM10', 'pm10'],
    ['european_aqi_ozone', 'Ozono', 'ozone'], ['european_aqi_nitrogen_dioxide', 'NO₂', 'nitrogen_dioxide'],
  ];
  const AQ_FETCH = AQ_VARS.flatMap(v => v[2] ? [v[0], v[2]] : [v[0]]);
  const WX_VARS = ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'dew_point_2m', 'precipitation_probability',
    'precipitation', 'cloud_cover', 'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'weather_code'];
  const C = { blue: '#3b82f6', orange: '#f59e0b', grey: '#94a3b8', favor: '#22c55e', lateral: '#f59e0b', contra: '#ef4444', calma: '#94a3b8' };
  const REL = { favor: 'A favor', lateral: 'Lateral', contra: 'En contra', calma: 'Calma' };
  const STEPS = 60;   // moments along the ride used for charts and the map

  const S = {};       // module state (one route per page)
  const $ = sel => S.panel.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const num = (n, d = 0) => n == null || isNaN(n) ? '—' : (+n).toLocaleString('es-ES', { maximumFractionDigits: d, minimumFractionDigits: d });
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  const hav = (a, b) => { const x = Math.sin(rad(b[0]-a[0])/2)**2 + Math.cos(rad(a[0]))*Math.cos(rad(b[0]))*Math.sin(rad(b[1]-a[1])/2)**2; return 2*6371*Math.asin(Math.sqrt(x)); };
  const bearing = (a, b) => { const y = Math.sin(rad(b[1]-a[1]))*Math.cos(rad(b[0])), x = Math.cos(rad(a[0]))*Math.sin(rad(b[0])) - Math.sin(rad(a[0]))*Math.cos(rad(b[0]))*Math.cos(rad(b[1]-a[1])); return (deg(Math.atan2(y, x)) + 360) % 360; };
  const CARD = ['N','NE','E','SE','S','SO','O','NO'];
  const cardinal = d => CARD[Math.round(((d % 360) + 360) % 360 / 45) % 8];
  // Times are shown in the route's own time zone (offset from the daily forecast)
  const loc = ms => new Date(ms + S.off * 1000);
  const fmtT = ms => { const d = loc(ms); return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
  const DAYS = ['dom','lun','mar','mié','jue','vie','sáb'], MONTHS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const fmtDay = ms => { const d = loc(ms); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
  const isoDay = ms => new Date(ms).toISOString().slice(0, 10);   // UTC date of an instant
  const aqiBand = v => AQI_BANDS.find(b => v < b[1]) || AQI_BANDS[AQI_BANDS.length - 1];
  const bandText = c => `color-mix(in srgb, ${c} 65%, var(--ink))`;
  const stat = arr => { const v = (arr || []).filter(x => x != null); return v.length ? { min: Math.min(...v), max: Math.max(...v), avg: v.reduce((a, b) => a + b, 0) / v.length } : null; };

  // ── Entry point ─────────────────────────────────────────────────
  async function init(panel, opts) {
    if (S.panel) return;
    Object.assign(S, { panel, ...opts, wxCache: {}, aq: null, aqTab: 'european_aqi', windOn: false, layer: null, legend: null, charts: {} });
    const t = S.track;
    S.pts = (t.points || []).filter(p => p && p[0] != null && p[1] != null);
    if (S.pts.length < 2) { panel.innerHTML = '<p class="wx-note">La ruta no tiene puntos para calcular la previsión.</p>'; return; }
    S.cum = [0];
    for (let i = 1; i < S.pts.length; i++) S.cum.push(S.cum[i - 1] + hav(S.pts[i - 1], S.pts[i]));
    S.total = S.cum[S.cum.length - 1] || 0.001;
    // Duration: recorded time when the GPX has it, else an estimate from distance and ascent
    const rec = t.moving_time ? (Number(t.moving_time) + Math.max(0, Number(t.stopped_time) || 0)) / 3600 : null;
    const g = GROUPS.find(x => x.re.test(t.activity || ''));
    const est = (Number(t.distance) || S.total) / g.kmh + (Number(t.elevation_gain) || 0) / g.climbMh;
    const useRec = rec && rec > 0.1 && rec < 72;
    S.durSrc = useRec ? 'el tiempo registrado en el track' : 'la distancia y el desnivel';
    S.dur = Math.max(0.25, Math.round((useRec ? rec : est) * 4) / 4);
    // Sample points every few km (6–20 of them): Open-Meteo answers all of them in one request
    const n = Math.max(6, Math.min(20, Math.round(S.total / 4) + 1));
    S.samples = [];
    for (let k = 0; k < n; k++) {
      const d = S.total * k / (n - 1);
      S.samples.push({ d, p: S.pts[pointAt(d)] });
    }

    panel.innerHTML = '<p class="wx-note">Cargando la previsión…</p>';
    try {
      const p0 = S.pts[0];
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${p0[0].toFixed(4)}&longitude=${p0[1].toFixed(4)}` +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max&timezone=auto&forecast_days=7&wind_speed_unit=kmh');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      S.daily = await r.json();
    } catch {
      panel.innerHTML = '<p class="wx-note">No se pudo obtener la previsión meteorológica.</p>';
      return;
    }
    S.off = S.daily.utc_offset_seconds || 0;
    // Default start: next full hour in the route's time zone, or 9:00 when that would end at night
    const now = loc(Date.now());
    let hh = now.getUTCHours() + 1, day = 0;
    if (hh < 7) hh = 9;
    else if (hh + S.dur > 21) { day = 1; hh = 9; }
    S.date = S.daily.daily.time[Math.min(day, S.daily.daily.time.length - 1)];
    S.time = `${String(hh).padStart(2, '0')}:00`;
    renderShell();
    if (S.map) ensureLayer();   // «Viento en la ruta» shows up in the layers control
    update();
  }

  // ── Layout ──────────────────────────────────────────────────────
  function renderShell() {
    const d = S.daily.daily;
    const days = d.time.map((iso, i) => {
      const dt = new Date(iso + 'T12:00:00Z');
      const name = i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : DAYS[dt.getUTCDay()];
      const [ico, desc] = WMO[d.weather_code[i]] || ['🌡️', ''];
      const pp = d.precipitation_probability_max?.[i];
      return `<button type="button" class="wx-daybtn" data-date="${iso}" title="${esc(desc)}">
        <span class="wx-dn">${name}</span><span class="wx-dd">${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}</span>
        <span class="wx-di">${ico}</span>
        <span class="wx-dt">${Math.round(d.temperature_2m_max[i])}° <small>${Math.round(d.temperature_2m_min[i])}°</small></span>
        <span class="wx-dp">${pp ? '💧' + pp + ' %' : '&nbsp;'}</span></button>`;
    }).join('');
    const p0 = S.pts[0];
    S.panel.innerHTML = `
      <div class="wx">
        <div class="wx-sec-head">Día de la salida</div>
        <div class="wx-days">${days}</div>
        <div class="wx-form">
          <label>Salida<input type="time" class="input" id="wx-time" step="900" value="${S.time}"></label>
          <label>Duración (h)<input type="number" class="input" id="wx-dur" min="0.25" max="96" step="0.25" value="${S.dur}"></label>
          <div class="wx-arrive"><span>Llegada</span><b id="wx-arrive">—</b></div>
        </div>
        <div class="wx-hint">Duración calculada con ${S.durSrc}; se supone un ritmo constante.</div>
        <button type="button" class="btn btn-outline wx-windbtn" id="wx-windbtn">${windIcon(16)}<span>Ver viento en el mapa</span></button>
        <div id="wx-body"><p class="wx-note">Cargando la previsión…</p></div>
        <div class="wx-src">Datos: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0) ·
          <a href="https://www.windy.com/?${p0[0].toFixed(4)},${p0[1].toFixed(4)},10" target="_blank" rel="noopener">Ver en Windy →</a></div>
      </div>`;
    S.panel.querySelectorAll('.wx-daybtn').forEach(b => b.addEventListener('click', () => { S.date = b.dataset.date; update(); }));
    let tm;
    $('#wx-time').addEventListener('change', () => { if ($('#wx-time').value) { S.time = $('#wx-time').value; update(); } });
    $('#wx-dur').addEventListener('input', () => {
      const v = parseFloat($('#wx-dur').value);
      if (v > 0) { S.dur = Math.min(96, v); clearTimeout(tm); tm = setTimeout(update, 350); }
    });
    $('#wx-windbtn').addEventListener('click', () => setWind(!S.windOn));
  }

  // ── Forecast for the chosen start ───────────────────────────────
  async function update() {
    S.panel.querySelectorAll('.wx-daybtn').forEach(b => b.classList.toggle('active', b.dataset.date === S.date));
    const [y, m, d] = S.date.split('-').map(Number), [hh, mm] = S.time.split(':').map(Number);
    S.start = Date.UTC(y, m - 1, d, hh, mm) - S.off * 1000;
    S.end = S.start + S.dur * H;
    $('#wx-arrive').textContent = fmtT(S.end) + (fmtDay(S.end) !== fmtDay(S.start) ? ` (${fmtDay(S.end)})` : '');
    const body = $('#wx-body');
    const seq = (S.seq = (S.seq || 0) + 1);
    let wx;
    try { wx = await weatherFor(S.start, S.end); }
    catch { if (seq === S.seq) body.innerHTML = '<p class="wx-note">No se pudo obtener la previsión meteorológica.</p>'; return; }
    if (seq !== S.seq) return;
    S.ride = alongRide(wx, WX_VARS);
    if (!S.ride.ok) { body.innerHTML = '<p class="wx-note">No hay previsión para ese horario (la previsión llega a 7 días).</p>'; drawWind(); return; }
    S.charts = {};
    body.innerHTML = renderWeather();
    bindCharts(body);
    drawWind();
    // Air quality: one request per page (the next 7 days at a few points)
    if (!S.aq) S.aq = airQuality().catch(() => null);
    const aq = await S.aq;
    if (seq !== S.seq || !$('#wx-aq')) return;
    S.aqRide = aq ? alongRide(aq, AQ_FETCH) : null;
    renderAq();
  }

  function weatherFor(start, end) {
    const lastDay = S.daily.daily.time[S.daily.daily.time.length - 1];
    const from = [isoDay(start - H), lastDay].sort()[0], to = [isoDay(end + H), lastDay].sort()[0];
    const key = from + '_' + to;
    if (!S.wxCache[key]) {
      const lat = S.samples.map(s => s.p[0].toFixed(4)).join(','), lon = S.samples.map(s => s.p[1].toFixed(4)).join(',');
      S.wxCache[key] = fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${WX_VARS.join(',')}` +
        `&timezone=GMT&wind_speed_unit=kmh&start_date=${from}&end_date=${to}`)
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(j => parseLocations(j, S.samples))
        .catch(e => { delete S.wxCache[key]; throw e; });
    }
    return S.wxCache[key];
  }

  async function airQuality() {
    // CAMS is coarse (≈10 km): a handful of points is enough
    const n = Math.min(6, S.samples.length), smp = [];
    for (let k = 0; k < n; k++) smp.push(S.samples[Math.round(k * (S.samples.length - 1) / Math.max(1, n - 1))]);
    const r = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${smp.map(s => s.p[0].toFixed(4)).join(',')}` +
      `&longitude=${smp.map(s => s.p[1].toFixed(4)).join(',')}&hourly=${AQ_FETCH.join(',')}&timezone=GMT&forecast_days=7`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return parseLocations(await r.json(), smp);
  }

  // Open-Meteo answers an object for one location and an array for several
  function parseLocations(j, samples) {
    return (Array.isArray(j) ? j : [j]).map((o, i) => {
      const h = o.hourly;
      const out = { d: samples[i].d, t0: Date.parse(h.time[0] + 'Z'), n: h.time.length, h };
      if (h.wind_direction_10m) {   // direction is interpolated through its components
        out.u = h.wind_direction_10m.map(v => v == null ? null : Math.sin(rad(v)));
        out.v = h.wind_direction_10m.map(v => v == null ? null : Math.cos(rad(v)));
      }
      return out;
    });
  }

  function hourVal(Lc, arr, t, nearest) {
    if (!arr) return null;
    const x = (t - Lc.t0) / H;
    if (x < -0.01 || x > Lc.n - 1 + 0.01) return null;
    const i = Math.max(0, Math.min(Lc.n - 1, Math.floor(x))), f = x - i;
    if (nearest) return arr[Math.max(0, Math.min(Lc.n - 1, Math.round(x)))] ?? arr[i];
    const a = arr[i], b = arr[Math.min(i + 1, Lc.n - 1)];
    return a == null ? b : b == null ? a : a + (b - a) * f;
  }

  // Values at STEPS+1 moments of the ride, each one at its place on the route (between two sample points)
  function alongRide(locs, vars) {
    const out = { t: [], ok: false, dir: [] };
    vars.forEach(v => { out[v] = []; });
    for (let k = 0; k <= STEPS; k++) {
      const f = k / STEPS, d = S.total * f, t = S.start + (S.end - S.start) * f;
      let a = 0; while (a < locs.length - 2 && locs[a + 1].d < d) a++;
      const A = locs[a], B = locs[Math.min(a + 1, locs.length - 1)];
      const w = B.d > A.d ? Math.max(0, Math.min(1, (d - A.d) / (B.d - A.d))) : 0;
      out.t.push(t);
      vars.forEach(v => {
        if (v === 'weather_code') { const N = w < .5 ? A : B; out[v].push(hourVal(N, N.h[v], t, true)); return; }
        const va = hourVal(A, A.h[v], t), vb = hourVal(B, B.h[v], t);
        const val = va == null ? vb : vb == null ? va : va + (vb - va) * w;
        out[v].push(val);
        if (val != null) out.ok = true;
      });
      if (A.u) {
        const ua = hourVal(A, A.u, t), ub = hourVal(B, B.u, t), xa = hourVal(A, A.v, t), xb = hourVal(B, B.v, t);
        out.dir.push(ua == null || ub == null || xa == null || xb == null ? null : (deg(Math.atan2(ua + (ub - ua) * w, xa + (xb - xa) * w)) + 360) % 360);
      }
    }
    return out;
  }

  // ── Weather section ─────────────────────────────────────────────
  function renderWeather() {
    const R = S.ride;
    const T = stat(R.temperature_2m), AT = stat(R.apparent_temperature), PP = stat(R.precipitation_probability),
          PR = stat(R.precipitation), WS = stat(R.wind_speed_10m), WG = stat(R.wind_gusts_10m);
    // Notices for the ride
    const msgs = [];
    const firstOver = (arr, lim) => { const i = arr.findIndex(v => v != null && v >= lim); return i < 0 ? null : R.t[i]; };
    if (PP && PP.max >= 60) msgs.push(['🌧️', `Lluvia probable desde las ${fmtT(firstOver(R.precipitation_probability, 60))} (hasta ${num(PP.max)} %)`]);
    else if (PP && PP.max >= 30) msgs.push(['🌦️', `Posibles chubascos desde las ${fmtT(firstOver(R.precipitation_probability, 30))} (${num(PP.max)} %)`]);
    if (WG && WG.max >= 50) msgs.push(['💨', `Rachas fuertes de hasta ${num(WG.max)} km/h`]);
    else if (WS && WS.max >= 30) msgs.push(['💨', `Viento fuerte de hasta ${num(WS.max)} km/h`]);
    if (AT && AT.min <= 0) msgs.push(['🥶', `Sensación térmica bajo cero (mín. ${num(AT.min)} °C)`]);
    if (T && T.max >= 32) msgs.push(['🥵', `Calor: hasta ${num(T.max)} °C`]);
    if (R.temperature_2m.some(v => v == null)) msgs.push(['ℹ️', 'La previsión no cubre toda la salida']);
    if (!msgs.length) msgs.push(['🕒', 'Condiciones estables durante toda la salida']);

    // Hour by hour strip
    const hours = [];
    for (let t = Math.ceil(S.start / H) * H; t <= S.end && hours.length < 48; t += H) {
      const k = Math.round((t - S.start) / (S.end - S.start) * STEPS);
      const [ico, desc] = WMO[R.weather_code[k]] || ['·', ''];
      const dir = R.dir[k];
      hours.push(`<div class="wx-h" title="${esc(desc)}"><span class="wx-hh">${fmtT(t)}</span><span class="wx-hi">${ico}</span>
        <span class="wx-ht">${num(R.temperature_2m[k])}°</span>
        <span class="wx-hw">${dir == null ? '' : arrowSvg((dir + 180) % 360, 11)}${num(R.wind_speed_10m[k])}</span></div>`);
    }

    // Wind relative to the direction of travel (share of the distance)
    const rel = { favor: 0, lateral: 0, contra: 0, calma: 0 };
    for (let k = 0; k < STEPS; k++) { const d = S.total * (k + .5) / STEPS; rel[relWind(d, bearingAt(d))]++; }
    const keys = Object.keys(rel).filter(k => rel[k]);
    const pct = k => Math.round(rel[k] / STEPS * 100);

    return `
      <div class="wx-alerts">${msgs.map(([i, m]) => `<div><span>${i}</span>${esc(m)}</div>`).join('')}</div>
      <div class="wx-gauges">
        ${gauge('Temperatura', T ? `${num(T.min)}–${num(T.max)}°` : '—', AT ? `Sensación ${num(AT.min)}–${num(AT.max)}°` : '',
          [[T, -10, 40, C.blue], [AT, -10, 40, C.orange]])}
        ${gauge('Precipitación', PP ? `${num(PP.max)} %` : '—', PR ? `Máx. ${num(PR.max, 1)} mm/h` : '',
          [[PP && { min: 0, max: PP.max }, 0, 100, C.blue], [PR && { min: 0, max: PR.max }, 0, 8, C.orange]])}
        ${gauge('Viento', WS ? `${num(WS.avg)} km/h` : '—', WG ? `Rachas ${num(WG.max)} km/h` : '',
          [[WS, 0, 60, C.blue], [WG, 0, 60, C.orange]])}
      </div>
      <div class="wx-sec-head">Hora a hora</div>
      <div class="wx-hours">${hours.join('')}</div>
      <div class="wx-sec-head">Viento respecto a la marcha</div>
      <div class="wx-relbar">${keys.map(k => `<span style="flex:${rel[k]};background:${C[k]}" title="${REL[k]} ${pct(k)} %"></span>`).join('')}</div>
      <div class="wx-legend">${keys.map(k => `<span><i style="background:${C[k]}"></i>${REL[k]} ${pct(k)} %</span>`).join('')}</div>
      <div class="wx-sec-head">Temperatura</div>
      ${chart({ yl: { u: '°C' }, series: [{ v: R.apparent_temperature, c: C.orange, fill: true, name: 'Sensación térmica', u: '°C' }, { v: R.temperature_2m, c: C.blue, name: 'Temperatura', u: '°C' }] })}
      <div class="wx-sec-head">Precipitación y nubosidad</div>
      ${chart({ yl: { min: 0, max: 100, u: '%' }, yr: { min: 0, max: Math.max(2, Math.ceil((PR?.max || 0) * 1.2)), u: 'mm/h' },
        series: [{ v: R.cloud_cover, c: C.grey, fill: true, name: 'Nubosidad', u: '%' }, { v: R.precipitation_probability, c: C.blue, name: 'Probabilidad', u: '%' },
                 { v: R.precipitation, c: C.orange, fill: true, axis: 'r', name: 'Intensidad', u: 'mm/h', dec: 1 }] })}
      <div class="wx-sec-head">Viento</div>
      ${chart({ yl: { min: 0, u: 'km/h' }, arrows: R.dir,
        series: [{ v: R.wind_gusts_10m, c: C.orange, fill: true, name: 'Rachas', u: 'km/h' }, { v: R.wind_speed_10m, c: C.blue, name: 'Viento', u: 'km/h' }] })}
      <div class="wx-sec-head">Humedad y punto de rocío</div>
      ${chart({ yl: { min: 0, max: 100, u: '%' }, yr: { u: '°C' },
        series: [{ v: R.relative_humidity_2m, c: C.blue, fill: true, name: 'Humedad', u: '%' }, { v: R.dew_point_2m, c: C.orange, axis: 'r', name: 'Punto de rocío', u: '°C' }] })}
      <div class="wx-sec-head">Calidad del aire</div>
      <div id="wx-aq"><p class="wx-note">Cargando la calidad del aire…</p></div>`;
  }

  function renderAq() {
    const box = $('#wx-aq');
    const A = S.aqRide;
    if (!A || !A.european_aqi.some(v => v != null)) {
      box.innerHTML = '<p class="wx-note">Sin previsión de calidad del aire para ese horario: solo cubre los próximos 5 días.</p>';
      return;
    }
    const gen = A.european_aqi;
    let iMax = gen.findIndex(v => v != null);
    gen.forEach((v, i) => { if (v != null && v > gen[iMax]) iMax = i; });
    const vMax = gen[iMax], band = aqiBand(vMax), gs = stat(gen);
    // Main pollutant: the sub-index that drives the general index at its worst moment
    const main = AQ_VARS.slice(1).map(v => [v, A[v[0]][iMax] ?? -1]).sort((a, b) => b[1] - a[1])[0][0];
    const sel = AQ_VARS.find(v => v[0] === S.aqTab) || AQ_VARS[0];
    const conc = sel[2] ? stat(A[sel[2]]) : null;
    const top = Math.max(100, Math.ceil(((stat(A[sel[0]]) || {}).max || 0) / 20) * 20 + 20);
    box.innerHTML = `
      <div class="wx-aq-top">
        ${gauge('ICA máximo', num(vMax), `a las ${fmtT(A.t[iMax])}`, [[{ min: 0, max: vMax }, 0, 120, band[3]]],
          `<div class="wx-aq-cat" style="color:${bandText(band[3])}">${band[2]}</div>`)}
        <div class="wx-aq-info">
          <div>Contaminante principal: <b>${main[1]}</b></div>
          <div class="wx-aq-val">ICA <b style="color:${bandText(band[3])}">${num(vMax)}</b></div>
          <div class="wx-note">🕒 ${gs.max - gs.min < 20 ? 'Condiciones estables durante toda la salida' : `Entre ${num(gs.min)} y ${num(gs.max)} durante la salida`}</div>
        </div>
      </div>
      <div class="cat-pills wx-aq-pills">${AQ_VARS.map(v => `<button type="button" class="cat-pill${v[0] === sel[0] ? ' active' : ''}" data-aq="${v[0]}">${v[1]}</button>`).join('')}</div>
      ${chart({ yl: { min: 0, max: top, u: 'ICA' }, bands: AQI_BANDS, tArr: A.t, series: [{ v: A[sel[0]], c: 'var(--ink)', name: sel[1], u: '' }] })}
      ${conc ? `<div class="wx-note">${sel[1]}: entre ${num(conc.min)} y ${num(conc.max)} µg/m³ durante la salida</div>` : ''}
      <div class="wx-note">Índice europeo de calidad del aire (CAMS), con resolución de unos 10 km.</div>`;
    box.querySelectorAll('[data-aq]').forEach(b => b.addEventListener('click', () => { S.aqTab = b.dataset.aq; renderAq(); }));
    bindCharts(box);
  }

  // ── SVG pieces ──────────────────────────────────────────────────
  function arrowSvg(toDeg, size) {
    return `<svg class="wx-arrow" width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(${Math.round(toDeg)}deg)"><path d="M12 2 L19 20 L12 16 L5 20 Z" fill="currentColor"/></svg>`;
  }
  function windIcon(s) {
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8"/></svg>`;
  }

  // 270° gauge with one arc per ring covering min..max of a series on its scale
  function gauge(label, value, sub, rings, extra = '') {
    const cx = 60, cy = 54, a0 = 135, span = 270;
    const pt = (r, a) => [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))];
    const arc = (r, from, to) => {
      const [x1, y1] = pt(r, from), [x2, y2] = pt(r, to);
      return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    };
    const parts = rings.map(([st, lo, hi, color], i) => {
      const r = 46 - i * 9;
      let s = `<path d="${arc(r, a0, a0 + span)}" class="wx-gtrack" stroke-width="7" fill="none" stroke-linecap="round"/>`;
      if (st) {
        const f = v => a0 + span * Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
        let from = f(st.min); const to = f(st.max);
        if (to - from < 3) from = Math.max(a0, to - 3);
        s += `<path d="${arc(r, from, Math.max(to, from + 0.5))}" stroke="${color}" stroke-width="7" fill="none" stroke-linecap="round"/>`;
      }
      return s;
    }).join('');
    return `<div class="wx-gauge"><svg viewBox="0 0 120 96" width="100%">${parts}
      <text x="60" y="${rings.length > 1 ? 58 : 60}" text-anchor="middle" class="wx-gv">${esc(value)}</text></svg>
      <div class="wx-gl">${esc(label)}</div><div class="wx-gs">${esc(sub)}</div>${extra}</div>`;
  }

  // Line/area chart over the ride time. series: [{v, c, fill, axis:'l'|'r', name, u, dec}]
  let chartN = 0;
  function chart({ series, yl = {}, yr = null, bands = null, arrows = null, tArr = null }) {
    const W = 360, Hh = 150, Lm = 34, Rm = yr ? 34 : 10, T = arrows ? 24 : 12, B = 20;
    tArr = tArr || S.ride.t;
    const scale = (ax, list) => {
      const vals = list.flatMap(s => s.v.filter(x => x != null));
      let lo = ax.min ?? Math.min(...vals), hi = ax.max ?? Math.max(...vals);
      if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
      if (ax.min != null && ax.max != null) return { lo, hi };
      // Free ends: round to a clean step so the four grid lines get round values
      if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
      for (const step of [0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100]) {
        const a = ax.min ?? Math.floor(lo / step) * step;
        if (a + 4 * step >= hi && (ax.max == null || a + 4 * step <= ax.max)) return { lo: a, hi: a + 4 * step };
      }
      return { lo, hi: Math.max(hi, lo + 1) };
    };
    const sl = scale(yl, series.filter(s => s.axis !== 'r')), sr = yr ? scale(yr, series.filter(s => s.axis === 'r')) : null;
    const x = i => Lm + (W - Lm - Rm) * i / (tArr.length - 1);
    const y = (v, s) => T + (Hh - T - B) * (1 - (v - s.lo) / (s.hi - s.lo));
    let g = '';
    if (bands) bands.forEach(([lo, hi, name, col]) => {
      if (lo >= sl.hi) return;
      const y1 = y(Math.min(hi, sl.hi), sl), y2 = y(Math.max(lo, sl.lo), sl);
      g += `<rect x="${Lm}" y="${y1.toFixed(1)}" width="${W - Lm - Rm}" height="${(y2 - y1).toFixed(1)}" fill="${col}" fill-opacity=".22"/>`;
      if (y2 - y1 > 11) g += `<text x="${W - Rm - 4}" y="${(y2 - 4).toFixed(1)}" text-anchor="end" class="wx-band" style="fill:${bandText(col)}">${name}</text>`;
    });
    const decs = s => Number.isInteger((s.hi - s.lo) / 4) ? 0 : 1;
    for (let k = 0; k <= 4; k++) {
      const yy = T + (Hh - T - B) * k / 4;
      g += `<line x1="${Lm}" x2="${W - Rm}" y1="${yy}" y2="${yy}" class="wx-grid"/>`;
      g += `<text x="${Lm - 4}" y="${yy + 3}" text-anchor="end" class="wx-ax">${num(sl.hi - (sl.hi - sl.lo) * k / 4, decs(sl))}</text>`;
      if (sr) g += `<text x="${W - Rm + 4}" y="${yy + 3}" class="wx-ax">${num(sr.hi - (sr.hi - sr.lo) * k / 4, decs(sr))}</text>`;
    }
    for (let k = 0; k <= 4; k++) {
      const i = Math.round((tArr.length - 1) * k / 4), xx = x(i);
      g += `<line x1="${xx}" x2="${xx}" y1="${T}" y2="${Hh - B}" class="wx-grid"/>`;
      g += `<text x="${xx}" y="${Hh - 6}" text-anchor="${k === 0 ? 'start' : k === 4 ? 'end' : 'middle'}" class="wx-ax">${fmtT(tArr[i])}</text>`;
    }
    if (!arrows) {
      if (yl.u) g += `<text x="${Lm - 4}" y="8" text-anchor="end" class="wx-ax wx-unit">${yl.u}</text>`;
      if (sr && yr.u) g += `<text x="${W - Rm + 4}" y="8" class="wx-ax wx-unit">${yr.u}</text>`;
    }
    series.forEach(s => {
      const sc = s.axis === 'r' ? sr : sl;
      const runs = []; let cur = [];
      s.v.forEach((v, i) => { if (v != null) cur.push([x(i), y(Math.max(sc.lo, Math.min(sc.hi, v)), sc)]); else if (cur.length) { runs.push(cur); cur = []; } });
      if (cur.length) runs.push(cur);
      const base = y(sc.lo <= 0 && sc.hi >= 0 ? 0 : sc.lo, sc).toFixed(1);
      runs.forEach(run => {
        const d = run.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
        if (s.fill) g += `<path d="${d}L${run[run.length - 1][0].toFixed(1)} ${base}L${run[0][0].toFixed(1)} ${base}Z" style="fill:${s.c}" fill-opacity=".22"/>`;
        g += `<path d="${d}" fill="none" style="stroke:${s.c}" stroke-width="2" stroke-linejoin="round"/>`;
      });
    });
    // Wind direction arrows along the top (pointing where the wind blows to)
    if (arrows) for (let k = 0; k <= 8; k++) {
      const i = Math.round((arrows.length - 1) * k / 8), dir = arrows[i];
      if (dir == null) continue;
      g += `<g transform="translate(${x(i).toFixed(1)} 11) rotate(${Math.round((dir + 180) % 360)})"><path d="M0 -7 L5 6 L0 3 L-5 6 Z" class="wx-arr"/></g>`;
    }
    const id = 'wxc' + (++chartN);
    S.charts[id] = { series, tArr, x, Lm, W, Rm, arrows };
    const legend = series.length > 1 ? `<div class="wx-legend">${series.map(s => `<span><i style="background:${s.c}"></i>${esc(s.name)}${s.u ? ' (' + esc(s.u) + ')' : ''}</span>`).join('')}</div>` : '';
    return `<div class="wx-chart" data-chart="${id}"><svg viewBox="0 0 ${W} ${Hh}" width="100%">${g}
      <line class="wx-cursor" x1="0" x2="0" y1="${T}" y2="${Hh - B}" style="display:none"/></svg>
      <div class="wx-tip" hidden></div>${legend}</div>`;
  }

  // Hover on a chart: cursor + values, and the matching point on the map
  function bindCharts(root) {
    root.querySelectorAll('.wx-chart').forEach(el => {
      const c = S.charts[el.dataset.chart]; if (!c) return;
      const svg = el.querySelector('svg'), cur = el.querySelector('.wx-cursor'), tip = el.querySelector('.wx-tip');
      const move = e => {
        const r = svg.getBoundingClientRect();
        const sx = (e.clientX - r.left) / r.width * c.W;
        const f = Math.max(0, Math.min(1, (sx - c.Lm) / (c.W - c.Lm - c.Rm)));
        const i = Math.round(f * (c.tArr.length - 1)), xx = c.x(i);
        cur.setAttribute('x1', xx); cur.setAttribute('x2', xx); cur.style.display = '';
        const dir = c.arrows ? c.arrows[i] : null;
        tip.innerHTML = `<div><b>${fmtT(c.tArr[i])}</b> · km ${num(S.total * i / (c.tArr.length - 1), 1)}${dir == null ? '' : ' · del ' + cardinal(dir)}</div>` +
          c.series.map(s => `<div><i style="background:${s.c}"></i>${esc(s.name)} <b>${num(s.v[i], s.dec || 0)}${s.u ? ' ' + esc(s.u) : ''}</b></div>`).join('');
        tip.hidden = false;
        const px = xx / c.W * r.width;
        tip.style.left = Math.max(0, Math.min(r.width - tip.offsetWidth, px - tip.offsetWidth / 2)) + 'px';
        if (S.onHover) S.onHover(pointAt(S.total * i / (c.tArr.length - 1)));
      };
      const leave = () => { cur.style.display = 'none'; tip.hidden = true; if (S.onHover) S.onHover(null); };
      svg.addEventListener('mousemove', move);
      svg.addEventListener('touchmove', e => { if (e.touches[0]) move(e.touches[0]); }, { passive: true });
      svg.addEventListener('mouseleave', leave);
      svg.addEventListener('touchend', leave);
    });
  }

  // ── Route geometry ──────────────────────────────────────────────
  function pointAt(d) { const j = S.cum.findIndex(c => c >= d); return j < 0 ? S.pts.length - 1 : j; }
  function bearingAt(d) {
    // Look ≈150 m behind and ahead so GPS noise does not flip the direction
    const j = pointAt(d); let a = j, b = j;
    while (a > 0 && S.cum[j] - S.cum[a] < 0.15) a--;
    while (b < S.pts.length - 1 && S.cum[b] - S.cum[j] < 0.15) b++;
    return bearing(S.pts[a], S.pts[b]);
  }
  function windAt(d) {
    const R = S.ride, i = Math.max(0, Math.min(STEPS, Math.round(d / S.total * STEPS)));
    return { dir: R.dir[i], speed: R.wind_speed_10m[i], gust: R.wind_gusts_10m[i], t: R.t[i] };
  }
  // Wind relative to the direction of travel at distance d
  function relWind(d, brg) {
    const w = windAt(d);
    if (w.dir == null || w.speed == null || w.speed < 5) return 'calma';
    const c = Math.cos(rad(w.dir + 180 - brg));   // 1 = blowing the way we go
    return c > 0.5 ? 'favor' : c < -0.5 ? 'contra' : 'lateral';
  }

  // ── Map layer «Viento en la ruta» ───────────────────────────────
  function setWind(on) {
    if (!S.map) return;
    ensureLayer();
    S.windOn = on;
    if (on && !S.map.hasLayer(S.layer)) S.layer.addTo(S.map);
    if (!on && S.map.hasLayer(S.layer)) S.map.removeLayer(S.layer);
    drawWind();
    if (on && S.layer.getLayers().length) {
      // Frame the route leaving room for the legend (top right)
      const o = S.fitOpts ? S.fitOpts() : { padding: [30, 30] }, lh = S.legend.getContainer().offsetHeight + 12;
      if (o.padding) { o.paddingTopLeft = [o.padding[0], o.padding[1]]; o.paddingBottomRight = [o.padding[0], o.padding[1]]; delete o.padding; }
      if (S.legendBottom) o.paddingBottomRight = [o.paddingBottomRight[0], o.paddingBottomRight[1] + lh];
      else o.paddingTopLeft = [o.paddingTopLeft[0], o.paddingTopLeft[1] + lh];
      S.map.fitBounds(L.latLngBounds(S.pts.map(p => [p[0], p[1]])), o);
    }
  }
  function syncWindUi() {
    const b = $('#wx-windbtn');
    if (b) { b.classList.toggle('active', S.windOn); b.querySelector('span').textContent = S.windOn ? 'Ocultar viento en el mapa' : 'Ver viento en el mapa'; }
    if (S.legend) S.legend.getContainer().style.display = S.windOn ? '' : 'none';
  }
  function ensureLayer() {
    if (S.layer) return;
    S.layer = L.layerGroup();
    if (S.layersCtl) S.layersCtl.addOverlay(S.layer, 'Viento en la ruta');
    S.map.on('overlayadd', e => { if (e.layer === S.layer) { S.windOn = true; drawWind(); } });
    S.map.on('overlayremove', e => { if (e.layer === S.layer) { S.windOn = false; syncWindUi(); } });
    const Leg = L.Control.extend({ onAdd: () => { const d = L.DomUtil.create('div', 'wx-map-legend'); L.DomEvent.disableClickPropagation(d); return d; } });
    // Top right on desktop (the panel covers the left); bottom left on phones, where the panel goes below the map
    S.legendBottom = window.innerWidth <= 900;
    S.legend = new Leg({ position: S.legendBottom ? 'bottomleft' : 'topright' }).addTo(S.map);
    S.map.on('zoomend', () => { if (S.windOn) drawWind(); });
  }
  function drawWind() {
    syncWindUi();
    if (!S.layer || !S.windOn) return;
    S.layer.clearLayers();
    const leg = S.legend.getContainer();
    if (!S.ride || !S.ride.ok) { leg.innerHTML = '<b>Viento</b><div>Sin previsión para ese horario</div>'; return; }
    // Route coloured by the wind relative to the direction of travel
    let run = [S.pts[0]], cls = null;
    const flush = () => { if (run.length > 1) L.polyline(run.map(p => [p[0], p[1]]), { color: C[cls], weight: 6, opacity: .9, lineCap: 'round', interactive: false }).addTo(S.layer); };
    for (let i = 1; i < S.pts.length; i++) {
      const d = (S.cum[i - 1] + S.cum[i]) / 2, c = relWind(d, bearingAt(d));
      if (cls && c !== cls) { flush(); run = [S.pts[i - 1]]; }
      cls = c; run.push(S.pts[i]);
    }
    flush();
    // Arrows along the route (one every ~60 px on screen), sized by wind speed, pointing where the wind blows to
    let px = 0;
    for (let i = 10; i < S.pts.length; i += 10) px += S.map.latLngToLayerPoint(S.pts[i - 10]).distanceTo(S.map.latLngToLayerPoint(S.pts[i]));
    const n = Math.max(6, Math.min(40, Math.round(px / 60)));
    for (let k = 0; k < n; k++) {
      const d = S.total * (k + 0.5) / n, w = windAt(d);
      if (w.dir == null) continue;
      const p = S.pts[pointAt(d)], sz = Math.round(18 + Math.min(1, (w.speed || 0) / 40) * 14);
      const icon = L.divIcon({ className: 'wx-map-arrow', iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2],
        html: `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" style="transform:rotate(${Math.round((w.dir + 180) % 360)}deg)"><path d="M12 2 L19 20 L12 15.5 L5 20 Z"/></svg>` });
      L.marker([p[0], p[1]], { icon, keyboard: false })
        .bindTooltip(`<b>${fmtT(w.t)}</b> · km ${num(d, 1)}<br>Viento ${num(w.speed)} km/h del ${cardinal(w.dir)}<br>Rachas ${num(w.gust)} km/h · ${REL[relWind(d, bearingAt(d))]}`, { direction: 'top' })
        .addTo(S.layer);
    }
    leg.innerHTML = `<b>Viento · ${fmtDay(S.start)}, ${fmtT(S.start)}–${fmtT(S.end)}</b>
      <div>${['favor', 'lateral', 'contra', 'calma'].map(k => `<span><i style="background:${C[k]}"></i>${REL[k]}</span>`).join('')}</div>`;
  }

  window.gpxRideWeather = { init };
})();
