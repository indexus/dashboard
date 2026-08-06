// Geometric ArrayBuffer pool.
//
// We pack per-snapshot instance data into a Float32Array and transfer
// the underlying buffer to the main thread (`postMessage(... [buffer])`).
// Without a pool, every flush would allocate a fresh ArrayBuffer →
// V8 produces sustained GC pressure during streaming + panning.
//
// Lifecycle:
//   - `acquire(neededEntries)` returns a buffer big enough for the
//     pack (re-using an existing free buffer when possible, otherwise
//     growing geometrically).
//   - `release(buffer)` returns a buffer to the pool. The main thread
//     posts back via RELEASE_PACKED after it has finished `writeBuffer`.
//     Detached buffers (byteLength === 0) are dropped silently.
//
// `maxIdle` caps memory: ~2 buffers are typically in flight (one being
// uploaded on main, one being prepped on worker), so 4 is plenty.

export function createBufferPool(bytesPerEntry, maxIdle = 4) {
  const pool = [];

  return {
    acquire(neededEntries) {
      const neededBytes = neededEntries * bytesPerEntry;
      for (let i = 0; i < pool.length; i++) {
        if (pool[i].byteLength >= neededBytes) {
          return pool.splice(i, 1)[0];
        }
      }
      const lastBuf = pool.pop();
      const lastEntries = lastBuf ? lastBuf.byteLength / bytesPerEntry : 0;
      const targetEntries = Math.max(neededEntries, lastEntries * 2, 256);
      return new ArrayBuffer(targetEntries * bytesPerEntry);
    },

    release(buffer) {
      if (!buffer || buffer.byteLength === 0) return;
      if (pool.length < maxIdle) pool.push(buffer);
    },
  };
}
