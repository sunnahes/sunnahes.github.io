/*
 * hijri.js — Conversión gregoriano ⇄ hijri.
 *
 * Variantes:
 *  - 'islamic-umalqura': calendario civil oficial saudí Umm al-Qura (KACST),
 *    implementado por ICU y expuesto vía Intl. Datos válidos aprox. 1300-1600 AH.
 *  - 'islamic-civil': calendario tabular (aritmético, época del jueves/viernes),
 *    usado históricamente como aproximación.
 *
 * Nota: el día islámico comienza en el maghrib (puesta de sol); estas
 * conversiones siguen la convención civil (medianoche a medianoche).
 */
(function (global) {
  'use strict';

  const MONTHS = [
    'Muharram', 'Safar', "Rabi' al-Awwal", "Rabi' al-Thani",
    'Jumada al-Ula', 'Jumada al-Akhira', 'Rajab', "Sha'ban",
    'Ramadán', 'Shawwal', "Dhu al-Qa'da", 'Dhu al-Hijja'
  ];

  const fmtCache = {};
  function getFmt(variant) {
    if (!fmtCache[variant]) {
      fmtCache[variant] = new Intl.DateTimeFormat(`en-u-ca-${variant}-nu-latn`, {
        timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric'
      });
    }
    return fmtCache[variant];
  }

  // Fecha hijri (y/m/d) del día civil UTC de `date`
  function fromGregorian(date, variant) {
    const parts = {};
    for (const { type, value } of getFmt(variant).formatToParts(date)) parts[type] = value;
    return { y: parseInt(parts.year, 10), m: parseInt(parts.month, 10), d: parseInt(parts.day, 10) };
  }

  // Estimación tabular del día juliano de una fecha hijri
  function estJdn(hy, hm, hd) {
    return Math.floor(hd + Math.ceil(29.5 * (hm - 1)) + (hy - 1) * 354 +
      Math.floor((3 + 11 * hy) / 30) + 1948440 - 1);
  }

  function jdnToDate(jdn) {
    // Devuelve la fecha a las 12:00 UTC de ese día civil
    return new Date((jdn - 2440588) * 86400000 + 12 * 3600000);
  }

  /*
   * Hijri → gregoriano: estima con el calendario tabular y refina comparando
   * con la salida de Intl. Devuelve un Date a las 12:00 UTC del día civil,
   * o null si la fecha no existe en esa variante (p. ej. día 30 de un mes de 29).
   */
  function toGregorian(hy, hm, hd, variant) {
    if (!(hy >= 1 && hm >= 1 && hm <= 12 && hd >= 1 && hd <= 30)) return null;
    const base = estJdn(hy, hm, hd);
    for (const span of [4, 40]) {
      for (let off = -span; off <= span; off++) {
        const dt = jdnToDate(base + off);
        const p = fromGregorian(dt, variant);
        if (p.y === hy && p.m === hm && p.d === hd) return dt;
      }
    }
    return null;
  }

  function format(h, withYearSuffix) {
    return `${h.d} de ${MONTHS[h.m - 1]} de ${h.y}${withYearSuffix === false ? '' : ' AH'}`;
  }

  global.Hijri = { MONTHS, fromGregorian, toGregorian, format };
})(typeof self !== 'undefined' ? self : globalThis);
