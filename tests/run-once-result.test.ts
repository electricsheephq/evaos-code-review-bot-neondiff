import { describe, expect, it } from "vitest";
import { applyReviewPullResultToRunOnceResult, type RunOnceResult } from "../src/worker.js";

function emptyResult(): RunOnceResult {
  return {
    reposScanned: 1,
    pullsSeen: 1,
    reviewed: 0,
    failed: 0,
    skippedDraft: 0,
    skippedCanary: 0,
    skippedPolicy: 0,
    skippedLicenseGate: 0,
    skippedCommandStop: 0,
    skippedCommandExplain: 0,
    skippedFinishingTouchDraft: 0,
    commandReviewRequested: 0,
    skippedProcessed: 0,
    skippedCapacity: 0,
    skippedContextBudget: 0,
    skippedProviderCooldown: 0,
    skippedStaleHead: 0,
    baselinedExisting: 0,
    policySkips: []
  };
}

describe("runOnce review result aggregation", () => {
  it.each([
    ["posted_stale_head", { skippedStaleHead: 1, failed: 0 }],
    ["posted_head_unverified", { skippedStaleHead: 0, failed: 1 }],
    ["skipped_consumed_authorization", { skippedStaleHead: 0, failed: 1 }]
  ] as const)("maps %s without counting a completed review", (status, expected) => {
    const result = emptyResult();
    applyReviewPullResultToRunOnceResult(result, status);
    expect(result).toMatchObject({ reviewed: 0, ...expected });
  });
});
