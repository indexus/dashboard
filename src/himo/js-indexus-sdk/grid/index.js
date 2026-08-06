import { Set } from "../entities/set.js";
import { createStreamCoalescer } from "./streamCoalescer.js";
import { createArrayPool, createSetPool } from "../utilities/bufferPool.js";
import { createGpuOverlapAccelerator } from "../utilities/gpuOverlap.js";

import { project, refresh, consolidate, process } from "./layer.js";

class Grid {
  constructor(collection, space, options, stream, finish, monitoring, network) {
    this.collection = collection;
    this.space = space;
    this.options = options;
    this.streamOutput = stream;
    this.finish = finish;
    this.monitoring = monitoring;
    this.network = network;

    this.current = {};
    this.cache = new Map();
    this.arrayPool = createArrayPool(8);
    this.seenPool = createSetPool(4);
    const gpuOptions = options && typeof options.gpu === "object" ? options.gpu : {};
    this.overlapAccelerator = createGpuOverlapAccelerator({
      enabled: gpuOptions.enabled !== false,
      minElements: Number.isFinite(gpuOptions.minElements)
        ? Math.max(1, Math.floor(gpuOptions.minElements))
        : 1024,
    });
    const geometryCacheSize =
      options &&
      options.cache &&
      Number.isFinite(options.cache.geometrySize)
        ? Math.max(256, Math.floor(options.cache.geometrySize))
        : 20000;
    this.geometryCache = new Map();
    this.geometryCacheSize = geometryCacheSize;
    this.root = new Set(collection, "@", undefined, undefined);

    const streamOptions =
      options && typeof options.stream === "object" ? options.stream : {};
    const streamProgressive = streamOptions.progressive === true;
    const defaultMinBatch = streamProgressive ? 8 : 128;
    const defaultFlushMs = streamProgressive ? 4 : 16;
    const minBatch = Number.isFinite(streamOptions.minBatch)
      ? Math.max(1, Math.floor(streamOptions.minBatch))
      : defaultMinBatch;
    const flushMs = Number.isFinite(streamOptions.flushMs)
      ? Math.max(0, Math.floor(streamOptions.flushMs))
      : defaultFlushMs;

    this.stream = createStreamCoalescer({
      minBatch,
      flushMs,
      applyBatch: (elements) => this.streamOutput(elements),
    });
  }

  async move(zoom, bounds) {
    const depth = Math.floor(
      (zoom + this.options.resolution + this.options.offset.zoom) /
        this.space.step
    );
    const hash = this.space.encode(this.space.center(bounds), depth);

    if (this.current.hash === hash) return;

    // Ensure previous trailing stream batches are visible before
    // scheduling a new traversal wave.
    this.stream.flushNow();

    const id = crypto.randomUUID();
    this.current = { hash, id };

    this.refresh(id, [this.root], this.project(zoom, bounds), depth);
  }

  getGeometry(hash) {
    if (this.geometryCache.has(hash)) {
      const cached = this.geometryCache.get(hash);
      this.geometryCache.delete(hash);
      this.geometryCache.set(hash, cached);
      return cached;
    }

    const geometry = {
      bounds: this.space.decode(hash),
      xyz: this.space.xyz(hash),
    };

    if (this.geometryCache.size >= this.geometryCacheSize) {
      const firstKey = this.geometryCache.keys().next().value;
      this.geometryCache.delete(firstKey);
    }
    this.geometryCache.set(hash, geometry);
    return geometry;
  }

}

Grid.prototype.project = project;
Grid.prototype.refresh = refresh;
Grid.prototype.process = process;
Grid.prototype.consolidate = consolidate;

export { Grid };
