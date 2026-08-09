import { API, Network } from "../../js-indexus-sdk/index.js";
import { DEFAULT_READ_OPTIONS } from "./readDefaults.js";

/**
 * Same-origin peer gateway (browser → dashboard → mesh). Null outside a window.
 * @returns {string | null}
 */
export function dashboardP2pGateway() {
  if (typeof globalThis === "undefined" || !globalThis.location?.origin) {
    return null;
  }
  return `${globalThis.location.origin}/api/p2p`;
}

/**
 * Map dashboard read knobs onto Network `setsPool` ctor options.
 * @param {{
 *   navigation?: string,
 *   method?: string,
 *   refreshTtlMs?: number,
 * }} [readOptions]
 * @param {{
 *   gateway?: string | null,
 *   meshDiscoveryIntervalMs?: number,
 * }} [extras]
 */
export function buildSetsPoolOptions(readOptions = {}, extras = {}) {
  const gateway =
    extras.gateway !== undefined ? extras.gateway : dashboardP2pGateway();
  /** @type {Record<string, unknown>} */
  const pool = {
    navigation: readOptions?.navigation ?? DEFAULT_READ_OPTIONS.navigation,
    method: readOptions?.method ?? DEFAULT_READ_OPTIONS.method,
    refreshTtlMs:
      readOptions?.refreshTtlMs ?? DEFAULT_READ_OPTIONS.refreshTtlMs,
    gateway,
  };
  if (Number.isFinite(extras.meshDiscoveryIntervalMs)) {
    pool.meshDiscoveryIntervalMs = extras.meshDiscoveryIntervalMs;
  }
  return pool;
}

/**
 * Config object passed across the worker boundary into `createGridRuntime`.
 * Does not construct a Network (constructors are not structuredClone-safe).
 *
 * @param {{
 *   peers: string[],
 *   concurrency: number,
 *   cacheSize: number,
 *   readOptions?: object,
 *   meshDiscoveryIntervalMs?: number,
 *   gateway?: string | null,
 *   protocol?: string,
 * }} args
 */
export function buildNetworkConfig({
  peers,
  concurrency,
  cacheSize,
  readOptions,
  meshDiscoveryIntervalMs,
  gateway,
  protocol = "http",
}) {
  return {
    protocol,
    peers: Array.isArray(peers) ? peers : [],
    concurrency,
    cacheSize,
    setsPool: buildSetsPoolOptions(readOptions, {
      gateway,
      meshDiscoveryIntervalMs,
    }),
  };
}

/**
 * Main-thread Network for Nearby (and any non-worker consumer).
 * Aggregate builds an equivalent Network inside the worker via buildNetworkConfig.
 *
 * @param {{
 *   hosts: string[],
 *   readOptions?: object,
 *   concurrency?: number,
 *   cacheSize?: number,
 *   meshDiscoveryIntervalMs?: number,
 *   gateway?: string | null,
 *   protocol?: string,
 * }} args
 */
export async function createDashboardNetwork({
  hosts,
  readOptions = DEFAULT_READ_OPTIONS,
  concurrency = 100,
  cacheSize = 20000,
  meshDiscoveryIntervalMs,
  gateway,
  protocol = "http",
}) {
  const bootstraps = [...new Set((hosts || []).filter(Boolean))];
  if (!bootstraps.length) {
    throw new Error("no mesh hosts — wait for /api/mesh nodes");
  }

  const config = buildNetworkConfig({
    peers: bootstraps,
    concurrency,
    cacheSize,
    readOptions,
    meshDiscoveryIntervalMs,
    gateway,
    protocol,
  });

  const network = new Network(
    config.protocol,
    new API(),
    config.peers,
    config.concurrency,
    config.cacheSize,
    config.setsPool,
  );
  await network.whenReady();
  if (!network.listPeers().length) {
    throw new Error(
      `failed to ping any peer (${bootstraps.length} hosts: ${bootstraps.join(", ")})`,
    );
  }
  return network;
}
