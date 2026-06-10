/*
 * Sanity test of the scientific core.
 * Validates against published facts:
 *  - Annular solar eclipse of 2026-02-17: new moon at 12:01 UTC (NASA).
 *  - Total solar eclipse of 2026-08-12: new moon at 17:46 UTC (NASA).
 *  - Start of Ramadan 1444 (Umm al-Qura): 1 Ramadan 1444 = 2023-03-23.
 *  - March 2023 conjunction: 2023-03-21 17:23 UTC.
 */
const A = require('../vendor/astronomy.browser.min.js');
globalThis.Astronomy = A;
require('../js/hilal.js');
require('../js/hijri.js');
const H = globalThis.Hilal;
const HJ = globalThis.Hijri;

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// 1. Conjunctions = instants of known solar eclipses
const nmFeb = A.SearchMoonPhase(0, A.MakeTime(new Date(Date.UTC(2026, 1, 1))), 30);
check('Luna nueva feb 2026 ≈ 2026-02-17 12:01 UTC (eclipse anular)',
  Math.abs(nmFeb.date.getTime() - Date.UTC(2026, 1, 17, 12, 1)) < 5 * 60000,
  nmFeb.date.toISOString());

const nmAug = A.SearchMoonPhase(0, A.MakeTime(new Date(Date.UTC(2026, 7, 1))), 30);
check('Luna nueva ago 2026 ≈ 2026-08-12 17:37 UTC (día del eclipse total)',
  Math.abs(nmAug.date.getTime() - Date.UTC(2026, 7, 12, 17, 37)) < 5 * 60000,
  nmAug.date.toISOString());

const nmMar23 = A.SearchMoonPhase(0, A.MakeTime(new Date(Date.UTC(2023, 2, 1))), 30);
check('Luna nueva mar 2023 ≈ 2023-03-21 17:23 UTC',
  Math.abs(nmMar23.date.getTime() - Date.UTC(2023, 2, 21, 17, 23)) < 5 * 60000,
  nmMar23.date.toISOString());

// 2. Hilal in Mecca, evenings of 21, 22 and 23 March 2023
//    (Mecca local noon = 09:00 UTC)
const mecca = new A.Observer(21.4225, 39.8262, 300);
for (const [day, expect] of [[21, 'imposible'], [22, 'marginal'], [23, 'facil']]) {
  const ev = H.evening(mecca, Date.UTC(2023, 2, day, 9, 0));
  const desc = `q=${ev.crit.q.toFixed(3)} cat=${ev.yallop.code} V=${ev.crit.V.toFixed(2)} ` +
    `lag=${Math.round(ev.lagMin)}min alt=${ev.crit.altMoon.toFixed(1)}° ARCL=${ev.crit.arclGeo.toFixed(1)}°`;
  if (expect === 'imposible') {
    check(`Meca 2023-03-${day}: no visible (conjunción esa tarde)`, ['E', 'F', 'S'].includes(ev.verdict.code) || ev.crit.q < -0.232, desc);
  } else if (expect === 'marginal') {
    check(`Meca 2023-03-${day}: marginal/visible (B-D)`, ev.crit.q > -0.232 && ev.crit.q < 0.5, desc);
  } else {
    check(`Meca 2023-03-${day}: fácilmente visible (A)`, ev.yallop.code === 'A', desc);
  }
}

// 3. Consistency of Mecca's sunset on 2023-03-22 (≈ 15:3x UTC)
const ev22 = H.evening(mecca, Date.UTC(2023, 2, 22, 9, 0));
check('Puesta de sol Meca 2023-03-22 entre 15:25 y 15:45 UTC',
  ev22.sunset.date.getUTCHours() === 15 && ev22.sunset.date.getUTCMinutes() >= 25 && ev22.sunset.date.getUTCMinutes() <= 45,
  ev22.sunset.date.toISOString());

// 4. Calendar: 1 Ramadan 1444 (Umm al-Qura) = 2023-03-23
const g = HJ.toGregorian(1444, 9, 1, 'islamic-umalqura');
check('1 Ramadán 1444 AH (Umm al-Qura) = 2023-03-23',
  g && g.getUTCFullYear() === 2023 && g.getUTCMonth() === 2 && g.getUTCDate() === 23,
  g ? g.toISOString().slice(0, 10) : 'null');

// Hijri round trip for 60 days around today
let rt = true;
for (let i = -30; i <= 30; i++) {
  const dt = new Date(Date.now() + i * 86400000);
  const noon = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), 12));
  const h = HJ.fromGregorian(noon, 'islamic-umalqura');
  const back = HJ.toGregorian(h.y, h.m, h.d, 'islamic-umalqura');
  if (!back || back.toISOString().slice(0, 10) !== noon.toISOString().slice(0, 10)) { rt = false; break; }
}
check('Conversión hijri ⇄ gregoriano: ida y vuelta (±30 días)', rt);

// 5. mapPoint works and gives a category consistent with evening()
const mp = H.mapPoint(21.4225, 39.8262, Date.UTC(2023, 2, 23, 9, 0),
  [nmMar23.ut]);
check('mapPoint Meca 2023-03-23 = categoría A', mp.cat === 'A', JSON.stringify(mp));

// 6. instantData does not throw and gives reasonable data
const inst = H.instantData(mecca, A.MakeTime(new Date(Date.UTC(2023, 2, 23, 15, 45))));
check('instantData: distancia lunar 356k-407k km',
  inst.moon.distGeoKm > 356000 && inst.moon.distGeoKm < 407000,
  Math.round(inst.moon.distGeoKm) + ' km');
check('instantData: iluminación 0-10% (luna de ~2 días)',
  inst.illumFrac > 0 && inst.illumFrac < 0.10,
  (inst.illumFrac * 100).toFixed(2) + ' %');

// 7. Boundary of the "Moon above the horizon" zone (90° cap around the
//    sublunar point): the Moon's topocentric altitude there must be ≈ 0
//    (±1.2° due to parallax and because the cap uses geocentric geometry).
{
  const DEG = Math.PI / 180;
  const t = A.MakeTime(new Date(Date.UTC(2026, 5, 16, 18, 0)));
  const sub = H.subPoint(A.Body.Moon, t);
  let maxAbs = 0;
  for (const lonOff of [-120, -60, 0.5, 60, 120]) {
    const lon = ((sub.lon + lonOff + 540) % 360) - 180;
    const phi = -Math.atan(Math.cos((lon - sub.lon) * DEG) / Math.tan(sub.lat * DEG)) / DEG;
    const obs = new A.Observer(phi, lon, 0);
    const eq = A.Equator(A.Body.Moon, t, obs, true, true);
    const hor = A.Horizon(t, obs, eq.ra, eq.dec); // no refraction
    maxAbs = Math.max(maxAbs, Math.abs(hor.altitude));
  }
  check('Frontera del casquete lunar: |altitud de la Luna| < 1.2°', maxAbs < 1.2,
    'desviación máx = ' + maxAbs.toFixed(3) + '°');
}

// 8. Salat times (Mecca, 2026-06-10, Umm al-Qura method)
{
  const DEG = Math.PI / 180;
  const pt = H.prayerTimes(mecca, Date.UTC(2026, 5, 10, 9, 0),
    { fajrAngle: 18.5, ishaInterval: 90, asrFactor: 1 });
  const order = pt.fajr && pt.sunrise && pt.dhuhr && pt.asr && pt.sunset && pt.isha &&
    pt.fajr.ut < pt.sunrise.ut && pt.sunrise.ut < pt.dhuhr.ut && pt.dhuhr.ut < pt.asr.ut &&
    pt.asr.ut < pt.sunset.ut && pt.sunset.ut < pt.isha.ut && pt.isha.ut < pt.fajrNext.ut;
  check('Salat: orden fajr < orto < dhuhr < asr < ocaso < isha < alba siguiente', !!order,
    order ? [pt.fajr, pt.sunrise, pt.dhuhr, pt.asr, pt.sunset, pt.isha].map(t => t.date.toISOString().slice(11, 16)).join(' ') + ' UTC' : 'faltan tiempos');

  // Solar altitude at fajr = −18.5° (no refraction)
  const eqF = A.Equator(A.Body.Sun, pt.fajr, mecca, true, true);
  const altF = A.Horizon(pt.fajr, mecca, eqF.ra, eqF.dec).altitude;
  check('Salat: altitud del Sol en fajr ≈ −18,5°', Math.abs(altF + 18.5) < 0.05, altF.toFixed(3) + '°');

  // Isha = maghrib + exactly 90 min (Umm al-Qura rule)
  check('Salat: isha = maghrib + 90 min', Math.abs((pt.isha.ut - pt.sunset.ut) * 1440 - 90) < 0.01);

  // Asr shadow condition: cot(alt) = 1 + tan|φ−δ|
  const eqA = A.Equator(A.Body.Sun, pt.asr, mecca, true, true);
  const altA = A.Horizon(pt.asr, mecca, eqA.ra, eqA.dec).altitude;
  const eqN = A.Equator(A.Body.Sun, pt.dhuhr, mecca, true, true);
  const expected = Math.atan(1 / (1 + Math.tan(Math.abs(21.4225 - eqN.dec) * DEG))) / DEG;
  check('Salat: altitud del Sol en asr cumple la condición de sombra', Math.abs(altA - expected) < 0.05,
    `alt=${altA.toFixed(3)}° esperado=${expected.toFixed(3)}°`);

  // Islamic midnight = midpoint sunset→dawn
  const mid = (pt.sunset.ut + pt.fajrNext.ut) / 2;
  check('Salat: medianoche islámica en el punto medio de la noche', Math.abs(pt.midnight.ut - mid) < 1e-6);
}

console.log(failures ? `\n${failures} comprobaciones fallidas` : '\nTodas las comprobaciones superadas');
process.exit(failures ? 1 : 0);
