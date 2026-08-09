// React-side bridge to the heatmap worker.
//
// Owns the worker lifecycle, the bidirectional message protocol, and the
// RAF-driven transition factor. Exposes a stable controller object the
// WebGPU layer reads every frame, plus camera + polygon hooks the map
// component calls.
//
// Communication
// -------------
//   main → worker:  INIT, LOAD_POLYGON, MOVE, RELEASE_PACKED, TRANSITION_COMPLETE,
//                    RECONCILE, SET_CELL_POSITION, SET_POINT_OVERLAY_MAX_POINTS,
//                    SET_CUBE_SUBDIVISION_LIMIT, SET_REQUIRE_COMPLETE_CHILDREN,
//                    SET_ALGO_RESOLUTION, SET_POLYGON_FILTER_ENABLED,
//                    SET_VALUE_METRIC_INDEX, SET_CHILD_VIRTUALIZATION
//   INIT.payload.debugHeatmap — optional console diagnostics ([heatmap-worker], …).
//   INIT.payload.debugSdk     — SDK read-path channels ([indexus:sets|refresh|cube]).
//   worker → main:  INIT_COMPLETE, PACKED, VIEWPORT_METRICS, PERF_DEBUG,
//                    NETWORK_PEERS, NETWORK_ACTIVITY, ERROR
//
// PACKED carries a Float32Array as a transferable, pooled inside the
// worker — we send the buffer back via RELEASE_PACKED when a newer one
// arrives so the steady state stays at ~1 ArrayBuffer in flight.

import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  COLLECTION_DEFAULTS,
  DEFAULT_CELL_POSITION,
  normalizeCellPositionConfig,
} from "../lib/heatmap";

/** GPU snapshot cross-fade prev→cur (heatmap). Longer + eased = less “flash”. */
const TRANSITION_DURATION_MS = 720;

function easeTransitionBlend(t) {
  const x = Math.min(1, Math.max(0, t));
  // smoothstep: derivative ~0 at start/end → progressive fade-in/out
  return x * x * (3 - 2 * x);
}
// Heatmap opacity is binary from the packed snapshot only: visible whenever
// instanceCount > 0. Stats-driven fades fought EMPTY_PACK_GRACE (GPU still
// shows last composite while counts fluctuate during zoom).
// Threshold (in visible items) below which the points overlay switches
// from a solid white/black fill to per-point coloring driven by the
// same metric (and the same color palette) as the heatmap.
const POINT_COLOR_THRESHOLD = 200;
// During a strong zoom the cube briefly has nothing to display while
// the new LOD tiers stream in. Without this grace window the worker's
// `PACKED { instanceCount: 0 }` would clear the on-screen heatmap for
// 1+ frames (the WebGPU accum pass uses `loadOp:"clear"` regardless of
// instance count). Holding onto the previous packed snapshot for a
// short grace keeps the heatmap visible across that gap, then we let
// the empty pack through if the gap persists (genuinely-empty viewport).
const EMPTY_PACK_GRACE_MS = 300;
/** Hold heatmap/points invisible after INIT while coarse LOD packs stream
 *  in and the cube descends to the configured detail — avoids a colour flash
 *  of large parent sets before finer tiers arrive. */
const INITIAL_LOD_REVEAL_MS = 2000;
const NOOP = () => {};
const EMPTY_PACKED = { count: 0, data: null, snapshotVersion: 0 };

/** Point overlay as seen by the map — hidden during the initial LOD settle. */
function gatedPointOverlay(overlay, revealAtRef) {
  if (!overlay) return overlay;
  if (performance.now() < (revealAtRef?.current || 0)) {
    if (!overlay.enabled) return overlay;
    return { ...overlay, enabled: false };
  }
  return overlay;
}

function notifyPointSubscribers(ctx, overlay) {
  const visible = gatedPointOverlay(overlay, ctx.revealAtRef);
  for (const subscriber of ctx.pointSubscribersRef.current) {
    try {
      subscriber(visible);
    } catch (_) {
      /* ignore */
    }
  }
}
const EMPTY_POINTS = {
  enabled: false,
  points: [],
  stats: {
    visibleItemCount: 0,
    threshold: COLLECTION_DEFAULTS.pointOverlayMaxPoints,
    zoneSubdivisionThreshold: COLLECTION_DEFAULTS.cubeSubdivisionLimit,
    requireCompleteChildren: COLLECTION_DEFAULTS.cubeChildrenThreshold > 1,
    childVirtualizationEnabled: COLLECTION_DEFAULTS.childVirtualizationEnabled,
    algorithmResolution: COLLECTION_DEFAULTS.algorithmResolution,
    polygonFilterEnabled: COLLECTION_DEFAULTS.polygonDataFilterEnabled,
    valueMetricIndex: COLLECTION_DEFAULTS.valueMetricIndex,
    metricTotalCount: 0,
    metricSums: [],
    renderedZoneCount: 0,
    renderedPointCount: 0,
    mode: "heatmap",
    metricCount: 0,
    dvf: {
      transactions: 0,
      avgValeurFonciere: null,
      avgSurfaceM2: null,
      avgEuroM2: null,
    },
  },
};

function viewportDvfFromPayload(payload) {
  const v = payload?.viewportDvf;
  if (!v) {
    return {
      transactions: 0,
      avgValeurFonciere: null,
      avgSurfaceM2: null,
      avgEuroM2: null,
    };
  }
  return {
    transactions: Number.isFinite(v.transactions) ? v.transactions : 0,
    avgValeurFonciere: Number.isFinite(v.avgValeurFonciere)
      ? v.avgValeurFonciere
      : null,
    avgSurfaceM2: Number.isFinite(v.avgSurfaceM2) ? v.avgSurfaceM2 : null,
    avgEuroM2: Number.isFinite(v.avgEuroM2) ? v.avgEuroM2 : null,
  };
}

export function useGridWorker({
  collection,
  gridOpt,
  cubeOpt,
  pointOverlay,
  network,
  effect,
  initialZoom,
  normalizer,
  cellPosition: cellPositionProp,
  polygonFilterEnabled = true,
  valueMetricIndex = 2,
  childVirtualizationEnabled = COLLECTION_DEFAULTS.childVirtualizationEnabled,
  /** Bearer for permissioned meshes — injected into the worker before Network pings. */
  bearer,
}) {
  const workerRef = useRef(null);
  const repaintRef = useRef(NOOP);
  const debugHeatmapRef = useRef(false);
  debugHeatmapRef.current = gridOpt?.debugHeatmap === true;

  // The latest snapshot packed by the worker, plus its metadata. The
  // WebGPU layer reads this every frame; the underlying Float32Array is
  // pooled inside the worker.
  const latestPackedRef = useRef(EMPTY_PACKED);
  const latestPointsRef = useRef(EMPTY_POINTS);
  const pointSubscribersRef = useRef(new Set());
  const networkSubscribersRef = useRef(new Set());
  const latestNetworkRef = useRef({ peers: [], activity: null });
  // Timestamp (Date.now()) until which we'll keep showing the previous
  // packed snapshot if the worker reports `instanceCount: 0`. Reset to
  // `now + EMPTY_PACK_GRACE_MS` every time a non-empty pack arrives, so
  // the window only opens after we've actually had something to hold on to.
  const emptyPackGraceUntilRef = useRef(0);
  /** performance.now() until which heatmap + points stay hidden (initial LOD settle). */
  const revealAtRef = useRef(0);
  const revealTimerRef = useRef(null);
  const effectRef = useRef(effect);
  const normalizerRef = useRef(normalizer);
  const resolutionRef = useRef(
    cubeOpt?.resolution ?? COLLECTION_DEFAULTS.algorithmResolution
  );

  // Transition timing lives here because it is RAF-driven (0→1 over
  // TRANSITION_DURATION_MS with smoothstep easing, independent of the worker's
  // repack cadence). The worker only signals when to START a blend
  // (`PACKED.dataDriven`).
  const transitionRef = useRef({
    active: false,
    startedAt: 0,
    snapshotVersion: -1,
  });
  const transitionRafRef = useRef(null);

  const pendingMoveRef = useRef(null);
  const moveRafRef = useRef(null);

  const zoomRef = useRef(initialZoom);

  const getTransitionFactor = useCallback(() => {
    const state = transitionRef.current;
    if (!state.active) return 1;
    const elapsed = performance.now() - state.startedAt;
    const linear = Math.min(1, elapsed / TRANSITION_DURATION_MS);
    if (linear >= 1) {
      state.active = false;
      state.snapshotVersion = -1;
      // Tell the worker the GPU blend is done so it can drop its
      // `previousDisplay` and re-pack without the merge. Without this,
      // cells that exist in `prev` but not `cur` linger forever (the
      // merge writes prev's data into BOTH the previous_* and current_*
      // slots, so the GPU mix collapses to prev at factor=1 instead of
      // disappearing). Echo the snapshotVersion so a stale ack racing a
      // newer dataDriven flush is ignored on the worker side.
      workerRef.current?.postMessage({
        type: "TRANSITION_COMPLETE",
        payload: { snapshotVersion: latestPackedRef.current.snapshotVersion },
      });
    }
    return easeTransitionBlend(linear);
  }, []);

  const scheduleTransitionRepaint = useCallback(() => {
    if (transitionRafRef.current !== null) return;
    const tick = () => {
      transitionRafRef.current = null;
      if (!transitionRef.current.active) return;
      repaintRef.current();
      if (getTransitionFactor() < 1) {
        transitionRafRef.current = window.requestAnimationFrame(tick);
      }
    };
    transitionRafRef.current = window.requestAnimationFrame(tick);
  }, [getTransitionFactor]);

  // Worker lifecycle — wait for mesh peers (+ optional bearer) so INIT
  // never races an empty bootstrap list / missing Authorization header.
  useEffect(() => {
    if (!network?.peers?.length) return;
    // Empty string means "token pending" (mesh_dash). Undefined = no-auth mesh (himo).
    if (bearer === "") return;

    const worker = new Worker(
      new URL("../workers/grid.worker.js", import.meta.url),
      { type: "module" }
    );
    workerRef.current = worker;
    latestNetworkRef.current = { peers: [], activity: null };

    // Gate the first paint until coarse parent sets have had time to
    // subdivide toward the configured resolution / zone threshold.
    if (revealTimerRef.current != null) {
      clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    revealAtRef.current = performance.now() + INITIAL_LOD_REVEAL_MS;
    revealTimerRef.current = window.setTimeout(() => {
      revealTimerRef.current = null;
      revealAtRef.current = 0;
      notifyPointSubscribers(
        { pointSubscribersRef, revealAtRef },
        latestPointsRef.current,
      );
      repaintRef.current();
    }, INITIAL_LOD_REVEAL_MS);

    worker.onmessage = (event) =>
      handleWorkerMessage(event, {
        latestPackedRef,
        latestPointsRef,
        pointSubscribersRef,
        networkSubscribersRef,
        latestNetworkRef,
        emptyPackGraceUntilRef,
        revealAtRef,
        normalizerRef,
        resolutionRef,
        transitionRef,
        scheduleTransitionRepaint,
        repaintRef,
        worker,
        debugHeatmapRef,
      });

    worker.onerror = (error) => {
      console.error("Worker encountered an error:", error);
    };

    worker.postMessage({
      type: "INIT",
      payload: {
        collection,
        gridOpt,
        cubeOpt,
        pointOverlay,
        network,
        bearer: bearer || undefined,
        debugPerf: gridOpt?.debugPerf,
        // SDK read-path channels ("sets,refresh,cube", true, or false). The
        // worker is a separate realm, so the console global does not reach it.
        debugSdk: gridOpt?.debugSdk ?? globalThis.__INDEXUS_DEBUG__ ?? false,
        cellPosition: normalizeCellPositionConfig(
          cellPositionProp ?? DEFAULT_CELL_POSITION
        ),
        polygonFilterEnabled: polygonFilterEnabled !== false,
        valueMetricIndex,
        childVirtualizationEnabled: childVirtualizationEnabled !== false,
        debugHeatmap: gridOpt?.debugHeatmap === true,
      },
    });

    return () => {
      if (revealTimerRef.current != null) {
        clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
      worker.terminate();
      workerRef.current = null;
    };
    // Intentionally omit `cellPositionProp`: runtime updates use SET_CELL_POSITION
    // so toggling the map panel does not terminate and recreate the worker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    collection,
    gridOpt,
    cubeOpt,
    pointOverlay,
    network,
    bearer,
    scheduleTransitionRepaint,
  ]);

  // Cleanup any in-flight RAFs on unmount.
  useEffect(
    () => () => {
      repaintRef.current = NOOP;
      if (moveRafRef.current !== null) cancelAnimationFrame(moveRafRef.current);
      if (transitionRafRef.current !== null)
        cancelAnimationFrame(transitionRafRef.current);
    },
    []
  );

  useEffect(() => {
    effectRef.current = effect;
  }, [effect]);

  useEffect(() => {
    normalizerRef.current = normalizer;
  }, [normalizer]);

  // Camera move flush — coalesces back-to-back map events into one
  // postMessage per frame.
  const flushPendingMove = useCallback(() => {
    moveRafRef.current = null;
    const pending = pendingMoveRef.current;
    const worker = workerRef.current;
    if (!pending || !worker) return;
    worker.postMessage({
      type: "MOVE",
      payload: {
        zoom: pending.zoom,
        bounds: pending.bounds,
        strictBounds: pending.strictBounds,
      },
    });
  }, []);

  const handleMapMove = useCallback(
    (mapZoom, mapBounds) => {
      const sw = mapBounds.getSouthWest();
      const ne = mapBounds.getNorthEast();
      const latStep = (ne.lat - sw.lat) / 2;
      const lngStep = (ne.lng - sw.lng) / 2;
      const bounds = [
        {
          dimension: 0,
          segment: [
            sw.lat - latStep,
            ne.lat + latStep,
            sw.lng - lngStep,
            ne.lng + lngStep,
          ],
        },
      ];
      const strictBounds = [
        {
          dimension: 0,
          segment: [sw.lat, ne.lat, sw.lng, ne.lng],
        },
      ];

      zoomRef.current = mapZoom;
      pendingMoveRef.current = { zoom: mapZoom, bounds, strictBounds };
      if (moveRafRef.current === null) {
        moveRafRef.current = requestAnimationFrame(flushPendingMove);
      }
    },
    [flushPendingMove]
  );

  const onPolygonLoaded = useCallback((geojson) => {
    if (!workerRef.current || !geojson) return;
    workerRef.current.postMessage({ type: "LOAD_POLYGON", payload: geojson });
  }, []);

  const registerRepaint = useCallback((requestRepaint) => {
    repaintRef.current =
      typeof requestRepaint === "function" ? requestRepaint : NOOP;
  }, []);

  const getZoom = useCallback(() => zoomRef.current, []);
  const getPackedData = useCallback(() => latestPackedRef.current, []);
  const setAlgorithmResolution = useCallback((value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    const next = Math.max(1, Math.floor(n));
    resolutionRef.current = next;
    workerRef.current?.postMessage({
      type: "SET_ALGO_RESOLUTION",
      payload: { value: next },
    });
    repaintRef.current();
  }, []);
  const setNormalizer = useCallback((value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return;
    normalizerRef.current = n;
    // Points paint uses overlay.stats.normalizer (MapLibre circle-color).
    // Update it and notify subscribers so discrete points recolor immediately
    // with the heatmap — don't wait for the next PACKED frame.
    const cur = latestPointsRef.current;
    if (cur?.enabled && cur.stats) {
      latestPointsRef.current = {
        ...cur,
        stats: { ...cur.stats, normalizer: n },
      };
      notifyPointSubscribers(
        { pointSubscribersRef, revealAtRef },
        latestPointsRef.current,
      );
    }
    repaintRef.current();
  }, []);
  const getResolutionConstant = useCallback(() => resolutionRef.current, []);
  const getNormalizer = useCallback(() => normalizerRef.current, []);
  const getEffect = useCallback(() => effectRef.current, []);
  const setEffect = useCallback((nextEffect) => {
    if (!nextEffect) return;
    effectRef.current = nextEffect;
    repaintRef.current();
  }, []);
  const getPointOverlay = useCallback(
    () => gatedPointOverlay(latestPointsRef.current, revealAtRef),
    [],
  );
  const getHeatmapOpacity = useCallback(() => {
    if (performance.now() < revealAtRef.current) return 0;
    const overlay = latestPointsRef.current;
    if (overlay?.enabled && overlay?.stats?.mode === "points") {
      return 0;
    }
    return latestPackedRef.current?.count > 0 ? 1 : 0;
  }, []);
  const subscribePointOverlay = useCallback((handler) => {
    if (typeof handler !== "function") return NOOP;
    const subscribers = pointSubscribersRef.current;
    subscribers.add(handler);
    handler(gatedPointOverlay(latestPointsRef.current, revealAtRef));
    return () => subscribers.delete(handler);
  }, []);
  const subscribeNetwork = useCallback((handler) => {
    if (typeof handler !== "function") return NOOP;
    const subscribers = networkSubscribersRef.current;
    subscribers.add(handler);
    handler(latestNetworkRef.current);
    return () => subscribers.delete(handler);
  }, []);
  const setCellPosition = useCallback((next) => {
    const normalized = normalizeCellPositionConfig(next);
    workerRef.current?.postMessage({
      type: "SET_CELL_POSITION",
      payload: normalized,
    });
  }, []);
  const setPointOverlayMaxPoints = useCallback((value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    workerRef.current?.postMessage({
      type: "SET_POINT_OVERLAY_MAX_POINTS",
      payload: { value: Math.max(1, Math.floor(n)) },
    });
  }, []);
  const setCubeSubdivisionLimit = useCallback((value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    workerRef.current?.postMessage({
      type: "SET_CUBE_SUBDIVISION_LIMIT",
      payload: { value: Math.max(0, Math.floor(n)) },
    });
  }, []);
  const setRequireCompleteChildren = useCallback((value) => {
    workerRef.current?.postMessage({
      type: "SET_REQUIRE_COMPLETE_CHILDREN",
      payload: { value: value !== false },
    });
  }, []);
  const setPolygonFilterEnabled = useCallback((value) => {
    workerRef.current?.postMessage({
      type: "SET_POLYGON_FILTER_ENABLED",
      payload: { value: value !== false },
    });
  }, []);
  const setValueMetricIndex = useCallback((value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return;
    workerRef.current?.postMessage({
      type: "SET_VALUE_METRIC_INDEX",
      payload: { value: Math.floor(n) },
    });
  }, []);
  const setChildVirtualizationEnabled = useCallback((value) => {
    workerRef.current?.postMessage({
      type: "SET_CHILD_VIRTUALIZATION",
      payload: { value: value !== false },
    });
  }, []);
  // Stable controller object the WebGPU layer reads every frame.
  const controller = useMemo(
    () => ({
      getPackedData,
      getZoom,
      getResolutionConstant,
      getTransitionFactor,
      getNormalizer,
      getEffect,
      setEffect,
      getHeatmapOpacity,
      getPointOverlay,
      subscribePointOverlay,
      subscribeNetwork,
      setCellPosition,
      setPointOverlayMaxPoints,
      setCubeSubdivisionLimit,
      setRequireCompleteChildren,
      setPolygonFilterEnabled,
      setValueMetricIndex,
      setChildVirtualizationEnabled,
      setAlgorithmResolution,
      setNormalizer,
      debugHeatmap: gridOpt?.debugHeatmap === true,
    }),
    [
      getPackedData,
      getZoom,
      getResolutionConstant,
      getTransitionFactor,
      getNormalizer,
      getEffect,
      setEffect,
      getHeatmapOpacity,
      getPointOverlay,
      subscribePointOverlay,
      subscribeNetwork,
      setCellPosition,
      setPointOverlayMaxPoints,
      setCubeSubdivisionLimit,
      setRequireCompleteChildren,
      setPolygonFilterEnabled,
      setValueMetricIndex,
      setChildVirtualizationEnabled,
      setAlgorithmResolution,
      setNormalizer,
      gridOpt?.debugHeatmap,
    ]
  );

  return { controller, handleMapMove, onPolygonLoaded, registerRepaint };
}

function handleWorkerMessage(event, ctx) {
  const { type, payload, buffer, pointsBuffer } = event.data;
  switch (type) {
    case "INIT_COMPLETE":
      break;

    case "PACKED": {
      const isEmptyPack = !(payload.instanceCount > 0 && buffer);
      const now = Date.now();
      const previous = ctx.latestPackedRef.current;
      const hadPrevious = !!previous?.data && previous.count > 0;
      // Hold onto the previous packed snapshot during a fast zoom: while
      // the cube is fetching new LOD tiers the worker briefly emits
      // empty packs, and the WebGPU accum pass clears unconditionally,
      // so adopting them would blank the heatmap for a few frames.
      const withinGrace =
        isEmptyPack && hadPrevious && now < ctx.emptyPackGraceUntilRef.current;

      if (ctx.debugHeatmapRef?.current) {
        if (isEmptyPack && hadPrevious && !withinGrace) {
          console.info("[heatmap-main]", "PACKED adopting empty after grace", {
            snapshotVersion: payload.snapshotVersion,
          });
        }
      }

      if (withinGrace) {
        // Skip writing to latestPackedRef AND skip releasing the
        // previous buffer — we're still rendering it. The worker pool
        // will simply keep using a different ArrayBuffer for its next
        // pack; we'll release on the next non-empty (or grace-expired)
        // PACKED. Stats / points still flow through below so the
        // overlay panel updates.
      } else {
        // Send the previous buffer back so the worker can re-use it for
        // the next pack — keeps the Float32Array pool steady at ~1
        // ArrayBuffer in flight and eliminates per-snapshot allocation.
        const prevBuf = previous?.data?.buffer;
        if (prevBuf && prevBuf.byteLength > 0) {
          ctx.worker.postMessage(
            { type: "RELEASE_PACKED", buffer: prevBuf },
            [prevBuf]
          );
        }

        ctx.latestPackedRef.current = isEmptyPack
          ? {
              count: 0,
              data: null,
              snapshotVersion: payload.snapshotVersion,
            }
          : {
              count: payload.instanceCount,
              data: new Float32Array(buffer),
              snapshotVersion: payload.snapshotVersion,
            };

        if (!isEmptyPack) {
          // Open a fresh grace window now that we have something to
          // hold on to. Don't open one on empty packs — that would let
          // a sequence of empties extend itself indefinitely.
          ctx.emptyPackGraceUntilRef.current = now + EMPTY_PACK_GRACE_MS;
        }
      }

      const normalizer = ctx.normalizerRef.current;
      const dvf = viewportDvfFromPayload(payload);
      const metricTotalCount =
        Number.isFinite(payload.viewportMetricCount) && payload.viewportMetricCount > 0
          ? payload.viewportMetricCount
          : 0;
      const metricSums = Array.isArray(payload.viewportMetricSums)
        ? payload.viewportMetricSums
        : [];
      ctx.latestPointsRef.current =
        payload.showPoints && payload.pointCount > 0 && pointsBuffer
          ? {
              enabled: true,
              points: new Float32Array(pointsBuffer),
              stats: {
                visibleItemCount: payload.visibleItemCount ?? 0,
                threshold: payload.pointThreshold ?? 500,
                renderedZoneCount: payload.instanceCount ?? 0,
                renderedPointCount: payload.pointCount ?? 0,
                mode: "points",
                normalizer,
                colorThreshold: POINT_COLOR_THRESHOLD,
                metricCount:
                  Number.isFinite(payload.metricCount) && payload.metricCount >= 0
                    ? payload.metricCount
                    : 0,
                zoneSubdivisionThreshold:
                  Number.isFinite(payload.zoneSubdivisionThreshold) &&
                  payload.zoneSubdivisionThreshold >= 0
                    ? Math.floor(payload.zoneSubdivisionThreshold)
                    : COLLECTION_DEFAULTS.cubeSubdivisionLimit,
                requireCompleteChildren: payload.requireCompleteChildren !== false,
                childVirtualizationEnabled:
                  payload.childVirtualizationEnabled !== false,
                algorithmResolution:
                  Number.isFinite(payload.algorithmResolution) &&
                  payload.algorithmResolution > 0
                    ? payload.algorithmResolution
                    : ctx.resolutionRef.current,
                polygonFilterEnabled: payload.polygonFilterEnabled !== false,
                valueMetricIndex:
                  Number.isFinite(payload.valueMetricIndex) &&
                  payload.valueMetricIndex >= 0
                    ? Math.floor(payload.valueMetricIndex)
                    : COLLECTION_DEFAULTS.valueMetricIndex,
                metricTotalCount,
                metricSums,
                dvf,
              },
            }
          : {
              enabled: false,
              points: [],
              stats: {
                visibleItemCount: payload.visibleItemCount ?? 0,
                threshold: payload.pointThreshold ?? 500,
                renderedZoneCount: payload.instanceCount ?? 0,
                renderedPointCount: payload.pointCount ?? 0,
                mode: "heatmap",
                normalizer,
                colorThreshold: POINT_COLOR_THRESHOLD,
                metricCount:
                  Number.isFinite(payload.metricCount) && payload.metricCount >= 0
                    ? payload.metricCount
                    : 0,
                zoneSubdivisionThreshold:
                  Number.isFinite(payload.zoneSubdivisionThreshold) &&
                  payload.zoneSubdivisionThreshold >= 0
                    ? Math.floor(payload.zoneSubdivisionThreshold)
                    : COLLECTION_DEFAULTS.cubeSubdivisionLimit,
                requireCompleteChildren: payload.requireCompleteChildren !== false,
                childVirtualizationEnabled:
                  payload.childVirtualizationEnabled !== false,
                algorithmResolution:
                  Number.isFinite(payload.algorithmResolution) &&
                  payload.algorithmResolution > 0
                    ? payload.algorithmResolution
                    : ctx.resolutionRef.current,
                polygonFilterEnabled: payload.polygonFilterEnabled !== false,
                valueMetricIndex:
                  Number.isFinite(payload.valueMetricIndex) &&
                  payload.valueMetricIndex >= 0
                    ? Math.floor(payload.valueMetricIndex)
                    : COLLECTION_DEFAULTS.valueMetricIndex,
                metricTotalCount,
                metricSums,
                dvf,
              },
            };
      if (
        Number.isFinite(payload.algorithmResolution) &&
        payload.algorithmResolution > 0
      ) {
        ctx.resolutionRef.current = Math.floor(payload.algorithmResolution);
      }
      notifyPointSubscribers(ctx, ctx.latestPointsRef.current);

      const hasPackedInstances =
        (payload.instanceCount ?? 0) > 0 && buffer != null;

      if (
        payload.dataDriven &&
        !withinGrace &&
        hasPackedInstances
      ) {
        const snap =
          payload.snapshotVersion !== undefined &&
          payload.snapshotVersion !== null
            ? payload.snapshotVersion
            : -1;
        const tr = ctx.transitionRef.current;
        const restartBlend = !tr.active || tr.snapshotVersion !== snap;
        ctx.transitionRef.current = {
          active: true,
          startedAt: restartBlend ? performance.now() : tr.startedAt,
          snapshotVersion: snap,
        };
        if (restartBlend) {
          ctx.scheduleTransitionRepaint();
        }
      }

      // Always repaint when a new snapshot arrives — even if the GPU mix
      // would collapse to identity, the layer's idle-skip needs to see
      // the new instanceData identity to invalidate.
      ctx.repaintRef.current();
      break;
    }

    case "VIEWPORT_METRICS": {
      const current = ctx.latestPointsRef.current;
      if (!current?.stats) break;
      const metricTotalCount =
        Number.isFinite(payload?.viewportMetricCount) && payload.viewportMetricCount > 0
          ? payload.viewportMetricCount
          : 0;
      const metricSums = Array.isArray(payload?.viewportMetricSums)
        ? payload.viewportMetricSums
        : [];
      const dvf = viewportDvfFromPayload(payload);
      ctx.latestPointsRef.current = {
        ...current,
        stats: {
          ...current.stats,
          metricTotalCount,
          metricSums,
          dvf,
        },
      };
      notifyPointSubscribers(ctx, ctx.latestPointsRef.current);
      break;
    }

    case "PERF_DEBUG":
      // Worker-side perf telemetry to diagnose CPU spikes.
      console.debug("[grid.worker][perf]", payload);
      break;

    case "NETWORK_PEERS": {
      const peers = Array.isArray(payload?.peers) ? payload.peers : [];
      ctx.latestNetworkRef.current = {
        ...ctx.latestNetworkRef.current,
        peers,
        routingKey:
          payload?.routingKey ?? ctx.latestNetworkRef.current?.routingKey ?? null,
      };
      for (const sub of ctx.networkSubscribersRef.current) {
        try {
          sub(ctx.latestNetworkRef.current);
        } catch {
          /* ignore */
        }
      }
      break;
    }

    case "NETWORK_ACTIVITY": {
      ctx.latestNetworkRef.current = {
        ...ctx.latestNetworkRef.current,
        activity: payload || null,
        activityAt: performance.now(),
      };
      for (const sub of ctx.networkSubscribersRef.current) {
        try {
          sub(ctx.latestNetworkRef.current);
        } catch {
          /* ignore */
        }
      }
      break;
    }

    case "ERROR":
      console.error("Worker error:", payload);
      break;

    default:
      console.warn("Unknown message type from worker:", type);
  }
}
