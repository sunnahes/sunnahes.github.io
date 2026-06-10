# HilalScope — Crescent moon visibility

Reference site for computing the visibility of the hilal (the first crescent
moon) and the start of the Islamic months, on a scientific basis.

## Running

It is a static site; any file server will do:

```bash
python3 -m http.server 8788
# → http://localhost:8788
```

(An internet connection is only needed for place search — Nominatim/OSM —
and the initial IP-based location estimate — GeoJS, with ipwho.is as fallback.)

## Tests

```bash
node test/sanity.cjs
```

Validates the ephemerides against solar eclipses published by NASA (the
conjunctions coincide with the eclipses), the actual start of Ramadan 1444 and
the Umm al-Qura conversion.

## Features

- Two switchable views: **2D canvas map** (equirectangular, no WebGL, the
  default: very lightweight) and **3D globe** (globe.gl, initialised only on
  demand, with antialiasing disabled, pixel ratio 1 and animation paused when
  not in use). Both with continent outlines (Natural Earth 110m, no political
  borders) and a graticule; click or search to set the location (the initial
  one is estimated from the IP), with automatic time zone (tz-lookup) and
  configurable altitude.
- Projection of the night zone (geometric solar terminator) and of the area
  from which the Moon is above the horizon (90° cap centred on the sublunar
  point, dashed yellow edge), recomputed for the selected instant, with the
  subsolar and sublunar points. The intersection night ∩ lunar zone is where
  the Moon can be seen in a dark sky.
- Date/time in the Gregorian or Hijri (Umm al-Qura) calendar, with
  equivalences (including the tabular/civil Islamic one) and a notice of the
  day change after maghrib.
- Analysis of the evening hilal: conjunction, Moon age, sunset and moonset,
  LAG, best time Tb = Ts + 4/9·LAG.
- Visibility criteria: **Yallop (1997, NAO TN 69)** (q value, categories A–F)
  and **Odeh (2006, ICOP)** (V value, zones A–D), plus the Danjon limit (~7°).
- Full state of the Moon at any instant: altitude/azimuth, phase,
  illumination, elongation, distance, parallax, diameter, magnitude, RA/Dec…
- Global visibility map (Yallop categories) computed in a Web Worker.
- Table of upcoming lunations with the Islamic month each one opens.
- Salat periods with astronomical definition (solar angle of dawn/twilight,
  meridian transit, asr shadow condition, Islamic midnight and last third),
  with the MWL / Umm al-Qura / Egypt / ISNA / Karachi methods and standard or
  Hanafi asr; the current period is highlighted and each one indicates whether
  the Moon is above the horizon.
- Salat periods projected on the map (2D and 3D): an analytic raster layer
  that colours every point on the planet according to the period in force at
  the selected instant (computed from the local hour angle and solar altitude,
  no searches: it animates in real time with the mouse wheel). In 3D it is
  applied as a globe texture over the continent outlines.
- Mouse wheel over the date (±1 day) and time (±10 min; Shift ±1 min,
  Ctrl ±1 h) fields to animate the motion of the Sun and the Moon on the map.

## Science

- Ephemerides: [Astronomy Engine](https://github.com/cosinekitty/astronomy)
  (VSOP87 + truncated ELP2000-82, ~1′ accuracy).
- Yallop, B.D. (1997). *A Method for Predicting the First Sighting of the New
  Crescent Moon*. NAO Technical Note No. 69, HM Nautical Almanac Office.
- Odeh, M.Sh. (2006). "New Criterion for Lunar Crescent Visibility".
  *Experimental Astronomy* 18, 39–64. doi:10.1007/s10686-005-9002-5.
- Danjon, A. (1936). "Le croissant lunaire". *L'Astronomie* 50, 57–65.
- Umm al-Qura calendar via ICU/`Intl` (see R.H. van Gent, Utrecht University).

The exact conventions (geocentric vs. topocentric, refraction, etc.) are
documented in the "Methodology" section of the site itself.
