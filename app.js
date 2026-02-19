/* =========================================================
   CONFIGURACIÓN GLOBAL
========================================================= */

const svgNS = "http://www.w3.org/2000/svg";

// Márgenes
const MARGIN = {
  top: 20,
  right: 20,
  bottom: 40,
  left: 50
};

// Tamaño gráficas
const CHART_SIZE = {
  width: 1600,
  height: 700
};

// Tamaño de fuentes
const AXIS_FONT_SIZE = 18; // Ejes


/* =========================================================
   ELEMENTOS DEL DOM
========================================================= */

const $ = (s, el = document) => el.querySelector(s);

const els = {
  file: document.getElementById('file'),
  importBtn: document.getElementById('importBtn'),
  status: document.getElementById('status'),
  smooth: document.getElementById('smooth'),
  smoothWindow: document.getElementById('smoothWindow'),
  minStep: document.getElementById('minStep'),
  title: document.getElementById('title'),
  clear: document.getElementById('clear'),
  png: document.getElementById('png'),
  svg: document.getElementById('svg'),

  kPoints: document.getElementById('kPoints'),
  kDist: document.getElementById('kDist'),
  kMinMax: document.getElementById('kMinMax'),

  chartSlope: document.getElementById('chartSlope'),
  chartElevation: document.getElementById('chartElevation'),

  colorSlopeLine: document.getElementById('colorSlopeLine'),
  colorEleLine: document.getElementById('colorEleLine'),
  colorEleArea: document.getElementById('colorEleArea'),
};

Object.entries(els).forEach(([key, value]) => {
  if (!value) console.warn("No existe elemento:", key);
});


/* =========================================================
   ESTADO GLOBAL
========================================================= */

let last = null;
let tmr = null;


/* =========================================================
   CONFIGURACIÓN SVG
========================================================= */

function setupSVG(svg) {
  svg.setAttribute('viewBox', `0 0 ${CHART_SIZE.width} ${CHART_SIZE.height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
}

setupSVG(els.chartSlope);
setupSVG(els.chartElevation);


/* =========================================================
   UTILIDADES GENERALES
========================================================= */

// Clamp valor entre min y max
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Formatear metros a string
function fmtMeters(m) {
  if (!isFinite(m)) return '—';
  if (m >= 1000) return (m / 1000).toFixed(2).replace('.', ',') + ' km';
  return Math.round(m) + ' m';
}

// Formatear distancia para eje horizontal (km o m)
function fmtDist(m) {
  if (!isFinite(m)) return '—';
  if (m >= 1000) return (m / 1000).toFixed(1).replace('.', ',') + ' km';
  return Math.round(m) + ' m';
}

// Haversine para distancia entre dos puntos lat/lon
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

// Media móvil para suavizado
function movingAverage(arr, w) {
  const n = arr.length;
  const out = new Array(n).fill(NaN);
  const half = Math.floor(w / 2);

  for (let i = 0; i < n; i++) {
    let sum = 0, c = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= n) continue;
      const v = arr[j];
      if (isFinite(v)) {
        sum += v;
        c++;
      }
    }
    out[i] = c ? sum / c : NaN;
  }

  return out;
}


/* =========================================================
   INTERFAZ Y ESTADO VISUAL
========================================================= */

// Habilitar o deshabilitar botones exportación
function enableExport(on) {
  els.png.disabled = !on;
  els.svg.disabled = !on;
}

// Mostrar mensajes de estado
function setStatus(msg, kind = '') {
  els.status.textContent = msg || '';
  els.status.style.color =
    kind === 'error'
      ? '#ff6b6b'
      : (kind === 'warn'
        ? '#ffcc66'
        : '#a9b7bd');
}

// Limpiar gráficos y KPIs
function clearCharts() {
  els.chartSlope.innerHTML = '';
  els.chartElevation.innerHTML = '';
  els.kPoints.textContent = '—';
  els.kDist.textContent = '—';
  els.kMinMax.textContent = '—';
}


/* =========================================================
   PARSEO Y PROCESAMIENTO GPX
========================================================= */

// Extraer nombre de ruta del GPX
function extractRouteName(xmlText) {
  try {
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, "application/xml");
    if (xml.querySelector("parsererror")) return null;

    const trkName = xml.querySelector('trk > name');
    if (trkName && trkName.textContent.trim()) return trkName.textContent.trim();

    const metaName = xml.querySelector('metadata > name');
    if (metaName && metaName.textContent.trim()) return metaName.textContent.trim();

    return null;
  } catch {
    return null;
  }
}

// Parsear GPX XML y extraer puntos con lat, lon, ele
function parseGPX(xmlText) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, "application/xml");

  if (xml.querySelector("parsererror"))
    throw new Error("El GPX/XML no se pudo parsear. Asegúrate de que esté completo.");

  let pts = [...xml.getElementsByTagName('trkpt')];
  if (!pts.length) pts = [...xml.getElementsByTagName('rtept')];
  if (!pts.length) throw new Error("No se encontraron puntos <trkpt> o <rtept>.");

  const out = [];

  for (const p of pts) {
    const lat = parseFloat(p.getAttribute('lat'));
    const lon = parseFloat(p.getAttribute('lon'));
    const eleEl = p.getElementsByTagName('ele')[0];
    const ele = eleEl ? parseFloat(eleEl.textContent) : NaN;

    if (!isFinite(lat) || !isFinite(lon)) continue;
    out.push({ lat, lon, ele });
  }

  if (out.length < 2) throw new Error("Muy pocos puntos válidos.");
  const anyEle = out.some(p => isFinite(p.ele));
  if (!anyEle) throw new Error("No hay elevación (<ele>) en el GPX; no se puede calcular pendiente.");

  return out;
}

/* =========================================================
   CONSTRUCCIÓN DE DATOS
========================================================= */

// Construir filas con distancias, pendientes y elevaciones
function buildRows(points, minStepM) {

  const filtered = [points[0]];

  for (let i = 1; i < points.length; i++) {
    const a = filtered[filtered.length - 1];
    const b = points[i];
    const d = haversine(a.lat, a.lon, b.lat, b.lon);
    if (d >= minStepM) filtered.push(b);
  }

  let distAcc = 0;
  let minSlope = Infinity;
  let maxSlope = -Infinity;
  let minEle = Infinity;
  let maxEle = -Infinity;

  const rows = filtered.map((p, i) => {

    if (i === 0) {
      minEle = Math.min(minEle, p.ele);
      maxEle = Math.max(maxEle, p.ele);

      return {
        idx: 1,
        lat: p.lat,
        lon: p.lon,
        ele: p.ele,
        dist: 0,
        distAcc: 0,
        deltaEle: NaN,
        slopePercent: NaN
      };
    }

    const prev = filtered[i - 1];
    const dist = haversine(prev.lat, prev.lon, p.lat, p.lon);
    distAcc += dist;

    const deltaEle =
      (isFinite(prev.ele) && isFinite(p.ele))
        ? (p.ele - prev.ele)
        : NaN;

    const slopePercent =
        (dist > 0 && isFinite(deltaEle))
        ? (deltaEle / dist) * 100
        : NaN;

    if (isFinite(slopePercent)) {
      minSlope = Math.min(minSlope, slopePercent);
      maxSlope = Math.max(maxSlope, slopePercent);
    }

    if (isFinite(p.ele)) {
      minEle = Math.min(minEle, p.ele);
      maxEle = Math.max(maxEle, p.ele);
    }

    return {
      idx: i + 1,
      lat: p.lat,
      lon: p.lon,
      ele: p.ele,
      dist,
      distAcc,
      deltaEle,
      slopePercent
    };
  });

  return {
    rows,
    stats: { distAcc, minSlope, maxSlope, minEle, maxEle }
  };
}


/* =========================================================
   DIBUJO DE EJES
========================================================= */

function drawAxes(
  svg,
  xScale,
  yScale,
  xTicks,
  yTicks,
  xFormat,
  yFormat,
  width,
  height
) {

  const svgWidth = width || CHART_SIZE.width;
  const svgHeight = height || CHART_SIZE.height;

  const chartLeft = MARGIN.left;
  const chartRight = svgWidth - MARGIN.right;
  const chartTop = MARGIN.top;
  const chartBottom = svgHeight - MARGIN.bottom;

  // ----- GRID + TICKS Y
  yTicks.forEach(tick => {

    const y = Math.round(yScale(tick));

    // Si está fuera del área visible, no dibujar nada
    if (y < chartTop || y > chartBottom) return;

    // Grid
    if (tick !== 0) {
        const grid = document.createElementNS(svgNS, 'line');
        grid.setAttribute('x1', chartLeft);
        grid.setAttribute('x2', chartRight);
        grid.setAttribute('y1', y);
        grid.setAttribute('y2', y);
        grid.setAttribute('stroke', 'rgba(255,255,255,0.05)');
        svg.appendChild(grid);
    }

    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', chartLeft);
    line.setAttribute('y1', y);
    line.setAttribute('x2', chartLeft + 6);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', 'rgba(233,240,242,0.6)');
    svg.appendChild(line);

    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', chartLeft - 6);
    text.setAttribute('y', y + 5);
    text.setAttribute('fill', 'rgba(233,240,242,0.8)');
    text.setAttribute('font-size', AXIS_FONT_SIZE);
    text.setAttribute('text-anchor', 'end');
    text.style.fontFamily = 'Inter, sans-serif';
    text.textContent = yFormat ? yFormat(tick) : tick.toString();
    svg.appendChild(text);
  });

  // ----- GRID + TICKS X
  xTicks.forEach(tick => {

    const x = xScale(tick);

    if (tick !== 0) {
      const grid = document.createElementNS(svgNS, 'line');
      grid.setAttribute('x1', x);
      grid.setAttribute('x2', x);
      grid.setAttribute('y1', chartTop);
      grid.setAttribute('y2', chartBottom);
      grid.setAttribute('stroke', 'rgba(255,255,255,0.05)');
      svg.appendChild(grid);
    }

    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', x);
    line.setAttribute('y1', chartBottom);
    line.setAttribute('x2', x);
    line.setAttribute('y2', chartBottom + 6);
    line.setAttribute('stroke', 'rgba(233,240,242,0.6)');
    svg.appendChild(line);

    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', chartBottom + 22);
    text.setAttribute('fill', 'rgba(233,240,242,0.8)');
    text.setAttribute('font-size', AXIS_FONT_SIZE);
    text.setAttribute('text-anchor', 'middle');
    text.style.fontFamily = 'Inter, sans-serif';
    text.textContent = xFormat ? xFormat(tick) : tick.toString();
    svg.appendChild(text);
  });

  // ----- Ejes principales
  const xAxis = document.createElementNS(svgNS, 'line');
  xAxis.setAttribute('x1', chartLeft);
  xAxis.setAttribute('x2', chartRight);
  xAxis.setAttribute('y1', chartBottom);
  xAxis.setAttribute('y2', chartBottom);
  xAxis.setAttribute('stroke', 'rgba(233,240,242,0.7)');
  svg.appendChild(xAxis);

  const yAxis = document.createElementNS(svgNS, 'line');
  yAxis.setAttribute('x1', chartLeft);
  yAxis.setAttribute('x2', chartLeft);
  yAxis.setAttribute('y1', chartTop);
  yAxis.setAttribute('y2', chartBottom);
  yAxis.setAttribute('stroke', 'rgba(233,240,242,0.7)');
  svg.appendChild(yAxis);
}


/* =========================================================
   MOTOR GENÉRICO DE GRÁFICA DE LÍNEA
========================================================= */

function drawLineChart({
  svg,
  data,
  xAccessor,
  yAccessor,
  lineColor = "#4cc9f0",
  areaColor = null,
  yTicks = [],
  yFormat = v => v,
  xFormat = v => v,
  forcedMinY = null,
  forcedMaxY = null
}) {

  svg.innerHTML = "";

  const W = CHART_SIZE.width;
  const H = CHART_SIZE.height;

  const chartLeft = MARGIN.left;
  const chartRight = W - MARGIN.right;
  const chartTop = MARGIN.top;
  const chartBottom = H - MARGIN.bottom;

  const chartWidth = chartRight - chartLeft;
  const chartHeight = chartBottom - chartTop;

  const xValues = data.map(xAccessor).filter(v => isFinite(v));
  const yValues = data.map(yAccessor).filter(v => isFinite(v));

  if (!xValues.length || !yValues.length) return;

  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);

  const autoMinY = Math.min(...yValues);
  const autoMaxY = Math.max(...yValues);
  const minY = arguments[0].forcedMinY ?? autoMinY;
  const maxY = arguments[0].forcedMaxY ?? autoMaxY;

  const xScale = v =>
    chartLeft + ((v - minX) / (maxX - minX || 1)) * chartWidth;

  const yScale = v =>
    chartBottom - ((v - minY) / (maxY - minY || 1)) * chartHeight;

  // Dibujar ejes
  drawAxes(
    svg,
    xScale,
    yScale,
    generateXTicks(minX, maxX),
    yTicks,
    xFormat,
    yFormat,
    W,
    H
  );

    // Línea punteada en Y = 0
    if (minY < 0 && maxY > 0) {
    const zeroY = yScale(0);

    const zeroLine = document.createElementNS(svgNS, "line");
    zeroLine.setAttribute("x1", chartLeft);
    zeroLine.setAttribute("x2", chartRight);
    zeroLine.setAttribute("y1", zeroY);
    zeroLine.setAttribute("y2", zeroY);

    zeroLine.setAttribute("stroke", "rgba(255,255,255,0.45)");
    zeroLine.setAttribute("stroke-width", "1.5");
    zeroLine.setAttribute("stroke-dasharray", "6 6");

    svg.appendChild(zeroLine);
    }


    // Construir path
    let d = "";
    let firstValid = null;
    let lastValid = null;

    data.forEach(row => {

    const yVal = yAccessor(row);
    if (!isFinite(yVal)) return;

    const x = xScale(xAccessor(row));
    const y = yScale(yVal);

    if (!firstValid) {
        d += `M ${x} ${y}`;
        firstValid = { x, y };
    } else {
        d += ` L ${x} ${y}`;
    }

    lastValid = { x, y };
    });

    // Área opcional (si existe y hay puntos válidos)
    if (areaColor && firstValid && lastValid) {

    const areaPath =
        d +
        ` L ${lastValid.x} ${chartBottom}` +
        ` L ${firstValid.x} ${chartBottom} Z`;

    const area = document.createElementNS(svgNS, "path");
    area.setAttribute("d", areaPath);
    area.setAttribute("fill", areaColor);
    area.setAttribute("opacity", "0.3");
    svg.appendChild(area);
    }

  // Línea
  const path = document.createElementNS(svgNS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", lineColor);
  path.setAttribute("stroke-width", "2");
  svg.appendChild(path);
}


function generateXTicks(minX, maxX) {

  const totalKm = maxX / 1000;
  let stepKm;

  if (totalKm < 3) stepKm = 0.25;
  else if (totalKm < 8) stepKm = 0.5;
  else if (totalKm < 20) stepKm = 1;
  else if (totalKm < 50) stepKm = 2;
  else stepKm = 5;

  const step = stepKm * 1000;

  const ticks = [];
  for (let v = 0; v <= maxX; v += step) {
    ticks.push(v);
  }

  return ticks;
}


function drawSlopeChart(rows) {

  const yValues = rows
    .map(r => r.slopePercent_plot)
    .filter(v => isFinite(v));

  if (!yValues.length) return;

  const rawMin = Math.min(...yValues);
  const rawMax = Math.max(...yValues);

  const step = 5;
  
  //Simetria en el eje 0
  const absMax = Math.max(Math.abs(rawMin), Math.abs(rawMax));
  const maxY = Math.ceil(absMax / step) * step;
  const minY = -maxY;


  const yTicks = [];
  for (let v = minY; v <= maxY; v += step) {
    yTicks.push(v);
  }

    drawLineChart({
        svg: els.chartSlope,
        data: rows,
        xAccessor: r => r.distAcc,
        yAccessor: r => r.slopePercent_plot,
        lineColor: els.colorSlopeLine.value,
        yTicks,
        yFormat: v => v.toFixed(0) + "%",
        xFormat: v => {
            const km = v / 1000;
            return km % 1 === 0
            ? km.toFixed(0) + " km"
            : km.toFixed(1) + " km";
        },
        forcedMinY: minY,
        forcedMaxY: maxY
});

}


function drawElevationChart(rows) {

  const yValues = rows.map(r => r.ele).filter(v => isFinite(v));
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);

  const yTicks = [];
  const step = 50;

  const start = Math.floor(minY / step) * step;
  const end = Math.ceil(maxY / step) * step;

  for (let v = start; v <= end; v += step) {
    yTicks.push(v);
  }

  drawLineChart({
    svg: els.chartElevation,
    data: rows,
    xAccessor: r => r.distAcc,
    yAccessor: r => r.ele,
    lineColor: els.colorEleLine.value,
    areaColor: els.colorEleArea.value,
    yTicks,
    yFormat: v => v.toFixed(0),
    xFormat: v => (v / 1000).toFixed(0)
  });
}





/* =========================================================
   FUNCIÓN PRINCIPAL
========================================================= */

async function compute(gpxText) {

  try {

    const xmlText = gpxText.trim();
    if (!xmlText) {
      setStatus('Carga un archivo GPX válido.', 'warn');
      enableExport(false);
      clearCharts();
      return;
    }

    const routeName = extractRouteName(xmlText);
    if (routeName) {
      els.title.value = routeName;
    }

    const points = parseGPX(xmlText);

    const minStepM = clamp(parseFloat(els.minStep.value), 0, 50) || 2;

    let w = parseInt(els.smoothWindow.value, 10);
    if (w % 2 === 0) w += 1;
    w = Math.min(Math.max(w, 1), 101);

    const { rows, stats } = buildRows(points, minStepM);

    const slopes = rows.map(r => r.slopePercent);
    const smooth =
      (els.smooth.value === 'on' && w > 1)
        ? movingAverage(slopes, w)
        : slopes.slice();

    rows.forEach((r, i) => r.slopePercent_plot = smooth[i]);

    last = {
      rows,
      stats,
      meta: { title: els.title.value.trim() || 'Nombre de la ruta' }
    };

    drawSlopeChart(rows, stats);
    drawElevationChart(rows, stats);

    els.kPoints.textContent = rows.length;
    els.kDist.textContent = (stats.distAcc / 1000).toFixed(2) + ' km';
    els.kMinMax.textContent =
      stats.minEle.toFixed(0) + ' / ' +
      stats.maxEle.toFixed(0) + ' m';

    setStatus('GPX procesado correctamente.', '');
    enableExport(true);

  } catch (e) {
    setStatus('Error procesando GPX: ' + e.message, 'error');
    enableExport(false);
    clearCharts();
  }
}


/* =========================================================
   EVENTOS
========================================================= */

// Botón Importar GPX abre selector
els.importBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  els.file.click();
});

// Cuando se selecciona archivo
els.file.addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];

  if (!f) {
    setStatus('No se seleccionó ningún archivo.', 'warn');
    enableExport(false);
    clearCharts();
    return;
  }

  const text = await f.text();
  clearTimeout(tmr);
  tmr = setTimeout(() => compute(text), 150);
});

// Limpieza
els.clear.addEventListener('click', () => {
  els.file.value = '';
  last = null;
  enableExport(false);
  setStatus('Limpio.', '');
  clearCharts();
});

// Inicializar estado
enableExport(false);
setStatus('Carga un GPX para habilitar la exportación.', 'warn');
