// Polygon-coverage WASM bridge.
//
// Wraps the compiled Emscripten module so the worker can ask "is this
// cell-bounding-box fully inside the loaded polygon?" synchronously.
// The Cube uses this to truncate recursion at fully-covered nodes,
// matching what the (now-deleted) main-thread `usePolygonCovering`
// hook used to do.
//
// Two-stage lifecycle:
//   1. `createPolygonWasm()` — async load; returns a runtime with
//      `loadGeojson()` and `isCovered()`.
//   2. `loadGeojson(geojson)` — call later (when the GeoJSON arrives
//      from the main thread). Until then `isCovered()` returns false,
//      which is safe (Cube just doesn't truncate).
//
// All the malloc/free dance lives here; callers see a tiny API.

import PolygonModule from "../../wasm/polygonCovering.js";

export async function createPolygonWasm() {
  const wasm = await PolygonModule();

  const loadPolygonFn = wasm.cwrap("load_polygon", "number", ["number"]);
  const coversFn = wasm.cwrap("covers", "number", ["number", "number"]);

  function allocateString(str) {
    const bytes = new TextEncoder().encode(str + "\0");
    const ptr = wasm._malloc(bytes.length);
    if (ptr === 0) throw new Error("WASM malloc failed (string)");
    wasm.HEAPU8.set(bytes, ptr);
    return ptr;
  }

  function allocateDoubleArray(values) {
    const bytes = values.length * Float64Array.BYTES_PER_ELEMENT;
    const ptr = wasm._malloc(bytes);
    if (ptr === 0) throw new Error("WASM malloc failed (double[])");
    new Float64Array(wasm.HEAPU8.buffer, ptr, values.length).set(values);
    return ptr;
  }

  let polygonPtr = null;

  return {
    loadGeojson(geojson) {
      const str = typeof geojson === "string" ? geojson : JSON.stringify(geojson);
      const strPtr = allocateString(str);
      const ptr = loadPolygonFn(strPtr);
      wasm._free(strPtr);
      if (!ptr) return false;
      polygonPtr = ptr;
      return true;
    },

    // Cell shape: `{ bounds: [{ south, west, north, east }] }` — same
    // as the SDK's recursion node. Returns false until `loadGeojson`
    // succeeds.
    isCovered(cell) {
      if (polygonPtr === null) return false;
      const b = cell.bounds[0];
      const ptr = allocateDoubleArray([b.south, b.west, b.north, b.east]);
      const result = coversFn(polygonPtr, ptr);
      wasm._free(ptr);
      return Boolean(result);
    },
  };
}
