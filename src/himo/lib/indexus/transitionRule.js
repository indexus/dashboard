/**
 * When to arm a prev→cur WebGL snapshot blend after flushAndPack.
 *
 * Only a bumped `dataVersion` (cube mutate / prune that must animate) paired
 * with a new display snapshot starts a cross-fade. Pure MOVE/LOD packs keep
 * the same dataVersion and snap.
 *
 * @param {{
 *   displayChanged: boolean,
 *   incomingDataVersion: number,
 *   lastTransitionDataVersion: number,
 * }} args
 * @returns {boolean}
 */
export function shouldArmDataDrivenTransition({
  displayChanged,
  incomingDataVersion,
  lastTransitionDataVersion,
}) {
  return (
    !!displayChanged &&
    Number(incomingDataVersion) > Number(lastTransitionDataVersion)
  );
}
