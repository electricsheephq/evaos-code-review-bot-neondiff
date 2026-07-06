import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitPublicCommands } from "../src/scheduler.js";
import { collectTrustedReviewCommands, decideCommandAction } from "../src/commands.js";
import { loadConfigFromObject, type BotConfig } from "../src/config.js";
import { ReviewStateStore } from "../src/state.js";
import type { IssueCommentCommandSource } from "../src/commands.js";
import type { PullRequestSummary } from "../src/types.js";

const BOT_LOGIN = "evaos-code-review-bot[bot]";

function config(publicEnabled: boolean): BotConfig {
  return loadConfigFromObject({
    github: { botLogin: BOT_LOGIN },
    commands: {
      enabled: true,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: ["100yenadmin"],
      acknowledge: false,
      ...(publicEnabled ? { publicCommands: { enabled: true, actions: ["review", "re-review"], cooldownMinutes: 10 } } : {})
    }
  });
}

function pull(headSha: string): PullRequestSummary {
  return { number: 7, title: "PR", draft: false, head: { sha: headSha, ref: "f" }, base: { sha: "b", ref: "main", repo: { full_name: "owner/repo" } }, html_url: "x" };
}

function comment(id: number, login: string, body: string, type = "User"): IssueCommentCommandSource {
  return { id, body, html_url: `https://github.test/${id}`, user: { login, type } };
}

function admit(store: ReviewStateStore, cfg: BotConfig, comments: IssueCommentCommandSource[], headSha: string, now?: Date) {
  const collected = collectTrustedReviewCommands(comments, cfg.commands);
  return admitPublicCommands({ config: cfg, state: store, repo: "owner/repo", pull: pull(headSha), publicEligible: collected.publicEligible, comments, ...(now ? { now } : {}) });
}

describe("public command admission (#345)", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function store() {
    const root = mkdtempSync(join(tmpdir(), "evaos-pubadmit-"));
    roots.push(root);
    return new ReviewStateStore(join(root, "state.sqlite"));
  }

  it("admits a public review/re-review from a non-trusted human when enabled", () => {
    const s = store();
    const admitted = admit(s, config(true), [
      comment(101, "randopublic", "@evaos-code-review-bot review"),
      comment(102, "randopublic", "@evaos-code-review-bot re-review")
    ], "head-1");
    expect(admitted.map((c) => c.commentId)).toEqual([101, 102]);
    s.close();
  });

  it("admits nothing when publicCommands is disabled (byte-identical to today)", () => {
    const s = store();
    // Disabled ⇒ publicEligible is empty from the collector, so nothing to admit.
    const collected = collectTrustedReviewCommands([comment(101, "randopublic", "@evaos-code-review-bot review")], config(false).commands);
    expect(collected.publicEligible).toEqual([]);
    expect(admit(s, config(false), [comment(101, "randopublic", "@evaos-code-review-bot review")], "head-1")).toEqual([]);
    s.close();
  });

  it("never admits a bot's own review comment (loop protection)", () => {
    const s = store();
    const admitted = admit(s, config(true), [
      comment(101, BOT_LOGIN, "@evaos-code-review-bot review", "Bot"),
      comment(102, "some-other-bot[bot]", "@evaos-code-review-bot review", "Bot")
    ], "head-1");
    expect(admitted).toEqual([]);
    s.close();
  });

  it("flows an admitted public command through the SAME dedup/decision gate as a trusted one (#345 §5)", () => {
    const s = store();
    const admitted = admit(s, config(true), [comment(101, "randopublic", "@evaos-code-review-bot re-review")], "head-1");
    expect(admitted.map((c) => c.commentId)).toEqual([101]);

    // Same downstream decision path as trusted commands: an already-processed head is a no-op (the
    // per-head claim / hasProcessedCommand short-circuit is shared — public authorization changes
    // nothing downstream).
    const decision = decideCommandAction({
      commands: admitted, repo: "owner/repo", pullNumber: 7, headSha: "head-1",
      hasProcessedCommand: (_r, _p, _h, commentId) => commentId === 101
    });
    expect(decision).toEqual({ action: "none", shouldReview: false });

    // Not yet processed ⇒ the admitted public re-review drives a review exactly like a trusted one.
    const active = decideCommandAction({
      commands: admitted, repo: "owner/repo", pullNumber: 7, headSha: "head-1", hasProcessedCommand: () => false
    });
    expect(active).toMatchObject({ action: "re-review", shouldReview: true, commandId: 101 });
    s.close();
  });

  it("cools down a repeat public command on the same head/author/action, but allows a new head", () => {
    const s = store();
    const cfg = config(true);
    const t0 = new Date("2026-07-06T12:00:00.000Z");
    // First invocation admitted.
    expect(admit(s, cfg, [comment(101, "randopublic", "@evaos-code-review-bot review")], "head-1", t0).length).toBe(1);
    // Repeat within the cooldown window ⇒ denied.
    expect(admit(s, cfg, [comment(102, "randopublic", "@evaos-code-review-bot review")], "head-1", new Date(t0.getTime() + 60_000))).toEqual([]);
    // A genuinely new push (new head) is not blocked by the prior head's invocation.
    expect(admit(s, cfg, [comment(103, "randopublic", "@evaos-code-review-bot review")], "head-2", new Date(t0.getTime() + 60_000)).length).toBe(1);
    // After the window, the same head is allowed again.
    expect(admit(s, cfg, [comment(104, "randopublic", "@evaos-code-review-bot review")], "head-1", new Date(t0.getTime() + 11 * 60_000)).length).toBe(1);
    s.close();
  });
});
