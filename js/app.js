/* app.js — UI: 2D map / 3D globe, place search, local date/time, data panels. */
(function () {
  'use strict';

  const A = window.Astronomy;
  const H = window.Hilal;
  const HJ = window.Hijri;
  const I18N = window.I18N;
  const tt = I18N.t; // translation (t stays free as a local time variable)
  const $ = (id) => document.getElementById(id);
  const DEG = Math.PI / 180;

  // Touch/mobile device per user agent (+ touch points for iPads with a
  // desktop UA). Drives touch-only tweaks; the layout itself is responsive
  // via CSS media queries.
  const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints || 0) > 1;
  if (IS_MOBILE) document.body.classList.add('mobile');

  // Height available for the map: full viewport on desktop, top 40% on
  // narrow screens (the sidebar takes the bottom 60%; keep in sync with CSS)
  const narrowLayout = () => innerWidth <= 720;
  const mapViewH = () => narrowLayout() ? Math.round(innerHeight * 0.4) : innerHeight;

  const CAT_COLORS = {
    A: '#00c853', B: '#aeea00', C: '#ffd600', D: '#ff9100',
    E: '#ff3d00', F: '#7f0000', S: '#546e7a', N: '#37474f', P: '#263238'
  };

  // ---------- State ----------
  const state = {
    loc: { lat: 21.4225, lon: 39.8262, elev: 300, name: 'La Meca (Makkah), Arabia Saudí', tz: 'Asia/Riyadh' },
    when: new Date(),   // selected UTC instant
    mapPoints: [],      // global visibility map (worker)
    mapRes: 4
  };

  // ---------- Time zones ----------
  function tzFor(lat, lon) {
    try { if (typeof tzlookup === 'function') return tzlookup(lat, lon); } catch (e) { /* out of range */ }
    const off = Math.round(lon / 15);
    return 'Etc/GMT' + (off === 0 ? '' : (off > 0 ? '-' : '+') + Math.abs(off)); // inverted sign (POSIX)
  }

  function partsInZone(date, tz) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    const p = {};
    for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
    return { y: +p.year, m: +p.month, d: +p.day, hh: (+p.hour) % 24, mm: +p.minute, ss: +p.second };
  }

  // Civil (wall) time in a zone → UTC instant
  function zonedTimeToUtc(y, m, d, hh, mm, tz) {
    const target = Date.UTC(y, m - 1, d, hh, mm, 0);
    let guess = target;
    for (let i = 0; i < 3; i++) {
      const p = partsInZone(new Date(guess), tz);
      const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
      guess += target - asUtc;
    }
    return new Date(guess);
  }

  function fmtLocal(dateLike, withDate) {
    const date = dateLike instanceof Date ? dateLike : dateLike.date;
    const opts = { timeZone: state.loc.tz, hour: '2-digit', minute: '2-digit', hour12: false };
    if (withDate !== false) { opts.day = '2-digit'; opts.month = '2-digit'; opts.year = 'numeric'; }
    return new Intl.DateTimeFormat(I18N.locale(), opts).format(date);
  }
  function fmtUTC(dateLike) {
    const date = dateLike instanceof Date ? dateLike : dateLike.date;
    return new Intl.DateTimeFormat(I18N.locale(), {
      timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date) + ' UTC';
  }

  const n = (x, dp) => (x === null || x === undefined || Number.isNaN(x)) ? '—' : x.toFixed(dp);
  const deg = (x, dp) => n(x, dp === undefined ? 2 : dp) + '°';
  function hm(hours) {
    if (hours === null || hours === undefined) return '—';
    const sign = hours < 0 ? '−' : '';
    const t = Math.abs(hours);
    return `${sign}${Math.floor(t)} h ${String(Math.round((t % 1) * 60)).padStart(2, '0')} min`;
  }
  const shortName = (s) => (s || '').split(',').slice(0, 2).join(',');

  // ---------- Geometry: 90° caps (night / lunar visibility) ----------
  /*
   * Boundary of the 90°-radius cap centred at (latC, lonC): it is a great
   * circle that crosses each meridian exactly once at
   *   φ(λ) = −atan( cos(λ−λc) / tan φc ),
   * and the region is closed through the given pole (poleSign = ±1).
   *  - Night: centre = subsolar point, closed through the pole opposite the Sun.
   *  - Moon visible (above the horizon): centre = sublunar point, closed
   *    through the pole of the Moon's own hemisphere.
   */
  function capRing(latC, lonC, poleSign, step) {
    let phiC = latC * DEG;
    if (Math.abs(phiC) < 1e-4) phiC = phiC < 0 ? -1e-4 : 1e-4;
    const ring = [];
    for (let lon = -180; lon <= 180; lon += (step || 2)) {
      const phi = -Math.atan(Math.cos((lon - lonC) * DEG) / Math.tan(phiC)) / DEG;
      ring.push([lon, phi]);
    }
    const curveLen = ring.length; // the curved part (to stroke only the boundary)
    ring.push([180, poleSign * 89.99], [-180, poleSign * 89.99], [ring[0][0], ring[0][1]]);
    return { ring, curveLen };
  }

  function sceneGeometry() {
    const t = A.MakeTime(state.when);
    const sun = H.subPoint(A.Body.Sun, t);
    const moon = H.subPoint(A.Body.Moon, t);
    return {
      sun, moon,
      night: capRing(sun.lat, sun.lon, -Math.sign(sun.lat || 1)),
      moonVis: capRing(moon.lat, moon.lon, Math.sign(moon.lat || 1))
    };
  }

  // ---------- Salat periods projected on the map ----------
  /*
   * At a given instant, the period in force at each point on the planet
   * depends only on the Sun's position relative to that point: its local hour
   * angle T (0..360°, measured from solar noon) and the hour angles at which
   * the horizon (−0.833°), dawn/twilight (the method's angle) and the asr
   * shadow condition are crossed. Everything is analytic (no searches), so
   * the whole planet is rasterised per pixel.
   */
  const BAND_COLORS = {
    dhuhr: [255, 213, 79, 70],
    asr: [255, 152, 0, 95],
    maghrib: [239, 83, 80, 110],
    isha: [126, 87, 194, 120],
    night: [48, 63, 159, 115],
    lastthird: [0, 151, 167, 110],
    fajr: [38, 198, 218, 105],
    polar: [40, 53, 90, 110]
  };

  function salatOpts() {
    const m = SALAT_METHODS[$('salat-method').value];
    return { fajrAngle: m.fajrAngle, ishaAngle: m.ishaAngle, ishaInterval: m.ishaInterval, asrFactor: +$('salat-asr').value };
  }

  // Parameters that depend only on latitude (constant per raster row)
  function salatRowParams(latDeg, sun, opts) {
    const phi = latDeg * DEG, dec = sun.lat * DEG;
    const sp = Math.sin(phi), cp = Math.cos(phi), sd = Math.sin(dec), cd = Math.cos(dec);
    const cosCross = (alt) => (Math.sin(alt * DEG) - sp * sd) / (cp * cd);
    const c0 = cosCross(-0.833);
    if (c0 < -1) return { polarDay: true };
    if (c0 > 1) return { polarNight: true };
    const H0 = Math.acos(c0) / DEG;
    const cf = cosCross(-opts.fajrAngle);
    // If the Sun never reaches the dawn angle (white nights), sunrise/sunset is used
    const Hf = cf <= -1 ? 180 : (cf >= 1 ? H0 : Math.acos(cf) / DEG);
    const nightLen = (360 - Hf) - H0;
    const Tmid = H0 + nightLen / 2, TL = H0 + nightLen * 2 / 3;
    let Hisha;
    if (opts.ishaInterval !== undefined && opts.ishaInterval !== null) {
      Hisha = H0 + opts.ishaInterval * 0.25068; // the Sun moves ~0.25°/min
    } else {
      const ci = cosCross(-opts.ishaAngle);
      Hisha = ci <= -1 ? 180 : (ci >= 1 ? Tmid : Math.acos(ci) / DEG);
    }
    Hisha = Math.min(Hisha, Tmid);
    const hAsr = Math.atan(1 / (opts.asrFactor + Math.tan(Math.abs(phi - dec)))) / DEG;
    return { H0, Hf, Hisha, Tmid, TL, hAsr, sp, cp, sd, cd };
  }

  function salatBandAt(rp, lonDeg, sunLon) {
    if (rp.polarDay) return null;
    if (rp.polarNight) return 'polar';
    let T = (lonDeg - sunLon) % 360;
    if (T < 0) T += 360; // 0..360 from local solar noon
    if (T < rp.H0) { // afternoon with the Sun above the horizon
      const h = Math.asin(rp.sp * rp.sd + rp.cp * rp.cd * Math.cos((lonDeg - sunLon) * DEG)) / DEG;
      return h <= rp.hAsr ? 'asr' : 'dhuhr';
    }
    if (T < rp.Hisha) return 'maghrib';
    if (T < rp.Tmid) return 'isha';
    if (T < rp.TL) return 'night';
    if (T < 360 - rp.Hf) return 'lastthird';
    if (T < 360 - rp.H0) return 'fajr';
    return null; // morning: from sunrise to noon there is no obligatory period
  }

  // Label for each prayer at the longitudinal centre of its band, at the
  // subsolar latitude (there the daytime geometry is regular and never polar).
  const BAND_LABELS = { fajr: 'Fajr', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };
  function salatBandLabels(sun) {
    const rp = salatRowParams(sun.lat, sun, salatOpts());
    if (rp.polarDay || rp.polarNight) return [];
    const ca = (Math.sin(rp.hAsr * DEG) - rp.sp * rp.sd) / (rp.cp * rp.cd);
    const Hasr = Math.acos(Math.max(-1, Math.min(1, ca))) / DEG;
    const mids = {
      dhuhr: Hasr / 2,
      asr: (Hasr + rp.H0) / 2,
      maghrib: (rp.H0 + rp.Hisha) / 2,
      isha: (rp.Hisha + rp.Tmid) / 2,
      fajr: 360 - (rp.Hf + rp.H0) / 2
    };
    return Object.entries(mids).map(([band, T]) => ({
      band,
      text: BAND_LABELS[band],
      lat: sun.lat,
      lon: ((sun.lon + T + 540) % 360) - 180
    }));
  }

  function drawSalatLabels(c, sun, lon2px, lat2px, fontPx) {
    const bands = enabledBands();
    c.font = `bold ${fontPx}px system-ui, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.strokeStyle = 'rgba(0,0,0,0.7)';
    c.lineWidth = fontPx / 4;
    c.fillStyle = '#fff';
    for (const l of salatBandLabels(sun)) {
      if (!bands.has(l.band)) continue;
      const x = lon2px(l.lon), y = lat2px(l.lat);
      c.strokeText(l.text, x, y);
      c.fillText(l.text, x, y);
    }
    c.textAlign = 'start'; c.textBaseline = 'alphabetic';
  }

  let salatCache = { key: null, canvas: null, texUrl: null };
  function getSalatLayer(sun) {
    const o = salatOpts();
    const bands = enabledBands();
    const key = [sun.lat.toFixed(3), sun.lon.toFixed(3), o.fajrAngle, o.ishaAngle, o.ishaInterval, o.asrFactor, [...bands].sort().join(',')].join('|');
    if (salatCache.key === key) return salatCache.canvas;
    const W = 720, Hh = 360;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = Hh;
    const cx = cv.getContext('2d');
    const img = cx.createImageData(W, Hh);
    const data = img.data;
    for (let yy = 0; yy < Hh; yy++) {
      const rp = salatRowParams(90 - (yy + 0.5) * 180 / Hh, sun, o);
      for (let xx = 0; xx < W; xx++) {
        const band = salatBandAt(rp, -180 + (xx + 0.5) * 360 / W, sun.lon);
        if (!band || !bands.has(band)) continue;
        const col = BAND_COLORS[band];
        const i = (yy * W + xx) * 4;
        data[i] = col[0]; data[i + 1] = col[1]; data[i + 2] = col[2]; data[i + 3] = col[3];
      }
    }
    cx.putImageData(img, 0, 0);
    salatCache = { key, canvas: cv, texUrl: null };
    return cv;
  }

  // Equirectangular texture (ocean + continent outlines + bands + labels)
  // for the 3D globe. The outline goes underneath: the bands are
  // semi-transparent (alpha component in BAND_COLORS) and let it show. At
  // twice the raster resolution so the labels stay legible.
  function getSalatTextureUrl(sun) {
    getSalatLayer(sun);
    if (salatCache.texUrl && salatCache.texLand === land.length) return salatCache.texUrl;
    const W = 1440, Hh = 720;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = Hh;
    const c = cv.getContext('2d');
    c.fillStyle = '#10395c';
    c.fillRect(0, 0, W, Hh);
    c.lineWidth = 1.2;
    c.strokeStyle = COAST;
    c.beginPath();
    for (const f of land) {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) for (const ring of poly) pathRing(c, ring, 0, 0, W, Hh);
    }
    c.stroke();
    c.drawImage(salatCache.canvas, 0, 0, W, Hh);
    drawSalatLabels(c, sun, lon => (lon + 180) / 360 * W, lat => (90 - lat) / 180 * Hh, 26);
    salatCache.texLand = land.length;
    salatCache.texUrl = cv.toDataURL('image/png');
    return salatCache.texUrl;
  }

  // ---------- Simple / advanced menu and visible layers ----------
  let uiMode = localStorage.getItem('hilal-menu') === 'adv' ? 'adv' : 'simple';
  const PRAYER_BANDS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  const ALL_BANDS = [...PRAYER_BANDS, 'night', 'lastthird', 'polar'];
  // Bands that get rasterised: in the simple menu, the checked prayers; in
  // the advanced one, all of them if the map checkbox is on.
  function enabledBands() {
    if (uiMode === 'simple') return new Set(PRAYER_BANDS.filter(b => $('chk-' + b).checked));
    return new Set($('salat-map').checked ? ALL_BANDS : []);
  }
  // Night and lunar-zone shading (always on in the advanced menu)
  const sunZoneOn = () => uiMode !== 'simple' || $('chk-sun').checked;
  const moonZoneOn = () => uiMode !== 'simple' || $('chk-moon').checked;
  const salatOnMap = () => enabledBands().size > 0;
  // The night fill is redundant when the raster already includes the night band
  const nightShadeOn = () => sunZoneOn() && !enabledBands().has('night');
  // For validation: period in force at given coordinates with the current state
  window.__salatBandAt = (lat, lon) => {
    const sun = H.subPoint(A.Body.Sun, A.MakeTime(state.when));
    return salatBandAt(salatRowParams(lat, sun, salatOpts()), lon, sun.lon);
  };

  // ---------- Continent outline data (no political borders) ----------
  const COAST = 'rgba(190,205,225,0.55)';

  let land = [];
  fetch('data/land.geojson')
    .then(r => r.json())
    .then(geo => { land = geo.features; base2d = null; renderScene(); })
    .catch(e => console.error('No se pudo cargar el contorno de continentes:', e));

  // ---------- View: 2D (canvas, default) / 3D (WebGL, on demand) ----------
  let view = localStorage.getItem('hilal-view') === '3d' ? '3d' : '2d';
  let G = null;       // globe.gl instance (only if the 3D view is used)
  let base2d = null;  // offscreen canvas with ocean + graticule + continent outlines
  const canvas = $('map2d');
  const ctx2d = canvas.getContext('2d');
  let mapRect = { x: 0, y: 0, w: 1, h: 1 }; // map area within the canvas

  function ensureGlobe() {
    if (G) return G;
    G = Globe({ rendererConfig: { antialias: false, powerPreference: 'low-power' } })($('globe'))
      .globeImageUrl(null)
      .backgroundImageUrl('img/night-sky.png')
      .showGraticules(true)
      .atmosphereColor('#7ba2ff')
      .atmosphereAltitude(0.18)
      .polygonsTransitionDuration(0)
      .polygonAltitude(d => d.properties.kind === 'night' ? 0.012 : d.properties.kind === 'moonvis' ? 0.015 : 0.006)
      // Continents are drawn as outlines only; the night shading is omitted
      // when the salat layer is active (the bands already encode the night).
      .polygonCapColor(d => d.properties.kind === 'night'
        ? (nightShadeOn() ? 'rgba(4,8,26,0.62)' : 'rgba(0,0,0,0)')
        : d.properties.kind === 'moonvis'
        ? (moonZoneOn() ? 'rgba(255,216,102,0.10)' : 'rgba(0,0,0,0)')
        : 'rgba(0,0,0,0)')
      .polygonSideColor(() => 'rgba(0,0,0,0)')
      .polygonStrokeColor(d => d.properties.kind === 'night'
        ? (sunZoneOn() ? 'rgba(120,150,255,0.45)' : 'rgba(0,0,0,0)')
        : d.properties.kind === 'moonvis'
        ? (moonZoneOn() ? 'rgba(255,216,102,0.85)' : 'rgba(0,0,0,0)')
        : COAST)
      .polygonLabel(() => '')
      .onPolygonClick((d, ev, coords) => { if (coords && Number.isFinite(coords.lat)) setLocation(coords.lat, coords.lng, null, true); })
      .pointsMerge(true)
      .pointAltitude(0.02)
      .pointRadius(2.2)
      .pointColor(d => CAT_COLORS[d.cat] || '#888')
      .htmlElementsData([])
      .htmlElement(d => {
        const el = document.createElement('div');
        if (d.type === 'pin') {
          el.className = 'marker-pin';
          el.innerHTML = '📍<div class="marker-label">' + (d.label || '') + '</div>';
        } else {
          el.className = 'marker-body';
          el.textContent = d.type === 'sun' ? '☀️' : '🌙';
          el.title = tt(d.type === 'sun' ? 'sun_pt' : 'moon_pt');
        }
        return el;
      })
      .onGlobeClick(({ lat, lng }) => setLocation(lat, lng, null, true));
    G.renderer().setPixelRatio(1); // less GPU load
    G.globeMaterial().color.set('#10395c');
    G.globeMaterial().shininess = 4;
    G.pointOfView({ lat: state.loc.lat, lng: state.loc.lon, altitude: 1.8 }, 0);
    return G;
  }

  function setView(v) {
    view = v;
    localStorage.setItem('hilal-view', v);
    $('view-2d').classList.toggle('active', v === '2d');
    $('view-3d').classList.toggle('active', v === '3d');
    $('map2d').classList.toggle('hidden', v !== '2d');
    $('globe').classList.toggle('hidden', v !== '3d');
    if (v === '3d') {
      ensureGlobe().resumeAnimation();
      G.width(innerWidth).height(mapViewH());
    } else if (G) {
      G.pauseAnimation(); // no WebGL render loop in the 2D view
    }
    renderScene();
  }
  $('view-2d').addEventListener('click', () => setView('2d'));
  $('view-3d').addEventListener('click', () => setView('3d'));
  document.addEventListener('visibilitychange', () => {
    if (G && view === '3d') document.hidden ? G.pauseAnimation() : G.resumeAnimation();
  });
  window.addEventListener('resize', () => {
    if (view === '3d' && G) G.width(innerWidth).height(mapViewH());
    base2d = null;
    renderScene();
  });

  // ---------- 2D render (equirectangular) ----------
  function layout2d() {
    const sbw = narrowLayout() ? 0 : 420;
    const availW = innerWidth - sbw, availH = mapViewH();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.style.left = sbw + 'px';
    canvas.style.width = availW + 'px';
    canvas.style.height = availH + 'px';
    canvas.width = Math.round(availW * dpr);
    canvas.height = Math.round(availH * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mw = Math.min(availW - 24, 2 * (availH - 24));
    const mh = mw / 2;
    mapRect = { x: (availW - mw) / 2, y: (availH - mh) / 2, w: mw, h: mh, dpr };
  }
  const lon2x = (lon) => mapRect.x + (lon + 180) / 360 * mapRect.w;
  const lat2y = (lat) => mapRect.y + (90 - lat) / 180 * mapRect.h;

  function pathRing(c, ring, x0, y0, w, h) {
    ring.forEach(([lon, lat], i) => {
      const x = x0 + (lon + 180) / 360 * w;
      const y = y0 + (90 - lat) / 180 * h;
      i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
    });
  }

  function buildBase2d() {
    const dpr = mapRect.dpr;
    base2d = document.createElement('canvas');
    base2d.width = Math.round(mapRect.w * dpr);
    base2d.height = Math.round(mapRect.h * dpr);
    const c = base2d.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = mapRect.w, h = mapRect.h;
    // Ocean
    c.fillStyle = '#10395c';
    c.fillRect(0, 0, w, h);
    // Graticule
    c.strokeStyle = 'rgba(255,255,255,0.08)';
    c.lineWidth = 1;
    c.beginPath();
    for (let lon = -150; lon <= 150; lon += 30) { c.moveTo((lon + 180) / 360 * w, 0); c.lineTo((lon + 180) / 360 * w, h); }
    for (let lat = -60; lat <= 60; lat += 30) { c.moveTo(0, (90 - lat) / 180 * h); c.lineTo(w, (90 - lat) / 180 * h); }
    c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.16)'; // equator
    c.beginPath(); c.moveTo(0, h / 2); c.lineTo(w, h / 2); c.stroke();
    // Continent outlines (no political borders, no fill)
    c.lineWidth = 1;
    c.strokeStyle = COAST;
    c.beginPath();
    for (const f of land) {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) for (const ring of poly) pathRing(c, ring, 0, 0, w, h);
    }
    c.stroke();
  }

  function draw2d(geo) {
    layout2d();
    if (!base2d || base2d.width !== Math.round(mapRect.w * mapRect.dpr)) buildBase2d();
    const c = ctx2d;
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.drawImage(base2d, mapRect.x, mapRect.y, mapRect.w, mapRect.h);

    // Salat bands (analytic raster layer)
    const bandsOn = salatOnMap();
    if (bandsOn) {
      c.drawImage(getSalatLayer(geo.sun), mapRect.x, mapRect.y, mapRect.w, mapRect.h);
    }

    // Night zone (the fill is omitted if the bands already encode it)
    if (nightShadeOn()) {
      c.beginPath(); pathRing(c, geo.night.ring, mapRect.x, mapRect.y, mapRect.w, mapRect.h);
      c.fillStyle = 'rgba(4,8,26,0.55)';
      c.fill();
    }
    if (sunZoneOn()) {
      c.beginPath(); pathRing(c, geo.night.ring.slice(0, geo.night.curveLen), mapRect.x, mapRect.y, mapRect.w, mapRect.h);
      c.strokeStyle = 'rgba(130,160,255,0.7)';
      c.lineWidth = 1.2;
      c.stroke();
    }

    // Area with the Moon above the horizon
    if (moonZoneOn()) {
      c.beginPath(); pathRing(c, geo.moonVis.ring, mapRect.x, mapRect.y, mapRect.w, mapRect.h);
      c.fillStyle = 'rgba(255,216,102,0.10)';
      c.fill();
      c.beginPath(); pathRing(c, geo.moonVis.ring.slice(0, geo.moonVis.curveLen), mapRect.x, mapRect.y, mapRect.w, mapRect.h);
      c.strokeStyle = '#ffd866';
      c.lineWidth = 1.5;
      c.setLineDash([7, 4]);
      c.stroke();
      c.setLineDash([]);
    }

    // Prayer labels, above the shading
    if (bandsOn) drawSalatLabels(c, geo.sun, lon2x, lat2y, 12);

    // Visibility-map points (above the shading)
    if (state.mapPoints.length) {
      const cw = state.mapRes / 360 * mapRect.w;
      c.globalAlpha = 0.8;
      for (const p of state.mapPoints) {
        c.fillStyle = CAT_COLORS[p.cat] || '#888';
        c.fillRect(lon2x(p.lng) - cw / 2, lat2y(p.lat) - cw / 2, cw * 0.9, cw * 0.9);
      }
      c.globalAlpha = 1;
    }

    // Markers: Sun, Moon and location
    drawMarker(c, geo.sun.lon, geo.sun.lat, '#ffd866', '☀️');
    drawMarker(c, geo.moon.lon, geo.moon.lat, '#e8edf5', '🌙');
    const px = lon2x(((state.loc.lon + 180) % 360 + 360) % 360 - 180), py = lat2y(state.loc.lat);
    c.fillStyle = '#ff5252';
    c.strokeStyle = '#fff';
    c.lineWidth = 1.5;
    c.beginPath(); c.arc(px, py, 5, 0, 2 * Math.PI); c.fill(); c.stroke();
    c.font = '11px system-ui, sans-serif';
    c.fillStyle = '#fff';
    const label = shortName(state.loc.name);
    c.strokeStyle = 'rgba(0,0,0,0.7)';
    c.lineWidth = 3;
    c.strokeText(label, px + 8, py - 6);
    c.fillText(label, px + 8, py - 6);
  }

  function drawMarker(c, lon, lat, color, emoji) {
    const x = lon2x(lon), y = lat2y(lat);
    c.fillStyle = color;
    c.strokeStyle = 'rgba(0,0,0,0.6)';
    c.lineWidth = 1;
    c.beginPath(); c.arc(x, y, 7, 0, 2 * Math.PI); c.fill(); c.stroke();
    c.font = '12px serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(emoji, x, y + 1);
    c.textAlign = 'start'; c.textBaseline = 'alphabetic';
  }

  canvas.addEventListener('click', (ev) => {
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    if (x < mapRect.x || x > mapRect.x + mapRect.w || y < mapRect.y || y > mapRect.y + mapRect.h) return;
    const lon = (x - mapRect.x) / mapRect.w * 360 - 180;
    const lat = 90 - (y - mapRect.y) / mapRect.h * 180;
    setLocation(lat, lon, null, true);
  });

  // ---------- Common render ----------
  let lastOverlay3d = null;
  function renderScene() {
    const geo = sceneGeometry();
    if (view === '3d' && G) {
      const on = salatOnMap();
      G.globeImageUrl(on ? getSalatTextureUrl(geo.sun) : null);
      const styleKey = [on, nightShadeOn(), sunZoneOn(), moonZoneOn()].join('|');
      if (styleKey !== lastOverlay3d) {
        lastOverlay3d = styleKey;
        // Re-apply the accessors so land/night/moon change style
        G.polygonCapColor(G.polygonCapColor());
        G.polygonStrokeColor(G.polygonStrokeColor());
      }
      const nightF = { type: 'Feature', properties: { kind: 'night' }, geometry: { type: 'Polygon', coordinates: [geo.night.ring] } };
      const moonF = { type: 'Feature', properties: { kind: 'moonvis' }, geometry: { type: 'Polygon', coordinates: [geo.moonVis.ring] } };
      G.polygonsData([...land, nightF, moonF]);
      G.pointRadius(state.mapRes * 0.55).pointsData(state.mapPoints);
      G.htmlElementsData([
        { type: 'pin', lat: state.loc.lat, lng: state.loc.lon, label: shortName(state.loc.name) },
        { type: 'sun', lat: geo.sun.lat, lng: geo.sun.lon },
        { type: 'moon', lat: geo.moon.lat, lng: geo.moon.lon }
      ]);
    } else {
      draw2d(geo);
    }
  }

  // ---------- Location ----------
  let locIsDefault = true; // no location has been set yet (neither user nor IP)
  function setLocation(lat, lon, name, reverseLookup) {
    locIsDefault = false;
    state.loc.lat = +lat; state.loc.lon = +lon;
    state.loc.tz = tzFor(+lat, +lon);
    if (name) state.loc.name = name;
    if (reverseLookup) {
      state.loc.name = `${(+lat).toFixed(4)}, ${(+lon).toFixed(4)}`;
      fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&accept-language=es`)
        .then(r => r.ok ? r.json() : null)
        .then(j => { if (j && j.display_name) { state.loc.name = j.display_name; renderLocation(); renderScene(); } })
        .catch(() => {});
    }
    renderLocation();
    if (view === '3d' && G) G.pointOfView({ lat: +lat, lng: +lon, altitude: 1.8 }, 900);
    updateAll();
  }

  function renderLocation() {
    $('loc-name').textContent = state.loc.name;
    $('loc-name-s').textContent = state.loc.name;
    $('loc-coords').textContent = `${state.loc.lat.toFixed(4)}°, ${state.loc.lon.toFixed(4)}° · ${state.loc.elev} m`;
    $('loc-tz').textContent = state.loc.tz;
    $('lat').value = state.loc.lat.toFixed(4);
    $('lon').value = state.loc.lon.toFixed(4);
    $('elev').value = state.loc.elev;
  }

  // Default location from the visitor's IP (silent: if the service fails or
  // the user already chose something, whatever is set stays).
  function geolocateByIp() {
    const apply = (lat, lon, name) => {
      if (!locIsDefault) return;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      state.loc.elev = 0;
      setLocation(lat, lon, name || null, !name);
    };
    const label = (j) => [j.city, j.country].filter(Boolean).join(', ');
    fetch('https://get.geojs.io/v1/ip/geo.json')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(j => apply(parseFloat(j.latitude), parseFloat(j.longitude), label(j)))
      .catch(() => fetch('https://ipwho.is/')
        .then(r => r.ok ? r.json() : null)
        .then(j => { if (j && j.success !== false) apply(+j.latitude, +j.longitude, label(j)); })
        .catch(() => {}));
  }

  ['lat', 'lon', 'elev'].forEach(id => $(id).addEventListener('change', () => {
    const lat = parseFloat($('lat').value), lon = parseFloat($('lon').value);
    state.loc.elev = parseFloat($('elev').value) || 0;
    if (Number.isFinite(lat) && Number.isFinite(lon)) setLocation(lat, lon, null, true);
  }));

  // ---------- Search (Nominatim/OSM), wired in both menus ----------
  let searchTimer = null;
  function wireSearch(input, box) {
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = input.value.trim();
      if (q.length < 3) { box.classList.add('hidden'); return; }
      searchTimer = setTimeout(() => doSearch(q, input, box), 450);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(searchTimer); doSearch(input.value.trim(), input, box); }
    });
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.searchbox')) document.querySelectorAll('.results').forEach(b => b.classList.add('hidden'));
  });

  function doSearch(q, input, box) {
    if (!q) return;
    fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=es&q=${encodeURIComponent(q)}`)
      .then(r => r.json())
      .then(list => {
        box.innerHTML = '';
        if (!list.length) { box.innerHTML = `<div>${tt('no_results')}</div>`; }
        list.forEach(item => {
          const div = document.createElement('div');
          div.textContent = item.display_name;
          div.addEventListener('click', () => {
            box.classList.add('hidden');
            input.value = '';
            setLocation(parseFloat(item.lat), parseFloat(item.lon), item.display_name, false);
          });
          box.appendChild(div);
        });
        box.classList.remove('hidden');
      })
      .catch(() => {});
  }
  wireSearch($('search'), $('search-results'));
  wireSearch($('search-s'), $('search-results-s'));

  // ---------- Date and time ----------
  function syncInputsFromWhen() {
    const p = partsInZone(state.when, state.loc.tz);
    $('gdate').value = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    $('gtime').value = `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
    $('htime').value = $('gtime').value;
    const wall = new Date(Date.UTC(p.y, p.m - 1, p.d, 12));
    const h = HJ.fromGregorian(wall, 'islamic-umalqura');
    $('hday').value = h.d; $('hmonth').value = h.m; $('hyear').value = h.y;
    $('hijri-warn').classList.add('hidden');
  }

  function whenFromGregorianInputs() {
    const [y, m, d] = $('gdate').value.split('-').map(Number);
    const [hh, mm] = ($('gtime').value || '12:00').split(':').map(Number);
    if (!y) return;
    state.when = zonedTimeToUtc(y, m, d, hh, mm, state.loc.tz);
  }

  function whenFromHijriInputs() {
    const hy = +$('hyear').value, hmth = +$('hmonth').value, hd = +$('hday').value;
    const greg = HJ.toGregorian(hy, hmth, hd, 'islamic-umalqura');
    const warn = $('hijri-warn');
    if (!greg) {
      warn.textContent = tt('hijri_bad');
      warn.classList.remove('hidden');
      return;
    }
    warn.classList.add('hidden');
    const p = partsInZone(greg, 'UTC');
    const [hh, mm] = ($('htime').value || '12:00').split(':').map(Number);
    state.when = zonedTimeToUtc(p.y, p.m, p.d, hh, mm, state.loc.tz);
  }

  ['gdate', 'gtime'].forEach(id => $(id).addEventListener('change', () => { whenFromGregorianInputs(); updateAll(); }));
  ['hday', 'hmonth', 'hyear', 'htime'].forEach(id => $(id).addEventListener('change', () => { whenFromHijriInputs(); updateAll(); }));

  HJ.MONTHS.forEach((name, i) => {
    const opt = document.createElement('option');
    opt.value = i + 1; opt.textContent = `${i + 1} · ${name}`;
    $('hmonth').appendChild(opt);
  });

  $('tab-greg').addEventListener('click', () => switchTab(true));
  $('tab-hijri').addEventListener('click', () => switchTab(false));
  function switchTab(greg) {
    $('tab-greg').classList.toggle('active', greg);
    $('tab-hijri').classList.toggle('active', !greg);
    $('panel-greg').classList.toggle('hidden', !greg);
    $('panel-hijri').classList.toggle('hidden', greg);
  }

  $('prev-day').addEventListener('click', () => { state.when = new Date(state.when.getTime() - 86400000); updateAll(); });
  $('next-day').addEventListener('click', () => { state.when = new Date(state.when.getTime() + 86400000); updateAll(); });
  $('now-btn').addEventListener('click', () => { state.when = new Date(); updateAll(); });

  // Mouse wheel over the date/time fields: shifts the time and animates the
  // Sun and the Moon. Recomputations are coalesced per frame (rAF).
  let updPending = false;
  function scheduleUpdate() {
    if (updPending) return;
    updPending = true;
    requestAnimationFrame(() => { updPending = false; updateAll(); });
  }
  function nudgeWhen(ms) { state.when = new Date(state.when.getTime() + ms); scheduleUpdate(); }
  function attachWheel(el, fn) {
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      fn(e.deltaY < 0 ? 1 : -1, e); // wheel up = forward
    }, { passive: false });
  }
  const timeStepMin = (e) => e.shiftKey ? 1 : e.ctrlKey ? 60 : 10;
  attachWheel($('gdate'), d => nudgeWhen(d * 86400000));
  attachWheel($('hday'), d => nudgeWhen(d * 86400000));
  attachWheel($('gtime'), (d, e) => nudgeWhen(d * timeStepMin(e) * 60000));
  attachWheel($('htime'), (d, e) => nudgeWhen(d * timeStepMin(e) * 60000));

  // Wheel over the 2D map or the 3D globe: shifts the time ±10 min.
  // Capturing and with stopPropagation to get ahead of the globe's
  // OrbitControls; alt+wheel lets the event through and keeps the camera zoom.
  function attachMapWheel(el) {
    el.addEventListener('wheel', (e) => {
      if (e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      nudgeWhen((e.deltaY < 0 ? 1 : -1) * 10 * 60000);
    }, { passive: false, capture: true });
  }
  attachMapWheel(canvas);
  attachMapWheel($('globe'));

  // ---------- Table rendering ----------
  function renderTable(el, rows) {
    el.innerHTML = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      if (r.section) {
        tr.className = 'section';
        tr.innerHTML = `<td colspan="2">${r.section}</td>`;
      } else {
        const [k, v] = r;
        tr.innerHTML = `<td>${k}</td><td>${v}</td>`;
      }
      el.appendChild(tr);
    }
  }
  const pill = (code, label) =>
    `<span class="pill" style="background:${CAT_COLORS[code] || '#888'};color:#06121f">${code}</span> ${label}`;

  // ---------- Salat periods ----------
  const SALAT_METHODS = {
    mwl: { fajrAngle: 18, ishaAngle: 17 },
    uaq: { fajrAngle: 18.5, ishaInterval: 90 },
    egy: { fajrAngle: 19.5, ishaAngle: 17.5 },
    isna: { fajrAngle: 15, ishaAngle: 15 },
    krc: { fajrAngle: 18, ishaAngle: 18 }
  };
  ['salat-method', 'salat-asr'].forEach(id => $(id).addEventListener('change', updateAll));
  $('salat-map').addEventListener('change', renderScene);

  function renderSalat(obs, wallNoonUtcMs) {
    const method = SALAT_METHODS[$('salat-method').value];
    const asrFactor = +$('salat-asr').value;
    const opts = {
      fajrAngle: method.fajrAngle, ishaAngle: method.ishaAngle,
      ishaInterval: method.ishaInterval, asrFactor
    };
    let pt = null, ptPrev = null;
    try {
      pt = H.prayerTimes(obs, wallNoonUtcMs, opts);
      // Previous evening's night: between 00:00 and fajr its night bands apply
      ptPrev = H.prayerTimes(obs, wallNoonUtcMs - 86400000, opts);
    } catch (e) { console.error(e); }
    const el = $('salat-table');
    el.innerHTML = '';
    if (!pt || !pt.dhuhr) return;

    const moonUp = (t) => {
      if (!t) return false;
      const eq = A.Equator(A.Body.Moon, t, obs, true, true);
      return A.Horizon(t, obs, eq.ra, eq.dec, 'normal').altitude > 0;
    };
    const F = (t) => t ? fmtLocal(t, false) : '—';
    const ishaDef = method.ishaInterval !== undefined
      ? tt('isha_interval', method.ishaInterval)
      : tt('isha_angle', method.ishaAngle);

    const rows = [
      { name: 'Fajr', a: pt.fajr, b: pt.sunrise, def: tt('d_fajr', method.fajrAngle) },
      { name: tt('sl_shuruq'), a: pt.sunrise, b: null, def: tt('d_shuruq'), instant: true },
      { name: 'Dhuhr', a: pt.dhuhr, b: pt.asr, def: tt('d_dhuhr') },
      { name: 'Asr', a: pt.asr, b: pt.sunset, def: tt('d_asr', asrFactor) },
      { name: 'Maghrib', a: pt.sunset, b: pt.isha, def: tt('d_maghrib'), aP: ptPrev && ptPrev.sunset, bP: ptPrev && ptPrev.isha },
      { name: 'Isha', a: pt.isha, b: pt.midnight, def: tt('d_isha', ishaDef), aP: ptPrev && ptPrev.isha, bP: ptPrev && ptPrev.midnight },
      { name: tt('sl_midnight'), a: pt.midnight, b: null, def: tt('d_midnight'), instant: true },
      { name: tt('sl_qiyam'), a: pt.lastThird, b: pt.fajrNext, def: tt('d_qiyam'), aP: ptPrev && ptPrev.lastThird, bP: ptPrev && ptPrev.fajrNext }
    ];
    const inRange = (a, b) => a && b && state.when >= a.date && state.when < b.date;
    for (const r of rows) {
      const tr = document.createElement('tr');
      const active = r.instant
        ? (r.a && Math.abs(state.when - r.a.date) < 5 * 60000)
        : (inRange(r.a, r.b) || inRange(r.aP, r.bP));
      if (active) tr.className = 'now';
      const interval = r.instant ? F(r.a) : `${F(r.a)} – ${F(r.b)}`;
      tr.innerHTML = `<td>${r.name}${moonUp(r.a) ? ' 🌙' : ''}</td>` +
        `<td>${interval}<br><span class="small">${r.def}</span></td>`;
      el.appendChild(tr);
    }
    if (!pt.fajr || !pt.isha) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="2"><span class="warn">${tt('white_nights')}</span></td>`;
      el.appendChild(tr);
    }
  }

  // ---------- Simple menu: state at the instant ----------
  const compass = (az) => tt('dirs')[Math.round(az / 45) % 8];
  function renderSimpleStatus() {
    const t = A.MakeTime(state.when);
    const sun = H.subPoint(A.Body.Sun, t);
    const rp = salatRowParams(state.loc.lat, sun, salatOpts());
    let bandTxt;
    if (rp.polarDay) {
      bandTxt = tt('bs_midsun');
    } else {
      const band = salatBandAt(rp, state.loc.lon, sun.lon);
      bandTxt = band ? tt('bs_' + band) : tt('bs_morning');
    }
    const obs = new A.Observer(state.loc.lat, state.loc.lon, state.loc.elev);
    const eqM = A.Equator(A.Body.Moon, t, obs, true, true);
    const m = A.Horizon(t, obs, eqM.ra, eqM.dec, 'normal');
    const eqS = A.Equator(A.Body.Sun, t, obs, true, true);
    const s = A.Horizon(t, obs, eqS.ra, eqS.dec, 'normal');
    let moonHtml;
    if (m.altitude > 0) {
      moonHtml = `${tt('st_up', compass(m.azimuth))} ` +
        `<span class="small">${tt('st_pos', m.azimuth.toFixed(0), m.altitude.toFixed(0))}</span>`;
      if (s.altitude > 0) moonHtml += `<br><span class="small">${tt('st_day')}</span>`;
    } else {
      moonHtml = tt('st_down');
    }
    $('simple-status').innerHTML =
      `🕐 <b>${fmtLocal(state.when, false)}</b> <span class="small">${tt('st_local')} (${state.loc.tz})</span><br>` +
      `🕌 ${tt('st_band')}: <b>${bandTxt}</b><br>${moonHtml}`;
  }

  // Simple/advanced switching
  function setMode(m) {
    uiMode = m;
    localStorage.setItem('hilal-menu', m);
    $('mode-simple').classList.toggle('active', m === 'simple');
    $('mode-adv').classList.toggle('active', m === 'adv');
    $('simple-panel').classList.toggle('hidden', m !== 'simple');
    $('adv-panel').classList.toggle('hidden', m === 'simple');
    renderScene(); // the set of visible bands depends on the menu
  }
  $('mode-simple').addEventListener('click', () => setMode('simple'));
  $('mode-adv').addEventListener('click', () => setMode('adv'));
  ['chk-sun', 'chk-moon', ...PRAYER_BANDS.map(b => 'chk-' + b)]
    .forEach(id => $(id).addEventListener('change', renderScene));

  // ---------- Language ----------
  $('lang-sel').addEventListener('change', () => {
    I18N.set($('lang-sel').value);
    updateAll();    // regenerates all dynamic texts
  });

  // ---------- Main computation ----------
  function updateAll() {
    syncInputsFromWhen();
    renderLocation();
    renderScene();

    const obs = new A.Observer(state.loc.lat, state.loc.lon, state.loc.elev);
    const p = partsInZone(state.when, state.loc.tz);
    const wallNoonUtcMs = zonedTimeToUtc(p.y, p.m, p.d, 12, 0, state.loc.tz).getTime();

    // --- Calendar equivalences ---
    const wallNoon = new Date(Date.UTC(p.y, p.m - 1, p.d, 12));
    const umq = HJ.fromGregorian(wallNoon, 'islamic-umalqura');
    const tab = HJ.fromGregorian(wallNoon, 'islamic-civil');
    const weekday = new Intl.DateTimeFormat(I18N.locale(), { timeZone: state.loc.tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(state.when);

    // --- Evening analysis ---
    let ev = null;
    try { ev = H.evening(obs, wallNoonUtcMs); } catch (e) { console.error(e); }

    let equivHtml =
      `<b>${weekday}</b>, ${$('gtime').value} (${state.loc.tz}) · ${fmtUTC(state.when)}<br>` +
      `Umm al-Qura: <b>${HJ.format(umq)}</b> · ${tt('equiv_tab')} ${HJ.format(tab)}`;
    if (ev && !ev.polar && ev.sunset && state.when.getTime() >= ev.sunset.date.getTime()) {
      const next = HJ.fromGregorian(new Date(wallNoon.getTime() + 86400000), 'islamic-umalqura');
      equivHtml += `<br><span class="small">${tt('equiv_next')} ${HJ.format(next)}</span>`;
    }
    $('date-equiv').innerHTML = equivHtml;

    // --- Verdict and evening table ---
    const vEl = $('verdict');
    if (!ev || ev.polar) {
      vEl.className = 'verdict cat-P';
      vEl.textContent = tt('verdict_polar');
      renderTable($('evening-table'), []);
      renderTable($('criteria-table'), []);
    } else {
      vEl.className = 'verdict cat-' + ev.verdict.code;
      vEl.innerHTML = `${pill(ev.verdict.code, '')} ${tt(ev.verdict.key)}`;
      const ageSunsetH = ev.conjunctionPrev ? (ev.sunset.ut - ev.conjunctionPrev.ut) * 24 : null;
      if (ageSunsetH !== null && ageSunsetH > 72) {
        vEl.innerHTML += `<br><span class="small">${tt('note_old', (ageSunsetH / 24).toFixed(1))}</span>`;
      }

      renderTable($('evening-table'), [
        [tt('ev_conj_prev'), `${fmtLocal(ev.conjunctionPrev)}<br><span class="small">${fmtUTC(ev.conjunctionPrev)}</span>`],
        [tt('ev_age'), hm(ev.conjunctionPrev ? (ev.sunset.ut - ev.conjunctionPrev.ut) * 24 : null)],
        [tt('ev_sunset'), fmtLocal(ev.sunset, false)],
        [tt('ev_moonset'), ev.moonset ? fmtLocal(ev.moonset, false) : tt('ev_noset')],
        [tt('ev_lag'), ev.lagMin === null ? '—' : Math.round(ev.lagMin) + ' min'],
        [tt('ev_best'), fmtLocal(ev.bestTime, false) + ' <span class="small">local</span>'],
        [tt('ev_alt_tb'), deg(ev.crit.altMoon)],
        [tt('ev_azm_tb'), deg(ev.crit.azMoon, 1)],
        [tt('ev_azs_tb'), deg(ev.crit.azSun, 1)],
        [tt('ev_illum'), n(ev.crit.illumFrac * 100, 2) + ' %'],
        [tt('ev_conj_next'), `${fmtLocal(ev.conjunctionNext)}<br><span class="small">${fmtUTC(ev.conjunctionNext)}</span>`]
      ]);

      renderTable($('criteria-table'), [
        { section: tt('c_yallop') },
        [tt('c_q'), `<b>${n(ev.crit.q, 3)}</b>`],
        [tt('c_cat'), pill(ev.yallop.code, tt('ycat_' + ev.yallop.code))],
        [tt('c_arcv_geo'), deg(ev.crit.arcvGeo)],
        [tt('c_arcl_geo'), deg(ev.crit.arclGeo)],
        [tt('c_w1'), n(ev.crit.wYallop, 3) + '′'],
        { section: tt('c_odeh') },
        [tt('c_v'), `<b>${n(ev.crit.V, 2)}</b>`],
        [tt('c_zone'), pill(ev.odeh.code, tt('ocat_' + ev.odeh.code))],
        [tt('c_arcv_topo'), deg(ev.crit.arcvTopo)],
        [tt('c_arcl_topo'), deg(ev.crit.arclTopo)],
        [tt('c_w2'), n(ev.crit.wTopo, 3) + '′'],
        { section: tt('c_other') },
        [tt('c_daz'), deg(ev.crit.dazAbs)],
        [tt('c_sd'), n(ev.crit.sdTopo, 2) + '′'],
        [tt('c_par'), deg(ev.crit.parallaxDeg, 3)],
        [tt('c_age'), hm(ev.crit.ageHours)],
        [tt('c_danjon'), ev.crit.belowDanjon ? tt('c_danjon_no') : tt('c_danjon_ok')]
      ]);
    }

    // --- Selected instant ---
    try {
      const t = A.MakeTime(state.when);
      const inst = H.instantData(obs, t);
      const nextRise = A.SearchRiseSet(A.Body.Moon, obs, +1, t, 2);
      const nextSet = A.SearchRiseSet(A.Body.Moon, obs, -1, t, 2);
      const waxing = inst.phaseLon < 180;
      renderTable($('instant-table'), [
        [tt('i_above'), inst.moon.altitude > 0 ? tt('i_yes') : tt('i_no')],
        [tt('i_alt'), deg(inst.moon.altitude)],
        [tt('i_az'), deg(inst.moon.azimuth, 1)],
        [tt('i_alts'), deg(inst.sun.altitude)],
        [tt('i_azs'), deg(inst.sun.azimuth, 1)],
        [tt('i_phase'), tt(waxing ? 'i_waxing' : 'i_waning') + ` · ${n(inst.illumFrac * 100, 1)} %`],
        [tt('i_phase_angle'), deg(inst.phaseAngle, 1)],
        [tt('i_elong'), `${deg(inst.elongGeo, 2)} / ${deg(inst.elongTopo, 2)}`],
        [tt('i_age'), hm(inst.ageHours)],
        [tt('i_dist_topo'), Math.round(inst.moon.distTopoKm).toLocaleString(I18N.locale()) + ' km'],
        [tt('i_dist_geo'), Math.round(inst.moon.distGeoKm).toLocaleString(I18N.locale()) + ' km'],
        [tt('i_diam'), n(inst.moon.diameterArcmin, 2) + '′'],
        [tt('i_mag'), n(inst.moon.mag, 1)],
        [tt('i_radec'), `${n(inst.moon.ra, 3)} h / ${deg(inst.moon.dec, 2)}`],
        [tt('i_ecl'), inst.moon.eclLat === null ? '—' : deg(inst.moon.eclLat, 2)],
        [tt('i_nextrise'), nextRise ? fmtLocal(nextRise) : '—'],
        [tt('i_nextset'), nextSet ? fmtLocal(nextSet) : '—']
      ]);
    } catch (e) { console.error(e); }

    renderSalat(obs, wallNoonUtcMs);
    renderLunations();
    renderSimpleStatus();
  }

  // ---------- Upcoming lunations ----------
  let lunationsCache = null;
  function renderLunations() {
    if (!lunationsCache) lunationsCache = H.nextNewMoons(new Date(Date.now() - 40 * 86400000), 14);
    const el = $('lunations-table');
    el.innerHTML = '';
    const head = document.createElement('tr');
    head.className = 'section';
    head.innerHTML = tt('lun_head');
    el.appendChild(head);
    for (const nm of lunationsCache) {
      const mid = new Date(nm.date.getTime() + 14 * 86400000);
      const h = HJ.fromGregorian(new Date(Date.UTC(mid.getUTCFullYear(), mid.getUTCMonth(), mid.getUTCDate(), 12)), 'islamic-umalqura');
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.innerHTML = `<b>${HJ.MONTHS[h.m - 1]} ${h.y}</b>`;
      const td2 = document.createElement('td');
      const btn = document.createElement('button');
      btn.textContent = tt('btn_view');
      btn.addEventListener('click', () => {
        const pz = partsInZone(nm.date, state.loc.tz);
        state.when = zonedTimeToUtc(pz.y, pz.m, pz.d, 17, 0, state.loc.tz);
        updateAll();
      });
      td2.append(fmtUTC(nm) + ' ');
      td2.appendChild(btn);
      tr.append(td1, td2);
      el.appendChild(tr);
    }
  }

  // ---------- Global visibility map ----------
  let worker = null;
  $('map-btn').addEventListener('click', () => {
    if (worker) { worker.terminate(); worker = null; }
    const res = +$('map-res').value;
    const p = partsInZone(state.when, state.loc.tz);
    const t = A.MakeTime(new Date(Date.UTC(p.y, p.m - 1, p.d, 12)));
    const around = H.newMoonsAround(t);
    const prev2 = around.prev ? H.newMoonsAround(around.prev.AddDays(-1)).prev : null;
    const nmUts = [prev2, around.prev, around.next].filter(Boolean).map(x => x.ut);

    $('map-progress').classList.remove('hidden');
    $('map-bar').style.width = '0%';
    $('map-btn').disabled = true;

    worker = new Worker('js/mapworker.js');
    worker.onmessage = (ev2) => {
      if (ev2.data.type === 'progress') {
        $('map-bar').style.width = (100 * ev2.data.done / ev2.data.total).toFixed(1) + '%';
      } else if (ev2.data.type === 'done') {
        state.mapPoints = ev2.data.points;
        state.mapRes = res;
        renderScene();
        $('map-progress').classList.add('hidden');
        $('map-btn').disabled = false;
        worker.terminate(); worker = null;
      }
    };
    worker.onerror = (e) => {
      console.error('Error en el worker del mapa:', e.message);
      $('map-progress').classList.add('hidden');
      $('map-btn').disabled = false;
    };
    worker.postMessage({ y: p.y, m: p.m, d: p.d, latStep: res, lonStep: res, nmUts });
  });
  $('map-clear').addEventListener('click', () => { state.mapPoints = []; renderScene(); });

  // ---------- Startup ----------
  I18N.apply();
  $('lang-sel').value = I18N.lang;
  renderLocation();
  setMode(uiMode);
  setView(view);
  updateAll();
  geolocateByIp();
})();
