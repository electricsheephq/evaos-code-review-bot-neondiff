import { describe, expect, it } from "vitest";
import { advanceWorktreeCleanupDeadline } from "../src/daemon.js";

const INTERVAL_MS = 30 * 60_000;

describe("worktree cleanup elapsed-time scheduling", () => {
  it("uses the configured elapsed deadline across fast and slow daemon cycles", () => {
    let nextCleanupAtMs = INTERVAL_MS;

    for (const nowMs of [0, 10_000, 60_000, INTERVAL_MS - 1]) {
      const result = advanceWorktreeCleanupDeadline({
        enabled: true,
        intervalMs: INTERVAL_MS,
        nextCleanupAtMs,
        nowMs
      });
      expect(result.due).toBe(false);
      nextCleanupAtMs = result.nextCleanupAtMs;
    }

    const boundary = advanceWorktreeCleanupDeadline({
      enabled: true,
      intervalMs: INTERVAL_MS,
      nextCleanupAtMs,
      nowMs: INTERVAL_MS
    });
    expect(boundary).toEqual({ due: true, nextCleanupAtMs: 2 * INTERVAL_MS });

    const slowCycle = advanceWorktreeCleanupDeadline({
      enabled: true,
      intervalMs: INTERVAL_MS,
      nextCleanupAtMs: INTERVAL_MS,
      nowMs: 2 * INTERVAL_MS + 5 * 60_000
    });
    expect(slowCycle).toEqual({
      due: true,
      nextCleanupAtMs: 3 * INTERVAL_MS + 5 * 60_000
    });
  });

  it("initializes restart timing without an immediate cleanup storm or indefinite postponement", () => {
    const restartedAtMs = 50_000;
    const nextCleanupAtMs = restartedAtMs + INTERVAL_MS;

    expect(advanceWorktreeCleanupDeadline({
      enabled: true,
      intervalMs: INTERVAL_MS,
      nextCleanupAtMs,
      nowMs: restartedAtMs
    }).due).toBe(false);

    expect(advanceWorktreeCleanupDeadline({
      enabled: true,
      intervalMs: INTERVAL_MS,
      nextCleanupAtMs,
      nowMs: nextCleanupAtMs
    })).toEqual({
      due: true,
      nextCleanupAtMs: nextCleanupAtMs + INTERVAL_MS
    });
  });

  it("stays disabled without consuming or moving the stored deadline", () => {
    expect(advanceWorktreeCleanupDeadline({
      enabled: false,
      intervalMs: INTERVAL_MS,
      nextCleanupAtMs: INTERVAL_MS,
      nowMs: 2 * INTERVAL_MS
    })).toEqual({ due: false, nextCleanupAtMs: INTERVAL_MS });
  });
});
