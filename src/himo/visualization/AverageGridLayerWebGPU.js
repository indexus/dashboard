// AverageGridLayerWebGPU
//
// Orchestrates a WebGPU heatmap pipeline (mask → accumulation → normalize)
// and composites the result into MapLibre's WebGL framebuffer.
//
// Integration mode: TEXTURE HANDOFF.
//   1) WebGPU draws into an OffscreenCanvas (alphaMode: "premultiplied").
//   2) The OffscreenCanvas is uploaded into a WebGL texture inside MapLibre's
//      `render(gl, options)` callback (direct upload via WebGL2).
//   3) The texture is drawn as a fullscreen quad with premultiplied-alpha
//      blending, so map labels / water / borders remain on top.
//
// Idle-frame fast path: see `webgpu/frameSignature.js`.
//
// Mask pass is also re-recorded only when projection / canvas size / mask
// geometry changes (the polygon is screen-space static once any of those is
// constant).

import { PRESENTATION_FORMAT } from "./webgpu/constants";
import {
  FrameSignatureCache,
  computeEffectSignature,
  copyMatrix,
} from "./webgpu/frameSignature";
import { InstanceBuffer } from "./webgpu/instances";
import { uploadMaskGeometry } from "./webgpu/maskGeometry";
import {
  recordAccumPass,
  recordMaskPass,
  recordNormalizePass,
} from "./webgpu/passes";
import {
  colorRampSignature,
  createAccumPipeline,
  createMaskPipeline,
  createNormalizePipeline,
} from "./webgpu/pipelines";
import {
  createTargetTextures,
  createUniformBuffers,
  createUnitSquareBuffer,
} from "./webgpu/resources";
import {
  writeAccumUniform,
  writeMaskUniform,
  writeNormalizeUniform,
} from "./webgpu/uniforms";
import { WebGLCompositor } from "./webgpu/webglComposite";

class AverageGridLayerWebGPU {
  constructor(id, controller, device, features) {
    this.id = id;
    this.type = "custom";
    this.renderingMode = "2d";
    this.controller = controller;
    this.device = device;
    this.accumFormat = pickAccumFormat(device, features);

    this.geojson = null;
    this.maskEnabled = true;

    // Surface state.
    this.offscreen = null;
    this.context = null;
    this.presentationFormat = PRESENTATION_FORMAT;
    this.canvasWidth = 0;
    this.canvasHeight = 0;

    // GPU resources (allocated in onAdd).
    this.unitSquareBuffer = null;
    this.uniformBuffers = null;
    this.maskPipeline = null;
    this.accumPipeline = null;
    this.normalizePipeline = null;
    this.normalizeRampSignature = "";
    this.maskGeometry = null; // { vertexBuffer, indexBuffer, indexCount, dispose }
    this.maskVersion = 0; // bumped on uploadMask
    this.instances = null; // InstanceBuffer
    this.targets = null; // { accum, mask, accumView, maskView, dispose }

    // Bind groups (rebuilt when their underlying resources change).
    this.maskBindGroup = null;
    this.accumBindGroup = null;
    this.normalizeBindGroup = null;

    // Idle-skip cache + scratch matrix (Float32 copy of MapLibre's Float64
    // mercatorMatrix; equality compares apples to apples).
    this.frameSig = new FrameSignatureCache();
    this.scratchMatrix = new Float32Array(16);

    // WebGL composite (lives in MapLibre's gl context).
    this.gl = null;
    this.glCanvas = null;
    this.compositor = null;
    /** Last debug label emitted when `controller.debugHeatmap` is set. */
    this._heatmapDbgPath = "";
  }

  // --------------------------------------------------------------------------
  // MapLibre custom-layer hooks
  // --------------------------------------------------------------------------

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;
    this.glCanvas = gl.canvas;

    if (typeof OffscreenCanvas === "undefined") {
      console.error(
        "[AverageGridLayerWebGPU] OffscreenCanvas unavailable; cannot run texture handoff."
      );
      return;
    }

    this.offscreen = new OffscreenCanvas(1, 1);
    const context = this.offscreen.getContext("webgpu");
    if (!context) {
      console.error(
        "[AverageGridLayerWebGPU] webgpu context unavailable on OffscreenCanvas"
      );
      return;
    }
    this.context = context;

    // Force rgba8unorm + srgb so the bytes the OffscreenCanvas exposes line
    // up exactly with the WebGL upload path (gl.RGBA, gl.UNSIGNED_BYTE,
    // default sRGB). On platforms that prefer bgra8unorm, the format
    // mismatch forces Chromium to fall back to the slow Canvas2D readback
    // path on every frame.
    context.configure({
      device: this.device,
      format: this.presentationFormat,
      alphaMode: "premultiplied",
      colorSpace: "srgb",
    });

    this.allocateResources();
    this.resizeIfNeeded();
    if (this.geojson) this.uploadMask();

    console.info(
      `[AverageGridLayerWebGPU] presentationFormat=${this.presentationFormat}`
    );
  }

  onRemove() {
    this.context = null;
    this.offscreen = null;

    this.unitSquareBuffer?.destroy();
    if (this.uniformBuffers) {
      this.uniformBuffers.mask.destroy();
      this.uniformBuffers.accum.destroy();
      this.uniformBuffers.normalize.destroy();
    }
    this.maskGeometry?.dispose();
    this.instances?.dispose();
    this.targets?.dispose();
    this.compositor?.dispose();

    this.unitSquareBuffer = null;
    this.uniformBuffers = null;
    this.maskGeometry = null;
    this.instances = null;
    this.targets = null;
    this.compositor = null;
    this.gl = null;
  }

  render() {
    if (!this.context || !this.offscreen) return;

    const matrix = this.readMatrix();
    if (!matrix) return;

    this.resizeIfNeeded();
    if (!this.targets || this.canvasWidth === 0 || this.canvasHeight === 0) {
      return;
    }

    // Read every controller-supplied input ONCE per frame. They are queried
    // by several downstream helpers (idle-skip signature, packed data
    // caching, uniform writers, color-ramp pipeline). Reading them multiple
    // times wastes microseconds and, more importantly, getZoom() can drift
    // mid-render during animations.
    const { controller } = this;
    const zoom = controller.getZoom();
    const resolutionConstant = controller.getResolutionConstant();
    const effect = controller.getEffect();
    const normalizer = controller.getNormalizer();
    const heatmapOpacity = controller.getHeatmapOpacity
      ? controller.getHeatmapOpacity()
      : 1;
    const transitionFactor = controller.getTransitionFactor();

    this.ensureNormalizePipeline(effect);

    const packed = controller.getPackedData(zoom);

    const emptyPack = !packed || packed.count === 0;
    const hasComposite = !!this.compositor?.hasValidComposite?.();
    if (emptyPack && hasComposite) {
      if (controller.debugHeatmap && this._heatmapDbgPath !== "blit-empty-pack") {
        console.info("[heatmap-gpu]", "path: blit-empty-pack", {
          heatmapOpacity,
          transitionFactor,
        });
        this._heatmapDbgPath = "blit-empty-pack";
      }
      this.compositor.blit();
      return;
    }

    const sigInputs = {
      matrix,
      canvasW: this.canvasWidth,
      canvasH: this.canvasHeight,
      instanceData: packed && packed.count > 0 ? packed.data : null,
      effectSig: computeEffectSignature(effect, normalizer),
      maskVersion: this.maskVersion,
      heatmapOpacity,
      transitionFactor,
    };

    // ---- Idle-frame fast path ---------------------------------------------
    const diff = this.frameSig.diff(sigInputs);
    if (controller.debugHeatmap) {
      const path = diff?.matchesAll ? "idle-skip" : "full-pipeline";
      const riskyClear = emptyPack && !hasComposite;
      const effectivePath = riskyClear ? "full-pipeline-clear-risk" : path;
      if (effectivePath !== this._heatmapDbgPath) {
        console.info("[heatmap-gpu]", `path: ${effectivePath}`, {
          packedCount: packed?.count ?? 0,
          heatmapOpacity,
        });
        this._heatmapDbgPath = effectivePath;
      }
    }
    if (diff && diff.matchesAll) {
      this.compositor.blit();
      return;
    }

    // ---- Full pipeline ----------------------------------------------------
    const needMask = !diff || !diff.maskUnchanged;
    this.frameSig.capture(sigInputs);

    this.writeFrameUniforms(
      matrix,
      transitionFactor,
      zoom,
      resolutionConstant,
      effect,
      normalizer,
      heatmapOpacity
    );

    const cmd = this.device.createCommandEncoder();

    if (needMask) {
      recordMaskPass(cmd, this.maskPassContext());
    }

    const accumCtx = this.accumPassContext(packed);
    recordAccumPass(cmd, accumCtx);

    if (!recordNormalizePass(cmd, this.normalizePassContext())) {
      // Surface lost / dropped frame; the next one will reacquire. Don't
      // trust the cached frame state until we successfully encode again.
      this.frameSig.invalidate();
      return;
    }

    this.device.queue.submit([cmd.finish()]);

    // Hand the WebGPU result over to MapLibre's WebGL framebuffer at this
    // layer's compositing slot (before "Water"), so labels stay on top.
    this.compositor.upload(this.offscreen, this.canvasWidth, this.canvasHeight);
    this.compositor.blit();
  }

  // --------------------------------------------------------------------------
  // Public API parity with the WebGL layer
  // --------------------------------------------------------------------------

  initializeMask(geojson) {
    this.geojson = geojson;
    if (this.device && this.context) this.uploadMask();
  }

  setMaskEnabled(enabled) {
    const next = enabled !== false;
    if (this.maskEnabled === next) return;
    this.maskEnabled = next;
    this.frameSig.invalidate();
  }

  // --------------------------------------------------------------------------
  // Resource allocation
  // --------------------------------------------------------------------------

  allocateResources() {
    this.unitSquareBuffer = createUnitSquareBuffer(this.device);
    this.uniformBuffers = createUniformBuffers(this.device);
    this.maskPipeline = createMaskPipeline(this.device);
    this.accumPipeline = createAccumPipeline(this.device, this.accumFormat);
    // normalizePipeline is created lazily in `ensureNormalizePipeline`.
    this.instances = new InstanceBuffer(this.device);
    this.compositor = new WebGLCompositor(this.gl);
    this.compositor.init();
  }

  ensureNormalizePipeline(effect) {
    const sig = colorRampSignature(
      effect.colors,
      effect.colorInterpolation,
      this.presentationFormat
    );
    if (sig === this.normalizeRampSignature && this.normalizePipeline) return;
    this.normalizePipeline = createNormalizePipeline(
      this.device,
      this.presentationFormat,
      effect.colors,
      effect.colorInterpolation
    );
    this.normalizeRampSignature = sig;
    this.normalizeBindGroup = null; // force rebuild against the new layout
    // Palette changed: cached "idle frame" texture is now stale, force a full
    // normalize pass on the next render so colors repaint immediately.
    this.frameSig.invalidate();
  }

  uploadMask() {
    if (!this.device || !this.geojson) return;
    this.maskGeometry?.dispose();
    this.maskGeometry = uploadMaskGeometry(this.device, this.geojson);
    this.maskVersion += 1;
    this.frameSig.invalidate();
  }

  // --------------------------------------------------------------------------
  // Per-frame plumbing
  // --------------------------------------------------------------------------

  // Reads `transform.mercatorMatrix` (mercator [0,1] -> clip), which
  // MapLibre keeps in lock-step with `_calcMatrices()` every frame so it
  // can never desync from the camera animation. We enforce
  // `projection: "mercator"` in MapScreen, so this matrix is always
  // present.
  //
  // Returns `scratchMatrix` (a Float32Array) so the per-frame equality
  // check compares apples to apples — the transform exposes a
  // Float64Array, and storing a Float32 copy is what makes idle-skip
  // reliable.
  readMatrix() {
    const mat = this.map?.transform?.mercatorMatrix;
    if (!mat || mat.length < 16) return null;
    copyMatrix(this.scratchMatrix, mat);
    return this.scratchMatrix;
  }

  resizeIfNeeded() {
    if (!this.glCanvas || !this.offscreen) return;
    const w = this.glCanvas.width;
    const h = this.glCanvas.height;
    if (w === this.canvasWidth && h === this.canvasHeight) return;
    if (w === 0 || h === 0) return;

    this.offscreen.width = w;
    this.offscreen.height = h;
    this.canvasWidth = w;
    this.canvasHeight = h;

    this.targets?.dispose();
    this.targets = createTargetTextures(this.device, w, h, this.accumFormat);
    this.normalizeBindGroup = null; // depends on the new texture views
    this.compositor?.invalidateTextureSize();
    this.frameSig.invalidate(); // every cached signature is stale
  }

  writeFrameUniforms(
    matrix,
    transitionFactor,
    zoom,
    resolutionConstant,
    effect,
    normalizer,
    heatmapOpacity
  ) {
    writeMaskUniform(this.device, this.uniformBuffers.mask, matrix);
    writeAccumUniform(
      this.device,
      this.uniformBuffers.accum,
      matrix,
      effect.smoothEdge,
      effect.multiplier,
      transitionFactor,
      zoom,
      resolutionConstant,
      effect.centroidSnap ? 1 : 0,
      effect.areaMode ? 1 : 0
    );
    writeNormalizeUniform(
      this.device,
      this.uniformBuffers.normalize,
      normalizer,
      effect.fading,
      heatmapOpacity,
      this.maskEnabled
    );
  }

  // --------------------------------------------------------------------------
  // Pass contexts
  // --------------------------------------------------------------------------

  maskPassContext() {
    if (!this.maskBindGroup) {
      this.maskBindGroup = this.device.createBindGroup({
        layout: this.maskPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffers.mask } },
        ],
      });
    }
    return {
      maskView: this.targets.maskView,
      pipeline: this.maskPipeline,
      bindGroup: this.maskBindGroup,
      vertexBuffer: this.maskGeometry?.vertexBuffer ?? null,
      indexBuffer: this.maskGeometry?.indexBuffer ?? null,
      indexCount: this.maskGeometry?.indexCount ?? 0,
    };
  }

  accumPassContext(packed) {
    const instanceCount = this.instances.uploadPacked(packed);
    if (!this.accumBindGroup) {
      this.accumBindGroup = this.device.createBindGroup({
        layout: this.accumPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffers.accum } },
        ],
      });
    }
    return {
      accumView: this.targets.accumView,
      pipeline: this.accumPipeline,
      bindGroup: this.accumBindGroup,
      unitSquareBuffer: this.unitSquareBuffer,
      instanceBuffer: this.instances.buffer,
      instanceCount,
    };
  }

  normalizePassContext() {
    if (!this.normalizeBindGroup) {
      this.normalizeBindGroup = this.device.createBindGroup({
        layout: this.normalizePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffers.normalize } },
          { binding: 1, resource: this.targets.accumView },
          { binding: 2, resource: this.targets.maskView },
        ],
      });
    }
    return {
      context: this.context,
      pipeline: this.normalizePipeline,
      bindGroup: this.normalizeBindGroup,
    };
  }
}

// Match the WebGL pipeline's FLOAT accumulation FBO whenever the runtime
// exposes 32-bit float blending; otherwise fall back to rgba16float
// (last-bucket banding in dense areas, possible Inf if metric sums get
// large).
function pickAccumFormat(device, features) {
  const supports32fBlend =
    features?.float32Blendable === true ||
    device.features?.has?.("float32-blendable") === true;
  if (!supports32fBlend) {
    console.warn(
      "[AverageGridLayerWebGPU] float32-blendable unavailable; using rgba16float accumulation (precision degraded)"
    );
  }
  return supports32fBlend ? "rgba32float" : "rgba16float";
}

export default AverageGridLayerWebGPU;
