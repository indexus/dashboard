/* global GPUColorWrite */

// WebGPU render-pipeline factories. One factory per pass keeps the layout
// declaration co-located with the shader it targets.

import {
  MASK_SHADER,
  ACCUM_SHADER,
  buildNormalizeShader,
  generateColorRampWgsl,
} from "./shaders";
import { BYTES_PER_INSTANCE, MASK_FORMAT } from "./constants";

export function createMaskPipeline(device) {
  const module = device.createShaderModule({ code: MASK_SHADER });
  return device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module,
      entryPoint: "vs_main",
      buffers: [
        {
          arrayStride: 8,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [{ format: MASK_FORMAT }],
    },
    primitive: { topology: "triangle-list" },
  });
}

export function createAccumPipeline(device, accumFormat) {
  const module = device.createShaderModule({ code: ACCUM_SHADER });
  return device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module,
      entryPoint: "vs_main",
      buffers: [
        {
          arrayStride: 8,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
        },
        {
          arrayStride: BYTES_PER_INSTANCE,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 1, offset: 0, format: "float32x4" },
            { shaderLocation: 2, offset: 16, format: "float32x4" },
            { shaderLocation: 3, offset: 32, format: "float32x4" },
            { shaderLocation: 4, offset: 48, format: "float32x2" },
          ],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [
        {
          format: accumFormat,
          blend: {
            color: { srcFactor: "one", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });
}

// Compiled lazily when the controller's color ramp / bucket count change.
// Returns both the pipeline and the signature that produced it so callers
// can cache + invalidate cheaply.
export function createNormalizePipeline(
  device,
  presentationFormat,
  colors,
  colorInterpolation
) {
  const ramp = generateColorRampWgsl(colors, colorInterpolation);
  const module = device.createShaderModule({
    code: buildNormalizeShader(ramp),
  });

  return device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs_main" },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [
        {
          format: presentationFormat,
          // No blending — the OffscreenCanvas is cleared at the start of
          // each pass and the shader emits premultiplied alpha. The WebGL
          // composite step does the actual alpha-over against the map.
          writeMask: GPUColorWrite.ALL,
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });
}

export function colorRampSignature(colors, colorInterpolation, format) {
  // Do not rely on function identity / source length: d3 scales with
  // different ranges can stringify to the same shape, which would keep
  // the old normalize pipeline and therefore the wrong heatmap colors.
  // Fingerprint the actual ramp output at fixed samples instead.
  if (typeof colorInterpolation !== "function") {
    return `${colors}|none|${format}`;
  }
  const samples = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let value = "";
    try {
      value = String(colorInterpolation(t));
    } catch {
      value = "";
    }
    samples.push(value);
  }
  return `${colors}|${samples.join(",")}|${format}`;
}
