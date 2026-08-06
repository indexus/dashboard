/**
 * MapLibre circle layer for discrete sale points (ported from himo MapScreen).
 * Colors use clamp(v / normalizer) against the active theme prix/m² ramp.
 */
import {
  COLLECTION_DEFAULTS,
  HEATMAP_COLOR_SCALE_DARK,
  HEATMAP_COLOR_SCALE_WHITE,
} from "@himo/lib/heatmap.js";

export const POINT_SOURCE_ID = "average-grid-points-source";
export const POINT_LAYER_ID = "average-grid-points-layer";

const DEFAULT_POINT_NORMALIZER = COLLECTION_DEFAULTS.normalizer;

/** MapLibre interpolate stops: [t0, color0, t1, color1, …] sampled from d3 scale. */
function buildColorStops(scale, samples = 64) {
  const domain = scale.domain();
  const start = domain[0];
  const end = domain[domain.length - 1];
  const span = end > start ? end - start : 1;
  const stops = [];
  const n = Math.max(2, samples);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const value = start + t * span;
    stops.push(t, scale(value));
  }
  return stops;
}

const POINT_COLOR_STOPS_WHITE = buildColorStops(HEATMAP_COLOR_SCALE_WHITE, 64);
const POINT_COLOR_STOPS_DARK = buildColorStops(HEATMAP_COLOR_SCALE_DARK, 64);

export function emptyFeatureCollection() {
  return { type: "FeatureCollection", features: [] };
}

export function pointsToFeatureCollection(points) {
  const features = [];
  for (let i = 0; i + 2 < points.length; i += 3) {
    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [points[i], points[i + 1]],
      },
      properties: { v: points[i + 2] },
    });
  }
  return { type: "FeatureCollection", features };
}

export function getColoredPointPaint(mode, normalizer, hoverKey = null) {
  const whiteMode = mode === "white";
  const stops = whiteMode ? POINT_COLOR_STOPS_WHITE : POINT_COLOR_STOPS_DARK;
  const denom =
    Number.isFinite(normalizer) && normalizer > 0
      ? normalizer
      : DEFAULT_POINT_NORMALIZER;
  const inputExpr = ["max", 0, ["min", 1, ["/", ["get", "v"], denom]]];
  const colorExpr = ["interpolate", ["linear"], inputExpr];
  for (let i = 0; i < stops.length; i += 2) {
    colorExpr.push(stops[i], stops[i + 1]);
  }
  const strokeColor = whiteMode ? "#ffffff" : "hsl(0, 0%, 94%)";
  const HOVER_YELLOW = "#f0c040";
  const isHover = hoverKey
    ? ["==", ["get", "hk"], hoverKey]
    : false;
  return {
    "circle-radius": hoverKey
      ? ["case", isHover, 12.5, 6.2]
      : 6.2,
    "circle-color": colorExpr,
    "circle-opacity": 0.95,
    "circle-stroke-width": hoverKey
      ? ["case", isHover, 3.2, 1]
      : 1,
    "circle-stroke-color": hoverKey
      ? ["case", isHover, HOVER_YELLOW, strokeColor]
      : strokeColor,
  };
}

export function applyPointPaint(map, paint) {
  if (!map.getLayer(POINT_LAYER_ID)) return;
  const props = [
    "circle-radius",
    "circle-color",
    "circle-opacity",
    "circle-stroke-width",
    "circle-stroke-color",
  ];
  for (let i = 0; i < props.length; i++) {
    const key = props[i];
    if (paint[key] !== undefined) {
      map.setPaintProperty(POINT_LAYER_ID, key, paint[key]);
    }
  }
}

export function ensurePointLayer(map, mode) {
  const pointPaint = getColoredPointPaint(mode, DEFAULT_POINT_NORMALIZER);
  if (!map.getSource(POINT_SOURCE_ID)) {
    map.addSource(POINT_SOURCE_ID, {
      type: "geojson",
      data: emptyFeatureCollection(),
    });
  }
  if (!map.getLayer(POINT_LAYER_ID)) {
    map.addLayer({
      id: POINT_LAYER_ID,
      type: "circle",
      source: POINT_SOURCE_ID,
      paint: pointPaint,
      layout: { visibility: "none" },
    });
  } else {
    applyPointPaint(map, pointPaint);
  }
  map.moveLayer(POINT_LAYER_ID);
}

export function applyPointOverlay(map, overlay, mode) {
  const source = map.getSource(POINT_SOURCE_ID);
  if (!source) return;

  const layerVisible =
    !!overlay?.enabled &&
    overlay.points instanceof Float32Array &&
    overlay.points.length > 0;
  source.setData(
    layerVisible
      ? pointsToFeatureCollection(overlay.points)
      : emptyFeatureCollection(),
  );

  if (!map.getLayer(POINT_LAYER_ID)) return;
  map.setLayoutProperty(
    POINT_LAYER_ID,
    "visibility",
    layerVisible ? "visible" : "none",
  );
  if (!layerVisible) return;

  const stats = overlay?.stats || {};
  const paint = getColoredPointPaint(mode, stats.normalizer);
  applyPointPaint(map, paint);
}

export function hitHoverKey(h) {
  if (!h || h.lat == null || h.lng == null) return null;
  return `${h.rank ?? ""}|${h.id ?? ""}|${Number(h.lat).toFixed(5)}|${Number(h.lng).toFixed(5)}`;
}

export function hitsToFeatureCollection(hits) {
  const features = [];
  for (const h of hits || []) {
    if (h.lat == null || h.lng == null) continue;
    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [h.lng, h.lat],
      },
      properties: {
        v: Number(h.value) || 0,
        id: h.id || "",
        rank: h.rank ?? 0,
        hk: hitHoverKey(h),
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Apply Nearby search hits as €/m²-colored circles (same ramp as Aggregate). */
export function applyHitsOverlay(map, hits, mode, normalizer, hoverKey = null) {
  ensurePointLayer(map, mode);
  const source = map.getSource(POINT_SOURCE_ID);
  if (!source) return;
  const fc = hitsToFeatureCollection(hits);
  const visible = fc.features.length > 0;
  source.setData(visible ? fc : emptyFeatureCollection());
  if (!map.getLayer(POINT_LAYER_ID)) return;
  map.setLayoutProperty(
    POINT_LAYER_ID,
    "visibility",
    visible ? "visible" : "none",
  );
  if (!visible) return;
  applyPointPaint(map, getColoredPointPaint(mode, normalizer, hoverKey));
  try {
    map.moveLayer(POINT_LAYER_ID);
  } catch {
    /* ignore */
  }
}

