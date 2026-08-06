// Coalesces a stream of cell deliveries into batches.
//
// The Grid SDK calls `stream(elements)` once per network response, often
// with only a handful of cells (~5 cells/call in profiling). Calling
// `cube.set([fewCells])` on each delivery preserves the SDK's parent-merge
// semantics but pays the recursion overhead for every chunk. Coalescing
// into larger batches keeps the same semantics (one batch → one cube.set
// call) at a fraction of the CPU.
//
// Two flush triggers:
//   1. Buffer reaches `minBatch` cells → flush immediately.
//   2. Otherwise after `flushMs` ms of no new arrivals → flush trailing.
//
// `flushNow()` is what callers invoke when they need the buffer drained
// synchronously (e.g. on viewport change so the next `display()` sees the
// post-move dataset).

export function createStreamCoalescer({ minBatch, flushMs, applyBatch }) {
  let buffer = [];
  let timer = null;

  function flush() {
    timer = null;
    if (buffer.length === 0) return;
    const payload = buffer;
    buffer = [];
    applyBatch(payload);
  }

  return {
    enqueue(elements) {
      if (!Array.isArray(elements) || elements.length === 0) return;
      // Push in place; concat would allocate a new array per chunk
      // (O(N²) total during heavy streaming).
      for (let i = 0; i < elements.length; i++) buffer.push(elements[i]);

      if (buffer.length >= minBatch) {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        flush();
        return;
      }
      if (timer === null) timer = setTimeout(flush, flushMs);
    },

    flushNow() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (buffer.length > 0) flush();
    },
  };
}
