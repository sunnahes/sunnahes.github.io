/*
 * mapworker.js — Calcula en segundo plano el mapa global de visibilidad del
 * hilal (categorías de Yallop) para la tarde local de una fecha dada.
 */
importScripts('../vendor/astronomy.browser.min.js', 'hilal.js');

self.onmessage = function (ev) {
  const { y, m, d, latStep, lonStep, nmUts } = ev.data;
  const points = [];
  const lats = [];
  for (let lat = -64; lat <= 64; lat += latStep) lats.push(lat);
  const lons = [];
  for (let lon = -180; lon < 180; lon += lonStep) lons.push(lon);

  const total = lats.length * lons.length;
  let done = 0;
  const baseUtcNoon = Date.UTC(y, m - 1, d, 12, 0, 0);

  for (const lat of lats) {
    for (const lon of lons) {
      // Mediodía local medio: 12h UTC menos 4 min por grado de longitud
      const localNoonMs = baseUtcNoon - lon * 240000;
      let res;
      try {
        res = Hilal.mapPoint(lat, lon, localNoonMs, nmUts);
      } catch (e) {
        res = { cat: 'P', q: null };
      }
      points.push({ lat, lng: lon, cat: res.cat, q: res.q });
      done++;
    }
    self.postMessage({ type: 'progress', done, total });
  }
  self.postMessage({ type: 'done', points });
};
