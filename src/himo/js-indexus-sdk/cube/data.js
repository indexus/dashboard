export function create(xyz, bounds, count, metrics, items, children) {
  return {
    xyz,
    bounds,
    count,
    metrics,
    items,
    children,
  };
}

export function equal(element1, element2) {
  return JSON.stringify(element1) === JSON.stringify(element2);
}

export function add(element) {
  this.data[this.key(element.xyz)] = element;
}

export function get(xyz) {
  return this.data[this.key(xyz)];
}

export function key(xyz) {
  let output = `${xyz.resolution}`;
  for (let i = 0; i < xyz.coordinates.length; i++) {
    output += `-${xyz.coordinates[i]}`;
  }
  return output;
}

export function parent(xyz) {
  if (!xyz.resolution) {
    return null;
  }
  const coordinates = new Array(xyz.coordinates.length);
  for (let i = 0; i < xyz.coordinates.length; i++) {
    coordinates[i] = Math.floor(xyz.coordinates[i] / 2);
  }
  return {
    resolution: xyz.resolution - 1,
    coordinates,
  };
}

export function children(xyz) {
  const resolution = xyz.resolution + 1;
  const coordinates = xyz.coordinates;
  const dimensions = coordinates.length;
  const length = 2 ** dimensions;
  const children = new Array(length);

  for (let mask = 0; mask < length; mask++) {
    const childCoordinates = new Array(dimensions);
    for (let i = 0; i < dimensions; i++) {
      const bit = (mask >> (dimensions - 1 - i)) & 1;
      childCoordinates[i] = coordinates[i] * 2 + bit;
    }
    children[mask] = {
      resolution,
      coordinates: childCoordinates,
    };
  }
  return children;
}

export function set(elements) {
  const parents = {};
  let keep = elements.length;

  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    const existing = this.get(element.xyz);

    if (existing) {
      keep--;
    }

    if (!existing || existing.children.length === 0) {
      this.add(element);
    }

    this.merge(parents, element);
  }

  if (keep) {
    this.set(Object.values(parents));
  }
}

export function merge(parents, element) {
  const xyz = this.parent(element.xyz);

  if (!xyz) return;

  const key = this.key(xyz);
  const parent = parents[key];

  if (!parent) {
    const metrics = Array.isArray(element.metrics)
      ? element.metrics.slice()
      : element.metrics;
    parents[key] = this.create(
      xyz,
      this.space.bounds(xyz),
      element.count,
      metrics,
      undefined,
      [element.xyz]
    );
    return;
  }

  parent.count += element.count;
  const elementMetrics = element.metrics;
  if (Array.isArray(elementMetrics)) {
    if (!Array.isArray(parent.metrics)) {
      parent.metrics = elementMetrics.slice();
    } else {
      if (elementMetrics.length > parent.metrics.length) {
        const previousLength = parent.metrics.length;
        parent.metrics.length = elementMetrics.length;
        for (let i = previousLength; i < elementMetrics.length; i++) {
          parent.metrics[i] = 0;
        }
      }
      for (let i = 0; i < elementMetrics.length; i++) {
        parent.metrics[i] += elementMetrics[i];
      }
    }
  }
  parent.children.push(element.xyz);
}

/**
 * @param {"visual" | "items"} purpose
 *   - visual: respect `options.limit` (seuil de zone ; 0 = ne coupe pas la descente sur ce seuil seul) and `options.children` (enfants complets).
 *   - items: descend through every loaded branch; ignore `options.limit` so item counts / overlay
 *     do not change when the user tweaks the zone subdivision threshold (only visual LOD changes).
 */
export function retrieve(resolution, bounds, xyz, bypass, purpose = "visual") {
  const result = [];
  const stack = [{ xyz, bypass }];
  const needChildren =
    purpose === "items" ? 1 : (this.options.children ?? 1);

  while (stack.length > 0) {
    const current = stack.pop();
    const element = this.get(current.xyz);
    if (!element) continue;

    let nextBypass = current.bypass;
    if (!nextBypass) {
      const { overlap, contained } = this.space.overlap(bounds, element.bounds);
      if (!overlap) continue;
      nextBypass = contained;
    }

    if (element.xyz.resolution === resolution) {
      result.push(element);
      continue;
    }

    if (purpose === "items") {
      if (this.isCovered(element) && element.children.length < needChildren) {
        result.push(element);
        continue;
      }
    } else if (
      this.isCovered(element) &&
      (element.count <= this.options.limit ||
        element.children.length < needChildren)
    ) {
      result.push(element);
      continue;
    }

    if (!element.children.length) {
      result.push(element);
      continue;
    }

    for (let i = element.children.length - 1; i >= 0; i--) {
      stack.push({ xyz: element.children[i], bypass: nextBypass });
    }
  }

  return result;
}
