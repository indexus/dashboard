/**
 * Pure decisions for one Aggregate delta tick (grid.worker runDeltaTick).
 *
 * A tick must land as at most ONE WebGL blend and must never fight the
 * interactive MOVE path, so the commit rules live here where they can be
 * unit-tested without a worker.
 */

/**
 * Prune only when the pass ran to completion with no drill active. A MOVE
 * mid-pass means a drill is streaming cells for the new viewport — the himo
 * MOVE path never prunes, and pruning here would delete cells it just wrote.
 *
 * @param {{ aborted: boolean, drillInFlight: boolean }} state
 * @returns {boolean}
 */
export function shouldPruneAfterDeltaPass({ aborted, drillInFlight }) {
  return !aborted && !drillInFlight;
}

/**
 * End-of-pass commit:
 * - `bumpDataVersion` only when the cube actually mutated (count change,
 *   split, merge) — including a pass aborted mid-mutation, so the next flush
 *   cross-fades the partial state instead of snapping it. Prune-only never
 *   bumps: an LOD trim is a snap, not a data transition.
 * - `flush` whenever the display could have changed (mutation or prune).
 *
 * @param {{ mutated: boolean, pruned: number }} state
 * @returns {{ bumpDataVersion: boolean, flush: boolean }}
 */
export function deltaTickCommit({ mutated, pruned }) {
  return {
    bumpDataVersion: mutated === true,
    flush: mutated === true || Number(pruned) > 0,
  };
}
