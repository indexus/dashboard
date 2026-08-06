// WebGPU heatmap renderer — shared sizes and formats.
//
// Per-instance layout (see ACCUM_SHADER):
//   vec4<f32> currentLatLng    = (curLat, curLng, curParentLat, curParentLng)   [16B]
//   vec4<f32> previousLatLng   = (prevLat, prevLng, prevParentLat, prevParentLng) [16B]
//   vec4<f32> values           = (currentNominator, currentDenominator, resolution, slotResolution) [16B]
//   vec2<f32> previousValues   = (previousNominator, previousDenominator)       [ 8B]
//
// The previous* slots carry the cell's pre-reconciliation state; the accum
// vertex shader does `mix(previous, current, u.transitionFactor)` for both
// the position blend AND the value blend, so the CPU pack pass no longer
// depends on transitionFactor (was per-frame) — only on the snapshot pair.
// That keeps the pack cache hot during transitions and makes the GPU the
// sole owner of all temporal interpolation.
//
// `resolution`     — the cell's TRUE depth. Drives geometry size
//                    (latStep/lngStep ∝ 1 / 2^resolution) and the
//                    cell→parent fractional-zoom morph, so a coarse
//                    fallback cell renders at its actual large-disk size.
// `slotResolution` — the depth tier the cell occupies in the multi-LOD
//                    pack. For natural cells `slotResolution === resolution`.
//                    For parent-fallback cells (coarse cells substituted
//                    into an empty finer slot when finer data hasn't
//                    streamed in yet) `slotResolution` is the empty slot's
//                    depth, so the shader's triangle LOD kernel keeps them
//                    visible at the live zoom even though their TRUE depth
//                    is far away.
//
// The vertex shader derives a continuous `liveDepth = u.zoom +
// u.resolutionConstant` and computes per-instance LOD weight from
// `slotResolution` and zoomDelta from `resolution`, so the pack stays
// valid across an in-band bracket change with no CPU work.
//
// Optional future (pack path): extra depth slots center±2 near fract(liveDepth)
// boundaries if tier gaps are observed; worker today emits [center-1..center+1].

export const FLOATS_PER_INSTANCE = 14;
export const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

// Renderer formats.
export const MASK_FORMAT = "rgba8unorm";

// Forced canvas format. Matches the WebGL upload path
// (gl.RGBA, gl.UNSIGNED_BYTE) so handoff stays on the GPU-to-GPU fast path
// and never falls back to Canvas2D readback in Chromium.
export const PRESENTATION_FORMAT = "rgba8unorm";
