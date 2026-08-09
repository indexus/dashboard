/**
 * Unit tests for Aggregate data-driven transition arming.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shouldArmDataDrivenTransition } from "./transitionRule.js";

describe("shouldArmDataDrivenTransition", () => {
  it("arms when display changed and dataVersion advanced", () => {
    assert.equal(
      shouldArmDataDrivenTransition({
        displayChanged: true,
        incomingDataVersion: 3,
        lastTransitionDataVersion: 2,
      }),
      true,
    );
  });

  it("skips LOD/MOVE packs with unchanged dataVersion", () => {
    assert.equal(
      shouldArmDataDrivenTransition({
        displayChanged: true,
        incomingDataVersion: 2,
        lastTransitionDataVersion: 2,
      }),
      false,
    );
  });

  it("skips when display did not change", () => {
    assert.equal(
      shouldArmDataDrivenTransition({
        displayChanged: false,
        incomingDataVersion: 5,
        lastTransitionDataVersion: 2,
      }),
      false,
    );
  });

  it("arms after prune-only bump (same rule as mutate)", () => {
    assert.equal(
      shouldArmDataDrivenTransition({
        displayChanged: true,
        incomingDataVersion: 1,
        lastTransitionDataVersion: 0,
      }),
      true,
    );
  });
});
