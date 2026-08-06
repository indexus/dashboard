import { Item } from "../entities/item.js";
import { Set } from "../entities/set.js";
import { ROOT } from "../utilities/encoding.js";
import { asyncPool } from "../utilities/network.js";
import { State, Monitoring } from "../model/index.js";

export function project(zoom, bounds) {
  const result = [];

  let currentZoom = zoom + this.options.resolution;
  let currentBounds = this.space.extend(bounds, this.options.offset.bounds);

  const integerZoom = Math.floor(currentZoom);
  const fractionalZoom = currentZoom - integerZoom;

  if (fractionalZoom !== 0) {
    currentBounds = this.space.extend(currentBounds, -0.25 * fractionalZoom);
    currentZoom = integerZoom;
  }

  const zoomMax = Math.floor(
    zoom + this.options.resolution + this.options.offset.zoom
  );

  for (let z = 0; z <= zoomMax; z++) {
    let boundsAtZoom = currentBounds;

    // if (z < currentZoom) {
    //   const steps = currentZoom - z;
    //   for (let s = 0; s < steps; s++) {
    //     boundsAtZoom = this.space.extend(boundsAtZoom, 0.5);
    //   }
    // }

    if (z > currentZoom) {
      const steps = z - currentZoom;
      for (let s = 0; s < steps; s++) {
        boundsAtZoom = this.space.extend(boundsAtZoom, -0.25);
      }
    }

    if (z % this.space.step === 0) {
      result[z / this.space.step] = boundsAtZoom;
    }
  }

  return result;
}

async function prefetchBatchSets(list, viewportBounds) {
  const net = this.network;
  if (!net || typeof net.getSets !== "function") {
    return;
  }

  // `getSetsBatchSize === 0` disables prefetch; batching/chunking is handled by Network.setsPool.
  const configured =
    this.options &&
    this.options.network &&
    Number.isFinite(this.options.network.getSetsBatchSize)
      ? Math.floor(this.options.network.getSetsBatchSize)
      : null;

  if (configured === 0) {
    return;
  }

  const spatialPrefetch =
    this.options?.network?.spatialPrefetch !== false;

  const chunkSizeRaw =
    this.options &&
    this.options.network &&
    Number.isFinite(this.options.network.spatialPrefetchChunkSize)
      ? Math.floor(this.options.network.spatialPrefetchChunkSize)
      : 40;
  const spatialChunkSize = Math.max(4, chunkSizeRaw);

  /** Native `Set` — file imports entity `Set`, which shadows `globalThis.Set`. */
  const NativeSet = globalThis.Set;

  /** @type {Map<string, InstanceType<typeof NativeSet>>} */
  const byColl = new Map();
  for (let i = 0; i < list.length; i++) {
    const element = list[i];
    if (element._items) continue;
    const collection = element._collection;
    const hash = element._hash;
    if (!hash || hash === ROOT) continue;
    const cacheKey = `${collection}-${hash}`;
    if (this.cache.has(cacheKey)) continue;
    if (!byColl.has(collection)) {
      byColl.set(collection, new NativeSet());
    }
    byColl.get(collection).add(hash);
  }

  const tasks = [...byColl.entries()].map(([collection, hashSet]) =>
    spatialPrefetch && viewportBounds != null
      ? prefetchCollectionSpatialChunks.call(
          this,
          net,
          collection,
          hashSet,
          viewportBounds,
          spatialChunkSize
        )
      : prefetchCollectionMerged(net, collection, hashSet)
  );

  await Promise.all(tasks);
}

/**
 * Legacy path: one merged `/sets` request per collection (maximum HTTP merging).
 */
async function prefetchCollectionMerged(net, collection, hashSet) {
  await net.getSets(collection, [...hashSet]);
}

/**
 * Viewport-first: sort parent hashes by overlap with `viewportBounds`, then center distance;
 * prefetch sequentially in chunks so nearer rings populate the Network cache before farther ones.
 */
async function prefetchCollectionSpatialChunks(
  net,
  collection,
  hashSet,
  viewportBounds,
  chunkSize
) {
  const hashes = [...hashSet];
  const ranked = new Array(hashes.length);
  for (let i = 0; i < hashes.length; i++) {
    const hash = hashes[i];
    const bounds = this.getGeometry(hash).bounds;
    ranked[i] = {
      hash,
      rank: viewportPrefetchRank(this.space, viewportBounds, bounds),
    };
  }
  ranked.sort((a, b) => compareViewportPrefetchRank(a.rank, b.rank));

  for (let i = 0; i < ranked.length; i += chunkSize) {
    const slice = ranked.slice(i, i + chunkSize).map((r) => r.hash);
    await net.getSets(collection, slice);
  }
}

function viewportPrefetchRank(space, viewportBounds, cellBounds) {
  const o = space.overlap(viewportBounds, cellBounds);
  const distSq = viewportCenterDistSq(space, viewportBounds, cellBounds);
  return {
    overlaps: o.overlap,
    contained: o.contained,
    distSq,
  };
}

function compareViewportPrefetchRank(a, b) {
  if (a.overlaps !== b.overlaps) {
    return a.overlaps ? -1 : 1;
  }
  if (a.contained !== b.contained) {
    return a.contained ? -1 : 1;
  }
  return a.distSq - b.distSq;
}

/**
 * Cheap squared separation between segment centers (any dimension arity via point.value()).
 */
function viewportCenterDistSq(space, viewportBounds, cellBounds) {
  const cv = space.center(viewportBounds);
  const cc = space.center(cellBounds);
  let sum = 0;
  for (let i = 0; i < cv.length; i++) {
    const va = cv[i].value();
    const vb = cc[i].value();
    const n = Math.min(va.length, vb.length);
    for (let k = 0; k < n; k++) {
      const d = va[k] - vb[k];
      sum += d * d;
    }
  }
  return sum;
}

export async function refresh(id, list, bounds, depth, current = 0) {
  const candidates = this.arrayPool.acquire();
  const selected = this.arrayPool.acquire();
  const seen = this.seenPool.acquire();
  candidates.length = 0;
  selected.length = 0;
  const requestedConcurrency =
    typeof this.network?.getConcurrency === "function"
      ? this.network.getConcurrency()
      : list.length;
  const concurrency = Math.max(1, Math.floor(requestedConcurrency || 1));
  const targetBounds = bounds[current];

  try {
    await prefetchBatchSets.call(this, list, targetBounds);

    await asyncPool(concurrency, list, async (element) => {
      const elements = await this.process(element);
      for (let i = 0; i < elements.length; i++) {
        candidates.push(elements[i]);
      }
    });
    dedupeElementsInPlace(candidates, seen);

    await filterOverlaps.call(
      this,
      targetBounds,
      candidates,
      selected
    );

    let total = 0;
    for (let i = 0; i < list.length; i++) {
      if (!list[i]._items) total++;
    }

    this.monitoring.send(
      new Monitoring(current, State.Refresh, {
        id: id,
        depth: current,
        bounds: bounds[current],
        size: total,
      })
    );

    if (id === this.current.id) {
      if (selected.length > 0 && current < depth) {
        await this.refresh(id, selected, bounds, depth, current + 1);
      } else {
        this.stream.flushNow();
        this.finish(id);
      }
    }
  } finally {
    this.seenPool.release(seen);
    this.arrayPool.release(candidates);
    this.arrayPool.release(selected);
  }
}

function dedupeElementsInPlace(elements, seen) {
  if (!Array.isArray(elements) || elements.length === 0) return;
  let write = 0;
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    if (!element) continue;
    const key = `${element._collection}-${element._hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    elements[write] = element;
    write++;
  }
  elements.length = write;
  seen.clear();
}

async function filterOverlaps(targetBounds, candidates, selected) {
  if (!Array.isArray(candidates) || candidates.length === 0) return;

  const usedGpu =
    this.overlapAccelerator &&
    (await this.overlapAccelerator.selectOverlapping(
      targetBounds,
      candidates,
      selected
    ));

  if (!usedGpu) {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (!this.space.overlap(targetBounds, candidate._bounds).overlap) continue;
      selected.push(candidate);
    }
  }
}

export async function process(element) {
  const collection = element._collection;
  const hash = element._hash;
  const key = `${collection}-${hash}`;

  if (this.cache.has(key)) return this.cache.get(key);

  let set = element._items;
  let cacheableSource = Array.isArray(set);

  if (!set) {
    try {
      set = await this.network.getSet(collection, hash);
      cacheableSource = Array.isArray(set);
    } catch (error) {
      console.error(`Error processing element ${element}:`, error);
    }
  }

  const length = hash === ROOT ? 0 : hash.length;
  const elements = [];
  const streamElements = [];
  const merged = {};
  const source = Array.isArray(set) ? set : [];

  for (let i = 0; i < source.length; i++) {
    const elm = source[i];
    if (elm instanceof Item) {
      this.consolidate(merged, length + 1, elm);
      continue;
    }

    if (!elm._bounds || !elm._xyz) {
      const geometry = this.getGeometry(elm._hash);
      elm._bounds = geometry.bounds;
      elm._xyz = geometry.xyz;
    }
    elements.push(elm);
    streamElements.push(toCubeElement(elm, true));
  }

  const mergedValues = Object.values(merged);
  for (let i = 0; i < mergedValues.length; i++) {
    const mergedElement = mergedValues[i];
    elements.push(mergedElement);
    streamElements.push(toCubeElement(mergedElement, false));
  }

  if (cacheableSource) {
    this.cache.set(key, elements);
  }
  if (streamElements.length > 0) {
    this.stream.enqueue(streamElements);
    if (this.options?.stream?.progressive === true) {
      this.stream.flushNow();
    }
  }

  return elements;
}

function toCubeElement(element, reusable) {
  if (reusable && element.__cubeElement) {
    return element.__cubeElement;
  }

  const packed = {
    xyz: element._xyz,
    bounds: element._bounds,
    count: element._count,
    metrics: element._metrics,
    items: element._items,
    children: [],
  };

  if (reusable) {
    element.__cubeElement = packed;
  }

  return packed;
}

export function consolidate(merged, length, elm) {
  const hash = elm._hash.substring(0, length);
  const set = merged[hash];

  if (!set) {
    const metrics = Array.isArray(elm._metrics)
      ? elm._metrics.slice()
      : elm._metrics;
    const n = new Set(elm._collection, hash, 1, metrics);

    const geometry = this.getGeometry(n._hash);
    n._bounds = geometry.bounds;
    n._xyz = geometry.xyz;
    n._items = [elm];

    merged[hash] = n;
    return;
  }

  set._count++;
  set._items.push(elm);
  const itemMetrics = elm._metrics;
  if (!Array.isArray(itemMetrics)) return;

  if (!Array.isArray(set._metrics)) {
    set._metrics = itemMetrics.slice();
    return;
  }

  if (itemMetrics.length > set._metrics.length) {
    const previousLength = set._metrics.length;
    set._metrics.length = itemMetrics.length;
    for (let i = previousLength; i < itemMetrics.length; i++) {
      set._metrics[i] = 0;
    }
  }

  for (let i = 0; i < itemMetrics.length; i++) {
    set._metrics[i] += itemMetrics[i];
  }
}
