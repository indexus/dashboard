/**
 * Commit rules of the periodic Aggregate delta tick: one blend per mutated
 * pass, no false blends on prune-only, no prune while the MOVE path is live.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deltaTickCommit,
  shouldPruneAfterDeltaPass,
} from "./deltaTickRule.js";

describe("deltaTickCommit", () => {
  it("quiet pass: no bump, no flush", () => {
    const commit = deltaTickCommit({ mutated: false, pruned: 0 });
    assert.equal(commit.bumpDataVersion, false);
    assert.equal(commit.flush, false);
  });

  it("mutated pass: one bump and one flush", () => {
    const commit = deltaTickCommit({ mutated: true, pruned: 0 });
    assert.equal(commit.bumpDataVersion, true);
    assert.equal(commit.flush, true);
  });

  it("aborted-but-mutated pass still bumps (next flush must blend, not snap)", () => {
    // The abort only disables pruning; a partial mutation keeps its bump so a
    // MOVE flush cross-fades the half-applied delta.
    assert.equal(
      shouldPruneAfterDeltaPass({ aborted: true, drillInFlight: false }),
      false
    );
    const commit = deltaTickCommit({ mutated: true, pruned: 0 });
    assert.equal(commit.bumpDataVersion, true);
    assert.equal(commit.flush, true);
  });

  it("prune-only pass: flush without a version bump (LOD snap, no false blend)", () => {
    const commit = deltaTickCommit({ mutated: false, pruned: 3 });
    assert.equal(commit.bumpDataVersion, false);
    assert.equal(commit.flush, true);
  });
});

describe("shouldPruneAfterDeltaPass", () => {
  it("prunes only when the pass completed with no drill active", () => {
    assert.equal(
      shouldPruneAfterDeltaPass({ aborted: false, drillInFlight: false }),
      true
    );
    assert.equal(
      shouldPruneAfterDeltaPass({ aborted: true, drillInFlight: false }),
      false
    );
    assert.equal(
      shouldPruneAfterDeltaPass({ aborted: false, drillInFlight: true }),
      false
    );
  });
});
