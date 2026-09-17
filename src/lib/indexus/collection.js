import { Collection, Space } from "js-indexus-sdk";

/** Canonical GPS dimension for dashboard Nearby + Aggregate collections. */
export const GPS_DIM = {
  name: "gps",
  type: "spherical",
  args: [-90, 90, -180, 180],
};

/**
 * @param {{ name: string, dimensions: object[] }} definition
 * @returns {{ collection: Collection, space: Space }}
 */
export function buildCollectionAndSpace(definition) {
  const collection = new Collection(definition.name, definition.dimensions);
  const space = new Space(
    collection.dimensions(),
    collection.mask(),
    collection.offset(),
  );
  return { collection, space };
}

/**
 * GPS collection + space used by Nearby SearchSession and Aggregate heatmap.
 * @param {string} name
 * @returns {{ collection: Collection, space: Space, gps: ReturnType<Space["dimension"]> }}
 */
export function buildGpsCollection(name) {
  const { collection, space } = buildCollectionAndSpace({
    name,
    dimensions: [GPS_DIM],
  });
  return { collection, space, gps: space.dimension(0) };
}
