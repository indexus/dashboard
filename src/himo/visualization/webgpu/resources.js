/* global GPUBufferUsage, GPUTextureUsage */

// WebGPU buffer/texture/sampler factories. Pure functions: each one takes a
// device and returns the resource(s) it created — no hidden state.

import { MASK_FORMAT } from "./constants";

const UNIT_SQUARE_VERTICES = new Float32Array([
  0, 0, 1, 0, 0, 1,
  0, 1, 1, 0, 1, 1,
]);

export function createUnitSquareBuffer(device) {
  const buffer = device.createBuffer({
    size: UNIT_SQUARE_VERTICES.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, UNIT_SQUARE_VERTICES);
  return buffer;
}

// Three uniform buffers, sized for their respective shader uniforms.
//   mask:      mat4                                             (64 bytes)
//   accum:     mat4 + 4 floats (smoothEdge/multiplier/
//             transitionFactor/zoom) + 4 floats
//             (resolutionConstant + 3 pad)                      (96 bytes)
//   normalize: 4 floats (normalizer, fading, pad, pad)          (16 bytes)
export function createUniformBuffers(device) {
  return {
    mask: device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
    accum: device.createBuffer({
      size: 64 + 16 + 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
    normalize: device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
  };
}

// Allocates the two per-frame target textures (mask + accumulation) for the
// current canvas size. Returns the textures, their views, and a `dispose()`
// to release them when resizing.
export function createTargetTextures(device, width, height, accumFormat) {
  const accum = device.createTexture({
    size: [width, height, 1],
    format: accumFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const mask = device.createTexture({
    size: [width, height, 1],
    format: MASK_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  return {
    accum,
    accumView: accum.createView(),
    mask,
    maskView: mask.createView(),
    dispose() {
      accum.destroy();
      mask.destroy();
    },
  };
}
