// Per-frame signature cache for the layer's idle-skip fast path.
//
// MapLibre triggers `render()` for any reason (label fade, hovered
// control, neighbouring layer dirty), even when nothing about our layer
// changed. We hash the inputs that influence the pixels we'd produce
// (matrix bytes + canvas size + packed data identity + effect/mask
// versions + transition factor) and, when they all match the previous
// frame, reuse the compositor's persistent texture instead of re-running
// the WebGPU passes. Typical idle savings: ~1ms CPU + zero GPU work.
//
// `diff()` also surfaces the partial result that drives the mask-pass
// re-record decision: the mask is screen-space static once the matrix,
// canvas size and geometry version are constant.

export function matricesEqual(a, b) {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function copyMatrix(out, src) {
  for (let i = 0; i < 16; i++) out[i] = src[i];
}

export function computeEffectSignature(effect, normalizer) {
  const am = effect.areaMode ?? 0;
  const cs = effect.centroidSnap ?? 0;
  return `${effect.multiplier}|${effect.smoothEdge}|${effect.fading}|${normalizer}|${effect.colors}|${am}|${cs}`;
}

export class FrameSignatureCache {
  constructor() {
    this.matrix = new Float32Array(16);
    this.canvasW = 0;
    this.canvasH = 0;
    this.instanceData = null;
    this.effectSig = "";
    this.maskVersion = -1;
    this.heatmapOpacity = NaN;
    this.transitionFactor = NaN;
    this.valid = false;
  }

  // Returns `null` on cold cache, otherwise a cheap snapshot describing
  // which inputs changed since the last capture:
  //   { matchesAll: true }  → safe to skip the GPU passes entirely
  //   { matchesAll: false, maskUnchanged: true } → only data/effect/zoom
  //                                                changed; reuse mask
  //   { matchesAll: false, maskUnchanged: false } → mask must re-record
  diff(inputs) {
    if (!this.valid) return null;
    const matrixSame = matricesEqual(this.matrix, inputs.matrix);
    const canvasSame =
      this.canvasW === inputs.canvasW && this.canvasH === inputs.canvasH;
    const maskSame = this.maskVersion === inputs.maskVersion;
    const matchesAll =
      matrixSame &&
      canvasSame &&
      maskSame &&
      this.effectSig === inputs.effectSig &&
      this.instanceData === inputs.instanceData &&
      this.heatmapOpacity === inputs.heatmapOpacity &&
      this.transitionFactor === inputs.transitionFactor;
    return {
      matchesAll,
      maskUnchanged: matrixSame && canvasSame && maskSame,
    };
  }

  capture(inputs) {
    copyMatrix(this.matrix, inputs.matrix);
    this.canvasW = inputs.canvasW;
    this.canvasH = inputs.canvasH;
    this.instanceData = inputs.instanceData;
    this.effectSig = inputs.effectSig;
    this.maskVersion = inputs.maskVersion;
    this.heatmapOpacity = inputs.heatmapOpacity;
    this.transitionFactor = inputs.transitionFactor;
    this.valid = true;
  }

  invalidate() {
    this.valid = false;
  }
}
