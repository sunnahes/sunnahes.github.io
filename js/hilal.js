/*
 * hilal.js — Núcleo científico de cálculo de visibilidad del hilal.
 *
 * Efemérides: Astronomy Engine (Don Cross), basada en VSOP87 (Sol/planetas)
 * y una serie ELP2000-82 truncada para la Luna; precisión ~1 minuto de arco.
 *
 * Criterios implementados:
 *  - Yallop, B.D. (1997) "A Method for Predicting the First Sighting of the
 *    New Crescent Moon", NAO Technical Note No. 69, HM Nautical Almanac Office.
 *    q = (ARCV - (11.8371 - 6.3226·W' + 0.7319·W'² - 0.1018·W'³)) / 10
 *    con ARCV geocéntrico y W' = anchura topocéntrica del creciente (arcmin),
 *    evaluado en el "mejor momento" Tb = Tpuesta_sol + 4/9 · LAG.
 *  - Odeh, M.Sh. (2006) "New Criterion for Lunar Crescent Visibility",
 *    Experimental Astronomy 18, 39-64 (criterio de ICOP).
 *    V = ARCV - (7.1651 - 6.3226·W + 0.7319·W² - 0.1018·W³)
 *    con magnitudes topocéntricas.
 *  - Límite de Danjon (~7° de elongación): por debajo no existe creciente
 *    físicamente observable (Danjon 1932/1936).
 */
(function (global) {
  'use strict';

  const A = global.Astronomy;
  const DEG = Math.PI / 180;
  const MOON_RADIUS_KM = 1737.4;
  const EARTH_EQ_RADIUS_KM = 6378.137;
  const SUN_PARALLAX_DEG = 8.794 / 3600; // paralaje solar media
  const DANJON_LIMIT_DEG = 7.0;

  function norm180(x) {
    x = x % 360;
    if (x > 180) x -= 360;
    if (x < -180) x += 360;
    return x;
  }

  // Separación angular (grados) entre dos posiciones (AR en horas, Dec en grados)
  function sepDeg(ra1h, dec1, ra2h, dec2) {
    const a1 = ra1h * 15 * DEG, d1 = dec1 * DEG;
    const a2 = ra2h * 15 * DEG, d2 = dec2 * DEG;
    const c = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(a1 - a2);
    return Math.acos(Math.min(1, Math.max(-1, c))) / DEG;
  }

  // Última luna nueva (conjunción geocéntrica) anterior o igual a `time`,
  // y la primera posterior.
  function newMoonsAround(time) {
    let t = A.SearchMoonPhase(0, time.AddDays(-35), 36);
    let prev = null, next = null;
    while (t) {
      if (t.ut <= time.ut) { prev = t; t = A.SearchMoonPhase(0, t.AddDays(1), 35); }
      else { next = t; break; }
    }
    return { prev, next };
  }

  // Punto subsolar / sublunar geocéntrico (lat/lon sobre la superficie terrestre)
  function subPoint(body, time) {
    const vecJ = A.GeoVector(body, time, true);
    const vecD = A.RotateVector(A.Rotation_EQJ_EQD(time), vecJ);
    const eq = A.EquatorFromVector(vecD);
    const gast = A.SiderealTime(time); // horas
    return { lat: eq.dec, lon: norm180((eq.ra - gast) * 15) };
  }

  // Estado completo de la Luna y el Sol en un instante, para un observador.
  function instantData(observer, time) {
    const eqSun = A.Equator(A.Body.Sun, time, observer, true, true);   // topocéntrico
    const eqMoon = A.Equator(A.Body.Moon, time, observer, true, true); // topocéntrico
    const hSun = A.Horizon(time, observer, eqSun.ra, eqSun.dec, 'normal');
    const hMoon = A.Horizon(time, observer, eqMoon.ra, eqMoon.dec, 'normal');
    const hMoonAirless = A.Horizon(time, observer, eqMoon.ra, eqMoon.dec);

    const distTopoKm = eqMoon.dist * A.KM_PER_AU;
    const geoVec = A.GeoVector(A.Body.Moon, time, true);
    const distGeoKm = Math.hypot(geoVec.x, geoVec.y, geoVec.z) * A.KM_PER_AU;

    const sdArcmin = (Math.asin(MOON_RADIUS_KM / distTopoKm) / DEG) * 60;       // semidiámetro topocéntrico
    const parallaxDeg = Math.asin(EARTH_EQ_RADIUS_KM / distGeoKm) / DEG;        // paralaje horizontal ecuatorial

    const illum = A.Illumination(A.Body.Moon, time);
    const phaseAngle = illum.phase_angle;
    const illumFrac = (1 + Math.cos(phaseAngle * DEG)) / 2;

    const elongGeo = A.Elongation(A.Body.Moon, time).elongation;
    const elongTopo = sepDeg(eqMoon.ra, eqMoon.dec, eqSun.ra, eqSun.dec);
    const phaseLon = A.MoonPhase(time); // diferencia de longitud eclíptica Luna-Sol, 0..360

    const ecl = A.EclipticGeoMoon ? A.EclipticGeoMoon(time) : null;
    const nm = newMoonsAround(time);

    return {
      time,
      moon: {
        altitude: hMoon.altitude,
        altitudeAirless: hMoonAirless.altitude,
        azimuth: hMoon.azimuth,
        ra: eqMoon.ra,
        dec: eqMoon.dec,
        distTopoKm,
        distGeoKm,
        sdArcmin,
        diameterArcmin: 2 * sdArcmin,
        parallaxDeg,
        eclLat: ecl ? ecl.lat : null,
        eclLon: ecl ? ecl.lon : null,
        mag: illum.mag
      },
      sun: { altitude: hSun.altitude, azimuth: hSun.azimuth, ra: eqSun.ra, dec: eqSun.dec },
      phaseAngle,
      illumFrac,
      elongGeo,
      elongTopo,
      phaseLon,
      newMoonPrev: nm.prev,
      newMoonNext: nm.next,
      ageHours: nm.prev ? (time.ut - nm.prev.ut) * 24 : null
    };
  }

  // Parámetros de los criterios de visibilidad en un instante dado.
  function criteria(observer, time, conjunction) {
    const eqSun = A.Equator(A.Body.Sun, time, observer, true, true);
    const eqMoon = A.Equator(A.Body.Moon, time, observer, true, true);
    const hSun = A.Horizon(time, observer, eqSun.ra, eqSun.dec);   // sin refracción
    const hMoon = A.Horizon(time, observer, eqMoon.ra, eqMoon.dec); // sin refracción

    const distTopoKm = eqMoon.dist * A.KM_PER_AU;
    const geoVec = A.GeoVector(A.Body.Moon, time, true);
    const distGeoKm = Math.hypot(geoVec.x, geoVec.y, geoVec.z) * A.KM_PER_AU;
    const sdTopo = (Math.asin(MOON_RADIUS_KM / distTopoKm) / DEG) * 60; // arcmin
    const parallaxDeg = Math.asin(EARTH_EQ_RADIUS_KM / distGeoKm) / DEG;

    const arclTopo = sepDeg(eqMoon.ra, eqMoon.dec, eqSun.ra, eqSun.dec);
    const arclGeo = A.Elongation(A.Body.Moon, time).elongation;
    const arcvTopo = hMoon.altitude - hSun.altitude;
    // ARCV geocéntrico: se corrige la altitud topocéntrica por paralaje
    const arcvGeo = arcvTopo + parallaxDeg * Math.cos(hMoon.altitude * DEG)
                             - SUN_PARALLAX_DEG * Math.cos(hSun.altitude * DEG);
    const daz = norm180(hSun.azimuth - hMoon.azimuth);

    const wTopo = sdTopo * (1 - Math.cos(arclTopo * DEG));   // anchura topocéntrica (Odeh)
    const wYallop = sdTopo * (1 - Math.cos(arclGeo * DEG));  // anchura según Yallop (SD' topo, ARCL geo)

    const q = (arcvGeo - (11.8371 - 6.3226 * wYallop + 0.7319 * wYallop ** 2 - 0.1018 * wYallop ** 3)) / 10;
    const V = arcvTopo - (7.1651 - 6.3226 * wTopo + 0.7319 * wTopo ** 2 - 0.1018 * wTopo ** 3);

    const illum = A.Illumination(A.Body.Moon, time);
    const illumFrac = (1 + Math.cos(illum.phase_angle * DEG)) / 2;

    return {
      time,
      arclTopo, arclGeo, arcvTopo, arcvGeo,
      daz, dazAbs: Math.abs(daz),
      sdTopo, wTopo, wYallop,
      q, V,
      illumFrac,
      parallaxDeg,
      altMoon: hMoon.altitude, azMoon: hMoon.azimuth,
      altSun: hSun.altitude, azSun: hSun.azimuth,
      ageHours: conjunction ? (time.ut - conjunction.ut) * 24 : null,
      belowDanjon: arclGeo < DANJON_LIMIT_DEG
    };
  }

  function yallopCategory(q) {
    if (q > 0.216) return { code: 'A', label: 'Fácilmente visible a simple vista' };
    if (q > -0.014) return { code: 'B', label: 'Visible a simple vista en condiciones atmosféricas perfectas' };
    if (q > -0.160) return { code: 'C', label: 'Puede requerir ayuda óptica para localizar el creciente' };
    if (q > -0.232) return { code: 'D', label: 'Solo visible con ayuda óptica (prismáticos/telescopio)' };
    if (q > -0.293) return { code: 'E', label: 'No visible ni con telescopio (ARCL ≤ ~8,5°)' };
    return { code: 'F', label: 'No visible: por debajo del límite de Danjon (ARCL ≤ ~8°)' };
  }

  function odehZone(V) {
    if (V >= 5.65) return { code: 'A', label: 'Creciente visible a simple vista' };
    if (V >= 2.00) return { code: 'B', label: 'Visible con ayuda óptica; posible a simple vista' };
    if (V >= -0.96) return { code: 'C', label: 'Visible solo con ayuda óptica' };
    return { code: 'D', label: 'Creciente no visible' };
  }

  /*
   * Análisis del hilal para la tarde local cuyo mediodía (en UTC, ms) se indica.
   * Devuelve puesta de sol, puesta de luna, LAG, mejor momento (Yallop),
   * conjunción previa/siguiente y los criterios evaluados en el mejor momento.
   */
  function evening(observer, localNoonUtcMs) {
    const t0 = A.MakeTime(new Date(localNoonUtcMs));
    const sunset = A.SearchRiseSet(A.Body.Sun, observer, -1, t0, 1.2);
    if (!sunset) return { polar: true };

    // Buscamos la puesta de luna desde unas horas antes de la puesta de sol
    // para detectar LAG negativo (la Luna se pone antes que el Sol).
    const moonset = A.SearchRiseSet(A.Body.Moon, observer, -1, sunset.AddDays(-0.3), 1.5);
    const moonrise = A.SearchRiseSet(A.Body.Moon, observer, +1, t0, 1.5);
    const lagMin = moonset ? (moonset.ut - sunset.ut) * 1440 : null;

    const { prev, next } = newMoonsAround(sunset);
    const bestTime = (lagMin !== null && lagMin > 0)
      ? sunset.AddDays((4 / 9) * (lagMin / 1440))
      : sunset;

    const crit = criteria(observer, bestTime, prev);
    const atSunset = criteria(observer, sunset, prev);

    let verdict; // key: identificador estable para traducción en la UI
    if (lagMin !== null && lagMin <= 0) {
      verdict = { code: 'S', key: 'v_lagneg', text: 'No visible: la Luna se pone antes que el Sol (LAG ≤ 0).' };
    } else if (crit.altMoon <= 0) {
      verdict = { code: 'S', key: 'v_below', text: 'No visible: la Luna está bajo el horizonte tras la puesta de sol.' };
    } else if (crit.belowDanjon) {
      verdict = { code: 'F', key: 'v_danjon', text: 'No visible: elongación inferior al límite de Danjon (~7°); el creciente no llega a formarse.' };
    } else {
      const cat = yallopCategory(crit.q);
      verdict = { code: cat.code, key: 'ycat_' + cat.code, text: cat.label };
    }

    return {
      polar: false,
      sunset, moonset, moonrise, lagMin, bestTime,
      conjunctionPrev: prev, conjunctionNext: next,
      crit, atSunset,
      yallop: yallopCategory(crit.q),
      odeh: odehZone(crit.V),
      verdict
    };
  }

  /*
   * Punto del mapa global de visibilidad (versión ligera para el worker).
   * nmUts: instantes UT (días julianos UT de Astronomy Engine) de las lunas
   * nuevas próximas a la fecha, precalculados en el hilo principal.
   * Devuelve { cat, q } donde cat ∈ A..F | S (Luna bajo el horizonte al
   * ponerse el Sol) | P (sin puesta de sol: latitud polar).
   */
  function mapPoint(latDeg, lonDeg, localNoonUtcMs, nmUts) {
    const observer = new A.Observer(latDeg, lonDeg, 0);
    const t0 = A.MakeTime(new Date(localNoonUtcMs));
    const sunset = A.SearchRiseSet(A.Body.Sun, observer, -1, t0, 1.1);
    if (!sunset) return { cat: 'P', q: null };

    let prevUt = null;
    for (const ut of nmUts) if (ut <= sunset.ut) prevUt = ut;
    if (prevUt === null) return { cat: 'N', q: null }; // conjunción aún no ocurrida

    // Altitud de la Luna (sin refracción) en la puesta de sol
    const eqM = A.Equator(A.Body.Moon, sunset, observer, true, true);
    const hM = A.Horizon(sunset, observer, eqM.ra, eqM.dec);
    if (hM.altitude <= 0) return { cat: 'S', q: null };

    const moonset = A.SearchRiseSet(A.Body.Moon, observer, -1, sunset, 1.0);
    let lagDays = moonset ? (moonset.ut - sunset.ut) : (40 / 1440);
    lagDays = Math.min(Math.max(lagDays, 0), 240 / 1440);
    const best = sunset.AddDays((4 / 9) * lagDays);

    const crit = criteria(observer, best, null);
    if (crit.belowDanjon) return { cat: 'F', q: crit.q };
    return { cat: yallopCategory(crit.q).code, q: crit.q };
  }

  /*
   * Tiempos de oración (salat) con definiciones astronómicas:
   *  - Fajr: el Sol asciende por el ángulo de alba (p. ej. −18°) → hasta el orto.
   *  - Dhuhr: paso del Sol por el meridiano (mediodía solar).
   *  - Asr: cuando la sombra de un objeto = factor×objeto + sombra meridiana,
   *    es decir, altitud solar h tal que cot h = factor + tan|φ−δ|.
   *  - Maghrib: puesta de sol.
   *  - Isha: el Sol desciende por el ángulo de crepúsculo, o bien un intervalo
   *    fijo tras el maghrib (convención Umm al-Qura: +90 min).
   *  - Medianoche islámica: punto medio entre la puesta de sol y el alba
   *    siguiente; último tercio de la noche para el qiyam.
   * Las horas oficiales de cada país pueden añadir minutos de cautela.
   */
  function prayerTimes(observer, localNoonUtcMs, opts) {
    opts = opts || {};
    const fajrAngle = opts.fajrAngle === undefined ? 18 : opts.fajrAngle;
    const ishaAngle = opts.ishaAngle;
    const ishaInterval = opts.ishaInterval; // minutos tras el maghrib
    const asrFactor = opts.asrFactor === undefined ? 1 : opts.asrFactor;

    const t0 = A.MakeTime(new Date(localNoonUtcMs - 12 * 3600 * 1000)); // ~medianoche local
    const dhuhr = A.SearchHourAngle(A.Body.Sun, observer, 0, t0).time;  // tránsito
    const sunrise = A.SearchRiseSet(A.Body.Sun, observer, +1, t0, 1.2);
    const sunset = A.SearchRiseSet(A.Body.Sun, observer, -1, dhuhr, 1.0);

    let fajr = A.SearchAltitude(A.Body.Sun, observer, +1, t0, 1.0, -fajrAngle);
    if (fajr && sunrise && fajr.ut > sunrise.ut) fajr = null; // lat. alta: sin alba a ese ángulo

    let asr = null;
    if (dhuhr) {
      const eq = A.Equator(A.Body.Sun, dhuhr, observer, true, true);
      const s0 = Math.tan(Math.abs(observer.latitude - eq.dec) * DEG); // sombra meridiana
      const hAsr = Math.atan(1 / (asrFactor + s0)) / DEG;
      asr = A.SearchAltitude(A.Body.Sun, observer, -1, dhuhr, 0.6, hAsr);
    }

    let isha = null;
    if (sunset) {
      isha = (ishaInterval !== undefined && ishaInterval !== null)
        ? sunset.AddDays(ishaInterval / 1440)
        : A.SearchAltitude(A.Body.Sun, observer, -1, sunset, 0.6, -ishaAngle);
    }

    const fajrNext = sunset ? A.SearchAltitude(A.Body.Sun, observer, +1, sunset, 1.2, -fajrAngle) : null;
    let midnight = null, lastThird = null;
    if (sunset && fajrNext) {
      midnight = sunset.AddDays((fajrNext.ut - sunset.ut) / 2);
      lastThird = sunset.AddDays((fajrNext.ut - sunset.ut) * 2 / 3);
    }

    return { fajr, sunrise, dhuhr, asr, sunset, isha, fajrNext, midnight, lastThird };
  }

  // Próximas n lunaciones (conjunciones geocéntricas) a partir de una fecha.
  function nextNewMoons(fromDate, n) {
    const out = [];
    let t = A.SearchMoonPhase(0, A.MakeTime(fromDate), 40);
    while (t && out.length < n) {
      out.push(t);
      t = A.SearchMoonPhase(0, t.AddDays(1), 40);
    }
    return out;
  }

  global.Hilal = {
    norm180, sepDeg, newMoonsAround, subPoint,
    instantData, criteria, evening, mapPoint, nextNewMoons, prayerTimes,
    yallopCategory, odehZone,
    DANJON_LIMIT_DEG
  };
})(typeof self !== 'undefined' ? self : globalThis);
