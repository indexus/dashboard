/* eslint-env worker */
/* eslint-disable no-restricted-globals */

// ============================================================================
// Heatmap data plane (worker)
// ============================================================================
//
// The worker owns:
//   - the SDK Grid    — network fetch dispatcher
//   - the SDK Cube    — aggregated cells, display() per zoom
//   - the polygon WASM — Cube uses it to truncate recursion at fully-covered
//                        nodes
//   - the snapshot pair (prev/cur) the GPU should mix between
//   - packing the per-cell attributes into a Float32Array ready for
//     `device.queue.writeBuffer` on the main thread
//
// The main thread owns:
//   - MapLibre (zoom, bounds, repaints)
//   - the WebGPU device + render pipelines + idle-frame fast path
//   - the *timing* of the transition (a RAF-driven 0→1 factor sent as a
//     uniform every frame)
//
// Multi-LOD pack
// --------------
// `cube.display()` always materialises three depth tiers `[d-1, d, d+1]`
// around the live bracket. We pack ALL three; each instance carries its
// own `slotResolution` and the shader weighs it by
// `max(0, 1 - |slotResolution - liveDepth|)`. A small zoom change is
// handled entirely on the GPU (no PACKED round-trip), and a bracket
// crossing dissolves cells smoothly across the boundary instead of
// snapping. The worker only re-emits when bounds shift or the floor of
// the live depth leaves the centre tier.
//
// Parent fallback
// ---------------
// When a natural slot in `[d-1, d, d+1]` is empty (fine data hasn't
// streamed in yet, or doesn't exist near a polygon border), `collectSlot`
// lazily extends `cube.display()` backward via `ensureTier` (one
// retrieve+aggregate per missing depth, on demand only) up to
// PARENT_FALLBACK_DEPTH coarser tiers. The closest non-empty tier's
// cells are substituted into the empty slot — they keep their TRUE
// depth in `xyz.resolution` so the GPU renders the correct large-disk
// size, but are tagged with the empty slot's depth so the LOD kernel
// keeps them visible at the live zoom. Net result: the heatmap stays
// populated instead of punching a hole, even before the fine network
// response lands.
//
// Continuous transitions
// ----------------------
// dataDriven snapshot swaps freeze `previousDisplay` for the duration
// of the eased blend on main (duration in useGridWorker.js). Late network responses during the same
// transition are folded into `currentDisplay` only — the GPU keeps
// tweening prev → cur without restarting its 0→1 factor, so streaming
// bursts produce ONE smooth fade instead of pulsing every batch. New
// cells get fadeIn (prev=0) and gone cells get fadeOut (cur=0) inside
// `packAndEmit` so they actually morph in / out of existence instead
// of popping.
//
// Communication
// -------------
//   main → worker:  INIT, LOAD_POLYGON, MOVE, RELEASE_PACKED, TRANSITION_COMPLETE,
//                    SET_CELL_POSITION, SET_POINT_OVERLAY_MAX_POINTS,
//                    SET_CUBE_SUBDIVISION_LIMIT, SET_REQUIRE_COMPLETE_CHILDREN,
//                    SET_ALGO_RESOLUTION, SET_POLYGON_FILTER_ENABLED,
//                    SET_VALUE_METRIC_INDEX, SET_CHILD_VIRTUALIZATION
//   worker → main:  INIT_COMPLETE, PACKED, VIEWPORT_METRICS, ERROR
//
// PACKED carries the Float32Array as a transferable so we never copy
// the instance data across the bridge. After the GPU upload the main
// thread posts the buffer back via RELEASE_PACKED so the worker can
// re-use it (steady state ≈ 1 ArrayBuffer in flight, no GC pressure).

import { Buffer } from "buffer";

import {
  createCubeRuntime,
  createGridRuntime,
} from "../lib/indexus/runtime";
import { setDebug } from "../js-indexus-sdk/index.js";
import {
  BYTES_PER_INSTANCE,
  FLOATS_PER_INSTANCE,
} from "../visualization/webgpu/constants";

import { createBufferPool } from "./grid/bufferPool";
import { createPolygonWasm } from "./grid/polygonWasm";
import { createStreamCoalescer } from "./grid/streamCoalescer";

self.Buffer = Buffer; // js-indexus-sdk + axios expect a global Buffer

// ----------------------------------------------------------------------------
// Heatmap constants (moved from lib/heatmap)
// ----------------------------------------------------------------------------

const COLLECTION_DEFAULTS = {
  valueMetricIndex: 2,
  latMetricIndex: 3,
  lngMetricIndex: 4,
  metricScale: 1_000_000,
  metricLatOffset: 90,
  metricLngOffset: 180,
  metricMaxIndex: 63,
  normalizer: 10000,
  pointOverlayMaxPoints: 200,
  cubeSubdivisionLimit: 5,
  cubeChildrenThreshold: 4,
  childVirtualizationEnabled: false,
  algorithmResolution: 6,
  parentFallbackDepth: 6,
  heatmapVisualMultiplier: 2.5,
  heatmapVisualAreaMode: 0,
  heatmapVisualCentroidSnap: 0,
  polygonDataFilterEnabled: true,
  polygonVisualFilterEnabled: true,
};

const METRIC_VALEUR_FONCIERE_INDEX = 0;
const METRIC_SURFACE_BATI_INDEX = 1;
const METRIC_SCALE = COLLECTION_DEFAULTS.metricScale;
const LAT_OFFSET = COLLECTION_DEFAULTS.metricLatOffset;
const LNG_OFFSET = COLLECTION_DEFAULTS.metricLngOffset;
const METRIC_MAX_INDEX = COLLECTION_DEFAULTS.metricMaxIndex;

const CELL_POSITION_MODE_BOUNDS = "bounds";
const CELL_POSITION_MODE_METRICS = "metrics";

function normalizeCellPositionConfig(raw) {
  const mode =
    raw?.mode === CELL_POSITION_MODE_BOUNDS
      ? CELL_POSITION_MODE_BOUNDS
      : CELL_POSITION_MODE_METRICS;
  let metricLatIndex = Number(raw?.metricLatIndex);
  let metricLngIndex = Number(raw?.metricLngIndex);
  if (!Number.isFinite(metricLatIndex)) {
    metricLatIndex = COLLECTION_DEFAULTS.latMetricIndex;
  }
  if (!Number.isFinite(metricLngIndex)) {
    metricLngIndex = COLLECTION_DEFAULTS.lngMetricIndex;
  }
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

const SCALED_DETECTION_THRESHOLD = 10_000;

function decodeMetricCentroid(cell, latIdx, lngIdx) {
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

function ensureMetricCentroid(cell, latIdx, lngIdx) {
  if (cell.__lat !== undefined) return true;
  const decoded = decodeMetricCentroid(cell, latIdx, lngIdx);
  if (!decoded) return false;
  cell.__lat = decoded.lat;
  cell.__lng = decoded.lng;
  return true;
}

// ----------------------------------------------------------------------------
// Worker constants
// ----------------------------------------------------------------------------

const BATCH_MIN_CELLS = 64;
const BATCH_FLUSH_MS = 20;
const FLUSH_INTERVAL_MS = 16;
const INGEST_TARGET_BUDGET_MS = 6;
const INGEST_MIN_CELLS_PER_TICK = 256;
const INGEST_MAX_CELLS_PER_TICK = 12000;
const INGEST_INITIAL_CELLS_PER_TICK = 2500;
const MOVE_INTERACTION_SUPPRESS_MS = 120;
/** Debounce after MOVE settle / finish before Abelian reconcile. */
const RECONCILE_DEBOUNCE_MS = 1000;
/**
 * Quiet period after a reconcile/repair finishes before the next idle repair.
 * Measured from completion (not from start), so a long repair never overlaps
 * the next tick.
 */
const RECONCILE_IDLE_MS = 10000;
const EMPTY_PACK_HOLD_MS = 1800;
const PERF_SPIKE_THRESHOLD_MS = 22;
const PERF_SNAPSHOT_MS = 2000;
const DEFAULT_POINT_OVERLAY_MAX_POINTS = COLLECTION_DEFAULTS.pointOverlayMaxPoints;
const DEFAULT_CUBE_SUBDIVISION_LIMIT = COLLECTION_DEFAULTS.cubeSubdivisionLimit;
const DEFAULT_CUBE_CHILDREN_THRESHOLD = COLLECTION_DEFAULTS.cubeChildrenThreshold;
const DEFAULT_ALGO_RESOLUTION = COLLECTION_DEFAULTS.algorithmResolution;
const DEFAULT_CHILD_VIRTUALIZATION_ENABLED =
  COLLECTION_DEFAULTS.childVirtualizationEnabled !== false;
const VIEWPORT_METRICS_DEBOUNCE_MS = 90;
const MAX_VIRTUAL_CHILD_DEPTH_DELTA = 4;
const MAX_VIRTUAL_CELLS_PER_SLOT = 20000;
const MAX_VIRTUAL_ITEMS_PER_CELL = 50000;

// Monitoring callback the Grid SDK can call.
const NOOP_MONITORING = { send: () => {} };

/**
 * Session seed that decides which node the SDK sticks to for reads.
 * @param {{ routingKeyHash?: () => string }} net
 * @returns {string|null}
 */
function readRoutingKey(net) {
  if (typeof net?.routingKeyHash !== "function") return null;
  try {
    return net.routingKeyHash();
  } catch {
    return null;
  }
}

const packedPool = createBufferPool(BYTES_PER_INSTANCE);

// Reconstruct SDK Segment objects from the JSON-friendly bounds shape main
// posts over postMessage. The SDK strips prototype methods through
// structuredClone, so we always recreate them via the worker-local Space.
function deserializeBounds(serializedBounds, space) {
  return serializedBounds.map(({ dimension, segment }) =>
    space.dimension(dimension).newSegment(segment)
  );
}

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------

let grid = null;
let cube = null;
let cubeSpace = null;
let cubeResolution = 0;
let polygonWasm = null;
let pointOverlayConfig = {
  maxPoints: DEFAULT_POINT_OVERLAY_MAX_POINTS,
};
let lastKnownMetricCount = 0;
let cubeSubdivisionLimit = DEFAULT_CUBE_SUBDIVISION_LIMIT;
let cubeChildrenThreshold = DEFAULT_CUBE_CHILDREN_THRESHOLD;
let requireCompleteChildren = true;
let childVirtualizationEnabled = DEFAULT_CHILD_VIRTUALIZATION_ENABLED;
let algorithmResolution = DEFAULT_ALGO_RESOLUTION;
let polygonFilterEnabled = true;
let valueMetricIndex = COLLECTION_DEFAULTS.valueMetricIndex;

// How each cell's anchor lat/lng is chosen before packing (see metrics.js).
let cellPositionMode = CELL_POSITION_MODE_METRICS;
let cellPositionMetricLatIndex = COLLECTION_DEFAULTS.latMetricIndex;
let cellPositionMetricLngIndex = COLLECTION_DEFAULTS.lngMetricIndex;
// Bumped when the positioning mode flips so cached __lat/__lng on cells
// are recomputed on the next pack.
let positionStyleEpoch = 0;
// Last pack that wrote `positionStyleEpoch` into the outgoing buffer.
// `cube.display()` often returns the same ref when only this style changes,
// so `flushAndPack` uses this to decide it must still call `packAndEmit`.
let lastPackedPositionStyleEpoch = -1;

// Buffered MOVE that arrived while INIT was still awaiting its WASM init.
// Replayed at the end of INIT so the user's first viewport isn't dropped.
let pendingMove = null;

// Snapshot bookkeeping. Mirrors what App.js used to track on main.
let dataVersion = 0;             // bumped on every cube.set()
let displayedDataVersion = 0;    // dataVersion captured by the latest cube.display()
let lastTransitionDataVersion = 0; // dataVersion at the start of the active transition
let displaySnapshotVersion = 0;  // bumped each time cube.display() returns a new ref

let currentDisplay = null;
let previousDisplay = null;
let currentDisplayBounds = null; // Bounds the snapshot was originally
let previousDisplayBounds = null; // built with — needed by ensureTier so
                                  // lazy fallback walks aggregate against
                                  // the SAME viewport the snapshot was for.
let transitionActive = false;

let lastZoom = null;
let lastBoundsSerialized = null;
let lastStrictBoundsSerialized = null;

let viewportMetricsTimer = null;
let pendingViewportMetrics = null; // { zoom, key }
let viewportMetricsState = {
  key: "",
  totalCount: 0,
  metricSums: [],
  viewportDvf: {
    transactions: 0,
    avgValeurFonciere: null,
    avgSurfaceM2: null,
    avgEuroM2: null,
  },
};

// Caches keyed by depth — one entry per tier in the 3-depth band, all
// invalidated together when cube.display() returns a new ref. Empty
// tiers are NOT cached: a later ensureTier() may lazily fill them in
// during a parent-fallback walk and the next read must see the new
// data, not a stale empty cache hit.
const cellsByDepth = new Map();
const transitionCellsByDepth = new Map();
const parentByCell = new Map();          // Map<childDepth, WeakMap<cell, parent>>
const transitionParentByCell = new Map();

// Two flush paths into `flushAndPack`:
//
//   - DEFERRED (16 ms trailing-edge): used for stream-batch updates.
//     Coalesces a burst of cube.set() calls into ONE display change so
//     main receives one PACKED with `dataDriven: true` per ~frame
//     instead of resetting the GPU's transitionFactor on every batch.
//
//   - IMMEDIATE (next event-loop tick): used for MOVE / viewport changes
//     and INIT replay. The pack MUST catch up to the live camera as
//     fast as possible — otherwise main keeps rendering the previous
//     pack (cells at the old bracket's resolution and lat-lng grid)
//     under the new camera matrix and the user sees a one-frame flash
//     of "previous-zoom cells" before the new pack arrives.
//
// `flushTimer` is shared: an immediate request cancels a pending
// deferred timer; a deferred request is a no-op if any timer is
// already pending.
let flushTimer = null;
let ingestTimer = null;
let emptyPackHoldTimer = null;
let lastMoveAtMs = 0;
let lastNonEmptyPackAtMs = 0;
let reconcileDebounceTimer = null;
let reconcileIdleTimer = null;
let reconcileInFlight = false;
/** Coalesce: at most one follow-up run after the in-flight reconcile. */
let reconcilePendingForce = null;
/** True while the repair pass is driving its own viewport re-drill. */
let redrillInFlight = false;
const pendingIngest = new Map();
let ingestCellsPerTick = INGEST_INITIAL_CELLS_PER_TICK;
let perfDebugEnabled = true;
let perfSpikeThresholdMs = PERF_SPIKE_THRESHOLD_MS;
let perfSnapshotMs = PERF_SNAPSHOT_MS;
let perfSnapshotTimer = null;
/** Verbose heatmap pipeline logs (`INIT.payload.debugHeatmap`). */
let heatmapDebugEnabled = false;
let lastHeatmapEmptyEmitLogMs = 0;

function heatmapDebugLog(...args) {
  if (!heatmapDebugEnabled) return;
  console.info("[heatmap-worker]", ...args);
}

/** Empty-pack emits can repeat every retry frame — rate-limit logs. */
function heatmapDebugLogEmptyPack(details) {
  if (!heatmapDebugEnabled) return;
  const t = nowMs();
  if (t - lastHeatmapEmptyEmitLogMs < 400) return;
  lastHeatmapEmptyEmitLogMs = t;
  console.info("[heatmap-worker]", "emit PACKED empty (throttled)", details);
}

const perfStats = {
  ingestTicks: 0,
  ingestMsTotal: 0,
  ingestMsMax: 0,
  ingestCellsTotal: 0,
  flushCalls: 0,
  flushMsTotal: 0,
  flushMsMax: 0,
  moveCalls: 0,
  moveMsTotal: 0,
  moveMsMax: 0,
};

const stream = createStreamCoalescer({
  minBatch: BATCH_MIN_CELLS,
  flushMs: BATCH_FLUSH_MS,
  applyBatch: applyStreamBatch,
});

// Reusable scratch arrays for `collectCells`. Held at module scope so a
// stable cell count produces zero new array allocations per pack —
// only the parallel `slotResolutions` side grows alongside `cells`.
// Both are truncated (length = 0) at the start of each call rather
// than reallocated; V8 keeps the underlying capacity. The packed
// Float32Array is the only sized output that crosses the postMessage
// boundary, so leaking these arrays inside the worker is fine.
const scratchCells = [];
const scratchSlotResolutions = [];

// ----------------------------------------------------------------------------
// Polygon
// ----------------------------------------------------------------------------

const isCellCoveredByPolygon = (cell) =>
  polygonFilterEnabled && polygonWasm ? polygonWasm.isCovered(cell) : false;

function loadPolygon(geojson) {
  if (!polygonWasm) return false;
  if (!polygonWasm.loadGeojson(geojson)) return false;
  // Polygon now in effect → cube.display() may truncate recursion at
  // covered nodes. Force the next display() to recompute.
  if (cube) cube.current = {};
  requestImmediateFlush();
  return true;
}

// ----------------------------------------------------------------------------
// Stream batches
// ----------------------------------------------------------------------------

function applyStreamBatch(elements) {
  if (!cube) return;

  for (let i = 0; i < elements.length; i++) {
    const normalized = normalizeCubeElement(elements[i]);
    if (!normalized) continue;
    const key = cubeElementKey(normalized);
    pendingIngest.set(key, normalized);
  }

  scheduleIngest();
}

function normalizeCubeElement(element) {
  if (!element) return null;
  if (element.xyz && element.bounds) {
    if (!Array.isArray(element.children)) element.children = [];
    return element;
  }
  if (!element._xyz || !element._bounds) return null;
  return cube.create(
    element._xyz,
    element._bounds,
    element._count,
    element._metrics,
    element._items,
    []
  );
}

function cubeElementKey(element) {
  const xyz = element.xyz;
  let key = `${xyz.resolution}`;
  const coords = xyz.coordinates;
  for (let i = 0; i < coords.length; i++) {
    key += `-${coords[i]}`;
  }
  return key;
}

function nowMs() {
  if (typeof performance !== "undefined" && performance.now) {
    return performance.now();
  }
  return Date.now();
}

function perfRecord(label, elapsedMs, extra = undefined) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;

  switch (label) {
    case "ingestTick":
      perfStats.ingestTicks += 1;
      perfStats.ingestMsTotal += elapsedMs;
      perfStats.ingestMsMax = Math.max(perfStats.ingestMsMax, elapsedMs);
      if (extra && Number.isFinite(extra.processed)) {
        perfStats.ingestCellsTotal += extra.processed;
      }
      break;
    case "flushAndPack":
      perfStats.flushCalls += 1;
      perfStats.flushMsTotal += elapsedMs;
      perfStats.flushMsMax = Math.max(perfStats.flushMsMax, elapsedMs);
      break;
    case "handleMove":
      perfStats.moveCalls += 1;
      perfStats.moveMsTotal += elapsedMs;
      perfStats.moveMsMax = Math.max(perfStats.moveMsMax, elapsedMs);
      break;
    default:
      break;
  }

  if (perfDebugEnabled && elapsedMs >= perfSpikeThresholdMs) {
    self.postMessage({
      type: "PERF_DEBUG",
      payload: {
        kind: "spike",
        label,
        elapsedMs,
        pendingIngest: pendingIngest.size,
        ingestCellsPerTick,
        ...(extra || {}),
      },
    });
  }
}

function emitPerfSnapshot() {
  if (!perfDebugEnabled) return;
  const avg = (total, count) => (count > 0 ? total / count : 0);
  self.postMessage({
    type: "PERF_DEBUG",
    payload: {
      kind: "snapshot",
      pendingIngest: pendingIngest.size,
      ingestCellsPerTick,
      ingest: {
        ticks: perfStats.ingestTicks,
        avgMs: avg(perfStats.ingestMsTotal, perfStats.ingestTicks),
        maxMs: perfStats.ingestMsMax,
        totalCells: perfStats.ingestCellsTotal,
      },
      flush: {
        calls: perfStats.flushCalls,
        avgMs: avg(perfStats.flushMsTotal, perfStats.flushCalls),
        maxMs: perfStats.flushMsMax,
      },
      move: {
        calls: perfStats.moveCalls,
        avgMs: avg(perfStats.moveMsTotal, perfStats.moveCalls),
        maxMs: perfStats.moveMsMax,
      },
    },
  });
}

function schedulePerfSnapshot() {
  if (!perfDebugEnabled || perfSnapshotTimer != null) return;
  perfSnapshotTimer = setTimeout(() => {
    perfSnapshotTimer = null;
    emitPerfSnapshot();
    schedulePerfSnapshot();
  }, perfSnapshotMs);
}

function stopPerfSnapshot() {
  if (perfSnapshotTimer != null) {
    clearTimeout(perfSnapshotTimer);
    perfSnapshotTimer = null;
  }
}

function resetPerfStats() {
  perfStats.ingestTicks = 0;
  perfStats.ingestMsTotal = 0;
  perfStats.ingestMsMax = 0;
  perfStats.ingestCellsTotal = 0;
  perfStats.flushCalls = 0;
  perfStats.flushMsTotal = 0;
  perfStats.flushMsMax = 0;
  perfStats.moveCalls = 0;
  perfStats.moveMsTotal = 0;
  perfStats.moveMsMax = 0;
}

function tuneIngestChunk(elapsedMs, processedCells) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || processedCells <= 0) return;

  const ratio = INGEST_TARGET_BUDGET_MS / elapsedMs;
  let next = ingestCellsPerTick;

  // Clamp adaptation speed to avoid oscillation.
  if (ratio < 0.9) {
    next = Math.floor(ingestCellsPerTick * Math.max(0.7, ratio));
  } else if (ratio > 1.2) {
    next = Math.ceil(ingestCellsPerTick * Math.min(1.35, ratio));
  } else {
    return;
  }

  ingestCellsPerTick = Math.max(
    INGEST_MIN_CELLS_PER_TICK,
    Math.min(INGEST_MAX_CELLS_PER_TICK, next)
  );
}

function scheduleIngest() {
  if (ingestTimer != null) return;
  ingestTimer = setTimeout(() => {
    ingestTimer = null;
    ingestTick();
  }, 0);
}

function ingestTick() {
  if (!cube || pendingIngest.size === 0) return;
  const start = nowMs();
  const dynamicChunk = Math.max(
    INGEST_MIN_CELLS_PER_TICK,
    Math.min(INGEST_MAX_CELLS_PER_TICK, Math.floor(ingestCellsPerTick))
  );
  const batchSize = Math.min(dynamicChunk, pendingIngest.size);
  const batch = new Array(batchSize);
  let write = 0;

  for (const [key, value] of pendingIngest) {
    batch[write] = value;
    write += 1;
    pendingIngest.delete(key);
    if (write >= batchSize) break;
  }

  if (write > 0) {
    if (write < batch.length) batch.length = write;
    cube.set(batch);
    dataVersion += 1;
    // New cube mutations must refresh packs immediately. Deferring via
    // requestDataDrivenFlush + MOVE_INTERACTION_SUPPRESS_MS caused visible
    // "nothing until I stop moving": the MOVE flush often ran before this
    // ingest completed, then fresh cells waited ~120ms for the deferred path.
    requestImmediateFlush();
    const elapsed = nowMs() - start;
    tuneIngestChunk(elapsed, write);
    perfRecord("ingestTick", elapsed, {
      processed: write,
      chunk: dynamicChunk,
      pendingAfter: pendingIngest.size,
    });
  }

  if (pendingIngest.size > 0) {
    scheduleIngest();
  }
}

function resetIngestQueue() {
  if (ingestTimer != null) {
    clearTimeout(ingestTimer);
    ingestTimer = null;
  }
  pendingIngest.clear();
  ingestCellsPerTick = INGEST_INITIAL_CELLS_PER_TICK;
  lastNonEmptyPackAtMs = 0;
  resetPerfStats();
  if (emptyPackHoldTimer != null) {
    clearTimeout(emptyPackHoldTimer);
    emptyPackHoldTimer = null;
  }
}

function stopReconcileTimers() {
  redrillInFlight = false;
  if (reconcileDebounceTimer != null) {
    clearTimeout(reconcileDebounceTimer);
    reconcileDebounceTimer = null;
  }
  if (reconcileIdleTimer != null) {
    clearTimeout(reconcileIdleTimer);
    reconcileIdleTimer = null;
  }
}

function scheduleReconcileDebounced() {
  // A drill the repair itself started is not user movement: re-arming the
  // short debounce here is what turned one repair into a permanent one.
  if (redrillInFlight) {
    scheduleReconcileIdle();
    return;
  }
  // Debounced MOVE repair supersedes any pending idle tick.
  if (reconcileIdleTimer != null) {
    clearTimeout(reconcileIdleTimer);
    reconcileIdleTimer = null;
  }
  if (reconcileDebounceTimer != null) clearTimeout(reconcileDebounceTimer);
  reconcileDebounceTimer = setTimeout(() => {
    reconcileDebounceTimer = null;
    void runReconcile(false);
  }, RECONCILE_DEBOUNCE_MS);
}

/** Arm the next idle repair for RECONCILE_IDLE_MS after now (post-completion). */
function scheduleReconcileIdle() {
  if (reconcileIdleTimer != null) {
    clearTimeout(reconcileIdleTimer);
    reconcileIdleTimer = null;
  }
  reconcileIdleTimer = setTimeout(() => {
    reconcileIdleTimer = null;
    void runReconcile(false);
  }, RECONCILE_IDLE_MS);
}

/**
 * @param {boolean} force — skip MOVE-debounce gate (RECONCILE message).
 */
async function runReconcile(force = false) {
  if (!grid || !cube) return;
  if (reconcileInFlight) {
    // One refresh at a time — keep a single follow-up (prefer forced).
    if (reconcilePendingForce === null || force) {
      reconcilePendingForce = force;
    }
    return;
  }
  if (!force && nowMs() - lastMoveAtMs < RECONCILE_DEBOUNCE_MS) {
    // Camera still settling — retry after the idle gap from now.
    scheduleReconcileIdle();
    return;
  }
  if (lastZoom == null || !lastBoundsSerialized) {
    scheduleReconcileIdle();
    return;
  }

  // This run owns the idle schedule; re-arm only after it finishes.
  if (reconcileIdleTimer != null) {
    clearTimeout(reconcileIdleTimer);
    reconcileIdleTimer = null;
  }

  reconcileInFlight = true;
  reconcilePendingForce = null;
  try {
    const bounds = deserializeBounds(lastBoundsSerialized, grid.space);
    const result = await grid.reconcileVisible(lastZoom, bounds, cube);
    if (result?.dirty > 0) {
      dataVersion += 1;
      // The re-drill re-reads the whole viewport, and its `finish` arms another
      // repair. Branches replaced without moving the visible total are the
      // pruned deep tiers the display band drops anyway, so re-drilling them
      // only feeds the next pass the same work.
      if (result.rootAfter !== result.rootBefore) {
        // replaceBranch may have swapped a shallow shadow — force a full
        // viewport drill so the cube re-descends to zoom+resolution.
        redrillInFlight = true;
        try {
          await grid.move(lastZoom, bounds, { force: true });
        } catch (moveErr) {
          console.warn(
            "[aggregate.refresh] post-reconcile redrill failed:",
            moveErr
          );
        } finally {
          redrillInFlight = false;
        }
      }
    }
    // Drop cells finer than the Aggregate display band (z-1..z+1).
    const pruned = pruneCubePastViewportLod();
    if (result?.dirty > 0 || pruned > 0) {
      // Force metrics recompute on next pack even if camera key is unchanged.
      viewportMetricsState = {
        key: "",
        totalCount: 0,
        metricSums: [],
        viewportDvf: viewportDvfFromMetricSums(0, []),
      };
      requestImmediateFlush();
    }
  } catch (error) {
    console.warn("[aggregate.refresh] reconcile failed:", error);
  } finally {
    reconcileInFlight = false;
    const pending = reconcilePendingForce;
    reconcilePendingForce = null;
    if (pending !== null) {
      // Follow-up runs now; it will arm idle when *it* finishes.
      void runReconcile(pending);
    } else {
      // 10s quiet after this repair completed (even if it ran long).
      scheduleReconcileIdle();
    }
  }
}

/** Keep at most display tiers z-1..z+1 (z = floor(zoom + algoRes)). */
function pruneCubePastViewportLod() {
  if (!cube || lastZoom == null) return 0;
  const z = Math.floor(lastZoom + algorithmResolution);
  return cube.pruneDeeperThan(z + 1);
}

// ----------------------------------------------------------------------------
// Flush scheduling
// ----------------------------------------------------------------------------

function requestImmediateFlush() {
  // Cancel any pending deferred timer — a camera change supersedes a
  // pending stream-data flush so the user-visible matrix and the packed
  // buffer agree as soon as possible.
  if (flushTimer != null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAndPack();
  }, 0);
}

function requestDeferredFlush() {
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAndPack();
  }, FLUSH_INTERVAL_MS);
}

function scheduleEmptyPackRetry() {
  if (emptyPackHoldTimer != null) return;
  emptyPackHoldTimer = setTimeout(() => {
    emptyPackHoldTimer = null;
    requestDeferredFlush();
  }, Math.max(16, FLUSH_INTERVAL_MS));
}

function normalizePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

/** Cube visual `options.limit` (seuil zones): 0 = ne jamais s'arrêter sur le seuil de count seul. */
function normalizeCubeSubdivisionLimit(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function normalizeMetricIndex(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function applyCubeChildrenRequirement() {
  if (!cube?.options) return;
  cube.options.children = requireCompleteChildren
    ? cubeChildrenThreshold
    : 1;
}

function applyAlgorithmResolution(next) {
  algorithmResolution = normalizePositiveInt(next, algorithmResolution);
  if (cube?.options) cube.options.resolution = algorithmResolution;
  if (grid?.options) grid.options.resolution = algorithmResolution;
  cubeResolution = algorithmResolution;
}

// ----------------------------------------------------------------------------
// Display + transition orchestration
// ----------------------------------------------------------------------------

// Lazily materialises a single depth tier on the given display dict.
//
// Eager pre-extension was tempting but pays for tiers we usually never
// read — the natural slots `[d-1, d, d+1]` are populated in the steady
// state, so the typical flush needs ZERO extra retrieve calls. We only
// walk a coarser tier when an empty slot triggers the fallback walk
// inside `collectSlot`.
//
// Mutating the dict means subsequent flushes that hit cube.display()'s
// internal cache (same viewport hash) keep the work — extensions
// accumulate across frames until cube.current is reset (new data
// arrived) or the camera leaves the bracket.
function ensureTier(display, displayBounds, depth) {
  if (!display || !cube || !displayBounds) return null;
  if (depth < 0) return null;
  if (display[depth]) return display[depth];

  const raw = cube.retrieve(depth, displayBounds, cube.root, false);
  const aggregated = cube.aggregate(raw);
  const tier = { raw, aggregated };
  display[depth] = tier;
  // The merged caches may have memoised the previously-empty result for
  // this depth (the natural slot returned [] from cube.display() before
  // we filled it). Drop the entry so the next read sees the new tier.
  cellsByDepth.delete(depth);
  transitionCellsByDepth.delete(depth);
  return tier;
}

function flushAndPack() {
  const start = nowMs();
  if (!cube || !cube.get(cube.root)) {
    heatmapDebugLog("flushAndPack skipped", "no-cube-root");
    perfRecord("flushAndPack", nowMs() - start, { skipped: "no-cube-root" });
    return;
  }
  if (lastZoom == null || !lastBoundsSerialized) {
    heatmapDebugLog("flushAndPack skipped", "no-view");
    perfRecord("flushAndPack", nowMs() - start, { skipped: "no-view" });
    return;
  }

  // Cube.display() caches by hash (zoom/bounds center/depth). If data
  // arrived but viewport is unchanged the hash is the same and display()
  // would return its cached result; force a recompute so the new data
  // shows up.
  const incomingDataVersion = dataVersion;
  if (incomingDataVersion > displayedDataVersion) {
    cube.current = {};
    displayedDataVersion = incomingDataVersion;
  }

  const previous = currentDisplay;
  const previousBounds = currentDisplayBounds;
  const bounds = deserializeBounds(lastBoundsSerialized, cubeSpace);
  const next = cube.display(lastZoom, bounds);

  const displayChanged = previous && next && previous !== next;
  const positionStyleNeedsPack =
    positionStyleEpoch !== lastPackedPositionStyleEpoch;
  if (!previous || displayChanged) {
    currentDisplay = next;
    currentDisplayBounds = bounds;
    if (displayChanged) {
      displaySnapshotVersion += 1;
      cellsByDepth.clear();
      parentByCell.clear();
    }
  }

  if (!displayChanged && previous && !positionStyleNeedsPack) {
    heatmapDebugLog("flushAndPack skipped", "display-unchanged", {
      zoom: lastZoom,
      pendingIngest: pendingIngest.size,
      transitionActive,
    });
    perfRecord("flushAndPack", nowMs() - start, { skipped: "display-unchanged" });
    return; // Display + position style unchanged → skip pack.
  }

  // Continuous-transition rule — see TRANSITION_DURATION_MS on main for timing.
  //
  // • Data-ingest freezes `previousDisplay` once; subsequent batches in the same
  //   stream keep RAF factor ticking (PACKED.dataDriven=false).
  //
  // • LOD bracket crosses `floor(zoom + resolutionConstant)` do NOT start a
  //   snapshot blend: ACCUM_SHADER already uses float `liveDepth` and packs
  //   three tiers so zoom stays smooth without resetting transitionFactor on
  //   each integer hop (regresses "restart from whole zoom" feel).
  //
  // • Pure viewport/LOD geometry updates: swap packs immediately; only real
  //   `dataVersion` changes trigger prev/cur snapshot cross-fade.
  const dataDrivenChange =
    displayChanged && incomingDataVersion > lastTransitionDataVersion;
  let dataDrivenForEmit = false;

  if (transitionActive && previousDisplay) {
    transitionCellsByDepth.clear();
    transitionParentByCell.clear();
  } else if (dataDrivenChange) {
    previousDisplay = previous;
    previousDisplayBounds = previousBounds;
    transitionCellsByDepth.clear();
    transitionParentByCell.clear();
    lastTransitionDataVersion = incomingDataVersion;
    transitionActive = true;
    dataDrivenForEmit = true;
  } else if (displayChanged) {
    previousDisplay = null;
    previousDisplayBounds = null;
    transitionCellsByDepth.clear();
    transitionParentByCell.clear();
    transitionActive = false;
  }

  packAndEmit(dataDrivenForEmit);

  perfRecord("flushAndPack", nowMs() - start, {
    displayChanged: !!displayChanged,
    dataDrivenForEmit,
  });
}

// ----------------------------------------------------------------------------
// Cell collection (multi-LOD + parent fallback)
// ----------------------------------------------------------------------------

const liveDepth = (zoom) => Math.floor(zoom + cubeResolution);

// Populates `scratchCells` + `scratchSlotResolutions` with the cells
// that should be packed for this zoom. Output shape: parallel arrays
// where `scratchCells[i]` is the aggregated cell (or transition wrapper)
// and `scratchSlotResolutions[i]` is the LOD slot it occupies in the
// pack — different from `cells[i].xyz.resolution` only for parent
// fallback substitutions.
function collectCells(zoom) {
  scratchCells.length = 0;
  scratchSlotResolutions.length = 0;
  if (!currentDisplay) return;

  const center = liveDepth(zoom);
  const isTransitioning = transitionActive && !!previousDisplay;
  const minDepth = Math.max(
    0,
    center - COLLECTION_DEFAULTS.parentFallbackDepth
  );

  for (let slot = center - 1; slot <= center + 1; slot++) {
    collectSlot(slot, minDepth, isTransitioning);
  }
}

function collectElementItems(element, out, budget) {
  if (!element || !Array.isArray(out) || budget.remaining <= 0) return;
  const direct = element.items;
  if (Array.isArray(direct) && direct.length > 0) {
    for (let i = 0; i < direct.length; i++) {
      if (budget.remaining <= 0) return;
      const item = direct[i];
      if (!item) continue;
      if (Array.isArray(item._items) && item._items.length > 0) {
        collectElementItems({ items: item._items }, out, budget);
        continue;
      }
      out.push(item);
      budget.remaining -= 1;
    }
    return;
  }
  const children = element.children;
  if (!Array.isArray(children) || children.length === 0) return;
  for (let i = 0; i < children.length; i++) {
    if (budget.remaining <= 0) return;
    const child = cube.get(children[i]);
    if (!child) continue;
    collectElementItems(child, out, budget);
  }
}

function buildVirtualChildrenFromItems(parent) {
  if (!cube || !cubeSpace) return null;
  const xyz = parent?.xyz;
  if (!xyz) return null;
  const childXyzList = cube.children(xyz);
  if (!Array.isArray(childXyzList) || childXyzList.length === 0) return null;

  const items = [];
  collectElementItems(
    parent,
    items,
    { remaining: MAX_VIRTUAL_ITEMS_PER_CELL }
  );
  if (items.length === 0) return null;

  const childByKey = new Map();
  for (let i = 0; i < childXyzList.length; i++) {
    const childXyz = childXyzList[i];
    const metricsLen = Array.isArray(parent.metrics) ? parent.metrics.length : 0;
    childByKey.set(cube.key(childXyz), {
      xyz: childXyz,
      bounds: cubeSpace.bounds(childXyz),
      count: 0,
      metrics: Array(metricsLen).fill(0),
      items: [],
      children: [],
      __virtual: true,
      __virtualParent: parent,
    });
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const targetResolution = Number(childXyzList[0]?.resolution);
    let target = null;
    if (Number.isFinite(targetResolution)) {
      let itemXyz = item._xyz;
      if (!itemXyz && item._hash && typeof cubeSpace.xyz === "function") {
        itemXyz = cubeSpace.xyz(item._hash);
      }
      const itemResolution = Number(itemXyz?.resolution);
      const itemCoordinates = Array.isArray(itemXyz?.coordinates)
        ? itemXyz.coordinates
        : null;
      if (
        Number.isFinite(itemResolution) &&
        itemCoordinates &&
        itemResolution >= targetResolution
      ) {
        const shift = Math.floor(itemResolution - targetResolution);
        const scale = 2 ** shift;
        if (Number.isFinite(scale) && scale > 0) {
          const projectedChildXyz = {
            resolution: targetResolution,
            coordinates: itemCoordinates.map((coord) =>
              Math.floor(Number(coord) / scale)
            ),
          };
          target = childByKey.get(cube.key(projectedChildXyz)) || null;
        }
      }
    }
    if (!target) {
      const itemBounds =
        item._bounds || (item._hash ? cubeSpace.decode(item._hash) : null);
      if (!itemBounds) continue;
      for (let j = 0; j < childXyzList.length; j++) {
        const child = childByKey.get(cube.key(childXyzList[j]));
        if (!child) continue;
        const { overlap } = cubeSpace.overlap(child.bounds, itemBounds);
        if (!overlap) continue;
        target = child;
        break;
      }
    }
    if (!target) continue;

    const weight =
      Number.isFinite(item._count) && item._count > 0 ? item._count : 1;
    target.count += weight;
    target.items.push(item);
    const itemMetrics = Array.isArray(item._metrics)
      ? item._metrics
      : Array.isArray(item.metrics)
        ? item.metrics
        : null;
    if (!itemMetrics) continue;
    if (itemMetrics.length > target.metrics.length) {
      const prevLen = target.metrics.length;
      target.metrics.length = itemMetrics.length;
      for (let k = prevLen; k < itemMetrics.length; k++) target.metrics[k] = 0;
    }
    for (let k = 0; k < itemMetrics.length; k++) {
      const value = itemMetrics[k];
      if (Number.isFinite(value)) target.metrics[k] += value * weight;
    }
  }

  const children = [];
  for (const child of childByKey.values()) {
    if (child.count > 0) children.push(child);
  }
  return children.length > 0 ? children : null;
}

function virtualizeElementsToSlotFromItems(sourceElements, slotDepth) {
  if (!Array.isArray(sourceElements) || sourceElements.length === 0) return [];
  const out = [];
  for (let i = 0; i < sourceElements.length; i++) {
    const root = sourceElements[i];
    const rootDepth = Number(root?.xyz?.resolution);
    if (!Number.isFinite(rootDepth)) continue;
    const delta = slotDepth - rootDepth;
    if (delta <= 0) {
      out.push(root);
      if (out.length >= MAX_VIRTUAL_CELLS_PER_SLOT) return [];
      continue;
    }
    if (delta > MAX_VIRTUAL_CHILD_DEPTH_DELTA) continue;

    let layer = [root];
    let failed = false;
    for (let step = 0; step < delta; step++) {
      const next = [];
      for (let j = 0; j < layer.length; j++) {
        const children = buildVirtualChildrenFromItems(layer[j]);
        if (!children || children.length === 0) continue;
        for (let k = 0; k < children.length; k++) {
          next.push(children[k]);
          if (next.length >= MAX_VIRTUAL_CELLS_PER_SLOT) {
            failed = true;
            break;
          }
        }
        if (failed) break;
      }
      if (failed || next.length === 0) {
        layer = [];
        break;
      }
      layer = next;
    }
    if (failed || layer.length === 0) continue;
    for (let j = 0; j < layer.length; j++) {
      out.push(layer[j]);
      if (out.length >= MAX_VIRTUAL_CELLS_PER_SLOT) return [];
    }
  }
  return out;
}

function virtualizeTierFromItemsToSlot(depth, slotDepth) {
  if (!currentDisplay) return [];
  const tier = currentDisplay[depth];
  const fallbackRaw = Array.isArray(tier?.raw) ? tier.raw : [];
  if (fallbackRaw.length === 0) return [];

  let out = virtualizeElementsToSlotFromItems(fallbackRaw, slotDepth);
  // Visual `retrieve` respects `options.limit` and stops coarse parents early — item
  // detail needed for synthetic children often sits deeper. Retry with purpose "items"
  // only when virtualization is enabled and the visual tier produced nothing usable.
  if (
    out.length === 0 &&
    childVirtualizationEnabled &&
    cube &&
    currentDisplayBounds
  ) {
    try {
      const itemsRaw = cube.retrieve(
        depth,
        currentDisplayBounds,
        cube.root,
        false,
        "items"
      );
      if (Array.isArray(itemsRaw) && itemsRaw.length > 0) {
        out = virtualizeElementsToSlotFromItems(itemsRaw, slotDepth);
      }
    } catch (_) {}
  }
  return out;
}

// Appends cells at the given LOD slot. Walks natural depth first, then
// coarser tiers (down to `minDepth`) until a non-empty one is found.
// Each appended cell is paired with `slotResolution = slot` so the
// shader's LOD kernel keeps it visible at the live zoom regardless of
// the cell's TRUE depth.
//
// The fallback walk lazily materialises coarser tiers via ensureTier
// — cube.display() only populates the natural [d-1, d, d+1] band, so
// any depth below that needs a one-off cube.retrieve. We only pay
// that cost when a slot is empty (typical steady state: zero extra
// retrieves), and the result is mutated onto the snapshot dict so
// subsequent flushes that hit cube.display()'s viewport cache reuse
// the work.
function collectSlot(slot, minDepth, isTransitioning) {
  const effectiveChildVirtualization =
    childVirtualizationEnabled || cubeSubdivisionLimit <= 1;
  for (let d = slot; d >= minDepth; d--) {
    if (d < slot) {
      // Below the natural band: ensure the tier exists on the same
      // dict the snapshot was built on, with the SAME bounds it was
      // aggregated for. Doing this for `previousDisplay` too keeps
      // the transition merge consistent across the bracket boundary.
      ensureTier(currentDisplay, currentDisplayBounds, d);
      if (isTransitioning) {
        ensureTier(previousDisplay, previousDisplayBounds, d);
      }
    }

    const tier = cellsAtDepth(d, isTransitioning);
    if (tier.length === 0) continue;

    let cellsForSlot = tier;
    if (!isTransitioning && effectiveChildVirtualization) {
      const virtualizedFromItems = virtualizeTierFromItemsToSlot(d, slot);
      if (virtualizedFromItems.length > 0) {
        cellsForSlot = virtualizedFromItems;
      }
    }

    // We're about to emit cells at this true depth — `parentOf` reads
    // `currentDisplay[d - 1]` for the cell→parent morph blend. For
    // fallback tiers below the natural band the parent tier isn't
    // populated yet either; ensure it once here so `parentOf` can
    // fast-path through `currentDisplay[parentDepth]` for every cell.
    if (d - 1 >= 0 && d - 1 < slot) {
      ensureTier(currentDisplay, currentDisplayBounds, d - 1);
      if (isTransitioning) {
        ensureTier(previousDisplay, previousDisplayBounds, d - 1);
      }
    }

    for (let i = 0; i < cellsForSlot.length; i++) {
      scratchCells.push(cellsForSlot[i]);
      scratchSlotResolutions.push(slot);
    }
    return;
  }
}

function cellsAtDepth(depth, isTransitioning) {
  if (isTransitioning) {
    const cached = transitionCellsByDepth.get(depth);
    if (cached) return cached;
    const merged = mergeTransitionCells(depth);
    if (merged.length > 0) transitionCellsByDepth.set(depth, merged);
    return merged;
  }

  const cached = cellsByDepth.get(depth);
  if (cached) return cached;
  const tier = currentDisplay?.[depth];
  if (!tier?.aggregated?.[0]) return [];
  const cells = Object.values(tier.aggregated[0]);
  if (cells.length > 0) cellsByDepth.set(depth, cells);
  return cells;
}

// Builds the merged-snapshot list at one depth: a wrapper per cell
// carrying both its `__current` and `__previous` view (either may be
// null). Wrappers drive the fade-in / fade-out logic inside packAndEmit.
function mergeTransitionCells(depth) {
  const curMap = currentDisplay?.[depth]?.aggregated?.[0] || {};
  const prevMap = previousDisplay?.[depth]?.aggregated?.[0] || {};
  const merged = [];
  const seen = new Set();

  for (const key in prevMap) {
    const prev = prevMap[key];
    const cur = curMap[key] || null;
    merged.push({
      ...(cur || prev),
      __current: cur,
      __previous: prev,
    });
    seen.add(key);
  }
  for (const key in curMap) {
    if (seen.has(key)) continue;
    const cur = curMap[key];
    merged.push({
      ...cur,
      __current: cur,
      __previous: null,
    });
  }
  return merged;
}

// Returns the parent cell at `cell.xyz.resolution - 1`. Uses a
// per-snapshot WeakMap cache so repeated lookups across cells in the
// same parent are O(1).
function parentOf(cell) {
  if (!cube || !currentDisplay) return cell;
  const isTransitioning = transitionActive && !!previousDisplay;

  const source = cell.__current || cell.__previous || cell;
  if (source?.__virtualParent) return source.__virtualParent;
  const childDepth = source.xyz.resolution;
  const parentDepth = childDepth - 1;

  const cur = currentDisplay[parentDepth];
  const prev = previousDisplay?.[parentDepth];

  if (!cur?.aggregated?.[0] && !prev?.aggregated?.[0]) {
    // No parent tier in either snapshot: collapse parent slot to own
    // position so the GPU's `own + (parent - own) * zoomDelta` blend
    // is a no-op for this instance.
    return source;
  }

  const cacheStore = isTransitioning ? transitionParentByCell : parentByCell;
  let perDepth = cacheStore.get(childDepth);
  if (!perDepth) {
    perDepth = new WeakMap();
    cacheStore.set(childDepth, perDepth);
  }
  const cached = perDepth.get(cell);
  if (cached) return cached;

  const k = cube.key(cube.parent(source.xyz));
  const parent =
    cur?.aggregated?.[0]?.[k] ||
    prev?.aggregated?.[0]?.[k] ||
    source;
  perDepth.set(cell, parent);
  return parent;
}

function viewportDvfFromMetricSums(totalCount, metricSums) {
  const sumV = metricSums?.[METRIC_VALEUR_FONCIERE_INDEX] || 0;
  const sumS = metricSums?.[METRIC_SURFACE_BATI_INDEX] || 0;
  return {
    transactions: Math.round(totalCount > 0 ? totalCount : 0),
    avgValeurFonciere: totalCount > 0 ? sumV / totalCount : null,
    avgSurfaceM2: totalCount > 0 ? sumS / totalCount : null,
    avgEuroM2: sumS > 0 ? sumV / sumS : null,
  };
}

function metricSumsEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function aggregateViewportMetricSums(zoom, metricCountHint = 0) {
  const empty = {
    totalCount: 0,
    metricSums: Array.from({ length: Math.max(0, metricCountHint) }, () => 0),
  };
  if (!cube || !cubeSpace || zoom == null) return empty;
  const strictBoundsSerialized = lastStrictBoundsSerialized || lastBoundsSerialized;
  if (!strictBoundsSerialized) return empty;

  const strictBounds = deserializeBounds(strictBoundsSerialized, cubeSpace);
  const viewport = strictBounds?.[0]?.value?.();
  if (!Array.isArray(viewport) || viewport.length < 4) return empty;

  const depth = liveDepth(zoom);
  const raw = cube.retrieve(depth, strictBounds, cube.root, false, "items");
  if (!raw || raw.length === 0) return empty;

  let totalCount = 0;
  const metricSums = Array.from({ length: Math.max(0, metricCountHint) }, () => 0);

  for (let i = 0; i < raw.length; i++) {
    const element = raw[i];
    if (!element || !(element.count > 0)) continue;

    const cellRect = readCellRect(element);
    let fraction = 1;
    if (cellRect) {
      fraction = rectIntersectionFraction(cellRect, viewport);
      if (fraction <= 0) continue;
    } else {
      ensureDisplayPosition(element);
      if (!pointInViewport(element.__lat, element.__lng, viewport)) continue;
    }

    // Always accumulate item mass from visible parent zones, even when
    // purchase metrics are missing (density / incomplete Abelian).
    totalCount += element.count * fraction;

    const m = element.metrics;
    if (!Array.isArray(m) || m.length === 0) continue;
    if (m.length > metricSums.length) {
      const prevLen = metricSums.length;
      metricSums.length = m.length;
      for (let j = prevLen; j < m.length; j++) metricSums[j] = 0;
    }
    for (let j = 0; j < m.length; j++) {
      const value = m[j];
      if (Number.isFinite(value)) metricSums[j] += value * fraction;
    }
  }

  if (!(totalCount > 0)) return empty;
  return { totalCount, metricSums };
}

function viewportMetricsKey(zoom) {
  if (zoom == null) return "";
  const strictBoundsSerialized = lastStrictBoundsSerialized || lastBoundsSerialized || "";
  return `${liveDepth(zoom)}|${strictBoundsSerialized}|${lastKnownMetricCount}`;
}

function flushViewportMetricsRefresh() {
  viewportMetricsTimer = null;
  const pending = pendingViewportMetrics;
  pendingViewportMetrics = null;
  if (!pending || pending.zoom == null) return;

  const aggregated = aggregateViewportMetricSums(pending.zoom, lastKnownMetricCount);
  const viewportDvf = viewportDvfFromMetricSums(
    aggregated.totalCount,
    aggregated.metricSums
  );
  const changed =
    pending.key !== viewportMetricsState.key ||
    aggregated.totalCount !== viewportMetricsState.totalCount ||
    !metricSumsEqual(aggregated.metricSums, viewportMetricsState.metricSums);

  viewportMetricsState = {
    key: pending.key,
    totalCount: aggregated.totalCount,
    metricSums: aggregated.metricSums,
    viewportDvf,
  };

  if (changed) {
    self.postMessage({
      type: "VIEWPORT_METRICS",
      payload: {
        viewportMetricCount: aggregated.totalCount,
        viewportMetricSums: aggregated.metricSums,
        viewportDvf,
      },
    });
  }

  if (pendingViewportMetrics) {
    viewportMetricsTimer = setTimeout(
      flushViewportMetricsRefresh,
      VIEWPORT_METRICS_DEBOUNCE_MS
    );
  }
}

function scheduleViewportMetricsRefresh(zoom) {
  if (zoom == null) return;
  const key = viewportMetricsKey(zoom);
  // Always re-queue after pack/reconcile — Abelian counts can change without
  // a zoom/bounds key change, so do not early-return on key equality here.
  pendingViewportMetrics = { zoom, key };
  if (viewportMetricsTimer !== null) return;
  viewportMetricsTimer = setTimeout(
    flushViewportMetricsRefresh,
    VIEWPORT_METRICS_DEBOUNCE_MS
  );
}

/** Recompute viewport item totals synchronously (used at pack time). */
function refreshViewportMetricsSync(zoom) {
  if (zoom == null) {
    return {
      key: "",
      totalCount: 0,
      metricSums: [],
      viewportDvf: viewportDvfFromMetricSums(0, []),
    };
  }
  const aggregated = aggregateViewportMetricSums(zoom, lastKnownMetricCount);
  const viewportDvf = viewportDvfFromMetricSums(
    aggregated.totalCount,
    aggregated.metricSums
  );
  const key = viewportMetricsKey(zoom);
  viewportMetricsState = {
    key,
    totalCount: aggregated.totalCount,
    metricSums: aggregated.metricSums,
    viewportDvf,
  };
  return viewportMetricsState;
}

// ----------------------------------------------------------------------------
// Pack + emit
// ----------------------------------------------------------------------------

function packAndEmit(dataDriven) {
  collectCells(lastZoom);
  const cells = scratchCells;
  const slotResolutions = scratchSlotResolutions;
  const n = cells.length;
  let metricCount = lastKnownMetricCount;
  for (let i = 0; i < n; i++) {
    const src = cells[i]?.__current || cells[i];
    const len = Array.isArray(src?.metrics) ? src.metrics.length : 0;
    if (len > metricCount) metricCount = len;
  }
  lastKnownMetricCount = metricCount;
  const pointOverlay = safeCollectPointOverlay(lastZoom);
  // Sync totals so PACKED / UI badge reflect cube Abelian after reconcile
  // (debounced refresh alone skipped when zoom/bounds key was unchanged).
  const metricsNow = refreshViewportMetricsSync(lastZoom);
  const viewportMetricCount = metricsNow.totalCount;
  const viewportMetricSums = metricsNow.metricSums;
  const viewportDvf = metricsNow.viewportDvf;
  // Keep debounced path for MOVE settle / late ingest.
  scheduleViewportMetricsRefresh(lastZoom);

  if (n === 0) {
    const now = nowMs();
    const interactionActive = now - lastMoveAtMs < MOVE_INTERACTION_SUPPRESS_MS;
    const recentlyNonEmpty =
      lastNonEmptyPackAtMs > 0 && now - lastNonEmptyPackAtMs < EMPTY_PACK_HOLD_MS;
    const shouldHoldEmpty =
      transitionActive || pendingIngest.size > 0 || interactionActive || recentlyNonEmpty;

    heatmapDebugLogEmptyPack({
      snapshotVersion: displaySnapshotVersion,
      shouldHoldEmpty,
      interactionActive,
      transitionActive,
      pendingIngest: pendingIngest.size,
      recentlyNonEmpty,
      dataDriven,
    });

    // Always emit PACKED for n===0 below: withholding the frame left the
    // point GeoJSON stale on main while holding heatmap retries.
    if (shouldHoldEmpty) {
      scheduleEmptyPackRetry();
    }

    const message = {
      type: "PACKED",
      payload: {
        snapshotVersion: displaySnapshotVersion,
        instanceCount: 0,
        // Empty snapshots cannot participate in prev↔cur GPU blend; flagging
        // dataDriven would restart RAF timing without adopting geometry (grace
        // path skips buffer swaps), producing jumps/stutter.
        dataDriven: false,
        showPoints: pointOverlay.showPoints,
        pointCount: pointOverlay.count,
        visibleItemCount: pointOverlay.visibleItemCount,
        pointThreshold: pointOverlay.threshold,
        zoneSubdivisionThreshold: cubeSubdivisionLimit,
        requireCompleteChildren,
        childVirtualizationEnabled,
        algorithmResolution,
        polygonFilterEnabled,
        valueMetricIndex,
        metricCount: lastKnownMetricCount,
        viewportMetricCount,
        viewportMetricSums,
        viewportDvf,
      },
    };
    if (pointOverlay.buffer) {
      message.pointsBuffer = pointOverlay.buffer;
      self.postMessage(message, [pointOverlay.buffer]);
    } else {
      self.postMessage(message);
    }
    lastPackedPositionStyleEpoch = positionStyleEpoch;
    return;
  }

  const buffer = packedPool.acquire(n);
  const pool = new Float32Array(buffer);

  for (let i = 0; i < n; i++) {
    writeCellToPack(pool, i, cells[i], slotResolutions[i]);
  }

  const message = {
    type: "PACKED",
    payload: {
      snapshotVersion: displaySnapshotVersion,
      instanceCount: n,
      dataDriven,
      showPoints: pointOverlay.showPoints,
      pointCount: pointOverlay.count,
      visibleItemCount: pointOverlay.visibleItemCount,
      pointThreshold: pointOverlay.threshold,
      zoneSubdivisionThreshold: cubeSubdivisionLimit,
      requireCompleteChildren,
      childVirtualizationEnabled,
      algorithmResolution,
      polygonFilterEnabled,
      valueMetricIndex,
      metricCount: lastKnownMetricCount,
      viewportMetricCount,
      viewportMetricSums,
      viewportDvf,
    },
    buffer,
  };
  const transfer = [buffer];
  if (pointOverlay.buffer) {
    message.pointsBuffer = pointOverlay.buffer;
    transfer.push(pointOverlay.buffer);
  }
  self.postMessage(message, transfer);
  lastNonEmptyPackAtMs = nowMs();
  lastPackedPositionStyleEpoch = positionStyleEpoch;
}

function itemLatLngFromHash(item) {
  if (!cubeSpace || !item?._hash) return null;
  try {
    const segments = cubeSpace.decode(item._hash);
    if (!segments) return null;
    const center = cubeSpace.center(segments);
    const geo = readGeoPoint(center?.[0]);
    if (!geo) return null;
    return { lat: geo[0], lng: geo[1] };
  } catch (e) {
    // In case of error during decoding, treat as if no position available.
    return null;
  }
}

function computeItemMetricValue(item) {
  const denom =
    Number.isFinite(item?._count) && item._count > 0 ? item._count : 1;
  const metrics = Array.isArray(item?._metrics)
    ? item._metrics
    : Array.isArray(item?.metrics)
      ? item.metrics
      : null;
  const raw = metrics?.[valueMetricIndex];
  const sum = Number.isFinite(raw) ? raw : 0;
  return sum / denom;
}

function safeCollectPointOverlay(zoom) {
  try {
    return collectPointOverlay(zoom);
  } catch (error) {
    // Never let the optional points overlay break the heatmap pipeline.
    // Drop the overlay for this frame and surface the error for triage.
    self.postMessage({
      type: "ERROR",
      payload: `pointOverlay: ${error?.message || error}`,
    });
    return {
      showPoints: false,
      count: 0,
      buffer: null,
      visibleItemCount: 0,
      threshold: pointOverlayConfig.maxPoints,
    };
  }
}

// Build the points overlay.
//
// Strategy:
//   1. Retrieve cells at the natural live depth, restricted to the viewport.
//   2. Admit every cell whose BOUNDS intersect the viewport.
//   3. Estimate the visible item count by weighting each cell's `count`
//      with its bounds-intersection fraction.
//   4. If total <= threshold:
//      a. For each cell, retrieve individual items up to a limit.
//      b. Plot items at lat/lng from item hash where available; aggregate
//         points that fall on the same rounded coordinate.
//      c. If the cell exposes no item-level detail, scatter uniformly in
//         bounds (deterministic RNG) as degraded mode.
//      d. If item lists exist AND at least one item places on-screen via its
//         hash: do NOT add parent-bounds scatter for the unexplained remainder
//         (same locations when dezoom merges coarse cells vs fine hashes).
//      e. If item lists exist but none decode in viewport, scatter ONLY the
//         remainder toward the parent's reported count budget.
function collectPointOverlay(zoom) {
  const threshold = pointOverlayConfig.maxPoints;
  const empty = {
    showPoints: false,
    count: 0,
    buffer: null,
    visibleItemCount: 0,
    threshold,
  };

  if (!cube || !cubeSpace || zoom == null) return empty;
  const strictBoundsSerialized =
    lastStrictBoundsSerialized || lastBoundsSerialized;
  if (!strictBoundsSerialized) return empty;

  const strictBounds = deserializeBounds(strictBoundsSerialized, cubeSpace);
  const viewport = strictBounds?.[0]?.value?.();
  if (!Array.isArray(viewport) || viewport.length < 4) return empty;

  const depth = liveDepth(zoom);
  const raw = cube.retrieve(depth, strictBounds, cube.root, false, "items");
  if (!raw || raw.length === 0) return empty;

  const visibleCells = [];
  let weightedItemCount = 0;
  let upperBoundPoints = 0;
  for (let i = 0; i < raw.length; i++) {
    const element = raw[i];
    if (!element || !(element.count > 0)) continue;

    const cellValue = computeCellValue(element);

    const cellRect = readCellRect(element);
    if (cellRect) {
      const fraction = rectIntersectionFraction(cellRect, viewport);
      if (fraction <= 0) continue;
      visibleCells.push({ element, cellRect, value: cellValue });
      weightedItemCount += element.count * fraction;
      upperBoundPoints += element.count;
    } else {
      ensureDisplayPosition(element);
      if (!pointInViewport(element.__lat, element.__lng, viewport)) continue;
      visibleCells.push({ element, cellRect: null, value: cellValue });
      weightedItemCount += element.count;
      upperBoundPoints += element.count;
    }
  }

  const visibleItemCount = Math.round(weightedItemCount);
  if (visibleItemCount === 0) return empty;
  if (visibleItemCount > threshold) {
    return {
      showPoints: false,
      count: 0,
      buffer: null,
      visibleItemCount,
      threshold,
    };
  }

  const points = new Float32Array(upperBoundPoints * 3);
  let write = 0;

  for (let i = 0; i < visibleCells.length; i++) {
    const { element, cellRect, value: cellValue } = visibleCells[i];
    const items = [];
    collectElementItems(element, items, {
      remaining: Math.min(element.count, MAX_VIRTUAL_ITEMS_PER_CELL),
    });

    if (items.length === 0) {
      write = scatterPointsInCell(
        element,
        cellRect,
        viewport,
        cellValue,
        points,
        write
      );
      continue;
    }

    const aggregatedPoints = new Map();
    const seenHashesThisCell = new Set();

    let listWeightSum = 0;
    for (let j = 0; j < items.length; j++) {
      const item = items[j];
      const h =
        item && typeof item._hash === "string" && item._hash.length > 0
          ? item._hash
          : null;
      if (h) {
        if (seenHashesThisCell.has(h)) continue;
        seenHashesThisCell.add(h);
      }
      const weight =
        Number.isFinite(item._count) && item._count > 0 ? item._count : 1;
      listWeightSum += weight;
    }

    let decodedInViewport = 0;

    seenHashesThisCell.clear();
    for (let j = 0; j < items.length; j++) {
      const item = items[j];
      const h =
        item && typeof item._hash === "string" && item._hash.length > 0
          ? item._hash
          : null;
      if (h) {
        if (seenHashesThisCell.has(h)) continue;
        seenHashesThisCell.add(h);
      }

      const latLng = itemLatLngFromHash(item);
      if (!latLng || !pointInViewport(latLng.lat, latLng.lng, viewport)) {
        continue;
      }

      const weight =
        Number.isFinite(item._count) && item._count > 0 ? item._count : 1;
      const itemValue = computeItemMetricValue(item);
      const key = `${latLng.lng.toFixed(6)},${latLng.lat.toFixed(6)}`;

      decodedInViewport++;

      const existing = aggregatedPoints.get(key);
      if (existing) {
        existing.metricSum += itemValue * weight;
        existing.denomSum += weight;
      } else {
        aggregatedPoints.set(key, {
          metricSum: itemValue * weight,
          denomSum: weight,
          lat: latLng.lat,
          lng: latLng.lng,
        });
      }
    }

    for (const point of aggregatedPoints.values()) {
      if (write + 3 > points.length) break;
      const value = point.denomSum > 0 ? point.metricSum / point.denomSum : 0;
      points[write++] = point.lng;
      points[write++] = point.lat;
      points[write++] = value;
    }

    const remainder = Math.max(0, element.count - listWeightSum);
    // Do not overlay parent-bbox scatter while real hashes place points on
    // screen — avoids duplicate blobs when dezoom merges into coarse cells.
    if (remainder > 0 && decodedInViewport === 0) {
      write = scatterPointsInCell(
        { ...element, count: remainder },
        cellRect,
        viewport,
        cellValue,
        points,
        write
      );
    }
  }

  const renderedCount = Math.floor(write / 3);
  if (renderedCount === 0) return empty;

  return {
    showPoints: true,
    count: renderedCount,
    buffer:
      write === points.length ? points.buffer : points.slice(0, write).buffer,
    visibleItemCount,
    threshold,
  };
}

// Per-cell aggregated metric — the same value the heatmap pipeline
// drives its color through (nominator / count). The main thread divides
// this by `normalizer` (a fixed constant, not viewport-dependent) so
// the final color stop for a given item is invariant across frames.
function computeCellValue(element) {
  const denom = element?.count || 0;
  if (denom <= 0) return 0;
  const m = element?.metrics;
  const valeur = Number(m?.[METRIC_VALEUR_FONCIERE_INDEX]) || 0;
  const surface = Number(m?.[METRIC_SURFACE_BATI_INDEX]) || 0;
  // DVF: prix au m² = valeur foncière / surface bâtie
  if (surface > 1e-6 && valeur > 0) return valeur / surface;
  const prixSum = Number(m?.[valueMetricIndex]) || 0;
  if (prixSum > 0) return prixSum / denom;
  // geo_load / count-only — log density for a usable color span
  return Math.log1p(denom);
}

/**
 * Pack nominator/denominator for the WebGPU shader:
 *   color t = (nom / denom) / normalizer
 * DVF → (valeur / surface) / 10000  (= €/m² scaled)
 * geo_load → log1p(count) / log1p(50k)
 */
function heatPackValues(cell, fadeToZero) {
  if (fadeToZero || !cell) return { n: 0, d: 0, kind: "empty" };
  const count = cell.count || 0;
  const m = cell.metrics || [];
  const valeur = Number(m[METRIC_VALEUR_FONCIERE_INDEX]) || 0;
  const surface = Number(m[METRIC_SURFACE_BATI_INDEX]) || 0;
  const prixSum = Number(m[valueMetricIndex]) || 0;

  if (surface > 1e-6 && valeur > 0) {
    return { n: valeur, d: surface, kind: "dvf" };
  }
  if (prixSum > 0 && count > 0) {
    return { n: prixSum, d: count, kind: "dvf" };
  }
  if (count > 0) {
    return { n: Math.log1p(count), d: 1, kind: "density" };
  }
  return { n: 0, d: 0, kind: "empty" };
}

// Randomly scatters `count` points inside a cell's geographic bounds using a
// deterministic pseudo-random sequence so the same cell is rendered
// identically across frames. This is used as a fallback for cells without
// item-level detail, or for the remainder count when not all of a cell's
// items can be displayed individually.
//
// Points falling outside the strict viewport are dropped. Stride is 3 floats
// per emitted point: (lng, lat, value). All points from the same cell share
// the cell's aggregated metric value.
function scatterPointsInCell(
  element,
  cellRect,
  viewport,
  value,
  output,
  writeOffset
) {
  const count = element.count;
  if (count <= 0) return writeOffset;

  let write = writeOffset;
  if (cellRect) {
    const [south, north, west, east] = cellRect;
    const latSpan = Math.max(0, north - south);
    const lngSpan = Math.max(0, east - west);
    const seed = seedForElement(element);
    for (let i = 0; i < count; i++) {
      if (write + 3 > output.length) break;
      const u = pseudoRandom(seed + i * 2 + 1);
      const v = pseudoRandom(seed + i * 2 + 2);
      const lat = south + u * latSpan;
      const lng = west + v * lngSpan;
      if (!pointInViewport(lat, lng, viewport)) continue;
      output[write++] = lng;
      output[write++] = lat;
      output[write++] = value;
    }
    return write;
  }

  // No bounds → degraded fallback at the centroid.
  ensureDisplayPosition(element);
  if (!pointInViewport(element.__lat, element.__lng, viewport)) {
    return write;
  }
  for (let i = 0; i < count; i++) {
    if (write + 3 > output.length) break;
    output[write++] = element.__lng;
    output[write++] = element.__lat;
    output[write++] = value;
  }
  return write;
}

// Reads the [south, north, west, east] rectangle from a cube cell's
// bounds, or null if the bounds are missing/degenerate.
//
// The SDK stores bounds[0] as a plain object { south, west, north, east }
// (same shape the polygon WASM receives). An older Segment wrapper with a
// .value() method is also handled for forward-compatibility.
function readCellRect(element) {
  const b = element?.bounds?.[0];
  if (!b) return null;

  let south, north, west, east;
  if (typeof b.value === "function") {
    // SDK Segment object.
    const v = b.value();
    if (!Array.isArray(v) || v.length < 4) return null;
    [south, north, west, east] = v;
  } else if (
    typeof b.south === "number" &&
    typeof b.north === "number" &&
    typeof b.west === "number" &&
    typeof b.east === "number"
  ) {
    // Plain object { south, west, north, east } as documented in polygonWasm.js.
    ({ south, north, west, east } = b);
  } else {
    return null;
  }

  if (
    !Number.isFinite(south) ||
    !Number.isFinite(north) ||
    !Number.isFinite(west) ||
    !Number.isFinite(east)
  ) {
    return null;
  }
  if (north <= south || east <= west) return null;
  return [south, north, west, east];
}

// Longitude midpoint for a non-wrapping [west, east] segment (same
// assumption as readCellRect: west < east).
function lngSegmentMidpoint(west, east) {
  return (west + east) * 0.5;
}

function applyXyzCenter(cell) {
  const xyz = cell?.xyz;
  if (!xyz || !cubeSpace?.bounds || !cubeSpace?.center) return false;
  const bounds = cubeSpace.bounds(xyz);
  const center = cubeSpace.center(bounds);
  const geo = readGeoPoint(center?.[0]);
  if (!geo) return false;
  cell.__lat = geo[0];
  cell.__lng = geo[1];
  return true;
}

// Sets `cell.__lat` / `cell.__lng` from bounds midpoint and/or summed
// lat/lng metric hooks (see `CELL_POSITION_MODE_*`).
function ensureDisplayPosition(cell) {
  if (!cell) return;
  if (
    cell.__posEpoch === positionStyleEpoch &&
    cell.__lat !== undefined &&
    cell.__lng !== undefined
  ) {
    return;
  }
  cell.__posEpoch = positionStyleEpoch;
  delete cell.__lat;
  delete cell.__lng;

  const userLat = cellPositionMetricLatIndex;
  const userLng = cellPositionMetricLngIndex;

  if (cellPositionMode === CELL_POSITION_MODE_BOUNDS) {
    if (applyXyzCenter(cell)) return;
    if (applyBoundsCenter(cell)) return;
    if (ensureMetricCentroid(cell, userLat, userLng)) return;
    if (
      ensureMetricCentroid(
        cell,
        COLLECTION_DEFAULTS.latMetricIndex,
        COLLECTION_DEFAULTS.lngMetricIndex
      )
    ) {
      return;
    }
    cell.__lat = 0;
    cell.__lng = 0;
    return;
  }

  if (cellPositionMode === CELL_POSITION_MODE_METRICS) {
    if (ensureMetricCentroid(cell, userLat, userLng)) return;
    if (applyXyzCenter(cell)) return;
    if (applyBoundsCenter(cell)) return;
    if (
      ensureMetricCentroid(
        cell,
        COLLECTION_DEFAULTS.latMetricIndex,
        COLLECTION_DEFAULTS.lngMetricIndex
      )
    ) {
      return;
    }
    cell.__lat = 0;
    cell.__lng = 0;
  }
}

function readGeoPoint(point) {
  if (!point) return null;
  if (Number.isFinite(point.latitude) && Number.isFinite(point.longitude)) {
    return [point.latitude, point.longitude];
  }
  if (typeof point.value === "function") {
    const values = point.value();
    if (
      Array.isArray(values) &&
      values.length >= 2 &&
      Number.isFinite(values[0]) &&
      Number.isFinite(values[1])
    ) {
      return [values[0], values[1]];
    }
  }
  return null;
}

function applyBoundsCenter(cell) {
  const center = cubeSpace?.center?.(cell?.bounds);
  const geo = readGeoPoint(center?.[0]);
  if (geo) {
    cell.__lat = geo[0];
    cell.__lng = geo[1];
    return true;
  }
  const rect = readCellRect(cell);
  if (!rect) return false;
  const [south, north, west, east] = rect;
  cell.__lat = (south + north) * 0.5;
  cell.__lng = lngSegmentMidpoint(west, east);
  return true;
}

// Fraction of the cell's bounding rect that lies inside the viewport.
// Used to weight `count` so the threshold reflects only the on-screen
// portion of cells straddling the viewport edge.
function rectIntersectionFraction(cellRect, viewport) {
  const [cs, cn, cw, ce] = cellRect;
  const [vs, vn, vw, ve] = viewport;
  const south = Math.max(cs, vs);
  const north = Math.min(cn, vn);
  const west = Math.max(cw, vw);
  const east = Math.min(ce, ve);
  if (north <= south || east <= west) return 0;
  const cellArea = (cn - cs) * (ce - cw);
  if (cellArea <= 0) return 0;
  return ((north - south) * (east - west)) / cellArea;
}

function seedForElement(element) {
  const xyz = element?.xyz;
  if (!xyz) return 1;
  let seed = (xyz.resolution || 0) + 1;
  const coords = Array.isArray(xyz.coordinates) ? xyz.coordinates : [];
  for (let i = 0; i < coords.length; i++) {
    seed = (seed * 1315423911 + (coords[i] + 31) * (i + 1)) >>> 0;
  }
  return seed || 1;
}

function pseudoRandom(x) {
  const s = Math.sin(x * 12.9898) * 43758.5453123;
  return s - Math.floor(s);
}

function pointInViewport(lat, lng, viewport) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const [south, north, west, east] = viewport;
  return lat >= south && lat <= north && lng >= west && lng <= east;
}

function getStrictViewportRect() {
  if (!cubeSpace) return null;
  const serialized = lastStrictBoundsSerialized || lastBoundsSerialized;
  if (!serialized) return null;
  try {
    const strictBounds = deserializeBounds(serialized, cubeSpace);
    const v = strictBounds?.[0]?.value?.();
    if (!Array.isArray(v) || v.length < 4) return null;
    const [south, north, west, east] = v;
    if (
      !Number.isFinite(south) ||
      !Number.isFinite(north) ||
      !Number.isFinite(west) ||
      !Number.isFinite(east) ||
      north <= south ||
      east <= west
    ) {
      return null;
    }
    return v;
  } catch (_err) {
    return null;
  }
}

function rectIntersectionCorners(cellRect, viewportRect) {
  const [cs, cn, cw, ce] = cellRect;
  const [vs, vn, vw, ve] = viewportRect;
  const south = Math.max(cs, vs);
  const north = Math.min(cn, vn);
  const west = Math.max(cw, vw);
  const east = Math.min(ce, ve);
  if (north <= south || east <= west) return null;
  return [south, north, west, east];
}

// While network data catches up / GPU snapshot transitions blend, coarse
// parent anchors can sit strictly outside MapLibre's visible rect even
// though the cell overlaps the viewport (thin strip/graze). Sliding the pack
// anchor to the intersection centroid keeps disks from clipping away as
// "empty" flashes until finer tiers stream in.
function shouldUseIncompleteViewportAnchors() {
  return transitionActive || pendingIngest.size > 0;
}

function maybeNudgeCellAnchorOntoOverlapViewport(cell) {
  if (!cell || !shouldUseIncompleteViewportAnchors()) return;
  const viewport = getStrictViewportRect();
  if (!viewport) return;
  ensureDisplayPosition(cell);
  if (
    Number.isFinite(cell.__lat) &&
    Number.isFinite(cell.__lng) &&
    pointInViewport(cell.__lat, cell.__lng, viewport)
  ) {
    return;
  }
  const rect = readCellRect(cell);
  if (!rect) return;
  const isect = rectIntersectionCorners(rect, viewport);
  if (!isect) return;
  const [south, north, west, east] = isect;
  cell.__lat = (south + north) * 0.5;
  cell.__lng = lngSegmentMidpoint(west, east);
}

// Writes one instance's 14 floats into `pool` at offset i. Layout
// matches the shader (see `src/visualization/webgpu/shaders.js`):
//
//   [ 0.. 3] currentLatLng  : (curLat, curLng, curParentLat, curParentLng)
//   [ 4.. 7] previousLatLng : (prevLat, prevLng, prevParentLat, prevParentLng)
//   [ 8..11] values         : (currentNominator, currentDenominator,
//                              resolution, slotResolution)
//   [12..13] previousValues : (previousNominator, previousDenominator)
function writeCellToPack(pool, i, cell, slotResolution) {
  const parent = parentOf(cell);

  // Detect transition wrappers (`mergeTransitionCells` always sets BOTH
  // __current and __previous; `__current` being defined is the wrapper
  // signal). For non-transition cells, `cell` IS the aggregated cell.
  //
  //   wrapper with both sides    → exists in prev AND cur     → smooth blend
  //   wrapper with __previous=null → cell appeared this snapshot → fade IN  (prev=0, cur=full)
  //   wrapper with __current=null  → cell vanished this snapshot → fade OUT (cur=0, prev=full)
  //   non-wrapper                  → no transition, prev === cur   → mix collapses to identity
  //
  // Without the zero-substitutions a "new" cell would pop in at full
  // opacity (mix(curN, curN, t) = curN regardless of t) and a "gone"
  // cell would linger until TRANSITION_COMPLETE.
  const isWrapper = cell.__current !== undefined;
  const fadeIn = isWrapper && cell.__previous === null;
  const fadeOut = isWrapper && cell.__current === null;

  const cur = cell.__current || cell;
  const prev = cell.__previous || cur;
  const curParent = parent.__current || parent;
  const prevParent = parent.__previous || curParent;

  ensureDisplayPosition(cur);
  ensureDisplayPosition(prev);
  ensureDisplayPosition(curParent);
  ensureDisplayPosition(prevParent);

  maybeNudgeCellAnchorOntoOverlapViewport(cur);
  maybeNudgeCellAnchorOntoOverlapViewport(prev);
  maybeNudgeCellAnchorOntoOverlapViewport(curParent);
  maybeNudgeCellAnchorOntoOverlapViewport(prevParent);

  // DVF: (valeur/surface)/normalizer → €/m². geo_load: log1p(count).
  const curPack = heatPackValues(cur, fadeOut);
  const prevPack = heatPackValues(prev, fadeIn);
  const curN = curPack.n;
  const curD = curPack.d;
  const prevN = fadeIn ? 0 : prevPack.n || curN;
  const prevD = fadeIn ? 0 : prevPack.d || curD;

  const off = i * FLOATS_PER_INSTANCE;
  pool[off] = cur.__lat;
  pool[off + 1] = cur.__lng;
  pool[off + 2] = curParent.__lat;
  pool[off + 3] = curParent.__lng;
  pool[off + 4] = prev.__lat;
  pool[off + 5] = prev.__lng;
  pool[off + 6] = prevParent.__lat;
  pool[off + 7] = prevParent.__lng;
  pool[off + 8] = curN;
  pool[off + 9] = curD;
  pool[off + 10] = cell.xyz.resolution;
  pool[off + 11] = slotResolution;
  pool[off + 12] = prevN;
  pool[off + 13] = prevD;
}

// ----------------------------------------------------------------------------
// Message dispatch
// ----------------------------------------------------------------------------

function applyCellPositionFromPayload(payload) {
  const next = normalizeCellPositionConfig(payload);
  if (
    next.mode === cellPositionMode &&
    next.metricLatIndex === cellPositionMetricLatIndex &&
    next.metricLngIndex === cellPositionMetricLngIndex
  ) {
    return;
  }
  cellPositionMode = next.mode;
  cellPositionMetricLatIndex = next.metricLatIndex;
  cellPositionMetricLngIndex = next.metricLngIndex;
  positionStyleEpoch++;
  if (cube) cube.current = {};
  requestImmediateFlush();
}

self.onmessage = async (event) => {
  const { type, payload, buffer } = event.data;

  try {
    switch (type) {
      case "INIT":
        await handleInit(payload);
        break;

      case "LOAD_POLYGON": {
        if (!loadPolygon(payload)) {
          // GPU mask still works via main-thread initializeMask; worker
          // polygon is only for cube truncation. Soft-fail under Vite.
          console.warn(
            "[grid.worker] polygon GeoJSON load failed — cube truncation disabled"
          );
        }
        break;
      }

      case "MOVE":
        handleMove(payload);
        break;

      case "RELEASE_PACKED":
        if (buffer) packedPool.release(buffer);
        break;

      case "SET_CELL_POSITION": {
        applyCellPositionFromPayload(payload);
        break;
      }

      case "SET_POINT_OVERLAY_MAX_POINTS": {
        const next = normalizePositiveInt(
          payload?.value,
          pointOverlayConfig.maxPoints
        );
        if (next !== pointOverlayConfig.maxPoints) {
          pointOverlayConfig.maxPoints = next;
          requestImmediateFlush();
        }
        break;
      }

      case "SET_CUBE_SUBDIVISION_LIMIT": {
        const next = normalizeCubeSubdivisionLimit(payload?.value, cubeSubdivisionLimit);
        if (next !== cubeSubdivisionLimit) {
          cubeSubdivisionLimit = next;
          if (cube?.options) cube.options.limit = next;
          if (cube) cube.current = {};
          requestImmediateFlush();
        }
        break;
      }

      case "SET_REQUIRE_COMPLETE_CHILDREN": {
        const next = payload?.value !== false;
        if (next !== requireCompleteChildren) {
          requireCompleteChildren = next;
          applyCubeChildrenRequirement();
          if (cube) cube.current = {};
          requestImmediateFlush();
        }
        break;
      }

      case "SET_ALGO_RESOLUTION": {
        const next = normalizePositiveInt(payload?.value, algorithmResolution);
        if (next !== algorithmResolution) {
          applyAlgorithmResolution(next);
          if (cube) cube.current = {};
          if (grid && lastZoom != null && lastBoundsSerialized) {
            grid.move(lastZoom, deserializeBounds(lastBoundsSerialized, grid.space));
          }
          pruneCubePastViewportLod();
          requestImmediateFlush();
        }
        break;
      }

      case "SET_POLYGON_FILTER_ENABLED": {
        const next = payload?.value !== false;
        if (next !== polygonFilterEnabled) {
          polygonFilterEnabled = next;
          if (cube) cube.current = {};
          requestImmediateFlush();
        }
        break;
      }

      case "SET_VALUE_METRIC_INDEX": {
        const next = normalizeMetricIndex(payload?.value, valueMetricIndex);
        if (next !== valueMetricIndex) {
          valueMetricIndex = next;
          if (cube) cube.current = {};
          requestImmediateFlush();
        }
        break;
      }

      case "SET_CHILD_VIRTUALIZATION": {
        const next = payload?.value !== false;
        if (next !== childVirtualizationEnabled) {
          childVirtualizationEnabled = next;
          if (cube) cube.current = {};
          requestImmediateFlush();
        }
        break;
      }

      case "TRANSITION_COMPLETE":
        handleTransitionComplete(payload);
        break;

      default:
        console.warn("[grid.worker] unknown command:", type);
    }
  } catch (error) {
    self.postMessage({ type: "ERROR", payload: error.message });
  }
};

async function handleInit(payload) {
  // Must run before createGridRuntime → Network.discoverPeers → pingPeer.
  // Workers do not share the main thread's globalThis.__INDEXUS_BEARER__.
  if (typeof payload.bearer === "string" && payload.bearer.length > 0) {
    globalThis.__INDEXUS_BEARER__ = payload.bearer;
  }

  // The whole read path runs in here, so the SDK channels are worthless unless
  // the flag crosses with INIT — the main thread's global is a different realm.
  if (payload.debugSdk !== undefined) {
    setDebug(payload.debugSdk);
  }

  resetIngestQueue();
  stopReconcileTimers();
  stopPerfSnapshot();
  heatmapDebugEnabled = payload.debugHeatmap === true;
  lastHeatmapEmptyEmitLogMs = 0;
  const debugPerf = payload?.debugPerf;
  if (debugPerf && typeof debugPerf === "object") {
    perfDebugEnabled = debugPerf.enabled !== false;
    if (Number.isFinite(debugPerf.spikeThresholdMs)) {
      perfSpikeThresholdMs = Math.max(1, Math.floor(debugPerf.spikeThresholdMs));
    } else {
      perfSpikeThresholdMs = PERF_SPIKE_THRESHOLD_MS;
    }
    if (Number.isFinite(debugPerf.snapshotMs)) {
      perfSnapshotMs = Math.max(250, Math.floor(debugPerf.snapshotMs));
    } else {
      perfSnapshotMs = PERF_SNAPSHOT_MS;
    }
  } else {
    perfDebugEnabled = true;
    perfSpikeThresholdMs = PERF_SPIKE_THRESHOLD_MS;
    perfSnapshotMs = PERF_SNAPSHOT_MS;
  }
  if (perfDebugEnabled) schedulePerfSnapshot();

  if (viewportMetricsTimer !== null) {
    clearTimeout(viewportMetricsTimer);
    viewportMetricsTimer = null;
  }
  pendingViewportMetrics = null;
  viewportMetricsState = {
    key: "",
    totalCount: 0,
    metricSums: [],
    viewportDvf: {
      transactions: 0,
      avgValeurFonciere: null,
      avgSurfaceM2: null,
      avgEuroM2: null,
    },
  };

  // WASM module load is async but Cube construction needs the
  // `isCovered` closure synchronously. The closure is safe to call
  // before WASM is ready (returns false → cube doesn't truncate
  // recursion).
  polygonWasm = await createPolygonWasm();

  const progressiveGridStream =
    payload.gridOpt?.stream?.progressive === true;

  function gridStreamOutput(elements) {
    stream.enqueue(elements);
    if (progressiveGridStream) {
      stream.flushNow();
    }
  }

  const gridRuntime = createGridRuntime(
    payload.collection,
    payload.gridOpt,
    gridStreamOutput,
    // `finish` callback: flush stream chunks immediately but keep ingest
    // non-blocking to avoid stalling interaction frames. Also schedule a
    // debounced Abelian reconcile once the MOVE drill settles.
    () => {
      stream.flushNow();
      scheduleIngest();
      scheduleReconcileDebounced();
    },
    NOOP_MONITORING,
    payload.network
  );
  grid = gridRuntime.grid;

  // Live peer / request activity for the Aggregate Nodes side panel.
  if (gridRuntime.network) {
    const net = gridRuntime.network;
    if (typeof net.setActivityHandler === "function") {
      net.setActivityHandler((ev) => {
        self.postMessage({ type: "NETWORK_ACTIVITY", payload: ev });
      });
    }
    if (typeof net.setPeersHandler === "function") {
      net.setPeersHandler((peers) => {
        self.postMessage({
          type: "NETWORK_PEERS",
          payload: { peers, routingKey: readRoutingKey(net) },
        });
      });
    }
  }

  // Bootstrap pings must finish before the first MOVE/getSets, otherwise
  // sticky ingress has an empty peer table.
  // the table is empty and discoverPeers races with auth Headers.
  if (typeof gridRuntime.network?.whenReady === "function") {
    await gridRuntime.network.whenReady();
  }
  if (typeof gridRuntime.network?.listPeers === "function") {
    self.postMessage({
      type: "NETWORK_PEERS",
      payload: {
        peers: gridRuntime.network.listPeers(),
        routingKey: readRoutingKey(gridRuntime.network),
      },
    });
  }

  const cubeRuntime = createCubeRuntime(
    payload.collection,
    payload.cubeOpt,
    isCellCoveredByPolygon
  );
  cube = cubeRuntime.cube;
  cubeSpace = cubeRuntime.space;
  algorithmResolution = normalizePositiveInt(
    payload.cubeOpt?.resolution,
    DEFAULT_ALGO_RESOLUTION
  );
  cubeResolution = algorithmResolution;
  pointOverlayConfig = {
    maxPoints:
      payload.pointOverlay?.maxPoints ?? DEFAULT_POINT_OVERLAY_MAX_POINTS,
  };
  cubeSubdivisionLimit = normalizeCubeSubdivisionLimit(
    payload.cubeOpt?.limit,
    DEFAULT_CUBE_SUBDIVISION_LIMIT
  );
  cubeChildrenThreshold = normalizePositiveInt(
    payload.cubeOpt?.children,
    DEFAULT_CUBE_CHILDREN_THRESHOLD
  );
  requireCompleteChildren = payload.requireCompleteChildren !== false;
  childVirtualizationEnabled = payload.childVirtualizationEnabled !== false;
  polygonFilterEnabled = payload.polygonFilterEnabled !== false;
  valueMetricIndex = normalizeMetricIndex(
    payload.valueMetricIndex,
    COLLECTION_DEFAULTS.valueMetricIndex
  );
  if (cube?.options) cube.options.limit = cubeSubdivisionLimit;
  applyAlgorithmResolution(algorithmResolution);
  applyCubeChildrenRequirement();
  const cp = normalizeCellPositionConfig(payload.cellPosition);
  cellPositionMode = cp.mode;
  cellPositionMetricLatIndex = cp.metricLatIndex;
  cellPositionMetricLngIndex = cp.metricLngIndex;

  // Replay any MOVE that arrived during the await above.
  if (pendingMove) {
    const { zoom, bounds } = pendingMove;
    pendingMove = null;
    lastZoom = zoom;
    lastBoundsSerialized = bounds;
    grid.move(zoom, deserializeBounds(bounds, grid.space));
    requestImmediateFlush();
  }

  self.postMessage({ type: "INIT_COMPLETE" });
  scheduleReconcileIdle();
}

function handleMove(payload) {
  const start = nowMs();
  if (!grid) {
    // INIT is still awaiting WASM. Buffer this MOVE so the first
    // viewport isn't dropped — replayed at the end of INIT.
    pendingMove = payload;
    perfRecord("handleMove", nowMs() - start, { buffered: true });
    return;
  }

  // Keep cells from the in-flight move — they're often still inside
  // the new viewport and dropping them was visibly removing borders
  // during fast zoom.
  lastMoveAtMs = nowMs();
  stream.flushNow();
  scheduleIngest();

  const { zoom, bounds } = payload;
  lastZoom = zoom;
  lastBoundsSerialized = bounds;
  lastStrictBoundsSerialized = payload.strictBounds || bounds;

  grid.move(zoom, deserializeBounds(bounds, grid.space));
  pruneCubePastViewportLod();

  // Camera change MUST flush ASAP: the renderer reads the live matrix
  // every frame, and if the pack still holds cells at the previous
  // bracket the user sees a one-frame "previous-zoom flash" before
  // the new pack arrives. cube.display() hash-caches → if no bracket
  // cross happened this is essentially free.
  requestImmediateFlush();
  scheduleReconcileDebounced();
  perfRecord("handleMove", nowMs() - start, {
    pendingIngest: pendingIngest.size,
  });
}

function handleTransitionComplete(payload) {
  // Main reached transitionFactor === 1 on the GPU. Drop the previous
  // snapshot so collectCells stops merging — otherwise cells that
  // exist in `previousDisplay` but not in `currentDisplay` would render
  // forever at their old positions/values (mix(prev, cur, 1) collapses
  // to cur, but for "gone" cells the merge populates BOTH slots with
  // prev's data, so cur === prev and the cell never disappears).
  //
  // We require the snapshotVersion main observed on the LAST PACKED
  // matches the worker's current displaySnapshotVersion. If a newer
  // dataDriven flush has happened since main posted this ack, the ack
  // is stale and we must keep the still-active prev.
  if (!transitionActive || !previousDisplay) return;
  if (
    payload &&
    payload.snapshotVersion != null &&
    payload.snapshotVersion !== displaySnapshotVersion
  ) {
    return;
  }

  previousDisplay = null;
  transitionActive = false;
  transitionCellsByDepth.clear();
  transitionParentByCell.clear();

  // Re-pack at the same display (no merge this time → "gone" cells are
  // absent from the buffer). dataDriven=false so main does not start a
  // new transition.
  if (currentDisplay && cube?.get(cube.root) && lastZoom != null) {
    packAndEmit(false);
  }
}
