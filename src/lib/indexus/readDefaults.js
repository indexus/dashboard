/** Default shared read configuration (Nearby + Aggregate). */
export const DEFAULT_READ_OPTIONS = Object.freeze({
  navigation: "direct",
  method: "getSets",
  /** Floor between two `refresh` reads of the same zone. */
  refreshTtlMs: 5000,
});

/**
 * Floor between two `/neighbors` refreshes of the client node table.
 *
 * App also adopts richer `/api/mesh` host lists as they grow; this interval is
 * the in-Network path that learns spawneds Ops has not listed yet. 10 s is
 * cheap next to a reconcile pass and keeps Nodes from lagging Ops forever.
 */
export const MESH_DISCOVERY_INTERVAL_MS = 10000;
