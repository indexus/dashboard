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
 * The bootstrap host list is frozen once Data starts, so after that the Nodes
 * panel only tracks autoscale through this. Ops polls the mesh every 3–5 s;
 * one extra request per 10 s is nothing next to a reconcile pass, and it keeps
 * the two views from disagreeing on how many nodes exist.
 */
export const MESH_DISCOVERY_INTERVAL_MS = 10000;
