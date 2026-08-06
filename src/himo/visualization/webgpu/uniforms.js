// Pure uniform writers. They do not own buffers — they only know how to lay
// out the bytes for each of the three render passes.
//
// Each writer reuses a module-scope scratch Float32Array so per-frame uniform
// updates don't allocate.

const MASK_SCRATCH = new Float32Array(16);
const ACCUM_SCRATCH = new Float32Array(24);
const NORMALIZE_SCRATCH = new Float32Array(4);

export function writeMaskUniform(device, buffer, matrix) {
  for (let i = 0; i < 16; i++) MASK_SCRATCH[i] = matrix[i];
  device.queue.writeBuffer(buffer, 0, MASK_SCRATCH);
}

// mat4 (16 floats) + smoothEdge + multiplier + transitionFactor + zoom +
// resolutionConstant + centroidSnap + areaMode + pad.
//
// The shader derives a continuous live depth `zoom + resolutionConstant`
// and computes per-instance LOD weight and zoomDelta from it. Packed
// instance data therefore stays stable across continuous zoom animation
// (= cache hit in App.getPackedData) AND across in-band bracket changes
// (= the worker keeps a 3-depth band live, GPU re-weights what it has).
export function writeAccumUniform(
  device,
  buffer,
  matrix,
  smoothEdge,
  multiplier,
  transitionFactor,
  zoom,
  resolutionConstant,
  centroidSnap,
  areaMode
) {
  const data = ACCUM_SCRATCH;
  for (let i = 0; i < 16; i++) data[i] = matrix[i];
  data[16] = smoothEdge;
  data[17] = multiplier;
  data[18] = transitionFactor;
  data[19] = zoom;
  data[20] = resolutionConstant;
  data[21] = centroidSnap ? 1 : 0;
  data[22] = areaMode ? 1 : 0;
  data[23] = 0;
  device.queue.writeBuffer(buffer, 0, data);
}

// 4 floats: (normalizer, fading, heatmapOpacity, maskEnabled).
export function writeNormalizeUniform(
  device,
  buffer,
  normalizer,
  fading,
  heatmapOpacity,
  maskEnabled
) {
  const data = NORMALIZE_SCRATCH;
  data[0] = normalizer;
  data[1] = fading;
  data[2] = heatmapOpacity;
  data[3] = maskEnabled ? 1 : 0;
  device.queue.writeBuffer(buffer, 0, data);
}
