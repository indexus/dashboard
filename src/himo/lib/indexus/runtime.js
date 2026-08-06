// Thin factories around js-indexus-sdk constructors. The SDK's constructors
// are positional and return objects whose prototype methods are stripped by
// structuredClone, so we always recreate them on whichever thread will use
// them — never serialize a Cube/Grid/Network across the worker boundary.

import {
  Cube,
  Collection,
  Space,
  API,
  Network,
  Grid,
} from "../../js-indexus-sdk/index.js";

function buildCollectionAndSpace(definition) {
  const collection = new Collection(definition.name, definition.dimensions);
  const space = new Space(
    collection.dimensions(),
    collection.mask(),
    collection.offset()
  );
  return { collection, space };
}

export function createCubeRuntime(definition, cubeOptions, isCovered) {
  const { collection, space } = buildCollectionAndSpace(definition);
  const cube = new Cube(collection.name(), space, cubeOptions, isCovered);
  return { collection, space, cube };
}

export function createGridRuntime(
  definition,
  gridOptions,
  stream,
  finish,
  monitoring,
  networkConfig
) {
  const { collection, space } = buildCollectionAndSpace(definition);
  const network = new Network(
    networkConfig.protocol,
    new API(),
    networkConfig.peers,
    networkConfig.concurrency,
    networkConfig.cacheSize,
    networkConfig.setsPool ?? {}
  );
  const grid = new Grid(
    collection.name(),
    space,
    gridOptions,
    stream,
    finish,
    monitoring,
    network
  );
  return { collection, space, network, grid };
}
