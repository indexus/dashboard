/* global GPUBufferUsage */

// Per-frame instance buffer manager. Owns a single GPU vertex buffer that
// grows geometrically. The app produces a pre-packed Float32Array laid out
// exactly like the per-instance attribute layout, so a single writeBuffer
// call is all this needs to do per frame.

import { BYTES_PER_INSTANCE } from "./constants";

export class InstanceBuffer {
  constructor(device) {
    this.device = device;
    this.buffer = null;
    this.capacity = 0;
  }

  ensureCapacity(instanceCount) {
    if (instanceCount <= this.capacity) return;

    const next = Math.max(instanceCount, this.capacity * 2, 256);
    if (this.buffer) this.buffer.destroy();

    this.buffer = this.device.createBuffer({
      size: next * BYTES_PER_INSTANCE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.capacity = next;
  }

  uploadPacked(packed) {
    if (!packed || !packed.data || packed.count <= 0) return 0;
    const n = packed.count;
    this.ensureCapacity(n);
    this.device.queue.writeBuffer(
      this.buffer,
      0,
      packed.data.buffer,
      packed.data.byteOffset,
      n * BYTES_PER_INSTANCE
    );
    return n;
  }

  dispose() {
    if (this.buffer) this.buffer.destroy();
    this.buffer = null;
    this.capacity = 0;
  }
}
