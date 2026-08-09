// Thin factories around js-indexus-sdk constructors. The SDK's constructors
// are positional and return objects whose prototype methods are stripped by
// structuredClone, so we always recreate them on whichever thread will use
// them — never serialize a Cube/Grid/Network across the worker boundary.

import {
  Cube,
  API,
  Network,
  Grid,
} from "../../js-indexus-sdk/index.js";
import { buildCollectionAndSpace } from "./collection.js";

export { buildCollectionAndSpace, buildGpsCollection, GPS_DIM } from "./collection.js";
export {
  buildNetworkConfig,
  buildSetsPoolOptions,
  createDashboardNetwork,
  dashboardP2pGateway,
} from "./networkFactory.js";
export { DEFAULT_READ_OPTIONS, MESH_DISCOVERY_INTERVAL_MS } from "./readDefaults.js";

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
