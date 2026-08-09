import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

/**
 * Aggregate heatmap — MapLibre + WebGPU (himo AverageGridLayerWebGPU).
 * Discrete point overlay when viewport item count ≤ maxPoints.
 * Theme (dark/white) comes from the app — basemap + prix/m² ramp follow it.
 */
import { useGridWorker } from "@himo/hooks/useGridWorker.js";
import {
  AREA_MODE_DISK,
  CELL_POSITION_MODE_BOUNDS,
  CELL_POSITION_MODE_METRICS,
  COLLECTION_DEFAULTS,
  DEFAULT_CELL_POSITION,
  DEFAULT_HEATMAP_VISUAL,
  HEATMAP_COLOR_SCALE_DARK,
  HEATMAP_COLOR_SCALE_WHITE,
  normalizeCellPositionConfig,
} from "@himo/lib/heatmap.js";
import AverageGridLayerWebGPU from "@himo/visualization/AverageGridLayerWebGPU.js";
import { detectWebGPU } from "@himo/visualization/webgpu/detect.js";
import {
  blackenBackdropSettlementLabels,
  brightenDatavizDarkAdminLabels,
  brightenDatavizDarkSettlementLabels,
  brightenDatavizDarkWaterLabels,
  darkenBackdropMajorRoads,
  darkenDatavizDarkBuildings,
  disableTerrain,
  findFirstExistingLayerId,
  lightenBackdropBuildings,
  lightenDatavizDarkRoads,
  tuneDatavizDarkBackgroundAndWater,
  whitenBackdropRoadLabels,
} from "@himo/components/mapStyle.js";

import {
  GPS_DIM,
  DETAIL_LIMIT,
  DEFAULT_READ_OPTIONS,
} from "../lib/sdk.js";
import {
  POINT_LAYER_ID,
  applyPointOverlay,
  ensurePointLayer,
} from "../lib/pointOverlay.js";
import DataMapControls from "./DataMapControls.jsx";
import DataSidePanel, {
  HitsList,
  hitDetailLines,
  hitTitle,
  pointsToHits,
} from "./DataSidePanel.jsx";
import NodesList from "./NodesList.jsx";

function popupHtmlFromHit(hit) {
  const title = hitTitle(hit);
  const lines = hitDetailLines(hit);
  const body = lines
    .map((l) => `<div class="dim">${escapeHtml(l)}</div>`)
    .join("");
  return `<div class="agg-pop"><b>${escapeHtml(title)}</b>${body}</div>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function featureToHit(f, stats) {
  if (!f?.geometry?.coordinates) return null;
  const [lng, lat] = f.geometry.coordinates;
  const v = Number(f.properties?.v) || 0;
  const metricIndex = stats?.valueMetricIndex ?? null;
  return {
    rank: null,
    kind: "item",
    lng,
    lat,
    value: v,
    measure:
      metricIndex != null ? `measure m[${metricIndex}]` : "measure",
    metricIndex,
    normalizer: stats?.normalizer ?? null,
  };
}

const POLYGON_GEOJSON_URL = "/france.geojson";

const MAP_STYLES = {
  dark: {
    url: "https://api.maptiler.com/maps/dataviz-dark/style.json?key=6TL2ju3sEJfZ6Ns5kv7T",
  },
  white: {
    url: "https://api.maptiler.com/maps/backdrop/style.json?key=6TL2ju3sEJfZ6Ns5kv7T",
  },
};

const HEATMAP_INSERT_BEFORE = [
  "Water",
  "water",
  "water-shadow",
  "Country labels",
  "country-label",
];

const DVF_NORMALIZER = COLLECTION_DEFAULTS.normalizer; // 10000 €/m² (himo)

const HEATMAP_VISUAL = { ...DEFAULT_HEATMAP_VISUAL };

function colorScaleForMode(mode) {
  return mode === "white" ? HEATMAP_COLOR_SCALE_WHITE : HEATMAP_COLOR_SCALE_DARK;
}

function effectForMode(mode) {
  return {
    ...HEATMAP_VISUAL,
    smoothEdge: 0,
    fading: 0,
    colors: 24,
    colorInterpolation: colorScaleForMode(mode),
  };
}

const GRID_OPT = {
  offset: { zoom: 0, bounds: 0 },
  resolution: COLLECTION_DEFAULTS.algorithmResolution,
  stream: { progressive: true },
  network: { spatialPrefetchChunkSize: 40 },
};

const POINT_OVERLAY = {
  maxPoints: COLLECTION_DEFAULTS.pointOverlayMaxPoints,
};

function formatEuroM2(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 10000) return `${Math.round(n / 1000)}k €/m²`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k €/m²`;
  return `${Math.round(n)} €/m²`;
}

function createMap(container, center, zoom, styleUrl) {
  try {
    return new maplibregl.Map({
      container,
      style: styleUrl,
      center,
      zoom,
      projection: "mercator",
    });
  } catch (error) {
    console.error("[AggregateHeatmap] Failed to create map:", error);
    return null;
  }
}

function insertHeatmapLayer(map, layer) {
  const beforeId = findFirstExistingLayerId(map, HEATMAP_INSERT_BEFORE);
  const layerId = layer && layer.id;
  if (!layerId) return;

  if (map.getLayer(layerId)) {
    try {
      if (beforeId) map.moveLayer(layerId, beforeId);
    } catch (_) {}
    return;
  }

  try {
    if (beforeId) map.addLayer(layer, beforeId);
    else map.addLayer(layer);
  } catch (error) {
    console.warn(
      "[AggregateHeatmap] addLayer with reference id failed, retrying without:",
      error,
    );
    if (!map.getLayer(layerId)) map.addLayer(layer);
  }
}

function hydrateStyleLayers(map, layer, mode, controller) {
  disableTerrain(map);
  if (mode === "white") {
    lightenBackdropBuildings(map);
    blackenBackdropSettlementLabels(map);
    darkenBackdropMajorRoads(map);
    whitenBackdropRoadLabels(map);
  }
  if (mode === "dark") {
    tuneDatavizDarkBackgroundAndWater(map);
    brightenDatavizDarkSettlementLabels(map);
    brightenDatavizDarkAdminLabels(map);
    brightenDatavizDarkWaterLabels(map);
    lightenDatavizDarkRoads(map);
    darkenDatavizDarkBuildings(map);
  }
  if (layer) insertHeatmapLayer(map, layer);
  ensurePointLayer(map, mode);
  const overlay = controller?.getPointOverlay?.();
  if (overlay) applyPointOverlay(map, overlay, mode);
}

function applyHeatmapPalette(controller, mode) {
  if (!controller?.setEffect || !controller?.getEffect) return;
  const current = controller.getEffect();
  if (!current) return;
  controller.setEffect({
    ...current,
    colorInterpolation: colorScaleForMode(mode),
  });
}

function loadCountryPolygon(layer, onPolygonLoaded) {
  fetch(POLYGON_GEOJSON_URL)
    .then((response) => {
      if (!response.ok) throw new Error("Failed to fetch country GeoJSON");
      return response.json();
    })
    .then((geojson) => {
      onPolygonLoaded?.(geojson);
      if (layer) layer.initializeMask?.(geojson);
    })
    .catch((error) => console.error("[AggregateHeatmap] mask:", error));
}

function HimoHeatmapMap({
  mapZoom,
  mapCenter,
  averageGridController,
  mapStyleMode,
  visualPolygonFilter,
  onMove,
  onRegisterRepaint,
  onPolygonLoaded,
  onPointClick,
  onPointHover,
  fullscreenContainerRef,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const heatmapLayerRef = useRef(null);
  const loadedBasemapModeRef = useRef(null);
  const mapStyleModeRef = useRef(mapStyleMode);
  const visualPolygonFilterRef = useRef(visualPolygonFilter);
  const onMoveRef = useRef(onMove);
  const controllerRef = useRef(averageGridController);
  const onRegisterRepaintRef = useRef(onRegisterRepaint);
  const onPolygonLoadedRef = useRef(onPolygonLoaded);
  const onPointClickRef = useRef(onPointClick);
  const onPointHoverRef = useRef(onPointHover);
  const unsubscribePointsRef = useRef(null);
  const hoverPopupRef = useRef(null);

  useEffect(() => {
    onMoveRef.current = onMove;
    controllerRef.current = averageGridController;
    onRegisterRepaintRef.current = onRegisterRepaint;
    onPolygonLoadedRef.current = onPolygonLoaded;
    onPointClickRef.current = onPointClick;
    onPointHoverRef.current = onPointHover;
  }, [
    onMove,
    averageGridController,
    onRegisterRepaint,
    onPolygonLoaded,
    onPointClick,
    onPointHover,
  ]);

  useEffect(() => {
    mapStyleModeRef.current = mapStyleMode;
  }, [mapStyleMode]);

  useEffect(() => {
    visualPolygonFilterRef.current = visualPolygonFilter;
    heatmapLayerRef.current?.setMaskEnabled?.(visualPolygonFilter !== false);
    mapRef.current?.triggerRepaint?.();
  }, [visualPolygonFilter]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.loaded()) return;
    if (loadedBasemapModeRef.current === mapStyleMode) return;

    const layer = heatmapLayerRef.current;
    const styleSpec = MAP_STYLES[mapStyleMode];
    if (!styleSpec) return;

    applyHeatmapPalette(controllerRef.current, mapStyleMode);
    map.setStyle(styleSpec.url);
    map.once("style.load", () => {
      if (mapRef.current !== map) return;
      loadedBasemapModeRef.current = mapStyleMode;
      hydrateStyleLayers(map, layer, mapStyleMode, controllerRef.current);
      layer?.setMaskEnabled?.(visualPolygonFilterRef.current !== false);
      onMoveRef.current?.(map.getZoom(), map.getBounds());
      map.triggerRepaint?.();
    });
  }, [mapStyleMode]);

  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;
    let cancelled = false;

    const onMapMove = () => {
      const map = mapRef.current;
      if (!map || !onMoveRef.current) return;
      onMoveRef.current(map.getZoom(), map.getBounds());
    };

    (async () => {
      const detection = await detectWebGPU();
      if (cancelled) return;

      const modeForStyle = mapStyleModeRef.current || "dark";
      loadedBasemapModeRef.current = modeForStyle;
      const map = createMap(
        containerRef.current,
        mapCenter,
        mapZoom,
        MAP_STYLES[modeForStyle].url,
      );
      if (!map) return;
      mapRef.current = map;
      onRegisterRepaintRef.current?.(() => map.triggerRepaint());
      map.addControl(
        new maplibregl.NavigationControl({ showCompass: false }),
        "top-right",
      );
      // Native MapLibre FS on the wrap (badge + legend + map), not a custom Full/Exit.
      map.addControl(
        new maplibregl.FullscreenControl({
          container: fullscreenContainerRef?.current || undefined,
        }),
        "top-right",
      );

      map.on("load", () => {
        if (mapRef.current !== map) return;
        const webgpuReady = detection.supported && !!detection.device;
        if (webgpuReady && !heatmapLayerRef.current) {
          heatmapLayerRef.current = new AverageGridLayerWebGPU(
            "average-grid",
            controllerRef.current,
            detection.device,
            detection.features,
          );
        } else if (!webgpuReady) {
          console.error(
            `[AggregateHeatmap] WebGPU unavailable (${detection.reason || "unknown"})`,
          );
        }
        loadCountryPolygon(
          heatmapLayerRef.current,
          (geojson) => onPolygonLoadedRef.current?.(geojson),
        );
        heatmapLayerRef.current?.setMaskEnabled?.(
          visualPolygonFilterRef.current !== false,
        );
        applyHeatmapPalette(controllerRef.current, modeForStyle);
        hydrateStyleLayers(
          map,
          heatmapLayerRef.current,
          modeForStyle,
          controllerRef.current,
        );

        if (!unsubscribePointsRef.current) {
          unsubscribePointsRef.current =
            controllerRef.current?.subscribePointOverlay?.((overlay) => {
              const currentMap = mapRef.current;
              if (currentMap) {
                applyPointOverlay(
                  currentMap,
                  overlay,
                  mapStyleModeRef.current,
                );
                currentMap.triggerRepaint?.();
              }
            }) ?? null;
        }

        const pointLayerReady = () =>
          map.getLayer(POINT_LAYER_ID) ? [POINT_LAYER_ID] : [];

        const hideHoverPopup = () => {
          hoverPopupRef.current?.remove();
          hoverPopupRef.current = null;
          onPointHoverRef.current?.(null);
          map.getCanvas().style.cursor = "";
        };

        map.on("mousemove", (e) => {
          const layers = pointLayerReady();
          if (!layers.length) {
            hideHoverPopup();
            return;
          }
          const feats = map.queryRenderedFeatures(e.point, { layers });
          if (!feats.length) {
            hideHoverPopup();
            return;
          }
          const stats = controllerRef.current?.getPointOverlay?.()?.stats;
          const hit = featureToHit(feats[0], stats);
          if (!hit) {
            hideHoverPopup();
            return;
          }
          map.getCanvas().style.cursor = "pointer";
          onPointHoverRef.current?.(hit);
          if (!hoverPopupRef.current) {
            hoverPopupRef.current = new maplibregl.Popup({
              closeButton: false,
              closeOnClick: false,
              offset: 12,
              className: "agg-popup",
              maxWidth: "16rem",
            });
          }
          hoverPopupRef.current
            .setLngLat([hit.lng, hit.lat])
            .setHTML(popupHtmlFromHit(hit))
            .addTo(map);
        });

        map.on("click", (e) => {
          const layers = pointLayerReady();
          if (!layers.length) return;
          const feats = map.queryRenderedFeatures(e.point, { layers });
          if (!feats.length) return;
          const stats = controllerRef.current?.getPointOverlay?.()?.stats;
          const hit = featureToHit(feats[0], stats);
          if (hit) onPointClickRef.current?.(hit);
        });

        map.on("mouseleave", POINT_LAYER_ID, hideHoverPopup);

        onMapMove();
      });

      map.once("idle", onMapMove);
      map.on("move", onMapMove);
    })();

    return () => {
      cancelled = true;
      const map = mapRef.current;
      hoverPopupRef.current?.remove();
      hoverPopupRef.current = null;
      if (map) {
        map.off("move", onMapMove);
        unsubscribePointsRef.current?.();
        unsubscribePointsRef.current = null;
        map.remove();
        mapRef.current = null;
        heatmapLayerRef.current = null;
      }
      onRegisterRepaintRef.current?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onResize = () => mapRef.current?.resize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <div
      className="map-el"
      ref={containerRef}
      style={{ width: "100%", height: "100%" }}
    />
  );
}

export default function AggregateHeatmap({
  collection,
  hosts,
  bearer,
  detailLimit = DETAIL_LIMIT,
  center = [2.2137, 46.2276],
  zoom = 5,
  normalizer: normalizerProp,
  theme = "dark",
  onStatus,
  onViewportStats,
  onAddClick,
  sideView = "controls",
  onSideView,
  onViewportChange,
  readOptions = null,
}) {
  const mapStyleMode = theme === "white" ? "white" : "dark";
  const [instances, setInstances] = useState(0);
  const [dvf, setDvf] = useState(null);
  const [metricMode, setMetricMode] = useState("dvf");
  const [overlayMode, setOverlayMode] = useState("heatmap");
  const [visibleItemCount, setVisibleItemCount] = useState(0);
  const [parentItemTotal, setParentItemTotal] = useState(0);
  const [pointCount, setPointCount] = useState(0);
  const [pointHits, setPointHits] = useState([]);
  const [selectedPoint, setSelectedPoint] = useState(null);
  const [nodeCount, setNodeCount] = useState(0);
  const [normalizer, setNormalizerState] = useState(
    normalizerProp ?? DVF_NORMALIZER,
  );
  const [resolution, setResolution] = useState(
    COLLECTION_DEFAULTS.algorithmResolution,
  );
  const [maxPoints, setMaxPoints] = useState(
    COLLECTION_DEFAULTS.pointOverlayMaxPoints,
  );
  const [zoneLimit, setZoneLimit] = useState(
    detailLimit ?? COLLECTION_DEFAULTS.cubeSubdivisionLimit,
  );
  const [multiplier, setMultiplier] = useState(
    COLLECTION_DEFAULTS.heatmapVisualMultiplier,
  );
  const [areaMode, setAreaMode] = useState(
    COLLECTION_DEFAULTS.heatmapVisualAreaMode ?? AREA_MODE_DISK,
  );
  const [cellPosition, setCellPositionState] = useState(() =>
    normalizeCellPositionConfig(DEFAULT_CELL_POSITION),
  );
  const [requireCompleteChildren, setRequireCompleteChildren] = useState(
    COLLECTION_DEFAULTS.cubeChildrenThreshold > 1,
  );
  const [childVirtualization, setChildVirtualization] = useState(
    !!COLLECTION_DEFAULTS.childVirtualizationEnabled,
  );
  const [polygonFilter, setPolygonFilter] = useState(false);
  const [visualPolygonFilter, setVisualPolygonFilter] = useState(true);
  const mapWrapRef = useRef(null);

  const dynamicCenter = cellPosition.mode === CELL_POSITION_MODE_METRICS;

  useEffect(() => {
    if (bearer) globalThis.__INDEXUS_BEARER__ = bearer;
  }, [bearer]);

  useEffect(() => {
    if (normalizerProp != null) setNormalizerState(normalizerProp);
  }, [normalizerProp]);

  useEffect(() => {
    if (detailLimit != null) setZoneLimit(detailLimit);
  }, [detailLimit]);

  const peersKey = Array.isArray(hosts) ? hosts.join(",") : "";
  const peers = useMemo(
    () => (peersKey ? peersKey.split(",") : []),
    [peersKey],
  );

  const collectionDef = useMemo(
    () => ({ name: collection, dimensions: [GPS_DIM] }),
    [collection],
  );

  const network = useMemo(
    () => ({
      protocol: "http",
      peers: bearer ? peers : [],
      concurrency: 100,
      cacheSize: 50000,
      setsPool: {
        navigation: readOptions?.navigation ?? DEFAULT_READ_OPTIONS.navigation,
        method: readOptions?.method ?? DEFAULT_READ_OPTIONS.method,
        refreshTtlMs:
          readOptions?.refreshTtlMs ?? DEFAULT_READ_OPTIONS.refreshTtlMs,
      },
    }),
    [
      peers,
      bearer,
      readOptions?.navigation,
      readOptions?.method,
      readOptions?.refreshTtlMs,
    ],
  );

  const cubeOpt = useMemo(
    () => ({
      limit: detailLimit ?? COLLECTION_DEFAULTS.cubeSubdivisionLimit,
      children: COLLECTION_DEFAULTS.cubeChildrenThreshold,
      resolution: COLLECTION_DEFAULTS.algorithmResolution,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const initialEffect = useMemo(
    () => effectForMode(mapStyleMode),
    // mount-only initial palette; live switches go through setEffect
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const { controller, handleMapMove, registerRepaint, onPolygonLoaded } =
    useGridWorker({
      collection: collectionDef,
      gridOpt: GRID_OPT,
      cubeOpt,
      pointOverlay: POINT_OVERLAY,
      network,
      bearer,
      effect: initialEffect,
      initialZoom: zoom,
      normalizer,
      cellPosition: DEFAULT_CELL_POSITION,
      polygonFilterEnabled: false,
      valueMetricIndex: COLLECTION_DEFAULTS.valueMetricIndex,
      childVirtualizationEnabled: COLLECTION_DEFAULTS.childVirtualizationEnabled,
    });

  const onViewportChangeRef = useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;
  const handleMapMoveAndViewport = useCallback(
    (nextZoom, bounds) => {
      handleMapMove(nextZoom, bounds);
      const cb = onViewportChangeRef.current;
      if (!cb || nextZoom == null) return;
      let lng;
      let lat;
      if (bounds && typeof bounds.getCenter === "function") {
        const c = bounds.getCenter();
        lng = c?.lng;
        lat = c?.lat;
      } else if (Array.isArray(bounds) && bounds.length >= 4) {
        // [south, north, west, east]
        lat = (Number(bounds[0]) + Number(bounds[1])) / 2;
        lng = (Number(bounds[2]) + Number(bounds[3])) / 2;
      }
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
      cb([lng, lat], nextZoom);
    },
    [handleMapMove],
  );

  useEffect(() => {
    controller.setNormalizer?.(normalizer);
  }, [controller, normalizer]);

  useEffect(() => {
    applyHeatmapPalette(controller, mapStyleMode);
  }, [controller, mapStyleMode]);

  useEffect(() => {
    controller.setAlgorithmResolution?.(resolution);
  }, [controller, resolution]);

  useEffect(() => {
    controller.setPointOverlayMaxPoints?.(maxPoints);
  }, [controller, maxPoints]);

  useEffect(() => {
    controller.setCubeSubdivisionLimit?.(zoneLimit);
  }, [controller, zoneLimit]);

  useEffect(() => {
    controller.setPolygonFilterEnabled?.(polygonFilter);
  }, [controller, polygonFilter]);

  useEffect(() => {
    controller.setRequireCompleteChildren?.(requireCompleteChildren);
  }, [controller, requireCompleteChildren]);

  useEffect(() => {
    controller.setChildVirtualizationEnabled?.(childVirtualization);
  }, [controller, childVirtualization]);

  useEffect(() => {
    controller.setCellPosition?.(cellPosition);
  }, [controller, cellPosition]);

  useEffect(() => {
    if (!controller?.setEffect || !controller?.getEffect) return;
    const current = controller.getEffect();
    if (!current) return;
    if (
      current.multiplier === multiplier &&
      current.areaMode === areaMode
    ) {
      return;
    }
    controller.setEffect({ ...current, multiplier, areaMode });
  }, [controller, multiplier, areaMode]);

  useEffect(() => {
    const id = setInterval(() => {
      const n = controller.getPackedData?.()?.count ?? 0;
      setInstances((prev) => (prev === n ? prev : n));
    }, 800);
    return () => clearInterval(id);
  }, [controller]);

  useEffect(() => {
    const unsub = controller.subscribePointOverlay?.((overlay) => {
      const stats = overlay?.stats || {};
      const next = stats.dvf || null;
      setDvf((prev) => {
        const same =
          prev?.avgEuroM2 === next?.avgEuroM2 &&
          prev?.transactions === next?.transactions &&
          prev?.avgSurfaceM2 === next?.avgSurfaceM2;
        return same ? prev : next;
      });
      const hasPurchase =
        next &&
        Number.isFinite(next.avgEuroM2) &&
        next.avgEuroM2 > 0 &&
        Number.isFinite(next.avgSurfaceM2) &&
        next.avgSurfaceM2 > 0;
      setMetricMode(hasPurchase ? "dvf" : "density");
      setOverlayMode(stats.mode === "points" ? "points" : "heatmap");
      const fromMetrics = Number.isFinite(stats.metricTotalCount)
        ? Math.round(stats.metricTotalCount)
        : 0;
      const fromOverlay = Number.isFinite(stats.visibleItemCount)
        ? Math.round(stats.visibleItemCount)
        : 0;
      const fromDvf = Number.isFinite(stats.dvf?.transactions)
        ? Math.round(stats.dvf.transactions)
        : 0;
      setVisibleItemCount(fromOverlay);
      // Prefer viewport metric sum (visible parent zones); fall back to
      // DVF transactions then the heatmap↔points weighted gate count.
      const nextParentTotal =
        fromMetrics > 0 ? fromMetrics : fromDvf > 0 ? fromDvf : fromOverlay;
      setParentItemTotal((prev) =>
        prev === nextParentTotal ? prev : nextParentTotal,
      );
      setPointCount(
        Number.isFinite(stats.renderedPointCount)
          ? stats.renderedPointCount
          : overlay?.points?.length
            ? Math.floor(overlay.points.length / 3)
            : 0,
      );
      if (stats.mode === "points" && overlay?.points?.length) {
        setPointHits(pointsToHits(overlay.points, stats));
      } else {
        setPointHits([]);
        setSelectedPoint(null);
      }
    });
    return () => unsub?.();
  }, [controller]);

  useEffect(() => {
    const unsub = controller.subscribeNetwork?.((snap) => {
      const n = Array.isArray(snap?.peers) ? snap.peers.length : 0;
      setNodeCount((prev) => (prev === n ? prev : n));
    });
    return () => unsub?.();
  }, [controller]);

  useEffect(() => {
    onViewportStats?.({
      instances,
      metricMode,
      normalizer,
      dvf,
      mapStyleMode,
      overlayMode,
      visibleItemCount,
      parentItemTotal,
      pointCount,
    });
  }, [
    instances,
    metricMode,
    normalizer,
    dvf,
    mapStyleMode,
    overlayMode,
    visibleItemCount,
    parentItemTotal,
    pointCount,
    onViewportStats,
  ]);

  useEffect(() => {
    const itemsLabel =
      parentItemTotal > 0
        ? `${parentItemTotal.toLocaleString("fr-FR")} items`
        : "0 items";
    if (overlayMode === "points") {
      onStatus?.(
        `points · ${pointCount} ventes · ${itemsLabel} ≤ ${maxPoints}`,
      );
    } else if (metricMode === "dvf" && dvf?.avgEuroM2 != null) {
      onStatus?.(
        `DVF · ${formatEuroM2(dvf.avgEuroM2)} · ${itemsLabel} · ${instances} disks`,
      );
    } else {
      onStatus?.(
        `density · ${itemsLabel} · ${instances} disks · peers ${peers.length}`,
      );
    }
  }, [
    instances,
    peers.length,
    onStatus,
    metricMode,
    dvf,
    normalizer,
    overlayMode,
    pointCount,
    visibleItemCount,
    parentItemTotal,
    maxPoints,
  ]);

  const onDynamicCenter = useCallback((checked) => {
    setCellPositionState((prev) =>
      normalizeCellPositionConfig({
        ...prev,
        mode: checked ? CELL_POSITION_MODE_METRICS : CELL_POSITION_MODE_BOUNDS,
      }),
    );
  }, []);

  const metrics = useMemo(
    () => ({
      mode: overlayMode,
      pointCount,
      avgEuroM2Label: formatEuroM2(dvf?.avgEuroM2),
      transactions: dvf?.transactions,
      instances,
      visibleItemCount,
      parentItemTotal,
    }),
    [
      overlayMode,
      pointCount,
      dvf,
      instances,
      visibleItemCount,
      parentItemTotal,
    ],
  );

  // Must stay above any early return — peers/bearer flip would otherwise
  // change hook order and crash the whole App tree (blank screen).
  const onPointSelect = useCallback(
    (h) => {
      if (!h) return;
      // Prefer matching list row (has rank) when available
      const match =
        pointHits.find(
          (p) =>
            p.lat != null &&
            Math.abs(p.lat - h.lat) < 1e-7 &&
            Math.abs(p.lng - h.lng) < 1e-7,
        ) || h;
      setSelectedPoint(match);
      onSideView?.("items");
      const lines = hitDetailLines(match);
      onStatus?.(
        `${hitTitle(match)}${lines[0] ? ` · ${lines[0]}` : ""}`,
      );
    },
    [pointHits, onSideView, onStatus],
  );

  if (!peers.length || !bearer) {
    return (
      <div className="agg-shell">
        <div className="map-wrap">
          <div className="map-mode-badge">aggregate · waiting</div>
          <div
            className="map-el"
            style={{
              display: "grid",
              placeItems: "center",
              color: "var(--fog)",
              padding: "1rem",
            }}
          >
            {!peers.length
              ? "waiting for mesh hosts…"
              : "issuing bearer for heatmap worker…"}
          </div>
        </div>
        <DataSidePanel
          view={sideView}
          onView={onSideView || (() => {})}
          onAddClick={onAddClick}
          itemCount={0}
          nodeCount={0}
          controls={
            <div className="hit meta" style={{ color: "var(--fog)" }}>
              en attente du mesh…
            </div>
          }
          items={
            <div className="hit meta" style={{ color: "var(--fog)" }}>
              pas encore de points
            </div>
          }
          nodes={
            <div className="hit meta" style={{ color: "var(--fog)" }}>
              en attente des peers…
            </div>
          }
        />
      </div>
    );
  }

  const itemsBadge =
    parentItemTotal > 0
      ? parentItemTotal.toLocaleString("fr-FR")
      : "0";
  const badge =
    overlayMode === "points"
      ? `points · ${pointCount} · ${itemsBadge} items`
      : metricMode === "dvf" && dvf?.avgEuroM2 != null
        ? `heatmap · ${formatEuroM2(dvf.avgEuroM2)} · ${itemsBadge} items`
        : `heatmap · ${itemsBadge} items`;

  const controls = (
    <>
      <DataMapControls
        resolution={resolution}
        onResolution={setResolution}
        maxPoints={maxPoints}
        onMaxPoints={setMaxPoints}
        zoneLimit={zoneLimit}
        onZoneLimit={setZoneLimit}
        multiplier={multiplier}
        onMultiplier={setMultiplier}
        areaMode={areaMode}
        onAreaMode={setAreaMode}
        dynamicCenter={dynamicCenter}
        onDynamicCenter={onDynamicCenter}
        requireCompleteChildren={requireCompleteChildren}
        onRequireCompleteChildren={setRequireCompleteChildren}
        childVirtualization={childVirtualization}
        onChildVirtualization={setChildVirtualization}
        normalizer={normalizer}
        onNormalizer={setNormalizerState}
        polygonFilter={polygonFilter}
        onPolygonFilter={setPolygonFilter}
        visualPolygonFilter={visualPolygonFilter}
        onVisualPolygonFilter={setVisualPolygonFilter}
        metrics={metrics}
      />
    </>
  );

  const itemsPanel =
    overlayMode === "points" ? (
      <HitsList
        hits={pointHits}
        selected={selectedPoint}
        onFocus={onPointSelect}
        empty="aucun point dans le viewport"
      />
    ) : (
      <div className="hit meta" style={{ color: "var(--fog)" }}>
        heatmap actif · zoomez ou baissez le seuil items ({maxPoints}) pour la
        liste des items
      </div>
    );

  return (
    <div className="agg-shell">
      <div ref={mapWrapRef} className={`map-wrap map-wrap--${mapStyleMode}`}>
        <div className="map-mode-bar">
          <div className="map-mode-badge">{badge}</div>
        </div>
        <div
          className="heatmap-legend"
          title={`prix/m² · normalizer ${normalizer}`}
        >
          <span>0</span>
          <div
            className={`heatmap-legend-bar heatmap-legend-bar--${mapStyleMode}`}
            aria-hidden="true"
          />
          <span>
            {normalizer >= 1000
              ? `${Math.round(normalizer / 1000)}k`
              : normalizer}{" "}
            €/m²
          </span>
        </div>
        <HimoHeatmapMap
          mapZoom={zoom}
          mapCenter={center}
          averageGridController={controller}
          mapStyleMode={mapStyleMode}
          visualPolygonFilter={visualPolygonFilter}
          fullscreenContainerRef={mapWrapRef}
          onMove={handleMapMoveAndViewport}
          onRegisterRepaint={registerRepaint}
          onPolygonLoaded={onPolygonLoaded}
          onPointClick={onPointSelect}
        />
      </div>
      <DataSidePanel
        view={sideView}
        onView={onSideView || (() => {})}
        onAddClick={onAddClick}
        itemCount={overlayMode === "points" ? pointHits.length : 0}
        nodeCount={nodeCount}
        controls={controls}
        items={itemsPanel}
        nodes={<NodesList controller={controller} />}
      />
    </div>
  );
}
