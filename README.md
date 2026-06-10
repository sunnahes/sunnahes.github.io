# HilalScope — Visibilidad del creciente lunar

Web de referencia para calcular la visibilidad del hilal (primer creciente lunar)
y el comienzo de los meses islámicos, con base científica.

## Ejecutar

Es un sitio estático; basta cualquier servidor de ficheros:

```bash
python3 -m http.server 8788
# → http://localhost:8788
```

(Necesita conexión a internet solo para la búsqueda de lugares — Nominatim/OSM —
y la ubicación inicial estimada por IP — GeoJS, con ipwho.is de respaldo.)

## Tests

```bash
node test/sanity.cjs
```

Valida las efemérides contra eclipses solares publicados por la NASA (las
conjunciones coinciden con los eclipses), el inicio real de Ramadán 1444 y la
conversión Umm al-Qura.

## Funcionalidad

- Dos vistas conmutables: **mapa 2D en canvas** (equirectangular, sin WebGL,
  por defecto: muy ligero) y **globo 3D** (globe.gl, inicializado solo bajo
  demanda, con antialiasing desactivado, pixel ratio 1 y pausa de animación
  cuando no se usa). Ambas con contorno de continentes (Natural Earth 110m,
  sin fronteras políticas) y retícula; clic o búsqueda para fijar ubicación
  (la inicial se estima por IP), con zona horaria automática (tz-lookup) y
  altitud configurable.
- Proyección de la zona de noche (terminador solar geométrico) y de la zona
  desde la que la Luna está sobre el horizonte (casquete de 90° centrado en el
  punto sublunar, borde amarillo discontinuo), recalculadas para el instante
  seleccionado, con puntos subsolar y sublunar. La intersección noche ∩ zona
  lunar es donde la Luna puede verse en cielo oscuro.
- Fecha/hora en calendario gregoriano o hijri (Umm al-Qura), con equivalencias
  (incluido el tabular/islámico civil) y aviso de cambio de día tras el maghrib.
- Análisis del hilal de la tarde: conjunción, edad de la Luna, puestas de sol y
  luna, LAG, mejor momento Tb = Ts + 4/9·LAG.
- Criterios de visibilidad: **Yallop (1997, NAO TN 69)** (valor q, categorías A–F)
  y **Odeh (2006, ICOP)** (valor V, zonas A–D), más el límite de Danjon (~7°).
- Estado completo de la Luna en cualquier instante: altitud/acimut, fase,
  iluminación, elongación, distancia, paralaje, diámetro, magnitud, AR/Dec…
- Mapa global de visibilidad (categorías de Yallop) calculado en un Web Worker.
- Tabla de próximas lunaciones con el mes islámico que inaugura cada una.
- Franjas de salat con definición astronómica (ángulo solar del alba/crepúsculo,
  paso meridiano, condición de sombra del asr, medianoche islámica y último
  tercio), con métodos MWL / Umm al-Qura / Egipto / ISNA / Karachi y asr
  estándar o hanafí; se resalta la franja vigente y se indica si la Luna está
  sobre el horizonte en cada una.
- Franjas de salat proyectadas sobre el mapa (2D y 3D): capa raster analítica
  que colorea cada punto del planeta según la franja vigente en el instante
  seleccionado (calculada del ángulo horario y la altitud solar locales, sin
  búsquedas: se anima en tiempo real con la rueda del ratón). En 3D se aplica
  como textura del globo sobre el contorno de continentes.
- Rueda del ratón sobre los campos de fecha (±1 día) y hora (±10 min; Mayús
  ±1 min, Ctrl ±1 h) para animar el movimiento del Sol y la Luna en el mapa.

## Ciencia

- Efemérides: [Astronomy Engine](https://github.com/cosinekitty/astronomy)
  (VSOP87 + ELP2000-82 truncada, precisión ~1′).
- Yallop, B.D. (1997). *A Method for Predicting the First Sighting of the New
  Crescent Moon*. NAO Technical Note No. 69, HM Nautical Almanac Office.
- Odeh, M.Sh. (2006). «New Criterion for Lunar Crescent Visibility».
  *Experimental Astronomy* 18, 39–64. doi:10.1007/s10686-005-9002-5.
- Danjon, A. (1936). «Le croissant lunaire». *L'Astronomie* 50, 57–65.
- Calendario Umm al-Qura vía ICU/`Intl` (véase R.H. van Gent, Univ. de Utrecht).

Las convenciones exactas (geocéntrico vs. topocéntrico, refracción, etc.) están
documentadas en la sección «Metodología» de la propia web.
