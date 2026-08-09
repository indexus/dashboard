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
  pointOverlayMaxPoints: 1000,
  cubeSubdivisionLimit: 5,
  cubeChildrenThreshold: 4,
  childVirtualizationEnabled: false,
  algorithmResolution: 5,
  parentFallbackDepth: 6,
  heatmapVisualMultiplier: 2.5,
  heatmapVisualAreaMode: AREA_MODE_DISK,
  heatmapVisualCentroidSnap: 0,
  polygonDataFilterEnabled: true,
  polygonVisualFilterEnabled: true,
};

export const METRIC_VALEUR_FONCIERE_INDEX = 0;
export const METRIC_SURFACE_BATI_INDEX = 1;
export const METRIC_VALUE_INDEX = COLLECTION_DEFAULTS.valueMetricIndex;
export const METRIC_LAT_INDEX = COLLECTION_DEFAULTS.latMetricIndex;
export const METRIC_LNG_INDEX = COLLECTION_DEFAULTS.lngMetricIndex;
export const METRIC_SCALE = COLLECTION_DEFAULTS.metricScale;
export const LAT_OFFSET = COLLECTION_DEFAULTS.metricLatOffset;
export const LNG_OFFSET = COLLECTION_DEFAULTS.metricLngOffset;
export const METRIC_MAX_INDEX = COLLECTION_DEFAULTS.metricMaxIndex;

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
    Math.min(METRIC_MAX_INDEX, Math.floor(metricLatIndex)),
  );
  metricLngIndex = Math.max(
    0,
    Math.min(METRIC_MAX_INDEX, Math.floor(metricLngIndex)),
  );
  return { mode, metricLatIndex, metricLngIndex };
}

export const DEFAULT_CELL_POSITION = normalizeCellPositionConfig({
  mode: CELL_POSITION_MODE_METRICS,
  metricLatIndex: METRIC_LAT_INDEX,
  metricLngIndex: METRIC_LNG_INDEX,
});

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
