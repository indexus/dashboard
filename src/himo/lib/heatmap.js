import * as d3 from "d3";

export const AREA_MODE_DISK = 0;
export const AREA_MODE_CELL = 1;

export const COLLECTION_DEFAULTS = {
  valueMetricIndex: 2,
  latMetricIndex: 3,
  lngMetricIndex: 4,
  metricScale: 1_000_000,
  metricLatOffset: 90,
  metricLngOffset: 180,
  metricMaxIndex: 63,
  normalizer: 10000,
  // himo.place discrete overlay threshold.
  pointOverlayMaxPoints: 1000,
  cubeSubdivisionLimit: 5,
  cubeChildrenThreshold: 4,
  childVirtualizationEnabled: false,
  // himo.place drill/display resolution (dashboard had drifted to 6).
  algorithmResolution: 5,
  parentFallbackDepth: 6,
  heatmapVisualMultiplier: 2.5,
  heatmapVisualAreaMode: AREA_MODE_DISK,
  heatmapVisualCentroidSnap: 0,
  polygonDataFilterEnabled: true,
  polygonVisualFilterEnabled: true,
};

export const COLLECTION_METRIC_LABELS = {
  0: "Valeur fonciere somme",
  1: "Surface bati somme",
  2: "Prix m2 moyenne",
  3: "Latitude agregee somme",
  4: "Longitude agregee somme",
};

export function collectionMetricLabel(index) {
  const i = Number(index);
  if (!Number.isFinite(i) || i < 0) return "Metrique invalide";
  const key = Math.floor(i);
  return COLLECTION_METRIC_LABELS[key] || `Metrique ${key}`;
}

export const HEATMAP_COLOR_SCALE_WHITE = d3
  .scaleLinear()
  .domain([0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.65, 0.9])
  .range([
    "rgb(255,255,224)",
    "rgb(253,227,178)",
    "rgb(248,199,135)",
    "rgb(240,146,94)",
    "rgb(230,81,56)",
    "rgb(204,33,46)",
    "rgb(157,32,68)",
    "rgb(32,23,115)",
    "rgb(33,33,33)",
  ])
  .interpolate(d3.interpolateRgb);

// Dark basemap: bas en ardoise bleutée résolu ; haut en blanc cassé / blanc bleuté plutôt
// que jaune, tout en gardant une courte montée corail avant les tons très clairs.
export const HEATMAP_COLOR_SCALE_DARK = d3
  .scaleLinear()
  .clamp(true)
  .domain([0.1, 0.125, 0.15, 0.175, 0.2, 0.225, 0.25, 0.3, 0.35, 0.4, 0.52, 0.68, 0.9])
  .range([
    "rgb(10, 14, 26)",
    "rgb(15, 19, 34)",
    "rgb(21, 25, 44)",
    "rgb(27, 29, 54)",
    "rgb(33, 33, 64)",
    "rgb(38, 36, 74)",
    "rgb(76, 44, 66)",
    "rgb(118, 50, 70)",
    "rgb(142, 54, 74)",
    "rgb(156, 62, 76)",
    "rgb(172, 88, 74)",
    "rgb(208, 188, 186)",
    "rgb(246, 245, 248)",
  ])
  .interpolate(d3.interpolateRgb);

export const DEFAULT_HEATMAP_VISUAL = {
  multiplier: COLLECTION_DEFAULTS.heatmapVisualMultiplier,
  areaMode: COLLECTION_DEFAULTS.heatmapVisualAreaMode,
  centroidSnap: COLLECTION_DEFAULTS.heatmapVisualCentroidSnap,
};

export const RESOLUTION = COLLECTION_DEFAULTS.algorithmResolution;
export const PARENT_FALLBACK_DEPTH = COLLECTION_DEFAULTS.parentFallbackDepth;

export const METRIC_VALEUR_FONCIERE_INDEX = 0;
export const METRIC_SURFACE_BATI_INDEX = 1;
export const METRIC_VALUE_INDEX = COLLECTION_DEFAULTS.valueMetricIndex;
export const METRIC_LAT_INDEX = COLLECTION_DEFAULTS.latMetricIndex;
export const METRIC_LNG_INDEX = COLLECTION_DEFAULTS.lngMetricIndex;
export const METRIC_SCALE = COLLECTION_DEFAULTS.metricScale;
export const LAT_OFFSET = COLLECTION_DEFAULTS.metricLatOffset;
export const LNG_OFFSET = COLLECTION_DEFAULTS.metricLngOffset;
export const METRIC_MAX_INDEX = COLLECTION_DEFAULTS.metricMaxIndex;

export function metricLabel(index) {
  const n = Number(index);
  if (!Number.isFinite(n) || n < 0) return "Métrique invalide";
  const i = Math.floor(n);
  const base = collectionMetricLabel(i);
  return `[${i}] ${base}`;
}

export const CELL_POSITION_MODE_BOUNDS = "bounds";
export const CELL_POSITION_MODE_METRICS = "metrics";

export function normalizeCellPositionConfig(raw) {
  const mode =
    raw?.mode === CELL_POSITION_MODE_BOUNDS
      ? CELL_POSITION_MODE_BOUNDS
      : CELL_POSITION_MODE_METRICS;
  let metricLatIndex = Number(raw?.metricLatIndex);
  let metricLngIndex = Number(raw?.metricLngIndex);
  if (!Number.isFinite(metricLatIndex)) metricLatIndex = METRIC_LAT_INDEX;
  if (!Number.isFinite(metricLngIndex)) metricLngIndex = METRIC_LNG_INDEX;
  metricLatIndex = Math.max(
    0,
    Math.min(METRIC_MAX_INDEX, Math.floor(metricLatIndex))
  );
  metricLngIndex = Math.max(
    0,
    Math.min(METRIC_MAX_INDEX, Math.floor(metricLngIndex))
  );
  return { mode, metricLatIndex, metricLngIndex };
}

export const DEFAULT_CELL_POSITION = normalizeCellPositionConfig({
  mode: CELL_POSITION_MODE_METRICS,
  metricLatIndex: METRIC_LAT_INDEX,
  metricLngIndex: METRIC_LNG_INDEX,
});

export function cellPositionEquals(a, b) {
  return (
    a.mode === b.mode &&
    a.metricLatIndex === b.metricLatIndex &&
    a.metricLngIndex === b.metricLngIndex
  );
}

const SCALED_DETECTION_THRESHOLD = 10_000;

export function decodeMetricCentroid(cell, latIdx, lngIdx) {
  if (!cell?.metrics || !Array.isArray(cell.metrics)) return null;
  if (
    latIdx < 0 ||
    lngIdx < 0 ||
    latIdx >= cell.metrics.length ||
    lngIdx >= cell.metrics.length
  ) {
    return null;
  }
  const count = Number(cell.count);
  if (!Number.isFinite(count) || count <= 0) return null;
  const latSum = cell.metrics[latIdx];
  const lngSum = cell.metrics[lngIdx];
  if (!Number.isFinite(latSum) || !Number.isFinite(lngSum)) return null;
  const perItem = Math.abs(latSum) / count;
  const scale = perItem > SCALED_DETECTION_THRESHOLD ? METRIC_SCALE : 1;
  const lat = latSum / (scale * count) - LAT_OFFSET;
  const lng = lngSum / (scale * count) - LNG_OFFSET;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export function ensureMetricCentroid(cell, latIdx, lngIdx) {
  if (cell.__lat !== undefined) return true;
  const decoded = decodeMetricCentroid(cell, latIdx, lngIdx);
  if (!decoded) return false;
  cell.__lat = decoded.lat;
  cell.__lng = decoded.lng;
  return true;
}

export function ensureCentroid(cell) {
  if (cell.__lat !== undefined) return;
  if (!ensureMetricCentroid(cell, METRIC_LAT_INDEX, METRIC_LNG_INDEX)) {
    cell.__lat = NaN;
    cell.__lng = NaN;
  }
}
