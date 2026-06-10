/*
 * hijri.js — Gregorian ⇄ Hijri conversion.
 *
 * Variants:
 *  - 'islamic-umalqura': the official Saudi civil calendar Umm al-Qura
 *    (KACST), implemented by ICU and exposed via Intl. Data valid roughly
 *    1300-1600 AH.
 *  - 'islamic-civil': tabular calendar (arithmetic, Thursday/Friday epoch),
 *    historically used as an approximation.
 *
 * Note: the Islamic day begins at maghrib (sunset); these conversions follow
 * the civil convention (midnight to midnight).
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

  // Hijri date (y/m/d) of the UTC civil day of `date`
  function fromGregorian(date, variant) {
    const parts = {};
    for (const { type, value } of getFmt(variant).formatToParts(date)) parts[type] = value;
    return { y: parseInt(parts.year, 10), m: parseInt(parts.month, 10), d: parseInt(parts.day, 10) };
  }

  // Tabular estimate of the Julian day of a Hijri date
  function estJdn(hy, hm, hd) {
    return Math.floor(hd + Math.ceil(29.5 * (hm - 1)) + (hy - 1) * 354 +
      Math.floor((3 + 11 * hy) / 30) + 1948440 - 1);
  }

  function jdnToDate(jdn) {
    // Returns the date at 12:00 UTC of that civil day
    return new Date((jdn - 2440588) * 86400000 + 12 * 3600000);
  }

  /*
   * Hijri → Gregorian: estimates with the tabular calendar and refines by
   * comparing against Intl's output. Returns a Date at 12:00 UTC of the civil
   * day, or null if the date does not exist in that variant (e.g. day 30 of
   * a 29-day month).
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
